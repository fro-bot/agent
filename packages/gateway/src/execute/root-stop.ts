/**
 * Confirming that an aborted root session has really stopped, and finishing the job when it has not.
 *
 * `session.abort` is a request. OpenCode answers `true` for it even when nothing is running yet: a prompt that is
 * still being prepared (agent and skill discovery, provider state, the `chat.message` hook, all before the runner is
 * registered) has no runner to interrupt, and the abort leaves no trace. The prompt starts a moment later and runs
 * in a checkout the next run may already own. Absence from `session.status` therefore proves nothing: a root that
 * has not started yet is absent too.
 *
 * Positive evidence that the root stopped is a terminal assistant reply to its latest user message: the last message
 * in the session is an assistant message answering that user message with `time.completed` set (an abort writes
 * `MessageAbortedError` and a completion time, so an aborted reply counts). A reply to an older turn does not.
 * Without such a reply the root cannot be confirmed stopped.
 *
 * That evidence only rules out the turns that already exist. While background work is open (`followUpPossible`) OpenCode
 * starts root turns by itself: a child that finishes, or is cancelled by the abort, makes it inject a notice turn into
 * the root, and that turn goes through the same preparation as the prompt (its user message is saved only after agent,
 * skill and provider initialisation and the `chat.message` hook, and its runner registers after that). A reply to the
 * turn before it says nothing about a turn that is not saved yet, so with `followUpPossible` nothing confirms the
 * root: the probe is only ever `busy` or `unconfirmed`, the barrier quarantines, and the watch runs for the whole hold,
 * aborting the root on every busy observation.
 *
 * Two pieces build on that:
 * - `probeRootStop` is one observation: confirmed (not live, with that reply), busy (live, so it is aborted again),
 *   or unconfirmed (not live and no reply yet, or the lookup failed).
 * - `startQuarantineRootWatch` keeps probing for the whole quarantine hold, so a prompt that started after the
 *   barrier gave up is aborted as soon as it shows up instead of running through the hold unchecked.
 */

import type {LedgerReconcileAdapter, SessionClient} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

import {formatSdkError, getNumberProperty, getObjectProperty, getStringProperty, toErrorMessage} from '@fro-bot/runtime'

/** Cadence of the root-quiescence probe (inside the barrier's budget and during the quarantine hold). */
export const ROOT_QUIESCENCE_POLL_INTERVAL_MS = 500

/** Upper bound on one probe or abort request during the quarantine hold, so a hung request cannot stall the watch. */
export const ROOT_WATCH_REQUEST_TIMEOUT_MS = 5_000

/**
 * Upper bound, in milliseconds, on how long a quarantined run's lock lease and
 * concurrency slot are held past the failure that quarantined it.
 *
 * The termination barrier (`settle-owned-sessions.ts`) already spends up to
 * `DEFAULT_SETTLE_TIMEOUT_MS` (15 s) trying to confirm settlement before giving
 * up and quarantining. This window is deliberately much larger than that bound —
 * roughly 20x — so a background child that is genuinely still finishing a write
 * after being cancelled (a slow git operation, a large diff) is not abandoned
 * mid-write, while still being short enough that a wedged concurrency slot
 * recovers unattended rather than needing an operator to notice and intervene.
 *
 * Only the concurrency slot is released deterministically at this boundary (see
 * `scheduleQuarantineRelease` in `run.ts`). The repo lock is left to lapse via its own lease TTL
 * (`CoordinationConfig.lockTtlSeconds`, 900 s / 15 min by default) once this window stops
 * renewing it. An expired lease is NOT reclaimed on elapsed time alone: acquisition and the
 * operator `force-release-lock` both require a clear OpenCode workspace status check first, so a
 * quarantined run whose children are still busy keeps the repo blocked.
 *
 * Lives here, not in `run.ts`, so the root watch that covers the same window does not import the run pipeline.
 */
export const QUARANTINE_HOLD_WINDOW_MS = 5 * 60_000

/**
 * Cancel a single session. Best-effort: checks BOTH the SDK error envelope
 * and a thrown exception, logs either, and never throws — a failed cancel
 * request is evidence for the confirmation step, not a reason to abort
 * the whole settle attempt.
 */
export async function abortSession(
  client: SessionClient,
  sessionId: string,
  directory: string,
  signal: AbortSignal,
  logger: GatewayLogger,
  role: 'root' | 'owned',
): Promise<void> {
  try {
    const response = await client.session.abort({path: {id: sessionId}, query: {directory}, signal})
    const envelope = response as {readonly error?: unknown} | undefined
    if (envelope?.error != null) {
      logger.warn(
        {sessionId, role, detail: formatSdkError(envelope.error)},
        'settle-owned-sessions: session.abort returned an error envelope',
      )
    }
  } catch (error) {
    logger.warn({sessionId, role, detail: toErrorMessage(error)}, 'settle-owned-sessions: session.abort threw')
  }
}

/**
 * Whether a session's messages prove its root has stopped: the LAST message is an assistant message that answers
 * the LATEST user message and has `time.completed`. Pure; never reads message content.
 *
 * - No user message yet: false. The prompt may still be preparing.
 * - A user message the stream showed that the list does not hold: false. The list describes an older state.
 * - The latest user message has no reply, or its reply is not the last message, or the reply has no completion
 *   time: false. A reply to an older user message never counts.
 */
export function rootHasTerminalReply(messages: unknown, streamedUserMessageIds: ReadonlySet<string>): boolean {
  if (!Array.isArray(messages)) return false
  const userMessageIds = new Set<string>()
  let latestUserId: string | null = null
  let last: {readonly role: string | null; readonly info: unknown} | null = null
  for (const message of messages as readonly unknown[]) {
    const info = getObjectProperty(message, 'info')
    const id = getStringProperty(info, 'id')
    const role = getStringProperty(info, 'role')
    if (id === null || role === null) continue
    if (role === 'user') {
      userMessageIds.add(id)
      latestUserId = id
    }
    last = {role, info}
  }
  if (latestUserId === null || last === null) return false
  if (last.role !== 'assistant') return false
  for (const streamed of streamedUserMessageIds) {
    if (!userMessageIds.has(streamed)) return false
  }
  if (getStringProperty(last.info, 'parentID') !== latestUserId) return false
  return getNumberProperty(getObjectProperty(last.info, 'time'), 'completed') !== null
}

export type RootProbe = 'confirmed' | 'busy' | 'unconfirmed'

export interface ProbeRootStopOptions {
  /**
   * Background work is open, so OpenCode can start a root turn the message list does not show yet. Makes confirmation
   * impossible: a terminal reply to an earlier turn is not evidence about a newer one.
   */
  readonly followUpPossible?: boolean
  readonly client: SessionClient
  readonly adapter: LedgerReconcileAdapter
  readonly directory: string
  readonly rootSessionId: string
  readonly signal: AbortSignal
  /** Root user message ids the event stream showed. Each must be in the persisted list for the reply to count. */
  readonly streamedUserMessageIds: () => ReadonlySet<string>
}

/**
 * One observation of the root. Live (busy, or retrying) is `busy`: the caller aborts again. Not live is only
 * `confirmed` with a terminal reply to the latest user message; without one it is `unconfirmed`, because a root that
 * has not started is not live either. A failed lookup is `unconfirmed`.
 */
export async function probeRootStop(options: ProbeRootStopOptions): Promise<RootProbe> {
  const {client, adapter, directory, rootSessionId, signal, streamedUserMessageIds, followUpPossible = false} = options
  const live = await adapter.liveSessionIds(signal)
  if (live.success === false) return 'unconfirmed'
  if (live.data.has(rootSessionId)) return 'busy'
  if (followUpPossible) return 'unconfirmed'
  try {
    const response = (await client.session.messages({path: {id: rootSessionId}, query: {directory}, signal})) as
      {readonly error?: unknown; readonly data?: unknown} | undefined
    if (response === undefined || response.error != null) return 'unconfirmed'
    return rootHasTerminalReply(response.data, streamedUserMessageIds()) ? 'confirmed' : 'unconfirmed'
  } catch {
    return 'unconfirmed'
  }
}

export interface QuarantineRootWatchOptions extends Omit<ProbeRootStopOptions, 'signal'> {
  readonly logger: GatewayLogger
  readonly runId?: string
  readonly windowMs?: number
  readonly pollIntervalMs?: number
}

/**
 * Keeps probing a root the barrier could not confirm, for the length of the quarantine hold: every busy observation
 * sends another abort, so a prompt that started late is stopped instead of running through the hold. Ends at the
 * first confirmation or when the window closes, whichever comes first (with `followUpPossible` nothing confirms, so it
 * always runs to the end of the window). A window timer ends it even if a request
 * hangs, and every request is bounded. Everything it owns (both timers and the in-flight request) is released when it
 * ends; the timers are unref'd so they never keep the process alive.
 *
 * The hold itself is a fixed-length timer in `run.ts`, so a confirmation here does not shorten it.
 *
 * @returns `stop`, which ends the watch early. Safe to call more than once.
 */
export function startQuarantineRootWatch(options: QuarantineRootWatchOptions): () => void {
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
  let aborts = 0

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
    logger.warn({rootSessionId, aborts}, 'root-watch: quarantine hold ended without confirming the root stopped')
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

  async function tick(): Promise<void> {
    timer = undefined
    if (ended) return
    const probe = await bounded<RootProbe>(async signal => probeRootStop({...options, signal}), 'unconfirmed')
    if (ended) return
    if (probe === 'confirmed') {
      logger.info({rootSessionId, aborts}, 'root-watch: the root is confirmed stopped; ending the watch')
      end()
      return
    }
    if (probe === 'busy') {
      aborts += 1
      logger.warn(
        {rootSessionId, aborts},
        'root-watch: the root is running during the quarantine hold — aborting it again',
      )
      await bounded(
        async signal => abortSession(options.client, rootSessionId, options.directory, signal, logger, 'root'),
        undefined,
      )
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
