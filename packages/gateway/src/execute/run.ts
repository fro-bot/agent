import type {CoordinationConfig, Result, RunState} from '@fro-bot/runtime'
import type {Message} from 'discord.js'
import type {PermissionRequest} from '../approvals/coordinator.js'
import type {ApprovalRegistry} from '../approvals/registry.js'
import type {RepoBinding} from '../bindings/types.js'
import type {GatewayLogger} from '../discord/client.js'
import type {SinkThread} from '../discord/streaming.js'
import type {EnsureCloneFailure} from '../workspace-api/ensure-clone.js'
import type {ReadyzResponse, WorkspaceError} from '../workspace-api/types.js'
import type {ConcurrencyRegistry} from './concurrency.js'
import type {LaunchAdmission, LaunchWorkRequest, PostReplyFactory, ReplySink, StatusSink} from './launch-types.js'
import type {ChannelQueue} from './queue.js'
import type {RunIndex} from './run-index.js'

import {acquireLock, createHeartbeatController, createRun, releaseLock, transitionRun} from '@fro-bot/runtime'

import {createPermissionCoordinator} from '../approvals/coordinator.js'
import {createDiscordApprovalOnPending} from '../approvals/discord-transport.js'
import {sendMessage} from '../discord/io.js'
import {setRunReaction} from '../discord/reactions.js'
import {createStatusController} from '../discord/status-message.js'
import {createDiscordStreamSink} from '../discord/streaming.js'
import {attachOpencode} from './opencode-attach.js'
import {buildDiscordPrompt, EmptyPromptError} from './prompt.js'
import {RunCoreError, runOpenCodeCore} from './run-core.js'

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RunMentionDeps {
  readonly coordinationConfig: CoordinationConfig
  readonly identity: string
  readonly concurrency: ConcurrencyRegistry
  /** Per-channel FIFO queue for pending tasks. */
  readonly queue: ChannelQueue<RunTask>
  readonly attachUrl: string
  readonly attachToken: string
  /** Wall-clock milliseconds before an in-progress run is timed out. */
  readonly runTimeoutMs: number
  /**
   * Discord user ID of the bot. Used to strip leading mention tokens from
   * the message before building the agent prompt, so a bare `@bot` mention
   * does not silently dispatch a no-op run.
   */
  readonly botUserId: string
  /**
   * Optional canonical persona text (from `GatewayConfig.persona`).
   * Prepended to every Discord mention prompt before the Discord-mechanical guidance.
   * `null` → mechanical guidance only (fail-soft: omit persona rather than failing).
   */
  readonly persona: string | null
  readonly logger: GatewayLogger
  /** Program-scoped approval registry shared with the button handler and shutdown drain. */
  readonly approvalRegistry: ApprovalRegistry
  /**
   * Gateway approval mode. Propagated from `GatewayConfig.approvalMode`.
   * Currently only `approval-required` is supported.
   * `autonomous-low-risk` is deferred (unsafe due to OpenCode last-match-wins evaluation).
   */
  readonly approvalMode: 'approval-required'
  /**
   * Working-state UX mode. Propagated from `GatewayConfig.statusMode`.
   * - `live-status` (default): posts a single editable status message that updates as the agent works.
   * - `typing-only`: suppresses the status message; only the typing indicator is shown.
   */
  readonly statusMode: 'live-status' | 'typing-only'
  /**
   * Optional shutdown predicate. When present and returns `true`, the outer-finally
   * handoff is suppressed: the channel slot is released immediately instead of
   * starting the next queued task. Matches the `messageCreate` guard in program.ts
   * that refuses new mentions during shutdown.
   *
   * When absent (e.g. in tests that don't exercise shutdown), the handoff always
   * proceeds as normal.
   */
  readonly isShuttingDown?: () => boolean
  /**
   * Server-owned run index for `runId → {repo, surface}` resolution.
   *
   * Populated at run creation so privileged routes (future SSE/launch) can
   * authorize a run by id without trusting client-supplied owner/repo.
   * Optional — when absent, registration is skipped (e.g. in tests that do
   * not exercise the index).
   */
  readonly runIndex?: RunIndex
  /**
   * Run-state observer for the SSE observation pipeline.
   *
   * Called best-effort after each successful run-state transition so the
   * observation manager can project and fan out the new state to subscribers.
   * Optional — when absent, observation is skipped (e.g. in tests that do
   * not exercise the SSE pipeline).
   *
   * Narrow interface: only `observe` is exposed here so run.ts cannot call
   * subscribe, shutdown, or abortSubscription on the manager.
   */
  readonly runObserver?: {readonly observe: (runState: RunState) => Promise<void>}
  /**
   * Ensure the workspace checkout exists for the given owner/repo.
   * Called after the concurrency gate acquires a slot, before readyz/execution.
   * Injected so tests can stub it without live GitHub/workspace calls.
   *
   * Returns ok(path) on success (fresh clone or repo-exists recovery).
   * Returns err(EnsureCloneFailure) on auth/clone/network failure.
   */
  readonly ensureClone: (owner: string, repo: string) => Promise<Result<string, EnsureCloneFailure>>
  /**
   * Workspace readiness check. Called after ensure-clone, before execution.
   * Injected so tests can stub it without a live workspace.
   *
   * Fail-closed: any error result or thrown exception → treat as not-ready.
   */
  readonly readyz: () => Promise<Result<ReadyzResponse, WorkspaceError>>
}

/**
 * The task descriptor stored in the per-channel queue.
 *
 * Carries a `LaunchWorkRequest` (transport-neutral engine input) instead of a
 * raw Discord `Message`. The Discord adapter (`runMention`) constructs the
 * `LaunchWorkRequest` from the `Message` before enqueuing.
 *
 * `deps` is still carried so the inner execution primitive can access
 * coordination config, identity, concurrency, queue, and other deps.
 *
 * `runId` and `adoptionEtag` are set by `launchWork` during the admission block
 * (after `createRun` succeeds). `executeWorkOnHeldSlot` uses them to adopt the
 * already-created run (`PENDING → ACKNOWLEDGED`) instead of calling `createRun`.
 */
export interface RunTask {
  readonly request: LaunchWorkRequest
  readonly deps: RunMentionDeps
  /** Stable UUID for this run. Set by `launchWork` during admission. */
  readonly runId: string
  /**
   * The etag returned by `createRun` (the admission create-etag).
   * Used by `executeWorkOnHeldSlot` to adopt the run (`PENDING → ACKNOWLEDGED`).
   * After the ACK transition the etag is refreshed; subsequent transitions use
   * the latest etag, never this create-etag.
   */
  readonly adoptionEtag: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format a millisecond duration as a human-readable string for user-facing
 * timeout messages. Produces accurate compound minute+second strings for
 * non-integral minutes; falls back to seconds for sub-minute values.
 *
 * Examples:
 *   45_000  → "45 seconds"
 *   60_000  → "1 minute"
 *   90_000  → "1 minute 30 seconds"
 *   600_000 → "10 minutes"
 */
export function formatTimeoutDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const remainingSeconds = totalSeconds % 60
  if (minutes >= 1) {
    const minutePart = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
    if (remainingSeconds === 0) return minutePart
    return `${minutePart} ${remainingSeconds} ${remainingSeconds === 1 ? 'second' : 'seconds'}`
  }
  return `${totalSeconds} ${totalSeconds === 1 ? 'second' : 'seconds'}`
}

/** Narrow logger adapter for runtime coordination functions. */
function toCoordLogger(logger: GatewayLogger): {debug: (message: string, context?: Record<string, unknown>) => void} {
  return {
    debug: (msg, ctx) => logger.debug(ctx ?? {}, msg),
  }
}

// ---------------------------------------------------------------------------
// computeApprovalDeadlineMs
// ---------------------------------------------------------------------------

/**
 * Compute the per-approval deadline in ms from the **remaining** run budget.
 *
 * Pass `remainingBudgetMs` — the time left after setup, lock, and thread
 * creation — not the raw configured `runTimeoutMs`. This ensures the approval
 * deadline and the hard abort are aligned to the same budget origin.
 *
 * Returns `undefined` if `remainingBudgetMs` is too short to add a meaningful
 * deadline — specifically when there is less than 90 s of runway (we need at
 * least 30 s of clearance before the hard run timeout for the coordinator to
 * fire and the reply to POST).
 *
 * Otherwise the deadline is:
 *   - at least 60 s
 *   - at most half the remaining budget
 *   - capped at remainingBudgetMs − 30 s (fires before the hard abort)
 *   - capped at 13 min (Discord interaction-token guard)
 */
export function computeApprovalDeadlineMs(remainingBudgetMs: number): number | undefined {
  // Need at least 90 s to have a 60 s deadline + 30 s clearance.
  if (remainingBudgetMs <= 90_000) return undefined
  return Math.min(Math.max(60_000, Math.floor(remainingBudgetMs / 2)), remainingBudgetMs - 30_000, 13 * 60_000)
}

// DiscordAdapterBridge was removed — thread creation now lives in the adapter via threadFactory

// ---------------------------------------------------------------------------
// executeWorkOnHeldSlot — the private slot-holding execution pipeline
// ---------------------------------------------------------------------------

/**
 * Execute the post-acquire pipeline for a task.
 *
 * PRIVATE — not exported. Callers must go through `launchWork` (the public
 * front door) which enforces the per-channel FIFO queue and global concurrency
 * cap. Exporting this function would allow callers to bypass the queue.
 *
 * ASSUMES the channel concurrency slot is already held by the caller.
 * Owns: clone → readyz → thread → lock → run-state → heartbeat → execute → cleanup.
 *
 * On completion (success or failure), performs an **atomic handoff**:
 * - Calls `queue.takeNext(channelId)` while the slot is still held.
 * - If a next task exists → starts it on the held slot (no release/re-acquire gap).
 * - If the queue is empty → calls `concurrency.release(channelId)` (only then is the slot freed).
 *
 * The handoff `executeWorkOnHeldSlot` is fire-and-forget from the completing run's perspective.
 * Its own outer finally runs the same handoff/release logic, so the chain continues
 * and a thrown handoff still releases.
 */
async function executeWorkOnHeldSlot(task: RunTask): Promise<void> {
  const {request, deps} = task
  const {
    concurrency,
    queue,
    coordinationConfig,
    identity,
    attachUrl,
    attachToken,
    runTimeoutMs,
    botUserId,
    persona,
    logger,
  } = deps
  const {approvalRegistry, approvalMode, ensureClone, readyz} = deps

  // ── All mutable state that the outer finally needs is declared here so the
  // finally block can always reference channelId regardless of where execution
  // stopped. Async functions never throw synchronously, so the outer try/finally
  // always runs — but keeping these declarations before the try makes the
  // dependency explicit and avoids any ambiguity.
  const channelId = request.channelId
  const binding = request.binding
  const repo = `${binding.owner}/${binding.repo}`
  // runId and adoptionEtag are set by launchWork during admission.
  const runId = task.runId
  const coordLogger = toCoordLogger(logger)

  // ── Budget origin — single source of truth for hard abort and approval deadline ──
  // Captured once at run entry so both the AbortSignal.timeout and the approval
  // deadline clearance are computed from the same wall-clock reference.
  const runStartMs = Date.now()

  // ── Pre-ACK gate section — dual-finally wrapper ──────────────────────────────────────────────
  // Gates 1-4 (ensureClone, readyz, threadFactory, lock) and gate 5 (ACK transition) all fire
  // while the run is still PENDING (task.adoptionEtag is the current etag). Each explicit-return
  // failure path calls failAdmittedRun before returning. The try/catch below handles the case
  // where a gate THROWS (not just returns) — it terminalizes to FAILED then rethrows.
  // Once the ACK transition succeeds, the existing EXECUTING catch owns FAILED; this wrapper
  // must NOT run after a successful ACK (it only wraps the pre-ACK section).
  let preAckCompleted = false
  let lockEtag: string | null = null

  try {
    // ── Ensure workspace checkout exists ──────────────────────────────────────────────────────
    // Rehydrates a missing checkout (e.g. after container recreation) before OpenCode can start.
    // Placed after the concurrency gate so duplicate mentions are rejected before any
    // GitHub App token is minted or workspace clone is attempted.
    const ensureCloneResult = await ensureClone(binding.owner, binding.repo)
    if (ensureCloneResult.success === false) {
      logger.warn(
        {
          channelId,
          owner: binding.owner,
          repo: binding.repo,
          failureKind: ensureCloneResult.error.kind,
        },
        'run: workspace clone unavailable — aborting',
      )
      // Gate 1 failure: terminalize the admitted run to FAILED before replying.
      await failAdmittedRun(deps, repo, runId, task.adoptionEtag)
      await request.replySink.send('source', {
        content: 'The workspace is not available right now. Please try again later.',
      })
      return
    }

    // Use the ensured (canonical) path from ensureClone, not the potentially stale
    // workspacePath stored in the binding (e.g. after container recreation).
    const bindingWithEnsuredPath = {...binding, workspacePath: ensureCloneResult.data}

    // ── Workspace readiness gate ──────────────────────────────────────────────────────────────
    // Fail-closed: any error result or thrown exception → treat as not-ready.
    // This prevents creating a thread, acquiring a lock, or creating run-state
    // for a workspace that is not yet serving OpenCode.
    let workspaceReady = false
    try {
      const readyzResult = await readyz()
      workspaceReady = readyzResult.success === true && readyzResult.data.ready === true
    } catch {
      // Thrown exception (e.g. timeout) → fail closed
      workspaceReady = false
    }

    if (workspaceReady === false) {
      logger.warn({channelId, repo}, 'run: workspace not ready — aborting')
      // Gate 2 failure: terminalize the admitted run to FAILED before replying.
      await failAdmittedRun(deps, repo, runId, task.adoptionEtag)
      await request.replySink.send('source', {
        content: 'The workspace is not reachable right now. Please try again later.',
      })
      return
    }

    // ── Thread factory (transport-specific, optional) ─────────────────────────────────────────
    // Called after gates pass, before lock acquisition. The Discord adapter provides this to
    // create the response thread at the right pipeline stage. Non-Discord callers (in-memory
    // sinks, future web transports) omit it — the engine uses an empty thread ID in run-state.
    //
    // Bounded timeout: a hung threadFactory would pin the concurrency slot indefinitely.
    // Uses Promise.race with a setTimeout so the timeout is compatible with fake timers in tests.
    const THREAD_FACTORY_TIMEOUT_MS = 10_000
    let threadId = ''
    if (request.threadFactory !== undefined) {
      let threadResult: Awaited<ReturnType<NonNullable<typeof request.threadFactory>>>
      try {
        threadResult = await Promise.race([
          request.threadFactory(),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error(`threadFactory timed out after ${THREAD_FACTORY_TIMEOUT_MS}ms`))
            }, THREAD_FACTORY_TIMEOUT_MS)
          }),
        ])
      } catch (threadError) {
        // If the timeout fired, threadFactory may still resolve later — after the engine has
        // already aborted and released the concurrency slot. That late resolution is intentionally
        // abandoned: the created thread/sinks are orphaned, but the user sees a clean failure
        // and can retry. This is the safe outcome for a slow-but-not-dead Discord API call.
        logger.error(
          {channelId, repo, err: threadError instanceof Error ? threadError.message : String(threadError)},
          'run: threadFactory threw or timed out — aborting',
        )
        // Gate 3 (throw/timeout) failure: terminalize the admitted run to FAILED before replying.
        await failAdmittedRun(deps, repo, runId, task.adoptionEtag)
        await request.replySink.send('source', {content: 'Could not start the task — please try again.'})
        return
      }
      if (threadResult.ok === false) {
        logger.error({channelId, repo, err: threadResult.error}, 'run: threadFactory failed — aborting')
        // Gate 3 (ok:false) failure: terminalize the admitted run to FAILED before replying.
        await failAdmittedRun(deps, repo, runId, task.adoptionEtag)
        await request.replySink.send('source', {content: 'Could not start the task — please try again.'})
        return
      }
      threadId = threadResult.threadId
    }

    // ── Acquire repo lock ─────────────────────────────────────────────────────────────────────────

    const lockResult = await acquireLock(coordinationConfig, repo, identity, request.surface, runId, coordLogger)

    if (lockResult.success === false) {
      logger.error({repo, runId, err: lockResult.error.message}, 'run: lock acquisition error')
      // Gate 4 (lock error) failure: terminalize the admitted run to FAILED before replying.
      await failAdmittedRun(deps, repo, runId, task.adoptionEtag)
      await request.replySink.send('thread', {content: 'Could not start the task — please try again.'})
      return
    }

    if (lockResult.data.acquired === false) {
      // Lock held — terminal "waiting" reply; do NOT expose holder ID to Discord
      logger.info({repo, runId, holder: lockResult.data.holder?.holder_id ?? 'unknown'}, 'run: lock held by another')
      // Gate 4 (lock not acquired) failure: terminalize the admitted run to FAILED before replying.
      await failAdmittedRun(deps, repo, runId, task.adoptionEtag)
      await request.replySink.send('thread', {
        content: 'Another task is already in progress for this repo. Try again when it completes.',
      })
      return
    }

    // Lock acquired — must release in inner finally
    lockEtag = lockResult.data.etag

    // ── Run-state adoption: PENDING → ACKNOWLEDGED ────────────────────────────────────────────
    // The run was already created (PENDING) by launchWork during admission.
    // Adopt it here by transitioning PENDING → ACKNOWLEDGED using the adoption etag.
    // This is the seam between admission (launchWork) and execution (here).
    // The thread_id is updated via the transition so the run-state reflects the actual thread.
    // NOTE: transitionRun does not update thread_id — the thread_id was set at createRun time
    // with an empty string (pre-thread). This is acceptable — the thread_id is not load-bearing for run-state.
    const ackResult = await transitionRun(
      coordinationConfig,
      identity,
      repo,
      runId,
      'ACKNOWLEDGED',
      task.adoptionEtag,
      coordLogger,
    )
    if (ackResult.success === false) {
      logger.error({repo, runId, err: ackResult.error.message}, 'run: transitionRun ACKNOWLEDGED failed')
      // Gate 5 (ACK fail): run is still PENDING; terminalize to FAILED using adoptionEtag.
      await failAdmittedRun(deps, repo, runId, task.adoptionEtag)
      await request.replySink.send('thread', {content: 'Could not start the task — please try again.'})
      await releaseLock(coordinationConfig, repo, lockEtag, coordLogger)
      return
    }

    // ACK succeeded — mark pre-ACK section complete so the dual-finally catch does not run.
    preAckCompleted = true

    let runEtag = ackResult.data.etag

    // Push the ACKNOWLEDGED state to the observation pipeline (best-effort, fire-and-forget).
    notifyObserverBestEffort(deps, ackResult.data.state)

    const heartbeat = createHeartbeatController(coordinationConfig, identity, repo, runId, lockEtag, coordLogger)
    heartbeat.start()

    let heartbeatStopped = false

    const {statusSink, replySink} = request

    try {
      const execResult = await transitionRun(
        coordinationConfig,
        identity,
        repo,
        runId,
        'EXECUTING',
        runEtag,
        coordLogger,
      )
      if (execResult.success === false) {
        throw new Error(`transitionRun EXECUTING failed: ${execResult.error.message}`)
      }
      runEtag = execResult.data.etag

      // Push the EXECUTING state to the observation pipeline (best-effort, fire-and-forget).
      notifyObserverBestEffort(deps, execResult.data.state)

      // ── Working reaction — best-effort, fire-and-forget ───────────────────────────────────────────────────────────────────
      statusSink.setReaction('working')

      // ── Execute prompt via OpenCode ─────────────────────────────────────────────────────────────────────────────────────────

      const handle = attachOpencode(attachUrl, attachToken)
      const promptText =
        request.promptBuilder === undefined
          ? buildDiscordPrompt({
              messageText: request.promptText,
              owner: bindingWithEnsuredPath.owner,
              repo: bindingWithEnsuredPath.repo,
              botUserId,
              persona,
            })
          : request.promptBuilder({
              messageText: request.promptText,
              owner: bindingWithEnsuredPath.owner,
              repo: bindingWithEnsuredPath.repo,
            })

      // ── Remaining budget — single origin for hard abort AND approval deadline ──
      //
      // Both the AbortSignal.timeout (hard abort) and the approval deadline are
      // computed from the same wall-clock reference (runStartMs) so they are
      // aligned: the approval deadline always fires before the hard abort.
      const elapsedMs = Date.now() - runStartMs
      const remainingBudgetMs = Math.max(0, runTimeoutMs - elapsedMs)
      const timeoutSignal = AbortSignal.timeout(remainingBudgetMs)

      // ── Approval coordinator — per-run, wired to the program-scoped registry ──
      const approvalDeadlineMs = computeApprovalDeadlineMs(remainingBudgetMs)

      // ── Approval transport selection ──────────────────────────────────────────
      //
      // The engine's onPending hook is the transport-neutral extension point.
      // When the request carries a `createApprovalOnPending` factory (e.g. a web
      // transport), the engine calls it with all engine-owned context and uses
      // the returned callback. When absent (the default for Discord), the engine
      // constructs the Discord approval transport.
      //
      // The factory shape ensures the web transport receives canonical directory,
      // deadline, runId/repo, registry, and postReply factory — without the
      // transport duplicating engine internals or using stale binding paths.
      //
      // AbortSignal.timeout(10_000) avoids the dangling-timer leak from the old
      // Promise.race approach. AbortSignal.timeout is self-cleaning.
      const postReplyFactory: PostReplyFactory = sessionID => async (rID, dir, decision) => {
        // Call the OpenCode SDK permission reply endpoint.
        // Uses the session-scoped API: POST /session/{id}/permissions/{permissionID}
        try {
          const res = await handle.client.postSessionIdPermissionsPermissionId({
            path: {id: sessionID, permissionID: rID},
            body: {response: decision},
            query: {directory: dir},
            signal: AbortSignal.timeout(10_000),
          })
          const envelope = res as {error?: unknown} | undefined
          if (envelope?.error != null) {
            return {ok: false as const, error: String(envelope.error)}
          }
          return {ok: true as const}
        } catch (error) {
          return {ok: false as const, error: error instanceof Error ? error.message : String(error)}
        }
      }

      // ── Approval transport selection — resolved before coordinator creation ──────
      // `resolvedApprovalOnPending` is resolved first. If the factory throws, the outer
      // catch handles it; the inner try/finally (which calls coordinator.dispose) is never
      // entered, so there is no risk of accessing an uninitialized coordinator.
      const resolvedApprovalOnPending: (req: PermissionRequest) => void =
        request.createApprovalOnPending === undefined
          ? createDiscordApprovalOnPending({
              approvalRegistry,
              replySink,
              threadId,
              directory: bindingWithEnsuredPath.workspacePath,
              approvalDeadlineMs,
              onDeadlineSettled: async () => {
                // markVisibleOutputSent AFTER the send succeeds so flush() still
                // adds _(no output)_ if the send fails (user needs the fallback).
                const deadlineResult = await replySink.send('thread', {
                  content: 'Approval timed out — the task could not continue.',
                })
                const dr = deadlineResult as {success?: boolean} | undefined
                if (dr?.success === true) {
                  replySink.markVisibleOutputSent()
                }
              },
              postReplyFactory,
              logger,
            })
          : request.createApprovalOnPending({
              approvalRegistry,
              directory: bindingWithEnsuredPath.workspacePath,
              approvalDeadlineMs,
              runId,
              repo,
              replySink,
              postReplyFactory,
            })

      const coordinator = createPermissionCoordinator({
        logger,
        onPending: req => {
          // Awaiting-approval reaction — best-effort, fire-and-forget.
          // Replaces the working reaction with the awaiting-approval cue.
          // The reaction is set here (in the engine) because it's transport-neutral
          // state management; the Discord embed/button rendering is in the transport.
          statusSink.setReaction('awaiting-approval')
          // Delegate to the resolved approval transport for notification + registry wiring.
          resolvedApprovalOnPending(req)
        },
        onReplied: event => {
          // Authoritative echo from OpenCode — let the registry render + cascade.
          approvalRegistry.confirmReply(event)
        },
        onDispose: sessionIDs => {
          // Coordinator is per-run; dispose only the sessions it owned — never other runs.
          // eslint-disable-next-line no-void
          void Promise.all(sessionIDs.map(async sid => approvalRegistry.disposeRun(sid, 'run ended')))
        },
      })

      try {
        await runOpenCodeCore({
          handle,
          directory: bindingWithEnsuredPath.workspacePath,
          promptText,
          sink: replySink,
          signal: timeoutSignal,
          logger,
          coordinator,
          approvalMode,
          onActivity: (summary: string) => {
            statusSink.noteActivity(summary)
          },
          onBusy: (busy: boolean) => {
            statusSink.setBusy(busy)
          },
        })
      } finally {
        // Fail-closed: dispose any still-open coordinator entries so pending approvals
        // don't hang if the run ended (normally or via error) before they were settled.
        coordinator.dispose('run ended')
      }

      // ── Succeeded reaction — best-effort, fire-and-forget ────────────────────────────────────
      // Replaces the working/awaiting reaction with the succeeded cue.
      statusSink.setReaction('succeeded')

      // ── session.idle received — transition to COMPLETED ──────────────────────────────────────

      const stopResult = await heartbeat.stop()
      heartbeatStopped = true

      if (stopResult.success === true) {
        runEtag = stopResult.data.runEtag
        lockEtag = stopResult.data.lockEtag
      } else {
        logger.warn({repo, runId, err: stopResult.error.message}, 'run: heartbeat stop failed; using last known etags')
      }

      const completedResult = await transitionRun(
        coordinationConfig,
        identity,
        repo,
        runId,
        'COMPLETED',
        runEtag,
        coordLogger,
      )
      if (completedResult.success === false) {
        logger.error({repo, runId, err: completedResult.error.message}, 'run: transitionRun COMPLETED failed')
        // Non-fatal: continue to flush sink and release resources
      } else {
        // Push the COMPLETED state to the observation pipeline (best-effort, fire-and-forget).
        notifyObserverBestEffort(deps, completedResult.data.state)
      }

      // ── Status controller final-answer transition ─────────────────────────────────────────────
      // Get the buffered text BEFORE flush so the controller can decide whether to edit in place.
      // resolveToAnswer returns:
      //   'handled'   → controller edited the status message into the answer; skip sink flush.
      //   'delegated' → controller deleted the status (or typing-only); flush via sink as normal.
      const finalText = replySink.buffered()
      const answerResult = await statusSink.resolveToAnswer(finalText)
      if (answerResult.transition === 'delegated') {
        await replySink.flush()
      }
      // 'handled': answer is already in the status message — do not flush (would double-post).
    } catch (execError: unknown) {
      // ── Error classification ───────────────────────────────────────────────

      const isCoreError = execError instanceof RunCoreError
      const isTimeout = isCoreError && execError.kind === 'timeout'
      const isStreamEnded = isCoreError && execError.kind === 'stream-ended'
      const isReachability = isCoreError && (execError.kind === 'unreachable' || execError.kind === 'auth')
      const isEmptyPrompt = execError instanceof EmptyPromptError

      logger.error(
        {
          repo,
          runId,
          kind: isCoreError ? execError.kind : 'unknown',
          err: execError instanceof Error ? execError.message : String(execError),
        },
        'run: execution failed',
      )

      // ── Failed reaction — best-effort, fire-and-forget ────────────────────────────────────────
      // Replaces the working/awaiting reaction with the failed cue.
      statusSink.setReaction('failed')

      // Stop heartbeat (best-effort) if not already stopped
      if (heartbeatStopped === false) {
        const stopResult = await heartbeat.stop()
        heartbeatStopped = true
        if (stopResult.success === true) {
          runEtag = stopResult.data.runEtag
          lockEtag = stopResult.data.lockEtag
        } else {
          logger.warn(
            {repo, runId, err: stopResult.error.message},
            'run: heartbeat stop failed; using last known etags',
          )
        }
      }

      // Transition to FAILED (best-effort)
      const failedResult = await transitionRun(
        coordinationConfig,
        identity,
        repo,
        runId,
        'FAILED',
        runEtag,
        coordLogger,
      )
      if (failedResult.success === false) {
        logger.error({repo, runId, err: failedResult.error.message}, 'run: transitionRun FAILED failed')
      } else {
        // Push the FAILED state to the observation pipeline (best-effort, fire-and-forget).
        notifyObserverBestEffort(deps, failedResult.data.state)
      }

      // Flush partial output (best-effort) so the user sees whatever streamed before the failure.
      // Wrapped in its own try/catch so a flush failure does not mask the original error.
      await replySink.flush().catch((flushError: unknown) => {
        logger.warn({repo, runId, err: String(flushError)}, 'run: sink.flush failed in error path')
      })

      // Coarse user message — no internal detail
      const timeoutDuration = formatTimeoutDuration(runTimeoutMs)
      const hasVisibleOutput = replySink.hasVisibleOutput() === true
      const userMessage =
        isTimeout === true
          ? hasVisibleOutput === true
            ? `The task reached the ${timeoutDuration} time limit after posting updates above. Start a new @fro-bot request with what to do next and include any needed context from the output above.`
            : `The task reached the ${timeoutDuration} time limit. Please try again.`
          : isReachability === true
            ? 'The workspace is not reachable right now. Please try again later.'
            : isEmptyPrompt === true
              ? 'Nothing to do — please include a task in your message.'
              : isStreamEnded === true
                ? 'The task stream closed unexpectedly. Please try again.'
                : 'The task failed. Please try again.'

      // ── Status controller failure transition ──────────────────────────────────────────────────
      // resolveToFailure returns:
      //   'handled'   → controller edited the status message into the failure note; skip sendMessage.
      //   'delegated' → no status to edit (or typing-only); post via sendMessage as normal.
      // Never both — single owner for the failure message.
      const failureResult = await statusSink.resolveToFailure(userMessage).catch((error: unknown) => {
        logger.warn({repo, runId, err: String(error)}, 'run: statusController.resolveToFailure failed — delegating')
        return {transition: 'delegated' as const}
      })
      if (failureResult.transition === 'delegated') {
        const failureSendResult = await replySink.send('thread', {content: userMessage})
        if (failureSendResult !== undefined) {
          const result = failureSendResult as {success?: boolean; error?: {message: string}}
          if (result.success === false && result.error !== undefined) {
            logger.warn({repo, runId, err: result.error.message}, 'run: failed to send error reply to thread')
          }
        }
      }
    } finally {
      // Stop heartbeat if not yet stopped (defensive — should not normally happen)
      if (heartbeatStopped === false) {
        await heartbeat.stop().catch(() => {
          /* best-effort */
        })
      }

      // Dispose status controller — guaranteed cleanup of typing interval and debounce timer.
      // Must run in finally so timers never leak regardless of success or failure.
      await statusSink.dispose().catch((error: unknown) => {
        logger.warn({repo, runId, err: String(error)}, 'run: statusController.dispose failed')
      })

      // Release lock (best-effort)
      const releaseResult = await releaseLock(coordinationConfig, repo, lockEtag, coordLogger)
      if (releaseResult.success === false) {
        logger.warn({repo, runId, err: releaseResult.error.message}, 'run: releaseLock failed')
      }
    }
  } catch (gateError: unknown) {
    // ── Dual-finally: terminalize on thrown errors in the pre-ACK gate section ──────────────
    // If a gate THROWS (not just returns) before the ACK transition succeeds, the run is still
    // PENDING and must be terminalized to FAILED. The explicit-return paths already call
    // failAdmittedRun before returning, so they never reach this catch.
    // Once preAckCompleted is true (ACK succeeded), the existing EXECUTING catch owns FAILED.
    if (preAckCompleted === false) {
      logger.error(
        {repo, runId, err: gateError instanceof Error ? gateError.message : String(gateError)},
        'run: pre-ACK gate threw — terminalizing admitted run to FAILED',
      )
      await failAdmittedRun(deps, repo, runId, task.adoptionEtag)
      // Release the lock if it was acquired before the throw (best-effort — never let cleanup throw).
      if (lockEtag !== null) {
        await releaseLock(coordinationConfig, repo, lockEtag, coordLogger).catch((error: unknown) => {
          logger.warn(
            {repo, runId, err: String(error)},
            'run: releaseLock failed in dual-finally catch — lock will expire via TTL',
          )
        })
      }
    }
    throw gateError
  } finally {
    // ── Atomic handoff — replaces bare concurrency.release ──────────────────
    //
    // While the channel slot is still held, attempt to drain the next queued task.
    // If a task is waiting → start it on the held slot (no release/re-acquire gap).
    // If the queue is empty → release the slot now.
    //
    // This closes the free-slot window: there is NO moment where tryAcquire could
    // return 'ok' for a channel that still has pending/handing-off work.
    //
    // Shutdown gate: if shutdown has been requested, skip the handoff and release
    // the slot immediately. The in-memory queue is lossy by design (documented in
    // AGENTS.md); dropping pending tasks on graceful shutdown matches that contract.
    // This is consistent with the messageCreate guard in program.ts that refuses
    // new mentions once isShuttingDown() returns true.
    //
    // The handed-off executeWorkOnHeldSlot is fire-and-forget from this run's perspective so
    // cleanup completes, but its own outer finally runs the same handoff/release
    // logic — so the chain continues and a thrown handoff still releases.
    if (deps.isShuttingDown?.() === true) {
      // Shutdown in progress — drop pending queued tasks; release the slot.
      //
      // Queued tasks that are dropped here each have an admitted PENDING run-state
      // (created in launchWork). These PENDING records are NOT terminalized here
      // because the queue has no drain loop on shutdown — tasks are abandoned
      // in-memory and the ChannelQueue is not iterated. The recovery sweep
      // (recoverStaleRuns / findStaleRuns) will terminalize these orphan PENDING
      // records on next boot, once they age past the staleness threshold. This is
      // the correct backstop: adding a per-task drain here would require iterating
      // all channels and all queued tasks across the queue, which is complex and
      // fragile. The freshness window in findStaleRuns ensures a just-admitted
      // PENDING is not killed prematurely.
      try {
        concurrency.release(channelId)
      } catch (releaseError: unknown) {
        logger.warn(
          {channelId, err: releaseError instanceof Error ? releaseError.message : String(releaseError)},
          'run: concurrency.release threw during shutdown — slot may leak',
        )
      }
    } else {
      const nextTask = queue.takeNext(channelId)
      if (nextTask === undefined) {
        // Queue is empty — release the slot now.
        try {
          concurrency.release(channelId)
        } catch (releaseError: unknown) {
          logger.warn(
            {channelId, err: releaseError instanceof Error ? releaseError.message : String(releaseError)},
            'run: concurrency.release threw — slot may leak',
          )
        }
      } else {
        // Slot ownership transfers to the next run — do NOT call concurrency.release.
        // eslint-disable-next-line no-void
        void executeWorkOnHeldSlot(nextTask).catch((error: unknown) => {
          logger.error(
            {channelId, err: error instanceof Error ? error.message : String(error)},
            'run: handoff startRun failed',
          )
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// launchWork — the public, queue-and-cap-preserving front door
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Gateway in-flight set — owns immediate-path run promises
// ---------------------------------------------------------------------------

/**
 * Gateway-owned set of in-flight immediate-run promises.
 *
 * When `launchWork` takes the immediate path (slot acquired), it registers the
 * `executeWorkOnHeldSlot` promise here and removes it on settle. This keeps the
 * run alive after `launchWork` returns admission early — the caller's `await` no
 * longer owns the run.
 *
 * Graceful shutdown drains this set by awaiting all in-flight promises.
 * For this unit, the set is created and populated; shutdown drain is a future step.
 *
 * Module-scoped so it survives across `launchWork` calls within the same process.
 * Tests that need to inspect or drain it can import `getInFlightRuns`.
 */
const inFlightRuns = new Set<Promise<void>>()

/**
 * Returns the current set of in-flight immediate-run promises.
 * Exported for the graceful-shutdown drain and test inspection.
 */
export function getInFlightRuns(): ReadonlySet<Promise<void>> {
  return inFlightRuns
}

/**
 * Public front door for launching a unit of work.
 *
 * Transport-agnostic: accepts a `LaunchWorkRequest` with pre-constructed
 * `StatusSink` and `ReplySink` implementations. The Discord adapter
 * (`runMention`) calls this after mapping a Discord `Message` → `LaunchWorkRequest`.
 * A future web adapter will call this directly.
 *
 * Enforces the per-channel FIFO queue and global concurrency cap. A future
 * web caller goes through THIS and cannot bypass the queue/cap.
 *
 * Decides whether to run immediately or enqueue, in this order:
 * 1. Empty-prompt guard — returns `{accepted:false,'empty-prompt'}` before any admission.
 * 2. Decide disposition FIRST (without admitting):
 *    - `'cap'` (no slot AND queue full) → capacity reply, return `{accepted:false,'cap'}`, NO createRun.
 * 3. For accepted dispositions (queued or immediate), run the fail-closed admission block:
 *    `createRun(PENDING)` → `runIndex.register` → `notifyObserver(PENDING)`.
 *    If anything after `createRun` throws, terminalize to FAILED before propagating.
 * 4. Disposition:
 *    - Queued → `enqueue(task{runId, adoptionEtag})`; return `{accepted:true, runId}`.
 *    - Immediate → register `executeWorkOnHeldSlot(task)` in the in-flight set; return `{accepted:true, runId}`.
 *
 * Hard invariants:
 * - `'cap'` is TERMINAL — no queue, no retry, no createRun.
 * - Internal identifiers (lock etags, holder IDs, workspace URLs, run IDs,
 *   raw errors) are logged but NEVER posted to the transport.
 * - Bearer token (`attachToken`) is never logged.
 * - Exactly ONE `createRun` per admitted run (ifNoneMatch:'*' preserved).
 *
 * @param request - Transport-neutral engine input (prompt, sinks, binding, identity).
 * @param deps - Runtime dependencies (concurrency, queue, coordination config, etc.).
 * @returns `LaunchAdmission` — the admission decision, resolved before the run completes.
 */
export async function launchWork(request: LaunchWorkRequest, deps: RunMentionDeps): Promise<LaunchAdmission> {
  const {concurrency, queue, coordinationConfig, identity, logger} = deps
  const channelId = request.channelId
  const binding = request.binding
  const repo = `${binding.owner}/${binding.repo}`
  const coordLogger = toCoordLogger(logger)

  // ── Empty-prompt front-door guard ────────────────────────────────────────────
  // Fail fast before any queue/concurrency/lock/run-state work.
  // The Discord adapter already strips the mention and checks for empty before
  // calling launchWork, but this guard ensures any future caller (e.g. a web
  // transport) cannot enter the engine with an empty prompt and hit the late
  // EmptyPromptError path (which would churn thread/lock/run-state before failing).
  //
  // Note: this is NOT the only gate. buildDiscordPrompt independently re-strips
  // leading mentions via botUserId and throws EmptyPromptError for the
  // non-leading-mention edge case. Both checks are intentional and complementary.
  if (request.promptText.trim().length === 0) {
    await request.replySink.send('source', {content: 'Nothing to do — please include a task in your message.'})
    return {accepted: false, reason: 'empty-prompt'}
  }

  // ── Decide disposition FIRST (before admitting) ──────────────────────────────
  // The FIFO gate and concurrency cap determine disposition without creating any run-state.
  // Only after we know the run will be accepted do we run the admission block.

  // ── FIFO gate: if pending work exists, enqueue without consulting tryAcquire ──
  // A new request must never leapfrog older queued work, even if a slot is free.
  // Only the handoff path (executeWorkOnHeldSlot's outer finally) may start the next task.
  const hasPending = queue.pendingCount(channelId) > 0

  // ── Concurrency cap + per-channel in-flight guard ──────────────────────────
  // Only consult tryAcquire when there is no pending work (FIFO gate takes priority).
  const slotResult = hasPending === false ? concurrency.tryAcquire(channelId) : 'busy'

  if (slotResult === 'cap') {
    // Hard capacity reject — non-admitted, no createRun.
    await request.replySink.send('source', {content: 'fro-bot is at capacity right now — please try again shortly.'})
    return {accepted: false, reason: 'cap'}
  }

  // ── Admission block (fail-closed) ────────────────────────────────────────────
  // For both queued and immediate dispositions, admit the run now:
  //   1. createRun(PENDING) — single creator, ifNoneMatch:'*'
  //   2. runIndex.register — best-effort index entry
  //   3. notifyObserver(PENDING) — SSE shows 'queued'
  // If anything after createRun throws, terminalize to FAILED before propagating.

  const runId = request.runId !== undefined && request.runId !== '' ? request.runId : crypto.randomUUID()
  const now = new Date().toISOString()

  const initialRunState = {
    run_id: runId,
    surface: request.surface,
    thread_id: '', // thread not yet created at admission time; updated after threadFactory runs
    entity_ref: repo,
    phase: 'PENDING' as const,
    started_at: now,
    last_heartbeat: now,
    holder_id: identity,
    details: {channelId, owner: binding.owner, repo: binding.repo},
  }

  const createResult = await createRun(coordinationConfig, identity, repo, initialRunState, coordLogger)
  if (createResult.success === false) {
    logger.error({repo, runId, err: createResult.error.message}, 'run: createRun failed during admission')
    await request.replySink.send('source', {content: 'Could not start the task — please try again.'})
    // Capacity was acquired (slotResult === 'ok') — release it since we're not proceeding.
    if (slotResult === 'ok') {
      concurrency.release(channelId)
    }
    // createRun failed — no run-state to terminalize; just reject admission.
    throw new Error(`createRun failed: ${createResult.error.message}`)
  }

  const adoptionEtag = createResult.data.etag

  // Fail-closed: if register or notifyObserver throws after createRun succeeds,
  // terminalize the just-created run to FAILED so it is never orphaned as PENDING.
  try {
    // Register the run in the server-owned index so privileged routes can resolve
    // runId → {repo, surface} without trusting client-supplied owner/repo.
    // Best-effort: index is optional and register() is synchronous — never blocks execution.
    deps.runIndex?.register(runId, {repo, surface: request.surface, startedAt: now})

    // Notify the observation pipeline of the initial PENDING state.
    // Fire-and-forget: neither a sync throw nor an async rejection must abort admission.
    notifyObserverBestEffort(deps, initialRunState)
  } catch (admissionError: unknown) {
    // Fail-closed: terminalize the run to FAILED before propagating.
    logger.error(
      {repo, runId, err: admissionError instanceof Error ? admissionError.message : String(admissionError)},
      'run: admission block threw after createRun — terminalizing to FAILED',
    )
    await failAdmittedRun(deps, repo, runId, adoptionEtag)
    // Release the slot if we acquired it.
    if (slotResult === 'ok') {
      concurrency.release(channelId)
    }
    throw admissionError
  }

  // ── Dispatch based on disposition ────────────────────────────────────────────

  const task: RunTask = {request, deps, runId, adoptionEtag}

  if (slotResult === 'ok') {
    // Immediate path — slot already acquired; register the run promise in the in-flight set.
    // The gateway in-flight set owns the promise; launchWork returns admission early.
    // Graceful shutdown drains this set.
    //
    // runPromise is also returned in the LaunchAdmission result so callers that need
    // to await the full run (e.g. the Discord adapter for backward compatibility) can
    // do so without polling the in-flight set. The web launch route ignores it.
    const runPromise = executeWorkOnHeldSlot(task).catch((error: unknown) => {
      logger.error(
        {repo, runId, err: error instanceof Error ? error.message : String(error)},
        'run: immediate executeWorkOnHeldSlot failed',
      )
    })
    inFlightRuns.add(runPromise)
    // eslint-disable-next-line no-void
    void runPromise.finally(() => {
      inFlightRuns.delete(runPromise)
    })
    return {accepted: true, runId, runPromise}
  }

  // Queued path (slotResult === 'busy' or hasPending was true).
  // The slot was NOT acquired (tryAcquire returned 'busy' or was skipped due to FIFO gate).
  const enqueueResult = queue.enqueue(channelId, task)

  if (enqueueResult === 'full') {
    // Queue is full — the just-admitted PENDING run-state is now orphaned.
    // Terminalize it to FAILED so the recovery sweep never sees it as a ghost.
    logger.warn({repo, runId, channelId}, 'run: queue full after admission — terminalizing PENDING to FAILED')
    await failAdmittedRun(deps, repo, runId, adoptionEtag)
    await request.replySink.send('source', {
      content: 'The queue is full for this channel — please wait for pending tasks to complete.',
    })
    return {accepted: false, reason: 'queue-full'}
  }

  await ackEnqueueResult(request, enqueueResult)
  return {accepted: true, runId}
}

// ---------------------------------------------------------------------------
// notifyObserverBestEffort — fire-and-forget observer notification
// ---------------------------------------------------------------------------

/**
 * Notify the observation pipeline of a run-state transition.
 * Fire-and-forget: neither a sync throw nor an async rejection must abort the caller.
 */
function notifyObserverBestEffort(deps: RunMentionDeps, state: RunState): void {
  const logger = deps.logger
  try {
    deps.runObserver?.observe(state)?.catch((error: unknown) => {
      logger.warn({err: String(error)}, 'run: runObserver.observe failed')
    })
  } catch (observeError: unknown) {
    logger.warn({err: String(observeError)}, 'run: runObserver.observe threw — continuing (best-effort)')
  }
}

// ---------------------------------------------------------------------------
// failAdmittedRun — terminalize an admitted run to FAILED (best-effort)
// ---------------------------------------------------------------------------

/**
 * Terminalize an admitted run to FAILED.
 *
 * Used by the fail-closed admission block when register/observer throws after
 * `createRun` succeeds, and by the `executeWorkOnHeldSlot` early-abort gates.
 *
 * Uses the provided etag (the latest known etag for this run). Best-effort:
 * a failure to transition is logged but not propagated — the caller's error
 * takes precedence.
 */
async function failAdmittedRun(deps: RunMentionDeps, repo: string, runId: string, currentEtag: string): Promise<void> {
  const {coordinationConfig, identity, logger} = deps
  const coordLogger = toCoordLogger(logger)
  const failResult = await transitionRun(coordinationConfig, identity, repo, runId, 'FAILED', currentEtag, coordLogger)
  if (failResult.success === false) {
    logger.error({repo, runId, err: failResult.error.message}, 'run: failAdmittedRun — transitionRun FAILED failed')
  } else {
    notifyObserverBestEffort(deps, failResult.data.state)
  }
}

// ---------------------------------------------------------------------------
// ackEnqueueResult — send the appropriate ephemeral ack for an enqueue result
// ---------------------------------------------------------------------------

/**
 * Send the appropriate ephemeral ack for an enqueue result.
 * Centralises the two reply strings so they live in exactly one place.
 */
async function ackEnqueueResult(request: LaunchWorkRequest, result: 'queued' | 'full'): Promise<void> {
  if (result === 'queued') {
    await request.replySink.send('source', {content: "Queued — I'll start this when the current task finishes."})
  } else {
    await request.replySink.send('source', {
      content: 'The queue is full for this channel — please wait for pending tasks to complete.',
    })
  }
}

// ---------------------------------------------------------------------------
// runMention — thin Discord adapter
// ---------------------------------------------------------------------------

/**
 * Thin Discord adapter for mention-triggered runs.
 *
 * Maps a Discord `Message` → `LaunchWorkRequest` and calls `launchWork`.
 * This is the ONLY place in the codebase that touches a raw Discord `Message`
 * for execution purposes — the engine (`launchWork`/`executeWorkOnHeldSlot`)
 * is fully transport-neutral.
 *
 * ## Adapter responsibilities
 *
 * 1. **Empty-prompt fail-fast:** strips the bot mention from `message.content`
 *    via `botUserId`. If the result is empty, replies on the SOURCE message
 *    (not a thread) and returns immediately — no thread created, no lock
 *    acquired, no run-state written.
 *
 * 2. **Pre-thread acks:** cap/queue acks go to the source message via
 *    `sendMessage(message, ...)` before a thread exists.
 *
 * 3. **Thread factory:** provides a `threadFactory` on the `LaunchWorkRequest`
 *    that the engine calls after `ensureClone`/`readyz` pass (before lock).
 *    The factory creates the Discord thread, initializes the real
 *    `StatusSink`/`ReplySink` implementations (wrapping `createStatusController`
 *    and `createDiscordStreamSink`), and returns the thread ID.
 *    Thread creation is triggered by the engine at the correct pipeline stage
 *    but the Discord call is owned entirely by this adapter.
 *
 * 4. **Deferred proxy sinks:** before the thread exists, the proxy sinks route
 *    `send('source', ...)` to the source message and no-op everything else.
 *    After `threadFactory` runs, the real sinks take over.
 *
 * ## Hard invariants
 *
 * - `'cap'` is TERMINAL — no queue, no retry.
 * - Internal identifiers (lock etags, holder IDs, workspace URLs, run IDs,
 *   raw errors) are logged but NEVER posted to Discord.
 * - Bearer token (`attachToken`) is never logged.
 * - Every Discord send uses `allowedMentions: {parse: []}` (enforced by `io.ts`).
 */
export async function runMention(message: Message, binding: RepoBinding, deps: RunMentionDeps): Promise<void> {
  const {logger, botUserId} = deps
  const channelId = message.channel.id

  // ── Empty-prompt fail-fast ────────────────────────────────────────────────
  // Strip the bot mention from the message content. If the result is empty,
  // fail fast BEFORE thread/lock/run-state — reply on the source message.
  // This avoids the late EmptyPromptError path (which surfaced in-thread after
  // thread creation and lock acquisition) for the common bare-mention case.
  const mentionPattern = new RegExp(`<@!?${botUserId}>`, 'g')
  const strippedPrompt = message.content.replace(mentionPattern, '').trim()
  if (strippedPrompt.length === 0) {
    await sendMessage(message, {content: 'Nothing to do — please include a task in your message.'}, logger)
    return
  }

  // ── Deferred proxy sinks ──────────────────────────────────────────────────
  // Before the thread exists, proxy sinks route 'source' sends to the message
  // and no-op everything else. After threadFactory runs, real sinks take over.
  let realStatusSink: StatusSink | null = null
  let realReplySink: ReplySink | null = null

  const statusSink: StatusSink = {
    noteActivity: (summary: string) => {
      realStatusSink?.noteActivity(summary)
    },
    setBusy: (busy: boolean) => {
      realStatusSink?.setBusy(busy)
    },
    resolveToAnswer: async (text: string) => {
      if (realStatusSink !== null) return realStatusSink.resolveToAnswer(text)
      return {transition: 'delegated' as const}
    },
    resolveToFailure: async (note: string) => {
      if (realStatusSink !== null) return realStatusSink.resolveToFailure(note)
      return {transition: 'delegated' as const}
    },
    dispose: async () => {
      if (realStatusSink !== null) await realStatusSink.dispose()
    },
    setReaction: state => {
      // eslint-disable-next-line no-void
      void setRunReaction(message, state, logger)
    },
  }

  const replySink: ReplySink = {
    send: async (target, options) => {
      if (target === 'source') return sendMessage(message, options, logger)
      if (realReplySink !== null) return realReplySink.send(target, options)
      return undefined
    },
    append: (text: string) => {
      realReplySink?.append(text)
    },
    flush: async () => {
      if (realReplySink !== null) return realReplySink.flush()
      return undefined
    },
    buffered: () => realReplySink?.buffered() ?? '',
    hasVisibleOutput: () => realReplySink?.hasVisibleOutput() ?? false,
    markVisibleOutputSent: () => {
      realReplySink?.markVisibleOutputSent()
    },
    markVisibleOutputPending: () => {
      if (realReplySink !== null) return realReplySink.markVisibleOutputPending()
      return (_delivered: boolean) => {
        /* no-op settle handle — thread not yet created */
      }
    },
  }

  // ── Thread factory ────────────────────────────────────────────────────────
  // Called by the engine after ensureClone/readyz pass, before lock acquisition.
  // Creates the Discord thread, initializes real sinks, returns the thread ID.
  // The engine never imports Discord types — it only calls this opaque factory.
  const threadFactory: LaunchWorkRequest['threadFactory'] = async () => {
    let rawThread: Awaited<ReturnType<Message['startThread']>>
    try {
      rawThread = await message.startThread({name: `fro-bot: ${binding.repo}`})
    } catch (threadError) {
      return {ok: false, error: String(threadError)}
    }

    const thread: SinkThread = rawThread

    // Initialize real StatusSink wrapping createStatusController
    const statusController = createStatusController({
      thread: rawThread,
      mode: deps.statusMode,
      logger,
    })
    realStatusSink = {
      noteActivity: (summary: string) => statusController.noteActivity(summary),
      setBusy: (busy: boolean) => statusController.setBusy(busy),
      resolveToAnswer: async (text: string) => statusController.resolveToAnswer(text),
      resolveToFailure: async (note: string) => statusController.resolveToFailure(note),
      dispose: async () => statusController.dispose(),
      setReaction: state => {
        // eslint-disable-next-line no-void
        void setRunReaction(message, state, logger)
      },
    }

    // Initialize real ReplySink wrapping createDiscordStreamSink + sendMessage
    const streamSink = createDiscordStreamSink(thread, {logger})
    realReplySink = {
      send: async (target, options) => {
        if (target === 'source') return sendMessage(message, options, logger)
        return sendMessage(rawThread, options, logger)
      },
      append: (text: string) => streamSink.append(text),
      flush: async () => streamSink.flush(),
      buffered: () => streamSink.buffered(),
      hasVisibleOutput: () => streamSink.hasVisibleOutput(),
      markVisibleOutputSent: () => streamSink.markVisibleOutputSent(),
      markVisibleOutputPending: () => streamSink.markVisibleOutputPending(),
    }

    return {ok: true, threadId: rawThread.id}
  }

  // ── Build the LaunchWorkRequest ───────────────────────────────────────────
  // promptText is the already-stripped prompt (mention removed, trimmed).
  // The engine does not re-strip or re-validate.
  const request: LaunchWorkRequest = {
    promptText: strippedPrompt,
    channelId,
    guildId: message.guild?.id,
    surface: 'discord',
    binding,
    requester: {kind: 'discord-user', userId: message.author.id},
    statusSink,
    replySink,
    threadFactory,
  }

  // ── Delegate to launchWork (the transport-agnostic front door) ────────────
  // Pre-thread acks (cap/queue) go via replySink.send('source', ...) which
  // routes to sendMessage(message, ...) above. The engine handles everything else.
  //
  // launchWork returns a LaunchAdmission result immediately after the run is
  // admitted (or rejected) — it does NOT await the run itself. The gateway
  // in-flight set owns the immediate-path promise.
  //
  // runMention awaits the admission result, then awaits the runPromise (if present)
  // so the Discord event handler sees the run complete before returning. This
  // preserves the existing Discord behavior (reply timing unchanged) while
  // allowing a web launch route to return 202 after admission only.
  const admission = await launchWork(request, deps)

  // For the immediate path, await the run promise so the Discord handler sees
  // the full run lifecycle before returning (reply timing unchanged).
  // For cap/queue/empty-prompt paths, runPromise is absent and this is a no-op.
  if (admission.accepted === true && admission.runPromise !== undefined) {
    await admission.runPromise
  }
}
