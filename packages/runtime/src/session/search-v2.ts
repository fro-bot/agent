/** V2 sibling of `search.ts`: listing, content search (reads at most `SEARCH_MAX_SESSIONS` sessions) and summaries. */

import type {Result} from '@bfra.me/es/result'
import type {Logger} from '../shared/logger.js'
import type {SessionClientV2} from './backend-v2.js'
import type {MessageV2, SessionInfoV2, TodoItemV2} from './types-v2.js'
import type {SessionMatch, SessionSearchResult} from './types.js'

import {err, ok} from '@bfra.me/es/result'
import {latestTodosV2} from './storage-message-mappers-v2.js'
import {getSessionMessagesV2, getSessionV2, listSessionsForDirectoryV2} from './storage-v2.js'

/** Most sessions one content search will read. */
export const SEARCH_MAX_SESSIONS = 100

const EXCERPT_CONTEXT_CHARS = 50

export async function listSessionsV2(
  client: SessionClientV2,
  directory: string,
  options: {readonly limit?: number; readonly fromDate?: Date; readonly toDate?: Date},
  logger: Logger,
): Promise<Result<readonly SessionInfoV2[], Error>> {
  const {limit, fromDate, toDate} = options
  logger.debug('Listing V2 sessions', {directory, limit})

  const listed = await listSessionsForDirectoryV2(client, directory, logger)
  if (!listed.success) return listed

  // Filter again in case the server ignores the root and unarchived query filters.
  const filtered = listed.data.filter(session => {
    if (session.parentID != null || session.time.archived != null) return false
    if (fromDate != null && session.time.created < fromDate.getTime()) return false
    if (toDate != null && session.time.created > toDate.getTime()) return false
    return true
  })

  const sorted = filtered.toSorted((a, b) => b.time.updated - a.time.updated)
  const limited = limit == null ? sorted : sorted.slice(0, limit)
  logger.info('Listed V2 sessions', {count: limited.length, directory})
  return ok(limited)
}

function uniqueAgents(messages: readonly MessageV2[]): readonly string[] {
  const agents = new Set<string>()
  for (const message of messages) {
    if (message.agent != null) agents.add(message.agent)
  }
  return [...agents]
}

function searchMessages(
  messages: readonly MessageV2[],
  pattern: string,
  caseSensitive: boolean,
): readonly SessionMatch[] {
  const matches: SessionMatch[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      const searchText = caseSensitive ? part.text : part.text.toLowerCase()
      const index = searchText.indexOf(pattern)
      if (index === -1) continue

      const start = Math.max(0, index - EXCERPT_CONTEXT_CHARS)
      const end = Math.min(part.text.length, index + pattern.length + EXCERPT_CONTEXT_CHARS)
      matches.push({
        messageId: message.id,
        partId: part.id,
        excerpt: `...${part.text.slice(start, end)}...`,
        role: message.role,
        ...(message.agent == null ? {} : {agent: message.agent}),
      })
    }
  }
  return matches
}

export async function searchSessionsV2(
  query: string,
  client: SessionClientV2,
  directory: string,
  options: {
    readonly limit?: number
    readonly caseSensitive?: boolean
    readonly sessionId?: string
    readonly excludeSessionIds?: readonly string[]
  },
  logger: Logger,
): Promise<Result<readonly SessionSearchResult[], Error>> {
  const {limit = 20, caseSensitive = false, sessionId, excludeSessionIds = []} = options
  const excluded = new Set(excludeSessionIds)
  const pattern = caseSensitive ? query : query.toLowerCase()
  logger.debug('Searching V2 sessions', {directory, limit, caseSensitive})

  if (sessionId != null) {
    if (excluded.has(sessionId)) return ok([])
    const messages = await getSessionMessagesV2(client, sessionId, logger)
    if (!messages.success) return messages
    const matches = searchMessages(messages.data, pattern, caseSensitive)
    return ok(matches.length === 0 ? [] : [{sessionId, matches: matches.slice(0, limit)}])
  }

  const listed = await listSessionsV2(client, directory, {}, logger)
  if (!listed.success) return listed

  const results: SessionSearchResult[] = []
  let totalMatches = 0
  for (const session of listed.data.filter(s => !excluded.has(s.id)).slice(0, SEARCH_MAX_SESSIONS)) {
    if (totalMatches >= limit) break

    const messages = await getSessionMessagesV2(client, session.id, logger)
    if (!messages.success) continue // already logged; one unreadable session must not sink the whole search

    const matches = searchMessages(messages.data, pattern, caseSensitive)
    if (matches.length === 0) continue
    const kept = matches.slice(0, limit - totalMatches)
    results.push({sessionId: session.id, matches: kept})
    totalMatches += kept.length
  }

  logger.info('V2 session search complete', {resultCount: results.length, totalMatches})
  return ok(results)
}

export interface SessionDetailsV2 {
  readonly session: SessionInfoV2
  readonly messageCount: number
  readonly agents: readonly string[]
  readonly hasTodos: boolean
  readonly todoCount: number
  readonly completedTodos: number
}

/** Resolves to `ok(null)` when the session does not exist. */
export async function getSessionInfoV2(
  client: SessionClientV2,
  sessionId: string,
  logger: Logger,
): Promise<Result<SessionDetailsV2 | null, Error>> {
  const session = await getSessionV2(client, sessionId, logger)
  if (!session.success) return session
  if (session.data == null) return ok(null)

  const messages = await getSessionMessagesV2(client, sessionId, logger)
  if (!messages.success) return err(messages.error)

  const todos: readonly TodoItemV2[] = latestTodosV2(messages.data)
  return ok({
    session: session.data,
    messageCount: messages.data.length,
    agents: uniqueAgents(messages.data),
    hasTodos: todos.length > 0,
    todoCount: todos.length,
    completedTodos: todos.filter(todo => todo.status === 'completed').length,
  })
}
