import {
  buildTracingLauncherValue,
  encodeTraceRelayConfig,
  parseTraceRelayConfig,
  TRACE_RELAY_PATH,
  TRACING_IDENTITY_FIELD_MAX_CHARS,
} from '@fro-bot/runtime'
import {describe, expect, it} from 'vitest'
import {unwrapErr, unwrapOk} from '../../shared/test-helpers.js'
import {buildActionTracingHost, buildTracingRunIdentity, relayRequestFromInputs} from './tracing.js'

const HOST_CANARY = 'collector-canary.example.test'
const CREDENTIAL_CANARY = 'Basic cnVuLXRyYWNpbmctY2FuYXJ5LTAwMDc6c2VjcmV0'
const URL_CANARY = `https://${HOST_CANARY}/api/public/otel/v1/traces`

const FACTS = {
  repository: 'fro-bot/agent',
  runId: '987654321',
  attempt: 2,
  job: 'review-m1a2b3c4d',
  trigger: 'pull_request',
} as const

const ON = {enabled: true, url: URL_CANARY, headers: [{name: 'Authorization', value: CREDENTIAL_CANARY}]} as const

describe('relayRequestFromInputs', () => {
  it('turns the parsed inputs into the relay config: the URL and the credential headers', () => {
    // #given both inputs parsed to on
    const request = relayRequestFromInputs(ON)

    // #then
    expect(request).toEqual({url: URL_CANARY, headers: [{name: 'Authorization', value: CREDENTIAL_CANARY}]})
    // and it is a frame the relay accepts, byte for byte what the supervisor will write
    expect(request).not.toBeNull()
    const parsed = unwrapOk(parseTraceRelayConfig({version: 1, url: request?.url, headers: request?.headers}))
    expect(encodeTraceRelayConfig(parsed).subarray(4).toString('utf8')).toContain(CREDENTIAL_CANARY)
  })

  it('is null when tracing is off, so no relay is started', () => {
    expect(relayRequestFromInputs({enabled: false})).toBeNull()
  })

  it('keeps a no-credential endpoint with an empty header list', () => {
    expect(relayRequestFromInputs({enabled: true, url: 'http://127.0.0.1:4318/v1/traces', headers: []})).toEqual({
      url: 'http://127.0.0.1:4318/v1/traces',
      headers: [],
    })
  })
})

describe('buildTracingRunIdentity', () => {
  it('names the repository, run, attempt, job and trigger, all as strings', () => {
    // #given / #when
    const identity = unwrapOk(buildTracingRunIdentity(FACTS))

    // #then
    expect(identity).toEqual({
      repository: 'fro-bot/agent',
      runId: '987654321',
      attempt: '2',
      job: 'review-m1a2b3c4d',
      trigger: 'pull_request',
    })
  })

  it.each([
    ['no job', {...FACTS, job: null}],
    ['an empty job', {...FACTS, job: ''}],
    ['an empty repository', {...FACTS, repository: ''}],
    ['an empty run id', {...FACTS, runId: ''}],
    ['an empty trigger', {...FACTS, trigger: ''}],
    ['an attempt that is not a number', {...FACTS, attempt: Number.NaN}],
    ['a field over the plugin limit', {...FACTS, repository: 'x'.repeat(TRACING_IDENTITY_FIELD_MAX_CHARS + 1)}],
  ])('is incomplete, never a guessed value, for %s', (_name, facts) => {
    expect(unwrapErr(buildTracingRunIdentity(facts))).toBe('incomplete')
  })
})

describe('buildActionTracingHost', () => {
  const identity = unwrapOk(buildTracingRunIdentity(FACTS))

  it('is on with the relay port and the identity when the relay is running', () => {
    expect(buildActionTracingHost(43_210, identity)).toEqual({
      host: 'action',
      tracing: 'on',
      relayPort: 43_210,
      identity,
    })
  })

  it('is off when there is no relay: one that failed to start, a failed bundle check, or tracing off', () => {
    expect(buildActionTracingHost(null, identity)).toEqual({host: 'action', tracing: 'off'})
  })

  it('is off when there is no identity', () => {
    expect(buildActionTracingHost(43_210, null)).toEqual({host: 'action', tracing: 'off'})
  })

  it('produces a launcher document with the relay address and identity, and no credential or collector host', () => {
    // #given an on host built from facts, beside a request that holds a canary credential and host
    const request = relayRequestFromInputs(ON)
    const value = buildTracingLauncherValue(buildActionTracingHost(43_210, identity))

    // #then the document names the loopback relay on the relay's own path and the identity
    expect(JSON.parse(value)).toEqual({
      version: 1,
      host: 'action',
      tracing: 'on',
      relay: `http://127.0.0.1:43210${TRACE_RELAY_PATH}`,
      identity,
    })
    // and nothing of the collector or its credential is in it
    expect(request?.url).toContain(HOST_CANARY)
    expect(value).not.toContain(HOST_CANARY)
    expect(value).not.toContain(CREDENTIAL_CANARY)
    expect(value).not.toContain('Authorization')
  })

  it('says off in the launcher document when there is no relay', () => {
    expect(buildTracingLauncherValue(buildActionTracingHost(null, identity))).toBe(
      '{"version":1,"host":"action","tracing":"off"}',
    )
  })
})
