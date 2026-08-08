---
title: Verify the signal before implementing the plan
date: 2026-08-08
category: workflow-issues
module: development-workflow
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - A plan proposes control flow around signals that have not been verified in the shipped dependency or runtime.
  - A change depends on inferred side effects, ordering, liveness, retryability, or truncation state.
  - Multiple adapters or fallback paths must expose the same evidence.
  - Tests pass before anyone has demonstrated that removing the fix makes them fail.
  - Mocks stand in for bounded, paginated, or versioned external systems.
root_cause: scope_issue
resolution_type: workflow_improvement
tags:
  - evidence-first
  - scope-correction
  - partial-observability
  - neutralization-testing
  - realistic-mocks
  - dependency-source
---

# Verify the signal before implementing the plan

## Context

Four units in the Bitter Lesson harness plan began with plausible but unverified premises:

- retry policy could distinguish attempts that completed with external side effects;
- provider errors exposed a broad set of structured fields that could replace prose classifiers;
- session progress could be inferred from server heartbeat, tool-progress, or busy-status signals;
- newest-evidence selection required coordinated changes in both query and budget layers.

Source-level investigation refuted every premise. The safe result was not to preserve the original scope by inventing proxies. Each unit was narrowed to the behavior the available evidence could support.

This is a workflow rule, not four unrelated implementation details: **prove that a signal exists and carries the meaning the plan assigns to it before designing control flow around it.**

## Guidance

### 1. Audit signal sufficiency before designing the state machine

For each planned decision, name the exact observable input and ask two separate questions:

1. Does the signal exist in the shipped runtime or dependency?
2. Does it prove the property the branch needs, including partial-failure cases?

Presence is not sufficiency. The OpenCode `busy` status is observable, but it is a latched value with no timestamp or progress field. It cannot distinguish a healthy long-running turn from a responsive server with a wedged session. Treating it as activity would remove the only detector for that failure mode.

Likewise, artifact counters collected from streamed tool output show that a write was attempted, not that the remote system accepted it. They cannot safely populate an outcome such as `completed_with_side_effects`.

### 2. Narrow the plan when evidence removes a capability

Do not preserve a planned variant, abstraction, or implementation unit merely because the plan named it.

The retry work dropped `completed_with_side_effects` because no trustworthy detector could populate it. The liveness work was withdrawn because `server.heartbeat` proved only that the SSE connection was alive, the declared tool-progress event was not emitted, and `busy` carried no progress information. In both cases, building the requested shape would have converted uncertainty into a false fact.

Record the correction in the plan before implementation. The amended plan becomes an honest decision log instead of a stale specification that the code quietly contradicts.

### 3. Prefer the strongest available signal, and describe it honestly

When a structured field exists, consume it directly rather than infer the same decision from prose. The provider error work found that `ApiError.data.isRetryable` was required by the SDK but ignored by the harness. The classification became `api_error`, not `llm_fetch_error`: the retryability signal was real, but the provider did not report a network-fetch cause. Stronger evidence should narrow the claim, not inflate it. Source: `src/features/agent/streaming.ts`.

### 4. Verify every parallel data path, not only the primary one

The context-selection plan named GraphQL and `budget.ts`. Investigation showed that `budget.ts` did no list ordering at all, while the unlisted REST fallback independently kept the oldest entries. Updating only GraphQL would have made the evidence shown to the model depend on which hydration path happened to succeed.

The final change aligned chronological collections across both paths:

```graphql
comments(last: $maxComments)
commits(last: $maxCommits)
reviews(last: $maxReviews)
```

```ts
const limitedComments = comments.slice(Math.max(0, comments.length - budget.maxComments))
```

Files were deliberately excluded. A pull request file list has no timestamp, so “newest files” is not a meaningful operation. Applying `last:` uniformly would replace one arbitrary path-ordered subset with another while pretending to improve relevance.

### 5. Prove tests discriminate by neutralizing the fix

A passing test only proves the current implementation and fixture agree. After implementing the fix, temporarily remove or invert the load-bearing line and confirm the targeted test fails for the expected reason.

This exposed multiple false-confidence cases during the same work:

- a rewritten liveness test passed against unchanged production code;
- truncation tests passed against `>=` and `>` because no fixture sat exactly at the cap;
- a file-overflow mock returned more entries than requested, hiding that the real API bounded the response at `per_page`.

The corrected file test models the actual request bound. Production over-reads one entry so overflow becomes observable:

```ts
client.rest.pulls.listFiles({
  owner,
  repo,
  pull_number: number,
  per_page: budget.maxFiles + 1,
})
```

Source: `src/features/context/fallback.ts`.

Without the over-read, `fetched > kept` is structurally false because the endpoint can return at most `maxFiles` items. Neutralizing `+ 1` must fail the overflow assertion.

### 6. Verify dependency behavior against the version actually shipped

Negative claims such as “this event does not exist” age silently and are easy to reach with an incomplete search. The cloned OpenCode source was initially pinned behind the harness base, then re-pinned to `v1.18.14`, matching `packages/harness/harness.config.json`. A later code-focused review still found `server.heartbeat` emitters that the original audit missed in the instance and global HTTP event handlers.

Dependency source is evidence only when its ref matches the consumed version, but a correct ref is not enough: absence claims must search the actual producers and transport handlers, not only SDK event unions or the consumers already known to the harness.

## Why This Matters

Weak signals usually fail in the dangerous direction:

- an inferred “no side effects” result permits duplicate writes;
- an existence-only check suppresses recovery for an empty artifact;
- a server heartbeat mistaken for session progress masks a wedged turn while the connection remains healthy;
- an unrealistic mock keeps a regression test green while production cannot observe the tested state;
- a stale dependency clone makes a true conclusion accidental rather than reproducible.

Evidence-first scope correction keeps uncertainty explicit. It produces smaller implementations, but more importantly it prevents the harness from encoding claims it cannot defend.

## When to Apply

Apply this before adding control flow around retry, recovery, liveness, delivery state, fallback classification, adapter equivalence, API caps or pagination, or cloned dependency source.

## Examples

### Unsupported planned capabilities: remove or withdraw them

`completed_with_side_effects` was removed because artifact counters showed attempts, not accepted remote effects. The liveness implementation was withdrawn because heartbeat showed server and connection health rather than per-session progress, the proposed tool-progress signal was not emitted, and `busy` was only a latched status.

In both cases, the right fix was scope correction: keep only behavior the available evidence can support. Retryability now maps from observable `AttemptOutcome` values in `src/features/agent/retry.ts`, while the existing test `does not treat matching busy session status as activity` remains the liveness regression guard.

### Incomplete repository evidence: record the gap

The carry ledger marks unsupported removal claims as “Unestablished in-repo” rather than fabricating a justification. Absence of evidence stays visible until a source-level audit supplies it.

## Prevention Checklist

- Name the exact signal and the property it must prove before designing the branch.
- Confirm the signal against the shipped dependency version and search its actual producers, not only remembered consumers or generated types.
- Treat unknown as its own state when collapsing it into yes/no would weaken a safety boundary.
- Amend the plan when investigation removes a capability or changes the owning layer.
- Trace all adapters and fallback paths that promise equivalent behavior.
- Make mocks honor real caps, ordering, pagination, and error shapes.
- Neutralize the load-bearing fix and confirm the targeted test fails for the expected reason.
- Record unsupported claims as unsupported; do not fill required-looking documentation fields with inference.

## Related

- [A gate that cannot fail manufactures confidence](non-failing-gates-are-worse-than-no-gates-2026-08-07.md) — failing-direction tests for gates whose inputs may be unreachable or fabricated.
- [File existence is not deliverable existence](../logic-errors/file-existence-is-not-deliverable-existence-2026-08-08.md) — use the same predicate as the consumer and preserve an explicit unknown state.
- [Inferred counters are not control-flow authority](../logic-errors/inferred-counters-are-not-control-flow-authority-2026-08-08.md) — diagnostic counters cannot prove remote effects landed.
- [Duplicate version sources cause silently-missed bumps](harness-base-version-source-of-truth-2026-06-12.md) — consumed-version sources must remain authoritative and synchronized.
- `docs/reference/carry-ledger.md` — records evidence and removal conditions for the twelve upstream harness carries.
- `docs/plans/2026-08-07-001-refactor-bitter-lesson-harness-flexibility-plan.md` — the amended U3, U4, U6, and U7 investigation outcomes.
