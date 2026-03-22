# Auto Release No-Force-Push Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate force-pushes to the protected `release` branch by making `next` the only disposable synthetic branch and publishing only from a merged `next -> release` PR.

**Architecture:** Split release automation into two phases. `prepare-release-pr` synthesizes `next` from the latest `v*` tag plus `main`, runs a dry-run release check, and opens or updates the release PR without touching `release`. `auto-release` runs only after a real merged `next -> release` PR, validates the merge shape, then builds and runs `semantic-release` on `release` before post-release cleanup.

**Tech Stack:** GitHub Actions YAML, shell steps with `gh`, `git`, `pnpm`, semantic-release

---

## Context

### Current failure mode

`/.github/workflows/auto-release.yaml` used to hard-reset `release`, merge `main`, and force-push `release`. That topology avoided semantic-release ancestry issues but now fails against branch protection (`Cannot force-push to this branch`).

### Existing working building blocks

- `/.github/workflows/ci.yaml` already knows how to synthesize a disposable release candidate by resetting to the latest `v*` tag, merging a target SHA, and running `semantic-release --dry-run`.
- `/.releaserc.yaml` already expects publishing from the `release` branch and pushes `dist/` + `package.json` via `@semantic-release/git`.
- Pending release PRs are already modeled as `next -> release`.

### Design constraints

- Do not weaken branch protection on `release`.
- Keep publishing on `release` for now; do not migrate tags to `main` in this change.
- Treat `next` as disposable state that can be regenerated at any time.
- Release PR merges must preserve commit history; squash/rebase are not acceptable publish inputs.

---

## Task 1: Split release prep from publish

**Files:**
- Modify: `/.github/workflows/auto-release.yaml`
- Create: `/.github/workflows/prepare-release-pr.yaml`

**Step 1: Rewrite publish workflow as PR-merge-only**

Update `/.github/workflows/auto-release.yaml` so it only triggers on merged `pull_request.closed` events for `next -> release`. Remove `schedule` and `workflow_dispatch` from this workflow entirely.

**Step 2: Create dedicated prepare workflow**

Create `/.github/workflows/prepare-release-pr.yaml` for `schedule` and `workflow_dispatch`. Reuse the same GitHub App token and git user setup pattern already used in the release workflows.

**Step 3: Verify workflow files are valid**

Run: `pnpm lint .github/workflows/prepare-release-pr.yaml .github/workflows/auto-release.yaml`
Expected: PASS

**Step 4: Commit**

```bash
git add .github/workflows/auto-release.yaml .github/workflows/prepare-release-pr.yaml
git commit -m "fix(release): split release prep from publish"
```

---

## Task 2: Make prepare workflow synthesize `next` only

**Files:**
- Modify: `/.github/workflows/prepare-release-pr.yaml`

**Step 1: Synthesize disposable release candidate**

In `prepare-release-pr.yaml`:
- checkout `release`
- reset to latest `v*` tag
- merge `origin/main`
- run `semantic-release --dry-run true --ci false`

Do not rewrite `release`.

**Step 2: Push synthetic candidate to `next` only when a release is predicted**

Push `HEAD:next` with `--force-with-lease` only if dry-run emits a version. Leave `release` untouched during prepare.

**Step 3: Verify workflow file is valid**

Run: `pnpm lint .github/workflows/prepare-release-pr.yaml`
Expected: PASS

**Step 4: Commit**

```bash
git add .github/workflows/prepare-release-pr.yaml
git commit -m "fix(release): synthesize next instead of rewriting release"
```

---

## Task 3: Manage pending release PR lifecycle from prepare

**Files:**
- Modify: `/.github/workflows/prepare-release-pr.yaml`

**Step 1: Discover existing `next -> release` PR**

Query for an existing open pending release PR before mutating any PR state. Preserve exactly one open pending release PR.

**Step 2: Create/update PR when release is predicted**

When dry-run emits a version:
- push `next`
- generate a body with pending commits since `origin/release`
- create or update the pending release PR
- wait for GitHub to compute mergeability and fail if it is `DIRTY` or `BLOCKED`

**Step 3: Clean up stale PR state when no release is predicted**

When dry-run predicts no release:
- close any stale pending release PR with a clear comment
- delete stale `next` if it exists

**Step 4: Verify workflow file is valid**

Run: `pnpm lint .github/workflows/prepare-release-pr.yaml`
Expected: PASS

**Step 5: Commit**

```bash
git add .github/workflows/prepare-release-pr.yaml
git commit -m "fix(release): manage pending release PR from dry-run output"
```

---

## Task 4: Auto-merge only with merge commits

**Files:**
- Modify: `/.github/workflows/prepare-release-pr.yaml`

**Step 1: Decide merge policy explicitly**

In `prepare-release-pr.yaml`, compute whether to merge the pending release PR immediately:
- `schedule` should merge automatically
- `workflow_dispatch` should merge when `force-release == true`
- `workflow_dispatch` may also merge an already-open PR to allow manual recovery

**Step 2: Merge only with a merge commit**

Use `gh pr merge --merge --delete-branch=false`. Do not use squash or rebase for release PRs.

**Step 3: Verify workflow file is valid**

Run: `pnpm lint .github/workflows/prepare-release-pr.yaml`
Expected: PASS

**Step 4: Commit**

```bash
git add .github/workflows/prepare-release-pr.yaml
git commit -m "fix(release): merge release PRs with merge commits"
```

---

## Task 5: Publish only from validated merged PR context

**Files:**
- Modify: `/.github/workflows/auto-release.yaml`

**Step 1: Validate merged PR shape before publishing**

In `auto-release.yaml`:
- ensure `pull_request.merged == true`
- ensure `head.ref == 'next'`
- ensure `base.ref == 'release'`
- ensure `merge_commit_sha` exists
- ensure `release` HEAD matches `merge_commit_sha`
- ensure the merged commit has two parents (merge commit, not squash/rebase)

**Step 2: Publish from `release` only**

After validation:
- setup node/pnpm
- build
- run real `semantic-release`

Do not regenerate `next` or mutate PR state before publish.

**Step 3: Keep cleanup post-publish only**

Only after `semantic-release` reports a new version:
- update `v0`
- delete `next`

Failed publish must leave enough state for reruns.

**Step 4: Verify workflow file is valid**

Run: `pnpm lint .github/workflows/auto-release.yaml`
Expected: PASS

**Step 5: Commit**

```bash
git add .github/workflows/auto-release.yaml
git commit -m "fix(release): publish only from merged release PRs"
```

---

## Task 6: Full verification

**Files:**
- Verify only

**Step 1: Run repository checks**

Run: `pnpm lint`
Expected: PASS, or only pre-existing warnings already present in the repo.

**Step 2: Run typecheck**

Run: `pnpm check-types`
Expected: PASS

**Step 3: Run full build**

Run: `pnpm build`
Expected: PASS and `dist/` remains in sync.

**Step 4: Manual workflow verification checklist**

Document results for:
- no-op `workflow_dispatch` path
- prepare path with releasable changes
- merged PR publish path
- rerun/idempotency expectations

If you cannot execute a live GitHub run from this branch, explicitly note that live workflow verification remains pending.

---

## Notes for execution

- Do not hand-resolve PR `#353`; treat it as disposable state.
- Close PR `#353`, delete `next`, and regenerate the pending release PR from the prepare workflow.
- Keep the GitHub App token flow intact so the merged PR emits a follow-up workflow run.
- Do not weaken branch protection to make the old force-push flow work.
- This change still relies on semantic-release making a direct non-force push to `release` after the merge. If branch protection later requires PR-only updates, revisit the design.
