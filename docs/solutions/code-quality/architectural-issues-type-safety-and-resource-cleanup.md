---
title: "OpenCode SDK Session Backend: Architectural Issues in Type Safety and Resource Cleanup"
date: "2026-02-16"
category: "code-quality"
severity: "high"
status: "resolved"
affected_components:
  - "session/storage.ts"
  - "session/prune.ts"
  - "main.ts (cleanup orchestration)"
  - "SDK session backend integration"
related_patterns:
  - "hardcoded backend coupling"
  - "dependency injection violation"
  - "resource cleanup ordering"
  - "non-deterministic behavior"
  - "unsafe type casts"
keywords:
  - "pruneSessions"
  - "SessionBackend"
  - "server shutdown"
  - "latest session selection"
  - "type safety"
  - "resource cleanup"
  - "finally blocks"
  - "determinism"
related_issues:
  - "PR #198 (OpenCode SQLite session support)"
discovery_context: "code review feedback (Fro Bot + Codex agent)"
reviewer_agents:
  - "Fro Bot (primary backend coupling issue)"
  - "Codex agent (architectural critique: cleanup ordering, determinism, type safety)"
root_cause: "Multiple architectural quality issues: (1) pruneSessions() hardcoded JsonBackend instead of accepting injected SessionBackend, (2) server shutdown in try block could be skipped if cleanup throws, (3) non-deterministic SDK session ordering, (4) unnecessary unsafe type casts"
impact: "SQLite backend cannot properly prune sessions; server processes leak on cleanup failure; non-reproducible CI behavior; type safety gaps hide runtime errors"
---

# OpenCode SDK Session Backend: Architectural Issues in Type Safety and Resource Cleanup

## Summary

During code review of PR #198 (OpenCode SQLite session support), multiple architectural quality issues were discovered across session pruning, resource cleanup, and type safety. These issues would have caused:

- **Pruning failures** with SQLite backend (sessions accumulate indefinitely)
- **Resource leaks** when cleanup operations fail (server processes not shutdown)
- **Non-deterministic CI behavior** (latest session selection depends on undefined ordering)
- **Type safety gaps** (unsafe casts hide potential runtime errors)

All issues were caught during code review before merge, fixed in commits `41b6865` (Fro Bot fix) and `97b37a2` (Codex agent fixes).

## Problem Details

### Issue #1: pruneSessions() Hardcoded JsonBackend

**Symptom:**

```typescript
// Function signature suggested backend-agnostic design
export async function pruneSessions(directory: string, ...)

// But implementation hardcoded JsonBackend
const jsonBackend: JsonBackend = {type: 'json', workspacePath: directory}
```

**Discovery:** Fro Bot code review flagged that `pruneSessions()` was constructing `JsonBackend` directly instead of accepting the active session backend as a parameter.

**Impact:**

- When OpenCode v1.2.0+ uses SQLite (SDK backend), pruning attempts to delete from JSON filesystem storage
- SQLite sessions persist indefinitely, never pruned
- Cache bloat and performance degradation over time
- Violates backend-agnostic design contract established in Phase 2

### Issue #2: Server Shutdown Not Guaranteed

**Symptom:**

```typescript
try {
  // ... processing ...
  const pruneResult = await pruneSessions(...)
  const cacheSaved = await saveCache(...)

  if (serverHandle != null) {
    serverHandle.shutdown()  // ← Skipped if cache save throws
  }
} catch (cleanupError) {
  logger.warning('Cleanup failed')
  // Exits here without shutdown
}
```

**Discovery:** Codex agent architectural review identified that server shutdown was only reachable on success path.

**Impact:**

- If cache save fails, cleanup catch block exits without shutting down server
- Server process remains running, leaking file descriptors
- Repeated failures accumulate server processes across CI runs
- Resource exhaustion on long-running CI agents

### Issue #3: Latest Session Selection Non-Deterministic

**Symptom:**

```typescript
const response = await client.session.list({
  query: {directory, start: afterTimestamp, roots: true, limit: 1},
})
// Returns response.data[0] without verifying ordering
const session = mapSdkSessionToSessionInfo(response.data[0])
```

**Discovery:** Codex agent noted that fetching exactly 1 session relies on undefined SDK ordering behavior. When multiple sessions have identical or close `time.created` values, different sessions could be returned on repeated calls.

**Impact:**

- Non-reproducible CI behavior (same inputs produce different sessions)
- Difficult to debug session-related issues
- Test flakiness when verifying session selection logic
- Violates determinism requirement for CI pipelines

### Issue #4: Unsafe Type Cast in mapSdkPartToPart()

**Symptom:**

```typescript
state: mapSdkToolState(stateRecord) as unknown as Part["type"] extends "tool" ? never : never
```

**Discovery:** Codex agent flagged the cast as nonsensical—the conditional type always evaluates to `never`, and the cast suppresses TypeScript's type narrowing.

**Impact:**

- TypeScript cannot verify type safety between SDK and local types
- Runtime type mismatches hidden by unsafe cast
- If SDK types change, compile-time error detection is lost
- Reduced IDE support and autocomplete accuracy

## Root Cause Analysis

### Issue #1: Parameter Hardcoding

`pruneSessions()` was created before full backend abstraction was implemented. When backend detection logic was added, the pruning callsite wasn't updated to respect the active backend. The function accepted `directory` but internally constructed the backend, violating dependency injection principles.

### Issue #2: Cleanup Ordering

Server shutdown was placed inside the main try-catch block after cleanup operations. TypeScript doesn't enforce finally-block usage for cleanup, making it easy to miss that any exception in the catch handler bypasses remaining cleanup.

### Issue #3: SDK Ordering Assumptions

The SDK `session.list()` API doesn't guarantee ordering when `limit: 1` is used. The code assumed the API would return the latest session first, but this behavior is undefined in the SDK specification.

### Issue #4: Type Cast Misuse

The `mapSdkToolState()` function already returns `ToolState`, which is exactly what `ToolPart.state` expects. The cast to `never` was likely a copy-paste artifact or misunderstanding of conditional types, serving no purpose.

## Solution

### Fix #1: Accept SessionBackend Parameter

**Change `pruneSessions()` to accept `SessionBackend` as first parameter:**

```typescript
// Before
export async function pruneSessions(directory: string, config: PruningConfig, logger: Logger): Promise<PruneResult> {
  const project = await findProjectByDirectory(directory, logger)
  const jsonBackend: JsonBackend = {type: "json", workspacePath: directory}
  const allSessions = await listSessionsForProject(jsonBackend, project.id, logger)
  // ...
}

// After
export async function pruneSessions(
  backend: SessionBackend,
  config: PruningConfig,
  logger: Logger,
): Promise<PruneResult> {
  const {workspacePath} = backend
  const project = await findProjectByDirectory(workspacePath, logger)
  const allSessions = await listSessionsForProject(backend, project.id, logger)
  // ...
}
```

**Update callsite in `main.ts`:**

```typescript
// Before
const workspaceForPrune = getGitHubWorkspace()
const pruneResult = await pruneSessions(workspaceForPrune, DEFAULT_PRUNING_CONFIG, pruneLogger)

// After
const finalWorkspace = getGitHubWorkspace()
const pruneBackend: SessionBackend = backend ?? {type: "json", workspacePath: finalWorkspace}
const pruneResult = await pruneSessions(pruneBackend, DEFAULT_PRUNING_CONFIG, pruneLogger)
```

**Why it works:** By accepting `SessionBackend` as a parameter, `pruneSessions()` now respects the actual storage medium (JSON or SQLite). The function routes deletions to the correct backend: SDK sessions delete via API client, JSON sessions delete via filesystem. The fallback ensures graceful degradation if no backend was established.

### Fix #2: Guaranteed Server Shutdown via Nested Finally Block

**Move server shutdown to nested finally block:**

```typescript
// Before
try {
  // ... all processing ...
  const pruneResult = await pruneSessions(backend, config, logger)
  const cacheSaved = await saveCache({...})

  if (serverHandle != null) {
    serverHandle.shutdown()
  }
} catch (cleanupError) {
  bootstrapLogger.warning('Cleanup failed (non-fatal)', {...})
}

// After
try {
  // ... all processing ...
  const pruneResult = await pruneSessions(backend, config, logger)
  const cacheSaved = await saveCache({...})
} catch (cleanupError) {
  bootstrapLogger.warning('Cleanup failed (non-fatal)', {...})
} finally {
  // Guaranteed shutdown of SDK server regardless of cleanup success
  if (serverHandle != null) {
    try {
      serverHandle.shutdown()
    } catch (shutdownError) {
      bootstrapLogger.warning('Server shutdown failed (non-fatal)', {...})
    }
  }
}
```

**Why it works:** The `finally` block executes unconditionally—before exiting the try-catch, after either success or catch. Nesting another try-catch around `shutdown()` prevents shutdown failures from masking the original cleanup error. This ensures: (1) shutdown always runs, (2) shutdown errors don't suppress prior exceptions, (3) resource leaks are eliminated.

### Fix #3: Deterministic Latest Session Selection

**Fetch 10 sessions and explicitly select maximum by time.created:**

```typescript
// Before
const response = await client.session.list({
  query: {
    directory: workspacePath,
    start: afterTimestamp,
    roots: true,
    limit: 1, // ← only 1 result
  },
})
if (response.error != null || response.data == null) {
  return null
}
if (response.data.length === 0) {
  return null
}
const session = mapSdkSessionToSessionInfo(response.data[0])
return {projectID: session.projectID, session}

// After
const response = await client.session.list({
  query: {
    directory: workspacePath,
    start: afterTimestamp,
    roots: true,
    limit: 10, // ← fetch 10 to have choice
  },
})
if (response.error != null || response.data == null) {
  return null
}
const sessions = response.data.map(mapSdkSessionToSessionInfo)
if (sessions.length === 0) {
  return null
}
const latest = sessions.reduce((max, session) => (session.time.created > max.time.created ? session : max))
return {projectID: latest.projectID, session: latest}
```

**Why it works:** By fetching 10 results and explicitly computing the maximum by `time.created`, we eliminate dependence on API ordering. The `reduce()` ensures a deterministic pick: if two sessions have identical timestamps, the same one is returned every time. This is a standard max-selection pattern and makes session recovery reproducible across CI runs.

### Fix #4: Remove Unsafe Type Cast

**Remove the nonsensical `never` cast:**

```typescript
// Before
case 'tool': {
  const stateRecord = isRecord(sdkPart.state) ? sdkPart.state : {status: 'pending'}
  return {
    ...base,
    type: 'tool',
    callID: readString(sdkPart.callID) ?? readString(sdkPart.callId) ?? '',
    tool: readString(sdkPart.tool) ?? '',
    state: mapSdkToolState(stateRecord) as unknown as Part['type'] extends 'tool' ? never : never,
    metadata: isRecord(sdkPart.metadata) ? sdkPart.metadata : undefined,
  }
}

// After
case 'tool': {
  const stateRecord = isRecord(sdkPart.state) ? sdkPart.state : {status: 'pending'}
  return {
    ...base,
    type: 'tool',
    callID: readString(sdkPart.callID) ?? readString(sdkPart.callId) ?? '',
    tool: readString(sdkPart.tool) ?? '',
    state: mapSdkToolState(stateRecord),
    metadata: isRecord(sdkPart.metadata) ? sdkPart.metadata : undefined,
  }
}
```

**Why it works:** `mapSdkToolState()` already returns the correct type for the `state` field on a tool part. Removing the cast allows TypeScript to verify type safety naturally. If the SDK types change or `mapSdkToolState()` changes signature, TypeScript will catch the error at compile time instead of silently passing an incorrect value at runtime.

## Verification

All fixes verified with:

- **1756 tests passing** across 123 test files
- **TypeScript type checking clean** (no errors)
- **ESLint clean** (0 errors, 30 pre-existing warnings in test files)
- **Build succeeds** (dist/ bundle generated successfully)
- **Committed** in `41b6865` (Fro Bot fix) and `97b37a2` (Codex agent fixes)
- **Pushed to PR #198** for final review

## Prevention

### Function Design

- **Accept all relevant parameters explicitly**: If a function accepts user input (directory, config, backend type), don't hardcode behavior internally. Make every decision point a parameter or derive it consistently from a single source of truth.

- **Avoid parameter aliasing**: When a function accepts a parameter, use it. Don't accept `dir` then ignore it and use a module-level variable. Aliases hide dependencies and create maintenance traps.

- **Make SDK/external behavior explicit**: When relying on external libraries (SDK, test frameworks), document assumed ordering and behavior. If ordering is undefined, don't assume it—add explicit tests that verify the contract or refactor to not depend on ordering.

- **Use typed enums or discriminated unions over strings**: Hardcoded string literals can be missed during refactoring. Use `BackendType.JSON` instead of `"json"` so search/replace catches all references.

### Error Handling

- **Use try-finally for cleanup, never try-catch**: Cleanup code (shutdown, deletion, file closure) must run regardless of errors. Structure as:

  ```typescript
  let resource1, resource2
  try {
    resource1 = allocate()
    resource2 = allocate()
  } finally {
    cleanup(resource2)
    cleanup(resource1)
  }
  ```

  Cleanup in reverse order of allocation, each wrapped independently.

- **Never throw from cleanup handlers**: Cleanup must be defensive. Wrap each cleanup step in try-catch and log failures, don't re-throw. The original error is more important than a cleanup failure.

- **Test cleanup paths as aggressively as main paths**: Cleanup rarely executes during happy-path testing. Force failure conditions to test cleanup: mock allocations to fail after partial setup, inject errors into cleanup steps themselves.

### Type Safety

- **Eliminate unnecessary type casts**: If you need `as any` or `as SomeType`, the code is fighting the type system. The type system is right; the code is wrong. Refactor to make types flow naturally.

- **Use discriminated unions for state**: Instead of optional properties, use `{ type: 'loading' } | { type: 'success'; data: T } | { type: 'error'; error: E }`. This prevents invalid states and makes error handling exhaustive.

## Testing Strategies

- **Test parameter passing end-to-end**: Don't just unit test parameter handling. Integration test that parameters actually flow through the call chain. Catch aliasing and hardcoding by verifying behavior changes when you change inputs.

- **Force cleanup failure paths**: Mock cleanup operations to throw. Verify the system handles partial cleanup gracefully. Tests: `describe('cleanup failure')`, mock each cleanup step to fail, assert remaining steps still execute.

- **Verify reverse-order cleanup**: For multi-step cleanup, explicitly verify order. Track cleanup calls and assert they executed in reverse-order of allocation.

- **Test undefined SDK behavior explicitly**: Don't assume SDK ordering. Write tests that would fail if ordering changed. Iterate the SDK's collection multiple times, verify results are consistent.

- **Write regression tests for found bugs**: After fixing a hardcoding or cleanup bug, write a test that would have caught it. Keep it even after fixing (documents the issue for future maintainers).

## Code Review Checklist

- [ ] **Parameter usage**: All function parameters are used. No parameters accepted then ignored in favor of module-level variables or implicit defaults.
- [ ] **No hardcoded values in function bodies**: If a function accepts a parameter controlling behavior (type, mode, target), it's not hardcoded.
- [ ] **Cleanup structure**: Cleanup code uses `finally` blocks or explicit cleanup functions, never nested in error handlers.
- [ ] **Error propagation**: Errors from cleanup are handled separately from main operation errors. Cleanup failures don't mask earlier errors.
- [ ] **Type safety**: No `as any`, `as SomeType` without explanation. Types flow naturally from data to operations.
- [ ] **SDK/external behavior documented**: If relying on library ordering or behavior, document the assumption. Add a test that verifies the assumption.
- [ ] **Resource lifecycle clear**: Resources (connections, files, servers) have explicit allocation and deallocation.
- [ ] **Single source of truth for configuration**: If a configuration value is used in multiple places, it's derived from a single location.
- [ ] **Test coverage for error paths**: Not just happy path. Cleanup failures, partial setup, SDK errors.

## Related Documentation

- [Fro Bot Agent SQLite Session Support Plan](../plans/2026-02-15-feat-opencode-sqlite-session-support-plan.md)
- [Build Errors: Tool Binary Caching on Ephemeral Runners](../solutions/build-errors/tool-binary-caching-ephemeral-runners.md)

## Related Issues

- PR #198: OpenCode SQLite session backend implementation
- [Fro Bot Review](https://github.com/fro-bot/agent/pull/198#pullrequestreview-3807116353)

## Related RFCs

- **RFC-004: Session Management Integration** — Action-side session utilities (listing, searching, pruning, writeback)
- **RFC-002: Cache Infrastructure** — Core cache operations for persisting OpenCode storage
- **RFC-013: SDK Execution Mode** — OpenCode SDK-based execution (replaces CLI mode)
- **RFC-017: Post-Action Cache Hook** — Durable cache save via post-action hook

## See Also

- `src/lib/session/backend.ts` — Session backend discriminated union
- `src/lib/session/prune.ts` — Session retention and cleanup logic
- `src/lib/session/storage.ts` — OpenCode storage access utilities
- `src/main.ts` — Main orchestration entry point with cleanup lifecycle
- `src/lib/agent/opencode.ts` — SDK execution with server lifecycle management
