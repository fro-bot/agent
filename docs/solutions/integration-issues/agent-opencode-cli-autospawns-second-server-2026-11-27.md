---
title: The agent's opencode CLI can start a second OpenCode server mid-run
date: 2026-11-27
category: integration-issues
module: agent-execution
problem_type: integration_issue
component: tooling
symptoms:
  - "A Connect run ended with its run record at no-final-line after the model ran `opencode api get …`"
  - "opencode.log showed a second CLI start with args [\"serve\",\"--service\"] on the run's state directory while the Action's serve --stdio kept running"
  - "The drain reported quiet with no interrupted sessions, so the Action never saw the second server"
root_cause: missing_tooling
resolution_type: tooling_addition
severity: high
related_components:
  - background_job
  - testing_framework
tags:
  - opencode
  - cli-guard
  - path-shim
  - service-ensure
  - process-ownership
  - fail-closed
---

# The agent's opencode CLI can start a second OpenCode server mid-run

## Problem

Put an allowlist guard named `opencode` first on the agent's PATH so its shell can't start a second OpenCode server; it stops accidental use only, not a model that runs the real binary by absolute path. On OpenCode 2.4 almost every CLI command calls `Service.ensure`, which with no endpoint starts a detached `opencode serve --service` on the same state directory, and the Action's own `serve --stdio` on a private loopback port is invisible to the CLI. So when the model ran `opencode api get …` from its shell, a second server started against the run's session store, outside the Action's view and its cleanup (#2369).

## Symptoms

- The Connect sweep (run 45877265561) ended with its run record at `no-final-line`. One delegated child never sent a notice. The parent ended its turn without publishing, and the drain reported `quiet`.
- `opencode.log` showed a CLI start with `args=["api","get",…]`, then about 90 ms later `cli starting args=["serve","--service"]` on the same state, while `serve --stdio` kept running.

The second server was seen alongside the missing notice. It's not proven to have caused it, but the lifecycle bug is real either way.

## What Didn't Work

- **Blaming the tracing change or the Systematic pin move.** The diagnosis cleared both (identical plugin order and config; a scheduled run with no `api` calls ran one server).
- **Looking for a switch.** OpenCode 2.4.1 and 2.4.2 have no environment variable or config key that stops the auto-spawn. `opencode service set disabled true` doesn't help either: the CLI then starts a temporary `serve --stdio` instead.
- **Pointing the CLI at the Action's server.** That would stop the spawn, but it hands the agent the server API, so it needs its own security review. It wasn't pursued.
- **A first guard with gaps.**
  - Its integration tests killed every host process matching `serve --service`, which can kill an unrelated OpenCode service on a developer machine, including the session running the tests.
  - Under `isolate-agent`, a guard probe that timed out was treated like an ordinary refusal. The run launched, and teardown then refused take-back.

## Solution

Put a guard named `opencode` first on the agent's PATH. It runs the real binary only when the sole argument prints and exits, and refuses everything else with exit 2. The allowlist is in `packages/runtime/src/agent/cli-shim.ts:39-46` (`OPENCODE_CLI_SHIM_ALLOWED_ARGUMENTS`):

```ts
export const OPENCODE_CLI_SHIM_ALLOWED_ARGUMENTS: readonly string[] = [
  '--version',
  '-v',
  'version',
  '--help',
  '-h',
  'help',
]
```

The script it generates (`cli-shim.ts:70-80`) matches `$#:$1`, so no arguments or extra arguments fall through to the refusal:

```ts
  const patterns = OPENCODE_CLI_SHIM_ALLOWED_ARGUMENTS.map(argument => `1:${argument}`).join('|')
  return [
    '#!/bin/sh',
    '# Fro Bot: the OpenCode CLI must not start or reach a server in this run (fro-bot/agent#2369).',
    'case "$#:$1" in',
    `  ${patterns}) exec ${shellQuote(binaryPath)} "$@" ;;`,
    'esac',
```

Keeping `--version` working matters, because skills such as ce:connect check the host with `opencode --version`.

The guard goes first on PATH in the non-isolated and isolated modes, with exceptions:

- **Non-isolated:** first on the server child's PATH, from a directory under `RUNNER_TEMP` (`packages/runtime/src/agent/server-v2.ts:707`). It's removed when the server exits. Windows skips the guard because it can't run the shim, and a failed probe leaves it off PATH (`server-v2.ts:685-713`).
- **Isolated:** first on the sandbox launch PATH, with a read-only grant (`src/harness/phases/sandbox-lifecycle.ts:1221`). It's removed after take-back.
- **Workspace agent:** set up the same way (`apps/workspace-agent/src/opencode-server-v2.ts`).

Before the guard goes on PATH, it's run once with a refused argument, as the identity that will run the server. That catches a `noexec` mount or a directory the identity can't enter. What happens when the check fails depends on the mode (`src/harness/phases/sandbox-lifecycle.ts:1226-1252`):

- **Non-isolated:** a failed probe warns once and continues with the guard off PATH, so the run behaves as it did before the guard.
- **Isolated:** a guard directory the sandbox user can't enter fails the run. A probe that exits but fails its check warns once and continues without the guard. A probe that times out fails closed, because a privileged command that timed out can't be confirmed stopped (`sandbox-lifecycle.ts:1241-1243`):

```ts
        if (ran.timedOutAfterMs !== undefined) {
          return await failAndRelease('isolate-agent: the OpenCode CLI guard probe timed out')
        }
```

## Why This Works

The guard exits before the CLI resolves or starts any server. The only forms it passes through print and exit.

It is not a security boundary. A model can still run the real binary by its absolute path. The guard stops the accidental case, which is the one that happened: a model reaching for `opencode api …` the way a person would.

## Prevention

- **Check auto-start when you move a pin.** For any CLI the agent can run, read its connection code at the pinned version before you rely on it. The thing to look for is whether a plain command will start a server.
- **Use an allowlist, not a denylist.** A denylist of subcommands misses the next one that calls `Service.ensure`.
- **Prove ownership before you signal a process.** On a host that also runs live agent sessions, matching by command line kills the wrong process. `src/harness/phases/owned-service-processes.ts` counts a process only when its environment names the test's own `XDG_STATE_HOME`. Under isolation it checks only the sandbox uid and signals nothing. A decoy test checks that an unrelated look-alike is neither detected nor killed.
- **Treat a failed scan as a failure, not as "no match".** `pgrep` exit 1 means no matches. Any other exit, a signal or a missing binary throws.
- **Use a real-binary test.** `src/harness/phases/execute-v2.integration.test.ts` runs `opencode api get`, `opencode serve --service` and `opencode --version` from a scripted model. It asserts the first two exit 2, the third prints its version, and that no owned `serve --service` process or `service*.json` is left behind.

## Related Issues

- #2369 (the issue) and #2380 (the fix).
- [Isolated agent needs the runner environment rebuilt](../best-practices/isolated-agent-needs-runner-environment-rebuilt-2026-11-17.md): how the sandbox PATH is built. The guard is now prepended to it.
- [Bound and guard every reconcile pass](../logic-errors/bound-and-guard-every-reconcile-pass-2026-10-22.md): a timeout means the result is uncertain, not that it succeeded.
