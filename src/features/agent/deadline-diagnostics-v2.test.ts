import type {LifecycleSpan} from '../../shared/lifecycle-tracer.js'
import {createOwnershipLedger, shellLedgerKey} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  createEventTrailV2,
  describeDeadlineStateV2,
  EVENT_TRAIL_MAX_BYTES,
  EVENT_TRAIL_MAX_ENTRIES,
  recordFrameV2,
  reportDeadlineDiagnosticsV2,
} from './deadline-diagnostics-v2.js'
import {createActivityTrackerV2} from './streaming-v2.js'

const ROOT = 'ses_rootAAAAAA111111'
const CHILD = 'ses_childBBBBBB222222'
const CANARY = 'CANARY-payload-text-9f3a'

function record(
  trail: ReturnType<typeof createEventTrailV2>,
  frame: unknown,
  nowMs: number,
  owned: readonly string[] = [],
): void {
  recordFrameV2(trail, frame, {rootSessionId: ROOT, isOwned: id => owned.includes(id), nowMs})
}

function typed(type: string, sessionID?: string, extra: Record<string, unknown> = {}): unknown {
  return {type, data: {...(sessionID === undefined ? {} : {sessionID}), ...extra}}
}

describe('event trail', () => {
  it('keeps the last entries, oldest first, and no more than the entry cap', () => {
    // #given more distinct events than the cap
    const trail = createEventTrailV2()
    const total = EVENT_TRAIL_MAX_ENTRIES + 10

    // #when
    for (let index = 0; index < total; index++) record(trail, typed(`session.event${index}`, ROOT), 1_000 + index)

    // #then only the newest remain, in arrival order
    expect(trail.entries).toHaveLength(EVENT_TRAIL_MAX_ENTRIES)
    expect(trail.entries[0]?.type).toBe('session.event10')
    expect(trail.entries.at(-1)?.type).toBe(`session.event${total - 1}`)
    const times = trail.entries.map(entry => entry.atMs)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('stays inside its byte cap even when every type is as long as one may be', () => {
    // #given the longest type name an entry accepts, on a session, repeated with distinct names
    const trail = createEventTrailV2()
    const long = (index: number): string => `session.${'x'.repeat(50)}${String(index).padStart(4, '0')}`

    // #when
    for (let index = 0; index < 100; index++) record(trail, typed(long(index), ROOT), index)

    // #then
    expect(trail.bytes).toBeLessThanOrEqual(EVENT_TRAIL_MAX_BYTES)
    expect(trail.entries.length).toBeLessThan(EVENT_TRAIL_MAX_ENTRIES)
    const measured = trail.entries.reduce((sum, entry) => sum + entry.type.length + (entry.session?.length ?? 0), 0)
    expect(measured).toBeLessThanOrEqual(EVENT_TRAIL_MAX_BYTES)
    expect(trail.entries.at(-1)?.type).toBe(long(99))
  })

  it('folds consecutive repeats of one event into a single counted entry, so a token burst cannot push history out', () => {
    // #given earlier history, then a burst of deltas from the same session
    const trail = createEventTrailV2()
    record(trail, typed('session.execution.started', ROOT), 1)
    for (let index = 0; index < 300; index++)
      record(trail, typed('session.text.delta', ROOT, {delta: CANARY}), 2 + index)
    record(trail, typed('session.compaction.started', ROOT, {reason: 'auto'}), 400)

    // #then
    expect(trail.entries.map(entry => [entry.type, entry.count])).toEqual([
      ['session.execution.started', 1],
      ['session.text.delta', 300],
      ['session.compaction.started', 1],
    ])
    // The folded entry keeps the time of its LAST event.
    expect(trail.entries[1]?.atMs).toBe(301)
  })

  it('records the event type, role, session suffix and time, and never the payload', () => {
    // #given frames that carry text, input and an unrelated field with a recognizable value
    const trail = createEventTrailV2()

    // #when
    record(trail, typed('session.text.delta', ROOT, {delta: CANARY, text: CANARY, input: {command: CANARY}}), 10)
    record(trail, typed('session.tool.called', CHILD, {input: {command: CANARY}}), 11, [CHILD])
    record(trail, typed('server.heartbeat', undefined, {note: CANARY}), 12)

    // #then
    expect(JSON.stringify(trail)).not.toContain(CANARY)
    expect(trail.entries.map(entry => ({...entry}))).toEqual([
      {type: 'session.text.delta', role: 'root', session: '111111', atMs: 10, count: 1},
      {type: 'session.tool.called', role: 'child', session: '222222', atMs: 11, count: 1},
      {type: 'server.heartbeat', role: 'server', session: null, atMs: 12, count: 1},
    ])
  })

  it('replaces a type name that is not a plain dotted lowercase name, and a session id that is not a plain id', () => {
    // #given
    const trail = createEventTrailV2()

    // #when
    record(trail, typed(`session.${CANARY} with spaces`, ROOT), 1)
    record(trail, typed('x'.repeat(200), ROOT), 3)
    // An id that is not a plain id names no session, so it is not the run's: dropped like any other session-less frame.
    record(trail, typed('session.ok', `ses_${CANARY} !`), 2)

    // #then
    expect(JSON.stringify(trail)).not.toContain(CANARY)
    // Both are the one `unknown` of the root, folded.
    expect(trail.entries.map(entry => [entry.type, entry.count])).toEqual([['unknown', 2]])
  })

  describe('keeps unrelated sessions out', () => {
    it('drops the frames of a session the run does not own, whole: no type, suffix or time', () => {
      // #given the run's own events around a stranger's, on a server that serves every location
      const trail = createEventTrailV2()

      // #when
      record(trail, typed('session.execution.started', ROOT), 1)
      record(trail, typed('session.text.delta', 'ses_stranger333333', {delta: CANARY}), 2)
      record(trail, typed('session.stranger-only.type', 'ses_stranger333333'), 3)
      record(trail, typed('session.tool.called', CHILD, {}), 4, [CHILD])

      // #then
      expect(trail.entries.map(entry => [entry.type, entry.role, entry.atMs])).toEqual([
        ['session.execution.started', 'root', 1],
        ['session.tool.called', 'child', 4],
      ])
      expect(JSON.stringify(trail)).not.toContain('333333')
      expect(JSON.stringify(trail)).not.toContain('stranger')
    })

    it('keeps a session-less frame only when its type is on the server-wide allowlist', () => {
      // #given
      const trail = createEventTrailV2()

      // #when
      for (const type of [
        'server.connected',
        'server.heartbeat',
        'shell.exited',
        'experimental.job.updated',
        'vcs.branch.updated',
      ]) {
        record(trail, typed(type, undefined, {id: 'shl_other_run'}), 1)
      }

      // #then
      expect(trail.entries.map(entry => entry.type)).toEqual(['server.connected', 'server.heartbeat'])
    })
  })

  it('ignores a frame that has no type (a keepalive or a stranger shape)', () => {
    // #given
    const trail = createEventTrailV2()

    // #when
    for (const frame of [null, undefined, 'ping', 42, {}, {type: 7}, {data: {sessionID: ROOT}}]) record(trail, frame, 1)

    // #then
    expect(trail.entries).toEqual([])
  })

  describe('compaction state', () => {
    it('holds a compaction that started and never ended, with its reason and start time', () => {
      // #given
      const trail = createEventTrailV2()

      // #when
      record(trail, typed('session.compaction.started', ROOT, {reason: 'auto'}), 5_000)
      record(trail, typed('session.compaction.delta', ROOT, {text: CANARY}), 5_100)

      // #then the delta changes nothing and its text is never read
      expect(trail.rootCompaction).toEqual({session: '111111', role: 'root', reason: 'auto', atMs: 5_000})
      expect(JSON.stringify(trail)).not.toContain(CANARY)
    })

    it('closes it on ended and on failed, and remembers how the last one ended', () => {
      // #given two sessions compacting
      const trail = createEventTrailV2()
      record(trail, typed('session.compaction.started', ROOT, {reason: 'auto'}), 1)
      record(trail, typed('session.compaction.started', CHILD, {reason: 'manual'}), 2, [CHILD])

      // #when
      record(trail, typed('session.compaction.ended', ROOT, {reason: 'auto', text: CANARY}), 3)
      expect(trail.lastCompactionEnd).toBe('ended')
      record(trail, typed('session.compaction.failed', CHILD, {}), 4, [CHILD])

      // #then
      expect(trail.rootCompaction).toBeNull()
      expect(trail.childCompactions.size).toBe(0)
      expect(trail.lastCompactionEnd).toBe('failed')
      expect(JSON.stringify(trail)).not.toContain(CANARY)
    })

    it('drops a reason that is not one of the two the server defines', () => {
      // #given / #when
      const trail = createEventTrailV2()
      record(trail, typed('session.compaction.started', ROOT, {reason: CANARY}), 1)

      // #then
      expect(trail.rootCompaction?.reason).toBeNull()
      expect(JSON.stringify(trail)).not.toContain(CANARY)
    })

    it('bounds the children compactions it holds open', () => {
      // #given / #when
      const trail = createEventTrailV2()
      const children = Array.from({length: 50}, (_, index) => `ses_${String(index).padStart(10, '0')}`)
      for (const [index, child] of children.entries()) {
        record(trail, typed('session.compaction.started', child, {reason: 'auto'}), index, children)
      }

      // #then
      expect(trail.childCompactions.size).toBeLessThanOrEqual(8)
    })

    it("keeps the root's open compaction through enough owned children starting theirs to fill the cap", () => {
      // #given the root's compaction is open
      const trail = createEventTrailV2()
      record(trail, typed('session.compaction.started', ROOT, {reason: 'auto'}), 1)
      const children = Array.from({length: 50}, (_, index) => `ses_${String(index).padStart(10, '0')}`)

      // #when children start theirs, far past the cap
      for (const [index, child] of children.entries()) {
        record(trail, typed('session.compaction.started', child, {reason: 'manual'}), 10 + index, children)
      }

      // #then the root's is still held, first, and is the one the state reports first
      expect(trail.rootCompaction).toMatchObject({role: 'root', reason: 'auto', atMs: 1})
      const tracker = createActivityTrackerV2()
      Object.assign(tracker, {eventTrail: trail})
      const state = describeDeadlineStateV2({tracker, rootSessionId: ROOT, nowMs: 100})
      expect(state.compaction.open[0]).toEqual({role: 'root', session: '111111', reason: 'auto', startedMs: -99})
    })

    it("ignores another session's compaction: it neither shows up nor replaces the root's", () => {
      // #given the root's compaction is open
      const trail = createEventTrailV2()
      record(trail, typed('session.compaction.started', ROOT, {reason: 'auto'}), 1)

      // #when a session of another location starts, then ends, its own
      record(trail, typed('session.compaction.started', 'ses_stranger333333', {reason: 'manual'}), 2)
      record(trail, typed('session.compaction.ended', 'ses_stranger333333', {reason: 'manual'}), 3)

      // #then
      expect(trail.rootCompaction).toMatchObject({reason: 'auto', atMs: 1})
      expect(trail.childCompactions.size).toBe(0)
      expect(trail.lastCompactionEnd).toBeNull()
      const tracker = createActivityTrackerV2()
      Object.assign(tracker, {eventTrail: trail})
      expect(describeDeadlineStateV2({tracker, rootSessionId: ROOT, nowMs: 10}).compaction).toEqual({
        state: 'started-not-ended',
        open: [{role: 'root', session: '111111', reason: 'auto', startedMs: -9}],
      })
    })
  })
})

describe('describeDeadlineStateV2', () => {
  it('names a compaction that started and never ended, with its reason and how long before the deadline it began', () => {
    // #given a root that started a turn and then a compaction, with nothing after it
    const tracker = createActivityTrackerV2()
    tracker.rootExecutionStarted = true
    tracker.rootRunning = true
    record(tracker.eventTrail, typed('session.execution.started', ROOT), 4_000)
    record(tracker.eventTrail, typed('session.compaction.started', ROOT, {reason: 'auto'}), 4_500)

    // #when the deadline fires 60 s later
    const state = describeDeadlineStateV2({tracker, rootSessionId: ROOT, nowMs: 64_500})

    // #then
    expect(state.compaction).toEqual({
      state: 'started-not-ended',
      open: [{role: 'root', session: '111111', reason: 'auto', startedMs: -60_000}],
    })
    expect(state.recentEvents.map(({type, role, session, t}) => ({type, role, session, t}))).toEqual([
      {type: 'session.execution.started', role: 'root', session: '111111', t: -60_500},
      {type: 'session.compaction.started', role: 'root', session: '111111', t: -60_000},
    ])
    expect(state.waitingOn).toEqual(['execution-not-ended'])
  })

  it('reports no compaction when none was seen, and how the last one ended when one was', () => {
    // #given
    const tracker = createActivityTrackerV2()

    // #when / #then
    expect(describeDeadlineStateV2({tracker, rootSessionId: ROOT, nowMs: 1}).compaction).toEqual({
      state: 'none',
      open: [],
    })
    record(tracker.eventTrail, typed('session.compaction.started', ROOT, {reason: 'auto'}), 1)
    record(tracker.eventTrail, typed('session.compaction.ended', ROOT, {reason: 'auto'}), 2)
    expect(describeDeadlineStateV2({tracker, rootSessionId: ROOT, nowMs: 3}).compaction).toEqual({
      state: 'ended',
      open: [],
    })
  })

  it('carries no compaction role, reason or start in the trace when no compaction is open', () => {
    // #given a compaction that started and ended
    const tracker = createActivityTrackerV2()
    record(tracker.eventTrail, typed('session.compaction.started', ROOT, {reason: 'auto'}), 1)
    record(tracker.eventTrail, typed('session.compaction.ended', ROOT, {reason: 'auto'}), 2)
    const addEvent = vi.fn()

    // #when
    reportDeadlineDiagnosticsV2({
      tracker,
      rootSessionId: ROOT,
      logger: createMockLogger(),
      traceSpan: {addEvent} as unknown as LifecycleSpan,
      nowMs: 3,
    })

    // #then
    const attributes = addEvent.mock.calls[0]?.[1] as Record<string, unknown>
    expect(attributes['fro_bot.compaction']).toBe('ended')
    expect(attributes).not.toHaveProperty('fro_bot.compaction.role')
    expect(attributes).not.toHaveProperty('fro_bot.compaction.reason')
    expect(attributes).not.toHaveProperty('fro_bot.compaction.started_ms')
  })

  it('says a notice turn is owed, and which inbox items are still queued', () => {
    // #given the root's turn succeeded, then a completion notice was queued for it
    const tracker = createActivityTrackerV2()
    tracker.rootTerminal = {kind: 'succeeded'}
    tracker.turnOwed = true
    tracker.queuedNoticeInboxIds.add('msg_inboxAAAAAAA1')
    tracker.queuedNoticeInboxIds.add('msg_inboxBBBBBBB2')

    // #when
    const state = describeDeadlineStateV2({tracker, rootSessionId: ROOT, nowMs: 1})

    // #then
    expect(state.waitingOn).toEqual(['notice-turn-owed', 'inbox-queued'])
    expect(state.rootTerminal).toBe('succeeded')
    expect(state.queuedInbox).toEqual({count: 2, ids: ['AAAAA1', 'BBBBB2']})
  })

  it('does not call a root with no result finished: execution-not-ended appears beside a notice blocker', () => {
    // #given a root with no terminal result, a notice turn owed and an item queued, on a trusted stream
    const tracker = createActivityTrackerV2()
    tracker.turnOwed = true
    tracker.queuedNoticeInboxIds.add('msg_inboxAAAAAAA1')

    // #when / #then
    expect(describeDeadlineStateV2({tracker, rootSessionId: ROOT, nowMs: 1}).waitingOn).toEqual([
      'execution-not-ended',
      'notice-turn-owed',
      'inbox-queued',
    ])
  })

  it('does not report a stale notice or inbox as a blocker after a stream drop, and keeps the raw observations', () => {
    // #given a stream that lost events, a notice turn recorded as owed, an item recorded as queued, and no root result
    const tracker = createActivityTrackerV2()
    tracker.streamBlind = true
    tracker.turnOwed = true
    tracker.queuedNoticeInboxIds.add('msg_inboxAAAAAAA1')

    // #when
    const state = describeDeadlineStateV2({tracker, rootSessionId: ROOT, nowMs: 1})

    // #then completion ignores both, so neither is a blocker; the root still has no result
    expect(state.waitingOn).toEqual(['execution-not-ended'])
    expect(state).toMatchObject({turnOwed: true, streamBlind: true, queuedInbox: {count: 1, ids: ['AAAAA1']}})

    // #and a root with a result and nothing else owed is waiting on nothing
    tracker.rootTerminal = {kind: 'succeeded'}
    expect(describeDeadlineStateV2({tracker, rootSessionId: ROOT, nowMs: 1}).waitingOn).toEqual([])
  })

  it('lists outstanding and unknown owned work by id suffix, never by label', () => {
    // #given a root that succeeded with a running child, an unknown child, a settled child and a live shell
    const tracker = createActivityTrackerV2()
    tracker.rootTerminal = {kind: 'succeeded'}
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, `review ${CANARY}`)
    ledger.adopt('ses_unknownCC333333', `label ${CANARY}`)
    ledger.markUnknown('ses_unknownCC333333')
    ledger.adopt('ses_doneDD444444', 'done')
    ledger.settle('ses_doneDD444444')
    ledger.adopt(shellLedgerKey('shl_shellEE555555'), `command ${CANARY}`)

    // #when
    const state = describeDeadlineStateV2({tracker, ledger, rootSessionId: ROOT, nowMs: 1})

    // #then
    expect(state.waitingOn).toEqual(['owned-work-outstanding'])
    expect(state.outstanding).toEqual({
      count: 3,
      entries: [
        {kind: 'child', session: '222222', state: 'outstanding'},
        {kind: 'child', session: '333333', state: 'unknown'},
        {kind: 'shell', session: '555555', state: 'outstanding'},
      ],
    })
    expect(JSON.stringify(state)).not.toContain(CANARY)
  })

  it('caps the outstanding list and counts the rest', () => {
    // #given
    const tracker = createActivityTrackerV2()
    const ledger = createOwnershipLedger()
    for (let index = 0; index < 40; index++) ledger.adopt(`ses_child${String(index).padStart(8, '0')}`, 'child')

    // #when
    const state = describeDeadlineStateV2({tracker, ledger, rootSessionId: ROOT, nowMs: 1})

    // #then
    expect(state.outstanding.count).toBe(40)
    expect(state.outstanding.entries.length).toBeLessThan(40)
  })

  it('reports nothing to wait on for a root whose turn ended with no work owed', () => {
    // #given
    const tracker = createActivityTrackerV2()
    tracker.rootTerminal = {kind: 'failed'}

    // #when / #then
    expect(describeDeadlineStateV2({tracker, rootSessionId: ROOT, nowMs: 1}).waitingOn).toEqual([])
  })
})

function stalledOnCompaction() {
  const tracker = createActivityTrackerV2()
  tracker.rootExecutionStarted = true
  tracker.rootRunning = true
  record(tracker.eventTrail, typed('session.execution.started', ROOT), 4_000)
  record(tracker.eventTrail, typed('session.text.delta', ROOT, {delta: CANARY}), 4_200)
  record(tracker.eventTrail, typed('session.compaction.started', ROOT, {reason: 'auto'}), 4_500)
  return tracker
}

describe('reportDeadlineDiagnosticsV2', () => {
  it('logs one warning that names the compaction, the open execution and the recent events', () => {
    // #given
    const logger = createMockLogger()

    // #when
    reportDeadlineDiagnosticsV2({tracker: stalledOnCompaction(), rootSessionId: ROOT, logger, nowMs: 64_500})

    // #then
    expect(logger.warning).toHaveBeenCalledTimes(1)
    const [message, context] = vi.mocked(logger.warning).mock.calls[0] ?? []
    expect(message).toBe('Execution deadline diagnostics')
    expect(context).toMatchObject({
      rootSession: '111111',
      waitingOn: ['execution-not-ended'],
      rootRunning: true,
      compaction: {
        state: 'started-not-ended',
        open: [{role: 'root', session: '111111', reason: 'auto', startedMs: -60_000}],
      },
    })
    expect((context?.recentEvents as {type: string}[]).map(event => event.type)).toEqual([
      'session.execution.started',
      'session.text.delta',
      'session.compaction.started',
    ])
    expect(JSON.stringify(vi.mocked(logger.warning).mock.calls)).not.toContain(CANARY)
  })

  it('adds the same facts to the trace span as one event with fixed names and string values', () => {
    // #given
    const addEvent = vi.fn()
    const span = {addEvent} as unknown as LifecycleSpan

    // #when
    reportDeadlineDiagnosticsV2({
      tracker: stalledOnCompaction(),
      rootSessionId: ROOT,
      logger: createMockLogger(),
      traceSpan: span,
      nowMs: 64_500,
    })

    // #then
    expect(addEvent).toHaveBeenCalledTimes(1)
    const [name, attributes] = addEvent.mock.calls[0] as [string, Record<string, unknown>]
    expect(name).toBe('deadline.diagnostics')
    expect(Object.keys(attributes).length).toBeLessThanOrEqual(16)
    expect(Object.values(attributes).every(value => typeof value === 'string')).toBe(true)
    expect(attributes).toMatchObject({
      'fro_bot.waiting_on': 'execution-not-ended',
      'fro_bot.compaction': 'started-not-ended',
      'fro_bot.compaction.reason': 'auto',
      'fro_bot.compaction.started_ms': '-60000',
    })
    expect(String(attributes['fro_bot.recent_events'])).toContain('session.compaction.started')
    expect(String(attributes['fro_bot.recent_events']).length).toBeLessThanOrEqual(900)
    expect(JSON.stringify(attributes)).not.toContain(CANARY)
  })

  it('reports the stale-stream case the same way in the log and in the trace', () => {
    // #given a dropped stream, a stale inbox and no root result
    const tracker = createActivityTrackerV2()
    tracker.streamBlind = true
    tracker.turnOwed = true
    tracker.queuedNoticeInboxIds.add('msg_inboxAAAAAAA1')
    const logger = createMockLogger()
    const addEvent = vi.fn()

    // #when
    reportDeadlineDiagnosticsV2({
      tracker,
      rootSessionId: ROOT,
      logger,
      traceSpan: {addEvent} as unknown as LifecycleSpan,
      nowMs: 1,
    })

    // #then
    expect(vi.mocked(logger.warning).mock.calls[0]?.[1]).toMatchObject({
      waitingOn: ['execution-not-ended'],
      turnOwed: true,
      streamBlind: true,
      queuedInbox: {count: 1},
    })
    expect(addEvent.mock.calls[0]?.[1]).toMatchObject({
      'fro_bot.waiting_on': 'execution-not-ended',
      'fro_bot.turn_owed': 'true',
      'fro_bot.stream_blind': 'true',
      'fro_bot.queued_inbox': '1',
    })
  })

  it('takes the trace reason and start time from the root, before any child', () => {
    // #given a child that began compacting before the root, then the root
    const tracker = createActivityTrackerV2()
    record(tracker.eventTrail, typed('session.compaction.started', CHILD, {reason: 'manual'}), 1_000, [CHILD])
    record(tracker.eventTrail, typed('session.compaction.started', ROOT, {reason: 'auto'}), 3_000)
    const addEvent = vi.fn()

    // #when
    reportDeadlineDiagnosticsV2({
      tracker,
      rootSessionId: ROOT,
      logger: createMockLogger(),
      traceSpan: {addEvent} as unknown as LifecycleSpan,
      nowMs: 5_000,
    })

    // #then
    expect(addEvent.mock.calls[0]?.[1]).toMatchObject({
      'fro_bot.compaction.role': 'root',
      'fro_bot.compaction.reason': 'auto',
      'fro_bot.compaction.started_ms': '-2000',
    })
  })

  it('says in the trace when only a child is compacting', () => {
    // #given a child that began compacting and never finished, and a root that did not compact
    const tracker = createActivityTrackerV2()
    record(tracker.eventTrail, typed('session.compaction.started', CHILD, {reason: 'manual'}), 1_000, [CHILD])
    const addEvent = vi.fn()

    // #when
    reportDeadlineDiagnosticsV2({
      tracker,
      rootSessionId: ROOT,
      logger: createMockLogger(),
      traceSpan: {addEvent} as unknown as LifecycleSpan,
      nowMs: 5_000,
    })

    // #then
    expect(addEvent.mock.calls[0]?.[1]).toMatchObject({
      'fro_bot.compaction': 'started-not-ended',
      'fro_bot.compaction.role': 'child',
      'fro_bot.compaction.reason': 'manual',
      'fro_bot.compaction.started_ms': '-4000',
    })
  })

  it('keeps the trace event inside its length bound when the trail is full of the longest names', () => {
    // #given
    const tracker = createActivityTrackerV2()
    for (let index = 0; index < 100; index++) {
      record(tracker.eventTrail, typed(`session.${'x'.repeat(50)}${String(index).padStart(4, '0')}`, ROOT), index)
    }
    const addEvent = vi.fn()

    // #when
    reportDeadlineDiagnosticsV2({
      tracker,
      rootSessionId: ROOT,
      logger: createMockLogger(),
      traceSpan: {addEvent} as unknown as LifecycleSpan,
      nowMs: 1_000,
    })

    // #then the newest events are the ones kept
    const list = (addEvent.mock.calls[0]?.[1] as Record<string, string>)['fro_bot.recent_events'] ?? ''
    expect(list.length).toBeGreaterThan(0)
    expect(list.length).toBeLessThanOrEqual(900)
    expect(list).toContain('0099')
  })

  it('does not throw when the logger or the span does', () => {
    // #given
    const logger = createMockLogger()
    vi.mocked(logger.warning).mockImplementation(() => {
      throw new Error('log sink down')
    })
    const span = {
      addEvent: () => {
        throw new Error('span closed')
      },
    } as unknown as LifecycleSpan

    // #when / #then
    expect(() =>
      reportDeadlineDiagnosticsV2({
        tracker: stalledOnCompaction(),
        rootSessionId: ROOT,
        logger,
        traceSpan: span,
        nowMs: 1,
      }),
    ).not.toThrow()
  })
})
