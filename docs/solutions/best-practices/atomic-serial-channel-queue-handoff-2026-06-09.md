---
title: Serial per-channel work queue with atomic slot handoff and honest graceful shutdown
date: 2026-06-09
category: best-practices
module: gateway
problem_type: best_practice
component: assistant
severity: high
applies_when:
  - Building a per-key serial work queue in a long-running daemon
  - In-memory FIFO queues with a lossy-on-restart contract
  - Shutdown-sensitive concurrency loops that must not strand in-flight work
  - Handlers bound by an external interaction deadline (e.g. Discord's 3s ACK)
tags:
  - concurrency
  - atomic-handoff
  - fifo-queue
  - graceful-shutdown
  - in-memory-queue
  - event-loop-safety
  - discord
---

# Serial per-channel work queue with atomic slot handoff and honest graceful shutdown

## Context

The gateway's Discord mention loop runs at most one agent execution per channel at a
time (a per-channel concurrency slot, layered over a per-repo S3 lock). The queue is keyed
by `channelId`, which for Discord is the real channel snowflake but for the operator web
launch transport is a synthetic per-repo key (`web:<owner>/<repo>`) — the same FIFO + cap +
shutdown discipline applies to both by reuse, not extension. The original behavior rejected
a second `@`-mention while a channel was busy. Making busy channels
*queue* instead of reject introduces three correctness hazards that are easy to get
subtly wrong:

1. Serializing without a gap — naively releasing the slot and letting the next mention
   re-acquire it opens a window where a fresh mention starts concurrently with the
   drained task.
2. Fairness — a fresh arrival can leapfrog older queued work if a free slot is consulted
   before the queue.
3. Honest shutdown — an in-memory queue cannot truthfully promise to drain on SIGTERM,
   and trying to await chained work via `Promise.all` is a snapshot trap.

This doc captures the pattern that resolves all three, plus two supporting rules.

## Guidance

### Rule 1 — Atomic slot handoff (no release-then-reacquire gap)

In the finishing run's outer `finally`, while the slot is **still held**, take the next
queued task and start it on the same slot. Only `release()` when the queue is empty.
There is never a moment where `tryAcquire` could return `ok` for a channel that still has
handing-off work.

```typescript
// startRun outer finally
} finally {
  if (deps.isShuttingDown?.() === true) {
    concurrency.release(channelId)          // see Rule 3
  } else {
    const nextTask = queue.takeNext(channelId)
    if (nextTask === undefined) {
      concurrency.release(channelId)        // queue empty — free the slot
    } else {
      // Slot ownership transfers to the next run — do NOT release.
      void startRun(nextTask).catch(err => logger.error({channelId, err}, 'handoff failed'))
    }
  }
}
```

### Rule 2 — FIFO front-door gate

In the entry handler, if there is already pending work for the channel, enqueue
immediately **without** consulting the slot. Otherwise a free slot lets a new mention jump
the line ahead of older queued tasks.

```typescript
// runMention front door
if (queue.pendingCount(channelId) > 0) {
  await ackEnqueueResult(message, queue.enqueue(channelId, task))
  return
}
// ... only now consult tryAcquire(): 'ok' runs, 'busy' enqueues, 'cap' is terminal
```

### Rule 3 — Honest graceful shutdown for an in-memory queue (the load-bearing rule)

Gate the handoff on `isShuttingDown()`. Once shutdown is requested, **release the slot and
drop the pending queue** — do not try to drain it.

The tempting wrong fix is to track every run promise in a `Set` and `await
Promise.all(inFlightRuns)` on shutdown. This does not work: **`Promise.all` snapshots the
iterable at call time.** A handoff that fires *during* the drain adds its promise to the
set *after* the snapshot, so the chained run escapes the await — and gets killed mid-flight
when teardown proceeds, stranding run-state and holding the repo lock until the next
startup recovery sweep.

The `isShuttingDown()` gate closes the window at the source: once shutdown is observed, no
new handoff fires, so nothing is added to the in-flight set after the drain begins. Dropping
pending tasks is correct because the queue is in-memory and already lossy across restarts —
the gate simply makes the documented contract honest. It is also consistent with the
`messageCreate` guard that already refuses *new* mentions during shutdown.

```typescript
if (deps.isShuttingDown?.() === true) {
  concurrency.release(channelId)   // drop queued work; do not start the next task
}
```

Removing the promise-tracking machinery entirely was simpler and more honest than trying to
make the drain await late-added promises.

### Rule 4 — Cap the first enqueue, and keep counts honest

The depth cap must fire on the **first** enqueue of an unknown channel too, or
`createChannelQueue(0)` accepts one task. And `takeNext` must delete the bucket when it
drains to empty, so `pendingCount` never reports a stale non-zero value.

```typescript
enqueue: (channelId, task) => {
  const existing = queues.get(channelId)
  if (existing === undefined) {
    if (maxDepth <= 0) return 'full'     // first-enqueue cap
    queues.set(channelId, [task])
  } else {
    if (existing.length >= maxDepth) return 'full'
    existing.push(task)
  }
  return 'queued'
}

takeNext: channelId => {
  const existing = queues.get(channelId)
  if (existing === undefined || existing.length === 0) return undefined
  const task = existing.shift()
  if (existing.length === 0) queues.delete(channelId)   // keep pendingCount honest
  return task
}
```

### Rule 5 — Defer the interaction reply before any pre-reply REST call

Discord requires an interaction ACK within 3 seconds. Any `await` before the first reply —
including a permission `guild.members.fetch()` inside an authorization helper — risks
blowing the window and throwing on reply. `deferReply()` transitions the interaction to the
deferred state; all subsequent responses must use `editReply()`.

```typescript
await interaction.deferReply({ephemeral: true})   // BEFORE userIsAuthorized()
const authorized = await userIsAuthorized(guild, interaction.user.id, deps.triggerRoleId, deps.gatewayLogger)
if (authorized === false) {
  await interaction.editReply({content: 'You do not have permission to clear the queue.'})
  return
}
```

## Why This Matters

- **Serial-safety**: the slot is owned by exactly one run at a time; the handoff happens
  inside the outgoing run's `finally` with no free-slot gap, so two runs can never overlap
  on a channel.
- **FIFO fairness**: the front-door gate prevents leapfrogging.
- **No stranded state on shutdown**: the `isShuttingDown()` handoff gate means no doomed
  work starts after SIGTERM, so no run-state is left `EXECUTING` and no lock is held to TTL.
- **Honest contract**: the queue is documented as dropped-on-shutdown, and the code matches.
- **No 3s-window failures**: defer-first keeps the interaction valid through slow REST calls.

**Single-replica caveat.** The queue is in-memory; restarting the process drops queued
tasks (the in-flight run and its lock are unaffected). Multi-replica deployments need a
durable queue (Redis/SQS) — that boundary is acknowledged, not solved here.

**Durable admission corollary.** Once run admission moved into the launch front door, a
queued task carries a durable `PENDING` run-state even though the queue entry itself is
in-memory and lossy. Dropping the queue on shutdown therefore strands those `PENDING`
records; the startup stale-run sweep recovers them to `FAILED` using a heartbeat-staleness
freshness window (a just-admitted `PENDING` is excluded so it is never killed mid-admission).
The lossy-queue contract stands; the durable admission record just gains a recovery owner.
The gateway also drains an in-flight-run set on shutdown via `Promise.all([...set])`, which
snapshots the set at call time — a handoff that fires mid-drain escapes the await. That is the
same snapshot shape this doc warns about, but here it is accepted: the bounded drain has a hard
deadline and the startup recovery sweep terminalizes any run the drain misses, so a missed
handoff degrades to a recovered `FAILED`, not a lost run.

## When to Apply

Reach for this pattern when building a per-key serial work queue in a long-running daemon
where each key must serialize its own work, ordering must be FIFO/fair, the process must
shut down gracefully without stranding in-flight runs or locks, and an external interaction
deadline requires deferring the reply before pre-reply async work. Any in-memory queue
where you are tempted to "drain on shutdown" should be examined for the `Promise.all(set)`
snapshot trap — prefer gating new work at the source over awaiting a moving target.

## Examples

**Broken (snapshot trap):**

```typescript
client.on('messageCreate', message => {
  const p = handleMention(...)
  inFlightRuns.add(p)
  p.finally(() => inFlightRuns.delete(p))
})
// on shutdown:
await Promise.all(inFlightRuns)
// A handoff `void startRun(nextTask)` firing inside an in-flight run's finally
// adds its promise AFTER this snapshot — it is never awaited, then gets killed.
```

**Fixed (gate new work at the source):**

```typescript
} finally {
  if (deps.isShuttingDown?.() === true) {
    concurrency.release(channelId)            // no handoff once shutdown is observed
  } else {
    const nextTask = queue.takeNext(channelId)
    if (nextTask === undefined) concurrency.release(channelId)
    else void startRun(nextTask).catch(err => logger.error({channelId, err}, 'handoff failed'))
  }
}
// Promise.all(inFlightRuns) is now a complete snapshot: nothing new is added after
// shutdown is set.
```

## Related

- `gateway-opencode-mention-loop-best-practices-2026-05-30.md` — governs what happens
  *inside* a run (remote attach, streaming, run-state ownership). This doc governs how runs
  are *serialized across* a channel. Adjacent, non-overlapping.
- `discord-slash-command-orchestration-patterns-2026-05-27.md` — `/fro-bot` subcommand
  dispatch and the `interaction.appPermissions` / fail-closed authorization gate reused by
  `clear-queue`.
- PR #850 (serial queue), issue #763 (workspace/gateway reliability hardening).
