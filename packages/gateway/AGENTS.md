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
  - `src/discord/io.ts` — **centralized Discord content-send helper**. All Discord content sends (messages, interaction replies/edits) go through this module. Hardcodes `allowedMentions:{parse:[]}` on every call — mention-safe by default, fail-soft (never throws). Exports `sendMessage`, `editMessage`, `replyInteraction`, `editInteraction` (Effect-returning), and `replyInteractionAsync`/`editInteractionAsync` (plain-async wrappers for non-Effect.gen callers). `io.boundary.test.ts` enforces the boundary: any raw Discord content-send call outside the allowlist fails the test. Allowlisted legacy best-effort files that already set `allowedMentions:{parse:[]}` and catch internally: `presence.ts`, `status-message.ts`, `execute/recovery.ts`, `reactions.ts`.
  - `src/discord/channels.ts` — channel creation helper used by the add-project flow. `createChannelWithCollisionSuffix` always creates a fresh channel; it never returns an existing one. Tries the exact name first, then `name-2` through `name-10`, skipping any candidate whose name is already taken.
  - `src/discord/commands/guild-command.ts` — shared pipeline factory for guild-bound slash subcommands. Owns the full entry sequence: optional `preDefer` hook → guild-null guard → `deferReply` → `authorize` policy → `work` body → failure-reply catchAll. Any new guild-bound subcommand must be built with `makeGuildCommand` rather than hand-rolling the defer/auth/failure sequence. The factory exports `INTERNAL_ERROR_COPY` for reuse in exhaustiveness guards.
  - `src/discord/commands/add-project.ts` — `/fro-bot add-project` slash command. Orchestrates the 5-phase flow (PRE_FLIGHT → CLONING → CREATING_CHANNEL → WRITING_BINDING → READY). Depends on `channels.ts` for channel creation, `workspace-api/client.ts` for repo cloning, `bindings/store.ts` for durable binding persistence, and `github/app-client.ts` for GitHub App token acquisition.
  - `src/discord/commands/fro-bot.ts` — `/fro-bot` parent slash command. Hosts `ping`, `add-project`, `clear-queue`, and `force-release-lock` subcommands; dispatches to per-subcommand handlers.
  - `src/discord/reactions.ts` — run-state emoji reactions. Posts lifecycle emoji (working / succeeded / failed) to the source message as the run progresses.
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

### `GATEWAY_STATUS_MODE`

Controls the working-state UX posted to the run thread while the agent is executing. `live-status` (default) posts a single live status message plus a typing indicator; `typing-only` shows only the typing indicator (no status message). Absent or empty → `live-status`.

## Mention-triggered execution loop

When a guild member `@fro-bot`s in a channel, `discord/mentions.ts` handles the event:

1. **Thread guard** — skips if the message is already inside a thread (avoids recursive loops).
2. **Authorization gate** — fetches the member via REST (`guild.members.fetch()`; never via cache, which requires a privileged intent). If `GATEWAY_TRIGGER_ROLE_ID` is configured the member must hold that role; otherwise guild-level `ManageChannels` is required. Any resolution failure is fail-closed: access denied.
3. **Binding lookup** — resolves the channel to a `RepoBinding` via the object-store index. If the channel has no binding the user is told to run `/fro-bot add-project` first.
4. **`runMention`** (`execute/run.ts`) — manages the full execution lifecycle inside a `finally`-guarded resource block:
   - Global concurrency cap + per-channel in-flight guard (in-memory, resets on restart; stale-run recovery handles crash-time stranding).
   - Thread creation on the source message.
   - Repo lock acquisition via S3-conditional-write (`coordination/lock.ts`).
   - Run-state lifecycle: PENDING → ACKNOWLEDGED → EXECUTING, with a heartbeat that renews the lock lease every `HEARTBEAT_INTERVAL_MS`.
   - OpenCode execution via `execute/opencode-attach.ts` + `execute/run-core.ts`; streaming output is flushed to the thread by `discord/streaming.ts`.
   - On completion: run transitions to COMPLETED, heartbeat stops, lock is released.
   - On failure: run transitions to FAILED; a coarse error message (no internal detail) is posted to the thread.

### Authorization details

The trigger authorization gate is the security boundary between Discord users and agent execution. It is deliberately strict:

- Uses `guild.members.fetch()` (REST) — not `members.cache.get()` (which silently returns `undefined` without the `GuildMembers` privileged intent).
- If `GATEWAY_TRIGGER_ROLE_ID` is set, only members with that role may trigger. Without it, only members with guild-level `ManageChannels` may trigger.
- Any permission-resolution error → deny (fail closed). The error is logged; the user receives a generic "not authorized" reply.

### Bearer-token attach path

The gateway connects to OpenCode running inside the workspace container via the `WORKSPACE_OPENCODE_URL` endpoint (default `http://workspace:9200`). Every request to that endpoint is authenticated with a shared bearer token read from `WORKSPACE_OPENCODE_TOKEN`. The token is never logged or posted to Discord. The workspace container reverse-proxies OpenCode and validates the token before forwarding.

### OpenCode server port model

The workspace container runs two listening ports:

| Port | Service | Access |
| ---- | ------- | ------ |
| 9100 | Workspace agent (clone/setup API) | Internal sandbox network only |
| 9200 | OpenCode reverse proxy (bearer-authenticated) | Internal sandbox network only |

Both ports are loopback-bound inside the sandbox network. The egress proxy (`mitmproxy`) only permits outbound traffic to the allowlisted hosts; inbound connections from outside the sandbox are not possible by network topology. The gateway reaches these ports via the Docker Compose service DNS name `workspace`.

### Concurrent-run semantics

Each channel runs tasks serially via a per-channel FIFO queue. When a mention arrives:

- **cap** — global `GATEWAY_MAX_CONCURRENT_RUNS` limit reached → terminal "at capacity, try again shortly" reply. No queue entry is created.
- **busy** — this channel already has an active run → the new task is enqueued (up to the per-channel queue depth). The user receives a "Queued" ack and the task starts automatically when the current run finishes.
- **pending work present** — even if a slot appears free, a new mention is enqueued rather than starting immediately, so older queued work is never leapfrogged.
- **waiting** — the repo lock is held by another run → "another task in progress for this repo, try again when it completes".

On completion, the finishing run atomically hands the channel slot to the next queued task (if any) without releasing and re-acquiring it. This closes the window where a concurrent mention could slip in ahead of queued work. The queue is in-memory only — a gateway restart drops any pending tasks.

On graceful shutdown (SIGTERM), pending queued tasks are dropped: the handoff is suppressed and the channel slot is released immediately. The in-flight run finishes its own cleanup (lock release, run-state transition, heartbeat stop) but does not start any new runs. This is consistent with the `messageCreate` guard that refuses new mentions once shutdown is requested. The in-memory queue is lossy by design; dropping pending tasks on shutdown matches that contract.

The `/fro-bot clear-queue` subcommand drops all pending queued tasks for the invoking channel. It is authorization-gated with the same authority check as the mention path (trigger role or guild-level ManageChannels). The in-flight run (if any) is unaffected.

The `/fro-bot force-release-lock` subcommand lets a ManageChannels operator clear a stuck per-repo coordination lock. It is dead-run-verified: the lock is only deleted when BOTH the lock lease is expired AND the run-state heartbeat is stale or absent. An `IfMatch` conditional delete ensures a live run's re-acquired lock is never deleted. Requires guild-level ManageChannels (trigger-role-only users are denied). Operator-facing; not a substitute for normal lock release.

Releasing is always done in a `finally` block so crashes leave the system in a recoverable state.

### Startup stale-run recovery

`execute/recovery.ts` (`recoverStaleRuns`) runs once after Discord login on every gateway startup. It scans all bound repos for runs that were left in the `EXECUTING` phase by a prior crash — the only phase that can be stranded with a held lock and lease (PENDING→ACKNOWLEDGED→EXECUTING all complete synchronously before any interruptible await). For each stranded run it:

1. Transitions the run state to `FAILED` via a conditional-write against the current S3 object etag.
2. Releases the repo lock so the next mention can proceed.
3. Posts a brief "previous task interrupted on restart" note to the original thread (best-effort; skipped if the thread is unreachable).

Per-run errors are logged and the sweep continues — one corrupted record does not block recovery for the rest.

### Tool approval

When the workspace OpenCode config sets any tool to `ask` (rather than the default `allow`), OpenCode will pause execution and emit a `permission.asked` event before running that tool. The gateway intercepts these events and presents an interactive Discord approval prompt.

**How it works:**

- Each `permission.asked` event creates a Discord embed with Approve / Deny buttons in the run thread.
- Approvers must pass the same `userIsAuthorized` gate as trigger mentions: either hold the `GATEWAY_TRIGGER_ROLE_ID` role or have guild-level `ManageChannels`.
- The first valid button click wins (single-winner). A subsequent click on the same embed is a no-op.
- While the prompt is open, the agent run is paused. OpenCode resumes only after the reply reaches the workspace.
- If no decision is received within the approval deadline (a sub-deadline of the overall run timeout, capped at 13 minutes for Discord interaction-token expiry), the gateway fail-closes with `reject`: the tool is blocked, the embed is updated, and the run continues or errors from the rejection.
- Multiple open approvals from the same session are handled independently; a `reject` decision cascades and closes all sibling prompts in that session.
- **Default:** if no tool is set to `ask`, no approval prompts appear — all tools auto-run.
- **Restart limitation:** a pending approval is in-memory only and does not survive a gateway or workspace restart. See [Known limitations](#known-limitations) below.

## Known limitations

- **`add-project` is Discord-only.** The orchestration runs inside the slash
  command handler and requires a `ChatInputCommandInteraction`; there is no
  programmatic surface (HTTP endpoint, CLI, or agent tool) that triggers the same
  outcome. An autonomous agent cannot bind a repo without going through Discord.
  Recovery is via idempotent retry — re-running the command resumes a partial
  setup — rather than agent-callable recovery primitives. Extracting a
  Discord-independent `addProject(request, deps)` primitive is deferred until a
  non-Discord caller exists.

- **Mention-triggered execution is Discord-only.** A run starts only from an
  authorized `@fro-bot` mention in a bound channel; there is no HTTP endpoint,
  CLI, agent tool, or slash-command equivalent for starting a run. Extracting a
  Discord-independent execution primitive and caller surface is deferred until a
  non-Discord caller exists.

- **In-memory queue only.** The per-channel FIFO queue is in-memory and does not survive a gateway restart. Any pending queued tasks are silently dropped on restart; users must re-mention to retry. The global concurrency cap (`cap` path) is still terminal — no queue entry is created when the cap is reached.

- **Tool approval does not survive a restart.** A pending approval is held in memory by the per-run coordinator. If the gateway or workspace restarts while a permission prompt is in flight, the pending approval is abandoned: the coordinator's deadline fires (or the process exits fail-closed), the Discord embed is settled with `rejected`, and the run surfaces as interrupted. Re-mention to retry.

- **Fresh session per mention.** Each mention starts a new OpenCode session from scratch. There is no conversational continuity across mentions (session persistence is planned but not yet wired into the Discord surface).

- **In-memory concurrency state.** The concurrency registry is per-process and resets on gateway restart. Startup stale-run recovery handles lock/run-state cleanup, but the in-flight concurrency counter is not persisted.

- **Output is posted at run completion, not streamed incrementally.** The sink accumulates the full agent response in memory and flushes it to the Discord thread when the run completes (or, on failure, best-effort partial output is flushed before the coarse error reply). Output is NOT streamed incrementally to Discord during execution.

- **`heartbeat.stop()` failure can leave a run stuck.** If `heartbeat.stop()` returns an error, the gateway logs a warning and proceeds with last-known etags, but the run may remain in EXECUTING with the lock held until the lease expires. The next startup recovery sweep will detect and heal the stale run automatically.

## Build

```bash
pnpm --filter @fro-bot/gateway build
pnpm --filter @fro-bot/gateway test
pnpm --filter @fro-bot/gateway lint
```

The build runs `tsc --noEmit` for type checking, then `tsdown` to bundle `src/main.ts` into `dist/main.js` (single ESM file). Production deployment runs that bundle inside the container image — see `deploy/gateway.Dockerfile`.
