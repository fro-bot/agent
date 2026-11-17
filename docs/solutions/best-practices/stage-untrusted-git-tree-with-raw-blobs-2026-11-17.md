---
title: Stage files from an untrusted git tree with raw blobs, a pre-extraction budget and strict path checks
date: 2026-11-17
category: best-practices
module: setup
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - Copying files out of a git tree that contributors or a fork control into a path the agent or harness will read
  - Reading a tree on a CI runner where the checkout, its refs and its config are not trustworthy
  - Bounding disk use before writing anything extracted from git
tags:
  - git-cat-file
  - git-archive
  - gitattributes
  - symlink
  - o-nofollow
  - utf-8
  - repo-skills
  - untrusted-input
---

# Stage files from an untrusted git tree with raw blobs, a pre-extraction budget and strict path checks

## Context

The `repo-skills` input copies `.agents/skills` from a repository's default branch into a directory that OpenCode then scans. The tree's content is attacker-influenceable. `git archive | tar -x` is the obvious way to copy it, and it is unsafe in several separate ways. The staging code is `src/services/setup/repo-skills.ts`.

## Guidance

1. **Take the tree from a fresh private fetch, never from the checkout.** `stageDefaultBranchSkills` creates a throwaway bare repository under the staging root and fetches one commit of the default branch into a private ref. It first removes `GIT_DIR`, `GIT_WORK_TREE` and the other redirecting variables (`REDIRECTING_GIT_ENV`). No ref, config or object in the checkout is read, so an earlier step cannot plant or age one.
2. **Read raw blobs, not `git archive`.** `git archive` applies committed `.gitattributes` (`export-subst`, `ident`, `eol`). About 12 KB of stored blobs can expand to megabytes, past a budget that measured stored sizes. One `git cat-file --batch` returns the bytes as stored. `parseCatFileBatch` checks each frame against the listing and refuses an over-budget frame before reading its body.
3. **Budget before you write anything.** `git ls-tree -r -l -z -t <ref> -- .agents/skills` gives every path and size. Check entry, byte and depth limits against that listing, then read only the blobs you admit.
4. **Decode the listing strictly and refuse aliases.** Parse the raw `-z` bytes and decode each path with a fatal decoder:

   ```ts
   new TextDecoder("utf-8", {fatal: true, ignoreBOM: true})
   ```

   A lossy decode turns every invalid byte into U+FFFD, so two different git names become one string. A symlink entry and a directory with the same lossy name then alias, and a file is written through the link. `checkTreeShape` also refuses duplicate paths after NFC and lowercase folding, and a path that is both a file and a directory.

5. **Never write symlinks, and refuse submodules.** Symlink entries are counted, not written; the skills that contain one are rejected. `mkdir -p` follows a symlinked ancestor, and `O_NOFOLLOW` guards only the leaf, so files are created with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` into directories this code made itself.
6. **Publish atomically.** Copy each skill into a private scratch directory, then rename it into the directory the consumer scans. A failed copy is never discoverable.
7. **Budget per unit, not for the whole tree.** `selectSkillsWithinBudget` skips a skill that is over a limit on its own, or that would push the running total over, with one warning that names its id. The rest load. Structural problems (a submodule, an unsafe path, aliasing, a tampered blob stream) still refuse the whole source.
8. **Check collisions against the name the consumer registers.** OpenCode registers a `skills.paths` skill under its directory name, not its frontmatter `name`. Reserved ids are matched against the directory name.

## Why This Matters

Each shortcut fails quietly. Archive attributes make the written size differ from the budgeted size. A lossy decode lets two names address one path. An all-or-nothing budget lets one large skill block every other: on one repository a single 5.3 MB skill pushed the total to 5,372,686 bytes, over the 5 MiB limit, and no skill loaded (#2244).

## When to Apply

- Any code that materialises files from a git tree it does not fully trust: PR heads, default branches, dispatched branches.
- Any case where the extracted files feed a loader that discovers by directory scan.

## Examples

The attribute expansion is easy to reproduce. Commit a `.gitattributes` with `* export-subst` and a file full of `$Format:%H$` placeholders, then compare `git ls-tree -l` sizes with the output of `git archive`. The test for it is in `src/services/setup/repo-skills.test.ts`.

The repository name is validated before it reaches git. It appears only after the host in the remote URL, never where git could read it as an option. A repository named `.github` is valid (#2240); `.` and `..` are not.

## Related

- [An lstat-then-readFile guard is a TOCTOU file-system race](../logic-errors/toctou-file-read-race-in-net-diff-reconstruction-2026-07-30.md): the same symlink threat on the read side.
- [Runner-side git after an untrusted process wrote to the checkout](./restore-and-audit-git-metadata-before-runner-side-git-2026-11-17.md): why the checkout's own refs and config are not a source.
