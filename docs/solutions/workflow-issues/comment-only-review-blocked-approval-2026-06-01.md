---
title: Couple the review verdict to the GitHub review event so PR reviews satisfy branch protection
date: 2026-06-01
category: docs/solutions/workflow-issues
module: pr-review-prompt-contract
problem_type: workflow_issue
component: assistant
severity: medium
related_components:
  - development_workflow
  - tooling
applies_when:
  - The agent reports a clear PASS verdict but submits a comment-only review
  - Branch protection requires an approval event before merge
  - The review prompt separates the verdict text from the GitHub review action
  - Any agent-driven verdict maps to a platform action with side effects
root_cause: missing_workflow_step
resolution_type: workflow_improvement
tags:
  - github-actions
  - pull-request-review
  - branch-protection
  - approval-event
  - prompt-contract
  - workflow-routing
  - agent-native
---

# Couple the review verdict to the GitHub review event so PR reviews satisfy branch protection

## Context

When the Fro Bot GitHub Action reviews a pull request, the agent reaches a clear verdict — PASS, CONDITIONAL, or REJECT — and writes it as a `## Verdict:` heading in the review body. But it was delivering that verdict as a **comment-only** review (`gh pr review --comment`). GitHub branch protection keys off the review *event* (APPROVED / CHANGES_REQUESTED), not the prose in the body, so a comment-only "PASS" never satisfied the required-approval gate. Passing PRs stayed blocked on "review required" until a human approved them manually.

This surfaced live on PR #722 (two consecutive PASS verdicts delivered as COMMENTED events) and earlier on clean docs-only PRs.

## Guidance

If the agent is acting as a requested reviewer and reaches a verdict, it **must emit the GitHub review event that matches that verdict**:

| Verdict | Required event |
|---|---|
| PASS | `gh pr review --approve` |
| CONDITIONAL | `gh pr review --request-changes` |
| REJECT | `gh pr review --request-changes` |

A comment-only review is acceptable **only when no verdict can be reached** — it is never a valid delivery for the structured PASS / CONDITIONAL / REJECT contract. The escape-hatch wording that allowed "otherwise comment-only" must not exist in the prompt.

The fix lives entirely in the prompt, applied in the three places that govern PR-review behavior in `packages/runtime/src/agent/prompt.ts` — the `pull_request` trigger directive, the Response Protocol, and the Output Contract — plus a reinforcing line in `.github/workflows/ci.yaml`'s `PR_REVIEW_PROMPT`. The post-fix wording reads:

> Submit your review via `gh pr review` and choose the event that matches your verdict: `--approve` for a PASS verdict, `--request-changes` for a CONDITIONAL or REJECT verdict. A comment-only review does NOT satisfy a requested review and leaves the PR blocked on review-required. Once you reach a verdict you MUST approve or request changes — never deliver a verdict as a plain comment.

## Why This Matters

GitHub branch protection counts the **review event**, not the body text. A well-written "PASS" comment is not an approval. Because the agent itself emits the `gh pr review` command inside its session — the harness `submitReview()` is dumb transport that forwards whatever event it is handed — **the prompt is the only lever** that controls whether the final action is an approval, a change request, or dead-end commentary. If the prompt leaves an escape hatch, the system takes it by default and the PR stalls.

Operationally, stuck PRs waste operator time, register as false negatives in CI, and make the bot look flaky even when it reached the correct verdict.

## When to Apply

Anywhere an agent produces a verdict that maps to a platform action with side effects, keep the result and the emitted event coupled in the prompt contract:

- Code review systems (approve / request-changes)
- Approval / rejection workflows with state transitions
- Ticket triage that auto-transitions issue state
- Moderation decisions
- Any agent-driven surface where the "text result" and the "final API event" must not drift apart

## Examples

**Before** — open escape hatch in the directive:

```
Review action: approve/request-changes if confident; otherwise comment-only
```

The agent routinely "solved" the review by commenting instead of submitting the required event.

**After** — explicit verdict→event mapping, no comment-only fallback for verdicts:

```
PASS                 → gh pr review --approve
CONDITIONAL / REJECT → gh pr review --request-changes
(comment-only        → only when no verdict can be reached)
```

**Live validation** — after the fix merged (PR #723), Fro Bot reviewed both PR #723 and PR #722 with the new prompt and emitted real APPROVED events. On #722 it even self-narrated the behavior change ("my two prior reviews (PASS, comment-only)"). Same agent, same PR class that had been getting comment-only PASSes — now an approval event that clears branch protection.

## Caveat

This is a prompt-level fix: it sharply reduces the failure but cannot *guarantee* LLM compliance. The fully robust backstop would be a harness guardrail that parses the agent's verdict and reconciles it against the emitted `gh` event before the review is sent. That was deferred because the agent emits the event directly via `gh`, so the prompt is the immediate control point — escalate to a guardrail only if the failure recurs after this fix.

## Related

- [Delivery-mode contract for manual triggers](./delivery-mode-contract-for-manual-triggers-2026-04-17.md) — the same principle applied to a different prompt contract: make the intended action explicit rather than leaving the agent to infer it from heuristics.
- [Discord slash-command orchestration patterns](../best-practices/discord-slash-command-orchestration-patterns-2026-05-27.md) — agent-driven actions that must couple a decision to a platform side effect.
