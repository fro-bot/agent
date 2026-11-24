---
title: Recover a persistent agent session from context overflow without breaking continuity
date: 2026-08-03
last_updated: 2026-11-23
category: best-practices
module: agent-execution
problem_type: architecture_pattern
component: development_workflow
applies_when:
  - "Recovering a long-lived persistent agent session from ContextOverflowError"
  - "Session continuity across runs is a core product value that recovery must preserve"
  - "Recovery needs one bounded restart with a shared deadline across attempts"
tags:
  - context-overflow
  - session-recovery
  - session-continuity
  - phase-layer
  - execution-deadline
  - bounded-restart
---

# Recover a persistent agent session from context overflow without breaking continuity

## Context

A persistent, long-lived agent session (continued across CI runs by a stable logical key) can accumulate enough transcript to exceed the model context window and emit `ContextOverflowError`. If that terminally fails a required check, the run wedges and re-running just re-continues the same overflowed session. The fix must make overflow **recoverable** without discarding the persistent continuity that is the product's core value.

## Guidance

- **A fresh session drops the bloated transcript by construction — that is the primary size reduction.** Restarting on a new session (not continuing the overflowed one) is what actually escapes the overflow. Bounded prior-work recall (excluding the archived session from search and capping the result count) is **defense-in-depth**, not the primary mechanism.
- **Orchestrate recovery at the phase layer, not inside the single-attempt executor.** Only the phase layer (`runExecute`) holds the session-prep, client, logical key, and workspace needed to rebuild the bounded prior-work search _excluding the just-archived session_. Keep the single-attempt executor (`executeOpenCodeV2`, in `src/features/agent/execution-v2.ts`) as "run one attempt under a deadline." Pushing recovery down into the executor forces a downward layering leak and makes the exclusion impossible.
- **Share one absolute deadline across both attempts.** The executor mints its own deadline from `config.timeoutMs`, so a naive second call would grant a fresh full budget. Thread the _remaining_ budget (`timeoutMs − elapsed`) into the recovery attempt; if it is `<= 0`, do not restart.
- **Bound to exactly one restart; next-run recovery is the floor.** If the fresh session also overflows, archive it too and fail cleanly — no loop (`src/harness/phases/execute.ts:264-271`). Because archival is best effort, the next run starts fresh only when the archive succeeded; a failed archive logs a warning and does not block the restart, so the next run may re-continue the overflowed session (`:187-192`).
- **Never key the session on head SHA just to bound growth.** Fragmenting the continuity key (`pr:<number>:<sha>`) would discard the persistent memory on every push — the antithesis of a persistent-session product. Bound growth via recovery/compaction, not by fragmenting the identity key.
- **Drain the overflowed session's writers before anything else.** Archiving does not stop the overflowed session's own subagents, so recovery first cancels and settles whatever that session still owns (`backend.drainOverflowed(...)`, `src/harness/phases/execute.ts:171`). Otherwise the old and new sessions both write the same workspace and git index concurrently.
- **If the stop is not confirmed, skip both archive and restart.** When the drain reports `restartSafe === false`, a writer may still be running in the directory the replacement would share. Recovery neither archives (the next run could not tell the session from a finished one) nor restarts: it returns the overflowed result as incomplete, flagged `recoveryBoundaryUnresolved`, so the run takes its normal stop and persistence-decline path (`:179-185`).
- **Otherwise archive before the fresh attempt, and preserve the audit trail.** Archiving (not deleting) with `backend.archive(...)` (`:187`) keeps the overflowed session inspectable while making it ineligible for continuation. Archiving before the restart means a crash mid-recovery cannot re-wedge the next run on the known-overflowed session, provided the archive succeeded. Archival is best effort: an unsafe drain blocks the restart (`:179-185`), but `backend.archive` returning `false` only logs a warning (`:187-192`) and the restart proceeds, so the next run may still resume the overflowed session.

## Why This Matters

Overflow is otherwise terminal _and self-perpetuating_: the same stable key re-continues the same overflowed session every run. Recovery at the wrong layer either cannot exclude the archived session (re-ingesting the overflow) or silently doubles the execution budget. Getting the layer, the deadline threading, and the transcript-drop-vs-recall roles right is what makes recovery both correct and bounded — while the persistent continuity that justifies the whole architecture stays intact.

## When to Apply

- Recovering long-lived persistent agent sessions from context or resource exhaustion where continuity across runs must be preserved.
- Any recovery-restart pattern where a second attempt shares a bounded resource (deadline, budget) with the first.

## Examples

Phase-layer gate (only on overflow, only when nothing external could already have run):

```ts
if (
  result.llmError?.type === 'context_overflow' &&
  result.sendUncertain !== true &&
  credentialProvisioned === false &&
  responseFileStatus === 'absent' &&
  sessionId != null
) {
  result = await recoverFromContextOverflow({
    overflowedResult: result,
    overflowedSessionId: sessionId,
    overflowedLedger: ledger,
    // plus the phase-layer context needed to start a fresh attempt
  })
}
```

Inside the recovery helper — drain, archive, bounded exclusion, shared deadline:

```ts
// Stop what the overflowed session still owns before touching it.
const drainOutcome = await backend.drainOverflowed(overflowedLedger, overflowedSessionId, execLogger)

// Stop not confirmed: no archive, no restart. Hand back the overflowed result, incomplete.
if (drainOutcome.restartSafe === false) {
  return {...overflowedResult, recoveryBoundaryUnresolved: true}
}

const archiveSucceeded = await backend.archive(overflowedSessionId, execLogger)
if (archiveSucceeded === false) {
  execLogger.warning('Overflowed session archive failed; next run may re-continue it', {sessionId: overflowedSessionId})
}

// Defense-in-depth: exclude the archived session from prior-work recall.
const recoveryPriorWorkContext = await backend.searchPriorWork(
  recoverySearchQuery,
  sessionPrep.normalizedWorkspace,
  [overflowedSessionId],
  execLogger,
)

// Shared absolute deadline: remaining budget, not a fresh one.
const hasDeadline = bootstrap.inputs.timeoutMs > 0 // a timeout of 0 means no Action deadline
const remainingMs = hasDeadline ? bootstrap.inputs.timeoutMs - (Date.now() - executionStartTime) : 0
if (hasDeadline && remainingMs <= 0) return overflowedResult // no restart

const recoveryExecutionConfig = {...executionConfig, continueSessionId: undefined, timeoutMs: remainingMs}
```

## Related

- [Terminal outcomes must survive deadline cleanup](../logic-errors/terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md) — sibling on execution-deadline authority; recovery must not let a restart rewrite an already-accepted outcome or double the budget.
- [Filter archived/compacting sessions before title match](../logic-errors/resolver-eligibility-ordering-2026-08-03.md) — the resolver fix that makes "the fresh recovered session is what the next run continues" actually hold.
- [OpenCode SDK v1 can read but not typed-write session.time.archived](../logic-errors/archive-v1-read-v2-write-asymmetry-2026-08-03.md) — how the archive primitive used here is implemented.
- fro-bot/agent#1311 / PR #1313.
