---
title: Structural validators over markdown bodies must be code-span aware
date: 2026-07-17
category: logic-errors
module: release-notes-narration
problem_type: logic_error
component: tooling
symptoms:
  - apply job rejects a legitimate narration candidate with `contains-details` (or `contains-marker`)
  - the rejected candidate never contains a real details block — only prose describing one in inline code
  - the false positive is self-referential — narrative text describing the validator's own defenses trips the validator
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - development_workflow
tags:
  - markdown-validation
  - code-spans
  - inline-code
  - fenced-code
  - self-referential-prose
  - fail-closed
---

# Structural validators over markdown bodies must be code-span aware

## Problem

The release-notes apply job validates the model-written narrative candidate before
assembling the release body, rejecting structural forgery: a smuggled narration
marker (`contains-marker`) or a details tag (`contains-details`, matched with the
structural regex `/<\/?\s*details\b/i`).

Both checks scanned the **raw candidate text**. But markdown has two render layers:
a code-quoted tag (`` `<details>` `` or a fenced block) renders as literal text on
GitHub and can never open a block or forge the marker's structural position. Prose
that *describes* the defense is indistinguishable from an attack when the scan
ignores code spans.

The first live narration run (v0.93.0) hit exactly this: the model legitimately
summarized the new validation pipeline — "validates it (size, control characters,
no marker or `<details>` forgery, …)" — and the apply job rejected its own
feature's release notes. Self-referential prose is not an edge case here: release
notes about security hardening will routinely name the structures the validator
scans for.

## Symptoms

- `candidate rejected (contains-details); release vX.Y.Z left untouched` in the
  apply-job log, while the downloaded candidate contains no raw details tag —
  only a code-quoted mention.
- Fail-soft masking: the release ships with the plain changelog and the run stays
  green (warning only), so the false positive is easy to miss without reading the
  apply log.

## What Didn't Work

```ts
// Scanning the raw candidate: prose describing the defense in inline code
// (`<details>`) matches the same regex as a real forgery attempt.
if (DETAILS_TAG_PATTERN.test(candidate)) {
  return {ok: false, reason: 'contains-details'}
}
```

## Solution

Strip **well-formed** code spans before the structural scans — and only before
those scans. `stripCodeSpans` blanks the contents of fenced code blocks and inline
code spans (preserving newlines/offsets); the `contains-marker` and
`contains-details` checks run on the stripped text. All other checks (size,
control characters, commit-list dump, PR-link presence) still scan the raw text.

```ts
// scripts/release/assemble-release-notes.ts
const candidateWithoutCodeSpans = stripCodeSpans(candidate)

if (candidateWithoutCodeSpans.includes(NARRATION_MARKER)) {
  return {ok: false, reason: 'contains-marker'}
}

// Code-quoted tags are rendered as text by GitHub and cannot open a details block.
if (DETAILS_TAG_PATTERN.test(candidateWithoutCodeSpans)) {
  return {ok: false, reason: 'contains-details'}
}
```

The stripper's correctness burden is asymmetric: **failing to strip is safe
(over-rejection, fail-soft), stripping too much is a security hole (fail-open)**.
Two fail-open hazards were caught during review and are pinned by tests:

1. **Invalid backtick fences.** CommonMark forbids backticks in a backtick fence's
   info string — a line like ```` ```js` ```` is *not* a fence, and GitHub renders
   the following lines as live markup. Blanking that region would hide a real
   `<details>` from the scan. The stripper rejects such fences (tilde fences are
   exempt; tildes may appear in `~~~` info strings).
2. **Cross-newline inline spans.** A stray backtick opening a "span" that closes
   on a later line would blank line-starting HTML in between — and a line-starting
   HTML tag interrupts the paragraph as a block per CommonMark, i.e. it renders
   live. Inline spans are confined to a single line.

Anything unbalanced or malformed stays in the scanned text.

## Why This Works

The threat model is *rendered structure*, not byte content: a details tag or
marker only matters if GitHub renders it structurally. Code spans are the one
markdown construct guaranteed to render as literal text, so exempting well-formed
spans removes exactly the false-positive class without widening the attack
surface. Keeping every ambiguous case (unbalanced backticks, invalid fences,
multi-line spans) in the scanned text preserves the fail-closed default: when the
stripper is unsure whether text renders literally, the validator still sees it.

## Prevention

- When a validator scans a **markdown body** for structural threats (HTML tags,
  sentinel markers, injection shapes), decide explicitly which render layer the
  threat lives in. If the threat requires rendering, exempt well-formed code
  spans; if it is byte-level (control characters, hidden Unicode), scan raw.
- Make the stripper conservative in the fail-closed direction: only blank spans
  that are unambiguously well-formed under the renderer's actual rules
  (CommonMark), and leave everything else visible to the scan.
- Expect self-referential prose: any feature whose release notes, docs, or review
  comments describe the validator will contain the scanned-for strings in code
  spans. Pin that exact shape as an accepted-input test — the v0.93.0 incident
  candidate is the fixture.
- Pin the fail-open hazards as rejected-input tests (invalid info-string fence
  followed by a raw tag; unbalanced backtick before a raw tag), so a future
  stripper refactor cannot silently widen what gets blanked.

## Related Issues

- [`./sentinel-marker-must-be-position-anchored-when-body-contains-untrusted-content-2026-07-17.md`](./sentinel-marker-must-be-position-anchored-when-body-contains-untrusted-content-2026-07-17.md)
  — the adjacent validation bug in the same pipeline: that one anchors *where* the
  marker means something; this one scopes *which render layer* the scan applies to.
- [`../best-practices/release-notes-narration-routing-and-fail-soft-guards-2026-06-07.md`](../best-practices/release-notes-narration-routing-and-fail-soft-guards-2026-06-07.md)
  — the progenitor narration doc (routing, fail-soft posture, marker scheme).
- [`../best-practices/response-file-is-untrusted-input-2026-07-11.md`](../best-practices/response-file-is-untrusted-input-2026-07-11.md)
  — same trust-boundary discipline: untrusted authored text must not control
  structural enforcement, applied to a committed response file.
- [`./injected-deny-blocks-own-delivery-path-2026-07-13.md`](./injected-deny-blocks-own-delivery-path-2026-07-13.md)
  — sibling incident class: a security feature colliding with its own legitimate
  delivery path.
- PRs #1241 (the fix + both fail-open pins) and #1243 (compose-contract fix from
  the same v0.93.0 shakeout); incident run 29556739851.
