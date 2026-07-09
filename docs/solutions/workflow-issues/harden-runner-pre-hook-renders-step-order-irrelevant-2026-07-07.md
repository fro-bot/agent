---
title: harden-runner enforces egress via a pre-job hook, so reordering its step is ineffective
date: 2026-07-07
category: workflow-issues
module: .github/workflows/harness-integrate.yaml
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - A GitHub Actions action defines a `pre:` entrypoint (runs before every regular step)
  - You are tempted to reorder a workflow step to run "before" such an action's guard
  - A step appears blocked by a policy action and you think moving it earlier will help
tags:
  - harden-runner
  - github-actions
  - pre-hook
  - step-order
  - egress
  - workflow
---

# harden-runner enforces egress via a pre-job hook, so reordering its step is ineffective

## Context

While debugging a harden-runner egress block that was dropping `actions/checkout`'s connection to github.com (see the companion bug doc, Related), an intuitive fix was tried: move the `Checkout repository` step to run *before* the `Harden runner egress` step, on the theory that checkout would then run before harden-runner installed its iptables/DNS rules. It did not work — checkout failed identically after the reorder (PR #1137, later reverted).

## Guidance

A GitHub Actions action can declare a `pre:` entrypoint in its `action.yml`. GitHub runs that pre-entrypoint as a **`Pre <step name>` step before every regular step in the job**, regardless of where the action's own step sits in the `steps:` list. `step-security/harden-runner` uses this: its egress monitoring/blocking is installed by the pre-hook at the very start of the job.

Therefore **reordering the harden-runner step within `steps:` cannot change when the egress policy activates** — it is always active from the first regular step onward. Any "fix" that depends on a step running before harden-runner's step is a no-op.

The evidence is visible in the run's executed step list:

```
1. Set up job
2. Pre Harden runner egress   ← the pre-hook installs the egress block here, before any step
3. Checkout repository        ← still blocked, even though it's listed before "Harden runner egress"
4. Harden runner egress
...
```

The general rule: if an action has a `pre:` entrypoint that installs an environment guard (egress policy, a proxy, a monitor), the guard is in force for the whole job. To exempt a step you must configure the guard (e.g. fix the allowlist), not reorder around it. Real "before the guard" execution requires a *separate job* (a fresh runner) — not step ordering within the same job.

## Why This Matters

Reordering steps *looks* like it should work and produces a plausible-but-wrong mental model ("the block starts when its step runs"). Acting on it wastes a fix cycle and — worse — can appear to "work" for unrelated reasons and mask the real cause. Knowing that policy actions run from a pre-hook redirects you immediately to the correct fix surface (the action's configuration) instead of shuffling step order.

## When to Apply

- Any time a step seems blocked by a `step-security/harden-runner` (or similar `pre:`-entrypoint) action and you're considering moving it earlier.
- Reviewing a PR that reorders steps to "escape" an egress/monitoring guard — flag it as ineffective.
- Reasoning about when a job-scoped guard is active: assume "entire job," not "from its step onward."

## Examples

Ineffective (what was tried, PR #1137):

```yaml
steps:
  - name: Checkout repository        # moved first, hoping to beat the egress block
    uses: actions/checkout@v7
  - name: Harden runner egress       # harden-runner's PRE-hook already ran before checkout
    uses: step-security/harden-runner@v2.20.0
    with:
      egress-policy: block
```

Effective (fix the guard's config instead — here, the allowlist scalar):

```yaml
steps:
  - name: Harden runner egress
    uses: step-security/harden-runner@v2.20.0
    with:
      egress-policy: block
      allowed-endpoints: >-          # folded scalar so all endpoints actually parse
        github.com:443
        ...
  - name: Checkout repository
    uses: actions/checkout@v7
```

## Related

- [harden-runner allowed-endpoints as a YAML literal scalar silently drops all but the first endpoint](harden-runner-allowed-endpoints-literal-scalar-drops-endpoints-2026-07-07.md) — the actual root cause of this incident; the reorder here was a wrong turn on the way to that fix.
- [Same-job phase splitting is not a security boundary](../best-practices/same-job-phase-split-not-a-security-boundary-2026-07-04.md) — the related principle that real isolation between steps needs a separate job, not step ordering within one job.
