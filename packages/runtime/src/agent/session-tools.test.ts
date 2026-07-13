import {beforeEach, describe, expect, it, vi} from 'vitest'

import {createSessionTools, info, list, read, search} from './session-tools.js'

const mockListSessions = vi.fn()
const mockSearchSessions = vi.fn()
const mockGetSessionInfo = vi.fn()
const mockGetSession = vi.fn()
const mockGetSessionMessages = vi.fn()
const mockGetSessionTodos = vi.fn()

vi.mock('../session/index.js', () => ({
  listSessions: (...args: unknown[]): unknown => mockListSessions(...args),
  searchSessions: (...args: unknown[]): unknown => mockSearchSessions(...args),
  getSessionInfo: (...args: unknown[]): unknown => mockGetSessionInfo(...args),
  getSession: (...args: unknown[]): unknown => mockGetSession(...args),
  getSessionMessages: (...args: unknown[]): unknown => mockGetSessionMessages(...args),
  getSessionTodos: (...args: unknown[]): unknown => mockGetSessionTodos(...args),
}))

const mockCreateOpencodeClient = vi.fn()

vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: (...args: unknown[]): unknown => mockCreateOpencodeClient(...args),
}))

const FAKE_BASE_URL = 'http://127.0.0.1:4096'

beforeEach(() => {
  vi.resetAllMocks()
  mockCreateOpencodeClient.mockReturnValue({session: {}, project: {}})
})

describe('createSessionTools — contract shape', () => {
  it('returns exactly list/read/search/info keys', () => {
    // #given
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #then
    expect(Object.keys(tools).sort()).toEqual(['info', 'list', 'read', 'search'])
  })

  it('list args match the oMo contract: limit?, from_date?, to_date?, project_path?', () => {
    // #then
    expect(Object.keys(list.args).sort()).toEqual(['from_date', 'limit', 'project_path', 'to_date'])
    expect(typeof list.execute).toBe('function')
    expect(typeof list.description).toBe('string')
  })

  it('read args match the oMo contract: session_id!, include_todos?, include_transcript?, limit?', () => {
    // #then
    expect(Object.keys(read.args).sort()).toEqual(['include_todos', 'include_transcript', 'limit', 'session_id'])
  })

  it('search args match the oMo contract: query!, session_id?, case_sensitive?, limit?', () => {
    // #then
    expect(Object.keys(search.args).sort()).toEqual(['case_sensitive', 'limit', 'query', 'session_id'])
  })

  it('info args match the oMo contract: session_id!', () => {
    // #then
    expect(Object.keys(info.args)).toEqual(['session_id'])
  })

  it('each arg schema is a plain {type, description} object', () => {
    // #then
    for (const tool of [list, read, search, info]) {
      for (const schema of Object.values(tool.args)) {
        expect(typeof schema.type).toBe('string')
        expect(typeof schema.description).toBe('string')
      }
    }
  })
})

describe('createSessionTools — fail-soft: no base URL', () => {
  it('list returns "session store unavailable" and never throws when resolver returns undefined', async () => {
    // #given
    const tools = createSessionTools(() => undefined)

    // #when
    const result = await tools.list.execute({})

    // #then
    expect(result).toBe('session store unavailable: FRO_BOT_OPENCODE_URL is not set')
  })

  it('read returns "session store unavailable" when resolver returns empty string', async () => {
    // #given
    const tools = createSessionTools(() => '')

    // #when
    const result = await tools.read.execute({session_id: 'ses_1'})

    // #then
    expect(result.startsWith('session store unavailable:')).toBe(true)
  })

  it('search returns "session store unavailable" when resolver returns undefined', async () => {
    // #given
    const tools = createSessionTools(() => undefined)

    // #when
    const result = await tools.search.execute({query: 'foo'})

    // #then
    expect(result.startsWith('session store unavailable:')).toBe(true)
  })

  it('info returns "session store unavailable" when resolver returns undefined', async () => {
    // #given
    const tools = createSessionTools(() => undefined)

    // #when
    const result = await tools.info.execute({session_id: 'ses_1'})

    // #then
    expect(result.startsWith('session store unavailable:')).toBe(true)
  })
})

describe('createSessionTools — list', () => {
  it('formats sessions one per line with id, title, updated timestamp', async () => {
    // #given
    mockListSessions.mockResolvedValue([
      {
        id: 'ses_1',
        title: 'Session One',
        createdAt: 1000,
        updatedAt: 2000,
        messageCount: 3,
        agents: [],
        isChild: false,
      },
    ])
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.list.execute({limit: 5})

    // #then
    expect(result).toContain('ses_1')
    expect(result).toContain('Session One')
    expect(mockListSessions).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({limit: 5}),
      expect.anything(),
    )
  })

  it('returns a friendly message when no sessions exist', async () => {
    // #given
    mockListSessions.mockResolvedValue([])
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.list.execute({})

    // #then
    expect(result).toBe('No sessions found.')
  })

  it('returns error string (never throws) when the client call rejects', async () => {
    // #given
    mockListSessions.mockRejectedValue(new Error('boom'))
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.list.execute({})

    // #then
    expect(result).toBe('session store unavailable: boom')
  })
})

describe('createSessionTools — read', () => {
  it('returns not-found string for an unknown session id', async () => {
    // #given
    mockGetSession.mockResolvedValue(null)
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.read.execute({session_id: 'ses_missing'})

    // #then
    expect(result).toContain('session not found')
    expect(result).toContain('ses_missing')
  })

  it('requires session_id and fails soft when missing', async () => {
    // #given
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.read.execute({})

    // #then
    expect(result.startsWith('session store unavailable:')).toBe(true)
  })

  it('includes todos when include_todos is true', async () => {
    // #given
    mockGetSession.mockResolvedValue({
      id: 'ses_1',
      version: '1',
      projectID: 'p1',
      directory: '/w',
      title: 'T',
      time: {created: 1, updated: 2},
    })
    mockGetSessionTodos.mockResolvedValue([{content: 'do the thing', status: 'pending', priority: 'high'}])
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.read.execute({session_id: 'ses_1', include_todos: true})

    // #then
    expect(result).toContain('do the thing')
    expect(mockGetSessionTodos).toHaveBeenCalled()
  })

  it('includes transcript respecting limit when include_transcript is true', async () => {
    // #given
    mockGetSession.mockResolvedValue({
      id: 'ses_1',
      version: '1',
      projectID: 'p1',
      directory: '/w',
      title: 'T',
      time: {created: 1, updated: 2},
    })
    mockGetSessionMessages.mockResolvedValue([
      {id: 'm1', role: 'user'},
      {id: 'm2', role: 'assistant'},
    ])
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.read.execute({session_id: 'ses_1', include_transcript: true, limit: 1})

    // #then
    expect(result).toContain('m1')
    expect(result).not.toContain('m2')
  })
})

describe('createSessionTools — search', () => {
  it('requires query and fails soft when missing', async () => {
    // #given
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.search.execute({})

    // #then
    expect(result.startsWith('session store unavailable:')).toBe(true)
  })

  it('formats matches with per-match context lines', async () => {
    // #given
    mockSearchSessions.mockResolvedValue([
      {sessionId: 'ses_1', matches: [{messageId: 'm1', partId: 'p1', excerpt: '...found it...', role: 'user'}]},
    ])
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.search.execute({query: 'found'})

    // #then
    expect(result).toContain('ses_1')
    expect(result).toContain('found it')
  })

  it('returns a friendly message when there are no matches', async () => {
    // #given
    mockSearchSessions.mockResolvedValue([])
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.search.execute({query: 'nothing'})

    // #then
    expect(result).toBe('No matches found.')
  })
})

describe('createSessionTools — info', () => {
  it('returns not-found string for an unknown session id', async () => {
    // #given
    mockGetSessionInfo.mockResolvedValue(null)
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.info.execute({session_id: 'ses_missing'})

    // #then
    expect(result).toContain('session not found')
  })

  it('summarizes id/title/created/updated/message-count', async () => {
    // #given
    mockGetSessionInfo.mockResolvedValue({
      session: {
        id: 'ses_1',
        version: '1',
        projectID: 'p1',
        directory: '/w',
        title: 'My Session',
        time: {created: 1000, updated: 2000},
      },
      messageCount: 7,
      agents: ['build'],
      hasTodos: true,
      todoCount: 2,
      completedTodos: 1,
    })
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.info.execute({session_id: 'ses_1'})

    // #then
    expect(result).toContain('ses_1')
    expect(result).toContain('My Session')
    expect(result).toContain('7')
    expect(result).toContain('build')
  })

  it('requires session_id and fails soft when missing', async () => {
    // #given
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.info.execute({})

    // #then
    expect(result.startsWith('session store unavailable:')).toBe(true)
  })

  it('returns error string (never throws) when the client call rejects', async () => {
    // #given
    mockGetSessionInfo.mockRejectedValue(new Error('network down'))
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.info.execute({session_id: 'ses_1'})

    // #then
    expect(result).toBe('session store unavailable: network down')
  })
})
