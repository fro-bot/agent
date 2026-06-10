---
title: Centralize resource-key/identity construction to prevent silent cross-signal drift
date: 2026-06-09
category: best-practices
module: runtime
problem_type: best_practice
component: assistant
severity: high
applies_when:
  - The same resource-key / identity / path shape is constructed in 2+ places, especially across package boundaries
  - Coordination logic reads multiple distinct key families (e.g. lock + run-state) owned by different identity segments
  - Key-shape or identity constants are duplicated with an informal "must stay in sync" comment
  - A multi-signal guard silently degrades if one signal's key is wrong
  - Adding a new operation that touches existing key families
tags:
  - s3-key-construction
  - identity-separation
  - coordination
  - key-drift
  - single-source-of-truth
  - dead-run-verification
---

# Centralize resource-key/identity construction to prevent silent cross-signal drift

## Context

Coordination state in this repo lives in S3 under two **distinct identity families**:

- **Lock records** — built under `COORDINATION_IDENTITY = 'coordination'`.
- **Run-state records** — built under the **gateway identity** (`config.identity`, default `'discord-gateway'`).

That knowledge was duplicated: `packages/gateway/src/execute/recovery.ts` re-declared
`COORDINATION_IDENTITY` locally with a "must stay in sync" comment, and the coordination
modules each built keys inline. When a new operation — `forceReleaseStaleLock`'s
`readRunStateByRunId` — was added, it rebuilt the run-state key inline using the **wrong**
identity segment (`'coordination'` instead of the run-owner identity).

The result was a **silent safety-degradation**: `forceReleaseStaleLock` is supposed to be
two-signal "dead-run-verified" (release a lock only when the lease has expired **and** the
run-state heartbeat is stale/absent). But the heartbeat read targeted
`…/coordination/owner/repo/runs/{id}.json` while the record actually lives at
`…/discord-gateway/owner/repo/runs/{id}.json` → every read was `NoSuchKey` → "absent →
dead" → the guard collapsed to lease-only. No crash, no failing test — the tests mocked
`getObject` positionally without asserting the key. It was caught in review, not by the
suite.

## Guidance

### 1. One owner per resource-key family — export the builder, never rebuild inline

The module that owns the schema exports the key-builder; every consumer imports it. No call
site calls `buildObjectStoreKey(...)` directly.

```typescript
// lock.ts — owns the lock key family
export const COORDINATION_IDENTITY = 'coordination'
export function getLockKey(config, repo): Result<string, Error> {
  return buildObjectStoreKey(config.storeConfig, COORDINATION_IDENTITY, repo, 'locks', 'repo.json')
}

// run-state.ts — owns the run-state key family
export function getRunKey(config, identity, repo, runId): Result<string, Error> {
  return buildObjectStoreKey(config.storeConfig, identity, repo, 'runs', `${runId}.json`)
}
```

### 2. Make the two identity families impossible to confuse

The run-state builder **requires** the identity as a parameter, so a caller cannot silently
fall back to the lock identity. Locks and run-state can never share the wrong segment.

```typescript
async function readRunStateByRunId(config, repo, identity, runId) {
  const key = getRunKey(config, identity, repo, runId) // identity threaded, not hardcoded
  // …
}
```

### 3. Pin the exact key in a regression test — assert the string, not mock call order

The bug slipped because the test mocked `getObject` positionally and never inspected the key.

```typescript
it('run-state key uses the gateway identity segment, NOT the coordination identity', async () => {
  await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)
  const runStateKey = getObject.mock.calls[1][0] as string
  expect(runStateKey).toContain('/discord-gateway/')   // correct identity
  expect(runStateKey).toContain('/runs/run-42.json')   // correct path
  expect(runStateKey).not.toContain('/coordination/')  // wrong identity
})
```

### 4. Verify an identity/key claim by tracing the value end-to-end

`config.identity → 'discord-gateway'` is the canonical path. A same-named constant in
another package (`COORDINATION_IDENTITY` for *lock* keys) is **not** evidence the run-state
identity matches — matching the name instead of tracing the value is exactly how the wrong
dismissal happened during review. Trace the actual value through to where the record is
written.

### 5. Keep raw cross-package imports behind one adapter — DI and wrapping coexist

The gateway convention is that only `runtime-effect.ts` imports raw `@fro-bot/runtime`
primitives; everything else consumes the Effect-wrapped versions. Dependency injection for
testability does not require bypassing that boundary — inject the *wrapped* effect.

```typescript
// runtime-effect.ts — the single import boundary
export const forceReleaseStaleLockEffect = (config, repo, identity, logger) =>
  Effect.tryPromise({
    try: async () => forceReleaseStaleLock(config, repo, identity, logger),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.flatMap(r => (r.success === true ? Effect.succeed(r.data) : Effect.fail(r.error))))
```

## Why This Matters

Silent safety-degradation — no crash, no failing test — is the worst failure mode, because
nothing signals that a guarantee has quietly stopped holding. Here the guard existed
specifically to stop a live run's lock from being force-deleted (which would permit
concurrent execution against one repo), and the wrong key turned it off in every default
deployment. Duplicated construction knowledge is the mechanism that let it happen;
centralizing the builders turns "the two key families drifted" from a runtime near-miss into
a compile-time or single-edit concern.

## When to Apply

Whenever the same resource-key / identity / path shape is constructed in two or more places —
most urgently across package boundaries, and most critically when a key gates a destructive
or safety-critical operation (delete, force-release, state transition). The moment you see a
"must stay in sync" comment on a duplicated constant, treat it as a drift bug waiting to
happen and export a single builder instead.

## Examples

**Before — inline build with the wrong identity family:**

```typescript
// a local re-declaration + inline build (drift risk)
const COORDINATION_IDENTITY = 'coordination' // "must stay in sync"
const key = buildObjectStoreKey(config.storeConfig, COORDINATION_IDENTITY, repo, 'runs', `${runId}.json`)
// → fro-bot-state/coordination/owner/repo/runs/run-1.json   (WRONG — run-state isn't here)
```

**After — shared builder, identity threaded:**

```typescript
import {getLockKey, getRunKey} from '@fro-bot/runtime'

const lockKey = getLockKey(coordinationConfig, repo)
const runKey  = getRunKey(coordinationConfig, identity, repo, runId)
// runKey → fro-bot-state/discord-gateway/owner/repo/runs/run-1.json   (CORRECT)
```

## Related

- `gateway-opencode-mention-loop-best-practices-2026-05-30.md` — lock **release** `run_id`-ownership gate (a different moment in the lock lifecycle: the release decision, not key construction). Complementary; both touch `packages/gateway/src/execute/recovery.ts`.
- PR #854 (`/fro-bot force-release-lock` + the centralization fix).
