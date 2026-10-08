/**
 * Tests for the web question transport.
 *
 * Verifies that:
 * - `onPending(request)` registers the question with `questionScopeId = ctx.runId`
 *   BEFORE emitting the open frame (register-before-fan-out).
 * - The open frame carries the bounded, normalized detail and the run id.
 * - The settle frame is emitted through the registry's render on every settlement
 *   path (echo, teardown), using the real question registry.
 * - A throwing observer is fail-soft: nothing rejects the pending hook, the entry
 *   stays registered, and log calls carry ids only — never question text.
 * - A duplicate or refused registration emits no frame.
 * - Text is carried verbatim apart from bounding and control stripping.
 */

import type {QuestionRegistry, QuestionSideEffects} from '../../approvals/question-registry.js'
import type {GatewayLogger} from '../../discord/client.js'
import type {QuestionFrameData} from '../../operator-contract/question-frame.js'
import type {WebQuestionRequest, WebQuestionTransportContext, WebQuestionTransportDeps} from './web-question.js'
import {describe, expect, it, vi} from 'vitest'
import {QUESTION_TEXT_MAX_LENGTH} from '../../approvals/question-detail.js'
import {createQuestionRegistry} from '../../approvals/question-registry.js'
import {createWebQuestionOnPending} from './web-question.js'

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

function makeRequest(overrides?: Partial<WebQuestionRequest>): WebQuestionRequest {
  return {
    requestID: 'q-123',
    sessionID: 'sess-abc',
    questions: [
      {
        header: 'Pick',
        question: 'Which one?',
        options: [
          {label: 'A', description: 'first'},
          {label: 'B', description: 'second'},
        ],
      },
    ],
    ...overrides,
  }
}

function makeCtx(
  registry: QuestionRegistry,
  overrides?: Partial<WebQuestionTransportContext>,
): WebQuestionTransportContext {
  return {
    questionRegistry: registry,
    runId: RUN_ID,
    repo: 'owner/repo',
    questionDeadlineMs: 60_000,
    effects: makeEffects(),
    ...overrides,
  }
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createWebQuestionOnPending', () => {
  describe('register-before-fan-out', () => {
    it('registers the question with questionScopeId = ctx.runId, then emits the open frame', () => {
      // #given a registry spy and an observer that records call order
      const real = createQuestionRegistry({logger: makeLogger()})
      const order: string[] = []
      const registerSpy = vi.fn((params: Parameters<QuestionRegistry['register']>[0]) => {
        order.push('register')
        return real.register(params)
      })
      const deps = makeDeps({observeQuestion: vi.fn(() => order.push('observe'))})
      const ctx = makeCtx({register: registerSpy, attachMessage: real.attachMessage} as never)

      // #when a question is pending
      createWebQuestionOnPending(deps)(ctx)(makeRequest())

      // #then register precedes observe, with the run id as scope
      expect(order).toStrictEqual(['register', 'observe'])
      expect(registerSpy).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          requestID: 'q-123',
          sessionID: 'sess-abc',
          questionScopeId: RUN_ID,
          deadlineMs: 60_000,
        }),
      )
    })

    it('emits an open frame with the bounded detail, run id, and normalized flags', () => {
      // #given a question with `custom` omitted and `multiple` omitted
      const registry = createQuestionRegistry({logger: makeLogger()})
      const deps = makeDeps()

      // #when pending
      createWebQuestionOnPending(deps)(makeCtx(registry))(makeRequest())

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
      expect(registry.has('q-123')).toBe(true)
    })

    it('carries custom:false and multiple:true when the question sets them', () => {
      // #given explicit flags
      const registry = createQuestionRegistry({logger: makeLogger()})
      const deps = makeDeps()
      const request = makeRequest({
        questions: [{header: 'h', question: 'q', options: [], multiple: true, custom: false}],
      })

      // #when pending
      createWebQuestionOnPending(deps)(makeCtx(registry))(request)

      // #then the frame reflects them
      const frame = vi.mocked(deps.observeQuestion).mock.calls.at(0)?.[1] as Extract<
        QuestionFrameData,
        {settled: false}
      >
      expect(frame.questions[0]).toMatchObject({multiple: true, custom: false})
    })

    it('bounds over-cap text and strips control characters in the frame, not in the registry', () => {
      // #given text over the cap with ESC and NUL characters
      const registry = createQuestionRegistry({logger: makeLogger()})
      const deps = makeDeps()
      const long = `\u001B[31m${'x'.repeat(QUESTION_TEXT_MAX_LENGTH + 500)}\u0000`
      const request = makeRequest({questions: [{header: 'h', question: long, options: []}]})

      // #when pending
      createWebQuestionOnPending(deps)(makeCtx(registry))(request)

      // #then the frame text is capped and clean, while the registry keeps the raw text
      const frame = vi.mocked(deps.observeQuestion).mock.calls.at(0)?.[1] as Extract<
        QuestionFrameData,
        {settled: false}
      >
      const text = frame.questions[0]?.text ?? ''
      expect(text).toHaveLength(QUESTION_TEXT_MAX_LENGTH)
      expect(text.startsWith('[31m')).toBe(true)
      expect(text).not.toContain('\u001B')
      expect(text).not.toContain('\u0000')
      expect(registry.describePendingForScope(RUN_ID)[0]?.questions[0]?.question).toBe(long)
    })

    it('carries injection-shaped text verbatim as a string, never pre-rendered', () => {
      // #given markup- and markdown-shaped text
      const registry = createQuestionRegistry({logger: makeLogger()})
      const deps = makeDeps()
      const payload = '<img src=x onerror=alert(1)> `code` [link](javascript:alert(1)) **bold**'
      const request = makeRequest({
        questions: [{header: payload, question: payload, options: [{label: payload, description: payload}]}],
      })

      // #when pending
      createWebQuestionOnPending(deps)(makeCtx(registry))(request)

      // #then every field is the exact payload string
      const frame = vi.mocked(deps.observeQuestion).mock.calls.at(0)?.[1] as Extract<
        QuestionFrameData,
        {settled: false}
      >
      const [question] = frame.questions
      expect(question?.header).toBe(payload)
      expect(question?.text).toBe(payload)
      expect(question?.options[0]).toStrictEqual({label: payload, description: payload})
    })
  })

  describe('settle frame', () => {
    it('emits a settle frame when OpenCode echoes question.replied', async () => {
      // #given a registered, rendered question
      const registry = createQuestionRegistry({logger: makeLogger()})
      const deps = makeDeps()
      createWebQuestionOnPending(deps)(makeCtx(registry))(makeRequest())

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
      // #given a registered question and a web operator skip
      const registry = createQuestionRegistry({logger: makeLogger()})
      const effects = makeEffects()
      const deps = makeDeps()
      createWebQuestionOnPending(deps)(makeCtx(registry, {effects}))(makeRequest())

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
      // #given a registered question
      const registry = createQuestionRegistry({logger: makeLogger()})
      const effects = makeEffects()
      const deps = makeDeps()
      createWebQuestionOnPending(deps)(makeCtx(registry, {effects}))(makeRequest())

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
      createWebQuestionOnPending(deps)(makeCtx(registry))(makeRequest())

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

  describe('fail-soft observation', () => {
    it('does not throw when the open-frame observer throws, keeps the entry, and logs without text', () => {
      // #given an observer that throws, and a request containing secret-shaped text
      const registry = createQuestionRegistry({logger: makeLogger()})
      const deps = makeDeps({
        observeQuestion: vi.fn(() => {
          throw new Error('boom: SECRET-ERR')
        }),
      })
      const request = makeRequest({questions: [{header: 'h', question: 'token=SECRET-Q', options: []}]})
      const onPending = createWebQuestionOnPending(deps)(makeCtx(registry))

      // #when / #then the hook does not throw
      expect(() => onPending(request)).not.toThrow()

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

    it('does not throw when frame building throws on a malformed request', () => {
      // #given a request whose options are missing (malformed upstream data) and a throwing registry-free path
      const registry = {
        register: vi.fn(() => ({kind: 'registered' as const})),
        attachMessage: vi.fn(),
      }
      const deps = makeDeps()
      const malformed = {requestID: 'q-bad', sessionID: 's', questions: [{header: 'h', question: 'q'}]}

      // #when / #then the pending hook does not throw and no frame is emitted
      expect(() =>
        createWebQuestionOnPending(deps)(makeCtx(registry as never))(malformed as unknown as WebQuestionRequest),
      ).not.toThrow()
      expect(deps.observeQuestion).not.toHaveBeenCalled()
      expect(deps.logger.warn).toHaveBeenCalledOnce()
    })
  })

  describe('non-registered outcomes', () => {
    it('emits no new frame for a duplicate request id and keeps the existing entry', () => {
      // #given an already-pending request id
      const registry = createQuestionRegistry({logger: makeLogger()})
      const deps = makeDeps()
      const onPending = createWebQuestionOnPending(deps)(makeCtx(registry))
      onPending(makeRequest())

      // #when the same id is raised again
      onPending(makeRequest())

      // #then only the first open frame was emitted
      expect(deps.observeQuestion).toHaveBeenCalledOnce()
      expect(registry.pending()).toStrictEqual(['q-123'])
    })

    it('emits no frame when the registry refuses the registration (no deadline)', () => {
      // #given a non-positive deadline
      const registry = createQuestionRegistry({logger: makeLogger()})
      const deps = makeDeps()

      // #when pending
      createWebQuestionOnPending(deps)(makeCtx(registry, {questionDeadlineMs: 0}))(makeRequest())

      // #then nothing is registered or emitted
      expect(registry.has('q-123')).toBe(false)
      expect(deps.observeQuestion).not.toHaveBeenCalled()
    })
  })
})
