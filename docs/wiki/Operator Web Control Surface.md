---
type: subsystem
last-updated: "2026-07-05"
updated-by: "schedule-d7190410-28754466543"
sources:
  - packages/gateway/src/web/server.ts
  - packages/gateway/src/web/operator-route.ts
  - packages/gateway/src/web/operator-route-smoke.ts
  - packages/gateway/src/web/operator/launch-route.ts
  - packages/gateway/src/web/operator/runs-route.ts
  - packages/gateway/src/web/operator/cancel-route.ts
  - packages/gateway/src/web/operator/repos-route.ts
  - packages/gateway/src/web/operator/pending-approvals-route.ts
  - packages/gateway/src/web/operator/decision-route.ts
  - packages/gateway/src/web/operator/web-approval.ts
  - packages/gateway/src/web/operator/web-sinks.ts
  - packages/gateway/src/web/operator/idempotency.ts
  - packages/gateway/src/web/operator/route-helpers.ts
  - packages/gateway/src/web/auth/github.ts
  - packages/gateway/src/web/auth/session.ts
  - packages/gateway/src/web/auth/allowlist.ts
  - packages/gateway/src/web/auth/repo-authz.ts
  - packages/gateway/src/web/auth/csrf.ts
  - packages/gateway/src/web/auth/session-info-route.ts
  - packages/gateway/src/web/sse/manager.ts
  - packages/gateway/src/web/sse/projection.ts
  - packages/gateway/src/web/sse/run-stream-route.ts
  - packages/gateway/src/web/audit.ts
  - packages/gateway/src/web/operator-push/subscription-route.ts
  - packages/gateway/src/web/operator-push/subscription-store.ts
  - packages/gateway/src/web/operator-push/dispatcher.ts
  - packages/gateway/src/web/operator-push/trigger-policy.ts
  - packages/gateway/src/web/operator-push/vapid.ts
  - docs/privacy/operator-push-retention.md
  - packages/gateway/src/operator-contract/identity.ts
  - packages/gateway/src/operator-contract/approval.ts
  - packages/gateway/src/operator-contract/approval-frame.ts
  - packages/gateway/src/operator-contract/output.ts
  - packages/gateway/src/operator-contract/run-status.ts
  - packages/gateway/src/operator-contract/run-summary.ts
  - packages/gateway/src/execute/cancel.ts
  - packages/gateway/src/execute/abort-registry.ts
  - packages/gateway/src/operator-contract/redaction.ts
  - packages/gateway/src/operator-contract/repo-summary.ts
  - packages/gateway/src/operator-contract/version.ts
  - docs/decisions/2026-06-19-s2-operator-auth-authority.md
summary: "Authenticated browser surface that lets operators launch, observe, and approve gateway agent runs over HTTP and SSE"
---

# Operator Web Control Surface

Beyond Discord mentions, the [[Architecture Overview|gateway]] exposes a second way to drive agent runs: an authenticated, browser-facing HTTP surface for human operators. An operator signs in with GitHub, launches a run against a bound repository, and watches its status and output stream back live. This page describes how that surface is structured and why its security posture is built the way it is.

The implementation lives under `packages/gateway/src/web/` (the HTTP server, routes, authentication, and SSE machinery) and `packages/gateway/src/operator-contract/` (the frozen data types the surface speaks). The decision to make the gateway the single authority for operator authentication — rather than maintaining a parallel system in the separate dashboard project — is recorded in `docs/decisions/2026-06-19-s2-operator-auth-authority.md`.

## Listener Topology

The operator server (`web/server.ts`) is a Hono application bound only to the gateway's internal network — never the public internet directly and never the sandbox network the workspace runs on. TLS is terminated upstream by an infrastructure reverse proxy at a configured public origin, so the listener itself receives plain HTTP from that proxy.

Because the server trusts a proxy in front of it, it validates the forwarded host and protocol headers against the expected public origin and rejects mismatches. This stops anything that can reach the listener from spoofing the operator origin. During graceful shutdown a drain gate refuses new requests with `503` before any request body is read, and unauthenticated routes carry small body-size limits and socket-keyed rate limiting (keyed on the TCP peer address rather than a spoofable header).

Routes fall into two classes, enforced by a registration seam (`web/operator-route.ts`):

- **Public** — the health check and the two GitHub OAuth endpoints (start and callback). Registered through dedicated public helpers so they are never wrapped by the privileged guard.
- **Privileged** — everything else: launch, run listing, run-stream, repo listing, the two approval endpoints, session info, CSRF token issuance, and logout. Registered through a helper that automatically wraps each handler in the browser guard (session + allowlist + CSRF/origin checks). A startup assertion fails fast if any `/operator/*` route was registered without going through these helpers, making "forgot to add the guard" unrepresentable.

### Dependency-gated registration

Beyond the public/privileged split, each route is mounted **only when every dependency it needs is present**. The app builder (`web/server.ts`) threads a bag of optional dependencies — the session store, the denylist cache, the binding lookups, the allowlist, the audit logger, the run index, the observation manager, the approval registry, and the launch admission gate — and registers a given route inside an `if` that requires all of its pieces. A repo-listing route, for instance, never mounts unless the session store, denylist cache, binding lister, allowlist, and audit logger are all wired. Partially-wired security dependencies (some browser-guard pieces present, others missing) are treated as a programming error and throw at startup rather than silently degrading.

This pattern trades a subtle risk: a missing dependency drops a route silently, and a dropped route looks like a 404 rather than an error. To close that gap, an offline route-registration smoke check (`web/operator-route-smoke.ts`) pins the complete expected inventory of operator routes and asserts the built app exposes exactly that set. If a dependency is accidentally removed from the wiring, the affected route vanishes from the app and the smoke check fails in CI — at image-build time, before the gateway ever serves traffic.

### The operator route set

The privileged surface currently exposes:

- `POST /operator/runs` — launch a run (see [Launching a Run](#launching-a-run)).
- `GET /operator/runs` — list the operator's authorized runs across all bound repositories.
- `POST /operator/runs/:runId/cancel` — request cancellation of an in-flight run (see [Cancelling a Run](#cancelling-a-run)).
- `GET /operator/runs/:runId/stream` — open the SSE observation stream for one run.
- `GET /operator/runs/:runId/approvals` — list the run's currently-open approval requests.
- `POST /operator/runs/:runId/approvals/:requestId/decision` — settle one approval request.
- `GET /operator/repos` — list the repositories the operator is authorized to launch against.
- `GET /operator/session` and `GET /operator/session/csrf` — current session info and a fresh CSRF token.
- `POST /operator/auth/logout` — end the session.

The unauthenticated set is just the health check and the two OAuth endpoints (`GET /operator/auth/github/start`, `GET /operator/auth/github/callback`).

## Authentication and Authorization

### GitHub OAuth (`web/auth/github.ts`)

Sign-in is a hand-rolled GitHub OAuth flow using PKCE and an anti-forgery `state` value. The start endpoint generates the PKCE verifier server-side (it is never written to a cookie or returned to the browser), stores the `state` server-side with a short TTL and an outstanding-attempt cap, and redirects to GitHub. The callback validates `state` as one-time, exchanges the code with the stored verifier, and reads the authenticated user's stable numeric GitHub ID and display login.

Two properties matter throughout: the **numeric user ID is the authority** for every later authorization and audit decision, while the login is treated as mutable display metadata; and every authentication failure branch returns the same coarse response so the surface gives no oracle about why a request was rejected.

### Sessions (`web/auth/session.ts`)

A successful sign-in mints a server-side opaque session — a high-entropy random identifier stored in a `__Host-`-prefixed secure cookie, with the identity and the operator's GitHub OAuth token held only in memory on the gateway. Sessions enforce both an absolute lifetime (8 hours) and an idle timeout (30 minutes), checked on every lookup. The retained OAuth token is a session-bound secret: it is never written to disk, never logged, never placed in a cookie, and never returned through any API response. Because sessions live in memory, a gateway restart is a global logout.

### Allowlist and repository access (`web/auth/allowlist.ts`, `web/auth/repo-authz.ts`)

Authentication proves who an operator is; authorization decides what they may touch. A file-backed allowlist of stable numeric GitHub user IDs gates the surface, and it fails closed — a missing, unreadable, or malformed allowlist denies everyone. Repository authorization layers a second check on top: the operator must be on the allowlist **and** their OAuth token must prove read access to the specific target repository. The allowlist check runs first so a non-allowlisted operator never triggers a GitHub call. Results are cached briefly (with jitter, and with negative caching for denials and rate-limit windows), and concurrent misses for the same key coalesce into a single GitHub request.

### CSRF and the browser guard (`web/auth/csrf.ts`)

The browser guard validates Fetch Metadata headers and an HMAC-signed CSRF token on mutating requests (`POST`/`PUT`/`PATCH`/`DELETE`); safe methods are exempt. Combined with the same-origin posture from the listener topology, this is what makes the privileged routes safe to expose to a browser.

## Launching a Run

`POST /operator/runs` (`web/operator/launch-route.ts`) is a fire-and-return endpoint: the operator submits a repository and a prompt, and the server responds `202` with a `runId` almost immediately, leaving the operator to observe progress over SSE. Before anything launches, the request passes an ordered gauntlet: the browser guard, an operator-keyed rate limit, OAuth-token resolution from the session, body validation, **server-owned binding resolution** (the client names a repo but the server resolves the actual binding — client-supplied paths or owners are ignored), a denylist check that runs _before_ the authorization call, the repo-authorization check, and finally a per-operator idempotency guard.

The idempotency guard (`web/operator/idempotency.ts`) namespaces its key by the operator's numeric ID (`{githubUserId}:{clientKey}`), so one operator can never suppress another's launch. It uses a two-phase reserve-then-commit lifecycle: the key is reserved before `launchWork` is called and committed only on success, so a concurrent duplicate during the reservation window is recognized as in-flight rather than launching the work twice. On rejection the reservation is rolled back so no dead `runId` is echoed.

Admission itself goes through the gateway's single `launchWork` gate (see [[Execution Lifecycle]] for how that same admission path now records queued and failed runs).

## Listing Runs

`GET /operator/runs` (`web/operator/runs-route.ts`) answers "which runs may I see right now?" without the operator first having to know a `runId`. It enumerates bindings, deduplicates them by `owner/repo` _before_ any authorization call so a repository bound to several channels is only authorized once, caps the authorization fan-out, and projects each surviving run through the `RunSummary` shape (`operator-contract/run-summary.ts`). The listing is bounded — it returns at most a fixed number of summaries — and each summary carries only the run id, the `owner/repo` from the binding (never the internal entity reference), a coarse status, and timestamps. Runs whose stored entity reference disagrees with the binding (a sign of storage corruption or a repository rename) are dropped rather than rendered, so a stale record can never surface another repository's work.

The run index this route reads from is server-owned; the operator never supplies a run-to-repository mapping. See [[Session Persistence]] for how the index scans recent run records by recency from the object store.

## Approving Tool Use

Web-launched runs are no longer approval-free. When OpenCode hits a permission gate mid-run — a shell command, an out-of-tree file write — the same approval registry that backs Discord buttons (`registry.handleDecision` as the single settlement authority) also drives the web surface.

The web approval transport (`web/operator/web-approval.ts`) follows a **register-before-fan-out** discipline: it registers the pending request in the shared registry first, attaches the settle/clear callback, and only then fans an SSE frame out to any watching browsers. If the fan-out throws, the error is logged and swallowed — the registry entry already exists and its deadline still settles fail-closed, so a dropped frame degrades the UI without weakening the gate.

Operators observe and settle approvals two ways. The SSE stream carries **approval frames** (described below), and `GET /operator/runs/:runId/approvals` (`web/operator/pending-approvals-route.ts`) is a reconciliation fallback: a browser that reconnects after a dropped stream can re-fetch the currently-open requests instead of waiting for a replay. Listing approvals needs only read access to the run's repository. Settling one, via `POST /operator/runs/:runId/approvals/:requestId/decision` (`web/operator/decision-route.ts`), demands **write-level** repository authorization — a read-only operator may watch an approval but may not act on it. The decision route resolves the run to its repository through the server-owned run index, re-runs the denylist and write-authorization checks, and hands a transport-bound operator identity to `registry.handleDecision`, which records the `once` / `always` / `reject` outcome as the authoritative settlement.

## Cancelling a Run

An operator can stop a run that is still in flight. `POST /operator/runs/:runId/cancel` (`web/operator/cancel-route.ts`) is a **write-gated** endpoint — unlike observing a run, requesting cancellation demands write-level repository authorization, so a read-only operator may watch a run but may not halt it. The route resolves the run to its repository through the server-owned run index, re-runs the denylist and write-authorization checks, and (deliberately) applies the operator-keyed rate limit only _after_ authorization so an unauthorized caller never consumes budget.

Under the hood, cancellation rides an in-memory abort registry (`execute/abort-registry.ts`). When a run reaches the `EXECUTING` phase, the engine registers a per-run `AbortController` in the registry and composes the run's effective signal as `AbortSignal.any([timeoutSignal, cancelSignal])`; the controller is always removed in the outer `finally` regardless of how the run settles. Registration happens only after the `EXECUTING` transition commits — the earlier window is guarded instead by the run-state conditional-write rendezvous. A cancel request simply fires the registered controller.

Two design choices keep cancellation correct under races. First, classification is a **registry probe**, never composite abort-reason inspection: `AbortSignal.any` propagates whichever child fired first, so reading the reason would be racy, and the registry's own controller state is treated as ground truth (`execute/cancel.ts`). Second, a cancelled run settles as `CANCELLED` rather than `FAILED` — it flushes partial output, notifies the SSE observer, and suppresses the user-facing failure reply. The cancel path stops the heartbeat _first_ because its returned etags are the only fresh conditional-write handles; using a stale etag on the subsequent transition would `412` silently and TTL-orphan the coordination lock rather than fail loudly. When an operator cancel wins an adoption race, the losing run re-reads run-state, sees a `CANCELLED` phase, and exits cleanly instead of logging a misleading error. The `CANCELLED` phase is one of three [[Execution Lifecycle|terminal phases]] the coordination layer now names explicitly through a shared `TerminalPhase` type.

## Observing a Run

`GET /operator/runs/:runId/stream` (`web/sse/run-stream-route.ts`) opens a Server-Sent Events stream. The route resolves the run to its repository through a server-owned run index (never a client-supplied mapping), re-runs the denylist and repository-authorization checks, and acquires a per-operator stream-slot lease (a small cap on concurrent streams per operator). Every failure on the authorization path returns the identical generic not-found shape; exhausting the stream-slot cap returns an honest `429`. There is deliberately no distinguishable "authorized but not streaming" response, because that would leak whether a run exists.

Once open, the stream emits a closed set of frame types: a **status** frame carrying the operator-safe run projection, **output** frames (incremental deltas plus a final terminal frame that supersedes them), **approval** frames for the tool-approval flow, periodic **heartbeat** comments to keep proxies from closing the connection, and a **reset** frame with a typed reason on terminal status, shutdown, or overflow. A continuous authorization lease re-verifies the session, token, redaction, and repo access on an interval; if any check fails the stream closes gracefully.

An approval frame comes in two shapes (`operator-contract/approval-frame.ts`): an **open** frame carries the request id, the permission kind, and — when relevant — a length-bounded, control-character-stripped command or filepath, so the browser can render the prompt; a **settle** frame carries only the request id, telling the browser to dismiss a prompt that has been answered (by this operator, another operator, or the registry deadline). Unlike output deltas, approval frames are never coalesced — they are rare and must arrive intact.

Fan-out is handled by an in-memory observation manager (`web/sse/manager.ts`). The run engine calls into the manager on every state transition; the manager projects the run state through the redaction bridge, caches the latest status, and enqueues frames per subscriber without ever awaiting a write — a slow consumer is dropped locally once its queue exceeds a byte cap, and cannot stall publishing for anyone else. A bounded terminal-replay cache lets a late subscriber connecting shortly after completion still receive the final output and status before the stream closes. The manager is observer-only: it can read and project run state but has no API to transition runs or touch coordination locks.

## The Operator Contract

The types crossing this boundary are defined once, in `packages/gateway/src/operator-contract/`, and treated as a frozen surface. The contract version (`version.ts`, currently `1.6.0`) is pinned at build time and never negotiated over the wire — clients cannot ask for an older shape. The version follows a deliberate increment policy: a major bump for any breaking change (a removed, renamed, or narrowed field), a minor bump for additive changes (a new optional field or a new type such as the `RunSummary` and approval-frame shapes), and a patch bump for documentation only. The version is also emitted (emit-only, never read from the wire) on the public health-check body, so operators can probe the deployed contract version without authenticating; note that adding that health field was treated as non-structural and did _not_ itself bump the contract version, because the dashboard enforces a fail-closed drift gate on the SSE ready-frame version. Two normative obligations are encoded directly in the contract (`redaction.ts`):

- **Redaction obligation** — denylisted repositories must be excluded _before_ any per-repo query, not filtered at render time. Deny-key matching tolerates GitHub node-ID format skew by deriving the numeric database ID, and an entry with no usable deny key (or an unreadable denylist) must deny rather than leak. Redaction composes with repository authorization: authorization proves an operator _may_ see a repo, redaction proves the repo _is not hidden by policy_, and both must pass.
- **Authorization obligation** — operator identity is always constructed server-side from the authenticated session and is never deserialized from a request payload, and approval/launch decisions must carry a transport-bound identity rather than a free-form caller string.

The projection helper (`sse/projection.ts`) enforces redaction structurally: it takes a denylist predicate as a required argument and returns nothing for a denied repository, so the operator-facing `OperatorRunStatus` (`run-status.ts`) exposes only safe fields (entity reference, surface, phase, status, timestamps, staleness) and never the internal coordination fields like holder or thread IDs. The phase-to-status mapping is part of the pure projection; the richer "blocked" and "waiting for approval" states an operator sees are overlays the route layer derives from queue and approval-registry state rather than fields the projection itself produces.

The run-listing surface uses a deliberately leaner shape, `RunSummary` (`run-summary.ts`), which carries the `owner/repo` resolved from the binding rather than the internal entity reference. Both projections are pure and total: each returns nothing — rather than a partially-redacted record — whenever a repository is denylisted or a run's stored identity contradicts its binding, so callers skip the null and never render leaked or inconsistent data.

When a run fails, both projections may carry a `failureKind` — a coarse, sanitized reason drawn from a small closed vocabulary (`OperatorFailureKind` in `run-status.ts`): the two timeout variants (`inactivity-timeout`, `max-duration-timeout`), `stream-ended`, `workspace-unreachable`, `session-error`, and an `unknown` fallback. The mapping from the engine's richer internal error kinds is an explicit allowlist, so any unrecognized or unmapped internal kind collapses to `unknown` rather than leaking implementation detail. A pre-acknowledgement startup failure surfaces as `workspace-unreachable`. The kind is persisted on the `FAILED` run-state transition and projected onto the operator surface, giving operators a stable, non-sensitive signal about _why_ a run ended without exposing stack traces or internal vocabulary.

## Audit

Security-critical events on this surface — sign-ins, authorization decisions, launches, and stream lifecycle — flow through a typed audit seam (`web/audit.ts`) that records the numeric GitHub user ID and other safe fields while excluding tokens, prompts, and internal identifiers. The push subscription lifecycle (subscribe, unsubscribe, deactivation, dispatch, and startup disablement — see [Operator Push Notifications](#operator-push-notifications) below) is folded into the same seam, holding to the same rule: only operator identity, coarse enums, and counts, never endpoints or key material.

## Operator Push Notifications

Alongside the SSE stream, operators can opt into browser push notifications for two events: a run entering `waiting for approval` and a run failing. Push is **opt-in and disabled by default** — a deployment must both provision VAPID key material and start the object-store CAS self-test successfully before the surface is registered at all (`program.ts`; see the [privacy and retention policy](../privacy/operator-push-retention.md) for what is stored and how it is deleted).

The surface exposes four authenticated operator routes (`web/operator-push/`):

- `GET /operator/push/vapid-key` — the current VAPID public key and key version, used by the browser to create a `PushSubscription`.
- `POST /operator/push/subscriptions` — register (or refresh) a subscription for the authenticated operator.
- `POST /operator/push/subscriptions/unsubscribe` — remove a subscription.
- `GET /operator/push/subscriptions` — list the operator's own subscription metadata (never the endpoint or keys — see `toSubscriptionMetadata` in `subscription-store.ts`).

**Broadcast model.** The operator dashboard is a shared surface, not a per-operator one — approvals are run-scoped, not operator-scoped, and there is no dashboard-operator identity available at the run-failed or approval-pending seams. Every opted-in operator with an active subscription is nudged, regardless of who launched the run. The notification payload is fixed and repo-neutral ("something needs attention, open the dashboard" plus an allowlisted failure label) so a broadcast never leaks run, repo, or prompt content — Discord and the SSE stream remain the authoritative, detailed channels; push is a fail-soft nudge on top.

### VAPID key rotation and leak response

The VAPID private key is server-only, per-environment configuration — never logged, serialized, or returned by any route. Rotation supports a current key plus an optional previous key during a rollout window: each subscription record stores the key version it was created or refreshed under, and the dispatcher's trigger policy still delivers to previous-key records for the duration of the window (`web/operator-push/trigger-policy.ts`). Once the window closes, previous-key subscribers stop being notified until they re-subscribe under the new public key (their next browser-side subscribe call picks up the current key automatically).

If the private key leaks, the response is: provision a fresh VAPID keypair, roll the current key into the previous-key slot for a bounded rollout window, then retire the old key entirely once the window ends. There is no way to invalidate an individual leaked key server-side beyond this rotation — the protection comes from bounding how long the compromised key remains honored, not from revoking specific subscriptions.

## Relationship to Other Surfaces

This surface is one of three ways runs reach the gateway's execution engine, alongside Discord mentions and the GitHub Action. All three converge on the same `launchWork` admission gate and the same approval registry (`registry.handleDecision`) as the single settlement authority — which is exactly why the web tool-approval flow could be added without a parallel approval path: the browser is just another front-end onto the one registry the Discord buttons already drive. The conventions enforced here (functions only, dependency injection, fail-closed defaults, no secret leakage) match the rest of the project; see [[Conventions and Patterns]]. For the per-repo coordination lock these runs share with the Action, see [[Execution Lifecycle]].
