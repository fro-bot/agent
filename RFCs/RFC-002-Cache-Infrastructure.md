# RFC-002: Cache Infrastructure

**Status:** Pending
**Priority:** MUST
**Complexity:** High
**Phase:** 1

---

## Summary

Implement the core cache infrastructure for persisting OpenCode storage across GitHub Actions runs. This is the foundational persistence layer that enables the agent's "durable memory" capability.

## Dependencies

- **Builds Upon:** RFC-001 (Foundation & Core Types)
- **Enables:** RFC-004 (Session Management), RFC-012 (Advanced Cache Features)

## Features Addressed

| Feature ID | Feature Name                   | Priority |
| ---------- | ------------------------------ | -------- |
| F17        | OpenCode Storage Cache Restore | P0       |
| F18        | OpenCode Storage Cache Save    | P0       |
| F23        | Storage Versioning             | P1       |
| F24        | Corruption Detection           | P1       |
| F25        | auth.json Exclusion            | P0       |
| F28        | Branch-Scoped Caching          | P0       |
| F50        | Concurrency Handling           | P1       |

## Technical Specification

### 1. New Dependencies

Add to `package.json`:

```json
{
  "dependencies": {
    "@actions/cache": "^5.0.0"
  }
}
```

### 2. File Structure

```
src/lib/
├── cache.ts              # Core cache operations
├── cache-key.ts          # Cache key generation
└── cache.test.ts         # Cache unit tests
```

### 3. Cache Key Generation (`src/lib/cache-key.ts`)

```typescript
import type {AgentIdentity} from "./types.js"
import {CACHE_PREFIX} from "./constants.js"

export interface CacheKeyComponents {
  readonly agentIdentity: AgentIdentity
  readonly repo: string
  readonly ref: string
  readonly os: string
}

/**
 * Generate primary cache key with full specificity.
 * Pattern: opencode-storage-{agent}-{repo}-{ref}-{os}
 */
export function buildPrimaryCacheKey(components: CacheKeyComponents): string {
  const {agentIdentity, repo, ref, os} = components
  // Sanitize repo name (replace / with -)
  const sanitizedRepo = repo.replace(/\//g, "-")
  return `${CACHE_PREFIX}-${agentIdentity}-${sanitizedRepo}-${ref}-${os}`
}

/**
 * Generate restore keys for fallback matching.
 * Ordered from most to least specific.
 */
export function buildRestoreKeys(components: CacheKeyComponents): readonly string[] {
  const {agentIdentity, repo, ref, os} = components
  const sanitizedRepo = repo.replace(/\//g, "-")

  return [
    // Same branch, any run
    `${CACHE_PREFIX}-${agentIdentity}-${sanitizedRepo}-${ref}-`,
    // Same repo, any branch
    `${CACHE_PREFIX}-${agentIdentity}-${sanitizedRepo}-`,
  ] as const
}

/**
 * Generate unique save key (includes run ID for versioning).
 */
export function buildSaveCacheKey(components: CacheKeyComponents, runId: number): string {
  return `${buildPrimaryCacheKey(components)}-${runId}`
}
```

### 4. Core Cache Operations (`src/lib/cache.ts`)

```typescript
import * as cache from "@actions/cache"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type {CacheResult, Logger} from "./types.js"
import {buildPrimaryCacheKey, buildRestoreKeys, buildSaveCacheKey, type CacheKeyComponents} from "./cache-key.js"
import {getOpenCodeStoragePath, getOpenCodeAuthPath} from "../utils/env.js"
import {STORAGE_VERSION} from "./constants.js"

export interface RestoreCacheOptions {
  readonly components: CacheKeyComponents
  readonly logger: Logger
}

export interface SaveCacheOptions {
  readonly components: CacheKeyComponents
  readonly runId: number
  readonly logger: Logger
}

/**
 * Restore OpenCode storage from cache.
 *
 * Cache miss is not an error - returns hit: false.
 * Corruption is detected and reported but does not throw.
 */
export async function restoreCache(options: RestoreCacheOptions): Promise<CacheResult> {
  const {components, logger} = options
  const storagePath = getOpenCodeStoragePath()

  const primaryKey = buildPrimaryCacheKey(components)
  const restoreKeys = buildRestoreKeys(components)

  logger.info("Restoring cache", {primaryKey, restoreKeys: [...restoreKeys]})

  try {
    // Ensure storage directory exists
    await fs.mkdir(storagePath, {recursive: true})

    const restoredKey = await cache.restoreCache([storagePath], primaryKey, [...restoreKeys])

    if (restoredKey == null) {
      logger.info("Cache miss - starting with fresh state")
      return {
        hit: false,
        key: null,
        restoredPath: null,
        corrupted: false,
      }
    }

    logger.info("Cache restored", {restoredKey})

    // Check for corruption
    const isCorrupted = await checkStorageCorruption(storagePath, logger)
    if (isCorrupted) {
      logger.warning("Cache corruption detected - proceeding with clean state")
      await cleanStorage(storagePath)
      return {
        hit: true,
        key: restoredKey,
        restoredPath: storagePath,
        corrupted: true,
      }
    }

    // Verify storage version
    const versionMatch = await checkStorageVersion(storagePath, logger)
    if (!versionMatch) {
      logger.warning("Storage version mismatch - proceeding with clean state")
      await cleanStorage(storagePath)
      return {
        hit: true,
        key: restoredKey,
        restoredPath: storagePath,
        corrupted: true, // Treat version mismatch as corruption
      }
    }

    // Delete auth.json if it somehow got cached
    await deleteAuthJson(logger)

    return {
      hit: true,
      key: restoredKey,
      restoredPath: storagePath,
      corrupted: false,
    }
  } catch (error) {
    // Cache restore failure should not fail the run
    logger.warning("Cache restore failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      hit: false,
      key: null,
      restoredPath: null,
      corrupted: false,
    }
  }
}

/**
 * Save OpenCode storage to cache.
 *
 * Always runs, even on job failure (caller should use if: always()).
 * Excludes auth.json from being saved.
 */
export async function saveCache(options: SaveCacheOptions): Promise<boolean> {
  const {components, runId, logger} = options
  const storagePath = getOpenCodeStoragePath()

  const saveKey = buildSaveCacheKey(components, runId)

  logger.info("Saving cache", {saveKey})

  try {
    // Ensure auth.json is not in storage before saving
    await deleteAuthJson(logger)

    // Write storage version marker
    await writeStorageVersion(storagePath)

    // Check if storage exists and has content
    const storageExists = await directoryHasContent(storagePath)
    if (!storageExists) {
      logger.info("No storage content to cache")
      return false
    }

    const cacheId = await cache.saveCache([storagePath], saveKey)
    logger.info("Cache saved", {cacheId, saveKey})
    return true
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) {
      // Cache with this key already exists - not an error
      logger.info("Cache key already exists, skipping save")
      return true
    }

    logger.warning("Cache save failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Delete auth.json to prevent credential caching.
 */
async function deleteAuthJson(logger: Logger): Promise<void> {
  const authPath = getOpenCodeAuthPath()
  try {
    await fs.unlink(authPath)
    logger.debug("Deleted auth.json before cache operation")
  } catch (error) {
    // File doesn't exist - that's fine
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warning("Failed to delete auth.json", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/**
 * Check for obvious storage corruption.
 */
async function checkStorageCorruption(storagePath: string, logger: Logger): Promise<boolean> {
  try {
    const stat = await fs.stat(storagePath)
    if (!stat.isDirectory()) {
      return true
    }

    // Check for required subdirectories (adjust based on OpenCode structure)
    // For now, just check if directory is readable
    await fs.readdir(storagePath)
    return false
  } catch {
    logger.debug("Storage path not accessible - treating as corrupted")
    return true
  }
}

/**
 * Check storage version compatibility.
 */
async function checkStorageVersion(storagePath: string, logger: Logger): Promise<boolean> {
  const versionFile = path.join(storagePath, ".version")
  try {
    const content = await fs.readFile(versionFile, "utf8")
    const version = Number.parseInt(content.trim(), 10)
    if (version !== STORAGE_VERSION) {
      logger.info("Storage version mismatch", {expected: STORAGE_VERSION, found: version})
      return false
    }
    return true
  } catch {
    // No version file - treat as compatible (first run or legacy)
    logger.debug("No version file found - treating as compatible")
    return true
  }
}

/**
 * Write storage version marker.
 */
async function writeStorageVersion(storagePath: string): Promise<void> {
  const versionFile = path.join(storagePath, ".version")
  await fs.mkdir(storagePath, {recursive: true})
  await fs.writeFile(versionFile, String(STORAGE_VERSION), "utf8")
}

/**
 * Clean storage directory for fresh start.
 */
async function cleanStorage(storagePath: string): Promise<void> {
  try {
    await fs.rm(storagePath, {recursive: true, force: true})
    await fs.mkdir(storagePath, {recursive: true})
  } catch {
    // Best effort - continue even if cleanup fails
  }
}

/**
 * Check if directory exists and has content.
 */
async function directoryHasContent(dirPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dirPath)
    return entries.length > 0
  } catch {
    return false
  }
}
```

### 5. Integration with Main Entry Point

Update `src/main.ts`:

```typescript
import * as core from "@actions/core"
import {parseActionInputs} from "./lib/inputs.js"
import {createLogger} from "./lib/logger.js"
import {restoreCache, saveCache} from "./lib/cache.js"
import {getRunnerOS} from "./utils/env.js"
import type {CacheKeyComponents} from "./lib/cache-key.js"

async function run(): Promise<void> {
  const startTime = Date.now()
  const logger = createLogger()

  try {
    // 1. Parse inputs
    const inputs = parseActionInputs()

    // 2. Build cache key components
    const cacheComponents: CacheKeyComponents = {
      agentIdentity: "github",
      repo: process.env["GITHUB_REPOSITORY"] ?? "unknown/unknown",
      ref: process.env["GITHUB_REF_NAME"] ?? "main",
      os: getRunnerOS(),
    }

    // 3. Restore cache (early)
    const cacheResult = await restoreCache({
      components: cacheComponents,
      logger,
    })

    core.setOutput("cache-status", cacheResult.corrupted ? "corrupted" : cacheResult.hit ? "hit" : "miss")

    // 4. Execute main logic
    // TODO: Implement agent logic in subsequent RFCs

    // 5. Set outputs
    const duration = Math.round((Date.now() - startTime) / 1000)
    core.setOutput("duration", String(duration))
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  } finally {
    // 6. Save cache (always, even on failure)
    try {
      const cacheComponents: CacheKeyComponents = {
        agentIdentity: "github",
        repo: process.env["GITHUB_REPOSITORY"] ?? "unknown/unknown",
        ref: process.env["GITHUB_REF_NAME"] ?? "main",
        os: getRunnerOS(),
      }

      await saveCache({
        components: cacheComponents,
        runId: Number(process.env["GITHUB_RUN_ID"] ?? "0"),
        logger: createLogger(),
      })
    } catch {
      // Cache save failure should not mask the original error
    }
  }
}

await run()
```

## Acceptance Criteria

- [ ] `@actions/cache` dependency added and bundled
- [ ] Cache key includes agent identity, repo, branch, and OS
- [ ] Restore keys provide fallback chain (branch → repo)
- [ ] Cache restore handles miss gracefully (no failure)
- [ ] Cache restore detects and handles corruption
- [ ] Storage version is checked on restore
- [ ] auth.json is deleted before cache save
- [ ] Cache save includes storage version marker
- [ ] Cache save handles "already exists" gracefully
- [ ] All operations are logged with structured JSON
- [ ] Unit tests cover all cache scenarios
- [ ] Integration test verifies cache operations work end-to-end

## Test Cases

### Cache Key Tests

```typescript
describe("buildPrimaryCacheKey", () => {
  it("generates correct key format", () => {
    const key = buildPrimaryCacheKey({
      agentIdentity: "github",
      repo: "owner/repo",
      ref: "main",
      os: "Linux",
    })
    expect(key).toBe("opencode-storage-github-owner-repo-main-Linux")
  })

  it("sanitizes repo name with slashes", () => {
    const key = buildPrimaryCacheKey({
      agentIdentity: "github",
      repo: "org/nested/repo",
      ref: "feature/branch",
      os: "Linux",
    })
    expect(key).toContain("org-nested-repo")
  })
})

describe("buildRestoreKeys", () => {
  it("returns keys in most-to-least specific order", () => {
    const keys = buildRestoreKeys({
      agentIdentity: "github",
      repo: "owner/repo",
      ref: "main",
      os: "Linux",
    })
    expect(keys).toHaveLength(2)
    expect(keys[0]).toContain("main")
    expect(keys[1]).not.toContain("main")
  })
})
```

### Cache Operation Tests

```typescript
describe("restoreCache", () => {
  it("returns hit: false on cache miss", async () => {
    // Mock cache.restoreCache to return undefined
    const result = await restoreCache({components, logger})
    expect(result.hit).toBe(false)
    expect(result.corrupted).toBe(false)
  })

  it("detects storage corruption", async () => {
    // Mock corrupted storage
    const result = await restoreCache({components, logger})
    expect(result.corrupted).toBe(true)
  })

  it("deletes auth.json after restore", async () => {
    // Verify auth.json is removed
  })
})

describe("saveCache", () => {
  it("writes version marker before save", async () => {
    await saveCache({components, runId: 123, logger})
    // Verify .version file exists
  })

  it('handles "already exists" error gracefully', async () => {
    // Mock cache.saveCache to throw "already exists"
    const result = await saveCache({components, runId: 123, logger})
    expect(result).toBe(true)
  })
})
```

## Security Considerations

1. **auth.json exclusion**: Always delete before save, verify after restore
2. **Branch-scoped keys**: Reduce cache poisoning risk from fork PRs
3. **No secrets in logs**: Cache keys and paths are logged, but never credential content

## Implementation Notes

1. **Bundling**: `@actions/cache` must be added to `noExternal` in tsdown config
2. **Error resilience**: Cache failures should never fail the job
3. **Idempotency**: Multiple saves with same key should not error

## Estimated Effort

- **Development**: 6-8 hours
- **Testing**: 3-4 hours
- **Total**: 9-12 hours

---

## Appendix: P1 Feature Extensions

The following sections address P1 features that extend the core cache infrastructure.

### A. Storage Versioning (F23)

**Added:** 2026-01-17

#### Purpose

Include version marker in storage directory to detect breaking format changes and enable graceful migration.

#### Implementation

The `.version` file is already implemented in the core specification above. This section provides additional context.

**Version File Location:**

```
$XDG_DATA_HOME/opencode/storage/.version
```

**Version Format:**

```
1
```

**Version Check Flow:**

```typescript
// On restore
const version = await readStorageVersion(storagePath)
if (version !== STORAGE_VERSION) {
  logger.warning("Storage version mismatch", {expected: STORAGE_VERSION, found: version})
  // Proceed with clean state, not failure
  await cleanStorage(storagePath)
}
```

**When to Increment Version:**

- Breaking changes to OpenCode session format
- Changes to storage directory structure
- Incompatible oMo plugin updates

#### Acceptance Criteria (F23)

- [x] `.version` file created in storage directory
- [x] Version checked on cache restore
- [x] Mismatch triggers clean start (not failure)
- [x] Mismatch warning in run summary

---

### B. Corruption Detection (F24)

**Added:** 2026-01-17

#### Purpose

Detect obvious corruption in restored storage and proceed safely with clean state.

#### Implementation

Extend `checkStorageCorruption()` with comprehensive checks:

```typescript
interface CorruptionCheckResult {
  readonly corrupted: boolean
  readonly reason: string | null
}

async function checkStorageCorruption(storagePath: string, logger: Logger): Promise<CorruptionCheckResult> {
  try {
    // 1. Check storage path is a directory
    const stat = await fs.stat(storagePath)
    if (!stat.isDirectory()) {
      return {corrupted: true, reason: "Storage path is not a directory"}
    }

    // 2. Check directory is readable
    const entries = await fs.readdir(storagePath)

    // 3. Check for required structure (if sessions exist)
    const sessionsPath = path.join(storagePath, "sessions")
    try {
      const sessionsStat = await fs.stat(sessionsPath)
      if (!sessionsStat.isDirectory()) {
        return {corrupted: true, reason: "Sessions path is not a directory"}
      }
    } catch {
      // No sessions directory is OK (fresh state)
    }

    // 4. Check for obviously corrupt files (zero-byte JSON)
    for (const entry of entries) {
      if (entry.endsWith(".json")) {
        const filePath = path.join(storagePath, entry)
        const fileStat = await fs.stat(filePath)
        if (fileStat.size === 0) {
          return {corrupted: true, reason: `Zero-byte JSON file: ${entry}`}
        }
      }
    }

    return {corrupted: false, reason: null}
  } catch (error) {
    logger.debug("Storage corruption check failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return {corrupted: true, reason: "Storage not accessible"}
  }
}
```

#### Acceptance Criteria (F24)

- [x] Check for missing required directories
- [x] Check for unreadable files
- [x] Check for zero-byte JSON files
- [x] Corruption logged with reason
- [x] Corruption included in run summary
- [x] Proceed with clean state (not failure)

---

### C. Concurrency Handling (F50)

**Added:** 2026-01-17

#### Purpose

Handle simultaneous runs hitting the same cache key without data corruption.

#### Implementation

GitHub Actions cache uses **last-write-wins** semantics. This is acceptable for session storage because:

1. Sessions are append-only (new sessions don't modify old ones)
2. Session pruning is idempotent
3. The worst case is redundant work, not data loss

**Race Detection:**

```typescript
interface CacheSaveResult {
  readonly saved: boolean
  readonly raceDetected: boolean
  readonly error?: string
}

async function saveCache(options: SaveCacheOptions): Promise<CacheSaveResult> {
  const {components, runId, logger} = options
  const storagePath = getOpenCodeStoragePath()

  const saveKey = buildSaveCacheKey(components, runId)

  try {
    await deleteAuthJson(logger)
    await writeStorageVersion(storagePath)

    const storageExists = await directoryHasContent(storagePath)
    if (!storageExists) {
      return {saved: false, raceDetected: false}
    }

    const cacheId = await cache.saveCache([storagePath], saveKey)
    logger.info("Cache saved", {cacheId, saveKey})
    return {saved: true, raceDetected: false}
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) {
      // Another run saved with same key - race condition
      logger.warning("Cache key already exists - concurrent run detected", {saveKey})
      return {saved: false, raceDetected: true}
    }

    logger.warning("Cache save failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return {saved: false, raceDetected: false, error: error instanceof Error ? error.message : String(error)}
  }
}
```

**Run Summary Race Indicator:**

When race is detected, include in run summary:

```markdown
| Cache | ⚠️ race (concurrent run) |
```

#### Mitigation Strategies

1. **Unique save keys**: Include `runId` in save key to avoid collisions
2. **Restore key fallback**: Broader restore keys find latest successful save
3. **Idempotent operations**: Session storage design tolerates races

#### Acceptance Criteria (F50)

- [ ] Use last-write-wins semantics
- [ ] Detect "already exists" as race condition
- [ ] Log warning when race detected
- [ ] Include race warning in run summary (best-effort)
- [ ] No data corruption from concurrent writes
- [ ] Concurrent runs do not fail
