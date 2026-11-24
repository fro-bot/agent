---
title: Mint a scoped App installation token inline when an injectable step needs a credential
date: 2026-07-12
last_updated: 2026-11-23
category: best-practices
module: harness-release
problem_type: best_practice
component: authentication
severity: high
related_components:
  - development_workflow
  - tooling
applies_when:
  - A prompt-injectable or otherwise untrusted step genuinely needs a GitHub credential (e.g. to push a result)
  - The durable alternative is a broad PAT or org-wide App key reaching the untrusted step
  - The workflow has a one-job constraint (OIDC allowlists pinning job_workflow_ref, no cross-job secret handoff)
tags:
  - github-app
  - installation-token
  - credential-minimization
  - inline-mint
  - no-post-hook
  - fail-closed
---

# Mint a scoped App installation token inline when an injectable step needs a credential

## Context

The `harness-integrate` path (`packages/harness/AGENTS.md:87`) runs a prompt-injectable merge step; a separate trusted step pushes its result. The previous credential was `FRO_BOT_PAT`, a durable, broadly-scoped personal access token reaching that untrusted step. Issue #1126 (PRs #1179, #1182) replaces it with a GitHub App installation token minted inline, inside the same job and before the model step. The `single-repo` profile (the script's default) is that shape: scoped to exactly `contents: write` on exactly the target repository, with a roughly one-hour TTL. The model step gets only the read-only workflow token; the scoped App token is consumed by the trusted-integrate push step via a masked step output.

No workflow under `.github/workflows/` selects the `single-repo` profile today. The one workflow that calls the script, `fro-bot.yaml:393`, selects `owner-wide-workflow` (see "Profiles" below).

This sits on the credential-minimization ladder: scrub copies of a credential from the environment (hygiene) → mint a short-lived, narrowly-scoped token per run (minimization) → remove the credential from the untrusted step entirely when its only use is posting a result (removal — see `docs/solutions/best-practices/response-file-is-untrusted-input-2026-07-11.md`). Inline minting is the middle rung: for use when the untrusted step genuinely needs creation/push agency, not just the ability to report a result.

## Guidance

The shipped pattern is a checklist, not just a single trick:

- **Trusted inline no-post mint step**: implement the mint as a plain `run:` step invoking a checked-in script — never a marketplace action with a `post:` hook. The runner re-supplies an action's `INPUT_*` inputs (including a private key) during the post phase, and a prompt-injected earlier step in the same job can tamper the on-disk post script before it runs. SHA-pinning the action protects the download, not same-job filesystem integrity — see `docs/solutions/best-practices/same-job-phase-split-not-a-security-boundary-2026-07-04.md`.
- **Key scoped to the mint step's env only**, never job-level — apply `core.setSecret` immediately on reading the key, before any parsing touches it.
- **Constant-class error messages**: never interpolate a caught error, the PEM contents, or an API response body into a thrown error or log line.
- **All-or-nothing echo validation on both axes**: validate the response's `permissions` (the requested set plus the implied `metadata: read` grant every installation token carries — see the companion doc, `docs/solutions/logic-errors/app-token-echo-includes-implied-metadata-read-2026-07-12.md`) and, for the `single-repo` profile, the response's `repositories` (exactly the intended repository, nothing broader). The `owner-wide-workflow` profile sends no `repositories` and validates permissions only; see "Profiles" below.
- **Mint as late as possible, but before any untrusted step**: run checkout and setup on the default `GITHUB_TOKEN` (`contents: read` is enough for those), so the minted token's short TTL goes on the actual work rather than sitting idle. The mint still has to come before the agent step, so no step after the agent ever receives the App key. See `same-job-phase-split-not-a-security-boundary-2026-07-04.md`, "Mint before the agent, not after".
- **Fail closed**: any mint failure stops the job before the untrusted step runs. There is no durable fallback token to fall back to.
- **Zero new dependencies**: an RS256 App JWT is roughly 15 lines of `node:crypto` — no new library is warranted for this.

Reference implementation: `scripts/harness/mint-app-token.ts`, covered by 36 unit tests.

### Profiles

The script selects a profile through `FRO_BOT_APP_TOKEN_PROFILE` (`scripts/harness/mint-app-token.ts:49-50`):

- **`single-repo`** (the default) requests `contents: write`, sends `repositories` naming exactly the target repository, and validates that the response echoes exactly one repository, the intended one (`:159-172`). This is the profile the echo-validation guidance above describes.
- **`owner-wide-workflow`** requests the broader permission set (`:52-58`), sends no `repositories` (`:257-258`), and skips the repository echo check. It still validates the permissions echo and the token's `expires_at` (non-empty, in the future, within the one-hour cap; `:136-141`). `.github/workflows/fro-bot.yaml:385-397` uses it for direct autonomous `schedule`/`workflow_dispatch` runs, and passes the minted token to the action as `github-token` (`:514`). The App private key stays in the mint step's own `env:` (`:393-397`); the action never receives it. The bound is the permission set and the ~1 hour TTL, not a single-repository scope.

## Why This Matters

A durable PAT reaching a prompt-injectable step is a standing liability: if that step is compromised or manipulated, the blast radius is whatever the PAT can do, for as long as it's valid — which in practice is indefinitely. A minted token bounds both dimensions: scope (under the `single-repo` profile, exactly `contents: write` on one repository; under `owner-wide-workflow`, the fixed permission set across the owner's installation) and lifetime (~1 hour). The residual risk is real but smaller and clearly named. On the `harness-integrate` path the minted token was never handed to the untrusted step. On direct autonomous Fro Bot runs the agent is provisioned with the short-lived owner-wide token, and what stays in the mint step is the App private key. In both cases the App **key** used to mint it still carries the App's full installed scope — the key is used before the model step and no later step receives it, Issue #1180 originally proposed a dedicated, minimally-scoped App as the follow-up. It was closed by #1792 with a smaller fix: the mint step moved ahead of the agent step, so no step after the agent receives the key.

## When to Apply

- A prompt-injectable or otherwise untrusted step needs a GitHub credential to take an action (push, create a ref, etc.), not merely to report a result.
- The alternative under consideration is a broad, durable PAT or an App private key reaching that untrusted step.
- The workflow must stay a single job (e.g. because OIDC allowlist claims pin `job_workflow_ref`, ruling out a cross-job secret handoff).

## Examples

Mint step shape (illustrative, not the full script):

```yaml
- name: Mint scoped App installation token
  id: mint
  env:
    APP_ID: ${{ secrets.APP_ID }}
    APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}
  run: node scripts/harness/mint-app-token.ts
```

```ts
// inside mint-app-token.ts
const REQUESTED_PERMISSIONS = {contents: 'write'} as const
const EXPECTED_PERMISSIONS_ECHO = {contents: 'write', metadata: 'read'} as const

// single-repo profile: mint, then validate all-or-nothing on both axes before
// ever emitting the token. The response echoes a `repositories` ARRAY of
// repository objects — require exactly one entry naming exactly the intended repo.
// (The owner-wide-workflow profile validates permissions only.)
const repositoriesOk =
  Array.isArray(response.repositories) && response.repositories.length === 1 && response.repositories[0].name === REPO
if (!deepEqual(response.permissions, EXPECTED_PERMISSIONS_ECHO) || !repositoriesOk) {
  // constant-class error, fail closed (process.exitCode = 1) — no output emitted
  throw new Error('token-mint-failed')
}
```

What this replaces:

```yaml
# before: a durable, broadly-scoped PAT reaching the untrusted merge step
env:
  GH_TOKEN: ${{ secrets.FRO_BOT_PAT }}
```

## Related

- `docs/solutions/logic-errors/app-token-echo-includes-implied-metadata-read-2026-07-12.md` — the echo-validation bug this mint step's tests missed.
- `docs/solutions/workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md` — the credential-isolation precedent (broker-mint) this inline mint is a same-job alternative to.
- `docs/solutions/best-practices/same-job-phase-split-not-a-security-boundary-2026-07-04.md` — why the mint step must be a plain `run:` script, never an action with a `post:` hook.
- `docs/solutions/workflow-issues/create-github-app-token-caller-mint-invalid-2026-07-04.md` — why this had to be minted inside the called workflow's job rather than in the caller.
- Issue #1126, #1180; PRs #1179, #1182.
