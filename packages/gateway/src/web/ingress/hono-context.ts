/**
 * Hono `Context` boundary for the ingress pipeline.
 *
 * These are the only two points where ingress logic touches a Hono `Context`
 * directly: pulling the raw socket/X-Forwarded-For input off a request
 * (`extractRawIngressInput`), and mapping a resolution failure back to a
 * response (`respondForIngressRejection`). Both are generic over Hono's
 * Env/Path/Input type parameters — mirroring the pattern already used by
 * `../safe-response.js` — because Hono's own `app.use(path, handler)`
 * middleware overload types the Input parameter as `any`. A concrete
 * `Context` parameter type here would make every call from that overload an
 * unsafe (implicit-`any`) argument; a generic parameter lets each call site's
 * Context instantiate the generics explicitly instead.
 */

import type {Context} from 'hono'
import type {Env, Input} from 'hono/types'
import type {IngressRejection, RawIngressInput} from './resolve-client.js'
import {getConnInfo} from '@hono/node-server/conninfo'
import {badRequestResponse, unavailableResponse} from '../safe-response.js'

/**
 * Extract raw ingress input (socket address + X-Forwarded-For headers) from a
 * Hono request context for trusted-proxy-aware client resolution.
 *
 * getConnInfo may throw in environments without a real socket (e.g. direct
 * app.fetch() in tests) — treated as socket-unavailable via resolveClient,
 * never as a fallback key.
 */
export function extractRawIngressInput<E extends Env, P extends string, I extends Input>(
  c: Context<E, P, I>,
): RawIngressInput {
  let socketAddress: string | undefined
  try {
    socketAddress = getConnInfo(c).remote.address
  } catch {
    socketAddress = undefined
  }
  const forwardedFor = c.req.header('x-forwarded-for')
  return {
    socketAddress,
    forwardedForHeaders: forwardedFor === undefined ? [] : [forwardedFor],
  }
}

/**
 * Map an ingress resolution failure to a coarse response. Trusted-peer header
 * failures (missing/malformed/untrusted X-Forwarded-For chain) are a client
 * error (400); a socket acquisition failure is a server-side capacity issue
 * (503). Never allocate a rate-limit bucket or OAuth state before this check.
 */
export function respondForIngressRejection<E extends Env, P extends string, I extends Input>(
  c: Context<E, P, I>,
  rejection: IngressRejection,
): Response {
  if (rejection.kind === 'socket-unavailable' || rejection.kind === 'socket-invalid') {
    return unavailableResponse(c)
  }
  return badRequestResponse(c)
}
