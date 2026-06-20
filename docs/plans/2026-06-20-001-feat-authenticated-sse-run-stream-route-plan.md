---
title: "feat: Authenticated SSE run-stream route (Unit 4b)"
type: feat
status: completed
date: 2026-06-20
deepened: 2026-06-20
completed: 2026-06-20
origin: docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md
---

# Authenticated SSE run-stream route (Unit 4b)

## Overview

Expose the inert run-observation core (Unit 4a) through a single authenticated, repo-scoped, fail-closed SSE route: `GET /operator/runs/:runId/stream`. An operator with repository access streams a run's redacted, status-only updates; everyone else gets an indistinguishable generic not-found. This is the security-critical unit — authorization and redaction happen **before any byte is written**, the resolved repository is **never** taken from the client, and access lost mid-stream terminates the connection.

This plan was Oracle-reviewed against current `main` (`48ff4e6`) before writing; the review corrected real drift (route file path, replay assumptions, redaction placement) and footguns (run-wide `abortSubscription`). It is split into three sub-units because the surface is security-dense.

## Problem Frame

Unit 4a shipped the observation manager (`packages/gateway/src/web/sse/manager.ts`) with no public route. The prerequisites are all live on `main`: operator session + token retention (3h, `getOperatorToken`), server-owned run resolution (3i, `RunIndex.lookup`), repository authorization (3f, `checkRepoAuthz`), the redaction gate (#950, `projectRunStatus`/`isRepoDenied`, already primed in `program.ts`), and the privileged-route wrapper (`registerOperatorRoute`). What is missing is the HTTP surface that ties them together with a correct gate ordering and a streaming lifecycle. Because a single missed gate leaks repo-scoped run status (or a run-existence oracle), the route's ordering and teardown are the whole point.

## Requirements Trace

- R0. The operator app deps (`OperatorServerDeps` / `buildOperatorApp`) are extended to carry the `denylistCache`, `bindingsLookup`, and the run-observation `manager` instances created in `program.ts` so the route can reach them. (Today they are threaded only into the observation manager, not the operator app — a verified feasibility prerequisite.)
- R1. `GET /operator/runs/:runId/stream` is registered through `registerOperatorRoute` so the browser/session/allowlist/CSRF guard runs first; `assertAllPrivilegedRoutesWrapped` still passes.
- R2. Gate ordering before any SSE byte (and before any distinguishable success response): (1) guard; (2) resolve session + OAuth token by `sessionId`; (3) `runId → repo` via `RunIndex.lookup` (server-owned, never client-supplied); (4) split `owner/repo`; (5) explicit redaction check (denylist, fail-closed); (6) `checkRepoAuthz`; (7) acquire a stream slot; (8) only then open the SSE stream. Any failure at 2-7 returns the **same** generic not-found. **There is no authorized non-stream response** — a successful gate transitions directly into the SSE stream, so a 200 can never act as a run-resolved/authorized oracle.
- R3. Visibility is **repo-scoped**: any allowlisted operator with repo access to the run's repo may observe it, regardless of who launched it. Authorization is purely `checkRepoAuthz` on the resolved repo — no run-owner comparison.
- R4. The route performs an **explicit pre-subscribe redaction check** (not relying on the manager's publish-time projection), because `subscribe()` emits the latest cached status immediately and that cache could be a stale-allowed status for a now-denylisted repo.
- R5. No run-existence oracle: unknown `runId`, missing/keyless binding, binding-store error, denylisted repo, and unauthorized all return the identical generic `not-found` shape. The accepted residual is timing only (unknown `runId` may incur the ~8s `RunIndex` fallback vs a fast denial); acceptable because run ids are UUIDs and the response shape is identical (documented residual, not a blocker).
- R6. Reconnect model is **snapshot-on-subscribe** — the first frame is the cached latest status, or a `reset` if none. No `Last-Event-ID`, no replay (4a deferred replay; the manager has none). The route relies only on the manager's documented contract: a subscriber receives the cached snapshot (or reset) then future frames; a frame fanned out concurrently with `subscribe` may race (the route does not assume stronger ordering).
- R7. SSE frames are mapped to Hono `streamSSE`; the teardown paths (client abort, manager `onClose` for shutdown/max-duration, lease failure) all converge on **one synchronous, locally-guarded `cleanup()`** (a route-local `cleaned` boolean) that runs exactly once, using the **per-connection `unsubscribe()`** returned by `subscribe` (never run-wide `abortSubscription`), clears the lease timer, releases the stream slot, and ends the stream.
- R8. Per-connection socket timeout is raised above the 15s heartbeat for the stream connection only, in a `try/finally` so it is restored/closed on every exit path (never leaked to a reused keep-alive socket); the global 10s pre-auth server timeout is unchanged. **(Spike-gated — see Unit 1 / Open Questions: if the per-connection node socket is not reachable from the route, fall back to lowering the heartbeat below 10s.)**
- R9. A **continuous-authz lease** re-checks session + token + redaction + `checkRepoAuthz` on a bounded interval for the life of the stream; on failure it closes that connection (per-connection `unsubscribe`, not run-wide). Each tick checks a `closed`/generation flag before acting on its async result, so a slow `checkRepoAuthz` resolving after the connection has been torn down is a no-op. Revocation detection is bounded by `checkRepoAuthz`'s positive cache TTL **plus its 10% jitter (≈5m30s) plus the lease interval** — documented, not bypassed.
- R10. A **per-operator** (keyed on the numeric `operatorId`/`githubUserId`, never the session) concurrent active-stream cap is enforced; the slot is acquired before opening the stream and released **synchronously** in `cleanup()` so a reconnect storm cannot transiently exceed the cap.

## Scope Boundaries

- Repo-scoped visibility only — no owner/launcher comparison, no per-run ACLs.
- No replay / `Last-Event-ID` (deferred with the 4a replay deferral). Reconnect = snapshot-or-reset.
- No staleness reconciler for stuck runs (deferred from 4a) — a run that never reaches terminal still streams its last cached status until max-duration; out of scope here.
- No cache-bypass on the authz lease — TTL-bounded revocation detection is accepted for v1.
- No new OAuth scope work beyond what R2's token read needs; the `read:user`-insufficiency for private-repo authz is tracked separately (memory 5806) and must be resolved for private repos to authorize, but is not this unit's code.

### Deferred to Separate Tasks

- Replay / `Last-Event-ID`: future unit, only if measured reconnect churn justifies it.
- Staleness reconciler (evict/seal a stuck run's cached status): future unit (also closes the 4a accepted cache-leak).
- OAuth scope broadening for private-repo authz (memory 5806): prerequisite for private repos, tracked separately.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/web/operator-route.ts` — `registerOperatorRoute(app, method, path, handler)` wraps the handler with the installed guard; `getOperatorAuthContext(c)` returns `{githubUserId, sessionId}`; `assertAllPrivilegedRoutesWrapped` enforces wrapping.
- `packages/gateway/src/web/auth/session-info-route.ts` `buildSessionInfoRoute(app, deps)` + `csrf-route.ts` `buildCsrfRoute` — the exact builder + registration pattern to mirror.
- `packages/gateway/src/web/auth/session.ts` — `getOperatorToken(sessionId, nowMs)` (checks live/non-revoked/non-expired; returns `undefined` when dropped → re-auth needed); `get(sessionId, nowMs)` for session validity.
- `packages/gateway/src/execute/run-index.ts` — `RunIndex.lookup(runId): Promise<RunLocation | undefined>`; `RunLocation.repo` is an `owner/repo` **string** (split it), plus `surface`. Fallback can take up to ~8s; unknown → `undefined`.
- `packages/gateway/src/web/auth/repo-authz.ts` — `checkRepoAuthz(operatorId: number, owner: string, repo: string, userOAuthToken: string, deps): Promise<RepoAuthzResult>`. Allowlist + cache (positive 5m, negative 30s, 10% jitter) + audit built in.
- `packages/gateway/src/redaction/denylist.ts` + `surface-gate.ts` — `denylistCache.getDenylistState()` / `isRepoDenied(repoKey)`; `projectRunStatus` resolves binding keys and returns null when denied. The cache is already created + primed + background-refreshed in `program.ts`.
- `packages/gateway/src/web/sse/manager.ts` — `subscribe(runId, callbacks): () => void` (returns **unsubscribe**; clean unsubscribe does NOT call `onClose`), `abortSubscription(runId, reason)` (**run-wide — do not use for per-connection teardown**), `SubscriberCallbacks` (`onEvent(frame)`, `onClose(reason)`), `ObservationFrame` = status | reset | heartbeat.
- `packages/gateway/src/web/server.ts` `buildOperatorApp` (~229-491); the global `server.setTimeout(10_000)` (~510) bounds idle pre-auth connections — do not raise it.
- `packages/gateway/src/http/safe-response.ts` `notFoundResponse(c)` → `{error: 'not-found'}` — the single generic shape for every denied path.
- `packages/gateway/src/http/ingress-pin.test.ts` (~113-120) — the guarded-route allowlist; adding the route intentionally breaks it and must be updated.
- `@hono/node-server` `HttpBindings` (`incoming`/`outgoing`) — for the per-connection socket-timeout adjustment; Hono `streamSSE` for the stream.

### Institutional Learnings

- `docs/solutions/best-practices/gateway-control-surface-spine-2026-06-15.md` — server-owned resolution; never trust client-supplied repo.
- `docs/solutions/best-practices/centralize-s3-key-identity-construction-2026-06-09.md` — verify identity end-to-end; reuse shared key builders for binding/deny-key resolution.
- The 4a manager doc and mention-loop terminal-correctness doc — terminal/teardown discipline; EOF is observation failure not success.

### External References

- Hono `streamSSE` helper (`onAbort`, manual write) — does not implement replay; the route owns lifecycle.

## Key Technical Decisions

- **No authorized non-stream response.** A passing gate transitions directly into `streamSSE`; there is no intermediate authorized 200/marker. A distinguishable success response would itself be a run-resolved/authorized oracle, so the gate and the stream are one unit of work.
- **Token before run work.** After the guard, resolve session + `getOperatorToken(sessionId)` first. A missing token → generic not-found independent of `runId`, so a re-auth need never becomes a run-existence timing signal.
- **Explicit pre-subscribe redaction (P0).** The route resolves the binding's deny-keys and calls `isRepoDenied` before subscribing, returning the generic not-found on deny. Manager-level redaction is publish-time defense-in-depth, not the subscribe gate — `subscribe()` would otherwise emit a stale-allowed cached status for a newly denylisted repo.
- **Per-connection teardown via `unsubscribe()`, single synchronous cleanup.** `abortSubscription` is run-wide and would kill every operator's stream for that run on one tab disconnect — never use it for per-connection teardown. All exit paths converge on one `cleanup()` guarded by a route-local `cleaned` boolean so it runs once even under concurrent abort/lease-failure/manager-close; it calls `unsubscribe()`, clears the lease timer, releases the stream slot (synchronously), and ends the stream.
- **TTL-bounded continuous authz with a generation guard.** The lease re-checks through `checkRepoAuthz`'s cache; revocation is detected no later than positive-cache TTL + 10% jitter (≈5m30s) + lease interval. Accepted for v1; documented. No cache-bypass (avoids GitHub API pressure). Each tick re-checks the `cleaned`/`closed` flag before acting on its async result, so a slow check resolving after teardown is a no-op.
- **Per-connection socket timeout, not global, `try/finally`.** Raise only this connection's Node socket timeout above the heartbeat via the Hono node bindings, in a `try/finally` so it is restored/closed on every exit and never leaks to a reused keep-alive socket. The global 10s stays to bound idle pre-auth sockets. Spike-gated: if the route cannot reach the connection socket, fall back to a heartbeat below 10s.
- **Stream cap keyed on `operatorId`.** The concurrent-stream cap is keyed on the numeric GitHub user id, not the session — a session key is bypassable by opening multiple sessions. Slot acquired before the stream opens, released synchronously in `cleanup()`.
- **One generic denial shape.** `notFoundResponse(c)` for unknown runId / missing-keyless binding / store error / denied / unauthorized. Timing is UUID-keyed; accept the ~8s-fallback-vs-fast divergence for v1 (no coarse timing normalization unless leaked run IDs become a concern).
- **Status-only DTO (the revocation window is only safe because of this).** The streamed `OperatorRunStatus` carries exactly: `runId`, `entityRef`, `surface`, `phase`, `status`, `startedAt`, `stale` — no launcher identity, actor name, prompt, tool args, file path, or token. The TTL-bounded revocation window (R9) is acceptable precisely because these fields are low-sensitivity status only; any future richer field would force re-evaluating the lease/cache window.

## Gate Ordering (the load-bearing flow)

> *Directional — illustrates the required ordering for review, not implementation code.*

```
GET /operator/runs/:runId/stream
  └─ registerOperatorRoute guard (browser/session/allowlist/CSRF)  ── fail → guard's own response
  └─ getOperatorAuthContext(c) → { githubUserId, sessionId }
  └─ token = sessionStore.getOperatorToken(sessionId, now)         ── undefined → notFound (re-auth)
  └─ location = runIndex.lookup(runId)                             ── undefined → notFound
  └─ { owner, repo } = split(location.repo)                       ── malformed → notFound
  └─ denyKeys = resolve binding keys; await getDenylistState()
     if isRepoDenied(denyKeys)                                    ── denied → notFound
  └─ authz = checkRepoAuthz(githubUserId, owner, repo, token)     ── !authorized → notFound
  └─ acquire per-operator stream slot (key = githubUserId)        ── over cap → 429 (operator already authorized; honest backpressure, not a run oracle)
  └─ streamSSE: subscribe(runId) → snapshot/reset → live frames + heartbeat
        lease timer: re-check session+token+redaction+authz       ── fail → cleanup() (unsubscribe + clear timer + release slot)
        onAbort / onClose / max-duration                          ── → clear timer + unsubscribe
```

## Implementation Units

- [x] **Unit 0: Thread the denylist, bindings, and manager into the operator app deps**

  **Goal:** Make the redaction cache, bindings lookup, and observation manager reachable from operator routes — they exist in `program.ts` today but are not in `OperatorServerDeps`.

  **Requirements:** R0

  **Dependencies:** None (pure wiring on `main`).

  **Files:**
  - Modify: `packages/gateway/src/web/server.ts` (extend `OperatorServerDeps` + thread through `buildOperatorApp`)
  - Modify: `packages/gateway/src/program.ts` (pass the existing `denylistCache`, `bindingsStore`/lookup, and `runObservationManager` into `buildOperatorApp`)
  - Test: `packages/gateway/src/web/server.test.ts` (deps wiring)

  **Approach:**
  - Add `denylistCache`, `bindingsLookup`, and `manager` (the run-observation manager) to `OperatorServerDeps` (readonly). Thread them where `buildOperatorApp` constructs/wires routes.
  - In `program.ts`, pass the already-created instances (created for the observation manager) into `buildOperatorApp` — do not create second instances (one denylist cache, one manager per process).
  - No behavior change yet; this is the seam Unit 1 consumes.

  **Execution note:** Pure wiring — keep it minimal; the route units depend on it.

  **Patterns to follow:** how existing deps (`sessionStore`, `allowlist`, rate limiter) are threaded into `OperatorServerDeps` / `buildOperatorApp`.

  **Test scenarios:**
  - Wiring: `buildOperatorApp` accepts and retains the new deps; existing server tests still pass with the extended deps shape.

  **Verification:** The operator app can reach the denylist cache, bindings lookup, and observation manager; no second instance is created; no behavior change.

- [x] **Unit 1: Gate + authorized SSE open (no standalone success response)**

  **Goal:** The authenticated, server-owned, fail-closed gate that resolves the run, enforces redaction + repo authz, and — on success — transitions **directly into the SSE stream**. Every denial is the one generic not-found; there is **no** authorized non-stream response (no oracle).

  **Requirements:** R1, R2, R3, R4, R5, R6 (snapshot frame), R10 (slot acquire)

  **Dependencies:** Unit 0; 4a (manager), 3h, 3i, 3f, #950.

  **Files:**
  - Create: `packages/gateway/src/web/sse/run-stream-route.ts` (`buildRunStreamRoute(app, deps)`)
  - Create: `packages/gateway/src/web/sse/run-stream-route.test.ts`
  - Modify: `packages/gateway/src/web/server.ts` (register the route in `buildOperatorApp` after the guard is installed, before `notFound`/`assertAllPrivilegedRoutesWrapped`)
  - Modify: `packages/gateway/src/http/ingress-pin.test.ts` (add the new guarded route to the pinned list)

  **Approach:**
  - `buildRunStreamRoute(app, deps)` registers `GET /operator/runs/:runId/stream` via `registerOperatorRoute`. Deps come from Unit 0 plus `{sessionStore, runIndex, repoAuthzDeps, logger, now}`.
  - Handler runs the gate in the flow's exact order: `getOperatorAuthContext(c)` → `getOperatorToken(sessionId)` → `runIndex.lookup(runId)` → split `owner/repo` → resolve binding deny-keys + `getDenylistState()` + `isRepoDenied` → `checkRepoAuthz(githubUserId, owner, repo, token, repoAuthzDeps)` → acquire the per-`operatorId` stream slot (over cap → `429`).
  - **Every failure at any gate step returns `notFoundResponse(c)` before opening any stream** — there is no authorized 200/marker. On full success, the handler calls `streamSSE(c, ...)` and immediately delivers the manager's snapshot/reset as the first frame. (The live-frame loop, heartbeat, socket timeout, teardown, and lease are Units 2-3; Unit 1 lands the gate + stream-open + first snapshot frame so success is never observable as a non-stream response.)
  - Resolve the binding's deny-keys reusing the same binding/deny-key resolution `surface-gate.ts` uses (`bindingsLookup` + the shared key builder) — do not reinvent key construction.
  - Slot acquired here so an over-cap operator never opens a stream; released by the Unit 2 `cleanup()` (in Unit 1, release on the immediate stream end).

  **Execution note:** Test-first — the load-bearing assertion is that **no stream is opened and no distinguishable success response exists** unless all gates pass, and all denials share one shape.

  **Patterns to follow:** `buildSessionInfoRoute`/`buildCsrfRoute` registration; `checkRepoAuthz` fail-closed posture; `notFoundResponse`; Hono `streamSSE`.

  **Test scenarios:**
  - Security: missing token (dropped session) → not-found, identical whether `runId` exists or not; no stream opened.
  - Security: unknown `runId` (`lookup → undefined`) → not-found; no authz/redaction call after the miss; no stream.
  - Security: client cannot influence the resolved repo — only `runIndex.lookup` determines owner/repo (no query/body/header repo read).
  - Security: denylisted repo → not-found; `checkRepoAuthz` NOT reached (denylist before authz); no stream.
  - Security: `checkRepoAuthz` denies → not-found; byte-identical shape to unknown/denied; no stream.
  - Security: success is observable ONLY as an SSE stream (content-type `text/event-stream` + first snapshot/reset frame) — there is no 200 JSON/marker body that a prober could distinguish from not-found.
  - Cap: an over-cap operator (by `githubUserId`) gets `429`, not a stream.
  - Integration: `assertAllPrivilegedRoutesWrapped` passes; ingress-pin lists the new guarded route.

  **Verification:** No stream and no distinguishable success response unless token + lookup + redaction + authz + slot all pass; every denial is the one generic shape; resolved repo is server-owned; route is guard-wrapped and pinned.

- [x] **Unit 2: SSE live bridge + socket timeout + single cleanup**

  **Goal:** Turn Unit 1's stream-open into a full live stream — live frames, heartbeat, a spike-verified per-connection socket timeout, and one synchronous guarded cleanup that all teardown paths converge on.

  **Requirements:** R6, R7, R8

  **Dependencies:** Unit 1.

  **Files:**
  - Modify: `packages/gateway/src/web/sse/run-stream-route.ts`
  - Modify: `packages/gateway/src/web/sse/run-stream-route.test.ts`

  **Approach:**
  - **Socket-timeout spike FIRST (R8):** before building on it, verify the per-connection Node socket is reachable from the route and supports `setTimeout`. The plan's assumption (`c.env.outgoing`/`incoming` from `@hono/node-server` `HttpBindings`) is **unverified against current source** — confirm it exposes a Node socket with `setTimeout`, or fall back to lowering the manager heartbeat below the global 10s timeout (a config change, no socket access). Pick the working path and note it.
  - If the socket path works: raise this connection's socket timeout above the heartbeat (e.g. 60s) inside a `try/finally`, capturing the prior value and **always** restoring/closing it on exit so it never leaks to a reused keep-alive socket. Do not touch the global server timeout.
  - `const unsubscribe = manager.subscribe(runId, { onEvent: frame => writeFrame(stream, frame), onClose: reason => endStream(reason) })`. Map `ObservationFrame` → SSE: `status` → `event: status` + JSON data; `reset` → `event: reset` + `{runId, reason}`; `heartbeat` → SSE comment/keepalive. Never serialize anything outside the frame union.
  - **Single synchronous cleanup (R7):** one `cleanup()` guarded by a route-local `let cleaned = false` so it runs exactly once even under concurrent invocation. It: calls `unsubscribe()`, clears the lease timer (Unit 3), releases the stream slot synchronously, restores the socket timeout, and ends the stream. All paths call it: `stream.onAbort(cleanup)`, manager `onClose(reason)` → `cleanup`, max-duration → `onClose('max-duration')` → `cleanup`. **Never** `abortSubscription`. Stream finalization is a one-way edge owned only by `cleanup`.
  - EOF before terminal is an observation failure (manager closes with a reason), not success — surface as a clean stream end, not a completion.

  **Execution note:** Test-first on cleanup idempotency under concurrent teardown and the socket-timeout restore-on-every-exit property; these are the leak/race risks.

  **Patterns to follow:** the 4a manager's `onClose`/unsubscribe contract; `status-message.ts` cleanup discipline.

  **Test scenarios:**
  - Happy: stream delivers snapshot/reset first, then live status frames, then a clean terminal close; heartbeats on idle.
  - Teardown idempotency (load-bearing): concurrent client-abort + manager-`onClose` both invoke `cleanup`, which runs exactly once — `unsubscribe` once, slot released once, timer cleared once, no double stream-end.
  - Reliability: with the socket path, the per-connection timeout is raised above the heartbeat and **restored on every exit path** (including early error) — assert the underlying socket timeout returns to baseline after cleanup; the global timeout is untouched. (If the spike chose the heartbeat-lowering fallback, assert the heartbeat is below the global timeout instead.)
  - Isolation: one connection's teardown does not affect other subscribers of the same run (proves `unsubscribe`, not `abortSubscription`).
  - Safety: only `status`/`reset`/`heartbeat` SSE events are ever written — no raw output/tool/path bytes.

  **Verification:** Live frames stream with snapshot-on-subscribe semantics; one synchronous guarded cleanup handles every teardown path; the socket-timeout mechanism is spike-verified and never leaks.

- [x] **Unit 3: Continuous-authz lease + per-operator stream cap**

  **Goal:** Keep a live stream honest — periodically re-verify session, token, redaction, and repo authz with a generation guard, terminate on loss, and bound concurrent streams per operator id.

  **Requirements:** R9, R10

  **Dependencies:** Units 1-2.

  **Files:**
  - Modify: `packages/gateway/src/web/sse/run-stream-route.ts`
  - Modify: `packages/gateway/src/web/sse/run-stream-route.test.ts`

  **Approach:**
  - Start a route-owned lease timer when the stream opens (interval = heartbeat or a small multiple; named injectable constant). On each tick, re-run: `sessionStore.get(sessionId)` (live?), `getOperatorToken(sessionId)` (present?), `getDenylistState()` + `isRepoDenied` (still allowed?), `checkRepoAuthz(...)` (still authorized?). Any failure → `cleanup()` (closes this connection only).
  - **Generation guard:** each tick checks the `cleaned` flag *after* its async work resolves and before acting, so a slow `checkRepoAuthz` (which can wait on an in-flight request) that resolves after the connection is already torn down is a no-op — no acting on a dead socket, no late close.
  - The lease goes through `checkRepoAuthz`'s cache; document that revocation detection is bounded by **positive-cache TTL + its 10% jitter (≈5m30s worst case) + the lease interval**, and denylist detection by the denylist refresh TTL + lease interval. No cache-bypass (accepted for v1, status-only data).
  - **Per-operator cap (R10):** track active streams keyed on the numeric `githubUserId` (never the session — a session key is bypassable). The slot is acquired in Unit 1 before the stream opens (over cap → `429`, honest backpressure for an already-authorized operator, not a run oracle) and released **synchronously** in `cleanup()` so a rapid connect/disconnect storm cannot transiently exceed the cap.
  - Do **not** call `dropOperatorToken()` on a generic `github_denied` from `checkRepoAuthz` — that result cannot distinguish a revoked token from a denied repo. Only drop the token on a token-specific signal.

  **Execution note:** Test-first on the lease-failure → per-connection-close path, the late-resolving-check no-op (generation guard), and synchronous cap release.

  **Patterns to follow:** the existing per-route rate-limit/resource-bound convention in `server.ts`; `checkRepoAuthz` cache semantics.

  **Test scenarios:**
  - Security (lease): repo access revoked mid-stream → on the next tick after authz cache expiry (test clock) the stream is closed via `cleanup`; status stops flowing.
  - Security (lease): repo denylisted mid-stream → next tick closes the stream.
  - Security (lease): token dropped / session expired mid-stream → next tick closes the stream.
  - Generation guard: a lease tick whose `checkRepoAuthz` resolves *after* the connection is torn down does nothing (no close on a dead socket, no throw, no log spam).
  - Isolation: a lease failure on one connection closes only that connection, not other subscribers of the run.
  - Cap: the (N+1)th concurrent stream for one `githubUserId` gets `429`; closing one frees a slot synchronously; a rapid reconnect storm cannot exceed the cap; multiple sessions for the same operator share one cap.
  - No false drop: a still-authorized stream survives lease ticks; no `dropOperatorToken` on a generic repo denial.

  **Verification:** A stream is terminated within (≈5m30s + lease interval) of access loss via per-connection teardown; a late-resolving check is a no-op; concurrent streams are bounded per operator id with synchronous slot release; token is not dropped on ambiguous denials.

## System-Wide Impact

- **Interaction graph:** new guarded route in `buildOperatorApp`; consumes 3h/3i/3f/#950/4a. `ingress-pin.test.ts` and `assertAllPrivilegedRoutesWrapped` are the structural guards.
- **Error propagation:** every gate failure collapses to one `notFoundResponse`; lease failures close the connection without touching the run.
- **State lifecycle risks:** per-connection teardown must be idempotent and use `unsubscribe` (not run-wide `abortSubscription`); the socket-timeout change must be restored/closed; the stream-cap slot must release on every path.
- **API surface parity:** this is the first SSE route; its frame shapes (status/reset/heartbeat) become the operator stream contract.
- **Integration coverage:** the gate-ordering security tests and the lease-revocation tests are the cross-layer proofs unit mocks alone can't give.
- **Unchanged invariants:** the manager stays observer-only and untouched; the global 10s server timeout stays; runtime/coordination untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Authorized non-stream response acts as a run-resolved/authorized oracle | No placeholder/marker — a passing gate transitions directly into `streamSSE`; success is observable only as a stream (test: no distinguishable 200 body). |
| Deps not reachable from the route (`denylistCache`/`bindingsLookup` not in `OperatorServerDeps`) | Unit 0 threads them from `program.ts` into `buildOperatorApp` before any route work. |
| Per-connection socket-timeout mechanism unverified against source | Unit 2 spikes it first; falls back to lowering the heartbeat below the global 10s if the connection socket is unreachable. |
| Manager-only redaction serves a stale-allowed cached status on subscribe | Explicit pre-subscribe `isRepoDenied` gate in the route (R4); test a newly-denylisted repo returns not-found and never subscribes. |
| `abortSubscription` (run-wide) used for per-connection teardown kills all operators' streams | Use the `unsubscribe()` return; isolation test proves one teardown doesn't affect peers. |
| Idle SSE socket killed by the 10s global timeout | Per-connection socket timeout raised above heartbeat in `try/finally` (restored on every exit, no keep-alive leak); global untouched. |
| Revoked GitHub access keeps streaming status | Lease re-check; documented worst case ≈5m30s (positive TTL + 10% jitter) + lease interval; accepted for v1 because frames are status-only; lease test uses a controlled clock. |
| Late-resolving lease check acts on a torn-down connection | Generation/`cleaned` guard: each tick re-checks the flag after its async work before acting. |
| Run-existence oracle via differing denial shapes/timing | Single `notFoundResponse` for all denials; UUID run ids; timing divergence accepted/noted. |
| Token revoked vs repo denied indistinguishable → wrong `dropOperatorToken` | Do not drop token on generic `github_denied`; only on a token-specific signal. |
| Teardown double-close / leaked timer / double slot-release | One synchronous `cleanup()` guarded by a `cleaned` boolean for all paths; idempotency test under concurrent teardown. |
| Stream-cap bypass via multiple sessions or reconnect storm | Cap keyed on `githubUserId` (not session); slot released synchronously in `cleanup()`; reconnect-storm test. |
| Stale-cached status on a never-terminal run (4a accepted leak) gives a subscriber a believable stale snapshot then only heartbeats | Bounded by max-duration; documented v1 limitation; the deferred staleness reconciler (4a) is the real fix. |

## Documentation / Operational Notes

- Document the operator stream contract (`GET /operator/runs/:runId/stream`, status/reset/heartbeat frames, snapshot-on-subscribe, TTL-bounded revocation) in the gateway operator docs after Unit 3.
- Note the accepted v1 limitations (no replay, TTL-bounded authz, no staleness reconciler) where operators will read them.
- Update `docs/plans/2026-06-15-002` Unit 4b checkbox on completion.

## Open Questions

### Resolved During Planning (Oracle + document review)

- Route file/shape: `web/sse/run-stream-route.ts` + `buildRunStreamRoute` via `registerOperatorRoute` (plan's `web/routes/run-stream.ts` was drift).
- **No placeholder/authorized-marker response** — a passing gate transitions directly into the stream (no 200 oracle). Gate + stream-open land together in Unit 1.
- **Deps threading is a real prerequisite** — `denylistCache`/`bindingsLookup`/`manager` are not in `OperatorServerDeps` today; Unit 0 adds them.
- Replay: none — snapshot-on-subscribe (4a deferred replay).
- Redaction placement: explicit pre-subscribe route check, not manager-implicit.
- Teardown: one synchronous `cleaned`-guarded `cleanup()` using per-connection `unsubscribe()`, never run-wide `abortSubscription`.
- Socket timeout: per-connection in `try/finally` (spike-gated), not the global server timeout.
- Continuous authz: **kept in v1**; cache-TTL-bounded (≈5m30s + lease interval worst case), generation-guarded, no bypass.
- Stream cap: **kept in v1**, keyed on `githubUserId`; over-cap → `429` (honest backpressure for an already-authorized operator, not a run oracle).

### Deferred to Implementation

- Exact lease interval (heartbeat vs small multiple) — pick against the heartbeat constant during implementation.
- The socket-timeout spike outcome (per-connection socket vs heartbeat-lowering fallback) — decided in Unit 2 against the verified binding behavior.
- Coarse timing normalization for the unknown-runId 8s-fallback vs fast-denial divergence — only if leaked run ids prove a concern (likely not, UUIDs).

## Sources & References

- **Origin plan:** `docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md` (Unit 4b section).
- Oracle design review (2026-06-20) against `main` `48ff4e6` — file:line-cited findings on route path, token retrieval, redaction placement, lease cache semantics, socket timeout, teardown footgun, unit split.
- Document review (2026-06-20, 5 reviewers) — found the placeholder-200 oracle (P0), the `OperatorServerDeps` deps-threading gap and unverified socket-timeout binding (feasibility P1s), the operatorId cap key, the ≈5m30s jitter bound, the synchronous-cleanup/generation-guard robustness, and the status-only DTO enumeration. Forks resolved by Marcus: keep the continuous-authz lease and the stream cap in v1.
- Related code: `packages/gateway/src/web/operator-route.ts`, `web/auth/session.ts`, `web/auth/repo-authz.ts`, `execute/run-index.ts`, `redaction/denylist.ts`, `web/sse/manager.ts`, `web/server.ts`, `http/safe-response.ts`, `http/ingress-pin.test.ts`.
- Related issue: #907 (operator web surface umbrella).
