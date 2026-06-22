/**
 * Authenticated pending-approvals route: GET /operator/runs/:runId/approvals
 *
 * Returns the currently-open approval request(s) for a run so a reconnecting
 * or late-joining browser can recover the approval prompt without relying on
 * the SSE stream replay. This is the reconciliation fallback to the SSE
 * approval frame.
 *
 * Gate ordering (all must pass before any data is returned):
 *   1. Guard (browser/session/allowlist) — installed by buildOperatorApp
 *   2. Resolve session + OAuth token by sessionId
 *   3. RunIndex.lookup(runId) → server-owned repo; miss → notFoundResponse
 *   4. Split owner/repo (strip stray '#')
 *   5. Denylist check (redaction BEFORE authz); denied → notFoundResponse
 *   6. checkRepoAuthz (READ-level — sufficient for observing/reconnecting)
 *   7. Per-operator rate limit (keyed on operator identity)
 *   8. Return registry.describePendingForScope(runId) as a bounded DTO list
 *      (hard-capped at PENDING_APPROVALS_MAX_RESULTS entries)
 *
 * Security invariants:
 *   - approvalScopeId is run.run_id resolved server-side — NEVER from the client.
 *   - Every denial at gates 2–6 returns the identical no-oracle notFoundResponse.
 *   - A gate throw degrades to the same no-oracle denial, not a distinguishable 500.
 *   - An authorized operator with NO open requests returns 200 {approvals: []} —
 *     this is NOT an oracle because they are already authorized for that run.
 *   - Read-level authz is sufficient here; write-level is required only for the
 *     decision POST route.
 *   - Results are hard-capped at PENDING_APPROVALS_MAX_RESULTS (defensive).
 *   - Per-operator rate limit prevents enumeration abuse.
 */

import type {Hono} from 'hono'
import type {ApprovalRegistry, PendingApprovalDTO} from '../../approvals/registry.js'
import type {RunIndex} from '../../execute/run-index.js'
import type {RateLimiter} from '../../http/rate-limit.js'
import type {DenylistCache} from '../../redaction/denylist.js'
import type {BindingsLookup} from '../../redaction/surface-gate.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {SessionStore} from '../auth/session.js'
import type {OperatorLogger} from '../server.js'
import {createRateLimiter} from '../../http/rate-limit.js'
import {resolveBindingDenyKeys} from '../../redaction/surface-gate.js'
import {checkRepoAuthz} from '../auth/repo-authz.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {notFoundResponse, rateLimitedResponse} from '../safe-response.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard cap on the number of pending approval DTOs returned per request.
 * Defensive limit — a run should never have more than a handful of concurrent
 * open requests, but we cap to prevent any unbounded enumeration.
 */
export const PENDING_APPROVALS_MAX_RESULTS = 50

/** Per-operator rate limit: 30 requests per minute for the enumeration endpoint. */
const PENDING_APPROVALS_RATE_LIMIT = 30
const PENDING_APPROVALS_RATE_WINDOW_MS = 60_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies for the pending-approvals route. */
export interface PendingApprovalsRouteDeps {
  /** Session store for token retrieval. */
  readonly sessionStore: Pick<SessionStore, 'getOperatorToken'>
  /** Server-owned run index for runId → repo resolution. */
  readonly runIndex: Pick<RunIndex, 'lookup'>
  /** Denylist cache for pre-read redaction check. */
  readonly denylistCache: DenylistCache
  /** Bindings lookup for deny-key resolution. */
  readonly bindingsLookup: BindingsLookup
  /** Repo authorization dependencies (read-level). */
  readonly repoAuthzDeps: RepoAuthzDeps
  /** Approval registry — the sole source of pending request detail. */
  readonly registry: Pick<ApprovalRegistry, 'describePendingForScope'>
  /** Structured logger. */
  readonly logger: OperatorLogger
  /** Injectable clock. */
  readonly now: () => number
  /**
   * Optional injectable per-operator rate limiter.
   * When absent, a fresh limiter is created with PENDING_APPROVALS_RATE_LIMIT.
   */
  readonly rateLimiter?: RateLimiter
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/** Response body for GET /operator/runs/:runId/approvals */
export interface PendingApprovalsResponse {
  readonly approvals: readonly PendingApprovalDTO[]
}

// ---------------------------------------------------------------------------
// Route builder
// ---------------------------------------------------------------------------

/**
 * Register GET /operator/runs/:runId/approvals on the given Hono app.
 *
 * Must be called after setOperatorRouteGuard is installed in buildOperatorApp.
 * The guard runs first (browser/session/allowlist); this handler runs only
 * if the guard allows the request.
 *
 * Response body: {approvals: PendingApprovalDTO[]} — the open requests for the run.
 * An empty array means no open requests (not an oracle — the operator is authorized).
 */
export function buildPendingApprovalsRoute(app: Hono, deps: PendingApprovalsRouteDeps): void {
  const limiter =
    deps.rateLimiter ??
    createRateLimiter({
      limit: PENDING_APPROVALS_RATE_LIMIT,
      windowMs: PENDING_APPROVALS_RATE_WINDOW_MS,
      clock: deps.now,
    })

  registerOperatorRoute(app, 'GET', '/operator/runs/:runId/approvals', async c => {
    const nowMs = deps.now()

    // ── Gate 1: Read authenticated context set by the guard ──────────────────
    // In production the guard always sets this; undefined is unreachable.
    // Return not-found as a safe fallback (no oracle — same shape as all denials).
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'pending-approvals: denied')
      return notFoundResponse(c)
    }

    const {githubUserId, sessionId} = authCtx

    // ── Gates 2–6: Pre-read authorization gates ──────────────────────────────
    // Wrapped in try/catch so any unexpected throw returns the uniform not-found
    // shape rather than propagating to Hono as a 500 (which would be distinguishable
    // from the 404 and break the no-oracle property).
    let runId: string

    try {
      // ── Gate 2: Resolve OAuth token ──────────────────────────────────────
      const resolvedToken = deps.sessionStore.getOperatorToken(sessionId, nowMs)
      if (resolvedToken === undefined) {
        deps.logger.warn({githubUserId, gate: 'no-token'}, 'pending-approvals: denied')
        return notFoundResponse(c)
      }

      // ── Gate 3: Resolve runId → repo (server-owned) ──────────────────────
      // The repo is NEVER taken from the client. RunIndex.lookup is the sole authority.
      runId = c.req.param('runId') ?? ''
      const location = await deps.runIndex.lookup(runId)
      if (location === undefined) {
        deps.logger.warn({githubUserId, runId, gate: 'runIndex-miss'}, 'pending-approvals: denied')
        return notFoundResponse(c)
      }

      // ── Gate 4: Split owner/repo ─────────────────────────────────────────
      // Strip any trailing `#...` suffix before splitting so future entity_ref
      // formats with a fragment do not bleed into the repo name.
      const repoPath = location.repo.split('#')[0] ?? location.repo
      const slashIdx = repoPath.indexOf('/')
      if (slashIdx === -1) {
        deps.logger.warn({githubUserId, runId, gate: 'malformed-repo'}, 'pending-approvals: denied')
        return notFoundResponse(c)
      }
      const owner = repoPath.slice(0, slashIdx)
      const repo = repoPath.slice(slashIdx + 1)
      if (owner.length === 0 || repo.length === 0) {
        deps.logger.warn({githubUserId, runId, gate: 'malformed-repo'}, 'pending-approvals: denied')
        return notFoundResponse(c)
      }

      // ── Gate 5: Redaction check (denylist before authz, fail-closed) ─────
      // Resolve deny-keys from the binding store (fail-closed on error/missing).
      // Prime/refresh the denylist cache, then check synchronously.
      // This runs BEFORE checkRepoAuthz so a denylisted repo never triggers
      // a GitHub call.
      const denyKeys = await resolveBindingDenyKeys(owner, repo, deps.bindingsLookup)
      await deps.denylistCache.getDenylistState()
      if (deps.denylistCache.isRepoDenied(denyKeys) === true) {
        deps.logger.warn({githubUserId, runId, gate: 'denylisted'}, 'pending-approvals: denied')
        return notFoundResponse(c)
      }

      // ── Gate 6: Read-level repo authorization ────────────────────────────
      // READ (not write) — observing/reconnecting needs only read access.
      // The decision POST route uses write-level authz; this GET uses read-level.
      const authzResult = await checkRepoAuthz(githubUserId, owner, repo, resolvedToken, deps.repoAuthzDeps)
      if (authzResult.authorized === false) {
        deps.logger.warn({githubUserId, runId, gate: 'read-authz-denied'}, 'pending-approvals: denied')
        return notFoundResponse(c)
      }
    } catch (error: unknown) {
      deps.logger.warn(
        {runId: c.req.param('runId') ?? '', githubUserId, error},
        'pending-approvals: gate threw — denying',
      )
      return notFoundResponse(c)
    }

    // ── Gate 7: Per-operator rate limit ──────────────────────────────────────
    // Keyed on string(githubUserId) so the limit is per-operator, not per-run.
    // Rate limit is applied AFTER authz gates so only authorized operators consume
    // the budget (unauthorized requests are denied at gate 6 before reaching here).
    const operatorKey = String(githubUserId)
    if (limiter.allow(operatorKey) === false) {
      deps.logger.warn({githubUserId, runId, gate: 'rate-limited'}, 'pending-approvals: rate limited')
      return rateLimitedResponse(c)
    }

    // ── Gate 8: Return bounded pending approval DTOs ─────────────────────────
    // describePendingForScope returns only open/claimed entries for this runId.
    // Hard-cap the result to PENDING_APPROVALS_MAX_RESULTS (defensive).
    // An empty list is a valid authorized response — not an oracle.
    const all = deps.registry.describePendingForScope(runId)
    const approvals = all.length > PENDING_APPROVALS_MAX_RESULTS ? all.slice(0, PENDING_APPROVALS_MAX_RESULTS) : all

    return c.json({approvals}, 200)
  })
}
