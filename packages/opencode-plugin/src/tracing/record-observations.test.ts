import {describe, expect, it, vi} from 'vitest'

import {TASK_REUSE_REJECTION} from '../task-reuse-guard.js'
import {GUARD_REFUSAL_TEXT, observeEvent, observeHook, registerObservers, reportStateOf} from './record-observations.js'

const SES = 'ses_abc'

const event = (type: string, data: Record<string, unknown>, created = 1_000): unknown => ({
  id: 'evt_1',
  created,
  type,
  data: {sessionID: SES, ...data},
})

describe('reportStateOf', () => {
  it('reads the state from the report header, not from metadata that says completed on an interim report', () => {
    // #given an interim report: the header says running, the metadata says completed
    const text =
      '<subagent sessionID="ses_1" state="running" description="mid">\nnotes\n\nBackground work still running:'

    // #when / #then the header wins
    expect(reportStateOf(text, {state: 'completed'})).toBe('running')
  })

  it('falls back to metadata when the text has no header, and to nothing when neither has a state', () => {
    // #given text that is not a subagent report
    // #when / #then
    expect(reportStateOf('plain text', {state: 'completed'})).toBe('completed')
    expect(reportStateOf(undefined, undefined)).toBeUndefined()
    expect(reportStateOf('<subagent ses_1>', {})).toBeUndefined()
  })

  it('looks only at the head of a huge report', () => {
    // #given a state marker far past the header window, inside the body
    const text = `<subagent sessionID="ses_1" description="x">\n${'a'.repeat(5000)} state="running"`

    // #when / #then the body is not read, so the metadata decides
    expect(reportStateOf(text, {state: 'completed'})).toBe('completed')
  })
})

describe('observeEvent', () => {
  it('maps the events the model reads', () => {
    // #given / #when / #then
    expect(observeEvent(event('session.execution.started', {}))).toEqual({
      kind: 'execution.started',
      at: 1_000,
      sessionId: SES,
    })
    expect(observeEvent(event('session.execution.interrupted', {reason: 'user'}))).toMatchObject({
      kind: 'execution.ended',
      outcome: 'interrupted',
      reason: 'user',
    })
    expect(
      observeEvent(event('session.execution.failed', {error: {type: 'provider.internal', message: 'x', status: 503}})),
    ).toMatchObject({
      outcome: 'failed',
      error: {type: 'provider.internal', status: 503},
    })
    expect(
      observeEvent(
        event('session.step.ended', {
          assistantMessageID: 'msg_1',
          finish: 'stop',
          rawFinish: 'stop',
          tokens: {input: 70, output: 13, reasoning: 7, cache: {read: 30, write: 0}},
          cost: 0.5,
        }),
      ),
    ).toMatchObject({
      kind: 'step.ended',
      usage: {input: 70, output: 13, reasoning: 7, cacheRead: 30, cacheWrite: 0},
      cost: 0.5,
    })
    expect(observeEvent(event('session.text.ended', {assistantMessageID: 'msg_1', text: 'hello'}))).toMatchObject({
      kind: 'output',
      part: 'text',
      text: 'hello',
    })
    expect(observeEvent(event('session.renamed', {title: 'T'}))).toMatchObject({kind: 'title', title: 'T'})
    expect(observeEvent(event('session.usage.updated', {tokens: {input: 1, output: 1}}))).toMatchObject({kind: 'usage'})
  })

  it('carries the step’s own start time, the number the join reads, and nothing for a value that is not a finite number', () => {
    // #given step starts with a start time, with none, and with values that are not numbers
    const data = {sessionID: 's', assistantMessageID: 'a', agent: 'build', model: {id: 'm', providerID: 'p'}}

    // #then only a finite number is kept
    expect(observeEvent(event('session.step.started', {...data, started: 1_700_000_000_123}))).toMatchObject({
      kind: 'step.started',
      started: 1_700_000_000_123,
    })
    for (const started of [undefined, 'soon', Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
      const observed = observeEvent(event('session.step.started', {...data, started}))
      expect(observed).toMatchObject({kind: 'step.started', messageId: 'a'})
      expect((observed as {started?: unknown}).started).toBeUndefined()
    }
  })

  it('reads a subagent report from the item, with the header state, and the child id from metadata', () => {
    // #given an interim report item
    const raw = event('session.inbox.enqueued', {
      inboxID: 'msg_9',
      item: {
        type: 'synthetic',
        payload: {
          text: '<subagent sessionID="ses_c" state="running" description="d">x',
          metadata: {source: 'subagent', childID: 'ses_c', state: 'completed'},
        },
      },
    })

    // #when / #then
    expect(observeEvent(raw)).toMatchObject({
      kind: 'inbox.enqueued',
      item: 'synthetic',
      inboxId: 'msg_9',
      childSessionId: 'ses_c',
      reportState: 'running',
    })
  })

  it('reads the dispatch link from a tool event, and an error type from a failed one', () => {
    // #given
    const ok = observeEvent(
      event('session.tool.success', {
        assistantMessageID: 'm',
        id: 'call_1',
        metadata: {sessionID: 'ses_c', truncated: false},
      }),
    )
    const failed = observeEvent(
      event('session.tool.failed', {
        assistantMessageID: 'm',
        id: 'call_2',
        error: {type: 'permission.rejected', message: 'no'},
      }),
    )

    // #then
    expect(ok).toMatchObject({kind: 'tool.ended', succeeded: true, childSessionId: 'ses_c', truncated: false})
    expect(failed).toMatchObject({
      kind: 'tool.ended',
      succeeded: false,
      errorType: 'permission.rejected',
      message: 'no',
    })
  })

  it('names a call from the input-started event and opens it from the called event, with a snapshot of its arguments', () => {
    // #given the two events a tool call publishes before it runs (verified against v2.3.2 `publish-llm-event.ts`)
    const args = {path: 'README.md'}
    const named = observeEvent(
      event('session.tool.input.started', {assistantMessageID: 'm', id: 'call_1', name: 'read'}),
    )
    const called = observeEvent(
      event('session.tool.called', {assistantMessageID: 'm', id: 'call_1', input: args, executed: false}),
    )
    args.path = 'EDITED'

    // #then the name is known before the call, and the call carries the step, whether the provider ran it, and the arguments as they were
    expect(named).toEqual({
      kind: 'tool.named',
      at: 1000,
      sessionId: 'ses_abc',
      callId: 'call_1',
      tool: 'read',
    })
    expect(called).toMatchObject({
      kind: 'tool.called',
      callId: 'call_1',
      messageId: 'm',
      executed: false,
      input: {path: 'README.md'},
    })
  })

  it('marks a provider-executed call, and gives a call with no input an empty-object input', () => {
    // #given
    const called = observeEvent(
      event('session.tool.called', {assistantMessageID: 'm', id: 'call_2', input: {}, executed: true}),
    )

    // #then
    expect(called).toMatchObject({kind: 'tool.called', executed: true, input: {}})
  })

  it('carries a successful tool event’s content as a result snapshot, and a failed one none', () => {
    // #given
    const content = [{type: 'text', text: 'file body'}]
    const ok = observeEvent(
      event('session.tool.success', {
        assistantMessageID: 'm',
        id: 'call_1',
        content,
        metadata: {truncated: true},
        executed: false,
      }),
    )
    const failed = observeEvent(
      event('session.tool.failed', {
        assistantMessageID: 'm',
        id: 'call_2',
        error: {type: 'tool.execution', message: 'no'},
        executed: true,
      }),
    )
    content[0] = {type: 'text', text: 'EDITED'}

    // #then
    expect(ok).toMatchObject({
      kind: 'tool.ended',
      succeeded: true,
      executed: false,
      result: {content: [{type: 'text', text: 'file body'}], metadata: {truncated: true}},
    })
    expect(failed).toMatchObject({kind: 'tool.ended', succeeded: false, executed: true})
    expect(Reflect.get(failed ?? {}, 'result')).toBeUndefined()
  })

  it('keeps its copy of the guard’s refusal text equal to the guard’s', () => {
    // #given / #when / #then
    expect(GUARD_REFUSAL_TEXT).toBe(TASK_REUSE_REJECTION)
  })

  it('tags a failed call whose message is this plugin’s own reuse-guard refusal, and no other', () => {
    // #given the guard's fixed text, and a failure that merely resembles it
    const guard = observeEvent(
      event('session.tool.failed', {
        assistantMessageID: 'm',
        id: 'c1',
        error: {type: 'unknown', message: TASK_REUSE_REJECTION},
      }),
    )
    const other = observeEvent(
      event('session.tool.failed', {
        assistantMessageID: 'm',
        id: 'c2',
        error: {type: 'unknown', message: `${TASK_REUSE_REJECTION} `},
      }),
    )

    // #then
    expect(guard).toMatchObject({kind: 'tool.ended', succeeded: false, errorType: 'plugin.reuse-guard'})
    expect(other).toMatchObject({kind: 'tool.ended', errorType: 'unknown'})
  })

  it('yields no observation, and never throws, for a drifted or unrelated shape', () => {
    // #given payloads that lack a field, have the wrong type, or are not events
    const drifted: unknown[] = [
      undefined,
      null,
      'text',
      42,
      {},
      {type: 'session.step.ended', created: 1, data: {sessionID: SES}},
      {type: 'session.step.ended', created: 'late', data: {sessionID: SES, assistantMessageID: 'm'}},
      {type: 'session.inbox.enqueued', created: 1, data: {sessionID: SES, item: 'user'}},
      {type: 'session.tool.success', created: 1, data: {sessionID: SES}},
      event('session.text.delta', {delta: 'x'}),
      event('provider.updated', {}),
    ]

    // #when / #then
    for (const raw of drifted) expect(() => observeEvent(raw)).not.toThrow()
    expect(drifted.map(raw => observeEvent(raw))).toEqual(drifted.map(() => undefined))
  })
})

describe('observeHook', () => {
  it('maps the request hooks to request kinds with the content the span will carry', () => {
    // #given the four request hooks
    const payload = {
      sessionID: SES,
      agent: 'build',
      model: {id: 'gpt', providerID: 'openai'},
      system: [],
      messages: [],
      tools: {},
      options: {},
    }

    // #when / #then
    for (const [hook, kind] of [
      ['context', 'primary'],
      ['compaction', 'compaction'],
      ['title', 'title'],
      ['generate', 'generate'],
    ] as const) {
      expect(observeHook(`session.${hook}`, payload, 5)).toMatchObject({
        kind: 'request',
        requestKind: kind,
        agent: 'build',
        model: 'gpt',
        provider: 'openai',
        at: 5,
      })
    }
  })

  it('maps tool hooks, taking the child session id only from a subagent result', () => {
    // #given an after hook for a subagent and one for another tool with the same metadata shape
    const after = (tool: string): unknown => ({
      tool,
      sessionID: SES,
      id: 'call_1',
      agent: 'build',
      messageID: 'm',
      status: 'completed',
      result: {output: 'x', metadata: {sessionID: 'ses_child', status: 'running'}},
    })

    // #then
    expect(
      observeHook('tool.execute.before', {sessionID: SES, id: 'c', tool: 'read', messageID: 'msg_1', input: {}}, 1),
    ).toMatchObject({
      kind: 'tool.before',
      messageId: 'msg_1',
    })
    expect(observeHook('tool.execute.after', after('subagent'), 1)).toMatchObject({
      kind: 'tool.after',
      childSessionId: 'ses_child',
    })
    expect(observeHook('tool.execute.after', after('read'), 1)).toMatchObject({
      kind: 'tool.after',
      childSessionId: undefined,
    })
  })

  it('flags an interrupted tool from its error metadata', () => {
    // #given a failed after hook
    const raw = {
      tool: 'shell',
      sessionID: SES,
      id: 'c',
      agent: 'build',
      messageID: 'm',
      status: 'error',
      error: {_tag: 'Tool.Error', metadata: {interrupted: true}},
    }

    // #when / #then
    expect(observeHook('tool.execute.after', raw, 1)).toMatchObject({
      status: 'error',
      interrupted: true,
      result: undefined,
    })
  })

  it('reads a retry decision', () => {
    // #given
    const raw = {
      sessionID: SES,
      attempt: 2,
      error: {type: 'provider.internal', message: 'x', status: 503},
      decision: {retry: true, delay: 5},
    }

    // #then
    expect(observeHook('session.retry', raw, 1)).toMatchObject({
      kind: 'retry',
      attempt: 2,
      willRetry: true,
      error: {status: 503},
    })
  })

  it('yields nothing for a payload without a session id or an id it needs', () => {
    // #given / #then
    expect(observeHook('session.prompt', {messageID: 'm'}, 1)).toBeUndefined()
    expect(observeHook('session.prompt', {sessionID: SES}, 1)).toBeUndefined()
    expect(observeHook('tool.execute.before', {sessionID: SES, tool: 'read'}, 1)).toBeUndefined()
    expect(observeHook('session.unknown', {sessionID: SES}, 1)).toBeUndefined()
    expect(observeHook('session.prompt', 'nope', 1)).toBeUndefined()
  })
})

function fakeHost() {
  const sessionHooks = new Map<string, (event: unknown) => void>()
  const toolHooks = new Map<string, (event: unknown) => void>()
  const events: unknown[] = []
  let release: (() => void) | undefined
  const host = {
    session: {
      hook: vi.fn(async (name: string, callback: (event: unknown) => void) => {
        sessionHooks.set(name, callback)
      }),
    },
    tool: {
      hook: vi.fn(async (name: string, callback: (event: unknown) => void) => {
        toolHooks.set(name, callback)
      }),
    },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          for (const item of events) yield item
          await new Promise<void>(resolve => {
            release = resolve
          })
        },
      }),
    },
  }
  return {host: host as never, sessionHooks, toolHooks, events, release: () => release?.()}
}

describe('registerObservers', () => {
  it('registers every hook the model needs and passes observations on', async () => {
    // #given a host
    const {host, sessionHooks, toolHooks, events, release} = fakeHost()
    events.push(event('session.execution.started', {}))
    const seen: unknown[] = []

    // #when the observers register and the hooks and the event stream deliver
    const stop = await registerObservers(
      host,
      observation => seen.push(observation),
      () => 7,
    )
    sessionHooks.get('prompt')?.({sessionID: SES, messageID: 'm', prompt: {text: 'x'}, delivery: 'steer'})
    toolHooks.get('execute.before')?.({sessionID: SES, id: 'c', tool: 'read', input: {}})
    await new Promise(resolve => setTimeout(resolve, 5))
    stop()
    release()

    // #then all six session hooks and both tool hooks exist, and the observations arrived, with the hook clock
    expect([...sessionHooks.keys()].toSorted((a, b) => a.localeCompare(b))).toEqual([
      'compaction',
      'context',
      'generate',
      'prompt',
      'retry',
      'title',
    ])
    expect([...toolHooks.keys()].toSorted((a, b) => a.localeCompare(b))).toEqual(['execute.after', 'execute.before'])
    expect(seen).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'prompt', at: 7})]))
    expect(seen.map(item => (item as {kind: string}).kind).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'execution.started',
      'prompt',
      'tool.before',
    ])
  })

  it('never changes a hook payload and never lets a failing consumer reach the host', async () => {
    // #given a consumer that throws, and a payload
    const {host, sessionHooks, release} = fakeHost()
    await registerObservers(host, () => {
      throw new Error('consumer failed')
    })
    const payload = {sessionID: SES, messageID: 'm', prompt: {text: 'x'}, delivery: 'steer'}
    const before = structuredClone(payload)

    // #when the hook runs
    const result = sessionHooks.get('prompt')?.(payload)
    release()

    // #then it returns nothing, does not throw, and left the payload alone
    expect(result).toBeUndefined()
    expect(payload).toEqual(before)
  })
})
