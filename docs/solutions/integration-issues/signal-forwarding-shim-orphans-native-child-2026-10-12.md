---
title: Signal-forwarding shim orphaned its native child and crashed on a failed signal forward
date: 2026-10-12
category: integration-issues
module: harness-release
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - "`harness <args>` does not forward SIGTERM, so the native child keeps running after the wrapper dies"
  - "A child killed by a signal makes the wrapper exit 1 (`result.status ?? 1`)"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - agent-execution
tags:
  - signal-forwarding
  - spawnsync
  - child-process
  - orphaned-process
  - exit-code
  - node-signals
  - opencode
  - harness-shim
---

# Signal-forwarding shim orphaned its native child and crashed on a failed signal forward

## Problem

`@fro.bot/harness` ships a Node `bin` that runs the patched native OpenCode binary. Before PR #1800, the `harness <args>` passthrough ran that binary with `spawnSync`. A SIGTERM sent to the wrapper never reached the child, and a child killed by a signal made the wrapper exit 1.

The `opencode` command that #1800 added sits on the path the OpenCode SDK uses. The SDK launches `opencode serve` by bare name, without `detached`, and its `close()` sends `proc.kill()` to that process (`.slim/clonedeps/repos/anomalyco__opencode/packages/sdk/js/src/server.ts`, `process.ts`). With a Node wrapper on PATH, that signal reaches the wrapper, so forwarding it to the child became load-bearing.

## Symptoms

- `harness <args>` does not forward SIGTERM, so the native child keeps running after the wrapper dies.
- A child killed by a signal makes the wrapper exit 1.

## What Didn't Work

- **Skipping SIGINT forwarding when a TTY is attached.** A TTY does not tell you who sent the signal, so this silently drops a PID-directed SIGINT from editor integrations. The accepted cost of always forwarding is that a group-directed signal, such as Ctrl-C or a terminal hangup, can reach the child twice. This is documented in `packages/harness/README.md` under "Signals and exit codes".
- **A detached spawn with a process-group kill**, as in `execWithTimeout` (`src/services/setup/adapters.ts`). Detaching puts the child in its own process group, which takes it out of the terminal's foreground group. That approach also maps a signal death to exit 1.
- **`spawned.once('error', …)`.** Node emits `error` for a failed `kill()` on a live child, not only when spawn fails. EPERM is one cause: a native child that changed credentials can't be signalled. The first failed forward used up the one-shot listener. The second emitted an `error` with no listener, which crashed the shim while the child kept running.
- **Relying on `nohup` or `trap '' HUP`.** Node resets inherited signal ignores at startup, so a Node shim cannot see or preserve them. On Node 24.21, `bash -c 'trap "" HUP; exec node -e "process.kill(process.pid,\"SIGHUP\")"'` exits 129. No check inside Node can see the inherited ignore, because Node resets signal dispositions before user code runs.

## Solution

Run the child with an async, non-detached `spawn` and inherited stdio. Install the forwarding listeners before spawning, and hold any signal that arrives before the child exists:

```ts
// packages/harness/src/exec-binary.ts
let child: ChildProcess | undefined
const held: NodeJS.Signals[] = []
const host: SignalHost = options.signalHost ?? process

const listeners = FORWARDED_SIGNALS.map(signal => {
  const listener = (): void => {
    if (child === undefined) {
      held.push(signal)
      return
    }
    child.kill(signal)
  }
  return {signal, listener}
})
for (const {signal, listener} of listeners) host.on(signal, listener)
```

`FORWARDED_SIGNALS` is SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGUSR1 and SIGUSR2. Listening on SIGUSR1 also stops Node from opening its inspector.

Keep the `error` listener attached until the outcome settles. Treat an `error` as a spawn failure only when the child never got a pid:

```ts
// packages/harness/src/exec-binary.ts
let detachErrorHandler = (): void => {}
const onError = (error: Error): void => {
  if (spawned.pid === undefined) settle(toSpawnError(error))
}
spawned.on("error", onError)
detachErrorHandler = () => {
  spawned.off("error", onError)
}
spawned.once("exit", (code, signal) => {
  settle(outcomeFromExit(code, signal))
})
```

`exitStatusFor` in `exec-binary.ts` maps the outcome to an exit status, and the entry point only applies it. INT, TERM, HUP and QUIT are re-raised on the shim itself. Any other signal maps to `128 + n`. Spawn errors map to 127 for ENOENT, 126 for EACCES, and 1 for anything else:

```ts
// packages/harness/src/exec-binary.ts
case 'signaled':
  if (RERAISED_SIGNALS.includes(outcome.signal)) return {kind: 'reraise', signal: outcome.signal}
  return {kind: 'exit', code: 128 + (os.constants.signals[outcome.signal] ?? 0)}
```

```ts
// packages/harness/src/run-passthrough.ts
const env = resolved.source === "override" ? {...process.env, OPENCODE_PATH: resolved.path} : process.env
const outcome = await execBinary(resolved.path, options.args, {env})
if (outcome.kind === "spawn-error")
  console.error(`[${options.label}] Failed to spawn ${resolved.path}: ${outcome.message}`)
applyExitStatus(exitStatusFor(outcome))
```

For a server that has to survive a hangup, invoke the native binary directly (`nohup /path/to/native/opencode serve`) instead of going through the shim.

## Why This Works

The old code installed no signal listeners at all. Adding one would not have helped, because `spawnSync` blocks the event loop and no JavaScript listener can run while the child is alive. Node's default SIGTERM disposition then killed the wrapper straight away, and the child was never signalled.

Installing listeners before spawning closes the window in which a signal arrives with no child to forward it to. Holding that signal and delivering it once the child exists keeps the child from being left behind.

Settling as a spawn failure only when there is no pid separates a real spawn failure from a failed forward to a live child. The failed forward is ignored, and supervision continues until `exit`.

Re-raising INT, TERM, HUP and QUIT lets the parent observe a signal death. Any other signal the child dies of maps to `128 + n` and is not re-raised. For SIGPIPE and SIGUSR1 a re-raise would not even end the shim: Node ignores SIGPIPE and handles SIGUSR1 for its inspector. For signals such as SIGUSR2 or SIGKILL a re-raise would work, so mapping them to `128 + n` is a design choice rather than a limit. SIGKILL to the shim cannot be forwarded at all, so the child can be orphaned in that case. The README documents this.

## Prevention

- Do not `spawnSync` a child that you need to supervise or forward signals to.
- Install signal listeners before spawning, and hold signals that arrive early. `packages/harness/src/exec-binary.test.ts` pins this.
- Keep the `error` listener until the outcome settles, so a failed forward never ends supervision. A test emits two consecutive EPERM errors and asserts that the promise stays pending until the real child exits.
- Assert the outcome, not just the exit code. A default-disposition SIGTERM must report `{kind: 'signaled'}`.
- Test real delivery under a controlling terminal. `packages/harness/src/opencode-pty.test.ts` drives the shim through a Python `pty`. It pins terminal Ctrl-C delivery as at least once and at most twice, and checks that a PID-directed SIGINT is delivered while the terminal is attached.

## Related Issues

- PR #1800 (squash commit `6c64b44c7`)
- `docs/plans/2026-10-11-001-feat-harness-opencode-bin-plan.md`
- `packages/harness/README.md`, "Signals and exit codes"
- `docs/solutions/best-practices/promise-race-bounds-await-not-subprocess-2026-07-30.md`: a timeout does not stop a child either
- `docs/solutions/integration-issues/tool-cache-directory-spawned-as-executable-2026-09-06.md`: the same harness spawn boundary
