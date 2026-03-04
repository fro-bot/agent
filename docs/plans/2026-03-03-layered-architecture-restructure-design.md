# Layered Architecture Restructure — Design Document

**Date:** 2026-03-03 **Scope:** Project-wide (`--scope=project --strategy=aggressive`) **Status:** Approved

## Problem Statement

The codebase has accumulated architectural debt across several dimensions:

1. **Critical duplications** — `parseOmoProviders()` copy-pasted between `inputs.ts` and `setup/setup.ts`; dual input parsing via `parseActionInputs()` and `parseSetupInputs()`; parallel cache restore in `setup.ts` vs `cache.ts`
2. **Oversized files** — 6 files exceed 300 LOC (`router.ts` 892, `opencode.ts` 876, `storage.ts` 631, `main.ts` 579, `prompt.ts` 420, `setup.ts` 366, `cache.ts` 328)
3. **Flat `lib/` structure** — Mixes standalone utility files (`constants.ts`, `logger.ts`, `types.ts`) alongside feature modules (`agent/`, `triggers/`), obscuring dependency direction
4. **God function in `main.ts`** — 579-line `run()` orchestrates 12 steps with 13+ module imports
5. **Orphaned standalone files** — `cache-key.ts` (51L), `state-keys.ts` (19L), `outputs.ts` (13L) are micro-files without module homes

## Design: Four-Layer Architecture

### Layer Hierarchy (dependency flows DOWN only)

```
src/
├── main.ts, post.ts         ← Thin entry points
├── harness/            ← Layer 3: Workflow composition
├── features/                 ← Layer 2: Business logic
├── services/                 ← Layer 1: External system adapters
└── shared/                   ← Layer 0: Pure functions, types, no framework deps
```

### Layer Rules

| Layer            | May Import From            | Must NOT Import From              |
| ---------------- | -------------------------- | --------------------------------- |
| `shared/`        | nothing                    | services, features, harness |
| `services/`      | shared                     | features, harness           |
| `features/`      | shared, services           | harness                     |
| `harness/` | shared, services, features | —                                 |

### Concrete Structure

```
src/
├── main.ts                           # Thin: import run() + call
├── post.ts                           # Thin: import runPost() + call
├── index.ts                          # Public API
│
├── shared/                           # Layer 0: Pure, zero @actions deps
│   ├── types.ts                      # Core interfaces (ActionInputs, CacheResult, etc.)
│   ├── constants.ts                  # All defaults and config values
│   ├── logger.ts                     # Structured logging + redaction
│   ├── env.ts                        # Environment variable accessors
│   ├── errors.ts                     # Error utilities
│   ├── validation.ts                 # Input validation
│   ├── paths.ts                      # Path normalization
│   ├── format.ts                     # String formatting
│   ├── async.ts                      # Async utilities
│   ├── console.ts                    # Console utilities
│   └── index.ts                      # Re-exports
│
├── services/                         # Layer 1: External adapters
│   ├── cache/                        # GitHub Actions cache
│   │   ├── cache-key.ts              # Key generation (from lib/cache-key.ts)
│   │   ├── restore.ts               # Cache restoration + corruption detection
│   │   ├── save.ts                   # Cache saving + version writing
│   │   ├── types.ts                  # CacheAdapter, options interfaces
│   │   └── index.ts
│   ├── github/                       # Octokit + API (minimal changes)
│   │   ├── api.ts
│   │   ├── client.ts
│   │   ├── context.ts
│   │   ├── urls.ts
│   │   ├── utils.ts
│   │   ├── types.ts
│   │   └── index.ts
│   ├── session/                      # Session persistence
│   │   ├── storage-read.ts           # Read ops (extracted from storage.ts)
│   │   ├── storage-write.ts          # Write ops (extracted from storage.ts)
│   │   ├── discovery.ts              # Project discovery (extracted from storage.ts)
│   │   ├── search.ts
│   │   ├── prune.ts
│   │   ├── writeback.ts
│   │   ├── version.ts
│   │   ├── types.ts
│   │   └── index.ts
│   └── setup/                        # Environment bootstrap
│       ├── opencode.ts               # (existing)
│       ├── bun.ts                    # (existing)
│       ├── omo.ts                    # (existing)
│       ├── omo-config.ts             # (existing)
│       ├── gh-auth.ts                # (existing)
│       ├── auth-json.ts              # (existing)
│       ├── project-id.ts             # (existing)
│       ├── tools-cache.ts            # (existing)
│       ├── setup.ts                  # MODIFIED: receives ActionInputs, no parseSetupInputs
│       ├── types.ts
│       └── index.ts
│
├── features/                         # Layer 2: Business logic
│   ├── agent/                        # OpenCode execution
│   │   ├── server.ts                 # SDK server bootstrap (from opencode.ts)
│   │   ├── execution.ts              # Session + prompt execution (from opencode.ts)
│   │   ├── streaming.ts              # Event stream processing (from opencode.ts)
│   │   ├── retry.ts                  # Retry + recovery logic (from opencode.ts)
│   │   ├── context.ts                # Agent context collection
│   │   ├── prompt.ts                 # Prompt construction
│   │   ├── reactions.ts              # UX reactions
│   │   ├── diff-context.ts           # Diff budgeting
│   │   ├── types.ts
│   │   └── index.ts
│   ├── triggers/                     # Event routing
│   │   ├── router.ts                 # Core routing (< 200 LOC)
│   │   ├── skip-conditions.ts        # Skip logic (extracted)
│   │   ├── context-builders.ts       # NormalizedEvent → TriggerContext (extracted)
│   │   ├── types.ts
│   │   └── index.ts
│   ├── reviews/                      # PR review (existing structure)
│   ├── comments/                     # Comment handling (existing)
│   ├── context/                      # GraphQL hydration (existing)
│   ├── attachments/                  # File attachments (existing)
│   ├── delegated/                    # Branch/commit/PR ops (existing)
│   └── observability/                # Metrics (existing)
│
└── harness/                    # Layer 3: Workflow composition
    ├── config/                       # Action I/O
    │   ├── inputs.ts                 # Canonical parseActionInputs + parseOmoProviders
    │   ├── outputs.ts                # setActionOutputs
    │   ├── state-keys.ts             # Main↔post handoff keys
    │   ├── omo-providers.ts          # SINGLE SOURCE: parseOmoProviders + VALID_OMO_PROVIDERS
    │   └── index.ts
    ├── phases/                       # Extracted from main.ts
    │   ├── bootstrap.ts              # Input validation, OpenCode verification
    │   ├── routing.ts                # GitHub context, event routing
    │   ├── acknowledge.ts            # Receipt acknowledgment
    │   ├── cache-restore.ts          # Cache restore + project ID + server bootstrap
    │   ├── session-prep.ts           # Session introspection + attachments
    │   ├── execute.ts                # Agent execution + session discovery
    │   ├── finalize.ts               # Outputs, job summary, cleanup
    │   └── index.ts
    ├── run.ts                        # Phase composer (replaces main.ts god function)
    └── post.ts                       # Post-action logic
```

## Deduplication Strategy

| Current Duplication                                 | Resolution                                               |
| --------------------------------------------------- | -------------------------------------------------------- |
| `parseOmoProviders()` in `inputs.ts` and `setup.ts` | Single source in `harness/config/omo-providers.ts` |
| `VALID_OMO_PROVIDERS` array in both files           | Same — canonical location in `omo-providers.ts`          |
| `parseSetupInputs()` re-reading `core.getInput()`   | `setup.ts` receives `ActionInputs` parameter             |
| `setup.ts` raw cache restore (lines 318-340)        | Remove entirely; use `services/cache/restore.ts`         |
| Cache key component construction × 3                | Factory function in `services/cache/cache-key.ts`        |

## File Splits

### `agent/opencode.ts` (876L) → 4 files

| New File       | Responsibility                                   | Estimated LOC |
| -------------- | ------------------------------------------------ | ------------- |
| `server.ts`    | SDK server spawn, port selection, health check   | ~120          |
| `execution.ts` | Session creation, prompt sending, result parsing | ~200          |
| `streaming.ts` | Event stream subscription, progress logging      | ~150          |
| `retry.ts`     | Retry logic, connection backoff, error recovery  | ~100          |

### `triggers/router.ts` (892L) → 3 files

| New File              | Responsibility                        | Estimated LOC |
| --------------------- | ------------------------------------- | ------------- |
| `router.ts`           | Core `routeEvent()` dispatch          | ~150          |
| `skip-conditions.ts`  | All skip-check functions              | ~180          |
| `context-builders.ts` | Per-event TriggerContext construction | ~200          |

### `session/storage.ts` (631L) → 3 files

| New File           | Responsibility                                     | Estimated LOC |
| ------------------ | -------------------------------------------------- | ------------- |
| `storage-read.ts`  | `readSession`, `listSessions`, `findLatestSession` | ~150          |
| `storage-write.ts` | `writeSession`, `writeSessionSummary`              | ~120          |
| `discovery.ts`     | Project discovery, path normalization              | ~100          |

### `main.ts` (579L) → 7 phase files + thin entry

Each phase corresponds to 1-2 steps of the current 12-step harness.

### `cache.ts` (328L) → 3 files

| New File     | Responsibility                               | Estimated LOC |
| ------------ | -------------------------------------------- | ------------- |
| `restore.ts` | `restoreCache()` + corruption/version checks | ~130          |
| `save.ts`    | `saveCache()` + auth cleanup                 | ~100          |
| `types.ts`   | `CacheAdapter`, option interfaces            | ~40           |

## Impact

- **Source files**: ~88 moved/modified
- **Test files**: ~60 import path updates
- **Documentation**: AGENTS.md, RULES.md, copilot-instructions.md, 12+ RFCs, module AGENTS.md files
- **Build**: `tsdown.config.ts` entry points stay `src/main.ts` + `src/post.ts`

## Verification Strategy

After each phase of the refactoring:

1. `pnpm check-types` — TypeScript compilation
2. `pnpm test` — All 350+ tests pass
3. `pnpm lint` — ESLint clean
4. `pnpm build` — Bundle to dist/
