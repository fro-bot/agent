---
title: "Adding a Config-Declared Plugin to the Versioned Tool Pattern"
date: 2026-03-29
problem_type: best_practice
component: tooling
root_cause: missing_tooling
resolution_type: tooling_addition
severity: medium
tags:
  - versioning
  - plugin
  - opencode
  - systematic
  - setup
  - renovate
category: best_practice
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

The versioned-tool skill itself warns: _"Do not copy installer structure blindly between tools. Copy the version-source pattern; verify the install mechanics per tool."_

## Solution

### Adapted Pattern: Version Constant → Config Plugin Injection

Instead of a separate installer, the version flows through the existing data pipeline and lands in `OPENCODE_CONFIG_CONTENT`'s `plugins` array.

**Data flow:**

```
constants.ts → inputs.ts fallback → ActionInputs → bootstrap.ts
  → EnsureOpenCodeOptions → SetupInputs → setup.ts ciConfig.plugins
  → OPENCODE_CONFIG_CONTENT env var → OpenCode resolves at startup
```

### 1. Version Constant (single source of truth)

```typescript
// src/shared/constants.ts
export const DEFAULT_SYSTEMATIC_VERSION = "2.1.0"
```

### 2. Type Thread (4 interfaces updated)

```typescript
// src/shared/types.ts — ActionInputs
readonly systematicVersion: string

// src/services/setup/types.ts — SetupInputs
readonly systematicVersion: string

// src/features/agent/server.ts — EnsureOpenCodeOptions
systematicVersion: string
```

### 3. Input Parsing with Constant Fallback

```typescript
// src/harness/config/inputs.ts
const systematicVersionRaw = core.getInput("systematic-version").trim()
const systematicVersion = systematicVersionRaw.length > 0 ? systematicVersionRaw : DEFAULT_SYSTEMATIC_VERSION
```

### 4. Plugin Registration in OpenCode Config (the key adaptation)

```typescript
// src/services/setup/setup.ts — after user opencode-config merge
const systematicPlugin = `@fro.bot/systematic@${inputs.systematicVersion}`
const rawPlugins: unknown[] = Array.isArray(ciConfig.plugins) ? (ciConfig.plugins as unknown[]) : []
const hasSystematic = rawPlugins.some((p: unknown) => typeof p === "string" && p.startsWith("@fro.bot/systematic"))
if (!hasSystematic) {
  ciConfig.plugins = [...rawPlugins, systematicPlugin]
}
```

Design decisions:

- Plugin appended AFTER user `opencode-config` merge, so it's always present
- Dedup via `@fro.bot/systematic` prefix match so user version pins win
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

OpenCode reads `OPENCODE_CONFIG_CONTENT` as its highest-precedence config. By adding `plugins: ["@fro.bot/systematic@2.1.0"]` to this env var during setup, OpenCode resolves and installs the plugin at startup. The version is pinned via the same constant pattern used by all other tools, with Renovate automating npm version bumps through the `customManagers` regex.

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

| Tool       | Mechanism                                       | Install Location             |
| ---------- | ----------------------------------------------- | ---------------------------- |
| OpenCode   | Binary download + tool-cache                    | PATH binary                  |
| Bun        | Binary download + tool-cache                    | PATH binary                  |
| oMo        | `bunx` CLI with `install` subcommand            | npm global + config          |
| Systematic | Config declaration in `OPENCODE_CONFIG_CONTENT` | OpenCode resolves at startup |

When adding a fifth tool, check the tool's README first. The install mechanism determines whether you need an installer file or just config wiring.

### 3. Dedup array injections

When programmatically injecting into arrays that users can also populate (like `plugins`), always check for existing entries before appending. Prefix matching (`p.startsWith('@fro.bot/systematic')`) handles version differences gracefully.

### 4. Type safety with `Record<string, unknown>`

When spreading arrays extracted from `unknown`-typed objects, `Array.isArray()` narrows to `any[]` in TypeScript. Use explicit `unknown[]` annotation (`ciConfig.plugins as unknown[]`) to satisfy `@typescript-eslint/no-unsafe-assignment`.

### 5. Update ALL ciConfig test assertions

When changing what goes into `OPENCODE_CONFIG_CONTENT`, grep `setup.test.ts` for every `OPENCODE_CONFIG_CONTENT` assertion. There were 3 that needed updating for the plugins array addition.

## Related Documentation

- [Tool Binary Caching on Ephemeral Runners](../build-errors/tool-binary-caching-ephemeral-runners.md) — Covers the tools cache layer, oMo version pinning, and the input→type→constant flow pattern that Systematic also follows
- [Versioned Tool Skill](/.agents/skills/versioned-tool/SKILL.md) — The canonical reference for this pattern
- [PR #409](https://github.com/fro-bot/agent/pull/409) — Implementation PR

## Files Changed

| File                              | Change                                          |
| --------------------------------- | ----------------------------------------------- |
| `src/shared/constants.ts`         | Added `DEFAULT_SYSTEMATIC_VERSION`              |
| `src/shared/types.ts`             | Added `systematicVersion` to `ActionInputs`     |
| `src/harness/config/inputs.ts`    | Parse `systematic-version` with fallback        |
| `src/services/setup/types.ts`     | Added `systematicVersion` to `SetupInputs`      |
| `src/features/agent/server.ts`    | Added to `EnsureOpenCodeOptions` + pass-through |
| `src/harness/phases/bootstrap.ts` | Pass `inputs.systematicVersion` downstream      |
| `src/services/setup/setup.ts`     | Plugin injection into `ciConfig.plugins`        |
| `action.yaml`                     | Added `systematic-version` input                |
| `.github/renovate.json5`          | npm customManager + packageRule                 |
