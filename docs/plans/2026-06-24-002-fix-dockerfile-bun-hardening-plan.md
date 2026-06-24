---
title: 'fix: harden Bun install in deploy Dockerfiles (verified binary) and trim runtime image'
type: fix
status: active
date: 2026-06-24
---

# Harden Bun install in deploy Dockerfiles + trim runtime image

## Overview

Close #1003, the remaining Bun-migration deploy follow-up. Replace the unverified `npm i -g bun@${BUN_VERSION}` in both deploy Dockerfiles with a checksum-verified download of the official oven-sh/bun release binary (mirroring the existing OpenCode verified-binary pattern), and trim devDependencies out of the runtime images by copying a production-only `node_modules`.

## Problem Frame

The pnpm→Bun migration installed Bun in both `deploy/gateway.Dockerfile` and `deploy/workspace.Dockerfile` via `RUN npm i -g bun@${BUN_VERSION}` — pulling the `bun` npm wrapper package with no integrity check, unlike CI (`oven-sh/setup-bun@v2`) and unlike the workspace image's own OpenCode binary, which is fetched from a GitHub release and verified against `SHA256SUMS` fail-closed. Separately, the migration's build stage runs a full `bun install --frozen-lockfile` (devDependencies included, required because the build typechecks test files that import vitest), and the runtime stage copies that full `node_modules` — so the deployed images carry the dev toolchain (vitest, tsdown, eslint, …). This is hardening, not a correctness fix: the images work today.

## Requirements Trace

- R1. Both deploy Dockerfiles install Bun from the official oven-sh/bun GitHub release, verified against the release `SHASUMS256.txt` fail-closed (any download/checksum/mismatch/missing-entry aborts the build).
- R2. Bun binary selection is arch-aware and Alpine-compatible (musl), matching the build base image.
- R3. The runtime stage of both images carries a production-only `node_modules` (devDependencies excluded), and the gateway/workspace processes still start and pass their existing smoke tests.
- R4. `BUN_VERSION` stays the single Renovate-tracked source for the Bun version (no second literal introduced).

## Scope Boundaries

- Not changing the OpenCode binary install (already verified) — only mirroring its pattern for Bun.
- Not changing which dependencies are bundled vs external (the tsdown `noExternal` config is unchanged); the trim only affects which `node_modules` tree the runtime stage receives.
- Not pinning per-arch SHA256 literals in the Dockerfile — fetch-and-verify against `SHASUMS256.txt` at build time, matching the OpenCode pattern (keeps `BUN_VERSION` the single source).

## Context & Research

### Relevant Code and Patterns

- `deploy/workspace.Dockerfile` lines 90-126 — the **gold-standard verified-binary pattern** to mirror: `TARGETARCH` allowlist → percent-encode the tag → `curl --retry` the asset + checksum file → `awk` the expected hash → compare fail-closed → extract/chmod/verify. Reuse this shape for Bun.
- `deploy/gateway.Dockerfile` lines 6-9, 28, 46 — Bun install + full install + runtime copy of full `node_modules`.
- `deploy/workspace.Dockerfile` lines 24-27, 46, 139 — same shape.
- Bun release assets (verified against `oven-sh/bun` release `bun-v1.3.14`): the Alpine-compatible musl variants are `bun-linux-x64-musl-baseline.zip` (x64, AVX2-independent — mirrors the OpenCode baseline choice) and `bun-linux-aarch64-musl.zip` (arm64). Checksums live in a single `SHASUMS256.txt` (plus a `.asc` GPG signature). Assets are `.zip` (needs `unzip`, vs OpenCode's `.tar.gz`).
- Build stage is `node:24.17.0-alpine` with neither `curl` nor `unzip` — both must be added (then removed in the same layer to keep the build stage lean, or left since it is a discarded stage).
- The Bun release tag format is `bun-v${BUN_VERSION}` (e.g. `bun-v1.3.14`) — no percent-encoding needed (no `+`), unlike the OpenCode harness tag.

### Institutional Learnings

- `docs/solutions/workflow-issues/migrate-pnpm-to-bun-monorepo-2026-06-24.md` — the migration doc; documents why the build needs a full install (frozen-lockfile validates the whole workspace; the build typechecks tests). The trim must preserve that build-stage behavior and only change the runtime copy.
- The workspace image's OpenCode install is the reference implementation for fail-closed verified downloads.

### Verified During Planning

- `bun install --production --frozen-lockfile` resolves the prod-only tree cleanly in this monorepo (vitest/tsdown/eslint excluded; `@aws-sdk`, `discord.js`, `hono`, `@octokit` present; `typescript` present as a legitimate transitive prod dep). Prod-only `node_modules` ≈ 237M vs the larger full tree.
- `--production` triggers the root `postinstall` (`simple-git-hooks`) which fails in a clean stage — so the production-install layer must pass `--ignore-scripts` (the build's full install does not hit this because `simple-git-hooks` is present as a devDep).

## Key Technical Decisions

- **Mirror the OpenCode verified-binary pattern for Bun**, fetching `SHASUMS256.txt` and verifying at build time rather than pinning per-arch SHA256 literals. Rationale: keeps `BUN_VERSION` the single Renovate-tracked source (R4), matches the established in-repo pattern, and the GitHub-release-fetch trust model is the same one already accepted for OpenCode.
- **arch→asset allowlist**: `amd64 → bun-linux-x64-musl-baseline`, `arm64 → bun-linux-aarch64-musl`, anything else aborts. Baseline on x64 so the image runs on any x86 host regardless of builder CPU features (same reasoning as the OpenCode baseline choice).
- **Dedicated production-install layer for the trim.** Add a `bun install --production --frozen-lockfile --ignore-scripts` after the build/typecheck completes (so the full install still satisfies the build), producing a prod-only `node_modules` that the runtime stage copies instead of the full tree. `--ignore-scripts` avoids the `simple-git-hooks` postinstall failure.
- **Install Bun to a fixed path** (e.g. `/usr/local/bin/bun`) and `chmod 755`, mirroring the OpenCode install, so the subsequent `bun install`/`bun run` steps resolve it.

## Open Questions

### Resolved During Planning

- Which Bun asset for Alpine? — `bun-linux-x64-musl-baseline.zip` / `bun-linux-aarch64-musl.zip` (musl, baseline on x64).
- Pin SHA or fetch SHASUMS? — Fetch `SHASUMS256.txt` at build, verify fail-closed (keeps `BUN_VERSION` the single source).
- Does `--production` work in the monorepo? — Yes, with `--ignore-scripts` to skip the root postinstall.

### Deferred to Implementation

- Whether to drop `curl`/`unzip` in the same build-stage layer after the Bun download — build stage is discarded, so cleanup is optional; decide based on whether the Bun download layer is shared with other build steps.
- Whether `typescript` (transitive prod dep) being in the runtime tree is worth further trimming — out of scope; the prod install is the right granularity for this PR.

## Implementation Units

- [ ] **Unit 1: Verified Bun binary install — gateway Dockerfile**

**Goal:** Replace `npm i -g bun@${BUN_VERSION}` in `deploy/gateway.Dockerfile` with a checksum-verified download of the official Bun musl binary.

**Requirements:** R1, R2, R4.

**Dependencies:** None.

**Files:**
- Modify: `deploy/gateway.Dockerfile`

**Approach:** In the build stage, add `apk add --no-cache curl unzip` (curl to fetch, unzip for the `.zip` asset). Replace the `npm i -g bun` step with a `set -euo pipefail` block mirroring `deploy/workspace.Dockerfile` lines 90-126: `ARG TARGETARCH`, arch→asset allowlist (`bun-linux-x64-musl-baseline` / `bun-linux-aarch64-musl`), build the `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}` base URL, `curl --retry 3 --retry-delay 2` the asset `.zip` and `SHASUMS256.txt`, `awk` the expected hash for the asset, compare to `sha256sum` fail-closed (abort on missing entry or mismatch), `unzip` to a temp dir, move the `bun` binary to `/usr/local/bin/bun`, `chmod 755`, clean up, and `bun --version` to confirm. Keep `ARG BUN_VERSION=1.3.14` unchanged (R4).

**Patterns to follow:** `deploy/workspace.Dockerfile` lines 90-126 (the OpenCode verified-download block) — same control flow, adapted for `.zip`/`unzip` and the `bun-v` tag (no percent-encoding needed).

**Test scenarios:**
- Test expectation: none (Dockerfile) — verified by a successful image build and the `bun --version` step reporting `${BUN_VERSION}`, plus the existing Gateway Image Smoke Test.

**Verification:** `docker build -f deploy/gateway.Dockerfile .` succeeds; the Bun step prints the pinned version; a deliberately wrong asset name or corrupted checksum aborts the build (spot-check during implementation).

- [ ] **Unit 2: Verified Bun binary install — workspace Dockerfile**

**Goal:** Same verified-Bun-install change in `deploy/workspace.Dockerfile`.

**Requirements:** R1, R2, R4.

**Dependencies:** None (parallel to Unit 1, different file).

**Files:**
- Modify: `deploy/workspace.Dockerfile`

**Approach:** Identical to Unit 1, applied to the workspace build stage (lines 24-27). The runtime stage already has `curl` (line 70) but the **build** stage does not — add `apk add --no-cache curl unzip` there. The workspace image already contains the reference OpenCode verified-download block to mirror, so keep the two blocks visually consistent.

**Patterns to follow:** The OpenCode block already in this same file (lines 90-126).

**Test scenarios:**
- Test expectation: none (Dockerfile) — verified by a successful image build, the `bun --version` step, and the existing Workspace Image Smoke Test.

**Verification:** `docker build -f deploy/workspace.Dockerfile .` succeeds; Bun version reported; image boots and `/healthz` responds (existing smoke).

- [ ] **Unit 3: Production-only node_modules in runtime stage — both Dockerfiles**

**Goal:** Ship a prod-only `node_modules` (devDependencies excluded) in both runtime images.

**Requirements:** R3.

**Dependencies:** Units 1-2 (Bun must be installed before the prod install runs).

**Files:**
- Modify: `deploy/gateway.Dockerfile`, `deploy/workspace.Dockerfile`

**Approach:** After the package build step completes in the build stage (so the full install still satisfies the typecheck/bundle), add a dedicated production install into a separate directory that the runtime stage copies. Two viable shapes — pick the cleaner during implementation: (a) run `bun install --production --frozen-lockfile --ignore-scripts` into a throwaway prod dir (e.g. copy the manifests + `bun.lock` into `/prod`, install there) and `COPY --from=build /prod/node_modules`; or (b) run the prod install in place after the build and copy the resulting `node_modules`. `--ignore-scripts` is required to skip the root `simple-git-hooks` postinstall (which fails without the devDep present). The runtime `COPY --from=build .../node_modules` lines (gateway line 46, workspace line 139) then reference the prod tree. Confirm the gateway/workspace bundles still resolve their externalized deps (e.g. `@aws-sdk/signature-v4a`) from the prod tree at runtime.

**Patterns to follow:** The existing multi-stage `COPY --from=build` layout in both files.

**Test scenarios:**
- Test expectation: none (Dockerfile) — verified by the existing Gateway/Workspace Image Smoke Tests: the images must build, boot, and pass `/healthz` (workspace) / the gateway missing-secret startup error, proving the runtime process resolves all required deps from the prod-only tree.

**Verification:** Both images build; the runtime `node_modules` excludes `vitest`/`tsdown`/`eslint`; both smoke tests pass (proving no runtime dependency was trimmed away). Spot-check final image size is reduced.

- [ ] **Unit 4: Docs / comment reconciliation**

**Goal:** Update the Dockerfile comments to reflect the verified-Bun install and the prod-trim, and note any deploy-doc references.

**Requirements:** R1, R3.

**Dependencies:** Units 1-3.

**Files:**
- Modify: `deploy/gateway.Dockerfile`, `deploy/workspace.Dockerfile` (comments), `deploy/README.md` (only if it documents the Bun install posture)

**Approach:** Replace the `# Install Bun (matches packageManager: bun@${BUN_VERSION})` comments with a short note that Bun is fetched from the verified GitHub release (mirroring the OpenCode pattern). Add a one-line comment on the prod-install layer explaining why it exists (runtime image excludes devDeps; build stage still needs the full install for the typecheck). Check `deploy/README.md` for any "npm i -g bun" / image-build references and reconcile.

**Test scenarios:**
- Test expectation: none (comments/docs).

**Verification:** Comments accurately describe the new install path; no stale `npm i -g bun` references remain in deploy docs.

## System-Wide Impact

- **Interaction graph:** Both images' build stages change their Bun-acquisition path and add a prod-install layer; the runtime stages change which `node_modules` they receive. No application code changes.
- **API surface parity:** Both Dockerfiles must receive the identical Bun-install treatment (don't harden one and leave the other on `npm i -g`).
- **State lifecycle risks:** A too-aggressive trim could drop a runtime-required dependency, surfacing only at container start. The existing smoke tests (gateway missing-secret startup, workspace `/healthz` + `opencode --version`) are the guard — both must pass.
- **Unchanged invariants:** `BUN_VERSION` stays the single Renovate-tracked source (R4); the OpenCode verified-install block, tsdown bundling config, port model, and entrypoints are untouched.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Wrong Bun asset name for Alpine (glibc instead of musl) → binary won't run | Use the `-musl` variants explicitly; `bun --version` in the same layer fails the build fast if wrong |
| `--production` trims a dep the runtime actually needs (externalized bundle import) | Existing smoke tests boot the real process; a missing dep fails the smoke. Verify `@aws-sdk/signature-v4a` resolves |
| `--production` postinstall failure (`simple-git-hooks`) breaks the build | `--ignore-scripts` on the prod install |
| SHASUMS256.txt format differs from OpenCode's SHA256SUMS (column order) | Verify the awk field mapping against a real `SHASUMS256.txt` during implementation |

## Documentation / Operational Notes

- These are deploy-infra changes (CI builds both images via the Gateway/Workspace Image Smoke Tests). The smoke tests are the merge gate — no separate manual deploy needed to validate.
- `BUN_VERSION` Renovate tracking already exists (added in #1004 follow-up); confirm the new GitHub-release URL doesn't need a separate tracker (it interpolates `BUN_VERSION`).

## Sources & References

- Issue: #1003
- Related: `docs/solutions/workflow-issues/migrate-pnpm-to-bun-monorepo-2026-06-24.md`, #1002 (migration), #1004 (CI hardening)
- Code: `deploy/gateway.Dockerfile`, `deploy/workspace.Dockerfile` (OpenCode verified-install block lines 90-126), `deploy/README.md`
- Bun releases: https://github.com/oven-sh/bun/releases (asset names + `SHASUMS256.txt`)
