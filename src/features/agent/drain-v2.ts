import type {
  ActionOpenCodeV2Client,
  DirectoryActivity,
  DirectoryStabilityTuning,
  OpenCodeV2ServerHandle,
  OpenCodeV2ShutdownResult,
  OwnershipLedger,
} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import {
  awaitDirectoryStability,
  createDirectoryStabilityGate,
  DIRECTORY_QUIESCENCE_MIN_SPACING_MS,
  isShellLedgerKey,
  observeDirectoryV2,
} from '@fro-bot/runtime'
import {toErrorMessage} from '../../shared/errors.js'
import {reconcileOwnedWorkV2} from './reconcile-v2.js'

/**
 * Releasing a run on OpenCode V2: the Action's sibling of the gateway's `run-core-v2` release machinery (#1985).
 *
 * Why the directory decides and the ledger does not. Stock v2.2.0 gives no way to prove that nothing the run started can
 * still wake one of its sessions: a background child's notice and a shell's exit queue an inbox item and wake the owner
 * in a step the event stream does not show (probe P2), the global active list does not list a session whose only
 * activity is a background job, and an `interrupt` reply is a delivery receipt. So the run is released when the run's
 * DIRECTORY has shown no active session, no running shell and no queued inbox item for a stability window
 * (`createDirectoryStabilityGate`), and the ledger, the notices and the reconcile passes are inputs to the wait, never
 * the verdict.
 *
 * Two paths, one verdict:
 * - Drain (the root succeeded): wait while owned work is observed running, then require the directory quiet. Bounded.
 * - Stop (deadline, cancel, failure, or a drain that ran out): DELETE every running shell of the directory, interrupt
 *   every active session, the root first, read again, and repeat until the same gate passes. A stop is never confirmed
 *   from a reply.
 * Either way the server is shut down afterwards (`handle.shutdown`: interrupt owned sessions with reason `user`, close
 * stdin, confirm the exit), and only a directory that was confirmed quiet is saved.
 *
 * Kept Action-side, not moved to runtime, on purpose. `stopDirectoryActivityV2` and `reconcileLivePass` are gateway
 * code written against the gateway's pino-shaped logger and its quarantine policy; moving them would reshape the
 * gateway's logging and tests for ~100 lines the Action can own. The pieces both share already live in runtime
 * (`observeDirectoryV2`, `createDirectoryStabilityGate`, `awaitDirectoryStability`, `reconcileShellsOnce`).
 */

/** The longest the shell DELETEs of one stop may take together. A stalled DELETE must not use up more. */
export const STOP_DELETE_TIMEOUT_MS = 2_000
/** The longest the session interrupts of one stop may take together. A fresh bound, whatever the DELETEs did. */
export const STOP_INTERRUPT_TIMEOUT_MS = 3_000
/**
 * Bound on one confirmed stop (acting plus the stability window, which alone is about 5 s). A fresh budget, not a
 * remainder of the run's: the run's own deadline has usually passed by the time a stop is needed.
 */
export const STOP_CONFIRM_TIMEOUT_MS = 30_000
/**
 * Bound on the whole pre-shutdown phase (the run summary write and the prune). Its own teardown budget: the run's
 * deadline has usually passed by now, and this phase must never be the reason the server stays up.
 */
export const PRE_SHUTDOWN_TIMEOUT_MS = 20_000
/** Bound on each request inside the pre-shutdown phase. */
export const PRE_SHUTDOWN_REQUEST_TIMEOUT_MS = 5_000
/**
 * With no deadline, how many consecutive reconcile passes may observe no owned work running before the drain stops
 * waiting (V1's `UNOBSERVABLE_PASSES_BEFORE_DRAIN_EXIT`). Work that cannot be seen cannot be waited on.
 */
export const UNOBSERVABLE_PASSES_BEFORE_DRAIN_EXIT = 3
/** With no deadline, how many consecutive directory readings may fail before the drain stops waiting. */
export const UNREADABLE_READINGS_BEFORE_DRAIN_EXIT = 20
const DEFAULT_DRAIN_POLL_INTERVAL_MS = 250

/** What a release needs to know about the run. */
export interface DirectoryReleaseContext {
  readonly client: ActionOpenCodeV2Client
  /** The location the run's sessions and shells live in: the directory the server was started and gated for. */
  readonly directory: string
  /** The root session, or `null` when none was created (a failure before it existed). */
  readonly rootSessionId: string | null
  /** The run's ownership ledger, when execution got far enough to have one. */
  readonly ledger: OwnershipLedger | undefined
  /** When the run began (epoch ms): which sessions' inboxes a reading reads. */
  readonly runStartedAt: number
  readonly logger: Logger
  /** Overrides the stability window. For tests only. */
  readonly stability?: DirectoryStabilityTuning
}

/** The root and every session the ledger tracks, in any state. Background shells are not sessions. */
export function ownedSessionIdsOfRun(context: Pick<DirectoryReleaseContext, 'ledger' | 'rootSessionId'>): string[] {
  const owned = (context.ledger?.snapshot() ?? []).flatMap(entry =>
    isShellLedgerKey(entry.sessionId) ? [] : [entry.sessionId],
  )
  return context.rootSessionId === null ? owned : [context.rootSessionId, ...owned]
}

async function observe(context: DirectoryReleaseContext, signal: AbortSignal) {
  return observeDirectoryV2({
    client: context.client,
    directory: context.directory,
    signal,
    inbox: {runStartedAt: context.runStartedAt, ownedSessionIds: () => ownedSessionIdsOfRun(context)},
    // A session this run owns is active when the list says so, wherever the server stored it: the placement by
    // directory is for the sessions the ledger does not know.
    knownSessionIds: () => ownedSessionIdsOfRun(context),
  })
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, {once: true})
  })
}

/** A signal that aborts when `parent` does or after `ms`, and a way to release it. */
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

export interface StopDirectoryActivityOptions {
  readonly client: ActionOpenCodeV2Client
  readonly rootSessionId: string | null
  readonly directory: string
  /** What one reading of the directory showed. */
  readonly activity: DirectoryActivity
  /** Interrupt the root even if the reading did not show it: a prompt that is not admitted yet is not active (P1). */
  readonly alwaysInterruptRoot?: boolean
  /** The life of the stop. Not the signal of the requests: the DELETEs and interrupts each get a bound of their own. */
  readonly signal: AbortSignal
  readonly logger: Logger
  readonly deleteTimeoutMs?: number
  readonly interruptTimeoutMs?: number
}

async function interruptSession(
  client: ActionOpenCodeV2Client,
  sessionId: string,
  signal: AbortSignal,
  logger: Logger,
  role: 'owned' | 'root',
): Promise<void> {
  try {
    const result = await client.interrupt({sessionId, signal})
    if (!result.success) {
      logger.warning('Session interrupt during release returned an error', {sessionId, role, error: result.error.kind})
    } else if (!result.data.interrupted) {
      // Not a stop and not a failure: nothing active was interrupted.
      logger.debug('Session interrupt during release was a no-op', {sessionId, role})
    }
  } catch (error) {
    logger.warning('Session interrupt during release threw', {sessionId, role, error: toErrorMessage(error)})
  }
}

/**
 * Kill every running shell of the directory, then interrupt every active session, the root first. The DELETEs go first
 * because each kill wakes the shell's owner with an `error` notice (probe p22), which the interrupt then stops. A queued
 * inbox item is left alone: only a wake that has started can be interrupted, and the next reading sees it. Best-effort
 * and never throws: a failed DELETE or interrupt shows up as activity in the next reading.
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
              logger.warning('Shell delete during release returned an error', {shellId, error: result.error.kind})
            }
          } catch (error) {
            logger.warning('Shell delete during release threw', {shellId, error: toErrorMessage(error)})
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
    const rootActive = rootSessionId !== null && activity.activeSessionIds.includes(rootSessionId)
    // Issued together, the root first: one that never answers must not hold up the others.
    await Promise.allSettled([
      ...(rootSessionId !== null && (rootActive || alwaysInterruptRoot)
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

export type StopConfirmation = {readonly quiet: true} | {readonly quiet: false; readonly reason: string}

export interface StopAndConfirmOptions {
  /** Overrides `STOP_CONFIRM_TIMEOUT_MS`. */
  readonly timeoutMs?: number
}

/**
 * Stop whatever the directory shows and wait for it to stay quiet. Every reading that finds activity (a partial one
 * included: what it did show is still there to stop) is acted on, so the loop is "read, stop, read" until the gate
 * passes or the bound runs out. On a pass the ledger's entries are settled; on a miss they are marked `unknown`, so
 * "we gave up waiting" never reads as "we never tried".
 *
 * Accepted cost: any stop with a live shell kills it, the kill wakes the root, and that needs a full quiet window after.
 */
export async function stopAndConfirmQuietV2(
  context: DirectoryReleaseContext,
  options: StopAndConfirmOptions = {},
): Promise<StopConfirmation> {
  const {client, directory, rootSessionId, ledger, logger} = context
  const timeoutMs = options.timeoutMs ?? STOP_CONFIRM_TIMEOUT_MS
  const teardown = new AbortController()
  const timer = setTimeout(() => teardown.abort(), timeoutMs)
  let lastReason = 'the directory was never read'
  let firstReading = true

  const markUnresolved = (): void => {
    for (const entry of ledger?.snapshot() ?? []) if (entry.state !== 'settled') ledger?.markUnknown(entry.sessionId)
  }

  try {
    const gate = createDirectoryStabilityGate({
      ...context.stability,
      observe: async signal => {
        const observation = await observe(context, signal)
        if (observation.kind === 'quiescent') return observation
        lastReason =
          observation.kind === 'unreadable'
            ? `a read of the directory failed: ${observation.reason}`
            : `the directory was active: ${observation.activity.activeSessionIds.length} session(s), ${observation.activity.runningShellIds.length} shell(s), ${observation.activity.queuedInbox.length} queued inbox(es)`
        await stopDirectoryActivityV2({
          client,
          rootSessionId,
          directory,
          activity: observation.activity,
          alwaysInterruptRoot: firstReading,
          signal,
          logger,
        })
        firstReading = false
        return observation
      },
    })
    const outcome = await awaitDirectoryStability({
      gate,
      signal: teardown.signal,
      spacingMs: context.stability?.minSpacingMs ?? DIRECTORY_QUIESCENCE_MIN_SPACING_MS,
    })
    if (outcome.passed) {
      for (const entry of ledger?.snapshot() ?? []) if (entry.state !== 'settled') ledger?.settle(entry.sessionId)
      logger.info('The run directory stayed quiet for the whole window; safe to release', {directory})
      return {quiet: true}
    }
    markUnresolved()
    logger.error('The run directory could not be confirmed quiet', {directory, reason: lastReason})
    return {quiet: false, reason: lastReason}
  } catch (error) {
    markUnresolved()
    return {quiet: false, reason: `the stop threw unexpectedly: ${toErrorMessage(error)}`}
  } finally {
    clearTimeout(timer)
    teardown.abort()
  }
}

export type DrainResultV2 =
  {readonly kind: 'quiet'} | {readonly kind: 'expired'} | {readonly kind: 'unobservable'; readonly reason: string}

export interface DrainUntilQuietOptions {
  /** Remaining drain budget. `Number.POSITIVE_INFINITY` means the Action has no deadline. */
  readonly deadlineMs: number
  readonly pollIntervalMs?: number
}

/**
 * The success path: wait for the run's own work to settle, then for the directory to stay quiet.
 *
 * While the ledger holds unsettled entries each loop runs a bounded reconcile pass (children through the session API,
 * shells through the shell routes) and waits. Only once the ledger is drained does the directory gate run, and it stays
 * a precondition on the ledger: an entry going back to `unknown` ends the wait and returns to the pass. Every success
 * waits for the directory, whatever the ledger holds, because a notice-triggered wake and an untracked child are
 * invisible to it.
 *
 * Bounded. A finite deadline bounds the whole wait. With none (`timeout: 0`) V1's rule applies and nothing else does:
 * wait while work is observed running, with no time cap (the job's `timeout-minutes` is the backstop), and give up after
 * `UNOBSERVABLE_PASSES_BEFORE_DRAIN_EXIT` consecutive passes that saw owned work remaining and none of it running. A
 * directory that cannot be read is the same kind of blindness (`UNREADABLE_READINGS_BEFORE_DRAIN_EXIT`). A bound that is
 * hit is not an answer: the caller stops the directory and reports it unconfirmed.
 */
export async function drainUntilQuietV2(
  context: DirectoryReleaseContext,
  options: DrainUntilQuietOptions,
): Promise<DrainResultV2> {
  const {client, directory, rootSessionId, ledger, logger} = context
  const {deadlineMs, pollIntervalMs = DEFAULT_DRAIN_POLL_INTERVAL_MS} = options
  const hasDeadline = Number.isFinite(deadlineMs)
  const controller = new AbortController()
  // No timer without a deadline: V1 does not cap a drain that sees its work running.
  const timer = hasDeadline ? setTimeout(() => controller.abort(), Math.max(0, deadlineMs)) : undefined
  const {signal} = controller

  let unobservablePasses = 0
  let unreadableReadings = 0
  const gate = createDirectoryStabilityGate({
    ...context.stability,
    observe: async readSignal => {
      const observation = await observe(context, readSignal)
      unreadableReadings = observation.kind === 'unreadable' ? unreadableReadings + 1 : 0
      if (observation.kind !== 'quiescent') {
        logger.debug('The run directory is not quiet yet', {
          kind: observation.kind,
          ...(observation.kind === 'active' ? {activity: observation.activity} : {reason: observation.reason}),
        })
      }
      return observation
    },
  })
  const unreadableGiveUp = (): boolean => !hasDeadline && unreadableReadings >= UNREADABLE_READINGS_BEFORE_DRAIN_EXIT

  try {
    while (!signal.aborted) {
      if (ledger !== undefined && rootSessionId !== null) {
        const running = await reconcileOwnedWorkV2({client, ledger, directory, parentSessionId: rootSessionId, logger})
        if (signal.aborted) break
        if (!ledger.isDrainComplete()) {
          unobservablePasses = running ? 0 : unobservablePasses + 1
          if (!hasDeadline && unobservablePasses >= UNOBSERVABLE_PASSES_BEFORE_DRAIN_EXIT) {
            return {kind: 'unobservable', reason: 'owned work is unsettled and no reconcile pass could see it running'}
          }
          await abortableDelay(pollIntervalMs, signal)
          continue
        }
        unobservablePasses = 0
      }

      const stable = await awaitDirectoryStability({
        gate,
        signal,
        spacingMs: context.stability?.minSpacingMs ?? DIRECTORY_QUIESCENCE_MIN_SPACING_MS,
        shouldContinue: () => (ledger === undefined || ledger.isDrainComplete()) && !unreadableGiveUp(),
      })
      if (stable.passed) return {kind: 'quiet'}
      if (stable.reason === 'aborted') break
      if (unreadableGiveUp()) {
        return {kind: 'unobservable', reason: 'the run directory could not be read'}
      }
      // Invalidated: the ledger regressed. Back to the reconcile pass.
    }
    return {kind: 'expired'}
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
  }
}

export interface ReleaseRunOptions extends DirectoryReleaseContext {
  readonly handle: Pick<OpenCodeV2ServerHandle, 'shutdown'>
  /** The root's turn succeeded: drain first. Otherwise (deadline, cancel, failure) the stop path runs at once. */
  readonly executionSucceeded: boolean
  /** Remaining drain budget (`computeDrainDeadlineMs`). `Number.POSITIVE_INFINITY` for no Action deadline. */
  readonly deadlineMs: number
  readonly pollIntervalMs?: number
  readonly stopTimeoutMs?: number
  /**
   * Runs once the drain or the stop has decided, quiet or not, and before anything else touches the server: stops the
   * event observation that was kept running through the wait and reads what it gathered. Bounded like the pre-shutdown
   * step (it must never be the reason the server stays up). `quiet` says whether the directory was confirmed.
   */
  readonly onSettled?: (quiet: boolean, signal: AbortSignal) => Promise<void>
  /**
   * Runs while the server is still up and the directory is confirmed quiet, before shutdown (summary write, session
   * pruning). Bounded by `preShutdownTimeoutMs`: `signal` aborts when the bound fires, and a step that ignores it is
   * abandoned. Shutdown follows either way.
   */
  readonly beforeShutdown?: (signal: AbortSignal) => Promise<void>
  /** Overrides `PRE_SHUTDOWN_TIMEOUT_MS`. */
  readonly preShutdownTimeoutMs?: number
}

export interface ReleaseOutcomeV2 {
  /** The directory was confirmed quiet before shutdown, by the drain or by a confirmed stop. */
  readonly quiet: boolean
  /** How the success-path drain ended, or `not-attempted` when the run did not succeed. */
  readonly drain: 'expired' | 'not-attempted' | 'quiet' | 'unobservable'
  /** The stop path ran. */
  readonly stopped: boolean
  /** Ledger entries neither settled nor confirmed stopped. */
  readonly unknownCount: number
  /** `null` when shutdown threw. */
  readonly shutdown: OpenCodeV2ShutdownResult | null
  /** Why nothing may be saved, or `null` when the directory was confirmed quiet. */
  readonly declineReason: string | null
}

/**
 * Run the pre-shutdown step under its own teardown bound and never let it hold the release: a step that throws, or that
 * does not finish in `timeoutMs`, is logged and the release goes on to shutdown (and, after a confirmed exit, the save).
 */
async function runPreShutdownStep(
  step: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timed-out'>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timed-out')
    }, timeoutMs)
  })
  try {
    const outcome = await Promise.race([(async () => step(controller.signal))().then(() => 'done' as const), timedOut])
    if (outcome === 'timed-out') {
      logger.warning('Pre-shutdown step did not finish in time; shutting the server down without it', {timeoutMs})
    }
  } catch (error) {
    logger.warning('Pre-shutdown step failed (non-fatal); shutdown still proceeds', {error: toErrorMessage(error)})
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Settle a V2 run: drain or stop until the directory is confirmed quiet, then shut the server down.
 *
 * `handle.shutdown` runs on every path and last: it interrupts the owned sessions with reason `user` (the one reason that
 * releases the execution claim, probe P11), closes stdin (which also kills the server's shells) and confirms the exit.
 * Its result is shared with the cleanup phase's own `shutdown()`, which reads the same first result.
 */
export async function releaseRunV2(options: ReleaseRunOptions): Promise<ReleaseOutcomeV2> {
  const {handle, logger, ledger} = options
  let quiet = false
  let drain: ReleaseOutcomeV2['drain'] = 'not-attempted'
  let stopped = false
  let declineReason: string | null = null

  if (options.executionSucceeded) {
    const drained = await drainUntilQuietV2(options, {
      deadlineMs: options.deadlineMs,
      ...(options.pollIntervalMs === undefined ? {} : {pollIntervalMs: options.pollIntervalMs}),
    })
    drain = drained.kind
    quiet = drained.kind === 'quiet'
    if (!quiet) {
      logger.warning('Drain did not reach a quiet directory; stopping what the directory shows', {
        outcome: drained.kind,
        ...(drained.kind === 'unobservable' ? {reason: drained.reason} : {}),
      })
    }
  }

  if (!quiet) {
    stopped = true
    const confirmation = await stopAndConfirmQuietV2(options, {
      ...(options.stopTimeoutMs === undefined ? {} : {timeoutMs: options.stopTimeoutMs}),
    })
    quiet = confirmation.quiet
    if (!confirmation.quiet) {
      declineReason = `the run's directory could not be confirmed quiet before shutdown (${confirmation.reason}), so a background session or shell may still write`
    }
  }

  if (options.onSettled !== undefined) {
    const onSettled = options.onSettled
    await runPreShutdownStep(
      async signal => onSettled(quiet, signal),
      options.preShutdownTimeoutMs ?? PRE_SHUTDOWN_TIMEOUT_MS,
      logger,
    )
  }

  if (quiet && options.beforeShutdown !== undefined) {
    await runPreShutdownStep(options.beforeShutdown, options.preShutdownTimeoutMs ?? PRE_SHUTDOWN_TIMEOUT_MS, logger)
  }

  let shutdown: OpenCodeV2ShutdownResult | null = null
  try {
    shutdown = await handle.shutdown({ownedSessionIds: ownedSessionIdsOfRun(options)})
  } catch (error) {
    logger.warning('OpenCode V2 server shutdown failed', {error: toErrorMessage(error)})
  }

  return {
    quiet,
    drain,
    stopped,
    unknownCount: (ledger?.unknown() ?? 0) + (ledger?.outstanding() ?? 0),
    shutdown,
    declineReason,
  }
}
