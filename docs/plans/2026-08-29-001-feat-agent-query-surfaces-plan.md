---
title: 'Agent query surfaces: allowlist output and operator dispatch route'
type: feat
status: active
date: 2026-08-29
---

# Agent query surfaces: allowlist output and operator dispatch route

## Overview

Two capabilities are writable but not readable by agents: the brokered-push allowlist (configurable via `brokered-push-extra-paths`, discoverable only by failing a delivery) and workflow dispatch (invocable via Discord `/fro-bot dispatch`, whose structured nine-variant `DispatchOutcome` is collapsed into prose no agent can parse, with no programmatic route at all). This plan adds the read/query side of both, plus grounded doc corrections.

## Problem Frame

Session notes #314 and #292: the agent-native review of #1489 flagged the write-only allowlist (conf 0.94); the Unit-7A review flagged the Discord-only dispatch surface, the prose-collapsed outcome, and the absent audit record. Recon confirmed the seams: `setActionOutputs` already has a JSON-valued output precedent, and `DispatchWorkflow` (`packages/gateway/src/github/dispatch.ts`) is already transport-neutral — the web route reuses it without touching GitHub logic.

## Requirements Trace

- R1. An agent can read the resolved effective brokered-push allowlist from a run's outputs without attempting delivery.
- R2. The serialized allowlist derives from the same definitions enforcement uses — representation cannot drift from behavior.
- R3. An operator-web client can invoke workflow dispatch and receive the structured `DispatchOutcome`, gated identically to the launch route.
- R4. An accepted or failed dispatch leaves a typed audit event keyed by repo and outcome (runId when present), with no task text or install URLs.
- R5. ARCHITECTURE.md Invariant 8 and gateway AGENTS.md state the denylist invariant the code actually enforces.

## Scope Boundaries

- Discord command behavior unchanged — `outcomeCopy()` is already presentation over the structured outcome.
- No denylist *enforcement* change on Discord surfaces (note #293's other half — separate decision).
- No durable dispatch run-state or completion notification (Unit 7B territory, `docs/plans/2026-08-22-001-feat-gateway-dispatch-command-plan.md`).
- No SSE projection of dispatch events.

## Context & Research

### Relevant Code and Patterns

- `src/harness/config/outputs.ts:5-22` — `setActionOutputs`; `output-mode-migration` is the JSON-output precedent. Normal emission at `src/harness/phases/finalize.ts:184` (bootstrap inputs in scope); early exits use `setUnavailableActionOutputs` (`src/harness/run.ts:54`).
- `src/features/delegated/brokered-push-validation.ts:10-11` — `BROKERED_PUSH_ALLOWED_PATHS` regexes + `BROKERED_PUSH_ALLOWED_ROOT_FILES`, currently unexported.
- `packages/gateway/src/web/operator/launch-route.ts` — canonical route: guard → rate limit → session token → parse → `getBindingByRepo` → denylist → `checkRepoAuthz` → execute; coarse 404s; plain async Hono (no Effect at route level); `registerOperatorRoute` mandatory.
- `packages/gateway/src/github/dispatch.ts:19-47,211-224` — nine-variant `DispatchOutcome`; `DispatchWorkflow` signature `(owner, repo, task) => Promise<DispatchOutcome>`; instance built at `program.ts:418-424`.
- `packages/gateway/src/web/audit.ts` — typed in-process audit events via `emitAudit()` (sanitizing, sink-failure-swallowing); `launch.accepted`/`launch.rejected` precedent.
- `launch-route.test.ts` — test template: guard/CSRF, rate limit, binding/denylist/authz failures, malformed bodies, happy path, security projections.

### Institutional Learnings

- Representation-vs-enforcement drift is this repo's recurring failure (response-file deny-rule incident; #1493's nested-surface gap): R2 exists because of it.
- `verify-behavior-not-signal-2026-08-23.md` — tests must assert the serialized output content and the route's response body, not branch entry.
- `web-operator-launch-surface-2026-06-20.md` — operator write routes: server-owned resolution, denylist before authz, coarse pre-acceptance denials; the new route mirrors these verbatim.
- `authenticated-sse-run-observation-2026-06-20.md` — no-oracle discipline: every pre-acceptance denial collapses to the same coarse response.
- `key-credential-switch-on-operation-input-not-audit-token-2026-07-17.md` — auth and gating never key off correlation/audit identifiers.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/ plus packages/gateway/src/",
  "freshness": {
    "vcs_reference": "672251aa8"
  },
  "budget": {
    "max_search_passes": 2,
    "max_candidate_inspections": 5,
    "exhausted": true
  },
  "candidates": [
    {
      "path_or_symbol": "src/harness/config/outputs.ts:setActionOutputs",
      "description": "Central output emission with JSON-valued precedent (output-mode-migration).",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/gateway/src/web/operator/launch-route.ts",
      "description": "Canonical guarded operator route owning the gate ordering, validation, and coarse-error contract.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/gateway/src/github/dispatch.ts:createWorkflowDispatcher",
      "description": "Transport-neutral dispatch with the structured outcome union; reused as-is.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "packages/gateway/src/web/audit.ts:emitAudit",
      "description": "Typed sanitizing audit seam; gains one event kind.",
      "disposition": "extend"
    }
  ]
}
```

## Key Technical Decisions

- **Allowlist output serializes the enforcement sets themselves**: export the default path patterns and root files from `brokered-push-validation.ts` (or relocate to the shared module) and derive the JSON from them; a test pins that every serialized pattern admits/denies in agreement with `validateBrokeredPushFiles`. Hand-written lookalike strings are forbidden — that is the guard-vs-claim drift class.
- **Finalize-only emission**: the output appears alongside `resolved-output-mode` in normal runs and is empty on early-exit paths — consistent with existing output semantics, no threading through `setUnavailableActionOutputs`. *(Confirmed at scope gate.)*
- **Flat `200 + {outcome}` for all nine dispatcher outcomes**: the structured union is the contract this route exists to expose; HTTP statuses are reserved for transport failures (auth 404-coarse, malformed 400, rate limit 429, capacity 503). Mapping outcome classes onto statuses would re-collapse the union. *(Confirmed at scope gate.)*
- **Gate ordering copied from launch-route verbatim**: binding lookup → denylist → authz — because the denylist predicate consumes binding deny keys, it cannot run earlier; docs are corrected to say what the code enforces (denylist before any authz/GitHub query).
- **Audit event carries outcome discriminant + runId + repo key only**: no task text, no install URLs, no full outcome payload. Repo identity follows the `launch.accepted` precedent (non-redacted repos only — the denylist gate precedes dispatch), and **no audit event fires on a denylist denial**, so redacted identity never reaches the audit stream. Correlation IDs are generated per-request, never the operator session ID (opaque secret — established gateway rule), and nothing keys auth on them.
- **Route accepts an idempotency key** mirroring launch-route's guard: a network-retry double-POST must not fire two workflow runs. Fire-and-forget to GitHub makes this the only dedup point.
- **Empty output means unresolved, not empty allowlist**: early-exit runs emit `''` for `brokered-push-allowlist` (consistent with `resolved-output-mode`); README documents that consumers must treat empty/absent as "not resolved" — a `{}` would falsely claim an empty policy.
- **Serialized pattern language is documented**: `*` in a default path means exactly one path segment (matching the enforcement regex `[^/]+`); README states this so consumer-side glob libraries don't reinterpret it as unbounded depth. The drift-pin test enforces agreement.
- **Extra-prefix count is capped at parse time** (loud failure), bounding output size and serialization cost.

## Open Questions

### Deferred to Implementation

- Exact route path (`/operator/dispatch` vs nested under runs): follow whatever `registerOperatorRoute` conventions suggest at the code.
- Rate-limit numbers: mirror launch-route's shape; exact ceilings at implementation.

## Implementation Units

- [x] **Unit 1: `brokered-push-allowlist` action output**

**Goal:** Agents read the effective allowlist from run outputs. (R1, R2)

**Dependencies:** None

**Files:**
- Modify: `src/features/delegated/brokered-push-validation.ts` or `src/shared/brokered-push-paths.ts` (export/serialize), `src/harness/config/outputs.ts`, `packages/runtime/src/shared/types.ts` (`ActionOutputs`), `src/harness/phases/finalize.ts`, `action.yaml` (outputs block), `README.md` (outputs table)
- Test: `src/harness/config/outputs.test.ts`, `src/harness/phases/finalize.test.ts`, serializer test colocated with its module

**Test scenarios:**
- Happy: output JSON contains default paths, root files, and configured extras; extras empty → defaults only.
- Drift pin: every serialized default pattern string, converted back to a probe path, agrees with `validateBrokeredPushFiles` (admit for pattern-derived paths, deny for a mutated sibling).
- Edge: early-exit runs emit the output empty (pin one unavailable path).
- Integration: full `runFinalize` emits the output with extras threaded from bootstrap inputs.

**Verification:** an agent can parse the output JSON and predict admissibility of a candidate path without a delivery attempt.

- [x] **Unit 2: operator-web dispatch route + audit event**

**Goal:** Programmatic dispatch with structured outcome. (R3, R4)

**Dependencies:** None (parallel with Unit 1; different package)

**Files:**
- Create: `packages/gateway/src/web/operator/dispatch-route.ts` + `.test.ts`
- Modify: `packages/gateway/src/web/server.ts` (deps + registration), `packages/gateway/src/web/audit.ts` (event kind), `packages/gateway/src/program.ts` (pass existing `dispatchWorkflow` into operator deps), `packages/gateway/AGENTS.md` if route inventory is documented
- Test: route test mirroring `launch-route.test.ts` groups

**Approach:** copy launch-route's shape exactly (guard, operator-keyed rate limit, session token, JSON validation, `owner/repo` validation, binding → denylist → authz, coarse 404s); call the injected `DispatchWorkflow`; return `200 {outcome}` for every dispatcher outcome; `emitAudit` a `dispatch.completed` event (outcome discriminant, repo key, correlationId, runId when present). Do not touch `buildDispatchSpec()` or any Discord code.

**Test scenarios:**
- Happy: accepted outcome returns 200 with `runId`/`runUrl` when present; audit event emitted with discriminant + runId.
- Accepted WITHOUT runId (GitHub 204-no-details path) returns 200 `{outcome:'accepted'}` cleanly; audit event omits runId; README documents the client contract for this state.
- Idempotency: same key twice → one dispatcher call; guard behavior mirrors launch-route.
- Registration: the privileged-route wrapping smoke test (`operator-route.test.ts`) receives dispatch deps so the route actually registers and is asserted wrapped — optional-dep omission must not silently skip it.
- No audit event emitted on denylist denial (pin).
- Every non-accepted variant returns 200 with its discriminant intact (parametrize all nine).
- Error paths: unauthenticated → coarse 404; denylisted binding → coarse 404 with no GitHub call (pin call order); malformed body → 400; rate limit → 429.
- Security projections: response and audit contain no task text echo, no install URLs in audit, no binding internals.
- Integration: guard rejection (CSRF/session) before any dependency is consulted.

**Verification:** an agent can POST a dispatch and branch on `outcome` without scraping prose; denylist ordering pinned by test.

- [x] **Unit 3: doc corrections + plan hygiene**

**Goal:** Docs state enforced reality. (R5)

**Dependencies:** None

**Files:**
- Modify: `ARCHITECTURE.md` (Invariant 8: operator-surface scope + "binding → denylist → any authz/GitHub query"), `packages/gateway/AGENTS.md` (same correction), `action.yaml`/`README.md` (`duration` describes milliseconds), `docs/product/FEATURES.md` (stale output list), `docs/plans/2026-08-28-001-feat-brokered-push-path-opt-in-plan.md` (`status: done`)

**Test expectation: none** — docs and metadata only; markdown link check must stay green.

## System-Wide Impact

- **Interaction graph:** output emission is additive in finalize; the route is additive in `buildOperatorApp`. No trigger, routing, Discord, or workspace surface touched.
- **API surface parity:** this PR *is* the parity fix; after it, both capabilities are readable and writable by agents.
- **Error propagation:** dispatcher outcomes pass through untranslated; route transport errors follow launch-route's coarse contract. Audit sink failures are swallowed by design.
- **Unchanged invariants:** one comment per invocation; gate ordering; `DispatchWorkflow` internals; Discord command contract; denylist enforcement scope (docs corrected, behavior unchanged).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Serialized allowlist drifts from enforcement | R2 drift-pin test; serialization derives from exported enforcement definitions |
| New route widens operator surface | Identical gate stack to launch-route, pinned by tests including call-order |
| Audit event leaks request content | Event carries discriminant + repo key + runId only; security-projection test |

## Sources & References

- Session notes #314, #292, #293; recon lanes exp-1/exp-2 (2026-08-29)
- Related PRs: #1493 (allowlist opt-in), #1469 (dispatch Unit 7A)
- Related plan: `docs/plans/2026-08-22-001-feat-gateway-dispatch-command-plan.md`
