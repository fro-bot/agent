import {Buffer} from 'node:buffer'
import {describe, expect, it} from 'vitest'

import {
  encodeTraceRelayConfig,
  isValidTraceRelayHeaderName,
  isValidTraceRelayHeaderValue,
  parseTraceRelayChildLine,
  parseTraceRelayConfig,
  readTraceRelayFrameLength,
  TRACE_RELAY_MAX_CONFIG_BYTES,
  TRACE_RELAY_PATH,
  TRACE_RELAY_STATUS,
  validateTraceRelayUrl,
} from './trace-relay-wire.js'

const CANARY = 'Basic dHJhY2UtY2FuYXJ5LTAwMDc6c2VjcmV0'

function validConfig(): Record<string, unknown> {
  return {
    version: 1,
    url: 'https://collector.example.com/api/public/otel/v1/traces?project=a',
    headers: [
      {name: 'Authorization', value: CANARY},
      {name: 'x-langfuse-ingestion-version', value: '4'},
    ],
  }
}

describe('validateTraceRelayUrl', () => {
  it.each([
    ['an https URL with a path and a query', 'https://collector.example.com/api/public/otel/v1/traces?project=a'],
    ['an https URL with a port', 'https://collector.example.com:4318/v1/traces'],
    ['http to 127.0.0.1', 'http://127.0.0.1:4318/v1/traces'],
    ['http to another 127.0.0.0/8 address', 'http://127.8.9.10/v1/traces'],
    ['http to a short form that normalizes to 127.0.0.1', 'http://127.1:4318/v1/traces'],
    ['http to ::1', 'http://[::1]:4318/v1/traces'],
  ])('accepts %s', (_name, url) => {
    expect(validateTraceRelayUrl(url).success).toBe(true)
  })

  it.each([
    ['http to a public host', 'http://collector.example.com/v1/traces'],
    ['http to localhost', 'http://localhost:4318/v1/traces'],
    ['http to a private non-loopback address', 'http://10.0.0.5/v1/traces'],
    ['http to the unspecified address', 'http://0.0.0.0/v1/traces'],
    ['http to an IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/v1/traces'],
    ['a URL with a user name', 'https://user@collector.example.com/v1/traces'],
    ['a URL with a user name and a password', 'https://user:pass@collector.example.com/v1/traces'],
    ['a URL with a fragment', 'https://collector.example.com/v1/traces#frag'],
    ['another scheme', 'ftp://collector.example.com/v1/traces'],
    ['a file URL', 'file:///etc/passwd'],
    ['a string that is not a URL', 'collector.example.com'],
    ['an empty string', ''],
    ['https to the AWS metadata address', 'https://169.254.169.254/latest'],
    ['https to the GCP metadata name', 'https://metadata.google.internal/v1/traces'],
  ])('refuses %s with a fixed reason that never quotes the value', (_name, url) => {
    expect(validateTraceRelayUrl(url)).toMatchObject({success: false, error: 'invalid-url'})
  })
})

describe('trace relay header rules', () => {
  it.each(['authorization', 'X-Langfuse-Ingestion-Version', 'x_custom.key~1'])('accepts the name %s', name => {
    expect(isValidTraceRelayHeaderName(name)).toBe(true)
  })

  it.each([
    '',
    'with space',
    'colon:name',
    'new\nline',
    'ünï',
    'host',
    'Host',
    'content-length',
    'Transfer-Encoding',
    'connection',
    'upgrade',
    'expect',
    'content-type',
    'Content-Encoding',
    'keep-alive',
    'te',
    'trailer',
    'proxy-authorization',
  ])('refuses the name %j', name => {
    expect(isValidTraceRelayHeaderName(name)).toBe(false)
  })

  it('accepts a printable value and refuses control characters, edge whitespace and an empty value', () => {
    expect(isValidTraceRelayHeaderValue(CANARY)).toBe(true)
    expect(isValidTraceRelayHeaderValue('a b')).toBe(true)
    expect(isValidTraceRelayHeaderValue('')).toBe(false)
    expect(isValidTraceRelayHeaderValue('a\nb')).toBe(false)
    expect(isValidTraceRelayHeaderValue('a\rb')).toBe(false)
    expect(isValidTraceRelayHeaderValue('a\u0000b')).toBe(false)
    expect(isValidTraceRelayHeaderValue('a\tb')).toBe(false)
    expect(isValidTraceRelayHeaderValue('a\u007Fb')).toBe(false)
    expect(isValidTraceRelayHeaderValue(' lead')).toBe(false)
    expect(isValidTraceRelayHeaderValue('trail ')).toBe(false)
    expect(isValidTraceRelayHeaderValue('snow\u2603man')).toBe(false)
  })
})

describe('parseTraceRelayConfig', () => {
  it('accepts a valid config and carries the url, the headers and the limits', () => {
    // #given a valid frame body with some limits
    const parsed = parseTraceRelayConfig({...validConfig(), limits: {maxConnections: 4, upstreamTimeoutMs: 1500}})

    // #then it parses to the same values
    expect(parsed).toMatchObject({
      success: true,
      data: {
        url: 'https://collector.example.com/api/public/otel/v1/traces?project=a',
        headers: [
          {name: 'Authorization', value: CANARY},
          {name: 'x-langfuse-ingestion-version', value: '4'},
        ],
        limits: {maxConnections: 4, upstreamTimeoutMs: 1500},
      },
    })
  })

  it('accepts an empty header list', () => {
    expect(parseTraceRelayConfig({...validConfig(), headers: []}).success).toBe(true)
  })

  it.each([
    ['a non-object', 'x'],
    ['an array', []],
    ['null', null],
    ['an unknown version', {...validConfig(), version: 2}],
    ['a missing version', {url: 'https://c.example.com/t', headers: []}],
    ['an unknown top-level field', {...validConfig(), extra: true}],
    ['a url that is not a string', {...validConfig(), url: 5}],
    ['a url the rules refuse', {...validConfig(), url: 'http://collector.example.com/t'}],
    ['headers that are not an array', {...validConfig(), headers: {a: 'b'}}],
    ['a header that is not an object', {...validConfig(), headers: ['authorization: x']}],
    ['a header with an unknown field', {...validConfig(), headers: [{name: 'a', value: 'b', extra: 1}]}],
    ['a refused header name', {...validConfig(), headers: [{name: 'host', value: 'x'}]}],
    ['a header value with a control character', {...validConfig(), headers: [{name: 'a', value: 'x\ny'}]}],
    [
      'a header repeated in another case',
      {
        ...validConfig(),
        headers: [
          {name: 'Authorization', value: 'a'},
          {name: 'authorization', value: 'b'},
        ],
      },
    ],
    [
      'too many headers',
      {...validConfig(), headers: Array.from({length: 33}, (_, i) => ({name: `x-h${i}`, value: 'v'}))},
    ],
    ['a limits field that is not an object', {...validConfig(), limits: 5}],
    ['an unknown limit', {...validConfig(), limits: {sneaky: 1}}],
    ['a limit that is zero', {...validConfig(), limits: {maxConnections: 0}}],
    ['a limit that is negative', {...validConfig(), limits: {maxConnections: -1}}],
    ['a limit that is not an integer', {...validConfig(), limits: {maxConnections: 1.5}}],
    ['a limit that is a string', {...validConfig(), limits: {maxConnections: '4'}}],
  ])('refuses %s with the fixed code and no quoted input', (_name, value) => {
    expect(parseTraceRelayConfig(value)).toMatchObject({success: false, error: 'invalid-config'})
  })
})

describe('encodeTraceRelayConfig / readTraceRelayFrameLength', () => {
  it('round-trips a config through a length-prefixed frame', () => {
    const config = parseTraceRelayConfig(validConfig())
    if (!config.success) throw new Error('fixture')

    const frame = encodeTraceRelayConfig(config.data)
    const length = readTraceRelayFrameLength(frame)

    expect(length).toBe(frame.length - 4)
    expect(parseTraceRelayConfig(JSON.parse(frame.subarray(4).toString('utf8')))).toEqual(config)
  })

  it('refuses a frame length over the bound, a zero length and a short header', () => {
    const header = (length: number): Buffer => {
      const buffer = Buffer.alloc(4)
      buffer.writeUInt32BE(length)
      return buffer
    }
    expect(readTraceRelayFrameLength(header(TRACE_RELAY_MAX_CONFIG_BYTES + 1))).toBeNull()
    expect(readTraceRelayFrameLength(header(0))).toBeNull()
    expect(readTraceRelayFrameLength(Buffer.alloc(3))).toBeNull()
    expect(readTraceRelayFrameLength(header(TRACE_RELAY_MAX_CONFIG_BYTES))).toBe(TRACE_RELAY_MAX_CONFIG_BYTES)
  })

  it('refuses to encode a config over the size bound', () => {
    const config = parseTraceRelayConfig(validConfig())
    if (!config.success) throw new Error('fixture')
    const big = {
      ...config.data,
      headers: Array.from({length: 32}, (_, i) => ({name: `x-h${i}`, value: 'v'.repeat(TRACE_RELAY_MAX_CONFIG_BYTES)})),
    }
    expect(() => encodeTraceRelayConfig(big)).toThrow()
  })
})

describe('parseTraceRelayChildLine', () => {
  it('parses a ready line', () => {
    expect(parseTraceRelayChildLine('{"ready":true,"port":4318}')).toEqual({kind: 'ready', port: 4318})
  })

  it('refuses a ready line with a port outside 1..65535 or a non-integer', () => {
    expect(parseTraceRelayChildLine('{"ready":true,"port":0}')).toEqual({kind: 'invalid'})
    expect(parseTraceRelayChildLine('{"ready":true,"port":65536}')).toEqual({kind: 'invalid'})
    expect(parseTraceRelayChildLine('{"ready":true,"port":1.5}')).toEqual({kind: 'invalid'})
  })

  it('parses the fixed error codes and refuses an unknown one', () => {
    expect(parseTraceRelayChildLine('{"error":"invalid-config"}')).toEqual({kind: 'error', code: 'invalid-config'})
    expect(parseTraceRelayChildLine('{"error":"start-failed"}')).toEqual({kind: 'error', code: 'start-failed'})
    expect(parseTraceRelayChildLine('{"error":"internal"}')).toEqual({kind: 'error', code: 'internal'})
    expect(parseTraceRelayChildLine('{"error":"anything else"}')).toEqual({kind: 'invalid'})
  })

  it('parses the report line into batch counts', () => {
    expect(parseTraceRelayChildLine('{"report":{"delivered":3,"retry":2,"dropped":1}}')).toEqual({
      kind: 'report',
      counts: {delivered: 3, retry: 2, dropped: 1},
    })
  })

  it('refuses a report with a missing, negative or fractional count', () => {
    expect(parseTraceRelayChildLine('{"report":{"delivered":3,"retry":2}}')).toEqual({kind: 'invalid'})
    expect(parseTraceRelayChildLine('{"report":{"delivered":-1,"retry":0,"dropped":0}}')).toEqual({kind: 'invalid'})
    expect(parseTraceRelayChildLine('{"report":{"delivered":1.5,"retry":0,"dropped":0}}')).toEqual({kind: 'invalid'})
  })

  it('refuses text that is not JSON and values that are not objects', () => {
    expect(parseTraceRelayChildLine('hello')).toEqual({kind: 'invalid'})
    expect(parseTraceRelayChildLine('[1]')).toEqual({kind: 'invalid'})
    expect(parseTraceRelayChildLine('null')).toEqual({kind: 'invalid'})
  })
})

describe('the sender-facing contract', () => {
  it('serves one fixed path', () => {
    expect(TRACE_RELAY_PATH).toBe('/v1/traces')
  })

  it('answers with three distinct statuses, so the exporter can tell retry from final', () => {
    // The OTLP HTTP exporter (otlp-exporter-base 0.219.0, is-export-retryable.js) treats exactly 429, 502, 503 and 504
    // as retryable and any other status above 299 as final. Delivered must be 2xx, retry must be one of the four, and
    // dropped must be a final status that is neither 2xx nor retryable.
    const retryable = new Set([429, 502, 503, 504])
    expect(TRACE_RELAY_STATUS.delivered).toBeGreaterThanOrEqual(200)
    expect(TRACE_RELAY_STATUS.delivered).toBeLessThanOrEqual(299)
    expect(retryable.has(TRACE_RELAY_STATUS.retry)).toBe(true)
    expect(TRACE_RELAY_STATUS.dropped).toBeGreaterThan(299)
    expect(retryable.has(TRACE_RELAY_STATUS.dropped)).toBe(false)
  })
})
