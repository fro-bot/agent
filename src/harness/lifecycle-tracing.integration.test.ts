import type {OtlpSink, SinkRequest} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {startOtlpSink} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import {buildTraceSessionId, buildTracingRunLink} from '../services/setup/tracing.js'
import {
  createLifecycleTracer,
  createRegistryScrubber,
  LIFECYCLE_SERVICE_NAME,
  withSpan,
} from '../shared/lifecycle-tracer.js'
import {createSecretRegistry} from '../shared/secret-registry.js'
import {createMockLogger} from '../shared/test-helpers.js'

/**
 * The lifecycle trace as a collector receives it: the real tracer and the real exporter against a real OTLP/HTTP receiver, with
 * a run's worth of nested phases. What this checks is the wire format, which no unit test of the tracer's own state can: the
 * ids as hex of the right width, the parenting by id, the times as nanosecond strings that nest, the one resource, the one
 * request, and the session and invocation id on every span. (The turn traces' links to this trace's root are checked against
 * the real binary in `phases/tracing.integration.test.ts`, where a turn exists.)
 */

interface WireSpan {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly startTimeUnixNano: string
  readonly endTimeUnixNano: string
  readonly attributes: {
    readonly key: string
    readonly value: {readonly stringValue?: string; readonly intValue?: string}
  }[]
  readonly status?: {readonly code?: number}
  readonly links?: readonly unknown[]
}

interface WireResource {
  readonly resource: {readonly attributes: {readonly key: string; readonly value: {readonly stringValue?: string}}[]}
  readonly scopeSpans: {readonly scope: {readonly name: string}; readonly spans: WireSpan[]}[]
}

const resourcesOf = (request: SinkRequest): WireResource[] =>
  (request.body as {resourceSpans: WireResource[]}).resourceSpans
const spansOf = (request: SinkRequest): WireSpan[] =>
  resourcesOf(request).flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
const attr = (span: WireSpan, key: string): string | undefined => {
  const value = span.attributes.find(item => item.key === key)?.value
  return value?.stringValue ?? value?.intValue
}

const sinks: OtlpSink[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(sinks.splice(0).map(async sink => sink.stop()))
})

/** A run: three phases, one with a child, one skipped, one failed with an exception, then the root. */
async function exportRun(): Promise<{
  sink: OtlpSink
  tracer: ReturnType<typeof createLifecycleTracer>
  spans: WireSpan[]
}> {
  const sink = await startOtlpSink()
  sinks.push(sink)
  const registry = createSecretRegistry(() => undefined)
  const tracer = createLifecycleTracer({
    inputs: {enabled: true, url: sink.url, headers: []},
    logger: createMockLogger(),
    registry,
    env: {},
    identity: {repository: 'fro-bot/agent', runId: '77', attempt: '1', job: 'triage', trigger: 'issue_comment'},
  })
  const sessionId = buildTraceSessionId('fro-bot', 'agent', 'issue-42', createRegistryScrubber(registry))
  if (sessionId !== undefined) tracer.setSessionId(sessionId)

  await withSpan(
    tracer.startSpan('bootstrap'),
    async () => undefined,
    () => ({outcome: 'succeeded'}),
  )
  await withSpan(
    tracer.startSpan('routing'),
    async () => undefined,
    () => ({outcome: 'skipped', reason: 'no_mention'}),
  )
  const execution = tracer.startSpan('execution')
  const server = execution.startChild('server start')
  await new Promise(resolve => setTimeout(resolve, 5))
  server.end({outcome: 'succeeded'})
  execution.end({outcome: 'succeeded'})
  await withSpan(tracer.startSpan('cleanup'), async () => {
    throw new Error('cleanup exploded')
  }).catch(() => undefined)
  tracer.root.end({outcome: 'failed', reason: 'exception'})
  await tracer.flush()
  return {sink, tracer, spans: sink.accepted().flatMap(spansOf)}
}

describe('the lifecycle trace at a real OTLP receiver', () => {
  it('sends the whole run as one request, under one resource named for the Action', async () => {
    // #given / #when
    const {sink} = await exportRun()

    // #then
    expect(sink.accepted()).toHaveLength(1)
    const [resource] = resourcesOf(sink.accepted()[0] as SinkRequest)
    expect(resourcesOf(sink.accepted()[0] as SinkRequest)).toHaveLength(1)
    expect(resource?.resource.attributes.find(item => item.key === 'service.name')?.value.stringValue).toBe(
      LIFECYCLE_SERVICE_NAME,
    )
    expect(resource?.scopeSpans).toHaveLength(1)
    expect(resource?.scopeSpans[0]?.spans).toHaveLength(6)
  })

  it('writes ids as lower-case hex of the right width: one 32-character trace id, unique 16-character span ids', async () => {
    // #given / #when
    const {spans, tracer} = await exportRun()

    // #then
    expect(new Set(spans.map(span => span.traceId))).toEqual(new Set([tracer.ids?.traceId]))
    expect(spans[0]?.traceId).toMatch(/^[\da-f]{32}$/)
    for (const span of spans) expect(span.spanId).toMatch(/^[\da-f]{16}$/)
    expect(new Set(spans.map(span => span.spanId)).size).toBe(spans.length)
    expect(spans.find(span => span.name === 'action.main')?.spanId).toBe(tracer.ids?.rootSpanId)
  })

  it('parents every span by id: the root has no parent, phases hang from it, children from their phase', async () => {
    // #given / #when
    const {spans} = await exportRun()
    const byName = (name: string): WireSpan => {
      const found = spans.find(span => span.name === name)
      if (found === undefined) throw new Error(`no span ${name}`)
      return found
    }

    // #then
    const root = byName('action.main')
    expect(root.parentSpanId === undefined || root.parentSpanId === '').toBe(true)
    for (const phase of ['bootstrap', 'routing', 'execution', 'cleanup'])
      expect(byName(phase).parentSpanId).toBe(root.spanId)
    expect(byName('server start').parentSpanId).toBe(byName('execution').spanId)
    // every parent named is a span of the trace
    const ids = new Set(spans.map(span => span.spanId))
    for (const span of spans.filter(item => item.name !== 'action.main'))
      expect(ids.has(span.parentSpanId ?? '')).toBe(true)
  })

  it('writes times as 19-digit nanosecond strings that nest: a span ends no earlier than it starts, inside its parent', async () => {
    // #given / #when
    const {spans} = await exportRun()
    const byId = new Map(spans.map(span => [span.spanId, span]))

    // #then
    for (const span of spans) {
      expect(span.startTimeUnixNano).toMatch(/^\d{19}$/)
      expect(span.endTimeUnixNano).toMatch(/^\d{19}$/)
      const start = BigInt(span.startTimeUnixNano)
      const end = BigInt(span.endTimeUnixNano)
      expect(end >= start).toBe(true)
    }
    // and every child sits inside its parent
    const nested = spans
      .map(span => ({span, parent: byId.get(span.parentSpanId ?? '')}))
      .filter((pair): pair is {span: WireSpan; parent: WireSpan} => pair.parent !== undefined)
    expect(nested.length).toBe(spans.length - 1)
    expect(
      nested.map(({span, parent}) => BigInt(span.startTimeUnixNano) >= BigInt(parent.startTimeUnixNano)),
    ).not.toContain(false)
    expect(
      nested.map(({span, parent}) => BigInt(span.endTimeUnixNano) <= BigInt(parent.endTimeUnixNano)),
    ).not.toContain(false)
    // and the clock is wall time in nanoseconds, not milliseconds or a monotonic counter
    const rootStart = BigInt(spans.find(span => span.name === 'action.main')?.startTimeUnixNano ?? '0')
    expect(Math.abs(Number(rootStart / 1_000_000n) - Date.now())).toBeLessThan(60_000)
  })

  it('puts the one session and the invocation id on every span, and no link on any (the lifecycle trace is the link target)', async () => {
    // #given / #when
    const {spans, tracer} = await exportRun()

    // #then
    for (const span of spans) {
      expect(attr(span, 'langfuse.session.id')).toBe('fro-bot/agent:issue-42')
      expect(attr(span, 'fro_bot.invocation.id')).toBe(tracer.ids?.invocationId)
      expect(span.links ?? []).toEqual([])
    }
  })

  it('marks only the failed span as an error, with the outcome and reason as attributes on every span', async () => {
    // #given / #when
    const {spans} = await exportRun()

    // #then status: unset or ok everywhere but the failed root and cleanup (code 2)
    const errors = spans.filter(span => span.status?.code === 2).map(span => span.name)
    expect(errors.toSorted()).toEqual(['action.main', 'cleanup'])
    expect(attr(spans.find(span => span.name === 'routing') as WireSpan, 'fro_bot.outcome')).toBe('skipped')
    expect(attr(spans.find(span => span.name === 'routing') as WireSpan, 'fro_bot.reason')).toBe('no_mention')
    expect(attr(spans.find(span => span.name === 'bootstrap') as WireSpan, 'fro_bot.outcome')).toBe('succeeded')
  })

  it('exports the link a turn trace would use: the root span ids are those the launcher is given', async () => {
    // #given
    const {tracer} = await exportRun()

    // #when
    const link = buildTracingRunLink(tracer.ids, 'fro-bot/agent:issue-42')

    // #then
    expect(link.rootSpan).toEqual({traceId: tracer.ids?.traceId, spanId: tracer.ids?.rootSpanId})
    expect(link.invocationId).toBe(tracer.ids?.invocationId)
  })
})
