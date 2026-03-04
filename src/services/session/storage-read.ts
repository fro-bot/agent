import type {SessionClient} from './backend.js'
import type {Logger, Message, SessionInfo, TodoItem} from './types.js'

import {mapSdkMessageToMessage} from './storage-message-base-mapper.js'
import {mapSdkMessages} from './storage-messages-collection.js'
import {mapSdkPartToPart} from './storage-part-mapper.js'
import {mapSdkSessionToSessionInfo} from './storage-session-mappers.js'
import {mapSdkTodos} from './storage-todo-mappers.js'

export {mapSdkMessageToMessage, mapSdkPartToPart, mapSdkSessionToSessionInfo}

export async function listSessionsForProject(
  client: SessionClient,
  workspacePath: string,
  logger: Logger,
): Promise<readonly SessionInfo[]> {
  const response = await client.session.list({query: {directory: workspacePath}})
  if (response.error == null && response.data != null) {
    if (!Array.isArray(response.data)) return []
    return response.data.map(mapSdkSessionToSessionInfo)
  }

  logger.warning('SDK session list failed', {error: String(response.error)})
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
    logger.warning('SDK session list failed', {error: String(response.error)})
    return null
  }
  if (!Array.isArray(response.data) || response.data.length === 0) {
    return null
  }

  const sessions = response.data.map(mapSdkSessionToSessionInfo)
  if (sessions.length === 0) {
    return null
  }

  const latest = sessions.reduce((max, session) => (session.time.created > max.time.created ? session : max))
  return {projectID: latest.projectID, session: latest}
}
