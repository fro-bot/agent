---
type: architecture
last-updated: "2026-10-11"
updated-by: "18890129"
sources:
  - src/main.ts
  - src/post.ts
  - src/harness/run.ts
  - src/harness/outcome.ts
  - src/harness/post.ts
  - packages/runtime/src/agent/ownership-ledger.ts
  - packages/runtime/src/agent/ledger-reconcile.ts
  - packages/runtime/src/coordination/run-state.ts
  - packages/gateway/src/execute/run-core.ts
  - packages/gateway/src/execute/settle-owned-sessions.ts
  - packages/gateway/src/execute/recovery.ts
  - src/harness/config/state-keys.ts
  - src/services/cache/save.ts
  - src/shared/cache-save-result.ts
  - packages/runtime/src/index.ts
  - packages/runtime/src/coordination/types.ts
  - packages/harness/src/cli.ts
  - packages/harness/src/integrate.ts
  - packages/gateway/src/main.ts
  - packages/gateway/src/execute/run.ts
  - packages/gateway/src/http/server.ts
  - packages/gateway/src/discord/commands/dispatch.ts
  - packages/gateway/src/discord/commands/fro-bot.ts
  - packages/gateway/src/github/dispatch.ts
  - packages/gateway/src/github/app-client.ts
  - packages/gateway/src/web/server.ts
  - packages/gateway/src/web/ingress/resolve-client.ts
  - packages/gateway/src/approvals/coordinator.ts
  - packages/gateway/src/approvals/request-gate.ts
  - packages/gateway/src/approvals/question-registry.ts
  - packages/runtime/src/agent/remote-client.ts
  - packages/runtime/src/agent/filter-env.ts
  - packages/runtime/src/agent/with-scrubbed-env.ts
  - packages/runtime/src/agent/error-format/types.ts
  - src/features/triggers/skip-conditions-pr.ts
  - src/features/delegated/brokered-push.ts
  - scripts/harness/mint-app-token.ts
  - .github/workflows/harness-integrate.yaml
  - packages/harness/harness.config.json
  - apps/workspace-agent/src/main.ts
  - apps/workspace-agent/src/server.ts
  - apps/workspace-agent/src/opencode-server.ts
  - apps/workspace-agent/src/update.ts
  - apps/workspace-agent/src/recover.ts
  - apps/workspace-agent/src/journal.ts
  - apps/workspace-agent/src/handoff.ts
  - packages/gateway/src/workspace-api/client.ts
  - AGENTS.md
  - action.yaml
  - bunfig.toml
  - ARCHITECTURE.md
  - vitest.config.ts
  - scripts/vitest-home-isolation.ts
  - scripts/vitest-incomplete-run-reporter.ts
summary: "Monorepo structure, module map, and the boundary between gateway execution and workspace checkout management"
---

# Architecture Overview

Fro Bot Agent is a GitHub Action that runs an AI coding agent (OpenCode, optionally with Oh My OpenAgent) inside GitHub Actions workflows and preserves the agent's session state across CI runs via GitHub Actions cache when the trigger permits cache writes, and via an S3-compatible object store; `issue_comment` and `issues` runs cannot write the cache and depend on the object store for continuity. The codebase is TypeScript, ESM-only, targeting Node 24.

## Monorepo Structure

The project is organized as a Bun workspace monorepo with two workspace areas:

| Package | Path | Purpose |
| --- | --- | --- |
| `@fro-bot/runtime` | `packages/runtime/` | Shared runtime library: agent prompt, session management, object store, coordination primitives, and shared utilities. Consumed by both the Action and the Gateway. |
| `@fro.bot/harness` | `packages/harness/` | Published, patched OpenCode binary built via LLM-merge integration. Acts as a drop-in replacement for the stock OpenCode CLI in the action setup. Ships as a main package plus per-platform binary packages (`@fro.bot/harness-linux-x64`, etc.). |
| `@fro-bot/gateway` | `packages/gateway/` | Discord gateway daemon. Listens for Discord mentions and slash commands, acquires the per-repo gateway lock (`repo.json`), and dispatches agent runs via the runtime. Built with Effect for typed error handling and structured concurrency. |
| Action root | `src/` + `apps/action/` | The GitHub Action itself. Contains the harness (orchestration phases), features (triggers, comments, reviews, observability), and service adapters (GitHub API, cache, setup). Imports `@fro-bot/runtime` for core logic. |
| workspace-agent | `apps/workspace-agent/` | Sandboxed Hono HTTP service alongside the gateway. It clones, inspects, updates, and recovers checkouts in the workspace container; hosts an unprivileged OpenCode process behind a bearer-token proxy; and exposes health/readiness probes. |

The `apps/action/` directory holds the thinnest possible entry points — `main.ts` and `post.ts` — which simply re-export from `src/main.ts` and `src/post.ts`. The split exists to support multiple surfaces (the Discord gateway and workspace-agent are now live) that share the runtime package but have their own entry points.

## Layered Architecture (Action)

Within the action (`src/`), the source tree follows a strict four-layer dependency hierarchy. Each layer may import only from layers below it — never sideways or upward.

| Layer | Directory | Responsibility |
| --- | --- | --- |
| 0 — Shared | `src/shared/` | Pure types, constants, utilities. Zero external dependencies beyond Node built-ins and `@actions/core`. |
| 1 — Services | `src/services/` | External adapters: GitHub API client, cache operations, environment setup. |
| 2 — Features | `src/features/` | Business logic: agent execution, event routing, comment/review posting, observability. |
| 3 — Harness | `src/harness/` | Workflow composition: the two entry points (`main.ts`, `post.ts`) and their orchestration phases. |

All layers may also import from `@fro-bot/runtime`, which is treated as a peer dependency at the same level as `src/shared/`. This layering prevents circular dependencies and keeps testability high — lower layers can be unit-tested without mocking upper ones.

## Dual Entry Points

The action defines two Node 24 entry points in `action.yaml`:

- **`dist/main.js`** — The primary execution path. Bootstraps the environment, routes the incoming GitHub event, acquires the per-repo Action lock (`action.json`; fail-closed when S3 is configured), acknowledges the request, runs the AI agent, finalizes results, and attempts a first cache save.
- **`dist/post.js`** — A post-action hook (RFC-017) that runs after the main step completes, even on failure or cancellation. Its sole job is a durable cache save so that session state survives even if the main step is killed mid-execution.

Both entry points are thin wrappers. `main.ts` delegates to `harness/run.ts`; `post.ts` delegates to `harness/post.ts`.

## Module Map

### Harness Package (`packages/harness/`)

`@fro.bot/harness` is a published, patched OpenCode binary built via the LLM-merge integration method (`cortexkit/orw`). Rather than downloading stock OpenCode, the action setup can install the harness binary, which carries a curated set of integration refs (stalled or closed upstream PRs, branch URLs) merged onto each deliberately-pinned upstream release via a one-time `opencode run` LLM merge. The produced binary is frozen: the merge runs once in CI per release bump, is reviewed as a bump PR, and the integration commit SHA is pinned before per-platform binaries are built and published.

The CLI is a drop-in replacement — all arguments pass through to the patched OpenCode binary. Own subcommands (`info`, `patches`, `doctor`) report provenance (upstream tag, integration refs, build SHA) and health. The `integrate` merge step (`integrate.ts`) runs the OpenCode merge agent in CI over prompt-injectable upstream PR content, so both of its GitHub credentials are short-lived and minted just-in-time rather than drawn from durable secrets. The merge agent's own auth is minted from an OIDC broker (`scripts/harness/mint-broker-credential.ts`), and the credential used to `git push` the merge result is a scoped GitHub App installation token — single-repo, `contents: write`-only, roughly one-hour TTL — minted inline by a trusted no-post step (`scripts/harness/mint-app-token.ts`) that validates the returned token's scope all-or-nothing and fails closed on any mismatch. Neither mint has a durable-credential fallback, and the App private key is mapped only to the mint step's environment, never to job-level env or disk. As further defense-in-depth, the harness masks the `github-token` value and scrubs the raw `INPUT_GITHUB-TOKEN` copy from the merge child's environment so the OpenCode subprocess never inherits it.

The package ships as `@fro.bot/harness` (the main resolver) plus four per-platform packages (`@fro.bot/harness-linux-x64`, `-linux-arm64`, `-darwin-x64`, `-darwin-arm64`), each containing only its native binary. The main package's `postinstall` resolver picks the host platform's binary, verifies it, and symlinks it; `OPENCODE_PATH` and a bare `opencode` on `PATH` are honored as fallbacks for local or unbuilt use. Per-platform `optionalDependencies` are injected at publish time and are not listed in the workspace `package.json`.

The dedicated integration workflow (`.github/workflows/harness-integrate.yaml`) mints the App push token **before** running the merge agent. Its private key is supplied only to that pre-agent step, so no later step reintroduces it after agent-influenced code has run. The masked token output reaches trusted finalization, not the agent's environment. A 40-minute cap on the agent step leaves headroom within the token's roughly one-hour lifetime; a push after expiry fails closed rather than minting again in the modified workspace.

### Gateway Package (`packages/gateway/`)

The Discord gateway (`@fro-bot/gateway`) is a long-running daemon that bridges Discord mentions to Fro Bot agent runs and executes those runs end-to-end against a remote OpenCode server. Key modules:

**Discord** (`discord/`) — Client lifecycle wrapper (`client.ts`), slash command registry (`commands/`), mention handler (`mentions.ts`), channel helpers (`channels.ts`), presence updates (`presence.ts`), and streaming (`streaming.ts`). The streaming module relays OpenCode event output back into the Discord thread as the run progresses. The `/fro-bot` parent command hosts subcommands built through a shared guild-command factory (`guild-command.ts`) that owns the defer → guild-guard → authorize → work → failure-reply pipeline: `ping`, `add-project` (bind a repo to a channel), `clear-queue`, and `force-release-lock`. A `dispatch` subcommand (`commands/dispatch.ts`) is deliberately different from the mention path — instead of entering the gateway's per-channel queue or acquiring a local execution slot, it only asks GitHub Actions to accept a `workflow_dispatch` for the channel's bound repository and reports back the accepted run link. That request is issued through the gateway's GitHub App client and dispatch helper (`github/app-client.ts`, `github/dispatch.ts`), so a Discord operator can kick off an autonomous Action run without the gateway itself executing it.

**Execute** (`execute/`) — The agent-execution pipeline triggered by an `@fro-bot` mention or a web launch. `run.ts` orchestrates the full run: acquires the coordination lock, creates a run-state record with heartbeat, and delegates to `run-core.ts` for session creation, prompt send, and event-stream routing. `opencode-attach.ts` connects to the remote OpenCode server, `prompt.ts` builds the Discord prompt, `concurrency.ts` enforces per-channel run limits via a serial queue (`queue.ts`), and `recovery.ts` handles interrupted runs. An in-memory abort registry (`abort-registry.ts`) plus `cancel.ts` back operator-initiated cancellation: a run registered under its `runId` can be aborted mid-flight and settles as `CANCELLED` rather than `FAILED` (see [[Operator Web Control Surface]]). `run-core.ts` also counts inbound events so a stalled run can be distinguished from a lost-event timeout. Permission events emitted by OpenCode during a run are forwarded to Discord approval buttons via the approvals subsystem.

The gateway has no separate drain stage because it does not need one: `run-core.ts` does not return until the run's ownership ledger drains and the parent's follow-up reply is confirmed, so the heartbeat stop, terminal transition, and concurrency-slot handoff in `run.ts` all happen after owned background work has settled. `settle-owned-sessions.ts` is the termination barrier every post-ledger error passes through — it aborts unsettled sessions, confirms by reconciliation rather than trusting the abort response, and re-raises the original error marked _quarantined_ when it cannot confirm. A quarantined failure holds the channel's slot for a bounded window instead of handing the workspace to the next queued run. On restart, `recovery.ts` checks the repository's OpenCode workspace status rather than persisted ownership: a busy or unconfirmable workspace blocks stale-run terminalization, and recovery never deletes coordination locks. See [[Background Subagents and Ownership]].

**Approvals** (`approvals/`) — Discord approval UI for OpenCode permission gate events. When OpenCode asks for a file-system or shell permission during a gateway run, the coordinator (`coordinator.ts`) registers the pending request and the registry (`registry.ts`) manages the entry lifecycle across all in-flight runs. A Discord button click claims the entry (preventing duplicate replies), calls back to OpenCode's reply endpoint, and the authoritative `permission.replied` event from the SDK confirms settlement. The registry is the single source of truth; the coordinator is a thin forwarder bridging the SDK event stream to the registry.

**Agent questions** (`approvals/question-registry.ts`, `question-coordinator.ts`) — the same gate, second family. When an agent calls OpenCode's `question` tool, the run's question coordinator registers the request with a mandatory deadline and announces it to the web surface (SSE `question` frame) and, for Discord-launched runs, the run thread. `request-gate.ts` is the shared lifecycle core for approvals and questions: one claim machine, scope check, deadline owner, echo settlement, teardown, and terminal notification. A skip or an expired deadline replies with an empty answer so the agent continues; reject is used only on cancel and teardown. Web operators with write access can answer any run's question; Discord answers only its own thread's. See [[Operator Web Control Surface]] for the routes and frames.

**HTTP** (`http/`) — The signed announce webhook server. Handles control-plane presence messages with HMAC signature verification (`hmac.ts`), replay protection (`replay-cache.ts`), rate limiting (`rate-limit.ts`), and schema validation (`announce-schema.ts`).

**Web** (`web/`, `operator-contract/`) — The authenticated operator web control surface: a browser-facing Hono server that lets a signed-in human launch, observe, and approve tool use within agent runs over HTTP and Server-Sent Events. It owns GitHub OAuth, server-side sessions, a numeric-user-ID allowlist, per-repo authorization, CSRF protection, the SSE observation pipeline, and a web tool-approval flow that drives the same approval registry as Discord — all speaking a frozen operator contract. Routes are mounted through a dependency-gated registration seam whose inventory is verified by an offline smoke check, so a missing dependency surfaces as a build failure rather than a silently absent endpoint. This is a second entry point into the same execution engine the Discord mention handler uses. See [[Operator Web Control Surface]].

**Workspace API** (`workspace-api/`) — Typed client for the workspace-agent's clone, inspect, update, recovery, backup, and readiness endpoints (`client.ts`, `types.ts`). Before a gateway run begins, checkout preparation calls update under the repository lock and only falls back to clone when no checkout exists. The workspace service owns the mutation, journal, and per-repository mutex; the gateway owns admission and the resulting run-state record (see [[Operator Web Control Surface]]).

**Bindings** (`bindings/`) — Channel-to-repository binding store. Maps Discord channel IDs to the GitHub repository they operate on. Backed by S3 so bindings survive restarts.

**GitHub** (`github/`) — GitHub App authentication client (`app-client.ts`). Generates short-lived installation tokens for the bound repository so the agent can make authenticated GitHub API calls on behalf of the App.

**Config / Readiness / Program / Shutdown** — Configuration loading and validation (`config.ts`), readiness lifecycle (`readiness.ts`), the top-level Effect program (`program.ts`), and graceful SIGINT/SIGTERM handling (`shutdown.ts`).

The gateway runs as a Docker container alongside sidecars: the workspace-agent, a mitmproxy allowlist proxy (egress control to Discord and GitHub hosts only), and a reverse proxy. See `deploy/` for the Compose stack definition.

### Workspace-Agent (`apps/workspace-agent/`)

The control API (`server.ts`) clones repositories (`POST /clone`), inspects checkouts (`POST /inspect`), brings eligible default-branch checkouts forward (`POST /update`), previews and performs preserve-and-replace recovery, and lists or deletes retained backups. Control routes require the gateway's bearer; health and readiness do not. A per-repo mutex serializes mutations, and root-owned journals outside the checkout record update/recovery progress so interrupted work is reconciled before another mutation. Recovery moves the old tree into quarantine before publishing a fresh checkout rather than discarding it. These boundaries let the gateway coordinate runs without manipulating the checkout itself.

The service retains root authority for protected staging, journal, and network fetch operations, but the OpenCode server and its tools run under a separate unprivileged identity. Fresh clones are staged in a root-owned directory and handed off through a symlink-safe filesystem walk; git operations against an existing agent-owned checkout run as that agent identity. See [[Setup and Configuration]] for the deployment boundary.

The OpenCode server (`opencode-server.ts`) binds to loopback only; a bearer-token proxy (`opencode-proxy.ts`) is its externally reachable surface on the sandbox network. The gateway attaches through `createRemoteOpenCodeHandle()` in the runtime package — a handle whose `close`/`shutdown` are no-ops because the gateway does not own the remote server process.

### Runtime Package (`packages/runtime/`)

The runtime package exports five module groups:

**Agent** (`agent/`) — Prompt construction, output-mode and response-delivery resolution, server bootstrapping, and reference file management (see [[Prompt Architecture]]). The runtime supplies the _primitives_ an execution needs; it no longer owns an execution orchestrator. A `refactor(agent)` pass (commit `f5b8d69`) collapsed a previously duplicated execution stack — the runtime once exported its own `executeOpenCode`, retry, and prompt-sender modules that ran in parallel with the action layer's — down to a single owning implementation in `src/features/agent/`. That layer now drives the SDK session, retry policy, and continuation prompt itself, calling the runtime for the lower-level pieces below; the retry backoff constants live beside the retry logic that consumes them rather than being declared in two places. Spawns of the OpenCode child are wrapped in a deny-by-default environment filter (`filter-env.ts` / `with-scrubbed-env.ts`) so credential-shaped variables never reach the agent process (see [[Setup and Configuration]]). Error classification lives in a dedicated `error-format/` submodule that canonically owns the `ErrorType` union and `ErrorInfo` shape (re-exported from `types.ts` for callers), so the action and gateway share failure formatting (see [[Execution Lifecycle]]). Quota exhaustion, provider authentication failures, and unresolvable models stop Action retries; classifiers project structured markers or validated identifiers into trusted diagnostics rather than echoing raw provider text. Also provides `remote-client.ts`, which wraps a remote OpenCode server as an `OpenCodeServerHandle` so the gateway can execute runs without owning the server process.

**Ownership** (`agent/ownership-ledger.ts`, `agent/ledger-reconcile.ts`) — A per-invocation, three-state ledger tracking background subagent executions the run owns, plus the reconciler that settles entries whose completion event the SSE stream never delivered. Both surfaces share it: the Action drains against it before publishing or persisting, and the gateway holds its concurrency slot against it. It is keyed on the child session id rather than the dispatch job id, because upstream reuses job ids and a job-keyed entry could be settled by a notification for a different execution. See [[Background Subagents and Ownership]].

**Session** (`session/`) — SDK-backed session storage, search, pruning, writeback, and mapper layers (see [[Session Persistence]]).

**Object Store** (`object-store/`) — S3-compatible persistence: adapter, key builder, content sync, and endpoint/key validation (see [[Session Persistence]]).

**Coordination** (`coordination/`) — S3-backed distributed lock, heartbeat controller, and run-state primitives for per-surface mutual exclusion — gateway runs on `repo.json`, Action runs on `action.json` (see [[Execution Lifecycle]]). Run state gained a details-patch primitive alongside the phase-transition helper, because the transition helper refuses a same-phase write and background ownership changes occur mid-execution, with no phase change to hang them on. It re-reads the record on every call rather than threading a caller-held etag — a caller's etag goes stale the moment the heartbeat's own read-modify-write commits — and treats a lost race as non-fatal, since the next ownership change retries with fresher data.

**Shared** (`shared/`) — Logger with credential redaction, Result types, constants, environment helpers, async utilities, and formatting.

### Action Modules (`src/`)

**Shared** — `logger.ts` provides JSON-structured logging with automatic credential redaction. `types.ts` defines core interfaces (`ActionInputs`, `CacheResult`, `RunContext`). `constants.ts` pins default versions for OpenCode, Bun, oMo, and Systematic. `cache-save-result.ts` defines the persistence-outcome contract that cleanup hands to the post-action hook and that the `cache-save-result` action output reports (see [[Session Persistence]]).

**Services** — `github/` wraps Octokit and the `NormalizedEvent` system (see [[Execution Lifecycle]]). `cache/` manages GitHub Actions cache with corruption detection and S3 fallback. `setup/` orchestrates tool installation, including the new opt-in oMo installation controlled by the `enable-omo` input (see [[Setup and Configuration]]).

**Features** — `agent/` bridges the runtime prompt builder with GitHub-specific context and the output-mode resolver (see [[Prompt Architecture]]). `triggers/` implements event routing and skip-condition logic, including the PR review opt-out label handled in `skip-conditions-pr.ts` (see [[Execution Lifecycle]]). `comments/` and `reviews/` handle GitHub comment and PR review posting. `context/` hydrates issue/PR data via GraphQL. `observability/` collects metrics and generates run summaries. `attachments/` processes file attachments. `delegated/` (RFC-010) manages branch, commit, and PR operations via the GitHub Git Data API, and hosts the **brokered push** state machine that commits an agent's fix directly to a same-repo PR head branch on a trusted comment trigger, without ever handing the agent a credential (see [[Execution Lifecycle]] and [[Setup and Configuration]]).

**Harness** — `run.ts` orchestrates the full execution lifecycle through discrete phases, including the lock acquisition phase and the drain step that holds teardown open until owned background work settles. `post.ts` handles the post-action cache save, gated on the persistence outcome and metadata flags that cleanup wrote to action state. `outcome.ts` reduces delivery success plus four verification facts into the run's final `invocation-outcome`, which is where the `incomplete` state — a useful result may exist, but this invocation cannot certify completion — is decided. `config/` parses action inputs, publishes outputs, and manages the state keys that cross the main-step/post-hook process boundary (see [[Execution Lifecycle]]).

## Codemap Reference

The full, unabridged symbol rows for entries that [ARCHITECTURE.md](../../ARCHITECTURE.md) shortens or folds into a sibling row in its Codemap.

### Action / Root `src/`

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `installSystematicPlugin` | Function | `src/services/setup/systematic-plugin.ts` | Setup-time Systematic plugin install (keeps npm install off the server's boot path) |
| `saveCache` | Function | `src/services/cache/save.ts` | Persist state to cache; returns a `CacheSaveResult` (two independent persistence axes + a named outcome), not a boolean |
| `toCacheSaveStateValue` | Function | `src/shared/cache-save-result.ts` | Exhaustiveness-pinned mapper from `CacheSaveResult` to the `CACHE_SAVED` state handoff value |
| `checkpointDatabase` | Function | `src/services/cache/checkpoint.ts` | Merge SQLite WAL into main DB before save/restore hand-off |
| `verifyDatabaseUsable` | Function | `src/services/cache/integrity.ts` | Restore-side probe for structurally corrupt SQLite files |
| `isStructuralCorruptionError` | Function | `src/services/cache/sqlite-errors.ts` | Positive-allowlist classifier for SQLite corruption vs. transient errors |
| `runDrain` | Function | `src/harness/phases/execute.ts` | Drain phase: blocks publish/persist/release until this run's owned background work settles or the run's deadline expires |
| `normalizeEvent` | Function | `src/services/github/context.ts` | Raw payload → typed NormalizedEvent |
| `parseGitHubContext` | Function | `src/services/github/context.ts` | Global context → typed GitHubContext |
| `routeEvent` | Function | `src/features/triggers/router.ts` | Event routing orchestration |
| `NormalizedEvent` | Union | `src/services/github/types.ts` | 8-variant discriminated event union |

### `packages/runtime/` (canonical prompt + agent primitives)

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `buildAgentPrompt` | Function | `packages/runtime/src/agent/prompt.ts` | XML-tagged prompt with authority hierarchy |
| `buildAgentContextSection` | Function | `packages/runtime/src/agent/prompt.ts` | Consolidated agent operations block |
| `buildHarnessRulesSection` | Function | `packages/runtime/src/agent/prompt-thread.ts` | Non-negotiable rules with precedence declaration |
| `runPromptAttempt` | Function | `src/features/agent/retry.ts` | Execute prompt with retry logic |
| `pollForSessionCompletion` | Function | `src/features/agent/session-poll.ts` | Poll SDK for completion status |
| `bootstrapOpenCodeServer` | Function | `packages/runtime/src/agent/server.ts` (delegate: `src/features/agent/server-adapter.ts`) | Initialize SDK server lifecycle; probes instance-scoped readiness before reporting success |
| `createOwnershipLedger` | Function | `packages/runtime/src/agent/ownership-ledger.ts` | In-memory 3-state (outstanding/settled/unknown) ledger for background subagent executions, keyed by child session id |
| `reconcileLedgerOnce` / `createLedgerReconciler` | Function | `packages/runtime/src/agent/ledger-reconcile.ts` | Settles tracked ledger entries whose settlement event the SSE stream never delivered, against `children()`/`liveSessionIds()` (both scoped to the run's directory); never adopts an untracked session |
| `createRemoteQuestionClient` | Function | `packages/runtime/src/agent/remote-question-client.ts` | Narrow v2-SDK client over OpenCode's `question` reply/reject endpoints (the v1 client does not expose them); every call carries the workspace `directory` |
| `DEFAULT_OPENCODE_VERSION` | Constant | `packages/runtime/src/shared/constants.ts` | Pinned harness build version (OpenCode base + carries) |

### `packages/gateway/`

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `runMention` | Function | `packages/gateway/src/execute/run.ts` | Full mention execution lifecycle |
| `launchWork` | Function | `packages/gateway/src/execute/run.ts` | Fire-and-return web launch path |
| `buildDiscordPrompt` | Function | `packages/gateway/src/execute/prompt.ts` | Discord-specific prompt builder |
| `createWorkflowDispatcher` | Function | `packages/gateway/src/github/dispatch.ts` | `/fro-bot dispatch` GitHub Actions workflow-dispatch adapter (fire-and-forget; no queue, concurrency, or local run-state) |
| `createDiscordApprovalOnPending` | Function | `packages/gateway/src/approvals/discord-transport.ts` | Discord approval transport; auto-denies on a terminal (channel/thread-gone) delivery failure |
| `createRequestGate` | Function | `packages/gateway/src/approvals/request-gate.ts` | Shared lifecycle core for human-wait requests: the `open → claimed → confirmed` state machine, scope check, registry-owned deadline, echo settlement, run teardown, and one terminal notification per request. Backs both the approval and question registries |
| `createQuestionRegistry` | Function | `packages/gateway/src/approvals/question-registry.ts` | Question family of the gate: `answer` / `skip` decisions, answer validation, empty-reply skip at the deadline, reject on teardown, pending queries by scope and by run |
| `createQuestionCoordinator` | Function | `packages/gateway/src/approvals/question-coordinator.ts` | Per-run seam for `question.*` events: computes the deadline (or skips immediately), registers, announces through `onRegistered`, rejects malformed asks, and rejects still-pending questions at run end |
| `createDiscordQuestionOnRegistered` | Function | `packages/gateway/src/approvals/discord-question-transport.ts` | Discord question transport: posts the single-question prompt (or the web-fallback notice) into the run thread and attaches the settled render; a delivery failure never settles the question |
| `handleQuestionInteraction` | Function | `packages/gateway/src/discord/question-interactions.ts` | Option/Skip/text buttons, select menu, and answer modal: authorizes, maps option indices to raw labels, and decides through the gate with a Discord actor scoped to the thread |
| `buildPendingQuestionsRoute` / `buildQuestionDecisionRoute` | Function | `packages/gateway/src/web/operator/{pending-questions-route,question-decision-route}.ts` | `GET /operator/runs/:runId/questions` (read-level reconciliation listing) and `POST /operator/runs/:runId/questions/:requestId/decision` (write-level answer or skip; a refused body is `400 {error: 'bad request', reason, questionIndex}`, the standard operator error envelope) |
| `createWebQuestionOnRegistered` | Function | `packages/gateway/src/web/operator/web-question.ts` | Web question transport: emits the SSE open frame after registration and attaches the settle-frame render; fail-soft |
| `createQuestionEffects` | Function | `packages/gateway/src/execute/question-client.ts` | Per-run `replyQuestion` / `rejectQuestion` effects over the v2 SDK client; failures collapse to reason codes, never SDK error text |
| `recoverStaleRuns` | Function | `packages/gateway/src/execute/recovery.ts` | Startup sweep: terminalizes stale active runs only when the repo's OpenCode workspace is confirmed clear (busy/unknown leaves run and lock untouched); never deletes coordination locks |
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
| `OPERATOR_CONTRACT_VERSION` | Constant | `packages/gateway/src/operator-contract/version.ts` | Build-time-pinned operator contract version (`1.11.0`) |
| `resolveClient` | Function | `packages/gateway/src/web/ingress/resolve-client.ts` | Trusted-proxy-aware client-address resolution returning an exact canonical address for OAuth binding and a separate IPv4 /32 or IPv6 /64 abuse-accounting key for rate limits and the OAuth attempt cap; returns a branded `ResolvedClientAddress` or a closed `IngressRejection` — never a fallback key |
| `parseCanonicalAddress` | Function | `packages/gateway/src/web/ingress/canonical-address.ts` | Single strict IPv4/IPv6 parser shared by socket, X-Forwarded-For, and configured-peer parsing |
| `createPushHealthTracker` / `observePushAdapterHealth` | Function | `packages/gateway/src/web/operator-push/{push-health,push-health-adapter}.ts` | Passive in-memory operator push health (`disabled \| ready \| degraded \| unknown`, 1-hour staleness on a monotonic clock). Backend outcomes are observed at the object-store adapter the subscription store is built over (reads vs writes; a completed call is `ok`: `NoSuchKey`/`NotFound`, 412, 409 by code, 404/412/409 by status only without a code; a 404 `NoSuchBucket` is `failed`; the store reports CAS-retry exhaustion as a write failure ordered by when the record finished; a throwing `markDead` cleanup never feeds relay health), relay outcomes once per broadcast; each component keeps its latest-by-start observation. Surfaced only as the optional `push: {status}` on the authenticated `GET /operator/session`. `ready` is observed readiness, not guaranteed delivery |

## Annotated Data Flow

The fully annotated gateway mention-loop and harness release trees that [ARCHITECTURE.md](../../ARCHITECTURE.md) condenses in its Data Flow section. The annotated Action phase pipeline is in [[Execution Lifecycle]].

### Gateway Mention-Loop

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
              │     (coordination/lock.ts; heartbeat renews lease; expired takeover needs a clear workspace check)
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
              ├─→ agent question (`question` tool; root or adopted descendant)
              │     question.asked → question registry, deadline computed from the budget left
              │     (too little budget → skipped at once with an empty reply)
              │     → web: SSE `question` frame; Discord: prompt in the thread (single-question
              │       shapes) or a notice pointing at the operator web surface
              │     → answer/skip from either surface, or the deadline skip (empty reply)
              │     (pauses the inactivity watchdog while any approval or question is pending)
              │
              └─→ completion
                    root session.idle with a background dispatch adopted → drain
                      (periodic reconciliation until settled or the run deadline expires)
                      (completion needs ledger settlement AND each child's completion notice or cancel
                      evidence AND root freshness; human waits are independent: a pending question never
                      holds or ends it, and the inactivity watchdog stays paused for the whole drain)
                    code-written "started from" provenance line appended to the final reply
                    run → COMPLETED; heartbeat stop; lock release
                    on failure → FAILED; coarse error reply to thread
```

### Harness Release Pipeline

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

## Design Decisions

**Functions only, no classes.** The entire codebase uses plain functions and closures. This was a deliberate choice to keep the code simple and avoid the overhead of class hierarchies in a project that doesn't need polymorphism.

**Dependency injection via parameters.** Every function that needs a logger, API client, or adapter receives it as a parameter rather than importing a singleton. This makes testing straightforward — tests pass mock implementations directly.

**Adapter pattern for I/O.** External operations (cache, exec, tool-cache) are wrapped in adapter interfaces (`CacheAdapter`, `ExecAdapter`, `ToolCacheAdapter`). Production code uses real implementations; tests substitute fakes.

**Result types for recoverable errors.** Functions that can fail return `Result<T, E>` from `@bfra.me/es` rather than throwing. Exceptions are reserved for truly unexpected failures.

**ESM with `.js` extensions.** All relative imports use `.js` extensions, matching the Node 24 ESM resolution algorithm. This is enforced by the build and is a common source of errors for contributors unfamiliar with the convention. See [[Conventions and Patterns]] for the full set of coding conventions and anti-patterns.

## Build and Bundle

The project uses `tsdown` (an esbuild-based bundler) to produce `dist/main.js` and `dist/post.js`. The `dist/` directory is committed to the repository — GitHub Actions requires it. CI validates that `dist/` stays in sync with source by running `bun run build` and checking for diffs.

The runtime package (`packages/runtime/`) is consumed as a workspace dependency via its TypeScript source — no separate build step is required for development, though it has its own `tsdown` config for publishing.

Testing uses Vitest with colocated `.test.ts` files. The project follows test-driven development: failing test first, minimal implementation, then refactor. Shared test configuration isolates HOME and XDG paths and detects worker crashes that leave tests without results; [[Conventions and Patterns]] describes those boundaries.

## RFCs

Architecture decisions are documented in RFC documents under `RFCs/`. They cover the foundation types (RFC-001), cache infrastructure (RFC-002), GitHub client (RFC-003), session management (RFC-004), trigger routing (RFC-005), security gating (RFC-006), observability (RFC-007), S3 storage (RFC-019), and more. When a module's behavior seems surprising, the corresponding RFC usually explains the reasoning.
