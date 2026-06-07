---
title: "fix: Reconcile PR review approval event when the agent delivers a verdict as a comment"
type: fix
status: completed
date: 2026-06-06
completed: 2026-06-06
---

# fix: Reconcile PR review approval event when the agent delivers a verdict as a comment

## Overview

On a `pull_request` review trigger, the review agent runs `gh pr review` / `gh pr comment` itself inside its OpenCode session. On follow-up re-reviews (after branch protection dismisses a prior approval when a maintainer pushes a fix), the agent reaches a PASS verdict but sometimes delivers it as a plain comment (`event=COMMENTED`) instead of a formal approval (`event=APPROVE`). Branch protection counts only the review event, so the PR stays BLOCKED and a maintainer must approve manually — defeating the automation.

This adds a harness-side post-session reconciliation phase: after the agent finishes, if the bot's posted artifact carries a PASS verdict but no matching APPROVE review exists for the current head, the harness submits the formal APPROVE itself via the existing `submitReview()`. The prompt's comment-only escape hatch is also removed (advisory layer).

## Problem Frame

Issue #778. A partial recurrence of the bug PR #723 addressed with a prompt-only fix (documented in `docs/solutions/workflow-issues/comment-only-review-blocked-approval-2026-06-01.md`, which predicted this recurrence and set the escalation criterion: "escalate to a guardrail only if the failure recurs after this fix"). The recurrence is now confirmed, so the durable harness guardrail is warranted.

Architectural crux (verified): the harness is dumb transport — `executeOpenCode()` runs the agent session, and the agent emits the `gh` review command via shell (authenticated through the exported `GH_TOKEN`). `submitReview()` exists and correctly uses `octokit.rest.pulls.createReview` with a typed `event`, but it is not on the agent's delivery path. So the fix is a harness reconciliation step, not "route the agent through submitReview()."

Verdict source decision (load-bearing): reconcile from the **actual posted GitHub artifact** (the bot's latest PR review body, or its latest PR issue comment if it used `gh pr comment`), NOT the agent's private CI-log assistant text. Never approve based on prose the PR audience never saw.

## Requirements Trace

- R1. When a `pull_request` review run posts a PASS verdict but the bot's latest review event for the current head is not APPROVED, the harness submits a formal APPROVE so branch protection is satisfied.
- R2. The guardrail never approves stale code: it only acts when the bot's verdict artifact and the approval target match the current PR head SHA.
- R3. The guardrail never double-approves: if the bot already has an APPROVED review for the current head from this run, it no-ops.
- R4. The guardrail never approves on a non-PASS or unparsable/absent verdict (CONDITIONAL/REJECT/none → no-op; no auto REQUEST_CHANGES in v1).
- R5. The guardrail fails safe on insufficient permission, fork PRs, self-authored/bot-authored PRs, and API errors — it logs and no-ops, never aborting the run.
- R6. The prompt no longer offers a comment-only escape hatch for a reached verdict (advisory reinforcement of R1).

## Scope Boundaries

- APPROVE reconciliation only. CONDITIONAL/REJECT → REQUEST_CHANGES symmetry is **out of scope** for v1 (a missing request-changes does not block merge the way a missing approval does, and auto-requesting changes is more surprising).
- Does not change how the agent delivers reviews in-session (it still runs `gh pr review`). The harness only reconciles after the fact.
- Does not restructure review delivery into a harness-owned structured-JSON pipeline (Oracle's design C) — that is a larger refactor, not #778's fix.

### Deferred to Separate Tasks

- Symmetric REQUEST_CHANGES reconciliation: future iteration if comment-as-changes-requested proves to also cause friction.

## Context & Research

### Relevant Code and Patterns

- `src/harness/run.ts` — phase pipeline. Insertion point: after `runExecute()` sets `agentSuccess` (~line 114) and before `saveDedupMarker()` (~line 116) / `runFinalize()` (~line 121). At that point `routing.githubClient`, `routing.botLogin`, `routing.triggerResult.context`, `execution`, and `startTime` are all in scope.
- `src/harness/phases/` — existing phase modules; mirror their `run<Phase>(...)` shape for the new `runReviewReconciliation(...)`.
- `src/harness/phases/routing.ts` — builds `githubClient` and resolves `botLogin` (returned in the routing result).
- `src/features/reviews/reviewer.ts` — `submitReview(octokit, {prNumber, owner, repo, event, body, comments}, logger)` → `ReviewResult`. Call with `event: 'APPROVE'`, `comments: []`, and a short guardrail body. `REVIEW_EVENTS` / `SubmitReviewOptions` in `src/features/reviews/types.ts`.
- `src/features/triggers/context-builders-pr-issues.ts` — `normalizeReviewerLogin()` strips `[bot]`; reuse for bot-login matching.
- `packages/runtime/src/agent/prompt.ts` — verdict→event wording in the `pull_request` directive, Response Protocol (rule 5), and Output Contract. The Output Contract line still carries the escape hatch ("use it only if you genuinely cannot reach a verdict").
- `.github/workflows/ci.yaml` — `PR_REVIEW_PROMPT` reinforcing line; also the fork / self-authored exclusion guards (skips `fro-bot`/bot PR authors).

### Institutional Learnings

- `docs/solutions/workflow-issues/comment-only-review-blocked-approval-2026-06-01.md` — the prior prompt fix + the explicit prediction of this recurrence and the guardrail escalation criterion. This plan is the escalation.

### Verdict-heading format

The agent's review body uses a `## Verdict: PASS | CONDITIONAL | REJECT` heading (observed in Fro Bot review bodies). Parse this from the artifact body. Treat only an unambiguous `PASS` as approvable; anything else (including absent/multiple/ambiguous) is a no-op.

## Key Technical Decisions

- **Post-session reconciliation phase, not in-session interception.** The agent owns the shell `gh` call; the harness can only reliably act after the session by inspecting GitHub state. A dedicated `runReviewReconciliation()` phase keeps stateful PR mutation out of `finalize`.
- **Verdict source = posted GitHub artifact, not assistant CI-log text.** Query the bot's latest PR review (and latest PR issue comment as fallback for the `gh pr comment` path); parse the `## Verdict:` heading from that body. This guarantees the harness only approves what the PR audience actually saw.
- **Current-head gating.** Resolve the PR's current head SHA fresh; only reconcile when the verdict artifact corresponds to this run (filter bot reviews/comments by `submitted_at`/`created_at >= run start`) and the approval will target the current head. If the head advanced after the agent reviewed, no-op (don't approve stale code).
- **Idempotent / no double-approve.** If the bot already has an `APPROVED` review at the current head, skip.
- **Fail-safe everywhere.** Any error (permissions, fork, self-authored PR, API failure, parse failure) logs and no-ops. Reconciliation must never fail the run or throw out of the phase.
- **APPROVE-only in v1.** CONDITIONAL/REJECT mismatches may log a warning but do not auto-submit REQUEST_CHANGES.
- **Prompt escape-hatch removal is advisory, not the correctness boundary.** The guardrail is the correctness boundary; the prompt change reduces how often it must activate.

## Open Questions

### Resolved During Planning

- Approve from CI-log verdict or posted artifact? Posted artifact — never approve prose users didn't see.
- Await OpenCode shutdown before querying? Not required — reconciliation uses octokit/GitHub state, not the OpenCode session; it runs after `runExecute` returns and before cleanup shuts the server down.
- Double-review unavoidable when the agent already left a COMMENTED review? Yes — GitHub can't mutate a COMMENTED review into APPROVED, so a second (APPROVE) review is submitted. This is the intended repair path; document it as the one sanctioned exception to "exactly one artifact."

### Deferred to Implementation

- Exact `runReviewReconciliation` signature and where the phase result (did it approve?) surfaces — mirror existing phase modules.
- Whether to expose the reconciliation outcome in the run summary/metrics — decide during implementation; keep minimal.
- Precise bot-review "since run start" filter field (`submitted_at` for reviews vs `created_at` for issue comments) — confirm against octokit response shapes during implementation.

## Implementation Units

- [x] **Unit 1: Review-verdict parsing + reconciliation decision (pure logic)**

**Goal:** A pure, well-tested module that, given the bot's latest review state + verdict-bearing artifact body + current head SHA + run-start time, decides whether to submit an APPROVE (and why not, when not).

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Create: `src/features/reviews/review-reconciliation.ts`
- Test: `src/features/reviews/review-reconciliation.test.ts`

**Approach:**
- Export a `parseVerdict(body: string): 'PASS' | 'CONDITIONAL' | 'REJECT' | null` that matches the `## Verdict:` heading; return `null` on absent/ambiguous/multiple.
- Export a pure `decideReconciliation(input): {action: 'approve'} | {action: 'skip', reason: string}` taking: parsed verdict, whether a bot APPROVED review already exists at current head, whether the verdict artifact belongs to this run (timestamp gate), and head-match boolean. Encodes R1–R4 as explicit branches with named skip reasons (already-approved, stale-head, not-pass, no-verdict).
- No I/O in this module — it takes already-fetched facts. (Octokit calls live in Unit 2.)

**Patterns to follow:**
- `normalizeReviewerLogin()` for any login comparison helpers; `Result`-style explicitness used elsewhere in reviews.

**Test scenarios:**
- Happy path: verdict PASS + no existing approval + artifact from this run + head matches → `{action:'approve'}`.
- Edge case: verdict PASS but bot already APPROVED current head → skip (already-approved).
- Edge case: verdict PASS but artifact predates run start → skip (stale/not-this-run).
- Error path: verdict CONDITIONAL → skip (not-pass); verdict REJECT → skip (not-pass).
- Error path: body has no `## Verdict:` heading → `parseVerdict` returns null → skip (no-verdict).
- Edge case: body has two conflicting `## Verdict:` headings → null → skip.
- Edge case: head SHA advanced after the verdict artifact → skip (stale-head).

**Verification:**
- `decideReconciliation` returns `approve` only in the exact R1 case; every other branch returns a named skip reason. Full table-style coverage.

- [x] **Unit 2: `runReviewReconciliation` phase (octokit I/O + submit)**

**Goal:** A harness phase that gathers the GitHub facts, calls `decideReconciliation`, and on `approve` submits the formal APPROVE via `submitReview()`. Fail-safe throughout.

**Requirements:** R1, R2, R3, R5

**Dependencies:** Unit 1

**Files:**
- Create: `src/harness/phases/review-reconciliation.ts`
- Modify: `src/harness/run.ts`
- Test: `src/harness/phases/review-reconciliation.test.ts`

**Approach:**
- `runReviewReconciliation(params)` where params carry the octokit client, bot login, trigger context (owner/repo/PR number/event type), and run start time.
- Guard early: only proceed when event type is a `pull_request` review trigger, `responseMode` is github, PR number exists, bot login exists, `execution.success` is true. Otherwise no-op.
- Fetch: PR current head SHA + author/fork status; bot's reviews (`pulls.listReviews`) filtered to bot login (normalized) and `submitted_at >= runStart`, taking the latest; if none, the bot's latest PR issue comment (`issues.listComments`) since run start as the verdict-body fallback.
- Compute `alreadyApproved` (a bot APPROVED review at current head), `verdict` (parse the latest bot artifact body), `belongsToRun` (timestamp), `headMatches`.
- Call `decideReconciliation`; on `approve`, call `submitReview(octokit, {prNumber, owner, repo, event:'APPROVE', body:<short guardrail note>, comments:[]}, logger)`.
- Wrap the entire phase body so any throw (permissions, fork, self-authored, API) is caught, logged, and returns a no-op outcome. Never rethrow.
- Wire into `src/harness/run.ts` after `agentSuccess = execution.success` and before `saveDedupMarker`. Pass the needed fields from `routing`/`execution`/`startTime`.

**Execution note:** Implement test-first — the decision branches and the fail-safe wrapper are the risk surface.

**Patterns to follow:**
- Existing `run<Phase>()` modules for signature/return shape and logger usage.
- `submitReview()` call shape from `reviewer.ts`.

**Test scenarios:**
- Happy path (integration-style with a mocked octokit): PR review trigger, bot left a COMMENTED review with `## Verdict: PASS` at current head, no prior approval → phase calls `submitReview` with `event:'APPROVE'` exactly once.
- Happy path: bot used `gh pr comment` (no review, an issue comment with PASS) at current head → phase reads the issue-comment fallback and approves.
- Edge case: bot already APPROVED current head → `submitReview` not called.
- Edge case: verdict artifact from a prior run (older timestamp) → not called.
- Edge case: head advanced since the verdict → not called.
- Error path: non-pull_request trigger / no PR number / responseMode != github → early no-op, no octokit calls.
- Error path: `submitReview`/octokit throws (e.g., 403 fork/permission) → caught, logged, phase returns no-op, run continues (no rethrow).
- Error path: self-authored/bot-authored PR → no-op (don't attempt to approve own PR).
- Integration: `run.ts` invokes the phase between execute and dedup-marker, and a thrown reconciliation error does not change the run exit code.

**Verification:**
- On the COMMENTED-PASS-at-head case the harness produces a formal APPROVE; every skip/error branch leaves PR state untouched and never fails the run.

- [x] **Unit 3: Remove the prompt comment-only escape hatch (advisory layer)**

**Goal:** Tighten the verdict-delivery wording so a reached verdict can never be framed as legitimately comment-only, and add re-review awareness.

**Requirements:** R6

**Dependencies:** None (independent of Units 1–2)

**Files:**
- Modify: `packages/runtime/src/agent/prompt.ts`
- Modify: `.github/workflows/ci.yaml` (the `PR_REVIEW_PROMPT` reinforcing line)
- Test: `packages/runtime/src/agent/prompt.test.ts`

**Approach:**
- In the Output Contract line, remove "use it only if you genuinely cannot reach a verdict" escape hatch; state that a reached verdict MUST be delivered as the matching review event, and a comment-only path never satisfies review-required.
- Add re-review-aware wording to the `pull_request` directive: a dismissed/required-again review still requires a `gh pr review` event, never `gh pr comment`/`gh issue comment`.
- Keep the existing PASS→`--approve`, CONDITIONAL/REJECT→`--request-changes` mapping.

**Patterns to follow:**
- The existing three verdict-wording sites in `prompt.ts` and their current test assertions in `prompt.test.ts`.

**Test scenarios:**
- Happy path: the `pull_request` directive contains the approve/request-changes event mapping and the re-review-aware "never a plain comment" wording.
- Edge case: the Output Contract no longer contains the comment-only escape-hatch phrasing for a reached verdict (assert the old phrase is gone).
- Regression: existing prompt.test.ts assertions for the verdict mapping still pass.

**Verification:**
- Prompt no longer presents comment-only as valid for a reached verdict; re-review framing is explicit; existing verdict-mapping tests stay green.

## System-Wide Impact

- **Interaction graph:** New phase runs only on `pull_request` review triggers; all other event types early-no-op. It reads PR review/comment state and may submit one APPROVE review. No effect on issue/comment/schedule/dispatch flows.
- **Error propagation:** The phase is fully wrapped — it never throws out. A reconciliation failure is logged and does not change the run's success/exit code.
- **State lifecycle risks:** A second (APPROVE) review is created when the agent already left a COMMENTED review — the one sanctioned exception to "exactly one artifact per run." Idempotency guard prevents repeated approvals across reruns (skip when already APPROVED at head).
- **API surface parity:** Reuses `submitReview()` (already the canonical typed-event path); no new GitHub-write surface beyond it.
- **Unchanged invariants:** The agent's in-session review delivery is unchanged; the prompt mapping (PASS→approve) is unchanged except for removing the escape hatch; non-PR flows untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Approving stale code after a new push | Gate on current head SHA + run-start timestamp; no-op on mismatch (R2). |
| Double / repeated approvals | Skip when a bot APPROVED review already exists at current head (R3). |
| Approving when the bot can't (fork PR, self-authored PR, missing pull-request:write) | Fail-safe wrapper + explicit author/fork guards; log and no-op (R5). |
| Reconciling a non-PASS verdict | `decideReconciliation` approves only on unambiguous PASS; all else no-op (R4). |
| Mis-parsing the verdict from a noisy body | Strict `## Verdict:` heading match; null on absent/ambiguous/multiple → no-op. |
| Phase failure aborting the run | Entire phase wrapped; never rethrows; run exit code unaffected. |

## Documentation / Operational Notes

- Update `docs/solutions/workflow-issues/comment-only-review-blocked-approval-2026-06-01.md` (or add a short follow-up note) recording that the guardrail escalation shipped, closing the loop the doc opened. (Confirm during implementation; keep concise.)

## Sources & References

- Issue: #778
- Prior art: PR #723, `docs/solutions/workflow-issues/comment-only-review-blocked-approval-2026-06-01.md`
- Related code: `src/harness/run.ts`, `src/harness/phases/routing.ts`, `src/features/reviews/reviewer.ts`, `packages/runtime/src/agent/prompt.ts`
