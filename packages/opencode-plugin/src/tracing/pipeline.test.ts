import type {ScrubbedSpan} from './content.js'
import type {Observation} from './observation.js'
import type {SpanSink} from './pipeline.js'

import {describe, expect, it, vi} from 'vitest'

import {createScrubber} from './content.js'
import {createTracePipeline, randomIds} from './pipeline.js'
import {
  createSnapshotLedger,
  snapshotPrompt,
  snapshotRequest,
  snapshotToolArguments,
  snapshotToolResult,
} from './snapshot.js'
import {recordedFixtures} from './turn-model.fixtures.js'
import {replay} from './turn-model.testing.js'

function collectingSink() {
  const spans: ScrubbedSpan[] = []
  let dropped = 0
  const sink: SpanSink = {
    export: span => {
      spans.push(span)
    },
    drop: (count = 1) => {
      dropped += count
    },
  }
  return {sink, spans, dropped: () => dropped}
}

const fixture = (name: string): readonly Observation[] => recordedFixtures[name]?.observations ?? []
const scrubber = createScrubber()
const flush = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30))

describe('the pipeline', () => {
  it('does no work in observe: the sink hears nothing until the loop has run', async () => {
    // #given a pipeline and a whole recorded turn
    const {sink, spans} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber})

    // #when the observations are handed over
    for (const observation of fixture('text-turn')) pipeline.observe(observation)

    // #then nothing has been mapped or exported yet, because that happens after the caller returned
    expect(spans).toHaveLength(0)
    await flush()
    expect(spans.length).toBeGreaterThan(0)
    pipeline.stop()
  })

  it('exports one span per record the model produces, with valid W3C ids and parents that exist', () => {
    // #given the nested-subagent recording and the same recording replayed on the bare model
    const expected = replay(fixture('subagent-nested')).records
    const {sink, spans} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber})

    // #when it runs through the pipeline and stops
    for (const observation of fixture('subagent-nested')) pipeline.observe(observation)
    pipeline.stop()

    // #then the same number of spans came out, ids are 32 and 16 lowercase hex, and every parent is an exported span
    expect(spans).toHaveLength(expected.length)
    const ids = new Set(spans.map(span => span.spanId))
    for (const span of spans) {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/)
    }
    const orphans = spans.filter(span => span.parentSpanId !== undefined && !ids.has(span.parentSpanId))
    expect(orphans).toEqual([])
    expect(new Set(spans.map(span => span.traceId)).size).toBe(1)
  })

  it('discards an observation past the inbox bound and counts it, without throwing', () => {
    // #given a bound of two
    const {sink} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, limits: {maxInbox: 2}})
    const [a, b, c] = fixture('text-turn')

    // #when three arrive before the loop runs
    pipeline.observe(a as Observation)
    pipeline.observe(b as Observation)
    pipeline.observe(c as Observation)

    // #then one was discarded
    expect(pipeline.stats().observationsDropped).toBe(1)
    pipeline.stop()
  })

  it('drops a record past the record bound and counts it as a dropped span', () => {
    // #given room for one record
    const {sink, dropped} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, limits: {maxRecords: 1}})

    // #when a recording that yields several records is stopped
    for (const observation of fixture('tool-success-and-error')) pipeline.observe(observation)
    pipeline.stop()

    // #then the extra records were counted, not lost silently
    expect(dropped()).toBeGreaterThan(0)
  })

  it('counts a record it cannot map as a dropped span and goes on', () => {
    // #given a sink that fails on the first span
    let calls = 0
    const spans: ScrubbedSpan[] = []
    let dropped = 0
    const sink: SpanSink = {
      export: span => {
        calls += 1
        if (calls === 1) throw new Error('mapping failed')
        spans.push(span)
      },
      drop: (count = 1) => {
        dropped += count
      },
    }
    const pipeline = createTracePipeline({sink, scrubber})
    const expected = replay(fixture('text-turn')).records.length

    // #when
    for (const observation of fixture('text-turn')) pipeline.observe(observation)
    pipeline.stop()

    // #then one was dropped and the rest exported
    expect(dropped).toBe(1)
    expect(pipeline.stats().recordsFailed).toBe(1)
    expect(spans).toHaveLength(expected - 1)
  })

  it('loses an observation the model cannot handle, never the session', () => {
    // #given a model that is fed garbage
    const {sink} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber})

    // #when a malformed observation arrives
    expect(() => {
      pipeline.observe({kind: 'step.ended', at: Number.NaN, sessionId: 'x', messageId: 'y'})
      pipeline.observe(undefined as unknown as Observation)
    }).not.toThrow()
    expect(() => {
      pipeline.stop()
    }).not.toThrow()
  })

  it('tells the model the time on a timer so its inactivity bound fires with no traffic', () => {
    // #given an open turn and a clock that jumps past the inactivity bound
    vi.useFakeTimers()
    try {
      const {sink, spans} = collectingSink()
      let now = 1_000
      const pipeline = createTracePipeline({
        sink,
        scrubber,
        now: () => now,
        limits: {tickMs: 1_000},
        modelLimits: {rootInactivityMs: 5_000},
      })
      pipeline.observe({kind: 'prompt', at: 1_000, sessionId: 's', messageId: 'm', content: {text: 'hi'}})
      pipeline.observe({kind: 'inbox.enqueued', at: 1_000, sessionId: 's', inboxId: 'm', item: 'user'})
      pipeline.observe({kind: 'execution.started', at: 1_001, sessionId: 's'})

      // #when time passes with no further observation
      now = 20_000
      vi.advanceTimersByTime(1_500)
      vi.advanceTimersByTime(50)

      // #then the root closed, marked incomplete
      expect(spans.some(span => JSON.stringify(span.attributes).includes('incomplete'))).toBe(true)
      pipeline.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('makes valid ids from the default source', () => {
    // #given / #when
    const ids = randomIds()

    // #then
    expect(ids.trace()).toMatch(/^[0-9a-f]{32}$/)
    expect(ids.span()).toMatch(/^[0-9a-f]{16}$/)
    expect(ids.span()).not.toBe(ids.span())
  })

  it('removes secrets from every exported string, whatever field they were in', async () => {
    // #given a prompt that carries a secret shape
    const secret = ['ghp_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'].join('')
    const {sink, spans} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber})
    const observations = fixture('text-turn').map(observation =>
      observation.kind === 'prompt' ? {...observation, content: {text: `token ${secret}`}} : observation,
    )

    // #when
    for (const observation of observations) pipeline.observe(observation)
    pipeline.stop()

    // #then the secret is in no span
    expect(JSON.stringify(spans)).not.toContain('aB3dE5fG7hJ9')
    expect(JSON.stringify(spans)).toContain('[REDACTED]')
  })
})

describe('the snapshot ledger in the pipeline', () => {
  /** The text turn, with each content field replaced by a real snapshot held in `ledger`, as the hook handlers make them. */
  const snapshotted = (ledger: ReturnType<typeof createSnapshotLedger>): Observation[] =>
    fixture('tool-success-and-error').map(observation => {
      const context = {ledger}
      if (observation.kind === 'prompt') return {...observation, content: snapshotPrompt({text: 'a prompt'}, context)}
      if (observation.kind === 'request') {
        return {
          ...observation,
          content: snapshotRequest({system: [{text: 's'}], messages: [{role: 'user', content: 'hi'}]}, context),
        }
      }
      if (observation.kind === 'tool.before')
        return {...observation, input: snapshotToolArguments({path: 'a'}, context)}
      // As the hook handler does: a failed call carries no result snapshot.
      if (observation.kind === 'tool.after') {
        const result = observation.status === 'completed' ? snapshotToolResult({content: 'body'}, context) : undefined
        return {...observation, result}
      }
      return observation
    })

  it('frees every snapshot once the spans that carried them are exported', () => {
    // #given a ledger and a recorded turn whose content fields are held snapshots
    const ledger = createSnapshotLedger()
    const {sink} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, ledger})
    const observations = snapshotted(ledger)
    for (const observation of observations) pipeline.observe(observation)
    expect(ledger.stats().pending).toBeGreaterThan(0)

    // #when the pipeline stops and every record has been exported
    pipeline.stop()

    // #then nothing is left pending
    expect(ledger.stats()).toMatchObject({pending: 0, pendingChars: 0})
  })

  it('frees the snapshot of an observation it discards for lack of inbox room', () => {
    // #given an inbox of one
    const ledger = createSnapshotLedger()
    const {sink} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, ledger, limits: {maxInbox: 1}})
    const first = {
      kind: 'prompt',
      at: 1,
      sessionId: 's',
      messageId: 'm1',
      content: snapshotPrompt({text: 'one'}, {ledger}),
    } as const
    const second = {
      kind: 'prompt',
      at: 2,
      sessionId: 's',
      messageId: 'm2',
      content: snapshotPrompt({text: 'two'}, {ledger}),
    } as const

    // #when a second observation finds the inbox full
    pipeline.observe(first)
    pipeline.observe(second)

    // #then its snapshot was freed at once; the first is still pending
    expect(pipeline.stats().observationsDropped).toBe(1)
    expect(ledger.stats().pending).toBe(1)
    pipeline.stop()
  })

  it('frees the snapshots of a record it drops for lack of room', () => {
    // #given room for one record
    const ledger = createSnapshotLedger()
    const {sink} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, ledger, limits: {maxRecords: 1}})

    // #when a recording that yields several records is stopped
    for (const observation of snapshotted(ledger)) pipeline.observe(observation)
    pipeline.stop()

    // #then dropped and exported records alike gave their snapshots back
    expect(ledger.stats()).toMatchObject({pending: 0, pendingChars: 0})
  })
})

describe('snapshots the model drops without a span', () => {
  it('are freed: a prompt for a session that never starts an execution gives its snapshot back once the session is idle', async () => {
    // #given a ledger, a pipeline with a short idle limit and a fast tick, and a queued prompt that never runs
    const ledger = createSnapshotLedger()
    const {sink} = collectingSink()
    let clock = 1_000
    const pipeline = createTracePipeline({
      sink,
      scrubber,
      ledger,
      now: () => clock,
      limits: {tickMs: 10},
      modelLimits: {sessionIdleMs: 500},
    })
    const content = snapshotPrompt({text: 'a queued prompt'}, {ledger})
    pipeline.observe({kind: 'prompt', at: clock, sessionId: 'ses_idle', messageId: 'm1', content})
    pipeline.observe({kind: 'inbox.enqueued', at: clock, sessionId: 'ses_idle', inboxId: 'm1', item: 'user'})
    await flush()
    expect(ledger.stats().pending).toBe(1)

    // #when time passes beyond the idle limit and a tick runs
    clock += 600
    await flush()

    // #then the snapshot was released, with no span and no exit through a record
    expect(ledger.stats()).toMatchObject({pending: 0, pendingChars: 0})
    pipeline.stop()
  })

  it('are freed at stop', () => {
    // #given an idle session holding a prompt snapshot
    const ledger = createSnapshotLedger()
    const {sink} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, ledger})
    const content = snapshotPrompt({text: 'held'}, {ledger})
    pipeline.observe({kind: 'prompt', at: 1, sessionId: 'ses_idle', messageId: 'm1', content})
    pipeline.observe({kind: 'inbox.enqueued', at: 2, sessionId: 'ses_idle', inboxId: 'm1', item: 'user'})

    // #when
    pipeline.stop()

    // #then
    expect(ledger.stats().pending).toBe(0)
  })
})
