import type {Logger, Message, Part, SessionInfo, SessionMatch, SessionSearchResult, SessionSummary} from './types.js'

import {
  findProjectByDirectory,
  getMessageParts,
  getSession,
  getSessionMessages,
  getSessionTodos,
  listSessionsForProject,
} from './storage.js'

/**
 * List all main sessions (excluding child/branched sessions) for a directory.
 * Returns sessions sorted by updatedAt descending (most recent first).
 */
export async function listSessions(
  directory: string,
  options: {limit?: number; fromDate?: Date; toDate?: Date},
  logger: Logger,
): Promise<readonly SessionSummary[]> {
  const {limit, fromDate, toDate} = options

  logger.debug('Listing sessions', {directory, limit})

  // Find project by directory
  const project = await findProjectByDirectory(directory, logger)
  if (project == null) {
    logger.debug('No project found for directory', {directory})
    return []
  }

  // Get all sessions for this project
  const sessions = await listSessionsForProject(project.id, logger)

  // Filter to main sessions only (no parentID) and apply date filters
  const filtered = sessions.filter(session => {
    // Exclude child sessions
    if (session.parentID != null) return false

    // Apply date filters
    if (fromDate != null && session.time.created < fromDate.getTime()) return false
    if (toDate != null && session.time.created > toDate.getTime()) return false

    return true
  })

  // Sort by updatedAt descending
  const sorted = [...filtered].sort((a, b) => b.time.updated - a.time.updated)

  // Build summaries with message counts
  const summaries: SessionSummary[] = []
  const sessionsToProcess = limit == null ? sorted : sorted.slice(0, limit)

  for (const session of sessionsToProcess) {
    const messages = await getSessionMessages(session.id, logger)
    const agents = extractAgentsFromMessages(messages)

    summaries.push({
      id: session.id,
      projectID: session.projectID,
      directory: session.directory,
      title: session.title,
      createdAt: session.time.created,
      updatedAt: session.time.updated,
      messageCount: messages.length,
      agents,
      isChild: false,
    })
  }

  logger.info('Listed sessions', {count: summaries.length, directory})
  return summaries
}

/**
 * Extract unique agent names from messages.
 */
function extractAgentsFromMessages(messages: readonly Message[]): readonly string[] {
  const agents = new Set<string>()

  for (const message of messages) {
    if (message.agent != null) {
      agents.add(message.agent)
    }
  }

  return [...agents]
}

/**
 * Search session content for matching text.
 */
export async function searchSessions(
  query: string,
  directory: string,
  options: {limit?: number; caseSensitive?: boolean; sessionId?: string},
  logger: Logger,
): Promise<readonly SessionSearchResult[]> {
  const {limit = 20, caseSensitive = false, sessionId} = options

  logger.debug('Searching sessions', {query, directory, limit, caseSensitive})

  const searchPattern = caseSensitive ? query : query.toLowerCase()
  const results: SessionSearchResult[] = []
  let totalMatches = 0

  // If specific session, search only that one
  if (sessionId != null) {
    const matches = await searchSessionContent(sessionId, searchPattern, caseSensitive, logger)
    if (matches.length > 0) {
      results.push({sessionId, matches: matches.slice(0, limit)})
    }
    return results
  }

  // Otherwise search all sessions for the directory
  const sessions = await listSessions(directory, {}, logger)

  for (const session of sessions) {
    if (totalMatches >= limit) break

    const matches = await searchSessionContent(session.id, searchPattern, caseSensitive, logger)

    if (matches.length > 0) {
      const remainingLimit = limit - totalMatches
      results.push({
        sessionId: session.id,
        matches: matches.slice(0, remainingLimit),
      })
      totalMatches += Math.min(matches.length, remainingLimit)
    }
  }

  logger.info('Session search complete', {query, resultCount: results.length, totalMatches})
  return results
}

/**
 * Search within a single session's content.
 */
async function searchSessionContent(
  sessionId: string,
  pattern: string,
  caseSensitive: boolean,
  logger: Logger,
): Promise<readonly SessionMatch[]> {
  const messages = await getSessionMessages(sessionId, logger)
  const matches: SessionMatch[] = []

  for (const message of messages) {
    const parts = await getMessageParts(message.id, logger)

    for (const part of parts) {
      const text = extractTextFromPart(part)
      if (text == null) continue

      const searchText = caseSensitive ? text : text.toLowerCase()

      if (searchText.includes(pattern)) {
        // Extract excerpt around match
        const index = searchText.indexOf(pattern)
        const start = Math.max(0, index - 50)
        const end = Math.min(text.length, index + pattern.length + 50)
        const excerpt = text.slice(start, end)

        matches.push({
          messageId: message.id,
          partId: part.id,
          excerpt: `...${excerpt}...`,
          role: message.role,
          agent: message.agent,
        })
      }
    }
  }

  return matches
}

/**
 * Extract searchable text from a message part.
 */
function extractTextFromPart(part: Part): string | null {
  switch (part.type) {
    case 'text':
      return part.text
    case 'reasoning':
      return part.reasoning
    case 'tool': {
      if (part.state.status === 'completed') {
        return `${part.tool}: ${part.state.output}`
      }
      return null
    }
    case 'step-finish':
      return null
  }
}

/**
 * Get detailed info about a specific session.
 */
export async function getSessionInfo(
  sessionId: string,
  projectID: string,
  logger: Logger,
): Promise<{
  session: SessionInfo
  messageCount: number
  agents: readonly string[]
  hasTodos: boolean
  todoCount: number
  completedTodos: number
} | null> {
  const session = await getSession(projectID, sessionId, logger)
  if (session == null) return null

  const messages = await getSessionMessages(sessionId, logger)
  const agents = extractAgentsFromMessages(messages)
  const todos = await getSessionTodos(sessionId, logger)

  return {
    session,
    messageCount: messages.length,
    agents,
    hasTodos: todos.length > 0,
    todoCount: todos.length,
    completedTodos: todos.filter(t => t.status === 'completed').length,
  }
}
