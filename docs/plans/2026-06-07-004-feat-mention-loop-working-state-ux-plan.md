---
title: "feat: Mention-loop working-state UX (live status + typing)"
type: feat
status: active
date: 2026-06-07
origin: docs/brainstorms/2026-06-07-mention-loop-production-ready-requirements.md
deepened: 2026-06-07
---

# feat: Mention-loop working-state UX (live status + typing)

## Overview

Phase 2 of the production-ready `@Fro Bot` Discord mention loop. Phase 1 (clean rendering + persona, shipped in #831) made the *final* output read well; this phase makes the *waiting* read well. Today a mention runs silently until the final answer lands — on a long task the user has no signal the agent is alive. This adds a single live status message that updates on a rate-limit-safe cadence with Phase-1 action summaries, plus a Discord typing indicator pulsed while the session is busy. A deploy-wide setting can drop the status message for a quieter typing-only experience. The status message is replaced by the clean final answer when the run completes, or edited into a terse persona-voice failure note when it fails.

## Problem Frame

`packages/gateway/src/execute/run.ts` creates the thread, feeds a `DiscordStreamSink`, and flushes one final message at the end (`sink.flush()` at COMPLETED, coarse `safeSend` on failure). Between thread creation and that final flush, nothing is posted: the sink only appends + flushes (confirmed — no edit surface), `session.status` (busy/idle) is never observed, and no typing indicator is ever sent. For a multi-step coding task that can run minutes, the thread looks dead. The brainstorm (origin: working-state UX section) specifies a single editable status message + typing as the fix, with a typing-only mode for deployments that want minimal chatter.

## Requirements Trace

- R1. During a longer run, the user sees a single status message that updates as the agent works (default mode), never a wall of progress posts (origin SC4).
- R2. The status message is **replaced by** the clean final answer on completion — one clean thread message for short answers (origin: final-answer transition).
- R3. A typing indicator is shown only while the session is actually working and is cleared on idle/abort and **paused during an approval wait** so it never sticks or falsely implies active work (origin working-state UX).
- R4. A deploy-wide setting (`GATEWAY_STATUS_MODE`) selects `live-status` (default) or `typing-only`; typing-only suppresses the status message entirely (origin OQ1, configurability).
- R5. A failed/timed-out/aborted run reads as a terse failure note in Fro Bot's voice, not a raw error/tool dump; the status message transitions into that note (origin: failure presentation interaction state).
- R6. Status updates are debounced to stay within Discord edit rate limits — one edited message, not per-token (origin OQ2).

## Scope Boundaries

- Not changing the rendering/summary layer (`format-part.ts`) — it is the content source, consumed as-is.
- Not changing the `DiscordStreamSink` into an edit surface — the status controller is a separate component; the sink stays append-only.
- Not adding per-channel status configuration — deploy-wide only (origin OQ1 lean).
- Not adding the optional Kimaki-style footer (duration · model · context%) — deferred (origin OQ6).
- Not adding an expandable full action trace — collapsed essential summaries are the v1 surface (origin OQ7).

### Deferred to Separate Tasks

- **Serial per-channel queue + `/clear-queue`** (origin Phase 3): the queued-task acknowledgement interaction state is owned there, not here.
- **`/sessions` / `/resume` / `/force-release-lock` commands** (origin Phase 4).
- **Native approval-button UX polish** (origin Phase 4): showing the permission prompt *in* the status message, and richer approval-state thread UX. v1 here does the minimum correctness step — **pause typing while an approval is pending** (`setBusy(false)`) so the indicator doesn't falsely imply active work — but does not build any approval-state status UX.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/discord/streaming.ts` — `createDiscordStreamSink()`: `append()`/`flush()`/`buffered()` + the `pendingVisibleOutput`/`markVisibleOutputPending`/`hasVisibleOutput` visible-output-race machinery. Append-only; no `.edit()`. The status controller must coordinate with `hasVisibleOutput()` so a status message counts (or is excluded) correctly for the no-output fallback.
- `packages/gateway/src/execute/run.ts` — thread creation (`message.startThread` → `SinkThread`), sink construction, the run lifecycle (acquire lock → run-core → COMPLETED `sink.flush()` → failure `safeSend`), and the inner `finally` that disposes the coordinator. The status controller is created here (per-run, after thread creation) and torn down in the same `finally`. **Prior art for editing a posted message:** the approval embed settlement already does `message.edit(...)` (~run.ts:461) — mirror that handle-retention + edit pattern.
- `packages/gateway/src/execute/run-core.ts` — the OpenCode event loop: `message.part.delta`/tool-summary append sites, and the terminal `session.idle` return / `RunCoreError` throw paths. `session.status` is **not** observed here today — the busy/idle signal that drives typing must be added. This file already routes events; the status/typing hooks live alongside the existing handlers, fed by a callback/handle passed from `run.ts`.
- `packages/gateway/src/config.ts` — optional enum config pattern: `GATEWAY_APPROVAL_MODE` validates against a `VALID_APPROVAL_MODES` const tuple and rejects unsupported values (~config.ts:291-302). `GATEWAY_STATUS_MODE` mirrors this exactly.
- `packages/gateway/src/execute/format-part.ts` — `summarizeTool`/essential-tool filter (Phase 1): the status line content is derived from the same essential-action summaries, not re-invented.

### Institutional Learnings

- `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md` — bounded executions with guaranteed cleanup (dual `finally`), preserve user-visible output even on failure-path flush. The status controller teardown must follow the same guaranteed-cleanup discipline so typing never leaks past a run.

### External References

- discord.js 14.26.4: `TextBasedChannel#sendTyping()` → `Promise<void>`, server-side typing indicator auto-expires ~10s, so it must be re-pulsed (~7s interval) while busy. `Message#edit()` for the status message. Discord edit rate limits favor a debounced single edited message over frequent edits.

## Key Technical Decisions

- **Separate status controller, not a sink change.** A new `packages/gateway/src/discord/status-message.ts` owns one message ID and edits it on a debounced cadence. The sink stays append-only. Rationale: the sink's buffer/flush/visible-output contract is load-bearing and recently hardened; bolting an edit surface onto it would entangle two concerns (origin: "real new component, not a formatting tweak").
- **Status content = running count of essential actions**, derived from the Phase-1 summaries (e.g. `⏳ Working… edited 2 files · ran 1 command`). Not the full per-action log (that would re-introduce noise). Debounced at ~1.5–2s.
- **Final-answer transition = edit-in-place when it fits, else delete-then-post.** When the final answer fits one ≤2000-char message, edit the status message into the answer (one clean thread message). When the answer needs the >2000-char summary+attachment path (or otherwise can't be an in-place edit), delete the status message and let the sink post the answer normally. Rationale: short answers stay tidy; long answers reuse the existing tested flush path without contortion.
- **Typing driven by busy/idle**, pulsed ~7s, cleared on idle/abort/terminal **and paused during an approval wait** (`setBusy(false)` when the run blocks on a permission approval, so typing never falsely implies active work while waiting on a human). Rationale: ties the indicator to real work, satisfies R3's "never sticks."
- **`GATEWAY_STATUS_MODE` deploy-wide enum** (`live-status` default | `typing-only`), validated like `GATEWAY_APPROVAL_MODE`. In `typing-only`, the status controller is created in a no-status mode: typing still pulses, but no status message is posted/edited; `resolveToAnswer`/`resolveToFailure` always return `transition: 'delegated'` so the caller posts the final answer/failure via the sink/`safeSend`.
- **Single explicit transition contract (no scattered mode branching).** `resolveToAnswer(text)` and `resolveToFailure(note)` always return a discriminated result: `{ transition: 'handled' }` (the controller put the answer/note into the status message — caller does NOT post) or `{ transition: 'delegated' }` (caller must post via the sink/`safeSend`). The caller branches on this single result, not on `mode`. In `live-status`: short answer → `handled` (edited in place); long/attachment answer or empty → `delegated` (status deleted, sink posts). In `typing-only`: always `delegated`. This makes the success and failure call sites identical across modes.
- **Single owner for failure output (no double message).** On failure, the caller calls `resolveToFailure(note)` exactly once and posts the failure via `safeSend` **only when** the result is `delegated`. `resolveToFailure` never both edits the status AND lets `safeSend` fire — `handled` means the controller owns the failure message (status edited into the note), `delegated` means the caller owns it (status had nothing to edit, or typing-only). This removes the "instead of (or feeding) safeSend" ambiguity.
- **Settle before resolve (no late-edit race).** `resolveToAnswer`/`resolveToFailure`/`dispose` first enter a settle phase: cancel any pending debounce timer and **await any in-flight edit promise** before performing the final edit/delete. This prevents a debounced status edit that fired just before teardown from landing *after* the final answer and corrupting the thread — structurally the same hazard as the already-fixed visible-output race. The controller tracks the in-flight edit promise so settle can await it.
- **Coordinate with `hasVisibleOutput()`:** a posted status message must not cause the sink to think real answer output already exists (it would suppress the `_(no output)_` fallback wrongly) — the status controller's message is tracked separately from the sink's visible-output accounting. The status message is always resolved (handled or deleted) **before** the sink's flush decision, so the two never double-post. The no-output case (`handled`/`delegated` both apply): if the final answer is empty, the controller deletes the status message and returns `delegated`, and the sink owns the `_(no output)_` fallback — the status message never becomes the no-output placeholder.

## Open Questions

### Resolved During Planning

- **Config granularity** (origin OQ1): deploy-wide `GATEWAY_STATUS_MODE`, not per-channel — confirmed.
- **Cadence + content** (origin OQ2): ~1.5–2s debounce, running count of essential actions — confirmed.
- **Final-answer transition mechanics** (origin interaction state): edit-in-place when it fits one message, delete-then-post for long/attachment answers — confirmed.
- **Failure presentation** (origin interaction state): status edited into a terse persona-voice failure note — confirmed.
- **Reasoning marker** (origin OQ3): fully suppressed — already settled and shipped in Phase 1.

### Deferred to Implementation

- **Exact debounce constant** (1500ms vs 2000ms) and the exact status-line wording/emoji: pick during implementation against the real edit-rate-limit behavior; keep the constant named and easily tunable.
- **`session.status` event shape:** confirm the exact SDK event field for busy/idle against the installed `@opencode-ai/sdk` (1.15.13) during implementation — `run-core.ts` already consumes the event stream; the busy/idle discriminant is read from the same events. If no distinct `session.status` busy event is emitted, fall back to "busy = between prompt-send and `session.idle`" as the typing window.
- **Exact approval-wait detection point:** v1 pauses typing during an approval wait via `setBusy(false)`; the exact call site (which permission-coordinator event marks "now waiting on a human") is an implementation detail to wire against the existing approval path. The *richer* approval-state status UX (prompt-in-status-message) remains Phase-4 work.

## Implementation Units

- [x] **Unit 1: `GATEWAY_STATUS_MODE` config**

**Goal:** Add the deploy-wide working-state mode setting.

**Requirements:** R4

**Dependencies:** None.

**Files:**
- Modify: `packages/gateway/src/config.ts`
- Modify: `packages/gateway/src/config.test.ts`

**Approach:**
- Add `VALID_STATUS_MODES = ['live-status', 'typing-only'] as const` and a `statusMode` field on the gateway config, read via the optional-env pattern with default `live-status`, validated against the tuple (reject unsupported values with a clear error). Mirror `GATEWAY_APPROVAL_MODE` exactly.

**Patterns to follow:**
- `GATEWAY_APPROVAL_MODE` / `VALID_APPROVAL_MODES` validation in `config.ts`.

**Test scenarios:**
- Happy path: unset → defaults to `live-status`; `GATEWAY_STATUS_MODE=typing-only` → `typing-only`.
- Edge case: surrounding whitespace / empty string → default.
- Error path: an unsupported value (e.g. `silent`) → config load fails with a clear error naming the valid values.

**Verification:** config exposes a validated `statusMode`; invalid values are rejected at load.

- [x] **Unit 2: Status-message manager + typing pulse**

**Goal:** A per-run component that owns one status message (post/edit/resolve) on a debounced cadence and pulses the typing indicator while busy.

**Requirements:** R1, R2, R3, R5, R6

**Dependencies:** Unit 1 (reads `statusMode`).

**Files:**
- Create: `packages/gateway/src/discord/status-message.ts`
- Create: `packages/gateway/src/discord/status-message.test.ts`

- Factory `createStatusController({ thread, mode, logger })` returning a closure-based controller (functions-only) with: `noteActivity(summary)` — record an essential-action summary and schedule a debounced status edit; `setBusy(boolean)` — start/stop the ~7s typing re-pulse (callers also call `setBusy(false)` when the run blocks on an approval wait so typing pauses); `resolveToAnswer(text)` and `resolveToFailure(note)` — settle, then put the answer/note into the status message and return `{ transition: 'handled' }`, OR delete the status message and return `{ transition: 'delegated' }` (caller posts via sink/`safeSend`); `dispose()` — settle then clear all timers, stop typing, guaranteed-cleanup.
- **Transition contract (identical across modes at the call site):** `handled` = controller owns the final message (caller does nothing more); `delegated` = caller posts the answer/failure via the sink/`safeSend`. In `live-status`: a short answer that fits one ≤2000-char message → `handled` (edited in place); a long/attachment answer or an empty answer → `delegated` (status deleted). `resolveToFailure`: status message exists → edit into the note → `handled`; no status message yet → `delegated`. In `typing-only` mode: `noteActivity` posts nothing; `setBusy` still pulses typing; `resolveToAnswer`/`resolveToFailure` always return `delegated` (no status to edit).
- **Settle phase (before every resolve/dispose):** cancel the pending debounce timer and `await` any in-flight edit promise before performing the final edit/delete. The controller retains the in-flight edit promise so a debounced edit can never land after the final answer.
- Debounce: coalesce rapid `noteActivity` calls into one edit on a named interval constant; never edit per-token. First activity posts the initial status message; subsequent activity edits it.
- Typing: `setBusy(true)` immediately `thread.sendTyping()` and schedules re-pulse every ~7s; `setBusy(false)`/`dispose()` clears the interval. Typing failures are non-fatal (log + continue) — typing is cosmetic.
- All Discord calls are fail-soft (a failed edit/typing/delete logs and does not abort the run), consistent with the sink's `safeSend` discipline.

**Patterns to follow:**
- `message.edit(...)` handle retention from the approval-embed settlement in `run.ts` (~461).
- Closure-based controller with `dispose()` like `createHeartbeatController` (runtime) / the sink's settle-handle style.
- Fail-soft Discord I/O like `safeSend` in `streaming.ts`.

**Test scenarios:**
- Happy path (live-status): first `noteActivity` posts a status message; subsequent `noteActivity` within the debounce window coalesces into a single edit; the rendered status reflects the accumulated essential-action counts.
- Happy path (transition): `resolveToAnswer(short)` edits the status message into the answer and returns `transition: 'handled'`; `resolveToAnswer(long/needs-attachment)` deletes the status and returns `transition: 'delegated'`.
- Edge case (empty answer): `resolveToAnswer('')`/whitespace deletes the status and returns `transition: 'delegated'` (the sink owns the no-output fallback; the status never becomes the placeholder).
- Edge case (2000-char boundary): an answer exactly at the one-message limit resolves consistently (`handled`), and one char over → `delegated` — pin the boundary explicitly.
- Settle/race: a debounced edit is scheduled, then `resolveToAnswer` is called before the timer fires AND while a prior edit promise is in flight → assert the final answer is the last write, no late status edit lands after it.
- Happy path (typing): `setBusy(true)` sends typing and re-pulses on the interval; `setBusy(false)`/`dispose()` stops further pulses.
- Approval-wait: `setBusy(false)` during a simulated multi-pulse wait → no typing pulses fire while paused; `setBusy(true)` resumes.
- Failure path: `resolveToFailure(note)` with a status message present edits the status into the note and returns `transition: 'handled'`; with no status message yet returns `transition: 'delegated'` (caller posts) rather than throwing. Assert never both.
- Edge case (typing-only mode): `noteActivity` posts nothing, `setBusy` still pulses typing, `resolveToAnswer`/`resolveToFailure` always return `transition: 'delegated'`.
- Edge case (fail-soft): a rejected `thread.sendTyping()` / `message.edit()` / `message.delete()` is caught, logged, and does not throw.
- Edge case (dispose): `dispose()` settles then clears the typing interval and the pending debounce timer; no edits/pulses fire after dispose.

**Verification:** the controller posts/edits exactly one status message on cadence, pulses typing only while genuinely busy (paused during approval waits), resolves to a single `handled`/`delegated` outcome with no late-edit race, and never throws on Discord I/O failure.

- [x] **Unit 3: Wire the status controller into the run lifecycle**

**Goal:** Drive the controller from the run-core event stream and own its lifecycle in `run.ts`, coordinating with the sink's final flush and failure paths.

**Requirements:** R1, R2, R3, R5

**Dependencies:** Unit 2.

**Files:**
- Modify: `packages/gateway/src/execute/run.ts`
- Modify: `packages/gateway/src/execute/run-core.ts`
- Modify: `packages/gateway/src/execute/run.test.ts`
- Modify: `packages/gateway/src/execute/run-core.test.ts`

- `run.ts`: create the status controller right after thread/sink creation (passing `config.statusMode`); dispose it in the same inner `finally` that disposes the coordinator (guaranteed cleanup). The completion and failure call sites use the **single transition contract** and do NOT branch on mode:
  - On COMPLETED, before `sink.flush()`: `const r = await resolveToAnswer(finalText)`; if `r.transition === 'handled'` skip the sink flush (answer is in the status message); if `'delegated'` flush via the sink as today.
  - On failure (`RunCoreError`/timeout/abort): `const r = await resolveToFailure(coarseNote)` using the existing failure-copy mapping; post the coarse note via `safeSend` **only when** `r.transition === 'delegated'`. Never both.
- `run-core.ts`: thread a lightweight hook/handle (e.g. an `onActivity(summary)` and `onBusy(boolean)` pair) into the event loop. Call `onActivity` at each essential tool-summary append site (reusing `appendToolSummary`'s computed summary); `onBusy(true)` when work starts; `onBusy(false)` on `session.idle`/terminal **and when the run enters an approval wait** (the permission-coordinator path already knows this moment — pause typing there). If no distinct `session.status` busy event exists, treat the window between prompt-send and `session.idle` as busy.
- No-output fallback: because `resolveToAnswer('')` returns `delegated` and deletes the status message, the sink owns the `_(no output)_` fallback exactly as today — the status message never becomes the placeholder.
- Typing-only mode: the same call sites run unchanged (the controller always returns `delegated`), so typing pulses but the sink/`safeSend` own the final answer/failure — no mode-specific branching at the call site.

**Execution note:** integration-test the COMPLETED edit-in-place path and the failure-note path through `run.ts`, since mocks alone won't prove the status↔sink hand-off.

**Patterns to follow:**
- Per-run component creation + dual-`finally` teardown already used for the heartbeat/coordinator in `run.ts`.
- The existing `appendToolSummary` site in `run-core.ts` as the activity source.

**Test scenarios:**
- Integration (live-status, short answer): a run that produces tool activity then a short final answer → a status message is posted during the run and edited into the final answer; the sink does not post a second message.
- Integration (live-status, long answer): a run whose final answer needs the attachment path → the status message is deleted and the answer posts via the sink's summary+attachment path.
- Integration (failure): a run that throws `RunCoreError` → the status message is edited into a terse failure note (`handled`); exactly one failure message in the thread, no second `safeSend`, no raw error dump.
- Integration (failure before activity): a run that fails before any tool activity (no status message posted) → `resolveToFailure` returns `delegated` and `safeSend` posts the note; still exactly one failure message.
- Integration (typing-only mode): tool activity posts no status message; the final answer/failure posts via the sink/`safeSend`; typing was pulsed during the run.
- Integration (approval-wait): a run that enters an approval wait → typing pauses (no pulses) during the wait and resumes after.
- Edge case (no output): an empty-answer run still yields the `_(no output)_` (or persona equivalent) without a leftover status message.
- Edge case (cleanup): the controller is disposed in `finally` on both success and failure (no leaked typing interval).

**Verification:** during a live-status run the thread shows one updating status message that becomes the answer (or is replaced for long answers); failures read as a persona note; typing-only shows only typing + answer; no timers leak.

- [x] **Unit 4: Deploy wiring + docs**

**Goal:** Surface `GATEWAY_STATUS_MODE` for operators.

**Requirements:** R4

**Dependencies:** Unit 1.

**Files:**
- Modify: `deploy/compose.yaml`
- Modify: `deploy/README.md`
- Modify: `packages/gateway/AGENTS.md`

**Approach:**
- Add a commented optional `GATEWAY_STATUS_MODE` env entry in `deploy/compose.yaml` (default behavior documented as `live-status`), and a short operator note in `deploy/README.md` describing `live-status` vs `typing-only`. Add a one-line behavior note to `packages/gateway/AGENTS.md`. No plan-speak / phase taxonomy in any shipped file.

**Test expectation:** none — config/docs only (behavior covered by Units 1–3).

**Verification:** compose validates; docs describe the two modes without internal taxonomy.

## System-Wide Impact

- **Interaction graph:** the status controller sits between `run-core.ts` (activity/busy events) and Discord (`thread.send`/`message.edit`/`sendTyping`), and coordinates with the sink's final flush in `run.ts`. It does not touch lock/run-state/heartbeat.
- **Error propagation:** all Discord I/O in the controller is fail-soft (log + continue); a status/typing failure must never abort or fail a run.
- **State lifecycle risks:** the typing re-pulse interval and the debounce timer must be cleared on dispose in the run's `finally` — a leaked interval would pulse typing forever. The status message must always be resolved (edited/deleted) so it isn't orphaned.
- **API surface parity:** none — internal gateway component; no exported contract changes. `GATEWAY_STATUS_MODE` is the only new external (operator) surface.
- **Integration coverage:** the status↔sink hand-off (edit-in-place vs delete-then-post, and the no-output fallback) is the cross-layer behavior unit mocks won't prove — covered by Unit 3 integration tests.
- **Unchanged invariants:** the `DiscordStreamSink` contract, the lock/run-state/heartbeat coordination, and the approval embed flow are unchanged; the final-answer content and the `_(no output)_` fallback semantics are preserved.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Status edits hit Discord rate limits and throttle the run | Debounced single edited message (~1.5–2s), fail-soft on edit failure; one message edited, never per-token. |
| Status message + sink both post → double message (success or failure) | Single transition contract: the caller posts via sink/`safeSend` ONLY on `delegated`; `handled` means the controller owns the message. Settle phase cancels pending debounce + awaits in-flight edit before resolve, so no late edit lands after the answer. Unit 2/3 tests assert exactly one final/failure message and the race case. |
| Leaked typing interval keeps the thread "typing" forever, or typing lies during an approval wait | `dispose()` settles + clears all timers in the run's inner `finally`; `setBusy(false)` pauses typing on approval wait. Unit 2/3 cleanup + approval-wait tests assert no pulses after dispose / during a wait. |
| `session.status` busy/idle event shape differs in the SDK | Deferred-to-implementation: confirm against `@opencode-ai/sdk` 1.15.13; fall back to prompt-send→`session.idle` as the busy window. |
| Posted status message confuses the sink's `hasVisibleOutput` no-output accounting | Status message tracked separately from sink visible-output; resolved before the flush decision (KTD). |

## Documentation / Operational Notes

- `deploy/README.md` + `deploy/compose.yaml`: document `GATEWAY_STATUS_MODE` (`live-status` default | `typing-only`). Operators wanting the quietest experience set `typing-only`.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-07-mention-loop-production-ready-requirements.md](docs/brainstorms/2026-06-07-mention-loop-production-ready-requirements.md) — Phase 2 (working-state UX), OQ1/OQ2, interaction states.
- Related code: `packages/gateway/src/discord/streaming.ts`, `packages/gateway/src/execute/run.ts`, `packages/gateway/src/execute/run-core.ts`, `packages/gateway/src/config.ts`, `packages/gateway/src/execute/format-part.ts`.
- Phase 1 (shipped): #831 (rendering + persona), #837 (NBC follow-ups), #833 (lock-leak fix).
