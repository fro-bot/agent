---
title: "feat: Harness integrate→build bridge via CI artifact handoff"
type: feat
status: completed
date: 2026-06-05
---

# feat: Harness integrate→build bridge via CI artifact handoff

## Overview

`@fro.bot/harness` ships a native binary (`harness`) that is OpenCode pinned to a stable version plus a small set of LLM-merged upstream patches. Two halves of that pipeline exist but are not connected:

- `packages/harness/src/integrate.ts` (`runIntegration`) clones OpenCode at the base-version tag, fetches the configured patch refs, runs an `opencode run` LLM merge to reason them onto the stable tag, builds, verifies, captures the frozen integration commit SHA, and writes `provenance.json` to its work dir. It has **no runnable entry point** and **never persists the merged tree anywhere** beyond its disposable work dir.
- `packages/harness/scripts/build-platform.ts` (per-platform native build, run by the `build` matrix in `.github/workflows/harness-release.yaml`) clones `anomalyco/opencode` at an `--integration-commit` and compiles. The LLM-merged commit does not exist on upstream, so the build matrix cannot find it.

This plan connects them with a **CI artifact handoff (Option B)**: a new producer `integrate` job runs the LLM merge once, packages a **clean merged source snapshot** (extracted from the integration commit via `git archive` or equivalent clean checkout) plus the provenance manifest as a workflow artifact, and the `build` matrix downloads + extracts that artifact instead of cloning upstream. Each build-matrix job runs its own clean install + build from that merged source tree (the upstream-matched root install + build sequence from PR #772 still runs per-platform). No mirror repo, no cross-repo push, no write-scoped git token — the integrate job stays read-only against upstream and produces an artifact, not a pushed commit.

The integrate job's own build+verify (Steps 6–7 inside `runIntegration`) is a **pre-flight correctness gate** proving the merge compiles on one platform; its build outputs are discarded, not shipped. The artifact is the clean merged source, not the post-build working tree.

## Problem Frame

A real (patched) harness release is currently impossible to run end-to-end: the integrate engine produces a commit on a throwaway clone that the build matrix cannot reach. The dry-run only passed because it was fed a commit that already exists on upstream (the bare 1.15.13 tag, no patches). The first patched publish is blocked on bridging integrate → build. Option B was chosen over a mirror repo (A) and a single mega-job (C) because it is the simplest path that preserves the producer/build privilege split and needs no new repo or push credentials; the provenance manifest already records integration inputs, so losing durable git history of integrations is acceptable.

## Requirements Trace

- R1. A runnable entry point exists for `runIntegration` (a `harness integrate` CLI subcommand), wired through `cli.ts`, with config sourced from flags/env/`harness.config.json`.
- R2. The integrate job packages a **clean merged source snapshot** (extracted from the integration commit, e.g. via `git archive <integration_commit>`) plus `provenance.json` into a single uploadable artifact. The artifact excludes `.git` and any build products from the integrate runner's pre-flight build.
- R3. `build-platform.ts` gains an artifact-extract path that replaces `cloneAndCheckout` when an extracted merged source tree is supplied, building from the merged source at the frozen commit.
- R4. `harness-release.yaml` gains an `integrate` producer job that runs before `build`, produces the artifact + outputs the integration commit SHA, and the `build`/`publish`/`verify` matrix consumes the artifact + SHA.
- R5. The integrate job is read-only against upstream (no push, no write token); the LLM merge runs with OpenCode auth provisioned the same way the workspace executor / action provision it (file-based secret, never logged).
- R6. `dry_run` continues to work end-to-end (integrate + build + assemble, skip publish), and a non-patched run (no integration refs) still produces a valid artifact.
- R7. The fail-hard contract is preserved: any integrate failure produces no artifact and fails the job; the build matrix never runs against a partial/missing tree.
- R8. The build matrix verifies the downloaded artifact matches the declared integration commit / digest before compiling (no silent build of a stale or wrong tree). Because the artifact is produced via `git archive <integration_commit>`, it is inherently SHA-bound; the digest check makes this explicit and fail-closed.
- R9. Merged refs come only from the `harness.config.json` carry-policy allowlist (no arbitrary ref input at dispatch); the release is maintainer-gated manual `workflow_dispatch`; the provenance manifest records the exact upstream inputs (base tag + each ref + resolved SHA) and is included in the artifact for audit before publish.

## Scope Boundaries

- Not building a `fro-bot/opencode` mirror repo or any cross-repo git push (explicitly rejected in favor of B).
- Not changing the carry policy or which patch refs are carried (config-driven; `harness.config.json` already holds the ref set).
- Not changing trusted publishing / OIDC (already shipped and proven).
- Not changing the native-build internals (Bun pin, root install, upstream-matched build invocation) — those landed in PR #772.

### Deferred to Separate Tasks

- First actual patched release carrying PR #30182 onto 1.15.13: separate operator-driven dispatch after this bridge merges.
- Per-ref SHA resolution in the provenance manifest (currently all refs share the integration commit): future iteration, noted in `integrate.ts`.

## Context & Research

### Relevant Code and Patterns

- `packages/harness/src/cli.ts:147-167` — subcommand dispatch (`info`/`patches`/`doctor` via `if` chain, then `cmdPassthrough`). New `integrate` branch mirrors this; `cmdDoctor` (returns `number`, never throws) is the error-handling precedent. `main()` must `await` an async `cmdIntegrate`.
- `packages/harness/src/integrate.ts:44-53` — `IntegrationConfig` fields the CLI must supply: `baseVersion`, `releaseRepo`, `integrationRefs`, `agent`, `model`, `opencodeBin`, `workDir`, `promptPath`. `:264-368` `runIntegration` returns `{ok, manifest}`, writes `provenance.json` to `workDir`, does NOT push. `:176-240` `makeRealAdapters`.
- `packages/harness/harness.config.json:2-8` — source of `baseVersion`/`releaseRepo`/`integrationRefs`/`agent`/`model`/`opencodeBin`. `promptPath` + `workDir` are CLI/runtime-owned.
- `packages/harness/scripts/build-platform.ts:175` `cloneAndCheckout(repoUrl, workDir, commit)` — the exact seam Option B replaces with an extract-or-reuse path; `:96-97` `--repo-url`/`--work-dir` flag defaults.
- `.github/workflows/harness-release.yaml:41-61` build matrix, `:90-148` params→`build-platform` arg flow, `:175-188` publish job (`needs: build`, `id-token: write`), `:399-402` dry-run assemble path.
- `apps/workspace-agent` OpenCode auth provisioning (file-based secret, 0600, never logged) — the pattern for giving the integrate job model credentials.

### Institutional Learnings

- `docs/solutions/workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md` — make the workflow contract explicit and surface resolved values as job outputs rather than letting the model choose delivery shape. Applies to the integrate job emitting the integration commit SHA as a declared output.
- `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md` + `workspace-executor-opencode-provisioning-best-practices-2026-06-01.md` — non-interactive `opencode run`, file-based auth, never log token/body. Applies to R5.
- `docs/solutions/performance-issues/tool-binary-caching-ephemeral-runners.md` — producer-does-setup-once, consumers-reuse mindset; informs the integrate→matrix artifact handoff contract.

## Key Technical Decisions

- **Artifact handoff over mirror push (Option B):** producer job uploads merged source tree + `provenance.json`; build matrix downloads + extracts. Simplest correct bridge; no new repo, no push token, smaller security surface.
- **Artifact contents = a clean merged source snapshot extracted from the integration commit (e.g. `git archive <integration_commit>`), NOT the post-build working tree.** The integrate job's own build+verify (Steps 6–7 inside `runIntegration`) is a pre-flight correctness gate on one platform; its build outputs are discarded. Packaging the post-build working tree would poison all four cross-platform builds with platform-specific native deps and `node_modules`. The clean merged source tree excludes `.git` (keeping the artifact small) and carries `provenance.json`. The integration commit SHA travels as a job output + inside the manifest, not via git history.
- **`build-platform.ts` gains an artifact-aware path, not a removal of clone.** When the workflow supplies an extracted merged source tree, `cloneAndCheckout` is bypassed; the existing clone path stays for local/standalone runs. Selection via a new **`--source-tree <dir>` flag** — this is the resolved decision (see below).
- **`--source-tree <dir>` is an explicit new flag, not `--work-dir` reuse.** Using a dedicated flag makes the build-from-supplied-source intent unambiguous and fail-closed when the directory is missing, and keeps the standalone clone path untouched. The `--work-dir` reuse branch in `build-platform.ts:176-181` is left unchanged.
- **Artifact integrity: SHA-bound by construction + explicit digest check.** Because the artifact is produced via `git archive <integration_commit>`, it is inherently bound to that commit. The build matrix additionally verifies the downloaded artifact's digest against the declared digest before compiling (R8), making the check explicit and fail-closed.
- **Supply-chain gating as hard controls (R9):** (a) merged refs come only from the `harness.config.json` carry-policy allowlist — no arbitrary ref input at dispatch; (b) the release is maintainer-gated manual `workflow_dispatch`; (c) the provenance manifest records the exact upstream inputs (base tag + each ref + resolved SHA) and is included in the artifact for audit before publish.
- **Integrate job is read-only + auth-scoped:** `contents: read`, no `id-token`, OpenCode model auth from a secret file (mirroring workspace executor), token/body never logged.
- **Fail-hard preserved:** integrate writes the artifact only on `{ok:true}`; `build` `needs: integrate`, so a failed merge produces no artifact and the matrix never starts.
- **CLI config sourcing:** `integrate` reads `harness.config.json` for the ref set/agent/model/base-version, takes `--work-dir`/`--prompt-path`/`--out` as flags, and `opencodeBin` defaults to `opencode` on PATH (the harness/stock binary). No secrets in flags.

## Open Questions

### Resolved During Planning

- How does the commit reach the build jobs? → CI artifact (B), not git push.
- Does the artifact need `.git`? → No (verified): upstream `build.ts` reads `OPENCODE_VERSION` from env and bakes it via a compile-time define; it does NOT shell out to git. And `build-platform.ts` derives the `+harness.<short8>` version purely from the `--integration-commit` arg via `buildHarnessVersion` (`src/version.ts`), not `git rev-parse`. So a clean `git archive` source (no `.git`) builds and versions correctly.
- Where does model auth come from in the integrate job? → File-based secret, workspace-executor pattern, never logged.
- Should `--source-tree` be a new flag or `--work-dir` reuse? → Resolved: explicit `--source-tree <dir>` flag. Makes the build-from-supplied-source intent unambiguous and fail-closed when the dir is missing; keeps the standalone clone path untouched.

### Deferred to Implementation

- Exact artifact packaging mechanism (tar vs `actions/upload-artifact` directory upload) and whether `build-platform.ts` consumes an extracted dir or a tarball — decided against the real `cloneAndCheckout`/arg shape during Unit 2/3.
- Artifact size/retention tuning — observed empirically on the first real dispatch.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
harness-release.yaml (workflow_dispatch)
  job: integrate            [contents: read, no id-token, opencode-auth secret file]
    harness integrate --work-dir W --prompt-path P --out ARTIFACT
      └─ runIntegration(): clone upstream@tag → fetch refs → LLM merge → build (pre-flight gate) → verify
                           → capture integrationCommit → write provenance.json
                           → discard build outputs; extract clean merged source tree via git archive
      └─ package merged source tree (no .git, no build products) + provenance.json → upload-artifact "integration-tree"
      └─ output: integration_commit=<sha>, artifact_digest=<digest>
        │
        ▼ needs: integrate   (matrix consumes artifact + sha + digest)
  job: build (matrix linux/darwin × x64/arm64)   [contents: read]
    download-artifact "integration-tree" → verify digest → extract into source dir
    build-platform.ts --source-tree <extracted> --integration-commit <sha> ...
      └─ (bypasses cloneAndCheckout; runs own clean install + build from merged source tree) → per-platform binary
        │
        ▼ needs: build
  job: publish    [id-token: write]   (skipped when dry_run)
```

Fail-hard: integrate `{ok:false}` → no artifact + job fails → `build` never starts.

## Implementation Units

- [x] **Unit 1: `harness integrate` CLI subcommand (runnable entry point)**

**Goal:** Give `runIntegration` a runnable entry point so CI (and a maintainer locally) can drive the merge.

**Requirements:** R1, R5

**Dependencies:** None

**Files:**
- Modify: `packages/harness/src/cli.ts`
- Create: `packages/harness/src/integrate-command.ts` (assembles `IntegrationConfig` from `harness.config.json` + flags, calls `runIntegration(config, makeRealAdapters())`, maps result→exit code)
- Modify: `packages/harness/src/cli.test.ts`
- Create: `packages/harness/src/integrate-command.test.ts`

**Approach:**
- Add an `integrate` branch in the `cli.ts` dispatch chain (before passthrough), mirroring the `doctor` pattern but async; `main()` awaits it.
- `integrate-command.ts` reads `harness.config.json` (baseVersion/releaseRepo/integrationRefs/agent/model/opencodeBin), takes `--work-dir`, `--prompt-path`, `--out` flags, defaults `opencodeBin` to `opencode`. No secrets in flags.
- Map `{ok:true}`→0, `{ok:false}`→1 with a one-line error (no token/body in output).
- Add `integrate` to usage text and update the reserved-set assertion in `cli.test.ts`.

**Patterns to follow:** `cli.ts:159-162` (`cmdDoctor` exit-code return), `integrate.ts:176` `makeRealAdapters`.

**Test scenarios:**
- Happy path: valid config + flags → `runIntegration` invoked with the assembled `IntegrationConfig`, exit 0 on `{ok:true}` (adapters stubbed).
- Error path: `{ok:false}` from `runIntegration` → exit 1, error line printed, no stack/secret leakage.
- Edge case: missing required flag (`--work-dir`) → usage error, exit non-zero.
- Config sourcing: integration refs/agent/model read from `harness.config.json` (not hardcoded).
- Reserved-set test in `cli.test.ts` updated to include `integrate`.

**Verification:** `harness integrate --help` documents the command; unit tests prove config assembly + exit-code mapping with stubbed adapters; no real merge runs in tests.

- [x] **Unit 2: Artifact packaging (clean merged source snapshot + provenance)**

**Goal:** After a successful integrate, extract a clean merged source snapshot from the integration commit and package it with `provenance.json` into a single artifact-ready output. The artifact must not contain build products or `.git`.

**Requirements:** R2, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/harness/src/integrate-command.ts` (add `--out`-driven packaging step after `{ok:true}`)
- Modify: `packages/harness/src/integrate-command.test.ts`

**Approach:**
- On `{ok:true}` only, extract a clean merged source tree from the integration commit (e.g. `git archive <integrationCommit>`) into a staging path, add `provenance.json`, then **atomically finalize** — write the archive to a temp path first, move/rename to the `--out` path only after the archive completes successfully. A mid-step failure must leave no usable artifact at the `--out` path.
- On `{ok:false}`, produce nothing (fail-hard; the artifact's absence is the signal).
- The integration commit SHA is emitted to stdout/`GITHUB_OUTPUT` in Unit 4; here just ensure the manifest (which contains it) is included.

**Patterns to follow:** existing fs/spawn helpers in `integrate.ts`/`build-platform.ts`; `provenance.json` filename from `integrate.ts:90-99`.

**Test scenarios:**
- Happy path: `{ok:true}` → artifact contains merged source tree + `provenance.json`, excludes `.git`, excludes build products.
- Error path: `{ok:false}` → no artifact written.
- Edge case: `--out` path parent missing → created or clean error.
- Edge case: packaging fails mid-step (e.g. archive write interrupted) → no partial artifact left at the `--out` path (atomic staging verified).
- Integration: `provenance.json` in the artifact carries the same `integrationCommit` the command reports.

**Verification:** packaging only fires on success; artifact contents verified in tests; `.git` and build products excluded; partial/failed packaging leaves no usable artifact.

- [x] **Unit 3: `build-platform.ts` artifact-extract source path**

**Goal:** Let the build matrix build from an extracted merged source tree instead of cloning upstream.

**Requirements:** R3, R6

**Dependencies:** Unit 2 (artifact shape known)

**Files:**
- Modify: `packages/harness/scripts/build-platform.ts`
- Modify: `packages/harness/scripts/build-platform.test.ts`

**Approach:**
- Add a source-tree mode via the new `--source-tree <dir>` flag: when supplied, skip `cloneAndCheckout` and build the supplied merged source tree at `--integration-commit`. Each build-matrix job runs its own clean install + build from the extracted merged source tree (the upstream-matched root install + build sequence from PR #772 runs per-platform as before).
- Preserve the existing clone path for standalone/local runs (no behavior change when `--source-tree` absent).
- Keep `--integration-commit` required (used for the `+harness.<short8>` version string via `buildHarnessVersion` in `src/version.ts`, regardless of source — version derivation is pure-from-arg, never shells to git).

**Patterns to follow:** `build-platform.ts:77-107` `parseArgs`, `:175-184` `cloneAndCheckout`.

**Test scenarios:**
- Happy path: `--source-tree` supplied → `cloneAndCheckout` bypassed, build runs against the supplied dir.
- Backward-compat: no `--source-tree` → existing clone path unchanged.
- Edge case: `--source-tree` dir missing/empty → clean fail (no silent fallback to clone).
- Arg parsing: `--source-tree` parsed; `--integration-commit` still required.
- Edge case: source-tree mode with NO `.git` present still produces the correct `+harness.<short8>` version (proves version derivation is pure-from-arg via `buildHarnessVersion`, never shells to git).

**Verification:** both source modes covered by tests; absent `--source-tree` is byte-identical to current behavior; version correctness without `.git` verified.

- [x] **Unit 4: `harness-release.yaml` integrate producer job + matrix consumption**

**Goal:** Add the producer `integrate` job and rewire the matrix to consume its artifact + SHA.

**Requirements:** R4, R5, R6, R7, R8, R9

**Dependencies:** Units 1-3

**Files:**
- Modify: `.github/workflows/harness-release.yaml`

**Approach:**
- New `integrate` job (runs first, `contents: read`, no `id-token`): checkout, setup Bun/pnpm, provision OpenCode model auth from a secret file (workspace-executor pattern, never logged), run `harness integrate --work-dir … --prompt-path … --out integration-tree.tar`, `actions/upload-artifact` the tree, and emit `integration_commit` and `artifact_digest` as job outputs (read from `provenance.json` / computed from the archive).
- `build` matrix gains `needs: integrate`, `actions/download-artifact` + **verify artifact digest** before extracting (R8), then passes `--source-tree <extracted>` and `--integration-commit ${{ needs.integrate.outputs.integration_commit }}` to `build-platform.ts` (replacing the hardcoded `--repo-url anomalyco/opencode`).
- Merged refs come only from the `harness.config.json` carry-policy allowlist — no arbitrary ref input at dispatch (R9).
- `verify-binary`/`publish` consume the same SHA output.
- `dry_run` path: integrate + build + assemble run; publish still gated off.
- Fail-hard: `build needs: integrate` so a failed merge stops the matrix.
- Add the OpenCode-auth secret to the documented required secrets (runbook in Unit 5).

**Patterns to follow:** params-step→output pattern (`harness-release.yaml:90-131`); workspace-executor auth provisioning; `actions/upload-artifact`/`download-artifact` conventions already used elsewhere in `.github/workflows/`.

**Test scenarios:** Test expectation: none — workflow YAML; validated by `actionlint` + a real `dry_run` dispatch (the end-to-end proof, per the existing dry-run convention). The matrix-build behavior is covered by Unit 3 unit tests. Digest verification step confirmed present in the workflow before extract.

**Verification:** `actionlint` clean; a `dry_run` dispatch carrying a real integration ref completes integrate→build→assemble green across all four platforms with the artifact handoff; digest check fires before any build.

- [x] **Unit 5: Docs + runbook update**

**Goal:** Document the bridge and the new OpenCode-auth secret for operators.

**Requirements:** R5

**Dependencies:** Unit 4

**Files:**
- Modify: `packages/harness/AGENTS.md`
- Modify: `packages/harness/BOOTSTRAP.md` (it currently names a mirror repo as the intended fix — correct it to the artifact-handoff model; this correction is **required**)
- Modify: `packages/harness/README.md` (only if it describes the release flow; conditional, not mandatory)

**Approach:**
- Replace any mirror-repo language with the artifact-handoff description.
- Document the OpenCode-auth secret the integrate job needs and how to dispatch a real (patched) release vs a dry-run.
- Remove plan/taxonomy language; operator-facing only.

**Patterns to follow:** existing `BOOTSTRAP.md` tone; the workspace-executor secret docs.

**Test scenarios:** Test expectation: none — documentation.

**Verification:** docs describe the real shipped flow; no mirror-repo references remain; no plan-speak.

## System-Wide Impact

- **Interaction graph:** `harness-release.yaml` gains a job dependency edge (`build needs: integrate`); `build-platform.ts` gains a branch; `cli.ts` gains a subcommand. No runtime/action/gateway code touched.
- **Error propagation:** integrate `{ok:false}` → no artifact + job failure → matrix never starts (fail-hard preserved end-to-end).
- **State lifecycle risks:** artifact is per-run and ephemeral; no shared/persistent state introduced. Work dir is disposable. The artifact is a clean merged source snapshot — no build products, no platform-specific native deps, no `.git`.
- **API surface parity:** `build-platform.ts` keeps the clone path for standalone runs — no regression to the local/dry-run-with-real-commit path proven in PR #772.
- **Unchanged invariants:** native-build internals (Bun pin, root install, upstream-matched invocation), trusted publishing/OIDC, the privilege split (publish keeps `id-token`, build/integrate stay `contents: read`). The integrate job adds NO write-scoped git token.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| LLM merge non-determinism in CI produces a bad merged source tree | `runIntegration` already builds + verifies (pre-flight gate) before capturing the commit; fail-hard means a bad merge yields no artifact. Maintainer-gated manual dispatch. |
| Artifact size (full OpenCode source tree) slows the matrix | Exclude `.git` and build products; observe size on first dispatch; tune retention. Acceptable for a manual, infrequent release workflow. |
| OpenCode auth secret leakage in integrate job logs | File-based secret, never echoed; mirrors the proven workspace-executor pattern; token/body never logged. |
| `--source-tree` mode silently falling back to clone hides a broken artifact | Fail-closed when `--source-tree` is supplied but missing/empty (Unit 3 test). |
| Provenance manifest not in artifact → lost audit trail | Unit 2 test asserts `provenance.json` is included with the matching `integrationCommit`. |
| Partial/failed packaging leaves a corrupt artifact for upload | Atomic staging: archive written to temp path, moved to `--out` only on success (Unit 2 test). |
| Build matrix silently builds a stale or wrong merged source tree | Artifact is SHA-bound by construction (`git archive <integration_commit>`); build matrix verifies digest before compiling (R8). |
| Arbitrary ref injection via dispatch input bypasses carry policy | Merged refs come only from `harness.config.json` allowlist; no free-form ref input at dispatch; maintainer-gated `workflow_dispatch` (R9). |

## Documentation / Operational Notes

- Operators dispatch `harness-release.yaml` (`workflow_dispatch`); a real patched release needs the OpenCode-auth secret configured. Dry-run still needs no publish credentials.
- Merged refs are drawn exclusively from the `harness.config.json` carry-policy allowlist — no arbitrary ref can be injected at dispatch time. The release is maintainer-gated.
- The provenance manifest included in the artifact records the exact upstream inputs (base tag + each ref + resolved SHA) and should be reviewed before publish.
- This plan unblocks the deferred "first patched release carrying PR #30182" — that remains a separate operator dispatch after merge.

## Sources & References

- Related code: `packages/harness/src/integrate.ts`, `packages/harness/src/cli.ts`, `packages/harness/scripts/build-platform.ts`, `.github/workflows/harness-release.yaml`
- Related: `packages/harness/BOOTSTRAP.md` (mirror language to correct), PR #772 (native-build fixes), PR #771 (bootstrap runbook)
- Prior art: `prepare-release-pr.yaml` / `auto-release.yaml` (job-output + auth patterns, though no push needed here)
