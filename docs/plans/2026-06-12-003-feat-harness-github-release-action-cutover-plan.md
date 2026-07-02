---
title: "feat: Harness GitHub Release + action cutover (C1)"
type: feat
status: done
date: 2026-06-12
deepened: 2026-06-12
origin: docs/brainstorms/2026-06-12-harness-github-release-and-action-cutover-requirements.md
---

> **Status: done.** All 5 units shipped: harness version computation + npm prerelease versioning, the `release-binaries` job creating GitHub Releases with `SHA256SUMS`, the action's download-source swap + harness-aware `getLatestVersion()`, stock fallback + integrity verification, and the npm-publish environment/docs cleanup — verified on `main` (`src/services/setup/opencode.ts`, `.github/workflows/harness-release.yaml`).

# feat: Harness GitHub Release + action cutover (C1)

## Overview

Add a GitHub Release channel to the `@fro.bot/harness` release pipeline and cut the Fro Bot **action** over to download the patched OpenCode binary from it, the same way the action already downloads stock OpenCode tarballs. Keep npm publishing for local `bunx`/`mise` use, but fix the npm version so it is no longer indistinguishable from stock OpenCode. The workspace executor (Alpine/musl) and gateway are explicitly **not** cut over here — that is C2.

## Problem Frame

The action runs **stock** OpenCode from `anomalyco/opencode` releases. The patched harness build ships only to npm (no GitHub Release), so the action cannot consume it through its existing download path. Additionally, the harness npm version is published as bare `1.17.3`, indistinguishable from stock OpenCode `1.17.3`. (see origin: docs/brainstorms/2026-06-12-harness-github-release-and-action-cutover-requirements.md)

## Requirements Trace

- R1. Harness-release workflow creates a GitHub Release tagged `v<base>+harness.<short8>` with generic glibc assets (`opencode-{linux-x64,linux-arm64}.tar.gz`, `opencode-{darwin-x64,darwin-arm64}.zip`), archive root = `opencode`.
- R2. New `release-binaries` job: `needs: build`, `contents: write`, no `id-token`; isolated from build and npm publish.
- R3. Action downloads from `fro-bot/agent` harness releases; `getLatestVersion()` bypasses stock-latest for harness pins.
- R4. The action gains the *capability* to consume a harness pin (`1.17.3+harness.<short8>`). **The actual flip of `DEFAULT_OPENCODE_VERSION` is a post-merge follow-up** — no `fro-bot/agent` release with `opencode-*` assets exists until this PR's `release-binaries` job runs after merge. This PR keeps the stock `1.17.3` default; a one-line follow-up flips it once the first harness release is published (matches the manual-bump model).
- R5. npm version becomes prerelease `<base>-harness.<short8>` across all 5 packages, `latest` dist-tag set to it.
- R6. Pre-removal verification gate for the npm trusted-publisher environment binding; remove `environment: npm-publish` only if safe, else keep + document.
- R7. Workspace Dockerfile untouched — stays on stock `anomalyco/opencode` until C2.
- R8. Stock `anomalyco/opencode` fallback preserved on harness download/verify failure before hard-fail.
- R9. Integrity: release job verifies each binary's `--version` matches `buildHarnessVersion(base, commit)` (operational); action verifies the downloaded asset against the published `SHA256SUMS` before extract (transport — net-new; the current `validateDownload()` is only a magic-byte `file` check, so there is no sha256 check to "preserve").
- R10. All-or-nothing release gate: release fails unless all four platform assets are present and verified.
- R11. Windows posture documented as unsupported for harness.

## Scope Boundaries

- Action-only cutover. No runtime behavior change in gateway or workspace.
- No consumer-bump automation (single consumer; manual pin bump).

### Deferred to Separate Tasks

- musl/baseline Linux target builds in the harness matrix: C2.
- Workspace + gateway cutover to harness: C2 (gateway rides the workspace via remote-attach).
- Consumer-bump PR automation: C2 (needs `pull-requests: write` + a second consumer).
- Windows harness builds: later/never.

## Context & Research

### Relevant Code and Patterns

- `src/services/setup/opencode.ts` — `DOWNLOAD_BASE_URL` (:9, hardcoded `anomalyco/opencode`), `buildDownloadUrl`, `installOpenCode` (cache + `FALLBACK_VERSION` fallback), `getLatestVersion` (:161, always queries stock latest).
- `packages/runtime/src/shared/constants.ts` — `DEFAULT_OPENCODE_VERSION` (single source of truth; consumed by the action setup path).
- `.github/workflows/harness-release.yaml` — `build` matrix (4 platforms, `--single`, glibc), per-platform artifacts `harness-binary-{platform}-{arch}`, `publish` job (`environment: npm-publish`, `id-token: write`, resolves `BASE_VERSION` + `INTEGRATION_COMMIT` at :421/:437, assembles + publishes 5 npm packages).
- `packages/harness/scripts/build-platform.ts` — produces `packages/opencode/dist/opencode-{platform}-{arch}/bin/opencode`.
- `packages/harness/src/provenance.ts` / `provenance.json` — `buildSha`/`integrationCommit`/`integrationRefs`, the trust anchor for integrity verification.

### Institutional Learnings

- Memory 5349: `--single` builds glibc only (skips musl, `build.ts:129`); workspace needs musl — hence the C1/C2 split.
- Memory 5352: npm strips build metadata → npm must use prerelease `<base>-harness.<short8>`; all 5 packages identical; `latest` dist-tag set explicitly.
- Memory 5347/5350: gateway is remote-attach (no own download); C1 is action-only.

### External References

- npm/cli #1479, npm #6379, SemVer §10 — npm strips build metadata on publish (via @librarian).

## Key Technical Decisions

- **npm prerelease vs GitHub build-metadata** (D2): npm = `<base>-harness.<short8>` (distinct/installable/`latest`-taggable); GitHub tag = `v<base>+harness.<short8>`. The `-`/`+` asymmetry is forced by npm semver, not preference. The npm-version helper mirrors `packages/harness/src/version.ts:buildHarnessVersion` (same signature/tests).
- **Release job isolation** (D7): `release-binaries` (`contents: write`, no `id-token`) separate from untrusted `build` (`contents: read`) and `publish-npm` (`id-token: write`). The untrusted LLM-merge build never gains write/publish capability.
- **Integrity is operational + transport, NOT a security boundary** (D10/R9): the binary, its `--version`, and provenance are all produced by the same untrusted build runner, so verifying against provenance is *not* cryptographic security (a compromised build produces matching provenance). The real security trust anchor is maintainer-gated dispatch + reviewed integration refs + harness-repo CI on the build scripts (which are checked into the trusted repo, not LLM-merged). What the checks buy: release-side **operational integrity** (the binary `--version` matches `buildHarnessVersion(base, commit)` — confirms the right commit was baked, not a stray stock binary) + action-side **transport integrity** (SHA-256 verify confirms no download corruption). Attestation/Sigstore is intentionally skipped — it would be signed by the same build pipeline, adding no security for a self-consumed binary.
- **Release-before-publish sequencing** (new — from deepening): `publish-npm` depends on `release-binaries` so the GitHub Release (with assets) exists before npm's `latest` dist-tag moves. Prevents the hazard where release fails after npm succeeds, leaving `bunx @fro.bot/harness` resolving a version whose binary was never released.
- **Checksums: aggregated `SHA256SUMS`** (from deepening): the release-binaries job emits one `SHA256SUMS` asset (de-facto standard for mise/aqua/local consumers); the action verifies its single platform asset against the matching line. (Not per-asset `.sha256` sidecars.)
- **Stock fallback preserved** (D9/R8): a missing/broken harness release must not break all production runs — fall back to stock `anomalyco/opencode` before hard-failing.
- **`getLatestVersion()` harness-awareness** (D4/R3): bypass the stock-latest probe for harness pins.
- **npm-publish environment removal is gated** (D6/R6): the GitHub `environment:` is embedded in the OIDC `sub` claim (`repo:ORG/REPO:environment:npm-publish`), so removing it when the npm trusted-publisher was configured *with* an environment breaks publishing with a subject mismatch. Verify first via npmjs.com UI (`npmjs.com/settings/<user>/packages/<pkg>/publishing` → Environment field). Remove only if blank; else keep + document.

## Open Questions

### Resolved During Planning

- npm version encoding: prerelease `<base>-harness.<short8>` (librarian-verified).
- `getLatestVersion()` for harness pins: bypass stock-latest.
- Edit surface: single `DEFAULT_OPENCODE_VERSION` constant + `opencode.ts` download logic.
- gateway: no C1 change (remote-attach).

### Resolved During Deepening

- Checksum mechanism: aggregated `SHA256SUMS` release asset (not per-asset sidecars, not provenance-embedded); action verifies its single platform line.
- Integrity framing: operational (release `--version` check) + transport (action sha256) — not a cryptographic security boundary; security anchors in maintainer-gated dispatch + reviewed refs + trusted build-script CI.
- Job sequencing: `publish-npm` depends on `release-binaries` so a failed release can't leave npm `latest` ahead of a non-existent GitHub Release.

### Deferred to Implementation

- Whether `getLatestVersion()` keeps any stock path at all, or is fully removed for harness mode — settle when reading the call sites.
- (R6 resolved: maintainer verified the Environment field is blank for all 5 packages → straight removal is safe.)

## Implementation Units

- [x] **Unit 1: Compute harness version strings + fix npm prerelease versioning**

**Goal:** Publish npm as the prerelease `<base>-harness.<short8>` across all 5 packages with the `latest` dist-tag set to it; expose the GitHub tag form `v<base>+harness.<short8>` for the release job.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Modify: `.github/workflows/harness-release.yaml` (publish job: compute `NPM_VERSION=<base>-harness.<short8>` and `RELEASE_TAG=v<base>+harness.<short8>` from existing `BASE_VERSION` + `INTEGRATION_COMMIT`; apply `NPM_VERSION` to main + 4 platform package versions; set `latest` dist-tag explicitly)
- Modify: `packages/harness/scripts/*` assemble logic if version is set there (verify where the 5 package versions are written)
- Test: `packages/harness/**/*.test.ts` for any version-string helper extracted

**Approach:**
- Add a small pure helper (TS, under `packages/harness/src/`) that derives `{npmVersion, releaseTag}` from `(baseVersion, integrationCommit)`; unit-test it. Wire the workflow to use it (or mirror it in shell with a guard test).
- All 5 packages must receive the identical prerelease string (optionalDependencies exact-match).
- `npm publish` cannot set a prerelease as `latest` implicitly — add an explicit `npm dist-tag add <pkg>@<npmVersion> latest` step (idempotent), guarded for dry-run.

**Patterns to follow:** existing `buildHarnessVersion` / version helpers in `packages/harness/src/` (doctor already computes `<base>+harness.<short8>`).

**Test scenarios:**
- Happy path: `(1.17.3, ed359558abc...)` → `{npmVersion: "1.17.3-harness.ed359558", releaseTag: "v1.17.3+harness.ed359558"}`.
- Edge case: short8 truncation from a full 40-char SHA is exactly 8 chars.
- Edge case: base already carrying a prerelease/suffix is rejected or handled per the existing base-version validation.

**Verification:** a dry-run publish names all 5 packages `1.17.3-harness.<sha>`; `latest` would resolve to it; harness tests pass.

- [x] **Unit 2: `release-binaries` job — package OpenCode-shaped assets + create the GitHub Release**

**Goal:** A new isolated job that downloads the 4 build artifacts, repackages them into stock-shaped assets, verifies integrity, and creates the GitHub Release — all-or-nothing.

**Requirements:** R1, R2, R9, R10

**Dependencies:** Unit 1 (release tag string)

**Files:**
- Modify: `.github/workflows/harness-release.yaml` (add `release-binaries` job: `needs: build`, `permissions: {contents: write}`, no `id-token`)
- Possibly add: `packages/harness/scripts/package-release-assets.ts` (repackage artifact → `opencode-{os}-{arch}.{tar.gz|zip}`, archive root = `opencode`) + test

**Approach:**
- Download `harness-binary-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}`; each contains `opencode-{platform}-{arch}/bin/opencode` (the exact `build-platform.ts` `emitBinary` layout).
- **Existence gate first (R10):** before repackaging, assert all 4 binaries exist and are non-empty; fail the job immediately if any is missing (covers transient artifact expiry / partial upload). The matrix `fail-fast: true` + `needs: build` already handles per-platform build failures; add `if: !cancelled() && needs.build.result == 'success' && (needs.integrate.result == 'success' || == 'skipped')`.
- **Operational integrity (R9):** verify each binary's `--version` == `buildHarnessVersion(BASE_VERSION, INTEGRATION_COMMIT)` (recompute from workflow outputs — there is no provenance artifact uploaded from build; release-binaries computes its own from `needs.build.outputs.integration_commit` + `BASE_VERSION`). Add `buildSha` (= `GITHUB_SHA`) to the build job outputs for downstream reference.
- Repackage: linux → `.tar.gz`, darwin → `.zip`, binary at archive root.
- Emit one aggregated `SHA256SUMS` over the 4 assets (`sha256sum ./* > SHA256SUMS`); upload it alongside the 4 assets.
- Create the GitHub Release at `v<base>+harness.<short8>` via plain `gh release create` (the upstream/repo pattern; no `softprops/action-gh-release`). Draft-then-publish is rejected — no human reviewer in the loop, and `gh release create --assets` is atomic. Not marked the repo's `latest` GitHub release.

**Patterns to follow:** existing artifact download steps in the publish job; plain `gh release create -d --title ... --notes-file ...` from upstream `script/version.ts`; `verify-binary.ts` already verifies `--version` in the build job (reuse its check shape).

**Test scenarios:**
- Happy path (pure packager): given a dir with an `opencode` binary, produces a `.tar.gz`/`.zip` with `opencode` at root.
- Error path: missing one platform binary → packager/job signals failure (feeds R10 gate).
- Integrity: a binary whose digest mismatches `provenance.json` → verification fails.

**Verification:** dry-run produces 4 correctly-named, correctly-shaped assets + checksums; a simulated missing/4th asset fails the job; a real release lists all 4 + checksums.

- [x] **Unit 3: Action download source swap + `getLatestVersion()` harness-awareness**

**Goal:** The action downloads the harness binary from `fro-bot/agent` releases at `v<base>+harness.<short8>` and never misroutes a harness pin to stock latest.

**Requirements:** R3, R4

**Dependencies:** Unit 2 (a real harness release to download in verification)

**Files:**
- Modify: `src/services/setup/opencode.ts` (`DOWNLOAD_BASE_URL` / `buildDownloadUrl` for harness pins → `fro-bot/agent`; `getLatestVersion` bypasses stock-latest for harness versions)
- Modify: `packages/runtime/src/shared/constants.ts` (`DEFAULT_OPENCODE_VERSION` → `1.17.3+harness.<short8>`)
- Test: `src/services/setup/opencode.test.ts` (URL construction for harness vs stock; getLatestVersion routing)

**Approach:**
- Detect a harness pin (version containing `+harness.`); route its download URL to `fro-bot/agent` releases with the `v`-prefixed tag. **URL-encode the `+` as `%2B`** in the download URL path — GitHub stores the tag URL-encoded, and the raw `+` is misread by HTTP infra (deepening Finding 7; `actions/download-artifact` is unaffected but `buildDownloadUrl` constructs a raw URL).
- `getLatestVersion()`: for harness pins, do not call `anomalyco/opencode/releases/latest`; resolve from the pinned version. Keep stock behavior only for non-harness pins.

**Patterns to follow:** existing `buildDownloadUrl` os/arch/ext mapping; existing version-detection helpers.

**Test scenarios:**
- Happy path: harness pin `1.17.3+harness.abc12345` → URL `https://github.com/fro-bot/agent/releases/download/v1.17.3+harness.abc12345/opencode-linux-x64.tar.gz`.
- Happy path: stock pin `1.17.3` → unchanged `anomalyco/opencode` URL.
- Edge case: `+` in the tag path segment resolves/encodes correctly.
- Error/routing: harness pin never triggers the `anomalyco/opencode/releases/latest` fetch.

**Verification:** action tests pass; a manual/CI run downloads the real harness binary and `opencode --version` reports `1.17.3+harness.<sha>`.

- [x] **Unit 4: Stock fallback + download integrity verification in the action**

**Goal:** A bad/missing harness release does not break runs (falls back to stock), and the downloaded binary is integrity-checked before execution.

**Requirements:** R8, R9

**Dependencies:** Unit 3

**Files:**
- Modify: `src/services/setup/opencode.ts` (`installOpenCode` fallback path: on harness download/verify failure, attempt stock `anomalyco/opencode`; verify checksum before use)
- Test: `src/services/setup/opencode.test.ts` (fallback + integrity)

**Approach:**
- Split `validateDownload()` into two branches: harness pins → download the release's `SHA256SUMS`, compute the asset's sha256, verify the matching line (`shasum -a256 -c` via `execAdapter`), then extract; stock fallback → keep the existing magic-byte `file` heuristic (no `SHA256SUMS` exists for `anomalyco/opencode`).
- Wrap harness download in a try/verify in `installOpenCode`; on failure (404, missing asset, sha256 mismatch) log a warning and fall back to a known-good stock version before hard-failing. Mirror the existing `FALLBACK_VERSION` double-`downloadTool` test pattern (`opencode.test.ts:215`).

**Test scenarios:**
- Error path: harness release 404 → stock fallback attempted, install succeeds.
- Error path: checksum mismatch → reject the binary; fall back or hard-fail per policy.
- Happy path: valid harness asset + matching checksum → installs, no fallback.

**Verification:** action tests cover fallback + integrity; injected bad-release path falls back cleanly.

- [x] **Unit 5: npm-publish environment removal (gated) + Windows/posture docs**

**Goal:** Remove the redundant `environment: npm-publish` only if the npm trusted-publisher binding allows it; document harness as linux/darwin-only.

**Requirements:** R6, R11, R7

**Dependencies:** None (independent; sequence last)

**Files:**
- Modify: `.github/workflows/harness-release.yaml` (remove `environment: npm-publish` from publish job IF safe; keep `id-token: write`)
- Modify: `packages/harness/AGENTS.md` / `deploy/README.md` as needed (Windows unsupported; npm prerelease + GitHub tag scheme; C1/C2 split note)
- Confirm: `deploy/workspace.Dockerfile` is untouched (R7)

**Approach:**
- R6 gate ALREADY VERIFIED (maintainer checked npmjs.com): the Environment field is **blank** for all 5 packages' trusted-publisher configs, so removing `environment: npm-publish` is safe — the OIDC `sub` becomes `repo:fro-bot/agent:ref:...` (no `:environment:` segment), matching the npm-side config. Straight removal; keep `id-token: write`. No conditional.
- Document the versioning scheme (npm prerelease `-harness.<sha>` + GitHub tag `+harness.<sha>`) and the linux/darwin-only posture.

**Test scenarios:**
- Test expectation: none — workflow/docs change; covered by the dry-run publish still succeeding (publishing does not break after the environment decision).

**Verification:** a dry-run (or real) publish still succeeds after the environment decision; docs state the scheme + posture; `deploy/workspace.Dockerfile` diff is empty.

## System-Wide Impact

- **Interaction graph:** the action setup path (`runSetup` → `installOpenCode`) is the only runtime consumer changed. Gateway/workspace runtime unaffected (R7).
- **Error propagation:** harness download failure must degrade to stock (R8), not throw — preserve the existing fallback contract.
- **API surface parity:** the bundled `dist/main.mjs` for action + gateway both embed `installOpenCode`; only the action invokes it at runtime. Rebuild `dist/` after the source change; gateway behavior unchanged.
- **Unchanged invariants:** workspace Dockerfile, gateway remote-attach, npm publishing mechanism (OIDC), stock-OpenCode download path for non-harness pins.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Removing `environment: npm-publish` breaks OIDC publishing | R6 gate: verify trusted-publisher binding first; keep if bound |
| `+` in tag/URL breaks a tool | Validate tag→release→download end-to-end before locking; `%2B` or `-harness` fallback |
| Bad harness release breaks all runs | R8 stock fallback + R10 all-or-nothing gate + R9 integrity |
| Release fails after npm publishes → `bunx` resolves a binary-less version | Sequence `release-binaries → publish-npm` (publish needs release-binaries); npm `latest` never moves without a successful GitHub Release |
| Untrusted build artifact promoted to release | Honest scope: operational integrity only (R9). Security anchors in maintainer-gated dispatch + reviewed integration refs + trusted (non-LLM-merged) build-script CI — NOT in provenance verification (same runner produces both) |
| Mixed fleet (action on harness, workspace/gateway on stock) lingers | C2 exit criteria documented in origin; accepted interim state |

## Documentation / Operational Notes

- Document the npm prerelease + GitHub build-metadata scheme and the linux/darwin-only posture (Unit 5).
- After cutover, the maintainer manually bumps `DEFAULT_OPENCODE_VERSION` when a new harness ships (no automation in C1).
- `dist/` must be rebuilt and committed after the `opencode.ts` / constants change.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-12-harness-github-release-and-action-cutover-requirements.md](../brainstorms/2026-06-12-harness-github-release-and-action-cutover-requirements.md)
- Related code: `src/services/setup/opencode.ts`, `.github/workflows/harness-release.yaml`, `packages/harness/scripts/build-platform.ts`, `packages/harness/src/provenance.ts`
- External: npm/cli #1479, npm #6379, SemVer §10 (build metadata stripping)
