---
date: 2026-06-22
topic: web-tool-approval
---

# Web Tool Approval (Gateway Operator Surface)

## Summary

Give gateway-launched runs a real interactive tool-approval flow on the web operator surface: when a run hits a tool gate, an operator with write access sees the pending request — including the actual command or file path it wants to touch — over the existing SSE run-stream and submits once/always/reject through a new decision route, wired into the same transport-neutral approval registry the Discord flow already uses. Approving is a write-gated action (read-only operators can observe but not approve); a full diff/patch preview is deferred to a Phase 2.

---

## Problem Frame

Web-launched runs cannot do tool-gated work. When such a run reaches a tool permission gate, the gateway's web approval transport (`createWebAutoDenyApproval`) immediately rejects every request — so any step needing `bash`, `edit`, or another gated tool is denied and the run proceeds or fails without it. A web operator can launch a run and watch it stream, but cannot authorize the very actions that make an agent run useful.

That auto-deny stub is not the intended end state; it exists to avoid a worse failure. Without an explicit web transport, the engine falls through to the Discord approval transport, which posts the prompt to a thread that does not exist for a web run and holds the repo lock until the approval deadline (~13 minutes), blocking every run in that repo. Auto-deny was the safe placeholder while the interactive web path was unbuilt.

The foundation for the real path already exists. The approval registry is transport-neutral (it carries an `approvalScopeId`, a `handleDecision` entry point, and a typed actor). The SSE run-stream already overlays a `waiting_for_approval` status when a run's scope has a pending request. The operator contract already defines the decision vocabulary (`once`/`always`/`reject`) and the settlement outcomes. What is missing is the web transport itself: a way for the pending request's detail to reach the operator's browser, and a way for the operator's decision to return to the registry.

---

## Actors

- A1. Web operator: an authenticated dashboard user. With read access to the repo they can launch and observe a gateway run; with write (or admin) access they can also approve or reject its tool-permission requests.
- A2. Gateway run engine: drives the OpenCode session, raises a pending request on `permission.asked`, and blocks the gated tool until the request settles.
- A3. Approval registry: the transport-neutral component that holds open requests per approval scope and settles them on a decision, a reject cascade, or the deadline.

---

## Key Flows

- F1. Operator approves a pending tool request
  - **Trigger:** A running web-launched run raises a tool-permission request (`permission.asked`); the run blocks the gated tool.
  - **Actors:** A1, A2, A3
  - **Steps:** The registry registers the open request. The SSE run-stream pushes an approval frame (requestID + the gated command/filepath + tool category) and the run's status overlays to `waiting_for_approval`. A write-authorized operator sees the prompt and submits a decision (once/always/reject) to the decision route. The route re-checks write-level repo-authz and binds the requestID to the run's scope, then calls the registry's decision entry point. The registry settles the request and the engine unblocks (or rejects) the tool. The SSE stream emits a settle/clear frame.
  - **Outcome:** The tool proceeds (once/always) or is rejected; the run continues; the operator surface reflects the settled state.
  - **Covered by:** R1, R2, R3, R4, R6, R7, R9, R10, R11, R12

- F2. Reconnecting operator recovers an open request
  - **Trigger:** The operator's SSE connection drops and reconnects (or a second operator opens the run) while a request is still open.
  - **Actors:** A1, A3
  - **Steps:** The browser, on seeing `waiting_for_approval` (or on reconnect), calls the GET pending-approvals endpoint for the run. The endpoint returns the open request(s) with the same redaction-safe detail. The operator decides as in F1.
  - **Outcome:** A reconnecting or late-joining operator recovers the open request instead of the run hanging unseen until the deadline.
  - **Covered by:** R5, R6, R7, R11, R13, R14

- F3. No operator answers in time
  - **Trigger:** A request is open but no operator submits a decision.
  - **Actors:** A2, A3
  - **Steps:** The existing approval deadline elapses. The registry settles the request fail-closed (deny). The engine rejects the tool and the run proceeds or fails accordingly. The lock releases on the normal run lifecycle.
  - **Outcome:** An unanswered request cannot hold the repo lock indefinitely; the run settles deterministically.
  - **Covered by:** R8

---

## Requirements

**Web approval transport**
- R1. Replace `createWebAutoDenyApproval` with a real web approval transport that registers each tool-permission request as an open entry in the transport-neutral approval registry (the same registry the Discord transport uses), instead of immediately rejecting it.
- R2. The transport must settle a registered request when the operator's decision arrives, mapping the operator's choice to the registry's decision entry point with the matching reply value (once/always/reject).

**Pending-request delivery to the browser**
- R3. When a request opens, the SSE run-stream must emit an approval frame carrying the requestID, the tool category, and the decision context (the `command` for command-gated tools and the `filepath` for file-gated tools, from the event metadata), so the operator can make an informed decision and target it at the correct request. When the request settles, the stream must emit a settle/clear frame.
- R4. v1 surfaces the concrete gated action — the `command` and `filepath` from the `permission.asked` metadata — so the operator approves with real context, not a bare title. v1 stops short of a full file-content diff/patch preview (the would-be result of the edit), which is deferred to Phase 2. The surfaced detail must be bounded (length-capped/escaped) so a hostile or oversized command/path cannot break or abuse the browser surface.
- R5. A GET pending-approvals endpoint for a run must return the currently-open request(s) with the same redaction-safe detail, so a reconnecting or late-joining browser can recover open requests. This is the reconciliation fallback to the SSE frame.

**Decision route and authorization**
- R6. A decision route must accept an operator's once/always/reject decision for a specific requestID on a specific run and forward it to the approval registry.
- R7. Submitting a decision must require WRITE (or admin) permission on the run's repo, re-verified at submit time — a strictly higher bar than observing, which requires only read access. Approving authorizes a repo-mutating tool, so a read-only operator may watch the run stream but must not be able to approve. This requires extending the authz path beyond the current read-access boolean (`checkRepoAuthz` proves read access only) to determine the operator's permission level (read vs write/admin) for the repo.
- R9. Each settled decision must be attributed to the submitting operator's identity using the registry's existing typed actor, so there is a record of who approved or rejected what.
- R10. The decision route must bind the submitted requestID to the run's `approvalScopeId` and reject any cross-scope, cross-run, or stale decision with no side effects. A decision for a requestID the operator's authorized run does not own must fail without settling anything.
- R11. The decision route must be idempotent against already-settled requests: a decision for a requestID that has already settled (by an earlier decision, a reject cascade, or the deadline) is a no-op that returns a clear already-settled response, never a second settlement.
- R12. The `always` reply persists as an OpenCode permission rule beyond the single request (it is an always-rule in OpenCode's permission model, not a one-shot grant). The doc and the operator UI must treat `always` as the broader-blast-radius choice; v1 inherits OpenCode's existing always-rule scope rather than introducing a new persistence scope.

**Pending-request authorization and exposure**
- R13. The GET pending-approvals endpoint must authorize on the exact run scope using the same repo-authz check as the SSE stream, and must not reveal open-request existence, count, or detail to an operator who lacks access to that run/repo (no cross-scope existence oracle). An unauthorized request returns the same denial the SSE stream uses.

**Safety and lifecycle**
- R8. With auto-deny removed, a web-launched run can legitimately block on a pending approval and hold the repo lock until the request settles. The existing approval deadline must remain the safety valve, enforced per request: an unanswered request settles fail-closed (deny) at its deadline, and the lock is never held indefinitely by an undecided approval. A tool-heavy run that opens many sequential requests can hold the lock for up to the per-request deadline at a time; v1 accepts this per-request bound and does not add a separate cumulative-lock cap (the run's own concurrency/lifecycle already bounds it).
- R14. When multiple tool requests are open for the same run, all open requests must be recoverable (via the SSE frames and the GET endpoint) and individually decidable by requestID. The operator UI's presentation of concurrent open requests (queue, list, or one-at-a-time) and the mid-decision settle state (an open request that settles while the operator is deciding must become non-actionable with a clear settled/replaced signal) are interaction decisions for planning, but the transport must expose enough per-request state to support them.

---

## Acceptance Examples

- AE1. **Covers R1, R3.** Given a running web-launched run that raises a `bash` permission request, when the request opens, then the SSE stream emits an approval frame with the requestID, the `bash` category, and the gated `command`, and the run status shows `waiting_for_approval`.
- AE2. **Covers R2, R6, R7.** Given an open request and an authenticated operator with write access to the repo, when the operator submits `once` for that requestID, then the decision route re-checks write-level authz, the registry settles the request as allowed-once, and the gated tool proceeds.
- AE3. **Covers R4.** Given a `bash` request whose metadata carries a shell command, when it is surfaced to the browser, then the command is present (length-capped/escaped) so the operator decides on real context, while the full would-be file diff is not rendered.
- AE4. **Covers R5.** Given an open request and an operator whose SSE connection dropped, when the operator reconnects and calls the GET pending-approvals endpoint, then the open request is returned with its decision context so the operator can still decide.
- AE5. **Covers R7.** Given an authenticated operator with only read access to the run's repo, when they attempt to submit a decision, then the decision route denies the submission (read can observe but not approve), while they may still watch the run stream.
- AE6. **Covers R8.** Given an open request that no operator answers, when the approval deadline elapses, then the registry settles it fail-closed (deny), the tool is rejected, and the repo lock is not held beyond the run's normal lifecycle.
- AE7. **Covers R9.** Given an open request, when an authenticated operator settles it, then the registry records the submitting operator's identity (typed actor) alongside the decision outcome.
- AE8. **Covers R10.** Given an operator authorized for run A's repo, when they submit a decision for a requestID that belongs to run B (a different scope), then the decision route rejects it with no side effects and run B's request stays open.
- AE9. **Covers R11.** Given a requestID that already settled (by the deadline or an earlier decision), when an operator submits a decision for it (e.g. via a stale SSE frame or reconnect GET), then the route returns an already-settled response and does not settle the request a second time.
- AE10. **Covers R13.** Given an operator who lacks read access to a run's repo, when they call the GET pending-approvals endpoint for that run, then the endpoint returns the same denial as the SSE stream and reveals no open-request existence or detail.

---

## Success Criteria

- A web operator can launch a run that needs tool approvals, see each pending request in the browser in real time, and approve or reject it — completing tool-gated work that previously could only run through Discord.
- A dropped/reconnecting browser recovers an open request rather than letting the run hang unseen until the deadline.
- An unanswered request never holds the repo lock indefinitely; it settles fail-closed at the deadline exactly as before.
- Operators decide on the real gated action (the command/filepath), not a bare title — and a read-only operator can observe but cannot approve.
- A downstream planner can implement the transport, the SSE approval frame, the GET reconciliation endpoint, the write-level authz extension, and the decision route against the existing registry/contract seams without inventing approval semantics.

---

## Scope Boundaries

- A full file-content diff/patch preview (rendering what an edit would produce before deciding) is deferred to a clearly-scoped Phase 2. v1 shows the gated `command`/`filepath` but not the resulting diff.
- Policy-based pre-approval (operator-configured allow/deny rules that auto-resolve requests without a prompt) is not in scope. Per-request interactive approval is the foundational primitive a policy layer would build on; it must exist first. The click-tax concern for high-approval-volume runs is a documented Phase-2 driver.
- Changes to the Discord approval flow are out of scope; this work adds a parallel web transport and leaves the Discord transport unchanged.
- Changing the underlying OpenCode permission model, the approval deadline duration, or the registry's settlement semantics is out of scope; v1 reuses them.

---

## Key Decisions

- Show the gated action in v1, defer only the diff preview: v1 surfaces the actual `command`/`filepath` from the `permission.asked` metadata so the operator approves on real context. A title-only approval would invite blind rubber-stamping and give operators no reason to use the web surface over Discord. This deliberately surfaces more than the Discord embed does (which renders only a redaction-safe title), justified because the operator surface is authenticated and repo-authz-gated — a more trusted audience than a Discord channel. The richer artifact still deferred to Phase 2 is the full file-content diff/patch preview (what the edit would produce), not the command/path itself.
- Write/admin permission to approve, read to observe: approving runs a repo-mutating tool, so it carries a strictly higher bar than watching. A read-only collaborator can observe a run but cannot authorize changes to the repo. This requires extending the authz path to surface permission level (the current `checkRepoAuthz` only proves read access), which is new capability v1 must build — a deliberate cost accepted for least-privilege on a mutate-capable action.
- SSE approval frame as primary delivery, GET endpoint as reconciliation: the browser already holds the SSE connection, so pushing the prompt in-stream avoids a round-trip and matches how the run-observation manager already pushes status/output frames. The GET endpoint mirrors the run-stream's existing latest-known-state recovery philosophy so a reconnecting browser cannot silently miss an open request.
- Identity attribution comes for free: the registry's existing typed actor records who decided at no extra access cost, so v1 keeps an audit trail of approvals/rejections.
- Auto-deny removal makes the deadline load-bearing: today the deadline is a backstop behind an immediate auto-deny. Once requests can legitimately stay open, the deadline becomes the real safety valve for the no-operator-answers case, and v1 must treat it as such rather than as a stub. The deadline is per request; a tool-heavy run holds the lock at most one deadline at a time, which v1 accepts rather than adding a cumulative-lock cap.
- `always` is a persistent OpenCode permission rule, not a one-shot: the registry treats `always` as an always-rule in OpenCode's permission model, so approving `always` grants beyond the single request. v1 inherits that existing scope rather than redefining it, and surfaces `always` as the higher-blast-radius choice (the operator UI must make it harder to pick by accident — an interaction detail for planning).

---

## Outstanding Questions

### Deferred to Planning

- [Affects R7][Technical] How to source and cache the operator's repo permission level (read vs write/admin) so the submit-time re-check is both correct and revocation-safe — the GitHub `permissions` field on `GET /repos`, the collaborator-permission endpoint, or another path, and how its caching interacts with the existing authz cache.
- [Affects R3, R14][Design] Where the approval prompt lives relative to the run's streaming output (inline banner, docked panel, or modal) and how concurrent open requests are presented (queue, list, or one-at-a-time). Interaction decisions for the dashboard, captured so planning surfaces them.
- [Affects R12][Design] Whether the `always` choice needs a stronger affordance or confirmation than `once` to prevent an accidental persistent grant.

### Monitored Risk

- Per-request clicking could become a click-tax on high-approval-volume runs, pushing operators back to Discord. Policy-based pre-approval (a Phase-2 follow-up) is the mitigation; v1 ships per-request because it is the primitive policy builds on. Watch adoption to decide whether policy should be prioritized next.

---

## Dependencies / Assumptions

- The transport-neutral approval registry (`approvalScopeId`, the `handleDecision` decision entry point, typed actor `WebOperatorActor`) and the operator contract's `PermissionReply`/decision-outcome vocabulary exist and are reused as-is. Swapping `createWebAutoDenyApproval` for an interactive transport is a clean seam.
- The SSE run-stream surfaces the `waiting_for_approval` status overlay (`hasPendingForScope`) today, but its frame union (`ObservationFrame = StatusFrame | ResetFrame | HeartbeatFrame | OutputFrame`) carries status/output only, not the requestID/title. Adding the approval frame (R3) is a real protocol change across the manager's closed frame union, the SSE writer's exhaustiveness guard, the tests, and any client consumer — not a status overlay. Planning must treat it as a frame-type addition.
- The GET pending-approvals endpoint (R5/R13) does not exist yet; it is a net-new route whose shape, response DTO, and reconciliation behavior planning must design. The shared `checkRepoAuthz` helper used by the other privileged routes (launch, run-state, SSE) is reusable for both this endpoint's and the decision route's authz, so the authz primitive is shared even though no approval routes exist yet.
- The `permission.asked` event carries `requestID` (`properties.id`), `sessionID`, `permission` (gate category), `patterns`, and optional `metadata` (including `command`/`filepath`). v1 surfaces the `command`/`filepath` and category (R4), not a full file-content diff.
- Determining the operator's permission level (read vs write/admin) for R7 is new capability: the current `checkRepoAuthz` proves read access only. Planning must source the permission level (e.g. the GitHub `GET /repos/{owner}/{repo}` `permissions` field or the collaborator-permission endpoint) and decide its caching/freshness against the submit-time re-check.
- The deadline/claim machinery (atomic single-winner claim, fail-close at the deadline) is load-bearing for R8 and is reused exactly as-is; v1 does not change the deadline duration or settlement semantics.

---

## Sources / Research

- `packages/gateway/src/web/operator/web-approval.ts` — `createWebAutoDenyApproval`, the auto-deny stub being replaced (and its documented rationale for existing).
- `packages/gateway/src/approvals/` — `coordinator.ts` (`PermissionRequest` shape, `deriveTitle` reading `metadata.command`/`metadata.filepath`), `registry.ts` (transport-neutral registry, `ApprovalActor`), `discord-transport.ts` (the proven reference transport), `approval-flow.integration.test.ts`.
- `packages/gateway/src/web/sse/projection.ts` — the `waiting_for_approval` overlay via `hasPendingForScope`; the SSE frame currently carries status only, not the requestID/title.
- `packages/gateway/src/operator-contract/approval.ts` — `PermissionReply` (`once`/`always`/`reject`) and the decision-outcome vocabulary.
- `packages/gateway/src/operator-contract/run-status.ts` — `OperatorRunStatus` (the current SSE frame shape).
- `packages/gateway/src/discord/approvals.ts` — `buildApprovalEmbed`, the redaction-safe rendering reference ("never renders raw patterns, tool inputs, or the requestID").
- `docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md` — the Phase B web-operator surface plan this unit completes.
