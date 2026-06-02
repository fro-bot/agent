---
title: "feat: Provision OpenCode model/auth into the workspace executor for the mention loop"
type: feat
status: active
date: 2026-06-01
reviewed: 2026-06-01
---

# feat: Workspace OpenCode model/auth provisioning

## Overview

The workspace executor image (PR #725) runs `opencode serve`, but the OpenCode server has no LLM provider credentials and no model selection, so the `@fro-bot` Discord mention loop cannot complete a model-backed turn. This provisions provider credentials and a model into the workspace container at deploy time — never baked into the image — closing the last gap to a working mention loop.

## Problem Frame

`/fro-bot add-project` (clone) now works end-to-end, but the mention loop attaches to the workspace OpenCode server and sends a prompt with no credentials available. OpenCode reads stored provider credentials from `auth.json` at its data path (or the `OPENCODE_AUTH_CONTENT` env var); neither is currently provided. Model selection is also unset. This is todo 079 (`c-workspace-executor-followup`, P1).

## Requirements Trace

- R1. The workspace OpenCode server authenticates to an LLM provider using credentials supplied at deploy time, never baked into the image.
- R2. The model AND provider configuration (e.g. a cliproxyapi `baseURL`) are selectable at deploy time, mirroring the action's `model` + `opencode-config` inputs — no provider/model baked into the image.
- R3. Credentials are handled as a secret: file-based, `0600`, never logged, never in image layers, never in the clone subprocess env, with the narrowest practical runtime exposure.
- R4. The mention loop completes a real model-backed turn end-to-end in a deployed stack.
- R5. The clone path (`/fro-bot add-project`) remains unaffected — it needs no credentials.

## Canonical Auth-Gating Rule

One rule, referenced by every unit and the docs:

- **Clone-only deployments may boot without credentials.** Absent/empty auth secret → the entrypoint warns and continues; the clone path works.
- **Mention-loop turns require credentials.** When auth is absent, the OpenCode turn fails with OpenCode's own auth error (clear, not a silent hang). The entrypoint does not refuse to boot, because the same image serves clone-only deployments.

## Naming Table (canonical strings — use these exact names everywhere)

| Role | Value |
|------|-------|
| Docker/host secret file | `deploy/secrets/workspace-opencode-auth` |
| Container mount path | `/run/secrets/workspace_opencode_auth` |
| Entrypoint env pointing at the mount | `WORKSPACE_OPENCODE_AUTH_FILE` |
| OpenCode on-disk credential file (entrypoint writes here) | `$XDG_DATA_HOME/opencode/auth.json` (default `/root/.local/share/opencode/auth.json`) |

## Scope Boundaries

- No change to the gateway's attach/execution code — provisioning is workspace-container-only (the gateway already supplies URL + bearer token).
- No baking of any provider key into the image.
- **API-key credentials only for v1** (`{type:'api', key}`). OAuth/well-known entries are out of scope — a static deploy-time blob cannot refresh an expiring OAuth token mid-session, and the container has no writeback path.
- No multi-provider routing logic — a single provisioned `auth.json` blob is sufficient.
- No per-Discord-user credential mapping — all mention-loop runs use the one deployment-level credential (single-tenant v1).

### Deferred to Separate Tasks

- **Per-request model override from the gateway** (`body.model`) — gateway-side enhancement; the deploy-time model + provider config is sufficient for v1.
- **OAuth/refreshable credentials** — needs a file-backed writeback path; revisit if a provider requires it.
- The other PR #725 review follow-ups: opencode download checksum (todo 078), non-root workspace user (todo 080 — the real mitigation for same-user credential exposure), expanded smoke (todo 081).

## Context & Research

### Relevant Code and Patterns

- `src/services/setup/auth-json.ts` — `parseAuthJsonInput()` (JSON.parse + object check) and `populateAuthJson()` (writes `auth.json` to the OpenCode data dir, mode `0600`, fresh each run). **The exact pattern this plan mirrors for the workspace.**
- `src/services/setup/types.ts:82-107` — the canonical `auth.json` shape: `Record<providerID, ApiAuth | OAuthAuth | WellKnownAuth>`, `ApiAuth = {type:'api', key}`.
- `packages/runtime/src/shared/env.ts:17` — `getOpenCodeAuthPath() = $XDG_DATA_HOME/opencode/auth.json` (the write target).
- `deploy/workspace-entrypoint.sh` — already provisions the mitmproxy CA before `exec node`; the home for auth provisioning.
- `deploy/workspace.Dockerfile` — bakes `/root/.config/opencode/opencode.json`; the home for the default `model` field.
- `apps/workspace-agent/src/opencode-server.ts:101` — spawns `opencode serve` with `env: process.env`, so the server inherits entrypoint env (and reads the on-disk `auth.json`).
- `apps/workspace-agent/src/clone.ts:298-308` — builds an **explicit env allowlist** for the git child (NOT `...process.env`), so credentials do not bleed into the clone subprocess. This is why the file-based credential keeps the clone path clean.
- `deploy/compose.yaml` — existing `workspace-opencode-token` `_FILE` secret mount with `create_host_path:false`; the shape to copy.
- `deploy/README.md` — "Current optional secrets" table + the new-secret migration `touch` note.

### Institutional Learnings

- `docs/solutions/best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md` — config-declared pattern; the baked `opencode.json` is the right place for `model`.
- `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md` — the mention-loop attach/execution contract this unblocks.

### External References (verified against cloned OpenCode source `.slim/clonedeps/repos/anomalyco__opencode/`)

- `packages/opencode/src/auth/index.ts:60` — `if (process.env.OPENCODE_AUTH_CONTENT) { return JSON.parse(...) }` then falls back to reading the `auth.json` file. **This is the module `opencode serve` wires** (`server/routes/instance/httpapi/server.ts:189` provides `Auth.defaultLayer` from `@/auth`). (`v2/auth.ts:111` has the same env read but is not the serve runtime path.)
- Credential schema: `{type:'api', key}` (used by v1) | `oauth` | `wellknown`.
- `opencode.json` schema supports top-level `model: "provider/model"`; session model resolves `input.model ?? agent.model ?? currentModel ?? provider.defaultModel()` — unset does not hard-error, but R2 wants an explicit default.

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| **Credentials via a bind-mounted secret that the entrypoint writes to `$XDG_DATA_HOME/opencode/auth.json` (`0600`)** | Mirrors the action tier's proven `populateAuthJson`. A `0600` file has a strictly smaller introspection surface than an env var (no `/proc/<pid>/environ`, no `docker inspect`), and `clone.ts`'s explicit env allowlist already keeps it out of the git child. OpenCode reads this file on the serve path (`auth/index.ts`). |
| **Rejected — `OPENCODE_AUTH_CONTENT` env var** | Simpler, but exposes a bearer-grade key via `/proc/<pid>/environ` to any same-user process (including untrusted cloned repo code). The file path is the defense-in-depth choice; same-user exposure is then bounded by the non-root follow-up (todo 080). |
| **Entrypoint validates the credential blob against the auth schema before writing** — not just `JSON.parse` | "Parses as JSON" passes an empty `{}` or wrong-shape blob, deferring failure to a cryptic turn-time error. Validate: top-level object, ≥1 provider entry, each entry has `type:'api'` with a non-empty `key`. Fail fast with a clear message naming the problem. |
| **Model + provider config supplied at deploy time via `WORKSPACE_OPENCODE_MODEL` + `WORKSPACE_OPENCODE_CONFIG`, overlaid by the entrypoint onto a base `opencode.json` (no model/provider baked)** | Achieves parity with the action's `model` + `opencode-config` inputs, which is how `marcusrbrown/infra` routes Claude/OpenAI through cliproxyapi (stock `anthropic`/`openai` providers redirected via `provider.<id>.options.baseURL`). A baked default would be a placeholder the deployer must override anyway; the deploy is inherently provider-specific. The entrypoint shallow-merges the JSON overlay and applies the model string, always preserving the baked Systematic plugin. |
| **Fail-soft on missing auth (per the Canonical Auth-Gating Rule), but emit a clear startup marker** | The clone path must boot without creds; the mention-loop turn surfaces the auth error. To avoid a silently half-provisioned state, the entrypoint logs an explicit `auth: provisioned` / `auth: absent (mention loop will fail until configured)` line at startup so operators can see the state in `docker logs`. |
| **Workspace-only change; no gateway code** | The gateway attaches via URL + bearer token and sets no model; the workspace self-authenticates and self-selects the model. Smallest blast radius. |

## Threat Model (credential handling)

The workspace container clones and may execute untrusted repository code in the same container that now holds an LLM provider credential. Implications, to be documented for operators:

- The credential is **bearer-grade**: anyone/anything that reads it can use it externally until rotated.
- Compromise of cloned-repo code running as the same user can read the `0600` `auth.json`. The file channel narrows the surface vs env; the non-root user split (todo 080) is the real confinement and is called out as the follow-up.
- Operator guidance: supply a **least-privilege, rotatable** provider key (not a full org-wide production credential), and rotate by replacing the secret file + restarting the workspace container.

## Open Questions

### Resolved During Planning / Review

- **Which module reads creds on the serve path?** `packages/opencode/src/auth/index.ts` (`Auth.defaultLayer`), verified — both it and `v2/auth.ts` read `OPENCODE_AUTH_CONTENT`, and both fall back to the `auth.json` file.
- **Env var vs file?** File (bind-mounted secret → entrypoint writes XDG `auth.json`), per review — smaller exposure, matches `populateAuthJson`.
- **Do bare provider-key env vars work?** No — OpenCode has no generic provider-key env reads. Must be the `auth.json` blob (file or `OPENCODE_AUTH_CONTENT`).
- **Does an unset model hard-error?** No — falls back through session/agent/provider default; R2 still bakes an explicit default.
- **OAuth?** Out of scope for v1 — static blob can't refresh; API-key only.
- **How does infra route Claude/OpenAI today (cliproxyapi)?** Verified against `marcusrbrown/infra` `packages/cli/src/commands/cliproxy/setup/templates.ts`: stock `anthropic`/`openai` providers get `options.baseURL = https://cliproxy.fro.bot/v1`; models `anthropic/claude-sonnet-4-6` / `openai/gpt-5.4-mini`; `auth.json` keyed per-provider with the cliproxy bearer token as `key`. The workspace exposes the same surface so this config maps over 1:1.

### Deferred to Implementation

- **Exact XDG path resolution in-container** — write to `${XDG_DATA_HOME:-/root/.local/share}/opencode/auth.json`; confirm the data dir at implementation (OpenCode's `Global.Path.data`).
- **Validation depth** — schema-shape validation (type/key presence) is the bar; a live auth-resolution dry-run is explicitly NOT attempted at startup (needs a real provider call).

## Implementation Units

- [ ] **Unit 1: Entrypoint auth provisioning (file-based)**

**Goal:** The entrypoint writes a validated `auth.json` to OpenCode's data path from a mounted secret, so the server authenticates — without baking the secret or exposing it via env.

**Requirements:** R1, R3, R5

**Dependencies:** None (builds on the PR #725 entrypoint)

**Files:**
- Modify: `deploy/workspace-entrypoint.sh`

**Approach:**
- Read the optional secret path from `WORKSPACE_OPENCODE_AUTH_FILE` (default `/run/secrets/workspace_opencode_auth`).
- If present and non-empty: validate it is a JSON object with ≥1 provider entry where each entry is `{type:'api', key:<non-empty>}`; on failure, exit with a clear message naming the problem. On success, write it to `${XDG_DATA_HOME:-/root/.local/share}/opencode/auth.json` with `0600` (mkdir the dir first), mirroring `populateAuthJson`.
- If absent/empty: per the Canonical Auth-Gating Rule, log `auth: absent (mention loop will fail until configured)` and continue (clone-only boots). Never log the secret content.
- Emit `auth: provisioned` on success. Keep the CA step + `exec node` ordering; auth write happens before `exec`.

**Patterns to follow:**
- `src/services/setup/auth-json.ts` (`parseAuthJsonInput` validation + `populateAuthJson` write/perms).
- The existing CA-handling structure in `deploy/workspace-entrypoint.sh`.

**Test scenarios:**
- Test expectation: none (shell entrypoint) — exercised by Unit 4 smoke (dummy valid blob → file written; absent → boots) + a `sh -n` and shellcheck pass. Manual deploy validation covers a real provider auth.

**Verification:**
- With a valid secret, `$XDG_DATA_HOME/opencode/auth.json` exists `0600` with the blob; with a malformed/empty-provider blob, the container exits with a clear error; with no secret, it boots and the clone path works; the secret never appears in logs.

- [ ] **Unit 2: Model + provider-config overlay (entrypoint), no baked default**

**Goal:** The workspace OpenCode server's model and provider config are supplied at deploy time, mirroring the action's `model` + `opencode-config`.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `deploy/workspace.Dockerfile` (base `opencode.json` carries only the Systematic plugin + `autoupdate:false` — NO model, NO provider)
- Modify: `deploy/workspace-entrypoint.sh` (overlay `WORKSPACE_OPENCODE_CONFIG` + `WORKSPACE_OPENCODE_MODEL` onto the base config)

**Approach:**
- Drop the baked `model`. The entrypoint shallow-merges `WORKSPACE_OPENCODE_CONFIG` (a JSON object, the deployer's `provider` block) over the base config and sets `model` from `WORKSPACE_OPENCODE_MODEL`. The baked Systematic plugin is always preserved (union/dedup) so an overlay cannot drop it.
- Fail-soft: both unset → base config stands (clone-only boots; mention turn uses OpenCode's default/error). Malformed `WORKSPACE_OPENCODE_CONFIG` → fail fast with a clear message.

**Patterns to follow:**
- The action's `opencode-config` merge semantics (`src/services/setup/setup.ts`); the auth-validator `node -e` pattern already in the entrypoint.

**Test scenarios:**
- Test expectation: none (Dockerfile + shell) — Unit 4 smoke asserts overlay-applied (model + baseURL present, plugin preserved), overlay-absent (no model, plugin present), and malformed-overlay fail-fast.

**Verification:**
- With the cliproxyapi-shaped env, the effective `opencode.json` carries the overlaid model + provider `baseURL` + the Systematic plugin; with neither env, no `model` field and the plugin remains; malformed JSON exits non-zero.

- [ ] **Unit 3: Compose wiring**

**Goal:** Wire the auth secret into the `workspace` service, preserving secret/network conventions.

**Requirements:** R1, R3

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `deploy/compose.yaml`

**Approach:**
- Add a bind-mounted `workspace-opencode-auth` secret to the `workspace` service (`/run/secrets/workspace_opencode_auth`, `read_only`, `create_host_path:false`) and the `WORKSPACE_OPENCODE_AUTH_FILE` env pointing at it.
- Add `WORKSPACE_OPENCODE_MODEL` + `WORKSPACE_OPENCODE_CONFIG` env (non-secret operator config, sourced from `deploy/.env`) to the `workspace` service.
- Preserve the port model and the mitmproxy CA mount from PR #725 unchanged.

**Patterns to follow:**
- The existing `workspace-opencode-token` secret mount in `deploy/compose.yaml`.

**Test scenarios:**
- Test expectation: none (compose config) — validated by `docker compose config` parse; full-stack model-backed turn is the manual acceptance check.

**Verification:**
- `docker compose -f deploy/compose.yaml config` parses; the workspace mounts the auth secret; no host ports added.

- [ ] **Unit 4: Smoke extension + docs**

**Goal:** Guard the config shape in CI and document the new secret + the model for operators, stating precisely what CI does and does not prove.

**Requirements:** R3, and operational readiness for R4

**Dependencies:** Unit 1-3

**Files:**
- Modify: `.github/workflows/ci.yaml` (extend `workspace-smoke`)
- Modify: `deploy/README.md` (secrets table + default model + threat-model/rotation note)
- Modify: `apps/workspace-agent/AGENTS.md` (note auth/model provisioning)

**Approach:**
- Extend `workspace-smoke`: with a dummy **valid** auth blob mounted via the secret path, assert the container boots, writes `auth.json` (`0600`), logs `auth: provisioned`. With no secret, assert it still boots (clone path) and logs `auth: absent`. With a cliproxyapi-shaped `WORKSPACE_OPENCODE_CONFIG` + `WORKSPACE_OPENCODE_MODEL`, assert the effective `opencode.json` carries the model + `baseURL` + Systematic plugin; with a malformed overlay, assert fail-fast.
- **Explicitly document in the job + README what the smoke does NOT prove:** a real provider authentication or a completed model-backed turn (those need live creds → manual deploy validation, R4). Green CI is not operational readiness for the mention loop.
- Docs: add `workspace-opencode-auth` to the secrets table (required for the mention loop, optional for clone-only) with the migration `touch` note; document `WORKSPACE_OPENCODE_MODEL` + `WORKSPACE_OPENCODE_CONFIG` with the cliproxyapi recipe and the threat-model/rotation guidance.

**Patterns to follow:**
- The PR #725 `workspace-smoke` job; the README "Current optional secrets" table + migration section.

**Test scenarios:**
- Happy path: valid dummy blob → `auth.json` written `0600`, `auth: provisioned`, model present → job passes.
- Edge case: no secret → boots, `auth: absent`, clone path up → job passes.
- Error path: malformed/empty-provider blob → entrypoint exits with a clear error (assert non-zero + message).

**Verification:**
- `workspace-smoke` passes all three paths; docs accurately describe the secret, default model, what CI proves, and rotation.

## System-Wide Impact

- **Interaction graph:** The gateway mention loop gains a working, authenticated, model-selected OpenCode server with no gateway code change. The clone path is untouched.
- **Error propagation:** Absent auth → mention-loop turn fails with OpenCode's auth error (clear); malformed auth → entrypoint fails fast at startup; clone-only → boots clean.
- **State lifecycle risks:** The secret must never reach image layers, build args, logs, or the clone child env. Written `0600` to the data dir at runtime only.
- **API surface parity:** New deploy-secret contract (`workspace-opencode-auth`) consumed by external IaC — documented for operators with rotation guidance.
- **Unchanged invariants:** Port model, CA-trust behavior, clone credential handling/allowlist, and workspace-agent source all unchanged from PR #725.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Bearer LLM key readable by untrusted cloned-repo code (same user) | File `0600` (smaller surface than env) + threat-model doc + least-privilege/rotatable key guidance; non-root split tracked as todo 080. |
| Malformed/empty-provider blob looks provisioned | Schema-shape validation (type/key presence), not just `JSON.parse`; fail fast with a named error. |
| OAuth token expiry mid-session | Out of scope — v1 is API-key only; documented. |
| Green CI mistaken for working mention loop | Smoke + README explicitly state CI proves config shape only; R4 is manual deploy validation. |
| Deploy forgets the new secret on upgrade | `create_host_path:false` + README migration `touch` note. |
| Wrong/over-privileged key | Operator guidance: least-privilege, rotatable; rotation = replace file + restart. |

## Documentation / Operational Notes

- Operators populate `deploy/secrets/workspace-opencode-auth` with an API-key `auth.json` blob (e.g. `{"anthropic":{"type":"api","key":"sk-..."}}`) using a least-privilege, rotatable key.
- Canonical validation: after deploy, `@fro-bot <prompt>` in a registered channel completes a model-backed turn (R4). Rotate by replacing the secret file and restarting the workspace container.

## Sources & References

- Todo: `.context/systematic/todos/079-pending-p1-workspace-opencode-model-auth-provisioning-missing-for-mention-loop.md`
- Prior: PR #725 (workspace executor image), `docs/plans/2026-06-01-003-feat-workspace-executor-image-plan.md`
- Code: `src/services/setup/auth-json.ts`, `src/services/setup/types.ts:82-107`, `packages/runtime/src/shared/env.ts:17`, `deploy/workspace-entrypoint.sh`, `deploy/workspace.Dockerfile`, `deploy/compose.yaml`, `apps/workspace-agent/src/{opencode-server,clone}.ts`
- OpenCode source (verified): `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/auth/index.ts:60`, `server/routes/instance/httpapi/server.ts:189`
- Review: 5-persona document-review (coherence, feasibility, security-lens, scope-guardian, adversarial), 2026-06-01
