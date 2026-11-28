import {describe, expect, it} from 'vitest'
import {FRO_BOT_TRACING_LAUNCHER_ENV} from '../shared/constants.js'
import {TRACE_RELAY_PATH} from './trace-relay-wire.js'
import {
  ACTION_TRACING_OFF,
  buildTracingLauncherValue,
  isUsableTracingField,
  isUsableTracingIdentity,
  isUsableTracingRootSpan,
  isUsableTracingServerUrl,
  TRACING_IDENTITY_FIELD_MAX_CHARS,
  TRACING_LAUNCHER_MAX_CHARS,
  tracingRelayUrl,
  WORKSPACE_TRACING_HOST,
  type OpenCodeV2TracingHost,
  type TracingRunIdentity,
} from './tracing-launcher.js'

const IDENTITY: TracingRunIdentity = {
  repository: 'fro-bot/agent',
  runId: '123456789',
  attempt: '2',
  job: 'review-m1a2b3c4d',
  trigger: 'pull_request',
}

const ROOT_SPAN = {traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331'}
const SESSION_ID = 'fro-bot/agent:issue-42'
const INVOCATION_ID = '3f2a9c1e-7b4d-4e8a-9d6c-1a2b3c4d5e6f'

const on = (
  overrides: Partial<{
    relayPort: number
    identity: TracingRunIdentity
    rootSpan: {traceId: string; spanId: string}
    sessionId: string
    invocationId: string
    serverUrl: string
  }> = {},
): OpenCodeV2TracingHost => ({
  host: 'action',
  tracing: 'on',
  relayPort: 43_210,
  identity: IDENTITY,
  ...overrides,
})

describe('buildTracingLauncherValue', () => {
  it('says Action off in exactly the versioned form the plugin reads', () => {
    // #given / #when
    const value = buildTracingLauncherValue(ACTION_TRACING_OFF)

    // #then
    expect(value).toBe('{"version":1,"host":"action","tracing":"off"}')
  })

  it('says workspace in exactly the versioned form the plugin reads', () => {
    expect(buildTracingLauncherValue(WORKSPACE_TRACING_HOST)).toBe('{"version":1,"host":"workspace","tracing":"off"}')
  })

  it('carries the relay address and the run identity when Action tracing is on, and nothing else', () => {
    // #given / #when
    const value = buildTracingLauncherValue(on())

    // #then
    expect(JSON.parse(value)).toEqual({
      version: 1,
      host: 'action',
      tracing: 'on',
      relay: 'http://127.0.0.1:43210/v1/traces',
      identity: IDENTITY,
    })
    expect(Object.keys(JSON.parse(value) as object)).toEqual(['version', 'host', 'tracing', 'relay', 'identity'])
  })

  it.each([0, -1, 65_536, 1.5, Number.NaN])('says off, never an unusable address, for relay port %s', port => {
    expect(buildTracingLauncherValue(on({relayPort: port}))).toBe(buildTracingLauncherValue(ACTION_TRACING_OFF))
  })

  it.each([
    ['an empty field', {...IDENTITY, job: ''}],
    ['a field over the plugin limit', {...IDENTITY, repository: 'x'.repeat(TRACING_IDENTITY_FIELD_MAX_CHARS + 1)}],
    ['a control character', {...IDENTITY, trigger: 'push\nextra'}],
  ])('says off, never an identity the plugin would refuse, for %s', (_name, identity) => {
    expect(buildTracingLauncherValue(on({identity}))).toBe(buildTracingLauncherValue(ACTION_TRACING_OFF))
  })

  it('keeps a field exactly at the plugin limit', () => {
    const identity = {...IDENTITY, job: 'j'.repeat(TRACING_IDENTITY_FIELD_MAX_CHARS)}
    expect(JSON.parse(buildTracingLauncherValue(on({identity}))) as {tracing: string}).toMatchObject({tracing: 'on'})
  })
})

describe('the run link fields', () => {
  it('carries the root span context, the session id and the invocation id, verbatim, when all three are given', () => {
    // #given / #when
    const value = buildTracingLauncherValue(
      on({rootSpan: ROOT_SPAN, sessionId: SESSION_ID, invocationId: INVOCATION_ID}),
    )

    // #then
    expect(JSON.parse(value)).toEqual({
      version: 1,
      host: 'action',
      tracing: 'on',
      relay: 'http://127.0.0.1:43210/v1/traces',
      identity: IDENTITY,
      rootSpan: ROOT_SPAN,
      sessionId: SESSION_ID,
      invocationId: INVOCATION_ID,
    })
  })

  it('writes no serverUrl key, and the same bytes as before the field existed, when none is supplied', () => {
    // #given the run link as the Action builds it today
    const link = {rootSpan: ROOT_SPAN, sessionId: SESSION_ID, invocationId: INVOCATION_ID}
    const prefix =
      '{"version":1,"host":"action","tracing":"on","relay":"http://127.0.0.1:43210/v1/traces","identity":' +
      `{"repository":"fro-bot/agent","runId":"123456789","attempt":"2","job":"review-m1a2b3c4d","trigger":"pull_request"}`

    // #then a bare host and a fully linked one are exactly the old documents, with no key for the server
    expect(buildTracingLauncherValue(on())).toBe(`${prefix}}`)
    expect(buildTracingLauncherValue(on(link))).toBe(
      `${prefix},"rootSpan":{"traceId":"${ROOT_SPAN.traceId}","spanId":"${ROOT_SPAN.spanId}"},"sessionId":"${SESSION_ID}","invocationId":"${INVOCATION_ID}"}`,
    )
    expect(buildTracingLauncherValue(on(link))).not.toContain('serverUrl')
  })

  it('carries the GitHub server as an origin when it is given, and no key for it when it is not', () => {
    // #given a host with a server, and one without
    const given = JSON.parse(buildTracingLauncherValue(on({serverUrl: 'https://github.com'}))) as Record<
      string,
      unknown
    >
    const absent = JSON.parse(buildTracingLauncherValue(on())) as Record<string, unknown>

    // #then only the one that was given carries it
    expect(given.serverUrl).toBe('https://github.com')
    expect('serverUrl' in absent).toBe(false)
  })

  it.each([
    ['an empty server', ''],
    ['a plain http server', 'http://github.com'],
    ['a server with a path', 'https://github.com/org'],
    ['a server with a query', 'https://github.com?x=1'],
    ['a server with a fragment', 'https://github.com/#x'],
    ['a server with userinfo', 'https://user:pw@github.com'],
    ['a server with an upper-case host', 'https://GitHub.com'],
    ['a server with the default port spelled out', 'https://github.com:443'],
    ['a server with no scheme', 'github.com'],
    ['a server over the limit', `https://${'a'.repeat(TRACING_IDENTITY_FIELD_MAX_CHARS)}.com`],
    ['a server with a control character', 'https://github\n.com'],
  ])('says off, never a server the plugin would refuse, for %s', (_name, serverUrl) => {
    expect(buildTracingLauncherValue(on({serverUrl}))).toBe(buildTracingLauncherValue(ACTION_TRACING_OFF))
  })

  it('writes only the fields it was given', () => {
    expect(Object.keys(JSON.parse(buildTracingLauncherValue(on({sessionId: SESSION_ID}))) as object)).toEqual([
      'version',
      'host',
      'tracing',
      'relay',
      'identity',
      'sessionId',
    ])
  })

  it.each([
    ['a short trace id', {traceId: 'abc', spanId: ROOT_SPAN.spanId}],
    ['an upper-case trace id', {traceId: ROOT_SPAN.traceId.toUpperCase(), spanId: ROOT_SPAN.spanId}],
    ['an all-zero trace id', {traceId: '0'.repeat(32), spanId: ROOT_SPAN.spanId}],
    ['a long span id', {traceId: ROOT_SPAN.traceId, spanId: `${ROOT_SPAN.spanId}0`}],
    ['an all-zero span id', {traceId: ROOT_SPAN.traceId, spanId: '0'.repeat(16)}],
    ['a non-hex span id', {traceId: ROOT_SPAN.traceId, spanId: 'g'.repeat(16)}],
  ])('says off, never a root span context the plugin would refuse, for %s', (_name, rootSpan) => {
    expect(buildTracingLauncherValue(on({rootSpan}))).toBe(buildTracingLauncherValue(ACTION_TRACING_OFF))
  })

  it.each([
    ['an empty session id', {sessionId: ''}],
    ['a session id over the limit', {sessionId: 's'.repeat(TRACING_IDENTITY_FIELD_MAX_CHARS + 1)}],
    ['a session id with a control character', {sessionId: 'a/b:c\nd'}],
    ['an empty invocation id', {invocationId: ''}],
    ['an invocation id over the limit', {invocationId: 'i'.repeat(TRACING_IDENTITY_FIELD_MAX_CHARS + 1)}],
  ])('says off, never a value the plugin would refuse, for %s', (_name, fields) => {
    expect(buildTracingLauncherValue(on(fields))).toBe(buildTracingLauncherValue(ACTION_TRACING_OFF))
  })

  it('keeps a session id exactly at the limit', () => {
    const sessionId = 's'.repeat(TRACING_IDENTITY_FIELD_MAX_CHARS)
    expect(JSON.parse(buildTracingLauncherValue(on({sessionId}))) as {sessionId: string}).toMatchObject({sessionId})
  })

  it.each([
    ['null', null],
    ['a string', 'abc'],
    ['a number', 7],
    ['an array', []],
  ])('says off, and does not throw, for a root span that is %s (an untyped caller)', (_name, rootSpan) => {
    expect(buildTracingLauncherValue(on({rootSpan: rootSpan as unknown as {traceId: string; spanId: string}}))).toBe(
      buildTracingLauncherValue(ACTION_TRACING_OFF),
    )
  })

  it('writes only the two ids of a root span, whatever else the caller put on it', () => {
    const rootSpan = {...ROOT_SPAN, extra: 'SENTINEL'}
    const value = buildTracingLauncherValue(on({rootSpan}))
    expect(value).not.toContain('SENTINEL')
    expect(JSON.parse(value) as {rootSpan: unknown}).toMatchObject({rootSpan: ROOT_SPAN})
  })

  it('says off when the serialized document is over the plugin’s ceiling, and never writes one the plugin would refuse', () => {
    // #given a host whose every text field is `n` lone surrogates: control-free, so each field is accepted, but JSON.stringify
    // writes each lone surrogate as a six-character escape, so the document grows far past its fields' own lengths
    const lone = (n: number): string => '\uD800'.repeat(n)
    const host = (n: number): OpenCodeV2TracingHost =>
      on({
        identity: {repository: lone(n), runId: lone(n), attempt: lone(n), job: lone(n), trigger: lone(n)},
        sessionId: lone(n),
        invocationId: lone(n),
      })

    // #when the field length grows to its limit
    const lengths: number[] = []
    let sawOn = false
    let sawOff = false
    for (let n = 1; n <= TRACING_IDENTITY_FIELD_MAX_CHARS; n += 1) {
      const value = buildTracingLauncherValue(host(n))
      lengths.push(value.length)
      if ((JSON.parse(value) as {tracing: string}).tracing === 'on') sawOn = true
      else sawOff = true
    }

    // #then no document is over the ceiling, short fields are still on, and the longest are off
    expect(Math.max(...lengths)).toBeLessThanOrEqual(TRACING_LAUNCHER_MAX_CHARS)
    expect(sawOn).toBe(true)
    expect(sawOff).toBe(true)
    expect(buildTracingLauncherValue(host(TRACING_IDENTITY_FIELD_MAX_CHARS))).toBe(
      buildTracingLauncherValue(ACTION_TRACING_OFF),
    )
  })

  it('does not write the fields for an off host', () => {
    expect(buildTracingLauncherValue(ACTION_TRACING_OFF)).not.toContain('rootSpan')
  })
})

describe('isUsableTracingServerUrl', () => {
  it.each(['https://github.com', 'https://github.com/', 'https://ghe.example.com:8443'])('accepts %s', value => {
    expect(isUsableTracingServerUrl(value)).toBe(true)
  })

  it.each([undefined, null, 443, {}, '', 'http://github.com', 'https://github.com/a', 'https://a@github.com'])(
    'refuses %s',
    value => {
      expect(isUsableTracingServerUrl(value)).toBe(false)
    },
  )
})

describe('isUsableTracingRootSpan and isUsableTracingField', () => {
  it('accepts 32 and 16 lower-case hex characters with a non-zero value, and nothing else', () => {
    expect(isUsableTracingRootSpan(ROOT_SPAN)).toBe(true)
    expect(isUsableTracingRootSpan({traceId: `${'0'.repeat(31)}1`, spanId: `${'0'.repeat(15)}1`})).toBe(true)
    expect(isUsableTracingRootSpan({traceId: '0'.repeat(32), spanId: ROOT_SPAN.spanId})).toBe(false)
    expect(isUsableTracingRootSpan({traceId: ROOT_SPAN.traceId, spanId: undefined as unknown as string})).toBe(false)
  })

  it('accepts a bounded, non-empty string without control characters', () => {
    expect(isUsableTracingField('a')).toBe(true)
    expect(isUsableTracingField('')).toBe(false)
    expect(isUsableTracingField(7)).toBe(false)
  })
})

describe('tracingRelayUrl', () => {
  it('is the loopback address on the relay port and the one path the relay serves', () => {
    // #given the relay's own path constant, not a literal
    // #when / #then
    expect(tracingRelayUrl(5151)).toBe(`http://127.0.0.1:5151${TRACE_RELAY_PATH}`)
  })
})

describe('isUsableTracingIdentity', () => {
  it('accepts a complete identity and refuses a missing, empty or non-string field', () => {
    expect(isUsableTracingIdentity(IDENTITY)).toBe(true)
    expect(isUsableTracingIdentity({...IDENTITY, runId: ''})).toBe(false)
    expect(isUsableTracingIdentity({...IDENTITY, attempt: undefined as unknown as string})).toBe(false)
  })
})

describe('launcher variable name', () => {
  it('is the OPENCODE_-prefixed name the Action environment filter admits', () => {
    expect(FRO_BOT_TRACING_LAUNCHER_ENV).toBe('OPENCODE_FROBOT_TRACING')
  })
})
