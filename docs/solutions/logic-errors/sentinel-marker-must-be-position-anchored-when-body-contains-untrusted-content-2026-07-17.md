---
title: Idempotency sentinel markers must be position-anchored when the body contains untrusted content
date: 2026-07-17
category: logic-errors
module: release-notes-narration
problem_type: logic_error
component: tooling
symptoms:
  - apply step skips narration despite it having never run for this release (idempotency false positive)
  - idempotency check returns true when the marker substring appears anywhere in the release body, not only where the apply step writes it
  - a PR titled or commit-subjected with the literal marker string suppresses narration permanently for that release
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - development_workflow
tags:
  - sentinel-marker
  - position-anchor
  - structural-prefix
  - untrusted-body-content
  - changelog-forgery
  - idempotency-by-marker
---

# Idempotency sentinel markers must be position-anchored when the body contains untrusted content

## Problem

The release-notes apply job decides "already narrated, skip" by looking for a
sentinel marker (`<!-- fro-bot-narration-v1 -->`) in the release body. A bare
substring check treats the marker as present no matter where it appears — but the
release body embeds a `<details>` changelog whose PR titles and commit subjects are
user-influenced. A forged marker anywhere in that untrusted text trips the skip.

## Symptoms

- Narration is skipped for a release that was never narrated (idempotency false positive).
- The trigger is a PR title / commit subject containing the literal string
  `<!-- fro-bot-narration-v1 -->`, which semantic-release folds into the changelog.
- The suppression is permanent: the marker stays in the preserved changelog, so
  every re-run keeps skipping.

## What Didn't Work

```ts
// Substring-anywhere: any occurrence of the marker — including inside the
// embedded <details> changelog, where PR titles are user-influenced — counts
// as "already narrated."
if (body.includes(NARRATION_MARKER)) {
  return alreadyApplied()
}
```

## Solution

Anchor the check to the marker's **assembled position** — the marker only means
"narrated" when it sits immediately under the `## What's new` heading, which is the
one place the apply step writes it. `hasAppliedNarration` checks that structural
prefix at a line boundary, and the same function single-sources both the
idempotency skip and the post-edit verification.

```ts
// scripts/release/release-notes.ts
export const NARRATION_MARKER = '<!-- fro-bot-narration-v1 -->'

// The assembled shape always emits the heading line immediately followed by the
// marker line. Checking that exact structural prefix — rather than a bare
// substring search — prevents a forged marker embedded mid-changelog (e.g. inside
// a PR title that lands in the changelog) from being mistaken for applied narration.
const APPLIED_NARRATION_PREFIX = `## What's new\n${NARRATION_MARKER}`

export function hasAppliedNarration(body: string): boolean {
  if (body.startsWith(APPLIED_NARRATION_PREFIX)) {
    return true
  }
  return body.includes(`\n${APPLIED_NARRATION_PREFIX}`)
}
```

```ts
// scripts/release/assemble-release-notes.ts — runApply Step 1
// structural check (hasAppliedNarration), not a bare marker substring search
const currentBody = extractBody(ghView())
if (hasAppliedNarration(currentBody)) {
  return {exitCode: 0, message: `already-applied: release ${tag} body already contains the narration marker`}
}
```

## Why This Works

The marker is only semantically meaningful in the position the assembler writes it:
a heading line followed immediately by the marker line. User-influenced content in
the `<details>` changelog can contain the marker string, but it can never reach that
heading-adjacent position — the assembler controls the region above the changelog.
Anchoring the check to structure rather than presence makes the forgery inert.

## Prevention

- A sentinel/idempotency marker embedded in a body that **also** contains untrusted
  or user-influenced content must be **position-anchored** (matched at the exact
  structural position the writer emits it), never substring-matched anywhere in the body.
- Single-source the anchored check so the idempotency skip and the post-write
  verification cannot drift apart.
- Pin the forgery shape in a test:

```ts
// A marker forged inside a changelog-style bullet must NOT read as applied.
const forged = `## What's new\n\nsummary\n\n<details>\n* feat: add ${NARRATION_MARKER} support\n</details>`
expect(hasAppliedNarration(forged)).toBe(false)
```

## Related Issues

- [`../best-practices/release-notes-narration-routing-and-fail-soft-guards-2026-06-07.md`](../best-practices/release-notes-narration-routing-and-fail-soft-guards-2026-06-07.md)
  — the progenitor doc. Its idempotency rule now states the position-anchor
  requirement (a bare substring check is unsafe).
- [`retry-clobbers-previous-invocation-comment-2026-07-11.md`](./retry-clobbers-previous-invocation-comment-2026-07-11.md)
  — the identity-anchored twin. That bug keys idempotency on the invocation's own
  identity (run id + attempt); this one keys on structural position. Together they
  cover the marker-idempotency design space.
- [`../best-practices/response-file-is-untrusted-input-2026-07-11.md`](../best-practices/response-file-is-untrusted-input-2026-07-11.md)
  — same "the body contains untrusted content" trust-boundary discipline, applied
  to a committed response file rather than an in-body changelog.
- PR #1239 — the two-phase narration redesign where this was caught and fixed.
