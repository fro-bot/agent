import type {SessionClientV2} from './backend-v2.js'
import type {Logger} from './types.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {
  getSessionMessagesV2,
  getSessionTodosV2,
  getSessionV2,
  listSessionsForDirectoryV2,
  SESSION_LIST_MAX_PAGES,
} from './storage-v2.js'

const logger: Logger = {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}

const session = (id: string, updated = 1000) => ({
  id,
  projectID: 'proj',
  time: {created: 1, updated},
  title: id,
  location: {directory: '/work/repo'},
})

function clientWith(overrides: Partial<SessionClientV2>): SessionClientV2 {
  return {
    list: vi.fn(async () => ({data: []})),
    get: vi.fn(async () => null),
    messages: vi.fn(async () => []),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listSessionsForDirectoryV2', () => {
  it('asks for root, unarchived sessions in the directory, newest first', async () => {
    // #given
    const list = vi.fn(async () => ({data: [session('ses_1')]}))

    // #when
    const result = await listSessionsForDirectoryV2(clientWith({list}), '/work/repo', logger)

    // #then
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({directory: '/work/repo', parentID: null, archived: false, order: 'desc'}),
    )
    expect(result.success && result.data.map(s => s.id)).toEqual(['ses_1'])
  })

  it('follows next cursors until a page has none', async () => {
    // #given two pages
    const list = vi
      .fn()
      .mockResolvedValueOnce({data: [session('ses_1')], cursor: {next: 'c2'}})
      .mockResolvedValueOnce({data: [session('ses_2')], cursor: {}})

    // #when
    const result = await listSessionsForDirectoryV2(clientWith({list}), '/work/repo', logger)

    // #then
    expect(list).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({cursor: 'c2'}))
    expect(result.success && result.data.map(s => s.id)).toEqual(['ses_1', 'ses_2'])
  })

  it('stops on an empty page even when the server still offers a cursor', async () => {
    // #given the last page keeps advertising a next cursor
    const list = vi
      .fn()
      .mockResolvedValueOnce({data: [session('ses_1')], cursor: {next: 'c2'}})
      .mockResolvedValueOnce({data: [], cursor: {next: 'c3'}})

    // #when
    const result = await listSessionsForDirectoryV2(clientWith({list}), '/work/repo', logger)

    // #then
    expect(list).toHaveBeenCalledTimes(2)
    expect(result.success && result.data).toHaveLength(1)
  })

  it('stops when the cursor does not advance', async () => {
    // #given a server that returns the same cursor forever
    const list = vi.fn(async () => ({data: [session('ses_1')], cursor: {next: 'same'}}))

    // #when
    await listSessionsForDirectoryV2(clientWith({list}), '/work/repo', logger)

    // #then it is bounded rather than spinning
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('is bounded by SESSION_LIST_MAX_PAGES', async () => {
    // #given a server with endless distinct pages
    let n = 0
    const list = vi.fn(async () => ({data: [session(`ses_${(n += 1)}`)], cursor: {next: `c${n}`}}))

    // #when
    const result = await listSessionsForDirectoryV2(clientWith({list}), '/work/repo', logger)

    // #then
    expect(list).toHaveBeenCalledTimes(SESSION_LIST_MAX_PAGES)
    expect(result.success && result.data).toHaveLength(SESSION_LIST_MAX_PAGES)
  })

  it('returns an error result, not a throw, when the client rejects', async () => {
    // #given
    const list = vi.fn(async () => {
      throw new Error('store offline')
    })

    // #when
    const result = await listSessionsForDirectoryV2(clientWith({list}), '/work/repo', logger)

    // #then
    expect(result.success).toBe(false)
    expect(!result.success && result.error.message).toBe('store offline')
    expect(logger.warning).toHaveBeenCalled()
  })

  it('returns an error result for a non-list payload, distinct from an empty list', async () => {
    // #given
    const list = vi.fn(async () => ({unexpected: true}))

    // #when
    const result = await listSessionsForDirectoryV2(clientWith({list}), '/work/repo', logger)

    // #then
    expect(result.success).toBe(false)
    expect(!result.success && result.error.message).toMatch(/not a session list/)
  })
})

describe('getSessionV2', () => {
  it('maps a found session', async () => {
    // #given
    const get = vi.fn(async () => session('ses_1'))

    // #when
    const result = await getSessionV2(clientWith({get}), 'ses_1', logger)

    // #then
    expect(result.success && result.data?.id).toBe('ses_1')
    expect(get).toHaveBeenCalledWith('ses_1')
  })

  it('returns ok(null) when the client reports the session missing', async () => {
    // #given
    const get = vi.fn(async () => null)

    // #when
    const result = await getSessionV2(clientWith({get}), 'ses_missing', logger)

    // #then not found is a value, not an error
    expect(result.success && result.data).toBeNull()
  })

  it('returns an error result for an unparseable payload and for a rejection', async () => {
    // #given
    const garbled = clientWith({get: vi.fn(async () => ({id: 'ses_1'}))})
    const failing = clientWith({
      get: vi.fn(async () => {
        throw new Error('boom')
      }),
    })

    // #when
    const a = await getSessionV2(garbled, 'ses_1', logger)
    const b = await getSessionV2(failing, 'ses_1', logger)

    // #then
    expect(a.success).toBe(false)
    expect(b.success).toBe(false)
  })
})

describe('getSessionMessagesV2 / getSessionTodosV2', () => {
  const messages = [
    {id: 'msg_1', time: {created: 1}, type: 'user', text: 'hi'},
    {
      id: 'msg_2',
      time: {created: 2},
      type: 'assistant',
      agent: 'build',
      content: [
        {
          type: 'tool',
          id: 'c',
          name: 'todowrite',
          state: {
            status: 'completed',
            input: {todos: [{content: 'a', status: 'completed'}]},
            content: [{type: 'text', text: 'ok'}],
          },
        },
      ],
    },
  ]

  it('maps the message list', async () => {
    // #given
    const client = clientWith({messages: vi.fn(async () => messages)})

    // #when
    const result = await getSessionMessagesV2(client, 'ses_1', logger)

    // #then
    expect(result.success && result.data.map(m => m.id)).toEqual(['msg_1', 'msg_2'])
  })

  it('derives todos from the messages', async () => {
    // #given
    const client = clientWith({messages: vi.fn(async () => messages)})

    // #when
    const result = await getSessionTodosV2(client, 'ses_1', logger)

    // #then
    expect(result.success && result.data).toEqual([{content: 'a', status: 'completed'}])
  })

  it('returns an error result for a non-list payload and for a rejection', async () => {
    // #given
    const garbled = clientWith({messages: vi.fn(async () => 'nope')})
    const failing = clientWith({
      messages: vi.fn(async () => {
        throw new Error('boom')
      }),
    })

    // #when
    const a = await getSessionMessagesV2(garbled, 'ses_1', logger)
    const b = await getSessionTodosV2(failing, 'ses_1', logger)

    // #then
    expect(a.success).toBe(false)
    expect(b.success).toBe(false)
  })
})
