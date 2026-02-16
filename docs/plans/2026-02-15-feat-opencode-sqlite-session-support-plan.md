---
title: "feat: Update session support for OpenCode ≥1.1.53 SQLite storage"
type: feat
date: 2026-02-15
---

# Update Session Support for OpenCode ≥1.1.53 SQLite Storage

## Overview

OpenCode ≥1.1.53 migrates session storage from JSON files on disk to a SQLite database (via Drizzle ORM). Our action-side session utilities (`src/lib/session/`) currently read and write JSON files directly. We need to:

1. **Detect the OpenCode version** at runtime and branch between file-based (<1.1.53) and SDK-based (≥1.1.53) access paths
2. **Replace direct file I/O** for reads with SDK HTTP API calls when running OpenCode ≥1.1.53
3. **Add SDK-based session writeback** (run summary injection) for ≥1.1.53 so summaries appear immediately in SQLite; keep JSON writeback for <1.1.53
4. **Maintain backward compatibility** with OpenCode <1.1.53 by preserving the existing JSON file I/O code behind version gates

## Problem Statement

### Current State

All session management code in `src/lib/session/` uses direct filesystem access:

- `storage.ts`: Reads JSON files from `~/.local/share/opencode/storage/{project,session,message,part,todo}/`
- `writeback.ts`: Writes synthetic `message/*.json` and `part/*.json` files directly
- `search.ts` / `prune.ts`: Read/delete session files via `storage.ts` helpers
- `readJson()` / `listJsonFiles()` / `fs.writeFile()` are the only I/O primitives

**Existing bug (unrelated to SQLite):** `main.ts:480` calls `pruneSessions(getOpenCodeStoragePath(), ...)`, but `pruneSessions()` expects a **workspace/worktree directory** (it calls `findProjectByDirectory(directory)` which matches against `project.worktree`, e.g., `/home/runner/work/repo/repo`). The `storagePath` value (`~/.local/share/opencode/storage/`) will never match any project's worktree, so pruning silently does nothing. Fix: change the callsite to `pruneSessions(workspacePath, ...)`. This fix is required regardless of SQLite migration and should be applied in Phase 1.

### What Changed in OpenCode ≥1.1.53

OpenCode ≥1.1.53 (on the `dev` branch) shows:

- **Session data is now in SQLite** (`~/.local/share/opencode/opencode.db`) via Drizzle ORM with tables: `session`, `message`, `part`, `todo`, `permission`
- **JSON files are migrated on startup** — the old `storage.ts` runs migrations that copy JSON directory structures into the new flat layout, then the SQLite layer takes over
- **The JSON files may no longer exist** after migration — new sessions are created only in SQLite
- **The SDK server** exposes HTTP API routes for all session operations:
  - `GET /session` — list sessions (with `directory`, `roots`, `start`, `search`, `limit` filters)
  - `GET /session/:id` — get session
  - `GET /session/:id/message` — get messages (with `limit`)
  - `GET /session/:id/message/:mid` — get specific message with parts
  - `GET /session/:id/todo` — get todos
  - `DELETE /session/:id` — delete session
  - `POST /session/:id/message` — send message (prompt)
  - `POST /session/:id/prompt_async` — send async prompt
  - `PATCH /session/:sid/message/:mid/part/:pid` — update part
  - `DELETE /session/:sid/message/:mid/part/:pid` — delete part

### The oMo PR (code-yeongyu/oh-my-opencode#1837)

oMo's WIP PR demonstrates the migration pattern we should follow:

- **Runtime detection**: `isSqliteBackend()` checks OpenCode version against `OPENCODE_SQLITE_VERSION` constant
- **Dual paths**: Every storage function has an `if (isSqliteBackend()) { /* SDK path */ } else { /* JSON path */ }` branch
- **SDK client injection**: `setStorageClient(client)` / `getStorageClient()` for passing the SDK client to storage functions (note: oMo uses module-scoped state here; we diverge by using explicit `SessionBackend` dependency injection to comply with project conventions)
- **READ operations** → SDK `client.session.list()`, `client.session.messages()`, etc.
- **WRITE operations** → HTTP PATCH/DELETE to REST endpoints with basic auth
- **36 commits, 2725 tests passing** — confirms the approach works

## Proposed Solution

### Architecture: Version-Gated Dual Backend with Dependency Injection

Rather than sprinkling `if (isSqliteBackend())` checks throughout the codebase or using module-scoped mutable state (forbidden by project conventions), we use a **discriminated union** passed explicitly to all session functions:

```typescript
// src/lib/session/backend.ts (new file)
type SessionBackend =
  | {readonly type: "json"; readonly workspacePath: string}
  | {readonly type: "sdk"; readonly workspacePath: string; readonly client: SessionClient}

type SessionClient = Awaited<ReturnType<typeof createOpencode>>["client"]
```

All session functions accept `backend: SessionBackend` as an explicit parameter and branch on `backend.type`:

```typescript
// Example: storage.ts
export async function listSessions(
  backend: SessionBackend,
  options: ListOptions,
  logger: Logger,
): Promise<readonly SessionInfo[]> {
  if (backend.type === "sdk") {
    return listSessionsViaSDK(backend.client, backend.workspacePath, options, logger)
  }
  return listSessionsViaJSON(backend.workspacePath, options, logger)
}
```

The `SessionBackend` value is constructed once in `main.ts` based on version detection and threaded through all session callsites. This preserves function-based architecture and keeps dependencies explicit — no global mutable state.

### Version Detection Strategy

We already capture the OpenCode version in `verifyOpenCodeAvailable()` (`src/lib/agent/opencode.ts:565-591`) which parses `opencode --version` output. This version is returned in `EnsureOpenCodeResult.version` and available in `main.ts`.

```typescript
// src/lib/session/version.ts (new file)

const OPENCODE_SQLITE_VERSION = "1.1.53"

export function isSqliteBackend(version: string | null): boolean {
  if (version == null) return false
  return compareVersions(version, OPENCODE_SQLITE_VERSION) >= 0
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number)
  const partsB = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
```

### Phase 1: Server Lifecycle Refactor + Version Detection

**Why this is first**: Both pre-execution session introspection (listSessions, searchSessions at main.ts:224-236) and post-execution operations (writeback, prune) need the SDK client, which needs the OpenCode server running. Currently `executeOpenCode()` owns the entire server lifecycle — it starts the server and shuts it down in its `finally` block. We must extract the server lifecycle to `main.ts` so a single server instance can be shared across all three phases: introspection → execution → post-execution.

**Pre-execution introspection requirement (SQLite backend):** `listSessions()` and `searchSessions()` run _before_ agent execution to build prompt context. For OpenCode ≥1.1.53, these must go through the SDK HTTP API, which requires a running server. Therefore we will **start the SDK server before pre-execution introspection** and **reuse the same server instance** for the subsequent `executeOpenCode()` call to avoid double-boot.

**Files to create/modify:**

| File                         | Change                                                                 |
| ---------------------------- | ---------------------------------------------------------------------- |
| `src/lib/session/version.ts` | New: `isSqliteBackend()`, `OPENCODE_SQLITE_VERSION = '1.1.53'`         |
| `src/lib/session/backend.ts` | New: `SessionBackend` discriminated union type + `SessionClient` type  |
| `src/lib/session/index.ts`   | Export new modules                                                     |
| `src/lib/agent/opencode.ts`  | Refactor: return client/server alongside result, defer server shutdown |
| `src/main.ts`                | Manage server lifecycle; construct `SessionBackend` and thread through |

**Server lifecycle change:**

```typescript
// src/lib/agent/opencode.ts — new function
interface OpenCodeServerHandle {
  readonly client: SessionClient
  readonly server: {readonly url: string; close(): void}
  readonly shutdown: () => void
}

// Bootstrap server independently of execution
async function bootstrapOpenCodeServer(signal: AbortSignal, logger: Logger): Promise<OpenCodeServerHandle>

// executeOpenCode now accepts an optional pre-existing server handle
async function executeOpenCode(
  promptOptions: PromptOptions,
  logger: Logger,
  config?: ExecutionConfig,
  serverHandle?: OpenCodeServerHandle, // Reuse existing server if provided
): Promise<AgentResult>
```

```typescript
// src/main.ts — caller owns the full lifecycle
const backend: SessionBackend = isSqliteBackend(version)
  ? {type: "sdk", workspacePath, client: serverHandle.client}
  : {type: "json", workspacePath}

let serverHandle: OpenCodeServerHandle | null = null
try {
  // 1. Bootstrap server (SQLite backend only)
  if (isSqliteBackend(version)) {
    serverHandle = await bootstrapOpenCodeServer(abortController.signal, logger)
  }

  // 2. Pre-execution introspection (uses backend)
  const recentSessions = await listSessions(backend, {limit: 10}, sessionLogger)
  const priorWork = await searchSessions(searchQuery, backend, {limit: 5}, sessionLogger)

  // 3. Execute agent (reuses existing server)
  const result = await executeOpenCode(promptOptions, logger, config, serverHandle)

  // 4. Post-execution ops (same backend, same server)
  await writeSessionSummary(result.sessionId, summary, backend, logger)
  await pruneSessions(backend, pruningConfig, logger)
} finally {
  serverHandle?.shutdown() // Single shutdown point
}
```

**Version detection:**

1. Create `version.ts` with `isSqliteBackend(version)` using `OPENCODE_SQLITE_VERSION = '1.1.53'` (matches oMo's constant)
2. Create `backend.ts` with `SessionBackend` discriminated union (no module-scoped mutable state)
3. `ensureOpenCodeAvailable()` already captures version — `main.ts` uses it to construct the appropriate `SessionBackend` and passes it to all session callsites

### Phase 2: Read Path Migration (storage.ts, search.ts)

**Files to modify:**

| File | Functions | Change |
| --- | --- | --- |
| `src/lib/session/storage.ts` | `listProjects()`, `listSessionsForProject()`, `getSession()`, `getSessionMessages()`, `getMessageParts()`, `getSessionTodos()`, `findLatestSession()` | Add SDK branch |
| `src/lib/session/search.ts` | `listSessions()`, `searchSessions()`, `getSessionInfo()` | Use SDK-backed storage functions |

**SDK API mapping for reads:**

| Current Function | SDK API | Notes |
| --- | --- | --- |
| `listProjects()` | Not needed for SDK path | SDK `session.list` filters by `directory` directly |
| `listSessionsForProject(pid)` | `GET /session?directory=...` | No project ID indirection needed |
| `getSession(pid, sid)` | `GET /session/:sid` | Direct by session ID |
| `getSessionMessages(sid)` | `GET /session/:sid/message` | Returns messages with parts inline |
| `getMessageParts(mid)` | Part of message response | Already included in SDK message response |
| `getSessionTodos(sid)` | `GET /session/:sid/todo` | Direct |
| `findLatestSession(ts)` | `GET /session?directory=...&start=ts&roots=true&limit=1` | Filter by start timestamp |
| `listSessions(dir, opts)` | `GET /session?directory=dir&roots=true&limit=N` | Direct mapping |
| `searchSessions(query, dir)` | `GET /session?directory=dir&search=query` | Title search only; content search may need local iteration |

**Key difference**: The SDK `search` query parameter only searches session titles (case-insensitive `LIKE`). Our `searchSessions()` does full-text search across message parts (text, reasoning, tool output). For ≥1.1.53, we need to:

1. Use `GET /session?directory=dir` to list sessions
2. Use `GET /session/:id/message` to fetch messages+parts
3. Search content locally (same logic as now, but reading via SDK instead of files)

This means search performance won't change dramatically — we're just swapping the I/O layer.

### Phase 3: Write Path Migration (writeback.ts)

**Files to modify:**

| File                           | Functions               | Change                                                |
| ------------------------------ | ----------------------- | ----------------------------------------------------- |
| `src/lib/session/writeback.ts` | `writeSessionSummary()` | Dual path: SDK writeback for ≥1.1.53, JSON for legacy |

**Current approach**: Writes JSON files directly to `message/{sessionId}/` and `part/{messageId}/` directories.

**Decision**: Use dual-path writeback via the `SessionBackend` discriminated union:

- **SQLite backend (≥1.1.53)**: Write run summary via the SDK's `PATCH /session/:sid/message/:mid/part/:pid` endpoint so data appears immediately in SQLite. Since `POST /session/:id/message` triggers the agent loop (there's no "create message without prompting" API), we use PATCH to create parts with a pre-generated message ID.
- **JSON backend (<1.1.53)**: Keep the existing JSON file writeback (unchanged).
- **Fallback**: If SDK writeback fails, log a warning and attempt JSON writeback as best-effort. Do not fail the action solely due to writeback failure — writeback is auxiliary.

**Implementation note**: The `writeSessionSummary()` function signature changes to accept `SessionBackend`:

```typescript
export async function writeSessionSummary(
  sessionId: string,
  summary: RunSummary,
  backend: SessionBackend,
  logger: Logger,
): Promise<void>
```

### Phase 4: Delete Path Migration (storage.ts, prune.ts)

**Files to modify:**

| File                         | Functions         | Change                        |
| ---------------------------- | ----------------- | ----------------------------- |
| `src/lib/session/storage.ts` | `deleteSession()` | Use SDK `DELETE /session/:id` |
| `src/lib/session/prune.ts`   | `pruneSessions()` | Use SDK-backed functions      |

**SDK API mapping for deletes:**

| Current Function          | SDK API                | Notes                                         |
| ------------------------- | ---------------------- | --------------------------------------------- |
| `deleteSession(pid, sid)` | `DELETE /session/:sid` | Cascade delete handled by SQLite foreign keys |

The SDK's delete endpoint cascades via SQLite `ON DELETE CASCADE` on the `message` and `part` tables, so we don't need to manually delete messages/parts/todos — just delete the session.

**Important**: Pruning requires the server to be running. Same lifecycle concern as Phase 1.

### Phase 5: Integration Testing & Verification

- End-to-end testing with both OpenCode versions (pre-1.1.53 and ≥1.1.53)
- Cache migration scenario testing (JSON cache → SQLite upgrade, clean start)
- **Migration verification test**: Write synthetic JSON message/part via the legacy writeback path, then start OpenCode ≥1.1.53 and assert the synthetic message becomes discoverable via SDK list/search after migration. This specifically validates the JSON-writeback-as-fallback assumption.
- Build verification (`pnpm build`, `pnpm check-types`, `pnpm lint`)
- Verify oMo compatibility — agent-side session tools still work alongside our action-side changes

## Technical Considerations

### Semver Comparison

We need semver comparison for version gating. Options:

1. **Import `semver` package** — adds a dependency (against project conventions of minimal deps)
2. **Inline comparison** — parse `X.Y.Z`, compare major/minor/patch numerically
3. **Simple string check** — `version.startsWith('1.2')` or similar

**Recommendation**: Inline comparison. The logic is trivial (compare `major.minor.patch` numerically against `1.1.53`) and avoids a new dependency.

### SDK Client Type

The `@opencode-ai/sdk` package already provides the client type via `createOpencode()`. We should use the existing type rather than defining our own.

```typescript
type SessionClient = Awaited<ReturnType<typeof createOpencode>>["client"]
```

### Cache Implications

- **OpenCode <1.1.53**: Cache contains JSON files in `~/.local/share/opencode/storage/`
- **OpenCode ≥1.1.53**: Cache contains `opencode.db` SQLite database at `~/.local/share/opencode/opencode.db` + possibly leftover JSON files in `storage/`
- **Cache save/restore must include `opencode.db`**: Derive the DB path deterministically: `dbPath = join(dirname(storagePath), "opencode.db")`. Both `restoreCache()` and `saveCache()` in `cache.ts` must add this to `cachePaths` when the SQLite backend is detected.
- **Post-action hook parity**: `post.ts` calls `saveCache()` as the durable writeback path (RFC-017). It must pick up the same updated `cachePaths` (including `opencode.db`). Both entrypoints (`main.ts` and `post.ts`) must restore/save the DB path consistently. Update `post.ts` to pass version info so cache paths can be computed correctly.
- **Mixed scenario**: If we upgrade OpenCode version between runs, the first ≥1.1.53 run will migrate JSON → SQLite. The cache will then contain the SQLite DB. Subsequent runs will use SQLite directly.
- **Downgrade scenario**: If we downgrade from ≥1.1.53 to an older version, OpenCode won't know about the SQLite DB and JSON files won't exist. Session continuity would be lost. **This is acceptable** — downgrades are rare and users can clear cache.

### TodoItem Type Mismatch

OpenCode's SQLite `TodoTable` schema uses a composite PK `(session_id, position)` with **no `id` column**. Our `TodoItem` interface has `id: string`. The oMo PR also made `id` optional (`id?: string`) for this reason. We should:

1. Make `TodoItem.id` optional in `src/lib/session/types.ts`
2. Update any code that relies on `todo.id` to handle `undefined`

### oMo Compatibility

oMo's PR (#1837) adds its own `isSqliteBackend()` detection and SDK paths. Our changes should be compatible:

- oMo's session tools (`session_list`, `session_read`, etc.) are agent-side and independent of our action-side utilities
- Both use the same SDK client from `createOpencode()`
- No conflicts expected — oMo handles agent-side, we handle action-side

### Security

- SDK client communicates via localhost HTTP — no external network exposure
- Basic auth header from `getServerBasicAuthHeader()` (oMo pattern) — need to verify if our SDK client handles auth automatically
- No new credential storage needed — SDK handles auth internally

### SDK Failure Behavior

If the SQLite backend is detected but the SDK server cannot start or an HTTP API call fails:

- **Server bootstrap failure**: Fall back to `{ type: "json" }` backend for pre-execution introspection. Log a warning. JSON files may or may not exist (if they were already migrated, reads return empty — this is acceptable for session context, which is advisory).
- **Read/search failures**: Degrade to "no prior context" (empty session list). Log warning. Do not fail the action — session context is used to enrich prompts, not for correctness.
- **Writeback failures**: Log warning and attempt JSON writeback as best-effort fallback. Do not fail the action.
- **Prune failures**: Log warning and skip. Pruning is opportunistic — next run will retry.
- **Implementation**: Use `Result<T, E>` returns from `bootstrapOpenCodeServer()` so failures are handled intentionally at the callsite rather than via try/catch around large blocks.

## Acceptance Criteria

### Functional Requirements

- [ ] Session list/search/info operations work correctly with OpenCode ≥1.1.53 via SDK
- [ ] Session list/search/info operations continue to work with OpenCode <1.1.53 via JSON files
- [ ] Version detection correctly identifies OpenCode ≥1.1.53
- [ ] Session writeback (run summary) works for both versions
- [ ] Session pruning works for both versions
- [ ] `findLatestSession()` correctly finds new sessions for both backends
- [ ] Cache restore/save works correctly for both SQLite and JSON storage formats

### Non-Functional Requirements

- [ ] No new npm dependencies added (inline semver comparison)
- [ ] All existing tests continue to pass
- [ ] New tests cover SDK-backed code paths
- [ ] Server lifecycle properly managed (no resource leaks)

### Quality Gates

- [ ] `pnpm test` passes (all 350+ tests)
- [ ] `pnpm check-types` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm build` succeeds and `dist/` is in sync

## Implementation Phases

### Phase 1: Server Lifecycle Refactor + Version Detection (prerequisite for all SDK work)

- Extract server lifecycle from `executeOpenCode()` to `main.ts` via `bootstrapOpenCodeServer()`
- `executeOpenCode()` accepts optional pre-existing server handle to avoid double-boot
- Create `src/lib/session/version.ts` with `isSqliteBackend()` and `OPENCODE_SQLITE_VERSION = '1.1.53'`
- Create `src/lib/session/backend.ts` with `SessionBackend` discriminated union (no global mutable state)
- Fix `pruneSessions` callsite in `main.ts`: change `storagePath` → `workspacePath`
- Update cache paths in `cache.ts` and `post.ts` to include `opencode.db` via `join(dirname(storagePath), "opencode.db")`
- Add tests for version detection, backend construction, and server bootstrap
- **Estimated effort**: 6-8 hours

### Phase 2: Read Path Migration

- Add SDK branches to `storage.ts` read functions
- Update `search.ts` to use SDK-backed storage
- Make `TodoItem.id` optional for SQLite compatibility
- Add tests for SDK code paths
- **Estimated effort**: 6-8 hours

### Phase 3: Write Path Migration

- Dual-path writeback: SDK `PATCH` for SQLite backend, JSON files for legacy backend
- Both paths accessed via `SessionBackend` parameter — no version checks in writeback code
- JSON fallback on SDK failure (log warning, don't fail action)
- **Estimated effort**: 3-4 hours

### Phase 4: Delete Path Migration

- Add SDK branch to `deleteSession()` using `DELETE /session/:id`
- Update `prune.ts` to use SDK-backed deletion
- Add tests
- **Estimated effort**: 3-4 hours

### Phase 5: Integration Testing & Verification

- End-to-end testing with both pre-1.1.53 and ≥1.1.53
- Cache migration scenario testing (JSON → SQLite upgrade)
- Migration verification test: write synthetic JSON, start ≥1.1.53, assert discoverable via SDK
- Build verification (`pnpm build`, `pnpm check-types`, `pnpm lint`)
- **Estimated effort**: 3-4 hours

**Total estimated effort**: 21-30 hours

## Dependencies & Risks

### Dependencies

- OpenCode ≥1.1.53 must be installable via the setup flow
- The `@opencode-ai/sdk` must expose session list/message/todo APIs (confirmed via server routes)
- oMo PR (#1837) should be merged or at least stable for reference

### Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| SDK doesn't expose all needed session APIs | Low | High | Confirmed via server route inspection — all needed routes exist |
| OpenCode migration breaks JSON writeback | Medium | Medium | Test with real ≥1.1.53 build; fall back to SDK approach if needed |
| Server lifecycle refactor introduces bugs | Medium | Medium | Careful testing; keep server close in `finally` block |
| Version comparison edge cases | Low | Low | Test with `1.1.53`, `1.1.52`, `1.1.65`, `1.2.0`, `null` |
| Cache format incompatibility on upgrade | Low | Medium | Document the migration path; cache miss is recoverable |

### Implementation Risks & AI Failure Points

These are the places where an implementing agent is most likely to produce bugs. Each includes a specific mitigation.

**1. Server lifecycle ownership transfer (Phase 1 — HIGH RISK)**

Refactoring `executeOpenCode()` to accept an external server handle while maintaining timeout/retry/abort logic is the riskiest change. The function currently owns the full lifecycle in a try/finally block. Failure modes:

- Double-close: `server.close()` called in both `executeOpenCode` and `main.ts`
- Resource leak: server left running on error paths
- Broken retry: shared AbortController conflicts between timeout and server shutdown

**Mitigation**: When `serverHandle` is provided, `executeOpenCode()` must NOT call `server.close()` — it only manages the session and prompt lifecycle. The `finally` block in `main.ts` is the sole owner of `shutdown()`. Write a test that verifies: (a) server is NOT closed when handle is external, (b) server IS closed when no handle is provided (backward compat).

**2. SDK response shape → internal type mapping (Phase 2 — MEDIUM RISK)**

Our `SessionInfo`, `Message`, `Part`, `TodoItem` types were designed for JSON file shapes. SDK responses may differ (nested messages include parts inline; `TodoItem` has no `id` in SQLite; timestamp field names may vary). An AI agent will likely assume shapes are identical and use raw type assertions.

**Mitigation**: Create explicit mapping functions (e.g., `mapSdkSessionToSessionInfo()`, `mapSdkMessageToMessage()`) in `storage.ts` rather than raw casts. Write tests that assert the mapped output matches the internal type contract. Never use `as SessionInfo` on SDK responses.

**3. Full-text search via SDK (Phase 2 — MEDIUM RISK)**

The SDK's `search` query only searches session titles (`LIKE` match). Our `searchSessions()` does full-text search across message parts. An AI agent will likely either use the SDK search directly (wrong — only titles) or fetch ALL sessions+messages without pagination (correct but potentially huge).

**Mitigation**: For SDK path, list sessions by directory, then iterate with `GET /session/:id/message?limit=N` per session (matching the existing file-based iteration pattern). Add a `limit` parameter to control total sessions scanned. Document that search performance is O(sessions × messages) for both backends.

### Hidden Assumptions to Validate

1. **Server boot time budget**: `createOpencode()` includes a 30-retry connection loop with 1s delay (up to 30s). This now happens BEFORE execution rather than as part of the execution timeout. The total action runtime increases by up to 30s. Ensure the action timeout (`inputs.timeoutMs`) accounts for this or deduct bootstrap time from the execution budget.

2. **SDK client type stability**: Using `Awaited<ReturnType<typeof createOpencode>>["client"]` to derive the client type is convenient but fragile. If `@opencode-ai/sdk` changes its return type, this breaks silently. Verify during implementation whether the SDK exports a concrete `Client` type that can be imported directly.

### TDD Phase Ordering Notes

Phase ordering is correct for TDD with one clarification:

- **Phase 1 tests**: `isSqliteBackend()` and `SessionBackend` construction are pure functions — test first (RED). Server bootstrap tests require mocking `createOpencode()` (existing mock patterns in `opencode.test.ts` apply). The lifecycle refactor should be verified against existing integration tests before adding new ones.
- **Phase 2 tests**: Add SDK-path tests alongside existing JSON-path tests. Mock the SDK client. Verify type mapping functions independently.
- **Phase 3 tests**: Test both writeback paths. Mock SDK PATCH calls for SQLite path.
- **Phase 4 tests**: Test delete via SDK mock. Verify cascade behavior is delegated to the SDK (our code just calls `DELETE /session/:id`).

## References & Research

### Internal References

- `src/lib/session/storage.ts` — Current JSON file I/O (270 lines)
- `src/lib/session/writeback.ts` — Run summary writeback (127 lines)
- `src/lib/session/search.ts` — Session search (231 lines)
- `src/lib/session/prune.ts` — Session pruning (133 lines)
- `src/lib/session/types.ts` — Session type definitions (292 lines)
- `src/lib/agent/opencode.ts` — SDK execution + version check (635 lines)
- `src/main.ts:356-486` — Post-execution session steps
- `RFCs/RFC-004-Session-Management.md` — Original session management spec

### External References

- [OpenCode ≥1.1.53 storage.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/storage/storage.ts) — JSON migration logic
- [OpenCode ≥1.1.53 session/index.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/index.ts) — SQLite-backed session CRUD
- [OpenCode ≥1.1.53 session.sql.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.sql.ts) — Drizzle schema (SessionTable, MessageTable, PartTable, TodoTable)
- [OpenCode ≥1.1.53 db.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/storage/db.ts) — Bun SQLite + Drizzle setup
- [OpenCode ≥1.1.53 server/routes/session.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/session.ts) — HTTP API routes
- [oMo PR #1837](https://github.com/code-yeongyu/oh-my-opencode/pull/1837) — SQLite migration compatibility (reference implementation)

### Related Work

- RFC-004: Session Management Integration (completed)
- RFC-013: SDK-based execution
- oMo PR #1837: 36 commits, 2725 tests, `isSqliteBackend()` pattern
