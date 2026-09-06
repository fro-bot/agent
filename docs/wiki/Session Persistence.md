---
type: subsystem
last-updated: "2026-09-07"
updated-by: "schedule-d7190410-34062354146"
sources:
  - src/services/cache/cache-key.ts
  - src/shared/cache-save-result.ts
  - packages/runtime/src/session/storage.ts
  - packages/runtime/src/session/search.ts
  - packages/runtime/src/session/prune.ts
  - packages/runtime/src/session/logical-key.ts
  - packages/runtime/src/session/archive.ts
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

The defining feature of Fro Bot is persistent memory. Unlike typical CI-based AI agents that start fresh every run, Fro Bot preserves its session history across workflow invocations — subject to the trigger constraint documented below. This means the agent can reference prior investigations, avoid repeating work, and build institutional knowledge of a codebase over time.

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

Restore and save use that key differently. Restore matches on two prefixes — branch-scoped first, then repo-scoped — while the key a run _writes_ appends its run ID and run attempt (`buildSaveCacheKey` in `src/services/cache/cache-key.ts`). The run-attempt component was added because Actions cache entries are immutable: a re-run keeps the same `GITHUB_RUN_ID`, so without the attempt suffix the second attempt's save collided with the first attempt's entry, and that collision was folded into the "already exists" success path — the retry's own session state was silently discarded while the save reported success. Each attempt now writes its own entry. Both restore prefixes stop before the run ID, so they continue to match every save key regardless of run or attempt; the cost is that re-runs consume additional entries against the repository's cache budget, which LRU eviction absorbs. Losing a re-run's session state was judged the worse outcome.

On restore, the cache module performs several safety checks:

- **Corruption detection** — Verifies the storage path is a readable directory. If not, cleans and continues with empty state.
- **Version check** — Reads a `.version` file and compares against the expected `STORAGE_VERSION` constant. On mismatch, starts fresh to avoid format incompatibilities.
- **Credential cleanup** — Deletes any `auth.json` that might have been accidentally included in a previous cache save. Credentials are ephemeral and should never persist.

Cache saves happen twice: once during the cleanup phase of the main step, and again in the post-action hook (`post.ts`). The post-action hook exists because GitHub Actions may kill the main step's `finally` block, and losing cache would mean losing all session history.

### Trigger-specific cache write availability

GitHub scopes the cache JWT by **trigger class**, not by who fired the individual run: because `issue_comment` and `issues` are initiable by an actor without repository write access, every run on those triggers gets a read-only `ACTIONS_RUNTIME_TOKEN`. On those runs the Actions cache can still restore state, but its write token is not equally capable. A run started by a maintainer is affected exactly as much as one started by an outside contributor — this repository's own workflow admits only `OWNER`, `MEMBER`, and `COLLABORATOR` on `issue_comment`, and its cache writes were still denied. `@actions/cache` authenticates with that runner-injected token rather than `GITHUB_TOKEN`, so adding or changing a workflow `permissions:` block cannot make the cache writable; the permissions shown for `GITHUB_TOKEN` are irrelevant to this cache operation. `workflow_dispatch` and `schedule` runs are not affected.

This mapping from event to cache scope is attributed to a platform policy change and is not documented by GitHub; it is the current best explanation for the observed behavior on GitHub-hosted runners rather than a published contract. The triggers named here are the ones whose behavior was observed directly — `pull_request` and `pull_request_review_comment` were not, and fork pull requests carry their own separate cache-scope restrictions. See [the incident write-up](../solutions/integration-issues/read-only-actions-cache-token-broke-session-continuity-2026-08-11.md) for the evidence and the month it went unnoticed.

The result is that a run can restore prior state successfully while its cache write is rejected. Mention-driven runs therefore read session state but may be unable to write their new state. This is a GitHub platform constraint, not a Fro Bot configuration bug. `s3-backup` defaults to `false`; enabling it with a configured bucket makes the object store the durable path for session state, and restore consults it before the Actions cache. Object-store sync is best-effort and non-fatal, so continuity depends on the upload succeeding. If the upload fails, the run still falls through to the Actions cache write, which may also be denied.

`@actions/cache` hides both write denials and reservation collisions behind a `-1` sentinel instead of throwing, so the save path cannot distinguish those causes at that boundary. The cache write is therefore reported as not persisted rather than as a confident diagnosis. The post-action hook remains the retry path when the main-step save did not persist. What "did not persist" means precisely is the subject of the next section.

### What a Save Reports

`saveCache` returns a structured `CacheSaveResult` (`src/shared/cache-save-result.ts`) rather than a boolean. The shape has two independent persistence axes — `cachePersisted` and `storePersisted` — plus a named `outcome` describing the terminal condition that produced them. Durability overall is the disjunction of the two axes, never either one alone.

The reason for the shape is that a boolean collapsed three genuinely different situations into the same value: a deliberate opt-out (`SKIP_CACHE`), a denied write, and a successful write. Naming them separately makes the run's actual persistence story legible in the job summary and in the `cache-save-result` action output. The outcomes are `skipped-by-configuration`, `skipped-empty`, `checkpoint-declined`, `cache-rejected`, `cache-error`, and `persisted`.

`cache-rejected` deserves a note about what it does _not_ claim. `@actions/cache` distinguishes a policy denial, a reservation collision, a finalize error, a 5xx, and an upload failure internally, but none of those survive the `saveCache()` call boundary — every one returns the same `-1`. `cache-rejected` therefore covers all of them because the boundary cannot tell them apart, not because one was determined over the others. The source comments are explicit that this is an inference and that the cause must not be guessed from the trigger type or runner configuration: a self-hosted runner can hold a writable token on a comment trigger, and a transient service failure can happen regardless of token permissions.

The `persisted` outcome absorbs one case that looks like a failure. When the cache adapter throws an "already exists" error, the key is durably written either way — some concurrent job committed it first — so the state is present under that key regardless of which run wrote it. That is folded into `persisted` rather than given its own outcome.

Before saving, `saveCache` in `src/services/cache/save.ts` checks whether there is anything worth caching — but this check is subtler than "is the storage directory non-empty." Recent OpenCode versions persist sessions in an `opencode.db` SQLite file in the _parent_ of the storage directory, not inside it, so a naive empty-directory check would skip the save on every real run. The save path checkpoints SQLite before building the transport paths, and today's cache and object-store save sets include `opencode.db` but not `opencode.db-wal` or `opencode.db-shm`. A non-empty `opencode.db` is therefore the DB-side signal; WAL-only data is expected to have been merged before the save check.

## Object Store (S3 Backup)

GitHub Actions cache has a 10 GB limit per repository and entries expire after 7 days of inactivity. For repositories where losing agent memory would be costly, the optional S3-compatible object store backend (RFC-019) provides durable persistence that survives cache eviction — and, per the trigger constraint above, is the only path to continuity at all on GitHub-hosted runners for `issue_comment` and `issues` runs.

The implementation lives in `packages/runtime/src/object-store/` and consists of five modules:

- **`s3-adapter.ts`** — Creates an `ObjectStoreAdapter` wrapping `@aws-sdk/client-s3`. Handles upload (PutObject), download (GetObject with streaming pipeline), and list (ListObjectsV2 with pagination). A companion `listWithMetadata` operation returns each key alongside its S3 `LastModified` timestamp, which lets callers scan an object prefix by recency rather than reading every record — the gateway's operator run-index reads runs this way to surface only recent activity (see [[Operator Web Control Surface]]). All S3 error messages are sanitized to strip credentials before logging. The client retries up to 3 times and caps list pagination at 100 iterations, the same cap the metadata variant applies.

- **`content-sync.ts`** — Orchestrates bidirectional sync of three content types. `syncSessionsToStore` uploads only the main SQLite database file (`opencode.db`) to S3; the `-wal` and `-shm` sidecars are deliberately excluded from upload. `syncSessionsFromStore` still downloads whatever the store lists, with path traversal validation on every key, so objects written before that change continue to restore. `syncArtifactsToStore` uploads the OpenCode log directory tree. `syncMetadataToStore` writes a JSON metadata blob (token usage, timing, session IDs, costs) to S3 via a secure temp file.

- **`key-builder.ts`** — Constructs S3 object keys from config prefix, agent identity, repository, and content type (`sessions`, `artifacts`, `metadata`). Every component is sanitized and validated.

- **`validation.ts`** — Endpoint validation (HTTPS enforcement, SSRF protection against link-local/loopback/private IPs, metadata service blocking for `169.254.169.254` and `fd00:ec2::254`), prefix validation, key component sanitization, and download path traversal checks.

- **`types.ts`** — Defines the `ObjectStoreAdapter` interface and typed error factories (`ValidationError`, `PathTraversalError`, `ObjectStoreOperationError`). The interface keeps the core upload/download/list operations required and exposes the conditional (ETag-guarded) and recency-aware operations — `conditionalPut`, `conditionalDelete`, `getObject`, and `listWithMetadata` — as optional, so backends that do not need them are not forced to implement them. `conditionalPut` also accepts an optional `tagging` string: the coordination layer (see [[Execution Lifecycle]]) tags its run-state objects so a bucket lifecycle policy can expire them on its own schedule. Tagging is applied only on real AWS S3 (`config.endpoint == null`); custom S3-compatible endpoints skip it, since their tagging support varies. Session database objects themselves are not tagged — the tag path is specific to the short-lived coordination records, not the durable session backup.

### How It Integrates

The object store hooks into the cache layer at two points:

1. **On restore** — When the object store is configured, `restoreCache` in `src/services/cache/restore.ts` consults it **before** the Actions cache, not merely as a miss-time fallback. This ordering exists because some runs — mention-triggered runs in particular — cannot write the Actions cache, so their own state only ever lands in the object store; their successful S3 upload was invisible to a restore that took any cache hit first, including a stale prefix-fallback hit from an unrelated earlier run, leaving them to start cold every time. Consulting durable storage first lets the most recent real session win. A store hit still requires the main session database — sidecar WAL/SHM files alone remain a miss, as with the cache path — and the downloaded storage is validated the same way a cache restore is. A store failure or a disabled store falls through to the cache path unchanged, so the behavior is inert until durable storage is configured. A successful S3 restore reports `source: 'storage'` in the `CacheResult` (vs. `source: 'cache'` for an Actions cache hit).

2. **On save** — `saveCache` in `src/services/cache/save.ts` calls `syncSessionsToStore` **before** the Actions cache write, not after. That ordering is what lets the object store carry continuity on triggers whose cache write is denied: the upload has already happened by the time the cache write is rejected. The sync is best-effort and non-fatal, so a failed upload leaves the run falling through to a cache write that may itself be denied — S3 holds a recent copy when the upload succeeded, not unconditionally.

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

These runtime-side operations are distinct from the native agent tools described below: the operations above are invoked by harness/runtime code outside of model tool calls, never by the model directly. The native tools are what the model itself calls mid-run.

### Native Agent Session Tools

`packages/runtime/src/agent/session-tools.ts` implements the always-on `session_list` / `session_read` / `session_search` / `session_info` tool contract as a plain config-dir file tool (`tool/session.js`), independent of any plugin. Setup copies the compiled asset into the CI OpenCode config dir via `writeSessionToolsFile` (`src/services/setup/session-tools-config.ts`); OpenCode's tool registry loads it as a file tool before plugin tools, so an oh-my-openagent plugin tool of the same id overrides it at registry time (later-wins). The tools resolve an OpenCode client from `FRO_BOT_OPENCODE_URL` at call time (never at import time) and delegate to the same `packages/runtime/src/session/` primitives (`listSessions`, `getSession`, `getSessionMessages`, `getSessionTodos`, `getSessionInfo`, `searchSessions`) described above — they are a thin, string-formatted, model-facing wrapper over the SDK operations, not a separate storage path. Every failure path returns a `'session store unavailable: ...'` string rather than throwing, so a session-tool failure never fails the run; if the asset is missing at setup time, setup warns and continues, and the tools are simply absent from that run.

## Mapper Architecture

SDK types don't perfectly match the project's local types. The mapper layer in `packages/runtime/src/session/` (`storage-mappers.ts`, `storage-message-mappers.ts`) translates between them:

- **Session mappers** convert `SdkSessionExtended` (which includes fields the SDK type definitions omit, like `permission` and `time.archived`) into the local `SessionInfo` type.
- **Message mappers** convert SDK messages into local `Message` types, sorting chronologically by `time.created`. The SDK returns messages unsorted, so this step is essential.
- **Part mappers** handle the polymorphic message parts (text, tool calls, tool results) with their associated tool state.
- **Todo mapper** operates on `unknown` because the session todos endpoint isn't typed in the SDK.

The local types in `types.ts` are authoritative — they define the canonical shapes that all downstream code consumes.

## Session Search

The search module (`packages/runtime/src/session/search.ts`) provides two capabilities consumed by both the prompt builder and the native `session_list` / `session_search` agent tools:

- **`listSessions`** — Returns recent non-child sessions sorted by `updatedAt`. Child sessions (those with a `parentID`, representing agent-spawned branches) are filtered out of the main listing, and so are sessions marked _archived_ or _compacting_ (`session.time.archived` or `session.time.compacting` set). A session that has been retired by overflow recovery (below) therefore disappears from the listing while remaining in storage for history.
- **`searchSessions`** — Full-text search across session message content. Returns excerpts with context so the agent can decide which prior sessions are relevant without reading every message. Callers can pass an `excludeSessionIds` set to skip specific sessions — used by recovery flows that must not re-surface the session they are replacing.

During the session-prep phase of each run (see [[Execution Lifecycle]]), the system searches for sessions related to the current issue or PR. Matching excerpts are injected into the prompt as "Relevant Prior Work," giving the agent a lightweight summary of past interactions. Mid-run, the agent can additionally reach for the same search directly via the native `session_search` tool instead of waiting on the pre-injected excerpts.

### Archiving and Overflow Recovery

When a session grows past the model's context window, continuing to resume it would fail on every attempt. The archive helper (`packages/runtime/src/session/archive.ts`) retires such a session by stamping `time.archived` on it. Because the v1 SDK session client can _read_ `time.archived` but its typed update body only exposes `{title?}`, archiving is written through the v2 `session.update` endpoint — this is the one place the runtime reaches past v1 for a write. Once archived, the session is invisible to `listSessions` and, crucially, to logical-key resolution (below), so the next run resolves to a fresh thread instead of resuming the overflowed one. The retired session is not deleted; it stays available for audit and for `searchSessions` history until pruning eventually reclaims it.

## Logical Session Keys

Continuity depends on each run resolving to a stable _logical session key_ derived from the triggering context (`packages/runtime/src/session/logical-key.ts`). For entity-bound events — issue comments, PR reviews, and the like — the key is built from the issue or PR identity, so a follow-up comment resumes the same thread the agent was already working in. Resolution filters candidate sessions for eligibility — dropping any that are archived or compacting — _before_ matching by title, in both the workspace-scoped and global lookups. This means an overflowed session that was archived by recovery can never be re-selected by title, even though its title still matches; the resolver skips past it to an eligible thread or starts fresh.

Time-based triggers are subtler. Earlier, `schedule` runs keyed their logical session on the cron expression alone. Every scheduled run therefore resumed one ever-growing thread. As that single session's history bloated, the agent would read it, conclude the work was already done, and exit without making any tool calls — reporting success while silently doing nothing. To fix this, the schedule key now appends the workflow run ID to the cron-derived hash. Each scheduled run starts a fresh thread, while same-run reruns (which share a run ID) still resume correctly. The trade-off is deliberate: scheduled maintenance tasks are expected to be idempotent against the repository state they inspect, not against an accumulating conversation, so cross-run memory still flows through [run summary writeback](#run-summary-writeback) and `searchSessions` rather than through a shared thread.

## Pruning

Without pruning, the storage directory would grow unboundedly. The pruning module (`packages/runtime/src/session/prune.ts`) uses a dual-condition retention policy:

A session is kept if **either**:

- Its age is below the maximum age cutoff (default: 30 days), **or**
- Its index is within the maximum session count (default: 50, configurable via the `session-retention` input).

This "age OR count" approach prevents both unbounded growth (count limit) and premature deletion of recent sessions (age limit). When a parent session is pruned, its child sessions are cascade-deleted to avoid orphans.

## Run Summary Writeback

After each run, the finalize phase writes a synthetic user message into the session containing a structured summary of what the agent did — including the event type, repository, cache status, session ID, and any errors. This message becomes searchable by future runs, enabling the agent to find its own prior work via `searchSessions`.

The writeback uses `role: 'user'` for the synthetic message so the OpenCode session system treats it as input rather than agent output, which keeps the session in a consistent state for potential continuation.
