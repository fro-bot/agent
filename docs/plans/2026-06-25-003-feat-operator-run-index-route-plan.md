---
title: 'feat: GET /operator/runs run-index route'
type: feat
status: done
date: 2026-06-25
deepened: 2026-06-25
---

> **Status: done.** All 4 units shipped: `RunIndex.listRunsForRepo` + `listWithMetadata` adapter, `RunSummary` contract + projector, `GET /operator/runs` route (`packages/gateway/src/web/operator/runs-route.ts`), and server wiring — all verified on `main`.

# feat: GET /operator/runs run-index route

## Overview

Add a read-only `GET /operator/runs` endpoint that returns a bounded, repo-scoped,
denylist-safe list of run summaries. This lets the dashboard `/operator` page render
existing and in-flight runs (launched earlier, from another surface, or surviving a
reload) instead of only the runs launched in the current browser session.

The endpoint mirrors `GET /operator/repos` (`packages/gateway/src/web/operator/repos-route.ts`)
security posture exactly: session-gated, operator-keyed rate limit, denylist-before-authz,
per-repo authz, hard cap, no-oracle omission, closed DTO, `Cache-Control: no-store, private`.

## Problem Frame

Issue fro-bot/agent#1027 (under epic #907). The operator surface ships launch
(`POST /operator/runs`), per-run stream (`GET /operator/runs/:runId/stream`), approvals,
and repo-listing (`GET /operator/repos`) — but **no run index**. The dashboard's
operator client can resolve a single run (`getRunSnapshot(runId)`) but cannot enumerate
runs, so a freshly-loaded page is "launch-then-observe," not "here is current operator
activity." The triage on #1027 is effectively the spec; this plan implements it.

## Requirements Trace

- R1. `GET /operator/runs` → `200 {runs: RunSummary[]}` — bounded, repo-scoped, newest-first.
- R2. `RunSummary` = `{runId, repo: "owner/name", status: OperatorWebStatus, createdAt, updatedAt?}` —
  additive subset of `OperatorRunStatus`; `repo` from the binding, never raw `entity_ref`.
- R3. Contract bump `OPERATOR_CONTRACT_VERSION` `1.4.0` → `1.5.0` (additive = MINOR).
- R4. Security posture identical to `GET /operator/repos`: denylist-before-authz, no-oracle
  omission, operator-keyed rate limit, fail-closed on missing deny-key, `Cache-Control:
  no-store, private`, token never logged, no internal fields leaked.
- R5. New `RunIndex` enumeration capability (no public list method exists today).
- R6. Route registered and proven mounted — added to `EXPECTED_OPERATOR_ROUTES`, drift-guard
  and dep-gated negative test updated (the #1001 route-unmount class; the route-guard doc
  explicitly names #1027 as the maintenance trigger).

## Scope Boundaries

- No pagination — the hard cap is the contract (mirrors repos).
- No `phase` / `surface` / `stale` / raw `entityRef` (with `#number`) in the summary.
- Does not change the launch / stream / approval contracts.

### Deferred to Separate Tasks

- Dashboard `listRuns()` consumption + fixture removal: separate PR in `fro-bot/dashboard`
  (non-blocking; the dashboard pins `PINNED_CONTRACT_VERSION` and must bump to `1.5.0` in
  lockstep when it consumes the route).
- Epic #907 S1/S2 inbound-surface generalization: separate thread after this lands.

## Key Technical Decisions

- **Authz fan-out — per-repo once, scan only authorized non-denied repos.** Enumerate
  bindings → `filterDeniedRecords` (denylist) → cap → per-binding `checkRepoAuthz` →
  enumerate run-states ONLY for the surviving authorized repos. This bounds GitHub calls
  to binding count (not run count) and means denied/unauthorized repos' run-states are
  never read — tighter than "scan all runs then filter," and mirrors `repos-route.ts`.
- **Run scope — all phases, newest-first, hard-capped.** `MAX_RUNS_PER_LISTING = 100`,
  sorted by `started_at` desc, then truncated. Shows in-flight + recent terminal cards.
- **`RunSummary.repo` from the binding (`owner/repo`), never `entity_ref`.** `entity_ref`
  is `owner/repo#123` and carries the run/entity number. The route already iterates the
  authorized bindings, so it has `owner`/`repo` directly. This is not merely belt-only:
  the binding is the **authorization anchor**, while `entity_ref` is a data-layer record.
  If storage corruption ever made them diverge, the binding is the *correct* value (the
  scope the operator is authorized for). (Deepening confirmed: projecting via the binding
  is strictly safer than deriving repo from `entity_ref`.)
- **Direct `toRunSummary` projection (no per-run redaction re-check) — but WITH a defensive
  entity_ref consistency check.** The binding already passed `filterDeniedRecords` before
  its runs are scanned, so the repo-level denylist gate is satisfied; re-projecting each run
  through `toOperatorRunStatus`'s denylist predicate would redundantly denylist-check the
  *wrong* (data-layer `entity_ref`) source and is rejected. HOWEVER, as a corruption/rename
  guard, `toRunSummary` (or the route's flatten loop) verifies each scanned run's
  `entity_ref` owner/repo matches the repo prefix it was scanned under; on mismatch the run
  is skipped + warn-logged (fail-closed to omission, never abort). (Deepening: architect +
  security both confirmed direct projection is correct and safer; the consistency check
  covers storage corruption and repo-rename edge cases.)
- **`RunIndex` gains a single-repo `listRunsForRepo(repo, opts?)` scanner (not a bulk
  `listForRepos`).** `RunIndex` exposes only `register` + `lookup` today; `readRunsForRepo`
  is file-local. Expose it as `runIndex.listRunsForRepo(repo): Promise<readonly RunState[]>`
  — a single-repo prefix scan, NOT a bulk/collection method. Rationale (deepening, architect):
  a bulk `listForRepos` returning a `Map` adds collection + an implicit "don't touch the
  accelerator" contract to an interface whose documented domain is single-`runId` RESOLUTION
  (accelerator + negative cache + fallback). Exposing the existing single-repo scan primitive
  keeps `RunIndex` cohesive; the route owns the per-repo loop + flatten + sort + cap. It
  flows through `buildOperatorServerInputs` automatically (extend the `Pick<RunIndex, …>` in
  `server.ts` to include `'listRunsForRepo'`). The route's dep is a **required** field on
  `RunsRouteDeps` (type-enforced), so it is NOT the optional-dep silent-unmount class the
  route-guard doc warns about.
- **Per-repo read cap via a new optional `listWithMetadata` adapter method (the correct,
  not-naive cap).** `readRunsForRepo` today reads EVERY run-state object under a repo's
  prefix (no run-state pruning exists), sequential `getObject` — a real scaling cliff (a
  modest deployment exceeds the 8s enumeration timeout in ~weeks) AND a cost vector. The
  fix bounds per-repo reads to the newest K objects. To pick the *newest* K (not an arbitrary
  K by key order), the scan needs each key's `LastModified`, which S3 `ListObjectsV2` already
  returns but the adapter currently discards. Add an OPTIONAL `listWithMetadata?(prefix):
  Promise<Result<{key: string; lastModified: Date}[], Error>>` to `ObjectStoreAdapter`
  (mirroring how `getObject?`/`conditionalPut?` are optional) — only the S3 adapter implements
  it; the existing `list()` signature, `content-sync.ts`, the action tier, and all mocks are
  untouched. `readRunsForRepo` uses `listWithMetadata` when present: sort by `lastModified`
  desc, take top `MAX_RUNS_PER_REPO` (~200), `getObject` only those. Adapters without it fall
  back to the existing `list()` (unbounded) path. (Deepening: perf + security; chosen over
  the naive slice cap because the naive cap could discard the newest runs for an old repo.)

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/web/operator/repos-route.ts` — the exact gate-ordering blueprint
  (auth ctx → rate limit → token → list → denylist filter → cap → per-repo authz → cap →
  closed DTO → Cache-Control). Mirror its structure and its `ReposRouteDeps` shape.
- `packages/gateway/src/web/operator/repos-route.test.ts` — 16-scenario harness to mirror:
  429 rate-limited; rate-limit operator-keyed; rate-limit before enumeration; happy-path
  authorized subset; empty bindings → `[]`; none-authorized → `[]`; R19 omit-unauthorized;
  denylist-before-authz (denied repo never hits `checkRepoAuthz`); coarse 503 on store
  error (body not an array); token not logged; token-missing → non-200; closed-DTO field
  check (no internal fields); cap truncation; contract field types; Cache-Control header;
  401 when no guard installed. Stubs use `vi.fn()`; `findRunsForRepo` injected via a
  `Map<owner/repo, RunState[]>` (mirror `run-index.test.ts` injection).
- `packages/gateway/src/execute/run-index.ts` — `createRunIndex`, file-local
  `readRunsForRepo` (list+getObject+parseRunState), injectable `findRunsForRepo`,
  fail-safe-to-empty per repo, `RUN_INDEX_FALLBACK_TIMEOUT_MS = 8s`.
- `packages/gateway/src/operator-contract/{run-status.ts,repo-summary.ts,version.ts,index.ts}` —
  `PHASE_TO_WEB_STATUS` (all 6 phases mapped), `OperatorWebStatus`, the closed-DTO builder
  pattern (`toRepoSummary` copies fields, never spreads), the version constant + barrel.
- `packages/gateway/src/redaction/surface-gate.ts` — `filterDeniedRecords`, `bindingToRepoKey`.
- `packages/gateway/src/web/server.ts` ~643-668 — the `buildReposRoute` registration block +
  dep guard; `assertAllPrivilegedRoutesWrapped` at ~841; `Pick<RunIndex,…>` at ~169.
- `packages/gateway/src/program.ts` ~360 (`createRunIndex`), ~660 (`buildOperatorServerInputs`
  passes `runIndex` through) — the shared wiring helper; no program.ts change needed for
  Option 1 beyond `runIndex` already flowing.
- `@fro-bot/runtime` `RunState`: `run_id`, `entity_ref` (`owner/repo#N`), `surface`, `phase`,
  `started_at` (ISO), `last_heartbeat` (ISO); `RunPhase` = PENDING|ACKNOWLEDGED|EXECUTING|
  COMPLETED|FAILED|CANCELLED.

### Institutional Learnings

- `docs/solutions/best-practices/dependency-gated-route-registration-guard-2026-06-25.md` —
  **explicitly names `GET /operator/runs` (#1027)** as the maintenance trigger: add to
  `EXPECTED_OPERATOR_ROUTES` in the same PR; wire deps through `buildOperatorServerInputs`,
  never inline; the in-image smoke is the only signal that catches a silently-unmounted route.
- `docs/solutions/best-practices/web-operator-launch-surface-2026-06-20.md` — Rules 2/5/7:
  denylist-before-authz, scoped enumeration order, centralize deny-key via `bindingToRepoKey`,
  operator-keyed rate limit, closed DTO.
- `docs/solutions/best-practices/authenticated-sse-run-observation-2026-06-20.md` — Rule 1
  (no-oracle: a gate that throws degrades to the coarse shape, never 500), Rule 3 (strip
  `#fragment` defensively), Rule 5 (closed DTO).

### External References

- None — local patterns are strong (repos-route is a near-exact blueprint).

## Open Questions

### Resolved During Planning

- Authz fan-out, run scope, RunSummary shape, redaction double-check, RunIndex API shape —
  all resolved above (confirmed with the user in the scoping gate + research convergence).

### Deferred to Implementation

- Whether `updatedAt` is omitted when `last_heartbeat` is empty/unparseable (optional field
  semantics) — decide at projection time; default: omit when not a valid ISO string.
- Exact `MAX_RUNS_PER_REPO` value (~200 is a starting point; large enough to comfortably hold
  the global newest-100 across the per-repo set) — tune at implementation if needed.

## Implementation Units

- [x] **Unit 1: `listWithMetadata` adapter method + `RunIndex.listRunsForRepo` capped scanner**

**Goal:** Expose the existing single-repo run-state scan as a public `RunIndex` method,
bounded to the newest K objects per repo via a new optional metadata-listing adapter method.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Modify: `packages/runtime/src/object-store/types.ts` (add optional `listWithMetadata?`)
- Modify: `packages/runtime/src/object-store/s3-adapter.ts` (implement `listWithMetadata`)
- Modify: `packages/gateway/src/execute/run-index.ts` (expose `listRunsForRepo`; use the cap)
- Test: `packages/runtime/src/object-store/s3-adapter.test.ts` (listWithMetadata)
- Test: `packages/gateway/src/execute/run-index.test.ts` (listRunsForRepo + cap behavior)

**Approach:**
- **Adapter (runtime):** add OPTIONAL `listWithMetadata?(prefix): Promise<Result<{key: string;
  lastModified: Date}[], Error>>` to `ObjectStoreAdapter` (mirror the existing optional
  `getObject?`/`conditionalPut?` pattern — do NOT change the existing `list()` signature, so
  `content-sync.ts`, the action tier, and existing mocks are untouched). Implement in
  `s3-adapter.ts` by capturing `object.LastModified` (already on the `ListObjectsV2` response,
  currently discarded at the `Contents` loop) alongside `object.Key`.
- **Scanner (gateway):** expose `listRunsForRepo(repo: string): Promise<readonly RunState[]>`
  on the `RunIndex` interface + factory. It runs the same prefix scan as the file-local
  `readRunsForRepo`, but when the store adapter provides `listWithMetadata`, it sorts entries
  by `lastModified` desc and reads only the newest `MAX_RUNS_PER_REPO` (~200) via `getObject`;
  when absent, it falls back to the existing unbounded `list()` path. Keep the per-key
  try/catch fail-safe (a bad object is skipped, not fatal). Use the injectable
  `findRunsForRepo` override for tests as today.
- Do NOT touch the accelerator or negative cache — `listRunsForRepo` is a read scan, not a
  `runId` resolution. (Architect: keeps `RunIndex`'s resolution domain cohesive.)

**Patterns to follow:** the file-local `readRunsForRepo` scan; the optional-method pattern of
`getObject?`/`conditionalPut?` in `ObjectStoreAdapter`; the `findRunsForRepo` test injection.

**Test scenarios:**
- Happy path: repo with several runs → returns them (capped/uncapped per adapter support).
- Edge case: repo with no runs → `[]`.
- Error path: a `getObject` for one key fails → that key skipped, others returned (no abort).
- Cap (with `listWithMetadata`): repo with >MAX_RUNS_PER_REPO objects → only the newest
  MAX_RUNS_PER_REPO are read (assert `getObject` call count + that the newest by lastModified
  are the ones read).
- Fallback (no `listWithMetadata`): adapter without the method → uses `list()`, still returns runs.
- Integration: injected `findRunsForRepo` used in tests (no real S3).
- Adapter unit: `listWithMetadata` returns `{key, lastModified}` pairs; paginates like `list()`.

**Verification:** `listRunsForRepo` returns a repo's runs, bounded to the newest K when the
adapter supports metadata listing; a failing key is isolated; accelerator/negative-cache
untouched; the existing `list()` path and its consumers are unchanged.

- [x] **Unit 2: `RunSummary` contract type + projector + version bump**

**Goal:** Add the additive `RunSummary` DTO + a pure closed projector, and bump the contract
version.

**Requirements:** R2, R3

**Dependencies:** None

**Files:**
- Create: `packages/gateway/src/operator-contract/run-summary.ts`
- Test: `packages/gateway/src/operator-contract/run-summary.test.ts`
- Modify: `packages/gateway/src/operator-contract/index.ts` (barrel re-export)
- Modify: `packages/gateway/src/operator-contract/version.ts` (`'1.4.0'` → `'1.5.0'`)
- Modify: `packages/gateway/src/operator-contract/version.test.ts` (pin + title → `1.5.0`)

**Approach:**
- `RunSummary` interface: `{readonly runId; readonly repo; readonly status: OperatorWebStatus;
  readonly createdAt; readonly updatedAt?}`.
- `toRunSummary(runState, binding)` — pure, closed-DTO (copies only safe fields, never spreads
  runState): `runId ← run_id`, `repo ← \`${binding.owner}/${binding.repo}\``,
  `status ← PHASE_TO_WEB_STATUS[phase] ?? 'failed'` (reuse the existing map — export it from
  `run-status.ts` if needed), `createdAt ← started_at`, `updatedAt ← last_heartbeat` (omit when
  empty/unparseable). No `entityRef`, no `phase`/`surface`/`stale`, no internal fields.
- **Defensive entity_ref consistency:** the projector returns `null` when the run's
  `entity_ref` owner/repo does NOT match the `binding`'s `owner/repo` (corruption / repo-rename
  guard). The caller skips null projections + warn-logs (fail-closed to omission). Reuse the
  `entity_ref` owner/repo extraction (`parseEntityRef` in `surface-gate.ts`) and strip any
  `#fragment` before comparison.
- Bump `OPERATOR_CONTRACT_VERSION` to `'1.5.0'`; update `version.test.ts` literal + `it()` title.

**Patterns to follow:** `toRepoSummary` (closed-DTO copy-not-spread); `PHASE_TO_WEB_STATUS`
fail-closed `?? 'failed'`; `toOperatorRunStatus` returning `null` to signal omission.

**Test scenarios:**
- Happy path: each `RunPhase` maps to the correct `OperatorWebStatus` (table-driven, all 6).
- Edge case: `repo` is `owner/name` from the binding, NOT `entity_ref` (assert no `#`).
- Edge case: `updatedAt` omitted when `last_heartbeat` is empty/unparseable; present otherwise.
- Security: output contains only the 5 declared keys — no `entityRef`, `surface`, `phase`,
  `stale`, `thread_id`, `holder_id`, `details` (assert full key set).
- Security (consistency): a run whose `entity_ref` is `ownerB/repoB` projected against a
  binding for `ownerA/repoA` → returns `null` (omitted), warn-logged.
- Unrecognized phase (corrupt data) → `status: 'failed'` (fail-closed, no undefined).

- [x] **Unit 3: `runs-route.ts` → `GET /operator/runs` (TDD)**

**Goal:** The route itself, mirroring `repos-route.ts` gate ordering exactly.

**Requirements:** R1, R4

**Dependencies:** Unit 1 (enumeration), Unit 2 (projector)

**Files:**
- Create: `packages/gateway/src/web/operator/runs-route.ts`
- Test: `packages/gateway/src/web/operator/runs-route.test.ts`

**Execution note:** Test-first — write the gate-ordering and no-oracle scenarios before the
handler, mirroring `repos-route.test.ts` exactly.

**Approach:** `buildRunsRoute(app, deps)` registering `GET /operator/runs`. Gate ordering:
1. Read auth ctx (guard set it) — `undefined` → 401 fallback.
2. Operator-keyed rate limit (`RUNS_RATE_LIMIT_PER_MIN = 20`, key = `String(githubUserId)`,
   after auth ctx, before enumeration) → `rateLimitedResponse(c)`.
3. Resolve OAuth token → `undefined` → 401.
4. `listBindings()` → store error/throw → coarse `503 {error:'unavailable'}` (no partial leak).
5. `filterDeniedRecords(bindings, bindingToRepoKey, isRepoDenied)` — denylist BEFORE authz.
6. `capped = allowed.slice(0, MAX_REPOS_AUTHZ_FANOUT)` (mirror repos' 100 authz-fanout cap).
7. Per-binding `checkRepoAuthz` → keep authorized (silent omit on denial/throw, no oracle).
8. For each authorized binding: `runIndex.listRunsForRepo(\`${owner}/${repo}\`)` → that repo's
   run-states (capped to the newest `MAX_RUNS_PER_REPO`). A per-repo scan error is isolated
   (skip that repo, continue) — never a 500.
9. Project each run via `toRunSummary(runState, binding)`; **drop `null` results** (the
   entity_ref-consistency guard omits corrupt/mismatched runs).
10. Flatten; sort newest-first by `createdAt` (started_at desc); `slice(0, MAX_RUNS_PER_LISTING)`.
11. `c.header('Cache-Control','no-store, private')`; `return c.json({runs}, 200)`.

Constants: `MAX_RUNS_PER_LISTING = 100`, `MAX_RUNS_PER_REPO = 200`,
`RUNS_RATE_LIMIT_PER_MIN = 20`, `RUNS_RATE_WINDOW_MIN_MS = 60_000`. `RunsRouteDeps` mirrors
`ReposRouteDeps` PLUS the per-repo enumerator (`listRunsForRepo`, a REQUIRED field — not an
optional `OperatorServerDeps` field). A gate that throws degrades to the coarse shape — never a 500.

**Timeout/newest-first caveat (documented, accepted):** the per-repo loop reads sequentially.
With the per-repo cap (Unit 1) the worst-case read count is bounded (authorized-repo count ×
`MAX_RUNS_PER_REPO`), so for this single-operator deployment the loop completes well within
budget. The plan does NOT add a mid-loop wall-clock timeout to the route (the per-repo cap is
the bound); if a future high-binding deployment needs one, returning a partial set would make
"newest-first" only locally true — note this honestly rather than silently truncating.

**Patterns to follow:** `buildReposRoute` end-to-end; `repos-route.test.ts` harness +
`findRunsForRepo` injection.

**Test scenarios:**
- Happy path: bindings with runs, 2 authorized → `200 {runs:[…]}` only for authorized repos.
- Edge case: empty bindings → `200 {runs: []}`; none authorized → `200 {runs: []}`.
- Security: denylist-before-authz — denied repo's runs never scanned, `checkRepoAuthz` never
  called for it, denied repo's runId/entity never in the body (assert full body string).
- R19: unauthorized repo's runs silently omitted (no oracle).
- Edge case: hard-cap truncation — >100 runs across authorized repos → exactly 100, newest-first.
- Error path: `listBindings` fails → coarse 503, body NOT an array.
- Error path: token missing → 401; rate-limited → 429 (operator-keyed; enumeration not reached).
- Security: token never logged (inspect warn ctx — no `token`/`oauthToken` keys).
- Security: closed DTO — response items have only `{runId, repo, status, createdAt, updatedAt?}`.
- Contract: `Cache-Control: no-store, private` header set.
- Edge case: 401 when no guard installed (bare Hono app).

- [x] **Unit 4: Wire into `server.ts` + route-registration proof + docs**

**Goal:** Register the route, prove it mounts (the #1001 class), update docs.

**Requirements:** R6

**Dependencies:** Unit 3

**Files:**
- Modify: `packages/gateway/src/web/server.ts` (extend `Pick<RunIndex,…>` to include
  `listRunsForRepo`; add the gate block + `buildRunsRoute` call)
- Modify: `packages/gateway/src/web/operator-route-smoke.ts` (add `{GET, /operator/runs}` to
  `EXPECTED_OPERATOR_ROUTES`)
- Modify: `packages/gateway/src/web/server.test.ts` (bump drift-guard `v1.4.0`→`v1.5.0` titles;
  add `not.toContain('GET:/operator/runs')` to the dep-gated negative test)
- Modify: `deploy/README.md` + `packages/gateway/AGENTS.md` (operator API route table row)

**Approach:**
- Register `buildRunsRoute(app, {...})` alongside `buildReposRoute`, behind the same dep guard
  (browserGuard + sessionStore + denylistCache + listBindings + allowlist + auditLogger) PLUS
  `runIndex !== undefined`. Reuse the `const clock = deps.sessionDeps?.clock ?? (() => Date.now())`
  pattern, the shared `repoAuthzCache`, and `bindingToRepoKey`/`filterDeniedRecords`.
- Extend `Pick<RunIndex, 'lookup' | 'register'>` (server.ts ~169) to include `'listRunsForRepo'`.
  No `program.ts` change beyond `runIndex` already flowing through `buildOperatorServerInputs`.
- Add the new route to `EXPECTED_OPERATOR_ROUTES` (the maintenance rule); the `server.test.ts`
  drift guard + the in-image `operator-route-smoke` then assert it mounts.
- Update the operator API surface table in `deploy/README.md` + `packages/gateway/AGENTS.md`.

**Patterns to follow:** the `buildReposRoute` registration block + dep guard; the
route-registration-guard doc's "wire through the helper, add to the canonical constant" rule.

**Test scenarios:**
- Integration: the v1.5.0 drift-guard equality test passes with 12 routes (was 11).
- Integration: the dep-gated negative test asserts `GET:/operator/runs` absent when its gate
  deps are missing.
- Verification (in-image): `operator-route-smoke` reports the new route present.

**Verification:** `bun run --filter @fro-bot/gateway check-types|lint|test` green; the in-image
`operator-route-smoke` lists 12 routes; gateway-only (no runtime/action/root dist drift);
`deploy/README.md` + `AGENTS.md` tables updated.

## System-Wide Impact

- **Interaction graph:** new route consumes `runIndex` (already wired for run-stream/decisions/
  approvals), `sessionStore`, `denylistCache`, `listBindings`, `repoAuthzDeps`. No new
  program-scoped instance.
- **Error propagation:** store/enumeration errors → coarse 503; a thrown gate → coarse shape,
  never 500 (no-oracle).
- **API surface parity:** mirrors `GET /operator/repos` — the same security invariants apply;
  the contract bump is consumed by the dashboard (separate PR, lockstep `PINNED_CONTRACT_VERSION`).
- **Unchanged invariants:** launch/stream/approval contracts unchanged; `OperatorRunStatus`
  unchanged (`RunSummary` is additive); `RunIndex.register`/`lookup` behavior unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| New route silently unmounts (the #1001 class) | Add to `EXPECTED_OPERATOR_ROUTES`; drift-guard + dep-gated negative test + in-image smoke. `listRunsForRepo` is a required dep (type-enforced), not the optional-dep unmount class. |
| `entity_ref` (`owner/repo#N`) leaks a denylisted repo's identity | Project `repo` from the binding (the authz anchor), never `entity_ref`; binding passes `filterDeniedRecords` before its runs are scanned; `RunSummary` excludes `entity_ref`. |
| Cross-repo run misattribution (storage corruption / repo rename) | `toRunSummary` returns `null` when a scanned run's `entity_ref` owner/repo doesn't match the binding's repo → omitted + warn-logged (fail-closed). |
| Unbounded per-repo `getObject` cost (no run-state pruning; objects accumulate forever) | Per-repo read cap `MAX_RUNS_PER_REPO` (newest-K via `listWithMetadata` `LastModified` sort) bounds reads regardless of accumulation; operator-keyed rate limit (20/min); per-repo authz cap (100) bounds the repo set. Adapters without `listWithMetadata` fall back to the existing path. Operationally, an S3 lifecycle rule deleting terminal run-states is recommended for long-lived deployments. |
| Contract drift with the dashboard | Dashboard PR bumps `PINNED_CONTRACT_VERSION` to `1.5.0` in lockstep (deferred, non-blocking). |

## Documentation / Operational Notes

- Long-lived deployments accumulate terminal run-state objects (no application-level pruning).
  Recommend an S3 lifecycle rule deleting terminal run-state objects after N days as the
  zero-code operational mitigation; the per-repo read cap bounds per-request cost regardless.
- Dashboard consumer (separate PR) must bump `PINNED_CONTRACT_VERSION` to `1.5.0` in lockstep.

## Sources & References

- Issue: fro-bot/agent#1027 (triage comment is the spec); epic #907.
- Blueprint: `packages/gateway/src/web/operator/repos-route.ts` (+ `.test.ts`).
- Learnings: `docs/solutions/best-practices/dependency-gated-route-registration-guard-2026-06-25.md`,
  `web-operator-launch-surface-2026-06-20.md`, `authenticated-sse-run-observation-2026-06-20.md`.
