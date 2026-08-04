---
title: Recover a persistent agent session from context overflow without breaking continuity
date: 2026-08-03
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
- **Orchestrate recovery at the phase layer, not inside the single-attempt executor.** Only the phase layer (`runExecute`) holds the session-prep, client, logical key, and workspace needed to rebuild the bounded prior-work search _excluding the just-archived session_. Keep the executor (`executeOpenCode`) as "run one attempt under a deadline." Pushing recovery down into the executor forces a downward layering leak and makes the exclusion impossible.
- **Share one absolute deadline across both attempts.** The executor mints its own deadline from `config.timeoutMs`, so a naive second call would grant a fresh full budget. Thread the _remaining_ budget (`timeoutMs − elapsed`) into the recovery attempt; if it is `<= 0`, do not restart.
- **Bound to exactly one restart; next-run recovery is the floor.** If the fresh session also overflows, archive it too and fail cleanly — no loop. Because the overflowed session is archived, the next run starts fresh regardless.
- **Never key the session on head SHA just to bound growth.** Fragmenting the continuity key (`pr:<number>:<sha>`) would discard the persistent memory on every push — the antithesis of a persistent-session product. Bound growth via recovery/compaction, not by fragmenting the identity key.
- **Archive before the fresh attempt, and preserve the audit trail.** Archiving (not deleting) keeps the overflowed session inspectable while making it ineligible for continuation. Archiving before the restart guarantees a crash mid-recovery cannot re-wedge the next run on the known-overflowed session.

## Why This Matters

Overflow is otherwise terminal _and self-perpetuating_: the same stable key re-continues the same overflowed session every run. Recovery at the wrong layer either cannot exclude the archived session (re-ingesting the overflow) or silently doubles the execution budget. Getting the layer, the deadline threading, and the transcript-drop-vs-recall roles right is what makes recovery both correct and bounded — while the persistent continuity that justifies the whole architecture stays intact.

## When to Apply

- Recovering long-lived persistent agent sessions from context or resource exhaustion where continuity across runs must be preserved.
- Any recovery-restart pattern where a second attempt shares a bounded resource (deadline, budget) with the first.

## Examples

Phase-layer gate (only on overflow, only when nothing was delivered):

```ts
if (result.llmError?.type === "context_overflow" && result.commentsPosted === 0 && sessionId != null) {
  result = await recoverFromContextOverflow({
    overflowedResult: result,
    overflowedSessionId: sessionId,
    // plus the phase-layer context needed to start a fresh attempt
  })
}
```

Inside the recovery helper — archive, bounded exclusion, shared deadline:

```ts
const archiveSucceeded = await archiveSession(cacheRestore.serverHandle.server.url, overflowedSessionId, execLogger)
if (archiveSucceeded === false) {
  execLogger.warning("Overflowed session archive failed; next run may re-continue it", {sessionId: overflowedSessionId})
}

// Defense-in-depth: exclude the archived session from prior-work recall.
const recoveryPriorWorkContext = await searchSessions(
  recoverySearchQuery,
  cacheRestore.serverHandle.client,
  sessionPrep.normalizedWorkspace,
  {limit: 5, excludeSessionIds: [overflowedSessionId]},
  execLogger,
)

// Shared absolute deadline: remaining budget, not a fresh one.
const remainingMs = bootstrap.inputs.timeoutMs - (Date.now() - executionStartTime)
if (remainingMs <= 0) return overflowedResult // no restart

const recoveryExecutionConfig = {...executionConfig, continueSessionId: undefined, timeoutMs: remainingMs}
```

## Related

- [Terminal outcomes must survive deadline cleanup](../logic-errors/terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md) — sibling on execution-deadline authority; recovery must not let a restart rewrite an already-accepted outcome or double the budget.
- [Filter archived/compacting sessions before title match](../logic-errors/resolver-eligibility-ordering-2026-08-03.md) — the resolver fix that makes "the fresh recovered session is what the next run continues" actually hold.
- [OpenCode SDK v1 can read but not typed-write session.time.archived](../logic-errors/archive-v1-read-v2-write-asymmetry-2026-08-03.md) — how the archive primitive used here is implemented.
- fro-bot/agent#1311 / PR #1313.
