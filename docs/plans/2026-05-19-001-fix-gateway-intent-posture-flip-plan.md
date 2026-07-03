---
title: 'fix: Gateway intent-posture flip — privileged intents become opt-in'
type: fix
status: done
date: 2026-05-19
origin: https://github.com/fro-bot/agent/issues/646
---

> **Status: done.** All 3 units shipped: `DEFAULT_INTENTS` flipped to `[Guilds, GuildMessages]`, `DISCORD_PRIVILEGED_INTENTS` config knob, and tests/docs — verified on `main` (`packages/gateway/src/discord/client.ts:10`, PR #651).

# Gateway intent-posture flip — privileged intents become opt-in

## Overview

The gateway currently hard-codes the privileged Discord intent set as its baseline. `DEFAULT_INTENTS` in `packages/gateway/src/discord/client.ts` requests `MessageContent` and `GuildMembers` unconditionally, even though the only callers today are `createDiscordClient()` in `main.ts` and the bot's runtime behavior (slash commands, @-mentions in guild channels) needs neither. Until this flips, every gateway deployment that completes Discord-side approval for the privileged intents runs with broader read scope than the workload requires.

This plan flips the baseline to the non-privileged set (`Guilds`, `GuildMessages`) and introduces a single config knob — `DISCORD_PRIVILEGED_INTENTS` — that opts back into either or both privileged intents on a per-deployment basis. The knob loads through the existing `readOptionalSecret` pattern. Existing deployments that need the privileged set keep working by setting the env var; new deployments are non-privileged by default.

## Problem Frame

**Why this is wrong today.** Discord's gateway intent model treats `MessageContent` and `GuildMembers` as privileged precisely because they grant broad-scope reads against guild data. The application-level posture should be opt-in: bots that genuinely read message content or full member lists request those intents; bots that just receive mentions and run slash commands do not.

**Current behavior:**

- `DEFAULT_INTENTS` includes all four intents (`packages/gateway/src/discord/client.ts:10-15`).
- `createDiscordClient` merges any caller override on top of the defaults via a `Set` dedupe, so callers can never subtract a privileged intent (`packages/gateway/src/discord/client.ts:32-35`).
- The merge logic is otherwise sound — it correctly dedupes when callers add their own intents.

**What changes:**

- `DEFAULT_INTENTS` becomes `[Guilds, GuildMessages]`.
- `loadGatewayConfig()` reads `DISCORD_PRIVILEGED_INTENTS` (comma-separated, allowlisted to `MessageContent` and `GuildMembers` only) and exposes it as `privilegedIntents: GatewayIntentBits[]` on `GatewayConfig`.
- `main.ts` passes `{intents: config.privilegedIntents, logger}` to `createDiscordClient`.
- The Set-based merge logic stays — it's structurally correct; the meaning changes because `DEFAULT_INTENTS` is now smaller.

**Why the merge logic stays as-is.** The override path's job is "compose intents the gateway wants for its workload." With the smaller baseline, that composition now means "non-privileged baseline + whatever the operator opted into via env var." A `Set` dedupe is the right shape for that — replacing it would break the legitimate use case of `createDiscordClient({intents: [DirectMessages]})` for hypothetical future callers that want to extend the baseline.

## Requirements Trace

- **R1** — `DEFAULT_INTENTS` in `packages/gateway/src/discord/client.ts` contains only `Guilds` and `GuildMessages`.
- **R2** — `MessageContent` and `GuildMembers` opt in via the existing `readOptionalSecret` pattern in `packages/gateway/src/config.ts`, with no new schema-validation framework introduced.
- **R3** — Malformed config (unknown intent names, typos) fails fast with a clear error at gateway startup. No silent permissive default.
- **R4** — All 6 test scenarios specified in the origin issue pass:
  1. Boot with non-privileged baseline only when no opt-ins configured.
  2. Boot with `MessageContent` opt-in via config.
  3. Boot with `GuildMembers` opt-in via config.
  4. Boot with both privileged intents opted in.
  5. Malformed config fails fast with a clear error.
  6. Test-isolation guard: refuse to start the suite unless the token is a known-fake placeholder.
- **R5** — `packages/gateway/AGENTS.md` documents the new config knob and the opt-in semantics.

## Scope Boundaries

- **R20 / R21 enforcement** — channel-policy declaration, refusal patterns, rate limits, and drift refusal at the gateway boundary remain out of scope (deferred per the origin issue).
- **Cross-repo drift checks** — the mirror permission-drift runbook in `marcusrbrown/.dotfiles` stays separate. Both mechanisms will run independently against the same declared policy once this lands.
- **No new schema framework** — the issue is explicit: follow the existing `readOptionalSecret` pattern, do not introduce Zod, Effect Schema, or a custom validator framework.
- **No changes to `runtime-effect.ts`** — Effect adapters stay untouched. This change lives entirely inside the gateway's config and Discord client layers.
- **`workspace.Dockerfile`** is a `sleep infinity` placeholder for now and is not affected.

### Deferred to Separate Tasks

- R20 / R21 full enforcement: future plan in this repo, after Unit 7 of the gateway v1 plan lands.

## Context & Research

### Relevant Code and Patterns

| File | Reference |
|---|---|
| `packages/gateway/src/discord/client.ts:10-15` | Current `DEFAULT_INTENTS` constant (to flip) |
| `packages/gateway/src/discord/client.ts:30-66` | `createDiscordClient()` and the Set-based merge (merge logic stays, semantics change with the smaller default) |
| `packages/gateway/src/config.ts:42-77` | `readOptionalSecret` — canonical optional-secret pattern: tries `${NAME}_FILE` first, falls back to `process.env[name]`, treats empty/whitespace as null, EISDIR → clear error |
| `packages/gateway/src/config.ts:85-105` | `loadGatewayConfig()` — current pattern for reading and composing config values |
| `packages/gateway/src/config.ts:97-101` | `LOG_LEVEL` allowlist validation pattern (this plan mirrors it for the new env var) |
| `packages/gateway/src/config.ts:107-135` | AWS credential pair validation + orphan-token warning (this plan mirrors the parsing-then-throwing-clear-error pattern) |
| `packages/gateway/src/discord/client.test.ts:19-28` | Existing test asserting `MessageContent` is in defaults (must be replaced) |
| `packages/gateway/src/discord/client.test.ts:30-43` | Existing merge-dedup test (stays — verifies the merge logic still composes correctly with the smaller baseline) |
| `packages/gateway/src/config.test.ts:18-59` | `beforeEach` / `afterEach` env restore pattern — pattern to follow for new tests touching `DISCORD_PRIVILEGED_INTENTS` |
| `packages/gateway/src/main.ts:60-75` | Where `createDiscordClient()` is called — single wiring site to update |

### Institutional Learnings

- `docs/solutions/workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md` — strongest precedent for a posture flip from permissive-default to restrictive-default with explicit opt-in. The canonical takeaway: keep the resolver exhaustive and centralized; don't scatter ad-hoc env checks.
- `docs/solutions/best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md` — single source of truth for env-driven config knobs. Thread input → type → setup in one place.

### Tech stack

- discord.js 14.26.4 (canonical intent names: `GatewayIntentBits.MessageContent`, `GatewayIntentBits.GuildMembers`)
- Effect 3.21.2 (not used in this change — config and client layers stay on direct sync code)
- Vitest 4.1.5
- TypeScript 6.0.3, Node ESM target

## Key Technical Decisions

- **Parse comma-separated list, allowlist to exactly `MessageContent` and `GuildMembers`.** Not the full `GatewayIntentBits` enum. Reason: this knob is specifically the "privileged intents opt-in" surface — operators should not be able to enable arbitrary intents (e.g., `GuildPresences`, another privileged intent we don't need) via the same knob. If a future workload needs a non-privileged intent, it should be added to `DEFAULT_INTENTS` not this knob.
- **Case-sensitive match against canonical discord.js enum names.** `MessageContent,GuildMembers` is valid; `messagecontent,guildmembers` is rejected. Reason: discord.js's enum names are the canonical reference; operators copy them from the Discord dev portal; case-insensitive matching invites silent typos.
- **Whitespace trimming on each token.** `MessageContent, GuildMembers ` is valid — operators write env vars with various spacing conventions. Trim each token; reject empty tokens (`MessageContent,,GuildMembers`).
- **Empty / missing env var → `[]`.** The default-default case. The Set merge in `createDiscordClient` then naturally produces just the non-privileged baseline.
- **Fail-fast on unknown values.** A typo (`MesageContent`) throws at gateway startup with a clear error listing the allowed values. Better than silently dropping the typo and running with a posture the operator didn't intend.
- **Keep the existing merge logic.** The `Set`-dedup merge in `createDiscordClient` is structurally correct. Replacing it with "override replaces defaults" would prevent legitimate future composition (e.g., adding `DirectMessages` without removing the non-privileged baseline). The semantic change comes for free from the smaller `DEFAULT_INTENTS`.
- **Test-isolation guard pattern: `beforeAll` in `client.test.ts`.** Inspects `process.env.DISCORD_TOKEN` and throws unless undefined, empty, or matches a known-fake regex. Same shape as production credentials guards in other test suites.

## Open Questions

### Resolved During Planning

- **Where in the config flow does the validator throw?** Inside `loadGatewayConfig()`, right after parsing the env var, before constructing `GatewayConfig`. Matches the LOG_LEVEL pattern.
- **Should `DISCORD_PRIVILEGED_INTENTS` support a special `none` or `*` keyword?** No. Empty/missing is sufficient for "none"; `*` is unnecessary because the allowlist is only two values — operators can write `MessageContent,GuildMembers` explicitly.
- **What about the `DISCORD_PRIVILEGED_INTENTS_FILE` path?** It comes for free — `readOptionalSecret('DISCORD_PRIVILEGED_INTENTS')` already checks `DISCORD_PRIVILEGED_INTENTS_FILE` first. No additional work needed.
- **Should we add a compose.yaml secret mount for `discord-privileged-intents`?** Not in this PR — env-var is the canonical setting; the file path exists as a fallback but isn't expected to be the operator-facing surface. If operators want it as a file, they can add the mount themselves (the README documents the file pattern). Adds churn for no current operator benefit.

### Deferred to Implementation

- **Exact error message wording for unknown intent value.** Implementation will phrase it operator-friendly with the offending value and the allowed list. Not a planning question.

## Implementation Units

- [x] **Unit 1: Flip `DEFAULT_INTENTS` to non-privileged baseline**

**Goal:** Change `DEFAULT_INTENTS` in `packages/gateway/src/discord/client.ts` to contain only `Guilds` and `GuildMessages`. The merge logic in `createDiscordClient` is unchanged.

**Requirements:** R1.

**Dependencies:** None.

**Files:**
- Modify: `packages/gateway/src/discord/client.ts`

**Approach:**
- Remove `GatewayIntentBits.MessageContent` and `GatewayIntentBits.GuildMembers` from the `DEFAULT_INTENTS` literal.
- Update the JSDoc comment block above `createDiscordClient` to describe the new baseline.
- Leave the merge logic at `client.ts:32-35` untouched — it composes correctly with the smaller default.
- The existing `export {DEFAULT_INTENTS}` stays so tests can introspect it.

**Patterns to follow:**
- The JSDoc block at `packages/gateway/src/discord/client.ts:22-29` — keep the bullet-list style; add a bullet describing the baseline.

**Test scenarios:**
- Happy path: `DEFAULT_INTENTS.length === 2` and contains exactly `Guilds` and `GuildMessages` (no privileged intents).
- Happy path: `createDiscordClient()` with no options produces a client whose `intents` bitfield equals the union of `[Guilds, GuildMessages]` and nothing else.

**Verification:**
- The existing `default intents include MessageContent` test now fails (expected — Unit 3 deletes it). All other existing tests pass unchanged.
- `pnpm --filter @fro-bot/gateway check-types` clean.

---

- [x] **Unit 2: Add `DISCORD_PRIVILEGED_INTENTS` config knob in `loadGatewayConfig`**

**Goal:** Parse `DISCORD_PRIVILEGED_INTENTS` from env (via `readOptionalSecret`), validate against the two-value allowlist, and expose as `privilegedIntents: GatewayIntentBits[]` on `GatewayConfig`. Wire it into `main.ts` so it flows into `createDiscordClient` as the `intents` override.

**Requirements:** R2, R3.

**Dependencies:** Unit 1.

**Files:**
- Modify: `packages/gateway/src/config.ts` (parser, validation, `GatewayConfig` type extension)
- Modify: `packages/gateway/src/main.ts` (wire `privilegedIntents` into `createDiscordClient`)
- Test: `packages/gateway/src/config.test.ts` (parser tests — Unit 3 owns the client-level tests)

**Approach:**
- Introduce a module-level allowlist:
  ```ts
  const ALLOWED_PRIVILEGED_INTENTS = {
    MessageContent: GatewayIntentBits.MessageContent,
    GuildMembers: GatewayIntentBits.GuildMembers,
  } as const
  ```
  Operator-facing names are the keys; the values are the discord.js enum values.
- Add `privilegedIntents: GatewayIntentBits[]` to the `GatewayConfig` interface (readonly array).
- Inside `loadGatewayConfig()`:
  1. `const rawIntents = readOptionalSecret('DISCORD_PRIVILEGED_INTENTS')` (returns string | null).
  2. If null → `privilegedIntents = []`. Done.
  3. Otherwise split on `,`, trim each token, drop empty tokens that arise from leading/trailing/repeated separators (e.g., `,MessageContent,`). Throw clear error if a non-empty token doesn't match the allowlist keys exactly (case-sensitive). The error message names the invalid token and lists the allowed values.
  4. Map matching tokens to their `GatewayIntentBits` value. Dedupe via `Set`.
- Place the new block right after the LOG_LEVEL validation in `loadGatewayConfig` — mirrors the same parse-then-validate-then-throw pattern.
- In `main.ts`: change `createDiscordClient({logger})` to `createDiscordClient({intents: config.privilegedIntents, logger})`. If `privilegedIntents` is empty, the `intents` array is `[]` and the Set merge produces exactly `DEFAULT_INTENTS`.

**Patterns to follow:**
- `packages/gateway/src/config.ts:97-101` — `LOG_LEVEL` allowlist throw pattern.
- `packages/gateway/src/config.ts:107-135` — AWS credential parsing with structured error messages.

**Test scenarios:**
- Happy path: `DISCORD_PRIVILEGED_INTENTS` unset → `config.privilegedIntents === []`.
- Happy path: `DISCORD_PRIVILEGED_INTENTS=MessageContent` → `config.privilegedIntents === [GatewayIntentBits.MessageContent]`.
- Happy path: `DISCORD_PRIVILEGED_INTENTS=GuildMembers` → `config.privilegedIntents === [GatewayIntentBits.GuildMembers]`.
- Happy path: `DISCORD_PRIVILEGED_INTENTS=MessageContent,GuildMembers` → contains both values, no duplicates.
- Edge case: `DISCORD_PRIVILEGED_INTENTS=` (empty string) → `config.privilegedIntents === []` (treated as null by `readOptionalSecret`).
- Edge case: `DISCORD_PRIVILEGED_INTENTS= MessageContent , GuildMembers ` (extra whitespace) → both parsed correctly.
- Edge case: `DISCORD_PRIVILEGED_INTENTS=MessageContent,MessageContent` → deduped to one.
- Edge case: `DISCORD_PRIVILEGED_INTENTS=MessageContent,,GuildMembers` (empty middle token) → both privileged intents parsed, no error.
- Error path: `DISCORD_PRIVILEGED_INTENTS=MesageContent` (typo) → throws with message naming the invalid value and listing the allowed values.
- Error path: `DISCORD_PRIVILEGED_INTENTS=messagecontent` (wrong case) → throws (case-sensitive match).
- Error path: `DISCORD_PRIVILEGED_INTENTS=Guilds` (non-privileged intent in privileged knob) → throws (not in the privileged allowlist).
- Error path: `DISCORD_PRIVILEGED_INTENTS=GuildPresences` (a different privileged intent not allowed by this knob) → throws.
- Edge case: `DISCORD_PRIVILEGED_INTENTS_FILE` set to a file containing `MessageContent\n` → parsed correctly (free from `readOptionalSecret`).

**Verification:**
- All new `config.test.ts` tests pass.
- `pnpm --filter @fro-bot/gateway test` exits 0.
- `pnpm --filter @fro-bot/gateway check-types` clean.
- `pnpm --filter @fro-bot/gateway lint` clean.

---

- [x] **Unit 3: Client-level tests + test-isolation guard + AGENTS.md docs**

**Goal:** Add the client-level test scenarios from R4, install the test-isolation guard in `client.test.ts`, and document the `DISCORD_PRIVILEGED_INTENTS` knob in `packages/gateway/AGENTS.md`.

**Requirements:** R4, R5.

**Dependencies:** Unit 1, Unit 2.

**Files:**
- Modify: `packages/gateway/src/discord/client.test.ts` (delete obsolete `MessageContent`-in-defaults test, add new scenarios, install `beforeAll` guard)
- Modify: `packages/gateway/AGENTS.md` (add the env-var doc block)

**Approach:**
- **`client.test.ts` — delete the obsolete test.** The `default intents include MessageContent (required to read mention text)` test at lines 19-28 asserts the now-wrong behavior. Delete it (or replace its body) with a new test asserting `DEFAULT_INTENTS` is exactly `[Guilds, GuildMessages]`.
- **`client.test.ts` — add the test-isolation guard.** A `beforeAll` block at the top of the `describe` checks `process.env.DISCORD_TOKEN`:
  - undefined / empty / matches `/^(test-token-fake|fake|test|MOCK)/i` → pass.
  - otherwise → `throw new Error('refusing to run gateway client tests with what looks like a real DISCORD_TOKEN; set DISCORD_TOKEN to a known-fake value or unset it')`.
  This catches accidental sourcing of operator `.env` files into the test environment.
- **`client.test.ts` — add 4 new tests for the merge composition.** These verify the wiring works end-to-end:
  - "boots with non-privileged baseline only when no privileged intents opted in" — call `createDiscordClient()` with no options, assert bitfield = union of `[Guilds, GuildMessages]`.
  - "opts into MessageContent via passed intents" — call `createDiscordClient({intents: [GatewayIntentBits.MessageContent]})`, assert bitfield includes MessageContent and the baseline.
  - "opts into GuildMembers via passed intents" — same shape.
  - "opts into both privileged intents via passed intents" — assert bitfield includes both privileged intents and the baseline.
- **Update the existing merge-dedup test** (lines 30-43) — it tests `[DirectMessages, Guilds]`. Stays as-is since it still verifies merge behavior, just with the smaller baseline. The expected bitfield is recomputed automatically because it uses `DEFAULT_INTENTS` directly.
- **`AGENTS.md` — add config-knob documentation.** Insert a new section after the existing `## Package layout` block titled `## Configuration knobs`. Document `DISCORD_PRIVILEGED_INTENTS`:
  - What it does (opts into Discord privileged intents).
  - Allowed values (`MessageContent`, `GuildMembers`).
  - Format (comma-separated, case-sensitive, whitespace-tolerant).
  - Behavior when unset (non-privileged baseline only).
  - Behavior on typo (fail-fast at startup).
  - Note that the knob mirrors the `${NAME}_FILE` pattern from `readOptionalSecret`.
- The doc should be terse — match the existing AGENTS.md voice (no marketing speak, just operator-facing facts).

**Patterns to follow:**
- `packages/gateway/src/config.test.ts:18-59` — `beforeEach` / `afterEach` env restoration shape.
- `packages/gateway/src/discord/client.test.ts:30-43` — bitfield comparison via `new (... as unknown as ...).constructor` (reuse the same idiom; this works because discord.js stores intents as a BitField at runtime).
- `packages/gateway/AGENTS.md` — neutral operator-facing voice, no agent/session references.

**Test scenarios:**

R4#1–#6 are covered as follows:
- R4#1, R4#2, R4#3, R4#4 — new client-level tests in `client.test.ts` (this unit, listed below).
- R4#5 — owned by Unit 2's config-level tests (`config.test.ts`); malformed config throws inside `loadGatewayConfig()` and never reaches `createDiscordClient()`. Cross-referenced here for traceability; not duplicated.
- R4#6 — `validateTokenIsFake` helper tests (this unit, listed below) + the `beforeAll` install in `client.test.ts`.

This unit's tests:

- (R4#1) Happy path: default client (no options) has the non-privileged baseline only — assert intent bitfield equals union of `[Guilds, GuildMessages]` only.
- (R4#2) Happy path: `createDiscordClient({intents: [MessageContent]})` produces a client whose intents include MessageContent and the baseline.
- (R4#3) Happy path: same for GuildMembers.
- (R4#4) Happy path: both opted in via `intents: [MessageContent, GuildMembers]` produce baseline + both privileged intents.
- (R4#6) Test-isolation guard: extract guard logic into a small free function `validateTokenIsFake(token: string | undefined): void` (cleanest as a sibling test-only module — `packages/gateway/src/discord/test-token-guard.ts` or co-located with the test file — not an export from `client.ts`). Unit-test the helper directly and call it from the `beforeAll`. Add 3 helper tests: undefined → pass; `test-token-fake` → pass; `MTIzNDU2.real-looking-base64` → throws.

**Verification:**
- All client-level tests pass.
- `validateTokenIsFake` helper tests pass.
- `pnpm --filter @fro-bot/gateway test` exits 0.
- AGENTS.md renders without lint errors (`pnpm lint`).

## System-Wide Impact

- **Interaction graph:** `main.ts` calls `loadGatewayConfig` → uses `config.privilegedIntents` → passes to `createDiscordClient`. Single linear path; no callbacks, middleware, or observers affected.
- **Error propagation:** Malformed config throws inside `loadGatewayConfig`. `main.ts`'s startup `Effect.runPromise` catches the throw and surfaces it as a failed startup. The Dockerfile readiness flag (`/var/run/fro-bot/gateway-ready`) is never written, so the healthcheck stays red and docker compose reports the gateway unhealthy.
- **State lifecycle risks:** None. Pure startup-time config parsing.
- **API surface parity:** The `GatewayConfig` interface gains one field. External infra-as-code consumers (marcusrbrown/infra) gain one optional env var. No removals; no breaking changes.
- **Integration coverage:** The `main.ts` wiring change should not require an integration test — Unit 2's config tests + Unit 3's client tests verify both endpoints; the wiring between them is a one-line passthrough.
- **Unchanged invariants:** `readSecret` / `readOptionalSecret` signatures stay. The `${NAME}_FILE` fallback pattern stays. `createDiscordClient`'s function signature is unchanged — the new behavior comes from the smaller `DEFAULT_INTENTS` interacting with the existing merge logic.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Existing deployments that need the privileged intents (if any) break silently after upgrading. | Document the `DISCORD_PRIVILEGED_INTENTS` knob in the PR body, `deploy/README.md` (already touched in this branch arc), and `packages/gateway/AGENTS.md`. Existing operators who need the privileged set must set the env var on the next deploy. |
| Operator typo in the env var (e.g., `MesageContent`) causes a fail-fast startup that's confusing. | Error message names the invalid token AND lists the allowed values, so the operator can self-diagnose without reading code. |
| The `beforeAll` token guard could block legitimate dev work if the developer has `DISCORD_TOKEN` set in their shell. | Accept this — the whole point of the guard is to surface that exact case. Developers running gateway tests are expected to unset the var or use a `test-token-fake` placeholder. The error message tells them what to do. |
| Discord changes the privileged-intent list in a future API version (e.g., adds a new privileged intent). | Out of scope. The allowlist in this plan is the right shape to extend — adding a new privileged intent is a one-line addition to `ALLOWED_PRIVILEGED_INTENTS` when needed. |

## Documentation / Operational Notes

- `packages/gateway/AGENTS.md` documents the new env var (Unit 3).
- The PR body should note that this is an opt-in flip: existing operators relying on the privileged set need to set `DISCORD_PRIVILEGED_INTENTS=MessageContent,GuildMembers` on their next deploy.
- The `deploy/README.md` operator setup doc (already part of the v0.44.x deploy contract work) does NOT need an update in this PR — the env var is documented in `packages/gateway/AGENTS.md` (the canonical knob reference). If a future PR adds a "configuration reference" section to `deploy/README.md`, the knob can be cross-referenced there.
- No Dockerfile or compose.yaml changes. The env var flows through the existing `docker compose` env-passthrough; no new bind mounts are needed (operators set it via `.env` or shell env).

## Sources & References

- **Origin issue:** https://github.com/fro-bot/agent/issues/646
- **Related plan (dotfiles side):** [marcusrbrown/.dotfiles `2026-05-18-001-feat-discord-server-revival-plan.md`](https://github.com/marcusrbrown/.dotfiles/blob/main/docs/plans/2026-05-18-001-feat-discord-server-revival-plan.md) (Unit 9, cross-repo handoff)
- **Mirror runbook:** [marcusrbrown/.dotfiles `discord-permission-drift-check.md`](https://github.com/marcusrbrown/.dotfiles/blob/main/docs/runbooks/discord-permission-drift-check.md)
- **Related code:** `packages/gateway/src/discord/client.ts`, `packages/gateway/src/config.ts`, `packages/gateway/src/main.ts`, `packages/gateway/AGENTS.md`
- **Pattern precedent:** `docs/solutions/workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md` (default posture flip)
- **discord.js GatewayIntentBits reference:** `node_modules/discord.js/typings/index.d.ts` (canonical names)
