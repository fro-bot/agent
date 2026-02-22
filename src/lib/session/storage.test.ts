import type {SessionClient} from './backend.js'
import type {Logger} from './types.js'

import {describe, expect, it, vi} from 'vitest'

import {
  deleteSession,
  findLatestSession,
  findProjectByWorkspace,
  getSession,
  getSessionMessages,
  getSessionTodos,
  listProjectsViaSDK,
  listSessionsForProject,
} from './storage.js'

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}

function createMockSdkClient(options?: {
  sessionListResponse?: {data?: unknown; error?: unknown}
  sessionGetResponse?: {data?: unknown; error?: unknown}
  sessionMessagesResponse?: {data?: unknown; error?: unknown}
  sessionTodosResponse?: {data?: unknown; error?: unknown}
  sessionDeleteResponse?: {data?: unknown; error?: unknown}
  projectListResponse?: {data?: unknown; error?: unknown}
}) {
  return {
    session: {
      list: vi.fn().mockResolvedValue(options?.sessionListResponse ?? {data: []}),
      get: vi.fn().mockResolvedValue(options?.sessionGetResponse ?? {data: null}),
      messages: vi.fn().mockResolvedValue(options?.sessionMessagesResponse ?? {data: []}),
      todos: vi.fn().mockResolvedValue(options?.sessionTodosResponse ?? {data: []}),
      delete: vi.fn().mockResolvedValue(options?.sessionDeleteResponse ?? {data: null}),
    },
    project: {
      list: vi.fn().mockResolvedValue(options?.projectListResponse ?? {data: []}),
    },
  }
}

describe('listProjectsViaSDK', () => {
  it('maps project list results from SDK', async () => {
    // #given
    const client = createMockSdkClient({
      projectListResponse: {
        data: [
          {id: 'proj_1', worktree: '/repo', path: '/repo', extra: 'ignored'},
          {id: 'proj_2', worktree: '/repo-two', path: '/repo-two'},
        ],
      },
    })

    // #when
    const result = await listProjectsViaSDK(client as unknown as SessionClient, mockLogger)

    // #then
    expect(client.project.list).toHaveBeenCalledWith()
    expect(result).toEqual([
      {id: 'proj_1', worktree: '/repo', path: '/repo'},
      {id: 'proj_2', worktree: '/repo-two', path: '/repo-two'},
    ])
  })

  it('returns empty array when project list fails', async () => {
    // #given
    const client = createMockSdkClient({projectListResponse: {error: 'boom', data: null}})

    // #when
    const result = await listProjectsViaSDK(client as unknown as SessionClient, mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK project list failed', expect.any(Object))
  })

  it('filters malformed project records', async () => {
    // #given
    const client = createMockSdkClient({
      projectListResponse: {
        data: [
          {id: 'proj', worktree: '/repo'},
          {id: 123, worktree: '/repo', path: '/repo'},
        ],
      },
    })

    // #when
    const result = await listProjectsViaSDK(client as unknown as SessionClient, mockLogger)

    // #then
    expect(result).toEqual([])
  })
})

describe('findProjectByWorkspace', () => {
  it('returns project matching normalized workspace path', async () => {
    // #given
    const client = createMockSdkClient({
      projectListResponse: {data: [{id: 'proj_1', worktree: '/repo', path: '/repo'}]},
    })

    // #when
    const result = await findProjectByWorkspace(client as unknown as SessionClient, '/repo/', mockLogger)

    // #then
    expect(result).toEqual({id: 'proj_1', worktree: '/repo', path: '/repo'})
  })

  it('returns null when no project matches', async () => {
    // #given
    const client = createMockSdkClient({
      projectListResponse: {data: [{id: 'proj_1', worktree: '/repo', path: '/repo'}]},
    })

    // #when
    const result = await findProjectByWorkspace(client as unknown as SessionClient, '/other', mockLogger)

    // #then
    expect(result).toBeNull()
  })
})

describe('listSessionsForProject', () => {
  it('lists sessions via SDK', async () => {
    // #given
    const sdkSession = {
      id: 'ses_sdk',
      version: '1.1.53',
      projectId: 'proj_sdk',
      directory: '/workspace',
      title: 'SDK Session',
      time: {created: 1000, updated: 2000},
    }
    const client = createMockSdkClient({sessionListResponse: {data: [sdkSession]}})

    // #when
    const result = await listSessionsForProject(client as unknown as SessionClient, '/workspace', mockLogger)

    // #then
    expect(client.session.list).toHaveBeenCalledWith({query: {directory: '/workspace'}})
    expect(result).toEqual([
      {
        id: 'ses_sdk',
        version: '1.1.53',
        projectID: 'proj_sdk',
        directory: '/workspace',
        title: 'SDK Session',
        time: {created: 1000, updated: 2000},
      },
    ])
  })

  it('returns empty list when SDK session list fails', async () => {
    // #given
    const client = createMockSdkClient({sessionListResponse: {error: 'boom', data: null}})

    // #when
    const result = await listSessionsForProject(client as unknown as SessionClient, '/workspace', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session list failed', expect.any(Object))
  })
})

describe('getSession', () => {
  it('gets session via SDK', async () => {
    // #given
    const sdkSession = {
      id: 'ses_sdk',
      version: '1.1.53',
      projectId: 'proj_sdk',
      directory: '/workspace',
      title: 'SDK Session',
      time: {created: 1000, updated: 2000},
    }
    const client = createMockSdkClient({sessionGetResponse: {data: sdkSession}})

    // #when
    const result = await getSession(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(client.session.get).toHaveBeenCalledWith({path: {id: 'ses_sdk'}})
    expect(result).toEqual({
      id: 'ses_sdk',
      version: '1.1.53',
      projectID: 'proj_sdk',
      directory: '/workspace',
      title: 'SDK Session',
      time: {created: 1000, updated: 2000},
    })
  })

  it('returns null when SDK session get fails', async () => {
    // #given
    const client = createMockSdkClient({sessionGetResponse: {error: 'boom', data: null}})

    // #when
    const result = await getSession(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(result).toBeNull()
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session get failed', expect.any(Object))
  })
})

describe('getSessionMessages', () => {
  it('returns sorted messages via SDK', async () => {
    // #given
    const sdkMessages = [
      {
        id: 'msg_1',
        sessionId: 'ses_sdk',
        role: 'assistant',
        time: {created: 2000},
        parentId: 'msg_0',
        modelId: 'model',
        providerId: 'provider',
        mode: 'chat',
        agent: 'Sisyphus',
        path: {cwd: '/workspace', root: '/workspace'},
        cost: 0,
        tokens: {input: 0, output: 0, reasoning: 0, cache: {read: 0, write: 0}},
      },
      {
        id: 'msg_2',
        sessionId: 'ses_sdk',
        role: 'user',
        time: {created: 1000},
        agent: 'User',
        model: {providerID: 'provider', modelID: 'model'},
      },
    ]
    const client = createMockSdkClient({sessionMessagesResponse: {data: sdkMessages}})

    // #when
    const result = await getSessionMessages(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(client.session.messages).toHaveBeenCalledWith({path: {id: 'ses_sdk'}})
    expect(result).toHaveLength(2)
    expect(result[0]?.id).toBe('msg_2')
    expect(result[1]?.id).toBe('msg_1')
  })

  it('returns empty messages when SDK messages fail', async () => {
    // #given
    const client = createMockSdkClient({sessionMessagesResponse: {error: 'boom', data: null}})

    // #when
    const result = await getSessionMessages(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session messages failed', expect.any(Object))
  })
})

describe('getSessionTodos', () => {
  it('returns todos via SDK', async () => {
    // #given
    const sdkTodos = [
      {content: 'Task 1', status: 'pending', priority: 'high'},
      {id: 't2', content: 'Task 2', status: 'completed', priority: 'low'},
    ]
    const client = createMockSdkClient({sessionTodosResponse: {data: sdkTodos}})

    // #when
    const result = await getSessionTodos(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(client.session.todos).toHaveBeenCalledWith({path: {id: 'ses_sdk'}})
    expect(result).toEqual([
      {content: 'Task 1', status: 'pending', priority: 'high'},
      {id: 't2', content: 'Task 2', status: 'completed', priority: 'low'},
    ])
  })

  it('returns empty todos when SDK todos fail', async () => {
    // #given
    const client = createMockSdkClient({sessionTodosResponse: {error: 'boom', data: null}})

    // #when
    const result = await getSessionTodos(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session todos failed', expect.any(Object))
  })
})

describe('findLatestSession', () => {
  it('finds latest session via SDK', async () => {
    // #given
    const sdkSession = {
      id: 'ses_latest',
      version: '1.1.53',
      projectId: 'proj_sdk',
      directory: '/workspace',
      title: 'Latest',
      time: {created: 5000, updated: 6000},
    }
    const client = createMockSdkClient({sessionListResponse: {data: [sdkSession]}})

    // #when
    const result = await findLatestSession(client as unknown as SessionClient, '/workspace', 4000, mockLogger)

    // #then
    expect(client.session.list).toHaveBeenCalledWith({
      query: {directory: '/workspace', start: 4000, roots: true, limit: 10},
    })
    expect(result?.session.id).toBe('ses_latest')
  })
})

describe('deleteSession', () => {
  it('deletes session via SDK', async () => {
    // #given
    const client = createMockSdkClient({sessionDeleteResponse: {data: null}})

    // #when
    const result = await deleteSession(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(client.session.delete).toHaveBeenCalledWith({path: {id: 'ses_sdk'}})
    expect(result).toBe(0)
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Deleted session via SDK',
      expect.objectContaining({sessionID: 'ses_sdk'}),
    )
  })

  it('handles SDK delete errors gracefully', async () => {
    // #given
    const client = createMockSdkClient({sessionDeleteResponse: {error: 'Not found'}})

    // #when
    const result = await deleteSession(client as unknown as SessionClient, 'ses_missing', mockLogger)

    // #then
    expect(result).toBe(0)
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'SDK session delete failed',
      expect.objectContaining({sessionID: 'ses_missing'}),
    )
  })
})
