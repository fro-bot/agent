import type {Logger, Message, Part, ProjectInfo, SessionInfo, TodoItem} from './types.js'
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
export async function listSessionsForProject(projectID: string, logger: Logger): Promise<readonly SessionInfo[]> {
  const storagePath = getOpenCodeStoragePath()
  const sessionDir = path.join(storagePath, 'session', projectID)

  logger.debug('Listing sessions for project', {projectID, sessionDir})
  return listJsonFiles<SessionInfo>(sessionDir)
}

/**
 * Get a specific session by ID.
 */
export async function getSession(projectID: string, sessionID: string, logger: Logger): Promise<SessionInfo | null> {
  const storagePath = getOpenCodeStoragePath()
  const sessionPath = path.join(storagePath, 'session', projectID, `${sessionID}.json`)

  logger.debug('Reading session', {projectID, sessionID})
  return readJson<SessionInfo>(sessionPath)
}

/**
 * Get all messages for a session, sorted chronologically.
 * Sorting ensures messages appear in conversation order for session_read tool.
 */
export async function getSessionMessages(sessionID: string, logger: Logger): Promise<readonly Message[]> {
  const storagePath = getOpenCodeStoragePath()
  const messageDir = path.join(storagePath, 'message', sessionID)

  logger.debug('Reading session messages', {sessionID, messageDir})
  const messages = await listJsonFiles<Message>(messageDir)

  return [...messages].sort((a, b) => a.time.created - b.time.created)
}

/**
 * Get all parts for a message.
 */
export async function getMessageParts(messageID: string, logger: Logger): Promise<readonly Part[]> {
  const storagePath = getOpenCodeStoragePath()
  const partDir = path.join(storagePath, 'part', messageID)

  logger.debug('Reading message parts', {messageID, partDir})
  return listJsonFiles<Part>(partDir)
}

/**
 * Get todos for a session.
 */
export async function getSessionTodos(sessionID: string, logger: Logger): Promise<readonly TodoItem[]> {
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
  const messages = await getSessionMessages(sessionID, logger)
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
 * @param afterTimestamp - Only consider sessions created after this timestamp (ms)
 * @param logger - Logger instance
 * @returns The most recent session, or null if none found
 */
export async function findLatestSession(
  afterTimestamp: number,
  logger: Logger,
): Promise<{projectID: string; session: SessionInfo} | null> {
  const projects = await listProjects(logger)

  let latestSession: {projectID: string; session: SessionInfo} | null = null

  for (const project of projects) {
    const sessions = await listSessionsForProject(project.id, logger)

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
