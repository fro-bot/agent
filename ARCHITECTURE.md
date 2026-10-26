# Architecture

This document describes the system design, invariants, and data flows for the fro-bot/agent monorepo. For directory layout and where to add new code, see [STRUCTURE.md](STRUCTURE.md). For operational knowledge, symbol tables, and commands, see [AGENTS.md](AGENTS.md).

> **Deep dives:** [Architecture Overview](docs/wiki/Architecture%20Overview.md) · [Execution Lifecycle](docs/wiki/Execution%20Lifecycle.md) · [Conventions and Patterns](docs/wiki/Conventions%20and%20Patterns.md)

## Bird's-Eye Overview

This monorepo ships three distinct deployable surfaces from one codebase:

- **GitHub Action** — a CI harness that runs OpenCode agents in response to GitHub webhook events (issues, PRs, comments, reviews, scheduled runs, workflow dispatches). The Action entry points are `src/main.ts` and `src/post.ts`; the real logic lives in the 4-layer `src/` tree and `packages/runtime/`. Sessions persist across CI runs via GitHub Actions cache when the trigger permits cache writes, and via an S3-compatible object store; `issue_comment` and `issues` runs cannot write the cache and depend on the object store for continuity.
- **`@fro-bot/gateway`** (`packages/gateway/`) — a Discord-first daemon that listens for `@fro-bot` mentions in bound guild channels and runs OpenCode inside a sandboxed workspace container. Includes an operator web surface (Hono, gateway-net only), an inbound announce webhook, and an S3-backed coordination layer. The `/fro-bot dispatch` slash command is a separate, simpler path: it asks the bound repo's `fro-bot.yaml` workflow to run via the GitHub Actions API and returns the run URL — it never touches the gateway's queue, concurrency cap, or run-state.
- **`@fro.bot/harness`** (`packages/harness/`) — a patched OpenCode binary built via an LLM-merge integration pipeline. Published to npm and GitHub Releases; the Action setup phase downloads the checksum-verified release tarball (not the npm package) as the default OpenCode binary, and reuses an existing `opencode` only when it reports exactly the pinned version. The npm package ships `harness` and `opencode` commands (see [`packages/harness/README.md`](packages/harness/README.md)).

Supporting packages: `@fro-bot/runtime` (`packages/runtime/`) owns shared runtime primitives and version-pin constants; `@fro-bot/action` (`apps/action/`) is a thin workspace wrapper whose build produces the committed root `dist/`; `@fro-bot/workspace-agent` (`apps/workspace-agent/`) is the Hono HTTP sidecar inside the workspace container.

## Codemap

Symbols verified against the live source tree. Where a symbol has moved to `packages/runtime/`, the canonical location is noted. Per-directory `AGENTS.md` files list the finer-grained helpers; unabridged rows are in [Architecture Overview](docs/wiki/Architecture%20Overview.md#codemap-reference).

### Action / Root `src/`

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `run` | Function | `src/harness/run.ts` | Main entry, phase orchestration |
| `runPost` | Function | `src/harness/post.ts` | Post-action cache save |
| `runSetup` | Function | `src/services/setup/setup.ts` | Setup orchestration |
| `buildCIConfig` | Function | `src/services/setup/ci-config.ts` | CI config assembly with plugin injection |
| `writeSystematicConfig` | Function | `src/services/setup/systematic-config.ts` | Systematic plugin config writer |
| `installSystematicPlugin` | Function | `src/services/setup/systematic-plugin.ts` | Setup-time Systematic install |
| `restoreCache` | Function | `src/services/cache/restore.ts` | Restore OpenCode state |
| `saveCache` | Function | `src/services/cache/save.ts` | Persist state; returns a `CacheSaveResult` |
| `toCacheSaveStateValue` | Function | `src/shared/cache-save-result.ts` | `CacheSaveResult` → `CACHE_SAVED` value |
| `checkpointDatabase` | Function | `src/services/cache/checkpoint.ts` | Merge SQLite WAL into the main DB |
| `executeOpenCode` | Function | `src/features/agent/execution.ts` | SDK execution orchestration |
| `runDrain` | Function | `src/harness/phases/execute.ts` | Drain phase for owned background work |
| `normalizeEvent` / `parseGitHubContext` | Function | `src/services/github/context.ts` | Raw payload → `NormalizedEvent`; global context → `GitHubContext` |
| `routeEvent` | Function | `src/features/triggers/router.ts` | Event routing |
| `postComment` | Function | `src/features/comments/writer.ts` | Create or update comment |
| `submitReview` | Function | `src/features/reviews/reviewer.ts` | Submit PR review |
| `parseActionInputs` | Function | `src/harness/config/inputs.ts` | Parse/validate inputs |
| `createLogger` | Function | `src/shared/logger.ts` | Logger with redaction |
| `ActionInputs` | Interface | `src/shared/types.ts` | Input schema |
| `NormalizedEvent` | Union | `src/services/github/types.ts` | 8-variant event union |
| `TriggerResult` | Interface | `src/features/triggers/types.ts` | Routing decision |

### `packages/runtime/` (canonical prompt + agent primitives)

`src/features/agent/prompt.ts` re-exports from `@fro-bot/runtime`; the implementations live here.

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `buildAgentPrompt` / `buildAgentContextSection` | Function | `packages/runtime/src/agent/prompt.ts` | XML-tagged prompt with authority hierarchy |
| `buildHarnessRulesSection` | Function | `packages/runtime/src/agent/prompt-thread.ts` | Non-negotiable harness rules |
| `sendPromptToSession` | Function | `src/features/agent/prompt-sender.ts` | Send prompt to SDK session |
| `runPromptAttempt` | Function | `src/features/agent/retry.ts` | Prompt with retry logic |
| `pollForSessionCompletion` | Function | `src/features/agent/session-poll.ts` | Poll SDK for completion |
| `processEventStream` | Function | `src/features/agent/streaming.ts` | Process SDK event stream |
| `bootstrapOpenCodeServer` | Function | `packages/runtime/src/agent/server.ts` (delegate: `src/features/agent/server-adapter.ts`) | SDK server lifecycle |
| `createLeaseLoop` | Function | `packages/runtime/src/coordination/lease-loop.ts` | Shared lock-lease renewal loop (Action and gateway) |
| `createOwnershipLedger` | Function | `packages/runtime/src/agent/ownership-ledger.ts` | Background subagent ownership ledger |
| `reconcileLedgerOnce` / `createLedgerReconciler` | Function | `packages/runtime/src/agent/ledger-reconcile.ts` | Settle dropped ledger entries |
| `createRemoteQuestionClient` | Function | `packages/runtime/src/agent/remote-question-client.ts` | v2-SDK `question` reply/reject client |
| `TriggerDirective` | Interface | `packages/runtime/src/agent/prompt.ts` | Directive + appendMode for triggers |
| `DEFAULT_SYSTEMATIC_VERSION` | Constant | `packages/runtime/src/shared/constants.ts` | Pinned Systematic version |
| `DEFAULT_OPENCODE_VERSION` | Constant | `packages/runtime/src/shared/constants.ts` | Pinned harness build version |

### `packages/gateway/`

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `runMention` / `launchWork` | Function | `packages/gateway/src/execute/run.ts` | Mention lifecycle; fire-and-return web launch |
| `buildDiscordPrompt` | Function | `packages/gateway/src/execute/prompt.ts` | Discord prompt builder |
| `buildOperatorApp` | Function | `packages/gateway/src/web/server.ts` | Operator Hono app factory |
| `createWorkflowDispatcher` | Function | `packages/gateway/src/github/dispatch.ts` | `/fro-bot dispatch` workflow-dispatch adapter |
| `createDiscordApprovalOnPending` | Function | `packages/gateway/src/approvals/discord-transport.ts` | Discord approval transport |
| `createRequestGate` | Function | `packages/gateway/src/approvals/request-gate.ts` | Shared approval/question settlement gate |
| `createQuestionRegistry` | Function | `packages/gateway/src/approvals/question-registry.ts` | Question family of the gate |
| `createQuestionCoordinator` | Function | `packages/gateway/src/approvals/question-coordinator.ts` | Per-run `question.*` event seam |
| `createDiscordQuestionOnRegistered` | Function | `packages/gateway/src/approvals/discord-question-transport.ts` | Discord question transport |
| `buildPendingQuestionsRoute` / `buildQuestionDecisionRoute` | Function | `packages/gateway/src/web/operator/{pending-questions-route,question-decision-route}.ts` | Question list and answer/skip routes |
| `recoverStaleRuns` | Function | `packages/gateway/src/execute/recovery.ts` | Stale-run sweeps |
| `classifyInspectResult` | Function | `packages/gateway/src/execute/provenance.ts` | `inspect()` → failure or `CheckoutProvenance` |
| `parseOperatorCheckoutProvenance` | Function | `packages/gateway/src/operator-contract/provenance.ts` | Persisted provenance → operator DTO |
| `inspectCheckout` | Function | `apps/workspace-agent/src/inspect.ts` | `POST /inspect` read-only checkout report |
| `executeClone` | Function | `apps/workspace-agent/src/clone.ts` | `POST /clone` via root staging + handoff |
| `executeUpdate` | Function | `apps/workspace-agent/src/update.ts` | `POST /update` journaled fast-forward |
| `previewRecovery` / `executeRecovery` | Function | `apps/workspace-agent/src/recover.ts` | `POST /recover/preview` and `/recover` |
| `listBackups` / `deleteBackup` | Function | `apps/workspace-agent/src/backups.ts` | `/backups/:owner/:repo[/:id]` handlers |
| `buildOpencodeLaunchSpec` | Function | `apps/workspace-agent/src/opencode-server.ts` | Single OpenCode launch spec (agent uid, allowlisted env) |
| `gitInvocation` | Function | `apps/workspace-agent/src/git-safety.ts` | Neutralized credential-free git invocation |
| `createApp` | Function | `apps/workspace-agent/src/server.ts` | Control-API Hono app; required `auth` union |
| `withRepoLock` | Function | `apps/workspace-agent/src/repo-mutex.ts` | Per-repo mutation mutex and maintenance hold |
| `createRecoverCheckoutCommand` / `createCheckoutBackupCommand` | Function | `packages/gateway/src/discord/commands/{recover-checkout,checkout-backup}.ts` | `/fro-bot recover-checkout` and `checkout-backup` |
| `OPERATOR_CONTRACT_VERSION` | Constant | `packages/gateway/src/operator-contract/version.ts` | Pinned operator contract version (`1.13.0`) |
| `resolveClient` / `parseCanonicalAddress` | Function | `packages/gateway/src/web/ingress/{resolve-client,canonical-address}.ts` | Trusted-proxy-aware client address; strict IP parser |
| `createPushHealthTracker` / `observePushAdapterHealth` | Function | `packages/gateway/src/web/operator-push/{push-health,push-health-adapter}.ts` | Passive operator push health |

## Invariants

These are CI-enforced constraints. Violating any of them breaks the build or the system contract.

1. **4-layer import rule.** The root `src/` tree is strictly layered: `shared/` → `services/` → `features/` → `harness/`. Each layer may only import from layers below it. Cross-layer imports in the wrong direction are a type error and a lint error.
2. **Committed `dist/` must stay in sync.** CI runs `bun run build` and fails if `git diff dist/` shows changes. The pre-push hook enforces the same check locally. Never edit `dist/` by hand.
3. **Strict booleans.** No implicit falsy checks (`!value`). Use explicit comparisons (`=== null`, `=== undefined`, `.length === 0`). Enforced by ESLint.
4. **Functions only — no classes for stateful patterns.** Closures, not ES6 classes, carry state across the codebase (the only classes are a handful of `Error` subclasses in the gateway). Enforced by convention and code review.
5. **Exactly one comment or review per invocation (Response Protocol).** Exactly one GitHub comment or PR review is delivered per Action run. For `pull_request`/`issue_comment`/`issues` triggers this is **action-enforced**: the model writes its response to a run-scoped file and the harness posts it once via the Octokit writers, binding the target and surface to the trusted event (the response file cannot select its own). For `workflow_dispatch`/`schedule` the model still self-posts via `gh`, and the one-response rule remains prompt-enforced in `buildHarnessRulesSection()`.
6. **`NormalizedEvent` is never bypassed.** All webhook payloads must pass through `normalizeEvent()` before routing. The router never reads `context.payload` directly. Raw event access is an anti-pattern caught in code review.
7. **No type suppression.** `as any`, `@ts-ignore`, and `@ts-expect-error` are forbidden project-wide.
8. **Redaction-before-query (gateway operator surface).** On operator-web routes, the denylist check runs after the server-owned binding lookup (the predicate consumes the binding's deny keys) and before any run-state read or GitHub API call. Repo access is bindings-only: a repo is reachable when it is bound and not denylisted, with no GitHub-rights check. A repo redacted in `metadata/repos.yaml` is never queried and never reaches the audit stream. Cold-start failure → deny all (fail-closed). Discord surfaces do not currently consult the denylist post-binding.
9. **Client identity is never guessed, and derived accounting keys never stand in for exact identity (gateway ingress).** The client behind every public operator-surface request is a `ResolvedClientAddress` returned by `resolveClient()` (`packages/gateway/src/web/ingress/resolve-client.ts`) against the configured `OperatorIngressPolicy`. Trust and binding decisions (configured-peer equality, the OAuth `boundAddress`) use only its exact canonical identity (`.canonical`); the derived `.accountingKey` (IPv6 → /64, IPv4 → /32) only counts or buckets traffic (rate-limit buckets, the OAuth outstanding-attempt slot), and aggregation happens after `resolveClient`, never in `canonical-address.ts`. An unresolvable request rejects before any bucket or state entry is allocated — it is never collapsed onto a shared fallback key. `GATEWAY_OPERATOR_TRUSTED_PROXIES` is required whenever the operator surface is enabled (see Operator Ingress Trust Policy below).

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
        ├─→ routing phase
        │     parseGitHubContext → normalizeEvent → routeEvent (TriggerResult; skip if no match)
        ├─→ dedup phase
        │     skip if the agent already ran for this PR/issue within the dedup window
        ├─→ coordination-lock phase
        │     per-repo Action lock (`action.json`) when S3 is enabled; fail closed on lock error
        ├─→ acknowledge phase
        │     acknowledgeReceipt (reaction + comment stub)
        ├─→ cache-restore phase
        │     S3 first → Actions cache; repair the restored SQLite database (WAL checkpoint or
        │     clean slate); bootstrapOpenCodeServer probes instance-scoped readiness
        ├─→ session-prep phase
        │     processAttachments → buildAgentPrompt (packages/runtime)
        ├─→ execute phase
        │     executeOpenCode → sendPromptToSession → runPromptAttempt → processEventStream (SSE)
        │     (permission asks auto-denied; `question` tool never offered; adopted background
        │      children tracked by a per-invocation OwnershipLedger)
        ├─→ drain phase
        │     runDrain: owned background work settles before anything below publishes,
        │     persists, or releases (bounded by the run's deadline)
        ├─→ review-reconciliation phase
        │     reconcile formal review state after agent execution
        ├─→ finalize phase
        │     set outputs → writeJobSummary → deliver the response contract (review-required,
        │     review-permitted, or comment-only from trusted routing context)
        └─→ cleanup phase
              prune sessions → shutdown server → sync artifacts → saveCache (declined as
              `ownership-declined` when a live writer cannot be ruled out) → CACHE_SAVED state
              → release lock in finally

post.ts (separate Action step)
  └─→ harness/post.ts (runPost)
        └─→ saveCache retry unless CACHE_SAVED is durable/store-only/skipped/declined-for-safety
```

> See also: [Execution Lifecycle](docs/wiki/Execution%20Lifecycle.md#annotated-action-phase-pipeline)

### 2. Gateway Mention-Loop

Triggered by an `@fro-bot` mention in a Discord guild channel bound to a repo.

```
Discord messageCreate event
  └─→ packages/gateway/src/discord/mentions.ts
        │
        ├─→ thread guard (skip if already in a thread)
        ├─→ authorization gate (REST member fetch, role or ManageChannels; fail closed)
        ├─→ binding lookup (S3 object-store index → RepoBinding)
        └─→ runMention (packages/gateway/src/execute/run.ts)
              │
              ├─→ concurrency cap + per-channel FIFO queue → thread creation on source message
              ├─→ S3 conditional-write lock (coordination/lock.ts; the lease loop renews the lease)
              ├─→ checkout preparation (under the repo lock, before EXECUTING)
              │     POST /update (clone only on `no-checkout`) → CheckoutProvenance persisted
              │     with EXECUTING; refused/failed ends the run with a CheckoutPreparation reply
              │     (a `dirty` refusal first tries one automatic recovery, then updates again)
              ├─→ run-state lifecycle: PENDING → ACKNOWLEDGED → EXECUTING
              ├─→ execute/run-core.ts
              │     buildDiscordPrompt → OpenCode (workspace:9200, bearer auth)
              │     → SSE event stream → discord/streaming.ts → thread reply
              ├─→ background dispatch observation: completed `task` with
              │     state.metadata.background === true → ledger.adopt + coordinator.addOwnedSession
              ├─→ tool approval (root or adopted descendant)
              │     permission.asked → Discord embed (Approve/Deny) → approval registry; a terminal
              │     Discord delivery failure auto-denies on the server
              ├─→ agent question (root or adopted descendant)
              │     question.asked → question registry (deadline from the budget left) → web SSE
              │     frame or Discord prompt → answer/skip, or deadline skip with an empty reply
              │     (pending approvals and questions pause the inactivity watchdog)
              └─→ completion
                    root session.idle with an adopted dispatch → drain (ledger settlement, child
                    notices, root freshness); provenance line appended to the final reply
                    run → COMPLETED; heartbeat stop; lock release
                    on failure → FAILED; coarse error reply to thread
```

> See also: [Architecture Overview](docs/wiki/Architecture%20Overview.md#annotated-data-flow) · [Operator Web Control Surface](docs/wiki/Operator%20Web%20Control%20Surface.md)

### 3. Harness Release Pipeline

Triggered by `workflow_dispatch` or a push of a `harness-v*` tag on `.github/workflows/harness-release.yaml`.

```
harness-release.yaml (workflow_dispatch OR push: harness-v* tag)
  │
  ├─→ prepare-integrate job
  │     resolve base_version → render prompt from packages/harness/prompt.txt
  ├─→ integrate job (skipped when has_refs == 'false')
  │     .github/workflows/fro-bot.yaml agent: clone anomalyco/opencode → merge configured refs
  │     (harness.config.json carry policy) → build + verify → push refs/harness-integrate/<version>
  ├─→ build matrix (linux-x64, linux-arm64, darwin-x64, darwin-arm64)
  │     fetch the integration ref (or stock tag) → build-platform.ts → emit integration_commit
  └─→ publish job (all-or-nothing; requires build + release-binaries success)
        OIDC trusted publishing (id-token: write, publish job only)
        → npm publish @fro.bot/harness + 4 per-platform packages
        → GitHub Release (OpenCode-shaped assets + SHA256SUMS)
```

> See also: [Architecture Overview](docs/wiki/Architecture%20Overview.md#annotated-data-flow)

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

`checkpointDatabase` (`src/services/cache/checkpoint.ts`) merges the session database's write-ahead log into `opencode.db` in `saveCache` (`src/services/cache/save.ts`) and again in `runCacheRestore` (`src/harness/phases/cache-restore.ts`), so a poisoned newest cache entry heals in place.

- Success is judged by the WAL's on-disk size, never the pragma's `checkpointed` count. Only `opencode.db` crosses either transport (`DB_TRANSPORTABLE_BASENAMES`, `buildCachePaths`).
- The server must be quiescent first: `OpenCodeServerHandle.shutdown()` (`packages/runtime/src/agent/server.ts`) polls the port until refused, and `cleanup.ts` awaits it before saving.
- `src/services/cache/integrity.ts` and `sqlite-errors.ts` wipe session history only on a positively classified corruption.

> See also: [Session Persistence](docs/wiki/Session%20Persistence.md#sqlite-wal-checkpoint-repair-cache-bootstrap-trap)

### Cache Save Result Contract

`saveCache` returns a `CacheSaveResult` (`src/shared/cache-save-result.ts`), never a boolean: independent `cachePersisted` / `storePersisted` axes plus a named `CacheSaveOutcome`, mapped by `toCacheSaveStateValue` through a `satisfies Record<CacheSaveOutcome, ...>` table so an unmapped outcome fails `check-types`.

- `cache-rejected` is an inference (`@actions/cache`'s `-1` hides the cause); never derive the cause from trigger or runner config.
- `ownership-declined` maps to `declined-for-safety`, never `not-persisted`: `src/harness/post.ts` retries only `not-persisted`, and unknown state values fail toward retry.
- `runCleanup` (`src/harness/phases/cleanup.ts`) writes the value to `STATE_KEYS.CACHE_SAVED`, the `cache-save-result` output, and a job-summary row.

> See also: [Session Persistence](docs/wiki/Session%20Persistence.md#cache-save-result-contract)

### Invocation Identity (job-qualified keys)

`getInvocationIdentity` (`packages/runtime/src/shared/invocation-identity.ts`) adds the job-level component that `GITHUB_RUN_ID` + `GITHUB_RUN_ATTEMPT` lack: sanitized `GITHUB_JOB`, plus `-m<8 hex>` for a matrix leg. It is deterministic and derived from env, never handed off through state.

- The cache save key (`buildSaveCacheKey`) and the log artifact name carry it after `runId-runAttempt`; schedule/dispatch session keys (`buildLogicalKey`, `packages/runtime/src/session/logical-key.ts`) carry it after the run ID only, so a rerun resumes the same session.
- Entity-bound keys (`issue-{n}`, `pr-{n}`, `discussion-{n}`) stay unqualified; logical keys stay run-scoped, not attempt-scoped.

> See also: [Session Persistence](docs/wiki/Session%20Persistence.md#invocation-identity-job-qualified-keys)

### S3 Conditional-Write Locks (Gateway `repo.json`, Action `action.json`)

Per-repo S3 conditional-write locks (`If-None-Match` / `If-Match`) built by `getLockKey` (`packages/runtime/src/coordination/lock.ts`): gateway runs exclude each other on `locks/repo.json`, Action runs on `locks/action.json`; the surfaces do not exclude each other. The Action side is `src/harness/phases/acquire-lock.ts` (15-minute TTL), released in `cleanup.ts`. Both surfaces renew through one runtime `createLeaseLoop` (`packages/runtime/src/coordination/lease-loop.ts`): scheduling, a 10 s tick timeout with request abort, a shared 5 s stop budget, the freshest confirmed lock ETag and the failure state. Each surface injects its renewal and tick body and keeps its own takeover policy; the gateway heartbeat (`heartbeat.ts`) layers RunState on it. A renewal S3 committed but the caller lost (timed out, aborted or errored) is recovered by adoption at the next failed tick and at stop: the loop takes the stored ETag only if the record is this acquisition's own. Action: `holder_id`, `holder_job` and `acquisition_token`; gateway: `holder_id`, `run_id` and `acquisition_token`. A token-less record is never adopted. The gateway's release also retries once by ownership (`releaseLockIfHolder`, within a 5 s budget) when its ETag release 412s. The holder id stays `action:<runId>:<attempt>` (older agent versions match exactly that shape), and the job identity rides in the record's optional `holder_job` field. A cancelled or killed main step leaves the lock behind, so the main step records its holder id, job and a random per-acquisition `acquisition_token` (`lockHolderId` / `lockHolderJob` / `lockAcquisitionToken` state; if the write fails the lock is released and the run fails closed) and the post hook (`post.ts`) deletes the lock, with an aborting deadline, only while all three still match (holder fields alone can repeat across two calls of one reusable workflow). A later attempt of the same run and job also takes over an earlier attempt's unexpired lease once it has gone 3 heartbeat intervals (~90s) without a renewal (same `If-Match` ETag precondition); a renewing holder, a record without `holder_job`, another job or another run waits for the 15-minute TTL.

- With S3 configured, a lock error fails the Action closed; a contended Action exits 0 as `skipped`; a run without the lock never persists session state.
- Gateway takeover of an expired lease needs a `ConfirmExpiredHolder` `clear` result, corroborated via `packages/gateway/src/execute/repo-quiescence.ts`; this is snapshot corroboration, not fencing. The Action reclaims an expired lease without corroboration only when the holder is an Action holder (`action:{runId}:{attempt}`), via `reclaimableWithoutConfirmation`.

> See also: [Execution Lifecycle](docs/wiki/Execution%20Lifecycle.md#s3-conditional-write-locks-gateway-repojson-action-actionjson)

### Background Subagent Ownership Ledger (Gateway)

`runMention` creates a per-run `OwnershipLedger` (`packages/runtime/src/agent/ownership-ledger.ts`) for `runOpenCodeCore` (`packages/gateway/src/execute/run-core.ts`), keyed on child session id (never job id). Entries are `outstanding`, `settled`, or `unknown`, and `unknown` blocks both `isDrainComplete()` and `isPersistenceSafe()`.

- Root `session.idle` with a non-empty ledger enters drain. The drain-completion gate (`execute/drain-completion.ts`) requires each child's notice, current-generation root idle, and a REST-confirmed terminal root reply. Reconciliation settles tracked entries only; it never adopts.
- Teardown settles through `settleOwnedSessions`; an unconfirmed root or child means `quarantined` (held lock, no slot hand-off).
- `deploy/plugins/no-task-reuse.mjs` rejects any `task` call with a non-empty `task_id`, so each background job has its own child session.

> See also: [Background Subagents and Ownership](docs/wiki/Background%20Subagents%20and%20Ownership.md#background-subagent-ownership-ledger-gateway)

### Background Subagent Ownership Ledger (Action)

`runExecute` (`src/harness/phases/execute.ts`) creates one `OwnershipLedger` per invocation and threads it to `processEventStream` (`src/features/agent/streaming.ts`). Settlement comes only from the injected `<task id state>` notice on the root session; a descendant's `session.idle` / `session.error` never ends the root's turn.

- `runDrain` runs between execute and review reconciliation: reconcile, poll `isDrainComplete()` to the shared deadline, then abort whatever is not `settled`. `runCleanup` consumes `isPersistenceSafe()` (`ownership-declined`).
- `buildCIConfig` (`src/services/setup/ci-config.ts`) pins `subagent_depth` to `1` in every mode, overriding operator values with a warning.
- The `task_id` reuse guard (`deploy/plugins/no-task-reuse.mjs`, built into committed `dist/no-task-reuse.js`) is loaded by `bootstrapOpenCodeServer` (`src/features/agent/server-adapter.ts`) before every server start.

> See also: [Background Subagents and Ownership](docs/wiki/Background%20Subagents%20and%20Ownership.md#background-subagent-ownership-ledger-action)

### Generation-Scoped Completion Evidence (Action)

Idle evidence in `pollForSessionCompletionObservation` (`src/features/agent/session-poll.ts`) is scoped to a generation, not a sticky flag: `ActivityTracker.rootFreshness` (`src/features/agent/streaming.ts`) carries a `revision` advanced only by `invalidateRootFreshness()` on ROOT-session activity, and `hasFreshIdleCandidate()` holds only while the stamped revision is current and no `pendingParentMessageId` barrier is set.

- The idle candidate is not the only gate: the qualified-message path (`detectMessageActivity`) and `ledgerBlocksCompletion()` guard every admission point.
- A provisional observation never releases a guard or authorizes completion; unavailable evidence reaches the watchdog or deadline, never a guessed success.

> See also: [Background Subagents and Ownership](docs/wiki/Background%20Subagents%20and%20Ownership.md#generation-scoped-completion-evidence-action)

### Approval Denial on Undeliverable Discord Notification

`createDiscordApprovalOnPending` (`packages/gateway/src/approvals/discord-transport.ts`) posts the approval embed. A TERMINAL Discord failure (`UnknownChannel` / `MissingAccess`, matched on `DiscordAPIError.code`, never message text) makes `handleUndeliverable` deny server-side via `approvalRegistry.applySettlement`, rather than wait out the budget. Retryable failures leave the entry open. The denial is deliberately visible: logged at `error` with a distinct thread note.

> See also: [Operator Web Control Surface](docs/wiki/Operator%20Web%20Control%20Surface.md#approval-denial-on-undeliverable-discord-notification)

### Agent Questions (Gateway)

`question.asked` from the root session or an adopted background child is a second family of human wait next to tool approvals; asks from sessions the run does not own are ignored. `createRequestGate` (`packages/gateway/src/approvals/request-gate.ts`) is the single settlement path for both families: one-winner `open → claimed → confirmed` states, a registry-owned deadline, authoritative echo settlement, and exactly one terminal notification per request.

- Skip and deadline reply with an empty answer (the agent continues); reject is for cancel, teardown, and malformed or oversize asks only.
- `run-core.ts` pauses the inactivity watchdog while any human wait is pending; the gauge never influences drain.
- Question and answer text is untrusted plain text: bounded and control-stripped (`approvals/question-detail.ts`), rendered inert, never logged. Options are named by index, never label.

> See also: [Operator Web Control Surface](docs/wiki/Operator%20Web%20Control%20Surface.md#agent-questions-gateway)

### Checkout Provenance (Gateway + Workspace)

Gateway runs share one checkout per repository and record what they started from. Under the repo lock and before `EXECUTING`, `launchWork` / `runMention` (`packages/gateway/src/execute/run.ts`) call `update()` (`POST /update`, `apps/workspace-agent/src/update.ts`) first; `ensureClone` runs only on `no-checkout`.

- Refused or failed updates end the run before `EXECUTING` as `checkoutPreparation` (`execute/provenance.ts`, `preparation-reply.ts`); a `ready` result becomes `CheckoutProvenance`, rendered as a code-written "started from" line, never model-written.
- `/inspect` (`apps/workspace-agent/src/inspect.ts`) treats the checkout as hostile input: git runs as the agent uid and fails closed.
- Checkout types are duplicated across `apps/workspace-agent` and `packages/gateway`, pinned by `scripts/checkout-types-drift-guard.test.ts`.

> See also: [Operator Web Control Surface](docs/wiki/Operator%20Web%20Control%20Surface.md#checkout-provenance-gateway--workspace)

### OpenCode File Watcher Disabled By Default

Neither surface consumes file-change events, so `bootstrapOpenCodeServer` (`packages/runtime/src/agent/server.ts`) sets `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true` before spawn, only when the value is unset or empty, so an explicit operator value (including `false`) wins. `deploy/workspace.Dockerfile` bakes the same default. Accepted tradeoff: OpenCode's cached VCS branch can go stale after a checkout.

> See also: [Background Subagents and Ownership](docs/wiki/Background%20Subagents%20and%20Ownership.md#opencode-file-watcher-disabled-by-default)

### OpenCode Question Tool Disabled (Action)

Nobody can answer an interactive `question` in CI, so `bootstrapOpenCodeServer` (`pinQuestionToolOff`, `packages/runtime/src/agent/server.ts`) pins `OPENCODE_CLIENT=fro-bot-action` and deletes `OPENCODE_ENABLE_QUESTION_TOOL` before spawn; upstream then never registers the tool. Unlike the watcher default, an operator value does **not** win (overridden with a warning). The gateway keeps the tool.

> See also: [Setup and Configuration](docs/wiki/Setup%20and%20Configuration.md#opencode-question-tool-disabled-action)

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

The workspace-agent **service** (`apps/workspace-agent/src/main.ts`) stays root with a reduced capability set (`deploy/compose.yaml`); **OpenCode and everything it spawns** run as the unprivileged `opencode` account (uid/gid `10001`). `apps/workspace-agent/src/identity.ts` is the single source for ids, homes, and state directory names; `deploy/workspace.Dockerfile` must match.

- OpenCode spawns only through `buildOpencodeLaunchSpec` (`opencode-server.ts`): absolute path, agent uid, allowlist-built environment.
- Clone, update, and recovery run in root-owned staging, serialize per repository (`repo-mutex.ts`, sticky `maintenance-hold`), and journal root-owned (`journal.ts`).
- The `:9100` control API requires the `WORKSPACE_OPENCODE_TOKEN` bearer (`createApp`).
- Kernel boundaries are verified by `deploy/tests/isolation-harness.sh` and `deploy/validate-stack.sh`, not unit tests.

> See also: [Setup and Configuration](docs/wiki/Setup%20and%20Configuration.md#workspace-uid-isolation-service-vs-agent)

### Operator Ingress Trust Policy (Gateway)

`packages/gateway/src/web/ingress/` decides which address on an operator request is the client behind the TLS proxy. One explicit `OperatorIngressPolicy` (`policy.ts`) is `direct` or `trusted-proxy` with a non-empty tuple of **exact** peers from `GATEWAY_OPERATOR_TRUSTED_PROXIES` (`packages/gateway/src/config.ts`); invalid values fail at startup.

- `resolveClient` (`resolve-client.ts`) is the only intended producer of `ResolvedClientAddress`: an untrusted socket wins and `X-Forwarded-For` is ignored; for a trusted peer the strictly parsed chain is walked from the socket end to the first untrusted address, and malformed or all-trusted chains reject.
- Abuse accounting uses the derived `accountingKey` (IPv6 /64, IPv4 /32); the OAuth state keeps the exact `boundAddress`.

> See also: [Operator Web Control Surface](docs/wiki/Operator%20Web%20Control%20Surface.md#operator-ingress-trust-policy-gateway)

### Effect / Result Boundary (Gateway)

`packages/gateway/` is the only package in the monorepo that uses `effect`. The Action and `packages/runtime/` stay on hand-rolled `Result<T, E>` from `@bfra.me/es`. The boundary adapter is `packages/gateway/src/runtime-effect.ts`, which wraps every `@fro-bot/runtime` function the gateway uses. All gateway code outside that file works exclusively in `Effect.Effect<A, E, R>`.

### Systematic Plugin Install (Setup-Time, Not Server-Boot)

`installSystematicPlugin` (`src/services/setup/systematic-plugin.ts`) runs the OpenCode CLI's `plugin` command during setup on a tools-cache miss, before `saveToolsCache`, so a degraded npm registry never stalls server boot. It is bounded (420 s) and non-fatal (the server's own install is the fallback, and `saveToolsCache` is skipped), runs with a `filterAgentEnv`-scrubbed environment, and uses a throwaway `OPENCODE_DB` so it never leaves a WAL beside the real session database.

> See also: [Setup and Configuration](docs/wiki/Setup%20and%20Configuration.md#systematic-plugin-install-setup-time-not-server-boot)
