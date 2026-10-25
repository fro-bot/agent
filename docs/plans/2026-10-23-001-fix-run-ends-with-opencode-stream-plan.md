---
title: "fix: a gateway run ends with its OpenCode stream"
type: fix
status: active
date: 2026-10-23
origin: docs/brainstorms/2026-10-23-opencode-process-lifecycle-requirements.md
---

# fix: a gateway run ends with its OpenCode stream

## Overview

A gateway run whose OpenCode event stream ends, errors, or goes silent reaches `failed` within about a minute, in every run state. The failure goes through the existing termination barrier. Stranded run records are swept while the gateway runs. Terminal-state writes retry briefly, and the failure reply no longer depends on the write.

## Problem Frame

When OpenCode died mid-run, the run stayed `running` until the operator cancelled it (#1922). There are no logs, so the cause is unconfirmed. Any of these gaps can produce that outcome:

- the proxy never closes the downstream when the upstream dies;
- the SDK reconnects silently;
- the inactivity timer pauses during drain and human waits;
- terminal-write failures are only logged;
- stale-run recovery runs only at startup.

See origin: `docs/brainstorms/2026-10-23-opencode-process-lifecycle-requirements.md`.

## Requirements Trace

- R1. A run fails within about a minute of its stream ending, erroring, or going about 30s silent, in every state.
- R2. No run continues across a stream interruption.
- R3. The proxy closes the downstream when the upstream is lost, and the upstream when a streaming client disconnects.
- R4. A stream loss goes through the existing termination barrier.
- R5. Pending approval and question prompts resolve as "run ended".
- R6. The failure reply posts even when the terminal write fails.
- R7. An executing record with no live owner reaches a terminal state within 5 minutes. Queued runs are untouched.
- R8. Reconciliation never releases a lock or reservation.
- R9. Terminal writes retry briefly, then hand off to R7.
- R10. While a run waits on its completion gate, the operator sees why it has not finished.

## Scope Boundaries

The following are out of scope:

- resuming an interrupted run;
- tracking or killing orphaned tool processes (an accepted, unsupported case per the origin doc);
- OpenCode instance identity;
- recycling OpenCode for memory (#1923);
- `degraded` recovery;
- the inactivity and wall-clock defaults;
- the GitHub Action;
- a new operator failure kind. Every new failure uses `stream-ended`.
- surfacing the wait reason in Discord or the dashboard UI. R10 covers the operator API only. The dashboard consumes it in its own repo.

### Deferred to Separate Tasks

- Events missed between `promptAsync` and the lazy event subscription. File an issue.

## Context & Research

### Relevant Code and Patterns

- **Proxy:** `apps/workspace-agent/src/opencode-proxy.ts`.
  - The upstream response handler never tears down `res` on `close` or `error`.
  - No `res` close handler destroys the upstream request.
- **Event loop:** `packages/gateway/src/execute/run-core.ts`.
  - `event.subscribe` and `makeAbortableStream`.
  - The inactivity timer and its pause guard, `resetInactivity`.
  - The post-loop classification.
  - `throwWithBarrier` with `rootMayBeRunning`.
  - `onHumanWaitTerminal`.
- **Timer primitive:** `packages/runtime/src/agent/inactivity-timer.ts` (`createInactivityTimer`).
- **SDK SSE options at the pinned v1.19.0:** `sseMaxRetryAttempts` and `onSseError`. With a maximum of 1, the first failure calls `onSseError` and then ends the iterator cleanly.
- **OpenCode server events:** it sends `server.connected` first, then `server.heartbeat` every 10s.
- **Barrier:** `packages/gateway/src/execute/settle-owned-sessions.ts`.
- **Run lifecycle:** `packages/gateway/src/execute/run.ts`.
  - The `transitionTerminal` closure.
  - Failure-reply selection.
  - The `abortRegistry` register and delete.
- **Maintenance runs:** `packages/gateway/src/discord/maintenance-run.ts`. They heartbeat but are not in `abortRegistry`.
- **Retry helper:** `packages/gateway/src/execute/stale-etag-transition.ts` (`transitionRetryingStaleEtag`).
- **Recovery:** `packages/gateway/src/execute/recovery.ts` (`recoverStaleRuns`, `recoverOneRun`).
  - It is called from `packages/gateway/src/program.ts` at startup.
  - The interval pattern to follow is `sessionMaintenanceInterval` in the same file.
- **Completion gate:** `packages/gateway/src/execute/drain-completion.ts`. `reject(reason)` logs one code per declined attempt, for example `root-live`, `notice-not-observed`, `ledger-not-drained` and `idle-evidence-stale`. Today these appear only at debug level.
- **Status overlays:** `packages/gateway/src/web/sse/projection.ts` overlays `waiting_for_approval` and `waiting_for_question` on a `running` run from in-memory registries. `packages/gateway/src/operator-contract/run-status.ts` and `run-summary.ts` hold the wire types. `packages/gateway/src/operator-contract/version.ts` keeps the contract history.
- **Stale predicate:** `packages/runtime/src/coordination/run-state.ts` (`isRunStale`, `findStaleRuns`). An EXECUTING run is stale after a 60s heartbeat gap.

### Institutional Learnings

- `docs/solutions/logic-errors/gateway-root-not-aborted-on-early-stop-2026-10-22.md`: every early stop uses the barrier.
- `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md`: EOF without idle is a failure.
- `docs/solutions/logic-errors/bound-and-guard-every-reconcile-pass-2026-10-22.md`: bound periodic passes and dispose them on every exit.
- `docs/solutions/logic-errors/abortsignal-any-reason-classification-race-2026-07-03.md`: classify a timer by its own `signal.aborted`.
- `docs/solutions/logic-errors/terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md`: a retry never replaces an accepted outcome.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "fro-bot/agent monorepo @ main: apps/workspace-agent/src, packages/gateway/src/execute, packages/runtime/src/{agent,coordination}, deploy/",
  "freshness": {
    "vcs_reference": "8c8be73287a61a0cd55a9c6183abfcc56a9a8542"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 17,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "packages/runtime/src/agent/inactivity-timer.ts#createInactivityTimer",
      "description": "Resettable abort-timer primitive: reset/pause/resume/dispose, stable signal identity.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "packages/gateway/src/execute/run-core.ts#inactivityTimer/resetInactivity",
      "description": "Run-level activity watchdog, paused while draining or while human waits are outstanding; ignores server.heartbeat.",
      "disposition": "extend",
      "insufficiency_reason": "Paused in the states R1 covers; a second never-paused timer is added beside it."
    },
    {
      "path_or_symbol": "packages/gateway/src/execute/run-core.ts#makeAbortableStream",
      "description": "Races each stream read against the abort signal.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "packages/gateway/src/execute/run-core.ts#throwWithBarrier + settle-owned-sessions.ts#settleOwnedSessions",
      "description": "Termination barrier: abort root, confirm via session.status within 15s, else quarantine. Stream loss reuses it unchanged.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "apps/workspace-agent/src/opencode-server.ts#runSupervisedOpencode/statusRef",
      "description": "Owns spawn, exit handling, backoff, respawn and the shared status ref.",
      "disposition": "insufficient",
      "insufficiency_reason": "Instance identity was dropped from scope; not changed."
    },
    {
      "path_or_symbol": "apps/workspace-agent/src/server.ts#GET /readyz + packages/gateway/src/workspace-api/client.ts#readyz",
      "description": "Readiness {ready, opencode}, read once per run at admission.",
      "disposition": "insufficient",
      "insufficiency_reason": "Instance identity was dropped from scope; not changed."
    },
    {
      "path_or_symbol": "packages/gateway/src/execute/recovery.ts#recoverStaleRuns/recoverOneRun",
      "description": "Terminalizes stale runs once at startup, ETag-conditional, gated on repo quiescence, never deletes locks.",
      "disposition": "extend",
      "insufficiency_reason": "Startup-only, quiescence-gated record write, no owned-run skip, startup-specific note."
    },
    {
      "path_or_symbol": "packages/runtime/src/coordination/run-state.ts#isRunStale/findStaleRuns",
      "description": "Stale predicate and repo run scan.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "packages/runtime/src/coordination/heartbeat.ts + lease-loop.ts",
      "description": "Run and lock heartbeat; store liveness only.",
      "disposition": "insufficient",
      "insufficiency_reason": "Independent of OpenCode health; a stuck run keeps heartbeating."
    },
    {
      "path_or_symbol": "packages/gateway/src/execute/repo-quiescence.ts#createRepoQuiescenceChecker",
      "description": "Point-in-time session.status read per repo directory.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "packages/gateway/src/execute/abort-registry.ts#abortRegistry",
      "description": "runId to AbortController registry; registered after EXECUTING, deleted after terminal-write attempts.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "packages/gateway/src/execute/stale-etag-transition.ts#transitionRetryingStaleEtag",
      "description": "Re-read once and retry the terminal write once with the stored ETag.",
      "disposition": "extend",
      "insufficiency_reason": "Single retry, no delay, used only after a failed heartbeat stop."
    },
    {
      "path_or_symbol": "apps/workspace-agent/src/git-stream.ts#killProcessGroup/ensureConfirmedClose",
      "description": "SIGTERM, grace, SIGKILL, confirm for one child's process group.",
      "disposition": "insufficient",
      "insufficiency_reason": "Reaping is out of scope; pgid-only reach would miss detached tool children."
    },
    {
      "path_or_symbol": "deploy/workspace.Dockerfile tini entrypoint",
      "description": "tini reaps zombie orphans.",
      "disposition": "insufficient",
      "insufficiency_reason": "Never signals or reports on live orphans."
    },
    {
      "path_or_symbol": "packages/runtime/src/agent/ledger-reconcile.ts",
      "description": "Per-run reconciliation of owned child sessions.",
      "disposition": "insufficient",
      "insufficiency_reason": "Blind to instance replacement and stream health."
    },
    {
      "path_or_symbol": "packages/gateway/src/operator-contract/run-status.ts#toOperatorRunStatus",
      "description": "Read-only stale projection.",
      "disposition": "insufficient",
      "insufficiency_reason": "Display only."
    },
    {
      "path_or_symbol": "apps/workspace-agent/src/opencode-proxy.ts#createOpencodeProxy",
      "description": "Authenticated pass-through with a non-SSE inactivity timer.",
      "disposition": "extend",
      "insufficiency_reason": "Does not close the downstream on upstream death, nor the upstream on downstream disconnect."
    }
  ],
  "excluded_scopes": []
}
```

## Key Technical Decisions

- **Refuse reconnect in the SDK.**
  - Pass `sseMaxRetryAttempts: 1`, and capture the cause through `onSseError` for the log and error cause.
  - Any transport failure then takes the existing premature-end path.
- **Add a second watchdog that never pauses.**
  - It resets on every raw event, heartbeats included, and is armed at loop start.
  - It is classified by its own signal and wins over the drain, inactivity and wall-clock branches.
  - It fails through `throwWithBarrier('stream-ended', …, {rootMayBeRunning: true})`.
  - It is an opt-in `RunCoreParams` value, set to 30s by `run.ts`. Existing silent-stream tests under fake timers keep their outcomes. There is no config knob.
- **Reuse the existing barrier.** A stream loss gets no new lock rule.
- **Settle human waits.** On stream failure, pending gates settle through the same teardown path that cancel and timeout use.
- **Terminal writes.**
  - `transitionRetryingStaleEtag` gains `attempts`, a delay between attempts, and a per-attempt bound. Its default stays at today's single retry.
  - `transitionTerminal` passes 3 attempts, with waits of 0.5s and then 1s between them.
  - A retry never overwrites a stored terminal record or a record for another run.
  - The failure reply posts whatever the write result.
- **Sweep.**
  - `recoverStaleRuns` gains options: a phase filter, an `isOwned` predicate, a quiescence-gate switch, and the note text.
  - The sweep reads EXECUTING records only. It skips runs in `abortRegistry` and in-flight maintenance runs, and skips the quiescence gate. Swept records keep recovery's existing failure details. It never touches locks.
  - It runs on an unref'd 60s interval with its first tick one interval after start. A new pass does not start while one is running, and each pass is bounded. The interval is cleared at shutdown.
- **Time bound.** About 30s of detection, plus a barrier of up to 15s, plus a heartbeat stop of up to 5s, plus the bounded write retries, gives about a minute.
- **The wait reason is an in-memory overlay, not a stored field.**
  - The completion gate records its latest rejection code and when it was first seen in a per-run in-process map. The map clears on admission and on run exit.
  - The operator run status gains an optional `waitReason`, taken from an allowlist of codes and never from raw text. It appears only on a `running` run that is draining, and the approval and question overlays take precedence.
  - Keeping it in memory avoids an object-store write per declined attempt.
  - The change is additive, so the operator contract gets a minor version bump.
- **Single gateway replica assumed.** Heartbeat staleness and the in-process owned set are the guards.

## Open Questions

### Resolved During Planning

- **Lock handling after a stream loss:** use the existing barrier, with no new hold.
- **Sweep phases:** EXECUTING only.

### Deferred to Implementation

- Which existing path settles pending gates on cancel or timeout.
- The per-pass sweep bound, and whether `findStaleRuns` needs a read cap. Measure object counts first.
- How maintenance runs expose their in-flight run ids to the sweep (a shared set or registration).
- Whether the operator status groups the raw gate codes into fewer wire values. For example, `root-live` and `root-liveness-unavailable` could both read as "agent still working".

## Implementation Units

- [ ] **Unit 1: Proxy closes both directions**

**Goal:** When the upstream dies mid-response, the downstream closes. When an SSE client disconnects, the upstream closes.

**Requirements:** R3

**Dependencies:** None

**Files:**

- Modify: `apps/workspace-agent/src/opencode-proxy.ts`, `apps/workspace-agent/AGENTS.md`
- Test: `apps/workspace-agent/src/opencode-proxy.test.ts`

**Approach:**

- On the upstream response, `close` without completion, or `error`, destroys `res`. A response that completes is unchanged.
- For SSE responses only, a `res` close before finish destroys the upstream request.

**Execution note:** Test-first against real `http` servers. The upstream writes headers and one chunk, then destroys its socket.

**Test scenarios:**

- Error path: the upstream SSE socket is destroyed after headers and one chunk. The downstream closes within a short bound.
- Error path: the upstream non-SSE body is destroyed mid-body. The downstream closes and does not hang.
- Happy path: a completed non-SSE response arrives whole.
- Integration: an SSE client disconnects. The upstream `/event` connection closes within a short bound.
- Edge case: a non-SSE client disconnects. The new handler does not destroy the upstream request.

**Verification:** New tests fail on the old code. Existing proxy suites pass.

- [ ] **Unit 2: Event stream refuses reconnect and watches for silence**

**Goal:** Any stream end, error, or 30s of silence ends the event loop in every state, through the barrier. Pending human waits end with it.

**Requirements:** R1, R2, R4, R5

**Dependencies:** None

**Files:**

- Modify: `packages/gateway/src/execute/run-core.ts`, `packages/gateway/src/execute/run.ts`, `packages/gateway/AGENTS.md`, `docs/wiki/Execution Lifecycle.md`, `docs/wiki/Troubleshooting.md`
- Test: `packages/gateway/src/execute/run-core.stream-silence.test.ts` (new), `packages/gateway/src/execute/run-core.root-abort.test.ts`

**Approach:**

- Subscribe with `sseMaxRetryAttempts: 1` and an `onSseError` that records the cause.
- A second `server.connected` on one stream counts as a stream loss.
- An optional `streamSilenceTimeoutMs` adds a second inactivity timer. It starts at loop start, resets on every raw event before type dispatch, and never pauses. Its firing is classified first and fails through `throwWithBarrier`. It is disposed in the loop `finally` and at success. `run.ts` sets it to 30s.
- Pending approval and question gates settle as "run ended" on stream failure.

**Execution note:** Test-first with the controlled-stream fake-timer helpers.

**Test scenarios:**

- Happy path: heartbeats every 10s during drain do not trip the watchdog.
- Error path: 30s of silence during drain ends the run as `stream-ended` through the barrier.
- Error path: 30s of silence during an approval wait ends the run, and the gate resolves as "run ended". A late button press has no effect.
- Error path: the stream errors. The cause is captured, there is no second subscribe attempt, and the run ends as `stream-ended`.
- Error path: a second `server.connected` ends the run as `stream-ended`.
- Edge case: when silence and the wall clock fire together, the run is classified as silence.
- Edge case: a run that completes before 30s of silence stays COMPLETED.
- Edge case: when `streamSilenceTimeoutMs` is unset, behaviour is unchanged.

**Verification:** New tests fail on the old code. No existing run-core test changes outcome.

- [ ] **Unit 3: Terminal writes retry, and the reply does not depend on them**

**Goal:** Terminal writes retry briefly, and the failure reply posts even when the write fails.

**Requirements:** R6, R9

**Dependencies:** None

**Files:**

- Modify: `packages/gateway/src/execute/stale-etag-transition.ts`, `packages/gateway/src/execute/run.ts`, `packages/gateway/src/discord/maintenance-run.ts`
- Test: `packages/gateway/src/execute/stale-etag-transition.test.ts`, `packages/gateway/src/execute/run.lifecycle.test.ts`, `packages/gateway/src/execute/run.cancel.test.ts`

**Approach:**

- Extend the helper as described in Key Technical Decisions. Every terminal phase in `transitionTerminal` uses 3 attempts. Maintenance runs adopt the same arguments.
- The failure reply dispatches whatever the write result. After the final failure, log at error level.
- Tests that pin today's no-retry and no-reply behaviour change, and are named in the commit.

**Test scenarios:**

- Happy path: the first write fails and the second succeeds.
- Error path: all attempts fail. The reply has posted, the error is logged, and the record stays EXECUTING.
- Edge case: the stored record is already terminal. There is no retry and no overwrite.
- Edge case: a stalled attempt is bounded, and the whole retry stays within its budget.

**Verification:** Updated suites pass. Revert-checks fail the new tests.

- [ ] **Unit 4: Periodic stranded-run sweep**

**Goal:** EXECUTING records with no live owner reach FAILED within 5 minutes while the gateway runs.

**Requirements:** R7, R8

**Dependencies:** Unit 3 completes AE4. The sweep itself does not depend on it.

**Files:**

- Modify: `packages/gateway/src/execute/recovery.ts`, `packages/gateway/src/program.ts`, `packages/gateway/src/discord/maintenance-run.ts`, `packages/gateway/AGENTS.md`, `ARCHITECTURE.md`, `docs/wiki/Execution Lifecycle.md`
- Test: `packages/gateway/src/execute/recovery.test.ts`, `packages/gateway/src/execute/recovery.composed.test.ts`, `packages/gateway/src/program.test.ts`

**Approach:** As described in Key Technical Decisions. The startup call keeps today's behaviour. The sweep note text must not contradict a reply that has already posted.

**Test scenarios:**

- Happy path: a stale, unowned EXECUTING run becomes FAILED, and the note posts.
- Edge case: a stale run in `abortRegistry` is skipped.
- Edge case: an in-flight maintenance run with a stale heartbeat is skipped.
- Edge case: a stale PENDING run is not touched by the sweep.
- Edge case: a busy workspace does not block the record write, and no lock is released.
- Error path: a heartbeat lands between the read and the write. The ETag compare-and-swap skips the run.
- Integration: passes never overlap, and the interval is cleared at shutdown.

**Verification:** Recovery and program suites pass. Startup recovery tests are unchanged.

- [ ] **Unit 5: Operator-visible completion-gate wait reason**

**Goal:** While a run drains, the operator status says why the completion gate has not admitted it yet.

**Requirements:** R10

**Dependencies:** None

**Files:**

- Modify: `packages/gateway/src/execute/drain-completion.ts`, `packages/gateway/src/execute/run-core.ts`, `packages/gateway/src/web/sse/projection.ts`, `packages/gateway/src/operator-contract/run-status.ts`, `packages/gateway/src/operator-contract/version.ts`, `packages/gateway/AGENTS.md`, `docs/wiki/Operator Web Control Surface.md`
- Test: `packages/gateway/src/execute/drain-completion.test.ts`, `packages/gateway/src/web/sse/projection.test.ts`, `packages/gateway/src/operator-contract/run-status.test.ts`, `packages/gateway/src/operator-contract/version.test.ts`, `packages/gateway/src/web/sse/manager.test.ts`

**Approach:**

- `reject()` reports its code through an injected callback. run-core records it per run in an in-process map and clears it on admission and in the loop `finally`.
- The projection adds `waitReason` to a `running` status only when an entry exists and no approval or question overlay applies. The value is allowlisted.
- Live SSE status frames update when the reason changes. Repeats of the same code send nothing.
- The contract version and history get an additive entry, and the pinned version tests are updated.

**Patterns to follow:** The `waiting_for_question` overlay (contract 1.9.0/1.11.0) and its registry predicates in `projection.ts`.

**Test scenarios:**

- Happy path: a draining run with an unfenced child projects `waitReason: notice-not-observed`. Once admitted, the field is gone.
- Edge case: when a pending approval and a wait reason coexist, the approval overlay wins and no `waitReason` is shown.
- Edge case: the same reason repeating produces no new SSE frame. A changed reason produces one.
- Edge case: an unknown code never reaches the wire.
- Edge case: a terminal run carries no `waitReason`.

**Verification:** Contract and projection suites pass with the bumped version. Revert-checks fail the new tests.

## System-Wide Impact

- **Interaction graph:** the proxy; the run-core stream loop; the barrier; `run.ts` terminal paths and replies; the approval and question gates; recovery; the program lifecycle.
- **Error propagation:** new failures surface as `stream-ended`.
- **API surface parity:** the operator contract gains an optional `waitReason` (additive minor bump). The dashboard adopts it separately.
- **State lifecycle risks:** a terminal-write retry and the sweep can race. The ETag compare-and-swap resolves it.
- **Unchanged invariants:** lock takeover; quarantine semantics; the 5- and 30-minute defaults; startup recovery; the `/readyz` shape.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Heartbeats stall under memory pressure and fail a healthy run | 30s means three missed heartbeats. Log the largest gap between events per run. |
| One OpenCode restart fails every in-flight run | Intended. |
| The sweep reads every run object per repo each minute | Bound each pass, measure object counts, and cap reads if needed. |
| An orphaned tool command collides with the next run on the same repo | Accepted. It shows up as a dirty checkout, and auto-recovery handles it. |

## Phased Delivery

1. **PR A:** Unit 1 (workspace-agent only).
2. **PR B:** Unit 2.
3. **PR C:** Units 3 and 4. They do not depend on PR B.
4. **PR D:** Unit 5. Independent of the others.

Docs ship inside each unit. Only one PR is in the merge path at a time.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-10-23-opencode-process-lifecycle-requirements.md](../brainstorms/2026-10-23-opencode-process-lifecycle-requirements.md)
- Related issues: #1922, #1923
