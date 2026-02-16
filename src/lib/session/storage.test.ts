import type {Logger} from './types.js'
import * as fs from 'node:fs/promises'

import * as os from 'node:os'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {
  deleteSession,
  findLatestSession,
  findProjectByDirectory,
  getMessageParts,
  getOpenCodeStoragePath,
  getSession,
  getSessionMessages,
  getSessionTodos,
  listProjects,
  listSessionsForProject,
} from './storage.js'

vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn(),
}))

// Mock fs module
vi.mock('node:fs/promises')
vi.mock('node:os')

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}

function createMockSdkClient(options: {
  listResponse?: {data?: unknown; error?: unknown}
  getResponse?: {data?: unknown; error?: unknown}
  messagesResponse?: {data?: unknown; error?: unknown}
  todosResponse?: {data?: unknown; error?: unknown}
}) {
  return {
    session: {
      list: vi.fn().mockResolvedValue(options.listResponse ?? {data: []}),
      get: vi.fn().mockResolvedValue(options.getResponse ?? {data: null}),
      messages: vi.fn().mockResolvedValue(options.messagesResponse ?? {data: []}),
      todos: vi.fn().mockResolvedValue(options.todosResponse ?? {data: []}),
    },
  }
}

describe('getOpenCodeStoragePath', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.XDG_DATA_HOME
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses XDG_DATA_HOME when set', () => {
    // #given
    process.env.XDG_DATA_HOME = '/custom/data'

    // #when
    const result = getOpenCodeStoragePath()

    // #then
    expect(result).toBe('/custom/data/opencode/storage')
  })

  it('falls back to ~/.local/share when XDG_DATA_HOME is not set', () => {
    // #given
    vi.mocked(os.homedir).mockReturnValue('/home/user')

    // #when
    const result = getOpenCodeStoragePath()

    // #then
    expect(result).toBe('/home/user/.local/share/opencode/storage')
  })
})

describe('listProjects', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.XDG_DATA_HOME = '/test/data'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.XDG_DATA_HOME
  })

  it('returns empty array when project directory does not exist', async () => {
    // #given
    vi.mocked(fs.readdir).mockRejectedValue(new Error('ENOENT'))

    // #when
    const result = await listProjects(mockLogger)

    // #then
    expect(result).toEqual([])
  })

  it('returns parsed project files', async () => {
    // #given
    const projectData = {
      id: 'abc123',
      worktree: '/path/to/project',
      vcs: 'git',
      time: {created: 1000, updated: 2000},
    }

    vi.mocked(fs.readdir).mockResolvedValue([
      {name: 'abc123.json', isFile: () => true, isDirectory: () => false},
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(projectData))

    // #when
    const result = await listProjects(mockLogger)

    // #then
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(projectData)
  })

  it('skips non-JSON files', async () => {
    // #given
    vi.mocked(fs.readdir).mockResolvedValue([
      {name: 'readme.txt', isFile: () => true, isDirectory: () => false},
      {name: 'project.json', isFile: () => true, isDirectory: () => false},
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({id: 'test'}))

    // #when
    const result = await listProjects(mockLogger)

    // #then
    expect(result).toHaveLength(1)
  })

  it('skips directories', async () => {
    // #given
    vi.mocked(fs.readdir).mockResolvedValue([
      {name: 'subdir', isFile: () => false, isDirectory: () => true},
      {name: 'project.json', isFile: () => true, isDirectory: () => false},
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({id: 'test'}))

    // #when
    const result = await listProjects(mockLogger)

    // #then
    expect(result).toHaveLength(1)
  })

  it('skips files with invalid JSON', async () => {
    // #given
    vi.mocked(fs.readdir).mockResolvedValue([
      {name: 'invalid.json', isFile: () => true, isDirectory: () => false},
      {name: 'valid.json', isFile: () => true, isDirectory: () => false},
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    vi.mocked(fs.readFile)
      .mockResolvedValueOnce('not valid json')
      .mockResolvedValueOnce(JSON.stringify({id: 'valid'}))

    // #when
    const result = await listProjects(mockLogger)

    // #then
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({id: 'valid'})
  })
})

describe('findProjectByDirectory', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.XDG_DATA_HOME = '/test/data'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.XDG_DATA_HOME
  })

  it('returns project matching directory', async () => {
    // #given
    const project = {
      id: 'proj1',
      worktree: '/path/to/repo',
      vcs: 'git',
      time: {created: 1000, updated: 2000},
    }

    vi.mocked(fs.readdir).mockResolvedValue([
      {name: 'proj1.json', isFile: () => true, isDirectory: () => false},
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(project))

    // #when
    const result = await findProjectByDirectory('/path/to/repo', mockLogger)

    // #then
    expect(result).toEqual(project)
  })

  it('returns null when no project matches', async () => {
    // #given
    const project = {
      id: 'proj1',
      worktree: '/different/path',
      vcs: 'git',
      time: {created: 1000, updated: 2000},
    }

    vi.mocked(fs.readdir).mockResolvedValue([
      {name: 'proj1.json', isFile: () => true, isDirectory: () => false},
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(project))

    // #when
    const result = await findProjectByDirectory('/path/to/repo', mockLogger)

    // #then
    expect(result).toBeNull()
  })
})

describe('listSessionsForProject', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.XDG_DATA_HOME = '/test/data'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.XDG_DATA_HOME
  })

  it('returns sessions for project', async () => {
    // #given
    const session = {
      id: 'ses_abc123',
      version: '1.0.0',
      projectID: 'proj1',
      directory: '/path/to/repo',
      title: 'Test Session',
      time: {created: 1000, updated: 2000},
    }

    vi.mocked(fs.readdir).mockResolvedValue([
      {name: 'ses_abc123.json', isFile: () => true, isDirectory: () => false},
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(session))

    // #when
    const result = await listSessionsForProject({type: 'json', workspacePath: '/path/to/repo'}, 'proj1', mockLogger)

    // #then
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(session)
  })

  it('returns empty array when session directory does not exist', async () => {
    // #given
    vi.mocked(fs.readdir).mockRejectedValue(new Error('ENOENT'))

    // #when
    const result = await listSessionsForProject(
      {type: 'json', workspacePath: '/path/to/repo'},
      'nonexistent',
      mockLogger,
    )

    // #then
    expect(result).toEqual([])
  })
})

describe('getSession', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.XDG_DATA_HOME = '/test/data'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.XDG_DATA_HOME
  })

  it('returns session when file exists', async () => {
    // #given
    const session = {
      id: 'ses_abc123',
      version: '1.0.0',
      projectID: 'proj1',
      directory: '/path/to/repo',
      title: 'Test Session',
      time: {created: 1000, updated: 2000},
    }

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(session))

    // #when
    const result = await getSession({type: 'json', workspacePath: '/path/to/repo'}, 'proj1', 'ses_abc123', mockLogger)

    // #then
    expect(result).toEqual(session)
    expect(fs.readFile).toHaveBeenCalledWith('/test/data/opencode/storage/session/proj1/ses_abc123.json', 'utf8')
  })

  it('returns null when file does not exist', async () => {
    // #given
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'))

    // #when
    const result = await getSession({type: 'json', workspacePath: '/path/to/repo'}, 'proj1', 'nonexistent', mockLogger)

    // #then
    expect(result).toBeNull()
  })
})

describe('getSessionMessages', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.XDG_DATA_HOME = '/test/data'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.XDG_DATA_HOME
  })

  it('returns messages sorted by creation time', async () => {
    // #given
    const msg1 = {id: 'msg_1', sessionID: 'ses_1', role: 'user', time: {created: 2000}, agent: 'test', model: {}}
    const msg2 = {id: 'msg_2', sessionID: 'ses_1', role: 'assistant', time: {created: 1000}, agent: 'test'}

    vi.mocked(fs.readdir).mockResolvedValue([
      {name: 'msg_1.json', isFile: () => true, isDirectory: () => false},
      {name: 'msg_2.json', isFile: () => true, isDirectory: () => false},
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(msg1)).mockResolvedValueOnce(JSON.stringify(msg2))

    // #when
    const result = await getSessionMessages({type: 'json', workspacePath: '/path/to/repo'}, 'ses_1', mockLogger)

    // #then
    expect(result).toHaveLength(2)
    expect(result[0]?.id).toBe('msg_2') // Earlier timestamp first
    expect(result[1]?.id).toBe('msg_1')
  })

  it('returns empty array when message directory does not exist', async () => {
    // #given
    vi.mocked(fs.readdir).mockRejectedValue(new Error('ENOENT'))

    // #when
    const result = await getSessionMessages({type: 'json', workspacePath: '/path/to/repo'}, 'nonexistent', mockLogger)

    // #then
    expect(result).toEqual([])
  })
})

describe('getMessageParts', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.XDG_DATA_HOME = '/test/data'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.XDG_DATA_HOME
  })

  it('returns parts for message', async () => {
    // #given
    const part = {
      id: 'prt_1',
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'text',
      text: 'Hello world',
    }

    vi.mocked(fs.readdir).mockResolvedValue([
      {name: 'prt_1.json', isFile: () => true, isDirectory: () => false},
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(part))

    // #when
    const result = await getMessageParts({type: 'json', workspacePath: '/path/to/repo'}, 'msg_1', mockLogger)

    // #then
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(part)
  })
})

describe('getSessionTodos', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.XDG_DATA_HOME = '/test/data'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.XDG_DATA_HOME
  })

  it('returns todos when file exists', async () => {
    // #given
    const todos = [
      {id: '1', content: 'Task 1', status: 'pending', priority: 'high'},
      {id: '2', content: 'Task 2', status: 'completed', priority: 'low'},
    ]

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(todos))

    // #when
    const result = await getSessionTodos({type: 'json', workspacePath: '/path/to/repo'}, 'ses_1', mockLogger)

    // #then
    expect(result).toEqual(todos)
  })

  it('returns empty array when file does not exist', async () => {
    // #given
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'))

    // #when
    const result = await getSessionTodos({type: 'json', workspacePath: '/path/to/repo'}, 'nonexistent', mockLogger)

    // #then
    expect(result).toEqual([])
  })
})

describe('SDK session storage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

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
    const client = createMockSdkClient({listResponse: {data: [sdkSession]}})
    const backend = {type: 'sdk', workspacePath: '/workspace', client} as unknown as import('./backend.js').SdkBackend

    // #when
    const result = await listSessionsForProject(backend, 'proj_sdk', mockLogger)

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
    const client = createMockSdkClient({listResponse: {error: 'boom', data: null}})
    const backend = {type: 'sdk', workspacePath: '/workspace', client} as unknown as import('./backend.js').SdkBackend

    // #when
    const result = await listSessionsForProject(backend, 'proj_sdk', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session list failed', expect.any(Object))
  })

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
    const client = createMockSdkClient({getResponse: {data: sdkSession}})
    const backend = {type: 'sdk', workspacePath: '/workspace', client} as unknown as import('./backend.js').SdkBackend

    // #when
    const result = await getSession(backend, 'proj_sdk', 'ses_sdk', mockLogger)

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
    const client = createMockSdkClient({getResponse: {error: 'boom', data: null}})
    const backend = {type: 'sdk', workspacePath: '/workspace', client} as unknown as import('./backend.js').SdkBackend

    // #when
    const result = await getSession(backend, 'proj_sdk', 'ses_sdk', mockLogger)

    // #then
    expect(result).toBeNull()
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session get failed', expect.any(Object))
  })

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
    const client = createMockSdkClient({messagesResponse: {data: sdkMessages}})
    const backend = {type: 'sdk', workspacePath: '/workspace', client} as unknown as import('./backend.js').SdkBackend

    // #when
    const result = await getSessionMessages(backend, 'ses_sdk', mockLogger)

    // #then
    expect(client.session.messages).toHaveBeenCalledWith({path: {id: 'ses_sdk'}})
    expect(result).toHaveLength(2)
    expect(result[0]?.id).toBe('msg_2')
    expect(result[1]?.id).toBe('msg_1')
  })

  it('returns empty messages when SDK messages fail', async () => {
    // #given
    const client = createMockSdkClient({messagesResponse: {error: 'boom', data: null}})
    const backend = {type: 'sdk', workspacePath: '/workspace', client} as unknown as import('./backend.js').SdkBackend

    // #when
    const result = await getSessionMessages(backend, 'ses_sdk', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session messages failed', expect.any(Object))
  })

  it('returns todos via SDK', async () => {
    // #given
    const sdkTodos = [
      {content: 'Task 1', status: 'pending', priority: 'high'},
      {id: 't2', content: 'Task 2', status: 'completed', priority: 'low'},
    ]
    const client = createMockSdkClient({todosResponse: {data: sdkTodos}})
    const backend = {type: 'sdk', workspacePath: '/workspace', client} as unknown as import('./backend.js').SdkBackend

    // #when
    const result = await getSessionTodos(backend, 'ses_sdk', mockLogger)

    // #then
    expect(client.session.todos).toHaveBeenCalledWith({path: {id: 'ses_sdk'}})
    expect(result).toEqual([
      {content: 'Task 1', status: 'pending', priority: 'high'},
      {id: 't2', content: 'Task 2', status: 'completed', priority: 'low'},
    ])
  })

  it('returns empty todos when SDK todos fail', async () => {
    // #given
    const client = createMockSdkClient({todosResponse: {error: 'boom', data: null}})
    const backend = {type: 'sdk', workspacePath: '/workspace', client} as unknown as import('./backend.js').SdkBackend

    // #when
    const result = await getSessionTodos(backend, 'ses_sdk', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session todos failed', expect.any(Object))
  })

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
    const client = createMockSdkClient({listResponse: {data: [sdkSession]}})
    const backend = {type: 'sdk', workspacePath: '/workspace', client} as unknown as import('./backend.js').SdkBackend

    // #when
    const result = await findLatestSession(backend, 4000, mockLogger)

    // #then
    expect(client.session.list).toHaveBeenCalledWith({
      query: {directory: '/workspace', start: 4000, roots: true, limit: 1},
    })
    expect(result?.session.id).toBe('ses_latest')
  })
})

describe('deleteSession', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.XDG_DATA_HOME = '/test/data'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.XDG_DATA_HOME
  })

  it('deletes session and associated data', async () => {
    // #given
    const message = {id: 'msg_1', sessionID: 'ses_1', role: 'user', time: {created: 1000}, agent: 'test', model: {}}

    // Mock getSessionMessages
    vi.mocked(fs.readdir).mockImplementation(async dirPath => {
      const pathStr = String(dirPath)
      if (pathStr.includes('/message/')) {
        return [{name: 'msg_1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
      if (pathStr.includes('/part/')) {
        return [{name: 'prt_1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
      return []
    })

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(message))
    vi.mocked(fs.stat).mockResolvedValue({size: 100} as Awaited<ReturnType<typeof fs.stat>>)
    vi.mocked(fs.unlink).mockResolvedValue(undefined)
    vi.mocked(fs.rm).mockResolvedValue(undefined)

    // #when
    const result = await deleteSession({type: 'json', workspacePath: '/path/to/repo'}, 'proj1', 'ses_1', mockLogger)

    // #then
    expect(result).toBeGreaterThan(0)
    expect(mockLogger.debug).toHaveBeenCalledWith('Deleted session', expect.objectContaining({sessionID: 'ses_1'}))
  })

  it('handles missing files gracefully', async () => {
    // #given
    vi.mocked(fs.readdir).mockRejectedValue(new Error('ENOENT'))
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'))
    vi.mocked(fs.unlink).mockRejectedValue(new Error('ENOENT'))
    vi.mocked(fs.rm).mockRejectedValue(new Error('ENOENT'))

    // #when
    const result = await deleteSession(
      {type: 'json', workspacePath: '/path/to/repo'},
      'proj1',
      'nonexistent',
      mockLogger,
    )

    // #then
    expect(result).toBe(0)
  })

  it('deletes session via SDK when using sdk backend', async () => {
    // #given
    const deleteFn = vi.fn().mockResolvedValue({data: null})
    const client = {
      session: {delete: deleteFn},
    } as unknown as import('./backend.js').SdkBackend['client']
    const sdkBackend = {type: 'sdk', workspacePath: '/workspace', client} as import('./backend.js').SdkBackend

    // #when
    const result = await deleteSession(sdkBackend, 'proj1', 'ses_sdk', mockLogger)

    // #then
    expect(deleteFn).toHaveBeenCalledWith({path: {id: 'ses_sdk'}})
    expect(result).toBe(0)
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Deleted session via SDK',
      expect.objectContaining({sessionID: 'ses_sdk'}),
    )
  })

  it('handles SDK delete errors gracefully', async () => {
    // #given
    const deleteFn = vi.fn().mockResolvedValue({error: 'Not found'})
    const client = {
      session: {delete: deleteFn},
    } as unknown as import('./backend.js').SdkBackend['client']
    const sdkBackend = {type: 'sdk', workspacePath: '/workspace', client} as import('./backend.js').SdkBackend

    // #when
    const result = await deleteSession(sdkBackend, 'proj1', 'ses_missing', mockLogger)

    // #then
    expect(result).toBe(0)
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'SDK session delete failed',
      expect.objectContaining({sessionID: 'ses_missing'}),
    )
  })
})
