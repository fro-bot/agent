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

- **Trusting absence from the live set.** The first version of this fix confirmed the root stopped once it was absent from `session.status`. A live probe on OpenCode 1.19.0 seemed to support that: aborts sent 0 ms and about 500 ms after the `204` were honoured. Later probes on a cold server showed the static reading was right after all: an abort sent before the prompt's runner exists returns `true` and does nothing (no tombstone, no pending-prompt token), because preparation (agent and skill discovery, provider state, the `chat.message` hook) runs before the runner is registered. The prompt then starts 0.8–2.5 s later. Absence from status held in that window, so the barrier released the lock and slot and the prompt ran in a checkout the next run owned (#1958). The earlier probes had warm servers.
- **Treating session idle as terminal.** Idle also means "not started yet", and `session.status` has no "preparing" state, so absence proves nothing. The terminal marker is the last assistant message answering the latest user message with `time.completed` set.

## Solution

Every stop that may leave the root running passes `rootMayBeRunning: true` to `throwWithBarrier`. That covers:

- the wall-clock and operator-cancel timeouts;
- inactivity;
- a stream that ends before idle;
- an unexpected event-loop error;
- an abort during or after `promptAsync`.

Other failures keep the default `false`: unreachable, auth, prompt error, subscribe failure and drain timeout. When the flag is set, `throwWithBarrier` runs `settleOwnedSessions` with `confirmRootQuiescent: true`. It aborts the root and polls until the root is absent from the directory's live set **and** its session shows a terminal reply to the latest prompt (`packages/gateway/src/execute/root-stop.ts` `probeRootStop`), within the 15 s settle budget. Every poll that finds the root live sends another abort. If the root cannot be confirmed quiescent, the run quarantines.

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

- An abort is a request, not proof that the root stopped. Only a completed assistant reply to the latest user message is positive evidence; a root that has not started yet is absent from the live set too.
- A cold server loses an early abort. With no terminal reply inside the confirm window the run quarantines, and a root watch keeps probing through the quarantine hold, aborting again each time the root turns up busy, so a late prompt is stopped instead of running through the hold.
- An unconfirmed stop reuses the existing quarantine path, which holds the lock and slot for the quarantine window.
- A dead server always quarantines. `liveSessionIds` fails, so the root can never be seen absent. This is the intended fail-safe direction.

## Prevention

- `rootMayBeRunning` defaults to `false` in the `throwWithBarrier` options, so a new termination path in `run-core.ts` that omits it takes the fast path.
- `packages/gateway/src/execute/run-core.root-abort.test.ts` runs every stop reason against an absent ledger and against an empty one. It covers quarantine when the root stays live and when the abort fails, and it checks that a clean completion sends no abort.
- `packages/gateway/src/execute/run-core.root-abort.test.ts` (`a cold OpenCode server`) models a server that loses the first abort and starts the prompt later, inside and past the barrier. `settle-owned-sessions.test.ts` and `root-stop.test.ts` pin the evidence rules: an older turn's reply, no user message yet, an unfinished reply and a stale message list never confirm. When `base_version` in `packages/harness/harness.config.json` moves, re-run the live probe against a COLD server: abort at 0 ms and 500 ms after the `204`, then watch for busy status or written files for 40 s.

## Related Issues

- #1906 (fix) and #1889 (an operator cancel kept writing to the checkout)
- `docs/solutions/logic-errors/submission-failure-does-not-prove-the-work-never-started-2026-08-08.md`
- `docs/solutions/logic-errors/abortsignal-any-reason-classification-race-2026-07-03.md`
