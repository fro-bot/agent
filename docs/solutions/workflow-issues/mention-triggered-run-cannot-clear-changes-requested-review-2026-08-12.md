---
title: A mention-triggered run cannot clear a blocking review, by design
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

# A mention-triggered run cannot clear a blocking review, by design

## Context

A PR carried a `CHANGES_REQUESTED` review. Its condition was satisfied **out of band** — the concern was about deployed IAM configuration, resolved by probing the live account. There was no code change to push, so no commit would ever land to re-trigger review naturally.

Mentioning the bot on the PR produced a thorough, correct reply that ended: *"no blockers remain — this is good to merge."* The PR stayed blocked.

The verdict was right. Delivering it as a review was structurally impossible, and no amount of prompting would have changed that.

## Guidance

**The response surface is keyed off the triggering event, not the target.** The whole of `resolveResponseSurface` in `src/features/agent/response-file.ts`:

```ts
if (triggerContext?.eventType === 'pull_request') return 'pr-review'
if (agentContext.issueType === 'pr') return 'pr-comment'
return 'issue-comment'
```

A mention is an `issue_comment` event. It resolves to `pr-comment` — a comment on a PR, never a review. Only a review event supersedes `CHANGES_REQUESTED`; a comment, however well-reasoned, never does.

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

**What resolves it:** re-run the CI job that carries the review. That replays the `pull_request` event, reaches the `pr-review` surface, and produces a real review superseding the stale one.

**What does not:** re-requesting review. The workflow subscribes to a fixed type list in `.github/workflows/ci.yaml`:

```yaml
pull_request:
  branches: [main]
  types: [opened, synchronize, ready_for_review, reopened]
```

`review_requested` is absent, so the request registers on the PR and fires nothing.

Avoid an empty commit to force `synchronize`; it pollutes history to solve a routing problem. If the blocker was resolved outside the diff, dismiss the stale review manually and record the reason on the PR — a human action is the right shape for a condition the diff cannot show.

## Why This Matters

This is a security property, not a defect. A comment-triggered run is initiated by anyone who can comment. If such a run could clear a blocking review, unblocking a PR would be one comment away.

The same rule is stated explicitly in `src/features/reviews/review-guards.ts`, where the fork/self refusal applies only to `APPROVE`: request-changes and comment can only ever block a PR, so they are safe from any source, while approve can unblock and needs the stricter surface. The asymmetry is consistent and deliberate.

The operational trap: **prose agreement from a surface that cannot act looks resolved in the transcript and changes nothing on the PR.** The reply said the blocker was gone. The blocker was not gone. Both were true.

## When to Apply

- Diagnosing a PR that stays blocked after the bot says it should not be
- Designing any agent whose verdict must become a platform event with side effects — check whether the triggering event can reach the surface that emits it, before assuming a prompt fix is possible
- Deciding whether a workflow needs an additional `pull_request` trigger type, versus whether the omission is load-bearing

## Examples

| Trigger | Surface | Can supersede a blocking review |
|---|---|---|
| `pull_request` | `pr-review` | yes |
| `issue_comment` on a PR | `pr-comment` | no |
| `issue_comment` on an issue | `issue-comment` | n/a |

## Related

- [Couple the review verdict to the GitHub review event so PR reviews satisfy branch protection](./comment-only-review-blocked-approval-2026-06-01.md) — the adjacent failure and its prompt-level fix. That one is about an agent *choosing* the wrong delivery when the right one was available; this one is about the right delivery being unreachable from the triggering event. The reconciliation backstop described there explicitly no-ops here.
- [Sender-substituted association breaks mention authority](../logic-errors/sender-substituted-association-breaks-mention-authority-2026-07-17.md) — another case where the trust level of a mention-triggered run is load-bearing.
