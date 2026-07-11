---
title: 'Broadcast repo-neutral notifications to all subscribers when no per-request identity exists at the event seam'
date: 2026-07-10
category: best-practices
module: packages/gateway
problem_type: architecture_pattern
component: assistant
severity: low
applies_when:
  - 'A background notification (push, email) fires from an event seam that carries no per-recipient identity'
  - 'The notification payload is repo-neutral / content-free (a nudge, not the data itself)'
  - 'Plumbing recipient identity through shared state would mis-scope or overcomplicate the design'
tags:
  - broadcast
  - shared-console
  - operator-notifications
  - identity-seam
  - web-push
  - notification-targeting
---

# Broadcast repo-neutral notifications to all subscribers when no per-request identity exists at the event seam

## Context

Wiring Web Push dispatch into gateway event sources (pending-approval, failed-run) required an `operatorId` to target the notification, but the event seams carry none: run-state has no dashboard-operator field, approvals are run-scoped rather than launcher-scoped, Discord-triggered runs carry only a Discord user id (not a dashboard operator identity), and the web-launch operator identity that does exist on the launch request is never persisted forward to run-state.

## Guidance

When the recipient identity is genuinely absent at the event seam **and** the notification payload is repo-neutral, broadcast to all active subscriptions rather than plumbing identity through shared state to make targeting possible. The operator dashboard here is a shared console — any authorized operator can act on any run's approval — so "notify the launcher specifically" doesn't even match the interaction model; any operator is a valid recipient.

Broadcasting is safe specifically because the payload carries only a neutral nudge ("something needs attention, open the dashboard") plus a coarse allowlisted label, and never run/repo/prompt content. A broadcast leaks no content — only a timing signal that *some* event happened, which is an accepted tradeoff for a shared console of trusted operators.

## Why This Matters

The reflexive move when a notification needs a recipient and none is available is to persist operator identity onto run-state so the seam can carry it. That is unbudgeted, cross-cutting plumbing, and for a shared console it also mis-models the actual authorization: any operator can act on any run, so "the launcher" isn't even the right recipient concept. Choosing broadcast avoided a cross-cutting state change and matched the real authorization model instead of working around it.

The payload is the guard: broadcast is only acceptable when the payload is genuinely content-free. If a notification ever needs to carry recipient-specific or sensitive content, this pattern does not apply.

## When to Apply

- Repo-neutral background nudges (push/email) fired from identity-less seams on a shared, multi-operator surface where any authorized operator is a valid recipient.
- Do **not** broadcast if the payload carries recipient-specific or sensitive content (run details, repo names, prompt text) — scope it, and the identity plumbing becomes worth the cost.

## Examples

The gateway push dispatcher (`packages/gateway/src/web/operator-push/dispatcher.ts`) lists all active subscriptions and sends the same neutral payload to each one on a trigger; dead subscriptions are reaped per-record on send failure, but the trigger itself fans out to every subscriber rather than resolving a single recipient.

## Related

- [Authenticated SSE run observation](authenticated-sse-run-observation-2026-06-20.md) — operator pub/sub fanout pattern this broadcast approach parallels.
- [Gateway control surface spine](gateway-control-surface-spine-2026-06-15.md) — transport-neutral operator seams that this notification path plugs into.
