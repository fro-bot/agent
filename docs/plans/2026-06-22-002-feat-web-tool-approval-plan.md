---
title: 'feat: web tool-approval flow (gateway operator surface)'
type: feat
status: active
date: 2026-06-22
origin: docs/brainstorms/2026-06-22-web-tool-approval-requirements.md
---

# Web Tool Approval Flow (Gateway Operator Surface)

## Overview

Replace the web-launch auto-deny approval stub with a real interactive tool-approval transport. When a gateway-launched run hits a tool gate, the SSE run-stream pushes an approval frame carrying the gated `command`/`filepath`; an operator with **write** access submits once/always/reject through a new decision route that settles the existing transport-neutral approval registry; a GET pending-approvals endpoint reconciles open requests for reconnecting browsers. Read-only operators can observe but not approve.

The research confirmed the decision path, scope-binding, single-winner settlement, and the operator-contract decision types are already built — so much of this is wiring a new transport and two routes onto existing seams. The net-new surface is the SSE approval frame (a closed-union protocol change + contract-version bump), a write-level authz primitive, the `PermissionRequest` command/filepath extension with escaping, a registry read-method for the GET endpoint, and deleting the auto-deny path.

## Problem Frame

Web-launched runs cannot do tool-gated work (see origin: docs/brainstorms/2026-06-22-web-tool-approval-requirements.md). `createWebAutoDenyApproval` (`packages/gateway/src/web/operator/web-approval.ts`) rejects every tool-permission request immediately — so any step needing `bash`, `edit`, or another gated tool is denied. That stub exists only to avoid a worse failure: without an explicit web transport the engine falls through to the Discord transport, which posts to a nonexistent thread and holds the repo lock until the ~13-minute deadline. The foundation for the real path (transport-neutral registry, SSE run-stream, operator contract) is in place; what is missing is the web transport, the decision route, the pending-request delivery to the browser, and a write-level authz gate.

## Requirements Trace

- R1. Replace `createWebAutoDenyApproval` with a real web transport that registers each request in the approval registry (origin R1).
- R2. The transport settles a registered request when the operator's decision arrives, mapping once/always/reject to the registry decision entry point (origin R2).
- R3. The SSE run-stream emits an approval frame (requestID, tool category, command/filepath) on open and a settle/clear frame on settlement (origin R3).
- R4. v1 surfaces the concrete `command`/`filepath` from the event metadata (not a bare title), bounded (length-capped + escaped) so a hostile/oversized value cannot break or abuse the browser; the full file-content diff is deferred to Phase 2 (origin R4).
- R5. A GET pending-approvals endpoint returns the open request(s) with the same detail for reconnection recovery (origin R5).
- R6. A decision route accepts once/always/reject for a requestID on a run and forwards it to the registry (origin R6).
- R7. Submitting a decision requires WRITE (or admin) permission on the run's repo, re-verified revocation-safe at submit time — a strictly higher bar than observing (read) (origin R7).
- R8. The per-request approval deadline remains the fail-closed safety valve; an unanswered request denies at its deadline and never holds the lock indefinitely (origin R8).
- R9. Each settled decision is attributed to the submitting operator's identity via the registry's typed actor (origin R9).
- R10. The decision route binds requestID to the run's `approvalScopeId` and rejects cross-scope/cross-run/stale decisions with no side effects (origin R10).
- R11. The decision route is idempotent against already-settled requests (no second settlement) (origin R11).
- R12. `always` persists as an OpenCode always-rule beyond the single request; v1 inherits that scope and treats `always` as the higher-blast-radius choice (origin R12).
- R13. The GET endpoint authorizes on the exact run scope (read-level) and never reveals open-request existence/detail to an unauthorized operator (no existence oracle) (origin R13).
- R14. Concurrent open requests for a run are each recoverable and individually decidable; a request that settles mid-decision becomes non-actionable (origin R14).

## Scope Boundaries

- A full file-content diff/patch preview is deferred to Phase 2; v1 shows the `command`/`filepath` only.
- No policy-based pre-approval (auto-resolve rules); per-request interactive approval is the v1 primitive.
- The Discord approval flow is unchanged; this adds a parallel web transport.
- No change to the OpenCode permission model, the approval deadline duration, or the registry's settlement semantics.

### Deferred to Separate Tasks

- Dashboard UI for the approval prompt (placement relative to the run stream, concurrent-request presentation, `always` confirmation affordance): the dashboard repo consumes the contract this plan ships. This plan delivers the gateway-side transport, frames, routes, and contract; the browser UX is `fro-bot/dashboard` work, captured in the contract so the dashboard can build against it.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/approvals/registry.ts` — `handleDecision({requestID, approvalScopeId, decision, actor})` already enforces scope-binding (`channel-mismatch`), single-winner claim (`already-claimed`), and not-found (already-settled). `pending(scope)` returns request IDs only; a new `describePendingForScope` is needed for full detail (R5). `ApprovalActor`/`WebOperatorActor` exist.
- `packages/gateway/src/approvals/coordinator.ts` — `PermissionRequest` (`requestID, sessionID, permission, patterns, title`) lacks `command`/`filepath`; `parsePermissionRequest`/`deriveTitle` read `metadata.command`/`metadata.filepath` via the prototype-safe `getString` then discard them. R4 extends the type with optional fields.
- `packages/gateway/src/approvals/discord-transport.ts` — `createDiscordApprovalOnPending` is the reference transport (register-before-fan-out).
- `packages/gateway/src/web/operator/web-approval.ts` — `createWebAutoDenyApproval`, the stub to delete; `launch-route.ts` is its only call site.
- `packages/gateway/src/web/sse/manager.ts` — closed `ObservationFrame = StatusFrame | ResetFrame | HeartbeatFrame | OutputFrame`; `observeOutput` is the precedent for a new `observeApproval`. Per-subscriber 64 KB queue cap; terminal-replay cache for late subscribers.
- `packages/gateway/src/web/sse/run-stream-route.ts` — `writeFrame` exhaustiveness guard (the compile-time catch site for a new frame); `runLeaseCheck` (continuous-authz, 30 s interval) is the lease pattern; gate ordering (denylist→authz→cap) is the route template; `notFoundResponse`/`rateLimitedResponse` are the no-oracle responses.
- `packages/gateway/src/web/sse/projection.ts` — `scopeIdFor(runState)` returns `run_id` for non-Discord surfaces (the `approvalScopeId` for web).
- `packages/gateway/src/web/auth/repo-authz.ts` — `checkRepoAuthz` proves read access via `GET /repos/{owner}/{repo}` and discards the body; `RepoAuthzResult` is boolean. R7 needs a write-level sibling reading `permissions`.
- `packages/gateway/src/web/operator/launch-route.ts` — the swap point (`createApprovalOnPending: createWebAutoDenyApproval(...)`), the `observeOutput` wiring precedent, the `WebOperatorIdentity` construction.
- `packages/gateway/src/operator-contract/approval.ts` — `DecisionInput`, `toOperatorDecisionState` (already the contract for R6/R9/R10/R11); `PermissionReply` allowlist.
- `packages/gateway/src/operator-contract/version.ts` — `OPERATOR_CONTRACT_VERSION` (build-time pinned; the frame addition is a bump to 1.4.0).
- `packages/gateway/src/web/audit.ts` — `ApprovalDecisionEvent.decision` is binary (`approve`/`deny`); R12 wants once/always preserved (enum extension + `assertNever` updates).
- `packages/gateway/src/web/server.ts` — privileged-route registration site (the docstring already names "approvals" as a forward-looking route).
- `packages/gateway/src/approvals/approval-flow.integration.test.ts` — `webOnPending` is the working registry-level web-decision fixture pattern.

### Institutional Learnings

- `docs/solutions/best-practices/gateway-control-surface-spine-2026-06-15.md` — one fail-closed approval gate, many transports: the web decision route settles through the **same** `handleDecision`; verify scope equivalence (`approvalScopeId == run_id`) with a test; collapse, don't fork.
- `docs/solutions/best-practices/web-operator-launch-surface-2026-06-20.md` — delete the auto-deny path in the same change (don't stack); reuse `bindingToRepoKey`/centralized deny-keys; the GET enumeration follows denylist-filter → per-operator authz → hard cap → closed DTO, rate-limited per operator.
- `docs/solutions/best-practices/authenticated-sse-run-observation-2026-06-20.md` — no-oracle identical denial for every gate (a throw must degrade to the same denial, not a 500); redaction before authz; per-operator stream cap on numeric user id; **tighten the lease for the approval frame** because the permission request is more sensitive than sink-routed output; the new frame is additive-by-contract (version bump).
- `docs/solutions/best-practices/sse-output-streaming-terminal-drain-2026-06-21.md` — terminal is graceful drain not abort; enqueue the resolution frame before terminal status; bounded replay cache (TTL+count+bytes); coalesce on overflow; dequeue-before-await; out-of-order async guard.
- `docs/solutions/best-practices/effect-failure-channel-discipline-2026-06-10.md` — `catchAllCause` (not `catchAll`) on the new Effect routes; guard interrupts first so a shutdown mid-decision doesn't look like a denial.
- `docs/solutions/best-practices/atomic-serial-channel-queue-handoff-2026-06-09.md` — defer-before-REST discipline: resolve cheap local identity first; gate new work on `isShuttingDown()`.
- `docs/solutions/best-practices/discord-slash-command-orchestration-patterns-2026-05-27.md` — test the real HTTP route (with auth/denylist/redaction), not just the registry function.
- `docs/solutions/best-practices/centralize-s3-key-identity-construction-2026-06-09.md` — one owner per resource-key family; pin exact keys in regression tests (applies if a new approval-key family is introduced).

### External References

- GitHub `GET /repos/{owner}/{repo}` returns the requesting user's `permissions` object (`{pull, push, maintain, admin, triage}`); `GET /repos/{owner}/{repo}/collaborators/{username}/permission` returns a single permission enum. Either can source the write-level check (see Open Questions).

## Key Technical Decisions

- Settle through the existing `handleDecision`, do not fork: R10/R11 require no registry changes; the route supplies `approvalScopeId = run_id` (resolved server-side via `RunIndex.lookup`, never client-supplied) and the typed `WebOperatorActor`, and maps the `DecisionOutcome` via `toOperatorDecisionState`.
- Approval frame is a new closed-union variant, not a projected status field: add `ApprovalFrame` to `ObservationFrame`, an `observeApproval` manager method (mirroring `observeOutput`), the `writeFrame` branch, and bump `OPERATOR_CONTRACT_VERSION` to 1.4.0. The existing `waiting_for_approval` status overlay stays — it marks "blocked"; the new frame carries the prompt.
- Separate `checkRepoWriteAuthz` with a short TTL: do not bloat `RepoAuthzResult` or reuse the 5-min read cache. A new function reads the GitHub `permissions` field, returns `{authorized, level}`, uses a ~60 s positive TTL (revocation safety for a mutate-capable action), and adds an `insufficient_permission` denied-reason. Read routes keep `checkRepoAuthz` unchanged.
- Extend `PermissionRequest` with optional `command?`/`filepath?` (backward-compatible across its import sites), populated in `parsePermissionRequest` via the prototype-safe accessor. Escaping + length-cap is a new helper applied at the `observeApproval`/frame-build site so the in-memory `ApprovalFrameData` carries safe, bounded strings.
- Tighten the lease for approval data: approval frames carry the permission request (tool + command + repo), more sensitive than output frames. Apply a tighter re-check (cache-bypass or short-interval) for the approval surface rather than the default ~6-min window, or document the explicit decision.
- Decision route has no continuous-authz lease: a decision is a single HTTP request; `handleDecision` is itself the fail-closed gate. The lease exists only for the long-lived stream.
- Preserve `always` in the audit: extend `ApprovalDecisionEvent.decision` to `once|always|reject` (with the `LOG_LEVEL` map and `assertNever` updates) so the higher-blast-radius grant is auditable, rather than collapsing once/always to `approve`.
- Delete `createWebAutoDenyApproval` outright (not deprecate): a dead auto-deny factory invites re-introduction; the launch route's only call site swaps to the new transport.

## Open Questions

### Resolved During Planning

- Does the registry need new scope-binding/idempotency logic? → No; `handleDecision` already returns `channel-mismatch`/`already-claimed`/`not-found`. The route calls it correctly.
- Is the approval frame a status field or a new frame? → New closed-union frame + contract bump; the status overlay is unchanged.
- Same authz as observing? → No; write-level for approve, read-level for observe and the GET endpoint.
- What is `approvalScopeId` for web? → `run_id` (from `scopeIdFor` for non-Discord), resolved server-side.

### Deferred to Implementation

- **Write-authz source** [Needs research/decision]: the `permissions` field on the existing `GET /repos` call (one fewer request, body currently discarded) vs the dedicated collaborator-permission endpoint (single enum, separate call). Pick during Unit 3 by what gives a clean revocation-safe answer; both are viable.
- **Lease-tightening mechanism for approval frames** [Technical]: cache-bypass re-check vs a shorter lease interval scoped to runs with open approvals — settle against the actual `runLeaseCheck` shape during Unit 5.
- **Escape target** [Technical]: JSON-string escaping at the frame-build site is the default; confirm no additional HTML-context escaping is needed given the dashboard renders it (the dashboard owns DOM-escaping, but the gateway must still bound length and strip control characters).
- **Audit enum extension vs accept-loss** [Technical]: extending `ApprovalDecisionEvent` is the planned path; if the contract change proves disproportionate, fall back to mapping once/always→approve and documenting the loss.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
permission.asked (engine)
   │  parsePermissionRequest → PermissionRequest {…, command?, filepath?}   [Unit 1]
   ▼
createWebApprovalOnPending(ctx)(req)                                         [Unit 4]
   ├─ registry.register({requestID, approvalScopeId: ctx.runId, …})  (register-before-fan-out)
   └─ observeApproval(runId, {requestID, permission, command, filepath})    [Unit 2]
            │  escape + length-cap                                          [Unit 1]
            ▼
   SSE ApprovalFrame ──► browser (live)                                     [Unit 2]
   GET /operator/runs/:id/approvals ──► browser (reconnect)  read-authz     [Unit 6]

operator decides (write-authz)                                             [Unit 3 authz, Unit 5 route]
   POST /operator/runs/:id/approvals/:reqId/decision {decision}
   ├─ RunIndex.lookup → repo   (server-owned scope)
   ├─ denylist → checkRepoWriteAuthz (≤60s TTL)                            [Unit 3]
   ├─ registry.handleDecision({requestID, approvalScopeId: run_id, decision, actor: WebOperatorActor})
   │       → DecisionOutcome (ok | channel-mismatch | already-claimed | not-found | reply-failed)
   ├─ audit ApprovalDecisionEvent {decision: once|always|reject}           [Unit 3]
   └─ toOperatorDecisionState → JSON
            │
            ▼
   engine unblocks / rejects tool ─► SSE settle/clear frame  (graceful drain)  [Unit 2]
   deadline (unanswered) ─► fail-closed deny (R8, unchanged)
```

## Implementation Units

- [ ] **Unit 1: Surface command/filepath on PermissionRequest + escaping helper**

**Goal:** Carry the gated `command`/`filepath` through to the transport, bounded and escaped.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `packages/gateway/src/approvals/coordinator.ts` (add optional `command?`/`filepath?` to `PermissionRequest`; populate in `parsePermissionRequest` via the prototype-safe accessor)
- Create: `packages/gateway/src/approvals/approval-detail.ts` (or colocate) — a `boundApprovalDetail(value)` helper: length-cap (~4 KB) + control-char strip + JSON-safe escaping
- Test: `packages/gateway/src/approvals/coordinator.test.ts`, `packages/gateway/src/approvals/approval-detail.test.ts`

**Approach:**
- Optional fields keep the change backward-compatible across `PermissionRequest`'s import sites. Reuse `getString` (prototype-safe) — no `metadata?.command` shortcuts. The bound/escape helper runs where the frame data is built (Unit 2), not in the parser, so the registry's in-memory request keeps raw values for Discord parity.

**Patterns to follow:** `deriveTitle`'s existing `getString(metadata, 'filepath')`/`getString(metadata, 'command')` reads.

**Test scenarios:**
- Happy path: a `bash` `permission.asked` with `metadata.command` → `PermissionRequest.command` is populated; an `edit`/`external_directory` with `metadata.filepath` → `filepath` populated.
- Edge case: missing metadata → both fields `undefined`; prototype-polluted metadata → accessor does not read inherited props.
- Edge case: oversized command (> cap) → `boundApprovalDetail` truncates to the cap; embedded control chars / quotes → stripped/escaped; empty string → handled.

**Verification:** `PermissionRequest` carries `command`/`filepath` when present; the bound helper caps + escapes; existing coordinator tests still pass.

- [ ] **Unit 2: SSE ApprovalFrame + observeApproval (contract bump)**

**Goal:** Deliver the pending request to the browser as a new SSE frame and a settle/clear frame, with terminal-drain safety.

**Requirements:** R3, R14

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/gateway/src/web/sse/manager.ts` (add `ApprovalFrame` to the union; `observeApproval(runId, data)`; settle/clear emission; fan-out via the non-coalescing `enqueueFrame`; replay-cache + terminal-drain handling for the open-approval state)
- Modify: `packages/gateway/src/web/sse/run-stream-route.ts` (`writeFrame` branch for `'approval'`)
- Modify: `packages/gateway/src/operator-contract/version.ts` (`OPERATOR_CONTRACT_VERSION` → 1.4.0) and the contract module that declares the frame DTO (`ApprovalFrameData`: `{requestID, permission, command?, filepath?}` — escaped/bounded)
- Test: `packages/gateway/src/web/sse/manager.test.ts`, `run-stream-route.test.ts`, the operator-contract version test

**Approach:**
- Additive closed-union variant; the `writeFrame` exhaustiveness guard is the compile-time catch. `observeApproval` mirrors `observeOutput` (per-run closure wired at the launch route in Unit 4). Apply the terminal-drain triad: enqueue the settle/clear frame before terminal status; bound the replay cache; out-of-order async guard so a stale approval frame can't regress a terminal state. The status overlay (`waiting_for_approval`) is unchanged.

**Execution note:** Characterize the existing frame-union/terminal-drain behavior before adding the variant — the manager has subtle ordering/coalescing invariants (per the terminal-drain learnings).

**Patterns to follow:** `OutputFrame`/`observeOutput`/`enqueueOutputFrame`; the `ResetReason` typed-union shape; `sse-output-streaming-terminal-drain` rules.

**Test scenarios:**
- Happy path: `observeApproval` fans an `ApprovalFrame` (requestID + category + command/filepath) to live subscribers; on settlement a settle/clear frame is emitted.
- Integration: an approval frame followed by the run's terminal status drains in order (approval outcome not dropped); late subscriber reconnect sees recovery state (or is steered to the GET endpoint).
- Edge case: a stale/out-of-order approval frame after terminal does not regress the terminal state; oversized frame data respects the byte cap.
- Edge case: `writeFrame` handles `'approval'`; an unknown frame still trips the exhaustiveness guard.

**Verification:** New frame type compiles through the exhaustiveness guard; contract version bumped; terminal-drain ordering holds; existing SSE tests pass.

- [ ] **Unit 3: Write-level repo authz + audit enum**

**Goal:** A revocation-safe write/admin authz check distinct from the read check, and audit fidelity for once/always/reject.

**Requirements:** R7, R9, R12

**Dependencies:** None (parallel to Units 1-2)

**Files:**
- Modify: `packages/gateway/src/web/auth/repo-authz.ts` (`checkRepoWriteAuthz` returning `{authorized:true, level:'write'|'admin'} | {authorized:false, reason}`; add `insufficient_permission` to `RepoAuthzDeniedReason`; ~60 s positive TTL with a distinct cache-key prefix or cache-bypass)
- Modify: `packages/gateway/src/web/audit.ts` (extend `ApprovalDecisionEvent.decision` to `once|always|reject`; update `LOG_LEVEL` map + `assertNever` switches, including the `RepoAuthzDeniedReason` audit switch for the new reason)
- Test: `packages/gateway/src/web/auth/repo-authz.test.ts`, `packages/gateway/src/web/audit.test.ts`

**Approach:**
- Read the GitHub `permissions` field (source decided in Open Questions). `push`→`write`, `admin`→`admin`; neither → `insufficient_permission`. Short TTL because demotion from write→read must not let an approve succeed for minutes. Read routes keep `checkRepoAuthz` untouched.

**Test scenarios:**
- Happy path: an operator with `push` → `{authorized:true, level:'write'}`; with `admin` → `level:'admin'`.
- Error path: read-only (`pull` only) → `{authorized:false, reason:'insufficient_permission'}`; not-allowlisted / github-denied / rate-limited reasons preserved.
- Edge case: the short TTL — a cached write grant expires within ~60 s (revocation safety); a just-demoted operator fails after expiry.
- Happy path: audit emits `decision: 'always'` distinctly from `'once'`; the `assertNever` switches compile with the new variants.

**Verification:** `checkRepoWriteAuthz` distinguishes read/write/admin with a short TTL; audit preserves once/always/reject; read-path authz unchanged.

- [ ] **Unit 4: Web approval transport (swap auto-deny)**

**Goal:** Hand the engine a real `createApprovalOnPending` that registers + fans out the frame; delete the auto-deny path.

**Requirements:** R1, R2

**Dependencies:** Units 1, 2

**Files:**
- Modify/rename: `packages/gateway/src/web/operator/web-approval.ts` — replace `createWebAutoDenyApproval` with `createWebApprovalOnPending({observeApproval, logger})` (register-before-fan-out: `registry.register({requestID, sessionID, approvalScopeId: ctx.runId, …})` then `observeApproval(ctx.runId, boundDetail(req))`)
- Modify: `packages/gateway/src/web/operator/launch-route.ts` (swap the import + call site; extend the `Pick<RunObservationManager, 'observeOutput'>` to include `observeApproval`; build the per-run `observeApproval` closure mirroring `observeOutput`)
- Delete: the auto-deny factory and its dedicated test (`web-approval.test.ts` rewritten for the new transport)
- Test: `packages/gateway/src/web/operator/web-approval.test.ts` (new transport behavior)

**Approach:**
- Register before fan-out (Discord precedent) so a decision can settle even if the SSE send is dropped. The web transport does NOT claim visible output (the approval frame is a UI event, not agent output). No `createWebAutoDenyApproval` references may remain.

**Test scenarios:**
- Happy path: `onPending(req)` registers the entry with `approvalScopeId = runId` and calls `observeApproval` with the bounded detail.
- Edge case: `observeApproval` send failure is fail-soft (registration already done; the deadline still settles).
- Integration: zero references to `createWebAutoDenyApproval` remain (a structural assertion); the launch route wires `createWebApprovalOnPending`.

**Verification:** The launch route uses the real transport; auto-deny is deleted; registration precedes fan-out.

- [ ] **Unit 5: Decision route (POST once/always/reject)**

**Goal:** The privileged write-gated route that settles a decision through the registry.

**Requirements:** R6, R7, R9, R10, R11, R12

**Dependencies:** Units 2, 3, 4

**Files:**
- Create: `packages/gateway/src/web/operator/decision-route.ts` (`POST /operator/runs/:runId/approvals/:requestId/decision`)
- Modify: `packages/gateway/src/web/server.ts` (register the privileged route; thread its deps)
- Test: `packages/gateway/src/web/operator/decision-route.test.ts`

**Approach:**
- Gate order mirrors the run-stream route: session/guard → `RunIndex.lookup` (server-owned runId→repo) → owner/repo split → denylist (redaction before authz) → `checkRepoWriteAuthz` (write-level) → validate `decision` against the `PermissionReply` allowlist → build `WebOperatorActor` from `getOperatorAuthContext` → `registry.handleDecision({requestID, approvalScopeId: run.run_id, decision, actor})` → audit → `toOperatorDecisionState` → JSON. No continuous-authz lease. `catchAllCause` boundary; guard interrupts first (a shutdown mid-decision is not a denial). Every denial uses the no-oracle `notFoundResponse` shape; a gate throw degrades to the same denial, not a 500.

**Execution note:** Test through the real HTTP route (auth + denylist + redaction), not just `handleDecision` — the bootstrap-wiring gap is the documented failure mode.

**Patterns to follow:** `run-stream-route.ts` gate order + `notFoundResponse`; `DecisionInput`/`toOperatorDecisionState`; `effect-failure-channel-discipline` (`catchAllCause`).

**Test scenarios:**
- Happy path: write-authorized operator submits `once` → write-authz checked, registry settles allowed-once, JSON reflects the settled state; `always` settles as the persistent rule and audits distinctly.
- Error path: read-only operator → denied (no settlement); cross-run requestID (R10) → `channel-mismatch`, no side effects; already-settled requestID (R11) → already-settled response, no second settlement; invalid `decision` value → rejected.
- Error path: denylisted repo → no-oracle denial before any GitHub authz; a gate throw → same denial shape, not a 500.
- Integration: the route dispatches through real auth/denylist middleware (not a registry-only call); `handleDecision` is invoked with `approvalScopeId == run_id` and the typed actor.

**Verification:** A write-authorized decision settles the run's request; read-only is denied; cross-scope/stale are no-ops; tested through the real route.

- [ ] **Unit 6: GET pending-approvals reconciliation endpoint**

**Goal:** A read-gated enumeration route so a reconnecting browser recovers open requests, with no existence oracle.

**Requirements:** R5, R13, R14

**Dependencies:** Units 1, 5 (shares deps wiring + the registry read-method)

**Files:**
- Create: `packages/gateway/src/web/operator/pending-approvals-route.ts` (`GET /operator/runs/:runId/approvals`)
- Modify: `packages/gateway/src/approvals/registry.ts` (`describePendingForScope(approvalScopeId): readonly PendingApprovalDTO[]` — full bounded detail, mirroring `ApprovalFrameData`)
- Modify: `packages/gateway/src/web/server.ts` (register the route)
- Test: `packages/gateway/src/web/operator/pending-approvals-route.test.ts`, registry tests for `describePendingForScope`

**Approach:**
- Gate order: session/guard → `RunIndex.lookup` → denylist → `checkRepoAuthz` (read-level is sufficient) → return the open requests via `describePendingForScope(run.run_id)` as a closed bounded DTO. Per-operator rate limit. Any denial returns the identical no-oracle shape (R13) — never reveal existence/count. Bound the returned detail with the same escape/cap as the frame.

**Patterns to follow:** the launch-route enumeration pattern (denylist-filter → per-operator authz → hard cap → closed DTO); `notFoundResponse`.

**Test scenarios:**
- Happy path: read-authorized operator with an open request → 200 with the bounded DTO (requestID, category, command/filepath); no open request → empty list.
- Error path: operator without repo access → identical no-oracle denial (no existence/detail leak); denylisted repo → same denial before GitHub authz.
- Edge case: multiple concurrent open requests → all returned, individually keyed by requestID (R14); over-cap detail bounded.

**Verification:** Reconnecting operator recovers open requests; unauthorized access reveals nothing; DTO is bounded/closed.

## System-Wide Impact

- **Interaction graph:** engine `permission.asked` → web transport → registry + SSE manager → run-stream subscribers; decision route → `handleDecision` → engine unblock + settle frame; GET route → registry read-method. The Discord transport path is untouched and shares the same registry.
- **Error propagation:** every route denial uses the no-oracle `notFoundResponse`; gate throws degrade to the same shape (never a distinguishable 500); `catchAllCause` guarantees the registry-settle / SSE-emit / audit side effects on failure; interrupts propagate as interrupts, not denials.
- **State lifecycle risks:** register-before-fan-out so a dropped SSE send can't strand a decidable request; terminal-drain ordering so an approval outcome isn't dropped when the run completes in the same flush; the deadline remains the fail-closed valve (R8).
- **API surface parity:** the operator contract gains `ApprovalFrame`/`ApprovalFrameData` and bumps to 1.4.0; the dashboard consumes it. The Discord embed stays redaction-safe (title only); the web frame deliberately carries more (escaped/bounded command/filepath).
- **Integration coverage:** the decision and GET routes must be tested through the real HTTP path (auth/denylist/redaction), not registry-only.
- **Unchanged invariants:** `handleDecision` settlement semantics, the approval deadline duration, the read-level `checkRepoAuthz`, the `waiting_for_approval` status overlay, and the Discord transport all stay as-is. The registry gains a read-method and the request type gains optional fields — both backward-compatible.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Adding a frame variant breaks the closed-union exhaustiveness or a client consumer | The `writeFrame` exhaustiveness guard is the compile-time catch; bump `OPERATOR_CONTRACT_VERSION`; the dashboard consumes the bumped contract (deferred dashboard task). |
| Write-authz cache lets a demoted operator approve for minutes | Short (~60 s) positive TTL or cache-bypass on the write-level check; revocation-safety test pinning expiry. |
| Approval frame leaks sensitive request detail over a too-loose lease | Tighten the lease for the approval surface; redaction (denylist) runs before authz; the operator surface is authenticated + repo-authz-gated. |
| A decision settles but the SSE confirm/terminal frame is dropped | Register-before-fan-out + terminal-drain ordering + the GET reconciliation endpoint; the registry settlement is authoritative, the frame is advisory. |
| Tests pass against the registry but the route is mis-wired | Test through the real HTTP route with middleware (documented bootstrap-wiring failure mode). |
| `always` over-grant is invisible in audit | Extend the audit decision enum to preserve once/always/reject. |

## Documentation / Operational Notes

- File a `fro-bot/dashboard` issue (after merge) describing the new `ApprovalFrame`/`ApprovalFrameData`, the `GET /operator/runs/:id/approvals` and `POST .../decision` contracts, the `once|always|reject` decision shape, and the read-observe / write-approve split, so the dashboard can build the approval UX.
- `packages/gateway/AGENTS.md` (or the relevant gateway doc) should note the web approval transport replaced auto-deny, the write-vs-read authz split, and the deadline-as-fail-closed-valve.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-22-web-tool-approval-requirements.md](docs/brainstorms/2026-06-22-web-tool-approval-requirements.md)
- Related code: `packages/gateway/src/approvals/{registry,coordinator,discord-transport}.ts`, `packages/gateway/src/web/operator/{web-approval,launch-route}.ts`, `packages/gateway/src/web/sse/{manager,run-stream-route,projection}.ts`, `packages/gateway/src/web/auth/repo-authz.ts`, `packages/gateway/src/operator-contract/{approval,version}.ts`, `packages/gateway/src/web/{audit,server}.ts`.
- Institutional learnings: gateway-control-surface-spine, web-operator-launch-surface, authenticated-sse-run-observation, sse-output-streaming-terminal-drain, effect-failure-channel-discipline, atomic-serial-channel-queue-handoff (all under docs/solutions/best-practices/).
