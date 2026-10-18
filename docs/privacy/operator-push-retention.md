# Operator Push Notification: Privacy and Retention Policy

This document describes the data the gateway's operator push notification surface stores, what it puts in a notification payload, how long it keeps records, and how an operator's data can be exported or deleted.

Push notifications are an optional, opt-in convenience for operators using the browser-based control surface. They exist to nudge an operator that a run needs attention (a pending approval, a pending agent question, or a failed run) when they are not already watching the dashboard. They are never the system of record — the dashboard's live status stream and Discord remain the authoritative, detailed channels.

## What is stored

When an operator opts in, the browser creates a [W3C Push API](https://www.w3.org/TR/push-api/) subscription and the gateway persists one record per subscription:

- **Endpoint URL** — the push service URL the browser gave us. Write-only: it is used to send notifications and is never returned by any listing, export, or audit surface.
- **Browser public keys** (`p256dh`, `auth`) — the encryption keys the browser subscription requires. Also write-only, for the same reason.
- **Operator GitHub user ID** — the numeric identity that owns the subscription.
- **Key version** — which VAPID key the subscription was created or refreshed under (see rotation, below).
- **Timestamps** — created, last updated, and (if inactive) deactivated.
- **Active state** and, when inactive, a coarse reason.

**Nothing else is stored.** A subscription record never contains message content, prompt text, repository names, run identifiers, or run output. There is no field for any of that, and no code path writes one in.

## What a notification contains

Every push notification uses fixed, neutral copy: a short message indicating something needs attention, a link that opens the operator dashboard (for a question notification, a same-origin link to the run that is asking, and that run's opaque identifier in the encrypted payload), and — for failures — a label drawn from a small, pre-defined, allowlisted set of failure categories (for example, a timeout or a workspace error). The payload never includes the run's repository, prompt, or any of its output, and a question notification never includes the question or its options; the run identifier is the only run-specific value it carries. An operator who wants details opens the dashboard, authenticates, and sees them there under the normal authorization rules — the push payload itself carries none of it.

## Retention

An active subscription record persists until one of the following happens:

- The operator explicitly unsubscribes (opt-out) from the dashboard.
- The operator logs out, or their session is otherwise revoked — this deactivates every push subscription tied to that operator's GitHub identity, across all of their browsers and devices. A session reaching its 7-day lifetime does not deactivate subscriptions. If a deactivation fails, a gateway restart within 7 days of the logout repairs it: startup finds each user with a revoked session record and no live session, and deactivates that user's subscriptions again. A revoked record is kept and replayed until 7 days after the revoke, so a restart after that window does not repair it. The repair leaves a subscription that was made or refreshed after the restart began. If a revoked record cannot be read at a restart, that restart skips its replay, and a later restart within the window repairs it. Rotating `GATEWAY_OPERATOR_CSRF_SECRET` does not deactivate subscriptions; see the operator runbook for the follow-up step.
- The push relay reports the subscription is dead (the browser/service has discarded it).
- The VAPID key the subscription was signed under is revoked outside a normal rotation window.
- The operator requests deletion (see Deletion, below).

Once a record becomes inactive it is retained for 30 days — enough time for operational troubleshooting and audit correlation — and then purged automatically. Deletion additionally writes a durable tombstone at a separate key from the subscription record itself, so that restoring an older backup of just the subscription object cannot resurrect a record a privacy delete already removed. (A full-bucket restore that rewinds the entire object store, tombstones included, to a point before the delete is a disaster-recovery scenario outside the scope of this application-level protection.)

## Operator session records

Signing in to the operator surface creates a session record in the same object store. This is separate from push data, but the revoke and retention rules above depend on it.

- **What a record holds:** the operator's numeric GitHub user ID, display login, the time of sign-in, a status (`active`, `revoked` or `rotated`), and an integrity signature. It holds no OAuth token and no session identifier.
- **How it is keyed:** by a SHA-256 hash of the session identifier. The hashed key can appear in object-store info logs. It is not a credential: it cannot be turned back into the identifier or used as a cookie.
- **How long it is kept:** a session lasts 7 days. A record is kept until 7 days after sign-in, or 7 days after the revoke for a revoked or rotated record (the revoke time is stored and signed, and is capped at 7 days after sign-in, so a record is never kept longer than 14 days after sign-in), plus one hourly sweep interval. The sweep also deletes malformed records at once, and records that fail their signature once their claimed sign-in time is more than 7 days old.
- **Ending every session:** rotating `GATEWAY_OPERATOR_CSRF_SECRET` and redeploying invalidates every stored record at the next start. The sweep deletes them once their claimed sign-in time is more than 7 days old.

## Export

A privacy export of an operator's push data returns only safe metadata: the record's identifier (a hash, not the endpoint itself), timestamps, key version, active state, and — if inactive — a coarse reason. The export never includes the endpoint URL or the browser's encryption keys; those fields are write-only and structurally excluded from every non-mutating surface.

## Deletion

A privacy delete for an operator marks every one of their active subscription records inactive immediately, removes them from the active dispatch set (so no further notification can be sent to them even before the tombstone write completes), and writes a durable tombstone before the request returns. A privacy delete is not a permanent ban on that endpoint: a legitimate, authenticated re-subscribe from the same browser later is honored normally.

## Audit

The subscription lifecycle is recorded on the same coarse audit trail as the rest of the operator surface (see the [Operator Web Control Surface](../wiki/Operator%20Web%20Control%20Surface.md) wiki page): an operator subscribing, unsubscribing, having a subscription deactivated, and per-broadcast dispatch summaries. Every one of these audit records carries only the operator's GitHub user ID, coarse enum reasons, and counts — never an endpoint, a key, or notification payload content.

## Push health status

The authenticated operator session response may include a coarse `push.status` (`ready`, `degraded`, or `unknown`). It is derived in memory from the outcomes of calls that already happen, is returned only to the authenticated operator, and is never persisted or included in exports or audit events.

## Enablement

Push is disabled by default. Turning it on in a given deployment requires provisioning VAPID key material as server-only configuration and accepting the retention policy described here — there is no way to enable the surface without both.
