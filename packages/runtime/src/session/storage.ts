import type {SessionClient} from './backend.js'
import type {Logger, Message, SessionInfo, TodoItem} from './types.js'

import {mapSdkSessionToSessionInfo, mapSdkTodos} from './storage-mappers.js'
import {mapSdkMessages} from './storage-message-mappers.js'

export async function listSessionsForProject(
  client: SessionClient,
  workspacePath: string,
  logger: Logger,
): Promise<readonly SessionInfo[]> {
  const response = await client.session.list({query: {directory: workspacePath}})
  if (response.error == null && response.data != null) {
    if (!Array.isArray(response.data)) {
      // Same silent-exit shape as discovery.ts's listProjectsViaSDK: a successful response with a
      // structurally unexpected payload must not look identical to "no sessions". Never the
      // payload itself — its contents aren't known to be safe to emit.
      // `source` names the calling function. It appears only on warnings whose message text is
      // shared with another call site (this one and findLatestSession both list sessions and log
      // the same two messages); warnings with a unique message text deliberately omit it.
      logger.warning('SDK session list returned a non-array payload', {
        source: 'listSessionsForProject',
        type: typeof response.data,
        constructor: (response.data as object).constructor?.name,
      })
      return []
    }
    return response.data.map(mapSdkSessionToSessionInfo)
  }

  logger.warning('SDK session list failed', {source: 'listSessionsForProject', error: String(response.error)})
  return []
}

export async function getSession(
  client: SessionClient,
  sessionID: string,
  logger: Logger,
): Promise<SessionInfo | null> {
  const response = await client.session.get({path: {id: sessionID}})
  if (response.error != null || response.data == null) {
    logger.warning('SDK session get failed', {error: String(response.error)})
    return null
  }

  return mapSdkSessionToSessionInfo(response.data)
}

export async function getSessionMessages(
  client: SessionClient,
  sessionID: string,
  logger: Logger,
): Promise<readonly Message[]> {
  const response = await client.session.messages({path: {id: sessionID}})
  if (response.error == null && response.data != null) {
    if (!Array.isArray(response.data)) {
      logger.warning('SDK session messages returned a non-array payload', {
        type: typeof response.data,
        constructor: (response.data as object).constructor?.name,
      })
      return []
    }
    return mapSdkMessages(response.data)
  }

  logger.warning('SDK session messages failed', {error: String(response.error)})
  return []
}

export async function getSessionTodos(
  client: SessionClient,
  sessionID: string,
  logger: Logger,
): Promise<readonly TodoItem[]> {
  const sessionClient = client.session as unknown as {
    todos: (args: {path: {id: string}}) => Promise<{data?: unknown; error?: unknown}>
  }
  const response = await sessionClient.todos({path: {id: sessionID}})
  if (response.error == null && response.data != null) {
    if (!Array.isArray(response.data)) {
      // Hoisted from mapSdkTodos's own guard: a logger is in scope here, not in storage-mappers.ts
      // (a pure-mapping module with no I/O concerns), so this is where the structurally-unexpected
      // case can be made visible instead of looking identical to "no todos".
      logger.warning('SDK session todos returned a non-array payload', {
        type: typeof response.data,
        constructor: response.data.constructor?.name,
      })
      return []
    }
    return mapSdkTodos(response.data)
  }

  logger.warning('SDK session todos failed', {error: String(response.error)})
  return []
}

export async function findLatestSession(
  client: SessionClient,
  workspacePath: string,
  afterTimestamp: number,
  logger: Logger,
): Promise<{projectID: string; session: SessionInfo} | null> {
  const response = await client.session.list({
    query: {directory: workspacePath, start: afterTimestamp, roots: true, limit: 10} as Record<string, unknown>,
  })
  if (response.error != null || response.data == null) {
    logger.warning('SDK session list failed', {source: 'findLatestSession', error: String(response.error)})
    return null
  }
  if (!Array.isArray(response.data)) {
    // A structurally unexpected payload must not collapse into the same `null` as a genuinely
    // empty result ("no sessions since this timestamp") — that ambiguity is exactly what this
    // module's logging exists to remove. An empty array, by contrast, is normal operation and
    // stays quiet below.
    logger.warning('SDK session list returned a non-array payload', {
      source: 'findLatestSession',
      type: typeof response.data,
      constructor: (response.data as object).constructor?.name,
    })
    return null
  }
  if (response.data.length === 0) {
    return null
  }

  const sessions = response.data.map(mapSdkSessionToSessionInfo)

  const latest = sessions.reduce((max, session) => (session.time.created > max.time.created ? session : max))
  return {projectID: latest.projectID, session: latest}
}

export async function deleteSession(client: SessionClient, sessionID: string, logger: Logger): Promise<void> {
  const response = await client.session.delete({path: {id: sessionID}})
  if (response.error != null) {
    logger.warning('SDK session delete failed', {sessionID, error: String(response.error)})
    return
  }

  logger.debug('Deleted session via SDK', {sessionID})
}
