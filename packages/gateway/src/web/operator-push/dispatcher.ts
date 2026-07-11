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
import type {AuditLogger} from '../audit.js'
import type {DedupeCache} from './dedupe-cache.js'
import type {PushSender} from './push-sender.js'
import type {OperatorPushSubscriptionStore, SubscriptionRecord} from './subscription-store.js'
import type {TriggerDecision} from './trigger-policy.js'
import {emitAudit} from '../audit.js'
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
  /** Audit logger — one coarse push.dispatch summary event is emitted per broadcast. */
  readonly auditLogger: AuditLogger
}

export interface PushDispatcher {
  dispatchApprovalPending: (approvalId: string) => Promise<void>
  dispatchRunFailed: (runId: string, failureLabel?: OperatorFailureKind) => Promise<void>
}

export function createPushDispatcher(deps: CreatePushDispatcherDeps): PushDispatcher {
  const {store, sender, dedupeCache, triggerPolicy, vapidConfig, logger, auditLogger} = deps

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
      // No dispatch audit event either: nothing was dispatched.
      return
    }

    if (dedupeCache.shouldSend(dedupeKey) === false) {
      logger.debug({kind}, 'operator push dispatch: suppressed by dedupe window')
      // No dispatch audit event: suppressed, nothing was dispatched.
      return
    }

    // Coarse per-broadcast tally for the push.dispatch audit event. Dead
    // subscriptions are counted here and covered by this single summary —
    // markDead is NOT separately audited per record, which would be
    // per-endpoint noise (see markDead's dead-subscription branch below).
    let delivered = 0
    let dead = 0
    let failed = 0

    for (const record of activeRecords.data) {
      try {
        const outcome = await dispatchToRecord(kind, record, payload)
        switch (outcome) {
          case 'delivered':
            delivered += 1
            break
          case 'dead':
            dead += 1
            break
          case 'failed':
            failed += 1
            break
          case 'skipped':
            break
          default: {
            // Exhaustiveness guard: if a new dispatchToRecord outcome
            // variant is added without a case here, TypeScript will fail
            // to compile.
            const exhaustiveCheck: never = outcome
            throw new Error(`broadcast: unhandled dispatchToRecord outcome variant: ${String(exhaustiveCheck)}`)
          }
        }
      } catch (error: unknown) {
        // One failing record must never abort dispatch to the rest.
        failed += 1
        logger.warn(
          {kind, err: error instanceof Error ? error.message : String(error)},
          'operator push dispatch: one subscription failed — continuing with the rest',
        )
      }
    }

    // Emitted once per broadcast that reached the send loop. A record set
    // entirely filtered by stale-key (e.g. during a VAPID rotation window)
    // still records a {delivered:0, dead:0, failed:0} event — that a broadcast
    // ran with no wire sends is itself worth an audit trail, and it is
    // unambiguous: the empty-list and dedupe-suppressed paths return before
    // this point, so a zero-count event can only mean "all subscribers were
    // skipped".
    emitAudit({kind: 'push.dispatch', correlationId: dedupeId, trigger: kind, delivered, dead, failed}, auditLogger)
  }

  async function dispatchToRecord(
    kind: 'approval' | 'run_failed',
    record: SubscriptionRecord,
    payload: string,
  ): Promise<'delivered' | 'dead' | 'failed' | 'skipped'> {
    const decision = triggerPolicy.shouldNotify(record, {
      current: vapidConfig.keyVersion,
      previous: vapidConfig.previousKeyVersion,
    })
    if (decision === 'skip-stale-key') {
      logger.debug({kind}, 'operator push dispatch: skipped stale key version')
      return 'skipped'
    }

    const result = await sender.sendNotification(
      {endpoint: record.endpoint, keys: {p256dh: record.p256dh, auth: record.auth}},
      payload,
      {subject: vapidConfig.subject, publicKey: vapidConfig.publicKey, privateKey: vapidConfig.privateKey},
    )

    switch (result.outcome) {
      case 'accepted': {
        return 'delivered'
      }
      case 'dead-subscription': {
        const marked = await store.markDead({operatorId: record.operatorId, endpoint: record.endpoint})
        if (marked.success === false) {
          logger.warn({kind}, 'operator push dispatch: failed to mark dead subscription')
        }
        // Counted in the broadcast's coarse 'dead' tally — not separately
        // audited per record; a per-record deactivation event would leak
        // per-endpoint dispatch cadence. See push.subscription.deactivated
        // usage at the session-revoke site for the one case that IS audited
        // individually.
        return 'dead'
      }
      case 'retryable':
      case 'payload-too-large':
      case 'error': {
        logger.warn({kind, outcome: result.outcome}, 'operator push dispatch: relay send did not succeed')
        return 'failed'
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
