# RFC-017: Post-Action Cache Hook

**Status:** Pending
**Priority:** MUST
**Complexity:** Medium
**Phase:** 2

---

## Summary

Implement reliable cache persistence via GitHub Actions `post:` lifecycle hook. This RFC adds a third entry point (`src/post.ts`) that runs independently of the main action, ensuring cache is saved even on timeout, cancellation, or failure.

## Dependencies

- **Builds Upon:** RFC-002 (Cache Infrastructure), RFC-001 (Foundation & Core Types)
- **Relates To:** RFC-013 (SDK Execution Mode) - coordinates via state handoff

## Features Addressed

| Feature ID | Feature Name           | Priority |
| ---------- | ---------------------- | -------- |
| F74        | Post-Action Cache Hook | P0       |

## Problem Statement

The current cache save implementation in `src/main.ts` uses a `finally` block, which is vulnerable to:

1. **Hard kills**: GitHub Actions timeout (6 hours max) kills the process
2. **Cancellation**: User-initiated workflow cancellation
3. **SIGKILL**: Force-terminated processes
4. **Unhandled exceptions**: Exceptions outside try/catch

GitHub Actions provides a `post:` lifecycle hook that runs in a separate process after the main action completes (or fails). This hook is more reliable for cleanup operations.

## Technical Specification

### 1. New Entry Point (`src/post.ts`)

```typescript
/**
 * Post-action hook for reliable cache persistence.
 *
 * This entry point runs after the main action completes (success, failure, or cancellation).
 * It handles cache saving and session pruning in a best-effort manner.
 *
 * Key properties:
 * - Runs in a SEPARATE process from main action
 * - ALWAYS runs (even on main action failure/timeout)
 * - MUST NOT fail the job (best-effort only)
 * - Uses core.getState() for state handoff from main action
 */

import * as core from "@actions/core"
import {createLogger} from "./lib/logger.js"
import {saveCache} from "./lib/cache.js"
import {pruneSessions} from "./lib/session/prune.js"
import {parseActionInputs} from "./lib/inputs.js"

/**
 * State keys for main -> post handoff.
 */
const STATE_KEYS = {
  /** Whether the main action processed an event (vs skipped) */
  SHOULD_SAVE_CACHE: "shouldSaveCache",
  /** Session ID used in this run (for logging) */
  SESSION_ID: "sessionId",
  /** Whether main action already saved cache */
  CACHE_SAVED: "cacheSaved",
} as const

async function post(): Promise<void> {
  const logger = createLogger("post")

  try {
    logger.info("Post-action hook started")

    // Check if we should save cache
    const shouldSaveCache = core.getState(STATE_KEYS.SHOULD_SAVE_CACHE) !== "false"
    const cacheSaved = core.getState(STATE_KEYS.CACHE_SAVED) === "true"
    const sessionId = core.getState(STATE_KEYS.SESSION_ID) || "unknown"

    logger.debug("Post-action state", {shouldSaveCache, cacheSaved, sessionId})

    // Skip if main action already saved cache successfully
    if (cacheSaved) {
      logger.info("Cache already saved by main action, skipping")
      return
    }

    // Skip if main action determined we shouldn't save (e.g., skipped event)
    if (!shouldSaveCache) {
      logger.info("Cache save not required, skipping")
      return
    }

    // Parse inputs for cache configuration
    const inputsResult = parseActionInputs()
    if (!inputsResult.ok) {
      logger.warning("Failed to parse inputs, using defaults", {error: inputsResult.error})
    }

    // Save cache (idempotent, best-effort)
    try {
      await saveCache({
        agentIdentity: "github",
        logger,
      })
      logger.info("Cache saved successfully")
    } catch (error) {
      // Log but don't fail - cache save is best-effort
      logger.warning("Cache save failed (non-fatal)", {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // Session pruning (optional, non-fatal)
    try {
      const inputs = inputsResult.ok ? inputsResult.value : null
      const retention = inputs?.sessionRetention ?? 50

      await pruneSessions({
        maxSessions: retention,
        logger,
      })
      logger.info("Session pruning completed", {retention})
    } catch (error) {
      // Log but don't fail - pruning is best-effort
      logger.warning("Session pruning failed (non-fatal)", {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    logger.info("Post-action hook completed")
  } catch (error) {
    // NEVER fail the job from post-action hook
    logger.warning("Post-action hook error (non-fatal)", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

// Top-level await for ESM entry
await post()
```

### 2. State Handoff from Main Action

Update `src/main.ts` to set state for the post-action hook:

```typescript
import * as core from "@actions/core"

const STATE_KEYS = {
  SHOULD_SAVE_CACHE: "shouldSaveCache",
  SESSION_ID: "sessionId",
  CACHE_SAVED: "cacheSaved",
} as const

async function run(): Promise<void> {
  // Early state initialization
  core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, "false")
  core.saveState(STATE_KEYS.CACHE_SAVED, "false")

  try {
    // ... existing initialization ...

    // After determining we should process this event
    core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, "true")

    // After session creation
    core.saveState(STATE_KEYS.SESSION_ID, sessionId)

    // ... existing agent execution ...

    // After successful cache save in finally block
    try {
      await saveCache({agentIdentity: "github", logger})
      core.saveState(STATE_KEYS.CACHE_SAVED, "true")
    } catch (error) {
      // Cache save failed in main - post hook will retry
      logger.warning("Cache save failed, post-hook will retry", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  } catch (error) {
    // ... existing error handling ...
  }
}
```

### 3. Action Configuration Update (`action.yaml`)

```yaml
name: Fro Bot Agent
description: AI agent with persistent memory for GitHub automation
author: Fro Bot <agent@fro.bot>

inputs:
  github-token:
    description: GitHub token (App installation token or PAT) with write permissions
    required: true
  auth-json:
    description: JSON object mapping provider IDs to auth configs
    required: true
  prompt:
    description: Custom prompt for the agent
    required: false
  session-retention:
    description: Number of sessions to retain (default 50)
    required: false
    default: "50"
  s3-backup:
    description: Enable S3 write-through backup
    required: false
    default: "false"
  s3-bucket:
    description: S3 bucket for backup (required if s3-backup is true)
    required: false
  aws-region:
    description: AWS region for S3 bucket
    required: false
  agent:
    description: "Agent to use (default: Sisyphus). Must be a primary agent, not subagent."
    required: false
    default: Sisyphus
  model:
    description: "Model override (format: provider/model). If not set, uses agent's configured model."
    required: false
  timeout:
    description: "Execution timeout in milliseconds. 0 = no timeout. Default: 1800000 (30 minutes)"
    required: false
    default: "1800000"

outputs:
  session-id:
    description: OpenCode session ID used for this run
  cache-status:
    description: Cache restore status (hit/miss/corrupted)
  duration:
    description: Run duration in seconds

runs:
  using: node24
  main: dist/main.js
  post: dist/post.js
```

### 4. Build Configuration Update (`tsdown.config.ts`)

```typescript
export default defineConfig({
  entry: ["src/main.ts", "src/setup.ts", "src/post.ts"],
  fixedExtension: false,
  minify: true,
  plugins: [licenseCollectorPlugin()],
  noExternal: id => {
    // Bundle all @bfra.me/es subpaths
    if (id.startsWith("@bfra.me/es")) return true
    // Bundle all @actions/* packages
    if (id.startsWith("@actions/")) return true
    // Bundle @octokit/auth-app
    if (id.startsWith("@octokit/auth-app")) return true
    // Bundle @opencode-ai/sdk (RFC-013)
    if (id.startsWith("@opencode-ai/sdk")) return true
    return false
  },
})
```

### 5. State Keys Module (Optional Extraction)

Create `src/lib/state-keys.ts` for shared state key constants:

```typescript
/**
 * State keys for main <-> post action handoff.
 *
 * These keys are used with core.saveState() in main action
 * and core.getState() in post action.
 */
export const STATE_KEYS = {
  /** Whether the main action processed an event (vs skipped) */
  SHOULD_SAVE_CACHE: "shouldSaveCache",
  /** Session ID used in this run (for logging) */
  SESSION_ID: "sessionId",
  /** Whether main action already saved cache */
  CACHE_SAVED: "cacheSaved",
} as const

export type StateKey = keyof typeof STATE_KEYS
```

## Acceptance Criteria

### Post-Action Hook

- [ ] `src/post.ts` entry point exists and bundles to `dist/post.js`
- [ ] `action.yaml` includes `runs.post: dist/post.js`
- [ ] Post-hook saves cache idempotently (best-effort, never fails job)
- [ ] Post-hook runs even on main action failure/timeout
- [ ] Post-hook skips cache save if main action already saved
- [ ] Post-hook skips cache save if main action determined event should be skipped

### State Handoff

- [ ] Main action sets `shouldSaveCache` state before processing
- [ ] Main action sets `sessionId` state after session creation
- [ ] Main action sets `cacheSaved` state after successful cache save
- [ ] Post action reads state with `core.getState()`

### Build Configuration

- [ ] `tsdown.config.ts` includes `src/post.ts` in entry array
- [ ] Build produces `dist/main.js`, `dist/setup.js`, `dist/post.js`
- [ ] All three bundles pass type checking

### Error Handling

- [ ] Post-hook logs but does not throw on cache save failure
- [ ] Post-hook logs but does not throw on session pruning failure
- [ ] Post-hook catches all exceptions at top level
- [ ] Job status is not affected by post-hook errors

## Test Cases

### Post-Hook Execution Tests

```typescript
import {describe, it, expect, vi, beforeEach} from "vitest"
import * as core from "@actions/core"

vi.mock("@actions/core")
vi.mock("./lib/cache.js")
vi.mock("./lib/session/prune.js")

describe("post-action hook", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("saves cache when shouldSaveCache is true and cacheSaved is false", async () => {
    vi.mocked(core.getState).mockImplementation(key => {
      if (key === "shouldSaveCache") return "true"
      if (key === "cacheSaved") return "false"
      return ""
    })

    await import("./post.js")

    expect(saveCache).toHaveBeenCalled()
  })

  it("skips cache save when cacheSaved is true", async () => {
    vi.mocked(core.getState).mockImplementation(key => {
      if (key === "cacheSaved") return "true"
      return ""
    })

    await import("./post.js")

    expect(saveCache).not.toHaveBeenCalled()
  })

  it("skips cache save when shouldSaveCache is false", async () => {
    vi.mocked(core.getState).mockImplementation(key => {
      if (key === "shouldSaveCache") return "false"
      return ""
    })

    await import("./post.js")

    expect(saveCache).not.toHaveBeenCalled()
  })

  it("does not fail job on cache save error", async () => {
    vi.mocked(core.getState).mockImplementation(key => {
      if (key === "shouldSaveCache") return "true"
      if (key === "cacheSaved") return "false"
      return ""
    })
    vi.mocked(saveCache).mockRejectedValue(new Error("Cache save failed"))

    // Should not throw
    await expect(import("./post.js")).resolves.not.toThrow()
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it("does not fail job on pruning error", async () => {
    vi.mocked(core.getState).mockReturnValue("true")
    vi.mocked(pruneSessions).mockRejectedValue(new Error("Pruning failed"))

    await expect(import("./post.js")).resolves.not.toThrow()
    expect(core.setFailed).not.toHaveBeenCalled()
  })
})
```

### State Handoff Tests

```typescript
describe("main action state handoff", () => {
  it("sets shouldSaveCache to true when processing event", async () => {
    // ... setup mock event that should be processed ...

    await run()

    expect(core.saveState).toHaveBeenCalledWith("shouldSaveCache", "true")
  })

  it("keeps shouldSaveCache false when event is skipped", async () => {
    // ... setup mock event that should be skipped ...

    await run()

    expect(core.saveState).toHaveBeenCalledWith("shouldSaveCache", "false")
  })

  it("sets cacheSaved to true after successful cache save", async () => {
    // ... setup successful run ...

    await run()

    expect(core.saveState).toHaveBeenCalledWith("cacheSaved", "true")
  })

  it("sets sessionId after session creation", async () => {
    // ... setup run that creates session ...

    await run()

    expect(core.saveState).toHaveBeenCalledWith("sessionId", expect.stringMatching(/^ses_/))
  })
})
```

### Build Output Tests

```typescript
describe("build configuration", () => {
  it("produces three entry points", async () => {
    const files = await glob("dist/*.js")
    expect(files).toContain("dist/main.js")
    expect(files).toContain("dist/setup.js")
    expect(files).toContain("dist/post.js")
  })
})
```

## Implementation Notes

1. **Best-Effort Design**: Post-hook operations are best-effort. Never call `core.setFailed()` from post-hook.
2. **Idempotent Cache Save**: The `saveCache()` function should handle "cache already exists" gracefully (GitHub Actions cache is immutable per key).
3. **Double Save Prevention**: Main action sets `cacheSaved=true` after successful save. Post-hook checks this to avoid redundant work.
4. **Skip Detection**: If main action determines the event should be skipped (e.g., unauthorized author), it sets `shouldSaveCache=false` to prevent post-hook from saving stale cache.
5. **Session Pruning**: Moved to post-hook for reliability. If main action times out mid-prune, post-hook will complete it.
6. **State Persistence**: `core.saveState()` writes to a file that persists between main and post processes. State is scoped to the action run.

## Compatibility with Dependencies

- **RFC-002**: Uses existing `saveCache()` function. No changes to cache infrastructure required.
- **RFC-001**: Uses existing logger and input parsing. Adds new state keys module.
- **RFC-013**: Main action continues to attempt cache save in finally block; post-hook is a safety net.

## Security Considerations

1. **State Contents**: Only store non-sensitive metadata in state (session IDs, boolean flags). Never store tokens or credentials.
2. **Post-Hook Permissions**: Post-hook runs with same permissions as main action. No escalation.
3. **Cache Integrity**: Post-hook only saves to same cache key as main action would. No cross-contamination.

---

## Estimated Effort

- **Development**: 4-6 hours
- **Testing**: 2-3 hours
- **Total**: 6-9 hours
