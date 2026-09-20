---
title: Read the test count before blaming the file — a dying Vitest worker still exits 0
date: 2026-09-19
category: workflow-issues
module: gateway
problem_type: workflow_issue
component: testing_framework
severity: medium
applies_when:
  - Vitest prints a heap error but the summary still reports a nonzero test count
  - A run exits 0 while its passed count is below what was collected
  - A large test file is blamed for a crash before the count line is read
  - A stub drives a queue, drain, retry, or poll loop
  - An assertion follows a call that dispatches work without awaiting it
tags: [vitest, heap-exhaustion, silent-pass, misdiagnosis, unbounded-mock, fire-and-forget]
---

# Read the test count before blaming the file — a dying Vitest worker still exits 0

## Context

A Vitest worker died of heap exhaustion:

```
FATAL ERROR: Ineffective mark-compacts near heap limit
Allocation failed - JavaScript heap out of memory
 Test Files   (1)
      Tests  228 passed (239)
```

**Vitest exited 0.** Eleven tests never ran and nothing reported that as a failure.

The file was ~9,000 lines, so its size was blamed — supported by a claim that the crash reproduced with a `-t` filter matching zero tests. An issue was filed on that basis, a follow-up comment reinforced it, and a ~1,000-line split into seven topic files was dispatched as the fix.

The diagnosis was wrong, and the disproof was inside the evidence quoted to support it.

The real cause was one test stubbing a queue with `mockReturnValue(pendingTask)` — unbounded — where its seven siblings used the one-shot form. Once the code handed off its slot, every subsequent hand-off found another task waiting. The worker allocated until it died.

## Guidance

### Read the test count first

It discriminates the two causes, and nothing else in the output does:

| Output | Meaning |
|---|---|
| Heap error, **nonzero** count | Tests **executed**. Execution-time failure — almost always a runaway loop. |
| Heap error, **zero** count | Nothing ran. Collection-time failure, where file size is a real suspect. |

`Tests 228 passed (239)` means 228 tests ran to completion before the worker died. A collection-time failure cannot produce that number, because collection precedes execution. Reading past it cost an issue filed on the wrong cause and a large unnecessary refactor dispatched off it.

A green exit code does not override a mismatched count. Treat `passed < collected` as a failure regardless of what the runner returns.

### Confirm with the cheapest experiment

Apply the suspected one-line fix to the **original, unmodified** file and run it. If the heap error disappears and the full count passes, size was never the problem.

That experiment takes a minute and is decisive. Running it earlier would have prevented everything downstream of the misdiagnosis.

### Bound every stub that can drive a loop

Any stub feeding a queue, drain, retry, poll, or hand-off must terminate — including a **defensive** stub in a test asserting the loop never runs.

That case matters most. While the code is correct the stub is never consumed, so an unbounded stub is dormant and invisible. If the behaviour ever regresses, the test that exists to catch it hangs and exits 0 instead of failing. Its failure mode is silent exactly when it is needed.

### Give a fire-and-forget dispatch a settle point

If the code under test schedules work without awaiting it, an assertion placed immediately after `await` runs before that work can happen. It passes whether or not the behaviour is correct, and measures nothing.

## Why This Matters

A suite that cannot finish while reporting success is worse than one that fails. It does not merely withhold information — it actively asserts something untrue, with the same green check a real pass produces.

That is what made this expensive. Locally the bad stub looked like a pass for as long as the worker survived. CI had less headroom, so the same defect became a hard failure there — and by then the symptom pointed at the file, not the loop. The misdiagnosis was not carelessness about the evidence; it was reading evidence that was genuinely ambiguous *unless* you know which number discriminates.

The file split was kept, because splitting a 9,000-line test file has independent value. But it was not the fix, and treating it as one would have left the real defect in place.

## When to Apply

- `FATAL ERROR: Ineffective mark-compacts near heap limit` with a nonzero test count
- Any run whose passed count is below its collected count, whatever the exit code
- A large test file blamed for a crash before the counts are compared
- Reviewing a test that stubs hand-off, queueing, retry, draining, or polling
- Reviewing an assertion that follows a call known to dispatch work without awaiting it

## Examples

### Unbounded versus one-shot

```ts
// hangs the worker once the loop is entered
;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValue(pendingTask)

// terminates — packages/gateway/src/execute/run.quarantine.test.ts:89-95, :246
;(queue.takeNext as ReturnType<typeof vi.fn>)
  .mockReturnValueOnce(pendingTask)
  .mockReturnValue(undefined)
```

### Asserting before the work can happen

```ts
// passes whether or not the hand-off occurred
await runMention(message, makeBinding(), deps)
expect(mockRunOpenCodeCore).toHaveBeenCalledTimes(2)

// observes the settled state — run.quarantine.test.ts:103-122
await runMention(message, makeBinding(), deps)
await new Promise<void>(resolve => {
  setImmediate(resolve)
})
expect(mockRunOpenCodeCore).toHaveBeenCalledTimes(2)
```

Reintroducing the bare form makes the second test fail in under a second with a clear assertion error, which is how it was verified to be load-bearing rather than ceremony.

### The diagnosis

> "The file is too large, so Vitest dies during collection."

against

> "A test is executing an unbounded loop, so the worker allocates until it dies."

The count line separates them. Everything else is noise until it has been read.

## Related

- `docs/solutions/workflow-issues/a-check-written-from-inside-its-own-premise-cannot-fail-2026-09-04.md` — a passing check is the strongest false signal available. The unbounded defensive stub is a direct instance.
- `docs/solutions/workflow-issues/verify-behavior-not-signal-2026-08-23.md` — a present signal is not evidence of the effect it implies. Exit 0 here is precisely that.
- `docs/solutions/best-practices/matching-error-signature-is-not-a-matching-root-cause-2026-08-07.md` — compare stages, not strings. The heap error matched a size-shaped signature and had a different cause.
- Issue #1630 (closed, misdiagnosed — reasoning recorded there), issue #1631 (open, the runner reporting exit 0 on worker death).
