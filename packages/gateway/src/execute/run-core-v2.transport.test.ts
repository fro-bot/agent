/**
 * The V2 run loop over the real remote client: a data frame the transport cannot parse is a lost frame of unknown type
 * (a truncated `permission.asked` is a request nobody can answer), so it ends the stream through the barrier instead of
 * being skipped and found five minutes later by the inactivity watchdog.
 */

import {createRemoteOpenCodeV2Client} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {DIRECTORY, failure, ROOT, startRun} from './run-core-v2.fixture.js'

const INACTIVITY_MS = 300_000
const ENCODER = new TextEncoder()

/** A live event stream: it delivers `chunks`, then stays open until the caller aborts. */
function liveStreamFetch(chunks: readonly string[]): typeof fetch {
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        for (const chunk of chunks) stream.enqueue(ENCODER.encode(chunk))
        init?.signal?.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')))
      },
    })
    return new Response(body, {status: 200, headers: {'content-type': 'text/event-stream'}})
  })
}

function startOverTransport(chunks: readonly string[]) {
  const transport = createRemoteOpenCodeV2Client({baseUrl: 'http://workspace', fetch: liveStreamFetch(chunks)})
  return startRun({
    inactivityTimeoutMs: INACTIVITY_MS,
    subscribeResult: async () => transport.subscribeEvents({directory: DIRECTORY}),
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runOpenCodeCoreV2 over the remote client: an unreadable data frame', () => {
  it('ends a run whose permission.asked frame was truncated as stream-ended, with the root interrupted', async () => {
    // #given — the stream connects, then delivers a permission ask cut off mid-payload
    const run = startOverTransport([
      'data: {"type":"server.connected","data":{}}\n\n',
      `data: {"type":"permission.asked","data":{"sessionID":"${ROOT}","id":"per_1","action":"ext\n\n`,
    ])

    // #when — far short of the inactivity window
    await vi.advanceTimersByTimeAsync(1_000)

    // #then — the run fails now, and the root that may be waiting on the lost ask is interrupted and confirmed stopped
    const error = failure(run)
    expect(error.kind).toBe('stream-ended')
    expect(error.quarantined).toBe(false)
    expect(run.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
  })

  it('does not carry any of the unreadable payload into the error', async () => {
    // #given
    const run = startOverTransport([
      'data: {"type":"server.connected","data":{}}\n\n',
      'data: {"type":"permission.asked","data":{"secret":"hunter2\n\n',
    ])

    // #when
    await vi.advanceTimersByTimeAsync(1_000)

    // #then
    expect(failure(run).message).not.toContain('hunter2')
  })
})
