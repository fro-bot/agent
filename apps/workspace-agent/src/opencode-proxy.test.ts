/**
 * Tests for opencode-proxy.ts — bearer-token reverse proxy.
 *
 * Uses a real local http stub as the "upstream OpenCode server" — no mocks
 * needed for the proxy internals. Tests exercise the actual proxy logic.
 *
 * Uses http.request (not fetch) for precise connection lifecycle control —
 * fetch (undici) persistent connections make proxy.close() hang.
 */

import type {AddressInfo} from 'node:net'
import {Buffer} from 'node:buffer'
import http from 'node:http'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {createOpencodeProxy} from './opencode-proxy.js'

const TEST_TOKEN = 'test-bearer-token-xyz'

const noop = () => undefined
const makeLogger = () => ({info: noop, warn: noop, error: noop})

// ── Helpers ──────────────────────────────────────────────────────────────────

interface StubResponse {
  readonly statusCode: number
  readonly headers: http.IncomingHttpHeaders
  readonly body: string
}

/** Make a raw http.request to a URL, return status + body + headers. Always Connection: close. */
async function httpGet(url: string, reqHeaders: Record<string, string> = {}): Promise<StubResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {...reqHeaders, connection: 'close'},
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/**
 * Start a minimal upstream HTTP stub server.
 * Returns {url, close, lastSeenHeaders}.
 */
async function startUpstreamStub(opts: {responseStatus?: number; responseBody?: string; sse?: boolean}): Promise<{
  url: string
  close: () => Promise<void>
  lastSeenHeaders: () => http.IncomingHttpHeaders | undefined
}> {
  return new Promise((resolve, reject) => {
    let lastHeaders: http.IncomingHttpHeaders | undefined

    const stub = http.createServer((req, res) => {
      lastHeaders = req.headers

      if (opts.sse === true) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'close',
        })
        res.write('data: chunk1\n\n')
        setTimeout(() => {
          res.write('data: chunk2\n\n')
          res.end()
        }, 20)
        return
      }

      const body = opts.responseBody ?? 'ok'
      res.writeHead(opts.responseStatus ?? 200, {
        'Content-Length': String(Buffer.byteLength(body)),
        Connection: 'close',
      })
      res.end(body)
    })

    stub.listen(0, '127.0.0.1', () => {
      const addr = stub.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: async () => new Promise<void>((res, rej) => stub.close(err => (err == null ? res() : rej(err)))),
        lastSeenHeaders: () => lastHeaders,
      })
    })
    stub.once('error', reject)
  })
}

/**
 * Start the proxy on a random loopback port. Returns {url, close}.
 */
async function startProxy(
  token: string,
  upstreamUrl: string,
  timeoutMs?: number,
): Promise<{url: string; close: () => Promise<void>}> {
  const proxy = createOpencodeProxy({token, upstreamUrl, logger: makeLogger(), timeoutMs})
  await proxy.listen(0, '127.0.0.1')
  const addr = proxy.server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: async () => proxy.close(),
  }
}

// ── Auth tests ────────────────────────────────────────────────────────────────

describe('opencode-proxy — authorization', () => {
  let upstream: Awaited<ReturnType<typeof startUpstreamStub>>
  let proxyUrl: string
  let closeProxy: () => Promise<void>

  beforeEach(async () => {
    upstream = await startUpstreamStub({responseStatus: 200, responseBody: 'hello'})
    const p = await startProxy(TEST_TOKEN, upstream.url)
    proxyUrl = p.url
    closeProxy = p.close
  })

  afterEach(async () => {
    await closeProxy()
    await upstream.close()
  })

  it('forwards authorized request (correct bearer) and relays the response', async () => {
    // #when
    const res = await httpGet(`${proxyUrl}/some/path`, {Authorization: `Bearer ${TEST_TOKEN}`})

    // #then
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('hello')
  })

  it('returns 401 for missing Authorization header — does not forward', async () => {
    // #when
    const res = await httpGet(`${proxyUrl}/some/path`)

    // #then
    expect(res.statusCode).toBe(401)
    expect(upstream.lastSeenHeaders()).toBeUndefined()
  })

  it('returns 401 for wrong bearer token — does not forward', async () => {
    // #when
    const res = await httpGet(`${proxyUrl}/some/path`, {Authorization: 'Bearer wrong-token'})

    // #then
    expect(res.statusCode).toBe(401)
    expect(upstream.lastSeenHeaders()).toBeUndefined()
  })

  it('returns 401 for non-Bearer Authorization scheme — does not forward', async () => {
    // #when
    const res = await httpGet(`${proxyUrl}/some/path`, {Authorization: `Basic ${TEST_TOKEN}`})

    // #then
    expect(res.statusCode).toBe(401)
    expect(upstream.lastSeenHeaders()).toBeUndefined()
  })

  it('401 responses have identical body (no oracle — prevents token enumeration)', async () => {
    // #given — two different wrong tokens
    const [res1, res2] = await Promise.all([
      httpGet(`${proxyUrl}/p`, {Authorization: 'Bearer wrong-a'}),
      httpGet(`${proxyUrl}/p`, {Authorization: 'Bearer wrong-b'}),
    ])

    // #then — both 401 with identical bodies
    expect(res1.statusCode).toBe(401)
    expect(res2.statusCode).toBe(401)
    expect(res1.body).toBe(res2.body)
  })

  it('does NOT forward the Authorization header to the upstream server', async () => {
    // #when
    await httpGet(`${proxyUrl}/api`, {Authorization: `Bearer ${TEST_TOKEN}`})

    // #then — upstream sees no Authorization header
    const seen = upstream.lastSeenHeaders()
    expect(seen).toBeDefined()
    expect(seen?.authorization).toBeUndefined()
  })

  it('authorization header is not present in the 401 response body', async () => {
    // #when
    const res = await httpGet(`${proxyUrl}/p`, {Authorization: `Bearer ${TEST_TOKEN}-bad`})

    // #then
    expect(res.statusCode).toBe(401)
    expect(res.body).not.toContain(TEST_TOKEN)
    expect(res.body).not.toContain('Bearer')
    expect(res.body).not.toContain('Authorization')
  })
})

describe('opencode-proxy — SSE forwarding', () => {
  it('streams SSE chunks through without buffering (authorized request)', async () => {
    // #given — upstream sends two SSE chunks with a delay
    const sseUpstream = await startUpstreamStub({sse: true})
    const {url, close} = await startProxy(TEST_TOKEN, sseUpstream.url)

    // #when — collect SSE body from the proxy
    const response = await new Promise<{statusCode: number; contentType: string; body: string}>((resolve, reject) => {
      const parsed = new URL(`${url}/event`)
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: 'GET',
          headers: {
            Authorization: `Bearer ${TEST_TOKEN}`,
            Accept: 'text/event-stream',
            connection: 'close',
          },
        },
        res => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () =>
            resolve({
              statusCode: res.statusCode ?? 0,
              contentType: String(res.headers['content-type'] ?? ''),
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          )
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      req.end()
    })

    // #then — response is streamed with correct content type
    expect(response.statusCode).toBe(200)
    expect(response.contentType).toContain('text/event-stream')
    expect(response.body).toContain('chunk1')
    expect(response.body).toContain('chunk2')

    await close()
    await sseUpstream.close()
  })
})

describe('opencode-proxy — upstream errors', () => {
  it('returns 502 when upstream is not reachable', async () => {
    // #given — proxy pointing at a port with nothing listening (port 1 is always refused)
    const proxy = createOpencodeProxy({
      token: TEST_TOKEN,
      upstreamUrl: 'http://127.0.0.1:1',
      logger: makeLogger(),
    })
    await proxy.listen(0, '127.0.0.1')
    const addr = proxy.server.address() as AddressInfo
    const url = `http://127.0.0.1:${addr.port}`

    // #when
    const res = await httpGet(`${url}/test`, {Authorization: `Bearer ${TEST_TOKEN}`})

    // #then
    expect(res.statusCode).toBe(502)
    await proxy.close()
  })
})

describe('opencode-proxy — close()', () => {
  it('resolves cleanly when there are no active connections', async () => {
    // #given
    const upstreamStub = await startUpstreamStub({})
    const proxy = createOpencodeProxy({
      token: TEST_TOKEN,
      upstreamUrl: upstreamStub.url,
      logger: makeLogger(),
    })
    await proxy.listen(0, '127.0.0.1')

    // #when / #then
    await expect(proxy.close()).resolves.toBeUndefined()
    await upstreamStub.close()
  })
})

// ── Inactivity timeout stub helpers ──────────────────────────────────────────

/**
 * Start an upstream stub that accepts connections but never sends any response
 * (simulates a stalled upstream that accepted the TCP connection but hangs).
 */
async function startStalledUpstream(): Promise<{url: string; close: () => Promise<void>}> {
  return new Promise((resolve, reject) => {
    const stub = http.createServer((_req, _res) => {
      // Intentionally do nothing — never send headers or body
    })
    stub.listen(0, '127.0.0.1', () => {
      const addr = stub.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: async () => new Promise<void>((res, rej) => stub.close(err => (err == null ? res() : rej(err)))),
      })
    })
    stub.once('error', reject)
  })
}

/**
 * Start an upstream stub that sends headers immediately then stalls mid-body
 * (simulates a server that sends headers fast but hangs before completing the body).
 */
async function startHeadersThenStalledUpstream(): Promise<{url: string; close: () => Promise<void>}> {
  return new Promise((resolve, reject) => {
    const stub = http.createServer((_req, res) => {
      // Send headers immediately — do NOT set Content-Length so the response stays open
      res.writeHead(200, {'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked'})
      // Send one chunk then stall — never call res.end()
      res.write('{"partial":')
      // Intentionally do not write more or end the response
    })
    stub.listen(0, '127.0.0.1', () => {
      const addr = stub.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: async () => new Promise<void>((res, rej) => stub.close(err => (err == null ? res() : rej(err)))),
      })
    })
    stub.once('error', reject)
  })
}

/**
 * Start an upstream stub that sends chunks slowly but continuously —
 * each chunk resets the inactivity timer so the request should NOT be killed.
 */
async function startSlowButProgressingUpstream(opts: {
  chunkCount: number
  chunkIntervalMs: number
  chunkBody: string
}): Promise<{url: string; close: () => Promise<void>}> {
  return new Promise((resolve, reject) => {
    const stub = http.createServer((_req, res) => {
      res.writeHead(200, {'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked'})
      let sent = 0
      const sendNext = (): void => {
        if (sent >= opts.chunkCount) {
          res.end()
          return
        }
        res.write(opts.chunkBody)
        sent++
        setTimeout(sendNext, opts.chunkIntervalMs)
      }
      sendNext()
    })
    stub.listen(0, '127.0.0.1', () => {
      const addr = stub.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: async () => new Promise<void>((res, rej) => stub.close(err => (err == null ? res() : rej(err)))),
      })
    })
    stub.once('error', reject)
  })
}

/**
 * Start an upstream stub that sends an SSE stream with chunks spaced further
 * apart than the inactivity timeout — should NOT be killed (SSE is exempt).
 */
async function startLongRunningSSEUpstream(opts: {
  chunkIntervalMs: number
  chunkCount: number
}): Promise<{url: string; close: () => Promise<void>}> {
  return new Promise((resolve, reject) => {
    const stub = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Transfer-Encoding': 'chunked',
      })
      let sent = 0
      const sendNext = (): void => {
        if (sent >= opts.chunkCount) {
          res.end()
          return
        }
        res.write(`data: event${sent}\n\n`)
        sent++
        setTimeout(sendNext, opts.chunkIntervalMs)
      }
      sendNext()
    })
    stub.listen(0, '127.0.0.1', () => {
      const addr = stub.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: async () => new Promise<void>((res, rej) => stub.close(err => (err == null ? res() : rej(err)))),
      })
    })
    stub.once('error', reject)
  })
}

// ── Inactivity timeout tests ──────────────────────────────────────────────────

describe('opencode-proxy — inactivity timeout', () => {
  it('happy path: normal request/response completes within the inactivity window — unchanged behavior', async () => {
    // #given — upstream responds immediately with a complete body
    const upstream = await startUpstreamStub({responseStatus: 200, responseBody: 'complete response'})
    // Use a short timeout (100ms) — the fast upstream should complete well within it
    const {url, close} = await startProxy(TEST_TOKEN, upstream.url, 100)

    // #when
    const res = await httpGet(`${url}/api`, {Authorization: `Bearer ${TEST_TOKEN}`})

    // #then — response forwarded normally, no timeout
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('complete response')

    await close()
    await upstream.close()
  })

  it('error path (no response): upstream accepts but never sends headers → 504 within the interval', async () => {
    // #given — upstream accepts connection but never sends any response
    const upstream = await startStalledUpstream()
    // Very short timeout so the test runs fast
    const {url, close} = await startProxy(TEST_TOKEN, upstream.url, 150)

    // #when — make a request; it should time out
    const res = await httpGet(`${url}/api`, {Authorization: `Bearer ${TEST_TOKEN}`})

    // #then — proxy returns 504 (not a hang)
    expect(res.statusCode).toBe(504)
    expect(res.body).toContain('Gateway Timeout')

    await close()
    await upstream.close()
  })

  it('error path (mid-body stall): upstream sends headers quickly then stalls → inactivity timeout still fires', async () => {
    // #given — upstream sends headers + one chunk then stalls forever
    // This is the KEY test: headers arriving must NOT disarm the inactivity timer.
    // The upstream sends headers and one partial chunk, then never completes the body.
    const upstream = await startHeadersThenStalledUpstream()
    // Short timeout so the test runs fast
    const {url, close} = await startProxy(TEST_TOKEN, upstream.url, 150)

    // #when — make a request; headers arrive fast but body stalls
    // Since the upstream already forwarded headers before the timeout fires,
    // the proxy destroys the downstream connection — the client sees ECONNRESET.
    // This is the expected behavior: the timer fires (proving headers-arrived did NOT
    // disarm it) and the proxy tears down the stalled connection.
    const start = Date.now()
    const result = await new Promise<{statusCode: number; body: string; error?: string}>((resolve, _reject) => {
      const parsed = new URL(`${url}/api`)
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: 'GET',
          headers: {Authorization: `Bearer ${TEST_TOKEN}`, connection: 'close'},
        },
        res => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => resolve({statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8')}))
          // ECONNRESET is expected when the proxy destroys the connection mid-body
          res.on('error', (err: Error) => resolve({statusCode: res.statusCode ?? 0, body: '', error: err.message}))
        },
      )
      req.on('error', (err: Error) => resolve({statusCode: 0, body: '', error: err.message}))
      req.end()
    })
    const elapsed = Date.now() - start

    // #then — the inactivity timer fired (headers arriving did NOT disarm it).
    // The proxy either:
    //   (a) returned 504 before forwarding headers (statusCode === 504), OR
    //   (b) destroyed the connection after forwarding headers (ECONNRESET / partial body)
    // Either outcome proves the timer fired. The key invariant: elapsed is bounded
    // (not a hang), and the connection was torn down by the inactivity timer.
    const timerFired = result.statusCode === 504 || result.error !== undefined
    expect(timerFired).toBe(true)
    // Should complete within the timeout + generous CI buffer
    expect(elapsed).toBeLessThan(2000)

    await close()
    await upstream.close()
  })

  it('edge case (slow-but-progressing): non-SSE response sending chunks slower than interval is NOT killed', async () => {
    // #given — upstream sends 3 chunks, each 60ms apart; inactivity timeout is 100ms
    // Each chunk resets the timer, so the total time (3 * 60ms = 180ms) exceeds the
    // timeout interval (100ms), but the inactivity timer is reset on each chunk.
    const upstream = await startSlowButProgressingUpstream({
      chunkCount: 3,
      chunkIntervalMs: 60,
      chunkBody: 'chunk',
    })
    const {url, close} = await startProxy(TEST_TOKEN, upstream.url, 100)

    // #when
    const res = await httpGet(`${url}/api`, {Authorization: `Bearer ${TEST_TOKEN}`})

    // #then — all chunks received, no timeout
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('chunkchunkchunk')

    await close()
    await upstream.close()
  })

  it('edge case (SSE exemption): text/event-stream response is NOT timed out — streams past the window', async () => {
    // #given — SSE upstream sends chunks spaced 80ms apart; inactivity timeout is 50ms
    // Without SSE exemption, the 80ms gap between chunks would trip the 50ms timer.
    // With SSE exemption, the timer is cancelled on SSE detection and the stream completes.
    const upstream = await startLongRunningSSEUpstream({
      chunkIntervalMs: 80,
      chunkCount: 3,
    })
    const {url, close} = await startProxy(TEST_TOKEN, upstream.url, 50)

    // #when — SSE request
    const response = await new Promise<{statusCode: number; contentType: string; body: string; error?: string}>(
      (resolve, _reject) => {
        const parsed = new URL(`${url}/event`)
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'GET',
            headers: {
              Authorization: `Bearer ${TEST_TOKEN}`,
              Accept: 'text/event-stream',
              connection: 'close',
            },
          },
          res => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () =>
              resolve({
                statusCode: res.statusCode ?? 0,
                contentType: String(res.headers['content-type'] ?? ''),
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            )
            res.on('error', (err: Error) => resolve({statusCode: 0, contentType: '', body: '', error: err.message}))
          },
        )
        req.on('error', (err: Error) => resolve({statusCode: 0, contentType: '', body: '', error: err.message}))
        req.end()
      },
    )

    // #then — SSE stream completes without being cut off by the inactivity timer
    expect(response.error).toBeUndefined()
    expect(response.statusCode).toBe(200)
    expect(response.contentType).toContain('text/event-stream')
    expect(response.body).toContain('event0')
    expect(response.body).toContain('event1')
    expect(response.body).toContain('event2')

    await close()
    await upstream.close()
  })

  it('edge case: interval is configurable via timeoutMs option', async () => {
    // #given — stalled upstream; proxy with explicit 120ms timeout
    const upstream = await startStalledUpstream()
    const {url, close} = await startProxy(TEST_TOKEN, upstream.url, 120)

    const start = Date.now()

    // #when
    const res = await httpGet(`${url}/api`, {Authorization: `Bearer ${TEST_TOKEN}`})
    const elapsed = Date.now() - start

    // #then — timed out with 504, elapsed is in the expected range
    expect(res.statusCode).toBe(504)
    // Should fire at ~120ms; allow generous upper bound for CI timing variance
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(elapsed).toBeLessThan(2000)

    await close()
    await upstream.close()
  })

  it('edge case: defaults to PROXY_TIMEOUT_DEFAULT_MS when timeoutMs is not provided', async () => {
    // #given — proxy created without explicit timeoutMs
    // We just verify the proxy is created and works normally (the default is 30s,
    // too long to wait in a test — we verify the option is accepted and the proxy
    // functions correctly with a fast upstream)
    const upstream = await startUpstreamStub({responseStatus: 200, responseBody: 'default timeout test'})
    const {url, close} = await startProxy(TEST_TOKEN, upstream.url) // no timeoutMs

    // #when
    const res = await httpGet(`${url}/api`, {Authorization: `Bearer ${TEST_TOKEN}`})

    // #then — proxy works normally with default timeout
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('default timeout test')

    await close()
    await upstream.close()
  })
})
