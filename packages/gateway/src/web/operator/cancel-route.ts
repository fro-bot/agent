/**
 * Authenticated cancel route: POST /operator/runs/:runId/cancel
 *
 * Cancels a run whether it is queued (PENDING/ACKNOWLEDGED in the per-channel
 * FIFO) or executing, through the transport-neutral `cancelRun` orchestrator.
 * This is the write-gated cancellation path for the web operator surface.
 *
 * Gate ordering (mirrors decision-route.ts exactly):
 *   1. Guard (browser/session/allowlist/CSRF) — installed by buildOperatorApp
 *   2. Resolve session + OAuth token by sessionId
 *   3. Resolve runId → repo via RunIndex (server-owned; never client-supplied)
 *   4. Split owner/repo from the resolved location
 *   5. Resolve binding deny-keys; prime denylist; check isRepoDenied
 *   6. checkRepoWriteAuthz (WRITE-level — not read; insufficient_permission → denial)
 *   7. Operator-keyed rate limit (AFTER authz — unauthorized requests don't consume budget)
 *   8. Build CancelActorContext from the operator auth context (server-side only)
 *   9. cancelRun(params, deps)
 *  10. Emit run.cancel.* audit record
 *  11. Map CancelOutcome → JSON response
 *
 * Security invariants:
 *   - The repo is resolved server-side via resolveRepoFromRunIndex — NEVER from the client.
 *   - Every denial at gates 2–6 returns the identical no-oracle notFoundResponse.
 *   - A gate throw degrades to the same no-oracle denial, not a distinguishable 500.
 *   - Read-only operators (insufficient_permission) are denied at gate 6.
 *   - CSRF/Origin middleware covers this POST route (write route).
 */

import type {Hono} from 'hono'
import type {CancelActorContext, CancelOutcome, CancelRunDeps} from '../../execute/cancel.js'
import type {RunIndex} from '../../execute/run-index.js'
import type {RateLimiter} from '../../http/rate-limit.js'
import type {DenylistCache} from '../../redaction/denylist.js'
import type {BindingsLookup} from '../../redaction/surface-gate.js'
import type {AuditLogger} from '../audit.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {SessionStore} from '../auth/session.js'
import type {OperatorLogger} from '../server.js'
import {cancelRun} from '../../execute/cancel.js'
import {createRateLimiter} from '../../http/rate-limit.js'
import {emitAudit} from '../audit.js'
import {checkRepoWriteAuthz} from '../auth/repo-authz.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {notFoundResponse, rateLimitedResponse, unavailableResponse} from '../safe-response.js'
import {checkDenylist, resolveRepoFromRunIndex} from './route-helpers.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-operator cancel rate limit: 10 requests per minute (cheap idempotent no-ops, but bound abuse). */
const CANCEL_RATE_LIMIT_PER_MIN = 10
const CANCEL_RATE_WINDOW_MIN_MS = 60_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies for the cancel route. */
export interface CancelRouteDeps {
  /** Session store for token retrieval. */
  readonly sessionStore: Pick<SessionStore, 'getOperatorToken' | 'get'>
  /** Server-owned run index for runId → repo resolution. */
  readonly runIndex: Pick<RunIndex, 'lookup'>
  /** Denylist cache for pre-cancel redaction check. */
  readonly denylistCache: DenylistCache
  /** Bindings lookup for deny-key resolution. */
  readonly bindingsLookup: BindingsLookup
  /** Repo authorization dependencies (write-level). */
  readonly repoAuthzDeps: RepoAuthzDeps
  /** Cancel-run engine dependencies (queue, abort registry, approvals, etc.). */
  readonly cancelRunDeps: CancelRunDeps
  /** Audit logger for security events. */
  readonly auditLogger: AuditLogger
  /** Structured logger. */
  readonly logger: OperatorLogger
  /** Injectable clock. */
  readonly now: () => number
  /**
   * Optional injectable per-minute rate limiter (operator-keyed).
   * When absent, a fresh limiter is created with CANCEL_RATE_LIMIT_PER_MIN.
   */
  readonly rateLimiter?: RateLimiter
}

// ---------------------------------------------------------------------------
// Route builder
// ---------------------------------------------------------------------------

/**
 * Register POST /operator/runs/:runId/cancel on the given Hono app.
 *
 * Must be called after setOperatorRouteGuard is installed in buildOperatorApp.
 * The guard runs first (browser/session/allowlist/CSRF); this handler runs only
 * if the guard allows the request.
 *
 * Response body: OperatorCancelResponse {ok:true, runId, phase} on success
 * (both an active cancel and an idempotent already-terminal hit are 200s).
 */
export function buildCancelRoute(app: Hono, deps: CancelRouteDeps): void {
  // Per-operator rate limiter (operator-keyed, not socket-keyed), AFTER authz —
  // unauthorized requests must not consume budget.
  const rateLimiter =
    deps.rateLimiter ??
    createRateLimiter({limit: CANCEL_RATE_LIMIT_PER_MIN, windowMs: CANCEL_RATE_WINDOW_MIN_MS, clock: deps.now})

  registerOperatorRoute(app, 'POST', '/operator/runs/:runId/cancel', async c => {
    const nowMs = deps.now()

    // ── Gate 1: Read authenticated context set by the guard ──────────────────
    // In production the guard always sets this; undefined is unreachable.
    // Return not-found as a safe fallback (no oracle — same shape as all denials).
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'cancel: denied')
      return notFoundResponse(c)
    }

    const {githubUserId, sessionId} = authCtx

    // ── Gates 2–6: Pre-acceptance authorization gates ─────────────────────────
    // Wrapped in try/catch so any unexpected throw returns the uniform not-found
    // shape rather than propagating to Hono as a 500 (no-oracle property).
    let runId: string
    let owner: string
    let repo: string

    try {
      // ── Gate 2: Resolve OAuth token ──────────────────────────────────────
      const token = deps.sessionStore.getOperatorToken(sessionId, nowMs)
      if (token === undefined) {
        deps.logger.warn({githubUserId, gate: 'no-token'}, 'cancel: denied')
        emitAudit(
          {kind: 'run.cancel.rejected', correlationId: `cancel:${githubUserId}`, githubUserId, reason: 'not_found'},
          deps.auditLogger,
        )
        return notFoundResponse(c)
      }

      // ── Gates 3–4: Resolve runId → {owner, repo} (server-owned) ────────────
      // The repo is NEVER taken from the client. RunIndex.lookup is the sole authority.
      runId = c.req.param('runId') ?? ''
      const resolved = await resolveRepoFromRunIndex(runId, deps.runIndex)
      if (resolved === null) {
        deps.logger.warn({githubUserId, runId, gate: 'runIndex-miss-or-malformed'}, 'cancel: denied')
        emitAudit(
          {
            kind: 'run.cancel.rejected',
            correlationId: `cancel:${githubUserId}:${runId}`,
            githubUserId,
            reason: 'not_found',
          },
          deps.auditLogger,
        )
        return notFoundResponse(c)
      }
      owner = resolved.owner
      repo = resolved.repo

      // ── Gate 5: Redaction check (denylist before authz, fail-closed) ─────
      const isDenied = await checkDenylist(owner, repo, deps.bindingsLookup, deps.denylistCache)
      if (isDenied === true) {
        deps.logger.warn({githubUserId, runId, gate: 'denylisted'}, 'cancel: denied')
        emitAudit(
          {
            kind: 'run.cancel.rejected',
            correlationId: `cancel:${githubUserId}:${runId}`,
            githubUserId,
            reason: 'not_found',
          },
          deps.auditLogger,
        )
        return notFoundResponse(c)
      }

      // ── Gate 6: Write-level repo authorization ───────────────────────────
      const authzResult = await checkRepoWriteAuthz(githubUserId, owner, repo, token, deps.repoAuthzDeps)
      if (authzResult.authorized === false) {
        deps.logger.warn({githubUserId, runId, gate: 'write-authz-denied'}, 'cancel: denied')
        emitAudit(
          {
            kind: 'run.cancel.rejected',
            correlationId: `cancel:${githubUserId}:${runId}`,
            githubUserId,
            reason: 'authz_denied',
          },
          deps.auditLogger,
        )
        return notFoundResponse(c)
      }
    } catch (error: unknown) {
      deps.logger.warn({runId: c.req.param('runId') ?? '', githubUserId, error}, 'cancel: gate threw — denying')
      emitAudit(
        {kind: 'run.cancel.rejected', correlationId: `cancel:${githubUserId}`, githubUserId, reason: 'unknown'},
        deps.auditLogger,
      )
      return notFoundResponse(c)
    }

    // ── Gate 7: Operator rate limit — AFTER authz so unauthorized requests
    // don't consume budget. Operator-keyed, not socket-keyed. ─────────────────
    const operatorKey = String(githubUserId)
    if (rateLimiter.allow(operatorKey) === false) {
      deps.logger.warn({githubUserId, runId, gate: 'rate-limited'}, 'cancel: rate limited')
      return rateLimitedResponse(c)
    }

    // ── Gates 8–11: Post-authz settlement gates ───────────────────────────────
    // Wrapped in try/catch so any unexpected throw returns the uniform not-found
    // shape rather than propagating to Hono as a distinguishable 500.
    try {
      // ── Gate 8: Build CancelActorContext from the operator auth context ────
      const sessionEntry = deps.sessionStore.get(sessionId, nowMs)
      if (sessionEntry === undefined) {
        deps.logger.warn({githubUserId, runId, gate: 'no-session'}, 'cancel: denied — session missing')
        emitAudit(
          {
            kind: 'run.cancel.rejected',
            correlationId: `cancel:${githubUserId}:${runId}`,
            githubUserId,
            reason: 'not_found',
          },
          deps.auditLogger,
        )
        return notFoundResponse(c)
      }

      const actor: CancelActorContext = {
        githubUserId,
        login: sessionEntry.login,
        sessionCorrelationId: sessionId,
      }

      // ── Gate 9: Cancel through the transport-neutral orchestrator ───────────
      const outcome: CancelOutcome = await cancelRun({runId, actor, logger: deps.logger}, deps.cancelRunDeps)

      // ── Gates 10–11: Map outcome → audit + JSON response ─────────────────────
      switch (outcome.outcome) {
        case 'cancelled': {
          emitAudit(
            {
              kind: 'run.cancel.requested',
              correlationId: `cancel:${githubUserId}:${runId}`,
              githubUserId,
              runId,
              phase: 'CANCELLED',
            },
            deps.auditLogger,
          )
          return c.json({ok: true, runId, phase: 'CANCELLED'}, 200)
        }
        case 'already-terminal': {
          // outcome.phase is already TerminalPhase — CancelOutcome's already-terminal
          // variant is typed as such (see execute/cancel.ts), so it matches
          // OperatorCancelResponse's phase field with no narrowing needed.
          emitAudit(
            {
              kind: 'run.cancel.requested',
              correlationId: `cancel:${githubUserId}:${runId}`,
              githubUserId,
              runId,
              phase: outcome.phase,
            },
            deps.auditLogger,
          )
          return c.json({ok: true, runId, phase: outcome.phase}, 200)
        }
        case 'not-found': {
          deps.logger.warn({githubUserId, runId, gate: 'cancelRun-not-found'}, 'cancel: denied')
          emitAudit(
            {
              kind: 'run.cancel.rejected',
              correlationId: `cancel:${githubUserId}:${runId}`,
              githubUserId,
              reason: 'not_found',
            },
            deps.auditLogger,
          )
          return notFoundResponse(c)
        }
        case 'retry': {
          // The bounded rendezvous retry was exhausted without resolving to a
          // terminal outcome. Safe to retry — the run either advanced to
          // EXECUTING (a subsequent cancel hits the abort-registry path) or
          // reached a terminal state on its own. Return a coarse transient
          // 503 rather than a misleading success or a distinguishable error.
          // The rendezvous window is short — bounded by ensureClone/readyz/
          // threadFactory/lock — so a 2s Retry-After is a reasonable hint.
          deps.logger.warn({githubUserId, runId, gate: 'cancelRun-retry'}, 'cancel: transient — retry')
          return unavailableResponse(c, 2)
        }
      }
    } catch (error: unknown) {
      deps.logger.warn({runId, githubUserId, error}, 'cancel: post-authz gate threw — denying (no-oracle)')
      return notFoundResponse(c)
    }
  })
}
