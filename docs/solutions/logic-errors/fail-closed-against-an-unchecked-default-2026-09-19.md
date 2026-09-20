---
title: A fail-closed rule disabled the feature it protected, because nobody checked the default
date: 2026-09-19
category: logic-errors
module: response-delivery
problem_type: logic_error
component: development_workflow
symptoms:
  - Default-configured runs deliver no review and no comment, and exit 1
  - The failure reads `review-guard-blocked — Review guard blocked submission: receipt-blocked`
  - Every fork pull request is affected regardless of how the operator configured it
  - Invisible in the repository that develops the Action, because that repository enables the store
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [fail-closed, default-configuration, fork-pull-request, object-store, at-most-once, composition-testing]
---

# A fail-closed rule disabled the feature it protected, because nobody checked the default

## Problem

A durable receipt was added so a rerun could not post a second review — reviews are irreversible and have no find-and-update path, and GitHub preserves `GITHUB_RUN_ID` across reruns, so the existing time-window dedup marker could not suppress the duplicate. The receipt was deliberately made fail-closed: with its object store unavailable, block submission rather than risk a duplicate.

The store is off by default and force-disabled on every fork PR. So the rule blocked review delivery for most consumers of the Action.

## Symptoms

- `action.yaml:31-34` — `s3-backup` defaults to `'false'`, so any consumer who has not opted in hits this path.
- `src/harness/config/inputs.ts:315-338` — fork pull requests have the store disabled regardless of configuration, which the operator cannot override.
- The run calls `core.setFailed` and exits 1 with **nothing posted** — not even a degraded comment, because a `pr-review` surface requires a verdict.
- The reason surfaced as `receipt-blocked`, which describes the mechanism and not the cause.

It shipped and fired in this repository's own CI, where the review agent could not deliver its own review:

```
##[error]Failed to deliver the agent's response from .../35465422643-1:
review-guard-blocked — Review guard blocked submission: receipt-blocked
```

The repository that develops the Action enables the store, so the broken path never ran here during development. That is why it reached production.

## What Didn't Work

The original reasoning was explicit and internally coherent: *an unavailable store means the at-most-once guarantee cannot be enforced, and an unenforced guarantee is worse than a refused submission.* Every step of that follows — from a premise nobody checked.

Refusing loudly at input-parse time was considered as an alternative and is also wrong: fork PRs have the store disabled by design and their operator cannot fix it, so a parse-time failure would hard-fail every fork with no remedy.

## Solution

Separate *store absent* from *store failing*, at construction, before any adapter exists.

```ts
// src/services/github/review-delivery-receipt.ts:215-273
if (storeConfig.enabled === false) {
  return {
    reserve: async (identity, attempt) => {
      logger.warning(
        'Review delivery receipt: object store not configured -- submitting without at-most-once protection; a rerun of this invocation could duplicate this review',
        {identity, attempt},
      )
      return {kind: 'reserved-unconfigured'}
    },
    recordDelivered: async () => { /* nothing was reserved */ },
    release: async () => { /* nothing was reserved */ },
  }
}

const adapter = adapterOverride ?? createS3Adapter(storeConfig, logger)
```

A *configured* store that fails — missing conditional support, read error, conflict, malformed record — still blocks, unchanged.

A later round found a second defect in the same area. The guard decided whether to skip its post-reservation head re-check by comparing the reservation's etag to the sentinel string `'unconfigured'` — inferring a *capability* from a *value*. A test written to pin that assumption failed deterministically: a reservation whose etag spelled that literal skipped its check and submitted against a moved head. Fixed by making provenance part of the type:

```ts
// src/services/github/review-delivery-receipt.ts:110-120
export type ReviewDeliveryReservationOutcome =
  | {readonly kind: 'reserved-configured'; readonly etag: string}
  | {readonly kind: 'reserved-unconfigured'}
  | {readonly kind: 'blocked'; readonly reason: ReviewDeliveryReservationBlockedReason; readonly detail: string}
```

The unconfigured variant carries no etag at all, so there is no value to collide with rather than a value unlikely to collide. The sentinel was deleted.

## Why This Works

An unconfigured store is not a failure. There is nothing to reserve against, so there is nothing to fail closed *on*. The honest behaviour is to submit unprotected and say so in the log.

A configured store that errors is a different situation: the operator opted into the guarantee and it is now failing at runtime. Blocking is correct there.

The duplication risk for unconfigured consumers is the **status quo** — it existed before the receipt and is not a new hazard. A safety feature may decline to improve a situation it cannot reach. It may not make that situation worse.

The split belongs at construction rather than the call site because the returned object should encode the guarantee it can actually provide. A caller should read `kind`, not infer capability from a boolean or a string.

## Prevention

**The rule:** a fail-closed gate must be evaluated against the configuration it will actually run under — including the default, and including the cases where configuration is forced and the operator has no say. "Unavailable" and "never configured" are different states and must not share a branch.

Before shipping a fail-closed rule, answer three questions in writing:

1. What is the default value of the dependency this gate needs? Read the manifest, do not assume.
2. Is there a topology where the dependency is forced off regardless of configuration? Fork PRs, restricted tokens, and read-only environments are the usual ones.
3. If the answer to either is "the gate fires," is that acceptable — or has the feature been disabled for its own users?

Two supporting rules this incident produced:

- **Test the composition, not just the leaves.** Every test mocked the reservation operations, so nothing exercised the real construction against a real store config. Each unit was correct; the composition was broken. That seam is where this class of bug lives. The regression tests added afterwards build the real operations from a real config and cover default-off, configured-failure, and fork.
- **Read a discriminant, not a value.** If a later decision depends on which path produced a result, make that a variant in the type. A sentinel value is a convention; a discriminant is a guarantee. Parse, don't validate.

## Related Issues

- `docs/solutions/logic-errors/file-existence-is-not-deliverable-existence-2026-08-08.md` — the three-state rule. A boolean cannot express "unknown", and this incident is the same shape one level up: a boolean could not express "never configured".
- `docs/solutions/logic-errors/failed-run-reported-success-with-no-delivery-surface-2026-08-07.md` — a run reporting success with nothing delivered. This is the inverse: a run reporting failure with nothing delivered, for a reason that was not a failure.
- `docs/solutions/integration-issues/read-only-actions-cache-token-broke-session-continuity-2026-08-11.md` — closest prior instance of inferring a capability from a sentinel-shaped return value.
- Shipped in PR #1629.
