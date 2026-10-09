/**
 * Authenticated question decision route:
 * POST /operator/runs/:runId/questions/:requestId/decision
 *
 * Answers or skips a pending agent-question request through the shared request
 * gate. The write-gated settlement path for questions on the web operator
 * surface; it serves every run, Discord-launched or web-launched, because web
 * operators with write access to the run's repository may answer any run's
 * question.
 *
 * Gate ordering (all must pass before the gate is called):
 *   0. Body size limit (64 KiB) — global middleware in buildOperatorApp, ahead
 *      of every route and so ahead of the guard and any lookup
 *   1. Guard (browser/session/allowlist/CSRF) — installed by buildOperatorApp
 *   2. Resolve session + OAuth token by sessionId
 *   3. Resolve runId → repo via RunIndex (server-owned; never client-supplied)
 *   4. Split owner/repo
 *   5. Denylist check (BEFORE any authz call)
 *   6. checkRepoWriteAuthz (WRITE-level)
 *   7. Parse + shape-check the body ({decision:'answer', answers} | {decision:'skip'})
 *   8. Build the web operator actor server-side from the session
 *   9. Map option indices to the raw labels, then registry.decide
 *  10. Emit the question.decision / question.rejected audit record
 *  11. Map the gate outcome → JSON response
 *
 * Security invariants:
 *   - The run is resolved server-side and passed to the gate, which refuses a
 *     request id that belongs to another run (same answer as an unknown id).
 *   - Every denial at gates 2–6 returns the identical no-oracle notFoundResponse;
 *     a gate throw degrades to the same denial.
 *   - Audit events and logs carry ids and reason codes only — never question
 *     or answer text, and never the request body.
 *   - The 4,000-character free-text cap and answer validation run in the gate,
 *     before any call to OpenCode; a refused answer leaves the request pending.
 */

import type {Hono} from 'hono'
import type {QuestionDecisionOutcome, QuestionRegistry} from '../../approvals/question-registry.js'
import type {RunIndex} from '../../execute/run-index.js'
import type {QuestionDecisionErrorResponse, QuestionDecisionResponse} from '../../operator-contract/question-frame.js'
import type {DenylistCache} from '../../redaction/denylist.js'
import type {BindingsLookup} from '../../redaction/surface-gate.js'
import type {AuditLogger, QuestionRejectedReason} from '../audit.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {SessionStore} from '../auth/session.js'
import type {OperatorLogger} from '../server.js'
import {emitAudit} from '../audit.js'
import {checkRepoWriteAuthz} from '../auth/repo-authz.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {notFoundResponse} from '../safe-response.js'
import {parseQuestionDecisionBody, resolveQuestionAnswers} from './question-choices.js'
import {checkDenylist, resolveRepoFromRunIndex} from './route-helpers.js'

export interface QuestionDecisionRouteDeps {
  readonly sessionStore: Pick<SessionStore, 'getOperatorToken' | 'get'>
  readonly runIndex: Pick<RunIndex, 'lookup'>
  readonly denylistCache: DenylistCache
  readonly bindingsLookup: BindingsLookup
  /** Repo authorization dependencies (write-level). */
  readonly repoAuthzDeps: RepoAuthzDeps
  /** Question registry — the sole settlement path. */
  readonly registry: Pick<QuestionRegistry, 'decide' | 'describePendingForRun' | 'isClaimed'>
  readonly auditLogger: AuditLogger
  readonly logger: OperatorLogger
  readonly now: () => number
}

const BAD_REQUEST: QuestionDecisionErrorResponse = {error: 'bad request', reason: 'malformed', questionIndex: null}

/** Audit reason for a non-ok gate outcome. */
function rejectedReason(outcome: Exclude<QuestionDecisionOutcome, {readonly kind: 'ok'}>): QuestionRejectedReason {
  switch (outcome.kind) {
    case 'already-claimed':
      return 'already_claimed'
    case 'not-found':
    case 'scope-mismatch':
      return 'not_found'
    case 'reply-failed':
      return 'reply_failed'
    case 'invalid':
      return 'invalid'
  }
}

/**
 * Register POST /operator/runs/:runId/questions/:requestId/decision on the given Hono app.
 *
 * Response body: a `QuestionDecisionResponse` (HTTP 200) for every gate outcome except
 * `invalid`, which is HTTP 400 with a `QuestionDecisionErrorResponse` (`{error: 'bad request',
 * reason, questionIndex}`) in the operator error envelope.
 */
export function buildQuestionDecisionRoute(app: Hono, deps: QuestionDecisionRouteDeps): void {
  registerOperatorRoute(app, 'POST', '/operator/runs/:runId/questions/:requestId/decision', async c => {
    const nowMs = deps.now()

    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'question-decision: denied')
      return notFoundResponse(c)
    }

    const {githubUserId, sessionId} = authCtx

    // Gates 2–6. Any throw returns the uniform not-found shape, never a distinguishable 500.
    let token: string
    let runId: string

    try {
      const resolvedToken = deps.sessionStore.getOperatorToken(sessionId, nowMs)
      if (resolvedToken === undefined) {
        deps.logger.warn({githubUserId, gate: 'no-token'}, 'question-decision: denied')
        return notFoundResponse(c)
      }
      token = resolvedToken

      runId = c.req.param('runId') ?? ''
      const resolved = await resolveRepoFromRunIndex(runId, deps.runIndex)
      if (resolved === null) {
        deps.logger.warn({githubUserId, runId, gate: 'runIndex-miss-or-malformed'}, 'question-decision: denied')
        return notFoundResponse(c)
      }
      const {owner, repo} = resolved

      // Redaction BEFORE authz so a denylisted repo never triggers a GitHub call.
      const isDenied = await checkDenylist(owner, repo, deps.bindingsLookup, deps.denylistCache)
      if (isDenied === true) {
        deps.logger.warn({githubUserId, runId, gate: 'denylisted'}, 'question-decision: denied')
        return notFoundResponse(c)
      }

      // WRITE (not read): a read-only operator is denied here.
      const authzResult = await checkRepoWriteAuthz(githubUserId, owner, repo, token, deps.repoAuthzDeps)
      if (authzResult.authorized === false) {
        deps.logger.warn({githubUserId, runId, gate: 'write-authz-denied'}, 'question-decision: denied')
        return notFoundResponse(c)
      }
    } catch (error: unknown) {
      deps.logger.warn(
        {runId: c.req.param('runId') ?? '', githubUserId, errName: error instanceof Error ? error.name : 'non-error'},
        'question-decision: gate threw — denying',
      )
      return notFoundResponse(c)
    }

    // Gate 7: body shape. A client error (400), logged without the body.
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      deps.logger.warn({githubUserId, runId, gate: 'bad-body'}, 'question-decision: invalid JSON body')
      return c.json(BAD_REQUEST, 400)
    }
    const parsed = parseQuestionDecisionBody(body)
    if (parsed.kind === 'malformed') {
      deps.logger.warn({githubUserId, runId, gate: 'bad-body'}, 'question-decision: malformed decision body')
      return c.json(BAD_REQUEST, 400)
    }

    // Gates 8–11: post-authz. A throw here is denied with the same shape as an authz denial.
    try {
      const sessionEntry = deps.sessionStore.get(sessionId, nowMs)
      if (sessionEntry === undefined) {
        deps.logger.warn({githubUserId, runId, gate: 'no-session'}, 'question-decision: denied — session missing')
        return notFoundResponse(c)
      }

      const actor = {
        kind: 'web-operator' as const,
        githubUserId,
        login: sessionEntry.login,
        sessionCorrelationId: sessionId,
      }
      const requestId = c.req.param('requestId') ?? ''
      const correlationId = `question:${githubUserId}:${runId}:${requestId}`
      const audit = {correlationId, githubUserId, runId, requestId, family: 'question' as const}

      const refuse = (reason: QuestionRejectedReason): void => {
        emitAudit({kind: 'question.rejected', ...audit, reason}, deps.auditLogger)
      }

      let outcome: QuestionDecisionOutcome
      if (parsed.value.decision === 'skip') {
        outcome = await deps.registry.decide({
          requestID: requestId,
          scopeId: runId,
          runId,
          decision: {kind: 'skip'},
          actor,
        })
      } else {
        // Indices map back to the raw labels held by the registry — the labels the operator saw
        // may have been bounded. A request that is not open for this run has nothing to map.
        const request = deps.registry.describePendingForRun(runId).find(entry => entry.requestID === requestId)
        if (request === undefined) {
          // A claimed request is absent from the open list but not settled: another submission's reply
          // is in flight and it reopens if that reply fails. `isClaimed` is scoped to this run, so a
          // claimed request of another run is still indistinguishable from an unknown id.
          if (deps.registry.isClaimed(requestId, runId)) {
            refuse('already_claimed')
            return c.json({state: 'already_claimed'} satisfies QuestionDecisionResponse, 200)
          }
          refuse('not_found')
          return c.json({state: 'already_settled'} satisfies QuestionDecisionResponse, 200)
        }
        const resolved = resolveQuestionAnswers(request.questions, parsed.value.answers)
        if (resolved.kind === 'invalid') {
          refuse('invalid')
          const refusal: QuestionDecisionErrorResponse = {
            error: 'bad request',
            reason: resolved.reason,
            questionIndex: resolved.questionIndex,
          }
          return c.json(refusal, 400)
        }
        outcome = await deps.registry.decide({
          requestID: requestId,
          scopeId: runId,
          runId,
          decision: {kind: 'answer', answers: resolved.answers},
          actor,
        })
      }

      switch (outcome.kind) {
        case 'ok': {
          emitAudit(
            {
              kind: 'question.decision',
              ...audit,
              outcome: parsed.value.decision === 'skip' ? 'skipped' : 'answered',
            },
            deps.auditLogger,
          )
          return c.json({state: 'claimed'} satisfies QuestionDecisionResponse, 200)
        }
        case 'invalid': {
          refuse('invalid')
          const refusal: QuestionDecisionErrorResponse = {
            error: 'bad request',
            reason: outcome.reason,
            questionIndex: outcome.questionIndex,
          }
          return c.json(refusal, 400)
        }
        case 'already-claimed':
          refuse(rejectedReason(outcome))
          return c.json({state: 'already_claimed'} satisfies QuestionDecisionResponse, 200)
        case 'reply-failed':
          refuse(rejectedReason(outcome))
          return c.json({state: 'failed_to_settle'} satisfies QuestionDecisionResponse, 200)
        case 'not-found':
        case 'scope-mismatch':
          refuse(rejectedReason(outcome))
          return c.json({state: 'already_settled'} satisfies QuestionDecisionResponse, 200)
      }
    } catch (error: unknown) {
      deps.logger.warn(
        {runId, githubUserId, errName: error instanceof Error ? error.name : 'non-error'},
        'question-decision: post-authz gate threw — denying (no-oracle)',
      )
      return notFoundResponse(c)
    }
  })
}
