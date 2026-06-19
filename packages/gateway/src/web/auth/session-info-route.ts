/**
 * Session info endpoint for the operator web surface.
 *
 * GET /operator/session
 *
 * Returns current session info for an authenticated, allowlisted operator.
 * The response includes the operator's numeric GitHub user ID, display login,
 * and the computed session expiry timestamp.
 *
 * Security invariants:
 *   - Requires a valid session cookie (authenticated session).
 *   - Requires the session's GitHub user ID to be in the operator allowlist.
 *   - Origin and Fetch Metadata checks are applied before returning session info.
 *   - No CSRF token required (safe GET method).
 *   - Response is no-store, private — never cached.
 *   - No session ID, secret, or internal detail is included in the response.
 *
 * The browser guard is applied automatically by the privileged-route guard seam
 * installed in server.ts (via setOperatorRouteGuard). The handler reads the
 * authenticated context (githubUserId, sessionId) from the Hono context variables
 * set by the guard wrapper — no double session lookup.
 */

import type {Hono} from 'hono'
import type {BrowserGuardDeps} from './csrf.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {SESSION_ABSOLUTE_TTL_MS, SESSION_IDLE_TTL_MS} from './session.js'

/**
 * Register the GET /operator/session route on the given Hono app.
 *
 * Registered as a privileged operator route (requires session + allowlist).
 * The browser guard is applied automatically by the privileged-route guard seam
 * (setOperatorRouteGuard in server.ts). No CSRF token is required to GET session
 * info (safe method — guard uses requireCsrf=false for GET).
 *
 * The handler reads the authenticated context from Hono context variables set
 * by the guard wrapper, avoiding a double session lookup.
 *
 * Response body: { operatorId: number, login: string, expiresAt: number }
 *   - operatorId: stable GitHub numeric user ID
 *   - login: GitHub display login (mutable, for display only)
 *   - expiresAt: ms-since-epoch timestamp of the sooner of absolute or idle expiry
 */
export function buildSessionInfoRoute(app: Hono, deps: BrowserGuardDeps): void {
  registerOperatorRoute(app, 'GET', '/operator/session', c => {
    // The browser guard has already run (via the privileged-route guard seam).
    // Read the authenticated context stored by the guard wrapper.
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      // Guard not installed. This path is unreachable in production — buildSessionInfoRoute
      // is only called when browserGuardDeps is present, which also installs the guard.
      // Return 401 as a safe fallback.
      return c.json({error: 'unauthorized'}, 401)
    }

    const {sessionId} = authCtx
    const nowMs = deps.clock()

    // Look up the session entry to get identity and timestamps.
    // The guard already validated the session, but a race (revocation/expiry between
    // guard and handler) can produce undefined here. Treat it as a coarse 401 —
    // same body as the guard-not-installed fallback to avoid distinguishing detail.
    const entry = deps.sessionStore.get(sessionId, nowMs)
    if (entry === undefined) {
      return c.json({error: 'unauthorized'}, 401)
    }

    // Compute the effective expiry: the sooner of absolute TTL and idle TTL.
    const absoluteExpiry = entry.issuedAt + SESSION_ABSOLUTE_TTL_MS
    const idleExpiry = entry.lastAccessedAt + SESSION_IDLE_TTL_MS
    const expiresAt = Math.min(absoluteExpiry, idleExpiry)

    // Prevent caching of session info — it is session-bound and must not be
    // served from any cache (browser, CDN, or proxy).
    c.header('Cache-Control', 'no-store, private')
    // Vary on the headers the browser guard inspects so intermediaries cannot
    // serve a cached response to a different origin or fetch context.
    c.header('Vary', 'Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest')

    return c.json(
      {
        operatorId: entry.githubUserId,
        login: entry.login,
        expiresAt,
      },
      200,
    )
  })
}
