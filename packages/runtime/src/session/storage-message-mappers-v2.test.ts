import {describe, expect, it} from 'vitest'

import {latestTodosV2, mapMessagesV2} from './storage-message-mappers-v2.js'

// Message payloads as `ctx.session.context` returns them, plus the variants the schema allows.
const user = {id: 'msg_1', time: {created: 1000}, text: 'hello there', type: 'user'}
const assistantText = {
  id: 'msg_2',
  time: {created: 2000},
  type: 'assistant',
  agent: 'build',
  model: {id: 'm', providerID: 'p'},
  content: [{type: 'text', text: 'first reply'}],
}
const idle = {id: 'msg_3', time: {created: 3000}, type: 'idle', outcome: 'succeeded'}

describe('mapMessagesV2', () => {
  it('maps user and assistant messages and drops non-conversation records', () => {
    // #given a context window with an idle marker in the middle
    // #when
    const messages = mapMessagesV2([user, assistantText, idle])

    // #then
    expect(messages).toEqual([
      {id: 'msg_1', role: 'user', createdAt: 1000, parts: [{id: 'msg_1:0', kind: 'text', text: 'hello there'}]},
      {
        id: 'msg_2',
        role: 'assistant',
        agent: 'build',
        createdAt: 2000,
        parts: [{id: 'msg_2:0', kind: 'text', text: 'first reply'}],
      },
    ])
  })

  it('unwraps a {data} envelope and sorts oldest first', () => {
    // #given messages arriving newest first inside an envelope
    // #when
    const messages = mapMessagesV2({data: [assistantText, user]})

    // #then
    expect(messages?.map(m => m.id)).toEqual(['msg_1', 'msg_2'])
  })

  it('maps reasoning content as a reasoning part', () => {
    // #given
    const message = {...assistantText, content: [{type: 'reasoning', text: 'thinking it through'}]}

    // #when
    const [mapped] = mapMessagesV2([message]) ?? []

    // #then
    expect(mapped?.parts).toEqual([{id: 'msg_2:0', kind: 'reasoning', text: 'thinking it through'}])
  })

  it('renders a completed tool call as "<name>: <output>" and ignores unfinished ones', () => {
    // #given one completed tool call and one still running
    const message = {
      ...assistantText,
      content: [
        {
          type: 'tool',
          id: 'call_1',
          name: 'grep',
          state: {
            status: 'completed',
            input: {},
            content: [
              {type: 'text', text: 'src/a.ts:3'},
              {type: 'text', text: 'src/b.ts:9'},
            ],
          },
        },
        {type: 'tool', id: 'call_2', name: 'read', state: {status: 'running', input: {}, metadata: {}}},
      ],
    }

    // #when
    const [mapped] = mapMessagesV2([message]) ?? []

    // #then only the completed call is searchable, and file content is not mistaken for text
    expect(mapped?.parts).toEqual([{id: 'msg_2:0', kind: 'tool', text: 'grep: src/a.ts:3\nsrc/b.ts:9'}])
  })

  it('skips a completed tool call whose content has no text', () => {
    // #given a tool that only returned a file attachment
    const message = {
      ...assistantText,
      content: [
        {
          type: 'tool',
          id: 'call_1',
          name: 'read',
          state: {status: 'completed', input: {}, content: [{type: 'file', uri: 'file:///x.png', mime: 'image/png'}]},
        },
      ],
    }

    // #when
    const [mapped] = mapMessagesV2([message]) ?? []

    // #then
    expect(mapped?.parts).toEqual([])
  })

  it('treats synthetic messages as user messages', () => {
    // #given a subagent completion notice
    const synthetic = {
      id: 'msg_4',
      time: {created: 4000},
      type: 'synthetic',
      text: '<subagent state="completed">x</subagent>',
    }

    // #when
    const [mapped] = mapMessagesV2([synthetic]) ?? []

    // #then
    expect(mapped?.role).toBe('user')
    expect(mapped?.parts[0]?.text).toContain('subagent')
  })

  it('keeps a completed compaction summary as an assistant message, so older context stays searchable', () => {
    // #given
    const compaction = {
      id: 'msg_5',
      time: {created: 500},
      type: 'compaction',
      status: 'completed',
      reason: 'auto',
      summary: 'We fixed the cache key.',
    }

    // #when
    const messages = mapMessagesV2([user, compaction]) ?? []

    // #then the summary sorts first and is attributed to the assistant
    expect(messages.map(m => m.id)).toEqual(['msg_5', 'msg_1'])
    expect(messages[0]).toMatchObject({role: 'assistant', parts: [{kind: 'text', text: 'We fixed the cache key.'}]})
  })

  it('drops a compaction that is not completed', () => {
    // #given
    const running = {
      id: 'msg_5',
      time: {created: 500},
      type: 'compaction',
      status: 'running',
      reason: 'auto',
      summary: 'partial',
    }

    // #when
    // #then
    expect(mapMessagesV2([running])).toEqual([])
  })

  it('returns null when the payload is not list-shaped, and skips junk entries', () => {
    // #given
    // #when
    // #then
    expect(mapMessagesV2('nope')).toBeNull()
    expect(mapMessagesV2([user, null, 42, {type: 'user'}, {type: 'user', id: 'msg_x'}])?.map(m => m.id)).toEqual([
      'msg_1',
    ])
  })
})

describe('latestTodosV2', () => {
  const todoCall = (id: string, status: string, todos: unknown) => ({
    id,
    time: {created: 2000},
    type: 'assistant',
    agent: 'build',
    content: [
      {
        type: 'tool',
        id: `call_${id}`,
        name: 'todowrite',
        state: {status, input: {todos}, content: [{type: 'text', text: 'ok'}]},
      },
    ],
  })

  it('returns the todo list from the most recent completed todowrite call', () => {
    // #given two todowrite calls; the later one replaces the earlier list
    const first = todoCall('msg_a', 'completed', [{content: 'write tests', status: 'pending'}])
    const second = {
      ...todoCall('msg_b', 'completed', [
        {content: 'write tests', status: 'completed'},
        {content: 'ship it', status: 'in_progress'},
      ]),
      time: {created: 3000},
    }

    // #when
    const todos = latestTodosV2(mapMessagesV2([first, second]) ?? [])

    // #then
    expect(todos).toEqual([
      {content: 'write tests', status: 'completed'},
      {content: 'ship it', status: 'in_progress'},
    ])
  })

  it('ignores a todowrite call that did not complete', () => {
    // #given
    const running = todoCall('msg_a', 'running', [{content: 'x', status: 'pending'}])

    // #when
    // #then
    expect(latestTodosV2(mapMessagesV2([running]) ?? [])).toEqual([])
  })

  it('clamps an unknown status to pending and drops entries without content', () => {
    // #given
    const call = todoCall('msg_a', 'completed', [{content: 'odd', status: 'weird'}, {status: 'pending'}, 'junk'])

    // #when
    const todos = latestTodosV2(mapMessagesV2([call]) ?? [])

    // #then
    expect(todos).toEqual([{content: 'odd', status: 'pending'}])
  })

  it('returns an empty list when no message set todos', () => {
    // #given
    // #when
    // #then
    expect(latestTodosV2(mapMessagesV2([user, assistantText]) ?? [])).toEqual([])
  })
})
