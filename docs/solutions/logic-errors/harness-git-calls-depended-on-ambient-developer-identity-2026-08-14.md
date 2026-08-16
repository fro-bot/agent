---
title: Harness git calls depended on ambient developer identity and failed on runners
date: 2026-08-14
category: logic-errors
module: harness-release
problem_type: logic_error
component: tooling
symptoms:
  - "`git merge --no-ff` fails with `Committer identity unknown / *** Please tell me who you are.`"
  - "Seven conflict-resolver tests fail in CI and every one of them passes locally"
  - "The failure appears in disposable checkouts created under `RUNNER_TEMP`"
root_cause: config_error
resolution_type: code_fix
severity: high
related_components:
  - ci-workflows
  - development-workflow
tags:
  - git-identity
  - ambient-config
  - ci-only-failure
  - conflict-resolver
  - environment-dependence
---

## Problem

The harness conflict resolver ran `git merge` in disposable checkouts without supplying a committer identity. It worked on developer machines, which have a global git identity, and failed on GitHub Actions runners, which do not.

## Symptoms

```
Command failed: git -c credential.helper= -c core.askPass= merge --no-ff --no-edit refs/harness/conflict-source
Committer identity unknown

*** Please tell me who you are.
```

Seven conflict-resolver tests failed in CI. All seven shared this single root cause, and all seven passed locally.

## What Didn't Work

The obvious reading is "the test environment is missing configuration," which points at fixing CI — setting a global identity in the workflow, or configuring it in test setup.

That would have been wrong. The `git merge` is executed by the resolver itself, not by test scaffolding. The resolver creates fresh checkouts under `RUNNER_TEMP` and merges in them, so a real release run on a real runner would have failed in exactly the same way. Fixing the test environment would have hidden a production defect behind green CI.

## Solution

Pass the identity explicitly on every commit-producing invocation, alongside the existing hardening flags:

```ts
// Runners have no global git identity, so every commit-producing invocation
// carries its own. Matches DEFAULT_AUTHOR in src/features/delegated/types.ts;
// the harness package is standalone and cannot import it.
export const HARNESS_GIT_IDENTITY = [
  '-c',
  'user.name=Fro Bot',
  '-c',
  'user.email=fro-bot[bot]@users.noreply.github.com',
] as const
```

The value has to match the repository's existing convention in `src/features/delegated/types.ts`:

```ts
export const DEFAULT_AUTHOR = {
  name: 'Fro Bot',
  email: 'fro-bot[bot]@users.noreply.github.com',
} as const
```

An initial attempt used `github-actions[bot]@users.noreply.github.com`, which would have silently misattributed harness integration commits to a different bot. The constant is exported from `conflict-resolver.ts` and imported by `integrate.ts` rather than duplicated, so the two callsites cannot drift.

Do **not** solve this with `GIT_AUTHOR_*` / `GIT_COMMITTER_*` environment variables. Inheriting identity from the environment is the same defect in a different costume — the point is that the command carries everything it needs.

## Why This Works

`git commit` requires an identity and resolves it from configuration: repository, global, or system. A disposable checkout has no repository-level config, and an ephemeral runner has no global config, so resolution fails. Passing `-c user.name` / `-c user.email` supplies it at the invocation itself, which is the only scope guaranteed to exist.

The deeper property is that the command becomes independent of the machine it runs on. The original code was not "missing config" — it was reading state it did not own and could not guarantee.

## Prevention

- A test that passes locally and fails in CI is evidence about the *code*, not just the environment. Before adjusting CI, establish which side actually owns the missing state — here, production code was reading developer machine configuration.
- Subprocess invocations that must work in a clean environment should carry their required configuration inline. This code already did that for `credential.helper` and `core.askPass`; identity was the gap in an otherwise deliberate pattern.
- Keep identity constants in one place and import them. Two literals in two files is one careless edit away from commits attributed to two different authors.
- When a bot identity is involved, check the repo's existing convention before writing one. Misattribution is silent, survives review, and is annoying to correct after the fact.

## Related

- [gh auth login refuses to persist when GH_TOKEN is set](../workflow-issues/gh-auth-login-refuses-to-persist-when-gh-token-set-2026-07-10.md) — same class: tooling behavior that changes based on ambient environment state.
