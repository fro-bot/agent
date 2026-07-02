---
title: "feat: Flip the action default to the harness OpenCode binary"
type: feat
status: done
date: 2026-06-13
deepened: 2026-06-13
---

> **Status: done.** All 6 units shipped (PR #884) — `FALLBACK_VERSION`/`DEFAULT_OPENCODE_VERSION` decoupled, build-metadata-safe version compare, harness-aware tool-cache identity, retargeted Renovate manager, `sync-default-version` self-update job, and dist rebuild — verified on `main`.

# feat: Flip the action default to the harness OpenCode binary

## Overview

The GitHub Action already has the capability (PR #874) to download and verify a harness-pinned OpenCode binary from the `fro-bot/agent` GitHub Release, failing closed on a harness download/verify failure. The first harness release is now published and verified live: `v1.17.3+harness.2c9cdbd2` with `opencode-*` assets + `SHA256SUMS`. This plan flips the action's default so every Fro Bot run downloads and runs the patched harness binary instead of stock OpenCode.

This is the consumer cutover for the action tier only. The workspace executor image and gateway stay on stock OpenCode (C2 scope).

## Problem Frame

Flipping the default is not a single constant change. Two latent issues (surfaced by Oracle review, both verified at source) must be fixed first, or the flip would silently run stock OpenCode and defeat the fail-closed design:

1. **Tool-cache collision.** `@actions/tool-cache` runs `semver.clean()` on the version, which strips SemVer build metadata: `semver.clean('1.17.3+harness.2c9cdbd2')` → `'1.17.3'` (verified). So the harness binary and stock `1.17.3` collide in the tool-cache namespace. A pre-existing stock `opencode/1.17.3/` cache entry could satisfy a harness lookup, silently running stock.
2. **`FALLBACK_VERSION` aliases the default.** `FALLBACK_VERSION = DEFAULT_OPENCODE_VERSION` (verified, `src/services/setup/opencode.ts:16`). Flipping the default would make the stock fallback harness too, breaking the "fall back to a known stable stock version" contract for non-harness paths.

## Requirements Trace

- R1. Every action run that does not override `opencode-version` downloads and runs the harness binary `1.17.3+harness.2c9cdbd2`.
- R2. The harness binary must not collide with stock OpenCode in the tool cache; a stock `1.17.3` cache entry must never satisfy a harness lookup (and vice-versa).
- R3. The non-harness fallback path continues to fall back to a stable stock version (not a harness version).
- R4. `FALLBACK_VERSION` stays Renovate-tracked against stock `anomalyco/opencode` (existing manager, retargeted). `DEFAULT_OPENCODE_VERSION` is NOT Renovate-tracked; instead the harness-release workflow self-updates it via an auto-PR on successful publish.
- R5. The fail-closed posture for an explicit harness pin is preserved (harness download/verify failure throws; no silent stock fallback).

## Scope Boundaries

- The `@opencode-ai/sdk` pin stays stock `1.17.3` (harness patches the binary, not the SDK).
- The workspace executor image (`deploy/workspace.Dockerfile` `ARG OPENCODE_VERSION`) stays stock `1.17.3`.

### Deferred to Separate Tasks

- Workspace/gateway cutover to the harness binary (musl builds): C2, separate plan.
- OpenCode 1.17.4 base bump: B, separate plan.

## Context & Research

### Relevant Code and Patterns

- `packages/runtime/src/shared/constants.ts:27` — `DEFAULT_OPENCODE_VERSION` (the constant to flip).
- `src/services/setup/opencode.ts:15-16` — `FALLBACK_VERSION = DEFAULT_OPENCODE_VERSION` (decouple).
- `src/services/setup/opencode.ts:104-115` — harness routing (`isHarnessVersion`, `buildDownloadUrl`).
- `src/services/setup/opencode.ts:260,330` — `toolCache.find` / `toolCache.cacheDir` (cache identity).
- `src/services/setup/setup.ts:87` — cache-hit `toolCache.find('opencode', version)` (cache identity).
- `src/services/setup/adapters.ts:5-12` — `toolCache` adapter passthrough to `@actions/tool-cache`.
- `.github/renovate.json5:24-31` — the customManager to retarget to `FALLBACK_VERSION`.

### Institutional Learnings

- Memory 5362: keep `FALLBACK_VERSION` Renovate-tracked (stock), add a separate manager for the harness `DEFAULT_OPENCODE_VERSION`; tool-cache `-harness` identity required.
- Memory 5361: the published harness release is `v1.17.3+harness.2c9cdbd2`.

## Key Technical Decisions

- **Two independent constants, two Renovate managers (per Marcus directive, overriding Oracle's "remove the manager").**
  - `FALLBACK_VERSION = '1.17.3'` (plain stock `X.Y.Z`) — the existing customManager (lines 24-31) is retargeted from `DEFAULT_OPENCODE_VERSION` to `FALLBACK_VERSION`, still tracking `anomalyco/opencode` stock releases.
  - `DEFAULT_OPENCODE_VERSION = '1.17.3+harness.2c9cdbd2'` (full harness form) — a new customManager matches this constant and tracks `fro-bot/agent` github-releases so harness releases get proposed.
  - Independent literals (not derived) avoid the coupling-mismatch where a stock-base bump would point the default at a not-yet-built harness release.
- **Tool-cache identity uses a `-harness` (hyphen) form.** Convert `1.17.3+harness.2c9cdbd2` → `1.17.3-harness.2c9cdbd2` for `toolCache.find()` / `toolCache.cacheDir()` only (a prerelease form that `semver.clean` preserves and that does not collide with stock `1.17.3`). Keep the raw `+harness` version for download URLs, checksum lookup, outputs, and logs.
- **Fail-closed stays.** No change to the throw-on-harness-failure logic; only `FALLBACK_VERSION` is decoupled so non-harness paths still have a stock fallback.

## Open Questions

### Resolved During Planning

- Should the Renovate manager be removed (Oracle) or kept? — Kept and split: retarget existing to `FALLBACK_VERSION`, add a new one for the harness `DEFAULT_OPENCODE_VERSION` (Marcus directive).
- Does the SDK pin change? — No, stays stock `1.17.3`.

### Resolved During Deepening

- **Can Renovate auto-order `+harness.<sha>` tags? No (researched).** Renovate's `semver`/`semver-coerced` versioning follows SemVer strictly, which treats build metadata (`+harness.<sha>`) as **non-ordering** — so `1.17.3+harness.a` and `1.17.3+harness.b` compare equal and no update is ever proposed. `regex:` versioning *can* order by the suffix, but our suffix is a **non-monotonic LLM-merge commit SHA**, so lexical ordering would be meaningless/brittle (could propose an older release as "newer"). The `github-releases` datasource uses the git **tag** (not release title) and `extractVersionTemplate: '^v?(?<version>.*)$'` strips the leading `v`.
- **Decision (Unit 4): harness-release self-updates `DEFAULT_OPENCODE_VERSION` via auto-PR on successful publish (Marcus directive).** No Renovate manager for the harness version. The release pipeline already knows the exact `base_version` + integration short8 it just published, so on success it opens a PR bumping the constant + rebuilt `dist/`. This makes the version flow the right direction (release → constant) with no brittle ordering, respects branch protection (PR, not direct push), and keeps a review gate. (Alternatives considered and rejected: visibility-only Renovate manager — still manual bumps; monotonic-counter tag scheme — complicates the release pipeline.)

## Implementation Units

- [x] **Unit 1: Decouple FALLBACK_VERSION and introduce the harness default**

**Goal:** Make `FALLBACK_VERSION` an explicit stock constant and flip `DEFAULT_OPENCODE_VERSION` to the harness form, without the two aliasing.

**Requirements:** R1, R3, R5

**Files:**
- Modify: `packages/runtime/src/shared/constants.ts`
- Modify: `src/services/setup/opencode.ts` (the `FALLBACK_VERSION = DEFAULT_OPENCODE_VERSION` line)
- Test: `src/services/setup/opencode.test.ts`

**Approach:**
- Add `export const FALLBACK_VERSION = '1.17.3'` as an explicit stock constant (decide home: it currently lives in `opencode.ts`; keep it there but set it to a literal instead of the alias, OR move alongside `DEFAULT_OPENCODE_VERSION` in `constants.ts` — implementer picks the cleaner home, but it must be a plain `X.Y.Z` literal independent of the default).
- Set `DEFAULT_OPENCODE_VERSION = '1.17.3+harness.2c9cdbd2'` in `constants.ts`.
- Update the stale comment block at `constants.ts:22-26` to describe the new dual-constant model (stock fallback + harness default) without pinning version literals in prose.

**Patterns to follow:** existing constant + JSDoc style in `constants.ts`.

**Test scenarios:**
- Happy path: `DEFAULT_OPENCODE_VERSION` equals `1.17.3+harness.2c9cdbd2` and `isHarnessVersion(DEFAULT_OPENCODE_VERSION)` is true.
- Happy path: `FALLBACK_VERSION` is a plain semver (`/^\d+\.\d+\.\d+$/`) — the existing `FALLBACK_VERSION` test (`opencode.test.ts:552-555`) must still pass.
- Edge: `FALLBACK_VERSION !== DEFAULT_OPENCODE_VERSION` (guard against re-aliasing).

**Verification:** the existing fallback-is-semver test passes; default is the harness form.

- [x] **Unit 1b: Make compareVersions/isSqliteBackend build-metadata-safe**

**Goal:** Prevent the harness `+harness.<sha>` suffix from breaking OpenCode version comparison, which gates SQLite cache persistence.

**Requirements:** R1 (correctness of the flipped default)

**Files:**
- Modify: `packages/runtime/src/session/version.ts`
- Test: the colocated version test (find `version.test.ts` or the session test that covers `compareVersions`/`isSqliteBackend`)

**Approach:**
- `compareVersions(a, b)` does `a.split('.').map(Number)`. For `'1.17.3+harness.2c9cdbd2'` this yields `[1, 17, NaN/null, ...]`, so `isSqliteBackend('1.17.3+harness.2c9cdbd2')` returns false — which would omit the SQLite session DB from cache save/restore in `src/services/cache/paths.ts:50,66`, causing silent session-state loss. **This is the severe bug the plan's X.Y.Z-assumption flag caught.**
- Strip SemVer build metadata (and prerelease) before splitting: compare only the base `X.Y.Z`. e.g. take `version.split('+')[0].split('-')[0]` before `.split('.')`, or add a small `baseVersion(v)` helper. Apply inside `compareVersions` (covers all callers) or normalize at the `isSqliteBackend` boundary — implementer picks the cleanest, but it must make `isSqliteBackend('1.17.3+harness.<sha>')` behave identically to `isSqliteBackend('1.17.3')`.

**Patterns to follow:** existing `version.ts` style; `isHarnessVersion`/build-metadata handling in `opencode.ts`.

**Test scenarios:**
- Happy path: `compareVersions('1.17.3+harness.2c9cdbd2', '1.2.0')` > 0 (base compared, suffix ignored).
- Happy path: `isSqliteBackend('1.17.3+harness.2c9cdbd2') === true` (matches `isSqliteBackend('1.17.3')`).
- Edge: `compareVersions('1.17.3+harness.a', '1.17.3+harness.b') === 0` (build metadata non-ordering — equal base).
- Edge: `compareVersions('1.17.3', '1.17.3') === 0` (stock unchanged).
- Regression: `isSqliteBackend('1.1.0')` still false, `isSqliteBackend('1.2.0')` still true (threshold intact).

**Verification:** `isSqliteBackend` returns true for the harness default; SQLite cache paths are included; stock behavior unchanged.

- [x] **Unit 2: Tool-cache identity for harness versions**

**Goal:** Prevent harness/stock collision in `@actions/tool-cache` by using a `-harness` cache identity.

**Requirements:** R2

**Files:**
- Modify: `src/services/setup/opencode.ts` (`toolCache.find` at :260, `toolCache.cacheDir` at :330)
- Modify: `src/services/setup/setup.ts` (`toolCache.find('opencode', version)` at :87)
- Test: `src/services/setup/opencode.test.ts`

**Approach:**
- Add a small pure helper (e.g. `toolCacheVersion(version)`) that returns `version.replace('+harness.', '-harness.')` (or returns the version unchanged when it has no `+harness.`). Use it at every `toolCache.find`/`cacheDir` call site.
- Keep the raw `+harness` version everywhere else (download URL, checksum lookup, `installOpenCode` return `version`, logs, outputs).
- Verify the cache-store (`cacheDir`) and both cache-find sites (`opencode.ts:260`, `setup.ts:87`) use the converted identity so store/lookup are symmetric.
- **Verified during deepening (@actions/tool-cache@4.0.0):** `find`/`cacheDir`/`_createToolPath`/`_completeToolPath` all run `semver.clean()`; `semver.clean('1.17.3-harness.2c9cdbd2')` → preserved distinctly, while `semver.clean('1.17.3+harness.2c9cdbd2')` → `1.17.3` (collision). The `-harness` form is valid semver and accepted without throwing. The complete OpenCode cache call-site list is exactly these 3 sites (no `findAllVersions` anywhere). `src/services/setup/bun.ts` also caches but is OpenCode-unrelated — intentionally NOT converted.

**Patterns to follow:** existing pure-helper style in `opencode.ts` (`isHarnessVersion`, `buildDownloadUrl`).

**Test scenarios:**
- Happy path: `toolCacheVersion('1.17.3+harness.2c9cdbd2')` → `'1.17.3-harness.2c9cdbd2'`.
- Happy path: `toolCacheVersion('1.17.3')` → `'1.17.3'` (stock unchanged).
- Edge: `semver.clean` of the converted form is NOT `1.17.3` (prove no collision) — i.e. the `-harness` form preserves the suffix through tool-cache's cleaning, unlike the `+harness` form.
- Integration: a stock `1.17.3` cache entry does not satisfy a harness `find` (mock toolCache adapter; assert find is called with the `-harness` identity, not `1.17.3`).

**Verification:** all `toolCache.find`/`cacheDir` calls receive the `-harness` identity for harness versions; download/checksum/logs keep the raw `+harness` version.

- [x] **Unit 3: Retarget the existing Renovate manager to FALLBACK_VERSION**

**Goal:** Keep stock base tracking alive by pointing the existing customManager at `FALLBACK_VERSION`.

**Requirements:** R4

**Files:**
- Modify: `.github/renovate.json5` (lines 24-31)

**Approach:**
- Change `matchStrings` from `DEFAULT_OPENCODE_VERSION = '...'` to `FALLBACK_VERSION = '(?<currentValue>\d+\.\d+\.\d+)'`.
- If `FALLBACK_VERSION` does not live in `src/shared/constants.ts`, update `managerFilePatterns` to the file where it's defined.
- Keep `depNameTemplate: anomalyco/opencode`, `datasourceTemplate: github-releases`, and the `<=` cap behavior so stock-base bumps remain deliberate reviewed upgrades.

**Test scenarios:** Test expectation: none — Renovate config change; validated via the Renovate config validator in Unit 5.

**Verification:** the manager regex matches the new `FALLBACK_VERSION` literal.

- [x] **Unit 4: Self-update DEFAULT_OPENCODE_VERSION on successful harness release**

**Goal:** Make the harness-release workflow open a PR that bumps `DEFAULT_OPENCODE_VERSION` (+ rebuilt `dist/`) when a publish succeeds, so future harness releases flow into the action default automatically — replacing any Renovate involvement for the harness version (Renovate cannot order `+harness.<sha>` tags).

**Requirements:** R4

**Files:**
- Modify: `.github/workflows/harness-release.yaml`

**Approach:**
- Add a step/job AFTER the `publish (all-or-nothing)` job succeeds (gated `if: success() && dry_run != 'true'`) that:
  - Computes the published version `${base_version}+harness.${short_sha}` (already available as workflow outputs — `steps.params.outputs.base_version` / `short_sha`, the same values used to build the release tag).
  - Updates `DEFAULT_OPENCODE_VERSION` in `packages/runtime/src/shared/constants.ts` to that value (e.g. a `sed`/`node` in-place edit of the constant literal).
  - Rebuilds `dist/` (so the committed bundle stays in sync — required by the dist-sync CI gate).
  - Opens a PR with the change (use `peter-evans/create-pull-request` or an equivalent `gh pr create` flow) targeting `main`, so branch protection + review are respected. Do NOT push directly to main.
- The PR is auto-generated but reviewed/merged by a maintainer (fail-soft: if the PR step fails, it must not fail the release — the release already succeeded; surface a warning).
- For THIS first flip, the bump to `2c9cdbd2` is done manually in Unit 1; this self-update mechanism handles FUTURE releases.

**Patterns to follow:** the existing repo-write pattern in `harness-release.yaml` (it already pushes `refs/harness-integrate/...` with `contents: write`); the dist-rebuild pattern from the release/build steps; existing `gh`-based PR creation elsewhere in the repo if present.

**Test scenarios:** Test expectation: none — workflow change; validated via `actionlint` (Unit 5) and exercised on the next real harness release. Note in the PR that end-to-end proof comes from the next release dispatch, not CI.

**Verification:** `actionlint` clean; the new step is gated on publish success + non-dry-run; opens a PR rather than pushing to main; rebuilds dist in the PR.

- [x] **Unit 5: Stale comments, dist rebuild, and config validation**

**Goal:** Clean up stale comments, rebuild `dist/`, and validate config.

**Requirements:** R1

**Files:**
- Modify: `deploy/workspace.Dockerfile` (comments ~13-14 claiming it tracks `DEFAULT_OPENCODE_VERSION`)
- Modify: `.github/renovate.json5` (workspace ARG manager comment ~80-82)
- Modify: `.github/workflows/fro-bot.yaml` (narration comment ~235-237 if it claims stock OpenCode)
- Modify: `dist/main.js` (rebuild)

**Approach:**
- Fix stale comments so they describe the new model (workspace ARG is independently stock-pinned; the action default is harness).
- Run the Renovate config validator on `.github/renovate.json5` (Units 3+4).
- Rebuild `dist/` (the constant change flows into the bundled action).

**Test scenarios:** Test expectation: none — comments + generated output.

**Verification:** `dist/` rebuilt and in sync; Renovate config validates; `git diff dist/` only reflects the version change.

## System-Wide Impact

- **Interaction graph:** every action run resolves `DEFAULT_OPENCODE_VERSION` via `inputs.ts:333` → `setup.ts` → `opencode.ts` download. The flip changes the binary source to the harness release.
- **Error propagation:** a missing/failed harness release now fails closed (throws) instead of silently running stock — the desired posture. The CI `Test GitHub Action` job runs the real action and will exercise the harness download path (public release, no auth).
- **State lifecycle risks:** the tool-cache collision (Unit 2) is the key risk; the `-harness` identity prevents a stock entry satisfying a harness lookup and vice-versa.
- **Unchanged invariants:** SDK stays stock `1.17.3`; workspace ARG stays stock `1.17.3`; fail-closed logic unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Tool-cache collision silently runs stock | Unit 2 `-harness` cache identity + collision test |
| Renovate can't order `+harness` tags | Deferred question with manual-tracking fallback; don't block the flip |
| Base bump points default at non-existent harness release | Fail-closed download surfaces it loudly; base + harness move together (B/C2 discipline) |
| CI `Test GitHub Action` can't reach the release | Public release verified reachable (Oracle confirmed 200); no auth needed |

## Sources & References

- Oracle pin-flip strategy review (this session); both load-bearing claims source-verified.
- Memory 5361 (published release), 5362 (constant/Renovate/cache design).
- Published release: `v1.17.3+harness.2c9cdbd2`.
- Related: PR #874 (download capability), PR #882 (harness-tag exclusion).
