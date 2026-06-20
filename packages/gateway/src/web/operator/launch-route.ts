/**
 * Authenticated launch route: POST /operator/runs
 *
 * Allows an authenticated, allowlisted operator to launch agent work in a
 * chosen repo through the transport-neutral launchWork engine. The run is
 * recorded as surface:'web' and attributed to the operator's GitHub identity.
 *
 * The route returns 202 {runId} IMMEDIATELY (fire-and-return). The operator
 * observes the run via the SSE run-stream route (GET /operator/runs/:runId/stream).
 *
 * Gate ordering (all must pass before launchWork is fired):
 *   1. Guard (browser/session/allowlist/CSRF) — installed by buildOperatorApp
 *   2. Operator rate limit (3/min, 10/hr, operator-keyed)
 *   3. Resolve OAuth token via session store
 *   4. Parse and validate request body {repo, prompt, idempotencyKey?}
 *   5. Server-owned binding resolution via getBindingByRepo (never trust client)
 *   6. Denylist check (isRepoDenied) — before authz, no oracle
 *   7. checkRepoAuthz (allowlist + GitHub repo access)
 *   8. Empty-prompt fail-fast
 *   9. Per-operator idempotency guard (${githubUserId}:${clientKey})
 *  10. Generate runId + register PENDING in run index
 *  11. Fire launchWork WITHOUT await (.catch logs) → return 202 {runId}
 *
 * Security invariants:
 *   - Server-owned repo resolution: client body names a repo; server resolves
 *     via getBindingByRepo. Client-supplied binding/path/owner is ignored.
 *   - Denylist before authz: a denylisted repo never triggers a GitHub call.
 *   - Per-operator idempotency: key is namespaced ${githubUserId}:${clientKey}
 *     so operator A cannot suppress operator B's launch.
 *   - No token/prompt/path/internal-id in responses or logs.
 *   - CSRF/Origin middleware covers this POST route (write route).
 *   - Rate limit is operator-keyed (not per-repo).
 */

import type {Hono} from 'hono'
import type {RepoBinding} from '../../bindings/types.js'
import type {RunIndex} from '../../execute/run-index.js'
import type {RunMentionDeps} from '../../execute/run.js'
import type {RateLimiter} from '../../http/rate-limit.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {OperatorLogger} from '../server.js'
import type {IdempotencyGuard} from './idempotency.js'
import {randomUUID} from 'node:crypto'
import {launchWork} from '../../execute/run.js'
import {createRateLimiter} from '../../http/rate-limit.js'
import {checkRepoAuthz} from '../auth/repo-authz.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {notFoundResponse, rateLimitedResponse} from '../safe-response.js'
import {createWebAutoDenyApproval} from './web-approval.js'
import {createWebReplySink, createWebStatusSink} from './web-sinks.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-operator launch rate limit: 3 requests per minute. */
const LAUNCH_RATE_LIMIT_PER_MIN = 3
const LAUNCH_RATE_WINDOW_MIN_MS = 60_000

/** Per-operator launch rate limit: 10 requests per hour. */
const LAUNCH_RATE_LIMIT_PER_HR = 10
const LAUNCH_RATE_WINDOW_HR_MS = 60 * 60_000

/** Maximum body size for the launch route (prompt + repo + key). */
export const LAUNCH_MAX_BODY_BYTES = 64 * 1024

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal session store interface required by the launch route.
 */
export interface LaunchRouteSessionStore {
  readonly getOperatorToken: (sessionId: string, nowMs: number) => string | undefined
  readonly get: (
    sessionId: string,
    nowMs: number,
  ) => {readonly githubUserId: number; readonly login: string} | undefined
}

/**
 * Minimal binding store interface required by the launch route.
 */
export interface LaunchRouteBindingsLookup {
  readonly getBindingByRepo: (
    owner: string,
    repo: string,
  ) => Promise<
    {readonly success: true; readonly data: RepoBinding | null} | {readonly success: false; readonly error: Error}
  >
}

/** Dependencies for the launch route. */
export interface LaunchRouteDeps {
  /** Session store for OAuth token and identity retrieval. */
  readonly sessionStore: LaunchRouteSessionStore
  /** Binding store for server-owned repo resolution. */
  readonly bindingsLookup: LaunchRouteBindingsLookup
  /**
   * Denylist predicate — returns true when a repo's deny keys are on the denylist.
   * Must be called BEFORE checkRepoAuthz (no oracle, no GitHub call for denied repos).
   */
  readonly isRepoDenied: (repoKey: RepoKey) => boolean
  /** Repo authorization dependencies for checkRepoAuthz. */
  readonly repoAuthzDeps: RepoAuthzDeps
  /** Per-operator idempotency guard. */
  readonly idempotencyGuard: IdempotencyGuard
  /** Server-owned run index for registering PENDING entries before launchWork. */
  readonly runIndex: Pick<RunIndex, 'register'>
  /** Engine dependencies for launchWork. */
  readonly launchWorkDeps: RunMentionDeps
  /** Structured logger. */
  readonly logger: OperatorLogger
  /** Injectable clock. */
  readonly now: () => number
  /**
   * Optional injectable per-minute rate limiter (operator-keyed).
   * When absent, a fresh limiter is created with LAUNCH_RATE_LIMIT_PER_MIN.
   */
  readonly perMinRateLimiter?: RateLimiter
  /**
   * Optional injectable per-hour rate limiter (operator-keyed).
   * When absent, a fresh limiter is created with LAUNCH_RATE_LIMIT_PER_HR.
   */
  readonly perHrRateLimiter?: RateLimiter
}

// ---------------------------------------------------------------------------
// Web prompt builder
// ---------------------------------------------------------------------------

/**
 * Build a web-appropriate prompt for the agent.
 *
 * Omits Discord-thread/persona framing (DISCORD_MECHANICAL_GUIDANCE) that is
 * inappropriate for a web-launched run. The prompt is passed through as-is
 * with only the repo context prepended.
 */
function buildWebPrompt(args: {readonly messageText: string; readonly owner: string; readonly repo: string}): string {
  return `Repository: ${args.owner}/${args.repo}\n\n${args.messageText}`
}

// ---------------------------------------------------------------------------
// Route builder
// ---------------------------------------------------------------------------

/**
 * Register POST /operator/runs on the given Hono app.
 *
 * Must be called after setOperatorRouteGuard is installed in buildOperatorApp.
 * The guard runs first (browser/session/allowlist/CSRF); this handler runs only
 * if the guard allows the request.
 *
 * Response body: {runId: string} — the stable UUID for the launched run.
 * The operator subscribes to GET /operator/runs/:runId/stream to observe.
 */
export function buildLaunchRoute(app: Hono, deps: LaunchRouteDeps): void {
  // Per-operator rate limiters (operator-keyed, not socket-keyed).
  // Two windows: 3/min and 10/hr. Both must pass.
  const perMinLimiter =
    deps.perMinRateLimiter ??
    createRateLimiter({limit: LAUNCH_RATE_LIMIT_PER_MIN, windowMs: LAUNCH_RATE_WINDOW_MIN_MS, clock: deps.now})
  const perHrLimiter =
    deps.perHrRateLimiter ??
    createRateLimiter({limit: LAUNCH_RATE_LIMIT_PER_HR, windowMs: LAUNCH_RATE_WINDOW_HR_MS, clock: deps.now})

  registerOperatorRoute(app, 'POST', '/operator/runs', async c => {
    const nowMs = deps.now()

    // ── Gate 1: Read authenticated context set by the guard ──────────────────
    // In production the guard always sets this; undefined is unreachable.
    // Return not-found as a safe fallback (no oracle — same shape as all denials).
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'launch: denied')
      return notFoundResponse(c)
    }

    const {githubUserId, sessionId} = authCtx

    // ── Gate 2: Operator rate limit (operator-keyed, not socket-keyed) ───────
    // Two windows: 3/min and 10/hr. Both must pass.
    // Keyed on string(githubUserId) so the limit is per-operator, not per-repo.
    const operatorKey = String(githubUserId)
    if (perMinLimiter.allow(operatorKey) === false || perHrLimiter.allow(operatorKey) === false) {
      deps.logger.warn({githubUserId, gate: 'rate-limited'}, 'launch: rate limited')
      return rateLimitedResponse(c)
    }

    // ── Gate 3: Resolve OAuth token ──────────────────────────────────────────
    const token = deps.sessionStore.getOperatorToken(sessionId, nowMs)
    if (token === undefined) {
      deps.logger.warn({githubUserId, gate: 'no-token'}, 'launch: denied — token missing')
      return notFoundResponse(c)
    }

    // Resolve session identity for the requester attribution.
    const sessionEntry = deps.sessionStore.get(sessionId, nowMs)
    if (sessionEntry === undefined) {
      deps.logger.warn({githubUserId, gate: 'no-session'}, 'launch: denied — session missing')
      return notFoundResponse(c)
    }

    // ── Gate 4: Parse and validate request body ──────────────────────────────
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      deps.logger.warn({githubUserId, gate: 'bad-body'}, 'launch: denied — invalid JSON body')
      return c.json({error: 'bad request'}, 400)
    }

    if (body === null || typeof body !== 'object') {
      deps.logger.warn({githubUserId, gate: 'bad-body'}, 'launch: denied — body is not an object')
      return c.json({error: 'bad request'}, 400)
    }

    const bodyObj = body as Record<string, unknown>
    const repoField = bodyObj.repo
    const promptField = bodyObj.prompt
    const idempotencyKeyField = bodyObj.idempotencyKey

    if (typeof repoField !== 'string' || repoField.trim().length === 0) {
      deps.logger.warn({githubUserId, gate: 'bad-body'}, 'launch: denied — missing or empty repo field')
      return c.json({error: 'bad request'}, 400)
    }

    if (typeof promptField !== 'string') {
      deps.logger.warn({githubUserId, gate: 'bad-body'}, 'launch: denied — missing prompt field')
      return c.json({error: 'bad request'}, 400)
    }

    // Parse owner/repo from the repo field (format: 'owner/repo').
    const slashIdx = repoField.indexOf('/')
    if (slashIdx === -1 || slashIdx === 0 || slashIdx === repoField.length - 1) {
      deps.logger.warn({githubUserId, gate: 'bad-body'}, 'launch: denied — repo field must be owner/repo format')
      return c.json({error: 'bad request'}, 400)
    }
    const owner = repoField.slice(0, slashIdx)
    const repo = repoField.slice(slashIdx + 1)

    const idempotencyKey =
      typeof idempotencyKeyField === 'string' && idempotencyKeyField.length > 0 ? idempotencyKeyField : undefined

    // ── Gate 5: Server-owned binding resolution ──────────────────────────────
    // The server resolves the binding via getBindingByRepo. Client-supplied
    // binding/path/owner is ignored. Unknown/unbound repo → coarse pre-launch error.
    let binding: RepoBinding
    try {
      const bindingResult = await deps.bindingsLookup.getBindingByRepo(owner, repo)
      if (bindingResult.success === false) {
        deps.logger.warn({githubUserId, gate: 'binding-error'}, 'launch: denied — binding lookup error')
        return c.json({error: 'not-found'}, 404)
      }
      if (bindingResult.data === null) {
        deps.logger.warn({githubUserId, gate: 'unbound'}, 'launch: denied — repo not bound')
        return c.json({error: 'not-found'}, 404)
      }
      binding = bindingResult.data
    } catch {
      deps.logger.warn({githubUserId, gate: 'binding-error'}, 'launch: denied — binding lookup threw')
      return c.json({error: 'not-found'}, 404)
    }

    // ── Gate 6: Denylist check — BEFORE authz (no oracle, no GitHub call) ────
    const repoKey: RepoKey = {
      databaseId: typeof binding.databaseId === 'number' ? binding.databaseId : null,
      nodeId: typeof binding.nodeId === 'string' ? binding.nodeId : null,
    }
    if (deps.isRepoDenied(repoKey) === true) {
      deps.logger.warn({githubUserId, gate: 'denylisted'}, 'launch: denied — repo denylisted')
      return notFoundResponse(c)
    }

    // ── Gate 7: Repo authorization ────────────────────────────────────────────
    const authzResult = await checkRepoAuthz(githubUserId, owner, repo, token, deps.repoAuthzDeps)
    if (authzResult.authorized === false) {
      deps.logger.warn({githubUserId, gate: 'authz-denied'}, 'launch: denied — repo authz failed')
      return notFoundResponse(c)
    }

    // ── Gate 8: Empty-prompt fail-fast ────────────────────────────────────────
    if (promptField.trim().length === 0) {
      deps.logger.warn({githubUserId, gate: 'empty-prompt'}, 'launch: denied — empty prompt')
      return c.json({error: 'prompt is required'}, 400)
    }

    // ── Gate 9: Per-operator idempotency guard ────────────────────────────────
    // Key is namespaced: ${githubUserId}:${clientKey} so operator A cannot
    // suppress operator B's launch with the same client key.
    if (idempotencyKey !== undefined) {
      const priorRunId = deps.idempotencyGuard.check(githubUserId, idempotencyKey)
      if (priorRunId !== undefined) {
        // Duplicate within window — echo the prior runId, no double-launch.
        deps.logger.info({githubUserId, gate: 'idempotent'}, 'launch: idempotent — echoing prior runId')
        return c.json({runId: priorRunId}, 202)
      }
    }

    // ── Gate 10: Generate runId + register PENDING in run index ──────────────
    // The route owns the runId so it can return 202 {runId} immediately.
    // Register BEFORE firing launchWork so the run is visible to the SSE route.
    const runId = randomUUID()
    const startedAt = new Date().toISOString()

    try {
      deps.runIndex.register(runId, {
        repo: `${owner}/${repo}`,
        surface: 'web',
        startedAt,
      })
    } catch (registerError: unknown) {
      deps.logger.warn(
        {githubUserId, runId, err: registerError instanceof Error ? registerError.message : String(registerError)},
        'launch: runIndex.register threw — continuing (best-effort)',
      )
    }

    // Record idempotency entry AFTER generating the runId.
    if (idempotencyKey !== undefined) {
      deps.idempotencyGuard.record(githubUserId, idempotencyKey, runId)
    }

    // ── Gate 11: Fire launchWork WITHOUT await (fire-and-return) ─────────────
    // Build the LaunchWorkRequest with web-specific sinks, auto-deny approval,
    // and web prompt builder. The channelId is a deterministic, namespaced,
    // opaque scope key that cannot equal a Discord snowflake.
    const operatorIdentity = {
      kind: 'web-operator' as const,
      githubUserId,
      login: sessionEntry.login,
      sessionCorrelationId: sessionId,
    }

    const request = {
      promptText: promptField,
      runId,
      channelId: `web:${owner}/${repo}`,
      guildId: undefined,
      surface: 'web' as const,
      binding,
      requester: operatorIdentity,
      statusSink: createWebStatusSink(),
      replySink: createWebReplySink(),
      createApprovalOnPending: createWebAutoDenyApproval(),
      promptBuilder: buildWebPrompt,
    }

    // Fire-and-return: do NOT await launchWork. The engine awaits the whole run
    // on the immediate-slot path. Awaiting here would hang the HTTP connection.
    // eslint-disable-next-line no-void
    void launchWork(request, deps.launchWorkDeps).catch((error: unknown) => {
      deps.logger.error(
        {githubUserId, runId, err: error instanceof Error ? error.message : String(error)},
        'launch: launchWork threw unexpectedly',
      )
    })

    deps.logger.info({githubUserId, runId, owner, repo}, 'launch: accepted')

    // Return 202 Accepted immediately with the runId.
    return c.json({runId}, 202)
  })
}
