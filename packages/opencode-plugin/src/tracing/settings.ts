/**
 * Host mode and tracing settings: one function decides whether tracing is on and where spans go, and fails closed.
 *
 * This module sits OUTSIDE the lazy tracing chunk: it decides whether the chunk loads at all, so it must stay small and
 * import nothing from the OpenTelemetry SDK. Resolving to off never evaluates the chunk.
 *
 * Where settings come from, and nowhere else:
 * - The launcher variable `OPENCODE_FROBOT_TRACING`, set by whatever started the server (the Action, the workspace).
 * - Otherwise, only in a local session, a user-scope file under the user's config directory.
 * Plugin options, project config, the checkout, restored state and session content are never read.
 *
 * The user file names the machines it is for (`hosts`, required): a file synced to another machine, or left behind on a
 * shared one, does nothing there. And a remote collector in it must be `https`, with the platform's certificate
 * verification left on: the exporter sends the file's headers (a credential) to that URL, and the file has no switch to
 * relax verification, to follow a redirect, or to use plain `http` anywhere but a loopback literal.
 */

import {Buffer} from 'node:buffer'
import {closeSync, constants, fstatSync, openSync, readSync, realpathSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * Name of the launcher variable. `OPENCODE_`-prefixed so the Action's environment filter admits it, and not ending in a
 * denied suffix (`_TOKEN`, `_KEY`, `_SECRET`, `_PASSWORD`, …). It carries no credential: only host, on/off, a loopback
 * relay address and run identity.
 */
export const TRACING_LAUNCHER_ENV = 'OPENCODE_FROBOT_TRACING'

/** Version of both the launcher document and the user file. Anything else resolves to off. */
export const TRACING_SETTINGS_VERSION = 1

/** Variables a headless server (the Action, the workspace, any `opencode serve`) always has and a local session lacks. */
export const HEADLESS_MARKERS = ['OPENCODE_PASSWORD', 'OPENCODE_CONFIG_CONTENT'] as const

/** The user file, relative to the user's config directory. Not under `opencode/`: OpenCode reads nothing from here. */
export const USER_SETTINGS_RELATIVE_PATH = path.join('fro-bot', 'opencode-plugin', 'tracing.json')

/** Ceilings. A document or file over its ceiling is malformed, not truncated. */
export const MAX_LAUNCHER_CHARS = 4096
export const MAX_SETTINGS_FILE_BYTES = 16 * 1024
export const MAX_ENDPOINT_CHARS = 2048
export const MAX_HEADERS = 16
export const MAX_HEADER_VALUE_CHARS = 4096
export const MAX_HOSTS = 16
/** The longest name DNS allows. */
export const MAX_HOSTNAME_CHARS = 253
export const MAX_IDENTITY_FIELD_CHARS = 200

/** Run identity the Action supplies. Every span of an Action run carries it. */
export interface ActionIdentity {
  readonly repository: string
  readonly runId: string
  readonly attempt: string
  readonly job: string
  readonly trigger: string
}

/** The Action run's root span, which each turn's root span links to. Both ids are lower-case hex, not all zero. */
export interface RootSpanContext {
  readonly traceId: string
  readonly spanId: string
}

/**
 * What ties a turn trace to the Action run that started it. All three come from the launcher, each is optional, and none is
 * derived or altered here: `sessionId` (the Action's `<owner>/<repo>:<logical key>`) is used verbatim.
 */
export interface ActionRunContext {
  readonly rootSpan?: RootSpanContext | undefined
  readonly sessionId?: string | undefined
  readonly invocationId?: string | undefined
  /**
   * The GitHub server the run is on (`GITHUB_SERVER_URL`): an `https` origin with no path, query, fragment or credentials. The
   * run's URL is built from it. A launcher written before the field existed does not carry it, and reads as it always has.
   */
  readonly serverUrl?: string | undefined
}

/**
 * Why tracing is off. Fixed strings: they are the only thing a log line says about a refused setting. The first group is
 * a deliberate off and stays silent; the rest are logged once.
 */
export type OffReason =
  | 'action-off'
  | 'workspace-host'
  | 'unsupported-platform'
  | 'no-settings-file'
  | 'machine-not-listed'
  | 'launcher-malformed'
  | 'launcher-unsupported'
  | 'launcher-relay-invalid'
  | 'launcher-identity-invalid'
  | 'launcher-run-invalid'
  | 'headless-host'
  | 'settings-file-unreadable'
  | 'settings-file-unsafe'
  | 'settings-file-invalid'
  | 'settings-error'

const SILENT_REASONS: ReadonlySet<OffReason> = new Set([
  'action-off',
  'workspace-host',
  'unsupported-platform',
  'no-settings-file',
  'machine-not-listed',
])

export type TracingSettings =
  | {readonly mode: 'off'; readonly reason: OffReason}
  | ({
      readonly mode: 'on'
      readonly host: 'action'
      /** The relay's loopback traces URL. The collector credential never reaches the plugin. */
      readonly endpoint: string
      readonly identity: ActionIdentity
    } & ActionRunContext)
  | {
      readonly mode: 'on'
      readonly host: 'local'
      readonly endpoint: string
      readonly headers: Readonly<Record<string, string>>
    }

export interface ResolveTracingSettingsInput {
  readonly env: Readonly<Record<string, string | undefined>>
  /** The session's project directory: a settings file that resolves inside it is refused. */
  readonly directory: string
  readonly log: (line: string) => void
  /** Defaults to the running platform. */
  readonly platform?: NodeJS.Platform
  /** The current user's id. Defaults to `process.getuid()`. */
  readonly uid?: number | undefined
  /** The machine's name. Defaults to `os.hostname()`. Read only for a local session with a valid user file. */
  readonly hostname?: (() => string) | undefined
}

const off = (reason: OffReason): TracingSettings => ({mode: 'off', reason})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when `value` has exactly the listed keys, no more and no fewer. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return hasKeys(value, keys, [])
}

/** True when `value` has every required key and no key outside `required` and `optional`. */
function hasKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  return (
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key))
  )
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** `127.0.0.0/8` literals or `[::1]`. A hostname such as `localhost` is not accepted: it resolves through the host. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === '[::1]') return true
  const octets = hostname.split('.')
  return (
    octets.length === 4 && octets[0] === '127' && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  )
}

function parseUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ENDPOINT_CHARS) return undefined
  if (hasControlCharacter(value)) return undefined
  try {
    const url = new URL(value)
    // Credentials in a URL would be logged by anything that prints it.
    if (url.username !== '' || url.password !== '' || url.hash !== '') return undefined
    return url
  } catch {
    return undefined
  }
}

/** The launcher's relay: plain HTTP to a loopback literal with an explicit port. */
function parseRelayUrl(value: unknown): string | undefined {
  const url = parseUrl(value)
  if (url === undefined || url.protocol !== 'http:' || !isLoopbackHostname(url.hostname) || url.port === '') {
    return undefined
  }
  if (url.search !== '') return undefined
  return url.href
}

/** A user-file endpoint: HTTPS, or plain HTTP to a loopback literal. */
function parseCollectorUrl(value: unknown): URL | undefined {
  const url = parseUrl(value)
  if (url === undefined) return undefined
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url
  return undefined
}

function parseIdentity(value: unknown): ActionIdentity | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['repository', 'runId', 'attempt', 'job', 'trigger'])) return undefined
  const fields: string[] = []
  for (const key of ['repository', 'runId', 'attempt', 'job', 'trigger']) {
    const field = value[key]
    if (typeof field !== 'string' || field.length === 0 || field.length > MAX_IDENTITY_FIELD_CHARS) return undefined
    if (hasControlCharacter(field)) return undefined
    fields.push(field)
  }
  const [repository = '', runId = '', attempt = '', job = '', trigger = ''] = fields
  return {repository, runId, attempt, job, trigger}
}

const TRACE_ID = /^[\da-f]{32}$/
const SPAN_ID = /^[\da-f]{16}$/
const NON_ZERO = /[1-9a-f]/

/** 32 and 16 lower-case hex characters, neither all zero: what W3C trace context accepts as ids. */
function parseRootSpan(value: unknown): RootSpanContext | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['traceId', 'spanId'])) return undefined
  const {traceId, spanId} = value
  if (typeof traceId !== 'string' || typeof spanId !== 'string') return undefined
  if (!TRACE_ID.test(traceId) || !SPAN_ID.test(spanId) || !NON_ZERO.test(traceId) || !NON_ZERO.test(spanId)) {
    return undefined
  }
  return {traceId, spanId}
}

/** A non-empty string, at most as long as an identity field, free of control characters. */
function parseTextField(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTITY_FIELD_CHARS) return undefined
  return hasControlCharacter(value) ? undefined : value
}

/**
 * A GitHub server origin: exactly `https://<host>[:<port>]`, optionally with one trailing slash, no more. The text must be
 * what the URL parser would write back, so nothing is rewritten or discarded on the way (a path, a query, a fragment,
 * credentials, an upper-case host, a default port, a non-ASCII host all fail). Bounded like an identity field.
 */
function parseServerUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTITY_FIELD_CHARS) return undefined
  if (hasControlCharacter(value)) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined
  if (value !== url.origin && value !== `${url.origin}/`) return undefined
  return url.origin
}

/** The launcher's optional run link fields. A field that is present and not acceptable refuses them all: `undefined`. */
function parseRunContext(document: Record<string, unknown>): ActionRunContext | undefined {
  const context: {rootSpan?: RootSpanContext; sessionId?: string; invocationId?: string; serverUrl?: string} = {}
  if (Object.hasOwn(document, 'rootSpan')) {
    const rootSpan = parseRootSpan(document.rootSpan)
    if (rootSpan === undefined) return undefined
    context.rootSpan = rootSpan
  }
  if (Object.hasOwn(document, 'sessionId')) {
    const sessionId = parseTextField(document.sessionId)
    if (sessionId === undefined) return undefined
    context.sessionId = sessionId
  }
  if (Object.hasOwn(document, 'invocationId')) {
    const invocationId = parseTextField(document.invocationId)
    if (invocationId === undefined) return undefined
    context.invocationId = invocationId
  }
  if (Object.hasOwn(document, 'serverUrl')) {
    const serverUrl = parseServerUrl(document.serverUrl)
    if (serverUrl === undefined) return undefined
    context.serverUrl = serverUrl
  }
  return context
}

/** Resolves the launcher variable's value. Pure: no environment, no file. */
function resolveLauncher(raw: string): TracingSettings {
  if (raw.length === 0 || raw.length > MAX_LAUNCHER_CHARS) return off('launcher-malformed')
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch {
    return off('launcher-malformed')
  }
  if (!isRecord(document)) return off('launcher-malformed')
  if (document.version !== TRACING_SETTINGS_VERSION) return off('launcher-unsupported')
  if (document.host === 'workspace') return off('workspace-host')
  if (document.host !== 'action') return off('launcher-unsupported')
  if (document.tracing === 'off') return off('action-off')
  if (document.tracing !== 'on') return off('launcher-malformed')
  if (
    !hasKeys(
      document,
      ['version', 'host', 'tracing', 'relay', 'identity'],
      ['rootSpan', 'sessionId', 'invocationId', 'serverUrl'],
    )
  ) {
    return off('launcher-malformed')
  }

  const endpoint = parseRelayUrl(document.relay)
  if (endpoint === undefined) return off('launcher-relay-invalid')
  const identity = parseIdentity(document.identity)
  if (identity === undefined) return off('launcher-identity-invalid')
  const run = parseRunContext(document)
  if (run === undefined) return off('launcher-run-invalid')
  return {mode: 'on', host: 'action', endpoint, identity, ...run}
}

/**
 * Whether the launcher variable names the Action as the host that started this server. Strict and independent of tracing:
 * only a present, size-capped, valid JSON object with `version` 1 and `host` `'action'` answers `'action'`. The tracing
 * mode, relay and identity fields are not read, so an Action run with tracing off, or with a field the tracing decision
 * would refuse, is still the Action. Anything else (no variable, a malformed or oversized one, an unknown version, the
 * workspace or any other host) answers `undefined`. A user file and the headless markers never name the Action: only the
 * Action's own launcher does. Pure and never throws; it logs nothing.
 */
export function readLauncherHost(env: Readonly<Record<string, string | undefined>>): 'action' | undefined {
  const raw = env[TRACING_LAUNCHER_ENV]
  if (raw === undefined || raw.length === 0 || raw.length > MAX_LAUNCHER_CHARS) return undefined
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(document) || document.version !== TRACING_SETTINGS_VERSION) return undefined
  return document.host === 'action' ? 'action' : undefined
}

/** Header names the exporter or the transport owns. A user file cannot set them. */
const REFUSED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'proxy-authorization',
  'proxy-authenticate',
])
const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/

function parseHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {}
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length > MAX_HEADERS) return undefined
  const headers: Record<string, string> = {}
  for (const [name, headerValue] of entries) {
    const lower = name.toLowerCase()
    if (name.length > 64 || !HEADER_NAME.test(name) || REFUSED_HEADER_NAMES.has(lower)) return undefined
    if (typeof headerValue !== 'string' || headerValue.length === 0 || headerValue.length > MAX_HEADER_VALUE_CHARS) {
      return undefined
    }
    if (hasControlCharacter(headerValue) || Object.hasOwn(headers, lower)) return undefined
    headers[lower] = headerValue
  }
  return headers
}

/** `$XDG_CONFIG_HOME` when it is an absolute path, else `~/.config`. */
export function userSettingsFilePath(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.XDG_CONFIG_HOME
  if (configured !== undefined && path.isAbsolute(configured)) return path.join(configured, USER_SETTINGS_RELATIVE_PATH)
  const home = env.HOME !== undefined && path.isAbsolute(env.HOME) ? env.HOME : os.homedir()
  return path.join(home, '.config', USER_SETTINGS_RELATIVE_PATH)
}

type FileRead =
  | {readonly ok: true; readonly text: string}
  | {readonly ok: false; readonly reason: 'no-settings-file' | 'settings-file-unreadable' | 'settings-file-unsafe'}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  if (relative === '') return true
  // Outside means a way up (`..` alone, or `..` and a separator) or another root. A child NAMED `..config` is inside:
  // `startsWith('..')` alone would let a checkout choose the settings file.
  const goesUp = relative === '..' || relative.startsWith(`..${path.sep}`)
  return !goesUp && !path.isAbsolute(relative)
}

/**
 * Reads the user file, checking the OPENED handle: a regular file, owned by the current user, private to its owner (no group
 * or other permission bit at all: it can hold a collector credential, so readable is as bad as writable), small, and whose
 * real path is outside the project. A symlink is resolved first and its target is what gets opened and checked.
 */
function readSettingsFile(filePath: string, directory: string, uid: number): FileRead {
  let realPath: string
  try {
    realPath = realpathSync(filePath)
  } catch (error) {
    const code = errorCode(error)
    return {
      ok: false,
      reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'no-settings-file' : 'settings-file-unreadable',
    }
  }

  let realDirectory: string
  try {
    realDirectory = realpathSync(directory)
  } catch {
    realDirectory = path.resolve(directory)
  }
  if (isInside(realPath, realDirectory)) return {ok: false, reason: 'settings-file-unsafe'}

  let fd: number
  try {
    // NONBLOCK so a FIFO cannot hang the open; NOFOLLOW because `realPath` has no links left to follow.
    fd = openSync(realPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  } catch {
    return {ok: false, reason: 'settings-file-unreadable'}
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size > MAX_SETTINGS_FILE_BYTES) {
      return {ok: false, reason: 'settings-file-unsafe'}
    }
    const buffer = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (read === 0) break
      offset += read
    }
    return {ok: true, text: buffer.subarray(0, offset).toString('utf8')}
  } catch {
    return {ok: false, reason: 'settings-file-unreadable'}
  } finally {
    closeSync(fd)
  }
}

/** A name as compared: trimmed, lower case, without one trailing dot. */
const normalizeHostname = (value: string): string => {
  const lower = value.trim().toLowerCase()
  return lower.endsWith('.') ? lower.slice(0, -1) : lower
}

/** Letters, digits, dot, hyphen and underscore: what a machine name holds. No wildcard, port, path or space. */
const HOSTNAME_ENTRY = /^[\da-z._-]+$/

/** The `hosts` list: one to 16 names, each normalized. Undefined when the list or any entry is not acceptable. */
function parseHosts(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HOSTS) return undefined
  const hosts: string[] = []
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || entry.length > MAX_HOSTNAME_CHARS + 2) return undefined
    const host = normalizeHostname(entry)
    if (host.length === 0 || host.length > MAX_HOSTNAME_CHARS || !HOSTNAME_ENTRY.test(host)) return undefined
    hosts.push(host)
  }
  return hosts
}

/**
 * Whether `machine` is one of `hosts`. An entry matches the whole name, or the part of the name before its first dot. That
 * part never holds a dot, so an entry with a dot can only ever match the whole name: `build-box.example.test` does not
 * match a machine called `build-box`. No wildcards, no prefix or suffix matching.
 */
function namesMachine(hosts: readonly string[], machine: string): boolean {
  const name = normalizeHostname(machine)
  if (name.length === 0) return false
  const short = name.split('.')[0]
  return hosts.some(host => host === name || host === short)
}

function resolveSettingsFile(
  text: string,
  hostname: () => string,
): {readonly settings: TracingSettings; readonly host?: string} {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return {settings: off('settings-file-invalid')}
  }
  if (!isRecord(document) || document.version !== TRACING_SETTINGS_VERSION) {
    return {settings: off('settings-file-invalid')}
  }
  const allowed = Object.keys(document).every(
    key => key === 'version' || key === 'endpoint' || key === 'headers' || key === 'hosts',
  )
  const url = parseCollectorUrl(document.endpoint)
  const headers = parseHeaders(document.headers)
  const hosts = parseHosts(document.hosts)
  if (!allowed || url === undefined || headers === undefined || hosts === undefined) {
    return {settings: off('settings-file-invalid')}
  }
  // A valid file for another machine is not an error: it is silently not for this one.
  if (!namesMachine(hosts, hostname())) return {settings: off('machine-not-listed')}
  return {settings: {mode: 'on', host: 'local', endpoint: url.href, headers}, host: url.host}
}

/**
 * Decides whether tracing is on. Never throws. Logs at most one line: an off with a reason worth knowing, or, for a local
 * session, the destination host. Lines carry fixed text and a host name, never a header, a path or a settings value.
 */
export function resolveTracingSettings(input: ResolveTracingSettingsInput): TracingSettings {
  const {env, directory, log} = input
  const finish = (settings: TracingSettings): TracingSettings => {
    if (settings.mode === 'off' && !SILENT_REASONS.has(settings.reason)) log(`tracing off (${settings.reason})`)
    return settings
  }

  try {
    const launcher = env[TRACING_LAUNCHER_ENV]
    // The launcher decides alone: a declared off or a workspace host is never overridden by a user file.
    if (launcher !== undefined) return finish(resolveLauncher(launcher))

    // No launcher: something that is not this repo's Action started the server. A headless server stays off. The command
    // line says nothing: `serve --stdio` is also how the interactive app's private backend starts (`--standalone`, `run`,
    // ACP), and every launcher of this repo sets the variable above. Any other stdio server on this machine, an SDK
    // embedder included, falls under the user file unless it passes `OPENCODE_CONFIG_CONTENT`.
    if (HEADLESS_MARKERS.some(marker => env[marker] !== undefined)) {
      return finish(off('headless-host'))
    }

    const platform = input.platform ?? process.platform
    const uid = input.uid ?? process.getuid?.()
    if (platform === 'win32' || uid === undefined) return finish(off('unsupported-platform'))

    const file = readSettingsFile(userSettingsFilePath(env), directory, uid)
    if (!file.ok) return finish(off(file.reason))
    const resolved = resolveSettingsFile(file.text, input.hostname ?? os.hostname)
    if (resolved.settings.mode === 'on' && resolved.host !== undefined) {
      log(`tracing on, destination host ${resolved.host}`)
    }
    return finish(resolved.settings)
  } catch {
    return finish(off('settings-error'))
  }
}
