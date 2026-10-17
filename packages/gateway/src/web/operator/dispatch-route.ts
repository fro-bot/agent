/**
 * Authenticated workflow-dispatch route: POST /operator/dispatch
 *
 * Exposes the transport-neutral DispatchWorkflow to operator-web clients. The
 * route owns only the operator gate stack and response projection; GitHub,
 * authentication, and workflow-dispatch behavior remain in the injected
 * dispatcher.
 *
 * Gate ordering:
 *   1. Guard (browser/session/allowlist/CSRF) — installed by buildOperatorApp
 *   2. Operator-keyed rate limit (3/min, 10/hr)
 *   3. Server-side session identity
 *   4. JSON body validation ({repo, task})
 *   5. resolveRepoAccess — name validation, ONE server-owned binding read, then the
 *      denylist; the same predicate every other operator route uses. Anything but
 *      `allowed` returns the uniform 404.
 *   6. Idempotency check/reservation
 *   7. DispatchWorkflow (runs as the Fro Bot GitHub App installation, not as the operator)
 *
 * All dispatcher outcomes are returned unchanged as 200 {outcome}. The audit
 * record contains only the outcome discriminant and optional run ID; request
 * task text and install URLs never cross this route's audit boundary.
 */

import type {Hono} from 'hono'
import type {DispatchOutcome, DispatchWorkflow} from '../../github/dispatch.js'
import type {RateLimiter} from '../../http/rate-limit.js'
import type {DenylistCache} from '../../redaction/denylist.js'
import type {AuditLogger} from '../audit.js'
import type {DurableSessionStore} from '../auth/session.js'
import type {OperatorLogger} from '../server.js'
import type {IdempotencyGuard} from './idempotency.js'
import type {LaunchRouteBindingsLookup} from './launch-route.js'
import {createHash, randomUUID} from 'node:crypto'
import {createRateLimiter} from '../../http/rate-limit.js'
import {emitAudit} from '../audit.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {notFoundResponse, rateLimitedResponse} from '../safe-response.js'
import {IDEMPOTENCY_KEY_MAX_LENGTH} from './idempotency.js'
import {resolveRepoAccess} from './route-helpers.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-operator dispatch rate limit: 3 requests per minute. */
const DISPATCH_RATE_LIMIT_PER_MIN = 3
const DISPATCH_RATE_WINDOW_MIN_MS = 60_000

/** Per-operator dispatch rate limit: 10 requests per hour. */
const DISPATCH_RATE_LIMIT_PER_HR = 10
const DISPATCH_RATE_WINDOW_HR_MS = 60 * 60_000

const DISPATCH_IDEMPOTENCY_TTL_MS = 10 * 60_000
const DISPATCH_IDEMPOTENCY_MAX_ENTRIES = 10_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatchRouteDeps {
  readonly sessionStore: Pick<DurableSessionStore, 'get'>
  readonly bindingsLookup: LaunchRouteBindingsLookup
  /** Primed and consulted by resolveRepoAccess after the binding is found. */
  readonly denylistCache: Pick<DenylistCache, 'getDenylistState' | 'isRepoDenied'>
  readonly dispatchWorkflow: DispatchWorkflow
  readonly idempotencyGuard: IdempotencyGuard
  readonly auditLogger: AuditLogger
  readonly logger: OperatorLogger
  readonly now: () => number
  readonly perMinRateLimiter?: RateLimiter
  readonly perHrRateLimiter?: RateLimiter
}

interface CompletedDispatch {
  readonly fingerprint: string
  readonly outcome: DispatchOutcome
  readonly expiresAt: number
}

interface InFlightDispatch {
  readonly fingerprint: string
  readonly promise: Promise<DispatchOutcome>
}

function fingerprintDispatchRequest(owner: string, repo: string, task: string): string {
  return createHash('sha256')
    .update(JSON.stringify([owner, repo, task]), 'utf8')
    .digest('hex')
}

function parseRepo(repoField: string): {readonly owner: string; readonly repo: string} | undefined {
  const repoValue = repoField.trim()
  const slashIdx = repoValue.indexOf('/')
  if (slashIdx <= 0 || slashIdx === repoValue.length - 1 || repoValue.includes('/', slashIdx + 1)) return undefined

  const owner = repoValue.slice(0, slashIdx)
  const repo = repoValue.slice(slashIdx + 1)
  if (owner.trim().length === 0 || repo.trim().length === 0 || /\s/.test(owner) || /\s/.test(repo)) return undefined
  return {owner, repo}
}

/** Register POST /operator/dispatch on the given Hono app. */
export function buildDispatchRoute(app: Hono, deps: DispatchRouteDeps): void {
  const perMinLimiter =
    deps.perMinRateLimiter ??
    createRateLimiter({limit: DISPATCH_RATE_LIMIT_PER_MIN, windowMs: DISPATCH_RATE_WINDOW_MIN_MS, clock: deps.now})
  const perHrLimiter =
    deps.perHrRateLimiter ??
    createRateLimiter({limit: DISPATCH_RATE_LIMIT_PER_HR, windowMs: DISPATCH_RATE_WINDOW_HR_MS, clock: deps.now})
  const completedDispatches = new Map<string, CompletedDispatch>()
  const inFlightDispatches = new Map<string, InFlightDispatch>()

  registerOperatorRoute(app, 'POST', '/operator/dispatch', async c => {
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'dispatch: denied')
      return notFoundResponse(c)
    }

    const {githubUserId, sessionId} = authCtx
    const operatorKey = String(githubUserId)
    if (perMinLimiter.allow(operatorKey) === false || perHrLimiter.allow(operatorKey) === false) {
      deps.logger.warn({githubUserId, gate: 'rate-limited'}, 'dispatch: rate limited')
      return rateLimitedResponse(c)
    }

    if (deps.sessionStore.get(sessionId) === undefined) {
      deps.logger.warn({githubUserId, gate: 'no-session'}, 'dispatch: denied — session missing')
      return notFoundResponse(c)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      deps.logger.warn({githubUserId, gate: 'bad-body'}, 'dispatch: denied — invalid JSON body')
      return c.json({error: 'bad request'}, 400)
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      deps.logger.warn({githubUserId, gate: 'bad-body'}, 'dispatch: denied — body is not a plain object')
      return c.json({error: 'bad request'}, 400)
    }

    const bodyObj = body as Record<string, unknown>
    const repoField = bodyObj.repo
    const taskField = bodyObj.task
    if (typeof repoField !== 'string' || typeof taskField !== 'string' || taskField.trim().length === 0) {
      deps.logger.warn({githubUserId, gate: 'bad-body'}, 'dispatch: denied — missing or empty dispatch field')
      return c.json({error: 'bad request'}, 400)
    }

    const parsedRepo = parseRepo(repoField)
    if (parsedRepo === undefined) {
      deps.logger.warn({githubUserId, gate: 'bad-body'}, 'dispatch: denied — repo field must be owner/repo format')
      return c.json({error: 'bad request'}, 400)
    }
    const {owner, repo} = parsedRepo
    const idempotencyKeyField = bodyObj.idempotencyKey
    if (typeof idempotencyKeyField === 'string' && idempotencyKeyField.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      deps.logger.warn({githubUserId, gate: 'bad-body'}, 'dispatch: denied — idempotency key is too long')
      return c.json({error: 'bad request'}, 400)
    }
    const idempotencyKey =
      typeof idempotencyKeyField === 'string' && idempotencyKeyField.length > 0 ? idempotencyKeyField : undefined

    // One binding read. Unbound and denylisted share one denial label so the log is not
    // an existence oracle; a malformed name makes zero store calls.
    const access = await resolveRepoAccess(owner, repo, deps)
    if (access.kind !== 'allowed') {
      deps.logger.warn(
        {githubUserId, gate: access.kind === 'denied' ? 'repo-denied' : 'repo-unavailable'},
        'dispatch: denied — repo access',
      )
      return notFoundResponse(c)
    }

    if (idempotencyKey !== undefined) {
      const idempotencyMapKey = `${githubUserId}:${idempotencyKey}`
      const fingerprint = fingerprintDispatchRequest(owner, repo, taskField.trim())
      const priorMarker = deps.idempotencyGuard.check(githubUserId, idempotencyKey)
      if (priorMarker !== undefined) {
        const completed = completedDispatches.get(idempotencyMapKey)
        if (completed !== undefined && deps.now() < completed.expiresAt) {
          if (completed.fingerprint !== fingerprint) {
            return c.json({error: 'idempotency key reuse with different request'}, 400)
          }
          return c.json({outcome: completed.outcome}, 200)
        }
        if (completed !== undefined) completedDispatches.delete(idempotencyMapKey)

        const inFlight = inFlightDispatches.get(idempotencyMapKey)
        if (inFlight !== undefined) {
          if (inFlight.fingerprint !== fingerprint) {
            return c.json({error: 'idempotency key reuse with different request'}, 400)
          }
          try {
            return c.json({outcome: await inFlight.promise}, 200)
          } catch {
            return c.json({error: 'internal error'}, 500)
          }
        }

        // A live guard marker without a completed or in-flight outcome can arise
        // from independent in-process eviction (or an inconsistent/injected guard).
        // Do not dispatch twice.
        deps.logger.warn({githubUserId, gate: 'idempotent'}, 'dispatch: idempotency outcome unavailable')
        return c.json({error: 'internal error'}, 500)
      }

      deps.idempotencyGuard.reserve(githubUserId, idempotencyKey, randomUUID())
      let committed = false
      try {
        const dispatchPromise = deps.dispatchWorkflow(owner, repo, taskField)
        inFlightDispatches.set(idempotencyMapKey, {fingerprint, promise: dispatchPromise})
        const outcome = await dispatchPromise
        if (outcome.outcome === 'accepted') {
          deps.idempotencyGuard.commit(githubUserId, idempotencyKey)
          committed = true
          completedDispatches.set(idempotencyMapKey, {
            fingerprint,
            outcome,
            expiresAt: deps.now() + DISPATCH_IDEMPOTENCY_TTL_MS,
          })
          pruneCompletedDispatches(completedDispatches, deps.now())
        }
        emitDispatchAudit(deps.auditLogger, outcome, githubUserId, owner, repo)
        return c.json({outcome}, 200)
      } catch {
        return c.json({error: 'internal error'}, 500)
      } finally {
        inFlightDispatches.delete(idempotencyMapKey)
        if (committed === false) deps.idempotencyGuard.rollback(githubUserId, idempotencyKey)
      }
    }

    try {
      const outcome = await deps.dispatchWorkflow(owner, repo, taskField)
      emitDispatchAudit(deps.auditLogger, outcome, githubUserId, owner, repo)
      return c.json({outcome}, 200)
    } catch {
      return c.json({error: 'internal error'}, 500)
    }
  })
}

function pruneCompletedDispatches(dispatches: Map<string, CompletedDispatch>, nowMs: number): void {
  for (const [key, entry] of dispatches) {
    if (nowMs >= entry.expiresAt) dispatches.delete(key)
  }
  while (dispatches.size > DISPATCH_IDEMPOTENCY_MAX_ENTRIES) {
    const oldestKey = dispatches.keys().next().value
    if (oldestKey === undefined) return
    dispatches.delete(oldestKey)
  }
}

function emitDispatchAudit(
  auditLogger: AuditLogger,
  outcome: DispatchOutcome,
  githubUserId: number,
  owner: string,
  repo: string,
): void {
  emitAudit(
    {
      kind: 'dispatch.completed',
      correlationId: randomUUID(),
      githubUserId,
      repoFullName: `${owner}/${repo}`,
      outcome: outcome.outcome,
      ...(outcome.outcome === 'accepted' && outcome.runId !== undefined ? {runId: outcome.runId} : {}),
    },
    auditLogger,
  )
}
