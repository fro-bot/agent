import type {IncomingHttpHeaders, OutgoingHttpHeaders} from 'node:http'
import type {Result} from '../shared/types.js'
import type {KeyProxyMcpRouteConfig} from './key-proxy-wire.js'
import {err, ok} from '../shared/types.js'
import {parseUpstreamOrigin} from './key-proxy-routes.js'
import {
  KEY_PROXY_MAX_MCP_ROUTES,
  KEY_PROXY_MCP_FORBIDDEN_HEADERS,
  KEY_PROXY_MCP_PATH_PREFIX,
  parseMcpRoute,
} from './key-proxy-wire.js'

/**
 * What the key proxy forwards for one brokered remote MCP server. A route lives at `/mcp/<id>`, is bound to one upstream
 * origin and one absolute path, and carries the operator's headers. The client config names only the local URL.
 *
 * Unlike a provider route, nothing about the protocol is allowlisted: the agent's shell already holds the route, so a
 * tighter table would protect nothing, and the recorded 2.4.2 client needs POST, GET and DELETE, the `Mcp-*` protocol
 * headers (`Mcp-Param-*` are derived from each server's tool schema) and the raw query. The rules are about credentials
 * and framing instead: no client credential or forwarding header goes upstream, the configured headers are set last,
 * and what comes back is filtered by `key-proxy.ts` (no redirect, no upgrade, error bodies replaced).
 */

/** The methods a route admits. The recorded client sends POST for every message, GET for the stream and DELETE on close. */
const MCP_METHODS: ReadonlySet<string> = new Set(['POST', 'GET', 'DELETE'])

export interface McpRouteState {
  readonly id: string
  readonly hostname: string
  readonly port: number
  readonly host: string
  /** The absolute upstream path, exactly as configured. */
  readonly path: string
  /** The configured request headers, names lower-cased. Set last on every request. */
  readonly headers: Readonly<Record<string, string>>
}

/** Response headers passed to the client on a 2xx. Anything else the upstream sends (cookies, challenges) stays behind. */
export const MCP_SUCCESS_RESPONSE_HEADERS: readonly string[] = [
  'cache-control',
  'content-encoding',
  'content-length',
  'content-type',
  'mcp-session-id',
]

/**
 * The text OpenCode 2.4.2 reads as "the server no longer knows this session" (`failure` in `mcp/client.ts`): a 400 on a
 * request that carried a session id, whose body contains it. The client then drops the connection, initializes again and
 * retries the call (recorded in the Unit 2 spike).
 */
export const MCP_SESSION_EXPIRED_TEXT = 'Bad Request: Server not initialized'

/** What the upstream says when it has lost a session. Matched in the upstream body; the client gets the fixed text above. */
export const MCP_SERVER_NOT_INITIALIZED = 'Server not initialized'

/** The fixed body the client gets for an expired session, in the JSON-RPC error shape a server would send. */
export const MCP_SESSION_EXPIRED_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: null,
  error: {code: -32_000, message: MCP_SESSION_EXPIRED_TEXT},
})

/**
 * Request headers that never go upstream. The forwarder owns framing and the hop-by-hop set; the rest are client
 * credentials, cookies and forwarding metadata, which would name the loopback caller or carry a credential the client
 * was never meant to supply.
 */
const NEVER_FORWARDED: ReadonlySet<string> = new Set([
  ...KEY_PROXY_MCP_FORBIDDEN_HEADERS,
  'authorization',
  'cookie',
  'cookie2',
  'forwarded',
  'set-cookie',
  'via',
  'x-real-ip',
])

/** `X-Forwarded-For`, `-Host`, `-Proto`, `-Port` and the rest of the family. */
const FORWARDING_PREFIX = 'x-forwarded-'

/** `Retry-After` as a delay in seconds. An HTTP date, or anything else, is dropped: it is the one header read off an error. */
const RETRY_AFTER_SECONDS = /^\d{1,9}$/

function headerText(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value
}

function nominated(headers: IncomingHttpHeaders): ReadonlySet<string> {
  const connection = headerText(headers.connection)
  if (connection === undefined) return new Set()
  return new Set(
    connection
      .split(',')
      .map(token => token.trim().toLowerCase())
      .filter(token => token.length > 0),
  )
}

/**
 * The route table, keyed by id. Every field is checked again here, with fixed messages that never quote the input, even
 * though the child's frame parser already did: the table is also built by direct callers.
 */
export function buildMcpRoutes(routes: readonly KeyProxyMcpRouteConfig[]): Result<Map<string, McpRouteState>, string> {
  if (routes.length > KEY_PROXY_MAX_MCP_ROUTES) return err('there are too many MCP routes')
  const states = new Map<string, McpRouteState>()
  for (const route of routes) {
    const checked = parseMcpRoute(route)
    if (checked === null) return err('an MCP route is malformed')
    if (states.has(checked.id)) return err('an MCP route id is repeated')
    const origin = parseUpstreamOrigin(checked.origin)
    if (origin === null) return err('an MCP route has an upstream that is not a plain https origin')
    states.set(checked.id, {
      id: checked.id,
      ...origin,
      path: checked.path,
      headers: Object.fromEntries(Object.entries(checked.headers).map(([name, value]) => [name.toLowerCase(), value])),
    })
  }
  return ok(states)
}

/** The route for a local `/mcp/<id>` path and a method POST, GET or DELETE, or undefined. No decoding, no prefix match. */
export function matchMcpRoute(
  routes: ReadonlyMap<string, McpRouteState>,
  method: string,
  path: string,
): McpRouteState | undefined {
  if (!MCP_METHODS.has(method)) return undefined
  // `/mcp/<id>`: three segments exactly. The id is looked up in a Map, so `constructor` and `__proto__` are plain misses.
  const segments = path.split('/')
  if (segments.length !== 3 || segments[0] !== '' || segments[1] !== KEY_PROXY_MCP_PATH_PREFIX) return undefined
  const id = segments[2]
  return id === undefined ? undefined : routes.get(id)
}

/**
 * The headers sent upstream: the client's, minus credentials, cookies, hop-by-hop and forwarding headers and anything the
 * client named in `Connection`; `Host` and framing from the route; then the configured headers last, so no client header
 * of any case can override one.
 */
export function buildMcpRequestHeaders(
  client: IncomingHttpHeaders,
  route: McpRouteState,
  hasBody: boolean,
): OutgoingHttpHeaders {
  const skipped = nominated(client)
  const headers: OutgoingHttpHeaders = {}
  for (const [name, raw] of Object.entries(client)) {
    const value = headerText(raw)
    if (value === undefined) continue
    if (NEVER_FORWARDED.has(name) || name.startsWith(FORWARDING_PREFIX) || skipped.has(name)) continue
    headers[name] = value
  }
  if (hasBody && client['content-length'] !== undefined) headers['content-length'] = client['content-length']
  headers.host = route.host
  headers['accept-encoding'] = 'identity'
  for (const [name, value] of Object.entries(route.headers)) headers[name] = value
  return headers
}

/** The `Retry-After` delay in seconds, or undefined when the value is anything else. */
export function sanitizeRetryAfter(value: string | undefined): string | undefined {
  return value !== undefined && RETRY_AFTER_SECONDS.test(value) ? value : undefined
}
