---
date: 2026-07-01
topic: harness-merge-credential-broker
---

# Harness Merge Credential Broker — Consuming Side

## Summary

Wire the harness merge path to run on a short-lived, broker-minted cliproxy token instead of the durable model credential. Two sequenced deliverables: an env-hygiene scrub that ships independently, then a dedicated `harness-integrate.yaml` reusable workflow that requests a GitHub OIDC token, mints an `auth.json` from `broker.fro.bot`, and provisions it to the merge agent — with revocation handled by the broker's TTL and sweeper.

---

## Problem Frame

The production harness integrate job runs an autonomous LLM merge with the durable model credential reachable on the same filesystem as the merge agent's tools. `harness-release.yaml`'s `integrate` job calls `fro-bot.yaml` as a reusable workflow (`secrets: inherit`, `response-mode: none`), which provisions `auth-json` from `secrets.AUTH_JSON` and runs the merge agent (`--agent build`). The job is read-only toward GitHub, and the credential is written `0600` and never echoed — but the merge agent's bash/read/edit tools execute with host-user filesystem authority, so nothing structurally prevents a spawned tool from reading the credential path.

Two exposures compound. First, `auth-json` is read via `core.getInput('auth-json')` from `INPUT_AUTH_JSON`, which GitHub Actions leaves in the step's process env; there is no scrub after the on-disk write, so the raw secret stays env-dumpable and is inherited by the merge agent's child processes. Second, the durable provider key itself is present on the runner for the whole merge. An OpenCode permission config cannot close this — bash permission checks are advisory only — so the boundary has to be at the credential-lifetime and process layers.

The infra side is already built: an OIDC credential broker at `broker.fro.bot` mints a short-lived, revocable cliproxy token in exchange for a verified GitHub OIDC assertion, so the merge agent never holds the durable key. This work is the consuming side in this repo.

---

## Actors

- A1. Release orchestrator (`harness-release.yaml`): resolves the carry set and invokes the merge path when `has_refs == 'true'`.
- A2. Merge workflow (`harness-integrate.yaml`, new): the dedicated reusable workflow that requests the OIDC token, mints and provisions the credential, and runs the merge agent.
- A3. Merge agent (OpenCode `--agent build`): the autonomous process whose tools must never reach the durable credential.
- A4. Credential broker (`broker.fro.bot`, infra-side): verifies the OIDC assertion against its allowlist, mints the short-lived cliproxy token, and reaps it via TTL and a sweeper.
- A5. Operator (Marcus): un-placeholders the broker allowlist on `marcusrbrown/infra` so the mint can succeed.

---

## Key Flows

- F1. Harness merge on a brokered credential
  - **Trigger:** `harness-release.yaml` `integrate` invokes the merge path with a non-empty carry set.
  - **Actors:** A1, A2, A3, A4
  - **Steps:** (1) the merge workflow requests a GitHub OIDC token for audience `https://broker.fro.bot`; (2) it POSTs the token to `/v1/mint`; (3) the broker verifies issuer/signature/audience/expiry and matches claims against its allowlist; (4) on a match it returns an `auth.json` payload carrying a short-lived cliproxy token; (5) the workflow provisions that payload as the merge agent's `auth-json`, with the durable key never written on the runner; (6) the merge agent runs; (7) the minted token expires and is swept by the broker's TTL/sweeper after the run.
  - **Outcome:** the merge completes using a credential that is cliproxy-scoped and short-lived, with the durable provider key absent from the runner.
  - **Covered by:** R3, R4, R5, R6

---

## Requirements

**Environment hygiene (ships first, no infra dependency)**
- R1. After the auth credential is written to disk, scrub the raw secret from the harness process environment (`INPUT_AUTH_JSON`) so it is no longer env-dumpable.
- R2. Do not propagate the raw auth secret in the environment inherited by the OpenCode server child process.

**Brokered credential for the harness merge (needs the infra allowlist un-placeholdered)**
- R3. Extract the harness merge path into a dedicated reusable workflow (`harness-integrate.yaml`) that `harness-release.yaml` calls in place of the current direct `fro-bot.yaml` invocation, so `id-token: write` is scoped to the merge path only and never granted to the shared `fro-bot.yaml`.
- R4. In the merge workflow, request a GitHub OIDC token for audience `https://broker.fro.bot` and exchange it at `POST https://broker.fro.bot/v1/mint`.
- R5. Provision the minted `auth.json` as the merge agent's credential, and withhold the durable provider key from the integrate path entirely — the dedicated workflow must not use `secrets: inherit` and must not receive `secrets.AUTH_JSON`, so the durable key is neither written to disk nor present in any step's environment on the integrate runner.
- R6. When the mint fails or returns no credential, the merge path fails closed — it does not fall back to the durable key.
- R7. Rely on the broker's TTL and sweeper for revocation; the minted token's short lifetime bounds exposure. The broker exposes no caller-facing revoke endpoint, so the consuming side sends no run-end ping. The residual exposure window equals the token TTL: if the token is stolen mid-run, it stays valid until expiry/sweep with no in-run kill switch — acceptable because egress from the integrate job plus the token's cliproxy-only scope bound its value. Confirm the broker's actual TTL is short enough to cover a normal merge without over-extending this window; if immediate revocation is wanted later, file an infra follow-up to add a revoke endpoint.

**Cross-repo enablement**
- R8. Surface the exact broker-allowlist values the operator must set on `marcusrbrown/infra`, with instructions, so the mint can be un-placeholdered and the end-to-end path verified.

---

## Acceptance Examples

- AE1. **Covers R5.** Given the dedicated integrate workflow does not inherit `AUTH_JSON` (no `secrets: inherit`, secret not passed), when the merge agent and any of its child processes or sibling steps run, then the durable `secrets.AUTH_JSON` / `INPUT_AUTH_JSON` value is unreachable in every step environment, child-process environment, and on disk — only the short-lived cliproxy token is present. The assertion checks all inherited step and child envs, not just the final agent context.
- AE2. **Covers R6.** Given the broker returns a non-match or error, when the mint step runs, then the workflow fails without provisioning the durable credential.
- AE3. **Covers R1, R2.** Given the credential has been written to disk, when the merge agent spawns a child process, then that child's environment does not contain the raw auth secret.
- AE4. **Covers R7.** Given the merge finishes, when the run ends, then no durable credential remains valid — the minted token is bounded by the broker's TTL and reaped by its sweeper, and the workflow sends no revoke call.

---

## Success Criteria

- The merge agent cannot read the durable model credential path — the durable key is never on the integrate runner, only a short-lived cliproxy token.
- Verified against a real harness dispatch (not config inspection): a live integrate run completes on the minted credential after the operator un-placeholders the allowlist.
- The env-hygiene deliverable lands and verifies independently, before the broker allowlist is settled.
- The operator has an unambiguous, copy-ready list of the infra-side values and steps, surfaced at the point they are needed.

---

## Scope Boundaries

- Egress containment for the integrate job (retained item 1 of #1060) — deferred to `infra#725`. The broker shrinks the credential's value and lifetime; it does not constrain in-run network reach.
- The infra-side broker implementation and the allowlist un-placeholder action — owned by `marcusrbrown/infra`; this doc only surfaces the values and instructions the operator needs.
- Log redaction — already handled by `formatPipelineError`; this work is about read-access and credential lifetime, not log hygiene.
- Changing the merge agent, model, or carry-set resolution logic — unchanged; only how its credential is provisioned changes.

---

## Key Decisions

- Dedicated `harness-integrate.yaml` over gating the shared `fro-bot.yaml`: keeps `id-token: write` entirely off the general Fro Bot path (issues/comments/schedule/dispatch), at the cost of some setup duplication between the two workflows. Because the dedicated workflow does only the merge, no extra `credential-source` marker gate is needed to keep the mint off non-harness runs.
- Pin the broker allowlist on the `job_workflow_ref` claim → `fro-bot/agent/.github/workflows/harness-integrate.yaml@refs/heads/main`: GitHub designed `job_workflow_ref` to constrain which reusable workflow actually ran, independent of caller; it binds the mint to the exact code that touches the key, which is tighter than the caller-side `workflow_ref`.
- Withhold `AUTH_JSON` by construction, not by scrubbing: the dedicated workflow drops `secrets: inherit` and passes only the secrets the merge genuinely needs, so the durable key is never on the integrate runner. This is what makes R5 satisfiable — under `secrets: inherit` the durable key would still be inherited into the called workflow's environment and the "brokered only" boundary would be fake. The env scrub (R1–R2) is defense-in-depth for the shared non-harness paths that still carry `AUTH_JSON`, not the primary control for the harness path.
- Sequence the env scrub first (no infra dependency, independently testable) and the broker wiring second (blocked on the allowlist un-placeholder), so credential-lifetime progress is not gated on the disk-exposure reduction and vice versa. The two are genuinely independent: the scrub hardens the shared `fro-bot.yaml` paths that keep using `AUTH_JSON`, while the harness path drops `AUTH_JSON` entirely — neither depends on the other landing first.
- Ship the two deliverables as separate PRs: R1–R2 (env-hygiene scrub, shared-flow defense-in-depth) land first as their own focused change; R3–R8 (broker wiring) land second. They live in one requirements doc because they tell one credential-isolation story, but the env scrub touches the shared auth-json plumbing and earns its own review surface.
- Revocation via the broker's TTL/sweeper, no run-end ping: the broker exposes no caller-facing revoke endpoint, and the minted token's short lifetime bounds exposure. Keeps the consuming side simple; an immediate-revoke endpoint can be added infra-side later if wanted.

---

## Dependencies / Assumptions

- The broker at `broker.fro.bot` is live: `POST /v1/mint` with `Authorization: Bearer <github-oidc-token>`, verifying GitHub issuer, RS256 against the published JWKS, audience, expiry, and `jti` replay; it refuses `pull_request`/`pull_request_target` events and fail-closes on a non-matching or placeholder allowlist.
- The broker returns the minted credential shaped as an OpenCode `auth.json` payload.
- Workflow-file integrity is a load-bearing part of the trust model: the `job_workflow_ref` pin authorizes whatever `harness-integrate.yaml` contains on `refs/heads/main`, so the guarantee depends on `main` being edit-protected. `main` enforces branch protection with admin enforcement, so an unauthorized edit to the minting logic on the pinned ref is blocked — but any change to `harness-integrate.yaml` is security-relevant and must be reviewed as such.
- **Cross-repo action required on `marcusrbrown/infra` before the end-to-end path can succeed** — the broker allowlist is deployed fail-closed with placeholders and must be un-placeholdered with these exact values:
  - `repository_id`: `1126485011`
  - `repository_owner_id`: `80104189` (`fro-bot` org)
  - `job_workflow_ref`: `fro-bot/agent/.github/workflows/harness-integrate.yaml@refs/heads/main`
  - Until these are set, the mint fails closed and R3–R7 cannot be verified live. This is the one blocking external dependency; the env-hygiene deliverable (R1–R2) does not depend on it.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R3][Technical] Whether `harness-integrate.yaml` re-invokes the same `fro-bot/agent` action with the minted `auth-json` or is a trimmed copy of the merge setup — determines how much of `fro-bot.yaml`'s setup is shared vs duplicated.
- [Affects R4][Technical] The token-request mechanism inside the workflow (`core.getIDToken('https://broker.fro.bot')` in a small step vs an action) and where the mint HTTP call lives.
- [Affects R1, R2][Technical] The exact scrub seam — where in `src/harness/config/inputs.ts` / `src/features/agent/server.ts` the env delete and child-env exclusion belong so the file write still succeeds.
- [Affects R5][Technical] The exact secret-passing mechanics for the dedicated workflow — R5 requires dropping `secrets: inherit` and passing only the secrets the merge needs explicitly (not `AUTH_JSON`). Planning confirms which secrets the merge genuinely requires (e.g. `FRO_BOT_PAT`, `OPENCODE_CONFIG`) and wires them individually.
