---
title: "fix: recoverable ContextOverflowError for the PR review session"
type: fix
status: active
date: 2026-08-03
origin: docs/brainstorms/2026-08-03-review-session-overflow-recovery-requirements.md
deepened: 2026-08-03
---

# fix: recoverable ContextOverflowError for the PR review session

## Overview

The PR review job continues one OpenCode session across every review round (keyed PR-stable by `buildLogicalKey` → `pr:<number>`). Over several rounds the session's accumulated transcript exceeds the model context window and emits `ContextOverflowError`, which the poller treats as a generic terminal session error. Because the review is the required `test-action` CI check, that failure wedges merge even when the standing verdict is `APPROVED`, and re-running re-continues the same overflowed session so it fails again — admin override is the only escape.

This plan makes `ContextOverflowError` **recoverable instead of terminal** on the review path, without changing the PR-stable session key (persistent continuity is the project's core value proposition). On overflow the run archives the overflowed session and restarts once with a fresh session inside the same run, producing a real verdict on the current push. It also suppresses the confusing ENOENT secondary error and adds a visible recovery marker.

## Problem Frame

See origin: `docs/brainstorms/2026-08-03-review-session-overflow-recovery-requirements.md`. The defect is not the PR-stable key — it is that an overflowed session is terminal and self-perpetuating. Root cause confirmed in source:

- `buildLogicalKey` keys PR paths on `pr:<number>` (`packages/runtime/src/session/logical-key.ts:93-99`) — correct and intentional.
- `resolveSessionForLogicalKey` re-continues that session every round and skips archived/compacting sessions — but only _after_ the title match, a latent ordering bug this plan fixes (`packages/runtime/src/session/logical-key.ts:135-156`).
- `session-poll.ts` treats any persisted `sessionError` as terminal after 3 grace cycles (`src/features/agent/session-poll.ts:208-226`); `ContextOverflowError` is not distinguished.
- The required status is the CI `test-action` job (`.github/workflows/ci.yaml:144-213`).
- A failed execution still triggers a response-file read → confusing `ENOENT` secondary (`src/features/agent/response-post.ts:87-91`).

Key research reframe (see origin R4): the overflow comes from the **continued session's accumulated transcript**, not from `priorWorkContext` (already `limit: 5`-bounded search excerpts). A fresh session drops the transcript entirely, so it is materially smaller **by construction** — bounded-recall is defense-in-depth, not the primary size-reduction mechanism.

## Requirements Trace

- R1. Classify `ContextOverflowError` distinctly from generic/terminal session errors (origin R1).
- R2. In-run recovery: on overflow, restart a fresh session in the same run and archive the overflowed one (origin R2).
- R3. Bounded single restart; next-run recovery is the floor (origin R3).
- R4. Bounded recovery recall — fresh session excludes the archived session from prior-work search and stays budget-capped (defense-in-depth atop the automatic transcript drop) (origin R4).
- R5. Recovered verdict is a genuine full review, carrying a visible overflow-recovery marker (origin R5).
- R6. Suppress the ENOENT secondary cascade on session-error failure without regressing the #1252 fallback for genuine file-read failures on successful executions (origin R6).
- R7. Preserve invariants: attempt-scoped one-response, PR-stable key, non-overflow terminal behavior, #1252/#1305 finalize/deadline invariants (origin R7).

## Scope Boundaries

- No head-SHA / per-revision session keying — the continuity key stays `pr:<number>` (breaking session continuity is the antithesis of the project's core value prop).
- No session compaction/summarization plumbing.
- No GitHub-review-thread hydration into the prompt.
- Recovery is scoped to the **review execution path** (the flow that wedges the required merge check).

### Deferred to Separate Tasks

- Overflow recovery for the dispatch / schedule / comment flows (not merge-blocking; they fail a run rather than block a merge): a follow-up if it surfaces in practice.
- A structural fix for unbounded per-round session growth (compaction): a later effort if long-lived non-review sessions hit the same ceiling.

## Context & Research

### Relevant Code and Patterns

- **Error classifier pattern** — `classifyProviderAuthError` / `classifyQuotaError` return `ErrorInfo | null` on exact structured markers (`packages/runtime/src/agent/error-format/format.ts:183-241`); `ERROR_TYPES` / `ErrorInfo` taxonomy (`packages/runtime/src/agent/error-format/types.ts:1-58`); `createProviderAuthError` / `createQuotaExceededError` factories (`format.ts:167-173,243-260`). A new overflow classifier mirrors this exactly.
- **Structured-error extraction already present** — `streaming.ts:432-479` extracts `name` from `session.error` and routes it through the existing classifier chain (`const terminalError = classifyProviderAuthError({kind:'session-error', name}) ?? classifyQuotaError(...)`). The overflow classifier slots into this chain. `mergeActivityError` sets `activityTracker.terminalProviderError` + `sessionError` (`streaming.ts:65-93`).
- **SDK error shape** — `ContextOverflowError = { name: "ContextOverflowError"; data: { message: string; responseBody?: string } }` (`.slim/clonedeps/repos/anomalyco__opencode/packages/sdk/js/src/v2/gen/types.gen.ts:302-308`).
- **Create-vs-continue seam** — `execution.ts:115-134` (+ runtime copy `packages/runtime/src/agent/execution.ts:77-93`): `if (config?.continueSessionId == null) { create } else { reuse }`. Bounded-retry discipline to mirror: `retry.ts:43-130` (`MAX_LLM_RETRIES = 4`, single loop, break on `!shouldRetry`).
- **Archive primitive** — `client.session.update({sessionID, time:{archived: Date.now()}})` (SDK `sdk.gen.ts:486-497`; server `setArchived` at `session.ts:759-761`). `resolveSessionForLogicalKey` already excludes `time.archived != null`.
- **Prior-work search** — `searchSessions(query, client, workspace, {limit, caseSensitive, sessionId}, logger)` (`packages/runtime/src/session/search.ts:82-123`), called with `{limit: 5}` in `runSessionPrep` (`src/harness/phases/session-prep.ts:84-91`). Has `limit` + `sessionId`; no exclusion list yet.
- **Finalize / ENOENT / #1252 fallback** — ENOENT log at `response-post.ts:87-91`; finalize file-convention + fallback at `finalize.ts:194-218,309-325` (`file-read-failed && execution.success === false && commentsPosted === 0` → fallback comment).

### Institutional Learnings

- `docs/solutions/integration-issues/opencode-quota-retry-treated-as-activity-2026-07-15.md` — classify structured retry signals once at the trusted boundary into a distinct kind; don't let retry machinery/idle timers reinterpret it. Directly models R1.
- `docs/solutions/integration-issues/provider-auth-failure-hangs-to-timeout-2026-07-25.md` — exact structured-marker classification, merge observation paths into one authoritative state, rebuild safe output from harness-owned constants.
- `docs/solutions/logic-errors/terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md` — once an outcome is accepted, cleanup may degrade but must not rewrite it; artifact-read failure must not mask the primary error. Constrains R6 + recovery.
- `docs/solutions/logic-errors/retry-clobbers-previous-invocation-comment-2026-07-11.md` — idempotency must key off the invocation's own identity, never "the most recent bot comment." Constrains R7 attempt-scoping.
- `docs/solutions/best-practices/response-file-is-untrusted-input-2026-07-11.md` — missing/malformed response file fails closed; target/surface from trusted context. Constrains R6.
- `docs/solutions/workflow-issues/preview-dependency-release-recovery-requires-single-use-reruns-2026-07-30.md` — safe recovery is a bounded, single authorized action, not an open loop. Constrains R3.

## Key Technical Decisions

- **Classify overflow at the streaming boundary, mirroring auth/quota.** Add `context_overflow` to `ERROR_TYPES`, a `createContextOverflowError()` factory, and `classifyContextOverflowError({kind: 'session-error', name})`; wire it into the existing `terminalError` chain in `streaming.ts`. Rationale: the structured `name` is already extracted there; this is the one authoritative classification point and reuses a proven pattern.
- **Overflow is a distinct, recoverable terminal signal — recovery is orchestrated at the phase layer, not inside `executeOpenCode`.** Overflow still terminates the current session attempt (so poll/stream agree), tagged distinctly (`ErrorInfo.type === 'context_overflow'`). The **outer single-retry lives in `runExecute`** (`src/harness/phases/execute.ts`), because that layer holds session-prep, the OpenCode client, the logical key, and the workspace — everything a fresh recovery attempt needs. `executeOpenCode` stays "run one session attempt under a deadline." Rationale: recovery must re-run the bounded prior-work search with the archived session excluded (R4); that search lives in session-prep, which `executeOpenCode` cannot soundly re-run without a downward layering leak.
- **Recovery re-runs a bounded session-prep, not the original prompt.** On overflow, `runExecute` calls a recovery-prep path that resolves fresh (`continueSessionId = null`, same logical key + title) and re-runs `searchSessions` with `excludeSessionIds: [overflowedSessionId]` and the small cap, then calls `executeOpenCode` a second time. Rationale: satisfies R4 as written — the fresh session's prior-work context genuinely excludes the just-overflowed session. Transcript drop is still the primary size reduction; the exclusion is defense-in-depth against re-pulling the overflowed session's excerpts.
- **One absolute deadline across both attempts (#1305 preserved).** `executeOpenCode` creates its own `ExecutionDeadline` per call, so two naive calls would reset the budget. `runExecute` must thread the **remaining** budget into the second call (`remainingMs = timeoutMs − elapsed`); if `remainingMs <= 0`, fail without restarting. Rationale: an in-run restart must eat into the same budget, not grant a fresh window.
- **Archive via `session.update({time:{archived}})`, before the fresh attempt.** Archiving preserves the audit trail (session stays inspectable) and, combined with the resolver fix below, guarantees the overflowed session is never re-continued. Archive **before** the fresh attempt so a crash mid-recovery cannot re-wedge the next run on the known-overflowed session; the accepted cost is that a crash before the fresh verdict degrades continuity to a cold start next run (a wedged required check is worse than losing one PR's transcript continuity). If the fresh attempt also overflows, archive it too.
- **Resolver eligibility must precede title match (correctness fix).** `resolveSessionForLogicalKey` currently runs `findSessionByTitle` (newest-by-`updated`) _before_ the archived/compacting skip — so archiving the overflowed session (which bumps its `updated`) can make it mask the fresh same-title recovered session, returning `not-found` instead of the fresh one. The fix filters archived/compacting **before** title match. Rationale: without it, "the fresh recovered session adopts the title so the next run continues it" is not guaranteed; this is a latent bug the recovery path would expose.
- **Restart is gated on no prior delivery.** Recovery runs only when the overflowed attempt delivered nothing (`commentsPosted === 0`). If it somehow posted, do not restart-and-repost (return the original failed result). Rationale: R7 one-response — never double-deliver across the two attempts. For the file-convention review path this is normally zero; pin it in tests, don't assume it.
- **Recovered result carries recovery metadata; the verdict lives downstream.** `executeOpenCode` returns `commentsPosted` and error state, **not** a verdict (the review verdict is composed downstream via the response file + finalize). The recovered attempt's result is authoritative; add `overflowRecovery { recovered, archivedSessionId }` metadata for the visible marker + logs. Rationale: R5 marker without inventing a second delivery path.

## Open Questions

### Resolved During Planning

- Where classification lands: the streaming `terminalError` chain (`streaming.ts:432-479`), reusing the `{kind:'session-error', name}` input shape — not the poller (which sees only the flattened string). The poller/execution consume the classified `ErrorInfo.type`.
- Archive mechanism: `client.session.update({sessionID, time:{archived: Date.now()}})`; `resolveSessionForLogicalKey` honors `time.archived` (once the eligibility-ordering fix lands).
- Recovery placement: the outer single-retry lives in `runExecute` (phase layer), not inside `executeOpenCode` — so the recovery attempt can re-run a bounded session-prep with the archived session excluded (R4). `executeOpenCode` stays a single-attempt primitive.
- Whether the fresh recovery re-runs session-prep: **yes** — a recovery-prep path resolves fresh + re-runs `searchSessions` with `excludeSessionIds`. (Corrected from the first draft, which assumed prompt reuse; that could not satisfy R4's exclusion.)
- Deadline: one absolute budget across both attempts — `runExecute` passes the remaining budget into the second `executeOpenCode` call.
- Review path uses the action copy `src/features/agent/execution.ts` only; the runtime copy (`packages/runtime/src/agent/execution.ts`) is parity/library code and is out of scope.

### Deferred to Implementation

- Exact carrier for the recoverable-overflow signal on `ActivityTracker` (a distinct field vs inspecting `terminalProviderError.type === 'context_overflow'`) — resolve against the real merge/return shapes.
- The recovery-prep seam shape: a `forceFresh` + `excludeSessionIds` option on `runSessionPrep`, vs a dedicated `buildRecoverySessionPrep` helper — pick against the real `runSessionPrep` signature.
- How the recovery marker surfaces in the check output (job summary line vs the posted review body) — pick the least-noisy visible channel.
- The precise gate that distinguishes a session-error-caused missing response file (suppress ENOENT) from a genuine file-read failure on a successful execution (keep the #1252 fallback).

## Implementation Units

- [ ] **Unit 1: Classify `ContextOverflowError` distinctly**

**Goal:** Produce a distinct `context_overflow` `ErrorInfo` when the session emits `ContextOverflowError`, at the same streaming boundary that already classifies auth/quota.

**Requirements:** R1

**Dependencies:** None

**Files:**

- Modify: `packages/runtime/src/agent/error-format/types.ts` (add `context_overflow` to `ERROR_TYPES`; add a `ContextOverflowErrorInput` shape mirroring the session-error variant)
- Modify: `packages/runtime/src/agent/error-format/format.ts` (`createContextOverflowError()`, `classifyContextOverflowError()`)
- Modify: `src/features/agent/streaming.ts` (add `classifyContextOverflowError({kind:'session-error', name})` to the `terminalError` chain)
- Test: `packages/runtime/src/agent/error-format/format.test.ts`
- Test: `src/features/agent/opencode.test.ts`

**Approach:**

- Mirror `classifyProviderAuthError` exactly: exact-marker match on `name === 'ContextOverflowError'`, return a fixed-shape `ErrorInfo` (provider-neutral message, no raw provider payload). Slot it into the existing `classifyProviderAuthError(...) ?? classifyQuotaError(...)` chain so overflow is recognized before the generic path.
- Tag the resulting `ErrorInfo` so downstream orchestration can distinguish "recoverable overflow" from terminal auth/quota (the distinction is the `type` field; recovery logic is Unit 3).

**Patterns to follow:** `classifyProviderAuthError` / `createProviderAuthError` (`format.ts:167-241`); the `terminalError` chain (`streaming.ts:432-479`).

**Test scenarios:**

- Happy path: a `session.error` with `name: 'ContextOverflowError'` classifies to `type: 'context_overflow'` with the fixed message.
- Edge case: `ContextOverflowError` nested under `error.data.name` (both extraction sites) classifies identically.
- Error path: an unrelated `session.error` name does not classify as overflow (returns null / falls through to generic).
- No-leak: the classified `ErrorInfo` and any serialized output contain no raw provider/response-body text from `data`.
- Regression: auth and quota classification are unchanged (overflow added before them does not shadow them).

**Verification:** A `ContextOverflowError` session event yields a distinct `context_overflow` `ErrorInfo`; auth/quota/generic classification unchanged.

- [ ] **Unit 2: Session primitives — archive, resolver eligibility fix, prior-work exclusion**

**Goal:** Provide the three session-layer mechanisms recovery needs: archive a session so it is never re-continued, make the resolver pick the eligible (non-archived) same-title session, and exclude a session from prior-work search.

**Requirements:** R2, R4

**Dependencies:** None (parallel with Unit 1)

**Files:**

- Create: `archiveSession(client, sessionId, logger)` helper wrapping `client.session.update({sessionID, time:{archived}})` — colocate under `packages/runtime/src/session/`
- Modify: `packages/runtime/src/session/logical-key.ts` — in `resolveSessionForLogicalKey`, filter archived/compacting sessions **before** `findSessionByTitle`, not after
- Modify: `packages/runtime/src/session/search.ts` (`searchSessions` gains `excludeSessionIds?: readonly string[]`; filter candidates by it, keep the existing `limit` cap)
- Test: the archive helper's colocated test
- Test: `packages/runtime/src/session/logical-key.test.ts` (resolver eligibility ordering)
- Test: `packages/runtime/src/session/search.test.ts` (or the existing search test file)

**Approach:**

- `archiveSession` is a thin, fail-soft wrapper: on failure it logs and reports failure without throwing (the recovery caller decides what to do). Archiving only sets `time.archived`, preserving the audit trail.
- **Resolver eligibility fix:** today `resolveSessionForLogicalKey` runs `findSessionByTitle` (newest-by-`updated`) then rejects if the winner is archived/compacting (`packages/runtime/src/session/logical-key.ts:135-156`). Because archiving bumps `updated`, an archived overflowed session can win the title match and shadow the fresh same-title recovered session → `not-found` → continuity silently lost. Filter archived/compacting out of the candidate set **before** `findSessionByTitle` so the newest **eligible** same-title session wins.
- `excludeSessionIds` filters the given ids out of the candidate set; default empty preserves current behavior exactly (backward-safe for the existing `{limit: 5}` call site).

**Patterns to follow:** SDK `session.update` (`sdk.gen.ts:486`); `resolveSessionForLogicalKey` / `findSessionByTitle` (`packages/runtime/src/session/logical-key.ts:108-156`); existing `searchSessions` option handling (`search.ts:82-123`).

**Test scenarios:**

- Happy path: `archiveSession` calls `session.update` with `time.archived` set; a subsequently-resolved logical key skips the archived session.
- Error path: `archiveSession` on a failing client logs and reports failure without throwing.
- Resolver eligibility (the load-bearing regression): two same-title workspace sessions where the **archived** one has the newer `time.updated` → `resolveSessionForLogicalKey` returns the **non-archived** one, not `not-found`.
- Resolver: when the only same-title session is archived, still returns `not-found` (unchanged).
- Happy path: `searchSessions` with `excludeSessionIds: [X]` omits session X; without the option, results are identical to today (backward-safe).
- Edge case: `excludeSessionIds` referencing an absent id is a no-op; the `limit` cap still applies.

**Verification:** Archiving a session makes `resolveSessionForLogicalKey` skip it; a newer archived same-title session no longer masks an eligible fresh one; `searchSessions` can exclude a given session and is unchanged when the option is omitted.

- [ ] **Unit 3: Phase-level recovery orchestration (bounded single restart)**

**Goal:** On a classified overflow, archive the overflowed session and restart the review once — from a fresh, bounded session-prep — within the same run and the same execution budget; bound to exactly one restart.

**Requirements:** R2, R3, R4, R5 (full-review property), R7 (attempt-scoped, deadline)

**Dependencies:** Unit 1 (classification), Unit 2 (archive + resolver fix + exclusion)

**Files:**

- Modify: `src/harness/phases/execute.ts` (`runExecute`) — the outer recovery loop: first `executeOpenCode` → on `overflowRecovery` eligibility, archive → recovery-prep → second `executeOpenCode` with remaining budget → return only the recovered result
- Modify: `src/harness/phases/session-prep.ts` (`runSessionPrep`) — a recovery-prep path: `forceFresh` (`continueSessionId = null`, same logical key + title) + `excludeSessionIds` threaded into the `searchSessions` call
- Modify: `src/features/agent/execution.ts` — surface a `context_overflow` result cleanly and add `overflowRecovery { recovered, archivedSessionId }` result metadata; accept a caller-provided remaining timeout so the second attempt shares one absolute budget
- Test: `src/features/agent/opencode.test.ts` (execution-level overflow result shape)
- Test: `src/harness/phases/execute.test.ts` (the recovery loop, deadline threading, attempt-scoping)

**Approach:**

- `runExecute` runs the first attempt, then inspects the result: if `llmError.type === 'context_overflow'` **and** the attempt delivered nothing (`commentsPosted === 0`), it recovers; otherwise it returns the original result unchanged.
- Recovery sequence: `archiveSession(overflowedId)` (before the fresh attempt) → build recovery-prep (`forceFresh`, `excludeSessionIds: [overflowedId]`, small cap) → compute `remainingMs = timeoutMs − elapsed` (fail without restart if `<= 0`) → second `executeOpenCode` with the remaining budget → return the recovered result, tagged with `overflowRecovery`.
- Bounded to **one** restart. If the fresh attempt also overflows (or the recovery prompt is already too large), archive it too and fail cleanly — no loop. The archived sessions mean the next run starts fresh (next-run floor).
- The fresh session runs the full review prompt (not a shortened pass — R5 no-rubber-stamp). `executeOpenCode` composes `commentsPosted`/error state, **not** a verdict; the review verdict is delivered downstream via the response file + finalize. Only the recovered attempt's result reaches finalize (R7 one-response). The two attempts share one absolute deadline (#1305), so recovery cannot extend the budget.

**Execution note:** Add a failing test first for the overflow→archive→recovery-prep→fresh-restart path in `runExecute` (the core recovery contract), then implement the loop.

**Patterns to follow:** `runExecute` → `executeOpenCode` call site (`src/harness/phases/execute.ts:45-100`); create-vs-continue branch (`execution.ts:115-134`); `ExecutionDeadline` ownership (`execution.ts:59-62`, `retry.ts`); bounded-loop discipline (single attempt, break on terminal); quota/auth terminal handling for how a classified terminal result is surfaced.

**Test scenarios:**

- Happy path: first attempt returns `context_overflow` with `commentsPosted === 0` → overflowed session archived, recovery-prep built with `excludeSessionIds`, a fresh `executeOpenCode` runs and returns a recovered result tagged `overflowRecovery.recovered`; the run's outcome is the recovered one.
- Bounded retry: the fresh attempt also overflows → both sessions archived, run fails cleanly (exactly one restart, no loop).
- Deadline threading: the second `executeOpenCode` receives `remainingMs`, not a fresh full budget; if `remainingMs <= 0`, no restart and the run fails on the deadline.
- No-restart-on-delivery: an overflow attempt with `commentsPosted > 0` does **not** restart (no double-delivery); the original result is returned.
- Prior-work exclusion (integration): the recovery-prep `searchSessions` call carries `excludeSessionIds: [overflowedId]`.
- Attempt-scoping (integration): only the recovered attempt's result (`commentsPosted`, session id) reaches finalize; the overflowed attempt's session id is the archived one.
- Regression: a non-overflow terminal session error (auth/quota/generic) keeps current terminal behavior — no restart.

**Verification:** An overflowing review run recovers in-run without admin override; the second overflow fails cleanly; the second attempt shares the original budget; a delivered overflow attempt never double-posts; non-overflow errors are unaffected.

- [ ] **Unit 4: Suppress ENOENT cascade + surface the recovery marker**

**Goal:** Stop the confusing `failed to read response file … ENOENT` secondary on session-error failures, and make overflow recovery visible in the run output, without regressing the #1252 fallback.

**Requirements:** R5 (marker), R6

**Dependencies:** Unit 3 (recovery produces the marker signal)

**Files:**

- Modify: `src/features/agent/response-post.ts` and/or `src/harness/phases/finalize.ts` (gate the ENOENT log / secondary on session-error-failure vs genuine file-read failure)
- Modify: the finalize/output path to emit the overflow-recovery marker
- Test: `src/harness/phases/finalize.test.ts`

**Approach:**

- Distinguish "execution failed with a session error → no response file expected" (suppress the ENOENT secondary; the primary session error is the signal) from "successful execution but response file unreadable" (keep the #1252 `file-read-failed` fallback comment). Preserve the first authoritative outcome per the terminal-outcomes learning.
- Emit the overflow-recovery marker on the least-noisy visible channel (job summary line preferred) so a recovered green run is legible to maintainers without altering the review body's verdict.

**Patterns to follow:** finalize fallback path (`finalize.ts:309-325`); ENOENT log site (`response-post.ts:87-91`); `finalize.test.ts:175-325` fallback/marker assertions (e.g. `expect(options.body).not.toContain('ENOENT')`).

**Test scenarios:**

- Happy path: a session-error failure (including overflow that could not recover) does not emit `failed to read response file … ENOENT`; logs show only the primary failure.
- Regression: a successful execution with a genuinely unreadable response file still posts the #1252 fallback comment and fails with the primary execution error.
- Marker: an overflow-recovered run surfaces the recovery marker in the output; a normal run does not.
- Invariant: the recovered run still posts exactly one review.

**Verification:** No ENOENT secondary on session-error failures; #1252 fallback intact for successful-execution file-read failures; recovered runs are visibly marked; one-response holds.

## System-Wide Impact

- **Interaction graph:** streaming classifier → `ActivityTracker` → poller → `executeOpenCode` (attempt) → **`runExecute` recovery loop** → finalize delivery. Unit 1 adds a classification branch; Unit 2 adds session primitives + the resolver fix; Unit 3 adds the phase-level recovery loop; Unit 4 adjusts finalize logging + output.
- **Error propagation:** overflow becomes a distinct recoverable terminal signal; all other session errors keep their current terminal path. The first authoritative outcome must survive recovery/cleanup (no rewrite to timeout/ENOENT).
- **State lifecycle risks:** archive happens **before** the fresh attempt — a crash after archive but before the fresh verdict degrades continuity to a cold start next run (accepted: a wedged required check is worse than one PR's lost transcript continuity). The resolver eligibility fix (Unit 2) is what makes "the fresh recovered session adopts the title so the next run continues it" actually hold — without it, the newer archived session masks the fresh one. If the recovery attempt also overflows, its session is archived too.
- **Deadline ownership:** `executeOpenCode` mints its own `ExecutionDeadline` per call; the recovery loop must pass the **remaining** budget into the second call so both attempts share one absolute window (#1305). This is the single most error-prone seam — a naive second call silently doubles the budget.
- **API surface parity:** `searchSessions` gains an optional `excludeSessionIds` (backward-safe; default empty); `runSessionPrep` gains a recovery-prep path; `executeOpenCode` gains optional remaining-budget input + `overflowRecovery` result metadata. No change to the logical key contract or the PR-stable keying.
- **Integration coverage:** the archive→recovery-prep→fresh-restart→single-delivery path, the deadline threading, and the prior-work exclusion are cross-layer and need integration-level tests in `execute.test.ts` (mocks alone won't prove one-response + exclusion + shared-budget).
- **Unchanged invariants:** PR-stable logical key; non-overflow terminal session-error behavior; the #1252 fallback on successful-execution file-read failure; the #1305 bounded execution deadline; one comment/review per invocation.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Fresh recovery session re-overflows by re-ingesting prior context | Transcript is dropped by construction (primary); recovery-prep re-runs `searchSessions` with `excludeSessionIds` + small cap (defense-in-depth); a second overflow fails cleanly (bounded). |
| Newer archived session masks the fresh recovered session next run | Resolver eligibility fix (Unit 2) filters archived/compacting **before** title match, so the eligible fresh session wins; regression test pins the newer-archived case. |
| Recovery silently grants a second full execution window (#1305) | `runExecute` threads `remainingMs` into the second `executeOpenCode`; `<= 0` means no restart; a test proves the second attempt does not get a fresh budget. |
| Recovery becomes a gate-weakening shortcut (shallow pass) | The fresh session runs the full review prompt; green requires a genuine complete verdict; recovery is visibly marked. |
| Double-post across the overflowed + recovered attempts | Restart gated on `commentsPosted === 0`; only the recovered attempt reaches finalize; overflowed attempt posts nothing (retry-clobbers learning). |
| Crash between archive and fresh verdict | Archive-before-fresh is deliberate: next run starts cold rather than re-wedging on the known-overflowed session; accepted continuity tradeoff, documented. |
| Overflow classification shadows or is shadowed by auth/quota | Exact-marker classifier ordered in the existing chain; regression tests pin auth/quota unchanged. |
| ENOENT gate accidentally suppresses the genuine #1252 fallback | Gate strictly on session-error-failure vs successful-execution file-read failure; regression test pins the #1252 fallback. |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-08-03-review-session-overflow-recovery-requirements.md](../brainstorms/2026-08-03-review-session-overflow-recovery-requirements.md)
- Related code: `packages/runtime/src/agent/error-format/format.ts`, `src/features/agent/streaming.ts`, `src/harness/phases/execute.ts`, `src/harness/phases/session-prep.ts`, `src/features/agent/execution.ts`, `packages/runtime/src/session/search.ts`, `packages/runtime/src/session/logical-key.ts`, `src/harness/phases/finalize.ts`
- Related issue: #1311
- SDK error shape: `.slim/clonedeps/repos/anomalyco__opencode/packages/sdk/js/src/v2/gen/types.gen.ts:302-308`
