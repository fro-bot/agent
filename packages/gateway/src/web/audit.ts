/**
 * Typed audit seam for security-critical operator web events.
 * All security-relevant events flow through emitAudit(event, logger).
 * Gateway restart clears all in-flight audit state; no durable queue in v1.
 */

export interface AuditLogger {
  readonly info: (ctx: Record<string, unknown>, msg: string) => void
  readonly warn: (ctx: Record<string, unknown>, msg: string) => void
}

/** Safe reasons for auth callback failure. */
export type AuthCallbackFailureReason =
  | 'state_mismatch'
  | 'provider_error'
  | 'token_exchange_failed'
  | 'user_fetch_failed'
  | 'source_key_mismatch'
  | 'not_allowlisted'
  | 'unknown'

/** Safe reasons for authorization denial. */
export type AuthzDeniedReason =
  | 'not_allowlisted'
  | 'suspended'
  | 'invalid_repo_name'
  | 'github_denied'
  | 'rate_limited'
  | 'lookup_error'
  | 'insufficient_permission'
  | 'unknown'

/** Safe reasons for launch rejection. */
export type LaunchRejectedReason = 'binding_not_found' | 'concurrency_cap' | 'authz_denied' | 'unknown'

/** Safe reasons for approval rejection. */
export type ApprovalRejectedReason = 'already_claimed' | 'not_found' | 'deadline_expired' | 'scope_mismatch' | 'unknown'

/** Safe reasons for cancel-request rejection (pre-acceptance denial). */
export type CancelRejectedReason = 'not_found' | 'authz_denied' | 'unknown'

/** Safe reasons for bearer token rejection. */
export type BearerRejectedReason = 'missing_token' | 'invalid_signature' | 'expired' | 'unknown'

/** Safe reasons for browser-origin guard rejection. */
export type BrowserGuardRejectedReason =
  | 'non_cookie_credential'
  | 'no_session'
  | 'invalid_session'
  | 'not_allowlisted'
  | 'origin_null'
  | 'origin_mismatch'
  | 'origin_missing'
  | 'fetch_site_cross_site'
  | 'fetch_site_same_site'
  | 'fetch_mode_navigate'
  | 'fetch_mode_no_cors'
  | 'fetch_dest_object_embed'
  | 'csrf_missing'
  | 'csrf_invalid'
  | 'unknown'

/** OAuth flow initiated. */
export interface AuthStartEvent {
  readonly kind: 'auth.start'
  readonly correlationId: string
}

/** OAuth callback completed successfully. */
export interface AuthCallbackSuccessEvent {
  readonly kind: 'auth.callback.success'
  readonly correlationId: string
  /** Stable GitHub numeric user ID. */
  readonly githubUserId: number
  /** GitHub display login — mutable, for display only. */
  readonly login: string
}

/** OAuth callback failed. */
export interface AuthCallbackFailureEvent {
  readonly kind: 'auth.callback.failure'
  readonly correlationId: string
  readonly reason: AuthCallbackFailureReason
}

/** Operator session logged out. */
export interface AuthLogoutEvent {
  readonly kind: 'auth.logout'
  readonly correlationId: string
  readonly githubUserId: number
}

/** OAuth token revoked (e.g. GitHub webhook revocation). */
export interface AuthRevocationEvent {
  readonly kind: 'auth.revocation'
  readonly correlationId: string
  readonly githubUserId: number
}

/** Authenticated operator denied access (not on allowlist, suspended, etc.). */
export interface AuthzDeniedEvent {
  readonly kind: 'authz.denied'
  readonly correlationId: string
  readonly githubUserId: number
  readonly reason: AuthzDeniedReason
}

/** Launch request accepted and queued. */
export interface LaunchAcceptedEvent {
  readonly kind: 'launch.accepted'
  readonly correlationId: string
  readonly githubUserId: number
  readonly repoFullName: string
}

/** Launch request rejected before queuing. */
export interface LaunchRejectedEvent {
  readonly kind: 'launch.rejected'
  readonly correlationId: string
  readonly githubUserId: number
  readonly reason: LaunchRejectedReason
}

/** Approval decision submitted by operator. */
export interface ApprovalDecisionEvent {
  readonly kind: 'approval.decision'
  readonly correlationId: string
  readonly githubUserId: number
  readonly requestId: string
  /**
   * Pass-through enum: 'once' | 'always' | 'reject' — never a free-form string.
   * 'always' is the higher-blast-radius grant (persists as an OpenCode always-rule).
   * 'once' approves for this request only. 'reject' denies.
   */
  readonly decision: 'once' | 'always' | 'reject'
}

/** Approval submission rejected (already claimed, not found, etc.). */
export interface ApprovalRejectedEvent {
  readonly kind: 'approval.rejected'
  readonly correlationId: string
  readonly githubUserId: number
  readonly requestId: string
  readonly reason: ApprovalRejectedReason
}

/**
 * Operator cancel request accepted and processed (regardless of outcome —
 * 'cancelled' or the idempotent 'already-terminal' hit). The resulting phase
 * is carried so the audit trail records what actually happened.
 */
export interface RunCancelRequestedEvent {
  readonly kind: 'run.cancel.requested'
  readonly correlationId: string
  readonly githubUserId: number
  readonly runId: string
  readonly phase: 'CANCELLED' | 'COMPLETED' | 'FAILED'
}

/** Operator cancel request denied at a pre-acceptance gate (no state change). */
export interface RunCancelRejectedEvent {
  readonly kind: 'run.cancel.rejected'
  readonly correlationId: string
  readonly githubUserId: number
  readonly reason: CancelRejectedReason
}

/** Operator read a repo binding. */
export interface BindingReadEvent {
  readonly kind: 'binding.read'
  readonly correlationId: string
  readonly githubUserId: number
  readonly repoFullName: string
}

/** Bearer token rejected on an authenticated route. */
export interface BearerRejectedEvent {
  readonly kind: 'bearer.rejected'
  readonly correlationId: string
  /** Safe enum — never the raw token value. */
  readonly reason: BearerRejectedReason
}

/** Browser-origin guard rejected a request. */
export interface BrowserGuardRejectedEvent {
  readonly kind: 'browser.guard.rejected'
  readonly correlationId: string
  /** Safe enum — never header values, origins, or credential values. */
  readonly reason: BrowserGuardRejectedReason
  /**
   * GitHub numeric user ID — present only when reason is 'not_allowlisted'
   * (i.e. the session was valid but the user is not in the allowlist).
   * Absent for all other rejection reasons where identity is not yet established.
   */
  readonly githubUserId?: number
}

/**
 * Coarse reason a push subscription record became inactive, as surfaced on
 * the audit trail. Aligns with (but is a superset-safe mirror of) the
 * store's `SubscriptionInactiveReason` taxonomy — snake_case to match the
 * other reason enums in this module.
 */
export type PushDeactivationReason =
  'dead_relay' | 'session_revoked' | 'transferred' | 'key_revoked' | 'privacy_delete' | 'unknown'

/** Safe reasons the operator push surface is disabled at startup. */
export type PushDisabledReason = 'config_absent' | 'self_test_failed'

/** An operator registered a push subscription. Endpoint/keys are NEVER included. */
export interface PushSubscribedEvent {
  readonly kind: 'push.subscribed'
  readonly correlationId: string
  readonly githubUserId: number
}

/** An operator removed a push subscription. Endpoint is NEVER included. */
export interface PushUnsubscribedEvent {
  readonly kind: 'push.unsubscribed'
  readonly correlationId: string
  readonly githubUserId: number
}

/** A push subscription record was deactivated (session revoke, privacy delete, etc). */
export interface PushSubscriptionDeactivatedEvent {
  readonly kind: 'push.subscription.deactivated'
  readonly correlationId: string
  readonly githubUserId: number
  readonly reason: PushDeactivationReason
}

/**
 * Coarse per-broadcast dispatch summary — counts only, never per-operator
 * rows, never endpoints. Records "a broadcast for trigger X reached N
 * subscriptions, D died, F failed."
 */
export interface PushDispatchEvent {
  readonly kind: 'push.dispatch'
  /** The triggering run/approval id — same redaction class as requestId/runId. */
  readonly correlationId: string
  readonly trigger: 'approval' | 'run_failed'
  readonly delivered: number
  readonly dead: number
  readonly failed: number
}

/** The operator push surface was disabled at startup. */
export interface PushDisabledEvent {
  readonly kind: 'push.disabled'
  readonly correlationId: string
  readonly reason: PushDisabledReason
}

/** All security-critical audit events. */
export type AuditEvent =
  | AuthStartEvent
  | AuthCallbackSuccessEvent
  | AuthCallbackFailureEvent
  | AuthLogoutEvent
  | AuthRevocationEvent
  | AuthzDeniedEvent
  | LaunchAcceptedEvent
  | LaunchRejectedEvent
  | ApprovalDecisionEvent
  | ApprovalRejectedEvent
  | BindingReadEvent
  | BearerRejectedEvent
  | BrowserGuardRejectedEvent
  | RunCancelRequestedEvent
  | RunCancelRejectedEvent
  | PushSubscribedEvent
  | PushUnsubscribedEvent
  | PushSubscriptionDeactivatedEvent
  | PushDispatchEvent
  | PushDisabledEvent

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Patterns for sensitive string values that must never reach the log sink.
 * Redaction is whole-value and intentionally biased toward over-redaction.
 */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  // Cookie / session header values — common names only, with a boundary before the cookie name.
  /(?:^|[;,\s])(?:session|sid|sessionid|connect\.sid)\s*=/i,
  // GitHub tokens — match anywhere in the string (embedded in URLs, headers, etc.)
  /ghp_/,
  /ghs_/,
  /github_pat_/,
  // Bearer token header values — case-insensitive, matches embedded occurrences
  /bearer\s+/i,
  // Client secret
  /client_secret/i,
  // Prompt sentinel
  /PROMPT_CONTENT/,
  // Internal / RFC-1918 / loopback URLs — case-insensitive, match bare host and with path
  /https?:\/\/localhost(?:[/:?#]|$)/i,
  /https?:\/\/127\./i,
  /https?:\/\/10\./i,
  /https?:\/\/172\.(1[6-9]|2\d|3[01])\./i,
  /https?:\/\/192\.168\./i,
  /https?:\/\/169\.254\./i,
  // IPv6 loopback
  /https?:\/\/\[::1\]/i,
  // IPv6 ULA (fc00::/7) and link-local (fe80::/10)
  /https?:\/\/\[f[ce][0-9a-f]{2}:/i,
  // Docker / Kubernetes internal hostnames
  /https?:\/\/host\.docker\.internal(?:[/:?#]|$)/i,
  /https?:\/\/[a-z0-9-]+\.svc\.cluster\.local(?:[/:?#]|$)/i,
]

/** Returns '[redacted]' if the value matches any sensitive pattern; otherwise returns the value unchanged. */
function redactIfSensitive(value: string): string {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(value)) return '[redacted]'
  }
  return value
}

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

/**
 * Exhaustive log-level map: every AuditEvent kind must be present.
 * Adding a new variant without updating this map is a compile-time error.
 *
 * Note: 'approval.rejected' and 'push.disabled' are intentionally absent —
 * their levels are reason-dependent. See approvalRejectedLevel() and
 * pushDisabledLevel() below.
 */
const LOG_LEVEL: Record<Exclude<AuditEvent['kind'], 'approval.rejected' | 'push.disabled'>, 'info' | 'warn'> = {
  'auth.start': 'info',
  'auth.callback.success': 'info',
  'auth.callback.failure': 'warn',
  'auth.logout': 'info',
  'auth.revocation': 'info',
  'authz.denied': 'warn',
  'launch.accepted': 'info',
  'launch.rejected': 'warn',
  'approval.decision': 'info',
  'binding.read': 'info',
  'bearer.rejected': 'warn',
  'browser.guard.rejected': 'warn',
  'run.cancel.requested': 'info',
  'run.cancel.rejected': 'warn',
  'push.subscribed': 'info',
  'push.unsubscribed': 'info',
  'push.subscription.deactivated': 'info',
  'push.dispatch': 'info',
}

/**
 * Per-reason log level for 'approval.rejected' events.
 *
 * - 'already_claimed' / 'not_found': INFO — expected outcomes of concurrent submit
 *   (single-winner race) or a stale/duplicate request. Benign operational noise.
 * - 'scope_mismatch': WARN — genuine security signal: an operator tried to settle
 *   a request outside their run's scope. Warrants attention.
 * - 'unknown': WARN — operational anomaly (settlement failure); warrants attention.
 * - 'deadline_expired': WARN — registry-internal deadline path; not produced by the
 *   decision route but kept in the taxonomy for completeness.
 */
function approvalRejectedLevel(reason: ApprovalRejectedReason): 'info' | 'warn' {
  switch (reason) {
    case 'already_claimed':
    case 'not_found':
      return 'info'
    case 'scope_mismatch':
    case 'unknown':
    case 'deadline_expired':
      return 'warn'
  }
}

/**
 * Per-reason log level for 'push.disabled' events.
 *
 * - 'config_absent': INFO — the normal, expected state for any deployment
 *   that has not opted into operator push.
 * - 'self_test_failed': WARN — the object store failed the startup CAS
 *   self-test and push was forced closed; a genuine operational anomaly
 *   that warrants attention.
 */
function pushDisabledLevel(reason: PushDisabledReason): 'info' | 'warn' {
  switch (reason) {
    case 'config_absent':
      return 'info'
    case 'self_test_failed':
      return 'warn'
  }
}

/** Compile-time exhaustiveness guard — unreachable at runtime. */
function assertNever(x: never): never {
  throw new Error(`Unhandled AuditEvent kind: ${JSON.stringify(x)}`)
}

/** Emit a structured audit record. Sink failures are swallowed so audit logging cannot crash handlers. */
export function emitAudit(event: AuditEvent, logger: AuditLogger): void {
  const msg = `audit: ${event.kind}`
  // Build a sanitized context: spread all fields, then overwrite caller-controlled strings.
  const ctx: Record<string, unknown> = {...event}

  // Sanitize correlationId — present on every variant.
  ctx.correlationId = redactIfSensitive(event.correlationId)

  // Sanitize variant-specific caller-controlled string fields.
  switch (event.kind) {
    case 'auth.callback.success':
      ctx.login = redactIfSensitive(event.login)
      break
    case 'launch.accepted':
    case 'binding.read':
      ctx.repoFullName = redactIfSensitive(event.repoFullName)
      break
    case 'approval.decision':
    case 'approval.rejected':
      ctx.requestId = redactIfSensitive(event.requestId)
      break
    case 'run.cancel.requested':
      ctx.runId = redactIfSensitive(event.runId)
      break
    case 'auth.start':
    case 'auth.callback.failure':
    case 'auth.logout':
    case 'auth.revocation':
    case 'authz.denied':
    case 'launch.rejected':
    case 'bearer.rejected':
    case 'browser.guard.rejected':
    case 'run.cancel.rejected':
    case 'push.subscribed':
    case 'push.unsubscribed':
    case 'push.subscription.deactivated':
    case 'push.dispatch':
    case 'push.disabled':
      // No additional caller-controlled string fields on these variants.
      break
    default:
      // Exhaustiveness guard: TypeScript will error here if a new variant is added without a case.
      assertNever(event)
  }

  try {
    const level =
      event.kind === 'approval.rejected'
        ? approvalRejectedLevel(event.reason)
        : event.kind === 'push.disabled'
          ? pushDisabledLevel(event.reason)
          : LOG_LEVEL[event.kind]
    if (level === 'warn') {
      logger.warn(ctx, msg)
    } else {
      logger.info(ctx, msg)
    }
  } catch {
    // Swallow sink failures — audit loss is preferable to propagating errors from the log sink.
  }
}
