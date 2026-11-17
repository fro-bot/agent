---
title: Prove an Action change on the published install with a real caller
date: 2026-11-17
category: workflow-issues
module: setup
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - A change affects how the Action runs on a hosted runner (isolation, preflight, PATH, environment, git config)
  - The Action is called through a wrapper such as a composite action, not directly
  - A new default or opt-in is about to be rolled out to caller repositories
symptoms:
  - "Sandbox handoff failed: the git metadata cannot be trusted: .git/config sets lfs.repositoryformatversion, which is not on the allowlist of keys a checkout writes"
  - A published install called through a composite action was refused as a local install
  - The hosted-runner integration suite was green while the released Action refused every real run
tags:
  - isolate-agent
  - published-install
  - composite-action
  - live-check
  - workflow-dispatch
  - rollout
  - hosted-runner
  - probe
---

# Prove an Action change on the published install with a real caller

## Context

The hosted-runner integration suite for `isolate-agent` passed on every pull request. The released Action then refused every real run. The suite and a published install differ in ways a fixture does not copy, and each gap was found only by running the released tag from a real caller workflow.

## Guidance

Before calling an Action change done, run the published tag from a real caller. Then roll out per caller, with one live proof per distinct pattern.

**What only a published-install run showed**

- **Keys `actions/checkout` leaves in git config.** The audit allowlist missed `lfs.repositoryformatversion` (#2175), then the `config.worktree` booleans `core.sparsecheckout`, `core.sparsecheckoutcone` and `index.sparse` (#2177). The suite built its own checkout by hand.
- **`uses: ./` is not the published layout.** A published install lives at `<work>/_actions/<owner>/<repo>/<ref>`. `GITHUB_ACTION_PATH` is unset for a top-level action and names the composite's directory inside a composite. `checkActionLocation` in `src/services/setup/sandbox-preflight.ts` now takes the install root from the running script's path and requires `GITHUB_ACTION_REPOSITORY` and `GITHUB_ACTION_REF` to match it (#2225).
- **The caller's environment.** Unreachable `PATH` entries under the runner home (#2222), tool locations and a runtime directory the agent could not use (#2232), and no `opencode` on the agent's `PATH` (#2251).
- **The caller's secrets.** Several callers' auth secrets carried a provider entry the key proxy cannot route, so the run was refused at the config stage.

**How to run the probe**

- A branch dispatch works only for a workflow file that also exists on the default branch. Put the probe in an existing workflow file on a throwaway branch and dispatch with `gh workflow run <file> --ref <branch>`.
- Do not probe with a `push` trigger. The Action logs `Unsupported event type: push` and skips, and the job goes green. That is a false pass.
- Set `output-mode: branch-pr` explicitly when the probe must push. `auto` resolves to `working-dir` on `schedule` and `workflow_dispatch` (`resolveOutputMode` in `packages/runtime/src/agent/output-mode.ts`), and the model then declines to push.
- Do not expect two dispatches to share a session. `buildLogicalKey` in `packages/runtime/src/session/logical-key.ts` gives `workflow_dispatch` a run-scoped key. Continuity needs a trigger with a stable key, such as an issue or a pull request.
- For jobs gated to the default branch, relax only that guard on the throwaway branch and leave jobs with public side effects gated.
- Read the evidence from the log, not the conclusion: the agent's uid, the lines that prove each control ran, and the teardown result.
- For a security probe use a dummy token. Afterwards delete the branch and the caches it created.

**Rollout**

Group callers by the thing that differs (here, how each gets a push credential). Prove each group once, live, with a real push. Open one normal pull request per remaining caller. Watch each caller's first scheduled run after merge, and keep a revert ready for jobs that cannot be dispatched before merge.

## Why This Matters

A green hosted suite said the feature worked. The first published-install run failed on the git-lfs key, the next release on the sparse-checkout keys, the next on the composite layout. Each fix was small, and each cost a release. Proving the install early turns a failed release into a failed probe.

A passing check proves only what it can observe. The suite could not observe the hosted image's git-lfs, the runner's `_actions` layout, a wrapper's environment, or a caller's secret.

## When to Apply

- Any change to the preflight, the handoff, the git audit or the launch environment.
- Any change that depends on where the runner puts the Action or on what `actions/checkout` writes.
- Rolling a new default or opt-in across caller workflows.

## Examples

After each live find, make the suite reproduce it, so the next change is caught before release. The real-runner suite now replays checkout's own commands instead of a hand-written config:

```ts
git(workspace, "config", "--local", "lfs.repositoryformatversion", "0")
git(workspace, "config", "--local", "extensions.worktreeConfig", "true")
git(workspace, "sparse-checkout", "disable")
```

## Related

- [Checks report clean for what they cannot observe](./checks-report-clean-for-what-they-cannot-observe-2026-08-10.md): the general rule this is an instance of.
- [Verify behavior, not signal](./verify-behavior-not-signal-2026-08-23.md): a green job is not proof the Action ran.
- [Dependency majors that CI cannot verify](../best-practices/dependency-majors-that-ci-cannot-verify-2026-08-22.md): probing production boundaries that CI does not execute.
- [Delivery-mode contract for manual triggers](./delivery-mode-contract-for-manual-triggers-2026-04-17.md): why a manual probe must set its delivery mode.
- [An isolated agent needs the runner's environment rebuilt](../best-practices/isolated-agent-needs-runner-environment-rebuilt-2026-11-17.md): the environment gaps in detail.
