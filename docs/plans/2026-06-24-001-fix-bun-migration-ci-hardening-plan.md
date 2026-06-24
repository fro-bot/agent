---
title: 'fix: Bun migration CI hardening — phantom-dep guard, bun cache, tools-cache version segment'
type: fix
status: active
date: 2026-06-24
---

# Bun migration CI hardening

## Overview

Close the #1004 follow-up cohort from the pnpm→Bun migration: add the phantom-dependency lint guard the hoisted linker removed protection for, cache Bun's install cache in CI, give the action's tools-cache key a Bun-version segment so a Bun bump invalidates it, and apply two cheap notice-collector polish items. All four are verified against current `main` (`dc5a4c0f6`).

## Problem Frame

The Bun migration adopted the **hoisted** linker (required to keep TypeScript's deep-type naming portable — see `docs/solutions/workflow-issues/migrate-pnpm-to-bun-monorepo-2026-06-24.md`). Hoisting re-enables phantom-dependency imports: the spike already found two (`@octokit/core`, `yaml` in the gateway, now declared), and nothing prevents the next one from silently resolving. Separately, the migration's CI setup action caches nothing for Bun's dependency download, and the action's aggregate tools-cache key (which caches the installed Bun directory) carries no Bun-version segment — a Bun bump can restore a stale Bun from that cache.

## Requirements Trace

- R1. A workspace import of a package not declared in that package's `package.json` (or the root) fails lint, with devDependencies still permitted in test and config files.
- R2. CI caches Bun's global install cache so repeat runs do not re-download the full dependency graph.
- R3. A Bun version bump invalidates the action's tools-cache key so a stale Bun binary is not restored from the aggregate cache.
- R4. The notice collector's version comparator documents its prerelease/build-metadata assumption, and a regression test pins that workspace devDependencies are excluded from the prod attribution closure.

## Scope Boundaries

- Not touching the Dockerfile Bun install posture (verified-binary download / runtime-image trim) — that is #1003.
- Not fixing the pre-existing version-label dedup quirk — the license *text* is correct; only a `name@version` label can mismatch, and it predates the migration.

## Context & Research

### Relevant Code and Patterns

- `eslint.config.ts` — flat config calling `defineConfig` from `@bfra.me/eslint-config`. The shared config bundles `eslint-plugin-import-x` and enables several `import-x/*` rules; `import-x/no-extraneous-dependencies` **exists in the installed plugin but is NOT SET**. Enabling it is a config-only change — no new dependency.
- `.github/actions/setup/action.yaml` — the composite action all 6 workflows use: `oven-sh/setup-bun@v2` + `actions/setup-node` + `bun install --frozen-lockfile`. No Bun dependency cache today.
- `src/services/setup/tools-cache.ts` — `ToolsCacheKeyComponents` (`os`, `opencodeVersion`, `omoVersion`, `systematicVersion`, `cacheMode`), `buildToolsCacheKey`, `buildToolsRestoreKeys`, and `restoreToolsCache`/`saveToolsCache` (which cache `bunCachePath` among the paths but key on the components above — no `bunVersion`).
- `src/services/setup/setup.ts` — assembles `ToolsCacheKeyComponents` and calls restore/save (the call site that must pass the new `bunVersion`).
- `src/services/setup/bun.ts` — `installBun` already version-caches Bun via `@actions/tool-cache`'s native `find`/`cacheDir(version)`; the gap is only the *aggregate* GitHub-Actions cache key.
- `scripts/third-party-notices.ts` — `compareVersions` (ignores prerelease/build metadata); `collectProdClosureFromBunLock` (seeds from workspace `dependencies` only, so devDeps are already excluded — the test pins this).

### Institutional Learnings

- `docs/solutions/workflow-issues/migrate-pnpm-to-bun-monorepo-2026-06-24.md` — the migration doc; the hoisted-linker trade-off (lost phantom-dep protection) is the motivation for R1.
- `docs/solutions/workflow-issues/harness-base-version-source-of-truth-2026-06-12.md` — grow cache keys, never rename; informs R3's additive `bunVersion` segment.

## Key Technical Decisions

- **Phantom-dep guard via `import-x/no-extraneous-dependencies`, config-only.** The rule is already installed; enable it with per-package `packageDir` so each workspace package is validated against its own + the root `package.json`, and keep devDependencies allowed in `**/*.test.ts`, `**/*.config.ts`, `eslint.config.ts`, and scripts. No new dependency, no standalone script.
- **Bun cache via `actions/cache` keyed on `bun.lock`.** Cache `~/.bun/install/cache` in the composite action, restore-key-fallback on OS. Keep it before the install step so a hit speeds `bun install`.
- **Additive `bunVersion` segment.** Grow `ToolsCacheKeyComponents` and both key builders with `bunVersion`; never rename existing segments (a rename orphans every prior cache). The setup call site passes the resolved Bun version.

## Open Questions

### Resolved During Planning

- Does the shared eslint config expose an extraneous-deps rule? — Yes, `import-x/no-extraneous-dependencies` is installed (via `eslint-plugin-import-x`) but unset; enabling it is config-only.
- Is the tools-cache `bunVersion` gap real? — Yes; `restoreToolsCache`/`saveToolsCache` cache `bunCachePath` but key without a Bun version, so a bump can restore a stale Bun.

### Deferred to Implementation

- Exact `packageDir` shape for the monorepo flat-config override (single root + per-package vs a glob) — settle against the real `import-x` option behavior when wiring the rule.

## Implementation Units

- [x] **Unit 1: Phantom-dependency lint guard**

**Goal:** Fail lint on an import of a package not declared in the importing package's `package.json` (or root), while allowing devDependencies in test/config/script files.

**Requirements:** R1.

**Dependencies:** None.

**Files:**
- Modify: `eslint.config.ts`

**Approach:** Add an `import-x/no-extraneous-dependencies` rule block. Configure `packageDir` so each workspace package validates against its own manifest plus the repo root. Add an override enabling `devDependencies: true` for `**/*.test.ts`, `**/*.config.ts`, `eslint.config.ts`, `tsdown.config.ts`, and `scripts/**` so dev-only imports there don't trip the rule. Verify the rule catches a deliberately-undeclared import and that the existing tree (with the gateway's now-declared `@octokit/core`/`yaml`) passes clean.

**Patterns to follow:** The existing `import-x/*` rule entries already in the resolved config; the per-file `overrides` blocks already in `eslint.config.ts` (vitest overrides, deploy/scripts overrides).

**Test scenarios:**
- Happy path: full `bun run lint` passes on the current tree (no false positives — gateway's declared deps resolve).
- Edge case: a temporary undeclared import in a `src/` file fails lint with the extraneous-dependency message (prove the guard is non-vacuous, then remove the probe).
- Edge case: a devDependency import in a `*.test.ts` file does NOT fail (override works).

**Verification:** `bun run lint` exits 0 on the real tree; a probe undeclared import fails and a probe test-file devDep import passes.

- [x] **Unit 2: Bun install cache in CI**

**Goal:** Cache Bun's global install cache so repeat CI runs skip re-downloading the dependency graph.

**Requirements:** R2.

**Dependencies:** None.

**Files:**
- Modify: `.github/actions/setup/action.yaml`

**Approach:** Add an `actions/cache` step (pinned by SHA, matching the repo's action-pinning convention) for `~/.bun/install/cache`, keyed by `runner.os` + a hash of `bun.lock`, with an OS-scoped restore-key fallback. Place it before the `Install dependencies` step. Keep the step non-fatal on cache miss (default behavior).

**Patterns to follow:** The existing pinned-by-SHA action usage in this composite (`oven-sh/setup-bun`, `actions/setup-node`); cache-key hashing convention from other workflows.

**Test scenarios:**
- Test expectation: none (CI config) — verified via actionlint and a CI run showing a cache save then a subsequent hit.

**Verification:** `actionlint` clean; a CI run logs a Bun cache save, and a later run on the same `bun.lock` logs a cache hit.

- [x] **Unit 3: Bun-version segment in the tools-cache key**

**Goal:** Invalidate the action's aggregate tools-cache when the Bun version changes, so a stale Bun binary isn't restored.

**Requirements:** R3.

**Dependencies:** None.

**Files:**
- Modify: `src/services/setup/tools-cache.ts`, `src/services/setup/setup.ts`
- Test: `src/services/setup/tools-cache.test.ts`

**Approach:** Add a `bunVersion` field to `ToolsCacheKeyComponents`. Append a `-bun-${bunVersion}` segment to both `buildToolsCacheKey` branches and the `buildToolsRestoreKeys` outputs (additive — do not rename existing `oc-`/`omo-`/`sys-` segments, which would orphan all prior caches). Thread the resolved Bun version from the setup call site into the restore/save calls. Rebuild `dist/` (this is action-tier code).

**Patterns to follow:** The existing key composition in `buildToolsCacheKey`/`buildToolsRestoreKeys`; the grow-never-rename discipline from the harness base-version doc.

**Test scenarios:**
- Happy path: `buildToolsCacheKey` includes the `bun-<version>` segment for both enabled and disabled cache modes.
- Edge case: two different `bunVersion` values produce different keys (invalidation); same components produce a stable key.
- Edge case: `buildToolsRestoreKeys` carries the segment consistently with the primary key.

**Verification:** Updated tests pass; `bun run check-types` clean; `dist/main.js` rebuilt and in sync.

- [x] **Unit 4: Notice-collector polish**

**Goal:** Document the version comparator's metadata assumption and pin devDependency exclusion from the prod closure.

**Requirements:** R4.

**Dependencies:** None.

**Files:**
- Modify: `scripts/third-party-notices.ts`
- Test: `scripts/third-party-notices.test.ts`

**Approach:** Add a one-line comment on `compareVersions` noting it ignores prerelease/build metadata (a prerelease sorts below its release) and is safe here because license text is version-independent. Add a regression test asserting a workspace package's `devDependencies` are excluded from `collectProdClosureFromBunLock`.

**Patterns to follow:** Existing collector tests' `makeBunLock` fixture style.

**Test scenarios:**
- Happy path: a fixture workspace with a devDependency not present in any prod package's tree yields a closure that excludes that devDependency.
- Edge case: a package that is BOTH a devDependency and a transitive prod dependency is still included (prod reachability wins).

**Verification:** `bunx vitest run scripts/third-party-notices.test.ts` passes including the new test.

## System-Wide Impact

- **Interaction graph:** Unit 1 changes lint behavior repo-wide — a false positive would block all CI; the override set must cover every legitimate devDep-import location (tests, configs, scripts).
- **API surface parity:** Unit 3 changes the tools-cache key shape; the additive segment means existing caches fall through to a miss once (acceptable), not an orphaned-forever state.
- **Unchanged invariants:** Unit 3 must not rename existing key segments; Units 2/3 don't change install behavior, only caching.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| `import-x/no-extraneous-dependencies` false-positives on legitimate devDep imports in tests/configs/scripts | Explicit `devDependencies: true` overrides for those globs; prove clean `bun run lint` before PR |
| `packageDir` misconfiguration validates against the wrong manifest in the monorepo | Settle the exact `packageDir` shape against real `import-x` behavior; the non-vacuous probe test confirms it catches a real undeclared import |
| Renaming a tools-cache key segment orphans all prior caches | Additive `bunVersion` segment only; existing segments untouched |

## Sources & References

- Issue: #1004 (the follow-up cohort); related #1003 (deferred Dockerfile work)
- Related: `docs/solutions/workflow-issues/migrate-pnpm-to-bun-monorepo-2026-06-24.md`, `docs/solutions/workflow-issues/harness-base-version-source-of-truth-2026-06-12.md`
- Code: `eslint.config.ts`, `.github/actions/setup/action.yaml`, `src/services/setup/tools-cache.ts`, `src/services/setup/setup.ts`, `scripts/third-party-notices.ts`
