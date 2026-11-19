import type {Socket} from 'node:net'
import type {ScrubbedSpan} from './content.js'
import type {SpanExporter, SpanExporterOptions} from './exporter.js'
import {createServer as createHttpServer} from 'node:http'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {startOtlpSink, startTlsSink, type OtlpSink, type SinkRequest} from '../integration.fixture.js'
import {scrubbedBrand} from './content.js'
import {
  createSpanExporter,
  DEFAULT_EXPORTER_LIMITS,
  estimateSpanBytes,
  formatCountsHeader,
  SDK_SPAN_LIMITS,
  TRACE_COUNTS_HEADER,
} from './exporter.js'

const FAST = {batchIntervalMs: 15, requestTimeoutMs: 2_500, maxConsecutiveFailures: 3}
const sleep = async (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const hex = (n: number, length: number): string => n.toString(16).padStart(length, '0')
const TRACE = hex(0xabc, 32)

let spanCounter = 0
/** A span the way `scrubSpan` makes one. The brand is the module's own symbol, so only this module's tests may forge it. */
function span(overrides: Partial<Omit<ScrubbedSpan, typeof scrubbedBrand>> = {}): ScrubbedSpan {
  spanCounter += 1
  return {
    [scrubbedBrand]: true,
    traceId: TRACE,
    spanId: hex(spanCounter, 16),
    parentSpanId: undefined,
    name: 'execute_tool read',
    kind: 'internal',
    startMs: 1_700_000_000_000.25,
    endMs: 1_700_000_000_250.5,
    attributes: {'gen_ai.tool.name': 'read'},
    status: {code: 'unset'},
    events: [],
    ...overrides,
  }
}

interface Decoded {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly kind: number
  readonly startTimeUnixNano: string
  readonly endTimeUnixNano: string
  readonly attributes: {key: string; value: Record<string, unknown>}[]
  readonly status?: {code?: number; message?: string}
  readonly events?: {name: string; timeUnixNano: string; attributes?: {key: string; value: unknown}[]}[]
}

/** Every span in a decoded OTLP JSON request. */
function spansOf(request: SinkRequest): Decoded[] {
  const body = request.body as {resourceSpans: {scopeSpans: {spans: Decoded[]}[]}[]}
  return body.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
}

const attr = (decoded: Decoded, key: string): unknown => {
  const found = decoded.attributes.find(item => item.key === key)
  if (found === undefined) return undefined
  const value = found.value
  return value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue ?? value.arrayValue
}

const sinks: OtlpSink[] = []
const exporters: SpanExporter[] = []
const sink = async (...args: Parameters<typeof startOtlpSink>): Promise<OtlpSink> => {
  const started = await startOtlpSink(...args)
  sinks.push(started)
  return started
}
function exporterFor(options: Partial<SpanExporterOptions> & Pick<SpanExporterOptions, 'url'>): SpanExporter {
  const made = createSpanExporter({headers: {}, reportCounts: false, limits: FAST, ...options})
  exporters.push(made)
  return made
}

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const exporter of exporters.splice(0)) await exporter.close(0)
  for (const started of sinks.splice(0)) await started.stop()
})

describe('what the exporter sends', () => {
  it('exports spans with the explicit ids, parents and times it was given, a parent that has already ended included', async () => {
    // #given a tool span that ended, then a child that starts after it ended (a background subagent)
    const target = await sink()
    const exporter = exporterFor({url: target.url})
    const tool = span({spanId: hex(1, 16), startMs: 1_700_000_000_100, endMs: 1_700_000_000_107})
    const child = span({
      spanId: hex(2, 16),
      parentSpanId: tool.spanId,
      name: 'invoke_agent general',
      kind: 'internal',
      startMs: 1_700_000_000_110.5,
      endMs: 1_700_000_005_000,
      status: {code: 'error', message: 'boom'},
      events: [{name: 'exception', timeMs: 1_700_000_004_999, attributes: {'exception.type': 'x'}}],
    })

    // #when both are exported and the exporter closes
    exporter.export(tool)
    exporter.export(child)
    const counts = await exporter.close(3_000)

    // #then one request carried both, with the ids, the parent link and the times exactly as given
    expect(counts).toEqual({exported: 2, dropped: 0})
    const [request] = target.accepted()
    const [first, second] = spansOf(request as SinkRequest)
    expect([first?.traceId, first?.spanId, first?.parentSpanId]).toEqual([TRACE, tool.spanId, undefined])
    expect([second?.traceId, second?.spanId, second?.parentSpanId]).toEqual([TRACE, child.spanId, tool.spanId])
    expect(first?.startTimeUnixNano).toBe('1700000000100000000')
    expect(first?.endTimeUnixNano).toBe('1700000000107000000')
    expect(second?.startTimeUnixNano).toBe('1700000000110500000')
    expect(second?.status).toMatchObject({code: 2, message: 'boom'})
    expect(second?.events?.[0]).toMatchObject({name: 'exception', timeUnixNano: '1700000004999000000'})
    expect(request?.contentType).toBe('application/json')
  })

  it('carries a hand-built resource with no process arguments, host name or environment', async () => {
    // #given an exported span
    const target = await sink()
    const exporter = exporterFor({url: target.url})
    exporter.export(span())

    // #when it is received
    await exporter.close(3_000)

    // #then the resource holds the service name and nothing else
    const body = (target.accepted()[0] as SinkRequest).body as {
      resourceSpans: {resource: {attributes: {key: string}[]}}[]
    }
    expect(body.resourceSpans[0]?.resource.attributes.map(item => item.key)).toEqual(['service.name'])
    const text = (target.accepted()[0] as SinkRequest).text
    for (const process of ['process.command_args', 'process.pid', 'host.name', 'process.executable.path']) {
      expect(text).not.toContain(process)
    }
  })

  it('is not changed by OTEL_* variables in the environment', async () => {
    // #given a decoy collector, decoy headers, a resource, an always-off sampler and tiny SDK limits in the environment
    const decoy = await sink()
    const target = await sink()
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', decoy.url.replace('/v1/traces', ''))
    vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', decoy.url)
    vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'x-decoy=1')
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'decoy.attr=1')
    vi.stubEnv('OTEL_SERVICE_NAME', 'decoy-service')
    vi.stubEnv('OTEL_TRACES_SAMPLER', 'always_off')
    vi.stubEnv('OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT', '10')
    vi.stubEnv('OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT', '10')
    vi.stubEnv('OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT', '1')
    vi.stubEnv('OTEL_SDK_DISABLED', 'true')
    const exporter = exporterFor({url: target.url, headers: {authorization: 'Basic real'}})
    const long = 'v'.repeat(500_000)

    // #when a span with many attributes and a long value is exported
    exporter.export(span({attributes: {a: '1', b: '2', c: '3', 'gen_ai.input.messages': long}}))
    await exporter.close(3_000)

    // #then it went to the real target only, with the real headers, whole
    expect(decoy.requests).toHaveLength(0)
    const [request] = target.accepted()
    expect(request?.headers.authorization).toBe('Basic real')
    expect(request?.headers['x-decoy']).toBeUndefined()
    const [sent] = spansOf(request as SinkRequest)
    expect(attr(sent as Decoded, 'gen_ai.input.messages')).toBe(long)
    expect(sent?.attributes).toHaveLength(4)
    expect((request as SinkRequest).text).not.toMatch(/decoy/)
  })

  it('sets the SDK limits so none cuts content the plugin already bounded', () => {
    // #given / #when / #then
    expect(SDK_SPAN_LIMITS).toEqual({
      attributeValueLengthLimit: Number.POSITIVE_INFINITY,
      attributeCountLimit: 128,
      eventCountLimit: 128,
      linkCountLimit: 128,
      attributePerEventCountLimit: 128,
      attributePerLinkCountLimit: 128,
    })
  })

  it('sends the credential headers it was given, and only in the request headers', async () => {
    // #given local mode headers
    const target = await sink()
    const exporter = exporterFor({url: target.url, headers: {authorization: 'Basic abc123'}})
    exporter.export(span())

    // #when
    await exporter.close(3_000)

    // #then the header went out, and the body does not hold it
    const [request] = target.accepted()
    expect(request?.headers.authorization).toBe('Basic abc123')
    expect(request?.text).not.toContain('abc123')
  })
})

describe('the counts header', () => {
  it('has exactly the relay’s form, and the strings the plugin and the relay must agree on', () => {
    // #given / #when / #then
    expect(TRACE_COUNTS_HEADER).toBe('x-frobot-trace-counts')
    expect(formatCountsHeader({exported: 0, dropped: 0})).toBe('exported=0;dropped=0')
    expect(formatCountsHeader({exported: 12, dropped: 3})).toBe('exported=12;dropped=3')
    expect(formatCountsHeader({exported: 10 ** 15, dropped: 1})).toBe('exported=999999999999;dropped=1')
    expect(formatCountsHeader({exported: 123_456_789_012, dropped: 0})).toMatch(/^exported=\d{1,12};dropped=\d{1,12}$/)
  })

  it('rides on every batch in Action mode, as running totals as of the batch’s start', async () => {
    // #given three batches of one span each, one second apart in effect
    const target = await sink()
    const exporter = exporterFor({url: target.url, reportCounts: true, limits: {...FAST, maxBatchSpans: 1}})

    // #when each is exported after the previous was accepted
    for (let index = 0; index < 3; index += 1) {
      exporter.export(span())
      await vi.waitFor(() => {
        expect(target.accepted()).toHaveLength(index + 1)
      })
      await vi.waitFor(() => {
        expect(exporter.counts().exported).toBe(index + 1)
      })
    }
    await exporter.close(1_000)

    // #then every request carries a well-formed value and the totals grow batch by batch
    const values = target.accepted().map(request => request.headers[TRACE_COUNTS_HEADER])
    expect(values).toEqual(['exported=0;dropped=0', 'exported=1;dropped=0', 'exported=2;dropped=0'])
    for (const value of values) expect(value).toMatch(/^exported=\d{1,12};dropped=\d{1,12}$/)
  })

  it('is absent in local mode', async () => {
    // #given local mode
    const target = await sink()
    const exporter = exporterFor({url: target.url, reportCounts: false})
    exporter.export(span())

    // #when
    await exporter.close(3_000)

    // #then
    expect(target.accepted()[0]?.headers[TRACE_COUNTS_HEADER]).toBeUndefined()
  })

  it('counts drops in the header too', async () => {
    // #given spans that fail to map, noted as dropped, then one delivered batch
    const target = await sink()
    const exporter = exporterFor({url: target.url, reportCounts: true})
    exporter.drop(4)
    exporter.export(span())

    // #when
    await exporter.close(3_000)

    // #then
    expect(target.accepted()[0]?.headers[TRACE_COUNTS_HEADER]).toBe('exported=0;dropped=4')
    expect(exporter.counts()).toEqual({exported: 1, dropped: 4})
  })
})

describe('retry and refusal against the relay’s three answers', () => {
  it('retries a 503 and delivers once: the batch arrives exactly once at the destination', async () => {
    // #given a sink that answers retry twice, then delivered, with no retry-after
    const target = await sink({respond: n => ({status: n <= 2 ? 503 : 200})})
    // The delegate retries after about 1 s, then about 1.5 s (each with 20% jitter) and gives up when the next wait would
    // pass the request's own deadline: the deadline has to be well past the two waits, or this test is a coin flip.
    const exporter = exporterFor({url: target.url, limits: {...FAST, requestTimeoutMs: 8_000}})
    exporter.export(span())

    // #when
    const counts = await exporter.close(7_000)

    // #then three requests went out, one was accepted, and the span counts once as exported
    expect(target.requests.map(request => request.status)).toEqual([503, 503, 200])
    expect(target.accepted()).toHaveLength(1)
    expect(counts).toEqual({exported: 1, dropped: 0})
  }, 15_000)

  it('treats a 422 as final: one request, no retry, the batch counted as dropped', async () => {
    // #given a sink that answers dropped
    const target = await sink({respond: () => ({status: 422, body: 'dropped'})})
    const exporter = exporterFor({url: target.url})
    exporter.export(span())
    exporter.export(span())

    // #when
    const counts = await exporter.close(3_000)

    // #then
    expect(target.requests).toHaveLength(1)
    expect(counts).toEqual({exported: 0, dropped: 2})
  })

  it('gives up on a 503 that never clears, within the batch timeout, and counts the batch dropped', async () => {
    // #given a sink that always answers retry, and a short batch timeout
    const target = await sink({respond: () => ({status: 503})})
    const exporter = exporterFor({
      url: target.url,
      limits: {...FAST, requestTimeoutMs: 1_500, maxConsecutiveFailures: 9},
    })
    exporter.export(span())

    // #when
    const started = Date.now()
    const counts = await exporter.close(6_000)

    // #then it retried at least once, stopped inside the timeout plus slack, and counted the span once
    expect(target.requests.length).toBeGreaterThanOrEqual(2)
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(counts).toEqual({exported: 0, dropped: 1})
  }, 15_000)

  it('a retry-after from the destination never lengthens the wait past the batch timeout', async () => {
    // #given a retry answer asking for a long wait
    const target = await sink({respond: () => ({status: 503, headers: {'retry-after': '120'}})})
    const exporter = exporterFor({url: target.url, limits: {...FAST, requestTimeoutMs: 1_200}})
    exporter.export(span())

    // #when
    const started = Date.now()
    const counts = await exporter.close(5_000)

    // #then the exporter returned promptly, with the span counted dropped
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(counts.dropped).toBe(1)
  }, 15_000)

  it('keeps one batch in flight at a time, far under the relay’s limit of eight', async () => {
    // #given many spans and a slow sink
    const target = await sink({respond: () => ({status: 200, delayMs: 40})})
    const exporter = exporterFor({url: target.url, limits: {...FAST, maxBatchSpans: 2}})

    // #when thirty spans are exported
    for (let index = 0; index < 30; index += 1) exporter.export(span())
    const counts = await exporter.close(6_000)

    // #then never more than one request was open at the sink, and every span was delivered
    expect(target.peakConcurrent()).toBe(1)
    expect(counts).toEqual({exported: 30, dropped: 0})
    expect(target.accepted().length).toBeGreaterThanOrEqual(15)
  }, 15_000)
})

describe('what happens to the request at the cleanup deadline', () => {
  it('cancels a pending retry: after close returns, the destination gets nothing more, and the batch is counted dropped', async () => {
    // #given a destination that always answers 503, so the SDK keeps scheduling retries (about 1 s, then about 1.5 s)
    const target = await sink({respond: () => ({status: 503})})
    const exporter = exporterFor({
      url: target.url,
      limits: {...FAST, requestTimeoutMs: 20_000, maxConsecutiveFailures: 100},
    })
    exporter.export(span())

    // #when the deadline passes between the first retry and the second
    const counts = await exporter.close(1_400)
    const atClose = target.requests.length
    await sleep(3_500)

    // #then the batch was counted dropped, and no later request arrived (one that was merely abandoned would have retried)
    expect(counts).toEqual({exported: 0, dropped: 1})
    expect(atClose).toBeGreaterThanOrEqual(1)
    expect(target.requests.length).toBe(atClose)
  }, 20_000)

  it('cancels a request the destination never answers: its connection is closed from our side at the deadline', async () => {
    // #given a destination that accepts the connection and never answers
    const sockets: Socket[] = []
    let closedSockets = 0
    const stalled = createHttpServer(() => {})
    stalled.on('connection', socket => {
      sockets.push(socket)
      socket.on('close', () => {
        closedSockets += 1
      })
    })
    await new Promise<void>(resolve => stalled.listen(0, '127.0.0.1', resolve))
    const address = stalled.address() as {port: number}
    try {
      const exporter = exporterFor({
        url: `http://127.0.0.1:${address.port}/v1/traces`,
        limits: {...FAST, requestTimeoutMs: 20_000},
      })
      exporter.export(span())
      await sleep(300)
      expect(sockets).toHaveLength(1)

      // #when the deadline passes
      const counts = await exporter.close(300)
      await sleep(300)

      // #then the batch is counted dropped and our side closed the connection (without the cancel it stays open until the
      // 20 s request timeout)
      expect(counts).toEqual({exported: 0, dropped: 1})
      expect(closedSockets).toBe(1)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => stalled.close(() => resolve()))
    }
  }, 20_000)

  it('does not cancel anything that finished: a batch delivered before the deadline stays exported', async () => {
    // #given
    const target = await sink()
    const exporter = exporterFor({url: target.url})
    exporter.export(span())

    // #when
    const counts = await exporter.close(3_000)

    // #then
    expect(counts).toEqual({exported: 1, dropped: 0})
    expect(target.accepted()).toHaveLength(1)
  })
})

describe('certificate validation', () => {
  it.each([[undefined], ['0']])(
    'refuses an untrusted certificate and sends nothing, with NODE_TLS_REJECT_UNAUTHORIZED=%s, and counts the batch dropped',
    async setting => {
      // #given an https destination with a self-signed certificate, and the process-wide switch that turns validation off
      const target = await startTlsSink()
      if (target === undefined) return
      try {
        if (setting !== undefined) vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', setting)
        const exporter = exporterFor({url: target.url, headers: {authorization: 'Basic credential-never-sent'}})
        exporter.export(span())

        // #when the batch is exported
        const counts = await exporter.close(3_000)

        // #then no HTTP request reached the sink (so no body and no header), the handshake was refused, and the span is dropped
        expect(target.requests).toEqual([])
        expect(target.handshakes()).toBe(0)
        expect(counts).toEqual({exported: 0, dropped: 1})
      } finally {
        await target.stop()
      }
    },
    20_000,
  )
})

describe('redirects', () => {
  it.each([301, 302, 303, 307, 308])(
    'does not follow a %i: the request is not repeated anywhere else, and the batch counts as a final failure',
    async status => {
      // #given a destination that answers with a redirect to a second collector, and that second collector
      const elsewhere = await sink()
      const target = await sink({respond: () => ({status, headers: {location: elsewhere.url}})})
      const exporter = exporterFor({url: target.url, headers: {authorization: 'Basic credential-never-to-follow'}})
      exporter.export(span())
      exporter.export(span())

      // #when the batch is exported
      const counts = await exporter.close(3_000)

      // #then the redirect target heard nothing (so the credential never went there), the destination heard one request
      // (a redirect is neither retried nor followed), and both spans are counted dropped
      expect(elsewhere.requests).toHaveLength(0)
      expect(target.requests).toHaveLength(1)
      expect(target.requests[0]?.status).toBe(status)
      expect(counts).toEqual({exported: 0, dropped: 2})
    },
  )
})

describe('failure, overflow and shutdown', () => {
  it('stops trying after repeated connection failures and counts the rest as dropped', async () => {
    // #given a port nothing listens on (a sink that was stopped), and a short batch timeout
    const target = await startOtlpSink()
    const url = target.url
    await target.stop()
    const stopped = vi.fn()
    const exporter = exporterFor({
      url,
      onStopped: stopped,
      limits: {...FAST, requestTimeoutMs: 300, maxBatchSpans: 1, maxConsecutiveFailures: 3},
    })

    // #when spans keep arriving
    for (let index = 0; index < 3; index += 1) exporter.export(span())
    await vi.waitFor(() => {
      expect(stopped).toHaveBeenCalledOnce()
    })
    for (let index = 0; index < 5; index += 1) exporter.export(span())
    const counts = await exporter.close(1_000)

    // #then the circuit opened once, and every span is counted exactly once, none exported
    expect(stopped).toHaveBeenCalledOnce()
    expect(counts).toEqual({exported: 0, dropped: 8})
  }, 15_000)

  it('does not stop after one failed batch: the next one is delivered', async () => {
    // #given a sink that refuses the first batch with a final status, then accepts
    const target = await sink({respond: n => ({status: n === 1 ? 400 : 200})})
    const stopped = vi.fn()
    const exporter = exporterFor({url: target.url, onStopped: stopped, limits: {...FAST, maxBatchSpans: 1}})

    // #when
    exporter.export(span())
    await vi.waitFor(() => {
      expect(exporter.counts().dropped).toBe(1)
    })
    exporter.export(span())
    const counts = await exporter.close(2_000)

    // #then
    expect(stopped).not.toHaveBeenCalled()
    expect(counts).toEqual({exported: 1, dropped: 1})
  })

  it('drops and counts a span when the queue is full, and every span is counted exactly once', async () => {
    // #given a sink that holds the first batch, and a queue of three
    const target = await sink({respond: n => ({status: 200, delayMs: n === 1 ? 600 : 0})})
    const exporter = exporterFor({url: target.url, limits: {...FAST, maxQueueSpans: 3, maxBatchSpans: 1}})

    // #when the first span is in flight and ten more arrive
    exporter.export(span())
    await new Promise(resolve => setTimeout(resolve, 80))
    for (let index = 0; index < 10; index += 1) exporter.export(span())
    const counts = await exporter.close(6_000)

    // #then at most three of the ten were queued; the rest were dropped; nothing is lost from the books
    expect(counts.exported + counts.dropped).toBe(11)
    expect(counts.dropped).toBeGreaterThanOrEqual(7)
  }, 15_000)

  it('drops a span when the queue’s byte budget would be exceeded', async () => {
    // #given a byte budget that fits one large span
    const target = await sink({respond: () => ({status: 200, delayMs: 300})})
    const big = span({attributes: {'gen_ai.input.messages': 'x'.repeat(10_000)}})
    const exporter = exporterFor({
      url: target.url,
      limits: {...FAST, maxQueueBytes: estimateSpanBytes(big) + 100, maxBatchSpans: 1},
    })

    // #when the first goes in flight, then two large spans arrive
    exporter.export(span())
    await new Promise(resolve => setTimeout(resolve, 80))
    exporter.export(big)
    exporter.export(big)
    const counts = await exporter.close(4_000)

    // #then one was queued and one dropped
    expect(counts).toEqual({exported: 2, dropped: 1})
  }, 15_000)

  it('abandons what is still in flight at the shutdown bound, counts it dropped, and returns in time', async () => {
    // #given a sink that never answers in time
    const target = await sink({respond: () => ({status: 200, delayMs: 8_000})})
    const exporter = exporterFor({url: target.url, limits: {...FAST, maxBatchSpans: 2}})
    for (let index = 0; index < 5; index += 1) exporter.export(span())
    await new Promise(resolve => setTimeout(resolve, 100))

    // #when the exporter closes with a short bound
    const started = Date.now()
    const counts = await exporter.close(400)

    // #then it came back near the bound, and all five are dropped (two in flight, three queued)
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(counts).toEqual({exported: 0, dropped: 5})
  }, 15_000)

  it('counts a span exported after close as dropped, and never throws', async () => {
    // #given a closed exporter
    const target = await sink()
    const exporter = exporterFor({url: target.url})
    await exporter.close(100)

    // #when
    exporter.export(span())

    // #then
    expect(exporter.counts()).toEqual({exported: 0, dropped: 1})
  })

  it('counts a span it cannot encode as dropped and keeps going', async () => {
    // #given a span whose attributes throw when copied, and a well-formed one
    const target = await sink()
    const exporter = exporterFor({url: target.url})
    const circular: Record<string, string> = {}
    Object.defineProperty(circular, 'x', {
      get: () => {
        throw new Error('getter')
      },
      enumerable: true,
    })

    // #when a span that throws while it is copied is exported, then a good one
    exporter.export(span({attributes: circular}))
    exporter.export(span())
    const counts = await exporter.close(3_000)

    // #then the bad one is one drop and the good one is exported
    expect(counts).toEqual({exported: 1, dropped: 1})
  })

  it('does not leak the destination’s response body anywhere it can be logged', async () => {
    // #given a sink that echoes a secret-looking request body in an error response, and a log
    const lines: string[] = []
    const target = await sink({respond: (_n, request) => ({status: 400, body: request.text})})
    const exporter = exporterFor({
      url: target.url,
      onStopped: () => lines.push('stopped'),
      limits: {...FAST, maxConsecutiveFailures: 1},
    })
    exporter.export(span({attributes: {'gen_ai.tool.call.result': 'SECRET-ECHO-VALUE-12345'}}))

    // #when it fails and the exporter stops
    await vi.waitFor(() => {
      expect(lines).toEqual(['stopped'])
    })
    const counts = await exporter.close(500)

    // #then the only text the exporter surfaced is the fixed one
    expect(lines.join('')).not.toContain('SECRET-ECHO')
    expect(JSON.stringify(counts)).not.toContain('SECRET-ECHO')
  })

  it('exposes the defaults it is documented to have', () => {
    // #given / #when / #then
    expect(DEFAULT_EXPORTER_LIMITS).toMatchObject({
      maxQueueSpans: 512,
      maxBatchSpans: 32,
      batchIntervalMs: 1_000,
      requestTimeoutMs: 10_000,
      maxConsecutiveFailures: 3,
    })
    // The batch timeout stays above the relay's 8 s upstream timeout, so the plugin never re-sends a forward in progress.
    expect(DEFAULT_EXPORTER_LIMITS.requestTimeoutMs).toBeGreaterThan(8_000)
  })
})
