import type {IncomingHttpHeaders} from 'node:http'
import type {Logger} from '../shared/logger.js'
import type {RecordedRequest, TlsUpstream, UpstreamHandler} from './key-proxy-test-kit.js'
import type {KeyProxyLimits, KeyProxyProviderConfig, KeyProxyServer} from './key-proxy.js'
import {Buffer} from 'node:buffer'
import http from 'node:http'
import net from 'node:net'
import {gzipSync} from 'node:zlib'
import {afterEach, describe, expect, it} from 'vitest'

import {buildKeyProxyUpstream} from './key-proxy-routes.js'
import {startTlsUpstream} from './key-proxy-test-kit.js'
import {startKeyProxy} from './key-proxy.js'

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
  readonly placeholder?: string
}

async function setup(
  handler: UpstreamHandler,
  options: {
    readonly limits?: Partial<KeyProxyLimits>
    readonly providers?: (origin: string) => KeyProxyProviderConfig[]
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
    placeholder: PLACEHOLDER,
    providers: (options.providers ?? defaultProviders)(upstream.origin),
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
  const placeholder = init.placeholder ?? PLACEHOLDER
  const style = init.credential ?? (path.includes('/anthropic/') ? 'x-api-key' : 'bearer')
  if (style === 'x-api-key') headers['x-api-key'] = placeholder
  if (style === 'bearer') headers.authorization = `Bearer ${placeholder}`
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

  it.each([
    ['no credential', {credential: 'none' as const}],
    ['a wrong placeholder', {placeholder: 'not-the-placeholder-0123456789abcdefghijklmn'}],
    ['a placeholder of another length', {placeholder: 'short'}],
    ['the placeholder in the wrong header style', {credential: 'x-api-key' as const}],
  ])('answers 401 locally for %s and sends nothing upstream', async (_name, init) => {
    // #given an upstream that would answer
    const h = await setup(okJson)

    // #when a Chat request arrives with a bad credential
    const reply = await h.send('/openai/chat/completions', {body: '{}', ...init})

    // #then the proxy answers and the upstream never sees a request
    expect(reply.status).toBe(401)
    expect(h.upstream.requests).toHaveLength(0)
  })

  it('answers 401 for a Messages request that carries the placeholder as a Bearer token', async () => {
    const h = await setup(okJson)
    const reply = await h.send('/anthropic/messages', {body: '{}', credential: 'bearer'})
    expect(reply.status).toBe(401)
    expect(h.upstream.requests).toHaveLength(0)
  })

  it('rejects a duplicated credential header', async () => {
    // #given a request that repeats x-api-key
    const h = await setup(okJson)
    const raw = await rawExchange(
      h.proxy.port,
      `POST /anthropic/messages HTTP/1.1\r\nHost: x\r\nx-api-key: ${PLACEHOLDER}\r\nx-api-key: ${PLACEHOLDER}\r\ncontent-length: 2\r\n\r\n{}`,
    )

    // #then it is refused locally
    expect(raw).toMatch(/^HTTP\/1\.1 401/)
    expect(h.upstream.requests).toHaveLength(0)
  })

  it('rejects a repeated Authorization header even when the first one is valid', async () => {
    // #given a request whose first Authorization carries the placeholder and whose second does not
    const h = await setup(okJson)
    const raw = await rawExchange(
      h.proxy.port,
      `POST /openai/chat/completions HTTP/1.1\r\nHost: x\r\nauthorization: Bearer ${PLACEHOLDER}\r\nauthorization: Bearer other\r\ncontent-length: 2\r\n\r\n{}`,
    )

    // #then it is ambiguous and refused locally
    expect(raw).toMatch(/^HTTP\/1\.1 401/)
    expect(h.upstream.requests).toHaveLength(0)
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

  it('rejects a repeated x-api-key header even when the first one is valid', async () => {
    // #given a Messages request whose first x-api-key is the placeholder and whose second is not
    const h = await setup(okJson)
    const raw = await rawExchange(
      h.proxy.port,
      `POST /anthropic/messages HTTP/1.1\r\nHost: x\r\nx-api-key: ${PLACEHOLDER}\r\nx-api-key: other\r\ncontent-length: 2\r\n\r\n{}`,
    )

    // #then it is ambiguous and refused locally
    expect(raw).toMatch(/^HTTP\/1\.1 401/)
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
      placeholder: PLACEHOLDER,
      providers: [{id: 'openai', key: OPENAI_KEY, origin: 'http://api.example.com', routes: []}],
      logger,
    })

    // #then it does not start, and the reason carries no key
    expect(started.success).toBe(false)
    expect(started.success ? '' : started.error).not.toContain(OPENAI_KEY)
  })

  it('refuses to start with a short placeholder', async () => {
    const {logger} = recordingLogger()
    const started = await startKeyProxy({placeholder: 'short', providers: [], logger})
    expect(started.success).toBe(false)
  })

  it('refuses to start with a duplicate provider id', async () => {
    const {logger} = recordingLogger()
    const provider = {id: 'openai', key: OPENAI_KEY, origin: 'https://api.openai.com', routes: []}
    const started = await startKeyProxy({placeholder: PLACEHOLDER, providers: [provider, provider], logger})
    expect(started.success).toBe(false)
  })

  it('stops serving after close', async () => {
    const h = await setup(okJson)
    await h.proxy.close()
    await expect(h.send('/openai/models', {method: 'GET'})).rejects.toThrow()
  })
})
