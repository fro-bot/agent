# Gateway Package — Agent Notes

The Discord-first gateway daemon. Wraps `@fro-bot/runtime` with Effect 3.x as the composition layer.

## Effect / Result<> boundary

This package is the **only** place in the monorepo that uses `effect`. The Action and the runtime package stay on hand-rolled `Result<T, E>` from `@bfra.me/es`.

### Why a boundary

- The Action runs in a GitHub Actions runner where cold-start time matters. Adding Effect to the runtime bundle would inflate every Action invocation.
- Runtime APIs are stable and well-tested with `Result<>`. Rewriting them is gratuitous churn.
- The gateway has many composing async error paths (Discord webhook handlers, queue dispatch, S3 ops via runtime adapter, approval flow). Effect's `pipe` + `flatMap` + `gen` make those compose cleanly. The runtime doesn't have that density.

### Where the boundary lives

`packages/gateway/src/runtime-effect.ts` is the single adapter file. It wraps every `@fro-bot/runtime` function the gateway uses (`acquireLock`, `releaseLock`, `renewLease`, `forceReleaseLock`, `createRun`, `transitionRun`, `findStaleRuns`, `validateProviderSemantics`, S3 sync helpers).

Each wrapper takes the same shape:

```ts
Effect.tryPromise(() => runtimeFn(args)) // catches promise rejections
  .pipe(
    Effect.flatMap(result =>
      result.success === true
        ? Effect.succeed(result.data)
        : Effect.fail(result.error),
    ),
  )
```

All gateway code outside `runtime-effect.ts` works exclusively in Effect — `Effect.Effect<A, E, R>` everywhere. Subagents asked to add a new runtime call should add the wrapper to `runtime-effect.ts` first, never import directly from `@fro-bot/runtime` outside that adapter.

### Effect surface used

- **Core** (`Effect.Effect`, `pipe`, `Effect.tryPromise`, `Effect.flatMap`, `Effect.gen`, `Effect.runPromise`, `Effect.runSync`) — composing async error paths
- **Schedule** (`Effect.retry`, `Schedule.exponential`, `Schedule.recurs`) — retry policies on Discord API calls and runtime adapter calls
- **Schema** (`Schema.Struct`, `Schema.String`, `Schema.decodeUnknown`) — Discord interaction payload validation, approval-token record decode

Not used in v1:
- Effect runtime / Layer / Context (overkill for v1; revisit when DI complexity warrants)
- STM (no shared mutable state at this scope)
- Streams (Discord.js handles its own event stream)

## Package layout

- `src/main.ts` — entry point. Wires the Discord client, registers slash commands, installs SIGTERM handler. Runs an `Effect.runPromise` at the top level.
- `src/config.ts` — env + secret reading. `readSecret(name)` checks `${NAME}_FILE` first, falls back to `process.env[name]`.
- `src/runtime-effect.ts` — the Result<>→Effect boundary.
- `src/discord/` — Discord.js integration. Client construction with safe `allowedMentions` defaults, command registry, mention handler.
- `src/shutdown.ts` — SIGTERM handler with 25s drain.

## Build

```bash
pnpm --filter @fro-bot/gateway build
pnpm --filter @fro-bot/gateway test
pnpm --filter @fro-bot/gateway lint
```

The build runs `tsc --noEmit` for type checking, then `tsdown` to bundle `src/main.ts` into `dist/main.js` (single ESM file). Production deployment runs that bundle inside the container image — see `deploy/gateway.Dockerfile`.
