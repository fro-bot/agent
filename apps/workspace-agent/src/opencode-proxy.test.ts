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
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

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

describe('opencode-proxy — readProxyTimeoutMs() env parsing', () => {
  // readProxyTimeoutMs() reads process.env directly (no injection seam).
  // We test it by creating a proxy without an explicit timeoutMs option and
  // observing the effective timeout via a stalled upstream. For the fallback
  // branches (invalid/absent env) we verify the proxy still works correctly
  // with a fast upstream (the 30s default won't fire in a fast test).

  const ENV_KEY = 'WORKSPACE_PROXY_TIMEOUT_MS'

  afterEach(() => {
    // Always restore the env key so tests don't bleed into each other.
    delete process.env[ENV_KEY]
  })

  it('falls back to 30000ms default when env var is undefined', async () => {
    // #given — env var absent; proxy created without explicit timeoutMs
    delete process.env[ENV_KEY]
    const upstream = await startUpstreamStub({responseStatus: 200, responseBody: 'ok'})
    // No timeoutMs → readProxyTimeoutMs() is called → returns 30000 (default)
    const {url, close} = await startProxy(TEST_TOKEN, upstream.url)

    // #when — fast upstream completes well within the 30s default
    const res = await httpGet(`${url}/api`, {Authorization: `Bearer ${TEST_TOKEN}`})

    // #then — proxy works; the 30s default did not fire
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('ok')

    await close()
    await upstream.close()
  })

  it('falls back to default when env var is empty string', async () => {
    // #given — empty string is treated as absent
    process.env[ENV_KEY] = ''
    const upstream = await startUpstreamStub({responseStatus: 200, responseBody: 'ok'})
    const {url, close} = await startProxy(TEST_TOKEN, upstream.url)

    // #when
    const res = await httpGet(`${url}/api`, {Authorization: `Bearer ${TEST_TOKEN}`})

    // #then — proxy works normally (default 30s did not fire)
    expect(res.statusCode).toBe(200)

    await close()
    await upstream.close()
  })

  it('falls back to default when env var is whitespace only', async () => {
    // #given — whitespace-only trims to empty → default
    process.env[ENV_KEY] = '   '
    const upstream = await startUpstreamStub({responseStatus: 200, responseBody: 'ok'})
    const {url, close} = await startProxy(TEST_TOKEN, upstream.url)

    // #when
    const res = await httpGet(`${url}/api`, {Authorization: `Bearer ${TEST_TOKEN}`})

    // #then
    expect(res.statusCode).toBe(200)

    await close()
    await upstream.close()
  })

  it('falls back to default when env var is non-numeric ("abc")', async () => {
    // #given — parseInt('abc') is NaN → default
    process.env[ENV_KEY] = 'abc'
    const upstream = await startUpstreamStub({responseStatus: 200, responseBody: 'ok'})
    const {url, close} = await startProxy(TEST_TOKEN, upstream.url)

    // #when
    const res = await httpGet(`${url}/api`, {Authorization: `Bearer ${TEST_TOKEN}`})

    // #then
    expect(res.statusCode).toBe(200)

    await close()
    await upstream.close()
  })

  it('falls back to default when env var is "0" (non-positive)', async () => {
    // #given — 0 is not > 0 → default
    process.env[ENV_KEY] = '0'
    const upstream = await startUpstreamStub({responseStatus: 200, responseBody: 'ok'})
    const {url, close} = await startProxy(TEST_TOKEN, upstream.url)

    // #when
    const res = await httpGet(`${url}/api`, {Authorization: `Bearer ${TEST_TOKEN}`})

    // #then
    expect(res.statusCode).toBe(200)

    await close()
    await upstream.close()
  })

  it('falls back to default when env var is "-5000" (negative)', async () => {
    // #given — negative value is not > 0 → default
    process.env[ENV_KEY] = '-5000'
    const upstream = await startUpstreamStub({responseStatus: 200, responseBody: 'ok'})
    const {url, close} = await startProxy(TEST_TOKEN, upstream.url)

    // #when
    const res = await httpGet(`${url}/api`, {Authorization: `Bearer ${TEST_TOKEN}`})

    // #then
    expect(res.statusCode).toBe(200)

    await close()
    await upstream.close()
  })

  it('uses the env var value when it is a valid positive integer ("150")', async () => {
    // #given — valid positive integer → used as the timeout
    // We verify by pointing at a stalled upstream and observing the 504 fires
    // within the configured window (not the 30s default).
    process.env[ENV_KEY] = '150'
    const upstream = await startStalledUpstream()
    // No explicit timeoutMs → readProxyTimeoutMs() returns 150
    const {url, close} = await startProxy(TEST_TOKEN, upstream.url)

    const start = Date.now()

    // #when
    const res = await httpGet(`${url}/api`, {Authorization: `Bearer ${TEST_TOKEN}`})
    const elapsed = Date.now() - start

    // #then — timed out at ~150ms (not the 30s default)
    expect(res.statusCode).toBe(504)
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(elapsed).toBeLessThan(3000)

    await close()
    await upstream.close()
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

// ── Teardown logging (#1889) ─────────────────────────────────────────────────

interface LoggedCall {
  readonly level: 'info' | 'warn' | 'error'
  readonly msg: string
  readonly meta: Record<string, unknown> | undefined
}

function makeCapturingLogger(): {
  readonly logger: {
    readonly info: (msg: string, meta?: Record<string, unknown>) => void
    readonly warn: (msg: string, meta?: Record<string, unknown>) => void
    readonly error: (msg: string, meta?: Record<string, unknown>) => void
  }
  readonly calls: LoggedCall[]
} {
  const calls: LoggedCall[] = []
  return {
    calls,
    logger: {
      info: (msg, meta) => calls.push({level: 'info', msg, meta}),
      warn: (msg, meta) => calls.push({level: 'warn', msg, meta}),
      error: (msg, meta) => calls.push({level: 'error', msg, meta}),
    },
  }
}

/** Make a raw http.request with any method and optional body. Always Connection: close. */
async function httpSend(
  method: string,
  url: string,
  reqHeaders: Record<string, string> = {},
  body?: string,
): Promise<StubResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const headers: Record<string, string> = {...reqHeaders, connection: 'close'}
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
    const req = http.request(
      {hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method, headers},
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
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** Negative assertions need the server-side `close` events to have had a chance to fire. */
async function letLogsSettle(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 50)
  })
}

function teardownCalls(calls: readonly LoggedCall[]): readonly LoggedCall[] {
  return calls.filter(call => call.msg.startsWith('opencode-proxy: session abort'))
}

/**
 * An upstream that accepts a request and never answers it until `release()`. `requestSeen` resolves
 * once a request has arrived, so a test can act while the proxy is mid-forward.
 */
async function startHangingUpstream(): Promise<{
  readonly url: string
  readonly requestSeen: Promise<void>
  readonly release: () => void
  readonly close: () => Promise<void>
}> {
  const held: http.ServerResponse[] = []
  let markSeen: () => void = () => {}
  const requestSeen = new Promise<void>(resolve => {
    markSeen = resolve
  })
  const stub = http.createServer((_req, res) => {
    held.push(res)
    markSeen()
  })
  await new Promise<void>((resolve, reject) => {
    stub.once('error', reject)
    stub.listen(0, '127.0.0.1', resolve)
  })
  const addr = stub.address() as AddressInfo
  const release = (): void => {
    for (const res of held.splice(0)) {
      res.writeHead(200, {'Content-Length': '0', Connection: 'close'})
      res.end()
    }
  }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requestSeen,
    release,
    close: async () => {
      release()
      await new Promise<void>(resolve => {
        stub.close(() => resolve())
        stub.closeAllConnections()
      })
    },
  }
}

describe('opencode-proxy — session teardown logging', () => {
  const AUTH = {Authorization: `Bearer ${TEST_TOKEN}`}
  let upstream: Awaited<ReturnType<typeof startUpstreamStub>> | undefined
  let closeProxy: (() => Promise<void>) | undefined

  afterEach(async () => {
    await closeProxy?.()
    await upstream?.close()
    closeProxy = undefined
    upstream = undefined
  })

  async function startLoggedProxy(upstreamUrl: string): Promise<{url: string; calls: LoggedCall[]}> {
    const {logger, calls} = makeCapturingLogger()
    const proxy = createOpencodeProxy({token: TEST_TOKEN, upstreamUrl, logger})
    await proxy.listen(0, '127.0.0.1')
    const addr = proxy.server.address() as AddressInfo
    closeProxy = async () => proxy.close()
    return {url: `http://127.0.0.1:${addr.port}`, calls}
  }

  it('logs a proxied abort at info with the session id, upstream status and duration', async () => {
    // #given
    upstream = await startUpstreamStub({responseStatus: 200, responseBody: 'true'})
    const {url, calls} = await startLoggedProxy(upstream.url)

    // #when
    const res = await httpSend('POST', `${url}/session/ses_abc123/abort?directory=/workspace/repos/acme/widget`, AUTH)

    // #then
    expect(res.statusCode).toBe(200)
    await vi.waitFor(() => expect(teardownCalls(calls)).toHaveLength(1))
    const [entry] = teardownCalls(calls)
    expect(entry?.level).toBe('info')
    expect(entry?.msg).toBe('opencode-proxy: session abort forwarded')
    expect(entry?.meta).toEqual({
      sessionId: 'ses_abc123',
      status: 200,
      durationMs: expect.any(Number) as number,
    })
    expect(entry?.meta?.durationMs as number).toBeGreaterThanOrEqual(0)
  })

  it('logs the upstream status when OpenCode rejects the abort', async () => {
    // #given
    upstream = await startUpstreamStub({responseStatus: 404, responseBody: 'not found'})
    const {url, calls} = await startLoggedProxy(upstream.url)

    // #when
    await httpSend('POST', `${url}/session/ses_gone/abort`, AUTH)

    // #then
    await vi.waitFor(() => expect(teardownCalls(calls)).toHaveLength(1))
    expect(teardownCalls(calls)[0]?.meta).toMatchObject({sessionId: 'ses_gone', status: 404})
  })

  it('logs the 502 the caller saw when the upstream is unreachable', async () => {
    // #given — nothing listens upstream
    const {url, calls} = await startLoggedProxy('http://127.0.0.1:1')

    // #when
    const res = await httpSend('POST', `${url}/session/ses_down/abort`, AUTH)

    // #then
    expect(res.statusCode).toBe(502)
    await vi.waitFor(() => expect(teardownCalls(calls)).toHaveLength(1))
    expect(teardownCalls(calls)[0]?.meta).toMatchObject({sessionId: 'ses_down', status: 502})
  })

  it('logs the 504 the proxy itself synthesizes when the upstream stops answering', async () => {
    // #given an upstream that accepts the abort and never responds, and a short inactivity window
    const hanging = await startHangingUpstream()
    const {logger, calls} = makeCapturingLogger()
    const proxy = createOpencodeProxy({token: TEST_TOKEN, upstreamUrl: hanging.url, logger, timeoutMs: 100})
    await proxy.listen(0, '127.0.0.1')
    const addr = proxy.server.address() as AddressInfo
    closeProxy = async () => {
      await proxy.close()
      await hanging.close()
    }

    // #when
    const res = await httpSend('POST', `http://127.0.0.1:${addr.port}/session/ses_stuck/abort`, AUTH)

    // #then the caller got the proxy's own 504, and that is the status in the log, not the upstream's
    expect(res.statusCode).toBe(504)
    await vi.waitFor(() => expect(teardownCalls(calls)).toHaveLength(1))
    expect(teardownCalls(calls)[0]?.meta).toEqual({
      sessionId: 'ses_stuck',
      status: 504,
      durationMs: expect.any(Number) as number,
    })
    expect(teardownCalls(calls)[0]?.meta?.durationMs as number).toBeGreaterThanOrEqual(90)
  })

  it('logs once, with no status, when the caller disconnects before any header is sent', async () => {
    // #given an upstream that is still holding the abort when the caller gives up
    const hanging = await startHangingUpstream()
    const {logger, calls} = makeCapturingLogger()
    const proxy = createOpencodeProxy({token: TEST_TOKEN, upstreamUrl: hanging.url, logger})
    await proxy.listen(0, '127.0.0.1')
    const addr = proxy.server.address() as AddressInfo
    closeProxy = async () => {
      await proxy.close()
      await hanging.close()
    }
    const clientReq = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path: '/session/ses_left/abort',
      method: 'POST',
      headers: {...AUTH, connection: 'close'},
    })
    clientReq.on('error', () => {})
    clientReq.end()
    await hanging.requestSeen

    // #when the caller disconnects mid-forward, and the upstream then answers after the fact
    clientReq.destroy()
    await vi.waitFor(() => expect(teardownCalls(calls)).toHaveLength(1))
    hanging.release()
    await letLogsSettle()

    // #then exactly one line: session id and duration, and no status field at all
    expect(teardownCalls(calls)).toHaveLength(1)
    const meta = teardownCalls(calls)[0]?.meta
    expect(meta).toEqual({sessionId: 'ses_left', durationMs: expect.any(Number) as number})
    expect(Object.keys(meta ?? {})).not.toContain('status')
  })

  it('never logs the bearer token, the Authorization header, the request body, or the query string', async () => {
    // #given
    upstream = await startUpstreamStub({responseStatus: 200, responseBody: 'true'})
    const {url, calls} = await startLoggedProxy(upstream.url)

    // #when
    await httpSend(
      'POST',
      `${url}/session/ses_abc123/abort?directory=/workspace/repos/acme/widget`,
      {...AUTH, 'content-type': 'application/json'},
      '{"reason":"super-secret-body-content"}',
    )

    // #then
    await vi.waitFor(() => expect(teardownCalls(calls)).toHaveLength(1))
    const logged = JSON.stringify(calls)
    expect(logged).not.toContain(TEST_TOKEN)
    expect(logged.toLowerCase()).not.toContain('authorization')
    expect(logged.toLowerCase()).not.toContain('bearer')
    expect(logged).not.toContain('super-secret-body-content')
    expect(logged).not.toContain('/workspace/repos')
  })

  it('does not log unauthorized aborts as forwarded teardown, and still keeps the token out of logs', async () => {
    // #given
    upstream = await startUpstreamStub({responseStatus: 200})
    const {url, calls} = await startLoggedProxy(upstream.url)

    // #when
    const res = await httpSend('POST', `${url}/session/ses_abc123/abort`, {Authorization: 'Bearer wrong-token'})

    // #then
    expect(res.statusCode).toBe(401)
    await letLogsSettle()
    expect(teardownCalls(calls)).toHaveLength(0)
    expect(JSON.stringify(calls)).not.toContain('wrong-token')
  })

  it('does not log ordinary session traffic or a GET on the abort path', async () => {
    // #given
    upstream = await startUpstreamStub({responseStatus: 200})
    const {url, calls} = await startLoggedProxy(upstream.url)

    // #when
    await httpSend('GET', `${url}/session/ses_abc123/message`, AUTH)
    await httpSend('GET', `${url}/session/ses_abc123/abort`, AUTH)
    await httpSend('POST', `${url}/session/ses_abc123/prompt_async`, AUTH, '{}')
    await httpSend('GET', `${url}/session/status`, AUTH)

    // #then
    await letLogsSettle()
    expect(calls.filter(call => call.level === 'info' && call.msg.includes('forwarded'))).toHaveLength(0)
  })

  it('logs other teardown calls the same way: session delete and instance/global dispose', async () => {
    // #given
    upstream = await startUpstreamStub({responseStatus: 200, responseBody: 'true'})
    const {url, calls} = await startLoggedProxy(upstream.url)

    // #when
    await httpSend('DELETE', `${url}/session/ses_del1`, AUTH)
    await httpSend('POST', `${url}/instance/dispose?directory=/workspace/repos/acme/widget`, AUTH)
    await httpSend('POST', `${url}/global/dispose`, AUTH)

    // #then
    const forwarded = (): readonly LoggedCall[] => calls.filter(call => call.msg.endsWith('forwarded'))
    await vi.waitFor(() => expect(forwarded()).toHaveLength(3))
    const byMessage = Object.fromEntries(forwarded().map(call => [call.msg, call]))
    expect(byMessage['opencode-proxy: session delete forwarded']?.meta).toMatchObject({
      sessionId: 'ses_del1',
      status: 200,
    })
    expect(byMessage['opencode-proxy: instance dispose forwarded']?.meta).toMatchObject({status: 200})
    expect(byMessage['opencode-proxy: global dispose forwarded']?.meta).toMatchObject({status: 200})
    expect(JSON.stringify(calls)).not.toContain('/workspace/repos')
  })

  it('ignores a session id segment that is not a plain identifier', async () => {
    // #given
    upstream = await startUpstreamStub({responseStatus: 200})
    const {url, calls} = await startLoggedProxy(upstream.url)

    // #when
    await httpSend('POST', `${url}/session/ses%0d%0aforged/abort`, AUTH)

    // #then
    await letLogsSettle()
    expect(calls.filter(call => call.msg.endsWith('forwarded'))).toHaveLength(0)
  })
})

// ── Teardown in both directions ─────────────────────────────────────────────────
//
// A proxied response whose upstream dies mid-way must end the downstream response, and a proxied SSE
// stream whose downstream client goes away must end the upstream request. Every wait below is bounded so a
// regression fails in about a second instead of hanging the suite.

describe('opencode-proxy — closes both directions', () => {
  const BOUND_MS = 1_500
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  /** Rejects if `promise` has not settled within `ms`, naming what it was waiting for. */
  async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms)
    })
    try {
      return await Promise.race([promise, bound])
    } finally {
      clearTimeout(timer)
    }
  }

  async function startRawUpstream(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    })
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  async function startProxyFor(upstreamUrl: string): Promise<string> {
    const proxy = createOpencodeProxy({token: TEST_TOKEN, upstreamUrl, logger: makeLogger()})
    await proxy.listen(0, '127.0.0.1')
    cleanups.push(async () => {
      proxy.server.closeAllConnections()
      await proxy.close()
    })
    return `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`
  }

  interface Downstream {
    readonly req: http.ClientRequest
    readonly response: Promise<http.IncomingMessage>
    /** Resolves when the response is gone, and says whether it had completed. */
    readonly closed: Promise<{readonly complete: boolean; readonly received: string}>
    readonly firstChunk: Promise<string>
  }

  function getThroughProxy(proxyUrl: string, path: string): Downstream {
    const received: string[] = []
    let resolveFirst: (chunk: string) => void = () => {}
    const firstChunk = new Promise<string>(resolve => {
      resolveFirst = resolve
    })
    let resolveResponse: (res: http.IncomingMessage) => void = () => {}
    let rejectResponse: (error: Error) => void = () => {}
    const response = new Promise<http.IncomingMessage>((resolve, reject) => {
      resolveResponse = resolve
      rejectResponse = reject
    })
    let resolveClosed: (value: {complete: boolean; received: string}) => void = () => {}
    const closed = new Promise<{complete: boolean; received: string}>(resolve => {
      resolveClosed = resolve
    })
    const parsed = new URL(proxyUrl)
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path,
        method: 'GET',
        agent: false,
        headers: {authorization: `Bearer ${TEST_TOKEN}`, connection: 'close'},
      },
      res => {
        resolveResponse(res)
        res.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8')
          received.push(text)
          resolveFirst(text)
        })
        res.on('error', () => undefined)
        res.on('close', () => {
          resolveClosed({complete: res.complete, received: received.join('')})
        })
      },
    )
    req.on('error', (error: Error) => {
      rejectResponse(error)
      resolveClosed({complete: false, received: received.join('')})
    })
    req.end()
    return {req, response, closed, firstChunk}
  }

  it('closes the downstream SSE response when the upstream socket dies after headers and one chunk', async () => {
    // #given an upstream SSE stream that sends headers and one event, then loses its socket
    const upstreamUrl = await startRawUpstream((_req, res) => {
      res.writeHead(200, {'Content-Type': 'text/event-stream'})
      res.write('data: one\n\n', () => {
        setTimeout(() => res.socket?.destroy(), 20)
      })
    })
    const proxyUrl = await startProxyFor(upstreamUrl)

    // #when a client reads the stream through the proxy
    const downstream = getThroughProxy(proxyUrl, '/event')

    // #then the client saw the event and then the stream ended, instead of hanging open
    const result = await within(downstream.closed, BOUND_MS, 'the downstream SSE response to close')
    expect(result.received).toContain('data: one')
    expect(result.complete).toBe(false)
  })

  it('closes the downstream response when a non-SSE upstream body is destroyed mid-body', async () => {
    // #given an upstream that promises 100 bytes, sends part of them, then loses its socket
    const upstreamUrl = await startRawUpstream((_req, res) => {
      res.writeHead(200, {'Content-Type': 'application/json', 'Content-Length': '100'})
      res.write('{"partial":', () => {
        setTimeout(() => res.socket?.destroy(), 20)
      })
    })
    const proxyUrl = await startProxyFor(upstreamUrl)

    // #when
    const downstream = getThroughProxy(proxyUrl, '/session')

    // #then the client's response ends, incomplete, instead of waiting for the inactivity timer
    const result = await within(downstream.closed, BOUND_MS, 'the downstream response to close')
    expect(result.complete).toBe(false)
  })

  it('delivers a completed non-SSE response whole, and complete', async () => {
    // #given an upstream that answers normally
    const body = JSON.stringify({ok: true, items: [1, 2, 3]})
    const upstreamUrl = await startRawUpstream((_req, res) => {
      res.writeHead(200, {'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body))})
      res.end(body)
    })
    const proxyUrl = await startProxyFor(upstreamUrl)

    // #when
    const downstream = getThroughProxy(proxyUrl, '/session')

    // #then
    const result = await within(downstream.closed, BOUND_MS, 'the downstream response to finish')
    expect(result.complete).toBe(true)
    expect(result.received).toBe(body)
  })

  it('delivers a completed SSE response whole, and complete', async () => {
    // #given an SSE upstream that ends its stream cleanly
    const upstreamUrl = await startRawUpstream((_req, res) => {
      res.writeHead(200, {'Content-Type': 'text/event-stream'})
      res.write('data: one\n\n')
      res.end('data: two\n\n')
    })
    const proxyUrl = await startProxyFor(upstreamUrl)

    // #when
    const downstream = getThroughProxy(proxyUrl, '/event')

    // #then
    const result = await within(downstream.closed, BOUND_MS, 'the downstream SSE response to finish')
    expect(result.complete).toBe(true)
    expect(result.received).toBe('data: one\n\ndata: two\n\n')
  })

  it('closes the upstream /event request when an SSE client disconnects', async () => {
    // #given an upstream SSE stream that stays open and reports when its connection closes
    let resolveUpstreamClosed: () => void = () => {}
    const upstreamClosed = new Promise<void>(resolve => {
      resolveUpstreamClosed = resolve
    })
    const upstreamUrl = await startRawUpstream((_req, res) => {
      res.writeHead(200, {'Content-Type': 'text/event-stream'})
      res.write('data: connected\n\n')
      res.on('close', resolveUpstreamClosed)
    })
    const proxyUrl = await startProxyFor(upstreamUrl)
    const downstream = getThroughProxy(proxyUrl, '/event')
    await within(downstream.firstChunk, BOUND_MS, 'the first SSE event')

    // #when the client goes away
    downstream.req.destroy()

    // #then the proxy ends its upstream request instead of holding the stream open
    await expect(within(upstreamClosed, BOUND_MS, 'the upstream /event connection to close')).resolves.toBeUndefined()
  })

  it('leaves the upstream request alone when a non-SSE client disconnects mid-response', async () => {
    // #given a non-SSE upstream that sends part of a body and then waits
    let resolveUpstreamClosed: () => void = () => {}
    const upstreamClosed = new Promise<void>(resolve => {
      resolveUpstreamClosed = resolve
    })
    let upstreamRes: http.ServerResponse | undefined
    const upstreamUrl = await startRawUpstream((_req, res) => {
      upstreamRes = res
      res.writeHead(200, {'Content-Type': 'application/json', 'Content-Length': '100'})
      res.write('{"partial":')
      res.on('close', resolveUpstreamClosed)
    })
    const proxyUrl = await startProxyFor(upstreamUrl)
    const downstream = getThroughProxy(proxyUrl, '/session')
    await within(downstream.firstChunk, BOUND_MS, 'the first body chunk')

    // #when the client goes away
    downstream.req.destroy()
    const outcome = await Promise.race([
      upstreamClosed.then(() => 'upstream-closed' as const),
      new Promise<'still-open'>(resolve => setTimeout(() => resolve('still-open'), 300)),
    ])

    // #then the new SSE handler did not touch it: only an SSE response tears the upstream down on a client close
    expect(outcome).toBe('still-open')
    upstreamRes?.destroy()
  })
})
