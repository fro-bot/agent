---
title: 'feat: expose sanitized operator failure reason on the run status contract'
type: feat
status: active
date: 2026-07-04
deepened: 2026-07-04
---

# feat: expose sanitized operator failure reason on the run status contract

## Overview

Add an optional, allowlisted `failureKind` enum to the operator run-status contract so the dashboard can distinguish *why* a run failed (e.g. inactivity timeout vs. workspace unreachable vs. generic failure) instead of seeing only `status: failed`. The gateway already classifies failures internally; this feature persists that classification onto run-state and maps it — through a closed allowlist — onto both operator-facing run projections. Additive change, folded into the unreleased contract `1.6.0`.

## Problem Frame

A dashboard-launched run can end `failed` while the gateway knows the sanitized failure class (a live case failed after ~6m15s with gateway log reason `inactivity-timeout`), but `OperatorRunStatus` exposes only `phase`/`status`, so the operator UI cannot tell an inactivity timeout from any other failure. The failure kind is computed in the run lifecycle's error path and turned into a Discord message, then discarded — it is never persisted to run-state, so no operator projection can read it back. Source: fro-bot/agent#1099.

## Requirements Trace

- R1. Expose a sanitized failure reason for terminal `FAILED` operator runs, present only when `phase === 'FAILED'`. → Units 1, 2, 3
- R2. Values are an allowlisted closed enum, never raw error strings / model output / repo-private data / stack traces / internal URLs / tokens. → Unit 1
- R3. Available on both the live SSE status frame and the recent-runs/index projection. → Unit 2
- R4. Preserve all redaction invariants: denylisted-repo records still return null; no other `details` key leaks through the new field. → Units 1, 2
- R5. The internal failure classification is persisted to run-state so a projection can read it. → Units 3, 4
- R6. Pre-ACK workspace-startup failures (clone/readyz) surface as `workspace-unreachable`; other pre-ACK failures render without a `failureKind`. → Unit 4
- R7. A regression proves an inactivity-timeout failure exposes the sanitized reason without leaking raw details. → Units 2, 3

## Scope Boundaries

- No `failureMessage` — the gateway ships the allowlisted enum only; the dashboard owns user-facing copy. (Keeps the redaction story airtight: an enum literally cannot leak.)
- No dashboard rendering — that is `fro-bot/dashboard` work.
- No contract version bump — additive optional field is MINOR; `OPERATOR_CONTRACT_VERSION` stays `1.6.0` (grown, not bumped).
- `failureKind` is never set on non-`FAILED` phases (including `CANCELLED`, which takes its own path and carries `cancelledBy`, not `failureKind`).

### Deferred to Separate Tasks

- Full pre-ACK failure-kind coverage (lock-held, threadFactory failure, ACK-race, generic gate throw → distinct kinds): deferred; these render with no `failureKind` for v1. A follow-up can refine if the dashboard needs them.
- Dashboard consumption (render distinct copy for each kind) + the dashboard's `1.6.0` pin bump: `fro-bot/dashboard`, user-driven, in the same deploy window as the cancellation work (smart note #198).

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/execute/run-core.ts` — `RunCoreErrorKind` union (`unreachable`/`auth`/`session-error`/`prompt-error`/`timeout`/`inactivity-timeout`/`stream-ended`/`missing-coordinator`), the internal classification source.
- `packages/gateway/src/execute/run.ts` — the error-path `is*` classification (`isTimeout`/`isInactivityTimeout`/`isStreamEnded`/`isReachability`), the FAILED transition (no `detailsPatch` today — the seam to add persistence), the `failAdmittedRun` helper called by ~7 pre-ACK gate paths.
- `packages/gateway/src/operator-contract/run-status.ts` — `OperatorRunStatus` (closed DTO), `PHASE_TO_WEB_STATUS`, `toOperatorRunStatus` (live-SSE projector; reads only whitelisted fields, never `details`). Natural home for `OperatorFailureKind` + the allowlist mapping, beside `PHASE_TO_WEB_STATUS`.
- `packages/gateway/src/operator-contract/run-summary.ts` — `RunSummary` + `toRunSummary` (recent-runs projector); the `updatedAt?` conditional-spread is the exact pattern `failureKind?` mirrors.
- `packages/gateway/src/web/sse/projection.ts` — `projectRunObservation` re-copies the DTO field-by-field (the approval overlay path); must copy `failureKind` through from the bridge result (not from run-state directly, preserving the deny-gate).
- `packages/runtime/src/coordination/run-state.ts` — `TransitionRunOptions.detailsPatch` (added by the cancellation work #1111); the `detailsPatch: {failureKind}` write is atomic with the FAILED phase write (one S3 IfMatch, no extra round-trip). Precedent: `detailsPatch: {cancelledBy}` in `cancel.ts`/`run.ts`.
- `packages/gateway/src/operator-contract/version.ts` — `OPERATOR_CONTRACT_VERSION = '1.6.0'`; MINOR policy means additive fields do not bump it.

### Institutional Learnings

- `docs/solutions/best-practices/options-object-for-shared-signature-extension-2026-07-03.md` — the `detailsPatch` bag this feature writes through is the extension point that doc established; add `failureKind` as a detail, not a new signature param.
- Closed-DTO discipline: `projection.test.ts` asserts the operator DTO has *exactly* its whitelisted key set — the structural regression guard. Adding a field means adding it to that set (a deliberate contract-commit), and adding an assertion that no *other* `details` key leaks.

## Key Technical Decisions

- **Enum only, no message** (confirmed): `OperatorFailureKind` is a closed union; the dashboard owns copy. Redaction is trivially safe — the projection maps an internal kind to an allowlisted enum value, so nothing else can pass through.
- **Grow 1.6.0, don't bump** (confirmed): additive optional field = MINOR; `1.6.0` is unreleased/undeployed and the dashboard pins it once for both cancellation and this. Version test stays `1.6.0`.
- **The `RunCoreErrorKind → OperatorFailureKind` mapping IS the allowlist** and lives in `run-status.ts`: a `Record<...>` plus an `'unknown'` default so any unrecognized/adversarial `details.failureKind` value becomes `'unknown'` — never a raw passthrough. `missing-coordinator` (and any future internal kind) has no `Record` entry and therefore resolves to `'unknown'` — no new internal kind can leak without an explicit mapping.
- **The mapper takes the value, not the whole `details` dict** (defense-in-depth): signature is `toOperatorFailureKind(failureKind: unknown): OperatorFailureKind | undefined`, and the caller passes `runState.details.failureKind`. This makes the single-key-read constraint structural in the type signature rather than test-enforced — the mapper physically cannot read any other `details` key.
- **`OperatorFailureKind` = `'inactivity-timeout' | 'max-duration-timeout' | 'stream-ended' | 'workspace-unreachable' | 'session-error' | 'unknown'`.** Mapping: `timeout`→`max-duration-timeout` (operator-facing rename); `inactivity-timeout`/`stream-ended` direct; `unreachable`+`auth`→`workspace-unreachable` (coarsened deliberately — no network-vs-credential oracle for the operator); `session-error`+`prompt-error`→`session-error` (both upstream-of-tool failures, folded); `missing-coordinator`/empty-prompt/anything else→`unknown`.
- **Persist on the FAILED transition** via `detailsPatch: {failureKind}` — the classification must land on run-state or no projection can read it. A small `classifyOperatorFailureKind` helper in `run.ts` maps the existing `is*` flags to the internal kind string; the contract module maps that to the operator enum. This includes the rare CANCELLED→FAILED fallback path (when a CANCELLED transition itself fails and the run falls back to FAILED) — the error is already classified there, so the fallback transition must also carry `detailsPatch: {failureKind}`.
- **Guard against the #1109 write-path trap** (deepen finding): Unit 2's projection tests use hand-built run-state fakes with `details.failureKind` populated — they prove the *reader* works, not that production ever *writes* it. This is the exact pattern that made the thread_id bug (#1109) invisible to a green suite. Mandate at least one end-to-end test that drives a real `transitionRun(FAILED, {detailsPatch:{failureKind}})` and feeds the returned state into `toOperatorRunStatus`/`toRunSummary`, asserting the reason surfaces — tying the write to the read through the real seam.
- **Present only on `phase === 'FAILED'`**, populated via conditional spread (mirrors `updatedAt?`), so the closed DTO stays honest for every other phase.
- **Pre-ACK: `workspace-unreachable` only** (confirmed): thread an optional `failureKind` param through `failAdmittedRun`; populate it for clone/readyz gate failures, leave it `undefined` (field omitted) for lock-held/thread-fail/ACK-race/generic gate throw. (Note: lock-held IS terminalized to FAILED — it is just not a *workspace-startup* failure, so it omits the kind.) Verified call-site inventory: 7 pre-ACK `failAdmittedRun` sites (clone/readyz populate; threadFactory×2, lock-error, lock-held, ACK-412 omit) plus a pre-ACK catch-all (omit); the 3 `launchWork` admission sites are out of pre-ACK scope.

## Open Questions

### Resolved During Planning

- Enum vs message: enum only (user-confirmed).
- Version: grow 1.6.0, no bump (user-confirmed; matches additive MINOR policy).
- `prompt-error` has no operator enum entry: fold into `session-error` (user-confirmed).
- Pre-ACK coverage: `workspace-unreachable` for clone/readyz, omit the rest (user-confirmed).
- `EmptyPromptError` reaching FAILED: front-door guard short-circuits it before run-state exists; if it somehow reaches FAILED, map to `unknown`/omit (defensive).

### Deferred to Implementation

- Whether `classifyOperatorFailureKind` lives inline in `run.ts` or a tiny adjacent `failure-classify.ts` — decide by whether it keeps `run.ts` readable; single consumer either way.
- Exact `EnsureCloneFailureKind → workspace-unreachable` wiring (ensure-clone uses its own kind namespace) — map at the `failAdmittedRun` call site, don't introduce a parallel enum.

## Implementation Units

- [ ] **Unit 1: Contract type + allowlist mapping**

**Goal:** Define `OperatorFailureKind` and the closed `RunCoreErrorKind → OperatorFailureKind` allowlist gate; export from the contract barrel. No projection changes yet.

**Requirements:** R1, R2, R4

**Dependencies:** None

**Files:**
- Modify: `packages/gateway/src/operator-contract/run-status.ts`, `packages/gateway/src/operator-contract/index.ts`
- Test: `packages/gateway/src/operator-contract/run-status.test.ts`

**Approach:**
- Add `export type OperatorFailureKind = 'inactivity-timeout' | 'max-duration-timeout' | 'stream-ended' | 'workspace-unreachable' | 'session-error' | 'unknown'`.
- Add `toOperatorFailureKind(failureKind: unknown): OperatorFailureKind | undefined` beside `PHASE_TO_WEB_STATUS`: takes the value (NOT the `details` dict — the narrow signature makes single-key-read structural), maps a known internal-kind string through a `Record` to the operator enum, returns `'unknown'` for any non-`undefined` value not in the map, and `undefined` when the value is absent. Callers pass `runState.details.failureKind`.
- Export both from the barrel.

**Patterns to follow:** `PHASE_TO_WEB_STATUS` (the sibling closed mapping); the `?? 'failed'` defaulting style.

**Test scenarios:**
- Happy path: each known internal kind maps to its operator enum (table-driven: `timeout`→`max-duration-timeout`, `inactivity-timeout`→same, `stream-ended`→same, `unreachable`→`workspace-unreachable`, `auth`→`workspace-unreachable`, `session-error`→same, `prompt-error`→`session-error`).
- Edge: `details.failureKind` absent → `undefined`.
- Edge/security: an unrecognized string (`'lol-raw-error'`, `missing-coordinator`) → `'unknown'` (allowlist gate holds).
- Edge: a non-string value (object/number/null) → `'unknown'` (present) or `undefined` (absent) — never coerced into a raw value.
- Structural: the mapper's signature takes only the value, so it physically cannot read another `details` key (defense-in-depth over the test guard).

**Verification:** the mapping is total over `RunCoreErrorKind`, falls back to `'unknown'` for everything else, and reads no other detail.

- [ ] **Unit 2: Populate both projections + closed-DTO tests**

**Goal:** Add `failureKind?` to `OperatorRunStatus` and `RunSummary`, populate it (FAILED-only) in both projectors and the SSE copy-through, and update the closed-DTO guards.

**Requirements:** R1, R3, R4, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/gateway/src/operator-contract/run-status.ts` (`OperatorRunStatus` + `toOperatorRunStatus`), `packages/gateway/src/operator-contract/run-summary.ts` (`RunSummary` + `toRunSummary`), `packages/gateway/src/web/sse/projection.ts` (`projectRunObservation` copy-through)
- Test: `packages/gateway/src/operator-contract/run-status.test.ts`, `packages/gateway/src/operator-contract/run-summary.test.ts`, `packages/gateway/src/web/sse/projection.test.ts`

**Approach:**
- Add `readonly failureKind?: OperatorFailureKind` to both DTOs.
- In `toOperatorRunStatus` and `toRunSummary`: conditional spread gated on `phase === 'FAILED'` that calls `toOperatorFailureKind(runState.details.failureKind)` and omits the field when it returns `undefined` (mirrors `updatedAt?`). Read `runState.details.failureKind` ONLY inside this FAILED branch.
- In `projectRunObservation`: copy `base.failureKind` through from the bridge result (NOT from run-state) so the deny-gate/overlay path stays intact.
- Update the exact-key-set assertions (`projection.test.ts` `contractFields`, `run-status.test.ts`, `run-summary.test.ts`) to include `failureKind`; add an explicit assertion that no other `details` key (rawOutput, workspacePath, toolArgs, internalUrl) leaks. NOTE: `run-status.test.ts` currently has only a *negative* check (asserts `holder_id`/`thread_id`/`details` absent) — upgrade it to a full exact-key-set assertion so a future sibling-field leak is caught structurally, matching the `projection.test.ts` guard.

**Patterns to follow:** `updatedAt?` conditional spread in `run-summary.ts`; the closed-DTO key-set test in `projection.test.ts`.

**Test scenarios:**
- Happy path: a FAILED run-state with `details.failureKind = 'inactivity-timeout'` → both projections carry `failureKind: 'inactivity-timeout'` (R7).
- Edge: a non-FAILED run (running/succeeded/cancelled) → `failureKind` absent from both DTOs.
- Edge: FAILED run with no `details.failureKind` → field omitted (not `null`, not `'unknown'`).
- Security/R4: FAILED run whose `details` also contains `rawOutput`/`internalUrl`/`workspacePath` → only `failureKind` surfaces; the closed-key-set test proves no leak.
- Security: denylisted-repo FAILED run → projection returns null (deny-gate unaffected by the new field).
- Integration: SSE `projectRunObservation` carries `failureKind` through with the approval overlay applied.

**Verification:** both operator DTOs expose `failureKind` only on FAILED runs; the exact-key-set guards pass with the field added and prove no other detail leaks.

> Write-path caveat (deepen/#1109): these tests use populated run-state fakes and prove only the *reader*. The write is proven in Unit 3's end-to-end scenario — do not treat a green Unit 2 as evidence production populates the field.

- [ ] **Unit 3: Persist the failure kind on the in-flight FAILED transition**

**Goal:** Classify the in-flight run failure and write it to run-state so the projections (Unit 2) can read it.

**Requirements:** R5, R7

**Dependencies:** Unit 1 (needs the internal-kind vocabulary)

**Files:**
- Modify: `packages/gateway/src/execute/run.ts`
- Test: `packages/gateway/src/execute/run.test.ts`

**Approach:**
- Add a `classifyOperatorFailureKind(...)` helper mapping the existing error-path `is*` flags (`isTimeout`/`isInactivityTimeout`/`isStreamEnded`/`isReachability`, plus the `RunCoreError.kind` for `session-error`/`prompt-error`) to the internal kind string; catch-all → the value that maps to `'unknown'`.
- On the in-flight FAILED `transitionRun` call, pass `detailsPatch: {failureKind: <internal-kind-string>}` (atomic with the phase write). Do NOT set `failureKind` on the CANCELLED path (it carries `cancelledBy`, not `failureKind`). DO cover the CANCELLED→FAILED fallback path (when the CANCELLED transition fails and the run falls back to FAILED): the error is already classified there, so that fallback `transitionRun` must also carry `detailsPatch: {failureKind}` — otherwise the rare fallback surfaces `failed` with no reason.
- `details.failureKind` is additive-safe: verified no gateway/runtime consumer iterates `details` keys or asserts a closed shape (only `cancel.ts` reads `details.channelId`, `run-state.ts` validates the container type). `cancelledBy` and `failureKind` never coexist (mutually exclusive by phase), so the `{...details, ...detailsPatch}` merge cannot collide.

**Patterns to follow:** the `detailsPatch: {cancelledBy}` write in `run.ts`/`cancel.ts` (#1111); the existing `is*` classification block.

**Test scenarios:**
- **End-to-end (the #1109 guard — required):** drive a real `transitionRun(FAILED, {detailsPatch:{failureKind:'inactivity-timeout'}})` and feed the RETURNED run-state into `toOperatorRunStatus`/`toRunSummary`, asserting the projection carries `failureKind:'inactivity-timeout'`. This ties the write to the read through the real seam — a green Unit 2 alone does not prove production writes the field.
- Happy path: an inactivity-timeout failure → FAILED transition called with `detailsPatch.failureKind` = the inactivity kind.
- Happy path: a wall-clock timeout → `detailsPatch.failureKind` maps to `max-duration-timeout` at the projection.
- Edge: a generic/uncategorized failure → `failureKind` maps to `'unknown'` (or is omitted per the classify helper's contract — pick one and assert it).
- Edge: reachability failure (`unreachable`/`auth`) → persisted kind projects to `workspace-unreachable`.
- Regression: the CANCELLED path still writes `cancelledBy` and NOT `failureKind`.
- Fallback: a run whose CANCELLED transition fails and falls back to FAILED persists `detailsPatch.failureKind` (reason survives the fallback).

**Verification:** the FAILED transition persists the classified kind; a full inactivity-timeout path surfaces the sanitized reason on the operator contract with no raw detail leak.

- [ ] **Unit 4: Pre-ACK workspace-unreachable coverage**

**Goal:** Surface `workspace-unreachable` for pre-ACK workspace-startup failures; leave other pre-ACK failures without a `failureKind`.

**Requirements:** R6

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/gateway/src/execute/run.ts` (`failAdmittedRun` + its clone/readyz call sites)
- Test: `packages/gateway/src/execute/run.test.ts`

**Approach:**
- Add an optional `failureKind?` param to `failAdmittedRun`; when present, thread it into the FAILED `transitionRun` via `detailsPatch: {failureKind}`.
- At the clone-failure and readyz-failure call sites, pass the workspace-unreachable internal kind (map the ensure-clone kind namespace at the call site — do not add a parallel enum). Leave lock-held/threadFactory-fail/ACK-race/generic-gate-throw call sites passing nothing (field omitted).

**Patterns to follow:** the existing `failAdmittedRun` call sites; Unit 3's `detailsPatch` write.

**Test scenarios:**
- Happy path: workspace clone failure pre-ACK → run-state FAILED carries the workspace-unreachable kind → projection exposes `workspace-unreachable`.
- Happy path: readyz failure pre-ACK → same.
- Edge: lock-held path (an expected non-failure) → no `failureKind` written; projection omits the field.
- Edge: threadFactory failure / ACK-race → FAILED with no `failureKind` (omitted).

**Verification:** clone/readyz pre-ACK failures are operator-distinguishable as `workspace-unreachable`; other pre-ACK terminalizations render without a failure reason.

## System-Wide Impact

- **Interaction graph:** touches the two operator projections, the SSE observation copy-through, the in-flight + pre-ACK FAILED transitions, and the run-state `details` write. No new routes, no new frames, no version bump.
- **Error propagation:** the failure kind now travels run.ts classification → run-state `details` → projection → operator DTO, instead of dying at the Discord message. The Discord user-message path is unchanged.
- **State lifecycle risks:** `failureKind` is written atomically with the FAILED phase (single conditional write). The `terminalReplayCache` carries the enriched DTO to late subscribers automatically. `terminalRuns` out-of-order guard is inert to an added field.
- **API surface parity:** both operator run projections (`toOperatorRunStatus`, `toRunSummary`) gain the field in lockstep; the SSE overlay path copies it through. Missing one would make the surfaces disagree.
- **Integration coverage:** the closed-DTO key-set tests are the structural guard that the field is exposed *and* that no sibling `details` key leaks.
- **Unchanged invariants:** `OPERATOR_CONTRACT_VERSION` stays `1.6.0`; denylist gate still returns null for denied repos; internal fields (`holder_id`/`thread_id`/`details`) remain excluded by construction; `registry.handleDecision`/cancellation paths untouched; the ready/health frames still emit `1.6.0`.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A raw internal string leaks through `failureKind` | The projection maps through a closed `Record` with `'unknown'` default — the mapping IS the allowlist; the mapper's signature takes only the value (cannot read another `details` key); a table-driven test + the closed-key-set test prove no passthrough. |
| **Green Unit 2 masks a missing/wrong Unit 3 write** (the #1109 thread_id-fake trap) | Unit 2 fakes populate `details.failureKind`, proving only the reader. Unit 3 mandates an end-to-end `transitionRun`→projection test that ties write to read through the real seam. |
| `RunSummary` denylist filtering is caller-level (not built into `toRunSummary`) | Adding `failureKind` does not change this — callers must keep filtering denied records before projection (existing `filterDeniedRecords` in the runs route). Noted so a future caller doesn't assume `toRunSummary` self-guards. |
| Presence-vs-absence of `failureKind` on FAILED runs is a coarse oracle (pre-ACK-non-workspace vs `unknown`) | Accepted for v1: the operator can already infer pre-ACK timing, and writing `'unknown'` on every path would thread an extra param through all pre-ACK sites. Revisit if it proves exploitable. |
| Projections drift (one surface gains the field, the other doesn't) | Units 2 covers both `toOperatorRunStatus` and `toRunSummary` in one unit with parity tests. |
| Growing `1.6.0` post-merge confuses anyone reasoning from the merged cancellation PR | Nothing consumes `1.6.0` yet (unreleased, dashboard unpinned); documented that this and cancellation ship as one `1.6.0` the dashboard pins once. |
| Pre-ACK threading balloons scope | Scoped to `workspace-unreachable` on clone/readyz only; other call sites pass nothing (field omitted). |
| `failureKind` accidentally set on non-FAILED (esp. CANCELLED) | Population is gated on `phase === 'FAILED'` in the projection and only written on FAILED transitions; a regression asserts CANCELLED carries `cancelledBy`, not `failureKind`. |

## Documentation / Operational Notes

- Dashboard follow-up (render per-kind copy + pin `1.6.0`) is tracked in smart note #198; surface it at PR time so the dashboard consumes both cancellation and failure-reason in one pin bump.
- No deploy/compose/env changes.

## Sources & References

- Origin issue: fro-bot/agent#1099.
- Related: #1055 (inactivity-timeout policy, shipped — the failure class this exposes), #1111 (contract `1.6.0` + the `detailsPatch` seam this writes through), #1101 (lost-event vs hung diagnostics — complementary; once this ships the dashboard can at least name the reason).
- Related code: see Context & Research.
