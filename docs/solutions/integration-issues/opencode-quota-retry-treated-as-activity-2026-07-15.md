---
title: Fail fast on OpenCode account quota retries
date: 2026-07-15
category: integration-issues
module: agent-execution
problem_type: integration_issue
component: assistant
symptoms:
  - "Run 29180223942 failed with a provider quota error in roughly 1.2 seconds but the job timed out after 80 minutes"
  - "OpenCode correctly emitted a session.status retry event with action.reason=account_rate_limit and a retry-after of roughly 17h56m"
  - "OpenCode entered a multi-hour retry sleep while the harness stayed active until its 80-minute timeout"
  - "Retry events were treated only as evidence of activity, not as a terminal quota condition"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [opencode, quota, rate-limit, retry, sse, timeout, error-handling, provider-neutral]
---

# Fail fast on OpenCode account quota retries

## Problem
When an OpenCode provider account hit its quota, OpenCode correctly emitted a
`session.status` retry event carrying `action.reason=account_rate_limit` and a
multi-hour `retry-after`. Fro Bot's execution layer only used that event to
reset its activity/idle timers, so instead of failing the run immediately it
sat idle until the job-level timeout fired roughly 80 minutes later, wasting
CI time and producing a confusing timeout failure instead of a clear
quota-exhaustion failure.

## Symptoms
- Run 29180223942 failed provider quota in ~1.2s at the provider level, but the GitHub Actions job did not fail until the 80-minute timeout.
- OpenCode emitted `session.status` with `action.reason=account_rate_limit` and a retry-after of ~17h56m.
- The harness treated the retry event as generic activity, resetting idle/liveness timers rather than recognizing it as an unrecoverable quota state.
- No user-facing comment or review was posted explaining the failure; the run simply expired.

## What Didn't Work
- **Timeout tuning / log scraping**: Lowering job timeouts or grepping stdout/log lines for rate-limit phrases is fragile — provider error text varies, log scraping is not authoritative, and it doesn't generalize across providers or transports (SSE vs. REST polling).
- **Generic pre-response HTTP 402 fixture**: A one-size-fits-all "payment required" fixture used in tests didn't match the actual shape of provider quota signals (which arrive as a `session.status` retry action, not a bare HTTP error), so it gave false confidence without exercising the real code path.
- **Upstream carry**: Waiting on an upstream OpenCode change to short-circuit retries was rejected — Fro Bot needs to make a policy decision (fail fast) that OpenCode itself, as a general-purpose client, should not hardcode.

## Solution
Classify account-quota retries as a distinct, provider-neutral error and
fail the run immediately instead of waiting out the retry-after window:

- Added a provider-neutral quota `ErrorInfo` shape (`packages/runtime/src/agent/error-format/types.ts`) and formatting (`packages/runtime/src/agent/error-format/format.ts`) so quota failures are represented as structured data, not scraped strings.
- Added an exact retry-status classifier that inspects `session.status` retry `action.reason` (e.g. `account_rate_limit`) rather than pattern-matching log text.
- Made classification symmetric across transports — both the SSE stream consumer and the REST session-poll fallback recognize the same retry signal (`src/features/agent/streaming.ts`, `src/features/agent/session-poll.ts`).
- Gave quota classification priority over generic/transient error handling in the retry path (`src/features/agent/retry.ts`), and honored actual retryability: only genuine transient errors are retried, quota exhaustion is not.
- Added a v2 "wait" quota-failure outcome so the execution attempt cannot mistake quota exhaustion for successful completion.
- On quota failure, `src/harness/phases/finalize.ts` posts at most one trusted response — only when delivery conditions permit and no response has already been posted for the run — then fails the job deterministically instead of timing out.
- Raw provider event fields (which can carry account/billing details) are explicitly excluded from logs and any public-facing output; only the classified, provider-neutral summary is surfaced.

## Why This Works
The root cause was a category error: a terminal, unrecoverable condition
(account quota exhausted, retry-after measured in hours) was being handled by
code that only knew how to interpret retries as "the session is still alive."
By classifying the specific `account_rate_limit` retry reason as its own
error type — checked identically regardless of transport — the harness can
distinguish "worth waiting a few seconds for" from "no amount of waiting
within this job will help," and fail fast with an honest, single message
instead of silently spinning until an unrelated timeout kicks in.

## Prevention
- Maintain the exact account-quota producer fixture and add new retry reasons deliberately rather than folding them into quota handling by accident.
- Add behavior tests covering: SSE-delivered retry events, REST-poll-delivered retry events, the v2 wait-failure path, transient (genuinely retryable) 429s, the single-trusted-response delivery constraint, and confirmation that no raw provider event data leaks into logs or output.
- Classify based on structured signals (`action.reason`, event shape) — never regress to log-string matching, which breaks across providers and SDK versions.
- Keep job/step timeout policy strictly separate from quota classification; timeouts remain a backstop, not the primary failure signal for known quota conditions.

## Related Issues
- https://github.com/fro-bot/agent/issues/1206
- ../../plans/2026-07-15-002-fix-quota-limit-fail-fast-plan.md
- ../best-practices/extract-timer-primitive-keep-policy-per-surface-2026-07-13.md
- ../logic-errors/abortsignal-any-reason-classification-race-2026-07-03.md
- ../logic-errors/retry-clobbers-previous-invocation-comment-2026-07-11.md
