---
date: 2026-06-23
topic: pnpm-to-bun-migration
---

# Migrate the workspace from pnpm to Bun

## Summary

Replace pnpm with Bun as the workspace package manager via a staged migration: a spike phase verifies every blocker on a branch with real evidence, and the cutover (lockfile, CI, Renovate) lands only after the spike clears. The migration consolidates the toolchain on Bun (already used for the harness build), and removes the `pnpm licenses list` store dependency that breaks dist regeneration on dependency PRs.

---

## Problem Frame

The repo runs two package managers: pnpm@11.8.0 for the workspace and Bun 1.3.14 for the harness OpenCode build. That split means two install models, two version pins, and two mental models for one codebase.

The acute pain is a pnpm store-cache fault. On every Renovate dependency PR, the post-upgrade `pnpm run build` fails because `generate-license-file`'s `getProjectLicenses()` shells `pnpm licenses list --json --prod`, which reads pnpm's content-addressable store index — and Renovate restores a partial store missing the index file for at least `@actions/artifact@6.2.1` (`ERR_PNPM_MISSING_PACKAGE_INDEX_FILE`). The packages are present and the bundle builds; only the store read fails, and the fail-closed license preflight then aborts dist regeneration. `pnpm install --force` was tried and proved a no-op against this corruption. This blocks committed-`dist/` updates on every dependency PR.

The corruption lives in Renovate's restored store cache — upstream state the repo cannot reproduce or control. So the failure is recurring, environment-specific, and not fixable by configuring pnpm.

---

## Requirements

**Spike phase (gate before cutover)**

- R1. Run the full workspace gate under Bun on a branch without committing the package-manager switch: `bun install`, build, test, lint, check-types across all workspace packages.
- R2. Verify `bun run --filter` (or `--workspaces`) reproduces the current per-package script execution, including dependency-respecting build order for `@fro-bot/runtime` → `@fro-bot/action` / `@fro-bot/gateway` / `@fro.bot/harness`.
- R3. Validate that tsdown (bundler) and vitest run correctly when invoked under Bun's install layout. The repo keeps running scripts under `node --experimental-strip-types`; the spike confirms whether tools that previously resolved through pnpm's layout still resolve under Bun's.
- R4. Generate `THIRD_PARTY_NOTICES.txt` under Bun and byte-diff it against the current pnpm-produced file. Any difference must be explained (package set, ordering, license text) before the cutover is trusted.
- R5. Decide the linker mode (isolated vs hoisted) on evidence: run `bun install --linker isolated` to surface phantom dependencies, and confirm whether the Bun 1.3 isolated-install bug tail (catalog dedup, stale-store non-cleanup, no-op install performance) affects this graph.
- R6. The spike is throwaway-friendly: if any blocker proves fatal, fall back to making the license collector store-independent (keep pnpm) without having committed the switch.

**Config relocation**

- R7. Move the 14 dependency overrides from `pnpm-workspace.yaml#overrides` to root `package.json#overrides`, confirming each is top-level (Bun does not support pnpm's nested/selector overrides). Most are top-level style (`brace-expansion: '>=5.0.6'`); two use pnpm's `name@range` selector syntax (`tar@^7: '>=7.5.11'`, `undici@^7: '>=7.24.0'`) — confirm Bun's override syntax expresses these or rewrite them.
- R8. Move `onlyBuiltDependencies`/`allowBuilds` (`esbuild`, `simple-git-hooks`, `unrs-resolver`) to `trustedDependencies` in root `package.json`. Bun runs no lifecycle scripts unless a dependency is trusted; the `trustedDependencies` array replaces (not extends) Bun's built-in allowlist.
- R9. Create `bunfig.toml` (no such file exists today) and move `minimumReleaseAgeExclude` to Bun's native `minimumReleaseAge` + `minimumReleaseAgeExcludes` there (seconds, not minutes/version-strings as pnpm uses). Define how `bunfig.toml` coexists with the existing root config files.
- R10. Map the remaining install/build-affecting `pnpm-workspace.yaml` settings: `shamefullyHoist` → linker choice (R5), `autoInstallPeers`/`strictPeerDependencies:false` → Bun defaults. Treat purely legacy knobs (`ignoreWorkspaceRootCheck`, `savePrefix`, `shellEmulator`) as drop-if-obsolete cleanup, not cutover blockers. (`allowBuilds` is owned by R8.)

**Cutover**

- R11. Replace `pnpm-lock.yaml` with `bun.lock` (text format), remove `pnpm-workspace.yaml`, and set/remove `packageManager` appropriately.
- R12. Rewrite the workspace scripts in root `package.json` from `pnpm --filter <pkg> <script>` to the Bun equivalent, preserving the `dist:escape-hidden-unicode` / `dist:check-hidden-unicode` build/lint tails.
- R13. Rewire the ~16 pnpm references across the 6 CI/workflow files (`ci.yaml`, `auto-release.yaml`, `copilot-setup-steps.yaml`, `fro-bot.yaml`, `harness-release.yaml`, `prepare-release-pr.yaml`) to Bun setup + install + run.
- R14. Switch Renovate to the Bun manager: update `.github/renovate.json5` postUpgradeTasks to Bun commands and confirm the self-hosted action's allowedCommands accept them. Lockfile maintenance for `bun.lock` is available (the self-hosted Renovate is 43.234.0, above the 41.160.1 fix).
- R15. Pre-commit (`lint-staged`) and pre-push (`pnpm lint && pnpm build`) hooks via `simple-git-hooks` keep working under Bun, on a `simple-git-hooks` release that includes the Bun isolated-layout postinstall fix.

---

## Success Criteria

- A Renovate dependency PR completes its post-upgrade build and regenerates `dist/` with accurate `THIRD_PARTY_NOTICES.txt`, with no `pnpm licenses list` / store-index failure.
- The workspace installs, builds, tests, and lints under Bun with parity to the current pnpm gate; CI is green across all 6 workflows.
- One package manager governs the workspace; the harness build and the workspace install share the same Bun toolchain.
- A downstream planner has a verified blocker list (each spike item resolved yes/no with evidence) so the cutover plan executes without re-discovering Bun's behavior.

---

## Scope Boundaries

- Not switching the test or script RUNTIME to Bun. Tests run under vitest, scripts under `node --experimental-strip-types`. This migration is package-manager only; Bun-as-runtime is a separate, larger decision.
- Not changing the harness build's existing Bun usage — it already uses Bun and is out of scope except where workspace install changes touch it.
- Not adopting Bun catalogs in v1. Catalogs interact with the Bun 1.3 isolated-install bug tail (peer placement, dedup); defer until the migration is stable.
- Not pursuing the store-independent license-collector rewrite if the migration proceeds — Bun's npm-resolver fallback supersedes it. (It remains the fallback if the spike kills the migration.)

---

## Key Decisions

- Staged over big-bang: the Bun 1.3 isolated-install bug tail and several unverified-for-this-repo items (tsdown/vitest under Bun, build ordering, license output under the symlinked layout) make a faith-based full migration the wrong risk posture. Spike-verify, then cut over.
- Renovate version blocker cleared: the self-hosted Renovate is 43.234.0, well above the 41.160.1 release that fixed `bun.lock` lockFileMaintenance. The single most likely silent breakage is a non-issue.
- The license-collector fix and the migration solve the same root cause; the migration is preferred because it also delivers consolidation and supply-chain feature upgrades, but it must clear the spike first.

---

## Dependencies / Assumptions

- The self-hosted Renovate (`bfra-me/.github` renovate workflow, currently pinned `v4.16.28`, running Renovate 43.234.0) supports the Bun manager and `bun.lock` maintenance. The repo cannot edit the action's `allowedCommands` allowlist, only which allowed commands appear in postUpgradeTasks — confirm Bun commands are within the allowlist during the spike.
- `generate-license-file` resolves the package manager solely by `pnpm-lock.yaml` presence; with pnpm-lock.yaml removed it falls through to the npm/arborist resolver (reads `node_modules`, store-independent). The arborist + Bun isolated-layout (`node_modules/.bun` symlinks) combination is unverified for notice output — R4 validates it.
- Bun 1.3.14 is installed locally and already drives the harness build. The harness pins `HARNESS_BUN_VERSION = '1.3.14'` to exactly match upstream `anomalyco/opencode`'s `packageManager` field at the harness base version. Making Bun the workspace package manager creates a version coupling: decide whether the workspace Bun version must equal the harness pin, or whether the two pins may diverge (and how). A forced lockstep means a future harness/upstream bump also bumps the workspace toolchain.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R5][Technical] Isolated vs hoisted linker — isolated matches pnpm semantics and preserves phantom-dependency protection but carries the Bun 1.3 isolated bug tail; hoisted is more stable but loses that protection. Decide on spike evidence.
- [Affects R2][Needs research] Does `bun run --filter` guarantee dependency-topological build ordering equivalent to `pnpm -r`, or must the build script enforce order explicitly?
- [Affects R3][Needs research] Confirm tsdown/rolldown and vitest run cleanly under Bun's install layout for this repo's configs.
- [Affects R13][Technical] Whether any CI workflow depends on pnpm-specific behavior (cache action keys, `pnpm exec`, frozen-lockfile semantics) that needs a non-mechanical Bun translation.
- [Affects R15][Technical] Confirm the pinned `simple-git-hooks` version includes the Bun isolated-layout postinstall fix, or bump it.

---

## Sources / Research

- Renovate self-hosted version: `RENOVATE_VERSION: 43.234.0` (run 28063498652 logs) — above the 41.160.1 `bun.lock` lockFileMaintenance fix.
- `generate-license-file@4.2.1` resolver: `node_modules/.pnpm/generate-license-file@4.2.1_.../src/lib/internal/resolveDependencies/index.js` (`resolvePackageManager` checks only `pnpm-lock.yaml`) and `.../utils/pnpmCli.utils.js` (`execAsync("pnpm licenses list --json --prod")`).
- Current pnpm config surface: `pnpm-workspace.yaml` (overrides, onlyBuiltDependencies, minimumReleaseAgeExclude, shamefullyHoist, autoInstallPeers, strictPeerDependencies), `package.json` (`packageManager: pnpm@11.8.0`, workspace scripts, `workspace:*` deps).
- Confirmed root cause of the Renovate failure: `ERR_PNPM_MISSING_PACKAGE_INDEX_FILE` for `@actions/artifact@6.2.1`, surfaced by the stderr diagnostics in PR #997; `pnpm install --force` refuted as a no-op (run 28063498652).
- Bun feature parity (workspaces, `workspace:*`, text `bun.lock` default since 1.2, `trustedDependencies`, native `minimumReleaseAge`, security-scanner API, isolated installs default since 1.3) and migration risks (isolated-install bug tail, no-op install perf regressions, simple-git-hooks/lint-staged caveats) — 2026 research pass; validate the unverified items in the spike.
