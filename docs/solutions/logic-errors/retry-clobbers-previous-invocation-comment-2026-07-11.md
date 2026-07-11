---
title: Comment-post retry that updates the last marker comment clobbers a previous invocation's response
date: 2026-07-11
category: logic-errors
module: agent-response-delivery
problem_type: logic_error
component: development_workflow
severity: medium
symptoms:
  - "A repeat agent mention in the same thread overwrites the previous run's posted response instead of adding a new comment"
  - "Retry after an ambiguous post failure can double-post or edit the wrong comment"
root_cause: logic_error
resolution_type: code_fix
tags:
  - idempotency
  - retry
  - marker-comment
  - github-comments
  - exactly-once
---

# Comment-post retry that updates the last marker comment clobbers a previous invocation's response

## Problem

Delivering "exactly one comment per invocation" with retries needs run-scoped idempotency: a retry must be able to tell "did my own earlier attempt already succeed?" apart from "did some *other* invocation already comment on this thread?"

## Symptoms

- A repeat @-mention of the agent in the same issue/PR thread overwrites the previous run's posted response instead of adding a new comment.
- A retry after an ambiguous post failure (write may have succeeded but the client saw an error) can double-post, or edit the wrong comment entirely.

## What Didn't Work

Retrying with `updateExisting: true`, targeting the most recent bot marker comment in the thread. The generic bot marker (`BOT_COMMENT_MARKER`) only identifies "a comment this bot posted" — it carries no run identity. In a thread where a *previous* invocation already posted its response, that marker-comment selection finds the last bot comment, which belongs to the prior run, not the one currently retrying. `updateExisting` then silently overwrites that earlier response with the current run's content.

## Solution

`postCommentWithRetry` in `src/features/agent/response-post.ts` keys idempotency on a run-scoped marker, not on "the last thing the bot posted":

- Every posted comment is stamped with a run marker: `<!-- fro-bot-response:{runId}-{runAttempt} -->` (`runMarker()`), embedding `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`.
- Attempt 1 always creates a new comment — never updates.
- Only on a *later* attempt (after an ambiguous failure) does it probe the thread for a bot comment containing *this run's* marker before creating again. If found, the earlier attempt actually succeeded and nothing more is posted. A previous run's generic-marker comment never satisfies this probe, because the run marker differs.
- If `botLogin` is unavailable, the probe is skipped and every attempt creates (an acknowledged, pre-existing ambiguous-duplicate risk on retry, unchanged from before this fix).
- Reviews are handled differently and deliberately not retried the same way: a duplicate *review* is worse than a failed run, so ambiguous review-submission failures fail loudly rather than retrying.

## Why This Works

The marker key includes the run identity, so cross-invocation collision is structurally impossible: two different invocations can never produce the same marker, and the same invocation's retry always produces the same marker. The probe therefore answers exactly the question that matters — "did *I* already post?" — without needing global mutable state or an external idempotency store.

## Prevention

Any "exactly once per invocation" delivery mechanism that includes retries must key its idempotency probe on the invocation's own identity (run ID + attempt, request ID, correlation ID), never on "the most recent thing this actor produced." The latter conflates *this* invocation with *any prior* invocation the moment more than one run can touch the same destination (thread, record, resource).

## Related

- [Treat a model-authored response file as untrusted input and bind posting to the trusted event context](../best-practices/response-file-is-untrusted-input-2026-07-11.md) — the same response-post path this idempotency logic lives in.
