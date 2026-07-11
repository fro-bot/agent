/**
 * Authenticated operator push subscription routes:
 *   - POST /operator/push/subscriptions            — subscribe
 *   - POST /operator/push/subscriptions/unsubscribe — unsubscribe
 *   - GET  /operator/push/subscriptions             — list metadata
 *
 * Wires the browser's W3C `PushSubscription.toJSON()` payload to the durable
 * subscription store (web/operator-push/subscription-store.ts). Every
 * response returns only safe metadata — the endpoint URL and P-256/auth keys
 * are write-only and never echoed back or logged.
 *
 * Gate ordering (subscribe/unsubscribe — mirrors launch-route.ts):
 *   1. Guard (browser/session/allowlist/CSRF) — installed by buildOperatorApp
 *   2. Read authenticated context set by the guard — undefined → notFoundResponse
 *   3. Resolve operator identity (githubUserId) from authCtx
 *   4. Operator-keyed rate limit (write routes only)
 *   5. Parse + validate request body
 *   6. Endpoint URL validation (SSRF-conservative — subscribe only)
 *   7. Call the store
 *   8. Map result → safe JSON
 *
 * List (GET) skips gates 4–6 (no body, no mutation, no endpoint to validate).
 *
 * Security invariants:
 *   - Every denial (gates 2–4) returns the identical no-oracle notFoundResponse,
 *     mirroring launch-route. Malformed body / bad endpoint → 400 (mirrors
 *     launch-route's body-validation convention).
 *   - A gate throw degrades to the same denial, never a distinguishable 500.
 *   - The endpoint value is NEVER included in a response, log line, or thrown
 *     error — only coarse gate names and rejection classes.
 *   - CSRF/Origin middleware covers the two POST routes (write routes).
 */

import type {Hono} from 'hono'
import type {RateLimiter} from '../../http/rate-limit.js'
import type {
  OperatorPushSubscriptionListResponse,
  OperatorPushSubscriptionMetadata,
} from '../../operator-contract/index.js'
import type {AuditLogger} from '../audit.js'
import type {OperatorLogger} from '../server.js'
import type {OperatorPushSubscriptionStore, SubscriptionMetadata} from './subscription-store.js'
import {createRateLimiter} from '../../http/rate-limit.js'
import {parseOperatorPushSubscribeRequest, parseOperatorPushUnsubscribeRequest} from '../../operator-contract/index.js'
import {emitAudit} from '../audit.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {notFoundResponse, rateLimitedResponse} from '../safe-response.js'
import {hashEndpoint} from './subscription-store.js'
import {validateEndpointUrl} from './validate-endpoint.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-operator subscribe rate limit: 10 requests per minute. */
const SUBSCRIBE_RATE_LIMIT_PER_MIN = 10
const SUBSCRIBE_RATE_WINDOW_MS = 60_000

/** Per-operator unsubscribe rate limit: 10 requests per minute. */
const UNSUBSCRIBE_RATE_LIMIT_PER_MIN = 10
const UNSUBSCRIBE_RATE_WINDOW_MS = 60_000

/**
 * Best-effort soft bound on active subscription records per operator,
 * limiting store and dispatch-fanout growth from a single operator's
 * browsers. The count is read before the write and is not atomic with it,
 * so concurrent subscribes for distinct new endpoints can transiently
 * exceed this bound by (concurrency - 1); the per-operator subscribe rate
 * limit bounds how far that overrun can go. This limits unbounded growth,
 * not an exact ceiling. A re-subscribe of an endpoint the operator already
 * owns is a replace, not a new record, so it is exempt from this bound.
 */
const MAX_ACTIVE_SUBSCRIPTIONS_PER_OPERATOR = 20

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal session store interface required by the push subscription routes. */
export interface SubscriptionRouteSessionStore {
  readonly get: (
    sessionId: string,
    nowMs: number,
  ) => {readonly githubUserId: number; readonly login: string} | undefined
}

/** Dependencies for the push subscription routes. */
export interface SubscriptionRouteDeps {
  /** Session store for identity resolution. */
  readonly sessionStore: SubscriptionRouteSessionStore
  /** Durable subscription-record store. */
  readonly store: Pick<OperatorPushSubscriptionStore, 'subscribe' | 'unsubscribe' | 'listMetadataForOperator'>
  /** Current VAPID key version — stamped onto every subscribe call. */
  readonly keyVersion: string
  /** Audit logger for security events. */
  readonly auditLogger: AuditLogger
  /** Structured logger. */
  readonly logger: OperatorLogger
  /** Injectable clock. */
  readonly now: () => number
  /** Optional injectable per-minute rate limiter for subscribe (operator-keyed). */
  readonly subscribeRateLimiter?: RateLimiter
  /** Optional injectable per-minute rate limiter for unsubscribe (operator-keyed). */
  readonly unsubscribeRateLimiter?: RateLimiter
}

/** Map full SubscriptionMetadata (store shape) to the contract-safe response shape. */
function toResponseMetadata(metadata: SubscriptionMetadata): OperatorPushSubscriptionMetadata {
  const base: OperatorPushSubscriptionMetadata = {
    endpointHash: metadata.endpointHash,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    keyVersion: metadata.keyVersion,
    active: metadata.active,
  }
  if (metadata.inactiveReason === undefined) {
    return base
  }
  // The store's inactive-reason taxonomy is a superset ('transferred') of the
  // contract's public taxonomy. 'transferred' would leak that the endpoint
  // moved to another operator, so it is mapped to the same coarse 'revoked'
  // reason used for key_revoked rather than omitted — an omitted reason
  // renders ambiguously (active:false with no explanation) on the client.
  if (
    metadata.inactiveReason === 'unsubscribed' ||
    metadata.inactiveReason === 'dead' ||
    metadata.inactiveReason === 'key_revoked' ||
    metadata.inactiveReason === 'session-revoked' ||
    metadata.inactiveReason === 'transferred'
  ) {
    const mapped =
      metadata.inactiveReason === 'key_revoked' || metadata.inactiveReason === 'transferred'
        ? 'revoked'
        : metadata.inactiveReason
    return {...base, inactiveReason: mapped}
  }
  return base
}

// ---------------------------------------------------------------------------
// Route builder
// ---------------------------------------------------------------------------

/**
 * Register the three push subscription routes on the given Hono app.
 *
 * Must be called after setOperatorRouteGuard is installed in buildOperatorApp.
 * The guard runs first (browser/session/allowlist/CSRF); each handler runs
 * only if the guard allows the request.
 */
export function buildSubscriptionRoutes(app: Hono, deps: SubscriptionRouteDeps): void {
  const subscribeLimiter =
    deps.subscribeRateLimiter ??
    createRateLimiter({limit: SUBSCRIBE_RATE_LIMIT_PER_MIN, windowMs: SUBSCRIBE_RATE_WINDOW_MS, clock: deps.now})
  const unsubscribeLimiter =
    deps.unsubscribeRateLimiter ??
    createRateLimiter({limit: UNSUBSCRIBE_RATE_LIMIT_PER_MIN, windowMs: UNSUBSCRIBE_RATE_WINDOW_MS, clock: deps.now})

  // ── POST /operator/push/subscriptions ─────────────────────────────────────
  registerOperatorRoute(app, 'POST', '/operator/push/subscriptions', async c => {
    const nowMs = deps.now()

    // ── Gate 2: Read authenticated context set by the guard ────────────────
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'push-subscribe: denied')
      return notFoundResponse(c)
    }
    const {githubUserId, sessionId} = authCtx
    const operatorId = String(githubUserId)

    // ── Gate 4: Operator rate limit ─────────────────────────────────────────
    if (subscribeLimiter.allow(operatorId) === false) {
      deps.logger.warn({githubUserId, gate: 'rate-limited'}, 'push-subscribe: rate limited')
      return rateLimitedResponse(c)
    }

    // Resolve session identity — required for attribution, mirrors launch-route gate 3.
    const sessionEntry = deps.sessionStore.get(sessionId, nowMs)
    if (sessionEntry === undefined) {
      deps.logger.warn({githubUserId, gate: 'no-session'}, 'push-subscribe: denied — session missing')
      return notFoundResponse(c)
    }

    // ── Gate 5: Parse + validate request body ───────────────────────────────
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      deps.logger.warn({githubUserId, gate: 'bad-body'}, 'push-subscribe: denied — invalid JSON body')
      return c.json({error: 'bad request'}, 400)
    }

    const parsed = parseOperatorPushSubscribeRequest(body)
    if (parsed.success === false) {
      deps.logger.warn({githubUserId, gate: 'bad-body'}, 'push-subscribe: denied — invalid request shape')
      return c.json({error: 'bad request'}, 400)
    }

    // ── Gate 6: SSRF-conservative endpoint validation ───────────────────────
    // Never log the endpoint value itself — only the coarse rejection class.
    const endpointCheck = validateEndpointUrl(parsed.data.endpoint)
    if (endpointCheck.ok === false) {
      deps.logger.warn(
        {githubUserId, gate: 'endpoint-rejected', reason: endpointCheck.reason},
        'push-subscribe: denied — endpoint failed SSRF validation',
      )
      return c.json({error: 'bad request'}, 400)
    }

    // ── Gate 7: Call the store ───────────────────────────────────────────────
    try {
      // Soft active-subscription bound: block a NEW endpoint once the
      // operator is already at the bound, but never block a re-subscribe of
      // an endpoint they already own — that write replaces the existing
      // record rather than growing the active set. See
      // MAX_ACTIVE_SUBSCRIPTIONS_PER_OPERATOR's docstring for why this is
      // soft rather than atomic.
      const existingMetadata = await deps.store.listMetadataForOperator({operatorId})
      if (existingMetadata.success === false) {
        deps.logger.warn({githubUserId, gate: 'store-error'}, 'push-subscribe: store write failed')
        return notFoundResponse(c)
      }
      const activeRecords = existingMetadata.data.filter(m => m.active === true)
      const endpointHash = hashEndpoint(parsed.data.endpoint)
      const isExistingEndpoint = activeRecords.some(m => m.endpointHash === endpointHash)
      if (isExistingEndpoint === false && activeRecords.length >= MAX_ACTIVE_SUBSCRIPTIONS_PER_OPERATOR) {
        deps.logger.warn({githubUserId, gate: 'subscription-cap'}, 'push-subscribe: subscription cap')
        return c.json({error: 'bad request'}, 400)
      }

      const result = await deps.store.subscribe({
        operatorId,
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        keyVersion: deps.keyVersion,
      })
      if (result.success === false) {
        deps.logger.warn({githubUserId, gate: 'store-error'}, 'push-subscribe: store write failed')
        return notFoundResponse(c)
      }

      // ── Gate 8: Map result → safe JSON (metadata only, never endpoint/keys) ─
      deps.logger.info({githubUserId}, 'push-subscribe: accepted')
      emitAudit(
        {kind: 'push.subscribed', correlationId: `push-subscribe:${githubUserId}`, githubUserId},
        deps.auditLogger,
      )
      return c.json(toResponseMetadata(result.data), 200)
    } catch (error: unknown) {
      deps.logger.warn(
        {githubUserId, err: error instanceof Error ? error.message : String(error)},
        'push-subscribe: store call threw — denying',
      )
      return notFoundResponse(c)
    }
  })

  // ── POST /operator/push/subscriptions/unsubscribe ─────────────────────────
  registerOperatorRoute(app, 'POST', '/operator/push/subscriptions/unsubscribe', async c => {
    // ── Gate 2: Read authenticated context set by the guard ────────────────
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'push-unsubscribe: denied')
      return notFoundResponse(c)
    }
    const {githubUserId} = authCtx
    const operatorId = String(githubUserId)

    // ── Gate 4: Operator rate limit ─────────────────────────────────────────
    if (unsubscribeLimiter.allow(operatorId) === false) {
      deps.logger.warn({githubUserId, gate: 'rate-limited'}, 'push-unsubscribe: rate limited')
      return rateLimitedResponse(c)
    }

    // ── Gate 5: Parse + validate request body ───────────────────────────────
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      deps.logger.warn({githubUserId, gate: 'bad-body'}, 'push-unsubscribe: denied — invalid JSON body')
      return c.json({error: 'bad request'}, 400)
    }

    const parsed = parseOperatorPushUnsubscribeRequest(body)
    if (parsed.success === false) {
      deps.logger.warn({githubUserId, gate: 'bad-body'}, 'push-unsubscribe: denied — invalid request shape')
      return c.json({error: 'bad request'}, 400)
    }

    // ── Gate 7: Call the store ───────────────────────────────────────────────
    // Fail-closed, no-oracle: the store rejects when the endpoint is owned by
    // a different operator; that denial and an unknown endpoint (idempotent
    // no-op success) both surface identically here to avoid leaking ownership.
    try {
      const result = await deps.store.unsubscribe({operatorId, endpoint: parsed.data.endpoint})
      if (result.success === false) {
        deps.logger.warn({githubUserId, gate: 'store-error'}, 'push-unsubscribe: denied')
        return notFoundResponse(c)
      }

      // ── Gate 8: Safe response — no endpoint/keys ─────────────────────────
      deps.logger.info({githubUserId}, 'push-unsubscribe: accepted')
      emitAudit(
        {kind: 'push.unsubscribed', correlationId: `push-unsubscribe:${githubUserId}`, githubUserId},
        deps.auditLogger,
      )
      return c.json({ok: true}, 200)
    } catch (error: unknown) {
      deps.logger.warn(
        {githubUserId, err: error instanceof Error ? error.message : String(error)},
        'push-unsubscribe: store call threw — denying',
      )
      return notFoundResponse(c)
    }
  })

  // ── GET /operator/push/subscriptions ───────────────────────────────────────
  registerOperatorRoute(app, 'GET', '/operator/push/subscriptions', async c => {
    // ── Gate 2: Read authenticated context set by the guard ────────────────
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'push-subscriptions-list: denied')
      return notFoundResponse(c)
    }
    const {githubUserId} = authCtx
    const operatorId = String(githubUserId)

    try {
      const result = await deps.store.listMetadataForOperator({operatorId})
      if (result.success === false) {
        deps.logger.warn({githubUserId, gate: 'store-error'}, 'push-subscriptions-list: denied')
        return notFoundResponse(c)
      }

      const response: OperatorPushSubscriptionListResponse = {
        subscriptions: result.data.map(toResponseMetadata),
      }
      return c.json(response, 200)
    } catch (error: unknown) {
      deps.logger.warn(
        {githubUserId, err: error instanceof Error ? error.message : String(error)},
        'push-subscriptions-list: store call threw — denying',
      )
      return notFoundResponse(c)
    }
  })
}
