---
module: gateway control-surface spine
date: 2026-06-15
problem_type: architecture_pattern
component: tooling
severity: medium
related_components:
  - gateway execution engine
  - approval registry
  - discord adapter
tags:
  - transport-agnostic
  - approval-gate
  - queue-fifo
  - concurrency-cap
  - discord-adapter
  - fail-closed
  - characterization-tests
applies_when:
  - adding a non-discord control surface
  - refactoring mention-triggered gateway execution
  - generalizing approval intake beyond discord
  - preserving fifo and global concurrency semantics
  - extracting transport-neutral engine seams
---

# Transport-agnostic execution and approval seam

How to make a transport-coupled execution engine (Discord-mention-triggered) and its
tool-approval gate reusable by a future transport (web operator console) **without**
changing observable behavior, cloning the engine, or weakening the security boundary.

## Context

The gateway's agent run loop was reachable only through Discord: `runMention(message, …)`
read a raw discord.js `Message` throughout the post-acquire pipeline (queue scope, thread
creation, reactions, status, prompt), and the tool-approval gate rendered Discord embeds and
intook Discord button clicks inline. The gateway `AGENTS.md` carried a standing note that the
Discord coupling was "deferred until a non-Discord caller exists." That caller (an authenticated
web control surface) was about to land, so the coupling had to be resolved as a clean seam first
— and this was the **second** time the gateway hit this same wall, so the goal was a durable
abstraction, not another point fix.

The risk in a refactor like this is subtle: it is easy to (a) expose an inner execution path that
bypasses the per-channel FIFO queue / global concurrency cap, (b) silently change approval
scope-binding and weaken the fail-closed guarantee, or (c) leave two parallel engine paths alive.
All three are correctness/security regressions that tests written *after* the refactor would not catch.

## Guidance

1. **Put coordination in the public front door; keep the inner primitive private.** The queue,
   concurrency cap, FIFO handoff, and shutdown drain live in the exported entry point. The
   post-acquire pipeline is a *private* function that assumes the slot is already held and is never
   exported — so no transport can reach it without going through coordination.
2. **Pass sinks, not transport objects.** The engine receives narrow `StatusSink` / `ReplySink` /
   `CoreStreamSink` interfaces, never a raw `Message`. Reuse the transport library's own option types
   in the interface so the concrete adapter needs no casts. The adapter builds the sinks; the engine
   never imports the transport.
3. **One fail-closed approval gate, many transports.** Extract the transport-specific *render +
   decision-intake* into a transport module; keep the engine's approval hook transport-neutral; rename
   transport-shaped registry fields to neutral ones (`channelID`→`approvalScopeId`,
   `handleButtonDecision`→`handleDecision`, `decidedBy: string`→a typed actor union). Prove a
   non-transport decision settles through the **same** single-winner registry.
4. **Verify scope-equivalence explicitly — don't assume it.** When generalizing a security-relevant
   identifier, prove the new value equals the old one. Here a Discord thread *is* a channel, so
   `approvalScopeId: threadId` === the old `channelID: rawThread.id` and the button handler's
   `interaction.channelId` still matches. State this equivalence in the PR/commit so the boundary is
   provably unchanged.
5. **Characterize before you cut.** Write tests pinning observable behavior **green on unmodified
   code first**; they are the zero-regression gate through the extraction. Capture any *intended*
   behavior change as its own explicit, reviewed test diff — never let it hide inside the refactor.
6. **Collapse, don't fork.** An intermediate extraction step may leave two engine paths plus bridge
   scaffolding. The adapter step must collapse to ONE engine with no parallel path — verify by
   confirming the removed symbols have zero live references.
7. **Document the latent foot-guns for the next transport in code.** A seam built for one
   fail-soft transport hides assumptions the next transport will violate. Comment them where they live.

## Why This Matters

- **Coordination cannot be bypassed.** Because the inner primitive is unexported, a future web caller
  *must* go through `launchWork`'s queue + cap. There is no second door.
- **The security boundary is provably intact.** One registry, one single-winner fail-closed settlement,
  one scope check — verified equivalent to the prior Discord-only path, not re-implemented.
- **The next transport is additive, not a fork.** A web surface implements the sink interfaces and an
  approval transport; it does not clone the engine, so behavior cannot drift between surfaces.
- **The zero-regression claim is real.** Characterization tests that were green before and after the
  refactor are evidence, not assertion.

## When to Apply

- Adding a second transport (web, SSE, CLI) to an engine currently coupled to one.
- Extracting a messy adapter out of an execution engine that mixes queueing, transport, and logic.
- Generalizing an approval/permission flow so more than one surface can answer.
- Any refactor where an inner code path, if exposed, would let a caller skip coordination or weaken a
  security check.

## Examples

### 1) Public front door + private inner primitive

```ts
// PUBLIC: owns queue + concurrency cap + FIFO handoff. The only way in.
export async function launchWork(request: LaunchWorkRequest, deps: RunMentionDeps): Promise<void> {
  const {concurrency, queue} = deps
  // empty-prompt guard at the front door so no caller churns thread/lock/run-state
  if (request.promptText.trim().length === 0) {
    await request.replySink.send('source', {content: 'Nothing to do — please include a task in your message.'})
    return
  }
  if (queue.pendingCount(request.channelId) > 0) return enqueue(request, deps)
  const slotResult = concurrency.tryAcquire(request.channelId)
  if (slotResult === 'ok') await executeWorkOnHeldSlot({request, deps})
  // ...enqueue / cap-reject paths
}

// PRIVATE (never exported): assumes the slot is already held.
async function executeWorkOnHeldSlot(task: RunTask): Promise<void> {
  // clone → readyz → lock → run → cleanup, against sinks only
}
```

Exporting `executeWorkOnHeldSlot` would be the foot-gun — a caller could skip the queue/cap.

### 2) Sinks over raw transport objects

```ts
export interface ReplySink {
  append: (text: string) => void
  flush: () => Promise<unknown>
  buffered: () => string
  // discord.js option type reused → Discord impl needs no cast
  send: (target: ReplySinkTarget, options: MessageContentOptions) => Promise<unknown>
  // ...visible-output tracking methods omitted (hasVisibleOutput, markVisibleOutputSent, markVisibleOutputPending)
}
```

The Discord adapter builds `ReplySink`/`StatusSink` from `createStatusController`,
`createDiscordStreamSink`, and the `io.ts` safe-send boundary; the engine never sees a `Message`.

### 3) One fail-closed gate, multiple transports

```ts
export type ApprovalActor = DiscordApprovalActor | WebOperatorActor

async function handleDecision({requestID, approvalScopeId, decision, actor}: DecisionInput): Promise<DecisionOutcome> {
  const entry = registry.get(requestID)
  if (entry?.approvalScopeId !== approvalScopeId) return 'channel-mismatch' // scope-bound
  if (entry.state === 'claimed' || entry.state === 'confirmed') return 'already-claimed' // single-winner
  entry.state = 'claimed'
  entry.actor = actor
  // ...settle, fail-closed on timeout
}
```

A non-Discord decision settles through this exact path — proven by a web-operator test.

### 4) Characterization-first, with the one intended change made explicit

```ts
// Pinned green on unmodified code BEFORE the refactor:
it('bare @fro-bot mention: fails fast BEFORE thread creation, lock, or run-state', async () => {
  await runMention(message, makeBinding(), deps)
  expect(message.startThread).not.toHaveBeenCalled()
  expect(mockRuntime.acquireLock).not.toHaveBeenCalled()
  expect(mockRuntime.createRun).not.toHaveBeenCalled()
})
```

The empty-prompt fail-fast *is* the one accepted behavior delta — so it gets its own test, not a
silent change buried in the seam.

### 5) Latent foot-guns documented in code

```ts
// ReplySink.send must not reject — the Discord impl is fail-soft. A transport whose
// send CAN reject must add a .catch() that releases the pending claim, or it surfaces
// as an unhandled rejection inside onPending.
void replySink.send('thread', {content: 'Waiting for tool approval…'}).then(/* settle */)
```

```ts
// If the timeout fired, threadFactory may still resolve later, after the slot was released.
// That late resolution is intentionally abandoned (fails safe; the user can retry).
```

## Related

- [`atomic-serial-channel-queue-handoff-2026-06-09.md`](./atomic-serial-channel-queue-handoff-2026-06-09.md)
  — the FIFO queue + handoff this front door preserves; that doc's lock/queue snippets are the
  coordination the public entry point now owns.
- [`gateway-opencode-mention-loop-best-practices-2026-05-30.md`](./gateway-opencode-mention-loop-best-practices-2026-05-30.md)
  — the mention loop this seam refactors; its "transport clarity / remote attach" framing is adjacent.
- [`discord-slash-command-orchestration-patterns-2026-05-27.md`](./discord-slash-command-orchestration-patterns-2026-05-27.md)
  — Discord is now one transport over shared primitives, not the canonical pipeline.

> Consolidation note: when the web transport lands, the related docs above may warrant a refresh so
> their Discord-specific snippets read as "one transport" rather than the only one.
