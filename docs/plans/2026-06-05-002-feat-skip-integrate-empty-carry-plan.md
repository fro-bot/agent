---
title: "feat: Skip integrate job for empty carry set + tune merge prompt for Sonnet 4.6"
type: feat
status: done
date: 2026-06-05
---

> **Status: done.** All 5 units shipped: `has_refs` emitted from `prepare-integrate` and gating the `integrate` job, `build`'s dual-source clone, `publish` tolerating a skipped integrate, and the restructured merge prompt (`packages/harness/prompt.txt`) — verified on `main` (`.github/workflows/harness-release.yaml`, PR #788).

# feat: Skip integrate job for empty carry set + tune merge prompt for Sonnet 4.6

## Overview

The harness release pipeline runs a full Fro Bot agent (`integrate` job, ~3.5 min) on every release, even when the carry set is empty. With no patches to merge, that agent run does nothing but clone the stock release tag and push it to `refs/harness-integrate/<version>` — pure wasted CI time and a non-deterministic agent round-trip for a deterministic outcome.

This change makes the `integrate` job conditional: it runs only when there are patches to merge. When the carry set is empty, the `build` job clones the stock release tag directly and resolves its commit SHA, making empty-carry builds faster and idempotent. It also applies Oracle's Sonnet 4.6 prompt tuning to the merge path (which is now the only path that runs the agent).

## Problem Frame

`packages/harness/harness.config.json` currently has `integrationRefs: []` (empty — PR #30182 was reverted upstream and is not in OpenCode 1.16.0). The 1.16.0 dry-run (run 27024542968) proved the current pipeline works end-to-end, but the `integrate` job consumed ~3.5 min running an agent that produced a ref tip identical to the stock 1.16.0 tag commit. Oracle's audit of three recent `integrate` runs confirmed: the empty-carry agent run is functionally correct but entirely redundant, and even the merge-path runs waste turns on "orientation" (reading build internals/action.yaml the prompt told them to ignore).

Two improvements fall out:
1. **Skip the agent entirely when the carry set is empty** — deterministic stock-tag build, no agent.
2. **Tune the merge prompt for Sonnet 4.6** — since the empty-carry conditionals can leave the prompt (the prompt only renders for the merge path now), replace the ambiguous `(none)` conditionals with a deterministic merge-only runbook.

## Requirements Trace

- R1. When `harness.config.json` `integrationRefs` is empty, the `integrate` (Fro Bot agent) job does not run.
- R2. With an empty carry set, the `build` job clones the stock release tag from `release_repo`, resolves the tag commit SHA as `integration_commit`, and builds `<base>+harness.<sha[0:8]>` — identical output to today's path, just without the agent.
- R3. Empty-carry builds are idempotent: the same `base_version` + empty carry set yields the same `integration_commit` (the tag SHA) on every run.
- R4. With a non-empty carry set, the pipeline behaves exactly as today (integrate runs, pushes the ref, build fetches it).
- R5. `publish` continues to consume `needs.build.outputs.integration_commit` unchanged and provenance records the same SHA the binaries were built from (no split-brain regression in either path).
- R6. The merge prompt is restructured per Oracle's Sonnet 4.6 guidance (deterministic runbook, explicit merge mode, exact happy-path commands, ban on source-spelunking) — and no longer needs to carry the empty-carry / `(none)` conditional wording.

## Scope Boundaries

- Not changing the carry policy or which refs are carried (stays in `harness.config.json`).
- Not touching the action/runtime OpenCode pin (stays 1.15.13 separately).
- Not changing the publish/OIDC/provenance writer logic beyond what R5 requires (the writer already sources the build's `integration_commit`).
- Not adding per-ref resolved-SHA provenance (Fro Bot NBC on #786 — deferred to a future multi-ref carry).

### Deferred to Separate Tasks

- Per-ref `resolvedSha` in the provenance manifest (currently all entries share the integration commit): future task, only matters when a real multi-ref carry set exists.

## Context & Research

### Relevant Code and Patterns

- `.github/workflows/harness-release.yaml`:
  - `prepare-integrate` job (renders prompt, outputs `base_version` + `rendered_prompt`; already computes `INTEGRATION_REFS` from `harness.config.json`).
  - `integrate` job — a `uses: ./.github/workflows/fro-bot.yaml` reusable-workflow call gated on `needs: prepare-integrate`.
  - `build` job — matrix, `Fetch integration ref and resolve commit SHA` step fetches `refs/harness-integrate/<version>` and resolves the tip; emits `integration_commit` job output.
  - `publish` job — consumes `needs.build.outputs.integration_commit`; writes the provenance manifest from `harness.config.json` integrationRefs + that commit.
- `packages/harness/prompt.txt` — the merge prompt template (currently carries empty-carry `(none)` conditionals + the merge path). The `{{...}}` placeholders are substituted in `prepare-integrate`'s render step.
- `packages/harness/harness.config.json` — `integrationRefs` source of truth.

### Institutional Learnings

- Version-pin integrity is a hard invariant; the build must produce `<base>+harness.<sha>` deterministically (workspace-executor provisioning learnings).
- Pin aggressively, avoid non-deterministic `latest` (tool-binary-caching learnings) — supports the idempotent stock-tag clone.

### External References

- Oracle audit (this session): empty-carry agent run is redundant; merge-path prompt should be a deterministic runbook with explicit mode, exact commands, artifact discovery via `find`, and a ban on reading build/action internals unless a required command fails.

## Key Technical Decisions

- **`has_refs` gate in `prepare-integrate`**: the render step already parses `integrationRefs`; emit a boolean `has_refs` output. The `integrate` job gets `if: needs.prepare-integrate.outputs.has_refs == 'true'`. Rationale: single source of truth, no new parsing.
- **`build` dual-source by `has_refs`, not by "ref exists"**: branch explicitly on `needs.prepare-integrate.outputs.has_refs`. When `'true'`, fetch the pushed ref (today's path). When `'false'`, clone `release_repo` at `refs/tags/<tag>` and `git rev-parse` the tag commit as `integration_commit`. Rationale: explicit and race-free; avoids probing for a ref that was intentionally never pushed.
- **Skipped-job output propagation**: when `integrate` is skipped, `build`'s `needs: [prepare-integrate, integrate]` still resolves (a skipped needed job does not fail dependents as long as the dependent's own `if` allows it; `build` must use `if: always() && <prepare succeeded>` semantics OR rely on the default that skipped needs are permitted). Decision: verify the skipped-`integrate` dependency does not skip `build` — add `if: ${{ !cancelled() && needs.prepare-integrate.result == 'success' }}` to `build` so it runs whether or not `integrate` ran. This is the critical correctness seam.
- **Idempotency**: the stock-tag clone resolves `refs/tags/<tag>` → an immutable tag commit, so `integration_commit` is stable across runs (R3). The `+harness.<sha>` marker is derived purely from that SHA.
- **Prompt restructure**: remove empty-carry/`(none)` conditional wording from `prompt.txt`; it now only renders for the merge path. Apply Oracle's runbook structure (constants block, explicit merge mode, exact clone/fetch/branch/build/verify/push commands, `find`-based artifact discovery, ban on reading harness/build/action internals unless a required command fails). The `prepare-integrate` render only runs the prompt path when `has_refs == 'true'`, so the sentinel-init logic for empty refs can also be simplified.

## Open Questions

### Resolved During Planning

- How does `build` know the carry set is empty? → `prepare-integrate` emits `has_refs`; `build` branches on it.
- Does a skipped `integrate` job fail `build`? → No, as long as `build`'s `if` uses `!cancelled() && needs.prepare-integrate.result == 'success'` and does not require `integrate` success. Verified as the key seam.
- Does the stock-tag path stay idempotent? → Yes; `refs/tags/<tag>` is immutable.

### Deferred to Implementation

- Exact `if:` expression form for `build` and `publish` to tolerate the skipped `integrate` job (GitHub Actions skipped-needs semantics) — verify with a dry-run on both empty and (simulated) non-empty carry sets.
- Whether `publish`'s `needs` list + `if` also need `!cancelled()` adjustment so a skipped `integrate` doesn't skip `publish`.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
prepare-integrate (always)
  ├─ resolve base_version, tag
  ├─ compute has_refs  (integrationRefs non-empty?)
  └─ render prompt  (only meaningful when has_refs)
        │
        ├─ has_refs == true ──► integrate (Fro Bot agent: merge refs, push refs/harness-integrate/<v>)
        │                              │
        │                              ▼
        │                       build: FETCH refs/harness-integrate/<v>, resolve tip → integration_commit
        │
        └─ has_refs == false ─► (integrate SKIPPED)
                                       │
                                       ▼
                                build: CLONE release_repo @ refs/tags/<tag>, rev-parse tag → integration_commit

build (matrix, runs in BOTH cases via if: !cancelled() && prepare succeeded)
  └─ emits integration_commit
        │
        ▼
publish (consumes needs.build.outputs.integration_commit; provenance = same SHA)
```

## Implementation Units

- [x] **Unit 1: Emit `has_refs` from `prepare-integrate`**

**Goal:** Make the empty/non-empty carry decision an explicit job output.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `.github/workflows/harness-release.yaml` (prepare-integrate `outputs:` + render step)

**Approach:**
- In the render step, after computing `INTEGRATION_REFS`, set `has_refs=true|false` (true iff non-empty after trimming) to `$GITHUB_OUTPUT`.
- Add `has_refs: ${{ steps.render.outputs.has_refs }}` to the job `outputs:`.
- Keep `base_version` + `rendered_prompt` outputs as-is.

**Test scenarios:**
- Test expectation: none — workflow YAML, validated by actionlint + dry-run on both carry states.

**Verification:**
- actionlint clean; a dry-run logs `has_refs=false` for the current empty config.

- [x] **Unit 2: Gate the `integrate` job on `has_refs`**

**Goal:** Skip the agent run when there are no patches.

**Requirements:** R1, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `.github/workflows/harness-release.yaml` (integrate job `if:`)

**Approach:**
- Add `if: ${{ needs.prepare-integrate.outputs.has_refs == 'true' }}` to the `integrate` job.

**Test scenarios:**
- Test expectation: none — validated by dry-run (empty → integrate skipped; would need a non-empty config to prove it runs, simulated/deferred).

**Verification:**
- Empty-carry dry-run shows `integrate` skipped; build still proceeds.

- [x] **Unit 3: `build` dual-source (fetch ref OR clone stock tag)**

**Goal:** Make `build` produce the correct `integration_commit` in both paths and run even when `integrate` is skipped.

**Requirements:** R2, R3, R4, R5

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `.github/workflows/harness-release.yaml` (build job `if:` + `Fetch integration ref and resolve commit SHA` step)

**Approach:**
- Add `if: ${{ !cancelled() && needs.prepare-integrate.result == 'success' }}` to `build` so a skipped `integrate` does not skip it. **This is the critical seam — verify carefully.**
- In the fetch/resolve step, branch on `needs.prepare-integrate.outputs.has_refs`:
  - `'true'`: existing behavior — `git fetch origin +refs/harness-integrate/<version>:...`, `git rev-parse` the tip, checkout into `EXTRACT_DIR`.
  - `'false'`: `git clone --depth 1 --branch <tag> <release_repo_url> <EXTRACT_DIR>` (or fetch the tag), `git rev-parse refs/tags/<tag>` (or the cloned HEAD) → `integration_commit`. The extracted tree IS the stock tag source.
- Keep `integration_commit` job output emission identical so `publish` is unchanged.

**Test scenarios:**
- Test expectation: none — workflow shell; validated by dry-run (empty path clones tag, builds `<base>+harness.<tagsha>`).

**Verification:**
- Empty-carry dry-run: build clones the stock tag, resolves the tag SHA, builds all 4 platforms reporting `<base>+harness.<sha>`, emits `integration_commit` = tag SHA.

- [x] **Unit 4: `publish` tolerates skipped `integrate`**

**Goal:** Ensure publish runs in the empty-carry path and records the correct commit.

**Requirements:** R5

**Dependencies:** Unit 3

**Files:**
- Modify: `.github/workflows/harness-release.yaml` (publish job `if:`/`needs:` if required)

**Approach:**
- Verify `publish`'s `needs: [prepare-integrate, integrate, build]` + any `if:` does not get skipped because `integrate` was skipped. Adjust to `if: ${{ !cancelled() && needs.build.result == 'success' }}` if needed.
- Provenance writer already reads `harness.config.json` integrationRefs (empty → `[]`) + `needs.build.outputs.integration_commit` — no change needed, but confirm the empty path still produces a valid manifest with `integrationRefs: []` and the tag SHA.

**Test scenarios:**
- Test expectation: none — validated by dry-run (publish job runs, provenance valid).

**Verification:**
- Empty-carry dry-run: publish job runs (skip-guards/dry-run as configured), provenance manifest has `integrationRefs: []` + tag SHA.

- [x] **Unit 5: Restructure the merge prompt for Sonnet 4.6**

**Goal:** Make the (now merge-only) prompt a deterministic runbook; remove empty-carry conditionals.

**Requirements:** R6

**Dependencies:** Unit 2 (prompt only runs for the merge path now)

**Files:**
- Modify: `packages/harness/prompt.txt`
- Modify: `.github/workflows/harness-release.yaml` (render step — simplify sentinel-init now that empty refs never reach the prompt; keep the `bash -n` guard intact)
- Test: `packages/harness/src/cli.test.ts` (the `bash -n` prompt-snippet guard must still pass)

**Approach (Oracle's guidance):**
- Remove `(none)` / "if there are refs to merge" conditional wording — the prompt now always has refs.
- Add a `<constants>` block (tag, version, branch, workdir, release_repo) and a numbered `<procedure>` with exact commands for clone/fetch/branch/merge/build/verify/push.
- Artifact discovery via `find packages/opencode/dist -path '*/bin/opencode' -type f -print -quit` instead of "expected path".
- Explicit ban: "Do not read package.json, build scripts, action.yaml, or workflow files to understand the task. Run the exact commands below. Inspect files only to diagnose a failed required command."
- Keep the deterministic push heredoc (already good) + the embedded `bash -n`-validated snippet.
- Keep the no-GitHub-posting release-automation override (it eliminated the accidental-issue behavior).

**Test scenarios:**
- Happy path: the `bash -n` prompt-snippet guard test still extracts the fenced bash block and validates clean (no heredoc/indent regression).
- Edge case: render step still produces a coherent prompt for a non-empty carry set (the merge path) — manual/dry-run verification.

**Verification:**
- `bash -n` guard test green; a (simulated/future) non-empty-carry render reads as a clean runbook; Oracle's wasted-action behaviors (orientation reads, source-spelunking) are addressed by the ban + exact commands.

## System-Wide Impact

- **Interaction graph:** `prepare-integrate` → (`integrate` | skip) → `build` → `publish`. The skipped-`integrate` dependency is the critical seam — `build` and `publish` must use `!cancelled()`-style `if` so a skipped job doesn't cascade a skip.
- **Error propagation:** empty-carry path has fewer failure modes (no agent, no LLM merge). The stock-tag clone fails loudly if the tag doesn't exist.
- **State lifecycle risks:** none new; the stock-tag clone is read-only + deterministic.
- **API surface parity:** the `integration_commit` job output contract is unchanged in both paths, so `publish` + provenance are untouched.
- **Unchanged invariants:** non-empty carry path behaves exactly as today (R4); provenance still records the build's commit (R5); the action/runtime OpenCode pin is untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Skipped `integrate` cascades a skip to `build`/`publish` (GitHub Actions skipped-needs semantics) | Use `if: !cancelled() && needs.<prev>.result == 'success'`; verify with an empty-carry dry-run before any real publish. This is the #1 thing the dry-run must prove. |
| Stock-tag clone resolves a different SHA than the agent path would | Empty carry = no merge, so the agent path's ref tip IS the tag commit; cloning the tag yields the same SHA. Idempotent by construction. |
| Prompt restructure breaks the merge path (no non-empty carry to test now) | Keep the `bash -n` guard; the merge-path render is exercised only when a real ref is carried — note as the validation gap, verify on the next real carry. |
| Empty-carry `build` clone misses git history needed by the build | The upstream build reads `OPENCODE_VERSION` from env, not git; `--depth 1` tag clone is sufficient (verified earlier this session that build.ts has no git reads). |

## Documentation / Operational Notes

- `packages/harness/AGENTS.md` already documents the ref-push handoff; add a note that the `integrate` job is skipped for empty carry sets and `build` clones the stock tag directly.
- The empty-carry dry-run is the gate before the real 1.16.0 publish.

## Sources & References

- `.github/workflows/harness-release.yaml`, `packages/harness/prompt.txt`, `packages/harness/harness.config.json`
- Oracle integrate-log audit (this session)
- 1.16.0 dry-run run 27024542968 (proved current empty-carry path works end-to-end)
- Prior plan: `docs/plans/2026-06-05-001-feat-harness-integrate-build-bridge-plan.md`
