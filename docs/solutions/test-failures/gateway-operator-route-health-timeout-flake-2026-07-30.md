---
title: Gateway operator-route.test.ts times out under full-suite load — known non-blocking flake
date: 2026-07-30
category: test-failures
module: gateway
problem_type: flaky_test
component: test_suite
symptoms:
  - "packages/gateway/src/web/operator-route.test.ts fails with a ~5s timeout during a full workspace test run"
  - "Re-running or running the file in isolation passes cleanly (35/35)"
root_cause: resource_contention
resolution_type: known_issue
severity: low
tags:
  - flaky-test
  - vitest
  - gateway
  - operator-route
  - ci-triage
  - timeout
---

# Gateway operator-route.test.ts times out under full-suite load — known non-blocking flake

## Problem

`packages/gateway/src/web/operator-route.test.ts` intermittently fails with a ~5-second test timeout when the entire workspace test suite runs together (`bun run test`). The same file passes deterministically when run in isolation, so it is a load-dependent flake, not a real regression.

## Symptoms

- During a full run, the suite reports something like `operator-route.test.ts (… | 1 failed …)` with a timeout on a route/health assertion — the failure is a **timeout**, not an assertion mismatch.
- The failure is the whole-file 5s ceiling being exceeded under parallel load; it is not tied to one specific `it()`.
- Re-running the full suite, or running just the file, passes: `bunx vitest run packages/gateway/src/web/operator-route.test.ts` → 35/35 in ~1.4s.

## What Didn't Work

Treating a single occurrence as a code failure. The test exercises static route-classification guards (public/health vs privileged) with no timing-sensitive production logic — there is nothing in the assertions that legitimately takes 5s. The timeout is scheduler contention when many gateway suites run concurrently, not a bug in the code under test or the test itself.

## How To Confirm It's The Flake

1. It is a **timeout**, not an assertion failure (`Test timed out in 5000ms`), and it is on `operator-route.test.ts`.
2. It is the **only** failure in an otherwise-green run.
3. Run the file in isolation — it passes:
   ```bash
   bunx vitest run packages/gateway/src/web/operator-route.test.ts
   # → Test Files 1 passed (1); Tests 35 passed (35)
   ```
   Or re-run the full suite; the failure does not reproduce.

If all three hold, it is this flake — non-blocking. If an assertion (not a timeout) fails, or it reproduces in isolation, it is **not** this flake; investigate normally.

## Why This Happens

The workspace runs multiple gateway suites in parallel under Vitest. `operator-route.test.ts` has no long-running work of its own, but under peak concurrency its tasks can be starved past the default 5s per-test/file budget. In isolation there is no contention, so it finishes in ~1.4s.

## Prevention / Disposition

- **CI triage:** a lone `operator-route.test.ts` timeout in an otherwise-green run is non-blocking. Re-run before treating it as a signal; do not block a merge on it.
- **PR monitors / reviewers:** when watching CI, a single health-route timeout here should be flagged as the known flake, not a real failure.
- **Durable fix (if it becomes frequent):** raise the per-file timeout for this suite (e.g. a scoped `testTimeout`) or reduce gateway-suite parallelism, rather than editing the assertions. Not worth doing while it stays rare — captured here so recurrences are triaged in seconds instead of re-diagnosed each time.
