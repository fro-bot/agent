# Gateway Package — Agent Notes

The Discord-first gateway daemon. Wraps `@fro-bot/runtime` with Effect 3.x as the composition layer.

## Redaction gate

Gateway operator surfaces honor the `metadata/repos.yaml` denylist from `fro-bot/.github@data`. A repo redacted in that file is never included in operator output and never triggers a per-repo GitHub query — the denylist check happens before any binding lookup, run-state read, or status projection.

**Source:** `fro-bot/.github` repository, `data` branch, `metadata/repos.yaml`. Read via the gateway App client's Contents API (injectable `MetadataReader`; tests inject a fake).

**Deny keys** (`databaseId` / `nodeId`) are captured at ingest time (`add-project`) via `GET /repos/{owner}/{repo}` and stored on the `RepoBinding` (gateway-local; the shared `RunState` is not changed). At surface time the gate resolves run → binding → deny keys — no GitHub call is made to resolve repo identity. This is the denylist-before-query invariant.

GitHub models repository ids as int64, so a numeric id is only usable as a deny key when it is a positive integer JavaScript can represent exactly. `isUsableRepositoryId` (`src/shared/repository-id.ts`) is the single definition of that, and both sides of the match consult it: `getRepoIdentity` yields `null` rather than a lossy id that could collide with another repo's key, leaving the binding to carry `nodeId` alone, and a redacted `repos.yaml` entry whose only key is unrepresentable fails the load closed. A binding deny key is therefore best-effort per key and fail-closed in aggregate. Keep the two sides on one predicate — when they disagreed, an oversized id matched itself only by both sides being lossy in the same way.

**Fail-closed posture:**
- Cold start (never successfully loaded) → deny all. No last-known-good to fall back to.
- Refresh failure after a prior good load → serve last-known-good for a bounded grace window while emitting hard alarms (`logger.error`). After the grace window expires without a successful refresh → deny all.
- Missing deny key (binding has no `databaseId` or `nodeId`, or binding not found) → denied. Never resolved via a surface-time query.
- A redacted entry in `repos.yaml` with only an `R_`-format `node_id` and no numeric `database_id` → the whole denylist load fails closed (schema error). Every redacted entry must contribute a usable numeric `database_id`.

**Backfill:** Active bindings created before deny-key capture was added are backfilled offline/admin via `src/bindings/backfill-deny-keys.ts` before the first operator consumer ships. Records still missing deny keys after backfill are omitted (fail closed) — never resolved via a surface-time query.

The backfill ships inside the gateway bundle and runs as a one-off admin command against the deployed image — no Dockerfile change required. It is never invoked from a request handler, Discord command, or HTTP route.

**The bare command is a safe preview — it writes nothing.** Pass `--apply` to perform real writes.

```sh
# Preview (default, no flag): resolve identities, report the plan, write nothing
node dist/main.mjs backfill-deny-keys

# Apply: write deny keys for all bindings that lack them (requires --apply)
node dist/main.mjs backfill-deny-keys --apply

# Help: print usage and exit
node dist/main.mjs backfill-deny-keys --help
```

**Maintenance window:** Run the `--apply` pass during a maintenance window or when no binding mutations are in flight. The backfill only targets legacy keyless bindings (those without a `databaseId`), which normal gateway operation will not concurrently modify. However, the write is an unconditional overwrite (no etag/CAS) using the binding snapshot from `listBindings()`. If the gateway concurrently mutates the same binding between the list and the write (e.g. an `add-project` flow), the backfill will silently revert that change. Scheduling the `--apply` pass when the gateway is idle eliminates this window.

**Required env** (same as the gateway daemon):

| Variable | `_FILE` variant | Notes |
| --- | --- | --- |
| `GITHUB_APP_ID` | `GITHUB_APP_ID_FILE` | GitHub App numeric ID |
| `GITHUB_APP_PRIVATE_KEY` | `GITHUB_APP_PRIVATE_KEY_FILE` | PEM private key |
| `S3_BUCKET` | `S3_BUCKET_FILE` | Object-store bucket name |
| `AWS_REGION` | `AWS_REGION_FILE` | AWS region |
| `AWS_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID_FILE` | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY_FILE` | AWS credentials |

**Optional env:**

| Variable | Default | Notes |
| --- | --- | --- |
| `S3_PREFIX` | `fro-bot-state` | Object-store key prefix |
| `GATEWAY_IDENTITY` | `discord-gateway` | Namespace for bindings in the store |

**Exit codes:**

| Code | Meaning |
| --- | --- |
| `0` | Clean run — all bindings updated or already-keyed (skipped) |
| `1` | Config or setup failure — cannot proceed (check logs for the missing var or adapter error) |
| `2` | Partial failure — some bindings failed to resolve or write; inspect logs, re-run to retry |

The command is idempotent: a binding is skipped once it carries a usable deny key — a numeric `databaseId`, or a `nodeId` when the repository's id is not exactly representable and no numeric key is obtainable.

**Stale-redaction window:** A repo redacted in `repos.yaml` after ingest may surface until the next denylist refresh (bounded by TTL + grace window). Long-lived operator streams re-check on each request. This is a documented accepted risk.

**No-oracle:** Redacted repo owner/name are never stored, logged, or returned anywhere in the gate. Only deny keys (`databaseId` / `nodeId`) are retained from redacted entries. Error messages on denial paths are repo-identity-free.

**Composes alongside `checkRepoAuthz`:** authz proves the operator may see a repo; redaction proves the repo is not hidden by policy. Both must pass. The two gates are independent and cannot silently diverge.

**Cross-reference:** `src/operator-contract/redaction.ts` (`REDACTION_OBLIGATION`) is the agent-side authority. See also: `fro-bot/dashboard` `docs/solutions/security-issues/cross-source-redaction-denylist-before-query-2026-06-15.md` — the dashboard's reference implementation of the same invariant.

## Operator API contract

`packages/gateway/src/operator-contract/` is the **single authority** for operator-surface types (lifecycle, identity, approval-decision, responses) and the contract version. Import from its barrel (`index.ts`); do not re-declare these types elsewhere.

- `registry.handleDecision` is the **sole approval gate** — all transports (Discord, web) settle through it; no transport may implement a parallel settlement path.
- Agent questions settle only through `questionRegistry.decide` (and the gate's deadline, echo, and teardown paths). No transport may reply to or reject a question any other way. See [Agent questions](#agent-questions).
- `OperatorIdentity` is always constructed **server-side** from the authenticated session. It is never deserialized from a request payload.
- `OPERATOR_CONTRACT_VERSION` is **build-time pinned** and never negotiated over the wire. Any endpoint reading a version header must reject unrecognized versions fail-closed.
- The current contract version is `1.9.0`. The dashboard's SSE reader matches the version exactly and fails closed on a mismatch, so a gateway release and the dashboard release pinning the same version deploy as a pair.
- The dashboard's `operator-client.ts` is a **non-canonical downstream fixture**; it does not define the contract.

This Gateway operator-auth surface (`packages/gateway/src/web/auth/`) is the **single S2 operator-auth authority** (ratified [#951](https://github.com/fro-bot/agent/issues/951); ADR: `docs/decisions/2026-06-19-s2-operator-auth-authority.md`). The dashboard delegates interactive operator auth to it and maintains no parallel operator identity — it rides the gateway session (same-origin via `GATEWAY_OPERATOR_PUBLIC_ORIGIN`) and the gateway's numeric-GitHub-user-ID allowlist is the **single allowlist source of truth**. Do not add a second operator OAuth/session/allowlist anywhere downstream.

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
  - `src/discord/commands/fro-bot.ts` — `/fro-bot` parent slash command. Hosts `ping`, `add-project`, `clear-queue`, `force-release-lock`, `recover-checkout`, and the `checkout-backup` subcommand group (`list`/`delete`); dispatches to per-subcommand handlers.
  - `src/discord/commands/recover-checkout.ts` — `/fro-bot recover-checkout`: fresh guild-level `ManageChannels` check, acquires the repo lock, previews via `workspace-api/client.ts`'s `previewRecovery`, shows an ephemeral Preserve-and-replace/Cancel prompt with a 60-second one-shot nonce, then calls `recover` on confirm. `src/discord/recover-checkout-button.ts` parses the Recover-entry button's custom ID (channel only, no authority) and reruns the identical flow via `runRecoverCheckoutFlow`.
  - `src/discord/commands/checkout-backup.ts` — `/fro-bot checkout-backup list` (calls `listBackups`) and `delete <id>` (confirmation prompt with the same nonce rules, then `deleteBackup`).
  - `src/discord/questions.ts` — pure agent-question UI primitives: the `fb-q:` custom-id codec (`buildQuestionCustomId` / `parseQuestionCustomId`), `planQuestionPrompt` (native prompt or a named fallback reason), the answer modal, the fallback notice, and the settled embed.
  - `src/discord/question-interactions.ts` — `handleQuestionInteraction`: option/Skip/text buttons, select menu, and modal submit. Authorizes through the same role gate as approvals, maps option indices to raw labels, and decides through the question registry with a Discord actor scoped to the thread.
  - `src/discord/reactions.ts` — run-state emoji reactions. Posts lifecycle emoji (working / succeeded / failed) to the source message as the run progresses.
  - `src/discord/presence.ts` — resolves a channel by ID via `client.channels.fetch` and posts an embed with `allowedMentions: {parse: []}`. Used by the announce webhook to post control-plane presence messages as the Fro Bot user.
- `src/workspace-api/` — HTTP client for the workspace-agent sidecar service. `WorkspaceClient` (`client.ts`) wraps `/clone`, `/inspect`, `/update`, `/recover/preview`, `/recover`, and `/backups` (list/delete), mapping HTTP error shapes to typed `Result<T, E>` values per endpoint — each with its own deadline (clone 300s, inspect 25s, update/preview/recover/backups with their own defaults, readyz 5s). Injected into `add-project.ts` via `AddProjectDeps` and into `execute/run.ts`'s `RunMentionDeps` (`update`) and the recovery/backup commands above.
- `src/http/` — the inbound announce webhook (`POST /v1/announce`), the gateway's only HTTP ingress. Hono server (`server.ts`) reads the raw body and maps the framework-agnostic handler (`announce-handler.ts`) result to a response. The handler runs an ordered fail-closed pipeline: 8 KB size cap → rate limit → required headers → HMAC verify → timestamp window → replay reserve → JSON parse → exact-string `fired_at` cross-check → schema decode → embed render → Discord post. Auth failures (`hmac_invalid` / `timestamp_expired` / `replayed`) return an identical generic 401 so the caller cannot tell which check failed. Supporting modules: `hmac.ts` (HMAC-SHA256 over `timestamp + "." + rawBody`, `timingSafeEqual`), `announce-schema.ts` (Effect Schema), `templates.ts` (event_type → embed), `replay-cache.ts` (atomic reserve/commit/release seen-signature cache), `rate-limit.ts` (socket-keyed token bucket, bounded key count). Config: `GATEWAY_WEBHOOK_SECRET`, `GATEWAY_PRESENCE_CHANNEL_ID`, `GATEWAY_HTTP_PORT`.
- `src/web/` — Hono HTTP server for the operator web surface (gateway-net only). `server.ts` (`buildOperatorApp`) wires all operator routes behind the browser guard (session + allowlist + CSRF). `src/web/operator/` contains the authenticated operator routes:
  - `launch-route.ts` — `POST /operator/runs`: fire-and-return launch endpoint. Validates body, resolves binding server-side, checks denylist before authz, enforces per-operator idempotency and rate limits, registers a PENDING run-index entry, then fires `launchWork` without awaiting. Returns 202 `{runId}` immediately. Background run failures are logged via the fired promise's `.catch`; a failed run's idempotency key persists until TTL (failure-aware cleanup needs run-state lifecycle tracking).
  - `dispatch-route.ts` — `POST /operator/dispatch`: authenticated workflow-dispatch endpoint. Resolves the server-owned binding, checks denylist before write-level repo authz, and returns the complete structured `DispatchOutcome` as `200 {outcome}`; audit records carry only the outcome discriminant and optional run ID. Client contract: `accepted` without `runId` is a real acceptance (GitHub's 204-no-details path) — consumers poll the repo's workflow runs to locate it, and must not treat the missing ID as failure.
  - `repos-route.ts` — `GET /operator/repos`: lists bound repos the operator is authorized to access. Fans out to `checkRepoAuthz` per binding (up to `MAX_REPOS_PER_LISTING`); denylist filter runs before any GitHub call. Per-operator rate limit (20/min) bounds the authz fan-out.
  - `runs-route.ts` — `GET /operator/runs`: session-gated, repo-scoped, denylist-filtered run enumeration. Returns `{runs: RunSummary[]}` newest-first, capped at 100. Mirrors the security posture of `GET /operator/repos` exactly: denylist-before-authz, no-oracle omission, operator-keyed rate limit (20/min), `Cache-Control: no-store, private`. Run-states are read only for authorized, non-denied repos (authz fan-out bounds GitHub calls to binding count, not run count).
  - `idempotency.ts` — `createIdempotencyGuard`: bounded in-memory per-operator idempotency store backing the launch and dispatch routes. Keys are namespaced `${githubUserId}:${clientKey}` and capped at `IDEMPOTENCY_KEY_MAX_LENGTH` (256). Supports `check` / `reserve` / `commit` / `rollback`. Evicts expired entries before live ones at capacity.
  - `web-sinks.ts` — `createWebStatusSink` / `createWebReplySink`: no-op transport UX sinks for web-launched runs. v1 delivers run status via SSE only; agent output text is buffered but not streamed.
  - `web-approval.ts` — `createWebApprovalOnPending`: real web approval transport. Registers each tool-permission request in the approval registry (register-before-fan-out) and fans out an SSE approval frame via `observeApproval` so the operator can see and decide it. Fail-soft fan-out: if `observeApproval` throws, the error is logged at warn and swallowed — the registry entry is already registered and the deadline still settles fail-closed.
  - `web-question.ts` — `createWebQuestionOnRegistered`: web question transport. The coordinator registers the question first; this emits the SSE open frame and attaches the settle-frame render. Fail-soft: a throwing `observeQuestion` is logged by id and swallowed.
  - `pending-questions-route.ts` — `GET /operator/runs/:runId/questions`: read-level reconciliation listing of a run's open questions as bounded DTOs, found by run id (so Discord-launched runs are included), hard-capped at 50, rate limited per operator.
  - `question-decision-route.ts` — `POST /operator/runs/:runId/questions/:requestId/decision`: write-level answer or skip. 64 KiB body limit ahead of everything else, no-oracle denials, index-to-label mapping (`question-choices.ts`), then `questionRegistry.decide`; emits the `question.decision` / `question.rejected` audit events. A refused body is `400 {error: 'bad request', reason, questionIndex}` (`QuestionDecisionErrorResponse`), the standard operator error envelope; the 200 states live in `QuestionDecisionResponse`.
- `src/operator-contract/` — single authority for operator-surface types and contract version. `repo-summary.ts` (`toRepoSummary`) projects a `RepoBinding` to the operator-safe `RepoSummary` shape (owner, repo, channelName only — no internal IDs, paths, or deny keys).
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
   - Repo lock acquisition via S3-conditional-write (`coordination/lock.ts`, default `repo.json` scope). Gateway runs exclude each other per repo (shared checkout); GitHub Action runs lock `action.json` instead and are not excluded by, nor exclude, the gateway.
   - Run-state lifecycle: PENDING → ACKNOWLEDGED → EXECUTING, with a heartbeat that renews the lock lease every `HEARTBEAT_INTERVAL_MS`.
   - **Checkout preparation**, under the repo lock, before EXECUTING: calls `update()` (`POST /update`) first, never `ensureClone` (`POST /clone`) unconditionally — `ensureClone` runs only when `/update` reports `no-checkout`, then `/update` is retried. A `refused`/`failed` outcome ends the run before EXECUTING with a `CheckoutPreparation` record (`execute/provenance.ts`) and a reply (`execute/preparation-reply.ts`); every reason except `maintenance-hold` names `/fro-bot recover-checkout` and carries a Recover button. A `ready` outcome's own admission gates already guarantee a clean, attached checkout, so `CheckoutProvenance` is synthesized from the result directly rather than an extra `/inspect` call. The mutex, journal, and maintenance-hold state this depends on all live in the workspace, not here — see `apps/workspace-agent/AGENTS.md`.
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

The `/fro-bot force-release-lock` subcommand lets a ManageChannels operator clear a stuck per-repo coordination lock. It is corroborated: the lock is only deleted when the lease is expired AND the repo's OpenCode workspace status check (`execute/repo-quiescence.ts`) reports `clear`; `busy` or `unknown` refuses (`workspace-busy` / `workspace-unknown`). Operator guidance for a refusal: wait for or cancel the repo's running sessions; if still busy, or the workspace is down, restart the workspace and retry once its status endpoint is reachable (a stopped container yields `unknown`, never `clear`). The run-state heartbeat is diagnostic only. An `IfMatch` conditional delete on the ETag observed before the check ensures a re-acquired lock is never deleted. Requires guild-level ManageChannels (trigger-role-only users are denied). Operator-facing; not a substitute for normal lock release.

Releasing is always done in a `finally` block so crashes leave the system in a recoverable state.

### Startup stale-run recovery

`execute/recovery.ts` (`recoverStaleRuns`) runs once after Discord login on every gateway startup. It scans all bound repos for runs left in `EXECUTING`, `PENDING`, or `ACKNOWLEDGED` by a prior crash. The repo lock is acquired before the `PENDING`→`ACKNOWLEDGED` transition and held across `ensureClone` (which can run for minutes), so a crash can strand the lock under any of the three phases, not just `EXECUTING`. For each stranded run it:

1. Checks the repo's OpenCode workspace status. `busy` or `unknown` leaves the run and the lock untouched (blocked recovery, logged); persisted ownership is never consulted.
2. When `clear`, re-reads the run and re-checks staleness on that fresh record (a heartbeat during the check means it is alive — skipped), then transitions it to `FAILED` via a conditional write against that read's etag.
3. Posts a brief "previous task interrupted on restart" note to the original thread (best-effort; skipped if the transition failed or the thread is unreachable).

Startup recovery never deletes the coordination lock; a leftover lease lapses by TTL and the next acquisition re-runs the workspace check before taking over.
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

### Agent questions

When the agent calls OpenCode's `question` tool, OpenCode emits `question.asked` and blocks the call until the request is replied to or rejected. The `question` tool is enabled in gateway workspaces and the gateway answers it; the design is in [ARCHITECTURE.md](../../ARCHITECTURE.md#agent-questions-gateway).

**Flow:** `run-core.ts` hands an owned `question.asked` to the per-run `QuestionCoordinator`, which computes a deadline from the budget left (or skips immediately), registers the question in the question registry, then calls the run's `onRegistered` hook. The hook fans out to the web transport (SSE `question` frame), the Discord transport (Discord-launched runs only), and the push nudge. The question registry and the approval registry share one request gate.

**Conventions contributors must keep:**

- **Settle only through the gate.** Answer, skip, deadline, teardown, and echo all go through the registry and gate. Never call `replyQuestion` / `rejectQuestion` from a transport.
- **Skip is an empty reply, not a reject.** A skip and a deadline expiry reply with an empty answer per question so the agent continues. Reject is reserved for cancel and run teardown, and for a malformed ask.
- **Never log question or answer text.** Logs, audit events, errors, and push payloads carry request ids, run ids, actor ids, and reason codes. Do not log an effect's or SDK's raw error string either; it can echo the text.
- **Question and answer strings are untrusted plain text.** Carry them verbatim, bound and strip control characters at the build site (`approvals/question-detail.ts`), escape them with `escapeMarkdown` in Discord, and never pre-render HTML or Markdown.
- **Map answers by index.** Operators name options by zero-based index into the question's `options`; map back to the raw label from the registry (`describeRequest`) before calling `decide`. Option buttons and select values carry indices, never labels.
- **Attach transports with `attachMessage`.** A transport registers its settle render through `questionRegistry.attachMessage`. Renders accumulate, so web and Discord each keep their own. A render must be fail-soft and must not reject.
- **Register before fan-out.** The coordinator registers the question before any transport posts it, and a transport's `onRegistered` hook must never throw into the coordinator.
- **A delivery failure never settles a question.** Web answering and the deadline remain.
- **Count caps.** An ask with more than `MAX_QUESTIONS_PER_REQUEST` (8) questions or `MAX_OPTIONS_PER_QUESTION` (64) options in a question is parsed as malformed with reason `oversize` and rejected through `onMalformed`; it is never registered or announced. Log ids and reason codes, never text.
- **A claimed request is not settled.** `describe*` lists omit `claimed` entries, so the web decision route and the Discord handler ask `questionRegistry.isClaimed` before answering "no longer pending": a claimed request yields `already_claimed` (Discord: fixed "Already being answered." copy). On the web route `isClaimed` is scoped to the route's run, so another run's claimed request stays indistinguishable from an unknown id; this runs after the denylist, authz, and run-resolution gates.
- **Activity never undoes a pause.** `run-core`'s `resetInactivity` is the single re-arm path and refuses while `outstandingHumanWaits.size > 0` or `draining === true`; the last release outside drain re-arms by calling it after the delete. Do not add a call site that re-arms around it.
- **A settled ledger is not completion.** For a run that adopted a background dispatch, `run-core` completes only through `drain-completion.ts`: ledger settled, each child's `<task id=… state=completed|error>` notice (or REST cancel evidence, `MessageAbortedError`) observed, current-generation root idle, and REST corroboration of the latest root user message's reply. Human waits never participate. Do not add a path that aborts the drain from a ledger mutation; mutations only request validation. The drain's follow-up window is not covered by the settled-ledger fast path: `throwWithBarrier` passes `confirmRootQuiescent` to `settleOwnedSessions` whenever the run is draining and not admitted, so a failure there aborts and confirms the ROOT (or quarantines). Admission also needs the delivery fence (`reply-delivery.ts`): the follow-up turns' persisted reply text must already be in the sink. Never append, repair, or reorder reply text at or after admission — the sink is append-only and may be on screen. The persisted text is never trimmed when matching (a missing separator is a missing part of the reply); the only slack is extra trailing whitespace delivered after it. A text part seen only as a whole `message.part.updated` is not delivery evidence. Keep the tracker in step with every `sink.append` of ROOT reply text from deltas.
- **A dispatch is not a child session.** Upstream resumes a child on `task_id` reuse, so one child session id can carry several background jobs, each injecting its own notice. `run-core` tracks dispatches by their `task` tool part id: a replay is ignored, a new start calls `ledger.reopen` (never `adopt`) and `drainCompletion.noteDispatch`, an `updated` extension reopens but adds no expected notice. The fence counts distinct notice parts and per-dispatch cancellations against dispatches; never key notice or cancel evidence by child id alone.
- **Teardown is per family.** `approvalRegistry.disposeRun/disposeAll` touch only approvals and `questionRegistry.disposeRun/disposeAll` only questions; gateway shutdown uses `requestGate.disposeAllAcrossFamilies`. A claimed question or approval torn down mid-reply is rejected once (permission `reject` reply for approvals) if that reply later fails, unless the gate's deadline fail-close already started recovery (`entry.recoveryStarted`): then its reply is the one recovery and the family sends none.
- **Gate callers use whole operations.** `put`, `admit` → `submit`, `settleEcho`, `settleNow`, `retire`. Never reintroduce a primitive that clears a timer, removes an entry, or emits the terminal event on its own.

**Discord:** the prompt is posted only for Discord-launched runs, into the run thread, and only for a single-question request that fits Discord's component limits: buttons for up to 20 options when not `multiple`; a string select for 21–25 options, or for `multiple` with up to 25; a control row with Skip, plus "Answer with text…" (a 4,000-character modal) when a custom answer is allowed. Anything else posts a fixed-copy notice pointing at the operator web surface, with a link when `GATEWAY_OPERATOR_PUBLIC_ORIGIN` is configured, and never includes question text. Custom ids are `fb-q:<code>:<requestID>` with a trailing `:<optionIndex>` for option buttons; the codes are `o` option, `s` select, `k` skip, `t` text button, `m` modal. The codec refuses an id over 100 characters and the request then takes the web fallback. A Discord actor settles only a question from its own thread; a web operator with write access can settle any run's question.

**Discord decision records:** Discord decisions are structured logs carrying ids and an outcome or reason code only, using the same kind names as the web audit events. `question.decision` has an `outcome` of `answered` or `skipped`. `question.rejected` has a `reason` of `scope_mismatch`, `already_claimed`, `not_found`, `invalid`, or `reply_failed`. A user who fails the role gate gets an ephemeral refusal and a separate warning with reason `unauthorized`. These are logs rather than web audit events because the web events carry a GitHub user id, which a Discord actor does not have.

**Restart limitation:** pending questions are in memory only. A gateway restart loses them; see [Known limitations](#known-limitations).

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

- **Agent questions do not survive a restart.** A pending question and its deadline timer are held in memory by the question registry. A gateway restart loses them along with the run, and startup stale-run recovery handles the run. If only the workspace restarts, OpenCode loses the pending question, the gateway's deadline skip fails closed, and the terminal notification releases the run's wait.

- **Fresh session per mention.** Each mention starts a new OpenCode session from scratch. There is no conversational continuity across mentions (session persistence is planned but not yet wired into the Discord surface).

- **In-memory concurrency state.** The concurrency registry is per-process and resets on gateway restart. Startup stale-run recovery handles lock/run-state cleanup, but the in-flight concurrency counter is not persisted.

- **Output is posted at run completion, not streamed incrementally.** The sink accumulates the full agent response in memory and flushes it to the Discord thread when the run completes (or, on failure, best-effort partial output is flushed before the coarse error reply). Output is NOT streamed incrementally to Discord during execution.

- **`heartbeat.stop()` failure can leave a run stuck.** If `heartbeat.stop()` returns an error, the gateway logs a warning and proceeds with last-known etags, but the run may remain in EXECUTING with the lock held until the lease expires. The next startup recovery sweep will detect and heal the stale run automatically.

- **Run-observation cache leak on failed transitions.** If a run's state transition fails after the PENDING observe is sent (so the run never reaches a terminal status), its latest-status cache entry in the run-observation manager is never cleared. A future subscriber for that run would receive the stale cached status rather than a reset frame. The entry is cleared on process restart. A future staleness/reconcile path will evict these entries proactively.

## Build

```bash
bun run --filter @fro-bot/gateway build
bun run --filter @fro-bot/gateway test
bun run --filter @fro-bot/gateway lint
```

The build runs `tsc --noEmit` for type checking, then `tsdown` to bundle `src/main.ts` into `dist/main.mjs` (single ESM file). Production deployment runs that bundle inside the container image — see `deploy/gateway.Dockerfile`.
