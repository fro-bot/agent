---
title: Admit a same-run subagent resume on host-observed ownership, not on the id the model supplies
date: 2026-11-27
category: best-practices
module: agent-execution
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - A model-callable tool takes an id that names an existing server-side object (a child session, shell or job) and you want to allow reuse
  - A security decision depends on which host started the server, and a resolver exists that also decides an unrelated feature such as tracing
  - A stream event is published before the policy hook runs, and the runtime must react only to calls the policy admitted
  - A one-shot "noticed" set interacts with a state that can be entered again, such as a resume
tags:
  - subagent
  - resume
  - ownership-ledger
  - execute-before-hook
  - launcher-host
  - opencode-v2
  - fail-closed
---

# Admit a same-run subagent resume on host-observed ownership, not on the id the model supplies

## Context

On OpenCode v2.4.1 and v2.4.2 one `subagent` tool handles both dispatch and resume, and a call that carries `sessionID` resumes that child. The Action used to refuse every resume in its `execute.before` hook (#2262). The goal was to let a run resume a child it dispatched itself, and nothing else.

## Guidance

**1. Ownership is what the plugin saw on a successful fresh dispatch, keyed by the host-supplied caller.** `execute.after` records `child -> caller` only for a completed `subagent` call whose input has no `sessionID` (`packages/opencode-plugin/src/task-reuse-guard.ts:62-76`). The caller is the event's own `sessionID`, set by the host, so nothing the model wrote names it. `before` admits a resume only on an exact owner match on the Action host (`task-reuse-guard.ts:93-98`). Every other case gets the same fixed, id-free refusal.

<!-- prettier-ignore -->
```ts
      const admitted =
        actionHost &&
        caller !== undefined &&
        typeof target.sessionID === 'string' &&
        children.get(target.sessionID) === caller
      if (!admitted) throw new Error(TASK_REUSE_REJECTION)
```

**2. Decide the host with a strict reader of its own.** `readLauncherHost` (`packages/opencode-plugin/src/tracing/settings.ts:311-322`) answers `'action'` only for a present, size-capped, valid JSON launcher with `version === 1` and `host === 'action'`, and `setup.ts:89` builds the guard from it. `resolveLauncher` (`settings.ts:274`) could not be reused: it decides tracing and drops the host when tracing is off (`:286`) or the relay is rejected (`:295`), so an Action run with tracing off would have every resume refused.

**3. The record is per instance and bounded.** It is a `Map` in the guard's closure, capped at 1024 with the oldest evicted (`task-reuse-guard.ts:100-111`). A reload starts empty and an evicted child is refused, both in the safe direction.

**4. React to `tool_progress`, never to `tool_called`.** Upstream publishes `Tool.Called` before the plugin `execute.before` guard runs, so a refused resume still produces `tool_called`. Only the progress frame proves admission, because upstream emits it after the guard and before it submits the prompt (`src/features/agent/streaming-v2.ts:506-523`).

**5. Reopen before adoption.** A report notice puts the child in `noticedChildIds` (`streaming-v2.ts:695`), and `adoptDescendant` settles any adopted child still in that set (`:326`). Adopting a resumed child first would settle it at once, so `reopenResumedChild` (`:349-363`) runs first. It calls `ownershipLedger.resume` (`packages/runtime/src/agent/ownership-ledger.ts:167-172`) and clears the notice (`streaming-v2.ts:517-519`):

<!-- prettier-ignore -->
```ts
            // Before adoption: adopting a noticed child settles it again.
            reopenResumedChild(callKey(event), info?.input, childSessionId)
            adoptDescendant(childSessionId, subagentLabel(info?.input))
```

**6. Existing backstops stood in for generation fences.** Per-child execution numbers on the settle writers were not needed. The directory stability gate holds release while any session is active or an inbox item is queued (`src/features/agent/drain-v2.ts:424-429`), and the parent is busy during an in-flight resume, so the directory is never quiet between progress and prompt.

**Accepted residuals**, all documented in code comments: a stale reconcile snapshot can settle the reopened entry early (review accepted it as non-blocking, since the child stays active through report delivery); an event-stream gap can miss the progress frame; and overlapping resumes of one child may strand the second prompt upstream, which was traced from upstream source and not reproduced.

## Why This Matters

A model-supplied `sessionID` is a request, not a credential, so ownership has to come from something the model cannot write.

## When to Apply

Any model-callable tool that reuses an existing server-side object by id, and any stream that publishes "called" before its policy hook.

## Examples

The real-binary `packages/opencode-plugin/src/integration.test.ts` covers resuming an own child (`:473`), refusing foreign and unknown ids (`:507`) and the workspace host refusing its own child (`:562`). `src/features/agent/streaming-v2.test.ts` pins the reopen (`:1390`) and the refused call with no progress (`:1447`).

## Related

- [A failed resume leaves a reopened child waiting for a report that never comes](../logic-errors/failed-resume-leaves-a-reopened-child-with-no-report-2026-11-27.md): the failure path of the reopen.
- [With timeout 0, drain waits on observed running work](../logic-errors/no-deadline-drain-counts-observation-not-ledger-state-2026-10-22.md)
- #2262
