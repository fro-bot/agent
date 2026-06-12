import type {CoordinationConfig, Result} from '@fro-bot/runtime'
import type {Message} from 'discord.js'
import type {ApprovalRegistry} from '../approvals/registry.js'
import type {RepoBinding} from '../bindings/types.js'
import type {GatewayLogger} from '../discord/client.js'
import type {SinkThread} from '../discord/streaming.js'
import type {EnsureCloneFailure} from '../workspace-api/ensure-clone.js'
import type {ReadyzResponse, WorkspaceError} from '../workspace-api/types.js'
import type {ConcurrencyRegistry} from './concurrency.js'
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
 * Exactly the three arguments `runMention` takes — the stable contract the queue stores.
 */
export interface RunTask {
  readonly message: Message
  readonly binding: RepoBinding
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

// ---------------------------------------------------------------------------
// startRun — the slot-holding execution pipeline
// ---------------------------------------------------------------------------

/**
 * Execute the post-acquire pipeline for a task.
 *
 * ASSUMES the channel concurrency slot is already held by the caller.
 * Owns: clone → readyz → thread → lock → run-state → heartbeat → execute → cleanup.
 *
 * On completion (success or failure), performs an **atomic handoff**:
 * - Calls `queue.takeNext(channelId)` while the slot is still held.
 * - If a next task exists → starts it on the held slot (no release/re-acquire gap).
 * - If the queue is empty → calls `concurrency.release(channelId)` (only then is the slot freed).
 *
 * The handoff `startRun` is fire-and-forget from the completing run's perspective.
 * Its own outer finally runs the same handoff/release logic, so the chain continues
 * and a thrown handoff still releases.
 */
async function startRun(task: RunTask): Promise<void> {
  const {message, binding, deps} = task
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
  const {approvalRegistry, approvalMode, statusMode, ensureClone, readyz} = deps

  // ── All mutable state that the outer finally needs is declared here so the
  // finally block can always reference channelId regardless of where execution
  // stopped. Async functions never throw synchronously, so the outer try/finally
  // always runs — but keeping these declarations before the try makes the
  // dependency explicit and avoids any ambiguity.
  const channelId = message.channel.id
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
      await sendMessage(message, {content: 'The workspace is not available right now. Please try again later.'}, logger)
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
      await sendMessage(message, {content: 'The workspace is not reachable right now. Please try again later.'}, logger)
      return
    }

    // ── Create response thread ─────────────────────────────────────────────────────────────────

    const runId = crypto.randomUUID()
    let rawThread: Awaited<ReturnType<typeof message.startThread>>
    try {
      rawThread = await message.startThread({name: `fro-bot: ${binding.repo}`})
    } catch (threadError) {
      logger.error({channelId, repo, err: String(threadError)}, 'run: startThread threw — aborting')
      await sendMessage(message, {content: 'Could not start the task — please try again.'}, logger)
      return
    }
    const threadId = rawThread.id
    const thread: SinkThread = rawThread

    // ── Acquire repo lock ─────────────────────────────────────────────────────────────────────────

    const coordLogger = toCoordLogger(logger)
    const lockResult = await acquireLock(coordinationConfig, repo, identity, 'discord', runId, coordLogger)

    if (lockResult.success === false) {
      logger.error({repo, runId, err: lockResult.error.message}, 'run: lock acquisition error')
      await sendMessage(thread, {content: 'Could not start the task — please try again.'}, logger)
      return
    }

    if (lockResult.data.acquired === false) {
      // Lock held — terminal "waiting" reply; do NOT expose holder ID to Discord
      logger.info({repo, runId, holder: lockResult.data.holder?.holder_id ?? 'unknown'}, 'run: lock held by another')
      await sendMessage(
        thread,
        {content: 'Another task is already in progress for this repo. Try again when it completes.'},
        logger,
      )
      return
    }

    // Lock acquired — must release in inner finally
    let lockEtag = lockResult.data.etag

    // ── Run-state lifecycle + heartbeat ────────────────────────────────────────────────────────

    const now = new Date().toISOString()
    const initialRunState = {
      run_id: runId,
      surface: 'discord' as const,
      thread_id: threadId,
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
      await sendMessage(thread, {content: 'Could not start the task — please try again.'}, logger)
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
      await sendMessage(thread, {content: 'Could not start the task — please try again.'}, logger)
      await releaseLock(coordinationConfig, repo, lockEtag, coordLogger)
      return
    }
    runEtag = ackResult.data.etag

    const heartbeat = createHeartbeatController(coordinationConfig, identity, repo, runId, lockEtag, coordLogger)
    heartbeat.start()

    let heartbeatStopped = false
    let sink: ReturnType<typeof createDiscordStreamSink> | null = null

    // ── Status controller — per-run, created after thread is available ────────────────────────
    // Adapts rawThread to StatusThread: discord.js ThreadChannel has .send() and .sendTyping()
    // which structurally satisfy the StatusThread interface. Messages returned by .send() have
    // .edit() and .delete() which satisfy StatusMessage.
    const statusController = createStatusController({
      thread: rawThread,
      mode: statusMode,
      logger,
    })

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
      // eslint-disable-next-line no-void
      void setRunReaction(message, 'working', logger)

      // ── Execute prompt via OpenCode ─────────────────────────────────────────────────────────────────────────────────────────

      const handle = attachOpencode(attachUrl, attachToken)
      sink = createDiscordStreamSink(thread, {logger})
      const promptText = buildDiscordPrompt({
        messageText: message.content,
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
        onPending: request => {
          // Per-request closures — each captures its own sessionID.
          const {requestID, sessionID} = request

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
          // onDeadlineSettled: post a visible timed-out status to the run thread
          // and mark the sink so flush() does not add a misleading _(no output)_.
          approvalRegistry.register({
            requestID,
            sessionID,
            channelID: rawThread.id,
            directory: bindingWithEnsuredPath.workspacePath,
            request,
            effects: {postReply: postReplyForRequest},
            deadlineMs: approvalDeadlineMs,
            onDeadlineSettled: async () => {
              // markVisibleOutputSent AFTER the send succeeds so flush() still
              // adds _(no output)_ if the send fails (user needs the fallback).
              const deadlineResult = await sendMessage(
                rawThread,
                {content: 'Approval timed out — the task could not continue.'},
                logger,
              )
              if (deadlineResult.success === true) {
                sink?.markVisibleOutputSent()
              }
            },
          })

          // Awaiting-approval reaction — best-effort, fire-and-forget.
          // Replaces the working reaction with the awaiting-approval cue.
          // eslint-disable-next-line no-void
          void setRunReaction(message, 'awaiting-approval', logger)

          // Post a visible waiting-for-approval status BEFORE the embed so the
          // user sees the run is blocked even if the embed send is slow.
          // Fire-and-forget: status is best-effort; must not block onPending.
          // .catch() prevents an unhandled rejection if the Discord send fails.
          //
          // Pending-visibility: mark the send as in-flight BEFORE the void send so
          // timeout classification sees it as visible context even if the Discord
          // round-trip has not completed yet. settle(true) on success promotes to
          // permanently delivered; settle(false) on failure retracts the claim.
          const settleWaitingStatus = sink?.markVisibleOutputPending()
          // eslint-disable-next-line no-void
          void sendMessage(rawThread, {content: 'Waiting for tool approval…'}, logger).then(result => {
            if (result.success === true) {
              settleWaitingStatus?.(true)
            } else {
              settleWaitingStatus?.(false)
              logger.warn({requestID, err: result.error.message}, 'run: failed to post waiting-for-approval status')
            }
          })

          // Fire-and-forget: send the embed then attach the render function.
          // rawThread has the full Discord.js API (embeds, components, edit).
          // onPending must not throw (coordinator catches internally anyway).
          //
          // Pending-visibility: same pattern as the waiting-status send above —
          // mark in-flight before the void send, settle on resolution.
          const settleEmbed = sink?.markVisibleOutputPending()
          // eslint-disable-next-line no-void
          void sendMessage<Message>(
            rawThread,
            {embeds: [buildApprovalEmbed(request)], components: [buildApprovalButtons(requestID)]},
            logger,
          ).then(result => {
            if (result.success === true) {
              // Embed send succeeded — settle pending claim as delivered so
              // flush() does not add a misleading _(no output)_.
              settleEmbed?.(true)
              const postedMessage = result.data
              // Attach the render function now that we have a message reference.
              approvalRegistry.attachMessage(
                requestID,
                async (
                  req: import('../approvals/coordinator.js').PermissionRequest,
                  decision: import('../approvals/coordinator.js').PermissionReply,
                  decidedBy: string | null,
                  reason: import('../approvals/coordinator.js').SettlementReason,
                ) => {
                  const editResult = await editMessage(
                    postedMessage,
                    {
                      embeds: [buildSettledEmbed(req, decision, {decidedBy: decidedBy ?? undefined, reason})],
                      components: [],
                    },
                    logger,
                  )
                  if (editResult.success === false) {
                    logger.warn(
                      {requestID: req.requestID, err: editResult.error.message},
                      'run: failed to edit approval message',
                    )
                  }
                },
              )
            } else {
              settleEmbed?.(false)
              logger.warn({requestID, err: result.error.message}, 'run: failed to post approval embed')
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
          sink,
          signal: timeoutSignal,
          logger,
          coordinator,
          approvalMode,
          onActivity: (summary: string) => {
            statusController.noteActivity(summary)
          },
          onBusy: (busy: boolean) => {
            statusController.setBusy(busy)
          },
        })
      } finally {
        // Fail-closed: dispose any still-open coordinator entries so pending approvals
        // don't hang if the run ended (normally or via error) before they were settled.
        coordinator.dispose('run ended')
      }

      // ── Succeeded reaction — best-effort, fire-and-forget ────────────────────────────────────
      // Replaces the working/awaiting reaction with the succeeded cue.
      // eslint-disable-next-line no-void
      void setRunReaction(message, 'succeeded', logger)

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
      const finalText = sink.buffered()
      const answerResult = await statusController.resolveToAnswer(finalText)
      if (answerResult.transition === 'delegated') {
        await sink.flush()
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
      // eslint-disable-next-line no-void
      void setRunReaction(message, 'failed', logger)

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
      // Guard against double-post: sink is null when the error occurred before createDiscordStreamSink.
      if (sink !== null) {
        await sink.flush().catch((flushError: unknown) => {
          logger.warn({repo, runId, err: String(flushError)}, 'run: sink.flush failed in error path')
        })
      }

      // Coarse user message — no internal detail
      const timeoutDuration = formatTimeoutDuration(runTimeoutMs)
      const hasVisibleOutput = sink !== null && sink.hasVisibleOutput() === true
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
      const failureResult = await statusController.resolveToFailure(userMessage).catch((error: unknown) => {
        logger.warn({repo, runId, err: String(error)}, 'run: statusController.resolveToFailure failed — delegating')
        return {transition: 'delegated' as const}
      })
      if (failureResult.transition === 'delegated') {
        const failureSendResult = await sendMessage(thread, {content: userMessage}, logger)
        if (failureSendResult.success === false) {
          logger.warn({repo, runId, err: failureSendResult.error.message}, 'run: failed to send error reply to thread')
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
      await statusController.dispose().catch((error: unknown) => {
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
    // The handed-off startRun is fire-and-forget from this run's perspective so
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
        void startRun(nextTask).catch((error: unknown) => {
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
// runMention — the thin front door
// ---------------------------------------------------------------------------

/**
 * Front door for a mention-triggered run.
 *
 * Decides whether to run immediately or enqueue, in this order:
 * 1. If `queue.pendingCount(channelId) > 0` → enqueue + queued ack (pending work has
 *    priority; never take an immediate slot ahead of it).
 * 2. Else `concurrency.tryAcquire(channelId)`:
 *    - `'ok'`   → `startRun(task)` (slot held).
 *    - `'busy'` → enqueue + queued ack (or "queue is full" if at capacity). Return without blocking.
 *    - `'cap'`  → terminal capacity reply, no enqueue (global cap stays terminal).
 *
 * Hard invariants:
 * - `'cap'` is TERMINAL — no queue, no retry.
 * - Internal identifiers (lock etags, holder IDs, workspace URLs, run IDs,
 *   raw errors) are logged but NEVER posted to Discord.
 * - Bearer token (`attachToken`) is never logged.
 * - Every Discord send uses `allowedMentions: {parse: []}`.
 */
/**
 * Send the appropriate ephemeral ack for an enqueue result.
 * Centralises the two reply strings so they live in exactly one place.
 */
async function ackEnqueueResult(message: Message, result: 'queued' | 'full', logger: GatewayLogger): Promise<void> {
  if (result === 'queued') {
    await sendMessage(message, {content: "Queued — I'll start this when the current task finishes."}, logger)
  } else {
    await sendMessage(
      message,
      {content: 'The queue is full for this channel — please wait for pending tasks to complete.'},
      logger,
    )
  }
}

export async function runMention(message: Message, binding: RepoBinding, deps: RunMentionDeps): Promise<void> {
  const {concurrency, queue, logger} = deps
  const channelId = message.channel.id
  const task: RunTask = {message, binding, deps}

  // ── FIFO gate: if pending work exists, enqueue without consulting tryAcquire ──
  // A new mention must never leapfrog older queued work, even if a slot is free.
  // Only the handoff path (startRun's outer finally) may start the next task.
  if (queue.pendingCount(channelId) > 0) {
    await ackEnqueueResult(message, queue.enqueue(channelId, task), logger)
    return
  }

  // ── Concurrency cap + per-channel in-flight guard ──────────────────────────
  const slotResult = concurrency.tryAcquire(channelId)

  if (slotResult === 'cap') {
    await sendMessage(message, {content: 'fro-bot is at capacity right now — please try again shortly.'}, logger)
    return
  }

  if (slotResult === 'busy') {
    // Channel has an in-flight run — enqueue instead of rejecting.
    await ackEnqueueResult(message, queue.enqueue(channelId, task), logger)
    return
  }

  // Slot acquired — startRun owns the release (via atomic handoff in its outer finally).
  await startRun(task)
}
