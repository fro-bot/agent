---
title: A credential-gated action's eligible surface is the intersection of credential-withheld events and resource-bearing events
date: 2026-07-30
category: best-practices
module: runtime-response-delivery
problem_type: best_practice
component: authentication
severity: medium
applies_when:
  - Deciding which trigger events a credential-sensitive capability may run on
  - A capability needs both a credential posture and a specific resource (e.g. a PR head)
  - Trigger and credential behavior are defined in separate files
tags:
  - github-events
  - credential-scope
  - eligible-surface
  - issue-comment
  - pull-request
  - response-delivery
---

# A credential-gated action's eligible surface is the intersection of credential-withheld events and resource-bearing events

## Context

Brokered push exists to help the _credential-withheld_ mention path: on those triggers the model has no push credential, so a trusted maintainer's fix can't be delivered. The tempting framing was "it applies to PR-ish events — `pull_request` / `issue_comment` / `issues`." That framing is wrong on two independent axes, and each has to be checked against source, not assumed.

## Guidance

Derive the eligible surface as the **intersection of two source-verified sets**:

1. **Events where the capability's precondition holds** — here, events that _withhold_ the credential. That is decided by `classifyEvent` in `packages/runtime/src/agent/response-delivery.ts`, which returns `affected` (credential withheld) only for `pull_request` / `issue_comment` / `issues`.
2. **Events that actually carry the needed resource** — here, events that expose a _PR head branch_ to push to.

Only the overlap qualifies. Working it through:

- `issues` withholds the credential but has **no PR head** → out.
- `pull_request` would withhold the credential but is **not subscribed** by the workflow at all (`.github/workflows/fro-bot.yaml`) → moot.
- `pull_request_review_comment` is PR-bound but is **not credential-withheld** (`classifyEvent` → not `affected`), so it already pushes via its provisioned credential → not stranded, out of scope.
- `issue_comment` where `issue.pull_request != null` is **both** credential-withheld **and** PR-bound → the one eligible surface.

## Why This Matters

Getting the surface wrong in either direction is a bug: too broad authorizes a privileged write where the precondition doesn't hold (e.g. treating `pull_request_review_comment` as needing brokering when it already has a credential); too narrow silently drops the case the feature exists for. Because the two facts live in _different files_ (event classification in the runtime, subscribed triggers in the workflow YAML), assuming either one from the feature's name — instead of reading both — is how the surface silently drifts from reality.

## When to Apply

- Any capability gated on a credential _posture_ that also needs a specific event-carried resource.
- Any time the trigger list and the credential/permission logic are defined in separate files — verify both, intersect, don't infer from the feature name.
- Whenever a design says "applies to PR events": pin down _which_ PR events, on _which_ axis, against source.

## Examples

**Wrong** — infer the surface from the feature's intent:

> "It's a PR fix-delivery feature, so it applies to `pull_request` / `issue_comment` / `issues`."

`issues` has no PR head; `pull_request` isn't even subscribed; this over-claims two events and says nothing about `pull_request_review_comment`.

**Right** — intersect two source-verified sets:

```
credential-withheld (classifyEvent === 'affected'): pull_request, issue_comment, issues
resource-bearing (has a PR head branch):            pull_request, issue_comment-on-PR, pull_request_review_comment
subscribed (workflow YAML):                         issue_comment, pull_request_review_comment, discussion_comment, issues, …
∩  →  issue_comment where issue.pull_request != null
```

## Related

- [Treat a model-authored response file as untrusted input and bind posting to the trusted event context](response-file-is-untrusted-input-2026-07-11.md) — the companion rule for _where_ a credential-withheld run may post; this doc is the rule for _which events_ the credential-gated capability runs on.
- [A fork/self PR review guard must refuse APPROVE only](../workflow-issues/fork-review-guard-gates-approve-only-2026-07-11.md) — another case of gating a privileged event precisely rather than broadly.
- Established while shipping brokered push for trusted mention runs (#1297 / PR #1304).
