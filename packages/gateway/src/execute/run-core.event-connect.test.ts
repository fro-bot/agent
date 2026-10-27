/**
 * The prompt waits for the event stream to be live.
 *
 * `event.subscribe()` sends no request until the first `next()`, and OpenCode replays nothing to a late
 * connection, so a prompt sent before the stream connected could have its permission asks, output, idle and errors
 * lost. The server registers its listener before it emits `server.connected`, so reading that frame is proof the
 * stream is live. `runOpenCodeCore` therefore takes ONE iterator, reads its first frame under a bound, requires
 * `server.connected`, sends the prompt, and goes on consuming the same iterator (the connected frame included).
 *
 * Drives the real `runOpenCodeCore` with a controlled stream and fake timers; the SDK-level cases use the real
 * `createSseClient` with only `fetch` stubbed.
 */

import type {OpenCodeServerHandle} from '@fro-bot/runtime'
import type {PermissionCoordinator} from '../approvals/coordinator.js'
import type {GatewayLogger} from '../discord/client.js'
import type {DiscordStreamSink} from '../discord/streaming.js'
import type {RunCoreError} from './run-core.js'
import {getEventListeners} from 'node:events'
import {createOwnershipLedger, createRemoteOpenCodeHandle} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {awaitFirstEvent, EVENT_STREAM_CONNECT_TIMEOUT_MS, runOpenCodeCore} from './run-core.js'

const ROOT = 'sess-123'
const DIRECTORY = '/workspace/repo'
const BASE_URL = 'http://workspace:9200'
const PAST_SETTLE_BOUND_MS = 20_000

const connected = (): object => ({type: 'server.connected', properties: {}})
const idle = (): object => ({type: 'session.idle', properties: {sessionID: ROOT}})
const textDelta = (text: string): object => ({
  type: 'message.part.delta',
  properties: {sessionID: ROOT, partID: 'part-1', delta: {type: 'text', text}, field: 'text'},
})
const sessionError = (): object => ({type: 'session.error', properties: {sessionID: ROOT, error: 'boom'}})
const permissionAsked = (requestID: string): object => ({
  type: 'permission.asked',
  properties: {id: requestID, sessionID: ROOT, permission: 'bash', patterns: [], tool: 'bash'},
})

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeSink() {
  const append = vi.fn<(text: string) => void>()
  const sink: DiscordStreamSink = {
    append,
    flush: vi.fn().mockResolvedValue({kind: 'sent', charCount: 0}),
    buffered: () => '',
    markVisibleOutputSent: vi.fn(),
    markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
    hasVisibleOutput: vi.fn().mockReturnValue(false),
  }
  return {sink, append}
}

function makeCoordinator(): PermissionCoordinator {
  const owned = new Set<string>()
  return {
    onPermissionAsked: vi.fn().mockResolvedValue('once'),
    onPermissionReplied: vi.fn(),
    pending: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
    addOwnedSession: vi.fn((id: string) => {
      owned.add(id)
    }),
    isOwned: vi.fn((id: string) => owned.has(id)),
  }
}

type Outcome = {readonly ok: true} | {readonly ok: false; readonly error: RunCoreError}

interface StartOptions {
  readonly controller?: AbortController
  /** The run's own deadline: its signal aborts after this long. */
  readonly deadlineMs?: number
  readonly events?: readonly object[]
  readonly close?: boolean
  readonly ownershipLedger?: ReturnType<typeof createOwnershipLedger>
}

/** A run over a controlled stream: tests decide when each frame (and the end of the stream) arrives. */
function startRun(options: StartOptions = {}) {
  vi.useFakeTimers()
  const controller = options.controller ?? new AbortController()
  if (options.deadlineMs !== undefined) setTimeout(() => controller.abort(), options.deadlineMs)
  const queue: object[] = [...(options.events ?? [])]
  let closed = options.close === true
  let wake: (() => void) | null = null
  let streamCreated = 0
  let iteratorsTaken = 0
  /** What happened, in order: the frames the loop read and the prompt. */
  const order: string[] = []

  const stream: AsyncIterable<object> = {
    [Symbol.asyncIterator]() {
      iteratorsTaken += 1
      return {
        async next(): Promise<IteratorResult<object>> {
          while (true) {
            const next = queue.shift()
            if (next !== undefined) return {done: false, value: next}
            if (closed) return {done: true, value: undefined}
            await new Promise<void>(resolve => {
              wake = resolve
            })
          }
        },
        async return(): Promise<IteratorResult<object>> {
          return {done: true, value: undefined}
        },
      }
    },
  }
  const wakeStream = (): void => {
    const resume = wake
    wake = null
    resume?.()
  }

  const subscribe = vi.fn(async () => {
    streamCreated += 1
    return {stream}
  })
  const abort = vi.fn(async () => ({data: {}, error: null}))
  const promptAsync = vi.fn(async () => {
    order.push('prompt')
    return {data: {}, error: null}
  })
  const client = {
    session: {
      create: vi.fn().mockResolvedValue({data: {id: ROOT}, error: null}),
      messages: vi.fn().mockResolvedValue({data: [], error: null}),
      promptAsync,
      children: vi.fn().mockResolvedValue({data: [], error: null}),
      status: vi.fn().mockResolvedValue({data: {}, error: null}),
      abort,
    },
    event: {subscribe},
    postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({error: null}),
  }
  const handle = {
    client,
    server: {url: BASE_URL, close: vi.fn()},
    shutdown: vi.fn(),
  } as unknown as OpenCodeServerHandle

  const logger = makeLogger()
  const coordinator = makeCoordinator()
  const {sink, append} = makeSink()
  let settled: Outcome | undefined
  // eslint-disable-next-line no-void
  void runOpenCodeCore({
    handle,
    directory: DIRECTORY,
    promptText: 'Fix the bug please',
    sink,
    signal: controller.signal,
    logger,
    coordinator,
    ...(options.ownershipLedger === undefined ? {} : {ownershipLedger: options.ownershipLedger}),
  }).then(
    () => {
      settled = {ok: true}
    },
    (error: unknown) => {
      settled = {ok: false, error: error as RunCoreError}
    },
  )

  return {
    outcome: () => settled,
    emit: (event: object) => {
      order.push(`frame:${(event as {type: string}).type}`)
      queue.push(event)
      wakeStream()
    },
    close: () => {
      closed = true
      wakeStream()
    },
    subscribe,
    promptAsync,
    abort,
    logger,
    coordinator,
    append,
    order,
    streamsCreated: () => streamCreated,
    iteratorsTaken: () => iteratorsTaken,
    subscribeSignal: () => (subscribe.mock.calls[0] as unknown as [{signal: AbortSignal}])[0].signal,
  }
}

function failure(run: {readonly outcome: () => Outcome | undefined}): RunCoreError {
  const outcome = run.outcome()
  if (outcome === undefined || outcome.ok === true) {
    throw new Error(`expected the run to have failed, got ${outcome === undefined ? 'still running' : 'success'}`)
  }
  return outcome.error
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A handle whose `/event` stream is `stream`; session calls are doubles. */
function makeHandleWithStream(stream: AsyncIterable<unknown>) {
  const abort = vi.fn(async () => ({data: {}, error: null}))
  const promptAsync = vi.fn(async () => ({data: {}, error: null}))
  const handle = {
    client: {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: ROOT}, error: null}),
        messages: vi.fn().mockResolvedValue({data: [], error: null}),
        promptAsync,
        children: vi.fn().mockResolvedValue({data: [], error: null}),
        status: vi.fn().mockResolvedValue({data: {}, error: null}),
        abort,
      },
      event: {subscribe: vi.fn(async () => ({stream}))},
      postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({error: null}),
    },
    server: {url: BASE_URL, close: vi.fn()},
    shutdown: vi.fn(),
  } as unknown as OpenCodeServerHandle
  return {handle, abort, promptAsync}
}

/** Starts a run over `handle` and exposes its settled outcome. */
function settleRun(handle: OpenCodeServerHandle): {current: Outcome | undefined} {
  const outcome: {current: Outcome | undefined} = {current: undefined}
  // eslint-disable-next-line no-void
  void runOpenCodeCore({
    handle,
    directory: DIRECTORY,
    promptText: 'Fix the bug please',
    sink: makeSink().sink,
    signal: new AbortController().signal,
    logger: makeLogger(),
    coordinator: makeCoordinator(),
  }).then(
    () => {
      outcome.current = {ok: true}
    },
    (error: unknown) => {
      outcome.current = {ok: false, error: error as RunCoreError}
    },
  )
  return outcome
}

function sseResponse(frames: readonly object[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
        controller.close()
      },
    }),
    {status: 200, headers: {'content-type': 'text/event-stream'}},
  )
}

/** A run whose session calls are doubles and whose `/event` subscription is the real SDK client. */
function startRealClientRun() {
  const remote = createRemoteOpenCodeHandle(BASE_URL)
  const harness = makeHandleWithStream(undefined as never)
  const handle = {
    ...harness.handle,
    client: {...harness.handle.client, event: remote.client.event},
  } as unknown as OpenCodeServerHandle
  const outcome = settleRun(handle)
  return {outcome: () => outcome.current, promptAsync: harness.promptAsync, abort: harness.abort}
}

const eventCalls = (fetchStub: ReturnType<typeof vi.fn>): readonly unknown[][] =>
  fetchStub.mock.calls.filter(call => new URL(String(call[0])).pathname === '/event')

describe('runOpenCodeCore — the prompt waits for the event stream to connect', () => {
  it('sends no prompt until server.connected has been read, then sends exactly one', async () => {
    // #given a stream that has not announced itself
    const run = startRun()

    // #when time passes without a frame
    await vi.advanceTimersByTimeAsync(5_000)

    // #then no prompt went out
    expect(run.promptAsync).not.toHaveBeenCalled()
    expect(run.outcome()).toBeUndefined()

    // #when the stream connects late
    run.emit(connected())
    await vi.advanceTimersByTimeAsync(0)

    // #then the prompt follows the frame, once
    expect(run.promptAsync).toHaveBeenCalledOnce()
    expect(run.order).toEqual(['frame:server.connected', 'prompt'])
    run.emit(idle())
    await vi.advanceTimersByTimeAsync(0)
    expect(run.outcome()).toEqual({ok: true})
  })

  it('subscribes once and uses the one iterator throughout, never opening or closing a second', async () => {
    // #given
    const run = startRun({events: [connected()]})

    // #when the run goes on to a normal finish
    await vi.advanceTimersByTimeAsync(0)
    run.emit(textDelta('hello'))
    run.emit(idle())
    await vi.advanceTimersByTimeAsync(0)

    // #then one subscription, one iterator
    expect(run.outcome()).toEqual({ok: true})
    expect(run.streamsCreated()).toBe(1)
    expect(run.iteratorsTaken()).toBe(1)
    // and the barrier left no timer behind
    expect(vi.getTimerCount()).toBe(0)
  })

  describe('a frame that arrives immediately after server.connected is processed, not lost', () => {
    it('a permission ask is answered', async () => {
      // #given the ask is queued right behind the announcement
      const run = startRun({events: [connected(), permissionAsked('perm-1')]})

      // #when
      await vi.advanceTimersByTimeAsync(0)

      // #then
      expect(run.coordinator.onPermissionAsked).toHaveBeenCalledOnce()
      run.emit(idle())
      await vi.advanceTimersByTimeAsync(0)
      expect(run.outcome()).toEqual({ok: true})
    })

    it('output reaches the sink', async () => {
      // #given
      const run = startRun({events: [connected(), textDelta('first words')]})

      // #when
      await vi.advanceTimersByTimeAsync(0)
      run.emit(idle())
      await vi.advanceTimersByTimeAsync(0)

      // #then
      expect(run.outcome()).toEqual({ok: true})
      expect(run.append.mock.calls.map(([text]) => text).join('')).toContain('first words')
    })

    it('a root idle completes the run', async () => {
      // #given
      const run = startRun({events: [connected(), idle()]})

      // #when
      await vi.advanceTimersByTimeAsync(0)

      // #then
      expect(run.outcome()).toEqual({ok: true})
    })

    it('a session error fails the run', async () => {
      // #given
      const run = startRun({events: [connected(), sessionError()]})

      // #when
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

      // #then
      expect(failure(run).kind).toBe('session-error')
    })
  })

  it('still fails a run as replaced when a second server.connected arrives (the consumed one counts as the first)', async () => {
    // #given a connected stream
    const run = startRun({events: [connected()]})
    await vi.advanceTimersByTimeAsync(0)
    expect(run.outcome()).toBeUndefined()

    // #when the server announces itself again
    run.emit(connected())
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    expect(failure(run).kind).toBe('stream-ended')
    expect(failure(run).message).toContain('replaced')
  })

  describe('a stream that does not connect fails the run as unreachable, without touching the root', () => {
    it('ends before any frame (EOF)', async () => {
      // #given
      const run = startRun({close: true})

      // #when
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

      // #then
      expect(failure(run).kind).toBe('unreachable')
      expect(failure(run).quarantined).toBe(false)
      expect(run.promptAsync).not.toHaveBeenCalled()
      expect(run.abort).not.toHaveBeenCalled()
      expect(run.subscribeSignal().aborted).toBe(true)
    })

    it('stays silent for the barrier bound', async () => {
      // #given
      const run = startRun()

      // #when the bound passes less one millisecond, then the last one
      await vi.advanceTimersByTimeAsync(EVENT_STREAM_CONNECT_TIMEOUT_MS - 1)
      expect(run.outcome()).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)

      // #then
      expect(failure(run).kind).toBe('unreachable')
      expect(failure(run).quarantined).toBe(false)
      expect(run.promptAsync).not.toHaveBeenCalled()
      expect(run.abort).not.toHaveBeenCalled()
      expect(run.subscribeSignal().aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('opens with a frame that is not server.connected', async () => {
      // #given
      const run = startRun({events: [textDelta('too early')]})

      // #when
      await vi.advanceTimersByTimeAsync(0)

      // #then the frame is not mistaken for the announcement
      expect(failure(run).kind).toBe('unreachable')
      expect(failure(run).quarantined).toBe(false)
      expect(run.promptAsync).not.toHaveBeenCalled()
      expect(run.abort).not.toHaveBeenCalled()
    })

    it('throws while the first frame is awaited', async () => {
      // #given an iterator whose first read rejects
      vi.useFakeTimers()
      const error = new TypeError('socket hang up')
      const harness = makeHandleWithStream({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw error
          },
          return: async () => ({done: true, value: undefined}),
        }),
      })

      // #when
      const outcome = settleRun(harness.handle)
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

      // #then
      const caught = failure({outcome: () => outcome.current})
      expect(caught.kind).toBe('unreachable')
      expect(caught.cause).toBe(error)
      expect(harness.promptAsync).not.toHaveBeenCalled()
      expect(harness.abort).not.toHaveBeenCalled()
    })
  })

  describe('cancellation and the deadline keep their classification while waiting', () => {
    it('a cancel during the barrier is a timeout, with no prompt and no root abort', async () => {
      // #given
      const controller = new AbortController()
      const run = startRun({controller})
      await vi.advanceTimersByTimeAsync(1_000)

      // #when the operator cancels before the stream connected
      controller.abort()
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

      // #then
      expect(failure(run).kind).toBe('timeout')
      expect(failure(run).quarantined).toBe(false)
      expect(run.promptAsync).not.toHaveBeenCalled()
      expect(run.abort).not.toHaveBeenCalled()
      expect(run.subscribeSignal().aborted).toBe(true)
    })

    it('a run deadline shorter than the barrier bound ends the wait as a timeout, not unreachable', async () => {
      // #given a run whose own deadline passes after 3 s
      const run = startRun({deadlineMs: 3_000})

      // #when
      await vi.advanceTimersByTimeAsync(3_000 + PAST_SETTLE_BOUND_MS)

      // #then the wait did not outlive the deadline
      expect(failure(run).kind).toBe('timeout')
      expect(run.promptAsync).not.toHaveBeenCalled()
    })
  })

  it('leaves a run with background work to its usual completion once connected', async () => {
    // #given a ledger-carrying run that connects late
    const run = startRun({ownershipLedger: createOwnershipLedger()})
    await vi.advanceTimersByTimeAsync(2_000)
    expect(run.promptAsync).not.toHaveBeenCalled()

    // #when it connects and the root goes idle
    run.emit(connected())
    run.emit(idle())
    await vi.advanceTimersByTimeAsync(0)

    // #then
    expect(run.outcome()).toEqual({ok: true})
  })
})

describe('runOpenCodeCore — the barrier through the real SDK SSE client', () => {
  it('sends the prompt only after the connection answered with server.connected, over one request', async () => {
    // #given a server that answers /event with the announcement and then a root idle in the same response
    vi.useFakeTimers()
    const fetchStub = vi.fn().mockImplementation(async () => sseResponse([connected(), idle()]))
    vi.stubGlobal('fetch', fetchStub)

    // #when
    const run = startRealClientRun()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then the idle that rode in right behind the announcement completed the run, over one connection
    expect(run.outcome()).toEqual({ok: true})
    expect(run.promptAsync).toHaveBeenCalledOnce()
    expect(eventCalls(fetchStub)).toHaveLength(1)
  })

  it('fails as unreachable, with the transport error as cause, when the connection is refused; no prompt', async () => {
    // #given
    vi.useFakeTimers()
    const refused = new TypeError('fetch failed')
    const fetchStub = vi.fn().mockRejectedValue(refused)
    vi.stubGlobal('fetch', fetchStub)

    // #when
    const run = startRealClientRun()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then one attempt, no prompt, no root abort, and the SDK-reported cause is attached
    expect(eventCalls(fetchStub)).toHaveLength(1)
    const error = failure(run)
    expect(error.kind).toBe('unreachable')
    expect(error.cause).toBe(refused)
    expect(run.promptAsync).not.toHaveBeenCalled()
    expect(run.abort).not.toHaveBeenCalled()
  })

  it('fails as unreachable at the bound when the connection never answers, and cancels the pending request', async () => {
    // #given a connect phase that never completes, and a fetch that honours the abort it is given
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    const fetchStub = vi.fn(async (_url: unknown, init?: {readonly signal?: AbortSignal}) => {
      requestSignal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    })
    vi.stubGlobal('fetch', fetchStub)

    // #when
    const run = startRealClientRun()
    await vi.advanceTimersByTimeAsync(EVENT_STREAM_CONNECT_TIMEOUT_MS - 1_000)
    expect(run.outcome()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000 + PAST_SETTLE_BOUND_MS)

    // #then
    expect(failure(run).kind).toBe('unreachable')
    expect(run.promptAsync).not.toHaveBeenCalled()
    expect(run.abort).not.toHaveBeenCalled()
    expect(requestSignal?.aborted).toBe(true)
  })
})

describe('awaitFirstEvent — hygiene on the run signal', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves no abort listener and no timer behind, whichever way the wait ends', async () => {
    // #given a long-lived signal
    vi.useFakeTimers()
    const controller = new AbortController()
    const frame = (): AsyncIterator<unknown> => ({next: async () => ({done: false, value: connected()})})
    const ended = (): AsyncIterator<unknown> => ({next: async () => ({done: true, value: undefined})})
    const failing = (): AsyncIterator<unknown> => ({
      next: async () => {
        throw new Error('boom')
      },
    })
    const silent = (): AsyncIterator<unknown> => ({next: async () => new Promise<never>(() => {})})

    // #when the wait ends by a frame, an end, an error and a timeout
    expect(await awaitFirstEvent(frame(), controller.signal, 1_000)).toMatchObject({kind: 'frame'})
    expect(await awaitFirstEvent(ended(), controller.signal, 1_000)).toEqual({kind: 'ended'})
    expect(await awaitFirstEvent(failing(), controller.signal, 1_000)).toMatchObject({kind: 'error'})
    const pending = awaitFirstEvent(silent(), controller.signal, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await pending).toEqual({kind: 'timeout'})

    // #then nothing is left on the signal, and no timer is armed
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles at once on a signal that is already aborted, without reading', async () => {
    // #given
    const controller = new AbortController()
    controller.abort()
    const next = vi.fn(async () => ({done: false as const, value: connected()}))

    // #when / #then
    expect(await awaitFirstEvent({next}, controller.signal, 1_000)).toEqual({kind: 'aborted'})
    expect(next).not.toHaveBeenCalled()
  })
})
