---
title: "feat: Run the agent under its own user on GitHub-hosted Linux"
type: feat
status: active
date: 2026-11-10
---

# feat: Run the agent under its own user on GitHub-hosted Linux

## Overview

A new opt-in input, `isolate-agent`, starts the OpenCode V2 server, and every model tool and shell under it, as a dedicated unprivileged local user on GitHub-hosted Linux runners. The model can no longer read:
- the Action's process environment, which holds the workflow token;
- the workflow command files;
- runner-private directories and the runner's home;
- sudo or the docker socket.

The Action's own work after the model step never runs git configuration the model wrote. It never follows a link the model planted.

This is Phase 3 of #2135:
- Phase 0 proved the leak.
- Phase 1 documented it (#2145).
- Phase 2 researched and spiked the fix (run 42891132483).
- Phase 4, a second uid for tools, is future work.

## Problem Frame

Today the model runs as `runner` (uid 1001), the same user as the Action. On Linux, a same-uid process can read `/proc/<pid>/environ` of the Action's node process. That environment holds `INPUT_GITHUB-TOKEN` even after `delete process.env[...]`, and `ptrace_scope=1` doesn't stop it. Credential withholding (`response-delivery.ts`) keeps the token out of the model's env and `gh` config, but it isn't an OS boundary.

The spike showed that a separate uid closes that path on stock runners. It used a `sudo -n … setpriv --reuid --regid --clear-groups --no-new-privs` launch and a short list of permission changes. The spike also found three things uid separation doesn't fix on its own:
- The model can replace the checkout's `.git/config`. A later runner-side git call can then run model code as `runner` (fsmonitor, textconv).
- Background processes outlive a graceful server shutdown.
- Anything the runner later reads from a path the model could write may be a link to a runner secret. Examples are the response file and the stored session data.

## Requirements Trace

- R1. With `isolate-agent: true`, the OpenCode V2 server and every descendant run as an unprivileged user. That user has no supplementary groups, no capabilities and `no_new_privs`.
- R2. From the model's shell, these are unreadable:
  - The Action's process environment, meaning `/proc/<pid>/environ` of the Action and its ancestors.
  - `$GITHUB_ENV`, `$GITHUB_OUTPUT` and the other command files.
  - Runner-private directories under `RUNNER_TEMP`.
  - Every entry of the runner's home except the paths the sandbox is explicitly granted.
  - sudo and the docker socket.
- R3. The model keeps what it needs:
  - Read and write on the checkout.
  - `git status`/`add`/`commit` with a commit identity.
  - node, git and rg.
  - Its provider.
  - Admitted repo skills.
  - In provision mode, the `gh` authentication the trigger already grants.
- R4. After the model step, runner-side git runs only against git config, `info/` and hooks restored from a pre-model copy. It never runs against the versions the model left.
- R5. Before any runner-side read of model output, every process of the sandbox user has been killed and verified gone. The same holds before any checkpoint, cache save or ownership change. If this can't be confirmed, the run fails and publication and persistence are declined.
- R6. Every runner-side read of a path the sandbox could write refuses symlinks and non-regular files. That covers the response file and its candidates, attachments, and stored session data that is uploaded.
- R7. Session persistence works unchanged when isolation succeeds. Restore and save use identical path lists, so the cache version doesn't change.
- R8. With `isolate-agent: true` on an unsupported runner, the run fails before setup with an actionable message. These count as unsupported:
  - Not GitHub-hosted, or not Linux.
  - Running as root or in a container job.
  - No passwordless sudo.
  - Any of `setpriv`, `setfacl`, `useradd`, `userdel`, `pkill`, `pgrep` or `find` missing.
  - `fs.protected_hardlinks` or `fs.protected_symlinks` off.
- R9. When `isolate-agent` is unset, behavior is unchanged.
- R10. The post hook never retries a session save for an isolated run.

## Scope Boundaries

- The provider key file and `OPENCODE_PASSWORD` stay readable by the model's shell. The server and its tools share the sandbox uid, and the key belongs to the model's own provider. Phase 4 isolates them.
- Self-hosted, macOS, Windows and container-job runners aren't supported, and they fail closed when the input is set. A self-hosted runner that reports `RUNNER_ENVIRONMENT=github-hosted` is unsupported.
- Two isolated fro-bot steps running at the same time in one job aren't supported. The second fails at account creation.
- This isn't a VM boundary. Prompt data, the checkout and any credential the trigger deliberately provisions stay visible to the model.
- The default stays off. No nudge is logged when the input is unset.

### Deferred to Separate Tasks

- `GH_TOKEN` exported to later steps via `$GITHUB_ENV`: #2156.
- Provisioning the credential only on allowlisted triggers: #2157.
- Phase 4, a separate tool uid so the provider key and server password are hidden: a future #2135 phase.
- Flipping the default to on, and any warning that nudges callers toward it: a later PR, after `isolate-agent` has soaked on fro-bot/agent's own runs.

## Context & Research

### Relevant Code and Patterns

- **Spawn seam.** `startOpenCodeV2Server` in `packages/runtime/src/agent/server-v2.ts` takes `uid`/`gid` options and passes them straight to Node `spawn`. That needs root, so it works for the workspace supervisor but gets EPERM for `runner`. The Action entry is `startActionOpenCodeV2` in `src/harness/phases/v2-server.ts`, which passes no identity today.
- **Child env.** `filterAgentEnv` (`packages/runtime/src/agent/filter-env.ts`) is applied inside the spawn. The workspace's `buildOpencodeV2Env` (`apps/workspace-agent/src/opencode-server-v2.ts`) rewrites `HOME`/`USER`/`TMPDIR` and sets every XDG path explicitly for a different user.
- **Privilege-drop precedent.** `deploy/workspace-entrypoint.sh` uses `setpriv --reuid --regid --clear-groups`. `deploy/scripts/install-opencode-v2-plugins.sh` has an overridable `DROP_PRIVILEGES` seam that makes the drop testable without root.
- **Hardened-git precedent.** `makeGitSubprocess` in `packages/harness/src/integrate.ts` uses a `core.hooksPath` temp dir and an empty credential helper and askpass.
- **Runner-side git after the model step.** There are two calls in `src/features/delegated/reconstruct-changes.ts` and two in `src/features/delegated/commit-message.ts`. All four run in the checkout and read its local config. Reconstruction uses `getExecOutput` with no timeout. Brokered push writes only through the Git Data API (`commit.ts`).
- **Runner-side reads of model output.** The response file and fallback candidates are read in `response-post.ts` and `response-file.ts` with `fs.readFile`, which follows links. Reconstruction already reads worktree bytes with `O_NOFOLLOW`.
- **Lifecycle order** (`src/harness/run.ts`):
  1. Bootstrap, which creates the response dir.
  2. Repo-skills staging.
  3. Cache restore and DB repair.
  4. Credential files, plugins and config (`startActionOpenCodeV2`).
  5. Spawn.
  6. Execute.
  7. Release: prune while the server is live, then shut down.
  8. Finalize: read the response, brokered push.
  9. Cleanup: checkpoint, save.

  Finalize runs before cleanup, so take-back has to happen between release and finalize.
- **Post hook.** `src/harness/post.ts` retries a save when the main step didn't persist and didn't decline for safety.
- **Input plumbing.** `repo-skills` is the template. It touches `action.yaml`, the strict parser in `src/harness/config/inputs.ts`, the type in `packages/runtime/src/shared/types.ts`, the README table, the wiki Setup page, and the action.yaml-default test in `inputs.test.ts`.
- **Real-binary tests.** `src/harness/phases/v2-server.integration.test.ts` is gated on `FRO_BOT_OPENCODE_V2_BIN`, and no CI job sets that today. `test-action` in `.github/workflows/ci.yaml` runs the local Action, the self-review, on ubuntu-latest.

### Institutional Learnings

- **Repair before capture** (`docs/solutions/logic-errors/repair-before-capture-sqlite-session-cache-loop-2026-09-02.md`). Stop writers before checkpointing, and keep the restore and save path lists identical.
- **Sequential steps are not a security boundary** (`docs/solutions/best-practices/same-job-phase-split-not-a-security-boundary-2026-07-04.md`). Later runner-side work must not consume agent-controlled git config, hooks, `GITHUB_ENV` or PATH.
- **Workspace provisioning** (`docs/solutions/best-practices/workspace-executor-opencode-provisioning-best-practices-2026-06-01.md`). A 0600 key file stays readable by same-uid tools. This is the accepted residual.

### External References

- openai/codex-action's `unprivileged-user` mode uses `sudo -u` with `setpriv`. It's prior art for the drop, not for the git or persistence handling.
- The spike evidence is in the #2135 comment for run 42891132483 (Ubuntu 26.04, sudo-rs 0.2.13, util-linux 2.41.3).

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "packages/runtime/src/agent, src/harness/phases, src/services/setup, src/features/delegated, deploy/scripts, deploy/workspace-entrypoint.sh, apps/workspace-agent/src",
  "freshness": {
    "vcs_reference": "3ff4d80b9"
  },
  "budget": {
    "max_search_passes": 20,
    "max_candidate_inspections": 60,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "packages/runtime/src/agent/server-v2.ts startOpenCodeV2Server uid/gid",
      "description": "Passes uid/gid to Node spawn; used by the root workspace supervisor",
      "disposition": "extend",
      "insufficiency_reason": "Node spawn with a uid needs root or CAP_SETUID; the Action runs as runner"
    },
    {
      "path_or_symbol": "deploy/workspace-entrypoint.sh setpriv drop and deploy/scripts/install-opencode-v2-plugins.sh DROP_PRIVILEGES",
      "description": "The repo's setpriv flag set and a testable privilege-drop seam",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "apps/workspace-agent/src/opencode-server-v2.ts buildOpencodeV2Env",
      "description": "Explicit child env for a different user (HOME, USER, TMPDIR, XDG)",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/harness/src/integrate.ts makeGitSubprocess",
      "description": "Git subprocess with hooks, credential helper and askpass disabled",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "apps/workspace-agent/src/handoff.ts",
      "description": "Root-side no-follow lchown walk for agent-owned trees",
      "disposition": "insufficient",
      "insufficiency_reason": "Uses lchown in-process as root; the Action is non-root and must go through sudo"
    }
  ]
}
```

## Key Technical Decisions

- **Launch.** The server starts through `sudo -n --preserve-env=<names> -- setpriv --reuid=<uid> --regid=<gid> --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all --ambient-caps=-all -- <opencode> serve --stdio …`, with absolute paths.
  - `setpriv` has to run as root to drop groups.
  - sudo-rs ignores `-E`, so the env is passed by name list, and values never appear in argv.
  - This is a new spawn mode on the runtime seam, chosen when the caller isn't root. The existing in-process `uid`/`gid` stays for the root workspace supervisor.
- **One sandbox account, with a deterministic name, created per run and deleted at the end.** Creation is refused if the account or its uid already exists, and an existing account is never adopted. That makes "every process of this uid" mean this run's sandbox and nothing else. Matrix jobs run on separate VMs, so they need nothing extra.
- **Child env.** `HOME`, `USER`, `LOGNAME` and `TMPDIR` point at the sandbox. `PATH` is fixed. The four XDG paths (data, config, cache, state) are resolved from the runner's environment before `HOME` changes and passed as absolute values. That keeps the restored DB, plugins and config where restore and save expect them, so R7 holds.
- **Quiescence.** After the graceful shutdown, `pkill -KILL -u <uid>` and `pgrep -u <uid>` alternate until `pgrep` is empty or a bound expires. Because the uid is per run, this catches `setsid`, double-fork and signal-ignoring descendants without any process-tree tracking. If the bound expires, the outcome is `unconfirmed`. The run then fails, and persistence and publication are declined.
- **One manifest drives handoff and take-back.** It lists:
  - The checkout (via ACL).
  - The four OpenCode XDG dirs, the key file dir, the response dir and the attachment dir (handed over).
  - The repo-skills staging root and admitted tree (traverse and read only).
  - Traverse-only grants on each ancestor.

  The manifest records each path's original mode and ACL.
- **Take-back.** Take-back runs between release and finalize, and only after `stopped`. For each root it runs `find -P <root> -xdev -user <sandbox uid> -exec chown -h runner:runner {} +`. It then removes the sandbox ACL entries with `setfacl -P` and restores the recorded modes and ACLs.
  - Only inodes the sandbox owns change. A hardlink to a runner-owned file is never touched, and `-P`/`-h` never follow a link.
  - Before both handoff and take-back, each root and every ancestor must:
    - not be a symlink;
    - be owned by runner or root;
    - have no sandbox write grant.

    Any violation makes the outcome `unsafe`.
- **Runner-private surfaces are default-deny.**
  - Every top-level entry of the runner home gets a sandbox deny ACL, except the traverse chain and the manifest roots.
  - `_runner_file_commands` and `RUNNER_TEMP` go to 0700, with traverse granted only where a manifest path needs it.
  - Original modes and ACLs are restored at take-back.
  - The spike found that uid separation alone leaves `GITHUB_ENV` world-readable and `~/.docker/config.json` reachable.
- **Trusted git metadata is restored in place, on isolated runs only.**
  - Before handoff, the Action copies `.git/config`, `.git/config.worktree`, `.git/hooks/` and `.git/info/` into a runner-private 0700 dir. These are small files.
  - At take-back, it first checks that `.git` is a real directory, not a symlink and not a gitfile; otherwise the outcome is `unsafe`. It then writes the copies back over whatever the model left and deletes any new `config.worktree`.
  - The existing post-model git calls then run against trusted config and the model's index, refs and objects, which are read as data. Each call has `-c core.fsmonitor=false -c core.hooksPath=/dev/null`, `--no-textconv --no-ext-diff`, `--ignore-submodules=all`, a pinned `PATH`, and a subprocess killed on timeout.
  - Later workflow steps also inherit the trusted config.
  - Non-isolated runs are unchanged (R9). The model there is same-uid and could rewrite any copy anyway.
- **No-follow reads.** Every runner-side read of sandbox-writable output opens with `O_NOFOLLOW` and `fstat`s the handle. It requires a regular file and enforces a size bound. That covers the response file and candidates, attachments, and the stored session data the object-store upload reads. The DB checkpoint opens a regular file that was verified the same way.
- **Provision mode.** The `gh` hosts entry the trigger provisions is written into the sandbox's config dir. The sandbox's gitconfig gets `safe.directory` for the checkout and the same `user.name`/`user.email` that setup configures for the runner. The trigger classification is unchanged; #2157 owns that.
- **Post hook.** For an isolated run, the post hook never retries a save. It logs and declines. It doesn't kill or delete anything, because the main step's `finally` stops and takes back on exceptions and cancellation, and the hosted VM is torn down after the job.
- **Preflight.** The preflight runs at the top of bootstrap, before setup, so a failed check leaves nothing to undo. It checks every item in R8, resolving tool paths to absolute paths. It trusts `RUNNER_ENVIRONMENT`.

## Open Questions

### Resolved During Planning

- **Rollout:** an opt-in input first, with the default flipped later. No warning when the input is unset (Marcus).
- **Unsupported runners:** fail closed when the input is set (Marcus).
- **Trusted git:** in scope, restored in place on isolated runs (Marcus, document review).
- **Where take-back goes:** between release and finalize, because finalize reads model output before cleanup runs (flow analysis).
- **Account lifetime:** one deterministic account per run, refused if it already exists. Concurrent isolated steps in one job are unsupported (document review).
- **Post-hook recovery:** decline only, for isolated runs (document review).

### Deferred to Implementation

- Whether a clean filter named in the worktree's `.gitattributes` can still run once config is restored. Expected no, because drivers are defined only in config. A positive-control fixture proves it.
- The exact `PATH` value pinned for runner-side git.
- Whether the object-store upload reads files itself or archives them, which decides where its no-follow check sits.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
sequenceDiagram
  participant A as Action (runner)
  participant S as sudo/setpriv (root)
  participant O as opencode serve (sandbox uid)
  A->>A: preflight (fail closed before setup)
  A->>A: setup, restore, credential files, copy .git metadata
  A->>S: create account; manifest grants + default-deny locks (recorded)
  A->>S: launch with --preserve-env names
  S->>O: drop to sandbox uid
  A->>O: execute, release (prune, shutdown)
  A->>S: pkill/pgrep loop until empty
  A->>S: verify roots; chown sandbox-owned inodes back; restore .git metadata, modes, ACLs; userdel
  A->>A: finalize (no-follow response read; brokered push via hardened git)
  A->>A: cleanup (checkpoint, save)
```

## Implementation Units

- [x] **Unit 1: `isolate-agent` input and fail-closed preflight**

**Goal:** Parse the input strictly. When it's on, check the runner before any setup.

**Requirements:** R8, R9

**Dependencies:** None

**Files:**
- Modify: `action.yaml`, `src/harness/config/inputs.ts`, `packages/runtime/src/shared/types.ts`, `src/harness/phases/bootstrap.ts`
- Create: `src/services/setup/sandbox-preflight.ts`
- Test: `src/harness/config/inputs.test.ts`, `src/services/setup/sandbox-preflight.test.ts`, `src/harness/phases/bootstrap.test.ts`, and the input fixtures `tsc` flags

**Approach:**
- Follow the strict parser pattern of `parseRepoSkills`.
- The preflight takes an injected exec adapter and env, and returns a typed result that names the first failed check.
- Bootstrap calls it before `ensureOpenCodeAvailable` and before creating the response dir.

**Patterns to follow:**
- `parseRepoSkills` and the action.yaml-default test in `inputs.test.ts`.

**Test scenarios:**
- Happy path: input on and every check passes. The preflight returns ok with resolved absolute tool paths.
- Error path: each failing check makes bootstrap stop before setup, with an error that names the check. Setup, the response dir and the server never run. The checks are:
  - `RUNNER_ENVIRONMENT=self-hosted`
  - `RUNNER_OS=macOS`
  - uid 0
  - a container job
  - `sudo -n` exits 1
  - `setpriv` missing
  - `protected_hardlinks=0`
- Edge case: `isolate-agent: yes` fails parsing. Unset and `false` both mean off.
- Happy path: with input off, no preflight runs and nothing new is logged.

**Verification:**
- With input off, existing tests pass unchanged. The new tests fail if the preflight call is removed.

- [x] **Unit 2: Sandbox account and the sudo/setpriv launch seam**

**Goal:** Create the sandbox account, launch the server as it, then stop it and remove it with verified quiescence.

**Requirements:** R1, R5, R7

**Dependencies:** Unit 1

**Files:**
- Create: `packages/runtime/src/agent/sandbox-identity.ts`. It creates the account, runs the kill loop, verifies and deletes, behind an injected `PrivilegedExec` so it can be tested without root.
- Modify: `packages/runtime/src/agent/server-v2.ts`. Add a launch mode that wraps the spawn in `sudo -n --preserve-env=<names> -- setpriv …`. The child gets sandbox `HOME`/`USER`/`LOGNAME`/`TMPDIR`, a fixed `PATH`, and explicit absolute XDG paths resolved from the runner env. Secrets stay out of argv.
- Modify: `src/harness/phases/v2-server.ts` to pass the identity when isolation is on.
- Test: `packages/runtime/src/agent/sandbox-identity.test.ts`, `packages/runtime/src/agent/server-v2.test.ts`

**Approach:**
- The account is a system account with no supplementary groups and a fresh 0700 home. Creation is refused if it already exists.
- Stop is graceful shutdown, then the `pkill`/`pgrep` loop under a bound. The result is a discriminated outcome: `stopped` or `unconfirmed`. `userdel -r` runs only on `stopped`.
- The spike showed `runner` can't signal the sandbox uid, so every stop path goes through the privileged kill.

**Patterns to follow:**
- The `setpriv` flags in `deploy/workspace-entrypoint.sh`, the `DROP_PRIVILEGES` seam, and `buildOpencodeV2Env` for the child env.

**Test scenarios:**
- Happy path (fake exec):
  - The launch argv carries the exact setpriv flags.
  - The `--preserve-env` list includes `OPENCODE_PASSWORD` and `OPENCODE_CONFIG_CONTENT`, and no values appear in argv.
  - The child env sets all four XDG paths to the runner-resolved absolute values.
- Error path: an existing account refuses creation and nothing is deleted.
- Error path: `pgrep` still non-empty after the bound returns `unconfirmed`, and `userdel` is not called.
- Edge case: a process that reappears between `pkill` and `pgrep` gets killed by the next pass.

**Verification:**
- The unit tests fail with the kill loop removed. Real-runner behavior is covered by the Unit 6 suite.

- [x] **Unit 3: Manifest, handoff, default-deny locks and take-back**

**Goal:** Give the sandbox exactly the access it needs, deny everything else runner-private, and restore all of it once the sandbox is verified dead.

**Requirements:** R2, R3, R4, R5, R7

**Dependencies:** Unit 2

**Files:**
- Create: `src/services/setup/sandbox-handoff.ts`. It holds the manifest, the root and ancestor checks, `handOff`, `takeBack`, and the `.git` metadata copy and restore.
- Modify: `src/harness/phases/v2-server.ts`. Run handoff after credential files and repo-skills admission, before launch. Modify the attachment-dir creation site so the dir is granted at creation.
- Modify: `src/services/setup/gh-auth.ts`. In provision mode with isolation, write the `gh` hosts entry and the git identity into the sandbox's config.
- Test: `src/services/setup/sandbox-handoff.test.ts`

**Approach:**
- Handoff runs these steps in order:
  1. Verify roots and ancestors.
  2. Copy `.git` metadata.
  3. Record modes and ACLs.
  4. Apply the default-deny locks.
  5. Grant the checkout `u:<uid>:rwX` recursively, with default ACLs for both users.
  6. Hand over the manifest dirs.
  7. Write the sandbox gitconfig (`safe.directory`, identity).
- A failure partway through rolls back what was recorded and fails the run before launch.
- Take-back runs only on `stopped`, in this order:
  1. Verify roots, ancestors and that `.git` is a real directory.
  2. `find -P -xdev -user <uid> -exec chown -h` per root.
  3. Restore the `.git` metadata copies.
  4. Remove sandbox ACL entries and restore recorded modes and ACLs.
  5. `userdel`.
- Any failure returns `unsafe`.

**Execution note:** Write the Unit 6 blocked/works suite first, then make this unit pass it.

**Test scenarios:**
- Happy path (fake exec): the handoff argv covers every manifest path. Take-back reverses exactly what handoff recorded.
- Error path: an injected failure after the third handoff step rolls back the first two and fails before launch.
- Error path: a root ancestor that is a symlink, or not owned by runner, fails handoff, and fails take-back as `unsafe`.
- Error path: a take-back step fails, and the outcome is `unsafe`.

**Verification:**
- Unit tests pass. Real-runner behavior is covered by the Unit 6 suite.

- [x] **Unit 4: Lifecycle wiring, no-follow reads and post-hook safety**

**Goal:**
- Put stop and take-back between release and finalize.
- Make every exit path stop the sandbox first.
- Make runner reads of sandbox output refuse links.
- Gate publication and persistence on a confirmed restore.

**Requirements:** R5, R6, R7, R10

**Dependencies:** Units 2 and 3

**Files:**
- Modify: `src/harness/run.ts`, `src/harness/phases/release-v2.ts`, `src/harness/phases/cleanup.ts`, `src/harness/post.ts`, `src/harness/config/state-keys.ts`
- Modify: `packages/runtime/src/agent/response-file.ts`, `src/features/comments/response-post.ts` (or wherever the response read lives), the attachment reader, and the object-store upload path
- Test: `src/harness/run-v2.test.ts`, `src/harness/post.test.ts`, `src/harness/run-post-handoff.test.ts`, `packages/runtime/src/agent/response-file.test.ts`

**Approach:**
- After release, the run stops the sandbox, takes back and records the outcome.
  - On `stopped` + `restored`, finalize proceeds.
  - On `unconfirmed` or `unsafe`, it records a safety decline, skips finalize's response read and brokered push, skips checkpoint and save, and fails with a named reason.
- `run.ts`'s `finally` runs stop and take-back first whenever an account exists and isn't restored yet.
- The post hook declines any save for an isolated run.
- A no-follow reader (`O_NOFOLLOW`, `fstat` regular file, size bound) replaces `fs.readFile` for sandbox-writable output. It's used on every run, not only isolated ones.

**Patterns to follow:**
- `O_NOFOLLOW` reads in `src/features/delegated/reconstruct-changes.ts`.
- The existing `declined-for-safety` handling in `post.ts`.
- The run→post handoff test from #2152.

**Test scenarios:**
- Happy path: an isolated run reaches finalize only after `restored`. Cleanup checkpoints and saves once.
- Error path: `unconfirmed` at stop means:
  - no response read;
  - no brokered push;
  - no checkpoint and no save;
  - the run fails;
  - the post hook doesn't save.
- Error path: an exception mid-execution makes the `finally` path stop and take back before cleanup.
- Error path: the response file is a symlink to a runner-owned sentinel. Finalize refuses it, and the sentinel's content is never read or posted. A FIFO or directory there is refused too.
- Happy path: with isolation off, the state handoff and save are unchanged, and a regular response file is read as today.

**Verification:**
- Revert-checks: removing the finalize gate, the post-hook decline or the no-follow read each fails a test.

- [x] **Unit 5: Hardened runner-side git**

**Goal:** Make reconstruction and the commit-message lookup safe against the model's git state once take-back has restored trusted metadata.

**Requirements:** R4

**Dependencies:** Unit 3, for the metadata restore. The flag hardening is independent.

**Files:**
- Create: `src/features/delegated/trusted-git.ts`, which owns the argv, env and timeout-kill wrapper.
- Modify: `src/features/delegated/reconstruct-changes.ts`, `src/features/delegated/commit-message.ts`
- Test: `src/features/delegated/trusted-git.test.ts`, `src/features/delegated/reconstruct-changes.test.ts`, `src/features/delegated/commit-message.test.ts`

**Approach:**
- Every post-model call goes through one wrapper. The wrapper adds `-c core.fsmonitor=false -c core.hooksPath=/dev/null`, `--no-textconv --no-ext-diff` where they apply, `--ignore-submodules=all`, a pinned `PATH` in `GIT_ENV`, and a timeout that kills the process group.
- On isolated runs, this runs after the `.git` metadata restore. On non-isolated runs, the call sites get the same wrapper and otherwise work as today.

**Execution note:** Write the adversarial fixtures first. Each one needs a positive control that fires without the fix.

**Test scenarios:**
- Error path: the model rewrites `.git/config` (via rename) with:
  - `core.fsmonitor=<payload>`;
  - `diff.x.textconv` plus `.gitattributes` `* diff=x`;
  - `filter.x.clean` plus `* filter=x`;
  - `include.path`;
  - `.git/hooks/*`;
  - `.git/info/attributes`.

  After the metadata restore, reconstruction and the commit-message lookup run no payload. The positive control, plain git on the unrestored checkout, does run it.
- Error path: a nested repo or gitlink with a hostile config runs nothing.
- Error path: `.git` replaced by a symlink or a gitfile makes take-back `unsafe`.
- Happy path: on a clean checkout, these reconstruct exactly as today:
  - staged, unstaged, untracked, deleted and mode-changed files;
  - a force-added ignored file;
  - a new branch the model created.
- Error path: a hung git subprocess is killed at the bound.

**Verification:**
- Existing brokered-push tests pass. The adversarial tests fail when the restore or the wrapper is removed.

- [x] **Unit 6: Real-runner suite, docs and CI**

**Goal:** Prove the boundary on a real runner in CI, document the input and its residuals, and turn it on for the repo's own self-review.

**Requirements:** R1–R3, R5–R8

**Dependencies:** Units 1–5

**Files:**
- Create: `src/harness/phases/v2-server.sandbox.integration.test.ts`, one gated suite (Linux, github-hosted, sudo, real binary)
- Modify: `.github/workflows/ci.yaml`
  - Add a `Sandbox integration` job on ubuntu-latest. It fetches the pinned binary and verifies its digest against `opencode-v2-pin.json`, then runs that suite.
  - Set `isolate-agent: 'true'` on `test-action`.
  - Marcus approved the CI change in plan review.
- Modify: `README.md` (input table, "Credential limits"), `docs/wiki/Setup and Configuration.md` ("Withholding is not an OS boundary"), the `packages/runtime/src/agent/response-delivery.ts` comment, `ARCHITECTURE.md` (Action uid isolation beside the workspace paragraph) and `src/services/setup/AGENTS.md`

**Approach:**
- The suite drives a scripted fake model through real tool shells. It checks each row as the sandbox, with the same command run as runner as a positive control.
- The docs state exactly what is blocked and what isn't (the provider key, the server password, anything the trigger provisions) and the runner requirements. The `generating-project-docs` skill governs the README and ARCHITECTURE edits.

**Test scenarios:**
- Integration, blocked:
  - The Action's `/proc/<pid>/environ` and the ancestor walk.
  - `$GITHUB_ENV` and `$GITHUB_OUTPUT`.
  - A 0700 `RUNNER_TEMP` dir.
  - Canary 0644 files in `~`, `~/.config/<x>` and `~/.cache/<x>`.
  - `~/.docker/config.json`.
  - `sudo -n true`.
  - The docker socket.
- Integration, works:
  - Checkout read and write.
  - `git status`/`add`/`commit` with the configured identity.
  - A provider request.
  - An admitted repo skill read.
  - In provision mode, `gh api user`.
- Integration, identity: the server and a tool shell report the sandbox uid, no groups beyond its primary, `NoNewPrivs: 1` and zero capabilities.
- Integration, quiescence: a `setsid sleep`, a `nohup sleep` and a TERM-ignoring child are all gone after stop. A launch that fails after spawn leaves no sandbox process.
- Integration, take-back:
  - The model creates 0600 files, a 0700 dir and a symlink to a runner-owned sentinel.
  - Afterwards everything under the roots is runner-owned and readable.
  - The sentinel's owner, mode and content are unchanged, and the symlink is still a symlink.
  - A hardlink the model made to a runner-owned file it could write stays runner-owned.
- Integration, persistence: restore, then an isolated run, then checkpoint, then save, then restore in a second run. The cache paths and cache version are identical and the WAL is clean.
- Integration, git: the Unit 5 fixtures run end to end through a real model shell.

**Verification:**
- The `Sandbox integration` job passes on the PR, and reverting any lock fails its row.
- The PR's own `Test GitHub Action` run uses isolation and completes a review. Its log shows the sandbox launch, `stopped`, `restored` and a cache save.

## System-Wide Impact

- **Interaction graph:** the change touches bootstrap (preflight), `startActionOpenCodeV2` (handoff, launch), release, finalize (gated, no-follow reads), cleanup (persistence), the post hook (decline) and brokered push (hardened git).
- **Error propagation:**
  - Preflight fails before setup.
  - A handoff failure stops the run before launch.
  - `unconfirmed` or `unsafe` at stop fails the run, with publication and persistence declined.
  - Errors name the failed check and never print secret values.
- **State lifecycle risks:** checkpointing a live writer, a post hook saving unrestored state, and a partial handoff. These are covered by the stop-verify-restore order and the post-hook decline.
- **API surface parity:** the gateway workspace already isolates through its root supervisor and is unchanged. The new launch mode must not change the root `uid`/`gid` behavior.
- **Integration coverage:** the blocked/works table, the restore→save→restore cycle and the adversarial git fixtures need a real runner. They run in the `Sandbox integration` job.
- **Unchanged invariants:**
  - An unset input means today's behavior. The exceptions are the no-follow response read and the git timeout-kill wrapper, which tighten every run without changing results for regular files.
  - Restore and save path lists and the cache version.
  - Trigger credential classification.
  - Brokered push writes only through the API, with `force: false`.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A runner image change (sudo-rs version, util-linux, ACL support, the Ubuntu 26.04 rollout) breaks the launch | The preflight checks tool paths and sysctls. The `Sandbox integration` job and the isolated self-review run on every PR. |
| A sandbox descendant survives and races runner-side reads | Per-run uid, a `pkill`/`pgrep` loop to empty, and finalize and persistence gated on `stopped` |
| A runner-private file is still reachable | Default-deny on the runner home, with canary rows and positive controls in the blocked table |
| The ACL mask or default ACLs leave files the runner can't read | Take-back chowns every sandbox-owned inode back to runner, so later steps don't depend on ACLs |
| The model leaves a link where the runner reads | No-follow, regular-file-only reads for every sandbox-writable path |

## Documentation / Operational Notes

- The README and wiki get the input, its prerequisites, the list of what is and isn't blocked, the self-hosted caveat, and the unsupported concurrent-step case.
- Turning the input on by default comes after the self-review run has soaked with isolation, as a separate PR.

## Sources & References

- Related issues: #2135, #2156, #2157
- Spike: run 42891132483 and the #2135 Phase 2 results comment
- Related past work:
  - `docs/plans/2026-07-30-001-feat-brokered-push-trusted-mention-plan.md` is recorded as done. This plan keeps its trusted-SHA, API-only push and changes only how runner-side git treats the checkout's metadata.
  - `docs/plans/2026-09-24-001-feat-workspace-checkout-update-recovery-plan.md` is recorded as active. It is the workspace analogue (protected credentialed git), and this plan applies the same idea to the Action's post-model git.
- Related code: `packages/runtime/src/agent/server-v2.ts`, `src/harness/phases/v2-server.ts`, `src/features/delegated/reconstruct-changes.ts`, `deploy/workspace-entrypoint.sh`

## As built

Units 1–6 are implemented on `feat/isolate-agent-uid`. Divergences from the plan:

- **Take-back of the checkout is not a per-file ACL restore.** The checkout gets `setfacl` rwX plus default ACLs for the sandbox user. Take-back chowns every sandbox-owned inode back to the runner (`chown -h`, so links stay links) and then removes only the entries this run added, by uid (`setfacl -R -P -x u:<uid>` for access, `find -type d -exec setfacl -d -x` for default), so an ACL that existed before the run survives. The same pass gives the owner `u+rwX` on non-links, so a mode-000 file the model made is readable again. The recorded chain/temp-dir locks are reverted with `-b` plus the stored original, and that reversal runs even when the sandbox files could not be restored (the result is still `unsafe`).
- **Runner-side diff uses `--ignore-submodules=dirty`, not `none`.** With `none`, git runs `git status` inside a gitlink's repository and executes that repository's own `core.fsmonitor`; a positive control proves it. `dirty` never enters the submodule, still reports the recorded gitlink commit, and reconstruction still rejects gitlinks. `--no-textconv` and `--no-ext-diff` are kept, but no fixture can observe them: `--raw` never runs a textconv.
- **Hardened git lives in one wrapper**, `src/features/delegated/trusted-git.ts`, used by `reconstruct-changes.ts` and `commit-message.ts`. It adds a replaced environment, a pinned `PATH` and a timeout. Non-isolated runs use it too.
- **The lifecycle is created in `cache-restore.ts`** (where the server starts) and returned on the phase result. `run.ts` releases it right after the V2 server release and again in `finally` for any path that left earlier; a `sandboxSettled` flag stops a double release.
- **New `sandbox` start stage** in `V2StartStage`, and a new `ISOLATED_RUN` state key written before the save is armed. The post hook declines to retry any isolated `not-persisted` run.
- **`saveCache` declines with `ownership-declined`** when the data dir, storage dir, project-id file or a database file is a symlink or special file, before any checkpoint or upload.
- **S3 upload streams from a verified handle** (`openVerifiedReadStream`: no-follow open plus `fstat` on the same handle) with `ContentLength` taken from that handle. There is no size cap.
- **The real-runner suite now covers the four rows first left out**, as three more suites after the boundary one in `v2-server.sandbox.integration.test.ts` (shared scripted-provider helpers in `v2-server.sandbox.harness.ts`). None has run yet: they skip off a hosted runner and are first proven by the `Sandbox integration` job.
  - **Admitted repo skill:** the skill goes through the real `admitRepoSkills` into a real staging root. The model reads it and cannot write to it, and cannot list the staging root or read a runner-only file beside it.
  - **Provision-mode `gh`:** the model sees `GH_CONFIG_DIR`, and `gh auth token --hostname <dummy host>` returns a dummy token from the handed-over `hosts.yml`. The runner's own `~/.config/gh/hosts.yml` is unreadable. `gh api user` itself is not run: `gh` speaks https to any host except `github.localhost`, so a local stub cannot serve it without a TLS setup.
  - **Persistence round trip:** a cold restore, an isolated run, the real `saveCache` (checkpoint included) onto a local-directory cache adapter, a wipe, the real `restoreCache`, and a second isolated run on the restored files.
  - **Git fixtures through a model shell:** the model commits, then writes payload scripts and a hostile `.git/config` (by rename) and hook. After take-back the real `reconstructChanges` and `resolveBrokeredPushCommitMessage` run, and a copy that has the same hostile state is the positive control.
- **Still not covered:** repo-skill loading through OpenCode's own skill tool (only the OS-level read is checked), and anything at the Action level (`run.ts` ordering stays in unit tests and the isolated `Test GitHub Action` run).
- **The binary is installed under `/opt`** by the CI job so the sandbox user can execute it. The handoff does not grant access to the binary path, which on a real run lives in the world-readable tool cache.
- **The `Sandbox integration` job is not in the `release` job's `needs`.** Adding it is a CI/release change left for a decision.

### Review-pass changes (after the first build)

Eleven findings from review, each with a test and a revert-check:

- **Persisted checkout credentials.** With `isolate-agent` on, `assertNoPersistedGitCredentials` runs on every trigger, not only withheld ones; a hit fails the run before setup and names `persist-credentials: false`. The `test-action` checkout now sets `persist-credentials: false` unconditionally (the workflow test pins it). This edit to `ci.yaml` landed in the fix commit, not the `ci:` commit.
- **Unsafe release reads nothing sandbox-writable.** New `SANDBOX_UNSAFE` state key and `sandboxOutputUntrusted` cleanup option. After an unsafe or unconfirmed release, cleanup skips the object-store artifact sync and the log artifact upload, and the post hook skips its upload. Runner-generated metadata still goes out.
- **A throwing post-spawn gate** now stops the server and releases the sandbox before rethrowing (`runGates` wrapped in `stopAfterFailure`).
- **Account deletion** follows a confirmed stop even when take-back is unsafe (nothing runs as the uid any more). It stays blocked when the stop is unconfirmed.
- **Every privileged command has a deadline.** `createPrivilegedRun` uses `execWithTimeout` (default 60 s) and reports a killed command as `exitCode: null`; handoff and take-back each share a 120 s budget; `stopSandboxProcesses` gives `pkill`/`pgrep` the time left of its bound.
- **Signals.** `SIGINT`/`SIGTERM` stop the sandbox and attempt take-back within 10 s, then re-raise the signal. Handlers are installed before the account exists and removed after release.
- **Git metadata is restored by `rename`** from the snapshot (copy only on `EXDEV`), so a full disk cannot leave the model's version in place.
- **`storage/.version`** is written through an exclusive temp file and a rename, and a non-regular `.version` makes `saveCache` decline.
- **Populated submodules.** With isolation on, reconstruction reads gitlinks from `ls-files --stage`, declines by name when any gitlink directory holds a `.git`, and keeps `--ignore-submodules=dirty`. With isolation off it is back to the original `none`. The flag runs `finalize.ts` -> `brokered-push.ts` -> `reconstruct-changes.ts`.
- **Real-runner suite additions** (CI only): mode-000 file and directory readable again after take-back; a pre-existing named ACL and default ACL survive while none of this run's entries remain.
