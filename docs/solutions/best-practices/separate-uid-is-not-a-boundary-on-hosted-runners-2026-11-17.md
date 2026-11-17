---
title: "A separate uid is not a boundary on a hosted runner: shared directories are world-writable"
date: 2026-11-17
category: best-practices
module: setup
problem_type: best_practice
component: infrastructure
severity: high
applies_when:
  - An untrusted or autonomous process runs on a GitHub-hosted Linux runner as a different local user
  - Later runner-side code, in the Action or in another step, starts tools by name through PATH
  - You are choosing between ACL denylists, a read-only bind view, chroot and pivot_root to confine writes
tags:
  - isolate-agent
  - hosted-runner
  - world-writable
  - mount-namespace
  - read-only-view
  - pivot-root
  - path-planting
  - privilege-drop
---

# A separate uid is not a boundary on a hosted runner: shared directories are world-writable

## Context

`isolate-agent` first ran the agent as its own local user and shared the runner's filesystem with it. That was documented as protection for a write-capable token. It was not.

On the GitHub-hosted Ubuntu 24.04 and 26.04 images, `/usr/local/bin`, `/opt`, `/opt/pipx_bin`, `/usr/local/.ghcup/bin`, `/usr/share` and `/opt/hostedtoolcache` are mode 777 with no sticky bit. The runner's `PATH` lists `/usr/local/bin` before `/usr/bin`. A process under any uid can create or replace `git`, `tar`, `gh` or `zstd` there. A program the runner later starts by name, in the Action or in a later step, then runs as the runner, with the runner's token.

The measurements are in `docs/plans/2026-11-14-001-fix-isolate-agent-readonly-view-plan.md`. #2206 corrected the docs. #2209 closed the gap.

## Guidance

Confine writes with a private mount namespace whose filesystem is a read-only view with a short list of writable exceptions. A root builder runs inside the namespace:

1. Bind `/` recursively onto a new root.
2. Detach the stacked `binfmt_misc` mounts. The bottom entry is an autofs trigger that stays writable under any remount order.
3. Remount every other mount read-only, deepest first, one at a time with `remount,bind,ro`. This is `planViewSeal` in `packages/runtime/src/agent/sandbox-view.ts`.
4. Mount private tmpfs on `/tmp`, `/var/tmp` and `/dev/shm`.
5. Bind the approved roots back: the checkout, the response directory, the session directories, the `gh` config directory and the agent's home read-write; attachments and staged skills read-only.
6. Re-read `/proc/self/mountinfo` and refuse to start unless every mount outside the declared set is read-only. This is `verifyView` in the same file.

Then enter the view with `pivot_root`, lazily unmount the old root, and drop to the agent's user with `setpriv`. `buildSetprivDropArgs` in `packages/runtime/src/agent/sandbox-identity.ts` passes `--no-new-privs`, `--inh-caps=-all`, `--bounding-set=-all` and `--ambient-caps=-all`. A view that fails to build or verify never starts the server.

What didn't work:

- **An ACL denylist.** It has to find every writable path on every image and restore each ACL exactly afterwards.
- **`mount -o rbind,ro=recursive`.** It exits 0 and leaves nested mounts writable on both images.
- **`chroot` to enter the view.** A root process inside a `chroot` view can still reach the original writable root. Inside a `pivot_root` view it cannot.
- **`bwrap`.** It is absent on 24.04, and on 26.04 AppArmor allows it only after the uid drop.

## Why This Matters

A read-only allowlist needs no per-file bookkeeping, so there is no denylist to keep complete. The check reads the kernel's own mount table, so a mount the remount pass missed fails the launch instead of passing silently. After the drop the agent has no groups, no capabilities and `NoNewPrivs`, so it cannot remount anything.

The view limits filesystem writes. It does not limit network egress or reads, it has no PID namespace and no reduced `/dev`, and it does not detect hardlinks that existed before the run. The checkout and the other approved roots stay writable by design, so runner-side git there needs its own controls, and stopping the launch needs positive proof that every process is gone.

## When to Apply

- Before you treat a second local user as a write boundary on a hosted runner. Check what that user can write, not only what it can read.
- When a tool's exit code is the only evidence that a mount is read-only. Read the mount table.
- When the hosted images change. The real-runner `Sandbox integration` job runs a write matrix over the `PATH` directories, `/opt`, `/usr/share` and the tool cache on both images, with a control row for each.

## Examples

A passing launch logs `Read-only view probe passed` from `probeSandboxView` in `src/services/setup/sandbox-view-probe.ts`. Inside the view, a write to a mode-777 directory fails with the kernel's own error:

```text
$ touch /usr/local/bin/git
touch: cannot touch '/usr/local/bin/git': Read-only file system
```

## Related

- [Sequential steps in one GitHub Actions job are not a security boundary](./same-job-phase-split-not-a-security-boundary-2026-07-04.md): the same poisoning through PATH and shared files, between steps.
- [Stop a sudo-launched process tree by mount-namespace membership](./stop-sudo-launched-tree-by-mount-namespace-2026-11-17.md): how the launch is stopped and proven gone.
- [Runner-side git after an untrusted process wrote to the checkout](./restore-and-audit-git-metadata-before-runner-side-git-2026-11-17.md): the control for the one tree that stays writable.
