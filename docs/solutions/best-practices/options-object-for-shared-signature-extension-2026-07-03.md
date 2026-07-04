---
title: Extend a shared function via an options object, not a positional optional, to survive cross-branch merges
date: 2026-07-03
category: best-practices
module: runtime/coordination
problem_type: best_practice
component: assistant
severity: medium
applies_when:
  - Two or more in-flight branches each need to add a parameter to the same shared function
  - A widely-called function is accreting a tail of optional positional parameters
  - A change adds an optional param to a signature that another branch also touches
  - A shared runtime primitive is extended by feature work that will rebase onto sibling features
tags:
  - api-evolution
  - options-object
  - positional-params
  - merge-hazard
  - shared-signature
  - telescoping-parameters
---

# Extend a shared function via an options object, not a positional optional, to survive cross-branch merges

## Context

Two independent feature branches each needed to extend the same shared runtime primitive, `transitionRun`. Branch A (a bugfix) appended `threadId?: string` as a trailing optional positional parameter; branch B (a feature) independently appended `detailsPatch?: Record<string, unknown>` as *its* trailing optional positional parameter. Both landed at the same argument position (arg 7). On rebase they collide into an ambiguous parameter order, and — because both are optional — TypeScript compiles either ordering without complaint. A caller passing only the second field would have to also pass the first, and the order becomes a silent coin-flip decided by merge order.

## Guidance

When a shared function needs a new optional parameter — especially when sibling branches also touch it — add a single **options object** as the one extension point, not a positional optional:

```ts
// packages/runtime/src/coordination/run-state.ts
/**
 * Extension point for fields atomically merged into a run-state write alongside
 * the phase transition. Sibling additions (e.g. detailsPatch) should be appended
 * as fields on this bag rather than as new positional params on transitionRun.
 */
export interface TransitionRunOptions {
  readonly threadId?: string
  readonly detailsPatch?: Record<string, unknown>
}

export async function transitionRun(
  config: CoordinationConfig,
  identity: string,
  repo: string,
  runId: string,
  newPhase: RunPhase,
  etag: string,
  logger: CoordLogger,
  options?: TransitionRunOptions, // ← one bag; both branches' fields fold in here
): Promise<Result<{etag: string; state: RunState}, Error>>
```

Branch A adds `threadId?` to the interface; branch B adds `detailsPatch?` to the *same* interface. The two additions merge cleanly (different fields on one object), call sites read `{threadId}` / `{detailsPatch}` / `{threadId, detailsPatch}` self-documentingly, and there is no positional order to get wrong. Put a comment on the interface naming it the extension point so the next contributor appends a field instead of a positional param.

## Why This Matters

- **Positional optionals collide silently across branches.** Two branches each appending `arg[N]` produce a merge where the order is ambiguous and the type checker cannot catch it (both optional → any order compiles). An options object turns "which position?" into "which field name?" — order-free and merge-safe.
- **It stops telescoping.** A function accreting `f(a, b, c, logger, opt1?, opt2?, opt3?)` becomes unreadable at call sites (`f(x, y, z, log, undefined, undefined, val)`). A bag keeps call sites legible (`f(x, y, z, log, {opt3: val})`).
- **Self-documenting call sites.** `{detailsPatch: {cancelledBy}}` says what it is; `, undefined, {cancelledBy}` does not.

## When to Apply

- Any shared/widely-called function gaining an optional parameter when another branch is known to be in flight against it.
- The moment a function would grow its *second* trailing optional positional param — refactor to a bag before the collision, not after.
- Runtime primitives extended by feature branches that will rebase onto sibling features.

Do **not** over-apply: a stable function with a single, long-lived optional positional and no sibling branches touching it does not need a bag. The trigger is *multiple extenders* or *a growing optional tail*, not every optional param.

## Examples

Before (positional — collides on rebase):
```ts
// branch A
transitionRun(cfg, id, repo, runId, 'ACKNOWLEDGED', etag, logger, threadId)
// branch B, independently
transitionRun(cfg, id, repo, runId, 'CANCELLED', etag, logger, detailsPatch) // same arg slot!
```

After (options object — both fold into one bag):
```ts
transitionRun(cfg, id, repo, runId, 'ACKNOWLEDGED', etag, logger, {threadId})
transitionRun(cfg, id, repo, runId, 'CANCELLED', etag, logger, {detailsPatch: {cancelledBy}})
```

## Related

- fro-bot/agent#1109 (added `threadId`) and #1111 (added `detailsPatch`) — the two branches whose collision this pattern resolved; reconciled to `TransitionRunOptions` before the second merged.
- [Centralize resource-key/identity construction](centralize-s3-key-identity-construction-2026-06-09.md) — related single-source-of-truth discipline for shared coordination shapes.
