/**
 * CSRF token endpoint for the operator web surface.
 *
 * GET /operator/session/csrf
 *
 * Returns a fresh signed CSRF token for an authenticated, allowlisted session.
 * The token is returned in the response body only — never in a cookie or header.
 * The caller must include this token in the X-CSRF-Token header for mutating requests.
 *
 * Security invariants:
 *   - Requires a valid session cookie (authenticated session).
 *   - Requires the session's GitHub user ID to be in the operator allowlist.
 *   - Origin and Fetch Metadata checks are applied before returning the token.
 *   - Token is never logged.
 *   - No CSRF token required to GET the CSRF token (safe method).
 *
 * The browser guard is applied automatically by the privileged-route guard seam
 * installed in server.ts (via setOperatorRouteGuard). The handler reads the
 * authenticated context (githubUserId, sessionId) from the Hono context variables
 * set by the guard wrapper — no double session lookup.
 */

import type {Hono} from 'hono'
import type {BrowserGuardDeps} from './csrf.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {generateCsrfToken} from './csrf.js'

/**
 * Register the GET /operator/session/csrf route on the given Hono app.
 *
 * Registered as a privileged operator route (requires session + allowlist).
 * The browser guard is applied automatically by the privileged-route guard seam
 * (setOperatorRouteGuard in server.ts). No CSRF token is required to GET the
 * CSRF token (safe method — guard uses requireCsrf=false for GET).
 *
 * The handler reads the authenticated context from Hono context variables set
 * by the guard wrapper, avoiding a double session lookup.
 */
export function buildCsrfRoute(app: Hono, deps: BrowserGuardDeps): void {
  registerOperatorRoute(app, 'GET', '/operator/session/csrf', c => {
    // The browser guard has already run (via the privileged-route guard seam).
    // Read the authenticated context stored by the guard wrapper.
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      // Guard not installed. This path is unreachable in production — buildCsrfRoute
      // is only called when browserGuardDeps is present, which also installs the guard.
      // Return 401 as a safe fallback.
      return c.json({error: 'unauthorized'}, 401)
    }

    const {githubUserId, sessionId} = authCtx
    const nowMs = deps.clock()

    // Generate a fresh CSRF token bound to this session and operator.
    const token = generateCsrfToken({
      sessionId,
      operatorId: githubUserId,
      nowMs,
      secret: deps.csrfSecret,
    })

    // Prevent caching of the CSRF token — it is session-bound and must not be
    // served from any cache (browser, CDN, or proxy).
    c.header('Cache-Control', 'no-store, private')
    // Vary on the headers the browser guard inspects so intermediaries cannot
    // serve a cached response to a different origin or fetch context.
    c.header('Vary', 'Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest')

    // Return token in response body only — never in a cookie or header.
    return c.json({csrfToken: token}, 200)
  })
}
