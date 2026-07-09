---
title: "fix: scrub raw secrets from the OpenCode agent environment"
type: fix
status: active
date: 2026-07-08
---

# fix: scrub raw secrets from the OpenCode agent environment

## Overview

The published fro-bot Action leaks the raw GitHub token into posted PR reviews/comments. The agent posts via its own bash tool (`gh pr review N --body "…"`), and the raw `GH_TOKEN` lives in that shell's environment. When the model quotes PR content containing the literal string `${GH_TOKEN}` inside a double-quoted `--body`, bash parameter-expands it into the live token before `gh` runs. This plan removes the raw secrets from the OpenCode child's environment (an allowlist filter applied at the two spawn seams) and re-authenticates `gh` off-environment so delegated `gh` still works. With no `GH_TOKEN` in the child shell, `${GH_TOKEN}` expands to empty and the leak is closed for every consumer of the public Action.

Tracking: #1147.

## Problem Frame

The leak vector is confirmed from a downstream consumer's run artifact (see #1147): the model emitted the benign text `${GH_TOKEN}`; the secret materialized only at shell-expansion time, downstream of any model-output filter, and was posted via the model's own `gh` (bypassing the Action's Octokit writers). The raw token reaches the model because `configureGhAuth` sets `process.env.GH_TOKEN` (`src/services/setup/gh-auth.ts:7-31`) and setup exports it (`src/services/setup/setup.ts:302-314`), and the OpenCode SDK spawns the server child with `env: { ...process.env, … }` (`.slim/clonedeps/repos/anomalyco__opencode/packages/sdk/js/src/server.ts:22-40`) — so the model's bash inherits the raw token. The SDK exposes no per-child env override (`ServerOptions` is `hostname/port/signal/timeout/config` only), so the harness must present a filtered environment to the child at the spawn boundary.

## Requirements Trace

- R1. The OpenCode child process (and therefore the model's bash tool) must not inherit `GH_TOKEN`, `GITHUB_TOKEN`, provider API keys, or other secret-shaped env vars. (Root fix for #1147.)
- R2. The filter is an allowlist (deny-by-default): a newly-added secret env var is excluded unless explicitly allowed. `OPENCODE_CONFIG_CONTENT` and the operational vars OpenCode needs must pass through.
- R3. Delegated `gh` operations from the model's bash (branches/commits/PRs, review posting) must still work with the raw token absent from the environment — via off-environment `gh` auth (persisted config in a temp `GH_CONFIG_DIR`).
- R4. The harness's own Node process retains `process.env` intact (Octokit posting, delegated writers, RFC-018 flow are unaffected).
- R5. Regression tests prove a parent-env token never reaches the actual spawned child env, and that a filter failure fails closed (no spawn).

## Scope Boundaries

- Filtering applies to the OpenCode child env only; the harness Node `process.env` is deliberately left intact (R4).
- Provider inference is unaffected: provider auth is file-based via `auth.json` mode 0600 (`src/services/setup/auth-json.ts:31-55`), not env — so no provider key needs to pass through the child env.

### Deferred to Separate Tasks

- Credential broker (agent holds no raw GitHub credential; a harness-mediated wrapper performs approved operations) — the boundary against *deliberate* exfiltration (`gh auth token`). Tracked under #1147 hardening.
- Harness-mediated posting (model emits review body; harness scans + posts via Octokit) + a post-expansion secret-scan gate at the single posting choke point. Tracked under #1147 hardening.
- Prompt-ingress redaction for secrets already present in a PR diff. Tracked under #1147 hardening.
- `--body-file` / quoted-heredoc prompt contract (defense-in-depth against the model interpolating *other* kept env values into a posted body). Not needed to close the #1147 vector — Units 1–3 make `${GH_TOKEN}` expand to empty regardless — so it lands with the posting hardening, not the urgent hotfix. Tracked under #1147 hardening.

## Context & Research

### Relevant Code and Patterns

- `src/services/setup/gh-auth.ts:7-31` — `configureGhAuth(...)` today only sets `process.env.GH_TOKEN = token`; no `gh auth login`, no config write, no `GH_CONFIG_DIR`. This is the seam to change for off-env auth (R3).
- `src/services/setup/setup.ts:302-314` — setup order: `configureGhAuth` → `exportVariable('GH_TOKEN', …)` → git identity → `populateAuthJson`. Establishes that `GH_TOKEN` in the harness env is used by setup itself; the scrub must target the child, not this process.
- `packages/runtime/src/agent/server.ts:16-35` — `bootstrapOpenCodeServer` → `createOpencode({signal})` (spawn seam 1).
- `src/features/agent/execution.ts:46-57` — `executeOpenCode` calls `createOpencode({signal})` when `serverHandle == null` (spawn seam 2); reuses a passed handle otherwise.
- `.slim/clonedeps/repos/anomalyco__opencode/packages/sdk/js/src/server.ts:22-40` — SDK spawns with `env: { ...process.env, OPENCODE_CONFIG_CONTENT }`; no env override in `ServerOptions`.
- `src/harness/config/inputs.ts:203-240` — the #1119 scrub pattern (`core.setSecret` + `delete process.env['INPUT_GITHUB-TOKEN']`); mirror its shape and its test style.

### Institutional Learnings

- `docs/solutions/workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md` — already states the #1119 `INPUT_GITHUB-TOKEN` scrub was "hygiene, not isolation" because `GH_TOKEN` remains; this plan closes that residual. Cross-reference on completion.
- `docs/solutions/logic-errors/actions-core-input-env-hyphen-mapping-2026-07-01.md` — `@actions/core` maps input names to `INPUT_${name.replace(/ /g,'_').toUpperCase()}` (spaces→underscore, hyphens survive), so `INPUT_GITHUB-TOKEN` / `INPUT_AUTH-JSON` are the correct hyphenated names to exclude.
- `docs/solutions/best-practices/same-job-phase-split-not-a-security-boundary-2026-07-04.md` — reinforces that env inheritance (not step order) is the blast radius; child-env filtering is the right lever.
- `RFCs/RFC-018-Agent-Invokable-Delegated-Work.md:53-56,165-173` — the recorded decision that routed `GH_TOKEN` to the agent env for delegated work; this plan supersedes the "raw token in child env" part of that flow (delegated work is preserved via off-env `gh` auth). Update the RFC's env-flow note on completion.

## Key Technical Decisions

- **Filter `process.env` immediately before the spawn (fail-closed), because the SDK exposes no env override.** Verified: `createOpencode` forwards only `hostname/port/signal/timeout/config`, and `createOpencodeServer` hardcodes `env: { ...process.env, OPENCODE_CONFIG_CONTENT }` (`.slim/clonedeps/repos/anomalyco__opencode/packages/sdk/js/src/server.ts:22-40`) — there is no per-child env argument. So `process.env` is the only harness-side lever. Since the harness Node process does not read `GH_TOKEN`/`GITHUB_TOKEN` after setup (verified: only setup/gh-auth touch them; delegated writers use Octokit with an explicit token), the harness deletes the disallowed keys from `process.env` before the first `createOpencode` and does not restore them (simplest; R4 holds because nothing downstream needs them). If a post-spawn harness need surfaces, fall back to snapshot→filter→spawn→restore in a `finally`. **Fail-closed:** if the filter cannot be applied, the server must NOT spawn — never fall through to an unfiltered `{...process.env}` child.
- **Scope the scrub to the spawn (snapshot → scrub → spawn → restore) — NOT a global `process.env` reduction.** `createOpencode` is third-party (`@opencode-ai/sdk`, vendored read-only) and spawns the child synchronously with `{...process.env}` during the call, so the child captures whatever `process.env` holds at spawn time. A generic helper `withScrubbedEnv(fn, logger)` snapshots the keys it removes, deletes the disallowed keys from `process.env`, `await`s `fn()` (the `createOpencode` call — the child captures the filtered env), and **restores exactly the removed keys in `finally`**. Both seams wrap their `createOpencode` call in it. **Why not a global upstream scrub:** the deny-by-default allowlist is designed for the *sandboxed child*; applied to the *harness's own* `process.env` it strips operational vars the harness legitimately needs — concretely, the S3 cache backend's client falls back to the AWS SDK ambient credential chain (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` read from `process.env` at client construction in `s3-adapter.ts:104,111`; `storeConfig` carries no explicit `credentials`), and `restoreCache`/`saveCache` run around the spawn — a global scrub deleting `AWS_*` breaks cache restore and save. Scoping the scrub to the spawn window (with restore) keeps the harness env intact for S3/proxy/etc. while the model child still gets the filtered env. `createOpencode` stays the visible call at each seam (the helper wraps it, does not hide it); no eslint enforcement rule.
- **Enumerate-only keep-list for the sensitive `GITHUB_` namespace — no broad `GITHUB_` prefix.** Keep exactly the `GITHUB_*` vars the child needs (`GITHUB_REPOSITORY`, `GITHUB_WORKSPACE`, `GITHUB_REF`, `GITHUB_REF_NAME`, `GITHUB_SHA`, `GITHUB_EVENT_NAME`, `GITHUB_RUN_ID`…) as explicit keys; do NOT allow `GITHUB_*` by prefix — a `GITHUB_TOKEN`/`GITHUB_APP_PRIVATE_KEY`/`GITHUB_OAUTH_TOKEN`-shaped var would slip through. Other kept namespaces are non-secret operational vars: `PATH`, `HOME`, `SHELL`, `TMPDIR`/`TMP`, `CI`, `RUNNER_*`, `LANG`/`LC_*`, `OPENCODE_*` (incl. `OPENCODE_CONFIG_CONTENT`), `XDG_*` (auth.json location), `GH_CONFIG_DIR`, `NODE_*`. A deny-set (`*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`, `*_PRIVATE_KEY`, `AWS_*`, `INPUT_*`) is defense-in-depth on top of the allowlist, not the primary guard. Exact final keys validated against a real runner `env` snapshot (deferred detail).
- **Off-environment `gh` auth via temp `GH_CONFIG_DIR` is a functional necessity with a bounded, honestly-stated disk residual.** Removing `GH_TOKEN` from the child env would break the model's own `gh` unless gh is authed another way, so `configureGhAuth` persists auth to a temp `GH_CONFIG_DIR` (dir `0700`, `hosts.yml` `0600`) and exports `GH_CONFIG_DIR` (non-secret). **Residual (accepted, deferred to the broker):** the token now lives in a file the model's same-user bash can read (`cat "$GH_CONFIG_DIR/hosts.yml"`, or `gh auth token`). This fully closes the #1147 *accidental shell-expansion* vector (no `${GH_TOKEN}` in env to expand) but does NOT close *deliberate* exfiltration — that is the broker's job. Tight perms bound cross-user/cross-process reach only, not same-user model-bash reach; state this rather than implying the token is unreachable.


## Open Questions

### Resolved During Planning

- Does scrubbing secrets from the child break provider inference? No — provider auth is file-based (`auth.json`), not env (`src/services/setup/auth-json.ts:31-55`).
- Does scrubbing break harness delegated work? No — `src/features/delegated/*` uses Octokit in the harness Node process (keeps `process.env`); only the model's bash loses the raw token, and its `gh` usage is preserved by off-env auth.
- One filter seam or two? Two — both `createOpencode` callsites (`server.ts`, `execution.ts`) wrap their call in `withScrubbedEnv`. A global upstream scrub was rejected: it strips `AWS_*` the harness's own S3 cache backend reads from ambient env after the scrub.
- Global env reduction vs scoped-with-restore? Scoped: the deny-by-default allowlist is for the sandboxed child, not the harness process. Mutating the harness's global `process.env` breaks S3 cache save/restore (ambient `AWS_*`). Snapshot/scrub/spawn/restore keeps the harness env intact.

### Deferred to Implementation

- Exact final allowlist keys — validate against a real Action runner `env` snapshot so no operational var OpenCode needs is dropped (start from the keep-list above; add only proven-necessary vars).
- Exact type-signature threading of `withScrubbedEnv` around each seam's `createOpencode` call (the return-type generic + the existing `Awaited<ReturnType<typeof createOpencode>>` usages in `execution.ts`).
- Exact `GH_CONFIG_DIR` location + cleanup lifecycle (temp dir under the runner workspace; removed in a finally).

## Implementation Units

- [ ] **Unit 1: Env allowlist filter helper**

**Goal:** A pure, tested helper that takes an environment record and returns a filtered copy containing only allowlisted keys (deny-by-default), dropping all secret-shaped vars.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Create: `packages/runtime/src/agent/filter-env.ts`
- Create: `packages/runtime/src/agent/filter-env.test.ts`

**Approach:**
- Export a function taking a `NodeJS.ProcessEnv`-shaped record + returning a filtered record. Allowlist the sensitive `GITHUB_` namespace by **explicit exact keys only** (no `GITHUB_` prefix — a prefix would re-admit `GITHUB_TOKEN`/`GITHUB_APP_PRIVATE_KEY`-shaped vars). Allow non-secret operational namespaces by a small set of prefixes (`OPENCODE_`, `RUNNER_`, `XDG_`, `LC_`) plus exact keys (`PATH`, `HOME`, `SHELL`, `TMPDIR`, `TMP`, `CI`, `LANG`, `GH_CONFIG_DIR`, `NODE_*`). Keep allow-keys/allow-prefixes as named `readonly` constants for auditability.
- Deny-by-default: any key not matched by the allowlist is dropped. Add a deny-set (`*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`, `*_PRIVATE_KEY`, `AWS_*`, `INPUT_*`) as **defense-in-depth** that is applied even to otherwise-allowed keys — but the allowlist, not the deny-set, is the primary guard (so a new secret var fails safe by not being on the allowlist).

**Patterns to follow:** `readonly` constant sets; the redaction-list style in `packages/runtime/src/shared/logger.ts:23-36`.

**Test scenarios:**
- Happy path: an env with `PATH`, `OPENCODE_CONFIG_CONTENT`, `GITHUB_REPOSITORY` passes those through unchanged.
- Edge case: `GITHUB_TOKEN`, `GH_TOKEN` are dropped (not on the exact-key allowlist; the `GITHUB_` namespace is NOT prefix-allowed).
- Edge case: a hypothetical `GITHUB_APP_PRIVATE_KEY` / `GITHUB_OAUTH_TOKEN` is dropped (proves no broad `GITHUB_` prefix).
- Edge case: arbitrary `FOO_TOKEN`, `FOO_API_KEY`, `FOO_SECRET`, `AWS_SECRET_ACCESS_KEY`, `INPUT_AUTH-JSON` are dropped (deny-by-default + deny-set).
- Edge case: empty env → empty result; undefined values handled without throwing.
- Edge case: a newly-invented `SOME_NEW_CREDENTIAL` (matches no allow) is dropped — the fail-safe property.

**Verification:** Filter returns only allowlisted keys; every token/secret-shaped key (incl. any `GITHUB_*` secret) is absent; `OPENCODE_CONFIG_CONTENT` is retained.

- [ ] **Unit 2: Scope the env scrub to the OpenCode spawn (snapshot → scrub → spawn → restore)**

**Goal:** At each `createOpencode` call, `process.env` is temporarily reduced to the allowlisted set so the synchronously-spawned child captures a clean env, then `process.env` is restored so the harness keeps its full env (S3 `AWS_*`, proxy vars, etc.). The model's bash never inherits `GH_TOKEN`/`GITHUB_TOKEN`; the harness's own later phases (cache save/restore) are unaffected.

**Requirements:** R1, R2, R4

**Dependencies:** Unit 1

**Files:**
- Create: `packages/runtime/src/agent/with-scrubbed-env.ts` (`withScrubbedEnv(fn, logger)` — snapshot removed keys, delete disallowed keys, run `fn`, restore in `finally`)
- Create: `packages/runtime/src/agent/with-scrubbed-env.test.ts`
- Modify: `packages/runtime/src/agent/index.ts` (export `withScrubbedEnv`)
- Modify: `packages/runtime/src/agent/server.ts` (wrap the `createOpencode` call in `bootstrapOpenCodeServer`)
- Modify: `src/features/agent/execution.ts` (wrap the `createOpencode` call in `executeOpenCode`)
- Test: adjust `packages/runtime/src/agent/server.test.ts` and `src/features/agent/execution.test.ts` as needed for the wrapped call

**Approach:**
- `withScrubbedEnv<T>(fn: () => Promise<T>, logger): Promise<T>`: compute `filterAgentEnv(process.env)`; for each key in `process.env` NOT in the filtered set, record `{key, value}` in a snapshot and `delete process.env[key]`; then `try { return await fn() } finally { restore every snapshotted key onto process.env }`. `createOpencode` spawns the child synchronously with `{...process.env}` inside `fn`, so the child captures the filtered env; the `finally` restore returns `AWS_*`/proxy/etc. to the harness. Log a redaction-safe `{removedCount}` only (never key names/values).
- **Fail-closed:** if the scrub (filter/delete) throws BEFORE `fn` is invoked, do not call `fn` (no spawn) — rethrow. The `finally` still restores anything already removed. A throw from `fn` itself propagates normally after restore.
- Both seams: replace `await createOpencode({signal})` with `await withScrubbedEnv(() => createOpencode({signal}), logger)`. `createOpencode` stays imported/visible at each seam; the helper only brackets the call. Do NOT introduce an eslint rule or a hidden wrapper indirection.
- **Why scoped, not global:** a global `process.env` reduction (delete-and-don't-restore) breaks the harness's S3 cache backend — the S3 client falls back to the AWS ambient credential chain (`AWS_*` from `process.env` at construction, `s3-adapter.ts:104,111`) and `restoreCache`/`saveCache` run around the spawn. Restoring after the spawn keeps those intact.

**Patterns to follow:** the `process.env` snapshot/restore discipline in `src/services/setup/gh-auth.test.ts:27-39`; the existing `createOpencode({signal})` call shape at both seams.

**Test scenarios:**
- Happy path (primary #1147 canary): set `GH_TOKEN`/`GITHUB_TOKEN` in `process.env`; pass `withScrubbedEnv` an `fn` that CAPTURES `process.env.GH_TOKEN`/`GITHUB_TOKEN` at call time (simulating the SDK's synchronous `{...process.env}` spread); assert both captured values are `undefined`. Must be able to FAIL if the scrub is removed.
- Restore: after `withScrubbedEnv` resolves, `process.env.GH_TOKEN`/`GITHUB_TOKEN` are back to their original values (harness env intact) — and a kept operational var like `AWS_ACCESS_KEY_ID` set before the call is present BOTH inside `fn` and after.
- Happy path: `OPENCODE_CONFIG_CONTENT` is present inside `fn` (child boots).
- Restore-on-throw: if `fn` throws, `process.env` is still fully restored (assert removed keys are back).
- Fail-closed: if `filterAgentEnv` throws (mock it), `fn` is never invoked and any partial removal is restored.
- Restore `process.env` in `afterEach` (snapshot in `beforeEach`) so tests don't leak.
**Verification:** Inside `withScrubbedEnv`'s `fn`, `process.env` provably lacks `GH_TOKEN`/`GITHUB_TOKEN` (test fails otherwise) while `OPENCODE_CONFIG_CONTENT` is retained; after it resolves (or throws), `process.env` is fully restored including `AWS_*`; both `server.ts` and `execution.ts` seams wrap their `createOpencode` call.

- [ ] **Unit 3: Off-environment `gh` authentication**

**Goal:** `gh` is authenticated for the model's bash via a persisted config in a temp `GH_CONFIG_DIR`, not via `GH_TOKEN` in the child env — so delegated `gh` works with the raw token scrubbed.

**Requirements:** R3

**Dependencies:** Unit 1 (so `GH_CONFIG_DIR` is on the allowlist), Unit 2 (child no longer has `GH_TOKEN`)

**Files:**
- Modify: `src/services/setup/gh-auth.ts`
- Modify: `src/services/setup/setup.ts` (sequencing + `GH_CONFIG_DIR` export; reassess the `exportVariable('GH_TOKEN')` for the child's benefit)
- Test: `src/services/setup/gh-auth.test.ts`

**Approach:**
- In `configureGhAuth`, create a temp `GH_CONFIG_DIR` (mode **0700**) and persist auth there (`gh auth login --with-token` via the `ExecAdapter`, token on **stdin** — never argv) so gh reads it from config, not env; ensure the written `hosts.yml` is mode **0600**. Export `GH_CONFIG_DIR` (allowlisted, non-secret) so both the harness and the child `gh` resolve the same auth.
- **Honest residual (must be stated in code comment + docs):** the token now lives in `hosts.yml`, which the model's **same-user bash can read** (`cat "$GH_CONFIG_DIR/hosts.yml"`) or surface via `gh auth token`. Tight perms bound only cross-user/cross-process access, NOT same-user model reach. This closes the #1147 accidental `${GH_TOKEN}` shell-expansion vector (no env var to expand) but not deliberate exfiltration — that is explicitly the deferred broker's job. Do not imply the token is unreachable by the agent.
- The harness process may still hold `GH_TOKEN` for its own setup/Octokit needs; the point is the *child* env (Unit 2) no longer carries it while `gh` remains usable via config. Confirm no code path depends on the child seeing `GH_TOKEN`.
- Cleanup: remove the temp config dir in a finally at run teardown (or document why the ephemeral runner makes it moot).

**Execution note:** token must reach `gh auth login` via stdin, not a command argument (avoid argv/process-table exposure).

**Patterns to follow:** `ExecAdapter` usage + `process.env` snapshot/restore in `src/services/setup/gh-auth.test.ts`; secret-on-stdin handling elsewhere in setup.

**Test scenarios:**
- Happy path: `configureGhAuth` invokes `gh auth login --with-token` with the token on stdin and sets `GH_CONFIG_DIR`; does not rely on `GH_TOKEN` for gh usability.
- Integration: after auth, a `gh` invocation resolves auth from the config dir with `GH_TOKEN` absent from the (child) env (simulated).
- Error path: token missing/blank → fails closed (no partial/unauthenticated silent success), matching existing gh-auth failure behavior.
- Edge case: the token never appears in any argv passed to the ExecAdapter (assert stdin, not args).

**Verification:** `gh` is authenticated via config dir; delegated `gh` works with `GH_TOKEN` absent from the child env; token never on argv.

## System-Wide Impact

- **Interaction graph:** Both `createOpencode` seams (`server.ts`, `execution.ts`) wrap their call in `withScrubbedEnv`. A new seam must do the same — but the blast radius of forgetting is contained (only that spawn would inherit secrets), and both current seams are covered.
- **Error propagation:** `withScrubbedEnv` is fail-closed on the scrub step (no `fn`/spawn if the filter throws) and always restores `process.env` in `finally`, so neither a scrub error nor an `fn` throw leaves the harness env mutated.
- **State lifecycle risks:** The scoped scrub restores `process.env` after each spawn, so the harness's S3 cache save/restore (which reads ambient `AWS_*`) and proxy vars stay intact. Temp `GH_CONFIG_DIR` (Unit 3) must be created before the child spawns and cleaned up at teardown; create with tight perms under the runner workspace.
- **API surface parity:** A *future* OpenCode spawn seam must also wrap its call in `withScrubbedEnv`; the helper is the shared, tested convention. The harness env is unaffected either way (restore in `finally`).
- **Unchanged invariants:** The harness `process.env` is fully restored after each spawn — S3 (`AWS_*`), proxy, Octokit posting, `src/features/delegated/*`, and RFC-018 harness-side flow all keep working. Provider inference (file-based `auth.json`) is unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Allowlist too tight → OpenCode/omo missing an operational env var it needs → boot/inference failure | Finalize the keep-list against a real runner `env` snapshot (deferred detail in Unit 1/2); provider auth is file-based so keys aren't at risk; add an integration test that the server boots with the filtered env. |
| Enumerate-only `GITHUB_` list omits a needed non-secret `GITHUB_*` var → runtime breakage | Validate the exact `GITHUB_*` keep-keys against a real runner snapshot; the failure mode is a loud missing-var, not a silent leak. |
| A future spawn seam forgets to wrap its `createOpencode` call in `withScrubbedEnv` | Both current seams are wrapped and tested; the helper is the shared convention. Contained blast radius — only an unwrapped seam would leak, not the whole harness. |
| Global env mutation would break the harness's S3 cache (ambient `AWS_*`) | Scoped scrub restores `process.env` in `finally` after each spawn, so `restoreCache`/`saveCache` keep their ambient AWS creds and proxy vars. |
| Scrub throws → spawn proceeds with an unscrubbed env | Fail-closed: `withScrubbedEnv` does not invoke `fn` (no spawn) if the scrub step throws, and restores any partial removal. |
| Off-env gh auth leaves the token in a model-readable `hosts.yml` (or via `gh auth token`) — deliberate exfil | Accepted, explicitly-stated residual (dir 0700 / file 0600 bounds only cross-user reach); the deferred broker is the boundary for deliberate same-user exfiltration. |
| Canary test passes while the real child still leaks | Unit 2's primary canary asserts `process.env` lacks `GH_TOKEN`/`GITHUB_TOKEN` INSIDE `withScrubbedEnv`'s `fn` — the moment the SDK spreads `{...process.env}` into the child — so it fails if the scrub is removed; not a helper-only assertion. |

## Documentation / Operational Notes

- On completion: cross-reference `docs/solutions/workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md` (this closes its flagged residual) and update the `RFCs/RFC-018` env-flow note (agent no longer receives the raw token in its child env; delegated `gh` uses off-env config).
- Consider a `ce:compound` learning after merge: "secret-in-env + model bash = shell-expansion leak; scope the env scrub to the child spawn (snapshot/scrub/restore), NOT a global process.env reduction — the harness's own S3 cache reads ambient AWS_* and a global scrub breaks it."

## Sources & References

- Tracking issue: #1147
- Leak vector + evidence: memory 6444; #1147 body.
- Related: #1119 (INPUT_GITHUB-TOKEN scrub — hygiene predecessor), RFC-018 (delegated-work env flow), `docs/solutions/workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md`.
