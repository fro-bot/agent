---
title: "fix: Give the isolate-agent sandbox a read-only filesystem view"
type: fix
status: active
date: 2026-11-14
---

# fix: Give the isolate-agent sandbox a read-only filesystem view

## Summary

With `isolate-agent`, the agent's user can still write to shared directories on the hosted image that the runner runs programs from. This plan launches the agent inside a private mount namespace whose filesystem is read-only except for the paths the Action hands over. It ships as three PRs: the boundary, then the agent's `PATH`, then `bun` and `pnpm`.

---

## Problem Frame

`isolate-agent` runs the OpenCode server and its tools as a throwaway local user. That stops the agent from reading the Action's process environment and the runner's private files. It does not stop writes outside the runner home.

Measured on the hosted images (Ubuntu 24.04 `20261111.370.1`, Ubuntu 26.04 `20261111.196.1`):

- An unprivileged account can create, replace and unlink files in `/usr/local/bin`, `/opt`, `/opt/pipx_bin`, `/usr/local/.ghcup/bin`, `/usr/share`, and `/opt/hostedtoolcache` with its subdirectories. All are mode 777 with no sticky bit.
- The runner's `PATH` lists `/usr/local/bin` before `/usr/bin`. `zstd` and `node` already resolve there.

Read from the code:

- The handoff places no ACL outside the runner home and `RUNNER_TEMP`, and take-back walks only the handed-over roots (`src/services/setup/sandbox-handoff.ts`). Files the agent's user creates elsewhere survive the run.
- Runner-side programs are found by name through a `PATH` that starts with `/usr/local/bin`: the trusted git wrapper, the cache library's `tar` and `zstd`, and others.

So a program the runner or a later workflow step starts by name can be one the agent supplied, and it runs as the runner, which holds `github-token`.

A second, separate gap blocks adoption: the agent's `PATH` is fixed to `/usr/local/bin:/usr/bin:/bin`. `bun` and `pnpm` install under the runner home, which the agent's user can't enter. `uv` and the `node` from `actions/setup-node` sit in the tool cache, off that `PATH`. About 20 of the 36 owned agent jobs run one of these.

---

## Requirements

**Delivery 1: the boundary**

- R1. Under `isolate-agent`, the agent's process tree can write only to: the checkout, the session and XDG directories the handoff gives it, the response directory, the provisioned `gh` config directory, its own home, and private `/tmp`, `/var/tmp` and `/dev/shm`.
- R2. Every other location is read-only to that process tree, including every directory on the runner's `PATH`, `/opt`, `/usr/share` and the hosted tool cache. This holds for creating, replacing, appending to, renaming and unlinking, on every mount, nested mounts included.
- R3. Nothing the agent's process tree writes survives the run outside the locations in R1. The private temp directories vanish with the namespace.
- R4. A view that can't be built and verified never starts the server. The run fails, the handoff is taken back, and nothing is published or saved. There is no fallback to the old launch.
- R5. Teardown confirms that every process of the launch, privileged ones included, is gone before take-back, publication or persistence. An unconfirmed stop records `unsafe`.
- R6. Existing guarantees hold: the key proxy over loopback, the `gh` config handoff and credential helper, the trusted `.git` metadata snapshot and restore, the per-run log snapshot, and the stop → take-back → checkpoint order.
- R7. With `isolate-agent` off, behavior is unchanged.
- R8. The docs state what the view covers and what it doesn't.

**Delivery 2: the agent's PATH**

- R9. Tools in directories outside the runner home that earlier workflow steps put on the runner's `PATH` are runnable by the agent. That covers `uv` and a pinned `node`.

**Delivery 3: bun and pnpm**

- R10. `bun` and `pnpm`, installed the way callers install them, are runnable by the agent with no caller change beyond opting in.
- R11. The agent gains read and execute on those tools' install roots only. No grant covers the runner home or an ancestor of it, and no tool directory becomes writable.

---

## Scope Boundaries

- Pinning program lookups: restricting the Action's own `PATH`, checking the ownership chain of privileged tools, and running trusted git by absolute path. The view stops the agent's user from changing any of those directories during the run. What is left is a file placed before the Action starts, and that takes code already running as the runner. Pinning the Action's `PATH` would also change behavior: `zstd` lives only in `/usr/local/bin` on the measured image, so the cache would silently switch compression and miss existing entries.
- Detecting hardlinks that exist before handoff. Package stores make multiply linked files normal, and creating one takes code running as the runner.
- A machine-wide sweep for files owned by the agent's user. Overwriting an existing file keeps its owner, so a sweep proves nothing.
- Network egress control, a PID namespace, and a minimal `/dev`. The network must stay shared for the controller and the key proxy.
- Self-hosted runners, container jobs and macOS, which stay unsupported.
- Removing the runner-home ACL machinery. The ACLs still provide read confidentiality.
- A general rule that follows a tool's symlinks to decide what to grant.
- Flipping the `isolate-agent` default.

### Deferred to Separate Tasks

- The per-repo opt-in PRs: separate PRs in each caller repo, after the deliveries ship (see `docs/brainstorms/2026-11-14-isolate-agent-opt-in-rollout-requirements.md`).
- Sharing the runner's package caches and stores with the agent: a future iteration, only if cold installs prove too slow.
- Tools under the runner home other than `bun` and `pnpm`: added one at a time, from a measured layout.

---

## Context & Research

### Relevant Code and Patterns

- `packages/runtime/src/agent/server-v2.ts`: `buildSandboxLaunch` builds the `sudo` → `setpriv` → `env` → binary argv. The child is spawned detached. `killProcessGroup` swallows every error, including a permission error, so the runner can't be assumed to stop a root process.
- `src/harness/phases/sandbox-lifecycle.ts`: owns account creation, the handoff manifest, the launch spec (`SANDBOX_PATH`), launch admission, signal ownership, release and the `SANDBOX_STATE` writes. One timed-out privileged command makes the run `unsafe`.
- `src/services/setup/sandbox-handoff.ts`: the manifest (`workspace`, `handedOver`, `readable`, `traverseOnly`, `tighten`), `verifyRoots`, `planLocks`, the journal, and take-back. A `readable` root gets a recursive read-and-execute grant that take-back removes by uid.
- `src/services/setup/sandbox-preflight.ts`: `SANDBOX_TOOL_NAMES`, `TRUSTED_TOOL_DIRS`, `resolveTools`, and `checkActionLocation`, which walks the published install with `lstat` and requires `dist/main.js`, `dist/post.js` and `dist/key-proxy.js`.
- `packages/runtime/src/agent/sandbox-identity.ts`: account creation and deletion, the uid-wide kill and verify, and the `setpriv` drop arguments.
- `apps/action/src/key-proxy.ts` and the entry list in `tsdown.config.ts`: the pattern for a separate bundled child (`dist/key-proxy.js`), started with `process.execPath`.
- `src/harness/phases/v2-server.sandbox.integration.test.ts` and `src/harness/phases/v2-server.sandbox.harness.ts`: the real-runner suite. Probes are shell fragments run by the agent's shell, each with a runner-side positive control. The `Sandbox integration` job in `.github/workflows/ci.yaml` runs it on `ubuntu-latest` only.

### Institutional Learnings

- `docs/solutions/integration-issues/signal-forwarding-shim-orphans-native-child-2026-10-12.md`: sending a signal is not proof a child stopped. Confirm exit before trusting paths.
- `docs/solutions/security-issues/toctou-at-the-untrusted-model-output-extraction-boundary-2026-08-14.md`: a check followed by a path-based use is raceable. Privileged operations must not act on paths the agent can swap.
- `docs/solutions/logic-errors/repair-before-capture-sqlite-session-cache-loop-2026-09-02.md`: stop writers before checkpoint and save, and keep restore and save path lists identical.
- `docs/solutions/integration-issues/tool-cache-directory-spawned-as-executable-2026-09-06.md`: test that a tool resolves and runs, not only that its directory exists.
- `docs/plans/2026-11-10-001-feat-isolate-agent-uid-plan.md` ("As built"): take-back removes only this run's ACL entries and uses `setfacl -n`; never a blanket ACL reset.

### Measured on hosted runners

- A private mount namespace is admitted through `sudo` on both images, and the host mount table is unchanged afterwards.
- `mount -o rbind,ro=recursive` returns success but leaves nested mounts writable on both images. A recursive bind followed by a read-only bind-remount of each submount, deepest first, makes them read-only.
- With that view, the unprivileged account is refused in every shared directory listed above, including append and unlink on an existing mode-777 file. Approved directories, its home and fresh tmpfs temp directories accept writes, and the temp files are not visible on the host.
- Building the view takes 60–90 ms and leaves 54–62 mounts.
- Inside the view the account has no groups, no capabilities and `NoNewPrivs`. It can't remount, and it can't open a user namespace.
- One mount stayed writable after the remount pass: the top entry of a doubled `/proc/sys/fs/binfmt_misc`.
- `bwrap` is absent on 24.04. On 26.04 it works only after the uid drop.
- `bun` resolved at `/home/runner/.bun/bin/bun` and `pnpm` under `/home/runner/setup-pnpm/`, on one image and one version of each setup action.
- Not measured: how `sudo` and sudo-rs arrange the launch's processes, access through `/proc/<pid>/root` or inherited descriptors, `pivot_root`, the real server inside the view, and cancellation of the privileged part of the launch.

---

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "whole repository at b183325f7: src/, packages/, apps/, deploy/, .github/ (dist/ excluded)",
  "freshness": {
    "vcs_reference": "b183325f74e5ac511449eb1da4d2246ae7a8b383"
  },
  "budget": {
    "max_search_passes": 12,
    "max_candidate_inspections": 20,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/services/setup/sandbox-handoff.ts:handOff",
      "description": "Owns handoff and take-back of runner paths to the isolate-agent sandbox uid: setfacl grants, chown of handed-over roots, a journal, the ownership pass and ACL removal by uid.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/harness/phases/sandbox-lifecycle.ts:createSandboxLifecycle",
      "description": "Owns the isolate-agent run lifecycle: account creation, the handoff manifest, the sandbox launch spec including the fixed PATH, signal teardown, and the SANDBOX_STATE transitions.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/runtime/src/agent/server-v2.ts:buildSandboxLaunch",
      "description": "Pure sudo, setpriv and env argv for the sandboxed server. Identity variables, PATH included, are set after the drop.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/runtime/src/agent/sandbox-identity.ts",
      "description": "Creates and deletes the per-run sandbox account, kills and verifies every process of its uid, and builds the setpriv drop argv.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/services/setup/sandbox-preflight.ts:resolveTools",
      "description": "Resolves privileged tools by first executable match in fixed directories, and checks the published install location.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/runtime/src/shared/path-within.ts:isWithin",
      "description": "Component-wise lexical containment test that does not follow symlinks.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "apps/workspace-agent/src/handoff.ts",
      "description": "Walks a freshly staged clone with lstat and lchowns it to the agent uid.",
      "disposition": "insufficient"
    },
    {
      "path_or_symbol": "deploy/scripts/ensure-protected-dir.mjs:ensureProtectedDir",
      "description": "Creates or validates a root-owned protected directory for the Docker compose deployment.",
      "disposition": "insufficient"
    }
  ]
}
```

---

## Key Technical Decisions

- **A read-only mount view is the write boundary, not an ACL denylist.** A denylist has to find every writable file on every image and restore each ACL exactly. The view allowlists writable locations, costs under 100 ms, and needs no take-back of its own.
- **The trust line is the agent's process tree in this run.** Earlier workflow steps run as the runner and are trusted. An earlier isolated step is confined by the same view. This is why lookups are not pinned (see Scope Boundaries).
- **One custom launch for both images, no `bwrap`.** `bwrap` is missing on 24.04 and can't drop the uid as root on 26.04.
- **Per-mount read-only remounts, verified from the kernel's mount table.** `ro=recursive` silently skips submounts. The builder reads `/proc/self/mountinfo` before and after, and the launch fails unless every mount outside the declared set is read-only. Mount paths are decoded from the kernel's escaped form, never parsed from tool output.
- **The view keeps every path at its real absolute location.** The Action and the agent name the same files by the same paths: checkout, XDG directories, response directory, `GH_CONFIG_DIR`, the log directory. The view is a recursive bind of `/` entered as the new root, so nothing is relocated.
- **The policy lists writable roots and read-only inputs.** Private temp directories are mounted first. Any listed root beneath one is then bound back, parents before children: writable roots read-write, inputs (attachments, admitted skills) read-only.
- **The view builder is a bundled Node child, and the server launch stays an exec chain.** The builder runs as root inside the namespace, then exits. A fixed sequencing step then enters the new root, drops the uid and execs the server, so no Action-written privileged process outlives the build. `sudo` stays the parent, as today. The builder runs under the Action's own Node (`process.execPath`) from the published install. It runs before the agent starts, and the view then makes both read-only to the agent.
- **Mount-namespace membership is the handle for teardown.** A process group can be left, and the uid sweep can't see root processes. Every process of the launch, whatever its uid, session or group, is a member of the launch's private mount namespace. Teardown kills the members with the privileged tools and confirms none remain, in addition to the uid sweep. An empty namespace also means the private mounts are gone.
- **The preflight probe proves host capability only.** It is one pass or fail run of the real builder over a fixture. The launch-time verification is the authority for the real roots.
- **Delivery 2 mirrors the runner's `PATH` for the agent.** Absolute, existing directories, in the runner's order, de-duplicated, with the system directories appended. An entry the agent can write only lets the agent shadow its own tools, so it needs no filter.
- **Delivery 3 grants fixed install roots.** Each supported tool has a known install root taken from a measured layout, granted through the handoff's `readable` mechanism at its real path. Everything inside a granted root is readable by the agent, and the docs say so.

---

## Open Questions

### Resolved During Planning

- **Does the preflight probe need the account?** No. It checks writes as `nobody`, since account creation can take over a minute and happens later.
- **Does the cache library keep working?** Yes. Its `PATH` is untouched, so compression is unchanged.
- **Are both hosted images supported?** Yes. Both pass every measured stage, the all-mounts check included.

### Settled by Unit 1

Measured on both images (Ubuntu 24.04 with sudo 1.9.15, Ubuntu 26.04 with sudo-rs 0.2.13).

- **The doubled `binfmt_misc` mount.** The bottom entry is an autofs trigger that stays writable under any remount order. Unmounting the stack inside the view, or mounting a fresh `proc` there instead of binding the host's, leaves zero undeclared writable mounts. `/proc/self` and `/proc/1/status` still work for the account.
- **Process arrangement.** `sudo` stays as the parent and the final command is its direct child, in the same process group and session, with no pty. The runner can signal `sudo` only. `sudo` relays SIGTERM. A group SIGKILL from the runner kills `sudo` and orphans the final command. Closing stdin does nothing to `sudo`.
- **Identifying the namespace.** The spawned `sudo` is in the host namespace; its child is in the new one. `readlink /proc/<pid>/ns/mnt` on the child gives the id.
- **Listing and killing members.** `pgrep --ns <pid> --nslist mnt` and `pkill -KILL --ns <pid> --nslist mnt`, run as root, found and killed every member in one round, including processes that changed session and one reparented to init. A process-group listing missed two. Once empty, the namespace and its private mounts were gone.
- **Entering the view.** `pivot_root`, then a lazy unmount of the old root. `chroot` also works, but a root process inside a `chroot` view can reach the original writable root, and inside a `pivot_root` view it can't. Pipes work through either, and the server stand-in exits within 3 ms of stdin closing. The working directory must be set after entering, since the spawn's own is lost.
- **The builder.** The runner's Node is `/opt/runner-cache/externals/node24/bin/node`, in a world-writable directory chain. Root runs it inside the namespace. It runs before the agent starts, and the view makes it read-only to the agent.
- **Timing.** Spawn to first server output took 101–179 ms.
- **PTYs and devices.** `/dev/null`, randomness, PTY allocation, `/dev/shm` and `mktemp` all work in the view.
- **Temp use.** A small `npm` install wrote under 3 MiB to the account's `TMPDIR` and nothing to `/tmp` or `/var/tmp`.
- **Install roots.** `bun` is at `/home/runner/.bun` (one binary and a link to it). `pnpm` is at `/home/runner/setup-pnpm` (47 MB, 2,451 files, links that stay inside the root, its own store inside the root). Neither holds configuration or credential files. A recursive read-and-execute grant on each root, with the existing traverse entry on `/home/runner`, was enough to run both.
- **The runner's PATH.** Entries that earlier steps add through `$GITHUB_PATH` are in a JavaScript action's `process.env.PATH`, ahead of the image's entries.

Also seen, and outside this plan's write boundary: the account can connect to several sockets under `/run` (the system D-Bus, `snapd`, some `systemd` varlink sockets) and open some device nodes (`fuse`, `net/tun`, `vsock`). The Docker socket refuses it.

### Deferred to Implementation

- Whether to unmount the `binfmt_misc` stack or mount a fresh `proc`. Either passes the check.
- Sizes for the private tmpfs mounts. Measured use is small; pick a bound that a large install can't hit by accident.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

Launch chain under `isolate-agent`:

```text
sudo -n --preserve-env=<names> --
  unshare --mount --propagation private --
    <fixed sequencing step>
      1. <Action's node> dist/sandbox-view.js <policy>   # root, inside the namespace; exits when done
           read mountinfo
           recursive bind of / onto the new root
           remount every mount read-only, deepest first
           mount private /tmp, /var/tmp, /dev/shm
           bind listed roots back, parents before children
           re-read mountinfo; fail unless every other mount is read-only
      2. pivot_root into the new root, unmount the old one, then exec
           setpriv --reuid --regid --clear-groups --no-new-privs <drop all caps> --
             env HOME=… PATH=… XDG_*=… --
               opencode serve …
```

Order within a run:

1. Bootstrap preflight: resolve the tools, check the install, run the capability probe.
2. Setup, restore, account creation, ACL handoff, sandbox gitconfig (all unchanged).
3. Launch through the chain above, inside the lifecycle's launch admission.
4. Shutdown: close stdin, kill the namespace's members with `pkill --ns` and confirm none remain, kill and confirm the uid.
5. Take-back, then log snapshot, publication and persistence (unchanged).

A failed launch goes through steps 4 and 5 as well. "Rolled back" below means that same take-back, behind the same confirmation.

---

## Implementation Units

### Delivery 1: the boundary

- [x] **Unit 1: Hosted-runner measurements**

**Goal:** Settle the open questions on real runners before code depends on them.

**Requirements:** R2, R5, R10

**Dependencies:** None

**Files:**
- Modify: `docs/plans/2026-11-14-001-fix-isolate-agent-readonly-view-plan.md`

**Approach:**
- A throwaway branch in a scratch repository, no secrets, on `ubuntu-24.04` and `ubuntu-26.04`, deleted afterwards.
- Measure, with the real noninteractive `sudo` invocation: the process tree under `sudo` and sudo-rs; reading the namespace id of the launch from outside; listing and killing its members as root, including one that changed session; and that the namespace is gone once they exit.
- Measure the launch chain end to end with a stand-in server: the builder under the runner's Node as root, entering the view by `chroot` and by `pivot_root`, and that stdin, stdout and the working directory survive.
- Resolve the doubled `binfmt_misc` mount so the all-mounts check passes.
- Check PTY allocation, `/dev/null` and randomness inside the view, and a temp-size figure from a real install.
- Record where `setup-bun` and `pnpm/action-setup` install, and what those trees contain.
- Write the results into this plan's Open Questions.

**Test expectation:** none -- measurement only.

**Verification:**
- Every item under "Deferred to Implementation" has a recorded answer for both images.

- [x] **Unit 2: View policy and builder**

**Goal:** A tested module that turns a declared policy into mount operations and verifies the result, plus the bundled child that runs it.

**Requirements:** R1, R2, R3, R4

**Dependencies:** Unit 1

**Files:**
- Create: `packages/runtime/src/agent/sandbox-view.ts`
- Create: `packages/runtime/src/agent/sandbox-view-child.ts`
- Create: `apps/action/src/sandbox-view.ts`
- Modify: `tsdown.config.ts`
- Modify: `packages/runtime/src/index.ts`
- Test: `packages/runtime/src/agent/sandbox-view.test.ts`
- Test: `packages/runtime/src/agent/sandbox-view-child.test.ts`

**Approach:**
- Keep the planning pure: mount table in, ordered operations out. Keep verification pure: mount table and policy in, verdict out.
- The policy names the new root, the writable roots, the read-only inputs and the private temp mounts. It arrives as data, not as shell text.
- Refuse a policy in which a writable root has a mount beneath it, or equals or contains the `_actions` directory or the runner home.
- The child runs each operation by absolute tool path with a deadline, stops at the first failure, and exits non-zero with a fixed message.

**Execution note:** Implement test-first.

**Patterns to follow:**
- `packages/runtime/src/agent/key-proxy.ts` and `packages/runtime/src/agent/key-proxy-child.ts` for the pure-core and thin-child split.
- `apps/action/src/key-proxy.ts` for the bundle entry.

**Test scenarios:**
- Happy path: a mount table with nested mounts yields a recursive bind, then one read-only remount per mount, deepest first, then temp mounts, then the listed binds.
- Happy path: verification accepts a table where only the writable roots and temp mounts are writable.
- Edge case: a mount path with an escaped space decodes to the right path and is remounted.
- Edge case: two mounts stacked on one path are both accounted for by mount ID.
- Edge case: a writable root and a read-only input beneath a private temp directory are bound back after it, each with the right mode.
- Error path: verification rejects a table with one undeclared writable mount and names that mount.
- Error path: a writable root with a mount beneath it, or one containing the runner home, is refused before any operation.
- Error path: an operation fails or exceeds its deadline; the child runs nothing further and exits non-zero.

**Verification:**
- `dist/sandbox-view.js` is produced by the build, and two builds give identical output.

- [x] **Unit 3: Launch chain**

**Goal:** `buildSandboxLaunch` produces the namespace launch when a view is present.

**Requirements:** R1, R4, R7

**Dependencies:** Unit 2

**Files:**
- Modify: `packages/runtime/src/agent/server-v2.ts`
- Test: `packages/runtime/src/agent/server-v2.sandbox.test.ts`

**Approach:**
- Extend the sandbox launch spec with the view: the namespace tool paths, the interpreter and builder bundle, and the policy.
- The sequencing step is fixed text that takes every path as a positional argument.
- The server must not start unless the builder exits zero.
- Expose what teardown needs to identify the namespace, in the form Unit 1 settled.

**Patterns to follow:**
- The existing `buildSandboxLaunch` tests, which pin the full argv.

**Test scenarios:**
- Happy path: with a view, the argv is `sudo`, `unshare` with a private mount namespace, the sequencing step, the builder, then the enter-and-drop chain ending in the server.
- Edge case: a path containing a space, a quote or a newline reaches the builder and the server as one argument each.
- Error path: the builder exits non-zero; the server binary is never executed.

**Verification:**
- The existing tests for the launch without a view pass unchanged.

- [x] **Unit 4: Preflight**

**Goal:** The run fails before setup when the runner can't build a view.

**Requirements:** R4

**Dependencies:** Unit 2

**Files:**
- Modify: `src/services/setup/sandbox-preflight.ts`
- Test: `src/services/setup/sandbox-preflight.test.ts`

**Approach:**
- Add the tools the launch needs to the required list: `unshare`, `mount`, `umount`, `pivot_root` and the sequencing shell. Teardown uses `pkill` and `pgrep`, which are already required.
- Require `dist/sandbox-view.js` in the install check.
- The probe runs the real builder over a throwaway fixture, checks one refused write and one allowed write as `nobody`, and has its own short deadline. It reports pass or fail with one message.
- A probe that times out is confirmed stopped the same way Unit 5 confirms a launch. If it can't be, the run fails and nothing is set up.

**Test scenarios:**
- Happy path: with the tools and the bundle present and the probe passing, preflight passes.
- Error path: a required tool is missing; preflight fails and names it.
- Error path: the view bundle is missing or is a symlink; preflight fails.
- Error path: the probe fails or times out; preflight fails, nothing is set up, and the old launch is not used.

**Verification:**
- On both images the preflight passes and adds under two seconds.

- [x] **Unit 5: Lifecycle wiring and teardown**

**Goal:** The lifecycle builds the view policy from the handoff manifest, launches through it, and confirms the whole launch is gone before take-back.

**Requirements:** R1, R3, R4, R5, R6, R7

**Dependencies:** Units 2–4

**Files:**
- Modify: `src/harness/phases/sandbox-lifecycle.ts`
- Modify: `packages/runtime/src/agent/sandbox-identity.ts`
- Modify: `src/harness/phases/v2-server.ts`
- Modify: `src/harness/phases/bootstrap.ts`
- Test: `src/harness/phases/sandbox-lifecycle.test.ts`
- Test: `packages/runtime/src/agent/sandbox-identity.test.ts`
- Test: `src/harness/phases/sandbox-signal.test.ts`

**Approach:**
- The policy comes from the one manifest. Writable roots: the checkout, each handed-over directory, and the account's home. Read-only inputs: the manifest's `readable` and traverse-only entries.
- Stop gains a step: kill the members of the launch's mount namespace with the privileged tools and confirm none remain. If that can't be confirmed, the result is `unsafe`, the account is kept, and take-back does not run.
- A launch that never reached the server goes through the same stop.
- Signals during the build are owned by the lifecycle, as they are for the rest of the launch.

**Execution note:** Implement test-first.

**Patterns to follow:**
- `stopSandboxProcesses` in `packages/runtime/src/agent/sandbox-identity.ts` for kill-then-verify.
- The existing launch-admission and timed-out handling in the lifecycle.

**Test scenarios:**
- Happy path: the policy lists exactly the checkout, the handed-over directories and the home as writable, with the gh config directory only in provision mode, and the attachment and skills directories as read-only inputs.
- Happy path: release confirms the namespace is empty, then the uid, then takes back.
- Edge case: the launch failed before the uid drop; release still confirms the namespace and takes the handoff back.
- Error path: a namespace member remains after the kill, or the kill times out; the result is `unsafe`, no take-back, account kept.
- Error path: the namespace can't be identified and the launch process has not exited; the result is `unsafe`.
- Error path: a writable root has a mount beneath it; the launch is refused before the server starts, and the handoff is taken back.
- Integration: a signal arriving during the build ends with the namespace confirmed empty and no server started.
- Integration: with `isolate-agent` off, no view policy is built and no new command runs.

**Verification:**
- Every path that ends `restored` has confirmed both the namespace and the uid.

- [x] **Unit 6: Real-runner suite on both images**

**Goal:** The boundary is proven on real hosted runners for Ubuntu 24.04 and 26.04.

**Requirements:** R1, R2, R3, R5, R6

**Dependencies:** Units 2–5

**Files:**
- Modify: `src/harness/phases/v2-server.sandbox.integration.test.ts`
- Modify: `src/harness/phases/v2-server.sandbox.harness.ts`
- Modify: `.github/workflows/ci.yaml`

**Approach:**
- A write matrix as blocked probes, each with a runner-side control: create, append, rename and unlink in every runner `PATH` directory, `/opt`, `/usr/share`, the tool cache root and one subdirectory, and a disposable mode-777 file placed before launch.
- Works probes: a write in each R1 location, `/dev/null`, randomness, a PTY, and shared memory.
- Escape probes: a symlink from the checkout into a sealed directory, a hardlink from a sealed file into the checkout, `/proc/<runner pid>/root`, a remount attempt, and a user-namespace attempt.
- After the run, from the runner: disposable sentinels are unchanged, the private temp files are absent, no process remains in the namespace, and the host mount table equals the one before.
- The existing suites pass through the view: key proxy, `gh` credential helper, hostile git state, persistence round trip, log snapshot.
- The job runs on `ubuntu-24.04` and `ubuntu-26.04`. The workflow edit needs the owner's approval before it is pushed.

**Test scenarios:**
- Happy path: every write-matrix probe is blocked for the agent and allowed for the runner control.
- Happy path: every R1 location accepts a write from the agent.
- Edge case: a write through a checkout symlink into `/usr/local/bin` is blocked.
- Edge case: a hardlink from a sealed file into the checkout is refused.
- Error path: the agent can't read through `/proc/<runner pid>/root`.
- Error path: remount and user-namespace attempts fail.
- Integration: a server killed mid-run leaves no namespace member and no private mount.
- Integration: a second isolated run in the same job finds nothing from the first outside R1 locations.
- Integration: the server starts, becomes ready, runs a tool call and shuts down through the view on both images.

**Verification:**
- Both matrix legs pass, and no probe is skipped.

- [x] **Unit 7: Docs for delivery 1**

**Goal:** The docs describe the boundary as built.

**Requirements:** R8

**Dependencies:** Unit 6

**Files:**
- Modify: `docs/wiki/Setup and Configuration.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `action.yaml`

**Approach:**
- Replace the "Known limit, shared writable directories" paragraph with what the agent can write, what is read-only, and what stays out of scope: the checkout is still agent-written, read-only mounts don't stop socket or device access, the network is shared, and earlier steps are trusted.
- Add the new tools to the Requirements list and the view to the launch description.
- Restore the "when to turn it on" guidance for write-capable tokens.

**Test expectation:** none -- documentation only.

**Verification:**
- No doc still says the agent can write to shared directories.

### As built (Delivery 1)

Divergences from the plan, with the reason:

- **Namespace confirmation uses `lsns`, not `pgrep --ns`.** With the namespace leader dead, `pgrep --ns <leader>` exits 1 with no output while members remain, which reads as "empty". The confirmation lists namespaces with `lsns -n -t mnt -o NS,PID` (lowest pid of each), kills with `pkill -KILL --ns <that pid> --nslist mnt` and requires the namespace to be gone from the listing. A failed listing is never an empty answer. New module `packages/runtime/src/agent/sandbox-namespace.ts`; `lsns` joins the preflight's required tools.
- **The probe checks the refused write as root inside the view, not as `nobody`.** `nobody` cannot traverse the runner home, so its refusal would be a permission error and prove nothing. The probe checks for the read-only error text as root, then drops to `nobody` for the drop and a private `/tmp` write.
- **Builder bundle is split into a chunk.** `dist/sandbox-view.js` imports `dist/sandbox-view-<hash>.js`; the suite's stand-in install copies both. The preflight still names only the entry script.
- **Launch gate (second pass).** A dead launcher is not proof its namespace is empty: a group kill of `sudo` orphans a root child. The chain now starts with a gate, run by the same `sh` inside the new namespace before the builder: it writes `echo "$(readlink /proc/self/ns/mnt)"` to `<gate dir>/ns`, then polls `<gate dir>/go` until its content equals that id, and exits 71 on its own bound (200 ticks of `sleep 0.1`; 70 if it cannot read or record the id, 72 if it cannot sleep). The runner (`admitLaunch`) reads `ns`, requires `mnt:[digits]` that differs from its own `/proc/self/ns/mnt`, then writes `go` (`wx`, mode 0600) only if the launcher is alive and the teardown has not begun. The gate directory is made per launch under `<view root parent>/gates` by the runner (mode 0700), so the sandbox account cannot reach it. `readlink` and `sleep` join the preflight's required tools. `findLaunchNamespace` (`pgrep -P` + `lsns -p`) is gone.
- **Teardown rule (`stopLaunch`), per case.** Id captured (at admission, or read from the gate file at teardown), launcher alive or dead: stop the namespace and confirm it absent from a complete `lsns` listing. No id captured: no go-ahead was ever given, so only the gate shell (and the launcher) can exist; both carry the gate directory in their command line, so `pkill -KILL -f` on a self-excluding pattern of it kills them and `pgrep -c -f` must print `0` with exit 1. Anything not confirmed is `unsafe`. A time bound on the gate was rejected as the rule: it bounds the earliest exit of the orphaned shell, not the latest.
- **Listing check.** `lsns` output is rejected as a whole if any non-empty row is not two numbers, or if the runner's own namespace id is missing; absence of the launch id only counts as stopped from a listing that passed both.
- **Preflight probe** uses the same gate, admission and stop; a probe launch that cannot be confirmed stopped leaves its fixture in place and fails the preflight.
- **Extra files touched:** `src/harness/phases/sandbox-signal.fixture.ts`, `src/harness/phases/v2-server.test.ts`, `src/harness/phases/v2-server.ts` (passes the launcher's pid callback through to the spawn), `packages/runtime/src/agent/server-v2.sandbox.test.ts`. `bootstrap.ts`, `cache-restore.ts`, `run.ts` and `post.ts` needed no change: the lifecycle's `release` is the single teardown path and already ran for a failed launch.
- **CI job name changes** to `Sandbox integration (<os>)` with the matrix; a required-status-check setting naming the old job must be updated by the owner.
- **User-namespace probe** asks whether a write can be made to work from inside a user namespace, not whether one can be created: the hosted images may allow creation.

### Delivery 2: the agent's PATH

- [ ] **Unit 8: Mirror the runner's PATH**

**Goal:** Tools outside the runner home that earlier steps put on `PATH` run for the agent.

**Requirements:** R9

**Dependencies:** Delivery 1

**Files:**
- Create: `src/services/setup/sandbox-toolchain-path.ts`
- Modify: `src/harness/phases/sandbox-lifecycle.ts`
- Modify: `src/harness/phases/v2-server.sandbox.integration.test.ts`
- Modify: `docs/wiki/Setup and Configuration.md`
- Test: `src/services/setup/sandbox-toolchain-path.test.ts`
- Test: `packages/runtime/src/agent/server-v2.sandbox.test.ts`

**Approach:**
- Read the runner's `PATH` as the Action sees it at bootstrap.
- Keep absolute entries that are existing directories, in order, without duplicates, and append the system directories.
- An entry under the runner home stays on the list. It resolves nothing until delivery 3 grants it.
- The docs say the agent sees the runner's `PATH`.

**Test scenarios:**
- Happy path: tool-cache and system entries are kept in order, and the system directories come last.
- Edge case: empty, relative and missing entries are left out.
- Edge case: a duplicate entry appears once, at its first position.
- Integration (real runner): after `actions/setup-node` and `astral-sh/setup-uv`, the agent's shell reports the pinned `node` version and runs `uv`.

**Verification:**
- A workflow that uses only tool-cache tools needs no change beyond `isolate-agent: true`.

### Delivery 3: bun and pnpm

- [ ] **Unit 9: Grant the install roots of bun and pnpm**

**Goal:** `bun` and `pnpm` run for the agent, and nothing else under the runner home becomes readable.

**Requirements:** R10, R11

**Dependencies:** Units 1 and 8

**Files:**
- Modify: `src/services/setup/sandbox-handoff.ts`
- Modify: `src/harness/phases/sandbox-lifecycle.ts`
- Modify: `src/harness/phases/v2-server.sandbox.integration.test.ts`
- Modify: `docs/wiki/Setup and Configuration.md`
- Test: `src/services/setup/sandbox-handoff.test.ts`
- Test: `src/harness/phases/sandbox-lifecycle.test.ts`

**Approach:**
- A short fixed list of install roots, taken from Unit 1's measurements: `.bun` and `setup-pnpm` under the runner home. A root is granted only when it exists and a directory on the runner's `PATH` lies inside it.
- Each granted root becomes a `readable` root in the manifest. Its ancestors join the traverse chain, so their other children stay denied.
- Refuse any root that equals or contains the runner home.
- Add the new roots to every place the handoff enumerates roots: the reserved-subtree check, root verification, and lock planning.
- Take-back removes the grants through the existing per-uid removal.
- The docs name the supported tools and say that everything inside a granted root is readable by the agent.

**Execution note:** Implement test-first.

**Patterns to follow:**
- The `readable` handling for attachments and admitted skills in `src/services/setup/sandbox-handoff.ts`.

**Test scenarios:**
- Happy path: with `bun` on `PATH`, its install root is a readable root, its parent gains traverse, and the parent's other children are denied.
- Happy path: with `pnpm` on `PATH`, its install root is granted and its links resolve inside that root.
- Edge case: a listed root that doesn't exist, or that no `PATH` entry lies inside, is not granted.
- Error path: a root equal to the runner home is refused.
- Integration (real runner): `bun --version` and `pnpm --version` run in the agent's shell, installed the way callers install them, on both images.
- Integration (real runner): an install with `bun` and with `pnpm` succeeds in the checkout and writes its cache under the agent's home.
- Integration (real runner): a canary file beside a granted root stays unreadable, and the tool binary can't be modified.
- Integration: after take-back, the granted roots carry no entry for the agent's uid.

**Verification:**
- A caller workflow that installs `bun` or `pnpm` the usual way needs no change beyond `isolate-agent: true`.

---

## System-Wide Impact

- **Interaction graph:** The launch argv, the preflight and the lifecycle's stop change. The key proxy, cache restore and save, trusted git, finalize and the post hook don't.
- **Error propagation:** A missing capability fails the run at preflight, before setup. A view failure at launch never starts the server, takes the handoff back, and saves nothing. An unconfirmed stop records `unsafe`, which already withholds publication, persistence and uploads.
- **State lifecycle risks:** The private temp mounts and the new root vanish when the last member of the namespace exits, which is why teardown confirms the namespace is empty. The handoff journal is unchanged.
- **API surface parity:** No new input. The supported-runner requirements gain the namespace tools.
- **Integration coverage:** Kernel enforcement, process exit and mount behavior are provable only by the real-runner job. Unit tests cover argv, ordering, failure branches and state writes.
- **Unchanged invariants:** `isolate-agent` off; the stop → take-back → checkpoint order; restore and save path lists; the checkout stays agent-writable and untrusted for later steps.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A hosted image update changes mount behavior | The launch-time check fails the run without starting the server, and the real-runner job runs on both images on every PR. |
| A privileged part of the launch outlives the run | Teardown kills and confirms the namespace's members; unconfirmed means `unsafe`. |
| An autofs trigger mounts something writable after the check | Unit 1 saw no new mount in any approach, and removing the trigger from the view removes the case. Unit 6 re-reads the mount table after a run. |
| A tool the agent needs writes outside its home | Its home and the temp directories are writable; Units 6, 8 and 9 exercise real tools. Other cases surface as read-only errors, not silent damage. |
| A hardlink aliases a sealed file into a writable root | Inside the view a link across mounts is refused, and Unit 6 tests it. A link made before handoff takes code running as the runner, which is trusted. |
| The view breaks PTYs or device access | Unit 1 measures it, and Unit 6 tests it on both images. |
| A granted install root holds something private | The roots are a short fixed list, the docs say their contents are readable, and Unit 9 tests a canary beside one. |
| A setup action moves its install location | The grant is skipped, the tool stops resolving for the agent, and the real-runner job fails. |

---

## Documentation / Operational Notes

- Delivery 1 is a `fix`. Deliveries 2 and 3 are each a `feat`. Each is one PR.
- After delivery 1 ships, repeat the published-install live check with a write attempt into `/usr/local/bin` from the agent's shell.
- The `Sandbox integration` job stays a PR check and does not gate the release job.

---

## Sources & References

- Related code: `packages/runtime/src/agent/server-v2.ts`, `src/harness/phases/sandbox-lifecycle.ts`, `src/services/setup/sandbox-handoff.ts`, `src/services/setup/sandbox-preflight.ts`
- Related past work: `docs/plans/2026-11-10-001-feat-isolate-agent-uid-plan.md`, recorded active. That plan built the uid split and the home ACLs; this plan adds write confinement outside the home.
- Related past work: `docs/plans/2026-11-13-001-feat-isolate-agent-key-proxy-plan.md`, recorded active. Unchanged by this plan.
- Related past work: `docs/brainstorms/2026-11-14-isolate-agent-opt-in-rollout-requirements.md`. The rollout it describes waits for the deliveries here.
- Related PRs/issues: #2135, #2168, #2201, #2202
