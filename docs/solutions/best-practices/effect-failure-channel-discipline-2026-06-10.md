---
title: Effect failure-channel discipline for fail-soft boundaries
category: best-practices
module: gateway
date: 2026-06-10
problem_type: best_practice
component: service_object
severity: medium
applies_when:
  - "An Effect recovery boundary must guarantee a user-facing or cleanup side effect on every failure"
  - "A hook surface is deliberately typed with a never error channel (fail-soft contract)"
  - "Fiber interruption (shutdown) can reach a boundary that edits user-visible state"
  - "A package mixes Result-in-success-channel and error-channel Effect adapters"
tags:
  - effect
  - catchallcause
  - fail-soft
  - interruption
  - defect
  - discord
  - gateway
---

# Effect Failure-Channel Discipline for Fail-Soft Boundaries

## Context

The gateway's Discord command pipeline (`packages/gateway/src/discord/commands/guild-command.ts`) owns a guarantee: any failure after `deferReply` must edit the deferred reply before re-failing, so a user is never left at "thinking…" until the interaction token expires. Its hooks are deliberately fail-soft — `authorize` is typed `Effect<AuthDecision, never>` and the Discord I/O helpers (`discord/io.ts`) are typed `Effect<Result<unknown, Error>, never>`.

The first implementation guarded that guarantee with `Effect.catchAll`. Review proved this defect-blind: `Effect.catchAll` catches only **typed** failures, and a `never`-typed channel means any escaped error (a rejection inside `Effect.promise` in a future non-fail-closed `authorize`) surfaces as a **defect** (Die cause) — which skips `catchAll` entirely and reproduces the exact failure the boundary exists to eliminate. A second round caught the complement: naively squashing all causes converts fiber **interrupts** (shutdown) into misleading user-facing "internal error" replies carrying a useless FiberId string.

## Guidance

1. **Recovery boundaries that must be total use `catchAllCause`, not `catchAll`.** `catchAll` sees only the typed error channel; defects sail past it.
2. **Guard interrupts first.** `Cause.isInterruptedOnly(cause)` → `Effect.failCause(cause)` so interruption propagates cleanly (it also skips the user-facing edit — an interrupted command should not claim "internal error").
3. **One normalization boundary at the scope edge, not per step.** A per-step `catchAllCause` on `work` plus an outer `catchAll` is redundant and still leaves the other steps defect-blind. Normalize once, where the guarantee lives.
4. **`never` error channels are contracts the type system cannot enforce.** `Effect.promise(async () => …)` claims `never` but a thrown rejection becomes a defect. Keep the fail-closed convention (hooks return denials, not errors) for precise user messages — but make the boundary defect-proof *by construction* so a contract violation degrades to a generic reply instead of a hang.
5. **Opposite error-channel conventions are a composition hazard — document the boundary, don't mix blindly.** `io.ts` returns errors inside the `Result` on the success channel (callers always proceed); `runtime-effect.ts` unwraps `Result` and fails the Effect channel (callers `catchAll`). Composing both in one `Effect.gen` means a single `catchAll` cannot see io.ts failures. Both conventions are valid; the rule is to know which one each adapter uses and handle accordingly.

Before (defect-blind):

```ts
yield* Effect.gen(function* () {
  // defer → authorize → work
}).pipe(
  Effect.catchAll(error =>
    Effect.gen(function* () {
      yield* editInteraction(interaction, {content: INTERNAL_ERROR_COPY}, log)
      return yield* Effect.fail(error)
    }),
  ),
)
```

After (defect-proof, interrupt-aware — `guild-command.ts`):

```ts
yield* Effect.gen(function* () {
  // defer → authorize → work (work inside Effect.suspend so sync throws become defects)
  yield* Effect.suspend(() => spec.work(ctx))
}).pipe(
  Effect.catchAllCause(cause => {
    if (Cause.isInterruptedOnly(cause)) {
      return Effect.failCause(cause) // shutdown propagates; no user-facing edit
    }
    const squashed = Cause.squash(cause)
    const error = squashed instanceof Error ? squashed : new Error(String(squashed))
    return Effect.gen(function* () {
      const editResult = yield* editInteraction(interaction, {content: INTERNAL_ERROR_COPY}, log)
      if (editResult.success === false) {
        log.error({err: editResult.error.message}, 'guild-command: failed to deliver internal-error reply')
      }
      return yield* Effect.fail(error)
    })
  }),
)
```

## Why This Matters

A defect-blind boundary fails exactly when its contract is violated — silently, in the path that was designed to be the safety net. The type checker is satisfied, every test with well-behaved hooks passes, and the hole only opens when a future implementation breaks the unenforced `never` promise. Interrupt squashing is the mirror image: clean shutdowns become user-visible errors and garbage log entries, training operators to ignore the exact signal that matters.

## When to Apply

- Any Effect recovery boundary guaranteeing a side effect on failure (user reply, lock release, resource cleanup).
- Any surface where hooks/plugins are typed `Effect<T, never>` as a convention rather than a provable property.
- Shutdown-capable systems where fibers running these boundaries can be interrupted.
- Code that composes adapters with different error-channel conventions in one `Effect.gen`.

## Examples

Pinning the defect path — an `authorize` that violates its `never` contract still produces the user-facing reply and re-fails with the real error:

```ts
const authorize = vi.fn().mockReturnValue(
  Effect.promise(async () => {
    throw authError // escapes as a defect, not a typed failure
  }),
)
const result = await Effect.runPromise(Effect.either(executor(interaction)))
expect(editReply).toHaveBeenCalledOnce() // user saw the internal-error reply
expect(result._tag).toBe('Left') // original error re-failed
expect(work).not.toHaveBeenCalled()
```

Pinning interrupt propagation — interruption never claims "internal error":

```ts
const work = vi.fn().mockReturnValue(Effect.never)
const exit = await Effect.runPromise(
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(executor(interaction))
    yield* Fiber.interrupt(fiber)
    return yield* Fiber.await(fiber)
  }),
)
expect(Exit.isFailure(exit) && Cause.isInterrupted(exit.cause)).toBe(true)
expect(internalErrorCalls).toHaveLength(0)
```

## Related

- [Centralize S3 key/identity construction](centralize-s3-key-identity-construction-2026-06-09.md) — the sibling "one owner per boundary" lesson (resource keys instead of failure channels)
- [Discord slash-command orchestration patterns](discord-slash-command-orchestration-patterns-2026-05-27.md) — the command entry sequencing this pipeline now owns
- [Gateway OpenCode mention-loop best practices](gateway-opencode-mention-loop-best-practices-2026-05-30.md) — failure-path flush and lock-ownership discipline in the adjacent run loop
- [Atomic serial channel queue handoff](atomic-serial-channel-queue-handoff-2026-06-09.md) — defer-before-REST and honest shutdown for the same command surface
