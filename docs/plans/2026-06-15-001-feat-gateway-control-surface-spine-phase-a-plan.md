---
title: 'feat: Gateway control surface spine — Phase A (transport-agnostic execution + approval extraction)'
type: feat
status: active
date: 2026-06-15
origin: docs/brainstorms/2026-06-15-gateway-control-surface-spine-requirements.md
---

# Gateway control surface spine — Phase A (transport-agnostic execution + approval extraction)

## Overview

Phase A creates the seam that every future web control surface path depends on: a transport-agnostic `launchWork` execution core extracted from the Discord-coupled `runMention → startRun` path, and a generalized approval coordinator where a decision can arrive from Discord or a future web transport through the same fail-closed gate. The Discord user experience is unchanged — `runMention` becomes a thin adapter over `launchWork`, and the Discord approval button flow becomes one implementation of a transport-neutral approval-render/decision seam.

This is the "non-Discord caller" that `packages/gateway/AGENTS.md` explicitly defers to. It ships with zero behavior change to Discord, covered by tests, before any new listener or auth lands. Phase B (inbound web listener + operator auth) and Phase C (bindings read path) both depend on this seam existing.

Tracking issue: [fro-bot/agent#907](https://github.com/fro-bot/agent/issues/907).

## Problem Frame

The gateway's execution engine (`packages/gateway/src/execute/run.ts`) takes a Discord `Message` as its primary input — the prompt text, the status-reply surface, and the typing indicator are all extracted from or written back to that `Message`. The approval coordinator (`packages/gateway/src/approvals/coordinator.ts`) bridges OpenCode `permission.asked`/`replied` events to Discord buttons. Both are correct and well-tested for Discord, but neither can be invoked by a non-Discord caller without carrying a fake `Message` or a parallel approval path — both of which are unacceptable.

The consequence: the dashboard cannot launch work, the operator cannot approve actions from the web, and agent-to-agent coordination has no execution primitive to call. Phase A resolves this by introducing a transport-neutral interface layer that the Discord path implements and future web paths will also implement, without changing any observable Discord behavior.

## Requirements Trace

- **R1.** Extract a transport-agnostic `launchWork(request: LaunchWorkRequest, deps)` core from the `runMention → startRun` path. `LaunchWorkRequest` carries the transport-neutral inputs the engine needs: prompt text/source, binding (owner/repo), requester identity, and abstract status-sink + reply-sink interfaces — not a raw Discord `Message`.
- **R2.** `runMention` becomes a thin Discord adapter: it maps a Discord `Message` → `LaunchWorkRequest` (extracting prompt text, stripping the bot mention via `botUserId`, wiring Discord `StatusSink`/`ReplySink` implementations over the existing live-status/typing message flow) and calls `launchWork`. Zero change to the Discord user experience: same status message, typing indicator, queue behavior, and reactions.
- **R3.** Define transport-neutral sink interfaces (`StatusSink`, `ReplySink`) so the engine emits progress and results without knowing the transport. The Discord adapter implements them over the existing `live-status`/`typing-only` message flow. The interface contract is the only thing `launchWork` depends on.
- **R4.** Generalize the approval coordinator so an approval decision can arrive from Discord or a future web transport, preserving the same fail-closed/timeout/restart semantics by construction. The Discord button flow becomes one implementation of a transport-neutral approval-render/approval-decision seam. `parsePermissionRequest`/`parsePermissionReply` remain the pure, transport-agnostic parsing core.
- **R5.** One approval gate, multiple transports — there must be no parallel or second approval path. A future web approval reuses the same registry and settlement logic. The fail-closed coordinator/registry is the trust anchor.
- **R6.** The `RunTask` queue continues to work. Where `RunTask` currently carries a raw `Message`, it carries a `LaunchWorkRequest` (or the sinks) instead — but the change is minimal and behavior-preserving. The goal is a seam, not a rewrite.

## Scope Boundaries

- No new HTTP listener in Phase A (the ingress-pin constraint is not touched).
- No operator web auth in Phase A (HMAC-only today; web auth is Phase B).
- No bindings read surface in Phase A (Phase C).
- No change to the Discord user experience — same status message, typing indicator, queue behavior, reactions, and approval button flow.
- No extraction of `@fro-bot/runtime` HTTP primitives or the GitHub App client (separate effort).
- No change to `packages/gateway/src/http/ingress-pin.test.ts` or `server.ts` — the ingress-pin constraint is explicitly not touched.

### Deferred to Separate Tasks

- **Phase B** — inbound web control surface + operator web auth: a separate authenticated listener (honoring the ingress-pin egress boundary), web-launched work routing through Phase A's `launchWork` + approval gate, and net-new operator session auth. Requires coordination with `marcusrbrown/infra` on the deploy topology. Gets its own `ce:plan` run.
- **Phase C** — bindings read path: a read surface for `listBindings`/`getBindingByRepo` consumable by `fro-bot/dashboard`. Depends on Phase B's authenticated surface or ships as a minimal read endpoint. Gets its own `ce:plan` run.
- Characterization tests pinning current Discord behavior before the refactor (optional safety net — execution decision for the implementer; the plan recommends characterization-first for Units 2 and 3).

## Context & Research

### Relevant Code and Patterns

**Execution engine (`packages/gateway/src/execute/run.ts`, 834 lines):**
- `runMention(message: Message, binding: RepoBinding, deps: RunMentionDeps)` at line 805 — the thin Discord entry point; enqueues a `RunTask` and the real engine is `startRun(task: RunTask)` at line 184 (~600 lines).
- `RunTask = { readonly message: Message; readonly binding: RepoBinding; readonly deps: RunMentionDeps }` (line 70) — the `message: Message` field is the primary Discord coupling to extract.
- `RunMentionDeps` (line 28) includes: `coordinationConfig`, `identity`, `concurrency`, `queue: ChannelQueue<RunTask>`, `attachUrl`/`attachToken`, `runTimeoutMs`, `botUserId`, `persona`, `logger`, `approvalRegistry: ApprovalRegistry`, `approvalMode`, `statusMode: 'live-status' | 'typing-only'`, `ensureClone`, `readyz`, `isShuttingDown`.
- The Discord coupling is concentrated in: `RunTask.message: Message` (threaded through the engine for prompt-building and status replies) and the status/reply surface that writes back to that message.

**Approval coordinator (`packages/gateway/src/approvals/coordinator.ts`):**
- `createPermissionCoordinator(deps: PermissionCoordinatorDeps)` at line 206.
- `PermissionCoordinatorDeps.onRequest` (line ~89): "Invoked when a new request is registered. The caller renders the Discord embed." — this is the transport-coupling seam to generalize.
- Comment at top: "Bridges OpenCode permission events to the Discord approval UI."
- `parsePermissionRequest`/`parsePermissionReply` are pure parsers — already transport-agnostic, unchanged by Phase A.
- `PermissionRequest`/`PermissionReplyEvent` interfaces exist and are transport-neutral.
- `registry.ts` owns pending state and fail-closed settlement (timeout/restart → reject/dispose) — this is the trust anchor, unchanged by Phase A.

**Ingress-pin constraint (`packages/gateway/src/http/ingress-pin.test.ts`):**
- Statically asserts exactly one `serve()` call in `server.ts`. Phase A does not touch this file or `server.ts`.

**`packages/gateway/AGENTS.md`:**
- Explicitly notes execution is Discord-only and that a transport-agnostic execution primitive is "deferred until a non-Discord caller exists." Phase A creates that seam.

**Patterns to follow:**
- The `discord/io.ts` centralize-to-prevent-drift pattern (see `docs/plans/2026-06-09-004-refactor-gateway-discord-io-helper-plan.md`): introduce a typed interface, make the Discord path implement it, enforce the boundary.
- `GatewayLogger` injection pattern from `packages/gateway/src/discord/client.ts`.
- `Result<T, E>` from `@bfra.me/es` for fail-soft returns.
- Existing `ChannelQueue<RunTask>` and concurrency patterns in `run.ts`.

## Key Technical Decisions

- **`LaunchWorkRequest` carries sinks, not a `Message`.** The engine receives `StatusSink` and `ReplySink` interfaces rather than a raw Discord `Message`. The Discord adapter constructs concrete implementations of these interfaces from the `Message` and passes them in. This is the minimal seam: the engine's logic is unchanged, only its input contract changes.
- **`runMention` stays as the Discord entry point, becomes a thin adapter.** It does not disappear — it maps `Message` → `LaunchWorkRequest` and calls `launchWork`. The `ChannelQueue<RunTask>` continues to work; `RunTask` carries a `LaunchWorkRequest` (or the sinks) rather than a raw `Message` where feasible, keeping the change minimal.
- **Approval coordinator: `onRequest` becomes a transport-neutral render hook.** The `PermissionCoordinatorDeps.onRequest` callback is already the seam — it is "invoked when a new request is registered; the caller renders the Discord embed." Generalizing it means the callback receives a `PermissionRequest` and returns a `PermissionDecisionHandle` (or similar) that the coordinator uses to await the decision. The Discord implementation renders the embed and wires the button interaction; a future web implementation renders a web notification and wires an HTTP callback. The registry and fail-closed settlement are unchanged.
- **One gate, no parallel path (R5).** The registry owns pending state and settlement. Any new transport plugs into the same registry via the `onRequest` hook — it cannot create a parallel registry or bypass the fail-closed timeout/restart semantics.
- **Characterization-first / test-first execution.** Before refactoring Units 2 and 3, write characterization tests that pin the current Discord behavior (status message posted/edited, mention stripped, queue/concurrency, approval button flow). These tests must pass before and after the refactor. This is the zero-regression guarantee.
- **Minimal diff, behavior-preserving.** The goal is a seam, not a rewrite. `startRun` internals are not restructured beyond what is needed to accept `LaunchWorkRequest` + sinks instead of `RunTask.message`. The Discord adapter in `runMention` is the only new code path.

## Open Questions

### Resolved During Planning

- **Does Phase A need a new listener?** No — Phase A is purely a refactor that adds a seam. No new `serve()` call, no ingress-pin change.
- **Should `RunTask` be eliminated?** No — `RunTask` continues to work; it carries `LaunchWorkRequest` (or the sinks) instead of a raw `Message`. Minimal change.
- **Can `parsePermissionRequest`/`parsePermissionReply` stay as-is?** Yes — they are already pure and transport-agnostic. Phase A does not touch them.
- **Is the `onRequest` hook the right seam for the approval coordinator?** Yes — it is already the documented transport-coupling point ("the caller renders the Discord embed"). Generalizing it is the minimal change.
- **Does Phase A change the Discord user experience?** No — R2 and R3 are explicit: same status message, typing indicator, queue behavior, reactions, and approval button flow.

### Deferred to Implementation

- Exact names and shapes for `StatusSink`, `ReplySink`, and `LaunchWorkRequest` — to be determined during Unit 1 based on what `startRun` actually reads from `RunTask.message`.
- Whether `RunTask` carries a `LaunchWorkRequest` directly or carries the sinks as separate fields — implementer decides based on the minimal-diff principle.
- Exact form of the `PermissionDecisionHandle` returned by `onRequest` — to be determined during Unit 4 based on how the coordinator awaits the decision today.
- Whether a characterization test file is a separate Unit 0 or is folded into Units 2 and 3 as a pre-condition — execution decision for the implementer.

## High-Level Technical Design

The design introduces a thin interface layer between the Discord transport and the execution engine. The engine (`launchWork`) receives a `LaunchWorkRequest` that carries:

- Prompt text and source metadata (extracted from the Discord `Message` by the adapter)
- `RepoBinding` (owner, repo, channelId — unchanged)
- Requester identity (Discord user ID or future web operator identity)
- `StatusSink` — an interface the engine calls to post/update status progress (the Discord adapter implements this over the existing live-status/typing message flow)
- `ReplySink` — an interface the engine calls to deliver the final run output (the Discord adapter implements this over `Message.reply`)

The Discord adapter (`runMention`) maps `Message` → `LaunchWorkRequest`, constructs the Discord `StatusSink`/`ReplySink` implementations, and calls `launchWork`. The `ChannelQueue<RunTask>` continues to enqueue work; `RunTask` carries the `LaunchWorkRequest` instead of the raw `Message`.

The approval coordinator's `onRequest` hook is generalized: it receives a `PermissionRequest` and is responsible for rendering the approval UI (Discord embed, future web notification) and wiring the decision back to the coordinator. The registry and fail-closed settlement (timeout/restart → reject/dispose) are unchanged. The Discord button handler becomes one implementation of this hook.

```
Discord Message
    │
    ▼
runMention (thin Discord adapter)
    │  maps Message → LaunchWorkRequest
    │  constructs Discord StatusSink / ReplySink
    ▼
launchWork(request: LaunchWorkRequest, deps)   ← transport-agnostic engine
    │  calls request.statusSink.update(...)
    │  calls request.replySink.send(...)
    │  calls approvalRegistry (via coordinator)
    ▼
ChannelQueue<RunTask>  (RunTask carries LaunchWorkRequest)

Approval path:
coordinator.onRequest(permissionRequest)
    │
    ├── Discord impl: render embed → button interaction → registry.settle()
    └── Future web impl: render notification → HTTP callback → registry.settle()
                                                               ▲
                                                    registry (fail-closed, unchanged)
```

A future web caller (Phase B) will call `launchWork` directly with its own `StatusSink`/`ReplySink` implementations (e.g., SSE stream) and plug into the same approval coordinator via a web `onRequest` implementation.

## Implementation Units

- [ ] **Unit 1: Define transport-neutral types — `LaunchWorkRequest`, `StatusSink`, `ReplySink`**

  **Goal:** Establish the typed interface contract that the engine will accept and the Discord adapter will implement. No runtime behavior changes in this unit.

  **Requirements:** R1, R3

  **Dependencies:** None

  **Files:**
  - Create: `packages/gateway/src/execute/launch-types.ts` (or `packages/gateway/src/execute/types.ts` if a types file already exists — check first)

  **Approach:**
  - Read `packages/gateway/src/execute/run.ts` lines 1–100 to inventory exactly what `startRun` reads from `RunTask.message` (prompt text extraction, `botUserId` mention-strip, status-reply calls, typing indicator). These reads define the `StatusSink`/`ReplySink` interface surface.
  - Define `LaunchWorkRequest` with: prompt text (string), source metadata (channel/guild IDs for logging), `RepoBinding`, requester identity (Discord user ID or future operator identity as a discriminated union), `StatusSink`, `ReplySink`.
  - Define `StatusSink` interface: the methods the engine calls to post/update status progress (e.g., `update(text: string): Promise<void>`, `setTyping(): Promise<void>`).
  - Define `ReplySink` interface: the method the engine calls to deliver final output (e.g., `send(content: string, options?: ReplyOptions): Promise<void>`).
  - Use `unknown` + narrowing and discriminated unions; no `any`.

  **Patterns to follow:** existing `RunMentionDeps` and `RunTask` type shapes in `run.ts`; `Result<T, E>` from `@bfra.me/es`; discriminated union patterns used elsewhere in the gateway.

  **Test scenarios:**
  - Types-only unit: no runtime behavior. Verification is `pnpm check-types` clean and the type shapes satisfy the constraints (e.g., a Discord `Message`-based implementation satisfies `StatusSink`/`ReplySink` structurally).
  - Structural: a mock object implementing `StatusSink` compiles without cast; a mock `LaunchWorkRequest` with a Discord requester identity compiles; a future web requester identity shape also compiles (discriminated union covers both).

  **Verification:** `pnpm check-types` clean; the new types file exports `LaunchWorkRequest`, `StatusSink`, `ReplySink`; no `any` or `@ts-ignore`; the Discord `Message`-derived implementations in Unit 3 satisfy the interfaces structurally.

- [ ] **Unit 2: Extract `launchWork` core from `startRun`**

  **Goal:** Move the execution engine to accept `LaunchWorkRequest` + sinks instead of `RunTask.message`. `startRun` is updated to bridge `RunTask` → `LaunchWorkRequest` (or `RunTask` carries `LaunchWorkRequest` directly). The engine runs against a fake/in-memory sink with no Discord dependency.

  **Requirements:** R1, R6

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `packages/gateway/src/execute/run.ts` (extract `launchWork`, update `startRun`/`RunTask`)
  - Test: `packages/gateway/src/execute/run.test.ts` (new/updated tests for `launchWork` with in-memory sinks)

  **Approach:**
  - **Characterization-first:** before touching `startRun`, write (or verify existing) tests that pin the current behavior of `startRun` via the existing `RunTask.message` path — status message posted, mention stripped, queue/concurrency, timeout, shutdown. These tests must pass before and after the refactor.
  - Extract the engine body of `startRun` into `launchWork(request: LaunchWorkRequest, deps: LaunchWorkDeps)`. `LaunchWorkDeps` is a subset of `RunMentionDeps` (everything except the Discord-specific fields that move into the adapter).
  - Update `startRun` to map `RunTask` → `LaunchWorkRequest` (or update `RunTask` to carry `LaunchWorkRequest` directly — minimal-diff principle applies).
  - The `ChannelQueue<RunTask>` is unchanged; `runMention` still enqueues a `RunTask`.
  - Write new tests for `launchWork` using in-memory `StatusSink`/`ReplySink` implementations (no Discord, no `Message`). These tests cover the engine's behavior independently of the transport.

  **Patterns to follow:** existing `run.ts` test structure; `vi.hoisted()` + `vi.mock()` for static `@octokit/rest` shims (per repo test conventions); in-memory sink pattern (simple objects implementing the interfaces).

  **Test scenarios:**
  - Happy path: `launchWork` with an in-memory `StatusSink`/`ReplySink` completes a run, calls `statusSink.update` at least once, calls `replySink.send` with the final output.
  - Timeout: `launchWork` respects `runTimeoutMs`; the `StatusSink` receives a timeout status update; the run terminates cleanly.
  - Shutdown: `isShuttingDown()` returning `true` causes `launchWork` to reject/abort; the `StatusSink` receives a shutdown status update.
  - Queue/concurrency: `runMention` still enqueues via `ChannelQueue<RunTask>`; a second concurrent mention for the same channel is queued, not dropped.
  - Characterization regression: the existing Discord-path tests (via `runMention`) still pass unchanged after the refactor.

  **Verification:** `pnpm check-types` clean; `pnpm test` passes (existing `run.test.ts` + new `launchWork` tests); `launchWork` is exported and accepts `LaunchWorkRequest` + in-memory sinks; no Discord import in `launchWork`'s own logic.

- [ ] **Unit 3: Make `runMention` a thin Discord adapter**

  **Goal:** `runMention` maps a Discord `Message` → `LaunchWorkRequest`, constructs Discord `StatusSink`/`ReplySink` implementations over the existing live-status/typing message flow, and calls `launchWork`. Zero change to the Discord user experience.

  **Requirements:** R2, R3

  **Dependencies:** Units 1, 2

  **Files:**
  - Modify: `packages/gateway/src/execute/run.ts` (the `runMention` function and the Discord sink implementations)
  - Test: `packages/gateway/src/execute/run.test.ts` (Discord adapter behavior tests)

  **Approach:**
  - **Characterization-first:** verify the characterization tests from Unit 2 cover the Discord-path behavior (status message posted/edited, mention stripped via `botUserId`, queue/concurrency, reactions). These must pass before and after this unit.
  - Implement `DiscordStatusSink` and `DiscordReplySink` (or inline implementations) that wrap the existing live-status/typing message flow. The `statusMode: 'live-status' | 'typing-only'` logic moves into `DiscordStatusSink`.
  - `runMention` extracts prompt text from `message.content` (stripping the bot mention via `botUserId`), constructs the `LaunchWorkRequest` with the Discord sinks, and calls `launchWork` (or enqueues a `RunTask` carrying the `LaunchWorkRequest`).
  - The `Message` object is no longer passed into `launchWork` or `startRun` — it is consumed entirely in the adapter.

  **Patterns to follow:** existing `runMention` mention-strip logic; `statusMode` branching in `run.ts`; `discord/io.ts` `StatusSink`/`ReplySink` Discord implementations (if applicable from the io.ts refactor).

  **Test scenarios:**
  - Happy path: `runMention` with a real Discord `Message` mock calls `launchWork` with a `LaunchWorkRequest` whose prompt text has the bot mention stripped; the `StatusSink` posts a status message; the `ReplySink` sends the final output.
  - `statusMode: 'live-status'`: status message is posted and edited as the run progresses.
  - `statusMode: 'typing-only'`: typing indicator is set; no status message posted.
  - Mention strip: `@fro-bot prompt text` → `prompt text` (via `botUserId`); leading/trailing whitespace trimmed.
  - Queue/concurrency: a second `runMention` for the same channel is queued; the first run completes before the second starts.
  - Reactions: existing reaction behavior (if any) is preserved.
  - Regression: the Discord user experience is identical to pre-refactor (status message content, timing, error messages unchanged).

  **Verification:** `pnpm check-types` clean; `pnpm test` passes; `runMention` no longer passes a `Message` into `launchWork`/`startRun`; the Discord sink implementations satisfy `StatusSink`/`ReplySink` structurally; characterization tests pass.

- [ ] **Unit 4: Generalize the approval coordinator seam**

  **Goal:** The approval coordinator's `onRequest` hook becomes a transport-neutral render + decision-intake seam. The Discord button flow becomes one implementation. The registry and fail-closed settlement are unchanged. A decision from a non-Discord source settles via the same gate.

  **Requirements:** R4, R5

  **Dependencies:** Units 1, 2, 3 (the `LaunchWorkRequest` + sinks pattern is established; the coordinator is wired via `approvalRegistry` in `RunMentionDeps`)

  **Files:**
  - Modify: `packages/gateway/src/approvals/coordinator.ts` (generalize `PermissionCoordinatorDeps.onRequest`)
  - Modify (if needed): `packages/gateway/src/approvals/registry.ts` (verify fail-closed settlement is unchanged)
  - Test: `packages/gateway/src/approvals/coordinator.test.ts` (new tests for non-Discord decision intake)

  **Approach:**
  - Read `coordinator.ts` lines 1–250 to understand the current `onRequest` callback contract and how the coordinator awaits the decision.
  - Generalize `PermissionCoordinatorDeps.onRequest` so it receives a `PermissionRequest` and returns a handle (or registers a decision callback) that the coordinator uses to await the decision. The Discord implementation renders the embed and wires the button interaction to call `registry.settle()`; a future web implementation would render a web notification and wire an HTTP callback to `registry.settle()`.
  - `parsePermissionRequest`/`parsePermissionReply` are unchanged — they remain the pure parsing core.
  - The registry's fail-closed settlement (timeout/restart → reject/dispose) is unchanged.
  - Write a test that drives a decision from a non-Discord source (a plain function call simulating a web callback) and verifies it settles via the same registry.

  **Patterns to follow:** existing `coordinator.ts` `onRequest` callback shape; `registry.ts` `settle()` call pattern; `vi.hoisted()` + `vi.mock()` for test isolation.

  **Test scenarios:**
  - Happy path (Discord): a Discord button interaction calls the decision callback → `registry.settle()` is called → the coordinator resolves the permission request as approved.
  - Happy path (non-Discord): a plain function call (simulating a future web callback) calls the decision callback → `registry.settle()` is called → the coordinator resolves the permission request as approved.
  - Fail-closed (timeout): no decision arrives within `timeoutMs` → `registry.settle()` is called with reject → the coordinator resolves as rejected.
  - Fail-closed (restart): the coordinator is disposed before a decision arrives → pending requests are rejected/disposed.
  - One gate: two concurrent permission requests from different transports both settle via the same registry; neither bypasses the fail-closed semantics.
  - `parsePermissionRequest`/`parsePermissionReply` unchanged: existing parse tests still pass.

  **Verification:** `pnpm check-types` clean; `pnpm test` passes; a non-Discord decision source settles via the same registry; fail-closed timeout/restart behavior is preserved and tested; `parsePermissionRequest`/`parsePermissionReply` tests unchanged.

## System-Wide Impact

- **Interaction graph:** `runMention` → `launchWork` → `StatusSink`/`ReplySink` (Discord implementations). The `ChannelQueue<RunTask>` is unchanged. The approval coordinator is wired via `approvalRegistry` in `RunMentionDeps` — unchanged from the caller's perspective.
- **Error propagation:** unchanged — the engine's error handling (timeout, shutdown, run failure) is preserved; errors are surfaced via `StatusSink`/`ReplySink` to the transport, not thrown into the queue.
- **State lifecycle:** no persistence changes. The registry's in-memory pending state and fail-closed settlement are unchanged.
- **API surface parity:** `runMention` signature is unchanged (it is the Discord entry point); `launchWork` is a new export. The approval coordinator's `onRequest` callback contract changes shape (generalized), but the Discord implementation is updated in the same PR.
- **Sequencing:** Unit 1 (types) → Unit 2 (engine extraction) → Unit 3 (Discord adapter) → Unit 4 (approval seam). Units 2 and 3 both modify `run.ts` and are serial. Unit 4 modifies `coordinator.ts` and can run in parallel with Units 2–3 after Unit 1, but is logically cleaner after Unit 3 (the full `LaunchWorkRequest` pattern is established).
- **Unchanged invariants:** Discord user experience (status message, typing indicator, queue behavior, reactions, approval button flow), ingress-pin constraint (`server.ts` has exactly one `serve()`), `parsePermissionRequest`/`parsePermissionReply` pure parsing, registry fail-closed settlement, `ChannelQueue<RunTask>` concurrency model.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `startRun` reads more from `RunTask.message` than expected, making the `StatusSink`/`ReplySink` interface surface larger than anticipated | Unit 1 inventories all `message` reads before defining the interfaces; the interface surface is driven by actual usage, not assumption |
| Discord behavior regression (status message, mention strip, queue, reactions) | Characterization-first in Units 2 and 3: pin current behavior before refactoring; the characterization tests are the zero-regression gate |
| `RunTask` type change breaks other callers of the queue | `RunTask` change is minimal (carry `LaunchWorkRequest` instead of raw `Message`); all callers are in `run.ts` and are updated in the same unit |
| Approval coordinator `onRequest` generalization breaks the Discord button flow | Unit 4 updates the Discord `onRequest` implementation in the same PR; the Discord button tests must pass before and after |
| A future web approval path creates a parallel registry (bypassing fail-closed) | R5 is explicit: one gate. The registry is the trust anchor. The `onRequest` hook is the only approved extension point. Code review enforces this. |
| Phase B or C planned without access to the brainstorm (gitignored) | This plan carries forward all grounded context needed for Phase B and C planning (see Deferred Phases section below) |

## Deferred Phases (B & C) — grounding for future in-repo planning

This section exists because the origin brainstorm (`docs/brainstorms/2026-06-15-gateway-control-surface-spine-requirements.md`) is gitignored and will not be present after a fresh `main` pull. A future agent session in `fro-bot/agent` planning Phase B or Phase C must use this checked-in plan as its primary context source, alongside issue #907 and the north-star document.

**Phase B and Phase C each get their own `ce:plan` run from within `fro-bot/agent`, using this plan + the issue #907 thread as origin context (the brainstorm is local-only/gitignored).**

### Phase B — Inbound web control surface + operator web auth

**What it is:** A separate authenticated inbound listener exposing: launch a unit of work (calls Phase A's `launchWork`), query run/agent state, stream state back. Plus net-new operator web auth (sessions, revocation, CSRF/origin binding).

**Grounded constraints for Phase B planning:**

- **Ingress-pin egress-boundary constraint (load-bearing):** `packages/gateway/src/http/ingress-pin.test.ts` statically scans gateway source and asserts exactly one `serve()` call in `server.ts`. Rationale: the gateway is workspace-reachable over sandbox-net, so any new inbound listener could reopen the egress trust boundary (a workspace-reachable endpoint doing outbound requests would let the workspace bypass the mitmproxy egress filter). A new control surface must therefore be a **separate listener on a non-sandbox-net interface** (strongly preferred) OR a deliberately-reviewed `EXPECTED_ROUTES`/pin update + deploy/README egress-topology update + security review. This is a hard architectural gate, not a detail. The preferred path (separate non-sandbox-net interface) needs confirmation that the deploy topology (`marcusrbrown/infra` gateway compose + mitmproxy egress filter) can keep it off sandbox-net — requires coordination with `marcusrbrown/infra`.
- **Web auth is net-new and security-critical:** `packages/gateway/src/http/hmac.ts` (raw-body HMAC, `REPLAY_WINDOW_MS=5min`, constant-time, fail-closed) is the only auth today. No user/session/browser-auth concept exists anywhere. Operator web auth requires a real session model (operator identity, sessions, revocation, CSRF/origin binding) — not HMAC repurposed for a browser. The web auth mechanism (GitHub OAuth operator allowlist + signed cookie? device-flow/token?) and the operator allowlist source of truth are open questions for Phase B planning.
- **Web-launched work MUST reuse Phase A's `launchWork` + approval gate:** no parallel execution path, no parallel approval registry. The Phase A seam is the only approved extension point.
- **State-stream transport:** SSE vs. WebSocket vs. poll for streaming run/agent state back to the web caller — open question for Phase B planning.
- **Ingress-pin resolution options:** (a) separate listener on a non-sandbox-net interface (preferred — keeps the egress boundary clean, requires infra topology confirmation); (b) deliberate `EXPECTED_ROUTES`/pin update with a documented, reviewed egress-topology rationale + deploy/README update + security review (permissible but higher risk). Option (a) is the standing recommendation from the brainstorm.

### Phase C — Bindings read path

**What it is:** A read surface for gateway repo↔Discord bindings consumable by `fro-bot/dashboard` (its third data population). Read-only — no write or create capability in v1.

**Grounded constraints for Phase C planning:**

- **Bindings store:** `packages/gateway/src/bindings/store.ts` `createBindingsStore({adapter, storeConfig, identity})` exposes `createBinding` / `getBindingByRepo` / `getBindingByChannelId` / `listBindings` (create/read/list only, no delete/update). S3-backed via `@fro-bot/runtime` `ObjectStoreAdapter`.
- **`RepoBinding` shape:** `{ owner, repo, channelId, channelName, workspacePath, createdAt, createdByDiscordId }`.
- **No read surface today:** there is no HTTP or other surface exposing bindings outside the gateway process. Phase C creates the first read path.
- **Delivery options:** (a) ride Phase B's authenticated control surface (bindings read endpoint on the Phase B listener — requires Phase B to land first); (b) ship as a minimal read endpoint (could land before Phase B, but requires its own auth/egress decision). The delivery option affects sequencing and the auth surface area — open question for Phase C planning.
- **No write capability in v1:** `createBinding` is not exposed over this path.

### Sources for Phase B and C planning

- This plan: `docs/plans/2026-06-15-001-feat-gateway-control-surface-spine-phase-a-plan.md`
- Tracking issue: [fro-bot/agent#907](https://github.com/fro-bot/agent/issues/907)
- North-star: `fro-bot/.github` `docs/brainstorms/2026-06-15-fro-bot-personal-agent-north-star-requirements.md`
- Ingress-pin constraint: `packages/gateway/src/http/ingress-pin.test.ts`
- Bindings store: `packages/gateway/src/bindings/store.ts`
- Auth primitives: `packages/gateway/src/http/hmac.ts`, `packages/gateway/src/http/config.ts`
- Deploy topology: `marcusrbrown/infra` (gateway compose + mitmproxy egress filter)

## Documentation / Operational Notes

- After Phase A merges: update `packages/gateway/AGENTS.md` to reflect that the transport-agnostic execution primitive now exists (`launchWork`) and that the approval coordinator's `onRequest` hook is the approved extension point for new transports. Remove or update the "deferred until a non-Discord caller exists" note.
- The `launchWork` function and the `StatusSink`/`ReplySink` interfaces should be documented with JSDoc comments explaining the transport-neutral contract and the Discord adapter pattern, so future implementers (Phase B) know exactly what to implement.
- No infra changes in Phase A. Phase B requires coordination with `marcusrbrown/infra` on the deploy topology before any new listener lands.
- Verification commands (pnpm repo): `pnpm bootstrap`, `pnpm check-types`, `pnpm lint`, `pnpm test`. All must pass before merge.

## Sources & References

- Origin brainstorm (local-only/gitignored): `docs/brainstorms/2026-06-15-gateway-control-surface-spine-requirements.md`
- Tracking issue: [fro-bot/agent#907](https://github.com/fro-bot/agent/issues/907)
- North-star: `fro-bot/.github` `docs/brainstorms/2026-06-15-fro-bot-personal-agent-north-star-requirements.md`
- Execution engine: `packages/gateway/src/execute/run.ts` (834 lines; `runMention` at line 805, `startRun` at line 184, `RunTask` at line 70, `RunMentionDeps` at line 28)
- Approval coordinator: `packages/gateway/src/approvals/coordinator.ts` (`createPermissionCoordinator` at line 206, `PermissionCoordinatorDeps.onRequest` at line ~89)
- Approval registry: `packages/gateway/src/approvals/registry.ts` (pending state + fail-closed settlement)
- Ingress-pin constraint: `packages/gateway/src/http/ingress-pin.test.ts`
- `packages/gateway/AGENTS.md` (execution is Discord-only; transport-agnostic primitive deferred)
- Related plan (Discord I/O centralization pattern): `docs/plans/2026-06-09-004-refactor-gateway-discord-io-helper-plan.md`
- Auth primitives: `packages/gateway/src/http/hmac.ts`, `packages/gateway/src/http/config.ts`
- Bindings store: `packages/gateway/src/bindings/store.ts`
