/**
 * Transport-neutral run-cancellation orchestrator.
 *
 * `cancelRun(params, deps)` resolves a run's current phase and executes the
 * correct cancellation path:
 *
 *  - **Queued** (PENDING/ACKNOWLEDGED, in the per-channel FIFO): removed via
 *    `queue.removeBy`, terminalized directly (no lock/slot held — nothing to
 *    release).
 *  - **Executing** (abort-registry hit): pending approvals for the run's scope
 *    are rejected through the single fail-closed settlement gate
 *    (`registry.handleDecision`), then the abort handle fires. Unit 1's error
 *    path in `run.ts` owns the CANCELLED transition and resource release.
 *  - **Pre-ACK rendezvous** (double miss — the registration window between
 *    dequeue and abort-registry registration): a direct conditional-write
 *    `transitionRun(currentPhase → CANCELLED)` IS the rendezvous. Either the
 *    cancel wins (the run's own next transition 412s, re-reads, sees
 *    CANCELLED, exits cleanly) or the run advances first (this call 412s,
 *    re-reads, and resolves via a single bounded retry — see
 *    `attemptRendezvousCancel` below).
 *
 * Already-terminal runs are idempotent no-ops (read-then-short-circuit —
 * `transitionRun` rejects terminal transitions by design, so the orchestrator
 * never attempts one). Unknown runIds resolve to `not-found`.
 *
 * The Discord thread notice is always fail-soft: notice failure never fails
 * the cancellation outcome, only logs.
 */

import type {CoordinationConfig, RunPhase, RunState} from '@fro-bot/runtime'
import type {Client} from 'discord.js'
import type {ApprovalActor, ApprovalRegistry} from '../approvals/registry.js'
import type {GatewayLogger} from '../discord/client.js'
import type {AbortRegistry} from './abort-registry.js'
import type {ChannelQueue} from './queue.js'
import type {RunIndex} from './run-index.js'
import type {RunTask} from './run.js'

import {getRunKey, parseRunState, transitionRun} from '@fro-bot/runtime'
import {sendMessage} from '../discord/io.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal, readonly actor-attribution shape accepted by `cancelRun`.
 *
 * Structurally compatible with `OperatorIdentity`/`WebOperatorActor` — the
 * Unit 3 web route passes those fields directly. Kept as its own type here so
 * `cancel.ts` (execute-layer, transport-neutral) does not import the web
 * operator-contract module.
 */
export interface CancelActorContext {
  readonly githubUserId: number
  readonly login: string
  readonly sessionCorrelationId: string
}

export type CancelOutcome =
  | {readonly outcome: 'not-found'}
  | {readonly outcome: 'already-terminal'; readonly phase: RunPhase}
  | {readonly outcome: 'cancelled'; readonly wasQueued: boolean}
  /**
   * The bounded rendezvous retry (see `attemptRendezvousCancel`) was
   * exhausted without resolving to a terminal outcome — the run advanced to
   * EXECUTING on every observed attempt. The caller should treat this as
   * "cancel not yet applied, safe to retry" rather than a failure.
   */
  | {readonly outcome: 'retry'}

export interface CancelRunParams {
  readonly runId: string
  readonly actor: CancelActorContext
  readonly logger: GatewayLogger
}

export interface CancelRunDeps {
  readonly coordinationConfig: CoordinationConfig
  readonly identity: string
  readonly runIndex: Pick<RunIndex, 'lookup'>
  readonly queue: ChannelQueue<RunTask>
  readonly abortRegistry: Pick<AbortRegistry, 'has' | 'abort'>
  readonly approvalRegistry: Pick<ApprovalRegistry, 'describePendingForScope' | 'handleDecision'>
  readonly discordClient: Pick<Client, 'channels'>
  readonly runObserver?: {readonly observe: (runState: RunState) => Promise<void>}
  /** Wall-clock provider — injectable for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Bounded strategy for the pre-ACK rendezvous retry: a single retry after the
 * first 412 resolves to EXECUTING. One retry is sufficient because the
 * registration window (dequeue → abort-registry registration) is short and
 * bounded by the pipeline's own gates (ensureClone/readyz/threadFactory/lock);
 * a run cannot cycle between "not yet registered" and "EXECUTING" more than
 * once within that window. Exceeding the bound returns `{outcome:'retry'}`
 * rather than looping unboundedly — the caller (a future web route) can
 * safely re-issue the cancel request.
 */
const RENDEZVOUS_MAX_ATTEMPTS = 2

const CANCELLED_NOTICE_TEXT = 'Run cancelled by operator.'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RunStateRead {
  readonly state: RunState
  readonly etag: string
}

/** Read the current run-state for `repo`/`runId`. Returns `undefined` on any read/parse failure. */
async function readRunState(
  deps: CancelRunDeps,
  repo: string,
  runId: string,
  logger: GatewayLogger,
): Promise<RunStateRead | undefined> {
  const {coordinationConfig, identity} = deps
  const keyResult = getRunKey(coordinationConfig, identity, repo, runId)
  if (keyResult.success === false) {
    logger.warn({repo, runId, err: keyResult.error.message}, 'cancelRun: getRunKey failed')
    return undefined
  }
  const getObject = coordinationConfig.storeAdapter.getObject
  if (getObject == null) {
    logger.warn({repo, runId}, 'cancelRun: store adapter does not support getObject')
    return undefined
  }
  const fetched = await getObject(keyResult.data)
  if (fetched.success === false) {
    logger.warn({repo, runId, err: fetched.error.message}, 'cancelRun: getObject failed')
    return undefined
  }
  const parsed = parseRunState(fetched.data.data)
  if (parsed.success === false) {
    logger.warn({repo, runId, err: parsed.error.message}, 'cancelRun: parseRunState failed')
    return undefined
  }
  return {state: parsed.data, etag: fetched.data.etag}
}

const TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set(['COMPLETED', 'FAILED', 'CANCELLED'])

function isTerminalPhase(phase: RunPhase): boolean {
  return TERMINAL_PHASES.has(phase)
}

/** Fire-and-forget SSE observer notification — mirrors run.ts's notifyObserverBestEffort. */
function notifyObserverBestEffort(deps: CancelRunDeps, state: RunState, logger: GatewayLogger): void {
  try {
    deps.runObserver?.observe(state)?.catch((error: unknown) => {
      logger.warn({err: String(error)}, 'cancelRun: runObserver.observe failed')
    })
  } catch (error: unknown) {
    logger.warn({err: String(error)}, 'cancelRun: runObserver.observe threw synchronously')
  }
}

/**
 * Post the thread cancellation notice. Always fail-soft: never throws, and
 * failure is logged, not propagated — the cancellation outcome does not
 * depend on this succeeding. Skips (logs) when `thread_id` is absent.
 */
async function postCancellationNotice(
  deps: CancelRunDeps,
  runId: string,
  threadId: string,
  logger: GatewayLogger,
): Promise<void> {
  if (threadId === '') {
    logger.info({runId}, 'cancelRun: no thread_id on run-state — skipping cancellation notice')
    return
  }
  try {
    const channel = await deps.discordClient.channels.fetch(threadId)
    if (channel === null || channel === undefined) {
      logger.warn({runId, threadId}, 'cancelRun: thread channel not found — skipping cancellation notice')
      return
    }
    if (channel.isTextBased() === false || 'send' in channel === false) {
      logger.warn({runId, threadId}, 'cancelRun: resolved channel is not text-sendable — skipping cancellation notice')
      return
    }
    const sendResult = await sendMessage(channel, {content: CANCELLED_NOTICE_TEXT}, logger)
    if (sendResult.success === false) {
      logger.warn({runId, threadId, err: sendResult.error.message}, 'cancelRun: cancellation notice send failed')
    }
  } catch (error: unknown) {
    // sendMessage/io.ts never throws, but channels.fetch can — belt-and-suspenders.
    logger.warn(
      {runId, threadId, err: error instanceof Error ? error.message : String(error)},
      'cancelRun: cancellation notice threw — continuing',
    )
  }
}

/**
 * Settle every pending approval for the run's scope via the single fail-closed
 * gate (`registry.handleDecision`), rejecting each. Per-entry isolation: one
 * entry's failure (thrown or a non-'ok' `DecisionOutcome`) is logged and the
 * remaining entries are still attempted — cancellation proceeds regardless.
 *
 * Scope resolution: `approvalScopeId` is the Discord thread id for `surface
 * === 'discord'` runs (mirrors `scopeIdFor` in `web/sse/projection.ts`) and
 * the run id otherwise (mirrors `web/operator/web-approval.ts`'s
 * `approvalScopeId: ctx.runId` and `decision-route.ts`'s
 * `approvalScopeId: run.run_id`).
 */
async function settlePendingApprovals(
  deps: CancelRunDeps,
  runState: RunState,
  actor: ApprovalActor,
  logger: GatewayLogger,
): Promise<void> {
  const approvalScopeId = runState.surface === 'discord' ? runState.thread_id : runState.run_id
  const pending = deps.approvalRegistry.describePendingForScope(approvalScopeId)
  for (const entry of pending) {
    try {
      const outcome = await deps.approvalRegistry.handleDecision({
        requestID: entry.requestID,
        approvalScopeId,
        decision: 'reject',
        actor,
      })
      if (outcome !== 'ok') {
        logger.warn(
          {runId: runState.run_id, requestID: entry.requestID, outcome},
          'cancelRun: approval settle did not return ok — continuing with remaining entries',
        )
      }
    } catch (error: unknown) {
      logger.warn(
        {
          runId: runState.run_id,
          requestID: entry.requestID,
          err: error instanceof Error ? error.message : String(error),
        },
        'cancelRun: approval settle threw — continuing with remaining entries',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Rendezvous: pre-ACK / pre-registration double-miss path
// ---------------------------------------------------------------------------

/**
 * Attempt the direct conditional-write rendezvous: `transitionRun(currentPhase
 * → CANCELLED)`. This is used only on a double miss (no queue entry, no abort
 * registry entry) — the window between `queue.takeNext` and the abort
 * registry's `register()` call in `run.ts`.
 *
 * Bounded retry strategy (see `RENDEZVOUS_MAX_ATTEMPTS`): on a 412 etag
 * mismatch, re-read the run-state.
 *   - Terminal phase → `{outcome:'already-terminal', phase}` (the run's own
 *     transition won the race).
 *   - Non-terminal (still advancing, e.g. now EXECUTING) → retry once more.
 *   - Retries exhausted → `{outcome:'retry'}` (never loop unboundedly).
 */
async function attemptRendezvousCancel(
  deps: CancelRunDeps,
  repo: string,
  runId: string,
  actor: CancelActorContext,
  logger: GatewayLogger,
): Promise<CancelOutcome> {
  const {coordinationConfig, identity} = deps
  const coordLogger = {debug: (msg: string, ctx?: Record<string, unknown>) => logger.debug(ctx ?? {}, msg)}

  let read = await readRunState(deps, repo, runId, logger)
  if (read === undefined) {
    return {outcome: 'not-found'}
  }

  for (let attempt = 0; attempt < RENDEZVOUS_MAX_ATTEMPTS; attempt += 1) {
    if (isTerminalPhase(read.state.phase)) {
      return {outcome: 'already-terminal', phase: read.state.phase}
    }

    const cancelledBy = {
      githubUserId: actor.githubUserId,
      login: actor.login,
      sessionCorrelationId: actor.sessionCorrelationId,
      cancelledAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    }

    const result = await transitionRun(coordinationConfig, identity, repo, runId, 'CANCELLED', read.etag, coordLogger, {
      detailsPatch: {cancelledBy},
    })

    if (result.success === true) {
      notifyObserverBestEffort(deps, result.data.state, logger)
      await postCancellationNotice(deps, runId, result.data.state.thread_id, logger)
      return {outcome: 'cancelled', wasQueued: false}
    }

    // 412 (or another conditional-write failure) — re-read before deciding.
    const reread = await readRunState(deps, repo, runId, logger)
    if (reread === undefined) {
      // Could not confirm the current state — do not claim success or terminality.
      return {outcome: 'retry'}
    }
    read = reread
  }

  // Bound exhausted without resolving — the run kept advancing (e.g. to EXECUTING)
  // faster than this loop could observe a stable state. Safe to retry later:
  // by the time this returns, either the abort registry now has the entry
  // (a subsequent cancelRun call will hit the executing path) or the run
  // reached a terminal state on its own.
  return {outcome: 'retry'}
}

// ---------------------------------------------------------------------------
// cancelRun
// ---------------------------------------------------------------------------

export async function cancelRun(params: CancelRunParams, deps: CancelRunDeps): Promise<CancelOutcome> {
  const {runId, actor, logger} = params

  const location = await deps.runIndex.lookup(runId)
  if (location === undefined) {
    return {outcome: 'not-found'}
  }
  const {repo} = location

  const initialRead = await readRunState(deps, repo, runId, logger)
  if (initialRead === undefined) {
    return {outcome: 'not-found'}
  }

  // ── Idempotent short-circuit — read-then-short-circuit, never attempt a
  // terminal transition (transitionRun rejects it by design anyway). ──────
  if (isTerminalPhase(initialRead.state.phase)) {
    return {outcome: 'already-terminal', phase: initialRead.state.phase}
  }

  // ── Queued path: PENDING/ACKNOWLEDGED with a matching queue entry ───────
  const channelId = typeof initialRead.state.details.channelId === 'string' ? initialRead.state.details.channelId : ''
  if (channelId !== '') {
    const removed = deps.queue.removeBy(channelId, task => task.runId === runId)
    if (removed !== undefined) {
      const coordLogger = {debug: (msg: string, ctx?: Record<string, unknown>) => logger.debug(ctx ?? {}, msg)}
      const cancelledBy = {
        githubUserId: actor.githubUserId,
        login: actor.login,
        sessionCorrelationId: actor.sessionCorrelationId,
        cancelledAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
      }
      const transitionResult = await transitionRun(
        deps.coordinationConfig,
        deps.identity,
        repo,
        runId,
        'CANCELLED',
        initialRead.etag,
        coordLogger,
        {detailsPatch: {cancelledBy}},
      )
      if (transitionResult.success === false) {
        logger.error(
          {repo, runId, err: transitionResult.error.message},
          'cancelRun: transitionRun CANCELLED failed for a queued run',
        )
        // The run was already dequeued — it cannot be re-enqueued safely (order would
        // be lost). Fall through to the rendezvous path: the run-state read there will
        // reflect whatever won, and the caller gets an accurate outcome rather than a
        // silent no-op.
        return attemptRendezvousCancel(deps, repo, runId, actor, logger)
      }
      notifyObserverBestEffort(deps, transitionResult.data.state, logger)
      await postCancellationNotice(deps, runId, transitionResult.data.state.thread_id, logger)
      return {outcome: 'cancelled', wasQueued: true}
    }
  }

  // ── Executing path: abort-registry hit ───────────────────────────────────
  if (deps.abortRegistry.has(runId)) {
    const approvalActor: ApprovalActor = {
      kind: 'web-operator',
      githubUserId: actor.githubUserId,
      login: actor.login,
      sessionCorrelationId: actor.sessionCorrelationId,
    }

    // Settle pending approvals FIRST — Unit 1's error path (triggered by the
    // abort below) owns the run-state transition/cleanup; approvals must be
    // rejected before the abort so the run's own catch handler doesn't race
    // a still-open approval against the cancel.
    await settlePendingApprovals(deps, initialRead.state, approvalActor, logger)

    const cancelledBy = {
      githubUserId: actor.githubUserId,
      login: actor.login,
      sessionCorrelationId: actor.sessionCorrelationId,
      cancelledAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    }
    deps.abortRegistry.abort(runId, 'operator cancel', cancelledBy)

    await postCancellationNotice(deps, runId, initialRead.state.thread_id, logger)
    return {outcome: 'cancelled', wasQueued: false}
  }

  // ── Double miss: pre-ACK / pre-registration rendezvous window ───────────
  return attemptRendezvousCancel(deps, repo, runId, actor, logger)
}
