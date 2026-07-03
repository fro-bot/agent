---
status: ready-for-planning
created: 2026-04-25
topic: Effect adoption for the Discord gateway
related:
  - docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md
  - docs/brainstorms/2026-04-17-fro-bot-gateway-discord-requirements.md
---

# Effect Adoption for the Discord Gateway

## Context

PR #547 (lock primitives) and PR #548 (Action lock acquisition) shipped the cross-surface coordination layer. Both PRs surfaced the same three categories of friction:

- **Schema validation** — hand-rolled `hasValidLockRecordShape` / `hasValidRunStateShape` type guards plus `as T` casts at every JSON parse boundary. Defensive but ad-hoc.
- **Result<> verbosity** — `if (result.success === false) return err(result.error)` chains repeated 341 times across runtime + Action.
- **Manual concurrency** — `findStaleRuns` N+1 (review finding #7), s3-adapter list pagination, content-sync. Each needs its own bounded-concurrency helper if hand-rolled.

The Discord gateway (Unit 4 of the gateway plan) is the natural venue for adopting better primitives: it's greenfield, it has more sophisticated needs (queue, retry, scheduled work, Discord webhook validation), and it's the long-lived process where retry/scheduler primitives compound.

## Decision: gateway-first Effect adoption

Effect lands alongside Unit 4 as a foundation sub-task, with clear package boundaries:

| Package           | Status                | Effect adoption                                   |
| ----------------- | --------------------- | ------------------------------------------------- |
| `@fro-bot/runtime`  | Stays on Result<>       | None. Coordination, object-store, session APIs unchanged. |
| `@fro-bot/action`   | Stays on Result<>       | None. Bundle untouched.                             |
| `@fro-bot/gateway`  | New, Effect-native      | Core + Schedule + Schema. Lives at `packages/gateway/` per Unit 4. |

The boundary lives at the gateway package edge: gateway has a small `runtime-effect.ts` adapter that wraps each runtime call in `Effect.tryPromise` + flatMap on the Result tag. Gateway code consumes Effect throughout; runtime stays Result<>-typed.

## Why these decisions

### Gateway-first, not whole-project

- Action runs in GitHub Actions runner (cold-start sensitive); adding Effect to runtime affects Action bundle.
- Migrating 341 Result<> sites is a large carrying cost with no immediate user-visible value.
- Gateway is greenfield — Effect can prove itself in a contained space.
- If Effect-in-gateway compounds well, runtime migration is a future option; if it doesn't, runtime never paid the migration cost.

### Boundary at gateway package edge

- Runtime APIs already stable; rewriting them is gratuitous churn.
- Adapter is small (~50 lines) — one wrapper per runtime function, all in `packages/gateway/src/runtime-effect.ts`.
- Gateway code reads as native Effect; contributors don't see two paradigms inside one file.
- Runtime team (mostly Marcus) doesn't have to think about Effect when working on coordination primitives.

### Core + Schedule + Schema

- **Core** (`Effect.Effect`, `pipe`, `tryPromise`, `flatMap`, `gen`): composing async error paths. The gateway has many of them — Discord webhook handlers, queue dispatch, S3 ops via runtime adapter.
- **Schedule** (`Effect.Schedule`, `Effect.retry`, `Effect.timeout`): the gateway needs a real retry layer for queue dispatch, GitHub `workflow_dispatch` calls, and S3 ops. Hand-rolling backoff for 3+ different operation types is wasteful when Schedule does it composably.
- **Schema** (Effect.Schema): Discord interaction payloads have meaningful validation surface (slash command options, button custom_ids, modal submissions). Approval-token records also benefit. Parse-don't-validate at the gateway's untrusted-input edge.

## Scope boundaries

In scope:

- Add `effect` (3.x) as a dependency in `packages/gateway/`.
- Create `packages/gateway/src/runtime-effect.ts` adapter wrapping every runtime function gateway uses (`acquireLock`, `releaseLock`, `renewLease`, `forceReleaseLock`, `createRun`, `transitionRun`, `findStaleRuns`, `validateProviderSemantics`, S3 sync helpers).
- Use Effect natively in gateway code (Discord client, slash command handlers, queue, approval flow, locking).
- Use Effect.Schedule for retries on Discord HTTP, GitHub workflow_dispatch, and runtime adapter calls.
- Use Effect.Schema for Discord interaction validation and approval-token records.

Out of scope:

- Migrating any code in `@fro-bot/runtime` or `apps/action/` (root `src/`) to Effect. They stay on Result<>.
- Coordination review residuals (#7 N+1, #15 regex). These remain in the runtime layer; Effect doesn't reach them.
- @effect/schema in runtime parsers (`parseLockRecord`, `parseRunState`). They stay manual.
- Adopting Effect's `Layer`/`Context` for dependency injection. Gateway uses plain function injection (matches runtime's adapter pattern).

## Constraints

- **Effect 3.x**: Schema is part of the `effect` package itself (no separate `@effect/schema` install in 3.0+).
- **Bundle size**: gateway is a Docker container; bundle size doesn't constrain Effect adoption the way it constrains Action.
- **Testing**: gateway tests use vitest. `@effect/vitest` is the canonical test runner for Effect; evaluate whether its TestClock/Layer support justifies adoption alongside vanilla vitest.
- **Discord.js compatibility**: discord.js returns Promises; gateway wraps each at the boundary using `Effect.tryPromise`.
- **Type imports**: gateway imports types from `@fro-bot/runtime` (`LockRecord`, `RunState`, etc.) and uses them in Effect.Effect signatures. No issue.
- **Failure semantics**: runtime's `Result<T, Error>` maps to `Effect.Effect<T, Error>`. The adapter unwraps `success: false` into `Effect.fail(error)`.

## Success criteria

- `packages/gateway/src/runtime-effect.ts` adapter compiles with full type safety (no `any`, no `as`).
- Every gateway-side async operation that calls runtime returns `Effect.Effect<T, E>`.
- Gateway retry logic (queue, HTTP, runtime adapter) uses `Effect.Schedule` — no hand-rolled `setTimeout` backoff loops.
- Discord interaction handlers parse incoming payloads with `Effect.Schema` before processing.
- Tests cover: adapter wraps Result<>.success → Effect.succeed; adapter wraps Result<>.failure → Effect.fail; retry with Schedule.exponential; Schema parse failure produces actionable error.
- Action bundle size unchanged.
- Runtime API surface unchanged.

## Risks

| Risk                                                             | Mitigation                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Two paradigms (Result<> in runtime + Effect in gateway) confuse contributors | Document the boundary in `packages/gateway/AGENTS.md`. Adapter file naming makes the bridge explicit.               |
| Effect's learning curve slows Unit 4                             | Effect's surface is broad but the gateway uses a narrow slice (Effect.Effect, pipe, gen, Schedule, Schema). Document the slice. |
| Bundle bloat in gateway Docker image                             | Docker base image is Node 24-slim; Effect tree-shakes well. Build size is not a startup-latency concern for a long-lived process.   |
| Future migration of runtime to Effect requires re-engineering    | Adapter pattern means runtime-effect.ts becomes a no-op when runtime goes Effect-native. No throwaway work.   |
| Effect 3.x churn (rapid major releases)                          | Pin exact version; pre-push lint/build catches breaking upgrades before they land.                            |

## Open questions for planning

- Does gateway adopt `@effect/vitest` for tests, or keep vanilla vitest with manual Effect.runPromise wrappers? (Decide during Unit 4 step 1.)
- Naming for adapter file: `runtime-effect.ts` vs `runtime-bridge.ts` vs `runtime/index.ts`? (Decide during Unit 4 step 1.)
- Should Effect.forEach with concurrency replace hand-rolled S3 list pagination in gateway code, or stay manual? (Decide when the gateway needs to list S3 objects.)

## Handoff

Add to `docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md` Unit 4: explicit "Effect setup" sub-task as step 1, before Discord client / slash commands / queue / approval flow.
