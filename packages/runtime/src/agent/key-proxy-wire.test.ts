import {Buffer} from 'node:buffer'
import {describe, expect, it} from 'vitest'

import {
  encodeKeyProxyConfig,
  KEY_PROXY_MAX_CONFIG_BYTES,
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
