---
title: Recoverable ContextOverflowError for the PR review session
status: draft
date: 2026-08-03
issue: fro-bot/agent#1311
scope: standard
type: fix
---

# Recoverable ContextOverflowError for the PR review session

## Problem

The PR review job continues a single OpenCode session across every review round, keyed by a **PR-stable** logical key (`buildLogicalKey` → `pr:<number>` in `packages/runtime/src/session/logical-key.ts:93-99`). Persistent session state across CI runs is the project's core value proposition, so the PR-stable key is correct and intentional.

The defect is not the key — it is that an overflowed session is **terminal and self-perpetuating**:

1. Over several review rounds the session accumulates each round's diff + review context. Eventually it exceeds the model's context window and the session emits `ContextOverflowError`.
2. The session poller (`src/features/agent/session-poll.ts:208-226`) treats any persisted `sessionError` as terminal after `ERROR_GRACE_CYCLES` (3) cycles. `ContextOverflowError` is **not** distinguished from generic session errors.
3. The required review status is the CI `test-action` job (`.github/workflows/ci.yaml:144-213`). A hard failure there **blocks merge** even when the standing review decision is `APPROVED` and every other check is green — admin override is the only escape.
4. Re-running does **not** help: `resolveSessionForLogicalKey` rediscovers and continues the _same_ overflowed session by the same key, so it overflows again.
5. A secondary confusing error cascades: the failed execution never writes the response file, but finalize still attempts to read it (`src/features/agent/response-post.ts:87-90`), emitting `Response-post: failed to read response file … ENOENT`.

Observed on a real PR after 5 review rounds; the fifth round's own diff was trivial (one test assertion), so the overflow came from accumulated session history, not the round's diff size.

## Goal

Make `ContextOverflowError` in the review session **recoverable instead of terminal**, so a long-lived PR can always be reviewed and a required check can never be permanently wedged — **without** changing the PR-stable session key or discarding persistent continuity.

## Non-Goals

- **No head-SHA / per-revision session keying.** Fragmenting the continuity key (`pr:<number>:<sha>`) to bound growth would discard persistent session memory on every push — the antithesis of this project's core value proposition. The key stays `pr:<number>`.
- **No session compaction/summarization plumbing.** There is no in-repo compaction hook; building one is over-engineered for this fix. Recovery is by fresh-session restart, not by summarizing the overflowed transcript.
- **No GitHub-review-thread hydration into the prompt.** Prior-round context continues to come from session search (`searchSessions` / `priorWorkContext`), not from injecting prior review threads. Adding that is a separate future enhancement if prior-verdict memory ever proves weak.

### Scoped to the review path

Recovery is scoped to the **PR review execution path** — the flow whose failure wedges the required `test-action` merge check (the actual reported defect). `ContextOverflowError` can in principle also occur in the dispatch, schedule, and comment flows; those are **not** merge-blocking (they fail a run rather than block a merge), so they are deliberately out of scope here and left as a follow-up if they ever surface in practice. Extending the same classify/archive/restart behavior to those flows is a straightforward later addition.

### Bounded mitigation, not a growth-curve fix

This is a **recovery** mechanism, not a cure for unbounded per-round session growth. The underlying growth curve (each review round appends diff + context to a long-lived session) still exists; recovery makes overflow non-terminal rather than preventing it. If unbounded accumulation becomes a problem for other long-lived, non-review session flows, a follow-up should address per-round accumulation directly (e.g. compaction). That is deliberately out of scope here.

## Requirements

### R1 — Classify `ContextOverflowError` distinctly

The session-error handling path must distinguish `ContextOverflowError` (context window exhausted — recoverable by starting fresh) from generic/terminal session errors. It should slot into the existing structured error taxonomy rather than a bespoke string check where practical (cf. the existing provider-auth / quota classifiers in `packages/runtime/src/agent/error-format/format.ts`).

### R2 — In-run recovery: archive then restart once

When the review execution detects `ContextOverflowError`:

1. **Start a fresh session within the same run** and re-run the review against the current push, producing a real verdict. The required check goes green on the first overflowing run — no wasted run, no admin override.
2. **Archive** the overflowed session so `resolveSessionForLogicalKey` (which already skips archived sessions) will not re-continue it — on this run or any future run. Archiving only makes the session ineligible for continuation; it must not destroy the audit trail (the overflowed session stays inspectable). The fresh recovered session adopts the entity title so the **next** run continues _it_, not the archived one.

The fresh session preserves continuity via the existing `searchSessions` / `priorWorkContext` mechanism (query-based, independent of the logical key) — **but bounded per R4**, so it does not simply re-ingest the same bloated history that caused the overflow.

### R3 — Bounded retry (single restart)

The in-run restart is bounded to **exactly one** fresh attempt. If the fresh session _also_ overflows (e.g. a single genuinely enormous diff that cannot fit even in a clean session, or a recovery prompt that is itself too large before the first model turn), the run fails cleanly rather than looping restarts. Because the overflowed session was archived (R2), the **next** run / re-run starts fresh — next-run recovery is the floor beneath in-run recovery.

### R4 — Bounded recovery recall (do not re-ingest the overflow)

The fresh recovery session must start **materially smaller** than the session that overflowed. Seeding it from `searchSessions` unbounded would pull the same bloated excerpts straight back in and re-overflow on the first turn, defeating recovery. Therefore the recovery attempt must:

- **Exclude the just-archived overflowed session** (and the PR's prior overflowed rounds) from the prior-work search that seeds the fresh prompt.
- **Cap the prior-work budget** injected into the recovery prompt (bounded excerpt count / token budget, or a lighter recovery prompt shape), so the fresh session's starting context is comfortably under the window.

The recovery prompt is a re-evaluation of the **current push's diff** with bounded prior context — not a replay of the full review history.

### R5 — Recovered verdict is a genuine full review, visibly marked

- **No rubber-stamp path.** The required check may go green on recovery **only** when the fresh session produced a genuine, complete review of the current diff. Overflow recovery must not become a route to a shallower pass that merely appears fully reviewed — a crafted PR must not be able to force overflow to weaken the gate. If the recovered session cannot complete a full review, the run fails (R3); it does not pass.
- **Visible marker.** When a run recovers from overflow, the run/check output carries an explicit overflow-recovery marker so maintainers can see recovery happened even though the check went green — preserving the "review history got large" signal rather than silently burying it.

### R6 — Suppress the ENOENT secondary cascade

On a session-error failure (including overflow), the finalize/response-post path must not emit the confusing `failed to read response file … ENOENT` secondary error. A failed execution legitimately produced no response file; the primary failure (or the recovered verdict) is the signal. This must not regress the #1252 fallback-delivery behavior for genuine file-read failures on _successful_ executions.

### R7 — Preserve all existing invariants

- One comment/review per invocation (Response Protocol) — a recovery restart creates two execution attempts inside one invocation, so posting must be attempt-scoped: only the final recovered attempt emits the one permitted review; the overflowed attempt must post nothing. No double-post, no wrong-target.
- The PR-stable logical key is unchanged for every event path.
- Non-overflow session errors keep their current terminal behavior (no change to the generic grace-period path beyond carving out the overflow case).
- The bounded-execution deadline and other finalize invariants (#1252, #1305) are preserved — the in-run restart must fit within the existing execution deadline, not extend it.

## Acceptance Criteria

- **AC1** — A review session that emits `ContextOverflowError` archives itself and restarts once in the same run, posting a real verdict on the current push; the required `test-action` check passes without admin override.
- **AC2** — After overflow recovery, a subsequent run for the same PR does **not** re-continue the archived overflowed session (it either continues the fresh recovered session or starts anew), and does not immediately re-overflow from inherited history.
- **AC3** — If the fresh in-run session also overflows, the run fails cleanly (no infinite restart loop) and the overflowed sessions are archived so a re-run starts fresh.
- **AC4** — A session-error failure no longer emits the `failed to read response file … ENOENT` secondary error; logs show only the primary failure/recovery.
- **AC5** — `ContextOverflowError` is classified distinctly from generic session errors and from provider-auth/quota errors.
- **AC6** — Existing behavior is unchanged for: the PR-stable session key, non-overflow terminal session errors, the #1252 fallback comment on genuine file-read failure of a successful execution, and the one-response invariant.
- **AC7** — The recovery session's prior-work recall excludes the archived overflowed session and is budget-capped, so the fresh session's starting context is measurably smaller than the overflowed one (a fresh session does not immediately re-overflow from re-ingested history).
- **AC8** — The recovered run posts exactly one review (only the final recovered attempt emits; the overflowed attempt posts nothing) and carries a visible overflow-recovery marker in its output. The recovered green reflects a genuine complete review of the current diff, not a shortened pass.

## Key Seams (for planning)

- `packages/runtime/src/session/logical-key.ts:93-99` — PR-stable key (unchanged; referenced for the archive-not-rekey decision).
- `src/harness/phases/session-prep.ts:52-91` — `resolveSessionForLogicalKey` (skips archived) + `searchSessions` → `priorWorkContext`.
- `src/features/agent/session-poll.ts:12,208-226` — `ERROR_GRACE_CYCLES` grace path where overflow must be classified and routed to recovery.
- `src/features/agent/execution.ts:115-134` (+ runtime copy `packages/runtime/src/agent/execution.ts:77-93`) — continue-vs-fresh session seam where an in-run restart lands.
- `packages/runtime/src/agent/error-format/format.ts:183-241` — existing structured classifiers to slot R1 into.
- `src/features/agent/response-post.ts:87-90`, `src/harness/phases/finalize.ts:194-325` — ENOENT cascade + #1252 fallback path to preserve.
- Session archive mechanism — the primitive R2 relies on (confirm the exact archive call/state during planning).

## Open Questions (resolve in planning)

- **Preserve the structured error through the poller.** `session-poll.ts` currently flattens `sessionError` to a string (`firstSessionError: string`), which discards the `name` needed to classify overflow. `ContextOverflowError` is a real structured session-error name in the SDK v2 types (`.slim/clonedeps/repos/anomalyco__opencode/packages/sdk/js/src/v2/gen/types.gen.ts:303`), so the poller/activity-tracker must preserve the structured shape (or at least the `name`) before collapsing to a string. Planning must resolve where this classification lands.
- **Archive primitive.** No archive call exists at the runtime recovery seam today — `resolveSessionForLogicalKey` only _reads_ `matchedSession.time.archived`. Planning must name the exact archive mechanism (state mutation vs SDK call) invoked during recovery, and confirm the fresh recovered session adopts the entity title so the _next_ run continues _it_.
- **Same-run restart wiring.** The current execution flow runs one session and returns success/failure; there is no re-entry path for a fresh session in the same run. Planning must add the recovery branch (classify overflow → archive → create fresh session → rebuild bounded prompt → single retry) in the execution orchestration, and decide poller-vs-orchestration ownership of the single-restart bound.
- **Bounded-recall implementation (R4).** How the recovery prompt excludes the overflowed session from `searchSessions` and enforces the prior-work budget (the exact filter + cap).
- **Archive/verdict ordering.** Whether archiving is committed only after the fresh verdict persists, or archiving is safe earlier because it preserves the audit trail regardless (R2).
- Whether `ContextOverflowError` warrants a distinct `RunCoreErrorKind` / operator-facing failure kind, or stays internal to the action's session handling.
