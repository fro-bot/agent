/**
 * Authenticated decision route: POST /operator/runs/:runId/approvals/:requestId/decision
 *
 * Settles a once/always/reject decision for a pending tool-approval request
 * through the transport-neutral approval registry. This is the write-gated
 * settlement path for the web operator surface.
 *
 * Gate ordering (all must pass before handleDecision is called):
 *   1. Guard (browser/session/allowlist/CSRF) — installed by buildOperatorApp
 *   2. Resolve runId → repo via RunIndex (server-owned; never client-supplied)
 *   3. Split owner/repo from the resolved location
 *   4. resolveRepoAccess (bound AND not denylisted, one binding read) — the same
 *      predicate the read routes use; anything but `allowed` → notFoundResponse
 *   5. Parse + validate decision from body against PermissionReply allowlist
 *   6. Build WebOperatorActor from the operator auth context
 *   7. registry.handleDecision({requestID, approvalScopeId: run.run_id, decision, actor})
 *   8. Emit ApprovalDecisionEvent audit record
 *   9. Map DecisionOutcome via toOperatorDecisionState → JSON response
 *
 * Security invariants:
 *   - approvalScopeId is run.run_id resolved server-side — NEVER from the client.
 *   - Every denial at gates 2–4 returns the identical no-oracle notFoundResponse.
 *   - A gate throw degrades to the same no-oracle denial, not a distinguishable 500.
 *   - Cross-scope requestIDs (channel-mismatch) and already-settled requestIDs
 *     (already-claimed/not-found) are mapped via toOperatorDecisionState — no
 *     second settlement, no side effects.
 *   - No continuous-authz lease: a decision is a single HTTP request; the repo-access
 *     predicate + handleDecision ARE the gate. No GitHub call is made.
 *   - CSRF/Origin middleware covers this POST route (write route).
 */

import type {Hono} from 'hono'
import type {ApprovalRegistry, DecisionOutcome} from '../../approvals/registry.js'
import type {RunIndex} from '../../execute/run-index.js'
import type {PermissionReply} from '../../operator-contract/approval.js'
import type {DenylistCache} from '../../redaction/denylist.js'
import type {BindingsLookup} from '../../redaction/surface-gate.js'
import type {ApprovalRejectedReason, AuditLogger} from '../audit.js'
import type {SessionStore} from '../auth/session.js'
import type {OperatorLogger} from '../server.js'
import {toOperatorDecisionState} from '../../operator-contract/approval.js'
import {emitAudit} from '../audit.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {notFoundResponse} from '../safe-response.js'
import {resolveRepoAccess, resolveRepoFromRunIndex} from './route-helpers.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies for the decision route. */
export interface DecisionRouteDeps {
  /** Session store for the actor's display login. */
  readonly sessionStore: Pick<SessionStore, 'get'>
  /** Server-owned run index for runId → repo resolution. */
  readonly runIndex: Pick<RunIndex, 'lookup'>
  /** Denylist cache for pre-decision redaction check. */
  readonly denylistCache: DenylistCache
  /** Bindings lookup for deny-key resolution. */
  readonly bindingsLookup: BindingsLookup
  /** Approval registry — the sole settlement path. */
  readonly registry: Pick<ApprovalRegistry, 'handleDecision'>
  /** Audit logger for security events. */
  readonly auditLogger: AuditLogger
  /** Structured logger. */
  readonly logger: OperatorLogger
  /** Injectable clock. */
  readonly now: () => number
}

// ---------------------------------------------------------------------------
// Allowed decision values
// ---------------------------------------------------------------------------

/** The set of valid PermissionReply values accepted by this route. */
const ALLOWED_DECISIONS: ReadonlySet<string> = new Set<PermissionReply>(['once', 'always', 'reject'])

function isPermissionReply(value: unknown): value is PermissionReply {
  return typeof value === 'string' && ALLOWED_DECISIONS.has(value)
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

/**
 * Map a non-ok DecisionOutcome to the ApprovalRejectedReason taxonomy.
 *
 * 'ok' is excluded — callers must only call this for non-ok outcomes.
 *
 * Note: 'deadline_expired' is intentionally absent from this switch. Deadline
 * settlement is owned internally by the registry (it expires pending requests
 * on its own timer) and never surfaces as a DecisionOutcome returned by
 * handleDecision. The 'deadline_expired' reason exists in the ApprovalRejectedReason
 * taxonomy for the registry's own internal audit path, not for this route.
 */
function decisionOutcomeToRejectedReason(outcome: Exclude<DecisionOutcome, 'ok'>): ApprovalRejectedReason {
  switch (outcome) {
    case 'already-claimed':
      return 'already_claimed'
    case 'not-found':
      return 'not_found'
    case 'channel-mismatch':
      return 'scope_mismatch'
    case 'reply-failed':
      return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// Route builder
// ---------------------------------------------------------------------------

/**
 * Register POST /operator/runs/:runId/approvals/:requestId/decision on the given Hono app.
 *
 * Must be called after setOperatorRouteGuard is installed in buildOperatorApp.
 * The guard runs first (browser/session/allowlist/CSRF); this handler runs only
 * if the guard allows the request.
 *
 * Response body: {state: OperatorDecisionState} — the outcome of the decision.
 */
export function buildDecisionRoute(app: Hono, deps: DecisionRouteDeps): void {
  registerOperatorRoute(app, 'POST', '/operator/runs/:runId/approvals/:requestId/decision', async c => {
    const nowMs = deps.now()

    // ── Gate 1: Read authenticated context set by the guard ──────────────────
    // In production the guard always sets this; undefined is unreachable.
    // Return not-found as a safe fallback (no oracle — same shape as all denials).
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'decision: denied')
      return notFoundResponse(c)
    }

    const {githubUserId, sessionId} = authCtx

    // ── Gates 2–4: Pre-decision authorization gates ──────────────────────────
    // Wrapped in try/catch so any unexpected throw returns the uniform not-found
    // shape rather than propagating to Hono as a 500 (which would be distinguishable
    // from the 404 and break the no-oracle property).
    let runId: string

    try {
      // ── Gates 2–3: Resolve runId → {owner, repo} (server-owned) ────────────
      // The repo is NEVER taken from the client. RunIndex.lookup is the sole authority.
      // resolveRepoFromRunIndex handles the lookup + owner/repo split in one call.
      runId = c.req.param('runId') ?? ''
      const resolved = await resolveRepoFromRunIndex(runId, deps.runIndex)
      if (resolved === null) {
        deps.logger.warn({githubUserId, runId, gate: 'runIndex-miss-or-malformed'}, 'decision: denied')
        return notFoundResponse(c)
      }
      const {owner, repo} = resolved

      // ── Gate 4: Repo access (bound AND not denylisted, fail-closed) ─────
      // Same predicate as the read routes. Unbound and denylisted share one denial
      // label; repo-level denials emit no audit event.
      const access = await resolveRepoAccess(owner, repo, deps)
      if (access.kind !== 'allowed') {
        deps.logger.warn(
          {githubUserId, gate: access.kind === 'denied' ? 'repo-denied' : 'repo-unavailable'},
          'decision: denied',
        )
        return notFoundResponse(c)
      }
    } catch (error: unknown) {
      deps.logger.warn({runId: c.req.param('runId') ?? '', githubUserId, error}, 'decision: gate threw — denying')
      return notFoundResponse(c)
    }

    // ── Gate 5: Parse + validate decision from body ──────────────────────────
    // Invalid value → 400 (clear bad-request, but does NOT leak whether the
    // requestId exists — the body error is about the decision field, not the ID).
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      deps.logger.warn({githubUserId, runId, gate: 'bad-body'}, 'decision: denied — invalid JSON body')
      return c.json({error: 'bad request'}, 400)
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      deps.logger.warn({githubUserId, runId, gate: 'bad-body'}, 'decision: denied — body is not a plain object')
      return c.json({error: 'bad request'}, 400)
    }

    const bodyObj = body as Record<string, unknown>
    const decisionField = bodyObj.decision

    if (!isPermissionReply(decisionField)) {
      deps.logger.warn({githubUserId, runId, gate: 'invalid-decision'}, 'decision: denied — invalid decision value')
      return c.json({error: 'bad request'}, 400)
    }

    const decision: PermissionReply = decisionField

    // ── Gates 6–9: Post-authz settlement gates ──────────────────────────────
    // Wrapped in try/catch so any unexpected throw (e.g. toOperatorDecisionState
    // on an unhandled DecisionOutcome variant) returns the uniform not-found
    // shape rather than propagating to Hono as a distinguishable 500.
    // Gate 5 (decision validation) is intentionally OUTSIDE this block — it is
    // a legitimate client error (400) that stays before the post-authz gates.
    try {
      // ── Gate 6: Build WebOperatorActor from the operator auth context ──────
      // The actor is the typed identity for attribution on the settled decision.
      // We need the login from the session store.
      const sessionEntry = deps.sessionStore.get(sessionId, nowMs)
      if (sessionEntry === undefined) {
        deps.logger.warn({githubUserId, runId, gate: 'no-session'}, 'decision: denied — session missing')
        return notFoundResponse(c)
      }

      const actor = {
        kind: 'web-operator' as const,
        githubUserId,
        login: sessionEntry.login,
        sessionCorrelationId: sessionId,
      }

      // ── Gate 7: Settle through the registry ───────────────────────────────
      // handleDecision is the ONLY settlement path. approvalScopeId is run.run_id
      // resolved server-side — NEVER from the client.
      // The requestId comes from the URL param (not the body).
      const requestId = c.req.param('requestId') ?? ''

      const outcome = await deps.registry.handleDecision({
        requestID: requestId,
        approvalScopeId: runId,
        decision,
        actor,
      })

      // ── Gate 8: Emit audit record ─────────────────────────────────────────
      // Emit approval.decision only when the registry accepted the decision (ok).
      // For non-ok outcomes emit approval.rejected with the mapped reason so the
      // audit taxonomy preserves the rejection cause.
      if (outcome === 'ok') {
        emitAudit(
          {
            kind: 'approval.decision',
            correlationId: `decision:${githubUserId}:${runId}:${requestId}`,
            githubUserId,
            requestId,
            decision,
          },
          deps.auditLogger,
        )
      } else {
        const rejectedReason = decisionOutcomeToRejectedReason(outcome)
        emitAudit(
          {
            kind: 'approval.rejected',
            correlationId: `decision:${githubUserId}:${runId}:${requestId}`,
            githubUserId,
            requestId,
            reason: rejectedReason,
          },
          deps.auditLogger,
        )
      }

      // ── Gate 9: Map outcome → JSON response ───────────────────────────────
      const state = toOperatorDecisionState(outcome)
      return c.json({state}, 200)
    } catch (error: unknown) {
      deps.logger.warn({runId, githubUserId, error}, 'decision: post-authz gate threw — denying (no-oracle)')
      return notFoundResponse(c)
    }
  })
}
