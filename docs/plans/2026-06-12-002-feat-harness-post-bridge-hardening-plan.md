---
title: "feat: Harness post-bridge hardening (#775)"
type: feat
status: done
date: 2026-06-12
---

> **Status: done.** R2 (error redaction), R3 (doctor version form), R4 (per-ref provenance), and R5 (clean-snapshot tests) shipped in #873. R1 (config-based merge-agent sandbox) was dropped after review as unworkable and off the production path. #775 is closed; the production merge-agent credential-isolation concern is tracked separately in #1060.

# feat: Harness post-bridge hardening (#775)

## Overview

Four contained hardening improvements to the `@fro.bot/harness` integrate/build pipeline, deferred from the integrate→build bridge work (#774). None block a release; each closes a security, auditability, or diagnostic gap. All changes are isolated to `packages/harness` and ship as one PR.

## Problem Frame

The harness LLM-merge pipeline works but has four verified gaps (confirmed against current source this session):

1. **No merge-agent sandbox** (`integrate.ts:206`) — `runMerge` runs `opencode run --agent build` with no permission policy, so the autonomous agent's tools can read the filesystem outside the merge clone, including the `0600` model-credential file the workflow writes.
2. **Raw error surfacing** (`integrate.ts` lines 323/331/339/348/354/363/370/377/386) — failure paths interpolate raw `errorMessage(error)` with no redaction or length cap, despite `integrate-command.ts` claiming "one-line message only — no secrets."
3. **Stale `harness doctor` version check** (`cli.ts:101`) — compares the built binary `--version` against the bare `baseVersion`, but built binaries self-report `<base>+harness.<short8>` via `buildHarnessVersion()`. Off the release path (`verify-binary.ts` already handles the suffixed form) but reachable; Marcus hit it smoke-testing 1.16.0.
4. **Per-ref provenance collapse** (`integrate.ts:393-396`) — every ref's `resolvedSha` is set to the shared integration commit, so the manifest can't record each carry's actual upstream SHA. **No longer moot**: 1.17.3 carries 3 real refs, so this is live auditability work.

## Requirements Trace

- R1. `runMerge` executes the LLM merge under a restrictive OpenCode permission policy scoped to the merge clone directory (deny fs/network/tools outside it), protecting the host credential path. (#775 item 1a)
- R2. Integrate/opencode failure messages are routed through a single shared formatter that is single-line, length-capped, and secret-redacting. (#775 item 1b)
- R3. `harness doctor` accepts the `<baseVersion>+harness.<short8>` version form for built binaries, mirroring `verify-binary.ts`. (#775 item 2)
- R4. The provenance manifest records each carried ref's actual resolved upstream SHA, not the shared integration commit. (#775 item 3)
- R5. Tests assert the clean-snapshot guarantees: the produced artifact contains no `.git`; `--source-tree` against a non-git dir builds without invoking the clone path. (#775 optional tests)

## Scope Boundaries

- No change to the carry set, base version, or release-trigger mechanics (that is the separate 1.17.4 task).
- No action/gateway cutover (separate task).
- R1 (sandbox) end-to-end behavior can only be fully proven by a live release dispatch; the PR proves the config is written and shaped correctly, with live validation deferred to the next real harness dispatch.

## Context & Research

### Relevant Code and Patterns

- `packages/harness/src/integrate.ts` — `runMerge` adapter (`:203-211`), `runIntegration` fetch loop (`:326-333`), manifest assembly (`:389-399`). `errorMessage` interpolation throughout the `runIntegration` step error returns.
- `packages/harness/src/cli.ts` — `cmdDoctor` (`:91-110`), the bare-version check at `:101`. `Provenance` already exposes `integrationCommit`.
- `packages/harness/src/version.ts` — `buildHarnessVersion()` produces `<base>+harness.<short8>`; the canonical form to mirror.
- `packages/harness/scripts/verify-binary.ts` — already parses/accepts the `+harness.<short8>` form; reuse its logic for R3.
- `packages/harness/src/provenance.ts` — `ProvenanceManifest` / `IntegrationRefRecord` shape (`resolvedSha` field) for R4.

### Institutional Learnings

- `docs/solutions/workflow-issues/harness-base-version-source-of-truth-2026-06-12.md` — single-source discipline; relevant to keeping the redactor/version logic from duplicating.
- Memory: error formatters must redact secrets and never log request/response bodies (announce webhook precedent).

## Key Technical Decisions

- **Sandbox via a written `opencode.json` permission config in the merge clone**, not CLI flags — OpenCode resolves permissions from config; writing `<workDir>/.opencode/opencode.json` (or equivalent config path the merge run reads) before `runMerge` scopes reads/writes/bash/network to the clone and denies webfetch/websearch/task/skill. Must verify the exact config path/key an isolated `opencode run` honors against the cloned 1.17.3 source before relying on it (the isolation recipe in memory 4672 is the reference). If a written config cannot be made authoritative for the merge run, fall back to env-based permission scoping — resolve this in Unit 1.
- **One shared `formatPipelineError()`** in a small harness util, applied at the `runIntegration` failure boundary — redact GitHub token/PAT shapes and `user:pass@` URL credentials, collapse newlines, cap length. Single source so the redaction rules don't drift.
- **`harness doctor` reuses the verify-binary parse**, not a re-implemented string compare — build the expected version from `baseVersion` + `integrationCommit.slice(0,8)` when `integrationCommit` is present, else bare base. Avoids a third copy of the version-form logic.
- **Per-ref SHA captured in the fetch loop**, where each ref's tip is freshly known (`git rev-parse FETCH_HEAD` / the fetched ref), threaded onto each `source` and into the manifest. Keeps the shared `integrationCommit` as the build/freeze anchor while recording true upstream provenance per ref.

## Open Questions

### Resolved During Planning

- Bundle as one PR or split? → One PR; all four items are `packages/harness`-local with high cohesion and a single validation surface.
- Is item 3 still moot? → No; 1.17.3 carries 3 real refs, so per-ref SHA is live.

### Deferred to Implementation

- Exact OpenCode config path/key that an isolated `opencode run` honors for permission scoping — verify against cloned 1.17.3 source in Unit 1; choose written-config vs env fallback based on what is actually authoritative.
- Whether `errorMessage` itself should be replaced or wrapped — determine when applying the formatter at the boundary.

## Implementation Units

- [x] **Unit 1: Merge-agent sandbox (R1)** — **DROPPED after ce:review.** Two findings, both verified at source: (1) the deny-by-default config was inverted — OpenCode permission eval uses `findLast` (`core/src/permission.ts:102`), so `'*':'deny'` last denied every tool; (2) bash is advisory-only (`core/src/tool/bash.ts:141`), so the `git`/`bun` the merge requires cannot be sandboxed in-config at all. Decisively: `runMerge`/`buildSandboxConfig` live in the standalone `harness integrate` CLI, which the production release pipeline does NOT use — `harness-release.yaml` dispatches `fro-bot.yaml` to run the merge in the Fro Bot action (its own permission/auth model). The sandbox guarded a non-production path with a broken, unsandboxable mechanism, so it was removed rather than fixed. The real merge-agent isolation concern (#775 item 1a) belongs to the `fro-bot.yaml` integrate job — assessed separately. R1 is withdrawn; R2-R5 stand.

**Goal:** Run the LLM merge under a restrictive permission policy scoped to the merge clone, so spawned tools cannot read the host credential path or reach the network beyond the merge fetch.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `packages/harness/src/integrate.ts` (the `runMerge` adapter and/or a pre-merge config-write step)
- Test: `packages/harness/src/integrate.test.ts`

**Approach:**
- First verify against `.slim/clonedeps/repos/anomalyco__opencode` (pinned 1.17.3) which permission config path/key an `opencode run` invocation honors, and whether a clone-local config is authoritative. Use the isolation reference in memory 4672.
- Write a permission config scoping read/write/edit/bash/external_directory to `<workDir>/**` (deny `*`), denying webfetch/websearch/task/skill, and allowing only `git *` / `bun *` bash, before invoking `runMerge`. If a clone-local written config can't be made authoritative, scope via the isolated-run env approach instead.
- Keep the 30-minute timeout and synchronous poll behavior unchanged.

**Patterns to follow:** Isolated-OpenCode recipe (memory 4672); workspace OpenCode config overlay precedent (`deploy/workspace-entrypoint.sh`).

**Test scenarios:**
- Happy path: `runMerge` is invoked with the permission config present in the clone (assert the config file is written with the expected deny-by-default shape before the CLI call).
- Edge case: empty carry set (`sources.length === 0`) skips merge entirely — no config written, no behavior change.
- Error path: config-write failure surfaces as a redacted pipeline error (ties to Unit 2), not a raw throw.

**Verification:** The merge run is configured deny-by-default outside the clone; unit tests assert the config is written with the scoped shape; live egress/credential-isolation proof is deferred to the next real harness dispatch.

- [x] **Unit 2: Shared error redactor (R2)**

**Goal:** Route integrate/opencode failure messages through one single-line, length-capped, secret-redacting formatter.

**Requirements:** R2

**Dependencies:** None (independent of Unit 1; Unit 1's error path uses it if landed first, else follows)

**Files:**
- Create: `packages/harness/src/format-error.ts` (or co-locate in an existing harness util)
- Modify: `packages/harness/src/integrate.ts` (apply at the `runIntegration` failure-return boundary), `packages/harness/src/integrate-command.ts` (honor its "no secrets" claim)
- Test: `packages/harness/src/format-error.test.ts`

**Approach:**
- `formatPipelineError(err)`: coerce to message, collapse newlines to `; `, redact `ghp_`/`gho_`/`ghu_`/`ghs_`/`github_pat_` token shapes and `scheme://user:pass@` URL credentials, cap to a fixed length with an ellipsis. Apply at each `return {ok:false, error: ...}` site in `runIntegration`.

**Patterns to follow:** Secret-redaction discipline (announce-webhook no-body-logging precedent); single-source utility (avoid duplicating regexes).

**Test scenarios:**
- Happy path: a plain multi-line error → single line, length-capped.
- Edge case: empty/undefined error → safe non-empty string; already-short message passes through.
- Error path (redaction): messages containing a `ghp_…` token, a `github_pat_…` token, and a `https://user:secret@host` URL → all redacted; assert the secret substring is absent from output.
- Edge case: over-cap message → truncated with ellipsis, no secret straddling the cut.

**Verification:** All `runIntegration` failure messages pass through the formatter; tests prove no known secret shape survives.

- [x] **Unit 3: harness doctor version form (R3)**

**Goal:** `harness doctor` accepts the `<base>+harness.<short8>` form for built binaries.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `packages/harness/src/cli.ts` (`cmdDoctor`, the `:101` check)
- Test: `packages/harness/src/cli.test.ts`

**Approach:**
- Build the expected version from provenance: when `integrationCommit` is present, expect `${baseVersion}+harness.${integrationCommit.slice(0,8)}`; else bare `baseVersion`. Reuse the parse/compare logic from `scripts/verify-binary.ts` rather than re-implementing. Replace the `version !== p.baseVersion` exact-equality with the expected-form comparison.

**Patterns to follow:** `scripts/verify-binary.ts` version-form acceptance; `version.ts` `buildHarnessVersion()`.

**Test scenarios:**
- Happy path: built binary reporting `1.17.3+harness.ed359558` against provenance with that `integrationCommit` → doctor passes.
- Edge case: provenance with no `integrationCommit` (scaffold/dev) → bare-base comparison still works.
- Error path: genuine mismatch (binary reports a different base) → doctor still fails with the mismatch message.

**Verification:** Doctor passes against a correctly-built suffixed binary and still fails on a true mismatch.

- [x] **Unit 4: Per-ref provenance SHA (R4)**

**Goal:** Record each carried ref's actual upstream SHA in the provenance manifest.

**Requirements:** R4

**Dependencies:** None (touches the same file as Units 1/2 — sequence after them to avoid churn)

**Files:**
- Modify: `packages/harness/src/integrate.ts` (fetch loop `:327-333`, manifest assembly `:391-399`); `packages/harness/src/provenance.ts` if the record shape needs the field surfaced
- Test: `packages/harness/src/integrate.test.ts`

**Approach:**
- In the fetch loop, after each `fetchRef` succeeds, capture that ref's resolved upstream tip (e.g. `git rev-parse FETCH_HEAD` or the fetched ref) via an adapter, and thread `resolvedSha` onto each `source`. In manifest assembly, map each ref's own `resolvedSha` (fall back to `integrationCommit` only if capture failed). Keep `integrationCommit` as the build anchor. Remove/replace the now-inaccurate `:390` comment.

**Patterns to follow:** existing adapter pattern in `integrate.ts` (`getCommitSha`, `fetchRef`).

**Test scenarios:**
- Happy path: 3 carried refs resolving to 3 distinct upstream SHAs → manifest records 3 distinct `resolvedSha` values, none equal to each other.
- Edge case: empty carry set → manifest `integrationRefs` empty, no per-ref capture attempted.
- Error path: per-ref SHA capture fails for one ref → falls back to `integrationCommit` for that ref without aborting the run.

**Verification:** Manifest shows distinct per-ref upstream SHAs for a multi-carry run; `integrate.test.ts` asserts distinctness.

- [x] **Unit 5: Clean-snapshot guarantee tests (R5)**

**Goal:** Lock the handoff invariants with tests.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Test: `packages/harness/src/integrate.test.ts` and/or `packages/harness/scripts/build-platform.test.ts`

**Approach:**
- Assert the produced artifact (the `git archive` snapshot) contains no `.git` directory. Assert `build-platform --source-tree` pointing at a non-empty non-git directory builds without invoking the clone path.

**Patterns to follow:** existing `--source-tree` / packageArtifact tests from #774.

**Test scenarios:**
- Happy path: packaged artifact has no `.git` entry.
- Happy path: `--source-tree` against a populated non-git dir → no clone invoked (assert the clone adapter is not called).

**Test expectation:** behavioral assertions on existing pipeline functions; no production change in this unit.

**Verification:** Both invariants are pinned by passing tests.

## System-Wide Impact

- **Interaction graph:** All changes are within the harness integrate/build path; no action/gateway/runtime surface touched. `harness doctor` is a local diagnostic, off the release path.
- **Error propagation:** Unit 2 centralizes failure-message formatting; ensure every `runIntegration` failure return uses it.
- **API surface parity:** The provenance manifest shape (R4) is consumed by `harness patches`/`info` and `verify-binary.ts` — confirm the per-ref `resolvedSha` change stays read-compatible.
- **Unchanged invariants:** Base version, carry set, release-trigger mechanics, and the `integrationCommit` build anchor are unchanged. `harness.config.json` is not touched.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| R1 sandbox config isn't authoritative for the merge run → false sense of isolation | Unit 1 verifies the honored config path/key against cloned 1.17.3 source first; env fallback if written config isn't authoritative; live proof deferred to next dispatch and called out |
| Redaction regex misses a secret shape | Cover GitHub token + PAT + URL-cred shapes with explicit tests; cap length so partial leaks can't straddle the cut |
| Per-ref SHA capture changes manifest shape and breaks a consumer | Keep `integrationCommit` field; only populate per-ref `resolvedSha` with real values; verify `verify-binary.ts`/`patches` read-compat |
| dist: harness dist is gitignored — no committed-bundle churn | No dist step needed for harness changes |

## Sources & References

- Issue #775 (post-bridge hardening) + Fro Bot triage + Marcus re-verification comment.
- Related: #774 (integrate→build bridge), #867 (version-source fix), shipped harness 1.17.3 (integration commit `ed359558`).
- Source: `packages/harness/src/integrate.ts`, `cli.ts`, `version.ts`, `provenance.ts`, `scripts/verify-binary.ts`.
- Isolated-OpenCode recipe: memory 4672.
