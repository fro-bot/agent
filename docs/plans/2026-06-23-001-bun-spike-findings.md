# Bun Migration — Spike Findings (Phase 1)

**Date:** 2026-06-23
**Branch:** `feat/pnpm-to-bun-migration`
**Plan:** `docs/plans/2026-06-23-001-refactor-pnpm-to-bun-migration-plan.md`
**Bun version:** 1.3.14

## Decision: GO (with one new work item folded in)

The migration is viable. Every blocker has a confirmed path. One finding (notice generation) turns the deferred store-independent license collector into a **required** Bun-native unit, not a fallback.

## Sub-spike: Bun-native notice collector — PROVEN

A `bun.lock`-based collector was built and verified to reproduce the committed attribution. Independent verification (name-level set comparison against `dist/THIRD_PARTY_NOTICES.txt`):
- **Zero committed package names missing** — all 214 committed packages present in the Bun-native output.
- 6 genuinely-new names (`anynum`, `buffers`, `eastasianwidth`, `get-east-asian-width`, `is-unsafe` — transitive deps of version-bumped packages — plus `yaml`, the gateway phantom dep added this branch).
- Version-level differences are pure drift (newer versions resolved in `bun.lock` vs the days-old committed pnpm file), not a collector defect.
- `buffers@0.1.1` has no license file/field upstream → "Unknown" fallback (same outcome under any tool).
- Approach: parse `bun.lock` (`packages` map), collect prod seeds from all workspace `dependencies`, BFS with nested-aware (`parent/dep` key) resolution including optional deps; read LICENSE/license-field from `node_modules`; fail-closed on missing package dir.

The collector is the load-bearing cutover unit and is now de-risked.

## Blocker resolution (each yes/no with evidence)

| Item | Result | Evidence |
|------|--------|----------|
| U1 `bun install` | ✅ GREEN | 1874 packages installed, exit 0; `bun.lock` (310 KB text, 1264 entries) created; `node_modules/@fro-bot/runtime` symlinks correctly to the workspace package. |
| U1 config relocation | ✅ GREEN | `workspaces` + `trustedDependencies` + `overrides` in `package.json`, `bunfig.toml` for `minimumReleaseAge`, `pnpm-workspace.yaml` deleted — install clean. |
| U1 `trustedDependencies` / simple-git-hooks | ✅ GREEN | `simple-git-hooks` postinstall fired (skipped via env in spike) with no isolated-layout ENOENT crash. |
| U2 `bun run --filter` | ✅ GREEN | Syntax is `bun run --filter <pkg> <script>` (run BEFORE --filter). `bun --filter <pkg> run <script>` fails "No packages matched the filter". Bun sees all 5 workspace packages. |
| U2 build order | ✅ GREEN | runtime → action/gateway chain builds in order via filtered runs. `--filter '<pkg>...'` transitive syntax: deferred to cutover verification (Dockerfiles); explicit ordering is the fallback. |
| U3 tsdown | ✅ GREEN | runtime, action (via bunx), gateway (via bunx) tsdown builds succeed under Bun. |
| U3 vitest | ✅ GREEN | runtime suite 449 tests pass, exit 0, under Bun's layout. |
| U3 phantom deps | ⚠️ BOUNDED | gateway imports `@octokit/core` + `yaml` without declaring them (worked under pnpm hoisting). Adding both to `packages/gateway/package.json` makes gateway tsc pass. **Only the gateway is affected** — action, workspace-agent, harness, runtime tsc-clean. |
| U4 THIRD_PARTY_NOTICES | ❌→PATH | `generate-license-file`'s npm/arborist resolver finds only ~10-11 DIRECT root deps under Bun (committed file has 214 packages / 800 KB; Bun-generated ~19-22 KB). Tested both isolated AND hoisted linkers — arborist `loadActual()` needs npm's lockfile/nested metadata to build the dep graph, which Bun doesn't provide. **Viable path confirmed:** `bun.lock` has the full resolved tree (1264 entries); a Bun-native collector reads it + node_modules LICENSE files. |
| U5 linker | DECIDE | Default **isolated** retained. Hoisted gave 594 flat dirs but did NOT fix arborist; isolated matches pnpm semantics + phantom-dep protection. No Bun 1.3 isolated bug tail observed on this graph (catalogs deferred, install fast). |

## Consequence for Phase 2

The deferred "store-independent license collector" is no longer a fallback — it becomes a **required cutover unit**: a Bun-native notice generator that reads `bun.lock`'s resolved `packages` map (prod-filtered) and reads each package's LICENSE/NOTICE from `node_modules`, replacing `generate-license-file` + `pnpm licenses list` entirely. This is the only path that reproduces the 214-package committed-dist attribution under Bun.

Everything else (install, workspace resolution, filtered builds, tsdown, vitest) works under Bun with no fundamental gaps — the remaining cutover work is mechanical script/CI rewrites plus the two phantom-dep declarations.

## Branch state (spike, not for cutover commit as-is)

Modified for evidence only: `package.json` (workspaces already present; added overrides/trustedDependencies/packageManager), `bunfig.toml` (new), `packages/gateway/package.json` (added 2 phantom deps), `bun.lock` (new), `pnpm-workspace.yaml` (deleted), `pnpm-lock.yaml` (moved to `/tmp` — restore if no-go).
