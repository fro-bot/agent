---
title: "feat: Mention-loop operator commands — /fro-bot force-release-lock + run reactions"
type: feat
status: completed
date: 2026-06-09
deepened: 2026-06-09
completed: 2026-06-09
origin: docs/brainstorms/2026-06-07-mention-loop-production-ready-requirements.md
---

# Mention-loop operator commands — `/fro-bot force-release-lock` + run reactions

## Overview

This plan delivers the buildable-now slice of the mention loop's remaining command/UX surface (the reconciled "Phase 4"): an operator command to clear a stuck per-repo coordination lock (`/fro-bot force-release-lock`) and a lightweight reaction-based progress affordance on mention runs (R9). Both build on seams that already exist on `main` — the S3 coordination lock primitives and the existing run lifecycle — and follow the established `/fro-bot` subcommand conventions shipped with `/fro-bot clear-queue`.

The other items the brainstorm grouped under Phase 4 are deliberately deferred (see Scope Boundaries): `/fro-bot sessions` and `/fro-bot resume` are blocked on a session-registry persistence layer that does not yet exist, and `/fro-bot review` is its own capability (PR checkout + execution routing + verdict→event contract).

## Problem Frame

Two operational gaps remain in the mention loop now that execution, streaming, approvals, working-state UX, and the serial queue have shipped:

1. **A stuck per-repo lock has no recovery affordance.** The mention loop acquires a per-repo S3 coordination lock; if a run dies in a way that startup stale-run recovery doesn't promptly clear (or an operator needs to intervene), there is no Discord-facing way to release it. The repo stays blocked.
2. **A running mention gives weak at-a-glance status.** The working-state status message + typing indicator shipped in Phase 2, but there's no terminal at-a-glance signal (success/failure/awaiting-approval) on the triggering message itself — the kind of glanceable cue the GitHub Action conveys with reactions.

Both are bounded, follow existing patterns, and need no new durable state — making them the right first cut.

## Requirements Trace

- R1. An authorized operator can clear a stuck per-repo coordination lock for the current channel's bound repo via `/fro-bot force-release-lock`. (origin: Phase 4 "force-release-lock")
- R2. Force-release is **dead-run-verified**, not blind: it only releases a lock whose owning run is demonstrably dead — the lock lease has expired AND the run-state record for the lock's `run_id` shows a stale/absent heartbeat — and it never deletes a lock whose run-state shows a live heartbeat, nor a lock object that changed since it was read. (safety; origin: lock-ownership P0 in `gateway-opencode-mention-loop-best-practices`)
- R3. `force-release-lock` uses the same authorization gate, interaction-deadline handling, and fail-closed posture as the other `/fro-bot` subcommands. (origin: Phase 4 "consistent command conventions")
- R4. A mention run surfaces a glanceable reaction on the triggering message reflecting run state (working / succeeded / failed / awaiting-approval), as a secondary affordance that never affects execution if it fails. (origin: Phase 4 "reactions / R9")

## Scope Boundaries

- Not changing the lock acquisition / normal-release paths, the heartbeat lease, run-state writes, or the coordination schema. Force-release reads existing lock + run-state records and conditionally deletes the lock; it adds no fields to either record.
- Not adding a blunt operator override that force-deletes a lock regardless of run liveness — explicitly rejected for the `run_id`/heartbeat-ownership safety reasons in R2.
- Not force-releasing a lock whose run-state heartbeat is live, even if the operator asks and even if the lock lease has lapsed — the command refuses and reports the live holder. (A genuinely wedged-but-heartbeating run is out of scope for v1; surface it, don't kill it.)
- Not changing the working-state status controller or typing indicator (Phase 2, shipped). Reactions are additive to it.

### Deferred to Separate Tasks

- `/fro-bot sessions` and `/fro-bot resume`: blocked on a durable session-registry layer (gateway creates OpenCode session IDs in run-core but never persists them). Defer to a dedicated "session registry" brainstorm + plan. Note: the GitHub Action tier already has session listing/continuation machinery (`packages/runtime/src/session/storage.ts`, `continueSessionId` execution path) worth evaluating for extraction during that brainstorm.
- `/fro-bot review`: own capability — PR listing, PR-branch checkout via the workspace API, execution routing against a PR checkout, and the verdict→GitHub-review-event contract (see `comment-only-review-blocked-approval` learning). Separate plan.
- `/fro-bot approvals` command: the native approval flow (S5) already ships button-driven approvals inline; a standalone command is not needed for this cut.

## Context & Research

### Relevant Code and Patterns

- **Subcommand recipe** — `packages/gateway/src/discord/commands/fro-bot.ts`: parent `createFroBotCommand(deps)` builds `SlashCommandBuilder` with `.addSubcommand(...)` and dispatches on `interaction.options.getSubcommand(true)`. `executeClearQueue` (the freshest reference, #850) is the canonical handler shape: synchronous null-guild guard → `deferReply({ephemeral:true})` → `userIsAuthorized(...)` fail-closed → business logic → `editReply`. `FroBotDeps extends AddProjectDeps` with `queue`, `triggerRoleId`, `gatewayLogger`.
- **Registration + dep threading** — `packages/gateway/src/discord/commands/index.ts` (`getCommandRegistry(deps)` → `createFroBotCommand(deps)`); `packages/gateway/src/program.ts` builds `commandDeps` (~171-183) and passes them in.
- **Authorization** — `userIsAuthorized(guild, userId, triggerRoleId, logger)` in `packages/gateway/src/discord/mentions.ts` (REST `guild.members.fetch`, trigger-role-or-ManageChannels, fail-closed).
- **Lock primitives** — `packages/runtime/src/coordination/lock.ts`: `forceReleaseLock(config, repo, etag, logger)` (conditional delete with `IfMatch: etag`); the lock record (`{repo, holder_id, surface, acquired_at, ttl_seconds, run_id}`) lives at `{prefix}/{identity}/{owner}/{repo}/locks/repo.json` and carries NO heartbeat — only a lease (`acquired_at + ttl_seconds`); `acquireLock`'s `isStale(lockRecord, now)` is the lease-expiry check to reuse. `packages/runtime/src/coordination/run-state.ts`: the run-state record (keyed by `run_id`) carries `last_heartbeat`; `findStaleRuns` + `config.staleThresholdMs` are the heartbeat-staleness logic to reuse.
- **Coordination config + repo identity** — `makeCoordinationConfig(s3Adapter, config)` in `program.ts`; channel→repo via `bindingsStore.getBindingByChannelId(channelId)`.
- **Run lifecycle (reaction hook points)** — `packages/gateway/src/execute/run.ts` (`startRun` lifecycle: thread creation, approval-wait, terminal success/failure in the inner finally) and `run-core.ts` (session/idle/error events). The triggering `Message` is available in `runMention`/`startRun`.
- **Action-tier reaction reference** — `src/features/agent/reactions.ts`: emoji-per-state pattern to mirror conceptually (not import — different tier/model).

### Institutional Learnings

- `discord-slash-command-orchestration-patterns-2026-05-27.md`: use `interaction.appPermissions` / `userIsAuthorized` (never `members.cache.get()`); `deferReply` before any REST; test via the real `getCommandRegistry`+`dispatchCommand` dispatch path, not by calling handlers directly.
- `gateway-opencode-mention-loop-best-practices-2026-05-30.md`: **lock release must be gated on `run_id`/ownership** — a stale run whose lease expired may have had its lock re-acquired by a newer live run; releasing blindly deletes the newer run's lock and permits concurrent execution (the P0 this plan's R2 guards against).
- `atomic-serial-channel-queue-handoff-2026-06-09.md`: `deferReply`-before-REST and fail-closed auth are non-negotiable for every interaction.
- Project anti-pattern (AGENTS.md): reactions are a secondary affordance — API failures must never halt execution.

## Key Technical Decisions

- **Two-signal, dead-run-verified force-release (R2) — the lock record has no heartbeat.** The `LockRecord` is `{repo, holder_id, surface, acquired_at, ttl_seconds, run_id}`; its only staleness signal is **lease expiry** (`acquired_at + ttl_seconds`, via the existing `isStale(lockRecord, now)` that `acquireLock` uses). The live **heartbeat** lives in the separate **run-state** record (`last_heartbeat`), keyed by `run_id`. So force-release must check BOTH: (1) the lock lease is expired (`isStale` on the lock record), AND (2) the run-state for the lock's `run_id` is absent OR its heartbeat is past the run-state stale threshold (`config.staleThresholdMs`, as used by `findStaleRuns`). Release only when both hold; if run-state shows a live heartbeat, refuse and report the holder. This is the "proven dead" bar and resolves the lock-ownership P0 — a live run (including a newer run that re-acquired after the original went stale) is never killed. Lock lease-staleness and run heartbeat-staleness are two distinct thresholds; do not conflate them.
- **`IfMatch: etag` conditional delete guards the read→delete race (backstop, not the proof).** The lock etag is captured on read; the delete reuses the existing `IfMatch: etag` conditional delete (the object-store adapter supports conditional delete). If the lock object changed between read and delete (re-acquire/renewal rewriting the lock object), the delete fails and the command reports a transient conflict instead of deleting the new holder's lock. **Stated assumption:** re-acquire/renewal rewrites the same lock S3 object (changing its etag). The etag guard is a *backstop*; the two-signal run-state check is the primary safety proof — neither alone is treated as sufficient.
- **Compose the safety logic as a single runtime primitive (resolves the Unit 1 design fork).** Add `forceReleaseStaleLock(config, repo, logger)` to `packages/runtime/src/coordination/lock.ts` that internally reads the lock record (+etag), reads the run-state for its `run_id`, applies the two-signal check, performs the `IfMatch` delete, and returns a typed outcome (`released | live-holder | no-lock | conflict | error`, including the holder/run-age info for disclosure). The gateway command is a thin caller — the cross-cutting lock+run-state safety logic lives in the runtime layer where it is unit-testable and reusable. (Add an internal lock-record read returning `{record, etag}` if none exists today.)
- **Raised authorization for a destructive cross-run action (R3, hardened).** Lock deletion is a higher-risk class than queue clearing — it can reopen concurrent execution and can target another user's run — so it requires the stronger authority arm: guild-level `ManageChannels`, NOT merely a configured trigger role. (Do not pass a trigger-role-satisfies gate here; require the `ManageChannels` capability even when a trigger role is configured.) The ephemeral reply always discloses the current holder and run age at the point of action so the operator sees exactly what is being cleared.
- **Reaction failure-isolation with an explicit catch boundary.** A new `packages/gateway/src/discord/reactions.ts` exposes a tiny surface (set/replace a state reaction on a `Message`). Every Discord reaction call is caught **inside the helper** (each add/remove in its own try/catch or `.catch(logged)`), so the helper's public methods never reject. The `run.ts` hook sites call these already-safe methods and never `await` them in a shared failure path — a reaction failure can never become an unhandled rejection or alter run outcome.
- **No new persistence.** Both features read existing state (lock record; live `Message`); neither introduces a durable store.

## Open Questions

### Resolved During Planning

- Which commands are in scope: `/force-release-lock` + reactions only; `/sessions`/`/resume`/`/review` deferred (user-confirmed).
- Force-release safety posture: dead-run-verified via two signals (lock lease expired AND run-state heartbeat stale/absent), refuse on any live heartbeat (user-confirmed; hardened in review — the lock record carries no heartbeat, so run-state must be cross-referenced).
- Unit 1 composition fork: a single runtime primitive `forceReleaseStaleLock` owns the lock+run-state safety logic; the gateway command is a thin caller (resolved — was a two-arm open choice).
- Authorization bar: `ManageChannels` required (not trigger-role) because lock deletion is a destructive cross-run action (hardened in review).

### Deferred to Implementation

- Exact name/shape of the internal lock-record read returning `{record, etag}` — confirm against `packages/runtime/src/coordination/lock.ts`; add if absent (it appears absent today).
- The exact `ManageChannels`-only authorization mechanic (reuse `userIsAuthorized` with `triggerRoleId: null` vs a dedicated check) — confirm against the helper at implementation.
- Exact emoji chosen per state and whether "awaiting-approval" gets its own reaction or reuses the working state — pick during implementation to match the existing status-controller vocabulary; keep to standard unicode.
- Whether reactions attach to the triggering user message, the bot's thread root, or both — decide from the real `startRun` message/thread handles; default to the triggering message for the terminal cue.

## Implementation Units

- [x] **Unit 1: `forceReleaseStaleLock` runtime primitive (lock + run-state two-signal check)**

**Goal:** Provide a safe, reusable coordination operation that releases a per-repo lock ONLY when its owning run is proven dead — lock lease expired AND run-state heartbeat stale/absent — using an `IfMatch` conditional delete as a race backstop. Closes the etag gap and the live-run deletion P0 in the runtime layer.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `packages/runtime/src/coordination/lock.ts` (add `forceReleaseStaleLock(config, repo, logger)` returning a typed outcome; add an internal lock-record read returning `{record, etag}` if none exists — `acquireLock` only returns `holder` with a null etag on the stale-conflict path, so a dedicated read is expected)
- Reference (read, do not modify here): `packages/runtime/src/coordination/run-state.ts` for the run-state record shape, `last_heartbeat`, `config.staleThresholdMs`, and `findStaleRuns` heartbeat logic
- Test: `packages/runtime/src/coordination/lock.test.ts`

**Approach:**
- Read the current lock record + etag. If absent → outcome `no-lock`.
- Signal 1 (lease): apply the existing `isStale(lockRecord, now)` (lease = `acquired_at + ttl_seconds`). If the lease is NOT expired → outcome `live-holder` (do not delete).
- Signal 2 (heartbeat): read the run-state record for `lockRecord.run_id`. If run-state is present AND its `last_heartbeat` is within `config.staleThresholdMs` → outcome `live-holder` (do not delete). If run-state is absent OR its heartbeat is past the threshold → the run is dead.
- Only when BOTH signals say dead: perform the `IfMatch: etag` conditional delete. Success → `released`. Precondition failure (lock object changed since read) → `conflict` (never a blind delete).
- Return a typed outcome carrying holder id + run age for the caller's disclosure. Keep the runtime layer free of Discord concerns; use Result/typed-outcome style consistent with the existing coordination API.
- Use the two distinct thresholds correctly: lock lease vs run-state `staleThresholdMs`. Do not introduce a third definition.

**Patterns to follow:** `acquireLock`'s `isStale` lock check + Result style in `lock.ts`; `findStaleRuns` heartbeat-threshold usage in `run-state.ts`; the existing `forceReleaseLock`'s `IfMatch: etag` conditional-delete call.

**Test scenarios:**
- Happy path: lease expired AND run-state heartbeat stale → conditional delete succeeds → `released`.
- Happy path: lease expired AND run-state record absent → treated as dead → `released`.
- Error/refuse path: lease expired BUT run-state heartbeat is fresh (run still alive, lease just lapsed) → `live-holder`, NO delete attempted. (This is the core P0 guard — assert no delete call is made.)
- Error/refuse path: lease NOT expired → `live-holder`, no run-state read needed / no delete.
- Edge: no lock record → `no-lock`, no error.
- Edge/race: both signals dead, but the lock object changed between read and delete (simulate `IfMatch` precondition failure) → `conflict`, no deletion of the new holder's lock.
- Edge: malformed/partial lock or run-state record → fail closed (no delete), surfaced as `error`.

**Verification:** Runtime coordination tests cover release-when-dead (both heartbeat-stale and run-state-absent), refusal-when-lease-live, refusal-when-heartbeat-live, absent lock, the `IfMatch` precondition-failure race, and malformed records; acquire/normal-release behavior is unchanged.

- [x] **Unit 2: `/fro-bot force-release-lock` subcommand**

**Goal:** Expose the dead-run-verified force-release to operators via a `/fro-bot` subcommand for the current channel's bound repo, with the raised (`ManageChannels`) auth bar and the standard interaction posture.

**Requirements:** R1, R2, R3

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/gateway/src/discord/commands/fro-bot.ts` (builder `.addSubcommand`, dispatch branch, `executeForceReleaseLock` handler; extend `FroBotDeps` with the s3 adapter / coordination-config inputs — `bindingsStore` is already present via `AddProjectDeps`)
- Modify: `packages/gateway/src/program.ts` (thread the s3 adapter / coordination-config input into `commandDeps` — the adapter is already created there via `createS3Adapter`; this IS a required change, not optional)
- Test: `packages/gateway/src/discord/commands/fro-bot.test.ts`

**Approach:**
- Handler shape mirrors `executeClearQueue`: synchronous null-guild guard → `deferReply({ephemeral:true})` → authorization → resolve repo from `bindingsStore.getBindingByChannelId(channelId)` (no binding → ephemeral "no repo bound here") → build `CoordinationConfig` via `makeCoordinationConfig` → call Unit 1's `forceReleaseStaleLock` → `editReply` mapping the typed outcome.
- **Authorization is the raised bar (not the trigger-role gate):** require guild-level `ManageChannels`. Reuse the resolution mechanics of `userIsAuthorized` (REST `guild.members.fetch`, fail-closed) but DO NOT accept a configured trigger role as sufficient — this command needs the ManageChannels capability specifically. (Implementation may pass `triggerRoleId: null` into a `userIsAuthorized`-style check to force the ManageChannels arm, or use a dedicated `ManageChannels`-only check — confirm against the helper at implementation; either way the trigger-role-only user must be denied.)
- **Outcome → reply mapping:** `released` → ephemeral confirmation incl. the cleared holder/run age; `live-holder` → ephemeral refusal disclosing the holder id + run age ("held by an active run…"); `no-lock` → ephemeral "nothing to release"; `conflict` → ephemeral "the lock changed just now, try again"; `error` → ephemeral internal-error.
- New dep threading: extend `FroBotDeps` and `commandDeps` in `program.ts` with what force-release needs (the s3 adapter / coordination config inputs for `makeCoordinationConfig`); `bindingsStore` is already present via `AddProjectDeps`.
- All Discord sends ephemeral; `allowedMentions: {parse: []}` where applicable.

**Patterns to follow:** `executeClearQueue` end-to-end (guard/defer/auth/business/editReply); `userIsAuthorized` resolution mechanics in `mentions.ts`; `makeCoordinationConfig` usage in `program.ts`.

**Test scenarios:**
- Happy path: ManageChannels user, repo bound, dead run (lease + heartbeat stale) → release succeeds → ephemeral "released" reply with holder info; verify `deferReply` precedes the auth REST call.
- Error path: trigger-role-only user (no ManageChannels) → DENIED, no release attempted → ephemeral denial. (Asserts the raised bar vs clear-queue.)
- Error path: unauthorized user (neither) → denied, no release.
- Edge: null guild → plain ephemeral "must be used in a server", no defer/auth.
- Edge: no binding for the channel → ephemeral "no repo bound", no release attempted.
- Refuse path: live holder (Unit 1 returns `live-holder`) → ephemeral "held by an active run" with holder id + run age, no deletion.
- Edge: `conflict` and `no-lock` outcomes → mapped to their distinct ephemeral replies.
- Integration: invoked through the real `getCommandRegistry` + `dispatchCommand` path (not by calling the handler directly), asserting the dispatch wiring resolves `force-release-lock`.

**Verification:** The subcommand registers and dispatches; a ManageChannels user can clear a proven-dead lock end-to-end; a trigger-role-only user is denied; null-guild/no-binding/live-holder/conflict/no-lock all produce clear distinct ephemeral replies; dispatch-path integration test passes.

- [x] **Unit 3: Run-state reactions (R9)**

**Goal:** Add a glanceable reaction on the triggering message reflecting mention-run state, as a best-effort secondary affordance that never affects execution.

**Requirements:** R4

**Dependencies:** None (independent of Units 1-2)

**Files:**
- Create: `packages/gateway/src/discord/reactions.ts` (small surface: set a state reaction, clear/replace prior state reaction on a `Message`; every Discord call best-effort)
- Modify: `packages/gateway/src/execute/run.ts` (wire reaction transitions at run start → working, terminal → success/failure, and approval-wait → awaiting, at the existing lifecycle points)
- Test: `packages/gateway/src/discord/reactions.test.ts`; reaction-wiring assertions in `packages/gateway/src/execute/run.test.ts`

**Approach:**
- Standard unicode emoji per state (no custom emoji / `ManageMessages` dependency). Map: working, succeeded, failed, awaiting-approval.
- **Catch boundary inside the helper:** every reaction add/remove is wrapped in its own try/catch (or `.catch(logged)`) so the helper's exported methods resolve to void and NEVER reject. The `run.ts` hook sites call these already-safe methods; they are not awaited in any shared try/finally that gates run outcome, so a reaction failure cannot surface as an unhandled rejection or alter the run result.
- Wire at the existing `startRun` lifecycle transitions; do not restructure the run flow. Reactions complement (do not replace) the Phase 2 status controller.

**Patterns to follow:** `src/features/agent/reactions.ts` (emoji-per-state concept); the best-effort `.catch`-logged Discord-send style already used by the status controller / `safeReply`.

**Test scenarios:**
- Happy path: run start sets the working reaction; terminal success replaces it with the succeeded reaction; terminal failure sets the failed reaction.
- Edge: approval-wait sets the awaiting reaction, then resolves to succeeded/failed on completion.
- Error path: a Discord reaction API call rejects → the helper catches/logs it and resolves to void; assert the helper method does NOT reject and the run completes with an unchanged result.
- Error path (containment): a reaction failure during a run does not propagate to the run's success/failure classification (assert via the run-wiring test that a thrown reaction mock leaves the run outcome identical to the no-reaction baseline).
- Edge: prior state reaction is cleared/replaced so the message doesn't accumulate stale state cues (or document the additive choice and assert it).

**Verification:** Reactions appear for each run-state transition; a forced reaction-API failure resolves inside the helper (no rejection) and does not affect run success/failure or output; reaction component unit tests + run-wiring containment tests pass.

## System-Wide Impact

- **Interaction graph:** Unit 2 adds a dispatch branch under the existing `/fro-bot` parent (no new top-level command); Unit 3 hooks the existing `startRun` lifecycle (no flow restructure).
- **Error propagation:** Unit 1 returns Result types (no throw across the coordination boundary); Unit 2 surfaces outcomes as ephemeral replies; Unit 3 swallows reaction failures by design.
- **State lifecycle risks:** Force-release deletes a lock record — the two-signal (lease + run-state heartbeat) dead-run verification plus the `IfMatch` race backstop ensures a live run's lock is never deleted. No partial-write risk (single conditional delete on the lock object; run-state is read-only here).
- **API surface parity:** Force-release shares the interaction posture of `clear-queue`/`add-project` (defer-first, ephemeral, fail-closed) but RAISES the auth bar to `ManageChannels`; reactions share the best-effort Discord-send posture of the status controller.
- **Unchanged invariants:** Lock acquisition, normal release, the heartbeat lease, run-state writes, the coordination schema, the serial queue, and the Phase 2 status controller are all unchanged. Force-release is a read(lock+run-state)-then-conditional-delete(lock) on existing state; reactions are additive.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Force-release deletes a live run's lock (P0 — incl. a newer run that re-acquired after the original went stale) | Two-signal check: release only when the lock lease is expired AND the run-state heartbeat for the lock's `run_id` is stale/absent; refuse on any live heartbeat. `IfMatch: etag` conditional delete is the race backstop (concurrent re-acquire → precondition failure, not blind delete). (Unit 1, R2) |
| A slow-but-alive long run crosses the lease threshold and looks killable | The lease-expiry signal alone never authorizes deletion — the run-state heartbeat must ALSO be stale. A legitimately-running agent keeps heartbeating, so it is refused with holder/run-age disclosure. |
| Over-broad authority for a destructive action | Auth bar raised to guild `ManageChannels` (not trigger-role); a trigger-role-only user is denied. Reply discloses the holder before action. |
| Reaction API failures interfering with runs | Catch boundary inside the reaction helper (methods never reject) + hook sites never await reactions in a run-gating path; tested that a thrown reaction mock leaves the run outcome identical to baseline. |
| The lock record carries no heartbeat (original etag-only plan was unsafe) | Resolved by cross-referencing run-state for the heartbeat signal; the etag is read with the lock record for the `IfMatch` backstop, no schema change. |
| Object-store adapter must support conditional (`IfMatch`) delete | Confirmed present (the existing `forceReleaseLock` already uses it); Unit 1 reuses that path. |

## Sources & References

- **Origin document:** `docs/brainstorms/2026-06-07-mention-loop-production-ready-requirements.md` (Phase 4)
- Related code: `packages/gateway/src/discord/commands/fro-bot.ts`, `packages/runtime/src/coordination/lock.ts`, `packages/runtime/src/coordination/run-state.ts`, `packages/gateway/src/execute/run.ts`, `packages/gateway/src/discord/mentions.ts`, `src/features/agent/reactions.ts`
- Related learnings: `docs/solutions/best-practices/discord-slash-command-orchestration-patterns-2026-05-27.md`, `gateway-opencode-mention-loop-best-practices-2026-05-30.md`, `atomic-serial-channel-queue-handoff-2026-06-09.md`
- Related plans: `docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md` (Unit 6 reconciliation)
