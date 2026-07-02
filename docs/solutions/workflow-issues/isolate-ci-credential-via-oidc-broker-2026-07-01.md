---
title: Isolate a CI credential from an autonomous agent via an OIDC broker
date: 2026-07-01
category: docs/solutions/workflow-issues
module: harness/release pipeline
problem_type: workflow_issue
component: tooling
severity: high
applies_when:
  - A GitHub Actions job runs an autonomous/untrusted agent that must not read a durable provider credential
  - A reusable workflow is called with secrets: inherit but should only receive a subset of secrets
  - You need a short-lived, revocable credential minted per run instead of a durable key on the runner
related_components:
  - development_workflow
tags:
  - oidc
  - id-token
  - credential-broker
  - secrets-inherit
  - reusable-workflow
  - auth-json
  - fail-closed
  - cliproxy
---

# Isolate a CI credential from an autonomous agent via an OIDC broker

## Context

The harness LLM-merge (`.github/workflows/harness-release.yaml` `integrate` job) runs an autonomous OpenCode agent whose tools (`bash`/`read`/`edit`) execute with host-user filesystem authority. It was provisioned the durable model credential (`AUTH_JSON`) via `secrets: inherit` and an on-disk `auth.json`, so a compromised or misbehaving tool could read the durable key. An OpenCode permission config cannot sandbox those tools, so the fix has to be at the credential-lifetime and process layers, not in agent config. Issue #1060; shipped in PRs #1080, #1081.

The fix has two halves — a caller-side secret withholding and a called-side broker mint — that only work together. Documenting them in one place because a reader debugging the broker needs both.

## Guidance

### Withhold the durable secret by construction (caller side)

`secrets: inherit` forwards **all** caller secrets to a called reusable workflow. To keep a durable credential off the called workflow's runner, drop `secrets: inherit` and pass only the named secrets the job actually needs:

```yaml
# caller (harness-release.yaml integrate job)
uses: ./.github/workflows/harness-integrate.yaml
secrets:
  FRO_BOT_PAT: ${{ secrets.FRO_BOT_PAT }}
  OPENCODE_CONFIG: ${{ secrets.OPENCODE_CONFIG }}
  # NO AUTH_JSON — the durable model key never reaches this workflow.
```

Caveat: `GITHUB_TOKEN` is **auto-injected** into every called workflow regardless of the `secrets:` block and cannot be withheld — it can only be capability-restricted via the job `permissions:` block. So the isolation target must be the durable third-party key, not `GITHUB_TOKEN`; treat `GITHUB_TOKEN` as always present and restrict its scope instead.

### Mint a short-lived credential from an OIDC broker (called side)

A dedicated reusable workflow requests a GitHub OIDC token and exchanges it at a broker for a short-lived, revocable credential. Keep the mint logic in a testable `scripts/` module, not inline YAML (there is no workflow linter; the security logic deserves unit tests). The security contract:

1. `core.getIDToken(audience)`, then **immediately** `core.setSecret(oidcToken)` — mask the JWT before any HTTP call, log, or stack trace can surface it.
2. A **single** `POST /v1/mint` with `Authorization: Bearer <oidc-token>` (the OIDC token IS the bearer — no separate broker API key) under a bounded `AbortSignal.timeout`. **No retry** — the OIDC token is single-use per `jti`; a retry either fails replay protection or risks a duplicate credential. Share one `AbortSignal` across the fetch and the body read so a hung body can't exceed the bound.
3. Validate the response **all-or-nothing** (every provider well-formed or reject the entire payload).
4. Emit the credential as a `core.setSecret`-masked step output — never write it to disk, never place it or the OIDC token in `process.env`.
5. **Fail closed**: any error (OIDC failure, non-2xx, timeout, bad shape) exits non-zero and emits nothing. Never fall back to the durable key; never `continue-on-error`.

### Complete the env hygiene on the shared paths

The paths that still use the durable key should scrub it from `process.env` after reading it, so it is not inherited by the agent's child process (which the OpenCode SDK spawns with `{ ...process.env }`). Note `@actions/core` maps input names replacing **spaces** only with underscores — `auth-json` reads from `INPUT_AUTH-JSON`, not `INPUT_AUTH_JSON` (PR #1080).

## Why This Matters

The durable model key is the highest-value secret on the runner. Removing it entirely (broker path) shrinks the credential's value and lifetime; a stolen minted token is cliproxy-scoped and expires. The two halves are load-bearing together: dropping `secrets: inherit` without the broker leaves the merge with no credential; minting without dropping `secrets: inherit` leaves the durable key inherited into the called workflow's env, making the isolation fake.

**Diagnostic — failure taxonomy (each code localizes the fix to a different place):**

| Signal | Meaning | Fix lives in |
| --- | --- | --- |
| `401` at **mint** | Unauthenticated — bad/missing OIDC token | The workflow (`id-token: write`, audience) |
| `403` at **mint** | Authenticated but allowlist claim match failed — the token passed issuer/signature/audience/expiry | The broker's allowlist config (pinned `repository_id` / `repository_owner_id` / `job_workflow_ref`) |
| `401` **mid-run** from the credential consumer (e.g. `cliproxy … Invalid API key`, `isRetryable: false`) after the mint succeeded and calls worked | The minted credential was invalidated after issue — in practice: **the broker was redeployed while the run was in flight** | Operations — re-run the job; don't redeploy the broker while a consuming run is active |

The mid-run case was hit live (2026-07-02): mint succeeded at 04:37:10Z, the merge made ~90s of authenticated model calls, then every call returned `401 Invalid API key` — the broker had been redeployed mid-run, invalidating the in-flight minted key. The agent failed closed (exit 1, no partial push) and a re-run of the same job succeeded on a fresh mint. Corollary: treat broker redeploys as draining operations — check for active integrate runs first.

## When to Apply

- Any CI job running an autonomous or untrusted agent that must not read a durable provider credential.
- When a reusable workflow is invoked with `secrets: inherit` but should only receive a subset.
- When you want per-run, revocable credentials instead of a durable key on the runner.

## Examples

Fail-closed verified in practice: a dry-run `harness-release` dispatch whose broker allowlist was still mismatched returned `broker returned HTTP 403` at the mint step, and the subsequent "Run Fro Bot" merge step was **skipped** — no merge ran on a bad or absent credential. After the allowlist was corrected, the same dispatch minted cleanly and the merge authenticated on the short-lived token.

## Related

- `docs/solutions/best-practices/reusable-workflow-permissions-replace-not-merge-2026-07-01.md` — the permissions trap this work hit (a caller job needs `id-token: write` for the broker mint; getting the `permissions:` block wrong fails the run at startup).
- `docs/solutions/best-practices/workspace-executor-opencode-provisioning-best-practices-2026-06-01.md` — the sibling `auth-json` surface (workspace container entrypoint). This doc is the harness-CI producer side; that doc is the container consumer side.
- `docs/solutions/workflow-issues/build-pipeline-fallible-preflight-and-finally-cleanup-2026-06-22.md` — the preflight → mutator → finally lifecycle the mint script follows.
- `docs/solutions/best-practices/release-notes-narration-routing-and-fail-soft-guards-2026-06-07.md` — the `scripts/`-as-testable-module precedent for the mint script.
- Issue #1060; PRs #1080 (env scrub), #1081 (broker mint + workflow), #1082 (permissions fix). Egress containment for the integrate runner remains deferred to `marcusrbrown/infra#725`.
