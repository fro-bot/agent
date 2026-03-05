import type {SessionClient} from './backend.js'
import type {Logger} from './types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {getSessionInfo, listSessions, searchSessions} from './search.js'
import {getSession, getSessionMessages, getSessionTodos, listSessionsForProject} from './storage.js'

vi.mock('./storage.js', () => ({
  listSessionsForProject: vi.fn(),
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  getSessionTodos: vi.fn(),
}))

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}

const mockClient = {
  session: {
    list: vi.fn(),
    get: vi.fn(),
    messages: vi.fn(),
    todos: vi.fn(),
  },
  project: {
    list: vi.fn(),
    current: vi.fn(),
  },
} as unknown as SessionClient

describe('listSessions', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns sessions sorted by updatedAt descending', async () => {
    // #given
    vi.mocked(listSessionsForProject).mockResolvedValue([
      {
        id: 'ses_1',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'Session 1',
        time: {created: 1000, updated: 1000},
      },
      {
        id: 'ses_2',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'Session 2',
        time: {created: 2000, updated: 3000},
      },
    ])
    vi.mocked(getSessionMessages).mockResolvedValue([])

    // #when
    const result = await listSessions(mockClient, '/workspace', {}, mockLogger)

    // #then
    expect(listSessionsForProject).toHaveBeenCalledWith(mockClient, '/workspace', mockLogger)
    expect(result).toHaveLength(2)
    expect(result[0]?.id).toBe('ses_2')
    expect(result[1]?.id).toBe('ses_1')
  })

  it('returns empty array when no sessions exist', async () => {
    // #given
    vi.mocked(listSessionsForProject).mockResolvedValue([])

    // #when
    const result = await listSessions(mockClient, '/workspace', {}, mockLogger)

    // #then
    expect(result).toEqual([])
  })

  it('excludes child sessions (those with parentID)', async () => {
    // #given
    vi.mocked(listSessionsForProject).mockResolvedValue([
      {
        id: 'ses_main',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'Main Session',
        time: {created: 1000, updated: 2000},
      },
      {
        id: 'ses_child',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'Child Session',
        parentID: 'ses_main',
        time: {created: 1500, updated: 2500},
      },
    ])
    vi.mocked(getSessionMessages).mockResolvedValue([])

    // #when
    const result = await listSessions(mockClient, '/workspace', {}, mockLogger)

    // #then
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('ses_main')
  })

  it('filters sessions by date range', async () => {
    // #given
    vi.mocked(listSessionsForProject).mockResolvedValue([
      {
        id: 'ses_old',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'Old',
        time: {created: 1000, updated: 1500},
      },
      {
        id: 'ses_new',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'New',
        time: {created: 5000, updated: 6000},
      },
    ])
    vi.mocked(getSessionMessages).mockResolvedValue([])

    // #when
    const result = await listSessions(
      mockClient,
      '/workspace',
      {fromDate: new Date(2000), toDate: new Date(6000)},
      mockLogger,
    )

    // #then
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('ses_new')
  })

  it('respects limit parameter', async () => {
    // #given
    vi.mocked(listSessionsForProject).mockResolvedValue([
      {
        id: 'ses_1',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'S1',
        time: {created: 1000, updated: 1000},
      },
      {
        id: 'ses_2',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'S2',
        time: {created: 2000, updated: 2000},
      },
      {
        id: 'ses_3',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'S3',
        time: {created: 3000, updated: 3000},
      },
    ])
    vi.mocked(getSessionMessages).mockResolvedValue([])

    // #when
    const result = await listSessions(mockClient, '/workspace', {limit: 2}, mockLogger)

    // #then
    expect(result).toHaveLength(2)
  })

  it('includes message count and agents in summary', async () => {
    // #given
    vi.mocked(listSessionsForProject).mockResolvedValue([
      {
        id: 'ses_1',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'Session 1',
        time: {created: 1000, updated: 2000},
      },
    ])
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        id: 'msg_1',
        sessionID: 'ses_1',
        role: 'user',
        time: {created: 1000},
        agent: 'Sisyphus',
        model: {providerID: 'test', modelID: 'test'},
      },
      {
        id: 'msg_2',
        sessionID: 'ses_1',
        role: 'user',
        time: {created: 2000},
        agent: 'oracle',
        model: {providerID: 'test', modelID: 'test'},
      },
    ])

    // #when
    const result = await listSessions(mockClient, '/workspace', {}, mockLogger)

    // #then
    expect(result).toHaveLength(1)
    expect(result[0]?.messageCount).toBe(2)
    expect(result[0]?.agents).toContain('Sisyphus')
    expect(result[0]?.agents).toContain('oracle')
  })
})

describe('searchSessions', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('finds matching text in message parts', async () => {
    // #given
    vi.mocked(listSessionsForProject).mockResolvedValue([
      {
        id: 'ses_1',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'Session 1',
        time: {created: 1000, updated: 2000},
      },
    ])
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        id: 'msg_1',
        sessionID: 'ses_1',
        role: 'user',
        time: {created: 1000},
        agent: 'Sisyphus',
        model: {providerID: 'test', modelID: 'test'},
        parts: [
          {id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text: 'This contains an error message'},
        ],
      } as never,
    ])

    // #when
    const results = await searchSessions('error', mockClient, '/workspace', {}, mockLogger)

    // #then
    expect(results).toHaveLength(1)
    expect(results[0]?.sessionId).toBe('ses_1')
    expect(results[0]?.matches).toHaveLength(1)
    expect(results[0]?.matches[0]?.excerpt).toContain('error')
  })

  it('returns empty results when no matches found', async () => {
    // #given
    vi.mocked(listSessionsForProject).mockResolvedValue([
      {
        id: 'ses_1',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'Session 1',
        time: {created: 1000, updated: 2000},
      },
    ])
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        id: 'msg_1',
        sessionID: 'ses_1',
        role: 'user',
        time: {created: 1000},
        agent: 'test',
        model: {providerID: 'test', modelID: 'test'},
        parts: [{id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text: 'nothing relevant here'}],
      } as never,
    ])

    // #when
    const results = await searchSessions('nonexistent', mockClient, '/workspace', {}, mockLogger)

    // #then
    expect(results).toEqual([])
  })

  it('respects caseSensitive option', async () => {
    // #given
    vi.mocked(listSessionsForProject).mockResolvedValue([
      {
        id: 'ses_1',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'Session 1',
        time: {created: 1000, updated: 2000},
      },
    ])
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        id: 'msg_1',
        sessionID: 'ses_1',
        role: 'user',
        time: {created: 1000},
        agent: 'test',
        model: {providerID: 'test', modelID: 'test'},
        parts: [
          {id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text: 'This contains an Error message'},
        ],
      } as never,
    ])

    // #when — case insensitive should find it
    const caseInsensitive = await searchSessions('error', mockClient, '/workspace', {caseSensitive: false}, mockLogger)

    // #then
    expect(caseInsensitive).toHaveLength(1)

    // #when — case sensitive should NOT find 'error' (only 'Error' exists)
    const caseSensitive = await searchSessions('error', mockClient, '/workspace', {caseSensitive: true}, mockLogger)

    // #then
    expect(caseSensitive).toHaveLength(0)
  })

  it('searches tool output in completed tool parts', async () => {
    // #given
    vi.mocked(listSessionsForProject).mockResolvedValue([
      {
        id: 'ses_1',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'Session 1',
        time: {created: 1000, updated: 2000},
      },
    ])
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        id: 'msg_1',
        sessionID: 'ses_1',
        role: 'assistant',
        time: {created: 1000},
        agent: 'test',
        model: {providerID: 'test', modelID: 'test'},
        parts: [
          {
            id: 'prt_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_1',
            tool: 'bash',
            state: {
              status: 'completed',
              input: {command: 'ls'},
              output: 'command output with special data',
              title: 'Run bash',
              metadata: {},
              time: {start: 1000, end: 2000},
            },
          },
        ],
      } as never,
    ])

    // #when
    const results = await searchSessions('special data', mockClient, '/workspace', {}, mockLogger)

    // #then
    expect(results).toHaveLength(1)
    expect(results[0]?.matches[0]?.excerpt).toContain('special data')
  })

  it('returns empty parts when message has no inline parts', async () => {
    // #given — message without parts property; fallback should be []
    vi.mocked(listSessionsForProject).mockResolvedValue([
      {
        id: 'ses_1',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'Session 1',
        time: {created: 1000, updated: 2000},
      },
    ])
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        id: 'msg_1',
        sessionID: 'ses_1',
        role: 'user',
        time: {created: 1000},
        agent: 'test',
        model: {providerID: 'test', modelID: 'test'},
      },
    ])

    // #when
    const results = await searchSessions('anything', mockClient, '/workspace', {}, mockLogger)

    // #then
    expect(results).toEqual([])
  })

  it('respects limit parameter', async () => {
    // #given
    vi.mocked(listSessionsForProject).mockResolvedValue([
      {
        id: 'ses_1',
        version: '1.0.0',
        projectID: 'proj1',
        directory: '/workspace',
        title: 'Session 1',
        time: {created: 1000, updated: 2000},
      },
    ])
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        id: 'msg_1',
        sessionID: 'ses_1',
        role: 'user',
        time: {created: 1000},
        agent: 'test',
        model: {providerID: 'test', modelID: 'test'},
        parts: [
          {id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text: 'match one here'},
          {id: 'prt_2', sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text: 'match two here'},
          {id: 'prt_3', sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text: 'match three here'},
        ],
      } as never,
    ])

    // #when
    const results = await searchSessions('match', mockClient, '/workspace', {limit: 2}, mockLogger)

    // #then
    expect(results).toHaveLength(1)
    expect(results[0]?.matches.length).toBeLessThanOrEqual(2)
  })
})

describe('getSessionInfo', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null when session does not exist', async () => {
    // #given
    vi.mocked(getSession).mockResolvedValue(null)

    // #when
    const result = await getSessionInfo(mockClient, 'nonexistent', mockLogger)

    // #then
    expect(result).toBeNull()
    expect(getSession).toHaveBeenCalledWith(mockClient, 'nonexistent', mockLogger)
  })

  it('returns session info with message count, agents, and todos', async () => {
    // #given
    vi.mocked(getSession).mockResolvedValue({
      id: 'ses_1',
      version: '1.0.0',
      projectID: 'proj1',
      directory: '/workspace',
      title: 'Session 1',
      time: {created: 1000, updated: 2000},
    })
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        id: 'msg_1',
        sessionID: 'ses_1',
        role: 'user',
        time: {created: 1000},
        agent: 'Sisyphus',
        model: {providerID: 'test', modelID: 'test'},
      },
      {
        id: 'msg_2',
        sessionID: 'ses_1',
        role: 'user',
        time: {created: 2000},
        agent: 'oracle',
        model: {providerID: 'test', modelID: 'test'},
      },
    ])
    vi.mocked(getSessionTodos).mockResolvedValue([
      {id: '1', content: 'Task 1', status: 'completed', priority: 'high'},
      {id: '2', content: 'Task 2', status: 'pending', priority: 'low'},
    ])

    // #when
    const result = await getSessionInfo(mockClient, 'ses_1', mockLogger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.session.id).toBe('ses_1')
    expect(result?.messageCount).toBe(2)
    expect(result?.agents).toContain('Sisyphus')
    expect(result?.agents).toContain('oracle')
    expect(result?.hasTodos).toBe(true)
    expect(result?.todoCount).toBe(2)
    expect(result?.completedTodos).toBe(1)
  })

  it('handles session with no todos', async () => {
    // #given
    vi.mocked(getSession).mockResolvedValue({
      id: 'ses_1',
      version: '1.0.0',
      projectID: 'proj1',
      directory: '/workspace',
      title: 'Session 1',
      time: {created: 1000, updated: 2000},
    })
    vi.mocked(getSessionMessages).mockResolvedValue([])
    vi.mocked(getSessionTodos).mockResolvedValue([])

    // #when
    const result = await getSessionInfo(mockClient, 'ses_1', mockLogger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.hasTodos).toBe(false)
    expect(result?.todoCount).toBe(0)
    expect(result?.completedTodos).toBe(0)
  })
})
