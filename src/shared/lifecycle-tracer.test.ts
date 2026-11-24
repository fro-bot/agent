import type {SpanExporterOptions} from '@fro-bot/runtime/tracing/exporter'
import type {OtlpSink, SinkRequest} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import type {InvocationOutcome} from '../harness/outcome.js'
import type {CreateLifecycleTracerOptions, LifecycleTracer, SpanOutcome} from './lifecycle-tracer.js'
import {Buffer} from 'node:buffer'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import {createSpanExporter} from '@fro-bot/runtime/tracing/exporter'
import {CONTENT_ATTRIBUTE_NAMES} from '@fro-bot/runtime/tracing/scrub'
import {afterEach, describe, expect, expectTypeOf, it, vi} from 'vitest'
import {opensslAvailable, startOtlpSink, startTlsSink} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import {
  createLifecycleTracer,
  FREE_TEXT_MAX_CHARS,
  freeText,
  LIFECYCLE_SERVICE_NAME,
  NODE_DEBUG_WARNING,
  NOOP_SPAN,
  parseTraceIds,
  withSpan,
} from './lifecycle-tracer.js'
import {createSecretRegistry} from './secret-registry.js'
import {createMockLogger, serializeLoggerCalls} from './test-helpers.js'

const FAST = {batchIntervalMs: 15, requestTimeoutMs: 2_500, maxConsecutiveFailures: 3}
const ENDPOINT_PATH = '/v1/traces'

interface Decoded {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly startTimeUnixNano: string
  readonly endTimeUnixNano: string
  readonly attributes: {key: string; value: Record<string, unknown>}[]
  readonly status?: {code?: number; message?: string}
  readonly events?: {name: string; timeUnixNano: string; attributes?: {key: string; value: Record<string, unknown>}[]}[]
}

const spansOf = (request: SinkRequest): Decoded[] =>
  (request.body as {resourceSpans: {scopeSpans: {spans: Decoded[]}[]}[]}).resourceSpans.flatMap(resource =>
    resource.scopeSpans.flatMap(scope => scope.spans),
  )

const allSpans = (target: OtlpSink): Decoded[] => target.accepted().flatMap(spansOf)
const named = (spans: readonly Decoded[], name: string): Decoded => {
  const found = spans.find(span => span.name === name)
  if (found === undefined) throw new Error(`no span named ${name}`)
  return found
}
const attr = (span: Decoded, key: string): unknown => {
  const value = span.attributes.find(item => item.key === key)?.value
  return value === undefined ? undefined : (value.stringValue ?? value.intValue ?? value.boolValue ?? value.arrayValue)
}
const eventsNamed = (span: Decoded, name: string): NonNullable<Decoded['events']> =>
  (span.events ?? []).filter(event => event.name === name)
const eventAttr = (event: NonNullable<Decoded['events']>[number], key: string): unknown =>
  event.attributes?.find(item => item.key === key)?.value.stringValue

const escaped = (value: string): string => JSON.stringify(value).slice(1, -1)

const sinks: OtlpSink[] = []
const sink = async (...args: Parameters<typeof startOtlpSink>): Promise<OtlpSink> => {
  const started = await startOtlpSink(...args)
  sinks.push(started)
  return started
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(sinks.splice(0).map(async started => started.stop()))
})

interface Harness {
  readonly tracer: LifecycleTracer
  readonly logger: ReturnType<typeof createMockLogger>
  readonly registry: ReturnType<typeof createSecretRegistry>
  readonly masker: ReturnType<typeof vi.fn<(value: string) => void>>
  readonly createExporter: ReturnType<
    typeof vi.fn<(options: SpanExporterOptions) => ReturnType<typeof createSpanExporter>>
  >
}

function harness(
  url: string | undefined,
  overrides: Partial<CreateLifecycleTracerOptions> = {},
  headers: readonly {name: string; value: string}[] = [],
): Harness {
  let clock = 1_700_000_000_000
  const logger = createMockLogger()
  const masker = vi.fn<(value: string) => void>()
  const registry = createSecretRegistry(masker)
  const createExporter = vi.fn<(options: SpanExporterOptions) => ReturnType<typeof createSpanExporter>>(options =>
    createSpanExporter(options),
  )
  const tracer = createLifecycleTracer({
    inputs: url === undefined ? {enabled: false} : {enabled: true, url, headers},
    logger,
    registry,
    env: {},
    now: () => {
      clock += 10
      return clock
    },
    exporterLimits: FAST,
    createExporter,
    ...overrides,
  })
  return {tracer, logger, registry, masker, createExporter}
}

function recordEverywhere(tracer: LifecycleTracer, text: string): void {
  const span = tracer.startSpan(`name ${text}`)
  span.setAttribute('fro_bot.note', `attr ${text}`)
  span.setAttribute('fro_bot.ref', freeText(`ref ${text}`, 'ref'))
  span.addEvent('gate.decision', {detail: `event ${text}`, free: freeText(`event free ${text}`, 'gate')})
  span.recordException(new Error(`exception ${text}`))
  span.end({outcome: 'failed', reason: `reason ${text}`})
  tracer.setSessionId(`session ${text}`)
  tracer.root.end({outcome: 'failed', reason: `root ${text}`})
}

function finished(url: string, overrides: Partial<CreateLifecycleTracerOptions> = {}): Harness {
  const made = harness(url, overrides)
  made.tracer.startSpan('bootstrap').end({outcome: 'succeeded'})
  made.tracer.root.end({outcome: 'succeeded'})
  return made
}

describe('createLifecycleTracer', () => {
  describe('shape', () => {
    it('exports nested spans with events as one request, with parenting, hex ids and nanosecond times', async () => {
      // #given
      const target = await sink()
      const {tracer} = harness(target.url)
      const phase = tracer.startSpan('bootstrap')
      const install = tracer.startSpan('install opencode', {parent: phase})
      install.addEvent('path.dropped', {entries: '3'})
      install.end({outcome: 'succeeded'})
      phase.end({outcome: 'succeeded'})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      const result = await tracer.flush()

      // #then one request holds the three spans
      expect(target.accepted()).toHaveLength(1)
      const spans = allSpans(target)
      expect(spans.map(span => span.name).toSorted()).toEqual(['action.main', 'bootstrap', 'install opencode'])
      const root = named(spans, 'action.main')
      const phaseSpan = named(spans, 'bootstrap')
      const child = named(spans, 'install opencode')
      expect(root.traceId).toBe(tracer.ids?.traceId)
      expect(root.spanId).toBe(tracer.ids?.rootSpanId)
      expect(root.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(root.spanId).toMatch(/^[0-9a-f]{16}$/)
      expect(root.parentSpanId === undefined || root.parentSpanId === '').toBe(true)
      expect(phaseSpan.parentSpanId).toBe(root.spanId)
      expect(child.parentSpanId).toBe(phaseSpan.spanId)
      expect(new Set(spans.map(span => span.traceId)).size).toBe(1)
      for (const span of spans) {
        expect(span.startTimeUnixNano).toMatch(/^\d{19}$/)
        expect(span.endTimeUnixNano).toMatch(/^\d{19}$/)
        expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano))
      }
      expect(BigInt(child.startTimeUnixNano)).toBeGreaterThan(BigInt(phaseSpan.startTimeUnixNano))
      expect(eventsNamed(child, 'path.dropped')).toHaveLength(1)
      expect(eventAttr(eventsNamed(child, 'path.dropped')[0] ?? {name: '', timeUnixNano: ''}, 'entries')).toBe('3')
      expect(result).toEqual({spans: 3, undelivered: 0})
    })

    it('sends the Action’s own service name, not the plugin’s', async () => {
      // #given
      const target = await sink()
      const {tracer} = harness(target.url)
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then
      const resource = (
        target.accepted()[0]?.body as {
          resourceSpans: {resource: {attributes: {key: string; value: {stringValue: string}}[]}}[]
        }
      ).resourceSpans[0]?.resource
      expect(resource?.attributes.find(item => item.key === 'service.name')?.value.stringValue).toBe(
        LIFECYCLE_SERVICE_NAME,
      )
      expect(LIFECYCLE_SERVICE_NAME).not.toBe('fro-bot-opencode-plugin')
    })

    it('puts the run identity and the invocation id on every span, under the turn spans’ names', async () => {
      // #given
      const target = await sink()
      const {tracer} = harness(target.url, {identity: {repository: 'fro-bot/agent', runId: '77', attempt: '2'}})
      tracer.startSpan('routing').end()
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then only the fields that exist are sent
      for (const span of allSpans(target)) {
        expect(attr(span, 'fro_bot.repository')).toBe('fro-bot/agent')
        expect(attr(span, 'fro_bot.run.id')).toBe('77')
        expect(attr(span, 'fro_bot.run.attempt')).toBe('2')
        expect(attr(span, 'fro_bot.job')).toBeUndefined()
        expect(attr(span, 'langfuse.trace.metadata.repository')).toBe('fro-bot/agent')
        expect(attr(span, 'fro_bot.invocation.id')).toBe(tracer.ids?.invocationId)
      }
    })

    it('mints a fresh trace id, root span id and invocation id per tracer', () => {
      // #given / #when
      const first = harness('http://127.0.0.1:9/v1/traces').tracer.ids
      const second = harness('http://127.0.0.1:9/v1/traces').tracer.ids

      // #then
      expect(first?.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(first?.rootSpanId).toMatch(/^[0-9a-f]{16}$/)
      expect(first?.invocationId).toMatch(/^[0-9a-f]{16}$/)
      expect(second?.traceId).not.toBe(first?.traceId)
      expect(second?.invocationId).not.toBe(first?.invocationId)
    })

    it('sends no prompt, model output or tool content keys', async () => {
      // #given
      const target = await sink()
      const {tracer} = harness(target.url)
      tracer.startSpan('execution').end({outcome: 'succeeded'})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then
      for (const name of CONTENT_ATTRIBUTE_NAMES) expect(target.requests[0]?.text).not.toContain(name)
      expect(target.requests[0]?.text).not.toContain('gen_ai.')
    })
  })

  describe('outcomes', () => {
    it('marks a failed span with error status and an exception event, a skipped one with outcome only', async () => {
      // #given
      const target = await sink()
      const {tracer} = harness(target.url)
      const failing = tracer.startSpan('cache restore')
      failing.recordException(new TypeError('restore blew up'))
      failing.end({outcome: 'failed', reason: 'restore-error'})
      tracer.startSpan('dedup').end({outcome: 'skipped', reason: 'already-processed'})
      tracer.startSpan('execution').end({outcome: 'cancelled', reason: 'signal'})
      tracer.root.end({outcome: 'succeeded'})

      // #when
      await tracer.flush()

      // #then
      const spans = allSpans(target)
      const failed = named(spans, 'cache restore')
      expect(failed.status?.code).toBe(2)
      expect(attr(failed, 'fro_bot.outcome')).toBe('failed')
      expect(attr(failed, 'fro_bot.reason')).toBe('restore-error')
      const exception = eventsNamed(failed, 'exception')
      expect(exception).toHaveLength(1)
      expect(eventAttr(exception[0] ?? {name: '', timeUnixNano: ''}, 'exception.type')).toBe('TypeError')
      expect(eventAttr(exception[0] ?? {name: '', timeUnixNano: ''}, 'exception.message')).toBe('restore blew up')
      const skipped = named(spans, 'dedup')
      expect(attr(skipped, 'fro_bot.outcome')).toBe('skipped')
      expect(attr(skipped, 'fro_bot.reason')).toBe('already-processed')
      expect(skipped.status?.code ?? 0).toBe(0)
      const cancelled = named(spans, 'execution')
      expect(attr(cancelled, 'fro_bot.outcome')).toBe('cancelled')
      expect(cancelled.status?.code ?? 0).toBe(0)
      expect(named(spans, 'action.main').status?.code ?? 0).toBe(0)
    })

    it('records an exception with no cause chain and no stack', async () => {
      // #given
      const target = await sink()
      const {tracer} = harness(target.url)
      const span = tracer.startSpan('finalize')
      span.recordException(new Error('outer', {cause: new Error('inner cause text')}))
      span.end({outcome: 'failed'})
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then
      expect(target.requests[0]?.text).not.toContain('inner cause text')
      expect(target.requests[0]?.text).not.toContain('stack')
      expect(target.requests[0]?.text).not.toContain('at ')
    })

    it('ends a span that was never ended, at flush, with a reason and no outcome', async () => {
      // #given
      const target = await sink()
      const {tracer} = harness(target.url)
      tracer.startSpan('execution')

      // #when
      await tracer.flush()

      // #then
      const open = named(allSpans(target), 'execution')
      expect(attr(open, 'fro_bot.reason')).toBe('unfinished')
      expect(attr(open, 'fro_bot.outcome')).toBeUndefined()
    })

    it('covers every outcome the Action already has', () => {
      // #then the type is a superset of the invocation outcomes, plus the tracing-only value
      expectTypeOf<InvocationOutcome>().toExtend<SpanOutcome>()
      expectTypeOf<'cancelled'>().toExtend<SpanOutcome>()
    })
  })

  describe('session', () => {
    it('gives spans that ended before the session was known the session attribute at export', async () => {
      // #given a span ended before the id exists, one after
      const target = await sink()
      const {tracer} = harness(target.url)
      tracer.startSpan('bootstrap').end()
      tracer.setSessionId('fro-bot/agent:issue-42')
      tracer.startSpan('session prep').end()
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then every span carries it
      for (const span of allSpans(target)) expect(attr(span, 'langfuse.session.id')).toBe('fro-bot/agent:issue-42')
    })

    it('sets no session attribute when none was given', async () => {
      // #given
      const target = await sink()
      const {tracer} = harness(target.url)
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then
      expect(attr(allSpans(target)[0] as Decoded, 'langfuse.session.id')).toBeUndefined()
    })
  })

  describe('enablement', () => {
    it('is a no-op with tracing off: no request, no exporter', async () => {
      // #given
      const {tracer, createExporter, logger} = harness(undefined)

      // #when
      const span = tracer.startSpan('bootstrap')
      span.recordException(new Error('x'))
      span.end()
      const result = await tracer.flush()

      // #then
      expect(tracer.enabled).toBe(false)
      expect(tracer.ids).toBeNull()
      expect(createExporter).not.toHaveBeenCalled()
      expect(result).toEqual({spans: 0, undelivered: 0})
      expect(serializeLoggerCalls(logger)).toBe('[]')
    })

    it('refuses a credential over http even if the inputs said enabled, with one fixed warning', async () => {
      // #given an input that passed parsing somewhere it should not have
      const {tracer, createExporter, logger} = harness('http://collector.example.com/v1/traces', {}, [
        {name: 'Authorization', value: 'Bearer should-never-be-sent'},
      ])

      // #when
      await tracer.flush()

      // #then
      expect(tracer.enabled).toBe(false)
      expect(createExporter).not.toHaveBeenCalled()
      expect(logger.warning).toHaveBeenCalledTimes(1)
      expect(serializeLoggerCalls(logger)).not.toContain('collector.example.com')
      expect(serializeLoggerCalls(logger)).not.toContain('should-never-be-sent')
    })

    it('hands the exporter the validated endpoint and the credential, directly, with no relay in between', async () => {
      // #given
      const target = await sink()
      const {tracer, createExporter} = harness(target.url)
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then
      expect(createExporter).toHaveBeenCalledTimes(1)
      expect(createExporter.mock.calls[0]?.[0]).toMatchObject({
        url: target.url,
        serviceName: LIFECYCLE_SERVICE_NAME,
        reportCounts: false,
      })
      expect(new URL(target.url).pathname).toBe(ENDPOINT_PATH)
    })

    it.each(['http,tls', '*', 'HT*', 'Net', 'tls'])(
      'is off with one fixed warning when NODE_DEBUG is %s: nothing is sent and nothing is printed',
      async nodeDebug => {
        // #given
        const target = await sink()
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        const secret = 'Bearer nodedebug-credential-value'
        const {tracer, createExporter, logger, registry} = harness(target.url, {env: {NODE_DEBUG: nodeDebug}})
        registry.addTraceCredential([{name: 'Authorization', value: secret}])
        tracer.startSpan('bootstrap').end()
        tracer.root.end()

        // #when
        await tracer.flush()

        // #then
        expect(tracer.enabled).toBe(false)
        expect(createExporter).not.toHaveBeenCalled()
        expect(target.received()).toBe(0)
        expect(logger.warning).toHaveBeenCalledTimes(1)
        expect(logger.warning).toHaveBeenCalledWith(NODE_DEBUG_WARNING)
        const printed = JSON.stringify([
          ...stderr.mock.calls,
          ...stdout.mock.calls,
          ...vi.mocked(logger.warning).mock.calls,
        ])
        expect(printed).not.toContain(target.url)
        expect(printed).not.toContain(new URL(target.url).host)
        expect(printed).not.toContain('nodedebug-credential-value')
      },
    )

    it('is on when NODE_DEBUG is empty', () => {
      // #given / #when
      const {tracer} = harness('http://127.0.0.1:9/v1/traces', {env: {NODE_DEBUG: ''}})

      // #then
      expect(tracer.enabled).toBe(true)
    })

    it('does not send a credential to a certificate nothing trusts', async () => {
      // #given an https collector with a self-signed certificate
      if (!opensslAvailable()) return
      const tls = await startTlsSink()
      try {
        const {tracer, logger} = harness(tls.url, {}, [{name: 'Authorization', value: 'Bearer tls-credential-value'}])
        tracer.startSpan('bootstrap').end()
        tracer.root.end()

        // #when
        const result = await tracer.flush()

        // #then the handshake was refused, no HTTP request got through, and the spans are counted undelivered
        expect(tls.requests).toHaveLength(0)
        expect(tls.connections()).toBeGreaterThanOrEqual(1)
        await vi.waitFor(() => expect(tls.tlsErrors()).toBeGreaterThanOrEqual(1), {timeout: 3_000})
        expect(tls.handshakes()).toBe(0)
        expect(result.undelivered).toBe(2)
        expect(serializeLoggerCalls(logger)).not.toContain('tls-credential-value')
        expect(serializeLoggerCalls(logger)).not.toContain(tls.url)
      } finally {
        await tls.stop()
      }
    })
  })

  describe('scrubbing', () => {
    const CANARY = 'canary"secret\\value\nZZ-98765'

    it('keeps a canary out of every field position of the request, raw and JSON-escaped', async () => {
      // #given a canary registered before the spans are recorded
      const target = await sink()
      const {tracer, registry, logger} = harness(target.url)
      registry.mask(CANARY)
      recordEverywhere(tracer, CANARY)

      // #when
      await tracer.flush()

      // #then
      const text = target.requests.map(request => request.text).join('\n')
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toContain(CANARY)
      expect(text).not.toContain(escaped(CANARY))
      expect(text).not.toContain('ZZ-98765')
      expect(serializeLoggerCalls(logger)).not.toContain('ZZ-98765')
    })

    it('redacts a literal registered after the spans were recorded, at flush', async () => {
      // #given
      const target = await sink()
      const {tracer, registry} = harness(target.url)
      recordEverywhere(tracer, CANARY)

      // #when the secret becomes known only now, as the server password does
      registry.mask(CANARY)
      await tracer.flush()

      // #then
      const text = target.requests.map(request => request.text).join('\n')
      expect(text).not.toContain(CANARY)
      expect(text).not.toContain(escaped(CANARY))
    })

    it('redacts the trace credential and its Bearer and Basic forms from the body and the logs', async () => {
      // #given
      const target = await sink()
      const encoded = Buffer.from('collector-user:collector-password').toString('base64')
      const forms = [
        `Basic ${encoded}`,
        encoded,
        'collector-user:collector-password',
        'collector-password',
        'Bearer bearer-credential-abcdef',
        'bearer-credential-abcdef',
      ]
      const {tracer, registry, logger} = harness(target.url)
      registry.addTraceCredential([
        {name: 'Authorization', value: `Basic ${encoded}`},
        {name: 'X-Other', value: 'Bearer bearer-credential-abcdef'},
      ])
      const span = tracer.startSpan('bootstrap')
      for (const [index, form] of forms.entries()) {
        span.setAttribute(`fro_bot.form${index}`, form)
        span.addEvent('seen', {form})
      }
      span.recordException(new Error(`leaked ${forms.join(' | ')}`))
      span.end({outcome: 'failed'})
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then
      const text = target.requests.map(request => request.text).join('\n')
      for (const form of forms) {
        expect(text).not.toContain(form)
        expect(text).not.toContain(escaped(form))
      }
      for (const form of forms) expect(serializeLoggerCalls(logger)).not.toContain(form)
    })

    it('redacts every literal, not only the longest 128', async () => {
      // #given 200 literals of increasing length; the shortest would be the first dropped by a cap
      const target = await sink()
      const {tracer, registry} = harness(target.url)
      const literals = Array.from(
        {length: 200},
        (_value, index) => `lit-${'x'.repeat(index)}-${String(index).padStart(3, '0')}-end`,
      )
      for (const literal of literals) registry.add(literal)
      const span = tracer.startSpan('bootstrap')
      span.setAttribute('fro_bot.shortest', literals[0] as string)
      span.setAttribute('fro_bot.longest', literals[199] as string)
      span.end()
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then
      const text = target.requests.map(request => request.text).join('\n')
      expect(text).not.toContain(literals[0])
      expect(text).not.toContain(literals[199])
    })

    it('scrubs an exception message and a ref name before cutting them, so a cut cannot leave part of a secret', async () => {
      // #given secrets that straddle each cap
      const target = await sink()
      const {tracer, registry} = harness(target.url)
      const secret = 'STRADDLE-SECRET-VALUE-0123'
      registry.add(secret)
      const long = `${'.'.repeat(1_024 - 7)}${secret} and more after`
      const ref = `${'r'.repeat(FREE_TEXT_MAX_CHARS - 7)}${secret} tail`
      const span = tracer.startSpan('routing')
      span.recordException(new Error(long))
      span.setAttribute('fro_bot.ref', freeText(ref, 'ref'))
      span.end({outcome: 'failed'})
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then neither a whole secret nor a piece of it survived
      const text = target.requests.map(request => request.text).join('\n')
      expect(text).not.toContain('STRADDLE')
      expect(text).not.toContain('SECRET-VAL')
      // The marker may itself be cut by the cap, which is the point: the scrub ran first.
      expect(text).toContain('[REDACT')
    })

    it('caps a long exception message and a long ref name', async () => {
      // #given
      const target = await sink()
      const {tracer} = harness(target.url)
      const span = tracer.startSpan('routing')
      span.recordException(new Error('m'.repeat(5_000)))
      span.setAttribute('fro_bot.ref', freeText('r'.repeat(5_000), 'ref'))
      span.end({outcome: 'failed'})
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then
      const routing = named(allSpans(target), 'routing')
      const message = eventAttr(
        eventsNamed(routing, 'exception')[0] ?? {name: '', timeUnixNano: ''},
        'exception.message',
      ) as string
      expect(message.length).toBeLessThan(1_100)
      expect(message.startsWith('mmmm')).toBe(true)
      expect((attr(routing, 'fro_bot.ref') as string).length).toBeLessThan(FREE_TEXT_MAX_CHARS + 60)
    })

    it('omits a value the scrubber cannot process, with a marker', async () => {
      // #given a value over the scrubber's input ceiling, as an attribute and as an exception message
      const target = await sink()
      const {tracer} = harness(target.url)
      const huge = 'h'.repeat(9 * 1024 * 1024)
      const span = tracer.startSpan('execution')
      span.setAttribute('fro_bot.huge', huge)
      span.recordException(new Error(huge))
      span.end({outcome: 'failed'})
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then
      const execution = named(allSpans(target), 'execution')
      expect(attr(execution, 'fro_bot.huge')).toBe('[omitted]')
      expect(
        eventAttr(eventsNamed(execution, 'exception')[0] ?? {name: '', timeUnixNano: ''}, 'exception.message'),
      ).toBe('[omitted]')
      expect(JSON.stringify(attr(execution, 'fro_bot.content.omitted'))).toContain('over-input-ceiling')
    })

    it.each([
      ['shorter than 8', 'short'],
      ['longer than 65,536', 'z'.repeat(65_537)],
    ])('exports categories instead of any free text when a registered value is %s', async (_name, unmatchable) => {
      // #given
      const target = await sink()
      const {tracer, registry} = harness(target.url)
      registry.add(unmatchable)
      const span = tracer.startSpan('routing')
      span.setAttribute('fro_bot.ref', freeText('feature/secret-branch-name', 'ref'))
      span.addEvent('path.dropped', {entry: freeText('/home/runner/secret-dir', 'path-entry'), fixed: 'dropped'})
      span.recordException(new TypeError('message with a hunt-password inside'))
      span.end({outcome: 'failed'})
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then
      const text = target.requests.map(request => request.text).join('\n')
      expect(text).not.toContain('secret-branch-name')
      expect(text).not.toContain('secret-dir')
      expect(text).not.toContain('hunt-password')
      const routing = named(allSpans(target), 'routing')
      expect(attr(routing, 'fro_bot.ref')).toBe('ref')
      expect(eventAttr(eventsNamed(routing, 'path.dropped')[0] ?? {name: '', timeUnixNano: ''}, 'entry')).toBe(
        'path-entry',
      )
      expect(eventAttr(eventsNamed(routing, 'path.dropped')[0] ?? {name: '', timeUnixNano: ''}, 'fixed')).toBe(
        'dropped',
      )
      expect(eventAttr(eventsNamed(routing, 'exception')[0] ?? {name: '', timeUnixNano: ''}, 'exception.message')).toBe(
        'TypeError',
      )
    })

    it('exports a fixed category, never the error name, when a registered value the scrubber cannot match is the name', async () => {
      // #given a registered 7-character credential (outside the scrubber's range) that a thrown error carries as its name
      const target = await sink()
      const {tracer, registry} = harness(target.url)
      const secret = 'Zq9x4t7'
      registry.add(secret)
      const span = tracer.startSpan('routing')
      span.recordException(Object.assign(new Error(`failed for ${secret}`), {name: secret}))
      span.end({outcome: 'failed'})
      const typed = tracer.startSpan('dedup')
      typed.recordException(new TypeError(`bad value ${secret}`))
      typed.end({outcome: 'failed'})
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then the credential is in no byte of the export, and the name became the category `Error`, in every place it is written
      const text = target.requests.map(request => request.text).join('\n')
      expect(text).not.toContain(secret)
      const routing = named(allSpans(target), 'routing')
      const exception = eventsNamed(routing, 'exception')[0] ?? {name: '', timeUnixNano: ''}
      expect(eventAttr(exception, 'exception.type')).toBe('Error')
      expect(eventAttr(exception, 'exception.message')).toBe('Error')
      expect(attr(routing, 'error.type')).toBe('Error')
      expect(routing.status?.message).toBe('Error')
      // #and a built-in name is kept: it is one of a fixed set, not text the run supplied
      expect(
        eventAttr(eventsNamed(named(allSpans(target), 'dedup'), 'exception')[0] ?? exception, 'exception.type'),
      ).toBe('TypeError')
    })

    it('keeps free text, and redacts the token where it appears, for a 4,152-character ACTIONS_RUNTIME_TOKEN', async () => {
      // #given the token a JavaScript action's process holds on a hosted runner, registered as the run does
      const token = `eyJ${'AbCd0123'.repeat(520)}`.slice(0, 4_152)
      expect(token).toHaveLength(4_152)
      const target = await sink()
      const {tracer, registry} = harness(target.url)
      registry.addSecretEnv({ACTIONS_RUNTIME_TOKEN: token})
      const span = tracer.startSpan('routing')
      span.setAttribute('fro_bot.ref', freeText('feature/branch', 'ref'))
      span.setAttribute('fro_bot.url', freeText(`https://pipelines.example/x?t=${token}&keep=1`, 'url'))
      span.recordException(new Error(`request failed with ${token} in the header`))
      span.end({outcome: 'failed'})
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then free text survives, and the token appears nowhere in what was sent, raw or JSON-escaped
      const text = target.requests.map(request => request.text).join('\n')
      expect(registry.matchable()).toBe(true)
      const routing = named(allSpans(target), 'routing')
      expect(attr(routing, 'fro_bot.ref')).toBe('feature/branch')
      expect(String(attr(routing, 'fro_bot.url'))).toContain('keep=1')
      expect(text).not.toContain(token.slice(0, 64))
      expect(text).not.toContain(escaped(token).slice(0, 64))
      expect(
        eventAttr(eventsNamed(routing, 'exception')[0] ?? {name: '', timeUnixNano: ''}, 'exception.message'),
      ).toContain('in the header')
    })

    it('logs one info line naming each out-of-range source and its length, and never a value', async () => {
      // #given a short value in a secret-named variable and a too-long one in another, and a distinctive value in each
      const target = await sink()
      const {tracer, registry, logger} = harness(target.url)
      const shortValue = 'sh0rtVal'.slice(0, 7)
      const longValue = `LONGVAL${'z'.repeat(65_540)}`
      registry.addSecretEnv({FOO_TOKEN: shortValue, BAR_SECRET: longValue})
      tracer.startSpan('routing').end()
      tracer.root.end()

      // #when it is flushed twice
      await tracer.flush()
      await tracer.flush()

      // #then one info line, with the fixed text and the sources with their lengths
      const infos = vi
        .mocked(logger.info)
        .mock.calls.filter(([message]) => String(message).startsWith('Lifecycle trace carries no free text'))
      expect(infos).toEqual([
        [
          'Lifecycle trace carries no free text: a registered secret is outside 8–65,536 characters',
          {sources: ['env:FOO_TOKEN (7 characters)', 'env:BAR_SECRET (65547 characters)']},
        ],
      ])
      // #and no value, in any form, reached any log call
      const logged = serializeLoggerCalls(logger)
      expect(logged).not.toContain(shortValue)
      expect(logged).not.toContain('LONGVAL')
    })

    it('says nothing when every registered value is in range', async () => {
      // #given
      const target = await sink()
      const {tracer, registry, logger} = harness(target.url)
      registry.addSecretEnv({FOO_TOKEN: 'in-range-token-value'})
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then
      expect(serializeLoggerCalls(logger)).not.toContain('carries no free text')
    })

    it('exports free text when every registered value is in range', async () => {
      // #given
      const target = await sink()
      const {tracer, registry} = harness(target.url)
      registry.add('in-range-secret-value')
      const span = tracer.startSpan('routing')
      span.setAttribute('fro_bot.ref', freeText('feature/branch', 'ref'))
      span.end()
      tracer.root.end()

      // #when
      await tracer.flush()

      // #then
      expect(attr(named(allSpans(target), 'routing'), 'fro_bot.ref')).toBe('feature/branch')
    })
  })

  describe('delivery', () => {
    it.each([
      ['401', 401],
      ['413', 413],
    ])('leaves the run alone on a %s: one request, no retry, the spans counted undelivered', async (_name, status) => {
      // #given
      const target = await sink({respond: () => ({status, body: 'COLLECTOR-CANARY-BODY'})})
      const {tracer, logger} = finished(target.url)
      const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(process.stderr, 'write')]
      for (const spy of spies) spy.mockImplementation(() => true)

      // #when
      const started = Date.now()
      const result = await tracer.flush()

      // #then
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(target.requests).toHaveLength(1)
      expect(result).toEqual({spans: 2, undelivered: 2})
      expect(logger.warning).toHaveBeenCalledTimes(1)
      expect(logger.warning).toHaveBeenCalledWith(expect.any(String), {spans: 2, undelivered: 2})
      expect(serializeLoggerCalls(logger)).not.toContain('COLLECTOR-CANARY-BODY')
      expect(JSON.stringify(spies.flatMap(spy => spy.mock.calls))).not.toContain('COLLECTOR-CANARY-BODY')
    })

    it('ends within the bound on a collector that never answers, and counts the spans undelivered', async () => {
      // #given
      const target = await sink({respond: () => ({status: 200, hold: true})})
      const {tracer} = finished(target.url, {flushBoundMs: 800, exporterLimits: {...FAST, requestTimeoutMs: 20_000}})

      // #when
      const started = Date.now()
      const result = await tracer.flush()

      // #then
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(result).toEqual({spans: 2, undelivered: 2})
    })

    it('retries a 503 with a Retry-After that fits in the bound, and delivers', async () => {
      // #given
      const target = await sink({
        respond: n => (n === 1 ? {status: 503, headers: {'retry-after': '1'}} : {status: 200}),
      })
      const {tracer} = finished(target.url, {flushBoundMs: 7_000, exporterLimits: {...FAST, requestTimeoutMs: 8_000}})

      // #when
      const result = await tracer.flush()

      // #then
      expect(target.requests.map(request => request.status)).toEqual([503, 200])
      expect(result).toEqual({spans: 2, undelivered: 0})
    }, 15_000)

    it('counts a 200 with a partial rejection as delivered and logs nothing from its body', async () => {
      // #given
      const body = JSON.stringify({partialSuccess: {rejectedSpans: '1', errorMessage: 'PARTIAL-CANARY-MESSAGE'}})
      const target = await sink({respond: () => ({status: 200, body})})
      const {tracer, logger} = finished(target.url)
      const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(process.stderr, 'write')]
      for (const spy of spies) spy.mockImplementation(() => true)

      // #when
      const result = await tracer.flush()

      // #then
      expect(result).toEqual({spans: 2, undelivered: 0})
      expect(logger.info).toHaveBeenCalledTimes(1)
      expect(logger.warning).not.toHaveBeenCalled()
      expect(serializeLoggerCalls(logger)).not.toContain('PARTIAL-CANARY-MESSAGE')
      expect(JSON.stringify(spies.flatMap(spy => spy.mock.calls))).not.toContain('PARTIAL-CANARY-MESSAGE')
    })

    it('does not follow a redirect: a second listener receives nothing', async () => {
      // #given a collector that redirects to another listener
      const second = await sink()
      const first = await sink({respond: () => ({status: 307, headers: {location: second.url}})})
      const {tracer} = finished(first.url)

      // #when
      const result = await tracer.flush()

      // #then
      expect(first.requests).toHaveLength(1)
      expect(second.received()).toBe(0)
      expect(result.undelivered).toBe(2)
    })

    it('never logs a collector response body', async () => {
      // #given a 500 whose body holds a canary
      const target = await sink({respond: () => ({status: 500, body: 'RESPONSE-CANARY-9876'})})
      const {tracer, logger} = finished(target.url)

      // #when
      await tracer.flush()

      // #then
      expect(serializeLoggerCalls(logger)).not.toContain('RESPONSE-CANARY-9876')
    })

    it('sends once however many times flush is called', async () => {
      // #given
      const target = await sink()
      const {tracer, createExporter, logger} = finished(target.url)

      // #when flushed twice at once and once more after
      const [first, second] = await Promise.all([tracer.flush(), tracer.flush()])
      const third = await tracer.flush()

      // #then
      expect(target.accepted()).toHaveLength(1)
      expect(createExporter).toHaveBeenCalledTimes(1)
      expect(second).toBe(first)
      expect(third).toBe(first)
      expect(logger.info).toHaveBeenCalledTimes(1)
    })

    it('records nothing after the flush', async () => {
      // #given
      const target = await sink()
      const {tracer} = finished(target.url)
      await tracer.flush()

      // #when
      tracer.startSpan('late').end()

      // #then
      await tracer.flush()
      expect(allSpans(target).map(span => span.name)).not.toContain('late')
    })

    it('never throws into the run when the exporter itself fails', async () => {
      // #given
      const target = await sink()
      const {tracer, logger} = finished(target.url, {
        createExporter: () => {
          throw new Error(`boom with ${target.url}`)
        },
      })

      // #when
      const result = await tracer.flush()

      // #then
      expect(result).toEqual({spans: 2, undelivered: 2})
      expect(logger.warning).toHaveBeenCalledTimes(1)
      expect(serializeLoggerCalls(logger)).not.toContain(target.url)
    })
  })
})

describe('withSpan', () => {
  const recording = async () => {
    const {createRecordingTracer} = await import('./lifecycle-tracer.testing.js')
    return createRecordingTracer()
  }

  it('ends the span succeeded with the classifier’s result, and returns the value', async () => {
    // #given
    const {tracer, exported} = await recording()
    const span = tracer.startSpan('phase')

    // #when
    const value = await withSpan(
      span,
      async () => 41,
      result => ({outcome: 'skipped', reason: `got-${result}`}),
    )
    tracer.root.end()
    await tracer.flush()

    // #then
    expect(value).toBe(41)
    const phase = exported.find(item => item.name === 'phase')
    expect(phase?.attributes['fro_bot.outcome']).toBe('skipped')
    expect(phase?.attributes['fro_bot.reason']).toBe('got-41')
  })

  it('records the throw as an exception, ends the span failed, and rethrows the same error', async () => {
    // #given
    const {tracer, exported} = await recording()
    const boom = new Error('boom')

    // #when
    await expect(
      withSpan(tracer.startSpan('phase'), async () => {
        throw boom
      }),
    ).rejects.toBe(boom)
    tracer.root.end()
    await tracer.flush()

    // #then
    const phase = exported.find(item => item.name === 'phase')
    expect(phase?.attributes['fro_bot.outcome']).toBe('failed')
    expect(phase?.events.some(event => event.name === 'exception')).toBe(true)
  })

  it('keeps the phase’s result when the classifier itself throws', async () => {
    // #given / #when
    const {tracer} = await recording()
    const value = await withSpan(
      tracer.startSpan('phase'),
      async () => 'ok',
      () => {
        throw new Error('classifier')
      },
    )

    // #then
    expect(value).toBe('ok')
  })

  it('does nothing on the no-op span', async () => {
    await expect(withSpan(NOOP_SPAN, async () => 'fine')).resolves.toBe('fine')
  })
})

describe('the resource', () => {
  it('holds the service name and nothing else, and no detector reads the machine id, the registry or the host', async () => {
    // #given every route a resource detector takes to the host: the machine-id files, the registry and `ioreg`/`kenv` through a
    // child process, and the host name. (The bundle ships `@opentelemetry/resources`' detector code; none of it may run.)
    const reads = [
      vi.spyOn(fs.promises, 'readFile'),
      vi.spyOn(fs, 'readFileSync'),
      vi.spyOn(childProcess, 'exec'),
      vi.spyOn(childProcess, 'execFile'),
      vi.spyOn(childProcess, 'execSync'),
      vi.spyOn(childProcess, 'spawn'),
      vi.spyOn(os, 'hostname'),
    ]
    const target = await sink()
    const {tracer} = harness(target.url)
    tracer.startSpan('bootstrap').end({outcome: 'succeeded'})
    tracer.root.end({outcome: 'succeeded'})

    // #when
    await tracer.flush()

    // #then the resource is the one attribute we set
    const body = target.requests[0]?.body as {
      resourceSpans: {resource: {attributes: {key: string; value: unknown}[]}}[]
    }
    expect(body.resourceSpans[0]?.resource.attributes).toEqual([
      {key: 'service.name', value: {stringValue: LIFECYCLE_SERVICE_NAME}},
    ])
    // #and nothing went looking for the host
    for (const spy of reads) expect(spy).not.toHaveBeenCalled()
  })
})

describe('cancel', () => {
  it('ends every open span cancelled with the reason, root included, and leaves the ended ones alone', async () => {
    // #given a finished phase, an open phase with an open child, and the open root
    const target = await sink()
    const {tracer} = harness(target.url)
    tracer.startSpan('bootstrap').end({outcome: 'succeeded'})
    const execution = tracer.startSpan('execution')
    execution.startChild('install')

    // #when a signal cancels the run
    tracer.cancel('sigint')
    await tracer.flush()

    // #then
    const spans = allSpans(target)
    expect(attr(named(spans, 'bootstrap'), 'fro_bot.outcome')).toBe('succeeded')
    for (const name of ['execution', 'install', 'action.main']) {
      expect(attr(named(spans, name), 'fro_bot.outcome')).toBe('cancelled')
      expect(attr(named(spans, name), 'fro_bot.reason')).toBe('sigint')
    }
    // A cancelled span is not an error.
    expect(named(spans, 'execution').status?.code ?? 0).toBe(0)
  })

  it('keeps the cancelled outcome when the phase unwinds and ends itself afterwards (the first end wins)', async () => {
    // #given
    const target = await sink()
    const {tracer} = harness(target.url)
    const execution = tracer.startSpan('execution')
    tracer.cancel('sigterm')

    // #when the reaped command makes the phase end as failed, and the root as failed
    execution.recordException(new Error('child was killed'))
    execution.end({outcome: 'failed', reason: 'exception'})
    tracer.root.setAttribute('fro_bot.exit_code', 1)
    tracer.root.end({outcome: 'failed'})
    await tracer.flush()

    // #then
    const spans = allSpans(target)
    expect(attr(named(spans, 'execution'), 'fro_bot.outcome')).toBe('cancelled')
    expect(named(spans, 'execution').events ?? []).toEqual([])
    expect(attr(named(spans, 'action.main'), 'fro_bot.outcome')).toBe('cancelled')
  })

  it('does nothing after the flush has begun, and nothing on the no-op tracer', async () => {
    // #given a flushed tracer and a no-op one
    const target = await sink()
    const {tracer} = harness(target.url)
    tracer.root.end({outcome: 'succeeded'})
    await tracer.flush()
    const {tracer: off} = harness(undefined)

    // #when
    tracer.cancel('sigint')

    // #then
    expect(attr(named(allSpans(target), 'action.main'), 'fro_bot.outcome')).toBe('succeeded')
    expect(() => off.cancel('sigint')).not.toThrow()
  })
})

describe('flush bound', () => {
  it('uses the bound of the first call, so a signal’s export ends at its own deadline', async () => {
    // #given a collector that never answers
    const target = await sink({respond: () => ({status: 200, hold: true})})
    const {tracer} = harness(target.url, {flushBoundMs: 5_000})
    tracer.root.end({outcome: 'succeeded'})

    // #when flushed with a 300 ms bound
    const started = Date.now()
    const result = await tracer.flush({boundMs: 300})

    // #then it ended near the bound, not the tracer's 5 s, with the spans counted undelivered
    expect(Date.now() - started).toBeLessThan(2_500)
    expect(result.undelivered).toBeGreaterThan(0)
  })

  it('ignores the bound of a later call: the first call exports, every later call gets its result', async () => {
    // #given
    const target = await sink()
    const {tracer} = harness(target.url)
    tracer.root.end({outcome: 'succeeded'})

    // #when
    const first = await tracer.flush({boundMs: 1_000})
    const second = await tracer.flush({boundMs: 1})

    // #then
    expect(second).toBe(first)
    expect(target.received()).toBe(1)
  })
})

describe('the session attribute at flush', () => {
  const sessionOf = (spans: readonly Decoded[]): unknown => attr(named(spans, 'action.main'), 'langfuse.session.id')

  it('exports a session id that scrubbing leaves unchanged', async () => {
    // #given
    const target = await sink()
    const {tracer} = harness(target.url)
    tracer.setSessionId('fro-bot/agent:issue-42')
    tracer.root.end({outcome: 'succeeded'})

    // #when
    await tracer.flush()

    // #then
    expect(sessionOf(allSpans(target))).toBe('fro-bot/agent:issue-42')
  })

  it('exports no session id at all when scrubbing would change it, never a redacted one', async () => {
    // #given a repository whose name trips the scrubber's name/value rule
    const target = await sink()
    const {tracer} = harness(target.url)
    tracer.setSessionId('acme/password-manager:issue-42')
    tracer.startSpan('bootstrap').end({outcome: 'succeeded'})
    tracer.root.end({outcome: 'succeeded'})

    // #when
    await tracer.flush()

    // #then no span carries the attribute, and nothing was sent in its place
    const spans = allSpans(target)
    for (const span of spans) expect(attr(span, 'langfuse.session.id')).toBeUndefined()
    expect(
      target
        .accepted()
        .map(request => request.text)
        .join(''),
    ).not.toContain('REDACTED')
  })

  it('exports no session id that holds a registered secret', async () => {
    // #given a session id with a registered literal in it
    const target = await sink()
    const made = harness(target.url)
    made.registry.mask('sentinel-secret-9876')
    made.tracer.setSessionId('fro-bot/agent:sentinel-secret-9876')
    made.tracer.root.end({outcome: 'succeeded'})

    // #when
    await made.tracer.flush()

    // #then
    expect(sessionOf(allSpans(target))).toBeUndefined()
  })
})

describe('continuing a trace', () => {
  const ids = {traceId: '1'.repeat(32), rootSpanId: '2'.repeat(16), invocationId: '3'.repeat(16)}

  it('adds spans under the saved root without exporting a root of its own, in the saved trace', async () => {
    // #given a tracer continuing another process's trace
    const target = await sink()
    const {tracer} = harness(target.url, {continueFrom: ids})

    // #when it records a span and flushes
    tracer.startSpan('post').end({outcome: 'succeeded'})
    tracer.root.end({outcome: 'succeeded'})
    await tracer.flush()

    // #then one span, in the saved trace, hung from the saved root, carrying the saved invocation id
    const spans = allSpans(target)
    expect(spans.map(span => span.name)).toEqual(['post'])
    expect(spans[0]?.traceId).toBe(ids.traceId)
    expect(spans[0]?.parentSpanId).toBe(ids.rootSpanId)
    expect(attr(spans[0] as Decoded, 'fro_bot.invocation.id')).toBe(ids.invocationId)
    expect(tracer.ids).toEqual(ids)
  })
})

describe('parseTraceIds', () => {
  const good = {traceId: '1'.repeat(32), rootSpanId: '2'.repeat(16), invocationId: '3'.repeat(16)}

  it('accepts the record main saves', () => {
    expect(parseTraceIds(JSON.stringify(good))).toEqual(good)
  })

  it.each([
    ['empty', ''],
    ['not JSON', 'nope'],
    ['null', 'null'],
    ['an array', '[]'],
    ['a missing key', JSON.stringify({traceId: good.traceId, rootSpanId: good.rootSpanId})],
    ['an extra key', JSON.stringify({...good, extra: 'x'})],
    ['a short trace id', JSON.stringify({...good, traceId: '1'.repeat(31)})],
    ['an all-zero span id', JSON.stringify({...good, rootSpanId: '0'.repeat(16)})],
    ['an uppercase id', JSON.stringify({...good, invocationId: 'A'.repeat(16)})],
    ['a number', JSON.stringify({...good, traceId: 1})],
  ])('refuses %s', (_name, text) => {
    expect(parseTraceIds(text)).toBeNull()
  })
})
