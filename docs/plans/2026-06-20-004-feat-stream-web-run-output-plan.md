---
title: "feat: Stream web-launched run output to the operator"
type: feat
status: done
date: 2026-06-20
origin: docs/brainstorms/2026-06-20-stream-web-run-output-requirements.md
issue: 965
---

> **Status: done.** All 6 units shipped: the `OperatorOutputFrame` contract type + version bump, the manager `output` frame + `observeOutput` + terminal-output cache, the run-stream route `output` SSE mapping, the web `ReplySink` wired to push output, engine-side ordering, and the docs refresh — all verified on `main` (`packages/gateway/src/operator-contract/output.ts`, `packages/gateway/src/web/sse/manager.ts`). Closes #965.

# feat: Stream web-launched run output to the operator

## Overview

Deliver a web-launched run's agent output to the operator over the **existing** SSE run-stream. Today the web `ReplySink` (`packages/gateway/src/web/operator/web-sinks.ts`) accumulates the agent's text in memory and drops it (`flush`/`send` are no-ops); the operator can watch a run reach `succeeded`/`failed` over the status stream but never sees what the agent said. This wires the web sink's output through the run-observation manager as a new `output` SSE frame — live deltas as the agent produces them, plus an authoritative final-answer frame that guarantees completeness. Reuses the single run-stream connection and the existing per-subscriber backpressure. Closes #965 (advances #907).

## Problem Frame

The web operator surface is **status-only by construction** (see origin). The run-observation manager projects each `RunState` transition into a closed `OperatorRunStatus` DTO and fans it out as `status`/`reset`/`heartbeat` frames; the agent's output text never enters this pipeline. The text *does* flow into `request.replySink.append(...)` during execution (`packages/gateway/src/execute/run-core.ts:387,389,400`), but the web sink buffers it and `flush` is a no-op. The Discord transport already delivers the same text by posting the buffer to the thread (`packages/gateway/src/discord/streaming.ts:163-211`) — this brings parity to the web surface.

## Requirements Trace

- R1. A web operator subscribed to a run's stream sees the agent's output arrive live as `output` frames while the run executes.
- R2. The operator always ends with the complete answer: a `final: true` `output` frame is enqueued **before** the terminal status frame and **replaces** the accumulated live text.
- R3. A subscriber connecting **after** the run reached a terminal phase still receives the cached final answer (terminal-output snapshot).
- R4. A run with no output (empty / early failure) still produces a terminal `output` frame so the operator can distinguish "no output" from "missing output".
- R5. Under a slow/overflowing subscriber, the connection stays alive; output coalesces and the client is told via a monotonic `seq` + `droppedCount`. Per-subscriber queues stay independent.
- R6. Output is never delivered to an operator who lost repo access mid-run (rides the existing continuous-authz lease; the connection tears down within the accepted ~30s window).
- R7. The Discord transport's behavior is unchanged (the `ReplySink` change is additive to the web sink only; the engine-side reorder is inert for Discord).
- R8. Contract bump to `1.3.0` (additive `output` frame type); 1.2.x clients keep working via the `ready`-frame `contractVersion` feature-detect.

## Scope Boundaries

- No mid-stream content scrub / secret-scanning pass (deferred by policy — output is operator-safe by the sink route it took; the repo-authz gate is the trust boundary). See Key Technical Decisions.
- No second SSE channel — extend the existing manager + run-stream route.
- No mid-stream delta replay/scrollback. A reconnecting subscriber resumes live; only the terminal-output snapshot is cached and re-delivered (R3), not a delta history.
- No tighter-than-Discord projection — output reuses run-core's existing visible-output discipline (reasoning suppressed, tools summarized), not a new one.

### Deferred to Separate Tasks

- Tightening the authz lease for sensitive output (file contents/secrets): if a future change streams more than the current sink-routed visible text, the lease window must tighten per the SSE doc's rule-8 warning. Captured as an in-code foot-gun comment now; no separate issue yet.

## Context & Research

### Relevant Code and Patterns

- **Manager** `packages/gateway/src/web/sse/manager.ts`: `ObservationFrame` closed union (`:78`); `StatusFrame`/`ResetFrame`/`HeartbeatFrame` (`:54-75`); `observe(runState)` (`:460-506`) updates `latestStatusCache` (`:239`) then `fanOut`, and on terminal clears the cache + `closeRunSubscribers` (`:502-505`); `runSubscribers` per-run map (`:242`); `enqueueFrame` byte-cap + overflow-drop (`:303-331`, cap `DEFAULT_SUBSCRIBER_QUEUE_CAP_BYTES = 64*1024` at `:37`); `subscribe` snapshot-on-subscribe from `latestStatusCache` (`:538`); `shutdown` clears cache (`:602`).
- **Run-stream route** `packages/gateway/src/web/sse/run-stream-route.ts`: `writeFrame` SSE event mapping (`:178-191`) with an exhaustiveness `never` guard (`:188`); `ready` frame emitted first with `contractVersion` (`:442-448`); the lease re-verification (`:208-261`).
- **Projection** `packages/gateway/src/web/sse/projection.ts`: `projectRunObservation` closed-DTO copy of only the 7 contract fields (`:80-88`); denylist gate lives in `run-status.ts:131-135` (status path only — output bypasses projection).
- **Web sink** `packages/gateway/src/web/operator/web-sinks.ts`: `createWebReplySink()` (`:82-123`) — no params, `append` buffers, `flush`/`send` no-op.
- **Launch route** `packages/gateway/src/web/operator/launch-route.ts`: `replySink: createWebReplySink()` (`:342`); `LaunchRouteDeps` (`:97-128`) has no manager; `request` literal in scope: `runId` (`:335`), `binding`, `operatorIdentity`, `surface`.
- **Server wiring** `packages/gateway/src/web/server.ts`: `OperatorServerDeps.runObservationManager` (`:158`); `buildLaunchRoute` call (`:671-698`) does NOT pass the manager; `buildRunStreamRoute` does (`:582,602`).
- **Engine** `packages/gateway/src/execute/run.ts`: final answer source `replySink.buffered()` → `statusSink.resolveToAnswer(finalText)` (`:640-641`), then `flush()` on delegated (`:642-644`); terminal `notifyObserverBestEffort` fires at `:632` (COMPLETED) and `:698` (FAILED) — **before** the final answer is available (the reorder point).
- **Discord sink (reference)** `packages/gateway/src/discord/streaming.ts:129-211`: `append` buffers, `flush` posts the complete answer.
- **Contract** `packages/gateway/src/operator-contract/version.ts:15` (`'1.2.0'`); barrel `index.ts:17-28`; sibling type files `run-status.ts`/`approval.ts`/`redaction.ts`.
- **Tests** `manager.test.ts` (`collectFrames` harness `:178`, `drain()` `:199`, backpressure block `:354`, observer-only-invariant block `:717`); `run-stream-route.test.ts` (`makeManager` all-vi.fn `:152`, no-oracle assertions); `launch-route.test.ts` (module-mocks `launchWork`, captures the request shape).

### Institutional Learnings

The SSE run-observation doc (`docs/solutions/best-practices/authenticated-sse-run-observation-2026-06-20.md`) is the de-facto checklist — its 10 rules govern this work. Key applications:
- **Closed-DTO (rule 5) — NO exception needed.** The output frame's `text` is sourced from the `ReplySink` boundary (spine doc rule 2: "pass sinks, not transport objects"), not extracted from `RunState` by the projection. The DTO's `RunState` projection is unchanged; we add a new *frame type*, blessed by the 1.3.0 bump (rule 10). The plan states this so review does not re-litigate.
- **No-oracle (rule 1)** — no new `output-not-available`/`output-not-authorized` error codes; the stream itself is the only success shape, `404` the only denial.
- **Backpressure (rule 6)** — reuse the existing 64KB per-subscriber cap + overflow path; extend the frame enum, do not fork the cap accounting. One manager (spine doc rule 6: collapse, don't fork).
- **Lease (rule 8)** — output rides the existing lease; document the foot-gun that streaming sensitive content later must tighten it.
- **FIFO/ordering** (`atomic-serial-channel-queue-handoff-2026-06-09.md`) — `ready` stays the always-first frame; cached output replays in order after `ready`.
- **Cache key** (`centralize-s3-key-identity-construction-2026-06-09.md`) — the terminal-output cache is in-memory, named `latestOutputCache` as a sibling to `latestStatusCache` in the same file/lifecycle.

### External References

None — strong local patterns (the SSE doc's rules + the manager itself). External research skipped.

## Key Technical Decisions

- **`output` frame shape:** `{ type: 'output', runId: string, text: string, final: boolean, seq: number, droppedCount?: number }`. Delta frames append (`final: false`); the terminal frame replaces (`final: true`). `seq` is monotonic per run; `droppedCount` (when present) tells the client coalescing elided `n` prior deltas. Lives in a new `packages/gateway/src/operator-contract/output.ts`, re-exported from the barrel.
- **Explicit coalescing (not silent).** Under per-subscriber overflow, output deltas coalesce/drop, and the next output frame carries the cumulative `droppedCount` so the client can show elision live (origin decision revised after research: contract hygiene over silence). The `final: true` frame still guarantees completeness. Status frames keep their existing drop-the-subscriber overflow behavior; only output frames coalesce.
- **Engine-side ordering reorder.** Move the terminal `notifyObserverBestEffort(deps, terminalState)` in `run.ts` to **after** `resolveToAnswer`/`flush`, so the final `output` frame is pushed before the terminal status frame. Localized, keeps the manager observer-only. A characterization test proves Discord behavior is unchanged (Discord does not observe these frames, so the reorder is inert for it).
- **Content entry point `observeOutput(runId, text, opts)`** on the manager, alongside `observe(runState)`. It fans out an `output` frame to `runSubscribers.get(runId)` through the same `enqueueFrame` path, updates `latestOutputCache` only for the final frame, and is observer-only (no mutating run API — preserves rule 6). The web sink receives a **narrow `observeOutput` callback**, not the full manager (keeps the sink decoupled).
- **Construction-order wiring (shape 1).** Extend `createWebReplySink({ runId, observeOutput })`; add `runObservationManager: RunObservationManager` to `LaunchRouteDeps`; thread it through the `buildLaunchRoute` call in `web/server.ts`; at the launch site pass `{ runId, observeOutput: (text, opts) => manager.observeOutput(runId, text, opts) }`. The sink's `append` pushes a delta; `flush` (or a terminal hook) pushes the `final` frame.
- **Terminal-output snapshot cache.** `latestOutputCache: Map<runId, OperatorOutputFrame>` sibling to `latestStatusCache`, set on the final frame, cleared on the same teardown paths (`shutdown`, post-terminal cleanup). `subscribe` delivers it (after `ready`, after the cached status) so a late subscriber gets the answer. Derived projection, not a primary store.
- **Output as-is; repo-authz is the trust boundary.** No per-frame scrub; reuse run-core's visible-output discipline. The web SSE stream is a new *exposure* surface (browser-readable) but not a new *authz boundary* — parity with Discord for already-authorized operators.

## Open Questions

### Resolved During Planning

- Coalescing silent vs explicit? → **Explicit** (`seq` + `droppedCount`).
- Ordering mechanism? → **Engine-side reorder** of the terminal `notifyObserver` call.
- Closed-DTO tension? → **No exception needed** (output is sink-routed, not `RunState`-projected).
- Cache location? → in-memory `latestOutputCache` sibling to `latestStatusCache` in `manager.ts`.
- Sink↔manager wiring? → narrow `observeOutput` callback into `createWebReplySink`.

### Deferred to Implementation

- Whether a single `final` `output` frame can exceed the 64KB cap for a very large answer, and if so whether the manager chunks it or the sink pre-splits. (Likely chunk the final frame into ordered `output` deltas with the last carrying `final: true`; confirm against `enqueueFrame` byte accounting at implementation.)
- Exact coalescing strategy in the queue (merge adjacent text vs newest-wins-with-droppedCount) — pick against the real `enqueueFrame`/`drainQueue` shapes.
- Whether the terminal `output` frame and the terminal `status` frame need an explicit per-run drain barrier beyond the engine reorder (verify the reorder alone closes the race in the manager's async writer).

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
Run executes (executeWorkOnHeldSlot)
  agent text delta ──> request.replySink.append(text)
                          │  (web sink)
                          └─> observeOutput(runId, text)               ──> manager
                                                                            ├─ fanOut output frame {final:false, seq++}
                                                                            └─ per-subscriber enqueueFrame (64KB cap; coalesce + droppedCount on overflow)
Run completes
  finalText = replySink.buffered()
  statusSink.resolveToAnswer(finalText)
  replySink.flush()  ──> observeOutput(runId, finalText, {final:true}) ──> manager
                                                                            ├─ set latestOutputCache[runId]
                                                                            └─ fanOut output frame {final:true}      (BEFORE terminal status)
  notifyObserverBestEffort(deps, terminalState)  ◀── MOVED HERE (after flush) ──> manager.observe(terminal)
                                                                            ├─ fanOut status frame (terminal)
                                                                            └─ closeRunSubscribers + clear caches

Late subscriber connects after terminal:
  ready frame ──> cached status (latestStatusCache or reset) ──> cached final output (latestOutputCache) ──> close
```

## Implementation Units

- [x] **Unit 1: Output frame contract type + version bump**

**Goal:** Add the `output` frame type to the operator contract and bump the version.

**Requirements:** R8

**Dependencies:** None.

**Files:**
- Create: `packages/gateway/src/operator-contract/output.ts`
- Modify: `packages/gateway/src/operator-contract/index.ts` (re-export), `packages/gateway/src/operator-contract/version.ts` (`'1.2.0'` → `'1.3.0'`)
- Test: `packages/gateway/src/operator-contract/version.test.ts` (update the `1.2.0` assertion to `1.3.0`), `packages/gateway/src/operator-contract/output.test.ts` (new)

**Approach:** Define `OperatorOutputFrame { runId, text, final, seq, droppedCount? }` (readonly fields) mirroring the `run-status.ts` file shape. Bump the version constant per the MINOR policy.

**Patterns to follow:** `run-status.ts`/`approval.ts` file shape; the barrel re-export pattern in `index.ts`.

**Test scenarios:**
- Happy path: the type's required fields are present; `version.test.ts` pins `'1.3.0'`.
- Edge: `droppedCount` is optional (a frame without it is valid).

**Verification:** Contract barrel exports `OperatorOutputFrame`; `version.test.ts` green at `1.3.0`.

- [x] **Unit 2: Manager `output` frame + `observeOutput` + terminal-output cache**

**Goal:** Extend the manager's closed union with an `output` frame, add the `observeOutput` entry point, the `latestOutputCache`, explicit coalescing, and snapshot-on-subscribe for the cached final output.

**Requirements:** R1, R3, R4, R5

**Dependencies:** Unit 1.

**Files:**
- Modify: `packages/gateway/src/web/sse/manager.ts`
- Test: `packages/gateway/src/web/sse/manager.test.ts`

**Approach:** Add `OutputFrame` to `ObservationFrame` (the `writeFrame` exhaustiveness guard in Unit 3 forces handling). Add `observeOutput(runId, text, opts?: { final?: boolean; droppedCount? })` to the manager interface and implementation: build the `output` frame with a per-run monotonic `seq`, fan out via the existing `enqueueFrame` path. On per-subscriber overflow for an output frame, **coalesce** (do not drop the subscriber): merge/drop pending output and accumulate `droppedCount` onto the next output frame for that subscriber, keeping the connection alive (status-frame overflow keeps its existing drop behavior). On `final: true`, set `latestOutputCache.set(runId, frame)`. Extend `subscribe` snapshot delivery to also emit the cached final output (after `ready` is handled by the route, after the cached status). Clear `latestOutputCache` on the same teardown paths as `latestStatusCache` (terminal cleanup, `shutdown`). Keep the manager observer-only — no mutating run API added.

**Execution note:** Test-first — the backpressure/coalescing and observer-only invariants are load-bearing; pin them before implementing.

**Patterns to follow:** `latestStatusCache` lifecycle (`:239,489,503,602`); `enqueueFrame` byte accounting (`:303-331`); the `collectFrames`/`drain()` test harness; the existing backpressure (`:354`) and observer-only-invariant (`:717`) test blocks.

**Test scenarios:**
- Happy path: `observeOutput(runId, 'hello')` fans an `output` frame `{final:false, seq:0}` to a subscriber; a second call increments `seq`.
- Happy path (final): `observeOutput(runId, 'full answer', {final:true})` sets the cache and fans a `final:true` frame.
- R3 (late subscriber): a subscriber connecting after the final frame receives the cached final `output` frame on subscribe.
- R5 (coalescing): a slow/overflowing subscriber's output frames coalesce — the connection stays alive and a later frame carries `droppedCount > 0`; a fast subscriber on the same run is unaffected (independent queues).
- R5 (status overflow unchanged): a status-frame overflow still drops that subscriber (regression).
- Edge (empty): `observeOutput(runId, '', {final:true})` produces a terminal output frame with empty text (R4 backstop).
- Observer-only invariant: the manager deps type still has no mutating run API (extend the existing compile-time + behavioral assertion).

**Verification:** `output` frames fan out and coalesce as specified; `latestOutputCache` delivers to late subscribers; observer-only invariant holds; manager tests green.

- [x] **Unit 3: Run-stream route `output` SSE event mapping**

**Goal:** Map the `output` frame to a named SSE event on the wire.

**Requirements:** R1, R8

**Dependencies:** Unit 2.

**Files:**
- Modify: `packages/gateway/src/web/sse/run-stream-route.ts`
- Test: `packages/gateway/src/web/sse/run-stream-route.test.ts`

**Approach:** Add an `output` branch to `writeFrame` (`event: 'output', data: JSON.stringify({ runId, text, final, seq, droppedCount })`), satisfying the exhaustiveness `never` guard. The `ready` frame stays the always-first frame (do not regress). No new gates — output rides the existing auth/lease/cap path.

**Patterns to follow:** the existing `status`/`reset` branches in `writeFrame`; the no-oracle assertion style.

**Test scenarios:**
- Happy path: an `output` frame is written as `event: 'output'` with the JSON payload.
- Ordering: `ready` is still the first frame emitted, before any cached output replay.
- Exhaustiveness: the `never` guard compiles (a missing branch would fail typecheck).

**Verification:** `output` frames reach the wire as `event: 'output'`; `ready`-first preserved; route tests green.

- [x] **Unit 4: Wire the web ReplySink to push output (construction-order)**

**Goal:** Make `createWebReplySink` push deltas + the final answer through `observeOutput`, and thread the manager into the launch route.

**Requirements:** R1, R2, R7

**Dependencies:** Unit 2.

**Files:**
- Modify: `packages/gateway/src/web/operator/web-sinks.ts` (`createWebReplySink` signature + `append`/`flush`), `packages/gateway/src/web/operator/launch-route.ts` (`LaunchRouteDeps` + the sink construction), `packages/gateway/src/web/server.ts` (thread `runObservationManager` into the `buildLaunchRoute` call)
- Test: `packages/gateway/src/web/operator/web-sinks.test.ts`, `packages/gateway/src/web/operator/launch-route.test.ts`

**Approach:** Change `createWebReplySink()` → `createWebReplySink({ runId, observeOutput })` where `observeOutput: (text, opts?) => void`. `append(text)` pushes a delta (`observeOutput(text)`); `flush()` pushes the final answer (`observeOutput(buffered(), { final: true })`) and stays otherwise a no-op for the HTTP response. Add `runObservationManager` to `LaunchRouteDeps`; thread it through `web/server.ts:671-698`; at `launch-route.ts:342` pass `createWebReplySink({ runId, observeOutput: (text, opts) => deps.runObservationManager.observeOutput(runId, text, opts) })`. The sink stays decoupled from the full manager (narrow callback only).

**Test scenarios:**
- Happy path: `append('a')` then `append('b')` invokes `observeOutput` twice with the delta text; `flush()` invokes it once with `{final:true}` carrying the buffered answer.
- Edge (empty): `flush()` with an empty buffer still invokes `observeOutput('', {final:true})` (R4).
- Integration: the launch route constructs the sink with a working `observeOutput` bound to the threaded manager + the route's runId (assert the captured sink pushes to the manager spy).

**Verification:** the web sink pushes deltas + final answer to the manager; the launch route wires the manager + runId; Discord launch path untouched (its sink is a different construction).

- [x] **Unit 5: Engine-side ordering reorder**

**Goal:** Ensure the final `output` frame is delivered before the terminal status frame by reordering the terminal observer notification after the final answer flush.

**Requirements:** R2, R7

**Dependencies:** Unit 4.

**Files:**
- Modify: `packages/gateway/src/execute/run.ts`
- Test: `packages/gateway/src/execute/run.test.ts`

**Approach:** Move `notifyObserverBestEffort(deps, completedResult.data.state)` (currently `:632`) to **after** `resolveToAnswer`/`flush` (`:640-644`), and the FAILED equivalent (`:698`) to after its flush (`:703`). This guarantees the web sink's `flush()` → final `output` frame is pushed before `observe(terminalState)` fans the terminal status (which closes subscribers). Verify the reorder is inert for Discord (Discord does not observe these frames; its `flush` posts to the thread independently).

**Execution note:** Characterization-first — capture current Discord run completion + reply behavior before the reorder, so R7 zero-regression is provable.

**Test scenarios:**
- R2 (ordering): for a web run, the final `output` frame is observed before the terminal `status` frame (assert frame order via the manager harness or an observer spy ordering).
- R7 (Discord unchanged): a successful Discord run still completes and posts its output; the reorder does not change Discord reply behavior (characterization test).
- Edge (failure path): a FAILED run flushes partial output (final `output` frame) before the terminal failed status.

**Verification:** terminal output precedes terminal status for web runs; Discord behavior byte-identical; run tests green.

- [x] **Unit 6: Docs refresh**

**Goal:** Update the SSE solution doc and operator-contract notes to reflect the new `output` frame, and document the lease foot-gun.

**Requirements:** R6, R8 (read-side closure)

**Dependencies:** Units 1-5.

**Files:**
- Modify: `docs/solutions/best-practices/authenticated-sse-run-observation-2026-06-20.md` (note the `output` frame as an additive frame type under the closed-union/contract rules), `packages/gateway/AGENTS.md` if it documents the operator frame set.

**Approach:** Add a short note that the `output` frame is sink-routed (not `RunState`-projected), rides the same lease, and that streaming sensitive content later must tighten the lease (the rule-8 foot-gun). Ancillary cleanup, not requirement-bearing.

**Test scenarios:** Test expectation: none — docs only.

**Verification:** the SSE doc reflects the `output` frame and the lease caveat.

## System-Wide Impact

- **Interaction graph:** the web `ReplySink.append`/`flush` now call into the manager's `observeOutput`; `run.ts` terminal-observer reorder affects both transports' call order (inert for Discord). The run-stream route gains an `output` event.
- **Error propagation:** `observeOutput` is best-effort/fail-soft (a fan-out failure warns, never throws into the run); the auth/lease boundary stays fail-closed. The web sink's `flush` must not reject into the run (foot-gun: a sink `send` that can reject needs a `.catch`).
- **State lifecycle risks:** `latestOutputCache` must be cleared on every teardown path that clears `latestStatusCache` (terminal, shutdown) or it leaks per-run final answers.
- **API surface parity:** Discord already delivers output via its sink; this brings the web sink to parity without touching Discord.
- **Integration coverage:** the launch-route → sink → manager → route wiring is the cross-layer chain (Unit 4 integration scenario); the ordering reorder is the run.ts → manager chain (Unit 5).
- **Unchanged invariants:** the `RunState` projection (closed-DTO rule 5) is unchanged — output is a new frame type, not a new projected field; the manager stays observer-only; the no-oracle denial shape and the per-operator stream cap are unchanged; Discord behavior is unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Terminal status races ahead of the final answer (the core bug) | Engine-side reorder (Unit 5) + ordering test (R2); the final frame is enqueued before `observe(terminalState)` fans the terminal status. |
| Reorder regresses Discord | Characterization-first test (Unit 5); the reorder is inert because Discord does not observe these frames. |
| Late subscriber sees `succeeded` with no answer | `latestOutputCache` snapshot delivered on subscribe (Unit 2, R3). |
| Output overflow drops the connection / loses text silently | Coalesce-keep-alive with `seq`+`droppedCount` (Unit 2, R5); final frame backstops completeness. |
| `latestOutputCache` leaks per-run answers | Cleared on the same teardown paths as `latestStatusCache` (Unit 2); test the teardown. |
| Sensitive output rides the ~6m-class lease window | Accepted for current sink-routed visible text; in-code foot-gun comment + doc note (Unit 6) that file/secret output must tighten the lease. |
| A very large final answer exceeds the 64KB cap | Deferred-to-implementation: chunk the final frame into ordered deltas with the last `final:true`; confirm against `enqueueFrame` accounting. |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-20-stream-web-run-output-requirements.md](../brainstorms/2026-06-20-stream-web-run-output-requirements.md)
- Related: `docs/solutions/best-practices/authenticated-sse-run-observation-2026-06-20.md` (the 10-rule checklist), `docs/solutions/best-practices/web-operator-launch-surface-2026-06-20.md` (names #965 as deferred), `docs/solutions/best-practices/gateway-control-surface-spine-2026-06-15.md` (sinks-over-transport), `docs/solutions/best-practices/atomic-serial-channel-queue-handoff-2026-06-09.md` (FIFO/ordering).
- Issue: #965 (advances #907).
