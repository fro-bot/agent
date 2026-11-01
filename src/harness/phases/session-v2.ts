import type {LogicalSessionKey, SessionSearchResult, SessionSummary} from '@fro-bot/runtime'
import type {SessionClientV2, SessionListQueryV2} from '@fro-bot/runtime/session-v2'
import type {Logger} from '../../shared/logger.js'
import {buildSessionTitle} from '@fro-bot/runtime'
import {
  getSessionInfoV2,
  listSessionsForDirectoryV2,
  listSessionsV2,
  searchSessionsV2,
} from '@fro-bot/runtime/session-v2'
import {toErrorMessage} from '../../shared/errors.js'

/**
 * The session reads of a V2 run: prior-work context and logical-key continuity, over the server's own HTTP routes.
 *
 * V1 read sessions through the SDK client (`listSessions`, `searchSessions`, `resolveSessionForLogicalKey`). V2 has
 * runtime siblings for the first two (`listSessionsV2`, `searchSessionsV2`, over a `SessionClientV2`) and none for
 * continuity, which is added here. The `fro-bot` plugin's session tools adapt the same `SessionClientV2` over the
 * plugin context; this adapts it over `handle.fetch`, so both read V2 sessions through the same mappers and see the same
 * ids and titles.
 *
 * Continuity key: the V2 session title is `fro-bot: <logical key>` (`buildSessionTitle`), set at creation
 * (`createSession({title})`) and re-asserted after each prompt, because V2 may regenerate a title.
 */

type FetchRoute = (path: string, init?: RequestInit) => Promise<Response>

const ROUTE_TIMEOUT_MS = 15_000

class HttpStatusError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`http ${status}`)
    this.name = 'HttpStatusError'
    this.status = status
  }
}

async function readJson(fetchRoute: FetchRoute, path: string): Promise<unknown> {
  const response = await fetchRoute(path, {signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS)})
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new HttpStatusError(response.status)
  }
  return response.json()
}

function listQueryString(query: SessionListQueryV2): string {
  const params = new URLSearchParams()
  if (query.directory !== undefined) params.set('directory', query.directory)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.cursor !== undefined) params.set('cursor', query.cursor)
  if (query.order !== undefined) params.set('order', query.order)
  if (query.parentID !== undefined) params.set('parentID', query.parentID === null ? 'null' : query.parentID)
  if (query.archived !== undefined) params.set('archived', query.archived ? 'true' : 'false')
  return params.toString()
}

/** `SessionClientV2` over the server handle's authenticated fetch (`path` is relative to the server URL). */
export function createSessionReaderV2(fetchRoute: FetchRoute): SessionClientV2 {
  return {
    list: async query => readJson(fetchRoute, `/api/session?${listQueryString(query)}`),
    get: async sessionId => {
      try {
        return await readJson(fetchRoute, `/api/session/${encodeURIComponent(sessionId)}`)
      } catch (error) {
        if (error instanceof HttpStatusError && error.status === 404) return null
        throw error
      }
    },
    messages: async sessionId => readJson(fetchRoute, `/api/session/${encodeURIComponent(sessionId)}/context`),
  }
}

export type SessionResolutionV2 =
  | {readonly status: 'found'; readonly sessionId: string}
  | {readonly status: 'not-found'}
  | {readonly status: 'error'; readonly error: string}

/**
 * The most recently updated unarchived root session in `workspacePath` whose title is the logical key's title. A
 * listing that fails is an `error`, never `not-found`: an outage must not read as "no session to continue".
 */
export async function resolveSessionForLogicalKeyV2(
  reader: SessionClientV2,
  workspacePath: string,
  key: LogicalSessionKey,
  logger: Logger,
): Promise<SessionResolutionV2> {
  const listed = await listSessionsForDirectoryV2(reader, workspacePath, logger)
  if (!listed.success) return {status: 'error', error: listed.error.message}

  const title = buildSessionTitle(key)
  const matches = listed.data.filter(session => session.title === title && session.parentID == null)
  if (matches.length === 0) return {status: 'not-found'}

  const latest = matches.reduce((best, current) => (current.time.updated > best.time.updated ? current : best))
  return {status: 'found', sessionId: latest.id}
}

const RECENT_SESSION_LIMIT = 10
const PRIOR_WORK_LIMIT = 5

/** Recent sessions and prior-work matches for the prompt. Each part fails soft to empty, as V1's eager strategy does. */
export async function prepareSessionContextV2(options: {
  readonly reader: SessionClientV2
  readonly workspacePath: string
  readonly searchQuery: string
  readonly logger: Logger
}): Promise<{
  readonly recentSessions: readonly SessionSummary[]
  readonly priorWorkContext: readonly SessionSearchResult[]
}> {
  const {reader, workspacePath, searchQuery, logger} = options

  let recentSessions: readonly SessionSummary[] = []
  try {
    const listed = await listSessionsV2(reader, workspacePath, {limit: RECENT_SESSION_LIMIT}, logger)
    if (listed.success) {
      const summaries: SessionSummary[] = []
      for (const session of listed.data) {
        const details = await getSessionInfoV2(reader, session.id, logger)
        summaries.push({
          id: session.id,
          projectID: session.projectID,
          directory: session.directory,
          title: session.title,
          createdAt: session.time.created,
          updatedAt: session.time.updated,
          messageCount: details.success && details.data !== null ? details.data.messageCount : 0,
          agents: details.success && details.data !== null ? details.data.agents : [],
          isChild: session.parentID != null,
        })
      }
      recentSessions = summaries
    } else {
      logger.warning('Recent session lookup failed; proceeding with empty context', {error: listed.error.message})
    }
  } catch (error) {
    logger.warning('Recent session lookup failed; proceeding with empty context', {error: toErrorMessage(error)})
  }

  let priorWorkContext: readonly SessionSearchResult[] = []
  try {
    const searched = await searchSessionsV2(searchQuery, reader, workspacePath, {limit: PRIOR_WORK_LIMIT}, logger)
    if (searched.success) priorWorkContext = searched.data
    else
      logger.warning('Prior-work session search failed; proceeding with empty context', {error: searched.error.message})
  } catch (error) {
    logger.warning('Prior-work session search failed; proceeding with empty context', {error: toErrorMessage(error)})
  }

  return {recentSessions, priorWorkContext}
}
