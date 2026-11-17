---
title: Runner-side git after an untrusted process wrote to the checkout needs a restored, allowlisted .git
date: 2026-11-17
category: best-practices
module: setup
problem_type: design_pattern
component: infrastructure
severity: high
applies_when:
  - A trusted process runs git in a checkout that an untrusted process (an agent, a build) could write
  - You need runner-side git after an isolated agent run, such as diff, status or ls-files
  - A trusted allowlist must accept what actions/checkout writes on hosted runners
  - A checkout step could leave a credential in .git/config
symptoms:
  - "Sandbox handoff failed: the git metadata cannot be trusted: .git/config sets lfs.repositoryformatversion, which is not on the allowlist of keys a checkout writes"
  - ".git/config.worktree sets core.sparsecheckout, which is not on the allowlist of keys a checkout writes"
  - "rollback incomplete: .git was created during the run"
tags:
  - git-config
  - isolate-agent
  - trust-boundary
  - fsmonitor
  - allowlist
  - actions-checkout
  - persist-credentials
  - commondir
---

# Runner-side git after an untrusted process wrote to the checkout needs a restored, allowlisted .git

## Context

With `isolate-agent`, the model runs as a separate local user but can still rewrite the checkout, `.git` included. When it stops, the Action runs `git` in that checkout as the runner. Git runs commands named by config: `core.fsmonitor`, `core.hooksPath`, `diff.*.textconv`, `filter.*`, `core.sshCommand`, and anything an `include.path` pulls in. Hooks, `info/attributes`, a `.git/commondir` redirect and a submodule's own `.git/config` do the same. A trusted `git` call over that state runs the model's code with the runner's token.

Switching keys off on the command line (`-c core.fsmonitor=false -c core.hooksPath=/dev/null`) is not enough. It cannot reach config that git reads from somewhere else: an `include.path` into a checkout file, a `.git/config` that is a symlink, or a planted `commondir`. `trusted-git.test.ts` has a positive control for each.

## Guidance

Treat the metadata as untrusted and replace it. Treat the index, refs and objects as data.

1. **Snapshot before the model starts, restore at take-back.** `snapshotGit` and `restoreGit` in `src/services/setup/sandbox-handoff.ts` cover `config`, `config.worktree`, `hooks/` and `info/`. Restore removes the model's copy and renames the snapshot over it. A rename needs no free space; a copy is used only across devices.
2. **Audit the snapshot copy, not the live file.** `src/services/setup/git-snapshot-audit.ts` allows no symlinks or special files. Every config key must be on an allowlist of what `actions/checkout` writes. Git parses the copy itself:

   ```sh
   git config --file <copy> --list --null --no-includes
   ```

   A `remote.*.url` containing `::` is refused as a transport helper.

3. **Refuse `.git/commondir`.** It redirects git's config and objects, so a restored `config` would restore nothing git reads. `commondirProblem` checks it at handoff and again at take-back.
4. **Run git through one hardened wrapper.** `runTrustedGit` in `src/features/delegated/trusted-git.ts` disables global and system config, pins `PATH`, turns off the pager and prompts, sets a timeout, and passes `TRUSTED_GIT_GLOBAL_ARGS`.
5. **Do not enter gitlinks.** Under isolation `src/features/delegated/reconstruct-changes.ts` diffs with `--no-ext-diff --no-textconv --ignore-submodules=dirty` and declines when a submodule is populated. `--ignore-submodules=none` makes git run `git status` inside the submodule, where that repository's own `core.fsmonitor` runs.
6. **Require `persist-credentials: false`.** `actions/checkout` otherwise leaves the token as an `http.*.extraheader` in `.git/config`, which the model's user can read. Bootstrap fails closed on every trigger under isolation.

An allowlist replaced a first audit that looked for dangerous keys. A key nobody listed is not trusted, so there is no list of dangerous keys to maintain.

## Why This Matters

The Action's token and runner privileges sit behind that `git` call. Command-line hardening leaves every config key nobody thought of. A restored, audited config removes the class.

The cost of an allowlist is that it must match reality. The first release refused every hosted run, because the allowlist was written from a fixture checkout:

- System git-lfs on the hosted image writes `lfs.repositoryformatversion` (#2175). Only that one `lfs.*` key is allowed; `lfs.url`, `lfs.customtransfer.*` and `filter.lfs.*` stay refused.
- `actions/checkout` v7 runs `git sparse-checkout disable`, which leaves `core.sparsecheckout`, `core.sparsecheckoutcone` and `index.sparse` in `config.worktree` (#2177).

`lfs: true` on the checkout stays unsupported. It writes `filter.lfs.*` and hooks.

## When to Apply

Apply this whenever a trusted process runs `git` in a directory an untrusted process could write. That includes later workflow steps, which inherit the restored config.

## Examples

Build the test checkout the way `actions/checkout` builds it, not by hand. The real-runner suite replays checkout's own commands:

```ts
git(workspace, "config", "--local", "lfs.repositoryformatversion", "0")
git(workspace, "config", "--local", "extensions.worktreeConfig", "true")
git(workspace, "sparse-checkout", "disable")
git(workspace, "config", "--local", "--unset-all", "extensions.worktreeConfig")
```

Pair each hostile fixture with a plain-git control that must fire. A hostile config that does nothing under plain git proves nothing about the wrapper.

## Related

- [Sequential steps in one GitHub Actions job are not a security boundary](./same-job-phase-split-not-a-security-boundary-2026-07-04.md): poisoned git config and hooks between steps. This pattern is one constrained way to run trusted git after untrusted code in the same job; step order alone is still not a boundary.
- [A mechanism that can deliver any tracked change needs a path allowlist](./net-diff-delivery-needs-an-allowlist-not-a-denylist-2026-07-30.md): the same allowlist-over-denylist rule, for delivered paths.
- [An lstat-then-readFile guard is a TOCTOU file-system race](../logic-errors/toctou-file-read-race-in-net-diff-reconstruction-2026-07-30.md): the file-read side of the same reconstruction path.
- [Prove an Action change on the published install with a real caller](../workflow-issues/published-install-live-check-before-rollout-2026-11-17.md): how the two missing allowlist keys were found.
