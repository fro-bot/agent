---
title: Stop a sudo-launched process tree by mount-namespace membership, not by process group
date: 2026-11-17
category: best-practices
module: agent-execution
problem_type: architecture_pattern
component: infrastructure
severity: high
applies_when:
  - A process runs as another uid or as root under sudo and the caller cannot signal it
  - Teardown must prove that every descendant of a privileged launch is gone
  - A launcher's exit is the only evidence available that the launch ended
symptoms:
  - A process group kill of sudo leaves the real command running as an orphan
  - A process-group listing misses children that called setsid
  - pgrep --ns exits 1 with no output while namespace members remain
tags:
  - sudo
  - process-group
  - mount-namespace
  - lsns
  - launch-gate
  - teardown
  - fail-closed
  - isolate-agent
---

# Stop a sudo-launched process tree by mount-namespace membership, not by process group

## Context

On an isolated run the unprivileged runner starts the agent through `sudo … setpriv …`. `sudo` stays as the parent, and the final command is its direct child in the same process group and session. The runner can signal only `sudo`. A group `SIGKILL` kills `sudo` and orphans the real command, which the runner then cannot signal. sudo 1.9.15 (Ubuntu 24.04) and sudo-rs 0.2.13 (Ubuntu 26.04) arrange the launch the same way. sudo-rs ignores `-E`, so the environment is passed as a name list.

A launch's processes are the privileged builder, the shells of the exec chain, the server, and everything the server's tools start. No single ordinary handle covers them:

- A process-group listing misses any process that changed session.
- A uid sweep (`pkill -u`, `pgrep -u`) cannot see the root processes.
- The launcher exiting says nothing about its orphaned child.

The measurements are in `docs/plans/2026-11-14-001-fix-isolate-agent-readonly-view-plan.md`.

## Guidance

1. **Identify the launch by its mount namespace.** The first root step of the launch chain in `packages/runtime/src/agent/server-v2.ts` writes its own `/proc/self/ns/mnt` id to a per-launch gate directory, then waits for a go-ahead file that holds the same id. It gives up on its own bound if none arrives.
2. **Gate admission on the captured id.** `admitLaunch` in `packages/runtime/src/agent/sandbox-namespace.ts` writes the go-ahead only when the id is well-formed, differs from the runner's own namespace, the launcher is alive and teardown has not begun. A launch whose id was never captured never gets past the gate.
3. **Stop as root and confirm from a complete listing.** `stopLaunchNamespace` lists with `lsns -n -t mnt -o NS,PID`, kills with `pkill -KILL --ns <member pid> --nslist mnt`, and repeats until the namespace is absent. It rejects the whole listing if any non-empty row is unparseable or the host's own id is missing, because such a listing was cut short. It refuses to signal the host namespace.
4. **When no id was captured**, `stopLaunch` kills by the gate directory in the command line and confirms only when the count of matches is zero.
5. **Treat every unconfirmed or timed-out step as `unsafe`.** `stopLaunches` in `src/harness/phases/sandbox-lifecycle.ts` requires each launch to be confirmed. Otherwise nothing is taken back and the account is kept. A timed-out privileged command is never counted as a stopped process.

The uid sweep, `stopSandboxProcesses` in `packages/runtime/src/agent/sandbox-identity.ts`, still runs afterwards. It catches `setsid` children of the agent's uid. It is the complement, not the answer.

What didn't work:

- **Killing the process group from the runner.** It kills only `sudo`.
- **Finding the namespace after launch** from the launcher's children. Once the launcher is dead there is nothing to walk, and the stop was skipped.
- **`pgrep --ns <leader>` to confirm empty.** With the leader dead it exits 1 with no output while members remain, which reads as "empty".
- **A time bound on the gate as the safety rule.** It bounds the earliest exit of an orphaned shell, not the latest.

## Why This Matters

If a stop is wrongly believed complete, an orphaned root process can keep changing files that the runner then takes back and trusts. Confirmation needs positive evidence. A missing row, a failed command or a timeout is not evidence.

## When to Apply

Use this whenever code starts a process across a privilege boundary and later has to prove that process and its descendants are gone. Do not rely on pids, process groups or uids alone. A wrapper's death never proves its child stopped.

## Examples

A confirmed stop logs `Sandbox launch namespace stopped` with `confirmed: true`. The real-runner suite kills a launcher while its root step waits at the gate and checks that the orphan is still found and killed.

Tests that count mount namespaces must attribute them the same way. On Ubuntu 24.04, `snapd` activates `systemd-timedated.service` in its own mount namespace for about 30 seconds, so a before-and-after diff of `lsns` counts a namespace that is not the launch's. `newLaunchNamespaces` in `src/harness/phases/v2-server.sandbox.harness.ts` keeps a new namespace only if one of its members belongs to the launch (#2235).

## Related

- [A separate uid is not a boundary on a hosted runner](./separate-uid-is-not-a-boundary-on-hosted-runners-2026-11-17.md): the view this namespace holds.
- [Promise.race bounds the await, not a non-abortable subprocess](./promise-race-bounds-await-not-subprocess-2026-07-30.md): a settled wait is not a stopped child. A parent's exit does not stop a privileged child either.
- [Signal-forwarding shim orphaned its native child](../integration-issues/signal-forwarding-shim-orphans-native-child-2026-10-12.md): the same orphaning at a different launch boundary.
- [An early gateway stop must abort and confirm the root session](../logic-errors/gateway-root-not-aborted-on-early-stop-2026-10-22.md): keep protective state when a stop is unconfirmed.
