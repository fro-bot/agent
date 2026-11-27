---
title: "A run that never ends after the final message: reproduce before blaming the pin, and log what the root was doing"
date: 2026-11-27
category: workflow-issues
module: agent-execution
problem_type: workflow_issue
component: assistant
severity: high
applies_when:
  - A run stays open after the agent's final message until the execution deadline
  - Bumping the OpenCode V2 pin, especially when the first real model run on it misbehaves
  - Adding diagnostics that read the server's event stream
symptoms:
  - "The Action logs nothing after the final message until 'Execution timeout reached'"
  - "The drain at the deadline finds the root session still running plus a live shell"
root_cause: async_timing
resolution_type: tooling_addition
related_components:
  - dependencies
  - tooling
tags:
  - opencode-v2
  - pin-bump
  - execution-deadline
  - compaction
  - sse-events
  - diagnostics
---

# A run that never ends after the final message: reproduce before blaming the pin, and log what the root was doing

## Context

Read the deadline diagnostics, and reproduce on both binaries, before attributing a hang to a pin. A blind deadline log turns every hang into a version hunt, so the Action now logs what the root session was doing when the deadline fired.

The incident: the first PR review on OpenCode 2.4.2 (run 45893163833) posted its final approval message, then the Action logged nothing until the 40-minute deadline. The drain found the root session still running and one live shell (`sessionsInterrupted: 1`, `shellsDeleted: 1`). The Action's wait was correct, because the server never published `session.execution.succeeded`, but the deadline log said only `Execution timeout reached`.

The pin PR that brought in 2.4.2 had passed CI. Pin bumps come from the Fro Bot app, and the review job skips bot-authored PRs (`.github/workflows/fro-bot.yaml:291`). So the first real model run on a new pin is the next human PR's review.

## Guidance

1. **Revert the pin first, then find the cause.** Moving back to the last good version (#2375) restored reviews within minutes and gave time to investigate.
2. **Reproduce on both binaries before blaming the bump.** A diff between versions pointed at three plausible upstream changes: background compaction tracing, keyed mutexes moved to host services, and SQLite transactions moved to Effect. A scripted-provider matrix on both real binaries found no difference between versions in any scenario it tested, and the schema was identical. So nothing showed a 2.4.2 regression, but the original hang's cause is still unknown. 2.4.2 went back in (#2377).
3. **Expect hangs that exist on both versions.** The matrix found one. The sequence:
   - A background compaction summary is in flight when the final message goes out.
   - A later notice, such as a shell exiting, wakes the root while its context is over the limit.
   - The summary request stalls, returns 500, or drops.
   - The root then waits on the held summary (`Fiber.await(held.fiber)` in OpenCode's `core/src/session/compaction.ts`) with no timeout of its own. A failing summary is re-sent every 10–15 s.
   - The stream shows `session.compaction.started` and then nothing.

   This is reported upstream as anomalyco/opencode#66766. It is not proven to be what hung run 45893163833, whose logs don't mention compaction either way (#2376).
4. **Log a snapshot at the deadline.** The Action now logs one content-free line when the execution deadline fires (#2382). A listener added at `src/features/agent/retry-v2.ts:220-224` (`reportDeadlineDiagnosticsV2`) builds it. Only the deadline path fires it: the listener is removed as soon as a result is chosen. The event trail is fed from raw frames, before the mapper drops `session.compaction.*` (`trailFrames`, `src/features/agent/streaming-v2.ts:422-426`):

   ```ts
   async function* trailFrames(frames: AsyncIterable<unknown>): AsyncGenerator<unknown> {
     for await (const frame of frames) {
       recordFrameV2(tracker.eventTrail, frame, {rootSessionId: sessionId, isOwned, nowMs: Date.now()})
       yield frame
     }
   ```

   The trail is capped at 20 entries (`EVENT_TRAIL_MAX_ENTRIES`) and 1 KiB (`EVENT_TRAIL_MAX_BYTES`), and repeats are folded. A bounded summary of the same fields goes on the lifecycle trace as the `deadline.diagnostics` event. The warning line in the run log has the full snapshot.
5. **Keep shared-feed diagnostics to the run's own sessions.** The server's event feed covers every location it serves. Record only the root, the children the run owns, and a short list of server-wide types (`src/features/agent/deadline-diagnostics-v2.ts:112-122`):

   ```ts
     if (sessionId === null) {
       if (!SERVER_WIDE_TYPES.has(type)) return
       role = 'server'
     } else if (sessionId === context.rootSessionId) {
       role = 'root'
     } else if (context.isOwned(sessionId)) {
       role = 'child'
     } else {
       return
     }
   ```

   Hold the root's open compaction outside the child cap, so children can't push it out.
6. **Report only blockers the completion rule honours.** After a stream drop, completion ignores stale notice and inbox state, so the snapshot has to ignore it too (`deadline-diagnostics-v2.ts:235-240`):

   ```ts
     if (tracker.rootTerminal === null) waitingOn.push('execution-not-ended')
     // The completion rule (`observeRootTerminal`) defers on these only while the stream is trusted.
     if (!tracker.streamBlind) {
       if (tracker.turnOwed) waitingOn.push('notice-turn-owed')
       if (queued.length > 0) waitingOn.push('inbox-queued')
     }
   ```

## Why This Matters

A blind deadline log turns every hang into a version hunt. The diff for this one named three suspects, and all three were wrong. With the snapshot, the held-compaction case reads straight off one line:

```
Execution deadline diagnostics {waitingOn:["execution-not-ended"], rootRunning:true, compaction:{state:"started-not-ended", open:[{role:"root", reason:"auto", startedMs:-15614}]}, recentEvents:[…{type:"session.compaction.started", role:"root", session:"3aVL77", t:-15614}, {type:"server.heartbeat", t:-4986}]}
```

A snapshot that reads the whole feed would publish other sessions' ids and timing. It could also blame the wrong session's compaction. A snapshot that counts stale state as a blocker would point at a notice the completion rule had already stopped waiting for.

## When to Apply

- After a pin bump, watch the first human PR review on the new version. The bump PR's own checks run no review.
- When a run reaches its deadline, read the `Execution deadline diagnostics` line before reading the diff:
  - `started-not-ended` with role `root` means the root has an open compaction. That fits a held summary, but the trail alone doesn't establish the cause.
  - A pending `notice-turn-owed` or `inbox-queued` while the stream was trusted points at delivery.
  - `execution-not-ended` alone, with no compaction, needs the server log.
- When you add a diagnostic that reads the server's event stream, filter it to the run's own sessions.

## Examples

- **Before:** `Execution timeout reached`, then the drain verdict. There was nothing to act on, so the pin was reverted on suspicion.
- **After:** the line above names a root compaction that started 15.6 s before the deadline and never ended. On a normal finish nothing extra is logged.
- **Reproducing:** the matrix used a scripted provider that holds open, fails or drops the summary request. Its harness was kept outside the repo, so a held-compaction test of the deadline path lives in `src/harness/phases/execute-v2.integration.test.ts`.

## Related

- #2376 (the hang), #2375 (pin revert), #2382 (diagnostics), anomalyco/opencode#66766 (upstream report).
- [Permission ask dropped by ownership filter](../integration-issues/permission-ask-dropped-by-ownership-filter-2026-09-19.md): another silent hang to the deadline, with a different cause.
- [Terminal outcomes must survive deadline cleanup](../logic-errors/terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md): when a terminal result beats the deadline. This run had none.
