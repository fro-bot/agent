# Architecture

This document describes the system design, invariants, and data flows for the fro-bot/agent monorepo. For directory layout and where to add new code, see [STRUCTURE.md](STRUCTURE.md). For operational knowledge, symbol tables, and commands, see [AGENTS.md](AGENTS.md).

> **Deep dives:** [Architecture Overview](docs/wiki/Architecture%20Overview.md) · [Execution Lifecycle](docs/wiki/Execution%20Lifecycle.md) · [Conventions and Patterns](docs/wiki/Conventions%20and%20Patterns.md)

## Bird's-Eye Overview

This monorepo ships three distinct deployable surfaces from one codebase:

- **GitHub Action** — a CI harness that runs OpenCode agents in response to GitHub webhook events (issues, PRs, comments, reviews, scheduled runs, workflow dispatches). The Action entry points are `src/main.ts` and `src/post.ts`; the real logic lives in the 4-layer `src/` tree and `packages/runtime/`. Sessions persist across CI runs via GitHub Actions cache and an S3-compatible object store.
- **`@fro-bot/gateway`** (`packages/gateway/`) — a Discord-first daemon that listens for `@fro-bot` mentions in bound guild channels and runs OpenCode inside a sandboxed workspace container. Includes an operator web surface (Hono, gateway-net only), an inbound announce webhook, and an S3-backed coordination layer.
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
| `DEFAULT_SYSTEMATIC_VERSION` | Constant | `packages/runtime/src/shared/constants.ts` | Pinned Systematic version (`2.32.2`) |
| `DEFAULT_OPENCODE_VERSION` | Constant | `packages/runtime/src/shared/constants.ts` | Pinned harness version (`1.17.13+harness.ee55e157`) |

### `packages/gateway/`

| Symbol               | Type     | Location                                 | Role                             |
| -------------------- | -------- | ---------------------------------------- | -------------------------------- |
| `runMention`         | Function | `packages/gateway/src/execute/run.ts`    | Full mention execution lifecycle |
| `launchWork`         | Function | `packages/gateway/src/execute/run.ts`    | Fire-and-return web launch path  |
| `buildDiscordPrompt` | Function | `packages/gateway/src/execute/prompt.ts` | Discord-specific prompt builder  |
| `buildOperatorApp`   | Function | `packages/gateway/src/web/server.ts`     | Operator Hono app factory        |

## Invariants

These are CI-enforced constraints. Violating any of them breaks the build or the system contract.

1. **4-layer import rule.** The root `src/` tree is strictly layered: `shared/` → `services/` → `features/` → `harness/`. Each layer may only import from layers below it. Cross-layer imports in the wrong direction are a type error and a lint error.
2. **Committed `dist/` must stay in sync.** CI runs `bun run build` and fails if `git diff dist/` shows changes. The pre-push hook enforces the same check locally. Never edit `dist/` by hand.
3. **Strict booleans.** No implicit falsy checks (`!value`). Use explicit comparisons (`=== null`, `=== undefined`, `.length === 0`). Enforced by ESLint.
4. **Functions only — no classes for stateful patterns.** Closures, not ES6 classes, carry state across the codebase (the only classes are a handful of `Error` subclasses in the gateway). Enforced by convention and code review.
5. **Exactly one comment or review per invocation (Response Protocol).** Exactly one GitHub comment or PR review is delivered per Action run. For `pull_request`/`issue_comment`/`issues` triggers this is **action-enforced**: the model writes its response to a run-scoped file and the harness posts it once via the Octokit writers, binding the target and surface to the trusted event. For `workflow_dispatch`/`schedule` the model still self-posts via `gh`, and the one-response rule remains prompt-enforced in `buildHarnessRulesSection()`.
6. **`NormalizedEvent` is never bypassed.** All webhook payloads must pass through `normalizeEvent()` before routing. The router never reads `context.payload` directly. Raw event access is an anti-pattern caught in code review.
7. **No type suppression.** `as any`, `@ts-ignore`, and `@ts-expect-error` are forbidden project-wide.
8. **Redaction-before-query (gateway).** The gateway denylist check runs before any binding lookup, run-state read, or GitHub API call. A repo redacted in `metadata/repos.yaml` is never queried. Cold-start failure → deny all (fail-closed).

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
        │     parseActionInputs → ensureOpenCodeAvailable → restoreCache
        │
        ├─→ routing phase
        │     parseGitHubContext → normalizeEvent → routeEvent
        │     (produces TriggerResult; skips if no matching trigger)
        │
        ├─→ dedup phase
        │     skip if agent already ran for this PR/issue within dedup window
        │     (happy path shown; lock acquisition and review reconciliation
        │      phases also run where applicable)
        │
        ├─→ acknowledge phase
        │     acknowledgeReceipt (reaction + comment stub)
        │
        ├─→ cache-restore phase
        │     dedicated session state restore from S3 / Actions cache
        │
        ├─→ session-prep phase
        │     processAttachments → buildAgentPrompt (packages/runtime)
        │
        ├─→ execute phase
        │     executeOpenCode → bootstrapOpenCodeServer → sendPromptToSession
        │       → runPromptAttempt → processEventStream (SSE)
        │
        ├─→ finalize phase
        │     writeSessionSummary → pruneSessions
        │
        └─→ cleanup phase
              saveCache → writeJobSummary

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

Triggered by `workflow_dispatch` on `.github/workflows/harness-release.yaml`.

```
harness-release.yaml (workflow_dispatch)
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

### S3 Conditional-Write Lock (Gateway)

The gateway uses S3 conditional writes (`If-None-Match` / `If-Match`) as a distributed coordination lock for per-repo execution. Lock acquisition, lease renewal (heartbeat), and release live in `packages/runtime/src/coordination/lock.ts` (runtime-owned, called by the gateway). The lock is always released in a `finally` block. Stale locks (expired lease + stale heartbeat) are recovered by `packages/gateway/src/execute/recovery.ts` on gateway startup.

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
