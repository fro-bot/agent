---
title: "feat: Gateway Discord tool-approval (S5) — probe-first"
type: feat
status: active
date: 2026-06-01
origin: docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md
---

# feat: Gateway Discord tool-approval (S5) — probe-first

## Overview

The gateway mention loop (Unit 6 MVP, PR #705) runs OpenCode against a bound repo in the workspace container and streams output to Discord. Today it has **no approval gate**: any tool the agent decides to run executes unattended. This plan adds the deferred **S5** capability — surfacing OpenCode tool-permission requests as Discord approval embeds with approve/deny buttons, and replying to OpenCode over its HTTP permission endpoint.

**SSE delivery of `permission.asked` is verified reliable at 1.14.41.** Oracle/Librarian review (session 2026-06-01) confirmed that `permission.asked` is a BusEvent published to `bus.subscribeAll()` → `/event` SSE, and that the 1.14.42+ regression only affected SyncEvents — not bus events. The plan remains **probe-first**, but the probe now **confirms** a known-working round-trip rather than gating on a feared unknown. The risk has shifted from "will the signal arrive?" to lifecycle coordination: SSE drops while a permission is pending, reject cascades, shutdown draining, and sub-deadline discipline.

## Problem Frame

Sensitive actions (file writes, bash, PR creation) currently run with no human gate on the Discord surface — the GitHub Action tier never needed one (its operations are PR-scoped and reviewable), but the gateway drives a live agent in a shared channel. S5 from the Gateway v1 brainstorm requires "sensitive-action approvals." The original Unit 6 plan sketched the design (opaque-token `custom_id`, S3 payload, restart durability) but deferred implementation. The spike confirmed it is buildable on the current remote-attach topology; this plan turns that into executable units — without the S3 token store, which is unnecessary (see Key Technical Decisions).

## Requirements Trace

- R-S5. Sensitive tool/permission requests from OpenCode surface in Discord as an approval prompt; the agent run blocks until approved or denied.
- R-S5.1. Approve/deny is authorized (only trigger-role / `ManageChannels` users, mirroring mention authorization).
- R-S5.2. Approval state is held in the in-memory registry for the lifetime of the run. There is **no cross-restart durability**: the blocked run is NOT resumed after gateway restart in v1; pending registry entries are abandoned on restart and surface as a clear "run interrupted, please re-mention" failure.
- R-S5.3. A response (`"once"` / `"reject"`) is delivered to OpenCode over the HTTP permission reply endpoint so the run resumes or aborts the tool.
- R-S5.4. Approval activity is observable (who approved/denied, which tool) without logging secrets or request/response bodies.

## Scope Boundaries

- Not building reactions (👀/🎉/😕), the working-message progress editor, the serial per-channel queue, or the `/review`/`/sessions`/`/resume` commands — those are separate deferred Unit 6 items.
- Not changing the GitHub Action tier's tool handling — Action stays as-is.
- Not building the `/fro-bot approvals` management command in this plan (deferred to a follow-up); the approval flow itself is the deliverable.

### Deferred to Separate Tasks

- Reactions + progress editor (R9): separate plan.
- Serial queue + `/clear-queue` (R11): separate plan.
- `/review`, `/sessions`, `/resume` commands: separate plan.
- Gateway startup self-test wiring (#7) and stand-alone safety-wins: can ship independently; not blocked by S5.
- `no-fro-bot` block role (R6): dropped (won't-do) — redundant deny-list on top of the existing allow-list auth model; exclude a user by not granting the trigger role.
- `/fro-bot approvals` list/revoke management command: follow-up plan after S5 core lands.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/execute/run-core.ts:155-310` — the OpenCode event loop. Consumes **v2 sync events** (`session.next.text.delta`, `session.next.tool.called`, `session.next.tool.success`, `session.idle`, `session.error`). This is where `permission.asked` and `permission.replied` branches attach. No permission handling exists today.
- `packages/gateway/src/execute/run.ts:73-243` — orchestration wrapper (concurrency gate, thread creation, sink flush). The run currently runs to `session.idle` uninterrupted; approval introduces a mid-run blocking wait on the coordinator promise.
- `packages/gateway/src/discord/mentions.ts:69-156` — `userIsAuthorized()` (trigger-role / `ManageChannels`) and run handoff. The approve/deny authorization reuses this.
- `packages/gateway/src/discord/streaming.ts:117-166` — buffered Discord sink; approval embed posting is adjacent but separate (component message, not the text sink).
- `packages/gateway/src/discord/commands/fro-bot.ts:28-60` + `commands/index.ts:14-106` — slash-command registry + dispatch; the deferred `/fro-bot approvals` extends this.
- `packages/gateway/src/program.ts:89-264` — boot/event-handler wiring; the Discord `interactionCreate` button handler registers here and must reach the in-memory coordinator registry.

### Institutional Learnings

- `docs/solutions/best-practices/discord-slash-command-orchestration-patterns-2026-05-27.md` — `interaction.appPermissions` traps, live cache re-reads, multi-phase partial-failure recovery. Directly applicable to button-interaction handling.
- `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md` — remote-attach, EOF/timeout handling, failure-path flush. The approval wait must respect the same dual-finally / flush discipline.
- `docs/solutions/best-practices/webhook-ingress-security-patterns-2026-05-30.md` — constant-time, never log bodies. The single-winner settle guard mirrors the replay-cache reserve pattern; atomic in-memory state transition before awaiting reply POST is mandatory.

### External References

- Spike findings (memory 4365): `@opencode-ai/sdk@1.14.41` — permission events on `/event` SSE bus; v2 `POST /permission/{requestID}/reply` with body `{ reply: "once" | "always" | "reject", message?: string }` and optional `query: { directory?, workspace? }`.
- Oracle/Librarian review (memory 4366, session 2026-06-01): `permission.asked` is a BusEvent (not a SyncEvent) — SSE delivery at 1.14.41 is verified reliable; `requestID` = `properties.id` (confirmed); `permission.replied` is a real non-sync event `{ sessionID, requestID, reply }` and is the authoritative settlement signal; reject cascade confirmed (one reject → all same-session pending rejected server-side); `GET /permission` lists pending requests (reconciliation fallback when SSE drops); no server-side timeout — headless `opencode serve` blocks indefinitely on Deferred.await until reply / session-abort / server-shutdown.
- Config-policy fallback: `allow|deny|ask` via OpenCode config (`permission/evaluate.ts`) — non-interactive, does NOT satisfy S5's live-human-approval intent; kept as last-resort only if BOTH SSE and GET /permission fail.

## Key Technical Decisions

- **Probe confirms, not gates.** Unit 1 is now a **confirmation probe** rather than a binary gate: the full round-trip is expected to work (SSE delivery verified reliable), but the probe must empirically confirm it end-to-end and capture any ordering surprises (especially create-session→subscribe→prompt ordering, since run-core currently prompts before subscribing — at-most-once events may be missed). Decision gate: if round-trip works → proceed; if SSE fails but `GET /permission` works → proceed with a polling watcher; only if BOTH fail → Units 2-4 blocked, replan. Config-policy is non-interactive and does NOT satisfy S5.
- **Bind to the v2 event surface.** run-core consumes `session.next.*` (v2 sync events), so approval detection binds to **v2 `permission.asked`**, not v1 `permission.updated`. Mismatching the surface means the request is never seen.
- **HTTP reply is regression-proof.** The reply endpoint is plain HTTP (not SSE), so even if SSE delivery were fragile, the response path is stable.
- **Verified reply body.** `POST /permission/{requestID}/reply` with body `{ reply: "once" | "always" | "reject", message?: string }` and optional `query: { directory?, workspace? }`. APPROVE maps to `"once"` (default); DENY maps to `"reject"`. Do NOT use `allow|deny` or `response:`.
- **`requestID` = `properties.id` (confirmed).** The inbound event is `{ id: string, type: "permission.asked", properties: PermissionRequest }`; identity and display fields (sessionID, permission, tool, metadata) live in `properties`; the top-level `id` is the event ID only. The reply route's `{requestID}` path param is `properties.id` — confirmed by Oracle/Librarian review.
- **`permission.replied` is the authoritative settlement signal.** `{ sessionID, requestID, reply }` arrives as a non-sync bus event. run-core (and the coordinator) must consume it as the canonical "this permission was settled" signal, not just the button-click path alone. This handles auto-approve, policy-settle, and reject cascade sibling reconciliation.
- **Reject cascade.** A single `"reject"` reply settles ALL pending permissions in the same session server-side. The coordinator must reconcile sibling registry entries from `permission.replied` events — it cannot assume independent settlement.
- **In-memory registry (no S3 token store).** OpenCode pending permissions are ephemeral in-memory deferreds that die on instance teardown. The plan does not resume blocked runs across gateway restart; therefore, persisting an S3 token that points to a non-resumable run buys nothing. The registry is a module-scoped map keyed by `requestID` (`properties.id`). This is correct for a single-process gateway; it breaks under multi-replica deployments, which are out of scope for v1.
- **`custom_id = approve:<requestID>` / `deny:<requestID>`.** `requestID` is a UUID-shaped string that fits `approve:<requestID>` well within Discord's 100-char `custom_id` limit directly — no opaque token or additional indirection needed.
- **Workspace routing on reply.** The reply call MUST include the same workspace-routing `query: { directory }` used by the `/event` SSE subscription; without it the reply may hit the wrong instance or return a 4xx.
- **Single authoritative deadline — a sub-deadline of `runTimeoutMs`.** There is ONE deadline for an approval wait, set as a sub-deadline of the overall run timeout, also capped below Discord's 15-minute interaction-token expiry. This ensures the approval deadline fires before the run itself is torn down, and heartbeat continues during the wait. On timeout: post a deny (`"reject"`, fail-closed), flush the sink, surface a clear Discord message.
- **Single-winner settle guard.** A settled registry entry transitions state exactly once: button-click vs. timeout vs. `permission.replied` arrival cannot double-act. The loser path is a no-op, never double-POSTs to OpenCode.
- **Channel-scoped authorization, reusing mention auth.** Any trigger-role / `ManageChannels` user in the channel can approve; the click handler re-runs `userIsAuthorized()` (live fetch, not cache).
- **SSE loop must not block.** The coordinator seam (`onPermissionAsked` / `onPermissionReplied`) must be non-blocking in the event-loop switch; emit and return, let the coordinator own the wait.
- **No bodies in logs.** Approval logs carry tool name + decision + actor ID only — never tool input, never the permission payload contents.

## Open Questions

### Resolved During Planning

- Can a remote client see + respond to permissions at 1.14.41? — Yes (spike, memory 4365).
- v1 vs v2 permission API? — Use v2 (`permission.asked` + `POST /permission/{requestID}/reply`) to match run-core's v2 event surface.
- Where does approval state live? — In-memory registry keyed by `requestID`; no S3 token store.
- Which field is the reply `{requestID}` path param? — `properties.id` (confirmed, Oracle/Librarian review, memory 4366).
- Does SSE deliver `permission.asked` at 1.14.41? — Yes: it is a BusEvent, not a SyncEvent; survives the 1.14.42+ SyncEvent regression (confirmed, memory 4366).
- Is `permission.replied` a real event? — Yes: a non-sync bus event `{ sessionID, requestID, reply }`; it is the authoritative settlement signal (confirmed, memory 4366).
- Does reject cascade exist? — Yes: one `"reject"` settles all same-session pending permissions server-side (confirmed, memory 4366).
- Is there a server-side timeout? — No: `opencode serve` blocks indefinitely until reply / session-abort / server-shutdown (confirmed, memory 4366).

### Deferred to Implementation (Unit 1 Probe)

- **create-session→subscribe→prompt ordering:** run-core currently prompts before subscribing — at-most-once SSE events may be missed. Unit 1 must observe whether this ordering is a problem in practice and whether subscribe-before-prompt is required.
- **`session.idle` interleaving while a permission is pending:** observe during the Unit 1 probe; handle in Unit 2's loop integration.
- **N-concurrent cardinality:** confirm whether a single run can emit multiple concurrent `permission.asked` events; design the registry for N pending (keyed per `requestID`), each settled independently.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
@fro-bot <msg> ──► run.ts (auth, concurrency, thread)
                     └─► run-core.ts event loop (SSE /event)
                           │  session.next.text.delta ─► sink
                           │  permission.asked ─────────► coordinator.onPermissionAsked(request)
                           │        │  1. insert in-memory registry entry (keyed by requestID = properties.id)
                           │        │  2. post Discord embed + Approve/Deny buttons
                           │        │     custom_id = approve:<requestID> / deny:<requestID>
                           │        │  3. await coordinator promise (sub-deadline of runTimeoutMs; fail-closed "reject")
                           │        ▼
                           │  permission.replied ────────► coordinator.onPermissionReplied(event)
                           │        │  settles registry entry (authoritative signal; handles reject cascade)
                           │        │  withdraws/updates sibling embeds if cascade-rejected
                           │        ▼
                           │   interactionCreate (button) ─► authorize (live fetch)
                           │        │  verify interaction.channelId === pending.channelID
                           │        │  single-winner settle guard (loser is no-op)
                           │        │  POST /permission/{requestID}/reply  { reply: "once" | "reject" }
                           │        │    with query: { directory }
                           │        │  settle registry entry
                           │        ▼
                           │   run resumes (tool runs or is rejected)
                           └─ session.idle ─► flush sink, finalize
```

SSE-drop reconciliation path:
```
SSE drop detected while permission is pending
  ├─ GET /permission → lists pending requests → re-surface or fail-closed
  └─ (last resort only) config-policy: non-interactive, does NOT satisfy S5
```

Decision gate after Unit 1:
```
Unit 1 probe confirms the full round-trip at 1.14.41?
  ├─ YES (round-trip works) ─► build interactive approval (Units 2-4 as written)
  ├─ PARTIAL (SSE fails, GET /permission works) ─► proceed with polling watcher; do NOT pivot to config-policy
  └─ NO (both fail) ─► Units 2-4 blocked; replan; config-policy is a NON-INTERACTIVE fallback,
                        does NOT satisfy S5's live-human-approval intent.
```

## Implementation Units

- [x] **Unit 1: Runtime probe — confirm full permission round-trip at 1.14.41 (low-risk confirmation)** — PASSED 2026-06-01. Against an isolated `--pure` 1.14.41 server (temp HOME/XDG, `opencode/big-pickle`), an `external_directory` read trigger produced `permission.asked` over `/event` SSE; `GET /permission` listed the pending request; the tool was blocked before reply; `POST /permission/{properties.id}/reply` with `{reply:"once"}` unblocked it and `{reply:"reject"}` cancelled it; `permission.replied` arrived over SSE as the authoritative settle. Confirmed `requestID = properties.id`; event order `…permission.asked → permission.replied → …session.idle`. Isolation recipe + full payload shape recorded in memory 4367. Decision gate: YES — interactive S5 buildable; config-policy fallback not needed.

**Goal:** Empirically confirm that `permission.asked` reaches the gateway's `/event` SSE subscriber, that `GET /permission` lists the pending request, that `POST /permission/{requestID}/reply` (with `requestID = properties.id`) unblocks the tool, and capture any ordering or interleaving surprises. Since SSE delivery is verified reliable at this SDK version, the probe is a **confirmation** of the full round-trip, not a binary gate on an unknown.

**Requirements:** R-S5 (feasibility confirmation)

**Dependencies:** None.

**Files:**
- Create: `packages/gateway/scripts/probe-permission-event.mjs` (or a temporary `*.test.ts` harness) — drives a workspace OpenCode session against a fixture that triggers a permission; subscribes to `/event`; calls `GET /permission`; exercises the reply endpoint.
- Reference: `packages/gateway/src/execute/run-core.ts` (reuse its attach/subscribe wiring), `apps/workspace-agent/` (workspace server + proxy).

**Approach:**
- Stand up (or reuse) a workspace OpenCode server at the pinned 1.14.41 with a permission-requiring config (a tool set to `ask`).
- Subscribe to `/event` using the **exact same path** as run-core: same `directory` query parameter, same bearer proxy — not a bare SDK call without workspace routing.
- Prompt a session into a tool that requires permission; record: (a) does `permission.asked` arrive over SSE? (b) does `GET /permission` list the pending request (reconciliation fallback)? (c) does `POST /permission/{requestID}/reply { reply: "once" }` actually unblock the tool? (d) confirm `requestID = properties.id`. (e) trigger a `"reject"` reply and confirm the cascade: all same-session pending permissions are rejected server-side. (f) observe whether `session.idle` interleaves while a permission is pending. (g) observe create-session→subscribe→prompt ordering — does prompting before subscribing cause `permission.asked` to be missed?
- Exercise at least one **concurrent-pending** scenario (two permission requests in the same session) to confirm N-request cardinality and independent settlement.
- **Decision gate:** if the full round-trip works → proceed to Units 2-4. If SSE fails but `GET /permission` works → proceed with a polling watcher instead of pure SSE. If BOTH fail → stop, mark Units 2-4 blocked, open a replan (config-policy is non-interactive and does NOT satisfy S5).

**Execution note:** This is a throwaway investigation harness, not production code — start by observing real events, not by writing assertions. Capture findings, then delete or convert the harness.

**Test scenarios:**
- Test expectation: none — this is a runtime probe / investigation harness, not feature-bearing code. Its output is a recorded finding (round-trip confirmed + payload shape + `requestID` field + reject cascade behavior + `session.idle` interleaving + create-subscribe-prompt ordering) that informs Units 2-4.

**Verification:**
- A documented finding: "full round-trip {confirmed | partially confirmed | failed}; `permission.asked` over SSE = {yes | no}; `GET /permission` lists pending = {yes | no}; `POST /permission/{requestID}/reply` unblocks = {yes | no}; `requestID = properties.id` = {confirmed | contradicted}; reject cascade = {confirmed | contradicted}; `session.idle` interleaving = {…}; create-subscribe-prompt ordering = {…}." The decision gate is resolved and the chosen branch is recorded.

- [ ] **Unit 2: Permission coordinator + run-core integration**

**Goal:** Add a permission coordinator with an explicit seam (`onPermissionAsked` / `onPermissionReplied`) and an in-memory registry keyed by `requestID`. run-core consumes both `permission.asked` (register pending + signal the coordinator) and `permission.replied` (authoritative settle — reconcile sibling embeds on reject cascade). The coordinator owns the blocking wait; run-core stays transport-focused.

**Requirements:** R-S5, R-S5.3

**Dependencies:** Unit 1 (confirmed branch).

**Files:**
- Modify: `packages/gateway/src/execute/run-core.ts`
- Create: `packages/gateway/src/approvals/coordinator.ts`
- Test: `packages/gateway/src/execute/run-core.test.ts`, `packages/gateway/src/approvals/coordinator.test.ts`

**Approach:**
- Add a `permission.asked` branch to run-core's event loop that calls `coordinator.onPermissionAsked(request)` and returns immediately (do not block the loop; keep the SSE drain running so `permission.replied` and other events are not starved).
- Add a `permission.replied` branch to run-core's event loop that calls `coordinator.onPermissionReplied(event)` — this is the authoritative settlement signal and must be processed even when no button click has arrived.
- The coordinator exposes: `onPermissionAsked(request): Promise<"once" | "reject">` (the run-core event loop awaits this promise after registering; the promise resolves when settled by button click, `permission.replied`, or the deadline) and `onPermissionReplied(event): void` (settle the matching registry entry and reconcile any same-session siblings cascade-rejected by the server).
- The in-memory registry is a module-scoped map keyed by `requestID` (`properties.id`). Each entry tracks: promise resolver, channelID (for channel-binding in Unit 3), settlement state (open / settled), and session ID (for cascade reconciliation). A restart abandons all entries — controlled failure, not a hang.
- **Reject cascade:** when `permission.replied` arrives with `reply: "reject"`, check for other open registry entries with the same `sessionID` and fail-close them (they were cascade-rejected server-side); their embeds must be updated/withdrawn in Unit 3.
- **create-session→subscribe→prompt ordering:** if Unit 1 showed that prompting before subscribing drops `permission.asked`, enforce subscribe-before-prompt in the coordinator or run-core wiring.

**Patterns to follow:** the existing `session.next.tool.called`/`success` correlation (cache call info, surface to caller) at `run-core.ts:266-300`.

**Test scenarios:**
- Happy path: `permission.asked` event with valid `properties` → coordinator registers entry keyed by `properties.id`, returns a pending promise.
- Happy path: `permission.replied { reply: "once" }` → coordinator settles the matching entry; promise resolves `"once"`.
- Happy path: `permission.replied { reply: "reject" }` → coordinator settles the matching entry; promise resolves `"reject"`; sibling same-session open entries are also fail-closed (cascade).
- Edge case: `permission.asked` with a missing/unknown tool field in `properties` → still registers with a safe fallback title, does not throw.
- Edge case: `permission.replied` for an unknown `requestID` (already settled or never registered) → no-op, no error.
- Edge case: `session.idle` arriving while a permission is pending → pending signal emitted before idle resolves (ordering preserved); coordinator entry not dropped prematurely.
- N-concurrent: two `permission.asked` events for the same run → two independent registry entries, each settled independently.

**Verification:** run-core emits structured pending-permission signals on `permission.asked`, processes `permission.replied` as the authoritative settle, and continues to handle all existing event types unchanged.

- [ ] **Unit 3: Discord approval embed/buttons + live auth + channel binding + pause/resume**

**Goal:** When the coordinator signals a pending permission, post a Discord approval embed with Approve/Deny buttons (`custom_id = approve:<requestID>` / `deny:<requestID>`); the run pauses on the coordinator promise. Handle button clicks: verify channel binding, authorize the clicker (live fetch), POST the decision to OpenCode's reply endpoint (with workspace routing), and settle the coordinator registry entry. Single authoritative sub-deadline and single-winner settle guard govern the entire flow.

**Requirements:** R-S5, R-S5.1, R-S5.3, R-S5.4

**Dependencies:** Unit 2.

**Files:**
- Create: `packages/gateway/src/discord/approvals.ts` (embed builder + button `ActionRow`; `custom_id = approve:<requestID>` / `deny:<requestID>`)
- Modify: `packages/gateway/src/execute/run.ts` (await coordinator promise between pending signal and continuation; respect failure-path flush; ensure heartbeat continues during wait)
- Modify: `packages/gateway/src/program.ts` (register `interactionCreate` button routing; reach the coordinator registry)
- Test: `packages/gateway/src/discord/approvals.test.ts`, `packages/gateway/src/execute/run.test.ts`

**Approach:**
- On pending signal from coordinator: build embed (tool + title, no input body) + Approve/Deny buttons → post to the run's thread.
- **`custom_id = approve:<requestID>` / `deny:<requestID>`.** `requestID` is `properties.id`; fits well within Discord's 100-char limit directly — no opaque token or S3 indirection needed.
- Await the coordinator promise (blocking the run); the promise is settled by button click, `permission.replied`, or the single authoritative deadline.
- **Single authoritative deadline — a sub-deadline of `runTimeoutMs`.** Set the deadline to expire before the run itself is torn down (and before Discord's 15-min interaction-token expiry). Heartbeat must continue during the wait. On deadline expiry: post a deny (`"reject"`, fail-closed) to OpenCode via `POST /permission/{requestID}/reply`, flush the sink, surface a clear "approval timed out — denied" message, settle the coordinator entry, and resolve the run cleanly. Reuse the dual-finally / flush discipline from the mention-loop best-practices doc.
- **Channel binding invariant.** `interaction.channelId` MUST equal the `channelID` recorded in the coordinator registry entry (recorded at `permission.asked` time). A mismatch fails closed with an ephemeral denial and no reply POST.
- **Live authorization.** Re-run `userIsAuthorized()` on every click (live `members.fetch`, not cache). Return ephemeral "not authorized" with no side effects if rejected.
- **Single-winner settle guard.** Check the coordinator registry entry's settlement state before posting. First settler wins; all others (button-click vs. timeout vs. `permission.replied`) are no-ops — never double-POST to OpenCode.
- POST `{ reply: "once" }` (approve) or `{ reply: "reject" }` (deny) to `POST /permission/{requestID}/reply` via the SDK, **including `query: { directory }`** matching the workspace routing of the run's SSE subscription.
- On success: settle the coordinator registry entry, edit the original embed to a resolved state (who decided, decision) — no secret content; log actor ID + tool + decision only.
- **Reject cascade — update sibling embeds.** When `permission.replied` cascade-rejects sibling same-session permissions, update/withdraw their Discord embeds via the coordinator (Unit 2 signals this; Unit 3 handles the embed side-effect).
- **Shutdown-triggered fail-closed settle.** `program.ts` awaits `inFlightRuns` on shutdown; a pending approval could stall shutdown until the deadline. Add a shutdown signal path that triggers fail-closed settle on all open coordinator registry entries so shutdown does not hang indefinitely.

**Patterns to follow:** `discord/streaming.ts` safe-send helpers; failure-path flush from `run.ts`; `interaction.appPermissions` / live-fetch lessons from the slash-command solution doc.

**Test scenarios:**
- Happy path (approve): authorized clicker, channel match, registry entry open → single-winner guard passes → POST `{ reply: "once" }` with `query: { directory }` → run resumes → embed shows "approved by @user".
- Happy path (deny): authorized clicker, channel match → POST `{ reply: "reject" }` → run rejects the tool.
- Error path: no resolution within sub-deadline → fail-closed `"reject"` posted to OpenCode, sink flushed, clear Discord message, run finalizes cleanly.
- Edge case: embed post fails (Discord API error) → run does not hang; falls back to fail-closed `"reject"` + logged reason.
- Race (click-vs-timeout): click arrives after timeout has already settled the entry → single-winner guard no-ops the click; no double-POST to OpenCode.
- Race (click-vs-permission.replied): `permission.replied` settles the entry before button click arrives → click is a no-op.
- Security: `interaction.channelId` ≠ coordinator `channelID` → ephemeral denial, no POST, no state change.
- Security: unauthorized clicker → ephemeral "not authorized", no POST, run stays pending.
- Reject cascade: deny one permission → coordinator reconciles sibling embeds for same-session cascade-rejected entries.
- N-concurrent: two `permission.asked` events for the same run → two independent embeds, each settled independently without cross-contamination.
- Shutdown: gateway shutdown signal → all open coordinator registry entries fail-closed; embeds updated; shutdown does not hang.
- Integration: approve click end-to-end settles the exact pending run keyed by `requestID` (no cross-run leakage); OpenCode reply endpoint called exactly once per authorized decision.

**Verification:** a permission-requiring run posts an approval prompt, blocks, and resumes or fail-closes deterministically; the concurrency slot is released within the sub-deadline bound; N-concurrent requests do not interfere; shutdown drains cleanly.

- [ ] **Unit 4: Integration/failure tests + deploy docs**

**Goal:** End-to-end failure-mode tests covering the scenarios that unit mocks cannot prove, plus deploy documentation: the workspace `permission: ask` config knob (the deploy-time switch that activates S5) and `AGENTS.md` permission posture.

**Requirements:** R-S5.1, R-S5.3, R-S5.4

**Dependencies:** Units 2, 3.

**Files:**
- Create: integration test(s) covering the approve→reply→resume cross-seam path and the key failure modes
- Modify: `packages/gateway/AGENTS.md` (permission posture; authorize-approver guidance)
- Modify: `deploy/README.md` (workspace `permission: ask` config knob; how to enable tool prompting)

**Approach:**
- Integration test: the approve→reply→resume path crosses Discord → coordinator → OpenCode HTTP; assert the reply endpoint is hit exactly once per authorized decision via a seam/mock.
- Integration test: SSE drop while a permission is pending → `GET /permission` reconciliation path kicks in or run fails closed cleanly (no hang).
- Integration test: workspace/OpenCode restart while a permission is pending → coordinator registry entry expires/fails; gateway never shows "approved" for a dead deferred; run surfaces as "run interrupted, please re-mention".
- Integration test: gateway shutdown with an in-flight pending approval → shutdown-triggered fail-closed settle completes; `inFlightRuns` drain unblocks; gateway exits cleanly.
- Document (in `AGENTS.md` + `deploy/README.md`) how an operator enables tool prompting (the workspace OpenCode `permission` config that makes tools `ask` rather than auto-allow) — this is the deploy-time knob that makes S5 active.

**Test scenarios:**
- Approve → reply → resume end-to-end: coordinator promise resolves `"once"`, reply endpoint called once, run continues.
- SSE drop during pending: reconcile via `GET /permission` or fail closed without hanging.
- OpenCode restart during pending: coordinator entry fails/expires; no "approved" side-effect to a dead deferred.
- Shutdown drain: pending approval fail-closes; `inFlightRuns` unblocks; no indefinite hang.

**Verification:** all failure modes covered by integration tests; deploy docs explain how to enable the prompt posture and the v1 restart limitation.

## System-Wide Impact

- **Interaction graph:** introduces a Discord `interactionCreate` (button) handler alongside the existing slash-command dispatch; both route through `program.ts` event wiring. The run-core event loop gains `permission.asked` and `permission.replied` branches; the run orchestrator gains a blocking wait on the coordinator promise and a pending-run registry.
- **Error propagation:** approval failures (deadline, Discord post failure, reply-endpoint non-2xx) must fail-closed (deny) and flush partial output, never silently drop a run or leave the concurrency slot wedged.
- **Authorization surface:** approve/deny reuses `userIsAuthorized()` so the existing mention auth rules apply uniformly to approvals. The R6 block role was dropped (won't-do) as redundant.
- **Integration coverage:** the approve→reply→resume path crosses Discord → coordinator → OpenCode HTTP; unit mocks alone won't prove it — include a seam test that asserts the reply endpoint is hit exactly once per authorized decision.
- **Unchanged invariants:** the mention loop's existing run path (no permission requested) is unaffected — when no `permission.asked` arrives, behavior is identical to today. The GitHub Action tier is untouched.

### Named Lifecycle Failure Modes

- **workspace/OpenCode restart while pending.** OpenCode rejects the permission server-side when its process exits (shutdown finalizer rejects all pending deferreds). The coordinator registry entry must fail/expire on this signal; the gateway must never show "approved" for a dead deferred. The run surfaces as "run interrupted, please re-mention."
- **SSE drop while a permission is pending.** `permission.asked` and `permission.replied` are at-most-once / non-replayable bus events; a dropped SSE connection loses them. Reconcile via `GET /permission` (lists pending requests) or fail closed. Never leave a run hanging on a dropped SSE without a timeout.
- **Gateway shutdown drain.** `program.ts` awaits `inFlightRuns` on shutdown; a pending approval could stall this indefinitely until the sub-deadline fires. Add a shutdown signal that triggers fail-closed settle on all open coordinator registry entries so the drain unblocks promptly.
- **Heartbeat/lock liveness.** The approval wait shares the run lifecycle; the heartbeat (if any) must continue during the coordinator await. The approval deadline must be a **sub-deadline of `runTimeoutMs`** so the outer run timeout is never the binding constraint.
- **Reject cascade.** A single `"reject"` reply (or an always-auto-approve config rule) settles ALL pending permissions in the same session server-side. The coordinator must reconcile sibling registry entries from `permission.replied` events, not assume each permission is settled independently. Discord embeds for cascade-rejected siblings must be updated/withdrawn.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `permission.asked` does not reach `/event` SSE at 1.14.41 despite BusEvent classification | Unit 1 probe confirms the full round-trip. If SSE fails: try polling via `GET /permission` (reconciliation fallback). If both fail: pivot to replan (config-policy is NON-INTERACTIVE and does NOT satisfy S5). |
| create-session→subscribe→prompt ordering drops at-most-once `permission.asked` | Unit 1 probe observes this directly; enforce subscribe-before-prompt in Unit 2 if needed. |
| `session.idle` interleaves while a permission is pending, terminating the run prematurely | Observe in Unit 1; handle ordering in Unit 2's event loop integration. |
| OpenCode times out or restarts server-side before the Discord click arrives | Coordinator registry entry fails/expires on the `permission.replied` cascade or SSE close; gateway never posts a reply to a dead deferred. Sub-deadline fires before run teardown. |
| Gateway shutdown stalls on a pending approval | Shutdown-triggered fail-closed settle on all open coordinator entries; `inFlightRuns` drain unblocks. Tested in Unit 4. |
| SSE drop while a permission is pending (events are at-most-once) | Reconcile via `GET /permission`; fail closed if unavailable. Never hang without a deadline. |
| Reject cascade settles sibling permissions unexpectedly | Coordinator reconciles sibling registry entries from `permission.replied`; their embeds are updated/withdrawn. Tested explicitly. |
| Double-click or click racing a timeout/permission.replied double-POSTs to OpenCode | Single-winner settle guard on the coordinator registry entry: first settler wins, all others are no-ops. Tested with click-vs-timeout and click-vs-permission.replied race scenarios. |
| A pending approval wedges the per-channel concurrency slot | Bounded by the single authoritative sub-deadline (fail-closed `"reject"`); tested in Unit 3. Heartbeat continues during wait. |
| Unauthorized user approves a sensitive action | Approve/deny re-runs live `userIsAuthorized()` on every click; never trusts the original mention author or cache. Channel binding check additionally prevents cross-channel approval. |
| Secret/tool-input leakage into Discord or logs | Embed shows tool name + title only; logs carry actor ID + tool + decision; no tool input in any registry entry or logged field. |

## Documentation / Operational Notes

- Document the workspace permission-mode knob (OpenCode `permission: ask`) required to make tools prompt — without it, tools auto-allow and no approval is requested. This is the deploy-time switch that activates S5. Covered in Unit 4's `AGENTS.md` + `deploy/README.md` edits.
- Note the v1 limitation: a gateway restart during a pending approval abandons that run. The blocked run is NOT resumed; pending coordinator registry entries are discarded on restart and surface as "run interrupted, please re-mention."
- Note the multi-replica limitation: the in-memory coordinator registry is single-process; running multiple gateway replicas would split the registry and break button routing. Multi-replica is out of scope for v1.

## Sources & References

- **Origin document:** [docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md](docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md) (Unit 6 deferred items; approval design sketch at lines 183, 200, 284-286, 764, 769)
- Spike findings: project memory ID 4365 (S5 remote-attach feasibility at 1.14.41)
- Oracle architecture review + Librarian source research: project memory ID 4366 (session 2026-06-01) — BusEvent classification confirmed, `requestID = properties.id` confirmed, `permission.replied` authoritative signal confirmed, reject cascade confirmed, no server-side timeout confirmed, `GET /permission` reconciliation endpoint confirmed
- SDK refs: installed `@opencode-ai/sdk@1.14.41` — `PermissionList` (`GET /permission`), `postPermissionRequestIdReply` (`POST /permission/{requestID}/reply`), `permission.asked` / `permission.replied` event shapes
- OpenCode source (clonedeps): `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/permission/index.ts` (Deferred.await, bus.subscribeAll, shutdown finalizer), `.../server/routes/instance/httpapi/groups/permission.ts` (reply route, list route)
- Related solutions: `docs/solutions/best-practices/discord-slash-command-orchestration-patterns-2026-05-27.md`, `gateway-opencode-mention-loop-best-practices-2026-05-30.md`, `webhook-ingress-security-patterns-2026-05-30.md`
