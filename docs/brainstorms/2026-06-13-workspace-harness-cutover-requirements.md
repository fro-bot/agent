---
title: "Workspace/gateway cutover to the harness OpenCode binary (C2)"
type: requirements
status: ready-for-planning
date: 2026-06-13
---

# Workspace/gateway cutover to the harness OpenCode binary (C2)

## Problem & Goal

The GitHub Action now runs the patched harness OpenCode build by default (PR #884). The deployed gateway's **workspace executor image** still bakes **stock** OpenCode from `anomalyco/opencode`. C2 completes the harness rollout: the workspace executor (which runs the agent for the `@fro-bot` mention loop) should run the same patched harness binary the action does, so carried upstream patches apply consistently across both surfaces.

The gateway process itself needs no change — it remote-attaches to the workspace OpenCode proxy and bakes no binary.

## Background (verified)

- The workspace image is **Alpine-based** and bakes **musl** OpenCode variants: `opencode-linux-x64-baseline-musl.tar.gz` (amd64, AVX2-independent baseline) and `opencode-linux-arm64-musl.tar.gz` (arm64). Source: `deploy/workspace.Dockerfile:51-65`.
- The harness build (`packages/harness/scripts/build-platform.ts:245`) invokes upstream `build.ts --single`, which builds only the current platform and **skips abi-specific (musl) targets**, defaulting to **glibc** (`FFF_LIBC: "gnu"`). Source: `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/script/build.ts:116-129,190,196`.
- Therefore the harness release publishes **generic glibc** assets (`opencode-linux-x64.tar.gz`, `opencode-linux-arm64.tar.gz`, darwin zips, `SHA256SUMS`) — no `-musl`/`-baseline` variants. Source: `.github/workflows/harness-release.yaml:495-547`.
- A glibc binary **will not run on the workspace's Alpine (musl) base.** So C2 is not a simple repoint — the harness must additionally produce musl/baseline Linux assets.
- The gateway image bakes no OpenCode binary. Source: `deploy/gateway.Dockerfile`.
- The workspace `OPENCODE_VERSION` is Renovate-tracked against `anomalyco/opencode`. Source: `.github/renovate.json5:84-92`.

## Approach (decided)

**Extend the harness release to publish both libc flavors, then repoint the workspace.**

The harness Linux build additionally produces **musl + x64-baseline** variants and publishes them as new release assets, **without disturbing** the existing generic glibc assets the action just cut over to (#884). Each consumer gets the right libc:
- **Action** → glibc `opencode-linux-{x64,arm64}.tar.gz` (runs on the glibc GitHub Actions runner). Unchanged.
- **Workspace** → musl `opencode-linux-x64-baseline-musl.tar.gz` + `opencode-linux-arm64-musl.tar.gz` (runs on Alpine).

## Requirements

- **R1.** The harness release publishes, in addition to the existing generic glibc Linux assets, `opencode-linux-x64-baseline-musl.tar.gz` and `opencode-linux-arm64-musl.tar.gz` built from the same pinned integration commit, with version `--version` reporting `<base>+harness.<sha>`.
- **R2.** The new musl/baseline assets are included in the release `SHA256SUMS`.
- **R3.** `deploy/workspace.Dockerfile` downloads the OpenCode binary from `fro-bot/agent` harness releases (not `anomalyco/opencode`), using the `+harness.<sha>` version (URL-encoding `+` as `%2B`, matching the action's C1 download pattern), keeping the existing musl/baseline asset names.
- **R4.** The workspace download verifies the asset against the release `SHA256SUMS` before use (fail-closed), matching the action's harness-download posture — an upgrade from today's unchecked `curl | tar`.
- **R5.** The workspace `OPENCODE_VERSION` pin stays **independently controllable** (not coupled to the action's self-update). Its Renovate manager retargets to the `fro-bot/agent` harness release channel, and the workspace can be reverted to a prior release without touching the action's harness SHA. This preserves the lag/rollback safety valve the action/workspace split was designed for.
- **R6.** The existing action glibc download path (PR #884) is unchanged.
- **R7.** The gateway image and process are unchanged.
- **R8.** Verification goes beyond `--version`: the `Workspace Image Smoke Test` proves the musl harness binary boots on Alpine AND exercises a real execution path (e.g. launches the binary in the production server mode and verifies one real interaction), because `--version` does not catch libc-loader mismatches, runtime syscall/path issues, or mention-loop regressions.
- **R9.** The release workflow's Linux asset handling — download, existence gate, repackaging, `SHA256SUMS`, and upload — is expanded from the current 4-asset world to include the new musl/baseline assets at every step (the workflow is currently hardcoded around exactly 4 assets).
- **R10.** Workspace download fail-closed semantics are explicit: any download, `SHA256SUMS` fetch, hash mismatch, partial download, or 404 aborts the build/startup with **no fallback** to a cached or pre-existing binary. Smoke coverage includes a hash-mismatch / missing-checksum negative path.

## Scope Boundaries

**In scope:** harness Linux build matrix gains musl + x64-baseline targets; release workflow packages/checksums/publishes the new assets; workspace Dockerfile repoint + checksum verification; workspace version-pin/Renovate update; workspace smoke verification.

**Out of scope / unchanged:** the action glibc path (#884); the gateway (no binary bake); the SDK pin; darwin assets (workspace is Linux-only); the harness npm packages (those wrap the action-facing binary, not the workspace).

## Spike Result (resolved 2026-06-13)

The build contract is now proven against upstream `build.ts` (`.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/script/build.ts:53-135`):

- `allTargets` already includes `linux-x64-baseline-musl` (`arch:x64, abi:musl, avx2:false`), `linux-arm64-musl` (`arch:arm64, abi:musl`), and `linux-x64-musl` — the matrix entries exist.
- **`--single` CANNOT emit musl.** Lines 116-135: `--single` filters to the current platform/arch, includes baseline only if `--baseline` is passed, and **unconditionally skips `abi:"musl"`** (lines 129-131) with no flag to include it. Without `--single`, `build.ts` builds the **entire 12-target matrix** (all OS/arch/abi/baseline combos).
- The harness build matrix (`.github/workflows/harness-release.yaml:213-228`) is **per-platform**: `linux/x64`→ubuntu-24.04, `linux/arm64`→ubuntu-24.04-arm, darwin→macOS. Each runs `build-platform.ts --platform X --arch Y` → `build.ts --single`.

**Implication for planning (build-invocation fork, real tradeoff):** to emit the workspace's musl/baseline Linux assets, the harness Linux build cannot keep using bare `--single`. Options for planning to choose:
1. **Extend `build-platform.ts` + matrix with explicit variant selection** (`--abi musl`, `--baseline`) and invoke `build.ts` so it produces exactly that one target. Requires `build.ts` to honor explicit single-target selection — which it does NOT today (`--single` is hard-coded to current-platform-glibc). This likely needs a **harness carry patch** to `build.ts` adding an explicit-target mode, or driving the non-`--single` path filtered to one target.
2. **Run the non-`--single` full matrix on the Linux runners** and package only the wanted Linux musl assets — simpler invocation, but builds extra unused targets (cost: measure the CI wall-clock delta; the "incremental compile" claim remains unmeasured).
The matrix would also grow new Linux entries (x64-glibc kept for the action; x64-baseline-musl + arm64-musl added for the workspace). Planning must pick the invocation strategy and measure CI cost via a dry-run before locking build units.

## Key Technical Decisions

- **Both libc flavors published — framed as a compatibility constraint, not a goal.** The workspace cutover only *needs* musl/baseline assets; the existing generic glibc assets are kept **solely** to avoid breaking the action path PR #884 just shipped. This is a deliberate compatibility hedge, not core scope; if the action path were ever migrated to musl, the glibc assets could drop.
- **x64-baseline retained for the workspace.** Matches OpenCode's own image and keeps the image runnable on any x86 host regardless of the build runner's CPU features.
- **Per-platform native build retained.** The harness build runs per-platform on native runners; the cleanest way to add musl is to have the Linux runners additionally build the musl/baseline targets (upstream `build.ts` already encodes `abi:"musl"` and `baseline` targets) rather than dropping `--single` and cross-building the whole matrix on one runner.

## Open Questions

### Resolved During Brainstorm

- Is C2 a simple repoint? — No; the harness must produce musl/baseline assets first (verified glibc-only today).
- Does the gateway need a binary change? — No (no bake; remote-attach).
- musl-only or both libc flavors? — Both, as a compatibility constraint to avoid disturbing the action (#884).
- Workspace pin coupling? — Independent (R5); preserves the rollback safety valve.

### Resolved — Cutover Value Confirmed

- **Is the workspace cutover valuable, or parity-for-parity's-sake? → VALUE (verified 2026-06-13).** All three carried harness patches affect the workspace mention-loop execution path (3/3 affect workspace, 0/3 action-only):
  - **#19961 (session-transform ordering)** touches `session/prompt.ts`, `compaction.ts`, `llm.ts`, `llm/request.ts` — all on the `session.promptAsync` path the gateway drives on every mention-loop turn (`packages/gateway/src/execute/run-core.ts:243-300`).
  - **#31859 (plugin runtime)** touches `plugin/index.ts` startup loading; the workspace bakes `@fro.bot/systematic` as a plugin (`deploy/workspace.Dockerfile:67-75`), so it exercises this runtime.
  - **#31638 (compaction hydration)** touches `message-v2.ts` model conversion, hitting long-running workspace mention-loop sessions.
  The workspace runs the same core session/plugin/compaction code these patches fix, so the cutover buys real behavior fixes, not aesthetic consistency. C2 is justified.

### Security / Threat Model

- Moving the workspace binary source from upstream `anomalyco/opencode` to our **self-built** `fro-bot/agent` harness release shifts the trust boundary onto our LLM-merge build/publish pipeline. `SHA256SUMS` (same-release) proves integrity-in-transit, **not** provenance. Blast radius is bounded by the workspace `sandbox-net` + mitmproxy egress containment, but planning should note the trust-boundary shift explicitly. Input validation (allowlisted version/asset names, no shell interpolation, extracted-path containment) applies to the new download path.

### Deferred to Planning

- **How exactly to parameterize the harness Linux build** to emit musl + x64-baseline alongside (or instead of) the generic glibc output on the Linux runners: does `build.ts --single` accept libc/baseline selection, or does the harness build need explicit per-target invocations? Requires reading upstream `build.ts` target logic and the harness build matrix in `harness-release.yaml`. Confirm CI build time/cost of the extra Linux targets.
- **Workspace version-pin story:** the action's self-update PR (#884) bumps only `DEFAULT_OPENCODE_VERSION`. Should the same self-update extend to bump the workspace `ARG OPENCODE_VERSION`, or does the workspace stay on its own Renovate/manual pin? (The workspace deliberately lagged the action during the 1.15.13/1.17.3 cutovers — coupling them removes that safety valve.)
- **Asset naming consistency** between upstream's emitted names and what the harness packaging/release step attaches (the harness currently renames to generic `opencode-<os>-<arch>`; musl/baseline assets must carry the suffixes the workspace expects).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| musl/baseline build fails or is mis-targeted on CI | Dry-run the harness release; verify `--version` + `file`/`ldd` libc on each new asset before publish |
| Workspace gets a glibc binary by mistake (won't boot on Alpine) | Smoke test (R8) catches it; checksum + explicit musl asset name |
| Coupling workspace pin to action self-update removes the lag safety valve | Decide in planning; default to keeping the workspace pin independent |
| Extra Linux build targets increase release CI time/cost | Measure in the dry-run; baseline+musl are incremental compiles on existing runners |

## Sources & References

- Memory 5392 (C2 gap analysis, verified).
- `deploy/workspace.Dockerfile:41-65`, `deploy/gateway.Dockerfile`.
- `packages/harness/scripts/build-platform.ts:219-320`.
- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/script/build.ts:116-240`.
- `.github/workflows/harness-release.yaml` (Release Binaries / publish jobs).
- `.github/renovate.json5:84-92`.
- PR #884 (action harness cutover, C1 download/checksum pattern).
