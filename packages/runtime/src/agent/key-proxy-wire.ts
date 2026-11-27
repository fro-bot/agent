import type {Result} from '../shared/types.js'
import type {KeyProxyRoute} from './key-proxy-routes.js'
import type {KeyProxyProviderConfig} from './key-proxy.js'
import {Buffer} from 'node:buffer'
import {err, ok} from '../shared/types.js'

/**
 * What the Action and the key-proxy child say to each other.
 *
 * Action to child, on stdin: one frame (a 4-byte big-endian length, then that many bytes of UTF-8 JSON) holding the
 * provider keys and the upstream map. The pipe then stays open; closing it is the shutdown signal.
 *
 * Child to Action, on stdout: one JSON line, either `{"ready":true,"port":N}` or `{"error":"<code>"}` with a fixed code.
 * An error line never quotes input.
 */

export const KEY_PROXY_CONFIG_VERSION = 1
export const KEY_PROXY_MAX_CONFIG_BYTES = 1024 * 1024
const MAX_PROVIDERS = 64
const MAX_ROUTES_PER_PROVIDER = 64
const MAX_QUERIES_PER_ROUTE = 8

/** Brokered MCP servers per child, and the bounds on one route: the Action refuses anything over these before it starts. */
export const KEY_PROXY_MAX_MCP_ROUTES = 64
const MAX_MCP_HEADERS_PER_ROUTE = 32
const MAX_MCP_HEADER_VALUE_LENGTH = 4096
const MAX_MCP_PATH_LENGTH = 2048

/** One path segment, so `/mcp/<id>` is exactly three segments. */
const MCP_ROUTE_ID = /^[A-Z0-9][\w-]{0,63}$/i

/** An absolute path of printable ASCII with no query and no fragment: it is sent upstream byte for byte. */
const MCP_UPSTREAM_PATH = /^\/[\x21\x22\x24-\x3E\x40-\x7E]*$/

/** RFC 9110 `token`. */
const MCP_HEADER_NAME = /^[!#$%&'*+\-.^\w`|~]+$/

/** Visible characters, tab and space, and the Latin-1 range Node accepts in a header value. No line break, no control. */
const MCP_HEADER_VALUE = /^[\t\x20-\x7E\x80-\xFF]*$/

/** Exit codes of the child. Zero is a clean stop after stdin closed. */
export const KEY_PROXY_EXIT_INVALID_CONFIG = 64
export const KEY_PROXY_EXIT_START_FAILED = 65
export const KEY_PROXY_EXIT_INTERNAL = 70

export type KeyProxyChildErrorCode = 'internal' | 'invalid-config' | 'start-failed'

/** The first path segment of every MCP route: the child serves one brokered server at `/mcp/<route id>`. */
export const KEY_PROXY_MCP_PATH_PREFIX = 'mcp'

/**
 * Request headers the forwarder sets or refuses itself, so an operator-configured header may not name one (compared
 * case-insensitively): the hop-by-hop set, plus the headers it fixes (`host`, `accept-encoding`, `content-length`) and
 * the one it refuses (`expect`).
 */
export const KEY_PROXY_MCP_FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Header values shorter than this are held by the child but neither redacted from error bodies nor scanned for. */
export const KEY_PROXY_MCP_SECRET_FLOOR = 8

/** `Authorization: Bearer <token>`: the token on its own is as good as the whole value, so it is a secret too. */
const SCHEME_TOKEN = /^(?:bearer|basic|token)\s+(\S(?:.*\S)?)\s*$/i

/**
 * The strings of one header value that must not reach the agent: the whole value, and the token after a Bearer, Basic or
 * Token scheme, each only at {@link KEY_PROXY_MCP_SECRET_FLOOR} characters or more. The Action masks and scans the same
 * strings (`planMcpBrokerV2`), and the child redacts them from an error body.
 */
export function mcpHeaderSecrets(value: string): string[] {
  const found: string[] = []
  if (value.length >= KEY_PROXY_MCP_SECRET_FLOOR) found.push(value)
  const token = SCHEME_TOKEN.exec(value)?.[1]
  if (token !== undefined && token.length >= KEY_PROXY_MCP_SECRET_FLOOR) found.push(token)
  return found
}

/**
 * One brokered remote MCP server: the child forwards `/mcp/<id>` to `origin` + `path` and adds `headers` to every request
 * it sends. The Action plans these from `opencode-config` (`planMcpBrokerV2`); the credential values in `headers` reach
 * the child on stdin only.
 */
export interface KeyProxyMcpRouteConfig {
  /** Opaque route id, one path segment. It never collides with a provider id: it lives under `/mcp/`. */
  readonly id: string
  /** `https://host[:port]`, no path. */
  readonly origin: string
  /** The absolute upstream path, exactly as configured (a trailing slash is kept). No query, no fragment. */
  readonly path: string
  /** The configured request headers, names as authored and unique case-insensitively. Set last on every request. */
  readonly headers: Readonly<Record<string, string>>
}

export interface KeyProxyWireConfig {
  readonly version: 1
  readonly providers: readonly KeyProxyProviderConfig[]
  /** Brokered MCP servers, served at `/mcp/<id>`. Absent when there are none. */
  readonly mcp?: readonly KeyProxyMcpRouteConfig[]
  /** Extra TLS trust for the upstream (PEM). Set only by the supervisor's test options. */
  readonly ca?: string
}

export type KeyProxyChildLine =
  | {readonly kind: 'error'; readonly code: KeyProxyChildErrorCode}
  | {readonly kind: 'invalid'}
  | {readonly kind: 'ready'; readonly port: number}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnly(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).every(name => names.includes(name))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function parseRoute(value: unknown): KeyProxyRoute | null {
  if (!isRecord(value) || !hasOnly(value, ['method', 'path', 'queries', 'auth', 'upstreamPath', 'kind'])) return null
  const {method, path, queries, auth, upstreamPath, kind} = value
  if (method !== 'GET' && method !== 'POST') return null
  if (!nonEmptyString(path) || !path.startsWith('/')) return null
  if (!nonEmptyString(upstreamPath) || !upstreamPath.startsWith('/')) return null
  if (auth !== 'bearer' && auth !== 'x-api-key') return null
  if (kind !== 'inference' && kind !== 'models') return null
  if (!Array.isArray(queries) || queries.length > MAX_QUERIES_PER_ROUTE) return null
  if (!queries.every((query): query is string => typeof query === 'string')) return null
  return {method, path, queries, auth, upstreamPath, kind}
}

function parseProvider(value: unknown): KeyProxyProviderConfig | null {
  if (!isRecord(value) || !hasOnly(value, ['id', 'key', 'origin', 'routes'])) return null
  const {id, key, origin, routes} = value
  if (!nonEmptyString(id) || !nonEmptyString(key) || !nonEmptyString(origin)) return null
  if (!Array.isArray(routes) || routes.length > MAX_ROUTES_PER_PROVIDER) return null
  const parsed = routes.map(parseRoute)
  if (parsed.includes(null)) return null
  return {id, key, origin, routes: parsed as KeyProxyRoute[]}
}

function parseMcpHeaders(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_MCP_HEADERS_PER_ROUTE) return null
  const seen = new Set<string>()
  const headers: Record<string, string> = {}
  for (const [name, headerValue] of entries) {
    const lowered = name.toLowerCase()
    if (!MCP_HEADER_NAME.test(name) || KEY_PROXY_MCP_FORBIDDEN_HEADERS.has(lowered) || lowered === '__proto__')
      return null
    if (seen.has(lowered)) return null
    seen.add(lowered)
    if (typeof headerValue !== 'string' || headerValue.length > MAX_MCP_HEADER_VALUE_LENGTH) return null
    if (!MCP_HEADER_VALUE.test(headerValue)) return null
    headers[name] = headerValue
  }
  return headers
}

/**
 * One MCP route, or null when it is malformed. The origin is not judged here: `startKeyProxy` refuses a bad one at start,
 * as it does for a provider. Returns a copy holding only the known fields.
 */
export function parseMcpRoute(value: unknown): KeyProxyMcpRouteConfig | null {
  if (!isRecord(value) || !hasOnly(value, ['id', 'origin', 'path', 'headers'])) return null
  const {id, origin, path, headers} = value
  if (typeof id !== 'string' || !MCP_ROUTE_ID.test(id)) return null
  if (!nonEmptyString(origin)) return null
  if (typeof path !== 'string' || path.length > MAX_MCP_PATH_LENGTH || !MCP_UPSTREAM_PATH.test(path)) return null
  const parsedHeaders = parseMcpHeaders(headers)
  if (parsedHeaders === null) return null
  return {id, origin, path, headers: parsedHeaders}
}

function parseMcpRoutes(value: unknown): readonly KeyProxyMcpRouteConfig[] | null {
  if (!Array.isArray(value) || value.length > KEY_PROXY_MAX_MCP_ROUTES) return null
  const routes = value.map(parseMcpRoute)
  return routes.includes(null) ? null : (routes as KeyProxyMcpRouteConfig[])
}

/**
 * Validates the decoded JSON. The error is a fixed code: nothing of the input is ever quoted.
 *
 * The field list below is the child's whole vocabulary: a field it does not know is refused, never skipped, because
 * starting without something the Action sent would run the agent against servers whose credentials the child was meant to
 * hold.
 */
export function parseKeyProxyConfig(value: unknown): Result<KeyProxyWireConfig, 'invalid-config'> {
  if (!isRecord(value) || !hasOnly(value, ['version', 'providers', 'mcp', 'ca'])) return err('invalid-config')
  if (value.version !== KEY_PROXY_CONFIG_VERSION) return err('invalid-config')
  if (!Array.isArray(value.providers) || value.providers.length > MAX_PROVIDERS) return err('invalid-config')
  const providers = value.providers.map(parseProvider)
  if (providers.includes(null)) return err('invalid-config')
  if (value.ca !== undefined && !nonEmptyString(value.ca)) return err('invalid-config')
  const mcp = value.mcp === undefined ? undefined : parseMcpRoutes(value.mcp)
  if (mcp === null) return err('invalid-config')
  return ok({
    version: KEY_PROXY_CONFIG_VERSION,
    providers: providers as KeyProxyProviderConfig[],
    ...(mcp === undefined ? {} : {mcp}),
    ...(value.ca === undefined ? {} : {ca: value.ca}),
  })
}

export function encodeKeyProxyConfig(config: KeyProxyWireConfig): Buffer {
  const payload = Buffer.from(JSON.stringify(config), 'utf8')
  if (payload.length > KEY_PROXY_MAX_CONFIG_BYTES) throw new Error('the key proxy config is too large')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length)
  return Buffer.concat([header, payload])
}

/** The payload length announced by a frame header, or null when the header is short, empty or over the bound. */
export function readKeyProxyFrameLength(header: Buffer): number | null {
  if (header.length < 4) return null
  const length = header.readUInt32BE(0)
  return length > 0 && length <= KEY_PROXY_MAX_CONFIG_BYTES ? length : null
}

export function parseKeyProxyChildLine(line: string): KeyProxyChildLine {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return {kind: 'invalid'}
  }
  if (!isRecord(parsed)) return {kind: 'invalid'}
  if (parsed.ready === true && typeof parsed.port === 'number') {
    const {port} = parsed
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? {kind: 'ready', port} : {kind: 'invalid'}
  }
  const {error} = parsed
  if (error === 'internal' || error === 'invalid-config' || error === 'start-failed')
    return {kind: 'error', code: error}
  return {kind: 'invalid'}
}
