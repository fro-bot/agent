---
type: subsystem
last-updated: "2026-06-21"
updated-by: "aaaf91d"
sources:
  - packages/gateway/src/web/server.ts
  - packages/gateway/src/web/operator-route.ts
  - packages/gateway/src/web/operator/launch-route.ts
  - packages/gateway/src/web/operator/repos-route.ts
  - packages/gateway/src/web/operator/web-approval.ts
  - packages/gateway/src/web/operator/web-sinks.ts
  - packages/gateway/src/web/operator/idempotency.ts
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
  - packages/gateway/src/operator-contract/identity.ts
  - packages/gateway/src/operator-contract/approval.ts
  - packages/gateway/src/operator-contract/output.ts
  - packages/gateway/src/operator-contract/run-status.ts
  - packages/gateway/src/operator-contract/redaction.ts
  - packages/gateway/src/operator-contract/repo-summary.ts
  - packages/gateway/src/operator-contract/version.ts
  - docs/decisions/2026-06-19-s2-operator-auth-authority.md
summary: "Authenticated browser surface that lets operators launch and observe gateway agent runs over HTTP and SSE"
---

# Operator Web Control Surface

Beyond Discord mentions, the [[Architecture Overview|gateway]] exposes a second way to drive agent runs: an authenticated, browser-facing HTTP surface for human operators. An operator signs in with GitHub, launches a run against a bound repository, and watches its status and output stream back live. This page describes how that surface is structured and why its security posture is built the way it is.

The implementation lives under `packages/gateway/src/web/` (the HTTP server, routes, authentication, and SSE machinery) and `packages/gateway/src/operator-contract/` (the frozen data types the surface speaks). The decision to make the gateway the single authority for operator authentication — rather than maintaining a parallel system in the separate dashboard project — is recorded in `docs/decisions/2026-06-19-s2-operator-auth-authority.md`.

## Listener Topology

The operator server (`web/server.ts`) is a Hono application bound only to the gateway's internal network — never the public internet directly and never the sandbox network the workspace runs on. TLS is terminated upstream by an infrastructure reverse proxy at a configured public origin, so the listener itself receives plain HTTP from that proxy.

Because the server trusts a proxy in front of it, it validates the forwarded host and protocol headers against the expected public origin and rejects mismatches. This stops anything that can reach the listener from spoofing the operator origin. During graceful shutdown a drain gate refuses new requests with `503` before any request body is read, and unauthenticated routes carry small body-size limits and socket-keyed rate limiting (keyed on the TCP peer address rather than a spoofable header).

Routes fall into two classes, enforced by a registration seam (`web/operator-route.ts`):

- **Public** — health check and the two GitHub OAuth endpoints (start and callback). Registered through dedicated public helpers so they are never wrapped by the privileged guard.
- **Privileged** — launch, run-stream, repo listing, session info, and logout. Registered through a helper that automatically wraps each handler in the browser guard (session + allowlist + CSRF/origin checks). A startup assertion fails fast if any `/operator/*` route was registered without going through these helpers, making "forgot to add the guard" unrepresentable.

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

Admission itself goes through the gateway's single `launchWork` gate (see [[Execution Lifecycle]] for how that same admission path now records queued and failed runs). The web transport deliberately runs without interactive approvals: its approval sink (`web/operator/web-approval.ts`) auto-denies every permission request, so web-launched runs only perform work that needs no human gate.

## Observing a Run

`GET /operator/runs/:runId/stream` (`web/sse/run-stream-route.ts`) opens a Server-Sent Events stream. The route resolves the run to its repository through a server-owned run index (never a client-supplied mapping), re-runs the denylist and repository-authorization checks, and acquires a per-operator stream-slot lease (a small cap on concurrent streams per operator). Every failure on the authorization path returns the identical generic not-found shape; exhausting the stream-slot cap returns an honest `429`. There is deliberately no distinguishable "authorized but not streaming" response, because that would leak whether a run exists.

Once open, the stream emits a closed set of frame types: a **status** frame carrying the operator-safe run projection, **output** frames (incremental deltas plus a final terminal frame that supersedes them), periodic **heartbeat** comments to keep proxies from closing the connection, and a **reset** frame with a typed reason on terminal status, shutdown, or overflow. A continuous authorization lease re-verifies the session, token, redaction, and repo access on an interval; if any check fails the stream closes gracefully.

Fan-out is handled by an in-memory observation manager (`web/sse/manager.ts`). The run engine calls into the manager on every state transition; the manager projects the run state through the redaction bridge, caches the latest status, and enqueues frames per subscriber without ever awaiting a write — a slow consumer is dropped locally once its queue exceeds a byte cap, and cannot stall publishing for anyone else. A bounded terminal-replay cache lets a late subscriber connecting shortly after completion still receive the final output and status before the stream closes. The manager is observer-only: it can read and project run state but has no API to transition runs or touch coordination locks.

## The Operator Contract

The types crossing this boundary are defined once, in `packages/gateway/src/operator-contract/`, and treated as a frozen surface. The contract version (`version.ts`) is pinned at build time and never negotiated over the wire — clients cannot ask for an older shape. Two normative obligations are encoded directly in the contract (`redaction.ts`):

- **Redaction obligation** — denylisted repositories must be excluded _before_ any per-repo query, not filtered at render time. Deny-key matching tolerates GitHub node-ID format skew by deriving the numeric database ID, and an entry with no usable deny key (or an unreadable denylist) must deny rather than leak. Redaction composes with repository authorization: authorization proves an operator _may_ see a repo, redaction proves the repo _is not hidden by policy_, and both must pass.
- **Authorization obligation** — operator identity is always constructed server-side from the authenticated session and is never deserialized from a request payload, and approval/launch decisions must carry a transport-bound identity rather than a free-form caller string.

The projection helper (`sse/projection.ts`) enforces redaction structurally: it takes a denylist predicate as a required argument and returns nothing for a denied repository, so the operator-facing `OperatorRunStatus` (`run-status.ts`) exposes only safe fields (entity reference, surface, phase, status, timestamps, staleness) and never the internal coordination fields like holder or thread IDs.

## Audit

Security-critical events on this surface — sign-ins, authorization decisions, launches, and stream lifecycle — flow through a typed audit seam (`web/audit.ts`) that records the numeric GitHub user ID and other safe fields while excluding tokens, prompts, and internal identifiers.

## Relationship to Other Surfaces

This surface is one of three ways runs reach the gateway's execution engine, alongside Discord mentions and the GitHub Action. All three converge on the same `launchWork` admission gate and the same approval registry (`registry.handleDecision`) as the single settlement authority, which is why no transport — web included — implements a parallel launch or approval path. The conventions enforced here (functions only, dependency injection, fail-closed defaults, no secret leakage) match the rest of the project; see [[Conventions and Patterns]]. For the per-repo coordination lock these runs share with the Action, see [[Execution Lifecycle]].
