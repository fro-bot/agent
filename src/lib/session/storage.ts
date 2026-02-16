import type {SessionBackend, SessionClient} from './backend.js'
import type {Logger, Message, Part, ProjectInfo, SessionInfo, TodoItem, ToolState} from './types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import process from 'node:process'

/**
 * Get the OpenCode storage directory path following XDG Base Directory Specification.
 * OpenCode stores session data in JSON files under this path, not in SQLite.
 * This must match OpenCode's own storage path to ensure compatibility.
 */
export function getOpenCodeStoragePath(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME
  const basePath = xdgDataHome ?? path.join(os.homedir(), '.local', 'share')
  return path.join(basePath, 'opencode', 'storage')
}

/**
 * Read and parse a JSON file from OpenCode storage.
 * Returns null on any error to avoid throwing in normal file-not-found scenarios.
 * OpenCode creates files lazily, so absence is expected during initial runs.
 */
async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

/**
 * List all JSON files in a directory, returning parsed contents.
 * Returns empty array if directory doesn't exist - this is expected behavior
 * since OpenCode creates directories on-demand during first session creation.
 */
async function listJsonFiles<T>(dirPath: string): Promise<readonly T[]> {
  try {
    const entries = await fs.readdir(dirPath, {withFileTypes: true})
    const results: T[] = []

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const filePath = path.join(dirPath, entry.name)
        const content = await readJson<T>(filePath)
        if (content != null) {
          results.push(content)
        }
      }
    }

    return results
  } catch {
    return []
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function mapSdkFileDiffs(value: unknown): readonly {file: string; additions: number; deletions: number}[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const results: {file: string; additions: number; deletions: number}[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const file = readString(entry.file) ?? ''
    const additions = readNumber(entry.additions) ?? 0
    const deletions = readNumber(entry.deletions) ?? 0
    results.push({file, additions, deletions})
  }

  return results
}

function mapSdkSummary(value: unknown): SessionInfo['summary'] | undefined {
  if (!isRecord(value)) return undefined
  const additions = readNumber(value.additions) ?? 0
  const deletions = readNumber(value.deletions) ?? 0
  const files = readNumber(value.files) ?? 0
  const diffs = mapSdkFileDiffs(value.diffs)

  return {additions, deletions, files, diffs}
}

function mapSdkShare(value: unknown): SessionInfo['share'] | undefined {
  if (!isRecord(value)) return undefined
  const url = readString(value.url)
  if (url == null) return undefined
  return {url}
}

function mapSdkTime(value: unknown): SessionInfo['time'] {
  if (!isRecord(value)) {
    return {created: 0, updated: 0}
  }

  return {
    created: readNumber(value.created) ?? 0,
    updated: readNumber(value.updated) ?? 0,
    compacting: readNumber(value.compacting) ?? undefined,
    archived: readNumber(value.archived) ?? undefined,
  }
}

export function mapSdkSessionToSessionInfo(sdkSession: unknown): SessionInfo {
  if (!isRecord(sdkSession)) {
    return {
      id: '',
      version: '',
      projectID: '',
      directory: '',
      title: '',
      time: {created: 0, updated: 0},
    }
  }

  const id = readString(sdkSession.id) ?? ''
  const version = readString(sdkSession.version) ?? ''
  const projectID = readString(sdkSession.projectID) ?? readString(sdkSession.projectId) ?? ''
  const directory = readString(sdkSession.directory) ?? ''
  const parentID = readString(sdkSession.parentID) ?? readString(sdkSession.parentId) ?? undefined
  const title = readString(sdkSession.title) ?? ''

  return {
    id,
    version,
    projectID,
    directory,
    parentID,
    title,
    time: mapSdkTime(sdkSession.time),
    summary: mapSdkSummary(sdkSession.summary),
    share: mapSdkShare(sdkSession.share),
    permission: isRecord(sdkSession.permission)
      ? {rules: Array.isArray(sdkSession.permission.rules) ? sdkSession.permission.rules : []}
      : undefined,
    revert: isRecord(sdkSession.revert)
      ? {
          messageID: readString(sdkSession.revert.messageID) ?? readString(sdkSession.revert.messageId) ?? '',
          partID: readString(sdkSession.revert.partID) ?? readString(sdkSession.revert.partId) ?? undefined,
          snapshot: readString(sdkSession.revert.snapshot) ?? undefined,
          diff: readString(sdkSession.revert.diff) ?? undefined,
        }
      : undefined,
  }
}

function mapSdkUserMessage(sdkMessage: Record<string, unknown>): Message {
  const modelRecord = isRecord(sdkMessage.model) ? sdkMessage.model : null
  const providerID =
    readString(modelRecord?.providerID) ??
    readString(modelRecord?.providerId) ??
    readString(sdkMessage.providerID) ??
    readString(sdkMessage.providerId) ??
    ''
  const modelID =
    readString(modelRecord?.modelID) ??
    readString(modelRecord?.modelId) ??
    readString(sdkMessage.modelID) ??
    readString(sdkMessage.modelId) ??
    ''

  const summary = isRecord(sdkMessage.summary)
    ? {
        title: readString(sdkMessage.summary.title) ?? undefined,
        body: readString(sdkMessage.summary.body) ?? undefined,
        diffs: mapSdkFileDiffs(sdkMessage.summary.diffs) ?? [],
      }
    : undefined

  return {
    id: readString(sdkMessage.id) ?? '',
    sessionID: readString(sdkMessage.sessionID) ?? readString(sdkMessage.sessionId) ?? '',
    role: 'user',
    time: {created: readNumber(isRecord(sdkMessage.time) ? sdkMessage.time.created : null) ?? 0},
    summary,
    agent: readString(sdkMessage.agent) ?? '',
    model: {providerID, modelID},
    system: readString(sdkMessage.system) ?? undefined,
    tools: isRecord(sdkMessage.tools) ? (sdkMessage.tools as Record<string, boolean>) : undefined,
    variant: readString(sdkMessage.variant) ?? undefined,
  }
}

function mapSdkAssistantMessage(sdkMessage: Record<string, unknown>): Message {
  const timeRecord = isRecord(sdkMessage.time) ? sdkMessage.time : null
  const tokensRecord = isRecord(sdkMessage.tokens) ? sdkMessage.tokens : null
  const cacheRecord = isRecord(tokensRecord?.cache) ? tokensRecord?.cache : null
  const pathRecord = isRecord(sdkMessage.path) ? sdkMessage.path : null

  return {
    id: readString(sdkMessage.id) ?? '',
    sessionID: readString(sdkMessage.sessionID) ?? readString(sdkMessage.sessionId) ?? '',
    role: 'assistant',
    time: {
      created: readNumber(timeRecord?.created) ?? 0,
      completed: readNumber(timeRecord?.completed) ?? undefined,
    },
    parentID: readString(sdkMessage.parentID) ?? readString(sdkMessage.parentId) ?? '',
    modelID: readString(sdkMessage.modelID) ?? readString(sdkMessage.modelId) ?? '',
    providerID: readString(sdkMessage.providerID) ?? readString(sdkMessage.providerId) ?? '',
    mode: readString(sdkMessage.mode) ?? '',
    agent: readString(sdkMessage.agent) ?? '',
    path: {
      cwd: readString(pathRecord?.cwd) ?? '',
      root: readString(pathRecord?.root) ?? '',
    },
    summary: readBoolean(sdkMessage.summary) ?? undefined,
    cost: readNumber(sdkMessage.cost) ?? 0,
    tokens: {
      input: readNumber(tokensRecord?.input) ?? 0,
      output: readNumber(tokensRecord?.output) ?? 0,
      reasoning: readNumber(tokensRecord?.reasoning) ?? 0,
      cache: {
        read: readNumber(cacheRecord?.read) ?? 0,
        write: readNumber(cacheRecord?.write) ?? 0,
      },
    },
    finish: readString(sdkMessage.finish) ?? undefined,
    error: isRecord(sdkMessage.error)
      ? {
          name: readString(sdkMessage.error.name) ?? '',
          message: readString(sdkMessage.error.message) ?? '',
        }
      : undefined,
  }
}

export function mapSdkMessageToMessage(sdkMessage: unknown): Message {
  if (!isRecord(sdkMessage)) {
    return {
      id: '',
      sessionID: '',
      role: 'user',
      time: {created: 0},
      agent: '',
      model: {providerID: '', modelID: ''},
    }
  }

  const role = readString(sdkMessage.role)
  if (role === 'assistant') {
    return mapSdkAssistantMessage(sdkMessage)
  }

  return mapSdkUserMessage(sdkMessage)
}

function mapSdkMessageWithParts(sdkMessage: unknown): Message {
  const message = mapSdkMessageToMessage(sdkMessage)
  if (!isRecord(sdkMessage)) {
    return message
  }

  const parts = Array.isArray(sdkMessage.parts) ? sdkMessage.parts.map(mapSdkPartToPart) : undefined
  if (parts == null || parts.length === 0) {
    return message
  }

  return {
    ...message,
    parts,
  } as unknown as Message
}

function mapSdkPartBase(sdkPart: Record<string, unknown>): {id: string; sessionID: string; messageID: string} {
  return {
    id: readString(sdkPart.id) ?? '',
    sessionID: readString(sdkPart.sessionID) ?? readString(sdkPart.sessionId) ?? '',
    messageID: readString(sdkPart.messageID) ?? readString(sdkPart.messageId) ?? '',
  }
}

function mapSdkToolState(state: Record<string, unknown>): ToolState {
  const status = readString(state.status) ?? 'pending'
  if (status === 'completed') {
    const timeRecord = isRecord(state.time) ? state.time : null
    return {
      status: 'completed',
      input: isRecord(state.input) ? state.input : {},
      output: readString(state.output) ?? '',
      title: readString(state.title) ?? '',
      metadata: isRecord(state.metadata) ? state.metadata : {},
      time: {
        start: readNumber(timeRecord?.start) ?? 0,
        end: readNumber(timeRecord?.end) ?? 0,
        compacted: readNumber(timeRecord?.compacted) ?? undefined,
      },
      attachments: undefined,
    }
  }

  if (status === 'running') {
    const timeRecord = isRecord(state.time) ? state.time : null
    return {
      status: 'running',
      input: isRecord(state.input) ? state.input : {},
      time: {start: readNumber(timeRecord?.start) ?? 0},
    }
  }

  if (status === 'error') {
    const timeRecord = isRecord(state.time) ? state.time : null
    return {
      status: 'error',
      input: isRecord(state.input) ? state.input : {},
      error: readString(state.error) ?? '',
      time: {
        start: readNumber(timeRecord?.start) ?? 0,
        end: readNumber(timeRecord?.end) ?? 0,
      },
    }
  }

  return {status: 'pending'}
}

export function mapSdkPartToPart(sdkPart: unknown): Part {
  if (!isRecord(sdkPart)) {
    return {id: '', sessionID: '', messageID: '', type: 'text', text: ''}
  }

  const base = mapSdkPartBase(sdkPart)
  const type = readString(sdkPart.type)

  switch (type) {
    case 'text':
      return {
        ...base,
        type: 'text',
        text: readString(sdkPart.text) ?? '',
        synthetic: readBoolean(sdkPart.synthetic) ?? undefined,
        ignored: readBoolean(sdkPart.ignored) ?? undefined,
        time: isRecord(sdkPart.time)
          ? {
              start: readNumber(sdkPart.time.start) ?? 0,
              end: readNumber(sdkPart.time.end) ?? undefined,
            }
          : undefined,
        metadata: isRecord(sdkPart.metadata) ? sdkPart.metadata : undefined,
      }
    case 'tool': {
      const stateRecord = isRecord(sdkPart.state) ? sdkPart.state : {status: 'pending'}
      return {
        ...base,
        type: 'tool',
        callID: readString(sdkPart.callID) ?? readString(sdkPart.callId) ?? '',
        tool: readString(sdkPart.tool) ?? '',
        state: mapSdkToolState(stateRecord) as unknown as Part['type'] extends 'tool' ? never : never,
        metadata: isRecord(sdkPart.metadata) ? sdkPart.metadata : undefined,
      }
    }
    case 'reasoning':
      return {
        ...base,
        type: 'reasoning',
        reasoning: readString(sdkPart.reasoning) ?? '',
        time: isRecord(sdkPart.time)
          ? {
              start: readNumber(sdkPart.time.start) ?? 0,
              end: readNumber(sdkPart.time.end) ?? undefined,
            }
          : undefined,
      }
    case 'step-finish': {
      const tokensRecord = isRecord(sdkPart.tokens) ? sdkPart.tokens : null
      const cacheRecord = isRecord(tokensRecord?.cache) ? tokensRecord?.cache : null
      return {
        ...base,
        type: 'step-finish',
        reason: readString(sdkPart.reason) ?? '',
        snapshot: readString(sdkPart.snapshot) ?? undefined,
        cost: readNumber(sdkPart.cost) ?? 0,
        tokens: {
          input: readNumber(tokensRecord?.input) ?? 0,
          output: readNumber(tokensRecord?.output) ?? 0,
          reasoning: readNumber(tokensRecord?.reasoning) ?? 0,
          cache: {
            read: readNumber(cacheRecord?.read) ?? 0,
            write: readNumber(cacheRecord?.write) ?? 0,
          },
        },
      }
    }
    case null:
    default:
      return {
        ...base,
        type: 'text',
        text: readString(sdkPart.text) ?? '',
      }
  }
}

function mapSdkTodoItem(sdkTodo: unknown): TodoItem | null {
  if (!isRecord(sdkTodo)) return null
  const content = readString(sdkTodo.content)
  const status = readString(sdkTodo.status)
  const priority = readString(sdkTodo.priority)
  if (content == null || status == null || priority == null) return null

  return {
    ...(readString(sdkTodo.id) == null ? {} : {id: readString(sdkTodo.id) ?? ''}),
    content,
    status:
      status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'cancelled'
        ? status
        : 'pending',
    priority: priority === 'high' || priority === 'medium' || priority === 'low' ? priority : 'medium',
  }
}

async function listSessionsViaSDK(
  client: SessionClient,
  workspacePath: string,
  logger: Logger,
): Promise<readonly SessionInfo[]> {
  const response = await client.session.list({query: {directory: workspacePath}})
  if (response.error == null && response.data != null) {
    if (!Array.isArray(response.data)) {
      return []
    }

    return response.data.map(mapSdkSessionToSessionInfo)
  }

  logger.warning('SDK session list failed', {error: String(response.error)})
  return []
}

async function getSessionViaSDK(client: SessionClient, sessionID: string, logger: Logger): Promise<SessionInfo | null> {
  const response = await client.session.get({path: {id: sessionID}})
  if (response.error != null || response.data == null) {
    logger.warning('SDK session get failed', {error: String(response.error)})
    return null
  }

  return mapSdkSessionToSessionInfo(response.data)
}

async function getSessionMessagesViaSDK(
  client: SessionClient,
  sessionID: string,
  logger: Logger,
): Promise<readonly Message[]> {
  const response = await client.session.messages({path: {id: sessionID}})
  if (response.error == null && response.data != null) {
    if (!Array.isArray(response.data)) {
      return []
    }

    const mapped = response.data.map(mapSdkMessageWithParts)
    return [...mapped].sort((a, b) => a.time.created - b.time.created)
  }

  logger.warning('SDK session messages failed', {error: String(response.error)})
  return []
}

async function getSessionTodosViaSDK(
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
      return []
    }

    const todos: TodoItem[] = []
    for (const item of response.data) {
      const mapped = mapSdkTodoItem(item)
      if (mapped != null) {
        todos.push(mapped)
      }
    }

    return todos
  }

  logger.warning('SDK session todos failed', {error: String(response.error)})
  return []
}

async function findLatestSessionViaSDK(
  client: SessionClient,
  workspacePath: string,
  afterTimestamp: number,
  logger: Logger,
): Promise<{projectID: string; session: SessionInfo} | null> {
  const response = await client.session.list({
    query: {
      directory: workspacePath,
      start: afterTimestamp,
      roots: true,
      limit: 1,
    } as Record<string, unknown>,
  })
  if (response.error != null || response.data == null) {
    logger.warning('SDK session list failed', {error: String(response.error)})
    return null
  }

  if (!Array.isArray(response.data) || response.data.length === 0) {
    return null
  }

  const session = mapSdkSessionToSessionInfo(response.data[0])
  return {projectID: session.projectID, session}
}

/**
 * Get all projects from storage.
 */
export async function listProjects(logger: Logger): Promise<readonly ProjectInfo[]> {
  const storagePath = getOpenCodeStoragePath()
  const projectDir = path.join(storagePath, 'project')

  logger.debug('Listing projects', {projectDir})
  return listJsonFiles<ProjectInfo>(projectDir)
}

/**
 * Find project by directory path.
 */
export async function findProjectByDirectory(directory: string, logger: Logger): Promise<ProjectInfo | null> {
  const projects = await listProjects(logger)

  for (const project of projects) {
    if (project.worktree === directory) {
      return project
    }
  }

  return null
}

/**
 * Get all sessions for a project.
 */
export async function listSessionsForProject(
  backend: SessionBackend,
  projectID: string,
  logger: Logger,
): Promise<readonly SessionInfo[]> {
  if (backend.type === 'sdk') {
    return listSessionsViaSDK(backend.client, backend.workspacePath, logger)
  }

  const storagePath = getOpenCodeStoragePath()
  const sessionDir = path.join(storagePath, 'session', projectID)

  logger.debug('Listing sessions for project', {projectID, sessionDir})
  return listJsonFiles<SessionInfo>(sessionDir)
}

/**
 * Get a specific session by ID.
 */
export async function getSession(
  backend: SessionBackend,
  projectID: string,
  sessionID: string,
  logger: Logger,
): Promise<SessionInfo | null> {
  if (backend.type === 'sdk') {
    return getSessionViaSDK(backend.client, sessionID, logger)
  }

  const storagePath = getOpenCodeStoragePath()
  const sessionPath = path.join(storagePath, 'session', projectID, `${sessionID}.json`)

  logger.debug('Reading session', {projectID, sessionID})
  return readJson<SessionInfo>(sessionPath)
}

/**
 * Get all messages for a session, sorted chronologically.
 * Sorting ensures messages appear in conversation order for session_read tool.
 */
export async function getSessionMessages(
  backend: SessionBackend,
  sessionID: string,
  logger: Logger,
): Promise<readonly Message[]> {
  if (backend.type === 'sdk') {
    return getSessionMessagesViaSDK(backend.client, sessionID, logger)
  }

  const storagePath = getOpenCodeStoragePath()
  const messageDir = path.join(storagePath, 'message', sessionID)

  logger.debug('Reading session messages', {sessionID, messageDir})
  const messages = await listJsonFiles<Message>(messageDir)

  return [...messages].sort((a, b) => a.time.created - b.time.created)
}

/**
 * Get all parts for a message.
 */
export async function getMessageParts(
  backend: SessionBackend,
  messageID: string,
  logger: Logger,
): Promise<readonly Part[]> {
  if (backend.type === 'sdk') {
    return []
  }

  const storagePath = getOpenCodeStoragePath()
  const partDir = path.join(storagePath, 'part', messageID)

  logger.debug('Reading message parts', {messageID, partDir})
  return listJsonFiles<Part>(partDir)
}

/**
 * Get todos for a session.
 */
export async function getSessionTodos(
  backend: SessionBackend,
  sessionID: string,
  logger: Logger,
): Promise<readonly TodoItem[]> {
  if (backend.type === 'sdk') {
    return getSessionTodosViaSDK(backend.client, sessionID, logger)
  }

  const storagePath = getOpenCodeStoragePath()
  const todoPath = path.join(storagePath, 'todo', `${sessionID}.json`)

  logger.debug('Reading session todos', {sessionID})
  const todos = await readJson<TodoItem[]>(todoPath)
  return todos ?? []
}

/**
 * Delete a single file, returning bytes freed.
 */
async function deleteFile(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath)
    await fs.unlink(filePath)
    return stat.size
  } catch {
    return 0
  }
}

/**
 * Delete a directory recursively, returning bytes freed.
 * Calculates size before deletion for metrics. Failures are silent since
 * pruning is opportunistic - we don't want to fail the entire action if
 * a single session directory is locked or missing.
 */
async function deleteDirectoryRecursive(dirPath: string): Promise<number> {
  let totalSize = 0

  try {
    const entries = await fs.readdir(dirPath, {withFileTypes: true})

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name)

      if (entry.isDirectory()) {
        totalSize += await deleteDirectoryRecursive(entryPath)
      } else {
        const stat = await fs.stat(entryPath)
        totalSize += stat.size
      }
    }

    await fs.rm(dirPath, {recursive: true, force: true})
  } catch {
    // Silently ignore: pruning is opportunistic, shouldn't fail entire action
  }

  return totalSize
}

/**
 * Delete a session and all its associated data.
 */
export async function deleteSession(projectID: string, sessionID: string, logger: Logger): Promise<number> {
  const storagePath = getOpenCodeStoragePath()
  let freedBytes = 0

  // Delete message parts first
  const messages = await getSessionMessages({type: 'json', workspacePath: ''}, sessionID, logger)
  for (const message of messages) {
    const partDir = path.join(storagePath, 'part', message.id)
    freedBytes += await deleteDirectoryRecursive(partDir)
  }

  // Delete messages directory
  const messageDir = path.join(storagePath, 'message', sessionID)
  freedBytes += await deleteDirectoryRecursive(messageDir)

  // Delete session file
  const sessionPath = path.join(storagePath, 'session', projectID, `${sessionID}.json`)
  freedBytes += await deleteFile(sessionPath)

  // Delete todos file (if exists)
  const todoPath = path.join(storagePath, 'todo', `${sessionID}.json`)
  freedBytes += await deleteFile(todoPath)

  // Delete session_diff file (if exists)
  const diffPath = path.join(storagePath, 'session_diff', `${sessionID}.json`)
  freedBytes += await deleteFile(diffPath)

  logger.debug('Deleted session', {sessionID, freedBytes})
  return freedBytes
}

/**
 * Find the most recently created session across all projects.
 *
 * This is needed because OpenCode CLI doesn't return the session ID directly.
 * We infer which session was created by comparing timestamps - the newest session
 * created after execution start time is assumed to be the result.
 *
 * This approach works because:
 * 1. Each GitHub Action run is isolated (no concurrent OpenCode executions)
 * 2. Session IDs contain hex timestamps making them monotonic
 * 3. We record execution start time before calling OpenCode
 *
 * @param backend - Session backend to query
 * @param afterTimestamp - Only consider sessions created after this timestamp (ms)
 * @param logger - Logger instance
 * @returns The most recent session, or null if none found
 */
export async function findLatestSession(
  backend: SessionBackend,
  afterTimestamp: number,
  logger: Logger,
): Promise<{projectID: string; session: SessionInfo} | null> {
  if (backend.type === 'sdk') {
    return findLatestSessionViaSDK(backend.client, backend.workspacePath, afterTimestamp, logger)
  }

  const projects = await listProjects(logger)

  let latestSession: {projectID: string; session: SessionInfo} | null = null

  for (const project of projects) {
    const sessions = await listSessionsForProject(backend, project.id, logger)

    for (const session of sessions) {
      if (session.time.created <= afterTimestamp) {
        continue
      }

      if (latestSession == null || session.time.created > latestSession.session.time.created) {
        latestSession = {projectID: project.id, session}
      }
    }
  }

  if (latestSession != null) {
    logger.debug('Found latest session', {
      sessionId: latestSession.session.id,
      projectId: latestSession.projectID,
      createdAt: latestSession.session.time.created,
    })
  }

  return latestSession
}
