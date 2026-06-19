---
title: "feat: Gateway metadata/repos.yaml redaction gate (denylist-before-query)"
type: feat
status: completed
date: 2026-06-19
completed: 2026-06-19
origin: https://github.com/fro-bot/agent/issues/950 (Fro Bot triage comment as requirements)
---

# Gateway `metadata/repos.yaml` redaction gate (denylist-before-query)

## Overview

Make gateway operator endpoints honor the shared `metadata/repos.yaml` redaction policy: a repo redacted in the denylist (but visible to the gateway's GitHub App installation) must never appear in operator output and must never trigger a per-repo query. This replaces the operator contract's fail-closed `assertRedactionApplied` stub with a real denylist-before-query gate, backed by a denylist the gateway reads from `fro-bot/.github@data:metadata/repos.yaml`.

The load-bearing design constraint (from the design review): the denylist is keyed by GitHub `database_id` / `node_id`, but the gateway only stores `owner/repo` for its bindings and runs. Resolving `owner/repo → id` at surface time **is** the per-repo query the invariant forbids. So the gateway must capture the repo's `database_id` + `node_id` **at ingest** (when a legitimate App query already happens) and persist them on the binding and run-state, making the surface-time denylist check a pure in-memory lookup with no GitHub call.

## Problem Frame

The dashboard already enforces a cross-source redaction guard (`fro-bot/dashboard` `src/github/metadata.ts`): installation/App visibility must never re-derive private repos that `metadata/repos.yaml` redacted (denylist-before-query, fail-closed). The gateway is a new surface for the same data. Its `checkRepoAuthz` proves *operator → repo* access through GitHub's App/installation view — exactly the channel that can see private repos by their real names. So the first operator endpoint that surfaces repo/run/binding data would reintroduce the leak the dashboard closed. This must land before those endpoints (the Phase B SSE / binding-read units) ship.

The metadata source of truth lives in `fro-bot/.github@data` (`metadata/repos.yaml`); the dashboard is the reference implementation; this repo is the new surface that must adopt the invariant.

## Requirements Trace

- R1. Gateway operator endpoints that surface repo data never include a repo redacted in `metadata/repos.yaml`.
- R2. The denylist check happens **before** any per-repo query (binding lookups, run-state reads, status/mission projections) — never at render time, and never via a surface-time GitHub call to resolve the repo's identity.
- R3. The gate **fails closed**: an unreadable/parse-failed/schema-mismatched denylist, a redacted entry with no usable deny key, or a surfaced record whose own deny key is unknown → deny/omit. Never an unfiltered union.
- R4. The gate composes **alongside** `checkRepoAuthz`, not instead of it: authz proves the operator may see a repo; redaction proves the repo is not hidden by policy. Both must pass.
- R5. Deny-key matching is format-stable: match `database_id` (primary) and `node_id` (secondary), handling node_id format skew; exact node_id-only matching is insufficient.
- R6. Redacted owner/name are never stored, logged, or returned anywhere in the gateway (only deny keys are retained).
- R7. Tests exercise the cross-source leak path: a denylisted repo visible via the App channel must not appear and must not trigger a per-repo query.

## Scope Boundaries

- This plan does not build any operator endpoint that surfaces repo data — it makes the gate + denylist available and replaces the stub. The first consumer is the Phase B SSE route (`docs/plans/2026-06-15-002-...` Unit 4b).
- This plan does not change `checkRepoAuthz` behavior; it adds a parallel gate.

### Deferred to Separate Tasks

- **Backfill of ACTIVE bindings is IN SCOPE (Unit 2)** — a controlled offline/admin path resolves deny keys for active bindings before the first operator consumer ships, so the gate is not functionally empty. Backfill of *inactive/archived* bindings (and any non-binding legacy record) is deferred; until resolved, those records fail closed (omitted), never via a surface-time query.
- The canonical shared-invariant text in `fro-bot/.github`: a cross-repo coordination follow-up (Fro Bot's note). This plan keeps the gateway's `REDACTION_OBLIGATION` as the agent-side authority and cross-links the dashboard learning.

## Context & Research

### Relevant Code and Patterns

- **Reference implementation (mirror, do not copy verbatim):** `fro-bot/dashboard` `src/github/metadata.ts` — `readRepoMetadata(reader)` returns `{publicRepos, redactedNodeIds, redactedDatabaseIds}`; injectable `MetadataReader`; `deriveDatabaseId(nodeId)` (legacy base64 → numeric id, `R_` format → null); fail-closed error taxonomy (`MetadataUnavailableError` 404 / `MetadataParseError` / `MetadataSchemaError` / `MetadataTransportError`); redaction = `private: true` OR `owner === '[REDACTED]'`; only deny keys retained. Constants `DATA_REF = 'data'`, `METADATA_PATH = 'metadata/repos.yaml'`.
- **Dashboard learning:** `fro-bot/dashboard` `docs/solutions/security-issues/cross-source-redaction-denylist-before-query-2026-06-15.md`.
- **Gateway App client:** `packages/gateway/src/github/app-client.ts` — `createAppClient` / `authForRepo(owner, repo)`; discovery `GET /repos/{owner}/{repo}/installation` already returns repo data; `AppClientAuthResult` currently surfaces only `octokit`/`installationId`/`token`.
- **Gateway ingest points:** `packages/gateway/src/discord/commands/add-project.ts` (repo validation + binding write); `packages/gateway/src/bindings/types.ts` (`RepoBinding` = owner/repo/channel/workspace today); `packages/gateway/src/execute/run.ts` (`createRun`, writes `entity_ref` + details).
- **Run identity:** `packages/runtime/src/coordination/types.ts` `RunState` (`entity_ref`, `details`; no repo id today).
- **Contract obligation (already shipped):** `packages/gateway/src/operator-contract/redaction.ts` — `REDACTION_OBLIGATION`, fail-closed `assertRedactionApplied` stub; `packages/gateway/src/operator-contract/run-status.ts` — `toOperatorRunStatus` with `isRepoDenylisted: (entityRef: string) => boolean` (predicate shape changes here).

### Institutional Learnings

- `docs/solutions/best-practices/centralize-s3-key-identity-construction-2026-06-09.md` — one owner per identity/key family; thread the key through as a required param.
- `docs/solutions/best-practices/signed-webhook-ingress-hardening-2026-05-29.md` — no-oracle errors: never echo redacted owner/name into errors/logs.
- The dashboard learning (above) is the primary reference.

### External References

- None needed — the dashboard reference implementation is the authority.

## Key Technical Decisions

- **Deny-key matching: `database_id` primary, `node_id` secondary; missing or underivable key → deny.** The denylist build (mirroring the dashboard) produces `redactedDatabaseIds: Set<number>` and `redactedNodeIds: Set<string>`. A surfaced repo is denied if its stored `databaseId ∈ redactedDatabaseIds` OR its `nodeId ∈ redactedNodeIds`. A record with neither a usable stored `databaseId` nor `nodeId` is **denied** (fail closed) — never resolved via a fresh GitHub query.
- **`R_`-format cross-skew is fail-closed at denylist-build time (P1 from review).** `deriveDatabaseId` returns null for `R_`-format node_ids. If a *redacted* entry yields neither a numeric `database_id` (direct or derived) — i.e. an `R_`-only entry — then node_id-only matching is format-fragile: a surfaced repo recorded under a different node_id format for the same repo would miss both keys and leak. Therefore: **every redacted entry MUST contribute a usable numeric `database_id` (direct or derived); a redacted entry that cannot is a denylist schema error → the whole load fails closed.** This guarantees the stable cross-format key exists for every denied repo. (The dashboard's `repos.yaml` carries `database_id` on redacted entries, so this is an assertion, not a new burden — but the gate must enforce it rather than silently degrade to node_id-only.)
- **Deny keys are GATEWAY-LOCAL — stored on `RepoBinding`, NOT on the shared `RunState` (Fork 2 / feasibility P2).** `RunState` lives in the shared `packages/runtime` package used by the action tier; adding deny-key fields there is a cross-package contract change with action-side blast radius. Instead, the repo's `database_id` + `node_id` are stored only on `RepoBinding` (gateway-only). At surface time, the gateway resolves a run/record to its binding (which it already does via the bindings store) and reads the binding's deny keys. No shared-runtime change; no run-creation copy.
- **Capture deny keys at ingest via a repo-identity query, not at surface time (P0 ingest-call fix).** The repo's `database_id` + `node_id` are captured when `add-project` validates the repo. **Correction from review:** `GET /repos/{owner}/{repo}/installation` returns only the installation id + permissions — NOT repo identity. Capture requires an explicit `GET /repos/{owner}/{repo}` (returns `id` + `node_id`) issued during the add-project flow where a legitimate repo query already happens. Persist the result on the binding. Surface-time redaction is then a pure in-memory set lookup with zero GitHub calls — satisfying denylist-before-query.
- **Denylist filtering is the FIRST step in EVERY surface-time working-set builder (P1 from review).** Not just `toOperatorRunStatus`. Any operator path that enumerates bindings or runs (binding-list, run-list, counts) must apply the denylist filter at the TOP of the working-set build — before any per-repo query, name resolution, or projection — so a denied repo is never queried or partially surfaced. The gate is a shared precondition, not a projection-time afterthought.
- **Cross-surface inventory + no-oracle across ALL paths (P1/P2 from review).** The redaction obligation is not only the operator projection. This plan inventories every gateway repo-bearing surface (operator endpoints, but also error/log paths, counts, and — for awareness — Discord replies / announce / audit that echo repo identity) and ensures a denied repo's owner/name never appears in output, errors, or logs. Operator-surface denial paths use sanitized, repo-agnostic messages; tests assert redacted owner/name never appear in logs/error text. (Non-operator surfaces like Discord replies operate on operator-initiated bound repos and are noted in the inventory; gating them beyond the operator surface is scoped explicitly per finding.)
- **Canonical identity at ingest to survive rename/transfer (P1 from review).** Capture the repo's immutable GitHub numeric `id` (`database_id`) and `node_id` from one canonical query at ingest, and normalize the same way the denylist build does. Document that a repo renamed/transferred *after* ingest keeps its stable numeric id (GitHub ids are immutable across rename), so the deny-key match holds; only a repo *recreated* under a new id is a distinct entity. Tests cover the rename case (same id) explicitly.
- **Reader: injectable, App-client Contents fetch of `.github@data:metadata/repos.yaml`.** Mirror the dashboard's `MetadataReader` injection (tests inject a fake; production injects a real reader over the gateway App client's Contents API). Prefer the App client over the object-store — the object-store would create a second source of truth needing sync/integrity machinery.
- **Fail-closed with bounded last-known-good grace, NOT instant deny-all (Fork 1 / P0 DoS).** Pure deny-all-on-read-failure makes `.github@data` a single availability kill-switch for the whole operator plane — a transient outage or an attacker-induced fetch failure would take down all repo-bearing responses. Instead: cache the parsed denylist; on a *refresh* failure, keep serving against the **last successfully-loaded denylist for a bounded grace window** (e.g. a small multiple of the TTL) while emitting **hard alarms**; only after the grace window expires does the gate deny all. **Cold-start (never successfully loaded) still denies all** — there is no last-known-good to fall back to. This separates confidentiality from availability and bounds the stale-redaction window (documented accepted risk; the SSE 4b authz-lease re-check further bounds long-lived streams).
- **Cache simplicity (P3 scope):** the in-memory cache is a single parsed denylist with a TTL + the bounded-grace behavior above. Background pre-fetch is optional, not required for v1 — a lazy refresh on read after TTL expiry (with the grace fallback) is sufficient. Avoid extra refresh choreography.
- **Predicate shape changes from `entityRef: string` to a repo-identity object.** `toOperatorRunStatus`'s `isRepoDenylisted` becomes `(repoKey: {databaseId: number | null; nodeId: string | null}) => boolean`; the gateway supplies the keys it resolved from the binding. `entity_ref` text is not a stable deny key. **Contract classification: this is an ADDITIVE-but-signature-changing change to an unconsumed function** — `toOperatorRunStatus` has no production consumer yet (only tests + the SSE plan, not yet implemented), so changing its predicate parameter is not a breaking change to any live consumer. The contract version is bumped per the contract's own policy (minor, since no shipped consumer breaks); the SSE plan's Unit 4a is reconciled in lockstep. (Decision pinned — no longer "decide MAJOR vs additive at implementation.")
- **Fail-closed taxonomy mirrors the dashboard, with hardening differences.** Reuse the dashboard's error model (unavailable/parse/schema/transport; redacted entry with no usable numeric deny key → schema error → stop). Do NOT copy the dashboard aggregator's "denylist incomplete but continue with warning" behavior — for the operator surface, an incomplete/partial-parse/unknown deny key denies (the whole load fails closed; never partial-continue). The operator API is more sensitive (active run/binding state).
- **Gate replaces `assertRedactionApplied` and backs `isRepoDenylisted`.** The contract's throwing stub becomes a real call into the gate; `REDACTION_OBLIGATION` stays the documented agent-side authority, cross-linking the dashboard learning. `checkRepoAuthz` is untouched and runs alongside (both must pass).
- **Redacted owner/name never retained.** The denylist build keeps only `node_id`/`database_id` for redacted entries (the dashboard already does this); the gateway never logs or stores a denied repo's owner/name. No-oracle error messages everywhere.

## Open Questions

### Resolved During Planning

- Can the gateway do denylist-before-query without a surface-time query? — Only by capturing `database_id`/`node_id` at ingest and storing them on binding + run-state; the current `owner/repo`-only model cannot (design review, source-verified).
- Does `repos.yaml` carry owner/repo for redacted entries to match on? — No; redacted entries set `owner: '[REDACTED]'`. Deny keys are `node_id` + `database_id`, both present.
- Reader source? — Gateway App-client Contents fetch of `.github@data`, injectable; not the object-store.
- Fail-closed on missing deny key? — Deny (the most security-sensitive safe direction).

### Deferred to Implementation

- Exact persistence shape for `databaseId`/`nodeId` on `RepoBinding` (new explicit fields vs a typed sub-object) and the run-state copy — decide at implementation, favoring explicit typed fields over `details: Record<string, unknown>` guesses.
- The precise denylist cache invalidation/refresh mechanism (background timer vs lazy-on-read with TTL) — decide at implementation.

## Output Structure

    packages/gateway/src/redaction/
      ├── metadata-reader.ts      # readRepoDenylist(reader) → Result<RepoDenylist, MetadataError>; deriveDatabaseId; error taxonomy
      ├── metadata-reader.test.ts
      ├── denylist.ts             # in-memory denylist cache (TTL, fail-closed refresh) + isRepoDenied(repoKey) predicate
      ├── denylist.test.ts
      └── reader-app-client.ts    # production MetadataReader over the gateway App client Contents API

## Implementation Units

- [x] **Unit 1: Repo deny-key persistence on bindings (gateway-local)**

  **Goal:** Add `databaseId` + `nodeId` to the gateway's `RepoBinding` so a repo's deny keys are available at surface time without a query. The shared `RunState` is NOT changed (Fork 2).

  **Requirements:** R2, R5

  **Dependencies:** None

  **Files:**
  - Modify: `packages/gateway/src/bindings/types.ts` (add `databaseId?: number`, `nodeId?: string` to `RepoBinding` + validation)
  - Modify: `packages/gateway/src/bindings/store.ts` (persist/read the new fields)
  - Test: `packages/gateway/src/bindings/store.test.ts`

  **Approach:**
  - Add explicit optional typed fields for the repo's GitHub numeric `databaseId` and string `nodeId` to `RepoBinding` only. Optional because legacy bindings won't have them (they fail closed until backfilled by Unit 2b).
  - **Do NOT touch `packages/runtime/src/coordination/types.ts` `RunState`** — it is shared with the action tier. The gateway resolves a run's repo to its binding at surface time (it already maps runs to repos) and reads the deny keys from the binding. This keeps the change gateway-local with no action-tier blast radius.
  - Keep the fields out of any operator-facing projection (`OperatorRunStatus` must not expose them — they are deny keys, internal).
  - Backward compatible: absence is valid and means "no usable deny key" (→ denied at the gate).

  **Test scenarios:**
  - Happy path: a binding with `databaseId`/`nodeId` round-trips through the store.
  - Edge case: a binding without the fields parses (legacy compatibility) and resolves to "no deny key."
  - Security: the deny-key fields are not present on `OperatorRunStatus` (assert keys absent).

  **Verification:** bindings can carry repo deny keys gateway-locally; the shared `RunState` is untouched; legacy bindings remain valid and resolve to "no deny key."

- [x] **Unit 2: Capture deny keys at ingest + active-binding backfill**

  **Goal:** Capture the repo's `database_id` + `node_id` when `add-project` validates the repo, persist on the binding; and backfill the deny keys for existing ACTIVE bindings so the gate is functional for the current corpus (Fork 3).

  **Requirements:** R2

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `packages/gateway/src/github/app-client.ts` (add a narrow repo-identity accessor returning `{databaseId, nodeId}` via `GET /repos/{owner}/{repo}`)
  - Modify: `packages/gateway/src/discord/commands/add-project.ts` (capture ids during the existing repo-validation flow, write to the binding)
  - Create: `packages/gateway/src/bindings/backfill-deny-keys.ts` (offline/admin backfill of active bindings)
  - Test: `packages/gateway/src/discord/commands/add-project.test.ts`, `packages/gateway/src/github/app-client.test.ts`, `packages/gateway/src/bindings/backfill-deny-keys.test.ts`

  **Approach (ingest, P0 corrected):**
  - **`GET /repos/{owner}/{repo}/installation` returns only installation id + permissions — NOT repo identity** (verified). Add a narrow accessor that issues `GET /repos/{owner}/{repo}` (returns `id` + `node_id`) within the add-project validation flow, where a legitimate repo query already happens. Do NOT add any new GitHub call at run-creation or surface time.
  - Thread the captured `{databaseId, nodeId}` into the binding write. Capture the immutable numeric `id` so a later rename/transfer (which preserves the id) still matches the denylist (canonical-identity decision).

  **Approach (backfill, Fork 3):**
  - A controlled, offline/admin backfill (`backfill-deny-keys.ts`) enumerates ACTIVE bindings lacking deny keys and resolves each via the same narrow repo-identity accessor, writing the keys back. This runs OUTSIDE the operator surface (admin-invoked, not a per-request path), so it is not a denylist-before-query violation. It must run before the first operator consumer (4b) ships so the gate is not functionally empty for existing installs.

  **Execution note:** capture-at-ingest is the security-load-bearing seam — test that no NEW GitHub call is added at run-creation/surface time (the ids come from the binding). The backfill is the only place an `owner/repo → id` query happens for existing records, and it is admin/offline.

  **Test scenarios:**
  - Happy path: `add-project` stores `databaseId`/`nodeId` (from `GET /repos/{owner}/{repo}`) on the new binding.
  - Security: surface-time / run-creation paths issue NO GitHub call to resolve repo identity (keys come from the binding).
  - Rename: a binding whose repo was renamed after ingest still matches by the immutable numeric id.
  - Backfill: an active binding missing deny keys gets them populated by the backfill; the backfill is not invoked from any request path.

  **Verification:** new bindings carry deny keys captured at ingest via the correct repo query; active legacy bindings are backfilled offline before the first consumer; no surface-time identity query exists.

- [x] **Unit 3: Denylist reader (mirror dashboard, fail-closed)**

  **Goal:** Read and parse `metadata/repos.yaml@data` into a denylist of `redactedDatabaseIds` + `redactedNodeIds`, with the dashboard's fail-closed taxonomy.

  **Requirements:** R3, R5, R6

  **Dependencies:** None (parallel with 1/2)

  **Files:**
  - Create: `packages/gateway/src/redaction/metadata-reader.ts`
  - Create: `packages/gateway/src/redaction/metadata-reader.test.ts`
  - Create: `packages/gateway/src/redaction/reader-app-client.ts`

  **Approach:**
  - Mirror `fro-bot/dashboard` `src/github/metadata.ts`: injectable `MetadataReader`, `readRepoDenylist(reader): Result<RepoDenylist, MetadataError>` returning `{redactedNodeIds: Set<string>, redactedDatabaseIds: Set<number>}` (the gateway does NOT need `publicRepos`). Port `deriveDatabaseId` (legacy base64 → numeric, `R_` → null). Redaction = `private: true` OR `owner === '[REDACTED]'`. Retain only deny keys; never store/log redacted owner/name (no-oracle errors).
  - Fail-closed taxonomy: 404/missing → unavailable; parse failure → parse error; version mismatch → schema error; redacted entry with no usable deny key → schema error (stop); transport → transport error. ALL error paths return `err(...)`, nothing throws.
  - `reader-app-client.ts`: a production `MetadataReader` over the gateway App client's Contents API for `fro-bot/.github`, ref `data`, path `metadata/repos.yaml`; signals 404 via the not-found sentinel.

  **Patterns to follow:** dashboard `metadata.ts` (verbatim structure for the reader + `deriveDatabaseId` + error taxonomy), adapted to drop `publicRepos`.

  **Test scenarios:**
  - Happy path: a valid `repos.yaml` yields the expected `redactedDatabaseIds` + `redactedNodeIds`; public entries contribute nothing.
  - Format skew: a legacy base64 node_id derives the numeric `database_id` into the set; an `R_`-format node_id yields a null derivation (node_id still in the set).
  - Fail closed: 404 → unavailable err; malformed YAML → parse err; wrong version → schema err; redacted entry with no node_id AND no database_id → schema err (stop).
  - Security: no error message or log contains a redacted entry's owner/name.

  **Verification:** the reader produces a correct denylist from valid input and fails closed (err, no throw) on every error path, never leaking redacted owner/name.

- [x] **Unit 4: Denylist cache + `isRepoDenied` predicate**

  **Goal:** Cache the parsed denylist with a short TTL (fail-closed on refresh failure) and expose the `isRepoDenied(repoKey)` predicate the gate uses.

  **Requirements:** R2, R3, R5

  **Dependencies:** Unit 3

  **Files:**
  - Create: `packages/gateway/src/redaction/denylist.ts`
  - Create: `packages/gateway/src/redaction/denylist.test.ts`

  **Approach:**
  - In-memory cache of the parsed denylist with a ~5-minute TTL, lazy refresh on read after expiry (no required background timer — P3 simplification).
  - **Fail-closed with bounded last-known-good grace (Fork 1 / P0 DoS):**
    - **Cold start** (never successfully loaded) → **deny all** (no last-known-good).
    - **Refresh failure with a prior good load** → keep serving against the **last-known-good denylist for a bounded grace window** (e.g. `GRACE = k × TTL`, small k) while emitting **hard alarms** (logged at error + a metric). After the grace window elapses without a successful refresh → **deny all**.
    - This bounds the availability blast radius: a transient `.github@data` outage does not instantly nuke every repo-bearing operator response, but a sustained failure still fails closed.
  - `isRepoDenied(repoKey: {databaseId: number | null; nodeId: string | null}): boolean` — true if `databaseId ∈ redactedDatabaseIds` OR `nodeId ∈ redactedNodeIds`. A `repoKey` with neither a usable databaseId nor nodeId → **true (denied)**.
  - Pure lookup at call time — no I/O on the hot path (I/O only on lazy refresh).

  **Test scenarios:**
  - Happy path: a repoKey matching a redacted databaseId or nodeId is denied; a non-redacted repoKey is allowed.
  - Security: a repoKey with `{databaseId: null, nodeId: null}` is denied (fail closed on missing key).
  - Fail closed (cold start): before any successful load → deny all.
  - Grace window: a refresh failure after a prior good load serves last-known-good within the grace window (and emits an alarm); past the grace window → deny all.
  - Edge case: lazy refresh after TTL takes the updated denylist; a repo newly added to the denylist is denied after refresh.

  **Verification:** the predicate is a pure in-memory lookup; denies on match or missing key; cold-start fails closed; refresh failure serves bounded last-known-good with alarms, then fails closed past the grace window.

- [x] **Unit 5: Wire the gate into the contract + every working-set builder**

  **Goal:** Replace `assertRedactionApplied`'s stub, change `isRepoDenylisted` to the repo-key shape, resolve deny keys from the binding, and apply the denylist filter as the FIRST step in every operator working-set builder — composing alongside `checkRepoAuthz`.

  **Requirements:** R1, R2, R3, R4, R5

  **Dependencies:** Units 1, 4

  **Files:**
  - Modify: `packages/gateway/src/operator-contract/redaction.ts` (`assertRedactionApplied` satisfied by the real denylist check; keep `REDACTION_OBLIGATION` + cross-link the dashboard learning)
  - Modify: `packages/gateway/src/operator-contract/run-status.ts` (`isRepoDenylisted` becomes `(repoKey) => boolean`)
  - Create/Modify: the gateway helper that resolves a run/record → its binding deny keys → `isRepoDenied` (the surface-time bridge; binding lookup, gateway-side)
  - Modify: `packages/gateway/src/operator-contract/run-status.test.ts`, `packages/gateway/src/operator-contract/redaction.test.ts`
  - Modify: `docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md` (reconcile Unit 4a's `isRepoDenylisted` consumer to the new shape)

  **Approach:**
  - Change `toOperatorRunStatus` so its redaction predicate takes the repo's deny keys (`{databaseId, nodeId}`) rather than `entityRef` text. The gateway supplies the keys by resolving the run → its binding (gateway-side) and reading the binding's deny keys. The projection still omits (returns null) a denied repo before any field read.
  - **Denylist-filter-first (P1 from review):** for any operator path that builds a working set from multiple records (binding-list, run-list, counts), apply the denylist filter at the TOP of the working-set build — before any per-repo query, name resolution, or projection — so a denied repo is never queried or partially surfaced. This plan establishes the filter helper; the actual list endpoints (Phase B) call it first. (No operator list endpoint ships here; the helper + the contract path do.)
  - Replace `assertRedactionApplied`'s default throw with a real check that the denylist gate ran and passed for the repo being surfaced.
  - **Contract classification (pinned, P2 from review):** the predicate-shape change is to `toOperatorRunStatus`, which has NO production consumer yet (only tests + the not-yet-implemented SSE plan). So it is not breaking to any live consumer; bump the contract version per its own policy (minor) and reconcile the SSE plan's Unit 4a in lockstep. (No longer "decide MAJOR vs additive at implementation.")

  **Execution note:** characterization-first against the existing run-status/redaction tests; verify the omission-before-field-read invariant survives the shape change.

  **Test scenarios:**
  - Happy path: `toOperatorRunStatus` for a non-denied repo returns a populated status; for a denied repo (matching deny key) returns null.
  - Security (R4): a repo that passes authz but is denylisted is still omitted (both gates independent; redaction wins).
  - Security: a record whose binding has no deny keys is omitted (fail closed).
  - Security (R2): the working-set filter helper excludes denied records BEFORE any per-repo query (assert no query for the denied record).
  - Contract: the predicate-shape change is reflected in the contract version + the SSE plan consumer.

  **Verification:** the contract consumes the real denylist via binding-resolved repo keys, omits denied/keyless repos before any query, composes alongside authz, and the stub no longer ships.

- [x] **Unit 6: Cross-source leak tests + obligation docs**

  **Goal:** Prove the cross-source leak path is closed (no output AND no query for a denylisted repo) and document the invariant + backfill need.

  **Requirements:** R1, R2, R6, R7

  **Dependencies:** Units 2, 5

  **Files:**
  - Create: `packages/gateway/src/redaction/redaction-gate.integration.test.ts`
  - Modify: `packages/gateway/AGENTS.md` (note the redaction gate + denylist source + fail-closed posture; cross-link the dashboard learning)
  - Modify: `packages/gateway/src/operator-contract/redaction.ts` (REDACTION_OBLIGATION cross-link if not already)

  **Approach:**
  - Integration test: a repo redacted in a fixture `repos.yaml`, present via the (faked) App channel, with a binding carrying that repo's deny keys → the operator projection omits it AND the test asserts no GitHub call was made to resolve/surface that repo (assert the App client / Octokit is not called for the denied repo — per the dashboard learning's "test the client is not called" rule).
  - **Cross-surface inventory (P1 from review):** inventory every gateway repo-bearing surface (operator endpoints, working-set/list/count builders, error/log paths) and assert a denied repo's owner/name never appears in output, errors, or logs. Note Discord-reply/announce/audit paths in the inventory: these operate on operator-initiated bound repos; document whether each is in/out of scope for this gate and why (the operator surface is the in-scope target; auxiliary surfaces are inventoried for awareness with explicit scope notes).
  - node_id cross-format skew: a redacted entry with only an `R_`-format node_id is rejected at denylist-build (fail closed); a redacted entry with a numeric `database_id` matches a surfaced repo regardless of the surfaced repo's node_id format.
  - Fail-closed: cold-start denylist read failure → all repo-bearing projections deny; refresh failure → last-known-good within grace, deny past it; a record with no deny keys → omitted.
  - Document the backfill behavior (active bindings backfilled by Unit 2; any record still missing deny keys is omitted) and the bounded stale-redaction window in AGENTS.md.

  **Test scenarios:**
  - Security (R7): denylisted repo visible via App channel is omitted from operator output AND triggers no per-repo query.
  - Security (R2): a working-set/list path filters denied records before any per-repo query.
  - Security (R6): no error/log path emits a denied repo's owner/name (no-oracle across paths).
  - Security: a redacted entry with only an `R_` node_id fails the denylist load closed (build error); a numeric-keyed redacted entry matches across node_id formats.
  - Fail closed: cold-start unavailable → deny all; grace window serves last-known-good then denies; missing deny key on a record → omitted.

  **Verification:** the cross-source leak path is closed end-to-end with no surfacing and no query across operator surfaces; no-oracle holds on error/log paths; the invariant, backfill behavior, and stale-window are documented.

## System-Wide Impact

- **Interaction graph:** ingest (`add-project`) captures deny keys onto the gateway-local `RepoBinding`; the gateway resolves a run/record → its binding at surface time and feeds the deny keys to `toOperatorRunStatus` + the working-set filter; the SSE plan's 4b gate ordering uses the same denylist. `checkRepoAuthz` unchanged. The shared `RunState`/runtime package is NOT touched (Fork 2) — no action-tier impact.
- **Error propagation:** the reader returns `Result` (no throws); the cache denies on cold-start unavailability and serves bounded last-known-good with alarms on refresh failure; the predicate is total. No new throw paths on the hot path.
- **State lifecycle risks:** active bindings are backfilled (Unit 2) before the first consumer; any record still missing deny keys fails closed (omitted). Denylist refresh failure is bounded by the grace window + alarms.
- **API surface parity:** the `isRepoDenylisted` predicate-shape change is to an unconsumed contract function (no live consumer) — minor version bump; the SSE plan's 4a consumer is reconciled in lockstep (Unit 5).
- **Availability:** fail-closed is bounded (last-known-good grace + alarms) so a transient metadata-read failure does not take down the whole operator plane (Fork 1).
- **Unchanged invariants:** `checkRepoAuthz`, the operator browser guard, all shipped routes, the shared `RunState`, and existing binding/run behavior are unchanged except for the additive gateway-local binding deny-key fields. Redaction composes alongside authz; it does not replace it.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Resolving a repo's deny key at surface time would itself be the leak | Capture keys at ingest via `GET /repos/{owner}/{repo}` + backfill active bindings offline; surface-time check is a pure in-memory lookup; tests assert no GitHub call for denied/unknown repos. |
| Fail-closed deny-all becomes a self-inflicted DoS / availability kill-switch (P0) | Bounded last-known-good grace window + hard alarms on refresh failure; only cold-start and post-grace-window deny all. Separates confidentiality from availability. |
| `R_`-only redacted entry → cross-format node_id miss → leak (P1) | Every redacted entry must contribute a usable numeric `database_id`; an `R_`-only entry fails the denylist load closed. |
| List/enumeration + cross-surface paths surface/query a denied repo before the gate (P1) | Denylist filter is the FIRST step in every working-set builder; cross-surface inventory + no-oracle tests on error/log paths. |
| Rename/transfer makes the stored deny key miss the denylist | Capture the immutable numeric `id` at ingest (stable across rename/transfer); test the rename case. |
| Adding deny keys to shared `RunState` would hit the action tier | Deny keys are gateway-local (on `RepoBinding` only); `RunState`/runtime untouched. |
| Active legacy bindings make the gate functionally empty | Unit 2 backfills active bindings offline before the first consumer ships. |
| Denylist staleness lets a newly-redacted repo leak within the TTL/grace window | Bounded TTL + grace; documented accepted window; the SSE 4b authz-lease re-check further bounds long-lived streams. |
| Predicate-shape change breaks the SSE plan's 4a consumer | Unconsumed function → minor bump; Unit 5 reconciles the SSE plan in lockstep; characterization-first on run-status tests. |
| Copying the dashboard aggregator's "incomplete-but-continue" behavior would leak | Explicitly do NOT copy it; operator surface denies on incomplete/partial-parse/unknown deny key (whole load fails closed). |

## Documentation / Operational Notes

- `packages/gateway/AGENTS.md` documents the redaction gate, the `.github@data:metadata/repos.yaml` source, the fail-closed posture, and the legacy-record backfill limitation.
- Cross-link the dashboard learning (`cross-source-redaction-denylist-before-query-2026-06-15.md`) from `REDACTION_OBLIGATION`.
- Operational: the denylist read depends on the gateway App client having Contents read on `fro-bot/.github`; note the permission requirement.

## Sources & References

- **Origin:** [fro-bot/agent#950](https://github.com/fro-bot/agent/issues/950) (Fro Bot triage comment as requirements)
- Reference implementation: `fro-bot/dashboard` `src/github/metadata.ts` + `docs/solutions/security-issues/cross-source-redaction-denylist-before-query-2026-06-15.md`
- Metadata source of truth: `fro-bot/.github@data` `metadata/repos.yaml`
- Related issues: #907 (umbrella), #951 (auth authority)
- Related plan: `docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md` (Unit 4b consumes this gate; Unit 4a consumes the predicate)
- Key code: `packages/gateway/src/operator-contract/{redaction,run-status}.ts`, `packages/gateway/src/github/app-client.ts`, `packages/gateway/src/bindings/types.ts`, `packages/gateway/src/discord/commands/add-project.ts`, `packages/runtime/src/coordination/types.ts`
