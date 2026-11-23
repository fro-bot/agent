import {readFileSync} from 'node:fs'
import path from 'node:path'
import {
  ACTION_TRACING_OFF,
  buildTracingLauncherValue,
  formatTraceRelayCountsHeader,
  FRO_BOT_TRACING_LAUNCHER_ENV,
  parseTraceRelayCountsHeader,
  TRACE_RELAY_COUNTS_HEADER,
  TRACE_RELAY_PATH,
  TRACING_IDENTITY_FIELD_MAX_CHARS,
  TRACING_LAUNCHER_VERSION,
  tracingRelayUrl,
  WORKSPACE_TRACING_HOST,
  type OpenCodeV2TracingHost,
  type TracingRunIdentity,
} from '@fro-bot/runtime'
import {
  COLLECTOR_BODY_LIMIT_BYTES,
  DEFAULT_EXPORTER_LIMITS,
  formatCountsHeader,
  TRACE_COUNTS_HEADER,
} from '@fro-bot/runtime/tracing/exporter'
import {describe, expect, it} from 'vitest'
import {
  MAX_IDENTITY_FIELD_CHARS,
  MAX_LAUNCHER_CHARS,
  resolveTracingSettings,
  TRACING_LAUNCHER_ENV,
  TRACING_SETTINGS_VERSION,
} from './settings.js'

// The plugin must not import `@fro-bot/runtime` when it runs, so it mirrors what the Action's runtime writes and reads.
// These tests import both packages on purpose: a change to either side that the other does not follow fails here.

const IDENTITY: TracingRunIdentity = {
  repository: 'fro-bot/agent',
  runId: '987654321',
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
  }> = {},
): OpenCodeV2TracingHost => ({
  host: 'action',
  tracing: 'on',
  relayPort: 43_210,
  identity: IDENTITY,
  ...overrides,
})

function resolve(host: OpenCodeV2TracingHost) {
  const lines: string[] = []
  const settings = resolveTracingSettings({
    env: {[FRO_BOT_TRACING_LAUNCHER_ENV]: buildTracingLauncherValue(host)},
    directory: '/work/checkout',
    log: line => lines.push(line),
  })
  return {settings, lines}
}

describe('the launcher variable', () => {
  it('has the same name in the plugin and in the runtime that writes it', () => {
    // #given the name the plugin reads and the name the spawn function writes
    // #when / #then they must be the same string, or the plugin would never see what the launcher says
    expect(TRACING_LAUNCHER_ENV).toBe(FRO_BOT_TRACING_LAUNCHER_ENV)
    expect(FRO_BOT_TRACING_LAUNCHER_ENV).toBe('OPENCODE_FROBOT_TRACING')
  })

  it('has the same document version on both sides', () => {
    expect(TRACING_SETTINGS_VERSION).toBe(TRACING_LAUNCHER_VERSION)
  })
})

describe('the launcher document, as the runtime writes it and the plugin reads it', () => {
  it('reads Action on as on, with the relay on the relay path and the identity unchanged', () => {
    // #given an on host
    const {settings, lines} = resolve(on())

    // #then
    expect(settings).toEqual({
      mode: 'on',
      host: 'action',
      endpoint: tracingRelayUrl(43_210),
      identity: IDENTITY,
    })
    expect(new URL((settings as {endpoint: string}).endpoint).pathname).toBe(TRACE_RELAY_PATH)
    expect(lines).toEqual([])
  })

  it('reads the run link the runtime writes as the same three values, and a document without it as before', () => {
    // #given an on host with all three fields, and one with none
    const full = resolve(on({rootSpan: ROOT_SPAN, sessionId: SESSION_ID, invocationId: INVOCATION_ID}))
    const bare = resolve(on())

    // #then the plugin reads each value unchanged, and the bare document carries no key for them
    expect(full.settings).toEqual({
      mode: 'on',
      host: 'action',
      endpoint: tracingRelayUrl(43_210),
      identity: IDENTITY,
      rootSpan: ROOT_SPAN,
      sessionId: SESSION_ID,
      invocationId: INVOCATION_ID,
    })
    expect(full.lines).toEqual([])
    expect(Object.keys(bare.settings)).toEqual(['mode', 'host', 'endpoint', 'identity'])
  })

  it('agrees on the longest session id and invocation id, with every other field at its limit, inside the document ceiling', () => {
    // #given the longest value of each text field, and an identity at its limit
    const longest = {
      repository: 'r'.repeat(MAX_IDENTITY_FIELD_CHARS),
      runId: '1'.repeat(MAX_IDENTITY_FIELD_CHARS),
      attempt: '2'.repeat(MAX_IDENTITY_FIELD_CHARS),
      job: 'j'.repeat(MAX_IDENTITY_FIELD_CHARS),
      trigger: 't'.repeat(MAX_IDENTITY_FIELD_CHARS),
    }
    const sessionId = 's'.repeat(MAX_IDENTITY_FIELD_CHARS)
    const invocationId = 'i'.repeat(MAX_IDENTITY_FIELD_CHARS)
    const host = on({identity: longest, rootSpan: ROOT_SPAN, sessionId, invocationId})

    // #then it fits and reads as on; one character more is off on the runtime's side
    expect(buildTracingLauncherValue(host).length).toBeLessThan(MAX_LAUNCHER_CHARS)
    expect(resolve(host).settings).toMatchObject({mode: 'on', sessionId, invocationId})
    expect(resolve(on({sessionId: `${sessionId}s`})).settings).toEqual({mode: 'off', reason: 'action-off'})
  })

  it('reads Action off as a silent off', () => {
    const {settings, lines} = resolve(ACTION_TRACING_OFF)

    expect(settings).toEqual({mode: 'off', reason: 'action-off'})
    expect(lines).toEqual([])
  })

  it('reads the workspace as a silent off', () => {
    const {settings, lines} = resolve(WORKSPACE_TRACING_HOST)

    expect(settings).toEqual({mode: 'off', reason: 'workspace-host'})
    expect(lines).toEqual([])
  })

  it('agrees on the longest identity field: the runtime writes it on and the plugin reads it on', () => {
    // #given each field at exactly the limit both sides state
    expect(MAX_IDENTITY_FIELD_CHARS).toBe(TRACING_IDENTITY_FIELD_MAX_CHARS)
    const longest = {
      repository: 'r'.repeat(MAX_IDENTITY_FIELD_CHARS),
      runId: '1'.repeat(MAX_IDENTITY_FIELD_CHARS),
      attempt: '2'.repeat(MAX_IDENTITY_FIELD_CHARS),
      job: 'j'.repeat(MAX_IDENTITY_FIELD_CHARS),
      trigger: 't'.repeat(MAX_IDENTITY_FIELD_CHARS),
    }

    // #when / #then it still fits the plugin's whole-document ceiling and reads as on
    expect(buildTracingLauncherValue(on({identity: longest})).length).toBeLessThan(MAX_LAUNCHER_CHARS)
    expect(resolve(on({identity: longest})).settings).toMatchObject({mode: 'on', identity: longest})
  })

  it('agrees on one character past the limit: the runtime writes off, and the plugin would refuse the field anyway', () => {
    // #given a field one past the limit
    const tooLong = {...IDENTITY, job: 'j'.repeat(MAX_IDENTITY_FIELD_CHARS + 1)}

    // #then the runtime never writes it, so the plugin reads the Action's off
    expect(resolve(on({identity: tooLong})).settings).toEqual({mode: 'off', reason: 'action-off'})

    // #and the plugin, handed such a document directly, refuses it with a reason
    const direct = resolveTracingSettings({
      env: {
        [FRO_BOT_TRACING_LAUNCHER_ENV]: JSON.stringify({
          version: 1,
          host: 'action',
          tracing: 'on',
          relay: tracingRelayUrl(43_210),
          identity: tooLong,
        }),
      },
      directory: '/work/checkout',
      log: () => undefined,
    })
    expect(direct).toEqual({mode: 'off', reason: 'launcher-identity-invalid'})
  })
})

describe('the request body limits', () => {
  it('keeps the plugin’s batch limit under the relay’s body cap, which is under nothing it could be refused by', () => {
    // #given the relay's cap, read from its source (the constant is not exported from the runtime package)
    const source = readFileSync(path.resolve(import.meta.dirname, '../../../runtime/src/agent/trace-relay.ts'), 'utf8')
    const cap = /maxRequestBodyBytes:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(source)
    expect(cap).not.toBeNull()
    const relayCap = Number(cap?.[1]) * 1024 * 1024

    // #then plugin limit <= relay cap, and plugin limit < the collector's front-proxy refusal threshold with headroom
    expect(DEFAULT_EXPORTER_LIMITS.maxBatchBytes).toBeLessThanOrEqual(relayCap)
    expect(DEFAULT_EXPORTER_LIMITS.maxBatchBytes).toBeLessThanOrEqual(COLLECTOR_BODY_LIMIT_BYTES - 512 * 1024)
    expect(relayCap).toBe(16 * 1024 * 1024)
  })
})

describe('the counts header', () => {
  it('is the same header name on both sides', () => {
    expect(TRACE_COUNTS_HEADER).toBe(TRACE_RELAY_COUNTS_HEADER)
    expect(TRACE_RELAY_COUNTS_HEADER).toBe('x-frobot-trace-counts')
  })

  it.each([
    [0, 0],
    [1, 0],
    [12, 3],
    [123_456_789_012, 999_999_999_999],
    [10 ** 15, 7],
  ])('writes %i exported and %i dropped as a value the relay reads back to the same numbers', (exported, dropped) => {
    // #given the plugin's formatting
    const value = formatCountsHeader({exported, dropped})

    // #then it is the relay's own format for the same numbers (capped at twelve digits), and the relay parses it
    const cap = 999_999_999_999
    const capped = {exportedSpans: Math.min(exported, cap), droppedSpans: Math.min(dropped, cap)}
    expect(value).toBe(formatTraceRelayCountsHeader(capped))
    expect(parseTraceRelayCountsHeader(value)).toEqual(capped)
  })
})
