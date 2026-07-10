/**
 * Orchestrates operator push notification dispatch: approval-pending and
 * run-failed events fan out to every active subscription owned by the
 * target operator, subject to dedupe, key-rotation trigger policy, and a
 * linearizable re-verification of ownership immediately before each send.
 *
 * Fail-soft by design: `dispatchApprovalPending` / `dispatchRunFailed`
 * NEVER throw into the caller. Every dependency call and the whole flow is
 * wrapped so an unexpected failure degrades to a coarse log, not a crash of
 * whatever fire-and-forget call site invoked it.
 *
 * Dispatch-vs-transfer linearizability: `store.getActiveRecordsForOperator`
 * returns a point-in-time snapshot. Because ownership can transfer to a
 * different operator (or the subscription can be tombstoned) between that
 * read and the moment a notification is actually sent, this dispatcher
 * calls `store.verifyStillOwned` immediately before each send. If the
 * generation has moved on, or the record is no longer active or no longer
 * owned by the same operator, the send is skipped. This narrows the
 * delivery-to-wrong-owner window to the async gap between the ownership
 * re-check and the actual relay request — not zero, but bounded to a single
 * I/O hop; a transfer landing inside that window is additionally caught by
 * the relay returning 410 for the transferred-away subscription.
 *
 * Security invariant: this module never logs the endpoint, subscription
 * keys, VAPID keys, or push payload — only coarse operator/run identifiers
 * and outcome labels.
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
  readonly store: Pick<OperatorPushSubscriptionStore, 'getActiveRecordsForOperator' | 'verifyStillOwned' | 'markDead'>
  readonly sender: PushSender
  readonly dedupeCache: DedupeCache
  readonly triggerPolicy: PushDispatcherTriggerPolicy
  readonly vapidConfig: PushDispatcherVapidConfig
  readonly logger: DispatcherLogger
}

export interface PushDispatcher {
  dispatchApprovalPending: (operatorId: string, approvalId: string) => Promise<void>
  dispatchRunFailed: (operatorId: string, runId: string, failureLabel?: OperatorFailureKind) => Promise<void>
}

export function createPushDispatcher(deps: CreatePushDispatcherDeps): PushDispatcher {
  const {store, sender, dedupeCache, triggerPolicy, vapidConfig, logger} = deps

  async function dispatchToOperator(
    kind: 'approval' | 'run_failed',
    operatorId: string,
    dedupeId: string,
    payload: string,
  ): Promise<void> {
    const dedupeKey = `${operatorId}:${dedupeId}:${kind}`
    if (dedupeCache.shouldSend(dedupeKey) === false) {
      logger.debug({operatorId, kind}, 'operator push dispatch: suppressed by dedupe window')
      return
    }

    const activeRecords = await store.getActiveRecordsForOperator({operatorId})
    if (activeRecords.success === false) {
      logger.warn({operatorId, kind}, 'operator push dispatch: failed to list active subscriptions')
      return
    }

    for (const record of activeRecords.data) {
      try {
        await dispatchToRecord(kind, operatorId, record, payload)
      } catch (error: unknown) {
        // One failing record must never abort dispatch to the rest.
        logger.warn(
          {operatorId, kind, err: error instanceof Error ? error.message : String(error)},
          'operator push dispatch: one subscription failed — continuing with the rest',
        )
      }
    }
  }

  async function dispatchToRecord(
    kind: 'approval' | 'run_failed',
    operatorId: string,
    record: SubscriptionRecord,
    payload: string,
  ): Promise<void> {
    const decision = triggerPolicy.shouldNotify(record, {
      current: vapidConfig.keyVersion,
      previous: vapidConfig.previousKeyVersion,
    })
    if (decision === 'skip-stale-key') {
      logger.debug({operatorId, kind}, 'operator push dispatch: skipped stale key version')
      return
    }

    // Re-verify ownership immediately before send — closes the window
    // between the snapshot read above and this send (see module docstring).
    const verified = await store.verifyStillOwned({
      endpointHash: record.endpointHash,
      operatorId,
      ownershipGeneration: record.ownershipGeneration,
    })
    if (verified.success === false) {
      logger.warn({operatorId, kind}, 'operator push dispatch: ownership re-verification failed')
      return
    }
    if (verified.data === false) {
      logger.debug({operatorId, kind}, 'operator push dispatch: skipped — ownership changed since listing')
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
        const marked = await store.markDead({operatorId, endpoint: record.endpoint})
        if (marked.success === false) {
          logger.warn({operatorId, kind}, 'operator push dispatch: failed to mark dead subscription')
        }
        return
      }
      case 'retryable':
      case 'payload-too-large':
      case 'error': {
        logger.warn({operatorId, kind, outcome: result.outcome}, 'operator push dispatch: relay send did not succeed')
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

  async function dispatchApprovalPending(operatorId: string, approvalId: string): Promise<void> {
    try {
      const payload = JSON.stringify(buildApprovalPayload())
      await dispatchToOperator('approval', operatorId, approvalId, payload)
    } catch {
      logger.warn({operatorId}, 'operator push dispatch: approval dispatch threw — continuing')
    }
  }

  async function dispatchRunFailed(
    operatorId: string,
    runId: string,
    failureLabel?: OperatorFailureKind,
  ): Promise<void> {
    try {
      const payload = JSON.stringify(buildFailedRunPayload(failureLabel))
      await dispatchToOperator('run_failed', operatorId, runId, payload)
    } catch {
      logger.warn({operatorId}, 'operator push dispatch: run-failed dispatch threw — continuing')
    }
  }

  return {dispatchApprovalPending, dispatchRunFailed}
}
