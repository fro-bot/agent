/**
 * Safe response helpers for the operator web surface.
 *
 * All operator HTTP responses pass through these helpers to ensure:
 *   - Auth failures are coarse and no-oracle (R4, R15).
 *   - Error shapes are consistent and redaction-friendly.
 *   - No internal details, paths, tokens, or session values leak into responses.
 *
 * The shape is intentionally minimal: {ok: true} for success, {error: string}
 * for failures. Richer response bodies are added per-route for future authenticated routes.
 */

import type {Context} from 'hono'
import type {Env, Input} from 'hono/types'

type OperatorResponseContext<E extends Env = Env, P extends string = string, I extends Input = Input> = Context<E, P, I>
// ---------------------------------------------------------------------------
// Success responses
// ---------------------------------------------------------------------------

/**
 * Return a coarse success response.
 * Use for routes that have no meaningful body to return yet.
 */
export function okResponse<E extends Env, P extends string, I extends Input>(
  c: OperatorResponseContext<E, P, I>,
): Response {
  return c.json({ok: true}, 200)
}

// ---------------------------------------------------------------------------
// Error responses — coarse, no-oracle
// ---------------------------------------------------------------------------

/**
 * Return a coarse 400 Bad Request.
 * Use for malformed requests, untrusted forwarded headers, and invalid input.
 * Never include the specific reason in the response body.
 */
export function badRequestResponse<E extends Env, P extends string, I extends Input>(
  c: OperatorResponseContext<E, P, I>,
): Response {
  return c.json({error: 'bad request'}, 400)
}

/**
 * Return a coarse 404 Not Found.
 * Use for unknown routes and resources that do not exist or are not visible
 * to the current operator. Never distinguish between "not found" and "not authorized".
 */
export function notFoundResponse<E extends Env, P extends string, I extends Input>(
  c: OperatorResponseContext<E, P, I>,
): Response {
  return c.json({error: 'not-found'}, 404)
}

/**
 * Return a coarse 413 Payload Too Large.
 * Use when the request body exceeds the configured size limit.
 */
export function payloadTooLargeResponse<E extends Env, P extends string, I extends Input>(
  c: OperatorResponseContext<E, P, I>,
): Response {
  return c.json({error: 'payload too large'}, 413)
}

/**
 * Return a coarse 429 Too Many Requests.
 * Use when a rate limit is exceeded. Includes Retry-After when provided.
 */
export function rateLimitedResponse<E extends Env, P extends string, I extends Input>(
  c: OperatorResponseContext<E, P, I>,
  retryAfterSeconds?: number,
): Response {
  if (retryAfterSeconds !== undefined) {
    c.header('Retry-After', String(retryAfterSeconds))
  }
  return c.json({error: 'rate limited'}, 429)
}

/**
 * Return a coarse 503 Service Unavailable.
 * Use during graceful shutdown drain.
 */
export function unavailableResponse<E extends Env, P extends string, I extends Input>(
  c: OperatorResponseContext<E, P, I>,
): Response {
  return c.json({error: 'unavailable'}, 503)
}
