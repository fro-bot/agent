---
title: "feat: Own and freeze the canonical operator API contract (S1 surface)"
type: feat
status: done
date: 2026-06-19
deepened: 2026-06-19
origin: https://github.com/fro-bot/agent/issues/949 (Fro Bot triage comment as requirements)
---

> **Status: done.** All 6 units shipped as `packages/gateway/src/operator-contract/` (`version.ts`, `identity.ts`, `run-status.ts`, `approval.ts`, `responses.ts`/`parse.ts`, `redaction.ts`) — verified on `main` (PR #952).

# Own and freeze the canonical operator API contract (S1 surface)

## Overview

Make this repo the single source of truth for the operator API contract. Add a dedicated `packages/gateway/src/operator-contract/` module that consolidates the operator-facing shapes that exist today but are scattered and internal — run-state lifecycle, approval-decision semantics, and operator authorization identity — and exports them as transport-stable plain TS types plus a runtime validator, behind an explicit contract version. Embed the authorization and `metadata/repos.yaml` redaction (#950) obligations as first-class normative clauses. The dashboard's mock client becomes a conformant downstream fixture; the gateway owns the real contract.

Net-new command/mission shapes (launch/query/stream a unit of work) are **deferred** — they are designed and frozen alongside the endpoints that implement them in Units 4–6 of the web-operator surface plan, not here.

## Problem Frame

The gateway is gaining an inbound operator control surface (S1/S2, umbrella #907). As that surface takes shape, the gateway must be the authority any client validates against — not the dashboard, which already carries a typed *mock* operator client (`fro-bot/dashboard` `src/gateway/operator-client.ts`). Today no canonical, versioned, exported operator contract exists: the relevant shapes live as runtime coordination internals, gateway approval internals, and inline HTTP response literals. Until the contract is frozen, downstream interactive UI work stays behind mocks (per #949's gating rule).

## Requirements Trace

- R1. The operator command/state/approval/authz contract is documented and exported from one stable location in this repo.
- R2. Consumers have a referenceable, pinned contract **version** to validate against.
- R3. The contract is transport-stable: exported types are plain TS and validation returns `Result<T, E>`; Effect `Schema` is never part of the exported surface.
- R4. The contract is the **sole definer** of its types; existing scattered definitions re-import from it rather than duplicating (collapse, don't fork).
- R5. The contract surfaces only operator-safe fields; internal coordination fields are excluded by construction.
- R6. The contract embeds the authorization obligation (operator→repo access) and the `metadata/repos.yaml` redaction obligation (#950) as normative clauses.
- R7. The contract encodes approval-decision semantics so a web transport cannot become a higher-privilege bypass of the fail-closed gate.

## Scope Boundaries

- This plan does **not** implement the redaction gate itself (denylist-before-query against `metadata/repos.yaml`). It binds the contract to that obligation so the first repo-data endpoint cannot skip it; the gate ships with the endpoint that needs it.
- This plan does **not** change any runtime behavior of existing routes, approvals, or the engine. It is a types-consolidation + versioning + obligation-documentation change.
- No cross-repo coupling: `fro-bot/dashboard` is a downstream consumer; this contract has no source dependency on it, and this plan touches only `fro-bot/agent`.

### Deferred to Separate Tasks

- Net-new operator **command/mission shapes** (`POST /operator/runs`, `GET /operator/runs/:id`, stream, approvals decision body): designed + frozen with their endpoints in the web-operator surface plan (`docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md`, Units 4–6).
- The **redaction gate implementation** (#950): a follow-up that implements denylist-before-query; this plan only freezes the obligation.
- A **compound solutions doc** capturing "centralize-key pattern applied to type families": after this lands (no existing types-ownership doc exists).
- A **dashboard-side conformance check** (type-assignability CI gate or assertion test that the dashboard mock conforms to the frozen contract version): lives in `fro-bot/dashboard`, out of scope here, but the contract's value depends on it — flagged so the contract doesn't silently drift from the mock.
- Promoting `PermissionRequest`/`PermissionReplyEvent`/`SettlementReason` and the OAuth-callback / route-guard response shapes into the contract: a later v1.1 MINOR (kept out of v1 to bound the fan-out).

## Context & Research

### Relevant Code and Patterns

- **Run-state lifecycle** — `packages/runtime/src/coordination/types.ts`: `RunPhase` (`PENDING|ACKNOWLEDGED|EXECUTING|COMPLETED|FAILED|CANCELLED`), `Surface` (`github|discord|web`), `RunState` (carries internal `holder_id`, `thread_id`, `details`). Exported via `packages/runtime/src/coordination/index.ts` → `packages/runtime/src/index.ts`. NOT re-declared in the gateway — imported.
- **Run-state parser precedent** — `packages/runtime/src/coordination/run-state.ts` `parseRunState(data): Result<RunState, Error>` + `hasValidRunStateShape` type-guard. The canonical validator pattern to mirror.
- **Approval semantics** — `packages/gateway/src/approvals/coordinator.ts`: `PermissionReply` (`once|always|reject`, declared here — gateway-owned), `PermissionRequest`, `PermissionReplyEvent`, `SettlementReason`. `packages/gateway/src/approvals/registry.ts`: `WebOperatorActor`, `ApprovalActor` union, `DecisionOutcome`.
- **Identity duplication (consolidation target)** — structurally overlapping `OperatorAuthContext` (`packages/gateway/src/web/operator-route.ts`), `SessionIdentity` (`packages/gateway/src/web/auth/session.ts`), `WebOperatorIdentity` (`packages/gateway/src/execute/launch-types.ts`), `WebOperatorActor` (`packages/gateway/src/approvals/registry.ts`).
- **Operator HTTP response shapes (inline literals to name)** — `session-info-route.ts` `{operatorId, login, expiresAt}`; `csrf-route.ts` `{csrfToken}`; `safe-response.ts` `{ok}` / `{error}`.
- **Version-constant precedent** — `OPENCODE_SQLITE_VERSION` (`packages/runtime/src/session/version.ts`) + colocated `version.test.ts` pin; `STORAGE_VERSION = 1` (`packages/runtime/src/shared/constants.ts`, "increment on breaking changes").
- **Effect/Result boundary** — `packages/gateway/AGENTS.md`: gateway is the only `effect` user; exported surface must be plain TS + `Result<T,E>` from `@bfra.me/es/result`; Effect `Schema` confined to `packages/gateway/src/http/announce-schema.ts`.
- **Module convention** — gateway submodules are flat, file-per-concept, no `index.ts` barrel (the dominant pattern across `approvals/`, `web/`, `execute/`, `http/`, `bindings/`); the runtime package uses a barrel for its cross-package public API.

### Institutional Learnings

- `docs/solutions/best-practices/centralize-s3-key-identity-construction-2026-06-09.md` — one owner per type/identity family; consumers import, never re-declare; thread identity as a required param; pin literal values in regression tests; a "must stay in sync" comment is a drift bug.
- `docs/solutions/best-practices/effect-failure-channel-discipline-2026-06-10.md` — Effect Schema stays internal; across the boundary types are plain TS and validation returns `Result`; document the error-channel convention at the seam.
- `docs/solutions/best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md` — version flows from one constant through a typed pipeline; no second copy; track the constant via Renovate.
- `docs/solutions/best-practices/gateway-control-surface-spine-2026-06-15.md` — `ApprovalActor` as a discriminated union (not `string`); scope-equivalence asserted not assumed; characterize-before-cut; collapse-don't-fork (verify zero live references to removed symbols).
- `docs/solutions/best-practices/signed-webhook-ingress-hardening-2026-05-29.md` — no-oracle parse errors: the validator must not echo rejected input values into error reasons.

### External References

- None. The work mirrors strong local patterns (runtime `parseRunState`, `OPENCODE_SQLITE_VERSION`, gateway module layout); no external research needed.

## Key Technical Decisions

- **Contract home: a gateway module, not a published package.** `packages/gateway/src/operator-contract/`. The dashboard references the contract by version; no new publishable `@fro-bot/operator-contract` package yet. (Per #949 scope decision.)
- **Consolidate-only freeze.** Freeze what exists today (lifecycle, approval-decision, authz identity) + version + redaction clause. Net-new command/mission shapes are deferred to their implementing units.
- **Run-state is projected, not re-exported raw — and the projection is redaction-aware.** Define `OperatorRunStatus` exposing only operator-safe fields (`runId`, `entityRef`, `surface`, `phase`, `startedAt`, and a derived `stale: boolean`). Exclude `holder_id`, `thread_id`, `details` by construction (R5, Phase B R12). Re-export `RunPhase`/`Surface` as-is. **Critical (security review):** `entity_ref` is the repo slug `owner/repo#123`; exposing it for a repo redacted in `metadata/repos.yaml` reintroduces the exact leak #950 closes — and the redaction obligation is a *pre-query* gate, so it does not retroactively scrub an already-stored run's status. Therefore `toOperatorRunStatus(runState, opts)` must accept a redaction signal and, for a denylisted repo, return `null` (omit the record) rather than a populated status. `OperatorRunStatus` is documented as a redaction-aware projection, and Unit 6's redaction clause explicitly states the gate applies to status projections, not only to repo-data queries. The `stale` derivation takes an explicit `staleThresholdMs` (no hidden coupling to the runtime default) — the projection is pure over its inputs.
- **The redaction obligation ships a fail-closed structural stub, not just prose (security review).** A documented `REDACTION_OBLIGATION` constant is not an enforceable control. Unit 6 additionally exports a fail-closed `assertRedactionApplied`-style guard that throws by default (`REDACTION_GATE_NOT_IMPLEMENTED`), so the first repo-data endpoint cannot ship a response path that surfaces repo data without either implementing the gate or visibly removing the call (which fails review). This makes the obligation grepable and unskippable while keeping the gate implementation itself deferred. The contract binds redaction to run *alongside* `checkRepoAuthz` (`web/auth/repo-authz.ts`) — both must pass — so the two cannot silently diverge.
- **Canonical `OperatorIdentity` for the genuine duplicate only.** Deepening (architecture review) corrected the over-broad "four sites collapse" framing: only `WebOperatorActor` (`approvals/registry.ts`) and `WebOperatorIdentity` (`execute/launch-types.ts`) are byte-for-byte identical (`kind:'web-operator'`, `githubUserId`, `login`, `sessionCorrelationId`) — those two collapse onto one canonical `OperatorIdentity`. `OperatorAuthContext` (`{githubUserId, sessionId}` — a Hono-context guard result) and `SessionIdentity` (`{githubUserId, login}` — a session-store record) are **semantically distinct** and do NOT belong in the identity union; they only reference the canonical field types (e.g. `OperatorIdentity['githubUserId']`) for consistency. The `ApprovalActor` union stays the transport-variant consumer. This collapse shape is resolved here, not deferred.
- **Decision-state canonicalizes the operator-facing set (corrected mapping).** Deepening (architecture review) found the first mapping wrong. The operator set is `pending | claimed | already_claimed | scope_mismatch | failed_to_settle | unavailable`. The `DecisionOutcome` (`ok | not-found | channel-mismatch | already-claimed | reply-failed`, `approvals/registry.ts`) maps: `ok→claimed`, `channel-mismatch→scope_mismatch`, `already-claimed→already_claimed` (NOT `already_settled` — the first POST is still in-flight, the entry has not settled), `reply-failed→failed_to_settle`, `not-found→unavailable`. `pending` is the implied pre-decision state (open entry, no `DecisionOutcome`). `expired` is **dropped** from the `DecisionOutcome` mapping — it is a deadline/settlement-path state (`SettlementReason 'deadline'`), not a decision outcome; if exposed at all it is derived separately from the deadline path, not from this mapping. The `never` exhaustiveness guard covers exactly the 5 `DecisionOutcome` variants. The mapping is a contract clause with a table-driven test.
- **`PermissionReply` becomes contract-owned via re-export, not re-definition.** The contract is its sole definer; `packages/gateway/src/approvals/coordinator.ts` keeps the existing export path working with `export type { PermissionReply } from '../operator-contract/approval.js'` (re-export — NOT a second `export type PermissionReply = ...`, which would be the exact fork this plan eliminates). This keeps all 9 existing import sites valid without a 9-file change; a note flags the re-export seam as an incremental future migration. `PermissionRequest`/`PermissionReplyEvent`/`SettlementReason` stay in `coordinator.ts` for v1 (11/2/5-file fan-out respectively) with a v1.1-candidate comment. Approval semantics are encoded so a web decision must carry a transport-bound actor — the contract exports a `DecisionInput` type (`actor: ApprovalActor`, no free-form `decidedBy: string`) so the type constraint is load-bearing (R7).
- **Validator: plain-TS + `Result`, Effect-free exported surface (R3).** `parseOperatorX(input: unknown): Result<OperatorX, Error>` with hand-rolled type-guards, mirroring `parseRunState`. No-oracle error reasons (no echo of rejected input). Effect `Schema`, if used at all, stays internal to the module and is never re-exported.
- **Version: a single pinned constant with a breaking-change policy.** `OPERATOR_CONTRACT_VERSION = '1.0.0'` exported from the module + a colocated pin test, mirroring `OPENCODE_SQLITE_VERSION`/`STORAGE_VERSION`. Source comment documents MAJOR=breaking / MINOR=additive / PATCH=doc. Add a Renovate-trackable single source.
- **Module layout matches the gateway's dominant pattern with one deliberate exception.** File-per-concept under `operator-contract/`, but **add a single `index.ts` barrel** as the one stable import point a downstream consumer (dashboard) pins — the contract's whole purpose is to be the import authority, which the runtime package precedent supports.
- **Redaction (#950) is a documented obligation, not an implementation here.** Embed the verbatim invariant + the four operational rules (denylist-before-query; format-stable deny keys; fail-closed; composes alongside `checkRepoAuthz`, not instead of) as a normative clause module. The first repo-data endpoint must satisfy it.

## Open Questions

### Resolved During Planning

- Are `RunPhase`/`RunState` re-declared in the gateway (to delete)? — No. Verified: only imported from runtime. Only `PermissionReply` is gateway-declared, so only it changes owner. (Repo verification, 2026-06-19.)
- Does `metadata/repos.yaml` appear anywhere in this repo today? — No (zero matches). The redaction gate is unimplemented; the contract embeds the obligation + a fail-closed structural stub only.
- Module barrel or flat? — Flat is the gateway norm, but the contract adds a single `index.ts` because its purpose is to be the one import authority. Verified no import-cycle risk: the barrel re-exports `RunPhase`/`Surface` from `@fro-bot/runtime` and runtime cannot import back from the gateway (layer rule).
- Identity-collapse shape — only `WebOperatorActor` + `WebOperatorIdentity` (byte-identical) collapse onto `OperatorIdentity`; `OperatorAuthContext` and `SessionIdentity` are semantically distinct and stay separate, referencing canonical field types only. (Architecture review, 2026-06-19.)
- Do `WebOperatorActor`/`WebOperatorIdentity`/`OperatorAuthContext`/`SessionIdentity` have external consumers that the unit file-lists must cover? — No. Verified zero external by-name consumers; only the `ApprovalActor` union has 3 consumers and stays in place. `PermissionReply` has 9 import sites, all preserved via the coordinator re-export. (Repo blast-radius verification, 2026-06-19.)
- Unit 3 posture (re-export vs migrate): v1 is **re-export only** — the contract adds the operator-facing `OperatorRunStatus` projection and re-exports `RunPhase`/`Surface`; existing direct `@fro-bot/runtime` imports are left in place (migrating them is a deferred, optional follow-up). The Unit 3 goal text is aligned to this.

### Deferred to Implementation

- Whether the OAuth-callback `{githubUserId, login}` shape (`web/auth/github.ts`) and the route-guard `{ok, response}` return union (`web/operator-route.ts`) should also be named in a later v1.1 MINOR — out of scope for v1's 4 named response shapes.
- Whether to later migrate the 3 gateway files that import `RunPhase`/`Surface` directly from `@fro-bot/runtime` (`execute/launch-types.ts`, `runtime-effect.ts`, `execute/recovery.test.ts`) to import from the contract barrel — v1 leaves them as-is (see Unit 3 posture, resolved below).

> Note: two questions the first draft deferred are now resolved by deepening — the identity-collapse shape (only `WebOperatorActor`+`WebOperatorIdentity` collapse; `OperatorAuthContext`/`SessionIdentity` stay distinct) and the Phase B field-name reconciliation (now a Unit 3 precondition, not deferred).

## Output Structure

    packages/gateway/src/operator-contract/
      ├── version.ts            # OPERATOR_CONTRACT_VERSION + increment policy
      ├── version.test.ts
      ├── identity.ts           # canonical OperatorIdentity (+ ApprovalActor reference)
      ├── identity.test.ts
      ├── run-status.ts         # OperatorRunStatus projection; re-exports RunPhase/Surface
      ├── run-status.test.ts
      ├── approval.ts           # PermissionReply (sole definer), decision-state set + DecisionOutcome mapping
      ├── approval.test.ts
      ├── responses.ts          # named operator HTTP response types (SessionInfo, etc.)
      ├── parse.ts              # parseOperatorX(input): Result<T, Error> validators
      ├── parse.test.ts
      ├── redaction.ts          # #950 redaction obligation clause (types + constants, no gate)
      └── index.ts              # single public barrel — the import authority

## Implementation Units

- [x] **Unit 1: Contract version + module skeleton**

  **Goal:** Establish the module home, the pinned contract version, and the public barrel.

  **Requirements:** R1, R2

  **Dependencies:** None

  **Files:**
  - Create: `packages/gateway/src/operator-contract/version.ts`
  - Create: `packages/gateway/src/operator-contract/version.test.ts`
  - Create: `packages/gateway/src/operator-contract/index.ts`

  **Approach:**
  - `OPERATOR_CONTRACT_VERSION = '1.0.0'` with a source comment stating the increment policy (MAJOR=breaking, MINOR=additive, PATCH=doc), mirroring the `STORAGE_VERSION` comment style.
  - `index.ts` re-exports the version now and grows as later units land (the single import authority).
  - Add a Renovate-trackable single source for the constant (or a documented note that the version is human-bumped on breaking changes, like `STORAGE_VERSION`).

  **Patterns to follow:** `packages/runtime/src/session/version.ts` + `version.test.ts`; `STORAGE_VERSION` in `packages/runtime/src/shared/constants.ts`.

  **Test scenarios:**
  - Happy path: `OPERATOR_CONTRACT_VERSION` is exactly `'1.0.0'` (literal pin, like the `OPENCODE_SQLITE_VERSION` test).
  - Happy path: the value is importable from the module barrel `index.ts`.

  **Verification:** the version constant is pinned by test and exported from the barrel; type-check and lint clean.

- [x] **Unit 2: Canonical operator identity**

  **Goal:** Define one `OperatorIdentity` as the sole definer and collapse the duplicated identity sites onto it.

  **Requirements:** R3, R4, R5

  **Dependencies:** Unit 1

  **Files:**
  - Create: `packages/gateway/src/operator-contract/identity.ts`
  - Create: `packages/gateway/src/operator-contract/identity.test.ts`
  - Modify: `packages/gateway/src/execute/launch-types.ts` (have `WebOperatorIdentity` reference the contract type)
  - Modify: `packages/gateway/src/approvals/registry.ts` (have `WebOperatorActor` reference the contract type)
  - Modify: `packages/gateway/src/operator-contract/index.ts` (export identity)
  - Test: `packages/gateway/src/execute/run.test.ts` / existing approval tests stay green (behavior unchanged)

  **Approach:**
  - Canonical `OperatorIdentity` with the `web-operator` shape (`githubUserId: number`, `login: string` (display-only), `sessionCorrelationId: string`), `readonly` throughout, discriminated by `kind` so future variants extend without forking.
  - Collapse ONLY the genuine duplicate: `WebOperatorIdentity` (`execute/launch-types.ts`) and `WebOperatorActor` (`approvals/registry.ts`) are byte-identical — both reference the canonical `OperatorIdentity` so there is one structural definer. Keep the `ApprovalActor` union (`registry.ts`) and `RequesterIdentity` union (`launch-types.ts`) as the transport-variant consumers (unchanged export paths; their 3/0 external consumers keep working).
  - Do NOT fold `OperatorAuthContext` (`{githubUserId, sessionId}`, Hono guard result) or `SessionIdentity` (`{githubUserId, login}`, session record) into the identity union — they are semantically distinct. At most, reference canonical field types (`OperatorIdentity['githubUserId']`) for consistency; no structural relationship, no Modify churn required for v1.
  - Collapse-don't-fork check: no second structural declaration of the `{githubUserId, login, sessionCorrelationId}` triple remains outside the contract; the `web-operator` construct-site literals in `run.test.ts` and `approval-flow.integration.test.ts` stay assignable.

  **Execution note:** characterization-first — confirm the existing approval/launch identity tests are green before the cut, and remain green after (behavior must not change).

  **Patterns to follow:** `centralize-s3-key-identity-construction` (export the type, consumers import); `RequesterIdentity` discriminated-union shape in `launch-types.ts`.

  **Test scenarios:**
  - Happy path: a `web-operator` identity constructed against the contract type satisfies `WebOperatorActor` and `WebOperatorIdentity` structurally (assignability test).
  - Edge case: `login` is documented/typed as display-only (a comment/JSDoc assertion or a type-level note) so it is never treated as an identity key.
  - Integration: existing approval-decision and launch tests remain green after the consolidation (no behavior change).

  **Verification:** one structural definer of the operator identity; dependent sites reference it; all existing approval/launch tests pass.

- [x] **Unit 3: Run-status projection + lifecycle re-export**

  **Goal:** Expose an operator-safe `OperatorRunStatus` projection and make the contract the operator-facing surface for `RunPhase`/`Surface`.

  **Requirements:** R3, R4, R5

  **Dependencies:** Unit 1

  **Files:**
  - Create: `packages/gateway/src/operator-contract/run-status.ts`
  - Create: `packages/gateway/src/operator-contract/run-status.test.ts`
  - Modify: `packages/gateway/src/operator-contract/index.ts`

  **Approach:**
  - **Precondition:** read the Phase B status projection table (`docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md` lines 185-194) and align `OperatorRunStatus` field names + status taxonomy to it before writing, so the frozen v1.0.0 contract does not mismatch the endpoints it governs.
  - Re-export `RunPhase` and `Surface` from `@fro-bot/runtime` through the contract barrel as the operator-facing lifecycle types. **Posture: re-export only** — do not migrate the existing gateway files that import these directly from runtime (left as a deferred follow-up).
  - Define `OperatorRunStatus` carrying only operator-safe fields: `runId`, `entityRef`, `surface`, `phase`, `startedAt`, `stale: boolean`. Exclude `holder_id`, `thread_id`, `details`.
  - Provide a pure, **redaction-aware** `toOperatorRunStatus(runState, opts)` projection (no I/O) where `opts` carries an explicit `staleThresholdMs` (no hidden runtime-default coupling) and a redaction signal. For a denylisted repo (`entity_ref` resolves to a repo redacted in `metadata/repos.yaml`), it returns `null` (omit the record) — never a populated status. This closes the cross-obligation leak: `entity_ref` = `owner/repo#123` would otherwise expose a redacted repo's identity/activity that the pre-query redaction gate does not retroactively scrub.

  **Patterns to follow:** Phase B status mapping (`2026-06-15-002` lines 185-194); pure-projection style; the #950 redaction obligation (Unit 6).

  **Test scenarios:**
  - Happy path: `toOperatorRunStatus` maps each `RunPhase` to the expected operator status and copies operator-safe fields.
  - Security (R5): the projection output type and result contain no `holder_id`, `thread_id`, or `details` (assert keys absent).
  - Security (R5/R6, cross-obligation): a denylisted-repo run yields `null` (record omitted), not a populated status exposing `entityRef`.
  - Edge case: a non-denylisted repo is NOT accidentally omitted (positive control).
  - Edge case: `stale` derives true/false correctly from `last_heartbeat` vs `now` at the `staleThresholdMs` boundary.

  **Verification:** `OperatorRunStatus` excludes internal fields by construction, omits denylisted repos, and is covered by projection tests; field names match the Phase B table; `RunPhase`/`Surface` are re-exported from the barrel.

- [x] **Unit 4: Approval-decision contract + `PermissionReply` ownership**

  **Goal:** Make the contract the sole definer of `PermissionReply` and canonicalize the operator-facing decision-state set with an explicit mapping.

  **Requirements:** R4, R7

  **Dependencies:** Unit 1

  **Files:**
  - Create: `packages/gateway/src/operator-contract/approval.ts`
  - Create: `packages/gateway/src/operator-contract/approval.test.ts`
  - Modify: `packages/gateway/src/approvals/coordinator.ts` (re-import `PermissionReply` from the contract)
  - Modify: `packages/gateway/src/operator-contract/index.ts`

  **Approach:**
  - Define `PermissionReply` (`once|always|reject`) in the contract as the sole definer. `coordinator.ts` MUST keep its export with a re-export — `export type { PermissionReply } from '../operator-contract/approval.js'` — NOT a second `export type PermissionReply = ...`. This preserves all 9 existing import sites (`launch-types.ts`, `registry.ts`, `discord-transport.ts`, `discord/approvals.ts`, plus 5 tests) without a 9-file change. Add a comment marking the re-export as an incremental migration seam.
  - Keep `PermissionRequest`/`PermissionReplyEvent`/`SettlementReason` in `coordinator.ts` (11/2/5-file fan-out) with a `// v1.1 promotion candidate` note in `approval.ts` so the next consolidator sees the seam.
  - Define the operator-facing decision-state set `pending | claimed | already_claimed | scope_mismatch | failed_to_settle | unavailable` and a mapping function from `DecisionOutcome` (`ok→claimed`, `channel-mismatch→scope_mismatch`, `already-claimed→already_claimed`, `reply-failed→failed_to_settle`, `not-found→unavailable`). `pending` is the implied pre-decision state. `expired` is NOT in this mapping (it is a deadline/settlement-path state). The `never` exhaustiveness guard is over the 5 `DecisionOutcome` variants only.
  - Export a `DecisionInput` type (`{ requestID, approvalScopeId, decision: PermissionReply, actor: ApprovalActor }`) so a decision must carry a transport-bound actor by type — no free-form `decidedBy: string`. This makes the R7 constraint load-bearing: any new decision entry point references `DecisionInput`. Add a structural test scanning approval-related functions for a `decidedBy: string` parameter (must find none) and document in AGENTS.md that `registry.handleDecision` is the sole approval gate.

  **Execution note:** characterization-first — existing coordinator/registry tests green before and after the ownership move.

  **Patterns to follow:** `gateway-control-surface-spine` (one fail-closed gate, many transports; actor union not `string`; the `handleDecision` scope-binding/single-winner model is the real enforcement); `comment-only-review-blocked-approval` (verdict coupled to a transport event).

  **Test scenarios:**
  - Happy path: `PermissionReply` imported via the contract still satisfies `coordinator.ts` usage (assignability + all 9 import sites + existing tests green).
  - Happy path: each of the 5 `DecisionOutcome` variants maps to the documented operator decision-state (table-driven test; assert `already-claimed→already_claimed`, NOT `already_settled`).
  - Error path: the mapping is exhaustive over `DecisionOutcome` (a `never` guard fails compilation if a variant is unmapped).
  - Security (R7): a structural test scans approval-decision functions and fails if any accepts a `decidedBy: string` instead of a transport-bound `actor: ApprovalActor`.

  **Verification:** `PermissionReply` has one definer with a working re-export; the 5-variant mapping is correct and exhaustive; `DecisionInput` is exported and the no-`decidedBy` structural test passes; coordinator tests pass unchanged.

- [x] **Unit 5: Named operator response types + validators**

  **Goal:** Publish named types for the already-shipped operator HTTP responses and provide Effect-free runtime validators.

  **Requirements:** R1, R3

  **Dependencies:** Units 1–4

  **Files:**
  - Create: `packages/gateway/src/operator-contract/responses.ts`
  - Create: `packages/gateway/src/operator-contract/parse.ts`
  - Create: `packages/gateway/src/operator-contract/parse.test.ts`
  - Modify: `packages/gateway/src/web/auth/session-info-route.ts` (use the named `OperatorSessionInfo` type)
  - Modify: `packages/gateway/src/operator-contract/index.ts`

  **Approach:**
  - Name the shipped response shapes (`OperatorSessionInfo` = `{operatorId, login, expiresAt}`, plus the csrf/ok/error shapes) as plain TS types; have `session-info-route.ts` use `OperatorSessionInfo` instead of its inline literal + JSDoc.
  - Provide `parseOperatorX(input: unknown): Result<OperatorX, Error>` validators with hand-rolled type-guards mirroring `parseRunState`. Error reasons are no-oracle (do not echo rejected input values). Effect `Schema` is not used on the exported surface.

  **Patterns to follow:** `packages/runtime/src/coordination/run-state.ts` `parseRunState` + `hasValidRunStateShape`; `signed-webhook-ingress-hardening` no-oracle errors.

  **Test scenarios:**
  - Happy path: a valid payload parses to the typed value via `Result.ok`.
  - Edge case: missing/extra fields are rejected deterministically.
  - Security (no-oracle): a captured-logger / collected-error test across ALL validator error paths asserts no input value substring, no token shape (`ghs_`, `ghp_`, `Bearer `), and no session secret (`sessionCorrelationId`, raw cookie value) appears in any error reason — the validator must not echo input at all, even a garbled fragment.
  - Integration: `session-info-route.ts` compiles and its existing tests pass using the named `OperatorSessionInfo` type.

  **Verification:** named response types exported; validators return `Result` with no-oracle errors proven across all error paths; the session-info route uses the contract type; existing route tests pass.

- [x] **Unit 6: Redaction + authorization obligation clauses**

  **Goal:** Embed the #950 redaction obligation and the authorization obligation as normative contract clauses bound to the contract version.

  **Requirements:** R6, R7

  **Dependencies:** Units 1–5

  **Files:**
  - Create: `packages/gateway/src/operator-contract/redaction.ts`
  - Modify: `packages/gateway/src/operator-contract/index.ts`
  - Modify: `docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md` (cross-reference the frozen contract from the consuming units)
  - Modify: AGENTS.md (note the contract module as the operator-surface authority)

  **Approach:**
  - `redaction.ts` exports the obligation as a documented `REDACTION_OBLIGATION` constant + the four operational rules as a normative comment: denylist-before-query; format-stable deny keys (node_id `MDEw…` vs `R_kgDO…` skew, derive numeric database_id); fail-closed; composes alongside `checkRepoAuthz` (both must pass). The clause explicitly states the gate applies to `OperatorRunStatus` projections (not only repo-data queries).
  - **Fail-closed structural stub (security review):** export an `assertRedactionApplied`-style guard whose body throws (`REDACTION_GATE_NOT_IMPLEMENTED`) by default. The first repo-data endpoint must call it (and replace the body with the real gate) — a response path that surfaces repo data without it crashes at runtime, so the obligation is grepable and unskippable. The gate's real implementation stays deferred; only the fail-closed stub + its contract binding ship now. Bind it to run alongside `checkRepoAuthz` (`web/auth/repo-authz.ts`) so authz and redaction cannot diverge.
  - State the authorization obligation: an operator decision/launch carries a transport-bound `OperatorIdentity`/`DecisionInput`; the contract cannot bypass the fail-closed approval gate. Add two documented constraints (security review): the version constant is build-time pinned and never negotiated over the wire (any endpoint reading a version header rejects unrecognized versions fail-closed); `OperatorIdentity` is always constructed server-side from the authenticated session, never deserialized from a request payload.
  - Document, in the contract and AGENTS.md, that the gateway owns this contract, `registry.handleDecision` is the sole approval gate, and the dashboard mock is a non-canonical fixture; downstream consumers pin `OPERATOR_CONTRACT_VERSION`.

  **Test scenarios:**
  - Happy path: `REDACTION_OBLIGATION` is exported, references the four operational rules, and is wired into the barrel.
  - Security: `assertRedactionApplied` throws by default (proves the fail-closed stub is live, not a no-op).
  - Test expectation: the behavioral redaction-gate tests (denylisted-repo leak path, node_id skew, denylist-read-failure fail-closed) ship with the gate implementation (deferred), per #950 acceptance #3.

  **Verification:** the contract exports the redaction + authorization clauses and the fail-closed stub, the barrel surfaces them, AGENTS.md records ownership + the sole-gate + the two documented constraints, and the web-operator plan cross-references the frozen contract.

## System-Wide Impact

- **Interaction graph:** `coordinator.ts` (PermissionReply), `registry.ts` / `launch-types.ts` (identity), `session-info-route.ts` (response type) shift to import from the contract. No control-flow change — only type ownership.
- **Error propagation:** validators return `Result`; no new throw paths across the package boundary. Effect stays internal.
- **State lifecycle risks:** none — no runtime state is added or changed; this is a types/version/docs consolidation.
- **API surface parity:** the contract becomes the single definer; the collapse-don't-fork checks (zero live duplicate declarations) are the parity guarantee.
- **Unchanged invariants:** the fail-closed approval gate, the operator browser guard, all shipped route behavior, and the runtime coordination internals are unchanged. The contract re-exports/projects them; it does not alter them.
- **Sequencing / parallelism:** Unit 1 first (the barrel + version must exist before others export through it). Units 2, 3, 4 have disjoint create-files and disjoint domain Modify-files (`registry.ts`+`launch-types.ts` / none / `coordinator.ts`), but **all three add re-exports to `operator-contract/index.ts`** — the one serialization point. Execute Units 2/3/4 serially, OR develop their create-files in parallel and consolidate every `index.ts` re-export in a single integration step (do not let parallel workers edit `index.ts`). Unit 5's `responses.ts` + `session-info-route.ts` edits are independent of 2/3/4, but `parse.ts` depends on the types from 2/3/4. Unit 6 is last (binds the obligations + barrel + docs).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Consolidating identity types introduces a subtle behavior change in approvals/launch | Characterization-first: existing approval/launch tests green before and after; assignability tests prove structural equivalence. Only the byte-identical `WebOperatorActor`/`WebOperatorIdentity` collapse; distinct types stay separate. |
| Operator status taxonomy drifts from the Phase B projection table | Unit 3 reconciles field names against `2026-06-15-002` lines 185-194 as a **precondition** (not a deferred note) before `v1.0.0` freezes. |
| Freezing `v1.0.0` before command/mission shapes exist invites a premature breaking bump later | Consolidate-only scope + documented MINOR=additive policy: command shapes are additive in a later MINOR, not a breaking change to frozen types. |
| `OperatorRunStatus.entityRef` leaks a denylisted repo's identity/activity (the #950 leak), because redaction is a pre-query gate that does not scrub stored status | **Critical.** The projection is redaction-aware: `toOperatorRunStatus` omits (`null`) a denylisted repo's record; Unit 6's clause states the gate applies to status projections; tests cover the leak path. |
| Redaction obligation documented but gate deferred — a future endpoint could skip it | A fail-closed `assertRedactionApplied` stub throws by default, so a repo-data response path crashes without it (grepable, unskippable); bound to run alongside `checkRepoAuthz`. |
| R7 type constraint isn't load-bearing — a new decision path could take a raw `string` actor outside the contract | Export `DecisionInput` (`actor: ApprovalActor`); a structural test fails on any `decidedBy: string` approval signature; AGENTS.md names `registry.handleDecision` the sole gate. |
| Version-downgrade via a wire-supplied contract version | The version constant is build-time pinned, never negotiated over the wire; an endpoint reading a version header rejects unrecognized versions fail-closed (documented constraint). |
| `OperatorIdentity` deserialized from untrusted request payload | Documented constraint (contract + AGENTS.md): `OperatorIdentity` is always constructed server-side from the authenticated session, never from a request body. |

## Documentation / Operational Notes

- AGENTS.md gains a one-line note: the operator contract module is the authority for operator-surface types; the dashboard client is a non-canonical fixture.
- Consider a follow-up compound solutions doc: "centralize-key pattern applied to type families" (no existing types-ownership doc).

## Sources & References

- **Origin:** [fro-bot/agent#949](https://github.com/fro-bot/agent/issues/949) (Fro Bot triage comment as requirements)
- Related issues: #907 (umbrella), #950 (redaction invariant)
- Related plan: `docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md` (consuming web-operator units 4–6)
- Key code: `packages/runtime/src/coordination/types.ts`, `packages/gateway/src/approvals/{coordinator,registry}.ts`, `packages/gateway/src/web/{operator-route,auth/session,auth/session-info-route}.ts`, `packages/gateway/src/execute/launch-types.ts`, `packages/runtime/src/session/version.ts`
- Learnings: `centralize-s3-key-identity-construction`, `effect-failure-channel-discipline`, `versioned-tool-config-plugin-pattern`, `gateway-control-surface-spine`, `signed-webhook-ingress-hardening`
