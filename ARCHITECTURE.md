# Architecture

This document describes the system design, invariants, and data flows for the fro-bot/agent monorepo. For directory layout and where to add new code, see [STRUCTURE.md](STRUCTURE.md). For operational knowledge, symbol tables, and commands, see [AGENTS.md](AGENTS.md).

> **Deep dives:** [Architecture Overview](docs/wiki/Architecture%20Overview.md) · [Execution Lifecycle](docs/wiki/Execution%20Lifecycle.md) · [Conventions and Patterns](docs/wiki/Conventions%20and%20Patterns.md)

## Bird's-Eye Overview

This monorepo ships three distinct deployable surfaces from one codebase:

- **GitHub Action** — a CI harness that runs OpenCode agents in response to GitHub webhook events (issues, PRs, comments, reviews, scheduled runs, workflow dispatches). The Action entry points are `src/main.ts` and `src/post.ts`; the real logic lives in the 4-layer `src/` tree and `packages/runtime/`. Sessions persist across CI runs via GitHub Actions cache when the trigger permits cache writes, and via an S3-compatible object store; `issue_comment` and `issues` runs cannot write the cache and depend on the object store for continuity.
- **`@fro-bot/gateway`** (`packages/gateway/`) — a Discord-first daemon that listens for `@fro-bot` mentions in bound guild channels and runs OpenCode inside a sandboxed workspace container. Includes an operator web surface (Hono, gateway-net only), an inbound announce webhook, and an S3-backed coordination layer. The `/fro-bot dispatch` slash command is a separate, simpler path: it asks the bound repo's `fro-bot.yaml` workflow to run via the GitHub Actions API and returns the run URL — it never touches the gateway's queue, concurrency cap, or run-state.
- **`@fro.bot/harness`** (`packages/harness/`) — a patched OpenCode binary built via an LLM-merge integration pipeline. Published to npm and GitHub Releases; consumed by the Action setup phase as the default OpenCode binary.

Supporting packages: `@fro-bot/runtime` (`packages/runtime/`) owns shared runtime primitives and version-pin constants; `@fro-bot/action` (`apps/action/`) is a thin workspace wrapper whose build produces the committed root `dist/`; `@fro-bot/workspace-agent` (`apps/workspace-agent/`) is the Hono HTTP sidecar inside the workspace container.

## Codemap

Symbols verified against the live source tree. Where a symbol has moved to `packages/runtime/`, the canonical location is noted.

### Action / Root `src/`

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `run` | Function | `src/harness/run.ts` | Main entry, phase orchestration |
| `runPost` | Function | `src/harness/post.ts` | Post-action cache save |
| `runSetup` | Function | `src/services/setup/setup.ts` | Setup orchestration |
| `buildCIConfig` | Function | `src/services/setup/ci-config.ts` | CI config assembly with plugin injection |
| `writeSystematicConfig` | Function | `src/services/setup/systematic-config.ts` | Systematic plugin config writer |
| `restoreCache` | Function | `src/services/cache/restore.ts` | Restore OpenCode state |
| `saveCache` | Function | `src/services/cache/save.ts` | Persist state to cache |
| `checkpointDatabase` | Function | `src/services/cache/checkpoint.ts` | Merge SQLite WAL into main DB before save/restore hand-off |
| `verifyDatabaseUsable` | Function | `src/services/cache/integrity.ts` | Restore-side probe for structurally corrupt SQLite files |
| `isStructuralCorruptionError` | Function | `src/services/cache/sqlite-errors.ts` | Positive-allowlist classifier for SQLite corruption vs. transient errors |
| `executeOpenCode` | Function | `src/features/agent/execution.ts` | SDK execution orchestration |
| `normalizeEvent` | Function | `src/services/github/context.ts` | Raw payload → typed NormalizedEvent |
| `parseGitHubContext` | Function | `src/services/github/context.ts` | Global context → typed GitHubContext |
| `routeEvent` | Function | `src/features/triggers/router.ts` | Event routing orchestration |
| `postComment` | Function | `src/features/comments/writer.ts` | Create or update comment |
| `submitReview` | Function | `src/features/reviews/reviewer.ts` | Submit PR review |
| `parseActionInputs` | Function | `src/harness/config/inputs.ts` | Parse/validate inputs |
| `createLogger` | Function | `src/shared/logger.ts` | Logger with redaction |
| `ActionInputs` | Interface | `src/shared/types.ts` | Input schema |
| `NormalizedEvent` | Union | `src/services/github/types.ts` | 8-variant discriminated event union |
| `TriggerResult` | Interface | `src/features/triggers/types.ts` | Routing decision |

### `packages/runtime/` (canonical prompt + agent primitives)

`src/features/agent/prompt.ts` re-exports from `@fro-bot/runtime`; the implementations live here.

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `buildAgentPrompt` | Function | `packages/runtime/src/agent/prompt.ts` | XML-tagged prompt with authority hierarchy |
| `buildAgentContextSection` | Function | `packages/runtime/src/agent/prompt.ts` | Consolidated agent operations block |
| `buildHarnessRulesSection` | Function | `packages/runtime/src/agent/prompt-thread.ts` | Non-negotiable rules with precedence declaration |
| `sendPromptToSession` | Function | `src/features/agent/prompt-sender.ts` | Send prompt to SDK session |
| `runPromptAttempt` | Function | `src/features/agent/retry.ts` | Execute prompt with retry logic |
| `pollForSessionCompletion` | Function | `src/features/agent/session-poll.ts` | Poll SDK for completion status |
| `processEventStream` | Function | `src/features/agent/streaming.ts` | Process SDK event stream |
| `bootstrapOpenCodeServer` | Function | `src/features/agent/server.ts` | Initialize SDK server lifecycle |
| `TriggerDirective` | Interface | `packages/runtime/src/agent/prompt.ts` | Directive + appendMode for triggers |
| `DEFAULT_SYSTEMATIC_VERSION` | Constant | `packages/runtime/src/shared/constants.ts` | Pinned Systematic version (`3.12.4`) |
| `DEFAULT_OPENCODE_VERSION` | Constant | `packages/runtime/src/shared/constants.ts` | Pinned harness version (`1.18.21+harness.22dee0ee`) |

### `packages/gateway/`

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `runMention` | Function | `packages/gateway/src/execute/run.ts` | Full mention execution lifecycle |
| `launchWork` | Function | `packages/gateway/src/execute/run.ts` | Fire-and-return web launch path |
| `buildDiscordPrompt` | Function | `packages/gateway/src/execute/prompt.ts` | Discord-specific prompt builder |
| `buildOperatorApp` | Function | `packages/gateway/src/web/server.ts` | Operator Hono app factory |
| `createWorkflowDispatcher` | Function | `packages/gateway/src/github/dispatch.ts` | `/fro-bot dispatch` GitHub Actions workflow-dispatch adapter (fire-and-forget; no queue, concurrency, or local run-state) |

## Invariants

These are CI-enforced constraints. Violating any of them breaks the build or the system contract.

1. **4-layer import rule.** The root `src/` tree is strictly layered: `shared/` → `services/` → `features/` → `harness/`. Each layer may only import from layers below it. Cross-layer imports in the wrong direction are a type error and a lint error.
2. **Committed `dist/` must stay in sync.** CI runs `bun run build` and fails if `git diff dist/` shows changes. The pre-push hook enforces the same check locally. Never edit `dist/` by hand.
3. **Strict booleans.** No implicit falsy checks (`!value`). Use explicit comparisons (`=== null`, `=== undefined`, `.length === 0`). Enforced by ESLint.
4. **Functions only — no classes for stateful patterns.** Closures, not ES6 classes, carry state across the codebase (the only classes are a handful of `Error` subclasses in the gateway). Enforced by convention and code review.
5. **Exactly one comment or review per invocation (Response Protocol).** Exactly one GitHub comment or PR review is delivered per Action run. For `pull_request`/`issue_comment`/`issues` triggers this is **action-enforced**: the model writes its response to a run-scoped file and the harness posts it once via the Octokit writers, binding the target and surface to the trusted event. For `workflow_dispatch`/`schedule` the model still self-posts via `gh`, and the one-response rule remains prompt-enforced in `buildHarnessRulesSection()`. The Action's response surface is derived from trusted routing context: `pull_request` is review-required; an authorized `issue_comment` mention on a pull request is review-permitted (a verdict submits a real review, while omitting it posts a comment); all other response-file-triggered paths are comment-only. The response file cannot select its own target or surface.
6. **`NormalizedEvent` is never bypassed.** All webhook payloads must pass through `normalizeEvent()` before routing. The router never reads `context.payload` directly. Raw event access is an anti-pattern caught in code review.
7. **No type suppression.** `as any`, `@ts-ignore`, and `@ts-expect-error` are forbidden project-wide.
8. **Redaction-before-query (gateway operator surface).** On operator-web routes, the denylist check runs after the server-owned binding lookup (the predicate consumes the binding's deny keys) and before any authorization check, run-state read, or GitHub API call. A repo redacted in `metadata/repos.yaml` is never queried and never reaches the audit stream. Cold-start failure → deny all (fail-closed). Discord surfaces do not currently consult the denylist post-binding.

> See also: [Conventions and Patterns](docs/wiki/Conventions%20and%20Patterns.md)

## Data Flow

Three distinct execution flows operate in this system. They share the `packages/runtime/` primitives but have separate entry points, triggers, and lifecycles.

### 1. Action Phase Pipeline

Triggered by a GitHub webhook event dispatched to the Action runner.

```
main.ts
  └─→ harness/run.ts (run)
        │
        ├─→ bootstrap phase
        │     parseActionInputs → ensureOpenCodeAvailable
        │
        ├─→ routing phase
        │     parseGitHubContext → normalizeEvent → routeEvent
        │     (produces TriggerResult; skips if no matching trigger)
        │
        ├─→ dedup phase
        │     skip if agent already ran for this PR/issue within dedup window

        ├─→ coordination-lock phase
        │     acquire per-repo cross-surface lock when S3 is enabled
        │
        ├─→ acknowledge phase
        │     acknowledgeReceipt (reaction + comment stub)
        │
        ├─→ cache-restore phase
        │     restore from S3 first → fall back to Actions cache when needed
        │     → repair the restored SQLite database before the server opens it:
        │       checkpoint its WAL, or clean-slate it if SQLite reports it structurally corrupt
        │
        ├─→ session-prep phase
        │     processAttachments → buildAgentPrompt (packages/runtime)
        │
        ├─→ execute phase
        │     executeOpenCode → bootstrapOpenCodeServer → sendPromptToSession
        │       → runPromptAttempt → processEventStream (SSE)
        │     (onPermissionAsked auto-denies any permission.asked event immediately —
        │      there is no interactive approval path in CI, so an unanswered ask must
        │      never be left to block the run until the execution deadline)
        │
        ├─→ review-reconciliation phase
        │     reconcile formal review state after agent execution

        ├─→ finalize phase
        │     set outputs → writeJobSummary → enforce/deliver response contract
        │       (review-required, review-permitted, or comment-only from trusted routing context)
        │
        └─→ cleanup phase
              prune sessions → shutdown server → sync artifacts and metadata
              → saveCache (checkpoints the WAL before capturing files; S3 before Actions cache)
              → release lock in finally

post.ts (separate Action step)
  └─→ harness/post.ts (runPost)
        └─→ saveCache (durable persistence, runs even on failure)
```

> See also: [Execution Lifecycle](docs/wiki/Execution%20Lifecycle.md)

### 2. Gateway Mention-Loop

Triggered by an `@fro-bot` mention in a Discord guild channel bound to a repo.

```
Discord messageCreate event
  └─→ packages/gateway/src/discord/mentions.ts
        │
        ├─→ thread guard (skip if already in a thread)
        ├─→ authorization gate
        │     guild.members.fetch() [REST, never cache]
        │     → role check (GATEWAY_TRIGGER_ROLE_ID) or ManageChannels
        │     → fail-closed on any resolution error
        │
        ├─→ binding lookup
        │     S3 object-store index → RepoBinding
        │
        └─→ runMention (packages/gateway/src/execute/run.ts)
              │
              ├─→ concurrency cap + per-channel FIFO queue
              ├─→ thread creation on source message
              ├─→ S3 conditional-write lock acquisition
              │     (coordination/lock.ts; heartbeat renews lease)
              │
              ├─→ run-state lifecycle
              │     PENDING → ACKNOWLEDGED → EXECUTING
              │
              ├─→ execute/run-core.ts
              │     buildDiscordPrompt → OpenCode (workspace:9200, bearer auth)
              │     → SSE event stream → discord/streaming.ts → thread reply
              │
              ├─→ tool approval (if any tool set to `ask`)
              │     permission.asked → Discord embed (Approve/Deny buttons)
              │     → approval registry → workspace resume/reject
              │
              └─→ completion
                    run → COMPLETED; heartbeat stop; lock release
                    on failure → FAILED; coarse error reply to thread
```

> See also: [Architecture Overview](docs/wiki/Architecture%20Overview.md) · [Operator Web Control Surface](docs/wiki/Operator%20Web%20Control%20Surface.md)

### 3. Harness Release Pipeline

Triggered by `workflow_dispatch` or a push of a `harness-v*` tag on `.github/workflows/harness-release.yaml`.

```
harness-release.yaml (workflow_dispatch OR push: harness-v* tag)
  │
  ├─→ prepare-integrate job
  │     resolve base_version → render prompt from packages/harness/prompt.txt
  │     → emit: base_version, rendered_prompt, has_refs
  │
  ├─→ integrate job (skipped when has_refs == 'false')
  │     uses: .github/workflows/fro-bot.yaml (Fro Bot agent, secrets: inherit)
  │     agent:
  │       clone anomalyco/opencode → create integration branch at base tag
  │       → merge configured refs (harness.config.json carry-policy allowlist)
  │       → build + verify host CLI
  │       → push to refs/harness-integrate/<version>
  │
  ├─→ build matrix (linux-x64, linux-arm64, darwin-x64, darwin-arm64)
  │     needs: [prepare-integrate, integrate]
  │     fetch refs/harness-integrate/<version> (or stock tag if has_refs=false)
  │     → build-platform.ts --source-tree <tree> --integration-commit <sha>
  │     → emit: integration_commit
  │
  └─→ publish job (all-or-nothing; requires build + release-binaries success)
        OIDC trusted publishing (id-token: write, publish job only)
        → npm publish @fro.bot/harness + 4 per-platform packages
        → GitHub Release (OpenCode-shaped assets + SHA256SUMS)
```

> See also: [Architecture Overview](docs/wiki/Architecture%20Overview.md)

## Cross-Cutting Concerns

### Redaction and Logging Gate

Every function takes an injected `logger` parameter (never `console.log`). The logger (`createLogger` in `src/shared/logger.ts`) auto-redacts secrets and sensitive values before any log line is emitted. In the gateway, the operator denylist gate (`packages/gateway/src/operator-contract/redaction.ts`, `REDACTION_OBLIGATION`) enforces that redacted repo identity is never stored, logged, or returned — only deny keys (`databaseId` / `nodeId`) are retained.

> See also: [Conventions and Patterns](docs/wiki/Conventions%20and%20Patterns.md)

### NormalizedEvent Discriminated Union

All GitHub webhook payloads are normalized through `normalizeEvent()` (`src/services/github/context.ts`) into a typed `NormalizedEvent` discriminated union (`src/services/github/types.ts`) with 8 variants before any routing logic runs. The router (`routeEvent`) operates exclusively on `NormalizedEvent`; raw `context.payload` access is forbidden. This is Invariant 6 above.

> See also: [Execution Lifecycle](docs/wiki/Execution%20Lifecycle.md)

### XML-Tagged Prompt Architecture

Agent prompts are assembled from named XML-tagged sections with an explicit authority hierarchy. Section order follows Anthropic's recommended pattern: reference data first (`<harness_rules>`, `<identity>`, `<environment>`, `<issue>`/`<pull_request>`, `<session_context>`), task and instructions last (`<task>`, `<user_supplied_instructions>`, `<output_contract>`, `<agent_context>`). `<harness_rules>` takes precedence over `<user_supplied_instructions>`. The canonical builder is `buildAgentPrompt` in `packages/runtime/src/agent/prompt.ts`.

> See also: [Prompt Architecture](docs/wiki/Prompt%20Architecture.md)

### Two-Layer Session Management

Session persistence spans two distinct layers that are easy to conflate. During execution, the **agent-side** layer is a set of always-on native OpenCode file tools that let the model query prior sessions directly. Around execution, the **action-side** layer is a set of runtime utilities that summarize, prune, and write session state. Both layers share the same SDK-backed persisted session store, but neither calls the other directly.

> See also: [Session Persistence](docs/wiki/Session%20Persistence.md) — canonical reference for the native tool inventory, config-dir registration, fallback behavior, and detailed session lifecycle.

### OIDC Trusted Publishing

The harness release workflow publishes to npm via OIDC (no long-lived npm token). `id-token: write` is scoped to the `publish` job only; `integrate` and `build` jobs run with `contents: read` and no `id-token`. Each of the five packages (`@fro.bot/harness` + four per-platform packages) requires a one-time trusted-publisher configuration on npmjs.com before OIDC publishes can succeed.

### SQLite WAL Checkpoint Repair (Cache Bootstrap Trap)

`src/services/cache/checkpoint.ts` (`checkpointDatabase`) merges the OpenCode session database's write-ahead log into the main `opencode.db` file via `PRAGMA wal_checkpoint(TRUNCATE)` (`node:sqlite`, unflagged on Node 24), and runs at two call sites: inside `saveCache` (`src/services/cache/save.ts`), before file sizes are inspected or bytes transported, and again on the restore side in `runCacheRestore` (`src/harness/phases/cache-restore.ts`), before `bootstrapOpenCodeServer` ever opens the database. Restore keys are prefixes that return the most recent entry and save keys are unique per run, so a run that declines to save leaves a poisoned entry as the newest one for the next restore to hit again — checkpointing on restore heals a stuck repository in place instead of letting it loop. Success is judged by the WAL's on-disk size after the attempt, never by the pragma's own `checkpointed` count (verified to under-report on a fully successful truncation). A busy or lock-contended writer surfaces as a busy database and is retried within a bounded attempt count and wall-clock deadline; the deadline is checked only between attempts, so an in-flight pragma is never interrupted. An **idle** live writer does not surface this way at all: a checkpoint against it can report success and then have the WAL grow again moments later from a write that was already in flight when the child was signalled. Closing that gap is `packages/runtime/src/agent/server.ts`'s job, not the checkpoint's — `OpenCodeServerHandle.shutdown()` sends the child's kill signal and then polls its listening port (bounded, best-effort; the SDK exposes no pid or exit event to await directly) until connections start being refused or a timeout elapses, and `src/harness/phases/cleanup.ts` awaits that before `saveCache` ever runs. A timed-out poll does not fail the run, but is logged, since the checkpoint that follows is not then running against a confirmed-quiet database.

The write-ahead log itself no longer crosses either transport on save: `DB_TRANSPORTABLE_BASENAMES` (`packages/runtime/src/session/version.ts`) and `buildSaveCachePaths` (`src/services/cache/paths.ts`) both include only the main database file. The object store's per-key upload/overwrite is not atomic across two files, so a healthy save that only refreshes `opencode.db` could otherwise leave an older `opencode.db-wal` object paired with a newer database on the next restore; `src/services/cache/restore.ts` deletes any write-ahead log downloaded from the object store immediately after the sync call returns, before anything opens the database. The Actions cache is unaffected by that specific hazard (one entry is one atomic archive), so a legacy database+WAL pair restored from there is left alone and repaired in place by the same restore-side checkpoint described above, rather than discarded.

`src/services/cache/integrity.ts` (`verifyDatabaseUsable`) closes the gap a hot WAL would otherwise mask: a structurally corrupt database with no pending write-ahead data reports `nothing-to-checkpoint` and would sail through unprobed, later getting re-persisted under a fresh key. It runs only on the restore path (`SELECT count(*) FROM sqlite_master`, a schema-page read, not a full `PRAGMA integrity_check`) and only when `checkpointDatabase` itself reports `nothing-to-checkpoint`.

`src/services/cache/sqlite-errors.ts` (`isStructuralCorruptionError`) is a positive allowlist — matching only SQLite's own wording for "file is not a database" and "database disk image is malformed" — never a catch-all. Deleting a repository's session history (`cleanStorage`) is the most destructive action either module takes, so any unrecognized failure (permission denied, disk full, I/O error, a missing parent directory, a merely non-writable-but-readable database) defaults to `structural: false` / `usable: true` and is left alone rather than wiped. Only a positive corruption classification routes into `cleanStorage`, the same clean-slate path `restoreCache` already uses for cache-corruption and storage-version mismatches.

### S3 Conditional-Write Lock (Action + Gateway)

The Action and Gateway use the same runtime-owned S3 conditional-write lock (`If-None-Match` / `If-Match`) to coordinate per-repo execution so GitHub and Discord surfaces cannot overlap. Action acquisition lives in `src/harness/phases/acquire-lock.ts` and uses a 15-minute TTL without a heartbeat or `RunState`; `src/harness/phases/cleanup.ts` releases it in a cleanup `finally` block. The shared lock implementation is `packages/runtime/src/coordination/lock.ts`. The Gateway adds heartbeat and run state during execution, with startup stale recovery in `packages/gateway/src/execute/recovery.ts`.

### Mitmproxy Egress Topology (Workspace)

The workspace container runs inside a sandboxed Docker Compose network. All outbound traffic from the workspace is routed through a `mitmproxy` instance on `egress-net`; the workspace itself is on `sandbox-net` with no direct internet access. The mitmproxy enforces an allowlist of permitted outbound hosts. The gateway reaches the workspace via Docker Compose service DNS (`workspace:9100` for the workspace agent, `workspace:9200` for the OpenCode reverse proxy).

```
workspace container (sandbox-net)
  └─→ mitmproxy (sandbox-net ↔ egress-net)
        └─→ internet (allowlisted hosts only)

gateway container (gateway-net)
  └─→ workspace:9100  (workspace-agent clone/setup API)
  └─→ workspace:9200  (OpenCode reverse proxy, bearer auth)
```

### Effect / Result Boundary (Gateway)

`packages/gateway/` is the only package in the monorepo that uses `effect`. The Action and `packages/runtime/` stay on hand-rolled `Result<T, E>` from `@bfra.me/es`. The boundary adapter is `packages/gateway/src/runtime-effect.ts`, which wraps every `@fro-bot/runtime` function the gateway uses. All gateway code outside that file works exclusively in `Effect.Effect<A, E, R>`.
