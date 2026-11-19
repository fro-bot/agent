/**
 * The span exporter: scrubbed spans in, OTLP/HTTP JSON out, with explicit configuration and exact counts.
 *
 * Built on the OpenTelemetry SDK's own pieces, constructed by hand: a tracer provider with a hand-built resource and no
 * detectors (so no process arguments or host data), explicit span limits, an id generator that hands out the ids the turn
 * model already chose, and the SDK's HTTP export delegate. It reads no `OTEL_*` variable and sets no global provider. The
 * `OTLPTraceExporter` class is not used: it merges `OTEL_EXPORTER_OTLP_HEADERS` into the headers it is given.
 *
 * The queue and the batch loop are this module's, not the SDK's batch processor, because the counts matter: the SDK's
 * processor drops silently when full. Here every span ends up counted exactly once, as exported (its batch was accepted)
 * or dropped (queue overflow, a failed batch, the circuit open, or abandoned at shutdown).
 *
 * What the SDK's delegate does with a response (read from `@opentelemetry/otlp-exporter-base` 0.219.0, and pinned by
 * `exporter.test.ts`): status up to 299 is success; 429, 502, 503 and 504 and these network errors (ECONNRESET,
 * ECONNREFUSED, EPIPE, ETIMEDOUT, EAI_AGAIN, ENOTFOUND, ENETUNREACH, EHOSTUNREACH) are retried with backoff (1 s growing
 * by 1.5, at most five retries) until the per-batch timeout; every other status is final. The relay's `503` is therefore a
 * retry and its `422` a drop. One batch is in flight at a time, far under the relay's refusal threshold of eight.
 */

import type {ReadableSpan, SpanProcessor} from '@opentelemetry/sdk-trace-base'
import type {ScrubbedSpan} from './content.js'

import {ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, TraceFlags} from '@opentelemetry/api'
import {OTLPExporterBase} from '@opentelemetry/otlp-exporter-base'
import {createOtlpHttpExportDelegate, httpAgentFactoryFromOptions} from '@opentelemetry/otlp-exporter-base/node-http'
import {JsonTraceSerializer} from '@opentelemetry/otlp-transformer'
import {resourceFromAttributes} from '@opentelemetry/resources'
import {AlwaysOnSampler, BasicTracerProvider} from '@opentelemetry/sdk-trace-base'

/**
 * The request header that carries the plugin's running totals to the Action's relay, in Action mode only.
 * MIRRORS `TRACE_RELAY_COUNTS_HEADER` and `formatTraceRelayCountsHeader` in `packages/runtime/src/agent/trace-relay-wire.ts`,
 * which is the source of truth: this package may not import the runtime at run time. The form is exactly
 * `exported=<n>;dropped=<n>`, each `n` one to twelve ASCII digits.
 */
export const TRACE_COUNTS_HEADER = 'x-frobot-trace-counts'

/** Largest total the header can carry: twelve digits. Beyond it a count saturates rather than break the form. */
const MAX_COUNT = 999_999_999_999

export interface SpanCounts {
  readonly exported: number
  readonly dropped: number
}

/** The header value for `counts`. */
export function formatCountsHeader(counts: SpanCounts): string {
  return `exported=${Math.min(counts.exported, MAX_COUNT)};dropped=${Math.min(counts.dropped, MAX_COUNT)}`
}

export interface ExporterLimits {
  /** Spans waiting for export. A span past this is dropped and counted. */
  readonly maxQueueSpans: number
  /** Estimated bytes waiting for export. */
  readonly maxQueueBytes: number
  readonly maxBatchSpans: number
  /** Estimated bytes in one batch. A single span over it goes alone. */
  readonly maxBatchBytes: number
  /** From the first queued span to its batch. Short, so a trace is visible soon after the turn. */
  readonly batchIntervalMs: number
  /**
   * One batch, retries included. Above the relay's own upstream timeout (8 s) so the plugin never gives up on a forward
   * the relay is still making, which would send the same batch twice.
   */
  readonly requestTimeoutMs: number
  /** After this many failed batches in a row, exporting stops and everything else is dropped. */
  readonly maxConsecutiveFailures: number
}

export const DEFAULT_EXPORTER_LIMITS: ExporterLimits = {
  maxQueueSpans: 512,
  maxQueueBytes: 32 * 1024 * 1024,
  maxBatchSpans: 32,
  maxBatchBytes: 4 * 1024 * 1024,
  batchIntervalMs: 1_000,
  requestTimeoutMs: 10_000,
  maxConsecutiveFailures: 3,
}

/**
 * SDK span limits, set explicitly so no `OTEL_*` variable and no SDK default cuts content the plugin already bounded.
 * The value-length limit is unbounded because `scrubSpan` has bounded every value; the count limits are the SDK's own
 * defaults (a span carries about 45 attributes and at most one event), stated here so they cannot be changed from outside.
 */
export const SDK_SPAN_LIMITS = {
  attributeValueLengthLimit: Number.POSITIVE_INFINITY,
  attributeCountLimit: 128,
  eventCountLimit: 128,
  linkCountLimit: 128,
  attributePerEventCountLimit: 128,
  attributePerLinkCountLimit: 128,
} as const

export interface SpanExporterOptions {
  /** Full OTLP traces URL. */
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  /** Action mode: send the running counts on every batch. Local mode: never. */
  readonly reportCounts: boolean
  readonly limits?: Partial<ExporterLimits>
  /** Called once if the circuit opens. Fixed text only. */
  readonly onStopped?: () => void
}

export interface SpanExporter {
  /** Queues a span. Never throws; a span that cannot be queued is counted as dropped. */
  readonly export: (span: ScrubbedSpan) => void
  readonly counts: () => SpanCounts
  /** Counts spans that never reached `export`, for example one whose mapping failed, so the totals stay honest. */
  readonly drop: (spans?: number) => void
  /**
   * Stops accepting spans, exports what is queued within `boundMs`, counts whatever is left as dropped, and returns the
   * final totals.
   */
  readonly close: (boundMs: number) => Promise<SpanCounts>
}

interface Queued {
  readonly span: ReadableSpan
  readonly size: number
}

/** A span's size as the exporter budgets it: the characters it holds, not the encoded request. */
export function estimateSpanBytes(span: ScrubbedSpan): number {
  let size = 256 + span.name.length
  for (const [name, value] of Object.entries(span.attributes)) {
    size += 24 + name.length
    if (typeof value === 'string') size += value.length
    else if (typeof value !== 'number' && typeof value !== 'boolean') for (const item of value) size += item.length + 4
  }
  for (const event of span.events) {
    size += 64 + event.name.length
    for (const [name, text] of Object.entries(event.attributes)) size += name.length + text.length
  }
  return size + (span.status.message?.length ?? 0)
}

const hrTime = (ms: number): [number, number] => {
  const seconds = Math.floor(ms / 1000)
  return [seconds, Math.round((ms - seconds * 1000) * 1e6)]
}

const sleep = async (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms).unref()
  })

export function createSpanExporter(options: SpanExporterOptions): SpanExporter {
  const limits: ExporterLimits = {...DEFAULT_EXPORTER_LIMITS, ...options.limits}
  let exported = 0
  let dropped = 0
  let queue: Queued[] = []
  let queuedBytes = 0
  let inFlight: {readonly done: Promise<void>; readonly size: number; abandoned: boolean} | undefined
  let timer: NodeJS.Timeout | undefined
  let consecutiveFailures = 0
  let tripped = false
  let closed = false

  // The next ids the SDK hands to a span: the ones the turn model already chose, so records and parents agree.
  let nextTraceId = ''
  let nextSpanId = ''
  const idGenerator = {generateTraceId: () => nextTraceId, generateSpanId: () => nextSpanId}

  const counts = (): SpanCounts => ({exported, dropped})
  const baseHeaders = {'Content-Type': 'application/json', ...options.headers}

  const exporter = new OTLPExporterBase<ReadableSpan[]>(
    createOtlpHttpExportDelegate(
      {
        url: options.url,
        // Read on every request, so each batch carries the totals as of its start.
        headers: async () =>
          options.reportCounts ? {...baseHeaders, [TRACE_COUNTS_HEADER]: formatCountsHeader(counts())} : baseHeaders,
        timeoutMillis: limits.requestTimeoutMs,
        // One batch in flight is enforced here; the delegate's own limit is a second guard.
        concurrencyLimit: 1,
        compression: 'none',
        agentFactory: httpAgentFactoryFromOptions({keepAlive: true}),
      },
      JsonTraceSerializer,
    ),
  )

  let pendingSize = 0
  const processor: SpanProcessor = {
    onStart: () => {},
    onEnd: span => {
      queue.push({span, size: pendingSize})
      queuedBytes += pendingSize
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  }
  const provider = new BasicTracerProvider({
    // Hand-built: no detectors, so no process arguments, host name or environment-derived attributes.
    resource: resourceFromAttributes({'service.name': 'fro-bot-opencode-plugin'}),
    sampler: new AlwaysOnSampler(),
    idGenerator,
    spanLimits: SDK_SPAN_LIMITS,
    generalLimits: {
      attributeCountLimit: SDK_SPAN_LIMITS.attributeCountLimit,
      attributeValueLengthLimit: Number.POSITIVE_INFINITY,
    },
    spanProcessors: [processor],
  })
  const tracer = provider.getTracer('fro-bot-opencode-plugin')

  function trip(): void {
    if (tripped) return
    tripped = true
    dropped += queue.length
    queue = []
    queuedBytes = 0
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    try {
      options.onStopped?.()
    } catch {
      // A log failure must not matter.
    }
  }

  function takeBatch(): Queued[] {
    const batch: Queued[] = []
    let bytes = 0
    while (queue.length > 0 && batch.length < limits.maxBatchSpans) {
      const next = queue[0]
      if (next === undefined) break
      if (batch.length > 0 && bytes + next.size > limits.maxBatchBytes) break
      batch.push(next)
      bytes += next.size
      queue.shift()
      queuedBytes -= next.size
    }
    return batch
  }

  function startBatch(): void {
    if (inFlight !== undefined || queue.length === 0 || tripped) return
    const batch = takeBatch()
    const current = {abandoned: false, size: batch.length} as {done: Promise<void>; size: number; abandoned: boolean}
    const settle = (ok: boolean): void => {
      if (current.abandoned) return
      if (ok) {
        exported += batch.length
        consecutiveFailures = 0
      } else {
        dropped += batch.length
        consecutiveFailures += 1
        if (consecutiveFailures >= limits.maxConsecutiveFailures) trip()
      }
    }
    current.done = new Promise<void>(resolve => {
      // A watchdog over the whole batch, in case a result never comes back: a lost result is a failed batch.
      const watchdog = setTimeout(() => {
        settle(false)
        current.abandoned = true
        resolve()
      }, limits.requestTimeoutMs + 2_000)
      watchdog.unref()
      try {
        exporter.export(
          batch.map(item => item.span),
          result => {
            clearTimeout(watchdog)
            settle(result.code === 0)
            resolve()
          },
        )
      } catch {
        clearTimeout(watchdog)
        settle(false)
        resolve()
      }
    }).finally(() => {
      inFlight = undefined
      if (!closed) schedule()
    })
    inFlight = current
  }

  function schedule(): void {
    if (timer !== undefined || queue.length === 0 || inFlight !== undefined || tripped || closed) return
    if (queue.length >= limits.maxBatchSpans) {
      startBatch()
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      startBatch()
    }, limits.batchIntervalMs)
    timer.unref()
  }

  function exportSpan(span: ScrubbedSpan): void {
    try {
      const size = estimateSpanBytes(span)
      if (closed || tripped || queue.length >= limits.maxQueueSpans || queuedBytes + size > limits.maxQueueBytes) {
        dropped += 1
        return
      }
      const parent =
        span.parentSpanId === undefined
          ? ROOT_CONTEXT
          : trace.setSpanContext(ROOT_CONTEXT, {
              traceId: span.traceId,
              spanId: span.parentSpanId,
              traceFlags: TraceFlags.SAMPLED,
            })
      nextTraceId = span.traceId
      nextSpanId = span.spanId
      pendingSize = size
      const sdkSpan = tracer.startSpan(
        span.name,
        {
          kind: span.kind === 'client' ? SpanKind.CLIENT : SpanKind.INTERNAL,
          startTime: hrTime(span.startMs),
          attributes: {...span.attributes} as Record<string, string | number | boolean | string[]>,
        },
        // Always explicit: an ambient context another library registered in this process must never become a parent.
        parent,
      )
      if (span.status.code === 'error') {
        sdkSpan.setStatus({
          code: SpanStatusCode.ERROR,
          ...(span.status.message === undefined ? {} : {message: span.status.message}),
        })
      }
      for (const event of span.events) sdkSpan.addEvent(event.name, {...event.attributes}, hrTime(event.timeMs))
      // `end` hands the finished span to the processor above, which queues it.
      sdkSpan.end(hrTime(span.endMs))
      schedule()
    } catch {
      dropped += 1
    }
  }

  return {
    export: exportSpan,
    counts,
    drop: (spans = 1) => {
      dropped += spans
    },
    close: async boundMs => {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      const deadline = Date.now() + boundMs
      for (;;) {
        // `tripped` and the queue change as batches settle.
        if (tripped || (queue.length === 0 && inFlight === undefined)) break
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        if (inFlight === undefined) startBatch()
        const waiting = inFlight
        if (waiting === undefined) break
        await Promise.race([waiting.done, sleep(remaining)])
      }
      // Whatever is still queued or in flight is abandoned: counted dropped, and a late result is ignored.
      if (inFlight !== undefined) {
        if (!inFlight.abandoned) dropped += inFlight.size
        inFlight.abandoned = true
      }
      dropped += queue.length
      queue = []
      queuedBytes = 0
      // Shut the transport down without waiting on a request that is still open.
      await Promise.race([exporter.shutdown().catch(() => {}), sleep(250)])
      return counts()
    },
  }
}
