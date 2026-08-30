---
title: A mention-triggered run could not clear a blocking review — and the stated reason was wrong
date: 2026-08-12
category: workflow-issues
module: development-workflow
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - A PR carries CHANGES_REQUESTED and the blocking condition was satisfied outside the diff
  - The bot replies to a mention saying no blockers remain, and the PR stays blocked
  - Reasoning about which GitHub event can produce which response surface
  - Designing an agent whose verdict must become a platform event with side effects
tags:
  - pr-review
  - mention-trigger
  - changes-requested
  - event-routing
  - response-delivery
  - security-boundary
---

# A mention-triggered run could not clear a blocking review — and the stated reason was wrong

> **Resolved 2026-08-29 (#1504).** An authorized mention on a PR now resolves to a review-permitted surface and can submit a real review. The original constraint below was real, but the security rationale this doc gave for it was mistaken — see [Why This Matters](#why-this-matters). The incident and the diagnosis are preserved; the guidance is corrected.

## Context

A PR carried a `CHANGES_REQUESTED` review. Its condition was satisfied **out of band** — the concern was about deployed IAM configuration, resolved by probing the live account. There was no code change to push, so no commit would ever land to re-trigger review naturally.

Mentioning the bot on the PR produced a thorough, correct reply that ended: *"no blockers remain — this is good to merge."* The PR stayed blocked.

The verdict was right. Delivering it as a review was structurally impossible, and no amount of prompting would have changed that.

## Guidance

**The response surface is keyed off the triggering event, not the target.** That remains true — but the mapping now distinguishes three states rather than two, in `src/features/agent/response-file.ts`:

```ts
if (triggerContext?.eventType === 'pull_request') return 'pr-review'
if (triggerContext?.eventType === 'issue_comment' && agentContext.issueType === 'pr') return 'pr-review-optional'
if (agentContext.issueType === 'pr') return 'pr-comment'
return 'issue-comment'
```

At the time of the incident the middle case did not exist, so a mention resolved to `pr-comment` and a verdict was rejected outright — the run reached a conclusion and delivered nothing at all.

The distinction that was missing is **required** versus **permitted**. A `pull_request` run must produce a verdict; a missing one fails closed, because silently commenting would downgrade a required review while reporting success. A mention may produce one: a verdict submits a real review, and its absence posts a comment. Collapsing both into one surface is what made the capability unreachable — and promoting mentions to review-*required* instead would have been the same bug mirrored, forcing a verdict out of a run that was only ever asked a question.

**The reconciliation backstop does not rescue this.** It no-ops on the same distinction, in `src/harness/phases/review-reconciliation.ts`:

```ts
if (isFileConventionDelivery === true) {
  return {reconciled: false, reason: 'finalize-owns-response'}
}

if (isPullRequestReviewTrigger === false) {
  return {reconciled: false, reason: 'not-pr-review-trigger'}
}
```

where `isPullRequestReviewTrigger` is derived in `src/harness/run.ts` as `triggerContext.eventType === 'pull_request'`.

**What resolves it now:** mention the bot. An authorized mention reaches the review-permitted surface and submits a real review, which supersedes the stale one — GitHub scores the latest review per reviewer, so no explicit dismissal is needed.

**What resolved it before:** re-running the CI job that carries the review, replaying the `pull_request` event to reach the `pr-review` surface.

**What does not:** re-requesting review. The workflow subscribes to a fixed type list in `.github/workflows/ci.yaml`:

```yaml
pull_request:
  branches: [main]
  types: [opened, synchronize, ready_for_review, reopened]
```

`review_requested` is absent, so the request registers on the PR and fires nothing.

Avoid an empty commit to force `synchronize`; it pollutes history to solve a routing problem. If the blocker was resolved outside the diff, dismiss the stale review manually and record the reason on the PR — a human action is the right shape for a condition the diff cannot show.

## Why This Matters

The original version of this doc called the restriction a security property and justified it this way:

> A comment-triggered run is initiated by anyone who can comment. If such a run could clear a blocking review, unblocking a PR would be one comment away.

**That premise was false when written.** `checkIssueCommentSkipConditions` in `src/features/triggers/skip-conditions-comment.ts` rejects bot authors and any association outside `OWNER`, `MEMBER`, `COLLABORATOR` — before the run ever executes. A mention run has never been reachable by "anyone who can comment." The surface restriction was not what made mentions safe; the association gate was, and it already existed.

The lasting lesson is not about review surfaces. It is that **a constraint can be correct while the reason given for it is wrong**, and the wrong reason is what survives in documentation and blocks the fix. This doc argued the restriction was load-bearing security. It was actually an unfinished capability wearing a security justification — and that framing is why the gap sat unaddressed while the machinery to close it safely was already in the codebase.

When recording a constraint as deliberate, state which mechanism enforces the property and check that it is the one you are naming. Had this doc traced the actual gate, it would have documented a missing feature rather than a security boundary.

The genuine security property is narrower and unchanged: `src/features/reviews/review-guards.ts` refuses `APPROVE` on fork and self-authored PRs while permitting request-changes and comment, because only approve can unblock. Mention-initiated reviews traverse that identical guard, plus the head-SHA re-check that anchors a review to the tree it was made against.

The operational trap from the incident still stands: **prose agreement from a surface that cannot act looks resolved in the transcript and changes nothing on the PR.** The reply said the blocker was gone. The blocker was not gone. Both were true.

## When to Apply

- Diagnosing a PR that stays blocked after the bot says it should not be
- Designing any agent whose verdict must become a platform event with side effects — check whether the triggering event can reach the surface that emits it, before assuming a prompt fix is possible
- Deciding whether a workflow needs an additional `pull_request` trigger type, versus whether the omission is load-bearing

## Examples

| Trigger | Surface | Verdict | Can supersede a blocking review |
|---|---|---|---|
| `pull_request` | `pr-review` | required | yes |
| authorized `issue_comment` on a PR | `pr-review-optional` | permitted | yes |
| `pull_request_review_comment` | `pr-comment` | rejected | no |
| `issue_comment` on an issue | `issue-comment` | rejected | n/a |

`pull_request_review_comment` is deliberately not promoted: widening review authority to inline review comments is a separate trust question.

## Related

- [Couple the review verdict to the GitHub review event so PR reviews satisfy branch protection](./comment-only-review-blocked-approval-2026-06-01.md) — the adjacent failure and its prompt-level fix. That one is about an agent *choosing* the wrong delivery when the right one was available; this one is about the right delivery being unreachable from the triggering event. The reconciliation backstop described there explicitly no-ops here.
- [Sender-substituted association breaks mention authority](../logic-errors/sender-substituted-association-breaks-mention-authority-2026-07-17.md) — another case where the trust level of a mention-triggered run is load-bearing.
