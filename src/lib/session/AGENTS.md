# SESSION PERSISTENCE

OpenCode session persistence layer — storage, search, pruning, and run summary writeback.

## WHERE TO LOOK

| Component     | File           | Responsibility                                      |
| ------------- | -------------- | --------------------------------------------------- |
| **Storage**   | `storage.ts`   | JSON file I/O, project/session discovery, deletion  |
| **Search**    | `search.ts`    | `listSessions()`, `searchSessions()`, introspection |
| **Pruning**   | `prune.ts`     | Retention policy, cascade deletion                  |
| **Writeback** | `writeback.ts` | Synthetic run summary messages                      |
| **Types**     | `types.ts`     | SessionInfo, Message, Part, TodoItem                |

## KEY EXPORTS

- `listSessions(directory, options, logger)` — Recent sessions by `updatedAt`, child sessions filtered.
- `searchSessions(directory, query, options)` — Cross-session full-text search with context excerpts.
- `pruneSessions(directory, config, logger)` — Dual-condition retention (Age OR Count) with child cascade.
- `writeSessionSummary(options, logger)` — Synthetic `role: 'user'` message injection for agent discovery.
- `getSession(sessionId, logger)` — Retrieve single session metadata.
- `getSessionMessages(sessionId, logger)` — Chronological message list sorted by `time.created`.
- `deleteSession(sessionId, logger)` — Cascade delete parts, messages, and todos; returns bytes freed.

## STORAGE STRUCTURE

```
$XDG_DATA_HOME/opencode/storage/
├── project/{projectID}.json           # Git worktree → project mapping
├── session/{projectID}/{sessionID}.json  # Session metadata (timestamps, title)
├── message/{sessionID}/{messageID}.json  # Message headers (role, agent, model)
├── part/{messageID}/{partID}.json       # Content (text, tool outputs, reasoning)
└── todo/{sessionID}.json                # Session-level todo items
```

## PATTERNS

- **XDG Storage**: Primary path `~/.local/share/opencode/storage/` via `getOpenCodeStoragePath()`.
- **Null-Safe I/O**: `readJson()` returns `null` on error; files lazy-created (absence is normal).
- **Chronological Sort**: Messages sorted by `time.created` (unsorted on disk).
- **Dual-Condition Pruning**: Keep if `(age < cutoff OR index < maxSessions)`; prevents cache bloat.
- **Child Tracking**: Sessions with `parentID` represent branches; filtered from lists, cascade-deleted.
- **Synthetic Discovery**: `writeback.ts` injects `agent: 'fro-bot'`, `modelID: 'run-summary'` metadata.
- **ID Packing**: `hex-timestamp` + `base62-random` (e.g., `ses_`, `msg_`, `prt_`).

## ANTI-PATTERNS

| Forbidden                     | Reason                                                 |
| ----------------------------- | ------------------------------------------------------ |
| Throwing on file-not-found    | OpenCode creates files lazily; absence is normal       |
| Hardcoding `~/.local/share`   | Respect `XDG_DATA_HOME` via `getOpenCodeStoragePath()` |
| Unsorted message access       | Messages unordered on disk; always sort by time        |
| Ignoring child sessions       | Must cascade-delete when parent is pruned              |
| Time-only OR count-only prune | Dual-condition needed for balanced retention           |
