import type {PruningConfig} from '@fro-bot/runtime'
import type {SessionClientV2} from '@fro-bot/runtime/session-v2'
import type {Logger} from '../../shared/logger.js'
import {listSessionsForDirectoryV2} from '@fro-bot/runtime/session-v2'
import {toErrorMessage} from '../../shared/errors.js'

/**
 * Session pruning on OpenCode V2: the sibling of `pruneSessions` (runtime), which V1 runs before the cache save so the
 * saved database does not grow with every run.
 *
 * The retention rule is V1's: keep a root session if it was updated within `maxAgeDays` OR it is among the newest
 * `maxSessions`; delete the rest. V1 deleted a root and then each of its children; on V2 `DELETE /api/session/:id` is
 * documented to delete the session and its child sessions, so one call per root is enough.
 *
 * What it reads: the unarchived root sessions created in `directory`, newest first, up to the list page bound
 * (`SESSION_LIST_MAX_PAGES` pages of 100). A session archived by overflow recovery is therefore not counted and not
 * pruned: it is dead by construction and rare. A list that cannot be read prunes nothing.
 *
 * It runs only after the run's directory was confirmed quiet and while the server is still up: deleting a session that
 * is still running is exactly what a release must not do.
 */

const DELETE_TIMEOUT_MS = 15_000
const DAY_MS = 24 * 60 * 60 * 1000

type FetchRoute = (path: string, init?: RequestInit) => Promise<Response>

export interface PruneSessionsV2Options {
  readonly reader: SessionClientV2
  readonly fetchRoute: FetchRoute
  /** The directory the run's sessions were created with: the exact string the server stored. */
  readonly directory: string
  readonly config: PruningConfig
  readonly logger: Logger
  /** Test seam. */
  readonly now?: () => number
}

export interface PruneSessionsV2Result {
  readonly prunedCount: number
  readonly remainingCount: number
}

async function deleteSessionV2(fetchRoute: FetchRoute, sessionId: string): Promise<boolean> {
  const response = await fetchRoute(`/api/session/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
  })
  await response.body?.cancel().catch(() => undefined)
  // Gone already is as good as deleted.
  return response.ok || response.status === 404
}

export async function pruneSessionsV2(options: PruneSessionsV2Options): Promise<PruneSessionsV2Result> {
  const {reader, fetchRoute, directory, config, logger} = options
  const now = options.now ?? Date.now
  logger.info('Starting session pruning', {maxSessions: config.maxSessions, maxAgeDays: config.maxAgeDays})

  const listed = await listSessionsForDirectoryV2(reader, directory, logger)
  if (!listed.success) {
    logger.warning('Session pruning skipped: the session list could not be read', {error: listed.error.message})
    return {prunedCount: 0, remainingCount: 0}
  }

  const sessions = [...listed.data].sort((a, b) => b.time.updated - a.time.updated)
  const cutoff = now() - config.maxAgeDays * DAY_MS
  const keep = new Set<string>()
  for (const session of sessions) if (session.time.updated >= cutoff) keep.add(session.id)
  for (const session of sessions.slice(0, config.maxSessions)) keep.add(session.id)

  const doomed = sessions.filter(session => !keep.has(session.id))
  if (doomed.length === 0) {
    logger.info('No sessions to prune')
    return {prunedCount: 0, remainingCount: sessions.length}
  }

  let prunedCount = 0
  for (const session of doomed) {
    try {
      if (await deleteSessionV2(fetchRoute, session.id)) {
        prunedCount += 1
        logger.debug('Pruned session', {sessionId: session.id})
      } else {
        logger.warning('Failed to prune session', {sessionId: session.id})
      }
    } catch (error) {
      logger.warning('Failed to prune session', {sessionId: session.id, error: toErrorMessage(error)})
    }
  }

  logger.info('Session pruning complete', {prunedCount, remainingCount: sessions.length - doomed.length})
  return {prunedCount, remainingCount: sessions.length - doomed.length}
}
