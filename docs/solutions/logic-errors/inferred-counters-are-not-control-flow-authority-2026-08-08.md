---
title: Counters inferred from stream text cannot authorize a replay decision
date: 2026-08-08
category: logic-errors
module: agent-execution
problem_type: logic_error
component: service_object
symptoms:
  - "A recovery gate reads zero side effects from an attempt that died mid-flight"
  - "A counter intended as reporting metadata is used to make a safety decision"
  - "A planned design variant has no observable input that can populate it"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags:
  - inference
  - observability
  - recovery
  - replay-safety
  - control-flow
---

## Problem

The execution result carries `prsCreated`, `commitsCreated`, and `commentsPosted`. They look like a record of what the agent did, and a recovery gate used one of them to decide whether re-running was safe:

```ts
if (result.llmError?.type === 'context_overflow' && result.commentsPosted === 0 && sessionId != null) {
```

Those counters are populated by detecting artifacts in SSE events and tool-output text. They evidence that a write was _attempted and observed_, never that it _landed_. Two consequences:

- A write that reached GitHub before the stream died leaves the counters at zero, because detection never ran.
- Text that resembles a result — a model quoting a URL, a tool echoing a command — can increment them without any write occurring.

The failure direction is the dangerous one. The counters read empty exactly when an attempt dies mid-flight, which is precisely when the gate is consulted. A gate keyed on "zero effects observed" therefore reads _permissive_ in the case where effects are most likely to be unconfirmed.

## Symptoms

- Recovery proceeds after an attempt that may have already posted or pushed.
- Reasoning about the gate looks sound in the happy path and inverts under partial failure.
- A design that depends on classifying "completed with side effects" cannot be implemented honestly, because no input can populate it.

## What Didn't Work

**Reading the counters as a ledger.** They are named for the effects, not for the evidence, so they invite being trusted as a record. The name describes intent; the derivation describes reliability.

**Looking for a better detector.** The signals that genuinely prove an effect — the return values of the commit, comment, and review calls — exist only in the delivery path, downstream of where the recovery decision is made. There is no reliable pre-replay detector to find. That is a fact about the architecture, not a gap in the search.

## Solution

Gate on facts that are structural rather than inferred:

```ts
// Provisioned credentials can hide completed external writes; only a non-provisioned run without a valid response may be replayed.
if (
  result.llmError?.type === 'context_overflow' &&
  credentialProvisioned === false &&
  responseFileStatus === 'absent' &&
  sessionId != null
) {
```

Both inputs are observable rather than inferred. The credential is withheld entirely for the events that carry one, so on those events the agent _cannot_ write to GitHub — that is enforced by construction, not detected after the fact. The response file is removed before the run, so its state is attributable to this attempt.

The planned outcome variant that would have described "completed, with side effects" was dropped rather than implemented, because the only inputs available to populate it were the inference-derived counters. A variant asserting a fact the system cannot observe is worse than not having the variant: it launders an unknown into a claim.

The counters remain, and remain useful, for reporting and run summaries. They just do not authorize decisions.

## Why This Works

Replay safety needs evidence of what happened. Where such evidence does not exist, the honest options are to narrow the decision to facts that are structurally guaranteed, or to decline. Both are available here; inventing confidence was not.

## Prevention

- **Ask how a value is derived before letting it gate anything.** Detected-from-text and returned-by-the-API are different reliability classes wearing the same field name.
- **Check which way the signal fails.** A signal that reads empty on partial failure is unusable for a gate consulted on partial failure, regardless of accuracy in the happy path.
- **Prefer structural facts to observed ones.** "This event class never receives a credential" is stronger than "we did not detect a write", because it is enforced rather than measured.
- **Write the fallback into the plan before the investigation runs.** This unit was specified as "name the signal before building the lattice", with an explicit instruction that a narrower design was the correct outcome if no sufficient signal existed. That pre-authorization is what made dropping a planned variant a normal step rather than a scope failure — without it, the pressure is to implement the variant on whatever data is nearest.
- **A variant no input can populate is not a conservative placeholder.** It reads as a supported case to every future caller.

## Related Issues

- [Absence of an outcome is not a failed outcome](../workflow-issues/absence-of-outcome-is-not-a-failed-outcome-2026-08-07.md) — the same separation of observed fact from missing evidence, applied to scoring.
- [A gate that cannot fail manufactures confidence](../workflow-issues/non-failing-gates-are-worse-than-no-gates-2026-08-07.md) — a gate whose input could not distinguish the states it claimed to.
- [File existence is not deliverable existence](file-existence-is-not-deliverable-existence-2026-08-08.md) — the replacement gate's other input, and its own weak-predicate history.
