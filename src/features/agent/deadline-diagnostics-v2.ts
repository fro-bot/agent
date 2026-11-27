import type {OwnershipLedger} from '@fro-bot/runtime'
import type {LifecycleSpan} from '../../shared/lifecycle-tracer.js'
import type {Logger} from '../../shared/logger.js'
import type {ActivityTrackerV2} from './streaming-v2.js'
import {isShellLedgerKey, shellIdFromLedgerKey} from '@fro-bot/runtime'

/**
 * What a run was doing when its execution deadline fired, for the one line that explains a stalled root. The deadline
 * itself says only that time ran out; a root that stays open after its final message (fro-bot/agent#2376) left nothing
 * to read, because the event mapper drops the events that show why (a compaction that started and never ended above all).
 *
 * Content-free by construction. The trail below is fed RAW frames, before the mapper, and reads exactly four things from
 * one: its `type`, the `sessionID` in its data, and, for a compaction start, its `reason`. The type is kept only when it
 * is a plain dotted lowercase name, the session only as its last six characters, the reason only when it is one of the two
 * the server defines. No text, input, output, path or message id is read, so none can be logged or traced. Ownership
 * labels are never listed either: a subagent's description is model-controlled.
 *
 * Mutable on purpose, like the tracker that holds it: every SSE frame passes through `recordFrameV2`.
 */

/** Most entries the trail holds. Consecutive repeats fold into one entry, so a token burst costs one. */
export const EVENT_TRAIL_MAX_ENTRIES = 20
/** Most bytes the trail holds: each entry costs its type, its session suffix and a fixed overhead. */
export const EVENT_TRAIL_MAX_BYTES = 1_024
const ENTRY_OVERHEAD_BYTES = 16
const TYPE_MAX_CHARS = 64
const SESSION_SUFFIX_CHARS = 6
const OPEN_COMPACTIONS_MAX = 8
const OUTSTANDING_LISTED_MAX = 10
const QUEUED_INBOX_LISTED_MAX = 8
/** Most characters of the trace event's event list; the span's own text budget is a shared, finite resource. */
const TRACE_EVENT_LIST_MAX_CHARS = 900

const TYPE_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/
const SESSION_ID_PATTERN = /^[\w-]{1,128}$/

export type TrailRole = 'child' | 'other' | 'root' | 'server'
export type CompactionReason = 'auto' | 'manual'

export interface TrailEntry {
  readonly type: string
  readonly role: TrailRole
  /** The last characters of the session id, `null` for an event of no session. */
  readonly session: string | null
  /** When the last of the folded events arrived (epoch ms). */
  atMs: number
  /** How many consecutive identical events this entry stands for. */
  count: number
}

export interface OpenCompaction {
  readonly role: Exclude<TrailRole, 'server'>
  readonly session: string
  readonly reason: CompactionReason | null
  readonly atMs: number
}

export interface EventTrailV2 {
  /** Oldest first. */
  readonly entries: TrailEntry[]
  /** The summed cost of `entries`, never above `EVENT_TRAIL_MAX_BYTES`. */
  bytes: number
  /** Compactions that started and have not ended or failed, by full session id. */
  readonly openCompactions: Map<string, OpenCompaction>
  /** How the most recent compaction that ended did so, `null` before any. */
  lastCompactionEnd: 'ended' | 'failed' | null
}

export function createEventTrailV2(): EventTrailV2 {
  return {entries: [], bytes: 0, openCompactions: new Map(), lastCompactionEnd: null}
}

export interface RecordFrameContext {
  readonly rootSessionId: string
  readonly isOwned: (sessionId: string) => boolean
  readonly nowMs: number
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null
  const property = (value as Record<string, unknown>)[key]
  return typeof property === 'string' ? property : null
}

function readReason(data: unknown): CompactionReason | null {
  const reason = readString(data, 'reason')
  return reason === 'auto' || reason === 'manual' ? reason : null
}

function entryCost(type: string, session: string | null): number {
  return type.length + (session?.length ?? 0) + ENTRY_OVERHEAD_BYTES
}

/** Record one raw SSE frame. Never throws and never keeps anything of the frame beyond what the module doc lists. */
export function recordFrameV2(trail: EventTrailV2, frame: unknown, context: RecordFrameContext): void {
  const rawType = readString(frame, 'type')
  if (rawType === null) return
  const type = rawType.length <= TYPE_MAX_CHARS && TYPE_PATTERN.test(rawType) ? rawType : 'unknown'
  const data = typeof frame === 'object' && frame !== null ? (frame as Record<string, unknown>).data : undefined
  const rawSession = readString(data, 'sessionID')
  const sessionId = rawSession !== null && SESSION_ID_PATTERN.test(rawSession) ? rawSession : null
  const role: TrailRole =
    sessionId === null
      ? 'server'
      : sessionId === context.rootSessionId
        ? 'root'
        : context.isOwned(sessionId)
          ? 'child'
          : 'other'
  const session = sessionId === null ? null : sessionId.slice(-SESSION_SUFFIX_CHARS)

  const last = trail.entries.at(-1)
  if (last !== undefined && last.type === type && last.role === role && last.session === session) {
    last.count += 1
    last.atMs = context.nowMs
  } else {
    trail.entries.push({type, role, session, atMs: context.nowMs, count: 1})
    trail.bytes += entryCost(type, session)
    while (
      trail.entries.length > 1 &&
      (trail.entries.length > EVENT_TRAIL_MAX_ENTRIES || trail.bytes > EVENT_TRAIL_MAX_BYTES)
    ) {
      const dropped = trail.entries.shift()
      if (dropped !== undefined) trail.bytes -= entryCost(dropped.type, dropped.session)
    }
  }

  trackCompaction(trail, type, role, sessionId, session, data, context.nowMs)
}

function trackCompaction(
  trail: EventTrailV2,
  type: string,
  role: TrailRole,
  sessionId: string | null,
  session: string | null,
  data: unknown,
  nowMs: number,
): void {
  if (role === 'server' || session === null) return
  const key = sessionId ?? session
  if (type === 'session.compaction.started') {
    // Re-keyed so the oldest open one is the first in the map, and the one dropped when the bound is hit.
    trail.openCompactions.delete(key)
    trail.openCompactions.set(key, {role, session, reason: readReason(data), atMs: nowMs})
    while (trail.openCompactions.size > OPEN_COMPACTIONS_MAX) {
      const oldest = trail.openCompactions.keys().next()
      if (oldest.done === true) break
      trail.openCompactions.delete(oldest.value)
    }
  } else if (type === 'session.compaction.ended' || type === 'session.compaction.failed') {
    trail.openCompactions.delete(key)
    trail.lastCompactionEnd = type === 'session.compaction.ended' ? 'ended' : 'failed'
  }
}

export type WaitingReason = 'execution-not-ended' | 'inbox-queued' | 'notice-turn-owed' | 'owned-work-outstanding'

export interface DeadlineStateV2 {
  /** The root session, as the last characters of its id. */
  readonly rootSession: string
  /** What the run's completion was still waiting on, from the same facts `observeRootTerminal` decides on. */
  readonly waitingOn: readonly WaitingReason[]
  readonly rootTerminal: 'failed' | 'interrupted' | 'succeeded' | null
  readonly rootRunning: boolean
  readonly turnOwed: boolean
  /** The stream lost events, so `turnOwed` and the queue are not trusted by the completion rule. */
  readonly streamBlind: boolean
  readonly queuedInbox: {readonly count: number; readonly ids: readonly string[]}
  readonly outstanding: {
    readonly count: number
    readonly entries: readonly {
      readonly kind: 'child' | 'shell'
      readonly session: string
      readonly state: 'outstanding' | 'unknown'
    }[]
  }
  readonly compaction: {
    readonly state: 'ended' | 'failed' | 'none' | 'started-not-ended'
    readonly open: readonly {
      readonly role: Exclude<TrailRole, 'server'>
      readonly session: string
      readonly reason: CompactionReason | null
      /** Milliseconds relative to the deadline: negative, how long before it the compaction started. */
      readonly startedMs: number
    }[]
  }
  /** Oldest first. `t` is milliseconds relative to the deadline (negative: before it); `n` is set for a folded run. */
  readonly recentEvents: readonly {
    readonly type: string
    readonly role: TrailRole
    readonly session: string | null
    readonly t: number
    readonly n?: number
  }[]
}

export interface DescribeDeadlineStateOptions {
  readonly tracker: ActivityTrackerV2
  readonly ledger?: OwnershipLedger
  readonly rootSessionId: string
  /** The moment the deadline fired (epoch ms): the zero of every relative time. */
  readonly nowMs: number
}

export function describeDeadlineStateV2(options: DescribeDeadlineStateOptions): DeadlineStateV2 {
  const {tracker, ledger, rootSessionId, nowMs} = options
  const {eventTrail: trail} = tracker

  const queued = [...tracker.queuedNoticeInboxIds]
  const unsettled = (ledger?.snapshot() ?? []).filter(entry => entry.state !== 'settled')
  const waitingOn: WaitingReason[] = []
  // A null result with a notice turn owed or queued is explained by those; a root that is running, or that never ended
  // for any other reason, has an execution that did not end.
  if (tracker.rootRunning || (tracker.rootTerminal === null && !tracker.turnOwed && queued.length === 0)) {
    waitingOn.push('execution-not-ended')
  }
  if (tracker.turnOwed) waitingOn.push('notice-turn-owed')
  if (queued.length > 0) waitingOn.push('inbox-queued')
  if (ledger !== undefined && !ledger.isDrainComplete()) waitingOn.push('owned-work-outstanding')

  const open = [...trail.openCompactions.values()].map(compaction => ({
    role: compaction.role,
    session: compaction.session,
    reason: compaction.reason,
    startedMs: compaction.atMs - nowMs,
  }))

  return {
    rootSession: rootSessionId.slice(-SESSION_SUFFIX_CHARS),
    waitingOn,
    rootTerminal: tracker.rootTerminal?.kind ?? null,
    rootRunning: tracker.rootRunning,
    turnOwed: tracker.turnOwed,
    streamBlind: tracker.streamBlind,
    queuedInbox: {
      count: queued.length,
      ids: queued.slice(0, QUEUED_INBOX_LISTED_MAX).map(id => id.slice(-SESSION_SUFFIX_CHARS)),
    },
    outstanding: {
      count: unsettled.length,
      entries: unsettled.slice(0, OUTSTANDING_LISTED_MAX).map(entry => {
        const shell = isShellLedgerKey(entry.sessionId)
        return {
          kind: shell ? ('shell' as const) : ('child' as const),
          session: (shell ? shellIdFromLedgerKey(entry.sessionId) : entry.sessionId).slice(-SESSION_SUFFIX_CHARS),
          state: entry.state === 'unknown' ? ('unknown' as const) : ('outstanding' as const),
        }
      }),
    },
    compaction: {
      state: open.length > 0 ? 'started-not-ended' : (trail.lastCompactionEnd ?? 'none'),
      open,
    },
    recentEvents: trail.entries.map(entry => ({
      type: entry.type,
      role: entry.role,
      session: entry.session,
      t: entry.atMs - nowMs,
      ...(entry.count > 1 ? {n: entry.count} : {}),
    })),
  }
}

/** The event list as one string, newest kept first when it must be cut. Every part is a validated name or a number. */
function describeRecentEvents(events: DeadlineStateV2['recentEvents']): string {
  const parts: string[] = []
  let length = 0
  for (const event of [...events].reverse()) {
    const part = `${event.type} ${event.role}${event.session === null ? '' : `:${event.session}`} ${event.t}ms${event.n === undefined ? '' : ` x${event.n}`}`
    length += part.length + 2
    if (length > TRACE_EVENT_LIST_MAX_CHARS) break
    parts.push(part)
  }
  return parts.reverse().join('; ')
}

/** The trace event's attributes: fixed keys, and values that are fixed words, numbers or validated names. */
function traceAttributes(state: DeadlineStateV2): Record<string, string> {
  const firstOpen = state.compaction.open[0]
  return {
    'fro_bot.waiting_on': state.waitingOn.length === 0 ? 'none' : state.waitingOn.join(','),
    'fro_bot.root_terminal': state.rootTerminal ?? 'none',
    'fro_bot.root_running': String(state.rootRunning),
    'fro_bot.compaction': state.compaction.state,
    ...(firstOpen === undefined
      ? {}
      : {
          'fro_bot.compaction.reason': firstOpen.reason ?? 'unknown',
          'fro_bot.compaction.started_ms': String(firstOpen.startedMs),
        }),
    'fro_bot.queued_inbox': String(state.queuedInbox.count),
    'fro_bot.outstanding': String(state.outstanding.count),
    'fro_bot.recent_events': describeRecentEvents(state.recentEvents),
  }
}

export interface ReportDeadlineDiagnosticsOptions extends Omit<DescribeDeadlineStateOptions, 'nowMs'> {
  readonly logger: Logger
  /** The `execution` phase's span. The no-op span of a run that is not traced swallows the event. */
  readonly traceSpan?: LifecycleSpan
  readonly nowMs?: number
}

/**
 * Log one structured line, and add one event to the trace span, saying what the root was doing when the deadline fired.
 * Reads state already in memory: no request, no wait. Never throws: it runs inside the deadline's own latch, and the abort
 * that follows must not depend on a log sink or a closed span.
 */
export function reportDeadlineDiagnosticsV2(options: ReportDeadlineDiagnosticsOptions): void {
  const {logger, traceSpan} = options
  let state: DeadlineStateV2
  try {
    state = describeDeadlineStateV2({...options, nowMs: options.nowMs ?? Date.now()})
  } catch {
    return
  }
  try {
    logger.warning('Execution deadline diagnostics', {...state})
  } catch {
    // The trace event below is independent of the log sink.
  }
  try {
    traceSpan?.addEvent('deadline.diagnostics', traceAttributes(state))
  } catch {
    // A span that is closed or capped must not stop the abort that follows.
  }
}
