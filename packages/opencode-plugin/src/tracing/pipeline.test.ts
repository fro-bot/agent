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

describe('spans the model refuses at its open-span limit', () => {
  /** One turn with one request and `calls` tool calls that never end, so the limit is hit by the later ones. */
  const crowdedTurn = (calls: number): Observation[] => {
    const out: Observation[] = []
    let at = 0
    const add = (observation: Record<string, unknown>): void => {
      at += 1
      out.push({at, ...observation} as Observation)
    }
    add({kind: 'prompt', sessionId: 'a', messageId: 'm1', delivery: 'steer', content: 'hi'})
    add({kind: 'inbox.enqueued', sessionId: 'a', inboxId: 'm1', item: 'user'})
    add({kind: 'execution.started', sessionId: 'a'})
    add({kind: 'inbox.delivered', sessionId: 'a', inboxId: 'm1'})
    add({
      kind: 'request',
      sessionId: 'a',
      requestKind: 'primary',
      agent: 'build',
      model: 'm',
      provider: 'p',
      content: {},
    })
    add({kind: 'step.started', sessionId: 'a', messageId: 's1', started: at, agent: 'build', model: 'm', provider: 'p'})
    for (let index = 0; index < calls; index += 1) {
      add({kind: 'tool.named', sessionId: 'a', callId: `c${index}`, tool: 'read'})
      add({kind: 'tool.called', sessionId: 'a', callId: `c${index}`, executed: false, input: {}})
    }
    // No terminal events: a call that was refused a span stays refused, and the ones that fit close as interrupted.
    add({
      kind: 'step.ended',
      sessionId: 'a',
      messageId: 's1',
      finish: 'stop',
      usage: {input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0},
      cost: 0,
    })
    add({kind: 'execution.ended', sessionId: 'a', outcome: 'succeeded'})
    return out
  }

  it('are counted as dropped at the sink, exactly once each, and the rest are exported', async () => {
    // #given a limit of 4 open spans per trace (the root's request takes one, so three calls fit) and ten calls
    const {sink, spans, dropped} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, modelLimits: {maxOpenSpansPerTrace: 4}})

    // #when the turn runs to its end
    for (const observation of crowdedTurn(10)) pipeline.observe(observation)
    await flush()
    pipeline.stop()

    // #then three calls fit and were exported (interrupted), seven were refused, and the sink was told seven
    const exportedTools = spans.filter(span => span.name.startsWith('execute_tool')).length
    expect(exportedTools).toBe(3)
    expect(dropped()).toBe(7)
  })

  it('are not counted again at stop or on later observations', async () => {
    // #given the same turn, observed, then more traffic, then stop
    const {sink, dropped} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, modelLimits: {maxOpenSpansPerTrace: 4}})
    for (const observation of crowdedTurn(10)) pipeline.observe(observation)
    await flush()
    const afterTurn = dropped()

    // #when a tick and stop follow
    await new Promise(resolve => setTimeout(resolve, 30))
    pipeline.stop()

    // #then the count did not change
    expect(afterTurn).toBeGreaterThan(0)
    expect(dropped()).toBe(afterTurn)
  })

  it('count nothing when nothing was refused', async () => {
    // #given a turn that fits
    const {sink, dropped} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber})
    for (const observation of crowdedTurn(3)) pipeline.observe(observation)
    await flush()
    pipeline.stop()

    // #then
    expect(dropped()).toBe(0)
  })
})

describe('a snapshot shared by a model span and a tool span', () => {
  const USAGE = {input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0}

  it('stays held until both owners have been exported, whichever goes first', async () => {
    // #given a request whose response asked for a call, and the call's argument snapshot (the same object is in the model's
    // record of what was asked and in the open tool span)
    const ledger = createSnapshotLedger()
    const {sink, spans} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, ledger})
    const args = snapshotToolArguments({path: 'a.txt'}, {ledger})
    const at = (n: number) => n
    pipeline.observe({kind: 'prompt', at: at(1), sessionId: 'a', messageId: 'm1', delivery: 'steer', content: 'hi'})
    pipeline.observe({kind: 'inbox.enqueued', at: at(2), sessionId: 'a', inboxId: 'm1', item: 'user'})
    pipeline.observe({kind: 'execution.started', at: at(3), sessionId: 'a'})
    pipeline.observe({kind: 'inbox.delivered', at: at(4), sessionId: 'a', inboxId: 'm1'})
    pipeline.observe({
      kind: 'request',
      at: at(5),
      sessionId: 'a',
      requestKind: 'primary',
      agent: 'build',
      model: 'm',
      provider: 'p',
      content: {},
    })
    pipeline.observe({
      kind: 'step.started',
      at: at(6),
      started: at(6),
      sessionId: 'a',
      messageId: 's1',
      agent: 'build',
      model: 'm',
      provider: 'p',
    })
    pipeline.observe({kind: 'tool.named', at: at(7), sessionId: 'a', callId: 'c1', tool: 'read'})
    pipeline.observe({
      kind: 'tool.called',
      at: at(8),
      sessionId: 'a',
      callId: 'c1',
      messageId: 's1',
      executed: false,
      input: args,
    })

    // #when the model's span goes out first: the step ends while the tool is still running
    pipeline.observe({
      kind: 'step.ended',
      at: at(9),
      sessionId: 'a',
      messageId: 's1',
      finish: 'tool-calls',
      usage: USAGE,
      cost: 0,
    })
    await flush()

    // #then the model span was exported and the tool span still holds the snapshot
    expect(spans.some(span => span.name.startsWith('chat'))).toBe(true)
    expect(ledger.stats().pending).toBeGreaterThanOrEqual(1)
    const stillHeld = ledger.stats().pending

    // #when the tool ends and its span goes out
    pipeline.observe({kind: 'tool.ended', at: at(10), sessionId: 'a', callId: 'c1', succeeded: true})
    pipeline.observe({kind: 'execution.ended', at: at(11), sessionId: 'a', outcome: 'succeeded'})
    await flush()

    // #then it is released, and nothing is left
    expect(stillHeld).toBeGreaterThan(ledger.stats().pending)
    expect(ledger.stats().pending).toBe(0)
    pipeline.stop()
  })

  it('is released once when only one owner exists', async () => {
    // #given a tool call with no model request to share it
    const ledger = createSnapshotLedger()
    const {sink} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, ledger})
    const args = snapshotToolArguments({path: 'b.txt'}, {ledger})
    pipeline.observe({kind: 'prompt', at: 1, sessionId: 'a', messageId: 'm1', delivery: 'steer', content: 'hi'})
    pipeline.observe({kind: 'inbox.enqueued', at: 2, sessionId: 'a', inboxId: 'm1', item: 'user'})
    pipeline.observe({kind: 'execution.started', at: 3, sessionId: 'a'})
    pipeline.observe({kind: 'inbox.delivered', at: 4, sessionId: 'a', inboxId: 'm1'})
    pipeline.observe({kind: 'tool.called', at: 5, sessionId: 'a', callId: 'c1', executed: false, input: args})
    pipeline.observe({kind: 'tool.ended', at: 6, sessionId: 'a', callId: 'c1', succeeded: true})
    pipeline.observe({kind: 'execution.ended', at: 7, sessionId: 'a', outcome: 'succeeded'})
    await flush()

    // #then
    expect(ledger.stats().pending).toBe(0)
    pipeline.stop()
  })
})

describe('stop against a deadline', () => {
  /** A scrubber that burns about `ms` per string, standing in for a large backlog of expensive spans. */
  const slowScrubber = (ms: number) =>
    createScrubber({
      patterns: [
        {
          id: 'slow',
          find: () => {
            const until = performance.now() + ms
            while (performance.now() < until) {
              // Busy wait: the cost is synchronous, as a big scrub is.
            }
          },
        },
      ],
    })

  /** `turns` complete one-step turns in as many sessions, all observed and none yet processed. */
  const backlog = (
    pipeline: ReturnType<typeof createTracePipeline>,
    turns: number,
    ledger: ReturnType<typeof createSnapshotLedger>,
  ) => {
    for (let index = 0; index < turns; index += 1) {
      const session = `s${index}`
      const at = index * 10
      pipeline.observe({
        kind: 'prompt',
        at: at + 1,
        sessionId: session,
        messageId: 'm',
        delivery: 'steer',
        content: snapshotPrompt({text: 'hi'}, {ledger}),
      })
      pipeline.observe({kind: 'inbox.enqueued', at: at + 2, sessionId: session, inboxId: 'm', item: 'user'})
      pipeline.observe({kind: 'execution.started', at: at + 3, sessionId: session})
      pipeline.observe({kind: 'inbox.delivered', at: at + 4, sessionId: session, inboxId: 'm'})
      pipeline.observe({
        kind: 'request',
        at: at + 5,
        sessionId: session,
        requestKind: 'primary',
        agent: 'build',
        model: 'm',
        provider: 'p',
        content: snapshotRequest({system: [{text: 's'}], messages: [], tools: {}}, {ledger}),
      })
      pipeline.observe({
        kind: 'step.started',
        at: at + 6,
        started: at + 6,
        sessionId: session,
        messageId: 's',
        agent: 'build',
        model: 'm',
        provider: 'p',
      })
      pipeline.observe({
        kind: 'step.ended',
        at: at + 7,
        sessionId: session,
        messageId: 's',
        finish: 'stop',
        usage: {input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0},
        cost: 0,
      })
      pipeline.observe({kind: 'execution.ended', at: at + 8, sessionId: session, outcome: 'succeeded'})
    }
  }

  it('does the whole backlog when it fits the deadline', () => {
    // #given a small backlog and a generous deadline
    const ledger = createSnapshotLedger()
    const {sink, spans, dropped} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, ledger, limits: {sliceMs: 1_000}})
    backlog(pipeline, 5, ledger)

    // #when
    pipeline.stop(5_000)

    // #then everything was exported, nothing dropped, nothing held
    expect(spans.filter(span => span.name.startsWith('invoke_agent'))).toHaveLength(5)
    expect(dropped()).toBe(0)
    expect(ledger.stats().pending).toBe(0)
  })

  it('stops at the deadline, drops and counts the rest, and releases their snapshots', () => {
    // #given 60 turns at about 3 ms per string and a deadline of 60 ms: far less time than the whole needs
    const ledger = createSnapshotLedger()
    const {sink, spans, dropped} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber: slowScrubber(3), ledger, limits: {sliceMs: 1_000}})
    backlog(pipeline, 60, ledger)

    // #when
    const started = performance.now()
    pipeline.stop(60)
    const elapsed = performance.now() - started

    // #then it came back near the deadline (one string's cost over, at most), exported some, dropped the rest, and holds nothing
    expect(elapsed).toBeLessThan(60 + 400)
    const exported = spans.filter(span => span.name.startsWith('invoke_agent') || span.name.startsWith('chat')).length
    expect(exported).toBeGreaterThan(0)
    expect(exported).toBeLessThan(120)
    expect(dropped()).toBeGreaterThan(0)
    expect(ledger.stats()).toMatchObject({pending: 0, pendingChars: 0})
  })

  it('counts every span as exported or dropped, none twice and none lost', () => {
    // #given the same backlog with a record per span: 60 turns make 120 spans (a root and a model call each)
    const ledger = createSnapshotLedger()
    const {sink, spans, dropped} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber: slowScrubber(3), ledger, limits: {sliceMs: 1_000}})
    backlog(pipeline, 60, ledger)

    // #when
    pipeline.stop(60)

    // #then exported plus dropped is the whole
    expect(spans.length + dropped()).toBe(120)
  })

  it('with no time left reports every unprocessed observation as lost and releases its snapshots', () => {
    // #given a backlog and a deadline that has already passed
    const ledger = createSnapshotLedger()
    const {sink, spans, dropped} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, ledger, limits: {sliceMs: 1_000}})
    backlog(pipeline, 10, ledger)

    // #when
    pipeline.stop(0)

    // #then nothing was exported, the eighty observations were never turned into spans and are reported as lost, and the
    // ledger is empty
    expect(spans).toHaveLength(0)
    expect(dropped()).toBe(0)
    expect(pipeline.stats().observationsDropped).toBe(80)
    expect(ledger.stats().pending).toBe(0)
  })

  it('keeps no work after stop: a later observation does nothing', () => {
    // #given a stopped pipeline
    const {sink, spans} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber})
    pipeline.stop(100)

    // #when
    for (const observation of fixture('text-turn')) pipeline.observe(observation)

    // #then
    expect(spans).toHaveLength(0)
  })
})

describe('the inbox holds a bounded amount of raw text', () => {
  const MIB = 1024 * 1024
  const turnStart = (pipeline: ReturnType<typeof createTracePipeline>, session = 'a'): void => {
    pipeline.observe({kind: 'prompt', at: 1, sessionId: session, messageId: 'm1', delivery: 'steer', content: 'hi'})
    pipeline.observe({kind: 'inbox.enqueued', at: 2, sessionId: session, inboxId: 'm1', item: 'user'})
    pipeline.observe({kind: 'execution.started', at: 3, sessionId: session})
    pipeline.observe({kind: 'inbox.delivered', at: 4, sessionId: session, inboxId: 'm1'})
    pipeline.observe({
      kind: 'request',
      at: 5,
      sessionId: session,
      requestKind: 'primary',
      agent: 'build',
      model: 'm',
      provider: 'p',
      content: {},
    })
    pipeline.observe({
      kind: 'step.started',
      at: 6,
      started: 6,
      sessionId: session,
      messageId: 's1',
      agent: 'build',
      model: 'm',
      provider: 'p',
    })
  }
  const output = (pipeline: ReturnType<typeof createTracePipeline>, at: number, text: string): void =>
    pipeline.observe({kind: 'output', at, sessionId: 'a', messageId: 's1', part: 'text', text})
  const turnEnd = (pipeline: ReturnType<typeof createTracePipeline>): void => {
    pipeline.observe({
      kind: 'step.ended',
      at: 900,
      sessionId: 'a',
      messageId: 's1',
      finish: 'stop',
      usage: {input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0},
      cost: 0,
    })
    pipeline.observe({kind: 'execution.ended', at: 901, sessionId: 'a', outcome: 'succeeded'})
  }
  const chatOf = (spans: readonly ScrubbedSpan[]) => spans.find(span => span.name.startsWith('chat'))

  it('replaces an observation over the remaining budget by its structure, with the content marked omitted, never clipped', async () => {
    // #given a budget of 3 MiB and five 1 MiB outputs queued before the pipeline has drained anything
    const {sink, spans} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, limits: {maxInboxChars: 3 * MIB}})
    turnStart(pipeline)
    for (let index = 0; index < 5; index += 1) output(pipeline, 10 + index, `${String(index)}`.repeat(MIB))
    turnEnd(pipeline)
    expect(pipeline.stats().inboxChars).toBeLessThanOrEqual(3 * MIB)

    // #when it drains
    await flush()
    pipeline.stop()

    // #then the turn is still one model span with its usage; the content that did not fit is omitted whole (no part of it),
    // and the span says so
    const chat = chatOf(spans)
    expect(chat).toBeDefined()
    const attributes = JSON.stringify(chat?.attributes)
    expect(attributes).toContain('output-omitted')
    expect(attributes).not.toMatch(/4{1000}/)
    expect(pipeline.stats().inboxChars).toBe(0)
  })

  it('keeps what fits, whole, and counts the omitted observations', async () => {
    // #given a budget that holds two of three outputs
    const {sink, spans} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, limits: {maxInboxChars: 2_500}})
    turnStart(pipeline)
    output(pipeline, 10, 'a'.repeat(1_000))
    output(pipeline, 11, 'b'.repeat(1_000))
    output(pipeline, 12, 'c'.repeat(1_000))
    turnEnd(pipeline)

    // #when
    await flush()
    pipeline.stop()

    // #then the first two are whole in the span, the third is not there at all
    const text = JSON.stringify(chatOf(spans)?.attributes['gen_ai.output.messages'])
    expect(text).toContain('a'.repeat(1_000))
    expect(text).toContain('b'.repeat(1_000))
    expect(text).not.toContain('c'.repeat(10))
    expect(pipeline.stats().observationsOmitted).toBe(1)
  })

  it('gives the budget back as the loop drains, so later observations are kept', async () => {
    // #given a budget of one output at a time
    const {sink, spans} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, limits: {maxInboxChars: 1_500}})
    turnStart(pipeline)
    output(pipeline, 10, 'a'.repeat(1_000))
    await flush()

    // #when the inbox has drained and another arrives
    expect(pipeline.stats().inboxChars).toBe(0)
    output(pipeline, 11, 'b'.repeat(1_000))
    turnEnd(pipeline)
    await flush()
    pipeline.stop()

    // #then both were kept
    const text = JSON.stringify(chatOf(spans)?.attributes['gen_ai.output.messages'])
    expect(text).toContain('a'.repeat(1_000))
    expect(text).toContain('b'.repeat(1_000))
    expect(pipeline.stats().observationsOmitted).toBe(0)
  })

  it('counts a title, a compaction summary and an error message the same way', async () => {
    // #given a budget of 500 and observations that carry 1,000 characters each of the three kinds
    const {sink} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, limits: {maxInboxChars: 500}})
    pipeline.observe({kind: 'title', at: 1, sessionId: 'a', title: 't'.repeat(1_000)})
    pipeline.observe({kind: 'compaction.ended', at: 2, sessionId: 'a', ok: true, text: 's'.repeat(1_000)})
    pipeline.observe({
      kind: 'execution.ended',
      at: 3,
      sessionId: 'a',
      outcome: 'failed',
      error: {type: 'x', message: 'e'.repeat(1_000)},
    })

    // #then none of it is held
    expect(pipeline.stats().inboxChars).toBeLessThanOrEqual(500)
    expect(pipeline.stats().observationsOmitted).toBe(3)
    pipeline.stop()
  })

  it('counts a budget exactly at the limit as fitting, and one character more as omitted', () => {
    // #given the characters the turn's opening already holds, and an output whose identifiers are 7 characters (`a`, `s1`, `text`)
    const probe = createTracePipeline({sink: collectingSink().sink, scrubber, limits: {maxInboxChars: 10_000_000}})
    turnStart(probe)
    const opening = probe.stats().inboxChars
    probe.stop()
    const exact = opening + 7 + 1_000
    const at = createTracePipeline({sink: collectingSink().sink, scrubber, limits: {maxInboxChars: exact}})
    const over = createTracePipeline({sink: collectingSink().sink, scrubber, limits: {maxInboxChars: exact - 1}})
    turnStart(at)
    turnStart(over)

    // #when the same 1,000-character output reaches each
    output(at, 10, 'a'.repeat(1_000))
    output(over, 10, 'a'.repeat(1_000))

    // #then it fits exactly, and one character short it is omitted
    expect(at.stats().observationsOmitted).toBe(0)
    expect(at.stats().inboxChars).toBe(exact)
    expect(over.stats().observationsOmitted).toBe(1)
    at.stop()
    over.stop()
  })
})

describe('every raw string an observation carries is counted at ingress', () => {
  const MIB = 1024 * 1024
  const USAGE = {input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0}
  const budgeted = (maxInboxChars: number, ledger?: ReturnType<typeof createSnapshotLedger>) => {
    const {sink, spans} = collectingSink()
    const pipeline = createTracePipeline({
      sink,
      scrubber,
      ...(ledger === undefined ? {} : {ledger}),
      limits: {maxInboxChars},
    })
    return {pipeline, spans}
  }
  const open = (pipeline: ReturnType<typeof createTracePipeline>, session = 'a'): void => {
    pipeline.observe({kind: 'prompt', at: 1, sessionId: session, messageId: 'm1', delivery: 'steer', content: 'hi'})
    pipeline.observe({kind: 'inbox.enqueued', at: 2, sessionId: session, inboxId: 'm1', item: 'user'})
    pipeline.observe({kind: 'execution.started', at: 3, sessionId: session})
    pipeline.observe({kind: 'inbox.delivered', at: 4, sessionId: session, inboxId: 'm1'})
    pipeline.observe({
      kind: 'request',
      at: 5,
      sessionId: session,
      requestKind: 'primary',
      agent: 'build',
      model: 'm',
      provider: 'p',
      content: {},
    })
    pipeline.observe({
      kind: 'step.started',
      at: 6,
      started: 6,
      sessionId: session,
      messageId: 's1',
      agent: 'build',
      model: 'm',
      provider: 'p',
    })
  }
  const close = (pipeline: ReturnType<typeof createTracePipeline>, at = 90): void => {
    pipeline.observe({kind: 'step.ended', at, sessionId: 'a', messageId: 's1', finish: 'stop', usage: USAGE, cost: 0})
    pipeline.observe({kind: 'execution.ended', at: at + 1, sessionId: 'a', outcome: 'succeeded'})
  }

  it('counts the error message of a tool.after, and keeps the tool’s outcome and error type when it is omitted', async () => {
    // #given a budget of 100 KiB and ten failed calls whose after hook carries a 1 MiB error message each
    const {pipeline, spans} = budgeted(100 * 1024)
    open(pipeline)
    for (let index = 0; index < 10; index += 1) {
      const callId = `c${String(index)}`
      pipeline.observe({kind: 'tool.named', at: 10 + index, sessionId: 'a', callId, tool: 'read'})
      pipeline.observe({kind: 'tool.called', at: 10 + index, sessionId: 'a', callId, executed: false, input: {}})
      pipeline.observe({
        kind: 'tool.after',
        at: 20 + index,
        sessionId: 'a',
        callId,
        tool: 'read',
        status: 'error',
        error: {type: 'tool.execution', message: 'm'.repeat(MIB)},
      })
      pipeline.observe({
        kind: 'tool.ended',
        at: 30 + index,
        sessionId: 'a',
        callId,
        succeeded: false,
        errorType: 'tool.execution',
        message: 'short',
      })
    }
    close(pipeline)

    // #then the inbox never held more than its budget of raw text, even though a megabyte arrived with each call
    expect(pipeline.stats().inboxChars).toBeLessThanOrEqual(100 * 1024)
    expect(pipeline.stats().observationsOmitted).toBeGreaterThanOrEqual(9)

    // #when it drains
    await flush()
    pipeline.stop()

    // #then every call still has its span, with its outcome and error type, and no megabyte of text went out
    const tools = spans.filter(span => span.name.startsWith('execute_tool'))
    expect(tools).toHaveLength(10)
    expect(tools.every(span => span.attributes['fro_bot.tool.outcome'] === 'error')).toBe(true)
    expect(tools.every(span => span.attributes['fro_bot.tool.error_type'] === 'tool.execution')).toBe(true)
    expect(JSON.stringify(spans)).not.toMatch(/m{1000}/)
    expect(pipeline.stats().inboxChars).toBe(0)
  })

  it('keeps a snapshot the replacement still owns charged in the ledger, and frees it only when its span goes', async () => {
    // #given a tool call whose result is a held snapshot, and a terminal event whose message is over the budget
    const ledger = createSnapshotLedger()
    const {pipeline} = budgeted(1_000, ledger)
    open(pipeline)
    pipeline.observe({kind: 'tool.named', at: 10, sessionId: 'a', callId: 'c1', tool: 'read'})
    pipeline.observe({kind: 'tool.called', at: 11, sessionId: 'a', callId: 'c1', executed: false, input: {}})
    const result = snapshotToolResult({content: [{type: 'text', text: 'file body'}]}, {ledger})
    const before = ledger.stats().pending
    expect(before).toBeGreaterThanOrEqual(1)

    // #when the observation that owns it is replaced because its message does not fit
    pipeline.observe({
      kind: 'tool.ended',
      at: 12,
      sessionId: 'a',
      callId: 'c1',
      succeeded: true,
      message: 'x'.repeat(5_000),
      result,
    })
    expect(pipeline.stats().observationsOmitted).toBe(1)

    // #then the snapshot is still charged: the replacement still holds it
    expect(ledger.stats().pending).toBe(before)

    // #when the turn ends and the span is exported
    close(pipeline)
    await flush()
    pipeline.stop()

    // #then it is released then, once
    expect(ledger.stats().pending).toBe(0)
  })

  it('does not release a snapshot twice for an observation that is dropped for an oversized identifier', () => {
    // #given a held snapshot in an observation whose call id is absurdly long
    const ledger = createSnapshotLedger()
    const {pipeline} = budgeted(1_000_000, ledger)
    const result = snapshotToolResult({content: [{type: 'text', text: 'b'}]}, {ledger})
    expect(ledger.stats().pending).toBe(1)

    // #when
    pipeline.observe({kind: 'tool.ended', at: 1, sessionId: 'a', callId: 'x'.repeat(10_000), succeeded: true, result})

    // #then it is dropped as malformed, and its snapshot is freed
    expect(pipeline.stats().observationsDropped).toBe(1)
    expect(ledger.stats().pending).toBe(0)
    pipeline.stop()
  })

  it.each([
    ['prompt', {kind: 'prompt', sessionId: 'a', messageId: 'm', delivery: 'steer', content: 'p'.repeat(2_000)}],
    ['request', {kind: 'request', sessionId: 'a', requestKind: 'primary', content: 'r'.repeat(2_000)}],
    ['tool.called', {kind: 'tool.called', sessionId: 'a', callId: 'c', executed: false, input: 'i'.repeat(2_000)}],
    ['tool.before', {kind: 'tool.before', sessionId: 'a', callId: 'c', tool: 'read', input: 'i'.repeat(2_000)}],
    [
      'tool.after (error text)',
      {
        kind: 'tool.after',
        sessionId: 'a',
        callId: 'c',
        tool: 'read',
        status: 'error',
        error: {type: 't', message: 'e'.repeat(2_000)},
      },
    ],
    [
      'tool.after (raw result)',
      {kind: 'tool.after', sessionId: 'a', callId: 'c', tool: 'read', status: 'completed', result: 'r'.repeat(2_000)},
    ],
    [
      'tool.ended (message)',
      {kind: 'tool.ended', sessionId: 'a', callId: 'c', succeeded: false, message: 'e'.repeat(2_000)},
    ],
    [
      'tool.ended (raw result)',
      {kind: 'tool.ended', sessionId: 'a', callId: 'c', succeeded: true, result: 'r'.repeat(2_000)},
    ],
    [
      'retry',
      {kind: 'retry', sessionId: 'a', attempt: 2, willRetry: true, error: {type: 't', message: 'e'.repeat(2_000)}},
    ],
    [
      'step.failed',
      {kind: 'step.failed', sessionId: 'a', messageId: 's', error: {type: 't', message: 'e'.repeat(2_000)}},
    ],
    [
      'execution.ended (reason)',
      {kind: 'execution.ended', sessionId: 'a', outcome: 'failed', reason: 'e'.repeat(2_000)},
    ],
    ['compaction.started (reason)', {kind: 'compaction.started', sessionId: 'a', reason: 'e'.repeat(2_000)}],
    [
      'compaction.ended (error)',
      {kind: 'compaction.ended', sessionId: 'a', ok: false, error: {type: 't', message: 'e'.repeat(2_000)}},
    ],
    ['title', {kind: 'title', sessionId: 'a', title: 't'.repeat(2_000)}],
    ['output', {kind: 'output', sessionId: 'a', messageId: 's', part: 'text', text: 'o'.repeat(2_000)}],
  ] as const)('counts the raw text of a %s observation against the budget', (_label, observation) => {
    // #given a budget of 1,000 and one observation carrying 2,000 characters of raw text
    const {pipeline} = budgeted(1_000)

    // #when
    pipeline.observe(observation as unknown as Observation)

    // #then the text was not held: it was omitted at ingress, and what the inbox holds is within the budget
    expect(pipeline.stats().observationsOmitted).toBe(1)
    expect(pipeline.stats().inboxChars).toBeLessThanOrEqual(1_000)
    pipeline.stop()
  })

  it.each([
    ['sessionId', {kind: 'usage', sessionId: 's'.repeat(10_000)}],
    ['messageId', {kind: 'step.started', sessionId: 'a', messageId: 'm'.repeat(10_000)}],
    ['model', {kind: 'request', sessionId: 'a', requestKind: 'primary', model: 'm'.repeat(10_000)}],
    ['tool name', {kind: 'tool.named', sessionId: 'a', callId: 'c', tool: 't'.repeat(10_000)}],
    ['error type', {kind: 'retry', sessionId: 'a', attempt: 2, willRetry: true, error: {type: 't'.repeat(10_000)}}],
  ] as const)(
    'drops an observation with an absurdly long %s, since an identifier that size is not real',
    (_label, observation) => {
      // #given
      const {pipeline} = budgeted(1_000_000)

      // #when
      pipeline.observe(observation as unknown as Observation)

      // #then
      expect(pipeline.stats().observationsDropped).toBe(1)
      expect(pipeline.stats().inboxChars).toBe(0)
      pipeline.stop()
    },
  )

  it('accepts an identifier of exactly 512 characters, and drops one of 513 as malformed, freeing its snapshot', () => {
    // #given a ledger, and two tool.ended observations whose call ids are 512 and 513 characters, each holding a snapshot
    const ledger = createSnapshotLedger()
    const {pipeline} = budgeted(1_000_000, ledger)
    const held = (text: string) => snapshotToolResult({content: [{type: 'text', text}]}, {ledger})

    // #when
    pipeline.observe({
      kind: 'tool.ended',
      at: 1,
      sessionId: 'a',
      callId: 'x'.repeat(512),
      succeeded: true,
      result: held('one'),
    })
    const afterAt = {dropped: pipeline.stats().observationsDropped, pending: ledger.stats().pending}
    pipeline.observe({
      kind: 'tool.ended',
      at: 2,
      sessionId: 'a',
      callId: 'x'.repeat(513),
      succeeded: true,
      result: held('two'),
    })

    // #then the 512 one was accepted (and still holds its snapshot), the 513 one was dropped and its snapshot freed
    expect(afterAt).toEqual({dropped: 0, pending: 1})
    expect(pipeline.stats().observationsDropped).toBe(1)
    expect(ledger.stats().pending).toBe(1)
    pipeline.stop()
    expect(ledger.stats().pending).toBe(0)
  })

  it('counts identifiers and labels in the same budget, and never omits them', () => {
    // #given a budget of 100 and an observation whose identifiers add up to more
    const {pipeline} = budgeted(100)

    // #when
    pipeline.observe({
      kind: 'step.started',
      at: 1,
      started: 1,
      sessionId: 's'.repeat(60),
      messageId: 'm'.repeat(60),
      agent: 'a',
      model: 'm',
      provider: 'p',
    })

    // #then it was not replaced (identifiers are structure), and the inbox holds what it holds
    expect(pipeline.stats().observationsOmitted).toBe(0)
    expect(pipeline.stats().inboxChars).toBeGreaterThanOrEqual(120)
    pipeline.stop()
  })
})

describe('an observation the pipeline drops is told to the model, in order, by a marker that cannot be dropped', () => {
  const USAGE = {input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0}
  const session = 'p'
  const base = (): Observation[] => [
    {kind: 'execution.started', at: 1, sessionId: session},
    {
      kind: 'request',
      at: 2,
      sessionId: session,
      requestKind: 'primary',
      agent: 'build',
      model: 'm',
      provider: 'p',
      content: {},
    },
  ]
  const turn = (): Observation[] => [
    {
      kind: 'step.started',
      at: 3,
      started: 3,
      sessionId: session,
      messageId: 's1',
      agent: 'build',
      model: 'm',
      provider: 'p',
    },
    {kind: 'output', at: 4, sessionId: session, messageId: 's1', part: 'text', text: 'the step text'},
    {
      kind: 'step.ended',
      at: 5,
      sessionId: session,
      messageId: 's1',
      finish: 'stop',
      rawFinish: 'stop',
      usage: USAGE,
      cost: 0,
    },
    {kind: 'execution.ended', at: 6, sessionId: session, outcome: 'succeeded'},
  ]
  const chatSpan = (spans: readonly ScrubbedSpan[]) => spans.find(span => span.name.startsWith('chat'))

  it('lets a full inbox lose an observation and still reach the model with a marker, so the session’s binding is uncertain', async () => {
    // #given an inbox of three, filled by the setup and one more observation (the step's start), which does not fit
    const {sink, spans} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, limits: {maxInbox: 3}})
    for (const observation of [...base(), {kind: 'usage', at: 2, sessionId: session} as Observation])
      pipeline.observe(observation)

    // #when the rest of the turn is handed over while it is still full, then everything drains
    for (const observation of turn()) pipeline.observe(observation)
    await flush()
    pipeline.stop()

    // #then the lost step.started told the model, so the span carries none of the step's text, and says why
    expect(pipeline.stats().observationsDropped).toBeGreaterThan(0)
    const chat = chatSpan(spans)
    expect(chat?.attributes['fro_bot.span.gaps']).toContain('step-binding-uncertain')
    expect(JSON.stringify(spans)).not.toContain('the step text')
  })

  it('keeps the marker in its place in the sequence: what was queued before the loss is seen before it, and what arrives after it, after', async () => {
    // #given a turn whose first step complete, then a loss, then a second step
    const {sink, spans} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, limits: {maxInbox: 6}})
    for (const observation of [...base(), ...turn().slice(0, 3)]) pipeline.observe(observation)
    for (let index = 0; index < 7; index += 1) pipeline.observe({kind: 'usage', at: 7 + index, sessionId: 'other'})
    pipeline.observe({kind: 'execution.ended', at: 30, sessionId: session, outcome: 'succeeded'})
    await flush()
    pipeline.stop()

    // #then the first request's own step was queued before any loss, so it keeps its data
    expect(JSON.stringify(spans)).toContain('the step text')
  })

  it('never drops the marker itself: a stream of losses under a full inbox leaves the model told, and the inbox stays bounded', async () => {
    // #given an inbox of two and a hundred observations for the same session handed over before the loop runs
    const {sink, spans} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, limits: {maxInbox: 2}})
    for (const observation of base()) pipeline.observe(observation)
    for (let index = 0; index < 100; index += 1) pipeline.observe({kind: 'usage', at: 3 + index, sessionId: session})
    const dropped = pipeline.stats().observationsDropped
    await flush()
    for (const observation of turn()) pipeline.observe(observation)
    await flush()
    pipeline.stop()

    // #then they were dropped, the model was told once, in a marker, and the later step bound nothing
    expect(dropped).toBeGreaterThanOrEqual(98)
    expect(chatSpan(spans)?.attributes['fro_bot.span.gaps']).toContain('step-binding-uncertain')
    expect(JSON.stringify(spans)).not.toContain('the step text')
  })

  it('tells the model about an observation dropped for an oversized identifier', async () => {
    // #given a request waiting for its step, then an observation of the same session whose tool name is not a real identifier
    const {sink, spans} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber})
    for (const observation of base()) pipeline.observe(observation)
    pipeline.observe({kind: 'tool.named', at: 2, sessionId: session, callId: 'c', tool: 't'.repeat(5000)})
    for (const observation of turn()) pipeline.observe(observation)
    await flush()
    pipeline.stop()

    // #then the lost observation means the request waiting for its step may have lost that step's start
    expect(pipeline.stats().observationsDropped).toBe(1)
    expect(JSON.stringify(spans)).not.toContain('the step text')
    expect(spans.some(span => String(span.attributes['fro_bot.span.gaps']).includes('step-binding-uncertain'))).toBe(
      true,
    )
  })

  it('tells the model about an observation it failed on, before anything else it sees', async () => {
    // #given a request waiting for its step, and a step.started that reads fine at the door and throws inside the model
    const {sink, spans} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber})
    for (const observation of base()) pipeline.observe(observation)
    let reads = 0
    const hostile = {
      kind: 'step.started',
      at: 3,
      started: 3,
      sessionId: session,
      get messageId(): string {
        reads += 1
        if (reads > 1) throw new Error('hostile')
        return 's1'
      },
      agent: 'build',
      model: 'm',
      provider: 'p',
    } as unknown as Observation
    pipeline.observe(hostile)
    await flush()

    // #when the rest of the turn arrives
    for (const observation of turn().slice(1)) pipeline.observe(observation)
    await flush()
    pipeline.stop()

    // #then the session is uncertain from the failure on: the step's text is on no span
    expect(pipeline.stats().observationsDropped).toBe(1)
    expect(JSON.stringify(spans)).not.toContain('the step text')
    expect(spans.some(span => String(span.attributes['fro_bot.span.gaps']).includes('step-binding-uncertain'))).toBe(
      true,
    )
  })

  it('names every session for a drop it cannot attribute (an observation with no session id)', async () => {
    // #given two sessions each waiting for a step, with the inbox exactly full, and an observation with no session that does not fit
    const {sink, spans} = collectingSink()
    const pipeline = createTracePipeline({sink, scrubber, limits: {maxInbox: 4}})
    for (const observation of base()) pipeline.observe(observation)
    pipeline.observe({kind: 'execution.started', at: 1, sessionId: 'q'})
    pipeline.observe({
      kind: 'request',
      at: 2,
      sessionId: 'q',
      requestKind: 'primary',
      agent: 'build',
      model: 'm',
      provider: 'p',
      content: {},
    })
    pipeline.observe({kind: 'tick', at: 3})
    expect(pipeline.stats().observationsDropped).toBe(1)
    await flush()

    // #when both sessions then deliver a complete step
    for (const sessionId of [session, 'q']) {
      pipeline.observe({
        kind: 'step.started',
        at: 4,
        started: 4,
        sessionId,
        messageId: `s-${sessionId}`,
        agent: 'build',
        model: 'm',
        provider: 'p',
      })
      pipeline.observe({
        kind: 'output',
        at: 5,
        sessionId,
        messageId: `s-${sessionId}`,
        part: 'text',
        text: `text of ${sessionId}`,
      })
      pipeline.observe({
        kind: 'step.ended',
        at: 6,
        sessionId,
        messageId: `s-${sessionId}`,
        finish: 'stop',
        rawFinish: 'stop',
        usage: USAGE,
        cost: 0,
      })
      pipeline.observe({kind: 'execution.ended', at: 7, sessionId, outcome: 'succeeded'})
    }
    await flush()
    pipeline.stop()

    // #then neither is trusted
    expect(JSON.stringify(spans)).not.toContain('text of')
    expect(
      spans.filter(span => String(span.attributes['fro_bot.span.gaps']).includes('step-binding-uncertain')),
    ).toHaveLength(2)
  })
})

describe('a sink that throws while the pipeline reports a drop', () => {
  it('does not turn the sink’s failure into a loss marker per pass: the queue drains and stop() finishes', async () => {
    // #given a sink whose `drop` throws, and a model that refuses its second span so a drop must be reported
    const spans: ScrubbedSpan[] = []
    let calls = 0
    const sink: SpanSink = {
      export: span => {
        spans.push(span)
      },
      drop: () => {
        calls += 1
        throw new Error('sink is down')
      },
    }
    const pipeline = createTracePipeline({sink, scrubber, modelLimits: {maxOpenSpansPerTrace: 1}})
    const session = 'p'
    const observations: Observation[] = [
      {kind: 'execution.started', at: 1, sessionId: session},
      {
        kind: 'request',
        at: 2,
        sessionId: session,
        requestKind: 'primary',
        agent: 'build',
        model: 'm',
        provider: 'p',
        content: {},
      },
      {
        kind: 'request',
        at: 3,
        sessionId: session,
        requestKind: 'primary',
        agent: 'build',
        model: 'm',
        provider: 'p',
        content: {},
      },
      {
        kind: 'step.started',
        at: 4,
        started: 2,
        sessionId: session,
        messageId: 's1',
        agent: 'build',
        model: 'm',
        provider: 'p',
      },
      {kind: 'output', at: 5, sessionId: session, messageId: 's1', part: 'text', text: 'first answer'},
      {
        kind: 'step.ended',
        at: 6,
        sessionId: session,
        messageId: 's1',
        finish: 'stop',
        rawFinish: 'stop',
        usage: {input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0},
        cost: 0,
      },
      {kind: 'execution.ended', at: 7, sessionId: session, outcome: 'succeeded'},
    ]

    // #when everything is observed and the pipeline runs and stops (bounded, so a loop shows as a failure, not a hang)
    for (const observation of observations) pipeline.observe(observation)
    await flush()
    const started = performance.now()
    pipeline.stop(2_000)

    // #then it finished well inside the bound, lost nothing to the sink's failure, and the first request kept its own answer
    expect(performance.now() - started).toBeLessThan(1_500)
    expect(pipeline.stats().observationsDropped).toBe(0)
    expect(calls).toBeGreaterThan(0)
    expect(JSON.stringify(spans)).toContain('first answer')
  })
})
