# SESSION PERSISTENCE

OpenCode session persistence layer — storage, search, pruning, and run summary writeback.

## WHERE TO LOOK

| Component | File | Responsibility |
| --- | --- | --- |
| **Read** | `storage-read.ts` | Session, message, and part read operations (96 L) |
| **Write** | `storage-write.ts` | Session, message, and part write operations (16 L) |
| **Discovery** | `discovery.ts` | Project directory and session discovery (49 L) |
| **Storage** | `session-storage.ts` | Main storage orchestrator and path resolution (9 L) |
| **Search** | `search.ts` | `listSessions()`, `searchSessions()`, `getSessionInfo()` (220 L) |
| **Pruning** | `prune.ts` | Dual-condition retention (Age OR Count) (138 L) |
| **Writeback** | `writeback.ts` | Synthetic run summary messages for agent discovery (78 L) |
| **Mappers** | `storage-*-mapper.ts` | Data transformation between storage and memory |
| **Types** | `types.ts` | SessionInfo, Message, Part, TodoItem (291 L) |
| **Version** | `version.ts` | Storage format versioning and migrations (34 L) |],op:

OpenCode session persistence layer — storage, search, pruning, and run summary writeback.

## WHERE TO LOOK

| Component     | File           | Responsibility                                           |
| ------------- | -------------- | -------------------------------------------------------- |
| **Storage**   | `storage.ts`   | JSON file I/O, project/session discovery, deletion       |
| **Search**    | `search.ts`    | `listSessions()`, `searchSessions()`, `getSessionInfo()` |
| **Pruning**   | `prune.ts`     | Dual-condition retention (Age OR Count)                  |
| **Writeback** | `writeback.ts` | Synthetic run summary messages for agent discovery       |
| **Types**     | `types.ts`     | SessionInfo, Message, Part, TodoItem                     |

## KEY EXPORTS

- `listSessions(directory, options, logger)` — Recent main sessions (no children) by `updatedAt`.
- `searchSessions(directory, query, options)` — Cross-session full-text search with context excerpts.
- `pruneSessions(directory, config, logger)` — Dual-condition retention with child cascade deletion.
- `writeSessionSummary(summary, logger)` — Injects `role: 'user'` summary into session history.
- `getSession(projectID, sessionId, logger)` — Retrieve single session metadata.
- `getSessionMessages(sessionId, logger)` — Chronological message list sorted by `time.created`.
- `deleteSession(projectID, sessionID, logger)` — Cascade delete parts, messages, and todos.
- `findLatestSession(afterTimestamp, logger)` — Inference logic to find newly created sessions.

## STORAGE STRUCTURE

```
$XDG_DATA_HOME/opencode/storage/
├── project/{projectID}.json           # Git worktree → project mapping
├── session/{projectID}/{sessionID}.json  # Session metadata (timestamps, title)
├── message/{sessionID}/{messageID}.json  # Message headers (role, agent, model)
├── part/{messageID}/{partID}.json       # Content (text, tool outputs, reasoning)
├── todo/{sessionID}.json                # Session-level todo items
└── session_diff/{sessionID}.json         # Local state changes tracking
```

## PATTERNS

- **XDG Storage**: Path `~/.local/share/opencode/storage/` via `getOpenCodeStoragePath()`.
- **Null-Safe I/O**: `readJson()` returns `null` on error; absence is normal (lazy creation).
- **Chronological Sort**: Messages sorted by `time.created` (unsorted on disk).
- **Dual-Condition Pruning**: Keep if `(age < cutoff OR index < maxSessions)` to prevent bloat.
- **Child Tracking**: Sessions with `parentID` represent branches; filtered from main lists.
- **ID Packing**: Monotonic IDs with `hex-timestamp` + `base62-random` (e.g., `ses_123`).

## ANTI-PATTERNS

| Forbidden                     | Reason                                                 |
| ----------------------------- | ------------------------------------------------------ |
| Throwing on file-not-found    | OpenCode creates files lazily; absence is expected     |
| Hardcoding `~/.local/share`   | Respect `XDG_DATA_HOME` via `getOpenCodeStoragePath()` |
| Unsorted message access       | Messages unordered on disk; always sort by time        |
| Ignoring child sessions       | Must cascade-delete children when parent is pruned     |
| Time-only OR count-only prune | Dual-condition needed for balanced retention           |
