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
import {describe, expect, it} from 'vitest'

import {formatCountsHeader, TRACE_COUNTS_HEADER} from './exporter.js'
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

const on = (overrides: Partial<{relayPort: number; identity: TracingRunIdentity}> = {}): OpenCodeV2TracingHost => ({
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
