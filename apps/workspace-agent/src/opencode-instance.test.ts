/**
 * Tests for opencode-instance.ts — the best-effort `POST /instance/dispose` the workspace sends to
 * the local OpenCode after a checkout is replaced in place.
 */

import type {AddressInfo} from 'node:net'
import http from 'node:http'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createInstanceDisposer, DEFAULT_INSTANCE_DISPOSE_TIMEOUT_MS} from './opencode-instance.js'

const UPSTREAM = 'http://127.0.0.1:54321'
const DIRECTORY = '/workspace/repos/acme/widget'

interface Seen {
  method: string | undefined
  url: string | undefined
  body: string
  authorization: string | undefined
}

async function startStub(
  respond: (res: http.ServerResponse) => void,
): Promise<{readonly url: string; readonly seen: Seen[]; readonly close: () => Promise<void>}> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => {
      body += String(chunk)
    })
    req.on('end', () => {
      seen.push({method: req.method, url: req.url, body, authorization: req.headers.authorization})
      respond(res)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: async () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

describe('createInstanceDisposer: the request', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('pOSTs /instance/dispose with the directory as a url-encoded query param, no body, no credentials', async () => {
    // #given an OpenCode that answers the way the live probe saw it: 200 `true`
    const stub = await startStub(res => {
      res.writeHead(200, {'content-type': 'application/json'})
      res.end('true')
    })
    close = stub.close
    const dispose = createInstanceDisposer({upstreamUrl: stub.url})

    // #when
    const outcome = await dispose(DIRECTORY)

    // #then
    expect(outcome).toEqual({kind: 'disposed'})
    expect(stub.seen).toHaveLength(1)
    expect(stub.seen[0]?.method).toBe('POST')
    expect(stub.seen[0]?.url).toBe('/instance/dispose?directory=%2Fworkspace%2Frepos%2Facme%2Fwidget')
    expect(stub.seen[0]?.body).toBe('')
    expect(stub.seen[0]?.authorization).toBeUndefined()
  })

  it('encodes a directory with reserved characters so it round-trips exactly', async () => {
    // #given
    const stub = await startStub(res => {
      res.writeHead(200)
      res.end('true')
    })
    close = stub.close
    const dispose = createInstanceDisposer({upstreamUrl: stub.url})

    // #when
    await dispose('/workspace/repos/acme/we ird&repo?x=1#frag')

    // #then
    const url = new URL(stub.seen[0]?.url ?? '', 'http://x')
    expect(url.pathname).toBe('/instance/dispose')
    expect(url.searchParams.get('directory')).toBe('/workspace/repos/acme/we ird&repo?x=1#frag')
  })
})

describe('createInstanceDisposer: outcomes', () => {
  it('reports a non-2xx answer as http-error with the status', async () => {
    // #given
    const fetchFn = vi.fn().mockResolvedValue(new Response('nope', {status: 500}))
    const dispose = createInstanceDisposer({upstreamUrl: UPSTREAM, fetchFn})

    // #when / #then
    expect(await dispose(DIRECTORY)).toEqual({kind: 'failed', reason: 'http-error', status: 500})
  })

  it('reports a connection error as network-error', async () => {
    // #given
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const dispose = createInstanceDisposer({upstreamUrl: UPSTREAM, fetchFn})

    // #when / #then
    expect(await dispose(DIRECTORY)).toEqual({kind: 'failed', reason: 'network-error'})
  })

  it('skips without any request when OpenCode is not running', async () => {
    // #given
    const fetchFn = vi.fn()
    const dispose = createInstanceDisposer({upstreamUrl: UPSTREAM, fetchFn, isRunning: () => false})

    // #when / #then
    expect(await dispose(DIRECTORY)).toEqual({kind: 'skipped'})
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('sends the request when OpenCode is running', async () => {
    // #given
    const fetchFn = vi.fn().mockResolvedValue(new Response('true', {status: 200}))
    const dispose = createInstanceDisposer({upstreamUrl: UPSTREAM, fetchFn, isRunning: () => true})

    // #when / #then
    expect(await dispose(DIRECTORY)).toEqual({kind: 'disposed'})
    expect(fetchFn).toHaveBeenCalledOnce()
  })
})

/** A fetch that never answers and rejects exactly like a real one when its signal aborts. */
function hangingFetch() {
  return vi.fn().mockImplementation(
    async (_url: string, init: {signal: AbortSignal}) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), {name: 'AbortError'}))
        })
      }),
  )
}

describe('createInstanceDisposer: timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up at the 5s default, not before', async () => {
    // #given
    vi.useFakeTimers()
    const dispose = createInstanceDisposer({upstreamUrl: UPSTREAM, fetchFn: hangingFetch()})
    expect(DEFAULT_INSTANCE_DISPOSE_TIMEOUT_MS).toBe(5_000)

    // #when
    const pending = dispose(DIRECTORY)
    let settled = false
    pending.then(
      () => {
        settled = true
      },
      () => {},
    )
    await vi.advanceTimersByTimeAsync(4_999)
    const settledEarly = settled
    await vi.advanceTimersByTimeAsync(1)

    // #then
    expect(settledEarly).toBe(false)
    expect(await pending).toEqual({kind: 'failed', reason: 'timeout'})
  })

  it('honours a configured timeout', async () => {
    // #given
    vi.useFakeTimers()
    const dispose = createInstanceDisposer({upstreamUrl: UPSTREAM, fetchFn: hangingFetch(), timeoutMs: 250})

    // #when
    const pending = dispose(DIRECTORY)
    await vi.advanceTimersByTimeAsync(250)

    // #then
    expect(await pending).toEqual({kind: 'failed', reason: 'timeout'})
  })

  it('clears its timer once the answer arrives', async () => {
    // #given
    vi.useFakeTimers()
    const fetchFn = vi.fn().mockResolvedValue(new Response('true', {status: 200}))
    const dispose = createInstanceDisposer({upstreamUrl: UPSTREAM, fetchFn})

    // #when
    await dispose(DIRECTORY)

    // #then
    expect(vi.getTimerCount()).toBe(0)
  })
})
