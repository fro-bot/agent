/**
 * Named response types for the operator HTTP API surface.
 *
 * These are the canonical transport-stable shapes for operator endpoints.
 * All types are plain TypeScript (no Effect Schema) and are readonly.
 *
 * Design constraints:
 * - Effect Schema is never part of the exported surface (plain TS + Result only).
 * - All types are transport-stable; internal coordination fields are excluded.
 * - camelCase keys match the shipped JSON literals exactly.
 */

/**
 * Canonical response shape for GET /operator/session.
 *
 * - `operatorId`: stable GitHub numeric user ID (from the GitHub API `id` field).
 *   Prefer this over `login` for any access-control or audit decision.
 * - `login`: GitHub display login (mutable, for display only).
 * - `expiresAt`: ms-since-epoch timestamp of the sooner of absolute or idle expiry.
 */
export interface OperatorSessionInfo {
  readonly operatorId: number
  readonly login: string
  readonly expiresAt: number
}

/**
 * Canonical response shape for GET /operator/session/csrf.
 *
 * - `csrfToken`: a fresh signed CSRF token bound to the current session and operator.
 *   Must be included in the X-CSRF-Token header for mutating requests.
 */
export interface OperatorCsrfToken {
  readonly csrfToken: string
}

/**
 * Canonical success response shape for operator routes with no meaningful body.
 *
 * Returned by routes that succeed but have nothing to communicate beyond the status.
 * The `ok: true` literal is load-bearing — it is the discriminant for success.
 */
export interface OperatorOk {
  readonly ok: true
}

/**
 * Canonical error response shape for operator routes.
 *
 * All operator error responses use this shape. The `error` string is a coarse,
 * no-oracle reason (e.g. 'unauthorized', 'bad request') — it never echoes input
 * or includes internal detail.
 */
export interface OperatorError {
  readonly error: string
}
