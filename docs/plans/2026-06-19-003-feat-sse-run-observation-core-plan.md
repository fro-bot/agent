---
title: "feat: Inert SSE run-observation core (Unit 4a)"
type: feat
status: active
date: 2026-06-19
deepened: 2026-06-19
origin: docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md
---

# Inert SSE run-observation core (Unit 4a)

## Overview

Build the **lean inert core** that will let authenticated operators observe gateway runs through a bounded, redacted, status-only stream — **without exposing any HTTP route**. This is Unit 4a of the operator web-surface plan (`docs/plans/2026-06-15-002`). After a design review (5 reviewers, 2026-06-19), 4a was scoped down to the minimum safe substrate: a run-status projection (consuming the operator contract via the redaction bridge), a registry scope-pending accessor, a minimal backpressure-safe pub/sub manager with a latest-state snapshot cache and heartbeat, and a run-lifecycle observer push source.

**Deliberately deferred to Unit 4b** (where a real route, operator identity, and measurable reconnect churn exist to justify and test them): the replay buffer + Last-Event-ID, the heartbeat-derived staleness detector, and the per-operator stream cap. Reconnect in 4a is `reset` → snapshot-read. This reverses the parent plan's Fork 1 (keep-replay) with reviewer-grounded rationale: for a status-only, zero-subscriber inert core, replay/staleness/cap are machinery without payoff and are cleaner to build against the 4b route.

Landing 4a lean de-risks the genuinely load-bearing parts now — the safe-field projection, the observer-only invariant, and non-blocking backpressure — behind tests, before any route can leak.

## Problem Frame

The operator web surface needs a live view of run status. The prerequisites now exist on `main`: the operator contract (`packages/gateway/src/operator-contract/`) with `toOperatorRunStatus`, the redaction surface gate (`packages/gateway/src/redaction/surface-gate.ts` `projectRunStatus`), and the run index (Unit 3i). What's missing is the *streaming substrate*: a projection that maps a `RunState` to a safe `OperatorWebStatus`, a manager that fans run-status events to subscribers without ever stalling on a slow consumer, and a push source wired into the run lifecycle. The design review established that this core must be observer-only (never touching run lifecycle/locks/heartbeat) and status-only (a closed allowlist DTO — no raw output/tool args/paths/`details`).

## Requirements Trace

- R1. A `RunState` projects to a safe `OperatorRunStatus` via the gateway redaction bridge; a denylisted/keyless repo yields **no record** (`null`), and a `null` projection is dropped before any buffering/emit.
- R2. The projected base status is overlaid with the one endpoint-only `OperatorWebStatus` value that has a real source on `main`: `waiting_for_approval` (the run's approval scope has an open/claimed entry). The result is always a valid `OperatorWebStatus`. (`blocked` is **not** in v1 — no source exists; see Open Questions.)
- R3. The approval registry exposes `hasPendingForScope(approvalScopeId)` returning true only when an open/claimed entry exists for that scope (no requestID guessing / cross-run leak).
- R4. A run-lifecycle observer hook in gateway `run.ts` pushes the post-transition safe `RunState` to the manager at each `transitionRun` call site where the new state is in hand; runtime is untouched and the run is never affected by observation (best-effort, contained).
- R5. The manager is backpressure-safe: the publisher serializes once and enqueues per subscriber and **never awaits** a subscriber write; per-subscriber enqueue is strictly non-blocking and a subscriber past its 64 KB queue cap is dropped locally (its stream closed) without affecting publish or peers. Per-subscriber resource use is bounded; the manager holds only a small latest-status cache per run, not an unbounded history.
- R6. Reconnect (or any subscribe) delivers the run's **latest** projected status immediately from the snapshot cache (no replay buffer, no Last-Event-ID in v1), then live frames; if no snapshot exists, a `reset` (`{runId, reason}`) is emitted. Snapshot-on-subscribe is the contract.
- R7. The stream carries only an explicit closed-DTO `OperatorRunStatus`, `reset`, and heartbeat/connection frames — **never** raw output, prompts, tool args/titles, workspace paths, approval details, internal URLs, or any `RunState.details` passthrough. Enforced structurally (field-by-field DTO, never spread), with a serialization test.
- R8. The manager is **observer-only**: it never mutates run lifecycle, lock, or heartbeat state; disconnect/abort removes only the subscription + its timers/queue. EOF before a terminal status is an observation failure, not run success.
- R9. 4a exposes **no public SSE route** — it is inert and safe to land.

## Scope Boundaries

- No HTTP route, no `web/server.ts` change, no socket-timeout fix (all Unit 4b).
- No `checkRepoAuthz` call, no operator-token use, no continuous-authz lease (Unit 4b).
- No owner-scoped visibility logic (the repo-scoped authz model is enforced at the 4b route).
- No web-launch approval-scope registration (`approvalScopeId = runId` for web runs is Unit 6); 4a's overlay correlates Discord runs via `thread_id → approvalScopeId` and is written so a web run's `runId` scope works once Unit 6 registers it.
- No progress/token streaming — status-only. Coarse progress is a future contract type.
- **No `blocked` status overlay** — no readable pre-execution-rejection source exists on `main` (see Open Questions). v1 overlays only `waiting_for_approval`.

### Deferred to Separate Tasks

- **Replay buffer + Last-Event-ID** (`${runId}:${seq}` monotonic sequence, count/byte/TTL-bounded history, in-window replay, gap `reset`): Unit 4b/later. v1 uses snapshot-on-subscribe. Reason: over-built for a status-only, zero-subscriber inert core; cleaner to size and test against a real route and measured reconnect churn. *(Reverses parent Fork 1 per the 2026-06-19 design review.)*
- **Heartbeat-derived staleness detector** (snapshot-reconcile a live-but-stuck run into a terminal/stale frame): Unit 4b/later. Reason: nothing observes the inert core, so there is no stuck-stream to reconcile yet; it also needs an exported canonical snapshot-read helper that does not exist on `main`.
- **Per-operator stream cap** (5 concurrent streams per operator): Unit 4b. Reason: 4a has no authenticated operator identity, so the cap would be synthetic/vacuous here; it becomes real when 4b supplies the operator id at the route.
- Authenticated route + authz + redaction-at-route + continuous-authz lease: Unit 4b (`docs/plans/2026-06-15-002`).
- OAuth scope broadening (`read:user` → repo-read) for the 4b authz path: tracked in project memory; belongs with 4b.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/redaction/surface-gate.ts` — `projectRunStatus(runState, {nowMs, staleThresholdMs, bindingsLookup, isRepoDenied})` is the async bridge the projection consumes; it resolves run→binding→deny-keys and calls `toOperatorRunStatus` internally, returning `OperatorRunStatus | null`. **Do not call `toOperatorRunStatus` directly.**
- `packages/gateway/src/operator-contract/` — `OperatorRunStatus`, `OperatorWebStatus` (canonical 7-value set), `OPERATOR_CONTRACT_VERSION`. The base mapping covers `queued|running|succeeded|failed|cancelled`; `waiting_for_approval` and `blocked` are endpoint overlays.
- `packages/gateway/src/approvals/registry.ts` — `RegistryEntry` carries `approvalScopeId` (L209) and `state: 'open'|'claimed'|'confirmed'`; `pending()` (L425) returns requestIDs. Add `hasPendingForScope` by filtering the entries map by scope + `open|claimed`.
- `packages/runtime/src/coordination/types.ts` — `RunState` (`run_id`, `surface`, `thread_id`, `entity_ref`, `phase`, `started_at`, `last_heartbeat`, `holder_id`, `details`); `RunPhase` (`PENDING|ACKNOWLEDGED|EXECUTING|COMPLETED|FAILED|CANCELLED`).
- `packages/gateway/src/execute/run.ts` — drives transitions via `transitionRunEffect` (gateway Effect wrapper, `runtime-effect.ts`). The observer hook fires after each successful transition with the new `RunState`.
- `packages/gateway/src/discord/status-message.ts` — `createStatusController` is the lifecycle/cleanup pattern to mirror: debounced updates, fail-soft `safePost`/`safeEdit`, `settle()`, terminal-edit discipline, `dispose()` clears timers. Mirror its discipline, not its Discord specifics.
- `packages/gateway/src/execute/run-index.ts` — bounded-map cap/TTL/eviction style to mirror for the manager's per-subscriber bounds and latest-status cache.

### Institutional Learnings

- `docs/solutions/best-practices/gateway-control-surface-spine-2026-06-15.md` — server-owned run resolution; the projection must never trust client input (4a has no client; 4b enforces).
- `docs/solutions/best-practices/atomic-serial-channel-queue-handoff-2026-06-09.md` and the mention-loop terminal-correctness doc — terminal-signal discipline and dual-finally cleanup; EOF/abort is observation failure, not run success.
- `docs/solutions/best-practices/centralize-s3-key-identity-construction-2026-06-09.md` — the staleness snapshot read must use the shared run-state key builder/identity, not an inline key.

### External References

- None — this is internal substrate following established gateway patterns.

## Key Technical Decisions

- **Consume the contract via the gateway bridge, not directly.** `projection.ts` calls `surface-gate.ts`'s `projectRunStatus` so binding resolution + denylist live in one owner; the projection only layers the single `waiting_for_approval` overlay on the returned base, then builds a **closed DTO** field-by-field.
- **Closed-DTO safe-field allowlist (structural, not documented).** The projection never spreads `RunState` or `RunState.details`; it constructs the output by copying only the explicit contract fields. A denied/keyless repo (`projectRunStatus` → `null`) is dropped before any cache/emit. A serialization test asserts no unsafe field can appear.
- **Observer push, not polling.** The hook fires at each `run.ts` `transitionRun` call site where the new `{state}` is in hand. There is no polling in 4a (staleness is deferred to 4b).
- **`hasPendingForScope` derives the approval overlay from the run's scope, not requestIDs.** Discord runs map `thread_id → approvalScopeId`; web runs (Unit 6) will use `runId`. Never infer via requestID guessing.
- **Publisher never awaits a subscriber write.** One bounded queue + one writer task per subscription; serialize the event once, enqueue per subscriber. Enqueue is strictly non-blocking; a subscriber past its 64 KB queue cap is dropped locally (stream closed) without affecting publish or peers — proven by an all-subscribers-slow test where `observe()` still completes in bounded time.
- **Snapshot-on-subscribe, not replay.** The manager keeps only the **latest** projected status per active run (a small cache, not a history). A new subscription receives the latest snapshot immediately, then live frames; with no snapshot it gets `reset`. No `${runId}:${seq}` sequence, no Last-Event-ID, no replay buffer in v1 (deferred).
- **Manager is observer-only.** Disconnect/abort removes only the subscription + its timers/queue; it must never touch the run timeout signal, coordinator, lock, or heartbeat — proven by a mutation-guard test with read-only-typed deps.

## Bounds (v1)

| Bound | Value |
|------|-------|
| Per-subscriber buffered-write cap | 64 KB (drop subscriber past cap) |
| Heartbeat interval | 15 seconds |
| Max stream duration | 30 minutes |
| Latest-status cache | one projected frame per active run; entry cleared on terminal/cleanup |

All bounds are named constants in `manager.ts`, injectable for tests. *(Replay count/byte/TTL bounds, the staleness grace, and the per-operator cap are deferred to 4b — see Scope Boundaries.)*

## Implementation Units

- [ ] **Unit 1: Run-status projection (consumes the contract bridge)**

  **Goal:** Map a safe `RunState` to an `OperatorRunStatus` (closed DTO) with the `waiting_for_approval` overlay, via the redaction bridge.

  **Requirements:** R1, R2, R7

  **Dependencies:** None (all consumed surfaces are on `main`).

  **Files:**
  - Create: `packages/gateway/src/web/sse/projection.ts`
  - Create: `packages/gateway/src/web/sse/projection.test.ts`

  **Approach:**
  - Export `projectRunObservation(runState, deps)` where `deps` carries `{nowMs, staleThresholdMs, bindingsLookup, isRepoDenied, hasPendingForScope}`. The `isRepoDenied` predicate shape is `(repoKey: {readonly databaseId: number | null; readonly nodeId: string | null}) => boolean` — pass it straight through to `projectRunStatus`, which resolves the binding's repo keys internally.
  - Call `projectRunStatus(runState, {nowMs, staleThresholdMs, bindingsLookup, isRepoDenied})` from `surface-gate.ts` to get the base `OperatorRunStatus | null`. `null` → return `null` (denied/keyless repo: contract omission; no record — the manager drops it before caching/emit).
  - Overlay (single): if `hasPendingForScope(scopeIdFor(runState))` is true, set the status to `waiting_for_approval` (overriding the projected base, which would be `running`). Otherwise keep the projected base. The result is always a valid `OperatorWebStatus`. **No `blocked` overlay** — no source exists on `main` (see Open Questions).
  - `scopeIdFor(runState)`: `surface === 'discord'` → `thread_id`; otherwise → `run_id` (forward-compatible with the Unit 6 web-launch scope).
  - **Closed DTO:** build the returned object by copying only the explicit contract fields from the `projectRunStatus` result + the overlaid status. Never spread `runState`, never read `runState.details` into the output. The return type is the contract's `OperatorRunStatus` (no extra fields).

  **Execution note:** Test-first — pin the phase→status mapping table and the overlay before wiring the manager.

  **Patterns to follow:** `surface-gate.ts` `projectRunStatus` call shape; the contract's `OperatorWebStatus` value set.

  **Test scenarios:**
  - Happy path: each `RunPhase` maps to the expected base status (`PENDING`/`ACKNOWLEDGED`→`queued`, `EXECUTING`→`running`, `COMPLETED`→`succeeded`, `FAILED`→`failed`, `CANCELLED`→`cancelled`).
  - Overlay: a run whose scope has a pending approval projects `waiting_for_approval` (overrides `running`).
  - Edge: a denylisted/keyless repo (`projectRunStatus` returns `null`) yields `null` (no record).
  - Safety: a `RunState` whose `details` carries raw output / a workspace path / tool args projects an output that contains **none** of those keys/values — assert the serialized DTO has exactly the contract fields (structural allowlist proof).
  - Scope: `scopeIdFor` returns `thread_id` for a Discord run and `run_id` for a non-Discord run.

  **Verification:** Every phase + the overlay produce a valid `OperatorWebStatus`; denied repos omit (`null`); the output is a closed DTO with no `details` passthrough.

- [ ] **Unit 2: Registry scope-pending accessor**

  **Goal:** Add `hasPendingForScope(approvalScopeId)` so the projection's `waiting_for_approval` overlay derives from the run's scope, not requestID guessing.

  **Requirements:** R3

  **Dependencies:** None.

  **Files:**
  - Modify: `packages/gateway/src/approvals/registry.ts`
  - Test: `packages/gateway/src/approvals/registry.test.ts`

  **Approach:**
  - Add `hasPendingForScope(approvalScopeId: string): boolean` to the `ApprovalRegistry` interface and `createApprovalRegistry`.
  - Implement by scanning the entries map for any entry whose `approvalScopeId` matches AND whose `state` is `open` or `claimed` (not `confirmed`). Return on first match.
  - Do not expose entry contents — boolean only (no oracle on request details).

  **Execution note:** Test-first.

  **Patterns to follow:** existing `pending()` / `has()` accessors in `registry.ts`.

  **Test scenarios:**
  - Happy path: returns true when an `open` entry exists for the scope; true for a `claimed` entry.
  - Edge: returns false when only a `confirmed` entry exists for the scope.
  - Edge: returns false for a scope with no entries; false after the entry settles/disposes.
  - Isolation: an entry for a *different* scope does not satisfy the query (no cross-scope match).

  **Verification:** `hasPendingForScope` is true iff an open/claimed entry exists for exactly that scope.

- [ ] **Unit 3: Lean backpressure-safe pub/sub manager (snapshot-on-subscribe)**

  **Goal:** The observer-only manager that fans run-status frames to subscribers without ever stalling on a slow consumer, serves the latest snapshot on subscribe, and heartbeats — with no replay buffer, no staleness detector, and no per-operator cap (all deferred to 4b).

  **Requirements:** R5, R6, R7, R8, R9

  **Dependencies:** Unit 1 (projection).

  **Files:**
  - Create: `packages/gateway/src/web/sse/manager.ts`
  - Create: `packages/gateway/src/web/sse/manager.test.ts`

  **Approach:**
  - `createRunObservationManager(deps)` returns `{ observe(runState), subscribe(runId, {onEvent, onClose}), shutdown() }` (names directional). Pure in-memory substrate; no route.
  - **Publish path:** `observe(runState)` projects via Unit 1. A `null` projection (denied/keyless repo) is **dropped immediately** — never cached, never emitted, no side effect. A non-null projection updates the run's **latest-status cache** (one frame per run) and is enqueued to each current subscriber of that run. The publisher serializes the frame once and enqueues per subscriber; it **never awaits** a write. On a terminal status, the cache entry is cleared after fan-out and subscribers are closed cleanly.
  - **Subscriber:** one bounded queue + one writer task draining to `onEvent`. Enqueue is strictly non-blocking: if appending would exceed the 64 KB queue cap, the subscriber is dropped locally (`onClose('overflow')`, queue/timers cleared) and removed from the run's subscriber set — without touching publish or peers. Dropping a subscriber mid-fan-out must not corrupt the publish iteration (iterate over a snapshot of the subscriber set, or guard removal).
  - **Subscribe / snapshot:** on `subscribe(runId, ...)`, if a latest-status cache entry exists, deliver it immediately as the first frame, then live frames. If none exists, emit a single `reset` (`{runId, reason}`) — the subscriber (4b's route) is expected to snapshot-read canonical state. There is **no** Last-Event-ID, sequence, or replay in v1.
  - **Heartbeat:** a 15 s keepalive frame per active subscription; **max duration** 30 min then close. Both are named injectable constants.
  - **Lifecycle separation (observer-only):** stream disconnect / `onAbort` removes only the subscription + its timers/queue; it must NEVER touch the run timeout signal, coordinator, lock, or heartbeat. The manager has no reference to any mutating run API (enforced by read-only-typed deps). EOF before a terminal status fires `onClose('observation-failed')`, never treated as run success.
  - `shutdown()` closes all subscriptions and clears all caches/timers.

  **Execution note:** Test-first — the load-bearing risk is non-blocking backpressure and the observer-only invariant; prove both before wiring the hook.

  **Patterns to follow:** `status-message.ts` fail-soft + `settle`/`dispose` cleanup discipline; `run-index.ts` bounded-map style; the mention-loop terminal-correctness solution doc.

  **Test scenarios:**
  - Happy path: observing queued→running→terminal pushes ordered frames to a subscriber; the terminal status closes the stream cleanly and clears the cache entry.
  - Snapshot-on-subscribe: subscribing to a run with a cached latest status delivers that status first, then live frames; subscribing to a run with no cache emits `reset`.
  - Backpressure (the load-bearing one): a slow subscriber exceeding its 64 KB queue cap is dropped (`onClose('overflow')`) without blocking publish or a fast peer; with **all** subscribers slow, `observe()` still completes in bounded time (no await on any write; the latest-cache update stays O(1) per run).
  - Bounds: a subscriber past the 30-min max duration is closed; the 15 s heartbeat frame is emitted on an idle subscription.
  - Denied-repo omission: observing a run whose `projectRunObservation` returns `null` produces no cache entry, no enqueued frame, no heartbeat/reset side effect (assert nothing buffered).
  - Observer-only invariant: a mutation-guard test wires mocked lifecycle/lock/heartbeat deps and asserts `observe`/`subscribe`/`shutdown`/disconnect never call any mutating run API.
  - Cleanup: an aborted connection removes its subscription, timers, and queued bytes; rapid connect/disconnect does not leak listeners or timers.
  - Error path: a writer failure on one subscriber is contained (does not crash the manager or other subscribers); EOF before terminal status fires `onClose('observation-failed')`, not success.
  - Safety: only the closed-DTO `OperatorRunStatus` / `reset` / heartbeat frames are ever enqueued — assert no raw output/tool/path frame can appear.

  **Verification:** The manager is non-blocking-backpressure-safe, snapshot-on-subscribe, redacted (denied omitted before cache), observer-only, and fully tested — no replay/staleness/cap, no route exposed.

- [ ] **Unit 4: Run-lifecycle observer hook (push source)**

  **Goal:** Wire the manager's `observe` into the gateway run lifecycle so transitions push safe `RunState` snapshots; instantiate the manager in the composition root.

  **Requirements:** R4, R9

  **Dependencies:** Units 1-3.

  **Files:**
  - Modify: `packages/gateway/src/execute/run.ts` (push after each successful transition)
  - Modify: `packages/gateway/src/program.ts` (instantiate manager, thread into run deps)
  - Test: `packages/gateway/src/execute/run.test.ts`

  **Approach:**
  - Add an optional `runObserver?` dep to the run path (mirroring how `runIndex` is optional in `RunMentionDeps`). `run.ts` calls runtime `transitionRun(...)` **directly** (not `transitionRunEffect`) and the call returns `{etag, state}` on success. At each successful `transitionRun` call site (the PENDING→ACKNOWLEDGED, ACKNOWLEDGED→EXECUTING, and EXECUTING→terminal points), call `runObserver?.observe(result.state)` with the post-transition `RunState` that is already in hand — best-effort, wrapped so an observer error never aborts or alters the run (try/catch + `logger.warn`). Do **not** refactor `run.ts` onto `transitionRunEffect`; attach at the existing direct call sites.
  - In `program.ts`, instantiate `createRunObservationManager(...)` once and thread it as `runObserver`. No route registration (4a is inert) — the manager exists and is fed, but nothing subscribes yet.
  - Confirm runtime is untouched (the hook lives in gateway `run.ts`, not runtime `transitionRun`).

  **Execution note:** Test-first on the wiring — assert `observe` is called with the post-transition state and that observer failure is contained.

  **Patterns to follow:** the optional-`runIndex` dep + try/catch best-effort `register` wiring already in `run.ts` (3i); the direct `transitionRun(...)` call sites in `run.ts`.

  **Test scenarios:**
  - Happy path: a run transitioning PENDING→ACKNOWLEDGED→EXECUTING→terminal calls `runObserver.observe` with the correct post-transition `RunState` at each step.
  - Best-effort: an `observe` that throws is caught and logged; the run continues and completes normally (no abort, no lifecycle change).
  - Inert: omitting `runObserver` is safe (no crash); `program.ts` wires a manager but exposes no subscribe route.
  - Integration: creating a run end-to-end drives observed transitions in order (mock manager records the sequence).

  **Verification:** Transitions push safe state to the manager, observer failure is contained, runtime is untouched, and no public route exists.

## Open Questions

### Resolved During Planning

- **Should `blocked` be a v1 overlay?** No. `RunState` has no pre-execution-rejection field and `toOperatorRunStatus` does not emit `blocked`; there is no readable source on `main`. v1 overlays only `waiting_for_approval` (which has a real source via `hasPendingForScope`). The contract still *defines* `blocked` as a valid `OperatorWebStatus`; 4a simply never produces it.
- **Where does the observer hook attach?** At the direct `transitionRun(...)` call sites in `run.ts` (it returns `{state}`), not `transitionRunEffect` — `run.ts` does not use the Effect wrapper.
- **Replay vs snapshot-on-subscribe?** Snapshot-on-subscribe for v1 (latest-status cache); replay buffer + Last-Event-ID deferred to 4b (reverses parent Fork 1 per the design review).

### Deferred to Implementation

- Exact latest-status cache eviction on run completion vs a short grace (so a subscriber connecting right after terminal still gets the final status) — decide against real `run.ts` terminal timing during implementation.
- The precise `blocked` source, if/when a pre-execution-rejection signal is added to `RunState` or surfaced via `details` — a future contract/runtime change, out of scope here.

## System-Wide Impact

- **Interaction graph:** the observer hook is additive at the direct `transitionRun(...)` call sites in `run.ts`; `program.ts` gains one instantiation. Nothing subscribes until 4b.
- **Error propagation:** observer errors are caught at the hook and never propagate to the run; manager writer errors are contained per-subscriber.
- **State lifecycle risks:** the manager must never mutate run/lock/heartbeat state — observer-only is the invariant (no snapshot/reconcile path in v1, so no read-then-write risk either).
- **API surface parity:** none exposed in 4a; the `subscribe`/`reset`/heartbeat/snapshot-frame shapes become the contract 4b's route serves.
- **Integration coverage:** the run.ts→manager push is the cross-layer behavior unit tests must prove (mock manager records the transition sequence).
- **Unchanged invariants:** runtime `transitionRun`/coordination is untouched; the run lifecycle, locks, and heartbeat behave identically with or without an observer.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Backpressure bug stalls publish/run | Publisher never awaits subscriber writes; strictly non-blocking enqueue + local drop past 64 KB; explicit all-subscribers-slow test proving `observe()` completes in bounded time. |
| Observer error affects the run | Best-effort try/catch at the hook; run-continues test; catch covers both sync throw and async rejection. |
| Status frames leak unsafe fields | Closed-DTO allowlist (never spread `RunState`/`details`); serialization test asserts no raw/tool/path/`details` field can appear. |
| Denied repo frame buffered/leaked | `null` projection dropped before any cache/emit; omission test asserts no buffered frame. |
| Drop-subscriber-mid-fan-out corrupts publish loop | Iterate over a snapshot of the subscriber set (or guard removal); cleanup/leak test. |
| Scope overlay wrong for web runs (Unit 6 not built) | `scopeIdFor` returns `run_id` for non-Discord; documented forward-compat; Discord path fully tested now. |

## Documentation / Operational Notes

- After 4b lands the route, document the operator stream contract (`subscribe`, `reset`, heartbeat, status-only fields) in the gateway operator docs. 4a adds no operator-facing docs (inert).
- Update `docs/plans/2026-06-15-002` Unit 4a checkbox on completion.

## Sources & References

- **Origin plan:** `docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md` (Unit 4a section, reshaped 2026-06-19).
- Related code: `packages/gateway/src/redaction/surface-gate.ts`, `packages/gateway/src/operator-contract/`, `packages/gateway/src/approvals/registry.ts`, `packages/gateway/src/execute/run.ts`, `packages/gateway/src/discord/status-message.ts`, `packages/runtime/src/coordination/types.ts`.
- Related issue: #907 (operator web surface umbrella).
