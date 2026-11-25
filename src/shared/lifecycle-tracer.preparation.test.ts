import type {SpanExporter} from '@fro-bot/runtime/tracing/exporter'
import type {ScrubbedSpan} from '@fro-bot/runtime/tracing/scrub'
import type {CreateLifecycleTracerOptions} from './lifecycle-tracer.js'
import {describe, expect, it} from 'vitest'
import {
  CANCELLED_PREPARE_BUDGET_MS,
  createLifecycleTracer,
  freeText,
  INPUT_MAX_CHARS,
  MAX_EVENT_ATTRIBUTES,
  PLAIN_MAX_CHARS,
  SPAN_TEXT_BUDGET_CHARS,
  STRING_OVERHEAD_CHARS,
} from './lifecycle-tracer.js'
import {createSecretRegistry} from './secret-registry.js'
import {createMockLogger} from './test-helpers.js'

/**
 * Preparing a trace for export (scrubbing and serializing every span) is local CPU work. On a cancellation it runs beside the
 * sandbox teardown, so it must stay bounded by construction (every string and every span has a cap), yield to the event loop,
 * and give up, counting what it dropped, rather than run on. Nothing is cut before it is scrubbed: what is over a cap is replaced
 * whole.
 */

const SECRET = 'sk-live-0123456789abcdef'

interface Rig {
  readonly tracer: ReturnType<typeof createLifecycleTracer>
  readonly registry: ReturnType<typeof createSecretRegistry>
  readonly logger: ReturnType<typeof createMockLogger>
  readonly exported: ScrubbedSpan[]
  /** Spans the exporter was told were dropped, in total. */
  readonly dropped: () => number
  /** Called with each exported span, after it is recorded. */
  onExport: (span: ScrubbedSpan) => void
}

function rig(overrides: Partial<CreateLifecycleTracerOptions> = {}): Rig {
  const exported: ScrubbedSpan[] = []
  let droppedTotal = 0
  const state: Rig = {
    exported,
    dropped: () => droppedTotal,
    onExport: () => undefined,
  } as unknown as Rig
  const exporter: SpanExporter = {
    export: span => {
      exported.push(span)
      state.onExport(span)
    },
    counts: () => ({exported: exported.length, dropped: droppedTotal}),
    drop: (spans = 1) => {
      droppedTotal += spans
    },
    close: async () => ({exported: exported.length, dropped: droppedTotal}),
  }
  const logger = createMockLogger()
  const registry = createSecretRegistry(() => undefined)
  const tracer = createLifecycleTracer({
    inputs: {enabled: true, url: 'http://127.0.0.1:9/v1/traces', headers: []},
    logger,
    registry,
    env: {},
    createExporter: () => exporter,
    ...overrides,
  })
  return Object.assign(state, {tracer, registry, logger})
}

const spanNamed = (exported: readonly ScrubbedSpan[], name: string): ScrubbedSpan => {
  const found = exported.find(span => span.name === name)
  if (found === undefined) throw new Error(`no exported span named ${name}`)
  return found
}
const omittedOf = (span: ScrubbedSpan): string => JSON.stringify(span.attributes['fro_bot.content.omitted'] ?? [])

/** Counts turns of the event loop, one per `setImmediate`, until stopped. */
function countTurns(): {readonly turns: () => number; readonly stop: () => void} {
  let turns = 0
  let running = true
  const next = (): void => {
    if (!running) return
    turns += 1
    setImmediate(next)
  }
  setImmediate(next)
  return {
    turns: () => turns,
    stop: () => {
      running = false
    },
  }
}

/** A clock the test moves by hand, in milliseconds. */
function manualClock(): {readonly now: () => number; advance: (ms: number) => void} {
  let at = 0
  return {
    now: () => at,
    advance: ms => {
      at += ms
    },
  }
}

describe('input caps', () => {
  it('replaces a plain string over the cap whole, never cutting it, and a secret at its far end is not exported', async () => {
    // #given an attribute longer than the cap, with a registered secret past the point a cut would keep
    const {tracer, registry, exported} = rig()
    registry.add(SECRET)
    const span = tracer.startSpan('work')
    span.setAttribute('fro_bot.logical_key', `${'k'.repeat(PLAIN_MAX_CHARS)}${SECRET}`)
    span.setAttribute('fro_bot.at_cap', 'a'.repeat(PLAIN_MAX_CHARS))
    span.end({outcome: 'succeeded'})

    // #when
    await tracer.flush()

    // #then it is a fixed marker with a reason; a string exactly at the cap is exported as it is
    const work = spanNamed(exported, 'work')
    expect(work.attributes['fro_bot.logical_key']).toBe('[omitted]')
    expect(omittedOf(work)).toContain('fro_bot.logical_key:over-input-cap')
    expect(work.attributes['fro_bot.at_cap']).toBe('a'.repeat(PLAIN_MAX_CHARS))
    expect(JSON.stringify(exported)).not.toContain(SECRET)
    expect(JSON.stringify(exported)).not.toContain('kkkkkkkk')
  })

  it('replaces free text over the cap with its category, and an event value over the cap with the marker', async () => {
    // #given
    const {tracer, exported} = rig()
    const span = tracer.startSpan('work')
    span.setAttribute('fro_bot.ref', freeText('r'.repeat(INPUT_MAX_CHARS + 1), 'ref'))
    span.addEvent('path.dropped', {
      entries: freeText('p'.repeat(INPUT_MAX_CHARS + 1), 'path-entries'),
      names: 'n'.repeat(PLAIN_MAX_CHARS + 1),
    })
    span.end({outcome: 'succeeded'})

    // #when
    await tracer.flush()

    // #then
    const work = spanNamed(exported, 'work')
    expect(work.attributes['fro_bot.ref']).toBe('ref')
    const event = work.events.find(item => item.name === 'path.dropped')
    expect(event?.attributes.entries).toBe('path-entries')
    expect(event?.attributes.names).toBe('[omitted]')
    expect(omittedOf(work)).toContain('over-input-cap')
  })

  it('omits an exception message over the cap whole, and falls back to a fixed type name', async () => {
    // #given an error whose message and name are both over the cap
    const {tracer, exported} = rig()
    const span = tracer.startSpan('work')
    const error = new Error(`${'m'.repeat(INPUT_MAX_CHARS)}x`)
    error.name = 'N'.repeat(INPUT_MAX_CHARS + 1)
    span.recordException(error)
    span.end({outcome: 'failed', reason: 'exception'})

    // #when
    await tracer.flush()

    // #then
    const work = spanNamed(exported, 'work')
    const event = work.events.find(item => item.name === 'exception')
    expect(event?.attributes['exception.message']).toBe('[omitted]')
    expect(event?.attributes['exception.type']).toBe('Error')
    expect(work.status.message).toBe('[omitted]')
  })

  it('spends one text budget per span: what does not fit is left out, in recording order, and the span says so', async () => {
    // #given more strings than the span's budget holds (each is charged its length and a fixed overhead)
    const {tracer, exported} = rig()
    const length = 1_000
    const fit = Math.floor(SPAN_TEXT_BUDGET_CHARS / (length + STRING_OVERHEAD_CHARS))
    const span = tracer.startSpan('work')
    for (let index = 0; index < fit + 2; index += 1) span.setAttribute(`a.${index}`, 'z'.repeat(length))
    span.end({outcome: 'succeeded'})

    // #when
    await tracer.flush()

    // #then the first ones are kept; the rest are not exported at all, each with a reason
    const work = spanNamed(exported, 'work')
    expect(work.attributes[`a.${fit - 1}`]).toBe('z'.repeat(length))
    expect(work.attributes[`a.${fit}`]).toBeUndefined()
    expect(work.attributes[`a.${fit + 1}`]).toBeUndefined()
    expect(omittedOf(work)).toContain(`a.${fit}:over-span-budget`)
  })

  it('bounds how many strings a span prepares, not only how long they are', async () => {
    // #given a span with the most events, each with the most attributes, of one-character values
    const {tracer, exported} = rig()
    const span = tracer.startSpan('work')
    for (let event = 0; event < 64; event += 1)
      span.addEvent(
        `e${event}`,
        Object.fromEntries(Array.from({length: MAX_EVENT_ATTRIBUTES}, (_, index) => [`k${index}`, 'v'])),
      )
    span.end({outcome: 'succeeded'})

    // #when
    await tracer.flush()

    // #then no more strings were prepared than the budget pays for, though every one is a single character
    const work = spanNamed(exported, 'work')
    const kept = work.events.reduce((total, event) => total + Object.keys(event.attributes).length, 0)
    expect(kept).toBeLessThanOrEqual(Math.floor(SPAN_TEXT_BUDGET_CHARS / (1 + STRING_OVERHEAD_CHARS)))
    expect(kept).toBeLessThan(64 * MAX_EVENT_ATTRIBUTES)
    expect(omittedOf(work)).toContain('over-span-budget')
  })

  it('keeps no more than the event attribute cap of one event', async () => {
    // #given an event with far more attributes than the cap
    const {tracer, exported} = rig()
    const span = tracer.startSpan('work')
    span.addEvent(
      'busy',
      Object.fromEntries(Array.from({length: MAX_EVENT_ATTRIBUTES * 4}, (_, index) => [`k${index}`, 'v'])),
    )
    span.end({outcome: 'succeeded'})

    // #when
    await tracer.flush()

    // #then
    const event = spanNamed(exported, 'work').events.find(item => item.name === 'busy')
    expect(Object.keys(event?.attributes ?? {})).toHaveLength(MAX_EVENT_ATTRIBUTES)
  })
})

describe('preparing spans', () => {
  it('hands the event loop a turn between spans', async () => {
    // #given thirty ended spans and a counter of event-loop turns
    const test = rig()
    for (let index = 0; index < 30; index += 1) test.tracer.startSpan(`span-${index}`).end({outcome: 'succeeded'})
    const counter = countTurns()
    const turnsAtExport: number[] = []
    test.onExport = () => turnsAtExport.push(counter.turns())

    // #when
    await test.tracer.flush()
    counter.stop()

    // #then the loop turned between every pair of spans, not once at the end
    expect(turnsAtExport.length).toBe(31)
    for (let index = 1; index < turnsAtExport.length; index += 1)
      expect(turnsAtExport[index]).toBeGreaterThan(turnsAtExport[index - 1] ?? 0)
  })

  it('hands the event loop turns while it builds the scrubber from a large registry', async () => {
    // #given thousands of registered secrets
    const test = rig()
    for (let index = 0; index < 5_000; index += 1) test.registry.add(`secret-${String(index).padStart(8, '0')}`)
    test.tracer.startSpan('only').end({outcome: 'succeeded'})
    const counter = countTurns()
    let turnsAtFirstExport = -1
    test.onExport = () => {
      if (turnsAtFirstExport === -1) turnsAtFirstExport = counter.turns()
    }

    // #when
    await test.tracer.flush()
    counter.stop()

    // #then the first span waited behind many turns, not one long block
    expect(turnsAtFirstExport).toBeGreaterThanOrEqual(10)
  })

  it('still scrubs every literal of the large registry', async () => {
    // #given a registry built in many slices, and a secret that is in the last slice
    const test = rig()
    for (let index = 0; index < 500; index += 1) test.registry.add(`secret-${String(index).padStart(8, '0')}`)
    test.registry.add(SECRET)
    const span = test.tracer.startSpan('work')
    span.setAttribute('fro_bot.note', freeText(`before ${SECRET} after`, 'note'))
    span.end({outcome: 'succeeded'})

    // #when
    await test.tracer.flush()

    // #then
    expect(JSON.stringify(test.exported)).not.toContain(SECRET)
  })

  describe('after a cancellation', () => {
    it('stops preparing once its budget is spent, drops the spans it did not prepare, and says how many', async () => {
      // #given ten spans, a budget of 250 ms, and each prepared span costing 100 ms
      const clock = manualClock()
      const test = rig({monotonicNow: clock.now, cancelledPrepareBudgetMs: 250})
      for (let index = 0; index < 9; index += 1) test.tracer.startSpan(`span-${index}`).end({outcome: 'succeeded'})
      test.onExport = () => clock.advance(100)

      // #when the run is cancelled and then exported
      test.tracer.cancel('sigterm')
      const result = await test.tracer.flush()

      // #then three were prepared, seven were dropped (never partly exported), and the count is reported
      expect(test.exported).toHaveLength(3)
      expect(test.dropped()).toBe(7)
      expect(result).toEqual({spans: 10, undelivered: 7, unprepared: 7})
      expect(test.logger.warning).toHaveBeenCalledWith(
        'Lifecycle trace export finished',
        expect.objectContaining({spans: 10, undelivered: 7, unprepared: 7}),
      )
    })

    it('applies the budget to an export already under way, from the moment of the cancellation', async () => {
      // #given an export of ten spans that began before any cancellation
      const clock = manualClock()
      const test = rig({monotonicNow: clock.now, cancelledPrepareBudgetMs: 250})
      for (let index = 0; index < 9; index += 1) test.tracer.startSpan(`span-${index}`).end({outcome: 'succeeded'})
      test.onExport = () => {
        if (test.exported.length === 2) test.tracer.cancel('sigterm')
        clock.advance(100)
      }

      // #when the signal arrives while the second span is being handed over
      const result = await test.tracer.flush()

      // #then the budget runs from the cancellation (at 100 ms, so until 350 ms): the spans prepared at 0, 100, 200 and 300 ms
      // were exported, and the one that would start at 400 ms is the first dropped
      expect(test.exported).toHaveLength(4)
      expect(result).toEqual({spans: 10, undelivered: 6, unprepared: 6})
      expect(test.dropped()).toBe(6)
    })

    it('exports everything when the budget is not spent', async () => {
      // #given a cancelled run whose preparation is instant
      const clock = manualClock()
      const test = rig({monotonicNow: clock.now, cancelledPrepareBudgetMs: 250})
      for (let index = 0; index < 4; index += 1) test.tracer.startSpan(`span-${index}`).end({outcome: 'succeeded'})
      test.tracer.cancel('sigint')

      // #when
      const result = await test.tracer.flush()

      // #then nothing was dropped and no `unprepared` field is added to the result
      expect(test.exported).toHaveLength(5)
      expect(result).toEqual({spans: 5, undelivered: 0})
    })

    it('drops every span when the budget is gone before the scrubber is built', async () => {
      // #given a clock already past the budget when the export starts
      const clock = manualClock()
      const test = rig({monotonicNow: clock.now, cancelledPrepareBudgetMs: 50})
      test.registry.add(SECRET)
      test.tracer.startSpan('a').end({outcome: 'succeeded'})
      test.tracer.cancel('sigterm')
      clock.advance(1_000)

      // #when
      const result = await test.tracer.flush()

      // #then
      expect(test.exported).toHaveLength(0)
      expect(result).toEqual({spans: 2, undelivered: 2, unprepared: 2})
    })

    it('has a default budget well inside the teardown window', () => {
      expect(CANCELLED_PREPARE_BUDGET_MS).toBeGreaterThan(0)
      expect(CANCELLED_PREPARE_BUDGET_MS).toBeLessThanOrEqual(2_000)
    })
  })
})
