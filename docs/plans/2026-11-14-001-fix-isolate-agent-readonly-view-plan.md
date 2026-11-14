---
title: "fix: Give the isolate-agent sandbox a read-only filesystem view"
type: fix
status: active
date: 2026-11-14
---

# fix: Give the isolate-agent sandbox a read-only filesystem view

## Summary

With `isolate-agent`, the agent's user can still write to shared directories on the hosted image that the runner runs programs from. This plan launches the agent inside a private mount namespace whose filesystem is read-only except for the paths the Action hands over. It ships in two deliveries: the boundary first, then support for toolchains that earlier workflow steps installed.

---

## Problem Frame

`isolate-agent` runs the OpenCode server and its tools as a throwaway local user. That stops the agent from reading the Action's process environment and the runner's private files. It does not stop writes outside the runner home.

Measured on the hosted images (Ubuntu 24.04 `20261111.370.1`, Ubuntu 26.04 `20261111.196.1`):

- An unprivileged account can create, replace and unlink files in `/usr/local/bin`, `/opt`, `/opt/pipx_bin`, `/usr/local/.ghcup/bin`, `/usr/share`, and `/opt/hostedtoolcache` with its subdirectories. All are mode 777 with no sticky bit.
- The runner's `PATH` lists `/usr/local/bin` before `/usr/bin`. `zstd` and `node` already resolve there.

Read from the code:

- The handoff places no ACL outside the runner home and `RUNNER_TEMP`, and take-back walks only the handed-over roots (`src/services/setup/sandbox-handoff.ts`). Files the agent's user creates elsewhere survive the run.
- Runner-side programs are found by name through a `PATH` that starts with `/usr/local/bin`: the trusted git wrapper (`src/features/delegated/trusted-git.ts`), the cache library's `tar` and `zstd`, and others.
- Privileged tools are resolved once at preflight by first match, with only an is-file and executable check (`src/services/setup/sandbox-preflight.ts`).

So a program the runner or a later workflow step starts by name can be one the agent supplied, and it runs as the runner, which holds `github-token`.

A second, separate gap blocks adoption: the agent's `PATH` is fixed to `/usr/local/bin:/usr/bin:/bin`. `bun` and `pnpm` install under the runner home, which the agent's user can't enter. `uv` and the `node` from `actions/setup-node` sit in the tool cache, off that `PATH`. About 20 of the 36 owned agent jobs run one of these.

---

## Requirements

**Delivery 1: the boundary**

- R1. Under `isolate-agent`, the agent's process tree can write only to: the checkout, the session and XDG directories the handoff gives it, the response directory, the provisioned `gh` config directory, its own home, and private `/tmp`, `/var/tmp` and `/dev/shm`.
- R2. Every other location is read-only to that process tree, including every directory on the runner's `PATH`, `/opt`, `/usr/share` and the hosted tool cache. This holds for creating, replacing, appending to, renaming and unlinking, on every mount, nested mounts included.
- R3. Nothing the agent's process tree writes survives the run outside the locations in R1. The private temp directories vanish with the namespace.
- R4. If the read-only view can't be built and verified on the runner, the run fails before setup. There is no fallback to the old launch.
- R5. A launch that fails partway never starts the server. Teardown confirms that every process of the launch, privileged ones included, is gone before take-back, publication or persistence. An unconfirmed stop records `unsafe`.
- R6. Tools the Action runs as root resolve through a chain the agent's user can't modify. Runner-side trusted git runs by an absolute path resolved the same way.
- R7. Existing guarantees hold: the key proxy over loopback, the `gh` config handoff and credential helper, the trusted `.git` metadata snapshot and restore, the per-run log snapshot, and the stop → take-back → checkpoint order.
- R8. With `isolate-agent` off, behavior is unchanged.
- R9. The docs state what the view covers and what it doesn't.

**Delivery 2: toolchains**

- R10. Tools that earlier workflow steps put on the runner's `PATH` are runnable by the agent with no caller change beyond opting in. That covers at least `bun`, `pnpm`, `uv` and a pinned `node`.
- R11. The agent gains read and execute on those tools only. Nothing else under the runner home becomes readable, and no tool directory becomes writable.
- R12. `PATH` entries that could resolve inside agent-writable or secret-bearing locations are dropped, with a warning that names the entry.

---

## Scope Boundaries

- Restricting the Action's own `process.env.PATH` while isolated. The view already stops the agent's user from changing any `PATH` directory during the run. A process-wide pin would add only defence in depth, and it costs real behavior: `zstd` lives only in `/usr/local/bin` on the measured image, so the cache would silently change compression and miss existing entries.
- A machine-wide sweep for files owned by the agent's user. Overwriting an existing file keeps its owner, so a sweep proves nothing; the view is the boundary.
- Network egress control, a PID namespace, and a minimal `/dev`. The network must stay shared for the controller and the key proxy.
- Self-hosted runners, container jobs and macOS, which stay unsupported.
- Removing the runner-home ACL machinery now that a view exists. The ACLs still provide read confidentiality.
- Flipping the `isolate-agent` default.

### Deferred to Separate Tasks

- The per-repo opt-in PRs: separate PRs in each caller repo, after both deliveries ship (see `docs/brainstorms/2026-11-14-isolate-agent-opt-in-rollout-requirements.md`).
- Sharing the runner's package caches and stores with the agent: a future iteration, only if cold installs prove too slow.

---

## Context & Research

### Relevant Code and Patterns

- `packages/runtime/src/agent/server-v2.ts`: `buildSandboxLaunch` builds the `sudo` → `setpriv` → `env` → binary argv. The child is spawned detached, so the launch is its own process group. `killProcessGroup` swallows every error, including a permission error.
- `src/harness/phases/sandbox-lifecycle.ts`: owns account creation, the handoff manifest, the launch spec (`SANDBOX_PATH`), launch admission, signal ownership, release and the `SANDBOX_STATE` writes. One timed-out privileged command makes the run `unsafe`.
- `src/services/setup/sandbox-handoff.ts`: the manifest (`workspace`, `handedOver`, `readable`, `traverseOnly`, `tighten`), `verifyRoots`, `planLocks`, the journal, and take-back. A `readable` root gets a recursive read-and-execute grant that take-back removes by uid.
- `src/services/setup/sandbox-preflight.ts`: `SANDBOX_TOOL_NAMES`, `TRUSTED_TOOL_DIRS`, `resolveTools`, and `checkActionLocation`, which walks the published install with `lstat` and requires `dist/main.js`, `dist/post.js` and `dist/key-proxy.js`.
- `packages/runtime/src/agent/sandbox-identity.ts`: account creation and deletion, the uid-wide kill and verify, and the `setpriv` drop arguments.
- `apps/action/src/key-proxy.ts` and the entry list in `tsdown.config.ts`: the pattern for a separate bundled child (`dist/key-proxy.js`), started with `process.execPath`.
- `src/features/delegated/trusted-git.ts`: `TRUSTED_GIT_PATH` and both execution paths (timeout and plain).
- `src/harness/phases/v2-server.sandbox.integration.test.ts` and its harness: the real-runner suite. Probes are shell fragments run by the agent's shell, each with a runner-side positive control. The `Sandbox integration` job in `.github/workflows/ci.yaml` runs it on `ubuntu-latest` only.

### Institutional Learnings

- `docs/solutions/best-practices/same-job-phase-split-not-a-security-boundary-2026-07-04.md`: agent-controlled `PATH` entries run later under runner credentials. Keep runner-side lookups separate from the agent's `PATH`.
- `docs/solutions/integration-issues/signal-forwarding-shim-orphans-native-child-2026-10-12.md`: sending a signal is not proof a child stopped. Confirm exit before trusting paths.
- `docs/solutions/security-issues/toctou-at-the-untrusted-model-output-extraction-boundary-2026-08-14.md`: a check followed by a path-based use is raceable. Privileged operations must not act on paths the agent can swap.
- `docs/solutions/logic-errors/repair-before-capture-sqlite-session-cache-loop-2026-09-02.md`: stop writers before checkpoint and save, and keep restore and save path lists identical.
- `docs/plans/2026-11-10-001-feat-isolate-agent-uid-plan.md` ("As built"): take-back removes only this run's ACL entries and uses `setfacl -n`; never a blanket ACL reset.

### Measured on hosted runners

- A private mount namespace is admitted through `sudo` on both images, and the host mount table is unchanged afterwards.
- `mount -o rbind,ro=recursive` returns success but leaves nested mounts writable on both images. A recursive bind followed by a read-only bind-remount of each submount, deepest first, makes them read-only.
- With that view, the unprivileged account is refused in every shared directory listed above, including append and unlink on an existing mode-777 file. Approved directories, its home and fresh tmpfs temp directories accept writes, and the temp files are not visible on the host.
- Building the view takes 60–90 ms and leaves 54–62 mounts.
- Inside the view the account has no groups, no capabilities and `NoNewPrivs`. It can't remount, and it can't open a user namespace.
- One mount stayed writable after the remount pass: the top entry of a doubled `/proc/sys/fs/binfmt_misc`.
- `bwrap` is absent on 24.04. On 26.04 it works only after the uid drop.
- Not measured: access through `/proc/<pid>/root` or inherited descriptors, hardlinks into writable roots, `pivot_root`, the real server inside the view, and cancellation of the privileged part of the launch.

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

- **A read-only mount view is the write boundary, not an ACL denylist.** A denylist has to find every writable file on every image and restore each ACL exactly. The view allowlists writable locations, costs under 100 ms, and needs no take-back.
- **One custom launch for both images, no `bwrap`.** `bwrap` is missing on 24.04 and can't drop the uid as root on 26.04.
- **Per-mount read-only remounts, verified from the kernel's mount table.** `ro=recursive` silently skips submounts. The builder reads `/proc/self/mountinfo` before and after, and the run fails unless every mount outside the declared writable set is read-only. Mount paths are decoded from the kernel's escaped form, never parsed from tool output.
- **The view keeps every path at its real absolute location.** The Action and the agent name the same files by the same paths: checkout, XDG directories, response directory, `GH_CONFIG_DIR`, the log directory. The view is a recursive bind of `/` entered as the new root, so nothing is relocated.
- **Private temp directories are mounted first, then declared roots beneath them are bound back.** A handed-over root under `/tmp` would otherwise be hidden. A root that can't be bound back refuses the launch.
- **The view builder is a bundled Node child, and the server launch stays an exec chain.** The builder runs as root inside the namespace, then exits; a fixed sequencing step then execs into the new root, drops the uid and execs the server. No privileged supervisor outlives the build. This follows the `dist/key-proxy.js` pattern and keeps the mount logic in tested TypeScript. The preflight's install check covers the new bundle.
- **The launch's process group is the handle for privileged teardown.** The runner can't signal root processes, and the uid sweep can't see them. Teardown kills the launch's process group with the privileged tools and confirms it is empty, in addition to the uid sweep.
- **Privileged tools resolve through an immutable chain.** A candidate counts only if its canonical target and every ancestor directory are owned by root and not writable by group, other or any ACL entry. Symlinks are allowed when the whole chain passes, because the image links `sudo` and coreutils. `/usr/local/bin` fails the check, and resolution continues to `/usr/bin`.
- **The Action's own `PATH` is not restricted.** See Scope Boundaries.
- **Delivery 2 reuses the handoff's `readable` grants at the tools' real paths.** `/home/runner` already carries a traverse entry for the agent's user. A tool directory under the home becomes a `readable` root, and its ancestors join the traverse chain, so their other children stay denied. The view makes the grant read-only in effect.
- **The agent's `PATH` is a filtered mirror of the runner's.** Order is kept so the tool a workflow selected wins. The filter is in R12.

---

## Open Questions

### Resolved During Planning

- **Does the view need the account to exist for the preflight probe?** No. The probe checks writes as `nobody`, since account creation can take over a minute and happens later.
- **Does the cache library keep working?** Yes. Its `PATH` is untouched, so compression is unchanged.
- **Are both hosted images supported?** Yes, both passed the measured stages. The preflight probe decides for any other image.

### Deferred to Implementation

- **How the doubled `binfmt_misc` mount becomes read-only or leaves the view.** The verification in U1 fails closed on it. Candidates are remounting by mount ID order or unmounting it inside the private namespace. Acceptance: zero undeclared writable mounts on both images.
- **`chroot` or `pivot_root` to enter the view.** Only `chroot` was measured. The real-runner suite decides, using the `/proc` and descriptor checks in U6.
- **Whether `devpts` and device nodes behave when their mounts are read-only.** PTY allocation and `/dev/null` must work; U6 tests them.
- **Sizes for the private tmpfs mounts.** Bounded; pick values after measuring a real run's temp use.
- **The exact rule for a tool's symlink targets in U9.** The constraint is fixed; the tree-selection rule needs real `pnpm`, `npm` and `corepack` layouts.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

Launch chain under `isolate-agent`:

```text
sudo -n --preserve-env=<names> --
  unshare --mount --propagation private --
    <fixed sequencing step>
      1. node dist/sandbox-view.js <policy>      # root, inside the namespace; exits when done
           read mountinfo
           recursive bind of / onto the new root
           remount every mount read-only, deepest first
           mount private /tmp, /var/tmp, /dev/shm
           bind the declared writable roots back, parents before children
           re-read mountinfo; fail unless every other mount is read-only
      2. exec chroot <new root>
           setpriv --reuid --regid --clear-groups --no-new-privs <drop all caps> --
             env HOME=… PATH=… XDG_*=… --
               opencode serve …
```

Order within a run:

1. Bootstrap preflight: resolve tools through the immutable chain, check the install, run the functional probe.
2. Setup, restore, account creation, ACL handoff, sandbox gitconfig (all unchanged).
3. Launch through the chain above, inside the lifecycle's launch admission.
4. Shutdown: close stdin, kill and confirm the launch's process group, kill and confirm the uid.
5. Take-back, then log snapshot, publication and persistence (unchanged).

---

## Implementation Units

### Delivery 1: the boundary

- [ ] **Unit 1: View policy and builder**

**Goal:** A tested module that turns a declared policy into mount operations and verifies the result, plus the bundled child that runs it.

**Requirements:** R1, R2, R3

**Dependencies:** None

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
- The policy names the new root, the writable roots, and the private temp mounts. It arrives as data, not as shell text.
- The child runs each operation by absolute tool path with a deadline, stops at the first failure, and exits non-zero without output that names secrets.
- Reject a policy whose writable roots are not absolute, not canonical, overlap a protected path, or have a mount beneath them.

**Execution note:** Implement test-first.

**Patterns to follow:**
- `packages/runtime/src/agent/key-proxy.ts` and `key-proxy-child.ts` for the pure-core and thin-child split.
- `apps/action/src/key-proxy.ts` for the bundle entry.

**Test scenarios:**
- Happy path: a mount table with nested mounts yields a recursive bind, then one read-only remount per mount, deepest first, then temp mounts, then writable binds.
- Happy path: verification accepts a table where only the declared roots and temp mounts are writable.
- Edge case: a mount path with an escaped space or newline decodes to the right path and is remounted.
- Edge case: two mounts stacked on one path are both accounted for by mount ID.
- Edge case: a writable root beneath a private temp directory is bound back after that temp mount.
- Error path: verification rejects a table with one undeclared writable mount and names the mount, not its contents.
- Error path: a policy with a relative root, a root containing `..`, a root equal to `/`, or a root with a submount is refused before any operation.
- Error path: the third operation fails; the child runs nothing further and exits non-zero.
- Error path: an operation exceeds its deadline; the child kills it and exits non-zero.

**Verification:**
- The module has no dependency on the Action's `src/` tree.
- `dist/sandbox-view.js` is produced by the build, and two builds give identical output.

- [ ] **Unit 2: Launch chain**

**Goal:** `buildSandboxLaunch` produces the namespace launch when a view policy is present, and the old argv when it isn't.

**Requirements:** R1, R5, R8

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/runtime/src/agent/server-v2.ts`
- Test: `packages/runtime/src/agent/server-v2.sandbox.test.ts`

**Approach:**
- Extend the sandbox launch spec with the view: tool paths for the namespace, the builder bundle and interpreter, and the policy.
- The sequencing step is fixed text that takes every path as a positional argument.
- The server must not start unless the builder exits zero.
- Report the launch's process group to the caller so teardown can address it.

**Patterns to follow:**
- The existing `buildSandboxLaunch` tests, which pin the full argv.

**Test scenarios:**
- Happy path: with a view, the argv is `sudo`, `unshare` with a private mount namespace, the sequencing step, the builder, then the enter-and-drop chain ending in the server.
- Happy path: without a view, the argv is byte-for-byte the current one.
- Edge case: a path containing a space, a quote or a newline reaches the builder and the server as one argument each.
- Edge case: the identity environment (`HOME`, `PATH`, `XDG_*`) is set after the uid drop, as today.
- Error path: the builder exits non-zero; the server binary is never executed.

**Verification:**
- No test for the non-isolated launch changes.

- [ ] **Unit 3: Preflight: immutable tool chain and functional probe**

**Goal:** The run fails before setup unless the tools resolve safely and the view works on this runner.

**Requirements:** R4, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/services/setup/sandbox-preflight.ts`
- Test: `src/services/setup/sandbox-preflight.test.ts`

**Approach:**
- Add the namespace tools to the required list.
- A tool candidate passes only when its canonical target and each ancestor are root-owned and not writable by group, other or an ACL entry. A failing candidate is skipped, and the next directory is tried.
- Require the view bundle in the install check.
- The probe builds a real view over a throwaway fixture, checks one refused write and one allowed write as `nobody`, and confirms the host mount table is unchanged. It has its own short deadline and distinct failure reasons: unsupported, verification failed, privilege failed, timed out.

**Execution note:** Implement test-first.

**Patterns to follow:**
- `checkActionLocation` for the per-component walk.
- `grantsSandboxWrite` in `src/services/setup/sandbox-handoff.ts` for reading ACL write grants.

**Test scenarios:**
- Happy path: a tool present in a mode-777 directory and in a root-only directory resolves to the root-only one.
- Happy path: a tool that is a symlink into a root-only tree passes.
- Edge case: a tool whose directory is root-only but whose parent is writable by other is skipped.
- Edge case: a tool whose directory carries an ACL write entry for another user is skipped.
- Error path: a required tool exists only in a writable directory; preflight fails and names the tool.
- Error path: the view bundle is missing or is a symlink; preflight fails.
- Error path: each probe failure reason produces its own message, and none falls back to the old launch.
- Error path: the probe times out; preflight fails, and nothing is set up.

**Verification:**
- On the measured images, every required tool resolves outside `/usr/local/bin`.

- [ ] **Unit 4: Lifecycle wiring and teardown**

**Goal:** The lifecycle builds the view policy from the handoff manifest, launches through it, and confirms the whole launch is gone before take-back.

**Requirements:** R1, R3, R5, R7, R8

**Dependencies:** Units 1–3

**Files:**
- Modify: `src/harness/phases/sandbox-lifecycle.ts`
- Modify: `packages/runtime/src/agent/sandbox-identity.ts`
- Modify: `src/harness/phases/v2-server.ts`
- Modify: `src/harness/phases/bootstrap.ts`
- Test: `src/harness/phases/sandbox-lifecycle.test.ts`
- Test: `packages/runtime/src/agent/sandbox-identity.test.ts`
- Test: `src/harness/phases/sandbox-signal.test.ts`

**Approach:**
- Writable roots come from the one manifest: the checkout, each handed-over directory, and the account's home. Read-only inputs (attachments, admitted skills) need no entry, because the view shows them at their real paths and the existing ACL grants reading.
- Stop gains a step: kill the launch's process group with the privileged tools and confirm it is empty. A group that can't be confirmed empty means `unsafe`, the account is kept, and take-back does not run.
- A launch that never reached the server still goes through the same stop.
- Signals during the build are owned by the lifecycle, as they are for the rest of the launch.

**Patterns to follow:**
- `stopSandboxProcesses` in `packages/runtime/src/agent/sandbox-identity.ts` for kill-then-verify.
- The existing launch-admission and `timedOut()` handling in the lifecycle.

**Test scenarios:**
- Happy path: the policy lists exactly the checkout, the handed-over directories and the home, with the gh config directory only in provision mode.
- Happy path: release kills and confirms the process group, then the uid, then takes back.
- Edge case: a handed-over root under `/tmp` appears in the policy after the private temp mount.
- Edge case: the launch failed before the uid drop; release still confirms the group and rolls the handoff back.
- Error path: the group is still populated after the kill; the result is `unsafe`, no take-back, account kept.
- Error path: the group kill times out; the result is `unsafe`.
- Error path: a writable root has a mount beneath it; the launch is refused before the server starts, and the handoff is rolled back.
- Integration: a signal arriving during the build ends with the group confirmed empty and no server started.
- Integration: with `isolate-agent` off, no view policy is built and no new command runs.

**Verification:**
- Every path that ends `restored` has confirmed both the process group and the uid.

- [ ] **Unit 5: Trusted git by absolute path**

**Goal:** Runner-side trusted git no longer looks `git` up through a directory the image leaves writable.

**Requirements:** R6, R8

**Dependencies:** Unit 3

**Files:**
- Modify: `src/features/delegated/trusted-git.ts`
- Modify: `src/features/delegated/reconstruct-changes.ts`
- Modify: `src/features/delegated/commit-message.ts`
- Test: `src/features/delegated/trusted-git.test.ts`

**Approach:**
- Under isolation, pass the preflight-resolved `git` path into both execution paths of the wrapper, and build the wrapper's `PATH` from the directories that passed the immutable-chain check.
- Without isolation, the wrapper is unchanged.

**Test scenarios:**
- Happy path: under isolation, both execution paths run the absolute `git`, and the child `PATH` has no writable directory.
- Happy path: without isolation, the command and environment equal today's.
- Error path: isolation is on but no resolved `git` was supplied; the call fails instead of falling back to a name lookup.

**Verification:**
- No caller of the wrapper can reach a bare `git` under isolation.

- [ ] **Unit 6: Real-runner suite on both images**

**Goal:** The boundary is proven on real hosted runners for Ubuntu 24.04 and 26.04.

**Requirements:** R1, R2, R3, R5, R7

**Dependencies:** Units 1–5

**Files:**
- Modify: `src/harness/phases/v2-server.sandbox.integration.test.ts`
- Modify: `src/harness/phases/v2-server.sandbox.harness.ts`
- Modify: `.github/workflows/ci.yaml`

**Approach:**
- Add a write matrix as blocked probes, each with a runner-side control: create, append, rename and unlink in every runner `PATH` directory, `/opt`, `/usr/share`, the tool cache root and one subdirectory, and a disposable mode-777 file placed before launch.
- Add works probes: writes in each R1 location, `/dev/null`, randomness, a PTY, and shared memory.
- Add escape probes: a symlink from the checkout into a sealed directory, a hardlink to a sealed file, `/proc/<runner pid>/root`, inherited descriptors, a remount attempt, a user-namespace attempt.
- After the run, from the runner: disposable sentinels are unchanged, the private temp files are absent, and the host mount table equals the one before.
- Keep the existing suites passing through the view: key proxy, `gh` credential helper, hostile git state, persistence round trip, log snapshot.
- Run the job on `ubuntu-24.04` and `ubuntu-26.04`. The workflow edit needs the owner's approval before it is pushed.

**Test scenarios:**
- Happy path: every write-matrix probe is blocked for the agent and allowed for the runner control.
- Happy path: every R1 location accepts a write from the agent.
- Edge case: a write through a checkout symlink into `/usr/local/bin` is blocked.
- Edge case: a hardlink from the checkout to a sealed file can't be created, or can't be written through.
- Error path: the agent can't read or enter `/proc/<runner pid>/root`.
- Error path: remount and user-namespace attempts fail.
- Integration: a second isolated run in the same job starts clean and finds nothing from the first outside R1 locations.
- Integration: the server starts, becomes ready, runs a tool call and shuts down through the view on both images.

**Verification:**
- Both matrix legs pass, and no probe is skipped.

- [ ] **Unit 7: Docs for delivery 1**

**Goal:** The docs describe the boundary as built.

**Requirements:** R9

**Dependencies:** Unit 6

**Files:**
- Modify: `docs/wiki/Setup and Configuration.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `action.yaml`

**Approach:**
- Replace the "Known limit, shared writable directories" paragraph with what the agent can write, what is read-only, and what stays out of scope: the checkout is still agent-written, read-only mounts don't stop socket or device access, and the network is shared.
- Add the namespace tools to the Requirements list and the view to the launch description.
- Restore the "when to turn it on" guidance for write-capable tokens.

**Test expectation:** none -- documentation only.

**Verification:**
- No doc still says the agent can write to shared directories.

### Delivery 2: toolchains

- [ ] **Unit 8: The agent's PATH**

**Goal:** The agent's `PATH` mirrors the runner's, filtered.

**Requirements:** R10, R12

**Dependencies:** Delivery 1

**Files:**
- Create: `src/services/setup/sandbox-toolchain-path.ts`
- Modify: `src/harness/phases/sandbox-lifecycle.ts`
- Modify: `packages/runtime/src/agent/server-v2.ts`
- Test: `src/services/setup/sandbox-toolchain-path.test.ts`
- Test: `packages/runtime/src/agent/server-v2.sandbox.test.ts`

**Approach:**
- Read the runner's `PATH` as the Action sees it at bootstrap.
- Drop, with a warning that names the entry: empty and relative entries, entries that don't exist or aren't directories, and entries equal to, inside or containing the checkout, `RUNNER_TEMP`, the `_actions` directory, or the runner home itself.
- Keep order and remove duplicates. Always include the system directories at the end.
- Entries inside the runner home are kept only when Unit 9 can grant them.

**Execution note:** Implement test-first.

**Test scenarios:**
- Happy path: tool-cache and system entries are kept in order.
- Edge case: `a::b`, a leading or trailing colon, and `./bin` are dropped.
- Edge case: a literal `~/.bun/bin` is treated as relative and dropped.
- Edge case: a duplicate entry appears once, at its first position.
- Error path: `/home/runner`, `/home` and `/` are dropped and never granted.
- Error path: `<checkout>/node_modules/.bin` and an entry under `RUNNER_TEMP` are dropped.
- Error path: an entry that is a symlink is resolved component by component, and the resolved directory is judged by the same rules.

**Verification:**
- The agent's `PATH` never contains a directory the agent can write.

- [ ] **Unit 9: Tool directories under the runner home**

**Goal:** `bun`, `pnpm` and similar tools under the runner home run for the agent, and nothing else under the home becomes readable.

**Requirements:** R10, R11

**Dependencies:** Unit 8

**Files:**
- Modify: `src/services/setup/sandbox-handoff.ts`
- Modify: `src/harness/phases/sandbox-lifecycle.ts`
- Modify: `src/harness/phases/v2-server.sandbox.integration.test.ts`
- Modify: `docs/wiki/Setup and Configuration.md`
- Test: `src/services/setup/sandbox-handoff.test.ts`
- Test: `src/harness/phases/sandbox-lifecycle.test.ts`

**Approach:**
- A kept `PATH` entry under the runner home becomes a `readable` root. Its ancestors join the traverse chain, so their other children stay denied.
- When an entry in that directory is a symlink to a tree outside it, that tree becomes a `readable` root too. The tree must lie strictly inside the runner home, share a parent chain with the `PATH` directory, and stay under a size and count bound. Otherwise the `PATH` entry is dropped with a warning.
- Add the new roots to every place the handoff enumerates roots: the reserved-subtree check, root verification, and lock planning.
- Take-back removes the grants through the existing per-uid removal.

**Patterns to follow:**
- The `readable` handling for attachments and admitted skills in `src/services/setup/sandbox-handoff.ts`.

**Test scenarios:**
- Happy path: `~/.bun/bin` becomes a readable root; `~/.bun` gains traverse; its other children are denied.
- Happy path: a `.bin` directory whose links point into a sibling package tree grants that tree.
- Edge case: `~/.cargo/bin` is granted and `~/.cargo/credentials.toml` stays denied.
- Edge case: a link target outside the runner home needs no grant and adds no root.
- Error path: a link target that resolves to the runner home or above drops the `PATH` entry.
- Error path: a target tree over the bound drops the `PATH` entry with a warning.
- Error path: a new root that overlaps `_actions` is refused.
- Integration (real runner): `bun --version`, `pnpm --version`, `uv --version` and the pinned `node --version` run in the agent's shell, installed the way callers install them.
- Integration (real runner): a package install with `bun` and with `pnpm` succeeds in the checkout and writes its cache under the agent's home.
- Integration (real runner): a canary file next to a granted tool directory stays unreadable, and the tool binary can't be modified.
- Integration: after take-back, the granted directories carry no entry for the agent's uid.

**Verification:**
- A caller workflow that installs `bun` or `pnpm` the usual way needs no change beyond `isolate-agent: true`.

---

## System-Wide Impact

- **Interaction graph:** The launch argv, the preflight, the lifecycle's stop, and the trusted git wrapper change. The key proxy, cache restore and save, finalize and the post hook don't.
- **Error propagation:** A view failure at preflight fails the run before setup. A view failure at launch never starts the server, rolls the handoff back, and saves nothing. An unconfirmed stop records `unsafe`, which already withholds publication, persistence and uploads.
- **State lifecycle risks:** The private temp mounts and the new root vanish when the last process of the namespace exits, which is why teardown must confirm the process group. The handoff journal is unchanged.
- **API surface parity:** No new input. The supported-runner requirements gain the namespace tools.
- **Integration coverage:** Kernel enforcement, process exit and mount behavior are provable only by the real-runner job. Unit tests cover argv, ordering, failure branches and state writes.
- **Unchanged invariants:** `isolate-agent` off; the stop → take-back → checkpoint order; restore and save path lists; the checkout stays agent-writable and untrusted for later steps.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A hosted image update changes mount behavior | The preflight probe fails the run before setup, and the real-runner job runs on both images on every PR. |
| A privileged part of the launch outlives the run | Teardown kills and confirms the launch's process group; unconfirmed means `unsafe`. |
| A tool the agent needs writes outside its home | Its home and the temp directories are writable; U6 and U9 exercise real installs. Remaining cases surface as read-only errors, not silent damage. |
| A hardlink or open descriptor aliases a sealed file into a writable root | U6 tests both. A pre-existing dangerous alias is rejected at handoff. |
| The stacked `binfmt_misc` mount can't be made read-only | Verification fails closed; unmounting it inside the private namespace is the fallback. |
| The view breaks PTYs or device access | U6 tests both on both images before the PR merges. |
| Delivery 2 exposes a secret next to a tool directory | Only the `PATH` directory and bounded link-target trees are granted; siblings stay denied; U9 tests a canary. |

---

## Documentation / Operational Notes

- Delivery 1 is a `fix`. Delivery 2 is a `feat`. Each is one PR.
- After delivery 1 ships, repeat the published-install live check with a write attempt into `/usr/local/bin` from the agent's shell.
- The `Sandbox integration` job stays a PR check and does not gate the release job.

---

## Sources & References

- Related code: `packages/runtime/src/agent/server-v2.ts`, `src/harness/phases/sandbox-lifecycle.ts`, `src/services/setup/sandbox-handoff.ts`, `src/services/setup/sandbox-preflight.ts`, `src/features/delegated/trusted-git.ts`
- Related past work: `docs/plans/2026-11-10-001-feat-isolate-agent-uid-plan.md`, recorded active. That plan built the uid split and the home ACLs; this plan adds write confinement outside the home.
- Related past work: `docs/plans/2026-11-13-001-feat-isolate-agent-key-proxy-plan.md`, recorded active. Unchanged by this plan.
- Related past work: `docs/brainstorms/2026-11-14-isolate-agent-opt-in-rollout-requirements.md`. The rollout it describes waits for both deliveries here.
- Related PRs/issues: #2135, #2168, #2201, #2202
