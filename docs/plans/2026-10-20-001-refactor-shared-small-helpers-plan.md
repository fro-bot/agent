---
title: "refactor: share the remaining small helpers between the Action and the gateway"
type: refactor
status: active
date: 2026-10-20
origin: docs/brainstorms/2026-10-18-action-gateway-consolidation-requirements.md
---

# refactor: share the remaining small helpers between the Action and the gateway

## Overview

This is the last cheap rung of the consolidation ladder. Most small duplicates are already gone: rung 1 (#1869), rung 2 (#1872), config block 1 (#1883) and #1877 moved them into `@fro-bot/runtime`. What remains is a short list of identical copies. Each moves to a single home, except the `acquire-lock` delay, which stays local by design. Every caller behaves as it does today. The proof is that the existing suites pass with no edits to existing test files.

## Problem Frame

Three kinds of copies are still live.

- **Cross-surface.**
  - Five local sleep or delay copies sit beside an unused runtime `sleep`. Four of them move; the `acquire-lock` copy stays local.
  - The gateway hard-codes `'1800000'` while runtime exports `DEFAULT_TIMEOUT_MS`.
- **The entity-ref repo parser.** It has three identical gateway copies: `route-helpers.ts`, `surface-gate.ts` and `run-summary.ts`. This parser feeds the repo-access gate, so drift between the copies is an authorization risk. Runtime already owns the `entity_ref` format.
- **Gateway-internal copies.**
  - Five logger-adapter wrappers.
  - Two `isValidSha` / `SHA_RE` pairs.
  - Two identical `formatBytes` helpers in the Discord recovery commands.
  - Four stale comments that rung 2 missed. One names a function that does not exist, and one claims a deduplication that did not happen.

## Requirements Trace

- **R1.** One runtime `parseEntityRefRepo` for `owner/repo#n` entity refs. The three gateway copies delegate to it with identical results.
- **R2.** The four sleep/delay copies use runtime `sleep`. Zero-delay and non-negative behaviour at each call site is unchanged. The `acquire-lock.ts` copy stays local because it calls `unref`.
- **R3.** Gateway config uses runtime `DEFAULT_TIMEOUT_MS` for the run-timeout default.
- **R4.** The gateway has one logger adapter, one SHA validator and one binary-bytes formatter. The copies are deleted.
- **R5.** The stale comments are fixed: `reply-delivery.ts:13`, `run-core.ts:268-274`, `maintenance-run.ts:28` and `route-helpers.ts:4`.
- **R6.** The requirements doc marks config block 1 (#1883) and this rung as delivered. Rung 2 is already marked. It amends R7 and the "Ladder, low priority" row, marks the "mirrors exactly" success criterion done, records the two follow-ups as #1885 and #1886, and annotates the stale inventory rows (row 15, Callout B, Top-5 #2).
- **R7.** No behaviour change. Existing test files are not edited, and the new runtime test is additive.

## Scope Boundaries

These are out of scope, each tracked or decided elsewhere:

- **Inline error-message extraction** (about 86 sites) → #1885. It changes behaviour when `String(error)` throws.
- **owner/repo string parsers** (eight variants) → #1886. Any single contract changes behaviour on at least one surface. `parseEntityRefRepo` keeps today's entity-ref contract only: strip `#…`, split on the first `/`.
- **Gateway trust predicate.** It is security-adjacent and gets its own PR.
- **Truncate and duration formatters.** Their output is pinned by tests and the divergence is intentional.
- **Runtime `formatBytes`.** Its output (`12B`, `KB`) differs from the gateway's (`12 B`, `KiB`) and operators see it. The gateway pair merges within the gateway only.
- **GitHub App token minting and redaction wrappers.** They are not viable small-helper merges because their credential and trust models differ (R6 amends the requirements doc to say so).
- **Workspace-agent helpers.** They are a separate deploy unit and trust boundary.
- **Abort/settle and lease renewal.** These are separate planned rungs.

## Context & Research

Research: `/tmp/plan-rung4/repo.md`.

- **`sleep` family.**
  - Runtime `shared/async.ts` `sleep` throws on a negative, `NaN` or infinite delay. It has its own test and no production consumer.
  - Runtime `agent/server.ts:21` `delay` has one caller, `pollIntervalMs`, which defaults to `DEFAULT_SHUTDOWN_QUIESCE_POLL_INTERVAL_MS`.
  - Action `harness/phases/execute.ts:568` has one caller, which clamps with `Math.max(0, Math.min(...))`.
  - Action `services/cache/checkpoint.ts:74` has two callers, both using `retryDelayMs`, which defaults to `DEFAULT_RETRY_DELAY_MS`.
  - Action `harness/phases/coordination-decline.ts:40` returns early for `ms <= 0`.
  - Action `acquire-lock.ts:143` calls `unref` on its timer, so it stays local.
- **Entity-ref trio.** All three copies strip `#…` and split on the first `/`, returning null for a missing slash or an empty owner or repo. `route-helpers` uses `split('#')[0]` and the other two use `indexOf('#')`, with the same output. `resolveRepoFromRunIndex` has six route callers.
- **Logger adapters.** Each adapter is `(ctx, msg) → (msg, ctx ?? {})`, exposing 1, 2 or 4 methods.
  - `run-core.ts:275` and `settle-owned-sessions.ts:102` both have four methods and are identical.
  - `run.ts:416` (exported) and `maintenance-run.ts:29` both have two methods and are identical.
  - `recovery.ts:68` has one method.
  - `cancel.ts` imports `toCoordLogger` from `run.ts`.
- **SHA validation.** `workspace-api/client.ts:738-740` and `operator-contract/provenance.ts:98-104` both match `/^[0-9a-f]{40}$/` after a `typeof` check.
- **Bytes formatting.** `discord/commands/recover-checkout.ts:43` and `checkout-backup.ts:46` are identical and never throw.
- **Precedent.** `docs/solutions/best-practices/extract-timer-primitive-keep-policy-per-surface-2026-07-13.md` (shared primitive, per-surface policy). The rung 2 plan `docs/plans/2026-10-19-001-refactor-shared-payload-helpers-plan.md` set the same zero-test-edit proof.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "packages/runtime/src/shared, packages/runtime/src/coordination, packages/runtime/src/agent/server.ts, src/harness/phases, src/services/cache, packages/gateway/src",
  "freshness": {
    "vcs_reference": "423fa2f96"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 10,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "packages/runtime/src/shared/async.ts sleep",
      "description": "Runtime sleep with input guards, currently unused in production",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "packages/runtime/src/shared/constants.ts DEFAULT_TIMEOUT_MS",
      "description": "Runtime default run timeout (1800000)",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "packages/runtime/src/coordination/types.ts entity_ref",
      "description": "Runtime owns the entity_ref field; no parser exists yet",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/runtime/src/shared/format.ts formatBytes",
      "description": "Runtime byte formatter used by Action attachments",
      "disposition": "insufficient",
      "insufficiency_reason": "Different, operator-visible output (no space, KB/MB) and throws on bad input; the gateway pair keeps its own format"
    },
    {
      "path_or_symbol": "packages/runtime/src/shared/errors.ts toErrorMessage",
      "description": "Runtime error-message helper",
      "disposition": "insufficient",
      "insufficiency_reason": "Moving the inline sites changes behaviour when String() throws; tracked as #1885, out of this rung"
    }
  ]
}
```

## Key Technical Decisions

- **The entity-ref parser lives in runtime.** It goes in `packages/runtime/src/coordination/entity-ref.ts` as `parseEntityRefRepo(entityRef: string): {readonly owner: string; readonly repo: string} | null`, exported by name from `coordination/index.ts`. Runtime owns the field, and the parser gates repo access, so one definition guards it against drift. `resolveRepoFromRunIndex` stays in the gateway and only its body changes; it parses `RunIndex` `location.repo`, which has the same `owner/repo#n` shape. This is an exception to origin R1's "both surfaces switch in the same PR": the Action has no entity-ref consumer, so only the gateway switches.
- **Sleep guards move to the call sites that need them.** Runtime `sleep` throws on negative, `NaN` or infinite input. Today `coordination-decline`'s guard lives inside its local helper. The move adds `if (delayMs > 0) await sleep(delayMs)` inside the `applyBlockedLabel` backoff loop. It skips the await and does not `return`, so restore retries still run. `restoreBackoffMs` is a public option, so this guard also keeps a caller-supplied negative entry from throwing. The other three callers pass known finite, non-negative values (read during review): `server.ts` `pollIntervalMs` defaults to 100, `checkpoint.ts` `retryDelayMs` to 200 with no `src` override, and `execute.ts` clamps a value derived from `DEFAULT_DRAIN_POLL_INTERVAL_MS` (250). They need no extra guard.
- **The `acquire-lock` delay stays local.** It calls `unref` on its timer on purpose. A one-line comment says so. An `{unref}` option on runtime `sleep` would be new API and is not needed here.
- **The gateway helpers stay in the gateway.**
  - **Logger adapter:** `execute/runtime-logger.ts` exports `toRuntimeLogger`, the four-method adapter from `run-core.ts:275`. It depends on `GatewayLogger`, so it cannot live in runtime. Its result is structurally assignable to the 1- and 2-method shapes. `toCoordLogger` stays as an exported alias only if a call-site type needs the narrower name.
  - **SHA validator:** `workspace-api/sha.ts` exports `SHA_RE` and `isValidSha`.
  - **Bytes formatter:** the merged helper is `formatBinaryBytes`. The new name keeps it from being confused with runtime `formatBytes`.
- **Imports.** Gateway files import runtime values directly from `@fro-bot/runtime`, as `execute/settle-owned-sessions.ts` does. Action files use runtime `sleep` through the existing `src/shared/async.ts` re-export.
- **`dist/` is rebuilt per commit.** Runtime is bundled into the Action, so the orchestrator rebuilds `dist/` after every unit that touches runtime or `src/`. Unit 1 should leave `dist/` unchanged, and Unit 2 changes it.

## Open Questions

### Deferred to Implementation

- **Adapter test spies:** whether any test spies on a specific adapter name. Research found no test imports. If one does, point it at the new module without changing its assertions.

## Implementation Units

- [ ] **Unit 1: Runtime entity-ref parser**

**Goal:** One `parseEntityRefRepo` in runtime, called by the three gateway copies.

**Requirements:** R1, R5 (the `route-helpers.ts:4` header), R7

**Dependencies:** None

**Files:**

- Create: `packages/runtime/src/coordination/entity-ref.ts`, `entity-ref.test.ts`
- Modify: `packages/runtime/src/coordination/index.ts`, `packages/gateway/src/web/operator/route-helpers.ts`, `packages/gateway/src/redaction/surface-gate.ts`, `packages/gateway/src/operator-contract/run-summary.ts`
- Check: `dist/` after rebuild (expected unchanged)

**Approach:** Copy the current semantics exactly: strip everything from the first `#`, then split on the first `/`. The three gateway functions keep their names and signatures and delegate. Fix the `route-helpers.ts` header so it no longer claims the logic is deduplicated there.

**Test scenarios** (new runtime test):

| Input             | Result                                      |
| ----------------- | ------------------------------------------- |
| `owner/repo`      | `{owner, repo}`                             |
| `owner/repo#12`   | strips `#12`                                |
| `owner/repo#12#x` | strips from the first `#`                   |
| `owner/repo#`     | `{owner: 'owner', repo: 'repo'}`            |
| `/repo`           | null                                        |
| `owner/`          | null                                        |
| `owner`           | null                                        |
| `a/b/c`           | `{owner: 'a', repo: 'b/c'}`, matching today |
| `''`              | null                                        |

**Verification:** The runtime test passes. The gateway route, redaction and run-summary suites pass unchanged.

- [ ] **Unit 2: Sleep family and default timeout**

**Goal:** Runtime `sleep` replaces the four local copies, and gateway config uses `DEFAULT_TIMEOUT_MS`.

**Requirements:** R2, R3, R7

**Dependencies:** None

**Files:**

- Modify: `packages/runtime/src/agent/server.ts`, `src/harness/phases/execute.ts`, `src/services/cache/checkpoint.ts`, `src/harness/phases/coordination-decline.ts`, `src/harness/phases/acquire-lock.ts` (comment only), `packages/gateway/src/config.ts`
- Modify: `dist/` (orchestrator rebuild)

**Approach:**

- Delete each local `delay`/`sleep` and import runtime `sleep`. Inside runtime, import from `../shared/async.js`.
- `coordination-decline`: in the backoff loop, `if (delayMs > 0) await sleep(delayMs)`. Do not add a `return`.
- `acquire-lock`: keep the local `unref` delay and add a one-line comment saying why.
- Gateway config: replace the `'1800000'` default with `String(DEFAULT_TIMEOUT_MS)`, using `import {DEFAULT_TIMEOUT_MS} from '@fro-bot/runtime'`.

**Test scenarios:** No new tests. The existing Action harness, cache and runtime server suites cover these callers and must pass unchanged. `coordination-decline-restamp.test.ts` already exercises `restoreBackoffMs: [0, 0]` and expects the retry to succeed, which pins the zero-delay path.

**Verification:** `src/harness`, `src/services/cache`, runtime and gateway config tests pass with no edits.

- [ ] **Unit 3: Gateway-internal helpers and stale comments**

**Goal:** The gateway has one logger adapter, one SHA validator and one binary-bytes formatter. The stale "mirrors" comments are fixed.

**Requirements:** R4, R5, R7

**Dependencies:** None

**Files:**

- Create: `packages/gateway/src/execute/runtime-logger.ts` (`toRuntimeLogger`), `packages/gateway/src/workspace-api/sha.ts` (`SHA_RE`, `isValidSha`), `packages/gateway/src/discord/commands/format-binary-bytes.ts` (`formatBinaryBytes`)
- Modify: `execute/run-core.ts`, `execute/settle-owned-sessions.ts`, `execute/run.ts`, `execute/cancel.ts`, `execute/recovery.ts`, `discord/maintenance-run.ts`, `execute/reply-delivery.ts` (comment), `workspace-api/client.ts`, `operator-contract/provenance.ts`, `discord/commands/recover-checkout.ts`, `discord/commands/checkout-backup.ts`

**Approach:**

- Move each body as it is.
- Keep `ctx ?? {}` and the argument order.
- `cancel.ts` imports from the new module.
- Delete the copies.
- Rewrite or remove the stale comments so they state current facts.

**Test scenarios:** No new tests unless a module has no coverage after the move. The existing suites cover all callers.

**Verification:** The gateway full suite passes with no edits to existing test files.

- [ ] **Unit 4: Requirements doc**

**Goal:** The consolidation requirements doc matches the current state.

**Requirements:** R6

**Dependencies:** Units 1-3

**Files:**

- Modify: `docs/brainstorms/2026-10-18-action-gateway-consolidation-requirements.md`, and annotate the inventory doc beside it

**Approach:**

- Mark config block 1 (#1883) and this rung as delivered in the disposition table. Rung 2 is already marked.
- In R7 and the "Ladder, low priority" row, say why GitHub App minting and the redaction wrappers are not small-helper merges.
- Link #1885 and #1886.
- Mark the "mirrors exactly" success criterion done.
- Annotate the stale inventory rows (row 15, Callout B, Top-5 #2) with the PR that changed them.

**Verification:** Prettier, the link check and the prior-art schema check pass.

## System-Wide Impact

- **Action bundle:** `dist/` changes for the sleep moves, and the Action bundle is rebuilt. The entity-ref parser should not reach the Action entry. If `dist/` changes because of it, I investigate before merging.
- **Operator-visible output:** unchanged. The bytes formatter keeps its gateway format, and log messages keep their argument order.
- **Repo-access gate:** same results through one parser.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| A sleep caller passes `NaN` or a negative value, and runtime `sleep` throws where the local copy waited 0 | Confirm the input ranges per caller in Unit 2, and keep a call-site guard where a range isn't provable |
| Entity-ref behaviour drifts during the move | The runtime test pins every edge case, including `a/b/c` → `b/c` and `owner/repo#` |
| The logger-adapter consolidation breaks a narrower call-site type | Export a structurally compatible alias. `check-types` gates it |

## Sources & References

- Origin: `docs/brainstorms/2026-10-18-action-gateway-consolidation-requirements.md`
- Rung 2 plan: `docs/plans/2026-10-19-001-refactor-shared-payload-helpers-plan.md`
- Precedent: `docs/solutions/best-practices/extract-timer-primitive-keep-policy-per-surface-2026-07-13.md`
- Follow-ups: #1885 (error-message codemod), #1886 (owner/repo contract)
