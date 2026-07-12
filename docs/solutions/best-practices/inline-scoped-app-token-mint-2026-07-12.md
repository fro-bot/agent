---
title: Mint a scoped App installation token inline when an injectable step needs a credential
date: 2026-07-12
category: best-practices
module: harness-integrate
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

The `harness-integrate` path runs a prompt-injectable merge step that needs `git push` authority to land its result. The previous credential was `FRO_BOT_PAT`, a durable, broadly-scoped personal access token reaching that untrusted step. Issue #1126 (PRs #1179, #1182) replaces it with a GitHub App installation token minted inline, inside the same job, scoped to exactly `contents: write` on exactly the target repository, with a roughly one-hour TTL.

This sits on the credential-minimization ladder: scrub copies of a credential from the environment (hygiene) → mint a short-lived, narrowly-scoped token per run (minimization) → remove the credential from the untrusted step entirely when its only use is posting a result (removal — see `docs/solutions/best-practices/response-file-is-untrusted-input-2026-07-11.md`). Inline minting is the middle rung: for use when the untrusted step genuinely needs creation/push agency, not just the ability to report a result.

## Guidance

The shipped pattern is a checklist, not just a single trick:

- **Trusted inline no-post mint step**: implement the mint as a plain `run:` step invoking a checked-in script — never a marketplace action with a `post:` hook. The runner re-supplies an action's `INPUT_*` inputs (including a private key) during the post phase, and a prompt-injected earlier step in the same job can tamper the on-disk post script before it runs. SHA-pinning the action protects the download, not same-job filesystem integrity — see `docs/solutions/best-practices/same-job-phase-split-not-a-security-boundary-2026-07-04.md`.
- **Key scoped to the mint step's env only**, never job-level — apply `core.setSecret` immediately on reading the key, before any parsing touches it.
- **Constant-class error messages**: never interpolate a caught error, the PEM contents, or an API response body into a thrown error or log line.
- **All-or-nothing echo validation on both axes**: validate the response's `permissions` (the requested set plus the implied `metadata: read` grant every installation token carries — see the companion doc, `docs/solutions/logic-errors/app-token-echo-includes-implied-metadata-read-2026-07-12.md`) and the response's `repository` (exactly the intended repository, nothing broader).
- **Mint as late as possible**: run checkout and setup steps on the default `GITHUB_TOKEN` (`contents: read` is sufficient for those), so the minted token's short TTL is spent on the actual work, not idle earlier in the job.
- **Fail closed**: any mint failure stops the job before the untrusted step runs. There is no durable fallback token to fall back to.
- **Zero new dependencies**: an RS256 App JWT is roughly 15 lines of `node:crypto` — no new library is warranted for this.

Reference implementation: `scripts/harness/mint-app-token.ts`, covered by 36 unit tests.

## Why This Matters

A durable PAT reaching a prompt-injectable step is a standing liability: if that step is compromised or manipulated, the blast radius is whatever the PAT can do, for as long as it's valid — which in practice is indefinitely. A minted token bounds both dimensions: scope (exactly `contents: write` on one repository) and lifetime (~1 hour). The residual risk is real but smaller and clearly named: the minted token bounds what the untrusted step holds, but the App **key** used to mint it still carries the App's full installed scope — the key itself is not in the untrusted step's blast radius under this design, but a dedicated, minimally-scoped App (rather than reusing a broader existing App) is the natural follow-up (tracked as issue #1180).

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

// mint, then validate all-or-nothing on both axes before ever emitting the
// token. The response echoes a `repositories` ARRAY of repository objects —
// require exactly one entry naming exactly the intended repo.
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
