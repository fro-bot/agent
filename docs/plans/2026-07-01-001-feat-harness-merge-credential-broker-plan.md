---
title: "feat: Harness merge credential broker — consuming side"
type: feat
status: active
date: 2026-07-01
deepened: 2026-07-01
origin: docs/brainstorms/2026-07-01-harness-merge-credential-broker-requirements.md
---

# feat: Harness merge credential broker — consuming side

## Overview

Isolate the production harness LLM-merge agent from the durable model credential. Two sequenced deliverables shipped as separate PRs: (1) an env-hygiene scrub that removes the durable `auth-json` secret from the harness process environment so it cannot be dumped or inherited by the OpenCode child; (2) a dedicated `harness-integrate.yaml` reusable workflow that mints a short-lived credential from the OIDC broker (`broker.fro.bot`) and runs the merge on it, dropping `secrets: inherit` so the durable key never reaches the integrate runner.

**Attacker model:** a compromised OpenCode merge-agent tool (bash/read/edit) running with host-user filesystem authority on the GitHub Actions runner. It can read `process.env` and any `0600` file, and has outbound network access. It cannot modify workflow YAML or branch protection (`main` is `enforce_admins`-protected). The isolation target is the durable **model** key (`AUTH_JSON`); `GITHUB_TOKEN` is auto-injected and out of this plan's reach (capability-restricted via `permissions:`, exfiltration deferred to `infra#725`).

## Problem Frame

The `integrate` job in `.github/workflows/harness-release.yaml` runs an autonomous LLM merge by calling `.github/workflows/fro-bot.yaml` with `secrets: inherit` and `auth-json: ${{ secrets.AUTH_JSON }}`. The durable model key is written `0600` to disk and, because `core.getInput('auth-json')` leaves `INPUT_AUTH_JSON` in `process.env` and the OpenCode SDK spawns its child with `{ ...process.env }` (`.slim/clonedeps/repos/anomalyco__opencode/packages/sdk/js/src/server.ts:35-40`), the raw secret is both env-dumpable and inherited by the merge agent's tools, which run with host-user filesystem authority. An OpenCode permission config cannot sandbox those tools, so the boundary must be at the credential-lifetime and process/secret layers. The infra-side broker is already built and live; this plan is the consuming side (see origin: docs/brainstorms/2026-07-01-harness-merge-credential-broker-requirements.md).

## Requirements Trace

- R1. Scrub the raw `auth-json` secret (`INPUT_AUTH_JSON`) from the harness process environment after the value is read, so it is no longer env-dumpable, and register it with `core.setSecret` for log masking.
- R2. Ensure the scrubbed secret is not propagated into the OpenCode server child process environment.
- R3. Add a dedicated `harness-integrate.yaml` reusable workflow that scopes `id-token: write` to the merge path only, never granting it to shared `fro-bot.yaml`.
- R4. In the merge workflow, request a GitHub OIDC token for audience `https://broker.fro.bot` and exchange it at `POST https://broker.fro.bot/v1/mint`.
- R5. Provision the minted `auth.json` as the merge agent's credential and withhold the durable key from the integrate path entirely — drop `secrets: inherit`, do not pass `AUTH_JSON`.
- R6. When the mint fails or returns no credential, the merge path fails closed — no fallback to the durable key.
- R7. Rely on the broker's TTL and sweeper for revocation; no caller-side revoke ping.
- R8. Surface the exact broker-allowlist values the operator must set on `marcusrbrown/infra`, with instructions.

## Scope Boundaries

- Egress containment for the integrate job — deferred to `infra#725`. The broker shrinks the credential's value and lifetime; it does not constrain in-run network reach.
- The infra-side broker implementation and the allowlist un-placeholder — owned by `marcusrbrown/infra`.
- Log redaction beyond `setSecret` masking — already handled by `formatPipelineError`.
- Changing the merge agent, model, or carry-set resolution logic — unchanged; only credential provisioning changes.

### Deferred to Separate Tasks

- `apps/workspace-agent/src/opencode-server.ts` also spawns the OpenCode child with `env: process.env` (same leak shape, different code path) — separate hardening, not this plan.
- A `ce:compound` doc capturing the `secrets: inherit` → explicit-passthrough migration and the OIDC→broker mint pattern — after this work merges.

## Context & Research

### Relevant Code and Patterns

- `src/harness/config/inputs.ts:203` (`parseActionInputs`) — the `auth-json` read at `inputs.ts:221-225`. `core.setSecret` precedent for AWS keys at `inputs.ts:205-213` (test: `inputs.test.ts:290-301`).
- `src/services/setup/auth-json.ts:30-55` (`populateAuthJson`) — writes `auth.json` `0600`, never cached; reads from the parsed `authConfig` object, not the env var (so the env scrub is safe before the write).
- `.slim/clonedeps/repos/anomalyco__opencode/packages/sdk/js/src/server.ts:35-40` — the SDK spawns `opencode serve` with `{ ...process.env, OPENCODE_CONFIG_CONTENT }`; there is no per-call env-exclusion path, so scrubbing `process.env` before spawn is the only seam for R2.
- `.github/workflows/harness-release.yaml:197-206` (`integrate` job) — calls `fro-bot.yaml` via `uses:` + `secrets: inherit`; consumes `prepare-integrate.outputs.rendered_prompt` and `vars.HARNESS_MODEL`.
- `.github/workflows/harness-release.yaml:834-840` (`publish` job) — the repo's existing "scope `id-token: write` to one job, deny it to the LLM-merge build" precedent to mirror.
- `.github/workflows/fro-bot.yaml:260-291` — the `with:` mapping the merge path uses (`auth-json`, `github-token`, `model`, `enable-omo`, `omo-providers`, `opencode-config`, `output-mode`, `prompt`, `response-mode`, `timeout`) and the secrets it relies on (`AUTH_JSON`, `FRO_BOT_PAT`, `OMO_PROVIDERS`, `OPENCODE_CONFIG`).
- `.github/actions/setup` — composite Node+Bun setup action the new workflow reuses.
- Test patterns: `src/harness/config/inputs.test.ts` (`vi.hoisted` mocks of `@actions/core`, `vi.stubEnv` / `vi.unstubAllEnvs`, `setSecret` assertions); `src/services/setup/auth-json.test.ts` (real `fs`, `it.skipIf(win32)` for `0600`, `// #given/#when/#then`). `scripts/` tests run via `bun run test:scripts`.
- `@actions/core` is a root monorepo dependency; the mint script resolves it the same way every existing `scripts/` script does — from the workspace-root `node_modules/` present in the CI checkout (restored by `./.github/actions/setup`). No new dependency is added.
- `action.yaml` declares `auth-json` `required: true` with no default, and `inputs.ts:221-225` errors on empty — so an absent/failed mint cannot silently run the action on a fallback credential.

### Institutional Learnings

- `docs/solutions/best-practices/workspace-executor-opencode-provisioning-best-practices-2026-06-01.md` — file-vs-env credential doctrine ("a file is not in `/proc/<pid>/environ`; never export it"). The env scrub is the Action-tier completion of this doctrine. Apply the same auth-json shape-validation (JSON object, ≥1 provider, each `{type:'api', key:non-empty}`) to whatever the broker returns.
- `docs/solutions/workflow-issues/build-pipeline-fallible-preflight-and-finally-cleanup-2026-06-22.md` — structure the broker call as preflight (POST → validate) → mutator (emit auth.json) → finally (scrub the OIDC token from env even on broker failure). The finally must not share a lifecycle with the step whose failure makes it useful.
- `docs/solutions/best-practices/cross-libc-build-and-release-safety-2026-06-14.md` — boolean `workflow_call` inputs must be compared to the literal `true`, never the string `'true'` (silent always-true bug). Applies to any boolean gate on the new workflow.
- `docs/solutions/best-practices/release-notes-narration-routing-and-fail-soft-guards-2026-06-07.md` — bound external dispatch with a real timeout (`timeout: 0` is the unbounded-hang trap); resolve models/endpoints from config, never hardcode.

### External References

- GitHub OIDC with reusable workflows: `job_workflow_ref` describes the **called** workflow (`fro-bot/agent/.github/workflows/harness-integrate.yaml@<ref>`); `workflow_ref` describes the caller. `core.getIDToken(audience)` works from a called reusable workflow's job when that job has `id-token: write`. (https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/using-openid-connect-with-reusable-workflows)
- A reusable workflow called without `secrets: inherit` and without an explicit `secrets:` mapping receives none of the caller's named secrets — **except** `GITHUB_TOKEN`, which is always auto-injected and can only be capability-restricted via `permissions:`, not withheld. (https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- OIDC token TTL ~15 min, single-job-scoped. Immutable subject-claim format rolls out 2026-07-15 (affects the `sub` claim for repos renamed/transferred/created after that date; the broker allowlist must accept both formats). (https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/)

## Key Technical Decisions

- Withhold `AUTH_JSON` by construction, not by scrubbing: `harness-integrate.yaml` drops `secrets: inherit` and passes only the secrets the merge needs (`FRO_BOT_PAT`, `OPENCODE_CONFIG`, `OMO_PROVIDERS`), so the durable key is never on the integrate runner. The env scrub (Unit 1) is defense-in-depth for the shared `fro-bot.yaml` paths that keep using `AUTH_JSON`.
- `harness-integrate.yaml` is self-contained — it duplicates the ~4 merge steps (resolve prompt, checkout, setup, mint, run action) rather than calling `fro-bot.yaml` after minting. Calling the shared workflow would drag `id-token: write` and the auth-json override onto every Fro Bot path, defeating the isolation goal. Trade: ~4 steps of workflow duplication.
- The GitHub OIDC token is itself the broker bearer (`Authorization: Bearer <oidc-token>` to `/v1/mint`) — there is no separate broker API key secret. `harness-integrate.yaml` needs `id-token: write` and the explicit non-`AUTH_JSON` secrets, nothing else.
- The mint + validate logic lives in a testable script (`scripts/`), not inline YAML: the repo has no workflow linter, and the broker-response validation (JSON shape, provider count, fail-closed, finally-scrub) is security-load-bearing and deserves unit tests. The workflow step runs the script.
- Pin the broker allowlist on `job_workflow_ref` → `fro-bot/agent/.github/workflows/harness-integrate.yaml@refs/heads/main`. `main` is `enforce_admins`-protected, so the ref pin holds; a SHA pin would be tighter but forces an allowlist update every commit.
- `GITHUB_TOKEN` is auto-injected into the called workflow regardless of the secrets mapping and cannot be withheld — reframe: the isolation target is the durable **model** key (`AUTH_JSON`), not `GITHUB_TOKEN`, which is separately capability-restricted via the job `permissions:` block.
- **Minted-credential delivery: masked step output, not a disk write.** The mint script emits the minted `auth.json` as a `core.setSecret`-masked step output, which feeds the action's `auth-json` input and reuses the existing `populateAuthJson` flow (single data path). The alternative — the script writing the XDG `auth.json` directly — is rejected: it bypasses `populateAuthJson`, adds an ordering dependency (mint-write must precede and not be overwritten by the action), and leaves a credential file on disk that a crashed `finally` or a later step could pick up. Accepted tradeoff: the minted key lives briefly in `INPUT_AUTH_JSON` (~ms, same step) before Unit 1's scrub deletes it — bounded and masked, versus a persistent disk artifact.
- **Composite-action extraction rejected as premature.** A third option — extracting the shared merge steps into `.github/actions/harness-merge/` that both workflows call — is not taken: after the Unit 4 rewire, `fro-bot.yaml` no longer runs the harness merge, so the composite action would have exactly one consumer. Introducing a new `action.yaml` + composite-action constraints (no secrets, host-toolchain only) for a single consumer is YAGNI. Drift surface is ~8 shared action inputs across the two workflow files, expected to change <1×/quarter; mitigated by `# SYNC:` comments (see System-Wide Impact).

## Open Questions

### Resolved During Planning

- Where to scrub: immediately after `core.getInput('auth-json')` parse+validate in `inputs.ts` (~line 225), before the disk write (`setup.ts:312`) and the child spawn — the parsed value lives in memory, so the env delete is safe.
- Self-contained vs call-fro-bot.yaml: self-contained (decided above).
- Broker auth: the OIDC token is the bearer; no separate key.

### Deferred to Implementation

- Exact mint-step mechanism (a `scripts/` node script invoked by a `run:` step vs `actions/github-script`) — pick the form that keeps the validation unit-testable under `bun run test:scripts`.
- The precise explicit `secrets:` set `harness-integrate.yaml` needs (confirm `OMO_PROVIDERS`/`OPENCODE_CONFIG` are actually required for the integrate invocation vs droppable).

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
harness-release.yaml (integrate job)
  └─ uses: ./.github/workflows/harness-integrate.yaml   (NO secrets: inherit)
       with:   { model, prompt, broker-audience }
       secrets: { FRO_BOT_PAT, OPENCODE_CONFIG, OMO_PROVIDERS }   (explicit — no AUTH_JSON)
         │
         └─ job: integrate   permissions: { id-token: write, contents: read }
              ├─ resolve prompt / checkout (FRO_BOT_PAT) / setup
              ├─ step: mint  →  scripts/…/mint-broker-credential
              │     preflight:  getIDToken('https://broker.fro.bot')
              │                 POST /v1/mint  (Bearer <oidc>, bounded timeout)
              │     validate:   JSON, provider count > 0, each key non-empty
              │     emit:       masked auth.json  (setSecret + step output)
              │     finally:    scrub OIDC token from env; fail closed on any error
              └─ step: run action  with auth-json = <minted>   (never secrets.AUTH_JSON)
```

## Implementation Units

- [ ] **Unit 1: Scrub `INPUT_AUTH_JSON` from the harness process env**

**Goal:** Remove the durable `auth-json` secret from `process.env` after it is read and mask it, so it is not env-dumpable and not inherited by the OpenCode child.

**Requirements:** R1, R2

**Dependencies:** None (ships first, independently — PR 1)

**Files:**
- Modify: `src/harness/config/inputs.ts`
- Test: `src/harness/config/inputs.test.ts`

**Approach:**
- Immediately after `core.getInput('auth-json')` is read, validated, and confirmed non-empty (~`inputs.ts:225`), call `core.setSecret(authJson)` and `delete process.env.INPUT_AUTH_JSON`.
- Order is load-bearing: read → validate → `setSecret` + delete → (later) file write → (later) child spawn. The parsed value already lives in the returned `ActionInputs`/`authConfig` memory, so deleting the env var does not break `populateAuthJson`.
- R2 is satisfied transitively: the SDK spawns the child with `{ ...process.env }`, so deleting the var before the spawn keeps it out of the child.

**Patterns to follow:**
- The AWS-key masking at `inputs.ts:205-213` and its test at `inputs.test.ts:290-301`.
- `vi.stubEnv` / `vi.unstubAllEnvs` env-mutation test pattern in `inputs.test.ts`.

**Test scenarios:**
- Happy path: given `INPUT_AUTH_JSON` is set, when `parseActionInputs()` runs, then `process.env.INPUT_AUTH_JSON` is `undefined` afterward and the parsed `authJson` is still returned intact.
- Happy path: `core.setSecret` is called once with the raw auth-json value.
- Edge case: given `auth-json` is empty/missing, when parse runs, then it errors as today and does not throw on the delete (no env var to remove).
- Integration: given the scrub ran, when a child env is constructed from `process.env` (simulating the SDK spread), then the auth-json value is absent from that env snapshot.

**Verification:** `parseActionInputs` returns the same `authJson` value as before; `process.env.INPUT_AUTH_JSON` is gone after the call; `setSecret` masks it; existing 89 input-parsing tests still pass.

- [ ] **Unit 2: Testable broker-mint script**

**Goal:** A self-contained, unit-tested module that mints the OIDC token, exchanges it at the broker, validates the response, emits the minted `auth.json` masked, and fails closed.

**Requirements:** R4, R6

**Dependencies:** None in code; consumed by Unit 3 (PR 2)

**Files:**
- Create: `scripts/harness/mint-broker-credential.ts` (final path/name at implementer's discretion under `scripts/`)
- Test: `scripts/harness/mint-broker-credential.test.ts`

**Approach:**
- Preflight: `core.getIDToken('https://broker.fro.bot')`; **immediately** `core.setSecret(oidcToken)` so the JWT is masked before any HTTP call, error log, or stack trace can surface it. Then a **single** `POST https://broker.fro.bot/v1/mint` with `Authorization: Bearer <oidc-token>` under a bounded timeout — **no retry loop** (the OIDC token is single-use per `jti`; a retry either fails on replay protection or risks minting a duplicate credential).
- Validate the response as an OpenCode `auth.json`, **all-or-nothing**: parse JSON, assert ≥1 provider, and every provider must pass `{type:'api', key:non-empty}` with an ID matching `^[A-Za-z0-9._-]+$` (mirror `parseAuthJsonInput`). A payload where any provider fails is rejected entirely — no partial acceptance.
- On success, `core.setSecret` the payload and emit it as a masked step output (per the delivery KTD — never a disk write). If any temp file is unavoidable, use `process.env.RUNNER_TEMP`, never a user-local path (`~/.config/opencode/`) that a setup action could cache across runs.
- Fail closed: any error (OIDC failure, non-2xx, timeout, invalid/partial shape) exits non-zero and emits nothing usable — never a durable-key fallback, never `continue-on-error`.
- Env hygiene precise: the OIDC token and minted credential live only in local (function-scope) variables — the script must **never** place either into `process.env`. The try/finally exists to guarantee a non-zero exit on any error branch and no partial output; it is not memory zeroing (out of the threat model — the child inherits `process.env`, not the V8 heap).
- Node strip-only TS constraints apply (`scripts/`): no `as any`, `@ts-ignore`, `enum`, `namespace`, parameter properties, or TS import aliases (per the `Test Scripts Load` job).

**Execution note:** Implement test-first — the validation and fail-closed paths are the security contract.

**Patterns to follow:**
- `parseAuthJsonInput` / `verifyAuthJson` shape validation in `src/services/setup/auth-json.ts`.
- The preflight→mutator→finally structure from the build-pipeline learning.
- HTTP interception via `vi.stubGlobal('fetch', …)` with a `BROKER_URL`-style env override the script reads (matches the `vi.stubEnv`/`vi.unstubAllEnvs` convention; no new test deps like `nock`/`msw`). `@actions/core` mocking should match whatever PR 1 settles for `inputs.test.ts` (this is the first `scripts/` test to mock `@actions/core`).

**Test scenarios:**
- Happy path: given a valid OIDC token and a broker returning a well-formed `auth.json`, when mint runs, then it emits the masked payload and exits 0, and `core.setSecret` was called on the OIDC token before the POST.
- Error path: broker returns non-2xx → exits non-zero, emits nothing, no fallback.
- Error path: broker returns 200 with an empty/zero-provider or malformed body → rejected, exits non-zero.
- Error path: broker returns a payload with one valid and one invalid provider → **entire** payload rejected (all-or-nothing), exits non-zero.
- Error path: broker call exceeds the bounded timeout → fails fast, does not hang, no retry.
- Error path: transient network error on the POST → exits non-zero immediately without retrying.
- Error path: `getIDToken` throws (no `id-token` permission) → fails closed.
- Integration: given any failure branch, when the finally runs, then no partial credential is emitted and the script exits non-zero.

**Verification:** `bun run test:scripts` passes; the `Test Scripts Load` job accepts the file; every failure branch emits no credential; the OIDC token is masked before the first outbound call.

- [ ] **Unit 3: `harness-integrate.yaml` reusable workflow**

**Goal:** A dedicated reusable workflow that runs the merge on a broker-minted credential, with `id-token: write` scoped to it and no `AUTH_JSON`.

**Requirements:** R3, R4, R5, R7

**Dependencies:** Unit 2 (mint script)

**Files:**
- Create: `.github/workflows/harness-integrate.yaml`

**Approach:**
- `on: workflow_call` with inputs `model`, `prompt`, `broker-audience` (default `https://broker.fro.bot`); explicit `secrets:` block declaring `FRO_BOT_PAT`, `OPENCODE_CONFIG`, `OMO_PROVIDERS` (required/optional as confirmed) — **no `AUTH_JSON`, no `secrets: inherit`**.
- **Exactly one job**, with `permissions: { id-token: write, contents: read }` and everything else `none` — mirror the `harness-release.yaml:834-840` isolation comment. The one-job constraint is a security invariant (a second job would share the broker's `job_workflow_ref` allowlist pin) — assert it in a top-of-file comment.
- Steps: checkout (`FRO_BOT_PAT`, `persist-credentials: false`) → `./.github/actions/setup` → run the Unit 2 mint script (in the `id-token: write` job) → run `./` action with `auth-json` = the minted masked step output, `github-token: ${{ secrets.FRO_BOT_PAT }}`, `model`, `prompt`, `response-mode: none`, `enable-omo`/`omo-providers`/`opencode-config` matching the current merge invocation, `timeout` and `output-mode` as today.
- The mint step and the job MUST NOT set `continue-on-error: true` (it would bypass R6 fail-closed). Before relying on fail-closed, confirm the action's `auth-json` input has no unsafe default that would let an empty/skipped mint run on a fallback — `action.yaml` declares `auth-json` `required: true` with no default, and `inputs.ts:221-225` errors on empty, so an absent minted credential fails the action.
- Any boolean input compared to the literal `true`, never `'true'`.
- Do not cache the minted `auth.json` (preserve the never-cached invariant); the mint script writes no user-local path a setup action could cache.
- Annotate the ~8 shared action inputs (`model`, `github-token`, `prompt`, `response-mode`, `enable-omo`, `omo-providers`, `opencode-config`, `output-mode`, `timeout`) with a `# SYNC: fro-bot.yaml merge invocation` comment so the duplicated block is kept in step with `fro-bot.yaml`.

**Patterns to follow:**
- `.github/workflows/fro-bot.yaml:202-291` step/`with:` shape (adapted, minus the PR-head/prehead comment path the integrate call doesn't use).
- `.github/workflows/harness-release.yaml:838-840` per-job `id-token` scoping.

**Test scenarios:** Test expectation: none — declarative workflow YAML with no unit-testable logic (the testable logic lives in Unit 2). Verified via the pre-allowlist smoke test below and the live dispatch in Unit 4.

**Verification:**
- The workflow parses (no YAML error); `id-token: write` is present only on this one job; `AUTH_JSON`/`secrets: inherit`/`continue-on-error` appear nowhere.
- **Pre-allowlist fail-closed smoke test** (before the infra allowlist is un-placeholdered): dispatch the integrate path against the live broker and assert the run (1) reaches the mint step, (2) `core.getIDToken` returns a token (proves `id-token: write` propagates through `workflow_call`), (3) the placeholder allowlist returns 403 → the mint script exits non-zero, (4) no credential is emitted and the job fails (does not silently continue). A 403 here is success — it proves the OIDC plumbing, broker reachability, and fail-closed path independent of the infra allowlist.

- [ ] **Unit 4: Rewire the `harness-release.yaml` integrate job**

**Goal:** Point the release integrate path at `harness-integrate.yaml` and stop inheriting the durable secret.

**Requirements:** R5

**Dependencies:** Unit 3

**Files:**
- Modify: `.github/workflows/harness-release.yaml`

**Approach:**
- Change the `integrate` job (`harness-release.yaml:197-206`) from `uses: ./.github/workflows/fro-bot.yaml` + `secrets: inherit` to `uses: ./.github/workflows/harness-integrate.yaml` with an explicit `secrets:` mapping (`FRO_BOT_PAT`, `OPENCODE_CONFIG`, `OMO_PROVIDERS`) and `with: { model: vars.HARNESS_MODEL, prompt: …rendered_prompt, broker-audience }`.
- Keep the `if: has_refs == 'true'` gate and the `needs: prepare-integrate` wiring; downstream `build`/`publish` consumption of `prepare-integrate` outputs is unchanged.
- Confirm `fro-bot.yaml` retains no dependency on the integrate path (it stays the shared issue/comment/schedule workflow, untouched).

**Patterns to follow:** The existing `integrate` job block; the same-tenant OIDC note (caller need not redeclare `id-token: write`).

**Test scenarios:** Test expectation: none — workflow wiring. Verified by a real harness dispatch after the infra allowlist is set (see R8 / Success Criteria).

**Verification:** `secrets: inherit` no longer appears on the integrate path; a real `harness-release` dispatch with a non-empty carry set completes the merge on the minted credential (post-allowlist).

## System-Wide Impact

- **Interaction graph:** `harness-release.yaml` `integrate` → `harness-integrate.yaml` → the `./` action → OpenCode SDK spawn. `fro-bot.yaml` (issues/comments/schedule/dispatch) is untouched and keeps `secrets: inherit`/`AUTH_JSON`.
- **Error propagation:** Mint failure fails the integrate job closed (no durable-key fallback); the release surfaces the failure rather than merging on a bad credential.
- **State lifecycle risks:** The minted `auth.json` must never be cached (preserve the `populateAuthJson` never-cached invariant); the OIDC token and minted credential never enter `process.env` (local variables only).
- **Security invariant — one job:** `harness-integrate.yaml` must have exactly one job. A second job would share the broker's `job_workflow_ref` allowlist pin and could mint independently; any addition to this file is security-critical and must be reviewed as such (documented in the workflow's top comment).
- **Duplication sync:** the ~8 shared action inputs across `harness-integrate.yaml` and `fro-bot.yaml`'s merge invocation must be kept in step (`# SYNC:` comments on both). A security-relevant change to the merge invocation must land in both.
- **API surface parity:** `apps/workspace-agent/src/opencode-server.ts` has the same `env: process.env` spawn shape — deferred, noted for follow-up, not changed here.
- **Unchanged invariants:** `fro-bot.yaml`'s input contract and secret usage; the merge agent, model resolution (`vars.HARNESS_MODEL`), prompt rendering, and carry-set logic; the Response Protocol (merge uses `response-mode: none`). The disk copy of `auth.json` remains on the shared `fro-bot.yaml` paths — only the broker path removes the durable key from the runner entirely; the Unit 1 scrub closes only the env/proc-environ vector there.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| **Blocking:** broker allowlist is fail-closed with placeholders — mint fails until `marcusrbrown/infra` is un-placeholdered (R8) | Operator sets `repository_id=1126485011`, `repository_owner_id=80104189`, `job_workflow_ref=fro-bot/agent/.github/workflows/harness-integrate.yaml@refs/heads/main`. Ship Unit 1 (no infra dep) first; live-verify Units 2–4 after the allowlist is set. |
| `GITHUB_TOKEN` is auto-injected into the called workflow regardless of the secrets mapping | Isolation target is `AUTH_JSON`, not `GITHUB_TOKEN`; capability-restrict the token via the job `permissions:` block (`contents: read`, everything else `none`). |
| Immutable OIDC `sub`-claim format rolls out 2026-07-15 | The allowlist pins `job_workflow_ref` (unaffected by the `sub` change); note for infra that the broker should accept both `sub` formats if it ever also checks `sub`. |
| `job_workflow_ref` reflects the called workflow's ref | Pin is `@refs/heads/main`; `main` is `enforce_admins`-protected so unauthorized edits to the minting logic are blocked. Any change to `harness-integrate.yaml` is security-relevant and reviewed as such. |
| Unbounded broker call hangs the release | Bounded timeout + single attempt (no retry) in the mint script (learning: `timeout: 0` is the hang trap). |
| No workflow-YAML linter in CI | Review the two workflow files against the isolation precedent; the testable logic is isolated into Unit 2 where it is covered; the pre-allowlist smoke test exercises the live plumbing. |
| A compromised merge agent exfiltrates the minted credential or source via the auto-injected `GITHUB_TOKEN` (even at `contents: read`) | Deferred to `infra#725` (egress containment). Interim: the minted credential's cliproxy scope + short TTL bound the blast radius. This plan shrinks the credential's *value*, not the runner's *reach* — stated explicitly, not implied. |
| A transitive dep or upstream setup action introduces caching that persists the credential file across runs | The mint script emits a masked step output and writes no user-local path; if a temp file is ever needed it uses `RUNNER_TEMP`, never `~/.config/opencode/`. |
| Running `harness-release.yaml` from a non-main ref (tag/branch via `workflow_dispatch`) makes `job_workflow_ref` mismatch the `@refs/heads/main` pin | Correct fail-closed behavior (mint 403s), but surprising — document that the integrate path is only expected from `main`. |

## Documentation / Operational Notes

### Operator: Broker Allowlist Values (copy-ready for the PR body)

Before the integrate path can mint live, un-placeholder the `broker.fro.bot` allowlist on `marcusrbrown/infra` (see `infra#725` context) with exactly:

- `repository_id`: `1126485011`
- `repository_owner_id`: `80104189` (`fro-bot` org)
- `job_workflow_ref`: `fro-bot/agent/.github/workflows/harness-integrate.yaml@refs/heads/main`

Until these are set the broker fails closed (mint 403s). The env-hygiene deliverable (Unit 1 / PR 1) does not depend on this; the pre-allowlist smoke test (Unit 3 verification) is expected to see a 403 and fail closed.

- After merge, file a `ce:compound` doc for the `secrets: inherit` → explicit-passthrough migration and the OIDC→broker mint pattern (both absent from `docs/solutions/`).

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-01-harness-merge-credential-broker-requirements.md](../brainstorms/2026-07-01-harness-merge-credential-broker-requirements.md)
- Related code: `src/harness/config/inputs.ts`, `src/services/setup/auth-json.ts`, `.github/workflows/harness-release.yaml`, `.github/workflows/fro-bot.yaml`
- Related issue: #1060
- Cross-repo: `marcusrbrown/infra#725` (egress containment, deferred)
- External: GitHub OIDC with reusable workflows; immutable subject claims (2026-07-15)
