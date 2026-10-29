import type {SessionClientV2} from '@fro-bot/runtime/session-v2'

import {Schema} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import {createSessionTools, SESSION_TOOL_NAMES, TRANSCRIPT_CHAR_CAP} from './session-tools.js'

const DIRECTORY = '/work/repo'

const rawSession = (id: string, created: number, updated: number, title = `title ${id}`) => ({
  id,
  projectID: 'proj',
  time: {created, updated},
  title,
  location: {directory: DIRECTORY},
})

const user = (id: string, text: string, created: number) => ({id, time: {created}, type: 'user', text})
const assistant = (id: string, text: string, created: number, agent = 'build') => ({
  id,
  time: {created},
  type: 'assistant',
  agent,
  content: [{type: 'text', text}],
})
const todoWrite = (id: string, created: number, todos: readonly {content: string; status: string}[]) => ({
  id,
  time: {created},
  type: 'assistant',
  agent: 'build',
  content: [
    {
      type: 'tool',
      id: `c_${id}`,
      name: 'todowrite',
      state: {status: 'completed', input: {todos}, content: [{type: 'text', text: 'ok'}]},
    },
  ],
})

interface Store {
  readonly sessions: readonly ReturnType<typeof rawSession>[]
  readonly messages: Readonly<Record<string, readonly unknown[]>>
}

function makeClient(store: Store): SessionClientV2 {
  return {
    list: vi.fn(async () => ({data: store.sessions})),
    get: vi.fn(async (id: string) => store.sessions.find(s => s.id === id) ?? null),
    messages: vi.fn(async (id: string) => store.messages[id] ?? []),
  }
}

const day = (month: number, d: number, h = 12) => Date.UTC(2026, month - 1, d, h)

const store: Store = {
  sessions: [
    rawSession('ses_a', day(3, 1), day(3, 5), 'Fix the flaky cache test'),
    rawSession('ses_b', day(3, 10), day(3, 20), ''),
    rawSession('ses_c', day(4, 1), day(4, 2), 'Release notes'),
  ],
  messages: {
    ses_a: [
      user('msg_1', 'please fix the Flaky cache test', 1),
      assistant('msg_2', 'looking at the cache key now', 2),
      todoWrite('msg_3', 3, [
        {content: 'reproduce', status: 'completed'},
        {content: 'fix', status: 'in_progress'},
      ]),
    ],
    ses_b: [user('msg_4', 'cache invalidation question', 4), assistant('msg_5', 'unrelated', 5, 'explore')],
    ses_c: [user('msg_6', 'nothing relevant', 6)],
  },
}

let client: SessionClientV2
function tools(overrides: Partial<SessionClientV2> = {}) {
  client = {...makeClient(store), ...overrides}
  return createSessionTools({client, directory: DIRECTORY})
}
const failing = (): never => {
  throw new Error('store offline')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('tool contract', () => {
  it('keeps the V1 tool names and parameter names the prompt refers to', () => {
    // #given
    const t = tools()

    // #then names are stable
    expect([t.list.name, t.read.name, t.search.name, t.info.name]).toEqual([
      'session_list',
      'session_read',
      'session_search',
      'session_info',
    ])
    expect(Object.values(SESSION_TOOL_NAMES)).toEqual([
      'session_list',
      'session_read',
      'session_search',
      'session_info',
    ])
    // #and parameters are stable
    expect(Object.keys(t.list.input.fields)).toEqual(['limit', 'from_date', 'to_date', 'project_path'])
    expect(Object.keys(t.read.input.fields)).toEqual(['session_id', 'include_todos', 'include_transcript', 'limit'])
    expect(Object.keys(t.search.input.fields)).toEqual(['query', 'session_id', 'case_sensitive', 'limit'])
    expect(Object.keys(t.info.input.fields)).toEqual(['session_id'])
  })

  it('declares only session_id and query as required', () => {
    // #given
    const t = tools()

    // #when / #then optional fields may be omitted
    expect(() => Schema.decodeUnknownSync(t.list.input)({})).not.toThrow()
    expect(() => Schema.decodeUnknownSync(t.read.input)({session_id: 'ses_a'})).not.toThrow()
    expect(() => Schema.decodeUnknownSync(t.read.input)({})).toThrow()
    expect(() => Schema.decodeUnknownSync(t.search.input)({query: 'x'})).not.toThrow()
    expect(() => Schema.decodeUnknownSync(t.search.input)({})).toThrow()
    expect(() => Schema.decodeUnknownSync(t.info.input)({})).toThrow()
  })
})

describe('session_list', () => {
  it('lists sessions most recently updated first with title and update time', async () => {
    // #given
    const t = tools()

    // #when
    const output = await t.list.run({})

    // #then an untitled session shows a placeholder
    expect(output.split('\n')).toEqual([
      `ses_c  Release notes  updated ${new Date(day(4, 2)).toISOString()}`,
      `ses_b  (untitled)  updated ${new Date(day(3, 20)).toISOString()}`,
      `ses_a  Fix the flaky cache test  updated ${new Date(day(3, 5)).toISOString()}`,
    ])
  })

  it('defaults to the workspace directory and honours project_path', async () => {
    // #given
    const t = tools()

    // #when
    await t.list.run({})
    await t.list.run({project_path: '/other/repo'})

    // #then
    expect(client.list).toHaveBeenNthCalledWith(1, expect.objectContaining({directory: DIRECTORY}))
    expect(client.list).toHaveBeenNthCalledWith(2, expect.objectContaining({directory: '/other/repo'}))
  })

  it('applies limit, treating anything below 1 as no limit', async () => {
    // #given
    const t = tools()

    // #when
    const limited = await t.list.run({limit: 1})
    const unbounded = await t.list.run({limit: 0})
    const negative = await t.list.run({limit: -3})

    // #then
    expect(limited.split('\n')).toHaveLength(1)
    expect(unbounded.split('\n')).toHaveLength(3)
    expect(negative.split('\n')).toHaveLength(3)
  })

  it('filters by creation date, with to_date inclusive through the end of that day', async () => {
    // #given sessions created on 3/1, 3/10 and 4/1
    const t = tools()

    // #when
    const output = await t.list.run({from_date: '2026-03-10', to_date: '2026-03-10'})

    // #then ses_b was created at noon on 3/10 and is inside the inclusive day
    expect(output).toContain('ses_b')
    expect(output).not.toContain('ses_a')
    expect(output).not.toContain('ses_c')
  })

  it('ignores unparseable dates', async () => {
    // #given
    const t = tools()

    // #when
    const output = await t.list.run({from_date: 'not-a-date'})

    // #then
    expect(output.split('\n')).toHaveLength(3)
  })

  it('reports an empty store plainly', async () => {
    // #given
    const t = tools({list: vi.fn(async () => ({data: []}))})

    // #when / #then
    expect(await t.list.run({})).toBe('No sessions found.')
  })

  it('returns an unavailable message instead of throwing', async () => {
    // #given
    const t = tools({list: vi.fn(failing)})

    // #when / #then
    expect(await t.list.run({})).toBe('session store unavailable: store offline')
  })
})

describe('session_read', () => {
  it('requires a session id', async () => {
    // #given
    const t = tools()

    // #when / #then
    expect(await t.read.run({})).toBe('session store unavailable: session_id is required')
    expect(await t.read.run({session_id: ''})).toBe('session store unavailable: session_id is required')
  })

  it('says so when the session does not exist', async () => {
    // #given
    const t = tools()

    // #when / #then
    expect(await t.read.run({session_id: 'ses_nope'})).toBe('session not found: ses_nope')
  })

  it('returns the header alone by default', async () => {
    // #given
    const t = tools()

    // #when
    const output = await t.read.run({session_id: 'ses_a'})

    // #then
    expect(output.split('\n')).toEqual([
      'Session ses_a',
      'Title: Fix the flaky cache test',
      `Created: ${new Date(day(3, 1)).toISOString()}`,
      `Updated: ${new Date(day(3, 5)).toISOString()}`,
    ])
    expect(client.messages).not.toHaveBeenCalled()
  })

  it('includes todos when asked', async () => {
    // #given
    const t = tools()

    // #when
    const output = await t.read.run({session_id: 'ses_a', include_todos: true})
    const none = await t.read.run({session_id: 'ses_c', include_todos: true})

    // #then
    expect(output).toContain('Todos:\n  [completed] reproduce\n  [in_progress] fix')
    expect(none).toContain('Todos:\n  (none)')
  })

  it('renders the transcript oldest first, limited to the earliest N messages', async () => {
    // #given
    const t = tools()

    // #when
    const full = await t.read.run({session_id: 'ses_a', include_transcript: true})
    const limited = await t.read.run({session_id: 'ses_a', include_transcript: true, limit: 1})

    // #then a message with no readable text still renders a line
    expect(full).toContain(
      'Transcript:\n  [user] please fix the Flaky cache test\n  [assistant] looking at the cache key now\n  [assistant] todowrite: ok',
    )
    expect(limited).toContain('Transcript:\n  [user] please fix the Flaky cache test')
    expect(limited).not.toContain('[assistant]')
  })

  it('marks an empty transcript', async () => {
    // #given
    const t = tools({messages: vi.fn(async () => [])})

    // #when
    const output = await t.read.run({session_id: 'ses_a', include_transcript: true})

    // #then
    expect(output).toContain('Transcript:\n  (empty)')
  })

  it('caps a huge transcript and says how much was shown', async () => {
    // #given 200 messages of 1000 characters each
    const big = Array.from({length: 200}, (_, i) => user(`msg_${i}`, 'x'.repeat(1000), i))
    const t = tools({messages: vi.fn(async () => big)})

    // #when
    const output = await t.read.run({session_id: 'ses_a', include_transcript: true})

    // #then
    expect(output.length).toBeLessThan(TRANSCRIPT_CHAR_CAP + 1000)
    expect(output).toMatch(/\.\.\. transcript truncated \(\d+ of 200 messages shown\)/)
  })

  it('reads the context once for a combined todos and transcript request', async () => {
    // #given
    const t = tools()

    // #when
    const output = await t.read.run({session_id: 'ses_a', include_todos: true, include_transcript: true})

    // #then one snapshot feeds both sections
    expect(client.messages).toHaveBeenCalledTimes(1)
    expect(output).toContain('Todos:\n  [completed] reproduce\n  [in_progress] fix')
    expect(output).toContain('Transcript:\n  [user] please fix the Flaky cache test')
  })

  it('reads the context once for a todos-only request', async () => {
    // #given
    const t = tools()

    // #when
    await t.read.run({session_id: 'ses_a', include_todos: true})

    // #then
    expect(client.messages).toHaveBeenCalledTimes(1)
  })

  it('returns an unavailable message when messages cannot be read', async () => {
    // #given
    const t = tools({messages: vi.fn(failing)})

    // #when
    const output = await t.read.run({session_id: 'ses_a', include_transcript: true})

    // #then
    expect(output).toBe('session store unavailable: store offline')
  })
})

describe('session_search', () => {
  it('requires a query', async () => {
    // #given
    const t = tools()

    // #when / #then
    expect(await t.search.run({})).toBe('session store unavailable: query is required')
  })

  it('lists matches grouped by session with role and agent', async () => {
    // #given
    const t = tools()

    // #when
    const output = await t.search.run({query: 'cache'})

    // #then
    expect(output.split('\n')).toEqual([
      'Session ses_b:',
      '  [user] ...cache invalidation question...',
      'Session ses_a:',
      '  [user] ...please fix the Flaky cache test...',
      '  [assistant/build] ...looking at the cache key now...',
    ])
  })

  it('reports no matches', async () => {
    // #given
    const t = tools()

    // #when / #then
    expect(await t.search.run({query: 'zzz-no-such-text'})).toBe('No matches found.')
  })

  it('always searches the workspace directory', async () => {
    // #given
    const t = tools()

    // #when
    await t.search.run({query: 'cache'})

    // #then
    expect(client.list).toHaveBeenCalledWith(expect.objectContaining({directory: DIRECTORY}))
  })

  it('scopes to one session, and says so when it does not exist', async () => {
    // #given
    const t = tools()

    // #when
    const scoped = await t.search.run({query: 'cache', session_id: 'ses_b'})
    const missing = await t.search.run({query: 'cache', session_id: 'ses_nope'})

    // #then
    expect(scoped).toBe('Session ses_b:\n  [user] ...cache invalidation question...')
    expect(missing).toBe('session not found: ses_nope')
  })

  it('honours case_sensitive and limit', async () => {
    // #given
    const t = tools()

    // #when
    const sensitive = await t.search.run({query: 'flaky', case_sensitive: true})
    const limited = await t.search.run({query: 'cache', limit: 1})

    // #then
    expect(sensitive).toBe('No matches found.')
    expect(limited.split('\n')).toHaveLength(2)
  })

  it('returns an unavailable message instead of throwing', async () => {
    // #given
    const t = tools({list: vi.fn(failing)})

    // #when / #then
    expect(await t.search.run({query: 'cache'})).toBe('session store unavailable: store offline')
  })

  it('says the store is unavailable, not that nothing matched, when every session read fails', async () => {
    // #given listing works but no session's messages can be read
    const t = tools({messages: vi.fn(failing)})

    // #when
    const output = await t.search.run({query: 'cache'})

    // #then
    expect(output).toBe('session store unavailable: could not read any of 3 sessions: store offline')
    expect(output).not.toContain('No matches')
  })
})

describe('session_info', () => {
  it('summarises the session', async () => {
    // #given
    const t = tools()

    // #when
    const output = await t.info.run({session_id: 'ses_a'})

    // #then
    expect(output.split('\n')).toEqual([
      'Session ses_a',
      'Title: Fix the flaky cache test',
      `Created: ${new Date(day(3, 1)).toISOString()}`,
      `Updated: ${new Date(day(3, 5)).toISOString()}`,
      'Messages: 3',
      'Agents: build',
      'Todos: 1/2 completed',
    ])
  })

  it('shows placeholders when there are no agents or todos', async () => {
    // #given
    const t = tools({messages: vi.fn(async () => [])})

    // #when
    const output = await t.info.run({session_id: 'ses_a'})

    // #then
    expect(output).toContain('Agents: (none)')
    expect(output).toContain('Todos: (none)')
  })

  it('handles a missing id, a missing session and a failing store', async () => {
    // #given
    const healthy = tools()
    const broken = tools({get: vi.fn(failing)})

    // #when / #then
    expect(await healthy.info.run({})).toBe('session store unavailable: session_id is required')
    expect(await healthy.info.run({session_id: 'ses_nope'})).toBe('session not found: ses_nope')
    expect(await broken.info.run({session_id: 'ses_a'})).toBe('session store unavailable: store offline')
  })
})

describe('error text', () => {
  it('caps a long single-line reason and drops stack lines', async () => {
    // #given an error whose message is a stack trace
    const t = tools({
      list: vi.fn(async () => {
        throw new Error(`${'e'.repeat(500)}\n    at /Users/someone/secret/path.ts:1:1`)
      }),
    })

    // #when
    const output = await t.list.run({})

    // #then
    expect(output).not.toContain('/Users/')
    expect(output.length).toBeLessThan(260)
  })

  it('falls back to the error tag when the message is empty, as Effect tagged errors can be', async () => {
    // #given
    const tagged = Object.assign(new Error('placeholder'), {message: '', _tag: 'Session.NotFoundError'})
    const t = tools({list: vi.fn(async () => Promise.reject(tagged))})

    // #when / #then
    expect(await t.list.run({})).toBe('session store unavailable: Session.NotFoundError')
  })
})
