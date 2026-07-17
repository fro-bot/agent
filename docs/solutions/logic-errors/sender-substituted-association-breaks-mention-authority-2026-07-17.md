---
title: 'Sender-substituted author association silently changes whose authority hasMention carries'
date: 2026-07-17
category: logic-errors
module: src/features/triggers
problem_type: logic_error
component: trigger_routing
severity: high
symptoms:
  - 'A policy override keyed on hasMention passed authorization checks for the wrong identity'
  - 'Labeled PR from an unauthorized fork author would have run a review when a maintainer marked it ready_for_review'
  - 'All unit tests passed — each check was correct in isolation; the bug was in their composition'
root_cause: confused_deputy
resolution_type: code_fix
related_components:
  - trigger_routing
  - authorization
tags:
  - author-association
  - hasMention
  - sender-substitution
  - confused-deputy
  - skip-conditions
---

# Sender-substituted author association silently changes whose authority hasMention carries

## Problem

The review-skip-label feature (#1216) let an authorized `@fro-bot` mention override the
opt-out label. The override read `context.hasMention === true` and relied on the
`unauthorized_author` check earlier in the PR skip chain having validated "the author."

But for `review_requested` and `ready_for_review` events, `routeEvent`
(`src/features/triggers/router.ts`) substitutes the webhook **sender's** association into
`context.author.association` before skip checks run — the webhook payload lacks a usable
association for those senders, so the router resolves it via API and overwrites the field.
Meanwhile `hasMention` is parsed from the **PR body**, which the PR author controls
(`buildPullRequestContextData`).

Composition failure: on `ready_for_review`, the authorization check validates the sender
(an authorized maintainer clicking "ready for review"), while the mention override honors
body text written by the possibly-unauthorized PR author. An unauthorized fork author
could plant `@fro-bot` in the PR body of a labeled PR; when a maintainer later marks it
ready, the planted mention overrides the skip label on the maintainer's borrowed
authorization.

## Why tests missed it

Every individual check had correct tests: `unauthorized_author` blocked unauthorized
authors, the mention override worked on authorized PRs, the sender substitution had its
own routing tests. The bug lived in the interaction — no test composed
"unauthorized body author + authorized sender + labeled PR + planted mention" until two
independent review personas (correctness, adversarial) constructed the same scenario.

## Solution

Restrict identity-sensitive overrides to actions where the validated association belongs
to the same identity that produced the signal. The mention override is honored only on
`opened`/`synchronize`/`reopened` — actions where `context.author.association` is the PR
author's own (the same identity that wrote the body). `review_requested` keeps its
separate trusted override (`isBotReviewRequested`, derived from the live event, not body
text); `ready_for_review` has no override.

```ts
const isOverridden =
  (context.hasMention === true && context.action !== 'ready_for_review' && context.action !== 'review_requested') ||
  (context.action === 'review_requested' && context.isBotReviewRequested === true)
```

Regression pair pinning both directions: `ready_for_review` with a body mention still
skips; `synchronize` with a body mention still overrides.

## Prevention

- When a routing layer substitutes identity fields (`association`, actor, sender), every
  downstream check keyed on a *different* identity signal (body text, commit metadata,
  anything author-controlled) must state which identity it trusts and verify the
  substitution hasn't changed it.
- Signals derived from author-controlled content (`hasMention` from a PR body) carry the
  *author's* authority — never the event sender's. If the chain validated the sender,
  the author-controlled signal is unvalidated.
- Review personas that construct composition scenarios (attacker plants input in one
  event, victim triggers another) catch what per-check unit tests structurally cannot.

## References

- Fix: PR #1234 (`src/features/triggers/skip-conditions-pr.ts` — override condition + comment)
- Substitution site: `src/features/triggers/router.ts` (sender association overwrite for `review_requested`/`ready_for_review`)
- Signal origin: `src/features/triggers/context-builders-pr-issues.ts` (`hasMention` from PR body)
- Related: [delivery-mode-contract-for-manual-triggers-2026-04-17](../workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md)
