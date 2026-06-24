---
title: "refactor: Migrate the workspace from pnpm to Bun"
type: refactor
status: active
date: 2026-06-23
origin: docs/brainstorms/2026-06-23-pnpm-to-bun-migration-requirements.md
---

# refactor: Migrate the workspace from pnpm to Bun

## Overview

Replace pnpm@11.8.0 with Bun as the workspace package manager. The migration runs in two phases: a **spike** that verifies every blocker on a branch with real evidence, and a **cutover** that swaps the lockfile, config, scripts, CI, and Renovate only after the spike clears. Bun stays the package manager only — tests run under vitest, scripts under `node --experimental-strip-types`, and the action runtime stays Node 24 (set by `action.yaml`). The migration consolidates the toolchain (Bun already drives the harness build) and removes the `pnpm licenses list` store dependency that breaks dist regeneration on dependency PRs (see origin).

## Problem Frame

The repo runs two package managers: pnpm for the workspace and Bun 1.3.14 for the harness OpenCode build. The acute pain is a pnpm store-cache fault: on every Renovate dependency PR, the post-upgrade `pnpm run build` fails because `generate-license-file`'s `getProjectLicenses()` shells `pnpm licenses list --json --prod`, which reads pnpm's store index — and Renovate restores a partial store missing the index file for `@actions/artifact` (`ERR_PNPM_MISSING_PACKAGE_INDEX_FILE`). `generate-license-file` selects its resolver solely by `pnpm-lock.yaml` presence; removing pnpm makes it fall through to the npm/arborist resolver that reads `node_modules` directly — store-independent (see origin).

## Requirements Trace

- R1. Run the full workspace gate under Bun on a branch without committing the switch: install, build, test, lint, check-types across all packages (origin R1).
- R2. Verify `bun --filter` reproduces per-package script execution and the runtime → action/gateway/harness build order (origin R2).
- R3. Validate tsdown and vitest run correctly under Bun's install layout (origin R3).
- R4. Generate `THIRD_PARTY_NOTICES.txt` under Bun and byte-diff it against the pnpm-produced file (origin R4).
- R5. Decide linker mode (isolated vs hoisted) on evidence (origin R5).
- R6. Keep the spike throwaway-friendly with a clean fallback to the store-independent license fix (origin R6).
- R7. Move the 14 overrides to root `package.json#overrides`, resolving the two `name@range` selector overrides (origin R7).
- R8. Move `onlyBuiltDependencies`/`allowBuilds` to `trustedDependencies` (origin R8).
- R9. Create `bunfig.toml` and move `minimumReleaseAge` config there (origin R9).
- R10. Map remaining install/build-affecting workspace settings; drop obsolete knobs (origin R10).
- R11. Replace `pnpm-lock.yaml` with `bun.lock`, delete `pnpm-workspace.yaml`, update `packageManager` (origin R11).
- R12. Rewrite root + per-package scripts to Bun, preserving the build-ordering chain and the dist hidden-Unicode escape tail (origin R12).
- R13. Rewire pnpm references across the shared composite action + 6 workflows + 2 Dockerfiles (origin R13).
- R14. Switch Renovate to the Bun manager and confirm allowlist compatibility (origin R14).
- R15. Keep `simple-git-hooks` pre-commit/pre-push working under Bun via `trustedDependencies` (origin R15).

## Scope Boundaries

- Not switching the test or script runtime to Bun. Tests stay on vitest; scripts stay on `node --experimental-strip-types`. The action runtime stays Node 24.
- Not changing the harness build's existing Bun usage except where the shared composite-action swap touches it.
- Not adopting Bun catalogs in v1 (interact with the Bun 1.3 isolated-install bug tail).

### Deferred to Separate Tasks

- Store-independent license-collector rewrite (Oracle C plan): the fallback if the spike kills the migration; superseded by Bun's npm-resolver fallback if the migration proceeds.
- Retroactive edits to historical `docs/plans/*` that mention pnpm commands: annotate, don't rewrite.

## Context & Research

### Relevant Code and Patterns

- Shared composite action `.github/actions/setup/action.yaml` (40 lines) — `pnpm/action-setup` + `actions/setup-node cache: pnpm` + `pnpm install`. Called by all 6 workflows; the single highest-leverage swap.
- Root scripts `package.json:22-43` — `pnpm --filter <pkg> <script>` chains with `&&` (manual build ordering), `dist:escape-hidden-unicode` tail, `postinstall: simple-git-hooks`, `simple-git-hooks`/`lint-staged` config blocks.
- Per-package scripts use `pnpm --dir ../.. exec` (no Bun `--dir` equivalent) and `pnpm exec <bin>` (→ `bunx`): `apps/action`, `apps/workspace-agent`, `packages/runtime`, `packages/harness`, `packages/gateway`.
- `pnpm-workspace.yaml` (46 lines) — deletes entirely; `packages` → `package.json#workspaces`, `allowBuilds`+`onlyBuiltDependencies` → `trustedDependencies`, `overrides` → `package.json#overrides`, `minimumReleaseAgeExclude` → `renovate.json5`, the rest drop as Bun defaults.
- `scripts/build-action-dist.ts` — orchestrator with `pnpm exec tsc/tsdown` (→ `bunx`) and the preflight→mutator→finally slot ordering that must survive.
- `scripts/third-party-notices.ts:139` — `pnpm licenses list` (fail-soft augment; `generate-license-file` library is primary).
- `ci.yaml:118` — `pnpm sbom --sbom-format cyclonedx --prod` (no Bun equivalent).
- `deploy/gateway.Dockerfile` / `deploy/workspace.Dockerfile` — `corepack enable`, `COPY ... pnpm-lock.yaml pnpm-workspace.yaml`, `pnpm install --frozen-lockfile --filter <pkg>...`.
- `harness-release.yaml` — already installs Bun via `oven-sh/setup-bun@v2` (`1.3.14`) alongside the pnpm composite; scoped `pnpm install --filter @fro.bot/harness --frozen-lockfile`.

### Institutional Learnings

- `docs/solutions/workflow-issues/durable-dist-hidden-unicode-fix-2026-06-22.md`: the hidden-Unicode escape must stay the final `build` step and remain an allowlisted `run` script name (Renovate string-matches `postUpgradeTasks`).
- `docs/solutions/workflow-issues/committed-dist-attribution-and-sbom-hygiene-2026-06-21.md`: `THIRD_PARTY_NOTICES.txt` must stay byte-identical; the dist-diff gate is the proof; SBOM stays a non-blocking artifact.
- `docs/solutions/workflow-issues/build-pipeline-fallible-preflight-and-finally-cleanup-2026-06-22.md`: preserve preflight→mutator→finally slot ordering in `build-action-dist.ts`; fail-closed is policy not place (no env-conditional behavior).
- `docs/solutions/build-errors/tool-binary-caching-ephemeral-runners.md`: Bun-as-runtime was deleted Feb 2026 as dead code; if Bun returns as an install surface, add a `bun{version}` cache-key segment (grow the key, never rename).
- `docs/solutions/build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md`: the `gateway-smoke` CI job is the canary for monorepo resolution differences (pnpm store vs Bun hoisted) — re-verify under Bun.
- `.agents/skills/versioned-tool/SKILL.md` already pins `DEFAULT_BUN_VERSION` in `src/shared/constants.ts` (Renovate `github-releases` on `oven-sh/bun`, `extractVersionTemplate: "^bun-v(?<version>.*)$"`). Any new workspace Bun pin follows this row; coupled multi-file bumps need the dual-source idempotency guard (`cross-libc-build-and-release-safety-2026-06-14.md`).

## Key Technical Decisions

- Staged spike→cutover over big-bang: the Bun 1.3 isolated-install bug tail and several unverified-for-this-repo items make a faith-based migration the wrong risk posture (see origin).
- Bun is package manager only; Node 24 stays the action runtime. Do not reintroduce Bun-as-runtime (explicitly deleted Feb 2026).
- Renovate version blocker cleared: self-hosted Renovate is 43.234.0, above the 41.160.1 `bun.lock` lockFileMaintenance fix.
- The `dist/` build output changes on first Bun build (notice generation path differs); the cutover PR commits the regenerated `dist/` so the dist-diff gate passes.

## Open Questions

### Resolved During Planning

- Where does workspace config live under Bun? — `package.json` (`workspaces`, `trustedDependencies`, `overrides`) + new `bunfig.toml` (`minimumReleaseAge`); `pnpm-workspace.yaml` is deleted; `minimumReleaseAgeExclude` moves to `renovate.json5`.
- Does Renovate support Bun here? — Yes; 43.234.0 supports the bun manager and `bun.lock` maintenance.

### Deferred to Implementation

- Does `bun --filter <pkg>...` support pnpm's trailing-`...` transitive-dep syntax (Dockerfiles, gateway-smoke)? — Verify in spike (Unit 1/2); if not, enumerate the dependency explicitly.
- Isolated vs hoisted linker — decide on spike evidence (R5); isolated matches pnpm semantics but carries the Bun 1.3 bug tail.
- Does `actions/setup-node cache: bun` work, or use `oven-sh/setup-bun` for both Node-compat and caching? — Verify in spike.
- The two `name@range` selector overrides (`tar@^7`, `undici@^7`): Bun/npm `overrides` is bare-name only. Decide widen-to-bare (likely correct given the CVE floor) vs patch-script. Verify the resolved tree still satisfies the security floor.
- `pnpm sbom` replacement: `bunx @cyclonedx/cyclonedx-npm`, drop the SBOM step, or keep a `pnpm dlx` one-off. SBOM is a non-blocking CI artifact.
- `pnpm licenses list` in `third-party-notices.ts`: drop the fail-soft augment (library is primary) and confirm notices stay byte-identical.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

Migration phases and their gate relationship:

    Phase 1 — SPIKE (branch, no committed switch)
      U1 install+workspace gate ─┐
      U2 build-order + filter    ─┼─► decision artifact: every blocker yes/no with evidence
      U3 tsdown/vitest under Bun ─┤      │
      U4 THIRD_PARTY_NOTICES diff ┤      │ GATE: all clear?
      U5 linker decision         ─┘      │    ├─ yes ──► Phase 2 cutover
                                          │    └─ no ───► fallback: store-independent license fix (keep pnpm)
    Phase 2 — CUTOVER (only after gate)
      U6 config relocation (package.json/bunfig.toml/renovate.json5, delete pnpm-workspace.yaml, bun.lock)
      U7 scripts rewrite (root + 5 per-package, preserve build chain + escape tail)
      U8 CI rewire (composite action + 6 workflows + dist regen)
      U9 Dockerfiles + Renovate manager + final gate

## Implementation Units

### Phase 1 — Spike (branch, no committed switch)

- [ ] **Unit 1: Install + full workspace gate under Bun**

**Goal:** Prove `bun install` + build/test/lint/check-types succeed across all packages on a throwaway branch, with config relocated in-branch only.

**Requirements:** R1, R7, R8, R9, R10

**Dependencies:** None.

**Files:**
- Modify (branch-only, not for cutover commit): `package.json` (add `workspaces`, `trustedDependencies`, `overrides`; set `packageManager: bun@<DEFAULT_BUN_VERSION>`), create `bunfig.toml`, delete `pnpm-workspace.yaml`, generate `bun.lock`.

**Approach:**
- Relocate the 14 overrides to `package.json#overrides`; widen the two `name@range` selectors to bare `tar`/`undici` (verify the resolved tree still meets the CVE floor) unless the spike shows a regression.
- `trustedDependencies: ["esbuild", "simple-git-hooks", "unrs-resolver"]`.
- `bunfig.toml` `[install] minimumReleaseAge` + `minimumReleaseAgeExcludes` (seconds); decide whether `@opencode-ai/sdk@1.17.6` exclude moves here or to `renovate.json5` (origin notes it's a Renovate concept — prefer `renovate.json5`).
- Run install under the default linker; capture phantom-dependency output for U5.

**Execution note:** Spike-only branch — these edits are evidence-gathering, not the cutover commit. Keep them isolated so the fallback (keep pnpm) needs only a branch discard.

**Test scenarios:**
- Happy path: `bun install` completes; `node_modules` resolves all workspace packages.
- Happy path: build/test/lint/check-types run to completion (failures captured as blocker evidence, not silently passed).
- Edge case: `simple-git-hooks` postinstall runs (or is correctly gated by `trustedDependencies`) without the ENOENT isolated-layout crash.

**Verification:** A captured gate transcript shows install + all four scripts' outcomes; any failure is recorded as a named blocker with its cause.

- [ ] **Unit 2: Build-order and `--filter` parity**

**Goal:** Confirm `bun --filter` reproduces per-package execution and the runtime → action/gateway/harness build order, including the `...` transitive syntax used by Dockerfiles and gateway-smoke.

**Requirements:** R2

**Dependencies:** Unit 1.

**Files:** none modified — diagnostic only against the Unit 1 branch state.

**Approach:**
- Run the runtime→action→harness build chain via `bun --filter`; confirm ordering holds (or that explicit ordering is needed).
- Test `bun --filter '@fro-bot/gateway...'` and `'@fro-bot/workspace-agent...'` (transitive) against the Dockerfile/gateway-smoke usage; if `...` is unsupported, record the explicit-dependency workaround.

**Test scenarios:**
- Happy path: filtered build of `@fro-bot/runtime` then `@fro-bot/action` produces the same artifacts as the pnpm chain.
- Edge case: `--filter '<pkg>...'` resolves transitive workspace deps, or the fallback (build runtime first explicitly) is documented.

**Verification:** Build order and filter syntax confirmed (or a documented substitute), recorded in the decision artifact.

- [ ] **Unit 3: tsdown + vitest under Bun**

**Goal:** Validate the bundler and test runner work against Bun's install layout.

**Requirements:** R3

**Dependencies:** Unit 1.

**Files:** none modified — diagnostic only.

**Approach:** Run tsdown builds (runtime, action, gateway, harness, workspace-agent) and the vitest suites under Bun's `node_modules`. Confirm `bunx tsc --noEmit`, `bunx tsdown`, and `vitest run` resolve and pass.

**Test scenarios:**
- Happy path: each package's tsdown build emits the expected dist artifacts.
- Happy path: the full vitest suite passes under Bun's layout (gateway, runtime, action, scripts).
- Integration: `gateway-smoke` equivalent — build the gateway dist and confirm no bare `@fro-bot/runtime` import / resolution regression (the pnpm-store→Bun-hoist canary).

**Verification:** tsdown + vitest pass under Bun with no resolution regressions; gateway build proves monorepo linking.

- [ ] **Unit 4: THIRD_PARTY_NOTICES byte-diff**

**Goal:** Prove the committed-dist attribution stays accurate under Bun's npm/arborist resolver path.

**Requirements:** R4

**Dependencies:** Unit 1, Unit 3.

**Files:** none modified — diagnostic only (generate notices to a temp path and diff).

**Approach:**
- Generate `THIRD_PARTY_NOTICES.txt` under Bun (with `pnpm licenses list` removed so `generate-license-file` falls through to arborist) and byte-diff against the current committed file.
- Any diff (package set, ordering, license text) must be explained before trusting the cutover. Confirm the deterministic sort + EOL normalization still produce stable output under the symlinked `node_modules/.bun` layout.

**Test scenarios:**
- Happy path: generated notices byte-match the committed file, or every difference is explained and accepted.
- Edge case: arborist handles Bun's isolated `node_modules/.bun` symlink layout without dropping or duplicating prod packages.

**Verification:** A notices diff with zero unexplained differences; the attribution guarantee holds under Bun.

- [ ] **Unit 5: Linker decision + spike decision artifact**

**Goal:** Choose isolated vs hoisted on evidence and record the consolidated go/no-go.

**Requirements:** R5, R6

**Dependencies:** Units 1-4.

**Files:** Create: `docs/plans/2026-06-23-001-bun-spike-findings.md` (decision artifact).

**Approach:**
- Run `bun install --linker isolated` to surface phantom dependencies; weigh isolated (pnpm-semantics, phantom-dep protection, Bun 1.3 bug tail) vs hoisted (more stable, loses protection).
- Check the Bun 1.3 bug tail against this graph: catalog dedup (N/A — catalogs deferred), stale-store non-cleanup, no-op install performance.
- Write the decision artifact: each Unit 1-4 blocker resolved yes/no with evidence, linker choice, and the go/no-go for the cutover. If no-go, the artifact points at the store-independent license fallback.

**Test scenarios:** `Test expectation: none -- decision/spike unit; verification is the recorded evidence, not a code test.`

**Verification:** A decision artifact with every blocker resolved and an explicit go/no-go; the cutover proceeds only on go.

### Phase 2 — Cutover (spike GO confirmed; notice collector proven)

- [ ] **Unit 6a: Bun-native notice collector (replaces generate-license-file)**

**Goal:** Replace the `generate-license-file` + `pnpm licenses list` path with a `bun.lock`-based collector that reproduces the committed `THIRD_PARTY_NOTICES.txt` package set. Proven in the sub-spike; this unit finalizes and reviews it.

**Requirements:** R4 (and folds in the deferred store-independent collector).

**Dependencies:** Unit 6 config (bun.lock present).

**Files:** Modify: `scripts/third-party-notices.ts`, `scripts/third-party-notices.test.ts`.

**Approach:** `collectThirdPartyNotices()` auto-detects `bun.lock` and routes to `collectThirdPartyNoticesBun` (parse `bun.lock` packages map → prod closure via BFS over all workspace `dependencies`, nested-aware `parent/dep` keys + optional deps → read `node_modules` LICENSE/license-field → fail-closed on missing package dir → existing `formatThirdPartyNotices`). Legacy pnpm path uses dynamic `import('generate-license-file')` so arborist never loads under Bun. Remove the `pnpm licenses list` call.

**Execution note:** Already implemented in the spike branch; verify byte-faithful package-set reproduction (zero committed names missing) before trusting.

**Test scenarios:**
- Happy path: prod-closure extraction from `bun.lock` (seeds, transitive, optional, nested `parent/dep`, workspace exclusion, version dedup).
- Error path: missing package dir fails closed; missing license field falls back to "Unknown" with a warning.
- Integration: generated notices reproduce all committed package names (verified: 214/214 present, 6 explained new names).

**Verification:** `bunx vitest run scripts/third-party-notices.test.ts` passes; name-level diff vs committed file shows zero missing committed packages.

- [ ] **Unit 6: Config relocation + lockfile**

**Goal:** Land the committed config: `package.json` workspaces/trustedDependencies/overrides, `bunfig.toml`, `bun.lock`, delete `pnpm-workspace.yaml`, move `minimumReleaseAgeExclude` to `renovate.json5`.

**Requirements:** R7, R8, R9, R10, R11

**Dependencies:** Unit 5 (go).

**Files:**
- Modify: `package.json` (workspaces, trustedDependencies, overrides, packageManager), `packages/gateway/package.json` (add phantom deps `@octokit/core`, `yaml`), `.github/renovate.json5` (minimumReleaseAge exclude).
- Create: `bunfig.toml`, `bun.lock`.
- Delete: `pnpm-workspace.yaml`, `pnpm-lock.yaml`.

**Approach:** Apply the Unit 1 branch config as the real commit (isolated linker per U5). Add the two gateway phantom deps surfaced by the spike (`@octokit/core`, `yaml` — imported but undeclared, masked by pnpm hoisting). Widen the two `name@range` overrides to bare `tar`/`undici` (CVE floor makes this correct). `packageManager: bun@1.3.14` reuses the harness Bun pin; no new workspace version pin introduced.

**Test scenarios:**
- Happy path: `bun install --frozen-lockfile` succeeds against the committed `bun.lock`.
- Edge case: the security overrides resolve to versions meeting the CVE floor (spot-check `tar`, `undici`, `brace-expansion`).

**Verification:** Clean frozen install; `pnpm-workspace.yaml`/`pnpm-lock.yaml` gone; overrides enforced.

- [ ] **Unit 7: Scripts rewrite (root + per-package)**

**Goal:** Rewrite all `pnpm` script invocations to Bun, preserving the build-ordering chain, the dist hidden-Unicode escape tail, and the `simple-git-hooks`/`lint-staged` config.

**Requirements:** R12, R15

**Dependencies:** Unit 6.

**Files:**
- Modify: `package.json` (scripts, simple-git-hooks, lint-staged), `apps/action/package.json`, `apps/workspace-agent/package.json`, `packages/runtime/package.json`, `packages/harness/package.json`, `packages/gateway/package.json`, `scripts/build-action-dist.ts` (`pnpm exec` → `bunx`), `scripts/third-party-notices.ts` (drop `pnpm licenses list`, update comments), `scripts/check-dist-hidden-unicode.ts` (message).

**Approach:**
- Root scripts: `pnpm --filter` → `bun --filter`, `pnpm run` → `bun run`, drop `--no-strict-peer-dependencies` and `SKIP_INSTALL_SIMPLE_GIT_HOOKS=1`.
- Per-package: `pnpm --dir ../.. exec` → Bun `--cwd`/`run` equivalent (verified in spike); `pnpm exec` → `bunx`.
- `build-action-dist.ts`: preserve the preflight→mutator→finally slot ordering; `bunx tsc --noEmit` / `bunx tsdown`.
- `third-party-notices.ts`: remove the fail-soft `pnpm licenses list` augment; `generate-license-file`'s arborist path is primary.
- `simple-git-hooks`: `bunx lint-staged`, `bun run lint && bun run build`; `lint-staged` patterns → `bun run fix`.

**Execution note:** The hidden-Unicode escape must remain the final step of `build` and stay an allowlisted `run` script name (Renovate string-matches postUpgradeTasks).

**Test scenarios:**
- Happy path: `bun run build` produces byte-identical `dist/` (after the one-time regen commit) with the escape applied.
- Happy path: `bun run test`/`lint`/`check-types` pass.
- Edge case: pre-commit (`bunx lint-staged`) and pre-push (`bun run lint && bun run build`) hooks fire correctly.
- Integration: `build-action-dist.ts` preflight still throws before tsdown mutates `dist/`; escape runs in finally; notice write stays atomic.

**Verification:** All scripts run under Bun; `dist/` regenerates deterministically with notices + escape; hooks work.

- [ ] **Unit 8: CI rewire (composite action + 6 workflows + dist regen)**

**Goal:** Swap the shared composite action and all workflow pnpm references to Bun; commit the regenerated `dist/`.

**Requirements:** R13

**Dependencies:** Unit 7.

**Files:**
- Modify: `.github/actions/setup/action.yaml`, `.github/workflows/ci.yaml`, `auto-release.yaml`, `copilot-setup-steps.yaml`, `fro-bot.yaml`, `harness-release.yaml`, `prepare-release-pr.yaml`.
- Commit: regenerated `dist/` (one-time, first Bun build).

**Approach:**
- Composite action: replace `pnpm/action-setup` + `cache: pnpm` + `pnpm install` with `oven-sh/setup-bun` (pinned `DEFAULT_BUN_VERSION`) + Node 24 setup + `bun install --frozen-lockfile`; rename to "Setup Node.js and Bun".
- `ci.yaml`: `pnpm` → `bun` for build/lint/test/filter steps; decide `pnpm sbom` (drop, `bunx @cyclonedx/cyclonedx-npm`, or `pnpm dlx`) — SBOM is non-blocking.
- `harness-release.yaml`: collapse the duplicate Bun + pnpm setup into one `oven-sh/setup-bun`; `pnpm install --filter --frozen-lockfile` → `bun install --filter --frozen-lockfile`.
- `auto-release.yaml`: `pnpm semantic-release` → `bunx semantic-release`.
- Regenerate `dist/` under Bun and commit it so the dist-diff gate passes.

**Test scenarios:**
- Happy path: CI build job rebuilds `dist/` and the diff gate passes against the committed tree.
- Happy path: lint/test/gateway-smoke/workspace-smoke jobs pass under Bun.
- Integration: the `test-action` job (`uses: ./`) runs the action under the Bun-built dist; `harness-release` dry-run install/build succeeds.

**Verification:** All CI jobs green under Bun; dist-diff gate passes; the action runs from the Bun-built bundle.

- [ ] **Unit 9: Dockerfiles + Renovate manager + final gate**

**Goal:** Update the deploy images and switch Renovate to the Bun manager; final end-to-end verification.

**Requirements:** R14

**Dependencies:** Unit 8.

**Files:**
- Modify: `deploy/gateway.Dockerfile`, `deploy/workspace.Dockerfile`, `.github/renovate.json5`, AGENTS.md / RULES.md command docs, `docs/examples/fro-bot.yaml`.

**Approach:**
- Dockerfiles: `corepack enable` → Bun install (or keep corepack honoring `packageManager: bun@<ver>`); `COPY ... pnpm-lock.yaml pnpm-workspace.yaml` → `bun.lock`; `pnpm install --frozen-lockfile --filter <pkg>...` → `bun install --frozen-lockfile --filter <pkg>...` (verified syntax); `pnpm --filter <pkg> build` → `bun run --filter <pkg> build`.
- Renovate: `postUpgradeTasks.commands` → `['bun install', 'bun run fix', 'bun run build']`; drop the `lockFileMaintenance` rule (Bun regenerates `bun.lock` on install); confirm the bun manager picks up `bun.lock`.
- Update AGENTS.md/RULES.md COMMANDS and the user-facing `docs/examples/fro-bot.yaml`.

**Test scenarios:**
- Happy path: gateway + workspace Docker images build and boot under Bun (gateway-smoke / workspace-smoke).
- Happy path: a Renovate dependency PR completes postUpgrade install+fix+build and regenerates `dist/` with no `pnpm licenses list` failure.
- Edge case: the `lockFileMaintenance` removal doesn't break Renovate's bun.lock updates.

**Verification:** Docker images build/boot; a real Renovate dependency PR regenerates dist cleanly (the original trigger is fixed); Renovate tracks `bun.lock`.

## System-Wide Impact

- **Interaction graph:** all 6 workflows route through the shared composite action — one swap propagates everywhere; `harness-release.yaml` also has its own Bun setup to collapse.
- **Error propagation:** `build-action-dist.ts` slot ordering (preflight throws → fail-closed) must be preserved; do not let Bun's pipe semantics replace the orchestrator's controlled ordering.
- **State lifecycle risks:** first Bun build changes `dist/`; the cutover PR must commit the regenerated tree or the dist-diff + lint gates fail.
- **API surface parity:** the action runtime stays Node 24; only install/build tooling changes. `fro-bot.yaml` (`workflow_call` from harness-release) relies entirely on the composite action — verify callers still get a working env.
- **Integration coverage:** `gateway-smoke` (monorepo resolution canary) and `test-action` (runs the built action) are the cross-layer proofs that mocks won't cover.
- **Unchanged invariants:** committed `dist/` must stay byte-deterministic with accurate `THIRD_PARTY_NOTICES.txt`; the hidden-Unicode escape stays the final build step; `DEFAULT_BUN_VERSION` stays the single Bun version source.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Bun 1.3 isolated-install bug tail (stale store, no-op install perf) on this graph | U5 evaluates against the real graph; hoisted is the fallback linker |
| `name@range` overrides unsupported by Bun | Widen to bare name (CVE floor likely makes this correct); verify resolved tree meets the floor (U1) |
| `pnpm sbom` / `pnpm licenses list` have no Bun equivalent | SBOM is non-blocking (drop or `bunx`); `pnpm licenses list` is a removable fail-soft augment (U4 proves notices stay accurate) |
| First Bun build produces a different `dist/` and fails the diff gate | Commit the regenerated `dist/` in the cutover PR (U8) |
| Renovate silently drops a non-allowlisted postUpgrade command | Keep commands to allowlisted names (`bun install`, `bun run fix`, `bun run build`); escape stays inside `build` |
| `simple-git-hooks` postinstall crashes under Bun isolated layout | Add to `trustedDependencies`; confirm the pinned version includes the Bun-fix (U1/U7) |
| Spike work contaminates the keep-pnpm fallback | Spike edits stay branch-isolated; fallback is a branch discard (R6) |

## Sources & References

- **Origin document:** docs/brainstorms/2026-06-23-pnpm-to-bun-migration-requirements.md
- Migration surface inventory: shared composite action `.github/actions/setup/action.yaml`; root + per-package `package.json` scripts; 6 workflows; `pnpm-workspace.yaml`; `.github/renovate.json5`; `deploy/*.Dockerfile`; `scripts/build-action-dist.ts`, `scripts/third-party-notices.ts`.
- Learnings: `docs/solutions/workflow-issues/{durable-dist-hidden-unicode-fix,committed-dist-attribution-and-sbom-hygiene,build-pipeline-fallible-preflight-and-finally-cleanup}-2026-06*.md`; `docs/solutions/build-errors/{tool-binary-caching-ephemeral-runners,gateway-docker-runtime-resolution-crash-loop-2026-05-31}.md`; `.agents/skills/versioned-tool/SKILL.md`.
- Renovate version evidence: `RENOVATE_VERSION: 43.234.0` (run 28063498652).
