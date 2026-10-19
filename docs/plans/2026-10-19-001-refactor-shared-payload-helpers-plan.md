---
title: "refactor: share OpenCode payload helpers between the Action and the gateway"
type: refactor
status: active
date: 2026-10-19
origin: docs/brainstorms/2026-10-18-action-gateway-consolidation-requirements.md
---

# refactor: share OpenCode payload helpers between the Action and the gateway

## Overview

This rung of the consolidation moves the small pure helpers that read OpenCode payloads into `packages/runtime`. That covers the payload field accessors, the event-shape helpers, the task-notice parser and the blocking-tool check. The Action and the gateway import them from runtime and delete their own copies. No behavior changes.

## Problem Frame

Seven files define the same own-property accessors, 26 definitions in all. The files are `src/features/agent/{streaming,session-poll,retry}.ts`, `packages/gateway/src/execute/{run-core,drain-completion}.ts` and `packages/gateway/src/approvals/{coordinator,question-coordinator}.ts`. The event-shape helpers, the task-notice regex and parser, and the blocking-tool check are each copied once across the two surfaces. `run-core.ts` says it mirrors `streaming.ts` "exactly", and `drain-completion.ts` calls its predicate a "local copy of the Action's predicate in `session-poll.ts`". Nothing enforces either claim.

## Requirements Trace

- R1. Each helper is defined once in runtime, and both surfaces import it. Every production copy is deleted (origin R1, R2).
- R2. The shared helpers keep the current semantics. Reads are own-property only. A miss returns `null` (`ownValue` returns `undefined`). The typed accessors check the value's `typeof` and accept empty strings. `getObjectProperty` returns any non-null own value without narrowing. No call site changes behavior.
- R3. The "mirrors `streaming.ts`" comments in `run-core.ts` and the "local copy of the Action's predicate" comments in `drain-completion.ts` are removed.
- R4. Shared behavior is pinned by tests in runtime (origin R4).
- R5. The requirements doc marks rung 1 as delivered. It also notes that rung 2 needed no drift guard, because nothing stays copied (origin R9, R10).

## Scope Boundaries

- The REST message readers stay per surface because their selection policies differ. `retry.ts` picks by `time.created`, while `drain-completion.ts` picks by array order.
- Rung 1's `firstString` / `firstNumber` / `firstBoolean` stay as they are. They reject empty strings on purpose. The plain accessors accept empty strings, because the streaming output depends on that.
- `coordination/lock-audit.ts` `readString` and `session/storage-mappers.ts` `readString` / `isRecord` have different semantics and are not touched.
- The gateway's `isQualifiedTerminalReply` stays where it is. Only its blocking-tool step moves, because the Action's qualifier is inline and not yet extractable.
- No drift guard. Every production copy is removed in this PR, so there is nothing left to pin.
- The test-only `getProp` in `src/features/agent/quota-terminal-probe.test.ts` stays. It is a fixture helper in a gated probe test, not a surface copy.

## Context & Research

- Research with file:line references for every copy, the call-site counts and the semantic comparison: produced for this plan (local, untracked). It is summarized here.
- The task-notice regex `/<task id="([^"]+)" state="(completed|error)">/` is byte-identical in `streaming.ts` (`INJECTED_TASK_COMPLETION_PATTERN`) and `drain-completion.ts` (`TASK_NOTICE_PATTERN`). The two parsers differ in form only.
- Event-shape helpers: `streaming.ts` (`getEventKind`, `getEventPayload`, `getEventSessionID` on a typed `Event`) and `run-core.ts` (the same three on `unknown`). Both strip the sync-name suffix `/\.\d+$/`.
- Blocking-tool check: `session-poll.ts` inline vs `drain-completion.ts` inside `isQualifiedTerminalReply`. They are logically equivalent: `providerExecuted` tools and orphaned interrupted tools don't block, and a non-array `parts` doesn't block.
- None of these helpers is tested directly. The surface suites cover them indirectly, and those suites must stay green unchanged.
- Rung 1 precedent: `packages/runtime/src/agent/error-format/provider-failure.ts` has its own `ownValue`.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "packages/runtime/src/agent, src/features/agent, packages/gateway/src/execute, packages/gateway/src/approvals",
  "freshness": {
    "vcs_reference": "1c4d5f5e1"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 10,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "packages/runtime/src/agent/error-format/provider-failure.ts ownValue",
      "description": "Rung 1's own-property reader",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/runtime/src/agent/error-format/provider-failure.ts firstString / firstNumber / firstBoolean",
      "description": "Rung 1's first-of readers that reject empty strings",
      "disposition": "insufficient",
      "insufficiency_reason": "Empty-string rejection is intentional for classification; the plain accessors must accept empty strings, so these stay local"
    },
    {
      "path_or_symbol": "packages/runtime/src/coordination/lock-audit.ts readString",
      "description": "Bracket-read string accessor for lock audit details",
      "disposition": "insufficient",
      "insufficiency_reason": "Not own-property only; different semantics, left in place"
    },
    {
      "path_or_symbol": "packages/runtime/src/session/storage-mappers.ts readString / isRecord",
      "description": "Value-only readers for stored session rows",
      "disposition": "insufficient",
      "insufficiency_reason": "Take a value, not an object and key; different contract"
    }
  ]
}
```

## Key Technical Decisions

- **Keep the existing names.** The shared accessors keep `getStringProperty`, `getNumberProperty`, `getBooleanProperty`, `getObjectProperty` and `getSessionID`, so Action and gateway call sites change only their imports. The approvals coordinators switch to the shared helpers: `getOwn` becomes `ownValue` (same `undefined` miss), `getString` becomes `getStringProperty`, and `getObject` becomes `getObjectProperty`. `getStringArray` stays local because it has one consumer.
- **Four small runtime modules, not one.** The modules are `payload-accessors`, `event-shape`, `task-notice` and `message-facts`, so each stays easy to find and to delete.
- **Event helpers take `unknown`.** The Action passes its typed `Event`, which is assignable to `unknown`. `getSessionID` lives in `event-shape`. `getMessageID` stays local to `retry.ts`, because it is the only copy.
- **Task notice.** `task-notice` exports `parseTaskNotice` (text to notice) and `parseSyntheticNoticePart` (part to notice, gated on text type, synthetic and non-null text). The Action's `streaming.ts` call site uses `parseTaskNotice`, and its `eventSessionID === sessionId && synthetic === true` gate stays at the call site. `drain-completion.ts` imports both. The regex constant is not exported from the runtime root.
- **Exports are listed explicitly.** `agent/index.ts` exports the new helpers by name. Check for name collisions against existing runtime exports.
- **`ownValue` is defined once.** Rung 1's `provider-failure.ts` imports it from `payload-accessors`.
- **Rebuild `dist/` in every unit that touches runtime or `src/`.** Runtime is bundled into the Action, so Units 1 and 2 rebuild it.

## Open Questions

### Deferred to Implementation

- Whether any accessor result is compared with `=== undefined`. Research found none. If one exists, keep a `null` miss and fix the call site.
- Whether any gateway test imports `parseTaskNotice` or `parseSyntheticNoticePart` from `drain-completion.ts`. If one does, point the test at runtime. Don't keep a re-export.

## Implementation Units

- [x] **Unit 1: Runtime helper modules**

**Goal:** Pure helpers in runtime, each pinned by a test.

**Requirements:** R1, R2, R4

**Dependencies:** None

**Files:**

- Create: `packages/runtime/src/agent/payload-accessors.ts`, `event-shape.ts`, `task-notice.ts`, `message-facts.ts`, each with a `.test.ts`
- Modify: `packages/runtime/src/agent/index.ts`, `packages/runtime/src/agent/error-format/provider-failure.ts` (import `ownValue`)
- Modify: `dist/` (rebuild, because runtime is bundled into the Action)

**Approach:** Copy the production semantics as they are, using the `streaming.ts` and `drain-completion.ts` bodies as the sources. Put the task-notice regex literal in one constant. `parseSyntheticNoticePart` keeps its gate: text type, synthetic, and non-null text.

**Test scenarios:**

- Happy path: each accessor reads an own property.
- Edge case: an inherited property misses. A `null` or non-object `value` misses. For the typed accessors, a wrong type misses and `''` is accepted. `getObjectProperty` returns any non-null own value, primitives included. A miss returns `null`, and `ownValue` returns `undefined`. A getter is not invoked through the descriptor path.
- Edge case: the event helpers strip the `.N` sync suffix and read `properties`, then `data`.
- Edge case: the task-notice parser handles `completed` and `error`. It returns null for any other state, a missing id, non-text parts, non-synthetic parts and null text.
- Edge case: the blocking-tool check treats a running tool as blocking. A `providerExecuted` tool, an orphaned interrupted tool and a non-array `parts` are not blocking.

**Verification:** The runtime tests pass. Rung 1's `provider-failure` tests still pass.

- [x] **Unit 2: Action uses the shared helpers**

**Goal:** `streaming.ts`, `session-poll.ts` and `retry.ts` import from runtime. Their copies are deleted.

**Requirements:** R1, R2

**Dependencies:** Unit 1

**Files:**

- Modify: `src/features/agent/streaming.ts`, `src/features/agent/session-poll.ts`, `src/features/agent/retry.ts`
- Modify: `dist/`

**Approach:**

- Delete the local accessors, `getSessionID` and the event-shape helpers. Import them from runtime instead.
- Delete `INJECTED_TASK_COMPLETION_PATTERN` and `parseInjectedTaskCompletion`. The `streaming.ts` call site calls the shared `parseTaskNotice` and keeps its `eventSessionID === sessionId && text != null && synthetic === true` gate unchanged.
- Replace the inline blocking-tool check in `session-poll.ts` with `hasBlockingToolPart`.
- `getMessageID` stays local in `retry.ts`.
- The REST readers stay.

**Test scenarios:** No new behavior. The existing Action suites (`streaming`, `session-poll`, `retry`, `execution`, `opencode`) pass unchanged.

**Verification:** The suites pass without edits, and `dist/` is rebuilt and clean.

- [x] **Unit 3: Gateway uses the shared helpers**

**Goal:** `run-core.ts`, `drain-completion.ts` and the two approvals coordinators import from runtime. Their copies and the mirror comments are deleted.

**Requirements:** R1, R2, R3

**Dependencies:** Unit 1

**Files:**

- Modify: `packages/gateway/src/execute/run-core.ts`, `packages/gateway/src/execute/drain-completion.ts`, `packages/gateway/src/approvals/coordinator.ts`, `packages/gateway/src/approvals/question-coordinator.ts`

**Approach:**

- Delete the local accessors, `getSessionID`, the event helpers, `TASK_NOTICE_PATTERN`, `parseTaskNotice` and `parseSyntheticNoticePart`. Import them from runtime instead.
- Replace the blocking-tool loop inside `isQualifiedTerminalReply` with `hasBlockingToolPart`.
- Approvals: `getOwn` becomes `ownValue`, `getString` becomes `getStringProperty`, and `getObject` becomes `getObjectProperty`. `getStringArray` stays local.
- Remove the "mirrors `streaming.ts`" and "local copy of the Action's predicate" comments.

**Test scenarios:** No new behavior. The existing gateway suites (`run-core*`, `drain-completion`, approvals coordinators) pass unchanged.

**Verification:** The gateway suite passes without edits.

- [x] **Unit 4: Requirements doc**

**Goal:** Record rung 1 as delivered, and record that rung 2 needed no drift guard.

**Requirements:** R5

**Dependencies:** Units 1-3

**Files:**

- Modify: `docs/brainstorms/2026-10-18-action-gateway-consolidation-requirements.md`

**Approach:**

- Mark rung 1 as delivered in #1869.
- Amend R9 to say a drift guard is needed only when a rung leaves copies in place. Rung 2 removes every copy in one PR.
- Amend AE3 and the success-criteria bullet about the "mirrors exactly" comment so neither one expects a drift test. The comment is replaced by shared imports.

**Test expectation:** none. This is a docs change. The link check passes.

## System-Wide Impact

- **Interaction graph:** both event loops and the approvals coordinators read payloads through the shared helpers. No runtime behavior changes.
- **Unchanged invariants:** the REST reader selection rules, rung 1's empty-string rule, the per-surface event loops and all outputs.

## Risks & Dependencies

| Risk                                                   | Mitigation                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| A name collision in the runtime root exports           | Export by name, and run check-types across all packages     |
| A subtle semantic drift in a copy that research missed | The surface suites run unchanged. Any drift would fail them |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-10-18-action-gateway-consolidation-requirements.md](../brainstorms/2026-10-18-action-gateway-consolidation-requirements.md)
- Inventory: [docs/brainstorms/2026-10-18-action-gateway-consolidation-inventory.md](../brainstorms/2026-10-18-action-gateway-consolidation-inventory.md) (row 15, Callout B)
- Rung 1: #1869
