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
async function startProxy(token: string, upstreamUrl: string): Promise<{url: string; close: () => Promise<void>}> {
  const proxy = createOpencodeProxy({token, upstreamUrl, logger: makeLogger()})
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
