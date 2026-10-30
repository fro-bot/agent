/**
 * Stopping what a run left running in its directory, on OpenCode V2: the sibling of `root-stop.ts`.
 *
 * `POST /api/session/:id/interrupt` is a request, and its reply cannot be read as a stop (`{interrupted: false}` is also
 * what a prompt that is not admitted yet returns, probe P1). `DELETE /api/shell/:id` answers 204 for an unknown id, and a
 * shell it kills queues an `error` notice that WAKES the shell's owner (probe p22). Neither reply proves anything, and
 * stock v2.2.0 offers no route that does. So the stop is never "confirmed" from a reply or from the run's own ledger. The
 * stop acts on what the DIRECTORY shows (`observeDirectoryV2`), and whether it worked is decided by the directory staying
 * quiet for a window (`directory-quiescence-v2.ts`).
 *
 * This module is the acting half:
 * - `stopDirectoryActivityV2` takes one reading's activity and kills every running shell, then interrupts every active
 *   session, the root first. Shells go first because each kill wakes its owner, which the interrupt then stops. The
 *   DELETEs and the interrupts each have a bound of their own, so a DELETE that never answers cannot leave the
 *   interrupts with a signal that is already dead.
 * - `startQuarantineWatchV2` repeats that for the whole quarantine hold of a stop that could not be confirmed.
 *
 * Every session and shell in the directory is treated as the run's: nothing else shares a gateway checkout directory.
 */

import type {DirectoryActivity, RemoteOpenCodeV2Client} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

import {observeDirectoryV2, toErrorMessage} from '@fro-bot/runtime'
import {
  QUARANTINE_HOLD_WINDOW_MS,
  ROOT_QUIESCENCE_POLL_INTERVAL_MS,
  ROOT_WATCH_REQUEST_TIMEOUT_MS,
} from './root-stop.js'

/** The longest the shell DELETEs of one stop may take together. Its own bound: a stalled DELETE must not use up more. */
export const STOP_DELETE_TIMEOUT_MS = 2_000
/** The longest the session interrupts of one stop may take together. A fresh bound, whatever the DELETEs did. */
export const STOP_INTERRUPT_TIMEOUT_MS = 3_000

/** Room beyond the reading and the two stop bounds before a sweep is given up on. */
const SWEEP_SLACK_MS = 1_000

/** The two calls the acting half makes; the real V2 client satisfies it. */
export type DirectoryStopClientV2 = Pick<RemoteOpenCodeV2Client, 'deleteShell' | 'interrupt'>

/**
 * Interrupt one session. Best-effort: a failed request is not a reason to abort the stop, and the next reading of the
 * directory shows whether it worked. Never throws.
 */
export async function interruptSession(
  client: Pick<RemoteOpenCodeV2Client, 'interrupt'>,
  sessionId: string,
  signal: AbortSignal,
  logger: GatewayLogger,
  role: 'owned' | 'root',
): Promise<void> {
  try {
    const result = await client.interrupt({sessionId, signal})
    if (!result.success) {
      logger.warn(
        {sessionId, role, error: result.error.kind},
        'settle-owned-sessions: session interrupt returned an error',
      )
      return
    }
    if (!result.data.interrupted) {
      // Not a stop and not a failure: nothing active was interrupted.
      logger.debug({sessionId, role, interrupted: false}, 'settle-owned-sessions: session interrupt was a no-op')
    }
  } catch (error) {
    logger.warn({sessionId, role, detail: toErrorMessage(error)}, 'settle-owned-sessions: session interrupt threw')
  }
}

export interface StopDirectoryActivityOptions {
  readonly client: DirectoryStopClientV2
  readonly rootSessionId: string
  readonly directory: string
  /** What one reading of the directory showed. */
  readonly activity: DirectoryActivity
  /** Interrupt the root even if the reading did not show it, for a root whose prompt may not be admitted yet. */
  readonly alwaysInterruptRoot?: boolean
  /**
   * The life of the stop: the barrier's budget or the quarantine hold. It is NOT the signal of the requests. The DELETEs
   * and the interrupts each get a bound of their own, derived from it, so a stalled DELETE cannot starve an interrupt.
   * Once it aborts, nothing more is sent.
   */
  readonly signal: AbortSignal
  readonly logger: GatewayLogger
  /** Overrides `STOP_DELETE_TIMEOUT_MS`. */
  readonly deleteTimeoutMs?: number
  /** Overrides `STOP_INTERRUPT_TIMEOUT_MS`. */
  readonly interruptTimeoutMs?: number
}

/** A signal that aborts when `parent` does or after `ms`, whichever is first, and a way to release it. */
function boundedSignal(parent: AbortSignal, ms: number): {readonly signal: AbortSignal; readonly release: () => void} {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (parent.aborted) controller.abort()
  else parent.addEventListener('abort', abort, {once: true})
  const timer = setTimeout(abort, ms)
  timer.unref()
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer)
      parent.removeEventListener('abort', abort)
    },
  }
}

/**
 * Kill every running shell of the directory, then interrupt every active session, the root first. A queued inbox item is
 * left alone: only a wake that has started can be interrupted, and the next reading sees it. Best-effort and never
 * throws: a failed DELETE or interrupt shows up as activity in the next reading.
 *
 * The DELETEs go first because each kill wakes its owner, which the interrupt then stops. They have a bound of their
 * own, and the interrupts get a fresh one when they start, so a DELETE that never answers costs the interrupts nothing
 * but the wait.
 */
export async function stopDirectoryActivityV2(options: StopDirectoryActivityOptions): Promise<void> {
  const {
    client,
    rootSessionId,
    directory,
    activity,
    alwaysInterruptRoot = false,
    signal,
    logger,
    deleteTimeoutMs = STOP_DELETE_TIMEOUT_MS,
    interruptTimeoutMs = STOP_INTERRUPT_TIMEOUT_MS,
  } = options

  if (activity.runningShellIds.length > 0 && !signal.aborted) {
    const deletes = boundedSignal(signal, deleteTimeoutMs)
    try {
      await Promise.all(
        activity.runningShellIds.map(async shellId => {
          try {
            const result = await client.deleteShell({directory, shellId, signal: deletes.signal})
            if (!result.success) {
              logger.warn({shellId, error: result.error.kind}, 'settle-owned-sessions: shell delete returned an error')
            }
          } catch (error) {
            logger.warn({shellId, detail: toErrorMessage(error)}, 'settle-owned-sessions: shell delete threw')
          }
        }),
      )
    } finally {
      deletes.release()
    }
  }

  if (signal.aborted) return
  const interrupts = boundedSignal(signal, interruptTimeoutMs)
  try {
    const rootActive = activity.activeSessionIds.includes(rootSessionId)
    // Issued together, the root first: one that never answers must not hold up the others.
    await Promise.allSettled([
      ...(rootActive || alwaysInterruptRoot
        ? [interruptSession(client, rootSessionId, interrupts.signal, logger, 'root')]
        : []),
      ...activity.activeSessionIds
        .filter(sessionId => sessionId !== rootSessionId)
        .map(async sessionId => interruptSession(client, sessionId, interrupts.signal, logger, 'owned')),
    ])
  } finally {
    interrupts.release()
  }
}

export interface QuarantineWatchV2Options {
  readonly client: RemoteOpenCodeV2Client
  readonly directory: string
  readonly rootSessionId: string
  /** Owned sessions stored somewhere else now (a move): stopped while active, whatever the directory places. */
  readonly knownSessionIds?: () => readonly string[]
  readonly logger: GatewayLogger
  readonly runId?: string
  readonly windowMs?: number
  readonly pollIntervalMs?: number
}

/**
 * Keeps stopping the directory for the whole quarantine hold: every tick reads it (without the inbox, which cannot be
 * acted on), kills every running shell and interrupts every active session. It never ends on a quiet reading, because a
 * paused producer can wake a session at any point in the hold; only the window closes it. A window timer ends it even if
 * a request hangs, every request is bounded, and the timers are unref'd.
 *
 * @returns `stop`, which ends the watch early. Safe to call more than once.
 */
export function startQuarantineWatchV2(options: QuarantineWatchV2Options): () => void {
  const {
    client,
    directory,
    windowMs = QUARANTINE_HOLD_WINDOW_MS,
    pollIntervalMs = ROOT_QUIESCENCE_POLL_INTERVAL_MS,
    rootSessionId,
    knownSessionIds,
    logger: baseLogger,
    runId,
  } = options
  const logger: GatewayLogger =
    runId === undefined
      ? baseLogger
      : {
          debug: (context, message) => baseLogger.debug({runId, ...context}, message),
          info: (context, message) => baseLogger.info({runId, ...context}, message),
          warn: (context, message) => baseLogger.warn({runId, ...context}, message),
          error: (context, message) => baseLogger.error({runId, ...context}, message),
        }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let windowTimer: ReturnType<typeof setTimeout> | undefined
  let ended = false
  let sweeps = 0

  function end(): void {
    if (ended) return
    ended = true
    if (timer !== undefined) clearTimeout(timer)
    if (windowTimer !== undefined) clearTimeout(windowTimer)
    timer = undefined
    controller.abort()
  }

  windowTimer = setTimeout(() => {
    if (ended) return
    logger.warn({rootSessionId, sweeps}, 'root-watch: quarantine hold ended')
    end()
  }, windowMs)
  windowTimer.unref()

  /** One sweep bounded by its own cap; a hung request resolves instead of stalling the watch. */
  async function boundedSweep(): Promise<void> {
    const requestController = new AbortController()
    const forward = (): void => requestController.abort()
    controller.signal.addEventListener('abort', forward, {once: true})
    let capTimer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<void>(resolve => {
      capTimer = setTimeout(
        () => {
          requestController.abort()
          resolve()
        },
        ROOT_WATCH_REQUEST_TIMEOUT_MS + STOP_DELETE_TIMEOUT_MS + STOP_INTERRUPT_TIMEOUT_MS + SWEEP_SLACK_MS,
      )
      capTimer.unref()
    })
    const sweep = async (): Promise<void> => {
      const observation = await observeDirectoryV2({
        client,
        directory,
        signal: requestController.signal,
        inbox: false,
        ...(knownSessionIds === undefined ? {} : {knownSessionIds}),
        readTimeoutMs: ROOT_WATCH_REQUEST_TIMEOUT_MS,
      })
      // A partial reading is acted on too: what it did show is still there to stop.
      if (observation.kind === 'quiescent') return
      const {activity} = observation
      if (activity.activeSessionIds.length === 0 && activity.runningShellIds.length === 0) return
      sweeps += 1
      logger.warn(
        {
          rootSessionId,
          sweeps,
          activeSessionCount: activity.activeSessionIds.length,
          runningShellCount: activity.runningShellIds.length,
        },
        'root-watch: the directory is active during the quarantine hold — stopping it again',
      )
      // The watch's life, not the reading's capped signal: the stop's DELETEs and interrupts have bounds of their own.
      await stopDirectoryActivityV2({client, rootSessionId, directory, activity, signal: controller.signal, logger})
    }
    try {
      await Promise.race([sweep().catch(() => undefined), capped])
    } finally {
      if (capTimer !== undefined) clearTimeout(capTimer)
      controller.signal.removeEventListener('abort', forward)
    }
  }

  async function tick(): Promise<void> {
    timer = undefined
    if (ended) return
    await boundedSweep()
    if (ended) return
    timer = setTimeout(() => {
      // eslint-disable-next-line no-void
      void tick()
    }, pollIntervalMs)
    timer.unref()
  }

  timer = setTimeout(() => {
    // eslint-disable-next-line no-void
    void tick()
  }, pollIntervalMs)
  timer.unref()
  return end
}
