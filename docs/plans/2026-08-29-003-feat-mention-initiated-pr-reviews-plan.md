---
title: Let authorized mention runs submit PR reviews
type: feat
status: active
date: 2026-08-29
issue: https://github.com/fro-bot/agent/issues/1504
---

# Let authorized mention runs submit PR reviews

## Overview

An `@fro-bot` mention on a PR resolves to the `pr-comment` surface, and the response parser rejects a `verdict:` key on any surface but `pr-review`. So a mention run that reaches a review conclusion has that conclusion discarded at delivery: no comment, no review, a full agent turn spent. On a repo where Fro Bot is the required approver, there is no in-band path from `CHANGES_REQUESTED` back to `APPROVED`.

This makes the response surface reflect what the run is actually authorized to do, so an authorized mention can submit a real review — and makes the prompt agree with the validator so no run is ever instructed to produce output that will be rejected.

## Problem Frame

Three defects, all verified against `main`:

1. **The prompt instructs every file-convention run to emit a verdict.** `buildResponseProtocolSection()` (`packages/runtime/src/agent/prompt.ts:725-731`) takes no surface parameter and always emits "For a PR review, include a `verdict:` frontmatter key … never omit it" (`:756-766`). The model in the reported run was complying, not freelancing.
2. **`pull_request_review_comment` is a guaranteed-dead path.** `prompt.ts:441-443` attaches a verdict-REQUIRED `<output_contract>` for that trigger, but `resolveResponseSurface()` (`src/features/agent/response-file.ts:8-15`) maps only `pull_request` to `pr-review`. A model obeying a REQUIRED instruction fails delivery 100% of the time.
3. **A mention run cannot submit a review at all**, which is the capability gap the issue is actually about.

Failure is total rather than degraded: `finalize.ts:382-405` has a fallback error comment for `file-read-failed` only, so `parse-failed` posts nothing.

## Requirements Trace

- R1. An authorized mention on a PR can submit a real review event, so a prior `CHANGES_REQUESTED` can be superseded (GitHub scores the latest review per reviewer).
- R2. Review authority derives from trusted routing context and the requestor's association — never from the response file.
- R3. A run is never instructed to emit output its own validator will reject, on any trigger.
- R4. A PR mention that is not a review (a question, a request to explain) still works and still posts, without being forced to produce a verdict.
- R5. Existing review guards are preserved unchanged: APPROVE blocked on fork and self-authored PRs, head-SHA re-checked immediately before submission.
- R6. A validator rejection degrades to a posted comment rather than discarding the turn.
- R7. The existing solutions doc recording the old behavior as intentional is corrected, not left to contradict shipped behavior.

## Scope Boundaries

- No change to the association allowlist, bot rejection, or mention requirement — the existing trigger gate is the authorization boundary and is already correct.
- No new permission system; `getRepositoryPermission()` stays scoped to `review_requested`/`ready_for_review` where the webhook's association is the PR author's rather than the sender's.
- Not addressing session-continuity loss on `issue_comment` runs (read-only Actions cache for untrusted triggers). Nothing in this design may depend on session persistence.

### Deferred to Separate Tasks

- Actions cache read-only on mention triggers: separate issue, per the reporter's own note and the documented incident. It compounds the impact here but has an unrelated fix.

## Context & Research

### Relevant Code and Patterns

- `src/features/triggers/skip-conditions-comment.ts:31-50` — the existing mention gate: bot rejection, association allowlist, mention requirement, in that order.
- `packages/runtime/src/shared/types.ts:52-53` — `ALLOWED_ASSOCIATIONS` (`OWNER`, `MEMBER`, `COLLABORATOR`).
- `src/features/agent/response-file.ts:8-15` — `resolveResponseSurface()`, the derivation to extend.
- `src/features/agent/response-post.ts:281-301` — the trusted-derivation invariant and `deriveSurfaceAndTarget()`.
- `src/features/reviews/review-guards.ts:59-88` — APPROVE-only fork/self guard; `:122-156` — head-SHA TOCTOU guard.
- `src/features/agent/response-post.ts:387-405` — the no-verdict branch, where `pr-review` currently fails closed.
- `packages/runtime/src/agent/types.ts:239-268` — `PromptOptions`, which needs the surface threaded in.

### Institutional Learnings

- `docs/solutions/workflow-issues/mention-triggered-run-cannot-clear-changes-requested-review-2026-08-12.md` — records the current behavior as by design. **This plan reverses that decision, so the doc must be updated in the same change** (R7).
- `docs/solutions/workflow-issues/comment-only-review-blocked-approval-2026-06-01.md` — a verdict is worthless unless it becomes a real review event; comments do not satisfy branch protection. This is the affirmative case for the change.
- `docs/solutions/workflow-issues/fork-review-guard-gates-approve-only-2026-07-11.md` — the guard must refuse APPROVE only, never all review events. Inherited unchanged.
- `docs/solutions/security-issues/relative-response-file-write-silently-lost-review-2026-08-21.md` — the response file is untrusted: it may supply body and verdict, never the delivery target.
- `docs/solutions/integration-issues/read-only-actions-cache-token-broke-session-continuity-2026-08-11.md` — mention runs cannot persist session state; this design must not depend on it.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "fro-bot/agent: src/features/{agent,reviews,triggers}/, packages/runtime/src/agent/, src/harness/phases/",
  "freshness": {
    "vcs_reference": "bcb4ecbeb"
  },
  "budget": {
    "max_search_passes": 8,
    "max_candidate_inspections": 24,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/features/agent/response-file.ts::resolveResponseSurface",
      "description": "Derives the response surface from trusted routing context; maps only pull_request to pr-review.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/features/triggers/skip-conditions-comment.ts",
      "description": "Gates issue-comment mention runs on bot status, association allowlist, and mention presence.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/features/reviews/review-guards.ts::checkForkOrSelfGuard",
      "description": "Blocks APPROVE on fork and self-authored PRs while permitting REQUEST_CHANGES and COMMENT.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/features/reviews/review-guards.ts::submitReviewWithHeadGuard",
      "description": "Re-fetches the PR head immediately before submission and aborts if it moved, anchoring the review to the observed SHA.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "packages/runtime/src/agent/prompt.ts::buildResponseProtocolSection",
      "description": "Builds the Response Protocol block; currently surface-blind and unconditionally demands a verdict.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/runtime/src/agent/response-file.ts::parseResponseFile",
      "description": "Validates the response file against a caller-supplied surface and rejects a verdict outside pr-review.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/services/github/api.ts::getRepositoryPermission",
      "description": "Resolves a user's repo permission as an association equivalent; used where the webhook association is the PR author's rather than the sender's.",
      "disposition": "insufficient",
      "insufficiency_reason": "Mention runs already carry the comment author's association and are gated on it directly, so an extra API lookup adds a failure mode without adding authority."
    }
  ],
  "excluded_scopes": [
    {
      "scope": "packages/gateway/",
      "reason": "The Discord surface has its own approval coordinator and does not consume the Action's response-file protocol."
    }
  ]
}
```

## Key Technical Decisions

1. **A third state: review *permitted* versus review *required*.** This is the central decision. Making every PR mention a `pr-review` surface would recreate the reported bug in mirror image — a mention asking "what does this do?" would be told a verdict is mandatory, and `response-post.ts:388-397` would fail closed with nothing posted when the model sensibly omitted one. So the surface gains a distinction the current binary cannot express:
   - `pull_request` trigger → review **required** (unchanged; a missing verdict still fails closed, because silently commenting would downgrade a required review while reporting success).
   - authorized mention on a PR → review **permitted**: a verdict submits a real review; no verdict posts a comment. Both are successful deliveries.
   - everything else → comment surface, verdict rejected as today.
2. **Authority comes from the existing trigger gate, not a new check.** `checkIssueCommentSkipConditions` already restricts mention runs to non-bot `OWNER`/`MEMBER`/`COLLABORATOR` authors. A run that reaches execution has already cleared that bar, so the surface derivation may rely on it rather than re-deriving permission. Any additional API lookup would add a failure mode without adding authority.
3. **The surface is computed at the trusted boundary and threaded, not recomputed.** `resolveResponseSurface()` lives in `src/features/agent/` while the prompt builder lives in `packages/runtime/`; the runtime layer must not reach into the Action's routing. The computed `ResponseSurface` is added to `PromptOptions` and passed from `execution.ts`, so prompt, parser, and poster all consume one value derived once from trusted context. The response file still cannot influence it.
4. **Guards are inherited untouched.** `checkForkOrSelfGuard` and `submitReviewWithHeadGuard` already block APPROVE on fork/self PRs and anchor to the observed head. A mention-initiated review passes through the identical path — no bypass, no parallel implementation.
5. **`pull_request_review_comment` gets the contract its surface can honor.** Rather than promoting that trigger to `pr-review`, its `<output_contract>` becomes surface-conditional. Promoting it would widen review authority to inline review comments, which is a separate trust question this plan is not answering.
6. **Degrade rather than discard.** A verdict arriving on a comment surface drops the frontmatter, posts the prose, and warns loudly. Safe in this direction only: there is no review to downgrade. The mirror case — a `pr-review` surface with no verdict where one is required — keeps failing closed.

## Open Questions

### Resolved During Planning

- Does a mention-initiated review need explicit dismissal of the prior `CHANGES_REQUESTED`? No — GitHub scores the latest review per reviewer, so a fresh APPROVE from the same reviewer supersedes it.
- Does head-SHA anchoring need designing? No — `submitReviewWithHeadGuard` already re-fetches and aborts on movement.
- Should the permission bar for submitting a review be tighter than for triggering a run? No. The existing bar is already write-or-above equivalent, and the higher-consequence act (APPROVE on a fork or self-authored PR) is separately blocked by the fork/self guard.

### Deferred to Implementation

- Whether `ResponseSurface` is best threaded as a new `PromptOptions` field or folded into the existing trigger context shape — depends on how the runtime types are consumed by evals and tests.
- Exact wording of the surface-conditional Response Protocol text; it should be written once the three surface states are concrete in code.

## Implementation Units

- [ ] **Unit 1: Surface derivation gains the permitted state**

**Goal:** `resolveResponseSurface()` distinguishes review-required, review-permitted, and comment-only, and classifies an authorized mention on a PR as review-permitted.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/features/agent/response-file.ts`
- Modify: `packages/runtime/src/agent/types.ts` (the `ResponseSurface` union)
- Modify: `packages/runtime/src/agent/response-file.ts` (parser accepts a verdict on the permitted state)
- Test: `src/features/agent/response-file.test.ts`, `packages/runtime/src/agent/response-file.test.ts`

**Approach:**
- Extend the surface union rather than overloading `pr-review` with a boolean, so every consumer must handle the new state explicitly at the type level.
- Derivation reads only trusted routing context; the mention gate having already run is the authorization premise.

**Test scenarios:**
- Happy path: `pull_request` trigger → review-required, unchanged.
- Happy path: `issue_comment` on a PR → review-permitted.
- Edge case: `issue_comment` on an issue → comment surface.
- Edge case: `pull_request_review_comment` on a PR → comment surface (not promoted).
- Error path: parser accepts a verdict on review-permitted, still rejects it on comment surfaces with the existing error.
- Error path: parser accepts a *missing* verdict on review-permitted without erroring.

**Verification:** Every surface state is reachable from a trusted-context fixture, and the parser's accept/reject matrix matches the three states.

- [ ] **Unit 2: Prompt becomes surface-aware**

**Goal:** No run is instructed to emit output its validator will reject.

**Requirements:** R3, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/runtime/src/agent/prompt.ts` (`buildResponseProtocolSection`, the `<output_contract>` attachment at `:439-443`, `buildOutputContractSection`)
- Modify: `packages/runtime/src/agent/types.ts` (`PromptOptions`)
- Modify: `src/features/agent/execution.ts` (thread the computed surface)
- Test: `packages/runtime/src/agent/prompt.test.ts`

**Approach:**
- Gate the verdict instruction and the worked verdict example on the surface permitting one.
- On review-permitted, the text must convey that a verdict is available and what it does — not that it is mandatory — so a question-shaped mention isn't pushed into a review it shouldn't make.

**Test scenarios:**
- Happy path: review-required surface still emits the verdict instruction and example verbatim.
- Happy path: review-permitted surface offers the verdict without demanding it.
- Error path: comment surfaces omit verdict instructions entirely — assert **absence**, which is the coverage gap that let this drift (`prompt.test.ts:2262`, `:2316` only assert presence).
- Edge case: `pull_request_review_comment` receives no verdict-required contract.

**Verification:** For every surface, the prompt's instructions are satisfiable by the parser for that same surface — the contract the two sides share is now the same value.

- [ ] **Unit 3: Deliver a mention-initiated review**

**Goal:** A verdict on a review-permitted surface submits a real review through the existing guarded path; no verdict posts a comment.

**Requirements:** R1, R5

**Dependencies:** Units 1, 2

**Files:**
- Modify: `src/features/agent/response-post.ts` (the no-verdict branch at `:387-405`, the verdict branch at `:407-460`)
- Test: `src/features/agent/response-post.test.ts`

**Approach:**
- Route review-permitted verdicts through `checkForkOrSelfGuard` and `submitReviewWithHeadGuard` unchanged.
- No verdict on review-permitted is a successful comment delivery, not `missing-verdict`.
- Preserve the fallback-artifact rule: a response recovered from a fallback path may never APPROVE.

**Test scenarios:**
- Happy path: approve verdict on review-permitted submits APPROVE anchored to the observed head.
- Happy path: no verdict on review-permitted posts a comment and reports delivered.
- Error path: review-required with no verdict still fails closed as `missing-verdict`.
- Error path: APPROVE on a fork PR from a mention is blocked by the existing guard.
- Error path: APPROVE on a self-authored PR from a mention is blocked.
- Error path: head moved between authorization and submission aborts.
- Integration: a fallback-recovered response carrying `approve` downgrades to COMMENT.
- Security: the response file cannot influence which surface is used — assert the posted target derives from routing context with a hostile file.

- [ ] **Unit 4: Degrade instead of discarding**

**Goal:** A verdict on a comment surface posts the prose with a warning rather than losing the turn.

**Requirements:** R6

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/runtime/src/agent/response-file.ts` or `src/features/agent/response-post.ts` (placement decided at implementation; the degrade must not weaken the parser's surface check for other callers)
- Modify: `src/harness/phases/finalize.ts` (`parse-failed` handling around `:382-405`)
- Test: `src/features/agent/response-post.test.ts`, `src/harness/phases/finalize.test.ts`

**Approach:** Degrade loudly — `logger.warning`, never silent. This is a net for a prompt regression, not a substitute for Unit 2.

**Test scenarios:**
- Happy path: verdict on a comment surface posts the body, warns, reports delivered.
- Error path: the mirror case (missing verdict where required) still fails closed.
- Edge case: `parse-failed` for a reason other than a misplaced verdict still fails the run.

- [ ] **Unit 5: Correct the record**

**Goal:** Documentation matches shipped behavior.

**Requirements:** R7

**Dependencies:** Units 1-4

**Files:**
- Modify: `docs/solutions/workflow-issues/mention-triggered-run-cannot-clear-changes-requested-review-2026-08-12.md`
- Modify: `src/features/agent/AGENTS.md`, `README.md` as the surface states require

**Approach:** The solutions doc records a real incident and its reasoning; rewrite the resolution rather than deleting the history. State what changed, when, and why the original constraint was lifted.

**Test expectation:** none — documentation only.

## System-Wide Impact

- **Interaction graph:** surface derivation feeds prompt construction, response parsing, and delivery. One value, three consumers — the reason it is threaded rather than recomputed.
- **Unchanged invariants:** the association allowlist, bot rejection, mention requirement, APPROVE fork/self guard, head-SHA anchoring, one-response-per-invocation, and the rule that the response file never selects its own target. This plan changes which surface a trusted context yields — nothing about who is trusted.
- **Error propagation:** review submission stays single-attempt (create-review is not idempotent); comments keep bounded retry.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Widening review authority to a comment-initiated flow | Authority unchanged: the same allowlist that already gates mention runs. The higher-consequence act is still blocked by the fork/self guard. |
| A question-shaped mention pushed into an unwanted review | The permitted state offers a verdict rather than demanding one; no-verdict is a successful comment delivery. |
| Surface union change missing a consumer | Extend the union rather than adding a boolean, so the type checker enumerates every consumer. |
| Degrade path masking a future prompt regression | Warn loudly on every degrade; Unit 2's absence assertions are the real guard. |

## Sources & References

- Origin issue: fro-bot/agent#1504, including the maintainer triage that verified defects 1 and 2.
- Related: RFC-006 (association gating), RFC-009 (review features), RFC-016 (additional triggers).
