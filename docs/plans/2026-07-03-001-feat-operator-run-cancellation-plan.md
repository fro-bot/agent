---
title: 'feat: operator-initiated run cancellation'
type: feat
status: active
date: 2026-07-03
origin: docs/brainstorms/2026-07-03-operator-run-cancellation-requirements.md
deepened: 2026-07-03
---

# feat: operator-initiated run cancellation

## Overview

Add a browser-guarded mutating operator route that cancels a run whether it is queued (PENDING/ACKNOWLEDGED in the per-channel FIFO) or executing (EXECUTING with a live OpenCode stream). Cancellation commits the existing `CANCELLED` terminal state, auto-rejects pending tool approvals through the existing fail-closed settlement gate, posts a cancellation notice to the origin Discord thread, emits the terminal `cancelled` SSE status, is idempotent on terminal runs, is attributable to the cancelling operator, and survives gateway crashes without stranding the per-repo lock.

## Problem Frame

The operator surface can launch, list, stream, and approve — but not stop. A run going wrong holds its per-repo lock and concurrency slot until completion or the 30-minute ceiling. `CANCELLED` already exists in the run-state machine (reachable from all three non-terminal phases) and the operator contract already models the `cancelled` status; nothing operator-facing can trigger it. See origin: `docs/brainstorms/2026-07-03-operator-run-cancellation-requirements.md`.

## Requirements Trace

Traceability to the origin doc's requirements:

- R1 (authz/guard parity) → Unit 3
- R2 (any non-terminal phase; idempotent terminal no-op) → Units 1, 2, 3
- R3 (queued removal incl. dequeue-handoff window) → Unit 2
- R4 (prompt abort + full resource release; partial output preserved) → Units 1, 2
- R5 (approval auto-reject through the single settlement gate) → Unit 2
- R6 (Discord thread notice) → Unit 2
- R7 (SSE terminal `cancelled`, not `failed`) → Units 1, 3
- R8 (operator attribution) → Units 2, 3
- R9 (crash consistency — no stranded lock) → Unit 4

## Scope Boundaries

- Dashboard Cancel button/UI — dashboard-repo work consuming this route.
- Discord-side cancel initiation — web operator surface only.
- Bulk cancellation — single-run unit only.
- Run pause/resume — cancel is terminal.
- Cancel during gateway shutdown drain is a refused no-op; the startup recovery sweep owns terminalization (matches the existing shutdown-drain discipline).

### Deferred to Separate Tasks

- Dashboard contract-pin update to `1.6.0` + Cancel UI: `fro-bot/dashboard`, user-driven session after the gateway PR merges.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/web/operator/decision-route.ts` — the mutating-route template: gate ordering (session → repo-resolve → denylist → write-authz → parse → actor → settle → audit), uniform `notFoundResponse` denial (no oracle), rate-limit after authz, `WebOperatorActor` built server-side only.
- `packages/gateway/src/web/operator/route-helpers.ts` — `resolveRepoFromRunIndex` + `checkDenylist`, shared by per-runId routes.
- `packages/gateway/src/execute/run.ts` — run lifecycle: `AbortSignal.timeout` at ~:489 threaded into `runOpenCodeCore` (:592); error path (:668-779) maps `RunCoreError` kinds to transitions + coarse replies; `inFlightRuns` set (:911-919); atomic queue handoff (:823-885); `failAdmittedRun` (:1134-1143).
- `packages/gateway/src/execute/run-core.ts` — inactivity controller + `AbortSignal.any` composition (:281-304); `RunCoreErrorKind` union (:36-44); abort checks at every loop iteration.
- `packages/gateway/src/execute/queue.ts` — `ChannelQueue<T>` closure over `Map<string, T[]>`; `RunTask` entries carry `runId`; no remove-by-id primitive today.
- `packages/gateway/src/approvals/registry.ts` — `handleDecision` (:214-219) single fail-closed settlement gate; `describePendingForScope` (:482-503); `confirmReply` cascade.
- `packages/runtime/src/coordination/` — `transitionRun` (valid-transitions table rejects terminal→CANCELLED; conditional-write etags), `releaseLock` (ifMatch), `forceReleaseStaleLock` (dead-run-verified, checks lock `run_id` ownership), `heartbeat.stop()`.
- `packages/gateway/src/execute/recovery.ts` — startup sweep; currently reaps only non-terminal runs to FAILED.
- `packages/gateway/src/discord/io.ts` — `sendMessage` (hardcoded `SAFE_MENTIONS`, fail-soft); `discord/presence.ts` shows `client.channels.fetch` + `sendMessage`.
- `packages/gateway/src/web/sse/manager.ts` — `cancelled` already in `TERMINAL_STATUSES`; terminal drain + replay cache need no changes; `PHASE_TO_WEB_STATUS` already maps `CANCELLED → 'cancelled'`.
- `packages/gateway/src/web/audit.ts` — exhaustive audit-kind union + `LOG_LEVEL` compile-time guard.
- `packages/gateway/src/http/ingress-pin.test.ts` (:114-127) and `packages/gateway/src/web/operator-route-smoke.ts` (:40-53) — dual route-inventory pins; both must gain the cancel route in the same PR.
- Contract-bump precedent: every prior route addition bumped MINOR (1.0.0→…→1.5.0, commits `9fdaa1920`…`364033861`).

### Institutional Learnings

- `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md` — abort composition via `AbortSignal.any`; dual-`finally` cleanup; lock release must verify lock `run_id` ownership (P0 class); failure-path partial-output flush.
- `docs/solutions/best-practices/atomic-serial-channel-queue-handoff-2026-06-09.md` — handoff occurs with the slot held; queued runs hold no slot; cancel-removal must be race-checked against `takeNext`.
- `docs/solutions/best-practices/web-operator-launch-surface-2026-06-20.md` — pre-acceptance denials collapse to one generic shape; per-operator idempotency reserve/commit/rollback; `createWebAutoDenyApproval` is prior art for auto-reject.
- `docs/solutions/best-practices/sse-output-streaming-terminal-drain-2026-06-21.md` — terminal is a drain state; out-of-order projection guard (`terminalRuns`) is the active constraint for EXECUTING-after-CANCELLED.
- `docs/solutions/best-practices/authenticated-sse-run-observation-2026-06-20.md` — no-oracle denials including throws; contract version on the ready frame (the dashboard drift-gate surface).
- `docs/solutions/best-practices/dependency-gated-route-registration-guard-2026-06-25.md` — new route ⇒ update `EXPECTED_OPERATOR_ROUTES` + per-dep-omission smoke regression in the same PR.
- `docs/solutions/best-practices/centralize-s3-key-identity-construction-2026-06-09.md` — run-state writes use `getRunKey(..., identity, ...)`, lock uses `getLockKey`; pin key strings in regression tests.
- `docs/solutions/best-practices/signed-webhook-ingress-hardening-2026-05-29.md` — bound every outbound call; late-firing promises get `.catch` (the #1055 unhandled-rejection class).
- `docs/solutions/best-practices/architectural-issues-type-safety-and-resource-cleanup.md` — reverse-order release, each step independently wrapped, cleanup never throws; force-test cleanup-failure paths.

## Key Technical Decisions

- **Cancel signal composes with existing signals via `AbortSignal.any`** — the run's effective signal becomes any-of(ceiling timeout, inactivity, operator cancel). No parallel abort mechanism; `run-core.ts` already checks the combined signal everywhere it must.
- **Cancel classification happens in `run.ts`'s catch handler via an abort-registry probe** (`cancelRegistry.get(runId)?.signal.aborted`), not by inspecting the composite abort reason — `AbortSignal.any` propagates whichever child fired first, so reason inspection is racy; the registry's own signal is ground truth. The composed signal is built at the existing `run.ts:489` seam (nested `AbortSignal.any` with run-core's inactivity composition is well-defined; run-core's interface stays unchanged). A `'cancelled'` `RunCoreErrorKind` is added only if implementation finds run-core itself must behave differently on cancel; default is classification-at-run.ts with the existing kinds.
- **runId→abort-handle registry lives in the execute layer** (small module beside `inFlightRuns`), registered after the EXECUTING transition, deleted in the run's existing `finally`. The route never reaches the inner execution primitive — it goes through a transport-neutral `cancelRun` orchestrator in `execute/`.
- **Approval auto-reject enumerates pending entries and settles each through `registry.handleDecision` with `decision: 'reject'`** — reuses the single fail-closed gate verbatim (origin R5); no parallel settlement path, no new registry semantics.
- **Idempotency by read-then-short-circuit** — `transitionRun` rejects terminal transitions by design; the orchestrator reads current state first and returns the terminal phase without attempting a transition (origin R2, AE1/AE6).
- **Run-state rendezvous covers the registration window** — between queue dequeue and abort-registry registration (the pre-ACK gates: clone, readyz, threadFactory, lock), a cancel finds neither a queue entry nor an abort handle. The third path: `transitionRun(currentPhase → CANCELLED)` via conditional write. Either the cancel wins (the run's own next transition 412s, re-reads, sees CANCELLED, and exits cleanly) or the run advances first (cancel re-reads and retries/short-circuits). No polling, no early registration — the conditional-write chain is the rendezvous.
- **Contract bump 1.5.0 → 1.6.0** (additive route + response type = MINOR, matching all 5 prior route-addition precedents). **Deploy sequencing is load-bearing:** the dashboard drift gate is exact-match fail-closed (`operator-sse-reader.ts:481-486` — `contractVersion !== pin` → `onError('contract-drift')` + immediate close; pin currently `1.5.0`, tests pin the behavior). Any version skew in either direction kills every operator run stream at the ready frame. Merging the gateway PR is safe; *deploying* a 1.6.0 gateway requires either a coordinated deploy with the dashboard's pin bump or a transitional dual-accept on the dashboard side — dashboard-side decision, surfaced at PR time (see Risks).
- **Attribution in run-state `details.cancelledBy`** ({githubUserId, login, sessionCorrelationId, cancelledAt}) plus `run.cancel.*` audit events — mirrors launch/approval attribution. The `toRunSummary` projection must not leak it (verify in Unit 3 tests).
- **Plain async, not Effect** — the launch/decision routes and `run.ts` orchestration are plain async; the cancel route and orchestrator follow suit.

## Open Questions

### Resolved During Planning

- Bump vs no-bump: bump to 1.6.0 (policy + 5 precedents; user-confirmed).
- Error-kind reuse: new `'cancelled'` kind (user-confirmed).
- Shutdown behavior: cancel during drain is refused; recovery owns it (user-confirmed).

### Deferred to Implementation

- Whether the queued-cancel path can reuse `failAdmittedRun` with a phase parameter or needs a sibling `cancelAdmittedRun` — depends on how much of its shape (observer notify, index touch) is phase-independent. (Note: on cancel-wins-adoption races, `failAdmittedRun` must be skipped entirely — see Unit 1 approach.)
- Whether heartbeat's benign post-CANCELLED heartbeat write (terminal state gains a `last_heartbeat` update; harmless, doesn't resurrect the run) warrants suppression or just a comment — decide at the seam.
- Thread-notice wording — follow existing thread-narration voice at implementation time.
- Whether `runIndex.lookup` gains `thread_id` (additive) or the orchestrator reads run-state directly for the thread — pick whichever keeps the orchestrator single-read.

## Implementation Units

- [ ] **Unit 1: Cancel signal seam — abort registry + `'cancelled'` error kind + CANCELLED error path**

**Goal:** An in-flight run can be aborted by runId, and the run lifecycle settles it as `CANCELLED` (not `FAILED`) with partial output preserved.

**Requirements:** R2, R4, R7

**Dependencies:** None

**Files:**
- Create: `packages/gateway/src/execute/abort-registry.ts`
- Create: `packages/gateway/src/execute/abort-registry.test.ts`
- Modify: `packages/gateway/src/execute/run.ts`, `packages/gateway/src/execute/run-core.ts`
- Test: `packages/gateway/src/execute/run-core.test.ts`, `packages/gateway/src/execute/run.test.ts`

**Approach:**
- Closure-based registry (`register/abort/delete` by runId) beside `inFlightRuns`; registered after the EXECUTING transition succeeds, removed in the run's existing outer `finally`.
- Compose the cancel signal at the existing `run.ts:489` seam (`AbortSignal.any([timeout, cancel])` passed as the core's `signal`; run-core's internal inactivity composition nests cleanly — no run-core interface change).
- Classify in run.ts's catch handler by probing the registry (`cancelRegistry.get(runId)?.signal.aborted`) — NOT by composite abort reason (racy under `AbortSignal.any`). The cancelled case: `heartbeat.stop()` FIRST (its `runEtag`/`lockEtag` are the authoritative conditional-write etags — a stale etag makes the lock release silently fail and TTL-orphan), flush partial output (existing best-effort flush), `transitionRun(CANCELLED)` with attribution details, notify SSE observer, release lock with the heartbeat-stop `lockEtag` + `run_id` ownership check, release slot in the outer finally (existing dual-`finally` shape). Suppress the user-facing failure reply for operator-initiated cancels (the thread notice from Unit 2 is the communication).
- Etag-mismatch graceful losers: when the run's own `PENDING→ACKNOWLEDGED` or `ACKNOWLEDGED→EXECUTING` transition 412s, re-read the run-state; if `CANCELLED`, skip `failAdmittedRun` (its stale etag would 412 anyway and log a misleading error), suppress the user-facing "could not start" reply, release resources, exit cleanly.

**Patterns to follow:** inactivity-controller composition in `run-core.ts:281-304`; the FAILED error path in `run.ts:668-779`; dual-`finally` cleanup (mention-loop learnings doc).

**Test scenarios:**
- Happy path: registered run aborted by runId → run-core exits with `RunCoreError('cancelled')` → run settles `CANCELLED`, SSE observer notified, lock released, slot released.
- Edge: abort for an unknown/already-completed runId → registry no-op, no signal fired.
- Edge: ceiling timeout and operator cancel racing → exactly one terminal state; classification via registry probe does not mislabel (composite reason is not consulted).
- Edge: cancel wins the adoption race (PENDING→CANCELLED commits before PENDING→ACKNOWLEDGED) → the run's transition 412s, re-reads, sees CANCELLED, exits without `failAdmittedRun` noise or a user-facing failure reply.
- Error path: lock release fails on cancel path → cleanup continues (slot still released), error logged, no throw from cleanup.
- Error path (the #1055 class): OpenCode stream never settles after abort → the run's promise still resolves within the bounded window; no unhandled rejection from late-firing `.return()`.
- Integration: partial output streamed before cancel remains flushed/visible after `CANCELLED` settles.

**Verification:** gateway `tsc` + full gateway suite green; a simulated in-flight run cancelled via the registry lands `CANCELLED` with all resources released (asserted via fakes, not sleeps).

- [ ] **Unit 2: Cancel orchestrator — queue removal, approval cascade, thread notice, attribution**

**Goal:** A single transport-neutral `cancelRun(runId, actor, deps)` entry point that resolves the run's phase and executes the correct cancellation path.

**Requirements:** R2, R3, R4, R5, R6, R8

**Dependencies:** Unit 1

**Files:**
- Create: `packages/gateway/src/execute/cancel.ts`
- Create: `packages/gateway/src/execute/cancel.test.ts`
- Modify: `packages/gateway/src/execute/queue.ts` (add `removeByRunId`)
- Test: `packages/gateway/src/execute/queue.test.ts`

**Approach:**
- Read run-state first (via `getRunKey` — never inline keys). Terminal phase → return `{outcome: 'already-terminal', phase}` (idempotent, origin AE1/AE6).
- Queued (PENDING/ACKNOWLEDGED): `queue.removeByRunId(channelId, runId)`; on hit, terminalize to `CANCELLED` (no lock/slot held for queued runs — nothing to release). On miss, probe the abort registry; on registry hit, fire the abort (executing path). On double miss (the pre-ACK registration window, origin AE7): attempt `transitionRun(currentPhase → CANCELLED)` directly — the conditional write is the rendezvous (see Key Technical Decisions); on 412, re-read and retry once or short-circuit on terminal.
- Executing: enumerate pending approvals for the run's scope (`describePendingForScope`) and settle each via `registry.handleDecision({decision:'reject', actor})`; then fire the abort handle. The Unit 1 error path owns the state transition and resource release.
- Post the thread notice: resolve `thread_id` from run-state, `client.channels.fetch` → `sendMessage` (fail-soft, mention-safe, bounded); notice failure must not fail the cancellation.
- Write attribution into the transition's `details.cancelledBy`.

**Patterns to follow:** `presence.ts` channel-fetch + `sendMessage`; `createWebAutoDenyApproval` (web-launch learnings) for the reject cascade; reverse-order, independently-wrapped cleanup (resource-cleanup learnings).

**Test scenarios:**
- Happy path: queued run cancelled → removed from queue, `CANCELLED` committed, thread notice sent, active run on the same channel untouched (origin AE2).
- Happy path: executing run cancelled → approvals rejected through `handleDecision` (asserted: no direct registry-state mutation), abort fired, notice sent.
- Edge: cancel in the dequeue-handoff window (double miss) → run-state rendezvous commits CANCELLED; the run's own next transition 412s and exits cleanly; run never executes user work; response not a misleading no-op (origin AE7).
- Edge: double-cancel (two concurrent cancels) → one wins the conditional write, the other re-reads and reports already-terminal; abort() on an aborted controller is a spec no-op.
- Edge: already-terminal run → `already-terminal` outcome, no transition attempted, no notice posted (origin AE1).
- Error path: pending-approval rejection fails for one entry → remaining entries still settled; cancellation proceeds fail-closed.
- Error path: thread notice send fails → cancellation still completes; failure logged.
- Integration: approval settle frames reach both web (`observeApproval`) and Discord render paths on cancel (origin AE4).

**Verification:** every origin acceptance example AE1–AE7 that is orchestrator-scoped has a corresponding passing test; queue removal is race-checked against concurrent `takeNext` in a deterministic test.

- [ ] **Unit 3: Operator cancel route + contract 1.6.0 + pins + audit**

**Goal:** `POST /operator/runs/:runId/cancel` exposed on the operator surface with full guard parity, typed response, audit events, and the contract bump.

**Requirements:** R1, R2, R7, R8

**Dependencies:** Unit 2

**Files:**
- Create: `packages/gateway/src/web/operator/cancel-route.ts`
- Create: `packages/gateway/src/web/operator/cancel-route.test.ts`
- Modify: `packages/gateway/src/web/server.ts` (registration tuple beside the decision route), `packages/gateway/src/operator-contract/responses.ts`, `packages/gateway/src/operator-contract/parse.ts`, `packages/gateway/src/operator-contract/index.ts`, `packages/gateway/src/operator-contract/version.ts` (1.5.0 → 1.6.0), `packages/gateway/src/web/audit.ts`, `packages/gateway/src/http/ingress-pin.test.ts`, `packages/gateway/src/web/operator-route-smoke.ts`
- Test: `packages/gateway/src/operator-contract/version.test.ts`, `packages/gateway/src/web/server.test.ts`

**Approach:**
- Mirror `decision-route.ts` gate ordering exactly: session → `resolveRepoFromRunIndex` → `checkDenylist` → `checkRepoWriteAuthz` → rate limit (after authz, operator-keyed) → server-built `WebOperatorActor` → `cancelRun` → audit → typed response. All pre-acceptance denials return the identical `notFoundResponse` (no oracle), including throws.
- Response type in the contract: success carries the resulting phase (`CANCELLED` or the pre-existing terminal phase for idempotent hits) so the dashboard can render "already completed" honestly.
- New audit kinds (`run.cancel.requested` / `run.cancel.rejected` or a single kind with outcome) + `LOG_LEVEL` entries (compile-time exhaustive).
- Update BOTH route pins + per-dep-omission smoke regression (dependency-gated-route learnings).
- Verify `toRunSummary` / run-status projections do not leak `details.cancelledBy`.

**Patterns to follow:** `decision-route.ts` (gates, try/catch split, response mapping); `launch-route.ts` (operator-keyed rate limiting); contract barrel + parse-helper conventions.

**Test scenarios:**
- Happy path: authorized operator cancels own-repo run → 200 with phase, audit event emitted with actor identity.
- Error path: no session / bad CSRF / wrong origin / denylisted repo / no write authz → identical generic denial, zero state change (origin AE5); gate-throw degrades to the same denial.
- Edge: cancel an already-terminal run → idempotent success carrying the terminal phase.
- Edge: rate limit exceeded → limited response; unauthorized requests don't consume budget.
- Integration: route inventory pins (ingress-pin + smoke) pass with the new route; contract version test asserts 1.6.0; projection tests prove `cancelledBy` never reaches summary/status DTOs.

**Verification:** ingress-pin, smoke, and full gateway suite green; the SSE ready-frame carries 1.6.0.

- [ ] **Unit 4: Crash-consistency recovery — reconcile CANCELLED runs holding live locks**

**Goal:** A crash between the `CANCELLED` transition and resource cleanup cannot strand the per-repo lock (origin R9).

**Requirements:** R9

**Dependencies:** Units 1–2 (the cancel paths whose partial failure this reconciles)

**Files:**
- Modify: `packages/gateway/src/execute/recovery.ts`
- Test: `packages/gateway/src/execute/recovery.test.ts`

**Approach:**
- `findStaleRuns` (`packages/runtime/src/coordination/run-state.ts`, phase filter around :214) currently skips CANCELLED entirely — a crash between the CANCELLED transition and lock release is invisible to the sweep. Extend the phase filter to include CANCELLED (gated on the staleness window) OR add a dedicated second pass listing CANCELLED-phase run-states; either way release via `forceReleaseStaleLock` (dead-run-verified — lock `run_id` ownership + lease/heartbeat staleness built in, protecting a newer run's lock from blind deletion).
- Recovery-vs-cancel races are already safe (conditional writes: whichever transition commits first wins; the loser re-reads and skips) — pin with a test, no new machinery.
- Emit a recovery audit/log line for each reconciled lock.

**Patterns to follow:** existing `recoverStaleRuns`/`recoverOneRun` shape; `forceReleaseStaleLock` usage; lock-ownership P0 lesson (mention-loop learnings).

**Test scenarios:**
- Happy path: CANCELLED run + its own live lock at startup → lock released, logged.
- Edge: CANCELLED run, lock since re-acquired by a NEWER run (`run_id` mismatch) → lock untouched.
- Edge: CANCELLED run, no lock present → no-op.
- Error path: release fails → sweep continues to other repos; failure logged, startup not blocked.

**Verification:** recovery suite green; a simulated crash-mid-cancel (state committed, lock alive) reconciles on boot with no manual intervention.

## System-Wide Impact

- **Interaction graph:** cancel touches run lifecycle (`run.ts`/`run-core.ts`), queue, approvals registry, SSE manager (no code change — existing terminal handling), Discord io, recovery, and the operator contract. The SSE and Discord surfaces consume existing seams; no new fan-out paths.
- **Error propagation:** cancellation is never reported as a generic failure — the `'cancelled'` kind keeps operator messaging and run-state honest. Cleanup steps are independently wrapped; a failing side effect (notice, one approval settle) degrades without aborting the cancellation.
- **State lifecycle risks:** cancel-vs-completion and cancel-vs-handoff races settle to exactly one terminal state via conditional writes + read-then-short-circuit; the out-of-order SSE guard (`terminalRuns`) prevents a late EXECUTING projection from regressing a committed CANCELLED.
- **API surface parity:** the route joins launch/decision as the third mutating operator route with identical guard shape. Dashboard gains the capability only after its own pin bump (deferred task).
- **Integration coverage:** approval-settle frames on both transports; queue-removal race; recovery reconciliation — all pinned by tests above; the ingress pins force the deliberate-review event the security posture expects.
- **Unchanged invariants:** `registry.handleDecision` remains the sole settlement gate; `OPERATOR_CONTRACT_VERSION` remains build-time pinned and never negotiated over the wire; the queue remains in-memory/lossy; `io.ts` remains the only Discord send boundary; no new listener or network surface.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Dashboard drift gate vs 1.6.0 bump | **Verified: exact-match fail-closed** (`fro-bot/dashboard` `operator-sse-reader.ts:481-486`; pin `1.5.0`; mismatch → `contract-drift` error + stream close, test-pinned). A 1.6.0 gateway deploy against a 1.5.0 dashboard kills every operator run stream at the ready frame — and vice versa. Mitigation: merge is safe, deploy is the gate — coordinate the dashboard pin bump to land in the same deploy window (user-driven dashboard session), or add transitional dual-accept dashboard-side first. Surface prominently at PR time. |
| Blind lock release deleting a newer run's lock | Always `forceReleaseStaleLock` / ownership-checked release (`run_id` match) — never unconditional delete (documented P0 class). |
| Hung OpenCode stream after abort pins the route or leaks an unhandled rejection (#1055 class) | Bound cancel propagation; `.catch` on late-firing promises; regression test with a never-settling stream. |
| Queue removal racing `takeNext` handoff | Deterministic race test; miss falls through to abort-registry path so the window is covered either way (AE7). |
| Cancel spam / abuse | Operator-keyed rate limit after authz; idempotent no-ops are cheap; audit trail per attempt. |
| Approval reject cascade partially failing | Per-entry isolation; fail-closed continuation; integration test. |

## Documentation / Operational Notes

- `docs/wiki/` operator-surface page and `packages/gateway/AGENTS.md` route inventory mentions gain the cancel route (same PR).
- The dashboard follow-up (pin 1.6.0 + Cancel UI) is a `fro-bot/dashboard` task; surface it clearly at PR time so the user can schedule the dashboard session.
- No deploy/compose changes; no new env vars.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-07-03-operator-run-cancellation-requirements.md`
- Related code: see Context & Research above.
- Contract-bump precedent commits: `9fdaa1920`, `3d5fdcf19`, `5276272b0`, `1ad74fc04`, `364033861`.
- Related plan: `docs/plans/2026-06-15-002` (operator surface — where cancellation was deferred).
