---
type: subsystem
last-updated: "2026-06-28"
updated-by: "schedule-d7190410-28335678121"
sources:
  - packages/runtime/src/session/storage.ts
  - packages/runtime/src/session/search.ts
  - packages/runtime/src/session/prune.ts
  - packages/runtime/src/session/logical-key.ts
  - packages/runtime/src/session/writeback.ts
  - packages/runtime/src/session/types.ts
  - packages/runtime/src/session/discovery.ts
  - packages/runtime/src/session/backend.ts
  - packages/runtime/src/session/storage-mappers.ts
  - packages/runtime/src/session/storage-message-mappers.ts
  - packages/runtime/src/object-store/content-sync.ts
  - packages/runtime/src/object-store/s3-adapter.ts
  - packages/runtime/src/object-store/key-builder.ts
  - packages/runtime/src/object-store/validation.ts
  - packages/runtime/src/object-store/types.ts
  - src/services/cache/restore.ts
  - src/services/cache/save.ts
  - RFCs/RFC-004-Session-Management.md
  - RFCs/RFC-002-Cache-Infrastructure.md
  - RFCs/RFC-019-S3-Storage-Backend.md
summary: "How agent memory survives across CI runs via cache, SDK sessions, S3 object store, and pruning"
---

# Session Persistence

The defining feature of Fro Bot is persistent memory. Unlike typical CI-based AI agents that start fresh every run, Fro Bot preserves its session history across workflow invocations. This means the agent can reference prior investigations, avoid repeating work, and build institutional knowledge of a codebase over time.

## The Persistence Stack

Session persistence involves three cooperating subsystems:

1. **Cache layer** (`src/services/cache/`) — Saves and restores the OpenCode storage directory to/from GitHub Actions cache, with optional S3 write-through backup.
2. **Session layer** (`packages/runtime/src/session/`) — Reads, searches, and manages individual sessions within that storage directory via the OpenCode SDK. Part of the `@fro-bot/runtime` package (see [[Architecture Overview]]).
3. **Writeback** (`packages/runtime/src/session/writeback.ts`) — Injects synthetic summary messages into session history after each run, making past work discoverable by future runs.

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

Before saving, `saveCache` in `src/services/cache/save.ts` checks whether there is anything worth caching — but this check is subtler than "is the storage directory non-empty." Recent OpenCode versions persist sessions in an `opencode.db` SQLite file in the _parent_ of the storage directory, not inside it, so a naive empty-directory check would skip the save on every real run. The guard therefore also treats any non-empty SQLite DB-family file (`opencode.db`, `opencode.db-wal`, `opencode.db-shm`) as evidence of cacheable content. The WAL file matters specifically: because server shutdown kills the process without awaiting a checkpoint, a valid session can leave `opencode.db` at zero bytes with all data still in the `-wal` file, so any one non-empty member of the family is sufficient to proceed with the save.

## Object Store (S3 Backup)

GitHub Actions cache has a 10 GB limit per repository and entries expire after 7 days of inactivity. For repositories where losing agent memory would be costly, the optional S3-compatible object store backend (RFC-019) provides durable persistence that survives cache eviction.

The implementation lives in `packages/runtime/src/object-store/` and consists of five modules:

- **`s3-adapter.ts`** — Creates an `ObjectStoreAdapter` wrapping `@aws-sdk/client-s3`. Handles upload (PutObject), download (GetObject with streaming pipeline), and list (ListObjectsV2 with pagination). A companion `listWithMetadata` operation returns each key alongside its S3 `LastModified` timestamp, which lets callers scan an object prefix by recency rather than reading every record — the gateway's operator run-index reads runs this way to surface only recent activity (see [[Operator Web Control Surface]]). All S3 error messages are sanitized to strip credentials before logging. The client retries up to 3 times and caps list pagination at 100 iterations, the same cap the metadata variant applies.

- **`content-sync.ts`** — Orchestrates bidirectional sync of three content types. `syncSessionsToStore` uploads the SQLite database files (`opencode.db`, `.db-wal`, `.db-shm`) to S3. `syncSessionsFromStore` downloads them back, with path traversal validation on every key. `syncArtifactsToStore` uploads the OpenCode log directory tree. `syncMetadataToStore` writes a JSON metadata blob (token usage, timing, session IDs, costs) to S3 via a secure temp file.

- **`key-builder.ts`** — Constructs S3 object keys from config prefix, agent identity, repository, and content type (`sessions`, `artifacts`, `metadata`). Every component is sanitized and validated.

- **`validation.ts`** — Endpoint validation (HTTPS enforcement, SSRF protection against link-local/loopback/private IPs, metadata service blocking for `169.254.169.254` and `fd00:ec2::254`), prefix validation, key component sanitization, and download path traversal checks.

- **`types.ts`** — Defines the `ObjectStoreAdapter` interface and typed error factories (`ValidationError`, `PathTraversalError`, `ObjectStoreOperationError`). The interface keeps the core upload/download/list operations required and exposes the conditional (ETag-guarded) and recency-aware operations — `conditionalPut`, `conditionalDelete`, `getObject`, and `listWithMetadata` — as optional, so backends that do not need them are not forced to implement them.

### How It Integrates

The object store hooks into the cache layer at two points:

1. **On restore** — If the GitHub Actions cache misses or is corrupted, `restoreCache` in `src/services/cache/restore.ts` calls `syncSessionsFromStore` as a fallback. A successful S3 restore reports `source: 'storage'` in the `CacheResult` (vs. `source: 'cache'` for an Actions cache hit).

2. **On save** — After the normal Actions cache save, `saveCache` in `src/services/cache/save.ts` calls `syncSessionsToStore` to write the session database to S3. This write-through approach means S3 always has a recent copy.

3. **On cleanup** — The cleanup phase in `src/harness/phases/cleanup.ts` uploads run artifacts and metadata to S3 via `syncArtifactsToStore` and `syncMetadataToStore`. This happens after the server shuts down (ensuring WAL checkpoint) but before the cache save.

S3 operations are always best-effort: failures are logged as warnings but never abort the run. The action supports AWS S3, Cloudflare R2, Backblaze B2, and MinIO, with SSE encryption auto-selected per endpoint type (`aws:kms` for AWS, `AES256` for custom endpoints).

## SDK Session Operations

All session operations go through the `@opencode-ai/sdk` client — the session module never does direct file I/O against the storage directory. This is important because OpenCode may change its storage format between versions, and the SDK provides a stable abstraction.

The key operations:

- **`listSessionsForProject`** — Lists sessions for the current workspace, filtered by project directory. Returns `SessionInfo` objects mapped from SDK types.
- **`getSession` / `getSessionMessages`** — Retrieves a single session's metadata or its full message history.
- **`getSessionTodos`** — Reads the todo list from a session (uses an untyped SDK endpoint, hence the explicit `unknown` mapping).
- **`deleteSession`** — Removes a session (used during pruning).

All SDK operations return empty arrays or `null` on failure — they never throw. This null-safe pattern prevents a single bad session from crashing the entire run.

## Mapper Architecture

SDK types don't perfectly match the project's local types. The mapper layer in `packages/runtime/src/session/` (`storage-mappers.ts`, `storage-message-mappers.ts`) translates between them:

- **Session mappers** convert `SdkSessionExtended` (which includes fields the SDK type definitions omit, like `permission` and `time.archived`) into the local `SessionInfo` type.
- **Message mappers** convert SDK messages into local `Message` types, sorting chronologically by `time.created`. The SDK returns messages unsorted, so this step is essential.
- **Part mappers** handle the polymorphic message parts (text, tool calls, tool results) with their associated tool state.
- **Todo mapper** operates on `unknown` because the session todos endpoint isn't typed in the SDK.

The local types in `types.ts` are authoritative — they define the canonical shapes that all downstream code consumes.

## Session Search

The search module (`packages/runtime/src/session/search.ts`) provides two capabilities consumed by the prompt builder:

- **`listSessions`** — Returns recent non-child sessions sorted by `updatedAt`. Child sessions (those with a `parentID`, representing agent-spawned branches) are filtered out of the main listing.
- **`searchSessions`** — Full-text search across session message content. Returns excerpts with context so the agent can decide which prior sessions are relevant without reading every message.

During the session-prep phase of each run (see [[Execution Lifecycle]]), the system searches for sessions related to the current issue or PR. Matching excerpts are injected into the prompt as "Relevant Prior Work," giving the agent a lightweight summary of past interactions.

## Logical Session Keys

Continuity depends on each run resolving to a stable _logical session key_ derived from the triggering context (`packages/runtime/src/session/logical-key.ts`). For entity-bound events — issue comments, PR reviews, and the like — the key is built from the issue or PR identity, so a follow-up comment resumes the same thread the agent was already working in.

Time-based triggers are subtler. Earlier, `schedule` runs keyed their logical session on the cron expression alone. Every scheduled run therefore resumed one ever-growing thread. As that single session's history bloated, the agent would read it, conclude the work was already done, and exit without making any tool calls — reporting success while silently doing nothing. To fix this, the schedule key now appends the workflow run ID to the cron-derived hash. Each scheduled run starts a fresh thread, while same-run reruns (which share a run ID) still resume correctly. The trade-off is deliberate: scheduled maintenance tasks are expected to be idempotent against the repository state they inspect, not against an accumulating conversation, so cross-run memory still flows through [run summary writeback](#run-summary-writeback) and `searchSessions` rather than through a shared thread.

## Pruning

Without pruning, the storage directory would grow unboundedly. The pruning module (`packages/runtime/src/session/prune.ts`) uses a dual-condition retention policy:

A session is kept if **either**:

- Its age is below the maximum age cutoff (default: 30 days), **or**
- Its index is within the maximum session count (default: 50, configurable via the `session-retention` input).

This "age OR count" approach prevents both unbounded growth (count limit) and premature deletion of recent sessions (age limit). When a parent session is pruned, its child sessions are cascade-deleted to avoid orphans.

One exception exists for the legacy aggregate schedule session created before per-run keying. The count-based floor would otherwise keep that single bloated session alive indefinitely as long as it stayed within the recent-count window. Pruning recognizes the legacy title shape (`fro-bot: schedule-<8 hex>`, with no run-ID suffix) and force-expires it once it has aged past the cutoff, regardless of the count floor — clearing the stale thread that the keying fix was designed to retire.

## Run Summary Writeback

After each run, the finalize phase writes a synthetic user message into the session containing a structured summary of what the agent did — including the event type, repository, cache status, session ID, and any errors. This message becomes searchable by future runs, enabling the agent to find its own prior work via `searchSessions`.

The writeback uses `role: 'user'` for the synthetic message so the OpenCode session system treats it as input rather than agent output, which keeps the session in a consistent state for potential continuation.
