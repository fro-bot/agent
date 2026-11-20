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
 * by 1.5, at most five retries) until the per-batch timeout; every other status is final, a 3xx included: Node's `http`
 * does not follow redirects and the delegate does not either (pinned by `exporter.test.ts`), so the credential in a
 * local-mode header goes only to the URL in the settings file, which must be `https` for a remote collector with
 * certificate verification left at the platform default (`settings.ts` accepts nothing else). The relay's `503` is
 * therefore a retry and its `422` a drop. One batch is in flight at a time, far under the relay's refusal threshold of eight;
 * the next one starts only after the delegate has finished with the last (see `startBatch`).
 */

import type {ReadableSpan, SpanProcessor} from '@opentelemetry/sdk-trace-base'
import type {ScrubbedSpan} from './content.js'

import {Buffer} from 'node:buffer'

import {ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, TraceFlags} from '@opentelemetry/api'
import {OTLPExporterBase} from '@opentelemetry/otlp-exporter-base'
import {createOtlpHttpExportDelegate, httpAgentFactoryFromOptions} from '@opentelemetry/otlp-exporter-base/node-http'
import {JsonTraceSerializer} from '@opentelemetry/otlp-transformer'
import {resourceFromAttributes} from '@opentelemetry/resources'
import {AlwaysOnSampler, BasicTracerProvider} from '@opentelemetry/sdk-trace-base'

import {CONTENT_ATTRIBUTE_NAMES, MARKER} from './content.js'

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
  /** Encoded bytes waiting for export (each span counted at the size it will have on the wire). */
  readonly maxQueueBytes: number
  readonly maxBatchSpans: number
  /**
   * The most bytes in one request BODY, as encoded on the wire (UTF-8 bytes of the OTLP JSON, envelope included). Exact, not
   * estimated: every span is serialized once when it is queued, and a batch closes before its body would pass this. A span that
   * alone would pass it has its content omitted (see `exportSpan`) or is dropped; nothing over the limit is ever sent.
   */
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

/**
 * The most the collector's front proxy accepts in one request body: 4.5 MiB. Over it the answer is 413, which is final, so the
 * batch is lost. (Measured there: 4,192,616 bytes accepted, 5 MiB refused.) `maxBatchBytes` stays at least half a mebibyte under
 * it, and under the Action relay's own body cap (16 MiB, `trace-relay.ts`); `runtime-parity.test.ts` pins both relations.
 */
export const COLLECTOR_BODY_LIMIT_BYTES = 4_718_592

export const DEFAULT_EXPORTER_LIMITS: ExporterLimits = {
  maxQueueSpans: 512,
  maxQueueBytes: 32 * 1024 * 1024,
  maxBatchSpans: 32,
  maxBatchBytes: 4_000_000,
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
  /** Test seams only; nothing in production sets them. */
  readonly testing?: {
    /** Cancelling a request cannot reach its socket: the delegate never lets go, as if its transport could not be stopped. */
    readonly ignoreAgentDestroy?: boolean
  }
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

/** The most content attributes omitted from one span to bring it under the body limit, and the smallest one worth omitting. */
/** How long the delegate may take to let go of a cancelled request before the transport is given up on. */
const DRAIN_GRACE_MS = 1_000
const MAX_OMISSIONS = 32
const MIN_OMIT_BYTES = 256

const hrTime = (ms: number): [number, number] => {
  const seconds = Math.floor(ms / 1000)
  return [seconds, Math.round((ms - seconds * 1000) * 1e6)]
}

const sleep = async (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms).unref()
  })

/** What an attribute costs on the wire: its key and its value as JSON, in UTF-8 bytes (the OTLP JSON encodes a string as JSON does). */
const wireBytes = (name: string, value: string): number =>
  Buffer.byteLength(JSON.stringify(name), 'utf8') + Buffer.byteLength(JSON.stringify(value), 'utf8')

/**
 * The span without the content attribute that costs the most bytes on the wire, which it names in the omission marker; or
 * undefined. Only the content attributes are candidates (never identity, outcome or any other metadata), ranked by encoded bytes
 * saved, not by character count: escaped or multi-byte text costs far more than its length says.
 */
function omitLargestContent(span: ScrubbedSpan): ScrubbedSpan | undefined {
  let largest: string | undefined
  let weight = 0
  for (const name of CONTENT_ATTRIBUTE_NAMES) {
    const value = span.attributes[name]
    if (typeof value !== 'string') continue
    const bytes = wireBytes(name, value)
    if (bytes > weight) {
      largest = name
      weight = bytes
    }
  }
  // Nothing of content is left to omit: whatever makes the span too large is not something that can be taken out.
  if (largest === undefined || weight < MIN_OMIT_BYTES) return undefined
  const attributes: Record<string, string | number | boolean | readonly string[]> = {}
  for (const [name, value] of Object.entries(span.attributes)) if (name !== largest) attributes[name] = value
  const marked = span.attributes[MARKER.omitted]
  attributes[MARKER.omitted] = [...(typeof marked === 'object' ? marked : []), `${largest}:span-too-large`]
  return {...span, attributes}
}

export function createSpanExporter(options: SpanExporterOptions): SpanExporter {
  const limits: ExporterLimits = {...DEFAULT_EXPORTER_LIMITS, ...options.limits}
  let exported = 0
  let dropped = 0
  let queue: Queued[] = []
  let queuedBytes = 0
  // The batch the delegate holds. `counted` and "the delegate has let go" are separate facts: a batch is counted (exported or
  // dropped) once, by whichever of its result, the watchdog or shutdown comes first, while `inFlight` stays set until the delegate
  // has drained (its slot is free), because a batch handed to an occupied delegate is refused and its spans would be lost.
  let inFlight: {readonly done: Promise<void>; readonly size: number; counted: boolean} | undefined
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

  // The SDK's delegate cannot be told to stop: its shutdown does nothing, and a retry is a timer it does not expose. Two
  // things under our control cancel it: the agent (destroying it closes every open socket, so an in-flight request fails at
  // once) and the headers function, which the transport awaits before EVERY request including each retry (once cancelled it
  // throws, so no further request is made). Both are used at the cleanup deadline.
  let cancelled = false
  // Set while the request of a batch the watchdog gave up on is being cancelled: nothing may be sent until the delegate lets go.
  let cancelling = false
  let agent: {readonly destroy: () => void} | undefined
  const makeAgent = httpAgentFactoryFromOptions({keepAlive: true, rejectUnauthorized: true})

  const exporter = new OTLPExporterBase<ReadableSpan[]>(
    createOtlpHttpExportDelegate(
      {
        url: options.url,
        // Read on every request, so each batch carries the totals as of its start.
        headers: async () => {
          if (cancelled || cancelling) throw new Error('export cancelled')
          return options.reportCounts
            ? {...baseHeaders, [TRACE_COUNTS_HEADER]: formatCountsHeader(counts())}
            : baseHeaders
        },
        timeoutMillis: limits.requestTimeoutMs,
        // One batch in flight is enforced here; the delegate's own limit is a second guard.
        concurrencyLimit: 1,
        compression: 'none',
        // Certificate validation is set here, for every https export, so a process-wide `NODE_TLS_REJECT_UNAUTHORIZED=0` cannot
        // turn it off: the credential in a local-mode header goes only to a destination whose certificate verified.
        agentFactory: async protocol => {
          const made = await makeAgent(protocol)
          agent = options.testing?.ignoreAgentDestroy === true ? undefined : made
          return made
        },
      },
      JsonTraceSerializer,
    ),
  )

  // The span the SDK just finished, handed over by the processor to `build`, which sizes it before it is queued.
  let ended: ReadableSpan | undefined
  // The bytes of a request body that are not spans (the resource and the scope); derived from the first span, see `spanBytes`.
  let envelopeBytes = 0
  const processor: SpanProcessor = {
    onStart: () => {},
    onEnd: span => {
      ended = span
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
    // The body is the envelope, the spans' own JSON, and a comma between each pair: exact, so the sum is the request's size.
    let bytes = envelopeBytes
    while (queue.length > 0 && batch.length < limits.maxBatchSpans) {
      const next = queue[0]
      if (next === undefined) break
      if (batch.length > 0 && bytes + batch.length + next.size > limits.maxBatchBytes) break
      batch.push(next)
      bytes += next.size
      queue.shift()
      queuedBytes -= next.size
    }
    return batch
  }

  /**
   * Cancels the request the delegate holds and waits, for a bound, until it has let go of its slot. Used when the watchdog gives
   * up on a batch: the SDK's request timeout is an IDLE timeout on the socket, so a collector that keeps the connection active
   * (a response that trickles) outlasts the watchdog, and the next batch handed to the delegate would be refused as over its
   * concurrency limit. Destroying the agent closes every open socket, which ends the request, and the headers function refuses
   * every request until the delegate has drained. If it has not drained within the grace period the transport cannot be stopped:
   * the breaker trips (everything queued is counted dropped) and nothing more is sent.
   */
  async function cancelInFlight(): Promise<void> {
    cancelling = true
    try {
      agent?.destroy()
    } catch {
      // The headers function still stops every further request.
    }
    const drained = await Promise.race([
      exporter.forceFlush().then(
        () => true,
        () => true,
      ),
      sleep(DRAIN_GRACE_MS).then(() => false),
    ])
    if (drained) {
      cancelling = false
      return
    }
    cancelled = true
    trip()
  }

  function startBatch(): void {
    if (inFlight !== undefined || queue.length === 0 || tripped) return
    const batch = takeBatch()
    const current = {counted: false, size: batch.length} as {done: Promise<void>; size: number; counted: boolean}
    /** Counts the batch, once, whatever order the result, the watchdog and shutdown come in. */
    const settle = (ok: boolean): void => {
      if (current.counted) return
      current.counted = true
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
      // A watchdog over the whole batch, in case a result never comes back: a lost result is a failed batch. The request is then
      // cancelled and the next batch waits until the delegate has let go of it.
      const watchdog = setTimeout(() => {
        settle(false)
        cancelInFlight().then(resolve, resolve)
      }, limits.requestTimeoutMs + 2_000)
      watchdog.unref()
      try {
        exporter.export(
          batch.map(item => item.span),
          result => {
            clearTimeout(watchdog)
            settle(result.code === 0)
            // The delegate calls this from inside the promise it keeps in its own in-flight set (`otlp-export-delegate.js`:
            // `this._promiseQueue.pushPromise(this._transport.send(...).then(response => { ...resultCallback(...) }))`), and
            // takes that promise out of the set only AFTER it settles (`bounded-queue-export-promise-handler.js`:
            // `promise.then(popPromise, popPromise)`). Starting the next batch from here would find the set still full and be
            // refused with `Concurrent export limit reached` (a whole batch counted dropped). So the batch is not over until the
            // delegate says nothing is in flight: `forceFlush()` is `Promise.all` over that set, and the set's own removal was
            // registered on the same promise first, so by the time it resolves the entry is gone.
            exporter.forceFlush().then(resolve, resolve)
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

  /** Hands the SDK a span with the ids the turn model chose, and returns what it ended up with, or undefined. */
  function build(span: ScrubbedSpan): ReadableSpan | undefined {
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
    ended = undefined
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
    // `end` hands the finished span to the processor above, which leaves it in `ended`.
    sdkSpan.end(hrTime(span.endMs))
    const finished = ended
    ended = undefined
    return finished
  }

  function encodedLength(spans: ReadableSpan[]): number {
    const body = JsonTraceSerializer.serializeRequest(spans)
    if (body === undefined) throw new Error('nothing to encode')
    return body.byteLength
  }

  /**
   * The span's own bytes in a request body, exact: the body of a request holding it alone, less the envelope (the resource and the
   * scope, the same for every span). The envelope is derived once, from the first span: a request of one span is `E + a`, of the
   * same span twice `E + 2a + 1` (a comma), so `a` is the difference less one and `E` is what is left. The sum for a batch of n is
   * then `E + (a1 + ... + an) + (n - 1)`, which is what the delegate's serializer produces (pinned by `exporter.test.ts`).
   */
  function spanBytes(readable: ReadableSpan): number {
    const alone = encodedLength([readable])
    if (envelopeBytes === 0) {
      const twice = encodedLength([readable, readable])
      envelopeBytes = alone - (twice - alone - 1)
    }
    return alone - envelopeBytes
  }

  function exportSpan(span: ScrubbedSpan): void {
    try {
      if (closed || tripped || queue.length >= limits.maxQueueSpans) {
        dropped += 1
        return
      }
      // Sized once, exactly, before it is queued. A span that alone would pass the body limit has its largest content omitted,
      // again and again up to a bound, so the span itself still arrives; one that cannot be brought under is dropped and counted.
      let candidate = span
      for (let attempt = 0; ; attempt += 1) {
        const readable = build(candidate)
        if (readable === undefined) {
          dropped += 1
          return
        }
        const size = spanBytes(readable)
        if (envelopeBytes + size <= limits.maxBatchBytes) {
          if (queuedBytes + size > limits.maxQueueBytes) {
            dropped += 1
            return
          }
          queue.push({span: readable, size})
          queuedBytes += size
          break
        }
        const trimmed = attempt < MAX_OMISSIONS ? omitLargestContent(candidate) : undefined
        if (trimmed === undefined) {
          dropped += 1
          return
        }
        candidate = trimmed
      }
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
      // Whatever is still queued or in flight is cancelled and counted dropped (a request already fully received may still have
      // been accepted: a dropped count is an upper bound, and the Action-mode counts header, which only has exported and
      // dropped, reports it the same way).
      // What this does not cancel: the SDK's retry wait. `retrying-transport.js` holds it as a plain, referenced `setTimeout`
      // (v0.219.0, no handle exposed, and the package's exports map allows no deep import to build the transport ourselves), so
      // a host that waits for its event loop to drain stays up until it fires. That timer is bounded by the request timeout
      // (`requestTimeoutMs`, 10 s): the wait is at most 5 s of backoff, or a server-sent `Retry-After` up to the time left of the
      // request. Measured with `Retry-After: 9`: the process exits about 7.4 s after cleanup returns; without it, about 0.5 to
      // 1.1 s. When it fires the headers function above throws, so nothing is sent. OpenCode's server does not wait for it.
      cancelled = true
      try {
        agent?.destroy()
      } catch {
        // Nothing more can be done: the headers function stops every further request.
      }
      if (inFlight !== undefined && !inFlight.counted) {
        dropped += inFlight.size
        inFlight.counted = true
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
