import {Buffer} from 'node:buffer'
import {describe, expect, it, vi} from 'vitest'
import {
  parseTraceInputs,
  readTraceInputs,
  takeTraceInputs,
  TRACE_INPUT_MESSAGES,
  type TraceInputIo,
} from './trace-inputs.js'

const HOST_CANARY = 'collector-canary.example.test'
const ENDPOINT = `https://${HOST_CANARY}/api/public/otel/v1/traces`
const USER = 'pk-lf-canary-0001'
const PASSWORD = 'sk-lf-canary-0002-secret'
const ENCODED = Buffer.from(`${USER}:${PASSWORD}`).toString('base64')
const BASIC = `Basic ${ENCODED}`
const VERSION = 'x-langfuse-ingestion-version: 4'

function createIo() {
  const io = {
    warning: vi.fn<(m: string) => void>(),
    notice: vi.fn<(m: string) => void>(),
    info: vi.fn<(m: string) => void>(),
    mask: vi.fn<(v: string) => void>(),
  }
  return {io: io satisfies TraceInputIo, ...io}
}

const parse = (endpoint: string, headers: string) => {
  const spies = createIo()
  const result = parseTraceInputs({endpoint, headers}, spies.io)
  return {result, ...spies}
}

const masked = (mask: {mock: {calls: unknown[][]}}): string[] => mask.mock.calls.map(call => String(call[0]))

describe('parseTraceInputs', () => {
  describe('on', () => {
    it('is on with the endpoint and the headers, one per line', () => {
      // #given an https endpoint and two header lines
      const {result, warning, notice} = parse(ENDPOINT, `Authorization: ${BASIC}\n${VERSION}`)

      // #then
      expect(result).toEqual({
        enabled: true,
        url: ENDPOINT,
        headers: [
          {name: 'Authorization', value: BASIC},
          {name: 'x-langfuse-ingestion-version', value: '4'},
        ],
      })
      expect(warning).not.toHaveBeenCalled()
      expect(notice).not.toHaveBeenCalled()
    })

    it('tolerates CRLF, blank lines and spaces around the name and the value', () => {
      const {result} = parse(ENDPOINT, `\r\n  Authorization :   ${BASIC}   \r\n\r\n${VERSION}\r\n`)

      expect(result).toMatchObject({
        enabled: true,
        headers: [{name: 'Authorization', value: BASIC}, {name: 'x-langfuse-ingestion-version'}],
      })
    })

    it('keeps a colon inside a value, such as a URL or a base64 padding', () => {
      const {result} = parse(ENDPOINT, 'X-Target: https://other.example.test:8443/path')

      expect(result).toMatchObject({
        enabled: true,
        headers: [{name: 'X-Target', value: 'https://other.example.test:8443/path'}],
      })
    })

    it('is on with a notice, and no headers, when the endpoint is set and the headers are empty', () => {
      const {result, notice, warning} = parse(ENDPOINT, '')

      expect(result).toEqual({enabled: true, url: ENDPOINT, headers: []})
      expect(notice).toHaveBeenCalledTimes(1)
      expect(notice).toHaveBeenCalledWith(TRACE_INPUT_MESSAGES.noCredential)
      expect(warning).not.toHaveBeenCalled()
    })

    it('is on for a loopback http endpoint with no headers, in either loopback form', () => {
      expect(parse('http://127.0.0.1:4318/v1/traces', '').result).toMatchObject({enabled: true, headers: []})
      expect(parse('http://[::1]:4318/v1/traces', '').result).toMatchObject({enabled: true, headers: []})
    })

    it('accepts a header whose blank lines are only whitespace as no headers', () => {
      const {result, notice} = parse(ENDPOINT, '  \n \t \n')

      expect(result).toMatchObject({enabled: true, headers: []})
      expect(notice).toHaveBeenCalledTimes(1)
    })
  })

  describe('off', () => {
    it('is off and silent for an empty endpoint with empty headers', () => {
      const {result, warning, notice, info} = parse('', '')

      expect(result).toEqual({enabled: false})
      expect(warning).not.toHaveBeenCalled()
      expect(notice).not.toHaveBeenCalled()
      expect(info).not.toHaveBeenCalled()
    })

    it('is off with no relay and no warning when headers are set and the endpoint is empty, and says so at info', () => {
      const {result, warning, info} = parse('', `Authorization: ${BASIC}`)

      expect(result).toEqual({enabled: false})
      expect(warning).not.toHaveBeenCalled()
      expect(info).toHaveBeenCalledTimes(1)
      expect(info).toHaveBeenCalledWith(TRACE_INPUT_MESSAGES.headersWithoutEndpoint)
    })

    it.each([
      ['an http endpoint to a public host', 'http://collector.example.test/v1/traces'],
      ['http to localhost by name', 'http://localhost:4318/v1/traces'],
      ['an endpoint with userinfo', 'https://user:pass-word-1@collector.example.test/v1/traces'],
      ['an endpoint with a username only', 'https://user-name-1@collector.example.test/v1/traces'],
      ['an endpoint that is not a URL', 'collector.example.test/v1/traces'],
      ['an endpoint with another scheme', 'ftp://collector.example.test/v1/traces'],
      ['port zero', 'https://collector.example.test:0/v1/traces'],
      ['a fragment', 'https://collector.example.test/v1/traces#frag'],
      ['a cloud metadata address', 'http://169.254.169.254/latest'],
    ])('is off with one warning that names the input and quotes no part of the value for %s', (_name, endpoint) => {
      // #given an endpoint the relay's own rules refuse, with a header that would otherwise be fine
      const {result, warning, notice} = parse(endpoint, VERSION)

      // #then
      expect(result).toEqual({enabled: false})
      expect(warning).toHaveBeenCalledTimes(1)
      expect(warning).toHaveBeenCalledWith(TRACE_INPUT_MESSAGES.endpoint)
      expect(notice).not.toHaveBeenCalled()
      const text = String(warning.mock.calls[0]?.[0])
      expect(text).toContain('trace-endpoint')
      for (const piece of [endpoint, 'collector.example.test', 'user-name-1', 'pass-word-1', '169.254']) {
        expect(text).not.toContain(piece)
      }
    })

    it('is off with one warning when an http endpoint is set with any header, even a harmless one', () => {
      const {result, warning} = parse('http://127.0.0.1:4318/v1/traces', VERSION)

      expect(result).toEqual({enabled: false})
      expect(warning).toHaveBeenCalledTimes(1)
      expect(warning).toHaveBeenCalledWith(TRACE_INPUT_MESSAGES.credentialOverHttp)
      expect(String(warning.mock.calls[0]?.[0])).toContain('trace-headers')
    })

    it.each([
      ['a line without a colon', `${VERSION}\nAuthorization Basic ${ENCODED}`, 2],
      ['an empty name', `${VERSION}\n: ${BASIC}`, 2],
      ['an empty value', `\nAuthorization:   `, 2],
      ['a name with a space in it', `Bad Name: ${BASIC}`, 1],
      ['a host header', `${VERSION}\nHost: attacker.example.test`, 2],
      ['a content-length header', `Content-Length: 5`, 1],
      ['a content-type header', `${VERSION}\n\nContent-Type: application/json`, 3],
      ['a transfer-encoding header', `Transfer-Encoding: chunked`, 1],
      ['a connection header', `Connection: upgrade`, 1],
      ['a repeated name in another case', `${VERSION}\nX-LANGFUSE-INGESTION-VERSION: 5`, 2],
      ['a control character in a value', `${VERSION}\nX-Odd: abc\u0001defgh`, 2],
    ])('is off with one warning that names the input and the line number, for %s', (_name, headers, line) => {
      // #given a good endpoint and a header block with one refused line
      const {result, warning} = parse(ENDPOINT, headers)

      // #then
      expect(result).toEqual({enabled: false})
      expect(warning).toHaveBeenCalledTimes(1)
      const text = String(warning.mock.calls[0]?.[0])
      expect(text).toContain('trace-headers')
      expect(text).toContain(`line ${line}`)
      // nothing of any line, the endpoint, or a decoded credential is quoted
      for (const piece of [ENCODED, USER, PASSWORD, 'attacker.example.test', HOST_CANARY, 'chunked', 'upgrade']) {
        expect(text).not.toContain(piece)
      }
    })

    it('is off with one warning when there are more headers than the relay holds', () => {
      const headers = Array.from({length: 40}, (_value, index) => `X-Header-${index}: value-number-${index}`).join('\n')

      const {result, warning} = parse(ENDPOINT, headers)

      expect(result).toEqual({enabled: false})
      expect(warning).toHaveBeenCalledTimes(1)
      expect(String(warning.mock.calls[0]?.[0])).toContain('trace-headers')
    })

    it('never throws, whatever the input', () => {
      for (const endpoint of ['', ' ', '\u0000', 'https://', 'http://[', ENDPOINT.repeat(500)]) {
        for (const headers of ['', ':', '::', 'a:b', '\n\n\n', `A: ${'x'.repeat(100_000)}`]) {
          expect(() => parse(endpoint, headers)).not.toThrow()
        }
      }
    })
  })

  describe('masking', () => {
    it('masks the whole headers input, each line, each long value, and the endpoint', () => {
      // #given
      const headers = `Authorization: ${BASIC}\n${VERSION}`
      const {mask} = parse(ENDPOINT, headers)
      const values = masked(mask)

      // #then
      expect(values).toContain(ENDPOINT)
      expect(values).toContain(headers)
      expect(values).toContain(`Authorization: ${BASIC}`)
      expect(values).toContain(VERSION)
      expect(values).toContain(BASIC)
    })

    it('masks every derived form of a Basic value: the encoded part, the decoded pair and its password', () => {
      const {mask} = parse(ENDPOINT, `Authorization: ${BASIC}`)
      const values = masked(mask)

      expect(values).toContain(ENCODED)
      expect(values).toContain(`${USER}:${PASSWORD}`)
      expect(values).toContain(PASSWORD)
    })

    it('treats the Basic scheme in any case, and a token after Bearer', () => {
      const lower = parse(ENDPOINT, `authorization: basic ${ENCODED}`)
      expect(masked(lower.mask)).toEqual(expect.arrayContaining([ENCODED, `${USER}:${PASSWORD}`, PASSWORD]))

      const bearer = parse(ENDPOINT, 'Authorization: Bearer abcdefghijklmnop')
      expect(masked(bearer.mask)).toEqual(expect.arrayContaining(['Bearer abcdefghijklmnop', 'abcdefghijklmnop']))
    })

    it('does not mask a value shorter than eight characters, nor a derived piece that short', () => {
      // #given a one-character value, a seven-character value, and a Basic pair whose password is tiny
      const tinyPair = Buffer.from('a:b').toString('base64')
      const {mask} = parse(ENDPOINT, `X-One: 4\nX-Seven: 1234567\nAuthorization: Basic ${tinyPair}`)
      const values = masked(mask)

      // #then the short values are skipped (the lines that hold them are still masked whole)
      expect(values).not.toContain('4')
      expect(values).not.toContain('1234567')
      expect(values).not.toContain('b')
      expect(values).not.toContain('a:b')
      expect(values).not.toContain(tinyPair)
      expect(values).toContain('X-One: 4')
    })

    it('masks before it validates, so a refused input is masked too', () => {
      const {mask, warning} = parse('http://collector.example.test/v1/traces', `Authorization: ${BASIC}`)

      expect(warning).toHaveBeenCalledTimes(1)
      expect(masked(mask)).toEqual(expect.arrayContaining(['http://collector.example.test/v1/traces', BASIC, PASSWORD]))
    })

    it('masks the endpoint and the headers even when the endpoint is empty', () => {
      const {mask} = parse('', `Authorization: ${BASIC}`)

      expect(masked(mask)).toEqual(expect.arrayContaining([BASIC, PASSWORD]))
    })

    it('does not mask a decoded value that is not a credential pair', () => {
      // #given a Basic value that is not valid base64 of a user:password pair
      const {mask} = parse(ENDPOINT, 'Authorization: Basic not-base64!!!!')

      expect(masked(mask).filter(value => value.includes('\uFFFD'))).toEqual([])
    })
  })
})

describe('readTraceInputs', () => {
  const source = (values: Record<string, string>, env: Record<string, string | undefined> = {}) => ({
    getInput: (name: string) => values[name] ?? '',
    env,
  })

  it('reads, masks, removes and validates the two inputs, in that order, in one call', () => {
    // #given the runner's INPUT_ variables and the inputs they hold
    const env: Record<string, string | undefined> = {
      'INPUT_TRACE-ENDPOINT': ENDPOINT,
      'INPUT_TRACE-HEADERS': `Authorization: ${BASIC}`,
      PATH: '/usr/bin',
    }
    const {io, mask, warning} = createIo()

    // #when
    const result = readTraceInputs(
      source({'trace-endpoint': ENDPOINT, 'trace-headers': `Authorization: ${BASIC}`}, env),
      io,
    )

    // #then
    expect(result).toEqual({enabled: true, url: ENDPOINT, headers: [{name: 'Authorization', value: BASIC}]})
    expect(masked(mask)).toEqual(expect.arrayContaining([ENDPOINT, BASIC, PASSWORD]))
    expect(env['INPUT_TRACE-ENDPOINT']).toBeUndefined()
    expect(env['INPUT_TRACE-HEADERS']).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(warning).not.toHaveBeenCalled()
  })

  it('masks each form once: the parse that follows the masking does not repeat it', () => {
    // #given
    const {io, mask} = createIo()

    // #when
    readTraceInputs(source({'trace-endpoint': ENDPOINT, 'trace-headers': `Authorization: ${BASIC}`}), io)

    // #then
    expect(masked(mask).filter(value => value === ENDPOINT)).toHaveLength(1)
  })

  it('is off, with nothing masked and nothing said, when both inputs are empty', () => {
    // #given
    const {io, mask, warning, notice, info} = createIo()

    // #when
    const result = readTraceInputs(source({}), io)

    // #then
    expect(result).toEqual({enabled: false})
    expect(mask).not.toHaveBeenCalled()
    expect(warning).not.toHaveBeenCalled()
    expect(notice).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
  })

  it('removes the variables and masks the values when the inputs are refused, with one fixed warning', () => {
    // #given an http endpoint with a credential
    const env: Record<string, string | undefined> = {'INPUT_TRACE-ENDPOINT': 'x', 'INPUT_TRACE-HEADERS': 'y'}
    const {io, mask, warning} = createIo()

    // #when
    const result = readTraceInputs(
      source(
        {'trace-endpoint': 'http://collector.example.test/v1/traces', 'trace-headers': `Authorization: ${BASIC}`},
        env,
      ),
      io,
    )

    // #then
    expect(result).toEqual({enabled: false})
    expect(warning).toHaveBeenCalledTimes(1)
    expect(masked(mask)).toContain(BASIC)
    expect(Object.keys(env).filter(name => name.startsWith('INPUT_TRACE'))).toEqual([])
  })

  it('takes without validating: the post step can mask and remove before anything that can fail', () => {
    // #given
    const env: Record<string, string | undefined> = {'INPUT_TRACE-ENDPOINT': ENDPOINT}
    const {io, mask, warning} = createIo()

    // #when
    const raw = takeTraceInputs(source({'trace-endpoint': ENDPOINT, 'trace-headers': 'not a header'}, env), io)

    // #then
    expect(raw).toEqual({endpoint: ENDPOINT, headers: 'not a header'})
    expect(masked(mask)).toContain(ENDPOINT)
    expect(warning).not.toHaveBeenCalled()
    expect(env['INPUT_TRACE-ENDPOINT']).toBeUndefined()
  })
})
