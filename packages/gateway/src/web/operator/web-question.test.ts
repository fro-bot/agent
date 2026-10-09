/**
 * Tests for the web question transport.
 *
 * Verifies that, once the coordinator has registered a question:
 * - the open frame carries the bounded, normalized detail and the run id;
 * - the settle render is attached BEFORE the open frame is emitted;
 * - the settle frame is emitted through the real registry's render on every
 *   settlement path (echo, skip, teardown);
 * - a throwing observer is fail-soft and logs ids only — never question text;
 * - text is carried verbatim apart from bounding and control stripping.
 */

import type {QuestionInfo, QuestionRegistry, QuestionSideEffects} from '../../approvals/question-registry.js'
import type {GatewayLogger} from '../../discord/client.js'
import type {QuestionFrameData} from '../../operator-contract/question-frame.js'
import type {WebQuestionRequest, WebQuestionTransportContext, WebQuestionTransportDeps} from './web-question.js'
import {describe, expect, it, vi} from 'vitest'
import {QUESTION_TEXT_MAX_LENGTH} from '../../approvals/question-detail.js'
import {createQuestionRegistry} from '../../approvals/question-registry.js'
import {createWebQuestionOnRegistered} from './web-question.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUN_ID = 'run-uuid-1234'

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeEffects(): QuestionSideEffects {
  return {
    replyQuestion: vi.fn(async () => ({ok: true as const})),
    rejectQuestion: vi.fn(async () => ({ok: true as const})),
  }
}

function question(overrides?: Partial<QuestionInfo>): QuestionInfo {
  return {
    header: 'Pick',
    question: 'Which one?',
    options: [
      {label: 'A', description: 'first'},
      {label: 'B', description: 'second'},
    ],
    multiple: false,
    custom: true,
    ...overrides,
  }
}

function makeRequest(overrides?: Partial<WebQuestionRequest>): WebQuestionRequest {
  return {requestID: 'q-123', questions: [question()], ...overrides}
}

/** Register a question the way the coordinator does, then hand it to the transport. */
function registerAndAnnounce(
  registry: QuestionRegistry,
  deps: WebQuestionTransportDeps,
  request: WebQuestionRequest,
  effects: QuestionSideEffects = makeEffects(),
  ctxOverrides?: Partial<WebQuestionTransportContext>,
): void {
  registry.register({
    requestID: request.requestID,
    sessionID: 'sess-abc',
    questionScopeId: RUN_ID,
    runId: RUN_ID,
    questions: request.questions,
    effects,
    deadlineMs: 60_000,
  })
  createWebQuestionOnRegistered(deps)({questionRegistry: registry, runId: RUN_ID, repo: 'owner/repo', ...ctxOverrides})(
    request,
  )
}

function makeDeps(overrides?: Partial<WebQuestionTransportDeps>): WebQuestionTransportDeps {
  return {
    observeQuestion: vi.fn(),
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    ...overrides,
  }
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0)
  })
}

function lastOpenFrame(deps: WebQuestionTransportDeps): Extract<QuestionFrameData, {settled: false}> {
  const frame = vi.mocked(deps.observeQuestion).mock.calls.at(0)?.[1]
  if (frame === undefined || frame.settled) throw new Error('expected an open frame')
  return frame
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createWebQuestionOnRegistered', () => {
  describe('open frame', () => {
    it('emits an open frame with the bounded detail, run id, and normalized flags', () => {
      // #given a registered question with `custom` and `multiple` normalized by the coordinator
      const registry = createQuestionRegistry({logger: makeLogger()})
      const deps = makeDeps()

      // #when announced
      registerAndAnnounce(registry, deps, makeRequest())

      // #then the frame carries run id, normalized booleans, and verbatim short text
      expect(deps.observeQuestion).toHaveBeenCalledExactlyOnceWith(RUN_ID, {
        requestID: 'q-123',
        runId: RUN_ID,
        questions: [
          {
            header: 'Pick',
            text: 'Which one?',
            options: [
              {label: 'A', description: 'first'},
              {label: 'B', description: 'second'},
            ],
            multiple: false,
            custom: true,
          },
        ],
        settled: false,
      })
    })

    it('attaches the settle render before the open frame is emitted', () => {
      // #given an observer that records whether the render was already attached when it was called
      const real = createQuestionRegistry({logger: makeLogger()})
      const order: string[] = []
      const registry = {
        attachMessage: (...args: Parameters<QuestionRegistry['attachMessage']>) => {
          order.push('attach')
          real.attachMessage(...args)
        },
      }
      const deps = makeDeps({observeQuestion: vi.fn(() => order.push('observe'))})
      real.register({
        requestID: 'q-123',
        sessionID: 'sess-abc',
        questionScopeId: RUN_ID,
        questions: [question()],
        effects: makeEffects(),
        deadlineMs: 60_000,
      })

      // #when announced
      createWebQuestionOnRegistered(deps)({questionRegistry: registry, runId: RUN_ID, repo: 'o/r'})(makeRequest())

      // #then the render is attached first, so no settlement can slip past the browser
      expect(order).toStrictEqual(['attach', 'observe'])
    })

    it('carries custom:false and multiple:true when the question sets them', () => {
      // #given explicit flags
      const registry = createQuestionRegistry({logger: makeLogger()})
      const deps = makeDeps()

      // #when announced
      registerAndAnnounce(registry, deps, makeRequest({questions: [question({multiple: true, custom: false})]}))

      // #then the frame reflects them
      expect(lastOpenFrame(deps).questions[0]).toMatchObject({multiple: true, custom: false})
    })

    it('bounds over-cap text and strips control characters in the frame, not in the registry', () => {
      // #given text over the cap with ESC and NUL characters
      const registry = createQuestionRegistry({logger: makeLogger()})
      const deps = makeDeps()
      const long = `\u001B[31m${'x'.repeat(QUESTION_TEXT_MAX_LENGTH + 500)}\u0000`

      // #when announced
      registerAndAnnounce(registry, deps, makeRequest({questions: [question({question: long, options: []})]}))

      // #then the frame text is capped and clean, while the registry keeps the raw text
      const text = lastOpenFrame(deps).questions[0]?.text ?? ''
      expect(text).toHaveLength(QUESTION_TEXT_MAX_LENGTH)
      expect(text.startsWith('[31m')).toBe(true)
      expect(text).not.toContain('\u001B')
      expect(text).not.toContain('\u0000')
      expect(registry.describePendingForRun(RUN_ID)[0]?.questions[0]?.question).toBe(long)
    })

    it('carries injection-shaped text verbatim as a string, never pre-rendered', () => {
      // #given markup- and markdown-shaped text
      const registry = createQuestionRegistry({logger: makeLogger()})
      const deps = makeDeps()
      const payload = '<img src=x onerror=alert(1)> `code` [link](javascript:alert(1)) **bold**'

      // #when announced
      registerAndAnnounce(
        registry,
        deps,
        makeRequest({
          questions: [
            question({header: payload, question: payload, options: [{label: payload, description: payload}]}),
          ],
        }),
      )

      // #then every field is the exact payload string
      const [first] = lastOpenFrame(deps).questions
      expect(first?.header).toBe(payload)
      expect(first?.text).toBe(payload)
      expect(first?.options[0]).toStrictEqual({label: payload, description: payload})
    })
  })

  describe('settle frame', () => {
    it('emits a settle frame when OpenCode echoes question.replied', async () => {
      // #given an announced question
      const registry = createQuestionRegistry({logger: makeLogger()})
      const deps = makeDeps()
      registerAndAnnounce(registry, deps, makeRequest())

      // #when the authoritative echo arrives
      registry.confirmEcho({kind: 'replied', requestID: 'q-123', sessionID: 'sess-abc', answers: [['A']]})
      await flush()

      // #then the second observation is the settle frame
      expect(deps.observeQuestion).toHaveBeenCalledTimes(2)
      expect(deps.observeQuestion).toHaveBeenNthCalledWith(2, RUN_ID, {
        requestID: 'q-123',
        runId: RUN_ID,
        settled: true,
      })
      expect(registry.has('q-123')).toBe(false)
    })

    it('emits a settle frame when an operator skip settles and OpenCode echoes it', async () => {
      // #given an announced question and a web operator skip
      const registry = createQuestionRegistry({logger: makeLogger()})
      const effects = makeEffects()
      const deps = makeDeps()
      registerAndAnnounce(registry, deps, makeRequest(), effects)

      // #when the operator skips and the echo follows
      const outcome = await registry.decide({
        requestID: 'q-123',
        scopeId: RUN_ID,
        decision: {kind: 'skip'},
        actor: {kind: 'web-operator', githubUserId: 42, login: 'octocat', sessionCorrelationId: 'sess-1'},
      })
      registry.confirmEcho({kind: 'replied', requestID: 'q-123', sessionID: 'sess-abc', answers: [[]]})
      await flush()

      // #then the reply was an empty answer and the settle frame followed the open frame
      expect(outcome).toStrictEqual({kind: 'ok'})
      expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('q-123', [[]])
      expect(
        vi.mocked(deps.observeQuestion).mock.calls.map(call => (call[1] as {settled: boolean}).settled),
      ).toStrictEqual([false, true])
    })

    it('emits a settle frame on teardown (disposeRun) and rejects the question', async () => {
      // #given an announced question
      const registry = createQuestionRegistry({logger: makeLogger()})
      const effects = makeEffects()
      const deps = makeDeps()
      registerAndAnnounce(registry, deps, makeRequest(), effects)

      // #when the run tears down
      await registry.disposeRun('sess-abc', 'run-end')

      // #then the question is rejected and the browser is told to dismiss it
      expect(effects.rejectQuestion).toHaveBeenCalledExactlyOnceWith('q-123')
      expect(deps.observeQuestion).toHaveBeenLastCalledWith(RUN_ID, {requestID: 'q-123', runId: RUN_ID, settled: true})
    })

    it('swallows a throwing observer on the settle frame and logs ids only', async () => {
      // #given an observer that throws only for the settle frame
      const registry = createQuestionRegistry({logger: makeLogger()})
      const deps = makeDeps({
        observeQuestion: vi.fn((_runId: string, data: QuestionFrameData) => {
          if (data.settled) throw new Error('boom: SECRET-TEXT')
        }),
      })
      registerAndAnnounce(registry, deps, makeRequest())

      // #when the echo settles it
      registry.confirmEcho({kind: 'rejected', requestID: 'q-123', sessionID: 'sess-abc'})
      await flush()

      // #then the settlement still applied and the warning carries ids and an error name only
      expect(registry.has('q-123')).toBe(false)
      const warnings = JSON.stringify(vi.mocked(deps.logger.warn).mock.calls)
      expect(warnings).toContain('q-123')
      expect(warnings).not.toContain('SECRET-TEXT')
    })
  })

  describe('fail-soft', () => {
    it('does not throw when the open-frame observer throws, keeps the entry, and logs without text', () => {
      // #given an observer that throws, and a question with secret-shaped text
      const registry = createQuestionRegistry({logger: makeLogger()})
      const deps = makeDeps({
        observeQuestion: vi.fn(() => {
          throw new Error('boom: SECRET-ERR')
        }),
      })
      const request = makeRequest({questions: [question({question: 'token=SECRET-Q', options: []})]})

      // #when / #then announcing does not throw
      expect(() => {
        registerAndAnnounce(registry, deps, request)
      }).not.toThrow()

      // #then the entry stays registered and the warning has ids only
      expect(registry.has('q-123')).toBe(true)
      expect(deps.logger.warn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({runId: RUN_ID, requestID: 'q-123', errName: 'Error'}),
        expect.stringContaining('open-frame observer threw'),
      )
      const warnings = JSON.stringify(vi.mocked(deps.logger.warn).mock.calls)
      expect(warnings).not.toContain('SECRET-ERR')
      expect(warnings).not.toContain('SECRET-Q')
    })

    it('does not throw when frame building throws on malformed data', () => {
      // #given a request whose options are missing (malformed upstream data)
      const registry = {attachMessage: vi.fn()}
      const deps = makeDeps()
      const malformed = {requestID: 'q-bad', questions: [{header: 'h', question: 'q'}]} as unknown as WebQuestionRequest

      // #when / #then the hook does not throw and no frame is emitted
      expect(() => {
        createWebQuestionOnRegistered(deps)({questionRegistry: registry, runId: RUN_ID, repo: 'o/r'})(malformed)
      }).not.toThrow()
      expect(deps.observeQuestion).not.toHaveBeenCalled()
      expect(deps.logger.warn).toHaveBeenCalledOnce()
    })

    it('does not throw when attaching the settle render throws', () => {
      // #given a registry whose attachMessage throws
      const registry = {
        attachMessage: vi.fn(() => {
          throw new Error('boom')
        }),
      }
      const deps = makeDeps()

      // #when / #then the hook still emits the open frame without throwing
      expect(() => {
        createWebQuestionOnRegistered(deps)({questionRegistry: registry, runId: RUN_ID, repo: 'o/r'})(makeRequest())
      }).not.toThrow()
      expect(deps.observeQuestion).toHaveBeenCalledOnce()
    })
  })
})
