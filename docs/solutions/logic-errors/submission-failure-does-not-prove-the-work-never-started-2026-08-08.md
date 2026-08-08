---
title: A submission failure does not prove the work never started when observation began first
date: 2026-08-08
category: logic-errors
module: agent-execution
problem_type: logic_error
component: service_object
symptoms:
  - "A retried request repeats work the server had already accepted and begun"
  - "Artifacts detected during a failed attempt are missing from the result"
  - "The failure classification contradicts activity visible in the event stream"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - retry
  - classification
  - sse
  - idempotency
  - transport-error
---

## Problem

The agent retry path classified an attempt from the return value of the submit call alone. A submission failure meant "the prompt was never accepted", which in turn licensed resending the original prompt — the one operation that can duplicate work.

That inference is only valid if a submission failure proves the server never received the request. It does not. A transport error on the _response_ path is indistinguishable, from the client, from a transport error on the _request_ path. In the first case the turn is already running.

The code had the evidence to tell the difference and threw it away:

```ts
// Ensure the lazy SDK SSE stream begins connecting before prompt submission. Without this,
// event.subscribe().stream is only consumed after promptAsync returns, so early current-turn
// events can be missed while the agent is already working.
await Promise.resolve()
```

The event stream is subscribed _before_ submission, deliberately, precisely because the agent can start working before the submit call returns. Then:

```ts
if (promptStartResult != null) {
  await collectEventResults()
  return promptStartResult // observed activity discarded
}
```

`collectEventResults()` drains the stream, and the result is dropped on the floor. The comment three lines up describes the exact race the next branch ignores.

## Symptoms

- A second attempt sends the original request into a session already executing the first.
- Artifacts (comment URLs, commit SHAs) detected during the failed turn are absent from the final result, because the discarded stream result was the only place they lived.
- Nothing looks wrong in logs: the submit error is real and retryable, and the retry is the documented behavior.

## What Didn't Work

**Reasoning from the classification's name.** `submit_failed` reads like "nothing happened", and that reading is what makes it feel safe to replay. The name describes which call reported the error, not which side effects occurred.

**Trusting the error's retryability.** `retryable: true` is a statement about the transport, not about idempotency. It says the request may succeed if repeated; it says nothing about whether the previous one already took effect.

## Solution

Consult the observation that was already running before deciding what the failure means:

```ts
if (promptStartResult != null) {
  await collectEventResults()
  if (activityTracker.firstMeaningfulEventReceived === true) {
    const effectiveLlmError = eventStreamResult.llmError ?? promptStartResult.llmError
    const outcome: AttemptOutcome =
      effectiveLlmError?.retryable === true ? "turn_failed_retryable" : "turn_failed_terminal"
    return {
      ...promptStartResult,
      llmError: effectiveLlmError,
      outcome,
      shouldRetry: shouldRetryFromOutcome(outcome),
      eventStreamResult,
    }
  }
  return promptStartResult
}
```

If current-turn activity was observed, the turn was accepted regardless of what the submit call reported. It is reclassified as a failed turn, so recovery sends a continuation instead of replaying, and `eventStreamResult` is returned so artifacts observed during that turn survive.

`activityTracker.currentTurnArmed` is set immediately before submission, so `firstMeaningfulEventReceived` cannot be satisfied by activity from a previous turn.

## Why This Works

The window between "server accepted the request" and "client learned the outcome" is unobservable from the return value alone — that is what a transport failure means. But it is not unobservable from the _stream_, which is why the stream is subscribed first. The fix stops treating one channel's silence as authoritative when a second channel is already reporting.

## Prevention

- **When observation starts before an operation, the operation's failure is not the whole story.** Before treating a failed call as "never happened", ask what else was watching during that call, and consult it.
- **Separate "which call reported the error" from "what side effects occurred."** They are different facts and only the second one licenses a replay.
- **Retryable means safe to repeat only when the operation is idempotent.** For non-idempotent work, transport retryability and replay safety are independent questions.
- **Test the accepted-then-failed interleaving explicitly.** A test that only covers a clean submit failure will pass against the broken classification. Drive stream activity first, _then_ fail the submit, and assert the follow-up is a continuation rather than the original request.

## Related Issues

- [Terminal outcomes must survive deadline cleanup](terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md) — the mirror case: that one protects an outcome already decided, this one is about deciding correctly in the first place.
- [Absence of an outcome is not a failed outcome](../workflow-issues/absence-of-outcome-is-not-a-failed-outcome-2026-08-07.md) — the same distinction between missing evidence and observed fact, applied to scoring.
- Found by two independent reviewers during PR #1343; the mechanism was visible in the code's own comment.
