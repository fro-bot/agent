import {describe, expect, it} from 'vitest'
import {FRO_BOT_TRACING_LAUNCHER_ENV} from '../shared/constants.js'
import {TRACE_RELAY_PATH} from './trace-relay-wire.js'
import {
  ACTION_TRACING_OFF,
  buildTracingLauncherValue,
  isUsableTracingIdentity,
  TRACING_IDENTITY_FIELD_MAX_CHARS,
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

const on = (overrides: Partial<{relayPort: number; identity: TracingRunIdentity}> = {}): OpenCodeV2TracingHost => ({
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
