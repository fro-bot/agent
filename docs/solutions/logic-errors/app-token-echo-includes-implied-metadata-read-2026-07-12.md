---
title: App installation token responses echo an implied metadata:read grant, breaking strict echo validation
date: 2026-07-12
category: logic-errors
module: scripts/harness
problem_type: logic_error
component: tooling
severity: high
symptoms:
  - "Inline App-token mint fails with token-mint-failed on every real run while all 30+ unit tests pass"
  - "A dry-run release dispatch stops fail-closed at the mint step; the merge never runs"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - development_workflow
tags:
  - github-app
  - installation-token
  - permissions-echo
  - all-or-nothing-validation
  - fail-closed
---

# App installation token responses echo an implied metadata:read grant, breaking strict echo validation

## Problem

Minting a scoped GitHub App installation token (`POST /app/installations/{id}/access_tokens`) with a request body of `permissions: { contents: "write" }` succeeded against every unit test fixture but failed on every real invocation.

## Symptoms

- The inline App-token mint step (`scripts/harness/mint-app-token.ts`) failed with `token-mint-failed` on every real run, while all 30+ unit tests passed.
- A dry-run release dispatch stopped fail-closed at the mint step; the "Run Fro Bot" merge step never ran.

## What Didn't Work

The validator deep-equaled the response's echoed `permissions` object against the exact `permissions` object sent in the request. That comparison assumes the API echoes back precisely what was requested — it doesn't. The real API response for a request of `{ contents: "write" }` comes back as `{ contents: "write", metadata: "read" }`: GitHub silently adds a non-requestable, non-declinable implied `metadata: read` grant to every installation token, regardless of what permissions were asked for. The request-vs-request comparison was passing in tests only because the fixtures had been written to mirror the request body, not a real API response — so the tests validated the assumption, not the API.

## Solution

Pin the expected echo as its own constant, separate from the request body:

```ts
// the permissions actually sent in the mint request — unchanged
const REQUESTED_PERMISSIONS = {contents: 'write'} as const

// what the API is documented (and observed) to echo back — includes the
// implied, non-requestable metadata:read grant every installation token carries
const EXPECTED_PERMISSIONS_ECHO = {contents: 'write', metadata: 'read'} as const
```

The validator then deep-equals the response against `EXPECTED_PERMISSIONS_ECHO`, not `REQUESTED_PERMISSIONS`. All-or-nothing semantics are preserved on both sides: a response missing the `metadata: read` echo (signaling an API contract change) is still rejected, and a response carrying anything broader — e.g. `metadata: write` — is still rejected. Fixed in PR #1182.

## Why This Works

The failure mode was the fail-closed design working exactly as intended: the mint step detected an echo it didn't recognize and refused to hand out a token rather than guessing whether the extra grant was benign. Nothing pushed, nothing merged, on a mismatch it couldn't explain. The fix isn't to loosen validation — it's to make the expected value correctly reflect the API's actual documented behavior, so a *real* contract change (a genuinely new or broader grant) still trips the same fail-closed path.

## Prevention

When validating a third-party API's echo under all-or-nothing semantics, pin the expected value against the **documented response shape** (or a response captured from a live call), never against the request body you sent. A live dry-run against the real API is the only test that catches request/response asymmetry — unit fixtures mirroring the request will pass while masking exactly this class of bug.

## Related

- `docs/solutions/best-practices/inline-scoped-app-token-mint-2026-07-12.md` — the inline mint pattern this validator is part of.
- `docs/solutions/workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md` — the all-or-nothing validation precedent this echo check follows.
- PRs #1179, #1182.
