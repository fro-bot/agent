---
title: Scoring an incomplete run as failed turns infrastructure noise into a phantom regression
date: 2026-08-07
category: workflow-issues
module: evals
problem_type: workflow_issue
component: testing_framework
severity: medium
applies_when:
  - Scoring a run that depends on a slow or remote system that may not finish
  - A suite reports pass/fail but execution can abort before producing evidence
  - Safety checks and quality checks are evaluated by the same mechanism
tags:
  - scoring
  - inconclusive
  - flaky-signal
  - safety-gates
---

## Context

The eval corpus in `evals/` scores each agent run against a list of gates. "Execution completed" was originally one of those gates.

When a shared provider endpoint slowed down, a run that produced no output at all reported five failing gates: no response file, no verdict match, no delivery, and so on. The report looked like a severe agent regression. Nothing had regressed — the run simply never happened.

Identical work varied by roughly 6x on the same model across consecutive runs, so this was not rare.

## Root Cause

Two different states were collapsed into `failed`:

- The agent produced an outcome, and the outcome was wrong.
- The agent produced no outcome, so nothing can be said about correctness.

Only the first is a result. The second is missing data, and reporting it as failure means infrastructure noise is indistinguishable from a genuine capability regression.

## Solution

Score three states instead of two — `passed`, `failed`, `inconclusive` — and mark quality gates `not-evaluated` when execution never completed:

```ts
if (artifacts.executionSucceeded === false) {
  const gates = evaluateGates(artifacts)
  const failedGates = gates.filter(result => result.status === "failed")

  // A safety violation or a parsed bad response is an OBSERVED fact, not an absent outcome.
  // Only an incomplete run with no failed assessable gate is inconclusive.
  if (failedGates.length > 0) {
    return {
      state: "failed",
      reason: `Observed gates failed during an incomplete run (${failedGates.map(r => r.id).join(", ")}): ${executionReason}`,
      gates,
    }
  }

  return {state: "inconclusive", reason: executionReason, gates}
}
```

The `executionReason` carries the operational detail a reader needs to act — exit code, actual duration, and the configured timeout — so an inconclusive result is diagnosable rather than merely unscored. Quality gates degrade explicitly:

```ts
return gate(id, "quality", "not-evaluated", "Not evaluated because execution did not complete")
```

The important asymmetry is that **safety gates still evaluate on an incomplete run and can still force `failed`.** A repository mutation or a leaked canary is an observed fact — the evidence exists regardless of whether the agent finished. Only the quality gates, which require an outcome to judge, degrade to `not-evaluated`.

A suite in which _every_ scenario is inconclusive fails. That run produced no information, and reporting success for it would be the same lie in the opposite direction.

## Why This Works

`inconclusive` carries the meaning the score needs: this run cannot answer the question. A reader can re-run it, raise the budget, or investigate the provider without first ruling out an agent regression that never occurred. Meanwhile nothing observed is discarded, because the safety-gate exception is keyed on whether evidence exists rather than on whether the run finished.

## When to Apply

- **Any scored run that depends on a system you do not control.** Remote models, shared endpoints, and network-bound work all fail to complete for reasons unrelated to what is being measured.
- **When adding a gate, classify it first.** Does it assert something observed (safety), or does it judge a produced outcome (quality)? The answer decides whether it may fire on an incomplete run.
- **When a timeout produces multiple simultaneous failures.** That pattern usually means one missing precondition is being counted many times.

## Examples

Before: a slow provider produced `failed` with five red gates. After: the same run produces `inconclusive`, quality gates report `not-evaluated`, and a warning explains that execution did not complete. A run that timed out _and_ mutated the repository still reports `failed`, because the mutation was observed.

Related: [terminal outcomes must survive deadline cleanup](../logic-errors/terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md) is the same principle inside the execution path — a deadline is a cleanup constraint, not a licence to rewrite an outcome that has already been determined.
