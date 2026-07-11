---
title: 'gh auth login --with-token refuses to persist credentials when GH_TOKEN is set, silently breaking the CI review bot'
date: 2026-07-10
category: workflow-issues
module: src/services/setup
problem_type: workflow_issue
component: tooling
severity: high
symptoms:
  - 'A CI agent reaches a PASS verdict but its gh pr review call fails with "gh: not logged in"'
  - 'The PR review bot silently stops posting reviews repo-wide, while the CI job that runs it still shows green'
  - 'gh auth login --with-token exits 1: "The value of the GH_TOKEN environment variable is being used for authentication"'
root_cause: config_error
resolution_type: code_fix
related_components:
  - gh-cli
  - github-actions
  - setup
  - env-scrub
tags:
  - gh-auth
  - github-cli
  - env-scrub
  - review-bot
  - silent-failure
  - green-checks
---

# gh auth login --with-token refuses to persist credentials when GH_TOKEN is set, silently breaking the CI review bot

## Problem

Setup builds an off-environment `gh` auth store: a temporary `GH_CONFIG_DIR` with its own `hosts.yml`, so that after the harness scrubs `GH_TOKEN`/`GITHUB_TOKEN` from a model's child bash processes, `gh` invocations in that child still authenticate via the stored `hosts.yml` instead of a live token. This setup ran `gh auth login --with-token` while `process.env.GH_TOKEN` was still set in the parent process's environment. `gh auth login` intentionally refuses to write credentials when `GH_TOKEN` is present in its environment, exits 1, and `hosts.yml` is never written. Combined with the later env-scrub stripping `GH_TOKEN` from the child, the child ended up with no auth at all — `gh pr review` calls from the CI review bot silently failed.

## Symptoms

- A CI agent reaches a PASS verdict but its `gh pr review` call fails with `gh: not logged in`.
- The PR review bot silently stops posting reviews repo-wide, while the CI job that runs it still shows green.
- `gh auth login --with-token` exits 1: `The value of the GH_TOKEN environment variable is being used for authentication`.

## What Didn't Work / How It Hid

The "Test GitHub Action" CI job stayed green because the **job** succeeds — the review agent still reaches its verdict; only the final `gh pr review` post-step fails, and that failure was not surfaced as a job failure. Bot and Renovate PRs are review-exempt, so nothing exercised the review path in CI's own dogfooding until a human-authored PR's review simply never appeared. A green check on the job that *runs* an agent is not proof that the agent's side effect — posting a review — actually happened.

## Solution

Strip `GH_TOKEN` and `GITHUB_TOKEN` from the environment passed to the `gh auth login --with-token` exec only. The harness keeps `process.env.GH_TOKEN` intact for its own API calls; only the login subprocess's environment is scrubbed.

`src/services/setup/gh-auth.ts`:

```typescript
const loginEnv = {...process.env, GH_CONFIG_DIR: ghConfigDir}
delete loginEnv.GH_TOKEN
delete loginEnv.GITHUB_TOKEN

await exec('gh', ['auth', 'login', '--with-token'], {
  env: loginEnv,
  input: token,
})
```

Verify with a control: run the same command without `GH_TOKEN`/`GITHUB_TOKEN` in the environment, and confirm `gh auth login --with-token` proceeds to validate the piped token instead of bailing with the "environment variable is being used" error.

## Why This Works

`gh` intentionally prefers an environment `GH_TOKEN` over stored credentials and refuses to silently overwrite what it believes is an already-authenticated session. Removing `GH_TOKEN`/`GITHUB_TOKEN` from the login exec's environment lets the login command actually reach the credential-store write and populate `hosts.yml`, which the child's `GH_CONFIG_DIR` then points every subsequent `gh` invocation at.

## Prevention

- When a CLI has an environment variable that short-circuits its credential store (`gh` + `GH_TOKEN`), scrub that variable from the specific exec call that must *write* credentials — do not assume scrubbing the eventual child process is sufficient if the write-time process still sees it.
- Treat a green CI job that *runs* an agent as insufficient proof that the agent's side effect (posting a review, writing a comment) actually succeeded. Verify the real artifact — an actual posted review — on a human-authored PR, since bot/Renovate PRs are frequently review-exempt and won't exercise the path.

## Related

- [Isolate CI credential via OIDC broker](isolate-ci-credential-via-oidc-broker-2026-07-01.md) — the broader credential-isolation effort this off-environment `gh` auth setup belongs to.
- [Sequential steps in one GitHub Actions job are not a security boundary](../best-practices/same-job-phase-split-not-a-security-boundary-2026-07-04.md) — `GH_TOKEN`/`GITHUB_ENV` inheritance into later steps in the same job.
