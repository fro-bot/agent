---
title: 'feat: Skip PR reviews via opt-out label'
type: feat
status: active
date: 2026-07-16
origin: docs/brainstorms/2026-07-15-skip-agent-review-label-requirements.md
---

# feat: Skip PR reviews via opt-out label

## Overview

Add a per-PR opt-out from automatic PR-event reviews: when a pull request carries a configurable label (default `skip-agent-review`), PR-event trigger routing skips the run before acknowledgement or token spend. Explicit authorized `@fro-bot` mentions and trusted `review_requested` events naming the bot override the label. Closes #1216.

## Problem Frame

PR-triggered review runs process every authorized, non-draft, unlocked PR with no per-PR opt-out — maintainers cannot suppress automated review on a specific WIP or already-reviewed PR short of disabling the trigger repo-wide (see origin: docs/brainstorms/2026-07-15-skip-agent-review-label-requirements.md).

## Requirements Trace

- R1–R4. One public Action input (`review-skip-label`, default `skip-agent-review`); trimmed; empty disables; case-insensitive matching.
- R5–R7. Matching label skips before acknowledgement/model execution/token spend; no reaction/comment/review; new stable internal skip reason.
- R8. Labels read from the normalized webhook payload only; missing/empty labels → no match; no routing-time API fetch.
- R9. Issue-triage triggers unaffected.
- R10–R11. Authorized `@fro-bot` mention or trusted `review_requested` naming the bot overrides the skip.
- R12–R14. Event-time evaluation only: no in-flight cancellation (AE8), label removal re-enables on the next event with no skip memory (AE9); unlabeled/disabled behavior byte-identical to current.

## Scope Boundaries

- Out of scope: issue-triage triggers, in-flight cancellation, label creation/management, GitHub-visible skip indication, multiple label names, `pull_request.edited` subscription, workflow-trigger expansion, comment/review-comment route changes.
- The public Action contract is the only configuration surface — no duplicate workflow-level input.

## Context & Research

### Relevant Code and Patterns

- `src/features/triggers/skip-conditions-pr.ts` — `checkPullRequestSkipConditions` skip chain (action → self-comment → authorization → draft → locked → `bot_not_requested`); the label check appends after these.
- `src/services/github/context.ts` (`normalizeEvent`, `pull_request` case ~line 99) — the RAW typed webhook payload (`PullRequestEvent`) carries `pull_request.labels` (typed, fixture-backed), but `normalizeEvent` currently drops it: the normalized PR variant in `src/services/github/types.ts` has no `labels` field yet. Unit 2 adds it — do not expect the field to pre-exist.
- `src/features/triggers/context-builders-pr-issues.ts` (`buildPullRequestContextData`) — maps normalized event → `TriggerTarget`; mirrors `requestedReviewerLogins` pattern for labels.
- `src/harness/phases/routing.ts` (`runRouting`) — passes a partial config into `routeEvent`; the full `TriggerConfig` is assembled in `src/features/triggers/router.ts` via `{...DEFAULT_TRIGGER_CONFIG, ...config}` merge. The skip path returns `null` before acknowledgement (satisfies R5 by construction, verified at routing.ts:53-65).
- `src/harness/config/inputs.ts` — trim/empty-normalization patterns for inputs (e.g. `parseModelInput`).
- `src/features/triggers/types.ts` — `SKIP_REASONS`, `TriggerConfig`, `DEFAULT_TRIGGER_CONFIG`.
- `packages/runtime/src/agent/types.ts` — canonical `TriggerContext`/`TriggerTarget` (runtime-owned).

### Institutional Learnings

- `docs/solutions/integration-issues/github-action-input-env-hyphen-mapping-2026-07-10.md` — `review-skip-label` reads from env `INPUT_REVIEW-SKIP-LABEL` (hyphens survive); tests must mock the real key.
- `docs/solutions/integration-issues/action-input-metadata-defaults-are-runtime-contracts.md` — `action.yaml` default and `inputs.ts` fallback must agree (`skip-agent-review` in both).
- `docs/solutions/integration-issues/trigger-normalization-configuration-boundaries.md` — label data flows through `NormalizedEvent`, never raw payload access at routing.
- `docs/solutions/workflow-issues/action-phase-boundaries-require-explicit-data-contracts-2026-05-07.md` — the input threads bootstrap → routing via typed phase results, not ambient state.
- `docs/solutions/security-issues/authorization-identity-sources.md` — no secondary actor-attribution: GitHub label permissions are the authority (origin Key Decision).
- `docs/solutions/best-practices/end-to-end-action-tests-as-contract-tests.md` — cover the input→skip path end-to-end through `routeEvent`, not only unit-level.

## Key Technical Decisions

- **Label check runs last in the existing PR skip chain**: preserves current skip-reason precedence (`action_not_supported`, `self_comment`, `unauthorized_author`, `draft_pr`, `issue_locked`, `bot_not_requested` all take priority). A labeled-but-unauthorized PR still reports `unauthorized_author`.
- **Override conditions are exactly two** (evaluated inside the label check): the current event's PR body mention gate passed (`hasMention === true` — authorization already enforced earlier in the chain), or the current action is `review_requested` with `isBotReviewRequested === true`. `ready_for_review` with a pre-existing bot assignment is NOT an override (origin F2/R10-R11; confirmed contract, memory #6728).
- **Normalization propagates label names only** (`readonly string[]` of `label.name`): routing needs nothing else; no color/description/id. Case handling at comparison time (`toLowerCase()` both sides), not at normalization — the normalized event stays a faithful projection.
- **Empty/unset input semantics**: `inputs.ts` trims; trimmed-empty → `null` (feature disabled, no label evaluation). `action.yaml` carries the literal default `skip-agent-review` so metadata and runtime agree.
- **`TriggerConfig` gains `reviewSkipLabel: string | null`**, defaulted `null` in `DEFAULT_TRIGGER_CONFIG` — existing tests and non-Action consumers see no behavior change.
- **New skip reason `review_skip_label`** appended to `SKIP_REASONS` (stable, distinct, internal-only — skip path posts nothing, satisfying R6 by construction since `runRouting` returns before acknowledgement).
- **Labels stay in routing context** (`TriggerTarget.labels` optional): not added to `AgentContext`/prompt surfaces.

## Open Questions

### Resolved During Planning

- Where must the skip occur to guarantee zero token spend? — `runRouting` returns on `shouldProcess: false` before the acknowledge/cache/execute phases; placing the check in `checkPullRequestSkipConditions` is sufficient.
- Does `review_requested` label data exist on the payload? — yes; all PR-event payload variants carry `pull_request.labels`; missing/empty arrays normalize to `[]` (no match, R8/AE11).

### Deferred to Implementation

- Exact fixture shapes for labeled-PR payloads — extend the existing `__fixtures__/payloads.ts` builders at implementation time.

## Implementation Units

- [x] **Unit 1: Public input contract — `review-skip-label`**

**Goal:** Expose and parse the opt-out label input with trim/empty-disable semantics.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `action.yaml` (new input, default `skip-agent-review`), `src/shared/types.ts` (`ActionInputs.reviewSkipLabel: string | null`), `src/harness/config/inputs.ts`
- Test: `src/harness/config/inputs.test.ts`

**Approach:**
- Follow the existing trim-then-normalize input pattern; trimmed-empty → `null`. Input name `review-skip-label` → env `INPUT_REVIEW-SKIP-LABEL` (hyphen mapping — mock the real key in tests).

**Test scenarios:**
- Happy path: unset input → `'skip-agent-review'` (metadata default flows through `core.getInput`).
- Happy path: ` no-bot-review ` → `'no-bot-review'` (trimmed, AE3).
- Edge case: empty string → `null`; whitespace-only string → `null` (AE4/R3).
- Edge case: mixed-case value preserved verbatim (case handling is comparison-time, not parse-time).

**Verification:** `inputs.test.ts` green; parsed shape matches `action.yaml` default per the metadata-defaults contract.

- [x] **Unit 2: Normalized PR label propagation**

**Goal:** Carry PR label names from the webhook payload through `NormalizedEvent` into `TriggerTarget` — no API fetch.

**Requirements:** R8 (and enables R5)

**Dependencies:** None (parallel-safe with Unit 1)

**Files:**
- Modify: `src/services/github/types.ts` (PR variant gains `labels: readonly string[]`), `src/services/github/context.ts` (`normalizeEvent` pull_request case), `packages/runtime/src/agent/types.ts` (`TriggerTarget.labels?: readonly string[]`), `src/features/triggers/context-builders-pr-issues.ts` (`buildPullRequestContextData` target mapping)
- Test: `src/services/github/context.test.ts`, `src/features/triggers/router.test.ts` (context-builder assertions live here per existing pattern)

**Approach:**
- Mirror the `requestedReviewers` normalization shape: `(p.pull_request.labels ?? []).map(l => l.name)` with the same defensive flatMap treatment if the typed payload allows partial label objects. Only the PR event variant changes; issue/comment variants untouched (R9).

**Test scenarios:**
- Happy path: payload with two labels → normalized event carries both names in order.
- Edge case: payload with `labels` absent → `[]`; payload with empty `labels` → `[]` (AE11).
- Integration: `buildPullRequestContextData` maps normalized labels onto `target.labels`; other event types leave `labels` undefined.

**Verification:** context and router tests green; no `octokit`/API call added anywhere in the normalization path.

- [x] **Unit 3: Routing policy — skip + overrides**

**Goal:** Enforce the label skip with exact override behavior in the PR skip chain, threaded from the Action input.

**Requirements:** R4, R5, R6, R7, R9, R10, R11, R12, R13, R14

**Dependencies:** Units 1, 2

**Files:**
- Modify: `src/features/triggers/types.ts` (`SKIP_REASONS` + `TriggerConfig.reviewSkipLabel` + `DEFAULT_TRIGGER_CONFIG`), `src/features/triggers/skip-conditions-pr.ts`, `src/harness/phases/routing.ts` (pass `bootstrap.inputs.reviewSkipLabel` in the partial config — the `DEFAULT_TRIGGER_CONFIG` merge in `router.ts` needs no change beyond the type gaining the field)
- Test: `src/features/triggers/skip-conditions-pr.test.ts`, `src/features/triggers/router.test.ts`, `src/harness/phases/routing.test.ts`

**Approach:**
- Append the check after `bot_not_requested` (chain order preserved). Guard: `config.reviewSkipLabel != null` → compare `target.labels` case-insensitively against the trimmed config value. Overrides short-circuit the skip: `hasMention === true`, or (`action === 'review_requested'` && `isBotReviewRequested === true`). Skip result: `{shouldSkip: true, reason: 'review_skip_label', message: …}`.
- `checkPRReviewCommentSkipConditions` and all issue/comment skip functions untouched.

**Execution note:** Test-first — encode AE1–AE11 as failing scenarios before wiring the check.

**Test scenarios:**
- Happy path: labeled PR + `synchronize` → skip with `review_skip_label` (AE1).
- Happy path: config `Skip-Agent-Review` vs label `skip-agent-review` → skip (case-insensitive, AE2).
- Edge case: `reviewSkipLabel: null` (disabled) + PR literally labeled `skip-agent-review` → no skip (AE4).
- Edge case: unlabeled PR → `shouldSkip: false`, result identical to pre-feature behavior (AE7/R14).
- Edge case: labels empty/undefined on target → no match (AE11).
- Override: labeled PR + authorized PR-body mention (`hasMention: true`) → no skip (AE5).
- Override: labeled PR + `review_requested` with `isBotReviewRequested: true` → no skip (AE6).
- Negative override: labeled PR + `ready_for_review` where the bot appears in `requestedReviewerLogins` (stale assignment, `isBotReviewRequested: true` but action is not `review_requested`) → the label skip STILL applies (`ready_for_review` is never an override — only a live `review_requested` action naming the bot or an authorized mention is).
- Timing (AE8 is structural): label evaluation happens only at routing time — no code path cancels an in-flight run; assert no new cancellation surface is introduced (`Test expectation: none — structural; in-flight cancellation out of scope`).
- Timing: previously-skipped PR, label removed, new `synchronize` event → review runs normally (AE9 — re-evaluation is per-event, no skip memory).
- Precedence: labeled draft PR → `draft_pr` (not `review_skip_label`); labeled locked PR → `issue_locked`; labeled PR from unauthorized author → `unauthorized_author`.
- Integration (router-level): `routeEvent` with labeled `pull_request` fixture + config from routing phase → `shouldProcess: false` with `review_skip_label`; issue-triage event with same-named label → unaffected (AE10/R9).
- Integration (routing phase): `runRouting` threads the parsed input into `TriggerConfig`; skip path returns `null` before `collectAgentContext` (R5 — no acknowledgement/token spend).

**Verification:** All AE1–AE11 encoded and green; `SKIP_REASONS` addition does not break exhaustive consumers (grep for `SkipReason` switches).

- [x] **Unit 4: Public docs + dist**

**Goal:** Document the input and ship the rebuilt bundle.

**Requirements:** R1 (public contract visibility)

**Dependencies:** Units 1–3

**Files:**
- Modify: `README.md` (inputs table row), `dist/` (via `bun run build` only — never hand-edited)

**Approach:**
- One README inputs-table row matching `action.yaml` phrasing. Rebuild dist with frozen install; verify determinism (two consecutive builds byte-identical).

**Test scenarios:**
- Test expectation: none — docs and generated bundle; CI's dist-diff job is the gate.

**Verification:** `bun run lint` (includes md-links) green; `git diff dist/` clean after CI-equivalent rebuild.

## System-Wide Impact

- **Interaction graph:** Only `pull_request`-event routing changes. Comment/review-comment mention routes, issue triage, `workflow_dispatch`/`schedule`, and the review-reconciliation phase are untouched.
- **API surface parity:** `NormalizedEvent` PR variant and runtime `TriggerContext.target` gain optional label data; all other variants unchanged. `TriggerConfig` extension is defaulted-null (non-Action consumers unaffected).
- **Error propagation:** No new failure modes — missing label data degrades to "no match," never throws (R8).
- **Integration coverage:** Router-level contract tests prove input→skip end-to-end; unit tests alone don't prove the routing-phase threading (per the phase-boundary learning).
- **Unchanged invariants:** `NormalizedEvent`-only routing (Invariant 6); no routing-time GitHub API fetch; existing skip-reason precedence; no workflow-trigger expansion; Response Protocol untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A `SkipReason` consumer switches exhaustively and breaks on the new member | Grep for `SkipReason` usage in Unit 3; compile-time catch via TS if a `satisfies`/exhaustive switch exists |
| `action.yaml` default drifts from `inputs.ts` fallback | Test pins both (metadata-defaults learning); AE1 covers the default path |
| Payload label shape varies across PR actions | Defensive `?? []` + name-only projection; AE11 covers absence |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-15-skip-agent-review-label-requirements.md](../brainstorms/2026-07-15-skip-agent-review-label-requirements.md)
- Related issue: #1216
- Product contract: architecture memory #6728
- Related code: `src/features/triggers/skip-conditions-pr.ts`, `src/services/github/context.ts`, `src/harness/phases/routing.ts`
