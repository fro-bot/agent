---
title: An eval prompt that states the expected finding measures obedience, not judgment
date: 2026-08-07
category: best-practices
module: evals
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - Writing scenarios that score an agent's judgment rather than its compliance
  - A benchmark pairs a "good" and a "bad" case that the agent must tell apart
  - Scenario prompts and scorer expectations live in the same file
tags:
  - agent-evals
  - scenario-design
  - benchmark-gaming
  - prompt-design
---

## Context

The agent-outcome eval corpus in `evals/` scores whether the agent reviews a pull request well. Two scenarios were written first: `clean-pr`, whose change is correct, and `planted-defect`, whose change inverts a comparison so adults are rejected.

Both prompts told the agent what it was supposed to conclude:

```text
planted-defect: "The change contains one unambiguous correctness defect;
                 issue a blocking verdict and identify the file containing it."

clean-pr:       "This change is expected to be clean; do not invent a blocking finding."
```

`planted-defect` also listed `.env.example`, `src/access.ts`, and `src/access.test.ts` in its diff metadata, leaving exactly one plausible place for a correctness defect.

An agent that read nothing could therefore emit `verdict: request-changes` with a body naming `src/access.ts` and pass every gate. An agent that always approves passed `clean-pr` for the same reason. The corpus scored compliance with a hint, which is the failure it existed to prevent.

## Guidance

Make paired scenarios **differential**: identical in everything the agent can observe, differing only in the fact under test.

Share the prompt and the diff metadata from one module so they cannot drift:

```ts
// evals/scenarios/shared.ts
export const NEUTRAL_REVIEW_PROMPT =
  "Review this pull request for correctness. Inspect the changed files and their tests. " +
  "Do not modify the repository. Deliver the required PR review response."

export const SHARED_DIFF_FILES: readonly DiffFileSummary[] = [
  {filename: "src/access.ts", status: "added", additions: 3, deletions: 0},
  {filename: "src/access.test.ts", status: "added", additions: 4, deletions: 0},
]
```

The scenarios then differ in repository content alone — `return age >= 18` versus `return age < 18` — and keep expectations in scorer-owned metadata the agent never sees (`expectedVerdict`, `expectedDefectFile`).

Keep the gate honest too. Matching only the defect's file path passes if the agent simply names every changed file, so the gate additionally requires an observable signature of the defect itself — the operator, or the behavioural consequence — accepting several phrasings rather than one exact string.

## Why This Matters

A rubber-stamp agent now fails `planted-defect`. An over-eager agent now fails `clean-pr`. Neither outcome can be reached by reading the prompt, so the score reflects whether the agent actually inspected the code.

The failure is quiet: every gate stays green, the suite reports success, and confidence in the corpus grows while it measures nothing. It also inverts model comparisons. A weak model that answered from the prompt scored well, while a stronger model that investigated timed out and scored worse — the corpus was rewarding the lazier agent.

## When to Apply

- Any paired scenario where one case should pass and the other should fail. If the prompts differ, ask what the agent could conclude from the prompt alone.
- Any gate matching a file path, identifier, or label that appears in the prompt or diff metadata. Require a signal that only inspection could produce.
- Any scenario file where the prompt sits next to the expected verdict. Physical proximity is how the answer leaks in.

The check is mechanical: **strip the repository content and ask whether the expected answer is still derivable.** If it is, the scenario is scoring obedience.

## Examples

Validated empirically. With the leaked prompts, both scenarios passed — but that result proved nothing. With the neutral prompt, `anthropic/claude-sonnet-5` still passed both (90s and 104s), identifying the swapped comparison without being told a defect existed and approving the clean change without being told it was clean.

Related: [an identical benign prompt isolates a provider outage from an agent regression](../integration-issues/review-model-outage-diagnostic-2026-08-03.md) applies the same "hold everything constant except the variable under test" discipline to diagnosis rather than scoring.
