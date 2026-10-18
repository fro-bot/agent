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
 *   2. RunIndex.lookup(runId) → server-owned repo; miss → notFoundResponse
 *   3. Split owner/repo (strip stray '#')
 *   4. resolveRepoAccess (bound AND not denylisted, one binding read); anything
 *      but `allowed` → notFoundResponse
 *   5. Per-operator rate limit (keyed on operator identity)
 *   6. Return registry.describePendingForScope(runId) as a bounded DTO list
 *      (hard-capped at PENDING_APPROVALS_MAX_RESULTS entries)
 *
 * Security invariants:
 *   - approvalScopeId is run.run_id resolved server-side — NEVER from the client.
 *   - Every denial at gates 2–4 returns the identical no-oracle notFoundResponse.
 *   - A gate throw degrades to the same no-oracle denial, not a distinguishable 500.
 *   - An authorized operator with NO open requests returns 200 {approvals: []} —
 *     this is NOT an oracle because they are already authorized for that run.
 *   - Reads and writes share one repo-access predicate; no GitHub call is made.
 *   - Results are hard-capped at PENDING_APPROVALS_MAX_RESULTS (defensive).
 *   - Per-operator rate limit prevents enumeration abuse.
 */

import type {Hono} from 'hono'
import type {ApprovalRegistry, PendingApprovalDTO} from '../../approvals/registry.js'
import type {RunIndex} from '../../execute/run-index.js'
import type {RateLimiter} from '../../http/rate-limit.js'
import type {DenylistCache} from '../../redaction/denylist.js'
import type {BindingsLookup} from '../../redaction/surface-gate.js'
import type {OperatorLogger} from '../server.js'
import {createRateLimiter} from '../../http/rate-limit.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {notFoundResponse, rateLimitedResponse} from '../safe-response.js'
import {resolveRepoAccess, resolveRepoFromRunIndex} from './route-helpers.js'

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
  /** Server-owned run index for runId → repo resolution. */
  readonly runIndex: Pick<RunIndex, 'lookup'>
  /** Denylist cache for pre-read redaction check. */
  readonly denylistCache: DenylistCache
  /** Bindings lookup for deny-key resolution. */
  readonly bindingsLookup: BindingsLookup
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
    // ── Gate 1: Read authenticated context set by the guard ──────────────────
    // In production the guard always sets this; undefined is unreachable.
    // Return not-found as a safe fallback (no oracle — same shape as all denials).
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'pending-approvals: denied')
      return notFoundResponse(c)
    }

    const {githubUserId} = authCtx

    // ── Gates 2–4: Pre-read authorization gates ──────────────────────────────
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
        deps.logger.warn({githubUserId, runId, gate: 'runIndex-miss-or-malformed'}, 'pending-approvals: denied')
        return notFoundResponse(c)
      }
      const {owner, repo} = resolved

      // ── Gate 4: Repo access (bound AND not denylisted, fail-closed) ───────
      // One binding read. Unbound and denylisted share one denial label so the
      // log is not an existence oracle; repo-level denials emit no audit event.
      const access = await resolveRepoAccess(owner, repo, deps)
      if (access.kind !== 'allowed') {
        deps.logger.warn(
          {githubUserId, gate: access.kind === 'denied' ? 'repo-denied' : 'repo-unavailable'},
          'pending-approvals: denied',
        )
        return notFoundResponse(c)
      }
    } catch (error: unknown) {
      deps.logger.warn(
        {runId: c.req.param('runId') ?? '', githubUserId, error},
        'pending-approvals: gate threw — denying',
      )
      return notFoundResponse(c)
    }

    // ── Gate 5: Per-operator rate limit ──────────────────────────────────────
    // Keyed on string(githubUserId) so the limit is per-operator, not per-run.
    // Rate limit is applied AFTER authz gates so only authorized operators consume
    // the budget (unauthorized requests are denied at gate 4 before reaching here).
    const operatorKey = String(githubUserId)
    if (limiter.allow(operatorKey) === false) {
      deps.logger.warn({githubUserId, runId, gate: 'rate-limited'}, 'pending-approvals: rate limited')
      return rateLimitedResponse(c)
    }

    // ── Gate 6: Return bounded pending approval DTOs ─────────────────────────
    // describePendingForScope returns only open/claimed entries for this runId.
    // Hard-cap the result to PENDING_APPROVALS_MAX_RESULTS (defensive).
    // An empty list is a valid authorized response — not an oracle.
    const all = deps.registry.describePendingForScope(runId)
    const approvals = all.length > PENDING_APPROVALS_MAX_RESULTS ? all.slice(0, PENDING_APPROVALS_MAX_RESULTS) : all

    return c.json({approvals}, 200)
  })
}
