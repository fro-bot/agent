---
title: Terminal outcomes must survive deadline cleanup
date: 2026-07-24
category: logic-errors
module: action/agent-execution
problem_type: logic_error
component: assistant
symptoms:
  - Structured session errors collapsed to unusable text or risked exposing provider-controlled details
  - A missing response artifact could mask the primary execution failure
  - Work that completed before the execution deadline could still be reported as a timeout during cleanup
  - Cleanup-time expiry could trigger an unnecessary remote abort after terminal success or failure
root_cause: async_timing
resolution_type: code_fix
severity: high
tags:
  - execution-deadline
  - terminal-outcome
  - error-preservation
  - sse-teardown
  - response-delivery
  - opencode
  - async-timing
  - timeout
---

# Terminal outcomes must survive deadline cleanup

## Problem

The Action execution path mixed outcome-producing work with secondary cleanup and delivery. A prompt could finish before the absolute deadline, then be rewritten as a timeout because SSE shutdown, title reassertion, or artifact reconciliation crossed the deadline. Failed executions could also lose their causal error when the response file was missing, while raw provider error objects were unsafe and often reduced to `[object Object]`.

The durable rule is: **once terminal success or failure is accepted before the deadline, later cleanup, delivery, and enrichment may degrade, but they must not rewrite the outcome.**

## Symptoms

- Object-valued `session.error` events produced unusable or overly permissive error text.
- A failed comment or review run with no response file surfaced `file-read-failed` instead of the original execution error.
- A pre-deadline terminal result could become exit code 130 while waiting for an abort-ignoring event stream to stop.
- A retryable failure could start another attempt after cleanup consumed the remaining execution budget.
- Remote session abort could run after a terminal result simply because the timeout timer fired during teardown.

## What Didn't Work

- **Propagating provider `message` text.** Provider-controlled object fields may contain URLs, account identifiers, tokens, or nested response details. Treating them as safe summaries or retry classifiers weakened the trust boundary.
- **Wrapping the whole prompt attempt in the deadline race.** That made bounded cleanup part of terminal classification, so cleanup crossing the deadline converted an already-completed attempt into a timeout.
- **Checking only the timer latch.** `isTimedOut()` depends on the timeout callback running. Event-loop delay can put the wall clock past the deadline before that callback fires.
- **Throwing after artifact reconciliation.** Artifact reads are post-terminal enrichment. A timeout there must not override an accepted success.
- **Gating remote abort only on timeout state.** Timer state does not say whether a terminal result was accepted first.

## Solution

### Normalize provider errors at the event boundary

`normalizeSessionError` in `src/features/agent/streaming.ts` retains only bounded allowlisted fields from object payloads:

```ts
const fields: string[] = []
if (provider != null) fields.push(`provider=${provider}`)
if (name != null) fields.push(`name=${name}`)
if (status != null && Number.isFinite(status)) fields.push(`status=${status}`)
if (code != null) fields.push(`code=${code}`)

return fields.length > 0 ? fields.join("; ") : "Unknown session error"
```

Object `message` text remains available only to the structured quota classifier. It is deliberately excluded from the safe summary and fetch-retry classification. String and thrown fetch errors still follow their existing retry path.

### Preserve the primary failure when the response file is absent

`src/harness/phases/finalize.ts` uses the fallback only for the exact failure combination below; the helper names are simplified pseudocode:

```ts
if (result.reason === "file-read-failed" && execution.success === false && execution.commentsPosted === 0) {
  await postTrustedFallbackComment()
  return failWithPrimaryExecutionError(execution)
}
```

The harness posts one static, action-owned comment to the target derived from trusted routing context, then returns the original execution exit code and failure. Successful executions with missing or malformed files remain fail-closed delivery errors; parse failures, guard failures, and writer failures do not enter this fallback.

### Use one absolute execution deadline

`createExecutionDeadline` in `src/features/agent/retry.ts` owns one deadline timestamp, abort signal, remaining-budget calculation, and timeout latch. The same object is threaded through server/session creation, event subscription, prompt submission, polling, V2 wait, retries, title operations, and artifact reads. `timeout: 0` leaves the deadline disabled.

Terminal acceptance uses the wall clock rather than waiting for the timer callback:

```ts
const pollResult = await Promise.race([waitPromise, pollPromise])

if (deadline?.isExpired() === true) {
  throw createDeadlineExceededError("prompt attempt")
}

await collectEventResults()
```

This establishes the authority boundary before cleanup begins.

### Bound cleanup without making it authoritative

SSE shutdown is idempotent and waits once for a bounded drain so prompt metadata can settle without hanging forever:

```ts
let eventProcessorShutdown: Promise<void> | null = null

const stopEventProcessor = async (): Promise<void> => {
  if (eventProcessorShutdown != null) return eventProcessorShutdown

  attemptController.abort()
  waitAbortController.abort()
  eventAbortController.abort()
  eventProcessorShutdown = waitForEventProcessorShutdown(eventProcessor)
  return eventProcessorShutdown
}
```

If the deadline expires after terminal success, artifact reconciliation is skipped or allowed to return no enrichment; it does not throw a replacement timeout. Title reassertion is skipped when the deadline is already expired.

Remote abort uses an explicit outcome latch in `src/features/agent/execution.ts`. It remains enabled while no terminal attempt result exists, is disabled when an attempt result is accepted, and is re-enabled only when a retry delay starts a new non-terminal window. The abort request itself is bounded and fail-soft.

## Why This Works

The fix separates four responsibilities that previously shared timeout state:

1. **Execution** produces the authoritative success or failure.
2. **Deadline classification** decides whether that result arrived in time using the wall clock.
3. **Cleanup and enrichment** harvest metadata and release resources within bounded budgets.
4. **Delivery** reports the result without replacing its causal failure.

The resulting invariant is small enough to test directly:

```ts
if (terminalResultAcceptedBeforeDeadline === true) {
  cleanupMayDegradeMetadata()
  cleanupMustNotRewriteOutcome()
} else if (deadlineExpiredBeforeTerminalResult === true) {
  return timeoutResult()
}
```

Secondary operations still fail closed where they own the outcome—for example, a successful execution that never produces its required response file remains a delivery failure. They simply cannot replace an earlier, authoritative execution failure with a less useful secondary error.

## Prevention

- Test both sides of every deadline boundary: terminal result before expiry versus terminal result after expiry.
- Include cleanup implementations that ignore cancellation; assert one bounded wait and no duplicate teardown.
- Assert pre-deadline success and final failure survive title, SSE, and artifact work crossing the deadline.
- Assert a retryable result does not retry when cleanup consumes the remaining budget.
- Gate remote abort on terminal-outcome state, not only on timer state.
- Normalize provider objects at ingress with allowlisted bounded fields; assert raw messages and nested secrets never reach logs, action failures, or comments.
- Keep missing-response fallback eligibility exact and mutually exclusive with normal response delivery.
- Preserve `timeout: 0` as an explicit opt-out and prove it with a never-resolving operation test.

## Related Issues

- [Issue #1252](https://github.com/fro-bot/agent/issues/1252)
- [PR #1277](https://github.com/fro-bot/agent/pull/1277)
- [Classifying an abort by AbortSignal.any's composite reason is racy — use a side-channel](abortsignal-any-reason-classification-race-2026-07-03.md)
- [Treat a model-authored response file as untrusted input and bind posting to the trusted event context](../best-practices/response-file-is-untrusted-input-2026-07-11.md)
- [An injected permission deny blocked the harness's own response-file delivery path](injected-deny-blocks-own-delivery-path-2026-07-13.md)
- [Fail fast on OpenCode account quota retries](../integration-issues/opencode-quota-retry-treated-as-activity-2026-07-15.md)
- [Build pipelines need a fallible preflight and guaranteed finally cleanup](../workflow-issues/build-pipeline-fallible-preflight-and-finally-cleanup-2026-06-22.md)
