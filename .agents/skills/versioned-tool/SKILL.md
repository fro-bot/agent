---
name: versioned-tool
description: Use when adding or updating external CLI tools managed by pinned version constants, including OpenCode, Bun, oMo, action inputs, or Renovate customManagers.
---

# Versioned Tool

## Overview

This project manages external CLI tools through a **single-source-of-truth version constant** pattern. Every tool's default version lives in `packages/runtime/src/shared/constants.ts` (the root `src/shared/constants.ts` is a re-export barrel with no version literals — edits go in the runtime package), with Renovate automation tracking updates via `.github/renovate.json5`.

**Current tools:**

| Tool | Constant | User-facing input | Renovate datasource |
| --- | --- | --- | --- |
| OpenCode (action default) | `DEFAULT_OPENCODE_VERSION` | `opencode-version` | _Release-job coupled — NOT Renovate (see below)_ |
| OpenCode (action fallback) | `FALLBACK_VERSION` in `src/services/setup/opencode.ts` | _(internal only)_ | `github-releases` (`anomalyco/opencode`) |
| OpenCode (workspace image) | `ARG OPENCODE_VERSION` in `deploy/workspace.Dockerfile` | _(internal only)_ | _Release-job coupled — NOT Renovate (see below)_ |
| oMo | `DEFAULT_OMO_VERSION` | `omo-version` | `npm` (`oh-my-openagent`) |
| Bun | `DEFAULT_BUN_VERSION` | _(internal only)_ | `github-releases` (`oven-sh/bun`, extract `bun-v` prefix) |
| Systematic | `DEFAULT_SYSTEMATIC_VERSION` | `systematic-version` | `npm` (`@fro.bot/systematic`) |
| OpenCode (harness base) | `base_version` in `packages/harness/harness.config.json` | _(internal only — config-JSON, not a TS constant)_ | `github-releases` (`anomalyco/opencode`) |

**Release-job coupled sites (not Renovate-tracked):** `DEFAULT_OPENCODE_VERSION` and the workspace `ARG OPENCODE_VERSION` hold the harness build version (`<base>+harness.<sha>`). Renovate cannot order SemVer build-metadata tags, so both are bumped together by `harness-release.yaml`'s `sync-default-version` job at publish time (one auto-PR, dual-source idempotency guard). Do not add Renovate `customManager` entries for these — they would be dropped. See `docs/solutions/best-practices/cross-libc-build-and-release-safety-2026-06-14.md` §4 and `docs/solutions/workflow-issues/harness-base-version-source-of-truth-2026-06-12.md`.

## Quick Start

### Bump an existing tool version

1. Update `DEFAULT_<TOOL>_VERSION` in `packages/runtime/src/shared/constants.ts`.
2. Verify the installer imports that constant (not a duplicate string).
3. For user-facing tools, verify `src/harness/config/inputs.ts` falls back to the constant.
4. Update any docs that surface the pinned default.
5. If the bump pulls an npm package published within the last 3 days (e.g. `@opencode-ai/sdk` on a same-day OpenCode bump), `bun install` refuses it under `bunfig.toml`'s `minimumReleaseAge` — add a temporary `minimumReleaseAgeExcludes = ["<pkg>"]` and file a removal reminder for when the window clears (precedent: PRs #1066, #1084).
6. Run: `bun run test && bun run lint && bun run build`.

### Add a new external tool

Follow the full pattern below.

## Rule: Copy the Pattern, Not the Prose

The invariant flow is: `constants.ts` → installer import → input fallback (if user-facing) → Renovate.

Before editing, inspect the nearest existing implementation:

- `src/services/setup/opencode.ts` — supports `latest` resolution + fallback
- `src/services/setup/omo.ts` — dual-identity package (npm name ≠ runtime name)
- `src/services/setup/bun.ts` — internal-only, no action.yaml input

**If this skill conflicts with the current repo, follow the repo and update this skill afterward.**

## Critical Warning: Package Name May Differ from Runtime Identity

Do not assume the install package name, config filename, and runtime version string are the same.

The oMo integration is the cautionary example:

| Concern          | Install identity         | Runtime identity        |
| ---------------- | ------------------------ | ----------------------- |
| Package name     | `oh-my-openagent`        | `oh-my-opencode`        |
| Config filename  | —                        | `oh-my-opencode.json`   |
| Version output   | —                        | `oh-my-opencode@3.11.2` |
| bunx install arg | `oh-my-openagent@3.11.2` | —                       |

When adding or renaming a tool, verify independently:

1. Package name used in install commands
2. Runtime/version output format (run the tool, check stdout)
3. Config filenames and on-disk paths
4. Renovate datasource/package identity

## The Pattern

All tools share the same version-source and Renovate tracking. User-facing tools add `action.yaml` input and `inputs.ts` fallback; internal-only tools skip those steps.

### Required for every tool

#### 1. Define the Constant

All default versions live in `packages/runtime/src/shared/constants.ts` (re-exported through the root barrel `src/shared/constants.ts`):

```typescript
export const DEFAULT_BUN_VERSION = "1.3.9"
export const DEFAULT_OMO_VERSION = "3.11.2"
```

Rules: semver string, no `v` prefix, named `DEFAULT_<TOOL>_VERSION`. This is the ONLY place the version literal appears. (Exception: `DEFAULT_OPENCODE_VERSION` carries the harness build format `<base>+harness.<sha>` and is bumped by the release job, not by hand.)

#### 2. Import from Installer

Each installer imports the constant. Never duplicate the same version string across files.

**OpenCode is the exception, not the template:** `FALLBACK_VERSION` in `src/services/setup/opencode.ts` is an independent **stock** pin (e.g. `1.17.13`), deliberately NOT aliased from `DEFAULT_OPENCODE_VERSION` (the harness build, e.g. `1.17.13+harness.<sha>`). They are different artifacts on different update cadences, each with its own Renovate/release-job tracking — do not "deduplicate" them into an alias.

#### 3. Add Renovate Tracking

Add a `customManagers` entry in `.github/renovate.json5`:

```json
{
  "customType": "regex",
  "managerFilePatterns": ["/src\\/shared\\/constants\\.ts/"],
  "matchStrings": ["DEFAULT_OPENCODE_VERSION = '(?<currentValue>\\d+\\.\\d+\\.\\d+)'"],
  "depNameTemplate": "anomalyco/opencode",
  "datasourceTemplate": "github-releases",
  "extractVersionTemplate": "^v?(?<version>.*)$"
}
```

And a `packageRules` entry:

```json
{
  "matchPackageNames": ["anomalyco/opencode"],
  "semanticCommitType": "build"
}
```

**Datasource selection:**

| Source          | `datasourceTemplate` | `depNameTemplate` | `extractVersionTemplate` |
| --------------- | -------------------- | ----------------- | ------------------------ |
| GitHub Releases | `github-releases`    | `owner/repo`      | `^v?(?<version>.*)$`     |
| npm Registry    | `npm`                | `package-name`    | _(not needed)_           |

Bun tags use `bun-vX.Y.Z` format: `"extractVersionTemplate": "^bun-v(?<version>.*)$"`.

#### 4. Update Documentation

Update only the docs that surface the changed version:

- `README.md` — if it shows the pinned default in the input table
- `action.yaml` — input descriptions for user-facing tools
- `AGENTS.md` / `src/services/setup/AGENTS.md` — only if architectural pattern changed

#### 5. Rebuild dist/

```bash
bun run build  # runs tsc --noEmit && tsdown
```

`dist/` is committed and must stay in sync.

### Required only for user-facing tools

#### 6. Wire the action.yaml Input

```yaml
opencode-version:
  description: OpenCode CLI version to install if auto-setup is needed. Defaults to version pinned in source code if not set.
  required: false
  # NO hardcoded default — falls through to constant in inputs.ts
```

**Critical:** Do NOT set `default: latest` or `default: '1.2.24'` in `action.yaml`. The constant in `constants.ts` is the single source of truth.

#### 7. Parse Input with Constant Fallback

```typescript
const opencodeVersionRaw = core.getInput("opencode-version").trim()
const opencodeVersion = opencodeVersionRaw.length > 0 ? opencodeVersionRaw : DEFAULT_OPENCODE_VERSION
```

#### 8. Handle Explicit "latest" (If Supported)

`latest` is a user-provided override, not the default:

```typescript
if (version === "latest") {
  try {
    version = await getLatestVersion(logger)
  } catch (error) {
    logger.warning("Failed to get latest version, using fallback", {error: toErrorMessage(error)})
    version = FALLBACK_VERSION
  }
}
```

## Installer Expectations

Installers reuse the pinned version constant instead of hardcoding version literals.

Repo-specific behaviors today:

- **OpenCode**: supports explicit `latest` resolution, falls back to `FALLBACK_VERSION` (independent stock pin in `src/services/setup/opencode.ts` — deliberately not the harness-build `DEFAULT_OPENCODE_VERSION`)
- **Bun**: installs from `DEFAULT_BUN_VERSION`, no user override
- **oMo**: installs from `DEFAULT_OMO_VERSION`, but package/runtime identity differs

Do not copy installer structure blindly between tools. Copy the version-source pattern; verify the install mechanics per tool.

## Verification Checklist

- [ ] Constant updated in `packages/runtime/src/shared/constants.ts`
- [ ] No duplicate version literals elsewhere (grep for old version string)
- [ ] `action.yaml` has no hardcoded default for the version input
- [ ] Renovate customManager regex matches the constant pattern exactly
- [ ] Renovate packageRule sets `semanticCommitType: 'build'`
- [ ] `bun run test` passes
- [ ] `bun run lint` clean (0 errors)
- [ ] `bun run build` succeeds (`check-types` runs as part of build)
- [ ] `dist/` is regenerated and in sync
- [ ] Docs that surface the pinned default are updated

## Common Mistakes

| Mistake | Why It's Wrong | Fix |
| --- | --- | --- |
| Hardcoding default in `action.yaml` | Creates two sources of truth; version drifts | Remove `default:` line, let `inputs.ts` fall back to constant |
| Duplicating version string in installer | Stale fallback when constant updates | Import the constant (exception: OpenCode's `FALLBACK_VERSION` is an independent stock pin — see §2) |
| Wrong Renovate `extractVersionTemplate` | Renovate can't parse tag format | Check actual tag format: `v1.2.3` vs `bun-v1.2.3` |
| Using `latest` as default | Non-reproducible builds, surprise breakage | Pin to known stable; let users opt in to `latest` explicitly |
| Assuming package name == runtime identity | Config paths, version parsing, plugin names break | Verify install name, stdout output, and config file independently |
| Updating constant without updating docs | Users see stale pinned version in README/action descriptions | Grep for old version string across docs before committing |
| Copying installer internals between tools | Tools have different mechanics (fallback, latest, dual-identity) | Copy only the version-source pattern, not installer implementation |
