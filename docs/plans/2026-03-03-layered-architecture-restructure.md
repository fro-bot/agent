# Layered Architecture Restructure — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure the codebase from a flat `lib/` layout into a four-layer architecture (`shared/` → `services/` → `features/` → `harness/`) while deduplicating code and splitting all oversized files under 200 LOC.

**Architecture:** Four dependency layers with strict downward-only imports. Existing module directories (agent/, github/, triggers/, etc.) move into the appropriate layer. Standalone files consolidate into proper modules. `main.ts` decomposes into harness phases.

**Tech Stack:** TypeScript, ESM-only (.js extensions), Vitest, tsdown, pnpm

**Design doc:** `docs/plans/2026-03-03-layered-architecture-restructure-design.md`

---

## CRITICAL CONSTRAINTS

- **ESM imports**: ALL relative imports MUST use `.js` extensions
- **No type suppression**: NEVER `as any`, `@ts-ignore`, `@ts-expect-error`
- **Function-based**: No ES6 classes
- **Strict booleans**: `!= null` not `!value` for non-booleans
- **Logger injection**: All functions take `logger: Logger` as parameter
- **Test colocated**: `*.test.ts` files move WITH their source files
- **dist/ committed**: Must run `pnpm build` after all changes

## VERIFICATION COMMANDS

After every phase:

```bash
pnpm check-types    # TypeScript compiles
pnpm test           # All 350+ tests pass
pnpm lint           # ESLint clean
pnpm build          # Bundles to dist/
```

---

## Phase 1: Create `shared/` Layer (Pure Types + Utilities)

Move `utils/` contents and `lib/` standalone pure files into `shared/`. This layer has ZERO framework dependencies (`@actions/*`).

**Exception:** `logger.ts` uses `@actions/core` for output. It stays in shared/ because every layer needs it, but note this is a pragmatic compromise on "zero framework deps."

### Task 1: Create directory structure and move utility files

**Files:**

- Create: `src/shared/index.ts`
- Move: `src/utils/*.ts` → `src/shared/*.ts` (7 source + 7 test files)
- Move: `src/lib/types.ts` → `src/shared/types.ts` (+ test)
- Move: `src/lib/constants.ts` → `src/shared/constants.ts`
- Move: `src/lib/logger.ts` → `src/shared/logger.ts` (+ test)
- Delete: `src/utils/` (empty after moves)

**Step 1: Create shared/ and move files**

```bash
mkdir -p src/shared
# Move utils/ contents (source + tests)
git mv src/utils/env.ts src/shared/env.ts
git mv src/utils/env.test.ts src/shared/env.test.ts
git mv src/utils/errors.ts src/shared/errors.ts
git mv src/utils/errors.test.ts src/shared/errors.test.ts
git mv src/utils/paths.ts src/shared/paths.ts
git mv src/utils/paths.test.ts src/shared/paths.test.ts
git mv src/utils/validation.ts src/shared/validation.ts
git mv src/utils/validation.test.ts src/shared/validation.test.ts
git mv src/utils/async.ts src/shared/async.ts
git mv src/utils/async.test.ts src/shared/async.test.ts
git mv src/utils/format.ts src/shared/format.ts
git mv src/utils/format.test.ts src/shared/format.test.ts
git mv src/utils/console.ts src/shared/console.ts
git mv src/utils/console.test.ts src/shared/console.test.ts
# Move lib/ standalone pure files
git mv src/lib/types.ts src/shared/types.ts
git mv src/lib/constants.ts src/shared/constants.ts
git mv src/lib/logger.ts src/shared/logger.ts
git mv src/lib/logger.test.ts src/shared/logger.test.ts
# Remove empty utils/
rmdir src/utils
```

**Step 2: Create shared/index.ts**

```typescript
// Re-exports for shared layer
export {getExponentialDelay, withRetry} from "./async.js"
export {createConsoleAdapter} from "./console.js"
export type {ConsoleAdapter} from "./console.js"
// ... (re-export all public symbols from each file)
```

NOTE: Inspect each file's exports to build the complete index. Only re-export public symbols.

**Step 3: Update ALL imports across the codebase**

Every file that imported from `../utils/` or `../../utils/` or `../lib/types.js` etc. needs path updates.

Use ast-grep or find-and-replace for each pattern:

- `'../utils/env.js'` → `'../shared/env.js'` (adjust depth per file location)
- `'../../utils/env.js'` → `'../../shared/env.js'`
- `'./types.js'` (in lib/ files) → `'../shared/types.js'` (adjust depth)
- `'./constants.js'` (in lib/ files) → `'../shared/constants.js'`
- `'./logger.js'` (in lib/ files) → `'../shared/logger.js'`
- `'../logger.js'` → `'../../shared/logger.js'` (from lib/\*/files)

IMPORTANT: Imports are relative to the importing file's NEW location after all moves. Be very careful with path depth.

**Step 4: Update test-helpers.ts**

`src/lib/test-helpers.ts` may import from moved files. Update its imports.

**Step 5: Verify**

```bash
pnpm check-types && pnpm test && pnpm lint
```

Expected: All pass. If type errors appear, fix import paths.

**Step 6: Commit**

```bash
git add -A && git commit -m "refactor: create shared/ layer from utils/ and lib/ standalone files"
```

---

## Phase 2: Create `services/` Layer (External Adapters)

Move infrastructure modules that wrap external systems.

### Task 2: Move github/ module

**Files:**

- Move: `src/lib/github/*` → `src/services/github/*`

**Step 1: Move files**

```bash
mkdir -p src/services
git mv src/lib/github src/services/github
```

**Step 2: Update internal imports within github/**

Files in `src/services/github/` that imported from `../logger.js`, `../types.js`, `../../utils/errors.js` now need paths like `../../shared/logger.js`, `../../shared/types.js`, `../../shared/errors.js`.

**Step 3: Update external imports TO github/**

Every file that imported from `../github/`, `../../lib/github/`, `./lib/github/` needs path updates to point to `../services/github/`, etc.

**Step 4: Verify**

```bash
pnpm check-types && pnpm test
```

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor: move github/ to services/ layer"
```

### Task 3: Move session/ module

**Files:**

- Move: `src/lib/session/*` → `src/services/session/*`

Same pattern as Task 2. Move directory, update internal imports (to shared/), update external imports (to services/session/).

```bash
git mv src/lib/session src/services/session
# Update imports...
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: move session/ to services/ layer"
```

### Task 4: Move setup/ module

**Files:**

- Move: `src/lib/setup/*` → `src/services/setup/*`

Same pattern. Note that setup/ imports from `../cache-key.js` and `../constants.js` — these have already moved to `shared/`.

```bash
git mv src/lib/setup src/services/setup
# Update imports...
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: move setup/ to services/ layer"
```

### Task 5: Create services/cache/ from standalone files

**Files:**

- Move: `src/lib/cache.ts` → `src/services/cache/cache.ts` (temporarily, will split later)
- Move: `src/lib/cache.test.ts` → `src/services/cache/cache.test.ts`
- Move: `src/lib/cache-key.ts` → `src/services/cache/cache-key.ts`
- Move: `src/lib/cache-key.test.ts` → `src/services/cache/cache-key.test.ts`
- Create: `src/services/cache/index.ts`

**Step 1: Create and move**

```bash
mkdir -p src/services/cache
git mv src/lib/cache.ts src/services/cache/cache.ts
git mv src/lib/cache.test.ts src/services/cache/cache.test.ts
git mv src/lib/cache-key.ts src/services/cache/cache-key.ts
git mv src/lib/cache-key.test.ts src/services/cache/cache-key.test.ts
```

**Step 2: Create index.ts with re-exports**

**Step 3: Update imports** — `cache.ts` imports from `./cache-key.js` (now same dir), from `../shared/` (was `../types.js`, `../constants.js`), from `../session/version.js` (now `../session/version.js` — same relative since both in services/).

**Step 4: Verify + Commit**

```bash
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: create services/cache/ module from standalone cache files"
```

---

## Phase 3: Create `features/` Layer (Business Logic)

Move domain modules that contain business logic.

### Task 6: Move agent/ module

```bash
mkdir -p src/features
git mv src/lib/agent src/features/agent
# Update imports (agent/ has the MOST cross-module imports — ~11 modules)
# Internal: ../shared/ for types, constants, logger, errors, env, console, async
# Services: ../services/github/, ../services/session/, ../services/setup/, ../services/cache/
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: move agent/ to features/ layer"
```

### Task 7: Move triggers/ module

```bash
git mv src/lib/triggers src/features/triggers
# Update imports
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: move triggers/ to features/ layer"
```

### Task 8: Move remaining feature modules

Move these in one batch (they're smaller and less cross-dependent):

```bash
git mv src/lib/reviews src/features/reviews
git mv src/lib/comments src/features/comments
git mv src/lib/context src/features/context
git mv src/lib/attachments src/features/attachments
git mv src/lib/delegated src/features/delegated
git mv src/lib/observability src/features/observability
# Update ALL imports for all 6 modules
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: move reviews, comments, context, attachments, delegated, observability to features/ layer"
```

### Task 9: Clean up lib/ directory

After all moves, `src/lib/` should be empty (or only contain `test-helpers.ts`). Move test helpers to an appropriate location.

```bash
git mv src/lib/test-helpers.ts src/shared/test-helpers.ts  # or keep at src/ level
rmdir src/lib  # should be empty
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: remove empty lib/ directory"
```

---

## Phase 4: Create `harness/` Layer

This is the most complex phase — it involves extracting `main.ts` into composable phases.

### Task 10: Create harness/config/ from standalone files

**Files:**

- Move: `src/lib/inputs.ts` → `src/harness/config/inputs.ts` (if not already moved; it may still be in lib/ or already cleaned up)
- Move: `src/lib/inputs.test.ts` → `src/harness/config/inputs.test.ts`
- Move: `src/lib/outputs.ts` → `src/harness/config/outputs.ts`
- Move: `src/lib/outputs.test.ts` → `src/harness/config/outputs.test.ts`
- Move: `src/lib/state-keys.ts` → `src/harness/config/state-keys.ts`
- Move: `src/lib/state-keys.test.ts` → `src/harness/config/state-keys.test.ts`
- Create: `src/harness/config/omo-providers.ts` (extract from inputs.ts)
- Create: `src/harness/config/index.ts`

NOTE: `inputs.ts`, `outputs.ts`, `state-keys.ts` may still be in `lib/` if they weren't moved earlier. Check their location first. If lib/ was already cleaned up, they might need to move from wherever they ended up.

**Step 1: Create directory and move**

```bash
mkdir -p src/harness/config
# Move the files (paths depend on current location)
```

**Step 2: Extract omo-providers.ts**

Create `src/harness/config/omo-providers.ts` containing:

- `VALID_OMO_PROVIDERS` const array
- `parseOmoProviders()` function (canonical version)
- Export the `OmoProviders` type (or `OmoInstallOptions` — unify to one name)

Then update `inputs.ts` to import from `./omo-providers.js` instead of having its own copy.

**Step 3: Verify + Commit**

```bash
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: create harness/config/ from action I/O files + extract omo-providers"
```

### Task 11: Extract harness phases from main.ts

This is the biggest single task. Read `main.ts` carefully and extract each step into a phase function.

**Files:**

- Create: `src/harness/phases/bootstrap.ts`
- Create: `src/harness/phases/routing.ts`
- Create: `src/harness/phases/acknowledge.ts`
- Create: `src/harness/phases/cache-restore.ts`
- Create: `src/harness/phases/session-prep.ts`
- Create: `src/harness/phases/execute.ts`
- Create: `src/harness/phases/finalize.ts`
- Create: `src/harness/phases/index.ts`
- Create: `src/harness/run.ts`
- Modify: `src/main.ts` → thin entry point

**Phase function pattern:**

Each phase function:

1. Takes typed input (previous phase results + shared context)
2. Returns typed output (for next phase)
3. Creates its own logger with appropriate phase name
4. Handles errors with appropriate granularity

```typescript
// Example: src/harness/phases/bootstrap.ts
import type {ActionInputs} from "../config/index.js"
import type {Logger} from "../../shared/logger.js"
import type {EnsureOpenCodeResult} from "../../features/agent/index.js"

export interface BootstrapResult {
  readonly inputs: ActionInputs
  readonly opencodeResult: EnsureOpenCodeResult
}

export async function runBootstrap(logger: Logger): Promise<BootstrapResult | null> {
  // Steps 1-2 of current main.ts:
  // 1. parseActionInputs()
  // 2. ensureOpenCodeAvailable()
  // Return null on failure (caller handles core.setFailed)
}
```

**`harness/run.ts`** composes all phases:

```typescript
export async function run(): Promise<number> {
  const startTime = Date.now()
  const logger = createLogger({phase: "bootstrap"})
  const metrics = createMetricsCollector()
  metrics.start()

  // Phase 1: Bootstrap
  const bootstrap = await runBootstrap(logger)
  if (bootstrap == null) return 1

  // Phase 2: Routing
  const routing = await runRouting(bootstrap, logger)
  if (routing == null) return 0 // skip

  // ... etc through all phases

  return exitCode
}
```

**`src/main.ts`** becomes:

```typescript
import {run} from "./harness/run.js"
import process from "node:process"

await run().then(exitCode => {
  process.exit(exitCode)
})
```

**Step 1: Create phase files**

Extract each group of steps from main.ts into its own phase file. Keep the exact same logic — this is a MOVE, not a rewrite.

**Step 2: Create run.ts**

Compose the phases. The try/catch/finally structure from main.ts moves here.

**Step 3: Thin out main.ts**

Replace the entire body with a 3-line import-and-call.

**Step 4: Verify**

```bash
pnpm check-types && pnpm test
```

The black-box integration test in `src/main.test.ts` must still pass — it spawns Node to test the bundled artifact.

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor: extract main.ts into harness phases"
```

### Task 12: Move post.ts logic to harness

**Files:**

- Create: `src/harness/post.ts` (business logic from current post.ts)
- Modify: `src/post.ts` → thin entry point

```typescript
// src/post.ts
import {runPost} from "./harness/post.js"
await runPost()
```

```bash
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: move post.ts logic to harness/post.ts"
```

---

## Phase 5: Deduplicate

### Task 13: Remove parseOmoProviders from setup.ts

**Files:**

- Modify: `src/services/setup/setup.ts`

Remove:

- `VALID_OMO_PROVIDERS` const (lines 24-33)
- `parseOmoProviders()` function (lines 35-83)

Import from canonical location:

```typescript
import {parseOmoProviders} from "../../harness/config/omo-providers.js"
```

```bash
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: deduplicate parseOmoProviders — single source in harness/config"
```

### Task 14: Make setup.ts receive parsed inputs

**Files:**

- Modify: `src/services/setup/setup.ts`
- Modify: `src/services/setup/types.ts`
- Modify: wherever `runSetup()` is called

Change `runSetup()` signature:

```typescript
// Before
export async function runSetup(): Promise<SetupResult | null>

// After
export async function runSetup(inputs: ActionInputs, githubToken: string): Promise<SetupResult | null>
```

Remove `parseSetupInputs()` entirely. Replace all `core.getInput()` calls inside `runSetup()` with reads from the `inputs` parameter.

Remove the cache restore logic at the bottom of `runSetup()` (lines 318-340) — this is now handled by `services/cache/`.

```bash
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: setup receives parsed inputs — eliminate dual input parsing"
```

### Task 15: Create CacheKeyComponents factory

**Files:**

- Modify: `src/services/cache/cache-key.ts`

Add a factory function:

```typescript
export function buildCacheKeyComponents(): CacheKeyComponents {
  return {
    agentIdentity: "github",
    repo: getGitHubRepository(),
    ref: getGitHubRefName(),
    os: getRunnerOS(),
  }
}
```

Replace the 3 places that manually construct `CacheKeyComponents` (main.ts finally block, post.ts, setup.ts) with this factory.

```bash
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: centralize CacheKeyComponents construction"
```

---

## Phase 6: Split Oversized Files

### Task 16: Split agent/opencode.ts (876L) → 4 files

**Files:**

- Split: `src/features/agent/opencode.ts`
- Create: `src/features/agent/server.ts` — SDK server spawn, port selection, health check
- Create: `src/features/agent/execution.ts` — Session creation, prompt sending, result collection
- Create: `src/features/agent/streaming.ts` — Event stream subscription, progress logging
- Create: `src/features/agent/retry.ts` — Retry logic, connection backoff
- Modify: `src/features/agent/index.ts` — Update re-exports
- Delete: `src/features/agent/opencode.ts` (after all content moved)

Read `opencode.ts` carefully. Identify function boundaries:

- Server bootstrap functions → `server.ts`
- Execute/prompt functions → `execution.ts`
- Event streaming/SSE handlers → `streaming.ts`
- Retry/backoff/error recovery → `retry.ts`

Keep existing tests passing by updating imports.

```bash
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: split agent/opencode.ts into server, execution, streaming, retry modules"
```

### Task 17: Split triggers/router.ts (892L) → 3 files

**Files:**

- Split: `src/features/triggers/router.ts`
- Create: `src/features/triggers/skip-conditions.ts` — All `should*Skip*()` functions
- Create: `src/features/triggers/context-builders.ts` — Per-event TriggerContext builders
- Keep: `src/features/triggers/router.ts` — Core `routeEvent()` dispatch only
- Modify: `src/features/triggers/index.ts`

Read `router.ts`. The file likely has:

1. Core routing dispatch (keep in `router.ts`)
2. Skip condition checks (`shouldSkip*`) → `skip-conditions.ts`
3. Context building for each event type → `context-builders.ts`

```bash
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: split triggers/router.ts into router, skip-conditions, context-builders"
```

### Task 18: Split session/storage.ts (631L) → 3 files

**Files:**

- Split: `src/services/session/storage.ts`
- Create: `src/services/session/storage-read.ts` — Read operations
- Create: `src/services/session/storage-write.ts` — Write operations
- Create: `src/services/session/discovery.ts` — Project discovery
- Modify: `src/services/session/index.ts`

```bash
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: split session/storage.ts into read, write, discovery modules"
```

### Task 19: Split services/cache/ into separate files

**Files:**

- Split: `src/services/cache/cache.ts` (328L)
- Create: `src/services/cache/restore.ts` — `restoreCache()` + corruption/version checks
- Create: `src/services/cache/save.ts` — `saveCache()` + auth cleanup
- Create: `src/services/cache/types.ts` — `CacheAdapter`, option interfaces
- Keep internal helpers where they logically belong
- Modify: `src/services/cache/index.ts`

```bash
pnpm check-types && pnpm test
git add -A && git commit -m "refactor: split cache module into restore, save, types"
```

---

## Phase 7: Documentation Updates

### Task 20: Update AGENTS.md

Rewrite the structure diagram, code map, and all file path references to reflect the new layer structure.

Key sections to update:

- STRUCTURE tree diagram
- WHERE TO LOOK table
- CODE MAP table
- EXECUTION FLOW diagram
- COMPLEXITY HOTSPOTS table

### Task 21: Update RULES.md

Update any module structure references, import patterns, and architecture descriptions.

### Task 22: Update .github/copilot-instructions.md

Update file path references, structure diagram, and import examples.

### Task 23: Update RFCs

For each RFC that references `src/lib/` paths, update to new layer paths. Relevant RFCs:

- RFC-001 (Foundation) — types, constants paths
- RFC-002 (Cache) — cache module paths
- RFC-004 (Sessions) — session module paths
- RFC-005 (Triggers) — triggers module paths
- RFC-007 (Observability) — observability paths
- RFC-008 (Comments) — comments paths
- RFC-009 (PR Review) — reviews paths
- RFC-011 (Setup) — setup paths
- RFC-012 (Execution) — agent, main.ts paths
- RFC-013 (SDK Mode) — agent execution paths
- RFC-014 (Attachments) — attachments paths
- RFC-017 (Post-Action) — post.ts paths

### Task 24: Update module-level AGENTS.md files

Each module directory has its own `AGENTS.md`. Update file paths and cross-references.

### Task 25: Create shared/AGENTS.md

New knowledge base doc for the shared layer.

```bash
pnpm check-types && pnpm test && pnpm lint && pnpm build
git add -A && git commit -m "docs: update all documentation for layered architecture"
```

---

## Phase 8: Final Verification

### Task 26: Full verification suite

```bash
pnpm check-types    # TypeScript compiles
pnpm test           # All 350+ tests pass
pnpm lint           # ESLint clean
pnpm build          # Bundle to dist/
git diff dist/      # Verify dist/ is in sync
```

### Task 27: Layer dependency audit

Verify no upward imports exist:

- `shared/` must NOT import from `services/`, `features/`, or `harness/`
- `services/` must NOT import from `features/` or `harness/`
- `features/` must NOT import from `harness/`

Use grep to check:

```bash
# shared/ should not import from upper layers
grep -r "from.*services/" src/shared/ || echo "OK: no upward imports"
grep -r "from.*features/" src/shared/ || echo "OK: no upward imports"
grep -r "from.*harness/" src/shared/ || echo "OK: no upward imports"
# services/ should not import from upper layers
grep -r "from.*features/" src/services/ || echo "OK: no upward imports"
grep -r "from.*harness/" src/services/ || echo "OK: no upward imports"
# features/ should not import from harness
grep -r "from.*harness/" src/features/ || echo "OK: no upward imports"
```

If violations exist, fix them by moving the shared dependency down to the appropriate layer.

---

## Execution Order Summary

| #     | Task                                          | Phase | Risk   |
| ----- | --------------------------------------------- | ----- | ------ |
| 1     | Create shared/ from utils/ + lib/ standalones | 1     | Medium |
| 2     | Move github/ → services/                      | 2     | Low    |
| 3     | Move session/ → services/                     | 2     | Low    |
| 4     | Move setup/ → services/                       | 2     | Low    |
| 5     | Create services/cache/                        | 2     | Low    |
| 6     | Move agent/ → features/                       | 3     | Medium |
| 7     | Move triggers/ → features/                    | 3     | Medium |
| 8     | Move remaining → features/                    | 3     | Medium |
| 9     | Clean up empty lib/                           | 3     | Low    |
| 10    | Create harness/config/                  | 4     | Medium |
| 11    | Extract main.ts into phases                   | 4     | HIGH   |
| 12    | Move post.ts logic                            | 4     | Low    |
| 13    | Deduplicate parseOmoProviders                 | 5     | Low    |
| 14    | Setup receives parsed inputs                  | 5     | Medium |
| 15    | CacheKeyComponents factory                    | 5     | Low    |
| 16    | Split opencode.ts                             | 6     | HIGH   |
| 17    | Split router.ts                               | 6     | HIGH   |
| 18    | Split storage.ts                              | 6     | Medium |
| 19    | Split cache.ts                                | 6     | Low    |
| 20-25 | Documentation updates                         | 7     | Low    |
| 26-27 | Final verification + audit                    | 8     | Low    |
