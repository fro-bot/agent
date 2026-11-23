import type {TracingRunIdentity} from '@fro-bot/runtime'
import type {ExporterLimits, SpanExporter, SpanExporterOptions} from '@fro-bot/runtime/tracing/exporter'
import type {PendingSpan, Scrubber} from '@fro-bot/runtime/tracing/scrub'
import type {Logger} from './logger.js'
import type {SecretRegistry} from './secret-registry.js'
import type {TracingInputs} from './types.js'
import {randomBytes} from 'node:crypto'
import process from 'node:process'
import {parseTraceRelayConfig} from '@fro-bot/runtime'
import {createSpanExporter} from '@fro-bot/runtime/tracing/exporter'
import {createScrubber, scrubSpan} from '@fro-bot/runtime/tracing/scrub'

/**
 * The Action's own trace of one invocation: a run-wide recorder (held like `metrics`) that keeps spans, events and outcomes
 * in memory, scrubs them once at flush with a set of secrets that grew during the run, and sends them straight to the
 * operator's collector through the shared exporter. Never through the trace relay: the relay stops before finalize and
 * cleanup, and does not exist in the post step.
 *
 * Tracing never changes a run. Nothing here throws into the caller, every export failure ends in one log line with counts,
 * and with no usable trace inputs (or with `NODE_DEBUG` set) the tracer is a no-op that creates no exporter.
 *
 * What the scrub covers: every string of every span, at one point (`scrubSpan`), after a scrub-then-cap of the text that
 * comes from outside (exception messages, ref names). Event names and attribute KEYS are not scrubbed: they are this
 * module's and its callers' fixed vocabulary, never data.
 *
 * It fails closed. If the registry holds a credential the scrubber cannot match (see `secret-registry.ts`), no free text is
 * exported at all: exception messages and `freeText` values become their category.
 */

/** The resource's `service.name`: which sender a span came from. Distinct from the plugin's `fro-bot-opencode-plugin`. */
export const LIFECYCLE_SERVICE_NAME = 'fro-bot-action'

/** The root span's name: the main step. */
export const ROOT_SPAN_NAME = 'action.main'

/** How long a flush waits for the collector, near the relay's own 6 s settle. */
export const FLUSH_BOUND_MS = 6_000

/** Free text from outside is cut to this after it is scrubbed. */
export const FREE_TEXT_MAX_CHARS = 256
export const EXCEPTION_MESSAGE_MAX_CHARS = 1_024
const EXCEPTION_TYPE_MAX_CHARS = 128

/** The most spans, events per span and attributes per span kept. Bounds memory, and keeps the batch under the exporter's queue. */
const MAX_SPANS = 400
const MAX_EVENTS_PER_SPAN = 64
const MAX_ATTRIBUTES_PER_SPAN = 64

/** Fixed text, so no part of it can hold a value. */
export const NODE_DEBUG_WARNING =
  'NODE_DEBUG is set, so lifecycle tracing is off: Node can print transport details, including the trace endpoint, when it is set.'
const UNSAFE_CONFIG_WARNING =
  'The trace endpoint and credential were refused by the lifecycle tracer, so lifecycle tracing is off.'
const EXPORT_FAILED_MESSAGE = 'Lifecycle trace export failed'
const EXPORT_FINISHED_MESSAGE = 'Lifecycle trace export finished'

/** The attribute keys this tracer sets itself. The identity keys are the turn spans' own. */
export const LIFECYCLE_ATTRIBUTE = {
  outcome: 'fro_bot.outcome',
  reason: 'fro_bot.reason',
  invocationId: 'fro_bot.invocation.id',
  session: 'langfuse.session.id',
  errorType: 'error.type',
} as const

/**
 * What a span ended with. The Action's invocation outcomes (`InvocationOutcome` in `harness/outcome.ts`, which this layer cannot
 * import; `lifecycle-tracer.test.ts` pins the two together) plus `cancelled`, which only tracing knows: a signalled run's outputs
 * and job summary are unchanged.
 */
export type SpanOutcome = 'succeeded' | 'incomplete' | 'failed' | 'skipped' | 'cancelled'

export interface SpanResult {
  readonly outcome?: SpanOutcome
  /** A stable code (skip reason, lock result, cache status): fixed vocabulary, never free text. */
  readonly reason?: string
}

/**
 * Text that comes from outside the Action (a ref name, a PATH entry). It is exported scrubbed and capped, or, when the
 * scrubber cannot be trusted with this run, as its `category`: a fixed word that says what kind of text it was.
 */
export interface FreeText {
  readonly kind: 'free-text'
  readonly text: string
  readonly category: string
}

export const freeText = (text: string, category: string): FreeText => ({kind: 'free-text', text, category})

export type AttributeValue = string | number | boolean | FreeText
type EventAttributes = Readonly<Record<string, string | FreeText>>

export interface LifecycleSpan {
  readonly spanId: string
  readonly setAttribute: (name: string, value: AttributeValue) => void
  readonly addEvent: (name: string, attributes?: EventAttributes) => void
  /** The error's type and message only: no cause chain, no stack. Marks the span as an error. */
  readonly recordException: (error: unknown) => void
  readonly startChild: (name: string) => LifecycleSpan
  /** The first call wins. */
  readonly end: (result?: SpanResult) => void
}

export interface TraceIds {
  readonly traceId: string
  readonly rootSpanId: string
  /** Tells apart two Action steps in one job. */
  readonly invocationId: string
}

export interface FlushResult {
  readonly spans: number
  /** Spans in batches the collector did not acknowledge, plus spans that never fit. Not a count of spans it did not ingest. */
  readonly undelivered: number
}

export interface LifecycleTracer {
  /** False for the no-op. */
  readonly enabled: boolean
  /** Null for the no-op: there is no trace. */
  readonly ids: TraceIds | null
  readonly root: LifecycleSpan
  readonly startSpan: (name: string, options?: {readonly parent?: LifecycleSpan}) => LifecycleSpan
  /** The Langfuse session. Spans that ended before it was known get it at export. */
  readonly setSessionId: (sessionId: string) => void
  /** Idempotent: the first call exports, every later call returns the same result. Bounded. Never rejects. */
  readonly flush: () => Promise<FlushResult>
}

const NOOP_SPAN: LifecycleSpan = {
  spanId: '',
  setAttribute: () => undefined,
  addEvent: () => undefined,
  recordException: () => undefined,
  startChild: () => NOOP_SPAN,
  end: () => undefined,
}

const NOOP_RESULT: FlushResult = {spans: 0, undelivered: 0}

export function createNoopTracer(): LifecycleTracer {
  return {
    enabled: false,
    ids: null,
    root: NOOP_SPAN,
    startSpan: () => NOOP_SPAN,
    setSessionId: () => undefined,
    flush: async () => NOOP_RESULT,
  }
}

export interface CreateLifecycleTracerOptions {
  /** The parsed trace inputs. Off means the no-op. */
  readonly inputs: TracingInputs
  readonly logger: Logger
  /** The run's secrets. The tracer adds the trace credential to it. */
  readonly registry: SecretRegistry
  /** Whatever of the run identity exists: tracing does not depend on the turn trace's complete identity. */
  readonly identity?: Readonly<Partial<TracingRunIdentity>>
  /** Where `NODE_DEBUG` is read. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Milliseconds since the epoch; fractions allowed. Default: the monotonic clock anchored to the epoch. */
  readonly now?: () => number
  readonly flushBoundMs?: number
  readonly exporterLimits?: Partial<ExporterLimits>
  /** Test seam: the exporter is built at flush, never before. */
  readonly createExporter?: (options: SpanExporterOptions) => SpanExporter
}

const defaultNow = (): number => performance.timeOrigin + performance.now()

const hex = (bytes: number): string => randomBytes(bytes).toString('hex')

const OMITTED_TEXT = '[omitted]'

interface BoundedText {
  readonly text: string
  /** Set when the text could not be scrubbed: `reason` is the scrubber's, for the span's omission marker. */
  readonly omitted?: string
}

/** Cuts to `cap` characters without splitting a surrogate pair, and says so. */
function cut(text: string, cap: number): string {
  if (text.length <= cap) return text
  let end = cap
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd8_00 && last <= 0xdb_ff) end -= 1
  return `${text.slice(0, end)}…[truncated]`
}

/** Scrubs FIRST, then caps, so a cut cannot leave part of a secret. What cannot be scrubbed is omitted. */
function scrubThenCap(scrubber: Scrubber, text: string, cap: number): BoundedText {
  const result = scrubber.scrub(text)
  if (!result.ok) return {text: OMITTED_TEXT, omitted: result.reason}
  if (scrubber.survived?.(result.text) === true) return {text: OMITTED_TEXT, omitted: 'literal-survived'}
  return {text: cut(result.text, cap)}
}

interface ExceptionRecord {
  readonly type: string
  readonly message: string
}

function describeError(error: unknown): ExceptionRecord {
  try {
    if (error instanceof Error) return {type: error.name, message: error.message}
    return {type: typeof error, message: typeof error === 'string' ? error : String(error)}
  } catch {
    return {type: 'unknown', message: ''}
  }
}

interface SpanRecord {
  readonly spanId: string
  readonly parentSpanId: string | undefined
  readonly name: string
  readonly startMs: number
  endMs: number | undefined
  result: SpanResult | undefined
  exception: ExceptionRecord | undefined
  readonly attributes: Map<string, AttributeValue>
  readonly events: {readonly name: string; readonly timeMs: number; readonly attributes: EventAttributes}[]
}

export function createLifecycleTracer(options: CreateLifecycleTracerOptions): LifecycleTracer {
  const {inputs, logger, registry} = options
  if (!inputs.enabled) return createNoopTracer()
  const env = options.env ?? process.env

  // The credential is a secret from the moment it is known, whether or not this tracer ends up sending anything.
  registry.addTraceCredential(inputs.headers)

  if ((env.NODE_DEBUG ?? '') !== '') {
    logger.warning(NODE_DEBUG_WARNING)
    return createNoopTracer()
  }
  // The input parser already refused all of this. Checked again here because this is the one place the credential is sent
  // from: an `http` credential, or a URL the relay would not accept, is never sent.
  if (!parseTraceRelayConfig({version: 1, url: inputs.url, headers: inputs.headers}).success) {
    logger.warning(UNSAFE_CONFIG_WARNING)
    return createNoopTracer()
  }

  const {url, headers} = inputs
  const now = options.now ?? defaultNow
  const ids: TraceIds = {traceId: hex(16), rootSpanId: hex(8), invocationId: hex(8)}
  const records: SpanRecord[] = []
  let sessionId: string | undefined
  let closed = false
  let overflow = 0
  let flushed: Promise<FlushResult> | undefined

  function handleFor(record: SpanRecord): LifecycleSpan {
    const open = (): boolean => !closed && record.endMs === undefined
    return {
      spanId: record.spanId,
      setAttribute: (name, value) => {
        if (open() && (record.attributes.has(name) || record.attributes.size < MAX_ATTRIBUTES_PER_SPAN))
          record.attributes.set(name, value)
      },
      addEvent: (name, attributes = {}) => {
        if (open() && record.events.length < MAX_EVENTS_PER_SPAN) record.events.push({name, timeMs: now(), attributes})
      },
      recordException: error => {
        if (open() && record.exception === undefined) record.exception = describeError(error)
      },
      startChild: name => startSpan(name, {parent: handleFor(record)}),
      end: result => {
        if (!open()) return
        record.endMs = now()
        record.result = result
      },
    }
  }

  function startSpan(name: string, spanOptions: {readonly parent?: LifecycleSpan} = {}): LifecycleSpan {
    if (closed) return NOOP_SPAN
    if (records.length >= MAX_SPANS) {
      overflow += 1
      return NOOP_SPAN
    }
    const parentId = spanOptions.parent?.spanId
    const record: SpanRecord = {
      spanId: hex(8),
      // A parent that is not recorded (the no-op span, after the cap) leaves the child under the root.
      parentSpanId: parentId === undefined || parentId === '' ? ids.rootSpanId : parentId,
      name,
      startMs: now(),
      endMs: undefined,
      result: undefined,
      exception: undefined,
      attributes: new Map(),
      events: [],
    }
    records.push(record)
    return handleFor(record)
  }

  // The root is the first record, with the id minted up front so a turn can link to it before any span ends.
  const rootRecord: SpanRecord = {
    spanId: ids.rootSpanId,
    parentSpanId: undefined,
    name: ROOT_SPAN_NAME,
    startMs: now(),
    endMs: undefined,
    result: undefined,
    exception: undefined,
    attributes: new Map(),
    events: [],
  }
  records.push(rootRecord)
  const root = handleFor(rootRecord)

  const identityAttributes: Record<string, string> = {
    [LIFECYCLE_ATTRIBUTE.invocationId]: ids.invocationId,
    'langfuse.trace.metadata.invocation_id': ids.invocationId,
  }
  const identity = options.identity ?? {}
  const identityKeys = [
    ['repository', 'repository'],
    ['runId', 'run.id'],
    ['attempt', 'run.attempt'],
    ['job', 'job'],
    ['trigger', 'trigger'],
  ] as const
  for (const [field, key] of identityKeys) {
    const value = identity[field]
    if (value === undefined) continue
    identityAttributes[`fro_bot.${key}`] = value
    identityAttributes[`langfuse.trace.metadata.${key.replace('.', '_')}`] = value
  }

  function resolveText(scrubber: Scrubber, value: string | FreeText, omitted: string[], label: string): string {
    if (typeof value === 'string') return value
    if (!registry.matchable()) return value.category
    const bounded = scrubThenCap(scrubber, value.text, FREE_TEXT_MAX_CHARS)
    if (bounded.omitted !== undefined) omitted.push(`${label}:${bounded.omitted}`)
    return bounded.text
  }

  function toPending(record: SpanRecord, scrubber: Scrubber, endFallbackMs: number): PendingSpan {
    const omitted: string[] = []
    const attributes: Record<string, string | number | boolean> = {...identityAttributes}
    for (const [name, value] of record.attributes) {
      attributes[name] = typeof value === 'object' ? resolveText(scrubber, value, omitted, name) : value
    }
    if (record.result?.outcome !== undefined) attributes[LIFECYCLE_ATTRIBUTE.outcome] = record.result.outcome
    if (record.result?.reason !== undefined) attributes[LIFECYCLE_ATTRIBUTE.reason] = record.result.reason
    else if (record.endMs === undefined) attributes[LIFECYCLE_ATTRIBUTE.reason] = 'unfinished'
    if (sessionId !== undefined) attributes[LIFECYCLE_ATTRIBUTE.session] = sessionId

    const events = record.events.map(event => ({
      name: event.name,
      timeMs: event.timeMs,
      attributes: Object.fromEntries(
        Object.entries(event.attributes).map(([key, value]) => [
          key,
          resolveText(scrubber, value, omitted, `event.${key}`),
        ]),
      ),
    }))

    let status: PendingSpan['status'] = {code: 'unset'}
    if (record.exception !== undefined) {
      const type = scrubThenCap(scrubber, record.exception.type, EXCEPTION_TYPE_MAX_CHARS)
      if (type.omitted !== undefined) omitted.push(`exception.type:${type.omitted}`)
      let message = type.text
      if (registry.matchable()) {
        const bounded = scrubThenCap(scrubber, record.exception.message, EXCEPTION_MESSAGE_MAX_CHARS)
        if (bounded.omitted !== undefined) omitted.push(`exception.message:${bounded.omitted}`)
        message = bounded.text
      }
      attributes[LIFECYCLE_ATTRIBUTE.errorType] = type.text
      events.push({
        name: 'exception',
        timeMs: record.endMs ?? endFallbackMs,
        attributes: {'exception.type': type.text, 'exception.message': message},
      })
      status = {code: 'error', message}
    } else if (record.result?.outcome === 'failed') {
      status = {code: 'error', message: record.result.reason ?? 'failed'}
    }

    return {
      traceId: ids.traceId,
      spanId: record.spanId,
      parentSpanId: record.parentSpanId,
      name: record.name,
      kind: 'internal',
      startMs: record.startMs,
      endMs: record.endMs ?? endFallbackMs,
      attributes,
      status,
      events,
      ...(omitted.length > 0 ? {omitted} : {}),
    }
  }

  async function exportAll(): Promise<FlushResult> {
    const spans = records.length
    try {
      // The registry holds everything, so nothing is captured from the environment here, and no cap drops a literal.
      const scrubber = createScrubber({env: {}})
      scrubber.addLiterals?.(registry.literals())
      const exporter = (options.createExporter ?? createSpanExporter)({
        url,
        serviceName: LIFECYCLE_SERVICE_NAME,
        headers: Object.fromEntries(headers.map(({name, value}) => [name, value])),
        reportCounts: false,
        ...(options.exporterLimits === undefined ? {} : {limits: options.exporterLimits}),
      })
      const endMs = now()
      for (const record of records) {
        try {
          exporter.export(scrubSpan(toPending(record, scrubber, endMs), scrubber))
        } catch {
          exporter.drop()
        }
      }
      const counts = await exporter.close(options.flushBoundMs ?? FLUSH_BOUND_MS)
      const undelivered = counts.dropped + overflow
      const context = {spans: spans + overflow, undelivered}
      if (undelivered > 0) logger.warning(EXPORT_FINISHED_MESSAGE, context)
      else logger.info(EXPORT_FINISHED_MESSAGE, context)
      return context
    } catch {
      // Whatever threw may hold the endpoint or a header: the message is fixed and the error is not logged.
      const context = {spans: spans + overflow, undelivered: spans + overflow}
      logger.warning(EXPORT_FAILED_MESSAGE, context)
      return context
    }
  }

  return {
    enabled: true,
    ids,
    root,
    startSpan,
    setSessionId: id => {
      if (id.length > 0) sessionId = id
    },
    flush: async () => {
      closed = true
      flushed ??= exportAll()
      return flushed
    },
  }
}
