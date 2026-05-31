import type {CoordinationConfig} from '@fro-bot/runtime'
import type {Message} from 'discord.js'
import type {RepoBinding} from '../bindings/types.js'
import type {GatewayLogger} from '../discord/client.js'
import type {SinkThread} from '../discord/streaming.js'
import type {ConcurrencyRegistry} from './concurrency.js'

import {acquireLock, createHeartbeatController, createRun, releaseLock, transitionRun} from '@fro-bot/runtime'

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
  const channelId = message.channel.id
  const repo = `${binding.owner}/${binding.repo}`

  // ── Concurrency cap + per-channel in-flight guard ──────────

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
      const sink = createDiscordStreamSink(thread, {logger})
      const promptText = buildDiscordPrompt({
        messageText: message.content,
        owner: binding.owner,
        repo: binding.repo,
        botUserId,
      })
      const timeoutSignal = AbortSignal.timeout(runTimeoutMs)

      await runOpenCodeCore({
        handle,
        directory: binding.workspacePath,
        promptText,
        sink,
        signal: timeoutSignal,
        logger,
      })

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
