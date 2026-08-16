---
title: TOCTOU at the untrusted model-output extraction boundary
date: 2026-08-14
category: security-issues
module: harness-release
problem_type: security_issue
component: tooling
symptoms:
  - "CodeQL reports a high-severity file system race: the file may have changed since it was checked"
  - "Path components are validated with `lstat` and then read again by path string"
  - "Symlink rejection provably covers the check but not the subsequent read"
root_cause: missing_validation
resolution_type: code_fix
severity: high
related_components:
  - ci-workflows
tags:
  - toctou
  - symlink
  - o-nofollow
  - untrusted-input
  - codeql
  - file-handle
---

## Problem

The harness conflict resolver validated a file path with `lstat` and then read it by path. Between the check and the read, the path can be swapped — so the bytes read were not provably the bytes that were validated. This sits at the boundary where untrusted model output becomes artifact input.

## Symptoms

CodeQL, high severity:

> Potential file system race condition — The file may have changed since it was checked.

The reported code walked each path component with `fs.lstat`, rejected symlinks, and then called `fs.readFile(current)`.

## Why It Mattered Here

The unit's contract is that only validated regular-file bytes from the allowed conflict set become artifact input. Everything downstream — path allowlisting, conflict-marker rejection, encoding checks, size caps — assumes the bytes it inspects are the bytes that were validated. A check-then-read-by-path gap undercuts that assumption at the one place where the input is adversarial by construction.

## What Didn't Work

Adding more validation before the read does not help. Any amount of path-based checking followed by a path-based open has the same window; the gap is structural, not a matter of checking harder.

## Solution

Validate and read through the same file handle. A shared helper opens the final component with `O_NOFOLLOW`, re-checks it through the open handle, and returns the handle; both read and write paths go through it.

```ts
async function openRegularFile(root: string, relative: string, flags: number): Promise<FileHandle> {
  // ... component-by-component parent traversal, rejecting symlinks ...
  const handle = await fs.open(current, flags, 0o666)
  const finalStat = await handle.stat()
  if (finalStat.isFile() === false) throw new Error(/* ... */)
  return handle
}

async function readRegularFile(root: string, relative: string): Promise<Uint8Array> {
  const handle = await openRegularFile(root, relative, O_RDONLY | O_NOFOLLOW)
  try {
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function writeRegularFile(root: string, relative: string, bytes: Uint8Array): Promise<void> {
  const handle = await openRegularFile(root, relative, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW)
  try {
    await handle.writeFile(bytes)
  } finally {
    await handle.close()
  }
}
```

The write side originally had the same asymmetry — it re-validated in one loop and wrote by path in a second — and now goes through the same helper.

## Why This Works

`O_NOFOLLOW` makes a final-component symlink fail at open rather than being followed. `handle.stat()` inspects the already-open file description rather than re-resolving the name, so the inode confirmed is the inode held. Reading and writing through that same handle means no second name resolution ever happens, and a swap after open affects the name but not the open file.

Parent-component traversal still resolves by path, because Node exposes no `openat`. That residual race is documented in a comment at the callsite rather than papered over — the honest claim is that the final component is closed and the parent walk is not.

## Prevention

- At a trust boundary, validate and use the same handle. `lstat` then `readFile(path)` is the pattern to look for; the fix is `open` + `fstat` + read from the handle.
- `O_NOFOLLOW` belongs on both read and write flags. Hardening one direction and leaving the other by-path is easy to miss, since the write side often looks like "we already validated this."
- Pin the behavior with a test that swaps the target after open. The regression test here replaces the validated target with a symlink and asserts the redirect file is not written and the target remains a symlink — proving the write landed on the original inode rather than merely that no error was thrown.
- State residual limitations in code. `openat` is unavailable in Node, so the parent walk keeps a window; a comment saying so is more useful than an implied guarantee that does not hold.
