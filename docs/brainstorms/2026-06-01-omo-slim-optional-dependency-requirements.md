---
date: 2026-06-01
topic: omo-slim-optional-dependency
---

# OMO Slim as an Optional Dependency

## Summary

Add **OMO Slim** (`oh-my-opencode-slim`) as an optional, mutually-exclusive alternative to OMO: an `enable-omo-slim` action input with a single `omo-slim-preset` selector and a pinned `omo-slim-version`, plus the version-constant + Renovate tracking that every external tool in this repo uses. When OMO Slim is enabled, the CI OpenCode config pins `default_agent` to `orchestrator`. A gateway preset passthrough is planned but **deferred until the workspace container runs OpenCode (Unit 7)** — see Scope Boundaries.

---

## Problem Frame

The only optional agent-orchestration plugin wired into the harness today is **OMO** (`oh-my-openagent`), configured action-side via `enable-omo` + `omo-providers` + `omo-version`. OMO Slim is a separate, preset-based orchestration fork of oh-my-opencode that some users prefer: it selects a whole agent/model bundle by a single preset name, is orchestrator-centric, and ships no telemetry. There is currently no way to opt into Slim instead of OMO, and the gateway — which drives OpenCode inside the sandboxed workspace container for mention-loop runs — has no way to select a Slim preset for those runs. Users who want Slim must hand-edit `opencode.json`, which the setup step then overwrites. (Selecting a Slim preset for gateway-driven mention-loop runs is a related need, but the workspace container does not run OpenCode yet — so that piece is deferred to Unit 7.)

---

## Actors

- A1. Action / CI caller: sets `enable-omo-slim` + `omo-slim-preset` in a workflow that uses the action.
- A2. Gateway operator: sets the preset env var in `deploy/compose.yaml` so workspace-container OpenCode runs use a chosen Slim preset. *(Applies only to the deferred Unit-7 gateway path.)*
- A3. OMO Slim plugin (`oh-my-opencode-slim`): the installed orchestration plugin, registered in `opencode.json`'s `plugin` array, owning agent routing and the `orchestrator` default agent.
- A4. OMO plugin (`oh-my-openagent`): the mutually-exclusive incumbent that owns the same plugin/agent surface.

---

## Key Flows

- F1. CI run with OMO Slim
  - **Trigger:** A workflow sets `enable-omo-slim: true`, optionally `omo-slim-preset: openai`.
  - **Actors:** A1, A3
  - **Steps:** Inputs parsed → mutual-exclusivity check passes (OMO not enabled) → Slim installed via Bun at the pinned version → CI `opencode.json` registers the Slim plugin and pins `default_agent: orchestrator` → the chosen preset is applied → OpenCode runs driven by Slim.
  - **Outcome:** OpenCode executes under Slim's orchestrator with the selected preset; OMO is not installed.
  - **Covered by:** R1, R2, R3, R4, R7, R8, R10

- F2. *(Deferred — gated on Unit 7.)* Gateway mention-loop preset passthrough: the gateway reads the preset env var and passes it to the workspace OpenCode as `OH_MY_OPENCODE_SLIM_PRESET`. Not buildable until the workspace container runs OpenCode — see Scope Boundaries → Deferred to Separate Tasks.

---

## Requirements

**Action inputs & mutual exclusivity**
- R1. Add action input `enable-omo-slim` (boolean, default `false`), mirroring `enable-omo`.
- R2. Add action input `omo-slim-preset` (optional, single preset name such as `openai` or `opencode-go`) — the Slim analog of `omo-providers`. It is a single name, not a comma-separated list, because Slim selects exactly one preset.
- R3. Add action input `omo-slim-version` (optional; no hardcoded default in `action.yaml` — falls through to the pinned constant).
- R4. `enable-omo` and `enable-omo-slim` are mutually exclusive. Enabling both fails fast at input parse time with a clear, actionable error; the harness does not silently choose one. Defense-in-depth: CI config assembly also refuses to emit an `opencode.json` containing both plugins (a second fail-closed guard), so a cache-restored or externally-merged config cannot smuggle both in.

**Version pinning (versioned-tool pattern)**
- R5. Add `DEFAULT_OMO_SLIM_VERSION` to `src/shared/constants.ts` as the single source of truth (semver string, no `v` prefix), pinned to a stable release (Slim's latest stable is `1.1.1`; `2.0.0-beta.*` are prereleases and are not the default).
- R6. Add a Renovate `customManagers` regex entry + `packageRules` entry tracking `oh-my-opencode-slim` on the `npm` datasource with `semanticCommitType: build`, matching the existing OMO/Systematic pattern.

**Setup / install**
- R7. When `enable-omo-slim` is true, install Slim via Bun at the resolved version (analogous to `installOmo`). No telemetry opt-out env vars are exported — Slim ships no telemetry (verified in source).
- R8. The selected preset is applied so it is active for the run (mechanism — install flag, config key, or `OH_MY_OPENCODE_SLIM_PRESET` — deferred to planning).
- R9. `SetupResult` reports an OMO-Slim status (`installed` | `failed` | `skipped`) and error, parallel to `omoStatus`/`omoError`.

**CI config (`opencode.json`) assembly**
- R10. When `enable-omo-slim` is true, `buildCIConfig` registers the Slim plugin (`oh-my-opencode-slim@{version}`) in the `plugin` array and pins `default_agent: 'orchestrator'`.
- R11. The `@fro.bot/systematic` plugin continues to be injected in all modes. Existing behavior is unchanged when neither OMO nor Slim is enabled (build-agent default).
- R12. Plugin assembly is mode-authoritative: after cache restore, the `plugin` array is rebuilt for the active mode rather than appended to, then exactly the allowed plugins are added (Systematic always; OMO only in OMO mode; Slim only in Slim mode). This prevents a stale plugin entry from a prior run on a flipped flag surviving across mode switches — the same cache-restore + plugin-key class of bug the repo has hit before.

**Input parsing & warnings**
- R16. `inputs.ts` parses the three inputs into `ActionInputs`, warns when `omo-slim-preset` or a non-default `omo-slim-version` is provided while `enable-omo-slim` is false (parallel to the OMO warnings), and enforces R4.

**Compatibility & permissions**
- R19. Before pinning `default_agent: 'orchestrator'`, the setup step verifies the installed Slim version actually exposes the `orchestrator` agent; if it does not (e.g. a future Slim whose agent set changed), it fails with a versioned compatibility error rather than writing a config that breaks OpenCode startup. The pinned version (R5) is verified to expose `orchestrator` and the documented config schema.
- R20. The agent permission posture under Slim mode is explicitly defined (not deferred): state whether Slim's orchestrator inherits the disabled-mode `external_directory: deny` posture, a narrower orchestrator-specific policy, or another allowlist — with a fail-closed default if it cannot be determined at setup time.

**Tests & CI introspection**
- R17. Test coverage parallels OMO: setup, CI-config, and input-parsing suites plus a Slim installer test — asserting mutual-exclusivity failure, the `orchestrator` default, plugin registration and stripping, and version pinning.
- R18. CI introspection asserts the Slim mode (`default_agent == "orchestrator"`, Slim plugin present, exactly one `@fro.bot/systematic`, OMO absent) and disabled-mode Slim plugin/config-file absence.

---

## Acceptance Examples

- AE1. **Covers R4.** Given a workflow with both `enable-omo: true` and `enable-omo-slim: true`, when the action parses inputs, it fails fast with an error naming the conflict and exits without installing either plugin.
- AE2. **Covers R10, R7.** Given `enable-omo-slim: true` and `omo-slim-preset: openai`, when setup completes, the written `opencode.json` contains the `oh-my-opencode-slim` plugin and `default_agent: "orchestrator"`, and OMO is not installed.
- AE3. **Covers R16.** Given `enable-omo-slim: false` but `omo-slim-preset: openai` is supplied, when the action parses inputs, it emits a warning that the preset is ignored because OMO Slim is disabled.
- AE5. **Covers R12.** Given a prior OMO run left `oh-my-openagent` in a cache-restored `opencode.json`, when a subsequent run sets `enable-omo-slim: true`, the written config contains the Slim plugin and `orchestrator` default and contains NO `oh-my-openagent` entry. Flipping back to a disabled run leaves neither plugin.

---

## Success Criteria

- A workflow can set `enable-omo-slim: true` + `omo-slim-preset: openai` and get an OpenCode run driven by Slim's orchestrator with that preset, with OMO not installed.
- Enabling both OMO and OMO Slim fails with a clear, actionable error rather than silent precedence.
- Renovate opens PRs that bump `DEFAULT_OMO_SLIM_VERSION`.
- `ce:plan` can sequence the implementation without inventing product behavior, scope, or success criteria.

---

## Scope Boundaries

- Not deprecating or removing OMO — Slim is an additive, alternative option.
- Not building machinery to run OMO and Slim simultaneously — they conflict over plugin/agent ownership, so the relationship is mutual exclusion.
- Not authoring or customizing Slim's internal preset definitions — only selecting among Slim's existing presets.
- Not exposing Slim's broader features (council, multiplexer, subtask, interview, etc.) as action inputs — only enable + preset + version.
- Not changing how OMO itself works.

### Deferred to Separate Tasks (gated on Unit 7)

The gateway → workspace preset passthrough is **not buildable until Unit 7 ships the real workspace OpenCode image** — today `deploy/workspace.Dockerfile` is a placeholder idle container (`sleep infinity`, no OpenCode) and the workspace client only does `POST /clone`, so there is no workspace OpenCode process to inject env into. When Unit 7 lands, implement:

- R13. *(deferred)* The gateway reads an optional preset env var in `packages/gateway/src/config.ts` via the existing optional-secret/env pattern (as `DISCORD_PRIVILEGED_INTENTS` does), defaulting to unset.
- R14. *(deferred)* The gateway passes the preset value through to the workspace OpenCode as `OH_MY_OPENCODE_SLIM_PRESET`, with **allowlist validation of known preset names** (reject unknown values; no free-string passthrough across the container boundary).
- R15. *(deferred)* `deploy/compose.yaml` and `deploy/README.md` surface the env var using the optional-secret `_FILE` convention and document the migration step.

---

## Key Decisions

- Mutually exclusive with fail-fast on both-enabled: research confirmed Slim and OMO both own the `opencode.json` plugin array and agent routing, so coexistence would require conflict-resolution machinery with no clear payoff.
- `default_agent: 'orchestrator'` when Slim is enabled: matches Slim's orchestrator-centric design (the `orchestrator` agent is its primary entry; Slim supports a `setDefaultAgent` option) and parallels our existing pattern of pinning `default_agent` per mode (`build` when disabled).
- Single `omo-slim-preset` name, not a comma-list: Slim selects exactly one preset, unlike OMO's multi-provider list. The user-facing wording "presets" maps to choosing one preset by name.
- Gateway env var = workspace preset passthrough, **deferred to Unit 7**: OMO is action-only and never touched the gateway. Slim would run inside the workspace container (the mention loop), so the gateway env var would select the preset there via Slim's native `OH_MY_OPENCODE_SLIM_PRESET` — but the workspace container does not run OpenCode yet, so this is gated on Unit 7 (see Deferred to Separate Tasks).
- No telemetry env exports: Slim ships no telemetry, so the OMO telemetry opt-out knobs have no analog.
- Pin a stable version (`1.1.1`), not the `2.0.0-beta` prerelease line.

---

## Dependencies / Assumptions

- Source inspected at `.slim/clonedeps/repos/alvinunreal__oh-my-opencode-slim` (v1.1.1; latest remote tag `2.0.0-beta.13`). Install: `bunx oh-my-opencode-slim@{version} install`; config file `~/.config/opencode/oh-my-opencode-slim.json[c]`; preset env `OH_MY_OPENCODE_SLIM_PRESET`; built-in presets `openai`, `opencode-go`; agent literal `orchestrator`.
- The gateway preset passthrough depends on the workspace container running OpenCode with Slim available — which does not exist until Unit 7. This dependency is why R13-R15 are deferred.
- Bun is already an install dependency for the OMO path and is reused for Slim.
- **Preset credentials**: Slim's built-in presets (`openai`, `opencode-go`) select provider-specific models (e.g. `openai/gpt-5.5`). They are non-functional without the corresponding provider credentials, which the harness does not provide in its default free-model posture. Selecting a preset therefore assumes the caller supplies the needed provider auth; this is a premise of the feature, not something the integration provides.
- **Install/preset contract** (R7/R8): the install surface is Slim's own `bunx oh-my-opencode-slim@{version} install`, and preset application uses Slim's documented mechanism (install flag / config `preset` key / `OH_MY_OPENCODE_SLIM_PRESET` env) confirmed against the clone during planning — not OMO's provider/telemetry pattern.
- **Supply chain**: Slim is fetched and executed via `bunx` at setup time, the same posture as the existing OMO path (version-pinned, no artifact-hash verification) — an accepted, pre-existing risk shared with OMO.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R8][Needs research] Exact mechanism to apply the selected preset during CI install — install `--preset` flag vs config key vs exporting `OH_MY_OPENCODE_SLIM_PRESET`. Confirm against the clone's `install.ts`/`loader.ts`.
- [Affects R13-R15][Deferred to Unit 7] Exact gateway env var name (`GATEWAY_OMO_SLIM_PRESET` vs direct `OH_MY_OPENCODE_SLIM_PRESET`), and how the preset env reaches the workspace OpenCode process across the container boundary — resolved when the passthrough is built atop the Unit 7 workspace runtime. Allowlist validation is already mandated in R14 (deferred).
- [Affects R12][Technical] Whether Slim's CI config needs the same `external_directory: deny` / permission handling that OMO-disabled mode applies, or a different policy under the orchestrator default.
