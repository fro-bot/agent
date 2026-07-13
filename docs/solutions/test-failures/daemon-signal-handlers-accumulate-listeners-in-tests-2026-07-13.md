---
title: Daemon signal handlers accumulate across repeated test constructions
date: 2026-07-13
category: test-failures
module: gateway
problem_type: test_failure
component: testing_framework
severity: low
symptoms:
  - "MaxListenersExceededWarning for SIGTERM/SIGINT during the gateway test suite"
  - "Warning count grows with the number of tests that construct the program"
root_cause: test_isolation
resolution_type: test_fix
tags: [max-listeners, process-signals, test-isolation, shutdown, daemon-lifecycle]
---

# Daemon signal handlers accumulate across repeated test constructions

## Problem

`packages/gateway/src/shutdown.ts` installs process-level `SIGTERM`/`SIGINT` handlers that are deliberately never removed in production — correct for a daemon, which installs them once per process lifetime. `packages/gateway/src/program.test.ts` constructs the gateway program roughly 36 times in a single Vitest worker process, and `makeGatewayProgram` calls `installShutdownHandlers` internally without exposing the returned cleanup function to callers. Each construction adds another pair of listeners that never gets removed, eventually exceeding Node's default listener threshold.

## Symptoms

- `MaxListenersExceededWarning` for `SIGTERM`/`SIGINT` printed during the gateway test suite.
- The warning count scales with the number of tests that call `makeGatewayProgram`, not with anything related to actual shutdown behavior.

## What Didn't Work

- Raising `process.setMaxListeners()` would silence the warning without addressing the leak — it masks the signal rather than fixing isolation, and hides a genuine growth-with-test-count pattern.
- Removing the handlers in production teardown was considered and rejected: an audit confirmed exactly one construction per process in production, so there is no real leak there — the accumulation is an artifact of repeated test construction, not a defect in `shutdown.ts`.

## Solution

Fixed in the test file only: snapshot the process's `SIGTERM`/`SIGINT` listeners before each test, and strip only the listeners added during that test, restoring the exact pre-test set — the same cleanup `installShutdownHandlers`'s own return value would perform if it were reachable from the test.

```ts
// makeGatewayProgram calls installShutdownHandlers internally and does not expose
// its returned cleanup fn to callers — that's intentional for production (the
// process owns its own shutdown lifecycle). Tests that invoke makeGatewayProgram
// repeatedly would otherwise accumulate SIGTERM/SIGINT listeners across cases
// (Issue #1134). Since the cleanup closure isn't reachable here, snapshot the
// listener set before each test and strip anything added during it, restoring
// the exact pre-test listener set the same way installShutdownHandlers's own
// cleanup would (process.off per added listener).
beforeEach(() => {
  const sigtermBefore = process.listeners('SIGTERM')
  const sigintBefore = process.listeners('SIGINT')
  return () => {
    for (const listener of process.listeners('SIGTERM')) {
      if (!sigtermBefore.includes(listener)) process.off('SIGTERM', listener)
    }
    for (const listener of process.listeners('SIGINT')) {
      if (!sigintBefore.includes(listener)) process.off('SIGINT', listener)
    }
  }
})
```

## Why This Works

The side effect being accumulated is process-lifetime by design — a daemon installs its signal handlers once and keeps them for the life of the process, which is correct. The defect is test isolation: repeated construction in one process simulates a scenario that never happens in production. The `beforeEach`/teardown pair mirrors the real cleanup contract (`process.off` per handler `installShutdownHandlers` added) without touching production behavior in `shutdown.ts`.

## Prevention

- Treat `MaxListenersExceededWarning` in a test suite as a test-isolation smell first, not a signal to raise the listener cap.
- Snapshot and strip process-level listeners in any test that repeatedly constructs something with process-lifetime side effects (signal handlers, `process.on('exit', ...)`, global singletons).
- Never reach for `setMaxListeners()` as the first response — it suppresses the diagnostic without checking whether the accumulation reflects a real production leak.

## Related Issues

- Issue #1134
