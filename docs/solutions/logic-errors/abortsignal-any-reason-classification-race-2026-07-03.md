---
title: Classifying an abort by AbortSignal.any's composite reason is racy — use a side-channel
date: 2026-07-03
category: logic-errors
module: gateway/execute
problem_type: logic_error
component: assistant
symptoms:
  - A cancel and a timeout firing close together could be misclassified
  - The composite signal's reason reflects whichever child aborted first, not which one you care about
  - Reading combinedSignal.reason to decide cancel-vs-timeout is a data race
root_cause: async_timing
resolution_type: code_fix
severity: high
tags:
  - abortsignal
  - abortsignal-any
  - race-condition
  - cancel-vs-timeout
  - side-channel-classification
  - signal-composition
---

# Classifying an abort by AbortSignal.any's composite reason is racy — use a side-channel

## Problem

When several abort sources are composed with `AbortSignal.any([...])`, the resulting composite signal aborts with the **reason of whichever child fired first**. Deciding *why* the operation aborted (e.g. operator cancel vs. wall-clock timeout vs. inactivity) by inspecting the composite signal's `.reason` is therefore a race — if two sources fire in quick succession, the reason you read is a coin flip on scheduling order.

## Symptoms

- A run aborted by an operator cancel that also happened to be near its timeout ceiling could be classified as a `timeout` (or vice versa), driving the wrong terminal state and the wrong user-facing message.
- `combinedSignal.reason` / `combinedSignal.aborted` tells you *that* it aborted and *the first* reason, not *which* of your sources you need to branch on.

## What Didn't Work

- **Inspecting the composite reason.** `AbortSignal.any([timeout, cancel])` yields one signal; reading its `.reason` to distinguish cancel from timeout assumes the source you care about is the one that won the race. It isn't guaranteed.
- **Passing a custom reason into `abort(reason)`.** Even with distinct reasons per source, the composite still only surfaces the *first* fired source's reason — a distinguishable reason on the loser is invisible.

## Solution

Compose the signals for their *effect* (cancel the operation), but classify from an authoritative **side-channel** that records intent independently of scheduling order. Here, an abort registry whose `abort()` records the run and whose `isAborted(runId)` is queried in the catch handler:

```ts
// packages/gateway/src/execute/run.ts — compose for effect
const effectiveSignal = AbortSignal.any([timeoutSignal, cancelSignal])
// ... run under effectiveSignal ...

// classify from the registry, NOT from the composite reason:
const wasCancelled = abortRegistry.isAborted(runId)
if (wasCancelled === true) {
  // settle CANCELLED
} else {
  // settle FAILED/timeout
}
```

```ts
// packages/gateway/src/execute/abort-registry.ts — the side-channel ground truth
function abort(runId: string, reason?: string, meta?: CancelledByMetadata): boolean {
  const entry = controllers.get(runId)
  if (entry === undefined) return false
  entry.aborted = true          // ← recorded intent, order-independent
  entry.controller.abort(reason)
  return true
}
function isAborted(runId: string): boolean {
  return controllers.get(runId)?.aborted === true
}
```

`AbortSignal.any` still nests cleanly with any inner composition (e.g. run-core's own inactivity `AbortSignal.any`) — the fix is not about *how* to compose, it's about *not classifying from the composite*.

## Why This Works

The registry records the *cause* the moment it is requested, decoupled from the timing of when each signal's abort event propagates. Whichever signal wins the race to fire, the registry still knows the operator requested a cancel, so classification is deterministic. The composite signal is used only for its job — aborting the work — not as a source of truth about why.

## Prevention

- **Never branch behavior on `AbortSignal.any(...).reason`.** If you compose N signals and need to know which one fired, keep a per-source flag/registry and consult that.
- **Separate "abort the operation" from "explain the abort."** Composition handles the former; a side-channel handles the latter.
- **Test the near-simultaneous case.** A test where both the timeout and the cancel are armed and the cancel is requested must assert the classification comes out as cancel regardless — pin that the composite reason is *not* consulted.

## Related Issues

- fro-bot/agent#1111 — operator run cancellation; the settlement path classifies cancel-vs-timeout via the registry probe.
- [Gateway OpenCode mention-loop best practices](../best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md) — `AbortSignal.timeout` composition + bounded-execution discipline this builds on.
- [Authenticated SSE run observation](../best-practices/authenticated-sse-run-observation-2026-06-20.md) — fail-closed teardown / lease timing in the same async-signal family.
