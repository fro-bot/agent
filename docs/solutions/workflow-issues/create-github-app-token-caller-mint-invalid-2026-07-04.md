---
title: You cannot caller-mint a GitHub App token and pass it into a reusable workflow
date: 2026-07-04
category: workflow-issues
module: harness/release pipeline
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - A caller job invokes a reusable workflow via jobs.<id>.uses
  - You want a freshly minted credential (e.g. a GitHub App token) available inside the called workflow
  - You expect to mint in the caller job and pass the token down through the secrets block
tags:
  - github-actions
  - reusable-workflow
  - create-github-app-token
  - job-outputs
  - secrets
  - credential-minting
---

# You cannot caller-mint a GitHub App token and pass it into a reusable workflow

## Context

Removing a durable PAT from a reusable workflow (`harness-integrate.yaml`, which runs a prompt-injectable merge agent) by minting a short-lived GitHub App token in the **caller** (`harness-release.yaml`'s `integrate` job) and passing it into the called workflow via `secrets:`. This is the intuitive design — and it is invalid GitHub Actions. Surfaced while scoping #1107.

## Guidance

Two independent constraints block caller-mint:

1. **A job that calls a reusable workflow (`jobs.<id>.uses:`) cannot also have `steps:`.** The reusable-workflow-calling job supports only job-level keys (`uses`, `with`, `secrets`, `needs`, `permissions`, `strategy`, `if`). So you cannot run `actions/create-github-app-token` before the `uses:` call in the same job.
2. **Reusable-workflow `secrets:` values cannot reference `steps.*`.** A `jobs.<id>.secrets.<name>` expression may only read `github`, `needs`, `inputs`, `vars`, and `secrets` contexts — not `steps`. So even if you could run a mint step, `secrets: { TOKEN: ${{ steps.mint.outputs.token }} }` would not resolve.

So the whole "mint in the caller, hand the token down" shape is not implementable. Choose one of the valid alternatives instead — each with a distinct tradeoff.

## Why This Matters

Caller-mint reads as the obvious way to keep an App private key out of a prompt-injectable reusable workflow while still giving it a scoped token. It silently doesn't work — the workflow won't even parse. Knowing the constraint upfront avoids designing (and half-implementing) a token handoff GitHub Actions will reject, and points you at the real options early.

## When to Apply

- Any time you want a freshly minted credential available *inside* a reusable workflow.
- Any "mint a scoped token, then call the reusable workflow with it" design.
- Reviewing a workflow PR that appears to mint-and-pass into a `uses:` job.

## Examples

Invalid — mint in the same job that calls the reusable workflow:

```yaml
jobs:
  integrate:
    uses: ./.github/workflows/harness-integrate.yaml
    steps: # ← illegal: a `uses:` job cannot have `steps:`
      - id: mint
        uses: actions/create-github-app-token@v3
    secrets:
      TOKEN: ${{ steps.mint.outputs.token }} # ← illegal: secrets: cannot read steps.*
```

Valid alternative 1 — producer job + `needs.*` (brittle):

```yaml
jobs:
  mint:
    runs-on: ubuntu-latest
    outputs:
      token: ${{ steps.mint.outputs.token }}
    steps:
      - id: mint
        uses: actions/create-github-app-token@v3
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          skip-token-revoke: true # ← required, else the token is revoked at job end
  integrate:
    needs: mint
    uses: ./.github/workflows/harness-integrate.yaml
    secrets:
      TOKEN: ${{ needs.mint.outputs.token }}
```

Caveat: `actions/create-github-app-token` revokes its token at the minting job's end unless `skip-token-revoke: true`, so a cross-job hand-off is brittle and keeps the token alive longer than one job.

Valid alternative 2 — mint inside the called workflow:

```yaml
# inside harness-integrate.yaml
steps:
  - uses: actions/create-github-app-token@v3
    with:
      app-id: ${{ secrets.APP_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
```

Tradeoff: the App **private key** now lives in the called workflow's job — and if that job runs a prompt-injectable agent, the key (which mints the App's full installation scope) is in the untrusted blast radius. Worse than a scoped PAT for that case.

Valid alternative 3 — broker-mint off OIDC (keeps the App key out of CI entirely):

```yaml
# inside the called workflow
permissions:
  id-token: write
steps:
  - run: node scripts/harness/mint-broker-credential.ts # OIDC → broker → scoped short-lived token
```

Tradeoff: needs a broker that holds the App key server-side. This is the chosen direction for #1107 (see the broker doc below).

## Related

- `docs/solutions/workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md` — the broker-mint pattern (alternative 3), the real fix for #1107's integrate path.
- `docs/solutions/best-practices/reusable-workflow-permissions-replace-not-merge-2026-07-01.md` — a *different* reusable-workflow trap (permissions REPLACE, not merge). Adjacent but distinct: that one is about the `permissions:` ceiling; this one is about `steps`/`secrets`-context invalidity.
- `docs/solutions/best-practices/same-job-phase-split-not-a-security-boundary-2026-07-04.md` — why mint-inside-the-workflow (alternative 2) doesn't isolate the key from a same-job agent step.
- Issue #1107; in-repo wiring tracked at #1124, broker change at `marcusrbrown/infra#771`.
