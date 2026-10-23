---
title: An early gateway stop must abort and confirm the root session before releasing the lock and slot
date: 2026-10-22
category: logic-errors
module: gateway
problem_type: logic_error
component: service_object
symptoms:
  - "After a timeout, inactivity, stream end or operator cancel, the root session keeps running tools in the checkout"
  - "The next run takes the repo lock while the previous root is still writing to the same checkout"
  - "An event-stream rejection escapes the termination barrier and releases without quarantine"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - runtime
tags:
  - termination-barrier
  - session-abort
  - promptasync
  - quiescence
  - quarantine
  - fail-safe
---

## Problem

`promptAsync` forks the prompt in server scope and does not pass a request signal. Closing the event stream, dropping the client or releasing the run therefore does not stop it. Only `session.abort` does. On an early stop with an empty or absent ownership ledger, the termination barrier took its fast path and released the repo lock and slot without aborting the root. The root went on writing to the checkout while the next run took the lock.

In #1889, an operator cancel was followed by 11 more minutes of writes. Every later launch was then refused with the dashboard error "Checkout refused: uncommitted changes".

## Symptoms

- The wall-clock timeout, inactivity, the stream ending, operator cancel, and an abort during or after `promptAsync` all released while the root could still be running.
- An error from the event loop that was not a `RunCoreError` (a rejected stream, or a throw in the loop body) escaped `runOpenCodeCore` raw. `run.ts` treated it as unquarantined and released.
- For a cancel, the gateway logged `run-core: stream ended due to timeout signal` and then `run: execution aborted by operator cancel`. No line shows the session being stopped.

## What Didn't Work

- **Requiring positive evidence before trusting absence.** A static reading of the source suggested that an abort sent before the prompt runner exists is a no-op. If so, the root being absent from the live set would falsely confirm it was quiescent. A live probe on OpenCode 1.19.0 contradicted that reading: aborts sent 0 ms and about 500 ms after the `204` were honoured, and the prompt never ran.
- **Treating session idle as terminal.** Idle also means "not started yet". When a terminal marker is needed, use the last assistant message after the prompt with `time.completed` set.

## Solution

Every stop that may leave the root running passes `rootMayBeRunning: true` to `throwWithBarrier`. That covers:

- the wall-clock and operator-cancel timeouts;
- inactivity;
- a stream that ends before idle;
- an unexpected event-loop error;
- an abort during or after `promptAsync`.

Other failures keep the default `false`: unreachable, auth, prompt error, subscribe failure and drain timeout. When the flag is set, `throwWithBarrier` runs `settleOwnedSessions` with `confirmRootQuiescent: true`. It aborts the root and polls the directory's live set until the root is absent (`packages/gateway/src/execute/settle-owned-sessions.ts:244-254`), within the 15 s settle budget. If the root cannot be confirmed quiescent, the run quarantines.

The fast-path decision in `throwWithBarrier` is at `packages/gateway/src/execute/run-core.ts:673-679`:

```ts
const rootFollowUpOpen =
  rootMayBeRunning ||
  (drainCompletion !== undefined && draining === true && drainDoneController.signal.aborted === false)
const barrierLedger = ledger ?? (rootMayBeRunning ? createOwnershipLedger() : undefined)
if (barrierLedger === undefined || (barrierLedger.isDrainComplete() === true && rootFollowUpOpen === false)) {
  throw new RunCoreError(kind, message, false, providerFailureReason, cause)
}
```

A catch around the event loop sends every error that is not a `RunCoreError` through `throwWithBarrier` as `stream-ended`, with `rootMayBeRunning: true` and the original error as `cause` (`packages/gateway/src/execute/run-core.ts:1381-1392`).

A `promptAsync` that throws after the run signal aborted is treated as a stop where the root may be running (`packages/gateway/src/execute/run-core.ts:765-773`). A throw while the signal is untouched keeps the `unreachable` fast path. That assumes the server never accepted the prompt, which the client cannot prove (see `submission-failure-does-not-prove-the-work-never-started-2026-08-08.md`).

## Why This Works

- An abort is a request, not proof that the root stopped. Absence from the directory-scoped live set after the abort is the confirmation.
- The probe that sent early aborts at 0 ms and 500 ms after the `204` (one run each) saw them honoured. Absence after an early abort therefore counts as confirmation.
- An unconfirmed stop reuses the existing quarantine path, which holds the lock and slot for the quarantine window.
- A dead server always quarantines. `liveSessionIds` fails, so the root can never be seen absent. This is the intended fail-safe direction.

## Prevention

- `rootMayBeRunning` defaults to `false` in the `throwWithBarrier` options, so a new termination path in `run-core.ts` that omits it takes the fast path.
- `packages/gateway/src/execute/run-core.root-abort.test.ts` runs every stop reason against an absent ledger and against an empty one. It covers quarantine when the root stays live and when the abort fails, and it checks that a clean completion sends no abort.
- `confirms and releases on absence after an abort sent right after promptAsync returned` in `packages/gateway/src/execute/settle-owned-sessions.test.ts` pins the probe result with a mock. When `base_version` in `packages/harness/harness.config.json` moves, re-run the live probe: abort at 0 ms and 500 ms after the `204`, then watch for busy status or written files for 40 s.

## Related Issues

- #1906 (fix) and #1889 (an operator cancel kept writing to the checkout)
- `docs/solutions/logic-errors/submission-failure-does-not-prove-the-work-never-started-2026-08-08.md`
- `docs/solutions/logic-errors/abortsignal-any-reason-classification-race-2026-07-03.md`
