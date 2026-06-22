/**
 * Authenticated launch route: POST /operator/runs
 *
 * Allows an authenticated, allowlisted operator to launch agent work in a
 * chosen repo through the transport-neutral launchWork engine. The run is
 * recorded as surface:'web' and attributed to the operator's GitHub identity.
 *
 * The route returns 202 {runId} after awaiting launchWork admission. Admission
 * is fast and bounded — launchWork returns after the run is admitted (or
 * rejected), not after the run completes. The gateway in-flight set owns the
 * immediate-run promise; the operator observes the run via the SSE run-stream
 * route (GET /operator/runs/:runId/stream).
 *
 * Gate ordering (all must pass before launchWork is called):
 *   1. Guard (browser/session/allowlist/CSRF) — installed by buildOperatorApp
 *   2. Operator rate limit (3/min, 10/hr, operator-keyed)
 *   3. Resolve OAuth token via session store
 *   4. Parse and validate request body {repo, prompt, idempotencyKey?}
 *   5. Server-owned binding resolution via getBindingByRepo (never trust client)
 *   6. Denylist check (isRepoDenied) — before authz, no oracle
 *   7. checkRepoAuthz (allowlist + GitHub repo access)
 *   8. Empty-prompt fail-fast
 *   9. Per-operator idempotency guard (${githubUserId}:${clientKey})
 *  10. Generate runId + reserve idempotency key (if present)
 *  11. Await launchWork admission (returns LaunchAdmission, not the full run)
 *  12. On accepted: commit idempotency + return 202 {runId}
 *      On rejected/throw: rollback idempotency + return coarse error
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
import type {RunMentionDeps} from '../../execute/run.js'
import type {RateLimiter} from '../../http/rate-limit.js'
import type {ApprovalFrameData} from '../../operator-contract/approval-frame.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {OperatorLogger} from '../server.js'
import type {RunObservationManager} from '../sse/manager.js'
import type {IdempotencyGuard} from './idempotency.js'
import {randomUUID} from 'node:crypto'
import {launchWork} from '../../execute/run.js'
import {createRateLimiter} from '../../http/rate-limit.js'
import {bindingToRepoKey} from '../../redaction/surface-gate.js'
import {checkRepoAuthz} from '../auth/repo-authz.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {notFoundResponse, rateLimitedResponse} from '../safe-response.js'
import {createWebApprovalOnPending} from './web-approval.js'
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
  /** Engine dependencies for launchWork. launchWork owns run index registration. */
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
  /**
   * Run-observation manager for wiring the web ReplySink's output and approval
   * frames to the SSE run-stream.
   *
   * When present:
   * - `observeOutput` pushes live output deltas and the final answer frame.
   * - `observeApproval` fans out approval frames to subscribers.
   *
   * When absent (e.g. in tests that don't exercise streaming), output is
   * buffered but not streamed — the sink degrades gracefully to a no-op, and
   * approval frames are silently dropped.
   */
  readonly runObservationManager?: Pick<RunObservationManager, 'observeOutput' | 'observeApproval'>
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

    // Reject non-plain-object bodies: null, arrays, and primitives all fail.
    // typeof [] === 'object', so Array.isArray check is required.
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      deps.logger.warn({githubUserId, gate: 'bad-body'}, 'launch: denied — body is not a plain object')
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
    if (deps.isRepoDenied(bindingToRepoKey(binding)) === true) {
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
    // check() returns the runId for BOTH reserved AND committed live entries —
    // a concurrent duplicate arriving while the first is reserved-not-committed
    // echoes the reserved runId and does NOT launch twice.
    if (idempotencyKey !== undefined) {
      const priorRunId = deps.idempotencyGuard.check(githubUserId, idempotencyKey)
      if (priorRunId !== undefined) {
        // Duplicate within window — echo the prior runId, no double-launch.
        deps.logger.info({githubUserId, gate: 'idempotent'}, 'launch: idempotent — echoing prior runId')
        return c.json({runId: priorRunId}, 202)
      }
    }

    // ── Gate 10: Generate runId + reserve idempotency key ────────────────────
    // The route owns the runId so it can return 202 {runId} and pass it to
    // launchWork (which uses it for admission and run-index registration).
    // Reserve BEFORE launchWork so a concurrent duplicate during the admission
    // window echoes this runId and does NOT launch twice.
    const runId = randomUUID()

    if (idempotencyKey !== undefined) {
      deps.idempotencyGuard.reserve(githubUserId, idempotencyKey, runId)
    }

    // ── Gate 11: Await launchWork admission ───────────────────────────────────
    // Build the LaunchWorkRequest with web-specific sinks, real approval transport,
    // and web prompt builder. The channelId is a deterministic, namespaced,
    // opaque scope key that cannot equal a Discord snowflake.
    //
    // The web replySink is wired to the run-observation manager so subscribers
    // on GET /operator/runs/:runId/stream receive live output deltas and a
    // terminal final-answer frame. When the manager is absent (e.g. in tests
    // that don't exercise streaming), the sink degrades to a buffering no-op.
    //
    // launchWork returns after ADMISSION (not after the run). The gateway in-flight
    // set owns the immediate-run promise; awaiting here does NOT hang the connection.
    const operatorIdentity = {
      kind: 'web-operator' as const,
      githubUserId,
      login: sessionEntry.login,
      sessionCorrelationId: sessionId,
    }

    const manager = deps.runObservationManager
    const observeOutput =
      manager === undefined
        ? (_text: string, _opts?: {final?: boolean; droppedCount?: number}): void => {
            // No-op: manager absent (e.g. in tests that don't exercise streaming).
          }
        : (text: string, opts?: {final?: boolean; droppedCount?: number}): void =>
            manager.observeOutput(runId, text, opts)

    // Mirror the observeOutput closure pattern: build a per-run observeApproval
    // closure that captures runId and delegates to the manager. When the manager
    // is absent (e.g. in tests that don't exercise streaming), approval frames
    // are silently dropped — the registry registration still happens and the
    // deadline still settles fail-closed.
    const observeApproval =
      manager === undefined
        ? (_runId: string, _data: ApprovalFrameData): void => {
            // No-op: manager absent (e.g. in tests that don't exercise streaming).
          }
        : (approvalRunId: string, data: ApprovalFrameData): void => manager.observeApproval(approvalRunId, data)

    const request = {
      promptText: promptField,
      runId,
      channelId: `web:${owner}/${repo}`,
      guildId: undefined,
      surface: 'web' as const,
      binding,
      requester: operatorIdentity,
      statusSink: createWebStatusSink(),
      replySink: createWebReplySink({runId, observeOutput}),
      createApprovalOnPending: createWebApprovalOnPending({observeApproval, logger: deps.logger}),
      promptBuilder: buildWebPrompt,
    }

    // Await admission (fast, bounded — does NOT await the run itself).
    // The finally block guarantees rollback on ANY non-commit exit:
    //   - launchWork returns {accepted:false} → rollback
    //   - launchWork throws → rollback
    //   - any post-admission/pre-commit route error → rollback
    // This prevents a reserved-but-never-resolved key from blocking the operator's own key.
    let committed = false
    try {
      const admission = await launchWork(request, deps.launchWorkDeps)

      if (admission.accepted === true) {
        // Commit the idempotency entry now that admission succeeded.
        if (idempotencyKey !== undefined) {
          deps.idempotencyGuard.commit(githubUserId, idempotencyKey)
        }
        committed = true
        deps.logger.info({githubUserId, runId: admission.runId, owner, repo}, 'launch: accepted')
        return c.json({runId: admission.runId}, 202)
      }

      // Admission rejected — map reason to a coarse HTTP error.
      // rollback happens in finally.
      if (admission.reason === 'cap' || admission.reason === 'queue-full') {
        deps.logger.warn({githubUserId, owner, repo, gate: admission.reason}, 'launch: rejected — at capacity')
        return c.json({error: 'unavailable'}, 503)
      }

      // 'empty-prompt' — defensive; the route already validates empty prompt above.
      deps.logger.warn({githubUserId, owner, repo, gate: 'empty-prompt'}, 'launch: rejected — empty prompt')
      return c.json({error: 'bad request'}, 400)
    } catch (launchError: unknown) {
      deps.logger.error(
        {
          githubUserId,
          runId,
          owner,
          repo,
          err: launchError instanceof Error ? launchError.message : String(launchError),
        },
        'launch: launchWork threw — rolling back idempotency',
      )
      // rollback happens in finally; return a coarse 500.
      return c.json({error: 'internal error'}, 500)
    } finally {
      // Guarantee rollback on any non-commit exit (rejected, thrown, or any
      // post-admission/pre-commit route error). No-op if already committed or
      // if no idempotency key was supplied.
      if (committed === false && idempotencyKey !== undefined) {
        deps.idempotencyGuard.rollback(githubUserId, idempotencyKey)
      }
    }
  })
}
