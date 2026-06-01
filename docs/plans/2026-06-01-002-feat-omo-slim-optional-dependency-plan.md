---
title: 'feat: OMO Slim as an optional dependency'
type: feat
status: active
date: 2026-06-01
origin: docs/brainstorms/2026-06-01-omo-slim-optional-dependency-requirements.md
---

# feat: OMO Slim as an optional dependency

## Overview

Add OMO Slim (`oh-my-opencode-slim`) as an optional, mutually-exclusive alternative to OMO on the action/setup side: `enable-omo-slim` + `omo-slim-preset` + `omo-slim-version` inputs, a pinned `DEFAULT_OMO_SLIM_VERSION` with Renovate tracking, a Bun installer that applies the selected preset, and CI `opencode.json` assembly that registers the Slim plugin and pins `default_agent: 'orchestrator'`. The gateway→workspace preset passthrough is documented as a Unit-7-gated follow-on and is **not** built here.

## Problem Frame

The only optional orchestration plugin wired into the harness is OMO (`oh-my-openagent`), via `enable-omo`/`omo-providers`/`omo-version`. OMO Slim is a preset-based orchestration fork some users prefer, but there is no supported way to opt into it — hand-editing `opencode.json` is overwritten by setup. OMO and Slim both own the `opencode.json` plugin array and agent routing, so they cannot coexist (see origin).

## Requirements Trace

Implements R1-R12, R16-R20 from the origin requirements doc. R13-R15 (gateway passthrough) are explicitly deferred (see Scope Boundaries → Deferred to Separate Tasks).

- R1-R4: action inputs + mutual exclusivity → Unit 2
- R5-R6: version constant + Renovate → Unit 1
- R7-R9: install + preset + status → Unit 3
- R10-R12, R19-R20: CI config assembly, orchestrator default, mode-authoritative plugins, compat + permission posture → Unit 4
- R16: input parsing + warnings → Unit 2
- R17-R18: tests + CI introspection → Unit 5

## Scope Boundaries

- Not deprecating/removing OMO; Slim is additive and mutually exclusive.
- Not running OMO and Slim together; relationship is fail-fast mutual exclusion.
- Not authoring Slim's preset definitions; only selecting `openai` / `opencode-go`.
- Not exposing Slim's broader features (council, multiplexer, subtask) as inputs.

### Deferred to Separate Tasks

- **Gateway → workspace preset passthrough (R13-R15), gated on Unit 7.** The workspace container is a placeholder today (`deploy/workspace.Dockerfile` = `sleep infinity`, no OpenCode; workspace client only does `POST /clone`). When Unit 7 ships the real workspace OpenCode image, add: an optional gateway preset env var in `packages/gateway/src/config.ts` (allowlist-validated against known preset names — no free-string passthrough across the container boundary), passthrough to the workspace OpenCode as `OH_MY_OPENCODE_SLIM_PRESET`, and `deploy/compose.yaml` + `deploy/README.md` wiring via the optional-secret `_FILE` convention. Tracked here so it is not lost.

## Context & Research

### Relevant Code and Patterns

- `src/shared/constants.ts` — `DEFAULT_OMO_VERSION`, `DEFAULT_OMO_PROVIDERS`, `DEFAULT_SYSTEMATIC_VERSION` (the constant pattern to mirror).
- `src/services/setup/omo.ts` — `installOmo(version, {logger, execAdapter}, providers)`: `bunx oh-my-openagent@${version} ...`, config-file verification. Mirror for `installOmoSlim`.
- `src/services/setup/setup.ts:105-223` — the `enableOmo` branch: install, telemetry exports, `omoStatus`, CI-config build, merge/write `opencode.json`.
- `src/services/setup/ci-config.ts` — `buildCIConfig`, `stripOmoPlugins`, `pluginPrefix`, disabled-mode `default_agent: 'build'` + `external_directory: deny`.
- `src/harness/config/inputs.ts:70-141,188-393` — `parseOmoProviders`, `parseActionInputs`, disabled-mode warnings.
- `src/shared/types.ts` — `SetupInputs`, `SetupResult` (`omoStatus`/`omoError`), `ActionInputs`.
- `action.yaml:60-89` — `enable-omo`/`omo-version`/`omo-providers` inputs.
- `.github/renovate.json5:9-80` — OMO customManager + packageRule.
- `.github/workflows/ci.yaml:172-220` — disabled-mode introspection assertions.

### External / Clone Findings (`.slim/clonedeps/repos/alvinunreal__oh-my-opencode-slim`, v1.1.1)

- Install: `bunx oh-my-opencode-slim@{version} install --preset=<name>` (`src/cli/index.ts:18-26,45-61`); default preset `openai`; validated names `openai`, `opencode-go` via `getGeneratedPresetNames()`.
- Config file: `~/.config/opencode/oh-my-opencode-slim.json[c]`; registers `oh-my-opencode-slim` in the `plugin` array (`config-manager.ts:345-380`).
- Preset env override: `OH_MY_OPENCODE_SLIM_PRESET` (`loader.ts:287-291`) — relevant to the deferred gateway path.
- Agent literal `orchestrator` (`constants.ts` `DEFAULT_MODELS`); `setDefaultAgent` option exists (`schema.ts:323`).
- No telemetry in source.

### Institutional Learnings

- `docs/solutions/` (OMO config-key + cache-restore): the `plugin` (singular) key + stale cache-restored entries caused real bugs — Unit 4 must rebuild the plugin array mode-authoritatively.

## Key Technical Decisions

- **Preset applied via install flag** `--preset=<name>` (resolved from clone), not env, on the action side. Default `openai` when `enable-omo-slim` is true and no preset given.
- **Mutual exclusivity = fail-fast at parse + a config-assembly guard** (defense-in-depth) so a cache-restored config cannot carry both plugins.
- **`default_agent: 'orchestrator'`** is set unconditionally and authoritatively by *our* config write in Slim mode (Slim's own installer does not write `default_agent`). R19 is a **version-gated allowlist check** — the pinned version is known-good for the `orchestrator` agent — not a runtime capability probe (there is no on-disk signal at setup time that proves OpenCode agent registration).
- **Permission posture (R20) — decided, not deferred:** Slim mode uses the **OMO-enabled posture** — it does **not** inject the disabled-mode `external_directory: deny`; the orchestrator agent gets the same operating access OMO's agent has, and Slim does not widen capabilities beyond what OMO-enabled mode already grants. The build-agent `external_directory: deny` remains applied **only** in the no-plugin disabled mode. There is no remaining open question about this posture.
- **Version pinned to stable `1.1.1`**, not the `2.0.0-beta` line.

## Open Questions

### Resolved During Planning

- Preset-apply mechanism (origin R8 deferral): `bunx oh-my-opencode-slim@{version} install --no-tui --reset --preset=<name>` — `--preset`/`--no-tui`/`--reset` confirmed in `src/cli/index.ts:14,18,29`.
- Slim permission posture (origin R12/R20 deferral): decided — OMO-enabled posture, no forced deny (see Key Decisions). Not deferred.
- Type-source location: `ActionInputs` lives in `packages/runtime/src/shared/types.ts` and `SetupInputs` in `src/services/setup/types.ts`; `src/shared/types.ts` only re-exports. Unit 2 targets the runtime/services types, not the re-export.
- R19 form: a version-gated allowlist check (pinned version known-good for `orchestrator`), not a runtime probe.

### Deferred to Implementation

- Exact `installOmoSlim` config-file verification path (`oh-my-opencode-slim.json` presence) — confirm filename casing against the clone during implementation.
- Whether `omo-slim-preset` should validate against the known preset names at parse time or pass through to the installer's own validation (lean: validate at parse for a clear early error).

## Implementation Units

- [ ] **Unit 1: Version constant + Renovate tracking**

**Goal:** Single-source-of-truth pinned Slim version with Renovate updates.

**Requirements:** R5, R6

**Dependencies:** None

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `.github/renovate.json5`
- Test: `src/shared/constants.test.ts` (if version constants are asserted there)

**Approach:**
- Add `DEFAULT_OMO_SLIM_VERSION = '1.1.1'` (semver, no `v`).
- Add a Renovate `customManagers` regex entry matching `DEFAULT_OMO_SLIM_VERSION = '(?<currentValue>...)'` on the `npm` datasource for `oh-my-opencode-slim`, plus a `packageRules` entry with `semanticCommitType: 'build'`. Mirror the OMO entry exactly.

**Patterns to follow:** the OMO `DEFAULT_OMO_VERSION` constant + its renovate.json5 customManager/packageRule.

**Test scenarios:**
- Happy path: a test (or existing constants assertion) references `DEFAULT_OMO_SLIM_VERSION` rather than a hardcoded literal.
- Test expectation: Renovate config is not unit-tested; verify by inspection that the regex matches the constant line.

**Verification:** `grep` finds no duplicate `1.1.1` literal elsewhere; Renovate regex matches the constant; `pnpm build` clean.

- [ ] **Unit 2: Action inputs, parsing, mutual exclusivity, warnings**

**Goal:** Expose `enable-omo-slim` / `omo-slim-preset` / `omo-slim-version`; parse into `ActionInputs`; enforce mutual exclusion with `enable-omo`; warn on disabled-mode usage.

**Requirements:** R1, R2, R3, R4, R16

**Dependencies:** Unit 1

**Files:**
- Modify: `action.yaml`
- Modify: `src/harness/config/inputs.ts`
- Modify: `packages/runtime/src/shared/types.ts` (`ActionInputs` — authoritative; `src/shared/types.ts` only re-exports)
- Modify: `src/services/setup/types.ts` (`SetupInputs`); `packages/runtime/src/agent/setup-adapter.ts` if it mirrors the shape
- Test: `src/harness/config/inputs.test.ts`

**Approach:**
- `action.yaml`: add the three inputs; `enable-omo-slim` default `'false'`; NO hardcoded default for version (falls through to constant per versioned-tool).
- `inputs.ts`: parse `enableOmoSlim`, `omoSlimPreset`, `omoSlimVersion` (fallback `DEFAULT_OMO_SLIM_VERSION`). **Mandatory** preset validation: `omo-slim-preset` must be one of `{openai, opencode-go}` — reject anything else with a clear early error so only a validated union value reaches the installer `--preset=` argv in Unit 3 (never a raw string). Mutual-exclusion check: if both `enable-omo` and `enable-omo-slim` are true → fail via the existing `parseActionInputs` failure path (confirm it returns a Result / uses `core.setFailed` rather than throwing). Add disabled-mode warnings parallel to OMO.
- `types.ts`: extend `ActionInputs`/`SetupInputs` with the slim fields.

**Patterns to follow:** `parseOmoProviders`, the OMO disabled-mode warning block, `SetupInputs` shape.

**Test scenarios:**
- Happy path: `enable-omo-slim: true` + `omo-slim-preset: openai` → parsed inputs carry the values; version falls back to constant.
- Error path: both `enable-omo` and `enable-omo-slim` true → parse fails with a conflict error (AE1).
- Edge case: `enable-omo-slim: false` + `omo-slim-preset` set → warning emitted, preset ignored (AE3).
- Error path: unknown preset name (e.g. `bogus`) → mandatory hard validation error at parse time; the value never reaches the installer argv.
- Edge case: `omo-slim-version` omitted → equals `DEFAULT_OMO_SLIM_VERSION`.

**Verification:** inputs.test.ts green; mutual-exclusion + warnings covered.

- [ ] **Unit 3: Slim installer**

**Goal:** Install Slim via Bun at the resolved version with the selected preset; report status.

**Requirements:** R7, R8, R9

**Dependencies:** Unit 1, Unit 2

**Files:**
- Create: `src/services/setup/omo-slim.ts`
- Modify: `src/services/setup/setup.ts`
- Modify: `src/shared/types.ts` (SetupResult slim status)
- Test: `src/services/setup/omo-slim.test.ts`, `src/services/setup/setup.test.ts`

**Approach:**
- `installOmoSlim(version, {logger, execAdapter}, preset)`: run `bunx oh-my-opencode-slim@${version} install --no-tui --reset --preset=${preset}` (default `openai`). `--no-tui` = non-interactive CI; `--reset` = overwrite a cache-restored stale Slim config so the preset re-applies. `preset` is the validated union from Unit 2 (never a raw string); args passed as an array to `execAdapter.exec` (no shell interpolation). No telemetry env exports (Slim has none). Verify `~/.config/opencode/oh-my-opencode-slim.json` exists post-install (mirror `installOmo`). Return `{installed, version, error}`.
- `setup.ts`: add an `enableOmoSlim` branch mirroring the OMO branch — call `installBun()` then `installOmoSlim()`, set a slim status field. The branch is mutually exclusive with OMO (guaranteed upstream by Unit 2, but the branch structure is either/or).
- `SetupResult`: add `omoSlimStatus: 'installed' | 'failed' | 'skipped'` + `omoSlimError`.

**Patterns to follow:** `src/services/setup/omo.ts` install + verify; the `setup.ts` enableOmo branch.

**Execution note:** Install behavior is exec-adapter-driven; write tests against a mocked `execAdapter` first (test-first for the command shape + preset flag).

**Test scenarios:**
- Happy path: install invoked with `bunx oh-my-opencode-slim@1.1.1 install --no-tui --reset --preset=openai`; returns installed.
- Edge case: preset omitted → defaults to `openai` in the command.
- Error path: bunx non-zero exit → `{installed:false, error}` with a clear message.
- Error path: config file missing post-install → failure status.

**Verification:** installer + setup tests green; command/preset asserted against the mocked adapter.

- [ ] **Unit 4: CI config assembly (orchestrator default, mode-authoritative plugins, guards)**

**Goal:** When Slim is enabled, register the Slim plugin and pin `default_agent: 'orchestrator'`; rebuild the plugin array mode-authoritatively; refuse a both-plugins config; verify orchestrator presence; set the Slim permission posture.

**Requirements:** R10, R11, R12, R19, R20

**Dependencies:** Unit 3

**Files:**
- Modify: `src/services/setup/ci-config.ts`
- Modify: `src/services/setup/setup.ts` (merge/write path for slim mode)
- Test: `src/services/setup/ci-config.test.ts`, `src/services/setup/setup.test.ts`

**Approach:**
- `buildCIConfig`: add a Slim mode. Mode-authoritative plugin assembly — rebuild `plugin` from scratch for the active mode (Systematic always; `oh-my-opencode-slim@${version}` in slim mode; OMO only in OMO mode; none in disabled). Add `stripOmoSlimPlugins` parallel to `stripOmoPlugins` for the non-slim paths.
- Slim mode: write the config via the **authoritative fresh-write path** (mirror disabled-mode `setup.ts:218`, NOT the OMO append-merge at `setup.ts:205`) so cache-restored stale `plugin`/`default_agent` keys are overwritten. Unconditionally set `default_agent: 'orchestrator'` (load-bearing — do not rely on the plugin to self-correct a stale value). Do NOT apply `external_directory: deny` (OMO-enabled posture per Key Decisions).
- Dual-plugin guard: if the assembled config would contain both `oh-my-openagent` and `oh-my-opencode-slim`, fail closed (defense-in-depth behind Unit 2's parse guard).
- Orchestrator compat (R19): a **version-gated allowlist check** — assert the resolved Slim version is in a known-good set verified to register `orchestrator` (pinned `1.1.1` is in it); fail closed with a versioned compat error otherwise. Do NOT attempt a runtime/config-file probe of the agent set (no reliable on-disk signal at setup time).

**Patterns to follow:** `stripOmoPlugins`, `pluginPrefix`, `denyBuildExternalDirectoryPermission`, the existing enabled/disabled `buildCIConfig` branches.

**Test scenarios:**
- Happy path: slim mode → config has `oh-my-opencode-slim@1.1.1` plugin + `default_agent: 'orchestrator'`, no OMO, one `@fro.bot/systematic` (AE2).
- Edge case (cache-restore): config pre-seeded with `oh-my-openagent` → slim-mode assembly produces NO OMO entry (AE5); flip to disabled → neither plugin.
- Error path: assembled config with both plugins → fail closed.
- Error path (R19): installed Slim lacks `orchestrator` → versioned compat error, no broken config written.
- Edge case (R20): slim mode does not set `external_directory: deny`; disabled mode still does.

**Verification:** ci-config + setup tests green; cache-restore flip scenario covered.

- [ ] **Unit 5: Tests + CI introspection**

**Goal:** Round out coverage and add disabled/enabled Slim introspection to the Test GitHub Action job.

**Requirements:** R17, R18

**Dependencies:** Units 2-4

**Files:**
- Modify: `.github/workflows/ci.yaml`
- Modify: existing test suites as needed (`setup.test.ts`, `ci-config.test.ts`, `inputs.test.ts`)

**Approach:**
- Slim config assembly is covered by the Units 2-4 unit tests (`ci-config.test.ts` slim mode, `omo-slim.test.ts`, `setup.test.ts` slim cases): `default_agent == "orchestrator"`, `oh-my-opencode-slim` plugin present, exactly one `@fro.bot/systematic`, OMO absent, legacy `plugins` key stripped, dual-plugin and R19 guards.
- No dedicated CI job: a `workflow_dispatch`-only job surfaces as a perpetually-skipped check on every PR. Slim mode can be exercised on demand via the existing `fro-bot.yaml` dispatch when a live install smoke is wanted.

**Test scenarios:**
- Covered by Units 2-4 unit tests.

**Verification:** full suite green; `pnpm build` clean; `dist/` in sync; a Test GitHub Action run shows the slim introspection passing.

- [ ] **Unit 6: Documentation**

**Goal:** Surface the new inputs and the pinned default.

**Requirements:** none owned (documentation only — supports R1-R10 surfaced by other units)

**Dependencies:** Units 1-4

**Files:**
- Modify: `README.md` (input table), `action.yaml` (input descriptions), `src/services/setup/AGENTS.md` if the pattern note warrants.

**Approach:** Document `enable-omo-slim` / `omo-slim-preset` / `omo-slim-version`, the mutual-exclusivity-with-OMO note, and that Slim pins the orchestrator default. Note the deferred gateway passthrough as Unit-7-gated.

**Test scenarios:** Test expectation: none — docs only.

**Verification:** docs reflect the inputs + pinned version; no stale version literal.

## System-Wide Impact

- **Interaction graph:** `parseActionInputs` → `runSetup` (slim branch) → `buildCIConfig` (slim mode) → `opencode.json`. Mirrors the OMO chain.
- **Mode matrix:** the harness now has three setup modes (disabled/build, OMO, Slim) — every future OpenCode/plugin change must be reasoned across all three (acknowledged carrying cost from the brainstorm).
- **Cache interaction (authoritative write):** tools-cache restores `~/.config/opencode/opencode.json`. The existing OMO-enabled path appends to the restored `plugin` array and spreads existing keys (`setup.ts:205`: `{...existingConfig, ...ciConfig, plugin: [...existingPlugins, ...]}`), which would let a stale `oh-my-openagent`/duplicate plugin or a stale `default_agent` survive. Slim mode must write the config authoritatively (the disabled-mode fresh-write path, `setup.ts:218`), not append-merge — so stale plugins and a stale `default_agent: 'build'` are overwritten, not preserved.
- **Build impact:** changes are in `src/` (action tier) → `dist/` rebuild + commit required.
- **Unchanged invariants:** OMO behavior, disabled/build-agent mode, and `@fro.bot/systematic` injection are unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Stale plugin survives cache restore across mode flips | Mode-authoritative plugin rebuild + cache-restore acceptance test (Unit 4 / AE5) |
| `default_agent: orchestrator` pinned but agent absent in installed Slim | R19 compat verification before writing config |
| Both plugins smuggled via merged/cached config | Parse-time guard (Unit 2) + config-assembly fail-closed guard (Unit 4) |
| Preset non-functional without provider credentials | Documented premise (brainstorm); out of integration scope |
| Pinned 1.1.1 vs 2.0.0-beta schema drift | Version pinned to verified-stable; Renovate PRs reviewed; R19 guards agent-name drift |

## Documentation / Operational Notes

- README input table + action.yaml descriptions updated (Unit 6).
- Gateway passthrough deferred to Unit 7 — tracked in Scope Boundaries; revisit when the workspace OpenCode image lands.

## Sources & References

- Origin: docs/brainstorms/2026-06-01-omo-slim-optional-dependency-requirements.md
- Clone: .slim/clonedeps/repos/alvinunreal__oh-my-opencode-slim (v1.1.1)
- Pattern refs: src/services/setup/omo.ts, ci-config.ts, src/harness/config/inputs.ts
- versioned-tool skill conventions
