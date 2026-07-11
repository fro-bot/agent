---
title: A harness carry must clear a value bar, not just a safety bar
date: 2026-07-11
category: best-practices
module: harness-carries
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - Selecting upstream PRs to carry into the patched OpenCode harness build
  - An upstream fix is verified safe but its motivating bug does not affect our surfaces
tags:
  - harness
  - carry-policy
  - upstream
  - opencode
  - risk-value
---

# A harness carry must clear a value bar, not just a safety bar

## Context

The patched OpenCode harness build periodically pulls in upstream PRs ("carries") on top of a version bump. Each candidate carry has to be evaluated for whether it's safe to include — but safety alone is not sufficient grounds to include it.

## Guidance

During the 1.17.18 bump, upstream PR #35913 (removes the `/event` SSE directory filter for worktree sessions) was semantics-checked and verified safe for both consumers of that stream: every actionable branch in `src/features/agent/streaming.ts` and `packages/gateway/src/execute/run-core.ts` gates on `sessionID` before acting, so removing the directory filter couldn't cause either consumer to act on the wrong session's events.

It was still excluded, because:

- It fixes a worktree bug that doesn't affect our surfaces — we don't hit the failure mode it addresses.
- It *removes* a directory-scoping bandwidth benefit we actively rely on: shared servers handling multiple directories filter SSE traffic by directory today, and dropping that filter means more irrelevant event traffic reaching every consumer.
- It had zero human review engagement upstream — no linked issue discussion, no reviewer sign-off, just green CI.

The bar for a carry is two independent conditions, both required:

1. **Safe for our surfaces** (necessary, not sufficient) — verify every consumer of the changed behavior handles it correctly.
2. **Net positive value for our use** (only meaningful once 1 holds) — does it fix something we hit, or does it trade away a benefit we rely on?

Weight both against the upstream sourcing quality: review engagement, a linked issue, and green CI raise confidence in the underlying claim, but don't substitute for evaluating value on their own.

## Why This Matters

"Safe to include" answers only "will this carry break something," not "should this carry exist in our build." Treating safety as sufficient produces a harness that silently drifts toward every upstream change that happens not to break anything — including changes that remove capabilities we depend on, in service of fixing bugs we never had. Carries should shrink the delta from upstream only when that delta is actively costing us something; otherwise every unnecessary carry is a permanent maintenance liability with no offsetting benefit.

## When to Apply

Any time a patched/forked dependency is deciding whether to pull in an upstream change:

- Reviewing upstream PRs as harness carry candidates
- Auto-merge or bot-assisted dependency update pipelines that filter by "CI green" or "no breaking changes"
- Vendor/fork maintenance where the pull-in decision is being made by a different person than the one who reviews for safety

Quick checklist before accepting a carry:

- [ ] Confirmed safe: every consumer of the changed behavior in our codebase was checked, not assumed
- [ ] States what bug or gap it fixes *for us specifically* — not just "fixes a bug upstream"
- [ ] Identifies anything the change removes or weakens that we currently rely on
- [ ] Upstream sourcing quality noted (review engagement, linked issue, CI status) as a confidence signal, not a decision criterion on its own

## Related

- [Harden the runner: a literal YAML scalar silently drops allowed endpoints](../workflow-issues/harden-runner-allowed-endpoints-literal-scalar-drops-endpoints-2026-07-07.md) — another case where "technically works" was insufficient without checking the actual value/effect delivered.
- [Cross-libc build and release safety](./cross-libc-build-and-release-safety-2026-06-14.md) — related harness-build decision discipline.
