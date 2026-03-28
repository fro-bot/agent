---
title: "Session Continuity Post-Ship Audit"
date: 2026-03-28
scope: v0.32.0+ (PR #376)
runs_sampled: 4 Fro Bot schedule runs (Mar 24-27, 2026)
---

## Session Continuity Post-Ship Audit

## Executive Summary

The session continuity feature (PR #376, v0.32.0) is **partially functioning**. Prompt restructuring (Non-Negotiable Rules, Constraint Reminder) works correctly. Session titles are set correctly at creation. But **session continuation never succeeds** — every run creates a fresh session because OpenCode auto-renames the title after the first prompt, and the title re-set after prompt was never implemented.

**Impact**: Zero session continuity across runs. The agent cannot recall its prior work on the same entity. The "Thread Identity" section is never populated in prompts.

## Runs Sampled

| Run ID      | Date       | Event    | Session ID          | Title at Creation            |
| ----------- | ---------- | -------- | ------------------- | ---------------------------- |
| 23500894440 | 2026-03-24 | schedule | ses_2df4c0cafffe... | `fro-bot: schedule-c757a308` |
| 23552690701 | 2026-03-25 | schedule | ses_2da20617dffe... | `fro-bot: schedule-c757a308` |
| 23606276260 | 2026-03-26 | schedule | ses_2d4fc0340ffe... | `fro-bot: schedule-c757a308` |
| 23655941186 | 2026-03-27 | schedule | ses_2cfed642fffe... | `fro-bot: schedule-c757a308` |

All 4 runs: different session IDs despite identical logical key `schedule-c757a308`.

## Findings

### 1. CRITICAL: Session Title Auto-Overwrite (Root Cause)

**Severity**: Critical — blocks all session continuity

OpenCode auto-renames session titles based on the first message content. The title `fro-bot: schedule-c757a308` set at creation is overwritten (likely to something like "Daily maintenance report") before the cache is saved. The next run's resolver calls `findSessionByTitle()` looking for `fro-bot: schedule-c757a308` and finds no match.

**Evidence**:

- All 4 runs log: `Session continuity: no existing session found`
- All 4 runs log: `continueSessionId: null`
- All 4 runs: `Created new OpenCode session` with the correct title
- Cache IS restored from previous run (confirmed: `Cache hit for restore-key: opencode-storage-github-fro-bot-agent-main-Linux-23606276260`)
- 10 sessions exist at resolver time, none match the title

**Root cause**: The plan specified "After successful prompt, **re-set title** via `session.update()` to guard against OpenCode's auto-title behavior" — but this was **never implemented** in `execution.ts`. There is no `session.update()` call anywhere in the codebase.

**Fix**: Add `session.update()` call after each prompt to restore the logical key title. The OpenCode PATCH endpoint (`/session/{id}`) accepts `{ title }` — confirmed in `routes/session.ts:265`.

### 2. WORKING: Prompt Restructuring (Instruction Sandwich)

**Severity**: N/A — functioning correctly

The prompt shows:

- **Position 1**: `## Critical Rules (NON-NEGOTIABLE)` — 5-line hard constraints ✅
- **Last position**: `## Reminder: Critical Rules` — 1-line recency reminder ✅
- Task and Trigger Comment positioned near the top ✅
- Agent Context demoted below task content ✅

### 3. WORKING: Logical Key Computation

**Severity**: N/A — functioning correctly

The logical key `schedule-c757a308` is:

- Deterministic (same hash across all 4 runs) ✅
- Correctly derived from the schedule event ✅
- Used for session title and search fallback ✅

### 4. WORKING: Observability (Artifact Upload)

**Severity**: N/A — functioning correctly

All 4 Fro Bot schedule runs produced downloadable `opencode-logs` artifacts containing:

- OpenCode server log (4,000-8,700 lines each)
- Prompt artifact file (197 lines each)
- Unique artifact names (`opencode-logs-{runId}-1`) ✅

### 5. ISSUE: Thread Identity Section Missing from Prompts

**Severity**: High — dependent on session continuity

The prompt shows NO "Thread Identity" section. This is expected given continuity never succeeds — the section is only populated when `logicalKey` and `isContinuation` are provided to the prompt builder. When `continueSessionId` is null, no thread identity is injected.

**Fix**: Will resolve automatically once session continuity works. However, consider showing thread identity even on fresh sessions (e.g., "Fresh conversation — no prior thread found for schedule-c757a308") to aid debugging.

### 6. ISSUE: Task Content Duplicated in Prompt

**Severity**: Low — token waste

The schedule task description appears verbatim in both:

- `## Task` section (lines 8-37)
- `## Trigger Comment` section (lines 38-70)

This is ~30 lines / ~400 tokens of pure duplication. For schedule events, the Task and Trigger Comment are identical because the `prompt` input IS the task.

**Fix**: In `buildAgentPrompt()`, skip the Trigger Comment section when its content is identical to the Task section.

### 7. NOISE: `tool.registry ... invalid` Entries

**Severity**: Low — cosmetic noise

Every run logs 14-24 instances of:

```
INFO service=tool.registry status=started invalid
INFO service=tool.registry status=completed duration=N invalid
```

The `invalid` here is NOT an error — it's the tool name. OpenCode's tool registry initializes a tool called `invalid` (likely a placeholder/sentinel). This is benign startup chatter from OpenCode internals.

**Recommendation**: No action needed. Document as expected noise.

### 8. NOISE: `Blocked 3 postinstalls`

**Severity**: Low — cosmetic noise

Every run logs exactly once:

```
Blocked 3 postinstalls. Run `bun pm untrusted` for details.
```

This is Bun's security policy for oMo's dependencies. Expected behavior.

**Recommendation**: No action needed. Document as expected noise.

### 9. OBSERVATION: Prior Session Context Shows Stale Sessions

**Severity**: Medium — reduced context quality

The "Prior Session Context" table shows sessions from March 3-22 (pre-v0.32.0), none of which are schedule-related maintenance sessions. The recent schedule sessions (Mar 24-26) don't appear because they likely got renamed by OpenCode and are no longer matching any useful search query.

**Fix**: Will improve automatically once session continuity works. The "Current Thread Context" section will show the actual prior work from the same schedule thread.

## Prioritized Action Items

### P0: Fix session title persistence (blocks all continuity)

Add `session.update()` call in `execution.ts` after successful prompt to re-set the logical key title. Without this, no session continuity can ever work.

```typescript
// After successful prompt, re-set title to guard against auto-rename
if (sessionTitle != null) {
  try {
    await client.session.update({
      path: {id: sessionId},
      body: {title: sessionTitle} as Record<string, unknown>,
    })
  } catch {
    logger.warning("Failed to re-set session title", {sessionId, sessionTitle})
  }
}
```

### P1: Show Thread Identity on fresh sessions too

Currently Thread Identity only shows when `isContinuation` is true. Show it on fresh starts too so the logical key is visible in the prompt artifact for debugging:

```
## Thread Identity
**Logical Thread**: `schedule-c757a308` (schedule)
**Status**: Fresh conversation — no prior thread found for this entity.
```

### P2: Deduplicate Task / Trigger Comment for schedule events

Skip the Trigger Comment section when it's identical to the Task section. Saves ~400 tokens per schedule run.

### P3: Add debug logging for session title state

Log the titles of sessions returned by `listSessionsForProject()` during resolution so we can see what titles the sessions actually have (vs. what we're searching for).

## Metrics

| Metric                                  | Value                                                        |
| --------------------------------------- | ------------------------------------------------------------ |
| Runs sampled                            | 4                                                            |
| Session continuity success rate         | **0%** (0/4 runs)                                            |
| Prompt restructuring working            | **Yes** (Non-Negotiable Rules + Constraint Reminder present) |
| Artifact upload working                 | **Yes** (all 4 runs have artifacts)                          |
| Logical key computation working         | **Yes** (deterministic `schedule-c757a308` across all runs)  |
| OpenCode errors in logs                 | **0**                                                        |
| OpenCode warnings in logs               | **0**                                                        |
| tool.registry "invalid" entries per run | 14-24 (benign noise)                                         |
| Avg run duration                        | ~4-10 minutes                                                |
| Avg OpenCode log size                   | 4,000-8,700 lines                                            |
| Prompt size                             | 197 lines (~2,500 words)                                     |
