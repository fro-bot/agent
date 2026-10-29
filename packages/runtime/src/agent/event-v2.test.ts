import type {Logger} from '../shared/logger.js'
import type {V2DomainEvent} from './event-v2.js'

import {describe, expect, it, vi} from 'vitest'

import {
  CHILD_SESSION_ID,
  ENV_PERMISSION_ASKED_FRAME,
  EXECUTE_CALL_ID,
  EXECUTE_CALLED_FRAME,
  EXECUTE_INPUT_STARTED_FRAME,
  EXECUTE_PROGRESS_FRAMES,
  EXECUTE_SESSION_ID,
  EXECUTE_SUCCESS_FRAME,
  EXECUTION_FAILED_FRAME,
  EXECUTION_INTERRUPTED_SHUTDOWN_FRAME,
  EXECUTION_INTERRUPTED_USER_FRAME,
  EXECUTION_STARTED_FRAME,
  EXECUTION_SUCCEEDED_FRAME,
  FORGED_USER_ENQUEUED_FRAME,
  FORM_CANCELLED_FRAME,
  INTERRUPT_SESSION_ID,
  MOVED_SESSION_ID,
  NESTED_ASK_EXECUTE_CALL_ID,
  NESTED_ASK_REQUEST_IDS,
  NESTED_ASK_SESSION_ID,
  NESTED_PERMISSION_ASKED_FRAMES,
  PARENT_SESSION_ID,
  PLAIN_TURN_FRAMES,
  QUESTION_CALL_ID,
  QUESTION_FORM_CREATED_FRAME,
  QUESTION_FORM_ID,
  QUESTION_SESSION_ID,
  QUESTION_TOOL_CALLED_FRAME,
  QUESTION_TOOL_FAILED_FRAME,
  READ_TOOL_SUCCESS_FRAME,
  REASONING_FRAMES,
  RETRY_SCHEDULED_FRAME,
  SERVER_CONNECTED_FRAME,
  SESSION_MOVED_FRAME,
  STEP_FAILED_FRAME,
  STEP_STARTED_FRAME,
  SUBAGENT_NOTICE_ENQUEUED_FRAME,
  SUBAGENT_NOTICE_MESSAGE,
  TEXT_DELTA_FRAME,
  TEXT_ENDED_FRAME,
  TEXT_MESSAGE_ID,
  TEXT_SESSION_ID,
  TEXT_STARTED_FRAME,
  UNKNOWN_KIND_FORM_CREATED_FRAME,
} from './event-v2.fixtures.js'
import {isFatalV2Event, mapV2Event, mapV2EventStream, v2InnerCallKey} from './event-v2.js'

function makeLogger(): Logger {
  return {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}
}

async function* iterate(frames: readonly unknown[]): AsyncGenerator<unknown> {
  for (const frame of frames) {
    await Promise.resolve()
    yield frame
  }
}

async function* broken(): AsyncGenerator<unknown> {
  yield SERVER_CONNECTED_FRAME
  await Promise.resolve()
  throw new Error('socket closed')
}

async function collect(source: AsyncIterable<V2DomainEvent>): Promise<V2DomainEvent[]> {
  const out: V2DomainEvent[] = []
  for await (const event of source) out.push(event)
  return out
}

describe('mapV2Event: lifecycle and text', () => {
  it('maps server.connected', () => {
    expect(mapV2Event(SERVER_CONNECTED_FRAME)).toEqual({kind: 'connected'})
  })

  it('maps execution started, succeeded and interrupted (user) from real frames', () => {
    expect(mapV2Event(EXECUTION_STARTED_FRAME)).toEqual({kind: 'execution_started', sessionId: TEXT_SESSION_ID})
    expect(mapV2Event(EXECUTION_SUCCEEDED_FRAME)).toEqual({kind: 'execution_succeeded', sessionId: TEXT_SESSION_ID})
    expect(mapV2Event(EXECUTION_INTERRUPTED_USER_FRAME)).toEqual({
      kind: 'execution_interrupted',
      sessionId: INTERRUPT_SESSION_ID,
      reason: 'user',
    })
  })

  it('keeps the interrupt reason so a shutdown interrupt is distinguishable from a user stop', () => {
    expect(mapV2Event(EXECUTION_INTERRUPTED_SHUTDOWN_FRAME)).toMatchObject({
      kind: 'execution_interrupted',
      reason: 'shutdown',
    })
  })

  it('rejects an interrupt with an unknown reason as malformed', () => {
    const event = mapV2Event({type: 'session.execution.interrupted', data: {sessionID: 'ses_x', reason: 'weird'}})
    expect(event).toMatchObject({kind: 'malformed', eventType: 'session.execution.interrupted', sessionId: 'ses_x'})
  })

  it('maps a text delta and the replayable text end', () => {
    expect(mapV2Event(TEXT_DELTA_FRAME)).toEqual({
      kind: 'text_delta',
      sessionId: TEXT_SESSION_ID,
      messageId: TEXT_MESSAGE_ID,
      ordinal: 0,
      delta: 'all done',
    })
    expect(mapV2Event(TEXT_ENDED_FRAME)).toEqual({
      kind: 'text_ended',
      sessionId: TEXT_SESSION_ID,
      messageId: TEXT_MESSAGE_ID,
      ordinal: 0,
      text: 'all done',
    })
  })

  it('accepts an empty text delta as a real value', () => {
    const event = mapV2Event({
      type: 'session.text.delta',
      data: {sessionID: 'ses_x', assistantMessageID: 'msg_x', ordinal: 0, delta: ''},
    })
    expect(event).toMatchObject({kind: 'text_delta', delta: ''})
  })

  it('never maps reasoning to response text', () => {
    // #given the three reasoning events, one of which carries the private text twice
    const events = REASONING_FRAMES.map(frame => mapV2Event(frame))
    // #when mapped
    // #then each is activity only and carries no text of any kind
    for (const event of events) {
      expect(event).toEqual({kind: 'reasoning_activity', sessionId: TEXT_SESSION_ID, messageId: TEXT_MESSAGE_ID})
      expect(JSON.stringify(event)).not.toContain('PRIVATE CHAIN OF THOUGHT')
    }
  })

  it('does not let reasoning reach a response accumulated from text events', async () => {
    // #given a stream that interleaves reasoning with the real text turn
    const frames = [...REASONING_FRAMES, ...PLAIN_TURN_FRAMES]
    // #when the loop-side accumulation a consumer does is applied
    const events = await collect(mapV2EventStream(iterate(frames), {logger: makeLogger(), isOwnedSession: () => true}))
    const response = events.flatMap(event => (event.kind === 'text_delta' ? [event.delta] : [])).join('')
    // #then only the text delta is in the response
    expect(response).toBe('all done')
  })

  it('ignores frames with no consumer: text start, step start, user inbox items', () => {
    expect(mapV2Event(TEXT_STARTED_FRAME)).toBeNull()
    expect(mapV2Event(STEP_STARTED_FRAME)).toBeNull()
    expect(mapV2Event(FORGED_USER_ENQUEUED_FRAME)).toBeNull()
  })

  it('ignores unknown types, heartbeat-like frames and non-objects', () => {
    expect(mapV2Event({type: 'project.updated', data: {}})).toBeNull()
    expect(mapV2Event({type: 'comment:: heartbeat'})).toBeNull()
    expect(mapV2Event(': heartbeat')).toBeNull()
    expect(mapV2Event(null)).toBeNull()
    expect(mapV2Event(undefined)).toBeNull()
    expect(mapV2Event(7)).toBeNull()
    expect(mapV2Event({})).toBeNull()
  })

  it('flags a text delta without a session id as malformed', () => {
    expect(mapV2Event({type: 'session.text.delta', data: {delta: 'x'}})).toMatchObject({
      kind: 'malformed',
      eventType: 'session.text.delta',
      sessionId: null,
    })
  })
})

describe('mapV2Event: failures and retries', () => {
  it('maps execution failure and drops the response body', () => {
    // #given a failure whose error carries an upstream response body
    const event = mapV2Event(EXECUTION_FAILED_FRAME)
    // #then the allowlisted fields survive and the body does not
    expect(event).toEqual({
      kind: 'execution_failed',
      sessionId: TEXT_SESSION_ID,
      error: {type: 'provider.error', message: 'boom', status: 500, retryAfterMs: null},
    })
    expect(JSON.stringify(event)).not.toContain('secret upstream body')
  })

  it('maps a step failure', () => {
    expect(mapV2Event(STEP_FAILED_FRAME)).toEqual({
      kind: 'step_failed',
      sessionId: TEXT_SESSION_ID,
      error: {type: 'context_overflow', message: 'too long', status: null, retryAfterMs: null},
    })
  })

  it('maps a scheduled retry', () => {
    expect(mapV2Event(RETRY_SCHEDULED_FRAME)).toEqual({
      kind: 'retry_scheduled',
      sessionId: TEXT_SESSION_ID,
      attempt: 2,
      at: 1793206360000,
      error: {type: 'provider.rate_limit', message: 'slow down', status: 429, retryAfterMs: 5000},
    })
  })

  it('flags a failure without an error object as malformed rather than inventing one', () => {
    expect(mapV2Event({type: 'session.execution.failed', data: {sessionID: 'ses_x'}})).toMatchObject({
      kind: 'malformed',
      sessionId: 'ses_x',
    })
  })
})

describe('mapV2Event: tools and Code Mode', () => {
  it('maps the execute lifecycle onto one tool-call id (real P5 capture)', () => {
    // #given the captured execute frames: input started, called, four progress frames, success
    const frames = [
      EXECUTE_INPUT_STARTED_FRAME,
      EXECUTE_CALLED_FRAME,
      ...EXECUTE_PROGRESS_FRAMES,
      EXECUTE_SUCCESS_FRAME,
    ]
    // #when mapped
    const events = frames.map(frame => mapV2Event(frame))
    // #then every event shares the one tool-call id
    expect(events.map(event => (event !== null && 'callId' in event ? event.callId : null))).toEqual(
      Array.from({length: frames.length}, () => EXECUTE_CALL_ID),
    )
    expect(events.map(event => event?.kind)).toEqual([
      'tool_started',
      'tool_called',
      'tool_progress',
      'tool_progress',
      'tool_progress',
      'tool_progress',
      'tool_finished',
    ])
    expect(events[0]).toMatchObject({kind: 'tool_started', name: 'execute', sessionId: EXECUTE_SESSION_ID})
  })

  it('keeps two nested calls distinct by position inside one execute progress frame', () => {
    // #given the last progress frame, with two inner calls under one tool-call id
    const event = mapV2Event(EXECUTE_PROGRESS_FRAMES[3])
    // #then the inner calls are separate entries with distinct keys
    expect(event).toMatchObject({kind: 'tool_progress', callId: EXECUTE_CALL_ID})
    if (event?.kind !== 'tool_progress') throw new Error('expected tool_progress')
    expect(event.calls.map(call => [call.tool, call.status])).toEqual([
      ['opencode.worktree_list', 'completed'],
      ['opencode.models', 'completed'],
    ])
    const keys = event.calls.map(call => call.key)
    expect(new Set(keys).size).toBe(2)
    expect(keys).toEqual([v2InnerCallKey(EXECUTE_CALL_ID, 0), v2InnerCallKey(EXECUTE_CALL_ID, 1)])
  })

  it('reports each inner call status as it moves from running to completed', () => {
    const statuses = EXECUTE_PROGRESS_FRAMES.map(frame => {
      const event = mapV2Event(frame)
      return event?.kind === 'tool_progress' ? event.calls.map(call => call.status) : null
    })
    expect(statuses).toEqual([['running'], ['completed'], ['completed', 'running'], ['completed', 'completed']])
  })

  it('drops a malformed inner call but keeps the positions of the others', () => {
    const event = mapV2Event({
      type: 'session.tool.progress',
      data: {
        sessionID: 'ses_x',
        assistantMessageID: 'msg_x',
        id: 'call_x',
        metadata: {
          toolCalls: [
            {tool: 'a', status: 'completed'},
            {tool: 'b', status: 'weird'},
            {tool: 'c', status: 'error'},
          ],
        },
      },
    })
    if (event?.kind !== 'tool_progress') throw new Error('expected tool_progress')
    expect(event.calls.map(call => [call.index, call.tool, call.status])).toEqual([
      [0, 'a', 'completed'],
      [2, 'c', 'error'],
    ])
  })

  it('accepts progress metadata with no toolCalls (direct tools such as subagent)', () => {
    const event = mapV2Event({
      type: 'session.tool.progress',
      data: {
        sessionID: 'ses_x',
        assistantMessageID: 'msg_x',
        id: 'call_x',
        metadata: {sessionID: CHILD_SESSION_ID, status: 'running'},
      },
    })
    expect(event).toMatchObject({kind: 'tool_progress', calls: [], metadata: {sessionID: CHILD_SESSION_ID}})
  })

  it('maps a direct tool success with joined text content (real P6 capture)', () => {
    expect(mapV2Event(READ_TOOL_SUCCESS_FRAME)).toMatchObject({
      kind: 'tool_finished',
      outcome: 'success',
      callId: 'call_2_0',
      text: 'Read file /tmp/v2-plan/probes/work/outside/secret.txt, lines 1-1\n1: TOP-SECRET-OUTSIDE',
      error: null,
    })
  })

  it('maps an execute success with its inner calls', () => {
    const event = mapV2Event(EXECUTE_SUCCESS_FRAME)
    if (event?.kind !== 'tool_finished') throw new Error('expected tool_finished')
    expect(event.outcome).toBe('success')
    expect(event.calls.map(call => call.key)).toEqual([`${EXECUTE_CALL_ID}#0`, `${EXECUTE_CALL_ID}#1`])
  })

  it('maps a failed tool with its error (real P6 capture)', () => {
    expect(mapV2Event(QUESTION_TOOL_FAILED_FRAME)).toMatchObject({
      kind: 'tool_finished',
      outcome: 'failed',
      callId: QUESTION_CALL_ID,
      error: {type: 'tool.execution', message: 'probe-cancel'},
      text: '',
    })
  })

  it('keeps the tool input on called, for artifact detection by the consumer', () => {
    expect(mapV2Event(QUESTION_TOOL_CALLED_FRAME)).toMatchObject({
      kind: 'tool_called',
      callId: QUESTION_CALL_ID,
      input: {questions: [{question: 'Pick?'}]},
    })
  })

  it('flags a tool event with no call id as malformed', () => {
    expect(
      mapV2Event({type: 'session.tool.success', data: {sessionID: 'ses_x', assistantMessageID: 'msg_x', content: []}}),
    ).toMatchObject({kind: 'malformed', eventType: 'session.tool.success', sessionId: 'ses_x'})
  })

  it('ignores raw input streaming, which `called` supersedes', () => {
    expect(mapV2Event({type: 'session.tool.input.delta', data: {sessionID: 's', id: 'c', delta: '{'}})).toBeNull()
    expect(mapV2Event({type: 'session.tool.input.ended', data: {sessionID: 's', id: 'c', text: '{}'}})).toBeNull()
  })
})

describe('mapV2Event: permissions', () => {
  it('maps nested asks to distinct requests that share the execute call id (real P5 capture)', () => {
    // #given two concurrent asks from one execute call
    const [first, second] = NESTED_PERMISSION_ASKED_FRAMES.map(frame => mapV2Event(frame))
    // #then the request ids differ and the source tool-call id is shared
    expect(first).toMatchObject({kind: 'permission_asked', requestId: NESTED_ASK_REQUEST_IDS[0]})
    expect(second).toMatchObject({kind: 'permission_asked', requestId: NESTED_ASK_REQUEST_IDS[1]})
    if (first?.kind !== 'permission_asked' || second?.kind !== 'permission_asked') throw new Error('expected asks')
    expect(first.requestId).not.toBe(second.requestId)
    expect(first.sourceToolCallId).toBe(NESTED_ASK_EXECUTE_CALL_ID)
    expect(second.sourceToolCallId).toBe(NESTED_ASK_EXECUTE_CALL_ID)
    expect(first.sessionId).toBe(NESTED_ASK_SESSION_ID)
    expect(first.resources).not.toEqual(second.resources)
  })

  it('maps an ask with no source (an ask outside any tool call)', () => {
    const event = mapV2Event({
      type: 'permission.asked',
      data: {id: 'per_1', sessionID: 'ses_x', action: 'edit', resources: ['a']},
    })
    expect(event).toMatchObject({kind: 'permission_asked', sourceToolCallId: null, message: null})
  })

  it('maps a direct-tool ask on .env', () => {
    expect(mapV2Event(ENV_PERMISSION_ASKED_FRAME)).toMatchObject({
      kind: 'permission_asked',
      action: 'read',
      resources: ['.env'],
      sourceToolCallId: 'call_11_0',
    })
  })

  it('flags an ask with no request id as malformed so the consumer cannot silently skip a hang', () => {
    expect(
      mapV2Event({type: 'permission.asked', data: {sessionID: 'ses_x', action: 'edit', resources: []}}),
    ).toMatchObject({kind: 'malformed', eventType: 'permission.asked', sessionId: 'ses_x'})
  })

  it('maps a permission reply', () => {
    expect(
      mapV2Event({type: 'permission.replied', data: {sessionID: 'ses_x', requestID: 'per_1', reply: 'once'}}),
    ).toEqual({kind: 'permission_replied', sessionId: 'ses_x', requestId: 'per_1', reply: 'once'})
  })
})

describe('mapV2Event: forms', () => {
  it('maps a question form with its prompts (derived from source)', () => {
    expect(mapV2Event(QUESTION_FORM_CREATED_FRAME)).toEqual({
      kind: 'form_asked',
      formId: QUESTION_FORM_ID,
      sessionId: QUESTION_SESSION_ID,
      title: 'Questions',
      formKind: 'question',
      toolCallId: QUESTION_CALL_ID,
      fields: [
        {
          key: 'q0',
          type: 'string',
          title: 'Pick',
          description: 'Pick?',
          options: [
            {value: 'A', label: 'A', description: 'a'},
            {value: 'B', label: 'B', description: 'b'},
          ],
        },
      ],
    })
  })

  it('maps a form with no kind to a null kind, never to question', () => {
    const event = mapV2Event(UNKNOWN_KIND_FORM_CREATED_FRAME)
    expect(event).toMatchObject({kind: 'form_asked', formKind: null, toolCallId: null})
  })

  it('maps a cancelled form (real P6 capture)', () => {
    expect(mapV2Event(FORM_CANCELLED_FRAME)).toEqual({
      kind: 'form_resolved',
      formId: QUESTION_FORM_ID,
      sessionId: QUESTION_SESSION_ID,
      outcome: 'cancelled',
      answer: null,
    })
  })

  it('maps a replied form', () => {
    expect(mapV2Event({type: 'form.replied', data: {id: 'frm_1', sessionID: 'ses_x', answer: {q0: 'A'}}})).toEqual({
      kind: 'form_resolved',
      formId: 'frm_1',
      sessionId: 'ses_x',
      outcome: 'replied',
      answer: {q0: 'A'},
    })
  })

  it('flags a form with no fields as malformed', () => {
    expect(
      mapV2Event({type: 'form.created', data: {form: {id: 'frm_1', sessionID: 'ses_x', title: 't'}}}),
    ).toMatchObject({kind: 'malformed', eventType: 'form.created', sessionId: 'ses_x'})
  })

  it('flags a form whose id is missing as malformed so the consumer cannot skip the cancel', () => {
    expect(
      mapV2Event({type: 'form.created', data: {form: {sessionID: 'ses_x', title: 't', fields: []}}}),
    ).toMatchObject({
      kind: 'malformed',
      eventType: 'form.created',
    })
  })
})

describe('mapV2Event: subagent notices', () => {
  it('maps a synthetic inbox item with subagent metadata to a notice for the parent', () => {
    expect(mapV2Event(SUBAGENT_NOTICE_ENQUEUED_FRAME)).toEqual({
      kind: 'subagent_notice',
      sessionId: PARENT_SESSION_ID,
      notice: {childSessionId: CHILD_SESSION_ID, state: 'completed', agent: 'General', description: 'bg child'},
      inboxId: SUBAGENT_NOTICE_MESSAGE.id,
    })
  })

  it('maps an inbox delivery, captured from a real turn, to the item that entered the model turn', () => {
    expect(
      mapV2Event({
        type: 'session.inbox.delivered',
        data: {sessionID: TEXT_SESSION_ID, inboxID: 'msg_1836d7c84001UcG33UmRHZFsFl'},
      }),
    ).toEqual({kind: 'inbox_delivered', sessionId: TEXT_SESSION_ID, inboxId: 'msg_1836d7c84001UcG33UmRHZFsFl'})
  })

  it('ignores an inbox delivery that names no item', () => {
    expect(mapV2Event({type: 'session.inbox.delivered', data: {sessionID: TEXT_SESSION_ID}})).toBeNull()
  })

  it('carries no inbox id for a session.synthetic notice', () => {
    expect(
      mapV2Event({
        type: 'session.synthetic',
        data: {
          sessionID: PARENT_SESSION_ID,
          metadata: {source: 'subagent', childID: CHILD_SESSION_ID, agent: 'General', state: 'completed'},
        },
      }),
    ).toMatchObject({kind: 'subagent_notice', inboxId: null})
  })

  it('maps a session.synthetic event with subagent metadata', () => {
    const event = mapV2Event({
      type: 'session.synthetic',
      data: {
        sessionID: PARENT_SESSION_ID,
        text: 'whatever',
        metadata: {source: 'subagent', childID: CHILD_SESSION_ID, agent: 'General', state: 'cancelled'},
      },
    })
    expect(event).toMatchObject({kind: 'subagent_notice', notice: {state: 'cancelled'}})
  })

  it('ignores a synthetic event whose text claims a completion but carries no metadata', () => {
    const event = mapV2Event({
      type: 'session.synthetic',
      data: {sessionID: PARENT_SESSION_ID, text: `<subagent sessionID="${CHILD_SESSION_ID}" state="completed">`},
    })
    expect(event).toBeNull()
  })

  it('ignores a synthetic event from instruction loading', () => {
    const event = mapV2Event({
      type: 'session.synthetic',
      data: {sessionID: PARENT_SESSION_ID, text: 'x', metadata: {instruction: {paths: ['/a']}}},
    })
    expect(event).toBeNull()
  })
})

describe('mapV2Event: session moved', () => {
  it('maps session.moved with the destination directory (real P12 capture)', () => {
    expect(mapV2Event(SESSION_MOVED_FRAME)).toEqual({
      kind: 'session_moved',
      sessionId: MOVED_SESSION_ID,
      directory: '/tmp/v2-plan/probes/work/p12-destination',
    })
  })

  it('still maps a move whose destination is unreadable, since the session id alone makes it actionable', () => {
    expect(mapV2Event({type: 'session.moved', data: {sessionID: MOVED_SESSION_ID}})).toEqual({
      kind: 'session_moved',
      sessionId: MOVED_SESSION_ID,
      directory: null,
    })
  })
})

describe('mapV2EventStream', () => {
  it('yields the domain events of a captured turn in wire order and skips the rest', async () => {
    // #given the captured plain turn
    // #when it is mapped as a stream
    const events = await collect(
      mapV2EventStream(iterate(PLAIN_TURN_FRAMES), {logger: makeLogger(), isOwnedSession: () => true}),
    )
    // #then connected, execution, text and completion come out; text start, step start and the user inbox item do not
    expect(events.map(event => event.kind)).toEqual([
      'connected',
      'execution_started',
      'text_delta',
      'text_ended',
      'execution_succeeded',
    ])
  })

  it('upgrades a move of an owned session to a fatal event', async () => {
    // #given a move for a session the caller owns
    const events = await collect(
      mapV2EventStream(iterate([SESSION_MOVED_FRAME]), {
        logger: makeLogger(),
        isOwnedSession: id => id === MOVED_SESSION_ID,
      }),
    )
    // #then the stream surfaces a fatal event the run must fail on
    expect(events).toEqual([
      {
        kind: 'fatal',
        cause: 'session_moved',
        sessionId: MOVED_SESSION_ID,
        directory: '/tmp/v2-plan/probes/work/p12-destination',
      },
    ])
    expect(events.map(isFatalV2Event)).toEqual([true])
  })

  it('passes a move of an unowned session through as informational', async () => {
    const events = await collect(
      mapV2EventStream(iterate([SESSION_MOVED_FRAME]), {logger: makeLogger(), isOwnedSession: () => false}),
    )
    expect(events.map(event => event.kind)).toEqual(['session_moved'])
    expect(events.map(isFatalV2Event)).toEqual([false])
  })

  it('logs and yields a malformed frame, never dropping it silently', async () => {
    // #given an ask with no request id
    const logger = makeLogger()
    const bad = {type: 'permission.asked', data: {sessionID: 'ses_x', action: 'edit', resources: []}}
    // #when mapped as a stream
    const events = await collect(mapV2EventStream(iterate([bad]), {logger, isOwnedSession: () => true}))
    // #then the malformed event reaches the consumer and a warning names the type, not the payload
    expect(events.map(event => event.kind)).toEqual(['malformed'])
    expect(logger.warning).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(vi.mocked(logger.warning).mock.calls)).not.toContain('"resources"')
  })

  it('propagates a transport error so the consumer can record the discontinuity', async () => {
    // #given a source that fails mid-stream
    // #when consumed
    // #then the error reaches the caller after the events already mapped
    const seen: string[] = []
    await expect(
      (async () => {
        for await (const event of mapV2EventStream(broken(), {logger: makeLogger(), isOwnedSession: () => true})) {
          seen.push(event.kind)
        }
      })(),
    ).rejects.toThrow('socket closed')
    expect(seen).toEqual(['connected'])
  })

  it('handles an empty stream', async () => {
    expect(await collect(mapV2EventStream(iterate([]), {logger: makeLogger(), isOwnedSession: () => true}))).toEqual([])
  })
})

describe('isFatalV2Event', () => {
  it('is false for ordinary events', () => {
    expect(isFatalV2Event({kind: 'connected'})).toBe(false)
    expect(isFatalV2Event({kind: 'execution_started', sessionId: 's'})).toBe(false)
  })
})
