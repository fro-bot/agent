import type {Observation, Usage} from './observation.js'
import type {ChatRecord, InvokeRecord, SpanRecord, ToolRecord, TurnModelLimits} from './turn-model.js'

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
  /** The receive time of each session's latest primary request hook: what a step's own `started` is by default. */
  const lastHook = new Map<string, number>()
  const add = (observation: ObservationInput): void => {
    if (observation.at === undefined) {
      at += 1
    } else {
      at = observation.at
    }
    if (observation.kind === 'request' && observation.requestKind === 'primary') lastHook.set(observation.sessionId, at)
    out.push({...observation, at})
  }
  const api = {
    out,
    at: (time: number) => {
      at = time
      return api
    },
    prompt: (
      sessionId: string,
      messageId: string,
      extra: Partial<{at: number; bytes: number; content: unknown}> = {},
    ) => add({kind: 'prompt', sessionId, messageId, delivery: 'steer', content: 'hi', ...extra}),
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
    /** `started` defaults to the session's latest hook time (the step answers the newest request); a delayed step names its own. */
    stepStarted: (sessionId: string, messageId: string, started: number | undefined = lastHook.get(sessionId)) =>
      add({kind: 'step.started', sessionId, messageId, started, agent: 'build', model: 'm', provider: 'p'}),
    stepEnded: (sessionId: string, messageId: string) =>
      add({kind: 'step.ended', sessionId, messageId, finish: 'stop', rawFinish: 'stop', usage: USAGE, cost: 0}),
    text: (sessionId: string, messageId: string, text = 'ok', part: 'text' | 'reasoning' = 'text') =>
      add({kind: 'output', sessionId, messageId, part, text}),
    toolNamed: (sessionId: string, callId: string, tool = 'read') => add({kind: 'tool.named', sessionId, callId, tool}),
    toolCalled: (sessionId: string, callId: string, extra: Partial<Extract<Observation, {kind: 'tool.called'}>> = {}) =>
      add({kind: 'tool.called', sessionId, callId, executed: false, input: {from: 'event'}, ...extra}),
    /** The before hook alone: what a hook sees when its session events are missing or late. */
    hookBefore: (sessionId: string, callId: string, tool = 'read', messageId?: string, input: unknown = {}) =>
      add({kind: 'tool.before', sessionId, callId, tool, messageId, agent: 'build', input}),
    /** A call as it happens: the name, the called event, then the before hook. */
    toolBefore: (sessionId: string, callId: string, tool = 'read', messageId?: string) => {
      api.toolNamed(sessionId, callId, tool)
      api.toolCalled(sessionId, callId, {messageId})
      api.hookBefore(sessionId, callId, tool, messageId)
    },
    toolAfter: (sessionId: string, callId: string, tool = 'read', child?: string) =>
      add({kind: 'tool.after', sessionId, callId, tool, status: 'completed', result: 'r', childSessionId: child}),
    toolEnded: (sessionId: string, callId: string, extra: Partial<Extract<Observation, {kind: 'tool.ended'}>> = {}) =>
      add({kind: 'tool.ended', sessionId, callId, succeeded: true, ...extra}),
    tick: (time: number) => add({kind: 'tick', at: time}),
    lost: (sessionIds: readonly string[] | undefined, reason = 'test') => add({kind: 'loss', sessionIds, reason}),
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

  it('a response that asked for tool calls carries them, with their input, alongside its output', () => {
    // #given a turn whose first response asked for one read and whose second answered
    const {records} = run('tool-success-and-error')

    // #then the tool-calling response lists the call by id and tool, and the answering one lists none
    const [asking, answering] = chats(records).filter(chat => chat.requestKind === 'primary')
    const [tool] = tools(records)
    expect(asking?.toolCalls).toMatchObject([{callId: tool?.callId, tool: 'read'}])
    expect(asking?.toolCalls[0]?.input).not.toBeUndefined()
    expect(answering?.toolCalls).toEqual([])
  })

  it('bounds the tool calls kept per response and says so', () => {
    // #given a response that asked for four calls, with room for two
    const s = script()
    s.prompt('a', 'm1')
    s.enqueued('a', 'm1', 'user')
    s.started('a')
    s.delivered('a', 'm1')
    s.request('a')
    s.stepStarted('a', 's1')
    for (let index = 0; index < 4; index += 1) s.toolBefore('a', `c${index}`, 'read', 's1')
    s.stepEnded('a', 's1')
    s.ended('a')

    // #when replayed with that bound
    const {records} = replay(s.out, {limits: {maxOutputParts: 2}})

    // #then two are kept and the gap is named
    const [chat] = chats(records)
    expect(chat?.toolCalls).toHaveLength(2)
    expect(chat?.gaps).toContain('tool-calls-over-limit')
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

  it('records a tool that ended with neither a call event nor a hook as a span with its gaps named', () => {
    // #given a tool event with nothing before it
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
    expect(tools(records)[0]?.gaps).toEqual(expect.arrayContaining(['call-event', 'input']))
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

describe('the tool span lifecycle comes from session tool events', () => {
  /** A turn up to the model's step, ready for a tool call. */
  const openTurn = () => {
    const s = script()
    s.prompt('a', 'm1')
    s.enqueued('a', 'm1', 'user')
    s.started('a')
    s.delivered('a', 'm1')
    s.request('a')
    s.stepStarted('a', 's1')
    return s
  }
  const finish = (s: ReturnType<typeof script>) => {
    s.stepEnded('a', 's1')
    s.ended('a')
    return replay(s.out)
  }

  it('yields a span from the events alone when no hook fires for the call', () => {
    // #given a call with input-started, called and success events, and no before or after hook (a provider-executed one, or a hook that never fired)
    const s = openTurn()
    s.at(99)
    s.toolNamed('a', 'c1', 'websearch')
    s.at(109)
    s.toolCalled('a', 'c1', {messageId: 's1', executed: true, input: {query: 'q'}})
    s.at(149)
    s.toolEnded('a', 'c1', {executed: true, result: {content: 'found'}})

    // #when replayed
    const {records} = finish(s)

    // #then the span opened at the called event and closed at the success event, with the name, the input and the result
    const [span] = tools(records)
    expect(tools(records)).toHaveLength(1)
    expect([span?.tool, span?.outcome, span?.start, span?.end]).toEqual(['websearch', 'success', 110, 150])
    expect(span?.input).toEqual({query: 'q'})
    expect(span?.result).toEqual({content: 'found'})
    expect(span?.providerExecuted).toBe(true)
    expect(span?.gaps).toEqual([])
    expect(span?.parentSpanId).toBe(roots(records)[0]?.spanId)
  })

  it('adds the hooks’ view to the span the events opened: the arguments the tool received, and the result', () => {
    // #given a call whose before hook saw edited arguments and whose after hook saw its own result
    const s = openTurn()
    s.toolNamed('a', 'c1', 'read')
    s.toolCalled('a', 'c1', {input: {path: 'model-wrote-this'}})
    s.hookBefore('a', 'c1', 'read', undefined, {path: 'tool-received-this'})
    s.toolAfter('a', 'c1')
    s.toolEnded('a', 'c1', {result: {content: 'event content'}})

    // #when
    const {records} = finish(s)

    // #then one span, with the hook's arguments and the hook's result
    expect(tools(records)).toHaveLength(1)
    expect(tools(records)[0]?.input).toEqual({path: 'tool-received-this'})
    expect(tools(records)[0]?.result).toBe('r')
    expect(tools(records)[0]?.agent).toBe('build')
  })

  it('merges a before hook that arrives ahead of its called event into the one span, and does not open a second', () => {
    // #given the hook delivered before the event stream catches up
    const s = openTurn()
    s.at(100)
    s.hookBefore('a', 'c1', 'read', undefined, {path: 'p'})
    s.toolAfter('a', 'c1')
    s.at(95)
    s.toolNamed('a', 'c1', 'read')
    s.toolCalled('a', 'c1', {input: {path: 'model'}})
    s.toolEnded('a', 'c1')

    // #when
    const {records} = finish(s)

    // #then
    expect(tools(records)).toHaveLength(1)
    expect(tools(records)[0]).toMatchObject({input: {path: 'p'}, result: 'r', agent: 'build', outcome: 'success'})
  })

  it('opens no span from a hook alone, holds it only briefly and boundedly, and leaks nothing', () => {
    // #given hooks for calls whose events never come, more of them than the bound
    const s = openTurn()
    for (let index = 0; index < 5; index += 1) {
      s.hookBefore('a', `ghost-${index}`)
      s.toolAfter('a', `ghost-${index}`)
    }
    const {model, records} = replay(s.out, {limits: {maxPendingToolNotes: 3, toolNoteWaitMs: 10_000}, flush: false})

    // #then no span for any of them, and no more than the bound is held
    expect(tools(records)).toHaveLength(0)
    expect(model.stats().pendingToolNotes).toBe(3)

    // #when time passes beyond the wait, on a tick
    model.observe({kind: 'tick', at: lastAt(s.out) + 10_001})

    // #then they are gone
    expect(model.stats().pendingToolNotes).toBe(0)

    // #and a flush leaves no state and no span for them
    const flushed = model.flush(lastAt(s.out) + 20_000)
    expect(tools(flushed)).toHaveLength(0)
    expect(model.stats()).toMatchObject({openTraces: 0, sessions: 0, pendingToolNotes: 0})
  })

  it('does not drop a note at exactly the wait, and drops it after', () => {
    // #given one hook note, taken at 101, and a wait of 1000
    const s = openTurn()
    s.at(100)
    s.hookBefore('a', 'ghost')
    const {model} = replay(s.out, {limits: {toolNoteWaitMs: 1_000}, flush: false})

    // #when a tick comes at exactly the wait, then past it
    model.observe({kind: 'tick', at: 1_101})
    const atBound = model.stats().pendingToolNotes
    model.observe({kind: 'tick', at: 1_102})

    // #then
    expect([atBound, model.stats().pendingToolNotes]).toEqual([1, 0])
  })

  it('opens a span from the success or failed event alone, using the name from the input-started event', () => {
    // #given a call that failed before it was ever called (its input did not parse): a name event, then a failure
    const s = openTurn()
    s.toolNamed('a', 'c1', 'write')
    s.toolEnded('a', 'c1', {succeeded: false, errorType: 'tool.input-json', message: 'bad json'})

    // #when
    const {records} = finish(s)

    // #then
    expect(tools(records)[0]).toMatchObject({tool: 'write', outcome: 'error', errorType: 'tool.input-json'})
    expect(tools(records)[0]?.gaps).toEqual(expect.arrayContaining(['call-event', 'input']))
  })

  it('a call this plugin’s own reuse guard rejected yields a span with outcome rejected', () => {
    // #given the events of a rejected subagent call: named, called, then failed with the guard's error type, and no hooks
    const s = openTurn()
    s.toolNamed('a', 'c1', 'subagent')
    s.toolCalled('a', 'c1', {messageId: 's1', input: {sessionID: 'ses_x'}})
    s.toolEnded('a', 'c1', {succeeded: false, errorType: 'plugin.reuse-guard', message: 'Session reuse is disabled'})

    // #when
    const {records} = finish(s)

    // #then it is a rejected tool span with no result, and it opened no child
    expect(tools(records)[0]).toMatchObject({tool: 'subagent', outcome: 'rejected', errorType: 'plugin.reuse-guard'})
    expect(tools(records)[0]?.status).toBe('error')
    expect(invokes(records).filter(record => record.role === 'child')).toHaveLength(0)
  })

  it('an interrupted or declined call is closed by its failed event with that outcome', () => {
    // #given
    const s = openTurn()
    s.toolBefore('a', 'c1')
    s.toolEnded('a', 'c1', {succeeded: false, errorType: 'aborted', message: 'Tool execution interrupted'})
    s.toolBefore('a', 'c2')
    s.toolEnded('a', 'c2', {succeeded: false, errorType: 'permission.rejected', message: 'declined'})

    // #when
    const {records} = finish(s)

    // #then
    expect(tools(records).map(span => span.outcome)).toEqual(['interrupted', 'rejected'])
  })

  it('closes a call with an open span at cleanup as interrupted, whether a hook ever fired or not', () => {
    // #given one call with a hook and one with events only, both unfinished
    const s = openTurn()
    s.toolBefore('a', 'c1')
    s.toolNamed('a', 'c2', 'shell')
    s.toolCalled('a', 'c2')

    // #when cleanup runs
    const {records} = replay(s.out)

    // #then both closed as interrupted, incomplete
    expect(tools(records).map(span => [span.outcome, span.marks])).toEqual([
      ['interrupted', ['incomplete']],
      ['interrupted', ['incomplete']],
    ])
  })

  it('a code-execution call is one span: no nested call is published in this release', () => {
    // #given the recording of a code-execution tool whose code called a tool
    const {records} = run('tool-calls-inside-code-execution')

    // #then one tool span, the execution tool itself, and nothing nested under it
    expect(tools(records).map(span => span.tool)).toEqual(['execute'])
    expect(records.filter(record => record.parentSpanId === tools(records)[0]?.spanId)).toEqual([])
  })

  it('the recorded reuse-guard rejection is a rejected tool span, with no hook before or after', () => {
    // #given the recording of a subagent call carrying a session id, refused by this plugin's guard in the before hook
    const observations = fixture('tool-rejected-by-reuse-guard')
    expect(observations.some(observation => observation.kind === 'tool.before')).toBe(false)

    // #when
    const {records} = run('tool-rejected-by-reuse-guard')

    // #then
    expect(tools(records)[0]).toMatchObject({tool: 'subagent', outcome: 'rejected', errorType: 'plugin.reuse-guard'})
  })
})

describe('requests whose attempts cannot be seen', () => {
  it.each(['title', 'compaction', 'generate'] as const)(
    'one %s request is one span that says its attempt count is unknown',
    requestKind => {
      // #given
      const s = script()
      s.prompt('a', 'm1')
      s.enqueued('a', 'm1', 'user')
      s.started('a')
      s.delivered('a', 'm1')
      s.request('a', requestKind)
      s.request('a')
      s.stepStarted('a', 's1')
      s.stepEnded('a', 's1')
      s.ended('a')

      // #when
      const {records} = replay(s.out)

      // #then the auxiliary span says so, and the session model step does not
      const auxiliary = chats(records).filter(record => record.requestKind === requestKind)
      expect(auxiliary).toHaveLength(1)
      expect(auxiliary[0]?.attemptCountUnknown).toBe(true)
      expect(chats(records).find(record => record.requestKind === 'primary')?.attemptCountUnknown).toBeFalsy()
    },
  )

  it('two real provider attempts for one generate request are one span with the attempt count unknown', () => {
    // #given the recording of a generate request whose first provider attempt failed with a 503 and whose second succeeded
    const recorded = recordedFixtures['generate-retry']
    expect(recorded?.facts?.providerAttempts).toBe(2)
    const requests = fixture('generate-retry').filter(
      observation => observation.kind === 'request' && observation.requestKind === 'generate',
    )

    // #when replayed
    const {records} = run('generate-retry')

    // #then the hook fired once, and so there is exactly one generate span, and it says the attempts are unknown
    expect(requests).toHaveLength(1)
    const generated = chats(records).filter(record => record.requestKind === 'generate')
    expect(generated).toHaveLength(1)
    expect(generated[0]?.attemptCountUnknown).toBe(true)
    expect(generated[0]?.status).toBe('ok')
    // the retry's wait is inside the span: it started at the request and ended at the usage event, seconds later
    expect((generated[0]?.end ?? 0) - (generated[0]?.start ?? 0)).toBeGreaterThan(1_500)
  })

  it('keeps per-attempt spans for session model steps, where the retry hook exists', () => {
    // #given the recorded retry
    const {records} = run('model-failure-retry')

    // #then two attempts for the retried step, neither marked unknown
    const primary = chats(records).filter(record => record.requestKind === 'primary')
    expect(primary.filter(record => record.attempt > 1).length).toBeGreaterThan(0)
    expect(primary.every(record => record.attemptCountUnknown !== true)).toBe(true)
  })
})

describe('the tombstone of a closed root', () => {
  /** A dispatch that never reports, closed by the inactivity bound, then a late report. */
  const lateReport = (reportAfterMs: number, limits: Partial<typeof DEFAULT_LIMITS>) => {
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
    const closedAt = lastAt(s.out) + limits.rootInactivityMs! + 1
    s.tick(closedAt)
    s.at(closedAt + reportAfterMs - 1)
    s.enqueued('p', 'report', 'synthetic', 'kid', 'completed')
    s.started('p')
    s.delivered('p', 'report')
    s.request('p')
    s.stepStarted('p', 'sp2')
    s.stepEnded('p', 'sp2')
    s.ended('p')
    return replay(s.out, {limits})
  }
  const limits = {rootInactivityMs: 1_000, tombstoneTtlMs: 5_000}

  it('names the first trace in a continuation while the tombstone is fresh, at exactly the ttl', () => {
    // #given a late report exactly at the tombstone's age limit
    const {records} = lateReport(5_000, limits)

    // #then it continues the first trace
    const [first, second] = roots(records)
    expect(second?.marks).toContain('continuation')
    expect(second?.continuationOf).toBe(first?.traceId)
  })

  it('treats a report after the tombstone expired as an unattributed trace, with nothing naming the first', () => {
    // #given a late report one millisecond past the ttl
    const {records} = lateReport(5_001, limits)

    // #then the report starts a trace that is unattributed, not a continuation
    const second = roots(records)[1]
    expect(second?.marks).toContain('unattributed')
    expect(second?.marks).not.toContain('continuation')
    expect(second?.continuationOf).toBeUndefined()
  })

  it('holds only the trace id, and releases it on expiry', () => {
    // #given a closed trace
    const {model} = lateReport(10_000, limits)

    // #then the model remembers no more than its bound, and the expired entry is gone
    expect(model.stats().tombstones).toBeLessThanOrEqual(DEFAULT_LIMITS.maxTombstones)
  })
})

describe('the model holds a bounded amount of output while a request is open', () => {
  const limits = {maxOutputChars: 100, maxHeldOutputChars: 250}
  const open = (s: ReturnType<typeof script>, session: string, tag: string) => {
    s.prompt(session, `m-${tag}`)
    s.enqueued(session, `m-${tag}`, 'user')
    s.started(session)
    s.delivered(session, `m-${tag}`)
    s.request(session)
    s.stepStarted(session, `s-${tag}`)
  }
  const close = (s: ReturnType<typeof script>, session: string, tag: string) => {
    s.stepEnded(session, `s-${tag}`)
    s.ended(session)
  }
  const outputOf = (records: readonly SpanRecord[]) => chats(records)[0]

  it('keeps output up to the per-request budget whole, and omits the part that crosses it, saying so', () => {
    // #given two parts, the second crossing the 100-character budget
    const s = script()
    open(s, 'a', '1')
    s.text('a', 's-1', 'x'.repeat(60))
    s.text('a', 's-1', 'y'.repeat(60))
    close(s, 'a', '1')

    // #when
    const {records} = replay(s.out, {limits})

    // #then the first is whole, the second is omitted whole (raw text is never clipped before redaction), and the span says so
    const chat = outputOf(records)
    expect(chat?.texts.map(text => text.length)).toEqual([60])
    expect(chat?.gaps).toContain('output-omitted')
  })

  it('keeps output exactly at the budget whole, and omits one character over it', () => {
    // #given
    const at = script()
    open(at, 'a', '1')
    at.text('a', 's-1', 'x'.repeat(100))
    close(at, 'a', '1')
    const over = script()
    open(over, 'a', '1')
    over.text('a', 's-1', 'x'.repeat(101))
    close(over, 'a', '1')

    // #when
    const exact = outputOf(replay(at.out, {limits}).records)
    const cut = outputOf(replay(over.out, {limits}).records)

    // #then
    expect([exact?.texts[0]?.length, exact?.gaps.includes('output-omitted')]).toEqual([100, false])
    expect([cut?.texts.length, cut?.gaps.includes('output-omitted')]).toEqual([0, true])
  })

  it('omits a part that arrives when the budget is spent, and counts reasoning in the same budget', () => {
    // #given reasoning that spends the budget, then a text part
    const s = script()
    open(s, 'a', '1')
    s.text('a', 's-1', 'r'.repeat(100), 'reasoning')
    s.text('a', 's-1', 'late')
    close(s, 'a', '1')

    // #when
    const chat = outputOf(replay(s.out, {limits}).records)

    // #then the reasoning is whole, the text is not there, and the span says a part was omitted
    expect(chat?.reasoning.map(text => text.length)).toEqual([100])
    expect(chat?.texts).toEqual([])
    expect(chat?.gaps).toContain('output-omitted')
  })

  it('bounds the total across open requests, and gives the budget back when they close', () => {
    // #given three sessions with open requests, each under its own budget and together over the aggregate of 250
    const s = script()
    for (const session of ['a', 'b', 'c']) open(s, session, session)
    for (const session of ['a', 'b', 'c']) s.text(session, `s-${session}`, 'x'.repeat(90))
    const {model, records} = replay(s.out, {limits, flush: false})

    // #then the third request found too little of the aggregate left: its part was omitted, and the total never passed the bound
    expect(model.stats().heldOutputChars).toBeLessThanOrEqual(250)
    expect(model.stats().heldOutputChars).toBe(180)

    // #when everything closes
    for (const session of ['a', 'b', 'c']) close(s, session, session)
    const closed = replay(s.out, {limits})

    // #then all three spans exist, the aggregate-limited one says so, and nothing is held afterwards
    expect(chats(closed.records)).toHaveLength(3)
    expect(chats(closed.records).filter(chat => chat.gaps.includes('output-omitted'))).toHaveLength(1)
    expect(closed.model.stats().heldOutputChars).toBe(0)
    expect(records).toHaveLength(0)
  })

  it('bounds a compaction summary and a title the same way', () => {
    // #given a compaction whose text is over the budget
    const s = script()
    s.prompt('a', 'm1')
    s.enqueued('a', 'm1', 'user')
    s.started('a')
    s.delivered('a', 'm1')
    s.request('a', 'compaction')
    s.at(50)
    s.out.push({kind: 'compaction.ended', at: 50, sessionId: 'a', ok: true, text: 'z'.repeat(500)})
    s.ended('a')

    // #when
    const {records} = replay(s.out, {limits})

    // #then
    const compaction = chats(records).find(chat => chat.requestKind === 'compaction')
    expect(compaction?.texts).toEqual([])
    expect(compaction?.gaps).toContain('output-omitted')
  })

  it('holds nothing at flush', () => {
    // #given open requests with output
    const s = script()
    open(s, 'a', '1')
    s.text('a', 's-1', 'x'.repeat(80))

    // #when
    const {model} = replay(s.out, {limits})

    // #then
    expect(model.stats().heldOutputChars).toBe(0)
  })
})

describe('sessions that never start an execution', () => {
  const limits = {sessionIdleMs: 1_000, maxIdleSessions: 3, maxPendingPromptsPerSession: 2}
  const queue = (s: ReturnType<typeof script>, session: string, tag: string, content: object = {text: tag}) => {
    s.prompt(session, `m-${tag}`, {content})
    s.enqueued(session, `m-${tag}`, 'user')
    return content
  }

  it('forgets a session after the idle time with no trace, and hands back the snapshots it held', () => {
    // #given a prompt and its inbox item, and no execution ever
    const s = script()
    const content = queue(s, 'a', '1')
    const {model} = replay(s.out, {limits, flush: false})
    expect(model.stats().sessions).toBe(1)

    // #when time passes beyond the idle limit on a tick
    model.observe({kind: 'tick', at: lastAt(s.out) + 1_001})

    // #then the session is gone, and the prompt's snapshot is returned for release
    expect(model.stats()).toMatchObject({sessions: 0, openTraces: 0})
    expect(model.takeDiscarded()).toContain(content)
    expect(model.takeDiscarded()).toEqual([])
  })

  it('keeps it at exactly the idle limit, and forgets it one millisecond after', () => {
    // #given
    const s = script()
    queue(s, 'a', '1')
    const {model} = replay(s.out, {limits, flush: false})
    const last = lastAt(s.out)

    // #when
    model.observe({kind: 'tick', at: last + 1_000})
    const atLimit = model.stats().sessions
    model.observe({kind: 'tick', at: last + 1_001})

    // #then
    expect([atLimit, model.stats().sessions]).toEqual([1, 0])
  })

  it('counts activity: a session that keeps receiving prompts is not forgotten', () => {
    // #given a prompt every 600 ms against an idle limit of 1,000
    const s = script()
    for (let index = 0; index < 5; index += 1) {
      s.at(index * 600)
      queue(s, 'a', String(index))
    }
    const {model} = replay(s.out, {limits: {...limits, maxPendingPromptsPerSession: 10}, flush: false})

    // #when a tick comes 600 ms after the last
    model.observe({kind: 'tick', at: lastAt(s.out) + 600})

    // #then it is still there
    expect(model.stats().sessions).toBe(1)
  })

  it('never forgets a session that is running, however long it has been quiet', () => {
    // #given a running execution with an open request
    const s = script()
    s.prompt('a', 'm1')
    s.enqueued('a', 'm1', 'user')
    s.started('a')
    s.delivered('a', 'm1')
    s.request('a')
    const {model} = replay(s.out, {limits: {...limits, rootInactivityMs: 1_000_000}, flush: false})

    // #when a long time passes
    model.observe({kind: 'tick', at: lastAt(s.out) + 100_000})

    // #then it is still running
    expect(model.stats()).toMatchObject({sessions: 1, openTraces: 1})
  })

  it('never forgets a session whose execution has started, though nothing else is open', () => {
    // #given a started execution with no request, no tool and no trace-level activity afterwards
    const s = script()
    s.prompt('a', 'm1')
    s.enqueued('a', 'm1', 'user')
    s.started('a')
    s.delivered('a', 'm1')
    const {model} = replay(s.out, {limits: {...limits, rootInactivityMs: 1_000_000}, flush: false})

    // #when a long time passes
    model.observe({kind: 'tick', at: lastAt(s.out) + 100_000})

    // #then it is still there
    expect(model.stats()).toMatchObject({sessions: 1, openTraces: 1})
  })

  it('keeps at most the idle bound of sessions, forgetting the least recently active first', () => {
    // #given five idle sessions, a to e, one more recent than the last
    const s = script()
    for (const [index, session] of ['a', 'b', 'c', 'd', 'e'].entries()) {
      s.at(index * 10)
      queue(s, session, session)
    }

    // #when
    const {model} = replay(s.out, {limits, flush: false})

    // #then three remain, and the two oldest were handed back
    expect(model.stats().sessions).toBe(3)
    expect(model.takeDiscarded()).toHaveLength(2)
  })

  it('does not count a running session against the idle bound, and never evicts it', () => {
    // #given one running session and four idle ones
    const s = script()
    s.prompt('run', 'mr')
    s.enqueued('run', 'mr', 'user')
    s.started('run')
    s.delivered('run', 'mr')
    s.request('run')
    for (const session of ['a', 'b', 'c', 'd']) queue(s, session, session)

    // #when
    const {model} = replay(s.out, {limits: {...limits, rootInactivityMs: 1_000_000}, flush: false})

    // #then the running one and three idle ones are there
    expect(model.stats()).toMatchObject({sessions: 4, openTraces: 1})
  })

  it('bounds the prompts one idle session holds, dropping the oldest and handing back its snapshot', () => {
    // #given three prompts queued for one session with a bound of two
    const s = script()
    const first = queue(s, 'a', '1')
    queue(s, 'a', '2')
    queue(s, 'a', '3')

    // #when
    const {model} = replay(s.out, {limits, flush: false})

    // #then the oldest is gone and was handed back
    expect(model.takeDiscarded()).toContain(first)
  })

  it('starts a clean turn for a session that was forgotten and then runs', () => {
    // #given a forgotten session, then a normal turn for the same id
    const s = script()
    queue(s, 'a', '1')
    s.tick(5_000)
    s.at(6_000)
    s.turn('a', '2')

    // #when
    const {records, model} = replay(s.out, {limits})

    // #then the turn is traced from its own prompt, and nothing is left
    expect(roots(records)).toHaveLength(1)
    expect(model.stats().sessions).toBe(0)
  })

  it('hands back everything it holds at flush', () => {
    // #given an idle session holding a prompt
    const s = script()
    const content = queue(s, 'a', '1')
    const {model} = replay(s.out, {limits})

    // #then flush released it
    expect(model.takeDiscarded()).toContain(content)
    expect(model.stats().sessions).toBe(0)
  })
})

describe('a repeated tool terminal event', () => {
  const openTurn = () => {
    const s = script()
    s.prompt('a', 'm1')
    s.enqueued('a', 'm1', 'user')
    s.started('a')
    s.delivered('a', 'm1')
    s.request('a')
    s.stepStarted('a', 's1')
    return s
  }
  const spansFor = (s: ReturnType<typeof script>, limits: Partial<typeof DEFAULT_LIMITS> = {}) => {
    s.stepEnded('a', 's1')
    s.ended('a')
    return tools(replay(s.out, {limits}).records)
  }

  it('does not emit a second span for the same call id', () => {
    // #given a call that succeeded, and then a repeat of its success event
    const s = openTurn()
    s.toolBefore('a', 'c1')
    s.toolEnded('a', 'c1')
    s.toolEnded('a', 'c1')

    // #when / #then one span
    expect(spansFor(s)).toHaveLength(1)
  })

  it('ignores a failure that follows a success, and a success that follows a failure', () => {
    // #given
    const s = openTurn()
    s.toolBefore('a', 'c1')
    s.toolEnded('a', 'c1')
    s.toolEnded('a', 'c1', {succeeded: false, errorType: 'aborted'})
    s.toolBefore('a', 'c2')
    s.toolEnded('a', 'c2', {succeeded: false, errorType: 'tool.execution'})
    s.toolEnded('a', 'c2')

    // #when
    const spans = spansFor(s)

    // #then the first outcome stands for each
    expect(spans.map(span => [span.callId, span.outcome])).toEqual([
      ['c1', 'success'],
      ['c2', 'error'],
    ])
  })

  it('ignores a repeated called event and a late hook for a call that already ended, and hands the snapshots back', () => {
    // #given a finished call, then its events and hooks again
    const s = openTurn()
    s.toolBefore('a', 'c1')
    s.toolEnded('a', 'c1')
    const input = {again: true}
    const result = {again: 'late'}
    s.toolCalled('a', 'c1', {input})
    s.hookBefore('a', 'c1', 'read', undefined, input)
    s.out.push({
      kind: 'tool.after',
      at: lastAt(s.out),
      sessionId: 'a',
      callId: 'c1',
      tool: 'read',
      status: 'completed',
      result,
    })
    s.toolEnded('a', 'c1', {result})
    s.stepEnded('a', 's1')
    s.ended('a')

    // #when
    const {records, model} = replay(s.out)

    // #then still one span, and the repeats' snapshots were handed back
    expect(tools(records)).toHaveLength(1)
    const handed = model.takeDiscarded()
    expect(handed).toContain(input)
    expect(handed).toContain(result)
    expect(model.stats().pendingToolNotes).toBe(0)
  })

  it('remembers a bounded number of finished calls per session: the oldest is forgotten past the bound', () => {
    // #given a bound of three, four calls, then repeats of the newest and of the oldest
    const s = openTurn()
    for (const id of ['c1', 'c2', 'c3', 'c4']) {
      s.toolBefore('a', id)
      s.toolEnded('a', id)
    }
    s.toolEnded('a', 'c4')
    s.toolEnded('a', 'c1')

    // #when
    const spans = spansFor(s, {maxCompletedCallsPerSession: 3})

    // #then the newest repeat was ignored, and the forgotten oldest came back as a span of its own
    expect(spans.map(span => span.callId)).toEqual(['c1', 'c2', 'c3', 'c4', 'c1'])
  })

  it('does not treat a call id reused in another session as a repeat', () => {
    // #given the same call id in two sessions
    const s = script()
    for (const session of ['a', 'b']) {
      s.prompt(session, `m-${session}`)
      s.enqueued(session, `m-${session}`, 'user')
      s.started(session)
      s.delivered(session, `m-${session}`)
      s.request(session)
      s.stepStarted(session, `s-${session}`)
      s.toolBefore(session, 'c1')
      s.toolEnded(session, 'c1')
      s.stepEnded(session, `s-${session}`)
      s.ended(session)
    }

    // #when / #then
    expect(tools(replay(s.out).records)).toHaveLength(2)
  })

  it('holds nothing at flush', () => {
    // #given finished calls
    const s = openTurn()
    s.toolBefore('a', 'c1')
    s.toolEnded('a', 'c1')

    // #when
    const {model} = replay(s.out)

    // #then
    expect(model.stats().sessions).toBe(0)
  })
})

describe('a report delivered inside a later turn after the dispatching trace closed', () => {
  const limits = {rootInactivityMs: 1_000, tombstoneTtlMs: 5_000}

  /** Turn one dispatches a child and goes quiet until its trace closes; turn two is running when the report arrives. */
  const scenario = (reportAt: number) => {
    const s = script()
    s.prompt('p', 'm1')
    s.enqueued('p', 'm1', 'user')
    s.started('p')
    s.delivered('p', 'm1')
    s.request('p')
    s.stepStarted('p', 's1')
    s.toolBefore('p', 'c1', 'subagent')
    s.toolAfter('p', 'c1', 'subagent', 'kid')
    s.toolEnded('p', 'c1', {childSessionId: 'kid'})
    s.stepEnded('p', 's1')
    s.ended('p')
    // The first trace's inactivity bound passes: it closes, incomplete, leaving a tombstone for the child.
    s.tick(lastAt(s.out) + 1_001)
    // A second turn is running when the report arrives, and its next request carries it.
    s.at(reportAt - 10)
    s.prompt('p', 'm2')
    s.enqueued('p', 'm2', 'user')
    s.started('p')
    s.delivered('p', 'm2')
    s.at(reportAt)
    s.enqueued('p', 'report', 'synthetic', 'kid', 'completed')
    // The recorded order: the request that carries the report goes out, then the inbox item is delivered.
    s.request('p')
    s.stepStarted('p', 's2')
    s.delivered('p', 'report')
    s.stepEnded('p', 's2')
    s.ended('p')
    return s
  }

  it('still names the first trace in follow_on_of, from its tombstone', () => {
    // #given a report that arrives well inside the tombstone's life
    const {records} = replay(scenario(2_000).out, {limits})

    // #then the second turn's model request names the first turn's trace
    const [first, second] = roots(records)
    const followOn = chats(records).find(chat => chat.traceId === second?.traceId && chat.requestKind === 'primary')
    expect(followOn?.followOnOf).toEqual([first?.traceId])
  })

  it('does not name it after the tombstone expired', () => {
    // #given a report after the tombstone's ttl
    const {records} = replay(scenario(10_000).out, {limits})

    // #then nothing is named, and the report did not open a trace of its own
    const [, second] = roots(records)
    const followOn = chats(records).find(chat => chat.traceId === second?.traceId && chat.requestKind === 'primary')
    expect(followOn?.followOnOf).toEqual([])
  })

  it('names a still-open origin as it did, and a trace is never named in its own follow-on', () => {
    // #given the recorded case where the report arrives while the first trace is open
    const {records} = run('prompt-while-subagent-runs-report-during')
    const names = chats(records).flatMap(chat => chat.followOnOf.map(id => [chat.traceId, id]))

    // #then it still names the other trace, never itself
    expect(names.length).toBeGreaterThan(0)
    expect(names.every(([own, named]) => own !== named)).toBe(true)
  })
})

describe('a child that finishes before its dispatch link arrives', () => {
  /** The parent dispatches; the child runs a whole turn (request, step, output, tool, usage, end) with the link still unknown. */
  const fastChild = (extra: (s: ReturnType<typeof script>) => void = () => {}) => {
    const s = script()
    s.prompt('p', 'm1')
    s.enqueued('p', 'm1', 'user')
    s.started('p')
    s.delivered('p', 'm1')
    s.request('p')
    s.stepStarted('p', 's1')
    s.toolBefore('p', 'c1', 'subagent')
    // The child's whole turn, before any observation names it as this tool's child.
    s.prompt('kid', 'mk')
    s.enqueued('kid', 'mk', 'user')
    s.started('kid')
    s.delivered('kid', 'mk')
    s.request('kid')
    s.stepStarted('kid', 'sk')
    s.text('kid', 'sk', 'child answer')
    s.toolBefore('kid', 'ck')
    s.toolEnded('kid', 'ck')
    s.stepEnded('kid', 'sk')
    s.ended('kid')
    extra(s)
    // Now the link arrives, and the parent finishes.
    s.toolAfter('p', 'c1', 'subagent', 'kid')
    s.toolEnded('p', 'c1', {childSessionId: 'kid'})
    s.stepEnded('p', 's1')
    // The child's report reaches the parent, which answers it in the same execution, as recorded.
    s.enqueued('p', 'rep', 'synthetic', 'kid', 'completed')
    s.request('p')
    s.stepStarted('p', 's2')
    s.delivered('p', 'rep')
    s.stepEnded('p', 's2')
    s.ended('p')
    return s
  }

  it('replays the whole child sequence in order, so output, usage and a normal close all happen, with no forced flush', () => {
    // #given
    const s = fastChild()

    // #when replayed with no flush
    const {records, model} = replay(s.out, {flush: false})

    // #then one trace: the child's model span has its output and usage, its tool span closed, and both agents ended ok
    expect(roots(records)).toHaveLength(1)
    const kidChat = chats(records).find(chat => chat.sessionId === 'kid')
    expect(kidChat?.texts).toEqual(['child answer'])
    expect(kidChat?.usage).toBeDefined()
    expect(kidChat?.status).toBe('ok')
    // the root session id is known by the time the link resolves, for every span the child produced
    expect(new Set(records.map(record => record.rootSessionId))).toEqual(new Set(['p']))
    expect(tools(records).filter(tool => tool.sessionId === 'kid')).toHaveLength(1)
    const invokes = records.filter(record => record.kind === 'invoke_agent')
    expect(invokes).toHaveLength(2)
    expect(invokes.every(record => record.status === 'ok' && !record.marks.includes('incomplete'))).toBe(true)
    expect(model.stats()).toMatchObject({openTraces: 0, sessions: 0, bufferedSessions: 0, bufferedBytes: 0})
  })

  it('names the child under the dispatching tool span, as when the link comes first', () => {
    // #given / #when
    const {records} = replay(fastChild().out, {flush: false})

    // #then
    const dispatch = tools(records).find(tool => tool.tool === 'subagent')
    const child = records.find(record => record.kind === 'invoke_agent' && record.sessionId === 'kid')
    expect(child?.parentSpanId).toBe(dispatch?.spanId)
  })

  it('buffers every later kind of observation for a buffered session, and counts them against the bound', () => {
    // #given a buffer bound of five observations and a child whose whole turn is longer than that
    const s = fastChild()

    // #when
    const {records, model} = replay(s.out, {flush: false, limits: {maxBufferedObservations: 5}})

    // #then past the bound the buffer is released as its own unattributed trace, whole and in order, never half
    const kidRoots = records.filter(record => record.kind === 'invoke_agent' && record.sessionId === 'kid')
    expect(kidRoots).toHaveLength(1)
    expect(chats(records).find(chat => chat.sessionId === 'kid')?.texts).toEqual(['child answer'])
    expect(model.stats().bufferedSessions).toBe(0)
  })

  it('releases a buffered session that never gets its link as an unattributed trace at the window, with everything it did', () => {
    // #given a child whose whole turn arrives and whose link never does
    const s = script()
    s.prompt('p', 'm1')
    s.enqueued('p', 'm1', 'user')
    s.started('p')
    s.delivered('p', 'm1')
    s.request('p')
    s.stepStarted('p', 's1')
    s.toolBefore('p', 'c1', 'subagent')
    s.created('kid', 'p')
    s.prompt('kid', 'mk')
    s.enqueued('kid', 'mk', 'user')
    s.started('kid')
    s.delivered('kid', 'mk')
    s.request('kid')
    s.stepStarted('kid', 'sk')
    s.text('kid', 'sk', 'orphan answer')
    s.stepEnded('kid', 'sk')
    s.ended('kid')
    s.tick(lastAt(s.out) + DEFAULT_LIMITS.bufferWindowMs + 1)

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then it has its own trace marked unattributed, with its output, and it closed normally
    const kidRoot = records.find(record => record.kind === 'invoke_agent' && record.sessionId === 'kid')
    expect(kidRoot?.marks).toContain('unattributed')
    expect(kidRoot?.status).toBe('ok')
    expect(chats(records).find(chat => chat.sessionId === 'kid')?.texts).toEqual(['orphan answer'])
  })
})

describe('an observation whose text the pipeline omitted', () => {
  const open = (s: ReturnType<typeof script>, kind: 'primary' | 'compaction' | 'title' = 'primary') => {
    s.prompt('a', 'm1')
    s.enqueued('a', 'm1', 'user')
    s.started('a')
    s.delivered('a', 'm1')
    s.request('a', kind)
  }

  it('adds no text part and marks the request, for output', () => {
    // #given an output observation the pipeline emptied and marked omitted
    const s = script()
    open(s)
    s.stepStarted('a', 's1')
    s.out.push({
      kind: 'output',
      at: lastAt(s.out),
      sessionId: 'a',
      messageId: 's1',
      part: 'text',
      text: '',
      omitted: true,
    })
    s.text('a', 's1', 'kept')
    s.stepEnded('a', 's1')
    s.ended('a')

    // #when
    const chat = chats(replay(s.out).records)[0]

    // #then only the kept part is there, and the span says output is missing
    expect(chat?.texts).toEqual(['kept'])
    expect(chat?.gaps).toContain('output-omitted')
  })

  it('does the same for a compaction summary and a title', () => {
    // #given
    const compaction = script()
    open(compaction, 'compaction')
    compaction.out.push({kind: 'compaction.ended', at: 50, sessionId: 'a', ok: true, text: undefined, omitted: true})
    compaction.ended('a')
    const title = script()
    title.prompt('a', 'm1')
    title.enqueued('a', 'm1', 'user')
    title.started('a')
    title.delivered('a', 'm1')
    title.request('a', 'title')
    title.out.push({kind: 'title', at: 60, sessionId: 'a', title: '', omitted: true})
    title.ended('a')

    // #when
    const summarized = chats(replay(compaction.out).records).find(chat => chat.requestKind === 'compaction')
    const titled = chats(replay(title.out).records).find(chat => chat.requestKind === 'title')

    // #then neither carries a text, both say so
    expect(summarized?.texts).toEqual([])
    expect(summarized?.gaps).toContain('output-omitted')
    expect(titled?.texts).toEqual([])
    expect(titled?.gaps).toContain('output-omitted')
  })
})

describe('a session id in an ordinary tool’s result', () => {
  const turnWith = (tool: string, viaHook: boolean) => {
    const s = script()
    s.prompt('p', 'm1')
    s.enqueued('p', 'm1', 'user')
    s.started('p')
    s.delivered('p', 'm1')
    s.request('p')
    s.stepStarted('p', 's1')
    s.toolBefore('p', 'c1', tool)
    if (viaHook) s.toolAfter('p', 'c1', tool, 'not-a-child')
    s.toolEnded('p', 'c1', {childSessionId: 'not-a-child'})
    s.stepEnded('p', 's1')
    s.ended('p')
    return s
  }

  it.each([
    ['the success event', false],
    ['the after hook and the success event', true],
  ])(
    'is not a subagent dispatch: carried by %s of a `read` call, the root closes with nothing to wait for',
    (_label, viaHook) => {
      // #given an ordinary tool whose result metadata carries a session id
      const s = turnWith('read', viaHook)

      // #when replayed with no flush
      const {records, model} = replay(s.out, {flush: false})

      // #then no child was linked: the root closed normally on its own, and nothing is outstanding
      const invokes = records.filter(record => record.kind === 'invoke_agent')
      expect(invokes).toHaveLength(1)
      expect(invokes[0]).toMatchObject({status: 'ok'})
      expect(invokes[0]?.marks).not.toContain('incomplete')
      expect(tools(records)[0]?.childSessionId).toBeUndefined()
      expect(model.stats()).toMatchObject({openTraces: 0, sessions: 0, unresolvedDispatches: 0})
    },
  )

  it('is still a dispatch for the subagent tool, by either path', () => {
    // #given the same with the subagent tool, which then reports back
    const s = script()
    s.prompt('p', 'm1')
    s.enqueued('p', 'm1', 'user')
    s.started('p')
    s.delivered('p', 'm1')
    s.request('p')
    s.stepStarted('p', 's1')
    s.toolBefore('p', 'c1', 'subagent')
    s.toolEnded('p', 'c1', {childSessionId: 'kid'})
    s.stepEnded('p', 's1')
    s.ended('p')

    // #when replayed with no flush
    const {model} = replay(s.out, {flush: false})

    // #then the root waits for the child's report
    expect(model.stats().openTraces).toBe(1)
  })
})

describe('a step belongs to the latest primary hook at or before its own start time', () => {
  const CAP = {maxOpenSpansPerTrace: 1}
  const chatWith = (records: readonly SpanRecord[], text: string) =>
    chats(records).find(chat => chat.requestKind === 'primary' && chat.texts.includes(text))
  const primaries = (records: readonly SpanRecord[], sessionId = 'p') =>
    chats(records).filter(chat => chat.requestKind === 'primary' && chat.sessionId === sessionId)
  const hook = (s: ReturnType<typeof script>, session: string, at: number): void => {
    s.request(session, 'primary', {at})
  }
  const step = (
    s: ReturnType<typeof script>,
    session: string,
    message: string,
    started: number,
    text?: string,
  ): void => {
    s.stepStarted(session, message, started)
    if (text !== undefined) s.text(session, message, text)
    s.stepEnded(session, message)
  }
  const retry = (s: ReturnType<typeof script>, session: string, attempt = 2): void => {
    s.out.push({
      kind: 'retry',
      sessionId: session,
      attempt,
      willRetry: true,
      error: {type: 'provider.internal', message: 'x'},
      at: lastAt(s.out) + 1,
    })
  }

  /** What an uncertain chat span exports: nothing a step produced, an incomplete outcome, and the gap. */
  const expectNoStepData = (chat: ChatRecord): void => {
    expect(chat.gaps).toContain('step-binding-uncertain')
    expect(chat.status).toBe('interrupted')
    expect(chat.marks).toContain('incomplete')
    expect(chat.error).toBeUndefined()
    expect(chat.texts).toEqual([])
    expect(chat.reasoning).toEqual([])
    expect(chat.toolCalls).toEqual([])
    expect(chat.finishReason).toBeUndefined()
    expect(chat.usage).toBeUndefined()
    expect(chat.messageId).toBeUndefined()
  }

  it('binds each step to its own hook when steps and hooks arrive in order', () => {
    // #given two requests, each with its own step, in order
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    step(s, 'p', 'm1', 100, 'one')
    hook(s, 'p', 200)
    step(s, 'p', 'm2', 200, 'two')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then
    expect(chatWith(records, 'one')?.messageId).toBe('m1')
    expect(chatWith(records, 'two')?.messageId).toBe('m2')
    expect(chats(records).some(chat => chat.gaps.includes('step-binding-uncertain'))).toBe(false)
  })

  it('binds correctly when hook(n+1) is observed before step.ended(n) and before step.started(n)', () => {
    // #given the next hook observed first, then step n's start, text and end, then step n+1
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    hook(s, 'p', 200)
    step(s, 'p', 'm1', 100, 'one')
    step(s, 'p', 'm2', 200, 'two')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then arrival order is irrelevant: each text is on its own request
    expect(chatWith(records, 'one')?.messageId).toBe('m1')
    expect(chatWith(records, 'two')?.messageId).toBe('m2')
    expect(chatWith(records, 'one')?.start).toBe(100)
    expect(chatWith(records, 'two')?.start).toBe(200)
  })

  it('treats a start at exactly the hook’s time as that hook’s step', () => {
    // #given a hook and a step that share a millisecond, and a later hook
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    hook(s, 'p', 150)
    step(s, 'p', 'm1', 100, 'one')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then the tie goes to the hook at that time, not to a later one
    expect(chatWith(records, 'one')?.start).toBe(100)
  })

  it('binds nothing when two hooks share the newest time at or before the start, since they cannot be told apart', () => {
    // #given two hooks in the same millisecond and a step started at it
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    hook(s, 'p', 100)
    step(s, 'p', 'm1', 100, 'one')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then
    expect(JSON.stringify(records)).not.toContain('"one"')
  })

  it('binds nothing for a step with no usable start time', () => {
    // #given steps with no `started`, and with values that are not finite numbers
    for (const started of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      s.out.push({kind: 'step.started', sessionId: 'p', messageId: 'm1', started, at: lastAt(s.out) + 1})
      s.text('p', 'm1', 'one')
      s.stepEnded('p', 'm1')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then
      expect(JSON.stringify(records)).not.toContain('"one"')
    }
  })

  it('binds nothing for a step that starts before every hook the session has recorded', () => {
    // #given a step whose hook was never seen
    const s = script()
    s.started('p')
    hook(s, 'p', 200)
    step(s, 'p', 'm1', 100, 'orphan text')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then the hook at 200 is not its hook
    expect(JSON.stringify(records)).not.toContain('orphan text')
  })

  it('keeps helper requests out of the join: a title hook between a hook and its step is not a candidate', () => {
    // #given a primary hook, a title hook after it, and the primary's step starting after both
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    s.request('p', 'title', {at: 105})
    step(s, 'p', 'm1', 110, 'one')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then the step is the primary's
    expect(chatWith(records, 'one')?.requestKind).toBe('primary')
  })

  it('does not give a refused request’s text to the next admitted request (the first review’s case)', () => {
    // #given a cap of one span: request 1 admitted and bound, request 2 refused, request 1 ends, request 3 admitted, then request
    // 2's own step arrives after request 3's hook, and request 3's own
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    s.stepStarted('p', 'm1', 100)
    hook(s, 'p', 200)
    s.text('p', 'm1', 'one')
    s.stepEnded('p', 'm1')
    hook(s, 'p', 300)
    step(s, 'p', 'm2', 200, 'second request text')
    step(s, 'p', 'm3', 300, 'third request text')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {limits: CAP, flush: false})

    // #then the refused request's step bound nothing, and request 3 has its own
    expect(JSON.stringify(records)).not.toContain('second request text')
    expect(chatWith(records, 'third request text')?.messageId).toBe('m3')
    expect(chatWith(records, 'one')?.messageId).toBe('m1')
  })

  it('does not shift later steps when a refused request’s step.started is delivered, and both later requests are admitted (the second review’s case)', () => {
    // #given a cap of two: both slots filled, R refused, both slots freed by their steps, R's step discarded, then A and B admitted
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    hook(s, 'p', 200)
    hook(s, 'p', 300)
    step(s, 'p', 'm1', 100, 'first')
    step(s, 'p', 'm2', 200, 'second')
    s.stepStarted('p', 'mR', 300)
    hook(s, 'p', 400)
    step(s, 'p', 'mA', 401, 'A output')
    hook(s, 'p', 500)
    step(s, 'p', 'mB', 501, 'B output')
    s.ended('p')

    // #when
    const {records, model} = replay(s.out, {limits: {maxOpenSpansPerTrace: 2}, flush: false})

    // #then A and B were both admitted, each carries its own output, and nothing of R's exists
    expect(chatWith(records, 'A output')?.messageId).toBe('mA')
    expect(chatWith(records, 'B output')?.messageId).toBe('mB')
    expect(chatWith(records, 'first')?.messageId).toBe('m1')
    expect(chatWith(records, 'second')?.messageId).toBe('m2')
    expect(primaries(records)).toHaveLength(4)
    expect(model.stats().withholds).toBe(0)
  })

  it('withholds when a refused request’s step.started never comes: the later step could be its own', () => {
    // #given the same, with R's step never delivered
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    hook(s, 'p', 200)
    hook(s, 'p', 300)
    step(s, 'p', 'm1', 100, 'first')
    step(s, 'p', 'm2', 200, 'second')
    hook(s, 'p', 400)
    step(s, 'p', 'mA', 401, 'A output')
    hook(s, 'p', 500)
    step(s, 'p', 'mB', 501, 'B output')
    s.ended('p')

    // #when
    const {records, model} = replay(s.out, {limits: {maxOpenSpansPerTrace: 2}, flush: false})

    // #then what was bound before the step that could not be placed keeps its step, and nothing after it carries one
    expect(chatWith(records, 'first')?.messageId).toBe('m1')
    expect(chatWith(records, 'second')?.messageId).toBe('m2')
    expect(JSON.stringify(records)).not.toMatch(/A output|B output/)
    expect(model.stats().withholds).toBe(1)
    for (const chat of primaries(records).filter(candidate => candidate.start >= 400)) expectNoStepData(chat)
  })

  it('binds nothing for a delayed step after a trace-cap eviction and a reopening with no execution.ended (the third review’s case)', () => {
    // #given session p with a request, another root that evicts p's trace, then p asking again, and p's old step arriving late
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    s.started('q')
    hook(s, 'q', 150)
    hook(s, 'p', 200)
    s.stepStarted('p', 'late-step', 100)
    s.text('p', 'late-step', 'delayed text')
    s.stepEnded('p', 'late-step')
    s.stepStarted('p', 'own-step', 200)
    s.text('p', 'own-step', 'own text')
    s.stepEnded('p', 'own-step')
    s.ended('p')

    // #when the cap holds one trace
    const {records} = replay(s.out, {limits: {maxOpenTraces: 1}, flush: false})

    // #then the delayed step bound to nothing; the reopened request has its own step
    expect(JSON.stringify(records)).not.toContain('delayed text')
    expect(chatWith(records, 'own text')?.messageId).toBe('own-step')
  })

  it('exports no error, finish reason or usage for a step that bound nothing, and no foreign metadata', () => {
    // #given a refused request whose step then FAILS with its own error, agent, model and provider, and an admitted one after it
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    s.stepStarted('p', 'm1', 100)
    hook(s, 'p', 200)
    s.out.push({
      kind: 'step.started',
      sessionId: 'p',
      messageId: 'foreign',
      started: 200,
      agent: 'FOREIGN-AGENT',
      model: 'FOREIGN-MODEL',
      provider: 'FOREIGN-PROVIDER',
      at: lastAt(s.out) + 1,
    })
    s.out.push({
      kind: 'step.failed',
      sessionId: 'p',
      messageId: 'foreign',
      error: {type: 'FOREIGN-ERROR', message: 'FOREIGN-MESSAGE', status: 503},
      usage: USAGE,
      at: lastAt(s.out) + 1,
    })
    s.text('p', 'm1', 'one')
    s.stepEnded('p', 'm1')
    s.ended('p')

    // #when the second hook is refused by the cap
    const {records} = replay(s.out, {limits: CAP, flush: false})

    // #then nothing of the failed step is anywhere
    expect(JSON.stringify(records)).not.toContain('FOREIGN')
    expect(chatWith(records, 'one')?.messageId).toBe('m1')
  })

  it('keeps hook-time agent, model and provider apart from the step’s: a request that never bound shows only its own', () => {
    // #given a request hook with no agent, model or provider, a loss that makes it uncertain, and a step that would resolve to it
    const s = script()
    s.started('p')
    s.out.push({kind: 'request', sessionId: 'p', requestKind: 'primary', content: {messages: []}, at: 100})
    s.lost(['p'], 'inbox-full')
    s.out.push({
      kind: 'step.started',
      sessionId: 'p',
      messageId: 'm1',
      started: 100,
      agent: 'FOREIGN-AGENT',
      model: 'FOREIGN-MODEL',
      provider: 'FOREIGN-PROVIDER',
      at: lastAt(s.out) + 1,
    })
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then
    expect(primaries(records)).toHaveLength(1)
    for (const chat of primaries(records)) {
      expectNoStepData(chat)
      expect([chat.agent, chat.model, chat.provider]).toEqual([undefined, undefined, undefined])
      expect(chat.name).toBe('chat primary')
    }
    expect(JSON.stringify(records)).not.toContain('FOREIGN')
  })

  it('withholds the session when a step starts in its own hook’s millisecond and an orphan hook is still waiting before it (the cost of the abandoned-request rule)', () => {
    // #given an orphan hook that never gets a step, and the next hook whose step started exactly at its time
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    hook(s, 'p', 300)
    step(s, 'p', 'm9', 300, 'maybe the orphan’s')
    hook(s, 'p', 400)
    step(s, 'p', 'm10', 400, 'next one is fine')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then the whole session is withheld until its execution ends: no request, the one after included, carries step data
    expect(JSON.stringify(records)).not.toMatch(/maybe the orphan|next one is fine/)
    expect(primaries(records)).toHaveLength(3)
    for (const chat of primaries(records)) expectNoStepData(chat)
  })

  it('lets a pending primary that never saw a step survive the execution boundary without taking the next execution’s step', () => {
    // #given a primary with no step, the execution ending (a title keeps the session), and a new execution with its own request
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    s.request('p', 'title', {at: 101})
    s.ended('p')
    s.started('p')
    hook(s, 'p', 300)
    step(s, 'p', 'm9', 301, 'its own first step')
    s.ended('p')

    // #when
    const {records, model} = replay(s.out, {flush: false})

    // #then the new execution's step went to the new request, and the session kept its record across the boundary
    expect(chatWith(records, 'its own first step')?.start).toBe(300)
    expect(model.stats().hookTimes).toBeGreaterThan(0)
  })

  it('treats a loss as having possibly taken the step.started of every request waiting at that point, and only those', () => {
    // #given request 1 waiting, a loss, request 2 after the loss, and both steps
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    s.lost(['p'], 'inbox-full')
    hook(s, 'p', 200)
    step(s, 'p', 'm1', 100, 'one')
    step(s, 'p', 'm2', 200, 'two')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then request 1 is uncertain and holds no data; request 2, hooked after the marker, matches normally
    expect(JSON.stringify(records)).not.toContain('"one"')
    expect(chatWith(records, 'two')?.messageId).toBe('m2')
    const waiting = primaries(records).filter(chat => chat.gaps.includes('step-binding-uncertain'))
    expect(waiting).toHaveLength(1)
    expect(waiting[0]?.start).toBe(100)
    if (waiting[0] !== undefined) expectNoStepData(waiting[0])
  })

  it('treats a loss that names no session as a loss for every session', () => {
    // #given two sessions each with a request waiting, and a loss that names none
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    s.started('q')
    hook(s, 'q', 110)
    s.lost(undefined, 'identifier-too-long')
    step(s, 'p', 'mp', 100, 'p text')
    step(s, 'q', 'mq', 110, 'q text')
    s.ended('p')
    s.ended('q')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then
    expect(JSON.stringify(records)).not.toMatch(/"(p text|q text)"/)
    expect(chats(records).filter(chat => chat.gaps.includes('step-binding-uncertain'))).toHaveLength(2)
  })

  it('needs nothing for a lost hook: its step resolves to the older hook, which already has a step, and binds nothing', () => {
    // #given request 1 complete, request 2's hook lost (with its marker), its step arriving, and request 3 with its own step
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    step(s, 'p', 'm1', 100, 'one')
    s.lost(['p'], 'inbox-full')
    step(s, 'p', 'm2', 200, 'lost hook text')
    hook(s, 'p', 300)
    step(s, 'p', 'm3', 300, 'three')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then the orphan step is nobody's, and the others are their own
    expect(JSON.stringify(records)).not.toContain('lost hook text')
    expect(chatWith(records, 'one')?.messageId).toBe('m1')
    expect(chatWith(records, 'three')?.messageId).toBe('m3')
  })

  it('survives the double loss: hook n+1 lost AND step.started n lost', () => {
    // #given request 1 whose step.started is lost, request 2's hook lost, then request 2's step, and request 3 with its own
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    s.lost(['p'], 'inbox-full')
    s.lost(['p'], 'inbox-full')
    s.text('p', 'm1', 'one')
    s.stepEnded('p', 'm1')
    s.stepStarted('p', 'm2', 200)
    s.text('p', 'm2', 'two')
    s.stepEnded('p', 'm2')
    hook(s, 'p', 300)
    step(s, 'p', 'm3', 300, 'three')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then request 2's step resolves to request 1's hook, which is uncertain, and binds nothing; request 3 is its own
    expect(JSON.stringify(records)).not.toMatch(/"(one|two)"/)
    expect(chatWith(records, 'three')?.messageId).toBe('m3')
    const waiting = primaries(records).filter(chat => chat.gaps.includes('step-binding-uncertain'))
    expect(waiting).toHaveLength(1)
  })

  it('records a pre-output retry exactly: the failed attempt is its own span, and the retried attempt reuses the message id', () => {
    // #given attempt 1 (hook, retry hook, its step.started), attempt 2 (hook, step.started with the SAME message id, text, end)
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    retry(s, 'p')
    s.stepStarted('p', 'm1', 100)
    hook(s, 'p', 1800)
    s.stepStarted('p', 'm1', 1800)
    s.text('p', 'm1', 'recovered')
    s.stepEnded('p', 'm1')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then
    const [failed, ok] = primaries(records)
    expect(failed?.status).toBe('error')
    expect(failed?.attempt).toBe(1)
    expect(failed?.messageId).toBeUndefined()
    expect(ok?.texts).toEqual(['recovered'])
    expect(ok?.attempt).toBe(2)
    expect(ok?.start).toBe(1800)
  })

  it('holds no step open for a failed attempt whose request a retry hook already closed', () => {
    // #given a pre-output failure: the retry hook closes the request, then the failed attempt's step.started is delivered, and the
    // second attempt never starts its step
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    retry(s, 'p')
    s.stepStarted('p', 'm1', 100)

    // #when the session is still running (no execution end yet)
    const {model} = replay(s.out, {flush: false})

    // #then the step bound to nothing, so nothing waits for an end that will not come
    expect(model.stats().openSteps).toBe(0)
  })

  it('records the same retry when the failed attempt’s step.started is delivered after the next hook', () => {
    // #given the retry's hook and step.started delivered late, after the next attempt's hook
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    retry(s, 'p')
    hook(s, 'p', 1800)
    s.stepStarted('p', 'm1', 100)
    s.stepStarted('p', 'm1', 1800)
    s.text('p', 'm1', 'recovered')
    s.stepEnded('p', 'm1')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then
    const [failed, ok] = primaries(records)
    expect(failed?.status).toBe('error')
    expect(ok?.texts).toEqual(['recovered'])
    expect(ok?.start).toBe(1800)
  })

  it('does not close a request that already has a step when a retry hook follows it (a failure after output)', () => {
    // #given a step with output, the retry hook, then the step's failure, and a second attempt
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    s.stepStarted('p', 'm1', 100)
    s.text('p', 'm1', 'partial')
    retry(s, 'p')
    s.out.push({kind: 'step.failed', sessionId: 'p', messageId: 'm1', error: {type: 'aborted'}, at: lastAt(s.out) + 1})
    hook(s, 'p', 1800)
    step(s, 'p', 'm2', 1800, 'recovered')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then the failed attempt keeps its partial text, closed by its own failure
    const [failed, ok] = primaries(records)
    expect(failed?.texts).toEqual(['partial'])
    expect(failed?.messageId).toBe('m1')
    expect(ok?.texts).toEqual(['recovered'])
  })

  it('does not carry a retry’s attempt number past the hook that consumed it, nor past a refused one', () => {
    // #given a retry (attempt 2), its hook refused by the cap, and the next hooks
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    s.stepStarted('p', 'm1', 100)
    retry(s, 'p')
    hook(s, 'p', 200)
    s.stepStarted('p', 'm1', 200)
    s.text('p', 'm1', 'one')
    s.stepEnded('p', 'm1')
    hook(s, 'p', 300)
    step(s, 'p', 'm3', 301, 'third')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {limits: CAP, flush: false})

    // #then the refused hook consumed the 2; the third request is attempt 1
    expect(chatWith(records, 'third')?.attempt).toBe(1)
  })

  it('bounds the hook record per session: evicting a hook that never got its step withholds the session', () => {
    // #given a record of three hooks and five requests, none of which has had a step when the oldest are evicted
    const s = script()
    s.started('p')
    for (const at of [100, 200, 300, 400, 500]) hook(s, 'p', at)
    step(s, 'p', 'm3', 301, 'three')
    step(s, 'p', 'm5', 501, 'five')
    s.ended('p')

    // #when
    const {records, model} = replay(s.out, {limits: {maxHookTimes: 3}, flush: false})

    // #then nothing in the session carries step data, and the record is empty again at the end
    expect(JSON.stringify(records)).not.toMatch(/"(three|five)"/)
    expect(primaries(records)).toHaveLength(5)
    for (const chat of primaries(records)) expectNoStepData(chat)
    expect(model.stats().hookTimes).toBe(0)
  })

  it('evicts hooks that already had their step without withholding: a long session stays bound', () => {
    // #given a record of three and ten requests, each with its own step in order
    const s = script()
    s.started('p')
    for (let index = 1; index <= 10; index += 1) {
      hook(s, 'p', index * 100)
      step(s, 'p', `m${String(index)}`, index * 100, `text ${String(index)}`)
    }
    s.ended('p')

    // #when
    const {records, model} = replay(s.out, {limits: {maxHookTimes: 3}, flush: false})

    // #then every request has its own step
    expect(chats(records).filter(chat => chat.gaps.includes('step-binding-uncertain'))).toHaveLength(0)
    expect(chatWith(records, 'text 10')?.messageId).toBe('m10')
    expect(chatWith(records, 'text 1')?.messageId).toBe('m1')
    expect(model.stats().hookTimes).toBeLessThanOrEqual(3)
  })

  it('keeps a subagent’s hooks in its own record: its times never resolve a parent’s step', () => {
    // #given a parent and a dispatched child whose hook times interleave with the parent's
    const s = script()
    s.prompt('p', 'mp')
    s.enqueued('p', 'mp', 'user')
    s.started('p')
    s.delivered('p', 'mp')
    hook(s, 'p', 100)
    s.stepStarted('p', 'sp1', 100)
    s.toolBefore('p', 'c1', 'subagent', 'sp1')
    s.toolAfter('p', 'c1', 'subagent', 'kid')
    s.toolEnded('p', 'c1', {childSessionId: 'kid'})
    s.created('kid', 'p')
    s.prompt('kid', 'mk')
    s.enqueued('kid', 'mk', 'user')
    s.started('kid')
    s.delivered('kid', 'mk')
    hook(s, 'kid', 150)
    hook(s, 'p', 160)
    s.text('p', 'sp1', 'parent one')
    s.stepEnded('p', 'sp1')
    step(s, 'p', 'sp2', 160, 'parent two')
    step(s, 'kid', 'sk', 150, 'child text')
    s.ended('kid')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then each text is on its own session's span
    expect(chatWith(records, 'child text')?.sessionId).toBe('kid')
    expect(chatWith(records, 'parent two')?.sessionId).toBe('p')
  })

  describe('a step that starts in the same millisecond as a later hook', () => {
    const uncertain = (records: readonly SpanRecord[]) =>
      primaries(records).filter(chat => chat.gaps.includes('step-binding-uncertain'))

    it('binds nothing and marks both requests when the earlier one is still waiting (the review’s case)', () => {
      // #given hook 1 at 100, its attempt started and finished at 101, hook 2 at 101, then step 1's delayed start (started 101), text, end
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      hook(s, 'p', 101)
      step(s, 'p', 'm1', 101, 'ONE')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then neither request carries ONE: the step could be either one's, and both say so
      expect(JSON.stringify(records)).not.toContain('"ONE"')
      expect(uncertain(records).map(chat => chat.start)).toEqual([100, 101])
      for (const chat of uncertain(records)) expectNoStepData(chat)
    })

    it('withholds the whole session for a chain of waiting hooks, the later ones included', () => {
      // #given four hooks, the first three waiting, a step that started at the third's time, and a fourth hook after it
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      hook(s, 'p', 101)
      hook(s, 'p', 102)
      hook(s, 'p', 150)
      step(s, 'p', 'm1', 102, 'ONE')
      step(s, 'p', 'm4', 150, 'FOUR')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then no request carries step data, the fourth included
      expect(uncertain(records).map(chat => chat.start)).toEqual([100, 101, 102, 150])
      expect(JSON.stringify(records)).not.toMatch(/"(ONE|FOUR)"/)
    })

    it('withholds the earlier waiting hook, the equal-time one and every later request', () => {
      // #given an older waiting hook, a hook at the step's start time, and a hook after it
      const s = script()
      s.started('p')
      hook(s, 'p', 50)
      hook(s, 'p', 100)
      hook(s, 'p', 101)
      step(s, 'p', 'm1', 100, 'ONE')
      step(s, 'p', 'm3', 101, 'THREE')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then
      expect(uncertain(records).map(chat => chat.start)).toEqual([50, 100, 101])
      expect(JSON.stringify(records)).not.toMatch(/"(ONE|THREE)"/)
    })

    it('withholds nothing in an ordinary run, where a step shares its own hook’s millisecond and the earlier request has its step', () => {
      // #given steps that start at exactly their hook's time, delivered in order, back to back in the same millisecond or the next
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      step(s, 'p', 'm1', 100, 'ONE')
      hook(s, 'p', 100 + 1)
      step(s, 'p', 'm2', 101, 'TWO')
      hook(s, 'p', 102)
      step(s, 'p', 'm3', 102, 'THREE')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then each carries its own
      expect(uncertain(records)).toHaveLength(0)
      expect(chatWith(records, 'ONE')?.messageId).toBe('m1')
      expect(chatWith(records, 'TWO')?.messageId).toBe('m2')
      expect(chatWith(records, 'THREE')?.messageId).toBe('m3')
    })

    it('treats a refused earlier hook as waiting too: its step could be the one that arrives', () => {
      // #given a cap of one span held by a tool call, so hook 1 at 100 is refused; the call ends, hook 2 at 101 is admitted, and
      // the refused request's delayed step arrives (started 101)
      const s = script()
      s.started('p')
      s.toolNamed('p', 'c0')
      s.toolCalled('p', 'c0')
      hook(s, 'p', 100)
      s.toolEnded('p', 'c0')
      hook(s, 'p', 101)
      step(s, 'p', 'm1', 101, 'ONE')
      s.ended('p')

      // #when
      const {records, model} = replay(s.out, {limits: CAP, flush: false})

      // #then the step's text is on no span, and the admitted request says why
      expect(model.stats().droppedSpans).toBe(1)
      expect(JSON.stringify(records)).not.toContain('"ONE"')
      expect(uncertain(records).map(chat => chat.start)).toEqual([101])
    })

    it('marks both requests that share the newest time and bind nothing (a tie)', () => {
      // #given two hooks in the same millisecond and a step that started in it
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      hook(s, 'p', 100)
      step(s, 'p', 'm1', 100, 'ONE')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then
      expect(uncertain(records)).toHaveLength(2)
    })
  })

  describe('the review’s two successive same-millisecond boundaries', () => {
    it('never puts B’s output, message id or usage on C’s span, whatever order hooks and step events are observed in', () => {
      // #given A's hook at 19, A's step 20..20, B's hook at 20, B's step 21..21, C's hook at 21, every hook observed before the
      // step events (the pull loop lags)
      const s = script()
      s.started('p')
      hook(s, 'p', 19)
      hook(s, 'p', 20)
      hook(s, 'p', 21)
      step(s, 'p', 'mA', 20, 'A TEXT')
      step(s, 'p', 'mB', 21, 'B TEXT')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then no span carries a text, message id or usage of a step: the join could not tell the owners apart
      expect(JSON.stringify(records)).not.toMatch(/"(A|B) TEXT"/)
      for (const chat of primaries(records)) {
        expect(chat.messageId).toBeUndefined()
        expect(chat.usage).toBeUndefined()
        expect(chat.gaps).toContain('step-binding-uncertain')
      }
    })

    it('does the same when another plugin’s slow hook separates our hook from its own step (a long hook-to-start gap)', () => {
      // #given our hook at 0, its step started at 50 (another plugin's hook ran in between) and finished, the next hook at 50
      const s = script()
      s.started('p')
      hook(s, 'p', 0)
      hook(s, 'p', 50)
      step(s, 'p', 'm1', 50, 'FIRST TEXT')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then the step could be either's: nobody carries it
      expect(JSON.stringify(records)).not.toContain('FIRST TEXT')
      for (const chat of primaries(records)) expectNoStepData(chat)
    })
  })

  describe('a wall clock that goes backwards', () => {
    it('does not let an orphan hook before the rollback take the step after it (the review’s case)', () => {
      // #given hook 1 at 100 that never gets a step, the clock stepping back, hook 2 at 90, and its attempt starting at 101
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      hook(s, 'p', 90)
      step(s, 'p', 'm2', 101, 'SECOND')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then nobody carries SECOND; both requests are uncertain
      expect(JSON.stringify(records)).not.toContain('"SECOND"')
      expect(primaries(records).filter(chat => chat.gaps.includes('step-binding-uncertain'))).toHaveLength(2)
    })

    it('does not let a step from before the rollback, delivered after it, bind the request hooked after it', () => {
      // #given step 1 (started 101) delayed past the rollback hook at 90
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      hook(s, 'p', 90)
      step(s, 'p', 'm1', 101, 'ONE')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then
      expect(JSON.stringify(records)).not.toContain('"ONE"')
    })

    it('withholds a step that starts before the previous one (steps run in order), and everything that is then ambiguous', () => {
      // #given two steps in a session whose second started before the first (steps run one after another)
      const s = script()
      s.started('p')
      hook(s, 'p', 200)
      step(s, 'p', 'm1', 200, 'ONE')
      hook(s, 'p', 210)
      hook(s, 'p', 215)
      step(s, 'p', 'm2', 150, 'TWO')
      step(s, 'p', 'm3', 215, 'THREE')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then the first keeps its own; nothing after the discontinuity is trusted, and the hooks still waiting say so
      expect(chatWith(records, 'ONE')?.messageId).toBe('m1')
      expect(JSON.stringify(records)).not.toMatch(/"(TWO|THREE)"/)
      expect(
        primaries(records)
          .filter(chat => chat.gaps.includes('step-binding-uncertain'))
          .map(chat => chat.start),
      ).toEqual([210, 215])
    })

    it('does not mistake ordinary lag for a rollback: a step older than a hook that already has its step is fine', () => {
      // #given hook 2 observed before step 1's events, as the pull loop makes routine
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      hook(s, 'p', 150)
      step(s, 'p', 'm1', 100, 'ONE')
      step(s, 'p', 'm2', 150, 'TWO')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then
      expect(chatWith(records, 'ONE')?.messageId).toBe('m1')
      expect(chatWith(records, 'TWO')?.messageId).toBe('m2')
    })

    it('sees a rollback that follows a LOST hook: the loss marker carries the lost hook’s time', () => {
      // #given hook 1 at 100 with its step bound, hook 2 LOST (its marker carries its time, 200), the clock stepping back, hook 3 at
      // 150, then hook 2's delayed step (started 201), which would resolve to hook 3
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      step(s, 'p', 'm1', 100, 'one')
      s.out.push({kind: 'loss', sessionIds: ['p'], reason: 'inbox-full', hookAt: new Map([['p', 200]]), at: 200})
      hook(s, 'p', 150)
      step(s, 'p', 'm2', 201, 'TWO')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then nobody carries TWO, and the request hooked after the loss says why
      expect(JSON.stringify(records)).not.toContain('"TWO"')
      expect(
        primaries(records)
          .filter(chat => chat.gaps.includes('step-binding-uncertain'))
          .map(chat => chat.start),
      ).toEqual([150])
    })

    it('treats a lost hook like a refused one: its time stays in the record, so its step cannot land on a hook that shares it', () => {
      // #given hook 1 at 100 with its step bound, hook 2 LOST at 164, hook 3 recorded at the very same time, and hook 2's step
      // (started 164) delivered afterwards
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      step(s, 'p', 'm1', 100, 'one')
      s.out.push({kind: 'loss', sessionIds: ['p'], reason: 'inbox-full', hookAt: new Map([['p', 164]]), at: 164})
      hook(s, 'p', 164)
      step(s, 'p', 'm2', 164, 'LOST HOOKS TEXT')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then the step could be either's, so it binds nothing and the recorded request says so
      expect(JSON.stringify(records)).not.toContain('LOST HOOKS TEXT')
      expect(
        primaries(records)
          .filter(chat => chat.gaps.includes('step-binding-uncertain'))
          .map(chat => chat.start),
      ).toEqual([164])
    })

    it('keeps a lost hook’s time for a session the model has not seen yet, so a later hook that is earlier shows the rollback', () => {
      // #given the FIRST hook of a session lost (its marker names its time, 212) before anything of the session was seen, then
      // the clock stepping back, a hook at 148, and a step started at 166 (which belongs to the lost hook)
      const s = script()
      s.out.push({kind: 'loss', sessionIds: ['p'], reason: 'inbox-full', hookAt: new Map([['p', 212]]), at: 212})
      s.started('p')
      hook(s, 'p', 148)
      step(s, 'p', 'm0', 166, 'LOST FIRST HOOKS TEXT')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then nobody carries it, and the hook that followed the loss says why
      expect(JSON.stringify(records)).not.toContain('LOST FIRST HOOKS TEXT')
      expect(primaries(records).filter(chat => chat.gaps.includes('step-binding-uncertain'))).toHaveLength(1)
    })

    it('does not mistake a loss of something else for a hook: a lost event’s time says nothing about later hooks', () => {
      // #given a loss with no hook time, then an ordinary hook and step
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      step(s, 'p', 'm1', 100, 'one')
      s.lost(['p'], 'inbox-full')
      hook(s, 'p', 150)
      step(s, 'p', 'm2', 150, 'two')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then
      expect(chatWith(records, 'two')?.messageId).toBe('m2')
    })

    it('starts the next execution clean after a rollback', () => {
      // #given a rollback in one execution and a new execution with an ordinary request
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      s.request('p', 'title', {at: 101})
      hook(s, 'p', 90)
      s.ended('p')
      s.started('p')
      hook(s, 'p', 500)
      step(s, 'p', 'm9', 500, 'its own first step')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then
      expect(chatWith(records, 'its own first step')?.messageId).toBe('m9')
    })
  })

  describe('a loss reported while a request is bound and still running', () => {
    it('withholds the request’s step data entirely, so a prefix is never shown as the whole (the review’s case)', () => {
      // #given a bound request with a text prefix, a loss (the suffix was dropped), then the step ending as stop
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      s.stepStarted('p', 'm1', 100)
      s.text('p', 'm1', 'prefix')
      s.lost(['p'], 'inbox-full')
      s.stepEnded('p', 'm1')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then no text, no finish reason, an incomplete outcome and the same gap as any uncertain request
      expect(JSON.stringify(records)).not.toContain('prefix')
      expect(primaries(records)).toHaveLength(1)
      for (const chat of primaries(records)) expectNoStepData(chat)
    })

    it('leaves a request that ended before the loss alone, and marks only the ones still running', () => {
      // #given request 1 ended, request 2 bound and running, a loss, request 3 hooked after it
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      step(s, 'p', 'm1', 100, 'one')
      hook(s, 'p', 200)
      s.stepStarted('p', 'm2', 200)
      s.text('p', 'm2', 'two prefix')
      s.lost(['p'], 'inbox-full')
      s.stepEnded('p', 'm2')
      hook(s, 'p', 300)
      step(s, 'p', 'm3', 300, 'three')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then
      expect(chatWith(records, 'one')?.finishReason).toBe('stop')
      expect(chatWith(records, 'three')?.finishReason).toBe('stop')
      expect(JSON.stringify(records)).not.toContain('two prefix')
      expect(primaries(records).filter(chat => chat.gaps.includes('step-binding-uncertain'))).toHaveLength(1)
    })

    it('hands back the second owner of a bound request’s tool arguments when it turns uncertain', () => {
      // #given a bound request that asked for a tool with object arguments, then a loss
      const s = script()
      const input = {path: 'a'}
      s.started('p')
      hook(s, 'p', 100)
      s.stepStarted('p', 'm1', 100)
      s.toolNamed('p', 'c1')
      s.toolCalled('p', 'c1', {messageId: 'm1', input})
      s.lost(['p'], 'inbox-full')
      s.stepEnded('p', 'm1')
      s.ended('p')

      // #when
      const {model} = replay(s.out, {flush: false})

      // #then
      expect(model.takeDiscarded()).toContain(input)
    })

    it('applies a loss that names no session to a bound request of every session', () => {
      // #given two sessions with a bound request each and an unnamed loss
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      s.stepStarted('p', 'mp', 100)
      s.text('p', 'mp', 'p prefix')
      s.started('q')
      hook(s, 'q', 110)
      s.stepStarted('q', 'mq', 110)
      s.text('q', 'mq', 'q prefix')
      s.lost(undefined, 'identifier-too-long')
      s.stepEnded('p', 'mp')
      s.stepEnded('q', 'mq')
      s.ended('p')
      s.ended('q')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then
      expect(JSON.stringify(records)).not.toMatch(/(p|q) prefix/)
      expect(chats(records).filter(chat => chat.gaps.includes('step-binding-uncertain'))).toHaveLength(2)
    })
  })

  it('records a request that fails after output, whose retry hook arrives before its step events, as closed with a named gap and nothing misattributed', () => {
    // #given the retry hook delivered ahead of the step.started and text of the attempt it follows (the source publishes the
    // failure after the retry hook), then step.failed, and the second attempt
    const s = script()
    s.started('p')
    hook(s, 'p', 100)
    retry(s, 'p')
    s.stepStarted('p', 'm1', 100)
    s.text('p', 'm1', 'FIRST OUTPUT')
    s.out.push({
      kind: 'step.failed',
      sessionId: 'p',
      messageId: 'm1',
      error: {type: 'provider.internal', message: 'x'},
      at: lastAt(s.out) + 1,
    })
    hook(s, 'p', 200)
    step(s, 'p', 'm2', 200, 'SECOND OUTPUT')
    s.ended('p')

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then the first span has no text and says its output is missing; the second has only its own
    const [first, second] = primaries(records)
    expect(first?.texts).toEqual([])
    expect(first?.gaps).toContain('output')
    expect(first?.status).toBe('error')
    expect(second?.texts).toEqual(['SECOND OUTPUT'])
    expect(JSON.stringify(records)).not.toContain('FIRST OUTPUT')
  })

  describe('the withhold state: set by exactly four triggers, cleared only by the session’s own execution.ended', () => {
    /** An ordinary request with its step, then the trigger, then a request that follows it with its own step, then the end. */
    const withTrigger = (trigger: (s: ReturnType<typeof script>) => void) => {
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      step(s, 'p', 'm0', 100, 'BEFORE THE TRIGGER')
      trigger(s)
      hook(s, 'p', 400)
      step(s, 'p', 'm2', 400, 'AFTER THE TRIGGER')
      return s
    }
    const triggers: readonly (readonly [string, (s: ReturnType<typeof script>) => void, Partial<TurnModelLimits>])[] = [
      [
        'an ambiguous step',
        s => {
          hook(s, 'p', 150)
          hook(s, 'p', 151)
          step(s, 'p', 'm1', 151, 'AMBIGUOUS')
        },
        {},
      ],
      ['a hook earlier than the previous one', s => hook(s, 'p', 90), {}],
      ['a broadcast loss marker', s => s.lost(undefined), {}],
      [
        'a marker whose evidence is incomplete',
        s => s.out.push({kind: 'loss', sessionIds: ['p'], reason: 'x', incomplete: true, at: lastAt(s.out) + 1}),
        {},
      ],
      [
        'a step with no usable start time',
        s => s.out.push({kind: 'step.started', sessionId: 'p', messageId: 'mx', at: lastAt(s.out) + 1}),
        {},
      ],
      [
        'evicting a hook that never had its step',
        s => {
          hook(s, 'p', 110)
          hook(s, 'p', 120)
          hook(s, 'p', 130)
        },
        {maxHookTimes: 2},
      ],
    ]

    it.each(triggers)('is set by %s, and the request after it carries no step data', (_name, trigger, limits) => {
      // #given
      const s = withTrigger(trigger)
      s.ended('p')

      // #when
      const {records, model} = replay(s.out, {limits, flush: false})

      // #then the session was withheld, the request before the trigger kept its step, nothing after it carries one, and the record
      // is empty after the end
      expect(model.stats().withholds).toBeGreaterThan(0)
      expect(chatWith(records, 'BEFORE THE TRIGGER')?.messageId).toBe('m0')
      expect(JSON.stringify(records)).not.toMatch(/AFTER THE TRIGGER|AMBIGUOUS/)
      for (const chat of primaries(records).filter(candidate => candidate.start !== 100)) expectNoStepData(chat)
      expect(model.stats().hookTimes).toBe(0)
    })

    it.each(triggers)(
      'is cleared by the session’s execution.ended after %s: the next execution binds normally',
      (_name, trigger, limits) => {
        // #given the trigger, the end, and a clean execution of the same session
        const s = withTrigger(trigger)
        s.ended('p')
        s.started('p')
        hook(s, 'p', 900)
        step(s, 'p', 'm9', 900, 'CLEAN EXECUTION')
        s.ended('p')

        // #when
        const {records} = replay(s.out, {limits, flush: false})

        // #then
        expect(chatWith(records, 'CLEAN EXECUTION')?.messageId).toBe('m9')
        expect(chatWith(records, 'CLEAN EXECUTION')?.gaps).not.toContain('step-binding-uncertain')
      },
    )

    it('does not withhold for a loss marker that names its session and carries the time of the primary hook it lost', () => {
      // #given
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      step(s, 'p', 'm1', 100, 'one')
      s.out.push({kind: 'loss', sessionIds: ['p'], reason: 'x', hookAt: new Map([['p', 200]]), at: 200})
      step(s, 'p', 'm2', 200, 'the lost request’s own step')
      hook(s, 'p', 300)
      step(s, 'p', 'm3', 300, 'three')
      s.ended('p')

      // #when
      const {records, model} = replay(s.out, {flush: false})

      // #then
      expect(model.stats().withholds).toBe(0)
      expect(chatWith(records, 'three')?.messageId).toBe('m3')
      expect(JSON.stringify(records)).not.toContain('the lost request’s own step')
    })

    it('keeps the known lost-hook times of a broadcast marker for the sessions they belong to', () => {
      // #given a broadcast marker carrying the lost hook time of an unseen session
      const s = script()
      s.out.push({kind: 'loss', sessionIds: undefined, reason: 'x', hookAt: new Map([['q', 212]]), at: 212})
      s.started('q')
      hook(s, 'q', 148)
      step(s, 'q', 'm0', 166, 'LOST FIRST HOOKS TEXT')
      s.ended('q')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then the hook that came after the lost one (earlier than it: a rollback) withholds the session
      expect(JSON.stringify(records)).not.toContain('LOST FIRST HOOKS TEXT')
    })

    it('leaves a subagent’s session unaffected by its parent’s withhold', () => {
      // #given a parent withheld by a clock rollback and a dispatched child with an ordinary turn
      const s = script()
      s.prompt('p', 'mp')
      s.enqueued('p', 'mp', 'user')
      s.started('p')
      s.delivered('p', 'mp')
      hook(s, 'p', 100)
      s.stepStarted('p', 'sp1', 100)
      s.toolBefore('p', 'c1', 'subagent', 'sp1')
      s.toolAfter('p', 'c1', 'subagent', 'kid')
      s.toolEnded('p', 'c1', {childSessionId: 'kid'})
      s.created('kid', 'p')
      s.prompt('kid', 'mk')
      s.enqueued('kid', 'mk', 'user')
      s.started('kid')
      s.delivered('kid', 'mk')
      hook(s, 'p', 90)
      hook(s, 'kid', 150)
      step(s, 'kid', 'sk', 150, 'child text')
      s.ended('kid')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then the child binds; the parent's requests carry nothing
      expect(chatWith(records, 'child text')?.messageId).toBe('sk')
      for (const chat of primaries(records, 'p')) expectNoStepData(chat)
    })
  })

  /** A parent that dispatches a child whose observations are buffered until the dispatch link arrives. */
  const bufferedChild = (): ReturnType<typeof script> => {
    const s = script()
    s.prompt('p', 'mp')
    s.enqueued('p', 'mp', 'user')
    s.started('p')
    s.delivered('p', 'mp')
    hook(s, 'p', 100)
    s.stepStarted('p', 'sp1', 100)
    s.toolNamed('p', 'c1', 'subagent')
    s.toolCalled('p', 'c1', {messageId: 'sp1'})
    s.toolBefore('p', 'c1', 'subagent', 'sp1')
    s.created('kid', 'p')
    return s
  }
  const link = (s: ReturnType<typeof script>): void => {
    s.toolAfter('p', 'c1', 'subagent', 'kid')
    s.toolEnded('p', 'c1', {childSessionId: 'kid'})
    s.text('p', 'sp1', 'parent one')
    s.stepEnded('p', 'sp1')
    s.ended('p')
  }

  it('joins a buffered child unchanged on replay: its observations carry their own times', () => {
    // #given a child whose whole turn arrives before the dispatch link
    const s = bufferedChild()
    s.prompt('kid', 'mk')
    s.enqueued('kid', 'mk', 'user')
    s.started('kid')
    s.delivered('kid', 'mk')
    hook(s, 'kid', 150)
    hook(s, 'kid', 250)
    step(s, 'kid', 'k1', 150, 'first kid text')
    step(s, 'kid', 'k2', 250, 'second kid text')
    s.ended('kid')
    link(s)

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then
    expect(chatWith(records, 'first kid text')?.start).toBe(150)
    expect(chatWith(records, 'second kid text')?.start).toBe(250)
  })

  it('puts a loss for a buffered child in its buffer in order: an execution.ended before it cannot clear it', () => {
    // #given a child that completes a turn and ends, whose NEXT request hook is lost (a named loss), then a later request
    const s = bufferedChild()
    s.prompt('kid', 'mk')
    s.enqueued('kid', 'mk', 'user')
    s.started('kid')
    s.delivered('kid', 'mk')
    hook(s, 'kid', 150)
    step(s, 'kid', 'k1', 150, 'first kid text')
    s.ended('kid')
    s.lost(['kid'], 'inbox-full')
    step(s, 'kid', 'k2', 200, 'lost hook text')
    s.started('kid')
    hook(s, 'kid', 300)
    step(s, 'kid', 'k3', 300, 'third kid text')
    s.ended('kid')
    link(s)

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then the lost hook's step is nobody's, and the later request has its own
    expect(JSON.stringify(records)).not.toContain('lost hook text')
    expect(chatWith(records, 'first kid text')?.messageId).toBe('k1')
    expect(chatWith(records, 'third kid text')?.messageId).toBe('k3')
  })

  it('withholds a buffered child for good when a broadcast marker reaches it: a request after the marker carries no step data', () => {
    // #given a buffered child with a finished request, a broadcast marker, and a later request with its own step
    const s = bufferedChild()
    s.prompt('kid', 'mk')
    s.enqueued('kid', 'mk', 'user')
    s.started('kid')
    s.delivered('kid', 'mk')
    hook(s, 'kid', 150)
    step(s, 'kid', 'k1', 150, 'before the marker')
    s.lost(undefined, 'identifier-too-long')
    hook(s, 'kid', 300)
    step(s, 'kid', 'k2', 300, 'AFTER THE MARKER')
    s.ended('kid')
    link(s)

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then
    expect(chatWith(records, 'before the marker')?.messageId).toBe('k1')
    expect(JSON.stringify(records)).not.toContain('AFTER THE MARKER')
  })

  it('tells every buffered child about a loss that names no session', () => {
    // #given a buffered child with a request waiting for its step, and an unnamed loss before the link
    const s = bufferedChild()
    s.prompt('kid', 'mk')
    s.enqueued('kid', 'mk', 'user')
    s.started('kid')
    s.delivered('kid', 'mk')
    hook(s, 'kid', 150)
    s.lost(undefined, 'identifier-too-long')
    step(s, 'kid', 'k1', 150, 'kid text')
    s.ended('kid')
    link(s)

    // #when
    const {records} = replay(s.out, {flush: false})

    // #then the child's waiting request is uncertain
    expect(JSON.stringify(records)).not.toContain('kid text')
    expect(primaries(records, 'kid').some(chat => chat.gaps.includes('step-binding-uncertain'))).toBe(true)
  })

  describe('a closed request leaves only its time and state in the hook record', () => {
    it('references a request while it is open and lets go of it when its step ends', () => {
      // #given a request hook, then its step
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      const waiting = replay(s.out, {flush: false}).model.stats()
      s.stepStarted('p', 'm1', 100)
      s.text('p', 'm1', 'a'.repeat(40))
      const running = replay(s.out, {flush: false}).model.stats()
      s.stepEnded('p', 'm1')

      // #when the step ends, with the execution still running
      const {model} = replay(s.out, {flush: false})

      // #then the entry keeps its time, and no request, text or snapshot is reachable through it
      expect([waiting.historyRequestsHeld, running.historyRequestsHeld]).toEqual([1, 1])
      expect(model.stats()).toMatchObject({hookTimes: 1, historyRequestsHeld: 0, heldOutputChars: 0})
    })

    it('lets go of a request that a retry hook closed before its step', () => {
      // #given a request waiting for its step, and the retry hook that follows its failure
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      retry(s, 'p')

      // #when
      const {model} = replay(s.out, {flush: false})

      // #then
      expect(model.stats()).toMatchObject({hookTimes: 1, historyRequestsHeld: 0})
    })

    it('holds no payload outside the output budget after a full record of requests has closed', () => {
      // #given more requests in one execution than the record keeps, each with output, every one closed
      const count = DEFAULT_LIMITS.maxHookTimes + 6
      const s = script()
      s.started('p')
      for (let index = 0; index < count; index += 1) {
        const at = 100 + index * 10
        hook(s, 'p', at)
        step(s, 'p', `m${String(index)}`, at, 'x'.repeat(50))
      }

      // #when
      const {model, records} = replay(s.out, {flush: false})

      // #then every span exported, the record holds exactly its bound of times and none of the requests, and nothing is withheld
      expect(primaries(records)).toHaveLength(count)
      expect(model.stats()).toMatchObject({
        hookTimes: DEFAULT_LIMITS.maxHookTimes,
        historyRequestsHeld: 0,
        heldOutputChars: 0,
        openSteps: 0,
        withholds: 0,
      })
    })

    it('binds nothing for a step that arrives after its request closed, and binds the next request normally', () => {
      // #given a request closed by a retry hook, its late step, then a new request with its step
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      retry(s, 'p')
      step(s, 'p', 'late', 100, 'LATE STEP')
      hook(s, 'p', 200)
      step(s, 'p', 'm2', 200, 'NEXT')
      s.ended('p')

      // #when
      const {records} = replay(s.out, {flush: false})

      // #then
      expect(JSON.stringify(records)).not.toContain('LATE STEP')
      expect(chatWith(records, 'NEXT')?.messageId).toBe('m2')
      expect(chats(records).some(chat => chat.gaps.includes('step-binding-uncertain'))).toBe(false)
    })

    it.each([
      ['the trace closes', (_s: ReturnType<typeof script>) => undefined],
      ['a loss made it uncertain and the execution ends', (s: ReturnType<typeof script>) => s.lost(['a'])],
    ])(
      'holds no bound request in a session that outlives a trace that closed while its step ran: %s',
      (_name, extra) => {
        // #given a session with a prompt still queued behind the running one, a request bound to a step that never ends
        const s = script()
        s.prompt('a', 'm1')
        s.prompt('a', 'm2')
        s.enqueued('a', 'm1', 'user')
        s.enqueued('a', 'm2', 'user')
        s.started('a')
        s.delivered('a', 'm1')
        s.request('a')
        s.stepStarted('a', 's-1')
        s.text('a', 's-1', 'x'.repeat(30))
        extra(s)
        s.ended('a')

        // #when
        const {model, records} = replay(s.out, {flush: false})

        // #then the request's span is out, and nothing of it is left in the session that remains
        expect(chats(records)).toHaveLength(1)
        expect(model.stats()).toMatchObject({sessions: 1, openSteps: 0, historyRequestsHeld: 0, heldOutputChars: 0})
      },
    )

    it('still counts a closed hook that never had its step as unconsumed: an equal-time step withholds', () => {
      // #given a hook closed by a retry with no step, and a step that starts in the millisecond of the hook after it
      const s = script()
      s.started('p')
      hook(s, 'p', 150)
      retry(s, 'p')
      hook(s, 'p', 151)
      step(s, 'p', 'm1', 151, 'AMBIGUOUS')
      s.ended('p')

      // #when
      const {records, model} = replay(s.out, {flush: false})

      // #then
      expect(model.stats().withholds).toBe(1)
      expect(JSON.stringify(records)).not.toContain('AMBIGUOUS')
    })

    it('still withholds when a closed hook that never had its step is evicted', () => {
      // #given a hook closed by a retry with no step, and two more hooks past a record of two
      const s = script()
      s.started('p')
      hook(s, 'p', 110)
      retry(s, 'p')
      hook(s, 'p', 120)
      hook(s, 'p', 130)

      // #when
      const {model} = replay(s.out, {limits: {maxHookTimes: 2}, flush: false})

      // #then
      expect(model.stats().withholds).toBe(1)
    })
  })

  describe('a step with an earlier hook that has no step: whatever the clock says, its owner cannot be told apart', () => {
    it('does not give a delayed step to the request hooked after a clock step-back (the review’s case)', () => {
      // #given hook 1 at 100 whose attempt started at 115, a clock that stepped back so hook 2 reads 110, and hook 1's step after it
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      hook(s, 'p', 110)
      step(s, 'p', 'old-message', 115, 'OLD RESPONSE')
      step(s, 'p', 'new-message', 116, 'NEW RESPONSE')
      s.ended('p')

      // #when
      const {records, model} = replay(s.out, {flush: false})

      // #then neither request carries a step's text, message id or usage, both name the gap, and the session was withheld
      expect(JSON.stringify(records)).not.toMatch(/OLD RESPONSE|NEW RESPONSE/)
      expect(primaries(records)).toHaveLength(2)
      for (const chat of primaries(records)) expectNoStepData(chat)
      expect(model.stats().withholds).toBe(1)
    })

    it('does the same when the earlier hook is a refused request’s', () => {
      // #given a cap of one: hook 1 open, hook 2 refused, hook 1's step ends, hook 3 admitted at a time before the refused one's start
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      hook(s, 'p', 105)
      step(s, 'p', 'm1', 100, 'one')
      hook(s, 'p', 110)
      step(s, 'p', 'refused-message', 115, 'REFUSED RESPONSE')
      s.ended('p')

      // #when
      const {records, model} = replay(s.out, {limits: CAP, flush: false})

      // #then
      expect(chatWith(records, 'one')?.messageId).toBe('m1')
      expect(JSON.stringify(records)).not.toContain('REFUSED RESPONSE')
      expectNoStepData(primaries(records).find(chat => chat.start === 110) as ChatRecord)
      expect(model.stats().withholds).toBe(1)
    })

    it('does the same when the earlier hook is a lost one’s, which a loss marker named', () => {
      // #given hook 2 lost with its time carried by the marker, hook 3 admitted, and the lost request's step after it
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      step(s, 'p', 'm1', 100, 'one')
      s.out.push({kind: 'loss', sessionIds: ['p'], reason: 'x', hookAt: new Map([['p', 105]]), at: 105})
      hook(s, 'p', 110)
      step(s, 'p', 'lost-message', 115, 'LOST RESPONSE')
      s.ended('p')

      // #when
      const {records, model} = replay(s.out, {flush: false})

      // #then
      expect(chatWith(records, 'one')?.messageId).toBe('m1')
      expect(JSON.stringify(records)).not.toContain('LOST RESPONSE')
      expect(model.stats().withholds).toBe(1)
    })

    it('withholds the next step of an abandoned request, even when it starts well after its own hook', () => {
      // #given a hook that never gets a step, and the next request whose step starts strictly after its own hook
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      hook(s, 'p', 200)
      step(s, 'p', 'm1', 250, 'AFTER THE ABANDONED ONE')
      s.ended('p')

      // #when
      const {records, model} = replay(s.out, {flush: false})

      // #then
      expect(JSON.stringify(records)).not.toContain('AFTER THE ABANDONED ONE')
      for (const chat of primaries(records)) expectNoStepData(chat)
      expect(model.stats().withholds).toBe(1)
    })

    it('does not carry an abandoned request into the next execution of the session', () => {
      // #given an abandoned hook, the execution's end (a title keeps the session), and a new execution with an ordinary step
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      s.request('p', 'title', {at: 101})
      s.ended('p')
      s.started('p')
      hook(s, 'p', 300)
      step(s, 'p', 'm1', 350, 'NEXT EXECUTION')
      s.ended('p')

      // #when
      const {records, model} = replay(s.out, {flush: false})

      // #then
      expect(chatWith(records, 'NEXT EXECUTION')?.messageId).toBe('m1')
      expect(model.stats().withholds).toBe(0)
    })

    it('binds every step to its own hook when hooks are observed ahead of earlier steps, however late the steps start', () => {
      // #given both hooks seen before either step, each step starting well after its own hook
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      hook(s, 'p', 200)
      hook(s, 'p', 300)
      step(s, 'p', 'm1', 150, 'one')
      step(s, 'p', 'm2', 250, 'two')
      step(s, 'p', 'm3', 350, 'three')
      s.ended('p')

      // #when
      const {records, model} = replay(s.out, {flush: false})

      // #then
      expect(['one', 'two', 'three'].map(text => chatWith(records, text)?.messageId)).toEqual(['m1', 'm2', 'm3'])
      expect(model.stats().withholds).toBe(0)
    })

    it('binds the second attempt of a retried request: the failed attempt’s step is its own hook’s', () => {
      // #given hook, step.started of attempt 1, the retry hook, step.started of attempt 2 (the message id is reused), output, end
      const s = script()
      s.started('p')
      hook(s, 'p', 100)
      s.stepStarted('p', 'm1', 100)
      retry(s, 'p')
      hook(s, 'p', 1800)
      s.stepStarted('p', 'm1', 1800)
      s.text('p', 'm1', 'recovered')
      s.stepEnded('p', 'm1')
      s.ended('p')

      // #when
      const {records, model} = replay(s.out, {flush: false})

      // #then
      expect(chatWith(records, 'recovered')?.attempt).toBe(2)
      expect(model.stats().withholds).toBe(0)
    })
  })
})

describe('the join against every recorded scenario, with the scripted provider’s own account of whose each step was', () => {
  const names = Object.keys(recordedFixtures).filter(name => recordedFixtures[name]?.truth !== undefined)

  it('has the truth for every recorded scenario that has steps', () => {
    // #then the recorder wrote it for all of them
    expect(names.length).toBeGreaterThanOrEqual(22)
  })

  it.each(names)('binds every step of %s to the request the provider answered with it', name => {
    // #given the recording and what the scripted provider says each step answered
    const fixture = recordedFixtures[name]
    const truth = fixture?.truth ?? []
    const {records, model} = replay(fixture?.observations ?? [], {flush: false})

    // #when the primary chats of each session are ranked by when their request hook arrived
    const bySession = new Map<string, ChatRecord[]>()
    for (const chat of chats(records).filter(candidate => candidate.requestKind === 'primary')) {
      bySession.set(
        chat.sessionId,
        [...(bySession.get(chat.sessionId) ?? []), chat].sort((a, b) => a.start - b.start),
      )
    }

    // #then a chat that has a step has the step that the provider's own account gives its request; one that has none is a
    // failed attempt a retry hook closed, and the step it was given is the later attempt's (same message id)
    let bound = 0
    for (const {session, message, request} of truth) {
      const chat = bySession.get(session)?.[request]
      expect({session, request, chat: chat !== undefined}).toEqual({session, request, chat: true})
      const own = chat?.messageId === message
      const closedByRetry = chat?.messageId === undefined && chat?.status === 'error'
      expect({session, request, message, own, closedByRetry}).toEqual({
        session,
        request,
        message,
        own,
        closedByRetry: !own,
      })
      bound += own ? 1 : 0
    }
    expect(bound).toBeGreaterThan(0)
    expect(chats(records).filter(chat => chat.gaps.includes('step-binding-uncertain'))).toHaveLength(0)
    expect(model.stats().withholds).toBe(0)
  })
})
