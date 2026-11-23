import {createHash} from 'node:crypto'
import {
  buildTracingLauncherValue,
  encodeTraceRelayConfig,
  parseTraceRelayConfig,
  TRACE_RELAY_PATH,
  TRACING_IDENTITY_FIELD_MAX_CHARS,
} from '@fro-bot/runtime'
import {createScrubber} from '@fro-bot/runtime/tracing/scrub'
import {describe, expect, it, vi} from 'vitest'
import {createRegistryScrubber, createSecretRegistry} from '../../shared/secret-registry.js'
import {unwrapErr, unwrapOk} from '../../shared/test-helpers.js'
import {
  buildActionTracingHost,
  buildTraceSessionId,
  buildTracingRunIdentity,
  buildTracingRunLink,
  liveActionTracingHost,
  readLifecycleRunIdentity,
  relayRequestFromInputs,
  resolveActionTracing,
} from './tracing.js'

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

describe('liveActionTracingHost', () => {
  const identity = unwrapOk(buildTracingRunIdentity(FACTS))

  it('reads the relay at each evaluation: on while it lives, off from the moment it has crashed', () => {
    // #given a relay that is up when the source is made
    let crashed = false
    const source = liveActionTracingHost({port: 43_210, crashed: () => crashed}, identity)

    // #when it is read before and after the crash
    const before = source()
    crashed = true
    const after = source()

    // #then the first reading is on, with the port, and the second is off: a dead relay is never named to the plugin
    expect(before).toEqual({host: 'action', tracing: 'on', relayPort: 43_210, identity})
    expect(after).toEqual({host: 'action', tracing: 'off'})
  })

  it('stays off once off: a relay cannot come back, and a read after a crash never says on again', () => {
    let crashed = true
    const source = liveActionTracingHost({port: 43_210, crashed: () => crashed}, identity)
    expect(source().tracing).toBe('off')
    crashed = false
    expect(source().tracing).toBe('off')
  })

  it('is on for every evaluation while the relay lives (a second server in the run is told the same)', () => {
    const source = liveActionTracingHost({port: 1, crashed: () => false}, identity)
    expect([source().tracing, source().tracing]).toEqual(['on', 'on'])
  })
})

describe('resolveActionTracing', () => {
  it('returns a plain host as it is, and calls a source each time it is asked', () => {
    const off = buildActionTracingHost(null, null)
    const source = vi.fn(() => off)

    expect(resolveActionTracing(off)).toBe(off)
    expect(resolveActionTracing(source)).toBe(off)
    expect(resolveActionTracing(source)).toBe(off)
    expect(source).toHaveBeenCalledTimes(2)
  })
})

describe('buildTraceSessionId', () => {
  const hashed = (candidate: string): string =>
    `sha256:${createHash('sha256').update(candidate, 'utf8').digest('hex').slice(0, 32)}`

  it('qualifies the repository-local logical key with the repository', () => {
    expect(buildTraceSessionId('fro-bot', 'agent', 'issue-42', createScrubber())).toBe('fro-bot/agent:issue-42')
  })

  it('differs between two repositories on the same issue number', () => {
    const scrubber = createScrubber()
    expect(buildTraceSessionId('fro-bot', 'agent', 'issue-42', scrubber)).not.toBe(
      buildTraceSessionId('fro-bot', 'other', 'issue-42', scrubber),
    )
  })

  it('is bounded to the launcher’s 200 characters by the shared helper’s hashed form, and keeps long keys apart', () => {
    // #given two keys that agree for the first 300 characters
    const scrubber = createScrubber()
    const prefix = 'x'.repeat(300)
    const a = buildTraceSessionId('fro-bot', 'agent', `${prefix}-a`, scrubber)
    const b = buildTraceSessionId('fro-bot', 'agent', `${prefix}-b`, scrubber)

    // #then both are the hashed form (39 characters), differ, and are the same every time
    expect(a).toBe(hashed(`fro-bot/agent:${prefix}-a`))
    expect(b).toBe(hashed(`fro-bot/agent:${prefix}-b`))
    expect(a).not.toBe(b)
    expect(a).toHaveLength(39)
    expect(buildTraceSessionId('fro-bot', 'agent', `${prefix}-a`, scrubber)).toBe(a)
  })

  it('leaves a key that fits exactly at the limit untouched', () => {
    const key = 'k'.repeat(TRACING_IDENTITY_FIELD_MAX_CHARS - 'fro-bot/agent:'.length)
    expect(buildTraceSessionId('fro-bot', 'agent', key, createScrubber())).toBe(`fro-bot/agent:${key}`)
  })

  it('hashes a repository name the Action’s scrubber would redact, with the registry’s literals in it', () => {
    // #given a registry that holds the candidate's repository as a secret, as a masked input could
    const registry = createSecretRegistry(vi.fn())
    registry.add('payments-secret-repo')
    const scrubber = createRegistryScrubber(registry)

    // #when
    const id = buildTraceSessionId('acme', 'payments-secret-repo', 'issue-42', scrubber)

    // #then no id holds the literal: the hashed form stands in
    expect(id).toBe(hashed('acme/payments-secret-repo:issue-42'))
    expect(id).not.toContain('payments-secret-repo')
  })

  it('returns nothing when the scrubber would change both the candidate and its hash', () => {
    const candidate = 'acme/repo:issue-42'
    const scrubber = createScrubber({extraSecrets: [candidate, hashed(candidate)]})
    expect(buildTraceSessionId('acme', 'repo', 'issue-42', scrubber)).toBeUndefined()
  })

  it('returns nothing for a key with a lone surrogate, rather than one id for two keys', () => {
    const scrubber = createScrubber()
    expect([
      buildTraceSessionId('acme', 'repo', 'issue-\uD800', scrubber),
      buildTraceSessionId('acme', 'repo', 'issue-\uD801', scrubber),
    ]).toEqual([undefined, undefined])
  })
})

describe('buildTracingRunLink', () => {
  const ids = {traceId: 'a'.repeat(32), rootSpanId: 'b'.repeat(16), invocationId: 'c'.repeat(16)}

  it('carries the root span (trace and span id), the invocation id and the session', () => {
    expect(buildTracingRunLink(ids, 'fro-bot/agent:issue-42')).toEqual({
      rootSpan: {traceId: ids.traceId, spanId: ids.rootSpanId},
      invocationId: ids.invocationId,
      sessionId: 'fro-bot/agent:issue-42',
    })
  })

  it('carries no session when there is none, and nothing but the session when the tracer is off', () => {
    expect(buildTracingRunLink(ids, undefined)).toEqual({
      rootSpan: {traceId: ids.traceId, spanId: ids.rootSpanId},
      invocationId: ids.invocationId,
    })
    expect(buildTracingRunLink(null, 'fro-bot/agent:issue-42')).toEqual({sessionId: 'fro-bot/agent:issue-42'})
    expect(buildTracingRunLink(null, undefined)).toEqual({})
  })

  it('produces a launcher document the plugin reads: the three fields, and nothing of the collector', () => {
    // #given an on host with the link
    const identity = unwrapOk(buildTracingRunIdentity(FACTS))
    const value = buildTracingLauncherValue(
      buildActionTracingHost(43_210, identity, buildTracingRunLink(ids, 'fro-bot/agent:issue-42')),
    )

    // #then
    expect(JSON.parse(value)).toMatchObject({
      version: 1,
      host: 'action',
      tracing: 'on',
      rootSpan: {traceId: ids.traceId, spanId: ids.rootSpanId},
      sessionId: 'fro-bot/agent:issue-42',
      invocationId: ids.invocationId,
    })
    expect(value).not.toContain(HOST_CANARY)
    expect(value).not.toContain(CREDENTIAL_CANARY)
  })

  it('keeps the link through every read of a live source, and drops all of it with the relay', () => {
    // #given
    const identity = unwrapOk(buildTracingRunIdentity(FACTS))
    let crashed = false
    const source = liveActionTracingHost(
      {port: 43_210, crashed: () => crashed},
      identity,
      buildTracingRunLink(ids, 'fro-bot/agent:issue-42'),
    )

    // #then
    expect(source()).toMatchObject({tracing: 'on', sessionId: 'fro-bot/agent:issue-42', invocationId: ids.invocationId})
    crashed = true
    expect(source()).toEqual({host: 'action', tracing: 'off'})
  })
})

describe('readLifecycleRunIdentity', () => {
  it('reads whatever of the identity the environment holds, and leaves out the rest', () => {
    expect(
      readLifecycleRunIdentity({GITHUB_REPOSITORY: 'fro-bot/agent', GITHUB_RUN_ID: '77', GITHUB_EVENT_NAME: ' '}, null),
    ).toEqual({repository: 'fro-bot/agent', runId: '77'})
  })

  it('takes the job from the invocation identity', () => {
    expect(readLifecycleRunIdentity({GITHUB_RUN_ATTEMPT: '2'}, 'triage')).toEqual({attempt: '2', job: 'triage'})
  })
})
