import type {DirectoryActivity, DirectoryObservation} from './directory-quiescence-v2.js'
import type {V2InboxItemMeta} from './remote-client-v2.js'

/**
 * Progress lines for the V2 drain: what the run is waiting on, at info, so a stalled drain names its blocker in the job
 * log instead of polling in silence at debug (#2005). Shared by the Action's drain and the gateway's drain gate, which
 * log through differently shaped loggers, so this module takes an `emit` and owns no logger.
 *
 * Log-safe by construction. A line carries ids (session, shell) and enum-like inbox fields, capped; it never carries
 * message text, command text or anything else a user or the model wrote. `describeBlockingSet` copies an explicit
 * allow-list of fields, so a reading that grows a new field cannot leak it into a log.
 */

/** Ids listed per set in one line; the `count` beside each list carries the rest. */
export const BLOCKING_SET_ID_CAP = 10
/** Continuous non-quiet time between two progress lines when the blocking set does not change. */
export const DRAIN_HEARTBEAT_MS = 60_000
export const DRAIN_WAITING_MESSAGE = 'Drain waiting on directory activity'
export const DRAIN_UNREADABLE_MESSAGE = 'Drain could not read the directory'
/** Bound on the unreadable reason echoed into a line. */
const REASON_CAP = 200

export interface BlockingInboxEntry {
  readonly sessionId: string
  readonly queued: number
  /** Enum-like metadata of a bounded sample of the queued items (type, delivery, source). */
  readonly items?: readonly V2InboxItemMeta[]
}

/** What a non-quiet reading is blocked on, bounded and log-safe. `count` is the true size; the list is capped. */
export interface BlockingSet {
  readonly sessions: {readonly count: number; readonly ids: readonly string[]}
  readonly shells: {readonly count: number; readonly ids: readonly string[]}
  /** One entry per session with a queued inbox item. */
  readonly inbox: {readonly count: number; readonly items: readonly BlockingInboxEntry[]}
}

/** A blocking set, plus why the reading was unreadable when it was. */
export type BlockingDetail = BlockingSet & {readonly unreadable?: string}

function cappedIds(ids: readonly string[]): {readonly count: number; readonly ids: readonly string[]} {
  return {count: ids.length, ids: [...ids].sort().slice(0, BLOCKING_SET_ID_CAP)}
}

function copyItemMeta(item: V2InboxItemMeta): V2InboxItemMeta {
  return {
    ...(item.type === undefined ? {} : {type: item.type}),
    ...(item.delivery === undefined ? {} : {delivery: item.delivery}),
    ...(item.source === undefined ? {} : {source: item.source}),
  }
}

export function describeBlockingSet(activity: DirectoryActivity): BlockingSet {
  const inbox = [...activity.queuedInbox].sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  return {
    sessions: cappedIds(activity.activeSessionIds),
    shells: cappedIds(activity.runningShellIds),
    inbox: {
      count: inbox.length,
      items: inbox.slice(0, BLOCKING_SET_ID_CAP).map(entry => ({
        sessionId: entry.sessionId,
        queued: entry.queued,
        ...(entry.items === undefined || entry.items.length === 0
          ? {}
          : {items: entry.items.slice(0, BLOCKING_SET_ID_CAP).map(copyItemMeta)}),
      })),
    },
  }
}

/** The blocking set of a reading, with the unreadable reason (bounded) when it had one; `null` for a quiet reading. */
export function describeObservation(observation: DirectoryObservation): BlockingDetail | null {
  if (observation.kind === 'quiescent') return null
  return {
    ...describeBlockingSet(observation.activity),
    ...(observation.kind === 'unreadable' ? {unreadable: observation.reason.slice(0, REASON_CAP)} : {}),
  }
}

/** Identity of a blocking set: every id, not the capped sample, so a change beyond the cap still counts as a change. */
function blockingKey(activity: DirectoryActivity): string {
  const sessions = [...activity.activeSessionIds].sort().join(',')
  const shells = [...activity.runningShellIds].sort().join(',')
  const inbox = activity.queuedInbox
    .map(entry => `${entry.sessionId}:${entry.queued}`)
    .sort()
    .join(',')
  return `s=${sessions}|h=${shells}|i=${inbox}`
}

const EMPTY_KEY = 's=|h=|i='

export interface DrainProgressOptions {
  /** Writes one info line. The caller maps it onto its logger. */
  readonly emit: (message: string, fields: Readonly<Record<string, unknown>>) => void
  /** Test seam. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Overrides `DRAIN_HEARTBEAT_MS`. */
  readonly heartbeatMs?: number
}

export interface DrainProgress {
  /** Feed every reading, quiet ones included: a quiet one ends the current stretch of non-quiet. */
  readonly observe: (observation: DirectoryObservation) => void
  /** The blocking set of the latest non-quiet reading, kept after the directory goes quiet; `null` before any. */
  readonly lastBlocking: () => BlockingDetail | null
}

/**
 * Turns a stream of directory readings into a few info lines:
 * - `DRAIN_WAITING_MESSAGE` when the blocking set changes (one line per change, not per reading);
 * - the same line as a heartbeat after `heartbeatMs` of continuous non-quiet with no line in between, so a stall that
 *   does not change still shows how long it has lasted (an unreadable directory with nothing found included);
 * - `DRAIN_UNREADABLE_MESSAGE` when readings turn unreadable, once per stretch, with the reason.
 *
 * A stretch of non-quiet ends on a quiet reading, or on a gap of at least a heartbeat between readings (the gateway
 * reads only while its gate validates, so a long gap is a different stretch).
 */
export function createDrainProgress(options: DrainProgressOptions): DrainProgress {
  const {emit, now = Date.now, heartbeatMs = DRAIN_HEARTBEAT_MS} = options

  let readings = 0
  let stretchStartedAt: number | null = null
  let lastReadingAt = 0
  let lastLineAt = 0
  let lastKey: string | null = null
  let unreadable = false
  let last: BlockingDetail | null = null

  function endStretch(): void {
    stretchStartedAt = null
    lastKey = null
    unreadable = false
  }

  function observe(observation: DirectoryObservation): void {
    const at = now()
    readings += 1
    if (stretchStartedAt !== null && at - lastReadingAt >= heartbeatMs) endStretch()
    lastReadingAt = at
    const blocking = describeObservation(observation)
    if (blocking === null || observation.kind === 'quiescent') {
      endStretch()
      return
    }
    if (stretchStartedAt === null) {
      stretchStartedAt = at
      lastLineAt = at
    }
    const elapsedMs = at - stretchStartedAt
    const reason = blocking.unreadable
    last = blocking

    if (reason === undefined) {
      unreadable = false
    } else if (!unreadable) {
      unreadable = true
      emit(DRAIN_UNREADABLE_MESSAGE, {reason, readings, elapsedMs})
    }

    const key = blockingKey(observation.activity)
    const hasActivity = key !== EMPTY_KEY
    const changed = hasActivity && key !== lastKey
    const heartbeat = at - lastLineAt >= heartbeatMs
    lastKey = hasActivity ? key : null
    if (changed || heartbeat) {
      lastLineAt = at
      emit(DRAIN_WAITING_MESSAGE, {
        sessions: blocking.sessions,
        shells: blocking.shells,
        inbox: blocking.inbox,
        readings,
        elapsedMs,
        ...(reason === undefined ? {} : {unreadable: reason}),
      })
    }
  }

  return {observe, lastBlocking: () => last}
}
