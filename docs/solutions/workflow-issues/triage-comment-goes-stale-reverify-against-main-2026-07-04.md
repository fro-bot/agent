---
title: 'A triage comment can go stale within an hour — re-verify its claims against current main'
date: 2026-07-04
category: workflow-issues
module: development-workflow
problem_type: workflow_issue
component: assistant
severity: medium
applies_when:
  - The newest signal on an issue is an older triage, analysis, or "current state" comment
  - That comment's claims (issue state, PR merge status, code presence) are being used as implementation input
  - A closing PR may have merged shortly after the comment was written
tags:
  - triage
  - stale-context
  - verify-against-main
  - merge-timing
  - github
  - re-triage
---

# A triage comment can go stale within an hour — re-verify against current main

## Context

Issue #1069's triage comment (posted 2026-06-30 **02:26Z**) claimed the gateway "does not yet have the inactivity timer" and that "#1055 is an open issue." Both were overtaken ~1h later: PR #1068 merged at **03:26Z**, closing #1055 and shipping the gateway inactivity model. A later session that took the triage at face value would have built the *wrong* thing — "build the gateway inactivity model" — when the real remaining work was the inverse: "extract the now-existing model to a shared primitive and adopt it in the action."

The model was verifiably present on current `main`:

- `packages/gateway/src/execute/run-core.ts` — `RunCoreErrorKind` includes `'inactivity-timeout'` (~:42); the inactivity controller composes with the run signal via `AbortSignal.any([signal, inactivityController.signal])` (~:304).
- `packages/gateway/src/execute/run.ts` — `isInactivityTimeout = isCoreError && execError.kind === 'inactivity-timeout'` (~:796).

## Guidance

Before acting on any triage / analysis / "current state" comment — human or bot — re-verify its load-bearing claims against current `main`:

- **Issue/PR state**: `gh issue view <n> --json state,closedAt` / `gh pr view <n> --json state,mergedAt` — is it actually still open?
- **Merge timing by timestamp, not date**: compare the comment's `createdAt` against the closing PR's `mergedAt`. A comment written at 02:26Z is stale if the fix merged at 03:26Z the same day — same date, opposite reality.
- **Code presence**: grep/read the claimed-missing (or claimed-present) code on `main`.

If the comment is stale, post a corrected re-triage that cites the evidence and reframes the actual remaining work, so the next actor doesn't inherit the inverted framing.

## Why This Matters

Issue threads are append-only, but reality is not — a triage comment is a snapshot of `main` at the instant it was written, and a PR merging minutes later can invert its core claims without editing the comment. Trusting the newest *comment* instead of the newest *state* leads you to rebuild something that already exists, or to skip something that was reverted. Date-level reasoning ("the triage is from today") is not enough; a fix can land an hour after the triage on the same day.

## When to Apply

- Picking up any issue whose freshest signal is an older triage or analysis comment.
- Any "the code currently does X / feature Y is not built yet" claim in an issue body or comment.
- Reconciling a tracker or status doc that summarizes cross-repo state — re-derive from live state, not from the last narrative.

## Examples

Before (trusting stale triage):
```
triage (02:26Z): "gateway has no inactivity timer; #1055 open" → plan: build the model
```

After (re-verified against main):
```
gh: #1055 CLOSED by #1068 (merged 03:26Z); run-core.ts:304 has the inactivity AbortSignal.any
→ plan: extract the existing model to a shared primitive, adopt in the action
```

Rule: act on the newest *state*, not the newest *comment* — and check merge timestamps, not just dates.

## Related

- [A coordination field written empty at creation and never updated silently breaks every reader](../logic-errors/thread-id-persistence-gap-in-run-state-2026-07-03.md) — the sibling "a stale comment/assumption misleads a green-looking situation" lesson, on persisted state rather than issue threads.
