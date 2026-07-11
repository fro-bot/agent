---
title: A fork/self PR review guard must refuse APPROVE only, not all review events
date: 2026-07-11
category: workflow-issues
module: pr-review-guards
problem_type: workflow_issue
component: development_workflow
severity: high
related_components:
  - authentication
applies_when:
  - An automated reviewer can emit GitHub review events on PRs from forks or self-authored PRs
  - Branch protection counts APPROVE events toward required approvals
  - A guard is being added or refactored around automated review submission
tags:
  - fork-pr
  - branch-protection
  - review-guard
  - approve
  - request-changes
---

# A fork/self PR review guard must refuse APPROVE only, not all review events

## Context

An automated reviewer that can submit GitHub review events on pull requests needs a guard against reviewing forks and self-authored PRs — but "needs a guard" is not the same as "must refuse all review activity." The threat only exists on one of the three review events GitHub supports.

## Guidance

Only `APPROVE` is dangerous on a fork or self-authored PR: it is the only event that can satisfy branch protection and unblock merging attacker-controlled fork content, or let the bot self-approve its own PR. `REQUEST_CHANGES` and `COMMENT` can only ever block a PR, never unblock one — they are safe to submit on any PR, fork or not.

A guard that refuses all review events on forks breaks every legitimate fork-PR review: requesting changes on a fork PR would fail delivery and fail the run, even though request-changes carries no risk.

Correct shape (`checkForkOrSelfGuard` in `src/features/reviews/review-guards.ts`): the fork/self refusal lives *inside* `if (event === 'APPROVE')`. All events — including the ones allowed to proceed on a fork — still get the head-SHA guard: the PR's current head SHA is fetched and returned so the caller can bind `submitReviewWithHeadGuard`'s submission to the SHA that was actually reviewed, closing the TOCTOU window where a push lands between review and submit.

```ts
if (event === 'APPROVE') {
  if (isSelfAuthored) return {allowed: false, reason: 'self-or-fork'}
  if (isFork) return {allowed: false, reason: 'self-or-fork'}
}
return {allowed: true, currentHeadSha}
```

## Why This Matters

Gating on the event, not the PR, keeps the guard's blast radius equal to the actual risk. A blanket refusal on any fork/self PR looks conservative but silently disables a category of legitimate, risk-free reviewer behavior (blocking bad fork PRs with request-changes) — which is precisely the behavior most worth keeping on fork PRs, since forks are exactly where a reviewer's ability to say "no" matters most.

## When to Apply

Any automated review or approval system where:

- Some outcomes of the decision are safe regardless of trust level (block/deny) and some are unsafe (approve/unblock)
- A guard is being written or refactored around the side-effecting action

Gate on the *specific outcome that carries risk*, not on the presence of an untrusted actor. Apply the same reasoning to any binary-risk action set — refunds vs. charges, deletes vs. reads, merges vs. comments.

## Examples

**Wrong** — refuses all events on a fork/self PR:

```ts
if (isSelfAuthored || isFork) {
  return {allowed: false, reason: 'self-or-fork'}
}
```

A legitimate `REQUEST_CHANGES` on a malicious fork PR now fails to deliver.

**Right** — refusal scoped to the one risky event:

```ts
if (event === 'APPROVE' && (isSelfAuthored || isFork)) {
  return {allowed: false, reason: 'self-or-fork'}
}
```

## Related

- [Couple the review verdict to the GitHub review event so PR reviews satisfy branch protection](./comment-only-review-blocked-approval-2026-06-01.md) — the other half of the verdict→event contract this guard protects.
- [Treat a model-authored response file as untrusted input and bind posting to the trusted event context](../best-practices/response-file-is-untrusted-input-2026-07-11.md) — the response file supplies the verdict this guard ultimately gates.
