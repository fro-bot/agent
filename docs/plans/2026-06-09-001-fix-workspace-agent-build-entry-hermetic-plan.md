---
title: "fix: Make workspace-agent build entry hermetic"
type: fix
status: done
date: 2026-06-09
---

> **Status: done.** All 3 units shipped: hermetic entry + scoped rootDir (`apps/workspace-agent/tsdown.config.ts`), the post-build symbol guard, and the CI repo-root build regression step — verified on `main` (PR #849).

# fix: Make workspace-agent build entry hermetic

## Overview

The `apps/workspace-agent` build can resolve its bundle entry to the **wrong** `src/main.ts` — the repo-root action harness (`await run()`) instead of the package's own entry — when built in a full-monorepo checkout. This plan makes the build hermetic at the root cause (config resolution) and adds regression protection so the failure mode cannot silently return.

This is latent fragility, not an active outage: the deployed image is safe because `deploy/workspace.Dockerfile` copies only `apps/workspace-agent/` (plus root manifests), so the repo-root `src/main.ts` does not exist inside the container and the entry resolves correctly. The risk is to any full-monorepo build path (local dev, future CI steps, or a `rootDir` change).

## Problem Frame

Two config choices in `apps/workspace-agent` combine to make entry resolution non-hermetic (confirmed against current source and reproduced via the exact Docker build command locally):

1. `tsdown.config.ts` declares a bare relative `entry: ['src/main.ts']`, resolved relative to CWD / `rootDir` walk.
2. `tsconfig.json` sets `rootDir: "../../"` (two levels above the package, covering the whole monorepo), so the TypeScript program's file-resolution root includes the repo root — where `src/main.ts` (the action harness) also exists.

In a full-monorepo checkout, the bundle ends with `//#region ../../src/main.ts` + `await run()` and omits `startWorkspaceAgent`/`createOpencodeProxy`, with `@actions/core` pulled in. The deployed Docker image avoids this only because the repo-root `src/` is never copied into the build context.

Verified facts that shape the fix:
- The workspace-agent package is **self-contained**: `include: ["src/**/*.ts"]`, zero cross-package imports from its `src/`, and nothing references it as a TypeScript composite/project reference.
- **No consumer imports `@fro-bot/workspace-agent`** — it is a leaf application, not a library, so `composite: true` / `declaration: true` / the wide `rootDir` are cargo-culted and unused.
- The build script runs `tsc -p tsconfig.json --noEmit && tsdown`, so `rootDir`/`declaration` only affect the type-check file set, not emit. Scoping `rootDir` down is therefore safe.

Source: [#847](https://github.com/fro-bot/agent/issues/847) and its Fro Bot triage comment (the requirements basis for this plan).

## Requirements Trace

- R1. The workspace-agent build resolves its entry to `apps/workspace-agent/src/main.ts` regardless of build CWD or the presence of a repo-root `src/main.ts` (eliminate the root cause).
- R2. The TypeScript program for the package no longer considers repo-root files (scope `rootDir` to the package's own source).
- R3. A post-build guard fails the build if the produced bundle does not contain a known workspace-agent symbol (defense-in-depth against any future regression regardless of cause).
- R4. CI builds the workspace-agent from the repo root and exercises the guard, so a regression is caught in the full-monorepo context that the Docker build does not reproduce.
- R5. No behavioral change to the deployed image or the workspace-agent runtime; the Docker build continues to pass the existing Workspace Image Smoke Test.

## Scope Boundaries

- Non-goal: changing the deployed `deploy/workspace.Dockerfile` build flow — it is already safe and unchanged.
- Non-goal: altering workspace-agent runtime behavior, ports, or the entrypoint guard logic.
- Non-goal: touching other packages' `tsdown.config.ts` / `tsconfig.json` (only `apps/workspace-agent` is affected by this root cause).

### Deferred to Separate Tasks

- `packages/harness/BOOTSTRAP.md` "I" corruption: verified NOT present on `main` (the file correctly reads `harness-release.yaml`). It was only ever a stray local working-tree edit, never committed — no action required. Recorded here so the issue's mention is explicitly closed out.

## Context & Research

### Relevant Code and Patterns

- `apps/workspace-agent/tsdown.config.ts` — bare `entry: ['src/main.ts']` (the Option A target).
- `apps/workspace-agent/tsconfig.json` — `rootDir: "../../"`, `composite: true`, `declaration: true` (the Option C target; all three unused for this leaf app).
- `apps/workspace-agent/src/main.ts` — exports `startWorkspaceAgent` and contains the `createOpencodeProxy` wiring; the known-present symbols the guard can assert on.
- `deploy/workspace.Dockerfile` — `RUN pnpm --filter @fro-bot/workspace-agent build` (line ~31); copies `apps/workspace-agent/` only. The build guard runs as part of this build too.
- `.github/workflows/ci.yaml` — the `Workspace Image Smoke Test` job (clone API boot assertions) is the existing authority; the new repo-root build+guard step is added in the workspace-agent build/test path.
- Other packages' `tsdown.config.ts` (e.g. `packages/gateway`, root `tsdown.config.ts`) — reference for the established entry/config style in this repo.

### Institutional Learnings

- The gateway packaging crash-loop solution (`docs/solutions/` — gateway image packaging) established that monorepo package builds must be validated in their isolated build context, and that build-output assertions (no bare imports / expected symbols present) are the right guard. This plan applies the same principle to the workspace-agent entry resolution.

## Key Technical Decisions

- **Option A — package-relative entry (`tsdown.config.ts`):** resolve the entry from the config file's own directory (`fileURLToPath(import.meta.url)` + `path.join`) so it is independent of CWD and any `rootDir` walk. This is the direct fix for the resolution ambiguity.
- **Option C — scope `rootDir` (`tsconfig.json`):** set `rootDir` to the package's own source (`"src"`) so the TypeScript program cannot pull repo-root files into consideration. This removes the actual root cause. Verified safe: leaf app, no consumers, `--noEmit` build. Also drop the now-pointless `composite`/`declaration`/`declarationMap` only if doing so is clean and risk-free; otherwise leave them — scoping `rootDir` alone closes the hole. (Resolved during planning: keep the change minimal and centered on `rootDir`; treat the unused composite/declaration flags as an optional tidy, not a requirement.)
- **Option B — post-build symbol guard:** after the build, assert the produced `dist/main.mjs` contains a known workspace-agent symbol (e.g. `startWorkspaceAgent`). Belt-and-suspenders: catches any future regression regardless of root cause. Implemented as a tsdown post-build hook (mirroring the existing post-build plugin pattern in the repo's `tsdown.config.ts`) or a small package build-verify step — chosen at implementation time based on which integrates most cleanly without adding a separate runner.
- **CI regression step:** build the workspace-agent from the **repo root** (the context that reproduces the bug) and confirm the guard passes, so the full-monorepo failure mode — which the Docker smoke test cannot reproduce because it omits root `src/` — is covered.

## Open Questions

### Resolved During Planning

- Is `rootDir: "../../"` needed for composite project references? No — nothing references the package as a composite project and it has no type consumers. Safe to scope to `"src"`.
- Does scoping `rootDir` affect emit? No — the build type-checks with `--noEmit`; tsdown owns emit.
- Is the `BOOTSTRAP.md` corruption real on main? No — confirmed already-correct; non-issue.

### Deferred to Implementation

- Exact mechanism for Option B (tsdown post-build hook vs. a package `build` verify step) — pick whichever integrates without a new runner; both satisfy R3.
- Whether to also remove the unused `composite`/`declaration`/`declarationMap` flags — optional tidy; only if clean.

## Implementation Units

- [x] **Unit 1: Hermetic entry + scoped rootDir (root-cause fix)**

**Goal:** Make the workspace-agent build resolve only its own `src/main.ts`, regardless of CWD or repo-root files.

**Requirements:** R1, R2, R5

**Dependencies:** None

**Files:**
- Modify: `apps/workspace-agent/tsdown.config.ts` (package-relative entry via `import.meta.url`)
- Modify: `apps/workspace-agent/tsconfig.json` (required: `rootDir: "src"`)

**Approach:**
- Resolve `entry` from the config file's directory so it is absolute and CWD-independent.
- **Required:** scope `rootDir` to `"src"` so the TS program cannot include repo-root `src/main.ts`.
- **Optional tidy (only if `check-types` stays clean):** remove the now-unused `composite`/`declaration`/`declarationMap` flags. This is a separate, non-required cleanup — if removing them surfaces any type-check change, leave them in place; the `rootDir` scope-down alone closes the hole.
- Keep `include`/`outDir` and runtime behavior unchanged.

**Patterns to follow:**
- The repo's other `tsdown.config.ts` files for config style; standard ESM `import.meta.url` directory resolution.

**Test scenarios:**
- Integration (the decisive check): building the workspace-agent from the **repo root** (`pnpm --filter @fro-bot/workspace-agent build`) produces a `dist/main.mjs` that contains `startWorkspaceAgent` and does NOT contain the action-harness entry (`await run()` / `@actions/core`). This is exercised via the Unit 2 guard + Unit 3 CI step.
- Verification that `pnpm --filter @fro-bot/workspace-agent check-types` still passes with the scoped `rootDir`.

**Verification:**
- From the repo root, the workspace-agent bundle entry is the package's own `main.ts` (asserted by Unit 2's guard), and types/build are clean.

- [x] **Unit 2: Post-build symbol guard (defense-in-depth)**

**Goal:** Fail the build if the produced bundle does not contain a known workspace-agent symbol.

**Requirements:** R3

**Dependencies:** Unit 1 (so the guard passes on the corrected build)

**Files:**
- Modify: `apps/workspace-agent/tsdown.config.ts` (post-build hook) OR add a small package build-verify step (implementer's choice — no new runner)
- Test: colocated `.test.ts` for the guard's pure logic if extracted (e.g. a `bundleContainsSymbol(text, symbol)` helper)

**Approach:**
- After the bundle is written, read `dist/main.mjs` and assert it contains a stable workspace-agent symbol (`startWorkspaceAgent`). Fail the build with a clear message naming the expected symbol and the resolved entry if absent.
- **Decision rule (not open-ended):** implement as a tsdown post-build hook (mirroring the root `tsdown.config.ts` post-build plugin pattern) **unless** the hook cannot reliably access the written bundle on disk, in which case fall back to a small package `build`-script verify step that runs after `tsdown`. Default to the hook.
- Extract a tiny pure helper (text + symbol -> boolean) so the logic is unit-testable without invoking a real build.

**Patterns to follow:**
- The existing post-build plugin pattern in the repo's root `tsdown.config.ts` (e.g. the hidden-Unicode escape plugin) for hook shape and file-read/assert style.

**Test scenarios:**
- Happy path: guard logic returns true when the bundle text contains `startWorkspaceAgent`.
- Error path: guard logic returns false (and the build fails with the descriptive message) when the symbol is absent (simulating the action-harness bundle).
- Edge case: empty/missing bundle text fails closed (treated as absent symbol), not a crash.

**Verification:**
- A deliberately wrong entry (or empty bundle) causes the build to fail with the descriptive guard error; the correct build passes.

- [x] **Unit 3: CI repo-root build regression step**

**Goal:** Catch the full-monorepo regression in CI — the context the Docker smoke test cannot reproduce.

**Requirements:** R4

**Dependencies:** Units 1, 2

**Files:**
- Modify: `.github/workflows/ci.yaml` (add a step in the workspace-agent build/test path that runs the build from the repo root and confirms the guard passes)

**Approach:**
- Add a CI step that runs `pnpm --filter @fro-bot/workspace-agent build` from the repo root (where repo-root `src/main.ts` is present) and relies on the Unit 2 guard to fail if the wrong entry is bundled. Optionally add an explicit assertion that `dist/main.mjs` contains `startWorkspaceAgent` for a clear CI failure message.
- Place it where build/test for the package already runs so it triggers on relevant changes (respecting the existing `dorny/paths-filter` anchors — ensure `apps/workspace-agent/**` and the build config files trigger it).

**Patterns to follow:**
- Existing CI smoke/build steps in `.github/workflows/ci.yaml`; the repo convention for path-filter-gated jobs (see AGENTS rule on adding paths to both `config` and `src-changed` anchors when build config must trigger CI).

**Test scenarios:**
- Test expectation: none (CI configuration) — validated by the workflow running green on this PR with the guard exercised from the repo root. Manually reasoned: with Unit 1 reverted the step would fail (proving it guards the regression).

**Verification:**
- CI runs the repo-root build, the guard passes on the corrected entry, and the step is wired into the workspace-agent build/test path.

## System-Wide Impact

- **Interaction graph:** build-time only; no runtime code paths change. The Docker image build (`deploy/workspace.Dockerfile`) runs the same `pnpm --filter @fro-bot/workspace-agent build` and now also runs the Unit 2 guard — it must continue to pass (R5).
- **API surface parity:** none — leaf app, no type consumers.
- **Unchanged invariants:** workspace-agent runtime, ports, entrypoint guard, and the deployed Docker build flow are unchanged. The existing `Workspace Image Smoke Test` must stay green.
- **Integration coverage:** the new CI step proves the full-monorepo build context that unit tests and the Docker smoke test do not cover.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Scoping `rootDir` to `"src"` breaks type-checking (unexpected cross-tree dependency) | Verified the package is self-contained with no cross-package imports and `--noEmit`; `check-types` is run in the gate. If a hidden dependency surfaces, fall back to Option A + B alone (entry pin + guard) without the rootDir change. |
| Option B guard hook interferes with the build or the Docker build | Implement as a minimal post-write read/assert mirroring the existing post-build plugin pattern; the Docker `Workspace Image Smoke Test` validates the image still builds and boots. |
| CI step doesn't trigger on the relevant changes | Wire it into the existing workspace-agent build/test path and ensure the build-config files are in the correct `dorny/paths-filter` anchors. |

## Documentation / Operational Notes

- Close issue #847 on merge, noting the BOOTSTRAP.md mention was already-correct on main (non-issue).

## Sources & References

- **Origin:** [#847](https://github.com/fro-bot/agent/issues/847) + Fro Bot triage comment (requirements basis)
- Related code: `apps/workspace-agent/tsdown.config.ts`, `apps/workspace-agent/tsconfig.json`, `apps/workspace-agent/src/main.ts`, `deploy/workspace.Dockerfile`, `.github/workflows/ci.yaml`
- Related learnings: gateway image packaging solution (build-output assertion pattern)
