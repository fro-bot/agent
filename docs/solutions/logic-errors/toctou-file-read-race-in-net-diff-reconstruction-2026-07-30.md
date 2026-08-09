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
  - "The same alert recurs in a different module using the synchronous statSync/openSync shape"
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
  - fstat
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

## Recurrence (2026-08-07): the synchronous shape in a second module

The same alert reappeared in `evals/runner.ts`, which captures agent-written diagnostic logs. The mechanism is identical; only the API surface differed, which is why the original fix did not prevent it:

```ts
// Before — statSync and openSync each resolve the path independently (racy)
const bytesToRead = Math.min(fs.statSync(filePath).size, maxBytes)
const fileDescriptor = fs.openSync(filePath, "r")

// After — open once, then size the file through that same descriptor
let fileDescriptor: number | null = null
try {
  fileDescriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  const bytesToRead = Math.min(fs.fstatSync(fileDescriptor).size, maxBytes)
  const buffer = Buffer.alloc(bytesToRead)
  const bytesRead = fs.readSync(fileDescriptor, buffer, 0, bytesToRead, 0)
  return {text: buffer.subarray(0, bytesRead).toString("utf8"), bytesRead}
} finally {
  if (fileDescriptor !== null) fs.closeSync(fileDescriptor)
}
```

`fstatSync(fd)` is the synchronous counterpart of `handle.stat()`: it inspects the already-open inode rather than re-resolving the path. The size check matters here specifically because the files are written by the agent under test, so an unbounded read is a memory hazard as well as a race — and checking size on the descriptor means the value cannot change between the check and the read.

The original prevention rule named `lstat` and `readFile`, so a reviewer scanning for those exact calls would miss `statSync`/`openSync`. The rule below is now written against the _pattern_ rather than the specific API.

## Prevention

- For any security-relevant file read, prefer a single `open` + descriptor-based `stat`/`read` over a path-based check followed by a path-based read. This applies to every variant of the pattern: `lstat`/`stat`/`statSync` paired with `readFile`/`open`/`openSync`, async or sync.
- The smell is **two filesystem calls that each take a path**, where the second acts on what the first checked. Match on that shape, not on a list of function names.
- Apply it wherever the path is attacker- or model-influenceable — including files written by an agent under test, not only files from an untrusted checkout.
- Pin the behavior with a test that a symlink at the path fails `open` (rejected as "only regular files may be reconstructed"), and that oversized/exec files are rejected from the handle stat before the read is ever issued.

## Related Issues

- [Reconstructing from git diff silently drops untracked files](untracked-files-dropped-by-git-diff-reconstruction-2026-07-30.md) — the sibling reconstruction bug found in the same review.
- Introduced and fixed while shipping brokered push for trusted mention runs (#1297 / PR #1304); the race was caught by CodeQL alert #69 before merge.
- Recurred in the eval corpus diagnostics reader (PR #1340), caught by CodeQL alert #70 before merge — a second module, the synchronous API shape, and the same underlying pattern.
