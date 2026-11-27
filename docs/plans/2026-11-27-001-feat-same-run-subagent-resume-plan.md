---
title: "feat: let a run resume its own finished subagent on OpenCode v2"
type: feat
status: active
date: 2026-11-27
---

# feat: let a run resume its own finished subagent on OpenCode v2

## Summary

On OpenCode v2 a parent can wake a finished child by calling `subagent` with the child's `sessionID`, and the child's next reply arrives as a new report. The plugin guard refuses every `sessionID`, so a workflow that re-asks its own child loses that coverage. Two edits close the gap. First, the guard admits a resume of a child this run dispatched, on the Action host only. Second, the ownership ledger reopens that child so the run waits for its next report. The pin is 2.4.2 (`packages/runtime/src/shared/opencode-v2-pin.json`).

## Problem Frame

The guard exists because a resumed child used to go untracked (#1759, #1769). `adopt` is a no-op on a settled entry (`packages/runtime/src/agent/ownership-ledger.ts:148-151`), and the stream's sticky `noticedChildIds` (`src/features/agent/streaming-v2.ts:276,311-318`) would settle the child again on the resume's first progress frame. The fix keeps both protections and adds the missing transition. It does not remove the guard.

## Requirements

- R1. The guard admits a resume `sessionID` only when it names a child this run dispatched from the calling session, and only on the Action host. Every other id gets the existing fixed refusal.
- R2. The workspace server keeps refusing every resume. The gateway reaches the plugin through it, so the gateway keeps refusing too.
- R3. A resume reopens the child's ledger entry as outstanding, and the next report settles it as usual. `adopt` is unchanged.
- R4. The behavior is shown on the pinned binary (2.4.1 when planned, 2.4.2 now), and the docs that describe the guard are corrected.

## Scope Boundaries

- No change to how notices settle, and no change to reconcile, drain or quiet-stop. The directory stability gate (`src/features/agent/drain-v2.ts:423-431`) already blocks release while the resumed child is active.
- A resume that joins a still-running child, overlapping resumes of one child, and a stream gap that misses the resume's progress frame are residuals. See Risks.
- The gateway keeps refusing. Nothing is admitted across runs or from a restored cache.

### Deferred to Separate Tasks

- The running-tag/completed-metadata settlement and the gateway notice dedupe (`packages/gateway/src/execute/drain-completion-v2.ts:187-230`) are a separate fix, as #2262 states.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "packages/opencode-plugin, packages/runtime/src/agent, src/features/agent, packages/gateway/src/execute",
  "freshness": {"vcs_reference": "a83fa1b660455092caf8f03dea8aaedbdbb262c5"},
  "budget": {"max_search_passes": 8, "max_candidate_inspections": 24, "exhausted": false},
  "candidates": [
    {
      "path_or_symbol": "packages/opencode-plugin/src/task-reuse-guard.ts",
      "description": "refuses any subagent sessionID with a fixed message",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/runtime/src/agent/ownership-ledger.ts",
      "description": "per-child outstanding/settled/unknown with idempotent adopt",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/features/agent/streaming-v2.ts",
      "description": "adoption from subagent tool parts and the sticky noticedChildIds set",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/opencode-plugin/src/tracing/settings.ts",
      "description": "launcher document parser that already reads host action or workspace",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/opencode-plugin/src/integration.test.ts",
      "description": "real-binary scripted-provider subagent scenario",
      "disposition": "extend"
    }
  ]
}
```

## Key Technical Decisions

- **Ownership comes from what the plugin observed.** A record of child to caller is made only when all of these hold: the tool is `subagent`, the call succeeded, the call's input had no `sessionID`, and the result metadata names the child. The caller is the host-supplied event `sessionID`, never tool output or model input. The record lives in the `setupFroBotPlugin` closure, is bounded, and is memory-only, so a plugin reload fails closed.
- **A strict Action-host reader.** A small exported reader in the entry chunk returns `action` only for a present, size-capped, valid `OPENCODE_FROBOT_TRACING` document with `version` 1 and `host` `'action'`, regardless of tracing mode. The existing `resolveLauncher` (`packages/opencode-plugin/src/tracing/settings.ts:274-301`) is private and drops the host when tracing is off. It stays unchanged.
- **Reopen on the resume's progress frame.** `tool_progress` for a call whose input carries `sessionID` proves the guard admitted it. `tool_called` is published before the guard runs (`anomalyco/opencode@v2.4.1 packages/core/src/session/runner/step.ts:118-150`), so it is not proof. The stream calls a new ledger `resume(child)` once per call id and clears that child's `noticedChildIds` entry.
- **The next report settles the reopened child.** On 2.4.1 a report is delivered once, as an inbox item (`packages/core/src/session/execution/subagent-report.ts`). The parent has already consumed the earlier report before deciding to resume, so a sequential resume leaves no stale report to misattribute.
- **The refusal text is unchanged and carries no id.** New log lines never include a model-supplied `sessionID`.

## Implementation Units

- [x] **Unit 1: Plugin admission**

**Goal:** The guard admits a resume of a recorded child of the caller on the Action host, and refuses everything else.

**Requirements:** R1, R2

**Files:**

- Modify: `packages/opencode-plugin/src/task-reuse-guard.ts`, `packages/opencode-plugin/src/setup.ts`, `packages/opencode-plugin/src/tracing/settings.ts` (export the host reader beside the existing parser)
- Test: `packages/opencode-plugin/src/task-reuse-guard.test.ts`, `packages/opencode-plugin/src/tracing/settings.test.ts`, `packages/opencode-plugin/src/bundle.test.ts`

**Approach:** Widen the guard's hook input to the caller `sessionID`, and add an `execute.after` hook for the record. Keep the reader free of SDK imports so the entry-chunk rule in `bundle.test.ts` holds.

**Execution note:** Test-first.

**Test scenarios:**

- Recorded child of caller P, Action host, resume → admitted.
- Absent or null `sessionID` on any host → admitted (fresh dispatch, unchanged).
- Foreign id, a child recorded for caller Q, or a malformed id → fixed refusal.
- Workspace host, missing launcher, malformed launcher or unsupported version → refusal, even for a recorded child.
- Action launcher with tracing off, or with invalid relay fields → admitted.
- Another tool returning `{sessionID, status: 'running'}`, or a failed `subagent` call → nothing recorded.
- A fresh plugin instance (reload) → refusal of a previously valid resume.

**Verification:** Guard, settings and bundle tests pass, and the refusal text is byte-identical.

- [x] **Unit 2: Ledger resume**

**Goal:** A resume reopens the settled child so the run waits for its next report.

**Requirements:** R3

**Files:**

- Modify: `packages/runtime/src/agent/ownership-ledger.ts`, `src/features/agent/streaming-v2.ts`, plus the ledger wrappers the compiler requires (`packages/gateway/src/execute/run-core-shared.ts`, `src/features/agent/reconcile-v2.ts`, `packages/gateway/src/execute/live-reconcile.ts`). These are pass-through only.
- Test: `packages/runtime/src/agent/ownership-ledger.test.ts`, `src/features/agent/streaming-v2.test.ts`

**Approach:** `resume(child)` moves a settled or unknown entry to outstanding, leaves an outstanding one as it is, and does nothing for a child the ledger never adopted. In the stream's `tool_progress` handling, a call whose input carries `sessionID` matching the progress metadata's child calls `resume` once per call id and clears the sticky entry.

**Execution note:** Test-first. The existing "a second adopt does not reset a settled entry" test stays.

**Test scenarios:**

- adopt → settle → resume → the entry is outstanding and the drain is not complete.
- Resume of an outstanding child → still outstanding. Resume of an unadopted child → no change.
- The stream sees a settled child, then a resume call's progress → the child is outstanding and no longer in `noticedChildIds`. The next report settles it.
- A refused resume (`tool_called` with no progress) → no reopen. A replayed progress frame for the same call id → one reopen.

**Verification:** Ledger and streaming suites pass, and existing assertions are unchanged.

- [x] **Unit 3: Real-host proof and docs**

**Goal:** Show the flow on the pinned binary, and correct the guard docs.

**Requirements:** R2, R4

**Files:**

- Modify: `packages/opencode-plugin/src/integration.test.ts`, `ARCHITECTURE.md`, `packages/opencode-plugin/README.md`, `src/features/agent/AGENTS.md`, `docs/wiki/Background Subagents and Ownership.md`, `docs/wiki/Setup and Configuration.md`, `docs/wiki/Architecture Overview.md`, `STRUCTURE.md`, `deploy/README.md`

**Approach:** Extend the existing scripted-provider scenario (`integration.test.ts:162-210`). It already runs against the pinned binary in the existing CI job. The docs swap the stale "refuses any `sessionID`" or `task_id` wording for the same-run rule in one sentence each. The detail goes in the wiki ownership page.

**Test scenarios:**

- Dispatch B, B reports, the parent resumes B by its actual id → B's second reply reaches the parent, and there is exactly one child session.
- A foreign id → fixed refusal, and no prompt reaches any session.
- With the workspace launcher, dispatch a child and then resume it → refused.

**Verification:** The plugin integration suite passes with `FRO_BOT_OPENCODE_V2_BIN` set to the pinned binary; it passed on both 2.4.1 and 2.4.2, and `bun run check:md-links` passes.

## Risks

| Risk | Handling |
| --- | --- |
| A resume that joins a running child, or overlapping resumes, produces one report for several reopen calls. | The entry is already outstanding, so a join changes nothing. Overlap is a documented residual, and the directory gate holds release while the child runs. |
| The stream misses the resume's progress frame (SSE gap), so the settled entry stays settled. | The directory gate holds release while the child is active. This is the same exposure a missed fresh dispatch has today. |
| Upstream emits the resume's progress before it prompts the child, so a prompt that fails afterwards reopens a child that never reports. | The existing reconcile pass settles an outstanding child that is not live (`ledger-reconcile.ts:262-267`), so the run does not wait for the deadline. |
| A plugin reload drops the record and refuses a legitimate resume. | The guard fails closed, and the model can dispatch a fresh child. |
| A future pin changes report delivery to two paths. | Recheck the "delivered once" assumption on the next pin bump, before relying on it. |

## Sources

- Target issue: #2262 and its triage comment. Related: #1759, #1769.
- `docs/plans/2026-09-14-001-feat-background-subagent-ownership-plan.md` (active) built the ledger and excluded only cross-run resume.
- Upstream: `anomalyco/opencode@v2.4.1 packages/core/src/tool/plugin/subagent.ts`, `packages/core/src/session/runner/step.ts`, `packages/core/src/session/execution/subagent-report.ts`.
