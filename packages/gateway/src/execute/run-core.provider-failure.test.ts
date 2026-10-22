/**
 * #1836 — a provider rejection must fail the run promptly, not after the inactivity window.
 *
 * Drives the real `runOpenCodeCore` event loop with fake timers against an open stream that never
 * closes, so a missed detection shows up as `inactivity-timeout` at the full window instead.
 */

import type {OpenCodeServerHandle, OwnershipLedger} from '@fro-bot/runtime'
import type {PermissionCoordinator} from '../approvals/coordinator.js'
import type {GatewayLogger} from '../discord/client.js'
import type {DiscordStreamSink} from '../discord/streaming.js'

import {createOwnershipLedger} from '@fro-bot/runtime'
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
  readonly abort: ReturnType<typeof vi.fn>
  readonly logger: GatewayLogger
}

/** Starts a run over an open stream the test feeds one event at a time. */
interface StartOptions {
  readonly owned?: readonly string[]
  readonly controller?: AbortController
  readonly ownershipLedger?: OwnershipLedger
  /** Live-session map `session.status` reports; defaults to nothing live. */
  readonly live?: Readonly<Record<string, object>>
  readonly abort?: () => Promise<unknown>
}

function startRun(options: StartOptions = {}): Run {
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
      status: vi.fn().mockResolvedValue({data: options.live ?? {}, error: null}),
      abort: vi.fn(options.abort ?? (async () => ({data: {}, error: null}))),
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
    signal: (options.controller ?? new AbortController()).signal,
    logger,
    coordinator: makeCoordinator(options.owned),
    ...(options.ownershipLedger === undefined ? {} : {ownershipLedger: options.ownershipLedger}),
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
    abort: client.session.abort,
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

/** An assistant message whose session id appears ONLY on `info`, so the nested fallback runs alone. */
function nestedOnlyAssistantMessage(error: object): object {
  return {type: 'message.updated', properties: {info: {id: 'msg-1', sessionID: ROOT, role: 'assistant', error}}}
}

/** A compaction part whose session id appears ONLY on `part`, so the nested fallback runs alone. */
function nestedOnlyCompactionPart(sessionID = ROOT): object {
  return {
    type: 'message.part.updated',
    properties: {part: {id: 'part-compaction', messageID: 'msg-compaction', sessionID, type: 'compaction', auto: true}},
  }
}

function sessionError(error: unknown, sessionID = ROOT): object {
  return {type: 'session.error', properties: {sessionID, error}}
}

/** The root user message part `compaction.create` writes (compaction.ts:574-580). */
function compactionPart(sessionID = ROOT): object {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID,
      part: {id: 'part-compaction', messageID: 'msg-compaction', sessionID, type: 'compaction', auto: true},
    },
  }
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
        'retry status with a structured account_rate_limit reason',
        retryStatus({action: {reason: 'account_rate_limit', provider: 'p', title: 't', message: SECRET, label: 'l'}}),
        'Provider failure: provider quota exceeded',
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

  describe('a classified retry stops the live root before the run fails', () => {
    const authRetry = retryStatus({
      action: {reason: 'auth_unavailable', provider: 'p', title: 't', message: 'm', label: 'l'},
    })

    function settledLedger(): OwnershipLedger {
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'child')
      ledger.settle(CHILD)
      return ledger
    }

    it.each([
      ['no ledger', undefined],
      ['an empty ledger', createOwnershipLedger()],
      ['a settled ledger', settledLedger()],
    ])('aborts the root and confirms it quiescent with %s', async (_label, ownershipLedger) => {
      // #given — OpenCode is mid-retry, so the root is live
      const run = startRun({...(ownershipLedger === undefined ? {} : {ownershipLedger})})

      // #when
      await run.emit(authRetry)

      // #then — the failure is unchanged, and only returned after the root was aborted and checked
      expectFailed(run, 'Provider failure: provider auth unavailable')
      expect(run.abort).toHaveBeenCalledTimes(1)
      expect(run.abort).toHaveBeenCalledWith(expect.objectContaining({path: {id: ROOT}}))
      expect((run.outcome() as {error: RunCoreError}).error.quarantined).toBe(false)
    })

    it('passes rootMayBeRunning through the barrier options: a retry status always tears the live root down first', async () => {
      // #given — a retry status is the one failure source where OpenCode is still running the root. If
      // `failFromProvider` stopped passing `rootMayBeRunning` into `throwWithBarrier`, the barrier would see no live
      // work (no ledger, no drain) and return immediately.
      const run = startRun()

      // #when
      await run.emit(authRetry)

      // #then — the root was aborted exactly once, and only then did the run fail
      expect(run.abort).toHaveBeenCalledTimes(1)
      expect(run.abort).toHaveBeenCalledWith(expect.objectContaining({path: {id: ROOT}}))
      expectFailed(run, 'Provider failure: provider auth unavailable')
    })

    it('quarantines the run when the root stays live after the abort', async () => {
      // #given — the directory's live set keeps reporting the root
      const run = startRun({live: {[ROOT]: {type: 'retry'}}})

      // #when — the bounded teardown budget runs out
      await run.emit(authRetry)
      await vi.advanceTimersByTimeAsync(20_000)

      // #then — same kind and message, with quarantine as extra evidence
      const outcome = run.outcome()
      expect(outcome?.ok).toBe(false)
      const error = (outcome as {error: RunCoreError}).error
      expect(error.kind).toBe('session-error')
      expect(error.message).toBe('Provider failure: provider auth unavailable')
      expect(error.quarantined).toBe(true)
    })

    it('quarantines the run when the abort fails and the root stays live', async () => {
      // #given
      const run = startRun({
        live: {[ROOT]: {type: 'retry'}},
        abort: async () => {
          throw new Error(`abort refused ${SECRET}`)
        },
      })

      // #when
      await run.emit(authRetry)
      await vi.advanceTimersByTimeAsync(20_000)

      // #then — quarantined, and the abort error text is not echoed
      const error = (run.outcome() as {error: RunCoreError}).error
      expect(error.kind).toBe('session-error')
      expect(error.quarantined).toBe(true)
      expect(error.message).not.toContain('SECRET')
    })

    it('does not abort the root for a terminal error, which fires after OpenCode set it idle', async () => {
      // #given
      const run = startRun({ownershipLedger: createOwnershipLedger()})

      // #when — processor.ts halt publishes the error and sets idle in one step
      await run.emit(sessionError({name: 'ProviderAuthError', data: {providerID: 'p', message: 'x'}}))

      // #then
      expectFailed(run, 'Provider failure: provider auth unavailable')
      expect(run.abort).not.toHaveBeenCalled()
    })
  })

  describe('nested-only session ids', () => {
    it('classifies an assistant message that carries its session id only on info', async () => {
      // #given
      const run = startRun()

      // #when
      await run.emit(nestedOnlyAssistantMessage({name: 'ProviderAuthError', data: {providerID: 'p', message: 'x'}}))

      // #then
      expectFailed(run, 'Provider failure: provider auth unavailable')
    })

    it('clears a pending overflow on a compaction part that carries its session id only on part', async () => {
      // #given
      const run = startRun()

      // #when
      await run.emit(sessionError({name: 'ContextOverflowError', data: {message: 'x'}}))
      await run.emit(nestedOnlyCompactionPart())
      await run.emit({type: 'session.idle', properties: {sessionID: ROOT}})

      // #then
      expect(run.outcome()).toEqual({ok: true})
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

    it('fails the run on an abort the gateway did not cause (session.error, then idle)', async () => {
      // #given — another client called POST /session/:id/abort; no gateway signal has fired
      const run = startRun()

      // #when — upstream publishes session.error(MessageAbortedError) and then session.idle
      await run.emit(sessionError({name: 'MessageAbortedError', data: {message: 'Aborted'}}))

      // #then — failed, not completed with partial output
      expectFailed(run, 'Provider failure: session error')
      expect(vi.mocked(run.logger.error)).toHaveBeenCalledWith(
        {sessionId: ROOT, source: 'session.error', errorName: 'MessageAbortedError', reason: 'session error'},
        expect.any(String),
      )
    })

    it('leaves a gateway-caused abort to the cancel path', async () => {
      // #given
      const controller = new AbortController()
      const run = startRun({controller})

      // #when — the gateway aborts, then the abort events upstream publishes for it arrive
      controller.abort()
      await run.emit(sessionError({name: 'MessageAbortedError', data: {message: 'Aborted'}}))
      await run.emit({type: 'session.idle', properties: {sessionID: ROOT}})

      // #then — the existing signal path reports it; no provider failure
      const outcome = run.outcome()
      expect(outcome?.ok).toBe(false)
      expect((outcome as {error: RunCoreError}).error.kind).toBe('timeout')
      expect(loggedText(run.logger)).not.toContain('provider rejected the request')
    })

    it('fails the run on an external abort carried by an assistant message.updated', async () => {
      // #given
      const run = startRun()

      // #when
      await run.emit(assistantMessage({name: 'MessageAbortedError', data: {message: 'Aborted'}}))

      // #then
      expectFailed(run, 'Provider failure: session error')
      expect(vi.mocked(run.logger.error)).toHaveBeenCalledWith(
        {sessionId: ROOT, source: 'message.updated', errorName: 'MessageAbortedError', reason: 'session error'},
        expect.any(String),
      )
    })

    it('completes when compaction follows a ContextOverflowError session.error (compaction on)', async () => {
      // #given
      const run = startRun()

      // #when — overflow is published; the errored-looking assistant message is closed out (no error set while
      // compacting); compaction.create writes the root compaction part; the root then goes idle
      await run.emit(sessionError({name: 'ContextOverflowError', data: {message: SECRET}}))
      expect(run.outcome()).toBeUndefined()
      await run.emit(assistantMessage(undefined))
      await run.emit(compactionPart())
      await run.emit({type: 'session.idle', properties: {sessionID: ROOT}})

      // #then
      expect(run.outcome()).toEqual({ok: true})
      expect(vi.mocked(run.logger.error)).not.toHaveBeenCalled()
    })

    it('fails at root idle when no compaction followed a ContextOverflowError (compaction off)', async () => {
      // #given
      const run = startRun()

      // #when — upstream order with compaction off: session.error, session.idle, then message.updated
      await run.emit(sessionError({name: 'ContextOverflowError', data: {message: SECRET}}))
      expect(run.outcome()).toBeUndefined()
      await run.emit({type: 'session.idle', properties: {sessionID: ROOT}})

      // #then — failed with the closed reason, name and source; nothing raw logged
      expectFailed(run, 'Provider failure: session error')
      expect(vi.mocked(run.logger.error)).toHaveBeenCalledWith(
        {sessionId: ROOT, source: 'session.idle', errorName: 'ContextOverflowError', reason: 'session error'},
        expect.any(String),
      )
      expect(loggedText(run.logger)).not.toContain('SECRET')
    })

    it('does not let a compaction part from another session clear the overflow', async () => {
      // #given
      const run = startRun({owned: [CHILD]})

      // #when
      await run.emit(sessionError({name: 'ContextOverflowError', data: {message: 'x'}}))
      await run.emit(compactionPart(CHILD))
      await run.emit({type: 'session.idle', properties: {sessionID: ROOT}})

      // #then
      expectFailed(run, 'Provider failure: session error')
    })

    it('fails the run when an owned child overflows and goes idle uncompacted (compaction off)', async () => {
      // #given
      const run = startRun({owned: [CHILD]})

      // #when — the child's output is lost; the root has not gone idle
      await run.emit(sessionError({name: 'ContextOverflowError', data: {message: SECRET}}, CHILD))
      expect(run.outcome()).toBeUndefined()
      await run.emit({type: 'session.idle', properties: {sessionID: CHILD}})

      // #then
      expectFailed(run, 'Provider failure: session error')
      expect(vi.mocked(run.logger.error)).toHaveBeenCalledWith(
        {sessionId: ROOT, source: 'session.idle', errorName: 'ContextOverflowError', reason: 'session error'},
        expect.any(String),
      )
      expect(loggedText(run.logger)).not.toContain('SECRET')
    })

    it('lets an owned child recover through its own compaction (compaction on)', async () => {
      // #given
      const run = startRun({owned: [CHILD]})

      // #when
      await run.emit(sessionError({name: 'ContextOverflowError', data: {message: 'x'}}, CHILD))
      await run.emit(compactionPart(CHILD))
      await run.emit({type: 'session.idle', properties: {sessionID: CHILD}})
      await run.emit({type: 'session.idle', properties: {sessionID: ROOT}})

      // #then
      expect(run.outcome()).toEqual({ok: true})
    })

    it('re-arms on a second overflow after a compaction', async () => {
      // #given
      const run = startRun()

      // #when — overflow, compaction, a second overflow, then idle with no second compaction
      await run.emit(sessionError({name: 'ContextOverflowError', data: {message: 'x'}}))
      await run.emit(compactionPart())
      await run.emit(sessionError({name: 'ContextOverflowError', data: {message: 'x'}}))
      expect(run.outcome()).toBeUndefined()
      await run.emit({type: 'session.idle', properties: {sessionID: ROOT}})

      // #then
      expectFailed(run, 'Provider failure: session error')
    })

    it('treats an overflow with no session id as the root', async () => {
      // #given
      const run = startRun()

      // #when
      await run.emit({type: 'session.error', properties: {error: {name: 'ContextOverflowError', data: {message: 'x'}}}})
      expect(run.outcome()).toBeUndefined()
      await run.emit({type: 'session.idle', properties: {sessionID: ROOT}})

      // #then
      expectFailed(run, 'Provider failure: session error')
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

function errorOf(run: Run): RunCoreError {
  const outcome = run.outcome()
  expect(outcome?.ok).toBe(false)
  return (outcome as {error: RunCoreError}).error
}

describe('runOpenCodeCore — typed providerFailureReason on RunCoreError (contract 1.12.0)', () => {
  const authRetry = retryStatus({
    action: {reason: 'auth_unavailable', provider: 'p', title: 't', message: 'm', label: 'l'},
  })

  it.each([
    [
      'a ProviderAuthError',
      assistantMessage({name: 'ProviderAuthError', data: {message: 'x'}}),
      'provider auth unavailable',
    ],
    [
      'an unsupported-model APIError',
      assistantMessage({name: 'APIError', data: {message: 'model is not supported', isRetryable: false}}),
      'model not available',
    ],
    [
      'a rejected-request APIError',
      assistantMessage({name: 'APIError', data: {message: 'bad', statusCode: 400, isRetryable: false}}),
      'model provider rejected the request',
    ],
    ['a payload with no error', {type: 'session.error', properties: {sessionID: ROOT}}, 'session error'],
  ] as const)(
    'carries the internal reason for %s as a typed property (barrier fast path)',
    async (_label, event, reason) => {
      // #given
      const run = startRun()

      // #when
      await run.emit(event)

      // #then — the typed property, not just the message, names the reason
      const error = errorOf(run)
      expect(error.kind).toBe('session-error')
      expect(error.quarantined).toBe(false)
      expect(error.providerFailureReason).toBe(reason)
    },
  )

  it('carries the reason on the settled-after-abort throw site (a retry status stops the live root first)', async () => {
    // #given — a retry mid-backoff takes the settlement path, not the fast path
    const run = startRun({ownershipLedger: createOwnershipLedger()})

    // #when
    await run.emit(authRetry)

    // #then
    const error = errorOf(run)
    expect(run.abort).toHaveBeenCalledTimes(1)
    expect(error.quarantined).toBe(false)
    expect(error.providerFailureReason).toBe('provider auth unavailable')
  })

  it('carries the reason on the QUARANTINED throw site', async () => {
    // #given — the root stays live after the abort, so the barrier quarantines
    const run = startRun({live: {[ROOT]: {type: 'retry'}}})

    // #when
    await run.emit(authRetry)
    await vi.advanceTimersByTimeAsync(20_000)

    // #then
    const error = errorOf(run)
    expect(error.quarantined).toBe(true)
    expect(error.providerFailureReason).toBe('provider auth unavailable')
  })

  it('leaves the property absent on a non-provider failure', async () => {
    // #given — a transient retry, then silence for the whole window
    const run = startRun()

    // #when
    await run.emit(retryStatus({message: 'Too Many Requests'}))
    await vi.advanceTimersByTimeAsync(WINDOW + PROMPT_SECONDS)

    // #then
    const error = errorOf(run)
    expect(error.kind).toBe('inactivity-timeout')
    expect(error.providerFailureReason).toBeUndefined()
  })
})

describe('runOpenCodeCore — provider quota stops the run (shared classifier)', () => {
  const quotaRetry = retryStatus({
    action: {reason: 'account_rate_limit', provider: 'p', title: 't', message: SECRET, label: 'l'},
  })

  it('a quota retry stops the run, aborts the live root first, and carries the quota reason', async () => {
    // #given — OpenCode is mid-retry on an account rate limit, so the root is live
    const run = startRun({ownershipLedger: createOwnershipLedger()})

    // #when
    await run.emit(quotaRetry)

    // #then — it no longer waits out the retry budget: the root is torn down and the run fails with the quota reason
    expect(run.abort).toHaveBeenCalledTimes(1)
    expect(run.abort).toHaveBeenCalledWith(expect.objectContaining({path: {id: ROOT}}))
    const error = errorOf(run)
    expect(error.kind).toBe('session-error')
    expect(error.message).toBe('Provider failure: provider quota exceeded')
    expect(error.quarantined).toBe(false)
    expect(error.providerFailureReason).toBe('provider quota exceeded')
  })

  it('fails long before the inactivity window instead of waiting', async () => {
    // #given
    const run = startRun()

    // #when — one retry status, no time passing
    await run.emit(quotaRetry)

    // #then
    expect(errorOf(run).providerFailureReason).toBe('provider quota exceeded')
  })

  it('quarantines the run when the root is still live after a quota retry, keeping the reason', async () => {
    // #given — the directory's live set keeps reporting the root after the abort
    const run = startRun({live: {[ROOT]: {type: 'retry'}}})

    // #when — the bounded teardown budget runs out
    await run.emit(quotaRetry)
    await vi.advanceTimersByTimeAsync(20_000)

    // #then — same reason, with quarantine as extra evidence
    const error = errorOf(run)
    expect(error.kind).toBe('session-error')
    expect(error.message).toBe('Provider failure: provider quota exceeded')
    expect(error.quarantined).toBe(true)
    expect(error.providerFailureReason).toBe('provider quota exceeded')
  })

  it.each([
    ['a 402 status', {name: 'APIError', data: {message: SECRET, statusCode: 402, isRetryable: false}}],
    ['the insufficient_quota code', {name: 'APIError', data: {message: SECRET, code: 'insufficient_quota'}}],
    ['the usage_not_included code', {name: 'APIError', code: 'usage_not_included', data: {message: SECRET}}],
    [
      'usage-limit text',
      {name: 'APIError', data: {message: `Usage limit reached. Enable usage from your available balance ${SECRET}`}},
    ],
  ])('a session.error with %s is labelled quota, not "session error"', async (_label, error) => {
    // #given
    const run = startRun()

    // #when
    await run.emit(sessionError(error))

    // #then — it fails the run as it always did; only the label changes
    expectFailed(run, 'Provider failure: provider quota exceeded')
    expect(errorOf(run).providerFailureReason).toBe('provider quota exceeded')
  })

  it('an assistant message with a structured quota error is labelled quota', async () => {
    // #given
    const run = startRun()

    // #when
    await run.emit(assistantMessage({name: 'APIError', data: {message: SECRET, statusCode: 402}}))

    // #then
    expect(errorOf(run).providerFailureReason).toBe('provider quota exceeded')
  })

  it('a plain 429 is not quota: it stays a rejected request, never the quota label', async () => {
    // #given
    const run = startRun()

    // #when
    await run.emit(sessionError({name: 'APIError', data: {message: 'Too Many Requests', statusCode: 429}}))

    // #then
    expect(errorOf(run).providerFailureReason).toBe('model provider rejected the request')
  })

  it('logs only the allowlisted error name and the reason for a quota failure', async () => {
    // #given
    const run = startRun()

    // #when
    await run.emit(sessionError({name: 'APIError', data: {message: `Usage limit reached ${SECRET}`, statusCode: 402}}))

    // #then
    expect(loggedText(run.logger)).not.toContain('SECRET')
    expect(loggedText(run.logger)).toContain('"errorName":"APIError"')
    expect(loggedText(run.logger)).toContain('"reason":"provider quota exceeded"')
  })

  it('a transient retry still keeps waiting', async () => {
    // #given
    const run = startRun()

    // #when — a plain 429 retry with no structured quota action
    await run.emit(retryStatus({message: 'Too Many Requests'}))
    await vi.advanceTimersByTimeAsync(WINDOW / 2)

    // #then
    expect(run.outcome()).toBeUndefined()
  })
})
