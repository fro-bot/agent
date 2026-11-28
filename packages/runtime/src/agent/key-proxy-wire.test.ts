import {Buffer} from 'node:buffer'
import {describe, expect, it} from 'vitest'

import {
  encodeKeyProxyConfig,
  KEY_PROXY_MAX_CONFIG_BYTES,
  KEY_PROXY_MCP_FORBIDDEN_HEADERS,
  mcpHeaderSecrets,
  parseKeyProxyChildLine,
  parseKeyProxyConfig,
  readKeyProxyFrameLength,
} from './key-proxy-wire.js'

function validConfig(): Record<string, unknown> {
  return {
    version: 1,
    providers: [
      {
        id: 'openai',
        key: 'sk-real',
        origin: 'https://api.openai.com',
        routes: [
          {
            method: 'POST',
            path: '/chat/completions',
            queries: [''],
            auth: 'bearer',
            upstreamPath: '/v1/chat/completions',
            kind: 'inference',
          },
        ],
      },
    ],
  }
}

describe('encodeKeyProxyConfig / readKeyProxyFrameLength', () => {
  it('round-trips a config through a length-prefixed frame', () => {
    // #given a config
    const config = parseKeyProxyConfig(validConfig())
    if (!config.success) throw new Error('fixture')

    // #when it is framed and the length is read back
    const frame = encodeKeyProxyConfig(config.data)
    const length = readKeyProxyFrameLength(frame)

    // #then the length matches the payload and the payload parses to the same config
    expect(length).toBe(frame.length - 4)
    expect(parseKeyProxyConfig(JSON.parse(frame.subarray(4).toString('utf8')))).toEqual(config)
  })

  it('refuses a frame length over the bound, a zero length and a short header', () => {
    const header = (length: number): Buffer => {
      const buffer = Buffer.alloc(4)
      buffer.writeUInt32BE(length)
      return buffer
    }
    expect(readKeyProxyFrameLength(header(KEY_PROXY_MAX_CONFIG_BYTES + 1))).toBeNull()
    expect(readKeyProxyFrameLength(header(0))).toBeNull()
    expect(readKeyProxyFrameLength(Buffer.alloc(3))).toBeNull()
    expect(readKeyProxyFrameLength(header(KEY_PROXY_MAX_CONFIG_BYTES))).toBe(KEY_PROXY_MAX_CONFIG_BYTES)
  })

  it('refuses to encode a config over the bound', () => {
    const config = parseKeyProxyConfig(validConfig())
    if (!config.success) throw new Error('fixture')
    const huge = {...config.data, ca: 'x'.repeat(KEY_PROXY_MAX_CONFIG_BYTES)}
    expect(() => encodeKeyProxyConfig(huge)).toThrow(/too large/)
  })
})

describe('parseKeyProxyConfig', () => {
  it('accepts a valid config', () => {
    expect(parseKeyProxyConfig(validConfig()).success).toBe(true)
  })

  it('keeps the optional CA', () => {
    const parsed = parseKeyProxyConfig({
      ...validConfig(),
      ca: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
    })
    expect(parsed.success && parsed.data.ca).toContain('BEGIN CERTIFICATE')
  })

  it.each([
    ['not an object', 'text'],
    ['an array', []],
    ['a wrong version', {...validConfig(), version: 2}],
    [
      'a placeholder field, which the wire no longer carries',
      {...validConfig(), placeholder: 'placeholder-0123456789abcdefghijklmnopqrstuvwxyz'},
    ],
    ['providers not an array', {...validConfig(), providers: {}}],
    ['an unknown top-level field', {...validConfig(), extra: true}],
    [
      'a provider with no key',
      {...validConfig(), providers: [{...(validConfig().providers as object[])[0], key: undefined}]},
    ],
    [
      'a provider with an unknown field',
      {...validConfig(), providers: [{...(validConfig().providers as object[])[0], extra: 1}]},
    ],
    [
      'a route with a bad method',
      {
        ...validConfig(),
        providers: [
          {
            id: 'a',
            key: 'k',
            origin: 'https://x.example',
            routes: [
              {method: 'DELETE', path: '/a', queries: [''], auth: 'bearer', upstreamPath: '/a', kind: 'inference'},
            ],
          },
        ],
      },
    ],
    [
      'a route with a bad auth style',
      {
        ...validConfig(),
        providers: [
          {
            id: 'a',
            key: 'k',
            origin: 'https://x.example',
            routes: [{method: 'GET', path: '/a', queries: [''], auth: 'basic', upstreamPath: '/a', kind: 'models'}],
          },
        ],
      },
    ],
    [
      'a route path without a leading slash',
      {
        ...validConfig(),
        providers: [
          {
            id: 'a',
            key: 'k',
            origin: 'https://x.example',
            routes: [{method: 'GET', path: 'a', queries: [''], auth: 'bearer', upstreamPath: '/a', kind: 'models'}],
          },
        ],
      },
    ],
    [
      'a non-string query',
      {
        ...validConfig(),
        providers: [
          {
            id: 'a',
            key: 'k',
            origin: 'https://x.example',
            routes: [{method: 'GET', path: '/a', queries: [1], auth: 'bearer', upstreamPath: '/a', kind: 'models'}],
          },
        ],
      },
    ],
    [
      'too many providers',
      {
        ...validConfig(),
        providers: Array.from({length: 65}, (_v, index) => ({
          id: `p${index}`,
          key: 'k',
          origin: 'https://x.example',
          routes: [],
        })),
      },
    ],
    ['a non-string CA', {...validConfig(), ca: 5}],
  ])('refuses %s without quoting the input', (_name, input) => {
    // #given a bad config that holds a recognisable secret
    const tainted = JSON.parse(JSON.stringify(input ?? null)) as unknown
    // #when it is parsed
    const parsed = parseKeyProxyConfig(tainted)
    // #then it is refused with a fixed result
    expect(parsed).toEqual({success: false, error: 'invalid-config'})
  })
})

describe('MCP routes on the wire', () => {
  const HEADER_CANARY = 'Bearer mcp-wire-CANARY-0001'
  const route = {id: 's1', origin: 'https://mcp.example.com', path: '/mcp', headers: {Authorization: HEADER_CANARY}}

  it('encodes the MCP routes into the frame the child reads', () => {
    // #given a config that carries one brokered route
    const base = parseKeyProxyConfig(validConfig())
    if (!base.success) throw new Error('fixture')

    // #when it is framed
    const frame = encodeKeyProxyConfig({...base.data, mcp: [route]})

    // #then the payload carries the route exactly as given
    expect((JSON.parse(frame.subarray(4).toString('utf8')) as {mcp: unknown}).mcp).toEqual([route])
  })

  it('parses a config that carries MCP routes, keeping them exactly as sent', () => {
    // #given a valid provider config plus an MCP route
    // #when the child parses it
    const parsed = parseKeyProxyConfig({...validConfig(), mcp: [route]})

    // #then the route comes through unchanged
    expect(parsed.success && parsed.data.mcp).toEqual([route])
  })

  it('parses an MCP-only config with no providers, and an empty MCP list', () => {
    expect(parseKeyProxyConfig({version: 1, providers: [], mcp: [route]}).success).toBe(true)
    const empty = parseKeyProxyConfig({...validConfig(), mcp: []})
    expect(empty.success).toBe(true)
  })

  it('keeps a header named __proto__ as an own header', () => {
    // #given a route frame whose header map has that name as an own key
    const headers = JSON.parse('{"__proto__":"proto-value-0001"}') as Record<string, string>
    const parsed = parseKeyProxyConfig({...validConfig(), mcp: [{...route, headers}]})

    // #then the parser accepts it and keeps it as an own key, as the Action's planner does
    const kept = parsed.success ? parsed.data.mcp?.[0]?.headers : undefined
    expect(Object.keys(kept ?? {})).toEqual(['__proto__'])
    expect(Object.getOwnPropertyDescriptor(kept, '__proto__')?.value).toBe('proto-value-0001')
  })

  it('copies only the known route fields', () => {
    // #given a route with a header map the parser must copy, not alias
    const input = {...route, headers: {...route.headers}}
    const parsed = parseKeyProxyConfig({...validConfig(), mcp: [input]})
    if (!parsed.success) throw new Error('fixture')

    // #when the input is changed afterwards
    input.headers.Authorization = 'changed'

    // #then the parsed route keeps the value it was given
    expect(parsed.data.mcp?.[0]?.headers.Authorization).toBe(HEADER_CANARY)
  })

  it.each([
    ['a non-array mcp', 'x'],
    ['an mcp object', {}],
    ['a non-object route', [5]],
    ['a route with an unknown field', [{...route, extra: 1}]],
    ['a route with no origin', [{id: 's1', path: '/mcp', headers: {}}]],
    ['a route with no headers field', [{id: 's1', origin: route.origin, path: '/mcp'}]],
    ['a route with an empty id', [{...route, id: ''}]],
    ['a route id with a slash', [{...route, id: 'a/b'}]],
    ['a route id that is a dot segment', [{...route, id: '..'}]],
    ['a path with a query', [{...route, path: '/mcp?x=1'}]],
    ['a path with a fragment', [{...route, path: '/mcp#x'}]],
    ['a path that is not absolute', [{...route, path: 'mcp'}]],
    ['a path with a space', [{...route, path: '/a b'}]],
    ['a path with a line break', [{...route, path: '/a\r\nb'}]],
    ['a path over the bound', [{...route, path: `/${'a'.repeat(2048)}`}]],
    ['a header map that is an array', [{...route, headers: ['x']}]],
    ['a non-string header value', [{...route, headers: {'X-A': 5}}]],
    ['a header value with a line break', [{...route, headers: {'X-A': 'a\r\nX-B: b'}}]],
    ['a header value over the bound', [{...route, headers: {'X-A': 'a'.repeat(4097)}}]],
    ['a header name that is not a token', [{...route, headers: {'bad name': 'x'}}]],
    ['a forbidden header name', [{...route, headers: {Host: 'x'}}]],
    ['two header names that differ only in case', [{...route, headers: {'X-A': '1', 'x-a': '2'}}]],
    [
      'more than 32 headers',
      [{...route, headers: Object.fromEntries(Array.from({length: 33}, (_u, i) => [`X-${i}`, 'v']))}],
    ],
    ['more than 64 routes', Array.from({length: 65}, (_u, i) => ({...route, id: `s${i}`}))],
  ])('refuses %s without quoting the input', (_name, mcp) => {
    expect(parseKeyProxyConfig({...validConfig(), mcp})).toEqual({success: false, error: 'invalid-config'})
  })

  it('names the headers the forwarder owns: the hop-by-hop set, plus host, content-length, accept-encoding and expect', () => {
    expect([...KEY_PROXY_MCP_FORBIDDEN_HEADERS].sort()).toEqual([
      'accept-encoding',
      'connection',
      'content-length',
      'expect',
      'host',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'proxy-connection',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
    ])
  })

  it('still refuses a field the child does not know, so nothing the Action sent is silently skipped', () => {
    expect(parseKeyProxyConfig({...validConfig(), mcpRoutes: [route]})).toEqual({
      success: false,
      error: 'invalid-config',
    })
  })
})

describe('mcpHeaderSecrets', () => {
  it('takes a value of 8 characters or more, and the token after Bearer, Basic or Token', () => {
    expect(mcpHeaderSecrets('abcdefgh')).toEqual(['abcdefgh'])
    expect(mcpHeaderSecrets('Bearer abcdefgh1')).toEqual(['Bearer abcdefgh1', 'abcdefgh1'])
    expect(mcpHeaderSecrets('basic dXNlcjpwYXNz')).toEqual(['basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'])
    expect(mcpHeaderSecrets('TOKEN   tok-abcdefgh')).toEqual(['TOKEN   tok-abcdefgh', 'tok-abcdefgh'])
  })

  it('leaves out a value of 7 characters or fewer, and a scheme token under the same floor', () => {
    expect(mcpHeaderSecrets('abcdefg')).toEqual([])
    expect(mcpHeaderSecrets('')).toEqual([])
    expect(mcpHeaderSecrets('Bearer abcdefg')).toEqual(['Bearer abcdefg'])
  })

  it('does not split a value that merely starts with a scheme word', () => {
    expect(mcpHeaderSecrets('Bearertoken12345')).toEqual(['Bearertoken12345'])
  })
})

describe('parseKeyProxyChildLine', () => {
  it('parses the ready line', () => {
    expect(parseKeyProxyChildLine('{"ready":true,"port":43123}')).toEqual({kind: 'ready', port: 43123})
  })

  it('parses an error line', () => {
    expect(parseKeyProxyChildLine('{"error":"invalid-config"}')).toEqual({kind: 'error', code: 'invalid-config'})
  })

  it.each([
    [''],
    ['not json'],
    ['{"ready":true}'],
    ['{"ready":true,"port":0}'],
    ['{"ready":true,"port":70000}'],
    ['{"ready":true,"port":"80"}'],
    ['{"ready":false,"port":80}'],
    ['{"error":"something else"}'],
    ['[1]'],
  ])('treats %j as invalid', line => {
    expect(parseKeyProxyChildLine(line)).toEqual({kind: 'invalid'})
  })
})
