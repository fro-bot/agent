---
title: A coordination field written empty at creation and never updated silently breaks every reader
date: 2026-07-03
category: logic-errors
module: gateway/coordination
problem_type: logic_error
component: assistant
symptoms:
  - Discord runs never surfaced waiting_for_approval on the operator SSE surface
  - Startup recovery interruption thread-notes were never posted for real runs
  - All unit tests passed despite the field being empty in production
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - run-state
  - thread-id
  - coordination-drift
  - approval-scope
  - test-fake-blind-spot
  - persist-at-adoption
---

# A coordination field written empty at creation and never updated silently breaks every reader

## Problem

`RunState.thread_id` was written as the empty string at run admission and never written back after the Discord thread was created. Every consumer that resolved the discord approval scope or origin thread from run-state read an empty value, so operator-visible approval status and recovery thread-notes silently did nothing — while all unit tests passed.

## Symptoms

- `web/sse/projection.ts` `scopeIdFor` returned `''` for discord runs, so `hasPendingForScope('')` never matched a real approval → the operator SSE surface never showed `waiting_for_approval` for a discord run.
- `execute/recovery.ts` posted interruption notes via `resolveThread(run.thread_id)` → `''` resolved nothing → recovery thread-notes effectively never posted.
- The whole unit suite was green — the bug was invisible to tests.

## What Didn't Work

- **Trusting the tests.** Coverage looked thorough, but every test that touched `thread_id` hand-built a `RunState` fake with `thread_id: 'thread-1'` populated. The fakes encoded the *intended* state, not the *actual* admission shape (`thread_id: ''`), so they masked the write-path gap entirely.
- **Reading the stale comment.** The adoption transition carried a comment asserting `thread_id` "is not load-bearing for run-state" — an assumption that was false the moment any consumer began resolving the approval scope from it.

## Solution

Persist the live thread id at run adoption. `threadFactory` produces the real thread id immediately before the `PENDING → ACKNOWLEDGED` transition, so fold it into that same conditional write — no extra round-trip, `ifMatch` etag gate unchanged:

```ts
// packages/gateway/src/execute/run.ts — the ACK transition
const ackResult = await transitionRun(
  coordinationConfig, identity, repo, runId, 'ACKNOWLEDGED', task.adoptionEtag, coordLogger,
  {threadId}, // ← live thread id from threadFactory, persisted atomically with the phase
)
```

```ts
// packages/runtime/src/coordination/run-state.ts — merge only when non-empty
const threadId = options?.threadId
const nextState: RunState = {
  ...parsedCurrent.data,
  phase: newPhase,
  ...(threadId !== undefined && threadId !== '' ? {thread_id: threadId} : {}),
}
```

Runs with no thread (`threadFactory === undefined`, `threadId` stays `''`) keep an empty `thread_id`, which is correct. Web/GitHub surfaces scope on `run_id` and were never affected. Fixing the one missing write repaired discord approval-scope resolution *and* recovery thread-notes at the root.

## Why This Works

The failure was a **write-path gap, not a read-path bug**: readers were correct; the value they read was never populated. A field initialized empty at creation with an implicit "will be filled in later" that never happens is a silent-degradation trap — no error, no crash, just quietly wrong behavior in every consumer. Persisting at the first transition after the value becomes known closes the gap atomically with an already-required write.

## Prevention

- **When a feature depends on a persisted field, verify the write path, not just the declaration.** Grep for where the field is *written* with a real value, not only where it's typed or read.
- **Distrust populated test fakes for persistence bugs.** A fake that hand-sets the field to a realistic value proves the reader works, not that production ever writes it. Add at least one test that exercises the *real* creation/admission path and asserts the stored value (via the store fake's written body), not a hand-built object.
- **Treat "field X is not load-bearing" comments as expiry-dated.** The moment a new consumer resolves behavior from X, the comment is a lie. When adding such a consumer, audit the write path of the field it depends on.
- **Prefer folding a newly-known value into an already-required conditional write** over a separate follow-up write (which needs its own etag round-trip and can race).

## Related Issues

- fro-bot/agent#1109 — the fix.
- fro-bot/agent#1111 — the operator run-cancellation feature that exposed the gap (discord approval settlement + thread notice both read `thread_id`).
- [Centralize resource-key/identity construction to prevent silent cross-signal drift](../best-practices/centralize-s3-key-identity-construction-2026-06-09.md) — sibling silent-coordination-drift pattern; that one is about the *key* being wrong, this one is about the *value* being empty.
- [@actions/core input env-var mapping gotcha](actions-core-input-env-hyphen-mapping-2026-07-01.md) — same family: a silent gotcha that green tests miss because the fakes encode the intended shape.
