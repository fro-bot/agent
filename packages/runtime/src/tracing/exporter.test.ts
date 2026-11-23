import type {Socket} from 'node:net'
import type {SpanExporter, SpanExporterOptions} from './exporter.js'
import type {ScrubbedSpan} from './scrub.js'
import {Buffer} from 'node:buffer'
import {createServer as createHttpServer} from 'node:http'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  COLLECTOR_BODY_LIMIT_BYTES,
  createSpanExporter,
  DEFAULT_EXPORTER_LIMITS,
  formatCountsHeader,
  SDK_SPAN_LIMITS,
  TRACE_COUNTS_HEADER,
} from './exporter.js'
import {opensslAvailable, startOtlpSink, startTlsSink, type OtlpSink, type SinkRequest} from './otlp-sink.testing.js'
import {scrubbedBrand} from './scrub.js'

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
  readonly links?: {traceId: string; spanId: string; attributes?: {key: string; value: Record<string, unknown>}[]}[]
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
  const made = createSpanExporter({
    serviceName: 'fro-bot-opencode-plugin',
    headers: {},
    reportCounts: false,
    limits: FAST,
    ...options,
  })
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

  it('serializes a span’s links with hex trace and span ids, and its attributes', async () => {
    // #given a span that links to a span in another trace
    const target = await sink()
    const exporter = exporterFor({url: target.url})
    const linked = {traceId: hex(0xdef, 32), spanId: hex(0x42, 16), attributes: {'fro_bot.link.kind': 'run'}}
    exporter.export(span({links: [linked]}))
    exporter.export(span())

    // #when it is received
    await exporter.close(3_000)

    // #then the link carries the ids as lowercase hex, the way OTLP JSON writes them, and its attribute
    const [request] = target.accepted()
    const [withLink, without] = spansOf(request as SinkRequest)
    expect(withLink?.links).toHaveLength(1)
    const [link] = withLink?.links ?? []
    expect(link?.traceId).toBe(hex(0xdef, 32))
    expect(link?.spanId).toBe(hex(0x42, 16))
    expect(link?.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(link?.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(link?.attributes).toEqual([{key: 'fro_bot.link.kind', value: {stringValue: 'run'}}])
    // #and a span without links carries none
    expect(without?.links ?? []).toEqual([])
  })

  it('names the sender with the service name it was given, on the resource and the scope', async () => {
    // #given an exporter for another sender
    const target = await sink()
    const exporter = exporterFor({url: target.url, serviceName: 'fro-bot-action'})
    exporter.export(span())

    // #when it is received
    await exporter.close(3_000)

    // #then
    const body = (target.accepted()[0] as SinkRequest).body as {
      resourceSpans: {
        resource: {attributes: {key: string; value: {stringValue?: string}}[]}
        scopeSpans: {scope: {name: string}}[]
      }[]
    }
    expect(body.resourceSpans[0]?.resource.attributes).toEqual([
      {key: 'service.name', value: {stringValue: 'fro-bot-action'}},
    ])
    expect(body.resourceSpans[0]?.scopeSpans[0]?.scope.name).toBe('fro-bot-action')
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
  // Skipped, by name, only when `openssl` is not installed; any other failure making the certificate fails the test.
  it.skipIf(!opensslAvailable()).each([[undefined], ['0']])(
    'refuses an untrusted certificate and sends nothing, with NODE_TLS_REJECT_UNAUTHORIZED=%s, and counts the batch dropped',
    async setting => {
      // #given an https destination with a self-signed certificate, and the process-wide switch that turns validation off
      const target = await startTlsSink()
      try {
        if (setting !== undefined) vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', setting)
        const exporter = exporterFor({url: target.url, headers: {authorization: 'Basic credential-never-sent'}})
        exporter.export(span())

        // #when the batch is exported
        const counts = await exporter.close(3_000)

        // #then the exporter really reached the sink over TCP and began TLS, and the client refused it: a connection and a failed
        // handshake, no completed one, no HTTP request (so no body and no header), and the span is counted dropped
        expect(target.connections()).toBeGreaterThanOrEqual(1)
        // The server learns of the client's refusal a moment after the exporter has given up on the batch.
        await vi.waitFor(() => expect(target.tlsErrors()).toBeGreaterThanOrEqual(1), {timeout: 3_000})
        expect(target.handshakes()).toBe(0)
        expect(target.requests).toEqual([])
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
    // #given a byte budget that fits one large span (its encoded size, plus a little)
    const target = await sink({respond: () => ({status: 200, delayMs: 300})})
    const big = span({attributes: {'gen_ai.input.messages': 'x'.repeat(10_000)}})
    const exporter = exporterFor({
      url: target.url,
      limits: {...FAST, maxQueueBytes: 10_700, maxBatchSpans: 1},
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

  it('counts the queue in encoded bytes: escaped text that is short in characters overflows it', async () => {
    // #given a byte budget that holds one span of 2,000 control characters (12 KB encoded) but not two, though the two together are
    // only 4,000 characters: an accounting by characters would fit both
    const target = await sink({respond: () => ({status: 200, delayMs: 300})})
    const escaped = (): ScrubbedSpan => span({attributes: {'gen_ai.input.messages': '\u0001'.repeat(2_000)}})
    const exporter = exporterFor({url: target.url, limits: {...FAST, maxQueueBytes: 13_500, maxBatchSpans: 1}})

    // #when the first span goes in flight and two more arrive
    exporter.export(span())
    await new Promise(resolve => setTimeout(resolve, 80))
    exporter.export(escaped())
    exporter.export(escaped())
    const counts = await exporter.close(4_000)

    // #then one was queued and one dropped
    expect(counts).toEqual({exported: 2, dropped: 1})
  }, 15_000)

  it('counts multi-byte text in encoded bytes too', async () => {
    // #given a budget for one 3,000-character CJK span (9 KB encoded), and a third span that does not fit beside it
    const target = await sink({respond: () => ({status: 200, delayMs: 300})})
    const cjk = (): ScrubbedSpan => span({attributes: {'gen_ai.input.messages': '漢'.repeat(3_000)}})
    const exporter = exporterFor({url: target.url, limits: {...FAST, maxQueueBytes: 10_000, maxBatchSpans: 1}})

    // #when
    exporter.export(span())
    await new Promise(resolve => setTimeout(resolve, 80))
    exporter.export(cjk())
    exporter.export(cjk())
    const counts = await exporter.close(4_000)

    // #then
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

describe('every queued batch is sent, one at a time, in order', () => {
  const BATCH = DEFAULT_EXPORTER_LIMITS.maxBatchSpans

  /**
   * Waits until every span is counted, the way a running turn does (the exporter is NOT closed: the loop that sends the
   * queue on its own is what is under test, not the drain at shutdown).
   */
  const settled = async (exporter: SpanExporter, total: number): Promise<void> => {
    await vi.waitFor(
      () => {
        const {exported, dropped} = exporter.counts()
        expect(exported + dropped).toBe(total)
      },
      {timeout: 20_000, interval: 10},
    )
  }

  /** The span ids received, request by request, flattened: the order the collector saw them in. */
  const received = (target: OtlpSink): string[] =>
    target.accepted().flatMap(request => spansOf(request).map(item => item.spanId))

  it.each([
    ['3 full batches', 3, 0],
    ['4 full batches', 4, 0],
    ['10 full batches', 10, 0],
    ['3 full batches against a slow collector (200 ms a request)', 3, 200],
    ['4 full batches against a slow collector (200 ms a request)', 4, 200],
  ])(
    'delivers %s once each, in order, with nothing dropped',
    async (_label, batches, delayMs) => {
      // #given a collector (fast, or slow) and an exporter that has `batches` full batches queued behind one another
      const target = await sink({respond: () => ({status: 200, ...(delayMs === 0 ? {} : {delayMs})})})
      const exporter = exporterFor({url: target.url, limits: {...FAST, requestTimeoutMs: 8_000}})
      const spans = Array.from({length: batches * BATCH}, () => span())

      // #when they are all exported in the same tick, and the exporter sends them on its own
      for (const item of spans) exporter.export(item)
      await settled(exporter, batches * BATCH)

      // #then every span was delivered exactly once, in the order it was exported, in `batches` requests, one in flight at a time
      expect(exporter.counts()).toEqual({exported: batches * BATCH, dropped: 0})
      expect(target.accepted()).toHaveLength(batches)
      expect(received(target)).toEqual(spans.map(item => item.spanId))
      expect(target.peakConcurrent()).toBe(1)
    },
    30_000,
  )

  it('delivers batches that queue up while an earlier one is in flight, without a drain', async () => {
    // #given a slow collector and 100 spans (three full batches and a part)
    const target = await sink({respond: () => ({status: 200, delayMs: 60})})
    const exporter = exporterFor({url: target.url})
    const spans = Array.from({length: 100}, () => span())

    // #when they are exported and the exporter is left to send on its own
    for (const item of spans) exporter.export(item)
    await vi.waitFor(
      () => {
        expect(exporter.counts().exported).toBe(100)
      },
      {timeout: 10_000},
    )

    // #then all of them arrived, in order, with nothing dropped
    expect(exporter.counts()).toEqual({exported: 100, dropped: 0})
    expect(received(target)).toEqual(spans.map(item => item.spanId))
  }, 20_000)

  it('counts only the batch that failed when later batches are queued behind it, and sends the rest', async () => {
    // #given a collector that refuses the first batch for good (422) and takes the rest, with four full batches queued
    const target = await sink({respond: n => ({status: n === 1 ? 422 : 200})})
    const exporter = exporterFor({url: target.url})
    const spans = Array.from({length: 4 * BATCH}, () => span())

    // #when
    for (const item of spans) exporter.export(item)
    await settled(exporter, 4 * BATCH)

    // #then exactly the first batch is dropped; the three behind it are delivered, in order
    expect(exporter.counts()).toEqual({exported: 3 * BATCH, dropped: BATCH})
    expect(target.received()).toBe(4)
    expect(received(target)).toEqual(spans.slice(BATCH).map(item => item.spanId))
  }, 20_000)

  it('sends the batches queued behind one that timed out', async () => {
    // #given a collector that holds the first request past the request timeout, then answers normally
    const target = await sink({respond: n => (n === 1 ? {status: 200, hold: true} : {status: 200})})
    const exporter = exporterFor({url: target.url, limits: {...FAST, requestTimeoutMs: 300}})
    const spans = Array.from({length: 3 * BATCH}, () => span())

    // #when
    for (const item of spans) exporter.export(item)
    await settled(exporter, 3 * BATCH)

    // #then the timed-out batch is the only one dropped, and the two behind it are delivered in order
    expect(exporter.counts()).toEqual({exported: 2 * BATCH, dropped: BATCH})
    expect(received(target)).toEqual(spans.slice(BATCH).map(item => item.spanId))
  }, 20_000)

  it('flushes several queued batches inside a drain bound', async () => {
    // #given five full batches queued and a fast collector
    const target = await sink()
    const exporter = exporterFor({url: target.url})
    const spans = Array.from({length: 5 * BATCH}, () => span())
    for (const item of spans) exporter.export(item)

    // #when the final flush is given one second, the pipeline's drain bound
    const started = Date.now()
    const counts = await exporter.close(1_000)
    const elapsed = Date.now() - started

    // #then every span went inside the bound
    expect(counts).toEqual({exported: 5 * BATCH, dropped: 0})
    expect(elapsed).toBeLessThan(1_000)
  })

  it('counts what a drain bound cuts off as dropped, once, and sends the batches it reached in order', async () => {
    // #given ten full batches and a collector that takes 250 ms a request, with a 1 s bound
    const target = await sink({respond: () => ({status: 200, delayMs: 250})})
    const exporter = exporterFor({url: target.url})
    const spans = Array.from({length: 10 * BATCH}, () => span())
    for (const item of spans) exporter.export(item)

    // #when
    const counts = await exporter.close(1_000)

    // #then every span is counted exactly once, the batches that got through are the first ones in order, and the rest are dropped
    expect(counts.exported + counts.dropped).toBe(10 * BATCH)
    expect(counts.exported).toBeGreaterThanOrEqual(2 * BATCH)
    expect(counts.dropped).toBeGreaterThan(0)
    expect(received(target)).toEqual(spans.slice(0, received(target).length).map(item => item.spanId))
  }, 10_000)

  it('stops after consecutive failures and counts everything queued behind them as dropped, once each', async () => {
    // #given a collector that refuses every batch, a circuit of three, and six full batches queued
    const target = await sink({respond: () => ({status: 422})})
    const exporter = exporterFor({url: target.url, limits: {...FAST, maxConsecutiveFailures: 3}})
    for (let index = 0; index < 6 * BATCH; index += 1) exporter.export(span())

    // #when
    await settled(exporter, 6 * BATCH)

    // #then three batches were tried, the circuit opened, and all 6 x 32 spans are counted dropped exactly once
    expect(exporter.counts()).toEqual({exported: 0, dropped: 6 * BATCH})
    expect(target.received()).toBe(3)
  }, 20_000)

  it('reports the running totals in the counts header on each of the batches', async () => {
    // #given an Action-mode exporter and three full batches
    const target = await sink()
    const exporter = exporterFor({url: target.url, reportCounts: true})
    for (let index = 0; index < 3 * BATCH; index += 1) exporter.export(span())

    // #when
    await settled(exporter, 3 * BATCH)

    // #then the header on request n carries what the exporter had counted before it was sent
    expect(target.accepted().map(request => request.headers[TRACE_COUNTS_HEADER])).toEqual([
      'exported=0;dropped=0',
      `exported=${BATCH};dropped=0`,
      `exported=${2 * BATCH};dropped=0`,
    ])
  }, 20_000)
})

describe('a request never exceeds the collector’s body limit', () => {
  const LIMIT = DEFAULT_EXPORTER_LIMITS.maxBatchBytes
  const bytesOf = (request: SinkRequest): number => Buffer.byteLength(request.text, 'utf8')
  /** Text that is legal but far larger encoded than it looks: every character costs two to six bytes on the wire. */
  const ADVERSARIAL: readonly [string, (n: number) => string][] = [
    ['CJK (3 bytes a character)', n => '漢'.repeat(n)],
    ['emoji (4 bytes, two UTF-16 units)', n => '😀'.repeat(n / 2)],
    ['quotes (escaped, 2 bytes)', n => '"'.repeat(n)],
    ['backslashes (escaped, 2 bytes)', n => '\\'.repeat(n)],
    [String.raw`control characters (\u0001, 6 bytes)`, n => '\u0001'.repeat(n)],
    [String.raw`NUL (\u0000, 6 bytes)`, n => '\u0000'.repeat(n)],
    ['lone surrogates (6 bytes)', n => '\uD800'.repeat(n)],
    ['U+2028 (3 bytes)', n => '\u2028'.repeat(n)],
    ['JSON inside a string', n => JSON.stringify({a: ['"x"', String.raw`\y`], b: 'c'}).repeat(n / 30)],
  ]

  it('pins the limit under the collector’s refusal threshold, with headroom, and under the relay’s own cap', () => {
    // #given the front proxy refuses a body over 4.5 MiB with a final 413
    // #then the plugin's limit leaves at least half a mebibyte of headroom, and the relay accepts at least that much
    expect(COLLECTOR_BODY_LIMIT_BYTES).toBe(4_718_592)
    expect(LIMIT).toBe(4_000_000)
    expect(LIMIT).toBeLessThanOrEqual(COLLECTOR_BODY_LIMIT_BYTES - 512 * 1024)
  })

  it.each(ADVERSARIAL)(
    'keeps every body under the limit for %s, and delivers every span',
    async (_label, make) => {
      // #given 24 spans of 100,000 characters each of the nasty text (up to 600 KB encoded each: seven or more would pass the limit)
      const target = await sink()
      const exporter = exporterFor({url: target.url, limits: {...FAST, requestTimeoutMs: 20_000}})
      const spans = Array.from({length: 24}, () => span({attributes: {'gen_ai.output.messages': make(100_000)}}))

      // #when
      for (const item of spans) exporter.export(item)
      await vi.waitFor(
        () => {
          const {exported, dropped} = exporter.counts()
          expect(exported + dropped).toBe(spans.length)
        },
        {timeout: 30_000, interval: 20},
      )

      // #then every request is within the limit, nothing was lost, and the requests are well filled (not one span a request)
      expect(exporter.counts()).toEqual({exported: spans.length, dropped: 0})
      const bodies = target.accepted().map(bytesOf)
      expect(Math.max(...bodies)).toBeLessThanOrEqual(LIMIT)
      const received = target.accepted().flatMap(request => spansOf(request))
      expect(received).toHaveLength(spans.length)
    },
    60_000,
  )

  it('counts the size exactly: a limit equal to a batch’s encoded size takes the batch, one byte less does not', async () => {
    // #given the encoded size of a request of three spans of mixed nasty text
    const mixed = (): ScrubbedSpan[] => [
      span({attributes: {'gen_ai.output.messages': '漢'.repeat(3_000)}}),
      span({attributes: {'gen_ai.output.messages': '\u0001'.repeat(2_000), 'gen_ai.tool.name': String.raw`a"b\c`}}),
      span({
        attributes: {'gen_ai.input.messages': '😀'.repeat(1_500)},
        events: [{name: 'exception', timeMs: 1_700_000_000_100, attributes: {'exception.message': '\n\t"'}}],
      }),
    ]
    const measure = await sink()
    const measuring = exporterFor({url: measure.url, limits: {...FAST, maxBatchSpans: 3, maxBatchBytes: 50_000_000}})
    for (const item of mixed()) measuring.export(item)
    await measuring.close(5_000)
    const exact = bytesOf(measure.accepted()[0] as SinkRequest)
    expect(spansOf(measure.accepted()[0] as SinkRequest)).toHaveLength(3)

    // #when exporters are limited to exactly that many bytes, and to one fewer
    const atLimit = await sink()
    const atExporter = exporterFor({url: atLimit.url, limits: {...FAST, maxBatchSpans: 3, maxBatchBytes: exact}})
    for (const item of mixed()) atExporter.export(item)
    await atExporter.close(5_000)
    const under = await sink()
    const underExporter = exporterFor({url: under.url, limits: {...FAST, maxBatchSpans: 3, maxBatchBytes: exact - 1}})
    for (const item of mixed()) underExporter.export(item)
    await underExporter.close(5_000)

    // #then the first sends one request of exactly that size; the second needs two, neither over the limit
    expect(atLimit.accepted().map(bytesOf)).toEqual([exact])
    expect(under.accepted()).toHaveLength(2)
    expect(Math.max(...under.accepted().map(bytesOf))).toBeLessThanOrEqual(exact - 1)
  })

  it('sends a span that is too large on its own with its content omitted and marked, and still counts it exported', async () => {
    // #given one span whose encoded size is over the limit by itself (800,000 control characters, about 4.8 MB), and an ordinary one
    const target = await sink()
    const exporter = exporterFor({url: target.url, limits: {...FAST, requestTimeoutMs: 20_000}})
    const huge = span({
      attributes: {
        'gen_ai.output.messages': '\u0001'.repeat(800_000),
        'gen_ai.tool.name': 'read',
        'fro_bot.outcome': 'ok',
      },
    })

    // #when
    exporter.export(huge)
    exporter.export(span())
    const counts = await exporter.close(15_000)

    // #then both arrived, the big one without its content, its other attributes and an omission marker intact, all under the limit
    expect(counts).toEqual({exported: 2, dropped: 0})
    expect(Math.max(...target.accepted().map(bytesOf))).toBeLessThanOrEqual(LIMIT)
    const [first] = target.accepted().flatMap(request => spansOf(request))
    expect(attr(first as Decoded, 'gen_ai.output.messages')).toBeUndefined()
    expect(attr(first as Decoded, 'gen_ai.tool.name')).toBe('read')
    expect(JSON.stringify(attr(first as Decoded, 'fro_bot.content.omitted'))).toContain(
      'gen_ai.output.messages:span-too-large',
    )
  }, 30_000)

  it('omits the content attribute that costs the most on the wire, not the metadata that is longest in characters', async () => {
    // #given a span over the limit whose longest attribute by characters is metadata (800,000 plain characters, 800 KB encoded), and
    // whose costliest is content: 700,000 control characters are 4.2 MB encoded (six bytes each) in fewer characters
    const target = await sink()
    const exporter = exporterFor({url: target.url, limits: {...FAST, requestTimeoutMs: 20_000}})
    exporter.export(
      span({
        attributes: {
          'fro_bot.note': 'm'.repeat(800_000),
          'gen_ai.output.messages': '\u0001'.repeat(700_000),
          'gen_ai.tool.name': 'read',
        },
      }),
    )

    // #when
    const counts = await exporter.close(15_000)

    // #then the content went, the metadata stayed whole, and the marker names only the content
    expect(counts).toEqual({exported: 1, dropped: 0})
    const [sent] = target.accepted().flatMap(request => spansOf(request))
    expect(attr(sent as Decoded, 'gen_ai.output.messages')).toBeUndefined()
    expect(String(attr(sent as Decoded, 'fro_bot.note'))).toHaveLength(800_000)
    expect(attr(sent as Decoded, 'gen_ai.tool.name')).toBe('read')
    expect(JSON.stringify(attr(sent as Decoded, 'fro_bot.content.omitted'))).toContain(
      'gen_ai.output.messages:span-too-large',
    )
    expect(Math.max(...target.accepted().map(bytesOf))).toBeLessThanOrEqual(LIMIT)
  }, 30_000)

  it('drops, and counts, a span that is too large because of an attribute that is not content', async () => {
    // #given a span over the limit whose size is all metadata, and an ordinary span
    const target = await sink()
    const exporter = exporterFor({url: target.url, limits: {...FAST, requestTimeoutMs: 20_000}})
    exporter.export(span({attributes: {'fro_bot.note': '\u0001'.repeat(700_000), 'gen_ai.tool.name': 'read'}}))
    exporter.export(span())

    // #when
    const counts = await exporter.close(10_000)

    // #then nothing was taken out of it, it was never sent, and it is counted
    expect(counts).toEqual({exported: 1, dropped: 1})
    expect(target.received()).toBe(1)
  }, 30_000)

  it('drops, and counts, a span that is too large with nothing left to omit', async () => {
    // #given a span whose NAME is over the limit (a name is not content the exporter can omit), and an ordinary span
    const target = await sink()
    const exporter = exporterFor({url: target.url, limits: {...FAST, requestTimeoutMs: 20_000}})
    exporter.export(span({name: 'x'.repeat(4_100_000)}))
    exporter.export(span())

    // #when
    const counts = await exporter.close(10_000)

    // #then the oversized one is counted dropped and never sent (no 413), and the ordinary one arrived
    expect(counts).toEqual({exported: 1, dropped: 1})
    expect(target.received()).toBe(1)
  }, 30_000)

  it('fills a request close to the limit with ordinary spans', async () => {
    // #given 120 spans of about 100 KB of plain text each (12 MB in all), and a batch size that does not get in the way
    const target = await sink()
    const exporter = exporterFor({
      url: target.url,
      limits: {...FAST, requestTimeoutMs: 20_000, maxQueueSpans: 1_000, maxBatchSpans: 200},
    })
    for (let index = 0; index < 120; index += 1)
      exporter.export(span({attributes: {'gen_ai.input.messages': 'a'.repeat(100_000)}}))

    // #when
    const counts = await exporter.close(20_000)

    // #then every request but the last is within one span of the limit, so batching is not given up
    expect(counts).toEqual({exported: 120, dropped: 0})
    const bodies = target.accepted().map(bytesOf)
    for (const body of bodies.slice(0, -1)) {
      expect(body).toBeGreaterThan(LIMIT - 110_000)
      expect(body).toBeLessThanOrEqual(LIMIT)
    }
  }, 40_000)
})

describe('a collector that keeps the socket active past the watchdog', () => {
  interface Trickler {
    readonly url: string
    readonly requests: () => number
    readonly stop: () => Promise<void>
  }

  /**
   * A collector whose response to a chosen request never ends and never goes idle: the headers are sent at once and a byte of
   * body follows every 20 ms, so the SDK's request timeout (an IDLE timeout on the socket) never fires. The other requests are
   * answered 200 at once. Sockets are destroyed at stop, so no timer outlives the test.
   */
  async function trickler(stalls: (index: number) => boolean): Promise<Trickler> {
    const sockets = new Set<Socket>()
    const timers = new Set<NodeJS.Timeout>()
    let count = 0
    const server = createHttpServer((req, res) => {
      const index = count
      count += 1
      req.resume()
      req.on('end', () => {
        if (!stalls(index)) {
          res.writeHead(200, {'content-type': 'application/json'})
          res.end('{}')
          return
        }
        res.writeHead(200, {'content-type': 'application/json'})
        res.write('{')
        const tick = setInterval(() => {
          if (!res.destroyed) res.write(' ')
        }, 20)
        timers.add(tick)
        res.on('close', () => clearInterval(tick))
      })
    })
    server.on('connection', socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const {port} = server.address() as {port: number}
    return {
      url: `http://127.0.0.1:${port}/v1/traces`,
      requests: () => count,
      stop: async () => {
        for (const timer of timers) clearInterval(timer)
        for (const socket of sockets) socket.destroy()
        await new Promise<void>(resolve => server.close(() => resolve()))
      },
    }
  }

  const WATCHDOG_LIMITS = {batchIntervalMs: 10, requestTimeoutMs: 400, maxConsecutiveFailures: 3, maxBatchSpans: 2}
  /** The watchdog is the request timeout plus two seconds. */
  const WATCHDOG_MS = WATCHDOG_LIMITS.requestTimeoutMs + 2_000

  it('sends the batches queued behind it once the watchdog cancels it, and counts every span exactly once', async () => {
    // #given the first batch's response trickles forever and nine more spans queue behind it
    const target = await trickler(index => index === 0)
    try {
      const exporter = exporterFor({url: target.url, limits: WATCHDOG_LIMITS})
      const total = 11
      const started = Date.now()

      // #when
      for (let index = 0; index < total; index += 1) exporter.export(span())
      await vi.waitFor(
        () => {
          const {exported, dropped} = exporter.counts()
          expect(exported + dropped).toBe(total)
        },
        {timeout: WATCHDOG_MS + 5_000, interval: 25},
      )

      // #then the stalled batch (two spans) is the only loss, every later batch was delivered, and it took the watchdog plus a little
      expect(exporter.counts()).toEqual({exported: total - 2, dropped: 2})
      expect(Date.now() - started).toBeLessThan(WATCHDOG_MS + 3_000)
      expect(target.requests()).toBe(1 + Math.ceil((total - 2) / 2))
      const closing = Date.now()
      expect(await exporter.close(2_000)).toEqual({exported: total - 2, dropped: 2})
      expect(Date.now() - closing).toBeLessThan(1_000)
    } finally {
      await target.stop()
    }
  }, 30_000)

  it('stops within its bound, with every span counted once, when shutdown arrives mid-stall', async () => {
    // #given a first batch that trickles forever, with more spans queued behind it
    const target = await trickler(() => true)
    try {
      const exporter = exporterFor({url: target.url, limits: WATCHDOG_LIMITS})
      const total = 7
      for (let index = 0; index < total; index += 1) exporter.export(span())
      await vi.waitFor(() => expect(target.requests()).toBe(1), {timeout: 3_000, interval: 10})
      await sleep(100)

      // #when shutdown arrives while the request is active, well before the watchdog
      const closing = Date.now()
      const counts = await exporter.close(600)

      // #then it returns in its bound, and nothing is counted twice or lost
      expect(Date.now() - closing).toBeLessThan(1_500)
      expect(counts.exported + counts.dropped).toBe(total)
      expect(counts).toEqual({exported: 0, dropped: total})
    } finally {
      await target.stop()
    }
  }, 30_000)

  it('trips the breaker and counts everything queued when every request stalls, without waiting on any of them', async () => {
    // #given a collector that stalls every request
    const target = await trickler(() => true)
    try {
      const stopped = vi.fn()
      const exporter = exporterFor({url: target.url, limits: WATCHDOG_LIMITS, onStopped: stopped})
      const total = 20
      const started = Date.now()

      // #when
      for (let index = 0; index < total; index += 1) exporter.export(span())
      await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1), {timeout: 3 * WATCHDOG_MS + 8_000, interval: 50})

      // #then three watchdogs and three cancels (bounded), and the rest counted dropped in one go: every span counted once
      expect(Date.now() - started).toBeLessThan(3 * WATCHDOG_MS + 6_000)
      expect(exporter.counts()).toEqual({exported: 0, dropped: total})
      expect(target.requests()).toBe(3)
      expect(await exporter.close(500)).toEqual({exported: 0, dropped: total})
    } finally {
      await target.stop()
    }
  }, 60_000)

  it('gives up on a transport that will not let go: trips the breaker, counts the queue, and never counts a span twice', async () => {
    // #given a request that cannot be cancelled (its socket survives the cancel) and spans queued behind it
    const target = await trickler(() => true)
    try {
      const stopped = vi.fn()
      const exporter = exporterFor({
        url: target.url,
        limits: {...WATCHDOG_LIMITS, maxConsecutiveFailures: 50},
        onStopped: stopped,
        testing: {ignoreAgentDestroy: true},
      })
      const total = 9
      const started = Date.now()
      for (let index = 0; index < total; index += 1) exporter.export(span())

      // #when the watchdog fires, then the drain grace (one second) passes
      await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1), {timeout: WATCHDOG_MS + 4_000, interval: 25})

      // #then it stopped in the watchdog plus the grace, everything is counted dropped once, and only one request was ever made
      expect(Date.now() - started).toBeLessThan(WATCHDOG_MS + 3_500)
      expect(exporter.counts()).toEqual({exported: 0, dropped: total})
      expect(target.requests()).toBe(1)
      expect(await exporter.close(500)).toEqual({exported: 0, dropped: total})
    } finally {
      await target.stop()
    }
  }, 30_000)

  it('does not count the stalled batch again when shutdown arrives while the delegate has not yet let go of it', async () => {
    // #given a request that cannot be cancelled, so after the watchdog its batch is counted but its slot is still held
    const target = await trickler(() => true)
    try {
      const exporter = exporterFor({
        url: target.url,
        limits: {...WATCHDOG_LIMITS, maxConsecutiveFailures: 50},
        testing: {ignoreAgentDestroy: true},
      })
      const total = 6
      for (let index = 0; index < total; index += 1) exporter.export(span())
      await vi.waitFor(() => expect(exporter.counts().dropped).toBe(2), {timeout: WATCHDOG_MS + 3_000, interval: 10})

      // #when shutdown arrives in that window
      const counts = await exporter.close(500)

      // #then the stalled batch (two spans) is counted once and the four queued behind it once: six in all, not eight
      expect(counts).toEqual({exported: 0, dropped: total})
    } finally {
      await target.stop()
    }
  }, 30_000)

  it('does not announce a stop after shutdown has finished, when the grace period for an uncancellable request ends later', async () => {
    // #given a request that cannot be cancelled, whose watchdog has fired (its batch counted, the grace period running)
    const target = await trickler(() => true)
    try {
      const stopped = vi.fn()
      const exporter = exporterFor({
        url: target.url,
        limits: {...WATCHDOG_LIMITS, maxConsecutiveFailures: 50},
        onStopped: stopped,
        testing: {ignoreAgentDestroy: true},
      })
      const total = 4
      for (let index = 0; index < total; index += 1) exporter.export(span())
      await vi.waitFor(() => expect(exporter.counts().dropped).toBe(2), {timeout: WATCHDOG_MS + 3_000, interval: 10})

      // #when shutdown finishes inside the grace period, and the grace period then runs out
      const counts = await exporter.close(300)
      await sleep(1_500)

      // #then shutdown's own cancellation stands: no stop is announced after close() has returned, and no count moved
      expect(counts).toEqual({exported: 0, dropped: total})
      expect(stopped).not.toHaveBeenCalled()
      expect(exporter.counts()).toEqual({exported: 0, dropped: total})
    } finally {
      await target.stop()
    }
  }, 30_000)

  it('counts a span dropped once when shutdown arrives after the watchdog already counted its batch', async () => {
    // #given the first batch stalls past the watchdog while later ones succeed
    const target = await trickler(index => index === 0)
    try {
      const exporter = exporterFor({url: target.url, limits: WATCHDOG_LIMITS})
      for (let index = 0; index < 4; index += 1) exporter.export(span())
      await vi.waitFor(() => expect(exporter.counts().dropped).toBe(2), {timeout: WATCHDOG_MS + 3_000, interval: 25})

      // #when shutdown comes straight after, with the rest possibly in flight
      const counts = await exporter.close(2_000)

      // #then the stalled batch is not counted again
      expect(counts.exported + counts.dropped).toBe(4)
      expect(counts.dropped).toBe(2)
    } finally {
      await target.stop()
    }
  }, 30_000)
})
