/**
 * Caller-provided MCP servers (`opencode-config` `mcp`) for an OpenCode V2 Action run (fro-bot/agent#1931).
 *
 * **Credential-withheld triggers (`pull_request`, `issue_comment`, `issues`): only static local servers run.** A server
 * is kept only when its `type` is the literal `"local"`, it parses, and no `{file:` or `{env:` opening appears anywhere in
 * its original definition: its name, every known field and every nested or unknown key and string. Every other server is
 * dropped (all `remote` servers, any server with a reference, any malformed entry), and the `mcp` key goes when none is
 * left. OpenCode resolves `{file:...}` and `{env:...}` in `OPENCODE_CONFIG_CONTENT` as text, before it parses it
 * (`core/src/config/variable.ts`), so a value or a key with a reference can become anything the harness never saw, and
 * the default agent allows MCP tools (`allow *`). A top-level key whose own name carries a `{file:}` reference is
 * removed too, since it could resolve to `mcp`; that check is on top-level key names only, not recursive. `{env:}` in the
 * whole config fails setup earlier (`buildCIConfigV2`), so dropping a server for it is a helper-level rule.
 *
 * A kept server is trusted operator code, not a sandbox. Its definition is static, but the command, its arguments and
 * any literal `environment` value reach a process that the checkout controls, and the process can read what the runner
 * lets it. Operators must not put secrets in them. Fork pull requests stay the caller's restriction. The child
 * environment is unchanged (`filterAgentEnv(process.env)` plus the server keys).
 *
 * **Provisioned runs** trust the caller's workflow: `mcp` passes through after validation. V2 2.2.5 reads two spellings
 * (`core/src/config/normalize.ts`): the legacy per-name map `mcp.<name>` and the native `mcp.servers.<name>`; a server
 * literally named `servers` or `timeout` is a server only when its value has `type: "local" | "remote"`. Both parse into
 * one typed list. The config is not rewritten into one spelling.
 *
 * A string field that holds a `{env:}` or `{file:}` reference (a url, a referenced number or boolean, a referenced `type`)
 * is passed through without our format checks: OpenCode resolves it first, so OpenCode checks it. A referenced `type`
 * parses as a server of `unresolved` kind, and the launch fields that depend on the kind are then not checked. Structure
 * is still checked as written (`command` an array, `environment` and `headers` string maps, a url a string).
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

/** A server whose `type` is a reference OpenCode resolves later, so nothing that depends on the kind can be checked. */
export interface UnresolvedMcpServerV2 extends McpServerBase {
  readonly kind: 'unresolved'
}

export type McpServerV2 = LocalMcpServerV2 | RemoteMcpServerV2 | UnresolvedMcpServerV2

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

/**
 * A string that holds a `{env:...}` or `{file:...}` reference, anywhere in it. OpenCode substitutes these in the config
 * text before it parses it (`core/src/config/variable.ts`), so what the field becomes, and whether that is valid, is
 * OpenCode's to decide: our format checks defer to it. Structure is still ours: a field's type is checked as written.
 */
function isReference(value: unknown): value is string {
  return typeof value === 'string' && (value.includes('{env:') || value.includes('{file:'))
}

function isPositiveInt(value: unknown): boolean {
  return isReference(value) || (typeof value === 'number' && Number.isInteger(value) && value > 0)
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
    (port === undefined ||
      isReference(port) ||
      (Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65_535))
  )
}

/** A server definition (`type` is `local`, `remote` or a reference to one), as against the native map or `timeout`. */
function isDirectServer(value: unknown): boolean {
  return isRecord(value) && (value.type === 'local' || value.type === 'remote' || isReference(value.type))
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

function isHttpUrl(value: string): boolean {
  try {
    const {protocol} = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function parseServer(name: string, value: unknown, origin: 'legacy' | 'native'): Result<McpServerV2, McpConfigError> {
  if (name.length === 0) {
    return err({kind: 'invalid-name', server: name, message: 'opencode-config mcp server names must not be empty'})
  }
  if (!isRecord(value)) return invalid(name, 'must be an object')

  for (const flag of ['enabled', 'disabled', 'codemode']) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean' && !isReference(value[flag])) {
      return invalid(name, `${flag} must be a boolean`)
    }
  }
  if (value.timeout !== undefined && !isServerTimeout(value.timeout, origin)) {
    return invalid(name, 'timeout must be a positive integer of milliseconds')
  }

  const base = {name, namespace: mcpToolNamespace(name), origin}

  // A referenced `type` is OpenCode's to resolve: which launch fields apply, and whether they are valid, follows from it.
  if (isReference(value.type)) return ok({...base, kind: 'unresolved'})

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
    // A literal url is ours to check; one with a reference in it is checked by OpenCode once it is resolved.
    if (!isReference(value.url) && !isHttpUrl(value.url)) return invalid(name, 'url must be an absolute http(s) URL')
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

interface McpEntry {
  /** The key as authored. */
  readonly name: string
  /** The definition exactly as written: the withheld path inspects this, not the parsed launch fields. */
  readonly value: unknown
  readonly origin: 'legacy' | 'native'
}

interface McpLayout {
  readonly entries: readonly McpEntry[]
  /** The `mcp.timeout` block, when the key holds one rather than a server named `timeout`. */
  readonly timeout: {readonly value: unknown} | undefined
}

/**
 * Split the operator's `mcp` value into its server entries and its `timeout` block, in both spellings and with the
 * `servers`/`timeout` name disambiguation. The one place that reads the layout: the strict parse and the withheld filter
 * both start here. Fails only when the layout itself cannot be read.
 */
function readMcpLayout(mcp: unknown): Result<McpLayout, McpConfigError> {
  if (!isRecord(mcp)) {
    return err({kind: 'not-an-object', server: null, message: 'opencode-config mcp must be a JSON object'})
  }

  const entries: McpEntry[] = []
  let timeout: McpLayout['timeout']
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
      timeout = {value}
      continue
    }
    entries.push({name: key, value, origin: 'legacy'})
  }
  return ok({entries, timeout})
}

/**
 * Parse the operator's `mcp` value into a typed server list, or fail with a named error. Fails on the first bad entry.
 * Two servers may not share a name or a sanitized name: both would own one tool prefix.
 */
export function parseMcpServersV2(mcp: unknown): Result<readonly McpServerV2[], McpConfigError> {
  const layout = readMcpLayout(mcp)
  if (!layout.success) return layout
  if (layout.data.timeout !== undefined && !isTimeoutBlock(layout.data.timeout.value)) {
    return err({
      kind: 'invalid-server',
      server: null,
      message: 'opencode-config mcp.timeout must be a positive integer or an object of positive integers',
    })
  }

  const servers: McpServerV2[] = []
  const namespaces = new Map<string, string>()
  for (const {name, value, origin} of layout.data.entries) {
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
 * A `{file:}` or `{env:}` reference OpenCode resolves in the config text before it parses it
 * (`core/src/config/variable.ts`). On a withheld run `{env:}` fails setup before this runs, so it matters at the helper
 * level only.
 */
const REFERENCE_OPENINGS = ['{file:', '{env:'] as const

function hasReferenceOpening(text: string): boolean {
  return REFERENCE_OPENINGS.some(opening => text.includes(opening))
}

/** Whether a reference opens anywhere in a definition: a key or a string, at any depth, known field or not. */
function containsReference(value: unknown): boolean {
  if (typeof value === 'string') return hasReferenceOpening(value)
  if (Array.isArray(value)) return value.some(containsReference)
  if (isRecord(value)) {
    return Object.entries(value).some(([key, entry]) => hasReferenceOpening(key) || containsReference(entry))
  }
  return false
}

const MAX_LOGGED_NAMES = 20
const MAX_LOGGED_NAME_LENGTH = 64

/** Sanitize to `[a-zA-Z0-9_-]`, drop repeats and bound the list: a name is operator text, so it is never logged as typed. */
function namesForLog(names: readonly string[]): readonly string[] {
  const unique = [...new Set(names.map(name => mcpToolNamespace(name).slice(0, MAX_LOGGED_NAME_LENGTH)))]
  return unique.length > MAX_LOGGED_NAMES
    ? [...unique.slice(0, MAX_LOGGED_NAMES), `and ${unique.length - MAX_LOGGED_NAMES} more`]
    : unique
}

/** The configured server names, from whatever shape `mcp` has. Empty when the block is not an object. */
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
  return namesForLog(names)
}

/** A server a credential-withheld run keeps: a literal `local` that parses, with no reference anywhere in it. */
function isStaticLocal({name, value, origin}: McpEntry): boolean {
  if (hasReferenceOpening(name) || containsReference(value)) return false
  if (!isRecord(value) || value.type !== 'local') return false
  const parsed = parseServer(name, value, origin)
  return parsed.success && parsed.data.kind === 'local'
}

interface WithheldMcp {
  /** What is left of `mcp`, or undefined when nothing is. */
  readonly mcp: Record<string, unknown> | undefined
  readonly kept: readonly string[]
  readonly dropped: readonly string[]
}

/**
 * Filter `mcp` server by server. A kept server is passed through exactly as authored, in the spelling it was written in.
 * A layout that cannot be read drops the whole block. Two kept servers that share a tool prefix are both dropped.
 */
function filterWithheldMcp(mcp: unknown): WithheldMcp {
  const layout = readMcpLayout(mcp)
  if (!layout.success) return {mcp: undefined, kept: [], dropped: serverNamesForLog(mcp)}

  const candidates = layout.data.entries.filter(isStaticLocal)
  const prefixCounts = new Map<string, number>()
  for (const {name} of candidates) {
    const prefix = mcpToolNamespace(name)
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1)
  }
  const kept = candidates.filter(({name}) => prefixCounts.get(mcpToolNamespace(name)) === 1)
  const keptEntries = new Set(kept)
  const dropped = layout.data.entries.filter(entry => !keptEntries.has(entry))

  if (kept.length === 0) return {mcp: undefined, kept: [], dropped: namesForLog(dropped.map(({name}) => name))}

  const toEntry = ({name, value}: McpEntry): [string, unknown] => [name, value]
  const timeout = layout.data.timeout
  const keptTimeout: [string, unknown][] =
    timeout !== undefined && isTimeoutBlock(timeout.value) && !containsReference(timeout.value)
      ? [['timeout', timeout.value]]
      : []
  const nativeServers: [string, unknown][] = kept.filter(entry => entry.origin === 'native').map(toEntry)
  // Object.fromEntries defines own keys, so a server named `__proto__` stays a key.
  const out: Record<string, unknown> = Object.fromEntries([
    ...kept.filter(entry => entry.origin === 'legacy').map(toEntry),
    ...(nativeServers.length === 0 ? [] : [['servers', Object.fromEntries(nativeServers)] as [string, unknown]]),
    ...keptTimeout,
  ])
  return {
    mcp: out,
    kept: namesForLog(kept.map(({name}) => name)),
    dropped: namesForLog(dropped.map(({name}) => name)),
  }
}

/**
 * Apply the credential disposition to the operator's config (see the file header).
 *
 * `withhold`: keeps only the static local servers of `mcp`, and removes any top-level key whose name carries a `{file:}`
 * reference; never fails, so an unparseable block is removed too. Logs the kept and dropped servers by name. `provision`:
 * validates `mcp` and passes the config through unchanged, failing on a bad shape so a mistyped config stops setup
 * instead of running without its server.
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

  const referencedKeys = Object.keys(operator).filter(key => key.includes('{file:'))
  const hasMcp = 'mcp' in operator
  if (!hasMcp && referencedKeys.length === 0) return ok(operator)

  let filtered: WithheldMcp = {mcp: undefined, kept: [], dropped: []}
  if (hasMcp) {
    filtered = filterWithheldMcp(operator.mcp)
    if (filtered.kept.length > 0) {
      logger.info(
        `MCP servers kept while the credential is withheld (local, with no {env:} or {file:} reference): ${filtered.kept.join(', ')}`,
      )
    }
    if (filtered.dropped.length > 0 || filtered.kept.length === 0) {
      logger.warning(
        `MCP servers removed while the credential is withheld (only local servers with no {env:} or {file:} reference are run)${
          filtered.dropped.length === 0 ? '' : `: ${filtered.dropped.join(', ')}`
        }`,
      )
    }
  }
  if (referencedKeys.length > 0) {
    logger.warning(
      `Removed ${referencedKeys.length} opencode-config key(s) whose name carries a {file:} reference: OpenCode resolves it before it reads the key, so it could be mcp, which is filtered while the credential is withheld`,
    )
  }

  return ok(
    Object.fromEntries(
      Object.entries(operator).flatMap(([key, value]) => {
        if (referencedKeys.includes(key)) return []
        if (key !== 'mcp') return [[key, value]]
        return filtered.mcp === undefined ? [] : [[key, filtered.mcp]]
      }),
    ),
  )
}
