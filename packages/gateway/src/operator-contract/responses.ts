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

import type {TerminalPhase} from '@fro-bot/runtime'

/**
 * Canonical response shape for GET /operator/session.
 *
 * - `operatorId`: stable GitHub numeric user ID (from the GitHub API `id` field).
 *   Prefer this over `login` for any access-control or audit decision.
 * - `login`: GitHub display login (mutable, for display only).
 * - `expiresAt`: ms-since-epoch timestamp of the sooner of absolute or idle expiry.
 * - `push`: optional coarse push-health report; omitted entirely when push is not
 *   configured. Authenticated-only by construction (this is a privileged route).
 */
export interface OperatorSessionInfo {
  readonly operatorId: number
  readonly login: string
  readonly expiresAt: number
  readonly push?: OperatorPushHealth
}

/**
 * Coarse push health, as last OBSERVED by the gateway (no probing).
 *
 * - `ready`: the push subsystem was observed working within the last hour.
 *   This is observed readiness, NOT guaranteed delivery to a browser.
 * - `degraded`: the startup self-test failed, or the most recent fresh
 *   observation of the store backend or relay delivery failed.
 * - `unknown`: configured, but nothing fresh has been observed (every observation
 *   is older than one hour). Never read as healthy.
 *
 * Push that is not configured is reported by omitting `push` from the session
 * response, so there is no `disabled` value on the wire.
 */
export const OPERATOR_PUSH_HEALTH_STATUSES = ['ready', 'degraded', 'unknown'] as const

export type OperatorPushHealthStatus = (typeof OPERATOR_PUSH_HEALTH_STATUSES)[number]

export interface OperatorPushHealth {
  readonly status: OperatorPushHealthStatus
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

/**
 * Canonical success response shape for POST /operator/runs/:runId/cancel.
 *
 * Carries the resulting phase so the dashboard can render honestly whether the
 * cancel actually transitioned the run ('CANCELLED') or the run was already
 * terminal (the pre-existing terminal phase — an idempotent no-op, still a
 * 200, never an error). `runId` echoes the path param for client convenience.
 *
 * Internal attribution (`details.cancelledBy`) and coordination fields
 * (`thread_id`, etc.) are excluded by construction — they never appear here.
 */
export interface OperatorCancelResponse {
  readonly ok: true
  readonly runId: string
  readonly phase: TerminalPhase
}

// ---------------------------------------------------------------------------
// Operator push contract
// ---------------------------------------------------------------------------
//
// These DTOs are defined without enabling any route or dispatch behavior.
//
// Subscription metadata is a safe-fields-only surface: it NEVER carries the
// push endpoint URL, `p256dh`, or `auth` key material — only an opaque
// endpoint hash, timestamps, key version, active state, and a coarse
// inactive reason.

/**
 * Canonical response shape for GET /operator/push/vapid-key.
 *
 * Safe to expose to an authenticated operator session: `publicKey` is the
 * VAPID public key (never the private key), `keyVersion` identifies the
 * current signing key for client resubscribe decisions.
 */
export interface OperatorPushVapidKeyResponse {
  readonly publicKey: string
  readonly keyVersion: string
}

/**
 * The closed set of events that produce an operator push notification. The
 * kind crosses the wire as `data.type` on the push payload. The union is
 * derived from the tuple so the two cannot drift.
 */
export const OPERATOR_PUSH_TRIGGER_KINDS = ['approval', 'question', 'run_failed'] as const
export type OperatorPushTriggerKind = (typeof OPERATOR_PUSH_TRIGGER_KINDS)[number]

/** Coarse, non-oracle reasons a subscription record became inactive. */
export type OperatorPushInactiveReason = 'unsubscribed' | 'dead' | 'revoked' | 'session-revoked'

/**
 * Safe subscription metadata — the only shape returned by list/export
 * surfaces. Endpoint, `p256dh`, and `auth` are write-only secret fields and
 * are never present here.
 */
export interface OperatorPushSubscriptionMetadata {
  /** Opaque hash of the push endpoint URL — never the endpoint itself. */
  readonly endpointHash: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly keyVersion: string
  readonly active: boolean
  readonly inactiveReason?: OperatorPushInactiveReason
}

/**
 * Request body shape for POST /operator/push/subscriptions.
 *
 * Mirrors the W3C `PushSubscription.toJSON()` shape produced by the
 * browser's Push API. `endpoint` and `keys` are accepted at this boundary
 * only — they are never echoed back in a response.
 */
export interface OperatorPushSubscribeRequest {
  readonly endpoint: string
  readonly keys: {
    readonly p256dh: string
    readonly auth: string
  }
}

/** Request body shape for POST /operator/push/subscriptions/unsubscribe. */
export interface OperatorPushUnsubscribeRequest {
  readonly endpoint: string
}

/** Canonical success response shape for GET /operator/push/subscriptions. */
export interface OperatorPushSubscriptionListResponse {
  readonly subscriptions: readonly OperatorPushSubscriptionMetadata[]
}
