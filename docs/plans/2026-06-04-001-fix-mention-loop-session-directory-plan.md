---
title: 'fix: thread directory to session.create so mention-loop events arrive'
type: fix
status: done
date: 2026-06-04
---

> **Status: done.** `client.session.create()` threads `{query: {directory}}` matching `event.subscribe`/`promptAsync` — verified on `main` (`packages/gateway/src/execute/run-core.ts:319`).

# fix: thread directory to session.create so mention-loop events arrive

## Overview

The `@fro-bot` Discord mention loop never replies: `packages/gateway/src/execute/run-core.ts` creates the OpenCode
session **without a directory**, but subscribes to the event stream and sends the prompt **filtered to the repo
subdirectory**. OpenCode's `/event` stream is directory-scoped, so a subscription filtered to the subdir never receives
events for a session rooted at the parent (`/workspace/repos`). The gateway captures no `message.part.delta` (no reply
text) and no `session.idle` (no completion), waits out the run timeout, and posts nothing to Discord — a silent
no-reply, regardless of model. Fix: pass the same `directory` to `client.session.create()` that `event.subscribe()` and
`promptAsync()` already use, so all three agree.

Source: issue #766 + Fro Bot's source-verified triage. Confirmed still live on current `main` (`dc647e1`):
`run-core.ts:190` is `await client.session.create()` (no args) while `:216` and `:230` pass `{query: {directory}}`.

## Problem Frame

`runOpenCodeCore` in `packages/gateway/src/execute/run-core.ts` threads `directory` inconsistently across the three
OpenCode SDK calls that make up a mention run:

- `client.session.create()` (`run-core.ts:190`) — **no directory**. OpenCode roots the new session at its launch cwd
  (`/workspace/repos`), not the requested repo subdir.
- `client.event.subscribe({query: {directory}})` (`run-core.ts:216`) — filtered to the repo subdir.
- `client.session.promptAsync({..., query: {directory}})` (`run-core.ts:227-231`) — also the repo subdir.

Because the SSE stream is directory-scoped, the subdir-filtered subscription receives only `server.connected` /
`server.heartbeat` for a session rooted at the parent — never the session's `message.part.delta` or `session.idle`. The
drain loop therefore captures no reply text and never observes completion, exiting via the timeout-signal path
("stream ended due to timeout signal"). The workspace OpenCode produces a correct, stored assistant answer; the gateway
just never sees the events it filtered out.

The file's own header comment (`run-core.ts:14-17`) already documents that `directory` must be threaded for SSE routing
— but it names only `promptAsync` and `event.subscribe`, and the rule was applied to those two while `session.create`
was missed. `run-core.test.ts` mocks `create` but never asserts what directory is passed to it (the "header + directory
threading" describe block tests `promptAsync` only), which is why the bug shipped.

## Requirements Trace

- **R1.** `client.session.create()` must root the session at the same `directory` that the event subscription filters
  on, so the mention run receives `message.part.delta` and `session.idle` and posts the reply.
- **R2.** A regression test must assert `session.create` is called with `{query: {directory}}` matching the subscribe /
  prompt directory, closing the coverage gap that let this ship.
- **R3.** The header-comment invariant must name all three calls (`session.create`, `event.subscribe`, `promptAsync`) so
  the rule isn't silently re-broken.

## Scope Boundaries

- Not adopting Options 2/3 from the issue (drop the subscribe `directory` filter and correlate purely on `sessionId`).
  Those make event delivery robust to future session-root vs request-directory mismatches but weaken the
  directory-routing guarantee the header comment relies on. Chosen approach is Option 1 (preferred by both the reporter
  and Fro Bot); 2/3 remain available as a future hardening if a root/request mismatch ever recurs.
- Not changing the event-handling / `sessionId` correlation logic, the streaming semantics, or any other run-core
  behavior — this is a single missing-parameter fix.
- Not touching the action-tier streaming path (`src/features/agent/`) — the bug is gateway-only (`run-core.ts`).

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/execute/run-core.ts` — `runOpenCodeCore`; the three SDK calls at `:190` (create), `:216`
  (subscribe), `:230` (prompt). The fix mirrors the exact `{query: {directory}}` shape already used at `:216`/`:230`.
- `packages/gateway/src/execute/run-core.test.ts` — `buildParams` / `BASE_PARAMS` (directory fixtured at `:203`/`:213`),
  the `create: vi.fn().mockImplementation(sessionCreate)` mock (`:183`), and the existing "header + directory threading"
  describe block (`:658`) whose `threads directory to promptAsync query` test (`:659`) is the exact pattern to mirror
  for a new `threads directory to session.create query` test.
- SDK support: `SessionCreateData` accepts `query.directory` (`@opencode-ai/sdk` `types.gen.d.ts`) — Option 1 is a
  typed, supported one-liner, not a workaround.

### Institutional Learnings

- `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md` — already encodes the rule
  this bug violates: thread the repo directory consistently through the OpenCode session lifecycle; `session.idle` is
  the success signal and EOF without it is failure. This change brings `session.create` into compliance with that
  documented rule.

## Key Technical Decisions

- **Option 1 (pass `directory` to `session.create`)** over Options 2/3: keeps directory routing intact, aligns
  `create`/`subscribe`/`prompt` on one directory, is minimal and fully typed, and preserves the documented SSE-routing
  invariant. (User-selected; matches both the reporter's and Fro Bot's primary recommendation.)
- **Update the header comment to name all three calls**: the comment currently says "BOTH `promptAsync` AND
  `event.subscribe`" — making it "`session.create`, `event.subscribe`, AND `promptAsync`" prevents the same omission
  recurring.

## Open Questions

### Resolved During Planning

- Option 1 vs 2/3 → **Option 1** (user-selected).
- Does the SDK accept `query.directory` on create? → **Yes**, `SessionCreateData.query.directory` is typed.
- Is the bug still live on current main? → **Yes**, verified at `run-core.ts:190` on `dc647e1`.

### Deferred to Implementation

- None — this is a fully specified single-line behavior change plus its test and comment.

## Implementation Units

- [x] **Unit 1: Thread directory to session.create + regression test + comment**

**Goal:** The mention run's session is rooted at the repo directory so the subdir-filtered event subscription receives
its `message.part.delta` / `session.idle`, and the gateway posts the reply.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `packages/gateway/src/execute/run-core.ts` (pass `{query: {directory}}` to `client.session.create()` at
  `:190`; update the header comment at `:14-17` to name all three calls)
- Test: `packages/gateway/src/execute/run-core.test.ts` (add a `threads directory to session.create query` test mirroring
  the existing `threads directory to promptAsync query` test)

**Approach:**
- Change `await client.session.create()` to `await client.session.create({query: {directory}})`, reusing the same
  `directory` already destructured from params and passed to `subscribe`/`prompt`. No other logic changes.
- Update the header comment so the SSE-routing invariant reads "`session.create`, `event.subscribe`, AND `promptAsync`
  must carry the workspace repo `directory`" (currently names only the latter two).

**Execution note:** Test-first — add the failing `session.create` directory assertion before the one-line fix, mirroring
the existing promptAsync-directory test.

**Patterns to follow:**
- `run-core.test.ts:659` `threads directory to promptAsync query` — same structure: `buildParams(handle, {directory:
  '/repos/myrepo'})`, run the core, then assert the create mock's first call arg `query.directory` equals the params
  directory.
- The `{query: {directory}}` shape already at `run-core.ts:216`/`:230`.

**Test scenarios:**
- Happy path: `runOpenCodeCore` with `directory: '/repos/myrepo'` → `session.create` mock received
  `{query: {directory: '/repos/myrepo'}}` (the new regression test; fails before the fix because create is called with
  no args).
- Integration (already covered, must still pass): the existing `threads directory to promptAsync query` and the
  subscribe-directory behavior remain green — create now agrees with both.

**Verification:**
- The new `session.create` directory test fails against the unfixed line and passes after.
- `pnpm --filter @fro-bot/gateway test` green; `check-types` clean; `lint` 0 errors.
- `pnpm --filter @fro-bot/gateway build` succeeds (gateway bundle rebuilt for the deployed image).

## System-Wide Impact

- **Interaction graph:** `handleMention` → `runMention` → `runOpenCodeCore` → `session.create`/`event.subscribe`/
  `promptAsync`. Only the create call's args change; the event-drain loop and `sessionId` correlation are untouched.
- **Error propagation:** unchanged — `create` already handles the 401/throw paths; adding the query param doesn't alter
  them.
- **API surface parity:** none — `runOpenCodeCore` signature unchanged; `directory` was already a required param.
- **Unchanged invariants:** loopback/bearer-proxy transport, `sessionId`-gated event handling, streaming semantics,
  and the action-tier path (`src/features/agent/`) are all unaffected. This is purely aligning create with the two
  calls that already carry `directory`.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Passing `directory` to create changes session rooting in a way a test depended on | The existing create mock ignores args; the only new assertion is the directory itself. Full gateway suite must stay green. |
| The fix is correct in unit tests but the real workspace still mismatches | Unit/type coverage proves the contract; final proof is a live mention turn through a redeployed gateway (operator redeploy off the next release). Noted, not blocking. |

## Documentation / Operational Notes

- Header comment in `run-core.ts` updated to name all three calls (prevents recurrence).
- After merge + release, operators redeploy the gateway off the new version to restore the mention loop.
- Optional follow-up (not this PR): the mention-loop best-practices doc could add an explicit "thread `directory` to
  `session.create` too" line, but the code comment is the load-bearing reminder.

## Sources & References

- Issue: #766 (gateway mention loop never replies — directory routing mismatch)
- Triage: Fro Bot triage comment on #766 (source-verified; SDK `SessionCreateData.query.directory` confirmed)
- Related code: `packages/gateway/src/execute/run-core.ts` (`runOpenCodeCore`, `:190`/`:216`/`:230`),
  `packages/gateway/src/execute/run-core.test.ts` (`:658` directory-threading block)
- Learnings: `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md`
