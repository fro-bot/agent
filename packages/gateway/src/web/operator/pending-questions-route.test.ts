/**
 * Tests for GET /operator/runs/:runId/questions.
 *
 * Real HTTP route, real question registry and request gate. Read-level authz;
 * denylist before authz; no-oracle denials; bounded DTOs.
 */

import type {PendingQuestionsResponse} from '../../operator-contract/question-frame.js'
import type {PendingQuestionsRouteDeps} from './pending-questions-route.js'
import {describe, expect, it} from 'vitest'
import {QUESTION_TEXT_MAX_LENGTH} from '../../approvals/question-detail.js'
import {buildPendingQuestionsRoute, PENDING_QUESTIONS_MAX_RESULTS} from './pending-questions-route.js'
import {
  buildGuardedApp,
  DISCORD_THREAD,
  makeBindingsLookup,
  makeDenylistCache,
  makeEffects,
  makeLogger,
  makeRegistry,
  makeRunIndex,
  makeSessionStore,
  pickQuestion,
  readOnlyAuthz,
  RUN_ID,
  writeAuthz,
} from './test-helpers.js'

function makeDeps(
  registry: ReturnType<typeof makeRegistry>,
  overrides?: Partial<PendingQuestionsRouteDeps>,
): PendingQuestionsRouteDeps {
  return {
    sessionStore: makeSessionStore(),
    runIndex: makeRunIndex(),
    denylistCache: makeDenylistCache(),
    bindingsLookup: makeBindingsLookup(),
    repoAuthzDeps: readOnlyAuthz(),
    registry,
    logger: makeLogger(),
    now: () => 0,
    ...overrides,
  }
}

async function list(deps: PendingQuestionsRouteDeps, runId = RUN_ID) {
  const app = buildGuardedApp(a => {
    buildPendingQuestionsRoute(a, deps)
  })
  return app.fetch(new Request(`http://localhost/operator/runs/${runId}/questions`))
}

function register(
  registry: ReturnType<typeof makeRegistry>,
  requestID: string,
  options?: {readonly scope?: string; readonly runId?: string; readonly question?: ReturnType<typeof pickQuestion>},
) {
  registry.register({
    requestID,
    sessionID: 'sess-1',
    questionScopeId: options?.scope ?? RUN_ID,
    runId: options?.runId ?? RUN_ID,
    questions: [options?.question ?? pickQuestion()],
    effects: makeEffects(),
    deadlineMs: 60_000,
  })
}

describe('GET pending questions', () => {
  it("lists the run's open questions as bounded DTOs for a read-only operator", async () => {
    // #given a pending question with over-cap, control-laced text
    const registry = makeRegistry()
    register(registry, 'que_1', {
      question: pickQuestion({question: `\u001B${'q'.repeat(QUESTION_TEXT_MAX_LENGTH + 10)}`}),
    })

    // #when a read-only operator lists
    const res = await list(makeDeps(registry))

    // #then 200 with the bounded DTO (read-level authz suffices)
    expect(res.status).toBe(200)
    const body = (await res.json()) as PendingQuestionsResponse
    expect(body.requests).toHaveLength(1)
    expect(body.requests[0]?.requestID).toBe('que_1')
    expect(body.requests[0]?.questions[0]).toMatchObject({header: 'Env', multiple: false, custom: true})
    expect(body.requests[0]?.questions[0]?.text).toHaveLength(QUESTION_TEXT_MAX_LENGTH)
    expect(body.requests[0]?.questions[0]?.text).not.toContain('\u001B')
  })

  it("lists a Discord-scoped run's question by run id, and nothing from another run", async () => {
    // #given a thread-scoped question for this run and one for another run
    const registry = makeRegistry()
    register(registry, 'que_mine', {scope: DISCORD_THREAD})
    register(registry, 'que_other', {runId: 'run-other', scope: 'run-other'})

    // #when listing this run
    const res = await list(makeDeps(registry, {runIndex: makeRunIndex({repo: 'acme/widget', surface: 'discord'})}))

    // #then only this run's request appears
    const body = (await res.json()) as PendingQuestionsResponse
    expect(body.requests.map(r => r.requestID)).toEqual(['que_mine'])
  })

  it('drops a question once it settles', async () => {
    // #given a question and its echoed settlement
    const registry = makeRegistry()
    register(registry, 'que_1')
    registry.confirmEcho({kind: 'rejected', requestID: 'que_1', sessionID: 'sess-1'})

    // #when listing
    const res = await list(makeDeps(registry))

    // #then it is gone — an authorized empty list, not a denial
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({requests: []})
  })

  it('hard-caps the response', async () => {
    // #given more open questions than the cap
    const registry = makeRegistry()
    for (let i = 0; i < PENDING_QUESTIONS_MAX_RESULTS + 5; i++) register(registry, `que_${i}`)

    // #when listing
    const res = await list(makeDeps(registry))

    // #then the list is capped
    const body = (await res.json()) as PendingQuestionsResponse
    expect(body.requests).toHaveLength(PENDING_QUESTIONS_MAX_RESULTS)
  })

  it('a 200 response carrying question text is Cache-Control: no-store, private', async () => {
    // #given a pending question with model-authored text
    const registry = makeRegistry()
    register(registry, 'que_1')

    // #when listing
    const res = await list(makeDeps(registry))

    // #then the 200 body has the question text and may not be cached
    expect(res.status).toBe(200)
    const body = (await res.json()) as PendingQuestionsResponse
    expect(body.requests[0]?.questions[0]?.text).toBe('Which environment?')
    expect(res.headers.get('Cache-Control')).toBe('no-store, private')
  })

  it('denylisted repo → 404 before any authz call', async () => {
    // #given a denylisted repo
    const registry = makeRegistry()
    register(registry, 'que_1')
    const repoAuthzDeps = readOnlyAuthz()

    // #when
    const res = await list(makeDeps(registry, {denylistCache: makeDenylistCache(true), repoAuthzDeps}))

    // #then
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({error: 'not-found'})
    expect(repoAuthzDeps.fetch).not.toHaveBeenCalled()
  })

  it('unknown run and no-read-access are the same 404', async () => {
    // #given a run index miss, and an operator with no repo permissions at all
    const registry = makeRegistry()
    const miss = await list(makeDeps(registry, {runIndex: makeRunIndex('miss')}))
    const noAccess = await list(
      makeDeps(registry, {repoAuthzDeps: {...writeAuthz(), fetch: async () => new Response('{}', {status: 404})}}),
    )

    // #then
    for (const res of [miss, noAccess]) {
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({error: 'not-found'})
    }
  })

  it('rate limits an operator that enumerates too fast, after authz', async () => {
    // #given a limiter that allows nothing
    const registry = makeRegistry()
    const deps = makeDeps(registry, {rateLimiter: {allow: () => false}})

    // #when
    const res = await list(deps)

    // #then
    expect(res.status).toBe(429)
  })
})
