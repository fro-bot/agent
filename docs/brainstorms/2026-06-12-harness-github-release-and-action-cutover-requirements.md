---
title: Harness GitHub Release + action cutover (C1)
status: ready-for-planning
created: 2026-06-12
scope: deep
---

# Harness GitHub Release + action cutover (C1)

## Problem

The Fro Bot action and gateway run **stock** OpenCode downloaded from `anomalyco/opencode` GitHub Releases. The patched `@fro.bot/harness` build (base `1.17.3` + carried upstream refs) is published **only to npm** (main + 4 platform packages via OIDC trusted publishing); no GitHub Release is created. So the action/gateway cannot consume the patched binary the way they already consume stock OpenCode — by downloading a release tarball.

We want the action and gateway to run the **harness** build, distributed through a channel they already know how to consume, without losing the local `bunx @fro.bot/harness` / `mise npm:@fro.bot/harness` ergonomics.

## Scope split

This is **C1**. The workspace executor image (Alpine, needs musl) is **C2 (deferred)** because the harness build does not yet produce musl/baseline Linux assets.

- **C1 (this doc):** harness GitHub Release with generic glibc assets + **action-only** cutover.
- **C2 (deferred):** add musl/baseline Linux target builds to the harness matrix, then cut the **workspace** over (which is also how the gateway gets the harness — see below).

### The gateway is NOT a C1 consumer (resolved Q3)
The gateway reaches OpenCode in production purely by **remote-attach** to the workspace proxy (`packages/gateway/src/execute/opencode-attach.ts` → `http://workspace:9200`). It does **not** download or run its own OpenCode binary for the mention loop. (The gateway's bundled `dist` contains `installOpenCode`/`anomalyco/opencode` only because it bundles `@fro-bot/runtime`; that path is never invoked in the gateway runtime.) Therefore the gateway inherits the harness binary **from the workspace** — it cuts over automatically when C2 lands the workspace musl cutover. **C1 requires no gateway change.**

The split is clean: only the **action** downloads a generic glibc linux/darwin binary in C1 (which the current `--single` build already produces); the **workspace** needs musl (C2); the **gateway** rides the workspace.

## Decisions (settled)

### D1 — Dual distribution channels
The harness publishes to **both**:
- **GitHub Release** (new) — OpenCode-shaped binary assets the action/gateway download exactly like stock OpenCode today.
- **npm** (unchanged) — for local `bunx`/`mise` dogfooding.

### D2 — Versioning (npm prerelease + GitHub build-metadata)
The npm version and the GitHub Release tag encode the same identity in two different forms, forced by npm's SemVer handling (verified: npm strips build metadata on publish — npm/cli #1479, npm #6379 — so `1.17.3+harness.<sha>` collapses to bare `1.17.3` in the registry, is not distinctly installable, and a second integration commit collides as a duplicate).

- **GitHub Release tag** = `v1.17.3+harness.<short8>` (build metadata; `+` is valid in git refs and release-download URL path segments; matches the binary's internal `--version`).
- **npm version** = `1.17.3-harness.<short8>` (**prerelease** — distinct, installable, republishable per integration commit, `latest`-taggable).

The current publish flow sets bare `1.17.3`, which is **wrong** — indistinguishable from stock OpenCode `1.17.3`. The fix:
- compute `<base>-harness.<short8>` from the existing `BASE_VERSION` + `INTEGRATION_COMMIT` the publish job already resolves;
- apply the **identical** prerelease string to all 5 packages (main + 4 platform packages — `optionalDependencies` exact-match requirement);
- **explicitly set the `latest` dist-tag** to the prerelease (prereleases are excluded from default range/`latest` resolution otherwise).

The `-`/`+` asymmetry is deliberate and forced by npm constraints, not preference.

### D3 — Asset shape (generic glibc only in C1)
The release reproduces the exact stock asset names the action consumer expects:
- `opencode-linux-x64.tar.gz`, `opencode-linux-arm64.tar.gz`
- `opencode-darwin-x64.zip`, `opencode-darwin-arm64.zip`

Each archive contains `opencode` at archive root (matching upstream), repackaged from the existing per-platform build artifacts (`harness-binary-{platform}-{arch}`). **musl/baseline variants are out of scope for C1.**

### D4 — Consumer source swap (not just asset names)
Consumers currently hardcode `anomalyco/opencode`:
- `src/services/setup/opencode.ts:9` (`DOWNLOAD_BASE_URL`)
- `src/services/setup/opencode.ts:161` (`getLatestVersion()` API call)

The action must download the harness binary from `fro-bot/agent` releases at tag `v1.17.3+harness.<short8>`. `DEFAULT_OPENCODE_VERSION` (`packages/runtime/src/shared/constants.ts`) becomes the full harness version. **`getLatestVersion()` rule (resolves Q1):** bypass the stock `anomalyco/opencode/releases/latest` probe entirely for harness pins — never silently resolve a stock "latest" when the active version is a harness build (`opencode.ts:161` always queries the stock latest today, a real misroute bug the cutover must fix).

**Edit surface (resolves Q2):** the shared constant `DEFAULT_OPENCODE_VERSION` lives in `packages/runtime/src/shared/constants.ts` and is the single version source of truth consumed by the action's setup path. C1 edits that constant + the download-source logic in `opencode.ts` (both action-tier `src/features/agent` and runtime-tier consume the same constant; no separate pin). This is still "action-only" in the sense that no gateway/workspace runtime behavior changes — the runtime *package* is where the shared constant happens to live.

### D5 — Consumer bump is MANUAL in C1 (automation deferred)
Document-review (5/6 reviewers) found release-side consumer-bump automation is over-built for C1's single consumer, and feasibility proved it is **not implementable** from the release workflow as written (it has `contents: read` / `id-token: write` only — no `pull-requests: write`, no PR-capable token). For C1's one consumer (the action), a **manual one-line pin bump** is correct. Automation is deferred to C2, where a second consumer (the workspace) and a PR-capable credential justify it. No moving `latest` tag for production consumers (reproducibility).

### D9 — Stock fallback preserved (safety)
The action's installer falls back to `FALLBACK_VERSION = DEFAULT_OPENCODE_VERSION` on download failure. If `DEFAULT_OPENCODE_VERSION` becomes the harness version, a missing/broken harness release would leave **no escape hatch** — every production run fails. C1 must preserve an explicit **stock `anomalyco/opencode` fallback**: on harness download/verify failure, attempt the stock binary before hard-failing.

### D10 — Download integrity verification (safety/supply-chain)
The release-binaries job repackages artifacts from the **untrusted** build job (runs the LLM-merged upstream build). C1 must verify integrity end-to-end: the release job validates each asset's digest against the existing harness `provenance.json` (`buildSha`/`integrationCommit`) before publishing, and the action verifies the downloaded binary against a published checksum before execution. (Preserve/parity any integrity check the stock path has today.)

### D11 — All-or-nothing release gate (safety)
The harness GitHub Release must be created only after **all four** expected platform assets are present and verified. A partial (3/4) release must fail the workflow, not publish a release that installs fine on three platforms and fails on the fourth at runtime.

### D6 — Remove the redundant `npm-publish` environment — gated
`environment: npm-publish` on the publish job adds a GitHub deployment record + approval gate but contributes nothing the OIDC publish needs (tokenless; no env-scoped secrets — verified). Remove it **only after verifying** the npmjs.com trusted-publisher config for all 5 packages is **not bound** to the environment name `npm-publish`; if it is, removing the workflow environment breaks OIDC publishing. Keep `id-token: write`.

### D7 — Release job permission isolation
The release-binaries step needs `contents: write`. It must **not** live in the untrusted `build` job (which runs the LLM-merged upstream build and is deliberately read-only / no `id-token`). Structure:
- `build` — `contents: read`, no `id-token` (unchanged).
- `release-binaries` (new) — `needs: build`, `contents: write`, **no** `id-token`; downloads artifacts, repackages OpenCode-shaped assets, creates the GitHub Release.
- `publish-npm` — `needs: build`, `id-token: write`, `contents: read`.

### D8 — Windows
Harness-backed OpenCode is **linux/darwin only**. Document explicitly; the action's Windows download path remains stock-only / unsupported for harness.

## Requirements

- **R1** Harness-release workflow creates a GitHub Release tagged `v<base>+harness.<short8>` with generic glibc assets (`opencode-{linux-x64,linux-arm64}.tar.gz`, `opencode-{darwin-x64,darwin-arm64}.zip`), repackaged from build artifacts, archive root = `opencode`.
- **R2** New `release-binaries` job: `needs: build`, `contents: write`, no `id-token`; isolated from build and npm publish.
- **R3** Action (`opencode.ts`) downloads from `fro-bot/agent` harness releases; `DOWNLOAD_BASE_URL` + version handling point at the harness release; `getLatestVersion()` bypasses stock-latest for harness pins (D4 / Q1).
- **R4** `DEFAULT_OPENCODE_VERSION` becomes `1.17.3+harness.<short8>` (single shared constant; D4 / Q2). The gateway needs no change in C1 (remote-attach; rides the workspace in C2).
- **R5** npm version becomes the prerelease `<base>-harness.<short8>` across all 5 packages with the `latest` dist-tag explicitly set to it (D2). Replaces the wrong bare `1.17.3`.
- **R6** Pre-removal verification gate for the npm trusted-publisher environment binding; remove `environment: npm-publish` only if safe, else keep + document.
- **R7** Workspace Dockerfile is **untouched** in C1 — stays on stock `anomalyco/opencode` musl assets until C2.
- **R8** Stock `anomalyco/opencode` fallback preserved (D9): harness download/verify failure attempts the stock binary before hard-failing.
- **R9** Download integrity verification (D10): release job validates assets against `provenance.json`; action verifies the downloaded binary against a published checksum before execution.
- **R10** All-or-nothing release gate (D11): release fails unless all four platform assets are present and verified.
- **R11** Windows posture documented as unsupported for harness.

## C2 exit criteria (so the split doesn't stall)
C2 is committed, not open-ended. C2 lands when: (a) the harness matrix builds the musl/baseline Linux targets (`opencode-linux-x64-baseline-musl.tar.gz`, `opencode-linux-arm64-musl.tar.gz`); and (b) `deploy/workspace.Dockerfile` is cut over to download those from the harness release. Completing C2 also automatically moves the gateway onto the harness (it remote-attaches to the workspace). Until C2, production runs a **mixed fleet**: action on harness, workspace+gateway on stock — an accepted, documented interim state, not the end state. Consumer-bump automation (deferred D5) is built in C2 when the workspace becomes the second consumer.

## Out of scope (C2 / later)
- musl/baseline Linux target builds in the harness matrix.
- Workspace executor + gateway cutover to harness.
- Consumer-bump PR automation (needs `pull-requests: write` + a second consumer).
- Windows harness builds.

## Open questions for planning
- Q1 — **RESOLVED** (D4): bypass stock-latest for harness pins.
- Q2 — **RESOLVED** (D4): single shared `DEFAULT_OPENCODE_VERSION` constant; action + download logic only.
- Q3 — **RESOLVED:** gateway uses remote-attach; C1 is action-only, gateway rides the workspace in C2.

## Risks
- Removing `environment: npm-publish` without verifying npm-side binding breaks publishing (R6 gate).
- A harness release lacking musl assets must not be consumed by the workspace (R7).
- `+` in the GitHub tag/URL: start with `v<base>+harness.<sha>`; fallback to `%2B` encoding or `-harness.<sha>` tag form if tooling chokes. Validate the tag→release→download path end-to-end before locking.
- Same-base re-integration: a new integration commit off base `1.17.3` gets a new npm prerelease + new GitHub tag cleanly; the bare-`1.17.3` collision that motivated D2 is removed.
