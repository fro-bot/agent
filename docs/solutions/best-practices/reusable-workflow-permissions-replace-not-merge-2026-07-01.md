---
title: Reusable-workflow permissions replace, not merge — the id-token startup trap
date: 2026-07-01
category: docs/solutions/best-practices
module: ci-orchestration
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - A caller job invokes a reusable workflow (uses:) whose job requests more permission scopes than the caller grants
  - A workflow sets workflow-level permissions and a job needs additional scopes (e.g. id-token: write)
  - A workflow_dispatch fails at startup with zero jobs and no logs
tags:
  - github-actions
  - reusable-workflow
  - permissions
  - id-token
  - startup-failure
  - workflow-call
  - github-token
---

# Reusable-workflow permissions replace, not merge — the id-token startup trap

## Context

Wiring a caller workflow (`harness-release.yaml`, workflow-level `permissions: contents: read`) to a new reusable workflow (`harness-integrate.yaml`) whose job requests `id-token: write` to mint an OIDC credential. The dispatch failed immediately — zero jobs, no logs — with:

> Error calling workflow 'harness-integrate.yaml'. The nested job 'integrate' is requesting 'id-token: write', but is only allowed 'id-token: none'.

Local `js-yaml` validation passed; this is a GitHub run-graph schema check that only fires at dispatch (PR #1082).

## Guidance

Two GitHub rules combine into one trap:

1. **A job-level `permissions:` block replaces the workflow-level block entirely** — it does not merge. Any scope not listed in the job block becomes `none`, regardless of the workflow-level default.
2. **A called reusable workflow's `GITHUB_TOKEN` permissions can only be downgraded, never elevated**, relative to the caller job's ceiling.

So when a caller job invokes a reusable workflow whose job needs `{ id-token: write, contents: read }`, the caller job must declare **both** — declaring only `id-token: write` silently drops `contents` to `none`, and the called workflow's checkout (which needs `contents: read`) then exceeds the ceiling and re-fails at startup on `contents`:

```yaml
# WRONG — job block replaces workflow-level, so contents becomes none.
integrate:
  permissions:
    id-token: write
  uses: ./.github/workflows/harness-integrate.yaml

# RIGHT — repeat every scope the called workflow needs.
integrate:
  permissions:
    id-token: write
    contents: read
  uses: ./.github/workflows/harness-integrate.yaml
```

The repo-standard workflow-level `permissions: contents: read` still applies to jobs that don't declare their own block; only jobs with an explicit `permissions:` key opt out of it.

## Why This Matters

The failure is doubly hard: it's **silent to local validation** (js-yaml parses fine) and **loud but jobless at dispatch** (`startup_failure`, zero jobs, no step logs — the GitHub UI's "Invalid workflow file" annotation is the only source of the real error, and the API often won't surface it). Reaching for the wrong fix (only granting `id-token`) produces a second identical-shaped failure on a different scope, wasting a dispatch. Knowing "job-level replaces, called-workflow can only downgrade" gets it right on the first correction.

`startup_failure` with zero jobs is the signature of a run-graph rejection (permissions ceiling, invalid `needs`, bad `uses:` ref) — distinct from a job that runs and fails. When you see it, read the workflow-file annotation in the GitHub UI, not the run logs (there are none).

## When to Apply

- Any caller job that `uses:` a reusable workflow whose job requests scopes beyond the workflow-level default (OIDC `id-token: write` is the common one).
- Any time a `workflow_dispatch` completes in seconds with zero jobs — suspect a permissions ceiling or `uses:`/`needs:` graph error, and check the UI annotation.

## Examples

`harness-release.yaml`'s `integrate` job calls `harness-integrate.yaml`, whose job needs `id-token: write` (broker mint) and `contents: read` (checkout). The workflow-level default is `contents: read`. The correct caller-job block is `{ id-token: write, contents: read }` — both explicit, because the job-level block replaces the workflow-level one. Confirmed by a re-dispatch that cleared the graph and reached the mint step.

## Related

- `docs/solutions/workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md` — the first concrete use case: the caller job needs `id-token: write` precisely to mint the broker credential.
- `docs/solutions/best-practices/cross-libc-build-and-release-safety-2026-06-14.md` — the other `workflow_call` gotcha in this repo (boolean input `!= 'true'` is a silent always-true bug); same "read the producer contract before writing the consumer" theme.
- PR #1082 (`fix(harness): grant id-token to the integrate caller job`).
