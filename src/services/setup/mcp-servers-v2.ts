/**
 * Caller-provided MCP servers (`opencode-config` `mcp`) for an OpenCode V2 Action run (fro-bot/agent#1931).
 *
 * **Credential-withheld runs (every trigger except `schedule` and `workflow_dispatch`): only static local servers run.** A server
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
import type {CredentialDisposition, KeyProxyMcpRouteConfig} from '@fro-bot/runtime'
import type {Logger} from './types.js'

import {err, ok} from '@bfra.me/es/result'
import {KEY_PROXY_MCP_FORBIDDEN_HEADERS, validateUpstreamUrl} from '@fro-bot/runtime'

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

/** What an `mcp` key holds: the native `servers` map, the `timeout` block, an `enabled`-only stub, or a server. */
type McpKeyRole = 'native-servers' | 'server' | 'stub' | 'timeout'

/** The one place that tells the `servers` and `timeout` keys from servers of those names. */
function mcpKeyRole(key: string, value: unknown): McpKeyRole {
  if (isEnabledOnly(value)) return 'stub'
  if (key === 'servers' && !isDirectServer(value)) return 'native-servers'
  if (key === 'timeout' && !isDirectServer(value)) return 'timeout'
  return 'server'
}

/**
 * Split the operator's `mcp` value into its server entries and its `timeout` block, in both spellings and with the
 * `servers`/`timeout` name disambiguation. The one place that reads the layout: the strict parse and the withheld filter
 * both start here. Fails only when the layout itself cannot be read. An `enabled`-only stub is skipped, as upstream omits
 * it, unless `keepStubs` asks for it as an entry: the broker must see a stub that also carries `headers`.
 */
function readMcpLayout(mcp: unknown, options: {readonly keepStubs?: boolean} = {}): Result<McpLayout, McpConfigError> {
  if (!isRecord(mcp)) {
    return err({kind: 'not-an-object', server: null, message: 'opencode-config mcp must be a JSON object'})
  }

  const entries: McpEntry[] = []
  let timeout: McpLayout['timeout']
  for (const [key, value] of Object.entries(mcp)) {
    const role = mcpKeyRole(key, value)
    if (role === 'stub') {
      if (options.keepStubs === true) entries.push({name: key, value, origin: 'legacy'})
      continue
    }
    if (role === 'native-servers') {
      if (!isRecord(value)) {
        return err({kind: 'not-an-object', server: null, message: 'opencode-config mcp.servers must be a JSON object'})
      }
      for (const [name, server] of Object.entries(value)) entries.push({name, value: server, origin: 'native'})
      continue
    }
    if (role === 'timeout') {
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

// --- The credential broker (`isolate-agent`) -------------------------------------------------------------------------
//
// Under `isolate-agent` the sandbox user reads the whole `OPENCODE_CONFIG_CONTENT`, so a remote server's `headers` would
// hand its credential to the model. Instead every remote entry that has a `headers` key becomes a route on the key-proxy
// child, which holds the headers and adds them to each request it forwards to the server's fixed HTTPS upstream; the
// entry the sandbox reads points at the loopback route and has no headers. This section is the Action's half of that:
// classify (`planMcpBrokerV2`), then rewrite (`applyBrokeredMcpV2`). Brokering is keyed on the presence of `headers`
// alone: a header name is never used to guess which value is a credential.

export type McpBrokerLayout = McpEntry['origin']

/** Names one entry of the operator's `mcp`: the key as authored, in the spelling that declared it. */
export interface McpBrokerEntryRef {
  readonly name: string
  readonly layout: McpBrokerLayout
}

/** One entry the child serves: what to rewrite (`name`, `layout`) and what the child is told (`route`). */
export interface McpBrokerRouteV2 extends McpBrokerEntryRef {
  readonly route: KeyProxyMcpRouteConfig
}

/** A header value the Action masks and scans for, with the sanitized name of the first server that holds it. */
export interface McpBrokerSecretV2 {
  readonly server: string
  readonly value: string
}

export interface McpBrokerPlanV2 {
  /** In config order. Their `route` values are what the child receives. */
  readonly routes: readonly McpBrokerRouteV2[]
  /** Definitively disabled entries: their `headers` are dropped and no route exists. */
  readonly stripped: readonly McpBrokerEntryRef[]
  /** Values of 8 characters or more, and the token after a `Bearer`, `Basic` or `Token` scheme, each once. */
  readonly secrets: readonly McpBrokerSecretV2[]
}

export type McpBrokerRefusalKind =
  | 'conflicting-flags'
  | 'enabled-stub'
  | 'header-duplicate'
  | 'header-forbidden'
  | 'header-name-invalid'
  | 'header-value-invalid'
  | 'header-value-too-long'
  | 'headers-invalid'
  | 'headers-too-large'
  | 'local-with-headers'
  | 'oauth'
  | 'reference'
  | 'reference-key'
  | 'too-many-headers'
  | 'too-many-servers'
  | 'unreadable-layout'
  | 'unresolved-flag'
  | 'unresolved-type'
  | 'unsupported-type'
  | 'url-fragment'
  | 'url-invalid'
  | 'url-not-https'
  | 'url-path'
  | 'url-query'
  | 'url-unsafe-host'
  | 'url-userinfo'

export interface McpBrokerRefusal {
  readonly kind: McpBrokerRefusalKind
  /** The sanitized, bounded server name, or null when the refusal is about the whole block. */
  readonly server: string | null
  /** Names the rule and a fix. Never a configured value (a server name is sanitized, a header name echoed only as a token). */
  readonly message: string
}

/** The most servers one run brokers, headers one server may carry, and bytes of header text the frame may hold. */
const MAX_BROKERED_SERVERS = 64
const MAX_BROKERED_HEADERS_PER_SERVER = 32
const MAX_BROKERED_HEADER_VALUE_LENGTH = 4096
const MAX_BROKERED_HEADER_BYTES = 256 * 1024
const MAX_BROKERED_URL_LENGTH = 2048

/** Header values shorter than this are brokered but not masked or scanned: `1` or `v1` would refuse unrelated config. */
const SECRET_FLOOR = 8

/** RFC 9110 `token`: the characters a header name may hold. */
const HEADER_NAME_TOKEN = /^[!#$%&'*+\-.^\w`|~]+$/

/** What Node accepts in a header value (`checkInvalidHeaderChar`): tab, printable ASCII and the Latin-1 supplement. */
const HEADER_VALUE_CHARS = /^[\t\x20-\x7E\x80-\xFF]*$/

/** An authorization scheme and its token. */
const SCHEME_TOKEN = /^(?:bearer|basic|token)\s+(\S(?:.*\S)?)\s*$/i

const STRUCTURAL_ENCODING = /%(?:2f|5c|2e|3b|25)/i

function brokerRefusal(
  kind: McpBrokerRefusalKind,
  name: string,
  problem: string,
  fix: string,
): Result<never, McpBrokerRefusal> {
  const server = mcpToolNamespace(name).slice(0, MAX_LOGGED_NAME_LENGTH)
  return err({kind, server, message: `isolate-agent: MCP server "${server}" ${problem}. Fix: ${fix}.`})
}

function blockRefusal(kind: McpBrokerRefusalKind, problem: string, fix: string): Result<never, McpBrokerRefusal> {
  return err({kind, server: null, message: `isolate-agent: ${problem}. Fix: ${fix}.`})
}

type DisabledState = 'active' | 'conflict' | 'disabled' | 'unresolved'

/** `enabled: false` (flat) and `disabled: true` (native) both disable; each must be a literal boolean, and agree. */
function disabledStateOf(entry: Record<string, unknown>): DisabledState {
  const {enabled, disabled} = entry
  if (
    (enabled !== undefined && typeof enabled !== 'boolean') ||
    (disabled !== undefined && typeof disabled !== 'boolean')
  ) {
    return 'unresolved'
  }
  if (enabled !== undefined && disabled !== undefined && enabled === disabled) return 'conflict'
  return enabled === false || disabled === true ? 'disabled' : 'active'
}

/** A path the child can send upstream as it stands: printable ASCII, no `;` or `\`, no encoded structure, no empty or dot segment. */
function isCanonicalUpstreamPath(pathname: string): boolean {
  if (!/^\/[\x21-\x7E]*$/.test(pathname)) return false
  if (pathname.includes(';') || pathname.includes('\\') || STRUCTURAL_ENCODING.test(pathname)) return false
  const segments = pathname.split('/').slice(1)
  // One empty final segment is a trailing slash, which an upstream may require.
  const body = segments.at(-1) === '' ? segments.slice(0, -1) : segments
  return body.every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

interface UpstreamProblem {
  readonly kind: McpBrokerRefusalKind
  readonly problem: string
  readonly fix: string
}

/** The fixed upstream of a brokered server, or what is wrong with its `url`. The configured text is never quoted. */
function upstreamOf(raw: unknown): {readonly origin: string; readonly path: string} | UpstreamProblem {
  const invalid = (problem: string): UpstreamProblem => ({
    kind: 'url-invalid',
    problem,
    fix: 'set `url` to an absolute https URL written out in full',
  })
  if (typeof raw !== 'string' || raw.length > MAX_BROKERED_URL_LENGTH)
    return invalid('has a `url` that is not a usable string')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return invalid('has a `url` that is not a valid URL')
  }
  if (url.protocol !== 'https:') {
    return {
      kind: 'url-not-https',
      problem: 'has a `url` that is not https, so the broker could not keep its headers private on the wire',
      fix: 'serve the MCP server over https and use that URL',
    }
  }
  const prefix = /^https:\/\/([^/?#]*)/i.exec(raw)
  if (prefix === null) return invalid('has a `url` that is not written as `https://host/path`')
  if (prefix[1]?.includes('@') === true) {
    return {
      kind: 'url-userinfo',
      problem: 'has a `url` with credentials in it',
      fix: 'remove the user and password from the `url` and send them in a header the broker holds',
    }
  }
  if (raw.includes('#')) {
    return {kind: 'url-fragment', problem: 'has a `url` with a fragment', fix: 'remove the `#` and what follows it'}
  }
  if (raw.includes('?')) {
    return {
      kind: 'url-query',
      problem: 'has a `url` with a query string, which the broker does not forward from the configured URL',
      fix: 'remove the query from the `url`; a credential belongs in a header the broker holds',
    }
  }
  if (!validateUpstreamUrl(raw).success) {
    return {
      kind: 'url-unsafe-host',
      problem: 'has a `url` that targets a cloud metadata service',
      fix: 'point `url` at the MCP server',
    }
  }
  const written = raw.slice(prefix[0].length)
  if ((written === '' ? '/' : written) !== url.pathname || !isCanonicalUpstreamPath(url.pathname)) {
    return {
      kind: 'url-path',
      problem:
        'has a `url` path the broker cannot send as written (a dot or empty segment, `;`, `\\`, an encoded `/` or `.`, or a character that URL parsing would change)',
      fix: 'write the path in its plain, normalised form',
    }
  }
  return {origin: url.origin, path: url.pathname}
}

/** The values of one header that are masked and scanned: the whole value, and the token after an authorization scheme. */
function secretsOfHeaderValue(value: string): string[] {
  const found: string[] = []
  if (value.length >= SECRET_FLOOR) found.push(value)
  const token = SCHEME_TOKEN.exec(value)?.[1]
  if (token !== undefined && token.length >= SECRET_FLOOR) found.push(token)
  return found
}

type HeadersCheck = Result<
  {readonly headers: Readonly<Record<string, string>>; readonly bytes: number},
  McpBrokerRefusal
>

function checkBrokeredHeaders(name: string, headers: unknown): HeadersCheck {
  if (!isRecord(headers)) {
    return brokerRefusal(
      'headers-invalid',
      name,
      'has `headers` that is not an object of strings',
      'make `headers` an object of strings',
    )
  }
  const entries = Object.entries(headers)
  if (entries.length > MAX_BROKERED_HEADERS_PER_SERVER) {
    return brokerRefusal(
      'too-many-headers',
      name,
      `sets more than ${MAX_BROKERED_HEADERS_PER_SERVER} headers`,
      'keep only the headers the server needs',
    )
  }
  const seen = new Set<string>()
  const checked: Record<string, string> = {}
  let bytes = 0
  for (const [headerName, headerValue] of entries) {
    if (!HEADER_NAME_TOKEN.test(headerName)) {
      return brokerRefusal(
        'header-name-invalid',
        name,
        'sets a header whose name is empty or holds a character a header name cannot',
        'use plain header names (letters, digits and `-`)',
      )
    }
    const lowered = headerName.toLowerCase()
    if (KEY_PROXY_MCP_FORBIDDEN_HEADERS.has(lowered)) {
      return brokerRefusal(
        'header-forbidden',
        name,
        `sets the header "${lowered}", which the key proxy sets or refuses itself`,
        'remove it; the broker manages connection and framing headers',
      )
    }
    if (seen.has(lowered)) {
      return brokerRefusal(
        'header-duplicate',
        name,
        `sets the header "${lowered}" twice, under names that differ only in case`,
        'keep one of them',
      )
    }
    seen.add(lowered)
    if (typeof headerValue !== 'string' || !HEADER_VALUE_CHARS.test(headerValue)) {
      return brokerRefusal(
        'header-value-invalid',
        name,
        `sets the header "${lowered}" to a value that is not a string of printable characters`,
        'use a single-line string value',
      )
    }
    if (headerValue.length > MAX_BROKERED_HEADER_VALUE_LENGTH) {
      return brokerRefusal(
        'header-value-too-long',
        name,
        `sets the header "${lowered}" to a value longer than ${MAX_BROKERED_HEADER_VALUE_LENGTH} characters`,
        'shorten it',
      )
    }
    bytes += headerName.length + headerValue.length
    checked[headerName] = headerValue
  }
  return ok({headers: checked, bytes})
}

/**
 * Classify the operator's `mcp` (after per-trigger filtering) for a run whose agent reads its whole config. Every entry
 * that has a `headers` key must end as one of three things, or the run fails before anything starts:
 *
 * - a route, for an active remote server (`routes`): the child holds its headers, the entry is rewritten;
 * - a stripped entry, for one that is definitively disabled (`stripped`): its headers are dropped, nothing serves it;
 * - a refusal, for everything the broker cannot protect.
 *
 * Reads the original entries, not the parsed servers, because the parse skips `enabled`-only stubs and passes an
 * unresolved `type` through, and either can carry `headers` into the sandbox. An entry with no `headers` key is not the
 * broker's business and is never refused.
 */
export function planMcpBrokerV2(mcp: unknown): Result<McpBrokerPlanV2, McpBrokerRefusal> {
  if (mcp === undefined) return ok({routes: [], stripped: [], secrets: []})
  const layout = readMcpLayout(mcp, {keepStubs: true})
  if (!layout.success) {
    return blockRefusal(
      'unreadable-layout',
      'opencode-config `mcp` is not laid out as a map of servers',
      'make `mcp` an object of servers',
    )
  }

  const withHeaders = layout.data.entries.filter(({value}) => isRecord(value) && Object.keys(value).includes('headers'))
  if (withHeaders.length > MAX_BROKERED_SERVERS) {
    return blockRefusal(
      'too-many-servers',
      `opencode-config sets headers on more than ${MAX_BROKERED_SERVERS} MCP servers`,
      'drop the servers the run does not use',
    )
  }

  const routes: McpBrokerRouteV2[] = []
  const stripped: McpBrokerEntryRef[] = []
  const secrets = new Map<string, McpBrokerSecretV2>()
  let headerBytes = 0

  for (const {name, value, origin: layoutOrigin} of withHeaders) {
    if (!isRecord(value)) continue
    const ref: McpBrokerEntryRef = {name, layout: layoutOrigin}

    if (hasReferenceOpening(name)) {
      return brokerRefusal(
        'reference-key',
        name,
        'is declared under a name that holds an `{env:}` or `{file:}` reference, which could resolve to another server',
        'write the server name out literally',
      )
    }
    if (isEnabledOnly(value)) {
      return brokerRefusal(
        'enabled-stub',
        name,
        'is an `enabled`-only entry that also sets `headers`, which the broker cannot attribute to a server',
        'remove `headers` from it, or give the entry a `type` and a `url`',
      )
    }
    if (isReference(value.type)) {
      return brokerRefusal(
        'unresolved-type',
        name,
        'builds its `type` from an `{env:}` or `{file:}` reference, so the broker cannot tell whether it can protect its headers',
        'write `type` out literally',
      )
    }
    const state = disabledStateOf(value)
    if (state === 'unresolved') {
      return brokerRefusal(
        'unresolved-flag',
        name,
        'sets `enabled` or `disabled` to something other than a literal `true` or `false`',
        'write the flag out as `true` or `false`',
      )
    }
    if (state === 'conflict') {
      return brokerRefusal(
        'conflicting-flags',
        name,
        'sets `enabled` and `disabled` to contradictory values',
        'keep one of them',
      )
    }
    if (containsReference(value)) {
      return brokerRefusal(
        'reference',
        name,
        'holds an `{env:}` or `{file:}` reference, which the OpenCode server would resolve inside the sandbox, past the broker',
        'write every value of the server out literally',
      )
    }
    if (state === 'disabled') {
      stripped.push(ref)
      continue
    }
    if (value.type === 'local') {
      return brokerRefusal(
        'local-with-headers',
        name,
        'is a local server that sets `headers`, which the broker cannot protect',
        'remove `headers` from the local server',
      )
    }
    if (value.type !== 'remote') {
      return brokerRefusal(
        'unsupported-type',
        name,
        'sets `headers` on a server whose `type` is not `remote`',
        'set `type` to `remote`, or remove `headers`',
      )
    }
    if (value.oauth !== undefined && value.oauth !== false) {
      return brokerRefusal(
        'oauth',
        name,
        'sets `oauth` on a server with `headers`: the broker holds fixed headers and cannot run an OAuth login',
        'remove `oauth` (or set it to `false`), or remove `headers`',
      )
    }
    const upstream = upstreamOf(value.url)
    if ('kind' in upstream) return brokerRefusal(upstream.kind, name, upstream.problem, upstream.fix)

    const headers = checkBrokeredHeaders(name, value.headers)
    if (!headers.success) return headers
    headerBytes += headers.data.bytes
    if (headerBytes > MAX_BROKERED_HEADER_BYTES) {
      return blockRefusal(
        'headers-too-large',
        'the MCP headers in opencode-config are larger than the key proxy carries',
        'drop headers the servers do not need',
      )
    }

    const server = mcpToolNamespace(name).slice(0, MAX_LOGGED_NAME_LENGTH)
    for (const header of Object.values(headers.data.headers)) {
      for (const secret of secretsOfHeaderValue(header)) {
        if (!secrets.has(secret)) secrets.set(secret, {server, value: secret})
      }
    }
    routes.push({
      ...ref,
      route: {id: `s${routes.length + 1}`, origin: upstream.origin, path: upstream.path, headers: headers.data.headers},
    })
  }

  return ok({routes, stripped, secrets: [...secrets.values()]})
}
/** What to do to one entry of the operator's `mcp` once the child is up: point it at its route, or drop its headers. */
export type BrokeredMcpServerV2 = McpBrokerEntryRef &
  ({readonly action: 'route'; readonly url: string} | {readonly action: 'strip'})

/**
 * The rewrite of the config a brokered run delivers. Present (even with no servers) means the run is brokered, and the
 * delivered config is then checked to hold no `headers` that the broker did not account for.
 */
export interface BrokeredMcpV2 {
  readonly servers: readonly BrokeredMcpServerV2[]
}

function rewriteBrokeredEntry(entry: unknown, target: BrokeredMcpServerV2): Record<string, unknown> | null {
  if (!isRecord(entry) || !Object.keys(entry).includes('headers')) return null
  const rest = {...entry}
  delete rest.headers
  return target.action === 'route' ? {...rest, url: target.url, oauth: false} : rest
}

/**
 * Apply the rewrite to the operator config: each brokered entry gets the loopback `url`, `oauth: false` and no `headers`;
 * each stripped entry loses its `headers`. Every other entry and key is kept as written. Fails, naming the server and
 * never a value, when a target is not in the config or has no `headers` to drop, or when any `headers` is left behind.
 */
export function applyBrokeredMcpV2(
  operator: Record<string, unknown>,
  brokered: BrokeredMcpV2,
): Result<Record<string, unknown>, string> {
  const mismatch = (name: string): Result<never, string> =>
    err(
      `MCP server "${mcpToolNamespace(name).slice(0, MAX_LOGGED_NAME_LENGTH)}" was planned for the broker but is not in the config as planned`,
    )
  const find = (layoutOrigin: McpBrokerLayout, name: string): BrokeredMcpServerV2 | undefined =>
    brokered.servers.find(server => server.layout === layoutOrigin && server.name === name)

  const used = new Set<BrokeredMcpServerV2>()
  const rewriteOne = (layoutOrigin: McpBrokerLayout, name: string, entry: unknown): unknown => {
    const target = find(layoutOrigin, name)
    if (target === undefined) return entry
    const rewritten = rewriteBrokeredEntry(entry, target)
    if (rewritten === null) return entry
    used.add(target)
    return rewritten
  }

  const rewriteKey = (key: string, value: unknown): [string, unknown] => {
    const role = mcpKeyRole(key, value)
    if (role === 'native-servers' && isRecord(value)) {
      return [
        key,
        Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, rewriteOne('native', name, entry)])),
      ]
    }
    if (role === 'server' || role === 'stub') return [key, rewriteOne('legacy', key, value)]
    return [key, value]
  }

  const result = isRecord(operator.mcp)
    ? {...operator, mcp: Object.fromEntries(Object.entries(operator.mcp).map(([key, value]) => rewriteKey(key, value)))}
    : operator

  const missing = brokered.servers.find(server => !used.has(server))
  if (missing !== undefined) return mismatch(missing.name)

  // Nothing may keep a `headers` the broker did not account for: classify what is delivered, and expect nothing to do.
  const left = result.mcp === undefined ? ok({routes: [], stripped: [], secrets: []}) : planMcpBrokerV2(result.mcp)
  if (!left.success) return err(left.error.message)
  if (left.data.routes.length > 0 || left.data.stripped.length > 0) {
    const first = left.data.routes[0] ?? left.data.stripped[0]
    return err(
      `MCP server "${mcpToolNamespace(first?.name ?? '').slice(0, MAX_LOGGED_NAME_LENGTH)}" still sets headers after the broker rewrite`,
    )
  }
  return ok(result)
}
