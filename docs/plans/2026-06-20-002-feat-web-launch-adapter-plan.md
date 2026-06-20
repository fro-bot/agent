---
title: 'feat: Gateway web launch adapter (Unit 5)'
type: feat
status: active
date: 2026-06-20
origin: docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md
deepened: 2026-06-20
---

# Gateway web launch adapter (Unit 5)

Unit 5 of the gateway web operator control surface (parent plan: `docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md`). Resumes that plan's Unit 5 with the repo-selector decision folded in.

## Overview

Let an authenticated, allowlisted web operator launch agent work through the gateway's browser API, using the same transport-neutral `launchWork` execution front door that Discord mentions already use. Two pieces: a scoped repo-list route so the operator can see which repos they may launch in, then a launch route that builds a `LaunchWorkRequest` from the HTTP request and submits it.

The execution engine is already transport-neutral — `launchWork(request, deps)` and `LaunchWorkRequest` (with `surface: 'web'`, a `web-operator` requester, and web `statusSink`/`replySink`) are built for exactly this. The net-new work is: a scoped repo selector, web sink implementations (the web equivalents of the Discord status/reply sinks), launch idempotency, and the two routes.

## Problem Frame

The gateway can launch work from Discord (mentions → `runMention` → `launchWork`) and observe runs over the operator SSE route (#962). It cannot yet launch work from the browser. The missing piece is the authenticated launch path: an operator picks a bound repo and submits a prompt, and the gateway runs it through the same queue, concurrency cap, lock, and run-state spine Discord uses — recorded as `surface: 'web'` and attributable to the operator's GitHub identity.

A web operator has no Discord channel to imply the repo, so the surface must (a) let them choose from repos they may launch in (scoped per R19 so they cannot enumerate unrelated repos), and (b) surface unbound/unknown repo states before any work is queued (R10).

## Requirements Trace

- R1. Only an authenticated, allowlisted operator can list repos or launch work (reuse the operator guard).
- R6. Web-launched work enters the same public `launchWork` front door used by Discord-launched work (same queue, cap, lock, run-state).
- R10. Launch surfaces empty/unbound/unknown repo states before work starts, and prevents accidental duplicate submissions.
- R12/R17. No raw tool args, paths, tokens, or secrets in responses or logs; user-facing errors stay coarse.
- R14. The run is attributable to the operator's stable GitHub identity (`web-operator` requester).
- R18. The repo-list route exposes read-only binding data needed for repo selection (the cuttable Unit 7 slice pulled forward).
- R19. The repo list is scoped so an allowed operator cannot enumerate unrelated repositories: denylist-filtered, then gated by the operator's actual GitHub access to each repo.

## Scope Boundaries

- No binding writes, deletes, repo onboarding, or repair from the web surface.
- No machine/API callers; browser operator session only.
- No INTERACTIVE web approval transport — that is Unit 6. v1 web launches supply an **auto-deny** `createApprovalOnPending` so a tool gate is denied immediately (never the Discord transport, never a lock-deadlock). A web-launched run can only complete work needing no tool approval until Unit 6.
- No Discord behavior change.
- No streaming of launch output in the launch response — observation is the SSE route (#962); the launch route returns the created `runId` and the operator subscribes to observe.

### Deferred to Separate Tasks

- Full Unit 7 scoped binding reads beyond what the selector needs: parent plan Unit 7.
- Web approval notification + decision transport: parent plan Unit 6.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/execute/run.ts` — `launchWork(request, deps)` (the transport-neutral front door) and `runMention` (the Discord adapter to mirror, transport-neutrally).
- `packages/gateway/src/execute/launch-types.ts` — `LaunchWorkRequest`, `RequesterIdentity`/`WebOperatorIdentity`, `StatusSink`, `ReplySink`, `ApprovalTransportContext`. The web seam is fully specified here.
- `packages/gateway/src/bindings/store.ts` — `listBindings()` (flat global list), `getBindingByRepo(owner, repo)`.
- `packages/gateway/src/bindings/types.ts` — `RepoBinding` (owner/repo/channelId/channelName/workspacePath/deny-keys; **no enabled/disabled field** — only bound vs unbound exists).
- `packages/gateway/src/web/auth/repo-authz.ts` — `checkRepoAuthz(operatorId, owner, repo, token, deps)` (allowlist → cache → GitHub; 5m positive / 30s negative cache with coalescing).
- `packages/gateway/src/redaction/surface-gate.ts` — `filterDeniedRecords()` (denylist-first primitive; call before any per-repo query/projection) and `resolveBindingDenyKeys()`.
- `packages/gateway/src/web/auth/session.ts` — `getOperatorToken(sessionId, now)` (the OAuth token for `checkRepoAuthz`).
- `packages/gateway/src/web/operator-route.ts` — `registerOperatorRoute`, `getOperatorAuthContext`.
- `packages/gateway/src/web/server.ts` — `buildOperatorApp`, `OperatorServerDeps` (already carries allowlist, auditLogger, sessionStore, denylistCache, bindingsLookup, runIndex, repoAuthzCache).
- `packages/gateway/src/web/auth/session-info-route.ts`, `web/sse/run-stream-route.ts` — the `buildXRoute(app, deps)` + `registerOperatorRoute` pattern, the no-oracle/coarse-error discipline, and structured logging.
- `packages/gateway/src/operator-contract/run-status.ts`, `approval.ts`, `version.ts` — the contract DTO + pure-projection pattern and `OPERATOR_CONTRACT_VERSION` (currently `1.1.0`).
- `packages/gateway/src/http/ingress-pin.test.ts` — the operator route inventory pin (must add both new routes).

### Institutional Learnings

- `docs/solutions/best-practices/gateway-control-surface-spine-2026-06-15.md` — public-front-door, server-owned resolution, transport-neutral sinks.
- `docs/solutions/best-practices/atomic-serial-channel-queue-handoff-2026-06-09.md` — `launchWork` already owns the queue/cap/handoff; the web adapter must not bypass it.
- The #962 SSE route established the operator-route discipline this unit reuses: server-owned repo resolution, denylist-before-anything, coarse 404s, structured server-side logging.

## Key Technical Decisions

> Revised 2026-06-20 after a 5-reviewer document-review (see "Document Review Findings" below). The P0/P1 findings are now folded into the decisions and units; the review section is retained as the audit trail.

- **Launch is FIRE-AND-RETURN, never awaited (P0, verified `run.ts:882`).** `launchWork(request, deps): Promise<void>` **awaits the entire run** on the immediate-slot path (`await executeWorkOnHeldSlot`), and returns no runId. So the launch route must NOT `await launchWork`. Instead: the route generates the `runId` itself, registers a PENDING entry in the run index (`deps.runIndex.register`) BEFORE starting work, calls `launchWork` WITHOUT awaiting (fire-and-forget with a `.catch` that logs), and returns `202 {runId}` immediately. This requires threading a caller-supplied `runId` into the engine (a `LaunchWorkRequest.runId?` field or an injected id factory) so the route and the engine agree on the id — settle the exact seam in 5b, but the route owning/knowing the runId before work starts is non-negotiable. The response is **202 Accepted** (work queued/started), and the operator immediately opens the #962 SSE stream for that runId to observe.
- **Tool-approval interim = AUTO-DENY for `surface:'web'` (P1, verified `run.ts` approval-transport selection).** With no web approval transport (Unit 6), an absent `createApprovalOnPending` makes the engine default to the **Discord** approval transport — which posts to a non-existent thread (`approvalScopeId: ''`), is un-approvable on any surface, and **holds the repo lock until the ~13m deadline, blocking ALL runs in that repo**. v1 must NOT fall through to Discord. Decision: a web launch supplies a web `createApprovalOnPending` that **auto-denies** every tool permission request (fail-fast, no lock hold, no cross-surface confusion). A web-launched run can therefore only complete work that needs no tool approval; tool-gated steps are denied and the run proceeds/fails accordingly. The real interactive web approval transport is Unit 6. Pin the auto-deny with a test (a web launch hitting a tool gate denies immediately, does not deadlock the lock).
- **Prompt construction must be web-appropriate (P1, verified `run.ts:469` `buildDiscordPrompt`).** `executeWorkOnHeldSlot` unconditionally wraps the prompt with `DISCORD_MECHANICAL_GUIDANCE` ("You are responding in a Discord thread"). A web run would get Discord-flavored instructions. Make prompt construction injectable — a `promptBuilder?` on `LaunchWorkRequest` (or skip `buildDiscordPrompt` when `surface === 'web'` and use a web builder). The web builder omits Discord-thread/persona framing.
- **Scoped repo list (R19) = listBindings → denylist-filter → per-repo `checkRepoAuthz`.** All-bound-repos would let an allowed operator enumerate every onboarded repo (R19 violation). The defensible scope: enumerate bindings, drop denylisted records first (`filterDeniedRecords`), then keep only repos the operator actually has GitHub access to (`checkRepoAuthz`). N bindings is small and the authz cache coalesces, so per-repo authz is acceptable; use a simple hard cap + truncated-list contract (NOT pagination machinery). Failures are uniform/coarse (no oracle): store-error vs unauthorized vs denylisted must not be distinguishable; a residual timing oracle (sync vs async gate) is accepted for an authenticated-only route and documented.
- **New `RepoSummary` contract DTO → MINOR contract bump `1.1.0 → 1.2.0`.** Additive. The DTO exposes only `{owner, repo}` (+ optional display-only `channelName`) — never deny-keys, workspacePath, channelId, or internal IDs, in BOTH response and logs.
- **Server-owned repo resolution on launch.** The launch body names a repo; the server resolves it via `getBindingByRepo` (never trusts a client-supplied binding/path/owner), denylist-checks it, then authorizes the operator against it — mirroring the SSE route's gate discipline. Unknown/unbound/denied → a coarse pre-launch error (R10), not a queued run.
- **Web sinks feed run-state lifecycle, NOT the observation manager directly (corrected — P2).** A web launch has no Discord thread. `statusSink`/`replySink` get minimal in-gateway web implementations that are best-effort/no-op for transport UX (typing/reactions). Observation is driven by the engine's `transitionRun → runObserver.observe` lifecycle hook (`run.ts:400`), NOT by sink writes — so the operator observes via the #962 SSE route through the normal run-state path. `threadFactory` is omitted (engine uses empty thread id). Output is not returned inline.
- **`channelId` for queue scoping — namespaced, opaque, per-repo.** `launchWork` scopes its per-channel FIFO queue + concurrency slot by `channelId`. A web launch has no Discord channel; use a deterministic, NAMESPACED, opaque scope key derived from the binding (`web:<owner>/<repo>`) that cannot equal a Discord snowflake — never a client-supplied field. This serializes web launches per-repo like Discord. Known v1 tradeoff: two operators launching in the same repo share a FIFO/cap, so one can queue ahead of another (per-repo serialization); document it.
- **Idempotency (R10) — per-operator namespaced.** The launch route accepts an idempotency key and echoes the existing runId on a duplicate within a short window. The key MUST be namespaced per operator (`${githubUserId}:${clientKey}`) so operator A cannot replay operator B's key to suppress B's launch. Define omitted-key behavior (no idempotency guard / always launch) and a bounded retention window. In-memory bounded map is acceptable for v1.
- **State-changing route hardening (R3-equivalent, P1).** `POST /operator/runs` is the first WRITE operator route — it MUST go through the operator CSRF/Origin/Fetch-Metadata middleware, and MUST carry the parent plan's launch rate limits (3/min, 10/hr, operator-keyed) — the per-repo synthetic channelId does NOT cap an operator across many repos.
- **Coarse errors, structured logs (R12/R17).** User sees coarse states (unauthorized → 404, unbound/unknown repo → a clear pre-launch error, over-cap/queue-full → backpressure/202-queued); logs carry operator id, repo, and reason. No token/path/prompt in responses or logs.

## Open Questions

### Resolved During Planning

- How does a web operator pick a repo? → Scoped `GET /operator/repos` (5a), per-operator-authz filtered.
- Does the repo list need a disabled state? → No; `RepoBinding` has no disabled field. Surface bound (listable) vs unbound (absent) only. (R10's "disabled" is unsatisfiable without a schema change — honest gap, follow-up filed; the only current lever to stop web launches in a repo is destructive unbinding.)
- Does launch stream output? → No; returns `202 {runId}`; operator observes via the #962 SSE route.
- Does the route await launchWork? → **No (P0).** launchWork awaits the whole run; the route generates+registers the runId, fires launchWork without awaiting, returns 202 immediately.
- What happens on a tool-approval gate with no web approval transport? → **Auto-deny** (web `createApprovalOnPending` that denies). NOT Discord fallback (lock-deadlock + cross-surface confusion). Interactive web approval is Unit 6.
- Should idempotency keys be global? → No; per-operator namespaced (`${githubUserId}:${clientKey}`).

### Deferred to Implementation

- The exact seam for the route to own the runId before launchWork starts (a `LaunchWorkRequest.runId?` field vs an injected id factory) — settle in 5b; the property (route knows the runId before work starts, registers PENDING) is fixed.
- The exact `promptBuilder` injection shape (a `LaunchWorkRequest.promptBuilder?` vs a `surface==='web'` branch in `executeWorkOnHeldSlot`) — settle in 5b; the property (no Discord-thread framing for web) is fixed.
- Idempotency key storage shape (in-memory bounded map) and retention window — in-memory bounded is acceptable for v1.
- The queued-launch response detail (202 with queued metadata vs 202 with just the PENDING runId) — settle in 5b; must not be a 404/500 and must carry the runId.

## Implementation Units

- [x] **Unit 5a: Scoped operator repo-list route (`GET /operator/repos`)**

  **Goal:** An authenticated operator can list the repos they may launch work in, scoped so they cannot enumerate unrelated repositories.

  **Requirements:** R1, R18, R19, R12, R17

  **Dependencies:** operator auth/guard (shipped), bindings store, denylist cache, repo-authz, session token (3h).

  **Files:**
  - Create: `packages/gateway/src/operator-contract/repo-summary.ts` (the `RepoSummary` DTO + pure builder)
  - Create: `packages/gateway/src/operator-contract/repo-summary.test.ts`
  - Modify: `packages/gateway/src/operator-contract/index.ts` (barrel export)
  - Modify: `packages/gateway/src/operator-contract/version.ts` (`1.1.0 → 1.2.0`, additive)
  - Create: `packages/gateway/src/web/operator/repos-route.ts` (`buildReposRoute(app, deps)`)
  - Create: `packages/gateway/src/web/operator/repos-route.test.ts`
  - Modify: `packages/gateway/src/web/server.ts` (`OperatorServerDeps` if needed; register the route in `buildOperatorApp`)
  - Modify: `packages/gateway/src/http/ingress-pin.test.ts` (add `GET /operator/repos` to the pinned inventory)

  **Approach:**
  - `RepoSummary` exposes display-safe fields only: `{owner, repo}` (+ optional `channelName`). Never deny-keys, workspacePath, channelId, or internal IDs. Pure builder from a `RepoBinding`.
  - Route: auth context → resolve operator token → `listBindings()` → **`filterDeniedRecords()` first** (denylisted repos never appear) → for each surviving binding, `checkRepoAuthz(operatorId, owner, repo, token, deps)` → keep authorized → map to `RepoSummary[]`. Bound the number of authz checks (cap the list / page) and document the cost.
  - Failures are coarse: a store error or token-missing returns a clean error without leaking which repos exist; per-repo authz failures simply omit the repo (not an error).
  - Structured logging: operator id, count returned, any store/authz error — no repo enumeration leak to the client beyond the scoped result.

  **Patterns to follow:** `session-info-route.ts`/`run-stream-route.ts` route-builder + `registerOperatorRoute`; `surface-gate.ts` `filterDeniedRecords`; the contract DTO+builder pattern in `run-status.ts`.

  **Test scenarios:**
  - Happy path: operator with access to 2 of 4 bound repos gets exactly those 2 as `RepoSummary` (denylisted/unauthorized omitted).
  - R19 scope: a bound repo the operator has NO GitHub access to is omitted (assert `checkRepoAuthz` gates it out).
  - Redaction: a denylisted bound repo never appears AND `checkRepoAuthz`/`getBindingByRepo` is not called for it (filter-before-query).
  - Edge: zero bound repos / zero authorized repos → empty list (200, `[]`), not an error.
  - Error: a `listBindings` store error → coarse error response, no partial leak; logged.
  - Security: response carries no deny-keys, workspacePath, channelId, or token; assert the serialized shape.
  - Contract: the response items match `RepoSummary`; `OPERATOR_CONTRACT_VERSION` is `1.2.0`.
  - Ingress pin: `GET /operator/repos` is in the operator route inventory.

  **Verification:** An operator sees only denylist-cleared repos they can actually access; the route leaks no internal binding fields; the contract version bumped additively.

- [x] **Unit 5b: Web sinks + launch route (`POST /operator/runs`)**

  **Goal:** An authenticated operator launches work in a chosen repo through `launchWork`, recorded as `surface: 'web'` and attributed to their GitHub identity; the route returns `202 {runId}` immediately (fire-and-return) for the operator to observe via SSE.

  > This unit may split into 5b-i (engine seams: `LaunchWorkRequest.runId?` + auto-deny approval factory + injectable `promptBuilder`) and 5b-ii (web sinks + the route) if the engine changes land cleaner as their own commit. Keep the route thin; sink/engine policy lives in the seam.

  **Requirements:** R1, R6, R10, R12, R14, R17 (+ R3-equivalent CSRF/rate-limit)

  **Dependencies:** Unit 5a (repo selection); `launchWork` (shipped, needs the runId + approval + prompt seams below); the run index (3i, `register`/`lookup`); the SSE route (#962) for observation.

  **Files:**
  - Modify: `packages/gateway/src/execute/launch-types.ts` (add `runId?`, a web auto-deny `createApprovalOnPending` helper or doc, and `promptBuilder?` to `LaunchWorkRequest`)
  - Modify: `packages/gateway/src/execute/run.ts` (honor caller `runId`; use injected `promptBuilder` instead of unconditional `buildDiscordPrompt`)
  - Create: `packages/gateway/src/web/operator/web-sinks.ts` (minimal web `StatusSink` + `ReplySink`)
  - Create: `packages/gateway/src/web/operator/web-sinks.test.ts`
  - Create: `packages/gateway/src/web/operator/web-approval.ts` (the auto-deny `createApprovalOnPending` for web v1) + test
  - Create: `packages/gateway/src/web/operator/launch-route.ts` (`buildLaunchRoute(app, deps)`)
  - Create: `packages/gateway/src/web/operator/launch-route.test.ts`
  - Create: `packages/gateway/src/web/operator/idempotency.ts` (+ test) — per-operator-namespaced bounded idempotency guard
  - Modify: `packages/gateway/src/web/server.ts` (deps + register the route in `buildOperatorApp`; ensure CSRF/Origin middleware covers it)
  - Modify: `packages/gateway/src/http/ingress-pin.test.ts` (add `POST /operator/runs`)

  **Approach:**
  - **Engine seams first (P0/P1):** add `runId?` to `LaunchWorkRequest` so the route owns the id; `executeWorkOnHeldSlot` uses it instead of generating its own (`run.ts:336`). Add an injectable `promptBuilder?`; when present (web), use it instead of `buildDiscordPrompt` so the agent gets no Discord-thread framing. The web launch always supplies a `createApprovalOnPending` that **auto-denies** (so the engine never falls through to the Discord approval transport).
  - **Web sinks:** minimal `StatusSink`/`ReplySink` — best-effort/no-op for transport UX (typing/reactions/source acks). They do NOT drive observation; the engine's `transitionRun → runObserver.observe` lifecycle hook already feeds the #962 SSE path. No raw output returned inline.
  - **Launch route (fire-and-return):** CSRF/Origin middleware (it's a write) → auth context → operator rate-limit check (3/min, 10/hr, operator-keyed) → resolve operator token → parse body `{repo: 'owner/repo', prompt, idempotencyKey?}` → **server-owned** `getBindingByRepo(owner, repo)` (unbound/unknown → coarse pre-launch error per R10) → denylist-check → `checkRepoAuthz` (unauthorized → coarse 404) → empty-prompt fail-fast → **per-operator idempotency guard** (`${githubUserId}:${key}`; duplicate → echo the prior runId, no double-launch) → **generate `runId`, register a PENDING run-index entry** → build `LaunchWorkRequest` (`surface:'web'`, `requester:{kind:'web-operator', ...operatorIdentity}`, the caller `runId`, opaque `web:<owner>/<repo>` channelId, web sinks, web auto-deny `createApprovalOnPending`, web `promptBuilder`, no `threadFactory`) → **fire `launchWork(request, deps)` WITHOUT awaiting** (`.catch` logs) → return `202 {runId}` immediately.
  - Coarse errors + structured logs throughout; no token/prompt/path/internal-id in responses or logs.

  **Execution note:** Test-first for (a) the fire-and-return contract (the response returns immediately, NOT after the run), (b) the auto-deny-no-deadlock property, and (c) the per-operator idempotency isolation — the load-bearing correctness/security behaviors. Mirror the SSE route's test discipline.

  **Patterns to follow:** `run-stream-route.ts` gate ordering / coarse-error / structured-logging; `runMention` as the transport-neutral adapter reference (web sinks, not Discord); `launch-types.ts` `LaunchWorkRequest` doc + the documented web `createApprovalOnPending` example for the field shapes.

  **Test scenarios:**
  - **P0 fire-and-return:** with a `launchWork` mock that hangs, the route returns `202 {runId}` in <100ms (NOT after the run); the runId is registered PENDING before launchWork is invoked.
  - **P1 auto-deny:** a web launch whose run hits a tool-approval gate auto-denies immediately and does NOT hold the repo lock / fall through to the Discord transport (assert the web `createApprovalOnPending` is used and denies; assert no Discord approval path).
  - Happy path: a valid `{repo, prompt}` for an authorized, bound, non-denylisted repo fires `launchWork` once with `surface:'web'`, the web-operator requester, the caller runId, the web prompt builder, and the auto-deny approval factory; returns `202 {runId}`.
  - Queued case: when the channel slot is busy/full, the route still returns `202` with the runId (or a queued ack carrying it) — never 404/500, never a missing runId.
  - R10 unbound: unknown/unbound repo → coarse pre-launch error, `launchWork` NOT called.
  - R19/authz: a bound repo the operator can't access → coarse 404, `launchWork` NOT called.
  - Redaction: a denylisted repo → coarse 404, no launch, filter-before-authz.
  - R10 empty prompt: empty/whitespace → fail-fast error, no launch.
  - **Idempotency isolation (security):** operator A's key does NOT suppress operator B's launch with the same client key (two runIds); the same operator+key twice echoes one runId (`launchWork` fired once).
  - CSRF: a request failing Origin/Fetch-Metadata is rejected before any launch.
  - Rate limit: an operator exceeding 3/min (or 10/hr) is throttled; the limit is operator-keyed (not per-repo).
  - Prompt: the web run uses the web `promptBuilder` (no Discord-thread guidance) — assert `buildDiscordPrompt` is not applied for `surface:'web'`.
  - Security: response/log carry no token, prompt body, workspacePath, or internal IDs; only the runId (+ coarse status).
  - Server-owned: a client-supplied binding/path/owner is ignored; resolution only via `getBindingByRepo`.
  - Ingress pin: `POST /operator/runs` is in the inventory.

  **Verification:** A web operator launches through the same engine Discord uses, scoped/attributed/rate-limited, returning immediately with a runId; tool gates auto-deny without deadlock; no double-launch across operators; no secret leakage; the run is observable via #962.

## System-Wide Impact

- **Interaction graph:** the launch route is a new caller of `launchWork`; it must not bypass the queue/cap/lock. The web sinks become a new reader/writer of the run-state/observation path the SSE route already consumes.
- **API surface parity:** two new `/operator/*` routes join the ingress pin; the operator contract gains `RepoSummary` (`1.2.0`).
- **Error propagation:** pre-launch failures are coarse to the client, structured in logs; engine-level failures follow `launchWork`'s existing path.
- **Engine changes (NOT unchanged):** `LaunchWorkRequest` gains optional `runId`/`promptBuilder`/web-approval seams and `executeWorkOnHeldSlot` honors them — additive and optional, so the Discord path (`runMention`) is byte-behavior-identical when they're absent. Pin Discord-path regression tests. The approval registry and the SSE route are unchanged. No weakening of the ingress-pin boundary (new routes added deliberately + tested).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Per-repo `checkRepoAuthz` on the list route is N GitHub calls on cold cache | Bound the list size; the authz cache (5m) + coalescing amortizes; document the cost; page if N grows. |
| **A web launch hits a tool-approval gate with no web approval transport (Unit 6)** | **Auto-deny** via a web `createApprovalOnPending` (decided) — fail-fast, no lock hold, no Discord fallback. Tested. Unit 6 ships interactive web approval. |
| **`await launchWork` would hang the HTTP connection for the whole run (P0)** | Fire-and-return: route generates+registers the runId, fires launchWork un-awaited, returns 202 immediately. Tested with a hanging mock. |
| Web run gets Discord-thread prompt framing (P1) | Injectable `promptBuilder`; web builder omits Discord framing. Tested `surface:'web'` skips `buildDiscordPrompt`. |
| Cross-operator idempotency-key suppression | Per-operator-namespaced key (`${githubUserId}:${key}`). Tested A-can't-suppress-B. |
| First write route lacks CSRF / unbounded launch flood | CSRF/Origin middleware + operator-keyed rate limit (3/min, 10/hr). Tested. |
| Synthetic `channelId` collides with a real Discord channel id | Namespaced opaque `web:<owner>/<repo>` key that cannot equal a snowflake; never a client field. Tested. Known tradeoff: per-repo serialization across operators (documented). |
| Client-supplied repo/path trusted → wrong-repo launch | Server-owned resolution via `getBindingByRepo` only; ignore any client binding/path; tested. |
| Double-submit starts two runs | Idempotency guard; test exactly-once. |

## Documentation / Operational Notes

- `deploy/README.md` / operator docs: note the two new operator routes and the `1.2.0` contract version once shipped.
- After merge, update `fro-bot/dashboard#63`-adjacent consumer docs (or a sibling issue) with the launch + repo-list contract so the dashboard can build the picker + launch form.

## Document Review Findings (2026-06-20 — RESOLVED, folded into the units/decisions above)

A 5-reviewer document-review (security/feasibility/coherence/scope/adversarial) found real issues. All are now folded into Key Technical Decisions, Open Questions, Unit 5b, and Risks above (the P0 `launchWork`-awaits-whole-run was independently verified against `run.ts:882`). Retained as the audit trail.

- **P0 (feasibility + adversarial, verified vs source):** `launchWork(request, deps)` returns `Promise<void>` and **awaits the entire run** (`run.ts:882` `await executeWorkOnHeldSlot`). The plan's `await launchWork(...)` then "read the runId back" is broken — the HTTP connection would hang for the whole run (minutes), and the runId is generated *inside* (`run.ts:336`) and registered later (`:389`). **Required redesign:** generate the runId in the route, register a PENDING run-index entry, call launchWork WITHOUT awaiting (fire-and-return), return 202 `{runId}` immediately. Also handle the QUEUED case (no slot → no runId yet) — return a queued ack. Add a test asserting the response returns <100ms, not after execution.
- **P1 (security + adversarial + scope, verified):** the tool-approval-gate interim behavior must be DECIDED now, not deferred. With no web approval transport (Unit 6), `createApprovalOnPending` absent → engine **defaults to the Discord approval transport** (`run.ts:527-557`), which posts to a non-existent thread (`approvalScopeId: ''`), is un-approvable on any surface, and **holds the repo lock until the ~13m deadline — blocking ALL runs in that repo**. Decision needed: `surface:'web'` + no web approval transport → **auto-deny tool approvals (fail-fast, no lock hold)**, NOT fall through to Discord. Pin with a test.
- **P1 (adversarial, verified):** "launchWork is transport-neutral" is partly false — `executeWorkOnHeldSlot` unconditionally calls `buildDiscordPrompt` (`run.ts:469`) injecting `DISCORD_MECHANICAL_GUIDANCE` ("You are responding in a Discord thread"). A web run gets Discord-flavored instructions. **Fix:** make prompt construction injectable (a `promptBuilder?` on `LaunchWorkRequest`) or skip `buildDiscordPrompt` when `surface==='web'`.
- **P1 (security + adversarial):** idempotency key must be **namespaced per operator** (`${githubUserId}:${clientKey}`) or operator A can replay operator B's key to suppress B's launch (cross-operator poisoning). Define omitted-key behavior + bounded retention.
- **P1 (security):** `POST /operator/runs` is the first WRITE route — the plan must explicitly require **CSRF/Origin/Fetch-Metadata enforcement** (it's a state-changing request) and **carry forward the parent plan's launch rate limits (3/min, 10/hr, operator-keyed)** — the synthetic per-repo channelId does NOT cap an operator across many repos.
- **P2 (security + coherence):** pin **uniform failure shape/timing** (no-oracle) on the repo-list route — store-error vs unauthorized vs denylisted must not be distinguishable. (Adversarial notes a residual timing oracle via the authz cache — acceptable v1 for an authenticated-only route, but document it.)
- **P2 (security/scope):** tighten the no-secret constraint — `RepoSummary` must forbid workspacePath/channelId/deny-keys/internal IDs in BOTH response and logs; confirm `channelName` is display-only.
- **P2 (scope + coherence):** `R6` "same queue" vs synthetic channelId — reword to "same engine + queueing rules, web-derived queue key." Document the cross-operator per-repo queue starvation as a known v1 tradeoff.
- **P2 (scope):** keep 5a a minimal picker slice — a hard cap + truncated-list contract, NOT pagination machinery; no general bindings API. Consider splitting 5b (web sinks vs launch route).
- **P2 (feasibility, verified):** web sinks do NOT directly feed the observation manager — observation is driven by engine `transitionRun` → `runObserver.observe` (`run.ts:400`), not by sink writes. Correct the plan's "sinks record into the observation path" wording.
- **P3 (adversarial):** R10 "disabled repo" is unsatisfiable — `RepoBinding` has no disabled field. Honest gap; file a follow-up for an enabled/disabled binding field (the only current lever to stop web launches in a repo is destructive unbinding).

## Sources & References

- **Parent plan:** `docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md` (Unit 5).
- Engine seam: `packages/gateway/src/execute/launch-types.ts` (`LaunchWorkRequest` web derivation), `packages/gateway/src/execute/run.ts` (`launchWork`).
- Scoping: `packages/gateway/src/bindings/store.ts`, `packages/gateway/src/web/auth/repo-authz.ts`, `packages/gateway/src/redaction/surface-gate.ts`.
- Route discipline: `packages/gateway/src/web/sse/run-stream-route.ts` (#962), `packages/gateway/src/web/auth/session-info-route.ts`.
- Contract: `packages/gateway/src/operator-contract/` (`version.ts`, `run-status.ts`).
