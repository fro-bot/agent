# RFC-004: Session Management Integration

**Status:** Pending
**Priority:** MUST
**Complexity:** Medium
**Phase:** 2

---

## Summary

Integrate OpenCode's session management tools (`session_list`, `session_read`, `session_search`, `session_info`) to enable memory reuse across runs. This is the core capability that differentiates Fro Bot from stateless agents.

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
│   ├── types.ts          # Session-related types
│   ├── search.ts         # Session search operations
│   ├── prune.ts          # Session pruning logic
│   ├── writeback.ts      # Close-the-loop writeback
│   └── index.ts          # Public exports
```

### 2. Session Types (`src/lib/session/types.ts`)

```typescript
export interface Session {
  readonly id: string
  readonly projectPath: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly messageCount: number
  readonly agents: readonly string[]
}

export interface SessionMessage {
  readonly role: "user" | "assistant" | "system"
  readonly content: string
  readonly timestamp: string
}

export interface SessionSearchResult {
  readonly sessionId: string
  readonly matches: readonly SessionMatch[]
}

export interface SessionMatch {
  readonly messageId: string
  readonly excerpt: string
  readonly role: string
}

export interface SessionInfo {
  readonly id: string
  readonly messageCount: number
  readonly dateRange: {
    readonly first: string
    readonly last: string
  }
  readonly agents: readonly string[]
  readonly hasTodos: boolean
  readonly todoCount: number
  readonly completedTodos: number
}

export interface PruneResult {
  readonly prunedCount: number
  readonly prunedSessionIds: readonly string[]
  readonly remainingCount: number
  readonly freedBytes: number
}
```

### 3. Session Search (`src/lib/session/search.ts`)

```typescript
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type {Session, SessionSearchResult, SessionInfo, Logger} from "./types.js"
import {getOpenCodeStoragePath} from "../../utils/env.js"

/**
 * List all sessions for the current project.
 */
export async function listSessions(projectPath: string, logger: Logger): Promise<readonly Session[]> {
  const storagePath = getOpenCodeStoragePath()
  const sessionsDir = path.join(storagePath, "sessions")

  logger.debug("Listing sessions", {projectPath, sessionsDir})

  try {
    const entries = await fs.readdir(sessionsDir, {withFileTypes: true})
    const sessions: Session[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const sessionPath = path.join(sessionsDir, entry.name)
      const metaPath = path.join(sessionPath, "meta.json")

      try {
        const metaContent = await fs.readFile(metaPath, "utf8")
        const meta = JSON.parse(metaContent) as Record<string, unknown>

        // Filter by project path
        if (meta["projectPath"] !== projectPath) continue

        sessions.push({
          id: entry.name,
          projectPath: String(meta["projectPath"] ?? ""),
          createdAt: String(meta["createdAt"] ?? ""),
          updatedAt: String(meta["updatedAt"] ?? ""),
          messageCount: Number(meta["messageCount"] ?? 0),
          agents: (meta["agents"] as string[]) ?? [],
        })
      } catch {
        // Skip sessions with unreadable metadata
        logger.debug("Skipping session with unreadable metadata", {sessionId: entry.name})
      }
    }

    // Sort by updatedAt descending (most recent first)
    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

    logger.info("Listed sessions", {count: sessions.length})
    return sessions
  } catch (error) {
    logger.debug("No sessions found", {error: error instanceof Error ? error.message : String(error)})
    return []
  }
}

/**
 * Search session history for matching content.
 */
export async function searchSessions(
  query: string,
  projectPath: string,
  options: {limit?: number; caseSensitive?: boolean},
  logger: Logger,
): Promise<readonly SessionSearchResult[]> {
  const {limit = 20, caseSensitive = false} = options
  const sessions = await listSessions(projectPath, logger)
  const results: SessionSearchResult[] = []

  const searchPattern = caseSensitive ? query : query.toLowerCase()

  for (const session of sessions) {
    const matches = await searchSessionContent(session.id, searchPattern, caseSensitive, logger)

    if (matches.length > 0) {
      results.push({
        sessionId: session.id,
        matches,
      })

      // Stop if we've hit the limit
      const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0)
      if (totalMatches >= limit) break
    }
  }

  logger.info("Session search complete", {query, resultCount: results.length})
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
  const storagePath = getOpenCodeStoragePath()
  const messagesPath = path.join(storagePath, "sessions", sessionId, "messages.json")

  try {
    const content = await fs.readFile(messagesPath, "utf8")
    const messages = JSON.parse(content) as Array<{id: string; role: string; content: string}>
    const matches: SessionMatch[] = []

    for (const msg of messages) {
      const searchContent = caseSensitive ? msg.content : msg.content.toLowerCase()

      if (searchContent.includes(pattern)) {
        // Extract excerpt around match
        const index = searchContent.indexOf(pattern)
        const start = Math.max(0, index - 50)
        const end = Math.min(msg.content.length, index + pattern.length + 50)
        const excerpt = msg.content.slice(start, end)

        matches.push({
          messageId: msg.id,
          excerpt: `...${excerpt}...`,
          role: msg.role,
        })
      }
    }

    return matches
  } catch {
    return []
  }
}

/**
 * Get detailed info about a session.
 */
export async function getSessionInfo(sessionId: string, logger: Logger): Promise<SessionInfo | null> {
  const storagePath = getOpenCodeStoragePath()
  const sessionPath = path.join(storagePath, "sessions", sessionId)

  try {
    const metaPath = path.join(sessionPath, "meta.json")
    const metaContent = await fs.readFile(metaPath, "utf8")
    const meta = JSON.parse(metaContent) as Record<string, unknown>

    const todosPath = path.join(sessionPath, "todos.json")
    let hasTodos = false
    let todoCount = 0
    let completedTodos = 0

    try {
      const todosContent = await fs.readFile(todosPath, "utf8")
      const todos = JSON.parse(todosContent) as Array<{status: string}>
      hasTodos = todos.length > 0
      todoCount = todos.length
      completedTodos = todos.filter(t => t.status === "completed").length
    } catch {
      // No todos file
    }

    return {
      id: sessionId,
      messageCount: Number(meta["messageCount"] ?? 0),
      dateRange: {
        first: String(meta["createdAt"] ?? ""),
        last: String(meta["updatedAt"] ?? ""),
      },
      agents: (meta["agents"] as string[]) ?? [],
      hasTodos,
      todoCount,
      completedTodos,
    }
  } catch {
    logger.debug("Session info not found", {sessionId})
    return null
  }
}

/**
 * Read session messages.
 */
export async function readSession(
  sessionId: string,
  options: {limit?: number},
  logger: Logger,
): Promise<readonly SessionMessage[]> {
  const {limit} = options
  const storagePath = getOpenCodeStoragePath()
  const messagesPath = path.join(storagePath, "sessions", sessionId, "messages.json")

  try {
    const content = await fs.readFile(messagesPath, "utf8")
    const messages = JSON.parse(content) as Array<{role: string; content: string; timestamp?: string}>

    const result = messages.map(m => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
      timestamp: m.timestamp ?? "",
    }))

    if (limit != null && limit > 0) {
      return result.slice(-limit)
    }

    return result
  } catch {
    logger.debug("Session messages not found", {sessionId})
    return []
  }
}
```

### 4. Session Pruning (`src/lib/session/prune.ts`)

```typescript
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type {PruneResult, PruningConfig, Logger, Session} from "./types.js"
import {getOpenCodeStoragePath} from "../../utils/env.js"
import {listSessions} from "./search.js"

/**
 * Prune old sessions based on retention policy.
 *
 * Default: keep last 50 sessions OR sessions from last 30 days (whichever is larger).
 */
export async function pruneSessions(projectPath: string, config: PruningConfig, logger: Logger): Promise<PruneResult> {
  const {maxSessions, maxAgeDays} = config
  const sessions = await listSessions(projectPath, logger)

  logger.info("Starting session pruning", {
    totalSessions: sessions.length,
    maxSessions,
    maxAgeDays,
  })

  if (sessions.length === 0) {
    return {
      prunedCount: 0,
      prunedSessionIds: [],
      remainingCount: 0,
      freedBytes: 0,
    }
  }

  // Calculate cutoff date
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays)

  // Determine which sessions to keep
  const sessionsToKeep = new Set<string>()

  // Keep sessions within age limit
  for (const session of sessions) {
    const updatedAt = new Date(session.updatedAt)
    if (updatedAt >= cutoffDate) {
      sessionsToKeep.add(session.id)
    }
  }

  // Ensure we keep at least maxSessions (most recent)
  const sortedSessions = [...sessions]
  for (let i = 0; i < Math.min(maxSessions, sortedSessions.length); i++) {
    sessionsToKeep.add(sortedSessions[i].id)
  }

  // Determine sessions to prune
  const sessionsToPrune = sessions.filter(s => !sessionsToKeep.has(s.id))

  if (sessionsToPrune.length === 0) {
    logger.info("No sessions to prune")
    return {
      prunedCount: 0,
      prunedSessionIds: [],
      remainingCount: sessions.length,
      freedBytes: 0,
    }
  }

  // Prune sessions
  const storagePath = getOpenCodeStoragePath()
  const sessionsDir = path.join(storagePath, "sessions")
  let freedBytes = 0
  const prunedIds: string[] = []

  for (const session of sessionsToPrune) {
    const sessionPath = path.join(sessionsDir, session.id)

    try {
      const size = await getDirectorySize(sessionPath)
      await fs.rm(sessionPath, {recursive: true, force: true})
      freedBytes += size
      prunedIds.push(session.id)
      logger.debug("Pruned session", {sessionId: session.id, bytes: size})
    } catch (error) {
      logger.warning("Failed to prune session", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  logger.info("Session pruning complete", {
    prunedCount: prunedIds.length,
    remainingCount: sessions.length - prunedIds.length,
    freedBytes,
  })

  return {
    prunedCount: prunedIds.length,
    prunedSessionIds: prunedIds,
    remainingCount: sessions.length - prunedIds.length,
    freedBytes,
  }
}

/**
 * Calculate total size of a directory.
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0

  try {
    const entries = await fs.readdir(dirPath, {withFileTypes: true})

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name)

      if (entry.isDirectory()) {
        totalSize += await getDirectorySize(entryPath)
      } else {
        const stat = await fs.stat(entryPath)
        totalSize += stat.size
      }
    }
  } catch {
    // Ignore errors
  }

  return totalSize
}
```

### 5. Session Writeback (`src/lib/session/writeback.ts`)

```typescript
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type {RunSummary, Logger} from "../types.js"
import {getOpenCodeStoragePath} from "../../utils/env.js"

/**
 * Write a summary message to the current session.
 * This makes the run outcome discoverable in future session searches.
 */
export async function writeSessionSummary(sessionId: string, summary: RunSummary, logger: Logger): Promise<void> {
  const storagePath = getOpenCodeStoragePath()
  const messagesPath = path.join(storagePath, "sessions", sessionId, "messages.json")

  const summaryMessage = formatSummaryForSession(summary)

  try {
    // Read existing messages
    let messages: Array<{role: string; content: string; timestamp: string}> = []

    try {
      const content = await fs.readFile(messagesPath, "utf8")
      messages = JSON.parse(content)
    } catch {
      // No existing messages
    }

    // Append summary message
    messages.push({
      role: "system",
      content: summaryMessage,
      timestamp: new Date().toISOString(),
    })

    // Write back
    await fs.writeFile(messagesPath, JSON.stringify(messages, null, 2), "utf8")

    logger.info("Session summary written", {sessionId})
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
    "--- Run Summary ---",
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
```

### 6. Startup Session Search Integration

Add to main entry point pattern:

```typescript
import {searchSessions, listSessions} from "./lib/session/index.js"

async function run(): Promise<void> {
  // ... after cache restore

  // Search for relevant prior sessions
  const projectPath = process.env["GITHUB_REPOSITORY"] ?? ""
  const sessions = await listSessions(projectPath, logger)

  if (sessions.length > 0) {
    logger.info("Found prior sessions", {count: sessions.length, mostRecent: sessions[0].id})

    // Search for context-relevant sessions
    // TODO: Extract search terms from event payload
    const searchResults = await searchSessions("error|fix|investigation", projectPath, {limit: 5}, logger)

    if (searchResults.length > 0) {
      logger.info("Found relevant prior work", {matchCount: searchResults.length})
      // Pass to agent for context
    }
  }
}
```

## Acceptance Criteria

- [ ] `listSessions` returns sessions sorted by most recent
- [ ] `searchSessions` finds content across sessions
- [ ] `getSessionInfo` returns detailed session metadata
- [ ] `readSession` returns message history with optional limit
- [ ] Session pruning respects both count and age limits
- [ ] Pruning keeps whichever is larger (count or age retention)
- [ ] Session summary writeback appends to messages
- [ ] Startup searches for relevant prior sessions
- [ ] All operations log appropriately
- [ ] Tests cover pruning edge cases

## Test Cases

### Session List Tests

```typescript
describe("listSessions", () => {
  it("returns sessions sorted by updatedAt descending", async () => {
    const sessions = await listSessions("/project", logger)
    expect(sessions[0].updatedAt >= sessions[1].updatedAt).toBe(true)
  })

  it("filters by project path", async () => {
    const sessions = await listSessions("/project-a", logger)
    expect(sessions.every(s => s.projectPath === "/project-a")).toBe(true)
  })
})
```

### Pruning Tests

```typescript
describe("pruneSessions", () => {
  it("keeps at least maxSessions even if older than maxAgeDays", async () => {
    const result = await pruneSessions("/project", {maxSessions: 10, maxAgeDays: 7}, logger)
    expect(result.remainingCount).toBeGreaterThanOrEqual(10)
  })

  it("keeps recent sessions even if count exceeds maxSessions", async () => {
    const result = await pruneSessions("/project", {maxSessions: 5, maxAgeDays: 30}, logger)
    // All sessions within 30 days should be kept
  })

  it("reports freed bytes accurately", async () => {
    const result = await pruneSessions("/project", {maxSessions: 1, maxAgeDays: 1}, logger)
    expect(result.freedBytes).toBeGreaterThanOrEqual(0)
  })
})
```

## Implementation Notes

1. **Session storage format**: Assumes OpenCode stores sessions in `storage/sessions/{id}/` with `meta.json` and `messages.json`
2. **Graceful handling**: All operations handle missing files gracefully
3. **Performance**: Large session directories may need streaming/pagination

## Estimated Effort

- **Development**: 6-8 hours
- **Testing**: 3-4 hours
- **Total**: 9-12 hours
