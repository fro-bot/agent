---
title: "feat: Operator control-surface documentation and smoke coverage (Unit 8)"
type: feat
status: active
date: 2026-06-23
origin: docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md
---

# feat: Operator control-surface documentation and smoke coverage (Unit 8)

## Overview

The Gateway operator control-surface spine is functionally complete — the authenticated SSE run-stream (#962), web launch + repo selector (#968), lifecycle admission (#966), output streaming (#965), and web tool-approvals (#986) all shipped at operator contract `v1.4.0`. The remaining planned unit (Unit 8 of the operator control-surface plan) makes the surface operable and reviewable: the operator documentation drifted behind the shipped routes, there is no single operator runbook, and CI does not assert the privileged operator routes register in the built image.

This is closeout work — documentation and a thin registration smoke — not new runtime behavior.

## Problem Frame

Per the reconciled operator control-surface plan (`docs/plans/2026-06-15-002-...`), Unit 8 is the only remaining open item. Three concrete gaps (verified against `main` `95efb9320`):

1. **`deploy/README.md` operator API surface table is stale.** The table (under `### Operator API surface`) stops at `GET /operator/session` and omits every route shipped in 4b/5/6: `GET /operator/repos`, `POST /operator/runs`, `GET /operator/runs/:runId/stream`, `POST /operator/runs/:runId/approvals/:requestId/decision`, and `GET /operator/runs/:runId/approvals`. An operator reading the deploy docs cannot discover the launch/observe/approve surface.
2. **No consolidated operator runbook.** The original plan referenced a `docs/solutions/best-practices/gateway-web-operator-auth-...` doc that was never created. Operator setup knowledge is scattered across `deploy/README.md` sections and per-feature solution docs.
3. **CI does not assert operator routes in the built image.** `gateway-smoke` builds the Docker image and asserts config-load / no-module-crash, but does not assert the privileged operator routes register. Per-route behavior is covered by unit tests (`packages/gateway/src/web/**/*.test.ts`), and `server.test.ts` pins route registration at the unit level — but nothing proves the *built/deployed* image exposes the operator surface.

## Requirements Trace

- R1. The `deploy/README.md` operator API surface table lists every shipped privileged operator route with method, path, auth requirement, and purpose.
- R2. A single operator-facing runbook exists that an operator can follow end-to-end to deploy, configure OAuth, and understand the operator API surface, cross-linking the existing deploy/README sections rather than duplicating them.
- R3. CI asserts the privileged operator routes register when their deps are present (registration-level smoke), without requiring a live OAuth/GitHub backend.
- R4. No runtime/route behavior changes — documentation, one runbook doc, and test/CI additions only. `dist/` and the gateway runtime are untouched.
- R5. Existing route-registration and topology pins (`server.test.ts`, the announce/operator ingress assertions referenced in `deploy/README.md`) remain green and are extended (not weakened) if they assert the operator surface shape.

## Scope Boundaries

- No new operator routes, no contract changes, no `OPERATOR_CONTRACT_VERSION` bump.
- No live end-to-end OAuth/GitHub integration test in CI (the operator routes need a session + GitHub backend; that is out of scope for a registration smoke).
- No change to the sandbox-net topology ingress pin (the operator surface is on `gateway-net`, not sandbox-net reachable — that pin stays narrow by design).

### Deferred to Separate Tasks

- Dashboard consumer UX (`fro-bot/dashboard#81`, `#48`): separate repo, separate work.
- The web-approval polish follow-ups (note #173: e2e approval integration test, audit permission category, truncation signal, ordering test): a separate gateway hardening pass, not Unit 8.

## Context & Research

### Relevant Code and Patterns

- `deploy/README.md` — `## Operator OAuth (Web Surface)` (~line 261) and `### Operator API surface` table (~lines 303-314). The table format (method / path / auth / purpose) is the pattern to extend.
- `packages/gateway/src/web/server.ts` — `OperatorServerDeps` and the conditional route registration: privileged routes register only when their deps (`launchWorkDeps`, `runIndex`, `denylistCache`, `bindingsLookup`, browser guard, etc.) are present. The exact gating is the source of truth for R1's auth column and R3's registration assertions.
- `packages/gateway/src/web/server.test.ts` — existing registration pin (`registers GET /operator/health and no other routes`, and the OAuth-deps-present variant). The pattern for asserting the registered route set from a built app instance.
- The shipped route modules: `packages/gateway/src/web/operator/repos-route.ts`, `launch-route.ts`, `decision-route.ts`, `pending-approvals-route.ts`, and `packages/gateway/src/web/sse/run-stream-route.ts` — authoritative for method/path/auth of each route.
- `.github/workflows/ci.yaml` `gateway-smoke` (~line 251) — the existing image smoke; R3's registration smoke either extends this job or rides on the gateway unit-test suite.

### Institutional Learnings

- `docs/solutions/best-practices/` gateway docs (control-surface spine, authenticated SSE, web launch surface) — the runbook should cross-link these rather than restate them.
- The deploy/README already documents the operator OAuth setup; R2's runbook consolidates and points at it, avoiding duplication drift.

## Key Technical Decisions

- **Runbook lives in `deploy/README.md` as the canonical operator surface, with a thin pointer doc — not a duplicate.** The deploy README is already the operator's deploy reference. Rather than a second source of truth that will drift (the exact failure mode of the stale table), R2 is satisfied by completing the deploy/README operator section and adding a short consolidated index/runbook that links to it. Avoid duplicating route tables in two files.
- **Registration smoke, not behavioral E2E.** R3 asserts the routes *register* (the deployed image exposes the surface), reusing the `server.test.ts` registration-introspection pattern with all privileged deps present. A full behavioral smoke would need a live GitHub OAuth backend — out of scope and low marginal value given per-route unit coverage.
- **Derive the route list from source, not by hand.** The R1 table and R3 assertion should both be grounded in the actual registered routes (introspected from the Hono app) so they cannot silently drift again — prefer a test that enumerates registered operator routes and asserts the expected set, which doubles as drift protection for the docs.

## Open Questions

### Resolved During Planning

- Is Unit 7 (read-only bindings) part of this? → No, cut and superseded by `GET /operator/repos` (recorded in the reconciled plan).
- Does the ingress/topology pin need updating? → No. That pin asserts the sandbox-net-reachable surface (`POST /v1/announce` + `GET /operator/health`); the privileged operator routes are on `gateway-net`, intentionally outside that pin.

### Deferred to Implementation

- Exact home/filename of the consolidated runbook pointer (a `deploy/` section vs a `docs/solutions/` index) — decide when touching the files, favoring the option that minimizes duplication.
- Whether the registration smoke is a new CI step in `gateway-smoke` or a gateway unit test that the existing test job already runs — pick the lighter wiring that still proves the built surface.

## Implementation Units

- [ ] **Unit 1: Complete the deploy/README operator API surface table**

**Goal:** The operator API table lists every shipped privileged route with accurate method, path, auth, and purpose.

**Requirements:** R1, R5

**Dependencies:** None

**Files:**
- Modify: `deploy/README.md` (the `### Operator API surface` table and surrounding prose)

**Approach:**
- Add rows for `GET /operator/repos` (Session — scoped, denylist-filtered repo list), `POST /operator/runs` (Session + CSRF — launch), `GET /operator/runs/:runId/stream` (Session — SSE run observation), `POST /operator/runs/:runId/approvals/:requestId/decision` (Session + CSRF — write-gated approval decision), and `GET /operator/runs/:runId/approvals` (Session — pending-approvals enumeration).
- Source each route's exact path/method/auth from `packages/gateway/src/web/server.ts` registration and the route modules. Note the write-gated routes require repo write/admin authz beyond session.
- Add a one-line note that the operator surface is contract `v1.4.0` and that all routes return a generic not-found for unauthorized/redacted/unknown to avoid an existence oracle.

**Patterns to follow:** the existing table rows (lines 309-314) — same column shape.

**Test scenarios:** Test expectation: none — documentation-only change. (Drift protection is provided by Unit 3's registration test.)

**Verification:** The table matches the routes registered in `server.ts`; no shipped operator route is missing.

- [ ] **Unit 2: Consolidated operator runbook / index**

**Goal:** A single entry point an operator follows to deploy and operate the web surface, linking the deploy/README sections and relevant solution docs without duplicating them.

**Requirements:** R2

**Dependencies:** Unit 1

**Files:**
- Modify: `deploy/README.md` (add a short "Operator runbook" index section near the operator surface) OR Create: a short `docs/` pointer — decide during implementation to minimize duplication.

**Approach:**
- Provide an ordered path: deploy the gateway image → set `GATEWAY_OPERATOR_PUBLIC_ORIGIN` and OAuth env → register the GitHub OAuth app callback → operator allowlist → verify with `GET /operator/health` and an OAuth login → the operator API surface (link to the Unit 1 table).
- Cross-link the existing gateway operator solution docs rather than restating their content.

**Patterns to follow:** the existing `## Operator OAuth (Web Surface)` section structure.

**Test scenarios:** Test expectation: none — documentation-only.

**Verification:** An operator can follow one document end-to-end; no route/env table is duplicated across two files (single source of truth).

- [ ] **Unit 3: Operator route-registration smoke / drift guard**

**Goal:** A test asserts the full privileged operator route set registers when all deps are present, doubling as drift protection for the deploy/README table.

**Requirements:** R3, R5

**Dependencies:** Unit 1 (the expected route set is the documented set)

**Files:**
- Modify: `packages/gateway/src/web/server.test.ts` (add a case enumerating registered operator routes with all privileged deps present, asserting the expected `v1.4.0` set)
- Modify (if a built-image assertion is chosen): `.github/workflows/ci.yaml` `gateway-smoke` — optional thin step asserting the operator routes register in the built bundle.

**Approach:**
- Build a server instance with all privileged deps supplied (mirroring the existing `server.test.ts` deps fixtures), introspect the registered routes, and assert the set equals `{health, auth start, auth callback, logout, session, session/csrf, repos, runs, runs/:id/stream, runs/:id/approvals/:id/decision, runs/:id/approvals}`.
- Prefer the unit-test assertion (runs in the existing gateway test job) over a new Docker step unless a built-image assertion adds real value; the goal is drift protection, not behavioral E2E.
- Keep the assertion exact so a future added/removed route forces a deliberate update of both the test and the deploy/README table.

**Execution note:** Write the registration assertion test-first against the documented set, then confirm it matches the actual `server.ts` registration.

**Patterns to follow:** `server.test.ts` route-introspection (`registers GET /operator/health and no other routes`).

**Test scenarios:**
- Happy path: with all privileged deps present, the registered operator route set equals the expected `v1.4.0` set.
- Drift guard: an unexpected extra route or a missing expected route fails the assertion (verify by temporary injection during development, then remove).
- Edge: with only OAuth deps present (no launch/runIndex/denylist), the privileged run/approval routes do NOT register (matches the conditional gating) — confirms the assertion is dep-accurate, not vacuous.

**Verification:** The test fails if the operator surface drifts from the documented set; it passes against current `main`; it does not require a live OAuth/GitHub backend.

## System-Wide Impact

- **Interaction graph:** `deploy/README.md`, `packages/gateway/src/web/server.ts` (read-only, source of truth), `server.test.ts`, possibly `.github/workflows/ci.yaml`.
- **API surface parity:** none — no routes added or changed.
- **Unchanged invariants:** operator contract `v1.4.0`, all route behavior, the sandbox-net topology ingress pin, and `dist/` all stay exactly as shipped. This unit only documents and pins the existing surface.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| The deploy/README table drifts again after the next route change | Unit 3's exact registration assertion forces a deliberate update of both test and docs when the route set changes. |
| Runbook duplicates the route table and re-introduces drift | KTD: single source of truth — the runbook links to the deploy/README table, it does not restate it. |
| Registration assertion is vacuous (passes regardless) | Unit 3 includes a dep-gated negative case proving the assertion reflects actual conditional registration. |

## Documentation / Operational Notes

- This unit IS the documentation deliverable; after it lands, update the rollout tracker (`fro-bot/.github#3512`) to record the operator control-surface spine as documentation-complete.

## Sources & References

- **Origin document:** `docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md` (Unit 8)
- Related code: `deploy/README.md` operator section; `packages/gateway/src/web/server.ts`; `packages/gateway/src/web/server.test.ts`; the operator route modules.
- Related PRs: #962 (4b), #968 (5), #966, #965, #986 (6); reconciliation PR #994.
