/**
 * Authenticated decision route: POST /operator/runs/:runId/approvals/:requestId/decision
 *
 * Settles a once/always/reject decision for a pending tool-approval request
 * through the transport-neutral approval registry. This is the write-gated
 * settlement path for the web operator surface.
 *
 * Gate ordering (all must pass before handleDecision is called):
 *   1. Guard (browser/session/allowlist/CSRF) — installed by buildOperatorApp
 *   2. Resolve session + OAuth token by sessionId
 *   3. Resolve runId → repo via RunIndex (server-owned; never client-supplied)
 *   4. Split owner/repo from the resolved location
 *   5. Resolve binding deny-keys; prime denylist; check isRepoDenied
 *   6. checkRepoWriteAuthz (WRITE-level — not read; insufficient_permission → denial)
 *   7. Parse + validate decision from body against PermissionReply allowlist
 *   8. Build WebOperatorActor from the operator auth context
 *   9. registry.handleDecision({requestID, approvalScopeId: run.run_id, decision, actor})
 *  10. Emit ApprovalDecisionEvent audit record
 *  11. Map DecisionOutcome via toOperatorDecisionState → JSON response
 *
 * Security invariants:
 *   - approvalScopeId is run.run_id resolved server-side — NEVER from the client.
 *   - Every denial at gates 2–6 returns the identical no-oracle notFoundResponse.
 *   - A gate throw degrades to the same no-oracle denial, not a distinguishable 500.
 *   - Read-only operators (insufficient_permission) are denied at gate 6.
 *   - Cross-scope requestIDs (channel-mismatch) and already-settled requestIDs
 *     (already-claimed/not-found) are mapped via toOperatorDecisionState — no
 *     second settlement, no side effects.
 *   - No continuous-authz lease: a decision is a single HTTP request; write-authz
 *     + handleDecision ARE the gate.
 *   - CSRF/Origin middleware covers this POST route (write route).
 */

import type {Hono} from 'hono'
import type {ApprovalRegistry} from '../../approvals/registry.js'
import type {RunIndex} from '../../execute/run-index.js'
import type {PermissionReply} from '../../operator-contract/approval.js'
import type {DenylistCache} from '../../redaction/denylist.js'
import type {BindingsLookup} from '../../redaction/surface-gate.js'
import type {AuditLogger} from '../audit.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {SessionStore} from '../auth/session.js'
import type {OperatorLogger} from '../server.js'
import {toOperatorDecisionState} from '../../operator-contract/approval.js'
import {resolveBindingDenyKeys} from '../../redaction/surface-gate.js'
import {emitAudit} from '../audit.js'
import {checkRepoWriteAuthz} from '../auth/repo-authz.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {notFoundResponse} from '../safe-response.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies for the decision route. */
export interface DecisionRouteDeps {
  /** Session store for token retrieval. */
  readonly sessionStore: Pick<SessionStore, 'getOperatorToken' | 'get'>
  /** Server-owned run index for runId → repo resolution. */
  readonly runIndex: Pick<RunIndex, 'lookup'>
  /** Denylist cache for pre-decision redaction check. */
  readonly denylistCache: DenylistCache
  /** Bindings lookup for deny-key resolution. */
  readonly bindingsLookup: BindingsLookup
  /** Repo authorization dependencies (write-level). */
  readonly repoAuthzDeps: RepoAuthzDeps
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

    // ── Gates 2–6: Pre-decision authorization gates ──────────────────────────
    // Wrapped in try/catch so any unexpected throw returns the uniform not-found
    // shape rather than propagating to Hono as a 500 (which would be distinguishable
    // from the 404 and break the no-oracle property).
    let token: string
    let runId: string
    let owner: string
    let repo: string

    try {
      // ── Gate 2: Resolve OAuth token ──────────────────────────────────────
      const resolvedToken = deps.sessionStore.getOperatorToken(sessionId, nowMs)
      if (resolvedToken === undefined) {
        deps.logger.warn({githubUserId, gate: 'no-token'}, 'decision: denied')
        return notFoundResponse(c)
      }
      token = resolvedToken

      // ── Gate 3: Resolve runId → repo (server-owned) ──────────────────────
      // The repo is NEVER taken from the client. RunIndex.lookup is the sole authority.
      runId = c.req.param('runId') ?? ''
      const location = await deps.runIndex.lookup(runId)
      if (location === undefined) {
        deps.logger.warn({githubUserId, runId, gate: 'runIndex-miss'}, 'decision: denied')
        return notFoundResponse(c)
      }

      // ── Gate 4: Split owner/repo ─────────────────────────────────────────
      // Strip any trailing `#...` suffix before splitting so future entity_ref
      // formats with a fragment do not bleed into the repo name.
      const repoPath = location.repo.split('#')[0] ?? location.repo
      const slashIdx = repoPath.indexOf('/')
      if (slashIdx === -1) {
        deps.logger.warn({githubUserId, runId, gate: 'malformed-repo'}, 'decision: denied')
        return notFoundResponse(c)
      }
      owner = repoPath.slice(0, slashIdx)
      repo = repoPath.slice(slashIdx + 1)
      if (owner.length === 0 || repo.length === 0) {
        deps.logger.warn({githubUserId, runId, gate: 'malformed-repo'}, 'decision: denied')
        return notFoundResponse(c)
      }

      // ── Gate 5: Redaction check (denylist before authz, fail-closed) ─────
      // Resolve deny-keys from the binding store (fail-closed on error/missing).
      // Prime/refresh the denylist cache, then check synchronously.
      // This runs BEFORE checkRepoWriteAuthz so a denylisted repo never triggers
      // a GitHub call.
      const denyKeys = await resolveBindingDenyKeys(owner, repo, deps.bindingsLookup)
      await deps.denylistCache.getDenylistState()
      if (deps.denylistCache.isRepoDenied(denyKeys) === true) {
        deps.logger.warn({githubUserId, runId, gate: 'denylisted'}, 'decision: denied')
        return notFoundResponse(c)
      }

      // ── Gate 6: Write-level repo authorization ───────────────────────────
      // WRITE (not read) — a read-only operator must be denied here.
      // Uses a short (~60 s) positive TTL for revocation safety.
      const authzResult = await checkRepoWriteAuthz(githubUserId, owner, repo, token, deps.repoAuthzDeps)
      if (authzResult.authorized === false) {
        deps.logger.warn({githubUserId, runId, gate: 'write-authz-denied'}, 'decision: denied')
        return notFoundResponse(c)
      }
    } catch (error: unknown) {
      deps.logger.warn({runId: c.req.param('runId') ?? '', githubUserId, error}, 'decision: gate threw — denying')
      return notFoundResponse(c)
    }

    // ── Gate 7: Parse + validate decision from body ──────────────────────────
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

    // ── Gate 8: Build WebOperatorActor from the operator auth context ────────
    // The actor is the typed identity for attribution (R9). We need the login
    // from the session store.
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

    // ── Gate 9: Settle through the registry ─────────────────────────────────
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

    // ── Gate 10: Emit audit record ───────────────────────────────────────────
    // Emit on every outcome — the audit record captures the decision attempt
    // regardless of whether it settled (ok) or was rejected (scope_mismatch,
    // already_claimed, etc.).
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

    // ── Gate 11: Map outcome → JSON response ─────────────────────────────────
    const state = toOperatorDecisionState(outcome)
    return c.json({state}, 200)
  })
}
