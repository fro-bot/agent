---
title: 'feat: replace FRO_BOT_PAT with an inline-minted scoped App token on the integrate path'
type: feat
status: active
date: 2026-07-11
origin: https://github.com/fro-bot/agent/issues/1126
---

# feat: replace FRO_BOT_PAT with an inline-minted scoped App token on the integrate path

## Overview

`harness-integrate.yaml` hands its prompt-injectable LLM merge agent the durable, broad classic PAT `FRO_BOT_PAT`. This plan replaces it with a short-lived (~1h), single-repo, `contents: write`-only GitHub App installation token, minted by a trusted inline no-post step inside the same job. After this lands, `FRO_BOT_PAT` is gone from the integrate path entirely; the worst a fully compromised merge agent can do with its credential is push to `fro-bot/agent` for under an hour.

Design source: issue #1126 (supersedes the broker-side mint explored in `marcusrbrown/infra#771` and the older brainstorm `docs/brainstorms/2026-07-04-harness-integrate-app-token-broker-requirements.md` — the broker-consumption half of that doc is superseded; its security-contract requirements for mint scripts survive and are honored here).

## Problem Frame

The integrate job runs an autonomous OpenCode agent over upstream PR content (prompt-injectable by construction). That agent needs a GitHub credential for exactly one thing: `git push` of the integration result to `refs/harness-integrate/<version>`. Today it holds `FRO_BOT_PAT` — durable, account-broad, and usable anywhere. Interim hygiene (#1119) masks and scrubs copies but cannot isolate a credential the agent genuinely needs. Credential minimization is the root-cause fix: mint per-run, scope to one repo and one permission, expire in ~1h.

## Requirements Trace

- R1. The merge agent never holds a durable credential — only a ~1h App installation token scoped `{contents: write}` on `fro-bot/agent` alone.
- R2. `FRO_BOT_PAT` is removed from the integrate path entirely (workflow_call secrets decl, checkout, github-token input, caller pass-through).
- R3. The App **private key** never leaves the trusted mint step: mapped only to that step's `env` (never job-level env, never `with:` of a post-hooked action), never written to disk, `$GITHUB_OUTPUT`, or `$GITHUB_ENV`, and never included in error text. The minted **token** is intentionally handed off via a masked `$GITHUB_OUTPUT` step output — it is the same token the merge agent receives anyway, so its on-disk step-output residence adds no authority the agent doesn't already hold.
- R4. No `actions/create-github-app-token` or any post-hooked action performs the mint (post-phase `INPUT_*` re-injection + same-job on-disk tamper vector — see issue #1126 evidence).
- R5. Fail closed: any mint failure fails the job before the merge step runs; no durable-credential fallback.
- R6. One-job security invariant preserved (broker OIDC allowlist pins `job_workflow_ref`; no new job).
- R7. End-to-end proof on a real dispatch: mint succeeds, LLM merge runs, push to `refs/harness-integrate/<version>` completes on the App token.

## Scope Boundaries

- No egress-containment changes (that half is `marcusrbrown/infra#751`).
- No changes to the broker OIDC model-credential mint (`scripts/harness/mint-broker-credential.ts` stays as-is; the new mint is a sibling).
- No changes to `packages/harness/prompt.txt` — the push block consumes `GH_TOKEN` via `x-access-token` askpass (prompt.txt:74-95), and an installation token is a verified drop-in.
- Optional token revoke step (`DELETE /installation/token`) deferred — hygiene, not a boundary; TTL is the boundary.

### Deferred to Separate Tasks

- Dedicated minimal App migration if the current App's installed scope is broad (operator decision after U0 verification).
- workflow_dispatch/schedule model-credential minimization for the main fro-bot.yaml flows (#1167 residual, infra-dependent).

## Context & Research

### Relevant Code and Patterns

- `scripts/harness/mint-broker-credential.ts:5-18,112-166` — the mint-script security contract to mirror exactly: mask secret material immediately (before any log/throw), single bounded request (no retry), all-or-nothing response validation, masked step output only, fail closed via `process.exitCode = 1`.
- `scripts/harness/mint-broker-credential.test.ts` — test patterns: URL resolution, invalid-payload rejection, all-or-nothing, happy-path masking/output ordering.
- `.github/workflows/harness-integrate.yaml:29-32,77-82,92-96` — the three FRO_BOT_PAT entry points; step order harden-runner → checkout → setup → broker mint → Run Fro Bot; permissions `{id-token: write, contents: read}` (:53-55); harden-runner allowlist already includes `api.github.com:443` (:64-75) so the mint's REST calls clear egress.
- `.github/workflows/harness-release.yaml:206-210` — explicit secrets pass-through (`secrets: inherit` deliberately dropped in the #1060 hardening); new secrets must be threaded explicitly.
- `src/services/setup/setup.ts:307-314` + `packages/runtime/src/agent/response-delivery.ts` — on the integrate path the caller's event (`workflow_dispatch`/`push`, per fro-bot.yaml:38-43 the callee sees the caller's event) classifies credential=provision, so the action exports the supplied `github-token` as `GH_TOKEN` for the agent's push. Unchanged by this plan; the token *value* changes from PAT to App token.

### Institutional Learnings

- `docs/solutions/workflow-issues/create-github-app-token-caller-mint-invalid-2026-07-04.md` — mint cannot live in the caller (a `uses:` job has no steps; `secrets:` can't read `steps.*`). Validates the inline-in-called-job placement.
- `docs/solutions/best-practices/same-job-phase-split-not-a-security-boundary-2026-07-04.md` — step ordering is not a boundary against an *earlier* hostile step or *post* hooks. Here the key-bearing step runs before the injectable step and has no post hook, which is exactly why the no-post constraint (R4) is load-bearing.
- `docs/solutions/best-practices/reusable-workflow-permissions-replace-not-merge-2026-07-01.md` — caller job must keep `{id-token: write, contents: read}`; no permission changes needed (App mint uses the App JWT, not GITHUB_TOKEN).
- `docs/solutions/workflow-issues/harden-runner-allowed-endpoints-literal-scalar-drops-endpoints-2026-07-07.md` — allowlist scalar stays folded (`>-`); no allowlist change needed (api.github.com present).
- `docs/solutions/workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md` — fail-closed mint hygiene contract; also documents why scrubs alone can't isolate a needed credential (minimization is the fix).

## Key Technical Decisions

- **Inline no-post mint via checked-in script, not `actions/create-github-app-token`**: the marketplace action declares a `post:` hook; the runner re-supplies `INPUT_PRIVATE-KEY` at post time, and a prompt-injected step can tamper the on-disk post script → key exfiltration. A plain `run:` step invoking a checked-in script has no post phase. (origin: #1126)
- **Hand-rolled RS256 App JWT via `node:crypto`, zero new dependencies**: the mint needs one JWT signature (`crypto.createSign('RSA-SHA256')`) and two REST calls (`GET /repos/fro-bot/agent/installation` for the installation id, `POST /app/installations/{id}/access_tokens`). Adding `@octokit/auth-app` or a JWT lib for this is dependency sprawl on a security-critical path; the broker mint script set the no-deps precedent.
- **Key mapped step-env-only**: `APPLICATION_ID`/`APPLICATION_PRIVATE_KEY` appear in the mint step's `env:` block only (R3). This prevents exposure through normal step env inheritance — it is not claimed as a standalone isolation guarantee (same-job on-disk surfaces are the real boundary concern); the load-bearing protections are no-post (R4), no disk writes, constant-class error text, and fail-closed.
- **Scoped mint request**: token request body carries `permissions: {contents: 'write'}` and `repositories: ['agent']`; response validation asserts BOTH echoes match exactly — `permissions` equal to `{contents: 'write'}` AND the repository scope equal to the single `agent` repo (all-or-nothing — any broader/narrower/absent echo on either axis fails the mint). The exact echo field shape (`repositories` array of repo objects vs `repository_selection`) is pinned against the live REST response during U1 test writing.
- **Checkout moves to the default `GITHUB_TOKEN`**: checkout needs only `contents: read` (already granted); spending the ~1h App-token TTL on checkout/setup is waste and widens exposure. Mint as late as possible — immediately before Run Fro Bot.
- **Mint-step placement after the broker mint**: keeps the two mints adjacent and the token's exposure window minimal; both are trusted steps preceding the injectable one.

## Open Questions

### Resolved During Planning

- Does harden-runner egress permit the mint? Yes — `api.github.com:443` already allowlisted (harness-integrate.yaml:64-75).
- Does the prompt's push path accept an installation token? Yes — `x-access-token:<token>` over HTTPS (prompt.txt:74-95); installation tokens authenticate exactly this way.
- Are the App secrets available? Yes — `APPLICATION_ID` (2026-01-02) and `APPLICATION_PRIVATE_KEY` (2026-01-02) exist as repo Actions secrets.
- How do secrets reach the reusable workflow? Explicitly — `harness-release.yaml` passes named secrets (no `inherit`); both new secrets must be declared in `workflow_call` and passed by the caller.

### Deferred to Implementation

- Exact installation-id lookup response shape assertions: pin against the live REST response during U1 test writing.

## Implementation Units

- [ ] **Unit 0: Verify App installed scope (precondition)**

**Goal:** Confirm the App behind `APPLICATION_ID` is installed on `fro-bot/agent` with permissions covering `contents: write`, and record its full installed scope so the blast radius of key theft is known.

**Requirements:** R1 (scoping feasibility)

**Dependencies:** None. Operator-assisted: requires reading the App installation via an App JWT or the GitHub UI (Settings → GitHub Apps).

**Files:** none (verification only; findings recorded in the PR description)

**Approach:**
- Mint an App JWT locally or inspect via UI; `GET /app` + `GET /app/installations` to enumerate installed repos + permissions.
- If installed scope is broad (many repos or permissions beyond contents/metadata), surface to the operator: proceed (token is scoped regardless; key custody unchanged) and file the dedicated-App migration as the deferred task.

**Test scenarios:** Test expectation: none — verification-only unit.

**Verification:** Installed scope documented; `contents: write` on `fro-bot/agent` confirmed available to mint.

- [ ] **Unit 1: `scripts/harness/mint-app-token.ts` + tests**

**Goal:** A no-deps, no-post mint script mirroring the broker-mint security contract, emitting a single masked `github-token` step output.

**Requirements:** R1, R3, R4, R5

**Dependencies:** Unit 0

**Files:**
- Create: `scripts/harness/mint-app-token.ts`
- Test: `scripts/harness/mint-app-token.test.ts`

**Approach:**
- Read `APPLICATION_ID` + `APPLICATION_PRIVATE_KEY` from `process.env`; `core.setSecret` the key material immediately; fail closed if either is missing/empty.
- Build RS256 App JWT with `node:crypto` (`iat` backdated 60s, `exp` +9min, `iss` = app id).
- Call `GET /repos/fro-bot/agent/installation` (App JWT auth) → installation id; then `POST /app/installations/{id}/access_tokens` with `{repositories: ['agent'], permissions: {contents: 'write'}}`.
- All-or-nothing validation: response must carry a non-empty `token` (mask it via `setSecret` before ANY other statement), an `expires_at` timestamp, echoed `permissions` exactly `{contents: 'write'}`, AND a repository echo naming exactly the `agent` repo — any mismatch or extra grant on either axis fails the mint.
- Error hygiene: `setSecret` the private key before any parsing; every failure path throws/logs constant-class messages only (e.g. `app-jwt-build-failed`, `installation-lookup-failed`, `token-mint-failed`) — never interpolate caught error text, PEM content, or response bodies into emitted errors (the key/token could ride along in a parser message).
- Single bounded attempt per request (shared `AbortSignal.timeout`, body read inside the guard — the #1081 lesson); no retry; `process.exitCode = 1` on any failure.
- Emit only `core.setOutput('github-token', token)`. Never write the key or token to disk, `GITHUB_ENV`, or logs.

**Patterns to follow:** `scripts/harness/mint-broker-credential.ts` (contract + structure), its test file (mock fetch, ordering assertions).

**Test scenarios:**
- Happy path: valid env + mocked 200s → output emitted, `setSecret(token)` called BEFORE `setOutput` (ordering assertion).
- Error path: missing/empty `APPLICATION_ID` or key → exitCode 1, no fetch.
- Error path: installation lookup 404/non-200 → exitCode 1, no token request.
- Error path: token response missing `token`/`expires_at` → exitCode 1, no output.
- Edge case: echoed permissions broader than requested (e.g. `{contents: 'write', issues: 'write'}`) → rejected, exitCode 1.
- Edge case: echoed permissions narrower (`{contents: 'read'}`) → rejected.
- Edge case: repository echo missing the `agent` repo, or naming additional repos → rejected, exitCode 1.
- Error path: key-parse failure (malformed PEM) → exitCode 1 with a constant-class message; assert the error/log output contains no PEM fragment.
- Integration: JWT shape — decode the generated JWT header/payload (no signature verify) and assert `alg: RS256`, `iss`, `iat < exp`.
- Error path: fetch timeout/abort → exitCode 1 (no hang, body read guarded).

**Verification:** `bun run test:scripts` green; script passes lint + the Node 24 strip-only TS constraints (no non-erasable syntax).

- [ ] **Unit 2: Wire the mint into `harness-integrate.yaml`**

**Goal:** Integrate job mints and consumes the scoped token; `FRO_BOT_PAT` fully removed from the workflow.

**Requirements:** R1, R2, R3, R5, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `.github/workflows/harness-integrate.yaml`

**Approach:**
- `workflow_call.secrets`: drop `FRO_BOT_PAT`; add `APPLICATION_ID` + `APPLICATION_PRIVATE_KEY` (required, with descriptions).
- Checkout step: `token: ${{ github.token }}` (default, `contents: read`), keep `persist-credentials: false`.
- New step "Mint scoped App token" (id: `mint-app-token`) between the broker mint and Run Fro Bot: `run:` invoking the script via the same Node invocation pattern as the broker mint step; `env:` block carries ONLY the two App secrets — job-level env untouched.
- Run Fro Bot step: `github-token: ${{ steps.mint-app-token.outputs.github-token }}`.
- One-job invariant: no new jobs; permissions block unchanged.

**Test scenarios:** Test expectation: none — workflow YAML has no unit-test harness; behavior is proven by U4's live dispatch. `js-yaml`-parse sanity via existing lint/CI.

**Verification:** YAML parses; grep confirms zero `FRO_BOT_PAT` references remain in the file; step order harden-runner → checkout → setup → broker mint → app mint → Run Fro Bot.

- [ ] **Unit 3: Caller pass-through in `harness-release.yaml`**

**Goal:** The integrate call passes the App secrets and stops passing the PAT.

**Requirements:** R2

**Dependencies:** Unit 2 (lands in the same PR — the secrets contracts must move together)

**Files:**
- Modify: `.github/workflows/harness-release.yaml`

**Approach:**
- In the `integrate` job's `secrets:` block (:206-210): remove `FRO_BOT_PAT`, add `APPLICATION_ID: ${{ secrets.APPLICATION_ID }}` and `APPLICATION_PRIVATE_KEY: ${{ secrets.APPLICATION_PRIVATE_KEY }}`.
- Caller job permissions unchanged (`{id-token: write, contents: read}` — the replace-not-merge trap already handled).

**Test scenarios:** Test expectation: none — same rationale as Unit 2.

**Verification:** Zero `FRO_BOT_PAT` references remain on the integrate path across both workflows (release workflow may still use it elsewhere — only the integrate call changes).

- [ ] **Unit 4: End-to-end proof on a real dispatch**

**Goal:** Prove the full pipeline on the App token (R7) — fail-closed if anything is mis-wired.

**Requirements:** R5, R7

**Dependencies:** Units 2-3 merged to main (the release workflow dispatches from main).

**Files:** none

**Approach:**
- Dispatch `harness-release.yaml` with the current base version. The workflow has a `dry_run` input, and publish is idempotent per package/version (existing versions are skipped) — prefer `dry_run: true` when only mint/merge verification is wanted; a full run is safe for already-published versions but still executes the whole build/release orchestration.
- Watch the integrate job: app-token mint step succeeds (masked output), merge agent runs, push to `refs/harness-integrate/<version>` succeeds authenticated as the App.
- Confirm from logs the push authenticated via the App token (pusher identity = the App's bot user), and that no step env carries the PAT.

**Test scenarios:** Test expectation: none — live verification unit.

**Verification:** Green integrate job on a real dispatch; push ref exists; workflow run shows the App-token mint step; `FRO_BOT_PAT` absent from the job's secret surface.

## System-Wide Impact

- **Interaction graph:** integrate path only. The fro-bot.yaml comment/review + dispatch/schedule flows are untouched (their github-token remains as-is). The broker model-credential mint is untouched.
- **Error propagation:** mint failure → step exit 1 → job fails before the merge step (fail-closed, no fallback). Same posture as the broker mint.
- **State lifecycle risks:** the App token expires ~1h after mint; the integrate merge has completed well within that in all observed runs (~15 min worst case). If a pathological merge exceeds TTL, the push fails with 401 — fail-closed, re-dispatch.
- **API surface parity:** none — the `github-token` input contract of the action is unchanged; only the supplied value's provenance changes.
- **Unchanged invariants:** one-job integrate workflow; broker OIDC `job_workflow_ref` allowlist; harden-runner egress allowlist; response-mode none (no posting from the merge agent).

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| App's installed scope is broader than needed (key theft blast radius) | U0 documents it; dedicated-App migration filed as deferred task if broad. Key custody is unchanged by this plan (same secret, same repo) — the plan strictly shrinks what the *agent* holds. |
| Post-hook tamper vector reintroduced later by swapping in a marketplace action | R4 is explicit in the workflow comment on the mint step; the learnings doc records the evidence. |
| Token TTL expiry mid-merge | Mint placed immediately before the merge step; observed merge duration ≤ ~15 min vs ~60 min TTL. Fail-closed on expiry. |
| Echoed-permissions drift (GitHub grants more than requested) | All-or-nothing validation rejects any echo ≠ `{contents: 'write'}`. |
| Missing secrets at the callee (explicit pass-through forgotten) | Units 2+3 land in one PR; `workflow_call` marks both secrets `required: true` so a missing pass-through fails at dispatch, not mid-run. |

## Sources & References

- **Origin:** issue #1126 (design + evidence); #1124 closed as superseded; `marcusrbrown/infra#771` closed (broker-side mint ruled out).
- Prior brainstorm (partially superseded): `docs/brainstorms/2026-07-04-harness-integrate-app-token-broker-requirements.md`
- Related PRs: #1119 (interim hygiene), #1080/#1081/#1082 (broker mint arc), #1170 (comment/review credential removal)
- Related code: `scripts/harness/mint-broker-credential.ts`, `.github/workflows/harness-integrate.yaml`, `.github/workflows/harness-release.yaml`
