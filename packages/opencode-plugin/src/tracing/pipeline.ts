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
import type {Observation} from './observation.js'
import type {ActionIdentity} from './settings.js'
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

export interface PipelineLimits {
  /** Observations waiting for the model. Past this a new one is discarded and counted. */
  readonly maxInbox: number
  /** Records waiting to be mapped, scrubbed and exported. Past this a record is dropped and counted as a dropped span. */
  readonly maxRecords: number
  /** Time one scheduled turn of the loop may spend before yielding to the host. */
  readonly sliceMs: number
  /** How often the model is told the time, so its inactivity bounds fire with no traffic. */
  readonly tickMs: number
}

export const DEFAULT_PIPELINE_LIMITS: PipelineLimits = {maxInbox: 8_192, maxRecords: 2_048, sliceMs: 8, tickMs: 60_000}

export interface TracePipelineOptions {
  readonly sink: SpanSink
  readonly scrubber: Scrubber
  /** Action mode only. */
  readonly identity?: ActionIdentity | undefined
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
}

export interface TracePipeline {
  /** Cheap: appends and schedules. Never throws. */
  readonly observe: (observation: Observation) => void
  /** Runs everything still pending, closes every open span as interrupted and incomplete, and stops. */
  readonly stop: () => void
  readonly stats: () => PipelineStats
}

/** W3C-valid ids: 32 and 16 lowercase hex characters, never all zero. */
export const randomIds = (): IdSource => ({
  trace: () => randomBytes(16).toString('hex'),
  span: () => randomBytes(8).toString('hex'),
})

export function createTracePipeline(options: TracePipelineOptions): TracePipeline {
  const limits: PipelineLimits = {...DEFAULT_PIPELINE_LIMITS, ...options.limits}
  const now = options.now ?? Date.now
  const model = createTurnModel({
    ids: options.ids ?? randomIds(),
    ...(options.modelLimits === undefined ? {} : {limits: options.modelLimits}),
  })
  const attributeOptions = options.identity === undefined ? {} : {identity: options.identity}
  const inbox: Observation[] = []
  const records: SpanRecord[] = []
  let scheduled = false
  let stopped = false
  let observationsDropped = 0
  let recordsFailed = 0
  let tick: NodeJS.Timeout | undefined

  /** Every snapshot a record holds: the request, the prompts, a tool's arguments and its result. */
  function release(record: SpanRecord): void {
    const {ledger} = options
    if (ledger === undefined) return
    if (record.kind === 'chat') ledger.release(record.request)
    else if (record.kind === 'execute_tool') {
      ledger.release(record.input)
      ledger.release(record.result)
    } else for (const prompt of record.prompts) ledger.release(prompt.content)
    if (record.kind === 'chat') for (const call of record.toolCalls) ledger.release(call.input)
  }

  /** An observation that never reaches the model gives its snapshot back. */
  function releaseObservation(observation: Observation): void {
    const {ledger} = options
    if (ledger === undefined || typeof observation !== 'object' || observation === null) return
    if (observation.kind === 'prompt' || observation.kind === 'request') ledger.release(observation.content)
    else if (observation.kind === 'tool.before') ledger.release(observation.input)
    else if (observation.kind === 'tool.after') ledger.release(observation.result)
  }

  function enqueue(spans: readonly SpanRecord[]): void {
    for (const record of spans) {
      if (records.length >= limits.maxRecords) {
        options.sink.drop(1)
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
      options.sink.drop(1)
    } finally {
      release(record)
    }
  }

  function step(): boolean {
    const next = inbox.shift()
    if (next !== undefined) {
      try {
        enqueue(model.observe(next))
      } catch {
        // A model failure loses this observation, never the session.
        observationsDropped += 1
        releaseObservation(next)
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
    inbox.push({kind: 'tick', at: now()})
    schedule()
  }, limits.tickMs)
  tick.unref()

  return {
    observe: observation => {
      if (stopped) return
      if (inbox.length >= limits.maxInbox) {
        observationsDropped += 1
        releaseObservation(observation)
        return
      }
      inbox.push(observation)
      schedule()
    },
    stop: () => {
      if (stopped) return
      if (tick !== undefined) clearInterval(tick)
      tick = undefined
      while (inbox.length > 0) step()
      try {
        enqueue(model.flush(now()))
      } catch {
        observationsDropped += 1
      }
      stopped = true
      while (records.length > 0) step()
    },
    stats: () => ({observationsDropped, recordsFailed}),
  }
}
