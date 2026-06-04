---
title: 'fix: workspace-agent OpenCode supervisor readiness + gateway readiness gate'
type: fix
status: active
date: 2026-06-03
deepened: 2026-06-03
---

# fix: workspace-agent OpenCode supervisor readiness + gateway readiness gate

## Overview

On v0.52.1 the deployed gateway can clone repos (`/fro-bot add-project`) but the `@fro-bot` mention loop is
non-functional: the supervised `opencode serve` inside the workspace container fails to become ready within a
hardcoded 15s, the supervisor kills it and never respawns, and `/healthz` reports `starting`/`ok` forever — so the
gateway keeps routing mention runs to a workspace whose OpenCode is permanently dead. This plan fixes the supervisor
brittleness and closes the loop with a gateway-side readiness gate, delivered as three independently reviewable PRs
sequenced so the **first PR unblocks the common cold-boot-slowness case** (the reported failure), with PR 2 adding the gateway liveness gate and PR 3 adding transient-failure recovery.

Source: issue #749 (reproduced on a live v0.52.1 deployment) + Fro Bot triage (four defects confirmed against source at
`af529e2`) + Oracle source-level assessment.

## Problem Frame

The workspace-agent (`apps/workspace-agent/`) is the supervisor inside the sandboxed workspace container. It spawns
`opencode serve` (loopback `127.0.0.1:54321`), and exposes a clone/health API (`:9100`) and a bearer-token OpenCode
proxy (`:9200`). The Discord mention loop in `packages/gateway/` remotely attaches to that OpenCode server through the
proxy to execute agent turns.

Four compounding defects make the mention loop fail on cold boot:

1. **Hardcoded 15s readiness timeout, no override.** `opencode-server.ts` defaults `readyTimeoutMs = 15_000`; `main.ts`
   never overrides it and no env var exists. Cold boot behind the egress proxy (mitmproxy CA install + auth
   provisioning + clone + the now-permitted `models.dev` catalog fetch) routinely exceeds 15s; a manual
   `opencode serve` in the same container becomes ready in ~10s, so OpenCode itself is healthy — the supervisor is the
   problem.
2. **Readiness probe has no per-attempt timeout.** `defaultPollReady(url, signal)` does `await fetch(url, {signal})`
   with `signal === undefined` in production. A readiness connect that is accepted but never responds hangs the await;
   the deadline loop only checks the outer deadline *between* probes, so status sits in `starting` forever (never
   `ready`, never `down`).
3. **One-shot, no respawn.** `main.ts` does `.catch(() => { opencodeStatus.status = 'down' })`. A single transient
   cold-boot overrun permanently disables the mention loop until the container is recreated. The SIGTERM-on-timeout
   kills only the direct child PID (not the process group), so orphaned children can survive.
4. **`/healthz` masks a dead OpenCode.** It returns HTTP 200 regardless of OpenCode liveness, so the gateway has no
   signal to stop routing mention runs to a dead workspace.

## Requirements Trace

- **R1.** A hung readiness probe must not be able to leave the supervisor in `starting` forever (defect 2).
- **R2.** The readiness timeout must be operator-configurable and default to a realistic cold-boot value (defect 1).
- **R3.** The smallest correct change must let an operator redeploy and have the mention loop work when the only
  blocker is cold boot exceeding 15s (deployment unblock).
- **R4.** OpenCode liveness must be observable to the gateway via a dedicated readiness signal that does not break
  clone-only liveness (defect 4, workspace half).
- **R5.** The gateway must not route a mention run (create a thread, acquire a lock, create run-state, attach) to a
  workspace whose OpenCode is not ready; it must reply with a coarse "workspace unavailable" message instead (defect 4,
  gateway half).
- **R6.** A transient startup failure must not permanently disable the mention loop — the supervisor must respawn with
  bounded backoff before giving up (defect 3).
- **R7.** On timeout/respawn the supervisor must not leak orphaned OpenCode child processes, and must preserve the
  loopback-only bind and no-secret-logging invariants (defect 3, process-group half).
- **R8.** Invalid `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` must fail fast at startup (malformed config = fail-fast); an
  absent value falls back to the default (fail-soft).

## Scope Boundaries

- Not changing the readiness *definition* from "OpenCode HTTP server answers" to process-up/port-accepting or a
  session-create probe — readiness must continue to prove the HTTP stack is usable, and a session-create probe would
  create junk OpenCode sessions.
- Not attempting transparent session migration across an OpenCode respawn — an in-flight mention run that is attached
  when OpenCode restarts fails cleanly with a surfaced error; it is not silently migrated.
- Not introducing Effect into `apps/workspace-agent/` — Effect remains gateway-only per `packages/gateway/AGENTS.md`.

### Deferred to Separate Tasks

- **Gateway SDK call signal plumbing**: `runOpenCodeCore` checks `signal` during stream iteration but does not pass it
  into `session.create` / `event.subscribe` / `promptAsync` — the same accept-but-stall hang class as the probe bug.
  Deferred to a follow-up hardening PR (file a tracking issue): bound those calls with the run signal/timeouts.
- **`opencode-proxy.ts` upstream request timeout**: the proxy forwards via `http.request()` with no upstream timeout,
  so a stalled upstream can hang gateway calls. Deferred to the same hardening follow-up. Must not apply a short total
  timeout to SSE event streams (only to non-stream HTTP).

## Context & Research

### Relevant Code and Patterns

- `apps/workspace-agent/src/opencode-server.ts` — `startOpencodeServer(options)`, `defaultPollReady(url, signal?)`,
  `SpawnFn`/`PollReadyFn` DI seams, deadline-based readiness loop, SIGTERM-on-timeout. `defaultPollReady` treats any
  HTTP response (`res.status > 0`) as ready. Security invariants are codified in top-of-file comments (loopback-only,
  no token logging, no crash-loop). Status is modeled via the returned handle + a caller-owned mutable ref, not
  internal global state.
- `apps/workspace-agent/src/main.ts` — module-level `opencodeStatus = {status: 'starting' | 'ready' | 'down'}`,
  fire-and-forget boot (`startOpencodeServer(...).then(...).catch(...)`), one-shot `.catch`. `createApp({opencodeStatus})`
  shares readiness state with the health endpoint. Reads secrets via `./config.js` (`readSecret`).
- `apps/workspace-agent/src/server.ts` + `types.ts` — Hono app factory `createApp(deps)`, `/healthz` is the only status
  endpoint (no `/readyz`), `HealthzResponse` already carries the `opencode` field, `opencodeStatus` shared by reference.
- `apps/workspace-agent/src/opencode-server.test.ts` — Vitest + BDD comments (`#given/#when/#then`); `spawnFn` injected
  via `makeSpawnFn(...)`, `pollReadyFn` injected directly (`alwaysReady`/`neverReady`/`readyAfter(n)`); fake child is an
  `EventEmitter` with `kill()`/`on()`; **real timers** with `pollIntervalMs: 0` (not fake timers); aborts tested with
  `AbortController`; asserts SIGTERM on timeout/close.
- `apps/workspace-agent/src/config.ts` — workspace-agent secret reader, `${NAME}_FILE` precedence, file hardening, no
  secret logging. No positive-integer parse helper exists (inline parse pattern).
- `apps/workspace-agent/src/opencode-proxy.ts` — Node `http.createServer`, bearer auth via `timingSafeEqual`, Authorization
  stripped before forwarding, SSE preserved via direct `pipe` (no buffering). No upstream timeout.
- `packages/gateway/src/discord/mentions.ts` — `handleMention` is a thin router: thread guard → mention guard → auth
  (`guild.members.fetch()`, fail-closed) → binding lookup → `runMention(...)`. `safeReply()` always uses
  `allowedMentions: {parse: []}`.
- `packages/gateway/src/execute/run.ts` — `runMention(...)` creates the Discord thread first, then acquires lock /
  run-state, then attaches OpenCode (`attachOpencode`), then `runOpenCodeCore(..., signal=AbortSignal.timeout(...))`;
  release/cleanup is `finally`-guarded.
- `packages/gateway/src/execute/run-core.ts` — `runOpenCodeCore` owns session create / event subscribe / prompt / SSE;
  receives `signal` and checks it during stream iteration; all SDK calls carry `query: {directory}`.
- `packages/gateway/src/workspace-api/{client.ts,types.ts}` — typed `WorkspaceClient` with mirrored request/response
  types already exists; `clone(request)` returns `Result<CloneSuccess, WorkspaceError>`. This is the seam a readiness
  method extends.
- `packages/gateway/src/config.ts` — `loadGatewayConfig()` centralizes env/secret parsing, fail-fast with explicit
  messages, `${NAME}_FILE` precedence. Positive-int parsing is inline (no shared helper). Default
  `workspaceOpencodeUrl = http://workspace:9200`.

### Institutional Learnings

- `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md` — remote attach is HTTP+SSE
  with auth forwarded; **flush buffered output before the coarse error**; use `AbortSignal.timeout`, nested `finally`,
  ownership-checked lock release; don't let EOF/timeout masquerade as success.
- `docs/solutions/best-practices/workspace-executor-opencode-provisioning-best-practices-2026-06-01.md` — "server is up"
  is **not** readiness; treat **absent config fail-soft, malformed config fail-fast** (directly informs R8).
- `docs/solutions/code-quality/architectural-issues-type-safety-and-resource-cleanup.md` — use **nested `finally`** for
  shutdown/cleanup; don't assume SDK ordering. The anti-footgun for a supervisor that must always reap children.
- `docs/solutions/build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md` — host-checkout tests lie;
  the existing `Workspace Image Smoke Test` is the real boot proof for supervisor/readiness changes.
- `docs/solutions/best-practices/discord-slash-command-orchestration-patterns-2026-05-27.md` — a factory-based
  supervisor can still be broken at the real entrypoint; wire and test the actual bootstrap path.

## Key Technical Decisions

- **Per-probe AbortController composed with the caller signal** (R1): each readiness attempt gets its own short
  deadline (default ~3s) so a stalled connect can't wedge the loop; abort from the caller signal still propagates.
  Mirrors the existing `AbortController` test pattern.
- **`WORKSPACE_OPENCODE_READY_TIMEOUT_MS`, default 60s** (R2/R8): read in `main.ts`, validated as a positive integer
  with fail-fast on malformed input, fall back to 60s when absent. 60s covers cold boot behind the egress proxy with a
  model-catalog fetch; Oracle confirmed 60s over 120s as the right default.
- **Keep readiness = "HTTP answers"** (scope): do not weaken to port-accepting or strengthen to session-create.
- **`/readyz` + gateway gate ship together as one PR** (R4/R5): a workspace `/readyz` has zero operational value until
  the gateway consumes it. Splitting them would let the plan claim defect 4 is fixed while mention runs still route to
  dead workspaces.
- **Gate placement: in `handleMention` after binding lookup, before `runMention`** (R5): so a not-ready workspace never
  causes a thread, lock, or run-state to be created — just a coarse in-channel reply. Keeps the expensive lifecycle off
  the dead-workspace path.
- **`/healthz` stays always-200; `/readyz` carries OpenCode liveness** (R4): clone-only liveness must not regress; only
  the new endpoint gates on `opencode === 'ready'`.
- **Explicit supervisor state machine for respawn** (R6): on respawn, set status to a not-ready value (reuse the existing
  `starting`) BEFORE killing the child, so `/readyz` fails closed during the kill→respawn transition and can never report
  `ready` after shutdown of the current child has begun. Add `degraded` only if retries-exhausted needs distinct routing
  semantics from `down` (see Open Question).
- **`detached: true` + `kill(-pid, 'SIGTERM')` with `child.kill()` fallback** (R7): reap the whole process group on
  timeout/respawn; preserve loopback-only bind and no-secret-logging. Negative-PID kill only when `child.pid` is a
  number.
- **Per-attempt readiness deadline reset** (R6): each respawn attempt gets a fresh readiness deadline and probe timers;
  the global budget is not carried across attempts (unless a total-boot-budget cap is later desired).

## Open Questions

### Resolved During Planning

- Default readiness timeout value → **60s** (Oracle; issue suggested 60–120s).
- Invalid env value handling → **fail-fast at startup** (learnings: malformed config = fail-fast).
- Readiness strategy → **keep "any HTTP response"**; do not switch to port-accepting or session-create probe.
- PR structure → **3 PRs**; `/readyz` + gateway gate are one PR, not split.
- Where `apps/workspace-agent/AGENTS.md` documents the new env var → **it doesn't exist yet; PR 1 creates it.**
- `degraded` vs `down` → introduce `degraded` only in PR 3, only because retries-exhausted-but-clone-alive is a
  distinct routing state from `down`.

### Deferred to Implementation

- Exact backoff schedule and max attempts for respawn (PR 3) — choose during implementation against the real boot
  profile; capped exponential, a few attempts, then `degraded`.
- Whether the gateway readiness gate also short-circuits an in-flight run when the workspace transitions to not-ready
  mid-run — out of scope for PR 2; covered conceptually by the in-flight-restart risk below.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The
> implementing agent should treat it as context, not code to reproduce.*

Supervisor readiness/respawn state machine (PR 1 fixes the probe + timeout; PR 3 adds respawn/`degraded` — reuses `starting` for the respawn transition):

```
            ┌─────────┐  probe HTTP-200 within per-attempt deadline   ┌────────┐
  spawn ───▶│starting │ ─────────────────────────────────────────────▶│ ready  │
            └─────────┘                                                └────────┘
   │ per-attempt deadline hit (per-probe timeout caps a hung probe)
                  ▼
           kill process group (SIGTERM, negative-PID)
                  │
                  ▼
   ┌──────────────────────────┐  attempts remain   ┌────────────┐ (PR3)
   │ backoff (capped exp)      │ ─────────────────▶ │  starting  │──▶ starting
   └──────────────────────────┘                     └────────────┘                 │ attempts exhausted
                 ▼
             ┌──────────┐   clone API (:9100) stays alive; /healthz still 200
             │ degraded │   /readyz returns non-200 ─▶ gateway gate rejects mentions
             └──────────┘   (see Open Question — may collapse to `down`)```

Gateway dispatch gate (PR 2):

```
handleMention: thread guard → mention guard → auth → binding lookup
                                                          │
                                       ┌──────────────────┴──────────────────┐
                                       ▼                                      ▼
                          workspaceClient.readyz() == ready?         not ready / error
                                       │ yes                                  │
                                       ▼                                      ▼
                                  runMention(...)                  safeReply("workspace unavailable")
                              (thread, lock, attach)               (no thread, no lock, no run-state)
```

## Implementation Units

### Phase 1 — PR 1: deployment unblock (supervisor startup readiness)

- [ ] **Unit 1: Per-probe readiness timeout in `defaultPollReady`**

**Goal:** A hung readiness connect can no longer stall the supervisor in `starting` forever.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `apps/workspace-agent/src/opencode-server.ts`
- Test: `apps/workspace-agent/src/opencode-server.test.ts`

**Approach:**
- Give each `defaultPollReady` attempt its own `AbortController` with a short timeout (~3s), composed with any caller
  `signal` so external abort still propagates. On per-probe timeout, treat the attempt as "not ready yet" and return to
  the deadline loop so the outer `readyTimeoutMs` is honored.
- Preserve the "any HTTP response (`res.status > 0`) = ready" contract.

**Execution note:** Test-first — add a failing test proving a hung probe times out and the loop progresses, before the fix.

**Patterns to follow:** existing `AbortController` usage and `neverReady`/`readyAfter(n)` injected poll helpers in
`opencode-server.test.ts`; real timers with `pollIntervalMs: 0`.

**Test scenarios:**
- Happy path: a probe that resolves HTTP 200 immediately → readiness returns `ready`.
- Edge case: a probe that hangs past the per-probe timeout on the first attempt but succeeds on a later attempt →
  overall readiness still resolves `ready` within `readyTimeoutMs` (proves the per-probe timeout unblocks the loop).
- Error path: every probe hangs past the per-probe timeout → overall readiness fails at `readyTimeoutMs` and the child
  is SIGTERM'd (proves no permanent `starting`).
- Edge case: caller `signal` aborts mid-probe → the composed signal cancels the in-flight fetch and readiness rejects
  via abort (proves caller-abort still propagates through the per-probe controller).

**Verification:** the stuck-probe test fails before the change and passes after; no test relies on fake timers; SIGTERM
assertion on total-timeout still holds.

- [ ] **Unit 2: Configurable readiness timeout via `WORKSPACE_OPENCODE_READY_TIMEOUT_MS`**

**Goal:** Operators can raise the readiness timeout; the default becomes a realistic 60s cold-boot value.

**Requirements:** R2, R3, R8

**Dependencies:** Unit 1

**Files:**
- Modify: `apps/workspace-agent/src/opencode-server.ts` (raise default `readyTimeoutMs` to 60_000)
- Modify: `apps/workspace-agent/src/main.ts` (read + pass the env value)
- Modify: `apps/workspace-agent/src/config.ts` (parse/validate positive integer, fail-fast on malformed)
- Modify: `deploy/README.md` (document `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` — required operator-facing doc)
- Create (optional): `apps/workspace-agent/AGENTS.md` (supervisor invariants + env var; optional — only if the repo's per-package AGENTS.md convention is being extended here)
- Test: `apps/workspace-agent/src/config.test.ts` (or the existing config test file if present; otherwise colocate)

**Approach:**
- Add a positive-integer parser for `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` to the workspace-agent config module
  (inline parse mirroring the gateway pattern — no shared helper exists). Absent → 60s (fail-soft); present-but-invalid
  (non-numeric, ≤ 0) → throw at startup (fail-fast).
- Thread the resolved value from `main.ts` into `startOpencodeServer({ readyTimeoutMs })`.
- Document `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` (default 60s, fail-fast on malformed) in `deploy/README.md` (required).
- Optionally create `apps/workspace-agent/AGENTS.md` for supervisor invariants (loopback-only, no-secret-logging,
  process-group reaping) if extending the per-package AGENTS.md convention.

**Execution note:** Test-first for the parser's valid/invalid/absent branches.

**Patterns to follow:** `apps/workspace-agent/src/config.ts` secret-reader structure; `packages/gateway/src/config.ts`
inline positive-int parse + fail-fast error messages.

**Test scenarios:**
- Happy path: `WORKSPACE_OPENCODE_READY_TIMEOUT_MS=90000` → parsed as `90000` and passed to `startOpencodeServer`.
- Edge case: variable absent → default `60000` used (fail-soft).
- Error path: `WORKSPACE_OPENCODE_READY_TIMEOUT_MS=abc` → startup throws with an explicit message (fail-fast).
- Error path: `WORKSPACE_OPENCODE_READY_TIMEOUT_MS=0` (and negative) → startup throws (positive-integer constraint).
- Integration: `main.ts` boot wiring passes the resolved timeout into the supervisor (assert via the injected
  `startOpencodeServer` seam, mirroring existing bootstrap-wiring tests).

**Verification:** invalid values fail container startup loudly; a deployment that sets 60–90s no longer fails the cold
boot; `deploy/README.md` documents the variable.

### Phase 2 — PR 2: readiness contract + gateway gate

- [ ] **Unit 3: workspace-agent `/readyz` endpoint**

**Goal:** Expose OpenCode liveness as a dedicated readiness signal without regressing clone-only liveness.

**Requirements:** R4

**Dependencies:** Phase 1 (status semantics finalized)

**Files:**
- Modify: `apps/workspace-agent/src/server.ts` (register `/readyz`)
- Modify: `apps/workspace-agent/src/types.ts` (`ReadyzResponse` type)
- Test: `apps/workspace-agent/src/server.test.ts`

**Approach:**
- Add `GET /readyz` returning HTTP 200 only when `opencodeStatus.status === 'ready'`; return non-200 (e.g. 503) for
  any non-`ready` status (`starting`, `down`, and `degraded` if added) — fails closed during the respawn transition
  since respawn sets `starting` before kill. `/healthz` stays always-200 for container/clone liveness.
- Body carries the `opencode` status string for observability (no secrets).
- Network posture: `/readyz` is served by the same `:9100` Hono app as `/healthz` (sandbox-net reachable, unauthenticated
  like `/healthz`) — it is an internal control-plane signal for the gateway on the sandbox network, not exposed beyond it.
  It carries only the status string, no secrets.

**Patterns to follow:** existing Hono `app.get('/healthz', ...)` handler and `HealthzResponse` shape; shared
`opencodeStatus` ref via `ServerDeps`.

**Test scenarios:**
- Happy path: `status: 'ready'` → `/readyz` returns 200.
- Edge case: `status: 'starting'` → `/readyz` returns 503.
- Edge case: `status: 'down'` → `/readyz` returns 503.
- Invariant: `/healthz` returns 200 in all of the above (clone-only liveness unaffected).

**Verification:** `/readyz` flips with OpenCode status while `/healthz` stays 200.

- [ ] **Unit 4: Gateway readiness gate before mention dispatch**

**Goal:** The gateway refuses to route a mention run to a not-ready workspace, replying with a coarse message instead
of creating a thread/lock/run-state.

**Requirements:** R5

**Dependencies:** Unit 3

**Files:**
- Modify: `packages/gateway/src/workspace-api/client.ts` (add a `readyz()`/`getReadiness()` method)
- Modify: `packages/gateway/src/workspace-api/types.ts` (mirror `ReadyzResponse`)
- Modify: `packages/gateway/src/discord/mentions.ts` (`handleMention`: gate after binding lookup, before `runMention`)
- Modify: `packages/gateway/src/discord/mentions.ts` deps wiring as needed (inject the readiness check into `MentionDeps`/`RunMentionDeps`)
- Test: `packages/gateway/src/discord/mentions.test.ts`
- Test: `packages/gateway/src/workspace-api/client.test.ts`

**Approach:**
- Extend the existing typed `WorkspaceClient` with a readiness call returning a typed result (ready vs not-ready/error)
  — no new client abstraction.
- In `handleMention`, after the binding lookup and before `runMention`, call the readiness check. If not ready (or the
  check errors / times out), `safeReply` with a coarse "the workspace is not reachable right now" message
  (`allowedMentions: {parse: []}`) and return — do not create a thread, acquire a lock, or create run-state.
- Treat a readiness-check transport error as not-ready (fail-closed for routing), mirroring the auth fail-closed posture.
- TOCTOU handling: a passing readiness probe is not a guarantee. If OpenCode dies between the probe and attach,
  `runMention`'s attach/session-create failure must be caught, any buffered output flushed before the coarse error (per
  the mention-loop flush-before-error learning), and the user gets the same coarse 'workspace unavailable' message rather
  than an unclassified failure.

**Execution note:** Test-first for the gate's ready/not-ready/error branches at the `handleMention` seam.

**Patterns to follow:** `handleMention` thin-router structure and fail-closed auth; `WorkspaceClient.clone` Result
shape; `safeReply` mention-safe replies.

**Test scenarios:**
- Happy path: readiness = ready → `runMention` is invoked (assert the downstream dep is called).
- Error path: readiness = not-ready → `runMention` is NOT invoked, a coarse reply is sent, no thread/lock created.
- Error path: readiness check throws/times out → treated as not-ready (fail-closed), coarse reply, `runMention` not invoked.
- Error path: readiness = ready but attach/session-create then fails (workspace died in the TOCTOU window) → failure is
  caught, partial output flushed, coarse reply sent (not an unclassified crash).
- Integration: the gate sits after binding lookup (a missing binding still short-circuits earlier and never calls readiness).
- Invariant: the coarse reply uses `allowedMentions: {parse: []}`.

**Verification:** with a stubbed not-ready workspace, no thread/lock/run-state is created and the user gets a coarse
message; with ready, dispatch proceeds unchanged.

### Phase 3 — PR 3: supervisor robustness (respawn + process-group reaping)

- [ ] **Unit 5: Retry/respawn with bounded backoff + state machine**

**Goal:** A transient startup failure no longer permanently disables the mention loop.

**Requirements:** R6

**Dependencies:** Phase 1

**Files:**
- Modify: `apps/workspace-agent/src/opencode-server.ts` (supervised respawn loop, state transitions)
- Modify: `apps/workspace-agent/src/main.ts` (replace one-shot `.catch` with supervised lifecycle)
- Modify: `apps/workspace-agent/src/types.ts` (extend status with `degraded` if surfaced; `starting` reused for respawn transition)
- Test: `apps/workspace-agent/src/opencode-server.test.ts`

**Approach:**
- Replace the one-shot boot with a supervised loop: on startup failure, back off (capped exponential, a few attempts),
  reset the readiness deadline and probe timers per attempt, then transition to `degraded` when attempts are exhausted.
- Define explicit transitions: `starting → ready`, `starting → (kill) → starting`, `… → degraded`. Add
  `degraded` only because it has distinct routing semantics (clone API alive, mention routing refused) vs `down`.
- Set status to `starting` (not-ready) before killing the child on each respawn attempt, so `/readyz` fails closed
  during the transition (prevents a stale `ready` read routing a mention into a dying workspace).
- Enforce a hard upper bound: a max respawn-attempt count AND a total boot budget (separate from the per-attempt deadline)
  before transitioning to the terminal not-ready state, so a pathological crash-looping OpenCode cannot keep the supervisor
  retrying indefinitely. This preserves the original 'no crash-loop on spawn failure' invariant.
- Keep status transitions observable (logged, no secrets).

**Execution note:** Test-first for the backoff/exhaustion transitions; real timers with zero/short delays per the
existing convention (avoid fake timers unless deadline math requires them).

**Patterns to follow:** existing deadline-loop + injected `spawnFn`/`pollReadyFn` seams; nested-`finally` cleanup
discipline from the resource-cleanup learning.

**Test scenarios:**
- Happy path: first spawn becomes ready → no respawn, status `ready`.
- Edge case: first spawn fails, second becomes ready → status ends `ready` after one backoff (per-attempt deadline reset
  proven by the second attempt getting a full deadline).
- Error path: all attempts fail → status ends `degraded` (not stuck `starting`, not silently `down`), clone API still
  served.
- Edge case: each respawn attempt resets its readiness deadline (a slow-but-eventually-ready second attempt is not
  killed early by a carried-over deadline).
- Edge case: persistent failure hits the max-attempt cap / total boot budget → supervisor stops retrying and lands in
  the terminal not-ready state (no infinite respawn).

**Verification:** induced transient failure recovers without container recreation; exhausted retries land in `degraded`
and `/readyz` returns non-200.

- [ ] **Unit 6: Process-group reaping on timeout/respawn**

**Goal:** No orphaned OpenCode child survives a timeout/respawn to confuse later `:54321` probes.

**Requirements:** R7

**Dependencies:** Unit 5

**Files:**
- Modify: `apps/workspace-agent/src/opencode-server.ts` (spawn `detached: true`; kill the process group; widen ChildHandle/SpawnFn with pid)
- Test: `apps/workspace-agent/src/opencode-server.test.ts`

**Approach:**
- Prerequisite: the current `ChildHandle`/`SpawnFn` seam in `opencode-server.ts` exposes only `kill`/`on`, not `pid`.
  Widen `ChildHandle` to carry `pid?: number` (and `SpawnFn` to return it) so the negative-PID group kill can be
  implemented and tested against the seam.
- Spawn `opencode serve` with `detached: true` and, on timeout/respawn/shutdown, `process.kill(-pid, 'SIGTERM')` to reap
  the whole group; fall back to `child.kill()` when `child.pid` is not a number.
- Preserve the loopback-only bind and the no-secret-logging invariant; do not add any env/token logging.

**Patterns to follow:** existing SIGTERM-on-timeout assertion in `opencode-server.test.ts`; security-invariant comments
at the top of `opencode-server.ts`.

**Test scenarios:**
- Happy path: timeout kill uses negative-PID group SIGTERM when `child.pid` is a number (assert spawn called with
  `detached: true` and the negative-PID kill).
- Edge case: `child.pid` is undefined → falls back to `child.kill('SIGTERM')` (no negative-PID call).
- Invariant: no token/secret/env value is logged on any kill path; bind remains `127.0.0.1`.

**Verification:** group-kill path is exercised in tests; no orphan-child regression; security invariants intact.

## System-Wide Impact

- **Interaction graph:** `main.ts` boot → `startOpencodeServer` (supervisor) → `opencodeStatus` ref → `/healthz` +
  new `/readyz` → gateway `WorkspaceClient.readyz()` → `handleMention` gate → `runMention`. PR 2 introduces the new
  cross-package readiness edge.
- **Error propagation:** workspace not-ready surfaces as a typed not-ready result → coarse Discord reply (no thread/lock).
  A readiness-check transport error is treated as not-ready (fail-closed). Supervisor exhaustion surfaces as `degraded`
  → `/readyz` 503 → same gate rejection.
- **State lifecycle risks:** per-attempt readiness deadline reset must not carry a stale deadline across respawns;
  process-group kill must not leave orphans; `opencodeStatus` is a shared mutable ref — transitions must be written in
  one place to avoid races between the supervisor loop and the health handler.
- **API surface parity:** `/healthz` semantics unchanged (always 200); `/readyz` is additive. `WorkspaceClient` gains a
  method but `clone` is untouched.
- **Integration coverage:** the `Workspace Image Smoke Test` must continue to prove the image boots and `/healthz`
  responds; extend it (or add coverage) so `/readyz` is exercised against a booted image — host-checkout tests won't
  catch a runtime readiness regression.
- **Unchanged invariants:** loopback-only `:54321` bind, bearer-proxy on `:9200` as the only network-reachable attach
  endpoint, no-secret-logging, gateway auth fail-closed posture, Effect-only-in-gateway — none of these change.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `/readyz` returns 200 then OpenCode dies before attach (gate ≠ guarantee) | Gate improves routing/UX but does not replace robust attach-path error handling; the deferred SDK-signal + proxy-timeout hardening closes the residual hang window. |
| OpenCode restarts (PR 3) while a mention run is attached → SSE closes, run fails | Acceptable for v1: surface a clean failure (flush partial output before the coarse error per the mention-loop learning); no transparent session migration. |
| `detached: true` + negative-PID kill behaves differently across platforms | Container target is Linux; guard negative-PID kill behind a numeric `child.pid` and fall back to `child.kill()`; assert both paths in tests. |
| Raising default to 60s masks a genuinely broken OpenCode for up to 60s | `degraded` + `/readyz` make a terminally-down OpenCode observable; the gate stops routing rather than hanging for 60s per attempt. |
| `degraded`/`down` semantic creep | Only `degraded` is added, and only because it has distinct routing meaning; `down` retained for terminal/unmanaged failure. |
| Shared `opencodeStatus` ref race between supervisor loop and `/readyz` handler | Centralize all transitions in the supervisor; the handler only reads. |

## Documentation / Operational Notes

- Document `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` (default 60s, fail-fast on malformed) in `deploy/README.md` (required).
  Optionally also create `apps/workspace-agent/AGENTS.md` for supervisor invariants (loopback-only, no-secret-logging,
  process-group reaping) if extending the per-package AGENTS.md convention.
- Operators holding on v0.52.1 can redeploy after **PR 1** ships to fix the reported cold-boot-slowness failure (and
  optionally set `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` if 60s is still tight). Note: PR 1 fixes supervisor startup only —
  until PR 2 ships there is no gateway liveness gate, so a genuinely-dead workspace (vs. merely slow) would still receive
  mention runs; until PR 3 ships a startup failure is still one-shot. End-to-end recovery requires all three.
- File a tracking issue for the deferred hardening (gateway SDK call signals + proxy upstream timeout) and reference it
  from this plan.

## Sources & References

- Issue: #749 (v0.52.1 workspace-agent OpenCode supervisor brittle on cold boot)
- Triage: Fro Bot triage comment on #749 (four defects confirmed against `af529e2` / tag `v0.52.1`)
- Oracle source-level assessment (validated diagnosis, 3-PR structure, gateway-gate requirement, risk list)
- Related code: `apps/workspace-agent/src/{opencode-server,main,server,types,config,opencode-proxy}.ts`,
  `packages/gateway/src/{discord/mentions,execute/run,execute/run-core,workspace-api/client,workspace-api/types,config}.ts`
- Learnings: `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md`,
  `docs/solutions/best-practices/workspace-executor-opencode-provisioning-best-practices-2026-06-01.md`,
  `docs/solutions/code-quality/architectural-issues-type-safety-and-resource-cleanup.md`,
  `docs/solutions/build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md`
