---
title: "fix: Operator launch route (POST /operator/runs) unmounted in production"
type: fix
status: active
date: 2026-06-25
---

# Operator launch route (POST /operator/runs) unmounted in production

## Overview

`POST /operator/runs` — the web operator launch route (the surface that lets an
authenticated operator launch a run from the dashboard) — is gated in
`buildOperatorApp` (`packages/gateway/src/web/server.ts`) on BOTH
`deps.getBindingByRepo` and `deps.launchWorkDeps` being present. The gateway boot
path (`packages/gateway/src/program.ts`) constructs the `OperatorServerDeps` passed
to `startOperatorServer` but **never sets either field**, so the route is never
registered and returns 404 in the deployed gateway. This is a live, pre-existing
production bug in the same class as #1001 (a route silently unmounted because a
runtime dep is not wired).

## Problem Frame

- `server.ts` registers `POST /operator/runs` only when the browser guard +
  `sessionStore` + `denylistCache` + `getBindingByRepo` + `launchWorkDeps` are all
  present (see the `buildOperatorApp` JSDoc and the launch-route mount gate).
- In `program.ts`, the operator `OperatorServerDeps` object wires `denylistCache`,
  `bindingsLookup`, `listBindings`, `runObservationManager`, `runIndex`,
  `approvalRegistry`, session/OAuth/CSRF — but NOT `getBindingByRepo` and NOT
  `launchWorkDeps`. The `OperatorServerDeps` type declares both as optional, so the
  omission compiled silently.
- Result: the launch route is absent from the running app's route table; the
  dashboard's launch action hits a 404.
- `getBindingByRepo` is available as `bindingsStore.getBindingByRepo`. The engine
  deps needed for `launchWorkDeps` (`RunMentionDeps`) are constructed today INSIDE
  the `messageCreate` handler as `mentionDeps` (per-message). The launch route does
  not need the per-message Discord context — `launchWork(request, deps.launchWorkDeps)`
  builds its own request from the HTTP call — so the message-INDEPENDENT engine deps
  must be hoisted/constructed once at program scope and passed as `launchWorkDeps`.

## Requirements Trace

- R1. `POST /operator/runs` registers in the running gateway when operator web is
  enabled (the route is present in `buildOperatorApp(...).routes`).
- R2. `getBindingByRepo` and `launchWorkDeps` are wired into the `OperatorServerDeps`
  the gateway passes to `startOperatorServer`, using the same engine deps the Discord
  mention path uses (no behavior divergence between Discord-launched and
  web-launched runs; the fail-closed approval gate constraint still holds).
- R3. A regression test proves the route mounts with the production wiring and is
  absent if `getBindingByRepo` or `launchWorkDeps` is dropped — so this class of
  unmount is caught going forward.

## Scope Boundaries

- No change to the launch route's behavior, auth, or the approval gate — only its
  registration wiring.
- No change to the Discord mention path's behavior.
- The image-level operator-route smoke (the `feat/operator-surface-unit8-tail`
  branch) is OUT of scope here — that branch rebases on this fix and removes its
  manual `getBindingByRepo`/`launchWorkDeps` injection afterward so it routes through
  the now-correct production wiring.

### Deferred to Separate Tasks

- Image-level operator-route smoke de-vacuuming: `feat/operator-surface-unit8-tail`
  (rebases on this fix).

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/web/server.ts` — `buildOperatorApp` launch-route mount gate
  (requires `getBindingByRepo` + `launchWorkDeps`); the JSDoc enumerating route gates.
- `packages/gateway/src/web/operator/launch-route.ts` — `LaunchRouteDeps`:
  `bindingsLookup.getBindingByRepo`, `launchWorkDeps: RunMentionDeps`,
  `sessionStore`, `isRepoDenied`, `repoAuthzDeps`, `idempotencyGuard`. The route
  resolves the binding server-side via `getBindingByRepo` and calls
  `launchWork(request, deps.launchWorkDeps)`.
- `packages/gateway/src/program.ts` — the operator `OperatorServerDeps` construction
  (missing the two fields) and the `messageCreate` handler's `mentionDeps`
  (`RunMentionDeps`) construction, which is the reference for the engine deps.
- `packages/gateway/src/discord/mentions.ts` — `handleMention` / `RunMentionDeps`
  consumer; confirms which deps are engine vs message-specific.
- `packages/gateway/src/web/server.test.ts` — the existing operator route-set
  registration test (it DOES wire `getBindingByRepo` + a stub `launchWorkDeps`, which
  is why the unit suite did not catch the production omission — note this when adding
  the regression test).

### Institutional Learnings

- This is the #1001 class: a route gated on a runtime dep that the program forgets to
  wire. The fix pattern is to wire the dep in the production deps construction and add
  a test that asserts the route's presence/absence keys off that exact dep.

## Key Technical Decisions

- **Hoist the message-independent engine deps.** `RunMentionDeps` is built
  per-message in `messageCreate` today. Identify the subset that is message-INDEPENDENT
  (engine/runtime deps: workspace client, run index, run observer, lock/coordination,
  isShuttingDown, logger, config, etc. — everything except the specific Discord
  message/channel context) and construct it once at program scope. Use it for the
  operator `launchWorkDeps`, and (ideally) have the `messageCreate` handler reuse the
  same hoisted engine deps so the two paths cannot diverge. If full reuse is too
  invasive, construct the engine deps once and spread message context in the Discord
  path; do NOT duplicate the engine wiring.
- **`getBindingByRepo` is a direct passthrough** of `bindingsStore.getBindingByRepo`
  (bind for `this` if needed, mirroring the `listBindings` pattern already present).
- **Preserve the fail-closed approval gate.** Web-launched runs must route through the
  same approval path as Discord (the launch route's `launchWork` already enforces
  this via `launchWorkDeps`); wiring the same engine deps preserves it.

## Open Questions

### Resolved During Planning

- Where do `getBindingByRepo`/`launchWorkDeps` come from? `getBindingByRepo` =
  `bindingsStore.getBindingByRepo`; `launchWorkDeps` = the message-independent
  `RunMentionDeps` engine deps currently built inline in `messageCreate`.

### Deferred to Implementation

- The exact field-by-field split of `RunMentionDeps` into message-independent (hoist)
  vs message-specific (stays in `messageCreate`). Trace the actual `mentionDeps`
  object and `RunMentionDeps`/`launchWork` to determine it. The test is the gate:
  Discord mention behavior must be unchanged and the launch route must mount.

## Implementation Units

- [ ] **Unit 1: Wire getBindingByRepo + launchWorkDeps into the operator server deps**

**Goal:** `POST /operator/runs` registers in the running gateway; the launch route
receives the same engine deps the Discord mention path uses.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `packages/gateway/src/program.ts`
- Test: `packages/gateway/src/program.test.ts` (and/or `web/server.test.ts` if the
  registration assertion fits better there)

**Approach:**
- Trace the `mentionDeps` (`RunMentionDeps`) construction in the `messageCreate`
  handler. Extract the message-INDEPENDENT engine deps into a value built once at
  program scope (before/independent of the operator deps construction). Prefer having
  the Discord handler reuse this hoisted value (spreading only the per-message context)
  so Discord and web launch share one engine-deps source and cannot diverge.
- Set `getBindingByRepo: bindingsStore.getBindingByRepo.bind(bindingsStore)` (or
  direct reference if no `this` dependency — match the `listBindings` treatment) and
  `launchWorkDeps: <hoisted engine deps>` on the `OperatorServerDeps` passed to
  `startOperatorServer`.
- Verify the launch route's other required deps (`sessionStore`, `denylistCache`,
  `bindingsLookup`, browser guard pieces) are already present (they are — only the two
  fields are missing).

**Execution note:** test-first — write a failing test asserting `POST /operator/runs`
is in the operator app's route set under production-shaped wiring before fixing, and
a test that dropping `getBindingByRepo` or `launchWorkDeps` removes the route.

**Patterns to follow:** the existing `listBindings` wiring in the operator deps
(the same "distinct dep gates a distinct route" comment pattern); the `mentionDeps`
construction for the engine-deps shape.

**Test scenarios:**
- Happy path: with production-shaped operator deps (all wired), `buildOperatorApp`
  (or the program's operator deps fed to it) registers `POST /operator/runs`.
- Regression guard: dropping `getBindingByRepo` → `POST /operator/runs` absent;
  dropping `launchWorkDeps` → `POST /operator/runs` absent. (This is the #1001-class
  guard for the launch route specifically.)
- Discord parity: the `messageCreate`/`handleMention` path still receives an
  equivalent `RunMentionDeps` (the hoist did not change Discord behavior) — assert the
  engine deps the mention path uses are unchanged in shape.

**Verification:** `POST /operator/runs` is present in the operator app route set with
production wiring; absent when either new dep is dropped; the Discord mention path is
behavior-unchanged; gateway type-check, tests, lint clean; gateway-only (no root dist
drift).

## System-Wide Impact

- **Interaction graph:** the launch route now actually reaches `launchWork` with the
  engine deps — the same path Discord mentions use. The approval gate, lock/coordination,
  run index, and run observer must all be the same instances the Discord path uses so
  web and Discord launches share run-state/coordination (no second copies).
- **Unchanged invariants:** the launch route's auth, CSRF, denylist-before-authz,
  idempotency, and fail-closed approval behavior are unchanged — only its registration
  wiring is fixed. The Discord mention path behavior is unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Hoisting `RunMentionDeps` engine deps changes Discord mention behavior | Have the Discord handler reuse the hoisted engine deps (spread per-message context only); add/keep a test asserting the mention path's deps are unchanged in shape. |
| Web and Discord launches use different run-index/coordination instances | Wire the SAME program-scoped instances (runIndex, runObservationManager, lock store, etc.) into both — do not construct second copies. |
| `getBindingByRepo` `this`-binding | Mirror the existing `listBindings.bind(bindingsStore)` treatment. |

## Sources & References

- Related code: `packages/gateway/src/program.ts`,
  `packages/gateway/src/web/server.ts`,
  `packages/gateway/src/web/operator/launch-route.ts`,
  `packages/gateway/src/discord/mentions.ts`,
  `packages/gateway/src/web/server.test.ts`.
- Class precedent: #1001 (operator route unmounted because a dep was not wired).
- Follow-on: `feat/operator-surface-unit8-tail` (image-level smoke that rebases on
  this fix and removes its manual dep injection).
