/**
 * The OpenCode V2 routes the gateway may reach through the workspace's `:9200` bearer proxy (fro-bot/agent#1992).
 *
 * The proxy replaces the gateway bearer with the server's privileged Basic credential, so it forwards ONLY these
 * routes; everything else (credential storage, integration setup, config, debug) is answered 404 without a call to the
 * server. The list is exactly what `createRemoteOpenCodeV2Client` sends, and `gateway-routes-v2.test.ts` runs every
 * method of that client and fails when one produces a request that is not listed here, so a new client route cannot ship
 * without being allowlisted on purpose.
 *
 * It lives in the runtime because both sides may depend on the runtime and neither may depend on the other: the
 * gateway builds the requests (through the client) and the workspace agent's proxy filters them.
 */

export interface V2GatewayRoute {
  readonly method: 'DELETE' | 'GET' | 'POST'
  /** `/api/...`; a `:name` segment matches exactly one canonical identifier segment. */
  readonly path: string
}

export const V2_GATEWAY_ROUTES: readonly V2GatewayRoute[] = [
  {method: 'GET', path: '/api/event'},
  {method: 'GET', path: '/api/session'},
  {method: 'POST', path: '/api/session'},
  {method: 'GET', path: '/api/session/active'},
  {method: 'GET', path: '/api/session/:sessionId'},
  {method: 'POST', path: '/api/session/:sessionId/prompt'},
  {method: 'POST', path: '/api/session/:sessionId/interrupt'},
  {method: 'GET', path: '/api/session/:sessionId/inbox'},
  {method: 'POST', path: '/api/session/:sessionId/permission/:requestId/reply'},
  {method: 'POST', path: '/api/session/:sessionId/form/:formId/reply'},
  {method: 'DELETE', path: '/api/session/:sessionId/form/:formId'},
  {method: 'GET', path: '/api/shell'},
  {method: 'GET', path: '/api/shell/:shellId'},
  {method: 'DELETE', path: '/api/shell/:shellId'},
]

/** One identifier segment: what OpenCode ids are made of. Nothing that could be decoded, split or truncated by a router. */
const PARAM_SEGMENT = /^[\w-]{1,128}$/

const COMPILED = V2_GATEWAY_ROUTES.map(route => ({method: route.method, segments: route.path.split('/').slice(1)}))

/**
 * True when `method` and `pathname` are an allowlisted route. `pathname` must already be the canonical path of an
 * origin-form target (no query, no fragment): this compares the raw segments exactly and never decodes anything, so a
 * segment carrying `%`, `;`, `\`, `.` or any other character outside the identifier alphabet matches no parameter, and a
 * literal segment matches only its exact, lower-case spelling.
 */
export function isGatewayRouteV2(method: string, pathname: string): boolean {
  if (!pathname.startsWith('/')) return false
  const segments = pathname.split('/').slice(1)
  return COMPILED.some(
    route =>
      route.method === method &&
      route.segments.length === segments.length &&
      route.segments.every((expected, index) => {
        const actual = segments[index] as string
        return expected.startsWith(':') ? PARAM_SEGMENT.test(actual) : expected === actual
      }),
  )
}
