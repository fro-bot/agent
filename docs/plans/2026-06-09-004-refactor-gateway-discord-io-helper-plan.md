---
title: "refactor: Centralized fail-soft Discord I/O helper (discord/io.ts)"
type: refactor
status: completed
date: 2026-06-09
deepened: 2026-06-09
completed: 2026-06-09
---

# Centralized fail-soft Discord I/O helper (`discord/io.ts`)

## Overview

The gateway hand-rolls Discord sends/edits/replies at ~50 call sites. Mention-safety (`allowedMentions: {parse: []}`) and best-effort error handling are copy-pasted where present and silently missing where not — and there are already **three** near-identical local helpers (`streaming.ts` `safeSend`, `run.ts` `safeSend` + `safeReply`, `mentions.ts` `safeReply`). This refactor introduces one `packages/gateway/src/discord/io.ts` module with fail-soft helpers for both Discord surfaces (Message/Thread sends and interaction replies/edits), defaulting mention-safety so it cannot be forgotten, returning a `Result` instead of throwing. Existing local helpers collapse onto it; sites currently missing the mention guard gain it. A boundary check prevents future raw sends from bypassing the helper.

**No escape hatch in v1.** Review verified there is no genuine intentional-ping site: `add-project.ts:593` renders `"try @fro-bot in #channel"` as **plain text** (`@fro-bot` is literal, not a `<@id>` mention; `#channel` is the channel name string, not a `<#id>` mention), so `{parse: []}` changes nothing there. A mention-permitting override would be pure over-permissioning, so it is omitted. If a real ping need ever arises, add a *constrained* override then (specific user/channel IDs only, never global `parse`).

## Problem Frame

Two recurring problems, both surfaced by the Oracle assessment during PR #854 review:

1. **Security/correctness drift:** `allowedMentions: {parse: []}` is the guard that stops agent- or user-derived text from pinging `@everyone`/roles/users. It is applied inconsistently — every direct `interaction.editReply`/`reply` in `add-project.ts` (~30 sites), the non-lock-outcome edits in `fro-bot.ts` (6), `program.ts`, `commands/index.ts`, `ping.ts`, and the approval send in `run.ts` omit it. A new send site is one forgotten option away from a mention-amplification bug.
2. **Duplication:** three local fail-soft send wrappers + two `safeReply` definitions, none returning a Result or logging failures consistently. New features keep re-rolling the pattern (reactions.ts, status-message.ts each have their own try/catch shape).

## Requirements Trace

- R1. A single `discord/io.ts` exposes fail-soft helpers for (a) Message/Thread sends (send/reply + a separate edit helper) and (b) interaction replies/edits, each defaulting `allowedMentions: {parse: []}`, catching Discord API errors, logging via the injected `GatewayLogger` with **redacted** context (no raw message content/payloads), and returning a `Result` (never throwing).
- R2. The interaction family is **Effect-returning** (composes inside the existing `Effect.gen` command handlers without redundant `Effect.tryPromise` wrapping) and targets a **reply/edit-capable interaction type** broad enough to cover both `ChatInputCommandInteraction` and the button interaction used in `program.ts` (not chat-input only).
- R3. The three existing local helpers (`streaming.ts` `safeSend`, `run.ts` `safeSend`/`safeReply`, `mentions.ts` `safeReply`) are removed and their callers migrated to `io.ts`.
- R4. Call sites currently missing `allowedMentions: {parse: []}` gain it via migration — `add-project.ts`, `fro-bot.ts` non-lock edits, `program.ts`, `commands/index.ts`, `ping.ts`, `run.ts` approval send.
- R5. A boundary check (test/grep/lint) fails if a raw `interaction.reply`/`editReply` or message/thread `.send`/`.reply`/`.edit` bypasses `io.ts` in the gateway, so the mention guard cannot drift back out.
- R6. No behavioral regression: best-effort sites stay best-effort (never throw into the run/command flow); awaited sites stay awaited; fire-and-forget sites stay fire-and-forget; the #854 hanging-reply fix (catchAll edits the deferred reply on failure) is preserved.
- R7. Mention-safe with no override in v1: every helper applies `{parse: []}` with no caller opt-out (no escape hatch).

## Scope Boundaries

- Not changing WHAT any site sends (content/embeds/components unchanged) — only HOW it's sent (through the helper, with the guard + Result).
- **Leave all already-correct best-effort sites as-is** — `status-message.ts`, `presence.ts`, `recovery.ts` already set the guard and catch; do NOT migrate them (no duplication to collapse, no missing guard). This is a firm rule, not a per-site judgment, to avoid diff divergence.
- **`reactions.ts` is OUT** — it uses `react`/`users.remove` (reaction API), not a content send/reply/edit, so it is outside io.ts's surface entirely.
- The only sites this plan touches: the 3 duplicate helpers + their callers (Unit 2), and the interaction sites currently missing the guard (Unit 3).
- Not adding new Discord behaviors, retries, or rate-limit handling — fail-soft = catch+log+Result, nothing more.
- Not touching `deferReply` semantics (it's an ack, not a content send; helpers wrap reply/editReply/send, not defer).

### Deferred to Separate Tasks

- Follow-up B (`makeGuildCommand` pipeline collapsing the deferReply→auth→editReply skeleton): separate PR (note #147). This plan provides the io.ts that B will build on.

## Context & Research

### Relevant Code and Patterns

- **Existing helpers to absorb:** `packages/gateway/src/discord/streaming.ts` `safeSend` (Thread send + guard); `packages/gateway/src/execute/run.ts` `safeSend`/`safeReply`; `packages/gateway/src/discord/mentions.ts` `safeReply`. All currently `Promise<void>`, no catch, guard inline.
- **Already-correct best-effort sites (reference for the helper's catch+log shape):** `status-message.ts:207-254` (send/edit/delete/typing in try/catch with guard), `presence.ts:88-94`, `recovery.ts:280-283`, `streaming.ts` callers returning a FlushResult.
- **Logger:** `GatewayLogger` in `packages/gateway/src/discord/client.ts` — `debug/info/warn/error(context, message)`. NOTE: `add-project.ts` uses a different inline logger shape (`(msg, meta?)`); the helper takes `GatewayLogger` and add-project adapts or passes its gateway logger.
- **Result type:** the gateway/runtime use `Result<T, E>` (from `@bfra.me/es`); mirror existing usage.
- **No intentional-ping site exists:** `add-project.ts:593` ("try @fro-bot in #${channel.name}") is plain text — `@fro-bot` is literal, `#${channel.name}` is a name string; neither is a Discord mention, so `{parse: []}` is a no-op there. No escape hatch needed.
- **Interaction surface:** command handlers use `interaction.reply/editReply` (wrapped in `Effect.tryPromise` inside `Effect.gen` handlers); `program.ts` edits a **button** interaction (not ChatInput) on the approval path — the interaction helper type must cover both. The Message/Thread surface uses `.send`/`.reply`/`.edit`.

### Institutional Learnings

- `docs/solutions/best-practices/centralize-s3-key-identity-construction-2026-06-09.md` — the just-written sibling lesson: centralize duplicated construction so a guard can't be forgotten/drift. This refactor is the same principle applied to Discord sends (the `allowedMentions` guard is the thing that drifts).
- `signed-webhook-ingress-hardening-2026-05-29.md` / gateway anti-pattern: `allowedMentions: {parse: []}` on all Discord sends is a standing security rule.

## Key Technical Decisions

- **Two helper families in one module, surface-shaped.** `io.ts` exposes (a) a Message/Thread family for sends/replies plus a **separate** edit helper, and (b) an interaction family for replies/edits. They share the `allowedMentions: {parse: []}` default + catch/log/Result core but differ in the discord.js method and target type. The message-send/reply target is a minimal "send-capable" shape (mirroring `streaming.ts` `SinkThread`, covering `Message.reply` + `Thread.send`); `Message.edit` does **not** fit that shape and gets its own helper/overload (confirmed by review — edit typing diverges from send/reply).
- **Interaction family is Effect-returning and broadly typed (R2).** The command handlers are `Effect.gen` + `Effect.tryPromise`; a `Promise<Result>` helper would force redundant `Effect.tryPromise` wrapping around an already-caught Result. So the interaction helper returns an **Effect** that composes directly. Its target is a **reply/edit-capable interaction type** (union/structural type covering `ChatInputCommandInteraction` AND the button interaction `program.ts` edits) — not `ChatInputCommandInteraction`-only (confirmed blocker: `program.ts`'s approval path edits a button interaction).
- **Mention-safe by default, no override (R7).** Every helper applies `{parse: []}`; there is **no escape-hatch parameter** in v1. Review verified no genuine intentional-ping site exists (`add-project:593` is plain text). Omitting the override removes the foot-gun where a caller could pass `parse: ['everyone']`. A future constrained override (explicit IDs only) can be added if a real ping need appears.
- **Return `Result`, never throw; redacted logging (R1/R6).** Helpers catch the Discord API error, log via the injected logger with **minimal/redacted context** (operation + thread/interaction id + sanitized error — never raw message content, embeds, or Discord payloads), and return `err`. Best-effort callers ignore/log-and-continue; callers needing the sent Message use the `ok` value. Preserves "reactions/status are secondary; API failures must not halt execution."
- **Preserve the #854 hanging-reply fix explicitly (R6).** `fro-bot.ts`'s `Effect.catchAll` that edits the already-deferred reply before re-failing migrates to the interaction edit helper: the catchAll calls the helper (Effect-returning, never throws), then re-fails. Unit 3 wires this exact path and a regression test pins it.
- **Migrate, don't rewrite.** Each site swaps its inline `.send({...allowedMentions})` / `safeReply` / raw `editReply` for the helper. Content, embeds, components, await-vs-void, and ephemeral flags are preserved exactly.
- **Enforce the boundary (R5).** Add a check (a test that greps the gateway source, or a lint rule) that fails if any `interaction.reply`/`editReply` or message/thread `.send`/`.reply`/`.edit` appears outside `io.ts` (allowlisting io.ts itself and any deliberately-excluded site such as reactions). This is the same centralize-then-enforce lesson as the S3-key-construction solution doc — a guard that isn't enforced drifts back out.

## Open Questions

### Resolved During Planning

- Scope: both surfaces (Message + interaction) in one plan; user-confirmed.
- **No escape hatch in v1** — verified no genuine ping site (`add-project:593` is plain text); a generic override would be a foot-gun.
- **Interaction family is Effect-returning** (not `Promise<Result>`) — the handlers are `Effect.gen`; resolved to avoid redundant wrapping.
- **Interaction target type is widened** beyond `ChatInputCommandInteraction` to cover `program.ts`'s button interaction.
- **`Message.edit` is a separate helper** from send/reply (typing diverges).
- **Already-correct sites are left alone; `reactions.ts` is out** — firm, not per-site.
- The three duplicate local helpers are consolidated.

### Deferred to Implementation

- Exact helper names + the precise structural/union type for the interaction target (match discord.js typings for ChatInput + button interactions).
- Whether `add-project.ts`'s inline logger needs an adapter to satisfy `GatewayLogger` or can pass its gateway logger directly.
- The exact form of the boundary check (grep-in-test vs lint rule) — both satisfy R5.

## Implementation Units

- [x] **Unit 1: `discord/io.ts` module — the fail-soft helpers**

**Goal:** Create the single module with both helper families (Message/Thread send+reply + separate edit; interaction reply/edit), mention-safe by default (no override), catch+log+Result, redacted error context.

**Requirements:** R1, R2, R6, R7

**Dependencies:** None

**Files:**
- Create: `packages/gateway/src/discord/io.ts`
- Test: `packages/gateway/src/discord/io.test.ts`

**Approach:**
- Core: each helper builds options with `allowedMentions: {parse: []}` (no override param), calls the discord.js method in try/catch, logs failures via `GatewayLogger` with redacted context (operation + target id + sanitized error, never raw content/payload), returns `Result<Message | void, Error>` (ok carries the sent/edited Message where the API returns one).
- Message family: a send/reply helper targeting a minimal send-capable shape (mirror `streaming.ts` `SinkThread`, covers `Thread.send` + `Message.reply`), and a **separate** edit helper for `Message.edit` (typing diverges).
- Interaction family: **Effect-returning** helpers (`reply`/`edit`) targeting a reply/edit-capable interaction type broad enough for `ChatInputCommandInteraction` AND the button interaction `program.ts` uses.
- Mirror the guard invariant from `streaming.ts` (agent/interpolated text can never ping).

**Patterns to follow:** `streaming.ts` `safeSend` (guard + SinkThread typing), `status-message.ts` (catch+log best-effort shape), `GatewayLogger` from `discord/client.ts`, `Result` and `Effect` usage across the gateway.

**Test scenarios:**
- Happy path: send/reply/edit returns `ok` with the Message; `allowedMentions: {parse: []}` is on every call (assert the passed options).
- Error path: the discord.js call rejects → helper catches, logs via the logger with redacted context (assert warn/error called; assert the log payload does NOT include raw content), returns `err`, does NOT throw.
- Interaction family: the Effect-returning reply/edit defaults the guard, yields a Result, and composes inside an `Effect.gen` without `Effect.tryPromise` wrapping (assert the Effect resolves to `err` on failure rather than dying).
- Edge: helper never throws/rejects regardless of API outcome (assert no rejection in any branch).
- Edge: no override param exists (the guard cannot be opted out) — type-level/structural assertion that callers can't pass `allowedMentions`.

**Verification:** `io.ts` exports the message send/reply + edit helpers and the Effect-returning interaction helpers; all default the guard with no opt-out, return Result/Effect-of-Result, never throw, log redacted; unit tests cover happy/error/edge for each.

- [x] **Unit 2: Migrate the Message/Thread surface + remove the 3 duplicate helpers**

**Goal:** Replace `streaming.ts` `safeSend`, `run.ts` `safeSend`/`safeReply`, `mentions.ts` `safeReply` and their callers with `io.ts`; delete the local helpers.

**Requirements:** R3, R6

**Dependencies:** Unit 1

**Note on `run.ts`:** Units 2 and 3 BOTH modify `packages/gateway/src/execute/run.ts` (Unit 2 the message-send/reply helpers, Unit 3 the approval interaction send). They are therefore **serial: Unit 2 → Unit 3**, not parallel. Unit 1 may run before either.

**Files:**
- Modify: `packages/gateway/src/discord/streaming.ts`, `packages/gateway/src/execute/run.ts`, `packages/gateway/src/discord/mentions.ts`
- Modify (tests): `packages/gateway/src/discord/streaming.test.ts`, `packages/gateway/src/execute/run.test.ts`, `packages/gateway/src/discord/mentions.test.ts`

**Approach:**
- Swap each caller of the local helpers to the `io.ts` Message-family helper. Remove the now-dead local `safeSend`/`safeReply` definitions.
- Preserve await-vs-void: `run.ts`'s fire-and-forget approval/thread sends stay `void` (the helper returns a Result the void path ignores); awaited replies stay awaited.
- Keep the existing tests' guard assertions (the "can never ping" invariant) — now pointed at the io.ts helper.

**Patterns to follow:** existing caller shapes in each file; the streaming.ts guard-assertion tests.

**Test scenarios:**
- Happy path: each migrated caller still sends the same content with the guard (assert via the helper).
- Edge: `run.ts` approval send stays fire-and-forget (a helper `err` does not throw into the run flow).
- Regression: the streaming "never pings" invariant test still holds through io.ts.
- No remaining references to the removed local `safeSend`/`safeReply` (grep clean).

**Verification:** the 3 local helpers are gone; all callers use io.ts; gateway tests pass; the never-ping invariant is preserved.

- [x] **Unit 3: Migrate the command-interaction surface + apply the missing guard**

**Goal:** Route every `interaction.reply`/`editReply` site through the Effect-returning io.ts interaction helper, adding `allowedMentions: {parse: []}` where missing, preserving the #854 hanging-reply fix.

**Requirements:** R4, R6

**Dependencies:** Unit 1, **Unit 2** (shared `run.ts` — serial after Unit 2).

**Files:**
- Modify: `packages/gateway/src/discord/commands/add-project.ts`, `packages/gateway/src/discord/commands/fro-bot.ts`, `packages/gateway/src/discord/commands/ping.ts`, `packages/gateway/src/discord/commands/index.ts`, `packages/gateway/src/program.ts`, `packages/gateway/src/execute/run.ts` (approval interaction send if applicable)
- Modify (tests): the colocated `.test.ts` for each (`add-project.test.ts`, `fro-bot.test.ts`, command `index.test.ts`, plus program/run tests as touched)

**Approach:**
- Replace raw `interaction.reply/editReply({...})` with the Effect-returning io.ts interaction helper (defaults the guard). It composes directly inside the existing `Effect.gen` handlers — no `Effect.tryPromise` wrapper around it.
- `program.ts`'s button-interaction edits use the same helper (the widened interaction type covers it).
- **`fro-bot.ts` #854 catchAll:** the `Effect.catchAll` that edits the deferred reply before re-failing now calls the interaction edit helper, then re-fails. Behavior preserved exactly.
- `add-project.ts:593` ("try @fro-bot in #channel") goes through the helper with the default `{parse: []}` — it is plain text, so nothing changes visually. No override.
- `deferReply` calls are NOT wrapped (ack, not content). Ephemeral flags preserved.
- Preserve the unknown-command ack and ping behavior.

**Patterns to follow:** the existing `Effect.gen` command handlers; the #854 catchAll in `fro-bot.ts::executeForceReleaseLock`.

**Test scenarios:**
- Happy path: a representative `add-project` editReply and a `fro-bot` non-lock-outcome editReply now send with `allowedMentions: {parse: []}` (assert the option).
- Integration: `program.ts` button-interaction edit routes through the helper (assert the guard is applied on the button path).
- Error path / #854 regression: an interaction edit that rejects is caught by the helper (Effect yields `err`); the `fro-bot.ts` catchAll still edits the deferred reply with the internal-error message and re-fails — assert the deferred reply is NOT left hanging (pins the #854 fix).
- Regression: ephemeral replies stay ephemeral; the force-release-lock outcome replies (already had the guard) are unchanged in behavior; `add-project:593` still renders the same text.

**Verification:** all targeted interaction sites (incl. `program.ts` button path) route through io.ts with the guard; ephemeral/behavioral semantics preserved; the #854 fix has a passing regression test; gateway tests pass.

- [x] **Unit 4: Boundary enforcement — no raw Discord sends bypass io.ts**

**Goal:** Add a check that fails if gateway source reintroduces a raw `interaction.reply`/`editReply` or message/thread `.send`/`.reply`/`.edit` outside `io.ts`, so the guard can't drift back out (R5).

**Requirements:** R5

**Dependencies:** Units 2, 3 (the migration must be complete first, else the check fails on un-migrated sites).

**Files:**
- Create: `packages/gateway/src/discord/io.boundary.test.ts` (grep-the-source test) OR add an ESLint `no-restricted-syntax`/`no-restricted-properties` rule in the gateway eslint config — implementer picks; both satisfy R5.
- Modify (if lint route): the gateway ESLint config.

**Approach:**
- Enumerate the allowed locations (io.ts itself; any deliberately-excluded site — `reactions.ts` reaction calls, `status-message.ts`/`presence.ts`/`recovery.ts` if left as-is). The check scans `packages/gateway/src/**` for the raw call patterns and fails on any occurrence outside the allowlist.
- Keep the allowlist small and commented so a future deliberate exclusion is a visible, reviewed decision.

**Patterns to follow:** existing source-scanning tests in the repo (e.g. the harness workflow drift-guard test, the `dist/` hidden-unicode scan) for the grep-in-test approach.

**Test scenarios:**
- The check passes on the migrated tree.
- The check fails when a raw `interaction.editReply(` or thread `.send(` is added outside the allowlist (simulate via a fixture string or a temporarily-injected pattern in the test's own assertion logic).

**Verification:** the boundary check is green on the migrated code and demonstrably fails if a raw send is reintroduced; the allowlist is explicit and commented.

**Execution note:** Land this LAST — it depends on Units 2+3 having removed all the raw sites; running it earlier would fail on not-yet-migrated code.

## System-Wide Impact

- **Interaction graph:** touches most gateway Discord output paths; purely a send-mechanism swap, no control-flow change. The #854 hanging-reply fix (catchAll editing the deferred reply on failure) must be preserved — Unit 3 keeps that behavior.
- **Error propagation:** helpers convert throws into `Result.err` + log; best-effort callers continue, awaited callers decide. No new throws introduced.
- **State lifecycle risks:** none — no persistence touched.
- **API surface parity:** consolidates 3 helpers into 1 module; the never-ping invariant becomes the enforced default (Unit 4) rather than a per-site copy.
- **Sequencing:** Unit 1 first; Units 2→3 serial (shared `run.ts`); Unit 4 last (depends on the migration being complete).
- **Unchanged invariants:** message content/embeds/components, ephemeral flags, await-vs-void per site, deferReply acks, and the force-release-lock outcome replies all unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Interaction helper typed `ChatInputCommandInteraction`-only misses `program.ts`'s button-interaction edit | R2: the interaction target type is widened to a reply/edit-capable interaction covering both; Unit 3 has a `program.ts` button-path test. |
| A `Promise<Result>` helper composes awkwardly in the `Effect.gen` handlers | KTD: interaction family is Effect-returning; resolved in-plan, not deferred. |
| Migrating the interaction surface regresses the #854 hanging-reply fix or ephemeral semantics | Unit 3 wires the catchAll through the helper and pins it with a regression test; ephemeral preserved. |
| `Message.edit` forced into the send/reply shape | Separate edit helper (KTD + Unit 1). |
| A future raw send reintroduces the missing guard | Unit 4 boundary check fails CI on any raw send/reply/edit outside io.ts. |
| Over-migrating already-correct best-effort sites adds churn for no gain | Firm scope boundary: leave `status-message`/`presence`/`recovery` as-is; `reactions.ts` is out entirely. |

## Sources & References

- Oracle assessment (PR #854 follow-up): the duplication smell + safeSend/safeEdit extraction recommendation.
- Related code: `packages/gateway/src/discord/{streaming,mentions,status-message,reactions,presence,client}.ts`, `packages/gateway/src/discord/commands/{add-project,fro-bot,ping,index}.ts`, `packages/gateway/src/execute/run.ts`, `packages/gateway/src/program.ts`.
- Related learning: `docs/solutions/best-practices/centralize-s3-key-identity-construction-2026-06-09.md` (same centralize-to-prevent-drift principle).
- Follow-up B (deferred): `makeGuildCommand` pipeline (note #147).
