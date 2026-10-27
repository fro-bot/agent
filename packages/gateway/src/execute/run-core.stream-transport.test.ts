/**
 * The event subscription through the REAL SDK SSE client (`createSseClient` under `createOpencodeClient`), with only
 * the network stubbed. The mocks in the other run-core suites replace `event.subscribe` wholesale, so they cannot
 * show what the SDK actually does with a failed connection: reconnect with backoff (hiding the loss from the run),
 * or end the stream and report why.
 *
 * The v1 SSE client calls the global `fetch`, so that is what is stubbed here.
 */

import type {OpenCodeServerHandle} from '@fro-bot/runtime'
import type {PermissionCoordinator} from '../approvals/coordinator.js'
import type {GatewayLogger} from '../discord/client.js'
import type {DiscordStreamSink} from '../discord/streaming.js'
import type {RunCoreError} from './run-core.js'
import {createRemoteOpenCodeHandle} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {EVENT_STREAM_CONNECT_TIMEOUT_MS, runOpenCodeCore} from './run-core.js'

const ROOT = 'sess-123'
const DIRECTORY = '/workspace/repo'
const BASE_URL = 'http://workspace:9200'
const SILENCE_MS = 30_000
const PAST_SETTLE_BOUND_MS = 20_000

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
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

interface Started {
  readonly outcome: () => Outcome | undefined
  readonly logger: GatewayLogger
  readonly abort: ReturnType<typeof vi.fn>
  readonly promptAsync: ReturnType<typeof vi.fn>
}

/** A run whose session calls are doubles and whose `/event` subscription is the real SDK client. */
function startRun(options: {readonly streamSilenceTimeoutMs?: number} = {}): Started {
  const remote = createRemoteOpenCodeHandle(BASE_URL)
  const abort = vi.fn(async () => ({data: {}, error: null}))
  const promptAsync = vi.fn().mockResolvedValue({data: {}, error: null})
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
      event: remote.client.event,
      postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({error: null}),
    },
    server: {url: BASE_URL, close: vi.fn()},
    shutdown: vi.fn(),
  } as unknown as OpenCodeServerHandle

  const logger = makeLogger()
  let settled: Outcome | undefined
  // eslint-disable-next-line no-void
  void runOpenCodeCore({
    handle,
    directory: DIRECTORY,
    promptText: 'Fix the bug please',
    sink: makeSink(),
    signal: new AbortController().signal,
    logger,
    coordinator: makeCoordinator(),
    ...(options.streamSilenceTimeoutMs === undefined ? {} : {streamSilenceTimeoutMs: options.streamSilenceTimeoutMs}),
  }).then(
    () => {
      settled = {ok: true}
    },
    (error: unknown) => {
      settled = {ok: false, error: error as RunCoreError}
    },
  )
  return {outcome: () => settled, logger, abort, promptAsync}
}

function failure(run: Started): RunCoreError {
  const outcome = run.outcome()
  if (outcome === undefined || outcome.ok === true) {
    throw new Error(`expected the run to have failed, got ${outcome === undefined ? 'still running' : 'success'}`)
  }
  return outcome.error
}

/** The `/event` requests the stub saw. */
function eventCalls(fetchStub: ReturnType<typeof vi.fn>): readonly unknown[][] {
  return fetchStub.mock.calls.filter(call => new URL(String(call[0])).pathname === '/event')
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('runOpenCodeCore — the real SDK event subscription', () => {
  it('fails the run as unreachable, with the cause, after one failed fetch (no reconnect), before any prompt', async () => {
    // #given a network that refuses the connection
    vi.useFakeTimers()
    const refused = new TypeError('fetch failed')
    const fetchStub = vi.fn().mockRejectedValue(refused)
    vi.stubGlobal('fetch', fetchStub)

    // #when the run subscribes
    const run = startRun()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then the SDK tried once (the default would sleep and retry) and reported the error before the iterator
    // ended; the stream never connected, so the prompt was never sent and the root was never touched
    expect(eventCalls(fetchStub)).toHaveLength(1)
    const error = failure(run)
    expect(error.kind).toBe('unreachable')
    expect(error.cause).toBe(refused)
    expect(run.promptAsync).not.toHaveBeenCalled()
    expect(run.abort).not.toHaveBeenCalled()
  })

  it('fails the run as unreachable after one HTTP 500 from /event (no reconnect), before any prompt', async () => {
    // #given a server that answers the subscription with a 500
    vi.useFakeTimers()
    const fetchStub = vi
      .fn()
      .mockResolvedValue(new Response('nope', {status: 500, statusText: 'Internal Server Error'}))
    vi.stubGlobal('fetch', fetchStub)

    // #when
    const run = startRun()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then
    expect(eventCalls(fetchStub)).toHaveLength(1)
    const error = failure(run)
    expect(error.kind).toBe('unreachable')
    expect(error.cause).toBeInstanceOf(Error)
    expect((error.cause as Error).message).toBe('SSE failed: 500 Internal Server Error')
    expect(run.promptAsync).not.toHaveBeenCalled()
    expect(run.abort).not.toHaveBeenCalled()
  })

  it('ends the run as stream-ended, with the cause, when a connected stream then fails mid-body (no reconnect)', async () => {
    // #given a server that announces the stream, then drops the connection
    vi.useFakeTimers()
    const dropped = new TypeError('terminated')
    const encoder = new TextEncoder()
    let sent = false
    const fetchStub = vi.fn().mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (sent) {
                controller.error(dropped)
                return
              }
              sent = true
              controller.enqueue(encoder.encode('data: {"type":"server.connected","properties":{}}\n\n'))
            },
          }),
          {status: 200, headers: {'content-type': 'text/event-stream'}},
        ),
    )
    vi.stubGlobal('fetch', fetchStub)

    // #when
    const run = startRun()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then the prompt went out after the announcement, the loss is a stream loss carrying the cause, and the SDK did
    // not reconnect
    expect(run.promptAsync).toHaveBeenCalledOnce()
    expect(eventCalls(fetchStub)).toHaveLength(1)
    const error = failure(run)
    expect(error.kind).toBe('stream-ended')
    expect(error.cause).toBe(dropped)
    expect(run.abort).toHaveBeenCalled()
  })

  it('fails the run as unreachable at the connect bound when the connection never answers, and cancels the request', async () => {
    // #given a connection that never completes, and a fetch that honours the abort it is given
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

    // #when the connect bound passes with zero events
    const run = startRun({streamSilenceTimeoutMs: SILENCE_MS})
    await vi.advanceTimersByTimeAsync(EVENT_STREAM_CONNECT_TIMEOUT_MS - 1_000)
    expect(run.outcome()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000 + PAST_SETTLE_BOUND_MS)

    // #then the run failed before any prompt, and the pending connection was cancelled with it
    const error = failure(run)
    expect(error.kind).toBe('unreachable')
    expect(eventCalls(fetchStub)).toHaveLength(1)
    expect(requestSignal?.aborted).toBe(true)
    expect(run.promptAsync).not.toHaveBeenCalled()
    expect(run.abort).not.toHaveBeenCalled()
  })
})
