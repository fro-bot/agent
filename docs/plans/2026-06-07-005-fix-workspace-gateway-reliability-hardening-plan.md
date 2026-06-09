---
title: "fix: Workspace/gateway reliability hardening (#763)"
type: fix
status: active
date: 2026-06-07
deepened: 2026-06-07
---

# fix: Workspace/gateway reliability hardening (#763)

## Overview

Resilience and coverage hardening for the workspace-agent ↔ gateway attach path, deferred from the #749 supervisor-readiness work. Issue #763's first item (threading the run abort signal into the gateway's OpenCode SDK calls) **already shipped** — verified at `packages/gateway/src/execute/run-core.ts` where `signal` now reaches `session.create`, `event.subscribe`, and `promptAsync`. This plan covers the five remaining items: a workspace-proxy upstream timeout that is careful not to break SSE, deeper `/readyz` semantics, a hard per-probe deadline cap, a cross-package type-mirror test, and a testable `startWorkspaceAgent` seam.

## Problem Frame

Two residual failure modes and three coverage gaps remain after #749/#755/#761:

1. **The workspace OpenCode proxy has no upstream request timeout.** `apps/workspace-agent/src/opencode-proxy.ts` forwards via `http.request()` and handles only the `error` event — a stalled upstream leaves the gateway call hanging. The proxy also carries the SSE event stream, so a blanket total timeout would break streaming.
2. **`/readyz` reflects only the loopback OpenCode status, not the attach path.** It mirrors the supervisor's `opencodeStatus` (loopback `:54321`), but the gateway attaches through the bearer proxy on `:9200`. `/readyz` returning 200 does not currently prove the path the gateway uses is up.
3. **The overall readiness timeout is not a hard cap.** A single probe can overshoot `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` by up to one per-probe timeout (~3s). Immaterial at the 60s default; only matters for very low operator settings.
4. **No cross-package type-mirror test.** `apps/workspace-agent/src/types.ts` `ReadyzResponse` (flat) and `packages/gateway/src/workspace-api/types.ts` `ReadyzResponse` (discriminated union) are wire-compatible by hand with no compile-time guard against drift.
5. **No entrypoint-wiring seam/test.** `apps/workspace-agent/src/main.ts` does real work at import (binds ports, starts the supervisor/proxy), so there's no clean seam to assert the resolved readiness timeout reaches `startOpencodeServer`.

These are independent and low-priority — resilience and coverage on top of a working fix. Source: issue #763 (follow-up from #749).

## Requirements Trace

- R1. A stalled upstream on an ordinary (non-SSE) workspace-proxy request fails with a bounded timeout instead of hanging; SSE/event-stream requests are NOT subject to the bound.
- R2. `/readyz` returns ready only when the attach path the gateway actually uses (the bearer proxy on `:9200`) is usable, not merely when loopback OpenCode booted.
- R3. The readiness polling loop never exceeds `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` by more than a negligible margin — each probe is capped to the remaining deadline.
- R4. A compile-time test fails if the workspace-agent and gateway `ReadyzResponse` wire shapes drift out of compatibility.
- R5. The resolved readiness timeout's path from env → `startOpencodeServer` is assertable via a testable entrypoint seam, without binding real ports at import.

## Scope Boundaries

- Item 1 of #763 (abort-signal threading into SDK calls) is **already done** — not in scope; this plan notes it as resolved.
- Not changing the supervisor respawn / post-ready-exit lifecycle (owned by #749, shipped).
- Not adding new readiness/liveness *endpoints* — only deepening `/readyz` semantics and the proxy timeout.
- Not reworking the bearer-proxy auth or the SSE streaming contract — only adding a non-SSE upstream timeout alongside the existing forwarding.

## Context & Research

### Relevant Code and Patterns

- `apps/workspace-agent/src/opencode-proxy.ts` — `http.createServer()` + `http.request()` forwarding (~lines 55-129). No timeout today; SSE is not specially detected — upstream responses are piped through. The non-SSE-timeout must distinguish event-stream responses (e.g. by the upstream/downstream `Content-Type: text/event-stream`, or the request path/accept header) and skip the bound for them.
- `apps/workspace-agent/src/server.ts` (~47-66) — the `/readyz` handler; currently returns ready iff `opencodeStatus.status === 'ready'`. `/healthz` stays always-200 (unchanged).
- `apps/workspace-agent/src/main.ts` (~10-89) — side-effectful at import: creates the Hono app, starts the server, supervisor, and proxy, reads env/secret. The only export is `opencodeServerPromise`. Needs a `startWorkspaceAgent(deps)` seam.
- `apps/workspace-agent/src/opencode-server.ts` — `startOpencodeServer()` outer readiness loop (~233-254) calling `defaultPollReady(url, signal)` (~143-173) which enforces a fixed `probeTimeoutMs = 3_000` per probe (NOT a remaining-deadline cap).
- `apps/workspace-agent/src/types.ts` (~64-72) — flat `ReadyzResponse { ready: boolean; opencode: ... }`.
- `packages/gateway/src/workspace-api/types.ts` (~61-76) — discriminated `ReadyzReady | ReadyzNotReady`, plus the `WorkspaceClient.readyz()` consumer that cross-checks HTTP status against body shape.
- The proxy ports: `:9100` Hono clone/health, `:9200` bearer proxy (gateway attaches here), `:54321` loopback OpenCode (never published).

### Institutional Learnings

- `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md` — bounded executions / settle discipline: stalled upstream calls must be bounded so cleanup runs. The #749 readiness fix already applied a per-probe `AbortController` timeout; items 1/3 here extend the same "never wait forever" pattern to the proxy and the deadline cap.

## Key Technical Decisions

- **Non-SSE inactivity timeout (NOT a disarm-on-response-start total timeout).** Apply an inactivity/body-progress timeout to ordinary request/response forwarding: arm a timer on request start and **reset it on each data chunk** of the non-SSE response, firing only after no progress for the configured interval. Do NOT clear the timer merely because response headers arrived — a server can send headers fast then stall mid-body forever, which is the exact hang being fixed. SSE (`text/event-stream`) is **fully exempt** — once a response is detected as an event stream, cancel the inactivity timer entirely (the `/event` subscription is a long-lived intentional stream). This inactivity approach also avoids killing legitimate slow-but-progressing non-SSE downloads, which a blanket total timeout would. On timeout, destroy the upstream request and return a 504-class error to the gateway (which already maps clone/proxy timeouts to a 504). Timeout value: a new env-configurable constant (inactivity interval) with a sensible default (e.g. 30s), separate from the readiness probe timeout.
- **`/readyz` gates on the attach path WITHOUT a startup false-negative.** Extend readiness to require the bearer proxy (`:9200`) to be listening in addition to `opencodeStatus === 'ready'`. **Avoid the startup-ordering flap:** if OpenCode reaches ready before the proxy's `listening` event fires, a naive condition would briefly return 503 and the gateway (which fail-closes `handleMention`) would reject mentions during a normal boot window. The proxy-listening signal must therefore be established as part of the boot sequence such that `/readyz` only transitions toward ready once BOTH are live — e.g. await/confirm the proxy `listening` event during startup before readiness can be exposed, rather than letting `/readyz` depend on an event that can lag the rest of boot. Keep the existing flat→discriminated wire shape; only the *condition* changes. `/healthz` stays always-200. The gateway's `readyz()` status/body cross-check is unaffected (still returns 503 + not-ready body when the proxy leg is down).
- **Per-probe deadline cap (with a positive floor).** In the readiness loop(s), cap each probe timeout to `Math.max(1, Math.min(probeTimeoutMs, remainingMs))`, and exit the loop BEFORE calling the probe when `remaining <= 0`. The `Math.max(1, …)` floor prevents clock jitter / loop overhead from producing a 0 or negative timeout that would cause an immediate abort or invalid probe call. **This must be applied to BOTH readiness loop call sites:** the direct `startOpencodeServer()` path AND the production `runSupervisedOpencode()` supervisor path (the real entrypoint goes through the supervisor — see `opencode-server.ts:442`). Behavior unchanged at the 60s default; only tightens low-timeout configs.
- **Compile-time type-mirror test (one-way assignability, not equality).** The two `ReadyzResponse` types are intentionally asymmetric: the gateway's discriminated union is *narrower* (`ready: true` only pairs with `opencode: 'ready'`) while the workspace-agent flat type is *looser*. So assert **one-way assignability** — every gateway-valid `ReadyzResponse` is assignable to the workspace-agent shape (the wire direction: workspace produces, gateway consumes a narrowed view) — NOT type equality, which fails today by design. Use a type-level assertion (conditional types / `satisfies`) in a `.test.ts` so a future shape change breaks `tsc`. Cross-package import is acceptable in a test.
- **`startWorkspaceAgent(deps)` seam.** Extract the import-time side effects in `main.ts` into an exported `startWorkspaceAgent(deps)` function; the module's top level becomes a thin `if (isEntrypoint) startWorkspaceAgent(realDeps)` guard (mirror the harness/CLI `import.meta.url` entrypoint-guard pattern used elsewhere in the repo). This makes the env → `startOpencodeServer` timeout wiring assertable without binding ports.

## Open Questions

### Resolved During Planning

- **#763 item 1 (abort signal):** already shipped — verified at `run-core.ts`; excluded from scope.
- **Proxy timeout vs SSE:** resolve by exempting `text/event-stream` responses from the bound (KTD).
- **Readiness wire shape:** unchanged; only the readiness *condition* deepens (KTD).

### Deferred to Implementation

- **Exact SSE-detection mechanism:** confirm against the actual proxy forwarding code whether `Content-Type` is observable at the right moment (before the timer must fire) or whether the request path/`Accept` header is the more reliable signal — pick during implementation.
- **Proxy timeout env-var name + default:** choose a clear name (e.g. `WORKSPACE_PROXY_TIMEOUT_MS`) and default (~30s) consistent with existing workspace config conventions.
- **Proxy-`:9200`-healthy check mechanism for `/readyz`:** whether to track a "proxy listening" boolean in shared state (set when the proxy server's `listening` event fires) or probe it — pick the simplest reliable signal during implementation.

## Implementation Units

- [x] **Unit 1: Non-SSE upstream timeout in the workspace proxy**

**Goal:** Bound ordinary proxy request/response forwarding so a stalled upstream returns a 504-class error instead of hanging, while leaving SSE event streams unbounded.

**Requirements:** R1

**Dependencies:** None.

**Files:**
- Modify: `apps/workspace-agent/src/opencode-proxy.ts`
- Modify: `apps/workspace-agent/src/opencode-proxy.test.ts` (create if absent)
- Note: the new `WORKSPACE_PROXY_TIMEOUT_MS` env read lands in `main.ts` minimally; Unit 5 moves it into the `startWorkspaceAgent` seam (Unit 5 is the sole `main.ts` editor).

**Approach:**
- Add an **inactivity** timer (reset on each non-SSE response data chunk; armed on request start) — NOT a disarm-on-headers total timeout. A non-SSE upstream that sends headers then stalls mid-body must still trip the timeout. Detect SSE by the upstream response `Content-Type: text/event-stream` (and/or request path/`Accept`); once SSE is detected, cancel the inactivity timer entirely. On timeout (no progress for the configured interval), destroy the upstream request and respond with a 504-class status. Make the interval env-configurable with a sensible default.
- Preserve existing auth + body/no-body handling and the SSE piping path exactly.

**Patterns to follow:**
- The #749 per-probe `AbortController` timeout pattern in `opencode-server.ts` `defaultPollReady`.
- The gateway's existing clone/proxy-timeout → 504 mapping.

**Test scenarios:**
- Happy path: a normal request/response forwards and completes within the inactivity window — unchanged behavior.
- Error path (no response): an upstream that accepts but never sends headers (non-SSE) → the proxy returns a 504-class error within the configured interval, not a hang.
- Error path (mid-body stall): an upstream that sends headers quickly then stalls mid-body → still trips the inactivity timeout (does NOT hang because headers arrived).
- Edge case (slow-but-progressing): a non-SSE response that sends data in chunks slower than the interval-per-chunk but keeps progressing is NOT killed (inactivity, not total, timeout).
- Edge case (SSE exemption): an event-stream request (`text/event-stream`) is NOT timed out — it streams past the window without being cut off.
- Edge case: the interval is configurable via env and defaults correctly when unset.

**Verification:** a stalled non-SSE upstream (no-response OR mid-body) yields a bounded 504; slow-but-progressing non-SSE and SSE streams are unaffected.

- [x] **Unit 2: `/readyz` gates on the attach path (bearer proxy)**

**Goal:** `/readyz` returns ready only when the `:9200` bearer proxy the gateway attaches through is usable, not merely when loopback OpenCode booted.

**Requirements:** R2

**Dependencies:** None (independent of Unit 1, though same subsystem).

**Files:**
- Modify: `apps/workspace-agent/src/server.ts`
- Modify: `apps/workspace-agent/src/main.ts` (to surface the proxy-listening signal into the readiness condition)
- Modify: `apps/workspace-agent/src/server.test.ts` (or the readyz test file)

**Approach:**
- Track a "proxy listening" signal (set a boolean in shared state when the proxy server emits `listening`; clear on close/error). Extend the `/readyz` condition to require BOTH `opencodeStatus === 'ready'` AND the proxy signal. **Avoid the startup false-negative:** ensure the proxy `listening` event is awaited/confirmed during the boot sequence so `/readyz` does not briefly report 503 (and trigger the gateway's fail-closed mention gate) in the normal window where OpenCode is ready but the proxy listener hasn't flipped yet. The signal must reflect a stable boot state, not lag behind it. Keep the response wire shape unchanged (still the flat `ReadyzResponse`); only the readiness condition changes. `/healthz` stays always-200.

**Patterns to follow:**
- The existing `opencodeStatus` shared-state injection into `createApp(...)` in `main.ts`.
- The gateway `readyz()` status↔body cross-check (must keep returning 503 + not-ready body when the proxy leg is down).

**Test scenarios:**
- Happy path: OpenCode ready AND proxy listening → `/readyz` 200, ready body.
- Edge case: OpenCode ready but proxy NOT listening → `/readyz` 503, not-ready body.
- Edge case (startup ordering): the boot sequence does not expose ready before the proxy listener is confirmed — assert no transient 503 window where OpenCode is ready but the proxy signal lags (the false-negative the design must avoid).
- Edge case: OpenCode not ready → `/readyz` 503 (unchanged).
- Integration: `/healthz` stays 200 regardless of proxy/OpenCode state.

**Verification:** `/readyz` reflects attach-path usability; a down proxy leg yields 503 even when OpenCode booted; no startup flap during normal boot.

- [x] **Unit 3: Per-probe readiness deadline cap**

**Goal:** Cap each readiness probe to the remaining overall deadline so the loop can't overshoot `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` by a full probe.

**Requirements:** R3

**Dependencies:** None.

**Files:**
- Modify: `apps/workspace-agent/src/opencode-server.ts`
- Modify: `apps/workspace-agent/src/opencode-server.test.ts`

**Approach:**
- In the readiness loop(s), compute `remaining = deadline - now` each iteration, exit BEFORE probing when `remaining <= 0`, else pass `Math.max(1, Math.min(probeTimeoutMs, remaining))` as the per-probe timeout. The `Math.max(1, …)` floor prevents clock jitter from producing a 0/negative timeout.
- **Apply to BOTH call sites:** the direct `startOpencodeServer()` readiness loop AND the production `runSupervisedOpencode()` supervisor readiness probe (`opencode-server.ts:442`) — the real entrypoint (`main.ts`) goes through the supervisor, so fixing only `startOpencodeServer` would leave the deployed loop able to overshoot. Thread the computed per-probe timeout through `pollReadyFn(url, signal, timeout)` (or equivalent) at both sites.

**Patterns to follow:**
- The existing `defaultPollReady(url, signal)` per-probe timeout; parameterize the timeout and thread it through.

**Test scenarios:**
- Edge case: with a very low overall timeout (e.g. 1s) and a probe that would take 3s, the loop stops at ~1s, not ~3s — assert for BOTH the direct and supervised paths.
- Happy path: at the default 60s, behavior is unchanged (probes still use the 3s cap when remaining > 3s).
- Edge case: `remaining <= 0` → loop exits before probing (no zero/negative timeout passed downstream).

**Verification:** both the direct and supervised readiness loops respect the overall deadline within a negligible margin, with no zero/negative probe timeout.

- [x] **Unit 4: Cross-package `ReadyzResponse` type-mirror test**

**Goal:** Fail compilation if the workspace-agent and gateway `ReadyzResponse` wire shapes drift out of compatibility.

**Requirements:** R4

**Dependencies:** None.

**Files:**
- Create: a type-mirror test (e.g. `packages/gateway/src/workspace-api/readyz-types.test.ts` or `apps/workspace-agent/src/types.test.ts` — place it where cross-package import is cleanest)
- Modify: none (or a tiny type export if needed for the assertion)

**Approach:**
- Add a compile-time **one-way assignability** assertion (NOT equality — the types are intentionally asymmetric): assert every gateway-valid `ReadyzResponse` (the narrower discriminated union) is assignable to the workspace-agent flat `ReadyzResponse` shape it's produced from, covering both ready and not-ready cases. Use type-level assertions (conditional types / `satisfies`) so a future shape change breaks `tsc`. An equality assertion would fail today by design — do not use one.

**Patterns to follow:**
- Any existing type-assertion test in the repo; otherwise a standard `Expect<Extends<Gateway, Workspace>>`-style one-way type-level check.

**Test scenarios:**
- Test expectation: compile-time — the one-way assignability assertion holds today; a deliberate drift that breaks wire-compatibility (verified locally, not committed) would fail `tsc`. Include a runtime `expect(true).toBe(true)` placeholder if the runner requires a runtime assertion, with the real guard being the type-level check.

**Verification:** `pnpm check-types` fails if the gateway `ReadyzResponse` stops being assignable to the workspace-agent shape.

- [x] **Unit 5: `startWorkspaceAgent(deps)` entrypoint seam**

**Goal:** Extract `main.ts`'s import-time side effects into a testable `startWorkspaceAgent(deps)` so the env → `startOpencodeServer` readiness-timeout wiring is assertable without binding ports.

**Requirements:** R5

**Dependencies:** **Unit 5 is the SOLE editor of `apps/workspace-agent/src/main.ts`.** Sequence Units 1/2/3 first, then Unit 5 extracts the seam and folds in whatever `main.ts` wiring Units 1/2 introduced (the proxy timeout env read, the proxy-listening signal). Units 1/2 should keep their `main.ts` footprint minimal and expect Unit 5 to move it into the seam. Do NOT implement Unit 5 in parallel with 1/2.

**Files:**
- Modify: `apps/workspace-agent/src/main.ts`
- Create: `apps/workspace-agent/src/main.test.ts`

**Approach:**
- Move the import-time work (app/server/supervisor/proxy creation, env/secret reads) into an exported `startWorkspaceAgent(deps)` function with injectable dependencies (env, server-starter, supervisor factory, proxy factory). The top level becomes a thin `import.meta.url` entrypoint guard that calls it with real deps. Mirror the repo's existing entrypoint-guard pattern (e.g. the harness/scripts `fileURLToPath(import.meta.url)` guard).
- **Preserve startup order byte-for-byte:** read env BEFORE any server bind; start the same components in the same sequence (Hono server, supervisor, proxy) as today. The extraction must MOVE the existing steps, not rewrite them — a reordering could regress runtime even though the image still boots.

**Execution note:** extract the seam, then add a wiring test asserting the resolved `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` reaches the supervisor/`startOpencodeServer` via injected deps, AND a test asserting startup ordering is preserved (env read → components started in the same order).

**Patterns to follow:**
- The repo's `import.meta.url`-based entrypoint guards (harness CLI / deploy scripts).

**Test scenarios:**
- Integration: `startWorkspaceAgent` called with a fake env setting `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` → asserts the injected readiness path receives that resolved timeout.
- Integration (ordering): with spy/fake deps, assert env is read before any server bind and components start in the same order as the pre-refactor entrypoint.
- Edge case: importing the module does NOT bind ports / start the server (no side effects at import).

**Verification:** importing `main.ts` is side-effect-free; the readiness-timeout wiring and the preserved startup order are both assertable through injected deps; the Workspace Image Smoke Test still boots the image.

## System-Wide Impact

- **Interaction graph:** Unit 1 sits in the proxy forwarding path (gateway ↔ workspace OpenCode); Unit 2 changes what `/readyz` means to the gateway's `handleMention` readiness gate; Units 3/4/5 are internal to workspace-agent + a gateway type test.
- **Error propagation:** the proxy timeout surfaces as a 504-class error the gateway already maps; a deeper `/readyz` surfaces as 503 the gateway already fail-closes on.
- **State lifecycle risks:** the proxy "listening" signal must be cleared on proxy close/error so `/readyz` doesn't report ready against a dead proxy; the seam extraction must not drop any existing startup step.
- **API surface parity:** `/readyz`/`/healthz` wire shapes unchanged (only `/readyz` condition deepens) — the gateway `WorkspaceClient.readyz()` consumer needs no change.
- **Integration coverage:** the gateway already fail-closes `handleMention` on a not-ready/503 `/readyz`; Unit 2's deeper condition strengthens that gate without changing the consumer contract.
- **Unchanged invariants:** SSE/event-stream forwarding (must NOT be timed out), bearer-proxy auth, the readiness wire shape, the supervisor respawn lifecycle, and `/healthz` always-200.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| The proxy timeout accidentally cuts off SSE event streams | Exempt `text/event-stream` (cancel the timer on SSE detection); Unit 1 edge-case test asserts SSE streams past the window. |
| A non-SSE upstream stalls mid-body after fast headers → hang returns | Use an **inactivity** timer reset per data chunk (not disarm-on-headers); Unit 1 mid-body-stall test asserts it still trips. |
| The inactivity timeout kills a legitimate slow-but-progressing non-SSE download | Inactivity (per-chunk) not total timeout; Unit 1 slow-but-progressing test asserts it is NOT killed. |
| `/readyz` false-negative (503) during normal boot when OpenCode readies before the proxy `listening` fires → gateway rejects mentions | Establish the proxy-listening signal as a stable boot state before exposing ready; Unit 2 startup-ordering test asserts no transient 503 window. |
| `/readyz` "proxy listening" signal goes stale (reports ready against a dead proxy) | Clear the signal on proxy close/error; Unit 2 test covers proxy-not-listening → 503. |
| Per-probe cap only fixes the direct loop, leaving the production supervisor path uncapped | Apply to BOTH `startOpencodeServer` and `runSupervisedOpencode` (`opencode-server.ts:442`); Unit 3 tests both paths. |
| Per-probe cap produces a 0/negative timeout from clock jitter | `Math.max(1, …)` floor + exit-before-probe when `remaining <= 0` (KTD); Unit 3 boundary test. |
| The `main.ts` seam extraction drops a step or reorders startup (smoke test only proves "boots") | Move (not rewrite) steps; Unit 5 ordering test asserts env-before-bind and same component order; Unit 5 is sole `main.ts` editor (no parallel edits). |

## Documentation / Operational Notes

- Document the new `WORKSPACE_PROXY_TIMEOUT_MS` (name/default TBD) in `deploy/README.md` / `deploy/compose.yaml` if it's operator-relevant.
- Note the deeper `/readyz` semantics (now means "attach path usable") wherever `/readyz` is documented for operators.
- The Workspace Image Smoke Test (`Workspace Image Smoke Test` CI job) remains the authority that the image still boots after the `main.ts` seam extraction.

## Sources & References

- **Origin issue:** #763 — Workspace/gateway reliability hardening (follow-up from #749). Item 1 (abort-signal) verified already-shipped in `run-core.ts`.
- Related code: `apps/workspace-agent/src/{opencode-proxy,server,main,opencode-server,types}.ts`, `packages/gateway/src/workspace-api/types.ts`.
- Related PRs: #749/#755/#761/#767 (supervisor readiness), #769 (directory threading).
