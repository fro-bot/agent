---
title: "refactor: share provider-failure classification between the Action and the gateway"
type: refactor
status: active
date: 2026-10-18
origin: docs/brainstorms/2026-10-18-action-gateway-consolidation-requirements.md
---

# refactor: share provider-failure classification between the Action and the gateway

## Overview

A single runtime function looks at an OpenCode signal and returns two things: what kind of provider failure it is, and whether the run should stop now. The Action and the gateway both call it and delete their own copies. Where the copies used to disagree, both surfaces now follow the shared rule, and the PR lists the behavior that changes as a result. Operator contract 1.13.0 adds the `provider-quota-exceeded` reason.

## Problem Frame

Provider-failure handling exists in three places:

- runtime's per-kind classifiers in `packages/runtime/src/agent/error-format/format.ts`;
- the Action's ladders in `src/features/agent/streaming.ts` and `src/features/agent/session-poll.ts`;
- the gateway's `packages/gateway/src/execute/provider-failure.ts`.

The copies treat the same signal differently:

- On an `account_rate_limit` retry status, the Action stops the run. The gateway waits out OpenCode's retry budget.
- On a `model_not_found` or `model_not_supported` retry status, the gateway stops and the Action waits, even though a missing model never recovers.
- The gateway reads auth and model hints from message text. The Action does not.
- The Action's SSE and poll paths label the same error differently, because poll ignores usage-limit text.

Each fix has landed on only one side (see origin inventory, row 3).

## Requirements Trace

- R1. One runtime function classifies provider failures for both surfaces, and their own copies are deleted (origin R1, R2).
- R2. The function returns the failure kind and whether the run stops now. Both surfaces act on that stop decision (origin R5).
- R3. A run stops on confirmed structured signals and on the established text patterns: usage-limit wording and `Model not found:`. Looser hints, such as auth wording and "model is not supported", label the failure but never stop the run.
- R4. A retry status stops the run for `auth_unavailable`, `account_rate_limit`, `model_not_found` and `model_not_supported`. Every other retry keeps waiting.
- R5. Operator contract 1.13.0 adds `provider-quota-exceeded`. The paired dashboard release must ship before deploy, not before merge (origin R6).
- R6. Classification policy tests live once, in runtime. Surface tests cover only how each surface maps the result (origin R4).
- R7. A guard test keeps `@actions/*` imports out of `packages/runtime` (origin R18).
- R8. The PR description lists every behavior change the merge causes (origin R3).

## Scope Boundaries

- Three policies stay per surface because they differ by design:
  - abort detection: the gateway checks its own cancel signal;
  - context-overflow recovery: the Action restarts in a fresh session, while the gateway waits for compaction;
  - descendant-session errors: the Action ignores them, while the gateway fails the run.

  The shared function reports the `aborted` and `context-overflow` kinds and leaves the response to the surface.

- How each event loop handles a non-provider error, such as an unclassified `session.error` or a network error, belongs to the loop. That changes when the loops are consolidated, not in this rung.
- The gateway's error-name allowlist stays in the gateway. It feeds only the gateway's log line.
- The gateway's workspace-proxy `isAuthError` (HTTP 401/403 on `promptAsync`) is a transport check, not a provider failure, so it stays in the gateway.

### Deferred to Separate Tasks

- A drift guard for the task-notice pattern and payload accessors (origin R9). This gets its own PR before rung 2.
- Dashboard support for `provider-quota-exceeded` and the 1.13.0 pin. This happens in the dashboard repo, and it gets posted to fro-bot/.github#3512 after merge.

## Context & Research

### Relevant Code and Patterns

- Runtime per-kind classifiers live in `packages/runtime/src/agent/error-format/format.ts`. The input contract in `error-format/types.ts` requires normalized inputs and never raw SDK events.
- Action call sites:
  - `streaming.ts`: `classifyRetryStatusError`, `isTerminalProviderError`, the SSE `session.error` ladder, and `mergeActivityError`.
  - `session-poll.ts`: `classifyAssistantMessageError` and the poll retry branch.
- Gateway call sites:
  - `provider-failure.ts`.
  - `run-core.ts`: `failFromProvider` and the `session.error`, `message.updated` and `session.status` branches. A quota retry inherits the existing live-root teardown path.
  - `run.ts`: wire mapping.
- Contract: `packages/gateway/src/operator-contract/provider-failure-reason.ts` holds the tuple, the `satisfies` table, and the set-equality test. Version lives in `version.ts`. The 1.12.0 bump (#1859) is the precedent.
- The Action's recovery gate, `llmError.type === 'context_overflow'` in `src/harness/phases/execute.ts`, is load-bearing. `ErrorType` gains no new member.

### Institutional Learnings

- `docs/solutions/integration-issues/opencode-quota-retry-treated-as-activity-2026-07-15.md`: classify the exact structured retry reason.
- `docs/solutions/integration-issues/provider-auth-failure-hangs-to-timeout-2026-07-25.md`: only structured markers establish auth failure.
- `docs/solutions/logic-errors/abortsignal-any-reason-classification-race-2026-07-03.md`: the abort cause comes from surface state.
- `docs/solutions/best-practices/overflow-recovery-architecture-2026-08-03.md`: overflow recovery stays at the phase layer.
- `docs/solutions/best-practices/authenticated-sse-run-observation-2026-06-20.md`: the wire enum is closed and versioned.
- `docs/solutions/logic-errors/terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md`: once a terminal result is accepted, it is not rewritten.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "packages/runtime/src/agent/error-format, src/features/agent, packages/gateway/src/execute",
  "freshness": {
    "vcs_reference": "1dcd6a296"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 8,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "packages/runtime/src/agent/error-format/format.ts (classifyProviderAuthError, classifyQuotaError, classifyModelNotFoundError, classifyContextOverflowError)",
      "description": "Per-kind structured classifiers and ErrorInfo factories, already partly shared by both surfaces",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/gateway/src/execute/provider-failure.ts",
      "description": "Gateway composition: retry-status classification, structured-error classification, text labels, error-name allowlist",
      "disposition": "insufficient",
      "insufficiency_reason": "Gateway-local; its classification moves into the runtime function and the file shrinks to a mapping plus the log allowlist"
    },
    {
      "path_or_symbol": "src/features/agent/streaming.ts classifyRetryStatusError / session-poll.ts classifyAssistantMessageError",
      "description": "Action compositions over the runtime classifiers, already divergent between SSE and poll",
      "disposition": "insufficient",
      "insufficiency_reason": "Action-local and internally inconsistent; replaced by the runtime function"
    }
  ]
}
```

## Key Technical Decisions

- **One function owns both the label and the stop rule.** It returns kind, evidence, stop, and the Action's error label. If the label were shared but the stop decision were not, the stop decision would stay duplicated, and that duplication is exactly the drift this rung removes.
- **The function takes normalized inputs.** Callers pass either a retry-status signal (reason and reset time) or a terminal-payload signal (name, status, code, message, and the retryable flag). Runtime never sees an SDK `Event`.
- **Evidence comes in three levels.** The levels are `structured`, `text` (the established patterns), and `hint` (looser wording). Only `structured` and `text` stop a run. Auth wording counts as a hint, which keeps runtime's rule that message text is not auth evidence.
- **Results when no reason applies.** A retry status that matches no stop reason returns nothing, and the caller keeps waiting. A terminal payload always returns a result. With no evidence it is `unclassified` with `stop: false`, and it carries the Action's existing generic label ladder: network error, rate limit, retryable API error, agent error.
- **The contract changes before the gateway adopts the function.** The internal reason, wire value, mapping, and version move together in one unit. That keeps the set-equality test and the `satisfies` table valid at every commit.
- **Every commit builds.** Runtime is bundled into the Action, so each unit runs the build and commits any change to `dist/`.

## Open Questions

### Resolved During Planning

- Should the stop decision be shared or per surface? Shared (Marcus, 2026-10-18).
- Should the Action stop on a model retry? Yes (Marcus, 2026-10-18).
- How is the quota reason exposed? As a new wire value in contract 1.13.0 (Marcus, 2026-10-18).
- Does the gateway's `message.updated` overflow handling change? No. The pinned OpenCode source emits an assistant `ContextOverflowError` only after compaction has failed (`compaction.ts:450-458`), so the gateway's immediate failure is already correct.

### Deferred to Implementation

- Gateway tests that use the text `LLM quota exceeded` might get a different label under the shared usage-limit patterns. Check when they run, and change fixtures only if the new label is legitimately correct.

## High-Level Technical Design

> _This table shows the intended rule. It is guidance for review, not an implementation spec._

| Signal                                                     | Kind                   | Evidence   | Stop             |
| ---------------------------------------------------------- | ---------------------- | ---------- | ---------------- |
| retry `auth_unavailable`                                   | auth                   | structured | yes              |
| retry `account_rate_limit`                                 | quota                  | structured | yes              |
| retry `model_not_found` / `model_not_supported`            | model-not-found        | structured | yes              |
| retry, any other reason                                    | none                   | none       | no, keep waiting |
| terminal `ProviderAuthError`                               | auth                   | structured | yes              |
| terminal 402 / `insufficient_quota` / `usage_not_included` | quota                  | structured | yes              |
| terminal usage-limit text                                  | quota                  | text       | yes              |
| terminal `Model not found:` text                           | model-not-found        | text       | yes              |
| terminal auth wording, "model is not supported"            | auth / model-not-found | hint       | no               |
| `ContextOverflowError`                                     | context-overflow       | structured | surface policy   |
| `MessageAbortedError`                                      | aborted                | structured | surface policy   |
| anything else                                              | unclassified           | none       | no               |

## Behavior Changes

These go in the PR description and the release notes.

| Surface | Signal | Before | After |
| --- | --- | --- | --- |
| Gateway | `account_rate_limit` retry | waits out the retry budget | stops with `provider-quota-exceeded` |
| Gateway | `session.error` with 402, `insufficient_quota`, or usage-limit text | stops with `unclassified` | stops with `provider-quota-exceeded` |
| Action | `model_not_found` / `model_not_supported` retry | waits | stops with a model-not-found error |
| Action | poll assistant error with usage-limit text | generic error, exit 0 when a comment target exists | quota error, exit 1 |
| Action | terminal payload with auth wording or "model is not supported" | generic agent error, exit 0 when a comment target exists | provider-auth or model-not-found label, exit 1; timing unchanged |
| Gateway | assistant message error (`message.updated`) with 402, `insufficient_quota`, or usage-limit text | fails as `provider-rejected-request` (`APIError`) or `unclassified` | fails with `provider-quota-exceeded` |
| Action | model retry on a descendant session | ignored | marks that ledger entry unknown; the root failure is unaffected |
| Action | poll-observed assistant error with auth wording or "model is not supported" | settles at once with a generic agent error | still settles at once, now with the provider-auth or model-not-found label; recorded as a generic failure, not a terminal one |
| Both | error payload whose top-level and `data` fields disagree | each surface read its own field first | both read `data.*` first (`name` top level first), skipping wrong-typed values, via `terminalSignalFromPayload` |

## Implementation Units

- [x] **Unit 1: Runtime classifier and stop rule**

**Goal:** One function that returns kind, evidence, stop, and the Action's error label.

**Requirements:** R1, R2, R3, R4, R6

**Dependencies:** None

**Files:**

- Create: `packages/runtime/src/agent/error-format/provider-failure.ts`
- Create: `packages/runtime/src/agent/error-format/provider-failure.test.ts`
- Modify: `packages/runtime/src/agent/error-format/index.ts` and the `packages/runtime/src/agent/index.ts` re-exports
- Modify: `dist/`, if the build changes it

**Approach:**

- Build on the existing per-kind classifiers. Precedence runs structured, then text, then hint, then the generic label ladder.
- Move the gateway's model retry-reason set and its auth and model wording into runtime as `hint` patterns.
- Move the Action's generic label ladder here. It is currently duplicated between SSE and poll.

**Patterns to follow:** the factories in `packages/runtime/src/agent/error-format/format.ts`, and the input contract in `error-format/types.ts`.

**Test scenarios:**

- Happy path: every row of the rule table returns the stated kind, evidence, and stop value.
- Edge case: a retry status carrying only 429, overloaded, 503, or text returns nothing.
- Edge case: invalid, non-finite, or out-of-range quota reset times normalize the same way they do today.
- Edge case: precedence. A structured overflow beats quota text, and quota upgrades a generic error.
- Edge case: hint evidence never stops a run.
- Error path: message text is never auth evidence. The existing runtime tests still hold.

**Verification:** The runtime tests encode the rule table, including the rule that a quota retry stops. The gateway's and the Action's classification policy cases are ported here. The gateway's case for "quota keeps waiting" becomes "quota stops".

- [x] **Unit 2: Operator contract 1.13.0**

**Goal:** The internal reason `provider quota exceeded` maps to the wire value `provider-quota-exceeded`, and every pin reads 1.13.0.

**Requirements:** R5

**Dependencies:** None

**Files:**

- Modify: `packages/gateway/src/execute/provider-failure.ts` (the internal reason union only), `packages/gateway/src/operator-contract/provider-failure-reason.ts`, `packages/gateway/src/operator-contract/version.ts`
- Test: `packages/gateway/src/operator-contract/provider-failure-reason.test.ts`, `version.test.ts`, `question-frame.test.ts`, `run-summary.test.ts`, `run-status.test.ts`, `packages/gateway/src/config.test.ts`, `packages/gateway/src/redaction/surface-gate.test.ts`, `packages/gateway/src/web/sse/manager.test.ts`, `packages/gateway/src/execute/run.provider-failure.test.ts`
- Modify (docs): `packages/gateway/AGENTS.md`, `docs/wiki/Operator Web Control Surface.md`, `docs/wiki/Architecture Overview.md`, `ARCHITECTURE.md`, `deploy/README.md`

**Approach:** Follow the 1.12.0 precedent (#1859). Add a history entry to `version.ts`. Docs that list the enum values get the new value. Restate the paired-deploy note. `CHANGELOG.md` is generated, so do not edit it.

**Test scenarios:**

- Happy path: the new internal reason maps to `provider-quota-exceeded`, and both the run summary and the status frame project it.
- Edge case: a stored bogus value is still omitted, and the row is kept.
- Edge case: membership uses the `Set` guard, which rejects prototype keys.

**Verification:** The pins match across code, tests, and docs, and the contract tests pass.

- [x] **Unit 3: Gateway calls the shared function**

**Goal:** The gateway's classification copy is deleted, and `run-core` acts on the shared stop decision.

**Requirements:** R1, R2, R4, R6

**Dependencies:** Units 1 and 2

**Files:**

- Modify: `packages/gateway/src/execute/provider-failure.ts`. It shrinks to the kind-to-reason mapping plus the error-name allowlist.
- Modify: `packages/gateway/src/execute/run-core.ts`
- Test: `packages/gateway/src/execute/provider-failure.test.ts` (delete the policy cases ported in Unit 1), `packages/gateway/src/execute/run-core.provider-failure.test.ts`

**Approach:**

- `session.status` acts on `stop`. A quota retry goes through the existing live-root teardown: abort, confirm the root is quiescent, and quarantine if it is not.
- `session.error` and `message.updated` map the kind to a reason.
- The abort gate and overflow-pending handling stay as they are.

**Execution note:** First flip the two tests that pin quota as waiting, and watch them fail.

**Test scenarios:**

- Happy path: a root `account_rate_limit` retry stops the run, aborts the live root, and records the quota reason.
- Edge case: if the root is still live after a quota retry, the run is quarantined, the same as on the auth retry path.
- Happy path: a structured-quota `session.error` is labeled quota.
- Edge case: transient retries still keep waiting.
- Error path: logs carry only the allowlisted error name and the reason.
- Integration: the typed reason survives the `RunCoreError` barrier into the run record.

**Verification:** The gateway suite passes. The behavior changes match the table above.

- [x] **Unit 4: Action calls the shared function**

**Goal:** The Action's SSE and poll copies are deleted, and both act on the shared stop decision.

**Requirements:** R1, R2, R3, R4, R6

**Dependencies:** Unit 1

**Files:**

- Modify: `src/features/agent/streaming.ts`, `src/features/agent/session-poll.ts`
- Delete: the `createAgentError` copy in `src/features/comments/error-format.ts` and its barrel export, provided no production caller remains
- Test: `src/features/agent/streaming.test.ts`, `src/features/agent/session-poll.test.ts`, `src/features/agent/opencode.test.ts`, `src/features/comments/error-format.test.ts`, `src/harness/phases/finalize.test.ts`
- Modify: `dist/`

**Approach:**

- Replace `classifyRetryStatusError`, `isTerminalProviderError`, the SSE `session.error` ladder, and `classifyAssistantMessageError` with calls to the shared function.
- Terminal tracking keys on `stop`, not on `ErrorInfo.type`.
- `normalizeSessionError` stays as the logging helper.
- The overflow recovery gate does not change.

**Test scenarios:**

- Happy path: a model retry stops the run on both SSE and poll.
- Happy path: an `account_rate_limit` retry still stops, with its reset time.
- Edge case: auth wording on a terminal payload labels the failure without stopping the run early.
- Edge case: "model is not supported" on a terminal payload labels it without stopping the run early.
- Edge case: poll usage-limit text becomes a quota error.
- Edge case: an unclassified `session.error` still waits through the grace cycles.
- Integration: an overflow still triggers the fresh-session recovery.

**Verification:** The Action suite passes and `dist/` is clean. The behavior changes match the table above.

- [x] **Unit 5: Guard and docs**

**Goal:** Lock the runtime boundary, and update the docs that cite the moved code.

**Requirements:** R7

**Dependencies:** Units 1-4

**Files:**

- Create: `scripts/runtime-no-actions-import-guard.test.ts`
- Modify: `docs/solutions/integration-issues/opencode-quota-retry-treated-as-activity-2026-07-15.md`, `docs/solutions/integration-issues/provider-auth-failure-hangs-to-timeout-2026-07-25.md`

**Approach:** The guard scans `packages/runtime/src` for `@actions/` imports. The solution docs point to the runtime function.

**Test scenarios:**

- Happy path: the guard passes on the current tree.
- Error path: the guard fails when a runtime file imports `@actions/core`. Revert-check with a temporary import.

**Verification:** The guard runs in `test:scripts`, and the markdown link check passes.

## System-Wide Impact

- **Interaction graph:** Three places consume the function: the Action's stream loop, the Action's poll loop, and the gateway's `run-core`. Nothing else calls the deleted functions.
- **Error propagation:** The gateway's typed `providerFailureReason` keeps its shape and gains one value. The Action's `ErrorInfo` types are unchanged.
- **API surface:** The operator contract moves to 1.13.0. The dashboard must accept the new value and pin 1.13.0 before the gateway deploys.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Quota retries quarantine more gateway runs if a root stays live after abort | Uses the same teardown path as the auth retry, pinned by a test |
| Action runs that now get a quota, auth, or model label exit 1 instead of 0 | Listed in the PR. Each reflects a real provider failure |
| The gateway deploys before the dashboard accepts 1.13.0 | The paired deploy is documented in `deploy/README.md`. Merging alone is safe |

## Documentation / Operational Notes

- After merge, post the dashboard pairing to fro-bot/.github#3512: accept `provider-quota-exceeded`, pin 1.13.0, and deploy the two together.
- The release notes carry the Behavior Changes table.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-10-18-action-gateway-consolidation-requirements.md](../brainstorms/2026-10-18-action-gateway-consolidation-requirements.md)
- Inventory: [docs/brainstorms/2026-10-18-action-gateway-consolidation-inventory.md](../brainstorms/2026-10-18-action-gateway-consolidation-inventory.md)
- Contract precedent: [docs/plans/2026-10-17-002-feat-operator-contract-1-12-plan.md](2026-10-17-002-feat-operator-contract-1-12-plan.md)
- Related: #1227, #1283, #1854, #1859
