import type {TracingRunIdentity} from '@fro-bot/runtime'
import type {ExporterLimits, SpanExporter, SpanExporterOptions} from '@fro-bot/runtime/tracing/exporter'
import type {PendingSpan, Scrubber} from '@fro-bot/runtime/tracing/scrub'
import type {Logger} from './logger.js'
import type {SecretRegistry} from './secret-registry.js'
import type {TracingInputs} from './types.js'
import {Buffer} from 'node:buffer'
import {randomBytes} from 'node:crypto'
import process from 'node:process'
import {parseTraceRelayConfig} from '@fro-bot/runtime'
import {createSpanExporter} from '@fro-bot/runtime/tracing/exporter'
import {createScrubber, MAX_LITERAL_CHARS, MIN_LITERAL_CHARS, scrubSpan} from '@fro-bot/runtime/tracing/scrub'

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
 * Preparing the export never holds up a teardown. Scrubbing and serializing a batch is CPU work, and after a signal it runs beside
 * the sandbox teardown, whose timers and subprocess results wait behind whatever runs here. So it is bounded by construction (a cap
 * on every string, on the text of every span and on the attributes of an event; over a cap a value is replaced whole, because a cut
 * before the scrub could keep half a secret), it yields to the event loop between spans and between slices of the registry, and
 * from `cancel` it stops after `CANCELLED_PREPARE_BUDGET_MS`: the spans not prepared by then are dropped and counted. The
 * normal-completion flush is the same code with no budget; it runs after the run's phases, when no teardown is waiting, and where
 * a signal arrives first, `cancel` has already started the budget whichever caller flushes.
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
/** The most attributes one event keeps; the rest are left out. */
export const MAX_EVENT_ATTRIBUTES = 16

/**
 * What bounds the work of preparing a span for export (scrubbing is linear in the text, and every string is also searched for
 * every registered secret), by construction. A string longer than `INPUT_MAX_CHARS`, or past the span's `SPAN_TEXT_BUDGET_CHARS`
 * of text, is replaced WHOLE (the fixed marker, or a free text's category) and never cut: a cut before the scrub could leave the
 * front half of a secret that the scrubber no longer matches. The per-string cap is the scrubber's own bound on a plain string
 * (`plainStringChars`), far above what a phase records (ids, outcomes, a ref name, an exception message that is cut to 1,024
 * characters on export anyway).
 */
export const INPUT_MAX_CHARS = 8_192
/**
 * A plain string (not marked `freeText`) is an identifier, a code or a name this module's callers build: a logical key, a list of
 * tool names, a span name. It has a tighter cap of its own, and is replaced whole over it.
 */
export const PLAIN_MAX_CHARS = 1_024
export const SPAN_TEXT_BUDGET_CHARS = 16_384
/** Every string also costs a search for each registered secret, whatever its length: it is charged this much on top of its characters. */
export const STRING_OVERHEAD_CHARS = 64
/** The identity strings go on every span, so each is held to what a repository or job name can be. */
const IDENTITY_MAX_CHARS = 256
/** Notes of what a span left out: enough to say why, bounded so a span full of long strings does not carry a long list. */
const MAX_OMISSION_NOTES = 16

/**
 * How long after a cancellation the export may keep preparing spans (scrubbing and serializing them) before it drops the rest.
 * Preparation is local CPU work that runs beside the sandbox teardown and must never be what the teardown waits for: it yields to
 * the event loop between spans, and past this it stops.
 */
export const CANCELLED_PREPARE_BUDGET_MS = 1_000

/** Literals added to the scrubber per turn of the event loop: the fewer of these two limits. */
const SCRUBBER_SLICE_LITERALS = 64
const SCRUBBER_SLICE_CHARS = 512 * 1024

/** Fixed text, so no part of it can hold a value. */
export const NODE_DEBUG_WARNING =
  'NODE_DEBUG is set, so lifecycle tracing is off: Node can print transport details, including the trace endpoint, when it is set.'
const UNSAFE_CONFIG_WARNING =
  'The trace endpoint and credential were refused by the lifecycle tracer, so lifecycle tracing is off.'
const EXPORT_FAILED_MESSAGE = 'Lifecycle trace export failed'
/** One info line when the fail-closed rule trips: the range is the scrubber's own, so the text cannot drift from it. */
const NO_FREE_TEXT_MESSAGE = `Lifecycle trace carries no free text: a registered secret is outside ${MIN_LITERAL_CHARS}–${MAX_LITERAL_CHARS.toLocaleString('en-US')} characters`
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
 * The attribute keys Langfuse's OpenTelemetry ingestion reads from a trace's root observation, to show the trace's input and
 * output (its Sessions view) and its level and status message. Set on the `action.main` root alone, never on a phase.
 */
export const SUMMARY_ATTRIBUTE = {
  input: 'langfuse.observation.input',
  output: 'langfuse.observation.output',
  level: 'langfuse.observation.level',
  statusMessage: 'langfuse.observation.status_message',
} as const

/**
 * Each of the root's input and output strings is at most this many UTF-8 bytes. The input holds to it by construction (its
 * two free-text fields are cut to `FREE_TEXT_MAX_CHARS`, and the rest are short fixed words); the output cuts its phase list at
 * a whole entry.
 */
export const SUMMARY_MAX_BYTES = 4_096

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

const TRACE_ID_PATTERN = /^(?!0{32}$)[0-9a-f]{32}$/
const SPAN_ID_PATTERN = /^(?!0{16}$)[0-9a-f]{16}$/

/**
 * Reads the identity record the main step saved to Action state: exactly the three ids, each valid, and no other key. Anything
 * else (missing, partial, malformed, extra keys) is null, and the caller sends nothing. The record is trusted for nothing but
 * naming a trace, so it is checked as strictly as an input.
 */
export function parseTraceIds(text: string): TraceIds | null {
  if (text.length === 0) return null
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const keys = Object.keys(value)
    if (keys.length !== 3) return null
    const {traceId, rootSpanId, invocationId} = value as Record<string, unknown>
    if (typeof traceId !== 'string' || !TRACE_ID_PATTERN.test(traceId)) return null
    if (typeof rootSpanId !== 'string' || !SPAN_ID_PATTERN.test(rootSpanId)) return null
    if (typeof invocationId !== 'string' || !SPAN_ID_PATTERN.test(invocationId)) return null
    return {traceId, rootSpanId, invocationId}
  } catch {
    return null
  }
}

/**
 * What the root span's Langfuse input says about the run, beyond the identity the tracer was given (`repository` and `trigger`).
 * Every field is optional: one that is not known yet, or never is, is left out of the summary.
 */
export interface RunInput {
  /** The ref name: free text, so it is scrubbed, and left out when the registry cannot match a secret. */
  readonly ref?: string
  /** The event and its activity, a fixed vocabulary (`issue_comment.created`). */
  readonly event?: string
  readonly isolateAgent?: boolean
}

export interface FlushResult {
  readonly spans: number
  /** Spans in batches the collector did not acknowledge, plus spans that never fit. Not a count of spans it did not ingest. */
  readonly undelivered: number
  /** Spans dropped, already counted in `undelivered`, because the local preparation budget after a cancellation ran out. Absent when none. */
  readonly unprepared?: number
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
  /**
   * What the run is, for the root span's Langfuse input. Merged over earlier calls (a field given again replaces it, one left
   * out stays), and read at export, so call it as soon as a value is known. Nothing on any other span.
   */
  readonly setRunInput: (input: RunInput) => void
  /**
   * A signal arrived: ends every span still open as `cancelled` with `reason` (a fixed word such as the signal's name), the
   * root last, so the trace says where the run was when it stopped. Synchronous. Spans that end later (the phase unwinding as
   * its child is reaped) change nothing: the first end wins. Does nothing to a span that already ended.
   *
   * Also starts the clock of the export's local preparation budget (`CANCELLED_PREPARE_BUDGET_MS`), whoever calls `flush` and
   * whether or not the export is already under way: spans not prepared by then are dropped and counted, never truncated.
   */
  readonly cancel: (reason: string) => void
  /**
   * Idempotent: the first call exports, every later call returns the same result. Bounded: by `boundMs` of the first call
   * when it gives one, else by the tracer's own bound. Never rejects.
   */
  readonly flush: (options?: {readonly boundMs?: number}) => Promise<FlushResult>
}

/** The span of a tracer that is off, and of a span nobody has to end. Safe to call anything on. */
export const NOOP_SPAN: LifecycleSpan = {
  spanId: '',
  setAttribute: () => undefined,
  addEvent: () => undefined,
  recordException: () => undefined,
  startChild: () => NOOP_SPAN,
  end: () => undefined,
}

/**
 * Runs `work` inside `span`, and ends the span with what `classify` says of the result (default: succeeded). A throw is
 * recorded on the span as an exception, the span ends failed, and the error goes on unchanged: tracing never alters what
 * a phase does.
 */
export async function withSpan<T>(
  span: LifecycleSpan,
  work: (span: LifecycleSpan) => Promise<T>,
  classify?: (value: T) => SpanResult,
): Promise<T> {
  let value: T
  try {
    value = await work(span)
  } catch (error) {
    span.recordException(error)
    span.end({outcome: 'failed', reason: 'exception'})
    throw error
  }
  let result: SpanResult = {outcome: 'succeeded'}
  try {
    result = classify?.(value) ?? result
  } catch {
    // A classifier that throws must not change the phase's result.
  }
  span.end(result)
  return value
}

const NOOP_RESULT: FlushResult = {spans: 0, undelivered: 0}

export function createNoopTracer(): LifecycleTracer {
  return {
    enabled: false,
    ids: null,
    root: NOOP_SPAN,
    startSpan: () => NOOP_SPAN,
    setSessionId: () => undefined,
    setRunInput: () => undefined,
    cancel: () => undefined,
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
  /**
   * Adds spans to a trace another process started (the post step, after the main step's root has ended): the ids come from the
   * main step's record, no root span is recorded or exported, and every span with no parent hangs from the main step's root.
   */
  readonly continueFrom?: TraceIds
  /** Where `NODE_DEBUG` is read. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Milliseconds since the epoch; fractions allowed. Default: the monotonic clock anchored to the epoch. */
  readonly now?: () => number
  readonly flushBoundMs?: number
  /** How long after `cancel` the export keeps preparing spans. Default `CANCELLED_PREPARE_BUDGET_MS`. */
  readonly cancelledPrepareBudgetMs?: number
  /** Milliseconds on a clock that only moves forward, for the preparation budget. Default `performance.now`. */
  readonly monotonicNow?: () => number
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

/** True when scrubbing leaves `text` exactly as it is, and no registered literal survives in it. */
function scrubsUnchanged(scrubber: Scrubber, text: string): boolean {
  const result = scrubber.scrub(text)
  if (!result.ok || result.text !== text) return false
  return scrubber.survived?.(result.text) !== true
}

/**
 * A scrubber that knows everything the registry knows right now: the one the lifecycle tracer exports with, and the one the
 * session id is checked against. Nothing is captured from the environment (the registry already holds the secret-named values),
 * and no cap drops a literal. Built on each call, so a later registration is seen by the next scrubber, not by an earlier one.
 */
export function createRegistryScrubber(registry: Pick<SecretRegistry, 'literals'>): Scrubber {
  const scrubber = createScrubber({env: {}})
  scrubber.addLiterals?.(registry.literals())
  return scrubber
}

/** Scrubs FIRST, then caps, so a cut cannot leave part of a secret. What cannot be scrubbed is omitted. */
function scrubThenCap(scrubber: Scrubber, text: string, cap: number): BoundedText {
  const result = scrubber.scrub(text)
  if (!result.ok) return {text: OMITTED_TEXT, omitted: result.reason}
  if (scrubber.survived?.(result.text) === true) return {text: OMITTED_TEXT, omitted: 'literal-survived'}
  return {text: cut(result.text, cap)}
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

/** What a phase of the root's output says: a name, how it ended, and how long it ran. */
interface PhaseSummary {
  readonly name: string
  readonly outcome: string
  readonly ms: number
}

/**
 * The root's output as JSON of at most `SUMMARY_MAX_BYTES`: the phases that fit, in order, cut at a whole entry, with
 * `truncatedPhases` counting the rest. The part before the phases (an outcome, a reason of at most `FREE_TEXT_MAX_CHARS`
 * characters and a number) is far under the cap, so a cut always leaves a valid summary.
 */
function boundedOutput(base: Readonly<Record<string, unknown>>, phases: readonly PhaseSummary[]): string {
  const render = (count: number): string =>
    JSON.stringify({
      ...base,
      phases: phases.slice(0, count),
      ...(count < phases.length ? {truncatedPhases: phases.length - count} : {}),
    })
  const whole = render(phases.length)
  if (utf8Bytes(whole) <= SUMMARY_MAX_BYTES) return whole
  let count = 0
  while (count < phases.length && utf8Bytes(render(count + 1)) <= SUMMARY_MAX_BYTES) count += 1
  return render(count)
}

/** `ERROR` for a failed run; `WARNING` for one that did not run to a result (cancelled, skipped, incomplete, never ended). */
function levelOf(outcome: string): 'ERROR' | 'WARNING' | 'DEFAULT' {
  if (outcome === 'failed') return 'ERROR'
  if (outcome === 'cancelled' || outcome === 'skipped' || outcome === 'incomplete' || outcome === 'unfinished')
    return 'WARNING'
  return 'DEFAULT'
}

interface ExceptionRecord {
  readonly type: string
  readonly message: string
}

/** The names a built-in error (or a `typeof`) carries: the only error types exported when the registry cannot match a secret. */
const FIXED_EXCEPTION_TYPES: ReadonlySet<string> = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'bigint',
  'boolean',
  'function',
  'number',
  'object',
  'string',
  'symbol',
  'undefined',
])

/** A name from the fixed set, or `Error`. */
function exceptionCategory(type: string): string {
  return FIXED_EXCEPTION_TYPES.has(type) ? type : 'Error'
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

/** What one export holds, taken at the instant `flush` is called: the registry and session as they were, not as they become. */
interface Preparation {
  readonly scrubber: Scrubber
  readonly matchable: boolean
  /** The session id when it is exportable whole (see `toPending`), else undefined. */
  readonly session: string | undefined
  readonly endFallbackMs: number
}

/** What one span may still spend on text, and what it left out. */
interface SpanText {
  left: number
  readonly omitted: string[]
}

function note(spanText: SpanText, label: string, reason: string): void {
  if (spanText.omitted.length < MAX_OMISSION_NOTES) spanText.omitted.push(`${label}:${reason}`)
}

/** Spends the span's text budget on one string of `chars`. False, with a note, when it does not fit: the entry is then left out. */
function charge(spanText: SpanText, label: string, chars: number): boolean {
  const cost = chars + STRING_OVERHEAD_CHARS
  if (cost > spanText.left) {
    note(spanText, label, 'over-span-budget')
    return false
  }
  spanText.left -= cost
  return true
}

/**
 * The string to export for `value`, or undefined when the span has no budget left for it (the entry is left out, and the span
 * says so). A string over `INPUT_MAX_CHARS` is replaced whole: by the marker, or by a free text's category.
 */
function resolveText(
  preparation: Preparation,
  spanText: SpanText,
  value: string | FreeText,
  label: string,
): string | undefined {
  if (typeof value === 'string') {
    const oversize = value.length > PLAIN_MAX_CHARS
    if (oversize) note(spanText, label, 'over-input-cap')
    const used = oversize ? OMITTED_TEXT : value
    return charge(spanText, label, used.length) ? used : undefined
  }
  const oversize = value.text.length > INPUT_MAX_CHARS
  if (oversize) note(spanText, label, 'over-input-cap')
  // The category is what the text becomes when it cannot be trusted to a scrub: the registry cannot match a secret, or the text is over the cap.
  if (!preparation.matchable || oversize)
    return charge(spanText, label, value.category.length) ? value.category : undefined
  if (!charge(spanText, label, value.text.length)) return undefined
  const bounded = scrubThenCap(preparation.scrubber, value.text, FREE_TEXT_MAX_CHARS)
  if (bounded.omitted !== undefined) note(spanText, label, bounded.omitted)
  return bounded.text
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
  const ids: TraceIds = options.continueFrom ?? {traceId: hex(16), rootSpanId: hex(8), invocationId: hex(8)}
  const records: SpanRecord[] = []
  let sessionId: string | undefined
  let runInput: RunInput = {}
  let closed = false
  let overflow = 0
  let flushed: Promise<FlushResult> | undefined
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  /** Set by `cancel`: after this the export stops preparing spans. */
  let cancelDeadlineMs: number | undefined
  const preparationExpired = (): boolean => cancelDeadlineMs !== undefined && monotonicNow() > cancelDeadlineMs

  function handleFor(record: SpanRecord): LifecycleSpan {
    const open = (): boolean => !closed && record.endMs === undefined
    return {
      spanId: record.spanId,
      setAttribute: (name, value) => {
        if (open() && (record.attributes.has(name) || record.attributes.size < MAX_ATTRIBUTES_PER_SPAN))
          record.attributes.set(name, value)
      },
      addEvent: (name, attributes = {}) => {
        if (open() && record.events.length < MAX_EVENTS_PER_SPAN)
          record.events.push({
            name,
            timeMs: now(),
            // Past the cap the rest are left out: an event is a few fixed keys, never a bag of text to scrub.
            attributes: Object.fromEntries(Object.entries(attributes).slice(0, MAX_EVENT_ATTRIBUTES)),
          })
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
      // A name is a fixed word; one that is not is replaced whole, never cut.
      name: name.length > PLAIN_MAX_CHARS ? OMITTED_TEXT : name,
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
  // A continuation exports no root: the main step already did.
  if (options.continueFrom === undefined) records.push(rootRecord)
  const root = options.continueFrom === undefined ? handleFor(rootRecord) : NOOP_SPAN

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
    if (value === undefined || value.length > IDENTITY_MAX_CHARS) continue
    identityAttributes[`fro_bot.${key}`] = value
    identityAttributes[`langfuse.trace.metadata.${key.replace('.', '_')}`] = value
  }

  /** Free text for the summary, or undefined when it cannot be trusted to a scrub: scrubbed first, then cut, never a category. */
  function summaryText(preparation: Preparation, spanText: SpanText, label: string, text: string): string | undefined {
    if (!preparation.matchable) return undefined
    if (text.length > INPUT_MAX_CHARS) {
      note(spanText, label, 'over-input-cap')
      return undefined
    }
    const bounded = scrubThenCap(preparation.scrubber, text, FREE_TEXT_MAX_CHARS)
    if (bounded.omitted !== undefined) {
      note(spanText, label, bounded.omitted)
      return undefined
    }
    return bounded.text
  }

  /** The root's input: what the run is, with whatever is known. Undefined when nothing is. */
  function summarizeInput(preparation: Preparation, spanText: SpanText): string | undefined {
    const {trigger, repository} = identity
    const fixed = (text: string | undefined): string | undefined =>
      text === undefined || text.length > IDENTITY_MAX_CHARS ? undefined : text
    const summary = {
      trigger: fixed(trigger),
      event: fixed(runInput.event),
      // Free text: a repository and a ref name come from outside, so neither is exported when no scrub can be trusted with it.
      repository:
        repository === undefined ? undefined : summaryText(preparation, spanText, 'summary.repository', repository),
      ref: runInput.ref === undefined ? undefined : summaryText(preparation, spanText, 'summary.ref', runInput.ref),
      isolateAgent: runInput.isolateAgent,
    }
    const known = Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined))
    return Object.keys(known).length === 0 ? undefined : JSON.stringify(known)
  }

  /**
   * The root's Langfuse summary, built at export from the spans the tracer holds: the input, the output (how the run ended and
   * each direct child of the root as a phase), the level and the status message. Both JSON strings are then scrubbed with every
   * other attribute, whole.
   */
  function summarizeRoot(
    record: SpanRecord,
    preparation: Preparation,
    spanText: SpanText,
    reason: string | undefined,
  ): Record<string, string> {
    const {endFallbackMs} = preparation
    const attributes: Record<string, string> = {}
    const input = summarizeInput(preparation, spanText)
    if (input !== undefined) attributes[SUMMARY_ATTRIBUTE.input] = input
    const spent = (span: SpanRecord): number => Math.max(0, Math.round((span.endMs ?? endFallbackMs) - span.startMs))
    const outcomeOf = (span: SpanRecord): string =>
      span.result?.outcome ?? (span.endMs === undefined ? 'unfinished' : 'unset')
    const phases = records
      .filter(span => span !== record && span.parentSpanId === record.spanId)
      .map(span => ({name: span.name, outcome: outcomeOf(span), ms: spent(span)}))
    const outcome = outcomeOf(record)
    const bounded = reason === undefined ? undefined : scrubThenCap(preparation.scrubber, reason, FREE_TEXT_MAX_CHARS)
    attributes[SUMMARY_ATTRIBUTE.output] = boundedOutput(
      {outcome, ...(bounded === undefined ? {} : {reason: bounded.text}), durationMs: spent(record)},
      phases,
    )
    attributes[SUMMARY_ATTRIBUTE.level] = levelOf(outcome)
    if (bounded !== undefined) attributes[SUMMARY_ATTRIBUTE.statusMessage] = bounded.text
    return attributes
  }

  function toPending(record: SpanRecord, preparation: Preparation): PendingSpan {
    const {scrubber, endFallbackMs} = preparation
    const spanText: SpanText = {left: SPAN_TEXT_BUDGET_CHARS, omitted: []}
    const omitted = spanText.omitted
    const attributes: Record<string, string | number | boolean> = {...identityAttributes}
    // The reason first: it is what says how the span ended, so it is the last thing to lose its place in the budget.
    const reason =
      record.result?.reason === undefined
        ? undefined
        : resolveText(preparation, spanText, record.result.reason, LIFECYCLE_ATTRIBUTE.reason)
    for (const [name, value] of record.attributes) {
      if (typeof value === 'number' || typeof value === 'boolean') {
        attributes[name] = value
        continue
      }
      const text = resolveText(preparation, spanText, value, name)
      if (text !== undefined) attributes[name] = text
    }
    if (record.result?.outcome !== undefined) attributes[LIFECYCLE_ATTRIBUTE.outcome] = record.result.outcome
    if (reason !== undefined) attributes[LIFECYCLE_ATTRIBUTE.reason] = reason
    else if (record.endMs === undefined) attributes[LIFECYCLE_ATTRIBUTE.reason] = 'unfinished'
    if (preparation.session !== undefined) attributes[LIFECYCLE_ATTRIBUTE.session] = preparation.session
    if (record === rootRecord) Object.assign(attributes, summarizeRoot(record, preparation, spanText, reason))

    const events = record.events.map(event => ({
      name: event.name,
      timeMs: event.timeMs,
      attributes: Object.fromEntries(
        Object.entries(event.attributes).flatMap(([key, value]) => {
          const text = resolveText(preparation, spanText, value, `event.${key}`)
          return text === undefined ? [] : [[key, text] as const]
        }),
      ),
    }))

    let status: PendingSpan['status'] = {code: 'unset'}
    if (record.exception !== undefined) {
      // `Error.name` is a mutable string the run (or something it called) can set to anything, including a credential the
      // scrubber cannot match. So when the registry is not matchable the type is one of a fixed set of names, never the text.
      // Two strings, always: the exception is the one thing a failed span must say, so it is charged but never left out. When
      // the budget does not hold it, or it is over the input cap, it is the fixed type name and the marker.
      const {matchable} = preparation
      const fits =
        matchable &&
        record.exception.type.length <= INPUT_MAX_CHARS &&
        charge(spanText, 'exception.type', record.exception.type.length)
      const type = fits
        ? scrubThenCap(scrubber, record.exception.type, EXCEPTION_TYPE_MAX_CHARS)
        : {text: exceptionCategory(record.exception.type), omitted: undefined}
      if (matchable && !fits && record.exception.type.length > INPUT_MAX_CHARS)
        note(spanText, 'exception.type', 'over-input-cap')
      if (type.omitted !== undefined) omitted.push(`exception.type:${type.omitted}`)
      let message = type.text
      if (matchable) {
        const messageFits =
          record.exception.message.length <= INPUT_MAX_CHARS &&
          charge(spanText, 'exception.message', record.exception.message.length)
        if (!messageFits && record.exception.message.length > INPUT_MAX_CHARS)
          note(spanText, 'exception.message', 'over-input-cap')
        const bounded = messageFits
          ? scrubThenCap(scrubber, record.exception.message, EXCEPTION_MESSAGE_MAX_CHARS)
          : {text: OMITTED_TEXT, omitted: undefined}
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
      status = {code: 'error', message: reason ?? 'failed'}
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

  /** Says once, with sources and lengths only, why this run's spans carry categories instead of free text. */
  function reportNoFreeText(): void {
    if (registry.matchable()) return
    const {sources, total} = registry.unmatchable()
    logger.info(NO_FREE_TEXT_MESSAGE, {
      sources: sources.map(item => `${item.source} (${item.length} characters)`),
      ...(total > sources.length ? {more: total - sources.length} : {}),
    })
  }

  /** Lets the event loop run: the teardown's timers and subprocess results are waiting behind whatever runs here. */
  const yieldTurn = async (): Promise<void> =>
    new Promise<void>(resolve => {
      setImmediate(resolve)
    })

  /**
   * A scrubber that knows `literals`, built a slice at a time with a turn of the event loop after each. Undefined when the
   * preparation budget ran out meanwhile.
   */
  async function buildScrubber(literals: readonly string[]): Promise<Scrubber | undefined> {
    const scrubber = createScrubber({env: {}})
    for (let from = 0; from < literals.length;) {
      let chars = 0
      let to = from
      while (to < literals.length && to - from < SCRUBBER_SLICE_LITERALS && chars < SCRUBBER_SLICE_CHARS) {
        chars += literals[to]?.length ?? 0
        to += 1
      }
      scrubber.addLiterals?.(literals.slice(from, to))
      from = to
      await yieldTurn()
      if (preparationExpired()) return undefined
    }
    return scrubber
  }

  /**
   * Prepares and hands over every span, a turn of the event loop between spans, and stops once the cancellation's budget is
   * spent: the spans left are dropped and counted, never sent cut. Never rejects.
   */
  async function exportAll(boundMs: number): Promise<FlushResult> {
    const spans = records.length
    try {
      reportNoFreeText()
      // Taken now, before anything yields: what the registry and the session were when the export was asked for.
      const literals = registry.literals()
      const matchable = registry.matchable()
      const sessionCandidate = sessionId
      const exporter = (options.createExporter ?? createSpanExporter)({
        url,
        serviceName: LIFECYCLE_SERVICE_NAME,
        headers: Object.fromEntries(headers.map(({name, value}) => [name, value])),
        reportCounts: false,
        ...(options.exporterLimits === undefined ? {} : {limits: options.exporterLimits}),
      })
      const endFallbackMs = now()
      // The registry holds everything, so nothing is captured from the environment here, and no cap drops a literal.
      const scrubber = await buildScrubber(literals)
      let prepared = 0
      if (scrubber !== undefined) {
        // Never a redacted session id: a value the scrubber would change (a name like `acme/password-manager:issue-42` trips its
        // name/value rule) would collapse every conversation of that repository into one session. It is exported whole or not at all.
        const session =
          sessionCandidate !== undefined &&
          sessionCandidate.length <= PLAIN_MAX_CHARS &&
          scrubsUnchanged(scrubber, sessionCandidate)
            ? sessionCandidate
            : undefined
        const preparation: Preparation = {scrubber, matchable, session, endFallbackMs}
        for (const record of records) {
          if (preparationExpired()) break
          try {
            exporter.export(scrubSpan(toPending(record, preparation), scrubber))
          } catch {
            exporter.drop()
          }
          prepared += 1
          await yieldTurn()
        }
      }
      const unprepared = spans - prepared
      if (unprepared > 0) exporter.drop(unprepared)
      const counts = await exporter.close(boundMs)
      const undelivered = counts.dropped + overflow
      const context = {spans: spans + overflow, undelivered, ...(unprepared > 0 ? {unprepared} : {})}
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
    setRunInput: input => {
      if (closed) return
      runInput = {...runInput, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))}
    },
    cancel: reason => {
      // The budget runs from the first signal, even if the export is already under way and nothing here is left to end.
      cancelDeadlineMs ??= monotonicNow() + (options.cancelledPrepareBudgetMs ?? CANCELLED_PREPARE_BUDGET_MS)
      if (closed) return
      const stoppedAt = now()
      // Children before the root: the order a unwinding run would end them in.
      for (const record of records.toReversed()) {
        if (record.endMs !== undefined) continue
        record.endMs = stoppedAt
        record.result = {outcome: 'cancelled', reason}
      }
    },
    flush: async flushOptions => {
      closed = true
      flushed ??= exportAll(flushOptions?.boundMs ?? options.flushBoundMs ?? FLUSH_BOUND_MS)
      return flushed
    },
  }
}
