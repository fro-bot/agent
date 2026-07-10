/**
 * Pure builders for the two operator push notification payloads.
 *
 * Security invariant: the returned payload NEVER carries repo, prompt,
 * command, run output, endpoint, keys, tokens, cookies, CSRF token,
 * idempotency key, session id, or a raw (unmapped) failure kind. Every
 * value in the payload is a fixed i18n copy key or a member of a closed,
 * operator-safe allowlist (`OperatorFailureKind`) — never a free-form
 * passthrough from internal state.
 */

import type {OperatorFailureKind} from '../../operator-contract/run-status.js'

export interface PushPayloadData {
  readonly type: 'approval' | 'run_failed'
  readonly route: string
  readonly failureLabel?: OperatorFailureKind
}

export interface PushPayload {
  readonly title: string
  readonly body: string
  readonly data: PushPayloadData
}

/** Closed allowlist of failure labels safe to surface in a push payload — mirrors OperatorFailureKind. */
const KNOWN_SAFE_FAILURE_LABELS: ReadonlySet<OperatorFailureKind> = new Set([
  'inactivity-timeout',
  'max-duration-timeout',
  'stream-ended',
  'workspace-unreachable',
  'session-error',
  'unknown',
])

function isKnownSafeFailureLabel(value: string | undefined): value is OperatorFailureKind {
  if (value === undefined) return false
  return KNOWN_SAFE_FAILURE_LABELS.has(value as OperatorFailureKind)
}

/** Builds the fixed-copy payload for an approval-needed notification. */
export function buildApprovalPayload(): PushPayload {
  return {
    title: 'operator.approval_needed.title',
    body: 'operator.approval_needed.body',
    data: {type: 'approval', route: '/'},
  }
}

/**
 * Builds the fixed-copy payload for a run-failed notification.
 *
 * `failureLabel` is only included when it is a member of the closed
 * `OperatorFailureKind` allowlist — an unknown or absent label collapses to
 * generic copy with no `failureLabel` key, never a raw internal kind.
 */
export function buildFailedRunPayload(failureLabel?: string): PushPayload {
  const safeLabel = isKnownSafeFailureLabel(failureLabel) ? failureLabel : undefined
  return {
    title: 'operator.run_failed.title',
    body: 'operator.run_failed.body',
    data: {
      type: 'run_failed',
      route: '/',
      ...(safeLabel === undefined ? {} : {failureLabel: safeLabel}),
    },
  }
}
