/**
 * Tests for POST /operator/runs/:runId/questions/:requestId/decision.
 *
 * Every test goes through the real HTTP route with a real question registry and
 * request gate (see test-helpers.ts).
 *
 * Load-bearing:
 *   1. WRITE AUTHZ + NO ORACLE: read-only, denylisted, and unknown runs get the identical 404.
 *   2. DENYLIST BEFORE AUTHZ: a denylisted repo never reaches the GitHub permission fetch.
 *   3. INDEX MAPPING: option indices map to the RAW labels in the reply to OpenCode.
 *   4. CROSS-SURFACE: a web operator may answer a Discord-scoped run's question.
 *   5. CROSS-RUN: a request id from another run is "already settled", with no side effects.
 *   6. NO TEXT LEAKS: audit events and logs carry ids and reason codes only.
 */

import type {QuestionRegistry} from '../../approvals/question-registry.js'
import type {QuestionDecisionRouteDeps} from './question-decision-route.js'
import {describe, expect, it, vi} from 'vitest'
import {QUESTION_ANSWER_MAX_LENGTH} from '../../approvals/question-registry.js'
import {buildQuestionDecisionRoute} from './question-decision-route.js'
import {
  buildGuardedApp,
  DISCORD_THREAD,
  makeAuditLogger,
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
  SECRET,
  writeAuthz,
} from './test-helpers.js'

function makeDeps(
  registry: QuestionRegistry,
  overrides?: Partial<Omit<QuestionDecisionRouteDeps, 'auditLogger' | 'logger'>>,
) {
  const auditLogger = makeAuditLogger()
  const logger = makeLogger()
  return {
    sessionStore: makeSessionStore(),
    runIndex: makeRunIndex(),
    denylistCache: makeDenylistCache(),
    bindingsLookup: makeBindingsLookup(),
    repoAuthzDeps: writeAuthz(),
    registry,
    auditLogger,
    logger,
    now: () => 0,
    ...overrides,
  } satisfies QuestionDecisionRouteDeps
}

function app(deps: QuestionDecisionRouteDeps) {
  return buildGuardedApp(a => {
    buildQuestionDecisionRoute(a, deps)
  })
}

async function post(target: ReturnType<typeof app>, requestId: string, body: unknown, runId = RUN_ID) {
  return target.fetch(
    new Request(`http://localhost/operator/runs/${runId}/questions/${requestId}/decision`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

/** Register a question the way the run's coordinator does. */
function register(
  registry: QuestionRegistry,
  effects: ReturnType<typeof makeEffects>,
  options?: {
    readonly requestID?: string
    readonly scope?: string
    readonly runId?: string
    readonly questions?: Parameters<QuestionRegistry['register']>[0]['questions']
  },
) {
  return registry.register({
    requestID: options?.requestID ?? 'que_1',
    sessionID: 'sess-1',
    questionScopeId: options?.scope ?? RUN_ID,
    runId: options?.runId ?? RUN_ID,
    questions: options?.questions ?? [pickQuestion()],
    effects,
    deadlineMs: 60_000,
  })
}

const NO_ORACLE = {error: 'not-found'}

describe('POST question decision — answer', () => {
  it('a write-authorized operator answers a web-run question → 200 claimed, one reply with the mapped labels', async () => {
    // #given a pending question on a web run
    const registry = makeRegistry()
    const effects = makeEffects()
    register(registry, effects)
    const deps = makeDeps(registry)

    // #when the operator picks option 1 by index
    const res = await post(app(deps), 'que_1', {decision: 'answer', answers: [{options: [1]}]})

    // #then 200 claimed and exactly one reply, carrying the label (not the index)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({state: 'claimed'})
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [['prod']])
    expect(effects.rejectQuestion).not.toHaveBeenCalled()
  })

  it('the same operator answers a Discord-run question (thread scope) → accepted', async () => {
    // #given a question bound to a Discord thread scope but asked by run-abc
    const registry = makeRegistry()
    const effects = makeEffects()
    register(registry, effects, {scope: DISCORD_THREAD})
    const deps = makeDeps(registry, {runIndex: makeRunIndex({repo: 'acme/widget', surface: 'discord'})})

    // #when answered from the web
    const res = await post(app(deps), 'que_1', {decision: 'answer', answers: [{options: [0]}]})

    // #then the gate accepts the web operator on the Discord-scoped entry
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({state: 'claimed'})
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [['staging']])
  })

  it('maps the index to the RAW label when the displayed (bounded) label differs', async () => {
    // #given an option whose raw label is far over the label cap and contains a control character
    const registry = makeRegistry()
    const effects = makeEffects()
    const rawLabel = `deploy\u0007-${'x'.repeat(400)}`
    register(registry, effects, {
      questions: [pickQuestion({options: [{label: rawLabel, description: ''}], custom: false})],
    })
    const deps = makeDeps(registry)

    // #when the operator picks index 0
    const res = await post(app(deps), 'que_1', {decision: 'answer', answers: [{options: [0]}]})

    // #then the reply carries the exact raw label — a label-based body could never have matched
    expect(res.status).toBe(200)
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [[rawLabel]])
  })

  it('accepts several options for a multiple question, and options plus free text', async () => {
    // #given a multiple-choice question that also allows custom text
    const registry = makeRegistry()
    const effects = makeEffects()
    register(registry, effects, {questions: [pickQuestion({multiple: true})]})
    const deps = makeDeps(registry)

    // #when
    const res = await post(app(deps), 'que_1', {decision: 'answer', answers: [{options: [0, 1], text: 'and dev'}]})

    // #then labels first, then the text
    expect(res.status).toBe(200)
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [['staging', 'prod', 'and dev']])
  })

  it('accepts free text alone when custom is allowed (default)', async () => {
    // #given
    const registry = makeRegistry()
    const effects = makeEffects()
    register(registry, effects)

    // #when
    const res = await post(app(makeDeps(registry)), 'que_1', {decision: 'answer', answers: [{text: 'my own env'}]})

    // #then
    expect(res.status).toBe(200)
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [['my own env']])
  })
})

describe('POST question decision — skip', () => {
  it('skip → empty-answer reply, never a reject, audit outcome skipped', async () => {
    // #given a two-question request
    const registry = makeRegistry()
    const effects = makeEffects()
    register(registry, effects, {questions: [pickQuestion(), pickQuestion()]})
    const deps = makeDeps(registry)

    // #when skipped
    const res = await post(app(deps), 'que_1', {decision: 'skip'})

    // #then one empty answer per question, no reject, and the audit event says skipped
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({state: 'claimed'})
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [[], []])
    expect(effects.rejectQuestion).not.toHaveBeenCalled()
    expect(deps.auditLogger.info).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: 'question.decision',
        family: 'question',
        outcome: 'skipped',
        runId: RUN_ID,
        requestId: 'que_1',
        githubUserId: 1001,
      }),
      'audit: question.decision',
    )
  })
})

describe('POST question decision — gates and no-oracle denials', () => {
  it('read-only operator → 404 no-oracle, gate untouched', async () => {
    // #given a read-only operator and a pending question
    const registry = makeRegistry()
    const effects = makeEffects()
    register(registry, effects)
    const decide = vi.spyOn(registry, 'decide')

    // #when
    const res = await post(app(makeDeps(registry, {repoAuthzDeps: readOnlyAuthz()})), 'que_1', {decision: 'skip'})

    // #then
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NO_ORACLE)
    expect(decide).not.toHaveBeenCalled()
    expect(effects.replyQuestion).not.toHaveBeenCalled()
  })

  it('denylisted repo → identical 404 BEFORE any authz call', async () => {
    // #given a denylisted repo and an authz fetch spy
    const registry = makeRegistry()
    const effects = makeEffects()
    register(registry, effects)
    const repoAuthzDeps = writeAuthz()
    const deps = makeDeps(registry, {denylistCache: makeDenylistCache(true), repoAuthzDeps})

    // #when
    const res = await post(app(deps), 'que_1', {decision: 'skip'})

    // #then the same denial, and GitHub was never asked
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NO_ORACLE)
    expect(repoAuthzDeps.fetch).not.toHaveBeenCalled()
    expect(effects.replyQuestion).not.toHaveBeenCalled()
  })

  it('denial shapes are identical for read-only, denylisted, and unknown-run', async () => {
    // #given three denial causes
    const registry = makeRegistry()
    register(registry, makeEffects())
    const readOnly = await post(app(makeDeps(registry, {repoAuthzDeps: readOnlyAuthz()})), 'que_1', {decision: 'skip'})
    const denied = await post(app(makeDeps(registry, {denylistCache: makeDenylistCache(true)})), 'que_1', {
      decision: 'skip',
    })
    const miss = await post(app(makeDeps(registry, {runIndex: makeRunIndex('miss')})), 'que_1', {decision: 'skip'})

    // #then the same status and body
    for (const res of [readOnly, denied, miss]) {
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(NO_ORACLE)
    }
  })

  it('a gate that throws degrades to the same 404', async () => {
    // #given a run index that throws
    const registry = makeRegistry()
    const deps = makeDeps(registry, {
      runIndex: {
        lookup: vi.fn(async () => {
          throw new Error('boom')
        }),
      },
    })

    // #when
    const res = await post(app(deps), 'que_1', {decision: 'skip'})

    // #then
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NO_ORACLE)
  })

  it('a session that vanishes after authz → the same 404, no reply or reject', async () => {
    // #given a session store whose token resolves but whose session entry is gone
    const registry = makeRegistry()
    const effects = makeEffects()
    register(registry, effects)
    const sessionStore = {...makeSessionStore(), get: vi.fn((_sessionId: string, _nowMs: number) => undefined)}
    const deps = makeDeps(registry, {sessionStore})

    // #when
    const res = await post(app(deps), 'que_1', {decision: 'skip'})

    // #then it is indistinguishable from a run-index miss, and nothing was settled
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NO_ORACLE)
    expect(sessionStore.get).toHaveBeenCalledOnce()
    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(effects.rejectQuestion).not.toHaveBeenCalled()
  })

  it('a registry.decide that throws → the same 404, no reply or reject', async () => {
    // #given a registry whose settlement path throws unexpectedly
    const registry = makeRegistry()
    const effects = makeEffects()
    register(registry, effects)
    const decide = vi.spyOn(registry, 'decide').mockRejectedValue(new Error('boom'))
    const deps = makeDeps(registry)

    // #when
    const res = await post(app(deps), 'que_1', {decision: 'skip'})

    // #then 404 (not a 500), identical to a run-index miss, and nothing was sent to OpenCode
    expect(decide).toHaveBeenCalledOnce()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NO_ORACLE)
    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(effects.rejectQuestion).not.toHaveBeenCalled()
  })
})

async function pendingAfter(body: unknown, question = pickQuestion()) {
  const registry = makeRegistry()
  const effects = makeEffects()
  register(registry, effects, {questions: [question]})
  const deps = makeDeps(registry)
  const res = await post(app(deps), 'que_1', body)
  return {res, registry, effects, deps}
}

describe('POST question decision — validation leaves the request pending', () => {
  it('an out-of-range option index → 400 unknown-option, no reply, still open', async () => {
    const {res, registry, effects, deps} = await pendingAfter({decision: 'answer', answers: [{options: [5]}]})

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({error: 'bad request', reason: 'unknown-option', questionIndex: 0})
    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(registry.describePendingForRun(RUN_ID)).toHaveLength(1)
    expect(deps.auditLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({kind: 'question.rejected', reason: 'invalid'}),
      'audit: question.rejected',
    )
  })

  it('free text on a custom:false question → 400 unknown-option, no reply, still open', async () => {
    const {res, registry, effects} = await pendingAfter(
      {decision: 'answer', answers: [{text: 'free'}]},
      pickQuestion({custom: false}),
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({error: 'bad request', reason: 'unknown-option', questionIndex: 0})
    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(registry.describePendingForRun(RUN_ID)).toHaveLength(1)
  })

  it('free text over 4,000 characters → 400 text-too-long, no reply, still open', async () => {
    const {res, registry, effects} = await pendingAfter({
      decision: 'answer',
      answers: [{text: 'a'.repeat(QUESTION_ANSWER_MAX_LENGTH + 1)}],
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({error: 'bad request', reason: 'text-too-long', questionIndex: 0})
    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(registry.describePendingForRun(RUN_ID)).toHaveLength(1)
  })

  it('free text of exactly 4,000 characters is accepted', async () => {
    const {res, effects} = await pendingAfter({
      decision: 'answer',
      answers: [{text: 'a'.repeat(QUESTION_ANSWER_MAX_LENGTH)}],
    })

    expect(res.status).toBe(200)
    expect(effects.replyQuestion).toHaveBeenCalledOnce()
  })

  it('two options on a single-select question → 400 multiple-not-allowed', async () => {
    const {res, effects} = await pendingAfter({decision: 'answer', answers: [{options: [0, 1]}]})

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({error: 'bad request', reason: 'multiple-not-allowed', questionIndex: 0})
    expect(effects.replyQuestion).not.toHaveBeenCalled()
  })

  it('answers for fewer questions than asked → 400 arity-mismatch', async () => {
    const {res, effects} = await pendingAfter({decision: 'answer', answers: []})

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({error: 'bad request', reason: 'arity-mismatch', questionIndex: null})
    expect(effects.replyQuestion).not.toHaveBeenCalled()
  })

  it('a repeated option index → 400 malformed', async () => {
    const registry = makeRegistry()
    const effects = makeEffects()
    register(registry, effects, {questions: [pickQuestion({multiple: true})]})

    const res = await post(app(makeDeps(registry)), 'que_1', {decision: 'answer', answers: [{options: [0, 0]}]})

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({error: 'bad request', reason: 'malformed', questionIndex: 0})
    expect(effects.replyQuestion).not.toHaveBeenCalled()
  })

  it.each([
    ['not JSON', 'not json{'],
    ['an array', []],
    ['an unknown decision', {decision: 'approve'}],
    ['answer without answers', {decision: 'answer'}],
    ['answers that are not objects', {decision: 'answer', answers: ['staging']}],
    ['a negative index', {decision: 'answer', answers: [{options: [-1]}]}],
    ['a fractional index', {decision: 'answer', answers: [{options: [0.5]}]}],
    ['a string index', {decision: 'answer', answers: [{options: ['0']}]}],
    ['non-string text', {decision: 'answer', answers: [{text: 5}]}],
  ])('a malformed body (%s) → 400 malformed, gate untouched', async (_label, body) => {
    const registry = makeRegistry()
    const effects = makeEffects()
    register(registry, effects)
    const decide = vi.spyOn(registry, 'decide')

    const res = await post(app(makeDeps(registry)), 'que_1', body)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({error: 'bad request', reason: 'malformed', questionIndex: null})
    expect(decide).not.toHaveBeenCalled()
    expect(effects.replyQuestion).not.toHaveBeenCalled()
  })

  it('a refused answer does not consume the request: a corrected answer then succeeds', async () => {
    // #given a refused out-of-range answer
    const registry = makeRegistry()
    const effects = makeEffects()
    register(registry, effects)
    const target = app(makeDeps(registry))
    await post(target, 'que_1', {decision: 'answer', answers: [{options: [9]}]})

    // #when the operator corrects it
    const res = await post(target, 'que_1', {decision: 'answer', answers: [{options: [0]}]})

    // #then
    expect(res.status).toBe(200)
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [['staging']])
  })
})

describe('POST question decision — settlement states', () => {
  it('a duplicate submission after settlement → 200 already_settled, no second reply', async () => {
    // #given an answered question that OpenCode has echoed
    const registry = makeRegistry()
    const effects = makeEffects()
    register(registry, effects)
    const target = app(makeDeps(registry))
    await post(target, 'que_1', {decision: 'answer', answers: [{options: [0]}]})
    registry.confirmEcho({kind: 'replied', requestID: 'que_1', sessionID: 'sess-1', answers: [['staging']]})

    // #when the same submission is repeated (answer and skip)
    const again = await post(target, 'que_1', {decision: 'answer', answers: [{options: [0]}]})
    const skipAgain = await post(target, 'que_1', {decision: 'skip'})

    // #then both are idempotent already_settled and nothing more was sent
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({state: 'already_settled'})
    expect(await skipAgain.json()).toEqual({state: 'already_settled'})
    expect(effects.replyQuestion).toHaveBeenCalledOnce()
  })

  it('a second skip while the first reply is in flight → already_claimed, one reply', async () => {
    // #given a reply that has not resolved yet
    const registry = makeRegistry()
    const effects = makeEffects()
    let release: () => void = () => undefined
    effects.replyQuestion.mockImplementation(
      async () =>
        new Promise<{ok: true}>(resolve => {
          release = () => resolve({ok: true})
        }),
    )
    register(registry, effects)
    const target = app(makeDeps(registry))
    const first = post(target, 'que_1', {decision: 'skip'})
    await vi.waitFor(() => expect(effects.replyQuestion).toHaveBeenCalledOnce())

    // #when a second skip arrives
    const second = await post(target, 'que_1', {decision: 'skip'})
    release()
    await first

    // #then it lost the single-winner race
    expect(await second.json()).toEqual({state: 'already_claimed'})
    expect(effects.replyQuestion).toHaveBeenCalledOnce()
  })

  it('a second ANSWER while the first reply is in flight → already_claimed; if the first fails the question reopens and a third answer succeeds', async () => {
    // #given a first answer whose reply stays in flight
    const registry = makeRegistry()
    const effects = makeEffects()
    let failFirst: () => void = () => undefined
    effects.replyQuestion.mockImplementationOnce(
      async () =>
        new Promise<{ok: true}>(resolve => {
          failFirst = () => resolve({ok: false, error: SECRET} as never)
        }),
    )
    register(registry, effects)
    const deps = makeDeps(registry)
    const target = app(deps)
    const first = post(target, 'que_1', {decision: 'answer', answers: [{options: [0]}]})
    await vi.waitFor(() => expect(effects.replyQuestion).toHaveBeenCalledOnce())

    // #when a second operator answers while the first is claimed
    const second = await post(target, 'que_1', {decision: 'answer', answers: [{options: [1]}]})

    // #then it is told the request is claimed, not settled, and no second reply goes out
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({state: 'already_claimed'})
    expect(effects.replyQuestion).toHaveBeenCalledOnce()
    expect(deps.auditLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({kind: 'question.rejected', reason: 'already_claimed'}),
      'audit: question.rejected',
    )

    // #when the first reply then fails
    failFirst()
    const firstRes = await first

    // #then the first operator sees failed_to_settle and the question is open again
    expect(await firstRes.json()).toEqual({state: 'failed_to_settle'})
    expect(registry.describePendingForRun(RUN_ID)).toHaveLength(1)

    // #and a third answer is accepted
    const third = await post(target, 'que_1', {decision: 'answer', answers: [{options: [1]}]})
    expect(await third.json()).toEqual({state: 'claimed'})
    expect(effects.replyQuestion).toHaveBeenCalledTimes(2)
    expect(effects.replyQuestion).toHaveBeenLastCalledWith('que_1', [['prod']])
  })

  it('a second answer while the first reply is in flight stays already_claimed when the first reply throws', async () => {
    // #given a first answer whose reply stays in flight and then throws
    const registry = makeRegistry()
    const effects = makeEffects()
    let throwFirst: () => void = () => undefined
    effects.replyQuestion.mockImplementationOnce(
      async () =>
        new Promise<{ok: true}>((_resolve, reject) => {
          throwFirst = () => reject(new Error(SECRET))
        }),
    )
    register(registry, effects)
    const target = app(makeDeps(registry))
    const first = post(target, 'que_1', {decision: 'answer', answers: [{options: [0]}]})
    await vi.waitFor(() => expect(effects.replyQuestion).toHaveBeenCalledOnce())

    // #when a second answer arrives, then the first reply throws
    const second = await post(target, 'que_1', {decision: 'answer', answers: [{options: [1]}]})
    throwFirst()
    const firstRes = await first

    // #then the second was told claimed, the first failed_to_settle, and the question is open again
    expect(await second.json()).toEqual({state: 'already_claimed'})
    expect(await firstRes.json()).toEqual({state: 'failed_to_settle'})
    expect(registry.describePendingForRun(RUN_ID)).toHaveLength(1)
  })

  it('a claimed question of ANOTHER run is indistinguishable from an unknown id (never already_claimed)', async () => {
    // #given a question of run-other whose reply is in flight (claimed through its own run)
    const registry = makeRegistry()
    const effects = makeEffects()
    let release: () => void = () => undefined
    effects.replyQuestion.mockImplementationOnce(
      async () =>
        new Promise<{ok: true}>(resolve => {
          release = () => resolve({ok: true})
        }),
    )
    register(registry, effects, {runId: 'run-other', scope: 'run-other'})
    const claim = registry.decide({
      requestID: 'que_1',
      scopeId: 'run-other',
      runId: 'run-other',
      decision: {kind: 'skip'},
      actor: {kind: 'web-operator', githubUserId: 99, login: 'other', sessionCorrelationId: 'sess-other'},
    })
    await vi.waitFor(() => expect(effects.replyQuestion).toHaveBeenCalledOnce())
    const target = app(makeDeps(registry))

    // #when an operator authorized only for run-abc targets it, by answer and by skip, and probes an unknown id
    const answer = await post(target, 'que_1', {decision: 'answer', answers: [{options: [0]}]})
    const skip = await post(target, 'que_1', {decision: 'skip'})
    const unknown = await post(target, 'que_missing', {decision: 'answer', answers: [{options: [0]}]})

    // #then the claim is not revealed: same status and body as an unknown id, and nothing was sent
    expect(answer.status).toBe(unknown.status)
    expect(await answer.json()).toEqual(await unknown.json())
    expect(await skip.json()).toEqual({state: 'already_settled'})
    expect(effects.replyQuestion).toHaveBeenCalledOnce()

    release()
    await claim
  })

  it('a claimed question is still behind the denial gates: a read-only operator gets the no-oracle 404', async () => {
    // #given a claimed question on the operator's own run
    const registry = makeRegistry()
    const effects = makeEffects()
    let release: () => void = () => undefined
    effects.replyQuestion.mockImplementationOnce(
      async () =>
        new Promise<{ok: true}>(resolve => {
          release = () => resolve({ok: true})
        }),
    )
    register(registry, effects)
    const claim = registry.decide({
      requestID: 'que_1',
      scopeId: RUN_ID,
      runId: RUN_ID,
      decision: {kind: 'skip'},
      actor: {kind: 'web-operator', githubUserId: 99, login: 'other', sessionCorrelationId: 'sess-other'},
    })
    await vi.waitFor(() => expect(effects.replyQuestion).toHaveBeenCalledOnce())

    // #when a read-only operator answers
    const res = await post(app(makeDeps(registry, {repoAuthzDeps: readOnlyAuthz()})), 'que_1', {
      decision: 'answer',
      answers: [{options: [0]}],
    })

    // #then authz refuses first: the claim state is never revealed
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NO_ORACLE)

    release()
    await claim
  })

  it('a reply failure → 200 failed_to_settle, audit reply_failed, request open again', async () => {
    // #given the reply to OpenCode fails
    const registry = makeRegistry()
    const effects = makeEffects()
    effects.replyQuestion.mockResolvedValue({ok: false, error: SECRET} as never)
    register(registry, effects)
    const deps = makeDeps(registry)

    // #when
    const res = await post(app(deps), 'que_1', {decision: 'skip'})

    // #then
    expect(await res.json()).toEqual({state: 'failed_to_settle'})
    expect(registry.describePendingForRun(RUN_ID)).toHaveLength(1)
    expect(deps.auditLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({kind: 'question.rejected', reason: 'reply_failed'}),
      'audit: question.rejected',
    )
  })

  it('an unknown request id → already_settled with a not_found audit', async () => {
    // #given no pending questions
    const deps = makeDeps(makeRegistry())

    // #when
    const res = await post(app(deps), 'que_missing', {decision: 'skip'})

    // #then
    expect(await res.json()).toEqual({state: 'already_settled'})
    expect(deps.auditLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({kind: 'question.rejected', reason: 'not_found'}),
      'audit: question.rejected',
    )
  })

  it("a request id from another run is already_settled: the run's authz never grants another run's question", async () => {
    // #given a question that belongs to run-other, and an operator authorized for run-abc's repo
    const registry = makeRegistry()
    const effects = makeEffects()
    register(registry, effects, {runId: 'run-other', scope: 'run-other'})
    const target = app(makeDeps(registry))

    // #when the operator targets it through run-abc, by skip and by answer
    const skip = await post(target, 'que_1', {decision: 'skip'})
    const answer = await post(target, 'que_1', {decision: 'answer', answers: [{options: [0]}]})

    // #then neither settles it
    expect(await skip.json()).toEqual({state: 'already_settled'})
    expect(await answer.json()).toEqual({state: 'already_settled'})
    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(registry.describePendingForRun('run-other')).toHaveLength(1)
  })

  it('a question registered without a run id is unreachable from the web route', async () => {
    // #given a question with no run binding
    const registry = makeRegistry()
    const effects = makeEffects()
    registry.register({
      requestID: 'que_1',
      sessionID: 'sess-1',
      questionScopeId: RUN_ID,
      questions: [pickQuestion()],
      effects,
      deadlineMs: 60_000,
    })

    // #when
    const res = await post(app(makeDeps(registry)), 'que_1', {decision: 'skip'})

    // #then
    expect(await res.json()).toEqual({state: 'already_settled'})
    expect(effects.replyQuestion).not.toHaveBeenCalled()
  })
})

describe('POST question decision — audit and logs carry no question or answer text', () => {
  it('across accepted, invalid, claimed-race, and settled outcomes', async () => {
    // #given secret-shaped question text, option labels, and answers
    const registry = makeRegistry()
    const effects = makeEffects()
    register(registry, effects, {
      questions: [
        pickQuestion({
          header: SECRET,
          question: SECRET,
          options: [{label: `${SECRET}-opt`, description: SECRET}],
          custom: false,
        }),
      ],
    })
    const deps = makeDeps(registry)
    const target = app(deps)

    // #when an invalid answer (free text), a malformed body, an accepted answer, and a repeat
    await post(target, 'que_1', {decision: 'answer', answers: [{text: `${SECRET}-answer`}]})
    await post(target, 'que_1', `{"decision":"${SECRET}"`)
    await post(target, 'que_1', {decision: 'answer', answers: [{options: [0]}]})
    registry.confirmEcho({kind: 'replied', requestID: 'que_1', sessionID: 'sess-1', answers: [[`${SECRET}-opt`]]})
    await post(target, 'que_1', {decision: 'answer', answers: [{text: `${SECRET}-answer`}]})

    // #then no audit call and no log call mentions any of it
    const captured = JSON.stringify([
      deps.auditLogger.info.mock.calls,
      deps.auditLogger.warn.mock.calls,
      deps.logger.debug.mock.calls,
      deps.logger.info.mock.calls,
      deps.logger.warn.mock.calls,
      deps.logger.error.mock.calls,
    ])
    expect(captured).not.toContain('S3CRET')
    // …while the audit trail is non-vacuous: it recorded the decision and the refusals.
    expect(captured).toContain('question.decision')
    expect(captured).toContain('question.rejected')
  })

  it('the accepted-decision audit event has exactly the documented shape', async () => {
    // #given
    const registry = makeRegistry()
    register(registry, makeEffects())
    const deps = makeDeps(registry)

    // #when
    await post(app(deps), 'que_1', {decision: 'answer', answers: [{options: [0]}]})

    // #then
    expect(deps.auditLogger.info).toHaveBeenCalledExactlyOnceWith(
      {
        kind: 'question.decision',
        correlationId: `question:1001:${RUN_ID}:que_1`,
        githubUserId: 1001,
        runId: RUN_ID,
        requestId: 'que_1',
        family: 'question',
        outcome: 'answered',
      },
      'audit: question.decision',
    )
  })
})
