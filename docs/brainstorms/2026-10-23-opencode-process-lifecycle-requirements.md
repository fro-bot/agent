---
date: 2026-10-23
topic: opencode-process-lifecycle
---

# OpenCode process lifecycle: a run ends with its OpenCode stream

## Summary

A gateway run never outlives the OpenCode stream that serves it. When the stream ends, errors, or goes about 30 seconds without an event or server heartbeat, the run reaches `failed` within about a minute, in every run state. Stranded run records reach a terminal state within 5 minutes without a gateway restart.

---

## Problem Frame

The workspace runs one long-lived `opencode serve` for every repo. On the 2 GB gateway host, its RSS grew to about 1.1 GiB over 2.7 days of uptime (#1923, reported figures). The operator now caps the workspace at 1024 MiB, so the growth ends in an OOM kill. That kill can land in the middle of a run.

On 2026-10-23, OpenCode died mid-run and the run stayed `running` until the operator cancelled it by hand (#1922). The supervisor respawned OpenCode, and new launches worked. No logs exist for the incident. Code inspection found several gaps, any of which could have caused it:

- **Proxy.** When the workspace proxy's upstream dies, the proxy never closes the downstream connection. The gateway's event read stays pending. This is reproduced on Node 24.
- **Reconnect.** The SDK silently reconnects to the replacement OpenCode, and that replacement sends only a connect event and periodic heartbeats.
- **Inactivity.** Inactivity detection is paused during background drain and approval or question waits. In those states, only the 30-minute wall clock bounds the run.
- **Terminal writes.** A failed terminal-state write is only logged, so a finished run can keep showing `running`.
- **Recovery.** Stale-run recovery runs only at gateway startup, and skips a workspace that reports busy or unknown.

---

## Requirements

**Ending a run**

- R1. A run reaches `failed` within about a minute, in every run state, when its event stream ends, errors, or goes about 30 seconds with no event or server heartbeat.
- R2. A run never continues across a stream interruption, whether a reconnect would reach the same OpenCode instance or a replacement.
- R3. When the workspace proxy loses its upstream connection, it closes the matching downstream connection. When a streaming client disconnects, it closes the matching upstream connection.
- R4. A stream loss goes through the existing termination barrier: abort the root, confirm quiescence, and quarantine if unconfirmed.
- R5. When a run fails while it waits on an approval or a question, the pending prompt resolves as "run ended".
- R6. The failure reply posts even when the terminal-state write fails.

**Stranded run records**

- R7. While the gateway runs, an executing run left `running` with no live owner reaches a terminal state within 5 minutes, whatever the workspace's quiescence. Queued runs are not touched.
- R8. Reconciling a record never releases a lock or workspace reservation.
- R9. A failed terminal-state write is retried a few times over a short period. If it still fails, R7 reconciles the record.

**Seeing why a run has not finished**

- R10. While a run waits for its completion gate, the operator can see why the gate has not admitted completion yet. Examples include a background child whose notice has not arrived, or a root that is still live.

---

## Acceptance Examples

- AE1. **Covers R1, R2.** The operator restarts the workspace while a run is draining a background child. The run is `failed` within about a minute and does not resume on the new OpenCode.
- AE2. **Covers R1, R4.** A run's OpenCode stays alive but stops sending events and heartbeats. The run fails through the barrier.
- AE3. **Covers R5.** A run waits on an approval when its workspace restarts. The run fails, and the approval prompt shows that the run ended.
- AE4. **Covers R6, R7, R9.** A run completes, but its terminal-state write and the short retries all fail. The reply has already posted. The record reaches a terminal state within 5 minutes, and its note does not contradict the reply.
- AE5. **Covers R10.** A run's root has answered, but one background child is still running. The operator status shows the run as running and waiting on a background child's notice. Once the child settles, the wait reason clears.

---

## Success Criteria

- No gateway run stays `running` more than about a minute after its stream or its OpenCode process is gone, in any run state.
- No executing run record stays `running` more than 5 minutes without a live owner.
- An OOM kill under the workspace memory cap costs one failed run. It never leaves a stuck run that needs a manual cancel.

---

## Scope Boundaries

The following are out of scope:

- **Resuming an interrupted run.** The run fails and the operator relaunches it.
- **Orphaned tool processes.** A shell command that OpenCode started can outlive an OpenCode crash. Orphaned tool processes are not tracked, killed, or waited on. The rare collision with a later run on the same repo surfaces as a dirty checkout, and automatic recovery handles that.
- **Recycling OpenCode to bound its memory** (#1923). That stays open until the growth is measured on Linux with real runs.
- **Per-repo `/instance/dispose`** as a memory remedy.
- **Recovering automatically from the supervisor's `degraded` state.**
- **Changing the 5-minute inactivity and 30-minute wall-clock defaults.**
- **Events missed between `promptAsync` and the lazy event subscription.** This predates the work and is tracked separately.
- **The GitHub Action.**

---

## Key Decisions

- **30 seconds of silence, in every state.** OpenCode sends a heartbeat every 10 seconds. Three missed heartbeats are cheap to detect and tolerate a slow process.
- **Fail on any interruption.** OpenCode does not replay events on reconnect, so a blip can lose the event that would have finished the run. Failing costs less than reconciling.
- **No new lock rule.** The existing barrier already handles a root that may still be running. Designing for orphaned tool processes cost more than the rare, recoverable collision it would prevent.
- **Sweep executing records only, and touch no locks.** A quiescence gate would break the 5-minute bound while a workspace stays busy.

---

## Dependencies / Assumptions

- OpenCode sends `server.connected` on connect and `server.heartbeat` about every 10 seconds. This is verified in the pinned source.
- One gateway process runs at a time.
- Heartbeats keep their cadence under memory pressure. This is unverified.

---

## Sources / Research

- Issues #1922 and #1923.
- `apps/workspace-agent/src/opencode-proxy.ts`, `apps/workspace-agent/src/opencode-server.ts`.
- `packages/gateway/src/execute/run-core.ts`, `run.ts`, `recovery.ts`, `packages/gateway/src/program.ts`.
- `docs/solutions/logic-errors/gateway-root-not-aborted-on-early-stop-2026-10-22.md`.
