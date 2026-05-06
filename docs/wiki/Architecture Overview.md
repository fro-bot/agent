---
type: architecture
last-updated: "2026-05-03"
updated-by: "328fcc5"
sources:
  - src/main.ts
  - src/post.ts
  - src/harness/run.ts
  - src/harness/post.ts
  - packages/runtime/src/index.ts
  - packages/runtime/src/coordination/types.ts
  - AGENTS.md
  - action.yaml
  - pnpm-workspace.yaml
summary: "Monorepo structure, four-layer action architecture, runtime package, and module map"
---

# Architecture Overview

Fro Bot Agent is a GitHub Action that runs an AI coding agent (OpenCode + oMo) inside GitHub Actions workflows and preserves the agent's session state across runs. The codebase is TypeScript, ESM-only, targeting Node 24.

## Monorepo Structure

The project is organized as a pnpm workspace monorepo with two workspace areas:

| Package | Path | Purpose |
| --- | --- | --- |
| `@fro-bot/runtime` | `packages/runtime/` | Shared runtime library: agent prompt, session management, object store, coordination primitives, and shared utilities. Designed to be consumed by any Fro Bot surface (GitHub Action, Discord gateway, etc.). |
| Action root | `src/` + `apps/action/` | The GitHub Action itself. Contains the harness (orchestration phases), features (triggers, comments, reviews, observability), and service adapters (GitHub API, cache, setup). Imports `@fro-bot/runtime` for core logic. |

The `apps/action/` directory holds the thinnest possible entry points — `main.ts` and `post.ts` — which simply re-export from `src/main.ts` and `src/post.ts`. The split exists to support future surfaces (like a Discord gateway) that share the runtime package but have their own entry points.

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

### Runtime Package (`packages/runtime/`)

The runtime package exports five module groups:

**Agent** (`agent/`) — Prompt construction, SDK execution, output-mode resolution, server bootstrapping, retry logic, and reference file management (see [[Prompt Architecture]]).

**Session** (`session/`) — SDK-backed session storage, search, pruning, writeback, and mapper layers (see [[Session Persistence]]).

**Object Store** (`object-store/`) — S3-compatible persistence: adapter, key builder, content sync, and endpoint/key validation (see [[Session Persistence]]).

**Coordination** (`coordination/`) — S3-backed distributed lock, heartbeat controller, and run-state primitives for cross-surface mutual exclusion (see [[Execution Lifecycle]]).

**Shared** (`shared/`) — Logger with credential redaction, Result types, constants, environment helpers, async utilities, and formatting.

### Action Modules (`src/`)

**Shared** — `logger.ts` provides JSON-structured logging with automatic credential redaction. `types.ts` defines core interfaces (`ActionInputs`, `CacheResult`, `RunContext`). `constants.ts` pins default versions for OpenCode, Bun, oMo, and Systematic.

**Services** — `github/` wraps Octokit and the `NormalizedEvent` system (see [[Execution Lifecycle]]). `cache/` manages GitHub Actions cache with corruption detection and S3 fallback. `setup/` orchestrates tool installation (see [[Setup and Configuration]]).

**Features** — `agent/` bridges the runtime prompt builder with GitHub-specific context and the output-mode resolver (see [[Prompt Architecture]]). `triggers/` implements event routing and skip-condition logic. `comments/` and `reviews/` handle GitHub comment and PR review posting. `context/` hydrates issue/PR data via GraphQL. `observability/` collects metrics and generates run summaries. `attachments/` processes file attachments. `delegated/` manages branch, commit, and PR operations the agent performs.

**Harness** — `run.ts` orchestrates the full execution lifecycle through discrete phases, including the new lock acquisition phase. `post.ts` handles the post-action cache save. `config/` parses action inputs and manages state keys.

## Design Decisions

**Functions only, no classes.** The entire codebase uses plain functions and closures. This was a deliberate choice to keep the code simple and avoid the overhead of class hierarchies in a project that doesn't need polymorphism.

**Dependency injection via parameters.** Every function that needs a logger, API client, or adapter receives it as a parameter rather than importing a singleton. This makes testing straightforward — tests pass mock implementations directly.

**Adapter pattern for I/O.** External operations (cache, exec, tool-cache) are wrapped in adapter interfaces (`CacheAdapter`, `ExecAdapter`, `ToolCacheAdapter`). Production code uses real implementations; tests substitute fakes.

**Result types for recoverable errors.** Functions that can fail return `Result<T, E>` from `@bfra.me/es` rather than throwing. Exceptions are reserved for truly unexpected failures.

**ESM with `.js` extensions.** All relative imports use `.js` extensions, matching the Node 24 ESM resolution algorithm. This is enforced by the build and is a common source of errors for contributors unfamiliar with the convention. See [[Conventions and Patterns]] for the full set of coding conventions and anti-patterns.

## Build and Bundle

The project uses `tsdown` (an esbuild-based bundler) to produce `dist/main.js` and `dist/post.js`. The `dist/` directory is committed to the repository — GitHub Actions requires it. CI validates that `dist/` stays in sync with source by running `pnpm build` and checking for diffs.

The runtime package (`packages/runtime/`) is consumed as a workspace dependency via its TypeScript source — no separate build step is required for development, though it has its own `tsdown` config for publishing.

Testing uses Vitest with colocated `.test.ts` files. The project follows test-driven development: failing test first, minimal implementation, then refactor.

## RFCs

Architecture decisions are documented in RFC documents under `RFCs/`. They cover the foundation types (RFC-001), cache infrastructure (RFC-002), GitHub client (RFC-003), session management (RFC-004), trigger routing (RFC-005), security gating (RFC-006), observability (RFC-007), S3 storage (RFC-019), and more. When a module's behavior seems surprising, the corresponding RFC usually explains the reasoning.
