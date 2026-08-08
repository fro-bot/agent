---
title: The OpenCode server bootstraps from the process working directory, not the session directory
date: 2026-08-07
category: integration-issues
module: agent-execution
problem_type: integration_issue
component: testing_framework
severity: high
symptoms:
  - "Agent run exhausts its entire time budget and reports a timeout with no useful output"
  - "Captured log shows the agent searching the filesystem for files that should be in its workspace"
  - "Behaviour is correct in CI but wrong under a local test runner"
root_cause: config_error
resolution_type: test_fix
tags:
  - opencode
  - cwd
  - workspace-resolution
  - test-isolation
---

## Problem

`createOpencode` accepts no directory option. In `src/features/agent/execution.ts` it is called with only a signal:

```ts
;async () => withScrubbedEnv(async () => createOpencode({signal: deadline.signal}), logger)
```

The session's directory is set separately, later. The server itself bootstraps in whatever `process.cwd()` happens to be when it starts, and that is the tree it indexes.

In CI this is invisible: the Action already runs with its working directory set to `GITHUB_WORKSPACE`, so cwd and the session directory are the same path and nothing can diverge. Under a test runner they are different — the runner's cwd is the project checkout, while the fixture repository lives in a temp directory.

## Symptoms

An eval scenario pointed at a temp fixture repository ran past a 900-second budget and was recorded as a timeout. There was no error and no output, so it read as a slow or unresponsive model.

The captured `opencode.log` showed what was actually happening:

```text
cwd=/Users/…/fro-bot/agent
bash: find / -maxdepth 6 -iname "access.ts"
```

The server had indexed the project checkout. The fixture's files were not in the tree the agent could see, so the agent went looking for them across the entire filesystem — and spent the whole budget doing it.

## What Didn't Work

Passing the fixture path into session setup was not sufficient:

```ts
const environment = createIsolatedEvalEnv(fixtureRepo.path, scenario, fixtureRepo.headSha, model)
```

This isolates `HOME`, `XDG_*`, and the response-file location, and it sets the session directory — but it does not change the process working directory, so the server still bootstrapped against the runner's cwd.

Time was also lost to plausible wrong theories before the log was read: a malformed provider credential, then a wrong OpenCode version pin. Both were real problems worth fixing, and neither caused this.

## Solution

Enter the fixture repository before the server starts, and restore afterwards:

```ts
// The OpenCode server bootstraps from process.cwd(), so the fixture repository
// must be the working directory before execution begins.
process.chdir(repoPath)
```

Cleanup restores the original working directory _before_ removing temp directories, so the process is never left inside a deleted path:

```ts
process.chdir(env.originalCwd)
fs.rmSync(env.home, {recursive: true, force: true})
fs.rmSync(env.runnerTemp, {recursive: true, force: true})
```

Both scenarios completed in 78s and 88s after the change, against a prior 900s+ timeout.

## Why This Works

The server and the session now agree on which filesystem root the agent can inspect. The agent finds the scenario's files where it expects them and never falls back to searching.

## Prevention

- **When a child process inherits cwd, treat cwd as part of its configuration.** An explicit directory parameter elsewhere in the API does not imply the process respects it at bootstrap.
- **Read the execution log before theorising about a timeout.** The distinguishing evidence here — a `find /` in the agent's own transcript — was unavailable from timing data or result JSON alone. Capture the log on the non-completion path specifically, because that is when it is most needed and most likely to be discarded by cleanup.
- **Be suspicious of anything that works in CI and not locally.** Ask which environment invariants CI provides for free. Here, CI guaranteed `cwd === GITHUB_WORKSPACE` and hid the defect entirely.

`process.chdir` is global to the worker process. The eval runner accepts this and warns when it cannot confirm it is running in isolation; a properly isolated runner is the durable fix.

Related: [workspace executor OpenCode provisioning](../best-practices/workspace-executor-opencode-provisioning-best-practices-2026-06-01.md) covers the surrounding server-lifecycle conventions.
