/**
 * The path from a hook call to an exported span, kept off the host's request path.
 *
 * A hook handler calls `observe`, which appends one already-normalized observation to a bounded inbox and returns. Sizing,
 * the turn model, attribute mapping, scrubbing and export all run later, from `setImmediate`, a few milliseconds at a
 * time, so a large request snapshot never delays the model call that fired the hook. The content a request carries is a
 * reference to the host's own arrays; nothing here writes to a hook's arguments, and nothing serializes them in the hook.
 *
 * No SDK import: the exporter is an interface, so the whole path is testable without the OpenTelemetry packages.
 */

import type {ScrubbedSpan, Scrubber} from './content.js'
import type {Observation} from './observation.js'
import type {ActionIdentity} from './settings.js'
import type {IdSource, SpanRecord, TurnModelLimits} from './turn-model.js'

import {randomBytes} from 'node:crypto'
import {toExportSpan} from './genai-attributes.js'
import {approximateBytes} from './record-observations.js'
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

  function sized(observation: Observation): Observation {
    if (observation.bytes !== undefined) return observation
    if (observation.kind !== 'prompt' && observation.kind !== 'request') return observation
    return {...observation, bytes: approximateBytes(observation.content)}
  }

  function enqueue(spans: readonly SpanRecord[]): void {
    for (const record of spans) {
      if (records.length >= limits.maxRecords) {
        options.sink.drop(1)
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
    }
  }

  function step(): boolean {
    const next = inbox.shift()
    if (next !== undefined) {
      try {
        enqueue(model.observe(sized(next)))
      } catch {
        // A model failure loses this observation, never the session.
        observationsDropped += 1
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
