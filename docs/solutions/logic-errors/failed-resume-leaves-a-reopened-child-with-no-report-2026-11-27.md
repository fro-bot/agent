---
title: A failed resume leaves a reopened child waiting for a report that never comes
date: 2026-11-27
category: logic-errors
module: agent-execution
problem_type: logic_error
component: background_job
symptoms:
  - "Before the fix, review predicted that a resumed grandchild stays outstanding, then unknown, after its resume call fails, and that isDrainComplete() stays false: a finite-budget drain waits until its deadline, and a timeout-0 drain exits as unobservable with the ledger still incomplete"
  - "Before the fix, review predicted that if the prompt never reached the resumed child, no report would settle the entry the reopen made owed"
root_cause: async_timing
resolution_type: code_fix
severity: medium
tags:
  - subagent
  - resume
  - ownership-ledger
  - drain
  - reconcile
  - opencode-v2
---

# A failed resume leaves a reopened child waiting for a report that never comes

## Problem

A resume reopens the child's ledger entry on `tool_progress` (see the admission doc). Upstream emits that progress before it submits the prompt, so if prompt submission fails after progress ("Failed to prompt subagent"), the prompt may not reach the child and a report may never arrive. Review identified this path in #2262. It was not observed live.

## Symptoms

- Before the fix, review predicted that the reopened entry would stay outstanding after a failed call, because no report would come to settle it.
- Before the fix, review predicted that a deeper entry would be marked `unknown` on every reconcile pass and hold `isDrainComplete()` false. With a finite budget the drain waits until its deadline. With `timeout: 0` it exits as `unobservable` after three passes that see no owned work running, with the ledger still incomplete (`src/features/agent/drain-v2.ts:409-419`).

## What Didn't Work

The first version reopened the entry on progress and nothing handled a failed finish. It relied on reconcile to settle any child that was no longer live, but reconcile lists only the root's direct children (`packages/runtime/src/agent/ledger-reconcile.ts:222`). It settles a direct child that is not live (`:266`) and downgrades any other entry with `markUnknown` (`:251-257`), so a resumed grandchild was never settled.

## Solution

Record at reopen time whether the entry was settled beforehand (`src/features/agent/streaming-v2.ts:356-361`):

<!-- prettier-ignore -->
```ts
    resumedCalls.set(key, {
      childSessionId,
      settleOnFailure: readLedgerState(ownershipLedger, childSessionId) === 'settled',
    })
    ownershipLedger.resume(childSessionId)
    noticedChildIds.delete(childSessionId)
```

Then settle it again when the call ends `failed` (`streaming-v2.ts:371-376`). The `tool_finished` case calls this on every finish (`:530`), so each key is cleared:

<!-- prettier-ignore -->
```ts
  const settleResumeOnFailure = (key: string, outcome: 'failed' | 'success'): void => {
    const resumed = resumedCalls.get(key)
    resumedCalls.delete(key)
    if (ownershipLedger === undefined || resumed === undefined || outcome !== 'failed' || !resumed.settleOnFailure)
      return
    ownershipLedger.settle(resumed.childSessionId)
```

## Why This Works

The reopen is the only thing that moved the entry out of `settled`, so undoing it on failure restores what the stream found. A child that was already running keeps its run, because its report is still owed. If the prompt did start, the directory gate still holds release (`src/features/agent/drain-v2.ts:424-429`; see the admission doc).

## Prevention

When a transition owes a future event, give every failure exit of the call that created the debt a matching undo, and pin each depth and prior state: `src/features/agent/streaming-v2.test.ts:1581` (child), `:1597` (grandchild) and `:1658` (already running).

## Related Issues

- #2262
- [Admit a same-run subagent resume on host-observed ownership](../best-practices/admit-a-same-run-subagent-resume-on-host-observed-ownership-2026-11-27.md)
- [With timeout 0, drain waits on observed running work](./no-deadline-drain-counts-observation-not-ledger-state-2026-10-22.md)
- [Every ownership-ledger reconcile pass needs a bound, a signal and a guarded ledger](./bound-and-guard-every-reconcile-pass-2026-10-22.md)
