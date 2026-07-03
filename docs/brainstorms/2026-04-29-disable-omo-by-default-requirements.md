---
title: Disable oMo setup and use by default
status: ready-for-planning
created: 2026-04-29
---

# Disable oMo setup and use by default

## Problem

The action installs Oh My OpenAgent (oMo) and configures Sisyphus as the default agent on every run. This adds ~15-20s of cold-start work for callers who don't use oMo, advertises a non-default agent to users via `action.yaml`, and entangles the setup phase with a third-party plugin that doesn't apply to most workflows.

`prompt-sender.ts` already silently elides `body.agent` when the value equals `DEFAULT_AGENT`, so the build agent runs in practice today even though the input shows `sisyphus`. The plumbing is half-done — this brainstorm closes the loop.

## Goals

- Default behavior: oMo not installed, OpenCode build agent used, model overrides work as today.
- Opt-in via single boolean input. When enabled, behavior matches today's defaults (oMo installed, providers honored, custom omo-config respected).
- Single setup-time warning if any `omo-*` input is set while oMo is disabled. Inputs are otherwise ignored cleanly.

## Non-goals

- Removing oMo support entirely. It remains a fully-supported opt-in.
- Migrating known external callers (`marcusrbrown/containers`, `marcusrbrown/marcusrbrown.github.io`). Their workflows don't reference any oMo input, so disabling by default produces no observable change for them. Track downstream subagent-delegation behavior reactively if real breaks appear.
- "Doctor" surface removal. No code matches `doctor` anywhere; the user's note refers to oMo's internal command, not anything we expose.

## Requirements

### R0 — OpenCode's build agent is a sufficient default (RESOLVED 2026-04-29)

Validated by deep research into OpenCode SDK + source. Findings:

- **SDK contract:** `body.agent` is optional in `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:2326-2350`. When omitted, the server (`anomalyco/opencode/packages/opencode/src/session/prompt.ts` — `createUserMessage`) calls `agents.defaultAgent()`, which returns the first non-subagent, non-hidden agent in the registry: `build`. Caller's `config.default_agent` setting wins if set.
- **Build is documented default:** `https://opencode.ai/docs/agents` and `anomalyco/opencode` README both state "**build** — Default, full-access agent for development work" with "all tools enabled."
- **Tool parity for our use cases:** Build's permissions in `packages/opencode/src/agent/agent.ts` are `defaults ("*": "allow") + question:"allow" + plan_enter:"allow"`. That covers everything our prompt requires: `bash` (for `gh` CLI and `git`), `edit`, `read`, `task` (subagent delegation to `general`/`explore`), `grep`, `glob`, `lsp`, `websearch`, `webfetch`, `skill`, registered MCPs.
- **Already in production today:** `src/features/agent/prompt-sender.ts:47-48` elides `body.agent` when it equals `DEFAULT_AGENT='sisyphus'`. So Build is what runs in production when oMo isn't loaded — this work makes that explicit rather than half-implicit.
- **Subagent catalog gap:** Build delegates to OpenCode's stock `general` and `explore` subagents; oMo's specialist stack (Hephaestus, Oracle, Librarian, Prometheus) is unavailable. Acceptable for our hot paths (PR review, comment reply, DMR, wiki maintenance). Multi-file refactors that benefit from specialist routing must opt-in via `enable-omo: true`.

Confidence: HIGH (~90%). Remaining 10% is output-quality on complex multi-file refactors — not a primary use case. Mitigated by R8.

### R1 — `enable-omo` action input

A new boolean input `enable-omo` is added to `action.yaml`, default `false`. When `true`, current setup behavior is preserved. When `false` (the default), the setup phase skips Bun install, the oMo installer, the `omo-config` write, and any oMo-specific plugin merging.

### R2 — Default agent is OpenCode's build agent

The `agent` action input default in `action.yaml` is removed (no default value, optional input). The fallback in `src/harness/config/inputs.ts:290-291` (`agentRaw.length > 0 ? agentRaw : DEFAULT_AGENT`) is also removed; `parseActionInputs` returns `agent: string | null` (null when caller supplied empty). The execution config carries the same null through to `body.agent` and the runtime sets it iff non-null. When unset, OpenCode falls through to its build agent. Setting `agent: <name>` still works exactly as today and is honored by the SDK.

### R3 — Model override unchanged

The `model` input continues to take precedence over the agent's default model. With oMo disabled, no oMo provider configuration is read, so `resolvePromptModel` should resolve to the user's `model` if set, otherwise to the existing `DEFAULT_MODEL` constant. Behavior matches today's "no providers configured" path.

### R4 — Disabled-mode warning

When `enable-omo: false` and any of `omo-version`, `omo-providers` are set to a non-default, non-empty value, log exactly one warning per run via `core.warning(...)` naming all set inputs. Do not fail the run. Inputs are silently ignored — no further validation, no parse errors. Note: `omo-config` is removed from the action surface as part of this work (see R7), so it does not participate in R4's warning.

### R5 — Removal of "sisyphus" naming from defaults

The `DEFAULT_AGENT = 'sisyphus'` constant and any references that exist purely to elide it from SDK requests are removed. The omit-when-undefined contract becomes the model: the runtime omits `body.agent` when the caller didn't set one. Test fixtures and assertions that hard-code `'sisyphus'` outside of oMo-enabled regression coverage are updated to reflect the no-default semantic; oMo-enabled tests may continue asserting `'sisyphus'` as the canonical agent for that path.

Scope inventory — every site touched by R5:

- `packages/runtime/src/shared/constants.ts` — `DEFAULT_AGENT` declaration (canonical)
- `src/shared/constants.ts` — re-exports `DEFAULT_AGENT` from `@fro-bot/runtime`
- `packages/runtime/src/agent/prompt-sender.ts` — elide-when-equals-default logic
- `packages/runtime/src/agent/execution.ts` — `agent: config?.agent ?? DEFAULT_AGENT` log line
- `src/features/agent/prompt-sender.ts` — elide-when-equals-default logic (mirror of runtime)
- `src/features/agent/execution.ts` — `config?.agent ?? DEFAULT_AGENT` log line (mirror of runtime)
- `src/harness/config/inputs.ts:290-291` — `agentRaw.length > 0 ? agentRaw : DEFAULT_AGENT` fallback (must change to `string | null`)
- Test fixtures asserting `agent: 'sisyphus'` across `src/features/agent/opencode.test.ts`, `src/features/observability/{run,job}-summary.test.ts`, `src/features/comments/error-format.test.ts`

### R6 — Caller migration in this repo

`.github/workflows/fro-bot.yaml` currently passes `omo-providers: ${{ secrets.OMO_PROVIDERS }}` and `opencode-config: ${{ secrets.OPENCODE_CONFIG }}`. It depends on oMo provider registration today. R6 audits this workflow as part of the same PR and adds `enable-omo: true` to the `with:` block so daily DMR + weekly wiki + on-demand dispatch invocations continue to use the Sisyphus path. No semantic change for this caller — same agent, same providers, same model resolution.

### R7 — Remove `omo-config` action input

The `omo-config` input is currently declared in `action.yaml` but never read by `parseActionInputs`; downstream callers (`ensureOpenCodeAvailable`) hardcode `omoConfig: null`. R7 removes the input from `action.yaml` and removes the unused `omoConfig` plumbing from `SetupInputs`/`ensureOpenCodeAvailable`. The `writeOmoConfig` function and its tests stay because the function is still consumed by direct `setup.test.ts` test injection. If a future caller needs custom oMo config, the input can be added back (properly wired) at that time.

### R8 — Pin `default_agent: "build"` in generated `opencode.json` when oMo disabled

Defense-in-depth against fallback drift. When `enable-omo: false`, `buildCIConfig()` writes `default_agent: "build"` into the generated `opencode.json`. Two threats neutralized:

1. Future OpenCode versions could reorder the `agents` Record literal in `packages/opencode/src/agent/agent.ts`, changing which agent `defaultAgent()` returns when no `default_agent` is configured. Pinning eliminates this dependency on insertion order.
2. Callers may have a stale `default_agent: "sisyphus"` in a per-project `opencode.json` from a previous oMo-enabled run. Without pinning, OpenCode would throw `"default agent 'sisyphus' not found"` at request time. Our explicit pin overrides the stale value cleanly.

When `enable-omo: true`, `default_agent` is not pinned by the harness — oMo's installer or the caller's `opencode-config` input controls it (preserving today's behavior).

## Success criteria

- A clean run of the action with no inputs other than `github-token` and `auth-json` does not invoke `bunx`, does not write `oh-my-openagent.json`, does not register the oMo plugin in `opencode.json`, and uses OpenCode's `build` agent. Generated `opencode.json` contains `default_agent: "build"` (per R8).
- A run with `enable-omo: true` and existing oMo inputs behaves identically to the current main-branch behavior. Generated `opencode.json` does NOT pin `default_agent` (oMo / `opencode-config` input controls it).
- A run with `enable-omo: false` and any oMo input set produces exactly one `::warning::` line and otherwise behaves like the disabled case.
- Existing tests pass without re-asserting "sisyphus" anywhere except in regression coverage for the oMo-enabled path.
- New tests cover: disabled default path skips oMo install; warning fires when oMo inputs set with `enable-omo: false`; agent omit-when-undefined contract; model override works under disabled-oMo path; `default_agent: "build"` appears in `opencode.json` when oMo disabled and is absent when oMo enabled.

## Open questions for planning

- Does the `omo-providers` parser path stay alive (used only when `enable-omo: true`) or get gated at the input layer? Either works; planning picks the cleanest split.
- Bun install: today's only consumer is the oMo installer. The plan gates Bun install behind `enable-omo: true`. If a future non-oMo caller needs Bun, that's a separate input.
- Tools cache key: planning decides whether to partition the cache by `enable-omo` (avoid cross-contamination) or to scrub `omoVersion`/`bunCachePath`/`omoConfigPath` from the key+paths when disabled.
- `SetupResult.omoInstalled`: planning decides whether to add an `omoSkipped: boolean` (or migrate to `'installed' | 'failed' | 'skipped'`) so observability can distinguish skipped-by-design from install-failure.

## References

- `src/services/setup/setup.ts` — oMo install path
- `src/services/setup/omo.ts` — bunx install logic
- `src/services/setup/bun.ts` — Bun runtime install (only consumer is the oMo installer)
- `src/services/setup/tools-cache.ts` — cache key includes `omoVersion`; planning decides partition strategy
- `src/features/agent/prompt-sender.ts` AND `packages/runtime/src/agent/prompt-sender.ts` — agent omit logic, model resolution (mirrored after Unit 1 extraction)
- `src/features/agent/execution.ts` AND `packages/runtime/src/agent/execution.ts` — agent fallback log line (mirrored)
- `src/harness/config/inputs.ts` — `agent` and `omo-*` input parsing
- `packages/runtime/src/shared/constants.ts` — canonical `DEFAULT_AGENT`, `DEFAULT_MODEL`
- `src/shared/constants.ts` — re-exports the runtime constants
- `action.yaml` — input definitions
- `.github/workflows/fro-bot.yaml:198-202` — dogfood workflow that currently uses oMo providers
