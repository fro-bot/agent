# SESSION MODULE

**Scope:** OpenCode session persistence layer — storage, search, pruning, and run summary writeback.

## WHERE TO LOOK

| Component     | File           | Responsibility                                      |
| ------------- | -------------- | --------------------------------------------------- |
| **Storage**   | `storage.ts`   | JSON file I/O, project/session discovery, deletion  |
| **Search**    | `search.ts`    | `listSessions()`, `searchSessions()`, introspection |
| **Pruning**   | `prune.ts`     | Retention policy, cascade deletion                  |
| **Writeback** | `writeback.ts` | Synthetic run summary messages                      |
| **Types**     | `types.ts`     | SessionInfo, Message, Part, TodoItem                |
| **Exports**   | `index.ts`     | Public API surface                                  |

## KEY EXPORTS

```typescript
listSessions(directory, options, logger) // Get recent sessions by updatedAt
searchSessions(directory, query, options) // Full-text search with excerpts
pruneSessions(directory, config, logger) // Retention policy enforcement
writeSessionSummary(options, logger) // Create synthetic run summary
getSession(sessionId, logger) // Single session metadata
getSessionMessages(sessionId, logger) // Chronological message list
deleteSession(sessionId, logger) // Cascade delete with size tracking
```

## STORAGE STRUCTURE

```
$XDG_DATA_HOME/opencode/storage/
├── project/{projectID}.json           # Git worktree → project mapping
├── session/{projectID}/{sessionID}.json  # Session metadata (timestamps, title)
├── message/{sessionID}/{messageID}.json  # Message headers (role, agent, model)
├── part/{messageID}/{partID}.json       # Content (text, tool, reasoning)
└── todo/{sessionID}.json                # Session todo items
```

## PATTERNS

- **XDG Storage**: `$XDG_DATA_HOME/opencode/storage/` (typically `~/.local/share`)
- **Null-Safe I/O**: `readJson()` returns `null` on any error (files lazy-created)
- **Chronological Sort**: Messages sorted by `time.created`
- **Dual-Condition Pruning**: Keep if (created >= cutoffDate) OR (within maxSessions)
- **Child Session Tracking**: Sessions with `parentID` filtered, cascade-deleted
- **ID Format**: `{prefix}_{hex-timestamp}{base62-random}` (e.g., `ses_`, `msg_`, `prt_`)

## WRITEBACK PATTERN

Synthetic "run summary" messages enable agents to discover prior work:

- Created as `role: 'user'` with `agent: 'fro-bot'`, `modelID: 'run-summary'`
- Contains: repo, ref, runId, cacheStatus, PRs created, commits, duration
- Stored in message history for `session_search` discoverability

## ANTI-PATTERNS

| Forbidden                     | Reason                                           |
| ----------------------------- | ------------------------------------------------ |
| Throwing on file-not-found    | OpenCode creates files lazily; absence is normal |
| Hardcoding `~/.local/share`   | Use `getOpenCodeStoragePath()` for XDG support   |
| Unsorted message access       | Messages unordered on disk; always sort by time  |
| Ignoring child sessions       | Must cascade-delete when parent is pruned        |
| Time-only OR count-only prune | Use dual-condition for balanced retention        |
