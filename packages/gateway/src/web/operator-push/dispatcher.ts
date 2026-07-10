/**
 * Orchestrates operator push notification dispatch: approval-pending and
 * run-failed events broadcast to every active subscription across ALL
 * operators, subject to dedupe and key-rotation trigger policy.
 *
 * Broadcast model: the operator dashboard is a shared surface — approvals
 * are run-scoped, not operator-scoped, and there is no dashboard-operator
 * identity available at the run-failed or approval-pending seams. Every
 * opted-in operator with an active subscription is nudged for a pending
 * approval or a failed run, regardless of who launched the run. The payload
 * is repo-neutral ("something needs attention, open the dashboard") so a
 * broadcast leaks no run/repo content.
 *
 * Because dispatch targets every active subscriber rather than one owner,
 * there is no specific operator to re-verify ownership against — this
 * dispatcher does NOT call `store.verifyStillOwned`. (That check remains in
 * the store for the existing per-operator paths.)
 *
 * The dedupe key is keyed by the EVENT identity only (runId-or-approvalId +
 * kind), not per operator, so one event produces at most one nudge per
 * subscription within the window.
 *
 * Fail-soft by design: `dispatchApprovalPending` / `dispatchRunFailed`
 * NEVER throw into the caller. Every dependency call and the whole flow is
 * wrapped so an unexpected failure degrades to a coarse log, not a crash of
 * whatever fire-and-forget call site invoked it.
 *
 * Security invariant: this module never logs the endpoint, subscription
 * keys, VAPID keys, or push payload — only coarse operator/run identifiers
 * and outcome labels.
 *
 * Scale assumption: broadcast sends sequentially to every active
 * subscription. This is sized for the operator-console scale (a small
 * number of authenticated operators), not end-user scale. If the active
 * subscription count grows large, a bounded concurrent fan-out should
 * replace the sequential loop.
 */

import type {OperatorFailureKind} from '../../operator-contract/run-status.js'
import type {DedupeCache} from './dedupe-cache.js'
import type {PushSender} from './push-sender.js'
import type {OperatorPushSubscriptionStore, SubscriptionRecord} from './subscription-store.js'
import type {TriggerDecision} from './trigger-policy.js'
import {buildApprovalPayload, buildFailedRunPayload} from './payload-builder.js'

export interface DispatcherLogger {
  readonly debug: (context: Record<string, unknown>, message: string) => void
  readonly warn: (context: Record<string, unknown>, message: string) => void
}

export interface PushDispatcherVapidConfig {
  readonly subject: string
  readonly publicKey: string
  readonly privateKey: string
  readonly keyVersion: string
  /** Present only during a key-rotation rollout window. */
  readonly previousKeyVersion?: string
}

export interface PushDispatcherTriggerPolicy {
  shouldNotify: (
    record: {readonly keyVersion: string},
    keyVersions: {readonly current: string; readonly previous?: string},
  ) => TriggerDecision
}

export interface CreatePushDispatcherDeps {
  readonly store: Pick<OperatorPushSubscriptionStore, 'listAllActiveRecords' | 'markDead'>
  readonly sender: PushSender
  readonly dedupeCache: DedupeCache
  readonly triggerPolicy: PushDispatcherTriggerPolicy
  readonly vapidConfig: PushDispatcherVapidConfig
  readonly logger: DispatcherLogger
}

export interface PushDispatcher {
  dispatchApprovalPending: (approvalId: string) => Promise<void>
  dispatchRunFailed: (runId: string, failureLabel?: OperatorFailureKind) => Promise<void>
}

export function createPushDispatcher(deps: CreatePushDispatcherDeps): PushDispatcher {
  const {store, sender, dedupeCache, triggerPolicy, vapidConfig, logger} = deps

  async function broadcast(kind: 'approval' | 'run_failed', dedupeId: string, payload: string): Promise<void> {
    const dedupeKey = `${dedupeId}:${kind}`

    // List first: a transient list failure must not consume the dedupe
    // slot, or a retry of the same event within the dedupe window would be
    // silently suppressed with nothing ever sent.
    const activeRecords = await store.listAllActiveRecords()
    if (activeRecords.success === false) {
      logger.warn({kind}, 'operator push dispatch: failed to list active subscriptions')
      return
    }

    if (activeRecords.data.length === 0) {
      // Nothing was sent, so a later retry (once subscriptions exist)
      // should still fire — do not consume the dedupe slot here either.
      return
    }

    if (dedupeCache.shouldSend(dedupeKey) === false) {
      logger.debug({kind}, 'operator push dispatch: suppressed by dedupe window')
      return
    }

    for (const record of activeRecords.data) {
      try {
        await dispatchToRecord(kind, record, payload)
      } catch (error: unknown) {
        // One failing record must never abort dispatch to the rest.
        logger.warn(
          {kind, err: error instanceof Error ? error.message : String(error)},
          'operator push dispatch: one subscription failed — continuing with the rest',
        )
      }
    }
  }

  async function dispatchToRecord(
    kind: 'approval' | 'run_failed',
    record: SubscriptionRecord,
    payload: string,
  ): Promise<void> {
    const decision = triggerPolicy.shouldNotify(record, {
      current: vapidConfig.keyVersion,
      previous: vapidConfig.previousKeyVersion,
    })
    if (decision === 'skip-stale-key') {
      logger.debug({kind}, 'operator push dispatch: skipped stale key version')
      return
    }

    const result = await sender.sendNotification(
      {endpoint: record.endpoint, keys: {p256dh: record.p256dh, auth: record.auth}},
      payload,
      {subject: vapidConfig.subject, publicKey: vapidConfig.publicKey, privateKey: vapidConfig.privateKey},
    )

    switch (result.outcome) {
      case 'accepted': {
        return
      }
      case 'dead-subscription': {
        const marked = await store.markDead({operatorId: record.operatorId, endpoint: record.endpoint})
        if (marked.success === false) {
          logger.warn({kind}, 'operator push dispatch: failed to mark dead subscription')
        }
        return
      }
      case 'retryable':
      case 'payload-too-large':
      case 'error': {
        logger.warn({kind, outcome: result.outcome}, 'operator push dispatch: relay send did not succeed')
        return
      }
      default: {
        // Exhaustiveness guard: if a new PushRelayResult outcome variant is
        // added in push-sender.ts without a case here, TypeScript will fail
        // to compile.
        const exhaustiveCheck: never = result
        throw new Error(`dispatchToRecord: unhandled PushRelayResult outcome variant: ${String(exhaustiveCheck)}`)
      }
    }
  }

  async function dispatchApprovalPending(approvalId: string): Promise<void> {
    try {
      const payload = JSON.stringify(buildApprovalPayload())
      await broadcast('approval', approvalId, payload)
    } catch {
      logger.warn({approvalId}, 'operator push dispatch: approval dispatch threw — continuing')
    }
  }

  async function dispatchRunFailed(runId: string, failureLabel?: OperatorFailureKind): Promise<void> {
    try {
      const payload = JSON.stringify(buildFailedRunPayload(failureLabel))
      await broadcast('run_failed', runId, payload)
    } catch {
      logger.warn({runId}, 'operator push dispatch: run-failed dispatch threw — continuing')
    }
  }

  return {dispatchApprovalPending, dispatchRunFailed}
}
