import type {CoordinationConfig, Result, Surface} from '@fro-bot/runtime'
import type {Message} from 'discord.js'
import type {ApprovalRegistry} from '../approvals/registry.js'
import type {RepoBinding} from '../bindings/types.js'
import type {GatewayLogger} from '../discord/client.js'
import type {SinkThread} from '../discord/streaming.js'
import type {EnsureCloneFailure} from '../workspace-api/ensure-clone.js'
import type {ReadyzResponse, WorkspaceError} from '../workspace-api/types.js'
import type {ConcurrencyRegistry} from './concurrency.js'
import type {LaunchWorkRequest, ReplySink, StatusSink} from './launch-types.js'
import type {ChannelQueue} from './queue.js'

import {acquireLock, createHeartbeatController, createRun, releaseLock, transitionRun} from '@fro-bot/runtime'

import {createPermissionCoordinator} from '../approvals/coordinator.js'
import {buildApprovalButtons, buildApprovalEmbed, buildSettledEmbed} from '../discord/approvals.js'
import {editMessage, sendMessage} from '../discord/io.js'
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
 */
export interface RunTask {
  readonly request: LaunchWorkRequest
  readonly deps: RunMentionDeps
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

// (Unit 2 DiscordAdapterBridge removed in Unit 3 — thread creation now in adapter via threadFactory)

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

  // ── Budget origin — single source of truth for hard abort and approval deadline ──
  // Captured once at run entry so both the AbortSignal.timeout and the approval
  // deadline clearance are computed from the same wall-clock reference.
  const runStartMs = Date.now()

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
      await request.replySink.send('source', {
        content: 'The workspace is not reachable right now. Please try again later.',
      })
      return
    }

    // ── Thread factory (transport-specific, optional) ─────────────────────────────────────────
    // Called after gates pass, before lock acquisition. The Discord adapter provides this to
    // create the response thread at the right pipeline stage. Non-Discord callers (in-memory
    // sinks, future web transports) omit it — the engine uses an empty thread ID in run-state.
    let threadId = ''
    if (request.threadFactory !== undefined) {
      const threadResult = await request.threadFactory()
      if (threadResult.ok === false) {
        logger.error({channelId, repo, err: threadResult.error}, 'run: threadFactory failed — aborting')
        await request.replySink.send('source', {content: 'Could not start the task — please try again.'})
        return
      }
      threadId = threadResult.threadId
    }

    const runId = crypto.randomUUID()

    // ── Acquire repo lock ─────────────────────────────────────────────────────────────────────────

    const coordLogger = toCoordLogger(logger)
    const lockResult = await acquireLock(
      coordinationConfig,
      repo,
      identity,
      request.surface as Surface,
      runId,
      coordLogger,
    )

    if (lockResult.success === false) {
      logger.error({repo, runId, err: lockResult.error.message}, 'run: lock acquisition error')
      await request.replySink.send('thread', {content: 'Could not start the task — please try again.'})
      return
    }

    if (lockResult.data.acquired === false) {
      // Lock held — terminal "waiting" reply; do NOT expose holder ID to Discord
      logger.info({repo, runId, holder: lockResult.data.holder?.holder_id ?? 'unknown'}, 'run: lock held by another')
      await request.replySink.send('thread', {
        content: 'Another task is already in progress for this repo. Try again when it completes.',
      })
      return
    }

    // Lock acquired — must release in inner finally
    let lockEtag = lockResult.data.etag

    // ── Run-state lifecycle + heartbeat ────────────────────────────────────────────────────────

    const now = new Date().toISOString()
    const initialRunState = {
      run_id: runId,
      surface: request.surface as Surface,
      thread_id: threadId, // empty string for non-Discord/in-memory paths
      entity_ref: repo,
      phase: 'PENDING' as const,
      started_at: now,
      last_heartbeat: now,
      holder_id: identity,
      details: {channelId, owner: binding.owner, repo: binding.repo},
    }

    const createResult = await createRun(coordinationConfig, identity, repo, initialRunState, coordLogger)
    if (createResult.success === false) {
      logger.error({repo, runId, err: createResult.error.message}, 'run: createRun failed')
      await request.replySink.send('thread', {content: 'Could not start the task — please try again.'})
      await releaseLock(coordinationConfig, repo, lockEtag, coordLogger)
      return
    }

    let runEtag = createResult.data.etag

    const ackResult = await transitionRun(
      coordinationConfig,
      identity,
      repo,
      runId,
      'ACKNOWLEDGED',
      runEtag,
      coordLogger,
    )
    if (ackResult.success === false) {
      logger.error({repo, runId, err: ackResult.error.message}, 'run: transitionRun ACKNOWLEDGED failed')
      await request.replySink.send('thread', {content: 'Could not start the task — please try again.'})
      await releaseLock(coordinationConfig, repo, lockEtag, coordLogger)
      return
    }
    runEtag = ackResult.data.etag

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

      // ── Working reaction — best-effort, fire-and-forget ───────────────────────────────────────────────────────────────────
      statusSink.setReaction('working')

      // ── Execute prompt via OpenCode ─────────────────────────────────────────────────────────────────────────────────────────

      const handle = attachOpencode(attachUrl, attachToken)
      const promptText = buildDiscordPrompt({
        messageText: request.promptText,
        owner: bindingWithEnsuredPath.owner,
        repo: bindingWithEnsuredPath.repo,
        botUserId,
        persona,
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

      const coordinator = createPermissionCoordinator({
        logger,
        onPending: req => {
          // Per-request closures — each captures its own sessionID.
          const {requestID, sessionID} = req

          // postReply: call the OpenCode SDK permission reply endpoint.
          // Uses the session-scoped API: POST /session/{id}/permissions/{permissionID}
          // A 10 s AbortSignal.timeout ensures we never hang indefinitely.
          const postReplyForRequest = async (
            rID: string,
            directory: string,
            decision: import('../approvals/coordinator.js').PermissionReply,
          ) => {
            // FIX 4: Use AbortSignal.timeout(10_000) passed directly to the SDK call.
            // This avoids the dangling-timer leak from the old Promise.race approach
            // (where the losing setTimeout would remain armed for 10 s after the SDK
            // call resolved). AbortSignal.timeout is self-cleaning — no manual
            // clearTimeout needed. The SDK's Config extends RequestInit which includes
            // signal?: AbortSignal | null, so this is type-safe.
            try {
              const res = await handle.client.postSessionIdPermissionsPermissionId({
                path: {id: sessionID, permissionID: rID},
                body: {response: decision},
                query: {directory},
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

          // register-before-send: register the entry in the shared registry
          // BEFORE attempting the Discord embed post. This ensures the button
          // handler can look up the entry even if the send is still in-flight.
          // Registry owns the deadline timer (single-owner rule).
          //
          // channelID: use threadId (set by threadFactory after thread creation).
          // For non-Discord paths (in-memory sinks), threadId is '' — the registry
          // still works; the channelID is only used for button-handler lookup.
          //
          // onDeadlineSettled: post a visible timed-out status via replySink.send
          // and mark the sink so flush() does not add a misleading _(no output)_.
          approvalRegistry.register({
            requestID,
            sessionID,
            channelID: threadId,
            directory: bindingWithEnsuredPath.workspacePath,
            request: req,
            effects: {postReply: postReplyForRequest},
            deadlineMs: approvalDeadlineMs,
            onDeadlineSettled: async () => {
              // markVisibleOutputSent AFTER the send succeeds so flush() still
              // adds _(no output)_ if the send fails (user needs the fallback).
              // replySink.send returns unknown; cast to check success (Discord impl
              // returns Result<Message, {message: string}> — one documented cast).
              const deadlineResult = await replySink.send('thread', {
                content: 'Approval timed out — the task could not continue.',
              })
              const dr = deadlineResult as {success?: boolean} | undefined
              if (dr?.success === true) {
                replySink.markVisibleOutputSent()
              }
            },
          })

          // Awaiting-approval reaction — best-effort, fire-and-forget.
          // Replaces the working reaction with the awaiting-approval cue.
          statusSink.setReaction('awaiting-approval')

          // Post a visible waiting-for-approval status BEFORE the embed so the
          // user sees the run is blocked even if the embed send is slow.
          // Fire-and-forget: status is best-effort; must not block onPending.
          // .catch() prevents an unhandled rejection if the Discord send fails.
          //
          // Pending-visibility: mark the send as in-flight BEFORE the void send so
          // timeout classification sees it as visible context even if the Discord
          // round-trip has not completed yet. settle(true) on success promotes to
          // permanently delivered; settle(false) on failure retracts the claim.
          const settleWaitingStatus = replySink.markVisibleOutputPending()
          // eslint-disable-next-line no-void
          void replySink.send('thread', {content: 'Waiting for tool approval…'}).then(result => {
            // replySink.send returns unknown; cast to check success (one documented cast).
            const r = result as {success?: boolean; error?: {message: string}} | undefined
            if (r?.success === true) {
              settleWaitingStatus(true)
            } else {
              settleWaitingStatus(false)
              logger.warn(
                {requestID, err: r?.error?.message ?? 'unknown'},
                'run: failed to post waiting-for-approval status',
              )
            }
          })

          // Fire-and-forget: send the embed then attach the render function.
          // onPending must not throw (coordinator catches internally anyway).
          //
          // Pending-visibility: same pattern as the waiting-status send above —
          // mark in-flight before the void send, settle on resolution.
          //
          // replySink.send returns unknown; cast to get the posted message reference
          // for attachMessage (Discord impl returns Result<Message, ...>).
          // This is the one documented cast in the engine — Phase B will widen
          // ReplySink.send to return a typed result when needed.
          const settleEmbed = replySink.markVisibleOutputPending()
          // eslint-disable-next-line no-void
          void replySink
            .send('thread', {embeds: [buildApprovalEmbed(req)], components: [buildApprovalButtons(requestID)]})
            .then(result => {
              const r = result as {success?: boolean; data?: Message; error?: {message: string}} | undefined
              if (r?.success === true) {
                // Embed send succeeded — settle pending claim as delivered so
                // flush() does not add a misleading _(no output)_.
                settleEmbed(true)
                const postedMessage = r.data
                if (postedMessage !== undefined) {
                  // Attach the render function now that we have a message reference.
                  approvalRegistry.attachMessage(
                    requestID,
                    async (
                      permReq: import('../approvals/coordinator.js').PermissionRequest,
                      decision: import('../approvals/coordinator.js').PermissionReply,
                      decidedBy: string | null,
                      reason: import('../approvals/coordinator.js').SettlementReason,
                    ) => {
                      const editResult = await editMessage(
                        postedMessage,
                        {
                          embeds: [buildSettledEmbed(permReq, decision, {decidedBy: decidedBy ?? undefined, reason})],
                          components: [],
                        },
                        logger,
                      )
                      if (editResult.success === false) {
                        logger.warn(
                          {requestID: permReq.requestID, err: editResult.error.message},
                          'run: failed to edit approval message',
                        )
                      }
                    },
                  )
                }
              } else {
                settleEmbed(false)
                logger.warn({requestID, err: r?.error?.message ?? 'unknown'}, 'run: failed to post approval embed')
                approvalRegistry.markMessagePostFailed(requestID)
              }
            })
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
          sink: replySink as unknown as import('../discord/streaming.js').DiscordStreamSink,
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
      concurrency.release(channelId)
    } else {
      const nextTask = queue.takeNext(channelId)
      if (nextTask === undefined) {
        // Queue is empty — release the slot now.
        concurrency.release(channelId)
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

/**
 * Public front door for launching a unit of work.
 *
 * Transport-agnostic: accepts a `LaunchWorkRequest` with pre-constructed
 * `StatusSink` and `ReplySink` implementations. The Discord adapter
 * (`runMention`) calls this after mapping a Discord `Message` → `LaunchWorkRequest`.
 * A future web adapter (Phase B) will call this directly.
 *
 * Enforces the per-channel FIFO queue and global concurrency cap. A future
 * web caller goes through THIS and cannot bypass the queue/cap.
 *
 * Decides whether to run immediately or enqueue, in this order:
 * 1. If `queue.pendingCount(channelId) > 0` → enqueue + queued ack (pending work has
 *    priority; never take an immediate slot ahead of it).
 * 2. Else `concurrency.tryAcquire(channelId)`:
 *    - `'ok'`   → `executeWorkOnHeldSlot(task)` (slot held).
 *    - `'busy'` → enqueue + queued ack (or "queue is full" if at capacity). Return without blocking.
 *    - `'cap'`  → terminal capacity reply, no enqueue (global cap stays terminal).
 *
 * Hard invariants:
 * - `'cap'` is TERMINAL — no queue, no retry.
 * - Internal identifiers (lock etags, holder IDs, workspace URLs, run IDs,
 *   raw errors) are logged but NEVER posted to the transport.
 * - Bearer token (`attachToken`) is never logged.
 *
 * @param request - Transport-neutral engine input (prompt, sinks, binding, identity).
 * @param deps - Runtime dependencies (concurrency, queue, coordination config, etc.).
 */
export async function launchWork(request: LaunchWorkRequest, deps: RunMentionDeps): Promise<void> {
  const {concurrency, queue} = deps
  const channelId = request.channelId
  const task: RunTask = {request, deps}

  // ── FIFO gate: if pending work exists, enqueue without consulting tryAcquire ──
  // A new request must never leapfrog older queued work, even if a slot is free.
  // Only the handoff path (executeWorkOnHeldSlot's outer finally) may start the next task.
  if (queue.pendingCount(channelId) > 0) {
    const enqueueResult = queue.enqueue(channelId, task)
    await ackEnqueueResult(request, enqueueResult)
    return
  }

  // ── Concurrency cap + per-channel in-flight guard ──────────────────────────
  const slotResult = concurrency.tryAcquire(channelId)

  if (slotResult === 'cap') {
    await request.replySink.send('source', {content: 'fro-bot is at capacity right now — please try again shortly.'})
    return
  }

  if (slotResult === 'busy') {
    // Channel has an in-flight run — enqueue instead of rejecting.
    const enqueueResult = queue.enqueue(channelId, task)
    await ackEnqueueResult(request, enqueueResult)
    return
  }

  // Slot acquired — executeWorkOnHeldSlot owns the release (via atomic handoff in its outer finally).
  await executeWorkOnHeldSlot(task)
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
// runMention — thin Discord adapter (Unit 3)
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
 * 1. **Empty-prompt fail-fast (accepted Phase A behavior change):** strips the
 *    bot mention from `message.content` via `botUserId`. If the result is empty,
 *    replies on the SOURCE message (not a thread) and returns immediately — no
 *    thread created, no lock acquired, no run-state written.
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

  // ── Empty-prompt fail-fast (accepted Phase A behavior change) ─────────────
  // Strip the bot mention from the message content. If the result is empty,
  // fail fast BEFORE thread/lock/run-state — reply on the source message.
  // This deliberately changes the Unit 0 baseline behavior (which surfaced
  // EmptyPromptError late in-thread after thread creation and lock acquisition).
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
    surface: 'discord', // Phase B: 'web' — one documented cast in engine (request.surface as Surface)
    binding,
    requester: {kind: 'discord-user', userId: message.author.id},
    statusSink,
    replySink,
    threadFactory,
  }

  // ── Delegate to launchWork (the transport-agnostic front door) ────────────
  // Pre-thread acks (cap/queue) go via replySink.send('source', ...) which
  // routes to sendMessage(message, ...) above. The engine handles everything else.
  await launchWork(request, deps)
}
