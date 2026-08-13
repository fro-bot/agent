---
title: Optional cleanup sync must guard incomplete run identity
date: 2026-08-13
category: logic-errors
module: development-workflow
problem_type: logic_error
component: development_workflow
symptoms:
  - "An empty-prompt workflow dispatch correctly skipped routing but still emitted a cleanup warning"
  - "Failed to build object store metadata key for upload"
  - "repository path must not be empty"
root_cause: logic_error
resolution_type: code_fix
severity: low
tags:
  - object-store
  - cleanup
  - workflow-dispatch
  - run-identity
  - finally-cleanup
---

# Optional cleanup sync must guard incomplete run identity

## Problem

An empty-prompt `workflow_dispatch` correctly stopped during routing, but `run()` still entered its `finally` block with `repo` and `runId` unset. Cleanup then attempted optional S3 artifact and metadata persistence, producing a non-fatal warning on an otherwise successful skipped run.

## Symptoms

Run `31730967099` contained the expected `Workflow dispatch requires prompt input` message, followed by:

```text
Failed to build object store metadata key for upload
repository path must not be empty
```

The warning was logged under the `object-store-artifacts` phase with an empty `runId`. The job still succeeded; the defect was the invalid persistence attempt and its warning noise, not a failed execution or a broader S3 or authentication problem.

## What Didn't Work

- **Skipping all cleanup when routing returns no work.** Cleanup is intentionally in `finally`. A broad guard would also suppress cache saving, prompt-artifact upload, session pruning, and server shutdown.
- **Inventing fallback repository or run identifiers.** Synthetic identity would hide the incomplete state and risk writing misleading or malformed object-store keys.

These were rejected designs, not production fixes. The correct boundary is the optional operation whose preconditions are stronger than cleanup as a whole.

## Solution

Keep `runCleanup()` unconditional, but require complete run identity only for the object-store artifact and metadata sync block in `src/harness/phases/cleanup.ts`:

```ts
if (storeConfig.enabled === true && repo !== "" && runId !== "") {
  // syncArtifactsToStore(...)
  // syncMetadataToStore(...)
}
```

The rest of cleanup remains outside this guard. Table-driven tests in `src/harness/phases/cleanup.test.ts` cover both missing values and assert that:

- `createS3Adapter`, `syncArtifactsToStore`, and `syncMetadataToStore` are not called;
- cache saving still runs; and
- prompt-artifact upload still runs when enabled.

PR [#1389](https://github.com/fro-bot/agent/pull/1389) merged the fix. Post-merge run [`31743621043`](https://github.com/fro-bot/agent/actions/runs/31743621043) exercised the same empty-prompt path on the merged commit: the expected skip message remained, while all three old warning signals had zero matches and the run had no warning annotations.

## Why This Works

`src/harness/run.ts` initializes `repo` and `runId` as empty strings, assigns them only after successful routing, and always invokes `runCleanup()` from `finally`. Early routing exits therefore have valid cleanup work but no valid run identity.

The runtime object-store key builder correctly rejects an empty repository path. The bug was calling that validated boundary from an execution path that had not established its preconditions. Moving the identity check to the narrow optional-sync boundary preserves the reason cleanup is unconditional while preventing an operation that cannot produce a meaningful key.

## Prevention

- Test early-return paths that still cross a `finally` boundary, not only fully processed runs.
- Gate optional cleanup sub-operations at the narrowest boundary that owns their preconditions.
- Assert that unrelated cleanup still executes when an optional sub-operation becomes a no-op.
- Keep object-store key validation strict; callers should prove identity completeness rather than weaken validation or manufacture fallback values.
- Use a live before/after check for production-only warning paths. Here the old object-store warning count changed from one to zero while the intended routing skip remained observable.

## Related Issues

- [Build pipelines — fallible work is a preflight, cleanup is a finally](../workflow-issues/build-pipeline-fallible-preflight-and-finally-cleanup-2026-06-22.md)
- [Terminal outcomes must survive deadline cleanup](terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md)
- [A read-only Actions cache token broke session continuity, and a discarded return value hid it](../integration-issues/read-only-actions-cache-token-broke-session-continuity-2026-08-11.md)
- [Centralize resource-key/identity construction to prevent silent cross-signal drift](../best-practices/centralize-s3-key-identity-construction-2026-06-09.md)
