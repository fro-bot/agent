---
title: Fail fast on structured provider authentication failures
date: 2026-07-25
category: integration-issues
module: agent-execution
problem_type: integration_issue
component: assistant
symptoms:
  - "Structured provider authentication failures were treated as ordinary retry activity"
  - "Runs could poll until the full execution deadline and report a generic timeout"
  - "The actionable authentication failure was not surfaced promptly"
  - "Provider-controlled fields risked reaching intermediate or public error surfaces"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - authentication
  - tooling
tags:
  - opencode
  - provider-auth
  - fail-fast
  - sse
  - polling
  - terminal-state
  - redaction
  - timeout
---

# Fail fast on structured provider authentication failures

## Problem

OpenCode can report an unusable model-provider credential through structured session events rather than a request that simply throws. Fro Bot treated those events as generic session activity, so a failure that was already observable could remain in the polling loop until the absolute execution deadline and surface as an unrelated timeout.

The durable fix is not to infer authentication from arbitrary error text. It is to recognize exact structured markers at the event boundary, convert them into one authoritative terminal provider error, and rebuild a safe provider-neutral response at the trusted delivery boundary.

## Symptoms

- A `session.status` retry with `action.reason === 'auth_unavailable'` kept the run alive instead of terminating it.
- A `session.error` named `ProviderAuthError` could enter generic error handling rather than a dedicated auth path.
- SSE and REST polling could disagree when only one transport observed the auth event.
- The run eventually failed as a timeout instead of reporting that provider authentication needed operator action.

## What Didn't Work

- **Matching messages or bare HTTP statuses.** Provider text is unstable and may contain tokens, URLs, account identifiers, or nested response details. A bare `401`, `403`, or `503` also does not prove the model provider is the failing authority.
- **Adding a parallel auth flag.** Quota failures already used terminal provider state. A second lifecycle flag would let polling, retries, deadlines, and finalization drift between two representations of the same policy decision.
- **Aborting only the SSE stream.** Poll-only failures would still hang, and stream cancellation would become an unnecessary second authority for deciding the execution outcome.
- **Forwarding the provider payload to finalization.** Even correctly classified input remains untrusted data. Public error text and the comment target must be reconstructed from harness-owned constants and routed event context.

## Solution

### Classify only exact structured markers

`classifyProviderAuthError` in `packages/runtime/src/agent/error-format/format.ts` accepts two bounded inputs:

```ts
export function classifyProviderAuthError(input: ProviderAuthErrorInput): ErrorInfo | null {
  if (input.kind === "retry-status") {
    if (normalizeProviderAuthString(input.reason) !== "auth_unavailable") return null
    return createProviderAuthError()
  }

  if (normalizeProviderAuthString(input.name) === "ProviderAuthError") {
    return createProviderAuthError()
  }

  return null
}
```

Everything else remains generic or retryable unless another explicit classifier owns it. The resulting `provider_auth_error` contains fixed text only; it retains no provider identifier, message, status, code, URL, or route hint.

### Merge auth and quota into one sticky terminal state

`mergeActivityError` in `src/features/agent/streaming.ts` generalizes the earlier quota path. A generic observation may upgrade to a terminal provider error, but the first terminal provider error freezes the state:

```ts
const existingTerminal = activityTracker?.terminalProviderError
if (existingTerminal != null) return existingTerminal

const candidateIsTerminal = isTerminalProviderError(candidate)
const existingIsTerminal = existing != null && isTerminalProviderError(existing)
let merged = existing ?? candidate
if (existingIsTerminal) merged = existing
else if (candidateIsTerminal) merged = candidate
```

Both `processEventStream` and `pollForSessionCompletion` feed this state. The retry path checks it before retrying or accepting a successful V2 wait result, so a poll-only auth failure and an SSE auth failure converge on the same outcome.

Deadline ordering remains explicit: a terminal provider error observed before the deadline is authoritative; a deadline that became authoritative first remains a timeout. No cleanup or later generic observation can rewrite the winner.

### Rebuild trusted failure delivery

`runFinalize` in `src/harness/phases/finalize.ts` does not format the incoming provider payload. It calls `createProviderAuthError()` again, derives the target exclusively from trusted routing context, posts at most one comment when delivery is allowed, calls `core.setFailed` with fixed text, and returns exit code `1`.

This path deliberately bypasses response-file handling. Provider authentication is a harness-owned terminal failure, not model-authored response content, and it must remain a failed run even if another response was already recorded.

## Why This Works

The root cause was a category error: the harness interpreted a terminal provider condition as evidence that the session was still active. Normalizing the structured marker once gives streaming, polling, retries, deadline logic, and finalization one shared answer to the question "is this run recoverable?"

Keeping classification and delivery separate also preserves the security boundary. The event decides only the closed error type. Harness-owned code decides the public wording, target, delivery count, and exit status. Refreshing or replacing the upstream credential remains an operational remediation; it is not part of the classifier contract.

## Prevention

- Pin positive fixtures for exact `ProviderAuthError` and `auth_unavailable` markers, plus negative fixtures for bare statuses, generic outages, malformed values, and lookalike strings.
- Exercise both event-envelope versions and both observation paths: SSE-delivered auth and poll-only auth with no SSE event.
- Prove the execution boundary cannot retry the failure or convert it to success through `v2.session.wait()`.
- Test both deadline orderings: auth observed first versus deadline authoritative first.
- Use distinctive sentinel provider IDs, messages, tokens, account names, URLs, and route hints. Raw values may exist only in the inbound fixture payload; assert they are absent from derived `ActivityTracker`, poll result, `EventStreamResult`, attempt/final result, logs, `core.setFailed`, posted output, and routing/comment targets.
- Assert provider data cannot influence the repository, issue, pull request, or comment surface selected for delivery.
- Keep quota regression coverage intact when changing shared terminal-provider state.
- Pin exactly-one delivery and `exitCode === 1` for every terminal auth path.

## Related Issues

- [Issue #1253](https://github.com/fro-bot/agent/issues/1253)
- [PR #1283](https://github.com/fro-bot/agent/pull/1283)
- [Provider auth fast-fail implementation plan](../../plans/2026-07-24-001-fix-provider-auth-fast-fail-plan.md)
- [Fail fast on OpenCode account quota retries](opencode-quota-retry-treated-as-activity-2026-07-15.md)
- [Terminal outcomes must survive deadline cleanup](../logic-errors/terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md)
- [Treat a model-authored response file as untrusted input and bind posting to the trusted event context](../best-practices/response-file-is-untrusted-input-2026-07-11.md)
