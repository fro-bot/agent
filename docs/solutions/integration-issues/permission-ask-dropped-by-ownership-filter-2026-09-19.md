---
title: An ownership filter on a permission ask stalled the child waiting for the answer
date: 2026-09-19
category: integration-issues
module: agent-execution
problem_type: integration_issue
component: assistant
symptoms:
  - A run hangs for 20-30 minutes and is killed by the CI job cap with nothing posted
  - No error appears anywhere in the log
  - The log shows `permission.asked` arriving, and no reply after it
  - Runs that dispatch no subagents succeed normally, so it looks intermittent
root_cause: scope_issue
resolution_type: code_fix
severity: high
tags: [permission-asked, sse, subagent, deadlock, ownership-ledger, silent-hang]
---

# An ownership filter on a permission ask stalled the child waiting for the answer

## Problem

`processEventStream` filtered `permission.asked` through the same ownership check it used for activity, accounting, output, and lifecycle events. A permission ask is not a notification — upstream publishes it and then waits on a deferred resolution. Any ask the filter skipped was never answered, so the child blocked forever, the root blocked on the child, and the run died at its deadline having delivered nothing.

## Symptoms

- The run looks like a long hang, then dies at an external cap.
- **There is no error.** Nothing is thrown, nothing is logged as a failure, the exit is a timeout.
- The log contains the `permission.asked` event on a child session id, and nothing answering it.
- Runs with no subagents pass normally, which makes the failure look flaky rather than structural.

The observable shape is the important part: *an event arrives, nothing follows it, and the run ends by clock*.

## What Didn't Work

**Provider credential exhaustion.** Plausible because the stream handler has real auth and quota classification paths (`src/features/agent/streaming.ts:974-1102`), and because a genuine credential-cooldown incident had produced similar-looking stalls days earlier. Ruled out: this incident never reached a classification branch. The last thing in the log was an unanswered ask, not a provider error.

**Test-file churn inflating the prompt.** Plausible because the run that first showed the hang had added a large fixture file, and the execution path builds the prompt and materializes reference files before the stream opens. Ruled out by measurement: prompt sizes were within ~1KB across fast and hung runs, and the *successful* run had done strictly more work — more sessions, more stream calls — than the hung one.

Both hypotheses shared a flaw worth naming: they explained why a run might be *slow*, and the actual failure was a run that was *stopped*, waiting on something that would never arrive.

## Solution

Drop the ownership gate on this one branch, keeping only a well-formedness check.

```ts
// before — src/features/agent/streaming.ts
if (eventType === 'permission.asked') {
  const eventSessionID = getEventSessionID(event)
  if (!isOwnedSession(eventSessionID, sessionId, ownershipLedger)) continue

// after
if (eventType === 'permission.asked') {
  const eventSessionID = getEventSessionID(event)
  if (eventSessionID === null) continue
```

`isOwnedSession` is untouched and still gates every other event type. Only the blocking request lost its filter.

The reply also had to stop blocking the stream. Awaiting it inside the consumption loop reproduced the same stall one layer up — one slow reply held every event behind it:

```ts
void onPermissionAsked(request).catch(error => {
  logger.warning('Failed to reject OpenCode permission request', {...context, error: ...})
})
```

The responder (`src/features/agent/execution.ts:46-94`) carries its own bounded timeout and bounded retry, and checks `response.error` explicitly — this SDK reports transport failures in a field rather than by throwing, so an unchecked call looks successful when it is not.

## Why This Works

Answering every ask is correct **here** because of a specific deployment property, and the code says so at `src/features/agent/streaming.ts:652-658`: this Action starts its own loopback OpenCode server per run and wires an unconditional-reject responder to it. Every well-formed ask on that subscription belongs to this run's own process tree. There is no interactive approval path in CI, so an unanswered ask has no way to resolve except by deadline.

**The same change is wrong on the gateway surface.** The Discord gateway has a real human-answerable approval path and an ownership boundary that deliberately stops one run's approval crossing into another run's thread. Answering everything there would be a cross-run approval leak. That gap is tracked separately and left unfixed on purpose — it needs an ownership-boundary-safe answer path, not this fix ported across.

## Prevention

**The rule:** an ownership or relevance filter is for notifications. A request the remote side is *blocking on* needs a reply path keyed to the request, not a membership test that can silently drop it. If a filter can skip a blocking request, skipping is not "ignore" — it is "hang".

Concretely:

- Before filtering an event class, ask whether anything waits on the answer. If yes, the filter is a deadlock unless every skipped case has another responder.
- Log a warning whenever a blocking request is skipped. Silence was what made this cost three review rounds; a single "skipped an ask we do not own" line would have named it immediately.
- Test it directly: inject a child-session `permission.asked` *before* the session is adopted into the ownership ledger, and assert the responder still fires. That test fails against the old code.
- When a run dies by clock with no error, look for the last event that expected a response. A hang is usually an unanswered request, not slow work.

Anchor points: `src/features/agent/streaming.ts:643-725`, `src/features/agent/execution.ts:46-94,254-277`.

## Related Issues

- `docs/solutions/best-practices/web-operator-launch-surface-2026-06-20.md` — auto-deny on a surface with no interactive approver. Same reasoning, different surface; read together for why auto-deny does not generalize across surfaces.
- `docs/solutions/logic-errors/injected-deny-blocks-own-delivery-path-2026-07-13.md` — a permission rule blocking the harness's own path. Closest prior instance of a safety control applied at the wrong boundary.
- `docs/solutions/best-practices/extract-timer-primitive-keep-policy-per-surface-2026-07-13.md` — per-surface policy over shared mechanism, the principle that makes the gateway carve-out correct rather than inconsistent.
- Shipped in PR #1629.
