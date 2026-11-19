import type {Observation, Usage} from './observation.js'
import type {ChatRecord, InvokeRecord, SpanRecord, ToolRecord} from './turn-model.js'

import {describe, expect, it} from 'vitest'

import {recordedFixtures} from './turn-model.fixtures.js'
import {DEFAULT_LIMITS} from './turn-model.js'
import {renderTrees, replay} from './turn-model.testing.js'

const fixture = (name: string): readonly Observation[] => {
  const found = recordedFixtures[name]
  if (found === undefined) throw new Error(`no fixture named ${name}`)
  return found.observations
}

const run = (name: string) => replay(fixture(name), {flush: false})
const invokes = (records: readonly SpanRecord[]): InvokeRecord[] =>
  records.filter((record): record is InvokeRecord => record.kind === 'invoke_agent')
const chats = (records: readonly SpanRecord[]): ChatRecord[] =>
  records.filter((record): record is ChatRecord => record.kind === 'chat')
const tools = (records: readonly SpanRecord[]): ToolRecord[] =>
  records.filter((record): record is ToolRecord => record.kind === 'execute_tool')
/** Root spans in the order their turns started (records are in the order they finished). */
const roots = (records: readonly SpanRecord[]): InvokeRecord[] =>
  invokes(records)
    .filter(record => record.parentSpanId === undefined)
    .toSorted((a, b) => a.start - b.start)

const USAGE: Usage = {input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0}

type ObservationInput = Observation extends infer Each
  ? Each extends Observation
    ? Omit<Each, 'at'> & {at?: number}
    : never
  : never

const lastAt = (observations: readonly Observation[]): number => observations.at(-1)?.at ?? 0

/** Builds synthetic observations with an advancing clock, for the cases no recording covers. */
function script() {
  let at = 0
  const out: Observation[] = []
  const add = (observation: ObservationInput): void => {
    if (observation.at === undefined) {
      at += 1
    } else {
      at = observation.at
    }
    out.push({...observation, at})
  }
  const api = {
    out,
    at: (time: number) => {
      at = time
      return api
    },
    prompt: (sessionId: string, messageId: string, extra: Partial<{at: number; bytes: number}> = {}) =>
      add({kind: 'prompt', sessionId, messageId, delivery: 'steer', content: 'hi', ...extra}),
    enqueued: (
      sessionId: string,
      inboxId: string,
      item: 'user' | 'synthetic' | 'compaction',
      child?: string,
      state?: string,
    ) => add({kind: 'inbox.enqueued', sessionId, inboxId, item, childSessionId: child, reportState: state}),
    delivered: (sessionId: string, inboxId: string) => add({kind: 'inbox.delivered', sessionId, inboxId}),
    started: (sessionId: string) => add({kind: 'execution.started', sessionId}),
    ended: (sessionId: string, outcome: 'succeeded' | 'failed' | 'interrupted' = 'succeeded') =>
      add({
        kind: 'execution.ended',
        sessionId,
        outcome,
        ...(outcome === 'failed' ? {error: {type: 'provider.internal', message: 'boom'}} : {}),
      }),
    created: (sessionId: string, parentSessionId?: string) =>
      add({kind: 'session.created', sessionId, parentSessionId, agent: 'general'}),
    request: (
      sessionId: string,
      requestKind: 'primary' | 'title' | 'compaction' | 'generate' = 'primary',
      extra: Partial<{at: number; bytes: number}> = {},
    ) =>
      add({
        kind: 'request',
        sessionId,
        requestKind,
        agent: 'build',
        model: 'm',
        provider: 'p',
        content: {messages: []},
        ...extra,
      }),
    stepStarted: (sessionId: string, messageId: string) =>
      add({kind: 'step.started', sessionId, messageId, agent: 'build', model: 'm', provider: 'p'}),
    stepEnded: (sessionId: string, messageId: string) =>
      add({kind: 'step.ended', sessionId, messageId, finish: 'stop', rawFinish: 'stop', usage: USAGE, cost: 0}),
    text: (sessionId: string, messageId: string) =>
      add({kind: 'output', sessionId, messageId, part: 'text', text: 'ok'}),
    toolBefore: (sessionId: string, callId: string, tool = 'read') =>
      add({kind: 'tool.before', sessionId, callId, tool, agent: 'build', input: {}}),
    toolAfter: (sessionId: string, callId: string, tool = 'read', child?: string) =>
      add({kind: 'tool.after', sessionId, callId, tool, status: 'completed', result: 'r', childSessionId: child}),
    toolEnded: (sessionId: string, callId: string, extra: Partial<Extract<Observation, {kind: 'tool.ended'}>> = {}) =>
      add({kind: 'tool.ended', sessionId, callId, succeeded: true, ...extra}),
    tick: (time: number) => add({kind: 'tick', at: time}),
    /** A complete one-step turn for a session: prompt, execution, one request, its step, end. */
    turn: (sessionId: string, tag: string) => {
      api.prompt(sessionId, `m-${tag}`)
      api.enqueued(sessionId, `m-${tag}`, 'user')
      api.started(sessionId)
      api.delivered(sessionId, `m-${tag}`)
      api.request(sessionId)
      api.stepStarted(sessionId, `s-${tag}`)
      api.text(sessionId, `s-${tag}`)
      api.stepEnded(sessionId, `s-${tag}`)
      api.ended(sessionId)
    },
  }
  return api
}

describe('recorded fixtures', () => {
  it.each(Object.keys(recordedFixtures))('%s replays to a complete tree and leaves no state behind', name => {
    // #given a recording from the real binary
    // #when it is replayed and every record collected
    const {records, model} = run(name)

    // #then every span has a parent that exists (or is a root), and nothing is left open
    const ids = new Set(records.map(record => record.spanId))
    expect(ids.size).toBe(records.length)
    const missingParents = records.filter(record => record.parentSpanId !== undefined && !ids.has(record.parentSpanId))
    expect(missingParents).toEqual([])
    expect(model.stats()).toMatchObject({
      openTraces: 0,
      sessions: 0,
      bufferedSessions: 0,
      bufferedBytes: 0,
      unresolvedDispatches: 0,
      droppedSpans: 0,
    })
    expect(records.filter(record => record.marks.includes('incomplete'))).toEqual([])
  })

  it('a text turn yields a root span and one model span with output, usage and finish reason', () => {
    // #given the text turn
    const {records} = run('text-turn')

    // #then the root carries the prompt, the primary request has output, usage and finish, and the title has no finish reason
    expect(roots(records)).toHaveLength(1)
    const primary = chats(records).find(chat => chat.requestKind === 'primary')
    // OpenCode's split: 100 prompt tokens with 30 cached arrive as input 70 and cache read 30.
    expect(primary).toMatchObject({
      status: 'ok',
      finishReason: 'stop',
      usage: {input: 70, output: 20, reasoning: 0, cacheRead: 30, cacheWrite: 0},
      attempt: 1,
    })
    expect(primary?.texts).toHaveLength(1)
    expect(primary?.reasoning).toHaveLength(1)
    expect(primary?.parentSpanId).toBe(roots(records)[0]?.spanId)
    const title = chats(records).find(chat => chat.requestKind === 'title')
    expect(title?.finishReason).toBeUndefined()
    expect(title?.gaps).toContain('finishReason')
    expect(roots(records)[0]?.prompts).toHaveLength(1)
  })

  it('a turn with a tool yields a tool span under the root, closed on the tool event, with input and result', () => {
    // #given two turns of one session: a read that works and a read of a missing file
    const {records} = run('tool-success-and-error')

    // #then the first tool span succeeded with input and result under the first root, the second errored with no result
    const [ok, failed] = tools(records)
    expect(ok).toMatchObject({tool: 'read', outcome: 'success'})
    expect(ok?.input).not.toBeUndefined()
    expect(ok?.result).not.toBeUndefined()
    expect(failed).toMatchObject({outcome: 'error', errorType: 'tool.execution'})
    expect(failed?.gaps).toContain('result')
    expect(roots(records)).toHaveLength(2)
    expect(ok?.parentSpanId).toBe(roots(records)[0]?.spanId)
    expect(failed?.parentSpanId).toBe(roots(records)[1]?.spanId)
  })

  it.each([
    ['tool-rejected-by-rule', 'rejected', 'permission.rejected'],
    ['tool-declined-by-user', 'interrupted', 'aborted'],
    ['tool-interrupted-pending-permission', 'interrupted', 'aborted'],
    ['tool-interrupted-running', 'interrupted', 'tool.execution'],
  ] as const)('%s yields a closed tool span with outcome %s and no result', (name, outcome, errorType) => {
    // #given the recording
    const {records} = run(name)

    // #then the tool span closed with that outcome, and no result
    const [tool] = tools(records)
    expect(tool).toMatchObject({outcome, errorType})
    expect(tool?.result).toBeUndefined()
    expect(tool?.gaps).toContain('result')
  })

  it('an interrupted turn closes the root as interrupted after its children, and a declined tool needs no after hook', () => {
    // #given the user declined a tool: no after hook, step failed, execution interrupted
    const {records} = run('tool-declined-by-user')

    // #then the children closed before the root, and the root is interrupted
    const order = records.map(record => record.kind)
    expect(order.at(-1)).toBe('invoke_agent')
    expect(roots(records)[0]).toMatchObject({status: 'interrupted', error: {type: 'interrupted'}})
    const primary = chats(records).find(chat => chat.requestKind === 'primary')
    expect(primary?.status).toBe('interrupted')
  })

  it('a failed model call followed by a retry yields two model spans, the first marked failed', () => {
    // #given a 503 before the step starts, then a recovery, then a non-retryable 400
    const {records} = run('model-failure-retry')

    // #then the first turn has attempt 1 failed (no output) and attempt 2 ok; the second turn's root errored
    const first = roots(records)[0]
    const attempts = chats(records).filter(
      chat => chat.parentSpanId === first?.spanId && chat.requestKind === 'primary',
    )
    expect(attempts.map(chat => [chat.attempt, chat.status])).toEqual([
      [1, 'error'],
      [2, 'ok'],
    ])
    expect(attempts[0]?.error).toMatchObject({type: 'provider.internal', status: 503})
    expect(attempts[0]?.gaps).toContain('output')
    expect(attempts[1]?.texts).toHaveLength(1)
    const second = roots(records)[1]
    expect(second).toMatchObject({status: 'error', error: {type: 'provider.invalid-request', status: 400}})
    expect(chats(records).filter(chat => chat.parentSpanId === second?.spanId)).toMatchObject([{status: 'error'}])
  })

  it('a background subagent sits under its dispatching tool span, though that span has ended, with its prompt', () => {
    // #given the quick subagent: the child's prompt arrives BEFORE the dispatch result
    const {records} = run('subagent-quick')

    // #then there is one trace, the child hangs under the tool span, and the child kept its prompt
    expect(new Set(records.map(record => record.traceId)).size).toBe(1)
    const [dispatch] = tools(records)
    const child = invokes(records).find(record => record.role === 'child')
    expect(dispatch?.tool).toBe('subagent')
    expect(child?.parentSpanId).toBe(dispatch?.spanId)
    expect(child?.prompts).toHaveLength(1)
    expect(child?.start).toBeLessThan(dispatch?.end ?? 0)
    expect(child?.end).toBeGreaterThan(dispatch?.end ?? Number.POSITIVE_INFINITY)
    expect(chats(records).filter(chat => chat.sessionId === child?.sessionId)).toHaveLength(1)
  })

  it("the parent's follow-on model call after the child reports back is in the same trace", () => {
    // #given the quick subagent: the report starts a new parent execution with no prompt
    const {records} = run('subagent-quick')

    // #then the parent's last primary request shares the trace and the root, and no second root exists
    const root = roots(records)[0]
    const parentChats = chats(records).filter(
      chat => chat.sessionId === root?.sessionId && chat.requestKind === 'primary',
    )
    expect(parentChats).toHaveLength(3)
    for (const chat of parentChats) expect(chat.traceId).toBe(root?.traceId)
    expect(roots(records)).toHaveLength(1)
    expect(renderTrees(records)).not.toContain('continuation')
  })

  it('two subagents dispatched in parallel each sit under their own tool span', () => {
    // #given one model response with two subagent calls
    const {records} = run('subagents-parallel')

    // #then each child hangs under a different dispatching tool span, in one trace
    const dispatches = tools(records).filter(tool => tool.tool === 'subagent')
    const children = invokes(records).filter(record => record.role === 'child')
    expect(dispatches).toHaveLength(2)
    expect(children).toHaveLength(2)
    expect(new Set(children.map(child => child.parentSpanId))).toEqual(new Set(dispatches.map(tool => tool.spanId)))
    expect(dispatches.map(tool => tool.childSessionId).toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual(
      children.map(child => child.sessionId).toSorted((a, b) => a.localeCompare(b)),
    )
    expect(new Set(records.map(record => record.traceId)).size).toBe(1)
  })

  it('a subagent that starts a subagent keeps all three sessions in one trace', () => {
    // #given parent, mid and grandchild sessions
    const {records} = run('subagent-nested')

    // #then one trace, three sessions, and the grandchild under the mid session's dispatch
    expect(new Set(records.map(record => record.traceId)).size).toBe(1)
    expect(new Set(records.map(record => record.sessionId)).size).toBe(3)
    const [mid, grand] = invokes(records)
      .filter(record => record.role === 'child')
      .toSorted((a, b) => a.start - b.start)
    const midDispatch = tools(records).find(tool => tool.sessionId === mid?.sessionId)
    expect(grand?.parentSpanId).toBe(midDispatch?.spanId)
    expect(midDispatch?.parentSpanId).toBe(mid?.spanId)
  })

  it("a new prompt while a subagent runs, report after: two roots, the first stays open for the report's follow-on", () => {
    // #given the second turn ended BEFORE the child reported
    const {records} = run('prompt-while-subagent-runs-report-after')

    // #then the second turn is its own root, and the report's follow-on joined the first turn's trace (no continuation)
    const [first, second] = roots(records)
    expect(roots(records)).toHaveLength(2)
    expect(second?.prompts).toHaveLength(1)
    const secondChats = chats(records).filter(chat => chat.traceId === second?.traceId)
    expect(secondChats).toHaveLength(1)
    const firstParentChats = chats(records).filter(
      chat => chat.traceId === first?.traceId && chat.sessionId === first?.sessionId,
    )
    expect(firstParentChats.filter(chat => chat.requestKind === 'primary')).toHaveLength(3)
    expect(first?.reportDeliveredInTrace).toBeUndefined()
  })

  it("a new prompt while a subagent runs, report during: the follow-on request is in the second turn's trace and names the first", () => {
    // #given the child reports while the second turn's execution runs, and is consumed at a step boundary
    const {records} = run('prompt-while-subagent-runs-report-during')

    // #then the follow-on chat sits in the second root, names the first trace, and the first root says where its report went
    const [first, second] = roots(records)
    const followOn = chats(records).filter(chat => chat.followOnOf.length > 0)
    expect(followOn).toHaveLength(1)
    expect(followOn[0]).toMatchObject({traceId: second?.traceId, followOnOf: [first?.traceId]})
    // The first trace closing, at the report's delivery, must not cut the request that is still running in the second.
    expect(followOn[0]).toMatchObject({status: 'ok', finishReason: 'stop'})
    expect(followOn[0]?.texts).toHaveLength(1)
    expect(followOn[0]?.gaps).not.toContain('output')
    expect(first?.reportDeliveredInTrace).toBe(second?.traceId)
    expect(second?.prompts).toHaveLength(1)
    expect(
      chats(records).filter(chat => chat.traceId === first?.traceId && chat.sessionId === first?.sessionId),
    ).toHaveLength(3)
  })

  it('a prompt queued or steered mid-execution is recorded in the running trace and opens no new root', () => {
    for (const name of ['prompt-queued-mid-execution', 'prompt-steered-mid-execution']) {
      // #given a second prompt while the first execution runs
      const {records} = run(name)

      // #then one root carries both prompts, the second flagged mid-turn
      expect(roots(records)).toHaveLength(1)
      const prompts = roots(records)[0]?.prompts ?? []
      expect(prompts.map(prompt => prompt.midTurn)).toEqual([false, true])
      expect(chats(records).filter(chat => chat.requestKind === 'primary')).toHaveLength(2)
    }
  })

  it('title and compaction requests yield model spans with finish reason absent', () => {
    // #given a session with a title and a manual compaction
    const {records} = run('compaction-manual')

    // #then both spans exist without a finish reason; the compaction has its text and a reason marker
    const compaction = chats(records).find(chat => chat.requestKind === 'compaction')
    const title = chats(records).find(chat => chat.requestKind === 'title')
    expect(compaction?.finishReason).toBeUndefined()
    expect(compaction?.gaps).toContain('finishReason')
    expect(compaction?.marks).toContain('reason:manual')
    expect(compaction?.texts).toHaveLength(1)
    expect(title?.finishReason).toBeUndefined()
  })

  it('a manual compaction with no execution, and a generate request, each yield a standalone trace', () => {
    for (const [name, standalone] of [
      ['compaction-manual', 'compaction'],
      ['generate-standalone', 'generate'],
    ] as const) {
      // #given the recording
      const {records} = run(name)

      // #then a second, standalone root exists with one request under it
      const standaloneRoot = roots(records).find(root => root.standalone === standalone)
      expect(standaloneRoot?.prompts).toEqual([])
      expect(chats(records).filter(chat => chat.parentSpanId === standaloneRoot?.spanId)).toHaveLength(1)
    }
  })

  it("a restored session's first new turn yields spans for that turn only", () => {
    // #given a restored session: its history is not replayed to the plugin
    const {records} = run('restored-session')

    // #then one root, one model span, no title
    expect(roots(records)).toHaveLength(1)
    expect(chats(records).map(chat => chat.requestKind)).toEqual(['primary'])
  })

  it('the long session yields every model and tool span with its identity', () => {
    // #given a session with a retry, parallel reads, a background subagent and a compaction
    const {records} = run('long-session')

    // #then its four traces hold: a retried turn, three reads, a subagent with its follow-on, and a standalone compaction
    expect(roots(records)).toHaveLength(4)
    expect(chats(records).filter(chat => chat.attempt === 2)).toHaveLength(1)
    expect(tools(records).filter(tool => tool.tool === 'read')).toHaveLength(3)
    expect(tools(records).filter(tool => tool.tool === 'subagent')).toHaveLength(1)
    expect(chats(records).filter(chat => chat.requestKind === 'compaction')).toHaveLength(1)
    for (const record of records) {
      expect(record.sessionId).toMatch(/^ses_\d+$/)
      expect(record.rootSessionId).toBe('ses_1')
    }
  })

  it('every record names the root session of its trace', () => {
    // #given the nested recording
    const {records} = run('subagent-nested')

    // #then the grouping key is the same everywhere while session ids differ
    expect(new Set(records.map(record => record.rootSessionId))).toEqual(new Set(['ses_1']))
  })

  it('replays to the same trees whatever the ids are, and is deterministic', () => {
    // #given each recording replayed twice
    for (const name of Object.keys(recordedFixtures)) {
      // #when / #then the outlines agree
      expect(renderTrees(run(name).records)).toBe(renderTrees(run(name).records))
    }
  })
})

describe('turn model on constructed orderings', () => {
  it('two sessions running at once never share a trace', () => {
    // #given two root sessions with interleaved turns
    const s = script()
    s.prompt('a', 'ma')
    s.prompt('b', 'mb')
    s.enqueued('a', 'ma', 'user')
    s.enqueued('b', 'mb', 'user')
    s.started('a')
    s.started('b')
    s.delivered('a', 'ma')
    s.delivered('b', 'mb')
    s.request('a')
    s.request('b')
    s.stepStarted('b', 'sb')
    s.stepStarted('a', 'sa')
    s.stepEnded('a', 'sa')
    s.stepEnded('b', 'sb')
    s.ended('b')
    s.ended('a')

    // #when replayed
    const {records} = replay(s.out)

    // #then two traces, and each session's spans stay in its own
    expect(roots(records)).toHaveLength(2)
    for (const record of records) {
      const root = roots(records).find(candidate => candidate.traceId === record.traceId)
      expect(root?.sessionId).toBe(record.sessionId)
    }
  })

  it('an execution failure closes the root with an error status after its open children', () => {
    // #given a turn whose execution fails with a request and a tool still open
    const s = script()
    s.prompt('a', 'm1')
    s.enqueued('a', 'm1', 'user')
    s.started('a')
    s.delivered('a', 'm1')
    s.request('a')
    s.stepStarted('a', 's1')
    s.toolBefore('a', 'c1')
    s.ended('a', 'failed')

    // #when replayed
    const {records, model} = replay(s.out, {flush: false})

    // #then the open tool and request close first, the root last, with the error
    expect(records.at(-1)).toMatchObject({kind: 'invoke_agent', status: 'error', error: {type: 'provider.internal'}})
    expect(
      records
        .slice(0, -1)
        .map(record => record.kind)
        .toSorted(),
    ).toEqual(['chat', 'execute_tool'])
    expect(tools(records)[0]?.marks).toContain('incomplete')
    expect(model.stats().openTraces).toBe(0)
  })

  it('a child session with no known dispatcher gets its own trace, marked unattributed, once the window passes', () => {
    // #given a session that said it has a parent that never dispatched it
    const s = script()
    s.created('kid', 'parent-that-never-linked')
    s.prompt('kid', 'mk')
    s.enqueued('kid', 'mk', 'user')
    s.started('kid')
    s.delivered('kid', 'mk')
    s.request('kid')
    s.stepStarted('kid', 'sk')
    s.stepEnded('kid', 'sk')
    s.ended('kid')

    // #when the buffer window passes after its first observation
    s.tick((s.out[0]?.at ?? 0) + DEFAULT_LIMITS.bufferWindowMs)
    const {records} = replay(s.out)

    // #then it has its own trace, marked unattributed, with its spans
    const [root] = roots(records)
    expect(roots(records)).toHaveLength(1)
    expect(root?.marks).toContain('unattributed')
    expect(chats(records)).toHaveLength(1)
  })

  it('does not release a buffered session before the window passes, and does at exactly the window', () => {
    // #given an unresolved dispatch and a child that starts talking
    const s = script()
    s.turn('parent', 'p')
    const open = script()
    open.at(0).prompt('parent', 'mp')
    open.enqueued('parent', 'mp', 'user')
    open.started('parent')
    open.delivered('parent', 'mp')
    open.request('parent')
    open.stepStarted('parent', 'sp')
    open.toolBefore('parent', 'c1', 'subagent')
    open.at(100).prompt('kid', 'mk')
    const buffered = lastAt(open.out)

    // #when ticks arrive one millisecond before the window and at it
    const before = replay([...open.out, {kind: 'tick', at: buffered + DEFAULT_LIMITS.bufferWindowMs - 1}], {
      flush: false,
    })
    const at = replay([...open.out, {kind: 'tick', at: buffered + DEFAULT_LIMITS.bufferWindowMs}], {flush: false})

    // #then nothing is released early, and at the window the child gets its own trace
    expect(before.model.stats().bufferedSessions).toBe(1)
    expect(at.model.stats().bufferedSessions).toBe(0)
  })

  it('releases buffered child events as an unattributed trace when the count bound is exceeded, and not at the bound', () => {
    // #given an unresolved dispatch and a child sending observations
    const limit = 4
    const base = script()
    base.prompt('parent', 'mp')
    base.enqueued('parent', 'mp', 'user')
    base.started('parent')
    base.delivered('parent', 'mp')
    base.request('parent')
    base.stepStarted('parent', 'sp')
    base.toolBefore('parent', 'c1', 'subagent')

    const feed = (count: number) => {
      const s = script()
      s.out.push(...base.out)
      s.at(500)
      for (let index = 0; index < count; index += 1) s.prompt('kid', `mk${index}`)
      return replay(s.out, {limits: {maxBufferedObservations: limit}, flush: false})
    }

    // #when exactly the bound, and one more
    const atBound = feed(limit)
    const over = feed(limit + 1)

    // #then at the bound they are still buffered; one over releases them into their own trace marked unattributed
    expect(atBound.model.stats().bufferedSessions).toBe(1)
    expect(over.model.stats().bufferedSessions).toBe(0)
    expect(over.model.stats().sessions).toBe(2)
  })

  it('releases buffered child events when the byte bound is exceeded, and not at the bound', () => {
    // #given an unresolved dispatch and child prompts of a known size
    const base = script()
    base.prompt('parent', 'mp')
    base.enqueued('parent', 'mp', 'user')
    base.started('parent')
    base.delivered('parent', 'mp')
    base.request('parent')
    base.stepStarted('parent', 'sp')
    base.toolBefore('parent', 'c1', 'subagent')
    const feed = (bytes: number) => {
      const s = script()
      s.out.push(...base.out)
      s.at(500)
      s.prompt('kid', 'mk', {bytes})
      return replay(s.out, {limits: {maxBufferedBytes: 1000}, flush: false})
    }

    // #when one observation is exactly the bound, and one byte over
    // #then it is buffered at the bound and released one byte over
    expect(feed(1000).model.stats()).toMatchObject({bufferedSessions: 1, bufferedBytes: 1000})
    expect(feed(1001).model.stats()).toMatchObject({bufferedSessions: 0, bufferedBytes: 0, sessions: 2})
  })

  it('releases a session straight away when too many sessions are already buffered', () => {
    // #given an unresolved dispatch and two unknown sessions talking, with room for one
    const s = script()
    s.prompt('parent', 'mp')
    s.enqueued('parent', 'mp', 'user')
    s.started('parent')
    s.delivered('parent', 'mp')
    s.request('parent')
    s.stepStarted('parent', 'sp')
    s.toolBefore('parent', 'c1', 'subagent')
    s.prompt('kid1', 'k1')
    s.prompt('kid2', 'k2')

    // #when replayed with a one-session buffer
    const {model} = replay(s.out, {limits: {maxBufferedSessions: 1}, flush: false})

    // #then the first waits and the second has its own session already
    expect(model.stats()).toMatchObject({bufferedSessions: 1, sessions: 2})
  })

  it('links a child from the tool event when the after hook never fires', () => {
    // #given a dispatch whose only link is `session.tool.success` metadata
    const s = script()
    s.prompt('p', 'mp')
    s.enqueued('p', 'mp', 'user')
    s.started('p')
    s.delivered('p', 'mp')
    s.request('p')
    s.stepStarted('p', 'sp')
    s.toolBefore('p', 'c1', 'subagent')
    s.prompt('kid', 'mk')
    s.toolEnded('p', 'c1', {childSessionId: 'kid'})
    s.stepEnded('p', 'sp')
    s.enqueued('kid', 'mk', 'user')
    s.started('kid')
    s.delivered('kid', 'mk')
    s.request('kid')
    s.stepStarted('kid', 'sk')
    s.stepEnded('kid', 'sk')
    s.ended('kid')
    s.ended('p')

    // #when replayed
    const {records} = replay(s.out)

    // #then the child is under the dispatching tool span in one trace
    const child = invokes(records).find(record => record.role === 'child')
    expect(child?.parentSpanId).toBe(tools(records)[0]?.spanId)
    expect(new Set(records.map(record => record.traceId)).size).toBe(1)
  })

  it('a subagent that never reports leaves its root closed by the inactivity bound, incomplete; a later report is a continuation', () => {
    // #given a dispatch whose child finishes but whose report arrives only after the inactivity bound
    const s = script()
    s.prompt('p', 'mp')
    s.enqueued('p', 'mp', 'user')
    s.started('p')
    s.delivered('p', 'mp')
    s.request('p')
    s.stepStarted('p', 'sp')
    s.toolBefore('p', 'c1', 'subagent')
    s.toolAfter('p', 'c1', 'subagent', 'kid')
    s.stepEnded('p', 'sp')
    s.ended('p')
    const quiet = lastAt(s.out)

    // #when time passes to exactly the bound, then one millisecond past it
    const atBound = replay([...s.out, {kind: 'tick', at: quiet + DEFAULT_LIMITS.rootInactivityMs}], {flush: false})
    const past = replay([...s.out, {kind: 'tick', at: quiet + DEFAULT_LIMITS.rootInactivityMs + 1}], {flush: false})

    // #then the root is still open at the bound, and closed past it with the open children marked incomplete
    expect(roots(atBound.records)).toEqual([])
    expect(atBound.model.stats().openTraces).toBe(1)
    expect(roots(past.records)[0]?.marks).toContain('incomplete')
    expect(past.model.stats().openTraces).toBe(0)

    // #when the report arrives later
    const late = script()
    late.out.push(...s.out, {kind: 'tick', at: quiet + DEFAULT_LIMITS.rootInactivityMs + 1})
    late.at(quiet + DEFAULT_LIMITS.rootInactivityMs + 10)
    late.enqueued('p', 'mr', 'synthetic', 'kid', 'completed')
    late.started('p')
    late.delivered('p', 'mr')
    late.request('p')
    late.stepStarted('p', 'sr')
    late.stepEnded('p', 'sr')
    late.ended('p')
    const {records} = replay(late.out)

    // #then it starts a new trace marked as a continuation that names the first
    const [first, continuation] = roots(records)
    expect(continuation?.marks).toContain('continuation')
    expect(continuation?.continuationOf).toBe(first?.traceId)
  })

  it('a report with no trace and no tombstone gets its own trace, marked unattributed', () => {
    // #given a report for a child nobody here dispatched
    const s = script()
    s.enqueued('p', 'mr', 'synthetic', 'stranger', 'completed')
    s.started('p')
    s.delivered('p', 'mr')
    s.request('p')
    s.stepStarted('p', 'sr')
    s.stepEnded('p', 'sr')
    s.ended('p')

    // #when replayed
    const {records} = replay(s.out)

    // #then the turn is traced, marked unattributed
    expect(roots(records)[0]?.marks).toContain('unattributed')
  })

  it('an interim "running" report does not release the root; the final one does', () => {
    // #given a child that reports running first, then completed
    const s = script()
    s.prompt('p', 'mp')
    s.enqueued('p', 'mp', 'user')
    s.started('p')
    s.delivered('p', 'mp')
    s.request('p')
    s.stepStarted('p', 'sp')
    s.toolBefore('p', 'c1', 'subagent')
    s.toolAfter('p', 'c1', 'subagent', 'kid')
    s.stepEnded('p', 'sp')
    s.ended('p')
    s.enqueued('p', 'mr1', 'synthetic', 'kid', 'running')
    s.started('p')
    s.delivered('p', 'mr1')
    s.ended('p')
    const afterInterim = replay(s.out, {flush: false})
    s.enqueued('p', 'mr2', 'synthetic', 'kid', 'completed')
    s.started('p')
    s.delivered('p', 'mr2')
    s.ended('p')
    const afterFinal = replay(s.out, {flush: false})

    // #then the root stays open after the interim report and closes after the final one
    expect(roots(afterInterim.records)).toHaveLength(0)
    expect(afterInterim.model.stats().openTraces).toBe(1)
    expect(roots(afterFinal.records)).toHaveLength(1)
  })

  it('opening a trace past the open-trace bound closes the least recently active one, marked incomplete', () => {
    // #given three sessions with open turns and a bound of two
    const s = script()
    for (const id of ['a', 'b', 'c']) {
      s.prompt(id, `m-${id}`)
      s.enqueued(id, `m-${id}`, 'user')
      s.started(id)
    }

    // #when replayed
    const {records, model} = replay(s.out, {limits: {maxOpenTraces: 2}, flush: false})

    // #then the first closed incomplete and two remain open
    expect(roots(records)).toHaveLength(1)
    expect(roots(records)[0]).toMatchObject({sessionId: 'a'})
    expect(roots(records)[0]?.marks).toContain('incomplete')
    expect(model.stats().openTraces).toBe(2)
  })

  it('does not close a trace at exactly the open-trace bound', () => {
    // #given two sessions and a bound of two
    const s = script()
    for (const id of ['a', 'b']) {
      s.prompt(id, `m-${id}`)
      s.enqueued(id, `m-${id}`, 'user')
      s.started(id)
    }

    // #when replayed
    const {records, model} = replay(s.out, {limits: {maxOpenTraces: 2}, flush: false})

    // #then nothing closed
    expect(records).toEqual([])
    expect(model.stats().openTraces).toBe(2)
  })

  it('bounds the closed-trace memory by count: the oldest tombstone is forgotten first', () => {
    // #given five turns that each leave a dispatched child unreported, then silence past the inactivity bound
    const s = script()
    for (let index = 0; index < 5; index += 1) {
      const id = `p${index}`
      s.prompt(id, `m${index}`)
      s.enqueued(id, `m${index}`, 'user')
      s.started(id)
      s.delivered(id, `m${index}`)
      s.request(id)
      s.stepStarted(id, `s${index}`)
      s.toolBefore(id, `c${index}`, 'subagent')
      s.toolAfter(id, `c${index}`, 'subagent', `kid${index}`)
      s.stepEnded(id, `s${index}`)
      s.ended(id)
    }
    s.tick(lastAt(s.out) + DEFAULT_LIMITS.rootInactivityMs + 1)
    const limits = {maxTombstones: 3}

    // #when the memory is read, and then reports arrive for the oldest and the newest child
    const closed = replay(s.out, {limits, flush: false})
    const late = script()
    late.out.push(...s.out)
    late.at(lastAt(s.out) + 10)
    for (const [session, child] of [
      ['p0', 'kid0'],
      ['p4', 'kid4'],
    ] as const) {
      late.enqueued(session, `r-${child}`, 'synthetic', child, 'completed')
      late.started(session)
      late.delivered(session, `r-${child}`)
      late.ended(session)
    }
    const {records} = replay(late.out, {limits})

    // #then it holds exactly the bound, the evicted child's report is unattributed and the remembered one is a continuation
    expect(closed.model.stats().tombstones).toBe(3)
    const reportRoots = roots(records).filter(root => root.prompts.length === 0)
    expect(
      reportRoots.map(root => [
        root.sessionId,
        root.marks.includes('continuation'),
        root.marks.includes('unattributed'),
      ]),
    ).toEqual([
      ['p0', false, true],
      ['p4', true, false],
    ])
  })

  it('drops spans over the per-trace open-span bound and counts them, never past the bound', () => {
    // #given a turn with more concurrent tool calls than the bound
    const s = script()
    s.prompt('a', 'm1')
    s.enqueued('a', 'm1', 'user')
    s.started('a')
    s.delivered('a', 'm1')
    s.request('a')
    s.stepStarted('a', 's1')
    for (let index = 0; index < 5; index += 1) s.toolBefore('a', `c${index}`)

    // #when replayed with room for three open spans (the request holds one)
    const {model} = replay(s.out, {limits: {maxOpenSpansPerTrace: 3}, flush: false})

    // #then two tool spans were dropped and counted
    expect(model.stats().droppedSpans).toBe(3)
  })

  it("closing the first turn's trace on its report leaves the second turn's open tool span open", () => {
    // #given a second turn running a tool while the first turn's child reports into it
    const s = script()
    s.prompt('p', 'm1')
    s.enqueued('p', 'm1', 'user')
    s.started('p')
    s.delivered('p', 'm1')
    s.request('p')
    s.stepStarted('p', 's1')
    s.toolBefore('p', 'c1', 'subagent')
    s.toolAfter('p', 'c1', 'subagent', 'kid')
    s.stepEnded('p', 's1')
    s.ended('p')
    s.prompt('p', 'm2')
    s.enqueued('p', 'm2', 'user')
    s.started('p')
    s.delivered('p', 'm2')
    s.request('p')
    s.stepStarted('p', 's2')
    s.toolBefore('p', 'c2', 'shell')
    s.enqueued('p', 'mr', 'synthetic', 'kid', 'completed')
    s.delivered('p', 'mr')

    // #when replayed up to the delivery
    const {records, model} = replay(s.out, {flush: false})

    // #then the first trace closed, and the second's tool is still open: no record for it yet
    expect(roots(records)).toHaveLength(1)
    expect(tools(records).map(tool => tool.callId)).toEqual(['c1'])
    expect(model.stats().openTraces).toBe(1)
  })

  it('drops a model request over the per-trace open-span bound and counts it', () => {
    // #given a title and a primary request open at once, with room for one
    const s = script()
    s.prompt('a', 'm1')
    s.enqueued('a', 'm1', 'user')
    s.started('a')
    s.delivered('a', 'm1')
    s.request('a', 'title')
    s.request('a')

    // #when replayed
    const {model} = replay(s.out, {limits: {maxOpenSpansPerTrace: 1}, flush: false})

    // #then the second request was dropped and counted, and the trace says so
    expect(model.stats().droppedSpans).toBe(1)
  })

  it('keeps a tool cut by the tool itself as a marker, apart from any other truncation', () => {
    // #given a tool whose own output was truncated
    const s = script()
    s.prompt('a', 'm1')
    s.enqueued('a', 'm1', 'user')
    s.started('a')
    s.delivered('a', 'm1')
    s.request('a')
    s.stepStarted('a', 's1')
    s.toolBefore('a', 'c1', 'shell')
    s.toolAfter('a', 'c1', 'shell')
    s.toolEnded('a', 'c1', {truncated: true})
    s.stepEnded('a', 's1')
    s.ended('a')

    // #when replayed
    const {records} = replay(s.out)

    // #then the record says the tool cut its own output
    expect(tools(records)[0]?.toolTruncated).toBe(true)
  })

  it('records a tool that ended with no before hook as a span with its gaps named', () => {
    // #given a tool event with no hook before it
    const s = script()
    s.prompt('a', 'm1')
    s.enqueued('a', 'm1', 'user')
    s.started('a')
    s.delivered('a', 'm1')
    s.request('a')
    s.stepStarted('a', 's1')
    s.toolEnded('a', 'c1')
    s.stepEnded('a', 's1')
    s.ended('a')

    // #when replayed
    const {records} = replay(s.out)

    // #then the span exists and says what it lacks
    expect(tools(records)[0]?.gaps).toEqual(expect.arrayContaining(['before-hook', 'input']))
  })

  it('cleanup with spans open closes them as interrupted and leaves no state', () => {
    // #given a turn cut off mid-request and mid-tool, and a buffered child
    const s = script()
    s.prompt('a', 'm1')
    s.enqueued('a', 'm1', 'user')
    s.started('a')
    s.delivered('a', 'm1')
    s.request('a')
    s.stepStarted('a', 's1')
    s.toolBefore('a', 'c1', 'subagent')
    s.prompt('kid', 'mk')
    s.started('kid')
    s.request('kid')

    // #when flushed
    const {records, model} = replay(s.out)

    // #then every span closed (interrupted and incomplete), the buffered child got a trace, and no state remains
    for (const root of roots(records)) expect(root).toMatchObject({status: 'interrupted'})
    expect(
      records
        .filter(record => record.kind !== 'invoke_agent')
        .every(record => record.marks.includes('incomplete') || record.status === 'interrupted'),
    ).toBe(true)
    expect(
      roots(records)
        .map(root => root.sessionId)
        .toSorted(),
    ).toEqual(['a', 'kid'])
    expect(model.stats()).toMatchObject({
      openTraces: 0,
      sessions: 0,
      bufferedSessions: 0,
      bufferedBytes: 0,
      tombstones: 0,
      unresolvedDispatches: 0,
    })
  })

  it('a title whose text arrives after its turn ended is still joined, and the trace waits for it only briefly', () => {
    // #given a turn that ends before the title event
    const s = script()
    s.prompt('a', 'm1')
    s.enqueued('a', 'm1', 'user')
    s.started('a')
    s.delivered('a', 'm1')
    s.request('a', 'title')
    s.request('a')
    s.stepStarted('a', 's1')
    s.stepEnded('a', 's1')
    s.ended('a')
    const ended = lastAt(s.out)

    // #when the title arrives in time, and when it never does
    const joined = replay([...s.out, {kind: 'title', sessionId: 'a', title: 't', at: ended + 5}], {flush: false})
    const waiting = replay([...s.out, {kind: 'tick', at: ended + DEFAULT_LIMITS.titleWaitMs}], {flush: false})
    const gaveUp = replay([...s.out, {kind: 'tick', at: ended + DEFAULT_LIMITS.titleWaitMs + 1}], {flush: false})

    // #then the title carries its text; the trace is still open at the wait bound and closed, complete, one millisecond after
    expect(chats(joined.records).find(chat => chat.requestKind === 'title')?.texts).toHaveLength(1)
    expect(joined.model.stats().openTraces).toBe(0)
    expect(waiting.model.stats().openTraces).toBe(1)
    expect(gaveUp.model.stats().openTraces).toBe(0)
    expect(roots(gaveUp.records)[0]?.marks).not.toContain('incomplete')
    expect(chats(gaveUp.records).find(chat => chat.requestKind === 'title')?.gaps).toContain('output')
  })

  it('ignores observations for sessions it cannot place and never throws on a malformed order', () => {
    // #given events for a session with no beginning
    const s = script()
    s.stepStarted('ghost', 's1')
    s.stepEnded('ghost', 's1')
    s.toolEnded('ghost', 'c1')
    s.delivered('ghost', 'nope')
    s.ended('ghost')

    // #when replayed
    const {records, model} = replay(s.out)

    // #then nothing is recorded and nothing is retained
    expect(records).toEqual([])
    expect(model.stats().sessions).toBe(0)
  })

  it('a follow-on is not claimed twice', () => {
    // #given a report consumed by a request, then another request in the same execution
    const {records} = run('prompt-while-subagent-runs-report-during')

    // #then only one chat names the first trace
    expect(chats(records).filter(chat => chat.followOnOf.length > 0)).toHaveLength(1)
  })
})
