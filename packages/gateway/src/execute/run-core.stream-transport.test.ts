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

import {runOpenCodeCore} from './run-core.js'

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
}

/** A run whose session calls are doubles and whose `/event` subscription is the real SDK client. */
function startRun(options: {readonly streamSilenceTimeoutMs?: number} = {}): Started {
  const remote = createRemoteOpenCodeHandle(BASE_URL)
  const abort = vi.fn(async () => ({data: {}, error: null}))
  const handle = {
    client: {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: ROOT}, error: null}),
        messages: vi.fn().mockResolvedValue({data: [], error: null}),
        promptAsync: vi.fn().mockResolvedValue({data: {}, error: null}),
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
  return {outcome: () => settled, logger, abort}
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
  it('ends the run as stream-ended, with the cause, after one failed fetch (no reconnect)', async () => {
    // #given a network that refuses the connection
    vi.useFakeTimers()
    const refused = new TypeError('fetch failed')
    const fetchStub = vi.fn().mockRejectedValue(refused)
    vi.stubGlobal('fetch', fetchStub)

    // #when the run subscribes
    const run = startRun()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then the SDK tried once (the default would sleep and retry), reported the error before the iterator
    // ended, and the run failed as a lost stream carrying that very error
    expect(eventCalls(fetchStub)).toHaveLength(1)
    const error = failure(run)
    expect(error.kind).toBe('stream-ended')
    expect(error.cause).toBe(refused)
    expect(run.abort).toHaveBeenCalled()
  })

  it('ends the run as stream-ended after one HTTP 500 from /event (no reconnect)', async () => {
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
    expect(error.kind).toBe('stream-ended')
    expect(error.cause).toBeInstanceOf(Error)
    expect((error.cause as Error).message).toBe('SSE failed: 500 Internal Server Error')
  })

  it('ends the run as stream-ended when the connect phase never answers and nothing was ever delivered', async () => {
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

    // #when the silence window passes with zero events
    const run = startRun({streamSilenceTimeoutMs: SILENCE_MS})
    await vi.advanceTimersByTimeAsync(SILENCE_MS - 1_000)
    expect(run.outcome()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000 + PAST_SETTLE_BOUND_MS)

    // #then the run failed as a lost stream, and the pending connection was cancelled with it
    const error = failure(run)
    expect(error.kind).toBe('stream-ended')
    expect(error.message).toContain('silent')
    expect(eventCalls(fetchStub)).toHaveLength(1)
    expect(requestSignal?.aborted).toBe(true)
  })
})
