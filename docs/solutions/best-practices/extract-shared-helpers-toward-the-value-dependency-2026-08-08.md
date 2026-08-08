---
title: Extract a shared helper toward the value dependency, not toward the type that names it
date: 2026-08-08
category: best-practices
module: agent-execution
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - Deduplicating a helper that exists in two modules which already import each other
  - One direction of the existing dependency is a type-only import
  - Choosing which module should own an extracted function
tags:
  - import-cycle
  - type-only-imports
  - dependency-direction
  - refactoring
---

## Context

Two modules each held an identical copy of a small mapping function. They agreed, but duplicated rules drift, and this one decided whether a failed attempt could be retried — not somewhere drift is acceptable.

The obvious home is the module that owns the type the helper operates on. That is the wrong answer here, and the reason is invisible unless you check how the two modules already import each other.

## Guidance

Before extracting, classify each existing edge between the two modules as **type-only** or **value**:

```ts
// retry.ts
import type {AttemptOutcome, AttemptResult} from "./prompt-sender.js"

// prompt-sender.ts
import {runPromptAttempt, type ExecutionDeadline} from "./retry.js"
```

These are not symmetric. The first is erased at compile time and creates no runtime edge. The second is a real import. So the only runtime dependency runs `prompt-sender → retry`, even though each file names the other.

Moving the helper to `prompt-sender.ts` — the module that declares `AttemptOutcome`, and the intuitive owner — would force `retry.ts` to import it as a _value_. That converts the erased edge into a real one and closes the runtime cycle.

Extracting toward `retry.ts` instead follows the existing runtime edge and adds nothing:

```ts
// retry.ts — single source of truth
export function shouldRetryFromOutcome(outcome: AttemptOutcome): boolean {
  return outcome === 'turn_failed_retryable'
}

// prompt-sender.ts — already depends on retry at runtime
import {runPromptAttempt, shouldRetryFromOutcome, …} from './retry.js'
```

Leave a comment recording _why_ the helper lives away from its type, or the next reader will move it back.

## Why This Matters

A type-only import looks like a dependency in the source and is not one in the build. Reasoning about ownership from the import list alone gives the wrong answer, and the resulting cycle may not surface immediately — it can appear later as a module-initialization order bug in a bundled artifact, far from the refactor that caused it.

This is not a hypothetical trap. An automated reviewer flagged the duplication correctly and proposed exactly the cycle-forming direction, on the reasonable grounds that the type's owner should own the helper. The suggestion was right about the problem and wrong about the destination.

## When to Apply

- Any deduplication between two modules that already reference each other.
- Any time the intuitive owner is chosen because it declares the relevant type rather than because it is depended on.
- Any language with erasable imports — TypeScript's `import type`, Java's compile-time-only annotations, and similar — where the source graph and the runtime graph differ.

Verify rather than assume: a cycle check after the extraction is cheap, and it is the only way to know the erased edge stayed erased.

## Examples

**Wrong direction.** Helper moves to the type's owner; the other module must now import it as a value; a previously type-only edge becomes real; cycle.

**Right direction.** Helper moves to the module that is already a runtime dependency; the type-only edge stays erased; no new edge exists. Confirmed after the change with a project-wide cycle check reporting zero import cycles.
