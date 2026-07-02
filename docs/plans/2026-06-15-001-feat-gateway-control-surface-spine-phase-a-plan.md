---
title: 'feat: Gateway control surface spine — Phase A (transport-agnostic execution + approval extraction)'
type: feat
status: done
date: 2026-06-15
deepened: 2026-06-15
origin: docs/brainstorms/2026-06-15-gateway-control-surface-spine-requirements.md
---

> **Status: done.** All 5 units shipped: characterization tests, `LaunchWorkRequest`/`StatusSink`/`ReplySink`, `launchWork` extracted from `startRun`, `runMention` as a thin Discord adapter, and the transport-neutral approval coordinator seam — verified on `main` (`packages/gateway/src/execute/launch-types.ts`, PR #920).

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
- `RunTask = { readonly message: Message; readonly binding: RepoBinding; readonly deps: RunMentionDeps }` (line 97) — the `message: Message` field is the primary Discord coupling to extract.
- `RunMentionDeps` (line 28) includes: `coordinationConfig`, `identity`, `concurrency`, `queue: ChannelQueue<RunTask>`, `attachUrl`/`attachToken`, `runTimeoutMs`, `botUserId`, `persona`, `logger`, `approvalRegistry: ApprovalRegistry`, `approvalMode`, `statusMode: 'live-status' | 'typing-only'`, `ensureClone`, `readyz`, `isShuttingDown`.
- The Discord coupling is concentrated in: `RunTask.message: Message` (threaded through the engine for prompt-building and status replies) and the status/reply surface that writes back to that message.

**Approval coordinator (`packages/gateway/src/approvals/coordinator.ts`):**
- `createPermissionCoordinator(deps: PermissionCoordinatorDeps)` at line 206.
- `PermissionCoordinatorDeps.onPending` (`coordinator.ts:94`): "renders the Discord approval embed here AND registers the entry in the approval registry (including deadlineMs)." Plus `onReplied` (→ `registry.confirmReply`) and `onDispose` (→ `registry.disposeRun`). These deps callbacks are the transport-coupling seam to generalize. Public surface: `onPermissionAsked`/`onPermissionReplied` (`:72`/`:78`). (There is no `onRequest` callback.)
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

> **Plan vetted against current source (Oracle, main `0fa4ed32`).** The seam direction is sound, but the original anchors predated recent gateway churn (Discord `io.ts` refactor #858, serial queue #850, status controller #843, operator commands #854/#859). The decisions and units below incorporate that vetting. Line numbers are indicative, not authoritative — implementers verify against current source.

- **`launchWork` is the public, queue-and-cap-preserving front door (decision).** `launchWork(request, deps)` acquires the per-channel slot / enqueues / respects the global concurrency cap exactly as `runMention` does today, then drives the long post-acquire pipeline via a **private inner primitive** (e.g. `executeWorkOnHeldSlot(task)`). A future web caller goes through the front door and **cannot bypass** the per-channel FIFO, global cap, or shutdown handoff. The inner primitive is internal-only and is never exported as a "core" that dodges the queue. This is the load-bearing correction: `startRun` today assumes the channel slot is already held and owns atomic handoff/release in its outer `finally` (`run.ts:726-764`), draining via `queue.takeNext(channelId)` — exposing that inner body directly would be a concurrency footgun.
- **`LaunchWorkRequest` carries sinks, not a `Message`.** The engine receives `StatusSink` and `ReplySink` interfaces rather than a raw Discord `Message`. The Discord adapter constructs concrete implementations of these interfaces from the `Message` and passes them in. This is the minimal seam: the engine's logic is unchanged, only its input contract changes.
- **Empty-prompt behavior IS changing in Phase A (deliberate, accepted).** Today a bare `@fro-bot` mention proceeds through thread creation, lock acquisition, and run-state setup before `buildDiscordPrompt` throws `EmptyPromptError` late in the engine (`prompt.ts:110-114`), so the "nothing to do" failure surfaces *in-thread* after churn. The Discord adapter will strip the mention and detect an empty prompt **before** calling `launchWork`, failing fast with no thread/lock/run-state churn. This is a small, intentional UX improvement and a documented exception to "zero Discord behavior change" — characterize the current behavior first, then assert the new fail-fast behavior. (This is the only accepted Discord behavior delta in Phase A.)
- **Generalize the approval registry/coordinator names now, for Phase B readiness (decision).** Rename Discord-shaped registry terms to transport-neutral ones in Phase A: `channelID` → `approvalScopeId`, `handleButtonDecision` → `handleDecision`, `decidedBy: string` → a typed actor/operator identity. Extract the Discord approval transport from the `run.ts` `onPending` closure (`run.ts:396-536`) and the `program.ts` button handler (`program.ts:205-260`). This makes Phase B a clean plug-in rather than inheriting Discord-shaped names to rename later. No web auth/listener in Phase A.
- **`runMention` stays as the Discord entry point, becomes a thin adapter.** It does not disappear — it maps `Message` → `LaunchWorkRequest` and calls `launchWork`. The `ChannelQueue<RunTask>` continues to work; `RunTask` carries a `LaunchWorkRequest` (or the sinks) rather than a raw `Message` where feasible, keeping the change minimal.
- **Approval coordinator: the transport seam is the `onPending` + `onReplied` + `onDispose` deps callbacks, not a single render hook.** `PermissionCoordinatorDeps.onPending` (`coordinator.ts:94`) is the render-and-register hook — its doc states it "renders the Discord approval embed here **AND registers the entry in the approval registry** (including deadlineMs)." Render and registry-registration are coupled in this one callback, so the transport-neutral generalization must preserve that coupling (a transport renders its UI *and* registers the entry together), not split them. The decision-intake path is `onPermissionReplied`/`onReplied` → `registry.confirmReply`; teardown is `onDispose` → `registry.disposeRun` (fail-close). The public coordinator surface (`onPermissionAsked`/`onPermissionReplied`, `coordinator.ts:72`/`:78`) and the pure parsers (`parsePermissionRequest`/`parsePermissionReply`) are unchanged. Generalizing means a Discord transport supplies `onPending`/`onReplied`/`onDispose` implementations (embed + button wiring), and a future web transport supplies its own (notification + HTTP callback) — both reusing the same registry and fail-closed settlement.
- **One gate, no parallel path (R5).** The registry owns pending state and settlement. Any new transport plugs into the same registry via the `onPending`/`onReplied`/`onDispose` callbacks — it cannot create a parallel registry or bypass the fail-closed timeout/restart semantics.
- **Characterization-first / test-first execution.** Before refactoring Units 2 and 3, write characterization tests that pin the current Discord behavior (status message posted/edited, mention stripped, queue/concurrency, approval button flow). These tests must pass before and after the refactor. This is the zero-regression guarantee.
- **Minimal diff, behavior-preserving.** The goal is a seam, not a rewrite. `startRun` internals are not restructured beyond what is needed to accept `LaunchWorkRequest` + sinks instead of `RunTask.message`. The Discord adapter in `runMention` is the only new code path.

## Open Questions

### Resolved During Planning

- **Does Phase A need a new listener?** No — Phase A is purely a refactor that adds a seam. No new `serve()` call, no ingress-pin change.
- **Should `RunTask` be eliminated?** No — `RunTask` continues to work; it carries `LaunchWorkRequest` (or the sinks) instead of a raw `Message`. Minimal change.
- **Can `parsePermissionRequest`/`parsePermissionReply` stay as-is?** Yes — they are already pure and transport-agnostic. Phase A does not touch them.
- **What is the right seam for the approval coordinator?** The `PermissionCoordinatorDeps` callbacks `onPending` (render + register), `onReplied` (→ `registry.confirmReply`), and `onDispose` (→ `registry.disposeRun`) — `coordinator.ts:94`+. These are the documented transport-coupling points. Note `onPending` couples rendering with registry-registration, so the generalization keeps render+register together per transport rather than splitting them. (There is no `onRequest` callback — verified against source.)
- **Does Phase A change the Discord user experience?** No — R2 and R3 are explicit: same status message, typing indicator, queue behavior, reactions, and approval button flow.

### Deferred to Implementation

- Exact names and shapes for `StatusSink`, `ReplySink`, and `LaunchWorkRequest` — to be determined during Unit 1 based on what `startRun` actually reads from `RunTask.message`.
- Whether `RunTask` carries a `LaunchWorkRequest` directly or carries the sinks as separate fields — implementer decides based on the minimal-diff principle.
- Exact shape of the generalized `onPending`/`onReplied` transport implementations (and whether a small transport-descriptor type is worth introducing) — to be determined during Unit 4 based on how the coordinator awaits the decision today.
- Whether a characterization test file is a separate Unit 0 or is folded into Units 2 and 3 as a pre-condition — execution decision for the implementer.

## High-Level Technical Design

The design introduces a thin interface layer between the Discord transport and the execution engine. The engine (`launchWork`) receives a `LaunchWorkRequest` that carries:

- Prompt text and source metadata (extracted from the Discord `Message` by the adapter)
- `RepoBinding` (owner, repo, channelId — unchanged)
- Requester identity (Discord user ID or future web operator identity)
- `StatusSink` — an interface the engine calls to post/update status progress (the Discord adapter implements this over the existing live-status/typing message flow)
- `ReplySink` — an interface the engine calls to deliver the final run output (the Discord adapter implements this over `Message.reply`)

The Discord adapter (`runMention`) maps `Message` → `LaunchWorkRequest`, constructs the Discord `StatusSink`/`ReplySink` implementations, and calls `launchWork`. The `ChannelQueue<RunTask>` continues to enqueue work; `RunTask` carries the `LaunchWorkRequest` instead of the raw `Message`.

The approval coordinator's transport callbacks are generalized: `onPending` renders the approval UI **and** registers the entry in the registry (Discord embed today; a web notification in future), `onReplied` forwards the decision to `registry.confirmReply`, and `onDispose` fail-closes via `registry.disposeRun`. The registry and fail-closed settlement (timeout/restart → reject/dispose) are unchanged. The Discord embed+button handler becomes one implementation of these callbacks; a future web transport supplies its own.

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

Approval path (transport callbacks: onPending render+register, onReplied → confirmReply):
coordinator (onPermissionAsked / onPermissionReplied)
    │
    ├── Discord impl: onPending renders embed + registers → button → onReplied → registry.confirmReply
    └── Future web impl: onPending renders notification + registers → HTTP callback → onReplied → registry.confirmReply
                                                               ▲
                                                    registry (fail-closed: timeout/dispose, unchanged)
```

A future web caller (Phase B) will call `launchWork` directly with its own `StatusSink`/`ReplySink` implementations (e.g., SSE stream) and plug into the same approval coordinator via web `onPending`/`onReplied`/`onDispose` implementations.

## Implementation Units

- [x] **Unit 0: Characterization tests pinning current Discord behavior (mandatory)**

  **Goal:** Lock the current `runMention → startRun` and approval behaviors with tests that pass before AND after the refactor — the zero-regression gate. This is not optional; the engine has many edge behaviors (queue/cap, thread creation, live-status vs typing-only, reactions, approval waiting/timeout, empty-prompt) that a seam extraction can silently break.

  **Requirements:** R2, R3, R6 (guards the zero-change contract)

  **Dependencies:** None

  **Files:**
  - Test: `packages/gateway/src/execute/run.test.ts` (extend), `packages/gateway/src/approvals/coordinator.test.ts` (extend)

  **Approach:**
  - Pin, via the existing Discord `Message`-based entry points, the observable behaviors that must not change: per-channel queue scope + global concurrency cap + FIFO handoff; thread creation (`message.startThread`); reactions lifecycle (working/awaiting/succeeded/failed); `statusMode: 'live-status'` (status message posted+edited) vs `'typing-only'` (typing pulse, no status message); approval waiting → button decision → settle; approval timeout → fail-closed reject; shutdown handoff.
  - **Capture current empty-prompt behavior explicitly** (bare mention → late `EmptyPromptError` surfaced in-thread) so the deliberate Phase-A change (fail-fast in adapter) is a visible, reviewed diff, not a silent regression.

  **Test scenarios:**
  - Characterization: each behavior above asserted against the current code path; all green on unmodified `main`.

  **Verification:** the new characterization tests pass on current `main` before any refactor; they remain the regression gate through Units 2–4.

- [x] **Unit 1: Define transport-neutral types — `LaunchWorkRequest`, `StatusSink`, `ReplySink`**

  **Goal:** Establish the typed interface contract that the engine will accept and the Discord adapter will implement. No runtime behavior changes in this unit.

  **Requirements:** R1, R3

  **Dependencies:** None

  **Files:**
  - Create: `packages/gateway/src/execute/launch-types.ts` (or `packages/gateway/src/execute/types.ts` if a types file already exists — check first)

  **Approach:**
  - Inventory **every** `message` read across the full `startRun` body (`run.ts:184-765`) and `runMention` (`run.ts:805-834`) — NOT just lines 1–100. Oracle's verified coupling list (current `main`): `message.channel.id` for queue/concurrency scope (`run.ts:205`, `:807`); pre-thread failure/queue/cap reply acks via `sendMessage(message, …)` (`:229`, `:252`, `:264`, `:793-803`, `:822`); thread creation `message.startThread(...)` (`:259-268`); source-message reactions `setRunReaction(message, …)` (`:370`, `:465`, `:574`, `:635`); prompt text `message.content` (`:376-382`); status/typing via `createStatusController({thread, mode})` (`:347-351`) and `createDiscordStreamSink(thread)` (`:375`). These reads define the sink/request interface surface. Note: lock + run-state are written with `surface: 'discord'` (`:273`, `:300`) — Phase A introduces a transport-neutral surface/source identifier so a future web run is not a fake Discord thread.
  - Define `LaunchWorkRequest` with: prompt text (string), source metadata (channel/guild IDs for logging), `RepoBinding`, requester identity (Discord user ID or future operator identity as a discriminated union), `StatusSink`, `ReplySink`.
  - Define `StatusSink` interface: the methods the engine calls to post/update status progress (e.g., `update(text: string): Promise<void>`, `setTyping(): Promise<void>`).
  - Define `ReplySink` interface: the method the engine calls to deliver final output (e.g., `send(content: string, options?: ReplyOptions): Promise<void>`).
  - Use `unknown` + narrowing and discriminated unions; no `any`.

  **Patterns to follow:** existing `RunMentionDeps` and `RunTask` type shapes in `run.ts`; `Result<T, E>` from `@bfra.me/es`; discriminated union patterns used elsewhere in the gateway.

  **Test scenarios:**
  - Types-only unit: no runtime behavior. Verification is `pnpm --filter @fro-bot/gateway check-types` clean and the type shapes satisfy the constraints (e.g., a Discord `Message`-based implementation satisfies `StatusSink`/`ReplySink` structurally).
  - Structural: a mock object implementing `StatusSink` compiles without cast; a mock `LaunchWorkRequest` with a Discord requester identity compiles; a future web requester identity shape also compiles (discriminated union covers both).

  **Verification:** `pnpm --filter @fro-bot/gateway check-types` clean; the new types file exports `LaunchWorkRequest`, `StatusSink`, `ReplySink`; no `any` or `@ts-ignore`; the Discord `Message`-derived implementations in Unit 3 satisfy the interfaces structurally.

- [x] **Unit 2: Extract `launchWork` core from `startRun`**

  **Goal:** Move the execution engine to accept `LaunchWorkRequest` + sinks instead of `RunTask.message`. `startRun` is updated to bridge `RunTask` → `LaunchWorkRequest` (or `RunTask` carries `LaunchWorkRequest` directly). The engine runs against a fake/in-memory sink with no Discord dependency.

  **Requirements:** R1, R6

  **Dependencies:** Unit 0 (characterization gate), Unit 1

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

  **Verification:** `pnpm --filter @fro-bot/gateway check-types` clean; `pnpm --filter @fro-bot/gateway test` passes (existing `run.test.ts` + new `launchWork` tests); `launchWork` is exported and accepts `LaunchWorkRequest` + in-memory sinks; no Discord import in `launchWork`'s own logic.

- [x] **Unit 3: Make `runMention` a thin Discord adapter**

  **Goal:** `runMention` maps a Discord `Message` → `LaunchWorkRequest`, constructs Discord `StatusSink`/`ReplySink` implementations over the existing live-status/typing message flow, and calls `launchWork`. Zero change to the Discord user experience.

  **Requirements:** R2, R3

  **Dependencies:** Unit 0 (characterization gate), Units 1, 2

  **Files:**
  - Modify: `packages/gateway/src/execute/run.ts` (the `runMention` function and the Discord sink implementations)
  - Test: `packages/gateway/src/execute/run.test.ts` (Discord adapter behavior tests)

  **Approach:**
  - **Characterization-first:** the Unit 0 characterization tests cover the Discord-path behavior (status message posted/edited, mention stripped via `botUserId`, queue/concurrency, reactions). These must pass before and after this unit (except the deliberate empty-prompt delta below).
  - **Adapt the existing `StatusController` and `DiscordStreamSink` — do NOT reimplement `statusMode`.** The status controller (`packages/gateway/src/discord/status-message.ts`, `createStatusController`) already owns `live-status` vs `typing-only` (typing pulse in both modes, status-message suppression in `typing-only`, final-answer/failure delegation). The `DiscordStatusSink` wraps/adapts `createStatusController` over the new interface; it does not re-derive the mode logic. The `DiscordReplySink` delegates to the `io.ts` safe-send boundary (`sendMessage`/`editMessage`) and the existing `createDiscordStreamSink` — never raw `message.reply`/`thread.send` (preserves the `allowedMentions:{parse:[]}` + fail-soft invariants the `io.ts`/boundary tests enforce).
  - `runMention` extracts prompt text from `message.content`, strips the bot mention via `botUserId`, and **fails fast on an empty prompt before calling `launchWork`** (the accepted behavior change — see KTD; no thread/lock/run-state churn). On a non-empty prompt it constructs the `LaunchWorkRequest` with the Discord sinks and enqueues via `launchWork`'s front door.
  - The `Message` object is consumed entirely in the adapter — it is not passed into the inner execution primitive. Reactions and thread creation are driven through adapter-provided sink/lifecycle hooks, not by handing the engine a raw `Message`.

  **Patterns to follow:** existing `runMention` mention-strip logic; the `createStatusController` mode handling in `status-message.ts` (adapt, don't reimplement); the `discord/io.ts` safe-send boundary (`sendMessage`/`editMessage`, `SendCapable`/`ReplyCapable`) — note `io.ts` does NOT already define `StatusSink`/`ReplySink`, so those are net-new in Unit 1; the Discord sink implementations delegate to `io.ts` for safety invariants.

  **Test scenarios:**
  - Happy path: `runMention` with a real Discord `Message` mock calls `launchWork` with a `LaunchWorkRequest` whose prompt text has the bot mention stripped; the `StatusSink` posts a status message; the `ReplySink` sends the final output.
  - `statusMode: 'live-status'`: status message is posted and edited as the run progresses.
  - `statusMode: 'typing-only'`: typing indicator is set; no status message posted.
  - Mention strip: `@fro-bot prompt text` → `prompt text` (via `botUserId`); leading/trailing whitespace trimmed.
  - Queue/concurrency: a second `runMention` for the same channel is queued; the first run completes before the second starts.
  - Reactions: existing reaction behavior (if any) is preserved.
  - Regression: the Discord user experience is identical to pre-refactor (status message content, timing, error messages unchanged).

  **Verification:** `pnpm --filter @fro-bot/gateway check-types` clean; `pnpm --filter @fro-bot/gateway test` passes; `runMention` no longer passes a `Message` into `launchWork`/`startRun`; the Discord sink implementations satisfy `StatusSink`/`ReplySink` structurally; characterization tests pass.

- [x] **Unit 4: Generalize the approval coordinator seam**

  **Goal:** Generalize the approval coordinator's transport callbacks (`onPending`, `onReplied`, `onDispose`) so a non-Discord transport can render+register an approval, settle a decision, and fail-close teardown via the same registry. The Discord embed+button flow becomes one set of implementations. The registry and fail-closed settlement are unchanged. A decision from a non-Discord source settles via the same gate.

  **Requirements:** R4, R5

  **Dependencies:** Units 1, 2, 3 (the `LaunchWorkRequest` + sinks pattern is established; the coordinator is wired via `approvalRegistry` in `RunMentionDeps`)

  **Files:**
  - Modify: `packages/gateway/src/approvals/registry.ts` (generalize Discord-shaped names — `channelID` → `approvalScopeId`, `handleButtonDecision` → `handleDecision`, `decidedBy: string` → typed actor identity; fail-closed settlement logic unchanged)
  - Modify: `packages/gateway/src/execute/run.ts` (extract the Discord approval transport from the `onPending` closure at `:396-536`)
  - Modify: `packages/gateway/src/approvals/coordinator.ts` (the coordinator is already mostly generic; confirm the `onPending`/`onReplied`/`onDispose` deps contract and the deprecated `onSettled` at `:109-114` — preserve or deliberately remove with its tests, don't leave it dangling)
  - Modify: `packages/gateway/src/program.ts` (the Discord button decision handler at `:205-260` — point it at the renamed `handleDecision`)
  - Test: `packages/gateway/src/approvals/coordinator.test.ts` + `registry.test.ts` (non-Discord render+register and decision intake; renamed-API tests; preserve `onSettled` coverage or update it)

  **Approach:**
  - The real Discord coupling for approvals is NOT in `coordinator.ts` (already mostly generic) — it lives in the `run.ts` `onPending` closure (`:396-536`, renders the embed + registers), the `program.ts` button handler (`:205-260`, intakes the decision), and the Discord-shaped registry names. Extract a Discord approval *transport* from the `run.ts` closure so a future web transport can supply its own render+register/decision/teardown without a parallel registry. Generalize the registry names (KTD) so the decision path is `handleDecision({approvalScopeId, actor, ...})`, not `handleButtonDecision({channelID})`.
  - Read `coordinator.ts` in full to confirm the current callback contract. Verified seam (do not look for `onRequest` — it does not exist; note the deprecated `onSettled` at `:109-114`):
    - `PermissionCoordinatorDeps.onPending` (`coordinator.ts:94`) — renders the approval UI **and registers the entry in the approval registry** (including `deadlineMs`); render and registration are coupled in this one hook.
    - `PermissionCoordinatorDeps.onReplied` — forwards the decision to `registry.confirmReply`.
    - `PermissionCoordinatorDeps.onDispose` — calls `registry.disposeRun(sessionID, reason)` to fail-close on teardown.
    - Public coordinator surface: `onPermissionAsked` (`:72`) / `onPermissionReplied` (`:78`).
  - Generalize so the Discord transport supplies `onPending` (embed + register), `onReplied` (button→`confirmReply`), and `onDispose` implementations, and a future web transport supplies its own (notification + register, HTTP callback→`confirmReply`, teardown→`disposeRun`). Keep render+register coupled per transport — do not split them, since `onPending` owns both today.
  - `parsePermissionRequest`/`parsePermissionReply` are unchanged — they remain the pure parsing core.
  - The registry's fail-closed settlement (timeout/restart → reject/dispose) and deadline ownership are unchanged.
  - Write a test that drives render+register and a decision from a non-Discord source (plain function calls simulating a web transport) and verifies it settles via the same registry.

  **Patterns to follow:** the existing `onPending`/`onReplied`/`onDispose` deps callback shapes in `coordinator.ts`; `registry.confirmReply`/`disposeRun` call patterns in `registry.ts`; `vi.hoisted()` + `vi.mock()` for test isolation.

  **Test scenarios:**
  - Happy path (Discord): `onPending` renders+registers → a button interaction drives `onReplied` → `registry.confirmReply` → the coordinator resolves the request as approved.
  - Happy path (non-Discord): a plain `onPending`/`onReplied` pair (simulating a web transport) renders+registers and settles → `registry.confirmReply` → resolved as approved.
  - Fail-closed (timeout): no decision within the deadline → registry settles as reject → coordinator resolves as rejected.
  - Fail-closed (dispose/restart): `onDispose` → `registry.disposeRun` fail-closes pending entries.
  - One gate: two concurrent requests from different transports both settle via the same registry; neither bypasses fail-closed semantics or creates a parallel registry.
  - `parsePermissionRequest`/`parsePermissionReply` unchanged: existing parse tests still pass.

  **Verification:** `pnpm --filter @fro-bot/gateway check-types` clean; `pnpm --filter @fro-bot/gateway test` passes; a non-Discord transport renders+registers and settles via the same registry; fail-closed timeout/dispose behavior preserved and tested; `parsePermissionRequest`/`parsePermissionReply` tests unchanged; no reference to a nonexistent `onRequest`.

## System-Wide Impact

- **Interaction graph:** `runMention` → `launchWork` → `StatusSink`/`ReplySink` (Discord implementations). The `ChannelQueue<RunTask>` is unchanged. The approval coordinator is wired via `approvalRegistry` in `RunMentionDeps` — unchanged from the caller's perspective.
- **Error propagation:** unchanged — the engine's error handling (timeout, shutdown, run failure) is preserved; errors are surfaced via `StatusSink`/`ReplySink` to the transport, not thrown into the queue.
- **State lifecycle:** no persistence changes. The registry's in-memory pending state and fail-closed settlement are unchanged.
- **API surface parity:** `runMention` signature is unchanged (it is the Discord entry point); `launchWork` is a new export. The approval coordinator's `onPending`/`onReplied`/`onDispose` deps-callback contracts change shape (generalized), but the Discord implementations are updated in the same PR.
- **Sequencing:** Unit 0 (characterization gate) → Unit 1 (types) → Unit 2 (engine extraction + front-door/inner split) → Unit 3 (Discord adapter, empty-prompt fail-fast) → Unit 4 (approval transport extraction + registry rename). Units 2, 3, and 4 all modify `run.ts` (Unit 4 extracts the `onPending` closure from it), so they are serial, not parallel. Unit 0 must be green on unmodified `main` before any refactor begins.
- **Unchanged invariants:** Discord user experience (status message, typing indicator, queue behavior, reactions, approval button flow), ingress-pin constraint (`server.ts` has exactly one `serve()`), `parsePermissionRequest`/`parsePermissionReply` pure parsing, registry fail-closed settlement, `ChannelQueue<RunTask>` concurrency model.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `startRun` reads more from `RunTask.message` than expected, making the `StatusSink`/`ReplySink` interface surface larger than anticipated | Unit 1 inventories all `message` reads before defining the interfaces; the interface surface is driven by actual usage, not assumption |
| Discord behavior regression (status message, mention strip, queue, reactions) | Characterization-first in Units 2 and 3: pin current behavior before refactoring; the characterization tests are the zero-regression gate |
| `RunTask` type change breaks other callers of the queue | `RunTask` change is minimal (carry `LaunchWorkRequest` instead of raw `Message`); all callers are in `run.ts` and are updated in the same unit |
| Approval coordinator callback generalization breaks the Discord button flow | Unit 4 updates the Discord `onPending`/`onReplied`/`onDispose` implementations in the same PR; the Discord button tests must pass before and after |
| A future web approval path creates a parallel registry (bypassing fail-closed) | R5 is explicit: one gate. The registry is the trust anchor. The `onPending`/`onReplied`/`onDispose` callbacks are the only approved extension points. Code review enforces this. |
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

- After Phase A merges: update `packages/gateway/AGENTS.md` to reflect that the transport-agnostic execution primitive now exists (`launchWork`) and that the approval coordinator's `onPending`/`onReplied`/`onDispose` callbacks are the approved extension points for new transports. Remove or update the "deferred until a non-Discord caller exists" note.
- The `launchWork` function and the `StatusSink`/`ReplySink` interfaces should be documented with JSDoc comments explaining the transport-neutral contract and the Discord adapter pattern, so future implementers (Phase B) know exactly what to implement.
- No infra changes in Phase A. Phase B requires coordination with `marcusrbrown/infra` on the deploy topology before any new listener lands.
- Verification commands — **gateway-scoped** (the root `pnpm check-types`/`lint`/`test` scripts filter runtime/action/harness only and do NOT cover the gateway package): `pnpm --filter @fro-bot/gateway check-types`, `pnpm --filter @fro-bot/gateway lint`, `pnpm --filter @fro-bot/gateway test`, `pnpm --filter @fro-bot/gateway build`. All must pass before merge. (`pnpm bootstrap` first if deps changed.)

## Sources & References

- Origin brainstorm (local-only/gitignored): `docs/brainstorms/2026-06-15-gateway-control-surface-spine-requirements.md`
- Tracking issue: [fro-bot/agent#907](https://github.com/fro-bot/agent/issues/907)
- North-star: `fro-bot/.github` `docs/brainstorms/2026-06-15-fro-bot-personal-agent-north-star-requirements.md`
- Execution engine: `packages/gateway/src/execute/run.ts` (834 lines; `runMention` at line 805, `startRun` at line 184, `RunTask` at line 97, `RunMentionDeps` at line 28)
- Approval coordinator: `packages/gateway/src/approvals/coordinator.ts` (`createPermissionCoordinator` at line 206; deps callbacks `onPending` at line 94, `onReplied`, `onDispose`; public `onPermissionAsked` at line 72 / `onPermissionReplied` at line 78)
- Approval registry: `packages/gateway/src/approvals/registry.ts` (pending state + fail-closed settlement)
- Ingress-pin constraint: `packages/gateway/src/http/ingress-pin.test.ts`
- `packages/gateway/AGENTS.md` (execution is Discord-only; transport-agnostic primitive deferred)
- Related plan (Discord I/O centralization pattern): `docs/plans/2026-06-09-004-refactor-gateway-discord-io-helper-plan.md`
- Auth primitives: `packages/gateway/src/http/hmac.ts`, `packages/gateway/src/http/config.ts`
- Bindings store: `packages/gateway/src/bindings/store.ts`
