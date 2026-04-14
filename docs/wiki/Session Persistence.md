---
type: subsystem
last-updated: "2026-04-13"
updated-by: "86e5bad"
sources:
  - src/services/session/storage.ts
  - src/services/session/search.ts
  - src/services/session/prune.ts
  - src/services/session/writeback.ts
  - src/services/session/types.ts
  - src/services/session/discovery.ts
  - src/services/session/backend.ts
  - src/services/session/storage-mappers.ts
  - src/services/session/storage-message-mappers.ts
  - src/services/cache/restore.ts
  - src/services/cache/save.ts
  - RFCs/RFC-004-Session-Management.md
  - RFCs/RFC-002-Cache-Infrastructure.md
  - RFCs/RFC-019-S3-Storage-Backend.md
summary: "How agent memory survives across CI runs via cache, SDK sessions, and pruning"
---

<!-- eslint-disable markdown/no-missing-label-refs -->

# Session Persistence

The defining feature of Fro Bot is persistent memory. Unlike typical CI-based AI agents that start fresh every run, Fro Bot preserves its session history across workflow invocations. This means the agent can reference prior investigations, avoid repeating work, and build institutional knowledge of a codebase over time.

## The Persistence Stack

Session persistence involves three cooperating subsystems:

1. **Cache layer** (`src/services/cache/`) — Saves and restores the OpenCode storage directory to/from GitHub Actions cache, with optional S3 write-through backup.
2. **Session layer** (`src/services/session/`) — Reads, searches, and manages individual sessions within that storage directory via the OpenCode SDK.
3. **Writeback** (`src/services/session/writeback.ts`) — Injects synthetic summary messages into session history after each run, making past work discoverable by future runs.

## Cache Strategy

The storage directory (`~/.local/share/opencode/`) is cached using a branch-scoped key:

```text
opencode-storage-{repo}-{branch}-{os}
```

Branch scoping prevents one branch's session history from leaking into another. The OS component handles the rare case of cross-platform runners.

On restore, the cache module performs several safety checks:

- **Corruption detection** — Verifies the storage path is a readable directory. If not, cleans and continues with empty state.
- **Version check** — Reads a `.version` file and compares against the expected `STORAGE_VERSION` constant. On mismatch, starts fresh to avoid format incompatibilities.
- **Credential cleanup** — Deletes any `auth.json` that might have been accidentally included in a previous cache save. Credentials are ephemeral and should never persist.

Cache saves happen twice: once during the cleanup phase of the main step, and again in the post-action hook (`post.ts`). The post-action hook exists because GitHub Actions may kill the main step's `finally` block, and losing cache would mean losing all session history.

## S3 Backup

GitHub Actions cache has a 10 GB limit per repository and entries expire after 7 days of inactivity. For repositories where losing agent memory would be costly, the optional S3 write-through backend (RFC-019) writes session state to an S3 bucket alongside the normal cache save. On restore, the system tries the Actions cache first (faster) and falls back to S3 on miss or corruption.

## SDK Session Operations

All session operations go through the `@opencode-ai/sdk` client — the session module never does direct file I/O against the storage directory. This is important because OpenCode may change its storage format between versions, and the SDK provides a stable abstraction.

The key operations:

- **`listSessionsForProject`** — Lists sessions for the current workspace, filtered by project directory. Returns `SessionInfo` objects mapped from SDK types.
- **`getSession` / `getSessionMessages`** — Retrieves a single session's metadata or its full message history.
- **`getSessionTodos`** — Reads the todo list from a session (uses an untyped SDK endpoint, hence the explicit `unknown` mapping).
- **`deleteSession`** — Removes a session (used during pruning).

All SDK operations return empty arrays or `null` on failure — they never throw. This null-safe pattern prevents a single bad session from crashing the entire run.

## Mapper Architecture

SDK types don't perfectly match the project's local types. The mapper layer (`storage-mappers.ts`, `storage-message-mappers.ts`) translates between them:

- **Session mappers** convert `SdkSessionExtended` (which includes fields the SDK type definitions omit, like `permission` and `time.archived`) into the local `SessionInfo` type.
- **Message mappers** convert SDK messages into local `Message` types, sorting chronologically by `time.created`. The SDK returns messages unsorted, so this step is essential.
- **Part mappers** handle the polymorphic message parts (text, tool calls, tool results) with their associated tool state.
- **Todo mapper** operates on `unknown` because the session todos endpoint isn't typed in the SDK.

The local types in `types.ts` are authoritative — they define the canonical shapes that all downstream code consumes.

## Session Search

The search module (`search.ts`) provides two capabilities consumed by the prompt builder:

- **`listSessions`** — Returns recent non-child sessions sorted by `updatedAt`. Child sessions (those with a `parentID`, representing agent-spawned branches) are filtered out of the main listing.
- **`searchSessions`** — Full-text search across session message content. Returns excerpts with context so the agent can decide which prior sessions are relevant without reading every message.

During the session-prep phase of each run (see [[Execution Lifecycle]]), the system searches for sessions related to the current issue or PR. Matching excerpts are injected into the prompt as "Relevant Prior Work," giving the agent a lightweight summary of past interactions.

## Pruning

Without pruning, the storage directory would grow unboundedly. The pruning module (`prune.ts`) uses a dual-condition retention policy:

A session is kept if **either**:

- Its age is below the maximum age cutoff (default: 30 days), **or**
- Its index is within the maximum session count (default: 50, configurable via the `session-retention` input).

This "age OR count" approach prevents both unbounded growth (count limit) and premature deletion of recent sessions (age limit). When a parent session is pruned, its child sessions are cascade-deleted to avoid orphans.

## Run Summary Writeback

After each run, the finalize phase writes a synthetic user message into the session containing a structured summary of what the agent did — including the event type, repository, cache status, session ID, and any errors. This message becomes searchable by future runs, enabling the agent to find its own prior work via `searchSessions`.

The writeback uses `role: 'user'` for the synthetic message so the OpenCode session system treats it as input rather than agent output, which keeps the session in a consistent state for potential continuation.
