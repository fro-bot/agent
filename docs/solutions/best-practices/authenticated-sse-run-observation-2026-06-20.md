---
title: 'Authenticated SSE run-observation: no-oracle gating, redaction-before-authz, fail-closed teardown'
date: 2026-06-20
category: best-practices
module: gateway
problem_type: best_practice
component: authentication
severity: high
applies_when:
  - Adding an authenticated long-lived streaming surface (SSE or WebSocket) that must not leak existence via differential responses
  - Introducing a pub/sub manager that must be observer-only by construction (no mutating API in its dependency closure)
  - Designing a redaction-before-authz boundary for an operator-facing surface
  - Implementing fail-closed idempotent teardown for a streaming connection with a bounded lifetime
  - Adding continuous re-authorization (a lease) to a long-lived connection
tags:
  - sse
  - streaming
  - authentication
  - authz
  - redaction
  - no-oracle
  - fail-closed
  - pub-sub
---

# Authenticated SSE run-observation: no-oracle gating, redaction-before-authz, fail-closed teardown

## Context

The gateway's operator web surface needed a way for an authenticated, allowlisted operator to watch a run's status live in the browser. It shipped as an inert SSE core plus an authenticated route (`packages/gateway/src/web/sse/`): a projection of internal run-state into an operator-safe status, a bounded non-blocking pub/sub manager, and `GET /operator/runs/:runId/stream`.

The hard rule for the whole surface: **the stream itself is the only success signal.** Everything else must fail closed, stay indistinguishable from every other denial, and never leak run existence, authorization state, or redaction state. Several of the patterns below were caught by review before they shipped wrong — an unprimed denylist cache that silently kills the pipeline, a teardown path that leaks a stream slot on an unexpected throw, a gate throw that becomes a distinguishable `500`. They are written down so the next streaming surface gets them for free.

This is the first transport built on the transport-neutral execution/approval seam documented in [gateway-control-surface-spine](gateway-control-surface-spine-2026-06-15.md); it instantiates the **server-owned identity** discipline from [centralize-s3-key-identity-construction](centralize-s3-key-identity-construction-2026-06-09.md) and the **no-oracle** discipline from [signed-webhook-ingress-hardening](signed-webhook-ingress-hardening-2026-05-29.md) for a streaming surface.

## Guidance

### 1. No-oracle for streaming auth

Success is observable **only** as the `text/event-stream` response. Every denial — missing token, unknown run, malformed repo, denylisted repo, unauthorized — returns the identical generic `404`. Critically, a gate that **throws** must degrade to the same `404`, because an unhandled throw becomes a `500` that is distinguishable from the `404` and re-opens the oracle.

```ts
try {
  const resolvedToken = deps.sessionStore.getOperatorToken(sessionId, nowMs)
  if (resolvedToken === undefined) return notFoundResponse(c)

  runId = c.req.param('runId') ?? ''
  const location = await deps.runIndex.lookup(runId)
  if (location === undefined) return notFoundResponse(c)
  // ... split owner/repo, redaction, authz — each failure returns notFoundResponse(c)
} catch (error: unknown) {
  // re-read the param: runId may be unassigned if the throw was before gate 3
  deps.logger.warn({runId: c.req.param('runId') ?? '', githubUserId, error}, 'run-stream: gate threw — denying')
  return notFoundResponse(c)
}
```

This prevents *content-* and *ACL-based* oracles (different response shapes by failure cause). A residual **timing** oracle remains — a synchronous token-miss returns in microseconds while an async authz-denied returns after a GitHub round-trip — which is accepted here for status-only data. A higher-sensitivity surface copying this rule should add jitter or constant-time response shaping; do not cargo-cult "identical 404" onto sensitive data without closing the timing vector.

This is the SSE analogue of the HTTP "identical 401 for every auth failure" rule in [signed-webhook-ingress-hardening](signed-webhook-ingress-hardening-2026-05-29.md). The failure surfaces differ (HTTP `401` vs SSE `stream-vs-404`) but the oracle-prevention discipline is the same.

### 2. Redaction before authz

Resolve deny-keys and check the denylist **before** any GitHub/token-backed authz call, so a denylisted repo never triggers a GitHub request or uses the operator's token.

```ts
const denyKeys = await resolveBindingDenyKeys(owner, repo, deps.bindingsLookup)
await deps.denylistCache.getDenylistState()
if (deps.denylistCache.isRepoDenied(denyKeys) === true) return notFoundResponse(c)

const authzResult = await checkRepoAuthz(githubUserId, owner, repo, token, deps.repoAuthzDeps)
```

### 3. Server-owned `runId → repo` resolution

The `runId` comes from the client; the repo identity must come from the server-owned run index, never from a client-supplied owner/repo. Strip any `#fragment` defensively before splitting, so a future `entity_ref` format with a suffix can't bleed into the repo name.

```ts
const location = await deps.runIndex.lookup(runId) // server-owned
if (location === undefined) return notFoundResponse(c)
const repoPath = location.repo.split('#')[0] ?? location.repo
```

This is the same rule as [centralize-s3-key-identity-construction](centralize-s3-key-identity-construction-2026-06-09.md) ("server owns the identity"), applied to a different surface.

### 4. Prime the denylist cache at startup, then refresh on a timer

`isRepoDenied()` is fail-closed: an **unprimed** cache denies everything, which silently turns the whole observation pipeline dark. Prime it once at startup (fail-soft — a prime failure logs and leaves the cache deny-all until the next refresh, it does not crash boot), refresh it on the TTL cadence, and clear the interval on shutdown.

```ts
await denylistCache.getDenylistState() // prime (wrapped fail-soft at boot)
const denylistRefreshInterval = setInterval(() => {
  denylistCache.getDenylistState().catch((error: unknown) =>
    logger.warn({err: String(error)}, 'denylist: background refresh failed'),
  )
}, DENYLIST_TTL_MS)
// shutdown: clearInterval(denylistRefreshInterval)
```

Review caught this one: the wiring created the cache but never primed it, so the first (and every) projection returned `null` and the surface was dead despite green tests. Tests that mock the denylist never exercise the prime, so this needs an explicit startup-prime + a test that an unprimed cache fails closed.

### 5. Closed-DTO safe-field projection

Project internal run-state into the operator DTO by copying **only** the allowed fields — never spread the run-state object. If the repo is denied/keyless, return `null` so the manager drops it **before** caching or emitting.

```ts
const base = await bridgeFn(runState, deps)
if (base === null) return null // denied → dropped before cache/emit
// overlay is guarded so it can only override a non-terminal status
const status =
  base.status === 'running' && deps.hasPendingForScope(scopeId) === true
    ? 'waiting_for_approval'
    : base.status
const result: OperatorRunStatus = {
  runId: base.runId, entityRef: base.entityRef, surface: base.surface,
  phase: base.phase, status, startedAt: base.startedAt, stale: base.stale,
}
```

A status overlay (e.g. `waiting_for_approval`) must be guarded so it can only override a non-terminal status — never mask a `COMPLETED`/`FAILED` run.

### 6. Non-blocking pub/sub with a bounded per-subscriber drop

The publisher must **never** await a subscriber write. A slow consumer is dropped locally at a byte cap without stalling the publish path or any peer. The manager's dependency closure carries **no mutating run API** — it is observer-only *by construction*, so it structurally cannot affect run lifecycle.

```ts
if (sub.queueBytes + frameBytes > subscriberQueueCapBytes) {
  dropSubscriber(sub, 'overflow')
  return
}
sub.queue.push(frame)
if (sub.writerRunning === false) {
  sub.writerRunning = true
  drainQueue(sub).catch(() => {}) // fire-and-forget; never awaited by observe()
}
```

### 7. Fail-closed idempotent SSE teardown

Cleanup runs exactly once (a `cleaned` guard), is safe under a **synchronous** `onClose` during subscribe (declare `unsubscribe` as optional to avoid a temporal-dead-zone reference), releases the per-operator stream slot on **any** exit path (a `finally` safety net, not only the happy path), and restores the socket timeout best-effort (wrapped, so a destroyed socket can't skip the slot release). A **route-owned** max-duration timer bounds the connection independently of the manager's own max-duration as defense-in-depth.

```ts
let unsubscribe: (() => void) | undefined   // optional → no TDZ on synchronous onClose
const cleanup = (reason: string): void => {
  if (cleaned === true) return
  cleaned = true
  clearIntervalFn(leaseTimer)
  clearTimeoutFn(maxDurationTimer)
  unsubscribe?.()
  releaseSlot()                              // released before the throwable socket restore
  try { restoreSocketTimeout(socket, priorSocketTimeout) } catch { /* destroyed socket */ }
}
// plus: finally { releaseSlot() }  — releases the slot even if an unexpected throw bypassed cleanup
```

This shares the dual-finally resource-release discipline of [atomic-serial-channel-queue-handoff](atomic-serial-channel-queue-handoff-2026-06-09.md).

### 8. Continuous-authz lease

Re-verify session, token, denylist, and repo authz on an interval. After **every** `await`, re-check a generation guard (`isCleaned()`) so a check that resolves *after* the connection tore down is a no-op. Clear the lease timer before unsubscribing. The revocation window is bounded by the authz cache TTL (~5m + jitter) plus the lease interval (~5.5m worst case) and is **documented and accepted** because the streamed data is status-only.

```ts
const freshToken = deps.sessionStore.getOperatorToken(sessionId, nowMs)
if (isCleaned() === true) return        // a generation guard follows EVERY await
if (freshToken === undefined) { onFail(); return }

const authzResult = await checkRepoAuthz(githubUserId, owner, repo, freshToken, deps.repoAuthzDeps)
if (isCleaned() === true) return        // late resolution after teardown → no-op
if (authzResult.authorized === false) { onFail(); return }
```

> ⚠️ The ~6-minute revocation window (the ~5.5m positive-authz cache TTL plus the 30s lease interval) is accepted **only because the streamed data is status-only** (run phase/status/timestamps). A surface streaming sensitive data — logs, file contents, secrets — must NOT reuse this window: it needs a cache-bypass re-check, a zero-TTL authz cache, or a much shorter lease interval.

> **Update (#965 — `output` frame):** the stream now also carries an `output` frame with the agent's conversational text. This reuses the same lease window, accepted because the text is the *sink-routed visible output* (reasoning suppressed, tools summarized) the operator could already see in the Discord thread — it is operator-safe by the repo-authz boundary the stream already enforces, not by field-closure. **Foot-gun:** if a future change streams raw file contents, command output, or secrets through this frame, it must tighten the lease per the warning above — the current window is only acceptable for the existing sink-routed visible text.

The lease is **fail-closed**: an unexpected throw inside the lease tick closes the stream (`onFail`), it does not silently leave the connection open. This is the opposite polarity from the fail-*soft* boundaries in [effect-failure-channel-discipline](effect-failure-channel-discipline-2026-06-10.md), but uses the same "one boundary, defect-proof" discipline — here the boundary must deny by default.

### 9. Per-operator stream cap keyed on the numeric user id

Cap concurrent streams by the numeric GitHub user id, **not** the session id — a session key is bypassable by opening multiple sessions. Release the slot **synchronously** so a reconnect storm can't transiently exceed the cap. Over-cap returns a rate-limited response, reached only *after* authorization passes (so it is not a run-existence oracle).

```ts
if ((activeStreams.get(githubUserId) ?? 0) >= maxStreams) return rateLimitedResponse(c)
activeStreams.set(githubUserId, (activeStreams.get(githubUserId) ?? 0) + 1)
```

### 10. Contract-version `ready` frame + typed reset reasons

The first SSE frame on a successful stream is a typed `ready` frame carrying `OPERATOR_CONTRACT_VERSION`, so a browser client can detect contract drift at connect time. `ResetReason` is a closed union so a reset is explicit and machine-readable, not a guess from payload shape.

```ts
stream.writeSSE({event: 'ready', data: JSON.stringify({contractVersion: OPERATOR_CONTRACT_VERSION})}).catch(() => {})

export type ResetReason = 'no-snapshot' | 'terminal' | 'shutdown' | 'max-duration' | 'writer-error' | 'overflow'
```

The closed frame union is additive-by-contract: #965 added an `output` frame (`{ runId, text, final, seq, droppedCount? }`) and bumped `OPERATOR_CONTRACT_VERSION` to `1.3.0`. The frame's `text` is **sink-routed** (emitted by the engine through the operator-bound `ReplySink`), not extracted from `RunState` by the projection — so the closed-DTO discipline (rule 5) is unchanged: a new *frame type* is added, not a new *projected field*. Under per-subscriber backpressure, `output` frames **coalesce** (drop pending output, carry a cumulative `droppedCount`) rather than dropping the connection like status frames, and a `final: true` frame is cached so a late subscriber still receives the complete answer.

## Why This Matters

These ten rules together close the failure modes that make a naive SSE surface leaky or fragile: an auth oracle (differential responses by failure cause), an accidental GitHub call before redaction, internal run-state leaking into a frame, a slow consumer head-of-line-blocking every other subscriber, a teardown that leaks a slot or contaminates a reused keep-alive socket, a stale authorization that streams long after access is revoked, and silent contract drift. Most were review-caught — they would have shipped wrong without the discipline, and green tests did not surface them.

## When to Apply

- Adding an authenticated long-lived streaming surface (SSE or WebSocket) for status/observation.
- Any surface where fail-closed redaction must run before an external API call.
- Per-client stream quotas and bounded-lifetime connections.
- Long-lived connections that need continuous re-authorization.
- Client-visible contract versioning and explicit reset semantics.

## Examples

**Denials stay indistinguishable** — every gate failure returns the same shape:

```ts
if (resolvedToken === undefined) return notFoundResponse(c)
if (location === undefined) return notFoundResponse(c)
if (deps.denylistCache.isRepoDenied(denyKeys) === true) return notFoundResponse(c)
if (authzResult.authorized === false) return notFoundResponse(c)
```

**Snapshot-on-subscribe** — deliver the latest cached status first, else a `reset`:

```ts
const cached = latestStatusCache.get(runId)
if (cached === undefined) enqueueFrame(sub, {type: 'reset', runId, reason: 'no-snapshot'})
else enqueueFrame(sub, {type: 'status', data: cached})
```

## Related

- [gateway-control-surface-spine-2026-06-15.md](gateway-control-surface-spine-2026-06-15.md) — the transport-neutral execution/approval seam this SSE surface is the first transport on (the spine carved the seam; this instantiates it one layer up). Cross-link both ways.
- [signed-webhook-ingress-hardening-2026-05-29.md](signed-webhook-ingress-hardening-2026-05-29.md) — the HTTP no-oracle "identical 401" rule; rule 1 here is its SSE analogue.
- [centralize-s3-key-identity-construction-2026-06-09.md](centralize-s3-key-identity-construction-2026-06-09.md) — server-owned identity resolution; rule 3 applies it to `runId → repo`.
- [atomic-serial-channel-queue-handoff-2026-06-09.md](atomic-serial-channel-queue-handoff-2026-06-09.md) — the dual-finally resource-release discipline behind rule 7.
- [effect-failure-channel-discipline-2026-06-10.md](effect-failure-channel-discipline-2026-06-10.md) — fail-soft boundary discipline; rule 8's lease is the fail-*closed* counterpart.
- [gateway-opencode-mention-loop-best-practices-2026-05-30.md](gateway-opencode-mention-loop-best-practices-2026-05-30.md) — the gateway→workspace SSE direction; its "classify auth by numeric status" rule applies to workspace-internal SSE, while rule 1 here governs operator-facing SSE.
- [web-operator-launch-surface-2026-06-20.md](web-operator-launch-surface-2026-06-20.md) — the **write counterpart** on the same operator surface. Same no-oracle, redaction-before-authz, server-owned-resolution, and closed-DTO discipline, applied to a fire-and-return launch route instead of a long-lived stream (PR #968).
- Shipped in v0.72.0 via PR #961 (inert core) and PR #962 (authenticated route), under issue #907; the redaction-before-authz invariant is anchored by #950 and the operator-auth authority by #951.
