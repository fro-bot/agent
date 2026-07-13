import {beforeEach, describe, expect, it, vi} from 'vitest'
import {z} from 'zod'

import {createSessionTools, info, list, read, search} from './session-tools.js'

const mockListSessions = vi.fn()
const mockSearchSessions = vi.fn()
const mockGetSessionInfo = vi.fn()
const mockGetSession = vi.fn()
const mockGetSessionMessages = vi.fn()
const mockGetSessionTodos = vi.fn()
const mockExtractTextFromPart = vi.fn()

vi.mock('../session/index.js', () => ({
  listSessions: (...args: unknown[]): unknown => mockListSessions(...args),
  searchSessions: (...args: unknown[]): unknown => mockSearchSessions(...args),
  getSessionInfo: (...args: unknown[]): unknown => mockGetSessionInfo(...args),
  getSession: (...args: unknown[]): unknown => mockGetSession(...args),
  getSessionMessages: (...args: unknown[]): unknown => mockGetSessionMessages(...args),
  getSessionTodos: (...args: unknown[]): unknown => mockGetSessionTodos(...args),
  extractTextFromPart: (...args: unknown[]): unknown => mockExtractTextFromPart(...args),
}))

const SENTINEL_CLIENT = {session: {sentinel: true}, project: {sentinel: true}}
const mockCreateOpencodeClient = vi.fn()

vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: (...args: unknown[]): unknown => mockCreateOpencodeClient(...args),
}))

const FAKE_BASE_URL = 'http://127.0.0.1:4096'

beforeEach(() => {
  vi.resetAllMocks()
  mockCreateOpencodeClient.mockReturnValue(SENTINEL_CLIENT)
  mockExtractTextFromPart.mockImplementation((part: {type: string; text?: string}) =>
    part.type === 'text' ? (part.text ?? null) : null,
  )
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

  it('every arg is a Zod schema; only read/info session_id and search query are required', () => {
    // #then
    const requiredByTool = new Map<typeof list, readonly string[]>([
      [list, []],
      [read, ['session_id']],
      [search, ['query']],
      [info, ['session_id']],
    ])
    for (const [tool, requiredNames] of requiredByTool) {
      for (const [name, schema] of Object.entries(tool.args)) {
        expect(schema).toBeInstanceOf(z.ZodType)
        expect(schema.isOptional()).toBe(!requiredNames.includes(name))
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
    const result = await tools.list.execute({limit: 5, project_path: '/w'})

    // #then
    expect(result).toContain('ses_1')
    expect(result).toContain('Session One')
    expect(mockCreateOpencodeClient).toHaveBeenCalledWith({baseUrl: FAKE_BASE_URL})
    expect(mockListSessions).toHaveBeenCalledWith(
      SENTINEL_CLIENT,
      '/w',
      {limit: 5, fromDate: undefined, toDate: undefined},
      expect.anything(),
    )
  })

  it('passes fromDate at midnight and toDate at end-of-day for the same date', async () => {
    // #given
    mockListSessions.mockResolvedValue([])
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    await tools.list.execute({from_date: '2024-01-01', to_date: '2024-01-01'})

    // #then
    const call = mockListSessions.mock.calls[0]?.[2] as {fromDate: Date; toDate: Date}
    expect(call.fromDate.toISOString()).toBe('2024-01-01T00:00:00.000Z')
    expect(call.toDate.toISOString()).toBe('2024-01-01T23:59:59.999Z')
  })

  it('normalizes zero and negative limits to "no limit" (undefined)', async () => {
    // #given
    mockListSessions.mockResolvedValue([])
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    await tools.list.execute({limit: -1})
    await tools.list.execute({limit: 0})

    // #then
    expect(mockListSessions.mock.calls[0]?.[2]).toMatchObject({limit: undefined})
    expect(mockListSessions.mock.calls[1]?.[2]).toMatchObject({limit: undefined})
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
    expect(mockGetSession).toHaveBeenCalledWith(SENTINEL_CLIENT, 'ses_missing', expect.anything())
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
    expect(mockGetSessionTodos).toHaveBeenCalledWith(SENTINEL_CLIENT, 'ses_1', expect.anything())
  })

  it('includes transcript content (not message ids) respecting limit when include_transcript is true', async () => {
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
      {id: 'm1', role: 'user', parts: [{id: 'p1', type: 'text', text: 'hello there'}]},
      {id: 'm2', role: 'assistant', parts: [{id: 'p2', type: 'text', text: 'second message'}]},
    ])
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.read.execute({session_id: 'ses_1', include_transcript: true, limit: 1})

    // #then
    expect(result).toContain('[user] hello there')
    expect(result).not.toContain('second message')
    expect(result).not.toContain('m1')
    expect(mockGetSessionMessages).toHaveBeenCalledWith(SENTINEL_CLIENT, 'ses_1', expect.anything())
  })

  it('normalizes a negative transcript limit to "no limit"', async () => {
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
      {id: 'm1', role: 'user', parts: [{id: 'p1', type: 'text', text: 'one'}]},
      {id: 'm2', role: 'assistant', parts: [{id: 'p2', type: 'text', text: 'two'}]},
    ])
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.read.execute({session_id: 'ses_1', include_transcript: true, limit: -1})

    // #then
    expect(result).toContain('[user] one')
    expect(result).toContain('[assistant] two')
  })

  it('renders transcript messages oldest-first, keeping the earliest N under a limit', async () => {
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
      {id: 'm1', role: 'user', parts: [{id: 'p1', type: 'text', text: 'first message'}]},
      {id: 'm2', role: 'assistant', parts: [{id: 'p2', type: 'text', text: 'second message'}]},
      {id: 'm3', role: 'user', parts: [{id: 'p3', type: 'text', text: 'third message'}]},
    ])
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.read.execute({session_id: 'ses_1', include_transcript: true, limit: 2})

    // #then
    expect(result).toContain('first message')
    expect(result).toContain('second message')
    expect(result).not.toContain('third message')
  })

  it('caps the rendered transcript size and appends a truncation marker with counts', async () => {
    // #given
    mockGetSession.mockResolvedValue({
      id: 'ses_1',
      version: '1',
      projectID: 'p1',
      directory: '/w',
      title: 'T',
      time: {created: 1, updated: 2},
    })
    const bigText = 'x'.repeat(20_000)
    mockGetSessionMessages.mockResolvedValue([
      {id: 'm1', role: 'user', parts: [{id: 'p1', type: 'text', text: bigText}]},
      {id: 'm2', role: 'assistant', parts: [{id: 'p2', type: 'text', text: bigText}]},
      {id: 'm3', role: 'user', parts: [{id: 'p3', type: 'text', text: bigText}]},
    ])
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.read.execute({session_id: 'ses_1', include_transcript: true})

    // #then
    expect(result.length).toBeLessThan(60_000)
    expect(result).toMatch(/transcript truncated \(2 of 3 messages shown\)/)
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

  it('formats matches with per-match context lines and passes exact args through', async () => {
    // #given
    mockSearchSessions.mockResolvedValue([
      {sessionId: 'ses_1', matches: [{messageId: 'm1', partId: 'p1', excerpt: '...found it...', role: 'user'}]},
    ])
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.search.execute({query: 'found', limit: 3, case_sensitive: true})

    // #then
    expect(result).toContain('ses_1')
    expect(result).toContain('found it')
    expect(mockSearchSessions).toHaveBeenCalledWith(
      'found',
      SENTINEL_CLIENT,
      expect.any(String),
      {limit: 3, caseSensitive: true, sessionId: undefined},
      expect.anything(),
    )
  })

  it('normalizes zero/negative limit to "no limit"', async () => {
    // #given
    mockSearchSessions.mockResolvedValue([])
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    await tools.search.execute({query: 'found', limit: -5})

    // #then
    expect(mockSearchSessions.mock.calls[0]?.[3]).toMatchObject({limit: undefined})
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

  it('returns "session not found" (distinct from empty results) when session_id does not exist', async () => {
    // #given
    mockGetSession.mockResolvedValue(null)
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    const result = await tools.search.execute({query: 'anything', session_id: 'ses_missing'})

    // #then
    expect(result).toBe('session not found: ses_missing')
    expect(mockGetSession).toHaveBeenCalledWith(SENTINEL_CLIENT, 'ses_missing', expect.anything())
    expect(mockSearchSessions).not.toHaveBeenCalled()
  })

  it('scopes to session_id when it exists', async () => {
    // #given
    mockGetSession.mockResolvedValue({
      id: 'ses_1',
      version: '1',
      projectID: 'p1',
      directory: '/w',
      title: 'T',
      time: {created: 1, updated: 2},
    })
    mockSearchSessions.mockResolvedValue([])
    const tools = createSessionTools(() => FAKE_BASE_URL)

    // #when
    await tools.search.execute({query: 'found', session_id: 'ses_1'})

    // #then
    expect(mockSearchSessions).toHaveBeenCalledWith(
      'found',
      SENTINEL_CLIENT,
      expect.any(String),
      {limit: undefined, caseSensitive: undefined, sessionId: 'ses_1'},
      expect.anything(),
    )
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
    expect(mockGetSessionInfo).toHaveBeenCalledWith(SENTINEL_CLIENT, 'ses_missing', expect.anything())
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
