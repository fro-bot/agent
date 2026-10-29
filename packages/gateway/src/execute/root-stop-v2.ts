/**
 * Confirming that an interrupted root session has really stopped, on OpenCode V2: the sibling of `root-stop.ts`.
 *
 * `POST /api/session/:id/interrupt` is a request, and its reply cannot be read as a stop. `{interrupted: false}` is what
 * an idle session returns AND what a prompt that is not admitted yet returns (admission takes about 270 ms on a cold
 * location, probe P1), and an interrupt sent in that window leaves no trace: the turn then runs to completion. Absence
 * from `GET /api/session/active` proves nothing for the same reason, since a root that has not started is absent too.
 *
 * So a stop is confirmed only by positive evidence that an execution of the root ended, and the root absent from the
 * active list on both sides of reading it:
 * - on the stream: `session.execution.interrupted` with reason `user`, `session.execution.succeeded`, or
 *   `session.execution.failed`. An interrupt with reason `shutdown` is never evidence: it leaves the execution claim
 *   held and resumable (probe P11), which is the opposite of stopped;
 * - or, when the stream cannot say (it was closed before the end), the server's own persisted `outcome` of the session.
 *   A `shutdown` interrupt never writes it (`projectIdle` returns early), so a persisted `interrupted` is a real stop.
 *
 * That evidence only rules out executions that already happened. While background work is open (`followUpPossible`),
 * a finished or cancelled child makes the server start a root turn by itself, and a persisted outcome of the turn
 * before says nothing about it. With `followUpPossible` nothing confirms the root: the probe is only ever `busy` or
 * `unconfirmed`, the barrier quarantines, and the watch runs for the whole hold, interrupting the root on every busy
 * observation.
 *
 * The liveness reading is taken again after the evidence is read, so a cold root that starts in between reads as busy.
 */

import type {
  KillOwnedShellsOptions,
  KillOwnedShellsResult,
  LedgerReconcileAdapter,
  RemoteOpenCodeV2Client,
} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

import {killOwnedShells, toErrorMessage} from '@fro-bot/runtime'
import {
  QUARANTINE_HOLD_WINDOW_MS,
  ROOT_QUIESCENCE_POLL_INTERVAL_MS,
  ROOT_WATCH_REQUEST_TIMEOUT_MS,
} from './root-stop.js'
import {toRuntimeLogger} from './runtime-logger.js'

/** The two calls this module makes; the real V2 client satisfies it. */
export type RootStopClientV2 = Pick<RemoteOpenCodeV2Client, 'getSession' | 'interrupt'>

/** How the root's latest execution ended on the stream, as the event loop recorded it. */
export type StreamTerminal = 'failed' | 'inactivity' | 'shutdown' | 'succeeded' | 'superseded' | 'user'

/**
 * Interrupt one session. Best-effort: a failed request is evidence for the confirmation step, not a reason to abort the
 * settle attempt. Never throws.
 */
export async function interruptSession(
  client: RootStopClientV2,
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
      // Not a stop and not a failure: nothing active was interrupted. Confirmation never reads it as either.
      logger.debug({sessionId, role, interrupted: false}, 'settle-owned-sessions: session interrupt was a no-op')
    }
  } catch (error) {
    logger.warn({sessionId, role, detail: toErrorMessage(error)}, 'settle-owned-sessions: session interrupt threw')
  }
}

export type RootProbe = 'busy' | 'confirmed' | 'unconfirmed'

export interface ProbeRootStopV2Options {
  /** Background work is open, so a root turn the stream has not shown can still start. Makes confirmation impossible. */
  readonly followUpPossible?: boolean
  readonly client: RootStopClientV2
  /** Global liveness: the V2 reconcile adapter's `liveSessionIds`. */
  readonly adapter: LedgerReconcileAdapter
  readonly rootSessionId: string
  readonly signal: AbortSignal
  /** How the root's latest execution ended on the stream, or `null` when it has not (or the stream is gone). */
  readonly streamTerminal: () => StreamTerminal | null
}

/**
 * One observation of the root. Live is `busy`: the caller interrupts again. Not live is only `confirmed` with positive
 * evidence that an execution ended (see the module doc); without it it is `unconfirmed`. A failed lookup is
 * `unconfirmed`.
 */
export async function probeRootStopV2(options: ProbeRootStopV2Options): Promise<RootProbe> {
  const {client, adapter, rootSessionId, signal, streamTerminal, followUpPossible = false} = options
  const live = await adapter.liveSessionIds(signal)
  if (!live.success) return 'unconfirmed'
  if (live.data.has(rootSessionId)) return 'busy'
  if (followUpPossible) return 'unconfirmed'

  const terminal = streamTerminal()
  if (terminal === 'shutdown') return 'unconfirmed'
  let evidence = terminal === 'user' || terminal === 'succeeded' || terminal === 'failed'
  if (!evidence) {
    try {
      const session = await client.getSession({sessionId: rootSessionId, signal})
      if (!session.success) return 'unconfirmed'
      evidence = session.data.outcome !== null
    } catch {
      return 'unconfirmed'
    }
  }
  if (!evidence) return 'unconfirmed'

  // A cold root can start between the first reading and the evidence. Only a root that is still absent now is stopped.
  const after = await adapter.liveSessionIds(signal)
  if (!after.success) return 'unconfirmed'
  return after.data.has(rootSessionId) ? 'busy' : 'confirmed'
}

export interface QuarantineRootWatchV2Options extends Omit<ProbeRootStopV2Options, 'signal'> {
  /**
   * The background shells to keep killing. Each tick DELETEs any owned shell it finds running before it probes the root,
   * and the watch does not end on a confirmed root while a shell is still running: a DELETE wakes the owner, and a shell
   * that outlived the barrier must not outlive the hold.
   */
  readonly shells?: Omit<KillOwnedShellsOptions, 'logger' | 'pollIntervalMs' | 'rounds' | 'signal'>
  readonly logger: GatewayLogger
  readonly runId?: string
  readonly windowMs?: number
  readonly pollIntervalMs?: number
}

/**
 * Keeps probing a root the barrier could not confirm, for the length of the quarantine hold: every busy observation
 * sends another interrupt, so a prompt that started late is stopped instead of running through the hold. With `shells`
 * it also re-deletes every owned shell it finds running. Ends at the
 * first confirmation or when the window closes (with `followUpPossible` nothing confirms, so it always runs to the end
 * of the window). A window timer ends it even if a request hangs, every request is bounded, and the timers are unref'd.
 *
 * @returns `stop`, which ends the watch early. Safe to call more than once.
 */
export function startQuarantineRootWatchV2(options: QuarantineRootWatchV2Options): () => void {
  const {
    windowMs = QUARANTINE_HOLD_WINDOW_MS,
    pollIntervalMs = ROOT_QUIESCENCE_POLL_INTERVAL_MS,
    rootSessionId,
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
  let interrupts = 0

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
    logger.warn({rootSessionId, interrupts}, 'root-watch: quarantine hold ended without confirming the root stopped')
    end()
  }, windowMs)
  windowTimer.unref()

  /** One request bounded by its own cap; a hung request resolves `fallback` instead of stalling the watch. */
  async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, fallback: T): Promise<T> {
    const requestController = new AbortController()
    const forward = (): void => requestController.abort()
    controller.signal.addEventListener('abort', forward, {once: true})
    let capTimer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<T>(resolve => {
      capTimer = setTimeout(() => {
        requestController.abort()
        resolve(fallback)
      }, ROOT_WATCH_REQUEST_TIMEOUT_MS)
      capTimer.unref()
    })
    try {
      return await Promise.race([work(requestController.signal).catch(() => fallback), capped])
    } finally {
      if (capTimer !== undefined) clearTimeout(capTimer)
      controller.signal.removeEventListener('abort', forward)
    }
  }

  const unconfirmedSweep: KillOwnedShellsResult = {confirmed: false, stillRunning: []}

  async function tick(): Promise<void> {
    timer = undefined
    if (ended) return
    let shellsClear = true
    if (options.shells !== undefined) {
      const shells = options.shells
      const swept = await bounded<KillOwnedShellsResult>(
        async signal =>
          killOwnedShells({
            ...shells,
            logger: toRuntimeLogger(logger),
            signal,
            rounds: 1,
            pollIntervalMs: 0,
          }),
        unconfirmedSweep,
      )
      if (ended) return
      shellsClear = swept.confirmed
      if (swept.confirmed && swept.deleted.length > 0) {
        logger.warn(
          {rootSessionId, shellCount: swept.deleted.length},
          'root-watch: owned background shells were running during the quarantine hold — deleted them',
        )
      }
    }
    const probe = await bounded<RootProbe>(async signal => probeRootStopV2({...options, signal}), 'unconfirmed')
    if (ended) return
    if (probe === 'confirmed' && shellsClear) {
      logger.info({rootSessionId, interrupts}, 'root-watch: the root is confirmed stopped; ending the watch')
      end()
      return
    }
    if (probe === 'busy') {
      interrupts += 1
      logger.warn(
        {rootSessionId, interrupts},
        'root-watch: the root is running during the quarantine hold — interrupting it again',
      )
      await bounded(async signal => interruptSession(options.client, rootSessionId, signal, logger, 'root'), undefined)
      if (ended) return
    }
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
