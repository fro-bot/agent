---
title: Every ownership-ledger reconcile pass needs a bound, a signal and a guarded ledger
date: 2026-10-22
category: logic-errors
module: agent-execution
problem_type: logic_error
component: service_object
symptoms:
  - "One hung children() or status() call stops periodic reconciliation for the rest of the run"
  - "A reconcile answer that arrives after the drain decision flips an entry, so cleanup saves the cache while drain reports unresolved work"
  - "The 30 s reconciler interval stays armed in the gateway daemon after a run fails before its event loop"
root_cause: async_timing
resolution_type: code_fix
severity: high
related_components:
  - gateway
  - runtime
tags:
  - reconcile
  - ownership-ledger
  - timeout
  - abort-signal
  - guarded-writes
  - livelock
  - drain
---

## Problem

Reconcile passes over the ownership ledger had no time bound and no signal. This applied to the Action drain (initial, periodic, cancel and confirm passes, plus child aborts) and to the gateway live path (the periodic tick and the root-idle one-shot). `createLedgerReconciler` skips a tick while a pass is in flight, so one call that never answered stopped reconciliation for good. An answer that arrived late could also mutate the ledger after a decision had been made on it.

## Symptoms

- `createLedgerReconciler` at `packages/runtime/src/agent/ledger-reconcile.ts:315-318` skips every later periodic tick while a hung pass holds the `inFlight` flag. Owned background work stops being settled from status.
- A late answer turns an `unknown` entry into `settled`. `isPersistenceSafe()` then becomes true, and cleanup saves the cache even though drain reported ownership as unresolved.
- A subscribe or `promptAsync` failure before the event loop leaves the reconciler interval ticking, because the loop's `finally` never runs on that path.

## What Didn't Work

- **A 5 s bound on the gateway live path.** A server that answers in 6 s would time out on every pass. The child would stay `unknown`, drain would never admit it, and the run would livelock until the drain timeout. The live bound is therefore the 15 s settle budget. The Action drain keeps 5 s per call (`DRAIN_CALL_TIMEOUT_MS` in `src/harness/phases/execute.ts:554`): it runs inside a terminal budget where an `unknown` entry is cancelled at the deadline anyway.

## Solution

Each pass races its bound and aborts its signal when the bound expires. A timeout does exactly what a failed pass does: outstanding entries become `unknown`, and a warning is logged. The pass writes through a ledger whose `settle` and `markUnknown` become no-ops once the pass is abandoned or the owner is closed.

The gateway live pass is `reconcileLivePass`, in `packages/gateway/src/execute/live-reconcile.ts:34-94`. Its bound is `LIVE_RECONCILE_TIMEOUT_MS`, defined at `packages/gateway/src/execute/live-reconcile.ts:28`. The excerpt below leaves out logging and the `catch`/`finally` that clears the timer:

```ts
export const LIVE_RECONCILE_TIMEOUT_MS = DEFAULT_SETTLE_TIMEOUT_MS

export async function reconcileLivePass(
  options: ReconcileLedgerOptions,
  isClosed: () => boolean,
  timeoutMs: number = LIVE_RECONCILE_TIMEOUT_MS,
): Promise<void> {
  const {ledger} = options
  if (isClosed()) return
  const controller = new AbortController()
  let abandoned = false
  const inert = (): boolean => abandoned || isClosed()
  const guardedLedger: OwnershipLedger = {
    ...ledger,
    settle: sessionId => {
      if (inert() === false) ledger.settle(sessionId)
    },
    markUnknown: sessionId => {
      if (inert() === false) ledger.markUnknown(sessionId)
    },
  }
  const timedOut = new Promise<"timed-out">(resolve => {
    timer = setTimeout(() => {
      abandoned = true // before the abort: an abort-triggered answer must find the guard closed
      controller.abort()
      resolve("timed-out")
    }, timeoutMs)
  })
  const outcome = await Promise.race([
    reconcileLedgerOnce({...options, ledger: guardedLedger, signal: controller.signal}).then(() => "finished" as const),
    timedOut,
  ])
  if (outcome === "finished" || isClosed()) return
  // timed out: mark outstanding entries unknown, exactly as a failed pass does, and log a warning
}
```

`createLedgerReconciler` takes an injected `runPass` (`packages/runtime/src/agent/ledger-reconcile.ts:289`), so the periodic tick runs the bounded pass. In `runOpenCodeCore`:

```ts
// packages/gateway/src/execute/run-core.ts:611-617
createLedgerReconciler({
  ...liveReconcileOptions,
  runPass: async () => reconcileLivePass(liveReconcileOptions, () => liveReconcileClosed),
})

// packages/gateway/src/execute/run-core.ts:667-672, the top of throwWithBarrier
liveReconcileClosed = true
reconciler?.dispose()
drainCompletion?.dispose()
```

The Action drain does the same with `boundedCall` and `reconcileBounded` (`src/harness/phases/execute.ts:597-658`). Its periodic reconciler takes `runPass: reconcilePass`.

## Why This Works

- The race releases the in-flight slot, so the next tick runs. The abort tells the client to drop the request.
- The guard makes abandonment final. Once the bound has passed, or teardown owns the ledger, no answer can change an entry. Teardown's settle has its own guard, `attemptLedger`.
- Timeouts reuse the failed-pass semantics, so run completion does not change. An `unknown` entry blocks drain just as an `outstanding` one does, and a later successful pass can still settle it.
- Disposing the reconciler and drain-completion inside `throwWithBarrier` covers exits before the event loop. The loop's `finally` never runs on those paths.

## Prevention

- Live and drain passes reconcile through `reconcileLivePass` (gateway) or `reconcileBounded` (Action). Teardown's settle calls `reconcileLedgerOnce` directly, bounded by its teardown signal and guarded by `attemptLedger` (`packages/gateway/src/execute/settle-owned-sessions.ts:226`).
- Size a bound against the slowest server that still answers, not only against a hung one. A bound below normal latency turns slowness into a permanent `unknown`.
- Tests:
  - `packages/gateway/src/execute/live-reconcile.test.ts` covers the bound and the guard.
  - `packages/gateway/src/execute/run-core.live-reconcile.test.ts` covers hung ticks, late answers and the pre-loop timer leak. It also has the livelock pin: `settles the child and completes the run when reconcile answers at 6 s, inside the bound`.
  - The `drain` tests in `src/harness/phases/execute.test.ts` cover the Action side.
  - `packages/runtime/src/agent/ledger-reconcile.test.ts` covers `runPass`.

## Related Issues

- #1906 (Action drain), #1907 (gateway live path)
- `docs/solutions/best-practices/promise-race-bounds-await-not-subprocess-2026-07-30.md`: a race bounds the await, and a signal asks for cancellation.
- `docs/solutions/best-practices/extract-timer-primitive-keep-policy-per-surface-2026-07-13.md`: share the mechanism and keep the policy per surface.
