---
type: architecture
last-updated: "2026-07-12"
updated-by: "schedule-d7190410-29208059688"
sources:
  - src/main.ts
  - src/post.ts
  - src/harness/run.ts
  - src/harness/post.ts
  - packages/runtime/src/index.ts
  - packages/runtime/src/coordination/types.ts
  - packages/harness/src/cli.ts
  - packages/harness/src/integrate.ts
  - packages/gateway/src/main.ts
  - packages/gateway/src/execute/run.ts
  - packages/gateway/src/http/server.ts
  - packages/gateway/src/web/server.ts
  - packages/gateway/src/approvals/coordinator.ts
  - packages/runtime/src/agent/remote-client.ts
  - packages/runtime/src/agent/filter-env.ts
  - packages/runtime/src/agent/with-scrubbed-env.ts
  - scripts/harness/mint-app-token.ts
  - packages/harness/harness.config.json
  - apps/workspace-agent/src/main.ts
  - apps/workspace-agent/src/server.ts
  - apps/workspace-agent/src/opencode-server.ts
  - AGENTS.md
  - action.yaml
  - bunfig.toml
summary: "Monorepo structure, action + harness + gateway + workspace-agent packages, and module map"
---

# Architecture Overview

Fro Bot Agent is a GitHub Action that runs an AI coding agent (OpenCode, optionally with Oh My OpenAgent) inside GitHub Actions workflows and preserves the agent's session state across runs. The codebase is TypeScript, ESM-only, targeting Node 24.

## Monorepo Structure

The project is organized as a Bun workspace monorepo with two workspace areas:

| Package | Path | Purpose |
| --- | --- | --- |
| `@fro-bot/runtime` | `packages/runtime/` | Shared runtime library: agent prompt, session management, object store, coordination primitives, and shared utilities. Consumed by both the Action and the Gateway. |
| `@fro.bot/harness` | `packages/harness/` | Published, patched OpenCode binary built via LLM-merge integration. Acts as a drop-in replacement for the stock OpenCode CLI in the action setup. Ships as a main package plus per-platform binary packages (`@fro.bot/harness-linux-x64`, etc.). |
| `@fro-bot/gateway` | `packages/gateway/` | Discord gateway daemon. Listens for Discord mentions and slash commands, acquires the per-repo coordination lock, and dispatches agent runs via the runtime. Built with Effect for typed error handling and structured concurrency. |
| Action root | `src/` + `apps/action/` | The GitHub Action itself. Contains the harness (orchestration phases), features (triggers, comments, reviews, observability), and service adapters (GitHub API, cache, setup). Imports `@fro-bot/runtime` for core logic. |
| workspace-agent | `apps/workspace-agent/` | Sandboxed Hono HTTP service that runs inside the Docker Compose deploy stack alongside the gateway. Provides a `POST /clone` endpoint to checkout repositories in an isolated container (keeping git credentials off the gateway), and hosts a loopback-bound OpenCode server fronted by a bearer-token proxy for the gateway to attach to. Also exposes `GET /healthz` for Docker Compose health checks. |

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

- **`dist/main.js`** — The primary execution path. Bootstraps the environment, routes the incoming GitHub event, acquires a coordination lock, acknowledges the request, runs the AI agent, finalizes results, and attempts a first cache save.
- **`dist/post.js`** — A post-action hook (RFC-017) that runs after the main step completes, even on failure or cancellation. Its sole job is a durable cache save so that session state survives even if the main step is killed mid-execution.

Both entry points are thin wrappers. `main.ts` delegates to `harness/run.ts`; `post.ts` delegates to `harness/post.ts`.

## Module Map

### Harness Package (`packages/harness/`)

`@fro.bot/harness` is a published, patched OpenCode binary built via the LLM-merge integration method (`cortexkit/orw`). Rather than downloading stock OpenCode, the action setup can install the harness binary, which carries a curated set of integration refs (stalled or closed upstream PRs, branch URLs) merged onto each deliberately-pinned upstream release via a one-time `opencode run` LLM merge. The produced binary is frozen: the merge runs once in CI per release bump, is reviewed as a bump PR, and the integration commit SHA is pinned before per-platform binaries are built and published.

The CLI is a drop-in replacement — all arguments pass through to the patched OpenCode binary. Own subcommands (`info`, `patches`, `doctor`) report provenance (upstream tag, integration refs, build SHA) and health. The `integrate` merge step (`integrate.ts`) runs the OpenCode merge agent in CI over prompt-injectable upstream PR content, so both of its GitHub credentials are short-lived and minted just-in-time rather than drawn from durable secrets. The merge agent's own auth is minted from an OIDC broker (`scripts/harness/mint-broker-credential.ts`), and the credential used to `git push` the merge result is a scoped GitHub App installation token — single-repo, `contents: write`-only, roughly one-hour TTL — minted inline by a trusted no-post step (`scripts/harness/mint-app-token.ts`) that validates the returned token's scope all-or-nothing and fails closed on any mismatch. Neither mint has a durable-credential fallback, and the App private key is mapped only to the mint step's environment, never to job-level env or disk. As further defense-in-depth, the harness masks the `github-token` value and scrubs the raw `INPUT_GITHUB-TOKEN` copy from the merge child's environment so the OpenCode subprocess never inherits it.

The package ships as `@fro.bot/harness` (the main resolver) plus four per-platform packages (`@fro.bot/harness-linux-x64`, `-linux-arm64`, `-darwin-x64`, `-darwin-arm64`), each containing only its native binary. The main package's `postinstall` resolver picks the host platform's binary, verifies it, and symlinks it; `OPENCODE_PATH` and a bare `opencode` on `PATH` are honored as fallbacks for local or unbuilt use. Per-platform `optionalDependencies` are injected at publish time and are not listed in the workspace `package.json`.

### Gateway Package (`packages/gateway/`)

The Discord gateway (`@fro-bot/gateway`) is a long-running daemon that bridges Discord mentions to Fro Bot agent runs and executes those runs end-to-end against a remote OpenCode server. Key modules:

**Discord** (`discord/`) — Client lifecycle wrapper (`client.ts`), slash command registry (`commands/`, including `/add-project` and `/fro-bot`), mention handler (`mentions.ts`), channel helpers (`channels.ts`), presence updates (`presence.ts`), and streaming (`streaming.ts`). The streaming module relays OpenCode event output back into the Discord thread as the run progresses.

**Execute** (`execute/`) — The agent-execution pipeline triggered by an `@fro-bot` mention or a web launch. `run.ts` orchestrates the full run: acquires the coordination lock, creates a run-state record with heartbeat, and delegates to `run-core.ts` for session creation, prompt send, and event-stream routing. `opencode-attach.ts` connects to the remote OpenCode server, `prompt.ts` builds the Discord prompt, `concurrency.ts` enforces per-channel run limits via a serial queue (`queue.ts`), and `recovery.ts` handles interrupted runs. An in-memory abort registry (`abort-registry.ts`) plus `cancel.ts` back operator-initiated cancellation: a run registered under its `runId` can be aborted mid-flight and settles as `CANCELLED` rather than `FAILED` (see [[Operator Web Control Surface]]). `run-core.ts` also counts inbound events so a stalled run can be distinguished from a lost-event timeout. Permission events emitted by OpenCode during a run are forwarded to Discord approval buttons via the approvals subsystem.

**Approvals** (`approvals/`) — Discord approval UI for OpenCode permission gate events. When OpenCode asks for a file-system or shell permission during a gateway run, the coordinator (`coordinator.ts`) registers the pending request and the registry (`registry.ts`) manages the entry lifecycle across all in-flight runs. A Discord button click claims the entry (preventing duplicate replies), calls back to OpenCode's reply endpoint, and the authoritative `permission.replied` event from the SDK confirms settlement. The registry is the single source of truth; the coordinator is a thin forwarder bridging the SDK event stream to the registry.

**HTTP** (`http/`) — The signed announce webhook server. Handles control-plane presence messages with HMAC signature verification (`hmac.ts`), replay protection (`replay-cache.ts`), rate limiting (`rate-limit.ts`), and schema validation (`announce-schema.ts`).

**Web** (`web/`, `operator-contract/`) — The authenticated operator web control surface: a browser-facing Hono server that lets a signed-in human launch, observe, and approve tool use within agent runs over HTTP and Server-Sent Events. It owns GitHub OAuth, server-side sessions, a numeric-user-ID allowlist, per-repo authorization, CSRF protection, the SSE observation pipeline, and a web tool-approval flow that drives the same approval registry as Discord — all speaking a frozen operator contract. Routes are mounted through a dependency-gated registration seam whose inventory is verified by an offline smoke check, so a missing dependency surfaces as a build failure rather than a silently absent endpoint. This is a second entry point into the same execution engine the Discord mention handler uses. See [[Operator Web Control Surface]].

**Workspace API** (`workspace-api/`) — Client for calling the workspace-agent's clone and OpenCode-proxy endpoints (`client.ts`, `types.ts`).

**Bindings** (`bindings/`) — Channel-to-repository binding store. Maps Discord channel IDs to the GitHub repository they operate on. Backed by S3 so bindings survive restarts.

**GitHub** (`github/`) — GitHub App authentication client (`app-client.ts`). Generates short-lived installation tokens for the bound repository so the agent can make authenticated GitHub API calls on behalf of the App.

**Config / Readiness / Program / Shutdown** — Configuration loading and validation (`config.ts`), readiness lifecycle (`readiness.ts`), the top-level Effect program (`program.ts`), and graceful SIGINT/SIGTERM handling (`shutdown.ts`).

The gateway runs as a Docker container alongside sidecars: the workspace-agent, a mitmproxy allowlist proxy (egress control to Discord and GitHub hosts only), and a reverse proxy. See `deploy/` for the Compose stack definition.

### Workspace-Agent (`apps/workspace-agent/`)

The workspace-agent is a sandboxed Hono HTTP service that runs as a sidecar to the gateway. It owns two responsibilities: cloning repositories into an isolated container (`POST /clone`, keeping git credentials off the gateway), and hosting a remote OpenCode server that the gateway attaches to for agent execution. The OpenCode server (`opencode-server.ts`) binds to loopback only; a bearer-token proxy (`opencode-proxy.ts`) is the sole externally-reachable surface, ensuring the raw OpenCode port is never exposed on the sandbox network. The gateway attaches to this remote server via `createRemoteOpenCodeHandle()` in the runtime package — a handle whose `close`/`shutdown` are no-ops because the gateway does not own the remote server.

### Runtime Package (`packages/runtime/`)

The runtime package exports five module groups:

**Agent** (`agent/`) — Prompt construction, SDK execution, output-mode and response-delivery resolution, server bootstrapping, retry logic, and reference file management (see [[Prompt Architecture]]). Spawns of the OpenCode child are wrapped in a deny-by-default environment filter (`filter-env.ts` / `with-scrubbed-env.ts`) so credential-shaped variables never reach the agent process (see [[Setup and Configuration]]). Also provides `remote-client.ts`, which wraps a remote OpenCode server as an `OpenCodeServerHandle` so the gateway can execute runs without owning the server process.

**Session** (`session/`) — SDK-backed session storage, search, pruning, writeback, and mapper layers (see [[Session Persistence]]).

**Object Store** (`object-store/`) — S3-compatible persistence: adapter, key builder, content sync, and endpoint/key validation (see [[Session Persistence]]).

**Coordination** (`coordination/`) — S3-backed distributed lock, heartbeat controller, and run-state primitives for cross-surface mutual exclusion (see [[Execution Lifecycle]]).

**Shared** (`shared/`) — Logger with credential redaction, Result types, constants, environment helpers, async utilities, and formatting.

### Action Modules (`src/`)

**Shared** — `logger.ts` provides JSON-structured logging with automatic credential redaction. `types.ts` defines core interfaces (`ActionInputs`, `CacheResult`, `RunContext`). `constants.ts` pins default versions for OpenCode, Bun, oMo, and Systematic.

**Services** — `github/` wraps Octokit and the `NormalizedEvent` system (see [[Execution Lifecycle]]). `cache/` manages GitHub Actions cache with corruption detection and S3 fallback. `setup/` orchestrates tool installation, including the new opt-in oMo installation controlled by the `enable-omo` input (see [[Setup and Configuration]]).

**Features** — `agent/` bridges the runtime prompt builder with GitHub-specific context and the output-mode resolver (see [[Prompt Architecture]]). `triggers/` implements event routing and skip-condition logic. `comments/` and `reviews/` handle GitHub comment and PR review posting. `context/` hydrates issue/PR data via GraphQL. `observability/` collects metrics and generates run summaries. `attachments/` processes file attachments. `delegated/` manages branch, commit, and PR operations the agent performs.

**Harness** — `run.ts` orchestrates the full execution lifecycle through discrete phases, including the new lock acquisition phase. `post.ts` handles the post-action cache save. `config/` parses action inputs and manages state keys.

## Design Decisions

**Functions only, no classes.** The entire codebase uses plain functions and closures. This was a deliberate choice to keep the code simple and avoid the overhead of class hierarchies in a project that doesn't need polymorphism.

**Dependency injection via parameters.** Every function that needs a logger, API client, or adapter receives it as a parameter rather than importing a singleton. This makes testing straightforward — tests pass mock implementations directly.

**Adapter pattern for I/O.** External operations (cache, exec, tool-cache) are wrapped in adapter interfaces (`CacheAdapter`, `ExecAdapter`, `ToolCacheAdapter`). Production code uses real implementations; tests substitute fakes.

**Result types for recoverable errors.** Functions that can fail return `Result<T, E>` from `@bfra.me/es` rather than throwing. Exceptions are reserved for truly unexpected failures.

**ESM with `.js` extensions.** All relative imports use `.js` extensions, matching the Node 24 ESM resolution algorithm. This is enforced by the build and is a common source of errors for contributors unfamiliar with the convention. See [[Conventions and Patterns]] for the full set of coding conventions and anti-patterns.

## Build and Bundle

The project uses `tsdown` (an esbuild-based bundler) to produce `dist/main.js` and `dist/post.js`. The `dist/` directory is committed to the repository — GitHub Actions requires it. CI validates that `dist/` stays in sync with source by running `bun run build` and checking for diffs.

The runtime package (`packages/runtime/`) is consumed as a workspace dependency via its TypeScript source — no separate build step is required for development, though it has its own `tsdown` config for publishing.

Testing uses Vitest with colocated `.test.ts` files. The project follows test-driven development: failing test first, minimal implementation, then refactor.

## RFCs

Architecture decisions are documented in RFC documents under `RFCs/`. They cover the foundation types (RFC-001), cache infrastructure (RFC-002), GitHub client (RFC-003), session management (RFC-004), trigger routing (RFC-005), security gating (RFC-006), observability (RFC-007), S3 storage (RFC-019), and more. When a module's behavior seems surprising, the corresponding RFC usually explains the reasoning.
