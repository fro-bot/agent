# SESSION PERSISTENCE

OpenCode session persistence layer — storage, search, pruning, and run summary writeback.

## WHERE TO LOOK

| Component       | File                         | Responsibility                                            |
| --------------- | ---------------------------- | --------------------------------------------------------- |
| **Storage**     | `storage.ts`                 | SDK session list/get/messages/todos/delete operations     |
| **Mappers**     | `storage-mappers.ts`         | Session and todo mappers (SDK → local types)              |
| **Msg Mappers** | `storage-message-mappers.ts` | Message, part, and tool state mappers (SDK → local types) |
| **Discovery**   | `discovery.ts`               | Project directory and session discovery via SDK           |
| **Search**      | `search.ts`                  | `listSessions()`, `searchSessions()`, `getSessionInfo()`  |
| **Pruning**     | `prune.ts`                   | Dual-condition retention (Age OR Count)                   |
| **Writeback**   | `writeback.ts`               | Synthetic run summary messages for agent discovery        |
| **Types**       | `types.ts`                   | SessionInfo, Message, Part, TodoItem (authoritative)      |
| **Version**     | `version.ts`                 | Storage format versioning and migrations                  |
| **Backend**     | `backend.ts`                 | SDK client type alias                                     |

## KEY EXPORTS

- `listSessions(directory, options, logger)` — Recent main sessions (no children) by `updatedAt`.
- `searchSessions(directory, query, options)` — Cross-session full-text search with context excerpts.
- `pruneSessions(directory, config, logger)` — Dual-condition retention with child cascade deletion.
- `writeSessionSummary(summary, logger)` — Injects `role: 'user'` summary into session history.
- `getSession(projectID, sessionId, logger)` — Retrieve single session metadata.
- `getSessionMessages(sessionId, logger)` — Chronological message list sorted by `time.created`.
- `deleteSession(projectID, sessionID, logger)` — Delete session via SDK.
- `findLatestSession(afterTimestamp, logger)` — Inference logic to find newly created sessions.

## MAPPER ARCHITECTURE

Mappers convert SDK types to local types. Typed endpoints use SDK types as input; untyped endpoints use `unknown`:

- **Typed mappers**: `mapSdkSessionToSessionInfo(SdkSessionExtended)`, `mapSdkMessageToMessage(SdkMessageExtended)`, `mapSdkPartToPart(SdkPart)`, `mapSdkToolState(SdkToolState)`
- **Untyped mapper**: `mapSdkTodos(unknown)` — `session.todos()` endpoint is not typed in SDK
- **Extension types**: `SdkSessionExtended` and `SdkMessageExtended` add fields the server returns but SDK omits (`permission`, `time.archived`, `agent` on AssistantMessage, `variant` on UserMessage)

## PATTERNS

- **SDK-First**: All storage operations go through `@opencode-ai/sdk` client, never direct file I/O.
- **Null-Safe Returns**: Functions return empty arrays or `null` on SDK errors; never throw.
- **Chronological Sort**: Messages sorted by `time.created` (unsorted from SDK).
- **Dual-Condition Pruning**: Keep if `(age < cutoff OR index < maxSessions)` to prevent bloat.
- **Child Tracking**: Sessions with `parentID` represent branches; filtered from main lists.
- **Local Types Authoritative**: `types.ts` defines the canonical types; SDK types are inputs only.

## ANTI-PATTERNS

| Forbidden                     | Reason                                                                    |
| ----------------------------- | ------------------------------------------------------------------------- |
| Extending SDK types directly  | `readonly` mismatch, field name differences, structural incompatibilities |
| Throwing on SDK errors        | SDK errors are expected; return empty/null instead                        |
| Unsorted message access       | Messages unordered from SDK; always sort by time                          |
| Ignoring child sessions       | Must cascade-delete children when parent is pruned                        |
| Time-only OR count-only prune | Dual-condition needed for balanced retention                              |
