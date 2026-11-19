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
    add({kind: 'step.started', sessionId: 'a', messageId: 's1', agent: 'build', model: 'm', provider: 'p'})
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
          apply: text => {
            const until = performance.now() + ms
            while (performance.now() < until) {
              // Busy wait: the cost is synchronous, as a big scrub is.
            }
            return {text, count: 0}
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
