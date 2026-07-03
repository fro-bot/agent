---
title: "feat: Serial per-channel queue for mention loop"
type: feat
status: completed
date: 2026-06-09
origin: docs/brainstorms/2026-06-07-mention-loop-production-ready-requirements.md
deepened: 2026-06-09
completed: 2026-06-09
---

# feat: Serial per-channel queue for mention loop

## Overview

Replace the gateway mention loop's current "reject a second mention while a same-channel run is in flight" behavior with a **serial per-channel queue**: a mention that arrives while the channel is busy is acknowledged and queued, then runs automatically when the in-flight run finishes. Add a `/fro-bot clear-queue` subcommand to drop pending queued tasks (the in-flight task always runs to completion). This is Phase 3 of the mention-loop production-readiness effort (Phases 1–2 — rendering/persona and working-state UX — already shipped) and resolves success criterion SC5 (see origin).

## Problem Frame

Today, `runMention` acquires a per-channel concurrency slot via `concurrency.tryAcquire(channelId)`; when the channel already has an active run it returns `'busy'`, and `run.ts` replies "There is already a task running in this channel — please wait for it to finish." and stops (a terminal reject). For a busy channel this feels broken — the user must manually retry. The brainstorm's SC5 requires the second mention to be **queued and run**, not rejected.

The current control flow is the key constraint: `handleMention` (`packages/gateway/src/discord/mentions.ts`) `await`s `runMention` (`packages/gateway/src/execute/run.ts`), and the per-channel slot is acquired *inside* `runMention`. A queue changes this — an enqueued mention must be acknowledged and return without blocking the interaction, then start when the in-flight run's slot release fires.

Two serialization layers exist and only one changes: the **per-channel concurrency slot** (`'busy'` path — this becomes a queue) and the **per-repo S3 lock** (`acquireLock`, unchanged). The **global concurrency cap** (`'cap'` path) also stays terminal — a global-capacity rejection is not queued in v1. The queue is keyed by **Discord channel ID** (`message.channel.id`); thread messages are already ignored by `handleMention`.

## Requirements Trace

- R1. A mention arriving while its channel has an in-flight run is **queued**, not rejected, and the user gets a brief "queued" acknowledgement (SC5).
- R2. When the in-flight run completes (success or failure), the next queued task for that channel **starts automatically** (SC5).
- R3. `/fro-bot clear-queue` drops all pending queued tasks for the invoking channel; the in-flight task is unaffected and runs to completion (SC5).
- R4. The queue is **in-memory** per channel; tasks pending at gateway restart are lost (documented, not solved — per the Unit 6 R11 boundary, see origin).
- R5. The per-repo lock, the global concurrency cap (`'cap'` reject), and all existing run lifecycle behavior (thread/lock/run-state/heartbeat/execution/release ordering) are unchanged.
- R6. The `'cap'` global-capacity path remains a terminal reject (not queued) in v1.

## Scope Boundaries

- Non-goal: persistent/cross-restart queue (in-memory only, R4).
- Non-goal: queuing on global-cap rejection (`'cap'` stays terminal, R6).
- Non-goal: changing the per-repo lock or the run lifecycle internals.
- Non-goal: per-queue prioritization, reordering, or per-user fairness — strict FIFO per channel.
- Non-goal: a queue-position/status display beyond the initial "queued" ack (no live "you are 2nd in line" updates in v1).

### Deferred to Separate Tasks

- Phase 4 — core commands (`/fro-bot sessions`, `/fro-bot resume`, `/fro-bot force-release-lock`) + native approval UX: separate phase per the origin's build order. **Note for Phase 4:** all commands must be `/fro-bot` subcommands (matching the existing `ping`/`add-project`/`clear-queue` convention), never top-level slash commands.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/execute/concurrency.ts` — `ConcurrencyRegistry`: `tryAcquire(channelId) -> 'ok'|'cap'|'busy'`, `release(channelId)`, global cap + `activeChannels` set, in-memory by design. The `'busy'` branch is what the queue replaces.
- `packages/gateway/src/execute/run.ts` — `runMention(message, binding, deps)`: the slot dispatch (`tryAcquire` at ~189), the `'cap'`/`'busy'` terminal replies (~191–199), the happy path (ensureClone → readyz → startThread → acquireLock → run-state → heartbeat → execute), the inner finally `releaseLock`, and the **outer finally `concurrency.release(channelId)`** (~672–675) — the natural handoff point (replaced by the atomic handoff in Unit 2).
- `packages/gateway/src/discord/mentions.ts` — `handleMention`: ignores thread messages, auth + binding lookup, then `await runMention(...)`. `safeReply` with mentions disabled is the ack pattern.
- `packages/gateway/src/discord/commands/fro-bot.ts` — the `/fro-bot` command builder + subcommand dispatch (`interaction.options.getSubcommand(true)`); where `clear-queue` is added alongside `ping`/`add-project`.
- `packages/gateway/src/discord/commands/index.ts` — command registry + `dispatchCommand` + REST registration.
- `packages/gateway/src/program.ts` — builds the registry, registers slash commands, wires `interactionCreate` → `dispatchCommand`; also where the queue component is constructed and injected (like `concurrency`).

### Institutional Learnings

- The gateway mention-loop best-practices doc (`docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-*.md`) — bounded execution with guaranteed resource release (dual-finally), and the in-memory module-scoped registry pattern (breaks under multi-replica — acceptable for single-replica v1, same as `concurrency.ts` and the approval registry).
- The approval registry / coordination work established the register-before-act and ownership-gated patterns; the queue should follow the same fail-soft, single-owner discipline.

## Key Technical Decisions

- **Dedicated in-memory queue component** (`packages/gateway/src/execute/queue.ts`): a `ChannelQueue` keyed by Discord channel ID, holding pending tasks (FIFO). Mirrors `concurrency.ts` shape (factory returning an interface, module-injected via deps), in-memory by design. Chosen over making the `'busy'` path block/await — blocking would tie up the interaction and give no ack.

- **Explicit task descriptor (decided now, not deferred):** a queued task is `{message, binding, deps}` — exactly the three arguments `runMention` takes today. This is the stable contract the queue stores. No smaller capture is possible because `runMention` closes over nothing separate; the descriptor IS its argument tuple.

- **Extract `startRun(task)` from `runMention` (the re-entry seam):** today `runMention` both (a) makes the acquire/busy decision AND (b) runs the post-acquire pipeline (clone → readyz → thread → lock → run-state → heartbeat → execute → release). Split these: `startRun(task)` owns the post-acquire pipeline and assumes the channel slot is already held; `runMention` becomes the thin **front door** that decides acquire-now vs enqueue and either calls `startRun` or enqueues. Both the immediate path and the drain call the *same* `startRun` — so a queued task is replayed through the execution path only, not the acquire decision again. (Resolves the "re-enter runMention re-runs the whole pipeline" feasibility gap.)

- **Queue presence gates immediate-start (the FIFO fix):** a new mention must enqueue when the channel already has pending queued work, **even if a slot is free**. The decision is: if `pendingCount(channelId) > 0`, enqueue (never take an immediate `'ok'`); only the handoff path may start the next task. Without this, a fresh mention arriving in the gap after slot-release-before-drain would leapfrog older queued work (FIFO violation / starvation). So the front-door order is: if pending work exists → enqueue; else `tryAcquire` → `'ok'` runs now, `'busy'` enqueues, `'cap'` terminal-rejects.

- **Atomic handoff, not release-then-drain (the serial-safety fix):** the in-flight run must NOT fully release the channel slot and then separately drain — that opens a window where a new mention sees `'ok'` and starts concurrently with the drained task (two runs, same channel). Instead, on run completion the run path performs an **atomic handoff**: while the channel is still reserved, `queue.takeNext(channelId)`; if it returns a task, start it *holding the same slot* (no release/re-acquire gap); only when the queue is empty does `concurrency.release(channelId)` fire. The completing run triggers this in `startRun`'s outer finally — no timers/polling. (The queue exposes the atomic `takeNext`; the run path owns the take-or-release decision.)

- **`/fro-bot clear-queue` subcommand:** drops *pending* tasks for the invoking channel (not the in-flight run). Registered as a subcommand on the existing `/fro-bot` builder; the queue is plumbed into the command deps (the current command dep type carries no queue — it must be added and threaded `program.ts → getCommandRegistry → createFroBotCommand`).

- **Required per-channel depth cap (not optional):** a public Discord channel lets one user spam mentions while busy → unbounded queued tasks + acks (a real spam/memory/delayed-flood vector). v1 **requires** a per-channel depth cap with a deterministic overflow response: reject the newest mention with a terse "queue is full for this channel" reply. Default cap chosen at implementation (small, e.g. 5–10); surface as config only if needed.

- **Race-safe queue ops:** `enqueue`, the atomic `releaseOrHandoff`, `clear`, and `pendingCount` are all single-owner synchronous operations on the in-memory map (Node's single-threaded event loop makes each op atomic). `clear` racing a handoff is safe: handoff dequeues-and-commits atomically, so a task is either already handed off (runs) or still pending (cleared) — never both.

## Open Questions

### Resolved During Planning

- Queue keyed by channel or thread? Channel ID (`message.channel.id`) — matches `tryAcquire`; thread messages are ignored by `handleMention`.
- Does `/clear-queue` abort the in-flight run? No — in-flight runs to completion; only pending tasks are dropped (R3).
- Is the global `'cap'` path queued? No — stays terminal in v1 (R6).
- Top-level `/clear-queue` or subcommand? `/fro-bot clear-queue` subcommand (matches existing convention).

### Deferred to Implementation

- Exact `maxDepth` default value (small — 5–10) and whether it needs a config knob vs. a constant. The cap itself is required (resolved); only the number/config surface is deferred.
- Whether `startRun` is a standalone exported function or a closure inside `runMention`'s module — an internal structuring choice; the contract (`startRun(task)` owns the post-acquire pipeline, assumes slot held) is fixed.
- The exact queued-ack copy and the overflow ("queue is full") copy — wording, not behavior.

## Implementation Units

- [x] **Unit 1: In-memory channel queue component**

**Goal:** A `ChannelQueue` that holds pending per-channel tasks FIFO with an atomic `takeNext` pop, plus clear-by-channel and a required depth cap.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Create: `packages/gateway/src/execute/queue.ts`
- Test: `packages/gateway/src/execute/queue.test.ts`

**Approach:**
- Factory `createChannelQueue(maxDepth)` returning a readonly interface:
  - `enqueue(channelId, task) -> 'queued' | 'full'` — append FIFO; return `'full'` (reject newest) when the channel is at `maxDepth`.
  - `pendingCount(channelId) -> number` — pending depth for the channel (used by the front-door gate).
  - `clear(channelId) -> number` — drop all pending for the channel, return count dropped.
  - `takeNext(channelId) -> task | undefined` — atomic FIFO pop (the handoff primitive; single-owner, never returns the same task twice).
- In-memory `Map<channelId, task[]>`. Mirror `concurrency.ts` style (readonly interface, functions-only, strict booleans, in-memory by design). Each op is synchronous → atomic under Node's event loop.
- `task` is a typed descriptor `{message, binding, deps}` (the `runMention` argument tuple) — but the queue stays structurally agnostic; it stores and returns the descriptor opaquely.
- **Depth cap is required** (`maxDepth`, small default e.g. 5–10): `enqueue` returns `'full'` at the cap so the caller can reply "queue is full".

**Patterns to follow:**
- `packages/gateway/src/execute/concurrency.ts` (factory + readonly interface + in-memory Map/Set, module-injected).

**Test scenarios:**
- Happy path: enqueue two tasks for a channel → `takeNext` returns them FIFO; `pendingCount` reflects depth and decrements on take.
- Edge case: `takeNext` on empty channel → `undefined`; `clear` on empty → 0.
- Edge case: tasks for different channels are isolated (enqueue A doesn't affect B's take/count).
- R3: `clear(channelId)` drops only that channel's pending tasks and returns the count; other channels untouched.
- Required depth cap: enqueue at `maxDepth` returns `'full'`; pending tasks and other channels unaffected; after a `takeNext` frees a slot, enqueue succeeds again.
- Atomicity: two sequential `takeNext` calls never return the same task; interleaved enqueue + takeNext preserve FIFO and lose no task; `clear` after a `takeNext` drops only what remains.

**Verification:** Queue holds/returns tasks FIFO, isolates channels, enforces the depth cap, clears pending by channel, and `takeNext` never double-returns a task.

- [x] **Unit 2: `startRun` seam + front-door enqueue + atomic handoff**

**Goal:** Split `runMention` into an acquire-or-enqueue front door and a slot-holding `startRun` pipeline; replace the `'busy'` reject with enqueue+ack; hand the slot to the next queued task atomically on completion (no release-then-drain gap).

**Requirements:** R1, R2, R5, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/gateway/src/execute/run.ts` (extract `startRun(task)`; front-door gate; atomic handoff in the outer finally)
- Modify: `packages/gateway/src/program.ts` (construct `ChannelQueue`, inject into run deps alongside `concurrency`)
- Test: `packages/gateway/src/execute/run.test.ts` (extend)

**Approach:**
- **Extract `startRun(task: {message, binding, deps})`**: the post-acquire pipeline currently inside `runMention` (clone → readyz → thread → lock → run-state → heartbeat → execute → cleanup). It assumes the channel slot is already held. This is the single entry both the immediate path and the handoff call.
- **Front-door `runMention(message, binding, deps)`** becomes the gate, in this order:
  1. If `queue.pendingCount(channelId) > 0` → `enqueue` + queued ack (queued work has priority; never take an immediate slot ahead of it — the FIFO fix).
  2. Else `concurrency.tryAcquire(channelId)`:
     - `'ok'` → `startRun(task)` (slot held).
     - `'busy'` → `enqueue` + queued ack (or "queue is full" if `enqueue` returns `'full'`). Return without blocking. (Replaces the old terminal reject.)
     - `'cap'` → terminal capacity reply, no enqueue (R6).
- **Atomic handoff in `startRun`'s outer finally** (replaces `concurrency.release` + separate drain): call `queue.takeNext(channelId)` *while the slot is still held*. If it returns a task → start it on the held slot (`void startRun(next).catch(log)` — error-isolated, the slot stays owned by the chain). If it returns `undefined` → `concurrency.release(channelId)` (only now is the slot freed). This closes the release-before-drain window: a new mention can never see `'ok'` between a completion and the next task starting, because the slot is never free while pending work exists.
- The handoff `startRun` is fire-and-forget from the completing run's perspective (so cleanup completes), but the slot ownership transfers without a gap. A handoff-start failure logs and must still release the slot (its own finally runs the same handoff/release logic).
- `'ok'` happy path otherwise unchanged (R5); per-repo lock path unchanged.

**Execution note:** Add a failing integration-style test first for the front-door gate + atomic handoff contract (busy mention enqueues+acks; completion hands off to the next without freeing the slot; a new mention with pending work present enqueues rather than running), then implement.

**Patterns to follow:**
- The existing `tryAcquire`/`release` dual-finally ordering in `run.ts`; fire-and-forget `.catch` logging used elsewhere in the gateway (status/approval sends).

**Test scenarios:**
- R1: mention while channel busy → `enqueue` + queued ack (not the old reject reply); `startRun` not invoked synchronously for it.
- FIFO gate: a new mention arriving while `pendingCount > 0` is enqueued even though it could otherwise get `'ok'` — it does not leapfrog queued work.
- Serial safety (the core fix): when a run completes with a queued task present, the slot is handed off (next `startRun` runs) WITHOUT `concurrency.release` being called in between — assert no window where `tryAcquire` would return `'ok'` for that channel; two runs never overlap for one channel.
- R2: completion with a pending task → `takeNext` + next `startRun` starts; completion with empty queue → `concurrency.release` called, slot freed.
- R5/R6: `'ok'` path runs normally; `'cap'` replies terminally and does NOT enqueue; per-repo lock unchanged.
- Error path: a handed-off `startRun` that throws still releases/hands off the slot (its own finally), does not strand the queue, and logs.
- Overflow: enqueue returning `'full'` → terse "queue is full" reply; channel state unaffected.
- Integration: three mentions on a busy channel run strictly FIFO, each starting only after the prior completes, with no concurrent overlap.

**Verification:** A busy-channel mention is queued+acked and runs after the current finishes in FIFO order; the slot is handed off without a free-slot gap (no double-start); a new mention with pending work enqueues rather than leapfrogging; `'cap'`/lock behavior unchanged.

- [x] **Unit 3: `/fro-bot clear-queue` subcommand**

**Goal:** Operators/users can drop pending queued tasks for their channel; the in-flight run is unaffected.

**Requirements:** R3

**Dependencies:** Unit 1 (queue `clear`), Unit 2 (queue injected/available to commands)

**Files:**
- Modify: `packages/gateway/src/discord/commands/fro-bot.ts` (add `clear-queue` subcommand to the builder + dispatch)
- Modify: `packages/gateway/src/discord/commands/index.ts` (only if registry/deps wiring needs the queue)
- Modify: `packages/gateway/src/program.ts` (pass the `ChannelQueue` into command deps if not already)
- Test: `packages/gateway/src/discord/commands/index.test.ts` and/or a `fro-bot.test.ts` (extend)

**Approach:**
- Add a `clear-queue` subcommand to the existing `/fro-bot` builder (alongside `ping`/`add-project`). On invoke: `queue.clear(channelId)` for the interaction's channel, reply ephemerally with the number of pending tasks dropped (e.g. "Cleared N queued task(s). The running task will finish.").
- **Wire the queue into command deps:** the current command dep type (`AddProjectDeps`, passed via `program.ts → getCommandRegistry → createFroBotCommand`) carries no queue field. Add the `ChannelQueue` to the command deps type and thread it through those three sites so the subcommand handler can reach it. (Feasibility-flagged: the injection seam exists but must be explicitly extended.)
- The in-flight run is not touched (R3) — only pending tasks are dropped. `clear` racing a completion handoff is safe (Unit 1's `takeNext`/`clear` are atomic single-owner ops): a task is either already handed off or still pending, never both.
- Keyed by the interaction's channel ID, consistent with the queue/concurrency key.

**Patterns to follow:**
- The existing `/fro-bot` subcommand dispatch (`interaction.options.getSubcommand(true)`) and ephemeral reply style of `ping`/`add-project`.

**Test scenarios:**
- Happy path: `clear-queue` with N pending → queue `clear` called for the channel, ephemeral reply states N dropped.
- Edge case: `clear-queue` with empty queue → replies 0 dropped (no error).
- R3: `clear-queue` does not affect the in-flight run (only pending dropped) — assert the in-flight/active slot is untouched.
- Dispatch: `/fro-bot clear-queue` routes to the handler (subcommand dispatch wired correctly).

**Verification:** `/fro-bot clear-queue` drops pending tasks for the channel and reports the count; running task unaffected; registered/dispatched as a `/fro-bot` subcommand.

## System-Wide Impact

- **Interaction graph:** the handoff starts the next task from the completing run's outer finally via `void startRun(next).catch(log)` — each completion starts at most one successor (that successor's completion triggers the next handoff), so the chain is iterative, not unbounded recursion, and the stack does not grow (fire-and-forget detaches each link). The Discord interaction for a queued mention is acked immediately and not held open.
- **State lifecycle risks:** in-memory queue lost on restart (R4, documented). The handoff is in `startRun`'s outer `finally`, so it runs on success and failure paths — a task is never stranded by a normal throw. The only genuine stranding case is a hard crash between completion and handoff (process death) — acceptable under the in-memory v1 boundary (same as `concurrency.ts`'s active-set loss). Note: because queued work has priority (front-door gate), a stranded queue does NOT silently get leapfrogged by new mentions — new mentions enqueue behind it; the next *completion* handoff or a restart is what resolves it.
- **API surface parity:** `/fro-bot clear-queue` is the only new command surface; it follows the `/fro-bot` subcommand convention (and sets the precedent that ALL Phase 4 commands must be `/fro-bot` subcommands).
- **Unchanged invariants:** per-repo S3 lock, global concurrency cap (`'cap'` terminal), run-state/heartbeat/thread lifecycle, and the `'ok'` immediate-run path (when no pending work) are unchanged. The per-channel `'busy'` path changes from reject to queue, and a new front-door gate enqueues even on a free slot when pending work exists.
- **Integration coverage:** strict-FIFO across three queued mentions + the no-free-slot-gap handoff are the cross-layer scenarios unit-level mocks won't fully prove — covered by Unit 2's integration tests.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Free-slot gap double-starts a channel (new mention gets `'ok'` while a queued task also starts) | **Atomic handoff** — the slot is handed to the next task while still held; `concurrency.release` is called only when the queue is empty. No window where `tryAcquire` returns `'ok'` with pending work. Serial-safety test in Unit 2. |
| New mention leapfrogs older queued work (FIFO violation/starvation) | **Front-door gate** — `pendingCount(channelId) > 0` forces enqueue even on a free slot; only the handoff starts the next task. FIFO-gate test in Unit 2. |
| `takeNext` double-returns / loses a task | Atomic single-owner `takeNext` (Unit 1); atomicity tests. |
| Hard crash between completion and handoff strands a queued task | Accepted under the in-memory v1 boundary (R4); front-door priority means new mentions queue behind it (not leapfrog); resolved on next completion handoff or restart. |
| Unbounded enqueue from a spamming channel | **Required** per-channel depth cap (`maxDepth`) with a "queue is full" reply; FIFO bound. |
| `clear-queue` races a completion handoff | Atomic `takeNext`/`clear` — a task is either already handed off (runs) or still pending (cleared), never both. |
| Fire-and-forget handoff swallows errors silently | `.catch` logs; the handed-off `startRun`'s own finally still releases/hands off, so the queue never strands on a start failure. |

## Documentation / Operational Notes

- Update `packages/gateway/AGENTS.md` to document the serial per-channel queue (replaces reject-concurrent), the in-memory/restart-loss boundary, and the `/fro-bot clear-queue` subcommand.
- Note the single-replica assumption (module-scoped in-memory queue, same as `concurrency.ts`).

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-07-mention-loop-production-ready-requirements.md](../brainstorms/2026-06-07-mention-loop-production-ready-requirements.md) (Phase 3 / SC5)
- Related code: `packages/gateway/src/execute/concurrency.ts`, `packages/gateway/src/execute/run.ts`, `packages/gateway/src/discord/mentions.ts`, `packages/gateway/src/discord/commands/fro-bot.ts`, `packages/gateway/src/program.ts`
- Related learnings: `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-*.md`
