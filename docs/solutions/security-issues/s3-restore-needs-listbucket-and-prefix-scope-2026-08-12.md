---
title: An IAM policy derived from the save path silently disabled restore
date: 2026-08-12
category: security-issues
module: runtime
problem_type: security_issue
component: service_object
symptoms:
  - "Object store restore failed - treating as miss"
  - "Failed to list object store session files"
  - "Runs stay green while every session cold-starts"
  - "A shared-bucket policy grants delete reach over a co-tenant repository's data"
root_cause: missing_permission
resolution_type: config_change
severity: high
related_components:
  - documentation
tags:
  - s3
  - iam
  - least-privilege
  - listbucket
  - session-storage
  - fail-soft
---

# An IAM policy derived from the save path silently disabled restore

## Problem

The IAM policy for durable S3 session storage was derived from how the save path behaves — object keys come from a fixed filename set, so nothing needs to list. That reasoning produced `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, and omitted `s3:ListBucket`. The restore path lists before it downloads, so restore would have returned nothing, permanently and quietly.

## Symptoms

Nothing raises. The observable signature is a run that succeeds while behaving as though no state exists:

- One warning, `Failed to list object store session files` (`packages/runtime/src/object-store/content-sync.ts`)
- Every session starts cold, with no failed step and no non-zero exit

## What Didn't Work

**Reasoning from the write path.** `syncSessionsToStore` iterates a fixed constant and uploads each name it finds — no discovery, so no listing. True, and only half the subsystem. `syncSessionsFromStore` opens with `adapter.list(prefix)`, which issues `ListObjectsV2Command` and requires `s3:ListBucket`.

**Checking against the repo's own documentation.** `README.md:229` already stated the principal needs `s3:GetObject`, `s3:PutObject`, and `s3:ListBucket`. The policy contradicted published setup instructions and nobody noticed, because a contradiction between a policy and a README produces no signal at all.

**Verifying with a text pattern.** Enumerating the adapter's commands with a regex of the shape `new [A-Za-z]+Command\(` returned three results and appeared to confirm the original claim. `ListObjectsV2Command` contains a digit, so the character class could not match it. The verification step reproduced the bug it was meant to catch.

## Solution

Grant `s3:ListBucket` alongside the object actions, and scope each to the narrowest path that satisfies it. `ListBucket` is a bucket-level action, so it cannot share a statement with the object-level ones:

```json
{
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::BUCKET/PREFIX/*/OWNER/REPO/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::BUCKET",
      "Condition": {"StringLike": {"s3:prefix": "PREFIX/*/OWNER/REPO/*"}}
    }
  ]
}
```

Keys are built as:

```ts
const baseKey = `${validatedPrefix.data}/${sanitizedIdentity.data}/${repoPath}/${contentType}`
```

Identity is `github` for session content and `coordination` for the lock. The wildcard in that segment is a deliberate tradeoff, not a minimal grant, and it is worth being precise about why: **`*` matches `/` in both resource ARNs and `s3:prefix` conditions**, so `PREFIX/*/OWNER/REPO/*` also admits deeper paths such as `PREFIX/a/b/OWNER/REPO/...`. The key builder sanitizes its identity segment and cannot produce those, but an IAM policy bounds the principal, not one code path.

Enumerating `github` and `coordination` explicitly is the stricter posture, at the cost of a new identity constant failing closed until someone updates the policy — a failure this doc argues is easy to miss. Pick deliberately; do not assume the wildcard is minimal because it looks scoped.

This policy covers the Action's identity only. The gateway additionally writes tagged run-state and heartbeat objects (`tagging: RUN_STATE_TAG`), which require `s3:PutObjectTagging`; the Action runs neither, per the design note in `src/harness/phases/acquire-lock.ts`.

## Why This Works

Both paths are now covered, and the failure mode that hid the gap is understood rather than removed.

The degradation is quieter than it first appears. `adapter.list` returns a `Result` rather than throwing, so a denied list takes the handled branch in `syncSessionsFromStore` — one warning, then `{downloaded: 0, failed: 1, mainDbRestored: false}`. It never reaches the `catch` in `restore.ts` that logs `Object store restore failed - treating as miss`; that path is for thrown errors. The store simply reports itself empty, `restoreCache` falls through to the Actions cache, and the run is green.

That fail-soft design is correct — a storage outage must not break a run. It also means an under-granted policy is indistinguishable from an empty store. **The more gracefully a subsystem degrades, the less its permissions can be validated by watching it run.**

## Prevention

**Enumerate call sites structurally, across every arity.** A text search matches the shape you imagined; a structural query matches the code:

```bash
ast-grep --pattern 'buildObjectStoreKey($C, $I, $R, $T, $$$)' --lang ts
ast-grep --pattern 'buildObjectStoreKey($C, $I, $R, $T)'      --lang ts
```

Both forms, and every package. Scoping the first sweep to two directories undercounted by four call sites; the real figure is 13 matches, 10 outside tests, against the two that were front of mind.

**Enumerate the read path separately from the write path.** They are different code with different operations. Listing, tagging, and metadata reads are routinely present on one side and absent from the other.

**Treat disagreement with existing documentation as a finding.** Here the README was right and the fresh analysis was wrong.

**Verify a tightened policy with a negative case.** Positive checks prove sufficiency; only a negative check proves boundedness. Under the runtime identity, this repository's subtrees should allow put/list/get/delete while co-tenant prefixes deny list and head.

Read raw responses when probing. A projection such as `--query KeyCount` against `list-objects-v2` returns empty because that field is absent from the response shape — indistinguishable from a denial, and it sent this investigation sideways for a step.

**Re-scope when the bucket is shared.** Listing the prefix during verification surfaced another repository's data under the same root, including a 331 MB session database. Key construction namespaces by owner and repository so there was no collision risk, but the prefix-level policy granted `DeleteObject` over a co-tenant's state. Getting the operations right and the resource path wrong still leaves a policy far broader than the workload.

## Related Issues

- [A check reports clean for the part of the world it cannot observe](../workflow-issues/checks-report-clean-for-what-they-cannot-observe-2026-08-10.md) — the sibling epistemic failure: a check that runs, passes, and covers less than assumed.
- [A read-only Actions cache token broke session continuity](../integration-issues/read-only-actions-cache-token-broke-session-continuity-2026-08-11.md) — the incident this storage work resolved, also hidden by a layer that degraded politely.
- [Reusable-workflow permissions replace, not merge](../best-practices/reusable-workflow-permissions-replace-not-merge-2026-07-01.md) — another permission model whose real behavior differs from the intuitive reading.
- [Repair on restore must precede capture on save](../logic-errors/repair-before-capture-sqlite-session-cache-loop-2026-09-02.md) — the same restore-is-not-save asymmetry one layer down: capability there, atomicity here, since an Actions cache entry is one archive while an object-store prefix is independently-overwritten keys.
