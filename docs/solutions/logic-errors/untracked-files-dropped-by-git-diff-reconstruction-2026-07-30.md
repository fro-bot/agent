---
title: Reconstructing a change set from git diff silently drops untracked files
date: 2026-07-30
category: logic-errors
module: delegated
problem_type: logic_error
component: service_object
symptoms:
  - "A newly created (untracked) file in an allowed path is missing from the reconstructed change set"
  - "The run reports nothing-to-deliver / success even though the model created a file"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags:
  - git-diff
  - untracked-files
  - change-reconstruction
  - ls-files
  - net-diff
---

# Reconstructing a change set from git diff silently drops untracked files

## Problem

Reconstructing the model's changes as the net difference of the workspace against a trusted base commit used `git diff <sha>` alone. `git diff` reports only _tracked_ changes, so a file the model newly created (untracked) never appeared in the reconstructed set — it silently vanished, and the run reported "nothing to deliver" or succeeded while dropping real work.

## Symptoms

- A model-created new file under an allowed path is absent from the reconstructed `FileChange[]`.
- The delivery path reports nothing-to-deliver / green even though the workspace clearly changed.
- Modified tracked files come through fine; only brand-new files are missing — the tell that the diff, not the logic, is the boundary.

## What Didn't Work

Relying on `git diff <sha>` as the single source of "what changed." It is correct for tracked modifications and deletions but is silent on untracked files by design — there is no flag on `git diff` that makes a never-added file appear.

## Solution

Union the diff result with an explicit untracked-file listing, using the same neutralized git environment:

```ts
const untracked = await execAdapter.getExecOutput(
  "git",
  ["--no-pager", "-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "-z", "--"],
  {cwd: repoRoot, env: GIT_ENV, ignoreReturnCode: true, silent: true},
)
// merge untracked paths (added) with the tracked add/modify/delete set from `git diff`
```

`git ls-files --others --exclude-standard` lists workspace files git is not tracking, excluding `.gitignore`d paths — exactly the newly created files `git diff` omits. Each is treated as an addition and run through the same path/type/size validation as diffed files.

## Why This Works

`git diff` and `git ls-files --others` cover disjoint halves of "what's different from the base": diff owns tracked modifications/deletions, `ls-files --others` owns brand-new untracked files. Only their union is the true net change set. `--exclude-standard` keeps ignored scratch/build files out, so the union stays scoped to intentional content.

## Prevention

- Any "reconstruct changes from a diff" path must make an explicit, documented decision about tracked-only vs tracked+untracked, and test a brand-new file end to end — not just a modified one.
- When a feature's correctness depends on capturing _all_ workspace changes, treat `git diff` as necessary-but-insufficient and pair it with `ls-files --others --exclude-standard`.
- Keep a regression test asserting a freshly created allowed-path file survives reconstruction and reaches delivery.

## Related Issues

- [An lstat-then-readFile guard is a TOCTOU race](toctou-file-read-race-in-net-diff-reconstruction-2026-07-30.md) — the sibling reconstruction hardening from the same review.
- [Net-diff delivery needs an allowlist, not a denylist](../best-practices/net-diff-delivery-needs-an-allowlist-not-a-denylist-2026-07-30.md) — the surface this reconstruction feeds.
- Found and fixed during brokered push for trusted mention runs (#1297 / PR #1304).
