/**
 * Caller-provided MCP servers (`opencode-config` `mcp`) for an OpenCode V2 Action run (fro-bot/agent#1931).
 *
 * **Credential-withheld triggers (`pull_request`, `issue_comment`, `issues`): MCP is off.** The whole `mcp` key is
 * removed from the config before it reaches OpenCode. No screen of individual servers can hold, because OpenCode
 * resolves `{file:...}` and `{env:...}` in `OPENCODE_CONFIG_CONTENT` as text, before it parses it
 * (`core/src/config/variable.ts`): a header value, a query string or a server definition can all resolve to something
 * the harness never saw, and the default agent allows MCP tools (`allow *`). So the withheld path inspects nothing but
 * the server names, for the warning, and removes a top-level key whose own name carries a reference, since that could
 * resolve to `mcp`.
 *
 * **Provisioned runs** trust the caller's workflow: `mcp` passes through after validation. V2 2.2.5 reads two spellings
 * (`core/src/config/normalize.ts`): the legacy per-name map `mcp.<name>` and the native `mcp.servers.<name>`; a server
 * literally named `servers` or `timeout` is a server only when its value has `type: "local" | "remote"`. Both parse into
 * one typed list. The config is not rewritten into one spelling.
 *
 * What is validated is what the 2.2.5 source shows: the legacy server schema in full (`core/src/v1/config/mcp.ts`),
 * `mcp.timeout` (a bare number or an object of positive integers), and for native entries the fields both spellings
 * share (`type`, `command`, `cwd`, `environment`, `url`, `headers`, `codemode`, `enabled`/`disabled`, `timeout`, and that
 * `oauth` is `false` or an object). The native server schema itself is not in the readable source, so native-only
 * fields (`protocol`, the snake_case `oauth` keys) pass through unchecked; the server reports those as diagnostics.
 */

import type {Result} from '@bfra.me/es/result'
import type {CredentialDisposition} from '@fro-bot/runtime'
import type {Logger} from './types.js'

import {err, ok} from '@bfra.me/es/result'

interface McpServerBase {
  /** The key as authored. */
  readonly name: string
  /** `mcpToolNamespace(name)`: the prefix of every tool name upstream registers for this server. */
  readonly namespace: string
  /** Which spelling declared it. */
  readonly origin: 'legacy' | 'native'
}

export interface LocalMcpServerV2 extends McpServerBase {
  readonly kind: 'local'
  readonly command: readonly string[]
  readonly cwd?: string
  readonly environment: Readonly<Record<string, string>>
}

export interface RemoteMcpServerV2 extends McpServerBase {
  readonly kind: 'remote'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

export type McpServerV2 = LocalMcpServerV2 | RemoteMcpServerV2

export interface McpConfigError {
  readonly kind: 'duplicate-name' | 'invalid-name' | 'invalid-server' | 'not-an-object'
  /** The server key, or null when the whole `mcp` value is at fault. */
  readonly server: string | null
  /** Names the field and the server, never a configured value. */
  readonly message: string
}

/**
 * The namespace upstream gives an MCP server (`core/src/tool/mcp.ts` `namespace`, V2 2.2.5): every character outside
 * `[a-zA-Z0-9_-]` becomes `_`, and a tool is registered as `<namespace>_<tool>`. Two servers with one namespace would
 * share a tool prefix, so the parse rejects that. Pinned by a test.
 */
export function mcpToolNamespace(server: string): string {
  return server.replaceAll(/[^\w-]/g, '_')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string')
}

function isPositiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** `mcp.timeout`, and a native server's `timeout`: a bare number (V1) or an object of phase timeouts. */
function isTimeoutBlock(value: unknown): boolean {
  return isPositiveInt(value) || (isRecord(value) && Object.values(value).every(isPositiveInt))
}

/** A legacy server's `timeout` is a bare positive integer; a native one may also be an object of phases. */
function isServerTimeout(value: unknown, origin: 'legacy' | 'native'): boolean {
  return origin === 'legacy' ? isPositiveInt(value) : isTimeoutBlock(value)
}

/** The V1 `McpOAuthConfig` (`core/src/v1/config/mcp.ts`). */
function isLegacyOAuth(oauth: Record<string, unknown>): boolean {
  const strings = ['clientId', 'clientSecret', 'scope', 'redirectUri']
  const port = oauth.callbackPort
  return (
    strings.every(key => oauth[key] === undefined || typeof oauth[key] === 'string') &&
    (port === undefined || (Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65_535))
  )
}

function isDirectServer(value: unknown): boolean {
  return isRecord(value) && (value.type === 'local' || value.type === 'remote')
}

/** `core/src/config/normalize.ts` `isEnabledOnlyMcp`: a legacy `{enabled: false}` entry upstream omits. */
function isEnabledOnly(value: unknown): boolean {
  return isRecord(value) && !('type' in value) && typeof value.enabled === 'boolean'
}

function invalid(name: string, detail: string): Result<never, McpConfigError> {
  return err({
    kind: 'invalid-server',
    server: name,
    message: `opencode-config mcp server "${name}": ${detail}`,
  })
}

function parseServer(name: string, value: unknown, origin: 'legacy' | 'native'): Result<McpServerV2, McpConfigError> {
  if (name.length === 0) {
    return err({kind: 'invalid-name', server: name, message: 'opencode-config mcp server names must not be empty'})
  }
  if (!isRecord(value)) return invalid(name, 'must be an object')

  for (const flag of ['enabled', 'disabled', 'codemode']) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') return invalid(name, `${flag} must be a boolean`)
  }
  if (value.timeout !== undefined && !isServerTimeout(value.timeout, origin)) {
    return invalid(name, 'timeout must be a positive integer of milliseconds')
  }

  const base = {name, namespace: mcpToolNamespace(name), origin}

  if (value.type === 'local') {
    const {command} = value
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      !command.every(part => typeof part === 'string') ||
      command[0] === ''
    ) {
      return invalid(name, 'local servers need a non-empty command array of strings')
    }
    if (value.cwd !== undefined && typeof value.cwd !== 'string') return invalid(name, 'cwd must be a string')
    if (value.environment !== undefined && !isStringMap(value.environment)) {
      return invalid(name, 'environment must be an object of strings')
    }
    return ok({
      ...base,
      kind: 'local',
      command,
      ...(value.cwd === undefined ? {} : {cwd: value.cwd}),
      environment: value.environment ?? {},
    })
  }

  if (value.type === 'remote') {
    if (typeof value.url !== 'string') return invalid(name, 'remote servers need a url string')
    let protocol: string
    try {
      protocol = new URL(value.url).protocol
    } catch {
      return invalid(name, 'url must be an absolute http(s) URL')
    }
    if (protocol !== 'http:' && protocol !== 'https:') return invalid(name, 'url must be an absolute http(s) URL')
    if (value.headers !== undefined && !isStringMap(value.headers)) {
      return invalid(name, 'headers must be an object of strings')
    }
    const {oauth} = value
    if (oauth !== undefined && oauth !== false && !isRecord(oauth)) {
      return invalid(name, 'oauth must be false or an object')
    }
    if (origin === 'legacy' && isRecord(oauth) && !isLegacyOAuth(oauth)) {
      return invalid(name, 'oauth has a field of the wrong type')
    }
    return ok({
      ...base,
      kind: 'remote',
      url: value.url,
      headers: value.headers ?? {},
    })
  }

  return invalid(name, 'type must be "local" or "remote"')
}

/**
 * Parse the operator's `mcp` value into a typed server list, or fail with a named error. Fails on the first bad entry.
 * Two servers may not share a name or a sanitized name: both would own one tool prefix.
 */
export function parseMcpServersV2(mcp: unknown): Result<readonly McpServerV2[], McpConfigError> {
  if (!isRecord(mcp)) {
    return err({kind: 'not-an-object', server: null, message: 'opencode-config mcp must be a JSON object'})
  }

  const entries: {readonly name: string; readonly value: unknown; readonly origin: 'legacy' | 'native'}[] = []
  for (const [key, value] of Object.entries(mcp)) {
    if (isEnabledOnly(value)) continue
    if (key === 'servers' && !isDirectServer(value)) {
      if (!isRecord(value)) {
        return err({kind: 'not-an-object', server: null, message: 'opencode-config mcp.servers must be a JSON object'})
      }
      for (const [name, server] of Object.entries(value)) entries.push({name, value: server, origin: 'native'})
      continue
    }
    if (key === 'timeout' && !isDirectServer(value)) {
      if (!isTimeoutBlock(value)) {
        return err({
          kind: 'invalid-server',
          server: null,
          message: 'opencode-config mcp.timeout must be a positive integer or an object of positive integers',
        })
      }
      continue
    }
    entries.push({name: key, value, origin: 'legacy'})
  }

  const servers: McpServerV2[] = []
  const namespaces = new Map<string, string>()
  for (const {name, value, origin} of entries) {
    const parsed = parseServer(name, value, origin)
    if (!parsed.success) return parsed
    const {namespace} = parsed.data
    if (namespaces.has(namespace)) {
      return err({
        kind: 'duplicate-name',
        server: name,
        message: `opencode-config mcp server "${name}" shares the tool prefix "${namespace}" with another server`,
      })
    }
    namespaces.set(namespace, name)
    servers.push(parsed.data)
  }
  return ok(servers)
}

/**
 * A `{file:}` reference OpenCode resolves in the config text before it parses it (`core/src/config/variable.ts`).
 * `{env:}` has no branch here: the config builder fails setup on one before this runs.
 */
const FILE_REFERENCE_OPENING = '{file:'

const MAX_LOGGED_NAMES = 20
const MAX_LOGGED_NAME_LENGTH = 64

/**
 * The configured server names for the warning, sanitized to `[a-zA-Z0-9_-]` and bounded, from whatever shape `mcp`
 * has: a name is operator text, so it is never logged as typed. Empty when the block is not an object.
 */
function serverNamesForLog(mcp: unknown): readonly string[] {
  if (!isRecord(mcp)) return []
  const names: string[] = []
  for (const [key, value] of Object.entries(mcp)) {
    if (key === 'servers' && !isDirectServer(value)) {
      if (isRecord(value)) names.push(...Object.keys(value))
      continue
    }
    if (key === 'timeout' && !isDirectServer(value)) continue
    names.push(key)
  }
  const unique = [...new Set(names.map(name => mcpToolNamespace(name).slice(0, MAX_LOGGED_NAME_LENGTH)))]
  return unique.length > MAX_LOGGED_NAMES
    ? [...unique.slice(0, MAX_LOGGED_NAMES), `and ${unique.length - MAX_LOGGED_NAMES} more`]
    : unique
}

/**
 * Apply the credential disposition to the operator's config (see the file header).
 *
 * `withhold`: removes `mcp`, and any top-level key whose name carries a `{file:}` reference, with one
 * warning each; never fails, so an unparseable block is removed too. `provision`: validates `mcp` and passes the config
 * through unchanged, failing on a bad shape so a mistyped config stops setup instead of running without its server.
 */
export function applyOperatorMcpV2(
  operator: Record<string, unknown>,
  credential: CredentialDisposition,
  logger: Logger,
): Result<Record<string, unknown>, McpConfigError> {
  if (credential === 'provision') {
    if (!('mcp' in operator)) return ok(operator)
    const parsed = parseMcpServersV2(operator.mcp)
    return parsed.success ? ok(operator) : parsed
  }

  const referencedKeys = Object.keys(operator).filter(key => key.includes(FILE_REFERENCE_OPENING))
  const hasMcp = 'mcp' in operator
  if (!hasMcp && referencedKeys.length === 0) return ok(operator)

  if (hasMcp) {
    const names = serverNamesForLog(operator.mcp)
    logger.warning(
      `MCP servers are not run while the credential is withheld: removed opencode-config mcp${
        names.length === 0 ? '' : ` (servers: ${names.join(', ')})`
      }`,
    )
  }
  if (referencedKeys.length > 0) {
    logger.warning(
      `Removed ${referencedKeys.length} opencode-config key(s) whose name carries a {file:} reference: OpenCode resolves it before it reads the key, so it could be mcp, which is not run while the credential is withheld`,
    )
  }

  return ok(
    Object.fromEntries(Object.entries(operator).filter(([key]) => key !== 'mcp' && !referencedKeys.includes(key))),
  )
}
