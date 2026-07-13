---
title: Extract the timer primitive, keep the timeout policy per surface
date: 2026-07-13
category: best-practices
module: runtime
problem_type: best_practice
component: service_object
severity: medium
applies_when:
  - "Two execution surfaces need the same timing mechanics with different reset/pause policy"
  - "Converging duplicated timeout logic without forcing one surface's policy onto another"
  - "A refactor must be provably behavior-preserving"
tags: [inactivity-timer, abort-signal, shared-primitive, policy-boundary, behavior-preserving-refactor]
---

# Extract the timer primitive, keep the timeout policy per surface

## Context

The GitHub Action and the gateway tracked run timeouts divergently. The gateway had a resettable 5-minute inactivity window (reset on text deltas and tool completions, paused during approval waits). The action had only a hard ceiling plus a 90s startup-stall watchdog. Converging them risked either duplicating the timer mechanics across both surfaces or smuggling one surface's policy into the other.

## Guidance

Extract only the mechanism into a dependency-free primitive, and leave every policy decision — which events reset the timer, when to pause it, whether the window exists at all — in the caller.

`createInactivityTimer` (`packages/runtime/src/agent/inactivity-timer.ts`) owns the mechanics only:

```ts
export interface InactivityTimer {
  /** Aborts when the configured window elapses without a `reset()` call. Stable for the instance's life. */
  readonly signal: AbortSignal
  /** Clears any pending timeout and re-arms a fresh window. No-op when inert. */
  readonly reset: () => void
  /** Clears the pending timeout without aborting — the timer goes dormant until `reset()` or `resume()`. */
  readonly pause: () => void
  /** Re-arms a fresh window after a `pause()`. Equivalent to `reset()`. No-op when inert. */
  readonly resume: () => void
  /** Clears any pending timeout and marks the instance inert. Never aborts. Safe to call multiple times. */
  readonly dispose: () => void
}
```

`timeoutMs <= 0` produces an inert instance whose signal never aborts — callers that treat "no timeout configured" as "feature disabled" get that for free.

The gateway (`packages/gateway/src/execute/run-core.ts`) composes the primitive with its own event-driven policy:

```ts
// When inactivityTimeoutMs is set (>0), the shared `createInactivityTimer` primitive
// arms a timeout that fires after the configured window of silence. It is reset on
// every text delta, tool completion, and permission.replied event. It is paused on
// permission.asked and resumed+reset on permission.replied.
const inactivityTimer = createInactivityTimer({timeoutMs: inactivityTimeoutMs ?? 0})
```

The gateway's pre-existing timeout tests passed unchanged after the refactor onto the shared primitive — the unchanged-tests property is the behavior-preservation proof, not an assertion of it.

The action deliberately did not adopt an inactivity window. CI runs execute single long tool calls (full builds, complete test suites) that legitimately emit nothing for many minutes; a rolling inactivity window sized for interactive mention-driven runs would false-abort them. Non-adoption here is documented policy, not an omission.

## Why This Matters

A "shared abstraction" that carries policy across surfaces couples workloads with different characteristics — an interactive Discord mention loop and a batch CI run don't share an idle-time definition, even though they share timer mechanics. The primitive/policy split keeps the reusable part small and lets each surface make workload-appropriate choices without either surface reaching into the other's decisions.

## When to Apply

- Two or more call sites need identical timing/abort mechanics but different triggering rules.
- A convergence refactor is proposed and the risk is one surface's semantics leaking into another.
- Verifying a refactor didn't change behavior — an existing test suite passing unchanged is stronger evidence than new tests written after the fact.

## Examples

Primitive (mechanism, no policy):
```ts
const inactivityTimer = createInactivityTimer({timeoutMs: 0}) // inert — never aborts
```

Caller (policy, no mechanism):
```ts
const inactivityArmed = inactivityTimeoutMs !== undefined && inactivityTimeoutMs > 0
function resetInactivity(): void {
  if (!inactivityArmed) return
  inactivityTimer.reset()
}
```

## Related

- [AbortSignal.any() reason-classification race](../logic-errors/abortsignal-any-reason-classification-race-2026-07-03.md) — a related hazard when composing this primitive's `signal` with other abort sources via `AbortSignal.any`.
