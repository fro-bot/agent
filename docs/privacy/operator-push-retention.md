# Operator Push Notification: Privacy and Retention Policy

This document describes the data the gateway's operator push notification surface stores, what it puts in a notification payload, how long it keeps records, and how an operator's data can be exported or deleted.

Push notifications are an optional, opt-in convenience for operators using the browser-based control surface. They exist to nudge an operator that a run needs attention (a pending approval or a failed run) when they are not already watching the dashboard. They are never the system of record — the dashboard's live status stream and Discord remain the authoritative, detailed channels.

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

Every push notification uses fixed, neutral copy: a short message indicating something needs attention, a link that opens the operator dashboard, and — for failures — a label drawn from a small, pre-defined, allowlisted set of failure categories (for example, a timeout or a workspace error). The payload never includes the run's repository, prompt, or any of its output. An operator who wants details opens the dashboard, authenticates, and sees them there under the normal authorization rules — the push payload itself carries none of it.

## Retention

An active subscription record persists until one of the following happens:

- The operator explicitly unsubscribes (opt-out) from the dashboard.
- The operator's session is revoked — logging out (or a session expiring) deactivates every push subscription tied to that operator's GitHub identity, across all of their browsers and devices.
- The push relay reports the subscription is dead (the browser/service has discarded it).
- The VAPID key the subscription was signed under is revoked outside a normal rotation window.
- The operator requests deletion (see Deletion, below).

Once a record becomes inactive it is retained for 30 days — enough time for operational troubleshooting and audit correlation — and then purged automatically. Deletion additionally writes a durable tombstone at a separate key from the subscription record itself, so that restoring an older backup of just the subscription object cannot resurrect a record a privacy delete already removed. (A full-bucket restore that rewinds the entire object store, tombstones included, to a point before the delete is a disaster-recovery scenario outside the scope of this application-level protection.)

## Export

A privacy export of an operator's push data returns only safe metadata: the record's identifier (a hash, not the endpoint itself), timestamps, key version, active state, and — if inactive — a coarse reason. The export never includes the endpoint URL or the browser's encryption keys; those fields are write-only and structurally excluded from every non-mutating surface.

## Deletion

A privacy delete for an operator marks every one of their active subscription records inactive immediately, removes them from the active dispatch set (so no further notification can be sent to them even before the tombstone write completes), and writes a durable tombstone before the request returns. A privacy delete is not a permanent ban on that endpoint: a legitimate, authenticated re-subscribe from the same browser later is honored normally.

## Audit

The subscription lifecycle is recorded on the same coarse audit trail as the rest of the operator surface (see the [Operator Web Control Surface](../wiki/Operator%20Web%20Control%20Surface.md) wiki page): an operator subscribing, unsubscribing, having a subscription deactivated, and per-broadcast dispatch summaries. Every one of these audit records carries only the operator's GitHub user ID, coarse enum reasons, and counts — never an endpoint, a key, or notification payload content.

## Enablement

Push is disabled by default. Turning it on in a given deployment requires provisioning VAPID key material as server-only configuration and accepting the retention policy described here — there is no way to enable the surface without both.
