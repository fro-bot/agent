---
title: Tool Cache Separation - Persistent Binary Caching Across Ephemeral GitHub Actions Runners
problem_type: performance-issues
component: GitHub Actions Setup - Cache Layer
date: 2026-02-15
severity: medium
status: solved
tags:
  - caching
  - ci-optimization
  - tool-persistence
  - github-actions
  - performance
---

# Tool Binary Caching on Ephemeral GitHub Actions Runners

## Problem Summary

Tool binaries (OpenCode CLI, oMo plugin) were being re-downloaded on every GitHub Actions workflow run, causing unnecessary network I/O and increased execution time. Ephemeral runners don't persist `@actions/tool-cache` storage between runs, resulting in repeated downloads of the same immutable binaries.

### Symptoms

- OpenCode CLI downloaded fresh on every CI run (despite being cached via `@actions/tool-cache`)
- oMo plugin installed via `npm install -g oh-my-opencode@latest` on every run
- Increased workflow execution time (\u003e30s overhead per run)
- Wasteful network bandwidth consumption
- Non-deterministic oMo versions (dependent on npm registry's "latest" tag)

## Root Cause

The original architecture cached everything—OpenCode binaries, oMo plugin, and session state—under a single cache key. This created two critical problems:

1. **Cache Eviction Vulnerability**: GitHub Actions cache has a 10GB limit and 7-day inactivity window. Tool binaries are immutable and reproducible (can be re-downloaded), yet they competed with session state for cache space, risking loss of valuable conversation history when the cache budget was exhausted.

2. **No Version Pinning**: oMo was installed with `npm install -g oh-my-opencode@latest`, making each action run dependent on npm registry lookups. This introduced non-determinism—a run could pull a different version than previous runs, breaking reproducibility.

3. **Dead Code Burden**: The setup module carried unused Bun runtime installation code (193 lines), adding cognitive load and maintenance overhead for code paths never executed.

## Investigation Process

During research, a **critical discovery emerged: double cache layer problem**. The session cache was being restored in TWO places:
- `runSetup()` at `setup.ts:203-225` (for OpenCode memory)
- `main.ts:200` (for agent execution context)

This redundant restoration wasted API calls and complicates cache invalidation. Documented as follow-up (out of scope for this plan).

Other findings:
- `@actions/tool-cache` store (`/opt/hostedtoolcache`) is wiped on ephemeral runners—GitHub Actions cache must layer on top
- npm global prefix varies by environment (`npm config get prefix` required, not hardcoded)
- oMo binary location isn't just the npm prefix; includes both binary AND config output directory
- Pre-commit hooks auto-modify files during commit—requires careful staging to avoid bundling unintended changes

## Solution

### 1. Remove Dead Bun Runtime Code
- **Deleted**: `src/lib/setup/bun.ts` (193 lines)
- **Deleted**: `src/lib/setup/bun.test.ts` (complete test suite)
- **Cleaned**: Removed Bun exports from `src/lib/setup/index.ts`
- **Verified**: No Bun imports remain anywhere in source

### 2. Add oMo Version Pinning Input
- **Added** `omo-version` action input to `action.yaml` with pinned default `3.5.5`
- **Added** `DEFAULT_OMO_VERSION = '3.5.5'` constant to `src/lib/constants.ts`
- **Updated** `ActionInputs` interface to include `readonly omoVersion: string`
- **Updated** `parseActionInputs()` to parse and apply the new input

### 3. Create Tools Cache Module (`tools-cache.ts`)
Separate binary persistence from session state using distinct cache key prefix.

**Cache Key Structure:**
```typescript
opencode-tools-{os}-oc{opencodeVersion}-omo{omoVersion}
```

**Fallback Restore Chain:**
```typescript
[
  "opencode-tools-{os}-oc{version}-omo{version}-",  // Exact match or prefix
  "opencode-tools-{os}-"                             // Same OS, any versions
]
```

**Cached Paths:**
```typescript
[
  "$RUNNER_TOOL_CACHE/opencode",                      // OpenCode binary
  "$(npm config get prefix)/lib/node_modules/oh-my-opencode",  // oMo binary
  "~/.config/opencode"                                // oMo config
]
```

### 4. Pin oMo Version and Add Cache-Skip Support
- **Updated** `installOmo()` signature to accept `version: string` parameter
- **Replaced** all `oh-my-opencode@latest` with `oh-my-opencode@{version}`
- **Added** `skipInstall?: boolean` option to bypass installation on cache hit
- **Enhanced** `verifyOmoInstallation()` to check both binary AND config file existence

### 5. Integrate Tools Cache into Setup Flow
**Execution Order:**
```
1. Determine versions (from inputs or defaults)
2. Restore tools cache (before installs) → ToolsCacheResult {hit, restoredKey}
3. If HIT: Skip installs, use cached paths
4. If MISS: Install normally (OpenCode + oMo)
5. Save tools cache eagerly (immediately after installs)
6. Add PATH entries, configure auth, restore session cache
```

**Key Integration Points:**
- Added `discoverNpmPrefix(execAdapter)` helper to dynamically resolve npm global prefix
- Pass `skipInstall: true` to installers on cache hit
- Added `toolsCacheStatus: 'hit' | 'miss'` to `SetupResult`
- Tools cache save is eager (right after install), not deferred to post-action

### 6. Final Verification & Build
- ✅ `pnpm check-types` → exit 0 (all types clean)
- ✅ `pnpm lint` → 30 warnings (pre-existing, acceptable)
- ✅ `pnpm test` → 1706 tests PASS (0 failures)
- ✅ `pnpm build` → dist/ successfully rebuilt (+2.3KB)

## Key Implementation Details

### Cache Key Separation (Non-Negotiable)
**Storage Cache** (existing, unchanged):
```
CACHE_PREFIX = 'opencode-storage'
Key: opencode-storage-{repo}-{branch}-{os}
Scope: Session state, conversation history
```

**Tools Cache** (new):
```
TOOLS_CACHE_PREFIX = 'opencode-tools'
Key: opencode-tools-{os}-oc{opencodeVersion}-omo{omoVersion}
Scope: Immutable binaries (OpenCode, oMo)
```

### Pattern: Input → Constant → Function Parameter Flow
```typescript
// action.yaml
omo-version: '3.5.5'

// src/lib/constants.ts
DEFAULT_OMO_VERSION = '3.5.5'

// src/lib/types.ts
interface ActionInputs {
  readonly omoVersion: string
}

// src/lib/inputs.ts
const omoVersion = input.length > 0 ? input : DEFAULT_OMO_VERSION

// src/lib/setup/setup.ts
const omoVersion = core.getInput('omo-version').trim()
const omoVersion_final = omoVersion.length > 0 ? omoVersion : DEFAULT_OMO_VERSION
await installOmo(omoVersion_final, {...})
```

### Error Handling: Graceful Degradation
Cache failures return `{hit: false}` instead of throwing—tool installation failures are recoverable:

```typescript
export async function restoreToolsCache(options: RestoreToolsCacheOptions): Promise<ToolsCacheResult> {
  try {
    const restoredKey = await cacheAdapter.restoreCache(cachePaths, primaryKey, [...restoreKeys])
    if (restoredKey == null) {
      return {hit: false, restoredKey: null}  // Cache miss, not an error
    }
    return {hit: true, restoredKey}
  } catch (error) {
    // Network/API errors → log and continue with fresh install
    logger.warning('Tools cache restore failed', {error: toErrorMessage(error)})
    return {hit: false, restoredKey: null}
  }
}
```

### Test Coverage
- **tools-cache.test.ts**: 13 tests covering key generation, restore/save, hit/miss, error handling
- **setup.test.ts**: 6 new integration tests for cache restoration, skip-install logic, status reporting
- **omo.test.ts**: Updated for version parameter, added skipInstall bypass tests
- **inputs.test.ts**: 2 tests verifying omoVersion parsing and default fallback

**Result**: 1706 total tests pass (121 test files, 0 failures)

## Prevention Strategies

1. **Separate Cache Concerns by Prefix** — Always use distinct cache key prefixes for different concerns (e.g., `opencode-storage` for session state, `opencode-tools` for binary/tool caches). This prevents naming collisions, enables independent cache management, and makes it clear which component manages which data. Establishes a scaling pattern for future cache layers.

2. **Enforce Input → Type → Constant Flow** — Route all action inputs through a consistent transformation pipeline: kebab-case in `action.yaml` → camelCase in `ActionInputs` interface → UPPERCASE_UNDERSCORE in constants. This prevents copy-paste errors, ensures type safety early, and makes the pattern reusable for new inputs.

3. **Make Cache Misses Graceful, Not Failures** — Design cache operations to return `hit: false` instead of throwing on network errors or missing keys. This allows setup to proceed with a fresh install if cache is unavailable, preventing brittle CI that fails on temporary cache issues.

4. **Test Pre-Commit Hook Behavior in TDD** — If your repo has auto-formatting pre-commit hooks, write tests and commits incrementally rather than in large batches. Hooks may create surprise commits that disrupt your workflow; frequent small commits expose this early.

5. **Version-Pin Everything, Assume Nothing** — Don't rely on npm registry "latest" tags during CI (they're unpredictable). Pin versions in `action.yaml` defaults, constants, or function parameters. This enables reproducible setups and makes version management explicit rather than implicit.

6. **Use Adapter Pattern for Testable I/O** — Create interface boundaries (`ToolsCacheAdapter`, `CacheAdapter`, etc.) for external I/O operations. This allows tests to mock cache operations without touching the real GitHub Actions cache API, reducing test flakiness.

## Best Practices

- **Cache Key Design**: Include version info, OS, and tool name in the cache key itself rather than storing metadata separately. Example pattern: `opencode-tools-{os}-oc{version}-omo{version}`. This enables fallback chains and self-documenting cache invalidation.

- **Version Pinning**: Always accept `version: string` parameters in setup functions. Default to pinned versions (not "latest"). This breaks dependency on registry lookups and makes determinism the default, not an exception.

- **TDD Discipline**: Write tests first that assert your intent, then implement code. TDD catches real issues (like missing type field updates) that emerge during implementation but wouldn't appear in manual testing.

- **Module Exports Through Barrel Files**: All setup components export through `src/lib/setup/index.ts`. This creates a single verification point—grep the barrel file to confirm no dead exports remain.

- **Graceful Optional Components**: If a component is optional (like cache restoration), catch and log failures rather than crashing. This allows CI to proceed even if a nice-to-have feature breaks.

## Testing Recommendations

- **Test Cache Key Generation** — Verify cache keys are stable across OS variants, handle version edge cases (e.g., "latest" strings), and follow the documented pattern.

- **Test Fallback Chain Logic** — Write tests for cache restore trying multiple keys in order (same versions on same OS first, then any version on same OS, then cross-OS fallback).

- **Test Adapter Interface** — Mock the cache adapter to simulate hits, misses, network errors, and "already exists" scenarios without touching real cache infrastructure.

- **Test Version Parameter Threading** — Verify versions flow from input → constant → function call → command execution correctly. Use TDD to catch missing imports early.

- **Test Conditional Install Logic** — When `skipInstall: true`, verify install functions are never called. When `skipInstall: false` (or absent), verify they are. Use `vi.mocked()` to inspect call arguments.

## Common Pitfalls to Avoid

- **Don't Hardcode Npm Prefix** — Assume the npm global prefix is unpredictable per environment. Use `npm config get prefix` or `npm exec --package -c` to discover it dynamically. Hardcoded paths fail on different machine setups.

- **Don't Assume Import Names Work Globally** — If your code shadows `os` with a local variable (`const os = getRunnerOS()`), importing the `os` module as default will fail silently or cause confusion. Use named imports (`import { homedir } from 'node:os'`) to avoid shadowing.

- **Don't Let Pre-Commit Hooks Create Surprise Commits** — If your repo has formatting hooks, they modify files during commit. Test and commit incrementally to catch this early. If it happens, use `git reset --soft` and re-commit to consolidate.

- **Don't Store Metadata Separately from Cache Keys** — Version info, OS, and tool names should be embedded in the cache key itself, not in a separate version file. This prevents cache invalidation bugs and makes the cache self-documenting.

- **Don't Skip Type Checking Between Edits** — After editing multiple files (types, constants, functions), run `pnpm check-types` immediately. Type errors expose coupling bugs that won't show up until later.

- **Don't Delete Failing Tests** — If a test fails, fix the implementation, not the test. Tests are specs; code is the implementation. Deleting tests is deleting requirements.

- **Don't Commit Without Running Full Verification** — Always run the full gate: type checking, linting, tests, build, and pattern grep checks before committing. Missing one allows technical debt to slip through.

- **Don't Change Cache Prefix Values After Release** — Cache keys are immutable once deployed. Changing `CACHE_PREFIX` or `TOOLS_CACHE_PREFIX` breaks all existing cached entries. If you must change them, plan a migration or deprecation strategy.

## Related Documentation

### RFC References
- **[RFC-002: Cache Infrastructure](../../RFCs/RFC-002-Cache-Infrastructure.md)** - Core cache persistence for OpenCode storage, foundational for session durable memory across CI runs
- **[RFC-017: Post-Action Cache Hook](../../RFCs/RFC-017-Post-Action-Cache-Hook.md)** - Reliable cache persistence via GitHub Actions `post:` lifecycle hook, handles timeout/cancellation/failure scenarios
- **[RFC-011: Setup Action & Environment Bootstrap](../../RFCs/RFC-011-Setup-Action-Environment-Bootstrap.md)** - DEPRECATED (auto-setup integrated into main action), but documents setup orchestration including tool installation
- **[RFC-019: S3 Storage Backend](../../RFCs/RFC-019-S3-Storage-Backend.md)** - S3 write-through backup for cross-runner persistence, serves as fallback when GitHub Actions cache evicts

### Related Code Modules

**Cache & Persistence**:
- `src/lib/cache.ts` - Session cache operations (`restoreCache()`, `saveCache()`)
- `src/lib/setup/tools-cache.ts` - Tool cache management (NEW)

**Setup & Tool Installation**:
- `src/lib/setup/setup.ts` - Main orchestration (`runSetup()`)
- `src/lib/setup/opencode.ts` - OpenCode CLI resolution & caching
- `src/lib/setup/omo.ts` - oMo plugin installation

**Main Execution**:
- `src/main.ts` - 12-step orchestration
- `src/post.ts` - Post-action hook for durable cache save

## Performance Impact

- **Build time**: +867ms (tsdown bundler, one-time at commit)
- **Test suite**: 1706 tests in 5.09s (121 test files)
- **Runtime savings**: On cache hit, eliminates OpenCode download + oMo npm install (\u003e30s per run)

## Commits Created

1. `refactor(setup): remove dead Bun runtime code`
2. `feat(setup): add omo-version input with pinned default`
3. `feat(setup): add tools cache module for cross-run binary persistence`
4. `feat(setup): pin oMo version and add cache-skip support`
5. `feat(setup): integrate tools cache into setup flow for cross-run persistence`
6. `chore: rebuild dist after tool cache changes`

## Known Follow-ups

1. **Double session-cache-restore**: Both `runSetup()` and `main.ts` restore session cache - needs deduplication
2. **Cache size monitoring**: No visibility into GitHub Actions cache budget consumption
3. **oMo version resolution**: Could add npm registry check for latest stable version
