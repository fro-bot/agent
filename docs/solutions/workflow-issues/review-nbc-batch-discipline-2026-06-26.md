---
title: 'Handle non-blocking review concerns with judgment, batching, and clean public PR artifacts'
date: 2026-06-26
category: workflow-issues
module: pr-review-discipline
problem_type: workflow_issue
component: development_workflow
severity: low
applies_when:
  - 'A reviewer raises a nit or non-blocking concern during PR review'
  - 'The concern is logically part of the current change or already tracked elsewhere'
  - 'A side quest would create more review/CI overhead than value'
  - 'A PR title, body, commit message, or review reply risks narrating internal process'
tags:
  - pr-review
  - nbc
  - non-blocking
  - review-discipline
  - batching
  - pr-hygiene
  - scope-control
---

# Handle non-blocking review concerns with judgment, batching, and clean public PR artifacts

## Context

Non-blocking review concerns are real signals, but treating every one as a separate gate or follow-up creates churn. The useful policy is not “always fix” or “always defer”; it is to classify the concern in context, act when the fix belongs with the current change, track when it does not, and ask Marcus only when the judgment is uncertain.

Public PR artifacts should describe the change, not the private coordination that produced it.

## Guidance

Use this decision order for non-blocking concerns:

1. **Is it logically part of the current change?** Fix it in the current PR. Do not spin out a tiny side PR just to preserve an artificial boundary.
2. **Is it already tracked by an issue or clear follow-up?** Leave it tracked and avoid duplicating the work in the current branch.
3. **Would fixing it broaden the PR into a different problem?** Create or update a follow-up issue instead.
4. **Is the tradeoff unclear?** Ask Marcus with the recommendation first and the specific decision needed.

When the concern is fixed in the current PR, keep the PR body and commits public-facing:

- Say what changed and why.
- Include verification.
- Omit “Marcus said,” “the session decided,” internal review taxonomy, and process narration.

## Why This Matters

Over-splitting creates review and CI overhead for changes that reviewers expect to land together. Over-broadening turns small fixes into kitchen-sink PRs. Over-asking turns Marcus into the routing layer for obvious engineering judgment. Clean public artifacts keep the GitHub record useful for future maintainers and external readers.

The judgment point matters most after structured review: a non-blocking concern can still be worth fixing immediately when it is the same surface, the same invariant, or a missing sibling test. It can also be correctly ignored when the cost is another full CI/review reset for defensive redundancy or pre-existing semantics.

## When to Apply

- After `ce:review`, Fro Bot review, Oracle review, or any reviewer returns non-blocking concerns.
- When deciding whether to fix a sibling behavior in the same branch, create a follow-up issue, or leave a note.
- Before writing PR descriptions, commit messages, or public review replies from a session that involved private coordination.

## Examples

Good current-PR fix:

- A route fix changes `GET /operator/runs` to dedup before capping.
- Review finds `GET /operator/repos` has the same duplicate-binding cap bug.
- Fix both in the branch: same invariant, same surface, same tests.

Good defer:

- Review notes a broader read-amplification/indexing concern.
- The PR fixes cap fairness and preserves response shape.
- Track the scale redesign under the existing follow-up issue instead of expanding the branch.

Good ignore:

- Review notes a redundant defensive dedup guard remains after the main fix.
- It is harmless, covered by tests, and removing it would reset green CI/review for no user-visible value.

Bad public artifact:

```markdown
Marcus told me to batch this NBC after ce:review.
```

Good public artifact:

```markdown
This applies the same dedup-before-cap invariant to both operator listing routes so duplicate bindings cannot consume distinct repo slots.
```

## Related

- [Couple the review verdict to the GitHub review event](comment-only-review-blocked-approval-2026-06-01.md) — the agent-side review-event contract; this doc covers maintainer-side handling of review concerns.
- PR #1038 — example where a sibling non-blocking finding was correctly included in the same branch, while broader scale concerns stayed in #1036.
