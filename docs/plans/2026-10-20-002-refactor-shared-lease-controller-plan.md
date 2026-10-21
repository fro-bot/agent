---
title: "refactor: one lease loop for the Action and the gateway"
type: refactor
status: active
date: 2026-10-20
origin: docs/brainstorms/2026-10-18-action-gateway-consolidation-requirements.md
---

# refactor: one lease loop for the Action and the gateway

## Overview

The Action and the gateway each renew their S3 coordination lock with their own code:

- the Action uses `createLeaseController` in `acquire-lock.ts`;
- the gateway uses `createHeartbeatController` in `runtime/coordination/heartbeat.ts`.

Both run a renewal loop, track the latest lock ETag, guard against overlapping ticks, bound `stop()` with a 5 s grace period, and record failures. They also differ in ways nobody chose:

- the gateway has no per-tick timeout;
- only the Action unrefs its timers;
- only the Action logs failed renewals.

This rung moves the mechanics into one runtime lease loop. Each surface keeps its own takeover policy and its own per-tick work (the gateway also writes RunState). It ships as three PRs, in expand-then-contract order:

- **PR-A** is behaviour-neutral: the loop, with the Action moved onto it.
- **PR-B** moves the gateway onto the loop. It adds a 10 s tick timeout and abort-on-deadline, which also turns on for the Action.
- **PR-C** (folded into PR-B) adds ownership-checked ETag adoption after a failed renewal, on both surfaces. A tick timeout drops a renewal that may have committed, so the gateway timeout must ship with its recovery.

## Problem Frame

- **Duplicated mechanics drift.** The 5 s grace constant exists twice: `acquire-lock.ts` `STOP_GRACE_PERIOD_MS` and runtime `HEARTBEAT_STOP_GRACE_MS`. #1892 had to fix stop bounding, ETag tracking and late ticks in the gateway copy only.
- **Gateway ticks have no timeout.** A hung renewal or RunState request keeps `inFlight` set forever. Every later tick returns early without a sound until `stop()`, so the lease can lapse mid-run. Takeover still requires a quiet workspace, which bounds the impact, but the lease stops being renewed.
- **Late in-flight window.** A renewal or RunState write already on the wire when `stop()` begins can still land, because `conditionalPut` takes no `AbortSignal`. Client abort narrows this window but cannot close it: an aborted S3 PUT can still commit server-side and come back to us as an error.
- **A renewal can commit but return an error.** S3 has then advanced the lock ETag while the caller kept the old one. Release 412s, and the lock lingers until its TTL runs out.

## Requirements Trace

- **R1.** One runtime lease loop owns:
  - scheduling;
  - the per-tick timeout;
  - the overlap guard;
  - the stopping flag;
  - the shared stop budget;
  - the freshest confirmed lock ETag;
  - the failure state;
  - failure logging.

  Surfaces inject their renew function and their per-tick body, and keep their own takeover policy (consolidation R1/R8; lease decision C).

- **R2.** The loop keeps every #1892 guarantee:
  - one shared stop budget;
  - `stop()` never rejects;
  - stop is one-way;
  - the stopping flag is checked before I/O;
  - every failure carries the freshest confirmed ETags;
  - `stop()` reports a failed last tick;
  - a skipped tick changes nothing.
- **R3.** PR-A is behaviour-neutral for the Action. The proof is golden adapter-call traces recorded before extraction, plus the existing suites passing with no edits.
- **R4.** The gateway heartbeat keeps its public name and shape (`createHeartbeatController`, `HeartbeatController`, `HeartbeatStopError`). The only change is one additive optional parameter (the acquisition token). RunState composition stays in the gateway layer.
- **R5.** In PR-B, every tick on both surfaces is bounded by a 10 s timeout. In-flight requests are aborted when the tick timeout or the stop budget runs out, not when `stop()` begins.
- **R6.** A result from a superseded attempt (one whose tick timeout fired) is never applied to loop state or to the gateway's run ETag. `stop()` does not supersede an in-flight attempt: a result that lands after `stop()` returned but before the tick timeout still applies, as it does on the Action today. A late confirmed renewal is still our own ETag, so a release that reads `currentEtag()` afterwards succeeds. A late failure after stop is harmless, because `tickPending` has already latched continuity.
- **R7.** After a failed renewal, the loop re-reads the lock once, within the tick's bounds, and adopts the stored ETag if the record is ours:
  - Action: `holder_id`, `holder_job` and `acquisition_token` match.
  - Gateway: `holder_id`, `run_id` and this acquisition's `acquisition_token` match.
  - Adoption clears `hasFailed` and leaves `continuityUnverified` latched.
- **R8.** Gateway lock records carry a per-acquisition `acquisition_token`. Old readers ignore it.
- **R9.** These docs describe the shared loop and the adoption rule: `packages/gateway/AGENTS.md`, `ARCHITECTURE.md`, `STRUCTURE.md`, `docs/solutions/best-practices/centralize-s3-key-identity-construction-2026-06-09.md` (lines 40-41) and `docs/wiki/Troubleshooting.md` (re-verify the lease-renewal wording).

## Scope Boundaries

- **Takeover policy is unchanged.** The Action keeps direct reclaim plus its early-takeover gates. The gateway keeps `ConfirmExpiredHolder` workspace corroboration.
- **Acquisition** (`acquireLock`, `runAcquireLock`) is not redesigned.
- **RunState composition**, the stale-ETag transition helper and quarantine stay in the gateway.
- **The Action's cleanup persistence gate** and post-hook orphan release are unchanged.
- **The post-hook persistence retry** is #1890 and is not part of this rung.
- **Lock release** keeps its current ETag and holder rules.

## Context & Research

- Research: `/tmp/lease-rung/repo.md`, against #1892's head, merged as `4dbd5573e`. The takeover decision memo is `/tmp/lease-takeover/memo.md`. Document reviews: `/tmp/lease-rung/dr/`.
- **Action:** `src/harness/phases/acquire-lock.ts`.
  - `createLeaseController` (~169-265) is not exported. `LeaseController` (35-126) is its view type.
  - Constants and helpers: `RENEWAL_TIMEOUT_MS` (134), `STOP_GRACE_PERIOD_MS` (141), a local `delay` with `unref` (144-149) that is not cleared when its race is won, and `withTimeout` (151-167). `runWithDeadline` (382-399) calls `withTimeout`.
  - A timeout abandons the request, and a late success is dropped, because the `.then` hangs off the already-rejected `withTimeout` promise.
  - Consumers: `src/harness/run.ts` and `cleanup.ts`.
  - Tests mock `renewLease` at the `@fro-bot/runtime` boundary (`acquire-lock.test.ts:27-37`).
- **Gateway:** `packages/runtime/src/coordination/heartbeat.ts`.
  - A tick reads RunState, renews the lock, then writes RunState. A failed renewal throws, which skips the write.
  - `stop()` returns the last tick error (`:249-251`).
  - A skipped tick doesn't clear an earlier error (`:193-197`).
  - Consumers: `packages/gateway/src/execute/run.ts` (~974, stop sites ~1083, ~1560, ~1802, ~1913, quarantine ~684) and `packages/gateway/src/discord/maintenance-run.ts` (~102).
  - Tests: `heartbeat.test.ts`, `execute/test-helpers.ts` (mock), and two real-heartbeat consumers: `web/operator/launch-prompt.integration.test.ts` and `execute/run.provenance.test.ts`.
- **Adapter:** `object-store/types.ts`. `conditionalPut` has no `signal`; `conditionalDelete` and `getObject` do. `s3-adapter.ts` passes `abortOptions(signal)` as the second argument to `client.send`. `renewLease` (`lock.ts` ~414-435) takes no signal. `readLockRecord` (`lock.ts` ~491) is not exported.
- **Assertions that break:** `heartbeat.test.ts:365-371` asserts `renewLease` was called with exactly five arguments. `:154-158` asserts exact `conditionalPut` options. (`:181` and `:215` use `objectContaining` and `toMatchObject`, so they are fine.)

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "packages/runtime/src/coordination, packages/runtime/src/object-store, src/harness/phases/acquire-lock.ts, packages/gateway/src/execute, packages/gateway/src/discord/maintenance-run.ts",
  "freshness": {
    "vcs_reference": "4dbd5573e"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 10,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "packages/runtime/src/coordination/heartbeat.ts createHeartbeatController",
      "description": "Gateway lease plus RunState heartbeat with the #1892 stop guarantees",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/harness/phases/acquire-lock.ts createLeaseController",
      "description": "Action lease renewal with a 10 s per-renewal timeout and continuity latch",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/runtime/src/coordination/lock.ts renewLease",
      "description": "Conditional lock renewal",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/harness/phases/acquire-lock.ts runWithDeadline / withTimeout",
      "description": "AbortController-backed deadline used by the Action release paths",
      "disposition": "insufficient",
      "insufficiency_reason": "Release-scoped and Action-local; the loop needs a per-tick timeout plus a shared stop budget with generation tracking, so it keeps its own internal deadline handling and both helpers stay for release"
    }
  ]
}
```

## Key Technical Decisions

- **Runtime `createLeaseLoop`** lives in `packages/runtime/src/coordination/lease-loop.ts`. It has a different name from the Action's local `createLeaseController`, which Unit 4 deletes.
  - **Ownership:** the loop owns scheduling, timeouts, stopping, the lock ETag, failure state, the stop budget and failure logging.
  - **Inputs:** each surface passes `renew(record, etag, signal?)` and a `tick` body.
  - **Why `renew` is injected:** the Action passes the `renewLease` it imports from `@fro-bot/runtime`, so the existing test mock keeps intercepting it.
- **Tick context.** The body receives `{signal, isStopping, isCurrent, renewLock}`.
  - `signal` is `undefined` unless `abortOnDeadline` is on.
  - `renewLock(record)` returns `'renewed'` or `'skipped'`. It returns `'skipped'` when stopping or superseded, and throws when the renewal isn't confirmed, so the body's later I/O doesn't run.
  - `renewLock` records the new lock ETag before it resolves, but only while the attempt is still current.
  - `isCurrent()` lets the body drop its own late results; the gateway uses it for its run ETag.
  - An optional `finalize(signal?)` runs inside the same stop budget. The gateway uses it for the RunState snapshot.
- **Abort is opt-in** (`abortOnDeadline`).
  - **Off:** no signal is created or passed, and timed-out and stop-abandoned requests are left to settle, as today.
  - **On:** the loop creates one `AbortController` per tick and aborts it when the tick timeout or the stop budget runs out, never when `stop()` begins.
  - **When it turns on:** PR-A keeps it off for the Action. PR-B turns it on for both surfaces.
  - **Wiring for PR-B:** Unit 2 adds the optional `signal` to `conditionalPut` and `renewLease` (passed only when defined).
- **Failure state.**
  - **Generations:** each tick attempt carries a generation number.
  - **`hasFailed`** is true after a tick ends without a confirmed renewal, and false after one ends with a confirmed renewal.
  - **Skipped ticks:** a tick that skips its I/O, or a superseded (timed-out) attempt, changes neither `hasFailed` nor the stored last error.
  - **`continuityUnverified` latches** when a tick ends without a confirmed renewal: a renewal failure, a body failure before the renewal, a timeout before the renewal confirms, or `tickPending` at stop. A body failure or timeout _after_ a confirmed renewal doesn't latch. The Action has no I/O after its renewal, so this matches its behaviour exactly.
- **Stop.**
  - `stop()` sets stopping first. `start()` after `stop()` is a no-op.
  - One timer covers the whole budget: wait for the in-flight tick, then run `finalize` with whatever is left, and clear the budget timer on every exit.
  - **Never rejects.**
  - **Failure:** it returns `err` carrying the freshest confirmed lock ETag, `tickPending` and the last tick error when the in-flight tick is still pending, the last tick ended without a confirmed renewal, or `finalize` failed or ran out of budget.
- **Timers.**
  - **`unref` coverage:** `unref` applies to every loop timer (interval, tick timeout and stop budget). The Action sets it; the gateway, a daemon, does not.
  - **Clearing:** the loop clears its timers on every exit. Today the Action's grace `delay` lingers for up to 5 s, unref'd. Clearing it can't be seen from outside, so the golden traces assert adapter calls and their ordering, not leftover timers.
  - **Exception:** the in-flight attempt's own tick timeout stays armed after `stop()` gives up on a pending tick. It has to: the Action pins that an abandoned tick still times out and records its failure. When `stop()` gives up on a pending attempt, the loop unrefs that attempt's tick timer: it still fires while the process lives, but it never holds the gateway's shutdown (PR-B).
- **Action composition.**
  - **Tick body:** renews the constant identity record, which carries `holder_job` and `acquisition_token`.
  - **Settings:** `unref: true`, tick timeout `RENEWAL_TIMEOUT_MS` (10 s), stop budget `HEARTBEAT_STOP_GRACE_MS` (5 s), and `abortOnDeadline: false` in PR-A, `true` in PR-B.
  - **View:** `LeaseController` stays a view, and its `stop()` stays `Promise<void>`. A `tickPending` stop already latches continuity.
  - **Deleted:** the local `delay`, `STOP_GRACE_PERIOD_MS` and the renewal loop.
  - **Kept:** `withTimeout` and `runWithDeadline`, which the release paths use.
- **Gateway composition (PR-B).**
  - **Wrapper:** `createHeartbeatController` becomes a thin layer. Each tick: if stopping, return; read RunState; `renewLock(recordFrom(state))`; if renewed and still current, write RunState; then update its own `runEtag` only if `isCurrent()`.
  - **Result mapping:** it maps the loop's result back to `HeartbeatStopResult` / `HeartbeatStopError`, carrying `runEtag` from the layer.
  - **Settings:** `unref: false`, a 10 s tick timeout and `abortOnDeadline: true`.
  - **Error text:** stop errors use the loop's text (`Lease tick did not settle…`, `Lease finalize did not settle…`); no caller branches on it. The stop-path debug lines go away, as on the Action.
  - **Skipped tick:** stop beginning after the RunState read makes `renewLock` return `'skipped'`; the tick changes nothing, as today.
  - **Renew-then-skip:** a tick that confirms a renewal and then skips its RunState write because stop began clears an earlier tick's failure, so `stop()` reads a fresh snapshot and returns ok. Today the earlier error persists and the caller gets a stale `runEtag`. This is a named improvement.
- **Adoption (folded into PR-B).**
  - **Trigger:** runs inside the tick body after `renewLock` throws (no confirmed renewal), bounded by the same tick timeout and stop budget.
  - **Gating:** skipped if stopping or superseded.
  - **Read:** uses a lock read that `lock.ts` exports, with the tick's signal when there is one.
  - **Adopt:** takes the stored ETag when the surface's `ownsRecord(stored)` is true and the ETag differs from ours. Clears `hasFailed`, keeps `continuityUnverified` latched, and logs at info.
  - **Absent fields:** `ownsRecord` treats a field that is absent on both sides (such as an optional Action `holder_job`) as a match.
- **Gateway `acquisition_token` (folded into PR-B).**
  - **Generation:** a fresh UUID per acquisition, passed to `acquireLock`.
  - **Carrier:** an optional trailing parameter on `createHeartbeatController` (additive), threaded through `run.ts` and `maintenance-run.ts`. The heartbeat's renewal record includes it.
  - **Rollout:** an older gateway build renews records without the token. Adoption then fails closed for those records (no adoption, the lease falls back to its TTL), and the loop logs it. The gateway is one daemon, so this lasts only for the duration of a deploy.

## Open Questions

### Deferred to Implementation

- **Logger type:** the loop takes the runtime `Logger` (`debug`/`info`/`warning`). The gateway passes `toRuntimeLogger`'s output.
- **`getRunKey` at construction:** whether it should keep throwing. Keep the current behaviour unless the move forces a change.
- **Unverified:** whether S3 returns 412 or 404 for an `IfMatch` PUT on a deleted key. Pin the adapter mapping with a test. Under either code, a late renewal must not resurrect a released lock.

## Implementation Units

### PR-A: loop plus Action (behaviour-neutral)

- [x] **Unit 1: Golden-trace characterization**

**Goal:** Record today's adapter calls and their ordering for both surfaces, so every later unit can prove neutrality.

**Requirements:** R3

**Files:** Create `packages/runtime/src/coordination/lease-golden.test.ts` (gateway scenarios) and `src/harness/phases/acquire-lock.golden.test.ts` (Action scenarios).

**Approach:**

- Use fake timers and a recording in-memory adapter.
- Record `op`, key, options (`ifMatch`, `ifNoneMatch`, `tagging`, signal present or absent), the order of renewals, stop, release and RunState writes, and the tick spacing.
- Do not record leftover timers.
- Write traces as explicit arrays, not `.snap` files.
- Drive the Action scenarios through `runAcquireLock`, with the test's `@fro-bot/runtime` mock of `renewLease`.

**Test scenarios:**

- **Action:**
  - tick success;
  - renewal failure;
  - renewal throws;
  - renewal timeout (10 s);
  - a late renewal success after the timeout, which is not applied;
  - stop with a tick pending;
  - stop with no tick;
  - `settle`.
- **Gateway** (current behaviour; PR-B updates these deliberately):
  - read → renew → write order;
  - renew OK then the RunState write fails;
  - a renewal failure skips the write;
  - stop after a failed tick returns the error;
  - stop with a tick pending;
  - stop with the snapshot pending;
  - `start` after `stop`.

**Verification:** Passes on unchanged code.

- [x] **Unit 2: Optional abort signal on `conditionalPut` and `renewLease`**

**Goal:** Requests can be aborted. No caller passes a signal yet.

**Requirements:** R5 (groundwork)

**Files:** `packages/runtime/src/object-store/types.ts`, `s3-adapter.ts`, `s3-adapter.test.ts`, `packages/runtime/src/coordination/lock.ts`, `lock-scope.test.ts`

**Approach:**

- Add `signal?: AbortSignal` to the `conditionalPut` options. Pass it to `client.send` through `abortOptions` only when defined.
- Add an optional trailing `signal` to `renewLease`, forwarded only when defined.
- Grep every `conditionalPut(` caller to confirm none of them changes.

**Test scenarios:**

- `client.send` gets `abortSignal` only when a signal is given.
- An aborted PUT maps to `err`.
- `renewLease` forwards the signal.
- Existing exact assertions are unchanged.

**Verification:** Runtime tests pass. Golden traces are identical.

- [x] **Unit 3: Runtime lease loop**

**Goal:** `createLeaseLoop` with contract tests. Not used in production yet.

**Requirements:** R1, R2, R6

**Files:** Create `packages/runtime/src/coordination/lease-loop.ts` and `lease-loop.test.ts`. Export them by name from `coordination/index.ts`.

**Approach:** Implement the Key Technical Decisions: injected `renew`, the tick context, generation-guarded results, opt-in abort, the shared stop budget with an optional `finalize`, one-way stop, the stop failure contract, the failure-state rules, timer `unref` and clearing, and warning logs.

**Test scenarios** (each one revert-checked):

- **Stop budget:** one shared budget. The tick plus `finalize` resolve within about 5 s total, and every loop timer is cleared, except the tick timeout of an attempt that `stop()` gave up on (see Timers).
- **Never rejects:** `stop()` never rejects. A thrown error from `renew`, the body or `finalize` comes back as `err`.
- **Stop errors:**
  - `stop()` returns the last tick's failure when no confirmed renewal followed it (mirrors `heartbeat.test.ts:374`).
  - A skipped or superseded tick does not reset `hasFailed` or the stored error (mirrors `:808`).
- **One-way stop:** `start()` after `stop()` is a no-op.
- **`renewLock`:**
  - returns `'skipped'` when stopping or superseded;
  - throws on an unconfirmed renewal, so the body's later I/O doesn't run (mirrors `:221`).
- **ETag freshness:** every failure carries the freshest confirmed lock ETag.
- **Late results:** a late result from a timed-out attempt changes neither the lock ETag nor anything the body gates on `isCurrent()`. A result that lands after `stop()` returned but before the tick timeout still applies (matches the Action golden trace).
- **Abort:**
  - with `abortOnDeadline: false`, no signal is created or passed;
  - with it on, abort fires at the tick timeout and at budget expiry, not at `stop()` begin.
- **Latch:** `continuityUnverified` latches when a tick ends without a confirmed renewal, and not on a failure or timeout after a confirmed renewal.
- **`unref`:** applies to every loop timer when set.

**Verification:** New tests pass. `check-types` passes.

- [x] **Unit 4: Action on the loop**

**Goal:** The Action's renewal uses `createLeaseLoop`. Behaviour is unchanged.

**Requirements:** R1, R3

**Files:** `src/harness/phases/acquire-lock.ts`, `dist/`

**Approach:**

- Build the loop with the Action's injected `renewLease`, its tick body and its settings (`abortOnDeadline: false`).
- Expose the existing `LeaseController` view: `hasFailed`, `continuityUnverified`, `settle`, `currentEtag`, `stop`.
- Delete the local renewal loop, `delay` and `STOP_GRACE_PERIOD_MS`. Keep `withTimeout` and `runWithDeadline`.
- `cleanup.ts`, `run.ts` and `post.ts` are unchanged.
- Rebuild `dist/`.

**Verification:**

- Action golden traces are identical.
- `acquire-lock*.test.ts`, `cleanup*.test.ts`, `post.test.ts`, `run.test.ts` and `outcome.test.ts` pass with no edits to existing test files.

### PR-B: gateway on the loop (tick timeout, abort)

- [x] **Unit 5: Gateway heartbeat as a RunState layer; abort on for both surfaces**

**Goal:**

- `createHeartbeatController` composes RunState over the loop. Its public name and types are unchanged.
- Gateway ticks are bounded at 10 s.
- Abort-on-deadline is on for both surfaces.

**Requirements:** R2, R4, R5, R6

**Files:** `packages/runtime/src/coordination/heartbeat.ts`, `heartbeat.test.ts`, `lease-loop.ts` and `lease-loop.test.ts` (unref an abandoned attempt's timer at stop), the golden traces, `src/harness/phases/acquire-lock.ts` (`abortOnDeadline: true`, signal forwarded to `renewLease`), `packages/gateway/src/execute/stale-etag-transition.ts` (signal on its recovery read), `dist/`

**Approach:**

- **Tick body:** if stopping, return; read RunState with the signal; `renewLock(recordFrom(state))`; if renewed and current, write RunState with the signal; set the layer's `runEtag` only when `isCurrent()`.
- **`finalize`:** reads the snapshot.
- **Result mapping:** map the result back to the heartbeat types.
- **Settings:** a 10 s tick timeout, `unref: false`, `abortOnDeadline: true`.
- **Action:** turn on `abortOnDeadline` and forward the signal as `renewLease`'s trailing argument.
- **Loop:** when `stop()` gives up on a pending attempt, unref that attempt's tick timer.
- **Deletions:** delete the gateway's duplicate mechanics and the duplicate grace constant.
- **Rebuild:** rebuild `dist/`.

**Test scenarios:**

- A hung renewal times out at 10 s; the next tick runs and a warning is logged.
- A hung RunState write times out without losing the confirmed lock ETag, and without latching.
- A late renewal result or late RunState write after a timeout is not applied.
- The RunState read does not start after stop.
- The abort signal reaches the RunState read and write, the snapshot, and the Action renewal.
- After `stop()` gives up on a pending attempt, that attempt's tick timer is unref'd and still records its timeout.
- Stop beginning after the RunState read skips the tick and keeps an earlier error.
- A tick that renews and then skips its write because stop began clears an earlier write failure; `stop()` returns ok with the fresh snapshot.
- **Existing `heartbeat.test.ts` guarantees still pass.** The known adjustments, each listed in the PR:
  - `:365-371`, the five-argument `renewLease` check, gains the explicit scope and signal;
  - `:154-158`, exact `conditionalPut` options, gains the signal;
  - Action `renewLease` argument assertions gain the signal.

**Verification:**

- **Golden traces** change only for the named changes:
  - gateway tick timeout;
  - abort on both surfaces;
  - read-after-stop;
  - late results from timed-out gateway ticks;
  - stop error text (`Heartbeat …` to `Lease …`);
  - renew-then-skip returns ok.
- **These pass:**
  - `run.quarantine*.test.ts`
  - `run.lifecycle.test.ts`
  - `run.provenance.test.ts`
  - `launch-prompt.integration.test.ts`
  - `maintenance-run.test.ts`
  - `stale-etag-transition.test.ts`
  - Action suites
- **Mocks:** `test-helpers.ts` mocks still compile.
- **`dist/`:** confirm whether `dist/` changes.
- **PR note:** a renewal dropped by the tick timeout or an abort may have committed server-side. Without adoption the loop would keep a dead ETag for the rest of the run: every later renewal 412s and release lingers to TTL. Units 7-8 ship in the same PR to recover it.

- [x] **Unit 6: Docs for the shared loop**

**Goal:** Docs describe the shared loop and the gateway tick timeout.

**Requirements:** R9

**Files:**

- `packages/gateway/AGENTS.md`
- `ARCHITECTURE.md` (lease section ~288 and the code map)
- `STRUCTURE.md` (`coordination/` entry)
- `docs/solutions/best-practices/centralize-s3-key-identity-construction-2026-06-09.md` (lines 40-41)

**Verification:** Prettier and the link check pass. The wording describes current state only.

### PR-C (folded into PR-B): ownership-checked ETag adoption

- [ ] **Unit 7: Gateway `acquisition_token`**

**Goal:** Gateway lock records carry a per-acquisition token.

**Requirements:** R8

**Files:** `packages/runtime/src/coordination/heartbeat.ts` (optional trailing `acquisitionToken` parameter), `packages/gateway/src/execute/run.ts`, `packages/gateway/src/discord/maintenance-run.ts`, `packages/gateway/src/runtime-effect.ts` (if it re-exports the heartbeat type), and the relevant tests

**Approach:** Generate a UUID per acquisition and pass it to `acquireLock` and to `createHeartbeatController`. The heartbeat's renewal record includes it.

**Test scenarios:**

- The acquired record carries the token.
- Every renewal keeps it.
- Corroborated takeover of a token-bearing record is unchanged.
- Existing callers without the parameter still compile and behave the same.

- [ ] **Unit 8: Adoption after a failed renewal**

**Goal:** Recover a renewal that committed but returned an error.

**Requirements:** R7

**Files:**

- `packages/runtime/src/coordination/lock.ts` (export a lock read returning the record and ETag)
- `lease-loop.ts` and its tests
- `acquire-lock.ts` (`ownsRecord`)
- the heartbeat layer (`ownsRecord`)
- `acquire-lock.integration.test.ts`
- `dist/`

**Approach:**

- **Trigger:** inside the tick, after `renewLock` throws.
- **Gate:** skip if stopping or superseded.
- **Read:** read the lock with the tick's signal, under the tick timeout and stop budget.
- **Adopt:** when `ownsRecord(stored)` is true and the ETag differs, adopt it. Clear `hasFailed`, keep the latch, and log at info.
- **Stop path:** when `stop()` ends on a tick failure or a pending tick, run one adoption read within the remaining stop budget (with its signal), so the returned `lockEtag` is the stored one when the record is ours. A failed or timed-out read changes nothing.
- **Ownership:** gateway matches `holder_id`, `run_id` and `acquisition_token`; the Action matches `holder_id`, `holder_job` (absent on both sides matches) and `acquisition_token`.

**Test scenarios** (the adoption matrix):

- **Ours, committed with an error:** adopt.
- **Ours, not committed:** no change.
- **412 against a successor's record:** no adoption.
- **Read fails or times out:** no adoption, and the latch is set.
- **Stop arrives during the adoption read:** no adoption once the budget runs out.
- **Adoption read resolves after its tick timed out:** not applied.
- **A late commit after adoption:** the next tick 412s, recovery converges, and otherwise the lease lapses by TTL.
- **Same `holder_id` but a different token or `run_id`:** never adopted.
- **Absent `holder_job` on both sides:** matches.
- **Record renewed by an old build without the token:** not adopted, and logged.
- **Release after adoption:** succeeds.
- **Renewal committed, then dropped by the tick timeout:** the next tick's renewal 412s, adoption takes the stored ETag, and the following tick renews.
- **Stop after a dropped committed renewal:** the stop-path read adopts, and release succeeds.
- **Stop-path read fails, times out, or finds another holder:** `lockEtag` unchanged, and `stop()` still resolves within the budget.

**Verification:** The matrix passes on both surfaces. The integration test is extended. `dist/` is rebuilt. `settle()` stays bounded by the 10 s tick timeout.

- [ ] **Unit 9: Docs for adoption**

**Goal:** Document the adoption rule.

**Requirements:** R9

**Files:** `packages/gateway/AGENTS.md`, `ARCHITECTURE.md`, `docs/wiki/Troubleshooting.md`

## System-Wide Impact

| Surface | PR-A | PR-B | PR-B (adoption) |
| --- | --- | --- | --- |
| Action | None (traces identical) | A timed-out or budget-expired renewal is aborted instead of abandoned | A renewal that committed but returned an error no longer leaves the lock until the TTL |
| Gateway | None | A hung tick times out at 10 s and is logged; late results from a timed-out tick are ignored; in-flight I/O is aborted at the deadline; the RunState read doesn't start after stop | Adoption as above; lock records gain `acquisition_token` |
| `dist/` | Rebuilt | Rebuilt (the Action's `abortOnDeadline`) | Rebuilt |
| Object-store adapter | `conditionalPut` accepts an optional `signal` | — | Exported lock read |

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Extraction subtly changes Action timing | Golden traces before extraction, existing suites unchanged, abort off for the Action in PR-A, revert-checks |
| The test mock of `renewLease` is bypassed | The surface injects its `renew` function |
| Exact-argument assertions break when a signal is added | Pass the signal only when it is defined; list the `:365-371` and `:154-158` adjustments in PR-B |
| An aborted PUT still commits server-side | Abort only narrows the window. Adoption, in the same PR as the timeout, recovers the committed-but-errored state at the next tick and at stop; the release CAS keeps it safe |
| Adoption takes over a successor's record | `ownsRecord` requires the per-acquisition token on both surfaces |
| A 10 s gateway tick timeout trips on slow but healthy S3 | It is the same bound the Action runs with. The failure is logged and the next tick retries. Check gateway renewal latency before PR-B ships |

## Sources & References

- Origin: `docs/brainstorms/2026-10-18-action-gateway-consolidation-requirements.md`
- Lock-path bugfixes: #1892 (`4dbd5573e`)
- Takeover decision: option C (shared mechanism, per-surface policy)
- Related: #1890 (post-hook persistence retry)
