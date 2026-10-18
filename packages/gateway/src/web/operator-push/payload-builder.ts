/**
 * Pure builders for the operator push notification payloads (approval, question, run failed).
 *
 * Security invariant: the returned payload NEVER carries repo, prompt,
 * tool name, command, approval or question content, run output, endpoint,
 * keys, tokens, cookies, CSRF token, idempotency key, session id, or a raw
 * (unmapped) failure kind. Every value in the payload is a fixed i18n copy
 * key, a member of a closed, operator-safe allowlist (`OperatorFailureKind`),
 * or the run ID of an approval or question push. The run ID is the only
 * dynamic value: an opaque identifier inside an encrypted payload, admitted
 * only if it passes `RUN_ID_PATTERN`. The copy stays fixed — never a
 * free-form passthrough from internal state.
 */

import type {OperatorPushTriggerKind} from '../../operator-contract/responses.js'
import type {OperatorFailureKind} from '../../operator-contract/run-status.js'

export interface PushPayloadData {
  readonly type: OperatorPushTriggerKind
  readonly route: string
  readonly runId?: string
  readonly failureLabel?: OperatorFailureKind
}

export interface PushPayload {
  readonly title: string
  readonly body: string
  readonly data: PushPayloadData
}

/**
 * Closed allowlist of failure labels safe to surface in a push payload.
 *
 * `satisfies readonly OperatorFailureKind[]` only checks that each entry is a
 * valid OperatorFailureKind. It does NOT require every kind to be listed:
 * adding a kind in run-status.ts compiles without an entry here, and that kind
 * then falls back to generic push copy (see `checkout-substituted`,
 * `workspace-unavailable`).
 */
const KNOWN_SAFE_FAILURE_LABELS_LIST = [
  'inactivity-timeout',
  'max-duration-timeout',
  'stream-ended',
  'workspace-unreachable',
  'session-error',
  'unknown',
] satisfies readonly OperatorFailureKind[]

const KNOWN_SAFE_FAILURE_LABELS: ReadonlySet<OperatorFailureKind> = new Set(KNOWN_SAFE_FAILURE_LABELS_LIST)

function isKnownSafeFailureLabel(value: string | undefined): value is OperatorFailureKind {
  if (value === undefined) return false
  return KNOWN_SAFE_FAILURE_LABELS.has(value as OperatorFailureKind)
}

/** Run IDs admitted into a push route: UUIDs and other short URL-safe identifiers (`\w` is ASCII-only here). */
const RUN_ID_PATTERN = /^[\w-]{1,128}$/

/**
 * Builds the fixed-copy payload for an approval-needed notification. The run ID deep-links to
 * `/operator#<runId>` only when it matches `RUN_ID_PATTERN`; anything else routes to `/` with no
 * `runId`. The tool name, command, repo and prompt must never reach a push payload.
 *
 * The link opens the waiting run's card. A web-scope approval can be decided there; a Discord-scope
 * approval registers under the thread ID, so the card shows the run waiting and the decision stays
 * in Discord — the same deep link a question push gives today.
 */
export function buildApprovalPayload(runId: string): PushPayload {
  return {
    title: 'operator.approval_needed.title',
    body: 'operator.approval_needed.body',
    data: RUN_ID_PATTERN.test(runId)
      ? {type: 'approval', route: `/operator#${encodeURIComponent(runId)}`, runId}
      : {type: 'approval', route: '/'},
  }
}

/**
 * Builds the fixed-copy payload for an agent-question notification. The run ID
 * deep-links to `/operator#<runId>` only when it matches `RUN_ID_PATTERN`;
 * anything else routes to `/` with no `runId`. Question text, options, repo,
 * and prompt must never reach a push payload.
 */
export function buildQuestionPayload(runId: string): PushPayload {
  return {
    title: 'operator.question_pending.title',
    body: 'operator.question_pending.body',
    data: RUN_ID_PATTERN.test(runId)
      ? {type: 'question', route: `/operator#${encodeURIComponent(runId)}`, runId}
      : {type: 'question', route: '/'},
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
