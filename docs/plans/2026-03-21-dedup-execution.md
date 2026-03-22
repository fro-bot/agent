# Execution Deduplication Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent redundant agent invocations when multiple PR/issue events fire for the same entity within a short window (e.g., `synchronize` followed by `review_requested`).

**Architecture:** Use `@actions/cache` with lightweight sentinel files to track recent agent completions per entity (PR/issue number). A new `dedup` harness phase between `routing` and `acknowledge` checks for a recent sentinel before proceeding. After successful execution, the sentinel is saved. The dedup window is configurable via a new `dedup-window` action input (default: 10 minutes, 0 = disabled).

**Tech Stack:** TypeScript ESM, `@actions/cache`, Vitest, existing `CacheAdapter` pattern

---

## Context

### Problem

In repos where Fro Bot triggers on multiple PR events (`synchronize`, `review_requested`, `ready_for_review`, `opened`, `reopened`), a single user action can cause a cascade of events. Example: pushing commits triggers `synchronize`, then an automated review request triggers `review_requested`. With `cancel-in-progress: false` (the recommended concurrency setting), both runs execute sequentially — the agent runs twice for the same PR state.

### Solution

Before execution, check if a dedup sentinel exists in the GitHub Actions cache for this entity. If a recent sentinel is found (within the dedup window), skip execution. After successful execution, save a sentinel.

### Dedup Scope

- `pull_request` events: dedup on PR number
- `issues` events: dedup on issue number
- All other event types (comments, schedule, dispatch): no dedup (each is unique)

### Cache Key Design

- **Save key:** `fro-bot-dedup-v1-{sanitized_repo}-{entity_type}-{entity_number}-{run_id}`
- **Restore keys:** `['fro-bot-dedup-v1-{sanitized_repo}-{entity_type}-{entity_number}-']` (prefix match → most recent)
- **Sentinel path:** `/tmp/fro-bot-dedup/sentinel.json`
- **Sentinel content:** `{ timestamp, runId, action, eventType, entityType, entityNumber }`

### Phase Insertion Point

```
bootstrap → routing → [DEDUP] → acknowledge → cache-restore → session-prep → execute → finalize → [DEDUP SAVE] → cleanup
```

### Key Files Reference

- `src/harness/run.ts` — Phase orchestration (97 lines)
- `src/harness/phases/routing.ts` — Returns null to skip, sets outputs (87 lines)
- `src/harness/config/inputs.ts` — Input parsing with `parseTimeoutMs` reusable (224 lines)
- `src/shared/types.ts` — `ActionInputs` interface (112 lines)
- `src/shared/constants.ts` — Default values (37 lines)
- `src/services/cache/types.ts` — `CacheAdapter` interface (38 lines)
- `src/services/cache/save.ts` — Pattern for cache save with "already exists" handling (114 lines)
- `src/features/triggers/types.ts` — `TriggerContext`, `TriggerTarget` with `kind` and `number` (205 lines)
- `action.yaml` — Action input definitions (79 lines)

### Conventions (from AGENTS.md)

- ESM-only with `.js` extensions in imports
- Functions only (no classes)
- Logger injection in every function
- `readonly` interfaces
- Strict boolean expressions (`!= null`, not `!value`)
- Result types for recoverable errors
- Vitest with BDD comments (`// #given`, `// #when`, `// #then`)
- `CacheAdapter` injection for testable I/O

---

## Task 1: Add Constants

**Files:**

- Modify: `src/shared/constants.ts`

**Step 1: Add dedup constants**

Add after the existing cache constants (line 34):

```typescript
// Dedup execution defaults
export const DEFAULT_DEDUP_WINDOW_MS = 600_000 // 10 minutes
export const DEDUP_CACHE_PREFIX = "fro-bot-dedup-v1" as const
export const DEDUP_SENTINEL_DIR = "/tmp/fro-bot-dedup" as const
export const DEDUP_SENTINEL_FILENAME = "sentinel.json" as const
```

**Step 2: Verify**

Run: `pnpm check-types` Expected: PASS

**Step 3: Commit**

```bash
git add src/shared/constants.ts
git commit -m "feat(dedup): add dedup execution constants"
```

---

## Task 2: Add `dedupWindow` to ActionInputs

**Files:**

- Modify: `src/shared/types.ts` (line ~64, after `opencodeConfig`)
- Modify: `src/harness/config/inputs.ts` (add parsing)
- Modify: `src/harness/config/inputs.test.ts` (add tests)
- Modify: `action.yaml` (add input)

**Step 1: Add to ActionInputs interface**

In `src/shared/types.ts`, add to `ActionInputs` after `opencodeConfig`:

```typescript
  // Dedup execution: skip if agent already ran for this entity recently
  readonly dedupWindow: number
```

**Step 2: Add action.yaml input**

In `action.yaml`, add after the `omo-config` input (before `outputs:`):

```yaml
dedup-window:
  description: >-
    Deduplication window in milliseconds. Skip execution if the agent already ran for the same PR or issue within this window. 0 = disabled. Default: 600000 (10 minutes)

  required: false
  default: "600000"
```

**Step 3: Parse input in inputs.ts**

In `src/harness/config/inputs.ts`, add import of `DEFAULT_DEDUP_WINDOW_MS`:

```typescript
import {
  DEFAULT_AGENT,
  DEFAULT_DEDUP_WINDOW_MS,
  DEFAULT_OMO_PROVIDERS,
  // ... rest
} from "../../shared/constants.js"
```

Add parsing before the `return ok({...})` block (after `opencodeConfig` validation):

```typescript
const dedupWindowRaw = core.getInput("dedup-window").trim()
const dedupWindow = dedupWindowRaw.length > 0 ? parseTimeoutMs(dedupWindowRaw) : DEFAULT_DEDUP_WINDOW_MS
```

Add `dedupWindow` to the return object.

**Step 4: Write tests in inputs.test.ts**

Add test for dedup-window parsing — find the existing test pattern for optional numeric inputs (like `timeout`). Add:

```typescript
it("parses dedup-window with custom value", () => {
  // #given inputs with custom dedup-window
  mockInput("dedup-window", "300000")
  // ... other required inputs

  // #when parsing inputs
  const result = parseActionInputs()

  // #then dedupWindow should be parsed
  expect(isOk(result) && result.value.dedupWindow).toBe(300000)
})

it("uses default dedup-window when not provided", () => {
  // #given inputs without dedup-window
  // ... required inputs only

  // #when parsing inputs
  const result = parseActionInputs()

  // #then dedupWindow should be default (600000)
  expect(isOk(result) && result.value.dedupWindow).toBe(600000)
})

it("allows zero dedup-window to disable dedup", () => {
  // #given inputs with dedup-window = 0
  mockInput("dedup-window", "0")

  // #when parsing inputs
  const result = parseActionInputs()

  // #then dedupWindow should be 0
  expect(isOk(result) && result.value.dedupWindow).toBe(0)
})
```

**Step 5: Verify**

Run: `pnpm test src/harness/config/inputs.test.ts && pnpm check-types` Expected: All tests PASS, types clean

**Step 6: Commit**

```bash
git add src/shared/types.ts src/harness/config/inputs.ts src/harness/config/inputs.test.ts action.yaml
git commit -m "feat(dedup): add dedup-window action input"
```

---

## Task 3: Implement Sentinel Cache Operations

**Files:**

- Create: `src/services/cache/dedup.ts`
- Create: `src/services/cache/dedup.test.ts`

**Step 1: Write the tests first**

Create `src/services/cache/dedup.test.ts`:

```typescript
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import {createMockLogger} from "../../shared/test-helpers.js"
import {DEDUP_SENTINEL_DIR, DEDUP_SENTINEL_FILENAME} from "../../shared/constants.js"
import type {CacheAdapter} from "./types.js"
import type {DeduplicationMarker} from "./dedup.js"
import {restoreDeduplicationMarker, saveDeduplicationMarker} from "./dedup.js"

function createMockCacheAdapter(overrides?: Partial<CacheAdapter>): CacheAdapter {
  return {
    restoreCache: vi.fn().mockResolvedValue(undefined),
    saveCache: vi.fn().mockResolvedValue(0),
    ...overrides,
  }
}

const SENTINEL_PATH = path.join(DEDUP_SENTINEL_DIR, DEDUP_SENTINEL_FILENAME)

const TEST_ENTITY = {entityType: "pr", entityNumber: 42}
const TEST_REPO = "owner/repo"
const TEST_MARKER: DeduplicationMarker = {
  timestamp: "2026-03-21T12:00:00.000Z",
  runId: 12345,
  action: "synchronize",
  eventType: "pull_request",
  entityType: "pr",
  entityNumber: 42,
}

describe("restoreDeduplicationMarker", () => {
  const logger = createMockLogger()

  afterEach(async () => {
    await fs.rm(DEDUP_SENTINEL_DIR, {recursive: true, force: true})
  })

  it("returns null when no sentinel exists", async () => {
    // #given no cached sentinel
    const adapter = createMockCacheAdapter()

    // #when restoring
    const result = await restoreDeduplicationMarker(TEST_REPO, TEST_ENTITY, logger, adapter)

    // #then returns null
    expect(result).toBeNull()
    expect(adapter.restoreCache).toHaveBeenCalled()
  })

  it("returns marker when sentinel exists and is valid JSON", async () => {
    // #given a cached sentinel file
    const adapter = createMockCacheAdapter({
      restoreCache: vi.fn().mockImplementation(async () => {
        await fs.mkdir(DEDUP_SENTINEL_DIR, {recursive: true})
        await fs.writeFile(SENTINEL_PATH, JSON.stringify(TEST_MARKER), "utf8")
        return "fro-bot-dedup-v1-owner-repo-pr-42-12345"
      }),
    })

    // #when restoring
    const result = await restoreDeduplicationMarker(TEST_REPO, TEST_ENTITY, logger, adapter)

    // #then returns the parsed marker
    expect(result).toEqual(TEST_MARKER)
  })

  it("returns null when cache restore throws", async () => {
    // #given cache adapter that throws
    const adapter = createMockCacheAdapter({
      restoreCache: vi.fn().mockRejectedValue(new Error("network error")),
    })

    // #when restoring
    const result = await restoreDeduplicationMarker(TEST_REPO, TEST_ENTITY, logger, adapter)

    // #then returns null (fail-open)
    expect(result).toBeNull()
  })

  it("passes correct restore keys with prefix matching", async () => {
    // #given a mock adapter
    const adapter = createMockCacheAdapter()

    // #when restoring
    await restoreDeduplicationMarker(TEST_REPO, TEST_ENTITY, logger, adapter)

    // #then restore keys use prefix pattern
    const restoreCall = vi.mocked(adapter.restoreCache).mock.calls[0]
    expect(restoreCall?.[2]).toEqual(["fro-bot-dedup-v1-owner-repo-pr-42-"])
  })
})

describe("saveDeduplicationMarker", () => {
  const logger = createMockLogger()

  afterEach(async () => {
    await fs.rm(DEDUP_SENTINEL_DIR, {recursive: true, force: true})
  })

  it("saves sentinel with correct cache key", async () => {
    // #given a marker to save
    const adapter = createMockCacheAdapter()

    // #when saving
    const result = await saveDeduplicationMarker(TEST_REPO, TEST_ENTITY, TEST_MARKER, logger, adapter)

    // #then saves with run-specific key
    expect(result).toBe(true)
    const saveCall = vi.mocked(adapter.saveCache).mock.calls[0]
    expect(saveCall?.[1]).toBe("fro-bot-dedup-v1-owner-repo-pr-42-12345")
  })

  it("writes sentinel file with marker content", async () => {
    // #given a marker to save
    const adapter = createMockCacheAdapter()

    // #when saving
    await saveDeduplicationMarker(TEST_REPO, TEST_ENTITY, TEST_MARKER, logger, adapter)

    // #then sentinel file contains the marker JSON
    const content = await fs.readFile(SENTINEL_PATH, "utf8")
    expect(JSON.parse(content)).toEqual(TEST_MARKER)
  })

  it("returns true when cache key already exists", async () => {
    // #given adapter that throws "already exists"
    const adapter = createMockCacheAdapter({
      saveCache: vi.fn().mockRejectedValue(new Error("Cache already exists")),
    })

    // #when saving
    const result = await saveDeduplicationMarker(TEST_REPO, TEST_ENTITY, TEST_MARKER, logger, adapter)

    // #then returns true (idempotent)
    expect(result).toBe(true)
  })

  it("returns false when save fails", async () => {
    // #given adapter that throws
    const adapter = createMockCacheAdapter({
      saveCache: vi.fn().mockRejectedValue(new Error("network error")),
    })

    // #when saving
    const result = await saveDeduplicationMarker(TEST_REPO, TEST_ENTITY, TEST_MARKER, logger, adapter)

    // #then returns false (best-effort)
    expect(result).toBe(false)
  })
})
```

**Step 2: Run tests to confirm they fail**

Run: `pnpm test src/services/cache/dedup.test.ts` Expected: FAIL (module not found)

**Step 3: Implement `src/services/cache/dedup.ts`**

```typescript
import type {CacheAdapter} from "./types.js"
import type {Logger} from "../../shared/logger.js"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import {DEDUP_CACHE_PREFIX, DEDUP_SENTINEL_DIR, DEDUP_SENTINEL_FILENAME} from "../../shared/constants.js"
import {toErrorMessage} from "../../shared/errors.js"
import {defaultCacheAdapter} from "./types.js"

export interface DeduplicationMarker {
  readonly timestamp: string
  readonly runId: number
  readonly action: string
  readonly eventType: string
  readonly entityType: string
  readonly entityNumber: number
}

export interface DeduplicationEntity {
  readonly entityType: string
  readonly entityNumber: number
}

function sanitizeRepoName(repo: string): string {
  return repo.replaceAll("/", "-")
}

function buildDedupRestoreKeys(repo: string, entity: DeduplicationEntity): string[] {
  const sanitizedRepo = sanitizeRepoName(repo)
  return [`${DEDUP_CACHE_PREFIX}-${sanitizedRepo}-${entity.entityType}-${entity.entityNumber}-`]
}

export function buildDedupSaveKey(repo: string, entity: DeduplicationEntity, runId: number): string {
  const sanitizedRepo = sanitizeRepoName(repo)
  return `${DEDUP_CACHE_PREFIX}-${sanitizedRepo}-${entity.entityType}-${entity.entityNumber}-${runId}`
}

function getSentinelPath(): string {
  return path.join(DEDUP_SENTINEL_DIR, DEDUP_SENTINEL_FILENAME)
}

export async function restoreDeduplicationMarker(
  repo: string,
  entity: DeduplicationEntity,
  logger: Logger,
  cacheAdapter: CacheAdapter = defaultCacheAdapter,
): Promise<DeduplicationMarker | null> {
  const sentinelPath = getSentinelPath()
  const restoreKeys = buildDedupRestoreKeys(repo, entity)

  try {
    await fs.rm(DEDUP_SENTINEL_DIR, {recursive: true, force: true})
    await fs.mkdir(DEDUP_SENTINEL_DIR, {recursive: true})

    const restoredKey = await cacheAdapter.restoreCache([sentinelPath], "", restoreKeys)
    if (restoredKey == null) {
      logger.debug("No dedup sentinel found", {restoreKeys})
      return null
    }

    const content = await fs.readFile(sentinelPath, "utf8")
    const marker: DeduplicationMarker = JSON.parse(content)
    logger.debug("Dedup sentinel restored", {key: restoredKey, marker})
    return marker
  } catch (error) {
    logger.debug("Failed to restore dedup sentinel", {error: toErrorMessage(error)})
    return null
  }
}

export async function saveDeduplicationMarker(
  repo: string,
  entity: DeduplicationEntity,
  marker: DeduplicationMarker,
  logger: Logger,
  cacheAdapter: CacheAdapter = defaultCacheAdapter,
): Promise<boolean> {
  const sentinelPath = getSentinelPath()
  const saveKey = buildDedupSaveKey(repo, entity, marker.runId)

  try {
    await fs.mkdir(DEDUP_SENTINEL_DIR, {recursive: true})
    await fs.writeFile(sentinelPath, JSON.stringify(marker), "utf8")
    await cacheAdapter.saveCache([sentinelPath], saveKey)
    logger.debug("Dedup sentinel saved", {key: saveKey})
    return true
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) {
      logger.debug("Dedup sentinel key already exists", {key: saveKey})
      return true
    }
    logger.debug("Failed to save dedup sentinel", {error: toErrorMessage(error)})
    return false
  }
}
```

**Step 4: Run tests**

Run: `pnpm test src/services/cache/dedup.test.ts` Expected: All PASS

**Step 5: Verify types**

Run: `pnpm check-types` Expected: PASS

**Step 6: Commit**

```bash
git add src/services/cache/dedup.ts src/services/cache/dedup.test.ts
git commit -m "feat(dedup): add sentinel cache operations for execution dedup"
```

---

## Task 4: Implement Dedup Phase

**Files:**

- Create: `src/harness/phases/dedup.ts`
- Create: `src/harness/phases/dedup.test.ts`

**Step 1: Write failing tests first**

Create `src/harness/phases/dedup.test.ts`:

Test cases:

1. Returns `shouldProceed: true` when dedup window is 0 (disabled)
2. Returns `shouldProceed: true` for non-deduplicable event types (issue_comment)
3. Returns `shouldProceed: true` when no sentinel exists (cache miss)
4. Returns `shouldProceed: true` when sentinel is expired (marker age > window)
5. Returns `shouldProceed: true` when sentinel is from current run ID
6. Returns `shouldProceed: false` when recent sentinel exists within window
7. Returns `shouldProceed: false` for issue events with recent sentinel
8. Returns correct entity for PR events (`{ entityType: 'pr', entityNumber: N }`)
9. Returns null entity for comment events (no dedup)

The tests mock the cache adapter and construct minimal TriggerContext/BootstrapPhaseResult objects. Follow the existing test patterns from `skip-conditions-pr.test.ts`.

**Step 2: Implement `src/harness/phases/dedup.ts`**

```typescript
import type {DeduplicationEntity, DeduplicationMarker} from "../../services/cache/dedup.js"
import type {TriggerContext} from "../../features/triggers/types.js"
import type {CacheAdapter} from "../../services/cache/types.js"
import type {Logger} from "../../shared/logger.js"
import {restoreDeduplicationMarker, saveDeduplicationMarker} from "../../services/cache/dedup.js"
import {createLogger} from "../../shared/logger.js"
import {setActionOutputs} from "../config/outputs.js"

export interface DedupCheckResult {
  readonly shouldProceed: boolean
  readonly entity: DeduplicationEntity | null
}

const DEDUP_EVENT_TYPES = new Set(["pull_request", "issues"])

export function extractDedupEntity(context: TriggerContext): DeduplicationEntity | null {
  if (context.target == null) return null
  if (!DEDUP_EVENT_TYPES.has(context.eventType)) return null
  if (context.target.kind === "pr") return {entityType: "pr", entityNumber: context.target.number}
  if (context.target.kind === "issue") return {entityType: "issue", entityNumber: context.target.number}
  return null
}

export async function runDedup(
  dedupWindow: number,
  triggerContext: TriggerContext,
  repo: string,
  startTime: number,
  logger?: Logger,
  cacheAdapter?: CacheAdapter,
): Promise<DedupCheckResult> {
  const dedupLogger = logger ?? createLogger({phase: "dedup"})
  const entity = extractDedupEntity(triggerContext)

  if (dedupWindow === 0) {
    dedupLogger.debug("Dedup disabled (window = 0)")
    return {shouldProceed: true, entity}
  }

  if (entity == null) {
    dedupLogger.debug("No dedup entity for this event type", {eventType: triggerContext.eventType})
    return {shouldProceed: true, entity: null}
  }

  const marker = await restoreDeduplicationMarker(repo, entity, dedupLogger, cacheAdapter)

  if (marker == null) {
    dedupLogger.debug("No prior execution found")
    return {shouldProceed: true, entity}
  }

  if (marker.runId === triggerContext.runId) {
    dedupLogger.debug("Marker is from current run, proceeding")
    return {shouldProceed: true, entity}
  }

  const markerAge = Date.now() - new Date(marker.timestamp).getTime()
  if (markerAge > dedupWindow) {
    dedupLogger.debug("Prior execution expired", {markerAgeMs: markerAge, dedupWindowMs: dedupWindow})
    return {shouldProceed: true, entity}
  }

  dedupLogger.info("Skipping execution — agent ran for this entity recently", {
    entityType: entity.entityType,
    entityNumber: entity.entityNumber,
    priorRunId: marker.runId,
    priorAction: marker.action,
    markerAgeMs: markerAge,
  })

  setActionOutputs({
    sessionId: null,
    cacheStatus: "miss",
    duration: Date.now() - startTime,
  })

  return {shouldProceed: false, entity}
}

export async function saveDedupMarker(
  triggerContext: TriggerContext,
  entity: DeduplicationEntity,
  repo: string,
  logger?: Logger,
  cacheAdapter?: CacheAdapter,
): Promise<void> {
  const dedupLogger = logger ?? createLogger({phase: "dedup-save"})
  const marker: DeduplicationMarker = {
    timestamp: new Date().toISOString(),
    runId: triggerContext.runId,
    action: triggerContext.action ?? "unknown",
    eventType: triggerContext.eventType,
    entityType: entity.entityType,
    entityNumber: entity.entityNumber,
  }

  await saveDeduplicationMarker(repo, entity, marker, dedupLogger, cacheAdapter)
}
```

**Step 3: Run tests**

Run: `pnpm test src/harness/phases/dedup.test.ts` Expected: All PASS

**Step 4: Commit**

```bash
git add src/harness/phases/dedup.ts src/harness/phases/dedup.test.ts
git commit -m "feat(dedup): add dedup harness phase"
```

---

## Task 5: Wire Dedup Phase into run.ts

**Files:**

- Modify: `src/harness/run.ts`

**Step 1: Import the dedup phase**

Add imports:

```typescript
import {runDedup, saveDedupMarker} from "./phases/dedup.js"
```

**Step 2: Add dedup check after routing, before acknowledge**

After `const routing = await runRouting(...)` and before `reactionCtx = await runAcknowledge(...)`:

```typescript
const repo = `${routing.triggerResult.context.repo.owner}/${routing.triggerResult.context.repo.repo}`
const dedup = await runDedup(bootstrap.inputs.dedupWindow, routing.triggerResult.context, repo, startTime)
if (!dedup.shouldProceed) return 0
```

**Step 3: Add dedup save after successful execution**

After `agentSuccess = execution.success`, before `metrics.end()`:

```typescript
if (agentSuccess && dedup.entity != null) {
  await saveDedupMarker(routing.triggerResult.context, dedup.entity, repo)
}
```

**Step 4: Verify**

Run: `pnpm test && pnpm check-types` Expected: All tests PASS, types clean

**Step 5: Commit**

```bash
git add src/harness/run.ts
git commit -m "feat(dedup): wire dedup phase into main execution flow"
```

---

## Task 6: Build and Full Verification

**Step 1: Run full test suite**

Run: `pnpm test` Expected: All tests PASS (should be ~1000+ tests)

**Step 2: Run lint**

Run: `pnpm lint` Expected: 0 errors (pre-existing warnings OK)

**Step 3: Run type check**

Run: `pnpm check-types` Expected: PASS

**Step 4: Build**

Run: `pnpm build` Expected: Build succeeds, dist/ updated

**Step 5: Commit dist/**

```bash
git add dist/
git commit -m "build: rebuild dist for dedup execution feature"
```

---

## Task 7: Update AGENTS.md and Phases Docs

**Files:**

- Modify: `src/harness/phases/AGENTS.md` — Add dedup phase to table and flow
- Modify: `AGENTS.md` — Add dedup to execution flow if present

Update the phase table to include:

```
| **Dedup**       | `dedup.ts`       | Skip if agent already ran for this entity (XX L) |
```

Update the execution flow:

```
bootstrap → routing → dedup → acknowledge → cache-restore → session-prep → execute → finalize → cleanup
```

**Commit:**

```bash
git add src/harness/phases/AGENTS.md AGENTS.md
git commit -m "docs: add dedup phase to architecture docs"
```
