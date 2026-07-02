---
title: 'feat: harness release carry fingerprint, notes, and non-latest'
type: feat
status: done
date: 2026-06-21
---

> **Status: done.** Both units shipped: the carried refs squashed into one fingerprint commit (`packages/harness/prompt.txt` `git reset --soft` + single commit), and the carry list plumbed to the release job/notes in `harness-release.yaml` — verified on `main` (PR #982).

# Harness release carry fingerprint, notes, and non-latest

## Overview

Three improvements to the `@fro.bot/harness` release pipeline so a harness build's identity, provenance, and release ranking are correct:

1. **Squash all carried refs into one integration commit** so the integration SHA is a true fingerprint — its diff against the base tag is the combined diff of every carry, viewable as a single diff. Today the LLM merge produces N `--no-ff` merge commits and the SHA is just the *last* merge.
2. **List the carried PRs in the harness GitHub Release notes** (the same set `harness patches` reports), so a release at `1.17.6+harness.<short8>` documents exactly which upstream PRs it carries.
3. **Mark harness releases `--latest=false`** so a harness release never takes GitHub's "latest" pointer from the product `agent` releases.

## Problem Frame

The harness release flow: `prepare-integrate` renders a merge prompt → `integrate` (Fro Bot LLM merge) clones the base tag, `git merge --no-ff` each carry ref in order, pushes `refs/harness-integrate/<base_version>` → `build` fetches that ref and resolves `integration_commit = HEAD` → `release-binaries` creates the GitHub Release tagged `<base_version>+harness.<short8>`.

- The integration commit is the **last** `--no-ff` merge, so "view the carries as one diff" isn't possible and the SHA fingerprint understates what's carried.
- The release notes are a fixed one-liner (`Harness build of OpenCode <base> (integration <short8>)`) with no carry list.
- `gh release create` does not pass `--latest`, so GitHub's auto-latest could rank a harness tag (`1.17.6+...`) above a product tag (`v0.74.0`). Today `/releases/latest` resolves to the product release, but that is incidental, not enforced.

## Requirements Trace

- R1. The pushed integration ref is a **single commit** on top of the base tag whose tree equals all carries merged in order (conflicts resolved), so `git diff <base_tag>..<integration_commit>` is the combined carry diff.
- R2. The single integration commit's message names the carried refs.
- R3. The harness GitHub Release notes list the carried PRs (same labels as `harness patches` / the `integrationRefs`).
- R4. `gh release create` for harness releases passes `--latest=false`.
- R5. Existing gates still pass: the binary still self-reports `<base>+harness.<short8>`, the build/verify/libc/checksum steps are unaffected (they operate on the resulting tree/binary, not on history shape).

## Scope Boundaries

- Not changing which refs are carried (that's `harness.config.json`).
- Not changing the npm publish flow or the non-`v` tag scheme.
- Not changing how `integration_commit` / `short8` is derived (still `git rev-parse HEAD` of the pushed ref — now a single commit).

### Deferred to Separate Tasks

- Embedding the carry list into the binary `provenance.json` notes (already carried there structurally; release-notes is the gap this addresses).

## Context & Research

### Relevant Code and Patterns

- `packages/harness/prompt.txt` — the LLM merge procedure (step 2 merges each ref `--no-ff`; step 5 pushes `refs/harness-integrate/<version>`; step 6 returns the integration SHA). This is where the squash is added.
- `.github/workflows/harness-release.yaml`:
  - `prepare-integrate` (lines ~61-178) — computes `BRANCHES` (comma-joined carry labels like `anomalyco/opencode#19961, #31859, #31638`) from `integrationRefs`; renders the prompt. Add a `carries` output here.
  - `release-binaries` → `Create GitHub Release` step (lines ~726-772) — the `gh release create` with `--notes` and no `--latest`. Add the carry list to notes + `--latest=false`.
- `packages/harness/src/cli.ts` `cmdPatches()` (lines ~45-62) — the `harness patches` output shape (lists `integrationRefs`); the release notes should convey the same set.
- `packages/harness/harness.config.json` — `integrationRefs` (the 3 PR URLs).

### Institutional Learnings

- `docs/solutions/build-errors/` harness docs: the integration commit is the build/provenance anchor; any change to how it's produced must keep the binary version-identity verification intact (the existing `verify-binary.ts` + the release-binaries version gate).

## Key Technical Decisions

- **Squash via merge-then-soft-reset** (chosen): keep the per-ref `git merge --no-ff` sequence so the LLM resolves conflicts naturally ref-by-ref, then `git reset --soft {{tag}} && git commit` to collapse to one commit. The tree is identical to the multi-merge result; only history is flattened. Build, version verification, and the pushed-ref consumer are unaffected because they read the tree/HEAD, not the history shape.
- **Single source for the carry list**: the carry labels already computed as `BRANCHES` in `prepare-integrate` feed BOTH the squash commit message (via the prompt's `{{branches}}`) and the release notes (via a new `carries` output). No new data source.
- **`--latest=false` is defensive-explicit**: enforce non-latest regardless of how GitHub's auto-latest would rank the tag.

## Open Questions

### Resolved During Planning

- How to squash without breaking conflict resolution? → merge-then-soft-reset (conflicts handled during the merges; squash is purely a history flatten afterward).
- Does the squash break the version fingerprint / build? → No; the build and `verify-binary.ts` read the tree and the binary `--version`, not git history; `git rev-parse HEAD` still yields a single SHA.
- Where does the carry list come from for the notes? → the existing `BRANCHES` labels in `prepare-integrate`, plumbed as a `carries` output.

### Deferred to Implementation

- Exact commit-message format for the squash (e.g. `harness: integrate <base_version> carrying <labels>`) — finalize during prompt edit so it reads well and is deterministic.
- Whether the release notes render the carries as a bullet list or comma-joined — finalize when editing the `--notes` (bullet list is more readable for the GitHub Release body).

## Implementation Units

- [x] **Unit 1: Squash the integration into one fingerprint commit (prompt.txt)**

**Goal:** The pushed `refs/harness-integrate/<version>` is a single commit on top of the base tag containing all carries.

**Requirements:** R1, R2, R5

**Dependencies:** None

**Files:**
- Modify: `packages/harness/prompt.txt`

**Approach:**
- After step 2's per-ref `git merge --no-ff` sequence (and conflict resolution), add a squash step: `git reset --soft {{tag}}` then `git commit -m "<message naming the carries>"`. The message should name the carried refs (use the `{{branches}}` template var, already the comma-joined labels). Keep step 3 (build), step 4 (verify `--version` == `{{version}}`), and step 5 (push the ref) unchanged — they operate on the resulting tree/HEAD. Step 6 still returns `git rev-parse HEAD` (now the single squash commit).
- Update the procedure's prose/requirements so the agent knows the end state is ONE commit (not N merge commits) — explicitly: "After merging all refs and resolving conflicts, collapse the integration into a single commit with `git reset --soft {{tag}}` followed by `git commit`."
- Preserve the empty-carry path semantics: this job only runs when `has_refs == true` (the integrate job is skipped for empty carry sets), so the squash always has at least one carry. No empty-carry handling needed in the prompt.

**Execution note:** This is a prompt/runbook change validated end-to-end by a dry-run release, not by a unit test.

**Patterns to follow:** the existing exact-command style in `prompt.txt`; keep column-0 heredoc discipline.

**Test scenarios:** Test expectation: none — prompt/runbook change. Validated by a dry-run harness-release that produces a single-commit integration ref whose `git diff <tag>..HEAD` shows all carries.

**Verification:** A dry-run integration ref has exactly one commit above the base tag; `git diff <base_tag>..<integration_commit>` contains all three carries' changes; the built binary still reports `<base>+harness.<short8>`.

- [x] **Unit 2: Plumb the carry list to the release job and into the notes (harness-release.yaml)**

**Goal:** The harness GitHub Release notes list the carried PRs, and the release is marked non-latest.

**Requirements:** R3, R4

**Dependencies:** None (independent of Unit 1; the carry labels already exist in `prepare-integrate`)

**Files:**
- Modify: `.github/workflows/harness-release.yaml`

**Approach:**
- In `prepare-integrate`, add a `carries` output carrying the human-readable carry labels (reuse the `BRANCHES` value, or emit the `integrationRefs` as a newline/comma list). Thread it through the job `outputs`.
- The `release-binaries` job needs the carry list. Since `release-binaries` already consumes `prepare-integrate` outputs indirectly, add `carries` to its available inputs (via `needs.prepare-integrate.outputs.carries`).
- In the `Create GitHub Release` step, extend `--notes` to include the carried PRs (a `### Carries` section listing each ref/PR), and add `--latest=false` to the `gh release create` call. Apply the carries-in-notes to the create path; the clobber/idempotent-repair path (`gh release upload`) doesn't set notes, which is fine (notes are set on creation).
- Keep the existing one-line summary plus the carry list. Format the carry list as a markdown bullet list for readability in the GitHub Release body.

**Execution note:** CI/workflow change validated by `actionlint` + a dry-run/real release; no unit-test surface.

**Patterns to follow:** the existing `>> "$GITHUB_OUTPUT"` heredoc pattern in `prepare-integrate`; the existing `gh release create` flag style.

**Test scenarios:** Test expectation: none — workflow change. Validated by `actionlint` and a release run whose notes show the carry list and whose release is not marked latest.

**Verification:** `actionlint` clean; a release run's GitHub Release body contains the three carried PRs; `gh api repos/fro-bot/agent/releases/latest` still resolves to the product release after a harness release publishes; the harness release shows `--latest=false` behavior (not flagged latest).

## System-Wide Impact

- **Interaction graph:** `prompt.txt` (consumed by the Fro Bot integrate job) → the pushed integration ref → `build`/`release-binaries`/`publish`. Squashing changes only the history shape of the pushed ref; all consumers read HEAD/tree/binary.
- **Unchanged invariants:** the binary version identity (`<base>+harness.<short8>`), the build/verify/libc/checksum gates, the npm publish flow, the non-`v` tag scheme, and `integration_commit`/`short8` derivation (still `git rev-parse HEAD`, now a single commit).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| The soft-reset squash loses conflict resolutions or changes the tree | `git reset --soft` preserves the index/tree exactly; only commit history is discarded. The tree after the merges == the tree after the squash commit. Verify via dry-run `git diff <tag>..HEAD`. |
| The squash commit message is non-deterministic, breaking byte-stability expectations | The integration commit SHA is already non-deterministic across runs (LLM merge); nothing downstream pins it except per-run derivation. A stable message format is preferred but not required for correctness. |
| `--latest=false` interacts badly with the clobber/repair path | `--latest` is a create-time flag; the repair path uses `gh release upload` (no latest change), so a repaired release retains its non-latest status. |
| Carry list formatting breaks the heredoc/`--notes` quoting | Build the notes via a heredoc or a `--notes-file`, mirroring the existing safe-quoting patterns; validate with `actionlint`. |

## Documentation / Operational Notes

- No runtime/deploy impact. The next real harness release (next OpenCode bump) exercises all three changes; a dry-run can validate Unit 1's single-commit shape and Unit 2's notes/latest before a real publish.

## Sources & References

- Related code: `packages/harness/prompt.txt`, `.github/workflows/harness-release.yaml` (`prepare-integrate`, `release-binaries`), `packages/harness/src/cli.ts` (`cmdPatches`), `packages/harness/harness.config.json`.
- Trigger: maintainer request — squash carries into one fingerprint commit, list carries in release notes, keep harness releases non-latest.
