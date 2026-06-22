---
title: 'refactor: deterministic committed third-party notices + CI SBOM'
type: refactor
status: active
date: 2026-06-21
---

# Deterministic committed third-party notices + CI SBOM

## Overview

The action's bundled `dist/` is committed and is a redistribution of ~214 production dependencies (MIT/BSD/Apache-heavy). The build emits `dist/licenses.txt` (an 800KB concatenation of their license texts) on every build, but the file sits in half-tracked limbo: the release pipeline commits it, Renovate dep-bump commits delete it, CI's dist-diff check excludes it for `renovate/*` branches, and `.gitignore` doesn't cover it — so it perpetually shows as untracked.

This makes the attribution notice deterministic and intentionally tracked, removes the CI carve-out that let it rot, and adds a machine-readable SBOM as a CI artifact. The boring invariant: if the bundle is committed, the attribution matching that bundle is committed too.

## Problem Frame

The committed `dist/` legally requires preserving the bundled dependencies' license/copyright notices (MIT/BSD/Apache all require notice preservation on redistribution; an SBOM is not a substitute, and a release-only artifact is too weak because the Action is consumed by tag/SHA). The current file is neither reliably committed nor ignored.

Root cause of the oscillation (verified empirically 2026-06-21): the generated file is **already deterministic** — two consecutive clean builds produce byte-identical output, and a benign per-dependency warning (`Unable to determine license content for buffers@0.1.1`, a transitive dep of `@actions/artifact`) does not stop the file from being written. The file's current state is simply `??` untracked — main's HEAD genuinely lacks it, and it isn't gitignored. So the real defect is **process, not non-determinism**: the file is never landed in the tracked tree, the `renovate/*` CI carve-out (`ci.yaml:100`) exempts it from the diff gate, and the generator's fail-soft `catch` early-return (when `getProjectLicenses` *totally* fails) could in principle write nothing. Renovate's `ignorePaths: ['dist/**']` is only a *scan* exclusion; `postUpgradeTasks` already rebuilds + commits dist. The fix: commit the deterministic file under a clear name, remove the carve-out, and make the *total-failure* path fail-closed (without failing on benign per-dep gaps).

## Requirements Trace

- R1. The bundled third-party attribution notice is generated deterministically (stable order, normalized EOL, no timestamps/absolute paths) so identical inputs produce an identical file.
- R2. The generator never silently emits an empty/partial notice file — a generation failure fails the build rather than writing nothing.
- R3. The notice file is intentionally tracked and verified for **all** branches (the `renovate/*` dist-diff carve-out is removed), so every dependency change regenerates and commits matching notices.
- R4. A machine-readable SBOM (CycloneDX JSON) of production dependencies is produced as a CI artifact.
- R5. The notice content remains legally sufficient — actual license text preserved, attribution complete (no under-inclusion).

## Scope Boundaries

- Not gitignoring the notice file (rejected: weakens compliance for tag/SHA consumers; contradicts the committed-dist model).
- Not changing the bundle (`dist/main.js`/`post.js`) itself.
- Not changing Renovate's `ignorePaths` (it's a scan exclusion, not the cause — `postUpgradeTasks` already rebuilds + commits dist).

### Deferred to Separate Tasks

- Wiring GitHub's native SPDX "Export SBOM" / dependency-graph export as a secondary audit view (manual feature, not required for this fix).
- Committing the SBOM into the repo (start with a CI artifact; revisit only if a consumer needs SBOM-in-repo).
- `dependency-review-action` license-policy gating (separate policy decision).

## Context & Research

### Relevant Code and Patterns

- `tsdown.config.ts` — `licenseCollectorPlugin()` (the generator: `getProjectLicenses` + `pnpm licenses list --json --prod`, sorts by name, normalizes `\r\n`→`\n`, dedups to highest version, writes `dist/licenses.txt`). The fail-soft early-return is the bug.
- `.github/workflows/ci.yaml` (build job, ~96-106) — the dist-diff check with the `renovate/*` carve-out at line ~100 (`DIFF_TARGETS="dist/ ':!dist/licenses.txt'"`).
- `.github/workflows/auto-release.yaml` (~60) — runs `pnpm build`, so it regenerates the notice under any new name automatically.
- `.github/renovate.json5` — `postUpgradeTasks: {commands: ['pnpm install','pnpm run build','pnpm run fix'], executionMode: 'branch'}` already rebuilds + commits dist on dep PRs; `ignorePaths: ['dist/**']` is scan-only.

### Institutional Learnings

- Memory: `dist/` is committed and must stay in sync; CI fails on `git diff dist/` after build. This plan brings the notice file under that same invariant instead of exempting it.

### External References

- pnpm 11.7 native `pnpm sbom --sbom-format cyclonedx --prod` (CycloneDX 1.7 JSON; workspace/lockfile-aware; no new dependency).
- Oracle review + librarian research (this session): committed-bundle Actions should ship a committed, deterministic `THIRD_PARTY_NOTICES`; SBOM is a CI artifact, secondary to the notice.

## Key Technical Decisions

- **Rename `dist/licenses.txt` → `dist/THIRD_PARTY_NOTICES.txt`** — names the file for what it legally is (attribution), and the rename naturally retires the stale-path confusion.
- **Make generation fail-closed** — replace the fail-soft early-return: if license collection genuinely fails, the build fails (so a broken generation can never produce an empty/deleted notice that thrashes the diff). Preserve a deliberate, documented exception only if there's a real reason a clean environment can't collect licenses; default is fail the build.
- **Remove the CI `renovate/*` carve-out** — once generation is deterministic + fail-closed, Renovate's `postUpgradeTasks` rebuild produces a stable notice that passes the diff check like the rest of `dist/`; no exception needed.
- **Keep the highest-version dedup, but verify it's attribution-safe** — the current generator keeps only the highest resolved version's license `content` per package. This is acceptable for attribution when the license text is the same across the resolved versions (true for the vast majority). Document the assumption; if a package resolves to multiple versions with *different* license text, that's a known edge the generator should not silently drop — note it, don't expand scope to solve it unless found.
- **SBOM via native `pnpm sbom` as a CI artifact** — CycloneDX JSON, generated in CI and uploaded; no new dependency, no commit churn.

## Open Questions

### Resolved During Planning

- Commit vs gitignore the notice? → Commit (Oracle + research: committed bundle ⇒ committed attribution).
- Does removing the carve-out break Renovate PRs? → No, once the generator is deterministic + fail-closed; `postUpgradeTasks` already rebuilds and commits dist.
- New SBOM dependency needed? → No; `pnpm sbom` is native at pnpm 11.7.

### Deferred to Implementation

- The exact failure surface of `getProjectLicenses` in CI vs local — confirm during implementation whether it needs an install precondition (e.g. `pnpm licenses` data present) so fail-closed doesn't false-fail a legitimate build. If a clean `pnpm build` in CI can intermittently fail collection, the fix must make collection *reliable*, not just loud.

## Implementation Units

- [x] **Unit 1: Deterministic, fail-closed notice generation + rename**

**Goal:** The build emits `dist/THIRD_PARTY_NOTICES.txt` deterministically and fails the build on a genuine generation failure instead of silently writing nothing.

**Requirements:** R1, R2, R5

**Dependencies:** None

**Files:**
- Modify: `tsdown.config.ts` (the `licenseCollectorPlugin`: rename the output path + log text; replace the fail-soft early-return with fail-closed behavior; confirm stable sort + EOL normalization + no timestamps/absolute paths in output)
- Test: `tsdown.config.test.ts` (create if absent) — or, if the plugin isn't unit-testable in isolation, verify via a deterministic-output assertion (build twice, diff)

**Approach:**
- Rename `dist/licenses.txt` → `dist/THIRD_PARTY_NOTICES.txt` (2 occurrences: the `writeFile` target and the warning log text).
- **Determinism is already verified** (two clean builds → byte-identical; explicit sort + EOL normalization in place). No determinism work needed beyond confirming no regression.
- Make the **total-failure** path fail-closed: replace the `catch { console.warn(...); return }` early-return so a genuine `getProjectLicenses` failure throws and fails the build (never writes nothing). **Do NOT fail on benign per-dependency gaps** — e.g. `buffers@0.1.1` (transitive via `@actions/artifact`) legitimately has no resolvable license text and `generate-license-file` handles it while still writing the file. Fail-closed applies to total collection failure only.
- Keep the highest-version dedup; add a brief comment documenting the attribution-safety assumption (same license text across resolved versions).

**Patterns to follow:** the existing `defaultVersionInvariantPlugin` in the same file (a build-time invariant that fails the build) — mirror its fail-the-build posture.

**Test scenarios:**
- Happy path: a build produces `dist/THIRD_PARTY_NOTICES.txt` containing the bundled deps' names@version + license text, stably ordered.
- Edge case: two consecutive builds on an unchanged dependency tree produce byte-identical files (determinism).
- Error path: a forced collection failure fails the build (no silent empty/partial write).

**Verification:** `pnpm build` produces `dist/THIRD_PARTY_NOTICES.txt` (not `licenses.txt`); rebuilding without changes yields no diff; a simulated collection failure exits non-zero.

- [x] **Unit 2: Remove the CI dist-diff carve-out**

**Goal:** CI verifies all of `dist/` (including the notice) on every branch, with no `renovate/*` exception.

**Requirements:** R3

**Dependencies:** Unit 1 (the diff check only passes for Renovate PRs once generation is deterministic + fail-closed)

**Files:**
- Modify: `.github/workflows/ci.yaml` (the "Compare the expected and actual dist/ directories" step: drop the `renovate/*` branch that sets `DIFF_TARGETS="dist/ ':!dist/licenses.txt'"`; `DIFF_TARGETS="dist/"` unconditionally)

**Approach:**
- Remove the conditional that excludes the notice for `renovate/*`. The `eval`/`git diff` machinery stays; only the carve-out branch is deleted. Now Renovate dep PRs (whose `postUpgradeTasks` already runs `pnpm build`) must commit the regenerated notice, and CI verifies it like any other dist file.

**Test scenarios:** Test expectation: none — CI workflow change; validated by `actionlint` and by a real Renovate/dep PR rebuilding dist cleanly. (No unit-test surface.)

**Verification:** `actionlint` clean; the diff step has a single unconditional `DIFF_TARGETS="dist/"`; no remaining reference to `licenses.txt` anywhere in CI.

- [x] **Unit 3: CI CycloneDX SBOM artifact**

**Goal:** Each CI run (and/or release) produces a CycloneDX JSON SBOM of production dependencies, uploaded as an artifact.

**Requirements:** R4

**Dependencies:** None (independent of Units 1-2)

**Files:**
- Modify: `.github/workflows/ci.yaml` (add a step — likely in the build job — running `pnpm sbom --sbom-format cyclonedx --prod` and `actions/upload-artifact` for the output)

**Approach:**
- `pnpm sbom --sbom-format cyclonedx --prod` writes valid CycloneDX 1.7 JSON to **stdout** (verified) — redirect to a file (e.g. `sbom.cdx.json`) and upload via the pinned `actions/upload-artifact`. Use `--prod` so the SBOM reflects shipped deps. Do not commit the SBOM (artifact only, per scope). Note: the output carries a `metadata.timestamp` — fine for an uncommitted artifact.

**Test scenarios:** Test expectation: none — CI artifact generation; validated by `actionlint` and the artifact appearing on a CI run. (No unit-test surface.)

**Verification:** `actionlint` clean; a CI run uploads a non-empty CycloneDX JSON artifact that parses as valid JSON with a `bomFormat: "CycloneDX"` field.

- [x] **Unit 4: Commit the renamed notice + docs**

**Goal:** The repo's tracked state reflects the new file, and the build/license behavior is documented.

**Requirements:** R3, R5

**Dependencies:** Units 1-3

**Files:**
- Create/commit: `dist/THIRD_PARTY_NOTICES.txt` (the freshly generated, tracked file)
- Delete: `dist/licenses.txt` (if present in the tree at merge time)
- Modify: `AGENTS.md` and/or build docs — a line noting `dist/THIRD_PARTY_NOTICES.txt` is generated + committed attribution, and the SBOM is a CI artifact. Update any RULES/AGENTS reference that mentions `licenses.txt`.

**Approach:**
- After Units 1-3, run `pnpm build`, stage the new `dist/THIRD_PARTY_NOTICES.txt`, ensure the old `dist/licenses.txt` is removed from the tree, and document the new posture. This unit is the "land it tracked" step that ends the oscillation.

**Test scenarios:** Test expectation: none — generated artifact + docs.

**Verification:** `git ls-files dist/` includes `THIRD_PARTY_NOTICES.txt` and not `licenses.txt`; a clean `pnpm build` leaves the tree diff-free; docs mention the new file.

## System-Wide Impact

- **Interaction graph:** the tsdown build plugin (local + CI + release + Renovate `postUpgradeTasks` all run `pnpm build`), the CI dist-diff gate, and Renovate's dep-PR commits. Making generation deterministic + fail-closed is what lets the CI gate apply uniformly across all of these.
- **Error propagation:** generation failure now fails the build (fail-closed) instead of silently writing nothing — the deferred question guards against this false-failing a legitimate CI build.
- **State lifecycle risks:** the rename must land atomically with the carve-out removal — if the carve-out is removed before the file is deterministic, Renovate PRs would fail the diff check. Sequence: Unit 1 (determinism) → Unit 2 (remove carve-out) → Unit 4 (commit tracked file).
- **Unchanged invariants:** the bundle (`dist/main.js`/`post.js`), Renovate `ignorePaths`, and the rest of the dist-diff machinery are unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Fail-closed generation false-fails a legitimate CI/Renovate build (the original reason for the fail-soft path) | Resolve the deferred question first: confirm whether a clean `pnpm build` reliably collects licenses in CI; make collection *reliable* before making failure loud. If there's a genuine environment dependency, ensure it's satisfied (install state) rather than reintroducing silent fallback. |
| Removing the carve-out makes the next Renovate dep PR fail the dist-diff | Land Unit 1 (determinism) before/with Unit 2; verify on a real dep PR (or a simulated `renovate/*` branch build) that the rebuilt notice is byte-stable. |
| Highest-version dedup under-includes attribution when a package resolves to multiple versions with different license text | Document the assumption; if found in practice, emit per-resolved-version rather than collapsing (do not pre-build this unless observed). |
| `pnpm sbom` output flag/path differs from assumed | Confirm the exact invocation during Unit 3 implementation; it's a CI-only artifact step with no downstream coupling. |

## Documentation / Operational Notes

- Update `AGENTS.md` (and any RULES reference) to name `dist/THIRD_PARTY_NOTICES.txt` as the generated, committed attribution file and note the CycloneDX SBOM CI artifact.
- No runtime/deploy impact; this is build + CI + repo-hygiene only.

## Sources & References

- Related code: `tsdown.config.ts` (`licenseCollectorPlugin`), `.github/workflows/ci.yaml` (dist-diff), `.github/renovate.json5` (`postUpgradeTasks`), `.github/workflows/auto-release.yaml`.
- Research: Oracle strategic review + librarian SBOM/license research (this session).
- Trigger: maintainer question — "Why is dist/licenses.txt untracked and what's the modern way of tracking SBOM/licenses?"
