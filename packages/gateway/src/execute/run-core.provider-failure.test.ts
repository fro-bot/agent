/**
 * #1836 — a provider rejection must fail the run promptly, not after the inactivity window.
 *
 * Drives the real `runOpenCodeCore` event loop with fake timers against an open stream that never
 * closes, so a missed detection shows up as `inactivity-timeout` at the full window instead.
 */

import type {OpenCodeServerHandle} from '@fro-bot/runtime'
import type {PermissionCoordinator} from '../approvals/coordinator.js'
import type {GatewayLogger} from '../discord/client.js'
import type {DiscordStreamSink} from '../discord/streaming.js'

import {afterEach, describe, expect, it, vi} from 'vitest'

import {RunCoreError, runOpenCodeCore} from './run-core.js'

const ROOT = 'sess-123'
const CHILD = 'sess-child'
/** The production inactivity window; a fail-fast must land far inside it. */
const WINDOW = 300_000
const PROMPT_SECONDS = 1_000

/** Provider-controlled text that must never reach a failure message or a log line. */
const SECRET = 'sk-live-SECRET-token https://upstream.example/v1/chat?key=abc response-body-LEAK'

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function loggedText(logger: GatewayLogger): string {
  return [logger.debug, logger.info, logger.warn, logger.error]
    .flatMap(fn => vi.mocked(fn).mock.calls.map(call => JSON.stringify(call)))
    .join('\n')
}

function makeSink(): DiscordStreamSink {
  return {
    append: vi.fn(),
    flush: vi.fn().mockResolvedValue({kind: 'sent', charCount: 0}),
    buffered: () => '',
    markVisibleOutputSent: vi.fn(),
    markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
    hasVisibleOutput: vi.fn().mockReturnValue(false),
  }
}

function makeCoordinator(owned: readonly string[] = []): PermissionCoordinator {
  const ownedSessions = new Set<string>(owned)
  return {
    onPermissionAsked: vi.fn().mockResolvedValue('once'),
    onPermissionReplied: vi.fn(),
    pending: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
    addOwnedSession: vi.fn((id: string) => {
      ownedSessions.add(id)
    }),
    isOwned: vi.fn((id: string) => ownedSessions.has(id)),
  }
}

type Outcome = {readonly ok: true} | {readonly ok: false; readonly error: unknown}

interface Run {
  readonly emit: (event: object) => Promise<void>
  readonly outcome: () => Outcome | undefined
  readonly done: Promise<void>
  readonly logger: GatewayLogger
}

/** Starts a run over an open stream the test feeds one event at a time. */
function startRun(options: {readonly owned?: readonly string[]} = {}): Run {
  vi.useFakeTimers()
  const queue: object[] = []
  let wake: (() => void) | null = null

  async function* stream(): AsyncGenerator<object> {
    while (true) {
      const next = queue.shift()
      if (next === undefined) {
        await new Promise<void>(resolve => {
          wake = resolve
        })
      } else {
        yield next
      }
    }
  }

  const client = {
    session: {
      create: vi.fn().mockResolvedValue({data: {id: ROOT}, error: null}),
      messages: vi.fn().mockResolvedValue({data: [], error: null}),
      promptAsync: vi.fn().mockResolvedValue({data: {}, error: null}),
      children: vi.fn().mockResolvedValue({data: [], error: null}),
      status: vi.fn().mockResolvedValue({data: {}, error: null}),
      abort: vi.fn().mockResolvedValue({data: {}, error: null}),
    },
    event: {subscribe: vi.fn().mockResolvedValue({stream: stream()})},
    postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({error: null}),
  }
  const handle = {
    client,
    server: {url: 'http://workspace:9200', close: vi.fn()},
    shutdown: vi.fn(),
  } as unknown as OpenCodeServerHandle

  const logger = makeLogger()
  let settled: Outcome | undefined
  const done = runOpenCodeCore({
    handle,
    directory: '/workspace/repo',
    promptText: 'Fix the bug please',
    sink: makeSink(),
    signal: new AbortController().signal,
    logger,
    coordinator: makeCoordinator(options.owned),
    inactivityTimeoutMs: WINDOW,
  }).then(
    () => {
      settled = {ok: true}
    },
    (error: unknown) => {
      settled = {ok: false, error}
    },
  )

  return {
    emit: async event => {
      queue.push(event)
      if (wake !== null) {
        const resume: () => void = wake
        wake = null
        resume()
      }
      await vi.advanceTimersByTimeAsync(PROMPT_SECONDS)
    },
    outcome: () => settled,
    done,
    logger,
  }
}

function retryStatus(status: {readonly message?: string; readonly action?: object}, sessionID = ROOT): object {
  return {
    type: 'session.status',
    properties: {sessionID, status: {type: 'retry', attempt: 1, message: '', next: 1_000, ...status}},
  }
}

function assistantMessage(error: object | undefined, sessionID = ROOT, role = 'assistant'): object {
  return {
    type: 'message.updated',
    properties: {sessionID, info: {id: 'msg-1', sessionID, role, ...(error === undefined ? {} : {error})}},
  }
}

function sessionError(error: unknown, sessionID = ROOT): object {
  return {type: 'session.error', properties: {sessionID, error}}
}

function expectFailed(run: Run, message: string): void {
  const outcome = run.outcome()
  expect(outcome?.ok).toBe(false)
  if (outcome?.ok !== false) return
  expect(outcome.error).toBeInstanceOf(RunCoreError)
  expect((outcome.error as RunCoreError).kind).toBe('session-error')
  expect((outcome.error as RunCoreError).message).toBe(message)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runOpenCodeCore — provider rejection fails fast (#1836)', () => {
  describe('terminal signals fail the run long before the inactivity window', () => {
    const cases: readonly (readonly [string, object, string])[] = [
      [
        'retry status with structured action.reason auth_unavailable',
        retryStatus({action: {reason: 'auth_unavailable', provider: 'p', title: 't', message: SECRET, label: 'l'}}),
        'Provider failure: provider auth unavailable',
      ],
      [
        'retry status with a structured model_not_found reason',
        retryStatus({action: {reason: 'model_not_found', provider: 'p', title: 't', message: SECRET, label: 'l'}}),
        'Provider failure: model not available',
      ],
      [
        'retry status with a structured model_not_supported reason',
        retryStatus({action: {reason: 'model_not_supported', provider: 'p', title: 't', message: SECRET, label: 'l'}}),
        'Provider failure: model not available',
      ],
      [
        'assistant message.updated carrying ProviderAuthError',
        assistantMessage({name: 'ProviderAuthError', data: {providerID: 'openai', message: SECRET}}),
        'Provider failure: provider auth unavailable',
      ],
      [
        'assistant message.updated carrying an APIError',
        assistantMessage({name: 'APIError', data: {message: SECRET, statusCode: 400, isRetryable: false}}),
        'Provider failure: model provider rejected the request',
      ],
      [
        'assistant message.updated carrying an unsupported-model APIError',
        assistantMessage({name: 'APIError', data: {message: `model is not supported ${SECRET}`, isRetryable: false}}),
        'Provider failure: model not available',
      ],
    ]

    it.each(cases)('%s', async (_label, event, expectedMessage) => {
      // #given — an open stream with the full inactivity window ahead
      const run = startRun()

      // #when — the rejection event arrives
      await run.emit(event)

      // #then — FAILED with the fixed reason, one second in, nowhere near the window
      expectFailed(run, expectedMessage)
    })

    it('never leaks provider text into the failure or the logs', async () => {
      // #given
      const run = startRun()

      // #when — every classification path carries provider-controlled text
      await run.emit(
        retryStatus({
          message: `auth_unavailable: ${SECRET}`,
          action: {reason: 'auth_unavailable', provider: 'p', title: 't', message: SECRET, label: 'l'},
        }),
      )

      // #then
      const outcome = run.outcome()
      expect(outcome?.ok).toBe(false)
      const text = `${(outcome as {error: Error}).error.message}\n${loggedText(run.logger)}`
      for (const fragment of ['sk-live', 'SECRET', 'upstream.example', 'response-body', 'LEAK']) {
        expect(text).not.toContain(fragment)
      }
      expect(loggedText(run.logger)).toContain('provider auth unavailable')
    })

    it('logs only the error name for a message.updated failure', async () => {
      // #given
      const run = startRun()

      // #when
      await run.emit(assistantMessage({name: 'ProviderAuthError', data: {providerID: 'openai', message: SECRET}}))

      // #then
      expect(loggedText(run.logger)).toContain('ProviderAuthError')
      expect(loggedText(run.logger)).not.toContain('SECRET')
      expect(loggedText(run.logger)).not.toContain('openai')
    })

    it.each(['sk-live-abc123', 'a.b-c'])(
      'logs an identifier-shaped but unknown error name %s as "unknown"',
      async name => {
        // #given
        const run = startRun()

        // #when
        await run.emit(assistantMessage({name, data: {message: 'x'}}))

        // #then
        expect(loggedText(run.logger)).toContain('"errorName":"unknown"')
        expect(loggedText(run.logger)).not.toContain(name)
      },
    )

    it('replaces a non-identifier error name with "unknown" rather than logging it', async () => {
      // #given
      const run = startRun()

      // #when — the name itself is provider-controlled free text
      await run.emit(assistantMessage({name: `bad name ${SECRET}`, data: {message: SECRET}}))

      // #then
      expectFailed(run, 'Provider failure: session error')
      expect(loggedText(run.logger)).not.toContain('SECRET')
      expect(loggedText(run.logger)).toContain('"errorName":"unknown"')
    })
  })

  describe('transient retries keep waiting', () => {
    const transient: readonly (readonly [string, object])[] = [
      ['429 rate limit', retryStatus({message: 'Too Many Requests'})],
      ['429 with provider text', retryStatus({message: `429 rate limit exceeded ${SECRET}`})],
      ['overloaded', retryStatus({message: 'Provider is overloaded'})],
      ['5xx', retryStatus({message: 'Internal server error (500)'})],
      ['503', retryStatus({message: 'Service Unavailable 503'})],
      ['network', retryStatus({message: 'fetch failed: ECONNRESET'})],
      // A retried 5xx whose text names auth or a model is still a retry: only the structured reason is trusted.
      ['503 mentioning no auth available', retryStatus({message: `503 auth_unavailable: no auth available ${SECRET}`})],
      ['503 mentioning model not found', retryStatus({message: `503 model not found: openai/gpt-9 ${SECRET}`})],
      [
        'account rate limit with an action',
        retryStatus({action: {reason: 'account_rate_limit', provider: 'p', title: 't', message: 'm', label: 'l'}}),
      ],
    ]

    it.each(transient)('%s does not fail the run, which then completes normally', async (_label, event) => {
      // #given
      const run = startRun()

      // #when — a transient retry arrives, then a long wait inside the window
      await run.emit(event)
      await vi.advanceTimersByTimeAsync(WINDOW / 2)

      // #then — still running
      expect(run.outcome()).toBeUndefined()

      // #when — the retry succeeds and the root goes idle
      await run.emit({type: 'session.idle', properties: {sessionID: ROOT}})

      // #then
      expect(run.outcome()).toEqual({ok: true})
    })

    it('still ends in the inactivity timeout when nothing else happens', async () => {
      // #given
      const run = startRun()

      // #when — a transient retry, then silence for the whole window
      await run.emit(retryStatus({message: 'Too Many Requests'}))
      await vi.advanceTimersByTimeAsync(WINDOW + PROMPT_SECONDS)

      // #then — unchanged behavior for non-terminal retries
      const outcome = run.outcome()
      expect(outcome?.ok).toBe(false)
      expect((outcome as {error: RunCoreError}).error.kind).toBe('inactivity-timeout')
    })

    it('does not fail on an aborted assistant message', async () => {
      // #given
      const run = startRun()

      // #when — OpenCode marks the message aborted (operator cancel path owns that outcome)
      await run.emit(assistantMessage({name: 'MessageAbortedError', data: {message: 'Aborted'}}))

      // #then
      expect(run.outcome()).toBeUndefined()
    })

    it('ignores a non-assistant message and an assistant message without an error', async () => {
      // #given
      const run = startRun()

      // #when
      await run.emit(assistantMessage(undefined))
      await run.emit(assistantMessage({name: 'ProviderAuthError', data: {message: 'x'}}, ROOT, 'user'))

      // #then
      expect(run.outcome()).toBeUndefined()
    })
  })

  describe('root session only', () => {
    it('does not fail the root on a child retry status', async () => {
      // #given — the child is owned (adopted) by this run
      const run = startRun({owned: [CHILD]})

      // #when
      await run.emit(retryStatus({action: {reason: 'auth_unavailable'}}, CHILD))

      // #then
      expect(run.outcome()).toBeUndefined()
    })

    it('does not fail the root on a child assistant-message error', async () => {
      // #given
      const run = startRun({owned: [CHILD]})

      // #when
      await run.emit(assistantMessage({name: 'ProviderAuthError', data: {providerID: 'p', message: 'x'}}, CHILD))

      // #then
      expect(run.outcome()).toBeUndefined()
    })

    it('does not fail the run on a foreign session it does not own', async () => {
      // #given
      const run = startRun()

      // #when
      await run.emit(retryStatus({action: {reason: 'auth_unavailable'}}, 'sess-stranger'))
      await run.emit(assistantMessage({name: 'ProviderAuthError', data: {message: 'x'}}, 'sess-stranger'))

      // #then
      expect(run.outcome()).toBeUndefined()
    })
  })

  describe('structured session.error', () => {
    it('classifies a ProviderAuthError object instead of reporting "unknown session error"', async () => {
      // #given
      const run = startRun()

      // #when
      await run.emit(sessionError({name: 'ProviderAuthError', data: {providerID: 'openai', message: SECRET}}))

      // #then
      expectFailed(run, 'Provider failure: provider auth unavailable')
      expect(loggedText(run.logger)).not.toContain('unknown session error')
      expect(loggedText(run.logger)).not.toContain('SECRET')
    })

    it('classifies an unsupported-model UnknownError by its message without echoing it', async () => {
      // #given — OpenCode reports an unresolvable model as a bare UnknownError with only a message
      const run = startRun()

      // #when
      await run.emit(
        sessionError({
          name: 'UnknownError',
          data: {message: `Model not found: openai/gpt-9. Did you mean: gpt-5? ${SECRET}`},
        }),
      )

      // #then
      expectFailed(run, 'Provider failure: model not available')
      expect(loggedText(run.logger)).not.toContain('gpt-9')
    })

    it('gives an unclassifiable structured error a fixed reason', async () => {
      // #given
      const run = startRun()

      // #when
      await run.emit(sessionError({name: 'UnknownError', data: {message: SECRET}}))

      // #then
      expectFailed(run, 'Provider failure: session error')
    })

    it('does not fail the run on a session.error carrying MessageAbortedError', async () => {
      // #given
      const run = startRun()

      // #when — the abort signal, not this event, ends the loop
      await run.emit(sessionError({name: 'MessageAbortedError', data: {message: 'Aborted'}}))

      // #then — no RunCoreError, no provider failure logged
      expect(run.outcome()).toBeUndefined()
      expect(vi.mocked(run.logger.error)).not.toHaveBeenCalled()
    })

    it('keeps running through a ContextOverflowError session.error while OpenCode compacts', async () => {
      // #given
      const run = startRun()

      // #when — overflow is published, then OpenCode compacts and the root finishes
      await run.emit(sessionError({name: 'ContextOverflowError', data: {message: SECRET}}))
      expect(run.outcome()).toBeUndefined()
      await run.emit({type: 'session.idle', properties: {sessionID: ROOT}})

      // #then
      expect(run.outcome()).toEqual({ok: true})
      expect(vi.mocked(run.logger.error)).not.toHaveBeenCalled()
    })

    it('still fails normally when a terminal error follows a ContextOverflowError', async () => {
      // #given
      const run = startRun()

      // #when
      await run.emit(sessionError({name: 'ContextOverflowError', data: {message: 'x'}}))
      await run.emit(sessionError({name: 'ProviderAuthError', data: {message: 'x'}}))

      // #then
      expectFailed(run, 'Provider failure: provider auth unavailable')
    })

    it.each([
      [`auth_unavailable: no auth available (${SECRET})`, 'Provider failure: provider auth unavailable'],
      [
        `'gpt-5.5' model is not supported when using Codex with a ChatGPT account ${SECRET}`,
        'Provider failure: model not available',
      ],
      [`Model not found: openai/gpt-9. Did you mean: gpt-5? ${SECRET}`, 'Provider failure: model not available'],
    ])('classifies a string session.error carrying a provider body: %s', async (text, expectedMessage) => {
      // #given
      const run = startRun()

      // #when
      await run.emit(sessionError(text))

      // #then — the fixed reason, with no raw substring in the failure or any logger call
      expectFailed(run, expectedMessage)
      const logged = loggedText(run.logger)
      for (const fragment of ['sk-live', 'SECRET', 'upstream.example', 'response-body', 'LEAK', 'gpt-9', 'ChatGPT']) {
        expect(logged).not.toContain(fragment)
      }
    })

    it('gives an arbitrary string a fixed "session error" reason and never echoes it', async () => {
      // #given
      const run = startRun()

      // #when
      await run.emit(sessionError(`LLM quota exceeded ${SECRET}`))

      // #then — failureKind stays session-error (expectFailed asserts it); no raw text anywhere
      expectFailed(run, 'Provider failure: session error')
      const logged = loggedText(run.logger)
      expect(logged).not.toContain('quota')
      expect(logged).not.toContain('SECRET')
      for (const call of vi.mocked(run.logger.error).mock.calls) {
        expect(JSON.stringify(call)).toContain('"reason":"session error"')
      }
    })

    it('logs only source, error name and reason for a string session.error', async () => {
      // #given
      const run = startRun()

      // #when
      await run.emit(sessionError(`auth_unavailable ${SECRET}`))

      // #then
      expect(vi.mocked(run.logger.error)).toHaveBeenCalledWith(
        {sessionId: ROOT, source: 'session.error', errorName: 'error-text', reason: 'provider auth unavailable'},
        expect.any(String),
      )
    })

    it('reports a payload with no error as a fixed "session error"', async () => {
      // #given
      const run = startRun()

      // #when
      await run.emit({type: 'session.error', properties: {sessionID: ROOT}})

      // #then
      expectFailed(run, 'Provider failure: session error')
    })
  })

  describe('duplicate signals', () => {
    it('fails once when several terminal signals arrive for the same rejection', async () => {
      // #given — OpenCode emits the assistant error, then session.error, for one rejection
      const run = startRun()

      // #when
      await run.emit(assistantMessage({name: 'ProviderAuthError', data: {message: 'x'}}))
      await run.emit(sessionError({name: 'ProviderAuthError', data: {message: 'x'}}))

      // #then — one settled outcome, from the first signal
      expectFailed(run, 'Provider failure: provider auth unavailable')
      expect(vi.mocked(run.logger.error)).toHaveBeenCalledTimes(1)
    })
  })
})
