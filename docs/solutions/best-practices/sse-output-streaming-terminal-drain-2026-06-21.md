---
title: 'Streaming ordered output over SSE: terminal-as-graceful-drain and the completeness guarantee'
date: 2026-06-21
category: best-practices
module: gateway
problem_type: best_practice
component: service_object
severity: high
applies_when:
  - Fanning out ordered content frames plus a terminal signal over a bounded-queue pub/sub to both live and late subscribers (SSE/WebSocket run or log observation, progress+result channels)
  - A consumer must be guaranteed the complete final result even under backpressure, late connection, or burst load
  - Content frames can be high-volume while a terminal status must still be delivered after them
  - State observations feeding the stream are async and can resolve out of causal order
tags:
  - sse
  - streaming
  - backpressure
  - pubsub
  - terminal-state
  - replay-cache
  - coalescing
---

# Streaming ordered output over SSE: terminal-as-graceful-drain and the completeness guarantee

## Context

A gateway pub/sub manager already streamed run **status** to operators over SSE. It then had to stream the run's **output** — the agent's text, as live deltas plus a final answer — over the same connection, to both live subscribers and subscribers who connect after the run has already finished, under per-subscriber backpressure, while preserving a hard guarantee: **the operator always ends up with the complete answer.**

That guarantee is deceptively hard. It is not delivered by one mechanism; it emerges from several that have to cooperate, and the failure modes are subtle concurrency/lifecycle bugs rather than obvious logic errors. This documents the reusable rules. It is the **output/completeness layer**; the authentication, redaction-before-authz, and fail-closed-teardown rules for the same surface live in [authenticated-sse-run-observation](./authenticated-sse-run-observation-2026-06-20.md), and the transport-neutral seam it rides on is in [gateway-control-surface-spine](./gateway-control-surface-spine-2026-06-15.md).

## Guidance

### 1. Terminal is a graceful end-of-stream, not an abort

When a manager streams **ordered** frames (deltas) and a **terminal** frame, the terminal must *drain* the subscriber's queued frames before closing — never clear the queue and close. The final-content frame is frequently queued *behind* earlier frames; an abort-style teardown drops it, so the consumer sees the run finish with missing output.

Model terminal as a state (`closingReason = 'terminal'`) that stops accepting new frames but lets the writer finish:

```ts
// manager.ts — markRunSubscribersForTerminalDrain
sub.closingReason = 'terminal'

// Cancel the per-subscriber timers FIRST, so a duration/heartbeat timer can't
// fire mid-drain and close with the wrong reason (e.g. 'max-duration').
if (sub.maxDurationTimer !== undefined) { deps.clearTimeout(sub.maxDurationTimer); sub.maxDurationTimer = undefined }
if (sub.heartbeatTimer !== undefined) { deps.clearInterval(sub.heartbeatTimer); sub.heartbeatTimer = undefined }

if (sub.queue.length === 0) {
  finalizeTerminalSubscriber(sub)            // nothing queued — close now
} else if (sub.writerRunning === false) {
  sub.writerRunning = true
  drainQueue(sub).catch(() => {})            // queued frames pending — let the writer deliver them, then close
}
// (writer already running → trust it to finalize when the queue empties)

// --- drainQueue --- finalizes on empty *only* in terminal mode:
if (sub.queue.length === 0 && sub.closingReason === 'terminal') {
  sub.writerRunning = false
  finalizeTerminalSubscriber(sub)            // → sub.callbacks.onClose('terminal')
  return
}
```

Apply the **same** drain-state invariant everywhere a subscriber can enter terminal — both the live terminal path and the late-subscriber replay path — so there is exactly one closing discipline. Cancel per-subscriber duration/heartbeat timers when terminal drain begins, so a timer can't preempt the drain and close with the wrong reason.

### 2. The completeness guarantee is a triad, not a single mechanism

**(a) Ordering — the final content must be enqueued before the terminal status.** If the terminal status fans out first, the consumer can see "succeeded" with no answer. Defer the terminal observer-notify until after the content flush:

```ts
// run.ts — capture the terminal state, flush the final output, THEN notify
if (answerResult.transition === 'delegated') {
  await replySink.flush().catch(/* fail-soft */)  // pushes the final output frame
}
if (completedStateForNotify !== undefined) {
  notifyObserverBestEffort(deps, completedStateForNotify) // fans the terminal status frame
}
```

This reorder is inert for transports that post their output independently (e.g. a Discord thread); pin that with a characterization test.

**(b) A bounded terminal-replay cache for late subscribers.** A consumer connecting *after* the run finished must still get the answer. Cache the final output + terminal status past terminal, bounded three ways — TTL, entry count, **and total bytes** (content frames can be large; an entry-count cap alone leaves memory unbounded):

```ts
const DEFAULT_TERMINAL_REPLAY_TTL_MS = 10 * 60 * 1000
const DEFAULT_TERMINAL_REPLAY_MAX_ENTRIES = 500
const DEFAULT_TERMINAL_REPLAY_MAX_BYTES = 8 * 1024 * 1024

// On terminal: cache {finalOutput, terminalStatus} with a TTL eviction timer,
// track bytes, and enforce the caps. The late-subscriber path replays
// final-output → terminal-status → graceful drain → close:
if (replayEntry.finalOutput !== undefined) enqueueOutputFrame(sub, outputFrame)
if (replayEntry.terminalStatus !== undefined) enqueueFrame(sub, statusFrame)
sub.closingReason = 'terminal'
// ...same drain-state invariant as rule 1
```

Funnel every eviction (TTL, count cap, byte cap) through one `evictTerminalReplayEntry` that keeps the byte counter, the per-run seq counter, and the terminal-seen set in lockstep; clear all eviction timers on shutdown.

**(c) Coalesce content frames under overflow — don't drop the connection.** Status frames can drop a slow subscriber on overflow (the next status supersedes). Content frames must not: coalesce pending output, carry a cumulative `droppedCount`, keep the connection alive. The authoritative final frame restores completeness regardless of what was coalesced.

### 3. Measure the *effective* frame before the cap check

When a frame is rewritten before enqueue — here, merging the accumulated `droppedCount` makes the frame larger — the queue-byte cap check must measure the **rewritten** frame, not the original. Otherwise `queueBytes` grows by more than the check approved, drifts above the cap, and triggers spurious coalescing on frames that actually fit:

```ts
// Build the effective frame and measure it BEFORE the cap comparison,
// then use the same value for both the check and the increment.
const effectiveFrame: OutputFrame =
  sub.coalescedDropCount > 0
    ? {type: 'output', data: {...frame.data, droppedCount: (frame.data.droppedCount ?? 0) + sub.coalescedDropCount}}
    : frame
const effectiveBytes = estimateFrameBytes(effectiveFrame)
if (sub.queueBytes + effectiveBytes <= subscriberQueueCapBytes) {
  sub.coalescedDropCount = 0              // reset — the count is now carried in effectiveFrame
  sub.queue.push(effectiveFrame)
  sub.queueBytes += effectiveBytes        // same value the check used — no drift
}
```

### 4. Dequeue before you await

A writer draining a queue must `shift()` the frame off the queue **before** awaiting its delivery. Otherwise a concurrent coalescing splice can mutate or remove the frame that is mid-delivery:

```ts
while (sub.queue.length > 0) {
  const frame = sub.queue.shift()   // writer owns the frame now
  if (frame === undefined) break    // (defensive: writerRunning gates a single drainer)
  // ...adjust queueBytes...
  await sub.callbacks.onEvent(frame) // coalescing can splice the *rest* of the queue safely
}
```

### 5. Guard against out-of-order async projections

If the observations feeding the stream are async and can resolve out of causal order, a stale **non-terminal** state resolving *after* terminal must not regress the cached terminal status or evict the replay entry. Track a per-run terminal-seen set and drop late non-terminal observations:

```ts
if (isTerminal(projected.status) === false && terminalRuns.has(runId) === true) {
  logger.warn(/* ... */, 'non-terminal observe arrived after terminal — dropping stale observation')
  return
}
if (isTerminal(projected.status) === true) {
  terminalRuns.add(runId)
  // ...cache the terminal replay entry...
}
```

### 6. Wire the producer-side sink fail-soft

The component that feeds content into the manager (here, the run's reply sink) must never let a manager fault break the run. Wrap the `observeOutput` calls so a streaming error degrades the *stream*, not the *run*:

```ts
append: (text) => { buffer += text; try { deps.observeOutput(text) } catch { /* fail-soft */ } },
flush:  async () => { try { deps.observeOutput(buffer, {final: true}) } catch { /* fail-soft */ } },
```

## Why This Matters

Each rule maps to a concrete failure that a security-weighted multi-reviewer pass (plus an Oracle consult) caught — failures the implementation and the author's own verification had missed:

| Rule | Failure it prevents |
|------|---------------------|
| Terminal = graceful drain | Consumer sees the run finish with the final answer dropped (it was queued behind earlier frames) |
| Ordering (content before terminal) | Consumer sees "succeeded"/"failed" with no answer at all |
| Bounded replay cache | A consumer connecting after completion gets nothing — and an unbounded cache OOMs the process |
| Coalescing, not disconnect | A burst of output kills the operator's connection |
| Effective-byte accounting | `queueBytes` drift coalesces frames that actually fit, degrading output for no reason |
| Dequeue-before-await | The in-flight frame is corrupted by a concurrent coalescing splice |
| Out-of-order guard | A late EXECUTING projection regresses a committed terminal state / corrupts the replay cache |
| Fail-soft sink | A transient streaming fault aborts the whole run |

The meta-lesson: for a concurrency state machine, an **adversarial review pass on the new machinery is high-value even after the author believes it is correct.** Two of these were real P1 bugs found only because the review constructed the precise interleavings, then Oracle diagnosed them as one missing invariant — *terminal is an end-of-stream boundary, not an abort.*

## When to Apply

Any time you fan out **ordered content plus a terminal signal** over a bounded-queue pub/sub to live *and* late subscribers: SSE/WebSocket run observation, log/output streaming, progress-then-result channels. The triad (ordering + bounded replay cache + coalescing) is the part that is easy to under-build — a single "cache the final frame" is not enough without the ordering guarantee and the graceful drain.

## Examples

**Terminal drain vs hard close** — the core inversion. Before: terminal clears the queue and closes (drops the queued final frame). After:

```ts
sub.closingReason = 'terminal'
if (sub.queue.length === 0) finalizeTerminalSubscriber(sub)
else if (sub.writerRunning === false) { sub.writerRunning = true; drainQueue(sub).catch(() => {}) }
```

**Ordering fix** — flush the final content, *then* notify terminal:

```ts
if (answerResult.transition === 'delegated') await replySink.flush().catch(/* ... */)
if (completedStateForNotify !== undefined) notifyObserverBestEffort(deps, completedStateForNotify)
```

**Effective-byte accounting** — measure the rewritten frame before the cap check (see rule 3).

## See also

- [authenticated-sse-run-observation](./authenticated-sse-run-observation-2026-06-20.md) — the auth/redaction-before-authz/fail-closed-teardown layer for the same surface (the layer *below* this one).
- [gateway-control-surface-spine](./gateway-control-surface-spine-2026-06-15.md) — the transport-neutral seam this rides on.
- [web-operator-launch-surface](./web-operator-launch-surface-2026-06-20.md) — the write counterpart (launching a run); this doc is the read/observation counterpart.
- [atomic-serial-channel-queue-handoff](./atomic-serial-channel-queue-handoff-2026-06-09.md) — adjacent queue-drain/handoff discipline.

Source: PR #974 (#965), advancing #907. Files: `packages/gateway/src/web/sse/manager.ts`, `packages/gateway/src/web/operator/web-sinks.ts`, `packages/gateway/src/execute/run.ts`, `packages/gateway/src/web/sse/run-stream-route.ts`, `packages/gateway/src/operator-contract/output.ts`.
