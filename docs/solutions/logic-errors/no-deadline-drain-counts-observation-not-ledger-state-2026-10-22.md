---
title: With timeout 0, drain waits on observed running work and exits on consecutive passes that observe nothing
date: 2026-10-22
category: logic-errors
module: agent-execution
problem_type: logic_error
component: service_object
symptoms:
  - "timeout: 0 cancels owned background work as soon as the main session ends"
  - "Overflow recovery never runs under timeout: 0 because its remaining budget is negative"
  - "With no deadline, an entry that can never be confirmed keeps isDrainComplete() false, so cleanup never runs"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - runtime
tags:
  - drain
  - timeout-zero
  - ownership-ledger
  - observation
  - overflow-recovery
---

## Problem

`timeout: 0` means the Action sets no deadline of its own. The workflow's `timeout-minutes` or GitHub's job limit is then the only thing that stops the job. Two consumers of the input did not follow that. The drain budget floored to 0, so owned background work was cancelled the moment the main session returned. Overflow recovery computed a negative remaining budget and never ran. A drain with no deadline has a further hazard: an entry that can never be confirmed would hold the drain open forever, so cleanup (cache save, lock release, reply) would never run.

## Symptoms

- With `timeout: 0`, drain logs `Drain deadline reached — cancelling unsettled owned work; run reports incomplete` immediately after execution ends.
- `recoverFromContextOverflow` returns the original failure under `timeout: 0` without retrying.
- After the deadline fix, two kinds of entry stay `unknown` indefinitely: one whose server is dead, and one whose session is not a direct child of the parent. `runDrain` never returns.

## What Didn't Work

- **Counting passes where every unsettled entry is `unknown`.** One transient failure marks a live child `unknown`, and `reconcileLedgerOnce` never moves it back. The streak then counted a running child as unobservable, and drain cancelled live work after three passes.

## Solution

`reconcileLedgerOnce` returns what the pass observed as well as what it changed, through `ReconcileObservation` in `packages/runtime/src/agent/ledger-reconcile.ts:183-190`:

```ts
export interface ReconcileObservation {
  readonly liveTrackedSessionIds: ReadonlySet<string>
}
```

The set holds only unsettled entries whose session the pass saw as a live direct child of the parent. An `unknown` entry seen running stays `unknown` in the ledger, so this set is the only record that it is running.

`computeDrainDeadlineMs` in `src/harness/phases/execute.ts:586` treats a non-positive total as having no deadline:

```ts
if (totalTimeoutMs <= 0) return Number.POSITIVE_INFINITY
```

`runDrain` counts only passes that observed nothing running (`src/harness/phases/execute.ts:795-803`):

```ts
const reconcilePass = async (): Promise<void> => {
  const observedRunning = await reconcileBounded(reconcileOptions, () => waitEnded)
  if (waitEnded) return
  const workRemains = ledger.snapshot().some(entry => entry.state !== "settled")
  consecutiveUnobservablePasses = workRemains && observedRunning === false ? consecutiveUnobservablePasses + 1 : 0
}
const hasDeadline = Number.isFinite(deadlineMs)
const unobservable = (): boolean =>
  hasDeadline === false && consecutiveUnobservablePasses >= UNOBSERVABLE_PASSES_BEFORE_DRAIN_EXIT
```

When there is no deadline, the wait ends after `UNOBSERVABLE_PASSES_BEFORE_DRAIN_EXIT` (3) consecutive unobserved passes. Drain then goes to `cancelOutstanding`, reports ownership as unresolved, and cleanup runs. With a finite deadline the deadline governs and the streak is ignored.

Overflow recovery in `src/harness/phases/execute.ts:212-216` treats `timeoutMs <= 0` as unbounded, and the recovery attempt keeps `timeoutMs: 0`.

## Why This Works

- A pass observes running work when a tracked, unsettled entry is a live direct child of the parent. That is a fact about the server at that moment and does not depend on earlier failures.
- A pass that fails, times out, or sees no tracked live child is the only evidence that the work cannot be waited on. A dead server fails every pass, and an entry that is not a child is never seen as a live child.
- Any pass that observes running work resets the streak, so transient failures never add up to an exit.
- After the exit, ownership is reported as unresolved. That is accurate: drain does not claim the work finished.

## Prevention

- A rule that gives up waiting must use what the last pass observed, never ledger state that cannot move back.
- Code that derives a budget from `timeoutMs` handles `0` itself. `computeDrainDeadlineMs` and overflow recovery each check `timeoutMs <= 0`, and `createExecutionDeadline`'s caller maps it to no deadline.
- Tests in `src/harness/phases/execute.test.ts`:
  - `keeps waiting past 3 passes and settles it when it finishes (%s)` pins the rejected ledger-state streak.
  - `resets the unobservable streak on a pass that observes the child running` pins the reset.
  - `stops waiting after 3 unknown passes when every reconcile call fails, and reports unresolved ownership` pins the exit.
- The `observation` group in `packages/runtime/src/agent/ledger-reconcile.test.ts` pins `liveTrackedSessionIds`.

## Related Issues

- #1906
- `docs/solutions/logic-errors/terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md`
- `docs/solutions/logic-errors/gateway-root-not-aborted-on-early-stop-2026-10-22.md`
- `docs/solutions/logic-errors/bound-and-guard-every-reconcile-pass-2026-10-22.md`
