/**
 * Drain-completion gate for a gateway run that adopted background work, on OpenCode V2: the sibling of
 * `drain-completion.ts`.
 *
 * Why it exists is unchanged. A background child finishes, the server queues a notice for the PARENT, and the parent
 * runs again to take it in (probe P2: `started, succeeded, started, succeeded` about 0.8 s apart). So the first root
 * idle after a dispatch is not terminal, and a settled ledger alone is not completion.
 *
 * What differs is the evidence. V1 had to reconstruct the root's state from REST message lists. V2 publishes the root's
 * executions on the stream (`session.execution.started` / `succeeded`) and says when a queued inbox item enters a turn
 * (`session.inbox.delivered`), so the gate keeps that state itself. Success is admitted only when ALL of these hold at one
 * commit point:
 * - the ledger reports drain-complete (`unknown` still blocks, exactly as before);
 * - every queued notice has been delivered into a root turn;
 * - the root idle evidence is current-generation: no root activity (an execution starting, text, a tool) and no new
 *   notice since the root's last `execution.succeeded`, which is how "idle after the last turn a notice triggered" reads
 *   on this stream;
 * - the active list shows the root is not live;
 * - the DIRECTORY has stayed quiet for the stability window (`directory-quiescence-v2.ts`): no session located in it is
 *   active, no shell of it is running, no session of this run (the root, what it owns, and what was updated since it
 *   began) has a queued inbox item, for 11 consecutive readings 500 ms apart.
 *   This is what the run is released on. The ledger and the notices cannot prove that no producer is mid-way between
 *   admitting a notice and waking its session, and a session an adopted child's shell wakes later is not on the stream
 *   either; the directory shows both. So the gate does not wait for a notice per entity: a child or shell the ledger
 *   settled is covered by the directory, whether or not its notice was seen. Activity does not fail the run: the gate keeps
 *   reading until the directory is quiet or the run's deadline ends it;
 * - the revision captured before that wait still equals the current one.
 *
 * The reads happen BEFORE the commit point, like the liveness read, so the commit stays one synchronous block. Root
 * activity or a new notice during the wait ends it and drops the readings taken so far: they described the old evidence.
 *
 * Whatever never becomes quiet never admits: the run's hard deadline reports it incomplete. The stream is trusted as the
 * run's own record: a stream that is lost fails the run through the barrier, so a stream that is delivering is complete.
 * That is why no reply-delivery fence is needed: the follow-up turn's text arrives before its `execution.succeeded`.
 *
 * Not a state machine framework: a revision counter, an idle stamp, the notices seen, and one validation in flight.
 */

import type {
  DirectoryStabilityGate,
  LedgerReconcileAdapter,
  OwnershipLedger,
  ShellNoticeState,
  SubagentNotice,
} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {DrainRejectCode} from './drain-completion.js'

import {
  awaitDirectoryStability,
  DIRECTORY_QUIESCENCE_MIN_SPACING_MS,
  shellLedgerKey,
  toErrorMessage,
} from '@fro-bot/runtime'
import {DRAIN_REQUEST_TIMEOUT_MS, DRAIN_VALIDATION_INTERVAL_MS} from './drain-completion.js'

type BoundedResult<T> = {readonly ok: true; readonly value: T} | {readonly ok: false}

export interface DrainCompletionV2Options {
  readonly rootSessionId: string
  readonly ledger: OwnershipLedger
  /** Global liveness: the V2 reconcile adapter's `liveSessionIds`. */
  readonly adapter: LedgerReconcileAdapter
  /**
   * The directory's stability gate (`createDirectoryStabilityGate` over `observeDirectoryV2`). Read BEFORE the commit
   * point; the gate's streak is dropped whenever the evidence it was waiting on changes.
   */
  readonly directoryGate: DirectoryStabilityGate
  /** Time between directory readings. Defaults to `DIRECTORY_QUIESCENCE_MIN_SPACING_MS`. */
  readonly directorySpacingMs?: number
  /** The run's combined signal: deadline, inactivity, cancel. Aborting it ends validation. */
  readonly signal: AbortSignal
  readonly logger: GatewayLogger
  /** Called at most once, only for an admitted completion. */
  readonly onAdmitted: () => void
  /** Called with the code of every declined admission attempt, so the run can show why it has not finished. */
  readonly onNotAdmitted?: (code: DrainRejectCode) => void
  readonly validationIntervalMs?: number
  readonly requestTimeoutMs?: number
}

export interface DrainCompletionV2 {
  /** Root execution started, text, tool or reasoning activity: invalidates current idle evidence. */
  readonly noteRootActivity: () => void
  /**
   * A completion notice for one of the root's children. `inboxId` is the inbox item carrying it, or `null` when the
   * notice is already a transcript message. Deduped by child and state. Invalidates idle evidence.
   */
  readonly noteNotice: (notice: SubagentNotice, inboxId: string | null) => void
  /**
   * A notice about a child or a shell arrived and could not be read. It invalidates idle evidence; the ledger entry (the
   * caller marks it `unknown`) still blocks admission until it is seen to stop.
   */
  readonly noteUnreadableNotice: () => void
  /**
   * A completion notice for one of the root's background shells, with the same meaning as `noteNotice`. A shell is
   * waited on exactly like a child: its notice wakes the root, so the first idle after it is not terminal. Deduped by
   * shell and state. Invalidates idle evidence.
   */
  readonly noteShellNotice: (shellId: string, state: ShellNoticeState, inboxId: string | null) => void
  /** A queued inbox item entered a turn of an owned session. */
  readonly noteInboxDelivered: (inboxId: string) => void
  /** The root's execution succeeded: stamps the current revision, unless a notice is still queued. */
  readonly noteRootIdle: () => void
  /** The run entered drain: validation passes may now run, retried on the interval. */
  readonly beginDrain: () => void
  /** Ask for a validation pass. Never completes anything itself; coalesced to one in flight. */
  readonly requestValidation: () => void
  readonly dispose: () => void
}

interface NoticeRecord {
  inboxId: string | null
  delivered: boolean
}

export function createDrainCompletionV2(options: DrainCompletionV2Options): DrainCompletionV2 {
  const {
    rootSessionId,
    ledger,
    adapter,
    signal,
    logger,
    onAdmitted,
    onNotAdmitted,
    directoryGate,
    directorySpacingMs = DIRECTORY_QUIESCENCE_MIN_SPACING_MS,
    validationIntervalMs = DRAIN_VALIDATION_INTERVAL_MS,
    requestTimeoutMs = DRAIN_REQUEST_TIMEOUT_MS,
  } = options

  let closed = false
  // Aborted on dispose so a request still in flight when the run exits stops, and its cap timer is cleared.
  const lifecycle = new AbortController()
  let draining = false
  let inFlight = false
  let rerunRequested = false
  let retryTimer: ReturnType<typeof setInterval> | undefined

  // Generation counter: bumped by any root activity or notice. Idle evidence stamped with an older revision is stale.
  let revision = 0
  let idleRevision: number | null = null
  const notices = new Map<string, NoticeRecord>()

  function invalidate(): void {
    revision += 1
    idleRevision = null
  }

  function queuedNotices(): number {
    let queued = 0
    for (const record of notices.values()) if (!record.delivered) queued += 1
    return queued
  }

  function noteRootActivity(): void {
    if (closed) return
    invalidate()
  }

  // Notices are keyed by ledger key, so a child and a shell can never stand in for each other.
  function recordNotice(ledgerKey: string, state: string, inboxId: string | null): void {
    if (closed) return
    const key = `${ledgerKey}:${state}`
    const existing = notices.get(key)
    if (existing === undefined) {
      // A queued item is not in a turn yet; a transcript message already is.
      notices.set(key, {inboxId, delivered: inboxId === null})
      invalidate()
    } else if (existing.inboxId === null && inboxId !== null && !existing.delivered) {
      existing.inboxId = inboxId
    }
    requestValidation()
  }

  function noteNotice(notice: SubagentNotice, inboxId: string | null): void {
    recordNotice(notice.childSessionId, notice.state, inboxId)
  }

  function noteShellNotice(shellId: string, state: ShellNoticeState, inboxId: string | null): void {
    recordNotice(shellLedgerKey(shellId), state, inboxId)
  }

  function noteUnreadableNotice(): void {
    if (closed) return
    invalidate()
    requestValidation()
  }

  function noteInboxDelivered(inboxId: string): void {
    if (closed) return
    for (const record of notices.values()) {
      if (record.inboxId === inboxId && !record.delivered) {
        record.delivered = true
        invalidate()
      }
    }
  }

  function noteRootIdle(): void {
    if (closed) return
    // A queued notice means a turn is still owed: this idle ended a turn that did not take it in.
    if (queuedNotices() > 0) return
    idleRevision = revision
  }

  /**
   * Run one request bounded by the run signal, dispose, and a hard cap. Never rejects; a hung, failed, or aborted
   * request is `{ok: false}` so the caller treats it as "no evidence", never as success.
   *
   * The signal is a plain controller fed by listeners that are ALL removed in `finally`, not an `AbortSignal.any`
   * composite: a composite stays registered on its parents until garbage collection, so retries would accumulate on
   * the long-lived run and lifecycle signals.
   */
  async function bounded<T>(request: (requestSignal: AbortSignal) => Promise<T>): Promise<BoundedResult<T>> {
    if (signal.aborted || lifecycle.signal.aborted) return {ok: false}
    const requestController = new AbortController()
    const abortRequest = (): void => {
      requestController.abort()
    }
    signal.addEventListener('abort', abortRequest, {once: true})
    lifecycle.signal.addEventListener('abort', abortRequest, {once: true})
    const capTimer = setTimeout(abortRequest, requestTimeoutMs)
    const abandoned = new Promise<BoundedResult<T>>(resolve => {
      requestController.signal.addEventListener('abort', () => resolve({ok: false}), {once: true})
    })
    try {
      return await Promise.race([
        request(requestController.signal).then(
          (value): BoundedResult<T> => ({ok: true, value}),
          (): BoundedResult<T> => ({ok: false}),
        ),
        abandoned,
      ])
    } finally {
      clearTimeout(capTimer)
      signal.removeEventListener('abort', abortRequest)
      lifecycle.signal.removeEventListener('abort', abortRequest)
    }
  }

  async function rootIsLive(): Promise<boolean | null> {
    const result = await bounded(async requestSignal => adapter.liveSessionIds(requestSignal))
    if (!result.ok || !result.value.success) return null
    return result.value.data.has(rootSessionId)
  }

  function reject(reason: DrainRejectCode, context: Record<string, unknown> = {}): void {
    logger.debug({sessionId: rootSessionId, reason, ...context}, 'run-core: drain completion not admitted')
    onNotAdmitted?.(reason)
  }

  async function validate(): Promise<void> {
    // Captured before the request: renewed root activity while it is in flight invalidates whatever it describes.
    const requestedRevision = revision

    const live = await rootIsLive()
    if (closed || signal.aborted) return

    if (live === null) return reject('root-liveness-unavailable')
    if (live) return reject('root-live')

    // Wait for the directory to stay quiet. Read here, before the commit point: nothing may be awaited after it. The
    // wait ends early if the evidence it is for changes, and its readings are dropped with it.
    const waitController = new AbortController()
    const abortWait = (): void => waitController.abort()
    signal.addEventListener('abort', abortWait, {once: true})
    lifecycle.signal.addEventListener('abort', abortWait, {once: true})
    let stable: Awaited<ReturnType<typeof awaitDirectoryStability>>
    try {
      stable = await awaitDirectoryStability({
        gate: directoryGate,
        signal: waitController.signal,
        spacingMs: directorySpacingMs,
        shouldContinue: () =>
          !closed &&
          !signal.aborted &&
          revision === requestedRevision &&
          idleRevision === revision &&
          ledger.isDrainComplete(),
        onObservation: state => {
          // Why the run has not finished yet, for the operator status.
          if (state.last?.kind === 'unreadable') reject('root-liveness-unavailable', {read: state.last.reason})
          else if (!state.passed) {
            reject('ledger-not-drained', {
              directory: state.last?.kind === 'active' ? state.last.activity : 'quiet',
              quietReadings: state.streak,
            })
          }
        },
      })
    } finally {
      signal.removeEventListener('abort', abortWait)
      lifecycle.signal.removeEventListener('abort', abortWait)
    }
    if (closed || signal.aborted) return
    if (!stable.passed) {
      if (revision !== requestedRevision) return reject('revision-drift')
      return reject('idle-evidence-stale')
    }

    // Commit point — nothing awaited between here and `onAdmitted`.
    if (revision !== requestedRevision) return reject('revision-drift')
    if (idleRevision === null || idleRevision !== revision) return reject('idle-evidence-stale')
    if (!ledger.isDrainComplete()) return reject('ledger-not-drained')

    closed = true
    onAdmitted()
  }

  function requestValidation(): void {
    if (closed || !draining || signal.aborted) return
    if (inFlight) {
      rerunRequested = true
      return
    }
    // Nothing to validate without a drained ledger and current-generation root idle evidence. Each skip still names
    // its blocker, so the run's wait reason follows the run instead of staying empty or frozen on an earlier code.
    if (!ledger.isDrainComplete()) {
      onNotAdmitted?.('ledger-not-drained')
      return
    }
    if (idleRevision === null || idleRevision !== revision) {
      onNotAdmitted?.('idle-evidence-stale')
      return
    }
    inFlight = true
    rerunRequested = false
    validate()
      .catch((error: unknown) => {
        reject('validation-threw', {detail: toErrorMessage(error)})
      })
      .finally(() => {
        inFlight = false
        if (rerunRequested) requestValidation()
      })
  }

  function beginDrain(): void {
    if (closed || draining) return
    draining = true
    retryTimer = setInterval(requestValidation, validationIntervalMs)
  }

  function dispose(): void {
    closed = true
    lifecycle.abort()
    if (retryTimer !== undefined) clearInterval(retryTimer)
    retryTimer = undefined
  }

  return {
    noteRootActivity,
    noteNotice,
    noteUnreadableNotice,
    noteShellNotice,
    noteInboxDelivered,
    noteRootIdle,
    beginDrain,
    requestValidation,
    dispose,
  }
}
