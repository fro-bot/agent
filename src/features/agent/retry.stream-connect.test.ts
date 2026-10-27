/**
 * The prompt waits for the event stream to be live.
 *
 * `client.event.subscribe()` sends no request until the first `next()`, and OpenCode replays nothing to a late
 * connection. The server registers its listener before it emits `server.connected`, so once the Action's event
 * processor has read that frame, nothing published later can be missed. `runPromptAttempt` therefore waits for the
 * processor to report it (bounded, and only when it is about to submit a new prompt) before it captures the message
 * baseline and calls `startPrompt`.
 */
import type {Event} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
import type {ExecutionDeadline, PromptStartResult} from './retry.js'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {createExecutionDeadline, EVENT_STREAM_CONNECT_TIMEOUT_MS, runPromptAttempt} from './retry.js'

// v2 wait is unavailable, so completion detection falls back to the stream/poll path under test.
vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: vi.fn().mockReturnValue({
    v2: {session: {wait: vi.fn().mockRejectedValue(new Error('v2 not available in test'))}},
  }),
}))

const SESSION = 'ses_123'
/** Longer than the event processor's bounded shutdown, so cleanup on the fake clock completes. */
const SHUTDOWN_WINDOW_MS = 30_000

/** Real-timer pause: lets the stream, the baseline read and the poll watchdog take their turns. */
const tick = async (ms = 15): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const connected = (): Event => ({type: 'server.connected', properties: {}}) as unknown as Event
const idle = (): Event => ({type: 'session.idle', properties: {sessionID: SESSION}}) as unknown as Event
const delta = (text: string): Event =>
  ({type: 'message.part.delta', properties: {sessionID: SESSION, delta: {type: 'text', text}}}) as unknown as Event
const sessionError = (): Event =>
  ({
    type: 'session.error',
    properties: {sessionID: SESSION, error: {name: 'UnknownError', data: {message: 'boom'}}},
  }) as unknown as Event
const permissionAsked = (): Event =>
  ({
    type: 'permission.asked',
    properties: {id: 'perm-1', sessionID: SESSION, permission: 'bash', patterns: [], always: [], tool: undefined},
  }) as unknown as Event

function stubDeadline(remainingMs: number, signal: AbortSignal): ExecutionDeadline {
  return {
    timeoutMs: remainingMs,
    signal,
    isExpired: () => false,
    isTimedOut: () => false,
    remainingMs: () => remainingMs,
    run: async operation => operation(),
    dispose: vi.fn(),
  }
}

/** A stream the test feeds by hand, counting how many iterators were taken from it. */
function makeControlledStream() {
  const queue: Event[] = []
  let closed = false
  let wake: (() => void) | null = null
  let iterators = 0
  const stream: AsyncIterable<Event> = {
    [Symbol.asyncIterator]() {
      iterators += 1
      return {
        async next(): Promise<IteratorResult<Event>> {
          while (true) {
            const next = queue.shift()
            if (next !== undefined) return {done: false, value: next}
            if (closed) return {done: true, value: undefined}
            await new Promise<void>(resolve => {
              wake = resolve
            })
          }
        },
        async return(): Promise<IteratorResult<Event>> {
          return {done: true, value: undefined}
        },
      }
    },
  }
  const resume = (): void => {
    const fn = wake
    wake = null
    fn?.()
  }
  return {
    stream,
    emit: (event: Event) => {
      queue.push(event)
      resume()
    },
    close: () => {
      closed = true
      resume()
    },
    iterators: () => iterators,
  }
}

interface Harness {
  readonly order: string[]
  readonly startPrompt: ReturnType<typeof vi.fn>
  readonly messages: ReturnType<typeof vi.fn>
  readonly subscribe: ReturnType<typeof vi.fn>
  readonly client: Parameters<typeof runPromptAttempt>[0]
}

function makeHarness(startResult: PromptStartResult = null): Harness {
  const order: string[] = []
  const messages = vi.fn(async () => {
    order.push('baseline')
    return {data: []}
  })
  const subscribe = vi.fn()
  const startPrompt = vi.fn(async () => {
    order.push('prompt')
    return startResult
  })
  const client = {
    session: {messages, status: vi.fn().mockResolvedValue({data: {[SESSION]: {type: 'busy'}}})},
    event: {subscribe},
  } as unknown as Parameters<typeof runPromptAttempt>[0]
  return {order, startPrompt, messages, subscribe, client}
}

async function run(
  harness: Harness,
  stream: AsyncIterable<Event>,
  options: {
    readonly logger?: Logger
    readonly deadline?: ExecutionDeadline
    readonly onPermissionAsked?: Parameters<typeof runPromptAttempt>[10]
    readonly timeoutMs?: number
    readonly attemptAbortController?: AbortController
  } = {},
) {
  return runPromptAttempt(
    harness.client,
    SESSION,
    '/workspace',
    options.timeoutMs ?? 400,
    options.logger ?? createMockLogger(),
    stream,
    undefined,
    harness.startPrompt as unknown as Parameters<typeof runPromptAttempt>[7],
    options.deadline,
    options.attemptAbortController,
    options.onPermissionAsked,
  )
}

describe('runPromptAttempt — the prompt waits for the event stream to connect', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('captures the baseline and sends the prompt only after server.connected, in that order', async () => {
    // #given a stream that has not announced itself
    const harness = makeHarness()
    const fed = makeControlledStream()
    const attempt = run(harness, fed.stream)

    // #when time passes without the announcement
    await tick(40)

    // #then nothing was sent, not even the baseline read
    expect(harness.startPrompt).not.toHaveBeenCalled()
    expect(harness.messages).not.toHaveBeenCalled()

    // #when the stream connects late
    fed.emit(connected())
    await tick(15)

    // #then the baseline is read and the prompt follows, once
    expect(harness.order).toEqual(['baseline', 'prompt'])
    expect(harness.startPrompt).toHaveBeenCalledOnce()

    // #when the turn then completes on the same stream
    fed.emit(delta('hello'))
    fed.emit(idle())
    await tick(40)
    const result = await attempt

    // #then
    expect(result.success).toBe(true)
  })

  it('consumes the one stream it was given exactly once, and never subscribes again', async () => {
    // #given
    const harness = makeHarness()
    const fed = makeControlledStream()
    const attempt = run(harness, fed.stream)

    // #when
    fed.emit(connected())
    await tick(15)
    fed.emit(delta('hi'))
    fed.emit(idle())
    await tick(40)
    await attempt

    // #then
    expect(fed.iterators()).toBe(1)
    expect(harness.subscribe).not.toHaveBeenCalled()
  })

  it('answers a permission ask that arrives immediately after server.connected, before the turn is armed', async () => {
    // #given the ask is queued right behind the announcement
    const harness = makeHarness()
    const fed = makeControlledStream()
    const onPermissionAsked = vi.fn(async () => undefined)
    const attempt = run(harness, fed.stream, {onPermissionAsked})

    // #when
    fed.emit(connected())
    fed.emit(permissionAsked())
    await tick(15)

    // #then the ask was handled (it runs ahead of the arming guard), and the prompt still went out
    expect(onPermissionAsked).toHaveBeenCalledOnce()
    expect(harness.order).toEqual(['baseline', 'prompt'])

    fed.emit(idle())
    await tick(40)
    await attempt
  })

  it('processes output, a root idle and a session error that follow the prompt on the same stream', async () => {
    // #given a run that connected and sent its prompt
    const harness = makeHarness()
    const fed = makeControlledStream()
    const attempt = run(harness, fed.stream)
    fed.emit(connected())
    await tick(15)
    expect(harness.startPrompt).toHaveBeenCalledOnce()

    // #when the turn fails right behind the prompt
    fed.emit(delta('partial'))
    fed.emit(sessionError())
    await tick(40)
    const result = await attempt

    // #then the failure on the shared stream was seen
    expect(result.success).toBe(false)
  })

  describe('a stream that does not connect fails before any prompt', () => {
    it('ends before server.connected', async () => {
      // #given
      const harness = makeHarness()
      const fed = makeControlledStream()
      const attempt = run(harness, fed.stream)

      // #when the stream ends without announcing itself
      fed.close()
      await tick(15)
      const result = await attempt

      // #then the pre-prompt failure shape, with nothing sent
      expect(result.success).toBe(false)
      expect(result.outcome).toBe('submit_failed')
      expect(result.settlement).toEqual({kind: 'failure-observed'})
      expect(result.error).toContain('Event stream')
      // nothing was sent, and the failure is a transient transport one: the retry loop may resend the original prompt
      expect(result.llmError?.retryable).toBe(true)
      expect(harness.startPrompt).not.toHaveBeenCalled()
      expect(harness.messages).not.toHaveBeenCalled()
    })

    it('keeps the error that ended the stream, in the result and in a warning that carries only its name and message', async () => {
      // #given a stream whose first read fails
      const harness = makeHarness()
      const logger = createMockLogger()
      const failing: AsyncIterable<Event> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            const error = new TypeError('socket hang up')
            throw error
          },
        }),
      }

      // #when
      const result = await run(harness, failing, {logger})

      // #then the cause rides in the message, and the warning has exactly its name and message, not the error object
      expect(result.success).toBe(false)
      expect(result.error).toContain('TypeError: socket hang up')
      expect(harness.startPrompt).not.toHaveBeenCalled()
      expect(logger.warning).toHaveBeenCalledWith(
        'Event stream did not connect before the prompt',
        expect.objectContaining({reason: 'stream-ended', errorName: 'TypeError', errorMessage: 'socket hang up'}),
      )
      const context = vi.mocked(logger.warning).mock.calls.at(-1)?.[1] as Record<string, unknown>
      expect(Object.keys(context).sort()).toEqual(['errorMessage', 'errorName', 'reason', 'sessionId'])
    })

    it('stays silent for the barrier bound', async () => {
      vi.useFakeTimers()
      // #given
      const harness = makeHarness()
      const fed = makeControlledStream()
      const attempt = run(harness, fed.stream)

      // #when the bound passes less one millisecond, then the last one
      await vi.advanceTimersByTimeAsync(EVENT_STREAM_CONNECT_TIMEOUT_MS - 1)
      expect(harness.startPrompt).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      // the bounded event-processor cleanup then runs against the fake clock too
      await vi.advanceTimersByTimeAsync(SHUTDOWN_WINDOW_MS)
      const result = await attempt

      // #then
      expect(result.success).toBe(false)
      expect(result.outcome).toBe('submit_failed')
      expect(result.error).toContain('within 10s')
      expect(result.llmError?.retryable).toBe(true)
      expect(harness.startPrompt).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('opens with a frame that is not server.connected', async () => {
      vi.useFakeTimers()
      // #given
      const harness = makeHarness()
      const fed = makeControlledStream()
      const attempt = run(harness, fed.stream)

      // #when a stray frame arrives and nothing else does
      fed.emit(delta('too early'))
      await vi.advanceTimersByTimeAsync(EVENT_STREAM_CONNECT_TIMEOUT_MS + SHUTDOWN_WINDOW_MS)
      const result = await attempt

      // #then the stray frame is not mistaken for the announcement
      expect(result.success).toBe(false)
      expect(harness.startPrompt).not.toHaveBeenCalled()
    })
  })

  describe('the deadline bounds the wait', () => {
    it('rejects as a deadline expiry when the run deadline passes before the stream connects', async () => {
      vi.useFakeTimers()
      // #given a deadline shorter than the barrier bound
      const harness = makeHarness()
      const fed = makeControlledStream()
      const deadline = createExecutionDeadline(3_000, createMockLogger())
      const attempt = run(harness, fed.stream, {deadline})
      const settled = attempt.then(
        () => 'resolved',
        (error: unknown) => (error as Error).name,
      )

      // #when
      await vi.advanceTimersByTimeAsync(3_000 + SHUTDOWN_WINDOW_MS)

      // #then the wait ended with the deadline, not with the 10 s bound, and nothing was sent
      expect(await settled).toBe('DeadlineExceededError')
      expect(harness.startPrompt).not.toHaveBeenCalled()
      deadline.dispose()
    })
  })

  describe('the wait is clipped to the time the run has left', () => {
    it('ends the wait at the remaining time as a deadline expiry, not a connect failure, when that is shorter than the bound', async () => {
      // #given 2 s left on the clock (its signal has not fired yet) and a stream that never connects
      vi.useFakeTimers()
      const harness = makeHarness()
      const fed = makeControlledStream()
      const attempt = run(harness, fed.stream, {deadline: stubDeadline(2_000, new AbortController().signal)})
      let settledAt: number | undefined
      const settled = attempt.then(
        () => 'resolved',
        (error: unknown) => {
          settledAt = Date.now()
          return (error as Error).name
        },
      )
      const startedAt = Date.now()

      // #when 2 s pass, and the bounded event-processor cleanup (2 s) runs
      await vi.advanceTimersByTimeAsync(2_000 + 2_100)

      // #then it ended there as a deadline expiry, not at the 10 s bound and not as a retryable connect failure
      expect(await settled).toBe('DeadlineExceededError')
      expect((settledAt ?? Number.POSITIVE_INFINITY) - startedAt).toBeLessThan(EVENT_STREAM_CONNECT_TIMEOUT_MS)
      expect(harness.startPrompt).not.toHaveBeenCalled()
    })

    it('treats a deadline with no time left as expired at once, even though its signal has not fired', async () => {
      // #given
      vi.useFakeTimers()
      const harness = makeHarness()
      const fed = makeControlledStream()
      fed.emit(connected())

      // #when / #then
      const attempt = run(harness, fed.stream, {deadline: stubDeadline(0, new AbortController().signal)})
      const settled = attempt.then(
        () => 'resolved',
        (error: unknown) => (error as Error).name,
      )
      await vi.advanceTimersByTimeAsync(SHUTDOWN_WINDOW_MS)
      expect(await settled).toBe('DeadlineExceededError')
      expect(harness.startPrompt).not.toHaveBeenCalled()
      expect(harness.messages).not.toHaveBeenCalled()
    })

    it('settles at once, without arming a timer, when the attempt was already cancelled', async () => {
      // #given an attempt controller aborted before the wait
      vi.useFakeTimers()
      const harness = makeHarness()
      const fed = makeControlledStream()
      const cancelled = new AbortController()
      cancelled.abort()

      // #when
      const attempt = run(harness, fed.stream, {attemptAbortController: cancelled})
      // (only the bounded event-processor cleanup, 2 s, is left to run: far short of the 10 s bound)
      await vi.advanceTimersByTimeAsync(2_100)
      const result = await attempt

      // #then it did not wait for the 10 s bound
      expect(result.success).toBe(false)
      expect(harness.startPrompt).not.toHaveBeenCalled()
    })

    it('rejects at once when the deadline had already fired, without reading the baseline or sending the prompt', async () => {
      // #given a deadline that expired before the attempt reached the wait, and a stream that is connected
      vi.useFakeTimers()
      const harness = makeHarness()
      const fed = makeControlledStream()
      fed.emit(connected())
      const fired = new AbortController()
      fired.abort()

      // #when / #then
      const attempt = run(harness, fed.stream, {deadline: stubDeadline(0, fired.signal)})
      const settled = attempt.then(
        () => 'resolved',
        (error: unknown) => (error as Error).name,
      )
      await vi.advanceTimersByTimeAsync(SHUTDOWN_WINDOW_MS)
      expect(await settled).toBe('DeadlineExceededError')
      expect(harness.startPrompt).not.toHaveBeenCalled()
      expect(harness.messages).not.toHaveBeenCalled()
    })
  })

  it('leaves no timer behind once the stream connected and the attempt ended', async () => {
    // #given a stream that connects at once and a prompt start that fails (an early exit)
    vi.useFakeTimers()
    const harness = makeHarness({
      success: false,
      error: 'prompt submission failed: 503',
      llmError: null,
      outcome: 'submit_failed',
      shouldRetry: false,
      settlement: {kind: 'failure-observed'},
      eventStreamResult: {
        tokens: null,
        model: null,
        cost: null,
        prsCreated: [],
        commitsCreated: [],
        commentsPosted: 0,
        llmError: null,
      },
    })
    const fed = makeControlledStream()
    fed.emit(connected())

    // #when
    const attempt = run(harness, fed.stream)
    // (less than the 10 s bound, so a timer the barrier forgot to clear would still be pending)
    await vi.advanceTimersByTimeAsync(3_000)
    await attempt

    // #then the barrier's timer was cleared with the rest
    expect(harness.startPrompt).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not wait when there is no prompt to send', async () => {
    // #given a resumed attempt: no startPrompt, and a stream that never announces itself
    const fed = makeControlledStream()
    const client = {
      session: {status: vi.fn().mockResolvedValue({data: {[SESSION]: {type: 'busy'}}})},
    } as unknown as Parameters<typeof runPromptAttempt>[0]
    const attempt = runPromptAttempt(client, SESSION, '/workspace', 400, createMockLogger(), fed.stream)

    // #when the turn completes without any announcement
    fed.emit(idle())
    await tick(40)
    const result = await attempt

    // #then it behaves as before: no barrier
    expect(result.success).toBe(true)
  })
})
