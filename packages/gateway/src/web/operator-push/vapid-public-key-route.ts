/**
 * Authenticated operator push route: GET /operator/push/vapid-key
 *
 * Returns the current VAPID public key and key version so an authenticated
 * operator's browser can call `PushManager.subscribe({applicationServerKey})`.
 * Never exposes the private key — the route only ever reads
 * `vapidPublicKeyInfo` (see web/operator-push/vapid.ts), which structurally
 * excludes the private key field.
 *
 * Gate ordering:
 *   1. Guard (browser/session/allowlist) — installed by buildOperatorApp
 *      (GET → requireCsrf=false; this is a read route)
 *   2. Read authenticated context set by the guard
 *   3. Return {publicKey, keyVersion}
 *
 * Security invariants:
 *   - The private VAPID key never flows into this module.
 *   - Every denial mirrors the launch route's no-oracle notFoundResponse.
 */

import type {Hono} from 'hono'
import type {OperatorPushVapidKeyResponse} from '../../operator-contract/index.js'
import type {OperatorLogger} from '../server.js'
import type {VapidPublicKeyInfo} from './vapid.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {notFoundResponse} from '../safe-response.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies for the VAPID public key route. */
export interface VapidPublicKeyRouteDeps {
  /** Client-safe VAPID material (public key + key version only). */
  readonly vapidPublicKeyInfo: VapidPublicKeyInfo
  /** Structured logger. */
  readonly logger: OperatorLogger
}

// ---------------------------------------------------------------------------
// Route builder
// ---------------------------------------------------------------------------

/**
 * Register GET /operator/push/vapid-key on the given Hono app.
 *
 * Must be called after setOperatorRouteGuard is installed in buildOperatorApp.
 * The guard runs first (browser/session/allowlist); this handler runs only
 * if the guard allows the request.
 */
export function buildVapidPublicKeyRoute(app: Hono, deps: VapidPublicKeyRouteDeps): void {
  registerOperatorRoute(app, 'GET', '/operator/push/vapid-key', c => {
    // ── Gate: Read authenticated context set by the guard ────────────────────
    // In production the guard always sets this; undefined is unreachable.
    // Return not-found as a safe fallback (no oracle — same shape as all denials).
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'push-vapid-key: denied')
      return notFoundResponse(c)
    }

    const response: OperatorPushVapidKeyResponse = {
      publicKey: deps.vapidPublicKeyInfo.publicKey,
      keyVersion: deps.vapidPublicKeyInfo.keyVersion,
    }
    return c.json(response, 200)
  })
}
