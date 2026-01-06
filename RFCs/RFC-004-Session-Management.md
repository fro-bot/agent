# RFC-004: Session Management Integration

**Status:** Pending **Priority:** MUST **Complexity:** Medium **Phase:** 2

---

## Summary

Implement session management utilities for the Fro Bot agent harness to enable memory reuse across runs. This RFC defines **action-side utilities** for listing, searching, reading, and pruning OpenCode sessions stored in the standard OpenCode storage directory.

**Important Distinction:**

- **This RFC** defines utilities used by the **GitHub Action** to manage sessions (pruning, introspection, startup search)
- **oMo session tools** (`session_list`, `session_read`, `session_search`, `session_info`) are provided by the Oh My OpenCode plugin to **AI agents** via prompts for runtime session introspection

The action-side utilities must work with the exact OpenCode storage format to ensure compatibility.

## Dependencies

- **Builds Upon:** RFC-001 (Types), RFC-002 (Cache)
- **Enables:** RFC-007 (Observability), RFC-021 (Close-the-Loop)

## Features Addressed

| Feature ID | Feature Name                     | Priority |
| ---------- | -------------------------------- | -------- |
| F11        | Session Search on Startup        | P0       |
| F21        | Close-the-Loop Session Writeback | P0       |
| F22        | Session Pruning                  | P0       |

## Technical Specification

### 1. File Structure

```
src/lib/
├── session/
│   ├── types.ts          # Session-related types (matching OpenCode)
│   ├── storage.ts        # OpenCode storage access utilities
│   ├── search.ts         # Session search operations
│   ├── prune.ts          # Session pruning logic
│   ├── writeback.ts      # Close-the-loop writeback
│   └── index.ts          # Public exports
```

### 2. OpenCode Storage Structure

OpenCode uses **JSON files on disk** (NOT SQLite) stored under `$XDG_DATA_HOME/opencode/storage/` (typically `~/.local/share/opencode/storage/`):

```
~/.local/share/opencode/storage/
├── .version                           # Storage version marker
├── migration                          # Migration version number
├── project/
│   └── {projectID}.json              # Project metadata (git root hash)
├── session/
│   └── {projectID}/
│       └── {sessionID}.json          # Session info
├── message/
│   └── {sessionID}/
│       └── {messageID}.json          # Message info
├── part/
│   └── {messageID}/
│       └── {partID}.json             # Message content parts (text, tool calls, etc.)
├── todo/
│   └── {sessionID}.json              # Todo items for session
└── session_diff/
    └── {sessionID}.json              # Session diffs (optional)
```

### 3. Session Types (`src/lib/session/types.ts`)

Types aligned with OpenCode's actual Zod schemas from `packages/opencode/src/session/index.ts`:

```typescript
/**
 * OpenCode Session.Info - matches the actual schema from OpenCode source.
 *
 * @see https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/index.ts
 */
export interface SessionInfo {
  readonly id: string // Format: ses_{hex-timestamp}{random-base62}
  readonly version: string // OpenCode version that created this session
  readonly projectID: string // Git root commit hash
  readonly directory: string // Working directory path
  readonly parentID?: string // For child/branched sessions
  readonly title: string // Session title
  readonly time: {
    readonly created: number // Unix timestamp (ms)
    readonly updated: number // Unix timestamp (ms)
    readonly compacting?: number
    readonly archived?: number
  }
  readonly summary?: {
    readonly additions: number
    readonly deletions: number
    readonly files: number
    readonly diffs?: readonly FileDiff[]
  }
  readonly share?: {
    readonly url: string
  }
  readonly permission?: PermissionRuleset
  readonly revert?: {
    readonly messageID: string
    readonly partID?: string
    readonly snapshot?: string
    readonly diff?: string
  }
}

/**
 * OpenCode MessageV2.User - user message schema
 */
export interface UserMessage {
  readonly id: string // Format: msg_{hex-timestamp}{random-base62}
  readonly sessionID: string
  readonly role: "user"
  readonly time: {
    readonly created: number
  }
  readonly summary?: {
    readonly title?: string
    readonly body?: string
    readonly diffs: readonly FileDiff[]
  }
  readonly agent: string // e.g., "Sisyphus", "coder", "oracle"
  readonly model: {
    readonly providerID: string // e.g., "anthropic", "github-copilot"
    readonly modelID: string // e.g., "claude-sonnet-4"
  }
  readonly system?: string
  readonly tools?: Record<string, boolean>
  readonly variant?: string
}

/**
 * OpenCode MessageV2.Assistant - assistant message schema
 */
export interface AssistantMessage {
  readonly id: string
  readonly sessionID: string
  readonly role: "assistant"
  readonly time: {
    readonly created: number
    readonly completed?: number
  }
  readonly parentID: string // References user message ID
  readonly modelID: string
  readonly providerID: string
  readonly mode: string // @deprecated but still present
  readonly agent: string
  readonly path: {
    readonly cwd: string
    readonly root: string
  }
  readonly summary?: boolean
  readonly cost: number // USD cost
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: {
      readonly read: number
      readonly write: number
    }
  }
  readonly finish?: string // Finish reason: "end_turn", "tool-calls", etc.
  readonly error?: MessageError
}

export type Message = UserMessage | AssistantMessage

/**
 * OpenCode MessageV2.Part - message content parts (discriminated union)
 */
export interface PartBase {
  readonly id: string // Format: prt_{hex-timestamp}{random-base62}
  readonly sessionID: string
  readonly messageID: string
}

export interface TextPart extends PartBase {
  readonly type: "text"
  readonly text: string
  readonly synthetic?: boolean
  readonly ignored?: boolean
  readonly time?: {
    readonly start: number
    readonly end?: number
  }
  readonly metadata?: Record<string, unknown>
}

export interface ToolPart extends PartBase {
  readonly type: "tool"
  readonly callID: string
  readonly tool: string
  readonly state: ToolState
  readonly metadata?: Record<string, unknown>
}

export interface ToolStateCompleted {
  readonly status: "completed"
  readonly input: Record<string, unknown>
  readonly output: string
  readonly title: string
  readonly metadata: Record<string, unknown>
  readonly time: {
    readonly start: number
    readonly end: number
    readonly compacted?: number
  }
  readonly attachments?: readonly FilePart[]
}

export interface ToolStatePending {
  readonly status: "pending"
}

export interface ToolStateRunning {
  readonly status: "running"
  readonly input: Record<string, unknown>
  readonly time: {readonly start: number}
}

export interface ToolStateError {
  readonly status: "error"
  readonly input: Record<string, unknown>
  readonly error: string
  readonly time: {readonly start: number; readonly end: number}
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export interface ReasoningPart extends PartBase {
  readonly type: "reasoning"
  readonly reasoning: string
  readonly time?: {
    readonly start: number
    readonly end?: number
  }
}

export interface StepFinishPart extends PartBase {
  readonly type: "step-finish"
  readonly reason: string
  readonly snapshot?: string
  readonly cost: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: {
      readonly read: number
      readonly write: number
    }
  }
}

export type Part = TextPart | ToolPart | ReasoningPart | StepFinishPart

/**
 * OpenCode Project metadata
 */
export interface ProjectInfo {
  readonly id: string // Git root commit hash
  readonly worktree: string // Project directory path
  readonly vcs: "git" | string
  readonly time: {
    readonly created: number
    readonly updated: number
    readonly initialized?: number
  }
}

/**
 * Todo item (stored in todo/{sessionID}.json)
 */
export interface TodoItem {
  readonly id: string
  readonly content: string
  readonly status: "pending" | "in_progress" | "completed" | "cancelled"
  readonly priority: "high" | "medium" | "low"
}

/**
 * Simplified types for RFC-004 operations
 */
export interface SessionSummary {
  readonly id: string
  readonly projectID: string
  readonly directory: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly messageCount: number
  readonly agents: readonly string[]
  readonly isChild: boolean // Has parentID
}

export interface SessionSearchResult {
  readonly sessionId: string
  readonly matches: readonly SessionMatch[]
}

export interface SessionMatch {
  readonly messageId: string
  readonly partId: string
  readonly excerpt: string
  readonly role: "user" | "assistant"
  readonly agent?: string
}

export interface PruneResult {
  readonly prunedCount: number
  readonly prunedSessionIds: readonly string[]
  readonly remainingCount: number
  readonly freedBytes: number
}

export interface PruningConfig {
  readonly maxSessions: number // Default: 50
  readonly maxAgeDays: number // Default: 30
}

// Re-export Logger from parent types
export type {Logger} from "../types.js"

// Supporting types
export interface FileDiff {
  readonly file: string
  readonly additions: number
  readonly deletions: number
}

export interface FilePart extends PartBase {
  readonly type: "file"
  readonly file: string
  readonly content: string
}

export interface PermissionRuleset {
  readonly rules: readonly unknown[]
}

export interface MessageError {
  readonly name: string
  readonly message: string
}
```

### 4. Storage Utilities (`src/lib/session/storage.ts`)

```typescript
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import type {SessionInfo, ProjectInfo, Message, Part, TodoItem, Logger} from "./types.js"

/**
 * Get the OpenCode storage directory path.
 * Uses XDG_DATA_HOME or falls back to ~/.local/share/opencode/storage
 */
export function getOpenCodeStoragePath(): string {
  const xdgDataHome = process.env["XDG_DATA_HOME"]
  const basePath = xdgDataHome ?? path.join(os.homedir(), ".local", "share")
  return path.join(basePath, "opencode", "storage")
}

/**
 * Read a JSON file from storage, returning null if not found.
 */
async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf8")
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

/**
 * List all JSON files in a directory, returning parsed contents.
 */
async function listJsonFiles<T>(dirPath: string): Promise<readonly T[]> {
  try {
    const entries = await fs.readdir(dirPath, {withFileTypes: true})
    const results: T[] = []

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
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
 * Get all project IDs from storage.
 */
export async function listProjects(logger: Logger): Promise<readonly ProjectInfo[]> {
  const storagePath = getOpenCodeStoragePath()
  const projectDir = path.join(storagePath, "project")

  logger.debug("Listing projects", {projectDir})
  return listJsonFiles<ProjectInfo>(projectDir)
}

/**
 * Find project ID by directory path.
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
  const sessionDir = path.join(storagePath, "session", projectID)

  logger.debug("Listing sessions for project", {projectID, sessionDir})
  return listJsonFiles<SessionInfo>(sessionDir)
}

/**
 * Get a specific session by ID.
 */
export async function getSession(projectID: string, sessionID: string, logger: Logger): Promise<SessionInfo | null> {
  const storagePath = getOpenCodeStoragePath()
  const sessionPath = path.join(storagePath, "session", projectID, `${sessionID}.json`)

  logger.debug("Reading session", {projectID, sessionID})
  return readJson<SessionInfo>(sessionPath)
}

/**
 * Get all messages for a session.
 */
export async function getSessionMessages(sessionID: string, logger: Logger): Promise<readonly Message[]> {
  const storagePath = getOpenCodeStoragePath()
  const messageDir = path.join(storagePath, "message", sessionID)

  logger.debug("Reading session messages", {sessionID, messageDir})
  const messages = await listJsonFiles<Message>(messageDir)

  // Sort by creation time (ascending)
  return [...messages].sort((a, b) => a.time.created - b.time.created)
}

/**
 * Get all parts for a message.
 */
export async function getMessageParts(messageID: string, logger: Logger): Promise<readonly Part[]> {
  const storagePath = getOpenCodeStoragePath()
  const partDir = path.join(storagePath, "part", messageID)

  logger.debug("Reading message parts", {messageID, partDir})
  return listJsonFiles<Part>(partDir)
}

/**
 * Get todos for a session.
 */
export async function getSessionTodos(sessionID: string, logger: Logger): Promise<readonly TodoItem[]> {
  const storagePath = getOpenCodeStoragePath()
  const todoPath = path.join(storagePath, "todo", `${sessionID}.json`)

  logger.debug("Reading session todos", {sessionID})
  const todos = await readJson<TodoItem[]>(todoPath)
  return todos ?? []
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
    const partDir = path.join(storagePath, "part", message.id)
    freedBytes += await deleteDirectoryRecursive(partDir, logger)
  }

  // Delete messages directory
  const messageDir = path.join(storagePath, "message", sessionID)
  freedBytes += await deleteDirectoryRecursive(messageDir, logger)

  // Delete session file
  const sessionPath = path.join(storagePath, "session", projectID, `${sessionID}.json`)
  freedBytes += await deleteFile(sessionPath, logger)

  // Delete todos file (if exists)
  const todoPath = path.join(storagePath, "todo", `${sessionID}.json`)
  freedBytes += await deleteFile(todoPath, logger)

  // Delete session_diff file (if exists)
  const diffPath = path.join(storagePath, "session_diff", `${sessionID}.json`)
  freedBytes += await deleteFile(diffPath, logger)

  logger.debug("Deleted session", {sessionID, freedBytes})
  return freedBytes
}

/**
 * Delete a directory recursively, returning bytes freed.
 */
async function deleteDirectoryRecursive(dirPath: string, logger: Logger): Promise<number> {
  let totalSize = 0

  try {
    const entries = await fs.readdir(dirPath, {withFileTypes: true})

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name)

      if (entry.isDirectory()) {
        totalSize += await deleteDirectoryRecursive(entryPath, logger)
      } else {
        const stat = await fs.stat(entryPath)
        totalSize += stat.size
      }
    }

    await fs.rm(dirPath, {recursive: true, force: true})
  } catch {
    // Directory doesn't exist or can't be deleted
  }

  return totalSize
}

/**
 * Delete a single file, returning bytes freed.
 */
async function deleteFile(filePath: string, logger: Logger): Promise<number> {
  try {
    const stat = await fs.stat(filePath)
    await fs.unlink(filePath)
    return stat.size
  } catch {
    return 0
  }
}
```

### 5. Session Search (`src/lib/session/search.ts`)

```typescript
import type {SessionInfo, SessionSummary, SessionSearchResult, SessionMatch, Message, Part, Logger} from "./types.js"
import {
  getOpenCodeStoragePath,
  listProjects,
  listSessionsForProject,
  getSessionMessages,
  getMessageParts,
  findProjectByDirectory,
} from "./storage.js"

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

  logger.debug("Listing sessions", {directory, limit})

  // Find project by directory
  const project = await findProjectByDirectory(directory, logger)
  if (project == null) {
    logger.debug("No project found for directory", {directory})
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
  const sessionsToProcess = limit != null ? sorted.slice(0, limit) : sorted

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

  logger.info("Listed sessions", {count: summaries.length, directory})
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

  logger.debug("Searching sessions", {query, directory, limit, caseSensitive})

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

  logger.info("Session search complete", {query, resultCount: results.length, totalMatches})
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
    case "text":
      return part.text
    case "reasoning":
      return part.reasoning
    case "tool":
      if (part.state.status === "completed") {
        return `${part.tool}: ${part.state.output}`
      }
      return null
    default:
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
  const {getSession, getSessionTodos} = await import("./storage.js")

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
    completedTodos: todos.filter(t => t.status === "completed").length,
  }
}
```

### 6. Session Pruning (`src/lib/session/prune.ts`)

```typescript
import type {PruneResult, PruningConfig, Logger} from "./types.js"
import {listSessionsForProject, findProjectByDirectory, deleteSession} from "./storage.js"

/**
 * Default pruning configuration.
 */
export const DEFAULT_PRUNING_CONFIG: PruningConfig = {
  maxSessions: 50,
  maxAgeDays: 30,
}

/**
 * Prune old sessions based on retention policy.
 *
 * Retention logic: keep sessions that satisfy EITHER condition:
 * - Within maxAgeDays of the current date
 * - Within the most recent maxSessions (by updatedAt)
 *
 * This ensures we always keep at least maxSessions, even if they're older than maxAgeDays.
 */
export async function pruneSessions(directory: string, config: PruningConfig, logger: Logger): Promise<PruneResult> {
  const {maxSessions, maxAgeDays} = config

  logger.info("Starting session pruning", {directory, maxSessions, maxAgeDays})

  // Find project
  const project = await findProjectByDirectory(directory, logger)
  if (project == null) {
    logger.debug("No project found for pruning", {directory})
    return {
      prunedCount: 0,
      prunedSessionIds: [],
      remainingCount: 0,
      freedBytes: 0,
    }
  }

  // Get all sessions (including child sessions for cleanup)
  const allSessions = await listSessionsForProject(project.id, logger)

  // Filter to main sessions only for retention calculation
  const mainSessions = allSessions.filter(s => s.parentID == null)

  if (mainSessions.length === 0) {
    return {
      prunedCount: 0,
      prunedSessionIds: [],
      remainingCount: 0,
      freedBytes: 0,
    }
  }

  // Sort by updatedAt descending (most recent first)
  const sortedSessions = [...mainSessions].sort((a, b) => b.time.updated - a.time.updated)

  // Calculate cutoff date
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays)
  const cutoffTime = cutoffDate.getTime()

  // Determine which sessions to keep
  const sessionsToKeep = new Set<string>()

  // Keep sessions within age limit
  for (const session of sortedSessions) {
    if (session.time.updated >= cutoffTime) {
      sessionsToKeep.add(session.id)
    }
  }

  // Ensure we keep at least maxSessions (most recent)
  for (let i = 0; i < Math.min(maxSessions, sortedSessions.length); i++) {
    sessionsToKeep.add(sortedSessions[i].id)
  }

  // Determine sessions to prune (main sessions not in keep set)
  const mainSessionsToPrune = sortedSessions.filter(s => !sessionsToKeep.has(s.id))

  // Also find child sessions of sessions being pruned
  const allSessionsToPrune = new Set<string>()
  for (const session of mainSessionsToPrune) {
    allSessionsToPrune.add(session.id)
    // Add child sessions
    for (const child of allSessions) {
      if (child.parentID === session.id) {
        allSessionsToPrune.add(child.id)
      }
    }
  }

  if (allSessionsToPrune.size === 0) {
    logger.info("No sessions to prune")
    return {
      prunedCount: 0,
      prunedSessionIds: [],
      remainingCount: mainSessions.length,
      freedBytes: 0,
    }
  }

  // Prune sessions
  let freedBytes = 0
  const prunedIds: string[] = []

  for (const sessionId of allSessionsToPrune) {
    try {
      const bytes = await deleteSession(project.id, sessionId, logger)
      freedBytes += bytes
      prunedIds.push(sessionId)
      logger.debug("Pruned session", {sessionId, bytes})
    } catch (error) {
      logger.warning("Failed to prune session", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const remainingCount = mainSessions.length - mainSessionsToPrune.length

  logger.info("Session pruning complete", {
    prunedCount: prunedIds.length,
    remainingCount,
    freedBytes,
  })

  return {
    prunedCount: prunedIds.length,
    prunedSessionIds: prunedIds,
    remainingCount,
    freedBytes,
  }
}
```

### 7. Session Writeback (`src/lib/session/writeback.ts`)

```typescript
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type {RunSummary, Logger} from "../types.js"
import {getOpenCodeStoragePath, getSessionMessages} from "./storage.js"

/**
 * Append a run summary to a session's message history.
 *
 * This creates a synthetic "system" message containing the run summary,
 * making it discoverable in future session searches.
 *
 * NOTE: This directly writes to the OpenCode storage format. The message
 * will appear in session_read and session_search results.
 */
export async function writeSessionSummary(sessionId: string, summary: RunSummary, logger: Logger): Promise<void> {
  const storagePath = getOpenCodeStoragePath()
  const messageDir = path.join(storagePath, "message", sessionId)
  const partDir = path.join(storagePath, "part")

  // Generate IDs matching OpenCode format (descending timestamp for recent-first)
  const timestamp = Date.now()
  const messageId = `msg_${timestamp.toString(16)}${generateRandomBase62(14)}`
  const partId = `prt_${timestamp.toString(16)}${generateRandomBase62(14)}`

  // Create message metadata
  const messageMetadata = {
    id: messageId,
    sessionID: sessionId,
    role: "user",
    time: {
      created: timestamp,
    },
    summary: {
      title: "GitHub Action Run Summary",
      diffs: [],
    },
    agent: "fro-bot",
    model: {
      providerID: "system",
      modelID: "run-summary",
    },
  }

  // Create text part with summary content
  const summaryText = formatSummaryForSession(summary)
  const partMetadata = {
    id: partId,
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text: summaryText,
    time: {
      start: timestamp,
      end: timestamp,
    },
  }

  try {
    // Ensure directories exist
    await fs.mkdir(messageDir, {recursive: true})
    await fs.mkdir(path.join(partDir, messageId), {recursive: true})

    // Write message and part files
    const messagePath = path.join(messageDir, `${messageId}.json`)
    const partPath = path.join(partDir, messageId, `${partId}.json`)

    await fs.writeFile(messagePath, JSON.stringify(messageMetadata, null, 2), "utf8")
    await fs.writeFile(partPath, JSON.stringify(partMetadata, null, 2), "utf8")

    logger.info("Session summary written", {sessionId, messageId})
  } catch (error) {
    logger.warning("Failed to write session summary", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Format run summary for session storage.
 */
function formatSummaryForSession(summary: RunSummary): string {
  const lines = [
    "--- Fro Bot Run Summary ---",
    `Event: ${summary.eventType}`,
    `Repo: ${summary.repo}`,
    `Ref: ${summary.ref}`,
    `Run ID: ${summary.runId}`,
    `Cache: ${summary.cacheStatus}`,
    `Duration: ${summary.duration}s`,
  ]

  if (summary.sessionIds.length > 0) {
    lines.push(`Sessions used: ${summary.sessionIds.join(", ")}`)
  }

  if (summary.createdPRs.length > 0) {
    lines.push(`PRs created: ${summary.createdPRs.join(", ")}`)
  }

  if (summary.createdCommits.length > 0) {
    lines.push(`Commits: ${summary.createdCommits.join(", ")}`)
  }

  if (summary.tokenUsage != null) {
    lines.push(`Tokens: ${summary.tokenUsage.input} in / ${summary.tokenUsage.output} out`)
  }

  return lines.join("\n")
}

/**
 * Generate random base62 string (matching OpenCode ID format).
 */
function generateRandomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let result = ""
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}
```

### 8. Public Exports (`src/lib/session/index.ts`)

```typescript
// Storage utilities
export {
  getOpenCodeStoragePath,
  findProjectByDirectory,
  getSession,
  getSessionMessages,
  getMessageParts,
  getSessionTodos,
} from "./storage.js"

// Search operations
export {listSessions, searchSessions, getSessionInfo} from "./search.js"

// Pruning
export {pruneSessions, DEFAULT_PRUNING_CONFIG} from "./prune.js"

// Writeback
export {writeSessionSummary} from "./writeback.js"

// Types
export type {
  SessionInfo,
  SessionSummary,
  SessionSearchResult,
  SessionMatch,
  PruneResult,
  PruningConfig,
  Message,
  UserMessage,
  AssistantMessage,
  Part,
  TextPart,
  ToolPart,
  TodoItem,
  ProjectInfo,
} from "./types.js"
```

### 9. Startup Session Search Integration

Add to main entry point pattern:

```typescript
import {listSessions, searchSessions, findProjectByDirectory} from "./lib/session/index.js"

async function run(): Promise<void> {
  // ... after cache restore

  // Get current project directory (repo root from GitHub context)
  const projectPath = process.env["GITHUB_WORKSPACE"] ?? process.cwd()

  // Search for relevant prior sessions
  const sessions = await listSessions(projectPath, {limit: 10}, logger)

  if (sessions.length > 0) {
    logger.info("Found prior sessions", {count: sessions.length, mostRecent: sessions[0].id})

    // Search for context-relevant sessions based on event payload
    // Extract search terms from issue title, PR title, or error messages
    const searchTerms = extractSearchTermsFromEvent(context)

    if (searchTerms != null) {
      const searchResults = await searchSessions(searchTerms, projectPath, {limit: 5}, logger)

      if (searchResults.length > 0) {
        logger.info("Found relevant prior work", {matchCount: searchResults.length})
        // Pass session context to agent prompt
      }
    }
  }
}
```

## Session Tools: Action vs Agent

### Action-Side Utilities (This RFC)

The utilities defined in this RFC are used by the **GitHub Action harness** for:

1. **Startup introspection**: List and search sessions to provide context to the agent
2. **Session pruning**: Clean up old sessions at the end of each run
3. **Run summary writeback**: Record run outcomes for future discoverability
4. **Cache management**: Understand what sessions exist in restored cache

These utilities run **before** and **after** the AI agent executes.

### Agent-Side Tools (oMo Plugin)

The `session_*` tools provided by Oh My OpenCode are available to the **AI agent** during runtime:

| Tool             | Description                            | Usage                             |
| ---------------- | -------------------------------------- | --------------------------------- |
| `session_list`   | List available sessions with filtering | Agent discovers prior sessions    |
| `session_read`   | Read session messages and todos        | Agent reviews prior conversations |
| `session_search` | Full-text search across sessions       | Agent finds relevant prior work   |
| `session_info`   | Get session metadata and statistics    | Agent assesses session scope      |

**Key Difference**: The agent uses these tools through natural language via the LLM tool-calling interface. The action uses the RFC-004 utilities directly in TypeScript.

### Ensuring Agent Uses Session Tools

The agent prompt (defined in RFC-011) must instruct the agent to use session tools:

```markdown
## Session Management (REQUIRED)

Before investigating any issue, you MUST use the session management tools to check for prior work:

1. Use `session_search` to find sessions related to the current issue/PR
2. Use `session_read` to review relevant prior conversations
3. Only after checking for prior work should you begin new investigation

At the end of your work, leave a searchable summary that future sessions can find.
```

## Future Enhancement: Custom OpenCode Tools

A future enhancement would expose action-side utilities (like `pruneSessions`) to agents as OpenCode custom tools:

```typescript
// Example: future custom tool for session pruning
// See: https://opencode.ai/docs/custom-tools/
{
  "name": "fro_prune_sessions",
  "description": "Prune old sessions per retention policy. Use when requested by user or when cache is full.",
  "input_schema": {
    "type": "object",
    "properties": {
      "maxSessions": {"type": "number", "description": "Maximum sessions to keep"},
      "maxAgeDays": {"type": "number", "description": "Maximum age in days"}
    }
  }
}
```

This would allow the agent to proactively manage storage when instructed.

## Acceptance Criteria

- [ ] `listSessions` returns sessions sorted by most recent, filtering by directory
- [ ] `listSessions` excludes child/branched sessions (those with `parentID`)
- [ ] `searchSessions` finds text content across session message parts
- [ ] `getSessionInfo` returns detailed session metadata including todos
- [ ] Session pruning respects both count and age limits
- [ ] Pruning keeps whichever is larger (count or age retention)
- [ ] Pruning also removes child sessions of pruned parent sessions
- [ ] Session summary writeback creates valid OpenCode message format
- [ ] Writeback messages are discoverable via `session_search`
- [ ] All operations work with real OpenCode storage at `~/.local/share/opencode/storage/`
- [ ] All operations log appropriately
- [ ] Tests use valid OpenCode data formats

## Test Cases

### Session List Tests

```typescript
describe("listSessions", () => {
  it("returns sessions sorted by updatedAt descending", async () => {
    const sessions = await listSessions("/project", {}, mockLogger)
    if (sessions.length >= 2) {
      expect(sessions[0].updatedAt >= sessions[1].updatedAt).toBe(true)
    }
  })

  it("excludes child sessions (those with parentID)", async () => {
    const sessions = await listSessions("/project", {}, mockLogger)
    expect(sessions.every(s => !s.isChild)).toBe(true)
  })

  it("filters by directory via project lookup", async () => {
    const sessions = await listSessions("/project-a", {}, mockLogger)
    expect(sessions.every(s => s.directory === "/project-a")).toBe(true)
  })

  it("respects limit parameter", async () => {
    const sessions = await listSessions("/project", {limit: 5}, mockLogger)
    expect(sessions.length).toBeLessThanOrEqual(5)
  })
})
```

### Pruning Tests

```typescript
describe("pruneSessions", () => {
  it("keeps at least maxSessions even if older than maxAgeDays", async () => {
    const result = await pruneSessions("/project", {maxSessions: 10, maxAgeDays: 7}, mockLogger)
    expect(result.remainingCount).toBeGreaterThanOrEqual(Math.min(10, totalSessions))
  })

  it("keeps recent sessions even if count exceeds maxSessions", async () => {
    // All sessions within maxAgeDays should be kept regardless of count
    const result = await pruneSessions("/project", {maxSessions: 5, maxAgeDays: 30}, mockLogger)
    // Verify no sessions within 30 days were pruned
  })

  it("also prunes child sessions of pruned parents", async () => {
    const result = await pruneSessions("/project", {maxSessions: 1, maxAgeDays: 1}, mockLogger)
    // Child sessions should be included in prunedSessionIds
  })

  it("reports freed bytes accurately", async () => {
    const result = await pruneSessions("/project", {maxSessions: 1, maxAgeDays: 1}, mockLogger)
    expect(result.freedBytes).toBeGreaterThanOrEqual(0)
  })
})
```

### Search Tests

```typescript
describe("searchSessions", () => {
  it("searches text parts for matching content", async () => {
    const results = await searchSessions("error", "/project", {}, mockLogger)
    for (const result of results) {
      expect(result.matches.every(m => m.excerpt.toLowerCase().includes("error"))).toBe(true)
    }
  })

  it("respects caseSensitive option", async () => {
    const caseInsensitive = await searchSessions("Error", "/project", {caseSensitive: false}, mockLogger)
    const caseSensitive = await searchSessions("Error", "/project", {caseSensitive: true}, mockLogger)
    // Case-insensitive should find more or equal matches
    expect(caseInsensitive.length).toBeGreaterThanOrEqual(caseSensitive.length)
  })

  it("searches tool output in completed tool parts", async () => {
    const results = await searchSessions("command output", "/project", {}, mockLogger)
    // Should find matches in tool part output
  })
})
```

### Storage Format Tests

```typescript
describe("OpenCode storage format compatibility", () => {
  it("reads real session files from OpenCode storage", async () => {
    // This test validates against actual OpenCode storage
    const storagePath = getOpenCodeStoragePath()
    const projects = await listProjects(mockLogger)
    expect(projects.length).toBeGreaterThan(0)

    for (const project of projects) {
      const sessions = await listSessionsForProject(project.id, mockLogger)
      for (const session of sessions) {
        // Validate session structure matches SessionInfo type
        expect(session.id).toMatch(/^ses_/)
        expect(typeof session.time.created).toBe("number")
        expect(typeof session.time.updated).toBe("number")
      }
    }
  })

  it("reads real message files with correct structure", async () => {
    const storagePath = getOpenCodeStoragePath()
    const projects = await listProjects(mockLogger)
    if (projects.length > 0) {
      const sessions = await listSessionsForProject(projects[0].id, mockLogger)
      if (sessions.length > 0) {
        const messages = await getSessionMessages(sessions[0].id, mockLogger)
        for (const message of messages) {
          expect(message.id).toMatch(/^msg_/)
          expect(["user", "assistant"]).toContain(message.role)
        }
      }
    }
  })
})
```

## Implementation Notes

1. **OpenCode storage format**: Sessions use JSON files, NOT SQLite. The storage is at `~/.local/share/opencode/storage/`
2. **ID format**: IDs use format `{prefix}_{hex-timestamp}{random-base62}` for monotonic ordering
3. **Project organization**: Sessions are organized by `projectID` (git root commit hash)
4. **Child sessions**: Sessions with `parentID` are branches/forks and should be excluded from main session lists
5. **Message parts**: Message content is stored separately in the `part/` directory, not in the message files
6. **Graceful handling**: All operations handle missing files gracefully
7. **Performance**: Large session directories may need streaming/pagination in future versions

## Estimated Effort

- **Development**: 8-10 hours
- **Testing**: 4-5 hours
- **Total**: 12-15 hours

---

## Completion Notes

**Date:** 2026-01-06

**Summary:** Implemented session management utilities for the Fro Bot agent harness:

- `src/lib/session/types.ts` - OpenCode-compatible types (SessionInfo, Message, Part, etc.)
- `src/lib/session/storage.ts` - Storage access utilities (list, read, delete operations)
- `src/lib/session/search.ts` - Session list and search operations
- `src/lib/session/prune.ts` - Session pruning with retention policy
- `src/lib/session/writeback.ts` - Run summary writeback to session storage
- `src/lib/session/index.ts` - Public exports

**Tests:** 48 new tests covering all acceptance criteria

**Deviations:** None - implementation follows RFC specification exactly
