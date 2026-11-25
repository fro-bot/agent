import type {OtlpSink, SinkRequest} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import type {CreateLifecycleTracerOptions, LifecycleTracer} from './lifecycle-tracer.js'
import {Buffer} from 'node:buffer'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {startOtlpSink} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import {createLifecycleTracer, FREE_TEXT_MAX_CHARS, SUMMARY_ATTRIBUTE, SUMMARY_MAX_BYTES} from './lifecycle-tracer.js'
import {createSecretRegistry} from './secret-registry.js'
import {createMockLogger} from './test-helpers.js'

/**
 * The root span's Langfuse summary: `langfuse.observation.input|output|level|status_message` on `action.main`, and on no other
 * span, as the collector receives them. Langfuse's Sessions view shows a trace's input and output from its root observation, so
 * without these the Action's trace reads "No messages".
 */

interface Wire {
  readonly name: string
  readonly attributes: {key: string; value: Record<string, unknown>}[]
  readonly status?: {code?: number; message?: string}
}

const spansOf = (request: SinkRequest): Wire[] =>
  (request.body as {resourceSpans: {scopeSpans: {spans: Wire[]}[]}[]}).resourceSpans.flatMap(resource =>
    resource.scopeSpans.flatMap(scope => scope.spans),
  )

const attr = (span: Wire, key: string): string | undefined => {
  const value = span.attributes.find(item => item.key === key)?.value
  return value === undefined ? undefined : (value.stringValue as string | undefined)
}
const named = (spans: readonly Wire[], name: string): Wire => {
  const found = spans.find(span => span.name === name)
  if (found === undefined) throw new Error(`no span named ${name}`)
  return found
}
const json = (span: Wire, key: string): Record<string, unknown> => {
  const text = attr(span, key)
  if (text === undefined) throw new Error(`no ${key} on ${span.name}`)
  return JSON.parse(text) as Record<string, unknown>
}

const KEYS = [
  'langfuse.observation.input',
  'langfuse.observation.output',
  'langfuse.observation.level',
  'langfuse.observation.status_message',
] as const

const CANARY = 'ZZ-98765-canary-token'
const escaped = (value: string): string => JSON.stringify(value).slice(1, -1)

const sinks: OtlpSink[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(sinks.splice(0).map(async started => started.stop()))
})

async function setup(overrides: Partial<CreateLifecycleTracerOptions> = {}): Promise<{
  readonly target: OtlpSink
  readonly tracer: LifecycleTracer
  readonly registry: ReturnType<typeof createSecretRegistry>
}> {
  const target = await startOtlpSink()
  sinks.push(target)
  let clock = 1_700_000_000_000
  const registry = createSecretRegistry(() => undefined)
  const tracer = createLifecycleTracer({
    inputs: {enabled: true, url: target.url, headers: []},
    logger: createMockLogger(),
    registry,
    env: {},
    now: () => {
      clock += 10
      return clock
    },
    exporterLimits: {batchIntervalMs: 15, requestTimeoutMs: 2_500, maxConsecutiveFailures: 3},
    identity: {repository: 'fro-bot/agent', trigger: 'issue_comment'},
    ...overrides,
  })
  return {target, tracer, registry}
}

const exported = (target: OtlpSink): Wire[] => target.accepted().flatMap(spansOf)
const anyNumber: unknown = expect.any(Number)
const containing = (text: string): unknown => expect.stringContaining(text)

/** A run that went well: three phases, one with a child, and a root that ends with a reason. */
async function normalRun(): Promise<Wire[]> {
  const {target, tracer} = await setup()
  tracer.setRunInput({isolateAgent: false, ref: 'main'})
  tracer.setRunInput({event: 'issue_comment.created'})
  tracer.startSpan('bootstrap').end({outcome: 'succeeded'})
  const execution = tracer.startSpan('execution')
  execution.startChild('server start').end({outcome: 'succeeded'})
  execution.end({outcome: 'succeeded', reason: 'completed'})
  tracer.startSpan('cleanup').end({outcome: 'succeeded'})
  tracer.root.end({outcome: 'succeeded', reason: 'completed'})
  await tracer.flush()
  return exported(target)
}

describe('the root span’s Langfuse summary', () => {
  it('uses the keys Langfuse reads', () => {
    // #then
    expect(Object.values(SUMMARY_ATTRIBUTE)).toEqual([...KEYS])
  })

  describe('a normal run', () => {
    it('puts the four keys on the root and on no other span', async () => {
      // #given / #when
      const spans = await normalRun()

      // #then
      for (const key of KEYS) expect(attr(named(spans, 'action.main'), key)).toBeTypeOf('string')
      for (const span of spans.filter(item => item.name !== 'action.main'))
        for (const key of KEYS) expect(attr(span, key)).toBeUndefined()
    })

    it('records what the run is as the input, with the fields merged across calls', async () => {
      // #given / #when
      const root = named(await normalRun(), 'action.main')

      // #then
      expect(json(root, 'langfuse.observation.input')).toEqual({
        trigger: 'issue_comment',
        event: 'issue_comment.created',
        repository: 'fro-bot/agent',
        ref: 'main',
        isolateAgent: false,
      })
    })

    it('records how the run ended as the output, with the direct children of the root as the phases', async () => {
      // #given / #when
      const root = named(await normalRun(), 'action.main')

      // #then the grandchild `server start` is not a phase; each phase is a name, an outcome and its milliseconds
      const output = json(root, 'langfuse.observation.output')
      expect(output).toEqual({
        outcome: 'succeeded',
        reason: 'completed',
        durationMs: anyNumber,
        phases: [
          {name: 'bootstrap', outcome: 'succeeded', ms: anyNumber},
          {name: 'execution', outcome: 'succeeded', ms: anyNumber},
          {name: 'cleanup', outcome: 'succeeded', ms: anyNumber},
        ],
      })
      expect(output.durationMs as number).toBeGreaterThan(0)
    })

    it('has the default level and the reason as the status message', async () => {
      // #given / #when
      const root = named(await normalRun(), 'action.main')

      // #then
      expect(attr(root, 'langfuse.observation.level')).toBe('DEFAULT')
      expect(attr(root, 'langfuse.observation.status_message')).toBe('completed')
    })
  })

  describe('how the run ended', () => {
    it.each([
      ['failed', 'exception', 'ERROR'],
      ['skipped', 'no_mention', 'WARNING'],
      ['incomplete', 'proxy-exited', 'WARNING'],
      ['succeeded', 'completed', 'DEFAULT'],
    ] as const)('puts the four keys on the root alone, and level %s → %s', async (outcome, reason, level) => {
      // #given
      const {target, tracer} = await setup()
      tracer.startSpan('routing').end({outcome: outcome === 'skipped' ? 'skipped' : 'succeeded'})
      tracer.root.end({outcome, reason})

      // #when
      await tracer.flush()

      // #then
      const spans = exported(target)
      const root = named(spans, 'action.main')
      expect(attr(root, 'langfuse.observation.level')).toBe(level)
      expect(attr(root, 'langfuse.observation.status_message')).toBe(reason)
      expect(json(root, 'langfuse.observation.output')).toMatchObject({outcome, reason})
      for (const key of KEYS) expect(attr(root, key)).toBeTypeOf('string')
      for (const span of spans.filter(item => item.name !== 'action.main'))
        for (const key of KEYS) expect(attr(span, key)).toBeUndefined()
    })

    it('says cancelled, at the warning level, with the signal and the phase that was open', async () => {
      // #given a finished phase and one that a signal interrupts
      const {target, tracer} = await setup()
      tracer.setRunInput({isolateAgent: true})
      tracer.startSpan('bootstrap').end({outcome: 'succeeded'})
      const execution = tracer.startSpan('execution')
      execution.startChild('install')

      // #when
      tracer.cancel('sigterm')
      await tracer.flush()

      // #then
      const spans = exported(target)
      const root = named(spans, 'action.main')
      expect(attr(root, 'langfuse.observation.level')).toBe('WARNING')
      expect(attr(root, 'langfuse.observation.status_message')).toBe('sigterm')
      expect(json(root, 'langfuse.observation.output')).toEqual({
        outcome: 'cancelled',
        reason: 'sigterm',
        durationMs: anyNumber,
        phases: [
          {name: 'bootstrap', outcome: 'succeeded', ms: anyNumber},
          {name: 'execution', outcome: 'cancelled', ms: anyNumber},
        ],
      })
      expect(json(root, 'langfuse.observation.input')).toMatchObject({isolateAgent: true})
      for (const span of spans.filter(item => item.name !== 'action.main'))
        for (const key of KEYS) expect(attr(span, key)).toBeUndefined()
    })

    it('leaves the status message out when the run gave no reason, and names a phase that never ended', async () => {
      // #given a root that ends with an outcome only, and a phase left open
      const {target, tracer} = await setup()
      tracer.startSpan('execution')
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then
      const root = named(exported(target), 'action.main')
      expect(attr(root, 'langfuse.observation.status_message')).toBeUndefined()
      const output = json(root, 'langfuse.observation.output')
      expect(output).not.toHaveProperty('reason')
      expect(output.phases).toEqual([{name: 'execution', outcome: 'unfinished', ms: anyNumber}])
    })
  })

  describe('the input', () => {
    it('is left out when nothing about the run is known', async () => {
      // #given no identity and no input
      const {target, tracer} = await setup({identity: {}})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then
      expect(attr(named(exported(target), 'action.main'), 'langfuse.observation.input')).toBeUndefined()
    })

    it('leaves out a field the run does not know', async () => {
      // #given only the event is known besides the identity
      const {target, tracer} = await setup({identity: {trigger: 'workflow_dispatch'}})
      tracer.setRunInput({event: 'workflow_dispatch'})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then
      expect(json(named(exported(target), 'action.main'), 'langfuse.observation.input')).toEqual({
        trigger: 'workflow_dispatch',
        event: 'workflow_dispatch',
      })
    })

    it('stays under the cap with the longest ref and repository it can hold, each as bad as JSON makes it', async () => {
      // #given control characters, which JSON writes as six characters each
      const hostile = '\u0001'.repeat(300)
      const {target, tracer} = await setup({identity: {repository: '\u0001'.repeat(256), trigger: 'issue_comment'}})
      tracer.setRunInput({ref: hostile, event: 'issue_comment.created', isolateAgent: true})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then
      const text = attr(named(exported(target), 'action.main'), 'langfuse.observation.input') ?? ''
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(SUMMARY_MAX_BYTES)
      expect(() => {
        JSON.parse(text) as unknown
      }).not.toThrow()
    })

    it('is not recorded by a tracer that continues another’s trace: the post step has no root', async () => {
      // #given the post step's tracer, and a span of its own
      const {target, tracer} = await setup({
        continueFrom: {traceId: 'a'.repeat(32), rootSpanId: 'b'.repeat(16), invocationId: 'c'.repeat(16)},
      })
      tracer.setRunInput({ref: 'main', isolateAgent: false})
      tracer.startSpan('post').end({outcome: 'succeeded', reason: 'saved'})

      // #when
      await tracer.flush()

      // #then
      const spans = exported(target)
      expect(spans.map(span => span.name)).toEqual(['post'])
      for (const key of KEYS) expect(attr(named(spans, 'post'), key)).toBeUndefined()
    })
  })

  describe('scrubbing', () => {
    it('keeps a canary in the ref out of the payload, raw and JSON-escaped, and still sends the summary', async () => {
      // #given a registered secret that the ref carries, and the reason of the run carries too
      const {target, tracer, registry} = await setup()
      registry.mask(CANARY)
      tracer.setRunInput({ref: `feature/${CANARY}`})
      tracer.root.end({outcome: 'failed', reason: `broke on ${CANARY}`})

      // #when
      await tracer.flush()

      // #then
      const text = target.requests.map(request => request.text).join('\n')
      expect(text).not.toContain(CANARY)
      expect(text).not.toContain(escaped(CANARY))
      expect(text).not.toContain('ZZ-98765')
      const root = named(exported(target), 'action.main')
      const input = json(root, 'langfuse.observation.input')
      expect(input.ref).toEqual(containing('feature/'))
      expect(input.ref).not.toContain('ZZ-98765')
      expect(attr(root, 'langfuse.observation.status_message')).not.toContain('ZZ-98765')
    })

    it('scrubs a secret that JSON writes differently from the registered text', async () => {
      // #given a secret with a quote and a backslash in it: in the JSON it is `pa\"ss\\word...`, not the registered text
      const secret = String.raw`pa"ss\word-ZZ-98765-xyz`
      const {target, tracer, registry} = await setup()
      registry.mask(secret)
      tracer.setRunInput({ref: `feature/${secret}`})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then
      const text = target.requests.map(request => request.text).join('\n')
      expect(text).not.toContain('ZZ-98765')
      expect(text).not.toContain(escaped(secret))
      expect(json(named(exported(target), 'action.main'), 'langfuse.observation.input').ref).toEqual(
        containing('feature/'),
      )
    })

    it('cuts a long ref to the free-text cap, after the scrub', async () => {
      // #given
      const {target, tracer} = await setup()
      tracer.setRunInput({ref: `release/${'x'.repeat(400)}`})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then
      const {ref} = json(named(exported(target), 'action.main'), 'langfuse.observation.input') as {ref: string}
      expect(ref.startsWith('release/xxx')).toBe(true)
      expect(ref.length).toBeLessThan(FREE_TEXT_MAX_CHARS + 32)
      expect(ref).toContain('[truncated]')
    })

    it('scrubs before it cuts, so a secret on the cut line leaves no front half behind', async () => {
      // #given a ref whose canary starts 16 characters before the cap
      const {target, tracer, registry} = await setup()
      registry.mask(CANARY)
      tracer.setRunInput({ref: `${'a'.repeat(FREE_TEXT_MAX_CHARS - 16)}${CANARY}`})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then not even the part a cut would have kept
      const text = target.requests.map(request => request.text).join('\n')
      expect(text).not.toContain(CANARY.slice(0, 12))
    })

    it('scrubs a secret registered after the run recorded its input', async () => {
      // #given
      const {target, tracer, registry} = await setup()
      tracer.setRunInput({ref: `feature/${CANARY}`})
      tracer.root.end({outcome: 'succeeded'})

      // #when the secret becomes known before the export
      registry.mask(CANARY)
      await tracer.flush()

      // #then
      expect(target.requests.map(request => request.text).join('\n')).not.toContain('ZZ-98765')
    })

    it('drops the free-text fields, and only those, when a registered secret is one the scrubber cannot match', async () => {
      // #given a 7-character credential: outside the scrubber's range, so no free text can be trusted to it
      const {target, tracer, registry} = await setup()
      registry.add('Zq9x4t7')
      tracer.setRunInput({ref: 'Zq9x4t7-branch', event: 'issue_comment.created', isolateAgent: true})
      tracer.startSpan('bootstrap').end({outcome: 'succeeded'})
      tracer.root.end({outcome: 'failed', reason: 'exception'})

      // #when
      await tracer.flush()

      // #then ref and repository are gone; the categories stay
      const root = named(exported(target), 'action.main')
      expect(json(root, 'langfuse.observation.input')).toEqual({
        trigger: 'issue_comment',
        event: 'issue_comment.created',
        isolateAgent: true,
      })
      expect(json(root, 'langfuse.observation.output')).toEqual({
        outcome: 'failed',
        reason: 'exception',
        durationMs: anyNumber,
        phases: [{name: 'bootstrap', outcome: 'succeeded', ms: anyNumber}],
      })
      expect(attr(root, 'langfuse.observation.status_message')).toBe('exception')
      expect(attr(root, 'langfuse.observation.level')).toBe('ERROR')
      expect(target.requests.map(request => request.text).join('\n')).not.toContain('Zq9x4t7')
    })
  })

  describe('the cap', () => {
    it('cuts the phases at a whole entry and counts what it cut, for a run with many phases', async () => {
      // #given 300 phases
      const {target, tracer} = await setup()
      for (let index = 0; index < 300; index += 1) tracer.startSpan(`phase-${index}`).end({outcome: 'succeeded'})
      tracer.root.end({outcome: 'succeeded', reason: 'completed'})

      // #when
      await tracer.flush()

      // #then
      const text = attr(named(exported(target), 'action.main'), 'langfuse.observation.output') ?? ''
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(SUMMARY_MAX_BYTES)
      const output = JSON.parse(text) as {
        outcome: string
        phases: {name: string; outcome: string; ms: number}[]
        truncatedPhases: number
      }
      expect(output.outcome).toBe('succeeded')
      expect(output.phases.length).toBeGreaterThan(20)
      expect(output.phases.length).toBeLessThan(300)
      expect(output.truncatedPhases).toBe(300 - output.phases.length)
      // the first ones, whole and in order
      output.phases.forEach((entry, index) => {
        expect(entry).toEqual({name: `phase-${index}`, outcome: 'succeeded', ms: anyNumber})
      })
    })

    it('adds no count when everything fits', async () => {
      // #given
      const {target, tracer} = await setup()
      tracer.startSpan('bootstrap').end({outcome: 'succeeded'})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then
      expect(json(named(exported(target), 'action.main'), 'langfuse.observation.output')).not.toHaveProperty(
        'truncatedPhases',
      )
    })
  })
})

describe('the no-op tracer', () => {
  it('accepts the run input and does nothing', () => {
    // #given
    const tracer = createLifecycleTracer({
      inputs: {enabled: false},
      logger: createMockLogger(),
      registry: createSecretRegistry(() => undefined),
    })

    // #when / #then
    expect(() => tracer.setRunInput({ref: 'main', isolateAgent: true})).not.toThrow()
  })
})
