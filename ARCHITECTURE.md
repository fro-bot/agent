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
| `installSystematicPlugin` | Function | `src/services/setup/systematic-plugin.ts` | Setup-time Systematic plugin install (keeps npm install off the server's boot path) |
| `restoreCache` | Function | `src/services/cache/restore.ts` | Restore OpenCode state |
| `saveCache` | Function | `src/services/cache/save.ts` | Persist state to cache; returns a `CacheSaveResult` (two independent persistence axes + a named outcome), not a boolean |
| `toCacheSaveStateValue` | Function | `src/shared/cache-save-result.ts` | Exhaustiveness-pinned mapper from `CacheSaveResult` to the `CACHE_SAVED` state handoff value |
| `checkpointDatabase` | Function | `src/services/cache/checkpoint.ts` | Merge SQLite WAL into main DB before save/restore hand-off |
| `verifyDatabaseUsable` | Function | `src/services/cache/integrity.ts` | Restore-side probe for structurally corrupt SQLite files |
| `isStructuralCorruptionError` | Function | `src/services/cache/sqlite-errors.ts` | Positive-allowlist classifier for SQLite corruption vs. transient errors |
| `executeOpenCode` | Function | `src/features/agent/execution.ts` | SDK execution orchestration |
| `runDrain` | Function | `src/harness/phases/execute.ts` | Drain phase: blocks publish/persist/release until this run's owned background work settles or the run's deadline expires |
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
| `bootstrapOpenCodeServer` | Function | `packages/runtime/src/agent/server.ts` (delegate: `src/features/agent/server-adapter.ts`) | Initialize SDK server lifecycle; probes instance-scoped readiness before reporting success |
| `createOwnershipLedger` | Function | `packages/runtime/src/agent/ownership-ledger.ts` | In-memory 3-state (outstanding/settled/unknown) ledger for background subagent executions, keyed by child session id |
| `reconcileLedgerOnce` / `createLedgerReconciler` | Function | `packages/runtime/src/agent/ledger-reconcile.ts` | Settles tracked ledger entries whose settlement event the SSE stream never delivered, against `children()`/`liveSessionIds()`; never adopts an untracked session |
| `TriggerDirective` | Interface | `packages/runtime/src/agent/prompt.ts` | Directive + appendMode for triggers |
| `DEFAULT_SYSTEMATIC_VERSION` | Constant | `packages/runtime/src/shared/constants.ts` | Pinned Systematic version (`3.21.0`) |
| `DEFAULT_OPENCODE_VERSION` | Constant | `packages/runtime/src/shared/constants.ts` | Pinned harness version (`1.18.30+harness.7c479429`) |

### `packages/gateway/`

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `runMention` | Function | `packages/gateway/src/execute/run.ts` | Full mention execution lifecycle |
| `launchWork` | Function | `packages/gateway/src/execute/run.ts` | Fire-and-return web launch path |
| `buildDiscordPrompt` | Function | `packages/gateway/src/execute/prompt.ts` | Discord-specific prompt builder |
| `buildOperatorApp` | Function | `packages/gateway/src/web/server.ts` | Operator Hono app factory |
| `createWorkflowDispatcher` | Function | `packages/gateway/src/github/dispatch.ts` | `/fro-bot dispatch` GitHub Actions workflow-dispatch adapter (fire-and-forget; no queue, concurrency, or local run-state) |
| `createDiscordApprovalOnPending` | Function | `packages/gateway/src/approvals/discord-transport.ts` | Discord approval transport; auto-denies on a terminal (channel/thread-gone) delivery failure |
| `recoverStaleRuns` | Function | `packages/gateway/src/execute/recovery.ts` | Startup sweep: reattaches stale `EXECUTING` runs, reconciles persisted background-subagent ownership against the live workspace server, and releases a stale run's lock whenever the lock still names that run |
| `classifyInspectResult` | Function | `packages/gateway/src/execute/provenance.ts` | Classifies a workspace `inspect()` result into a run-blocking `checkout-substituted` failure or a `CheckoutProvenance` the run carries forward |
| `parseOperatorCheckoutProvenance` | Function | `packages/gateway/src/operator-contract/provenance.ts` | Field-by-field validator projecting persisted `runState.details.checkoutProvenance` into the wire-decoupled operator DTO |
| `inspectCheckout` | Function | `apps/workspace-agent/src/inspect.ts` | `POST /inspect` handler: read-only report of an existing checkout (HEAD, worktree state, in-progress operation) |
| `executeClone` | Function | `apps/workspace-agent/src/clone.ts` | `POST /clone` handler: clones into root-owned staging, validates HEAD, hands ownership to the agent uid, then publishes by `rename` |
| `handOffToAgent` | Function | `apps/workspace-agent/src/handoff.ts` | Filesystem-only (`lstat`/`lchown`) ownership walk of a staged clone to `AGENT_UID`/`AGENT_GID`; bounded by deadline and entry cap |
| `buildOpencodeLaunchSpec` | Function | `apps/workspace-agent/src/opencode-server.ts` | Single launch spec for every OpenCode spawn: fixed executable path, agent uid/gid, allowlist-constructed env (`buildOpencodeEnv`) |
| `gitInvocation` | Function | `apps/workspace-agent/src/git-safety.ts` | Shared neutralized, credential-free git invocation (sealed config, exact `safe.directory`) for any git run against an agent-owned checkout |
| `createApp` | Function | `apps/workspace-agent/src/server.ts` | Workspace control-API Hono app; required `auth` union (`bearer` \| `disabled-for-tests`) gates every route except `/healthz`/`/readyz` |
| `withRepoLock` | Function | `apps/workspace-agent/src/repo-mutex.ts` | Single per-repo operation mutex (keyed by `repoMutexKey`) shared by clone, update, recovery, and backup deletion; `markRepoHeld` sets a sticky maintenance hold on any unconfirmed subprocess termination, cleared only by a workspace restart |
| `readJournal` / `writeJournal` | Function | `apps/workspace-agent/src/journal.ts` | Root-owned update/recovery journal store (temp-then-rename; parsed reads where `malformed` is never `absent`) |
| `executeUpdate` | Function | `apps/workspace-agent/src/update.ts` | `POST /update` handler: network-free admission, then the root-owned bare fetch store, then a pack-stream import, then a journaled fast-forward |
| `previewRecovery` / `executeRecovery` | Function | `apps/workspace-agent/src/recover.ts` | `POST /recover/preview` (stateless fingerprint) and `POST /recover` (quarantine-and-replace) handlers |
| `listBackups` / `deleteBackup` | Function | `apps/workspace-agent/src/backups.ts` | `GET`/`DELETE /backups/:owner/:repo[/:id]` handlers over quarantine generations |
| `runAgentWalk` / `measureSealedTree` | Function | `apps/workspace-agent/src/agent-walk.ts` | Agent-uid checkout size/entry-count walker; `measureSealedTree` measures a sealed tree through a root-opened fd when a plain agent-uid walk can't traverse it |
| `readUpdateNetworkConfig` | Function | `apps/workspace-agent/src/config.ts` | Reads the egress-proxy and CA-bundle settings `/update`'s network half needs, once at startup |
| `createRecoverCheckoutCommand` / `createCheckoutBackupCommand` | Function | `packages/gateway/src/discord/commands/{recover-checkout,checkout-backup}.ts` | `/fro-bot recover-checkout` and `/fro-bot checkout-backup list\|delete`; the Recover button on a refusal reply shares the same flow via `discord/recover-checkout-button.ts` |
| `OPERATOR_CONTRACT_VERSION` | Constant | `packages/gateway/src/operator-contract/version.ts` | Build-time-pinned operator contract version (`1.8.0`) |

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
        │     → bootstrapOpenCodeServer probes instance-scoped readiness (session.list) before
        │       reporting the server bootstrapped, not just listening
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
        │     (processEventStream observes owned descendants via a per-invocation
        │      OwnershipLedger: a completed `task` tool call carrying
        │      metadata.background === true adopts the child session id, after which
        │      its deltas/tools/permission-asks route like the root's, its token
        │      totals sum into the run's reported usage, and its session.error marks
        │      the entry unknown rather than ending the run's own turn)
        │
        ├─→ drain phase
        │     runDrain: owned background work settles before anything below
        │       publishes, persists, or releases — reconciles once immediately, then
        │       polls until the ledger drains or the run's deadline
        │       (computeDrainDeadlineMs: total timeout minus a 30s teardown reserve
        │       minus time execution already spent) expires, at which point every
        │       unsettled entry is session.abort-ed (no-op when execution never ran,
        │       e.g. SKIP_AGENT_EXECUTION=true)
        │
        ├─→ review-reconciliation phase
        │     reconcile formal review state after agent execution

        ├─→ finalize phase
        │     set outputs → writeJobSummary (includes a "Background Work" section
        │       naming any ownership-ledger entry that did not settle) → enforce/
        │       deliver response contract (review-required, review-permitted, or
        │       comment-only from trusted routing context)
        │
        └─→ cleanup phase
              prune sessions → shutdown server → sync artifacts and metadata
              → saveCache — declined outright (`ownership-declined`) if the ownership
                ledger, server shutdown quiescence, or the coordination lease cannot
                confirm no writer remains live; otherwise checkpoints the WAL before
                capturing files (S3 before Actions cache)
                → toCacheSaveStateValue derives CACHE_SAVED state + cache-save-result output + job-summary row
              → release lock in finally

post.ts (separate Action step)
  └─→ harness/post.ts (runPost)
        └─→ saveCache retry — skipped when CACHE_SAVED already reports durable/store-only/skipped/
              declined-for-safety; an absent or unrecognized state retries (not-persisted). Writes its own
              job-summary row on retry (no cache-save-result output: post: steps run after every other step)
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
              ├─→ checkout preparation (under the repo lock, before EXECUTING)
              │     POST /update — network-free admission, then the bare fetch store,
              │     then a pack-stream import, then a journaled fast-forward
              │     → `no-checkout` retries once through ensureClone (fresh clone), then
              │       retries /update; `checkout-substituted` fails the run before any
              │       agent session starts; every other refused/failed outcome ends the
              │       run before EXECUTING with a CheckoutPreparation record and a reply
              │       (Discord replies carry a one-click Recover button)
              │     → CheckoutProvenance (checked remote evidence) persisted with the
              │       EXECUTING transition on a `ready` outcome
              │
              ├─→ run-state lifecycle
              │     PENDING → ACKNOWLEDGED → EXECUTING
              │
              ├─→ execute/run-core.ts
              │     buildDiscordPrompt (+ provenance block appended) → OpenCode (workspace:9200, bearer auth)
              │     → SSE event stream → discord/streaming.ts → thread reply
              │
              ├─→ background dispatch observation (ownership ledger)
              │     `task` tool completes with state.metadata.background === true
              │     → ledger.adopt(childSessionId) + coordinator.addOwnedSession
              │     → descendant's deltas/tools/approvals now route like the root's
              │
              ├─→ tool approval (if any tool set to `ask`; root or adopted descendant)
              │     permission.asked → Discord embed (Approve/Deny buttons)
              │     → approval registry → workspace resume/reject
              │     (a terminal Discord delivery failure — channel/thread gone —
              │      auto-denies on the server instead of hanging out the run budget)
              │
              └─→ completion
                    root session.idle with ledger entries still outstanding → drain
                      (periodic reconciliation until settled or the run deadline expires)
                    code-written "started from" provenance line appended to the final reply
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

The write-ahead log itself no longer crosses either transport on save: `DB_TRANSPORTABLE_BASENAMES` (`packages/runtime/src/session/version.ts`) and `buildCachePaths` (`src/services/cache/paths.ts`) both include only the main database file. The object store's per-key upload/overwrite is not atomic across two files, so a healthy save that only refreshes `opencode.db` could otherwise leave an older `opencode.db-wal` object paired with a newer database on the next restore; `src/services/cache/restore.ts` deletes any write-ahead log downloaded from the object store immediately after the sync call returns, before anything opens the database. Restore and save now build the Actions-cache path list from that same shared `buildCachePaths`, so its version hash is identical by construction; a legacy database+WAL cache entry (built from the old five-path list) no longer matches that hash and is therefore never restored at all, not repaired in place.

`src/services/cache/integrity.ts` (`verifyDatabaseUsable`) closes the gap a hot WAL would otherwise mask: a structurally corrupt database with no pending write-ahead data reports `nothing-to-checkpoint` and would sail through unprobed, later getting re-persisted under a fresh key. It runs only on the restore path (`SELECT count(*) FROM sqlite_master`, a schema-page read, not a full `PRAGMA integrity_check`) and only when `checkpointDatabase` itself reports `nothing-to-checkpoint`.

`src/services/cache/sqlite-errors.ts` (`isStructuralCorruptionError`) is a positive allowlist — matching only SQLite's own wording for "file is not a database" and "database disk image is malformed" — never a catch-all. Deleting a repository's session history (`cleanStorage`) is the most destructive action either module takes, so any unrecognized failure (permission denied, disk full, I/O error, a missing parent directory, a merely non-writable-but-readable database) defaults to `structural: false` / `usable: true` and is left alone rather than wiped. Only a positive corruption classification routes into `cleanStorage`, the same clean-slate path `restoreCache` already uses for cache-corruption and storage-version mismatches.

### Cache Save Result Contract

`saveCache` (`src/services/cache/save.ts`) returns a `CacheSaveResult` (`src/shared/cache-save-result.ts`), not a boolean: `cachePersisted` and `storePersisted` are independent axes (either, both, or neither backend may have durably persisted state in one save), plus a named `CacheSaveOutcome` (`skipped-by-configuration`, `skipped-empty`, `checkpoint-declined`, `ownership-declined`, `cache-rejected`, `cache-error`, `persisted`) naming the terminal condition that produced them. `ownership-declined` is the save never being attempted at all because persistence safety could not be confirmed — unresolved background-subagent ownership, unconfirmed OpenCode server shutdown quiescence, or a failed coordination lease renewal (see `runCleanup`, `src/harness/phases/cleanup.ts`). `cache-rejected` is documented at the type as an inference, not an observation: `@actions/cache`'s `-1` write-failure sentinel does not distinguish a policy denial (read-only `ACTIONS_RUNTIME_TOKEN` on `issue_comment`/`issues`) from a reservation collision, and nothing downstream may infer which one occurred from trigger type or runner config.

`toCacheSaveStateValue` (`src/shared/cache-save-result.ts`) maps that result to one of five `CacheSaveStateValue`s (`durable`, `store-only`, `skipped`, `declined-for-safety`, `not-persisted`) via `OUTCOME_TO_STATE_VALUE`, a `satisfies Record<CacheSaveOutcome, ...>`-pinned table (the same exhaustiveness pattern as `RESPONSE_SURFACE_POLICIES` in `packages/runtime/src/agent/prompt.ts`): a new outcome added to the union without a case here fails `check-types` rather than silently mapping to nothing. `cache-rejected`/`cache-error` map to `store-only` when `storePersisted` is true, `not-persisted` otherwise — a store-only save is durable through the other backend, never inferred as a retry-worthy failure. `ownership-declined` maps to `declined-for-safety`, never to `not-persisted`: that would tell the post hook to retry and silently override the safety gate cleanup just applied.

`src/harness/phases/cleanup.ts` writes that value on every path a result exists (not just the successful one) to three places: `core.saveState(STATE_KEYS.CACHE_SAVED, ...)` for the post hook, `setCacheSaveResultOutput` (`src/harness/config/outputs.ts`) for the `cache-save-result` Action output (declared in `action.yaml`), and `writeCacheSaveResultSummary` (`src/features/observability/job-summary.ts`) for a standalone "Session Persistence" job-summary row — written separately from `writeJobSummary` because the save happens in cleanup, after `runFinalizeWithResult` has already written and flushed the main summary table. `src/harness/post.ts` reads `CACHE_SAVED` back via `parseCacheSaveStateValue` (absent or unrecognized values, e.g. from an older action version, fail toward `not-persisted` — retry, never skip) and skips its retry on `durable`/`store-only`/`skipped`/`declined-for-safety`, retrying only on `not-persisted`. The `declined-for-safety` skip is not an optimization like the other three: the post hook runs with strictly less information than cleanup had (no server handle, no ownership ledger, no lease), so it honors cleanup's refusal rather than second-guessing it — unlike `not-persisted`, which always retries because the post hook is the last chance to persist state. The post hook cannot set the `cache-save-result` output for its own retry: `runs.post:` steps execute after every other step in the job, so no step could exist to read a value set there; it writes its own job-summary row instead, since that may report a red state the main step's summary never saw.

### S3 Conditional-Write Lock (Action + Gateway)

The Action and Gateway use the same runtime-owned S3 conditional-write lock (`If-None-Match` / `If-Match`) to coordinate per-repo execution so GitHub and Discord surfaces cannot overlap. Action acquisition lives in `src/harness/phases/acquire-lock.ts` and uses a 15-minute TTL without a heartbeat or `RunState`; `src/harness/phases/cleanup.ts` releases it in a cleanup `finally` block. The shared lock implementation is `packages/runtime/src/coordination/lock.ts`. The Gateway adds heartbeat and run state during execution, with startup stale recovery in `packages/gateway/src/execute/recovery.ts` — which releases a stale run's lock whenever the lock still names that run's `run_id`, whatever phase it stopped in (checkout preparation holds the lock before `EXECUTING`, so gating release on phase would strand a crashed mid-clone run's lock until lease expiry; a lock another run has since taken is never touched), and also reconciles any persisted background-subagent ownership claim against the live workspace server (see Background Subagent Ownership Ledger below) before deciding whether a stale run's lock can be released.

### Background Subagent Ownership Ledger (Gateway)

`runMention` creates a fresh `OwnershipLedger` (`packages/runtime/src/agent/ownership-ledger.ts`) per run and hands it to `runOpenCodeCore` (`packages/gateway/src/execute/run-core.ts`), keyed on the descendant's child session id rather than its job id — upstream reuses job ids across extensions, so a job-keyed ledger would let a delayed notification for a stale job settle a newer execution. Each entry is `outstanding` (adopted, not yet confirmed finished), `settled` (confirmed finished, terminal), or `unknown` (a dropped event or a failed reconciliation call — never collapsed into `settled`, and blocks `isDrainComplete()` and `isPersistenceSafe()` alike — an entry the harness cannot confirm might still be a live writer, so the run's own deadline rather than the predicate is what bounds the wait). A background dispatch is observed, not requested: when a `task` tool call completes carrying `state.metadata.background === true` and a `jobId`, `run-core` adopts that `jobId` into the ledger and calls `coordinator.addOwnedSession(jobId)` — from that point the descendant's own text deltas, tool events, and permission asks route through the same handlers as the root session (`PermissionCoordinator.isOwned`, `packages/gateway/src/approvals/coordinator.ts`) instead of being dropped by the root-session-only filters that used to gate every event branch. Root `session.idle` is deliberately NOT an ownership check — it always resolves the run's completion signal, and a descendant's own idle transition must never be mistaken for the root's. Root idle with `ledger.isDrainComplete() === false` instead enters a drain state: the run stays alive, continuing to route descendant events and approvals, while `createLedgerReconciler` (`packages/runtime/src/agent/ledger-reconcile.ts`) polls every `DEFAULT_LEDGER_RECONCILE_INTERVAL_MS` (30s) — until every entry settles or the run's own deadline expires, at which point every entry not confirmed `settled` — `unknown` as well as `outstanding`, since an unconfirmable entry is the one most likely still running — is individually `session.abort`-ed and downgraded to `unknown` (a cancellation request was sent, but nothing confirms the child actually stopped). Reconciliation only ever settles or downgrades entries the ledger already tracks; it cannot adopt an untracked child, because upstream creates a child session for foreground `task` delegation identically to a background one and writes `background: true` only onto tool-part metadata, never onto the session record.

Reconciliation (`reconcileLedgerOnce`) settles what it already tracks; it never adopts a session the ledger has not already learned about. It does NOT recover a dropped dispatch event — upstream creates a child session identically for foreground `task` delegation and background dispatch (the only difference, `background: true`, is stamped onto the tool-call metadata, never onto the session record), so `children()`/`liveSessionIds()` give reconciliation no discriminant to tell an ordinary foreground subagent from a background dispatch. An earlier version adopted any live untracked child it found; that let a foreground subagent mid-run at a reconcile tick be misclassified as this run's owned background work, and was removed. What reconciliation DOES recover is a dropped _settlement_ event: for each tracked entry it asks two separate upstream questions and never conflates them — `children(parentSessionId)` (a bare parent-id lookup with no liveness filter, used only to confirm a tracked entry is still this parent's child) and `liveSessionIds()` (server-wide non-idle session status). A tracked entry that is a child of the parent AND live stays outstanding; one that is a child AND NOT live is settled; one that is not a child of the parent at all — even if `liveSessionIds()` reports it live somewhere else on the server — is downgraded to `unknown`, never settled and never left outstanding, because a persisted or forged entry naming a session live under a different tree must never grant this run's drain or Discord thread access to it. The pass makes no upstream calls at all when the ledger is empty. `run.ts` persists the ledger's non-settled entries onto `RunState.details` (`rootSessionId`, `ownedSessionIds`) on every mutation via `wrapLedgerWithHooks`, fire-and-forget; `recovery.ts`'s `reconcileOwnedSessions` reads that claim back on gateway restart, seeds a throwaway ledger with exactly the persisted session ids, and runs one reconciliation pass scoped to the persisted `rootSessionId` before treating any of it as live — a restart is not a workspace restart (subagents may still be writing), but a claim the live server does not corroborate is downgraded, never restored. A dispatch whose _dispatch_ event (not settlement) is dropped before the ledger ever learns the session id is consequently unrecoverable by reconciliation; this is bounded by the run's own deadline, and nothing in this codebase can currently issue a background dispatch, so the gap has no live exposure today.

### Background Subagent Ownership Ledger (Action)

`runExecute` (`src/harness/phases/execute.ts`) creates one `OwnershipLedger` per invocation (persisting across every LLM retry attempt inside `executeOpenCode`, but replaced with a fresh, empty one across a context-overflow recovery restart — the recovered session starts with nothing outstanding) and threads it through `executeOpenCode` → `sendPromptToSession` (`src/features/agent/prompt-sender.ts`) → `runPromptAttempt` (`src/features/agent/retry.ts`) → `processEventStream` (`src/features/agent/streaming.ts`). The same SSE consumer that already drove the root session's text, tool, and error handling now drives every adopted descendant's too, gated by `isOwnedSession()` — true for the root session id, true for any id `ledger.isTracked()`, false otherwise (absent ledger stays single-session, matching every run before this capability existed). A completed `task` tool call carrying `state.metadata.jobId` and `state.metadata.background === true` adopts the child — the identical signal the gateway's `run-core.ts` detects, duplicated rather than shared because the two surfaces have no common event-consumption module. Once adopted, a descendant's `permission.asked` is auto-denied exactly like the root's; its `session.error` marks the entry `unknown` rather than ending the run's own turn or feeding `recoverFromContextOverflow` — only the root session's `session.idle`/`session.error` end or degrade this invocation's turn, mirroring the gateway's identical root-scoping and for the identical reason (a descendant's own terminal signal must never be mistaken for the root's). The one signal treated as confirmed-finished for a descendant is upstream's own injected `<task id="..." state="completed|error">` completion turn on the ROOT session's text, parsed by `parseInjectedTaskCompletion` and settled unconditionally for either terminal state. Each owned session's latest-reported token total is tracked separately and summed across every owned session (`sumOwnedSessionTokens`) into the run's reported usage — replacing a plain assignment that let a descendant's report silently clobber the root's.

`runDrain` (`src/harness/phases/execute.ts`) runs from `run.ts` between the execute phase and review-reconciliation: a complete no-op when `execution.ownershipLedger` is absent (execution never ran, e.g. `SKIP_AGENT_EXECUTION=true`), otherwise an unconditional first `reconcileLedgerOnce` pass — reconciliation is the only way a dropped dispatch event's settlement can still be recovered — followed by a poll loop against `ledger.isDrainComplete()` until it clears or `computeDrainDeadlineMs(timeoutMs, executionDurationMs)` (the invocation's total timeout, minus what execution already spent, minus a 30-second teardown reserve measured from real teardown runs, `DEFAULT_DRAIN_TEARDOWN_RESERVE_MS`) expires. On expiry every entry not confirmed `settled` — `outstanding` and `unknown` alike, since an unconfirmable entry is the one most likely still live — is `session.abort`-ed, reconciled once more, and whatever still is not confirmed settled is left `unknown`. Without a session client or parent session id to reconcile against (defensive; unreachable from the Action's real call graph today) every outstanding entry is marked `unknown` with no upstream call at all, rather than silently claiming a drain that was never actually checked. `writeJobSummary` (`src/features/observability/job-summary.ts`) reports the outcome in a "Background Work" job-summary section: silent when the ledger is absent or empty (byte-identical output to before this section existed), `"All background work finished."` when every entry settled, otherwise a list naming each unfinished entry by its dispatch-site label and state (`still running` / `unconfirmed`) plus a degraded-state banner when any entry is `unknown` — an unresolved entry is neither confirmed finished nor confirmed cancelled, and a reviewer who only skims for a nonempty list must not miss that ambiguity.

`runCleanup`'s persistence-safety gate (see Cache Save Result Contract above) is this ledger's other consumer: `ownershipLedger.isPersistenceSafe()` unresolved is the first of three independently-sufficient reasons `saveCache` can be declined outright as `ownership-declined`.

`buildCIConfig` (`src/services/setup/ci-config.ts`) pins OpenCode's `subagent_depth` config key to `1` unconditionally, in every mode (slim, oMo-enabled, disabled), overriding any operator-supplied value with a logged warning rather than honoring it — the one deliberate exception to this project's general "explicit operator value wins" convention. Upstream's own cancellation walks RUNNING jobs only: a completed child that links the root session to a still-running grandchild is never walked, so at depth greater than one a grandchild dispatch could outlive a cancellation meant to stop it. Depth one makes that path structurally unreachable rather than building a traversal of our own. An earlier design paired this with a pre-dispatch admission cap enforced against the ledger; it was removed as unenforceable — the only pre-execution hook available (the `task` permission request) fires identically for foreground delegation and background dispatch, so gating there would have throttled ordinary work, and the ledger it would have read only populates on already-completed dispatches, so the cap could never actually hold its own contract.

### Generation-Scoped Completion Evidence (Action)

Idle and terminal-signal evidence consumed by the execute-phase poll loop (`pollForSessionCompletionObservation`, `src/features/agent/session-poll.ts`) is scoped to a _generation_, not read as a sticky flag. `ActivityTracker.rootFreshness` (a `RootFreshnessTracker`, `src/features/agent/streaming.ts`) carries a monotonic `revision` counter advanced only by `invalidateRootFreshness()`, called on renewed ROOT-session activity: a `busy`/`retry` `session.status`, a new root user message (including an injected background-task-completion turn), or root-scoped assistant creation/progress/text-deltas/tool activity over SSE — callers gate every mutator on `eventSessionID === sessionId` first, so a descendant's own activity can never advance the root's generation. `markRootIdleCandidate()` stamps an idle observation with the revision it was seen at; `hasFreshIdleCandidate()` is true only when that stamped revision still equals the tracker's current revision, no `pendingParentMessageId` barrier is set, and no SSE-discontinuity revalidation is outstanding. It gates the idle-evidence paths in `session-poll.ts` and `retry.ts`'s `startV2SessionWait()`, but it is deliberately not the only admission route: the qualified-message path below reaches its own decision from message evidence plus status corroboration and revision freshness, without consulting the idle candidate at all. Treating this predicate as the single gate on completion is wrong, and a review round spent a high-confidence finding on that mistaken reading. This closes a real race: a background subagent's completion injects another parent turn onto the root session, and upstream persists that user message before the runner that will answer it starts running, so a plain sticky idle-received flag read during that window could authorize completing a turn that is still in flight. `registerPendingRootUserMessage()` raises the barrier on the new turn (a no-op on a duplicate/retried event for the same still-pending id) and `resolvePendingRootUserMessage()` clears it only once that message's own terminal assistant reply is observed. `requireRootRevalidation()`/`clearRootRevalidationRequirement()` force a REST corroboration before retained idle evidence may be trusted again after an SSE discontinuity, since a broken stream cannot itself prove freshness.

`detectMessageActivity()` (`session-poll.ts`) also tightens what counts as a completed assistant message: `time.completed` alone is not a success certificate (upstream stamps it during processor cleanup, including failed/intermediate processing), so a qualified candidate additionally requires a `finish` reason present and not `tool-calls`/`unknown`; correlation to the latest known root user message via `parentID` with the pending-parent barrier clear; no revision drift since the request was issued; and — mirroring upstream's own prompt-loop rule, which ignores tool-part `status` entirely — no non-provider-executed tool part left in the message unless cleanup already marked it an orphaned interrupted tool (`state.status === 'error'` and `state.metadata.interrupted === true`, strictly). A _completed_, non-provider-executed tool part still blocks: the model has not received the result yet and will produce another turn. The same qualified candidate must also survive two consecutive polls, and `session.status()` must corroborate inactivity, before completion is admitted. An assistant message carrying its own `error` field is classified through the same bounded provider/generic precedence the SSE `session.error` branch uses (`classifyAssistantMessageError()`) and returned as failure evidence directly, never falling through into a generic timeout and never becoming a completion candidate. `ledgerBlocksCompletion()` gates every one of these admission points against the `OwnershipLedger`, so a fresh, qualified, status-corroborated completion still defers while owned background work is outstanding. A run whose evidence is genuinely unavailable now reaches the watchdog or the deadline instead of reporting a guessed success.

### Approval Denial on Undeliverable Discord Notification

`createDiscordApprovalOnPending` (`packages/gateway/src/approvals/discord-transport.ts`) posts a tool-approval embed with Approve/Deny buttons and waits for a human. If the bound thread was deleted, that post fails, nobody can answer it, and the run would otherwise wait out its full budget for a decision that can never arrive. `handleUndeliverable` reclassifies a TERMINAL Discord failure — `UnknownChannel` or `MissingAccess`, matched on `DiscordAPIError.code` (a stable numeric code), never on `error.message`, so a wording change upstream cannot silently reclassify a rate limit or a 5xx as fatal — into an immediate server-side denial via `approvalRegistry.applySettlement({decision: 'reject', reason: 'disposed'})`, rather than leaving the entry `open` for a POST that can never succeed. Retryable failures (rate limits, 5xx, network errors) are left alone; the entry stays open via `markMessagePostFailed` so a later settlement can still deliver once the transient condition clears. The denial is deliberately visible, not silent: it logs at `error` with the Discord code, and posts a best-effort thread note worded distinctly from a human "Deny" click or a deadline timeout — because this mechanism turns Discord notification availability into a denial control, and an operator diagnosing a run must be able to tell a delivery failure from a person saying no.

### Checkout Provenance (Gateway + Workspace)

Every run on a repository shares one checkout on a persistent volume (`/workspace/repos/{owner}/{repo}`), so a gateway run must record what it started from. Preparation runs only while holding the repo lock, before `EXECUTING`: `runMention`/`launchWork` (`packages/gateway/src/execute/run.ts`) call `update()` (`packages/gateway/src/workspace-api/client.ts`, `POST /update`) first — never `ensureClone` (`POST /clone`) unconditionally. `ensureClone` runs only when `/update` reports `no-checkout` (e.g. after container recreation), and `/update` is retried against the freshly cloned tree; a fresh clone reporting `no-checkout` again is treated as a workspace bug, not a transient blip. The concurrency gate is keyed by channel, not repo, so preparing before the lock would let another channel, the operator surface, or an Action run touch the tree concurrently. A transport failure throws a `RunCoreError` through the same post-lock failure path as any execution failure; a client-side `/update` timeout reports checkout state as unknown rather than guessing, a rejected control-API bearer (401) maps to `workspace-unavailable`, and everything else invites a retry.

`/update` (`apps/workspace-agent/src/update.ts`) advances an eligible checkout to the remote default branch tip through network-free admission (config inventory, layout, temp-index cleanliness, path-obstruction preflight — `apps/workspace-agent/src/checkout-profile.ts`), a fetch into a root-owned bare mirror, a `pack-objects --stdout | index-pack --stdin --strict` pack-stream import, and a journaled `merge --ff-only --no-overwrite-ignore` fast-forward, returning a discriminated union: `ready` (unchanged or fast-forwarded, with checked remote evidence), `refused` (a reason, no mutation — dirty, detached, non-default-branch, diverged, ahead, unsupported layout/config, obstructed, an initialized submodule, an operation in progress, `needs-recovery`, `maintenance-hold`, or `checkout-substituted`), or `failed` (a reason, plus whether mutation had started). `checkout-substituted` fails the run with its own failure kind before any agent session starts, exactly as `classifyInspectResult` used to. Every other `refused`/`failed` outcome ends the run before `EXECUTING`: `toCheckoutPreparation` (`packages/gateway/src/execute/provenance.ts`) projects it into a `CheckoutPreparation` record persisted with the run's `FAILED` transition, and `formatPreparationRefusedReply`/`formatPreparationFailedReply` (`packages/gateway/src/execute/preparation-reply.ts`) format the reply — every refusal except `maintenance-hold` (and an apply-failed reply whose mutation may have started) names `/fro-bot recover-checkout` and, on Discord, carries a one-click Recover button (`packages/gateway/src/discord/recover-checkout-button.ts`) that reruns the identical flow after a fresh `ManageChannels` check.

A `ready` outcome's own admission gates already guarantee a clean, attached, no-operation-in-progress checkout — exactly the conditions that would otherwise have refused — so the gateway synthesizes `CheckoutProvenance` directly from the `UpdateReady` result rather than an extra round trip; its `remote` is `checked` (branch, SHA, time observed), never `not-checked`. `CheckoutProvenance` keeps meaning "the starting state of a run that reached EXECUTING"; refused/failed attempts land in the separate `checkoutPreparation` field instead (a run cancelled before `EXECUTING` records neither — it never started). The provenance flows three ways: persisted atomically with the `EXECUTING` transition via `detailsPatch`, appended to the prompt (`formatProvenanceForPrompt`), and appended to every final reply as a deterministic code-written "started from" line (`formatProvenanceLine`) — never model-written. Branch names come from an agent-writable checkout: replace backticks in the reply's code span, quote them as a JSON string in the prompt, and cap their length in both. The operator surface exposes both as the optional `OperatorRunStatus.checkoutProvenance`/`checkoutPreparation` fields (contract `1.8.0`) through `parseOperatorCheckoutProvenance`/`parseOperatorCheckoutPreparation` (`packages/gateway/src/operator-contract/provenance.ts`), wire-decoupled DTOs validated field-by-field — malformed or absent data projects to `undefined`, never a cast.

`/inspect` (`inspectCheckout`, `apps/workspace-agent/src/inspect.ts`) remains a standalone read-only diagnostic endpoint, independent of preparation. It runs under the next run's lock before that run's agent starts, against a tree the previous run's agent could write, so treat it as hostile-input code: it runs git as the unprivileged agent uid (not the root service) through the shared invocation in `apps/workspace-agent/src/git-safety.ts` (system/global config off, exactly the one canonical path marked `safe.directory`); it never clones, fetches, checks out, or passes credentials; runs `git status --no-optional-locks --ignore-submodules=all`; neutralizes `core.fsmonitor`, `core.hooksPath`, `core.pager`, and `credential.helper`; and enumerates every configured `filter.<name>` driver (system/global/local/worktree, following includes) fresh before each status call, disabling `clean`/`smudge`/`process` and forcing `required=false` via git's config environment variables rather than `-c` (which splits on the first `=`). Enumeration fails closed — if it cannot list drivers, `status` never runs and the call reports `inspection-failed`. Every git subprocess is bounded and confirmed reaped before a timeout resolves. The accepted cost: in a repo with a real filter (e.g. git-lfs) a stat-changed filtered file reports modified even when its content is not. The checkout types are duplicated between `apps/workspace-agent/src/types.ts` and `packages/gateway/src/workspace-api/types.ts` (the gateway image builds in isolation and cannot import the workspace-agent); `scripts/checkout-types-drift-guard.test.ts` asserts mutual assignability of the real types so drift on either side fails `check-types`.

### OpenCode File Watcher Disabled By Default

Neither surface consumes file-change events — the Action's stream handler and the gateway both read message and tool lifecycle events only — so `bootstrapOpenCodeServer` (`packages/runtime/src/agent/server.ts`) sets `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true` before spawn, alongside the pinned `FRO_BOT_OPENCODE_URL`, so the child captures it at spawn time and it survives the `OPENCODE_`-prefix allowlist in `filterAgentEnv`. It only defaults the value when unset or an empty string — GitHub Actions materializes an unset `env:` input as `''`, not an absent key, and OpenCode's boolean config parsing does not treat `''` as true — so an operator who explicitly set it (including to `false`) is never overridden. `deploy/workspace.Dockerfile` bakes the same default (`ENV OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true`) into the gateway's workspace container image, overridable per-deployment via `deploy/compose.yaml`/`deploy/.env`. The accepted tradeoff: OpenCode caches the VCS branch and refreshes that cache from watcher events, so it can go stale after a checkout — more visible on the long-lived workspace container than in short-lived CI.

### Mitmproxy Egress Topology (Workspace)

The workspace container runs inside a sandboxed Docker Compose network. All outbound traffic from the workspace is routed through a `mitmproxy` instance on `egress-net`; the workspace itself is on `sandbox-net` with no direct internet access. The mitmproxy enforces an allowlist of permitted outbound hosts. The gateway reaches the workspace via Docker Compose service DNS (`workspace:9100` for the workspace agent, `workspace:9200` for the OpenCode reverse proxy).

```
workspace container (sandbox-net)
  └─→ mitmproxy (sandbox-net ↔ egress-net)
        └─→ internet (allowlisted hosts only)

gateway container (gateway-net)
  └─→ workspace:9100  (workspace-agent clone/inspect control API, bearer auth)
  └─→ workspace:9200  (OpenCode reverse proxy, bearer auth)
```

### Workspace UID Isolation (Service vs. Agent)

The workspace container runs two identities. The workspace-agent **service** (`apps/workspace-agent/src/main.ts`) stays root (uid 0) because it hands checkouts to the agent and supervises its processes, but `deploy/compose.yaml` drops every capability except `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`, `KILL`, sets `no-new-privileges`, and disables core dumps. **OpenCode and everything it spawns** run as the unprivileged `opencode` account (`AGENT_UID`/`AGENT_GID` `10001`). `apps/workspace-agent/src/identity.ts` is the single source of truth for the uid/gid, the agent home and XDG tree (`/home/opencode`), the separate `SERVICE_HOME` (`/var/lib/workspace-agent/home`), the root-owned state/staging directory names, and the absolute `OPENCODE_EXECUTABLE_PATH`; `deploy/workspace.Dockerfile` creates the account and directories with the same values, so change both together.

- **OpenCode launch.** Every spawn site goes through `buildOpencodeLaunchSpec` (`apps/workspace-agent/src/opencode-server.ts`): absolute executable path (never resolved through `PATH`), agent uid/gid, and an environment _constructed_ from an allowlist by `buildOpencodeEnv` — agent home/XDG/`TMPDIR`, a fixed `PATH`, proxy, CA bundle, locale, and `OPENCODE_*` flags only. `WORKSPACE_*` settings, secret-file paths, tokens, and `GIT_*`/loader overrides cannot reach the child by construction, not by filtering. The service binds its control ports before OpenCode starts so the agent cannot race it for them.
- **Clone and handoff.** `executeClone` (`apps/workspace-agent/src/clone.ts`) clones into root-owned staging (`/workspace/repos/.workspace-agent/staging/`, `0700`, on the same volume), resolves and validates HEAD while the tree is still root's, hands every entry to the agent via `handOffToAgent` (`apps/workspace-agent/src/handoff.ts` — `lstat`/`lchown` only, never follows a symlink, never crosses `st_dev`, fails the clone on a hardlink, bounded by deadline and entry cap), then publishes with a single `rename`. Staging is emptied on every failure path. Clone runs under the shared per-repo mutex (`apps/workspace-agent/src/repo-mutex.ts`) and refuses with `journal-in-progress` (409) before touching anything when `apps/workspace-agent/src/journal.ts` reports an outstanding journal for the repo — found or `malformed`, never treated as absent. The only git that runs as root with credentials is the clone itself, in staging; the `repo-exists` check and post-rename race-check run as the agent through `apps/workspace-agent/src/git-safety.ts`.
- **Control-API auth.** `/clone` and `/inspect` on `:9100` require `Authorization: Bearer <WORKSPACE_OPENCODE_TOKEN>` — the same root-only secret the `:9200` OpenCode proxy uses — so the agent uid cannot call the control API over loopback. `createApp` (`apps/workspace-agent/src/server.ts`) takes a required `auth` discriminated union with no default; the check runs before body parsing, compares constant-time (length-guarded `timingSafeEqual`), and returns a fixed 401. The gateway sends the bearer from `createWorkspaceClient` (`packages/gateway/src/workspace-api/client.ts`); roll the gateway and workspace images together, since a token mismatch rejects every clone.
- **Checkout-update primitives.** Credentialed fetches run only against a root-owned bare mirror under the state directory's `fetch/` store (`FETCH_STORE_DIR_NAME` in `apps/workspace-agent/src/identity.ts`); objects cross into the agent-owned checkout only as a `pack-objects --stdout | index-pack --stdin --strict` stream (`runPackStream`, `apps/workspace-agent/src/git-stream.ts`), never by local fetch or alternates. Admission checks against an existing checkout — config inventory, layout, temp-index cleanliness, path-obstruction preflight — live in `apps/workspace-agent/src/checkout-profile.ts` and run as the agent through the network/local-update git profiles in `apps/workspace-agent/src/git-safety.ts`. The egress proxy and CA bundle `/update`'s network half needs are read once at startup (`readUpdateNetworkConfig`, `apps/workspace-agent/src/config.ts`), never re-read per call. Adversarial real-git fixtures live in `apps/workspace-agent/src/update-fixtures/`.
- **Per-repo mutex and maintenance hold.** `apps/workspace-agent/src/repo-mutex.ts` serializes every mutating operation on a repository — clone, update, recovery, backup delete — through one in-process `withRepoLock`; different repositories never contend. When a subprocess's termination cannot be confirmed within its reap-grace window (SIGKILL sent, exit never observed), `markRepoHeld` sets a sticky, in-process maintenance hold on that repository: every later mutating call refuses with `maintenance-hold` rather than risk two operations touching the same on-disk state. The hold clears ONLY on a workspace restart — never a timer, never a later successful operation — because the workspace is always exactly one container (a documented precondition of the #1661 migration, enforced by `deploy/validate-stack.sh`'s `workspace.deploy.replicas` check) and a restart is the only event that can actually guarantee a leaked subprocess is gone.
- **Journals and startup reconciliation.** Every in-flight update or recovery mutation is journaled root-owned under the state directory's `journals/` store (`JOURNAL_DIR_NAME`, `apps/workspace-agent/src/journal.ts`), one file per repository, written temp-file-and-rename — never inside `.git/`, where the agent could forge one. A read that finds a file but cannot parse it reports `malformed`, never `absent`. `main.ts` reconciles every outstanding journal on service start (bounded by `JOURNAL_RECONCILE_TIMEOUT_MS`), and `/update`/`/recover` reconcile again at the top of each operation before anything else: an update journal stuck at `applying` marks the checkout needs-recovery; a recovery journal is resolved forward from wherever it stopped, never by deleting the quarantined original or cloning into the empty path.
- **Recovery and backups.** `POST /recover/preview` (`previewRecovery`) is stateless — no server-side operation id — and returns a `fingerprint` digesting HEAD SHA, dirty counts, and checkout size/entry count; `POST /recover` (`executeRecovery`) recomputes the fingerprint under the repo lock and refuses with `checkout-changed` if it differs. A confirmed recovery preserves the WHOLE existing checkout by `rename` into a root-owned quarantine envelope `<quarantine>/<owner>__<repo>/<id>/{checkout/, metadata.json}` (`QUARANTINE_DIR_NAME`, `apps/workspace-agent/src/backups.ts`) — never stash, commit, or discard — then installs a fresh checkout built entirely as root in root-owned staging (`git init`, pack import, `read-tree --reset -u`, `update-ref`, canonical origin config) before handoff and rename; `read-tree --reset` never runs against an agent-owned checkout. Retention is capped at 5 generations and 10 GiB per repository (`RETENTION_MAX_GENERATIONS`/`RETENTION_MAX_BYTES`, `apps/workspace-agent/src/recover.ts`) with no automatic eviction — at the cap, recovery refuses before moving anything. `GET`/`DELETE /backups/:owner/:repo[/:id]` (`listBackups`/`deleteBackup`, `apps/workspace-agent/src/backups.ts`) list and remove one generation at a time; there is no export and no bulk delete.
- **Agent-uid size walker.** `runAgentWalk` (`apps/workspace-agent/src/agent-walk.ts`) measures a checkout or quarantine generation's size and entry count as the agent uid via a spawned child; when that plain walk is incomplete or fails, `measureSealedTree`/`measureSealedTreeFromFd` fall back to measuring the same sealed tree through a root-opened file descriptor, so the service never has to traverse an agent-owned directory by path.
- **Private-repo auth.** The installation token reaches git only through a `GIT_ASKPASS` helper that exact-matches git's literal `https://github.com` prompts and exits non-zero otherwise, with global/system git config sealed and `GIT_ALLOW_PROTOCOL=https`.
- **Directory ownership.** `/workspace/repos` and each owner directory stay root-owned, so the agent can edit a checkout but cannot replace where it lives. Secrets and the raw mitmproxy CA mount under the root-only `/run/workspace-agent/` tmpfs; only the installed public trust bundle is readable by both identities.
- **Entrypoint.** `deploy/workspace-entrypoint.sh` creates the protected state directory (`deploy/scripts/ensure-protected-dir.mjs`), migrates legacy root-owned checkouts to the agent uid (`deploy/scripts/migrate-repo-ownership.mjs` — filesystem-only, symlink/hardlink-safe, per-checkout completion markers, bounded by `WORKSPACE_MIGRATION_DEADLINE_MS`, refuses to start on timeout, never deletes), and writes OpenCode's auth and merged config from a process already running as the agent, fed via stdin (`deploy/scripts/provision-agent-config.mjs`) — root never writes into an agent-owned directory, where a planted symlink would turn into a privileged write.
- **Verification.** Kernel permission boundaries cannot be proven by unit tests: `deploy/tests/isolation-harness.sh` starts the image exactly as compose does and pairs each attempted violation as the agent (reading service home/secrets/env/memory, replacing a checkout parent, taking a control port) with the same operation succeeding as root. `deploy/validate-stack.sh` requires the service identity, the exact capability set, `no-new-privileges`, and the protected mount locations; `deploy/egress-smoke.sh` and the CI image smoke run with production's user, capabilities, and mount layout. CI also builds the `workspace-test` target of `deploy/workspace.Dockerfile` and runs the workspace-agent suite inside it, so the git fixtures exercise the image's own Alpine git.

### Effect / Result Boundary (Gateway)

`packages/gateway/` is the only package in the monorepo that uses `effect`. The Action and `packages/runtime/` stay on hand-rolled `Result<T, E>` from `@bfra.me/es`. The boundary adapter is `packages/gateway/src/runtime-effect.ts`, which wraps every `@fro-bot/runtime` function the gateway uses. All gateway code outside that file works exclusively in `Effect.Effect<A, E, R>`.

### Systematic Plugin Install (Setup-Time, Not Server-Boot)

`src/services/setup/systematic-plugin.ts` (`installSystematicPlugin`) runs the OpenCode CLI's `plugin` command (`opencode --pure plugin @fro.bot/systematic@<version> --global`) during the setup phase, on a tools-cache miss, before `saveToolsCache` — moving the same `Npm.add()` install the server would otherwise perform out of the server's boot path and into the same on-disk cache directory the server reads (deriving that path independently would have created a second copy of OpenCode's layout that must silently agree with the real one forever). Left alone, the server runs `config.get()` then `plugin.init()` serially before any service init, with no timeout of its own; a degraded npm registry turns that into 181–370s of a server whose SDK-level readiness signal — a stdout string match (`"opencode server listening"`) — is satisfied long before this per-directory instance bootstrap has run (issue #1536). `bootstrapOpenCodeServer` now closes that gap with its own instance-scoped readiness probe (a bounded `client.session.list({query: {directory}})` call) after `createOpencode` resolves, so a stall like this one now fails fast, by name, instead of surfacing 181–370s later as a bare "fetch failed" once undici's 300s `headersTimeout` on the harness's first real request finally gives up. The install is bounded (SIGTERM then SIGKILL) at 420s — sized against that measured stall tail, not against a healthy install (seconds) — and is non-fatal: on timeout or failure it warns and lets the server's own install serve as the fallback it always was, and setup skips `saveToolsCache` entirely, so an incomplete install is never persisted into an immutable cache key. The child's environment is `filterAgentEnv`-scrubbed, never inherited wholesale — this subprocess runs `npm install` against a package fetched off the network, so it gets the same untrusted-child treatment `withScrubbedEnv` gives `createOpencode` (issue #1147), never `GITHUB_TOKEN`, `*_API_KEY`, `*_SECRET`, `AWS_*`, or `INPUT_*`. It runs with `--pure` (skip plugin boot on install) and `--global` (write OpenCode's own config, not the checked-out repository).

Booting OpenCode for this install initializes the real session database (`~/.local/share/opencode/opencode.db`), enables WAL mode, and leaves an `opencode.db-wal` sidecar beside it — and this install runs on every tools-cache miss, before the session-storage cache is restored, on every harness release. `DB_TRANSPORTABLE_BASENAMES` (`packages/runtime/src/session/version.ts`) deliberately transports only the main database file, so a WAL this install created survived next to a database it was never opened against once the Actions-cache restore overwrote `opencode.db`; `checkpointDatabase` then silently merged that stale WAL into the freshly restored database, discarding the sessions the restore had just written back (production evidence: run `34448454976` restored 97 sessions from a 19 MB restore reported as "Cache restored successfully"; run `34449598839`, fifteen minutes later against the same restore key and an equally successful-looking restore, came up with 0 — and the saved cache entry itself had collapsed from 20,231,832 bytes to 801,442). `installSystematicPlugin` now points the child at `OPENCODE_DB`, a throwaway database file inside a per-install `mkdtemp()` directory, rather than cleaning up the stray WAL after the fact — a cleanup pass risks deleting committed session data on a cache miss or on a persistent runner. `OPENCODE_DB` is read directly by OpenCode's database path resolution and accepts an absolute path; the underlying sqlite drivers derive the `-wal`/`-shm` sidecar paths from that same main file path, so redirecting it relocates its sidecars too. The temp directory is removed in a `finally` block on every exit path — success, failure, and timeout — with cleanup failures logged but never surfaced as an install failure. `OPENCODE_DB` matches the existing `OPENCODE_` allowlist prefix in `filterAgentEnv`, so it reaches the child alongside the other `OPENCODE_*` overrides above while the deny-set and allowlist stay unchanged. Verified fixed on #1587's own review job (run `34463783992`): a genuine tools-cache miss — the same condition that triggers the bug — restored 97 sessions with no checkpoint-merge log line anywhere in the run.
