---
title: "feat: Make gateway announce/presence endpoint opt-in"
type: feat
status: active
date: 2026-06-02
---

# feat: Make gateway announce/presence endpoint opt-in

## Overview

The gateway daemon hard-requires `GATEWAY_WEBHOOK_SECRET` and `GATEWAY_PRESENCE_CHANNEL_ID` at boot, but the shipped `deploy/compose.yaml` wires neither — so a deployer following the shipped contract gets a crash-looping gateway (`Missing required secret: GATEWAY_WEBHOOK_SECRET`). This plan makes the announce/presence HTTP endpoint **opt-in**: when both secrets are present the announce server boots as today; when both are absent the gateway boots normally with the announce endpoint disabled; when exactly one is present the gateway fails fast with a clear both-or-neither error.

This resolves issue #738 by making the announce subsystem a deliberate opt-in rather than a mandatory dependency, removing the forced-secret friction for deployers who only use the Discord mention loop.

## Problem Frame

Issue #738 (Fro Bot triage confirmed against `v0.50.0` and current `main`): `loadGatewayConfig()` calls the throwing `readSecret('GATEWAY_WEBHOOK_SECRET')` / `readSecret('GATEWAY_PRESENCE_CHANNEL_ID')` (`packages/gateway/src/config.ts:361-362`) before the gateway can boot. The announce HTTP server is started unconditionally (`packages/gateway/src/program.ts:298`) and `AnnounceServerConfig` requires both as non-optional `string` fields. Compose provides no source for either secret, and `deploy/README.md` never creates them, so the documented deploy path crash-loops under `restart: unless-stopped`.

The maintainer decision (per triage) is to make the endpoint **optional** rather than wire the secrets as required. The announce/presence endpoint is a real but non-core subsystem — the core gateway value (Discord mention → OpenCode execution) does not depend on it.

## Requirements Trace

- R1. `GATEWAY_WEBHOOK_SECRET` and `GATEWAY_PRESENCE_CHANNEL_ID` become optional; the gateway boots successfully when both are absent.
- R2. When both secrets are present, the announce HTTP server behaves exactly as today (no security or behavioral regression to the `/v1/announce` ingress path).
- R3. When exactly one of the two is present, the gateway fails fast at config load with a clear both-or-neither error (no half-configured announce server).
- R4. When the announce endpoint is disabled, the gateway does not start the HTTP server and shutdown handling tolerates the absent server handle.
- R5. `deploy/compose.yaml` and `deploy/README.md` document the two optional secrets and how to enable the announce endpoint, consistent with the existing optional-secret file pattern.
- R6. CI proves the gateway image boots in **both** the no-announce-secrets (announce disabled) and with-announce-secrets (announce enabled, server starts) configurations, and still fails fast on a genuinely-missing core secret.

## Scope Boundaries

- No change to the announce ingress security model (HMAC verification, replay cache, rate limiting, body limit) when the endpoint IS enabled — opt-in must not weaken hardening.
- No change to the Discord mention loop, tool-approval, coordination, or workspace paths.
- No change to other required gateway secrets (`DISCORD_TOKEN`, GitHub App credentials, etc.).

### Deferred to Separate Tasks

- A general "every required secret in config.ts has a matching compose wiring" drift-guard: noted as a future hardening idea, not built here. This plan instead proves the specific no-secrets boot case in CI (R6).

## Context & Research

### Relevant Code and Patterns

- **Pair-validation precedent (mirror this exactly):** `packages/gateway/src/config.ts:288-301` — the AWS credential block reads `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` optionally and enforces "both set together, or neither" with a clear error naming which one was received, then builds an optional `credentials` object only when both are present. The announce secrets should follow the identical shape.
- **Config type:** `GatewayConfig` interface at `packages/gateway/src/config.ts:18`, fields `webhookSecret: string` / `presenceChannelId: string` at lines 43-44, assembled at lines 387-388.
- **Optional secret reader:** `readOptionalSecret(name): string | null` (`config.ts:196`) — same precedence as `readSecret` but returns `null` instead of throwing. Already used for `DISCORD_GUILD_ID`, `S3_ENDPOINT`, etc.
- **Announce server startup:** `packages/gateway/src/program.ts:298-310` — `deps.startAnnounceServer({client, logger, isShuttingDown}, {webhookSecret, presenceChannelId, httpPort})` returns a `CloseableServer` handle.
- **Shutdown already tolerates an absent handle:** `installShutdownHandlers(client, logger, drainMs?, server?: CloseableServer, awaitInFlight?)` (`packages/gateway/src/shutdown.ts:69`) — `server` is already optional, so passing `undefined` when the announce server is disabled needs no shutdown change.
- **Injection site:** `packages/gateway/src/main.ts:29` injects the real `createAnnounceServer`.
- **Existing optional-secret compose pattern:** `deploy/compose.yaml` `GATEWAY_TRIGGER_ROLE_ID_FILE` (line 39) + its bind-mount (lines 153-157) with `create_host_path: false`, and the `deploy/README.md` "When adding a new optional secret" migration note.

### Institutional Learnings

- `docs/solutions/best-practices/workspace-executor-opencode-provisioning-best-practices-2026-06-01.md` — **fail-soft when absent, fail-fast when malformed**; prefer explicit startup gating over implicit half-configured behavior. Maps directly to "announce boots only when both secrets exist; one-of-two is malformed → fail fast."
- `docs/solutions/best-practices/signed-webhook-ingress-hardening-2026-05-29.md` — treat announce ingress as hostile; do not weaken the ingress security model when making the endpoint opt-in.
- `docs/solutions/build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md` — image-only regressions need a build-and-boot CI smoke test; if the gateway can start conditionally, CI should verify the "no secrets / missing config" case too.

### External References

- None needed — the change follows an existing in-repo precedent (AWS credential pair-validation) and established optional-secret conventions.

## Key Technical Decisions

- **Model announce config as a single optional object, not two independent nullable fields.** Replace `webhookSecret: string` + `presenceChannelId: string` on `GatewayConfig` with an optional `announce?: { readonly webhookSecret: string; readonly presenceChannelId: string }`. This makes both-or-neither a **type-level invariant** (you either have the announce object with both values, or you have nothing) — "make impossible states impossible." Downstream code branches on `config.announce !== undefined` rather than null-checking two separate fields. This is the AWS-credentials shape applied to announce. **Alternative considered:** two independent nullable fields (`webhookSecret?: string` + `presenceChannelId?: string`) plus pair-validation. Rejected for consistency with the AWS-credential block in the same function (`config.ts:288-301`), which already models a both-or-neither secret pair as a single optional object — matching the immediate neighbor is the stronger maintainability signal. The internal `AnnounceServerConfig` keeps its two required `string` fields; the object is unwrapped at the `program.ts` gating boundary.
- **Pair-validation mirrors the AWS credential block.** Read both with `readOptionalSecret`; both present → build the announce object; both absent → `undefined`; exactly one present → throw a both-or-neither error naming which was received (and which is missing).
- **Gate startup, keep ingress hardening intact.** `program.ts` starts the announce server only when `config.announce !== undefined`; when disabled, `serverHandle` is `undefined` and is passed through to `installShutdownHandlers` (already optional). The announce server code, HMAC verification, replay cache, and rate limiting are unchanged.
- **Compose ships the secrets commented-out / documented as opt-in.** The default shipped compose must boot without them (closing #738); enabling announce is a documented opt-in step. Use the same `_FILE` + bind-mount + `create_host_path: false` pattern as `GATEWAY_TRIGGER_ROLE_ID`.

## Open Questions

### Resolved During Planning

- **Required vs optional?** → Optional (user decision). Announce becomes opt-in.
- **Two nullable fields vs one optional object?** → One optional `announce` object, for the type-level both-or-neither invariant.
- **Does shutdown need changes for the disabled case?** → No. `installShutdownHandlers`'s `server` param is already optional.

### Deferred to Implementation

- Exact field/helper naming inside `loadGatewayConfig` for the announce block (follow the AWS block's local-variable style).
- Whether to keep the two secrets as separate compose bind-mounts (preferred for symmetry) vs a single `env_file` — decide when editing compose; separate bind-mounts match the existing pattern.

## Implementation Units

- [ ] **Unit 1: Make announce secrets optional with both-or-neither validation (`config.ts`)**

**Goal:** `loadGatewayConfig()` no longer throws when both announce secrets are absent; models them as an optional `announce` object with pair-validation.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `packages/gateway/src/config.ts`
- Test: `packages/gateway/src/config.test.ts`

**Approach:**
- Replace `webhookSecret: string` + `presenceChannelId: string` on the `GatewayConfig` interface with `readonly announce?: { readonly webhookSecret: string; readonly presenceChannelId: string }`.
- In `loadGatewayConfig`, replace the two `readSecret(...)` calls with `readOptionalSecret(...)`, then apply pair-validation mirroring the AWS credential block (`config.ts:288-301`): both present → set `announce`; exactly one present → throw a both-or-neither error naming the received and the missing var; both absent → leave `announce` undefined.
- Assemble `...(announce === undefined ? {} : {announce})` into the returned config, same spread style as the AWS `credentials` field.

**Patterns to follow:**
- AWS credential pair-validation: `packages/gateway/src/config.ts:288-301` and the `...(credentials === undefined ? {} : {credentials})` assembly at line 325.

**Test scenarios:**
- Happy path: both `GATEWAY_WEBHOOK_SECRET` and `GATEWAY_PRESENCE_CHANNEL_ID` set → `config.announce` is `{webhookSecret, presenceChannelId}` with the expected values.
- Happy path: neither set → `config.announce` is `undefined` and `loadGatewayConfig()` does NOT throw (this is the #738 regression case — replaces the two existing "throws Missing required secret" tests at `config.test.ts:984-999`).
- Error path: only `GATEWAY_WEBHOOK_SECRET` set → throws a both-or-neither error naming the missing `GATEWAY_PRESENCE_CHANNEL_ID`.
- Error path: only `GATEWAY_PRESENCE_CHANNEL_ID` set → throws a both-or-neither error naming the missing `GATEWAY_WEBHOOK_SECRET`.
- Edge case: `_FILE` variants honored (e.g., `GATEWAY_WEBHOOK_SECRET_FILE`) for both, consistent with `readOptionalSecret` precedence.
- Edge case: empty or whitespace-only `GATEWAY_WEBHOOK_SECRET` (or its `_FILE`) is treated as **absent** (relies on `readOptionalSecret` returning `null` for empty/whitespace) — e.g. empty webhook secret + valid presence id → both-or-neither error naming the missing webhook secret, NOT a half-enabled announce server. This locks the security property that an empty secret cannot enable an unauthenticated announce endpoint.

**Verification:**
- The two former "Missing required secret" assertions are replaced by the both-absent no-throw test plus the two one-of-two error tests; full gateway suite green.

---

- [ ] **Unit 2: Gate announce server startup on opt-in (`program.ts`)**

**Goal:** The announce HTTP server starts only when `config.announce` is present; when absent, the gateway boots with no HTTP server and shutdown handles the undefined handle.

**Requirements:** R2, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/gateway/src/program.ts`
- Test: `packages/gateway/src/program.test.ts`

**Approach:**
- Wrap the `deps.startAnnounceServer(...)` call (`program.ts:298-310`) in `if (config.announce !== undefined)`, building the `AnnounceServerConfig` from `config.announce.webhookSecret` / `config.announce.presenceChannelId` / `config.httpPort`. Otherwise leave `serverHandle` as `undefined`.
- Pass the possibly-undefined `serverHandle` to `installShutdownHandlers` (already optional — no signature change).
- Add a clear comment: announce endpoint is opt-in; disabled when announce secrets are absent.
- Log at info level whether the announce endpoint is enabled or disabled at boot (operator observability — no secret values logged).
- Update `program.test.ts` deps/config fixtures (lines ~147-148 set `webhookSecret`/`presenceChannelId`) to use the new `announce` config shape.

**Patterns to follow:**
- The existing self-test / readiness dep-injection boot ordering in `program.ts`; the `isShuttingDown` + `serverHandle` shutdown wiring already present.

**Test scenarios:**
- Happy path: `config.announce` present → `startAnnounceServer` called once with the announce secrets + httpPort; the returned handle is passed to `installShutdownHandlers`.
- Happy path: `config.announce` undefined → `startAnnounceServer` is NOT called; boot completes; `installShutdownHandlers` receives `undefined` for the server handle.
- Integration: with announce disabled, the boot Effect still wires client events and logs that the announce endpoint is disabled (assert the enable/disable log line).

**Verification:**
- Boot succeeds in both modes; the announce server is started in exactly one of them; shutdown wiring is correct for both.

---

- [ ] **Unit 3: Compose + docs + CI no-secrets boot smoke (`deploy/`, `ci.yaml`)**

**Goal:** The shipped compose boots without announce secrets (closing #738); enabling announce is a documented opt-in; CI proves the no-secrets image boot.

**Requirements:** R5, R6

**Dependencies:** Unit 2

**Files:**
- Modify: `deploy/compose.yaml`
- Modify: `deploy/README.md`
- Modify: `.github/workflows/ci.yaml`

**Approach:**
- `deploy/compose.yaml`: document the two announce secrets as **opt-in** in the `gateway` service — add commented-out `GATEWAY_WEBHOOK_SECRET_FILE` / `GATEWAY_PRESENCE_CHANNEL_ID_FILE` env entries and commented-out bind-mounts mirroring the `GATEWAY_TRIGGER_ROLE_ID` pattern (`create_host_path: false`), with a comment that uncommenting both enables the announce endpoint. The default (commented) state must boot cleanly.
- `deploy/README.md`: add an "Enabling the announce/presence endpoint (optional)" subsection — both secrets are required together if you enable it; show the `openssl rand -hex 32 > deploy/secrets/gateway-webhook-secret` and presence-channel-id creation steps and the uncomment instructions. Note the both-or-neither rule.
- `.github/workflows/ci.yaml`: the existing `Gateway Image Smoke Test` (step "Smoke-test gateway image", ~line 268) runs `docker run` with **zero** env secrets and asserts `grep -q "Missing required secret: DISCORD_TOKEN"`. `DISCORD_TOKEN` is read first in `loadGatewayConfig`, so the gateway throws before it ever reaches the announce secrets — the existing assertion is **not** testing announce and stays **valid unchanged**. The change is **additive**: add two new smoke invocations (or steps):
  1. **Boot-disabled case:** supply all required core secrets (every `readSecret` call in config.ts — `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `S3_BUCKET`, `S3_REGION`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `WORKSPACE_OPENCODE_TOKEN`) but **omit** `GATEWAY_WEBHOOK_SECRET` and `GATEWAY_PRESENCE_CHANNEL_ID` → assert the gateway reaches a healthy/running state with the announce endpoint disabled (assert the "announce disabled" boot log line). This is the #738 default-deploy proof.
  2. **Boot-enabled case:** supply the core secrets **plus** `GATEWAY_WEBHOOK_SECRET` + `GATEWAY_PRESENCE_CHANNEL_ID` → assert the gateway boots AND the real announce server starts (assert the "announce enabled" / server-listening log line). This closes the adversarial + security gap that Unit 2 only mocks `startAnnounceServer` — the enabled path proves the real `createAnnounceServer` wiring survives the config reshape.

**Patterns to follow:**
- `deploy/compose.yaml` `GATEWAY_TRIGGER_ROLE_ID` env + bind-mount + `create_host_path: false`.
- `deploy/README.md` existing "When adding a new optional secret" migration section.
- The existing `Gateway Image Smoke Test` job structure in `.github/workflows/ci.yaml`.

**Test scenarios:**
- Test expectation: none for compose/README (declarative deploy config + docs). CI smoke changes are the executable proof.
- CI smoke — **no-secrets fail-fast (existing, unchanged):** zero env secrets → gateway throws `Missing required secret: DISCORD_TOKEN`.
- CI smoke — **core-only boot-disabled (new):** all required core secrets supplied, announce secrets omitted → gateway reaches running/healthy state with announce endpoint disabled (assert the "announce disabled" boot log line).
- CI smoke — **core+announce boot-enabled (new):** core secrets + `GATEWAY_WEBHOOK_SECRET` + `GATEWAY_PRESENCE_CHANNEL_ID` → gateway boots AND the real announce server starts (assert the "announce enabled" / server-listening log line).

**Verification:**
- `docker compose config` is valid; the documented default deploy path boots without announce secrets; the `Gateway Image Smoke Test` proves all three smoke states: no-secrets fail-fast, core-only boot-disabled, and core+announce boot-enabled.

## System-Wide Impact

- **Interaction graph:** Only the announce subsystem boot gate changes. The Discord mention loop, tool-approval, coordination lock/self-test, and workspace paths are untouched.
- **Error propagation:** A one-of-two announce config is now a fail-fast config error (clear both-or-neither message) instead of either a silent half-config or an unrelated crash. A genuinely-missing core secret still fails fast.
- **State lifecycle risks:** When announce is disabled, no HTTP server is created → no listening socket, no replay cache, no rate limiter; shutdown receives `undefined` and skips server close (already supported).
- **API surface parity:** `GatewayConfig.webhookSecret`/`presenceChannelId` become `GatewayConfig.announce?`. Every consumer (`program.ts`, `program.test.ts`, any config fixtures) must move to the new shape — grep `webhookSecret`/`presenceChannelId` across `packages/gateway/` to confirm all references are migrated.
- **Integration coverage:** The CI image smoke is the cross-layer proof that config gating + program gating + compose defaults compose into a booting container without announce secrets.
- **Unchanged invariants:** When announce IS enabled, the `/v1/announce` ingress behavior (HMAC verification, replay protection, rate limiting, body limit, empty-render fallback) is byte-for-byte unchanged — this plan only gates whether the server starts, never how it behaves once started.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A consumer of `config.webhookSecret`/`presenceChannelId` is missed during the type migration → type error or runtime undefined | Grep all `packages/gateway/` references before completing Unit 2; tsc must pass; the type change makes missed sites compile errors, not silent failures |
| Opt-in weakens ingress security if someone enables announce with only partial config | Both-or-neither validation makes a half-enabled announce impossible; ingress hardening code is untouched |
| CI smoke still asserts the old "missing secret" crash and fails after the fix | Unit 3 explicitly updates the smoke expectation to the no-announce-secrets success boot while keeping a real missing-core-secret fail-fast case |
| Units 1-2 land before Unit 3's additive smoke cases, temporarily leaving the new boot paths unproven in CI | Units 1-3 land as a **single PR**. The image smoke test only asserts the `DISCORD_TOKEN` fail-fast today (it never reaches the announce check), so Units 1-2 do not red-line the existing smoke even before Unit 3's additive cases land; the vitest `config.test.ts` changes are bundled atomically within Unit 1. Co-committing keeps main green throughout. |
| Existing `config.test.ts:984-999` required-secret tests now assert wrong behavior | Unit 1 replaces them with the both-absent no-throw + two one-of-two error tests |

## Documentation / Operational Notes

- `deploy/README.md` gains an opt-in announce section; the default documented deploy no longer provisions announce secrets.
- Operators upgrading from a crash-looping `v0.50.0` deploy simply pull the new image — the gateway boots without announce secrets; no migration action required unless they want the announce endpoint.
- **Stale partial installs:** under the old contract both announce secrets were required, so a half-configured install was already a boot failure. With both-or-neither, an operator who has exactly one announce secret lingering (env or secret file) from a partial setup still gets a fail-fast both-or-neither error. Remediation: either create the matching second secret to enable announce, or remove both to opt out. The boot error names which secret is missing.
- A patch/minor release after merge lets infra move off the `v0.46.3` hold (issue #738's interim workaround).

## Sources & References

- Origin: issue #738 + Fro Bot triage comment (verified against `v0.50.0` and `main`).
- Related code: `packages/gateway/src/config.ts:288-301` (AWS pair-validation precedent), `:361-362` (the throwing reads), `packages/gateway/src/program.ts:298-312` (announce startup + shutdown), `packages/gateway/src/shutdown.ts:69` (optional server handle).
- Related learnings: `docs/solutions/best-practices/workspace-executor-opencode-provisioning-best-practices-2026-06-01.md`, `docs/solutions/best-practices/signed-webhook-ingress-hardening-2026-05-29.md`, `docs/solutions/build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md`.
