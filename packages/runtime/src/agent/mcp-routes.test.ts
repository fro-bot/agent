import type {IncomingHttpHeaders} from 'node:http'
import type {KeyProxyMcpRouteConfig} from './key-proxy-wire.js'
import {describe, expect, it} from 'vitest'

import {buildMcpRequestHeaders, buildMcpRoutes, matchMcpRoute, sanitizeRetryAfter} from './mcp-routes.js'

const TOKEN = 'Bearer mcp-routes-CANARY-0001'

function route(overrides: Partial<KeyProxyMcpRouteConfig> = {}): KeyProxyMcpRouteConfig {
  return {id: 's1', origin: 'https://mcp.example.com', path: '/mcp', headers: {Authorization: TOKEN}, ...overrides}
}

function built(routes: readonly KeyProxyMcpRouteConfig[]) {
  const result = buildMcpRoutes(routes)
  if (!result.success) throw new Error(`fixture refused: ${result.error}`)
  return result.data
}

describe('buildMcpRoutes', () => {
  it('holds each route under its id with a parsed origin and lower-cased header names', () => {
    // #given two routes on one origin with different paths
    const routes = built([
      route(),
      route({id: 's2', path: '/other/', headers: {'X-Api-Key': 'k-12345678', Accept: 'text/plain'}}),
    ])

    // #then each is looked up by id and keeps its own fixed path and headers
    expect(routes.get('s1')).toMatchObject({
      id: 's1',
      hostname: 'mcp.example.com',
      port: 443,
      host: 'mcp.example.com',
      path: '/mcp',
      headers: {authorization: TOKEN},
    })
    expect(routes.get('s1')?.secrets).toEqual([TOKEN, 'mcp-routes-CANARY-0001'])
    expect(routes.get('s2')?.path).toBe('/other/')
    expect(routes.get('s2')?.headers).toEqual({'x-api-key': 'k-12345678', accept: 'text/plain'})
  })

  it('keeps a header named __proto__ as an own header, in the table and on the request', () => {
    // #given a route whose header name a plain object would swallow
    const headers = JSON.parse('{"__proto__":"proto-value-0001"}') as Record<string, string>
    const state = built([route({headers})]).get('s1')
    if (state === undefined) throw new Error('fixture')

    // #when a request is built for it
    const out = buildMcpRequestHeaders({}, state, false)

    // #then the name is an own key in both, with its value
    expect(Object.keys(state.headers)).toEqual(['__proto__'])
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toBe('proto-value-0001')
    expect(state.secrets).toEqual(['proto-value-0001'])
  })

  it('accepts an empty header map and a non-default port', () => {
    const routes = built([route({origin: 'https://mcp.example.com:8443', headers: {}})])
    expect(routes.get('s1')).toMatchObject({port: 8443, host: 'mcp.example.com:8443', headers: {}})
  })

  it.each<[string, Partial<KeyProxyMcpRouteConfig>]>([
    ['an empty id', {id: ''}],
    ['an id with a slash', {id: 's/1'}],
    ['an id with a dot segment', {id: '..'}],
    ['a plain-http origin', {origin: 'http://mcp.example.com'}],
    ['an origin that carries a path', {origin: 'https://mcp.example.com/mcp'}],
    ['a metadata-service origin', {origin: 'https://169.254.169.254'}],
    ['a path that does not start with a slash', {path: 'mcp'}],
    ['a path with a query', {path: '/mcp?x=1'}],
    ['a path with a fragment', {path: '/mcp#x'}],
    ['a path with a space', {path: '/m cp'}],
    ['a path with a line break', {path: '/mcp\r\nx: y'}],
    ['a path over the bound', {path: `/${'a'.repeat(3000)}`}],
    ['a header named Host', {headers: {Host: 'evil.example'}}],
    ['a header named Transfer-Encoding', {headers: {'Transfer-Encoding': 'chunked'}}],
    ['a header named Content-Length', {headers: {'Content-Length': '1'}}],
    ['two header names that differ only in case', {headers: {Authorization: 'a', authorization: 'b'}}],
    ['a header name that is not a token', {headers: {'bad name': 'x'}}],
    ['a header value with a line break', {headers: {'X-A': 'one\r\nX-B: two'}}],
    ['a header value with a control character', {headers: {'X-A': 'one\u0001two'}}],
    ['a header value above the byte range', {headers: {'X-A': 'one\u0100two'}}],
    ['a header value over the bound', {headers: {'X-A': 'a'.repeat(5000)}}],
    [
      'too many headers',
      {headers: Object.fromEntries(Array.from({length: 33}, (_unused, index) => [`X-H${index}`, 'v']))},
    ],
  ])('refuses %s, quoting nothing', (_name, overrides) => {
    // #given a route that breaks one rule and carries a value that must not surface
    const tainted = route({...overrides, headers: {...overrides.headers, 'X-Canary': TOKEN}})

    // #when the table is built
    const result = buildMcpRoutes([tainted])

    // #then it is refused with a message that holds no header value, header name or path
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(JSON.stringify(result)).not.toContain('mcp.example.com')
  })

  it('refuses a repeated id', () => {
    expect(buildMcpRoutes([route(), route({path: '/two'})]).success).toBe(false)
  })

  it('refuses more than 64 routes', () => {
    const many = Array.from({length: 65}, (_unused, index) => route({id: `s${index}`}))
    expect(buildMcpRoutes(many).success).toBe(false)
  })
})

describe('matchMcpRoute', () => {
  const routes = built([route(), route({id: 's2', path: '/two'})])

  it.each(['POST', 'GET', 'DELETE'])('admits %s on the exact local path', method => {
    expect(matchMcpRoute(routes, method, '/mcp/s1')?.id).toBe('s1')
    expect(matchMcpRoute(routes, method, '/mcp/s2')?.id).toBe('s2')
  })

  it.each(['PUT', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'post'])('refuses %s', method => {
    expect(matchMcpRoute(routes, method, '/mcp/s1')).toBeUndefined()
  })

  it.each([
    ['an unknown id', '/mcp/s9'],
    ['no id', '/mcp'],
    ['no id with a trailing slash', '/mcp/'],
    ['a trailing slash', '/mcp/s1/'],
    ['an extra segment', '/mcp/s1/tools'],
    ['a provider-shaped path', '/openai/chat/completions'],
    ['the object prototype', '/mcp/constructor'],
    ['__proto__', '/mcp/__proto__'],
    ['a different prefix', '/MCP/s1'],
    ['a path with no leading slash', 'x/mcp/s1'],
  ])('refuses %s', (_name, path) => {
    expect(matchMcpRoute(routes, 'POST', path)).toBeUndefined()
  })
})

describe('buildMcpRequestHeaders', () => {
  const state = built([
    route({headers: {Authorization: TOKEN, 'X-Tenant': 'tenant-7', accept: 'application/json'}}),
  ]).get('s1')
  if (state === undefined) throw new Error('fixture')

  function headers(client: IncomingHttpHeaders, hasBody = false) {
    return buildMcpRequestHeaders(client, state as NonNullable<typeof state>, hasBody)
  }

  it('forwards the protocol headers a client sends', () => {
    // #given the headers the recorded 2.4.2 client sent on a 2026 tools/call
    const out = headers({
      'content-type': 'application/json',
      'mcp-method': 'tools/call',
      'mcp-name': 'echo',
      'mcp-param-text': 'hi1',
      'mcp-protocol-version': '2026-07-28',
      'mcp-session-id': 'sess-1',
      'last-event-id': 'g1',
      'user-agent': 'opencode/latest/2.4.2/cli',
    })

    // #then every one reaches the upstream untouched
    expect(out).toMatchObject({
      'content-type': 'application/json',
      'mcp-method': 'tools/call',
      'mcp-name': 'echo',
      'mcp-param-text': 'hi1',
      'mcp-protocol-version': '2026-07-28',
      'mcp-session-id': 'sess-1',
      'last-event-id': 'g1',
      'user-agent': 'opencode/latest/2.4.2/cli',
    })
  })

  it('forwards no client Authorization when the route configures none', () => {
    const bare = built([route({headers: {'X-Api-Key': 'only-key-12345678'}})]).get('s1')
    if (bare === undefined) throw new Error('fixture')
    const out = buildMcpRequestHeaders({authorization: 'Bearer client-secret'}, bare, false)
    expect(Object.keys(out)).not.toContain('authorization')
    expect(out['x-api-key']).toBe('only-key-12345678')
  })

  it('never forwards a client credential, cookie or proxy credential', () => {
    const out = headers({
      authorization: 'Bearer client-secret',
      cookie: 'sid=1',
      cookie2: 'x=1',
      'proxy-authorization': 'Basic Zm9v',
      'set-cookie': ['a=b'],
    })
    expect(Object.keys(out)).not.toContain('cookie')
    expect(Object.keys(out)).not.toContain('cookie2')
    expect(Object.keys(out)).not.toContain('proxy-authorization')
    expect(Object.keys(out)).not.toContain('set-cookie')
    expect(out.authorization).toBe(TOKEN)
  })

  it('drops forwarding metadata and the headers the forwarder owns', () => {
    const out = headers({
      forwarded: 'for=1.2.3.4',
      via: '1.1 proxy',
      'x-forwarded-for': '1.2.3.4',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'http',
      'x-real-ip': '1.2.3.4',
      host: '127.0.0.1:1234',
      'accept-encoding': 'gzip',
      expect: '100-continue',
      upgrade: 'websocket',
      te: 'trailers',
      trailer: 'x',
      'keep-alive': 'timeout=5',
      'proxy-connection': 'keep-alive',
    })
    for (const name of [
      'forwarded',
      'via',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-real-ip',
      'expect',
      'upgrade',
      'te',
      'trailer',
      'keep-alive',
      'proxy-connection',
    ]) {
      expect(Object.keys(out)).not.toContain(name)
    }
    expect(out.host).toBe('mcp.example.com')
    expect(out['accept-encoding']).toBe('identity')
  })

  it('drops any header the client names in Connection, case-insensitively', () => {
    const out = headers({connection: 'close, X-Hop-Secret', 'x-hop-secret': 'v', 'x-keep': 'kept'})
    expect(Object.keys(out)).not.toContain('connection')
    expect(Object.keys(out)).not.toContain('x-hop-secret')
    expect(out['x-keep']).toBe('kept')
  })

  it('sets the configured headers last, replacing a client header of any case', () => {
    // #given a client that sends its own Authorization, X-Tenant and Accept
    const out = headers({
      authorization: 'Bearer client-secret',
      'x-tenant': 'tenant-attacker',
      accept: 'text/event-stream',
    })

    // #then the configured values win, and no other casing of the name survives
    expect(out.authorization).toBe(TOKEN)
    expect(out['x-tenant']).toBe('tenant-7')
    expect(out.accept).toBe('application/json')
    expect(Object.keys(out).filter(name => name.toLowerCase() === 'authorization')).toEqual(['authorization'])
  })

  it('joins a repeated client header', () => {
    expect(headers({'x-a': ['one', 'two']})['x-a']).toBe('one, two')
  })

  it('passes content-length only when the request has a body', () => {
    expect(headers({'content-length': '12'}, true)['content-length']).toBe('12')
    expect(Object.keys(headers({'content-length': '12'}, false))).not.toContain('content-length')
    expect(Object.keys(headers({'transfer-encoding': 'chunked'}, true))).not.toContain('transfer-encoding')
  })
})

describe('sanitizeRetryAfter', () => {
  it.each([
    ['30', '30'],
    ['0', '0'],
  ])('keeps the delay %s', (value, expected) => {
    expect(sanitizeRetryAfter(value)).toBe(expected)
  })

  it.each([
    ['an HTTP date', 'Wed, 21 Oct 2026 07:28:00 GMT'],
    ['a credential', TOKEN],
    ['a negative number', '-1'],
    ['a number with a unit', '30s'],
    ['a huge number', '12345678901234567890'],
    ['an empty value', ''],
    [undefined, undefined],
  ])('drops %s', (_name, value) => {
    expect(sanitizeRetryAfter(value)).toBeUndefined()
  })
})
