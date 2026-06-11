---
title: "refactor: Shared guild-command pipeline (makeGuildCommand)"
type: refactor
status: active
date: 2026-06-10
deepened: 2026-06-10
---

# refactor: Shared guild-command pipeline (makeGuildCommand)

## Overview

Extract the repeated `/fro-bot` subcommand entry skeleton — guild-null guard → deferReply → authorization → work → failure-path reply — into a single `makeGuildCommand` factory in `packages/gateway/src/discord/commands/guild-command.ts`. The three guild-bound subcommands (`add-project`, `clear-queue`, `force-release-lock`) migrate onto it; `ping` (no guard/defer/auth) stays as-is.

This is the second of the two duplication follow-ups identified during the operator-commands review (the first was the `discord/io.ts` centralization). Beyond deduplication, the pipeline gives every guild command the deferred-reply failure protection that currently only `force-release-lock` has: an infrastructure failure in any handler edits the deferred ephemeral reply with a generic internal-error message before re-failing, instead of leaving the user at "thinking…" until the interaction token expires.

## Goals

- One owner for the guild-command entry sequence; a new subcommand cannot forget the guard/defer/auth ordering or the failure-path reply. (The factory is justified by real upcoming consumers, not hypotheticals: `/fro-bot sessions`, `/resume`, and `/review` are already-deferred guild commands from the operator-commands scoping — 3 sites today, ~6 on the roadmap.)
- Auth policies stay explicitly parameterized — the three commands have genuinely different gates by design, and the pipeline must not flatten them.
- Behavior is preserved except for exactly two deliberate, named deltas: (1) `clear-queue` and `add-project` gain the catchAll hanging-reply protection; (2) `add-project` moves to guard-before-defer (see KTDs). Same replies, same auth outcomes, same test contracts otherwise.

## Non-Goals

- Migrating `ping` (no skeleton to share).
- Normalizing `runAddProject`'s internal phase orchestration to Effect.gen — its plain-async body stays; only its entry sequence moves into the pipeline.
- Changing any auth policy, reply copy, or ephemeral behavior.
- Touching the mention path or `program.ts` button handling.

## Current State (verified 2026-06-10, main fdfd5f5)

- `packages/gateway/src/discord/commands/index.ts:11-14` — `SlashCommand = {data, execute}`, `execute(interaction): Effect<void, Error>`; `dispatchCommand` acks unknown commands and logs failures.
- `fro-bot.ts:90-145` — parent command routes subcommands via `getSubcommand(true)`.
- `clear-queue` (`fro-bot.ts:162-199`): guild-null guard with immediate ephemeral reply (pre-defer) → `deferReply({ephemeral: true})` → `userIsAuthorized(guild, userId, triggerRoleId, log)` post-defer (trigger role OR ManageChannels; denial edits the deferred reply) → work → editReply. Plain async in `Effect.tryPromise`. No failure-path reply.
- `force-release-lock` (`fro-bot.ts:228-405`): guild-null guard → defer → direct `guild.members.fetch()` + `permissions.has(ManageChannels)` (deliberately stricter; trigger-role-only denied) → work → outcome mapping; outer `Effect.catchAll` edits the deferred reply then re-fails (the hanging-reply fix). Effect.gen.
- `add-project` (`add-project.ts:215-771`): rate-limit check (before defer, replies ephemerally on limit) → defer → shutdown gate → guild-null guard → bot-permission gate (`interaction.appPermissions`) → `userIsAuthorized(guild, userId, logger)` → long phase orchestration with many editReply exits. Plain async in `Effect.tryPromise`. No failure-path reply.
- All Discord replies already flow through `discord/io.ts` helpers (mention-safe, fail-soft).

Exact entry orderings today (the pipeline must reproduce these slots precisely):

- `clear-queue` / `force-release-lock`: guild-null guard (immediate ephemeral reply, pre-defer) → defer → auth (post-defer; denial edits the deferred reply) → work.
- `add-project`: rate limit (pre-defer; immediate ephemeral reply on limit) → defer → shutdown gate → guild-null guard (edits deferred reply) → bot-permission gate → user auth → work.

Pipeline canonical order: `preDefer` hook (rate limit; immediate ephemeral reply, runs before everything) → guild-null guard (immediate ephemeral reply, pre-defer) → defer → auth policy (post-defer) → work. For `add-project` this means the guild-null guard moves from post-defer to pre-defer (deliberate delta 2), and the shutdown gate + bot-permission gate stay inside its `authorize`/`work` boundary: shutdown gate runs as the first step of `work`; bot-permission + user auth compose into its `authorize` policy.

## Key Technical Decisions

- **Pipeline shape — dispatch unchanged.** `makeGuildCommand(spec, deps)` closes over deps and returns a `(interaction) => Effect<void, Error>` executor invoked by the existing parent-command subcommand router; `SlashCommand.execute` and `dispatchCommand` are not modified. The pipeline owns: optional `preDefer` hook → guild-null guard + immediate ephemeral server-only reply → `deferReply({ephemeral: true})` → auth policy (denial edits the deferred reply) → `work` → shared `Effect.catchAll` (defer-onward scope) that edits the deferred reply with the generic internal-error copy and re-fails.
- **One spec contract (stated once, used everywhere):** `{name, authorize, work, preDefer?, denialCopy?, serverOnlyCopy?}` — the two copy fields default to the existing shared strings; commands with bespoke denial copy supply it. Nothing else goes on the spec: logging is derived from `name` (`withLogContext`), and the failure policy is pipeline-owned, not configurable.
- **Work functions MUST return an Effect — the factory normalizes all failure lanes.** `work: (ctx) => Effect<void, Error>` is the only contract. The factory invokes it inside `Effect.suspend` so synchronous throws during Effect construction, rejected promises (via the caller's own `Effect.tryPromise`), and `Effect.fail` all funnel into the same pipeline catchAll. `force-release-lock`'s Effect.gen body converts naturally; `clear-queue`'s small async body wraps in `Effect.tryPromise` inside its work function; `add-project` passes `Effect.tryPromise(() => runAddProjectPhases(...))` — its 500-line phase body is untouched, it just loses its hand-rolled entry sequence.
- **Auth is a parameterized policy, not a unified gate.** `authorize(ctx) => Effect<AuthDecision>` per command: `clear-queue` keeps `userIsAuthorized` (trigger role OR ManageChannels); `force-release-lock` keeps the direct ManageChannels-only check; `add-project` composes its bot-permission gate + `userIsAuthorized` into one policy. Denial copy comes from the spec's `denialCopy` (or the decision when a command needs per-denial messages). The pipeline only owns the *sequencing* (auth runs after defer, denial edits the deferred reply, fail-closed on auth errors).
- **The catchAll is the pipeline's.** The shared failure path reproduces `force-release-lock`'s current semantics exactly: scope it around defer-onward work only (guild-null guard replies are outside it — no double-reply), edit the deferred reply via `editInteraction` with the generic internal-error copy, then re-fail so `dispatchCommand` still logs. `clear-queue` and `add-project` gain this behavior (a deliberate, small behavior improvement — documented in the PR).
- **Guard-before-defer standardization (deliberate delta 2).** `add-project` currently defers before its guild-null guard; the pipeline guards first (immediate ephemeral reply, matching the other two). This is a named behavior change, not a pure refactor: the user-visible difference is nil (ephemeral either way), but interaction call ordering changes, and add-project tests asserting defer-then-guard update to guard-then-defer. Called out in the PR body.
- **Scoped log context stays per-command.** The pipeline builds `withLogContext(deps.gatewayLogger, {command: spec.name})` once and threads it to auth/work, replacing the three hand-rolled call sites.

## Implementation Units

- [ ] **Unit 1: `makeGuildCommand` factory + tests**
  - New `packages/gateway/src/discord/commands/guild-command.ts`: spec type (`{name, authorize, work, preDefer?, denialCopy?, serverOnlyCopy?}`), the pipeline `Effect`, shared catchAll, scoped logger construction.
  - TDD: tests pin ordering (guard → defer → auth → work), denial path edits deferred reply, catchAll edits-then-refails on work failure, preDefer short-circuit, guild-null immediate ephemeral reply, fail-closed auth errors.
  - Gate: new tests + `tsc` + lint green.

- [ ] **Unit 2: migrate `clear-queue` + `force-release-lock`** (after Unit 1)
  - Rewrite both subcommand executors in `fro-bot.ts` as `makeGuildCommand` specs; delete the hand-rolled skeletons and `force-release-lock`'s local catchAll (now pipeline-owned).
  - Behavior contract: every existing test in `fro-bot.test.ts` (defer/auth/guild-null/outcome mapping/catchAll) passes unchanged or with mechanical-only updates; `clear-queue` gains a catchAll test.
  - Gate: full `fro-bot.test.ts` + dispatch-path tests in `index.test.ts` green.

- [ ] **Unit 3: migrate `add-project` entry** (after Unit 2)
  - Map add-project's entry checks onto the pipeline slots: `preDefer` = rate limit; guild-null guard moves pre-defer (delta 2); `authorize` = bot-permission gate + `userIsAuthorized`; shutdown gate becomes the first step of `work`; the phase orchestration body becomes the work function unchanged.
  - Update add-project tests for guard-before-defer ordering; add the gained-catchAll test.
  - Owns the Verification grep: assert no hand-rolled `deferReply` entry skeletons remain in the three migrated commands outside `guild-command.ts` (add as a small structural test or a verification step in this unit).
  - Gate: full gateway suite + types + lint green; boundary test still green.

## Scope Boundaries

**In scope:** `guild-command.ts` (new), `fro-bot.ts`, `add-project.ts`, their tests, `packages/gateway/AGENTS.md` (one-line module note).
**Out of scope:** `ping.ts`, `index.ts` dispatch, `program.ts`, mention path, io.ts, any auth policy or reply copy change.

## Risks

| Risk | Mitigation |
| --- | --- |
| Pipeline subtly reorders add-project's entry checks (rate limit/shutdown/permissions) | Unit 3 maps each existing check to an explicit pipeline slot; tests pin the sequence; deviation only where documented (guard-before-defer) |
| Shared catchAll double-replies on paths that already replied | catchAll scoped defer-onward, mirroring the proven force-release-lock structure; guard replies outside it |
| Auth policy flattening regresses the deliberate strictness split | Policies are per-command functions passed into the spec; tests pinning trigger-role-denied (force-release-lock) and trigger-role-allowed (clear-queue) must pass unchanged |
| Effect/async impedance in add-project | Its body stays async behind one `Effect.tryPromise`; only the entry moves |

## Verification

- Full gateway suite green (incl. unchanged auth/outcome/dispatch contracts in `fro-bot.test.ts`, `add-project.test.ts`, `index.test.ts`).
- `tsc --noEmit`, eslint 0 errors.
- Grep: no hand-rolled `deferReply` entry skeletons remain in the three migrated commands outside the pipeline.
