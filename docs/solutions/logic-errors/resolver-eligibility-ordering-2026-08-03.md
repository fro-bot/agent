---
title: Filter archived/compacting sessions before title match, not after
date: 2026-08-03
category: logic-errors
module: agent-execution
problem_type: logic_error
component: service_object
symptoms:
  - "resolveSessionForLogicalKey returned not-found even though a fresh eligible session existed"
  - "A newer archived same-title session masked an older eligible one"
  - "Session continuity could be silently lost after archiving"
root_cause: scope_issue
resolution_type: code_fix
severity: high
tags:
  - session-continuity
  - logical-key
  - archived-session
  - eligibility-ordering
  - resolver
---

# Filter archived/compacting sessions before title match, not after

## Problem

`resolveSessionForLogicalKey` selected the newest same-title session first (`findSessionByTitle`, ranked by `time.updated`) and only _then_ rejected it if it was archived or compacting. Because archiving bumps `time.updated`, a freshly archived session could win the title match and shadow an eligible non-archived session with the same title — causing a false `not-found` and silently losing session continuity.

## Symptoms

- Two workspace sessions share a title; the archived one has the newer `time.updated`.
- `resolveSessionForLogicalKey` returns `not-found` instead of the eligible non-archived session.
- Continuity is lost: the next run starts cold even though a valid continuable session exists.

## What Didn't Work

Ranking by title first, then filtering eligibility:

```ts
// Bug: newest-by-title chosen first; archived winner then rejected as not-found,
// never falling back to the eligible older same-title session.
const matchedSession = findSessionByTitle(matchingWorkspaceSessions, title)
if (matchedSession != null && (matchedSession.time.archived != null || matchedSession.time.compacting != null)) {
  return {status: "not-found"}
}
```

## Solution

Filter archived/compacting out of the candidate set **before** ranking by title, so the newest _eligible_ same-title session wins:

```ts
const eligibleWorkspaceSessions = matchingWorkspaceSessions.filter(
  session => session.time.archived == null && session.time.compacting == null,
)
const matchedSession = findSessionByTitle(eligibleWorkspaceSessions, title)
```

Apply the same eligibility filter on any sibling resolution path (e.g. the stale-directory fallback) that also ranks by title.

## Why This Works

Archiving a session updates its `time.updated`, so "most recently updated" is exactly the wrong selection criterion when eligibility is checked afterward — the archived session is guaranteed to look newest. Filtering eligibility first makes the ranking operate only over sessions that can actually be continued.

## Prevention

Regression test that fails before the fix and passes after:

- Create two same-title workspace sessions.
- Give the **archived** one the **newer** `time.updated`.
- Assert `resolveSessionForLogicalKey` returns the **non-archived** session (`status: 'found'`), not `not-found`.
- Keep the existing case: when the _only_ same-title session is archived, still return `not-found`.

General rule: when a lookup both **ranks** and **filters for eligibility**, filter first — otherwise an ineligible top-ranked item can mask an eligible one instead of falling through to it.

## Related Issues

- fro-bot/agent#1311 / PR #1313 — a latent bug the overflow-recovery path would have exposed (the fresh recovered session shares the archived session's title).
- See also: [Overflow-recovery architecture](../best-practices/overflow-recovery-architecture-2026-08-03.md).
