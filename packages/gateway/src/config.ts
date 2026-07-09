import type {AwsCredentials, ObjectStoreConfig} from './runtime-effect.js'
import type {OperatorAllowlist} from './web/auth/allowlist.js'
import type {VapidKeyMaterial, VapidPublicKeyInfo} from './web/operator-push/vapid.js'

import {Buffer} from 'node:buffer'
import {closeSync, constants, fstatSync, openSync, readFileSync} from 'node:fs'
import {isIP} from 'node:net'
import process from 'node:process'

import {GatewayIntentBits} from 'discord.js'
import {parseAllowlistText} from './web/auth/allowlist.js'
import {
  OPERATOR_PUSH_DEDUPE_WINDOW_MS,
  OPERATOR_PUSH_ENABLED,
  OPERATOR_PUSH_PREVIOUS_VAPID_KEY_VERSION,
  OPERATOR_PUSH_PREVIOUS_VAPID_PRIVATE_KEY,
  OPERATOR_PUSH_PREVIOUS_VAPID_PUBLIC_KEY,
  OPERATOR_PUSH_PREVIOUS_VAPID_SUBJECT,
  OPERATOR_PUSH_VAPID_KEY_VERSION,
  OPERATOR_PUSH_VAPID_PRIVATE_KEY,
  OPERATOR_PUSH_VAPID_PUBLIC_KEY,
  OPERATOR_PUSH_VAPID_SUBJECT,
} from './web/operator-push/config-keys.js'
import {assertValidVapidKeyMaterial} from './web/operator-push/vapid.js'

const DEFAULT_S3_PREFIX = 'fro-bot-state'
const DEFAULT_GATEWAY_IDENTITY = 'discord-gateway'
const DEFAULT_LOG_LEVEL = 'info' as const
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

const DEFAULT_APPROVAL_MODE = 'approval-required' as const
// autonomous-low-risk is deferred: OpenCode evaluates session rules before persisted project
// 'approved' rules, and last-match-wins means persisted 'always' approvals can override session
// denies. No permission.asked fires in that case, so gateway autonomous reject cannot save it.
// Keep the env var so operators get a clear error instead of silent fallback if they set it.
const VALID_APPROVAL_MODES = ['approval-required'] as const
const DEFERRED_APPROVAL_MODES = ['autonomous-low-risk'] as const

const DEFAULT_OPERATOR_PUSH_DEDUPE_WINDOW_MS = 300_000

const DEFAULT_STATUS_MODE = 'live-status' as const
const VALID_STATUS_MODES = ['live-status', 'typing-only'] as const

const ALLOWED_PRIVILEGED_INTENTS = {
  MessageContent: GatewayIntentBits.MessageContent,
  GuildMembers: GatewayIntentBits.GuildMembers,
} as const

export interface GatewayConfig {
  readonly discordToken: string
  readonly discordApplicationId: string
  readonly discordGuildId: string | null
  readonly objectStore: ObjectStoreConfig
  readonly identity: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  readonly privilegedIntents: readonly GatewayIntentBits[]
  readonly githubAppId: string
  readonly githubAppPrivateKey: string
  readonly gatewayGitHubAppInstallUrl: string
  readonly workspaceAgentUrl: string
  /** Full base URL of the workspace OpenCode proxy (e.g. `http://workspace:9200`). */
  readonly workspaceOpencodeUrl: string
  /** Bearer token for the workspace OpenCode proxy. Never logged. */
  readonly workspaceOpencodeToken: string
  /**
   * Discord role ID that grants trigger authorization.
   * `null` if unset — falls back to guild-level `ManageChannels`.
   */
  readonly triggerRoleId: string | null
  /** Maximum number of simultaneous active runs across all channels. */
  readonly maxConcurrentRuns: number
  /** Maximum wall-clock milliseconds a single run may take before being aborted. */
  readonly runTimeoutMs: number
  /**
   * Maximum milliseconds of inactivity (no text delta or tool completion) before a run is
   * aborted. Resets on every text delta, tool completion, and permission reply.
   * Pauses while waiting on a human approval (permission.asked → permission.replied).
   */
  readonly runInactivityTimeoutMs: number
  /**
   * Approval mode for tool permission requests during mention runs.
   * - `approval-required` (default): routes permission asks to Discord approval UI.
   *
   * Note: `autonomous-low-risk` is deferred and explicitly rejected at startup. See config.ts for
   * the rationale (OpenCode last-match-wins evaluation makes session-scoped denies unsafe).
   */
  readonly approvalMode: 'approval-required'
  /**
   * Deploy-wide working-state UX mode for mention runs.
   * - `live-status` (default): posts a single editable status message that updates on a
   *   debounced cadence while the agent works, then transitions into the final answer.
   * - `typing-only`: suppresses the status message entirely; only the typing indicator is shown.
   */
  readonly statusMode: 'live-status' | 'typing-only'
  /**
   * Canonical Fro Bot persona text, read from `GATEWAY_PERSONA_FILE` (or `GATEWAY_PERSONA` env var).
   * Prepended to every Discord mention prompt before the Discord-mechanical guidance.
   * `null` when unset, empty, or whitespace-only — the mention loop degrades gracefully to
   * mechanical guidance only.
   */
  readonly persona: string | null
  /**
   * Announce/presence endpoint configuration. Present only when both
   * `GATEWAY_WEBHOOK_SECRET` and `GATEWAY_PRESENCE_CHANNEL_ID` are set.
   * When absent, the announce HTTP server is not started.
   */
  readonly announce?: {
    readonly webhookSecret: string
    readonly presenceChannelId: string
    readonly httpPort: number
  }
  /**
   * Operator web surface configuration. Present only when all required operator
   * config is set: `GATEWAY_OPERATOR_BIND_HOST`, `GATEWAY_OPERATOR_BIND_PORT`,
   * and `GATEWAY_OPERATOR_PUBLIC_ORIGIN`.
   *
   * When absent, the operator HTTP server is not started (opt-in).
   * Partial config (some but not all required vars) fails closed at startup.
   *
   * Security constraints enforced at config-load time:
   *   - bindHost must be a literal IP address (no hostnames — `node:net` `isIP()` check).
   *   - bindHost must NOT be an all-interfaces address: `0.0.0.0`, `::`, or `0:0:0:0:0:0:0:0`.
   *   - bindHost must NOT be a loopback address: any `127.0.0.0/8` range, `::1`,
   *     or the full-form `0:0:0:0:0:0:0:1`.
   *   - bindHost must NOT be a sandbox-net address: `10.0.0.0/8` (Docker internal network;
   *     the operator listener must be on gateway-net only).
   *   - publicOrigin must be a valid https:// URL.
   *
   * The operator listener is bound to gateway-net only and is not reachable
   * from sandbox-net. TLS is terminated by the infra reverse proxy.
   */
  readonly operatorWeb?: {
    /**
     * Bind host for the operator listener on gateway-net.
     * Must be a literal IP address (not a hostname).
     * Must NOT be an all-interfaces address (0.0.0.0, ::, 0:0:0:0:0:0:0:0),
     * a loopback address (127.0.0.0/8, ::1, 0:0:0:0:0:0:0:1),
     * or a sandbox-net address (10.0.0.0/8).
     */
    readonly bindHost: string
    /** Bind port for the operator listener. */
    readonly bindPort: number
    /**
     * Public HTTPS origin exposed by the infra reverse proxy.
     * Used to validate X-Forwarded-Host/X-Forwarded-Proto headers.
     * Example: 'https://operator.example.com'
     */
    readonly publicOrigin: string
    /**
     * GitHub OAuth App client ID.
     * Read from GATEWAY_OPERATOR_GITHUB_CLIENT_ID (or GATEWAY_OPERATOR_GITHUB_CLIENT_ID_FILE).
     */
    readonly oauthClientId: string
    /**
     * GitHub OAuth App client secret. Never logged or browser-visible.
     * Read from GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET (or _FILE variant).
     */
    readonly oauthClientSecret: string
    /**
     * Allowlisted same-origin return paths for post-auth redirect.
     * Comma-separated list read from GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS.
     * Defaults to ['/operator'] when unset.
     * Only paths in this list are accepted as return_to targets.
     */
    readonly oauthAllowedReturnPaths: readonly string[]
    /**
     * TTL for OAuth state entries in milliseconds.
     * Read from GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS.
     * Defaults to 600_000 (10 minutes).
     */
    readonly oauthStateTtlMs: number
    /**
     * Maximum outstanding (unconsumed) OAuth attempts per source key.
     * Read from GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS.
     * Defaults to 5.
     */
    readonly oauthMaxOutstandingAttemptsPerKey: number
    /**
     * CSRF token signing key (HMAC-SHA256), base64url-encoded with no padding/newlines.
     * Read from GATEWAY_OPERATOR_CSRF_SECRET (or _FILE variant).
     * Required when operator web is enabled — startup fails if absent.
     * Must decode to at least 32 bytes (256 bits) of CSPRNG entropy.
     */
    readonly csrfSecret: string
    /**
     * Operator allowlist — set of authorized numeric GitHub user IDs.
     * Loaded from GATEWAY_OPERATOR_ALLOWLIST_FILE or GATEWAY_OPERATOR_ALLOWLIST env var.
     * Required when operator web is enabled — startup fails if absent, empty, or malformed.
     * Fail-closed: missing/unreadable/empty/malformed allowlist denies everyone.
     */
    readonly allowlist: OperatorAllowlist
  }
  /**
   * Operator Web Push configuration. Present only when
   * `GATEWAY_OPERATOR_PUSH_ENABLED` is `true`.
   *
   * When absent (the default), push is disabled: no VAPID material is
   * required or validated, and no push routes or dispatch are exposed.
   *
   * When present, `current` is fully validated VAPID key material
   * (public key, private key, subject, key version) and `previous` is an
   * optional second keypair accepted during a VAPID rotation rollout
   * window. `vapidPublicKeyInfo` is the client-safe subset
   * (`{publicKey, keyVersion}`) of `current` — route-facing code should
   * read `vapidPublicKeyInfo`, not `current`, so the private key never
   * needs to flow past config-loading code.
   *
   * The private key fields (`current.privateKey`, `previous.privateKey`)
   * must never be logged, serialized into a response, or embedded in a
   * thrown error.
   */
  readonly operatorPush?: {
    readonly current: VapidKeyMaterial
    readonly previous?: VapidKeyMaterial
    readonly vapidPublicKeyInfo: VapidPublicKeyInfo
    readonly dedupeWindowMs: number
  }
}

/**
 * Build a VapidKeyMaterial object with `privateKey` defined as a
 * non-enumerable property.
 *
 * `JSON.stringify` and `Object.keys`/spread-based logging only
 * see enumerable properties, so this prevents the private key from leaking
 * into a serialized config blob, a debug dump, or an accidental `console.log`
 * of the whole config object — while the field remains readable via direct
 * property access (`material.privateKey`) for code that legitimately needs it
 * (VAPID signing).
 */
function buildVapidKeyMaterial(
  publicKey: string,
  privateKey: string,
  subject: string,
  keyVersion: string,
): VapidKeyMaterial {
  const material = {publicKey, subject, keyVersion} as {
    -readonly [K in keyof VapidKeyMaterial]: VapidKeyMaterial[K]
  }
  Object.defineProperty(material, 'privateKey', {
    value: privateKey,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return material
}

const MAX_SECRET_BYTES = 4096

class SecretFileNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretFileNotFoundError'
  }
}

/**
 * Read a secret file with hardened path validation. Uses `openSync` with
 * `O_NOFOLLOW` so symlinks fail at open (no TOCTOU window between validation
 * and read), then `fstatSync` on the already-open file descriptor to confirm
 * the file is a regular file under the size limit.
 *
 * Throws on:
 * - ENOENT: file does not exist (SecretFileNotFoundError — callers can catch
 *   this specifically to fall through to env-var fallbacks)
 * - Symlink (ELOOP from openSync with O_NOFOLLOW)
 * - Not a regular file: FIFOs, devices, directories (rejected after fstat)
 * - Size > MAX_SECRET_BYTES: prevents memory exhaustion
 *
 * The 4096-byte limit is generous for any reasonable secret. AWS keys are
 * typically <50 bytes; Discord tokens are <100; OAuth refresh tokens are
 * occasionally larger but well under 4KB.
 *
 * Note: O_NOFOLLOW is a POSIX extension supported on Linux and macOS. On
 * Windows (where Node's openSync silently ignores the flag), symlinks fall
 * through to the fstat-based rejection — same outcome, just at a later check.
 */
function readSecretFile(filePath: string): string {
  let fd: number
  try {
    // O_NOFOLLOW: open fails immediately if path is a symlink (Linux/macOS).
    // This removes the lstat-then-read TOCTOU window — we can never race on a
    // symlink swap because the open() syscall itself refuses to follow.
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ENOENT') {
        throw new SecretFileNotFoundError(`Secret file does not exist: ${filePath}`)
      }
      if (error.code === 'ELOOP') {
        // O_NOFOLLOW path-is-symlink rejection on Linux/macOS
        throw new Error(
          `Secret path is not a regular file: ${filePath} (got symlink). Symlinks are not supported — bind-mount a real file.`,
        )
      }
    }
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (stat.isFile() === false) {
      const kind = describeStatKind(stat)
      throw new Error(
        `Secret path is not a regular file: ${filePath} (got ${kind}). FIFOs, devices, and directories are not supported — bind-mount a real file.`,
      )
    }
    if (stat.size > MAX_SECRET_BYTES) {
      throw new Error(
        `Secret file is too large: ${filePath} (${stat.size} bytes > ${MAX_SECRET_BYTES} byte limit). Secrets should be a single value on a single line.`,
      )
    }
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function describeStatKind(stat: import('node:fs').Stats): string {
  if (stat.isSymbolicLink()) return 'symlink'
  if (stat.isFIFO()) return 'FIFO/pipe'
  if (stat.isCharacterDevice()) return 'character device'
  if (stat.isBlockDevice()) return 'block device'
  if (stat.isDirectory()) return 'directory'
  if (stat.isSocket()) return 'socket'
  return 'unknown non-file'
}

/**
 * Read a required secret by name.
 *
 * Precedence:
 * 1. If `${name}_FILE` env var is set AND that file exists → read file contents, trim trailing whitespace
 * 2. Else if `process.env[name]` is set → return it
 * 3. Else throw with a clear message
 */
export function readSecret(name: string): string {
  const value = readOptionalSecret(name)
  if (value === null) {
    throw new Error(`Missing required secret: ${name} (set ${name} env var or ${name}_FILE pointing to a file)`)
  }
  return value
}

/**
 * Read a required secret that may contain embedded newlines (e.g. PEM private keys).
 *
 * Same precedence as `readSecret` but skips the line-break rejection check.
 * Only use for secrets where multi-line content is expected and valid.
 */
export function readMultilineSecret(name: string): string {
  const value = readOptionalMultilineSecret(name)
  if (value === null) {
    throw new Error(`Missing required secret: ${name} (set ${name} env var or ${name}_FILE pointing to a file)`)
  }
  return value
}

/**
 * Read an optional secret that may contain embedded newlines (e.g. PEM private keys).
 *
 * Same precedence as `readOptionalSecret` but skips the line-break rejection check.
 */
export function readOptionalMultilineSecret(name: string): string | null {
  const filePath = process.env[`${name}_FILE`]
  if (filePath !== undefined) {
    let contents: string | undefined
    try {
      contents = readSecretFile(filePath)
    } catch (error) {
      if (error instanceof SecretFileNotFoundError) {
        // file not present; fall through to env-var fallback
      } else {
        throw error
      }
    }
    if (contents !== undefined) {
      const trimmed = contents.trimEnd()
      if (trimmed.trim() === '') return null
      return trimmed
    }
  }

  const value = process.env[name]
  if (value !== undefined && value.trim() !== '') {
    return value
  }

  return null
}

/**
 * Read an optional secret by name.
 *
 * Same precedence as `readSecret` but returns `null` instead of throwing.
 */
export function readOptionalSecret(name: string): string | null {
  const filePath = process.env[`${name}_FILE`]
  if (filePath !== undefined) {
    let contents: string | undefined
    try {
      contents = readSecretFile(filePath)
    } catch (error) {
      if (error instanceof SecretFileNotFoundError) {
        // file not present; fall through to env-var fallback
      } else {
        throw error
      }
    }
    if (contents !== undefined) {
      // Strip only trailing whitespace (newline/spaces from echo) so leading whitespace
      // in valid secrets is preserved — matching the env-var path which uses raw process.env[name].
      // Treat whitespace-only or empty files as "not set" (e.g. empty bind-mounted optional secrets).
      const trailingTrimmed = contents.trimEnd()
      if (trailingTrimmed.trim() === '') return null
      if (/[\r\n\u0085\u2028\u2029]/.test(trailingTrimmed)) {
        throw new Error(
          `Secret value at ${filePath} contains embedded line-breaking characters — likely a copy-paste with line-wrapping. Remove the line break and rewrite the file as a single line.`,
        )
      }
      return trailingTrimmed
    }
  }

  const value = process.env[name]
  if (value !== undefined && value.trim() !== '') {
    if (/[\r\n\u0085\u2028\u2029]/.test(value)) {
      throw new Error(
        `Environment variable ${name} contains embedded line-breaking characters — likely a copy-paste with line-wrapping. Remove the line break and set it as a single line.`,
      )
    }
    return value
  }

  return null
}

/**
 * Load and validate the gateway configuration from environment variables and secrets.
 *
 * Throws if any required secret is missing or if a value fails validation.
 */
export function loadGatewayConfig(): GatewayConfig {
  const discordToken = readSecret('DISCORD_TOKEN')
  const discordApplicationId = readSecret('DISCORD_APPLICATION_ID')
  const discordGuildId = readOptionalSecret('DISCORD_GUILD_ID')

  const s3Bucket = readSecret('S3_BUCKET')
  const s3Region = readSecret('S3_REGION')
  const s3Endpoint = readOptionalSecret('S3_ENDPOINT') ?? undefined
  const s3Prefix = readOptionalSecret('S3_PREFIX') ?? DEFAULT_S3_PREFIX
  const s3Sse = readOptionalSecret('S3_SSE') ?? undefined

  const identity = readOptionalSecret('GATEWAY_IDENTITY') ?? DEFAULT_GATEWAY_IDENTITY

  const rawLogLevel = readOptionalSecret('LOG_LEVEL') ?? DEFAULT_LOG_LEVEL
  if (!(VALID_LOG_LEVELS as readonly string[]).includes(rawLogLevel)) {
    throw new Error(`Invalid LOG_LEVEL value: "${rawLogLevel}" (valid values: ${VALID_LOG_LEVELS.join(', ')})`)
  }
  const logLevel = rawLogLevel as GatewayConfig['logLevel']

  const rawApprovalMode = readOptionalSecret('GATEWAY_APPROVAL_MODE') ?? DEFAULT_APPROVAL_MODE
  if ((DEFERRED_APPROVAL_MODES as readonly string[]).includes(rawApprovalMode)) {
    throw new Error(
      `GATEWAY_APPROVAL_MODE value "${rawApprovalMode}" is not supported: autonomous-low-risk is deferred because OpenCode evaluates session rules before persisted project 'approved' rules, and last-match-wins means persisted 'always' approvals can override session denies. Use "approval-required" (the default).`,
    )
  }
  if (!(VALID_APPROVAL_MODES as readonly string[]).includes(rawApprovalMode)) {
    throw new Error(
      `Invalid GATEWAY_APPROVAL_MODE value: "${rawApprovalMode}" (valid values: ${VALID_APPROVAL_MODES.join(', ')})`,
    )
  }
  const approvalMode = rawApprovalMode as GatewayConfig['approvalMode']

  const rawStatusMode = readOptionalSecret('GATEWAY_STATUS_MODE') ?? DEFAULT_STATUS_MODE
  if (!(VALID_STATUS_MODES as readonly string[]).includes(rawStatusMode)) {
    throw new Error(
      `Invalid GATEWAY_STATUS_MODE value: "${rawStatusMode}" (valid values: ${VALID_STATUS_MODES.join(', ')})`,
    )
  }
  const statusMode = rawStatusMode as GatewayConfig['statusMode']

  const rawIntents = readOptionalSecret('DISCORD_PRIVILEGED_INTENTS')
  const privilegedIntents: GatewayIntentBits[] = []
  if (rawIntents !== null) {
    const tokens = rawIntents
      .split(',')
      .map(token => token.trim())
      .filter(token => token.length > 0)
    const seen = new Set<GatewayIntentBits>()
    for (const token of tokens) {
      if (Object.prototype.hasOwnProperty.call(ALLOWED_PRIVILEGED_INTENTS, token) === false) {
        const allowed = Object.keys(ALLOWED_PRIVILEGED_INTENTS).join(', ')
        throw new Error(
          `Invalid DISCORD_PRIVILEGED_INTENTS value: "${token}". Allowed values: ${allowed} (case-sensitive, comma-separated).`,
        )
      }
      const intent = ALLOWED_PRIVILEGED_INTENTS[token as keyof typeof ALLOWED_PRIVILEGED_INTENTS]
      if (seen.has(intent) === false) {
        seen.add(intent)
        privilegedIntents.push(intent)
      }
    }
  }

  const awsAccessKeyId = readOptionalSecret('AWS_ACCESS_KEY_ID')
  const awsSecretAccessKey = readOptionalSecret('AWS_SECRET_ACCESS_KEY')
  const awsSessionToken = readOptionalSecret('AWS_SESSION_TOKEN')

  // Pair validation: both must be set together, or neither
  if (awsAccessKeyId !== null && awsSecretAccessKey === null) {
    throw new Error(
      'Both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together (received: AWS_ACCESS_KEY_ID). Set both, or set neither to use the SDK default credential chain.',
    )
  }

  if (awsSecretAccessKey !== null && awsAccessKeyId === null) {
    throw new Error(
      'Both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together (received: AWS_SECRET_ACCESS_KEY). Set both, or set neither to use the SDK default credential chain.',
    )
  }

  let credentials: AwsCredentials | undefined

  if (awsAccessKeyId !== null && awsSecretAccessKey !== null) {
    credentials = {
      accessKeyId: awsAccessKeyId,
      secretAccessKey: awsSecretAccessKey,
      ...(awsSessionToken === null ? {} : {sessionToken: awsSessionToken}),
    }
  } else if (awsSessionToken !== null) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'AWS_SESSION_TOKEN is set without AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY; ignoring it and falling back to SDK default credential chain.',
      }),
    )
  }

  const objectStore: ObjectStoreConfig = {
    enabled: true,
    bucket: s3Bucket,
    region: s3Region,
    prefix: s3Prefix,
    ...(s3Endpoint === undefined ? {} : {endpoint: s3Endpoint}),
    ...(s3Sse === undefined ? {} : {sseEncryption: s3Sse as ObjectStoreConfig['sseEncryption']}),
    ...(credentials === undefined ? {} : {credentials}),
  }

  const githubAppId = readSecret('GITHUB_APP_ID')
  const githubAppPrivateKey = readMultilineSecret('GITHUB_APP_PRIVATE_KEY')
  const gatewayGitHubAppInstallUrl =
    readOptionalSecret('GATEWAY_GITHUB_APP_INSTALL_URL') ?? 'https://github.com/apps/fro-bot-agent/installations/new'

  const workspaceAgentUrl = readOptionalSecret('WORKSPACE_AGENT_URL') ?? 'http://workspace:9100'

  const workspaceOpencodeUrl = readOptionalSecret('WORKSPACE_OPENCODE_URL') ?? 'http://workspace:9200'
  const workspaceOpencodeToken = readSecret('WORKSPACE_OPENCODE_TOKEN')
  const triggerRoleId = readOptionalSecret('GATEWAY_TRIGGER_ROLE_ID')

  const rawMaxConcurrent = readOptionalSecret('GATEWAY_MAX_CONCURRENT_RUNS') ?? '3'
  if (/^[1-9]\d*$/.test(rawMaxConcurrent) === false) {
    throw new Error(`Invalid GATEWAY_MAX_CONCURRENT_RUNS value: "${rawMaxConcurrent}" (must be a positive integer)`)
  }
  const maxConcurrentRuns = Number.parseInt(rawMaxConcurrent, 10)
  if (
    Number.isFinite(maxConcurrentRuns) === false ||
    Number.isInteger(maxConcurrentRuns) === false ||
    maxConcurrentRuns < 1
  ) {
    throw new Error(`Invalid GATEWAY_MAX_CONCURRENT_RUNS value: "${rawMaxConcurrent}" (must be a positive integer)`)
  }

  const rawRunTimeout = readOptionalSecret('GATEWAY_RUN_TIMEOUT_MS') ?? '1800000'
  if (/^[1-9]\d*$/.test(rawRunTimeout) === false) {
    throw new Error(`Invalid GATEWAY_RUN_TIMEOUT_MS value: "${rawRunTimeout}" (must be a positive integer)`)
  }
  const runTimeoutMs = Number.parseInt(rawRunTimeout, 10)
  if (Number.isFinite(runTimeoutMs) === false || Number.isInteger(runTimeoutMs) === false || runTimeoutMs < 1) {
    throw new Error(`Invalid GATEWAY_RUN_TIMEOUT_MS value: "${rawRunTimeout}" (must be a positive integer)`)
  }

  const rawRunInactivityTimeout = readOptionalSecret('GATEWAY_RUN_INACTIVITY_TIMEOUT_MS') ?? '300000'
  if (/^[1-9]\d*$/.test(rawRunInactivityTimeout) === false) {
    throw new Error(
      `Invalid GATEWAY_RUN_INACTIVITY_TIMEOUT_MS value: "${rawRunInactivityTimeout}" (must be a positive integer)`,
    )
  }
  const runInactivityTimeoutMs = Number.parseInt(rawRunInactivityTimeout, 10)
  if (
    Number.isFinite(runInactivityTimeoutMs) === false ||
    Number.isInteger(runInactivityTimeoutMs) === false ||
    runInactivityTimeoutMs < 1
  ) {
    throw new Error(
      `Invalid GATEWAY_RUN_INACTIVITY_TIMEOUT_MS value: "${rawRunInactivityTimeout}" (must be a positive integer)`,
    )
  }

  // Soft warning: if inactivity >= hard ceiling, the inactivity timer can never fire.
  // Valid config, but effectively dead — the hard ceiling always wins first.
  if (runInactivityTimeoutMs >= runTimeoutMs) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: `GATEWAY_RUN_INACTIVITY_TIMEOUT_MS (${runInactivityTimeoutMs}ms) is >= GATEWAY_RUN_TIMEOUT_MS (${runTimeoutMs}ms) — the inactivity timer can never fire because the hard ceiling fires first. Set GATEWAY_RUN_INACTIVITY_TIMEOUT_MS to a value less than GATEWAY_RUN_TIMEOUT_MS.`,
      }),
    )
  }

  // Persona — optional multi-line markdown file (e.g. fro-bot-persona.md).
  // Uses readOptionalMultilineSecret because persona files contain embedded newlines.
  // Absent/empty/whitespace → null: the mention loop degrades gracefully.
  // Fail-soft: any read error (permission-denied, directory, oversized, etc.) logs a warning
  // and resolves to null — a persona read failure must never crash gateway startup.
  let persona: string | null = null
  try {
    persona = readOptionalMultilineSecret('GATEWAY_PERSONA')
  } catch {
    // Intentionally broad catch: permission-denied, directory, oversized, symlink, etc.
    // Log a warning WITHOUT file contents (no secret leakage) and continue with null.
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'GATEWAY_PERSONA read failed — persona will be null; gateway startup continues. Check GATEWAY_PERSONA_FILE path, permissions, or whether the file exceeds the 4096-byte secret size limit.',
      }),
    )
  }

  // Announce/presence endpoint — opt-in: both secrets must be set together, or neither.
  // Mirrors the AWS credential pair-validation block above.
  const gatewayWebhookSecret = readOptionalSecret('GATEWAY_WEBHOOK_SECRET')
  const gatewayPresenceChannelId = readOptionalSecret('GATEWAY_PRESENCE_CHANNEL_ID')

  if (gatewayWebhookSecret !== null && gatewayPresenceChannelId === null) {
    throw new Error(
      'Both GATEWAY_WEBHOOK_SECRET and GATEWAY_PRESENCE_CHANNEL_ID must be set together (received: GATEWAY_WEBHOOK_SECRET, missing: GATEWAY_PRESENCE_CHANNEL_ID). Set both to enable the announce endpoint, or set neither to disable it.',
    )
  }

  if (gatewayPresenceChannelId !== null && gatewayWebhookSecret === null) {
    throw new Error(
      'Both GATEWAY_WEBHOOK_SECRET and GATEWAY_PRESENCE_CHANNEL_ID must be set together (received: GATEWAY_PRESENCE_CHANNEL_ID, missing: GATEWAY_WEBHOOK_SECRET). Set both to enable the announce endpoint, or set neither to disable it.',
    )
  }

  let announce:
    {readonly webhookSecret: string; readonly presenceChannelId: string; readonly httpPort: number} | undefined

  if (gatewayWebhookSecret !== null && gatewayPresenceChannelId !== null) {
    const rawHttpPort = readOptionalSecret('GATEWAY_HTTP_PORT') ?? '3000'
    const httpPort = Number.parseInt(rawHttpPort, 10)
    if (
      Number.isFinite(httpPort) === false ||
      Number.isInteger(httpPort) === false ||
      httpPort < 1 ||
      httpPort > 65535
    ) {
      throw new Error(`Invalid GATEWAY_HTTP_PORT value: "${rawHttpPort}" (must be an integer in the range 1–65535)`)
    }
    announce = {webhookSecret: gatewayWebhookSecret, presenceChannelId: gatewayPresenceChannelId, httpPort}
  }

  // Operator web surface — opt-in: all three required vars must be set together, or none.
  // Partial config (some but not all) fails closed with a clear error.
  const operatorBindHost = readOptionalSecret('GATEWAY_OPERATOR_BIND_HOST')
  const rawOperatorBindPort = readOptionalSecret('GATEWAY_OPERATOR_BIND_PORT')
  const operatorPublicOrigin = readOptionalSecret('GATEWAY_OPERATOR_PUBLIC_ORIGIN')

  const operatorVarsPresent = [operatorBindHost, rawOperatorBindPort, operatorPublicOrigin].filter(
    v => v !== null,
  ).length

  if (operatorVarsPresent > 0 && operatorVarsPresent < 3) {
    const missing: string[] = []
    if (operatorBindHost === null) missing.push('GATEWAY_OPERATOR_BIND_HOST')
    if (rawOperatorBindPort === null) missing.push('GATEWAY_OPERATOR_BIND_PORT')
    if (operatorPublicOrigin === null) missing.push('GATEWAY_OPERATOR_PUBLIC_ORIGIN')
    throw new Error(
      `Partial operator web config: all three of GATEWAY_OPERATOR_BIND_HOST, GATEWAY_OPERATOR_BIND_PORT, and GATEWAY_OPERATOR_PUBLIC_ORIGIN must be set together to enable the operator listener, or none to disable it. Missing: ${missing.join(', ')}.`,
    )
  }

  let operatorWeb: GatewayConfig['operatorWeb']

  if (operatorVarsPresent === 3) {
    // operatorVarsPresent === 3 means all three are non-null; narrow types with explicit guards.
    if (operatorBindHost === null || rawOperatorBindPort === null || operatorPublicOrigin === null) {
      throw new Error('Internal: operatorVarsPresent === 3 but a var is null — this is a bug')
    }

    // Validate bind host — must be a literal IP address (no hostnames).
    // isIP() returns 4 for IPv4, 6 for IPv6, 0 for non-IP (hostname or invalid).
    if (isIP(operatorBindHost) === 0) {
      throw new Error(
        `GATEWAY_OPERATOR_BIND_HOST must be a literal IP address, not a hostname: "${operatorBindHost}". Set it to the gateway container's gateway-net IP address (e.g. 172.20.0.2).`,
      )
    }

    // Reject all-interfaces binds: 0.0.0.0, ::, and the full-form 0:0:0:0:0:0:0:0.
    const ALL_INTERFACE_ADDRS = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0'])
    if (ALL_INTERFACE_ADDRS.has(operatorBindHost)) {
      throw new Error(
        `GATEWAY_OPERATOR_BIND_HOST must not be "${operatorBindHost}" — the operator listener must be bound to a specific gateway-net address, not all interfaces. Set it to the gateway container's gateway-net IP address.`,
      )
    }

    // Reject loopback: any 127.0.0.0/8 range, ::1, and full-form 0:0:0:0:0:0:0:1.
    //
    // Safe to use startsWith('127.') here: isIP() above has already proven this is a
    // literal IP address, so no hostname can reach this check. The prefix uniquely
    // identifies the 127.0.0.0/8 loopback range for dotted-decimal IPv4.
    const LOOPBACK_ADDRS = new Set(['::1', '0:0:0:0:0:0:0:1'])
    const isIPv4Loopback = operatorBindHost.startsWith('127.')
    if (isIPv4Loopback || LOOPBACK_ADDRS.has(operatorBindHost)) {
      throw new Error(
        `GATEWAY_OPERATOR_BIND_HOST must not be "${operatorBindHost}" — the operator listener must be bound to a gateway-net address, not the loopback interface. Set it to the gateway container's gateway-net IP address.`,
      )
    }

    // Reject sandbox-net: 10.0.0.0/8 (Docker internal network used by workspace).
    // The operator listener must be on gateway-net only, not reachable from sandbox-net.
    //
    // Safe to use startsWith('10.') here: isIP() above has already proven this is a
    // literal IPv4 address, so no hostname can reach this check. The prefix uniquely
    // identifies the 10.0.0.0/8 range for dotted-decimal IPv4.
    const isIPv4SandboxNet = operatorBindHost.startsWith('10.')
    if (isIPv4SandboxNet) {
      throw new Error(
        `GATEWAY_OPERATOR_BIND_HOST must not be "${operatorBindHost}" — 10.0.0.0/8 is the sandbox-net (Docker internal network). The operator listener must be on gateway-net only (e.g. 172.20.x.x). Set it to the gateway container's gateway-net IP address.`,
      )
    }

    // Reject all IPv6 literal addresses.
    //
    // gateway-net is an IPv4-only Docker bridge network; there is no IPv6 gateway-net
    // topology. Binding the operator listener to any IPv6 address would either fail at
    // runtime (no IPv6 interface on gateway-net) or silently bind to a different
    // interface than intended. Reject all IPv6 literals now and revisit when an IPv6
    // gateway-net topology exists.
    //
    // isIP() returns 6 for any valid IPv6 literal (including compressed forms like
    // '::1', 'fe80::1', 'fc00::1', '2001:db8::1'). The all-interfaces ('::') and
    // loopback ('::1', '0:0:0:0:0:0:0:1') cases are already caught above; this guard
    // catches all remaining IPv6 literals (ULA, link-local, global unicast, etc.).
    if (isIP(operatorBindHost) === 6) {
      throw new Error(
        `GATEWAY_OPERATOR_BIND_HOST must not be an IPv6 address: "${operatorBindHost}" — gateway-net is an IPv4-only Docker bridge network. IPv6 operator binds are not supported until an IPv6 gateway-net topology exists. Set it to the gateway container's IPv4 gateway-net address (e.g. 172.20.0.2).`,
      )
    }

    // Validate bind port.
    const operatorBindPort = Number.parseInt(rawOperatorBindPort, 10)
    if (
      Number.isFinite(operatorBindPort) === false ||
      Number.isInteger(operatorBindPort) === false ||
      operatorBindPort < 1 ||
      operatorBindPort > 65535
    ) {
      throw new Error(
        `Invalid GATEWAY_OPERATOR_BIND_PORT value: "${rawOperatorBindPort}" (must be an integer in the range 1–65535)`,
      )
    }

    // Validate public origin — must be a canonical https:// origin:
    //   scheme + host + optional port, no path beyond /, no query, no hash, no userinfo.
    // A canonical origin is used for OAuth callbacks, cookies, CORS, and CSRF checks.
    // Any extra component (path, query, hash, credentials) indicates a misconfiguration
    // that would silently break those checks at runtime.
    let parsedPublicOrigin: URL
    try {
      parsedPublicOrigin = new URL(operatorPublicOrigin)
    } catch {
      throw new Error(
        `Invalid GATEWAY_OPERATOR_PUBLIC_ORIGIN value: "${operatorPublicOrigin}" (must be a valid URL, e.g. https://operator.example.com)`,
      )
    }
    if (parsedPublicOrigin.protocol !== 'https:') {
      throw new Error(
        `Invalid GATEWAY_OPERATOR_PUBLIC_ORIGIN value: "${operatorPublicOrigin}" (must use https:// — the operator listener does not terminate TLS; TLS is handled by the infra reverse proxy)`,
      )
    }
    // Reject non-canonical origin components. A canonical origin has:
    //   - pathname of exactly '/' (URL always normalizes to '/' when no path is given)
    //   - no search (query string)
    //   - no hash
    //   - no username or password (userinfo)
    // pathname === '/' is the root — the only acceptable value. Any deeper path
    // (e.g. '/some/path') means the value is a URL, not an origin.
    if (parsedPublicOrigin.pathname !== '/') {
      throw new Error(
        `Invalid GATEWAY_OPERATOR_PUBLIC_ORIGIN value: "${operatorPublicOrigin}" — must be a canonical origin (scheme + host + optional port only). ` +
          `Remove the path component. A canonical origin has no path beyond /, no query, no hash, and no username/password. ` +
          `Example: https://operator.example.com`,
      )
    }
    if (parsedPublicOrigin.search !== '') {
      throw new Error(
        `Invalid GATEWAY_OPERATOR_PUBLIC_ORIGIN value: "${operatorPublicOrigin}" — must be a canonical origin (scheme + host + optional port only). ` +
          `Remove the query string. A canonical origin has no path beyond /, no query, no hash, and no username/password. ` +
          `Example: https://operator.example.com`,
      )
    }
    if (parsedPublicOrigin.hash !== '') {
      throw new Error(
        `Invalid GATEWAY_OPERATOR_PUBLIC_ORIGIN value: "${operatorPublicOrigin}" — must be a canonical origin (scheme + host + optional port only). ` +
          `Remove the hash fragment. A canonical origin has no path beyond /, no query, no hash, and no username/password. ` +
          `Example: https://operator.example.com`,
      )
    }
    if (parsedPublicOrigin.username !== '') {
      throw new Error(
        `Invalid GATEWAY_OPERATOR_PUBLIC_ORIGIN value: "${operatorPublicOrigin}" — must be a canonical origin (scheme + host + optional port only). ` +
          `Remove the username. A canonical origin has no path beyond /, no query, no hash, and no username/password. ` +
          `Example: https://operator.example.com`,
      )
    }
    if (parsedPublicOrigin.password !== '') {
      throw new Error(
        `Invalid GATEWAY_OPERATOR_PUBLIC_ORIGIN value: "${operatorPublicOrigin}" — must be a canonical origin (scheme + host + optional port only). ` +
          `Remove the password. A canonical origin has no path beyond /, no query, no hash, and no username/password. ` +
          `Example: https://operator.example.com`,
      )
    }

    // Read GitHub OAuth client credentials — required when operator web is enabled.
    // GATEWAY_OPERATOR_GITHUB_CLIENT_ID: GitHub OAuth App client ID.
    // Also accepts GATEWAY_OPERATOR_GITHUB_CLIENT_ID_FILE pointing to a file.
    const oauthClientId = readSecret('GATEWAY_OPERATOR_GITHUB_CLIENT_ID')
    const oauthClientSecret = readSecret('GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET')

    // Read optional OAuth tuning parameters with safe defaults.
    const rawAllowedReturnPaths = readOptionalSecret('GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS')
    const oauthAllowedReturnPaths: readonly string[] =
      rawAllowedReturnPaths === null
        ? ['/operator']
        : rawAllowedReturnPaths
            .split(',')
            .map(p => p.trim())
            .filter(p => p.length > 0)

    const rawStateTtlMs = readOptionalSecret('GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS')
    let oauthStateTtlMs = 600_000 // 10 minutes default
    if (rawStateTtlMs !== null) {
      const parsed = Number.parseInt(rawStateTtlMs, 10)
      if (Number.isFinite(parsed) === false || Number.isInteger(parsed) === false || parsed < 1) {
        throw new Error(
          `Invalid GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS value: "${rawStateTtlMs}" (must be a positive integer in milliseconds)`,
        )
      }
      oauthStateTtlMs = parsed
    }

    const rawMaxOutstanding = readOptionalSecret('GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS')
    let oauthMaxOutstandingAttemptsPerKey = 5 // default
    if (rawMaxOutstanding !== null) {
      const parsed = Number.parseInt(rawMaxOutstanding, 10)
      if (Number.isFinite(parsed) === false || Number.isInteger(parsed) === false || parsed < 1) {
        throw new Error(
          `Invalid GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS value: "${rawMaxOutstanding}" (must be a positive integer)`,
        )
      }
      oauthMaxOutstandingAttemptsPerKey = parsed
    }

    // Read and validate CSRF signing secret — required when operator web is enabled.
    // Must be a strict base64url string (no padding, no newlines, no non-base64url chars),
    // decode to at least 32 bytes (256 bits of HMAC-SHA256 key entropy), and be round-trip
    // stable (re-encoding the decoded bytes must reproduce the original string).
    //
    // GATEWAY_OPERATOR_CSRF_SECRET is an HMAC-SHA256 key with at least 256 bits of CSPRNG
    // entropy, encoded as base64url with no padding and no newlines.
    const rawCsrfSecret = readSecret('GATEWAY_OPERATOR_CSRF_SECRET')
    // Strict base64url: only A-Z, a-z, 0-9, -, _ (no padding, no whitespace, no +, /)
    // Use \w (word chars: [A-Za-z0-9_]) plus - for the full base64url alphabet.
    if (/^[\w-]+$/.test(rawCsrfSecret) === false) {
      throw new Error(
        String.raw`Invalid GATEWAY_OPERATOR_CSRF_SECRET: must be strict base64url encoding (characters A-Z, a-z, 0-9, -, _ only; no padding, no whitespace, no + or /). Generate with: node -e "require('crypto').randomBytes(32).toString('base64url')" | tr -d '\n'`,
      )
    }
    // Decode and check minimum length (32 bytes = 256 bits)
    const csrfKeyBytes = Buffer.from(rawCsrfSecret, 'base64url')
    if (csrfKeyBytes.length < 32) {
      throw new Error(
        String.raw`Invalid GATEWAY_OPERATOR_CSRF_SECRET: decoded to ${csrfKeyBytes.length} bytes but at least 32 bytes (256 bits) are required. Generate a new secret with: node -e "require('crypto').randomBytes(32).toString('base64url')" | tr -d '\n'`,
      )
    }
    // Round-trip stability: re-encoding must reproduce the original string
    const csrfSecretRoundTrip = csrfKeyBytes.toString('base64url')
    if (csrfSecretRoundTrip !== rawCsrfSecret) {
      throw new Error(
        'Invalid GATEWAY_OPERATOR_CSRF_SECRET: value is not round-trip stable (re-encoding the decoded bytes does not reproduce the original string). Ensure the value is canonical base64url with no padding.',
      )
    }
    const csrfSecret = rawCsrfSecret

    // Read operator allowlist — required when operator web is enabled.
    // Supports both file-backed (GATEWAY_OPERATOR_ALLOWLIST_FILE) and inline
    // (GATEWAY_OPERATOR_ALLOWLIST) variants. Fail-closed: missing/empty/malformed → throw.
    const rawAllowlistText = readOptionalMultilineSecret('GATEWAY_OPERATOR_ALLOWLIST')
    if (rawAllowlistText === null) {
      throw new Error(
        'Missing required operator allowlist: set GATEWAY_OPERATOR_ALLOWLIST env var (newline-separated numeric GitHub user IDs) or GATEWAY_OPERATOR_ALLOWLIST_FILE pointing to a file. The operator web surface requires an explicit allowlist — it cannot start without one.',
      )
    }
    const allowlistParseResult = parseAllowlistText(rawAllowlistText)
    if (allowlistParseResult.ok === false) {
      throw new Error(
        `Invalid operator allowlist: ${allowlistParseResult.reason}. Fix GATEWAY_OPERATOR_ALLOWLIST or GATEWAY_OPERATOR_ALLOWLIST_FILE. The operator web surface requires a valid, non-empty allowlist — it cannot start with a malformed or empty one.`,
      )
    }
    // Construct OperatorAllowlist directly from the parse result — no double parse, no dead logger.
    const {ids: allowlistIds} = allowlistParseResult
    const allowlist: OperatorAllowlist = {
      isAuthorized: (githubUserId: number) => allowlistIds.has(githubUserId),
      size: allowlistIds.size,
    }

    // Normalize to parsedPublicOrigin.origin: strips trailing slash and default ports.
    // Stored value is always scheme+host+optional-non-default-port (no trailing slash).
    operatorWeb = {
      bindHost: operatorBindHost,
      bindPort: operatorBindPort,
      publicOrigin: parsedPublicOrigin.origin,
      oauthClientId,
      oauthClientSecret,
      oauthAllowedReturnPaths,
      oauthStateTtlMs,
      oauthMaxOutstandingAttemptsPerKey,
      csrfSecret,
      allowlist,
    }
  }

  // Operator push — opt-in via GATEWAY_OPERATOR_PUSH_ENABLED. Disabled mode (the default)
  // ignores any VAPID material present and exposes no operatorPush config block. Enabled
  // mode requires complete, valid VAPID material and fails closed on any missing/malformed
  // value — mirroring the operator-web fail-closed posture above.
  //
  // The private key is read via readSecret/readOptionalSecret only. It is validated by
  // assertValidVapidKeyMaterial, which throws fixed reason strings that never embed the
  // private key value. The private key is stored only in operatorPush.current.privateKey /
  // operatorPush.previous.privateKey — route-facing code must read vapidPublicKeyInfo instead.
  const rawOperatorPushEnabled = readOptionalSecret(OPERATOR_PUSH_ENABLED)
  const operatorPushEnabled = rawOperatorPushEnabled === 'true'
  if (rawOperatorPushEnabled !== null && rawOperatorPushEnabled !== 'true' && rawOperatorPushEnabled !== 'false') {
    throw new Error(`Invalid ${OPERATOR_PUSH_ENABLED} value: "${rawOperatorPushEnabled}" (valid values: true, false)`)
  }

  let operatorPush: GatewayConfig['operatorPush']

  if (operatorPushEnabled) {
    const pushPublicKey = readSecret(OPERATOR_PUSH_VAPID_PUBLIC_KEY)
    const pushPrivateKey = readSecret(OPERATOR_PUSH_VAPID_PRIVATE_KEY)
    const pushSubject = readSecret(OPERATOR_PUSH_VAPID_SUBJECT)
    const pushKeyVersion = readSecret(OPERATOR_PUSH_VAPID_KEY_VERSION)

    const current: VapidKeyMaterial = buildVapidKeyMaterial(pushPublicKey, pushPrivateKey, pushSubject, pushKeyVersion)
    const vapidPublicKeyInfo = assertValidVapidKeyMaterial(current)

    // Optional previous keypair — opt-in as a group: all four previous-key vars must be
    // set together, or none, mirroring the AWS-credential and announce pair-validation
    // pattern above.
    const previousPublicKey = readOptionalSecret(OPERATOR_PUSH_PREVIOUS_VAPID_PUBLIC_KEY)
    const previousPrivateKey = readOptionalSecret(OPERATOR_PUSH_PREVIOUS_VAPID_PRIVATE_KEY)
    const previousSubject = readOptionalSecret(OPERATOR_PUSH_PREVIOUS_VAPID_SUBJECT)
    const previousKeyVersion = readOptionalSecret(OPERATOR_PUSH_PREVIOUS_VAPID_KEY_VERSION)

    const previousVarsPresent = [previousPublicKey, previousPrivateKey, previousSubject, previousKeyVersion].filter(
      v => v !== null,
    ).length

    if (previousVarsPresent > 0 && previousVarsPresent < 4) {
      const missing: string[] = []
      if (previousPublicKey === null) missing.push(OPERATOR_PUSH_PREVIOUS_VAPID_PUBLIC_KEY)
      if (previousPrivateKey === null) missing.push(OPERATOR_PUSH_PREVIOUS_VAPID_PRIVATE_KEY)
      if (previousSubject === null) missing.push(OPERATOR_PUSH_PREVIOUS_VAPID_SUBJECT)
      if (previousKeyVersion === null) missing.push(OPERATOR_PUSH_PREVIOUS_VAPID_KEY_VERSION)
      throw new Error(
        `Partial previous VAPID key config: all four of ${OPERATOR_PUSH_PREVIOUS_VAPID_PUBLIC_KEY}, ${OPERATOR_PUSH_PREVIOUS_VAPID_PRIVATE_KEY}, ${OPERATOR_PUSH_PREVIOUS_VAPID_SUBJECT}, and ${OPERATOR_PUSH_PREVIOUS_VAPID_KEY_VERSION} must be set together to accept a previous VAPID key during rollout, or none to omit it. Missing: ${missing.join(', ')}.`,
      )
    }

    let previous: VapidKeyMaterial | undefined
    if (previousVarsPresent === 4) {
      if (
        previousPublicKey === null ||
        previousPrivateKey === null ||
        previousSubject === null ||
        previousKeyVersion === null
      ) {
        throw new Error('Internal: previousVarsPresent === 4 but a var is null — this is a bug')
      }
      previous = buildVapidKeyMaterial(previousPublicKey, previousPrivateKey, previousSubject, previousKeyVersion)
      assertValidVapidKeyMaterial(previous)
    }

    const rawDedupeWindowMs = readOptionalSecret(OPERATOR_PUSH_DEDUPE_WINDOW_MS)
    let dedupeWindowMs = DEFAULT_OPERATOR_PUSH_DEDUPE_WINDOW_MS
    if (rawDedupeWindowMs !== null) {
      const parsed = Number.parseInt(rawDedupeWindowMs, 10)
      if (Number.isFinite(parsed) === false || Number.isInteger(parsed) === false || parsed < 1) {
        throw new Error(
          `Invalid ${OPERATOR_PUSH_DEDUPE_WINDOW_MS} value: "${rawDedupeWindowMs}" (must be a positive integer in milliseconds)`,
        )
      }
      dedupeWindowMs = parsed
    }

    operatorPush = {
      current,
      ...(previous === undefined ? {} : {previous}),
      vapidPublicKeyInfo,
      dedupeWindowMs,
    }
  }

  return {
    discordToken,
    discordApplicationId,
    discordGuildId,
    objectStore,
    identity,
    logLevel,
    privilegedIntents,
    approvalMode,
    statusMode,
    persona,
    githubAppId,
    githubAppPrivateKey,
    gatewayGitHubAppInstallUrl,
    workspaceAgentUrl,
    workspaceOpencodeUrl,
    workspaceOpencodeToken,
    triggerRoleId,
    maxConcurrentRuns,
    runTimeoutMs,
    runInactivityTimeoutMs,
    ...(announce === undefined ? {} : {announce}),
    ...(operatorWeb === undefined ? {} : {operatorWeb}),
    ...(operatorPush === undefined ? {} : {operatorPush}),
  }
}
