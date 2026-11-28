/**
 * The path from a hook call to an exported span, kept off the host's request path.
 *
 * A hook handler normalizes its payload into an observation, which already carries an immutable bounded snapshot of the
 * named content fields (`snapshot.ts`), and calls `observe`, which appends it to a bounded inbox and returns. The turn
 * model, attribute mapping, scrubbing, bounding, serialization and export all run later, from `setImmediate`, a few
 * milliseconds at a time, so a large request never delays the model call that fired the hook. Nothing here holds a
 * reference to a hook's input, so a later edit to it cannot change what a span records.
 *
 * Snapshots are counted by a ledger (count and characters, apart from the exporter's queue) and freed when the span they
 * belong to is exported or dropped, or when their observation is discarded.
 *
 * No SDK import: the exporter is an interface, so the whole path is testable without the OpenTelemetry packages.
 */

import type {ScrubbedSpan, Scrubber} from './content.js'
import type {AttributeOptions} from './genai-attributes.js'
import type {Observation} from './observation.js'
import type {ActionIdentity, ActionRunContext} from './settings.js'
import type {SnapshotLedger} from './snapshot.js'
import type {IdSource, SpanRecord, TurnModelLimits} from './turn-model.js'

import {randomBytes} from 'node:crypto'
import {toExportSpan} from './genai-attributes.js'
import {createTurnModel} from './turn-model.js'

export interface SpanSink {
  readonly export: (span: ScrubbedSpan) => void
  /** Spans that never reached `export`. */
  readonly drop: (spans?: number) => void
}

/**
 * What the inbox can hold, in two separate bounds (there is no third budget):
 * - FREE TEXT (`maxInboxChars`): model output, titles, summaries, error messages. Past it the text is omitted and marked.
 * - IDENTIFIER-ONLY entries (ids, names, labels): bounded by COUNT (`maxInbox` entries) and by SIZE per identifier
 *   (`MAX_IDENTIFIER_CHARS`, 512 characters; a longer one is dropped as malformed). The identifier characters an entry holds
 *   are counted in `stats().inboxChars` but never omitted. Worst case, an adversary filling every slot with the observation
 *   kind that carries the most identifier fields (6, a `tool.after`) holds 8,192 x 6 x 512 = 25,165,824 characters
 *   (24 Mi), on top of the 8 Mi of free text. Real identifiers are tens of characters (the longest seen in real-binary runs is
 *   30: session, message and inbox ids), so a full inbox holds about 1 Mi in practice.
 */
export interface PipelineLimits {
  /** Observations waiting for the model. Past this a new one is discarded and counted. */
  readonly maxInbox: number
  /** Records waiting to be mapped, scrubbed and exported. Past this a record is dropped and counted as a dropped span. */
  readonly maxRecords: number
  /** Time one scheduled turn of the loop may spend before yielding to the host. */
  readonly sliceMs: number
  /**
   * Raw text (model output, a title, a compaction summary, error messages) the inbox may hold at once, in characters. An
   * observation that would pass it is replaced by its structure with the text omitted and marked, never clipped: a cut
   * before redaction could split a secret. Snapshots (prompt, request and tool content) have their own ledger.
   */
  readonly maxInboxChars: number
  /** How often the model is told the time, so its inactivity bounds fire with no traffic. */
  readonly tickMs: number
}

export const DEFAULT_PIPELINE_LIMITS: PipelineLimits = {
  maxInbox: 8_192,
  maxRecords: 2_048,
  sliceMs: 8,
  maxInboxChars: 8 * 1024 * 1024,
  tickMs: 60_000,
}

export interface TracePipelineOptions extends ActionRunContext {
  readonly sink: SpanSink
  readonly scrubber: Scrubber
  /** Action mode only. */
  readonly identity?: ActionIdentity | undefined
  /** The plugin's own version, for `langfuse.release` on root spans. Absent when unknown. */
  readonly release?: string | undefined
  /** Frees each snapshot as its span leaves the pipeline. Absent: nothing is counted. */
  readonly ledger?: SnapshotLedger | undefined
  readonly now?: () => number
  readonly ids?: IdSource
  readonly modelLimits?: Partial<TurnModelLimits>
  readonly limits?: Partial<PipelineLimits>
}

export interface PipelineStats {
  /** Observations discarded because the inbox was full. */
  readonly observationsDropped: number
  /** Records that could not be mapped or scrubbed. */
  readonly recordsFailed: number
  /** Observations whose text was replaced by its structure because the inbox's text budget was spent. */
  readonly observationsOmitted: number
  /** Characters of raw text the inbox holds right now. */
  readonly inboxChars: number
  /** Entries (session ids and lost-hook times) the loss markers in the inbox hold right now: bounded per marker. */
  readonly markerEntries: number
}

export interface TracePipeline {
  /** Cheap: appends and schedules. Never throws. */
  readonly observe: (observation: Observation) => void
  /**
   * Runs what is pending, closes every open span as interrupted and incomplete, and stops, working for at most `budgetMs`
   * (one scrub can run over it, never more). What it has not done by then is dropped and counted, and its snapshots
   * released, so the caller can give the exporter the rest of its own bound.
   */
  readonly stop: (budgetMs?: number) => void
  readonly stats: () => PipelineStats
}

/** W3C-valid ids: 32 and 16 lowercase hex characters, never all zero. */
export const randomIds = (): IdSource => ({
  trace: () => randomBytes(16).toString('hex'),
  span: () => randomBytes(8).toString('hex'),
})

/**
 * Which strings an observation carries, by kind and what the inbox does with them. Every string-valued field is counted
 * against `maxInboxChars`; the table is the audit:
 *
 * | kind                | free text (counted, omittable)          | identifiers and labels (counted, never omitted)                    |
 * | ------------------- | --------------------------------------- | ------------------------------------------------------------------ |
 * | prompt              | content when it is a raw string         | sessionId, messageId, delivery                                     |
 * | inbox.enqueued      |                                         | sessionId, inboxId, item, childSessionId, reportState              |
 * | inbox.delivered     |                                         | sessionId, inboxId                                                 |
 * | session.created     |                                         | sessionId, parentSessionId, agent                                  |
 * | execution.started   |                                         | sessionId                                                          |
 * | execution.ended     | reason, error.message                   | sessionId, outcome, error.type                                     |
 * | request             | content when it is a raw string         | sessionId, requestKind, agent, model, provider                     |
 * | retry               | error.message                           | sessionId, error.type                                              |
 * | step.started        |                                         | sessionId, messageId, agent, model, provider                       |
 * | step.ended          |                                         | sessionId, messageId, finish, rawFinish                            |
 * | step.failed         | error.message                           | sessionId, messageId, error.type                                   |
 * | output              | text                                    | sessionId, messageId, part                                         |
 * | tool.named          |                                         | sessionId, callId, tool                                            |
 * | tool.called         | input when it is a raw string           | sessionId, callId, messageId                                       |
 * | tool.before         | input when it is a raw string           | sessionId, callId, tool, messageId, agent                          |
 * | tool.after          | error.message, result when raw string   | sessionId, callId, tool, status, childSessionId, error.type        |
 * | tool.ended          | message, result when it is a raw string | sessionId, callId, errorType, childSessionId                       |
 * | compaction.started  | reason                                  | sessionId, inputId                                                 |
 * | compaction.ended    | text, error.message                     | sessionId, error.type                                              |
 * | title               | title                                   | sessionId                                                          |
 * | usage, tick         |                                         | sessionId                                                          |
 *
 * A snapshot (a frozen object in `content`, `input` or `result`) is not text: the ledger bounds it. An identifier over
 * `MAX_IDENTIFIER_CHARS` is not real: the observation is dropped as malformed.
 */
const FREE_TEXT_KEYS: ReadonlySet<string> = new Set([
  'text',
  'title',
  'message',
  'reason',
  'content',
  'input',
  'result',
])
const MAX_IDENTIFIER_CHARS = 512

interface Measured {
  /** Characters of omittable free text. */
  readonly text: number
  /** Characters of identifiers and labels. */
  readonly identifiers: number
  /** An identifier too long to be real. */
  readonly oversized: boolean
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** What an observation holds in raw strings, by the audit above. Never throws. */
function measure(observation: Observation): Measured {
  if (!isPlainRecord(observation)) return {text: 0, identifiers: 0, oversized: false}
  let text = 0
  let identifiers = 0
  let oversized = false
  const label = (value: string): void => {
    identifiers += value.length
    if (value.length > MAX_IDENTIFIER_CHARS) oversized = true
  }
  for (const [key, value] of Object.entries(observation)) {
    if (key === 'kind') continue
    if (typeof value === 'string') {
      if (FREE_TEXT_KEYS.has(key)) text += value.length
      else label(value)
    } else if (key === 'error') {
      if (typeof value === 'string') text += value.length
      else if (isPlainRecord(value)) {
        for (const [errorKey, errorValue] of Object.entries(value)) {
          if (typeof errorValue !== 'string') continue
          if (errorKey === 'message') text += errorValue.length
          else label(errorValue)
        }
      }
    }
  }
  return {text, identifiers, oversized}
}

const OMITTED_MESSAGE = '[omitted]'

/** The same observation without its free text, marked omitted: its place in the sequence, its identifiers and its snapshots are kept. */
function withoutText(observation: Observation): Observation {
  const copy: Record<string, unknown> = {...observation}
  for (const [key, value] of Object.entries(observation)) {
    if (typeof value === 'string' && FREE_TEXT_KEYS.has(key)) {
      // A part's text stays a string (the model reads its absence from the flag); a message keeps a visible marker.
      copy[key] = key === 'text' || key === 'title' ? '' : key === 'message' ? OMITTED_MESSAGE : undefined
    } else if (key === 'error' && isPlainRecord(value)) {
      const error: Record<string, unknown> = {...value}
      if (typeof error.message === 'string') error.message = OMITTED_MESSAGE
      copy.error = error
    } else if (key === 'error' && typeof value === 'string') {
      copy.error = OMITTED_MESSAGE
    }
  }
  copy.omitted = true
  return copy as unknown as Observation
}

export function createTracePipeline(options: TracePipelineOptions): TracePipeline {
  const limits: PipelineLimits = {...DEFAULT_PIPELINE_LIMITS, ...options.limits}
  const now = options.now ?? Date.now
  const model = createTurnModel({
    ids: options.ids ?? randomIds(),
    ...(options.modelLimits === undefined ? {} : {limits: options.modelLimits}),
  })
  const attributeOptions: AttributeOptions = {
    identity: options.identity,
    release: options.release,
    rootSpan: options.rootSpan,
    sessionId: options.sessionId,
    invocationId: options.invocationId,
  }
  /** Observations waiting for the model, each with the raw text it holds against `maxInboxChars`. */
  const inbox: {readonly observation: Observation; readonly chars: number}[] = []
  /**
   * Loss markers in `inbox`. They are not counted against `maxInbox` (the room for ordinary observations): a marker has a
   * reserved slot and can never be dropped. Markers merge when adjacent, so there are never more than one more than the
   * ordinary observations: the inbox stays bounded.
   */
  let markers = 0
  let inboxChars = 0
  let observationsOmitted = 0
  const records: SpanRecord[] = []
  let scheduled = false
  let stopped = false
  let observationsDropped = 0
  let recordsFailed = 0
  let tick: NodeJS.Timeout | undefined

  /** The most sessions one marker names; past it the marker names none, which means every session. */
  const MAX_MARKER_SESSIONS = 32

  const atOf = (observation: Observation): number => {
    try {
      return isPlainRecord(observation) && typeof observation.at === 'number' ? observation.at : now()
    } catch {
      return now()
    }
  }
  const sessionOf = (observation: Observation): string | undefined => {
    try {
      return isPlainRecord(observation) && typeof observation.sessionId === 'string' ? observation.sessionId : undefined
    } catch {
      return undefined
    }
  }

  /** The receive time of a primary request hook, when `observation` is one: the loss of a hook is told with its time. */
  const hookTimeOf = (observation: Observation): number | undefined => {
    try {
      return isPlainRecord(observation) && observation.kind === 'request' && observation.requestKind === 'primary'
        ? atOf(observation)
        : undefined
    } catch {
      return undefined
    }
  }

  /**
   * A marker's lost-hook times with `time` for `session` folded in (the newest per session); nothing for a drop with no session.
   * At most MAX_MARKER_SESSIONS sessions: a time that does not fit is not kept, and the marker is then a broadcast (it names every
   * session), which the model treats as evidence it cannot complete. A burst of drops cannot grow the marker.
   */
  const hookTimes = (
    known: ReadonlyMap<string, number> | undefined,
    session: string | undefined,
    time: number | undefined,
  ): {hookAt?: ReadonlyMap<string, number>} => {
    const merged = new Map(known)
    if (session !== undefined && time !== undefined && (merged.has(session) || merged.size < MAX_MARKER_SESSIONS)) {
      merged.set(session, Math.max(time, merged.get(session) ?? time))
    }
    return merged.size === 0 ? {} : {hookAt: merged}
  }

  /**
   * Tells the model, in order, that `observation` never reached it: a marker at the tail (it happened after everything queued)
   * or, for one the model just failed on, at the front. A marker next to another one joins it. A drop with no known session
   * makes a marker that names none: every session.
   */
  function lose(observation: Observation, reason: string, position: 'tail' | 'front' = 'tail'): void {
    // A session id that size is malformed (it is not stored): the loss counts for every session.
    const named = sessionOf(observation)
    const session = named !== undefined && named.length <= MAX_IDENTIFIER_CHARS ? named : undefined
    const edge = position === 'tail' ? inbox.at(-1) : inbox[0]
    const merged = edge?.observation
    if (isPlainRecord(merged) && merged.kind === 'loss') {
      const sessionIds =
        merged.sessionIds === undefined || session === undefined
          ? undefined
          : merged.sessionIds.includes(session)
            ? merged.sessionIds
            : merged.sessionIds.length >= MAX_MARKER_SESSIONS
              ? undefined
              : [...merged.sessionIds, session]
      const joined: Observation = {...merged, sessionIds, ...hookTimes(merged.hookAt, session, hookTimeOf(observation))}
      if (position === 'tail') inbox[inbox.length - 1] = {observation: joined, chars: 0}
      else inbox[0] = {observation: joined, chars: 0}
      return
    }
    const marker: Observation = {
      kind: 'loss',
      at: atOf(observation),
      sessionIds: session === undefined ? undefined : [session],
      reason,
      ...hookTimes(undefined, session, hookTimeOf(observation)),
    }
    if (position === 'tail') inbox.push({observation: marker, chars: 0})
    else inbox.unshift({observation: marker, chars: 0})
    markers += 1
  }

  /** Every snapshot a record holds: the request, the prompts, a tool's arguments and its result. */
  function release(record: SpanRecord): void {
    const {ledger} = options
    if (ledger === undefined) return
    if (record.kind === 'chat') ledger.release(record.request)
    else if (record.kind === 'execute_tool') {
      ledger.release(record.input)
      ledger.release(record.result)
      for (const replaced of record.discarded) ledger.release(replaced)
    } else for (const prompt of record.prompts) ledger.release(prompt.content)
    if (record.kind === 'chat') for (const call of record.toolCalls) ledger.release(call.input)
  }

  /** An observation that never reaches the model gives its snapshot back. */
  function releaseObservation(observation: Observation): void {
    const {ledger} = options
    if (ledger === undefined || typeof observation !== 'object' || observation === null) return
    if (observation.kind === 'prompt' || observation.kind === 'request') ledger.release(observation.content)
    else if (observation.kind === 'tool.before' || observation.kind === 'tool.called') ledger.release(observation.input)
    else if (observation.kind === 'tool.ended') ledger.release(observation.result)
    else if (observation.kind === 'tool.after') ledger.release(observation.result)
  }

  /** Snapshots the model dropped with no span (an expired session's prompts, a timed-out hook note): freed here. */
  /** A snapshot the model now holds twice needs two releases: the ledger counts its owners. */
  function retainShared(): void {
    const shared = model.takeRetained()
    if (options.ledger === undefined) return
    for (const snapshot of shared) options.ledger.retain(snapshot)
  }

  function releaseDiscarded(): void {
    const dropped = model.takeDiscarded()
    if (options.ledger === undefined) return
    for (const snapshot of dropped) options.ledger.release(snapshot)
  }

  /** Spans the model refused at its open-span limit that the sink has been told about. */
  let forwardedDrops = 0
  /** Tells the sink about spans the model refused, once each: the model keeps a running total, this sends the difference. */
  function forwardDrops(): void {
    const total = model.stats().droppedSpans
    if (total <= forwardedDrops) return
    const owed = total - forwardedDrops
    // Counted as told before the sink hears it: a sink that throws loses these counts, it never makes them repeat.
    forwardedDrops = total
    tellSink(owed)
  }

  /** The sink's `drop`, which may throw: its failure is its own, and never a reason to treat the model's work as lost. */
  function tellSink(count: number): void {
    try {
      options.sink.drop(count)
    } catch {
      // Nothing more can be done with a count the sink will not take.
    }
  }

  function enqueue(spans: readonly SpanRecord[]): void {
    for (const record of spans) {
      if (records.length >= limits.maxRecords) {
        tellSink(1)
        release(record)
        continue
      }
      records.push(record)
    }
  }

  function exportRecord(record: SpanRecord): void {
    try {
      options.sink.export(toExportSpan(record, attributeOptions, options.scrubber))
    } catch {
      recordsFailed += 1
      tellSink(1)
    } finally {
      release(record)
    }
  }

  function step(): boolean {
    const queued = inbox.shift()
    if (queued !== undefined) {
      inboxChars -= queued.chars
      const next = queued.observation
      if (isPlainRecord(next) && next.kind === 'loss') markers -= 1
      let produced: SpanRecord[] | undefined
      try {
        produced = model.observe(next)
      } catch {
        // A model failure loses this observation, never the session; the model hears of it before it sees anything else.
        observationsDropped += 1
        releaseObservation(next)
        lose(next, 'model-failed', 'front')
      }
      if (produced !== undefined) {
        try {
          enqueue(produced)
          retainShared()
          releaseDiscarded()
          forwardDrops()
        } catch {
          // What the model did is done; a failure handing it on is not a failure of the observation.
        }
      }
      return true
    }
    const record = records.shift()
    if (record === undefined) return false
    exportRecord(record)
    return true
  }

  function run(): void {
    scheduled = false
    const started = performance.now()
    while (performance.now() - started < limits.sliceMs && step()) {
      // Work until the slice is spent.
    }
    if (inbox.length > 0 || records.length > 0) schedule()
  }

  function schedule(): void {
    if (scheduled || stopped) return
    scheduled = true
    setImmediate(run)
  }

  tick = setInterval(() => {
    inbox.push({observation: {kind: 'tick', at: now()}, chars: 0})
    schedule()
  }, limits.tickMs)
  tick.unref()

  return {
    observe: observation => {
      if (stopped) return
      if (inbox.length - markers >= limits.maxInbox) {
        observationsDropped += 1
        releaseObservation(observation)
        lose(observation, 'inbox-full')
        return
      }
      const measured = measure(observation)
      if (measured.oversized) {
        // An identifier that size is not real: malformed, dropped, and anything it holds is freed.
        observationsDropped += 1
        releaseObservation(observation)
        lose(observation, 'identifier-too-long')
        return
      }
      // Raw text over the remaining budget is replaced by its structure with the text omitted and marked. The replacement
      // keeps the snapshots the observation holds, so they stay charged in the ledger until their span goes.
      let held = observation
      let heldChars = measured.text + measured.identifiers
      if (measured.text > 0 && inboxChars + heldChars > limits.maxInboxChars) {
        held = withoutText(observation)
        heldChars = measured.identifiers
        observationsOmitted += 1
      }
      inboxChars += heldChars
      inbox.push({observation: held, chars: heldChars})
      schedule()
    },
    stop: (budgetMs = Number.POSITIVE_INFINITY) => {
      if (stopped) return
      if (tick !== undefined) clearInterval(tick)
      tick = undefined
      const deadline = performance.now() + budgetMs
      const timeLeft = (): boolean => performance.now() < deadline
      // Observations first, so the model sees everything that happened; each step may be a slow one.
      while (inbox.length > 0 && timeLeft()) step()
      // Out of time: what was never processed is lost, and its snapshots go back to the ledger. The model flushes next and closes
      // every span as incomplete, so it needs no marker: nothing more will arrive for it to pair wrongly.
      for (const unprocessed of inbox.splice(0)) {
        if (isPlainRecord(unprocessed.observation) && unprocessed.observation.kind === 'loss') continue
        observationsDropped += 1
        releaseObservation(unprocessed.observation)
      }
      markers = 0
      inboxChars = 0
      try {
        enqueue(model.flush(now()))
        retainShared()
        releaseDiscarded()
        forwardDrops()
      } catch {
        observationsDropped += 1
      }
      stopped = true
      while (records.length > 0 && timeLeft()) step()
      // Whatever is left is counted as dropped spans and released.
      for (const left of records.splice(0)) {
        tellSink(1)
        release(left)
      }
    },
    stats: () => ({
      observationsDropped,
      recordsFailed,
      observationsOmitted,
      inboxChars,
      markerEntries: inbox.reduce(
        (sum, queued) =>
          queued.observation.kind === 'loss'
            ? sum + (queued.observation.sessionIds?.length ?? 0) + (queued.observation.hookAt?.size ?? 0)
            : sum,
        0,
      ),
    }),
  }
}
