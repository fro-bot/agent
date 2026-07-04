---
title: 'Broker-minted GitHub App token for the harness-integrate push (issue #1107)'
type: feature
status: requirements
date: 2026-07-04
depends_on_infra: marcusrbrown/infra (broker.fro.bot)
---

# Broker-minted GitHub App token for the harness-integrate push

## Problem

The harness-integrate path runs a **prompt-injectable LLM merge agent** (it merges untrusted upstream OpenCode refs) and hands it a **durable, broad classic PAT** (`FRO_BOT_PAT`) so the agent can `git push` the integration result to `refs/harness-integrate/<version>` on `fro-bot/agent`. The PAT reaches the agent's child process via `GH_TOKEN` (`src/services/setup/setup.ts:305`) and, until PR #1119, also via `INPUT_GITHUB-TOKEN`.

PR #1119 (defense-in-depth, does not close #1107) masks the token value and scrubs the `INPUT_GITHUB-TOKEN` copy, but the durable PAT still reaches the agent via `GH_TOKEN` **by necessity** — the agent needs a write-capable token to push. The real fix is to stop giving the agent a durable credential at all.

## Goal

Replace `FRO_BOT_PAT` on the integrate path with a **short-lived GitHub App installation token**, minted by the existing `broker.fro.bot` off the run's OIDC token — so the App private key never enters the prompt-injectable workflow and the agent only ever holds a ~1h token scoped to `contents: write` on `fro-bot/agent`.

This is the same trust boundary the credential broker already establishes for the model credential (`auth-json`): **durable secrets live in the broker (infra); CI receives only short-lived, scoped, masked outputs.**

## Why broker-mint (not mint-in-workflow)

Two alternatives were evaluated (Oracle-validated):

- **Caller-mint + pass down** — *invalid GitHub Actions.* A job that calls a reusable workflow cannot also run a preceding step, and reusable-workflow `secrets:` values cannot reference `steps.*` outputs. Not implementable.
- **Mint inside `harness-integrate.yaml`** (add a `create-github-app-token` step before the agent) — *works, but re-introduces a durable credential.* It puts `APPLICATION_PRIVATE_KEY` into the one-job, prompt-injectable integrate workflow. Only the mint step consumes it and the agent step gets only the token, but the App private key can mint the App's **full** installation scope — exactly the durable-credential-on-the-runner exposure the broker pattern exists to eliminate. Rejected as a step sideways from the established architecture.
- **Broker-mint (this doc)** — the App private key stays in the broker; CI holds only OIDC (already single-use, masked) and receives a scoped short-lived token. Consistent with #1060.

## The infra action (marcusrbrown/infra — Marcus drives this)

> **This section is the cross-repo work. It must land BEFORE the in-repo half can be wired or tested.**

Extend `broker.fro.bot` (deployed from `marcusrbrown/infra`) to mint a **GitHub App installation token** in addition to the model `auth.json` it already mints:

1. **Hold the fro-bot App credentials in the broker.** The broker needs the fro-bot GitHub App's `app-id` + private key (the same App already installed on `fro-bot/agent` with `contents: write`, used at `harness-release.yaml:1135-1140`). These become broker-side secrets — they must NOT be exposed as CI secrets on the integrate path.
2. **New mint output (or new endpoint).** On a valid OIDC exchange from the integrate workflow, the broker mints an installation token via `POST /app/installations/{id}/access_tokens` with:
   - `repositories: ["agent"]` (single repo — `fro-bot/agent`)
   - `permissions: { contents: "write" }` (nothing else — `response-mode: none` means no issue/PR/review posting on this path)
   - default ~1h TTL
   Return it to the caller either as an added field on the existing `/v1/mint` response, or via a distinct endpoint/claim. (Decision below — R3.)
3. **Allowlist unchanged in shape.** The integrate workflow is already allowlisted on the broker by `job_workflow_ref` = `fro-bot/agent/.github/workflows/harness-integrate.yaml@refs/heads/main` (+ repository_id `1126485011`, repository_owner_id `80104189`) per the #1060 work. Adding App-token minting to that same authorized exchange needs **no new allowlist entry** — but confirm the broker's mint handler applies the SAME allowlist gate before minting the App token (fail-closed 403 if not allowlisted), identical to the model-credential path.
4. **Fail-closed.** Any failure to mint the App token → non-2xx → the workflow fails closed (no durable fallback), exactly as the model-credential mint does today.

**Precise inputs Marcus needs on the infra side:**
- fro-bot App `app-id` and private key (broker-held secrets).
- The installation id for the fro-bot App on `fro-bot/agent` (broker resolves it, or it's configured).
- Confirm the fro-bot App installation on `fro-bot/agent` grants `contents: write` (verified in-repo: it already mints a contents:write-used token at `harness-release.yaml:1130-1156`).

## In-repo half (I do this — BLOCKED on the infra action above)

Once the broker returns an App token:

- **`scripts/harness/mint-broker-credential.ts`** — extend to consume + emit the App token as a second masked step output (e.g. `github-token`), mirroring the existing `auth-json` contract exactly: mask immediately, all-or-nothing validation, never to disk/env, fail closed. Token shape validation via the existing `apps/workspace-agent/src/sanitize.ts` `validateTokenShape` pattern.
- **`.github/workflows/harness-integrate.yaml`** — replace `github-token: ${{ secrets.FRO_BOT_PAT }}` (line 96) with `github-token: ${{ steps.mint.outputs.github-token }}`; drop `FRO_BOT_PAT` from the `secrets:` block (lines 30-32). Keep checkout on the default `GITHUB_TOKEN` (`contents: read`) with `persist-credentials: false` — do NOT spend the App-token TTL on checkout/setup; mint as late as possible before "Run Fro Bot". One-job invariant preserved (no new job).
- **`.github/workflows/harness-release.yaml`** — stop passing `FRO_BOT_PAT` into the integrate reusable-workflow call (line 208).
- **`packages/harness/prompt.txt`** — the push block (lines 74-95) already uses `GH_TOKEN`; `GH_TOKEN` will now carry the broker-minted App token instead of the PAT. Verify the `x-access-token` askpass pattern works with an installation token (it does — installation tokens auth as `x-access-token:<token>` over HTTPS).

## Requirements

- R1. The prompt-injectable integrate agent must never hold a durable credential — only a short-lived (~1h) token scoped to `contents: write` on `fro-bot/agent`. → infra + in-repo
- R2. The fro-bot App private key must never be exposed as a CI secret on the integrate path; it stays broker-side. → infra
- R3. **Decision:** add the App token to the existing `/v1/mint` response (one exchange, one OIDC token) vs a second endpoint/exchange. Lean: **single exchange, added response field** — the OIDC token is single-use per jti, so a second exchange would need a second OIDC token; extending the one response is simpler and matches the "one mint per run" model. → infra
- R4. Mint the App token as late as possible in the job (right before "Run Fro Bot") so the ~1h TTL isn't consumed by checkout/build; the integrate merge+build+push must complete within the TTL (normally minutes — headroom is large). → in-repo
- R5. `contents: write` only — no `pull-requests`/`issues`/`workflows`. Verified sufficient: checkout (read⊂write) + `git push` to `refs/harness-integrate/*` + `response-mode: none` (no posting). → infra + in-repo
- R6. Fail closed on any mint failure — no durable fallback (mirror the existing model-credential contract). → both
- R7. The change must not add a job to `harness-integrate.yaml` (one-job security invariant, lines 2-14) and must not disturb the existing broker OIDC model-credential mint. → in-repo

## Sequencing

Two-PR / cross-repo split (mirrors #1060 → infra#725):
1. **Infra (Marcus, marcusrbrown/infra):** broker mints the fro-bot App token. Ships first.
2. **In-repo (me, fro-bot/agent):** mint-script + workflow wiring to consume it. Blocked on (1); I verify end-to-end against the live broker before closing #1107.

PR #1119 (log-mask + env-scrub hygiene) shipped the interim defense-in-depth and #1107 was closed with it. The broker-mint fix in this doc is tracked by the dedicated `marcusrbrown/infra` issue (infra half) and a fresh `fro-bot/agent` issue for the in-repo wiring half — not by reopening #1107.

## Sources

- Issue #1107; PR #1119 (in-repo hygiene, partial).
- Existing broker: `scripts/harness/mint-broker-credential.ts`, `docs/plans/2026-07-01-001-feat-harness-merge-credential-broker-plan.md`, `docs/solutions/workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md`.
- fro-bot App already on fro-bot/agent with contents:write: `.github/workflows/harness-release.yaml:1130-1156`.
- Constraint: a shared-App key mints the App's full install scope (memory / dashboard#112 precedent) — which is why the key stays broker-side, not on the runner.
