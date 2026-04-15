---
type: architecture
last-updated: "2026-04-13"
updated-by: "86e5bad"
sources:
  - src/main.ts
  - src/post.ts
  - src/harness/run.ts
  - src/harness/post.ts
  - AGENTS.md
  - action.yaml
summary: "Four-layer architecture, dependency rules, and high-level module map"
---

# Architecture Overview

Fro Bot Agent is a GitHub Action that runs an AI coding agent (OpenCode + oMo) inside GitHub Actions workflows and preserves the agent's session state across runs. The codebase is TypeScript, ESM-only, targeting Node 24.

## Layered Architecture

The source tree follows a strict four-layer dependency hierarchy. Each layer may import only from layers below it — never sideways or upward.

| Layer | Directory | Responsibility |
| --- | --- | --- |
| 0 — Shared | `src/shared/` | Pure types, constants, utilities. Zero external dependencies beyond Node built-ins and `@actions/core`. |
| 1 — Services | `src/services/` | External adapters: GitHub API client, session persistence, cache operations, environment setup. |
| 2 — Features | `src/features/` | Business logic: agent execution, event routing, comment/review posting, observability. |
| 3 — Harness | `src/harness/` | Workflow composition: the two entry points (`main.ts`, `post.ts`) and their orchestration phases. |

This layering prevents circular dependencies and keeps testability high — lower layers can be unit-tested without mocking upper ones.

## Dual Entry Points

The action defines two Node 24 entry points in `action.yaml`:

- **`dist/main.js`** — The primary execution path. Bootstraps the environment, routes the incoming GitHub event, acknowledges the request, runs the AI agent, finalizes results, and attempts a first cache save.
- **`dist/post.js`** — A post-action hook (RFC-017) that runs after the main step completes, even on failure or cancellation. Its sole job is a durable cache save so that session state survives even if the main step is killed mid-execution.

Both entry points are thin wrappers. `main.ts` delegates to `harness/run.ts`; `post.ts` delegates to `harness/post.ts`.

## Module Map

The major modules, grouped by layer:

**Shared** — `logger.ts` provides JSON-structured logging with automatic credential redaction. `types.ts` defines core interfaces (`ActionInputs`, `CacheResult`, `RunContext`). `constants.ts` pins default versions for OpenCode, Bun, oMo, and Systematic.

**Services** — `github/` wraps Octokit and the `NormalizedEvent` system (see [[Execution Lifecycle]]). `session/` handles persistence through the OpenCode SDK (see [[Session Persistence]]). `cache/` manages GitHub Actions cache with corruption detection and optional S3 backup. `setup/` orchestrates tool installation (see [[Setup and Configuration]]).

**Features** — `agent/` contains the prompt builder and SDK execution logic (see [[Prompt Architecture]]). `triggers/` implements event routing and skip-condition logic. `comments/` and `reviews/` handle GitHub comment and PR review posting. `context/` hydrates issue/PR data via GraphQL. `observability/` collects metrics and generates run summaries. `attachments/` processes file attachments. `delegated/` manages branch, commit, and PR operations the agent performs.

**Harness** — `run.ts` orchestrates the full execution lifecycle through discrete phases. `post.ts` handles the post-action cache save. `config/` parses action inputs and manages state keys.

## Design Decisions

**Functions only, no classes.** The entire codebase uses plain functions and closures. This was a deliberate choice to keep the code simple and avoid the overhead of class hierarchies in a project that doesn't need polymorphism.

**Dependency injection via parameters.** Every function that needs a logger, API client, or adapter receives it as a parameter rather than importing a singleton. This makes testing straightforward — tests pass mock implementations directly.

**Adapter pattern for I/O.** External operations (cache, exec, tool-cache) are wrapped in adapter interfaces (`CacheAdapter`, `ExecAdapter`, `ToolCacheAdapter`). Production code uses real implementations; tests substitute fakes.

**Result types for recoverable errors.** Functions that can fail return `Result<T, E>` from `@bfra.me/es` rather than throwing. Exceptions are reserved for truly unexpected failures.

**ESM with `.js` extensions.** All relative imports use `.js` extensions, matching the Node 24 ESM resolution algorithm. This is enforced by the build and is a common source of errors for contributors unfamiliar with the convention.

## Build and Bundle

The project uses `tsdown` (an esbuild-based bundler) to produce `dist/main.js` and `dist/post.js`. The `dist/` directory is committed to the repository — GitHub Actions requires it. CI validates that `dist/` stays in sync with source by running `pnpm build` and checking for diffs.

Testing uses Vitest with colocated `.test.ts` files. The project follows test-driven development: failing test first, minimal implementation, then refactor.

## RFCs

Architecture decisions are documented in 19 RFC documents under `RFCs/`. They cover the foundation types (RFC-001), cache infrastructure (RFC-002), GitHub client (RFC-003), session management (RFC-004), trigger routing (RFC-005), security gating (RFC-006), observability (RFC-007), and more. When a module's behavior seems surprising, the corresponding RFC usually explains the reasoning.
