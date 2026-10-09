/**
 * Authenticated pending-questions route: GET /operator/runs/:runId/questions
 *
 * Returns the open agent-question requests for a run so a reconnecting or
 * late-joining browser can recover the prompt without relying on SSE replay.
 * This is the reconciliation read for the `question` frame.
 *
 * Gate ordering mirrors `pending-approvals-route.ts` (all must pass before any
 * data is returned):
 *   1. Guard (browser/session/allowlist) — installed by buildOperatorApp
 *   2. Resolve session + OAuth token by sessionId
 *   3. RunIndex.lookup(runId) → server-owned repo; miss → notFoundResponse
 *   4. Split owner/repo
 *   5. Denylist check (redaction BEFORE authz); denied → notFoundResponse
 *   6. checkRepoAuthz (READ-level)
 *   7. Per-operator rate limit
 *   8. Return the run's open requests as bounded DTOs, hard-capped
 *
 * Requests are found by the asking run's id, not by surface scope, so a
 * Discord-launched run's questions are listed the same as a web-launched run's.
 *
 * Security invariants:
 *   - The run id is resolved server-side; the repo is never taken from the client.
 *   - Every denial at gates 2–6 returns the identical no-oracle notFoundResponse,
 *     and a gate throw degrades to the same denial.
 *   - Every question and option string in the response is untrusted plain text,
 *     bounded and control-stripped; consumers render it inertly.
 */

import type {Hono} from 'hono'
import type {QuestionRegistry} from '../../approvals/question-registry.js'
import type {RunIndex} from '../../execute/run-index.js'
import type {RateLimiter} from '../../http/rate-limit.js'
import type {PendingQuestionsResponse} from '../../operator-contract/question-frame.js'
import type {DenylistCache} from '../../redaction/denylist.js'
import type {BindingsLookup} from '../../redaction/surface-gate.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {SessionStore} from '../auth/session.js'
import type {OperatorLogger} from '../server.js'
import {toQuestionRequestDetail} from '../../approvals/question-detail.js'
import {createRateLimiter} from '../../http/rate-limit.js'
import {checkRepoAuthz} from '../auth/repo-authz.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {notFoundResponse, rateLimitedResponse} from '../safe-response.js'
import {checkDenylist, resolveRepoFromRunIndex} from './route-helpers.js'

/** Hard cap on the number of pending question requests returned per call. */
export const PENDING_QUESTIONS_MAX_RESULTS = 50

/** Per-operator rate limit: 30 requests per minute for the enumeration endpoint. */
const PENDING_QUESTIONS_RATE_LIMIT = 30
const PENDING_QUESTIONS_RATE_WINDOW_MS = 60_000

export interface PendingQuestionsRouteDeps {
  readonly sessionStore: Pick<SessionStore, 'getOperatorToken'>
  readonly runIndex: Pick<RunIndex, 'lookup'>
  readonly denylistCache: DenylistCache
  readonly bindingsLookup: BindingsLookup
  /** Repo authorization dependencies (read-level). */
  readonly repoAuthzDeps: RepoAuthzDeps
  /** Question registry — the sole source of pending request detail. */
  readonly registry: Pick<QuestionRegistry, 'describePendingForRun'>
  readonly logger: OperatorLogger
  readonly now: () => number
  /** Optional injectable per-operator rate limiter. */
  readonly rateLimiter?: RateLimiter
}

/**
 * Register GET /operator/runs/:runId/questions on the given Hono app.
 *
 * Response body: {requests: PendingQuestionDTO[]}. An empty array means no open
 * requests (not an oracle — the operator is authorized for the run).
 */
export function buildPendingQuestionsRoute(app: Hono, deps: PendingQuestionsRouteDeps): void {
  const limiter =
    deps.rateLimiter ??
    createRateLimiter({
      limit: PENDING_QUESTIONS_RATE_LIMIT,
      windowMs: PENDING_QUESTIONS_RATE_WINDOW_MS,
      clock: deps.now,
    })

  registerOperatorRoute(app, 'GET', '/operator/runs/:runId/questions', async c => {
    const nowMs = deps.now()

    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'pending-questions: denied')
      return notFoundResponse(c)
    }

    const {githubUserId, sessionId} = authCtx

    // Any throw at gates 2–6 returns the uniform not-found shape, never a distinguishable 500.
    let runId: string

    try {
      const resolvedToken = deps.sessionStore.getOperatorToken(sessionId, nowMs)
      if (resolvedToken === undefined) {
        deps.logger.warn({githubUserId, gate: 'no-token'}, 'pending-questions: denied')
        return notFoundResponse(c)
      }

      runId = c.req.param('runId') ?? ''
      const resolved = await resolveRepoFromRunIndex(runId, deps.runIndex)
      if (resolved === null) {
        deps.logger.warn({githubUserId, runId, gate: 'runIndex-miss-or-malformed'}, 'pending-questions: denied')
        return notFoundResponse(c)
      }
      const {owner, repo} = resolved

      // Redaction BEFORE authz so a denylisted repo never triggers a GitHub call.
      const isDenied = await checkDenylist(owner, repo, deps.bindingsLookup, deps.denylistCache)
      if (isDenied === true) {
        deps.logger.warn({githubUserId, runId, gate: 'denylisted'}, 'pending-questions: denied')
        return notFoundResponse(c)
      }

      const authzResult = await checkRepoAuthz(githubUserId, owner, repo, resolvedToken, deps.repoAuthzDeps)
      if (authzResult.authorized === false) {
        deps.logger.warn({githubUserId, runId, gate: 'read-authz-denied'}, 'pending-questions: denied')
        return notFoundResponse(c)
      }
    } catch (error: unknown) {
      deps.logger.warn(
        {runId: c.req.param('runId') ?? '', githubUserId, errName: error instanceof Error ? error.name : 'non-error'},
        'pending-questions: gate threw — denying',
      )
      return notFoundResponse(c)
    }

    // After authz, so only authorized operators consume the budget.
    if (limiter.allow(String(githubUserId)) === false) {
      deps.logger.warn({githubUserId, runId, gate: 'rate-limited'}, 'pending-questions: rate limited')
      return rateLimitedResponse(c)
    }

    const all = deps.registry.describePendingForRun(runId)
    const requests = (
      all.length > PENDING_QUESTIONS_MAX_RESULTS ? all.slice(0, PENDING_QUESTIONS_MAX_RESULTS) : all
    ).map(dto => toQuestionRequestDetail(dto.requestID, dto.questions))

    const body: PendingQuestionsResponse = {requests}
    // Model-authored question text must never be cached by a browser or shared proxy.
    c.header('Cache-Control', 'no-store, private')
    return c.json(body, 200)
  })
}
