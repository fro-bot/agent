import type {AwsCredentials, ObjectStoreConfig} from './runtime-effect.js'

import {closeSync, constants, fstatSync, openSync, readFileSync} from 'node:fs'
import process from 'node:process'

import {GatewayIntentBits} from 'discord.js'

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
   * Approval mode for tool permission requests during mention runs.
   * - `approval-required` (default): routes permission asks to Discord approval UI.
   *
   * Note: `autonomous-low-risk` is deferred and explicitly rejected at startup. See config.ts for
   * the rationale (OpenCode last-match-wins evaluation makes session-scoped denies unsafe).
   */
  readonly approvalMode: 'approval-required'
  /**
   * Canonical Fro Bot persona text, read from `GATEWAY_PERSONA_FILE` (or `GATEWAY_PERSONA` env var).
   * Prepended to every Discord mention prompt before the Discord-mechanical guidance.
   * `null` when unset, empty, or whitespace-only — the mention loop degrades gracefully to
   * mechanical guidance only (R4 fail-soft).
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

  const rawRunTimeout = readOptionalSecret('GATEWAY_RUN_TIMEOUT_MS') ?? '600000'
  if (/^[1-9]\d*$/.test(rawRunTimeout) === false) {
    throw new Error(`Invalid GATEWAY_RUN_TIMEOUT_MS value: "${rawRunTimeout}" (must be a positive integer)`)
  }
  const runTimeoutMs = Number.parseInt(rawRunTimeout, 10)
  if (Number.isFinite(runTimeoutMs) === false || Number.isInteger(runTimeoutMs) === false || runTimeoutMs < 1) {
    throw new Error(`Invalid GATEWAY_RUN_TIMEOUT_MS value: "${rawRunTimeout}" (must be a positive integer)`)
  }

  // Persona — optional multi-line markdown file (e.g. fro-bot-persona.md).
  // Uses readOptionalMultilineSecret because persona files contain embedded newlines.
  // Absent/empty/whitespace → null (R4 fail-soft: the mention loop degrades gracefully).
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
        msg: 'GATEWAY_PERSONA read failed — persona will be null; gateway startup continues. Check GATEWAY_PERSONA_FILE path and permissions.',
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
    | {readonly webhookSecret: string; readonly presenceChannelId: string; readonly httpPort: number}
    | undefined

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

  return {
    discordToken,
    discordApplicationId,
    discordGuildId,
    objectStore,
    identity,
    logLevel,
    privilegedIntents,
    approvalMode,
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
    ...(announce === undefined ? {} : {announce}),
  }
}
