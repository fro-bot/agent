---
date: 2026-06-15
topic: gateway-control-surface-phase-b
---

# Gateway control surface Phase B requirements

## Summary

Phase B adds an authenticated web operator control surface for the Gateway. It lets approved human operators launch work, observe run state, and approve or reject tool requests through the same execution and approval spine Discord already uses.

---

## Problem Frame

The Gateway can already run Fro Bot work from Discord and settle OpenCode permission requests through Discord approvals. Phase A extracted the shared execution and approval seam so non-Discord transports can use the same queue, concurrency, and fail-closed permission model.

The web side is still missing. The existing HTTP surface is HMAC-authenticated announce ingress, not browser operator control. A dashboard or web console cannot safely launch work, stream status, or settle approvals until the Gateway has a dedicated authenticated operator surface with a real human identity boundary.

---

## Actors

- A1. Web operator: a GitHub-authenticated human present in the configured operator allowlist.
- A2. Gateway: the trusted first-party service that owns run coordination, approval settlement, and coarse user-facing errors.
- A3. Discord operator: an existing Discord user path that must keep working through the shared execution and approval spine.
- A4. Workspace/container caller: an untrusted network neighbor that must not gain a new egress bypass through the web surface.
- A5. Operator web client: the first-party browser surface used by an authenticated operator.

---

## Key Flows

- F1. Web-launched work
  - **Trigger:** An allowed web operator submits work for a bound repository.
  - **Actors:** A1, A2, A5
  - **Steps:** The operator authenticates, chooses a bound repository, submits work, and receives status updates while the Gateway runs the work through the shared execution front door.
  - **Outcome:** The run follows the same queue, concurrency, shutdown, and failure semantics as Discord-launched work.
  - **Covered by:** R1, R2, R3, R6, R10, R11
- F2. Web approval decision
  - **Trigger:** A running OpenCode session asks for a tool permission.
  - **Actors:** A1, A2, A3
  - **Steps:** The Gateway exposes the pending approval to authorized operators, accepts the first valid decision, and settles it through the shared approval registry.
  - **Outcome:** Approval behavior remains fail-closed and single-winner across Discord and web transports.
  - **Covered by:** R7, R8, R9
- F3. Run state observation
  - **Trigger:** A web operator opens an active or recent run.
  - **Actors:** A1, A2, A5
  - **Steps:** The client reads a bounded run-status taxonomy, receives progress updates, and sees terminal status without access to secrets or raw internal payloads.
  - **Outcome:** The operator can understand what the Gateway is doing without bypassing the agent or workspace trust boundary.
  - **Covered by:** R7, R10, R11, R12
- F4. Read-only bindings lookup
  - **Trigger:** The operator web client needs Gateway repo-to-Discord binding data to support repo selection or dashboard state.
  - **Actors:** A1, A2, A5
  - **Steps:** The authenticated surface exposes binding reads scoped to the operator and requested repository context without exposing create, update, or delete operations.
  - **Outcome:** The operator can see relevant binding state while v1 keeps binding mutation out of the web surface.
  - **Covered by:** R18, R19, R20

---

## Requirements

**Operator access**
- R1. The web surface is available only to GitHub-authenticated humans who are present in a configured operator allowlist.
- R2. Operator sessions must have explicit lifetime, logout, and revocation semantics.
- R3. State-changing browser requests must be protected against CSRF and invalid origins.
- R4. The web surface rejects unauthenticated users, unauthorized users, expired sessions, and invalid browser-origin requests without disclosing sensitive internal state.
- R5. Phase B v1 excludes standalone machine/API callers, long-lived API tokens, and agent-to-agent orchestration.

**Execution and approval semantics**
- R6. Web-launched work must enter the same public execution front door used by Discord-launched work.
- R7. Web approvals must settle through the same fail-closed approval registry used by Discord approvals.
- R8. Approval settlement must remain single-winner across transports, stale tabs, retries, and replayed decision submissions.
- R9. Approval states must distinguish pending, already settled, expired, failed to settle, and unavailable cases for the operator.
- R10. Web launch must prevent accidental duplicate submissions and make empty, unbound, or disabled repository states visible before work starts.
- R11. The web surface must expose a bounded run status taxonomy covering queued, running, waiting for approval, blocked, failed, cancelled, and succeeded states.
- R12. Run progress must use a safe-field allowlist and must not expose raw workspace paths, tool arguments, prompts, internal URLs, tokens, or secret-bearing payload fragments.

**Security and trust boundary**
- R13. The control surface must preserve the Gateway ingress and egress trust boundary; workspace-reachable callers must not be able to use it as an outbound proxy or privileged command channel.
- R14. Operator actions must be attributable to a stable operator identity, including launch, run-state reads, binding reads, approve, reject, and failed authorization attempts.
- R15. User-facing errors must stay coarse, while internal logs keep enough structured context to diagnose auth, queue, run, approval, and transport failures.
- R16. Audit records for auth, launch, approval, rejection, and authorization failures must have a defined retention and protection story.
- R17. The surface must avoid logging raw prompts, request bodies, bearer tokens, session secrets, raw tool payloads, and internal URLs by default.

**Read-only bindings support**
- R18. The authenticated surface may expose read-only Gateway binding data needed for operator repo selection or dashboard state.
- R19. Binding reads must be scoped so an allowed operator cannot enumerate unrelated repositories by default.
- R20. Binding writes, binding deletes, repo onboarding, and binding repair are out of scope for Phase B v1.

---

## Acceptance Examples

- AE1. **Covers R1, R4.** Given a GitHub-authenticated user who is not in the operator allowlist, when they attempt to open or use the web control surface, the Gateway rejects the request with a coarse authorization failure and records a structured denial.
- AE2. **Covers R2, R3.** Given an allowed operator with an expired session or invalid browser origin, when they submit a launch or approval request, the Gateway rejects the request before changing run or approval state.
- AE3. **Covers R5.** Given a caller with only an API token and no browser operator session, when it attempts to launch work, the Gateway rejects it because standalone machine callers are not included in Phase B v1.
- AE4. **Covers R6, R13.** Given an allowed operator launches work for a bound repository, when the run starts, it uses the shared execution front door and cannot bypass the queue or global concurrency cap.
- AE5. **Covers R7, R8, R9.** Given a permission request visible in Discord and web, when the web operator approves first, stale Discord or web submissions cannot reverse or duplicate the decision and see an already-settled state.
- AE6. **Covers R10.** Given an operator selects an unbound or disabled repository, when they attempt to submit work, the web surface explains the blocked state before a run starts.
- AE7. **Covers R11, R12, R15, R17.** Given an active run fails because the workspace is unavailable, when the operator views the run, they see a coarse failure while logs retain structured internal cause without secrets.
- AE8. **Covers R18, R19, R20.** Given the operator web client reads repo binding data, when it uses the authenticated surface, it can list or retrieve scoped bindings but cannot create or modify them.

---

## Success Criteria

- Approved operators can launch and observe Gateway work from the web without changing Discord behavior.
- Web and Discord approvals share the same fail-closed registry, so no transport can bypass permission settlement.
- The web surface has a concrete human auth boundary with revocation and browser-origin protection.
- The ingress and egress boundary remains documented, tested, and reviewable before any listener or topology change ships.
- If included in Phase B, the operator web client can consume read-only binding data without introducing binding mutation in v1.
- A downstream planner does not need to invent actor scope, auth scope, approval semantics, or v1 non-goals.

---

## Scope Boundaries

- No machine/API callers in Phase B v1.
- No agent-to-agent orchestration.
- No dashboard UI implementation in this repo.
- No binding writes, binding deletes, or repo onboarding from the web surface.
- No general Gateway API proxy and no raw workspace/OpenCode API proxy.
- No Discord behavior changes.
- No weakening of the ingress-pin boundary without a documented security rationale and matching tests.
- No persistent approval recovery unless it is deliberately added in planning.

---

## Key Decisions

- **Configured allowlist for v1:** The first web operator surface uses GitHub identity plus an explicit allowlist to minimize blast radius.
- **One execution spine:** Web-launched work uses the shared execution front door so queueing, concurrency, and shutdown semantics stay centralized.
- **One approval gate:** Web approvals reuse the same fail-closed registry as Discord approvals instead of adding a parallel gate.
- **Separate control-surface trust boundary:** The web surface is security-critical and must not be treated as an extension of HMAC announce ingress.
- **Read-only bindings may ride Phase B:** Binding reads can be included as Phase-B-adjacent support if they remain scoped, read-only, and use the same authenticated operator surface.

---

## Dependencies / Assumptions

- Phase A shipped the transport-neutral execution and approval seam via `launchWork`, transport sinks, and a generalized approval registry.
- The preferred topology is a separate web listener or interface that is not reachable from the workspace sandbox network.
- The deploy topology in `marcusrbrown/infra` must support the chosen listener and network boundary.
- The operator allowlist source of truth must be configurable and auditable.
- The state-stream transport can be chosen during planning as long as it supports active observation and safe failure behavior.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1, R2, R3][Technical] What is the exact GitHub login/session mechanism and cookie or token shape?
- [Affects R1, R14, R16][Technical] Where does the operator allowlist live, and how is it updated or revoked?
- [Affects R11, R12][Technical] Should run progress use SSE, WebSocket, or polling for v1?
- [Affects R13][Needs research] Which deploy topology keeps the web surface off the workspace sandbox network with the least operational risk?
- [Affects R18, R19][Technical] Does the binding read path ship in the same first implementation PR as launch/status/approval, or as a follow-up on the same authenticated surface?

---

## Sources / Research

- Tracking issue: https://github.com/fro-bot/agent/issues/907
- Existing brainstorm: `docs/brainstorms/2026-06-15-gateway-control-surface-spine-requirements.md`
- Phase A plan: `docs/plans/2026-06-15-001-feat-gateway-control-surface-spine-phase-a-plan.md`
- Spine pattern doc: `docs/solutions/best-practices/gateway-control-surface-spine-2026-06-15.md`
- Signed ingress hardening: `docs/solutions/best-practices/signed-webhook-ingress-hardening-2026-05-29.md`
- Compose topology hardening: `docs/solutions/best-practices/compose-topology-egress-guard-hardening-2026-06-14.md`
- Mention-loop best practices: `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md`
- Current execution seam: `packages/gateway/src/execute/run.ts`
- Launch contracts: `packages/gateway/src/execute/launch-types.ts`
- Approval registry and coordinator: `packages/gateway/src/approvals/registry.ts`, `packages/gateway/src/approvals/coordinator.ts`
- Current HTTP announce auth: `packages/gateway/src/http/server.ts`, `packages/gateway/src/http/hmac.ts`
- Ingress boundary pin: `packages/gateway/src/http/ingress-pin.test.ts`
- Bindings store: `packages/gateway/src/bindings/store.ts`
