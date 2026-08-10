---
title: Intermittent failures wearing a deterministic signature
date: 2026-08-07
category: best-practices
module: harness-release
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - "An error string matches a previously documented deterministic failure"
  - "Consecutive attempts fail and the same signature appears in both"
  - "The visible error is a generic status code with no provider-level detail"
tags:
  - diagnosis
  - flake-vs-deterministic
  - error-signature
  - root-cause
  - reproduction
---

# Intermittent failures wearing a deterministic signature

## Context

A release pipeline failed twice in a row. The second failure surfaced `APIError; status=400`, which exactly matched the signature of a previously documented, genuinely deterministic provider outage. Two consecutive failures plus a known signature looked conclusive, so the investigation went to the provider and the infrastructure that fronts it.

It was the wrong system. The next attempt ran the full multi-minute workload normally on the same model. The 400 was intermittent and self-cleared, while the two actual defects were both in the repository.

## Guidance

**A matching error signature is not a matching root cause. Before reusing a documented signature, confirm the failing _stage_ matches, not just the error string.**

The heuristic being applied — _"a flake does not reproduce identically minutes later, so identical reproduction means a systematic cause"_ — is sound, but it carries a precondition that is easy to drop: the two failures have to be the **same failure**. Same stage, same operation.

That precondition did not hold here:

| Attempt | Failing stage                   | Error                        |
| ------- | ------------------------------- | ---------------------------- |
| 1       | git push to the integration ref | remote rejected (permission) |
| 2       | agent session start             | `APIError; status=400`       |

Two different stages, two different subsystems, two unrelated defects. Nothing reproduced. The word "again" was doing unearned work.

Practical checks before declaring a failure systematic:

- **Compare stages, not strings.** Which step failed? Did both attempts get equally far?
- **Compare durations.** A run that dies in 50 seconds and one that dies after 15 minutes are not the same failure, whatever they print.
- **Get the real error before theorizing.** A generic status code is not a root cause. If the detailed provider error only exists in a log artifact, capture the artifact first — reasoning from the status code alone is how a signature match becomes a false identification.
- **Prefer the boring explanation for a lone transient.** One unreproduced error is a flake until a second attempt fails _the same way at the same place_.

## Why This Matters

Misclassifying an intermittent failure as a known deterministic one is expensive in a specific way: it feels like progress. The signature match supplies a ready-made causal story and a ready-made owner, so effort flows to another team's system while the real defects — in this case two of them, both local — stay unexamined. It also risks "fixing" something that was never broken.

The cost here was a wasted investigation lane and a near-miss recommendation to change provider configuration that had nothing to do with the outage.

## When to Apply

- Any time a failure is matched against a documented signature, especially one that names an external system as the owner.
- When consecutive CI failures tempt a "this is systematic" conclusion.
- Before escalating to, or filing against, another repository or team.

## Examples

Discriminating evidence that should have been checked first:

```bash
# Which step failed, and how long did the job actually run?
gh run view <run-id> --json jobs \
  --jq '.jobs[] | {name, conclusion, startedAt, completedAt,
                   failedStep: ([.steps[]? | select(.conclusion=="failure") | .name] | first)}'
```

If the failing step differs between attempts, stop treating them as one incident.

## Related

- [Diagnosing a review-model outage](../integration-issues/review-model-outage-diagnostic-2026-08-03.md) — the genuinely deterministic outage this signature came from, and the origin of the reproduction heuristic this doc qualifies.
- [A failed run reported success because it had no delivery surface](../logic-errors/failed-run-reported-success-with-no-delivery-surface-2026-08-07.md) — why the real provider error was unavailable at the moment the misdiagnosis was made.
