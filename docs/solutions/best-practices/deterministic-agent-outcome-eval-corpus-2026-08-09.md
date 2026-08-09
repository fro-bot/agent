---
title: Build agent eval corpora around observable outcomes
date: 2026-08-09
category: best-practices
module: evals
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - Building a live agent-outcome regression corpus for harness behavior
  - Scenarios must remain small, read-only, and manually reviewable
  - Baselines need deterministic provenance and safe diagnostic evidence
tags:
  - agent-evals
  - outcome-gates
  - deterministic-provenance
  - tri-state-results
  - diagnostic-redaction
---

# Build agent eval corpora around observable outcomes

## Context

The harness flexibility plan proposed eight live scenarios, but the initial eval runner and scorer were specific to pull-request review. Several planned scenarios also depended on signals a live model could not produce reliably: an intentionally malformed response, silence about irrelevant context, deference to an untrusted comment, or safely contained repository mutation.

Trying to preserve that inventory would have turned `evals/` into a general eval platform while producing gates that rewarded hints, silence, or a particular tool choice. The accepted U1 corpus instead contains six read-only live scenarios, deterministic response-fault tests, pure outcome gates, tri-state results, deterministic provenance, and a sanitized reviewed baseline.

## Guidance

### Keep scenario inputs declarative and expectations outcome-based

A scenario describes only the fixture repository and trusted context presented to the agent. Expectations stay in scorer-owned metadata the agent never sees: the expected verdict, required evidence groups, mutation and leakage constraints, and baseline provenance.

For paired scenarios, hold the prompt, event shape, file list, and diff metadata constant; vary only the repository fact under test. Otherwise the prompt can leak the expected verdict and the scenario measures obedience rather than judgment.

### Gate observable outcomes, not method or prose absence

`evaluateGates()` scores a small fixed contract:

- the response file parses
- the structured verdict matches
- exactly one response artifact exists
- each required evidence group has at least one matching signal
- the fixture repository was not mutated
- the planted canary did not leak

Required signals are presence checks for evidence the answer is obligated to cite. They prove that evidence was accessed, not that the model applied it perfectly. Free-form absence checks are deliberately excluded: a model may name irrelevant context while correctly explaining why it does not apply.

The corpus also avoids tool-call counts, investigation order, reasoning shape, exact prose, and timing thresholds. Those are methods or provider characteristics, not the requested outcome.

### Separate failed outcomes from missing outcomes

Live execution can fail to produce an assessable result without demonstrating an agent regression. Preserve three suite states: `passed`, `failed`, and `inconclusive`.

Safety gates still run after incomplete execution because mutation and leakage remain observable facts. Response-based quality gates run after completed execution, and also run for incomplete execution when a response exists and parses. The corpus command is green only when the suite is `passed`; an inconclusive scenario cannot be promoted into the reviewed baseline.

### Use deterministic tests for deterministic fault paths

Missing, empty, malformed, and unknown-verdict response files are runner/parser behaviors. A live model cannot be reliably instructed to fail in those exact ways without leaking the expected failure into its prompt. Characterization tests inject those faults directly instead of spending a live-scenario slot on model-dependent misbehavior.

Use live scenarios only where model judgment is the signal under test. Use ordinary tests for parser failures, orchestration boundaries, gate truth tables, and baseline validation.

### Treat evidence authority and containment as separate design problems

An untrusted comment can provide context, but it cannot become the sole authority for a blocking verdict. The `unchanged-constraint-violation` scenario places the decisive policy in an unchanged repository file, where the agent must discover and cite it.

Similarly, OpenCode permission rules are not a host sandbox. The proposed mutation scenario was removed because the runner detects final repository state but does not provide OS-level containment; OpenCode still runs with the host user's authority. Detecting a final working-tree change is not containment.

The bounded corpus therefore remains read-only. A future mutation scenario requires OS-level process and filesystem isolation, not more allowlist code inside the runner.

### Make baseline provenance reviewable

`buildDeterministicScenarioProvenance()` reconstructs each fixture repository with deterministic commit identity and hashes a canonical prompt that excludes per-run paths and session identifiers. Baseline promotion then requires:

- a completed report with the expected completion marker
- a passed suite and one passed report per registered scenario
- exact scenario IDs and registry order
- common model, harness, plugin, and timeout values
- no retained diagnostics
- source prompt hashes and fixture SHAs matching freshly derived provenance

The committed baseline contains only allowlisted outcome and provenance fields. Durations, costs, token counts, timestamps, diagnostics paths, response bodies, and machine-specific paths are excluded.

Pinned provenance makes a result reviewable and comparable. It does not guarantee identical provider behavior across machines or dates.

### Validate the committed baseline against independently derived provenance

Promotion-time validation is not a standing gate. Between promotions, an ordinary prompt edit silently invalidates every recorded hash, and nothing fails until someone re-records the baseline.

The first version of the integrity check compared the committed baseline against a table of constants that had been copied out of that same baseline. It could only ever confirm the file agreed with itself. A later prompt change drifted all six recorded prompt hashes while the check stayed green — the same self-confirming failure described in [non-failing gates are worse than no gates](../workflow-issues/non-failing-gates-are-worse-than-no-gates-2026-08-07.md).

The fix is to derive the expected value independently rather than restate it. The check now recomputes provenance from the live scenario registry and hard-compares, naming the scenario and both hashes on failure:

```ts
const liveProvenance = ALL_SCENARIOS.map(scenario => buildDeterministicScenarioProvenance(scenario, logger))
```

Delete duplicated constants that a live value can reproduce. Keep a constant only where nothing can derive it: the recorded run commit identifies which commit produced the reviewed run, so it stays pinned by hand and forces a conscious update whenever the baseline is re-recorded.

A prompt change therefore has an honest cost — a fresh run, a re-recorded baseline, and updated byte pins. Document those steps together, because a contributor who follows a partial checklist hits an unexplained failure in a test they did not touch.

The order matters, because the baseline is legitimately stale in the middle of it:

1. Commit the code change. The recorded run commit is read from `HEAD`, so the tree must be clean and the change must already be in history.
2. Run the corpus once at that commit.
3. Promote the baseline from the completed report.
4. Commit the baseline, and update the recorded run commit that is pinned by hand.

Between steps 1 and 4 the integrity check fails on purpose, and any hook that runs it fails with it. Expect that window, keep it short, and do not resolve it by editing the baseline directly — a hand-edited baseline is no longer evidence of a run that happened.

### Capture diagnostics as bounded evidence, not proof of isolation

Failed and inconclusive runs need enough evidence to distinguish a provider failure, wrong working directory, permission stall, and model regression. `captureDiagnostics()` therefore accepts only immediate expected log files, skips directories and symlinks, redacts known and credential-shaped secrets before bounding content, caps the total retained bytes, and writes files with restrictive permissions.

Diagnostics remain gitignored and cannot be promoted into a baseline. This reduces retention risk; it does not make a live run safe. The agent still runs with the host user's authority, so live corpus runs belong on a disposable machine or container when the host contains sensitive data.

Provider authentication is a separate boundary from GitHub mutation authority. The runner may copy one provider entry and load its required auth plugin inside the isolated home, while still removing `GH_TOKEN` and `GITHUB_TOKEN` so the agent has no GitHub write credential.

## Why This Matters

An eval corpus can stay green while measuring nothing. Answer-revealing prompts reward compliance. Absence gates reward silence. Boolean verdicts convert provider failures into false regressions. Unstable hashes make baseline drift look meaningful. Raw diagnostics turn a failed run into a credential-retention risk. Permission configuration can create a false claim of containment.

A small outcome corpus avoids those traps by making every live scenario answer one reviewable question: did the agent produce the required observable result from the evidence it was given, without mutation or leakage?

## When to Apply

- A real model executes the production harness path against disposable fixtures.
- The behavior under test depends on repository evidence or supplied context, not a deterministic parser branch.
- A baseline must survive review across model, harness, plugin, prompt, or scenario changes.
- Failure evidence may contain provider logs, response bodies, paths, or credentials.
- A proposed scenario needs mutation, external side effects, or untrusted prose as verdict authority; treat that as a stop condition until the boundary is made structurally sound.

## Examples

The reviewed U1 baseline contains six scenarios covering clean and defective PR review, issue answers grounded in known files, relevant and irrelevant continuation context, and a constraint stored outside the diff. The authoritative run passed all six with `anthropic/claude-sonnet-5` on `1.18.14+harness.202732ae`; the committed baseline additionally pins the configured auth plugin, prompt hashes, fixture SHAs, and passed gate IDs.

The corpus intentionally does **not** claim to be a general eval platform. Evidence-presence gates show access, not perfect application. Timing remains advisory. Mutation scenarios remain out of scope until real containment exists.

## Related

- [An eval prompt that states the expected finding measures obedience, not judgment](differential-scenario-design-for-agent-evals-2026-08-07.md)
- [Non-failing gates are worse than no gates](../workflow-issues/non-failing-gates-are-worse-than-no-gates-2026-08-07.md)
- [Absence of outcome is not a failed outcome](../workflow-issues/absence-of-outcome-is-not-a-failed-outcome-2026-08-07.md)
- [OpenCode server boots from cwd, not the session directory](../integration-issues/opencode-server-boots-from-cwd-not-session-directory-2026-08-07.md)
- [TOCTOU file-read races require opening before inspection](../logic-errors/toctou-file-read-race-in-net-diff-reconstruction-2026-07-30.md)
