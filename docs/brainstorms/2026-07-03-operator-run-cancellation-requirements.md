---
date: 2026-07-03
topic: operator-run-cancellation
---

# Operator Run Cancellation

## Summary

Add operator-initiated run cancellation to the gateway web surface: a cancel action that stops a run whether it is still queued or actively executing, commits the existing `CANCELLED` terminal state, settles any pending tool approval, and posts a cancellation notice to the run's origin Discord thread.

---

## Problem Frame

The operator web surface can launch a run, list runs, stream output, and decide tool approvals — but cannot stop a run. Once launched, a run holds its per-repo lock and consumes a global concurrency slot until it completes, fails, or times out (hard ceiling 30 minutes). An operator watching a run go wrong — wrong prompt, wrong repo, runaway output, or a tool-approval request that should never be granted — has no remedy except waiting out the timeout or denying approvals one at a time as they arrive.

The `CANCELLED` terminal state already exists in the run-state machine and is reachable from every non-terminal phase, and the operator contract already models a `cancelled` run status — but nothing operator-facing can trigger the transition. The capability was deferred when the operator surface shipped (plan `2026-06-15-002`), leaving the surface launch-capable but stop-incapable.

---

## Actors

- A1. Operator: an allowlisted human authenticated on the web operator surface who launches, observes, and now cancels runs.
- A2. Thread watcher: anyone following the run's origin Discord thread (including the mention author for Discord-initiated runs).
- A3. Gateway run machinery: the queue, concurrency registry, run-state store, SSE stream manager, and approval coordinator that a cancellation must leave consistent.

---

## Key Flows

- F1. Cancel a queued run
  - **Trigger:** A1 cancels a run still waiting in the per-channel FIFO queue (PENDING/ACKNOWLEDGED).
  - **Actors:** A1, A3.
  - **Steps:** Operator issues cancel → gateway removes the run from the queue before it starts → run-state transitions to CANCELLED → origin thread gets the cancellation notice → operator surface reflects `cancelled`.
  - **Outcome:** The run never executes; no lock or concurrency slot is consumed; state and streams are terminal.
  - **Covered by:** R1, R2, R3, R6, R7.

- F2. Cancel an executing run
  - **Trigger:** A1 cancels a run in EXECUTING.
  - **Actors:** A1, A2, A3.
  - **Steps:** Operator issues cancel → gateway aborts the in-flight execution → partial output already streamed stays visible → run-state transitions to CANCELLED → per-repo lock released and concurrency slot freed → origin thread gets the cancellation notice → SSE subscribers receive the terminal `cancelled` status.
  - **Outcome:** Execution stops promptly; all coordination resources are released; every surface (web, Discord, run state) agrees the run was cancelled.
  - **Covered by:** R1, R2, R4, R6, R7, R8.

- F3. Cancel a run waiting on a tool approval
  - **Trigger:** A1 cancels a run that is paused on a pending tool-approval request.
  - **Actors:** A1, A2, A3.
  - **Steps:** Operator issues cancel → the pending approval is settled as rejected (no dangling approval) → execution aborts → run-state transitions to CANCELLED → thread notice posted → approval UI on all transports reflects the settled state.
  - **Outcome:** No orphaned approval remains on any transport; the run is terminal.
  - **Covered by:** R1, R2, R4, R5, R6, R7.

---

## Requirements

**Cancel action**

- R1. An allowlisted operator can cancel a specific run from the web operator surface; the action passes the same authentication, allowlist, CSRF, browser-guard, repository-authorization, and rate-limit enforcement as existing mutating operator routes (an operator may cancel only runs in repos they are authorized to operate on).
- R2. Cancelling a run in any non-terminal phase (queued or executing) transitions it to the existing `CANCELLED` terminal state; cancelling an already-terminal run is a no-op that reports the run's terminal state rather than an error.

**Queued runs**

- R3. Cancelling a queued run removes it from the queue before execution starts; it must not acquire the per-repo lock or a concurrency slot afterward. The queue→execution handoff window is covered: a cancel arriving after dequeue but before execution begins must still stop the run before any execution work starts, with the normal cancellation side effects.

**Executing runs**

- R4. Cancelling an executing run aborts the in-flight execution promptly and releases every coordination resource the run holds (per-repo lock, concurrency slot, stream subscriptions). Output already streamed remains visible; cancellation must not be reported as a generic failure.

**Approvals**

- R5. When a cancelled run has a pending tool-approval request, cancellation settles that approval as rejected before the run reaches terminal state; no approval may remain undecided for a terminal run on any transport (web or Discord). The rejection flows through the existing single fail-closed approval settlement gate — cancellation must not introduce a parallel settlement path.

**Observability**

- R6. The run's origin Discord thread receives a cancellation notice stating the run was cancelled by an operator, consistent with how the thread narrates other lifecycle transitions.
- R7. The operator surface (run listing and run stream) reports the run as `cancelled` — the distinct existing terminal status, not `failed` — and SSE subscribers receive the terminal status frame.

**Auditability**

- R8. Cancellation is attributable: the gateway records which operator cancelled the run, consistent with how launch and approval decisions are attributed today.

**Crash consistency**

- R9. Cancellation is durable across gateway restarts: a crash between the `CANCELLED` transition and resource cleanup must not strand the per-repo lock — either cleanup is part of the same atomic path, or startup recovery reconciles terminal-`CANCELLED` runs still holding a live lock.

---

## Acceptance Examples

- AE1. **Covers R2.** Given a run already in `COMPLETED`, when an operator cancels it, the response reports the run's terminal state, no state transition occurs, and no thread notice is posted.
- AE2. **Covers R3.** Given a run queued behind an active run on the same channel, when an operator cancels the queued run, the active run is unaffected and the cancelled run never starts executing.
- AE3. **Covers R4, R7.** Given a run mid-execution with output streaming, when an operator cancels it, streaming stops, previously streamed output remains visible in the web stream, and the terminal status is `cancelled`, not `failed`.
- AE4. **Covers R5.** Given a run paused on a pending tool approval, when an operator cancels the run, the approval settles as rejected on both web and Discord surfaces and no approval prompt remains actionable.
- AE5. **Covers R1.** Given a request without a valid operator session (or failing CSRF/origin checks), when it attempts a cancel, the request is denied by the same guard behavior as other mutating operator routes and no run state changes.
- AE6. **Covers R2, R4.** Given a run that reaches natural completion concurrently with a cancel request, the run settles in exactly one terminal state; whichever transition commits first wins and the loser is a no-op.
- AE7. **Covers R3.** Given a run cancelled in the instant between queue dequeue and execution start, the run never begins execution, settles as `CANCELLED`, and the operator response does not report a misleading no-op.

---

## Success Criteria

- An operator can stop a wrong or runaway run from the web surface in seconds, instead of waiting out the timeout ceiling.
- After any cancellation, no resource leaks: lock released, concurrency slot freed, queue entry removed, streams terminal, approvals settled.
- Every surface agrees on the outcome: web status `cancelled`, Discord thread carries the notice, run state is `CANCELLED`.
- Planning can proceed without inventing product behavior: cancel semantics per phase, approval settlement, and notification behavior are all pinned here.

---

## Scope Boundaries

- Dashboard UI (the Cancel button) is dashboard-repo work; this feature ships the gateway capability the dashboard will consume.
- Discord-side cancel initiation (command, button, or mention) is out of scope; cancellation is initiated from the web operator surface only.
- Bulk cancellation (all runs for a repo/channel) is out of scope; the unit is a single run.
- No new terminal state: `CANCELLED` already exists; this work makes it operator-reachable, not redefines it.
- Run pause/resume is out of scope; cancel is terminal.

---

## Key Decisions

- Full cancel (queued + executing) over queued-only: the primary operator need is stopping a run that is actively going wrong; a queued-only cancel would miss the main case.
- Post a cancellation notice to the origin Discord thread rather than stopping silently: thread watchers must be able to distinguish a deliberately cancelled run from a stalled one, and the thread already narrates run lifecycle.
- Auto-reject pending approvals on cancel rather than letting them dangle or expire: a terminal run with an undecided approval is an inconsistent state that confuses both transports.
- Idempotent no-op on already-terminal runs rather than an error: cancel races with natural completion are expected and must not surface as operator-facing failures.

---

## Dependencies / Assumptions

- The run-state machine already permits `CANCELLED` from PENDING, ACKNOWLEDGED, and EXECUTING — verified in `packages/runtime/src/coordination/run-state.ts`.
- The operator contract already models `cancelled` as a terminal run status consumed by the SSE stream manager — verified in `packages/gateway/src/web/sse/manager.ts`.
- Execution already runs under abort-signal control (timeout/inactivity), so an in-flight abort path exists to build on — verified in `packages/gateway/src/execute/run-core.ts`.
- There is currently no runId→abort-handle registry for in-flight runs (`inFlightRuns` tracks bare promises) — cancellation of executing runs requires adding one.
- `transitionRun` rejects transitions out of terminal phases (`VALID_TRANSITIONS` maps them to `[]`), so R2's terminal no-op requires a read-then-short-circuit before the transition call.
- Startup recovery currently reaps only non-terminal runs (`packages/gateway/src/execute/recovery.ts`), so R9 requires either atomic cleanup or extending recovery to reconcile terminal-`CANCELLED` runs holding a live lock.
- Adding an operator route touches the pinned route inventory (`packages/gateway/src/http/ingress-pin.test.ts`) and requires the deliberate security review that pin exists to force.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1][Technical] Operator-contract versioning: a new route and any new frame/DTO shapes interact with the dashboard's fail-closed contract-version drift gate; planning must decide bump-vs-no-bump and cross-repo sequencing so the deployed dashboard does not reject the gateway.
- [Affects R4][Technical] Whether aborting the gateway-side execution also requires explicitly terminating the workspace-side OpenCode session (or whether abandoning the SSE stream suffices), and what teardown the workspace API offers.
- [Affects R4][Technical] Cancel-vs-completion race semantics at the run-state store level (conditional-write loser handling) beyond the product-level "first commit wins" in AE6.
- [Affects R6][Technical] Exact wording and mechanism of the thread notice (new message vs status-message edit) — follow existing thread-narration conventions.
- [Affects R8][Technical] Where cancellation attribution lands (audit event, run-state metadata, or both), following the existing launch/approval attribution pattern.
- [Affects R5, R7][Technical] Ordering guarantee across approval settlement, the `CANCELLED` state commit, and the SSE terminal broadcast, so no transport briefly shows a live approval on a terminal run.
- [Affects R5][Technical] Whether cancel-triggered rejection reuses `registry.handleDecision` exactly or a dedicated internal helper with the same invariants, and what audit record the rejection emits.

---

## Sources / Research

- `packages/runtime/src/coordination/run-state.ts` — VALID_TRANSITIONS: `CANCELLED` reachable from all non-terminal phases.
- `packages/gateway/src/execute/run.ts` — queue admission, concurrency registry, `inFlightRuns` (no per-run abort handle today).
- `packages/gateway/src/execute/run-core.ts` — existing AbortController wiring (ceiling + inactivity), the seam an operator-initiated abort would join.
- `packages/gateway/src/web/sse/manager.ts` — terminal-status handling (`cancelled` in TERMINAL_STATUSES), `abortSubscription`, replay cache.
- `packages/gateway/src/http/ingress-pin.test.ts` — pinned operator route inventory; adding the cancel route is a deliberate security-review event.
- `docs/plans/2026-06-15-002` (operator surface deferred items) — where run cancellation was originally deferred.
- Precedent for mutating-route shape: launch route + approval decision route (browser guard, CSRF, allowlist, audit attribution).
