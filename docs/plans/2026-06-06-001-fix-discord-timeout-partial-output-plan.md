---
title: fix: Improve Discord timeout messaging after partial output
type: fix
status: active
date: 2026-06-06
---

# fix: Improve Discord timeout messaging after partial output

## Overview

Discord mention runs that hit the gateway wall-clock timeout after delivering visible output currently end with the same generic timeout message used for no-output failures. This plan keeps the existing timeout/failure semantics, but makes the terminal Discord message reflect whether useful partial output was already delivered and includes the configured timeout duration.

## Problem Frame

Issue #801 reports a Discord mention run that produced useful partial output and tool activity, then posted `The task timed out. Please try again.` after the 10-minute gateway deadline. That message makes a partial-success timeout look like a total failure and gives poor continuation guidance.

Fro Bot’s triage identified the likely seam: the mention run already has access to output visibility state through the Discord stream sink, and the timeout message is selected in `packages/gateway/src/execute/run.ts` after the failure-path flush.

## Requirements Trace

- R1. Timeout messages distinguish runs that already delivered visible partial output from runs that delivered no visible output.
- R2. Timeout messages include the configured gateway run timeout duration instead of a hardcoded or absent limit.
- R3. Run lifecycle semantics stay unchanged: a gateway timeout remains a failed run and keeps the existing flush-before-error-message sequence.
- R4. User-facing timeout text stays coarse and non-leaky; it must not expose internal paths, stack traces, provider details, or low-level gateway state.
- R5. Active-streaming timeout extensions and alternate success/partial-success states are deferred.

## Scope Boundaries

- This plan only changes Discord mention timeout classification and copy.
- This plan does not extend the run timeout, add heartbeat-based timeout policy, or change the default timeout.
- This plan does not change stored run phase/state semantics; timeout remains failure.
- This plan does not change premature stream-close (`stream-ended`) messaging.
- This plan does not suppress the existing no-output flush behavior on error paths.

### Deferred to Separate Tasks

- Active streaming/heartbeat timeout policy: decide separately whether actively producing runs should get a longer deadline.
- Error-path empty-output suppression: decide separately whether `_(no output)_` should be omitted when an error message follows.
- `stream-ended` partial-output messaging: adjacent behavior, but out of scope for #801’s timeout-specific fix.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/execute/run.ts`: owns `runMention()` lifecycle, failure-path sink flush, and user-facing error message selection.
- `packages/gateway/src/discord/streaming.ts`: owns buffered output flushing and `markVisibleOutputSent()` visibility tracking.
- `packages/gateway/src/execute/run-core.ts`: throws `RunCoreError('timeout', ...)` when the gateway deadline aborts execution.
- `packages/gateway/src/execute/run.test.ts`: existing run-level timeout/error-path coverage.
- `packages/gateway/src/discord/streaming.test.ts`: sink behavior coverage.

### Institutional Learnings

- `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md`: failure paths should flush buffered output before the coarse error reply; partial output must be best-effort and must not mask the original error.
- `packages/gateway/AGENTS.md`: Discord failure replies should stay generic and non-leaky.
- `docs/plans/2026-05-30-001-feat-gateway-unit-6-mention-loop-plan.md`: mention-loop output cadence is final flush on completion plus failure-path flush for partial progress, not chatty incremental streaming.

### External References

- None. Local Gateway patterns are sufficient for this focused behavior change.

## Key Technical Decisions

- Capture output visibility before choosing timeout copy: the timeout message should be based on the sink’s visible-output state after the failure-path flush completes.
- Append a terminal timeout note even when partial output was delivered: users need a clear signal that the run ended and that a follow-up message can continue the work.
- Include timeout duration in both timeout branches: operator-configured limits should be visible to users without implying an internal failure.
- Do not reclassify timeout as success or partial success: preserving `FAILED` avoids changing run coordination, cleanup, and downstream monitoring semantics.
- Do not broaden to `stream-ended`: although the flow is adjacent, issue #801 and Fro Bot triage are timeout-specific.

## Open Questions

### Resolved During Planning

- Should timeout messages always be posted after partial output? Yes — append a context-aware terminal timeout note rather than suppressing it.
- Should `stream-ended` be included? No — defer it to keep this plan tight.
- Should empty-output suppression be included? No — keep current no-output flush behavior and only improve timeout copy.

### Deferred to Implementation

- Exact timeout duration formatting: implement using the simplest readable helper that keeps configured values accurate and testable.
  - **Resolved:** `formatTimeoutDuration` produces compound minute+second strings for non-integral minutes (e.g. 90_000 → "1 minute 30 seconds", 600_000 → "10 minutes", 45_000 → "45 seconds"). Exported for direct unit testing.
- Exact message wording: keep the issue's intent, but allow implementation to tune copy for clarity and current project style.
  - **Resolved:** Visible-output branch: "The task reached the `<duration>` time limit after posting updates above. Start a new @fro-bot request with what to do next and include any needed context from the output above." No-output branch: "The task reached the `<duration>` time limit. Please try again." Both branches avoid "gateway timeout" and internal implementation terms.

## Implementation Units

- [x] **Unit 1: Expose sink visible-output state**

**Goal:** Make the Discord stream sink’s existing visible-output tracking readable by the mention run error classifier.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `packages/gateway/src/discord/streaming.ts`
- Test: `packages/gateway/src/discord/streaming.test.ts`

**Approach:**
- Extend the existing sink contract with a read-only predicate/accessor for whether visible output has been sent.
- Reuse the state already updated by `markVisibleOutputSent()`; do not add a second visibility flag with different semantics.
- Keep visibility one-way for a run: once visible output has been marked, later flush results should not reset it.

**Execution note:** Implement the sink behavior test-first.

**Patterns to follow:**
- Existing sink methods in `packages/gateway/src/discord/streaming.ts`.
- Existing visibility tests around `markVisibleOutputSent()` and skipped visible output behavior.

**Test scenarios:**
- Happy path: newly created sink reports no visible output.
- Happy path: after `markVisibleOutputSent()`, the sink reports visible output.
- Edge case: flushing an empty buffer does not itself reset visible-output state.

**Verification:**
- Sink tests prove the accessor reflects the existing visibility marker without changing flush behavior.

- [x] **Unit 2: Branch timeout copy using visibility state**

**Goal:** Make timeout failure messages context-aware while preserving failure semantics and message ordering.

**Requirements:** R1, R2, R3, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/gateway/src/execute/run.ts`
- Test: `packages/gateway/src/execute/run.test.ts`

**Approach:**
- Keep the current error path order: flush buffered output first, then send the terminal error message.
- For `RunCoreError('timeout')`, inspect visible-output state after the flush attempt.
- When visible output exists, send timeout copy that says the time limit was hit after posting updates and tells the user to start a new @fro-bot request with the next instruction/context.
- When visible output does not exist, send timeout copy that includes the configured duration and keeps retry guidance generic.
- Keep non-timeout error messages unchanged.

**Execution note:** Add failing run-level tests for both timeout branches before changing the classifier.

**Patterns to follow:**
- Existing `RunCoreError` type checks in `packages/gateway/src/execute/run.ts`.
- Existing Discord send safety (`allowedMentions: { parse: [] }`) in run-level replies.
- Existing timeout-duration tests around approval deadline/hard abort behavior.

**Test scenarios:**
- Timeout with partial text output flushed: final message acknowledges partial output and continuation guidance.
- Timeout with attachment output flushed: final message follows the partial-output branch.
- Timeout after only visibility marker output, such as an approval waiting/status message: final message follows the partial-output branch without changing approval settlement behavior.
- Timeout with no visible output: final message includes the configured duration and does not use partial-output continuation wording.
- Error path ordering: flush completes before the timeout message is sent.
- Regression: reachability, empty prompt, stream-ended, and generic failure messages remain unchanged.

**Verification:**
- Run-level tests prove timeout copy branches on visibility while preserving existing error classifications.

- [x] **Unit 3: Document deferred timeout-policy scope**

**Goal:** Make it clear in the durable plan/issue context that #801 fixes messaging only, not timeout policy.

**Requirements:** R5

**Dependencies:** Unit 2

**Files:**
- Modify: `docs/plans/2026-06-06-001-fix-discord-timeout-partial-output-plan.md`

**Approach:**
- Keep this plan’s scope boundary explicit so implementation review does not expand into timeout extension or success-state changes.
- If implementation discovers useful follow-up work, track it separately rather than folding it into this fix.

**Patterns to follow:**
- Existing plan scope-boundary style in `docs/plans/`.

**Test scenarios:**
- Test expectation: none — documentation/scope tracking only.

**Verification:**
- The plan remains aligned with issue #801 and Fro Bot’s triage after implementation updates.

## System-Wide Impact

- **Interaction graph:** Discord mention error path only; no change to workspace clone, binding lookup, OpenCode execution, or approval reply APIs.
- **Error propagation:** Timeout remains a `RunCoreError('timeout')` and still reports as failed; only the terminal Discord message changes.
- **State lifecycle risks:** Partial-output visibility is read-only from the classifier; it should not alter flush buffering, run storage, or lock cleanup.
- **API surface parity:** No public API or environment variable changes.
- **Integration coverage:** Run-level tests should cover the end-to-end failure path from simulated timeout through flush and Discord reply.
- **Unchanged invariants:** Failure-path partial output is best-effort; flush failures must not mask the original timeout.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Timeout copy leaks implementation detail | Keep text coarse: mention configured gateway timeout and continuation guidance only. |
| Visibility accessor drifts from flush result semantics | Reuse the existing sink visibility flag rather than deriving a second state. |
| Tests overfit exact copy | Assert key behavioral phrases/duration/branching while allowing minor wording adjustments. |
| Scope creep into timeout policy | Keep timeout extension and success-state changes deferred. |

## Documentation / Operational Notes

- No operator docs are required for the messaging-only fix.
- If a future timeout-policy change is planned, it should start from issue #801’s deferred notes but land separately.

## Sources & References

- Issue: [#801 Improve Discord mention timeout messaging after partial output](https://github.com/fro-bot/agent/issues/801)
- Fro Bot triage comment on #801
- Related code: `packages/gateway/src/execute/run.ts`
- Related code: `packages/gateway/src/discord/streaming.ts`
- Related tests: `packages/gateway/src/execute/run.test.ts`
- Related tests: `packages/gateway/src/discord/streaming.test.ts`
- Related learning: `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md`
