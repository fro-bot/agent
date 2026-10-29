import type {Result} from '@bfra.me/es/result'
import type {V2SessionApi} from './ledger-reconcile-v2.js'
import type {OwnershipLedger} from './ownership-ledger.js'
import type {RemoteOpenCodeV2Client} from './remote-client-v2.js'

import {err, ok} from '@bfra.me/es/result'
import {toError} from '../shared/errors.js'
import {listV2SessionsInDirectory} from './ledger-reconcile-v2.js'
import {isShellLedgerKey} from './ownership-ledger.js'

/**
 * The release invariant of a V2 run: directory quiescence, held for a stability window.
 *
 * Stock OpenCode v2.2.0 cannot prove that no work started by a run can still wake one of its sessions. Producers (a
 * background shell's exit, a subagent's completion) admit a notice to the session inbox and wake the session in a
 * separate step, and neither the event stream nor any REST route says a producer is mid-way. So a run does not try to
 * account for each entity it started. It releases its checkout when the DIRECTORY shows no activity for long enough:
 *
 * - no session located in the directory is on `GET /api/session/active` (root, children, grandchildren and resumed
 *   descendants alike, whatever the ledger says). The active list is global and short, so each entry is located with
 *   `GET /api/session/:id`; the cost follows the sessions running on the server, never the history stored under the
 *   directory;
 * - no shell of the directory is running on `GET /api/shell`, owned or not;
 * - no session that matters to this run has a queued item in `GET /api/session/:id/inbox` (an enqueued notice whose
 *   wake has not started: the producer has done its half). See "Which inboxes" below.
 *
 * Which inboxes. The workspace's server is long-lived and the sessions of earlier runs pile up under the same
 * directory, so reading every stored session's inbox would cost one request per session on every reading, and a history
 * past the list page bound would never read as quiet. The read is bounded to the run's root, the sessions it owns, and
 * every session whose `time.updated` is at or after the run's start minus `DIRECTORY_INBOX_RECENT_MARGIN_MS`. That is
 * sound because admitting an inbox item bumps the session's `time.updated` (`InboxEnqueued` projection,
 * `packages/core/src/session/projector.ts`), and every way to wake a session goes through an admit (`session.ts`
 * prompt and synthetic paths, `inbox.ts` `admit`). A session last updated before that cut-off either had nothing queued
 * when its own run released the directory, or was woken since, and a woken session shows up as active above. The list
 * is read newest-first and the walk stops at the cut-off, so the page bound applies to the recent sessions only.
 *
 * One quiet reading proves nothing, because a producer paused between admitting a notice and waking its session shows
 * nothing in any of the three. The gate therefore passes only after `DIRECTORY_QUIESCENCE_REQUIRED_OBSERVATIONS`
 * consecutive quiet readings, at least `DIRECTORY_QUIESCENCE_MIN_SPACING_MS` apart, spanning at least
 * `DIRECTORY_QUIESCENCE_MIN_SPAN_MS`. Any activity, and any read that fails, times out or comes back partial, resets the
 * count: a reading the run could not take is never read as quiet.
 *
 * What this does not prove: an upstream producer paused for longer than the window that wakes later. That is the
 * residual risk; it is mitigated by quarantining a stop that could not be confirmed and by the next run's acquire check
 * (`repo-quiescence-v2.ts`), and it is tracked upstream.
 *
 * Consequence: every session and shell in a gateway checkout directory is treated as the run's. Nothing else shares
 * the directory, so there is no way to tell them apart, and on a stop they are killed or interrupted.
 */

/** Consecutive quiet readings the gate needs. */
export const DIRECTORY_QUIESCENCE_REQUIRED_OBSERVATIONS = 11
/** Least time between two readings that both count toward the streak. */
export const DIRECTORY_QUIESCENCE_MIN_SPACING_MS = 500
/** Least time the streak must span: ten gaps of 500 ms. */
export const DIRECTORY_QUIESCENCE_MIN_SPAN_MS = 5_000
/** Bound on one reading, all of its requests included. */
export const DIRECTORY_QUIESCENCE_READ_TIMEOUT_MS = 5_000
/** Inbox reads, and session lookups for the active list, in flight at once. */
export const DIRECTORY_INBOX_READ_CONCURRENCY = 8
/**
 * How far before the run's start a session can have been last updated and still have its inbox read. Absorbs clock skew
 * between the gateway and the workspace server, and a session touched just before the run began.
 */
export const DIRECTORY_INBOX_RECENT_MARGIN_MS = 10 * 60 * 1000

/** The calls one reading makes; the real V2 client satisfies it. */
export interface DirectoryQuiescenceClient {
  readonly session: V2SessionApi
  readonly getSession: RemoteOpenCodeV2Client['getSession']
  readonly listShells: RemoteOpenCodeV2Client['listShells']
  readonly listSessionInbox: RemoteOpenCodeV2Client['listSessionInbox']
}

export interface DirectoryActivity {
  /** Sessions located in the directory that are on the active list. */
  readonly activeSessionIds: readonly string[]
  /** Shells of the directory that are running (a status this client does not know counts as running). */
  readonly runningShellIds: readonly string[]
  /** Sessions of this run's scope (see `InboxScope`) with a queued inbox item. */
  readonly queuedInbox: readonly {readonly sessionId: string; readonly queued: number}[]
}

export type DirectoryObservation =
  | {readonly kind: 'quiescent'}
  | {readonly kind: 'active'; readonly activity: DirectoryActivity}
  /** A read failed, timed out or was cut short. `activity` is what the reads that did answer showed. */
  | {readonly kind: 'unreadable'; readonly reason: string; readonly activity: DirectoryActivity}

/**
 * The sessions that are running in `directory`: the server's global active list, each entry located with
 * `GET /api/session/:id` and compared with the canonical directory (probes P2 and P9). The active list is short and the
 * history stored under a directory is not, so the cost follows the sessions running anywhere on the server and never
 * the sessions stored here; nothing is requested when nothing is active.
 *
 * `directory` is canonicalised first because the server stores the directory a session was created with and this
 * compares it as an exact string. A failed `realpath` fails the call: the raw path would silently miss sessions and
 * read as "quiet". A session deleted between the two reads is skipped (it has nothing left to run); any other failed
 * lookup, an unreadable location or a malformed list fails the call, never reads as quiet. An aborted `signal` fails it.
 *
 * Known limit (probe P12): a session that moved is located at its destination, so it drops out of a check keyed on the
 * directory it started in. A run treats a move of an owned session as fatal (`mapV2EventStream`).
 */
export async function listActiveSessionIdsInDirectoryV2(
  client: Pick<DirectoryQuiescenceClient, 'getSession' | 'session'>,
  directory: string,
  options: {readonly realpath: (path: string) => Promise<string>; readonly signal?: AbortSignal},
): Promise<Result<readonly string[], Error>> {
  const {realpath, signal} = options
  try {
    if (signal?.aborted === true) throw toError(signal.reason ?? new Error('aborted'))
    const canonical = await realpath(directory)
    const active: unknown = await client.session.active(signal === undefined ? undefined : {signal})
    if (active === null || typeof active !== 'object' || Array.isArray(active)) {
      return err(new Error('session.active: not an object keyed by session id'))
    }
    const located = await mapPool(Object.keys(active), DIRECTORY_INBOX_READ_CONCURRENCY, async sessionId => {
      const info = await client.getSession({sessionId, ...(signal === undefined ? {} : {signal})})
      if (!info.success) {
        return info.error.kind === 'http' && info.error.status === 404
          ? ({sessionId, here: false, failure: null} as const)
          : ({sessionId, here: false, failure: info.error.kind} as const)
      }
      if (info.data.directory === null) return {sessionId, here: false, failure: 'no location'} as const
      return {sessionId, here: info.data.directory === canonical, failure: null} as const
    })
    const unreadable = located.find(entry => entry.failure !== null)
    if (unreadable !== undefined) return err(new Error(`session.get: ${unreadable.failure ?? 'unreadable'}`))
    return ok(located.filter(entry => entry.here).map(entry => entry.sessionId))
  } catch (error) {
    return err(toError(error))
  }
}

/** Which sessions' inboxes one reading reads. */
export interface InboxScope {
  /** When the run began, in epoch milliseconds. */
  readonly runStartedAt: number
  /** The run's root and the sessions it owns, read whatever their `time.updated`. Called on every reading. */
  readonly ownedSessionIds: () => readonly string[]
}

/** The root and every session the ledger tracks, in any state. Background shells are not sessions and are skipped. */
export function ownedSessionIdsOf(rootSessionId: string, ledger: OwnershipLedger): readonly string[] {
  return [
    rootSessionId,
    ...ledger.snapshot().flatMap(entry => (isShellLedgerKey(entry.sessionId) ? [] : [entry.sessionId])),
  ]
}

export interface ObserveDirectoryOptions {
  readonly client: DirectoryQuiescenceClient
  /** The location the run's sessions and shells live in. */
  readonly directory: string
  readonly signal?: AbortSignal
  /** Overrides `DIRECTORY_QUIESCENCE_READ_TIMEOUT_MS`. */
  readonly readTimeoutMs?: number
  /**
   * Canonicalises the directory for the session filter, which the server compares as an exact string. Defaults to the
   * identity: the gateway cannot `realpath` a path in the workspace's filesystem and creates its sessions under the
   * canonical directory itself.
   */
  readonly realpath?: (path: string) => Promise<string>
  /**
   * Whose inboxes to read, or `false` to skip them, for a sweep that only needs to know what to kill or interrupt.
   * Required, so a caller decides: reading all of them is not an option.
   */
  readonly inbox: InboxScope | false
}

const identityRealpath = async (path: string): Promise<string> => path

type Read<T> = {readonly ok: true; readonly value: T} | {readonly ok: false; readonly reason: string}

function failed(reason: string): Read<never> {
  return {ok: false, reason}
}

async function guarded<T>(label: string, work: () => Promise<Read<T>>): Promise<Read<T>> {
  try {
    return await work()
  } catch (error) {
    return failed(`${label}: ${toError(error).message}`)
  }
}

async function mapPool<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await work(items[index] as T)
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, worker))
  return results
}

/**
 * One reading of the directory. Never throws and never reads a failure as quiet. Every request carries a signal that
 * the read timeout and the caller's signal both abort, and the whole reading is raced against that signal, so a client
 * that ignores it still cannot stall the caller.
 */
export async function observeDirectoryV2(options: ObserveDirectoryOptions): Promise<DirectoryObservation> {
  const {
    client,
    directory,
    signal,
    readTimeoutMs = DIRECTORY_QUIESCENCE_READ_TIMEOUT_MS,
    realpath = identityRealpath,
    inbox,
  } = options
  const emptyActivity: DirectoryActivity = {activeSessionIds: [], runningShellIds: [], queuedInbox: []}
  const callerAborted = (): boolean => signal?.aborted === true

  if (signal?.aborted === true) return {kind: 'unreadable', reason: 'aborted', activity: emptyActivity}

  const controller = new AbortController()
  const forward = (): void => controller.abort()
  signal?.addEventListener('abort', forward, {once: true})
  const timer = setTimeout(forward, readTimeoutMs)
  const abandoned = new Promise<'abandoned'>(resolve => {
    controller.signal.addEventListener('abort', () => resolve('abandoned'), {once: true})
  })

  const reads = async (): Promise<DirectoryObservation> => {
    const requestSignal = controller.signal
    const deps = {realpath}

    const activeRead = guarded<readonly string[]>('session.active', async () => {
      const located = await listActiveSessionIdsInDirectoryV2(client, directory, {
        realpath,
        signal: requestSignal,
      })
      return located.success ? {ok: true, value: located.data} : failed(located.error.message)
    })

    const shellRead = guarded<readonly string[]>('shell.list', async () => {
      const listed = await client.listShells({directory, signal: requestSignal})
      if (!listed.success) return failed(`shell.list: ${listed.error.kind}`)
      return {
        ok: true,
        value: listed.data
          .filter(shell => shell.status === 'running' || shell.status === 'unknown')
          .map(shell => shell.id),
      }
    })

    const inboxRead = guarded<readonly {readonly sessionId: string; readonly queued: number}[]>(
      'session.inbox',
      async () => {
        if (inbox === false) return {ok: true, value: []}
        const recent = await listV2SessionsInDirectory(client.session, directory, deps, {
          signal: requestSignal,
          updatedSince: inbox.runStartedAt - DIRECTORY_INBOX_RECENT_MARGIN_MS,
        })
        if (!recent.success) return failed(`session.list: ${recent.error.message}`)
        const sessionIds = [...new Set([...inbox.ownedSessionIds(), ...recent.data])]
        const readings = await mapPool(sessionIds, DIRECTORY_INBOX_READ_CONCURRENCY, async sessionId => {
          const listed = await client.listSessionInbox({sessionId, signal: requestSignal})
          // A session deleted between the list and this read has nothing left to wake.
          if (!listed.success) {
            return listed.error.kind === 'http' && listed.error.status === 404
              ? ({sessionId, queued: 0, failure: null} as const)
              : ({sessionId, queued: 0, failure: listed.error.kind} as const)
          }
          return {sessionId, queued: listed.data.queued, failure: null} as const
        })
        const unreadable = readings.find(reading => reading.failure !== null)
        if (unreadable !== undefined) return failed(`session.inbox: ${unreadable.failure ?? 'unreadable'}`)
        return {
          ok: true,
          value: readings.filter(reading => reading.queued > 0).map(({sessionId, queued}) => ({sessionId, queued})),
        }
      },
    )

    const [active, shells, queued] = await Promise.all([activeRead, shellRead, inboxRead])
    const activity: DirectoryActivity = {
      activeSessionIds: active.ok ? active.value : [],
      runningShellIds: shells.ok ? shells.value : [],
      queuedInbox: queued.ok ? queued.value : [],
    }
    const failures = [active, shells, queued].flatMap(read => (read.ok ? [] : [read.reason]))
    if (failures.length > 0) return {kind: 'unreadable', reason: failures.join('; '), activity}
    if (
      activity.activeSessionIds.length > 0 ||
      activity.runningShellIds.length > 0 ||
      activity.queuedInbox.length > 0
    ) {
      return {kind: 'active', activity}
    }
    return {kind: 'quiescent'}
  }

  try {
    const outcome = await Promise.race([reads(), abandoned])
    if (outcome === 'abandoned') {
      return {kind: 'unreadable', reason: callerAborted() ? 'aborted' : 'timed out', activity: emptyActivity}
    }
    return outcome
  } catch (error) {
    return {kind: 'unreadable', reason: toError(error).message, activity: emptyActivity}
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
    // Nothing this reading started outlives it.
    controller.abort()
  }
}

export interface DirectoryStabilityState {
  /** The streak has reached the required count and span. A point-in-time fact: the next reading can unpass it. */
  readonly passed: boolean
  /** Consecutive quiet readings that counted. */
  readonly streak: number
  /** Time from the first reading of the streak to the latest counted one. */
  readonly spanMs: number
  /** The reading just taken, or `null` before the first. */
  readonly last: DirectoryObservation | null
}

/** The window's constants. Production uses the defaults; the tests that are not about the window shorten it. */
export interface DirectoryStabilityTuning {
  readonly requiredObservations?: number
  readonly minSpacingMs?: number
  readonly minSpanMs?: number
}

export interface DirectoryStabilityGateOptions extends DirectoryStabilityTuning {
  /** One reading, bounded by the signal. Never rejects; if it does, the gate reads it as a failed reading. */
  readonly observe: (signal: AbortSignal) => Promise<DirectoryObservation>
  /** Test seam. Defaults to `Date.now`. */
  readonly now?: () => number
}

export interface DirectoryStabilityGate {
  /** Take one reading and fold it into the streak. */
  readonly step: (signal: AbortSignal) => Promise<DirectoryStabilityState>
  /** Drop the streak, for activity the gate did not read itself (a wake seen on the event stream). */
  readonly reset: () => void
  readonly state: () => DirectoryStabilityState
}

export function createDirectoryStabilityGate(options: DirectoryStabilityGateOptions): DirectoryStabilityGate {
  const {
    observe,
    requiredObservations = DIRECTORY_QUIESCENCE_REQUIRED_OBSERVATIONS,
    minSpacingMs = DIRECTORY_QUIESCENCE_MIN_SPACING_MS,
    minSpanMs = DIRECTORY_QUIESCENCE_MIN_SPAN_MS,
    now = Date.now,
  } = options

  let streak = 0
  let streakStartedAt = 0
  let lastCountedAt = 0
  let last: DirectoryObservation | null = null
  let spanMs = 0

  const snapshot = (): DirectoryStabilityState => ({
    passed: streak >= requiredObservations && spanMs >= minSpanMs,
    streak,
    spanMs,
    last,
  })

  function reset(): void {
    streak = 0
    spanMs = 0
  }

  async function step(signal: AbortSignal): Promise<DirectoryStabilityState> {
    let observation: DirectoryObservation
    try {
      observation = await observe(signal)
    } catch (error) {
      observation = {
        kind: 'unreadable',
        reason: toError(error).message,
        activity: {activeSessionIds: [], runningShellIds: [], queuedInbox: []},
      }
    }
    last = observation
    const at = now()
    if (observation.kind !== 'quiescent') {
      reset()
      return snapshot()
    }
    if (streak === 0) {
      streak = 1
      streakStartedAt = at
      lastCountedAt = at
      spanMs = 0
    } else if (at - lastCountedAt >= minSpacingMs) {
      streak += 1
      lastCountedAt = at
      spanMs = at - streakStartedAt
    }
    return snapshot()
  }

  return {step, reset, state: snapshot}
}

export type AwaitDirectoryStabilityResult =
  {readonly passed: true} | {readonly passed: false; readonly reason: 'aborted' | 'invalidated'}

export interface AwaitDirectoryStabilityOptions {
  readonly gate: DirectoryStabilityGate
  readonly signal: AbortSignal
  /** Time between readings. Defaults to `DIRECTORY_QUIESCENCE_MIN_SPACING_MS`. */
  readonly spacingMs?: number
  /** Called after every reading. */
  readonly onObservation?: (state: DirectoryStabilityState) => void
  /**
   * Asked before each further reading. `false` ends the wait and drops the streak: whatever it was waiting for has
   * changed, and readings taken for the old evidence do not carry over to the new.
   */
  readonly shouldContinue?: () => boolean
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
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

/**
 * Read the directory until the gate passes. Activity does not end the wait: the run keeps reading, and the caller's
 * signal (the wall clock, the barrier budget) is what bounds it.
 */
export async function awaitDirectoryStability(
  options: AwaitDirectoryStabilityOptions,
): Promise<AwaitDirectoryStabilityResult> {
  const {gate, signal, spacingMs = DIRECTORY_QUIESCENCE_MIN_SPACING_MS, onObservation, shouldContinue} = options
  while (true) {
    if (signal.aborted) return {passed: false, reason: 'aborted'}
    if (shouldContinue?.() === false) {
      gate.reset()
      return {passed: false, reason: 'invalidated'}
    }
    const state = await gate.step(signal)
    onObservation?.(state)
    if (state.passed) return {passed: true}
    if (signal.aborted) return {passed: false, reason: 'aborted'}
    await sleep(spacingMs, signal)
  }
}
