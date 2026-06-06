import type {CoordinationConfig, Result} from '@fro-bot/runtime'
import type {Message} from 'discord.js'
import type {ApprovalRegistry} from '../approvals/registry.js'
import type {RepoBinding} from '../bindings/types.js'
import type {GatewayLogger} from '../discord/client.js'
import type {SinkThread} from '../discord/streaming.js'
import type {EnsureCloneFailure} from '../workspace-api/ensure-clone.js'
import type {ReadyzResponse, WorkspaceError} from '../workspace-api/types.js'
import type {ConcurrencyRegistry} from './concurrency.js'

import {acquireLock, createHeartbeatController, createRun, releaseLock, transitionRun} from '@fro-bot/runtime'

import {createPermissionCoordinator} from '../approvals/coordinator.js'
import {buildApprovalButtons, buildApprovalEmbed, buildSettledEmbed} from '../discord/approvals.js'
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
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Send a message to a Discord channel/thread with mentions disabled.
 * ALL Discord sends in this module MUST go through this helper — never call
 * `.send()` directly with user-controlled content.
 */
async function safeSend(target: SinkThread, content: string): Promise<void> {
  await target.send({content, allowedMentions: {parse: []}})
}

/**
 * Reply to the original mention message with mentions disabled.
 */
async function safeReply(message: Message, content: string): Promise<void> {
  await message.reply({content, allowedMentions: {parse: []}})
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
// runMention — the lifecycle wrapper
// ---------------------------------------------------------------------------

/**
 * Execute a mention-triggered OpenCode run with full lifecycle management.
 *
 * Called by `mentions.ts` after authorization and binding lookup succeed.
 * Owns: concurrency registry, thread creation, lock, run-state, heartbeat,
 * execution, and release of all resources in a `finally` block.
 *
 * Hard invariants:
 * - "busy", "cap", "waiting" are TERMINAL — no queue, no retry. * - Internal identifiers (lock etags, holder IDs, workspace URLs, run IDs,
 *   raw errors) are logged but NEVER posted to Discord.
 * - Bearer token (`attachToken`) is never logged.
 * - Every Discord send uses `allowedMentions: {parse: []}`.
 */
export async function runMention(message: Message, binding: RepoBinding, deps: RunMentionDeps): Promise<void> {
  const {concurrency, coordinationConfig, identity, attachUrl, attachToken, runTimeoutMs, botUserId, logger} = deps
  const {approvalRegistry, approvalMode, ensureClone, readyz} = deps
  const channelId = message.channel.id
  const repo = `${binding.owner}/${binding.repo}`

  // ── Budget origin — single source of truth for hard abort and approval deadline ──
  // Captured once at run entry so both the AbortSignal.timeout and the approval
  // deadline clearance are computed from the same wall-clock reference.
  const runStartMs = Date.now()

  // ── Concurrency cap + per-channel in-flight guard ──────────
  // IMPORTANT: ensureClone and readyz are called AFTER this gate so that
  // same-channel mention storms do not each mint GitHub App tokens or call
  // workspace clone before the busy/cap rejection fires.

  const slotResult = concurrency.tryAcquire(channelId)

  if (slotResult === 'cap') {
    await safeReply(message, 'fro-bot is at capacity right now — please try again shortly.')
    return
  }

  if (slotResult === 'busy') {
    await safeReply(message, 'There is already a task running in this channel — please wait for it to finish.')
    return
  }

  // Slot acquired — MUST release in outer finally
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
      await safeReply(message, 'The workspace is not available right now. Please try again later.')
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
      await safeReply(message, 'The workspace is not reachable right now. Please try again later.')
      return
    }

    // ── Create response thread ─────────────────────────────────────────────────────────────────

    const runId = crypto.randomUUID()
    const rawThread = await message.startThread({name: `fro-bot: ${binding.repo}`})
    const threadId = rawThread.id
    const thread: SinkThread = rawThread

    // ── Acquire repo lock ─────────────────────────────────────────────────────────────────────────

    const coordLogger = toCoordLogger(logger)
    const lockResult = await acquireLock(coordinationConfig, repo, identity, 'discord', runId, coordLogger)

    if (lockResult.success === false) {
      logger.error({repo, runId, err: lockResult.error.message}, 'run: lock acquisition error')
      await safeSend(thread, 'Could not start the task — please try again.')
      return
    }

    if (lockResult.data.acquired === false) {
      // Lock held — terminal "waiting" reply; do NOT expose holder ID to Discord
      logger.info({repo, runId, holder: lockResult.data.holder?.holder_id ?? 'unknown'}, 'run: lock held by another')
      await safeSend(thread, 'Another task is already in progress for this repo. Try again when it completes.')
      return
    }

    // Lock acquired — must release in inner finally
    if (lockResult.data.etag === null) {
      logger.error({repo, runId}, 'run: lock acquired without etag')
      await safeSend(thread, 'Could not start the task — please try again.')
      return
    }
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
      await safeSend(thread, 'Could not start the task — please try again.')
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
      await safeSend(thread, 'Could not start the task — please try again.')
      await releaseLock(coordinationConfig, repo, lockEtag, coordLogger)
      return
    }
    runEtag = ackResult.data.etag

    const heartbeat = createHeartbeatController(coordinationConfig, identity, repo, runId, lockEtag, coordLogger)
    heartbeat.start()

    let heartbeatStopped = false
    let sink: ReturnType<typeof createDiscordStreamSink> | null = null

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

      // ── Execute prompt via OpenCode ─────────────────────────────────────────────────────────────────────────────────────────

      const handle = attachOpencode(attachUrl, attachToken)
      sink = createDiscordStreamSink(thread, {logger})
      const promptText = buildDiscordPrompt({
        messageText: message.content,
        owner: bindingWithEnsuredPath.owner,
        repo: bindingWithEnsuredPath.repo,
        botUserId,
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
              await safeSend(rawThread, 'Approval timed out — the task could not continue.')
              sink?.markVisibleOutputSent()
            },
          })

          // Post a visible waiting-for-approval status BEFORE the embed so the
          // user sees the run is blocked even if the embed send is slow.
          // Fire-and-forget: status is best-effort; must not block onPending.
          // .catch() prevents an unhandled rejection if the Discord send fails.
          // eslint-disable-next-line no-void
          void safeSend(rawThread, 'Waiting for tool approval…')
            .then(() => {
              sink?.markVisibleOutputSent()
            })
            .catch((error: unknown) => {
              logger.warn({requestID, err: String(error)}, 'run: failed to post waiting-for-approval status')
            })

          // Fire-and-forget: send the embed then attach the render function.
          // rawThread has the full Discord.js API (embeds, components, edit).
          // onPending must not throw (coordinator catches internally anyway).
          // eslint-disable-next-line no-void
          void rawThread
            .send({
              embeds: [buildApprovalEmbed(request)],
              components: [buildApprovalButtons(requestID)],
              allowedMentions: {parse: []},
            })
            .then(postedMessage => {
              // Embed send succeeded — mark sink visible so flush() does not add
              // a misleading _(no output)_ even if the waiting-status send failed.
              sink?.markVisibleOutputSent()
              // Attach the render function now that we have a message reference.
              approvalRegistry.attachMessage(
                requestID,
                async (
                  req: import('../approvals/coordinator.js').PermissionRequest,
                  decision: import('../approvals/coordinator.js').PermissionReply,
                  decidedBy: string | null,
                  reason: import('../approvals/coordinator.js').SettlementReason,
                ) => {
                  try {
                    await (postedMessage as {edit: (opts: unknown) => Promise<unknown>}).edit({
                      embeds: [buildSettledEmbed(req, decision, {decidedBy: decidedBy ?? undefined, reason})],
                      components: [],
                    })
                  } catch (error) {
                    logger.warn({requestID: req.requestID, err: String(error)}, 'run: failed to edit approval message')
                  }
                },
              )
            })
            .catch((error: unknown) => {
              logger.warn({requestID, err: String(error)}, 'run: failed to post approval embed')
              approvalRegistry.markMessagePostFailed(requestID)
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
        })
      } finally {
        // Fail-closed: dispose any still-open coordinator entries so pending approvals
        // don't hang if the run ended (normally or via error) before they were settled.
        coordinator.dispose('run ended')
      }

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

      await sink.flush()
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
      const userMessage =
        isTimeout === true
          ? 'The task timed out. Please try again.'
          : isReachability === true
            ? 'The workspace is not reachable right now. Please try again later.'
            : isEmptyPrompt === true
              ? 'Nothing to do — please include a task in your message.'
              : isStreamEnded === true
                ? 'The task stream closed unexpectedly. Please try again.'
                : 'The task failed. Please try again.'

      await safeSend(thread, userMessage).catch((error: unknown) => {
        logger.warn({repo, runId, err: String(error)}, 'run: failed to send error reply to thread')
      })
    } finally {
      // Stop heartbeat if not yet stopped (defensive — should not normally happen)
      if (heartbeatStopped === false) {
        await heartbeat.stop().catch(() => {
          /* best-effort */
        })
      }

      // Release lock (best-effort)
      const releaseResult = await releaseLock(coordinationConfig, repo, lockEtag, coordLogger)
      if (releaseResult.success === false) {
        logger.warn({repo, runId, err: releaseResult.error.message}, 'run: releaseLock failed')
      }
    }
  } finally {
    // ALWAYS release the concurrency slot
    concurrency.release(channelId)
  }
}
