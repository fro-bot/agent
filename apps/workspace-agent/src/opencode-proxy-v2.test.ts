/**
 * Tests for opencode-proxy-v2.ts: the bearer-to-Basic reverse proxy for a stock OpenCode V2 server.
 *
 * The upstream is a real local http stub that behaves like `serve --stdio` in the ways the proxy depends on (probe
 * P14): Basic auth with a per-spawn password, an identical 401 body for every auth failure, `x-opencode-directory`
 * selecting the location, and an uncompressed SSE stream with a heartbeat comment. Requests use `http.request` for
 * precise connection control.
 */

import type {AddressInfo} from 'node:net'
import type {Logger} from './opencode-server.js'

import {Buffer} from 'node:buffer'
import http from 'node:http'

import {afterEach, describe, expect, it} from 'vitest'

import {createOpencodeProxyV2} from './opencode-proxy-v2.js'
import {createUpstreamCredentials} from './opencode-server-v2.js'

const TOKEN = 'gateway-bearer-token-xyz'

interface LogLine {
  readonly level: 'error' | 'info' | 'warn'
  readonly message: string
  readonly meta?: Record<string, unknown>
}

function makeLogger(): {logger: Logger; lines: LogLine[]} {
  const lines: LogLine[] = []
  const record =
    (level: LogLine['level']) =>
    (message: string, meta?: Record<string, unknown>): void => {
      lines.push({level, message, ...(meta === undefined ? {} : {meta})})
    }
  return {logger: {info: record('info'), warn: record('warn'), error: record('error')}, lines}
}

interface Seen {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly headers: http.IncomingHttpHeaders
  readonly body: string
}

interface Upstream {
  readonly url: string
  /** The password the server currently holds. Changing it simulates a respawn. */
  password: string
  readonly seen: Seen[]
  readonly close: () => Promise<void>
  readonly openSse: () => number
}

async function startUpstream(initialPassword: string): Promise<Upstream> {
  const seen: Seen[] = []
  let sseOpen = 0
  const state = {password: initialPassword}
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8')})
      const expected = `Basic ${Buffer.from(`opencode:${state.password}`).toString('base64')}`
      if (req.headers.authorization !== expected) {
        // The same body for every failure, and no WWW-Authenticate header (P14).
        const body = JSON.stringify({_tag: 'UnauthorizedError', message: 'Authentication required'})
        res.writeHead(401, {'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body))})
        res.end(body)
        return
      }
      if (req.url === '/api/event') {
        sseOpen += 1
        res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform'})
        res.write(': heartbeat\n\n')
        res.write('data: {"type":"server.connected"}\n\n')
        res.once('close', () => {
          sseOpen -= 1
        })
        return
      }
      if (req.url === '/api/slow') return
      const body = JSON.stringify({directory: req.headers['x-opencode-directory'] ?? null, echoed: req.url})
      res.writeHead(200, {'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body))})
      res.end(body)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    get password() {
      return state.password
    },
    set password(value: string) {
      state.password = value
    },
    seen,
    openSse: () => sseOpen,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

interface Reply {
  readonly status: number
  readonly headers: http.IncomingHttpHeaders
  readonly body: string
}

async function request(
  base: string,
  options: {method?: string; path: string; headers?: Record<string, string>; body?: string},
): Promise<Reply> {
  const parsed = new URL(base)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: {connection: 'close', ...options.headers},
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8')}),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

const BEARER = {authorization: `Bearer ${TOKEN}`}

function basic(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
}

describe('opencode-proxy-v2', () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  async function setup(options: {password?: string; credentialed?: boolean; timeoutMs?: number} = {}) {
    const upstream = await startUpstream(options.password ?? 'pw-one')
    const credentials = createUpstreamCredentials()
    if (options.credentialed !== false) credentials.set(() => basic(upstream.password))
    const {logger, lines} = makeLogger()
    const proxy = createOpencodeProxyV2({
      token: TOKEN,
      upstreamUrl: upstream.url,
      logger,
      credentials,
      timeoutMs: options.timeoutMs,
    })
    await proxy.listen(0, '127.0.0.1')
    const url = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`
    cleanups.push(async () => upstream.close())
    cleanups.push(async () => {
      proxy.server.closeAllConnections()
      await proxy.close()
    })
    return {upstream, credentials, proxy, url, lines}
  }

  it('turns the caller bearer into the server Basic credential and drops the bearer', async () => {
    // #given
    const {upstream, url} = await setup()

    // #when a request carries the gateway bearer
    const reply = await request(url, {path: '/api/info', headers: BEARER})

    // #then the server saw Basic auth with its password, never the bearer
    expect(reply.status).toBe(200)
    expect(upstream.seen[0]?.headers.authorization).toBe(basic('pw-one'))
    expect(JSON.stringify(upstream.seen)).not.toContain(TOKEN)
  })

  it('passes x-opencode-directory through untouched', async () => {
    // #given
    const {upstream, url} = await setup()

    // #when
    const reply = await request(url, {
      path: '/api/session',
      headers: {...BEARER, 'x-opencode-directory': '%2Fworkspace%2Frepos%2Facme%2Fwidget'},
    })

    // #then the location the gateway chose is the location the server used
    expect((JSON.parse(reply.body) as {directory: string}).directory).toBe('%2Fworkspace%2Frepos%2Facme%2Fwidget')
    expect(upstream.seen[0]?.headers['x-opencode-directory']).toBe('%2Fworkspace%2Frepos%2Facme%2Fwidget')
  })

  it('forwards the method, path, query and body', async () => {
    // #given
    const {upstream, url} = await setup()

    // #when
    await request(url, {
      method: 'POST',
      path: '/api/session/ses_1/prompt?x=1',
      headers: {...BEARER, 'content-type': 'application/json', 'content-length': '13'},
      body: '{"text":"hi"}',
    })

    // #then
    expect(upstream.seen[0]).toMatchObject({
      method: 'POST',
      url: '/api/session/ses_1/prompt?x=1',
      body: '{"text":"hi"}',
    })
  })

  it('answers 401 and forwards nothing when the bearer is missing or wrong', async () => {
    // #given
    const {upstream, url} = await setup()

    // #when
    const missing = await request(url, {path: '/api/info'})
    const wrong = await request(url, {path: '/api/info', headers: {authorization: 'Bearer nope'}})
    const basicScheme = await request(url, {path: '/api/info', headers: {authorization: basic('pw-one')}})

    // #then the fixed body, and the server never saw a request
    for (const reply of [missing, wrong, basicScheme]) {
      expect(reply.status).toBe(401)
      expect(reply.body).toBe('Unauthorized\n')
    }
    expect(upstream.seen).toHaveLength(0)
  })

  it('never logs the bearer or the server credential', async () => {
    // #given
    const {url, lines} = await setup()

    // #when a bad request and a good one both pass through
    await request(url, {path: '/api/info', headers: {authorization: 'Bearer wrong-token-value'}})
    await request(url, {path: '/api/info', headers: BEARER})

    // #then
    const serialized = JSON.stringify(lines)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('wrong-token-value')
    expect(serialized).not.toContain(Buffer.from('opencode:pw-one').toString('base64'))
    expect(serialized).not.toContain('pw-one')
  })

  it('answers 503 and forwards nothing while no server is ready', async () => {
    // #given a proxy whose server has not published a credential yet
    const {upstream, url} = await setup({credentialed: false})

    // #when
    const reply = await request(url, {path: '/api/info', headers: BEARER})

    // #then a request is never sent unauthenticated to a server that is not the current one
    expect(reply.status).toBe(503)
    expect(reply.body).toBe('Service Unavailable\n')
    expect(upstream.seen).toHaveLength(0)
  })

  it('uses the new password for the next request after a respawn', async () => {
    // #given a ready server, then a respawn that rotates the password in the holder
    const {upstream, credentials, url} = await setup({password: 'pw-one'})
    expect((await request(url, {path: '/api/info', headers: BEARER})).status).toBe(200)
    credentials.clear()
    upstream.password = 'pw-two'
    credentials.set(() => basic('pw-two'))

    // #when
    const reply = await request(url, {path: '/api/info', headers: BEARER})

    // #then the proxy read the holder again and the request succeeds
    expect(reply.status).toBe(200)
    expect(upstream.seen.at(-1)?.headers.authorization).toBe(basic('pw-two'))
  })

  it('reports an upstream 401 as an authentication failure, not as a missing server or a bad bearer', async () => {
    // #given a holder that is stale: the server was respawned and the holder was not updated
    const {upstream, credentials, url, lines} = await setup({password: 'pw-one'})
    credentials.set(() => basic('pw-one'))
    upstream.password = 'pw-rotated'

    // #when
    const reply = await request(url, {path: '/api/info', headers: BEARER})

    // #then the caller can tell it from its own 401 (wrong bearer) and from a 502 (nothing listening)
    expect(reply.status).toBe(502)
    expect(reply.body).toBe('Upstream Authentication Failed\n')
    expect(reply.headers['x-fro-bot-proxy-error']).toBe('upstream-auth')
    const failure = lines.find(line => line.message.includes('rejected the credential'))
    expect(failure?.level).toBe('error')
    expect(JSON.stringify(lines)).not.toContain('pw-one')
  })

  it('answers 502 when the server is not listening', async () => {
    // #given an upstream that is gone
    const {upstream, url} = await setup()
    await upstream.close()

    // #when
    const reply = await request(url, {path: '/api/info', headers: BEARER})

    // #then
    expect(reply.status).toBe(502)
    expect(reply.body).toBe('Bad Gateway\n')
  })

  it('returns a 504 for a stalled non-streaming request, with a 30s default replaced by the option', async () => {
    // #given an upstream that accepts and never answers
    const {url} = await setup({timeoutMs: 80})

    // #when
    const reply = await request(url, {path: '/api/slow', headers: BEARER})

    // #then
    expect(reply.status).toBe(504)
  })

  it('streams SSE without compression, delivers the heartbeat comment, and is exempt from the timeout', async () => {
    // #given a short inactivity timeout
    const {upstream, url} = await setup({timeoutMs: 60})
    const received: string[] = []
    let contentType: string | undefined
    let contentEncoding: string | undefined
    const parsed = new URL(url)

    // #when a client holds the event stream open well past the timeout
    const connection = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: '/api/event',
        headers: {...BEARER, accept: 'text/event-stream', 'accept-encoding': 'gzip, deflate, br'},
      },
      res => {
        contentType = res.headers['content-type']
        contentEncoding = res.headers['content-encoding']
        res.on('data', (chunk: Buffer) => received.push(chunk.toString('utf8')))
      },
    )
    connection.end()
    await new Promise<void>(resolve => setTimeout(resolve, 250))

    // #then the stream is intact: first events arrived, the connection is still open, and nothing was compressed
    expect(contentType).toBe('text/event-stream')
    expect(contentEncoding).toBeUndefined()
    expect(received.join('')).toContain(': heartbeat')
    expect(received.join('')).toContain('server.connected')
    expect(upstream.openSse()).toBe(1)

    // #and a departed client releases the upstream stream
    connection.destroy()
    await new Promise<void>(resolve => setTimeout(resolve, 150))
    expect(upstream.openSse()).toBe(0)
  })

  describe('teardown logging', () => {
    it('logs an interrupt with the session id, the status the caller saw, and no directory', async () => {
      // #given
      const {url, lines} = await setup()

      // #when
      await request(url, {
        method: 'POST',
        path: '/api/session/ses_abc123/interrupt',
        headers: {...BEARER, 'x-opencode-directory': '%2Fworkspace%2Frepos%2Fsecret-org%2Fsecret-repo'},
      })
      await new Promise<void>(resolve => setTimeout(resolve, 20))

      // #then
      const line = lines.find(l => l.message === 'opencode-proxy-v2: session interrupt forwarded')
      expect(line?.meta).toMatchObject({sessionId: 'ses_abc123', status: 200})
      expect(JSON.stringify(lines)).not.toContain('secret-repo')
    })

    it('logs session delete, location evict and location reload', async () => {
      // #given
      const {url, lines} = await setup()

      // #when
      await request(url, {method: 'DELETE', path: '/api/session/ses_abc123', headers: BEARER})
      await request(url, {
        method: 'DELETE',
        path: '/api/debug/location?location[directory]=%2Fworkspace%2Frepos%2Fa%2Fb',
        headers: BEARER,
      })
      await request(url, {method: 'POST', path: '/api/location/reload', headers: BEARER})
      await new Promise<void>(resolve => setTimeout(resolve, 20))

      // #then each teardown request is recorded once, and the query string (which carries the directory) is not
      const messages = lines.map(line => line.message)
      expect(messages).toContain('opencode-proxy-v2: session delete forwarded')
      expect(messages).toContain('opencode-proxy-v2: location evict forwarded')
      expect(messages).toContain('opencode-proxy-v2: location reload forwarded')
      expect(JSON.stringify(lines)).not.toContain('workspace%2Frepos')
    })

    it('does not log a forwarded line for an unauthorised caller', async () => {
      // #given
      const {url, lines} = await setup()

      // #when
      await request(url, {method: 'POST', path: '/api/session/ses_abc123/interrupt'})

      // #then
      expect(lines.some(line => line.message.includes('forwarded'))).toBe(false)
    })

    it('ignores ordinary requests and a session id that is not a plain identifier', async () => {
      // #given
      const {url, lines} = await setup()

      // #when
      await request(url, {method: 'POST', path: '/api/session', headers: BEARER})
      await request(url, {method: 'POST', path: '/api/session/..%2Fescape/interrupt', headers: BEARER})
      await new Promise<void>(resolve => setTimeout(resolve, 20))

      // #then
      expect(lines.filter(line => line.message.includes('forwarded'))).toEqual([])
    })
  })
})
