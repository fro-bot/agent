---
title: An lstat-then-readFile guard is a TOCTOU file-system race; use an O_NOFOLLOW handle
date: 2026-07-30
category: logic-errors
module: delegated
problem_type: logic_error
component: service_object
symptoms:
  - "CodeQL js/file-system-race (high) on a file read that follows a stat-based guard"
  - "A symlink swapped in after the guard but before the read would be followed"
root_cause: async_timing
resolution_type: code_fix
severity: high
tags:
  - toctou
  - filesystem
  - symlink
  - o-nofollow
  - codeql
  - secure-read
---

# An lstat-then-readFile guard is a TOCTOU file-system race; use an O_NOFOLLOW handle

## Problem

Reconstructing a change set from the workspace read each file with a `lstat` guard (reject symlinks / non-regular / executable) followed by a path-based `readFile`. The two operations resolve the path independently, so anything swapped in between the check and the read is acted on — a classic time-of-check-to-time-of-use race. CodeQL flagged it as `js/file-system-race` (high).

## Symptoms

- CodeQL alert `js/file-system-race` (high) at the read site in `src/features/delegated/reconstruct-changes.ts`.
- The check (`lstat`) and the use (`readFile`) each re-resolve the path; a symlink planted between them is followed, defeating the symlink rejection.

## What Didn't Work

The `lstat`-then-`readFile` guard looked correct because it rejected symlinks — but the rejection is evaluated against a _different_ filesystem lookup than the read. Adding more checks before the read does not close the window; every path-based check-then-use pair reopens it.

## Solution

Open the file once with `O_NOFOLLOW`, then `stat` and read from that same handle, closing it in `finally`:

```ts
// Before — check and use resolve the path independently (racy)
const stats = await fs.lstat(filePath)
if (stats.isSymbolicLink() || stats.isFile() === false) throw new Error(...)
const content = await fs.readFile(filePath)

// After — one handle; O_NOFOLLOW rejects a symlink at open time
let handle: fs.FileHandle
try {
  handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
} catch {
  throw new Error(`${relativePath}: only regular files may be reconstructed`)
}
try {
  const stats = await handle.stat()
  if (stats.isFile() === false || isExecutable) throw new Error(...)
  const content = await handle.readFile()
  // …decode…
} finally {
  await handle.close()
}
```

## Why This Works

`O_NOFOLLOW` makes `open` fail if the final path component is a symlink, so a symlink swap is rejected at open time rather than checked and then re-followed. Once the handle is open it refers to a specific inode; `handle.stat()` and `handle.readFile()` both operate on that inode, so there is no second path resolution to race against. The `finally` close releases the descriptor on every path, including the size/exec-bit rejections.

## Prevention

- For any security-relevant file read, prefer a single `open` + handle-based `stat`/`read` over a path-based check followed by a path-based read.
- Treat `lstat`/`stat` followed by a path-based `readFile`/`writeFile` as a TOCTOU smell in review, especially where the path is attacker- or model-influenceable.
- Pin the behavior with a test that a symlink at the path fails `open` (rejected as "only regular files may be reconstructed"), and that oversized/exec files are rejected from the handle stat before `readFile` is ever called.

## Related Issues

- [Reconstructing from git diff silently drops untracked files](untracked-files-dropped-by-git-diff-reconstruction-2026-07-30.md) — the sibling reconstruction bug found in the same review.
- Introduced and fixed while shipping brokered push for trusted mention runs (#1297 / PR #1304); the race was caught by CodeQL alert #69 before merge.
