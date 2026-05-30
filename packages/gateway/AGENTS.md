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

- **Core** (`Effect.Effect`, `pipe`, `Effect.tryPromise`, `Effect.flatMap`, `Effect.gen`, `Effect.runPromise`, `Effect.try`, `Effect.succeed`, `Effect.fail`, `Effect.either`, `Effect.void`, `Effect.catchAll`) — composing async error paths
- **Schema** (`Schema.Struct`, `Schema.Union`, `Schema.Literal`, `Schema.NullOr`, `Schema.decodeUnknownEither`, `ParseResult.ArrayFormatter`) — announce webhook payload validation in `src/http/announce-schema.ts`. Decode errors are mapped to content-free reason strings via the typed formatter (no internal-shape casts).

Not yet wired:
- **Schedule** (`Schedule.exponential`, `Schedule.recurs`) — retry policies; not yet used

Not used at this scope:
- Effect runtime / Layer / Context (overkill for v1; revisit when DI complexity warrants)
- STM (no shared mutable state at this scope)
- Streams (Discord.js handles its own event stream)

## Package layout

- `src/main.ts` — entry point. Wires the Discord client, registers slash commands, installs SIGTERM handler. Runs an `Effect.runPromise` at the top level.
- `src/config.ts` — env + secret reading. `readSecret(name)` checks `${NAME}_FILE` first, falls back to `process.env[name]`.
- `src/runtime-effect.ts` — the Result<>→Effect boundary.
- `src/discord/` — Discord.js integration. Client construction with safe `allowedMentions` defaults, command registry, mention handler.
  - `src/discord/channels.ts` — channel creation helper used by the add-project flow. `createChannelWithCollisionSuffix` always creates a fresh channel; it never returns an existing one. Tries the exact name first, then `name-2` through `name-10`, skipping any candidate whose name is already taken.
  - `src/discord/commands/add-project.ts` — `/fro-bot add-project` slash command. Orchestrates the 5-phase flow (PRE_FLIGHT → CLONING → CREATING_CHANNEL → WRITING_BINDING → READY). Depends on `channels.ts` for channel creation, `workspace-api/client.ts` for repo cloning, `bindings/store.ts` for durable binding persistence, and `github/app-client.ts` for GitHub App token acquisition.
  - `src/discord/presence.ts` — resolves a channel by ID via `client.channels.fetch` and posts an embed with `allowedMentions: {parse: []}`. Used by the announce webhook to post control-plane presence messages as the Fro Bot user.
- `src/workspace-api/` — HTTP client for the workspace-agent sidecar service. `WorkspaceClient` wraps the `/clone` endpoint and maps HTTP error shapes to typed `Result<CloneSuccess, CloneError>` values. The client is injected into `add-project.ts` via `AddProjectDeps`.
- `src/http/` — the inbound announce webhook (`POST /v1/announce`), the gateway's only HTTP ingress. Hono server (`server.ts`) reads the raw body and maps the framework-agnostic handler (`announce-handler.ts`) result to a response. The handler runs an ordered fail-closed pipeline: 8 KB size cap → rate limit → required headers → HMAC verify → timestamp window → replay reserve → JSON parse → exact-string `fired_at` cross-check → schema decode → embed render → Discord post. Auth failures (`hmac_invalid` / `timestamp_expired` / `replayed`) return an identical generic 401 so the caller cannot tell which check failed. Supporting modules: `hmac.ts` (HMAC-SHA256 over `timestamp + "." + rawBody`, `timingSafeEqual`), `announce-schema.ts` (Effect Schema), `templates.ts` (event_type → embed), `replay-cache.ts` (atomic reserve/commit/release seen-signature cache), `rate-limit.ts` (socket-keyed token bucket, bounded key count). Config: `GATEWAY_WEBHOOK_SECRET`, `GATEWAY_PRESENCE_CHANNEL_ID`, `GATEWAY_HTTP_PORT`.
- `src/shutdown.ts` — SIGTERM/SIGINT handler with a 25s drain. Races `client.destroy()` and the announce server's `close()` against the drain timer; a server-close failure is logged without masking client teardown. New announce requests are refused with 503 while draining.

## Configuration knobs

### `DISCORD_PRIVILEGED_INTENTS`

Opts the gateway into Discord's privileged intents. Default is non-privileged
only (`Guilds` + `GuildMessages`); set this env var (or the matching
`DISCORD_PRIVILEGED_INTENTS_FILE` secret) to add `MessageContent`,
`GuildMembers`, or both.

- **Allowed values:** `MessageContent`, `GuildMembers` (case-sensitive)
- **Format:** comma-separated; whitespace tolerated (`MessageContent, GuildMembers ` works)
- **Empty / unset:** non-privileged baseline only — no opt-in
- **Typo or unknown value:** fail-fast at startup with an error naming the offending token
- **File fallback:** `DISCORD_PRIVILEGED_INTENTS_FILE` mirrors the `${NAME}_FILE` convention from `readOptionalSecret`

Existing deployments that need the privileged set must set this on the next
deploy. The allowlist is intentionally narrow — operators cannot enable
arbitrary Discord intents via this knob.

## Known limitations (v1)

- **`add-project` is Discord-only.** The orchestration runs inside the slash
  command handler and requires a `ChatInputCommandInteraction`; there is no
  programmatic surface (HTTP endpoint, CLI, or agent tool) that triggers the same
  outcome. An autonomous agent cannot bind a repo without going through Discord.
  Recovery is via idempotent retry — re-running the command resumes a partial
  setup — rather than agent-callable recovery primitives. Extracting a
  Discord-independent `addProject(request, deps)` primitive is deferred until a
  non-Discord caller exists.

## Build

```bash
pnpm --filter @fro-bot/gateway build
pnpm --filter @fro-bot/gateway test
pnpm --filter @fro-bot/gateway lint
```

The build runs `tsc --noEmit` for type checking, then `tsdown` to bundle `src/main.ts` into `dist/main.js` (single ESM file). Production deployment runs that bundle inside the container image — see `deploy/gateway.Dockerfile`.
