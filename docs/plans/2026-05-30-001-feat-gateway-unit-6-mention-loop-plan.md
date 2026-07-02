---
title: "feat: Gateway Unit 6 MVP — @fro-bot mention → OpenCode interaction loop (remote attach)"
type: feat
status: active
date: 2026-05-30
origin: docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md
deepened: 2026-05-30
---

# Gateway Unit 6 MVP — `@fro-bot` Mention → OpenCode Interaction Loop

## Overview

This plan delivers the **MVP core** of Gateway v1 Unit 6: a `@fro-bot <message>` mention in a
Discord channel bound to a repo drives OpenCode against that repo's cloned checkout, streaming the
agent's text response back into a Discord thread, with full run-state lifecycle and per-repo lock
coordination.

**Topology decision (locked): Option A — remote attach.** The OpenCode SDK server runs *inside the
workspace container* (where the cloned repo + egress-filtered network live, per the brainstorm's
sandbox model). The gateway connects to it over HTTP+SSE via `createOpencodeClient({baseURL})` and
reuses the battle-tested runtime event-interpretation primitives (`processEventStream`,
`pollForSessionCompletion`). This preserves the sandbox boundary while reusing the streaming logic
that the 1.14.41 pin saga proved correct.

**Scope (locked): MVP core only.** This plan covers mention → resolve binding → acquire lock →
create run-state → remote-execute → stream text back → lifecycle/lock release. Discord UX polish
(reactions, working-message heartbeat), approval buttons, the per-thread queue, and the ancillary
slash commands (`review`, `sessions`, `resume`, `clear-queue`, `approvals`, `force-release-lock`)
are explicitly deferred to a follow-up plan.

## Problem Frame

Unit 5 shipped the binding surface (`/fro-bot add-project` binds a channel to a repo and clones it
into the workspace). The announce webhook shipped the inbound control-plane slice. But the
user-facing payoff — actually *talking to the agent* — does not exist yet: `handleMention` in
`packages/gateway/src/discord/mentions.ts` is a v1 stub that creates a thread and replies `pong`,
explicitly marked "Proper session-aware naming arrives in Unit 6."

The original Unit 6 spec (origin: `docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md`,
lines 745-817) crams 15 new files into a single "unit." That is a multi-PR sequence, not a unit. This
plan carves the MVP core that makes `@fro-bot` genuinely work, de-risks the remote-attach topology
first, and leaves the UX/approval/queue layers for a follow-up.

## Requirements Trace

Carried from the origin Unit 6 spec (see origin: `docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md`):

- **AUTHZ** (added during deepening): only authorized members (trigger role or `ManageChannels`) may
  trigger execution; the workspace OpenCode server requires a bearer token on the attach path; a global
  concurrency cap bounds resource use.

- **R1** (action-taking): `@fro-bot <message>` runs OpenCode against the bound repo's checkout.
- **R4** (local default): execution targets the workspace checkout, not a cloud dispatch.
- **R9** (Discord-native UX): response streams into a Discord thread; long responses fall back to a
  `.md` attachment. (Reactions/working-message deferred.)
- **R11** (lifecycle): run-state PENDING → ACKNOWLEDGED → EXECUTING → COMPLETED/FAILED; per-repo lock
  held throughout, released on terminal state; stale runs recovered on gateway restart. (Queue
  deferred.)
- **S1-S6** (sandbox integrity): OpenCode executes inside the workspace container; the gateway never
  touches the repo working tree or the egress-filtered network directly.

## Scope Boundaries

- No reactions (👀/🎉/😕) — deferred.
- No working-message heartbeat editor — deferred.
- No approval buttons / tool-permission embeds — deferred.
- No per-thread queue — MVP rejects a second concurrent mention in the same thread with a "busy"
  reply rather than queuing (lock contention across channels still handled).
- No ancillary slash commands (`review`, `sessions`, `resume`, `clear-queue`, `approvals`,
  `force-release-lock`) — deferred.
- No incoming file attachments — agent works only with the message text (matches origin spec).
- No smart message splitting — long responses always use the `.md` file fallback.
- No session resume / multi-turn conversation — each mention is a fresh session in MVP. (Within-thread
  continuity deferred.)

### Deferred to Separate Tasks

- **Discord UX layer** (reactions, working-message heartbeat): follow-up plan, references origin
  spec files `packages/gateway/src/discord/progress.ts`, `reactions.ts`.
- **Approvals** (button components, opaque-token S3 payloads): follow-up plan, references origin spec
  `packages/gateway/src/discord/approvals.ts` + `commands/approvals.ts`.
- **Queue** (serial-per-thread): follow-up plan.
- **Ancillary slash commands**: follow-up plan, references origin spec `commands/{review,sessions,resume,clear-queue,force-release-lock}.ts`.

## Context & Research

### Relevant Code and Patterns

Runtime (reuse — `packages/runtime/src/agent/`):
- **`processEventStream` is NOT a barrel export today** — it is consumed inside `runPromptAttempt`
  via an injected `dependencies.processEventStream(...)` callback (`retry.ts`). To reuse the
  event-interpretation logic (handles `message.part.delta`, `session.next.text.delta`,
  `session.next.tool.{called,success}`, `message.part.updated`, `message.updated`, `session.error`,
  `session.idle`), Unit 2 must add a small additive export from the runtime barrel (`index.ts`) — a
  relocation, not a behavior change. This is a real prerequisite the plan owns, not free reuse.
- `pollForSessionCompletion(...)` + `runPromptAttempt(...)` — completion detection + retry/backoff
  (verify export status when wiring; export additively if needed).
- `OpenCodeServerHandle = {client; server: {url; close()}; shutdown()}` — the injection seam. A
  remote-attach handle can wrap `createOpencodeClient({baseURL})` with a no-op `close`/`shutdown`
  (the gateway does not own the remote server).
- **Critical constraint (memory):** the `/event` SSE subscription MUST pass the workspace `directory`
  — subscribing without it splits the SSE listener from the publisher and tool events never arrive.
  The remote-attach path must thread `directory` through both `event.subscribe` and `promptAsync`.

Coordination (reuse — `packages/runtime/src/coordination/`):
- `acquireLock(config, repo, holderId, surface, runId, logger)`, `releaseLock(config, repo, etag, logger)`.
- `createRun(config, identity, repo, runState, logger)`, `transitionRun(config, identity, repo, runId, newPhase, etag, logger)`, `findStaleRuns(config, identity, repo, logger)`.
- `createHeartbeatController(config, identity, repo, runId, lockEtag, logger)`.
- `RunPhase = 'PENDING'|'ACKNOWLEDGED'|'EXECUTING'|'COMPLETED'|'FAILED'|'CANCELLED'`; `Surface = 'github' | 'discord'` (use `'discord'`); full `RunState` shape (all fields required for construction): `run_id`, `surface`, `thread_id`, `entity_ref`, `phase`, `started_at`, `last_heartbeat`, `holder_id`, `details` (`packages/runtime/src/coordination/types.ts`).

Gateway (extend — `packages/gateway/src/`):
- `discord/mentions.ts::handleMention(message, botUserId)` — the pong stub to replace.
- `bindings/store.ts::getBindingByChannelId(channelId)` → `Result<RepoBinding | null, ...>` — resolve repo from channel.
- `program.ts::makeGatewayProgram` — wires `client.on('messageCreate', ...) → handleMention`; the
  dependency-injection seam for the new execution deps.
- `shutdown.ts::installShutdownHandlers` + `isShuttingDown()` — refuse new mention work during drain;
  stale-run recovery hook on startup.
- `config.ts` — `workspaceAgentUrl` exists; add `workspaceOpencodeUrl`.

Workspace-agent (extend — `apps/workspace-agent/src/`):
- `server.ts::createApp(deps?)` — Hono app; only `GET /healthz` + `POST /clone` today. Add OpenCode
  server lifecycle at boot.

### Institutional Learnings

- `docs/solutions/best-practices/discord-slash-command-orchestration-patterns-2026-05-27.md` —
  **test the real dispatch path**: handler-only unit tests masked a bootstrap-wiring gap that shipped
  green. Unit 4/5 here must assert the real `messageCreate → execution` wiring, not just the handler.
- `docs/solutions/best-practices/architectural-issues-type-safety-and-resource-cleanup.md` — guaranteed,
  backend-agnostic cleanup; don't assume session ordering. Bears on lock/run-state release in `finally`.
- `docs/solutions/best-practices/signed-webhook-ingress-hardening-2026-05-29.md` — reserve side effects
  before awaiting; fail-closed ordering. Bears on lock-before-execute ordering.

### External References

- **OpenCode SDK v1.14.41 remote attach (confirmed at the SDK level):** `createOpencodeClient({baseURL})`
  exists and defaults to `OPENCODE_BASE_URL` / `http://localhost:54321`. `createOpencode()` is
  convenience glue that spawns a *local* server then points a client at it — not required. The client
  streams events over SSE, so remote attach is supported by the SDK. **Caveat (corrected after source
  audit):** our runtime has **no remote-attach `baseURL` path at all today** — `execution.ts` uses
  `createOpencode({signal})` (local spawn) and `retry.ts` subscribes with no `baseURL`. The plan's
  earlier claim that "only `v2.session.wait()` is proven" was wrong; there is zero remote-attach code in
  the harness. This makes the Unit 0 spike **essential, not confirmatory** — it proves a path that does
  not exist yet.
- **discord.js v14:** `message.startThread({name})` (name 1-100 chars); thread posting needs
  `SEND_MESSAGES_IN_THREADS`. `message.edit()` is internally rate-limit-queued (50 req/s global) but
  caller throttling still advised. 2000-char content limit → `AttachmentBuilder` `.md` fallback.
  `allowedMentions: {parse: []}` strips `@everyone`/role/user pings from agent text.

## Key Technical Decisions

- **Remote attach over HTTP+SSE (Option A).** The workspace container runs the OpenCode SDK server
  bound to the cloned repo root; the gateway attaches via `createOpencodeClient({baseURL})`. Rationale:
  preserves the sandbox boundary (repo + egress filter stay in workspace) while reusing the runtime
  event loop. Rejected Option B (migrate the whole loop into workspace-agent — bigger build, throws
  away reuse) and Option C (OpenCode in the gateway container — voids the sandbox model).
- **Reuse `processEventStream`/`pollForSessionCompletion`, not full `executeOpenCode`.** The full
  `executeOpenCode` is coupled to the GitHub-flavored `buildAgentPrompt`. The gateway builds a fresh,
  minimal Discord prompt (message text + repo context) and drives the SDK session directly, reusing
  only the event-interpretation primitives. Matches the brainstorm's "gateway writes Discord
  equivalents fresh" decision.
- **The workspace OpenCode server is unauthenticated and MUST be sandbox-net-internal only.** Same
  trust model as the internal webhook HTTP: never host-exposed, no untrusted peers on the network. The
  server binds to a network-reachable interface *within* the compose `sandbox-net` and nowhere else.
- **MVP = fresh session per mention, no queue.** A second concurrent mention in the same thread gets a
  "busy — one task at a time" reply (the per-repo lock + a thread-level in-flight guard). Cross-channel
  same-repo contention is handled by the lock (loser posts "waiting for <holder>"). **Both "busy" and
  "waiting" are TERMINAL no-queue rejections** — the mention is dropped, not deferred or retried. The
  user re-sends when ready. "waiting" is status text, not a queued retry.
- **Lock and run-state release in `finally`.** Terminal transition + lock release must be guaranteed
  even on execution throw/timeout, per the resource-cleanup learning.
- **`directory` threaded through every SDK call.** Per the SSE-routing memory, `event.subscribe` and
  `promptAsync` must both carry the workspace repo `directory` or tool events never arrive.
- **All Discord sends go through one helper that hardcodes `allowedMentions: {parse: []}`.** Not just
  the stream sink — every write path (stream text, `.md` fallback, error replies, "busy"/"waiting"
  replies, recovery notes) routes through the same helper so agent or interpolated text can never ping
  `@everyone`/roles/users. Enforcement is a plan invariant, asserted per call site.
- **User-facing messages expose only coarse state.** "busy", "waiting for another task", "workspace not
  reachable", "task failed". Internal identifiers — holder IDs, workspace paths/URLs, lock etags,
  run IDs, raw exception text — are logged internally, never posted to the (public) Discord thread.
- **Global concurrency cap (security requirement, MVP).** The per-repo lock only serializes *within* a
  repo; it does not bound concurrent sessions across *distinct* repos. A gateway-level cap on
  simultaneous active runs (default small, e.g. 3) backstops resource exhaustion from a burst across
  many bound channels. When the cap is hit, new mentions get a terminal "at capacity — try again
  shortly" reply (same no-queue contract).
- **Credential containment (carried from Unit 5).** The workspace holds git credentials via the
  `GIT_ASKPASS` helper (Unit 5: token never in argv/URLs/logs, `execFile` only). The MVP relies on
  that containment and adds no new credential exposure: the gateway never sees the token, and the
  OpenCode server runs with the workspace's existing least-privilege repo-scoped credential. Broadening
  agent write/push capability or cross-repo access is out of scope and must stay technically bounded by
  the workspace clone's credential scope.
- **Trigger authorization gate (locked decision).** A mention only runs OpenCode if the invoking member
  is authorized. MVP gate: the invoking user must hold a configured trigger role
  (`GATEWAY_TRIGGER_ROLE_ID`); if that env is unset, fall back to requiring guild-level
  `ManageChannels` (the same authority `/fro-bot add-project` already enforces). The check uses
  `guild.members.fetch(userId)` then guild-level `member.permissions`/role membership — NOT
  `members.cache.get` (the documented false-negative trap; `fetch` works without the GuildMembers
  privileged intent). Fail-closed: any fetch/permission error → a coarse "not authorized" reply, no
  execution. Unauthorized mentions get a terminal "you're not authorized to run tasks here" reply.
- **Attach-path bearer token (locked decision).** OpenCode's SDK server has no native auth, so the
  workspace fronts it with a thin reverse proxy that requires `Authorization: Bearer <secret>` and
  forwards authorized HTTP+SSE to the loopback-bound OpenCode server. The gateway sends the shared
  secret (`WORKSPACE_OPENCODE_TOKEN`) on every attach call. This adds auth on top of network isolation
  (defense-in-depth) so a compromised `sandbox-net` peer cannot drive workspace execution without the
  secret. Secret compared with `timingSafeEqual`; never logged.

## Open Questions

### Resolved During Planning

- *Where does OpenCode execute?* → Workspace container (Option A), gateway attaches remotely.
- *Reuse `executeOpenCode` or build fresh?* → Reuse event primitives only; fresh Discord orchestrator.
- *How does the gateway reach the server?* → New `WORKSPACE_OPENCODE_URL` config; both containers on
  `sandbox-net`.
- *Queue in MVP?* → No; busy-reply + lock contention only.

### Deferred to Implementation

- Exact OpenCode server bind address/port inside the workspace container (depends on
  `createOpencodeServer` options observed during the Unit 0 spike).
- Whether one long-lived server (attach with per-request `directory`) or per-session servers — Unit 0
  resolves this empirically. The plan assumes one long-lived server with per-request `directory`
  (matches the runtime's existing `directory`-per-call model); Unit 0 confirms or forces the
  per-session fallback.
- Final text-buffering/flush cadence to Discord (boundary on `session.idle` vs incremental) — tuned in
  Unit 3 against observed event timing.

## Output Structure

    packages/gateway/src/execute/
      opencode-attach.ts        # remote-attach client → OpenCodeServerHandle wrapper
      opencode-attach.test.ts
      prompt.ts                 # minimal Discord prompt builder (message text + repo context)
      prompt.test.ts
      run-core.ts               # Unit 2: execute+stream core (attach → session → processEventStream → text)
      run-core.test.ts
      run.ts                    # Unit 4: lifecycle wiring (lock → run-state → heartbeat → run-core → release)
      run.test.ts
    packages/gateway/src/discord/
      streaming.ts              # SDK event stream → Discord thread sink (text + .md fallback)
      streaming.test.ts
      mentions.ts               # MODIFIED: route @fro-bot → execute/run.ts
    apps/workspace-agent/src/
      opencode-server.ts        # OpenCode SDK server lifecycle (boot loopback-bound, hold, expose URL)
      opencode-server.test.ts
      opencode-proxy.ts         # bearer-token reverse proxy → loopback OpenCode server (sandbox-net port)
      opencode-proxy.test.ts
      server.ts                 # MODIFIED: start server + proxy at boot; healthz reflects readiness
      config.ts                 # MODIFIED: read WORKSPACE_OPENCODE_TOKEN secret

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation
> specification. The implementing agent should treat it as context, not code to reproduce.*

```
Discord mention                         Gateway container                         Workspace container
─────────────────                       ─────────────────                         ───────────────────
@fro-bot <msg>  ──messageCreate──▶  handleMention
                                         │
                                         ├─ getBindingByChannelId(channelId) ─▶ (S3) ─▶ {owner, repo}
                                         │     └─ no binding → friendly "not bound" reply, stop
                                         │
                                         ├─ thread in-flight? → "busy" reply, stop
                                         │
                                         └─ runMention(message, binding, deps):
                                              1. startThread({name})              (Discord)
                                              2. acquireLock(repo, 'discord', runId)
                                                   └─ held by other → "waiting for <holder>", stop
                                              3. createRun(PENDING) → transition ACKNOWLEDGED
                                              4. heartbeat.start()
                                              5. transition EXECUTING
                                              6. attach: createOpencodeClient({baseURL: WORKSPACE_OPENCODE_URL})
                                                   wrap as OpenCodeServerHandle (no-op close/shutdown)
                                              7. session.create() ; promptAsync({parts, query:{directory}})  ──HTTP──▶ OpenCode server
                                                   event.subscribe({query:{directory}})                       ◀──SSE──  (bound to /workspace/repos/owner/repo)
                                              8. processEventStream(...) ─▶ DiscordStreamSink
                                                   └─ buffered text ─▶ thread.send / .md attachment if >2000
                                              9. session.idle → transition COMPLETED ; final flush
                                             10. finally: heartbeat.stop() ; releaseLock(etag)
                                                   on throw/timeout → transition FAILED ; error reply
```

Startup recovery (Unit 5): on gateway boot, `findStaleRuns(surface='discord')` → any run left in
EXECUTING by a crash is transitioned FAILED, its lock released, and (best-effort) the thread gets a
"previous task interrupted" note.

## Implementation Units

- [ ] **Unit 0: Spike — prove remote-attach streaming (de-risk the topology)**

**Goal:** Empirically confirm that `createOpencodeClient({baseURL})` against a *remote* OpenCode server
can run the full prompt → SSE stream → `session.idle` flow (not just `v2.session.wait()`), with tool
events arriving when `directory` is threaded through `event.subscribe`. This gates the entire plan.

**Requirements:** R1, R4 (topology viability)

**Dependencies:** None

**Files:**
- Create (throwaway/spike, not shipped): a minimal harness script under `packages/gateway/` that boots
  an OpenCode server in one process (simulating the workspace), attaches from another via `baseURL`,
  sends a trivial prompt against a fixture directory, and logs every event kind received.
- Produce a named go/no-go artifact: `docs/plans/2026-05-30-001-unit-0-spike-findings.md` (a short
  checklist: did text deltas arrive? did a `session.next.tool.*` event arrive? did `session.idle`
  arrive? can the client send a custom `Authorization` header on HTTP AND SSE? — each ✅/❌ with the
  observed event kinds + the header-injection mechanism). This artifact is the green-light contract
  Units 1-5 depend on.

**Approach:**
- Stand up `createOpencodeServer()` (or the workspace-agent's `opencode-server.ts` prototype from
  Unit 1 if built first) bound to a fixture repo dir.
- From a separate client, `createOpencodeClient({baseURL})`, create a session, `promptAsync` with
  `query: {directory}`, `event.subscribe` with `query: {directory}`, and run `processEventStream`.
- **Success criterion:** observe `message.part.delta` / `session.next.text.delta` text AND at least
  one `session.next.tool.*` event AND a terminal `session.idle` over the remote SSE connection.
- **Also confirm (gates the bearer-token proxy):** can the OpenCode SDK client send a custom
  `Authorization: Bearer <secret>` header on BOTH its HTTP calls (`promptAsync`) AND its SSE
  subscription (`event.subscribe`)? If the SDK exposes per-client headers (e.g. a `headers`/`fetch`
  option on `createOpencodeClient`), confirm the proxy auth path is viable. If it does NOT support a
  custom header on the SSE path, escalate — the proxy design may need a query-param token or a
  different attach mechanism. Record the exact header-injection mechanism observed.
- **Fallback trigger:** if remote SSE does not deliver streaming events (only terminal/`wait`), STOP
  and escalate — the plan falls back to Option B (execute-in-workspace), which is a re-plan, not a
  patch. Document the observed behavior either way.

**Execution note:** This is a spike — prove or disprove fast. Do not invest in production structure
until the topology is confirmed. The output is a go/no-go finding, not shippable code.

**Test scenarios:**
- Test expectation: none — spike harness; the "test" is the manual go/no-go observation logged above.

**Verification:**
- A written go/no-go note: remote streaming works (proceed to Unit 1) or does not (escalate, re-plan
  to Option B). Capture the exact event kinds observed.

- [ ] **Unit 1: Workspace-agent — OpenCode SDK server lifecycle**

**Goal:** The workspace container runs an OpenCode SDK server at boot, bound to `/workspace/repos`,
reachable on the internal `sandbox-net`. `GET /healthz` reflects server readiness so the gateway can
gate on it.

**Requirements:** R1, R4, S1-S6

**Dependencies:** Unit 0 (go decision)

**Files:**
- Create: `apps/workspace-agent/src/opencode-server.ts`
- Create: `apps/workspace-agent/src/opencode-server.test.ts`
- Create: `apps/workspace-agent/src/opencode-proxy.ts` (bearer-token reverse proxy fronting the
  loopback-bound OpenCode server; forwards authorized HTTP+SSE)
- Create: `apps/workspace-agent/src/opencode-proxy.test.ts`
- Modify: `apps/workspace-agent/src/server.ts` (start server + proxy at boot; surface readiness in `/healthz`)
- Modify: `apps/workspace-agent/src/config.ts` (read `WORKSPACE_OPENCODE_TOKEN` secret)
- Modify: `deploy/workspace.Dockerfile` + `deploy/compose.yaml` (the proxy port is `sandbox-net`-reachable;
  the raw OpenCode port binds to loopback only — never on `sandbox-net`, never host-published)

**Approach:**
- A `startOpencodeServer({rootDir, signal, logger})` that wraps `createOpencodeServer`, binds to
  **loopback only** within the container, and returns `{url, close}`. The raw server is never directly
  reachable from `sandbox-net`.
- A bearer-token reverse proxy (`opencode-proxy.ts`) binds the `sandbox-net`-reachable port, requires
  `Authorization: Bearer <WORKSPACE_OPENCODE_TOKEN>` (compared with `timingSafeEqual`, never logged),
  and forwards authorized HTTP + SSE to the loopback OpenCode server. Unauthorized → 401, no oracle.
- Boot both from `createApp`/`main` lifecycle; hold handles for shutdown.
- `/healthz` returns `{ok: true, opencode: 'ready'|'starting'|'down'}` so the gateway can poll before
  attaching.
- **Security:** only the PROXY port is on `sandbox-net`; the OpenCode server is loopback-bound. No
  `ports:` host mapping for either. Defense-in-depth: network isolation + bearer token.

**Patterns to follow:**
- `apps/workspace-agent/src/server.ts` Hono app + shutdown wiring.
- `packages/runtime/src/agent/server.ts::bootstrapOpenCodeServer` for `createOpencode`/server shape.

**Test scenarios:**
- Happy path — `startOpencodeServer` resolves with a loopback `url`; `/healthz` reports `ready`.
- Happy path — proxy forwards an authorized request (correct bearer) to the OpenCode server and relays
  the response/SSE stream.
- Edge case — server not yet up → `/healthz` reports `starting`, not `ready`.
- Error path — server spawn fails → `/healthz` reports `down`; clear log; process does not crash-loop.
- Error path — proxy request with missing/wrong bearer → 401, identical body (no oracle), not forwarded.
- Integration — `close()` on shutdown stops both the proxy and the OpenCode server (no leaked handles).

**Verification:**
- Tests pass; manual: container boots, `/healthz` flips to `ready`, the OpenCode port answers from a
  peer container on `sandbox-net` but not from the host.

- [ ] **Unit 2: Gateway remote-attach client + execution orchestrator**

**Goal:** A gateway-side module that attaches to the remote OpenCode server, creates a session, sends
a prompt against the repo `directory`, and drives it to completion using the reused runtime
primitives — returning a stream/result the Discord sink consumes.

**Requirements:** R1, R4

**Dependencies:** Unit 1

**Files:**
- Create: `packages/gateway/src/execute/opencode-attach.ts` (build an `OpenCodeServerHandle` from
  `createOpencodeClient({baseURL})` with no-op `close`/`shutdown`)
- Create: `packages/gateway/src/execute/opencode-attach.test.ts`
- Create: `packages/gateway/src/execute/prompt.ts` (minimal Discord prompt: message text + repo context)
- Create: `packages/gateway/src/execute/prompt.test.ts`
- Create: `packages/gateway/src/execute/run-core.ts` (the execute+stream core: attach → session →
  prompt → `processEventStream` → accumulated text. Unit 4's `run.ts` wraps this with lifecycle.)
- Create: `packages/gateway/src/execute/run-core.test.ts`
- Modify: `packages/gateway/src/config.ts` (NEW fields, following the `workspaceAgentUrl`/`WORKSPACE_AGENT_URL`
  pattern: `workspaceOpencodeUrl` from `WORKSPACE_OPENCODE_URL`; `workspaceOpencodeToken` from the
  `WORKSPACE_OPENCODE_TOKEN` secret via `readSecret`)
- Add: additive export of `processEventStream` (and `pollForSessionCompletion` if not already exported)
  from the runtime agent barrel `packages/runtime/src/agent/index.ts`

**Approach:**
- `attachOpencode(baseURL, token): OpenCodeServerHandle` — wrap the remote client created with the
  bearer token injected as an `Authorization` header (mechanism confirmed in Unit 0) on both HTTP and
  SSE paths; `close`/`shutdown` are no-ops (the gateway does not own the remote server). The
  `ownsServer` guard in the runtime means an injected handle is never closed by the loop. The token is
  never logged.
- `buildDiscordPrompt({messageText, owner, repo})` — minimal text; no harness rules in MVP. Strip/clean
  user text the same way external content is treated as untrusted.
- The orchestrator's execute core: `session.create()` → `promptAsync({parts, query:{directory}})` →
  `event.subscribe({query:{directory}})` → `processEventStream(...)` → completion via
  `pollForSessionCompletion`. Thread `directory` everywhere (SSE-routing constraint).
- Config: `workspaceOpencodeUrl` optional with a sane `sandbox-net` default; validate shape.

**Execution note:** Test-first for the attach handle's no-op ownership contract — a regression that
makes the gateway close the remote server would break every subsequent mention.

**Patterns to follow:**
- `packages/runtime/src/agent/execution.ts` (session create + prompt + retry shape).
- `packages/runtime/src/agent/retry.ts` / `streaming.ts` (event consumption).

**Test scenarios:**
- Happy path — `attachOpencode(url)` yields a handle whose `close`/`shutdown` are no-ops (asserted).
- Happy path — execute core: a fake event stream emitting text deltas + `session.idle` resolves with
  the accumulated text.
- Edge case — `buildDiscordPrompt` with empty/whitespace message → guarded (no empty prompt sent).
- Error path — `promptAsync` returns an LLM fetch error → existing retry/backoff path engages.
- Error path — remote server unreachable (attach/connect fails) → typed error surfaced to the caller
  (Unit 4 maps it to a Discord "workspace not reachable" reply).
- Error path — proxy rejects the bearer token (401) → typed auth error surfaced; Unit 4 maps to a
  coarse "workspace not reachable" reply (no auth detail leaked to Discord).
- Integration — the `Authorization: Bearer` header is present on both the `promptAsync` and
  `event.subscribe` calls (assert the header is threaded; mirrors the `directory` assertion).
- Integration — `directory` is present on both the `promptAsync` and `event.subscribe` calls (assert
  the query param is threaded — guards the SSE-routing regression).

**Verification:**
- Tests pass; the execute core resolves text from a fake remote stream and never closes the injected
  handle.

- [ ] **Unit 3: Discord streaming sink**

**Goal:** Consume the execution event stream and render the agent's text into the Discord thread —
incremental where sensible, with a `.md` attachment fallback for long output and `@everyone` stripped.

**Requirements:** R9

**Dependencies:** Unit 2

**Files:**
- Create: `packages/gateway/src/discord/streaming.ts`
- Create: `packages/gateway/src/discord/streaming.test.ts`

**Approach:**
- A `DiscordStreamSink(thread)` that buffers text from the execute core and flushes to the thread.
  MVP cadence: flush on `session.idle` (final) and optionally on large buffer boundaries; keep it
  simple — correctness over chattiness.
- Long-response fallback: if a flush exceeds 2000 chars, post a short summary line + the full text as a
  `.md` `AttachmentBuilder`. No smart splitting.
- Every send uses `allowedMentions: {parse: []}` so agent-generated `@everyone`/role/user text never
  pings.
- All sends go to the **thread** (`SEND_MESSAGES_IN_THREADS`), never the parent channel.

**Patterns to follow:**
- `packages/gateway/src/discord/presence.ts` (`channel.send({embeds, allowedMentions})` shape).
- `apps/action/src/features/comments/writer.ts` (structure of a posting analog).

**Test scenarios:**
- Happy path — short text (<2000) → single `thread.send` with `allowedMentions:{parse:[]}`.
- Happy path — long text (>2000) → summary message + `.md` attachment (assert no raw 2000+ send).
- Edge case — empty/whitespace final text → a clear "no output" message, not an empty send.
- Error path — `thread.send` rejects → error surfaced/logged; does not crash the run (Unit 4 maps to
  FAILED).
- Error path — agent text contains `@everyone` → `allowedMentions:{parse:[]}` present on the send
  (assert the option; nothing pings).

**Verification:**
- Tests pass; manual: a short prompt renders inline in the thread; a long prompt yields a `.md` file.

- [ ] **Unit 4: Mention → execution wiring + run-state lifecycle + lock**

**Goal:** Replace the `pong` stub. On a real `@fro-bot` mention in a bound channel, run the full
orchestration: resolve binding → thread → lock → run-state lifecycle → execute (Unit 2) → stream
(Unit 3) → guaranteed release.

**Requirements:** R1, R4, R11, S1-S6

**Dependencies:** Unit 2, Unit 3

**Files:**
- Modify: `packages/gateway/src/discord/mentions.ts` (replace stub with `runMention(message, deps)`)
- Create: `packages/gateway/src/execute/run.ts` lifecycle wiring (lock + run-state + heartbeat around
  the Unit 2 `run-core.ts` execute core; `run.ts` owns lifecycle, `run-core.ts` owns execute+stream)
- Modify: `packages/gateway/src/program.ts` (inject execution deps: bindings store, coordination
  config, attach URL, stream sink factory into the `messageCreate` handler)
- Test: `packages/gateway/src/discord/mentions.test.ts` (extend), `packages/gateway/src/execute/run.test.ts` (extend)

**Approach:**
- `runMention` flow (mirrors the High-Level Technical Design):
  1. Skip if already in a thread or bot not actually mentioned (preserve existing guards).
  2. **Trigger authorization gate:** `guild.members.fetch(userId)` then check the configured trigger
     role (`GATEWAY_TRIGGER_ROLE_ID`) or, if unset, guild-level `ManageChannels`. Unauthorized ⇒
     terminal "you're not authorized to run tasks here" reply, stop. Fetch/permission error ⇒
     fail-closed coarse "not authorized" reply. Uses `fetch` not `cache.get` (false-negative trap).
  3. `getBindingByChannelId(channelId)` → no binding ⇒ friendly "this channel isn't bound to a repo"
     reply, stop. Store error/rejection ⇒ safe "try again" reply, no further work (fail-closed).
  4. **Global concurrency cap:** if active runs ≥ cap ⇒ terminal "at capacity — try again shortly"
     reply, stop.
  5. Thread in-flight guard: if a run for this thread is already active ⇒ "busy — one task at a time"
     reply, stop. (MVP's no-queue contract.)
  4. `startThread({name})`.
  6. `startThread({name})`.
  7. `acquireLock(repo, holderId, 'discord', runId)` → held by other ⇒ "waiting for <holder>" reply
     (terminal, no queue), release nothing, stop.
  8. `createRun(PENDING)` → `transitionRun(ACKNOWLEDGED)` → `heartbeat.start()` → `transitionRun(EXECUTING)`.
  9. Execute (Unit 2 `run-core`) + stream (Unit 3).
  10. `session.idle` ⇒ `transitionRun(COMPLETED)`, final flush.
  11. **`finally`:** `heartbeat.stop()` + `releaseLock(etag)` + release the concurrency slot. On
     throw/timeout ⇒ `transitionRun(FAILED)` + coarse "task failed" reply (workspace-unreachable and
     proxy-401 both mapped to "workspace not reachable"; no internal detail leaked).
- Permission re-check before posting (defensive): if the bot lacks thread/send perms, fail clearly.

**Execution note:** Test the **real wiring** (`messageCreate → runMention`), not just `runMention` in
isolation — the orchestration-patterns learning documents a bootstrap-wiring gap that passed
handler-only tests.

**Patterns to follow:**
- `packages/gateway/src/discord/commands/add-project.ts` (multi-phase orchestration with guarded
  early-returns + binding lookup).
- `packages/runtime/src/coordination/` (lock + run-state + heartbeat usage).

**Test scenarios:**
- Happy path — authorized mention in a bound channel → thread created, lock acquired, run-state
  PENDING→ACKNOWLEDGED→EXECUTING→COMPLETED, text streamed, lock + concurrency slot released.
- Error path — unauthorized member (lacks trigger role / ManageChannels) → "not authorized" reply; no
  binding lookup, no thread, no lock, no run-state.
- Error path — `members.fetch` throws → fail-closed "not authorized" reply.
- Edge case — global concurrency cap reached → "at capacity" reply; no new run.
- Edge case — mention in an unbound channel → "not bound" reply; no lock, no run-state, no thread.
- Edge case — second mention in a thread with an active run → "busy" reply; first run unaffected.
- Edge case — already in a thread / bot not mentioned → no-op (existing guards preserved).
- Error path — binding store rejects → safe "try again" reply; no channel/lock side effects (fail-closed).
- Error path — lock held by another surface/channel for the same repo → "waiting for <holder>"; no
  run-state created.
- Error path — execution throws / workspace unreachable → run-state FAILED, "task failed" reply, lock
  released (assert release runs in `finally`).
- Error path — agent text contains `@everyone` → stripped by the sink (cross-checks Unit 3).
- Integration — real `messageCreate` dispatch reaches `runMention` (wiring asserted, not just the
  handler).
- Integration — run-state lifecycle: lock held across EXECUTING, released exactly once on terminal
  state (COMPLETED and FAILED both release).

**Verification:**
- Tests pass; live smoke: `@fro-bot explain <file>` in a bound channel → thread → text response →
  COMPLETED; S3 shows run-state + a released lock.

- [ ] **Unit 5: Startup stale-run recovery + integration + docs**

**Goal:** On gateway boot, recover runs a prior crash left mid-flight; wire the recovery into program
startup; document the MVP behavior and limitations.

**Requirements:** R11

**Dependencies:** Unit 4

**Files:**
- Modify: `packages/gateway/src/program.ts` (call stale-run recovery before/just after login)
- Create: `packages/gateway/src/execute/recovery.ts` (`recoverStaleRuns(deps)` — find EXECUTING runs for
  `surface='discord'`, transition FAILED, release their locks, best-effort thread note)
- Create: `packages/gateway/src/execute/recovery.test.ts`
- Modify: `packages/gateway/AGENTS.md` (document the mention loop + MVP limitations: no queue, no
  approvals, fresh session per mention; the trigger authorization gate; the bearer-token attach path)
- Modify: `deploy/README.md` (the new `WORKSPACE_OPENCODE_URL`/`WORKSPACE_OPENCODE_TOKEN`/
  `GATEWAY_TRIGGER_ROLE_ID`; the loopback-bound OpenCode server + sandbox-net-only proxy port; the
  shared-secret provisioning step)

**Approach:**
- `recoverStaleRuns`: `findStaleRuns(surface='discord')` → for each, `transitionRun(FAILED)` +
  `releaseLock` (best-effort, continue on per-run error so one bad record doesn't abort the sweep) +
  best-effort "previous task interrupted on restart" note to the thread if `thread_id` resolves.
- **Why recovery scans only `EXECUTING`:** `ACKNOWLEDGED` is entered immediately after `createRun`
  succeeds and `EXECUTING` just before the first SDK call — both within the synchronous setup block
  before any interruptible await. Only `EXECUTING` can be stranded by a crash with a held lease + lock,
  so it is the sole recovery target.
- Wire into `makeGatewayProgram` startup. Refuse new mentions while `isShuttingDown()` (drain gate).

**Patterns to follow:**
- `packages/runtime/src/coordination/run-state.ts::findStaleRuns`.
- The `findStaleRuns` continue-on-bad-key resilience from the Unit 2 coordination review.

**Test scenarios:**
- Happy path — one stale EXECUTING run on boot → transitioned FAILED, lock released, thread note posted.
- Edge case — no stale runs → recovery is a clean no-op.
- Edge case — stale run with an unresolvable `thread_id` → still FAILED + lock released; note skipped.
- Error path — one stale run's transition fails → sweep continues for the rest (no abort).
- Integration — boot with a planted EXECUTING run + held lock → after startup, run is FAILED and the
  lock is releasable by a new mention.

**Verification:**
- Tests pass; live smoke: kill the gateway mid-task, restart, confirm the run flips to FAILED and the
  lock frees; AGENTS.md + deploy README reflect the new surface.

## System-Wide Impact

- **Interaction graph:** `messageCreate → handleMention/runMention` is the new hot path. It now touches
  the bindings store (S3), the coordination layer (S3 lock + run-state), the remote OpenCode server
  (HTTP+SSE), and Discord threads. The `program.ts` DI seam gains execution deps.
- **Error propagation:** binding-store rejections fail closed (safe reply, no side effects); lock
  contention is a friendly "waiting"; execution failures become run-state FAILED + a thread reply;
  remote-unreachable is mapped to a clear "workspace not reachable" message.
- **State lifecycle risks:** lock + run-state must release exactly once on every terminal path
  (COMPLETED *and* FAILED) via `finally`. Crash mid-EXECUTING is covered by Unit 5 startup recovery.
  Heartbeat must stop before lock release (renew-then-release ordering already in the controller).
- **API surface parity:** this is the Discord analog of the Action's execute path; it deliberately does
  NOT change the Action. The runtime primitives are imported read-only (no behavior change to
  `packages/runtime/`).
- **Integration coverage:** real `messageCreate` wiring (not handler-only); `directory` threaded
  through both SDK calls; lock-held-across-EXECUTING; cross-channel same-repo contention.
- **Unchanged invariants:** `packages/runtime/src/agent/*` and `coordination/*` are reused without
  modification. `executeOpenCode`/`buildAgentPrompt` (GitHub path) are untouched. The workspace-agent's
  `POST /clone` contract is unchanged; only a new OpenCode-server lifecycle is added alongside it.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Remote SSE streaming doesn't work over `baseURL` (only `wait` proven in our harness) | **Unit 0 spike gates everything.** Go/no-go before any production code. Documented fallback to Option B (execute-in-workspace) as a re-plan, not a patch. |
| Unauthenticated OpenCode server reachable beyond the sandbox | Defense-in-depth: OpenCode server binds loopback-only; a bearer-token reverse proxy (`timingSafeEqual`, 401 no-oracle) is the sole `sandbox-net`-reachable port; never host-published. A compromised peer cannot drive execution without `WORKSPACE_OPENCODE_TOKEN`. |
| Any guild member triggers code execution | Trigger authorization gate: configured trigger role (`GATEWAY_TRIGGER_ROLE_ID`) or fallback guild-level `ManageChannels`; `members.fetch` (not `cache.get`); fail-closed. |
| SSE tool events silently missing (the 1.14.41 `/event` directory-routing regression) | Thread `directory` through both `event.subscribe` and `promptAsync`; Unit 2 integration test asserts the query param is present on both. |
| Lock/run-state leak on crash or throw | Release in `finally`; Unit 5 startup `recoverStaleRuns` sweep; continue-on-error so one bad record doesn't strand the rest. |
| Concurrent mentions race the lock/run-state | Per-repo lock + per-thread in-flight guard; MVP "busy" reply instead of a queue. |
| discord.js edit/post rate limits | MVP flushes on completion (not a chatty heartbeat); library queues internally; thread-only sends. |
| Agent text pings `@everyone` | Single send helper hardcodes `allowedMentions:{parse:[]}`; asserted at every call site (Unit 3 + Unit 4 + recovery). |
| Burst across many distinct repos exhausts workspace capacity (per-repo lock doesn't bound distinct repos) | Gateway-level global concurrency cap (default ~3); over-cap mentions get a terminal "at capacity" reply. |
| Internal infra detail (paths, holder IDs, etags, stack traces) leaks into public Discord threads | Coarse-state user messages only; internal identifiers logged internally, never posted. |
| Agent abuses workspace git credentials (push, exfil, cross-repo) | Relies on Unit 5 `GIT_ASKPASS` containment + least-privilege repo-scoped credential; no new exposure; broadening capability is out of scope. |

## Documentation / Operational Notes

- New config (gateway): `WORKSPACE_OPENCODE_URL` (internal `sandbox-net` URL of the workspace OpenCode
  PROXY), `WORKSPACE_OPENCODE_TOKEN` (shared bearer secret), `GATEWAY_TRIGGER_ROLE_ID` (optional trigger
  role; unset → ManageChannels fallback), and the global concurrency cap (env or constant).
- New config (workspace-agent): `WORKSPACE_OPENCODE_TOKEN` (same shared secret the proxy validates).
- Both `WORKSPACE_OPENCODE_TOKEN` values are operator-provisioned secrets (Docker secret / `_FILE`
  convention, matching the existing optional-secret pattern in `deploy/compose.yaml`).
- `packages/gateway/AGENTS.md`: document the mention loop and MVP limitations (no queue/approvals/UX,
  fresh session per mention, sandbox-internal server).
- `deploy/README.md` + `deploy/compose.yaml`: the workspace OpenCode port is `sandbox-net`-internal.
- KNOWN-LIMITS (origin spec): incoming attachments ignored; no smart message splitting (file fallback).

## Sources & References

- **Origin document:** [docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md](./2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md) (Unit 6, lines 745-817)
- Brainstorm: [docs/brainstorms/2026-04-17-fro-bot-gateway-discord-requirements.md](../brainstorms/2026-04-17-fro-bot-gateway-discord-requirements.md) (Cluster B extraction, Cluster C sandbox)
- Reuse: `packages/runtime/src/agent/{execution,retry,streaming,session-poll,server}.ts`, `packages/runtime/src/coordination/{lock,run-state,heartbeat}.ts`
- Extend: `packages/gateway/src/discord/mentions.ts`, `packages/gateway/src/bindings/store.ts`, `packages/gateway/src/program.ts`, `apps/workspace-agent/src/server.ts`
- Learnings: `docs/solutions/best-practices/discord-slash-command-orchestration-patterns-2026-05-27.md`, `docs/solutions/best-practices/architectural-issues-type-safety-and-resource-cleanup.md`
