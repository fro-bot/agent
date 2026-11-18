---
title: "Adding a Config-Declared Plugin to the Versioned Tool Pattern"
date: 2026-03-29
last_updated: 2026-09-04
category: best-practices
module: setup
problem_type: best_practice
component: tooling
severity: medium
root_cause: missing_tooling
resolution_type: tooling_addition
tags:
  - versioning
  - plugin
  - opencode
  - systematic
  - setup
  - renovate
---

# Adding a Config-Declared Plugin to the Versioned Tool Pattern

## Problem

The fro-bot/agent project manages external CLI tools (OpenCode, Bun, oMo) through a single-source-of-truth version constant pattern documented in `.agents/skills/versioned-tool/SKILL.md`. The `@fro.bot/systematic` OpenCode plugin needed to be added as a fourth bundled tool, but it installs differently from all existing tools — it's a config-declared plugin, not a downloaded binary or bunx-installed package.

## Symptoms

- No `@fro.bot/systematic` reference anywhere in the codebase
- Agent running in CI had no access to Systematic skills/workflows (brainstorming, planning, code review)
- The versioned-tool skill pattern covered binary downloads and bunx installs but not config-declared plugins

## What Didn't Work

The initial instinct was to model Systematic after oMo's installer pattern (`bunx oh-my-openagent@{version} install --no-tui --skip-auth`). This was wrong because:

1. Systematic has no `install` CLI subcommand — it's an OpenCode plugin, not a standalone CLI tool
2. OpenCode resolves plugins declared in its config at startup; no separate install step is needed
3. Creating a `systematic.ts` installer file would have been dead code

Points 2 and 3 were true when written and are no longer the whole story. Letting the server resolve the plugin at startup means it performs a network npm install _after_ its HTTP listener is already accepting connections, with no timeout of its own; under registry latency that stalled production runs for minutes. A setup-time installer (`src/services/setup/plugin-install-v2.ts`) now exists, and it is not dead code — it runs the OpenCode executable (`plugin add <spec>`) to install each spec into `<XDG_CACHE_HOME>/opencode/npm/<spec>`, the directory the server reads, and the server's startup resolution becomes a local no-op. The config-declaration pipeline described below is unchanged; the install just no longer happens inside the server. See [Systematic plugin install stalls OpenCode bootstrap](../integration-issues/plugin-install-at-server-start-stalls-first-request-2026-11-17.md).

The versioned-tool skill itself warns: _"Do not copy installer structure blindly between tools. Copy the version-source pattern; verify the install mechanics per tool."_

## Solution

### Adapted Pattern: Version Constant → Config Plugin Injection

Instead of a separate installer, the version flows through the existing data pipeline and lands in `OPENCODE_CONFIG_CONTENT`'s `plugins` array.

**Data flow:**

```
packages/runtime/src/shared/constants.ts → src/harness/config/inputs.ts fallback → ActionInputs
  → bootstrap.ts → EnsureOpenCodeOptions → SetupInputs
  → setup.ts (resolvePluginSpecsV2, installPluginsV2) → cache-restore.ts → v2-server.ts (resolvePluginSpecsV2)
  → ci-config-v2.ts plugins → OPENCODE_CONFIG_CONTENT env var → server finds the plugin in the cache
```

### 1. Version Constant (single source of truth)

```typescript
// packages/runtime/src/shared/constants.ts
export const DEFAULT_SYSTEMATIC_VERSION = "<version>"
```

### 2. Type Thread (4 interfaces updated)

```typescript
// packages/runtime/src/shared/types.ts — ActionInputs
readonly systematicVersion: string

// src/services/setup/types.ts — SetupInputs
readonly systematicVersion: string

// packages/runtime/src/agent/server.ts — EnsureOpenCodeOptions
readonly systematicVersion: string
```

### 3. Input Parsing with Constant Fallback

```typescript
// src/harness/config/inputs.ts
const systematicVersionRaw = core.getInput("systematic-version").trim()
const systematicVersion = systematicVersionRaw.length > 0 ? systematicVersionRaw : DEFAULT_SYSTEMATIC_VERSION
```

### 4. Plugin Registration in OpenCode Config (the key adaptation)

```typescript
// src/services/setup/plugin-install-v2.ts — resolvePluginSpecsV2 returns the exact specs
specs: [`${SYSTEMATIC_PACKAGE}@${systematicVersion}`, `${FRO_BOT_PLUGIN_PACKAGE}@${FRO_BOT_PLUGIN_VERSION}`]

// src/services/setup/ci-config-v2.ts — buildCIConfigV2, after the operator opencode-config is read
plugins: [...new Set([...inputs.plugins, ...operatorPlugins])],
```

Design decisions:

- `inputs.plugins` carries the specs from `resolvePluginSpecsV2`, and the `plugins` key is written after the operator `opencode-config` is spread, so the specs are always present
- Dedup is by exact spec string (`new Set`), not by package-name prefix: an operator spec with a different version is a separate entry, not a replacement
- Explicit `unknown[]` annotation avoids `@typescript-eslint/no-unsafe-assignment` lint error

### 5. Renovate Tracking (npm datasource)

```json5
// .github/renovate.json5 — customManagers entry
{
  customType: "regex",
  managerFilePatterns: ["/src\\/shared\\/constants\\.ts/"],
  matchStrings: ["DEFAULT_SYSTEMATIC_VERSION = '(?<currentValue>\\d+\\.\\d+\\.\\d+)'"],
  depNameTemplate: "@fro.bot/systematic",
  datasourceTemplate: "npm",
}
```

### 6. Action Input (no hardcoded default)

```yaml
# action.yaml — NO default: value, falls through to constant
systematic-version:
  description: Systematic plugin version to register with OpenCode.
  required: false
```

## Why This Works

OpenCode reads `OPENCODE_CONFIG_CONTENT` as its highest-precedence config. By adding `plugins: ["@fro.bot/systematic@<version>"]` to this env var during setup, OpenCode resolves the plugin at startup — and, since the setup-time install landed, finds it already present rather than fetching it. The version is pinned via the same constant pattern used by all other tools, with Renovate automating npm version bumps through the `customManagers` regex.

## Prevention

### 1. Follow the versioned-tool skill

`.agents/skills/versioned-tool/SKILL.md` documents the exact pattern. Every new tool should follow its verification checklist:

- Constant updated in `constants.ts`
- No duplicate version literals (grep for old version string)
- `action.yaml` has no hardcoded default
- Renovate regex matches the constant pattern
- Tests pass, lint clean, dist/ rebuilt

### 2. Verify install mechanics BEFORE copying patterns

The four tools now use four different installation mechanisms:

| Tool | Mechanism | Install Location |
| --- | --- | --- |
| OpenCode | Binary download + tool-cache | PATH binary |
| Bun | Binary download + tool-cache | PATH binary |
| oMo | `bunx` CLI with `install` subcommand | npm global + config |
| Systematic | Config declaration in `OPENCODE_CONFIG_CONTENT` + setup-time install into the XDG cache (`plugin-install-v2.ts`) | Server finds it in the cache; no network at startup |

When adding a fifth tool, check the tool's README first. The install mechanism determines whether you need an installer file or just config wiring.

### 3. Dedup array injections

When programmatically injecting into arrays that users can also populate (like `plugins`), always check for existing entries before appending. The setup code dedups by exact spec string (`new Set`); if version differences must collapse, match on the package name explicitly.

### 4. Type safety with `Record<string, unknown>`

When spreading arrays extracted from `unknown`-typed objects, `Array.isArray()` narrows to `any[]` in TypeScript. Use explicit `unknown[]` annotation (`operator.plugins as unknown[]`) to satisfy `@typescript-eslint/no-unsafe-assignment`.

### 5. Update ALL ciConfig test assertions

When changing what goes into `OPENCODE_CONFIG_CONTENT`, grep `setup.test.ts` for every `OPENCODE_CONFIG_CONTENT` assertion. There were 3 that needed updating for the plugins array addition.

## Related Documentation

- [Tool Binary Caching on Ephemeral Runners](../performance-issues/tool-binary-caching-ephemeral-runners.md) — Covers the tools cache layer, oMo version pinning, and the input→type→constant flow pattern that Systematic also follows
- [Versioned Tool Skill](/.agents/skills/versioned-tool/SKILL.md) — The canonical reference for this pattern
- [PR #409](https://github.com/fro-bot/agent/pull/409) — Implementation PR

## Files Changed

| File                                       | Change                                                      |
| ------------------------------------------ | ----------------------------------------------------------- |
| `packages/runtime/src/shared/constants.ts` | Added `DEFAULT_SYSTEMATIC_VERSION`                          |
| `packages/runtime/src/shared/types.ts`     | Added `systematicVersion` to `ActionInputs`                 |
| `src/harness/config/inputs.ts`             | Parse `systematic-version` with fallback                    |
| `src/services/setup/types.ts`              | Added `systematicVersion` to `SetupInputs`                  |
| `packages/runtime/src/agent/server.ts`     | Added to `EnsureOpenCodeOptions` + pass-through             |
| `src/harness/phases/bootstrap.ts`          | Pass `inputs.systematicVersion` downstream                  |
| `src/services/setup/plugin-install-v2.ts`  | `resolvePluginSpecsV2` and `installPluginsV2` for the specs |
| `src/services/setup/ci-config-v2.ts`       | Plugin specs into `plugins` of the CI config                |
| `action.yaml`                              | Added `systematic-version` input                            |
| `.github/renovate.json5`                   | npm customManager + packageRule                             |
