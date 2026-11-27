import type {IncomingHttpHeaders} from 'node:http'
import type {Logger} from '../shared/logger.js'
import type {RecordedRequest, TlsUpstream, UpstreamHandler} from './key-proxy-test-kit.js'
import type {KeyProxyMcpRouteConfig} from './key-proxy-wire.js'
import type {KeyProxyLimits, KeyProxyProviderConfig, KeyProxyServer} from './key-proxy.js'
import type {RecordedMcpExchange} from './mcp-wire.fixtures.js'
import {Buffer} from 'node:buffer'
import http from 'node:http'
import net from 'node:net'
import {gzipSync} from 'node:zlib'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {buildKeyProxyUpstream} from './key-proxy-routes.js'
import {startTlsUpstream} from './key-proxy-test-kit.js'
import {startKeyProxy} from './key-proxy.js'
import {
  MCP_2025_STATEFUL_EXCHANGES,
  MCP_2026_STATELESS_EXCHANGES,
  MCP_SESSION_EXPIRED_SENTINEL,
} from './mcp-wire.fixtures.js'

const PLACEHOLDER = 'placeholder-0123456789abcdefghijklmnopqrstuvwxyz'
const ANTHROPIC_KEY = 'sk-ant-REAL-CANARY-0001'
const OPENAI_KEY = 'sk-oai-REAL-CANARY-0002'

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function recordingLogger(): {readonly logger: Logger; readonly lines: string[]} {
  const lines: string[] = []
  const record = (message: string, context?: object): void => {
    lines.push(JSON.stringify({message, context}))
  }
  return {logger: {debug: record, info: record, warning: record, error: record}, lines}
}

interface Harness {
  readonly upstream: TlsUpstream
  readonly proxy: KeyProxyServer
  readonly lines: string[]
  readonly send: (path: string, init?: SendInit) => Promise<Reply>
}

interface SendInit {
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string | Buffer
  readonly credential?: 'none' | 'x-api-key' | 'bearer'
}

async function setup(
  handler: UpstreamHandler,
  options: {
    readonly limits?: Partial<KeyProxyLimits>
    readonly providers?: (origin: string) => KeyProxyProviderConfig[]
    /** Brokered MCP routes, built from the recording upstream's origin. */
    readonly mcp?: (origin: string) => KeyProxyMcpRouteConfig[]
    /** Leave the upstream's self-signed certificate out of the proxy's trust. */
    readonly untrusted?: boolean
  } = {},
): Promise<Harness> {
  const upstream = await startTlsUpstream(handler)
  cleanups.push(upstream.close)
  const defaultProviders = (origin: string): KeyProxyProviderConfig[] => {
    const anthropic = buildKeyProxyUpstream({
      providerId: 'anthropic',
      baseUrl: `${origin}/v1`,
      protocols: ['anthropic-messages'],
    })
    const openai = buildKeyProxyUpstream({
      providerId: 'openai',
      baseUrl: `${origin}/v1`,
      protocols: ['openai-responses', 'openai-chat'],
    })
    if (!anthropic.success || !openai.success) throw new Error('fixture upstream refused')
    return [
      {id: 'anthropic', key: ANTHROPIC_KEY, origin: anthropic.data.origin, routes: anthropic.data.routes},
      {id: 'openai', key: OPENAI_KEY, origin: openai.data.origin, routes: openai.data.routes},
    ]
  }
  const {logger, lines} = recordingLogger()
  const started = await startKeyProxy({
    providers: (options.providers ?? defaultProviders)(upstream.origin),
    ...(options.mcp === undefined ? {} : {mcp: options.mcp(upstream.origin)}),
    logger,
    ...(options.untrusted === true ? {} : {ca: upstream.ca}),
    ...(options.limits === undefined ? {} : {limits: options.limits}),
  })
  if (!started.success) throw new Error(`proxy did not start: ${started.error}`)
  cleanups.push(started.data.close)
  const proxy = started.data
  return {
    upstream,
    proxy,
    lines,
    send: async (path, init) => sendTo(proxy.port, path, init),
  }
}

async function sendTo(port: number, path: string, init: SendInit = {}): Promise<Reply> {
  const method = init.method ?? 'POST'
  const headers: Record<string, string> = {...init.headers}
  const style = init.credential ?? (path.includes('/anthropic/') ? 'x-api-key' : 'bearer')
  if (style === 'x-api-key') headers['x-api-key'] = PLACEHOLDER
  if (style === 'bearer') headers.authorization = `Bearer ${PLACEHOLDER}`
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path, method, headers}, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks)}))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(init.body)
  })
}

/** Writes raw bytes to the proxy and returns what came back before the socket closed or went quiet. */
async function rawExchange(port: number, text: string, quietMs = 300): Promise<string> {
  return new Promise<string>(resolve => {
    const socket = net.connect(port, '127.0.0.1')
    let received = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      socket.destroy()
      resolve(received)
    }
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(finish, quietMs)
    }
    socket.on('data', chunk => {
      received += chunk.toString('latin1')
      arm()
    })
    socket.on('close', finish)
    socket.on('error', finish)
    socket.write(text, 'latin1', arm)
  })
}

function sse(res: http.ServerResponse, chunks: readonly string[], gapMs = 0): void {
  res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
  let index = 0
  const next = (): void => {
    const chunk = chunks[index]
    index += 1
    if (chunk === undefined) {
      res.end()
      return
    }
    res.write(chunk)
    if (gapMs === 0) next()
    else setTimeout(next, gapMs)
  }
  next()
}

const okJson: UpstreamHandler = (_request, res) => {
  res.writeHead(200, {'content-type': 'application/json'})
  res.end('{"ok":true}')
}

function headerOf(request: RecordedRequest | undefined, name: string): string | string[] | undefined {
  return request?.headers[name]
}

describe('key proxy: routing and credentials', () => {
  it('forwards a Messages request with the real x-api-key and streams the SSE chunks in order', async () => {
    // #given an upstream that streams three SSE frames
    const frames = ['event: a\ndata: 1\n\n', 'event: b\ndata: 2\n\n', 'event: c\ndata: 3\n\n']
    const h = await setup((_request, res) => sse(res, frames))

    // #when the sandbox sends a Messages request with the placeholder
    const reply = await h.send('/anthropic/messages?beta=true', {
      headers: {'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'x'},
      body: '{"model":"m"}',
    })

    // #then the upstream saw the real key on the joined path, the stream arrived whole and in order
    const seen = h.upstream.requests[0]
    expect(seen?.url).toBe('/v1/messages?beta=true')
    expect(headerOf(seen, 'x-api-key')).toBe(ANTHROPIC_KEY)
    expect(headerOf(seen, 'anthropic-version')).toBe('2023-06-01')
    expect(headerOf(seen, 'anthropic-beta')).toBe('x')
    expect(seen?.body.toString()).toBe('{"model":"m"}')
    expect(reply.status).toBe(200)
    expect(reply.body.toString()).toBe(frames.join(''))
  })

  it('defaults anthropic-version for a Messages request that sends none', async () => {
    const h = await setup(okJson)
    await h.send('/anthropic/messages', {body: '{}'})
    expect(headerOf(h.upstream.requests[0], 'anthropic-version')).toBe('2023-06-01')
  })

  it.each([['/openai/responses'], ['/openai/responses/compact'], ['/openai/chat/completions']])(
    'forwards %s with the real Bearer token',
    async path => {
      // #given an upstream that records requests
      const h = await setup(okJson)

      // #when a Responses or Chat request carries the placeholder as a Bearer token
      const reply = await h.send(path, {body: '{}'})

      // #then the upstream sees the real token and never the placeholder
      expect(reply.status).toBe(200)
      expect(headerOf(h.upstream.requests[0], 'authorization')).toBe(`Bearer ${OPENAI_KEY}`)
      expect(JSON.stringify(h.upstream.requests[0]?.headers)).not.toContain(PLACEHOLDER)
    },
  )

  it('serves the models probe route', async () => {
    const h = await setup(okJson)
    const reply = await h.send('/openai/models', {method: 'GET'})
    expect(reply.status).toBe(200)
    expect(h.upstream.requests[0]?.url).toBe('/v1/models')
    expect(headerOf(h.upstream.requests[0], 'authorization')).toBe(`Bearer ${OPENAI_KEY}`)
  })

  it('uses each provider own key', async () => {
    const h = await setup(okJson)
    await h.send('/anthropic/messages', {body: '{}'})
    await h.send('/openai/responses', {body: '{}'})
    expect(headerOf(h.upstream.requests[0], 'x-api-key')).toBe(ANTHROPIC_KEY)
    expect(headerOf(h.upstream.requests[1], 'authorization')).toBe(`Bearer ${OPENAI_KEY}`)
  })

  const ANTHROPIC_CREDENTIAL = {header: 'x-api-key', value: ANTHROPIC_KEY, absent: 'authorization'} as const
  const OPENAI_CREDENTIAL = {header: 'authorization', value: `Bearer ${OPENAI_KEY}`, absent: 'x-api-key'} as const

  it.each([
    [
      'an x-api-key that is not the placeholder',
      '/anthropic/messages',
      {'x-api-key': 'model-level-override'},
      ANTHROPIC_CREDENTIAL,
    ],
    [
      'an Authorization that is not the placeholder',
      '/openai/chat/completions',
      {authorization: 'Bearer override'},
      OPENAI_CREDENTIAL,
    ],
    ['an x-api-key on a Bearer route', '/openai/chat/completions', {'x-api-key': 'override'}, OPENAI_CREDENTIAL],
    [
      'an Authorization on a Messages route',
      '/anthropic/messages',
      {authorization: 'Bearer override'},
      ANTHROPIC_CREDENTIAL,
    ],
    [
      'a non-Bearer Authorization',
      '/openai/chat/completions',
      {authorization: 'Basic b3ZlcnJpZGU='},
      OPENAI_CREDENTIAL,
    ],
  ])('ignores %s and forwards only the configured key', async (_name, path, headers, want) => {
    // #given an upstream that records requests
    const h = await setup(okJson)

    // #when a request carries its own credential, as a model-level override would, and not the placeholder
    const reply = await h.send(path, {body: '{}', credential: 'none', headers})

    // #then it still reaches the upstream, with only the configured key and nothing the client sent
    expect(reply.status).toBe(200)
    const seen = h.upstream.requests[0]?.headers ?? {}
    expect(seen[want.header]).toBe(want.value)
    expect(seen[want.absent]).toBeUndefined()
    expect(JSON.stringify(seen)).not.toMatch(/override|b3ZlcnJpZGU/)
  })

  it.each([
    ['/anthropic/messages', 'POST', ANTHROPIC_CREDENTIAL],
    ['/openai/chat/completions', 'POST', OPENAI_CREDENTIAL],
    ['/openai/models', 'GET', OPENAI_CREDENTIAL],
  ])('forwards %s with the configured key when the request carries no credential', async (path, method, want) => {
    // #given an upstream that records requests
    const h = await setup(okJson)

    // #when a request carries no credential header at all
    const reply = await h.send(path, {method, credential: 'none', ...(method === 'POST' ? {body: '{}'} : {})})

    // #then it is forwarded with the configured key
    expect(reply.status).toBe(200)
    expect(h.upstream.requests[0]?.headers[want.header]).toBe(want.value)
  })

  it('strips every repeated client credential header and sends one configured key', async () => {
    // #given a request that repeats Authorization and x-api-key
    const h = await setup(okJson)
    const raw = await rawExchange(
      h.proxy.port,
      'POST /openai/chat/completions HTTP/1.1\r\nHost: x\r\nauthorization: Bearer one\r\nauthorization: Bearer two\r\nx-api-key: a\r\nx-api-key: b\r\ncontent-length: 2\r\n\r\n{}',
    )

    // #then it is forwarded and the upstream sees only the configured key
    expect(raw).toMatch(/^HTTP\/1\.1 200/)
    const seen = h.upstream.requests[0]?.headers ?? {}
    expect(seen.authorization).toBe(`Bearer ${OPENAI_KEY}`)
    expect(seen['x-api-key']).toBeUndefined()
  })

  it.each([
    ['a gateway management route', '/openai/v0/management/auth-files', 'GET'],
    ['an unlisted inference route', '/openai/embeddings', 'POST'],
    ['count_tokens', '/anthropic/messages/count_tokens', 'POST'],
    ['a wrong method on a listed path', '/openai/chat/completions', 'GET'],
    ['an unlisted query', '/anthropic/messages?x=1', 'POST'],
    ['a query on a route that takes none', '/openai/responses?stream=true', 'POST'],
    ['the bare provider prefix', '/openai', 'GET'],
    ['an unknown provider prefix', '/other/chat/completions', 'POST'],
    ['no prefix', '/chat/completions', 'POST'],
    ['a prefix of the real one', '/openaix/chat/completions', 'POST'],
    ['a route of another provider protocol', '/anthropic/chat/completions', 'POST'],
  ])('answers 404 locally for %s with a valid placeholder', async (_name, path, method) => {
    // #given the allowlist for these providers
    const h = await setup(okJson)

    // #when a request with a valid placeholder asks for something else
    const reply = await h.send(path, {method, credential: path.startsWith('/anthropic') ? 'x-api-key' : 'bearer'})

    // #then it is answered locally and never forwarded
    expect(reply.status).toBe(404)
    expect(h.upstream.requests).toHaveLength(0)
  })

  it.each([
    ['/constructor/chat/completions'],
    ['/__proto__/chat/completions'],
    ['/toString/models'],
    ['/hasOwnProperty/x'],
  ])('answers 404 for the object-prototype prefix %s and keeps serving', async path => {
    // #given a proxy
    const h = await setup(okJson)

    // #when a request names a property of Object.prototype as the provider
    const reply = await h.send(path, {body: '{}'})

    // #then it is a plain 404 and the next valid request still works
    expect(reply.status).toBe(404)
    expect((await h.send('/openai/chat/completions', {body: '{}'})).status).toBe(200)
  })

  it.each([
    ['an absolute-form target', 'POST http://127.0.0.1/openai/chat/completions HTTP/1.1'],
    ['a double slash', 'POST //openai/chat/completions HTTP/1.1'],
    ['an encoded slash', 'POST /openai/chat%2fcompletions HTTP/1.1'],
    ['an encoded dot', 'POST /openai/%2e%2e/openai/chat/completions HTTP/1.1'],
    ['a dot segment', 'POST /openai/../openai/chat/completions HTTP/1.1'],
    ['a path parameter', 'POST /openai/chat/completions;x=1 HTTP/1.1'],
    ['a backslash', String.raw`POST /openai\chat/completions HTTP/1.1`],
    ['a fragment', 'POST /openai/chat/completions#x HTTP/1.1'],
    ['an empty segment', 'POST /openai//chat/completions HTTP/1.1'],
    ['a trailing slash', 'POST /openai/chat/completions/ HTTP/1.1'],
    ['an authority-form CONNECT', 'CONNECT 127.0.0.1:443 HTTP/1.1'],
  ])('rejects %s locally', async (_name, requestLine) => {
    // #given a proxy
    const h = await setup(okJson)

    // #when the raw request carries a valid placeholder
    const raw = await rawExchange(
      h.proxy.port,
      `${requestLine}\r\nHost: x\r\nauthorization: Bearer ${PLACEHOLDER}\r\ncontent-length: 2\r\n\r\n{}`,
    )

    // #then it is refused with a 4xx and nothing is forwarded
    expect(raw).toMatch(/^HTTP\/1\.1 4\d\d/)
    expect(h.upstream.requests).toHaveLength(0)
  })

  it('rejects an Upgrade request locally', async () => {
    // #given the websocket upgrade OpenCode tries first on the OpenAI Responses route
    const h = await setup(okJson)
    const raw = await rawExchange(
      h.proxy.port,
      `GET /openai/responses HTTP/1.1\r\nHost: x\r\nauthorization: Bearer ${PLACEHOLDER}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: abc\r\n\r\n`,
    )

    // #then it is refused as a plain 404 (so the client falls back to POST) and nothing is forwarded
    expect(raw).toMatch(/^HTTP\/1\.1 404/)
    expect(h.upstream.requests).toHaveLength(0)
  })

  it('rejects an Upgrade header on an otherwise valid route', async () => {
    // #given a POST on a listed route with a valid placeholder and an Upgrade header
    const h = await setup(okJson)
    const raw = await rawExchange(
      h.proxy.port,
      `POST /openai/chat/completions HTTP/1.1\r\nHost: x\r\nauthorization: Bearer ${PLACEHOLDER}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\ncontent-length: 2\r\n\r\n{}`,
    )

    // #then it is refused and nothing is forwarded
    expect(raw).toMatch(/^HTTP\/1\.1 404/)
    expect(h.upstream.requests).toHaveLength(0)
  })

  it('rejects Expect: 100-continue locally', async () => {
    const h = await setup(okJson)
    const raw = await rawExchange(
      h.proxy.port,
      `POST /openai/chat/completions HTTP/1.1\r\nHost: x\r\nauthorization: Bearer ${PLACEHOLDER}\r\nExpect: 100-continue\r\ncontent-length: 2\r\n\r\n`,
    )
    expect(raw).toMatch(/^HTTP\/1\.1 417/)
    expect(h.upstream.requests).toHaveLength(0)
  })
})

describe('key proxy: header handling', () => {
  it('forwards only the real credential when the client sends its own', async () => {
    // #given a client that adds every credential header it can think of to a Bearer route
    const h = await setup(okJson)

    // #when it sends them
    await h.send('/openai/chat/completions', {
      body: '{}',
      headers: {
        'x-api-key': 'client-key',
        'proxy-authorization': 'Basic abc',
        'x-goog-api-key': 'client-goog',
        'x-management-key': 'client-mgmt',
        cookie: 'session=client',
        'x-auth-token': 'client-token',
      },
    })

    // #then the upstream sees only the proxy's Authorization header
    const seen = h.upstream.requests[0]?.headers ?? {}
    expect(seen.authorization).toBe(`Bearer ${OPENAI_KEY}`)
    for (const name of [
      'x-api-key',
      'proxy-authorization',
      'x-goog-api-key',
      'x-management-key',
      'cookie',
      'x-auth-token',
    ]) {
      expect(seen[name]).toBeUndefined()
    }
    expect(JSON.stringify(seen)).not.toContain('client-')
  })

  it.each([['/openai/responses'], ['/openai/chat/completions']])(
    'forwards OpenAI-Organization and OpenAI-Project on %s',
    async path => {
      // #given an OpenAI route and a client that names its organization and project
      const h = await setup(okJson)

      // #when it sends them
      await h.send(path, {body: '{}', headers: {'openai-organization': 'org-abc', 'openai-project': 'proj_xyz'}})

      // #then both reach the upstream, beside the real key
      const seen = h.upstream.requests[0]?.headers ?? {}
      expect(seen['openai-organization']).toBe('org-abc')
      expect(seen['openai-project']).toBe('proj_xyz')
      expect(seen.authorization).toBe(`Bearer ${OPENAI_KEY}`)
    },
  )

  it('forwards OpenAI-Organization and OpenAI-Project on the OpenAI models route', async () => {
    const h = await setup(okJson)

    await h.send('/openai/models', {
      method: 'GET',
      headers: {'openai-organization': 'org-abc', 'openai-project': 'proj_xyz'},
    })

    expect(h.upstream.requests[0]?.headers['openai-organization']).toBe('org-abc')
    expect(h.upstream.requests[0]?.headers['openai-project']).toBe('proj_xyz')
  })

  it('does not forward OpenAI-Organization or OpenAI-Project on a Messages route', async () => {
    const h = await setup(okJson)

    await h.send('/anthropic/messages', {
      body: '{}',
      headers: {'openai-organization': 'org-abc', 'openai-project': 'proj_xyz'},
    })

    const seen = h.upstream.requests[0]?.headers ?? {}
    expect(seen['openai-organization']).toBeUndefined()
    expect(seen['openai-project']).toBeUndefined()
  })

  it('does not forward a client Authorization header on a Messages route', async () => {
    const h = await setup(okJson)
    await h.send('/anthropic/messages', {body: '{}', headers: {authorization: 'Bearer client-evil'}})
    const seen = h.upstream.requests[0]?.headers ?? {}
    expect(seen.authorization).toBeUndefined()
    expect(seen['x-api-key']).toBe(ANTHROPIC_KEY)
  })

  it('sends only the allowlisted client headers', async () => {
    const h = await setup(okJson)
    await h.send('/openai/chat/completions', {
      body: '{}',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'opencode/test',
        'x-opencode-session': 'ses_1',
        'x-custom': 'nope',
        'x-forwarded-for': '1.2.3.4',
      },
    })
    const seen = h.upstream.requests[0]?.headers ?? {}
    expect(seen['content-type']).toBe('application/json')
    expect(seen['user-agent']).toBe('opencode/test')
    expect(seen['x-opencode-session']).toBeUndefined()
    expect(seen['x-custom']).toBeUndefined()
    expect(seen['x-forwarded-for']).toBeUndefined()
  })

  it('strips hop-by-hop headers and any header named in Connection', async () => {
    // #given a client that nominates anthropic-beta and content-type in Connection and sends hop-by-hop headers
    const h = await setup(okJson)

    // #when it sends them
    await h.send('/anthropic/messages', {
      body: '{}',
      headers: {
        connection: 'keep-alive, anthropic-beta',
        'keep-alive': 'timeout=5',
        te: 'trailers',
        'proxy-connection': 'keep-alive',
        trailer: 'x',
        'anthropic-beta': 'nominated',
        'anthropic-version': '2023-06-01',
      },
    })

    // #then the nominated and hop-by-hop headers are gone and the unnominated one stays
    const seen = h.upstream.requests[0]?.headers ?? {}
    expect(seen['anthropic-beta']).toBeUndefined()
    expect(seen['keep-alive']).toBeUndefined()
    expect(seen.te).toBeUndefined()
    expect(seen['proxy-connection']).toBeUndefined()
    expect(seen.trailer).toBeUndefined()
    expect(seen['anthropic-version']).toBe('2023-06-01')
  })

  it('asks the upstream for identity encoding whatever the client asks for', async () => {
    const h = await setup(okJson)
    await h.send('/openai/chat/completions', {body: '{}', headers: {'accept-encoding': 'gzip, br'}})
    expect(h.upstream.requests[0]?.headers['accept-encoding']).toBe('identity')
  })

  it('sets the upstream Host and does not forward the client Host', async () => {
    const h = await setup(okJson)
    await h.send('/openai/chat/completions', {body: '{}', headers: {host: 'evil.example'}})
    expect(h.upstream.requests[0]?.headers.host).toBe(new URL(h.upstream.origin).host)
  })

  it('does not forward www-authenticate or free-form x- response headers, and keeps retry-after', async () => {
    // #given an upstream that sets several response headers
    const h = await setup((_request, res) => {
      res.writeHead(429, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="x"',
        'x-echo': 'free-form',
        'x-request-id': 'req_1',
        'set-cookie': 'a=b',
        'retry-after': '7',
      })
      res.end('{"error":{"type":"rate_limit_error"}}')
    })

    // #when a request is answered
    const reply = await h.send('/openai/chat/completions', {body: '{}'})

    // #then only the short list comes through
    expect(reply.status).toBe(429)
    expect(reply.headers['retry-after']).toBe('7')
    expect(reply.headers['www-authenticate']).toBeUndefined()
    expect(reply.headers['x-echo']).toBeUndefined()
    expect(reply.headers['x-request-id']).toBeUndefined()
    expect(reply.headers['set-cookie']).toBeUndefined()
    expect(reply.body.toString()).toBe('{"error":{"type":"rate_limit_error"}}')
  })
})

describe('key proxy: redirects and error bodies', () => {
  it('turns a cross-host 302 into a local 502 with no Location and no second request', async () => {
    // #given an upstream that redirects to a canary target
    const canary = await setup(okJson)
    const h = await setup((_request, res) => {
      res.writeHead(302, {location: `${canary.upstream.origin}/canary`})
      res.end()
    })

    // #when a request is answered with the redirect
    const reply = await h.send('/openai/chat/completions', {body: '{}'})

    // #then the client gets a 502 without a Location, and no one followed it
    expect(reply.status).toBe(502)
    expect(reply.headers.location).toBeUndefined()
    expect(canary.upstream.requests).toHaveLength(0)
    expect(h.upstream.requests).toHaveLength(1)
  })

  it.each([301, 303, 307, 308])('also refuses a %i', async status => {
    const h = await setup((_request, res) => {
      res.writeHead(status, {location: 'https://elsewhere.example/'})
      res.end()
    })
    const reply = await h.send('/openai/chat/completions', {body: '{}'})
    expect(reply.status).toBe(502)
    expect(reply.headers.location).toBeUndefined()
  })

  it('answers a bounded 502 when the upstream answers 101 and closes, and keeps serving', async () => {
    // #given an upstream that switches protocols for the first request, then closes the socket
    let first = true
    const h = await setup((_request, res, req) => {
      if (first) {
        first = false
        req.socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
        return
      }
      okJson(_request, res, req)
    })

    // #when a request is answered with the 101
    const started = Date.now()
    const reply = await h.send('/openai/chat/completions', {body: '{}'})

    // #then the client gets the fixed 502 at once, with nothing of the upstream in it
    expect(reply.status).toBe(502)
    expect(reply.body.toString()).toBe('Bad Gateway\n')
    expect(reply.headers.upgrade).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5000)

    // #then the next request is served
    expect((await h.send('/openai/chat/completions', {body: '{}'})).status).toBe(200)
  })

  it('redacts the key from an upstream 400 and keeps the rest of the error JSON', async () => {
    // #given an upstream error that echoes the key, raw and JSON-escaped
    const h = await setup((_request, res) => {
      res.writeHead(400, {'content-type': 'application/json'})
      res.end(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: `bad key ${OPENAI_KEY} here`,
            detail: 'context_length_exceeded',
          },
        }),
      )
    })

    // #when the error comes back
    const reply = await h.send('/openai/chat/completions', {body: '{}'})

    // #then the key is replaced everywhere and the structure survives
    expect(reply.status).toBe(400)
    const text = reply.body.toString()
    expect(text).not.toContain(OPENAI_KEY)
    const parsed = JSON.parse(text) as {error: {type: string; message: string; detail: string}}
    expect(parsed.error.type).toBe('invalid_request_error')
    expect(parsed.error.detail).toBe('context_length_exceeded')
    expect(parsed.error.message).toContain('[REDACTED]')
    expect(reply.headers['content-type']).toBe('application/json')
  })

  it('redacts every occurrence, including a JSON-escaped form', async () => {
    // #given a key with characters JSON escapes
    const keyWithQuote = String.raw`sk-has"quote\slash-0003`
    const h = await setup(
      (_request, res) => {
        res.writeHead(401, {'content-type': 'application/json'})
        res.end(JSON.stringify({a: keyWithQuote, b: [keyWithQuote, keyWithQuote]}))
      },
      {
        providers: origin => {
          const built = buildKeyProxyUpstream({
            providerId: 'openai',
            baseUrl: `${origin}/v1`,
            protocols: ['openai-chat'],
          })
          if (!built.success) throw new Error('fixture')
          return [{id: 'openai', key: keyWithQuote, origin: built.data.origin, routes: built.data.routes}]
        },
      },
    )

    // #when the error comes back
    const reply = await h.send('/openai/chat/completions', {body: '{}'})

    // #then neither form is left
    const text = reply.body.toString()
    expect(text).not.toContain(keyWithQuote)
    expect(text).not.toContain(JSON.stringify(keyWithQuote).slice(1, -1))
    expect(text.match(/\[REDACTED\]/g)).toHaveLength(3)
  })

  it('replaces a gzipped error body with a fixed generic error of the same status', async () => {
    // #given an upstream that gzips an error containing the key
    const h = await setup((_request, res) => {
      res.writeHead(400, {'content-type': 'application/json', 'content-encoding': 'gzip'})
      res.end(gzipSync(Buffer.from(JSON.stringify({error: {message: `key ${OPENAI_KEY}`}}))))
    })

    // #when the error comes back
    const reply = await h.send('/openai/chat/completions', {body: '{}'})

    // #then the client gets the generic body and no compression header
    expect(reply.status).toBe(400)
    expect(reply.body.toString()).not.toContain(OPENAI_KEY)
    expect(reply.headers['content-encoding']).toBeUndefined()
    expect(JSON.parse(reply.body.toString())).toEqual({
      error: {type: 'proxy_error', message: 'The upstream returned an error.'},
    })
  })

  it('replaces an error body over the bound, with the key straddling the bound, by a fixed generic error', async () => {
    // #given a small bound and an error whose key starts just before the bound
    const bound = 64
    const padding = 'x'.repeat(bound - 10)
    const h = await setup(
      (_request, res) => {
        res.writeHead(500, {'content-type': 'application/json'})
        res.end(`${padding}${OPENAI_KEY}${'y'.repeat(200)}`)
      },
      {limits: {maxErrorBodyBytes: bound}},
    )

    // #when the error comes back
    const reply = await h.send('/openai/chat/completions', {body: '{}'})

    // #then nothing of the body is forwarded
    expect(reply.status).toBe(500)
    const text = reply.body.toString()
    expect(text).not.toContain('xxxx')
    expect(text).not.toContain('sk-oai')
    expect(text).not.toContain('sk-')
    expect(JSON.parse(text)).toEqual({error: {type: 'proxy_error', message: 'The upstream returned an error.'}})
  })

  it('replaces a chunked error body that grows past the bound, however it is split', async () => {
    // #given an upstream that streams an error in pieces with no content-length, the key split across pieces
    const bound = 64
    const h = await setup(
      (_request, res) => {
        res.writeHead(500, {'content-type': 'application/json'})
        res.write('x'.repeat(bound - 8))
        res.write(OPENAI_KEY.slice(0, 8))
        setTimeout(() => {
          res.write(OPENAI_KEY.slice(8))
          res.end('y'.repeat(200))
        }, 30)
      },
      {limits: {maxErrorBodyBytes: bound}},
    )

    // #when the error comes back
    const reply = await h.send('/openai/chat/completions', {body: '{}'})

    // #then only the fixed generic error is forwarded
    expect(reply.status).toBe(500)
    expect(JSON.parse(reply.body.toString())).toEqual({
      error: {type: 'proxy_error', message: 'The upstream returned an error.'},
    })
  })

  it('keeps Retry-After and Retry-After-Ms of an error exactly as the upstream sent them, forwarded or replaced', async () => {
    // #given an upstream that rate limits, once with a small body and once with one over the bound
    const date = 'Wed, 21 Oct 2026 07:28:00 GMT'
    let calls = 0
    const h = await setup(
      (_request, res) => {
        calls += 1
        res.writeHead(429, {'retry-after': date, 'retry-after-ms': '1500', 'content-type': 'application/json'})
        res.end(calls === 1 ? '{}' : 'x'.repeat(400))
      },
      {limits: {maxErrorBodyBytes: 64}},
    )

    // #when both are answered
    const forwarded = await h.send('/openai/chat/completions', {body: '{}'})
    const replaced = await h.send('/openai/chat/completions', {body: '{}'})

    // #then both hints reach the client in each case
    for (const reply of [forwarded, replaced]) {
      expect(reply.status).toBe(429)
      expect(reply.headers['retry-after']).toBe(date)
      expect(reply.headers['retry-after-ms']).toBe('1500')
    }
  })

  it('refuses an upstream whose certificate it does not trust', async () => {
    // #given an upstream with a self-signed certificate that is not in the proxy's trust
    const h = await setup(okJson, {untrusted: true})

    // #when a request is made
    const reply = await h.send('/openai/chat/completions', {body: '{}'})

    // #then the TLS handshake fails, the client gets a 502, and no request (or key) reached the upstream
    expect(reply.status).toBe(502)
    expect(h.upstream.requests).toHaveLength(0)
  })

  it('answers a failed upstream connection with a fixed 502 that never names the host', async () => {
    // #given a provider whose upstream refuses connections
    const h = await setup(okJson, {
      providers: () => {
        const built = buildKeyProxyUpstream({
          providerId: 'openai',
          baseUrl: 'https://127.0.0.1:1/v1',
          protocols: ['openai-chat'],
        })
        if (!built.success) throw new Error('fixture')
        return [{id: 'openai', key: OPENAI_KEY, origin: built.data.origin, routes: built.data.routes}]
      },
    })

    // #when a request is made
    const reply = await h.send('/openai/chat/completions', {body: '{}'})

    // #then the body is fixed text
    expect(reply.status).toBe(502)
    expect(reply.body.toString()).not.toContain('127.0.0.1')
    expect(reply.body.toString()).not.toContain(':1')
  })

  it('never names the upstream host in any local error body', async () => {
    const h = await setup(okJson)
    const host = new URL(h.upstream.origin).host
    const replies = [
      await h.send('/openai/chat/completions', {body: '{}', credential: 'none'}),
      await h.send('/openai/nothing', {body: '{}'}),
      await h.send('/nobody/chat/completions', {body: '{}'}),
    ]
    for (const reply of replies) {
      expect(reply.body.toString()).not.toContain(host)
      expect(reply.body.toString()).not.toContain('127.0.0.1')
    }
  })
})

describe('key proxy: malformed input and limits', () => {
  it('answers a malformed request and still serves the next one', async () => {
    // #given a proxy
    const h = await setup((_request, res) => sse(res, ['data: 1\n\n', 'data: 2\n\n']))

    // #when garbage arrives
    const raw = await rawExchange(h.proxy.port, 'GARBAGE\r\n\r\n')

    // #then it gets an error and the next request streams
    expect(raw).toMatch(/^HTTP\/1\.1 400/)
    const reply = await h.send('/openai/chat/completions', {body: '{}'})
    expect(reply.body.toString()).toBe('data: 1\n\ndata: 2\n\n')
  })

  it('answers an oversized header with 431 and still serves the next request', async () => {
    const h = await setup(okJson, {limits: {maxHeaderBytes: 1024}})
    const raw = await rawExchange(
      h.proxy.port,
      `POST /openai/chat/completions HTTP/1.1\r\nHost: x\r\nauthorization: Bearer ${PLACEHOLDER}\r\nx-big: ${'a'.repeat(4096)}\r\n\r\n`,
    )
    expect(raw).toMatch(/^HTTP\/1\.1 431/)
    expect((await h.send('/openai/chat/completions', {body: '{}'})).status).toBe(200)
  })

  it('answers an oversized declared body with 413, sends nothing upstream, and still serves', async () => {
    const h = await setup(okJson, {limits: {maxRequestBodyBytes: 100}})
    const reply = await h.send('/openai/chat/completions', {body: 'x'.repeat(500)})
    expect(reply.status).toBe(413)
    expect(h.upstream.requests).toHaveLength(0)
    expect((await h.send('/openai/chat/completions', {body: '{}'})).status).toBe(200)
  })

  it('stops a chunked body that grows past the bound and still serves', async () => {
    // #given a bound and a chunked upload that exceeds it
    const h = await setup(okJson, {limits: {maxRequestBodyBytes: 100}})
    const raw = await rawExchange(
      h.proxy.port,
      `POST /openai/chat/completions HTTP/1.1\r\nHost: x\r\nauthorization: Bearer ${PLACEHOLDER}\r\ntransfer-encoding: chunked\r\n\r\n${(300).toString(16)}\r\n${'x'.repeat(300)}\r\n0\r\n\r\n`,
    )

    // #then the upload is refused and the proxy keeps serving
    expect(raw).toMatch(/^HTTP\/1\.1 413/)
    expect(h.upstream.requests).toHaveLength(0)
    expect((await h.send('/openai/chat/completions', {body: '{}'})).status).toBe(200)
  })

  it('refuses a connection past the cap', async () => {
    // #given a cap of two connections, both held open
    const h = await setup(okJson, {limits: {maxConnections: 2}})
    const held = [net.connect(h.proxy.port, '127.0.0.1'), net.connect(h.proxy.port, '127.0.0.1')]
    await new Promise(resolve => setTimeout(resolve, 100))

    // #when a third connects
    const third = await rawExchange(h.proxy.port, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n', 200)

    // #then it is dropped without an answer
    expect(third).toBe('')
    for (const socket of held) socket.destroy()
  })

  it('binds only the IPv4 loopback address on an ephemeral port', async () => {
    const h = await setup(okJson)
    expect(h.proxy.port).toBeGreaterThan(0)
    const raw = await rawExchange(
      h.proxy.port,
      `GET /openai/models HTTP/1.1\r\nHost: x\r\nauthorization: Bearer ${PLACEHOLDER}\r\n\r\n`,
    )
    expect(raw).toMatch(/^HTTP\/1\.1 200/)
    expect(h.proxy.address).toBe('127.0.0.1')
  })

  it('logs no header, body, path or key', async () => {
    // #given a run that exercises success and failure
    const h = await setup((_request, res) => {
      res.writeHead(400, {'content-type': 'application/json'})
      res.end(`{"echo":"${OPENAI_KEY}"}`)
    })
    await h.send('/openai/chat/completions', {body: '{"secret":"prompt-text"}', headers: {'x-custom': 'hdr-value'}})
    await h.send('/openai/chat/completions', {body: '{}', credential: 'none'})
    await h.send('/openai/missing', {body: '{}'})

    // #then nothing request-derived or secret is in the log
    const log = h.lines.join('\n')
    for (const needle of [
      OPENAI_KEY,
      PLACEHOLDER,
      'prompt-text',
      'hdr-value',
      '/chat/completions',
      '/missing',
      'Bearer',
    ]) {
      expect(log).not.toContain(needle)
    }
  })
})

/** Connects, writes `text` and resolves with what the proxy answered; the client socket stays open (write half included). */
async function rejectedConnection(
  port: number,
  text: string,
): Promise<{readonly socket: net.Socket; readonly raw: string}> {
  return new Promise((resolve, reject) => {
    // `allowHalfOpen`: after the proxy's FIN this client does not close its own side, as a hostile client would not.
    const socket = net.connect({port, host: '127.0.0.1', allowHalfOpen: true})
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('no answer from the proxy'))
    }, 3000)
    socket.once('data', chunk => {
      clearTimeout(timer)
      resolve({socket, raw: chunk.toString('latin1')})
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    socket.write(text)
  })
}

const CONNECT_REQUEST = 'CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n'
const UPGRADE_REQUEST = `GET /openai/responses HTTP/1.1\r\nHost: x\r\nauthorization: Bearer ${PLACEHOLDER}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: abc\r\n\r\n`

describe('key proxy: rejected CONNECT and Upgrade sockets', () => {
  it.each([
    ['CONNECT', CONNECT_REQUEST],
    ['Upgrade', UPGRADE_REQUEST],
  ])('survives a TCP reset after a rejected %s, even when the reset races the answer', async (_name, request) => {
    // #given a proxy, and a listener that would see the crash an unhandled socket error causes
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', onUncaught)
    cleanups.push(async () => {
      process.off('uncaughtException', onUncaught)
    })
    const h = await setup(okJson)

    // #when a client resets right after reading the rejection, and another resets before reading it
    const first = await rejectedConnection(h.proxy.port, request)
    expect(first.raw).toMatch(/^HTTP\/1\.1 40[45]/)
    first.socket.resetAndDestroy()
    const second = net.connect(h.proxy.port, '127.0.0.1')
    second.on('error', () => undefined)
    second.write(request, () => second.resetAndDestroy())
    await new Promise(resolve => setTimeout(resolve, 300))

    // #then nothing escaped, and the proxy serves the next request
    expect(uncaught).toEqual([])
    expect((await h.send('/openai/chat/completions', {body: '{}'})).status).toBe(200)
  })

  it.each([
    ['CONNECT', CONNECT_REQUEST],
    ['Upgrade', UPGRADE_REQUEST],
  ])('reclaims the slots of 64 half-open rejected %s sockets', async (_name, request) => {
    // #given the default cap of 64, and 64 clients that keep their write half open after the rejection
    const h = await setup(okJson, {limits: {rejectLingerMs: 50}})
    const held: net.Socket[] = []
    for (let index = 0; index < 64; index += 1) held.push((await rejectedConnection(h.proxy.port, request)).socket)
    cleanups.push(async () => {
      for (const socket of held) socket.destroy()
    })

    // #when the short linger passes
    await new Promise(resolve => setTimeout(resolve, 400))

    // #then the proxy closed them, so the next requests are served instead of dropped at the cap
    expect(held.every(socket => socket.destroyed || socket.readableEnded || !socket.writable)).toBe(true)
    expect((await h.send('/openai/chat/completions', {body: '{}'})).status).toBe(200)
    for (let index = 0; index < 6; index += 1) {
      expect((await rejectedConnection(h.proxy.port, request)).raw).toMatch(/^HTTP\/1\.1 40[45]/)
    }
  })

  it('closes detached sockets that are still open at shutdown, without waiting for the linger', async () => {
    // #given rejected sockets that the proxy would hold for a long linger
    const h = await setup(okJson, {limits: {rejectLingerMs: 60_000}})
    const held = await Promise.all([
      rejectedConnection(h.proxy.port, CONNECT_REQUEST),
      rejectedConnection(h.proxy.port, UPGRADE_REQUEST),
      rejectedConnection(h.proxy.port, CONNECT_REQUEST),
    ])
    cleanups.push(async () => {
      for (const {socket} of held) socket.destroy()
    })

    // #when the proxy shuts down with them open
    const started = Date.now()
    await h.proxy.close()

    // #then it finished at once and every client socket was closed
    expect(Date.now() - started).toBeLessThan(1500)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(held.every(({socket}) => socket.destroyed || socket.readableEnded)).toBe(true)
  })

  it('answers a malformed request on a connection that resets, without crashing', async () => {
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', onUncaught)
    cleanups.push(async () => {
      process.off('uncaughtException', onUncaught)
    })
    const h = await setup(okJson)

    const socket = net.connect(h.proxy.port, '127.0.0.1')
    socket.on('error', () => undefined)
    socket.write('NOT HTTP AT ALL\r\n\r\n', () => socket.resetAndDestroy())
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(uncaught).toEqual([])
    expect((await h.send('/openai/chat/completions', {body: '{}'})).status).toBe(200)
  })
})

describe('key proxy: a partial upload', () => {
  it('aborts the upstream request when the client disconnects mid-body, and keeps serving', async () => {
    // #given an upstream that records requests as they begin
    const h = await setup(okJson)

    // #when an authorized client sends the headers and part of the body, then vanishes
    const socket = net.connect(h.proxy.port, '127.0.0.1')
    socket.on('error', () => undefined)
    socket.write(
      `POST /openai/chat/completions HTTP/1.1\r\nHost: x\r\nauthorization: Bearer ${PLACEHOLDER}\r\ncontent-type: application/json\r\ncontent-length: 1000\r\n\r\n{"partial":`,
    )
    await vi.waitFor(() => {
      expect(h.upstream.connections.size).toBe(1)
    })
    socket.destroy()

    // #then the upstream request is aborted, it never completed, and the next request is served
    await vi.waitFor(() => {
      expect(h.upstream.connections.size).toBe(0)
    })
    expect(h.upstream.requests).toHaveLength(0)
    expect((await h.send('/openai/chat/completions', {body: '{}'})).status).toBe(200)
  })

  it('aborts the upstream request when the client resets mid-body', async () => {
    const h = await setup(okJson)
    const socket = net.connect(h.proxy.port, '127.0.0.1')
    socket.on('error', () => undefined)
    socket.write(
      `POST /openai/chat/completions HTTP/1.1\r\nHost: x\r\nauthorization: Bearer ${PLACEHOLDER}\r\ncontent-length: 1000\r\n\r\n{"partial":`,
    )
    await vi.waitFor(() => {
      expect(h.upstream.connections.size).toBe(1)
    })
    socket.resetAndDestroy()

    await vi.waitFor(() => {
      expect(h.upstream.connections.size).toBe(0)
    })
    expect((await h.send('/openai/chat/completions', {body: '{}'})).status).toBe(200)
  })
})

describe('key proxy: invalid chunked framing after the upstream request exists', () => {
  it.each([
    ['a chunk size that is not hexadecimal', 'zz\r\n'],
    ['a chunk that overruns its declared size', '2\r\nabcdef\r\n'],
  ])('aborts the upstream request on %s, and keeps serving', async (_name, badFraming) => {
    // #given an authorized chunked upload whose first chunk is valid, so the upstream request is under way
    const h = await setup(okJson)
    const socket = net.connect(h.proxy.port, '127.0.0.1')
    socket.on('error', () => undefined)
    socket.write(
      `POST /openai/chat/completions HTTP/1.1\r\nHost: x\r\nauthorization: Bearer ${PLACEHOLDER}\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n9\r\n{"partial\r\n`,
    )
    await vi.waitFor(() => {
      expect(h.upstream.connections.size).toBe(1)
    })

    // #when the client then sends bytes that are not valid chunk framing, and keeps the socket open
    socket.write(badFraming)

    // #then the upstream request is aborted, it never completed, and the next request is served
    await vi.waitFor(() => {
      expect(h.upstream.connections.size).toBe(0)
    })
    expect(h.upstream.requests).toHaveLength(0)
    expect((await h.send('/openai/chat/completions', {body: '{}'})).status).toBe(200)
    socket.destroy()
  })
})

describe('key proxy: streaming', () => {
  it('delivers the last bytes before closing', async () => {
    // #given an upstream that writes its terminal frame and ends at once
    const h = await setup((_request, res) => sse(res, ['data: a\n\n', 'data: [DONE]\n\n']))

    // #when the stream is read to its end
    const reply = await h.send('/openai/chat/completions', {body: '{}'})

    // #then the terminal frame is there
    expect(reply.body.toString().endsWith('data: [DONE]\n\n')).toBe(true)
  })

  it('does not cut off a long quiet gap inside a healthy stream before the idle limit', async () => {
    // #given an upstream that pauses 400 ms between frames, for longer in total than the 700 ms idle limit
    const h = await setup(
      (_request, res) => sse(res, ['data: a\n\n', 'data: b\n\n', 'data: c\n\n', 'data: d\n\n'], 400),
      {
        limits: {idleTimeoutMs: 700},
      },
    )

    // #when the stream is read
    const reply = await h.send('/openai/chat/completions', {body: '{}'})

    // #then every frame arrives: the limit is on idle time, not on the stream's lifetime
    expect(reply.body.toString()).toBe('data: a\n\ndata: b\n\ndata: c\n\ndata: d\n\n')
  })

  it('ends a stream that goes idle past the limit', async () => {
    // #given an upstream that stalls after its first frame, and a short idle limit
    const h = await setup(
      (_request, res) => {
        res.writeHead(200, {'content-type': 'text/event-stream'})
        res.write('data: a\n\n')
      },
      {limits: {idleTimeoutMs: 300}},
    )

    // #when the stream is read
    const outcome = await h.send('/openai/chat/completions', {body: '{}'}).then(
      reply => ({ended: true as const, text: reply.body.toString()}),
      () => ({ended: true as const, text: 'aborted'}),
    )

    // #then it ended on its own rather than hanging
    expect(outcome.ended).toBe(true)
  })

  it('destroys the upstream request when the client disconnects mid-stream', async () => {
    // #given an upstream that streams forever and notes when its connection closes
    let upstreamClosed: () => void = () => undefined
    const closed = new Promise<void>(resolve => {
      upstreamClosed = resolve
    })
    const h = await setup((_request, res) => {
      res.writeHead(200, {'content-type': 'text/event-stream'})
      res.write('data: a\n\n')
      res.on('close', upstreamClosed)
    })

    // #when the client reads the first frame and then hangs up
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: h.proxy.port,
          path: '/openai/chat/completions',
          method: 'POST',
          headers: {authorization: `Bearer ${PLACEHOLDER}`},
        },
        res => {
          res.once('data', () => {
            req.destroy()
            resolve()
          })
        },
      )
      req.on('error', () => undefined)
      req.on('close', () => resolve())
      req.end('{}')
      setTimeout(() => reject(new Error('no first frame')), 5000).unref()
    })

    // #then the upstream sees its connection close
    await closed
    expect(h.upstream.requests).toHaveLength(1)
  })

  it('ends the client stream with an error, and no second response, when the upstream truncates', async () => {
    // #given an upstream that promises more bytes than it sends and then drops the connection
    const h = await setup((_request, res) => {
      res.writeHead(200, {'content-type': 'text/event-stream', 'content-length': '1000'})
      res.write('data: partial\n\n')
      setTimeout(() => res.destroy(), 50)
    })

    // #when the client reads the response
    const result = await new Promise<{status: number; aborted: boolean; text: string}>(resolve => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: h.proxy.port,
          path: '/openai/chat/completions',
          method: 'POST',
          headers: {authorization: `Bearer ${PLACEHOLDER}`},
        },
        res => {
          let text = ''
          res.on('data', (chunk: Buffer) => {
            text += chunk.toString()
          })
          res.on('aborted', () => resolve({status: res.statusCode ?? 0, aborted: true, text}))
          res.on('error', () => resolve({status: res.statusCode ?? 0, aborted: true, text}))
          res.on('end', () => resolve({status: res.statusCode ?? 0, aborted: !res.complete, text}))
        },
      )
      req.on('error', () => resolve({status: 0, aborted: true, text: ''}))
      req.end('{}')
    })

    // #then the head was the one 200 and the stream did not end cleanly
    expect(result.status).toBe(200)
    expect(result.aborted).toBe(true)
    expect(result.text).toContain('partial')
  })

  it('answers a stalled upstream (no response headers) with a fixed 504', async () => {
    const h = await setup(() => undefined, {limits: {headersTimeoutMs: 200}})
    const reply = await h.send('/openai/chat/completions', {body: '{}'})
    expect(reply.status).toBe(504)
  })
})

describe('key proxy: start', () => {
  it('refuses to start with a non-https upstream', async () => {
    // #given a provider whose upstream origin is plain http
    const {logger} = recordingLogger()

    // #when the proxy starts
    const started = await startKeyProxy({
      providers: [{id: 'openai', key: OPENAI_KEY, origin: 'http://api.example.com', routes: []}],
      logger,
    })

    // #then it does not start, and the reason carries no key
    expect(started.success).toBe(false)
    expect(started.success ? '' : started.error).not.toContain(OPENAI_KEY)
  })

  it('refuses to start with a duplicate provider id', async () => {
    const {logger} = recordingLogger()
    const provider = {id: 'openai', key: OPENAI_KEY, origin: 'https://api.openai.com', routes: []}
    const started = await startKeyProxy({providers: [provider, provider], logger})
    expect(started.success).toBe(false)
  })

  it('stops serving after close', async () => {
    const h = await setup(okJson)
    await h.proxy.close()
    await expect(h.send('/openai/models', {method: 'GET'})).rejects.toThrow()
  })
})

const MCP_TOKEN = 'Bearer mcp-CANARY-0001-abcdefgh'
const MCP_SESSION = 'sess-test-1'

function mcpRoute(origin: string, overrides: Partial<KeyProxyMcpRouteConfig> = {}): KeyProxyMcpRouteConfig[] {
  return [{id: 's1', origin, path: '/mcp', headers: {Authorization: MCP_TOKEN, 'X-Tenant': 'tenant-7'}, ...overrides}]
}

/** A proxy with one MCP route and no provider, unless the test asks for more. */
async function setupMcp(
  handler: UpstreamHandler,
  options: {
    readonly limits?: Partial<KeyProxyLimits>
    readonly route?: Partial<KeyProxyMcpRouteConfig>
    readonly withProviders?: boolean
    readonly untrusted?: boolean
  } = {},
): Promise<Harness> {
  return setup(handler, {
    mcp: origin => mcpRoute(origin, options.route),
    ...(options.withProviders === true ? {} : {providers: () => []}),
    ...(options.limits === undefined ? {} : {limits: options.limits}),
    ...(options.untrusted === true ? {untrusted: true} : {}),
  })
}

async function sendMcp(h: Harness, init: Omit<SendInit, 'credential'> = {}, path = '/mcp/s1'): Promise<Reply> {
  return h.send(path, {...init, credential: 'none'})
}

/** Answers each upstream request with the next recorded response, in order. */
function replayUpstream(exchanges: readonly RecordedMcpExchange[]): UpstreamHandler {
  let index = 0
  return (_request, res) => {
    const exchange = exchanges[index]
    index += 1
    if (exchange === undefined) {
      res.writeHead(500)
      res.end('recording exhausted')
      return
    }
    const {status, headers, body} = exchange.response
    res.writeHead(status, headers)
    if (headers['content-type']?.includes('text/event-stream') !== true) {
      res.end(body)
      return
    }
    // A recorded stream is replayed event by event, so the order the client sees is the order the upstream wrote.
    const events = body.split(/(?<=\n\n)/).filter(event => event !== '')
    const next = (): void => {
      const event = events.shift()
      if (event === undefined) {
        res.end()
        return
      }
      res.write(event)
      setTimeout(next, 5)
    }
    next()
  }
}

/** The headers the recorded client sent that the proxy owns or rewrites, so a replay does not compare them. */
const REPLAY_SKIPPED_HEADERS: ReadonlySet<string> = new Set(['content-length', 'host', 'accept-encoding'])

async function replayRecording(exchanges: readonly RecordedMcpExchange[]) {
  const h = await setupMcp(replayUpstream(exchanges))
  const replies: Reply[] = []
  for (const exchange of exchanges) {
    const {method, headers, body} = exchange.request

    replies.push(await sendMcp(h, {method, headers, ...(body === '' ? {} : {body})}))
  }
  return {h, replies}
}

describe('key proxy: MCP routes, replaying what OpenCode 2.4.2 sent', () => {
  it('relays the recorded 2025 stateful flow: initialize, notification, GET stream, list, call, expiry, reconnect, DELETE', async () => {
    // #given the exchanges recorded against the pinned binary, replayed through the proxy one by one
    const {h, replies} = await replayRecording(MCP_2025_STATEFUL_EXCHANGES)

    // #then the upstream saw each request once, on the fixed path, with the client's protocol headers intact
    expect(h.upstream.requests).toHaveLength(MCP_2025_STATEFUL_EXCHANGES.length)
    MCP_2025_STATEFUL_EXCHANGES.forEach((exchange, index) => {
      const seen = h.upstream.requests[index]
      expect(seen?.method).toBe(exchange.request.method)
      expect(seen?.url).toBe('/mcp')
      expect(seen?.body.toString()).toBe(exchange.request.body)
      const compared = Object.entries(exchange.request.headers).filter(([name]) => !REPLAY_SKIPPED_HEADERS.has(name))
      expect(Object.fromEntries(compared.map(([name]) => [name, headerOf(seen, name)]))).toEqual(
        Object.fromEntries(compared),
      )
      // #then the configured headers were added to every request
      expect(headerOf(seen, 'authorization')).toBe(MCP_TOKEN)
      expect(headerOf(seen, 'x-tenant')).toBe('tenant-7')
    })

    // #then each reply keeps the upstream's status and, on a success, its body, type and session id
    const recordedReply = (status: number, body: string, type?: unknown, session?: unknown) => ({
      status,
      body,
      type,
      session,
    })
    expect(
      replies.map(reply =>
        recordedReply(
          reply.status,
          reply.body.toString(),
          reply.headers['content-type'],
          reply.headers['mcp-session-id'],
        ),
      ),
    ).toEqual(
      MCP_2025_STATEFUL_EXCHANGES.map(({response: r}) =>
        recordedReply(r.status, r.body, r.headers['content-type'], r.headers['mcp-session-id']),
      ),
    )
  })

  it('relays the recorded 2026 stateless flow, with the Mcp-Method, Mcp-Name and Mcp-Param headers intact', async () => {
    // #given the 2026 exchanges recorded against the pinned binary
    const {h, replies} = await replayRecording(MCP_2026_STATELESS_EXCHANGES)

    // #then every request arrived upstream with its protocol headers
    const call = h.upstream.requests.find(request => headerOf(request, 'mcp-method') === 'tools/call')
    expect(headerOf(call, 'mcp-param-text')).toBe('hi1')
    expect(headerOf(call, 'mcp-name')).toBe('echo')
    expect(headerOf(call, 'mcp-protocol-version')).toBe('2026-07-28')
    expect(h.upstream.requests.every(request => request.method === 'POST')).toBe(true)

    // #then the SSE result of a tool call arrives whole
    const index = MCP_2026_STATELESS_EXCHANGES.findIndex(e => e.request.headers['mcp-method'] === 'tools/call')
    expect(MCP_2026_STATELESS_EXCHANGES[index]?.response.body).toContain('echo:hi1')
    expect(replies[index]?.body.toString()).toBe(MCP_2026_STATELESS_EXCHANGES[index]?.response.body)
  })

  it('relays the recorded 400s intact: the probe answer and the session-expired reply', async () => {
    const {replies} = await replayRecording(MCP_2025_STATEFUL_EXCHANGES)

    // #given the 400s recorded against the pinned binary: the probe has no session, the expired call has one
    const failures = MCP_2025_STATEFUL_EXCHANGES.flatMap((exchange, index) =>
      exchange.response.status >= 400 ? [{exchange, reply: replies[index]}] : [],
    )

    // #then the client gets each status and body as the upstream sent them, and one holds the text OpenCode reconnects on
    expect(failures.map(({reply}) => [reply?.status, reply?.body.toString()])).toEqual(
      failures.map(({exchange}) => [exchange.response.status, exchange.response.body]),
    )
    expect(failures.length).toBeGreaterThanOrEqual(2)
    expect(failures.some(({reply}) => reply?.body.toString().includes(MCP_SESSION_EXPIRED_SENTINEL))).toBe(true)
  })
})

describe('key proxy: MCP routes, request side', () => {
  it('sets the configured headers and none of the client credentials, whatever their case', async () => {
    // #given a client that sends its own credential, cookie, tenant and forwarding headers
    const h = await setupMcp(okJson)

    // #when it posts to the route
    await sendMcp(h, {
      body: '{}',
      headers: {
        Authorization: 'Bearer client-secret',
        Cookie: 'sid=client',
        'Proxy-Authorization': 'Basic Y2xpZW50',
        'X-TENANT': 'tenant-attacker',
        'X-Forwarded-For': '203.0.113.9',
        Forwarded: 'for=203.0.113.9',
        'Content-Type': 'application/json',
      },
    })

    // #then the upstream saw the configured values only, and no cookie, proxy credential or forwarding header
    const seen = h.upstream.requests[0]
    expect(headerOf(seen, 'authorization')).toBe(MCP_TOKEN)
    expect(headerOf(seen, 'x-tenant')).toBe('tenant-7')
    expect(headerOf(seen, 'content-type')).toBe('application/json')
    for (const name of ['cookie', 'proxy-authorization', 'x-forwarded-for', 'forwarded']) {
      expect(headerOf(seen, name)).toBeUndefined()
    }
    expect(JSON.stringify(seen?.headers)).not.toContain('client-secret')
    expect(JSON.stringify(seen?.headers)).not.toContain('tenant-attacker')
  })

  it('forwards no client Authorization when the route does not configure one', async () => {
    // #given a route that authenticates with a different header
    const h = await setupMcp(okJson, {route: {headers: {'X-Api-Key': 'only-key-12345678'}}})

    // #when the client sends its own Authorization
    await sendMcp(h, {body: '{}', headers: {Authorization: 'Bearer client-secret'}})

    // #then the upstream sees the configured key and no Authorization at all
    expect(headerOf(h.upstream.requests[0], 'x-api-key')).toBe('only-key-12345678')
    expect(headerOf(h.upstream.requests[0], 'authorization')).toBeUndefined()
  })

  it('sets one authorization when the client repeats the header', async () => {
    const h = await setupMcp(okJson)
    const raw = await rawExchange(
      h.proxy.port,
      'POST /mcp/s1 HTTP/1.1\r\nHost: x\r\nAuthorization: a\r\nauthorization: b\r\nContent-Length: 2\r\n\r\n{}',
    )
    expect(raw).toMatch(/^HTTP\/1\.1 200/)
    expect(h.upstream.requests[0]?.headers.authorization).toBe(MCP_TOKEN)
  })

  it('sets the upstream Host and asks for identity encoding whatever the client sends', async () => {
    const h = await setupMcp(okJson)
    await sendMcp(h, {body: '{}', headers: {Host: 'evil.example', 'Accept-Encoding': 'gzip'}})
    const seen = h.upstream.requests[0]
    expect(headerOf(seen, 'host')).toBe(new URL(h.upstream.origin).host)
    expect(headerOf(seen, 'accept-encoding')).toBe('identity')
  })

  it('drops a header the client names in Connection and keeps the others', async () => {
    const h = await setupMcp(okJson)
    const raw = await rawExchange(
      h.proxy.port,
      'POST /mcp/s1 HTTP/1.1\r\nHost: x\r\nConnection: close, X-Hop\r\nX-Hop: 1\r\nMcp-Session-Id: s\r\nContent-Length: 2\r\n\r\n{}',
    )
    expect(raw).toMatch(/^HTTP\/1\.1 200/)
    expect(headerOf(h.upstream.requests[0], 'x-hop')).toBeUndefined()
    expect(headerOf(h.upstream.requests[0], 'mcp-session-id')).toBe('s')
  })

  it('passes the query through and keeps the configured path byte for byte', async () => {
    // #given a route whose configured path ends in a slash
    const h = await setupMcp(okJson, {route: {path: '/v1/mcp/'}})

    // #when the client adds the Code Mode query the 2.4.2 client appends to non-loopback servers
    await sendMcp(h, {body: '{}'}, '/mcp/s1?codemode=false&a=b%20c')

    // #then the upstream path is the fixed one plus the raw query
    expect(h.upstream.requests[0]?.url).toBe('/v1/mcp/?codemode=false&a=b%20c')
  })

  it.each(['POST', 'GET', 'DELETE'])('forwards %s and its body', async method => {
    const h = await setupMcp(okJson)
    const body = method === 'POST' ? '{"jsonrpc":"2.0"}' : undefined
    const reply = await sendMcp(h, {
      method,
      headers: {'mcp-session-id': MCP_SESSION},
      ...(body === undefined ? {} : {body}),
    })
    expect(reply.status).toBe(200)
    expect(h.upstream.requests[0]?.method).toBe(method)
    expect(h.upstream.requests[0]?.body.toString()).toBe(body ?? '')
  })

  it.each([
    ['PUT', '/mcp/s1'],
    ['PATCH', '/mcp/s1'],
    ['OPTIONS', '/mcp/s1'],
    ['HEAD', '/mcp/s1'],
    ['POST', '/mcp/s9'],
    ['POST', '/mcp'],
    ['POST', '/mcp/'],
    ['POST', '/mcp/s1/'],
    ['POST', '/mcp/s1/tools'],
    ['POST', '/mcp/%2e%2e/s1'],
    ['POST', '/mcp/s1;x'],
    ['POST', '/mcp/s1#x'],
    ['POST', '//mcp/s1'],
    ['POST', '/mcp/constructor'],
    ['POST', '/MCP/s1'],
  ])('refuses %s %s locally, with no contact upstream', async (method, path) => {
    const h = await setupMcp(okJson)
    const reply = await sendMcp(h, {method, body: '{}'}, path)
    expect(reply.status).toBe(404)
    expect(h.upstream.requests).toHaveLength(0)
  })

  it('refuses Expect and Upgrade on an MCP route, with no contact upstream', async () => {
    const h = await setupMcp(okJson)
    expect((await sendMcp(h, {body: '{}', headers: {Expect: '100-continue'}})).status).toBe(417)
    expect((await sendMcp(h, {body: '{}', headers: {Upgrade: 'websocket', Connection: 'Upgrade'}})).status).toBe(404)
    expect(h.upstream.requests).toHaveLength(0)
  })

  it('stops a body over the bound before the upstream sees it', async () => {
    const h = await setupMcp(okJson, {limits: {maxRequestBodyBytes: 8}})
    const reply = await sendMcp(h, {body: '0123456789abcdef'})
    expect(reply.status).toBe(413)
    expect(h.upstream.requests).toHaveLength(0)
  })
})

describe('key proxy: MCP routes, response side', () => {
  it.each([301, 302, 303, 307, 308])(
    'turns an upstream %i to the same origin into a 502 with no Location and no second request',
    async status => {
      // #given an upstream that redirects to its own origin
      const h = await setupMcp((_request, res) => {
        res.writeHead(status, {location: '/elsewhere'})
        res.end()
      })

      // #when the route is called
      const reply = await sendMcp(h, {body: '{}'})

      // #then the client gets a 502 without a Location, and the upstream saw one request only
      expect(reply.status).toBe(502)
      expect(reply.headers.location).toBeUndefined()
      expect(h.upstream.requests).toHaveLength(1)
    },
  )

  it('answers a bounded 502 when the upstream answers 101, and keeps serving', async () => {
    let first = true
    const h = await setupMcp((request, res, req) => {
      if (first) {
        first = false
        req.socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
        return
      }
      okJson(request, res, req)
    })
    const started = Date.now()
    const reply = await sendMcp(h, {body: '{}'})
    expect(reply.status).toBe(502)
    expect(reply.body.toString()).toBe('Bad Gateway\n')
    expect(reply.headers.upgrade).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5000)
    expect((await sendMcp(h, {body: '{}'})).status).toBe(200)
  })

  it('keeps the status of an upstream 401, drops the challenge and cookie, and redacts the credential from its body', async () => {
    // #given an upstream that rejects the credential, echoes it, and adds a challenge, a cookie and a delay
    const h = await setupMcp((request, res) => {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer resource_metadata="https://auth.example/.well-known/oauth-protected-resource"',
        'retry-after': '30',
        'set-cookie': 'sid=upstream',
        'x-leak': 'upstream-detail',
      })
      res.end(JSON.stringify({error: 'bad token', echoed: request.headers.authorization, detail: 'keep me'}))
    })

    // #when the route is called
    const reply = await sendMcp(h, {body: '{}'})

    // #then the status, type and delay stay, the challenge and cookie are gone, and only the credential is replaced
    expect(reply.status).toBe(401)
    expect(reply.headers['content-type']).toBe('application/json')
    expect(reply.headers['www-authenticate']).toBeUndefined()
    expect(reply.headers['set-cookie']).toBeUndefined()
    expect(reply.headers['x-leak']).toBeUndefined()
    expect(reply.headers['retry-after']).toBe('30')
    expect(JSON.parse(reply.body.toString())).toEqual({error: 'bad token', echoed: '[REDACTED]', detail: 'keep me'})
  })

  it.each([
    ['an HTTP date', 'Wed, 21 Oct 2026 07:28:00 GMT'],
    ['the credential', MCP_TOKEN],
    ['a delay with a unit', '30s'],
  ])('drops a Retry-After that is %s', async (_name, value) => {
    const h = await setupMcp((_request, res) => {
      res.writeHead(429, {'retry-after': value})
      res.end('slow down')
    })
    const reply = await sendMcp(h, {body: '{}'})
    expect(reply.status).toBe(429)
    expect(reply.headers['retry-after']).toBeUndefined()
  })

  describe('error bodies', () => {
    const failing =
      (status: number, body: string, headers: Record<string, string> = {}): UpstreamHandler =>
      (_request, res) => {
        res.writeHead(status, {'content-type': 'application/json', ...headers})
        res.end(body)
      }

    it.each([404, 405, 429, 500, 502, 503])('passes an upstream %i body through with its type', async status => {
      const h = await setupMcp(failing(status, 'plain detail', {'content-type': 'text/plain'}))
      const reply = await sendMcp(h, {body: '{}'})
      expect(reply.status).toBe(status)
      expect(reply.headers['content-type']).toBe('text/plain')
      expect(reply.body.toString()).toBe('plain detail')
    })

    it.each([
      [
        'a modern HeaderMismatch 400',
        400,
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32020,"message":"Header mismatch: Mcp-Name header value \'foo\' does not match body value \'bar\'"}}',
      ],
      [
        'a modern UnsupportedProtocolVersion 400',
        400,
        '{"jsonrpc":"2.0","id":"server-discover-probe-1","error":{"code":-32022,"message":"Unsupported protocol version","data":{"supported":["2026-07-28"]}}}',
      ],
      [
        'a modern method-not-found 404',
        404,
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}',
      ],
    ])('lets the client read %s, so it does not misread a modern server as an old one', async (_name, status, body) => {
      const h = await setupMcp(failing(status, body))
      const reply = await sendMcp(h, {body: '{}', headers: {'mcp-protocol-version': '2026-07-28'}})
      expect(reply.status).toBe(status)
      expect(reply.headers['content-type']).toBe('application/json')
      expect(reply.body.toString()).toBe(body)
    })

    it('relays the recorded session-expired reply untouched, so the client reconnects', async () => {
      // #given the 400 the pinned client received for an expired session, as recorded
      const expired = MCP_2025_STATEFUL_EXCHANGES.find(
        e => e.response.status === 400 && e.request.headers['mcp-session-id'] !== undefined,
      )
      if (expired === undefined) throw new Error('fixture')
      const h = await setupMcp(failing(400, expired.response.body))

      // #when the client calls with its session id
      const reply = await sendMcp(h, {body: '{}', headers: {'mcp-session-id': MCP_SESSION}})

      // #then it gets the recorded status and body, which hold the text OpenCode reconnects on
      expect(reply.status).toBe(400)
      expect(reply.body.toString()).toBe(expired.response.body)
      expect(reply.body.toString()).toContain(MCP_SESSION_EXPIRED_SENTINEL)
    })

    const SECRET = String.raw`Bearer tok"en\secret-12345678`
    const TOKEN_ONLY = String.raw`tok"en\secret-12345678`

    it('redacts every occurrence of a header value and of its scheme token, raw and JSON-escaped', async () => {
      // #given an upstream that echoes the value and the bare token, as JSON and as text
      const asJson = await setupMcp(failing(400, JSON.stringify({a: SECRET, b: TOKEN_ONLY, c: SECRET, keep: 'ok'})), {
        route: {headers: {Authorization: SECRET}},
      })
      const asText = await setupMcp(
        failing(400, `raw ${SECRET} and ${TOKEN_ONLY} and ${SECRET}`, {'content-type': 'text/plain'}),
        {
          route: {headers: {Authorization: SECRET}},
        },
      )

      // #when each route is called
      const json = (await sendMcp(asJson, {body: '{}'})).body.toString()
      const text = (await sendMcp(asText, {body: '{}'})).body.toString()

      // #then no form of the credential is left, and the rest is
      expect(JSON.parse(json)).toEqual({a: '[REDACTED]', b: '[REDACTED]', c: '[REDACTED]', keep: 'ok'})
      expect(text).toBe('raw [REDACTED] and [REDACTED] and [REDACTED]')
      for (const form of [
        SECRET,
        TOKEN_ONLY,
        JSON.stringify(SECRET).slice(1, -1),
        JSON.stringify(TOKEN_ONLY).slice(1, -1),
      ]) {
        expect(json).not.toContain(form)
        expect(text).not.toContain(form)
      }
    })

    it('redacts the value of every configured header, not only the authorization one', async () => {
      const h = await setupMcp(failing(400, 'seen tenant-7 and key-abcdefgh and a-short-one'), {
        route: {headers: {'X-Tenant': 'tenant-7', 'X-Key': 'key-abcdefgh'}},
      })
      const reply = await sendMcp(h, {body: '{}'})
      expect(reply.body.toString()).toBe('seen [REDACTED] and [REDACTED] and a-short-one')
    })

    it('leaves a header value shorter than 8 characters alone', async () => {
      const h = await setupMcp(failing(400, 'v1 abc1234'), {
        route: {headers: {'X-Version': 'v1', 'X-Short': 'abc1234'}},
      })
      expect((await sendMcp(h, {body: '{}'})).body.toString()).toBe('v1 abc1234')
    })

    it('redacts a scheme token that is on its own 8 characters or more, and not a shorter one', async () => {
      const long = await setupMcp(failing(400, 'token onlytoken-1'), {
        route: {headers: {Authorization: 'Basic onlytoken-1'}},
      })
      const short = await setupMcp(failing(400, 'token abcdefg'), {route: {headers: {Authorization: 'Basic abcdefg'}}})
      expect((await sendMcp(long, {body: '{}'})).body.toString()).toBe('token [REDACTED]')
      expect((await sendMcp(short, {body: '{}'})).body.toString()).toBe('token abcdefg')
    })

    it('replaces a compressed body with the fixed generic error, whatever it holds', async () => {
      // #given a body in an encoding the proxy never decodes, which would carry the credential
      const h = await setupMcp(failing(400, `Server not initialized ${MCP_TOKEN}`, {'content-encoding': 'gzip'}))

      const reply = await sendMcp(h, {body: '{}', headers: {'mcp-session-id': MCP_SESSION}})

      // #then the status stays and the body is fixed text with no encoding header
      expect(reply.status).toBe(400)
      expect(reply.headers['content-encoding']).toBeUndefined()
      expect(JSON.parse(reply.body.toString())).toEqual({
        error: {type: 'proxy_error', message: 'The upstream returned an error.'},
      })
    })

    it('answers at once with the generic error when the declared length is over the bound', async () => {
      const h = await setupMcp(
        (_request, res) => {
          res.writeHead(400, {'content-type': 'text/plain', 'content-length': '100000'})
          res.write(MCP_TOKEN)
        },
        {limits: {maxErrorBodyBytes: 64}},
      )
      const reply = await sendMcp(h, {body: '{}'})
      expect(reply.status).toBe(400)
      expect(reply.body.toString()).not.toContain('mcp-CANARY')
      expect(JSON.parse(reply.body.toString())).toEqual({
        error: {type: 'proxy_error', message: 'The upstream returned an error.'},
      })
    })

    it('replaces a chunked body that grows past the bound, with the credential straddling it', async () => {
      const h = await setupMcp(
        (_request, res) => {
          res.writeHead(400, {'content-type': 'text/plain'})
          res.write(MCP_TOKEN.slice(0, 10))
          res.write('x'.repeat(100))
          res.end(MCP_TOKEN.slice(10))
        },
        {limits: {maxErrorBodyBytes: 64}},
      )
      const reply = await sendMcp(h, {body: '{}'})
      expect(reply.status).toBe(400)
      expect(reply.body.toString()).not.toContain('mcp-CANARY')
      expect(reply.body.toString()).toContain('proxy_error')
    })
  })

  it('copies only the allowlisted headers of a success, and keeps the session id and the stream type', async () => {
    const h = await setupMcp((_request, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': MCP_SESSION,
        'cache-control': 'no-store',
        'set-cookie': 'sid=upstream',
        'www-authenticate': 'Bearer realm="x"',
        location: 'https://elsewhere.example/',
        'x-custom': 'upstream-detail',
      })
      res.end('{"ok":true}')
    })
    const reply = await sendMcp(h, {body: '{}'})
    expect(reply.status).toBe(200)
    expect(reply.headers['mcp-session-id']).toBe(MCP_SESSION)
    expect(reply.headers['content-type']).toBe('application/json')
    expect(reply.headers['cache-control']).toBe('no-store')
    for (const name of ['set-cookie', 'www-authenticate', 'location', 'x-custom']) {
      expect(reply.headers[name]).toBeUndefined()
    }
  })

  it('relays an empty 202 and an empty 200 to a DELETE', async () => {
    const h = await setupMcp((request, res) => {
      res.writeHead(request.method === 'DELETE' ? 200 : 202)
      res.end()
    })
    const accepted = await sendMcp(h, {body: '{"method":"notifications/initialized"}'})
    const deleted = await sendMcp(h, {method: 'DELETE', headers: {'mcp-session-id': MCP_SESSION}})
    expect([accepted.status, accepted.body.length]).toEqual([202, 0])
    expect([deleted.status, deleted.body.length]).toEqual([200, 0])
  })

  it('streams SSE events in order, with the gaps the upstream leaves', async () => {
    const frames = [
      'id: 1\ndata: a\n\n',
      'id: 2\nevent: message\ndata: b\n\n',
      ': keep-alive\n\n',
      'id: 3\ndata: c\n\n',
    ]
    const h = await setupMcp((_request, res) => sse(res, frames, 20))
    const reply = await sendMcp(h, {method: 'GET', headers: {accept: 'text/event-stream', 'last-event-id': '0'}})
    expect(reply.body.toString()).toBe(frames.join(''))
    expect(headerOf(h.upstream.requests[0], 'last-event-id')).toBe('0')
  })

  it('does not hold a GET stream back for its next event: the first frame arrives while the stream is open', async () => {
    // #given an upstream that writes one frame and keeps the stream open
    let release: () => void = () => undefined
    const hold = new Promise<void>(resolve => {
      release = resolve
    })
    const h = await setupMcp((_request, res) => {
      res.writeHead(200, {'content-type': 'text/event-stream'})
      res.write(': stream open\n\n')
      hold.then(
        () => res.end(),
        () => undefined,
      )
    })

    // #when the client reads the first frame
    const first = await new Promise<string>((resolve, reject) => {
      const req = http.request({host: '127.0.0.1', port: h.proxy.port, path: '/mcp/s1', method: 'GET'}, res => {
        res.once('data', (chunk: Buffer) => resolve(chunk.toString()))
      })
      req.on('error', reject)
      req.end()
      setTimeout(() => reject(new Error('no first frame')), 5000).unref()
    })
    release()

    // #then it was there before the upstream ended the stream
    expect(first).toBe(': stream open\n\n')
  })

  it('passes backpressure to the upstream when the client reads slowly', async () => {
    // #given an upstream that writes up to 128 MiB as fast as its socket takes it, and counts what it wrote
    const chunk = Buffer.alloc(64 * 1024, 97)
    const total = 2048
    let written = 0
    const h = await setupMcp((_request, res) => {
      res.writeHead(200, {'content-type': 'text/event-stream'})
      const pump = (): void => {
        while (written < total) {
          written += 1
          if (!res.write(chunk)) {
            res.once('drain', pump)
            return
          }
        }
        res.end()
      }
      pump()
    })

    // #when the client stops reading at once
    const received = await new Promise<number>((resolve, reject) => {
      const req = http.request({host: '127.0.0.1', port: h.proxy.port, path: '/mcp/s1', method: 'GET'}, res => {
        let bytes = 0
        res.pause()
        setTimeout(() => {
          // #then the upstream is held back by the buffers in between: it has not written everything
          expect(written).toBeLessThan(total)
          res.resume()
        }, 600)
        res.on('data', (data: Buffer) => {
          bytes += data.length
        })
        res.on('end', () => resolve(bytes))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })

    // #then once it reads, every byte arrives
    expect(received).toBe(chunk.length * total)
  }, 60_000)

  it('does not cut a stream that stays quiet past the provider idle bound', async () => {
    // #given frames 400 ms apart under a 150 ms idle limit
    const h = await setupMcp(
      (_request, res) => {
        res.writeHead(200, {'content-type': 'text/event-stream'})
        res.write(': a\n\n')
        setTimeout(() => res.write(': b\n\n'), 400)
        setTimeout(() => res.end(': c\n\n'), 800)
      },
      {limits: {idleTimeoutMs: 150}},
    )

    // #when it is read to its end
    const outcome = await new Promise<{readonly text: string; readonly complete: boolean}>(resolve => {
      const req = http.request({host: '127.0.0.1', port: h.proxy.port, path: '/mcp/s1', method: 'GET'}, res => {
        let text = ''
        res.on('data', (data: Buffer) => {
          text += data.toString()
        })
        res.on('close', () => resolve({text, complete: res.complete}))
        res.on('error', () => undefined)
      })
      req.on('error', () => undefined)
      req.end()
    })

    // #then every frame arrived and the stream ended cleanly, on the upstream's own end
    expect(outcome).toEqual({text: ': a\n\n: b\n\n: c\n\n', complete: true})
  })

  it('destroys the upstream request when the client drops a GET stream', async () => {
    let upstreamClosed: () => void = () => undefined
    const closed = new Promise<void>(resolve => {
      upstreamClosed = resolve
    })
    const h = await setupMcp((_request, res) => {
      res.writeHead(200, {'content-type': 'text/event-stream'})
      res.write(': open\n\n')
      res.on('close', upstreamClosed)
    })
    await new Promise<void>((resolve, reject) => {
      const req = http.request({host: '127.0.0.1', port: h.proxy.port, path: '/mcp/s1', method: 'GET'}, res => {
        res.once('data', () => {
          req.destroy()
          resolve()
        })
      })
      req.on('error', () => undefined)
      req.end()
      setTimeout(() => reject(new Error('no first frame')), 5000).unref()
    })
    await closed
    expect(h.upstream.requests).toHaveLength(1)
  })

  it('counts an open stream against the connection cap shared with every route', async () => {
    // #given a cap of one connection, held by a GET stream
    const h = await setupMcp(
      (_request, res) => {
        res.writeHead(200, {'content-type': 'text/event-stream'})
        res.write(': open\n\n')
      },
      {limits: {maxConnections: 1}},
    )
    const stream = http.request({host: '127.0.0.1', port: h.proxy.port, path: '/mcp/s1', method: 'GET', agent: false})
    await new Promise<void>((resolve, reject) => {
      stream.on('response', res => {
        res.once('data', () => resolve())
      })
      stream.on('error', reject)
      stream.end()
    })

    // #when another connection arrives
    const second = await rawExchange(h.proxy.port, 'GET /mcp/s1 HTTP/1.1\r\nHost: x\r\n\r\n', 200)

    // #then it is dropped without an answer
    expect(second).toBe('')
    stream.destroy()
  })

  it('refuses an upstream whose certificate it does not trust, with no request sent', async () => {
    const h = await setupMcp(okJson, {untrusted: true})
    const reply = await sendMcp(h, {body: '{}'})
    expect(reply.status).toBe(502)
    expect(h.upstream.requests).toHaveLength(0)
  })

  it('answers a failed upstream connection with a fixed 502 that never names the host', async () => {
    const h = await setupMcp(okJson, {route: {origin: 'https://127.0.0.1:1'}})
    const reply = await sendMcp(h, {body: '{}'})
    expect(reply.status).toBe(502)
    expect(reply.body.toString()).toBe('Bad Gateway\n')
  })

  it('waits for a response that comes after the provider first-byte bound, because only the client sets a tool call deadline', async () => {
    // #given limits that a provider route would trip, and an upstream that answers well after them
    const h = await setupMcp(
      (_request, res) => {
        setTimeout(() => {
          res.writeHead(200, {'content-type': 'application/json'})
          res.end('{"late":true}')
        }, 600)
      },
      {limits: {headersTimeoutMs: 150, idleTimeoutMs: 150}},
    )

    // #when the route is called
    const reply = await sendMcp(h, {body: '{}'})

    // #then the response completes
    expect(reply.status).toBe(200)
    expect(reply.body.toString()).toBe('{"late":true}')
  })

  it('still cuts a connection that never completes its handshake', async () => {
    // #given an upstream address that accepts TCP and never speaks TLS
    const sockets: net.Socket[] = []
    const silent = net.createServer(socket => sockets.push(socket))
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => silent.close(() => resolve()))
    })
    const {port} = silent.address() as net.AddressInfo
    const h = await setupMcp(okJson, {route: {origin: `https://127.0.0.1:${port}`}, limits: {connectTimeoutMs: 200}})

    // #when the route is called
    const reply = await sendMcp(h, {body: '{}'})

    // #then the connect bound still applies
    expect(reply.status).toBe(504)
  })
})

describe('key proxy: MCP routes beside provider routes', () => {
  it('serves a provider and an MCP route from one proxy without sharing a credential or a table', async () => {
    // #given a proxy with both route classes on one upstream
    const h = await setupMcp(okJson, {withProviders: true})

    // #when each is called
    const provider = await h.send('/openai/chat/completions', {body: '{}'})
    const mcp = await sendMcp(h, {body: '{}'})
    const crossed = await h.send('/mcp/chat/completions', {body: '{}'})
    const providerAsMcp = await sendMcp(h, {body: '{}'}, '/openai/s1')

    // #then each reached its own upstream path with its own credential, and the table paths did not cross
    expect(provider.status).toBe(200)
    expect(mcp.status).toBe(200)
    const [first, second] = h.upstream.requests
    expect(first?.url).toBe('/v1/chat/completions')
    expect(headerOf(first, 'authorization')).toBe(`Bearer ${OPENAI_KEY}`)
    expect(headerOf(first, 'x-tenant')).toBeUndefined()
    expect(second?.url).toBe('/mcp')
    expect(headerOf(second, 'authorization')).toBe(MCP_TOKEN)
    expect(crossed.status).toBe(404)
    expect(providerAsMcp.status).toBe(404)
    expect(h.upstream.requests).toHaveLength(2)
  })

  it('serves a provider named mcp as before when there are no MCP routes', async () => {
    const h = await setup(okJson, {
      providers: origin => {
        const built = buildKeyProxyUpstream({providerId: 'mcp', baseUrl: `${origin}/v1`, protocols: ['openai-chat']})
        if (!built.success) throw new Error('fixture')
        return [{id: 'mcp', key: OPENAI_KEY, origin: built.data.origin, routes: built.data.routes}]
      },
    })
    const reply = await h.send('/mcp/chat/completions', {body: '{}'})
    expect(reply.status).toBe(200)
    expect(headerOf(h.upstream.requests[0], 'authorization')).toBe(`Bearer ${OPENAI_KEY}`)
  })

  it('refuses to start when a provider is named mcp and MCP routes exist', async () => {
    const {logger} = recordingLogger()
    const started = await startKeyProxy({
      providers: [{id: 'mcp', key: OPENAI_KEY, origin: 'https://api.openai.com', routes: []}],
      mcp: mcpRoute('https://mcp.example.com'),
      logger,
    })
    expect(started.success).toBe(false)
    expect(started.success ? '' : started.error).not.toContain(OPENAI_KEY)
  })

  it('logs no header value, path, query or body for an MCP route', async () => {
    // #given calls that succeed, fail upstream and miss the route table
    const h = await setupMcp((_request, res) => {
      res.writeHead(400, {'content-type': 'application/json'})
      res.end(`{"echo":"${MCP_TOKEN}"}`)
    })
    await sendMcp(
      h,
      {body: '{"secret":"prompt-text"}', headers: {'x-custom': 'hdr-value', 'mcp-session-id': MCP_SESSION}},
      '/mcp/s1?codemode=false',
    )
    await sendMcp(h, {body: '{}'}, '/mcp/nope')

    // #then nothing request-derived or secret is in the log
    const log = h.lines.join('\n')
    for (const needle of [
      MCP_TOKEN,
      'mcp-CANARY',
      'tenant-7',
      'prompt-text',
      'hdr-value',
      MCP_SESSION,
      'codemode',
      '/mcp',
      'nope',
      'Bearer',
    ]) {
      expect(log).not.toContain(needle)
    }
  })
})

describe('key proxy: MCP routes at start', () => {
  const start = async (mcp: KeyProxyMcpRouteConfig[]) =>
    startKeyProxy({providers: [], mcp, logger: recordingLogger().logger})

  it.each([
    ['a plain-http origin', mcpRoute('http://mcp.example.com')],
    ['an origin with a path', mcpRoute('https://mcp.example.com/mcp')],
    ['a metadata-service origin', mcpRoute('https://169.254.169.254')],
    ['a repeated id', [...mcpRoute('https://a.example.com'), ...mcpRoute('https://b.example.com')]],
    ['a forbidden header', mcpRoute('https://mcp.example.com', {headers: {Host: 'x'}})],
  ])('refuses to start with %s, naming no header value', async (_name, mcp) => {
    const started = await start(mcp)
    expect(started.success).toBe(false)
    expect(started.success ? '' : started.error).not.toContain(MCP_TOKEN)
  })

  it('starts with MCP routes and no provider', async () => {
    const started = await start(mcpRoute('https://mcp.example.com'))
    expect(started.success).toBe(true)
    if (started.success) await started.data.close()
  })
})
