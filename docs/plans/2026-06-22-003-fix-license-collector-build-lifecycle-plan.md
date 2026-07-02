---
title: "fix: Decouple license collection from the dist-escape build lifecycle"
type: fix
status: done
date: 2026-06-22
---

> **Status: done.** All 4 units shipped: license-notice generation extracted to `scripts/third-party-notices.ts`, the `scripts/build-action-dist.ts` preflight→bundle→escape→writeNotice wrapper (escape runs in `finally`), the throwing license logic removed from the tsdown `writeBundle` hook, and the renovate.json5 comment fixed — verified on `main`.

# fix: Decouple license collection from the dist-escape build lifecycle

## Overview

The committed `dist/` hidden-unicode warning recurs on every Renovate dependency PR. Root cause (verified from Renovate run logs): the `licenseCollectorPlugin` in `tsdown.config.ts` runs `getProjectLicenses('./package.json')` inside its `writeBundle` hook and **throws** (fail-closed, PR #978) when license collection fails in Renovate's environment. The action build aborts with exit 1 — *after* tsdown has already cleaned and written the dist chunks, but *before* the escape plugin (and the final `dist:escape-hidden-unicode` build step) runs. The result on Renovate branches is the opposite of #978's intent: `dist/` is committed with raw hidden-unicode characters **and** a dropped `THIRD_PARTY_NOTICES.txt`.

The policy (#978 fail-closed attribution) is correct; the **placement** is wrong. This plan moves license collection to a preflight that runs before tsdown mutates `dist/`, and ensures the hidden-unicode escape runs even when the build fails — without masking genuine build failures.

## Problem Frame

`tsdown.config.ts` plugin order is `[licenseCollectorPlugin(), escapeHiddenUnicodePlugin(), defaultVersionInvariantPlugin()]`. All three run in `writeBundle`, which fires after tsdown has emitted/cleaned `dist/`. `licenseCollectorPlugin` does two fallible things:
- `getPnpmLicensesJson()` (`tsdown.config.ts:85`) — already fail-soft (returns `{}` → "Unknown" license types).
- `getProjectLicenses('./package.json')` (`tsdown.config.ts:192`) — hard-throws (`:194`) on failure, which is what aborts the build.

Because the throw happens in a late, post-mutation hook and shares the plugin array with the escape plugin, a license failure leaves the bad artifact state and skips escaping. In Renovate's `postUpgradeTasks` environment (`pnpm install` with possible `--ignore-scripts`/partial install), `getProjectLicenses` cannot read every dependency's license from `node_modules`, so it throws there while succeeding locally and in normal CI.

## Requirements Trace

- R1. Hidden-unicode escaping must run on a Renovate branch build even if license collection fails, so committed `dist/` never carries raw hidden-unicode characters.
- R2. Preserve #978's fail-closed attribution guarantee: a build that completes successfully must have an accurate, present `THIRD_PARTY_NOTICES.txt`; a total license-collection failure must not silently ship a degraded/placeholder notice on release/main builds.
- R3. License collection that fails must not destroy the existing committed `THIRD_PARTY_NOTICES.txt` (leave the prior good notice intact rather than dropping it).
- R4. Genuine build failures must still surface as a non-zero exit — the escape-on-failure path must not mask real errors.
- R5. `dist/` output must remain byte-identical on a successful build (this is a lifecycle restructure, not a content change).
- R6. License collection failures must produce actionable diagnostics (real stderr/cause), not just "cannot produce THIRD_PARTY_NOTICES.txt".

## Scope Boundaries

- No change to which characters are escaped or how (the `scripts/dist-hidden-unicode.ts` logic stays as-is).
- No change to the #978 fail-closed *policy* — only where/when it runs.
- No environment-conditional license behavior (rejected: same commit must produce the same `dist/` regardless of environment).

### Deferred to Separate Tasks

- Diagnosing the exact `generate-license-file` failure cause in Renovate's env: optional follow-up. The lifecycle fix is correct regardless of the precise pnpm/node_modules reason. The added diagnostics (R6) will surface it on the next occurrence.
- Removing the stale `renovate.json5` comment claiming `ignorePaths` skips the hidden-unicode detector: folded into this plan as a trivial cleanup (Unit 4), since it actively misleads future readers about this exact bug.

## Context & Research

### Relevant Code and Patterns

- `tsdown.config.ts` — `licenseCollectorPlugin()` (`:179`), `getPnpmLicensesJson()` (`:85`, fail-soft), `getProjectLicenses` import (`:6`), `formatThirdPartyNotices()` (the notice formatter), `escapeHiddenUnicodePlugin()` (`:127`), `defaultVersionInvariantPlugin()` (`:241`), plugin array (`:265`).
- `scripts/dist-hidden-unicode.ts` + `scripts/escape-dist-hidden-unicode.ts` — existing standalone build-helper-script precedent (run via `node --experimental-strip-types`).
- `package.json:24` — root `build` chain ending in `&& pnpm run dist:escape-hidden-unicode`.
- `apps/action/package.json:9` — action build: `pnpm --dir ../.. exec tsc --noEmit && pnpm --dir ../.. exec tsdown -c tsdown.config.ts`.

### Institutional Learnings

- `docs/solutions/workflow-issues/committed-dist-attribution-and-sbom-hygiene-2026-06-21.md` — the #978 fail-closed rationale (committed bundle ⇒ committed notice).
- `docs/solutions/workflow-issues/durable-dist-hidden-unicode-fix-2026-06-22.md` — the escape-in-build invariant; this plan fixes the gap where the escape was downstream of a throwing plugin.

## Key Technical Decisions

- **Preflight, don't fail-soft.** Collect licenses *before* tsdown runs (in a step that can fail-closed without leaving a half-written `dist/`). Oracle rejected env-conditional fail-soft as determinism-breaking; this preserves fail-closed without that cost.
- **Escape must be lifecycle-independent of license collection.** The escape runs after dist is written regardless of whether the (now-preflight) license step or the bundle step failed — but the wrapper preserves the real exit code so failures aren't masked.
- **Notice write stays atomic on success.** On a successful build, write the precomputed `THIRD_PARTY_NOTICES.txt` from the preflight result. On failure, the existing committed notice is untouched.
- **Build wrapper seam.** Introduce a small Node build-orchestration helper (consistent with the existing `scripts/*.ts` pattern) so the ordering (preflight → bundle → escape-in-finally → atomic notice) is explicit and testable, rather than relying on shell `&&` short-circuit semantics.

## Open Questions

### Resolved During Planning

- Where does the escape run now that it can't be a plain `&&` tail? → In the build wrapper's `finally`, after the bundle step, preserving the bundle's exit code. The root `build` script delegates to the wrapper.
- Should the tsdown `licenseCollectorPlugin` be removed or kept? → Reduced to a non-throwing step (or removed; the preflight + wrapper own notice production). The plugin must no longer throw inside `writeBundle`.

### Deferred to Implementation

- Exact helper/function names and whether the preflight reuses `getProjectLicenses`/`formatThirdPartyNotices` by extracting them into a shared module imported by both the wrapper and any remaining plugin code — determined when touching the real code.
- Whether the escape-in-finally lives in the wrapper or the existing final `dist:escape-hidden-unicode` step is invoked by the wrapper — pick the simpler wiring during implementation.

## Implementation Units

- [x] **Unit 1: Extract license-notice generation into a shared, testable module**

**Goal:** Move the fallible license collection (`getProjectLicenses` + `getPnpmLicensesJson` + `formatThirdPartyNotices`) out of the tsdown `writeBundle` hook into a standalone module that produces the notice content (string) without writing to `dist/`.

**Requirements:** R2, R3, R6

**Dependencies:** None

**Files:**
- Create: `scripts/third-party-notices.ts` (shared: `collectThirdPartyNotices(): Promise<string>` + the formatter, importing `getProjectLicenses`/`getPnpmLicensesJson`)
- Create: `scripts/third-party-notices.test.ts`
- Modify: `tsdown.config.ts` (move the collection/format logic out; keep or import shared formatter)

**Approach:**
- The shared collector returns the formatted notice string (or throws with a *rich* error including the underlying stderr/cause — R6) — it does not write `dist/THIRD_PARTY_NOTICES.txt` itself.
- Preserve the existing fail-soft `getPnpmLicensesJson` behavior and the hard-fail-on-total-failure semantics for `getProjectLicenses`, but make the thrown error carry the real cause.

**Patterns to follow:** `scripts/dist-hidden-unicode.ts` (standalone build-helper module + colocated test, erasable-syntax TS).

**Test scenarios:**
- Happy path: given a fake license dataset, `collectThirdPartyNotices` returns the formatted notice string matching the current `formatThirdPartyNotices` output (sorted, EOL-normalized).
- Error path: when the underlying collection throws, the module throws an error whose message includes the underlying cause/stderr (not just a generic string).
- Edge case: empty/`Unknown` license types still produce a valid notice (no throw for per-dependency gaps).

**Verification:** The notice-generation logic is importable and unit-tested; `tsdown.config.ts` no longer performs fallible license collection inside `writeBundle`.

- [x] **Unit 2: Add a build wrapper that preflights notices, bundles, and escapes in finally**

**Goal:** Introduce a build-orchestration helper that runs the license preflight (fail-closed, before tsdown), then the tsdown action build, then the hidden-unicode escape in a `finally` that preserves the bundle's exit code, then writes the notice atomically on success.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** Unit 1

**Files:**
- Create: `scripts/build-action-dist.ts` (the wrapper)
- Create: `scripts/build-action-dist.test.ts`
- Modify: `apps/action/package.json` (`build` delegates to the wrapper) and/or `package.json` (root `build` chain) — pick the seam that keeps the escape lifecycle-independent.

**Approach:**
- Order: (1) preflight `collectThirdPartyNotices()`; on failure, exit non-zero **before** invoking tsdown, leaving the committed `dist/THIRD_PARTY_NOTICES.txt` intact (R3). (2) Run the tsdown action build, capturing its exit status. (3) In a `finally`, run the dist hidden-unicode escape regardless of the bundle outcome (R1), but re-propagate the bundle's failure exit code (R4). (4) On bundle success, write the precomputed notice to `dist/THIRD_PARTY_NOTICES.txt` atomically (R2).
- The escape step reuses `scripts/escape-dist-hidden-unicode.ts` / the shared escape module — no new escape logic.
- Keep the existing root `build` final `dist:escape-hidden-unicode` as belt-and-suspenders OR fold it into the wrapper; do not leave the escape reachable only by a short-circuiting `&&` after a step that can throw.

**Execution note:** Test-first for the wrapper's ordering/exit-code contract — the failure-path behavior (escape runs, real exit code preserved, prior notice intact) is the load-bearing correctness property.

**Test scenarios:**
- Happy path: preflight succeeds → bundle succeeds → escape runs → notice written → exit 0.
- Error path (license preflight fails): wrapper exits non-zero, tsdown is never invoked, the existing `dist/THIRD_PARTY_NOTICES.txt` is not modified.
- Error path (bundle fails after emitting partial dist): the escape still runs over the emitted dist, and the wrapper exits with the bundle's non-zero code (failure not masked).
- Edge case: bundle succeeds but notice write fails → surfaces as a build failure (not silently ignored).
- Integration: a full real `pnpm build` produces byte-identical `dist/` to current main on the happy path (R5).

**Verification:** On success, `dist/` is byte-identical to current main and the notice is present; on a simulated license failure, the build exits non-zero without dropping the committed notice; on a simulated bundle failure, the escape has still run and the exit code is non-zero.

- [x] **Unit 3: Remove the throwing license logic from the tsdown writeBundle hook**

**Goal:** Ensure `tsdown.config.ts` no longer aborts the bundle from inside `writeBundle` due to license collection — the escape plugin and version-invariant plugin must not be blocked by a license failure.

**Requirements:** R1, R5

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `tsdown.config.ts` (remove/neutralize `licenseCollectorPlugin`'s throwing write; keep `escapeHiddenUnicodePlugin` and `defaultVersionInvariantPlugin`)

**Approach:**
- Either remove `licenseCollectorPlugin` from the plugin array entirely (the wrapper now owns notice production) or reduce it to a non-fallible copy of the precomputed notice. Decide during implementation based on which keeps `dist/` byte-identical and the bundle non-throwing.
- The `escapeHiddenUnicodePlugin` in-bundle escaping stays as belt-and-suspenders; the version-invariant plugin stays.

**Test scenarios:**
- Test expectation: covered by Unit 2's integration scenarios (byte-identical dist, escape runs on bundle failure). No new standalone test unless the plugin retains logic worth pinning.

**Verification:** A simulated license failure no longer aborts the tsdown build; the escape plugin still runs in the normal build.

- [x] **Unit 4: Fix the stale renovate.json5 comment**

**Goal:** Correct the `.github/renovate.json5` comment that claims `ignorePaths` skips the hidden-unicode detector — it does not, and the claim actively misleads about this exact bug.

**Requirements:** R6 (diagnostics/clarity)

**Dependencies:** None

**Files:**
- Modify: `.github/renovate.json5`

**Approach:** Update the comment near `ignorePaths` to state that it is extraction-only and does not suppress the hidden-unicode safety scan, consistent with `docs/solutions/workflow-issues/durable-dist-hidden-unicode-fix-2026-06-22.md`.

**Test scenarios:** Test expectation: none — comment-only change.

**Verification:** The comment no longer claims `ignorePaths` suppresses the hidden-unicode scan.

## System-Wide Impact

- **Interaction graph:** `package.json`/`apps/action/package.json` build scripts, `tsdown.config.ts` plugins, `.github/workflows/ci.yaml` Build job (rebuild + dist-diff + hidden-unicode check), Renovate `postUpgradeTasks` (`pnpm run build`).
- **Error propagation:** license preflight failure → non-zero before bundling (notice preserved); bundle failure → escape still runs, non-zero exit propagated.
- **State lifecycle risks:** partial-dist-after-bundle-failure is the core case — the escape-in-finally handles it; the atomic notice write avoids a half-written notice.
- **API surface parity:** none (build tooling only; no runtime/action code changes).
- **Unchanged invariants:** the set of escaped characters, the #978 fail-closed attribution policy, the committed-dist sync gate, and `dist/` content on a successful build all stay the same.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Build wrapper changes `dist/` output (breaks dist-diff) | R5 byte-identical verification on the happy path before PR; the wrapper only reorders steps, not content. |
| Escape-in-finally masks a genuine build failure | Wrapper re-propagates the bundle's exit code; tested explicitly (Unit 2 error path). |
| Preflight still fails in Renovate's env (same root cause) | The escape now runs regardless (R1), so the hidden-unicode warning is fixed even if the notice can't be regenerated; the committed notice is preserved (R3); R6 diagnostics surface the cause for a follow-up. |
| Removing the tsdown license plugin drops the notice on normal builds | Unit 2 writes the notice from the preflight on success; integration test asserts the notice is present and correct. |

## Documentation / Operational Notes

- After merge, the next Renovate branch build should produce clean escaped `dist/` even if license collection fails there; verify on the first post-merge Renovate PR.
- Update `docs/solutions/workflow-issues/durable-dist-hidden-unicode-fix-2026-06-22.md` (or add a follow-up note) if the lifecycle restructure changes the guidance about where the escape lives.

## Sources & References

- Oracle design consultation (this session): preflight-before-mutation + escape-in-finally + atomic notice; rejected env-conditional fail-soft.
- Renovate run log `27985307453` (the engine run): `getProjectLicenses` throw aborting the action build before the escape.
- Related: `docs/solutions/workflow-issues/committed-dist-attribution-and-sbom-hygiene-2026-06-21.md` (#978 rationale), `docs/solutions/workflow-issues/durable-dist-hidden-unicode-fix-2026-06-22.md`.
- Memory 5927 (the root-cause constraint).
