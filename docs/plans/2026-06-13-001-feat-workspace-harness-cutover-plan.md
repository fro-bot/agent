---
title: "feat: Cut the workspace executor over to the harness OpenCode binary"
type: feat
status: active
date: 2026-06-13
deepened: 2026-06-13
origin: docs/brainstorms/2026-06-13-workspace-harness-cutover-requirements.md
---

# feat: Cut the workspace executor over to the harness OpenCode binary

## Overview

The GitHub Action runs the patched harness OpenCode build by default (PR #884). The gateway's **workspace executor image** still bakes stock OpenCode from `anomalyco/opencode`. This plan extends the harness release to publish musl + x64-baseline Linux assets, then repoints `deploy/workspace.Dockerfile` at the harness release so the workspace runs the same patched binary — delivering the carried session/plugin/compaction fixes (#19961, #31859, #31638) into the mention-loop execution path. The gateway process is unchanged (it remote-attaches to the workspace OpenCode proxy and bakes no binary).

## Problem Frame

The workspace is Alpine-based and needs **musl** OpenCode binaries (`opencode-linux-x64-baseline-musl.tar.gz`, `opencode-linux-arm64-musl.tar.gz`). The harness release currently publishes only **generic glibc** assets, because `build-platform.ts` invokes upstream `build.ts --single`, which hard-skips musl targets (verified: `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/script/build.ts:116-135`). A glibc binary cannot run on Alpine, so this is not a simple repoint — the harness Linux build must additionally produce the musl/baseline variants. (see origin: docs/brainstorms/2026-06-13-workspace-harness-cutover-requirements.md)

## Requirements Trace

- R1. The harness release publishes `opencode-linux-x64-baseline-musl.tar.gz` and `opencode-linux-arm64-musl.tar.gz` from the same pinned integration commit, `--version` reporting `<base>+harness.<sha>`, alongside the existing generic glibc assets.
- R2. The new musl/baseline assets are included in the release `SHA256SUMS`.
- R3. `deploy/workspace.Dockerfile` downloads the binary from `fro-bot/agent` harness releases (not `anomalyco/opencode`), using the `+harness.<sha>` version (`+`→`%2B`), keeping the existing musl/baseline asset names.
- R4. The workspace download verifies the asset against the release `SHA256SUMS` before use (fail-closed) — an upgrade from today's unchecked `curl | tar`.
- R5. The workspace `OPENCODE_VERSION` advances in lockstep with the action default: the harness-release `sync-default-version` job bumps both `DEFAULT_OPENCODE_VERSION` and `deploy/workspace.Dockerfile`'s `ARG OPENCODE_VERSION` to the same build in one auto-PR. The **merge gate** on that PR is the rollback/lag valve (not merging holds both surfaces at the prior build), and a single PR can be reverted to roll both back. Renovate does not track the workspace harness ARG (build-metadata tags have no reliable ordering). *(Revised from the original "independent pin": leaving the workspace permanently un-bumped was a false safety — the merge gate already provides the control, while independence caused silent staleness.)*
- R6. The existing action glibc download path (PR #884) is unchanged.
- R7. The gateway image and process are unchanged.
- R8. Verification goes beyond `--version`: the `Workspace Image Smoke Test` proves the musl harness binary boots on Alpine and exercises a real execution path.
- R9. The release workflow's Linux asset handling — build matrix, download, existence gate, repackaging, `SHA256SUMS`, upload — expands from the current 4-asset world to include the new musl/baseline assets. The glibc `linux-x64`/`linux-arm64` assets remain published unchanged (musl is **additive**); x64 builds twice (glibc + baseline-musl).
- R10. Workspace download fail-closed semantics are explicit: any download, checksum fetch, hash mismatch, partial download, or 404 aborts the build with no fallback (no cached-binary fallback, no stock fallback, no silent retry); smoke coverage includes a hash-mismatch / missing-checksum negative path.
- R11. The build job asserts the patch took effect **in the real publish path** (not only the dry-run): after patching `build.ts`, verify the patch hunks landed (grep for the target-selector hook, fail fast if absent), and after building, verify each emitted Linux musl artifact is actually musl (`file`/`ldd`) before packaging — so a silently-failed patch produces a loud build failure, never a wrong-libc asset. This runs every release because the LLM-merge integration commit (and thus the build) differs each run, making a green dry-run non-authoritative for the published artifact.
- R12. The build job's isolation is preserved: `contents: read`, no `id-token`, `persist-credentials: false`; the `build.ts` patch step is a local build-time mutation of the checked-out source tree only — no git push, no credentials, no OIDC, constrained to a narrow diff around the `singleFlag` filter.

## Scope Boundaries

- The `@opencode-ai/sdk` pin stays stock `1.17.3`.
- The action glibc download path (#884) is unchanged (R6).
- The gateway image/process is unchanged (R7).
- Darwin assets are unchanged (the workspace is Linux-only).

### Deferred to Separate Tasks

- Migrating the action path to musl (would let the glibc assets drop): future, only if ever desired.
- Coupling the workspace pin to the action self-update mechanism: explicitly rejected (R5 keeps it independent).

## Context & Research

### Relevant Code and Patterns

- `deploy/workspace.Dockerfile:41-65` — workspace OpenCode bake (the consumption side to repoint).
- `packages/harness/scripts/build-platform.ts:219-320` — `runUpstreamBuild` (hardcodes `build.ts --single`), `resolveBuiltBinaryPath`/`emitBinary` (assume generic `opencode-<os>-<arch>` dir).
- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/script/build.ts:53-199` — target matrix, `--single` filter (skips musl), per-target build loop (`name` = pkg+os+arch+baseline+abi, `FFF_LIBC`, Bun `--target`).
- `.github/workflows/harness-release.yaml:213-228` (per-platform build matrix), `:334-339,495-547` (Release Binaries packaging/checksum/upload, hardcoded 4 assets).
- `src/services/setup/opencode.ts` — the action's harness download + SHA256SUMS verification + `%2B` encoding pattern to mirror in the Dockerfile (R3/R4).
- `.github/renovate.json5:84-92` — workspace `OPENCODE_VERSION` manager to retarget (R5).

### Institutional Learnings

- Memory 5392 (C2 gap: harness glibc-only, workspace needs musl), 5393 (cutover value confirmed 3/3), 5394 (build-invocation spike: `--single` can't emit musl).
- Memory 5361 (published release `v1.17.3+harness.2c9cdbd2`).
- `docs/solutions/` harness build/version docs (versioned-tool, harness-base-version-source-of-truth).

## Key Technical Decisions

- **Build-invocation strategy: ephemeral workflow-time patch to `build.ts`.** Since `build.ts --single` cannot emit musl and has no target-selection hook, the harness-release workflow applies a small patch to the integration-tree `build.ts` (after checkout, before build) **adding an explicit target selector** that the `singleFlag` path honors (not merely removing the musl skip); the per-`item` build loop is already target-parameterized, so the patch is local to the `singleFlag` filter (`build.ts:116-135`). `build-platform.ts` then requests the specific musl/baseline target per Linux runner, and its `resolveBuiltBinaryPath`/`emitBinary` become target-aware for the `-baseline-musl`/`-musl` dist dir names. The patch is applied to `${RUNNER_TEMP}/integration-src` (the `--source-tree` `build-platform.ts` actually builds from — verified, not a fresh clone). Chosen over a permanent carried integration patch (consumes a harness carry slot, permanently forks upstream — against the lean 1-3 ref carry policy) and over the full non-`--single` matrix (builds 10 unused Windows/macOS targets per Linux run — wasteful).
- **Checksum is transport integrity, not provenance.** `SHA256SUMS` is same-release/same-origin — it proves integrity-in-transit, not that the binary came from a trusted build. Provenance comes from commit-pinning (the resolved integration commit threaded build→release) plus the build job's isolation (R12). The workspace consumes the exact `v<base>+harness.<sha>` tag/asset tuple.
- **Both libc flavors published — compatibility constraint, not goal.** The generic glibc assets are kept solely so the action path (#884) is undisturbed; the workspace needs musl. Not core scope.
- **Workspace pin independent (R5).** Preserves the lag/rollback safety valve the action/workspace split was designed for (the workspace deliberately lagged the action during the 1.15.13/1.17.3 cutovers).
- **Fail-closed download with checksum (R4/R10).** Mirrors the action's harness-download posture; upgrades the workspace from unchecked `curl | tar`.

## Open Questions

### Resolved During Planning

- How does the harness Linux build emit musl? — Ephemeral workflow-time `build.ts` patch + per-runner target selection (KTD).
- musl-only or both libc flavors? — Both (compatibility constraint for the action).
- Workspace pin coupling? — Independent (R5).
- Is the cutover valuable? — Yes, 3/3 carried patches affect the workspace (origin doc, verified).

### Deferred to Implementation

- **Exact shape of the `build.ts` target-selector patch** (new `--target os/arch/abi/baseline` flag vs env vars) — settle against the real integration-tree `build.ts` during Unit 1; the loop body is already per-`item` parameterized, so the patch targets the `singleFlag` filter (`build.ts:116-135`).
- **CI wall-clock cost** of the two extra Linux targets — measure via the Unit 4 dry-run before treating "incremental" as fact; if material, reconsider.
- **Asset packaging dir-name resolution** — `resolveBuiltBinaryPath`/`emitBinary` must become target-aware for the `-baseline-musl`/`-musl` dist dirs; exact dir names confirmed against a real build in Unit 1.
- **The functional smoke probe shape (R8)** — what "real execution path" the workspace smoke exercises (binary boot in server mode + one interaction) vs. just `--version`; settle against the existing `Workspace Image Smoke Test` job.

## Implementation Units

- [ ] **Unit 1: Harness build emits musl/baseline Linux targets**

**Goal:** Make the harness Linux build produce `linux-x64-baseline-musl` and `linux-arm64-musl` binaries via an ephemeral `build.ts` target-selector patch + target-aware wrapper.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `.github/workflows/harness-release.yaml` (build job: add a step that patches the integration-tree `build.ts` after checkout; expand/parameterize the Linux build matrix for the musl/baseline targets)
- Modify: `packages/harness/scripts/build-platform.ts` (`runUpstreamBuild` to pass the target selection; `resolveBuiltBinaryPath`/`emitBinary` to handle `-baseline-musl`/`-musl` dist dir names)
- Test: `packages/harness/scripts/build-platform.test.ts` (target-name/dir resolution)

- Add a CLI flag(s) to `build-platform.ts` (e.g. `--abi musl`, `--baseline`) selecting the Linux variant; thread it into `runUpstreamBuild` and make `resolveBuiltBinaryPath`/`emitBinary` target-aware for the `-baseline-musl`/`-musl` dist dir names.
- In the workflow, after the integration-tree checkout (`fetch-integrate`), apply a minimal patch to `${RUNNER_TEMP}/integration-src/packages/opencode/script/build.ts` adding an explicit target selector the `singleFlag` path honors. Constrain the patch to a narrow diff around the `singleFlag` filter (R12).
- **Guard (R11): assert the patch landed** (grep for the selector hook; fail fast if absent) immediately after patching, before building.
- Expand the Linux matrix entries: keep `linux/x64` glibc unchanged (for the action), **add** `linux/x64` baseline-musl and `linux/arm64` musl (additive, for the workspace). x64 builds twice (glibc + baseline-musl). Each runs on its native runner.

**Patterns to follow:** existing `build-platform.ts` arg parsing + `runUpstreamBuild`; the per-platform matrix in `harness-release.yaml:213-228`.

**Test scenarios:**
- Happy path: target-name resolution returns the `-baseline-musl` / `-musl` dist dir for the new variants and the plain dir for glibc.
- Edge case: an unknown/unsupported abi/baseline combination is rejected with a clear error.
- Integration (workflow, proven in Unit 4 dry-run, not unit-testable): the patched `build.ts` actually emits a musl binary (`file`/`ldd` shows musl, not glibc).

**Verification:** a dry-run (Unit 4) produces musl/baseline binaries whose libc is verified musl and `--version` reports the harness version.

- [ ] **Unit 2: Release workflow publishes + checksums the new assets**

**Goal:** Expand Release Binaries asset handling from 4 to 6 so the musl/baseline assets are packaged, checksummed, and uploaded.

**Requirements:** R2, R9

**Dependencies:** Unit 1

**Files:**
- Modify: `.github/workflows/harness-release.yaml` (Release Binaries job: download/existence-gate/repackage/`SHA256SUMS`/upload steps)

- Add `opencode-linux-x64-baseline-musl.tar.gz` and `opencode-linux-arm64-musl.tar.gz` to every step currently hardcoded around the 4-asset set (existence gate, `sha256sum ... > SHA256SUMS`, `gh release upload`).
- **Libc assertion (R11): before packaging, verify each Linux musl artifact is actually musl** (`file`/`ldd`) in the real build/publish path — not only the dry-run — so a non-deterministic LLM-merge run that silently built glibc fails loud rather than publishing a wrong-libc asset.
- Keep the all-or-nothing publish semantics: a missing new asset fails the release.

**Patterns to follow:** the existing 4-asset handling in `harness-release.yaml:334-339,495-547`; the `release-binaries` arch-verify pattern (only run native `--version` on the runner-matching artifact).

**Test scenarios:** Test expectation: none — workflow change; validated via `actionlint` (Unit 5) and the Unit 4 dry-run (assets present in the release + in `SHA256SUMS`).

**Verification:** dry-run release contains all 6 assets and `SHA256SUMS` lists the 2 new ones.

- [ ] **Unit 3: Workspace Dockerfile repoint + checksum verification**

**Goal:** Point the workspace OpenCode bake at the harness release with fail-closed checksum verification and the harness version.

**Requirements:** R3, R4, R10, R5

**Dependencies:** Units 1-2 **must publish the new musl assets first** — the existing `v1.17.3+harness.2c9cdbd2` release does NOT have musl assets, so it cannot be used as a consumption surrogate. Unit 3 repoint can only be tested/deployed after a real release carrying the musl assets exists.

**Files:**
- Modify: `deploy/workspace.Dockerfile` (download host → `fro-bot/agent`, `+`→`%2B` URL encoding, fetch `SHA256SUMS`, verify the selected asset before extract, fail-closed)
- Modify: `.github/renovate.json5` (retarget the workspace `OPENCODE_VERSION` manager to the harness release channel; keep it independent of the action default)
- Modify: `deploy/README.md` (operator note: workspace now runs the harness binary; independent pin)

**Approach:**
- Mirror the action's harness download pattern from `src/services/setup/opencode.ts`: construct the `fro-bot/agent` release URL with `%2B`-encoded `+`, download `SHA256SUMS`, verify the asset hash, abort with no fallback on any failure (R10).
- Keep the existing `TARGETARCH`→asset-name mapping (`opencode-linux-x64-baseline-musl`, `opencode-linux-arm64-musl`) as a **fixed allowlist** (not free-form interpolation), and validate the version string before interpolation — mirroring the action's safe pattern — so the download URL/path has no traversal/injection surface.
- `OPENCODE_VERSION` becomes the `<base>+harness.<sha>` form; Renovate manager retargets to track `fro-bot/agent` harness releases independently.

**Patterns to follow:** `src/services/setup/opencode.ts` harness download + SHA256SUMS verification; existing Dockerfile `TARGETARCH` case.

**Test scenarios:** Test expectation: none for the Dockerfile itself (no unit layer) — behavior is proven by the Unit 5 smoke test (R8) including the R10 negative path.

**Verification:** the image builds, downloads the musl harness asset from `fro-bot/agent`, verifies the checksum, and boots; a tampered/missing checksum aborts the build.

- [ ] **Unit 4: Dry-run validation (CI cost + asset correctness)**

**Goal:** Prove end-to-end via a real harness-release dry-run before any publish, and measure the added CI cost.

**Requirements:** R1, R2, R9

**Dependencies:** Units 1-2

**Files:**
- None (operational: `gh workflow run harness-release.yaml -f base_version=1.17.3 -f dry_run=true`)

- Dispatch a dry-run; confirm the 6 assets assemble, `SHA256SUMS` covers them, and the musl binaries are actually musl (`file`/`ldd`). Note: the dry-run is a **build-shape check**, not authoritative for the published artifact (the LLM-merge integration commit differs per run); the R11 build-job guard is what protects the real publish.
- Record the Linux-runner wall-clock delta vs the prior 4-asset run. **Abort threshold:** if the added musl targets slow the harness release by more than ~50% or more than ~10 minutes wall-clock, stop and revisit the build strategy (full-matrix vs per-target, or whether x64-baseline is required) before proceeding to publish.

**Test scenarios:** Test expectation: none — operational validation gate.

**Verification:** dry-run succeeds, all 6 assets present + checksummed, musl confirmed via `file`/`ldd`, CI cost recorded against the abort threshold.

- [ ] **Unit 5: Workspace smoke test (functional, beyond --version) + negative path**

**Goal:** Prove the musl harness binary boots on Alpine and runs a real execution path, plus the fail-closed negative path.

**Requirements:** R8, R10

**Dependencies:** Units 1-3

**Files:**
- Modify: `.github/workflows/ci.yaml` (the `Workspace Image Smoke Test` job)
- Modify: `deploy/` smoke assets as needed

**Approach:**
- Extend the smoke beyond `opencode --version`: launch the binary in the production server mode (`opencode serve` as the workspace does) and verify one real interaction / readiness, catching libc-loader or runtime issues `--version` misses.
- Add a negative-path assertion: a tampered or missing `SHA256SUMS` / hash mismatch aborts the image build with no fallback (R10).

**Patterns to follow:** the existing `Workspace Image Smoke Test`; the workspace `opencode serve` launch in `apps/workspace-agent/src/opencode-server.ts`.

**Test scenarios:**
- Happy path: musl harness binary boots on Alpine, `opencode serve` reaches readiness, `--version` reports the harness version.
- Error path: checksum mismatch / missing `SHA256SUMS` aborts the build (no stale-binary fallback).

**Verification:** the smoke job proves boot + a real execution path on the musl harness binary and the fail-closed negative path.

## System-Wide Impact

- **Interaction graph:** the workspace OpenCode binary runs the gateway mention loop (`packages/gateway/src/execute/run-core.ts` drives `session.promptAsync`); the harness patches (#19961/#31859/#31638) now apply there.
- **Error propagation:** the workspace download becomes fail-closed (R4/R10) — a bad/missing asset aborts the image build rather than silently shipping stock.
- **State lifecycle risks:** version skew between action (glibc harness) and workspace (musl harness) is intentional and independently pinned (R5); both track the same `+harness.<sha>` base but can advance/rollback separately.
- **Unchanged invariants:** action glibc path (#884), gateway image/process, SDK pin, darwin assets — all explicitly unchanged (R6/R7 + Scope).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `build.ts` target-selector patch is more invasive than expected | Unit 1 settles the exact patch against real source; the loop is already per-`item` parameterized, only the `singleFlag` filter needs the hook |
| musl build silently produces glibc (or vice versa) | Unit 4 dry-run verifies libc via `file`/`ldd`; Unit 5 smoke boots it on Alpine |
| Extra Linux targets materially slow every harness release | Unit 4 measures the delta; revisit strategy if material |
| Workspace gets a glibc binary by mistake (won't boot on Alpine) | Explicit musl asset name + checksum + R8 functional smoke |
| Supply-chain trust shifts to our LLM-merge pipeline | Bounded by workspace sandbox-net + mitmproxy egress containment; checksum proves integrity-in-transit (note: not provenance) |
| Ephemeral workflow patch drifts from upstream `build.ts` shape | Keep the patch minimal + local to the `singleFlag` filter; the dry-run catches breakage before publish |

## Documentation / Operational Notes

- `deploy/README.md`: workspace now runs the harness binary; independent version pin; how to bump/rollback the workspace OpenCode version separately from the action.
- **Rollback matrix (R5 independence needs an explicit procedure):** if the musl workspace binary misbehaves in the mention loop while the action path is healthy, roll back **only** the workspace `OPENCODE_VERSION` pin to the prior harness release (or to a prior stock musl release as a last resort); leave the action's harness SHA untouched. Action and workspace may be temporarily out of phase — that is acceptable by design (R5). Document this as the "workspace smoke/mention-loop failure" runbook entry.
- **Sequencing:** the first real (non-dry-run) harness release after Units 1-2 land must publish the new musl assets before the workspace repoint (Unit 3) can consume them in production.
- **Smoke scope honesty (R8):** the `Workspace Image Smoke Test` proves boot + readiness + one real interaction on the musl harness binary — it catches libc-loader/boot failures `--version` misses, but is not full mention-loop load coverage. Real-traffic regressions are caught by the existing post-deploy behavior in the mention loop, not this smoke; treat the smoke as a boot/readiness gate, not a traffic canary.

## Sources & References

- **Origin document:** docs/brainstorms/2026-06-13-workspace-harness-cutover-requirements.md
- Build-invocation analysis (this session, explorer): `build.ts:53-199`, `build-platform.ts:219-320`.
- Memory 5392/5393/5394 (gap, value, spike).
- Related: PR #884 (action harness cutover — download/checksum/`%2B` pattern).
