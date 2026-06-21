---
title: 'fix: Move run lifecycle admission into launchWork so queued/failed runs are observable'
type: fix
status: active
date: 2026-06-20
deepened: 2026-06-20
---

# Move run lifecycle admission into launchWork so queued/failed runs are observable

## Overview

The `RunState` lifecycle record that `toOperatorRunStatus` projects is created **only inside** `executeWorkOnHeldSlot`, after the concurrency slot is acquired and after the clone/readyz/thread/lock gates. So a run that **queues** behind the per-repo cap, or **fails** at an early-abort gate, produces no `RunState` — and the operator SSE stream (and the web launch route's `202 {runId}`) point at a run that never becomes observable.

This moves run **admission** (creating the initial `PENDING` `RunState`) into `launchWork` (the public front door) for the two **accepted** dispositions — immediate-run and queued — so the run is observable the moment it is accepted. A hard **capacity-reject** (`'cap'`: no slot AND queue at depth cap) is NOT admitted — it stays a synchronous rejection with a user reply, no `RunState`, no runId to poll. `executeWorkOnHeldSlot` then **adopts** the already-created run (transitioning `PENDING → ACKNOWLEDGED`) instead of calling `createRun`. The early-abort gates terminalize the run to `FAILED`. The immediate run's lifetime is owned by the gateway (a new in-flight-run set that graceful shutdown drains), not by the caller's `await`, so `launchWork` can return admission early without dropping the run. This fixes both web and Discord (closes #966), and the web launch route's idempotency becomes two-phase so a rejected launch does not echo a dead runId.

## Problem Frame

`launchWork(request, deps): Promise<void>` (run.ts:843) decides disposition: FIFO-enqueue (run.ts:867-870), capacity-reject or busy-enqueue (run.ts:874-886), or immediate `await executeWorkOnHeldSlot(task)` (run.ts:888-889). Only the immediate path creates a `RunState` — `createRun` is at run.ts:376-381, after `ensureClone` (254-269), `readyz` (281-294), `threadFactory` (305-331), and lock acquisition (341-355), each of which returns *without* writing any `RunState` on failure.

`createRun` (run-state.ts:85-103) uses `conditionalPut(..., {ifNoneMatch: '*'})` — **not idempotent**; a second create on the same key fails. So the route cannot pre-create the `RunState` and have the engine create it again; the engine must **adopt**. The transition table (run-state.ts:8-15) only allows `PENDING → ACKNOWLEDGED`, `ACKNOWLEDGED → EXECUTING`, `EXECUTING → COMPLETED|FAILED|CANCELLED` — so early `PENDING/ACKNOWLEDGED → FAILED` are currently impossible and must be added.

`toOperatorRunStatus` (run-status.ts:74-81) already maps `PENDING → 'queued'` and `FAILED → 'failed'`, and the SSE observer is notified at each transition (run.ts:413-414, 435-436, 460-461, 640-641, 706-707) — so the read surface is mostly ready; the gap is purely that no `RunState` exists for queued/failed-early runs.

## Requirements Trace

- R1. A run **accepted** by `launchWork` (immediate or queued) has an observable `RunState` from acceptance: queued → `queued`, started → `running`, terminal → `succeeded`/`failed`/`cancelled`. A hard capacity-reject (`'cap'`) is not accepted — it gets a synchronous rejection reply, no `RunState`, no runId to poll.
- R2. `executeWorkOnHeldSlot` adopts the admitted run (no `createRun`); the immediate-run lifecycle is unchanged end-to-end for a successful run.
- R3. The four early-abort gates (clone, readyz, thread, lock) terminalize the admitted run to `FAILED` (observable as `failed`), for **both** web and Discord, and never leave an orphan `PENDING`.
- R4. The runtime transition table allows `PENDING → ACKNOWLEDGED|FAILED|CANCELLED` and `ACKNOWLEDGED → EXECUTING|FAILED|CANCELLED`; each new transition is regression-pinned.
- R5. Graceful shutdown / queue-drop terminalizes any dropped `PENDING` run to `FAILED` (not orphaned holding a slot).
- R6. The recovery sweep terminalizes orphan `PENDING` runs (a crash mid-admission) to `FAILED`, alongside the existing `EXECUTING` handling.
- R7. The web launch route's idempotency is two-phase: the key is committed only after admission succeeds, and rolled back if admission fails — a rejected launch does not echo a dead runId.
- R8. The Discord path stays behaviorally equivalent for successful runs; the only intended Discord change is that a failed-before-execution run now writes a `FAILED` `RunState` (an improvement) — pinned with regression tests.
- R9. No `createRun` double-write: exactly one creator (admission in `launchWork`); the `ifNoneMatch: '*'` conditional-put is preserved and tested.

## Scope Boundaries

- No change to the operator contract DTO shape or `OPERATOR_CONTRACT_VERSION` — `run-status.ts` already maps `PENDING`/`FAILED`; this fix only causes those states to actually be produced. (Verify the overlay guard allows `PENDING`; no version bump unless a field changes.)
- No change to the SSE route, the run-observation manager, or the repo-list route beyond what the new states require (they already consume `RunState`).
- No persistence change to the in-memory idempotency store (restart-loss remains a documented residual; this fixes only the dead-runId-on-failure echo).
- No new approval, no agent-output streaming (that is #965).
- No change to the queue/cap/FIFO algorithm itself — admission threads through it, it is not redesigned.

### Deferred to Separate Tasks

- Streaming web-launched agent output: #965.
- Persisting idempotency across restart: future, if needed.
- A new best-practice doc for the `ifNoneMatch:'*'` ↔ `IfMatch` S3 conditional-write vocabulary: a `ce:compound` follow-up after this lands.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/execute/run.ts` — `launchWork` (843-890), `executeWorkOnHeldSlot` (219-466 incl. `createRun` at 376, early-abort gates 254-355, `runIndex.register` 388-395, observer notifies 413/435/460/640/706), `runMention` Discord adapter (952-1092, no `runId`/`promptBuilder`/`createApprovalOnPending`).
- `packages/runtime/src/coordination/run-state.ts` — `createRun` (85-103, `ifNoneMatch:'*'`), `transitionRun` (106-159), transition table (8-15).
- `packages/gateway/src/web/operator/launch-route.ts` — `runIndex.register` (299-316) + `idempotencyGuard.record` (318-323) BEFORE fire-and-return `launchWork` (325-366).
- `packages/gateway/src/web/operator/idempotency.ts` — `check`/`record` (extend to reserve/commit/rollback).
- `packages/gateway/src/operator-contract/run-status.ts` — phase→status map (74-81), `toOperatorRunStatus` (121-154).
- The recovery sweep (`recoverStaleRuns` / `forceReleaseStaleLock` callers — find current location) that terminalizes stale `EXECUTING` runs.

### Institutional Learnings

- `docs/solutions/best-practices/gateway-control-surface-spine-2026-06-15.md` — **placement rule (load-bearing):** admission lives in the PUBLIC `launchWork`, adoption in the PRIVATE `executeWorkOnHeldSlot`. "No second door." Do NOT move admission into the private primitive or queued/cap-rejected runs stay unadmitted.
- `docs/solutions/best-practices/atomic-serial-channel-queue-handoff-2026-06-09.md` — FIFO/cap/shutdown contract admission must preserve. **Corollary (R5):** dropped-queue `PENDING` records must be terminalized to `FAILED` on shutdown, not orphaned holding a slot.
- `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md` — the recovery sweep terminalizes stale `EXECUTING` to `FAILED`; **must extend to `PENDING` (R6)**. Also the `IfMatch` lock-release precedent is the model for testing the `ifNoneMatch:'*'` create.
- `docs/solutions/best-practices/centralize-s3-key-identity-construction-2026-06-09.md` — **test discipline:** pin the S3 key AND the conditional-write header (`IfNoneMatch: '*'`), not just that `createRun` was called.
- `docs/solutions/code-quality/architectural-issues-type-safety-and-resource-cleanup.md` — **dual-finally:** every early-abort gate path that can throw after admission but before a terminal transition must terminalize to `FAILED` in a `finally`-guarded structure so a throw can't orphan a `PENDING`.
- `docs/solutions/best-practices/web-operator-launch-surface-2026-06-20.md` — the route/idempotency surface this extends (don't redesign rules 1/4/6, extend them). **This doc becomes stale when #966 lands** (see Documentation Notes).
- `docs/solutions/best-practices/authenticated-sse-run-observation-2026-06-20.md` — the read surface; verify the status overlay guard allows `PENDING` (non-terminal, should display).

## Key Technical Decisions

- **Admission in `launchWork`, adoption in `executeWorkOnHeldSlot` (no second door).** For the two **accepted** dispositions (immediate, queued), `launchWork` runs an **admission block**: `createRun(PENDING)` → `runIndex.register` → `notifyObserver(PENDING)`, then enqueues or runs. `executeWorkOnHeldSlot` receives the runId + the **adoption etag** on the `RunTask` and starts at `transitionRun(PENDING → ACKNOWLEDGED)` — it no longer calls `createRun`. Capacity-reject does NOT enter the admission block.
- **Admission block is fail-closed (fixes partial-admission orphan).** If anything AFTER `createRun` succeeds but throws (`runIndex.register`, `notifyObserver`), the block must terminalize the just-created run to `FAILED` before propagating — never leave a live PENDING with no index entry. Wrap the post-create steps so a throw routes to `failAdmittedRun` (best-effort) then rethrows/rejects admission.
- **createRun stays the single creator + stays `ifNoneMatch:'*'`.** Exactly one create per run, in the `launchWork` admission block. The conditional-put is preserved (a duplicate runId create fails loudly rather than clobbering). This is the safety property that makes "one creator" enforceable; the create test asserts the `IfNoneMatch: '*'` header, not just that `createRun` was called.
- **Capacity-reject (`'cap'`) is non-admitted.** A hard cap-reject (no slot AND queue at depth cap) sends the existing user reply (Discord) / coarse non-202 (web) and returns `{accepted:false, reason:'cap'}`. No `createRun`, no runId, no orphan. Only `enqueue`/`busy` (queued) and the immediate path admit. This is the single source of truth for `'cap'` — Overview, R1, Risks, and Unit 2 tests all reflect it.
- **Transition table gains early-FAILED.** `PENDING: ['ACKNOWLEDGED','FAILED','CANCELLED']`, `ACKNOWLEDGED: ['EXECUTING','FAILED','CANCELLED']`. `EXECUTING` and terminals unchanged. Each new edge regression-pinned; still-illegal edges (e.g. `PENDING → EXECUTING`) asserted to remain rejected.
- **Etag threading (fixes stale-etag 412).** `transitionRun` returns the new etag on every transition. The `RunTask` (currently `{request, deps}`) gains the **adoption etag** (the create-etag) so `executeWorkOnHeldSlot` can do `PENDING → ACKNOWLEDGED`. After that transition the etag is refreshed; `failAdmittedRun` and every later terminalize MUST use the **current** etag returned by the last successful transition, never the create-etag. `failAdmittedRun(runId, currentEtag, reason)` is a gateway helper that transitions the run to `FAILED` with the latest etag and notifies the observer.
- **Early-abort gates terminalize to FAILED via the guarded helper + dual-finally.** Each gate's bare `return` (now after adoption) becomes `await failAdmittedRun(runId, currentEtag, reason)` then reply + return. Use the dual-finally discipline (per the resource-cleanup learning) so a throw inside a gate still terminalizes the run — the FAILED transition is reached on both the explicit-failure and thrown-error paths. User-facing reply messages unchanged.
- **Immediate-run ownership: gateway in-flight set (fixes dropped run).** `launchWork` returns admission early, so the immediate run can NOT be owned by the caller's `await`. A new gateway-owned in-flight-run set holds the immediate-path promise (`void executeWorkOnHeldSlot(task)` is registered in the set; removed on settle). Graceful shutdown drains this set (awaits in-flight runs) alongside the existing queue/approval drain. There is no existing in-flight-promise set today (the immediate path is `await`ed inside `launchWork`) — this is a new, small mechanism modeled on the existing shutdown-drain pattern.
- **`launchWork` return shape.** `launchWork` changes from `Promise<void>` to `Promise<LaunchAdmission>` where `LaunchAdmission = {accepted: true, runId} | {accepted: false, reason}`. It awaits ONLY admission (a fast, bounded result), never the run. `runMention` (Discord) awaits the admission result and uses it for its reply; it no longer awaits the full run (the gateway in-flight set owns it). Characterization tests pin Discord successful-run completion + reply timing across this change.
- **Two-phase idempotency (R7).** `idempotency.ts` gains an explicit reserved→committed lifecycle: `reserve(key, runId)` (records a *reserved* entry; a concurrent duplicate during the window is treated as in-flight/duplicate, not a fresh launch), `commit(key)` (promotes to a committed entry with TTL), `rollback(key)` (removes the reservation). The route reserves before `await launchWork`, then in a `finally`-guarded structure: commit on `{accepted:true}`, rollback on `{accepted:false}` OR any throw OR any post-admission/pre-commit route failure — so a reserved-but-never-resolved key cannot stick and DoS the operator's own key. Reserved entries also carry a TTL so an abandoned reservation self-clears.
- **Shutdown + recovery terminalize PENDING (R5/R6).** Three orphan-PENDING sources are covered: (a) the queue-drop-on-shutdown path terminalizes each dropped queued task's PENDING → FAILED; (b) the stale-run recovery sweep is extended to PENDING (see below); (c) the fail-closed admission block + dual-finally gates cover the throw paths. `recovery.ts` currently documents "EXECUTING is the ONLY stranded phase" and `findStaleRuns` filters `phase !== 'EXECUTING'` out — so PENDING recovery is **new query logic** (extend `findStaleRuns`/the sweep), with a **freshness/grace window** so a just-admitted PENDING that is microseconds from `ACKNOWLEDGED` is NOT raced to FAILED (use a heartbeat-miss / minimum-age threshold; fresh PENDING is ineligible).

## Open Questions

### Resolved During Planning

- Where does admission live? → `launchWork` (public front door), per the spine doc. Adoption in `executeWorkOnHeldSlot`.
- Does the operator contract need a version bump? → No; `run-status.ts` already maps `PENDING`/`FAILED`. Verify only.
- Is createRun still conditional? → Yes, `ifNoneMatch:'*'` preserved; one creator.
- Capacity-reject (`'cap'`)? → **Non-admitted** synchronous rejection (no `RunState`, no runId). Only queued + immediate admit.
- Immediate-run ownership after `launchWork` returns early? → A new **gateway in-flight-run set** owns the immediate-path promise; graceful shutdown drains it. The run is not owned by the caller's `await`.
- Etag for post-adoption terminalization? → `transitionRun` returns the new etag; `failAdmittedRun` uses the **current** (post-ACK) etag, never the create-etag. `RunTask` carries the adoption etag.
- Partial-admission orphan (register/observer throw after createRun)? → The admission block is **fail-closed**: terminalize to FAILED before propagating.

### Deferred to Implementation

- **`recoverStaleRuns` / `findStaleRuns` PENDING extension shape:** `recovery.ts` and `findStaleRuns` filter to `EXECUTING` only. The exact query/selection change to also surface stale `PENDING`, and the precise freshness threshold (heartbeat-miss vs minimum-age) that excludes just-admitted PENDING, settle against the existing stale-run logic during Unit 5.
- **Reserved-entry TTL value** for the two-phase idempotency reservation — pick against the existing committed-entry TTL during Unit 4.
- **`failAdmittedRun` placement** (gateway helper module vs inline in run.ts) — implementer's call; behavior is specified.

## High-Level Technical Design

> *Directional guidance for review, not implementation specification.*

```
launchWork(request, deps): Promise<LaunchAdmission>
  guard empty prompt → return {accepted:false, reason:'empty-prompt'}   // before admission
  decide disposition FIRST (without admitting):
    cap (no slot AND queue full) → reply capacity; return {accepted:false,'cap'}   // NO admission
  runId = request.runId ?? uuid
  ADMISSION BLOCK (fail-closed):
    {etag} = createRun(PENDING)        ← one creator, ifNoneMatch:'*'
    try: runIndex.register(runId); notifyObserver(PENDING)   → SSE shows 'queued'
    catch: failAdmittedRun(runId, etag, 'admission'); rethrow  ← no orphan PENDING
  disposition:
    queued (FIFO pending / busy) → enqueue(task{runId, adoptionEtag:etag}); return {accepted:true, runId}
    immediate                    → inFlight.add(executeWorkOnHeldSlot(task{runId, adoptionEtag:etag}))
                                    return {accepted:true, runId}   ← gateway owns the promise

executeWorkOnHeldSlot(task)  // slot already held; ADOPTS the admitted run
  {etag} = transitionRun(PENDING → ACKNOWLEDGED, task.adoptionEtag)   // was createRun; etag REFRESHED
  ensureClone / readyz / threadFactory / lock:        // dual-finally so a throw still terminalizes
     on failure/throw → failAdmittedRun(runId, CURRENT etag, reason); reply; return → FAILED
  {etag} = transitionRun(ACKNOWLEDGED → EXECUTING, etag) → run → COMPLETED/FAILED

gateway shutdown drain: await inFlight set  +  for each dropped queued task → failAdmittedRun(PENDING→FAILED)
recovery sweep: stale PENDING (past freshness window) + stale EXECUTING → FAILED  // findStaleRuns extended
recovery sweep:       stale PENDING (+ existing EXECUTING) → FAILED
```

## Implementation Units

- [x] **Unit 1: Runtime transition table — add early-FAILED edges**

  **Goal:** Allow `PENDING/ACKNOWLEDGED → FAILED` (and `→ CANCELLED`) so admitted runs can terminalize before execution.

  **Requirements:** R4

  **Dependencies:** none (foundation).

  **Files:**
  - Modify: `packages/runtime/src/coordination/run-state.ts` (transition table 8-15)
  - Test: `packages/runtime/src/coordination/run-state.test.ts`

  **Approach:** `PENDING: ['ACKNOWLEDGED','FAILED','CANCELLED']`, `ACKNOWLEDGED: ['EXECUTING','FAILED','CANCELLED']`. Leave `EXECUTING`/terminals unchanged. No change to `createRun`/`transitionRun` signatures.

  **Execution note:** Test-first — pin each new (from,to) edge and that previously-illegal edges (e.g. `PENDING → EXECUTING`) remain rejected.

  **Test scenarios:**
  - Happy path: `transitionRun(PENDING → FAILED)` succeeds; `(ACKNOWLEDGED → FAILED)` succeeds; `(PENDING → CANCELLED)` succeeds.
  - Edge: `PENDING → EXECUTING` still rejected (skipping ACKNOWLEDGED); terminal → anything still rejected.
  - Regression: existing `PENDING → ACKNOWLEDGED → EXECUTING → COMPLETED` path unchanged.

  **Verification:** The transition map allows the new edges and rejects the still-illegal ones; existing run-state tests pass.

- [x] **Unit 2: `launchWork` owns admission + returns an admission result**

  **Goal:** `launchWork` decides disposition first, runs a fail-closed admission block for the two accepted dispositions (immediate, queued), returns a `LaunchAdmission` without awaiting the run, and hands immediate-run ownership to a gateway in-flight set.

  **Requirements:** R1, R2, R8, R9

  **Dependencies:** Unit 1.

  **Files:**
  - Modify: `packages/gateway/src/execute/run.ts` (`launchWork` 843-890: decide disposition; for accepted dispositions run the admission block — `createRun`/`runIndex.register`/`notifyObserver(PENDING)` moved here from `executeWorkOnHeldSlot`; change return type to `Promise<LaunchAdmission>`; thread `{runId, adoptionEtag}` onto the `RunTask`; register the immediate-path promise in a new gateway in-flight set; `runMention` awaits admission only)
  - Modify: `packages/gateway/src/execute/launch-types.ts` (add `LaunchAdmission` type; add `runId`/`adoptionEtag` to `RunTask`)
  - Test: `packages/gateway/src/execute/run.test.ts`

  **Approach:** Decide disposition BEFORE admitting. **Capacity-reject (`'cap'`):** reply capacity / coarse non-202, return `{accepted:false,'cap'}`, NO `createRun`. **Empty-prompt:** return `{accepted:false,'empty-prompt'}` before admission. For **queued** and **immediate**, run the **fail-closed admission block**: `{etag}=createRun(PENDING)`, then `try { runIndex.register; notifyObserver(PENDING) } catch { failAdmittedRun(runId, etag, 'admission'); rethrow }`. Then: queued → `enqueue(task{runId, adoptionEtag:etag})`; immediate → register `executeWorkOnHeldSlot(task)` in the **gateway in-flight set** (drained on shutdown) and return — do NOT await the run. Preserve the FIFO/cap/queue algorithm exactly. `runMention` awaits the admission result (for its reply), never the run.

  **Execution note:** Characterization-first — capture current `launchWork`/`executeWorkOnHeldSlot` behavior (esp. Discord successful-run completion + reply timing) before moving admission, so R8 equivalence is provable.

  **Patterns to follow:** spine doc "no second door"; existing observer-notify pattern (run.ts:413); the existing shutdown-drain pattern (model the in-flight set on it).

  **Test scenarios:**
  - Happy path (immediate): a launch with a free slot creates exactly one `PENDING`, registers the index, notifies the observer with `PENDING`, returns `{accepted:true, runId}` BEFORE the run completes (hanging `executeWorkOnHeldSlot` mock), then the run proceeds to completion.
  - **R8/ownership:** an immediate run still **completes and posts output** after `launchWork` returns admission early (the in-flight set keeps it alive); shutdown drains an in-flight immediate run.
  - Happy path (queued): a launch into a busy channel creates `PENDING`, returns `{accepted:true, runId}`, enqueues `task{runId, adoptionEtag}`; SSE projects `queued`.
  - Edge (cap): capacity-reject returns `{accepted:false,'cap'}` and does NOT create a `RunState`.
  - Edge (empty): empty prompt returns `{accepted:false,'empty-prompt'}`, no admission.
  - **Fail-closed:** `runIndex.register` (or `notifyObserver`) throws after `createRun` → the run is terminalized to `FAILED` (no orphan PENDING), admission rejects.
  - R9: a duplicate runId (createRun `ifNoneMatch:'*'` conflict) fails admission rather than clobbering — assert the `IfNoneMatch:'*'` header is set.
  - Integration: the observer receives `PENDING` before `ACKNOWLEDGED` for an immediate run.

  **Verification:** `launchWork` returns admission synchronously-fast for all dispositions; exactly one `createRun`; observer sees `PENDING` first.

- [x] **Unit 3: `executeWorkOnHeldSlot` adopts the run; early-abort gates terminalize to FAILED**

  **Goal:** The private primitive no longer creates the run; it adopts it (`PENDING → ACKNOWLEDGED`) and terminalizes to `FAILED` at every early-abort gate without orphaning a `PENDING`.

  **Requirements:** R2, R3, R8

  **Dependencies:** Unit 2 (admission moved; task carries runId+etag).

  **Files:**
  - Modify: `packages/gateway/src/execute/run.ts` (`executeWorkOnHeldSlot`: remove `createRun` at 376; start at `transitionRun(PENDING→ACKNOWLEDGED)`; wrap clone/readyz/thread/lock so each failure calls a `failAdmittedRun` helper then replies+returns; add the helper)
  - Test: `packages/gateway/src/execute/run.test.ts`

  **Approach:** `executeWorkOnHeldSlot` receives `{runId, adoptionEtag}` on the task. First action: `{etag}=transitionRun(PENDING → ACKNOWLEDGED, adoptionEtag)` — **capture the returned etag into a mutable `currentEtag`**. Each early-abort gate, on failure, calls `failAdmittedRun(runId, currentEtag, reason)` using the LATEST etag (after ACK the create/adoption etag is stale and would 412), which transitions → FAILED and notifies the observer `failed`, BEFORE the existing user reply + return. Use dual-finally so a throw in a gate still terminalizes (the FAILED transition is reached on both the explicit-failure and thrown-error paths). Each subsequent successful transition refreshes `currentEtag`. User-facing reply messages unchanged.

  **Execution note:** Test-first for each gate-failure → FAILED path; dual-finally per the resource-cleanup doc.

  **Patterns to follow:** `architectural-issues-type-safety-and-resource-cleanup.md` dual-finally; existing reply/return shape at gates 254-355.

  **Test scenarios:**
  - Happy path: a successful immediate run goes `PENDING → ACKNOWLEDGED → EXECUTING → COMPLETED` (adoption, no second createRun) — observer sees the full sequence; result identical to today.
  - Error path (×4): clone-fail, readyz-fail, thread-fail, lock-not-acquired each transition the run to `FAILED` (observer sees `failed`), send the same user reply as today, and leave no `PENDING` orphan.
  - Error path (throw): a gate that THROWS still terminalizes to `FAILED` (dual-finally), no orphan.
  - Edge: lock `acquired:false` (another task in progress) → `FAILED` with the existing "another task in progress" reply.
  - R8 Discord: a Discord (`runMention`) launch whose early gate fails now writes `FAILED` (previously just replied) — assert the new RunState + the unchanged reply text.
  - Regression: the successful Discord run path is byte-identical (no createRun double-call, same replies, same artifacts).

  **Verification:** No `createRun` in `executeWorkOnHeldSlot`; every early-abort path (including throw) yields a terminal `FAILED` and the same user reply; successful run unchanged.

- [x] **Unit 4: Two-phase idempotency in the web launch route**

  **Goal:** The launch route reserves the idempotency key, awaits `launchWork` admission, and commits only on accept / rolls back on reject — so a rejected launch never echoes a dead runId.

  **Requirements:** R7

  **Dependencies:** Unit 2 (`launchWork` returns `LaunchAdmission`).

  **Files:**
  - Modify: `packages/gateway/src/web/operator/idempotency.ts` — extend the entry lifecycle to **reserved → committed**: `reserve(key, runId)` records a *reserved* entry (a concurrent duplicate during the reservation window is treated as in-flight/duplicate, echoing the reserved runId, NOT a fresh launch); `commit(key)` promotes to a *committed* entry with the existing TTL; `rollback(key)` removes the reservation. Reserved entries carry their own TTL so an abandoned reservation self-clears.
  - Modify: `packages/gateway/src/web/operator/launch-route.ts` (reserve before `launchWork`; `await` admission; in a `finally`-guarded structure commit on `{accepted:true}` and rollback on `{accepted:false}` / throw / any post-admission-pre-commit route failure; remove the route's own `runIndex.register`/`record`-before-fire — `launchWork` owns the index now; return 202 with the admitted runId or a coarse error on non-accept)
  - Test: `packages/gateway/src/web/operator/{idempotency,launch-route}.test.ts`

  **Approach:** The route keeps its route-owned runId (passes it as `request.runId` so `launchWork` uses it and the 202 returns it; confirm `launchWork` honors `request.runId`). Flow: check idempotency (committed OR reserved duplicate → echo) → `reserve(key, runId)` → `const admission = await launchWork(request, deps)` → **in a try/finally**: on `{accepted:true}` `commit` + `202 {runId}`; on `{accepted:false}` or throw `rollback` + coarse error; the `finally` guarantees rollback if the route throws AFTER admission but BEFORE commit (no stuck reservation DoSing the operator's own key). Awaiting admission is bounded (admission does not await the run).

  **Execution note:** Test-first for the reserve/commit/rollback isolation + the no-dead-runId property.

  **Patterns to follow:** existing per-operator namespace (`${githubUserId}:${key}`); the launch-surface doc rules 1/6 (extend, don't redesign).

  **Test scenarios:**
  - Happy path: accepted admission → idempotency committed, `202 {runId}` returned.
  - R7 reject: a launch that fails admission (e.g. capacity-reject) → idempotency rolled back (a subsequent same-key request is NOT treated as a duplicate / does not echo the dead runId) and a coarse non-202 returned.
  - Isolation: operator A key 'x' and operator B key 'x' → two distinct runs (namespace preserved).
  - Duplicate: same operator+key twice (both accepted) → one launch, second echoes the runId.
  - Edge: `launchWork` throws → rollback + coarse error.
  - Edge (stuck-reservation): the route throws AFTER admission but BEFORE commit → the `finally` rolls back the reservation (a subsequent same-key request is NOT blocked by a dangling reservation).
  - Edge (reservation duplicate window): a second same-key request arriving while the first is reserved-not-committed echoes the reserved runId, does not launch twice.
  - Integration: the route no longer double-registers the run index (run.ts owns it) — assert `runIndex.register` is called once (in launchWork), not twice.

  **Verification:** A rejected launch leaves no idempotency entry and no dead runId; the run index is registered once.

- [x] **Unit 5: Shutdown queue-drop + recovery sweep terminalize orphan PENDING**

  **Goal:** Dropped queued runs (shutdown), in-flight immediate runs (shutdown), and orphan `PENDING` records (crash / admit-before-enqueue) are terminalized to `FAILED` or drained — no slot held by an orphan, operator sees `failed` not a stuck `queued`.

  **Requirements:** R5, R6

  **Dependencies:** Units 1-3.

  **Files:**
  - Modify: the shutdown/drain path in `packages/gateway/src/execute/run.ts` — drain the new in-flight-run set (Unit 2) AND terminalize each dropped queued task's `PENDING` → `FAILED`
  - Modify: `packages/gateway/src/execute/recovery.ts` (`recoverStaleRuns`/`recoverOneRun`) AND the runtime `findStaleRuns` (`packages/runtime/src/coordination/*`) — **`findStaleRuns` currently filters `phase !== 'EXECUTING'` out, and `recovery.ts` documents "EXECUTING is the ONLY stranded phase"** — extend the query to also surface stale `PENDING`, with a freshness window, and update the stale comment
  - Test: the recovery-sweep test + a shutdown-drain test + a `findStaleRuns` PENDING test

  **Approach:** On shutdown: drain the in-flight immediate-run set (await), and for each dropped queued `task`, `transitionRun(PENDING → FAILED, task.adoptionEtag)` + notify observer. **Recovery (new query logic, not a tweak):** extend `findStaleRuns` to return stale `PENDING` (past a heartbeat-miss / minimum-age **freshness window**) in addition to `EXECUTING`; a just-admitted PENDING within the window is **ineligible** (must not be raced to FAILED while it's about to transition to ACKNOWLEDGED). `recoverOneRun` terminalizes a stale PENDING → FAILED. Update the `recovery.ts` "EXECUTING is the only stranded phase" comment.

  **Execution note:** Test-first for the orphan-PENDING terminalization AND the fresh-PENDING-not-recovered guard (the run-killing race the review flagged).

  **Patterns to follow:** `gateway-opencode-mention-loop` rule 3 recovery sweep; `atomic-serial-channel-queue-handoff` shutdown contract.

  **Test scenarios:**
  - Happy path (shutdown queued): a queued `PENDING` run, on shutdown drain, → `FAILED` (observer sees `failed`), slot released.
  - Happy path (shutdown immediate): an in-flight immediate run is awaited by the drain (not dropped).
  - Happy path (recovery): a stale orphan `PENDING` (past the freshness window) → `FAILED` by the sweep.
  - **Edge (run-killing race):** a FRESH `PENDING` (within the freshness window, about to be adopted) is NOT terminalized by the recovery sweep.
  - Edge (`findStaleRuns`): the extended query returns stale PENDING + stale EXECUTING, excludes fresh PENDING.
  - Regression: the existing stale-`EXECUTING` recovery still works.

  **Verification:** No orphan `PENDING` survives shutdown or recovery; a fresh just-admitted PENDING is never killed; slots are not held by orphans.

- [x] **Unit 6: Verify the operator read surface projects PENDING/FAILED + docs refresh**

  **Goal:** Confirm `toOperatorRunStatus` surfaces the now-produced `PENDING`/`FAILED` states cleanly (overlay guard allows `PENDING`), and (ancillary, not requirement-bearing) refresh the docs the fix makes stale.

  **Requirements:** R1 (read-side closure). The docs-refresh portion is ancillary cleanup, not requirement-bearing.

  **Dependencies:** Units 1-5.

  **Files:**
  - Verify (likely no change): `packages/gateway/src/operator-contract/run-status.ts` (map already has `PENDING→'queued'`, `FAILED→'failed'`; confirm the `waiting_for_approval` overlay guard only overrides non-terminal and does not mask `PENDING`/`FAILED` incorrectly)
  - Test: `packages/gateway/src/operator-contract/run-status.test.ts` (add explicit PENDING→queued / FAILED→failed projection assertions if missing)
  - Modify (docs): `docs/solutions/best-practices/web-operator-launch-surface-2026-06-20.md` (drop the "not yet observable" caveat at the queued line, rewrite the failed-key-persists residual, remove #966 from deferred follow-ups), `atomic-serial-channel-queue-handoff-2026-06-09.md` (shutdown rule corollary), `gateway-opencode-mention-loop-best-practices-2026-05-30.md` (recovery sweep now includes PENDING)

  **Approach:** Mostly verification + a projection test + targeted doc edits. If the overlay guard or projection needs a tweak to display `PENDING`/`FAILED` correctly, make the minimal change (no contract version bump unless a field changes).

  **Test scenarios:**
  - Happy path: `toOperatorRunStatus` of a `PENDING` RunState → `status: 'queued'`; of a `FAILED` RunState → `status: 'failed'`.
  - Edge: the `waiting_for_approval` overlay does not override a `PENDING` or terminal state incorrectly.

  **Verification:** A queued run shows `queued` and a failed-early run shows `failed` end-to-end (RunState → projection → operator status); the stale doc caveats are removed.

## System-Wide Impact

- **Interaction graph:** `launchWork` (now admission owner) is called by both `runMention` (Discord) and the web launch route; `executeWorkOnHeldSlot` is called only by `launchWork`. The SSE observer and repo-list projection consume the new states automatically.
- **Error propagation:** early-abort gate failures become observable `FAILED` states (new) in addition to the existing user replies. A throw in a gate must still terminalize (dual-finally).
- **State lifecycle risks:** the central risk is a **double `createRun`** (admission + adoption) — the `ifNoneMatch:'*'` conditional-put makes this fail loudly, and Unit 3 explicitly removes the engine's `createRun`. The second risk is an **orphan `PENDING`** (throw-after-admission, shutdown, crash) — Units 3/5 terminalize all three.
- **API surface parity:** Discord and web both go through `launchWork`; both get the new lifecycle. No operator contract version change.
- **Unchanged invariants:** the queue/cap/FIFO algorithm, the `ifNoneMatch:'*'` create semantics, the operator DTO shape, the successful-run lifecycle (`PENDING→ACKNOWLEDGED→EXECUTING→COMPLETED`), and the user-facing reply texts are all unchanged. The only intended behavior change is that previously-silent queued/failed-early runs now produce an observable `RunState`.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| **Immediate run DROPPED** when `launchWork` returns admission early (caller no longer awaits it) | Gateway in-flight-run set owns the immediate promise (Unit 2); shutdown drains it; test: immediate run completes + posts output after admission returns. |
| **Fresh just-admitted PENDING killed** by an over-eager recovery sweep racing the PENDING→ACKNOWLEDGED transition | Freshness/grace window in `findStaleRuns` makes a just-admitted PENDING ineligible (Unit 5); explicit "fresh PENDING not recovered" test. |
| **Stale etag 412** — create/adoption etag is stale after the ACK transition | `transitionRun` returns the new etag; `currentEtag` refreshed per transition; `failAdmittedRun` uses the latest, never the create-etag (Unit 3). |
| **Partial-admission orphan** — register/observer throws after `createRun` | Fail-closed admission block terminalizes the run to FAILED before propagating (Unit 2); explicit test. |
| **Stuck idempotency reservation** DoSes the operator's own key | `finally`-guaranteed rollback for every non-commit exit incl. post-admission/pre-commit throw; reserved-entry TTL (Unit 4); explicit test. |
| Double `createRun` (admission + leftover adoption) clobbers/fails | `ifNoneMatch:'*'` makes the second create fail loudly; Unit 3 removes the engine create; test asserts exactly one create + the `IfNoneMatch:'*'` header. |
| `launchWork` returning admission-not-execution changes Discord reply timing | Characterization-first (Unit 2); pin Discord successful-run + failed-early behavior; `runMention` awaits admission only, reply timing unchanged. |
| Orphan `PENDING` holds a slot (throw after admission / shutdown / crash / admit-before-enqueue) | Fail-closed admission (Unit 2) + dual-finally gates (Unit 3) + shutdown drain + recovery sweep with freshness window (Unit 5); tests for each. |
| Transition-table change breaks an existing path | Unit 1 pins new edges AND that still-illegal edges remain rejected; full runtime suite. |
| Capacity-reject admission ambiguity | Resolved: `'cap'` is a synchronous non-admitted rejection (no createRun); single source of truth across all sections; pinned by test. |
| Operator overlay guard masks PENDING/FAILED | Unit 6 verifies the overlay only overrides non-terminal and surfaces the real states. |

## Documentation / Operational Notes

- Refresh (Unit 6) the launch-surface doc (#966 closed — drop the queued-not-observable caveat, the failed-key-persists residual, and #966 from deferred), the queue-handoff doc (shutdown terminalizes dropped PENDING), and the mention-loop doc (recovery sweep includes PENDING).
- After merge, a `ce:compound` may capture the `ifNoneMatch:'*'` ↔ `IfMatch` S3 conditional-write vocabulary (new pattern, only the IfMatch side is currently documented) and the two-phase idempotency (admission-gated) pattern.
- No deploy/config change; no contract version bump.

## Sources & References

- Issue: #966 (this fix); related #965 (web output streaming, deferred), #907 (parent), #968 (the launch surface that surfaced the gap).
- Grounding: `packages/gateway/src/execute/run.ts` (launchWork 843, executeWorkOnHeldSlot 219-466, createRun 376, gates 254-355, observer 413/435/460/640/706, runMention 952-1092), `packages/runtime/src/coordination/run-state.ts` (createRun 85-103, transition table 8-15, transitionRun 106-159), `packages/gateway/src/operator-contract/run-status.ts` (74-81), `packages/gateway/src/web/operator/launch-route.ts` (299-366).
- Learnings: gateway-control-surface-spine (no second door), atomic-serial-channel-queue-handoff (shutdown corollary), gateway-opencode-mention-loop (recovery sweep), centralize-s3-key-identity-construction (conditional-write test discipline), architectural-issues-type-safety-and-resource-cleanup (dual-finally), web-operator-launch-surface + authenticated-sse-run-observation (the surfaces this closes/feeds).
