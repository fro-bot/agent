import type {OtlpSink, SinkRequest} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import type {CreateLifecycleTracerOptions, LifecycleTracer} from './lifecycle-tracer.js'
import {Buffer} from 'node:buffer'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {startOtlpSink} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import {
  createLifecycleTracer,
  FREE_TEXT_MAX_CHARS,
  SUMMARY_ATTRIBUTE,
  SUMMARY_MAX_BYTES,
  SUMMARY_METADATA_PREFIX,
} from './lifecycle-tracer.js'
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
/** The attribute's string, which the summary's input and output always are: Markdown text, not JSON. */
const markdown = (span: Wire, key: string): string => {
  const value = attr(span, key)
  if (value === undefined) throw new Error(`no ${key} on ${span.name}`)
  return value
}
const INPUT = 'langfuse.observation.input'
const OUTPUT = 'langfuse.observation.output'
const METADATA = 'langfuse.observation.metadata.'
/** Every `langfuse.observation.metadata.<key>` of a span, with the value in the type it was sent as. */
const metadataOf = (span: Wire): Record<string, unknown> =>
  Object.fromEntries(
    span.attributes
      .filter(item => item.key.startsWith(METADATA))
      .map(item => {
        const {stringValue, intValue, boolValue, doubleValue} = item.value
        return [
          item.key.slice(METADATA.length),
          stringValue ?? (intValue === undefined ? (boolValue ?? doubleValue) : Number(intValue)),
        ]
      }),
  )
const metadataKeys = (span: Wire): string[] =>
  span.attributes.filter(item => item.key.startsWith(METADATA)).map(item => item.key)
/** The output's first line, and its table as lines (the header, the divider, then a row for each phase). */
const firstLine = (output: string): string => output.split('\n')[0] ?? ''
const tableOf = (output: string): string[] => output.split('\n\n')[1]?.split('\n') ?? []

const KEYS = [
  'langfuse.observation.input',
  'langfuse.observation.output',
  'langfuse.observation.level',
  'langfuse.observation.status_message',
] as const

const CANARY = 'ZZ-98765-canary-token'

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

const T0 = 1_700_000_000_000

/** A tracer on a clock the test moves by hand, so that every duration in the summary is known. */
async function setupTimed(
  overrides: Partial<CreateLifecycleTracerOptions> = {},
): Promise<Awaited<ReturnType<typeof setup>> & {readonly at: (ms: number) => void}> {
  let now = T0
  const started = await setup({now: () => now, ...overrides})
  return {...started, at: ms => (now = T0 + ms)}
}

/** Phases that run one after another, each for the given milliseconds, under a root that ends when the last one does. */
async function runWithPhases(
  durations: readonly number[],
  overrides: Partial<CreateLifecycleTracerOptions> = {},
): Promise<Wire> {
  const {target, tracer, at} = await setupTimed(overrides)
  let elapsed = 0
  for (const [index, duration] of durations.entries()) {
    at(elapsed)
    const phase = tracer.startSpan(`phase-${index}`)
    elapsed += duration
    at(elapsed)
    phase.end({outcome: 'succeeded'})
  }
  tracer.root.end({outcome: 'succeeded'})
  await tracer.flush()
  return named(exported(target), 'action.main')
}

describe('the root span’s Langfuse summary', () => {
  it('uses the keys Langfuse reads', () => {
    // #then
    expect(Object.values(SUMMARY_ATTRIBUTE)).toEqual([...KEYS])
    expect(SUMMARY_METADATA_PREFIX).toBe('langfuse.observation.metadata')
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

    it('says what the run is as one line of Markdown, with the fields merged across calls', async () => {
      // #given / #when
      const root = named(await normalRun(), 'action.main')

      // #then the event, the repository and the ref in code spans, then the isolation
      expect(markdown(root, INPUT)).toBe('`issue_comment.created` on `fro-bot/agent` @ `main`, not isolated')
    })

    it('pins the whole Markdown of one run: the line, the table, the order and the time of every phase', async () => {
      // #given a run on a clock that the test sets: bootstrap 420 ms, execution 12.34 s with a child, cleanup 1.2 s, 108 s in all
      const {target, tracer, at} = await setupTimed()
      tracer.setRunInput({isolateAgent: false, ref: 'main', event: 'issue_comment.created'})
      at(100)
      const bootstrap = tracer.startSpan('bootstrap')
      at(520)
      bootstrap.end({outcome: 'succeeded'})
      const execution = tracer.startSpan('execution')
      at(600)
      const child = execution.startChild('server start')
      at(900)
      child.end({outcome: 'succeeded'})
      at(12_860)
      execution.end({outcome: 'succeeded', reason: 'completed'})
      const cleanup = tracer.startSpan('cleanup')
      at(14_060)
      cleanup.end({outcome: 'succeeded'})
      at(108_000)
      tracer.root.end({outcome: 'succeeded', reason: 'completed'})

      // #when
      await tracer.flush()

      // #then the grandchild `server start` is not a phase
      const root = named(exported(target), 'action.main')
      expect(markdown(root, INPUT)).toBe('`issue_comment.created` on `fro-bot/agent` @ `main`, not isolated')
      expect(markdown(root, OUTPUT)).toBe(
        [
          '**succeeded** in 1m 48s, 3 phases — completed',
          '',
          '| phase | outcome | time |',
          '| --- | --- | --- |',
          '| bootstrap | succeeded | 420ms |',
          '| execution | succeeded | 12.3s |',
          '| cleanup | succeeded | 1.2s |',
        ].join('\n'),
      )
    })

    it('puts the structured fields in root-only metadata, in the type each has', async () => {
      // #given the same run as the pinned one
      const {target, tracer, at} = await setupTimed()
      tracer.setRunInput({isolateAgent: false, ref: 'main', event: 'issue_comment.created'})
      tracer.startSpan('bootstrap').end({outcome: 'succeeded'})
      tracer.startSpan('routing').end({outcome: 'skipped', reason: 'no_mention'})
      tracer.startSpan('cleanup').end({outcome: 'failed', reason: 'exception'})
      at(108_000)
      tracer.root.end({outcome: 'succeeded', reason: 'completed'})

      // #when
      await tracer.flush()

      // #then
      const spans = exported(target)
      expect(metadataOf(named(spans, 'action.main'))).toEqual({
        trigger: 'issue_comment',
        event: 'issue_comment.created',
        repository: 'fro-bot/agent',
        ref: 'main',
        isolate_agent: false,
        outcome: 'succeeded',
        reason: 'completed',
        duration_ms: 108_000,
        phase_count: 3,
        failed_phases: 2,
      })
      // #and no other span has any, so the identity mirror is the only metadata the phases carry
      for (const span of spans.filter(item => item.name !== 'action.main')) expect(metadataKeys(span)).toEqual([])
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
      expect(firstLine(markdown(root, OUTPUT))).toMatch(
        new RegExp(String.raw`^\*\*${outcome}\*\* in .*, 1 phase — ${reason}$`),
      )
      expect(metadataOf(root)).toMatchObject({outcome, reason})
      for (const key of KEYS) expect(attr(root, key)).toBeTypeOf('string')
      for (const span of spans.filter(item => item.name !== 'action.main'))
        for (const key of KEYS) expect(attr(span, key)).toBeUndefined()
    })

    it('says skipped at the warning level, with the phase that skipped it in the table', async () => {
      // #given
      const {target, tracer, at} = await setupTimed()
      tracer.setRunInput({event: 'issue_comment.created'})
      at(300)
      tracer.startSpan('routing').end({outcome: 'skipped', reason: 'no_mention'})
      tracer.root.end({outcome: 'skipped', reason: 'no_mention'})

      // #when
      await tracer.flush()

      // #then
      const root = named(exported(target), 'action.main')
      expect(markdown(root, OUTPUT)).toBe(
        [
          '**skipped** in 300ms, 1 phase — no_mention',
          '',
          '| phase | outcome | time |',
          '| --- | --- | --- |',
          '| routing | skipped | 0ms |',
        ].join('\n'),
      )
      expect(attr(root, 'langfuse.observation.level')).toBe('WARNING')
      expect(metadataOf(root)).toMatchObject({
        outcome: 'skipped',
        reason: 'no_mention',
        phase_count: 1,
        failed_phases: 1,
      })
    })

    it('says failed at the error level, and counts the phases that did not succeed', async () => {
      // #given a failed phase and the two that always follow
      const {target, tracer} = await setup()
      tracer.startSpan('bootstrap').end({outcome: 'failed', reason: 'exception'})
      tracer.startSpan('cleanup').end({outcome: 'succeeded'})
      tracer.startSpan('report').end({outcome: 'succeeded'})
      tracer.root.end({outcome: 'failed', reason: 'exception'})

      // #when
      await tracer.flush()

      // #then
      const root = named(exported(target), 'action.main')
      expect(tableOf(markdown(root, OUTPUT)).map(row => row.split(' | ')[0])).toEqual([
        '| phase',
        '| ---',
        '| bootstrap',
        '| cleanup',
        '| report',
      ])
      expect(markdown(root, OUTPUT)).toContain('| bootstrap | failed | ')
      expect(attr(root, 'langfuse.observation.level')).toBe('ERROR')
      expect(metadataOf(root)).toMatchObject({outcome: 'failed', phase_count: 3, failed_phases: 1})
    })

    it('says cancelled, at the warning level, with the signal and the phase that was open', async () => {
      // #given a finished phase and one that a signal interrupts, 2 s into the run
      const {target, tracer, at} = await setupTimed()
      tracer.setRunInput({isolateAgent: true, event: 'pull_request.opened', ref: '2091/merge'})
      at(100)
      const bootstrap = tracer.startSpan('bootstrap')
      at(600)
      bootstrap.end({outcome: 'succeeded'})
      const execution = tracer.startSpan('execution')
      execution.startChild('install')

      // #when
      at(2_000)
      tracer.cancel('sigterm')
      await tracer.flush()

      // #then
      const root = named(exported(target), 'action.main')
      expect(attr(root, 'langfuse.observation.level')).toBe('WARNING')
      expect(attr(root, 'langfuse.observation.status_message')).toBe('sigterm')
      expect(markdown(root, INPUT)).toBe('`pull_request.opened` on `fro-bot/agent` @ `2091/merge`, isolated')
      expect(markdown(root, OUTPUT)).toBe(
        [
          '**cancelled** in 2.0s, 2 phases — sigterm',
          '',
          '| phase | outcome | time |',
          '| --- | --- | --- |',
          '| bootstrap | succeeded | 500ms |',
          '| execution | cancelled | 1.4s |',
        ].join('\n'),
      )
      expect(metadataOf(root)).toMatchObject({
        outcome: 'cancelled',
        reason: 'sigterm',
        isolate_agent: true,
        duration_ms: 2_000,
        phase_count: 2,
        failed_phases: 1,
      })
    })

    it('leaves the reason out when the run gave none, and names a phase that never ended', async () => {
      // #given a root that ends with an outcome only, and a phase left open
      const {target, tracer} = await setup()
      tracer.startSpan('execution')
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then no dash, no status message, no reason in the metadata
      const root = named(exported(target), 'action.main')
      expect(attr(root, 'langfuse.observation.status_message')).toBeUndefined()
      expect(firstLine(markdown(root, OUTPUT))).toMatch(/^\*\*succeeded\*\* in \S+, 1 phase$/)
      expect(tableOf(markdown(root, OUTPUT))[2]).toMatch(/^\| execution \| unfinished \| \S+ \|$/)
      expect(metadataOf(root)).not.toHaveProperty('reason')
      expect(metadataOf(root)).toMatchObject({failed_phases: 1})
    })

    it('has no table for a run with no phases, and says 0 phases', async () => {
      // #given
      const {target, tracer} = await setup()
      tracer.root.end({outcome: 'succeeded', reason: 'completed'})

      // #when
      await tracer.flush()

      // #then
      const root = named(exported(target), 'action.main')
      expect(markdown(root, OUTPUT)).toMatch(/^\*\*succeeded\*\* in \S+, 0 phases — completed$/)
      expect(metadataOf(root)).toMatchObject({phase_count: 0, failed_phases: 0})
    })
  })

  describe('durations', () => {
    it('reads milliseconds under a second, then seconds with a tenth, then minutes and seconds', async () => {
      // #given phases of every size that matters, and a root of the same length as the sum
      const durations = [0, 999, 1_000, 12_340, 59_949, 59_950, 60_000, 108_000, 3_600_000]

      // #when
      const root = await runWithPhases(durations)

      // #then the 59.95 s phase would round to `60.0s`, so it is a minute
      expect(tableOf(markdown(root, OUTPUT)).slice(2)).toEqual([
        '| phase-0 | succeeded | 0ms |',
        '| phase-1 | succeeded | 999ms |',
        '| phase-2 | succeeded | 1.0s |',
        '| phase-3 | succeeded | 12.3s |',
        '| phase-4 | succeeded | 59.9s |',
        '| phase-5 | succeeded | 1m 0s |',
        '| phase-6 | succeeded | 1m 0s |',
        '| phase-7 | succeeded | 1m 48s |',
        '| phase-8 | succeeded | 60m 0s |',
      ])
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
      expect(attr(named(exported(target), 'action.main'), INPUT)).toBeUndefined()
    })

    it.each([
      [
        'the event, with no repository or ref',
        {trigger: 'workflow_dispatch'},
        {event: 'workflow_dispatch'},
        '`workflow_dispatch`',
      ],
      ['the trigger when the event is not known', {trigger: 'schedule'}, {ref: 'main'}, '`schedule` @ `main`'],
      ['the isolation alone', {}, {isolateAgent: true}, 'isolated'],
      ['the repository alone', {repository: 'fro-bot/agent'}, {}, 'on `fro-bot/agent`'],
      [
        'a pull request',
        {repository: 'marcusrbrown/infra', trigger: 'pull_request'},
        {event: 'pull_request.opened', ref: '2091/merge', isolateAgent: true},
        '`pull_request.opened` on `marcusrbrown/infra` @ `2091/merge`, isolated',
      ],
    ] as const)('says %s, and drops the parts it does not know', async (_name, identity, input, expected) => {
      // #given
      const {target, tracer} = await setup({identity})
      tracer.setRunInput(input)
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then
      expect(markdown(named(exported(target), 'action.main'), INPUT)).toBe(expected)
    })

    it('stays under the cap with the longest ref and repository it can hold, in the widest characters', async () => {
      // #given three-byte characters in every free field
      const wide = '段'.repeat(300)
      const {target, tracer} = await setup({identity: {repository: '段'.repeat(256), trigger: 'issue_comment'}})
      tracer.setRunInput({ref: wide, event: '段'.repeat(256), isolateAgent: true})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then
      const input = markdown(named(exported(target), 'action.main'), INPUT)
      expect(Buffer.byteLength(input, 'utf8')).toBeLessThanOrEqual(SUMMARY_MAX_BYTES)
      expect(input).toContain('…[truncated]')
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
      expect(metadataKeys(named(spans, 'post'))).toEqual([])
    })
  })

  describe('text that came from outside', () => {
    // A git ref can hold `|` and a backtick, and a phase name or a reason is whatever its caller wrote.
    const HOSTILE_REF = 'feat/a|b`c\nd'
    const HOSTILE_PHASE = 'ph|`x\ny\\z'
    const HOSTILE_REASON = 'why|`\nnot'

    async function hostileRun(): Promise<Wire> {
      const {target, tracer, at} = await setupTimed()
      tracer.setRunInput({ref: HOSTILE_REF, event: 'issue_comment.created', isolateAgent: true})
      const phase = tracer.startSpan(HOSTILE_PHASE)
      at(100)
      phase.end({outcome: 'failed', reason: 'exception'})
      at(2_000)
      tracer.root.end({outcome: 'failed', reason: HOSTILE_REASON})
      await tracer.flush()
      return named(exported(target), 'action.main')
    }

    it('cannot break out of the code spans of the input, or onto a second line', async () => {
      // #given / #when
      const input = markdown(await hostileRun(), INPUT)

      // #then a backtick or a line break in a ref would end the span or the line: the ref's become an apostrophe and a space
      expect(input).toBe("`issue_comment.created` on `fro-bot/agent` @ `feat/a|b'c d`, isolated")
      expect(input).not.toContain('\n')
      expect(input.split('`')).toHaveLength(7)
    })

    it('cannot add a cell, a row or a line to the output, or end the code of a cell early', async () => {
      // #given / #when
      const output = markdown(await hostileRun(), OUTPUT)

      // #then the pipe and the backtick are escaped, the backslash is doubled so it cannot escape the escape, and a line break is a space
      expect(output).toBe(
        [
          '**failed** in 2.0s, 1 phase — why\\|\\` not',
          '',
          '| phase | outcome | time |',
          '| --- | --- | --- |',
          '| ph\\|\\`x y\\\\z | failed | 100ms |',
        ].join('\n'),
      )
      expect(output.split('\n')).toHaveLength(5)
    })

    it('keeps the value as it is in the metadata, where nothing is rendered', async () => {
      // #given / #when
      const metadata = metadataOf(await hostileRun())

      // #then scrubbed, not escaped
      expect(metadata).toMatchObject({ref: HOSTILE_REF, reason: HOSTILE_REASON, outcome: 'failed'})
    })
  })

  describe('scrubbing', () => {
    it('keeps a canary in the ref out of the payload, and still sends the summary', async () => {
      // #given a registered secret that the ref carries, and the reason of the run carries too
      const {target, tracer, registry} = await setup()
      registry.mask(CANARY)
      tracer.setRunInput({ref: `feature/${CANARY}`})
      tracer.root.end({outcome: 'failed', reason: `broke on ${CANARY}`})

      // #when
      await tracer.flush()

      // #then
      const payload = target.requests.map(request => request.text).join('\n')
      expect(payload).not.toContain(CANARY)
      expect(payload).not.toContain('ZZ-98765')
      const root = named(exported(target), 'action.main')
      expect(markdown(root, INPUT)).toEqual(containing('@ `feature/'))
      expect(attr(root, 'langfuse.observation.status_message')).not.toContain('ZZ-98765')
      // #and the output still arrives, with the reason redacted inside it, and so do the metadata
      expect(firstLine(markdown(root, OUTPUT))).toMatch(/^\*\*failed\*\* in \S+, 0 phases — broke on /)
      expect(metadataOf(root).reason).toEqual(containing('broke on'))
      expect(metadataOf(root).ref).toEqual(containing('feature/'))
    })

    it('scrubs a secret that the Markdown would write differently from the registered text', async () => {
      // #given a secret with a pipe, a backtick and a line break in it: escaped, it is not the registered text
      const secret = 'pa|ss`word\n-ZZ-98765-xyz'
      const {target, tracer, registry} = await setup()
      registry.mask(secret)
      tracer.setRunInput({ref: `feature/${secret}`})
      tracer.startSpan(`phase ${secret}`).end({outcome: 'succeeded'})
      tracer.root.end({outcome: 'failed', reason: `broke ${secret}`})

      // #when
      await tracer.flush()

      // #then it is scrubbed before it is escaped, so no part of it is left in the payload, and the summary arrived
      const payload = target.requests.map(request => request.text).join('\n')
      expect(payload).not.toContain('ZZ-98765')
      expect(payload).not.toContain('pa|ss')
      const root = named(exported(target), 'action.main')
      expect(markdown(root, INPUT)).toEqual(containing('@ `feature/'))
      expect(markdown(root, OUTPUT)).toEqual(containing('| phase '))
    })

    it('cuts a long ref to the free-text cap, after the scrub', async () => {
      // #given
      const {target, tracer} = await setup()
      tracer.setRunInput({ref: `release/${'x'.repeat(400)}`})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then
      const input = markdown(named(exported(target), 'action.main'), INPUT)
      expect(input).toEqual(containing('@ `release/xxx'))
      expect(input.length).toBeLessThan(FREE_TEXT_MAX_CHARS + 64)
      expect(input).toContain('…[truncated]')
    })

    it('scrubs before it cuts, so a secret on the cut line leaves no front half behind', async () => {
      // #given a ref whose canary starts 16 characters before the cap
      const {target, tracer, registry} = await setup()
      registry.mask(CANARY)
      tracer.setRunInput({ref: `${'a'.repeat(FREE_TEXT_MAX_CHARS - 16)}${CANARY}`})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then not even the part a cut would have kept, and the summary did arrive with the safe part of the ref
      const payload = target.requests.map(request => request.text).join('\n')
      expect(payload).not.toContain(CANARY.slice(0, 12))
      expect(markdown(named(exported(target), 'action.main'), INPUT)).toEqual(
        containing(`@ \`${'a'.repeat(FREE_TEXT_MAX_CHARS - 16)}`),
      )
    })

    it('scrubs a secret registered after the run recorded its input', async () => {
      // #given
      const {target, tracer, registry} = await setup()
      tracer.setRunInput({ref: `feature/${CANARY}`})
      tracer.root.end({outcome: 'succeeded'})

      // #when the secret becomes known before the export
      registry.mask(CANARY)
      await tracer.flush()

      // #then the summary arrived, with the part of the ref that was safe
      expect(target.requests.map(request => request.text).join('\n')).not.toContain('ZZ-98765')
      expect(markdown(named(exported(target), 'action.main'), INPUT)).toEqual(containing('@ `feature/'))
    })
  })

  describe('when no free text can be trusted', () => {
    it('drops the repository and the ref, and only those, from the input, the metadata and the Markdown', async () => {
      // #given a 7-character credential: outside the scrubber's range, so no free text can be trusted to it
      const {target, tracer, registry} = await setup()
      registry.add('Zq9x4t7')
      tracer.setRunInput({ref: 'Zq9x4t7-branch', event: 'issue_comment.created', isolateAgent: true})
      tracer.startSpan('bootstrap').end({outcome: 'succeeded'})
      tracer.root.end({outcome: 'failed', reason: 'exception'})

      // #when
      await tracer.flush()

      // #then the event and the isolation stay
      const root = named(exported(target), 'action.main')
      expect(markdown(root, INPUT)).toBe('`issue_comment.created`, isolated')
      expect(metadataKeys(root).toSorted()).toEqual(
        ['trigger', 'event', 'isolate_agent', 'outcome', 'reason', 'duration_ms', 'phase_count', 'failed_phases']
          .map(key => `${METADATA}${key}`)
          .toSorted(),
      )
      expect(firstLine(markdown(root, OUTPUT))).toMatch(/^\*\*failed\*\* in \S+, 1 phase — exception$/)
      expect(tableOf(markdown(root, OUTPUT))[2]).toMatch(/^\| bootstrap \| succeeded \| \S+ \|$/)
      expect(attr(root, 'langfuse.observation.status_message')).toBe('exception')
      expect(attr(root, 'langfuse.observation.level')).toBe('ERROR')
      const payload = target.requests.map(request => request.text).join('\n')
      expect(payload).not.toContain('Zq9x4t7')
      // #and the repository is still in the identity every span carries, which this summary does not decide
      expect(metadataOf(root)).not.toHaveProperty('repository')
      expect(metadataOf(root)).not.toHaveProperty('ref')
    })
  })

  describe('a registered literal that overlaps the Markdown itself', () => {
    // A literal made of the summary's own words and punctuation: the scrubber would take it out of the finished text and leave a broken table.
    it.each([
      ['the input', INPUT, ', not isolated'],
      ['the output', OUTPUT, '| phase | outcome | time |'],
    ] as const)(
      'leaves %s absent, never rewritten, and the literal out of the payload',
      async (_name, key, literal) => {
        // #given
        const {target, tracer, registry} = await setup()
        tracer.setRunInput({ref: 'main', event: 'issue_comment.created', isolateAgent: false})
        tracer.startSpan('bootstrap').end({outcome: 'succeeded'})
        tracer.root.end({outcome: 'failed', reason: 'exception'})
        registry.add(literal)

        // #when
        await tracer.flush()

        // #then the root still arrives, with its level and its message
        const root = named(exported(target), 'action.main')
        expect(attr(root, 'langfuse.observation.level')).toBe('ERROR')
        expect(attr(root, 'langfuse.observation.status_message')).toBe('exception')
        // #and the attribute is omitted, not redacted into something that is no longer what was built
        expect(attr(root, key)).toBeUndefined()
        expect(target.requests.map(request => request.text).join('\n')).not.toContain(literal)
        // #and the metadata is not touched by it
        expect(metadataOf(root)).toMatchObject({outcome: 'failed', phase_count: 1})
      },
    )

    it('keeps every other summary attribute when one is omitted', async () => {
      // #given a literal only the input holds
      const {target, tracer, registry} = await setup()
      tracer.setRunInput({ref: 'main', isolateAgent: false})
      tracer.startSpan('bootstrap').end({outcome: 'succeeded'})
      tracer.root.end({outcome: 'succeeded'})
      registry.add(', not isolated')

      // #when
      await tracer.flush()

      // #then
      const root = named(exported(target), 'action.main')
      expect(attr(root, INPUT)).toBeUndefined()
      expect(firstLine(markdown(root, OUTPUT))).toMatch(/^\*\*succeeded\*\* in /)
    })

    it.each(['unauthorized_author', 'own_posted_comment', 'bot_not_requested', 'sigterm'])(
      'does not mistake an ordinary reason (%s) for something to omit',
      async reason => {
        // #given
        const {target, tracer} = await setup()
        tracer.setRunInput({ref: 'feature/password-manager', event: 'issue_comment.created', isolateAgent: false})
        tracer.root.end({outcome: 'skipped', reason})

        // #when
        await tracer.flush()

        // #then
        const root = named(exported(target), 'action.main')
        expect(firstLine(markdown(root, OUTPUT))).toMatch(new RegExp(String.raw`^\*\*skipped\*\* in .* — ${reason}$`))
        expect(markdown(root, INPUT)).toEqual(containing('`issue_comment.created`'))
      },
    )
  })

  describe('the byte cap', () => {
    const rowsOf = (output: string): string[] => tableOf(output).slice(2)

    it('counts bytes, not characters: multibyte phase names stay within 4,096 bytes and only whole rows are kept', async () => {
      // #given 200 phases whose names are three bytes a character
      const {target, tracer} = await setup()
      for (let index = 0; index < 200; index += 1) tracer.startSpan(`段階-${index}-処理`).end({outcome: 'succeeded'})
      tracer.root.end({outcome: 'succeeded', reason: 'completed'})

      // #when
      await tracer.flush()

      // #then
      const root = named(exported(target), 'action.main')
      const output = markdown(root, OUTPUT)
      expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(SUMMARY_MAX_BYTES)
      // close to the cap, so a count of characters would have kept more than fits
      expect(Buffer.byteLength(output, 'utf8')).toBeGreaterThan(SUMMARY_MAX_BYTES - 80)
      const rows = rowsOf(output)
      const kept = rows.length - 1
      expect(kept).toBeGreaterThan(10)
      expect(kept).toBeLessThan(200)
      rows.slice(0, kept).forEach((row, index) => {
        expect(row).toMatch(new RegExp(String.raw`^\| 段階-${index}-処理 \| succeeded \| \S+ \|$`))
      })
      // #and the last line says how many are not shown, and the first line still counts all of them
      expect(rows.at(-1)).toBe(`| … | ${200 - kept} more | |`)
      expect(firstLine(output)).toContain(', 200 phases')
      expect(metadataOf(root)).toMatchObject({phase_count: 200})
    })

    it('cuts at the last row that fits, not one earlier', async () => {
      // #given
      const {target, tracer} = await setup()
      for (let index = 0; index < 200; index += 1) tracer.startSpan(`段階-${index}-処理`).end({outcome: 'succeeded'})
      tracer.root.end({outcome: 'succeeded', reason: 'completed'})

      // #when
      await tracer.flush()

      // #then adding the next row, and the shorter count that goes with it, would be over the cap
      const output = markdown(named(exported(target), 'action.main'), OUTPUT)
      const rows = rowsOf(output)
      const kept = rows.length - 1
      const next = `| 段階-${kept}-処理 | succeeded | 10ms |`
      const more = `| … | ${200 - kept - 1} more | |`
      const without = output.slice(0, output.lastIndexOf('\n'))
      expect(Buffer.byteLength(`${without}\n${next}\n${more}`, 'utf8')).toBeGreaterThan(SUMMARY_MAX_BYTES)
    })

    it('measures the rows after they are escaped, so a name full of pipes and wide characters cannot push it over', async () => {
      // #given 200 phases that each grow when escaped: a pipe and a backtick are two bytes each, the rest three
      const {target, tracer} = await setup()
      for (let index = 0; index < 200; index += 1) tracer.startSpan(`段|\`階-${index}`).end({outcome: 'succeeded'})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then
      const output = markdown(named(exported(target), 'action.main'), OUTPUT)
      expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(SUMMARY_MAX_BYTES)
      const rows = rowsOf(output)
      const kept = rows.length - 1
      expect(kept).toBeGreaterThan(10)
      rows.slice(0, kept).forEach((row, index) => {
        expect(row).toMatch(new RegExp(`^\\| 段\\\\\\|\\\\\`階-${index} \\| succeeded \\| \\S+ \\|$`))
      })
      expect(rows.at(-1)).toBe(`| … | ${200 - kept} more | |`)
    })

    it('measures the names after they are scrubbed, so a replacement longer than the secret cannot push it over', async () => {
      // #given 200 phases that each carry a registered 8-character secret, which the scrubber replaces with something longer
      const secret = 'Zq9x4t7k'
      const {target, tracer, registry} = await setup()
      registry.add(secret)
      for (let index = 0; index < 200; index += 1) tracer.startSpan(`p${index}-${secret}`).end({outcome: 'succeeded'})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then
      const output = markdown(named(exported(target), 'action.main'), OUTPUT)
      expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(SUMMARY_MAX_BYTES)
      expect(output).not.toContain(secret)
      const rows = rowsOf(output)
      expect(rows.length).toBeGreaterThan(10)
      for (const row of rows.slice(0, -1)) expect(row).toMatch(/^\| p\d+-/)
      expect(rows.at(-1)).toMatch(/^\| … \| \d+ more \| \|$/)
    })

    it('cuts the phases at a whole row and counts what it cut, for a run with many phases', async () => {
      // #given 300 phases
      const {target, tracer} = await setup()
      for (let index = 0; index < 300; index += 1) tracer.startSpan(`phase-${index}`).end({outcome: 'succeeded'})
      tracer.root.end({outcome: 'succeeded', reason: 'completed'})

      // #when
      await tracer.flush()

      // #then
      const output = markdown(named(exported(target), 'action.main'), OUTPUT)
      expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(SUMMARY_MAX_BYTES)
      expect(firstLine(output)).toMatch(/^\*\*succeeded\*\* in \S+, 300 phases — completed$/)
      const rows = rowsOf(output)
      const kept = rows.length - 1
      expect(kept).toBeGreaterThan(20)
      expect(kept).toBeLessThan(300)
      expect(rows.at(-1)).toBe(`| … | ${300 - kept} more | |`)
      // the first ones, whole and in order
      rows.slice(0, kept).forEach((row, index) => {
        expect(row).toMatch(new RegExp(String.raw`^\| phase-${index} \| succeeded \| \S+ \|$`))
      })
    })

    it('adds no row about the rest when everything fits', async () => {
      // #given
      const {target, tracer} = await setup()
      tracer.startSpan('bootstrap').end({outcome: 'succeeded'})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then
      expect(markdown(named(exported(target), 'action.main'), OUTPUT)).not.toContain(' more | |')
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
