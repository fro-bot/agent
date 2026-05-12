---
title: "feat: Disable oMo by default"
type: feat
status: completed
date: 2026-04-30
completed: 2026-05-09
origin: docs/brainstorms/2026-04-29-disable-omo-by-default-requirements.md
---

# feat: Disable oMo by default

## Overview

Fro Bot should stop installing and wiring Oh My OpenAgent by default. The action should use OpenCode's built-in `build` agent unless a caller explicitly supplies another `agent` value. Supplying `agent` only changes the SDK request; oMo-provided agents such as `sisyphus` still require `enable-omo: true`. This turns today's half-implicit behavior into a public contract: no default `sisyphus`, no default Bun/oMo install, and no stale oMo config resurrected from cache.

This plan is based on the local brainstorm at `docs/brainstorms/2026-04-29-disable-omo-by-default-requirements.md`. That file is intentionally gitignored, so the plan carries forward the decisions needed for implementation.

## Problem Frame

The action currently advertises `agent: sisyphus` and installs oMo on every auto-setup path, even though production SDK calls often omit `body.agent` and therefore already fall through to OpenCode's `build` agent. That mismatch costs cold-start time, increases third-party plugin coupling, and makes the public action contract harder to reason about.

The desired outcome is boring and explicit: oMo remains supported, but it is an opt-in mode. Disabled mode must be strong enough to resist stale cached `opencode.json` files and stale caller config that still references `sisyphus` or `oh-my-openagent`.

Evidence carried forward from the origin brainstorm:

- Current public docs advertise `agent: sisyphus`, while current SDK request construction can omit `body.agent` and let OpenCode resolve `build`.
- Current setup installs Bun and runs the oMo installer on the default setup path, adding avoidable cold-start work for callers that only need OpenCode.
- Current tools cache includes mutable OpenCode config paths, so stale `default_agent` and plugin entries can reappear unless disabled mode actively isolates or overwrites them.

## Requirements Trace

Public inputs and migration:

- R1. Add `enable-omo` as a boolean action input with default `false`.
- R2. Remove the `agent` default from `action.yaml`; parsed inputs and execution config carry `agent: string | null`.
- R4. Emit clear migration warnings when disabled mode ignores or rewrites oMo-related inputs/config. Use one ignored-input warning for `omo-providers` and non-default `omo-version`, one agent warning for known oMo-provided `agent` names, and one config-rewrite warning for stripped oMo plugins or overridden `default_agent`.
- R6. Add `enable-omo: true` to this repo's dogfood workflow because it still passes `omo-providers` and should preserve the current oMo-agent path. Do not add `agent: sisyphus`; oMo configures Sisyphus as OpenCode's default when enabled.
- R7. Remove the dead public `omo-config` action input, `writeOmoConfig` wrapper, and input-specific tests inline with this change; extract or keep reusable merge helpers only if still used by setup internals or tests.

Runtime defaults:

- R0. Use OpenCode's built-in `build` agent as the default by omitting `body.agent` and pinning disabled-mode `default_agent` to `build` in generated config.
- R3. Preserve current model override precedence. Explicit `model` wins; disabled oMo with no model uses the existing `DEFAULT_MODEL` fallback.
- R5. Remove default `sisyphus` semantics from constants, logs, request construction, and default-oriented tests.

Disabled-mode hardening:

- R8. Write `default_agent: "build"` in generated OpenCode config when `enable-omo: false`, ignore existing local/restored `opencode.json`, and strip `oh-my-openagent` plugin entries from user `opencode-config` in disabled mode with an explicit rewrite warning.

## Scope Boundaries

- oMo support is not removed. It remains available when `enable-omo: true`.
- Existing known external callers are not migrated in this PR because the brainstorm found they do not use oMo inputs. General migration guidance and release notes are still required because some callers may rely on the previously advertised implicit Sisyphus default.
- oMo's internal doctor commands are not touched. This action does not expose them.
- No new dependency is added.
- No new action output is added for oMo status. Structured logs and summaries are enough unless implementation uncovers a concrete consumer need.

### Deferred to Separate Tasks

- Downstream workflow migration outside this repo: handle reactively only if a real external break appears.
- Future custom oMo config support: re-add a properly wired public input only if a caller needs it.

## Context & Research

### Relevant Code and Patterns

- `action.yaml` defines the public action inputs. It currently defaults `agent` to `sisyphus` and declares the unused public `omo-config` input.
- `src/harness/config/inputs.ts` parses action inputs and currently falls back to `DEFAULT_AGENT`, always parses `omo-providers`, and always resolves `omo-version` to `DEFAULT_OMO_VERSION`.
- `packages/runtime/src/shared/types.ts` contains canonical `ActionInputs`, `ModelConfig`, and `OmoProviders` types.
- `packages/runtime/src/agent/types.ts` contains canonical `ExecutionConfig` and `EnsureOpenCodeResult` types.
- `packages/runtime/src/agent/prompt-sender.ts` currently omits `body.agent` only when the configured agent equals `DEFAULT_AGENT`.
- `packages/runtime/src/agent/execution.ts` logs `DEFAULT_AGENT` when no agent is present.
- `packages/runtime/src/agent/server.ts` and `packages/runtime/src/agent/setup-adapter.ts` define the runtime auto-setup boundary.
- `src/features/agent/server-adapter.ts` mirrors the runtime setup boundary for the action harness.
- `src/services/setup/setup.ts` installs OpenCode, Bun, oMo, writes Systematic config, merges OpenCode config, and saves the tools cache.
- `src/services/setup/ci-config.ts` builds `OPENCODE_CONFIG_CONTENT` and injects the Systematic plugin.
- `src/services/setup/tools-cache.ts` currently includes `omoVersion` in the key and caches both Bun and `~/.config/opencode` on every setup path.
- `.github/workflows/fro-bot.yaml` currently passes `omo-providers` and must opt into oMo explicitly.
- `README.md` and `docs/wiki/` describe setup defaults and must stop presenting oMo/Sisyphus as the default path.
- `dist/**` contains committed build artifacts and must be regenerated after source changes.

### Institutional Learnings

- `docs/solutions/build-errors/tool-binary-caching-ephemeral-runners.md`: tools caches are best-effort, versioned, and separate from session caches. Cache misses are not failures.
- `docs/solutions/best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md`: versioned tool inputs must be threaded through `action.yaml`, parser types, setup types, config generation, tests, and `dist/`.
- `docs/solutions/workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md`: implicit runtime behavior should become explicit action-level contract when it affects callers.
- Runtime extraction moved canonical agent logic into `packages/runtime/src/agent/`; update runtime first and keep action-side wrappers aligned.

### External References

- No external research was needed for planning. The brainstorm already validated the OpenCode SDK contract and `build` agent behavior against current upstream docs/source.

## Key Technical Decisions

- `enable-omo` is the central mode flag. It is parsed once and threaded through setup/config/cache behavior instead of scattering independent `omo-*` checks.
- `omo-providers` is gated at the input layer. When oMo is disabled, raw provider text is ignored after the single warning, so invalid provider names do not fail disabled-mode runs.
- Disabled mode carries an explicit all-`no` `OmoProviders` value so existing model resolution remains simple and explicit.
- `agent` becomes `string | null`. `null` means omit `body.agent`; any non-null value is sent to the SDK. If disabled mode sees a known oMo-provided agent such as `sisyphus`, it should warn that the caller probably needs `enable-omo: true` unless they provide that agent through their own OpenCode config.
- `DEFAULT_AGENT` is removed. The new default contract is omission, not a magic string.
- Disabled-mode `default_agent: "build"` overrides user-provided `opencode-config.default_agent`. This intentionally protects callers from stale `sisyphus`; explicit `agent` remains the customization escape hatch.
- Disabled-mode config composition ignores existing local/restored `opencode.json`, filters both `plugin` and legacy `plugins` `oh-my-openagent` entries out of user `opencode-config`, injects Systematic, and applies `default_agent: "build"` after the user config merge.
- Enabled mode installs and registers oMo, and oMo configures Sisyphus as OpenCode's default. With `enable-omo: true` and unset `agent`, the SDK still omits `body.agent`; OpenCode resolves through the oMo-managed config. This repo's dogfood workflow only needs `enable-omo: true` to preserve current behavior.
- `systematic-config` writing is independent of Bun/oMo. A Bun or oMo skip/failure must not suppress Systematic config.
- Mode-specific config preparation runs even when OpenCode is already available and no tool install is needed. Tool availability and config generation are separate responsibilities.
- Tools cache is partitioned by mode. Disabled mode excludes Bun and `~/.config/opencode` paths to avoid stale oMo config leaks.
- `SetupResult` migrates from `omoInstalled: boolean` to `omoStatus: 'installed' | 'failed' | 'skipped'` so skipped-by-design is distinguishable from installer failure.
- R7 ships inline for the public action surface. Delete the input-specific `writeOmoConfig` wrapper if it has no production caller; keep or extract shared merge behavior only if setup internals still use it.

## Open Questions

### Resolved During Planning

- `omo-providers` parser scope: gate it at the input layer. Disabled mode ignores raw text after one warning; enabled mode validates as today.
- Tools cache partition: use an explicit mode component and disabled-mode path list. Enabled mode keeps oMo version and Bun/config paths; disabled mode omits them.
- `SetupResult.omoInstalled`: migrate to `omoStatus` instead of adding `omoSkipped`.
- R7 sequencing: remove the public `omo-config` input and input-specific wrapper inline with the public input contract change, but keep reusable setup helpers if still used.
- User config precedence: disabled-mode `default_agent: "build"` wins over `opencode-config.default_agent`, and disabled mode strips `oh-my-openagent` plugin entries from user `opencode-config` with a warning naming rewritten fields.

### Deferred to Implementation

- Exact helper names for all-`no` providers and mode-aware cache path construction: decide during implementation while keeping the behavior and tests from this plan.
- Whether shared merge behavior is still needed after removing `writeOmoConfig`: keep or extract the merge helper if tests or setup internals still use it; remove the input-specific wrapper if it becomes dead code.

## High-Level Technical Design

> This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

| Input state | Setup behavior | Config behavior | SDK prompt behavior | Cache behavior |
| --- | --- | --- | --- | --- |
| `enable-omo` unset or `false`, `agent` unset | Install/prepare OpenCode only; skip Bun/oMo | Fresh generated config includes Systematic and `default_agent: "build"`; no restored oMo plugin preservation | Omit `body.agent`; explicit model wins; otherwise use `DEFAULT_MODEL` | Disabled-mode key; cache OpenCode tool/cache paths only |
| `enable-omo: false`, `omo-version` or `omo-providers` set | Same disabled setup; emit one ignored-input warning naming ignored inputs | Same disabled config | Same disabled prompt behavior | Same disabled cache behavior |
| `enable-omo: false`, explicit `agent` | Same disabled setup; emit separate agent warning for known oMo-provided agent names | Same disabled config | Send `body.agent` with caller value | Same disabled cache behavior |
| `enable-omo: true`, `agent` unset | Preserve current Bun/oMo install and provider behavior | Preserve oMo plugin merge/normalization; do not pin `default_agent`; oMo-managed config selects Sisyphus by default | Omit `body.agent`; OpenCode resolves via oMo-managed default config | Enabled-mode key; include Bun and OpenCode config paths |
| `enable-omo: true`, `agent: sisyphus` | Preserve current Bun/oMo install and provider behavior | Preserve oMo plugin merge/normalization; do not pin `default_agent` | Send `body.agent: sisyphus` | Enabled-mode key; include Bun and OpenCode config paths |

## Implementation Units

- [x] **Unit 1: Public Input And Shared Contract**

**Goal:** Add the public `enable-omo` contract, remove default-agent and dead public `omo-config` surface, and update shared types so null agent/default-disabled mode is representable.

**Requirements:** R1, R2, R4, R5, R7

**Dependencies:** None

**Files:**

- Modify: `action.yaml`
- Modify: `src/harness/config/inputs.ts`
- Modify: `src/harness/config/inputs.test.ts`
- Modify: `packages/runtime/src/shared/types.ts`
- Modify: `packages/runtime/src/shared/constants.ts`
- Modify: `packages/runtime/src/agent/types.ts`
- Modify: `packages/runtime/src/agent/setup-adapter.ts`
- Modify: `packages/runtime/src/agent/server.ts`
- Modify: `src/features/agent/server-adapter.ts`
- Modify: `src/services/setup/types.ts`

**Approach:**

- Add `enable-omo` to `action.yaml` with default `false`.
- Remove `action.yaml`'s `agent` default and update the description so unset means OpenCode `build`.
- Remove the public `omo-config` input from `action.yaml`; remove action auto-setup plumbing and the input-specific `writeOmoConfig` wrapper where they are unreachable from parsed inputs.
- Parse `enable-omo` as a boolean and thread `enableOmo` through `ActionInputs`, `SetupInputs`, and runtime setup options.
- Parse `agent` as `string | null`; no fallback to a default agent constant.
- Remove `DEFAULT_AGENT` from runtime constants and any action-side re-export reliance.
- Add or centralize an all-`no` `OmoProviders` value for disabled mode.
- Gate `omo-providers` parsing behind `enableOmo === true`; disabled mode ignores invalid provider text after the warning.
- Emit one ignored-input `core.warning` in disabled mode when `omoVersionRaw.length > 0 && omoVersionRaw !== DEFAULT_OMO_VERSION` or `omoProvidersRaw.length > 0`.
- Emit a separate actionable warning when `enable-omo: false` and `agent` is a known oMo-provided agent such as `sisyphus`; do not fail because callers may provide custom OpenCode agent config with the same name.

**Execution note:** Implement parser behavior test-first because this is the public action contract.

**Patterns to follow:**

- `parseTimeoutMs` and `parseOutputMode` in `src/harness/config/inputs.ts` for explicit parsing.
- Existing `core.warning` usage in input parsing for fork/S3 warnings.
- Readonly interface style in `packages/runtime/src/shared/types.ts`.

**Test scenarios:**

- Happy path: no `enable-omo` input, no `agent` input -> `enableOmo` is `false`, `agent` is `null`, `omoProviders` is all `no`.
- Happy path: `enable-omo: true`, valid `omo-providers` -> providers parse exactly as current main behavior.
- Happy path: explicit `agent: custom` with disabled oMo -> parsed `agent` is `custom`.
- Edge case: disabled oMo with invalid `omo-providers` -> parse succeeds, all providers are `no`, exactly one warning is emitted.
- Edge case: disabled oMo with empty raw `omo-version` and empty raw `omo-providers` -> no warning is emitted.
- Edge case: disabled oMo with explicit default `omo-version` -> no warning if the raw value equals the pinned default.
- Edge case: disabled oMo with non-default `omo-version` and `omo-providers` -> one warning names both ignored inputs.
- Edge case: disabled oMo with `agent: sisyphus` -> parse succeeds and emits an actionable migration warning.
- Edge case: disabled oMo with invalid `omo-providers` and `agent: sisyphus` -> exactly two warnings are emitted: one ignored-input warning and one agent migration warning.
- Error path: enabled oMo with invalid `omo-providers` -> parser fails as today.
- Regression: `omo-config` no longer appears in `action.yaml` and is not required by runtime setup types.

**Verification:**

- Input parsing tests prove disabled mode is the default and enabled mode preserves provider validation.
- Type checking proves `agent: string | null` is threaded through runtime and action setup boundaries.

- [x] **Unit 2: Runtime Prompt And Execution Semantics**

**Goal:** Make SDK prompt construction use the new omit-when-null contract and keep model resolution unchanged for disabled oMo.

**Requirements:** R0, R2, R3, R5

**Dependencies:** Unit 1

**Files:**

- Modify: `packages/runtime/src/agent/prompt-sender.ts`
- Modify: `packages/runtime/src/agent/execution.ts`
- Modify: `src/features/agent/prompt-sender.ts`
- Modify: `src/features/agent/execution.ts`
- Modify: `src/features/agent/opencode.test.ts`
- Modify: `src/features/comments/error-format.ts`
- Modify: `src/features/comments/error-format.test.ts`
- Modify: `src/features/observability/types.ts`
- Modify: `src/features/observability/job-summary.ts`
- Modify: `src/features/observability/job-summary.test.ts`
- Modify: `src/features/observability/run-summary.test.ts`
- Modify: `src/harness/phases/finalize.ts`

**Approach:**

- Build the SDK prompt body without `agent` when `config.agent` is `null` or absent.
- Preserve explicit agent passthrough for any non-null value.
- Leave model resolution order intact: explicit model first, oMo providers second, default model when no providers are active.
- Update logs and summaries to display `build` or `build (default)` when no agent is set, without reintroducing a default-agent constant.
- Keep explicit `agent: sisyphus` as caller intent. The input layer warns when oMo is disabled, but runtime still sends explicit values through.
- If agent-not-found messaging is already centralized, adjust the suggestion so users who need Sisyphus know to set `enable-omo: true`.
- Prefer delegating action-side prompt sending to the runtime implementation. If a local mirror remains, add parity coverage so the runtime and action SDK bodies cannot drift.

**Execution note:** Add SDK-body characterization coverage before changing prompt construction.

**Patterns to follow:**

- Existing prompt body tests in `src/features/agent/opencode.test.ts`.
- Existing `resolvePromptModel` shape in `packages/runtime/src/agent/prompt-sender.ts`.
- Existing summary rendering helpers in `src/features/observability/`.

**Test scenarios:**

- Happy path: `agent: null`, no model, disabled providers -> prompt body omits `agent` and includes `model: opencode/big-pickle`.
- Happy path: `agent: custom`, no model -> prompt body includes `agent: custom`.
- Happy path: explicit `model` with disabled providers -> prompt body includes that model and still omits agent when `agent` is null.
- Happy path: enabled oMo providers with no explicit model -> prompt body omits model so provider/agent config can decide.
- Edge case: explicit `agent: sisyphus` with disabled oMo -> prompt body includes `agent: sisyphus`; no oMo install is implied by runtime prompt code.
- Integration: runtime and action prompt-sender paths produce identical SDK bodies for null agent, custom agent, explicit model, and enabled-oMo provider cases.
- Regression: no default-oriented test outside oMo-enabled regression coverage asserts `sisyphus` as the default.
- Regression: summaries render a human-readable default agent label instead of `null`.
- Error path: unknown-agent formatting suggests enabling oMo when the missing agent is likely oMo-provided.

**Verification:**

- SDK prompt tests show `body.agent` is omitted only for null/unset agent.
- Observability tests show summaries remain readable and non-null.

- [x] **Unit 3: Setup Mode Gating And OpenCode Config Composition**

**Goal:** Skip Bun/oMo work by default, keep Systematic independent, and make generated OpenCode config deterministic in disabled mode.

**Requirements:** R1, R4, R6, R7, R8

**Dependencies:** Unit 1

**Files:**

- Modify: `src/services/setup/setup.ts`
- Modify: `src/services/setup/setup.test.ts`
- Modify: `src/services/setup/ci-config.ts`
- Modify: `src/services/setup/ci-config.test.ts`
- Modify: `src/services/setup/index.ts`
- Modify/Delete: `src/services/setup/omo-config.ts` depending on whether shared merge helpers remain useful after `writeOmoConfig` removal
- Modify/Delete: `src/services/setup/omo-config.test.ts` depending on whether shared merge helper tests remain useful after `writeOmoConfig` removal

**Approach:**

- Add `enableOmo` to setup inputs and branch setup behavior from that value.
- Add an explicit config-preparation boundary on the setup adapter, such as `prepareOpenCodeEnvironment(inputs, githubToken)`, or split `runSetup` into install and prepare phases. If OpenCode is already available, skip install work but still run preparation to write mode-specific OpenCode/Systematic config and populate auth as needed.
- Disabled mode skips Bun install, oMo telemetry env export, `installOmo`, and oMo config writes.
- Move `writeSystematicConfig` out of the Bun/oMo branch so caller Systematic config is honored regardless of oMo mode or Bun availability.
- Disabled mode composes OpenCode config without reading or merging existing local/restored `opencode.json`. It must not preserve restored `oh-my-openagent` plugin entries or stale `default_agent` values from any existing file.
- Disabled mode may start from user `opencode-config`, but must strip bare/versioned `oh-my-openagent` entries from both `plugin` and legacy `plugins`, apply Systematic injection, override `default_agent` to `build` after the merge, and warn when fields are rewritten.
- Enabled mode preserves Bun install, oMo installer, provider handling, plugin merge, and oMo plugin version normalization. Enabled mode should let oMo-managed config select Sisyphus by default when `agent` is unset.
- Update `buildCIConfig` to accept mode and apply `default_agent: "build"` after user config merge when disabled.
- Keep Systematic plugin injection in both modes.
- Migrate setup result status to `omoStatus: 'installed' | 'failed' | 'skipped'`.
- Remove unreachable `omo-config` setup plumbing and the input-specific `writeOmoConfig` wrapper. Keep or extract shared `deepMerge` behavior only if setup internals or tests still need it.

**Execution note:** Start with setup tests for disabled default and enabled preservation because setup has the highest regression risk.

**Patterns to follow:**

- Current graceful failure style in `src/services/setup/setup.ts` for oMo installer errors.
- Current config validation and plugin injection tests in `src/services/setup/ci-config.test.ts`.
- Existing structured logger usage in setup.

**Test scenarios:**

- Happy path: disabled default setup installs/prepares OpenCode, writes Systematic config if provided, writes generated OpenCode config with `default_agent: "build"`, and returns `omoStatus: 'skipped'`.
- Happy path: enabled setup preserves current Bun/oMo install behavior and returns `omoStatus: 'installed'` when install succeeds.
- Happy path: enabled setup with oMo installer failure continues and returns `omoStatus: 'failed'` with the installer error.
- Edge case: disabled setup with existing restored `opencode.json` containing `default_agent: "sisyphus"` and `oh-my-openagent` -> final written config pins `build` and excludes restored oMo plugin entries.
- Edge case: disabled setup with a pre-existing local `opencode.json` even without cache restore -> final written config pins `build` and excludes local oMo plugin entries.
- Edge case: disabled setup with user `opencode-config.default_agent` set to `sisyphus` -> final config still pins `build`.
- Edge case: disabled setup with user `opencode-config.plugin` containing `oh-my-openagent`, `oh-my-openagent@latest`, or `oh-my-openagent@x.y.z` -> final config strips the oMo plugin entry, keeps unrelated plugin entries, and warns.
- Edge case: disabled setup with user legacy `opencode-config.plugins` containing any `oh-my-openagent` variant -> final config strips the legacy oMo plugin entry and warns.
- Edge case: enabled setup with user plugin array and oMo installer plugin entries -> existing plugin merge/dedupe behavior remains.
- Edge case: enabled setup with unset `agent` -> final config preserves oMo-managed Sisyphus default behavior without requiring the workflow to set `agent: sisyphus`.
- Integration: when `verifyOpenCodeAvailable` succeeds, setup adapter preparation still runs even though install work is skipped.
- Regression: disabled setup does not call Bun installer, `bunx`, `installOmo`, or `writeOmoConfig`.
- Regression: Systematic config write is attempted even when oMo is disabled and even if Bun would have failed.
- Regression: `buildCIConfig` appends Systematic in both modes and only pins `default_agent` in disabled mode.

**Verification:**

- Setup tests prove disabled mode cannot reintroduce oMo through install steps or stale config files.
- Config tests prove disabled mode `default_agent` precedence is intentional and enabled mode stays compatible.

- [x] **Unit 4: Tools Cache Mode Isolation**

**Goal:** Prevent disabled-mode runs from restoring or saving oMo/Bun-specific cache state while preserving enabled-mode cache behavior.

**Requirements:** R1, R8

**Dependencies:** Unit 3

**Files:**

- Modify: `src/services/setup/tools-cache.ts`
- Modify: `src/services/setup/tools-cache.test.ts`
- Modify: `src/services/setup/setup.ts`
- Modify: `src/services/setup/setup.test.ts`

**Approach:**

- Keep this as a separate unit because deterministic config rewrite only protects after setup writes config. Cache isolation prevents old `~/.config/opencode` state from entering disabled-mode setup in the first place and avoids broad restore keys matching the wrong mode.
- Add an explicit cache mode component, such as enabled-oMo versus disabled-oMo, to the tools cache key contract.
- Define restore-key prefixes so disabled-mode restore keys cannot match enabled-mode cache keys, and enabled-mode restore keys cannot match disabled-mode keys.
- Enabled mode keeps oMo version in the key and keeps the existing path set: OpenCode tool cache, Bun tool cache, `~/.config/opencode`, and `~/.cache/opencode`.
- Disabled mode omits oMo version from effective keying and excludes Bun tool cache and `~/.config/opencode` from cache paths.
- Disabled mode may keep OpenCode's package cache path if it does not restore mutable oMo config. The key point is no cached `opencode.json` or oMo plugin config enters disabled setup.
- Preserve best-effort cache semantics: restore/save failures warn and continue.

**Patterns to follow:**

- Existing key builder and restore-key tests in `src/services/setup/tools-cache.test.ts`.
- `docs/solutions/build-errors/tool-binary-caching-ephemeral-runners.md` guidance that tool cache misses are not failures.

**Test scenarios:**

- Happy path: enabled key includes mode, OpenCode version, oMo version, and Systematic version.
- Happy path: disabled key includes mode, OpenCode version, and Systematic version, but not oMo version.
- Happy path: enabled and disabled restore keys are mode-specific and cannot cross-match each other.
- Happy path: enabled restore/save paths include Bun and `~/.config/opencode`.
- Happy path: disabled restore/save paths exclude Bun and `~/.config/opencode`.
- Edge case: cache restore failure in either mode logs a warning and returns miss.
- Regression: setup passes the same mode and path contract to restore and save.

**Verification:**

- Cache tests prove no disabled-mode cache can restore stale oMo config or stale default-agent config.
- Setup integration tests prove disabled mode still saves/restores OpenCode tooling best-effort.

- [x] **Unit 5: Dogfood Workflow And Documentation**

**Goal:** Make public docs and this repo's own workflow match the new default contract.

**Requirements:** R1, R2, R5, R6, R7, R8

**Dependencies:** Units 1 through 4

**Files:**

- Modify: `.github/workflows/fro-bot.yaml`
- Modify: `README.md`
- Modify: `docs/wiki/Setup and Configuration.md`
- Modify: `docs/wiki/Architecture Overview.md`
- Modify: `docs/wiki/Execution Lifecycle.md`
- Modify: `docs/examples/fro-bot.yaml` if it documents action inputs

**Approach:**

- Add `enable-omo: true` next to existing `omo-providers` in `.github/workflows/fro-bot.yaml`; do not add `agent: sisyphus` because oMo configures it as default.
- Update README input docs so `enable-omo` is visible, `agent` has no Sisyphus default, and `omo-config` is gone.
- Add migration guidance: default runs now use OpenCode `build`; workflows that need oMo's Sisyphus should set `enable-omo: true`.
- Document that default setup uses OpenCode `build`, while oMo setup is opt-in.
- Update wiki pages that currently describe Bun/oMo as the normal setup path.
- Verify docs with targeted searches over `README.md`, `docs/wiki/`, `docs/examples/`, and `action.yaml` for `sisyphus`, `omo-config`, `Oh My OpenAgent`, `oMo`, and `OpenCode and oMo`; keep only intentional opt-in/support references.
- Keep wording public-facing and user-centered. Do not mention internal brainstorm/session/reviewer details.

**Patterns to follow:**

- Existing README action input table style.
- Existing wiki frontmatter/source style in `docs/wiki/`.
- Public artifact directive: write as Marcus, no AI/session internals.

**Test scenarios:**

- Test expectation: none for docs-only edits.

**Verification:**

- Docs no longer claim Sisyphus/oMo are default.
- Docs disclose disabled-mode `opencode-config` exceptions: `default_agent` is forced to `build` and oMo plugin entries are stripped unless `enable-omo: true`.
- Release notes/changelog guidance calls out the default-agent change and the Sisyphus migration path.
- Dogfood workflow explicitly opts into oMo and continues passing `omo-providers`.

- [x] **Unit 6: Bundle And Full Verification**

**Goal:** Keep committed action output in sync and prove the new contract passes the repo's normal checks.

**Requirements:** All requirements

**Dependencies:** Units 1 through 5

**Files:**

- Modify: `dist/**`

**Approach:**

- Rebuild the committed action bundle after source and docs changes.
- Verify source, runtime package, tests, linting, type checking, and bundle output together.
- Confirm no unexpected files remain uncommitted after the build, especially `dist/`.

**Patterns to follow:**

- Project convention that `dist/` is committed and must stay in sync with source.
- Existing pre-push hook expectations: tests, lint, build, and `dist/` diff check.

**Test scenarios:**

- Test expectation: none for generated bundle output. Behavioral coverage belongs to Units 1 through 4.

**Verification:**

- Type checks pass.
- Tests pass.
- Lint passes.
- Build succeeds and `dist/` matches the source changes.
- Git status shows only intended source, docs, workflow, and dist changes.

## System-Wide Impact

- **Interaction graph:** `action.yaml` inputs flow through `src/harness/config/inputs.ts`, runtime shared types, setup adapter boundaries, setup/config/cache services, runtime prompt construction, and observability summaries.
- **Error propagation:** Disabled mode should not fail on invalid ignored oMo provider text. Enabled mode should preserve current validation and installer failure behavior.
- **State lifecycle risks:** Tools cache, pre-existing local `opencode.json`, restored `opencode.json`, and user `opencode-config` are the main stale-state risks. Disabled mode must avoid caching/restoring mutable oMo config, ignore existing config files, filter user oMo plugin entries, and overwrite generated config deterministically.
- **API surface parity:** Runtime package types under `packages/runtime/src/` and action harness wrappers under `src/` must change together.
- **Integration coverage:** Setup tests must cover generated config after cache restore; prompt tests must cover SDK body shape; parser tests must cover raw input warning behavior.
- **Unchanged invariants:** `model` override semantics stay unchanged. Systematic plugin injection stays enabled. Session cache, object-store backup, trigger routing, and delivery modes are not changed.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Disabled mode restores stale `default_agent: "sisyphus"` from cache | Exclude `~/.config/opencode` from disabled cache paths and write fresh config with `default_agent: "build"`. |
| User `opencode-config.default_agent` intentionally points elsewhere | Disabled mode still pins `build`; users who need another agent can set explicit `agent`. Document this tradeoff and warn on stale oMo-looking config. |
| OpenCode is already installed so setup returns early before writing config | Split install availability from config preparation and test the already-available path. |
| Systematic config silently stops working when Bun/oMo are skipped | Move `writeSystematicConfig` outside Bun/oMo branch and test disabled mode with custom Systematic config. |
| Enabled oMo behavior regresses | Keep enabled mode's installer, provider parsing, plugin merge, and cache path behavior covered by regression tests. |
| Runtime and action harness contracts drift | Update canonical runtime files first, then action wrappers and tests. |
| Public docs imply oMo is still default | Update README, workflow, and wiki docs in the same PR. |
| `dist/` omitted from commit | Treat dist sync as its own final unit and verify the tree after build. |

## Documentation / Operational Notes

- This is a default behavior change for new/minimal action users. The PR description should state that oMo is still supported with `enable-omo: true`.
- `.github/workflows/fro-bot.yaml` opt-in keeps this repo's own bot workflow on the current oMo path because oMo configures Sisyphus as OpenCode's default.
- Disabled-mode warnings are migration affordances for users who set stale oMo inputs, known oMo agent names, or stale oMo config without enabling oMo.
- Documentation and release notes should include a migration note for users relying on the old implicit Sisyphus default. Workflows that need Sisyphus should set `enable-omo: true`.
- Public-facing docs must not include session internals, reviewer names, or brainstorm process details.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-04-29-disable-omo-by-default-requirements.md` (local-only, gitignored; key decisions are carried forward in this plan)
- Related code: `action.yaml`
- Related code: `src/harness/config/inputs.ts`
- Related code: `packages/runtime/src/shared/types.ts`
- Related code: `packages/runtime/src/agent/prompt-sender.ts`
- Related code: `packages/runtime/src/agent/execution.ts`
- Related code: `packages/runtime/src/agent/server.ts`
- Related code: `packages/runtime/src/agent/setup-adapter.ts`
- Related code: `src/features/agent/server-adapter.ts`
- Related code: `src/services/setup/setup.ts`
- Related code: `src/services/setup/ci-config.ts`
- Related code: `src/services/setup/tools-cache.ts`
- Related code: `.github/workflows/fro-bot.yaml`
- Institutional learning: `docs/solutions/build-errors/tool-binary-caching-ephemeral-runners.md`
- Institutional learning: `docs/solutions/best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md`
- Institutional learning: `docs/solutions/workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md`
