---
title: 'Migrating a pnpm workspace to Bun: diagnostics, spike-then-cutover, and the semantics that bite'
date: 2026-06-24
category: workflow-issues
module: workspace tooling
problem_type: workflow_issue
component: tooling
severity: high
applies_when:
  - 'A CI runner with a partial-restore model (Renovate, cache restore) breaks a tool that reads the package manager store rather than the lockfile'
  - 'Migrating a multi-package workspace from pnpm to Bun (or any package-manager swap with a stricter linker / frozen-lockfile model)'
  - 'A Docker build runs a filtered install plus a build that typechecks test files'
  - 'A license/SBOM generator shells into a package-manager CLI instead of reading the lockfile'
  - 'New toolchain version literals must stay Renovate-tracked across multiple files'
tags:
  - bun
  - pnpm
  - renovate
  - migration
  - monorepo
  - hoisted-linker
  - third-party-notices
  - fail-closed
---

# Migrating a pnpm workspace to Bun

## Context

A recurring Renovate failure forced this migration. On every dependency PR, the post-upgrade `pnpm run build` aborted because the license collector (`generate-license-file`, which shells `pnpm licenses list`) read pnpm's content-addressable store — and Renovate restored a *partial* store missing the package index file for at least `@actions/artifact` (`ERR_PNPM_MISSING_PACKAGE_INDEX_FILE`). Lockfile-only resolution reported the store complete (`reused 0, downloaded 0, added 0`), so `pnpm install --force` was a proven no-op. The packages were present and the bundle built; only the store read failed, and the fail-closed license preflight then aborted `dist/` regeneration.

The corruption lived in Renovate's restored store — upstream state the repo cannot reproduce or control. Three symptom-level fixes were merged and reverted before the real cause surfaced. The durable fix was to stop depending on the store at all: migrate the workspace from pnpm 11.8 to Bun 1.3.14 and replace the license collector with one that reads `bun.lock` directly. This shipped as a single cutover PR (#1002) backed by a spike, and was proven in production when the next Renovate run regenerated `dist/` cleanly with zero store errors.

## Guidance

### 1. Surface real stderr before attempting any fix

A fail-closed `catch` that throws a generic message makes an environment-specific failure un-diagnosable. Three wrong fixes (harness install shims, `pnpm install --force`, an unshipped plan) were tried against a vague "license collection failed" before a diagnostics commit surfaced the actual `ERR_PNPM_MISSING_PACKAGE_INDEX_FILE`. When a toolchain command fails, join `stderr`, `stdout`, `exitCode`, and `signal` into the thrown error *before* remediation:

```ts
export function formatChildProcessError(error: unknown): string {
  if (error == null || typeof error !== 'object') return String(error)
  const record = error as {message?: unknown; stderr?: unknown; stdout?: unknown; code?: unknown; signal?: unknown}
  const parts: string[] = []
  if (typeof record.message === 'string') parts.push(record.message)
  if (record.code != null) parts.push(`exitCode=${String(record.code)}`)
  if (record.signal != null) parts.push(`signal=${String(record.signal)}`)
  const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : ''
  if (stderr) parts.push(`stderr:\n${stderr}`)
  const stdout = typeof record.stdout === 'string' ? record.stdout.trim() : ''
  if (stdout) parts.push(`stdout:\n${stdout}`)
  return parts.length > 0 ? parts.join('\n') : String(error)
}
```

A fail-closed catch is not "done" until its failure path is *more* diagnostic than its success path. This matters most for CI-only failures you cannot reproduce locally — the stderr is your only evidence.

### 2. Spike-then-cutover for risky toolchain migrations

Do not commit the cutover until a throwaway-branch spike produces a go/no-go artifact. The spike must verify every load-bearing surface: install, filtered builds, the bundler, the test runner, the linker choice, and — critically — a **byte-faithful diff of any attribution-critical output** (here, that the Bun-native collector reproduced the full committed `THIRD_PARTY_NOTICES.txt` package set). For each divergence, decide tolerable (size/ordering) vs blocking (missing attribution, broken import); a single blocking item is a no-go. If the spike fails, you fall back having spent only cheap spike time.

Stage the cutover as a small stack of revert-able PRs, not one big-bang diff — each revert is a learning artifact and keeps the bisect tractable.

### 3. Bun-vs-pnpm semantics that bite at cutover

These four divergences are invisible until cutover and not called out in the Bun docs:

**(a) `--frozen-lockfile` validates the full workspace, even for `--filter`.** Bun checks the complete `workspaces` manifest set declared in `bun.lock` even when you only build one package. A Docker build that copies partial manifests fails with `lockfile had changes, but lockfile is frozen`. Copy **every** workspace `package.json` before the install. (pnpm tolerated partial manifests.)

**(b) A `--filter` install omits root devDependencies the build needs.** The package `build` runs `tsc -p tsconfig.json` over `.test.ts` files that import `vitest`; a filtered install omits those devDeps, so the typecheck fails `TS2307: Cannot find module 'vitest'` in Docker while passing locally with a full install. Use a full `bun install --frozen-lockfile` in Docker; keep `--filter` for the *build step*, not the *install step*.

**(c) Bun config lives in `package.json` + `bunfig.toml`, not a workspace yaml.** `pnpm-workspace.yaml` overrides/`onlyBuiltDependencies`/`minimumReleaseAge` map to `package.json` (`workspaces`, `overrides`, `trustedDependencies`, `packageManager`) plus `bunfig.toml` (`linker`, `minimumReleaseAge`).

**(d) Hoisted vs isolated linker — TS2883 is the canary.** Bun's default isolated linker places packages under non-portable `node_modules/.bun/<pkg>@<hash>/` paths, which makes TypeScript unable to name deep dependency types — `TS2883` on a root `eslint.config.ts` that calls `defineConfig` from `@bfra.me/eslint-config` (which references `@eslint/core` internals). It also creates duplicate dependency instances. `linker = "hoisted"` fixes it cleanly but loses phantom-dependency protection. (Attempted alternatives both fail: an `as Linter.Config[]` cast hits `TS2352` because `FlatConfigComposer` is not array-assignable; excluding the config from `tsconfig.json` breaks eslint's type-aware lint with "not found by the project service".) A clean relink requires `rm -rf node_modules apps/*/node_modules packages/*/node_modules && bun install` — changing the linker in `bunfig.toml` is a no-op if `node_modules` is already linked.

### 4. Store-independent license attribution: read the lockfile, walk the closure

A collector that depends on a package-manager store inherits the store's failure modes. Read `bun.lock` directly, BFS the prod closure across all workspace packages (traversing `dependencies` + `optionalDependencies` + `peerDependencies`, resolving Bun's nested `parent/dep` keys), read the `LICENSE`/`LICENCE`/`COPYING`/`NOTICE` file from `node_modules/<pkg>/`, and fail closed when a prod package's directory is missing. Validate `lockfileVersion` so a future format bump fails with a clear error rather than silently wrong output. The lockfile is the contract `install` produces; the store is a cache that can be incomplete, corrupt, or evicted. This pattern generalizes to any SBOM/attribution task that currently shells into a package manager.

### 5. Renovate version-tracking discipline carries to the new toolchain

Every new version literal in the new toolchain needs a Renovate `customManager` or it strands silently on the next bump. The migration added four `oven-sh/bun` trackers — both Dockerfile `ARG BUN_VERSION`, the composite-action `default:`, and the root `packageManager: "bun@X.Y.Z"` — each file-scoped via `managerFilePatterns` and capped with `allowedVersions` to stay in lockstep with the harness's validated Bun. The mechanical audit: every `X.Y.Z` literal in a non-`node_modules` file is a `customManager` candidate.

## Why This Matters

Toolchain migrations are high-blast-radius, low-frequency changes — you do them rarely enough to forget the lessons, and each touches enough surfaces that a big-bang cutover makes the bisect useless. The original sin here was depending on a corruptible store from CI code; the fix was reading the lockfile contract instead. The spike converts every "unknown until cutover" into a yes/no answer *before* you commit, and the staged PR stack gives cheap revert points. And the failure was never at the code surface — it was at the diagnostic surface: every minute on a wrong fix is a minute not spent reading the stderr that would have named the cause.

## When to Apply

- **Stderr-first** when a fail-closed catch wraps a toolchain command in a CI-only environment, or three-plus fixes haven't stuck against a vague message.
- **Spike-then-cutover** when a migration touches more than ~3 surfaces and produces a byte-diff-critical artifact.
- **Bun-vs-pnpm semantics** for any package-manager swap to a stricter linker/frozen-lockfile model, especially with deep-type imports in root config files or a Docker build that typechecks tests.
- **Lockfile-driven collector** when attribution shells into the package manager or has failed on a partial/incomplete-install error.
- **Renovate tracking** whenever a new tool introduces version literals across multiple files.

Do **not** reach for the full pattern when the toolchain already has a known-good store and the change is a minor bump, or when the blast radius is one script and one CI step.

## Examples

**The diagnostic trail (one PR if stderr had come first):**

| PR | Approach | Outcome |
| --- | --- | --- |
| harness shims | commit install-time bin/postinstall shims | reverted — never repaired the store |
| #997 | surface real stderr on license-collection failure | right diagnostic — revealed `ERR_PNPM_MISSING_PACKAGE_INDEX_FILE` |
| #998 | `pnpm install --force` postUpgrade | reverted (#999) — no-op against the partial store |
| #1002 | replace the store with a lockfile-driven collector (Bun migration) | the fix — no store, no corruption |

**The load-bearing Dockerfile change (pnpm → Bun):**

```dockerfile
# Before (pnpm): partial manifests + filtered install
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/runtime/ packages/runtime/
COPY packages/gateway/ packages/gateway/
RUN pnpm install --frozen-lockfile --filter @fro-bot/gateway...

# After (Bun): all manifests + full install
ARG BUN_VERSION=1.3.14
RUN npm i -g bun@${BUN_VERSION}
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/action/package.json apps/action/package.json
COPY apps/workspace-agent/package.json apps/workspace-agent/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/harness/package.json packages/harness/package.json
RUN bun install --frozen-lockfile
COPY packages/runtime/ packages/runtime/
COPY packages/gateway/ packages/gateway/
RUN bun run --filter @fro-bot/runtime build
RUN bun run --filter @fro-bot/gateway build
```

**Config relocation (`pnpm-workspace.yaml` deleted):**

```json5
// package.json
{
  "workspaces": ["apps/*", "packages/*"],
  "packageManager": "bun@1.3.14",
  "overrides": {"brace-expansion": ">=5.0.6", "undici": ">=7.24.0"},
  "trustedDependencies": ["esbuild", "simple-git-hooks", "unrs-resolver"]
}
```

```toml
# bunfig.toml
[install]
linker = "hoisted"            # isolated .bun/ paths break tsc TS2883 on eslint.config.ts
minimumReleaseAge = 259200    # 3 days
minimumReleaseAgeExcludes = []
```

## Related

- [Committed-bundle attribution and SBOM hygiene](committed-dist-attribution-and-sbom-hygiene-2026-06-21.md) — the attribution policy this migration preserves; the migration replaces its `pnpm sbom` / `pnpm licenses list` primitives.
- [Build-pipeline fallible preflight and finally cleanup](build-pipeline-fallible-preflight-and-finally-cleanup-2026-06-22.md) — the preflight→mutator→finally lifecycle the migration kept unchanged.
- [Durable dist hidden-Unicode fix](durable-dist-hidden-unicode-fix-2026-06-22.md) — the escape-as-final-build-step + Renovate allowlist constraint the new `postUpgradeTasks` had to honor.
- [Versioned-tool config plugin pattern](../best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md) — the single-source version-pin discipline extended to the workspace Bun pin.
- Plan: `docs/plans/2026-06-23-001-refactor-pnpm-to-bun-migration-plan.md` — the design record for PR #1002.
- Follow-ups: #1003 (Dockerfile verified-binary install, runtime image trim), #1004 (CI bun cache, phantom-dependency lint guard, notice-collector polish).
