import type {Logger} from './types.js'

import * as fs from 'node:fs/promises'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {getSessionInfo, listSessions, searchSessions} from './search.js'

// Mock fs and os modules
vi.mock('node:fs/promises')
vi.mock('node:os')

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}

// Helper to create mock session data
function createMockSession(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    version: '1.0.0',
    projectID: 'proj1',
    directory: '/path/to/repo',
    title: `Session ${id}`,
    time: {created: 1000, updated: 2000},
    ...overrides,
  }
}

// Helper to create mock project data
function createMockProject(id: string, worktree: string) {
  return {
    id,
    worktree,
    vcs: 'git',
    time: {created: 1000, updated: 2000},
  }
}

// Helper to create mock message data
function createMockMessage(id: string, role: 'user' | 'assistant', agent: string, created: number) {
  return {
    id,
    sessionID: 'ses_1',
    role,
    time: {created},
    agent,
    model: {providerID: 'test', modelID: 'test'},
  }
}

describe('listSessions', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.XDG_DATA_HOME = '/test/data'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.XDG_DATA_HOME
  })

  it('returns empty array when no project found', async () => {
    // #given
    vi.mocked(fs.readdir).mockRejectedValue(new Error('ENOENT'))

    // #when
    const result = await listSessions('/nonexistent', {}, mockLogger)

    // #then
    expect(result).toEqual([])
  })

  it('returns sessions sorted by updatedAt descending', async () => {
    // #given
    const project = createMockProject('proj1', '/path/to/repo')
    const session1 = createMockSession('ses_1', {time: {created: 1000, updated: 1000}})
    const session2 = createMockSession('ses_2', {time: {created: 2000, updated: 3000}})

    // Mock project lookup
    vi.mocked(fs.readdir).mockImplementation(async dirPath => {
      const pathStr = String(dirPath)
      if (pathStr.includes('/project')) {
        return [{name: 'proj1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
      if (pathStr.includes('/session/')) {
        return [
          {name: 'ses_1.json', isFile: () => true, isDirectory: () => false},
          {name: 'ses_2.json', isFile: () => true, isDirectory: () => false},
        ] as unknown as Awaited<ReturnType<typeof fs.readdir>>
      }
      if (pathStr.includes('/message/')) {
        return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>
      }
      return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>
    })

    vi.mocked(fs.readFile).mockImplementation(async filePath => {
      const pathStr = String(filePath)
      if (pathStr.includes('/project/')) return JSON.stringify(project)
      if (pathStr.includes('ses_1.json')) return JSON.stringify(session1)
      if (pathStr.includes('ses_2.json')) return JSON.stringify(session2)
      throw new Error('ENOENT')
    })

    // #when
    const result = await listSessions('/path/to/repo', {}, mockLogger)

    // #then
    expect(result).toHaveLength(2)
    expect(result[0]?.id).toBe('ses_2') // Higher updatedAt first
    expect(result[1]?.id).toBe('ses_1')
  })

  it('excludes child sessions (those with parentID)', async () => {
    // #given
    const project = createMockProject('proj1', '/path/to/repo')
    const mainSession = createMockSession('ses_main', {})
    const childSession = createMockSession('ses_child', {parentID: 'ses_main'})

    vi.mocked(fs.readdir).mockImplementation(async dirPath => {
      const pathStr = String(dirPath)
      if (pathStr.includes('/project')) {
        return [{name: 'proj1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
      if (pathStr.includes('/session/')) {
        return [
          {name: 'ses_main.json', isFile: () => true, isDirectory: () => false},
          {name: 'ses_child.json', isFile: () => true, isDirectory: () => false},
        ] as unknown as Awaited<ReturnType<typeof fs.readdir>>
      }
      if (pathStr.includes('/message/')) {
        return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>
      }
      return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>
    })

    vi.mocked(fs.readFile).mockImplementation(async filePath => {
      const pathStr = String(filePath)
      if (pathStr.includes('/project/')) return JSON.stringify(project)
      if (pathStr.includes('ses_main.json')) return JSON.stringify(mainSession)
      if (pathStr.includes('ses_child.json')) return JSON.stringify(childSession)
      throw new Error('ENOENT')
    })

    // #when
    const result = await listSessions('/path/to/repo', {}, mockLogger)

    // #then
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('ses_main')
    expect(result.every(s => !s.isChild)).toBe(true)
  })

  it('respects limit parameter', async () => {
    // #given
    const project = createMockProject('proj1', '/path/to/repo')
    const sessions = [
      createMockSession('ses_1', {time: {created: 1000, updated: 1000}}),
      createMockSession('ses_2', {time: {created: 2000, updated: 2000}}),
      createMockSession('ses_3', {time: {created: 3000, updated: 3000}}),
    ]

    vi.mocked(fs.readdir).mockImplementation(async dirPath => {
      const pathStr = String(dirPath)
      if (pathStr.includes('/project')) {
        return [{name: 'proj1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
      if (pathStr.includes('/session/')) {
        return sessions.map(s => ({
          name: `${s.id}.json`,
          isFile: () => true,
          isDirectory: () => false,
        })) as unknown as Awaited<ReturnType<typeof fs.readdir>>
      }
      if (pathStr.includes('/message/')) {
        return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>
      }
      return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>
    })

    vi.mocked(fs.readFile).mockImplementation(async filePath => {
      const pathStr = String(filePath)
      if (pathStr.includes('/project/')) return JSON.stringify(project)
      for (const session of sessions) {
        if (pathStr.includes(`${session.id}.json`)) return JSON.stringify(session)
      }
      throw new Error('ENOENT')
    })

    // #when
    const result = await listSessions('/path/to/repo', {limit: 2}, mockLogger)

    // #then
    expect(result).toHaveLength(2)
  })

  it('includes message count and agents in summary', async () => {
    // #given
    const project = createMockProject('proj1', '/path/to/repo')
    const session = createMockSession('ses_1', {})
    const messages = [
      createMockMessage('msg_1', 'user', 'Sisyphus', 1000),
      createMockMessage('msg_2', 'assistant', 'oracle', 2000),
    ]

    vi.mocked(fs.readdir).mockImplementation(async dirPath => {
      const pathStr = String(dirPath)
      if (pathStr.includes('/project')) {
        return [{name: 'proj1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
      if (pathStr.includes('/session/')) {
        return [{name: 'ses_1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
      if (pathStr.includes('/message/')) {
        return messages.map(m => ({
          name: `${m.id}.json`,
          isFile: () => true,
          isDirectory: () => false,
        })) as unknown as Awaited<ReturnType<typeof fs.readdir>>
      }
      return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>
    })

    vi.mocked(fs.readFile).mockImplementation(async filePath => {
      const pathStr = String(filePath)
      if (pathStr.includes('/project/')) return JSON.stringify(project)
      if (pathStr.includes('ses_1.json')) return JSON.stringify(session)
      for (const msg of messages) {
        if (pathStr.includes(`${msg.id}.json`)) return JSON.stringify(msg)
      }
      throw new Error('ENOENT')
    })

    // #when
    const result = await listSessions('/path/to/repo', {}, mockLogger)

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
    process.env.XDG_DATA_HOME = '/test/data'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.XDG_DATA_HOME
  })

  it('searches text parts for matching content', async () => {
    // #given
    const project = createMockProject('proj1', '/path/to/repo')
    const session = createMockSession('ses_1', {})
    const message = createMockMessage('msg_1', 'user', 'test', 1000)
    const part = {
      id: 'prt_1',
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'text',
      text: 'This contains an error message',
    }

    vi.mocked(fs.readdir).mockImplementation(async dirPath => {
      const pathStr = String(dirPath)
      if (pathStr.includes('/project')) {
        return [{name: 'proj1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
      if (pathStr.includes('/session/')) {
        return [{name: 'ses_1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
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
      return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>
    })

    vi.mocked(fs.readFile).mockImplementation(async filePath => {
      const pathStr = String(filePath)
      if (pathStr.includes('/project/')) return JSON.stringify(project)
      if (pathStr.includes('ses_1.json')) return JSON.stringify(session)
      if (pathStr.includes('msg_1.json')) return JSON.stringify(message)
      if (pathStr.includes('prt_1.json')) return JSON.stringify(part)
      throw new Error('ENOENT')
    })

    // #when
    const results = await searchSessions('error', '/path/to/repo', {}, mockLogger)

    // #then
    expect(results).toHaveLength(1)
    expect(results[0]?.sessionId).toBe('ses_1')
    expect(results[0]?.matches).toHaveLength(1)
    expect(results[0]?.matches[0]?.excerpt).toContain('error')
  })

  it('respects caseSensitive option', async () => {
    // #given
    const project = createMockProject('proj1', '/path/to/repo')
    const session = createMockSession('ses_1', {})
    const message = createMockMessage('msg_1', 'user', 'test', 1000)
    const part = {
      id: 'prt_1',
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'text',
      text: 'This contains an Error message',
    }

    vi.mocked(fs.readdir).mockImplementation(async dirPath => {
      const pathStr = String(dirPath)
      if (pathStr.includes('/project')) {
        return [{name: 'proj1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
      if (pathStr.includes('/session/')) {
        return [{name: 'ses_1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
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
      return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>
    })

    vi.mocked(fs.readFile).mockImplementation(async filePath => {
      const pathStr = String(filePath)
      if (pathStr.includes('/project/')) return JSON.stringify(project)
      if (pathStr.includes('ses_1.json')) return JSON.stringify(session)
      if (pathStr.includes('msg_1.json')) return JSON.stringify(message)
      if (pathStr.includes('prt_1.json')) return JSON.stringify(part)
      throw new Error('ENOENT')
    })

    // #when - case insensitive should find it
    const caseInsensitive = await searchSessions('error', '/path/to/repo', {caseSensitive: false}, mockLogger)

    // #then
    expect(caseInsensitive).toHaveLength(1)

    // #when - case sensitive should NOT find 'error' (only 'Error' exists)
    const caseSensitive = await searchSessions('error', '/path/to/repo', {caseSensitive: true}, mockLogger)

    // #then
    expect(caseSensitive).toHaveLength(0)
  })

  it('searches tool output in completed tool parts', async () => {
    // #given
    const project = createMockProject('proj1', '/path/to/repo')
    const session = createMockSession('ses_1', {})
    const message = createMockMessage('msg_1', 'assistant', 'test', 1000)
    const part = {
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
    }

    vi.mocked(fs.readdir).mockImplementation(async dirPath => {
      const pathStr = String(dirPath)
      if (pathStr.includes('/project')) {
        return [{name: 'proj1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
      if (pathStr.includes('/session/')) {
        return [{name: 'ses_1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
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
      return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>
    })

    vi.mocked(fs.readFile).mockImplementation(async filePath => {
      const pathStr = String(filePath)
      if (pathStr.includes('/project/')) return JSON.stringify(project)
      if (pathStr.includes('ses_1.json')) return JSON.stringify(session)
      if (pathStr.includes('msg_1.json')) return JSON.stringify(message)
      if (pathStr.includes('prt_1.json')) return JSON.stringify(part)
      throw new Error('ENOENT')
    })

    // #when
    const results = await searchSessions('special data', '/path/to/repo', {}, mockLogger)

    // #then
    expect(results).toHaveLength(1)
    expect(results[0]?.matches[0]?.excerpt).toContain('special data')
  })

  it('respects limit parameter', async () => {
    // #given
    const project = createMockProject('proj1', '/path/to/repo')
    const session = createMockSession('ses_1', {})
    const message = createMockMessage('msg_1', 'user', 'test', 1000)
    const parts = [
      {id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text: 'match one'},
      {id: 'prt_2', sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text: 'match two'},
      {id: 'prt_3', sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text: 'match three'},
    ]

    vi.mocked(fs.readdir).mockImplementation(async dirPath => {
      const pathStr = String(dirPath)
      if (pathStr.includes('/project')) {
        return [{name: 'proj1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
      if (pathStr.includes('/session/')) {
        return [{name: 'ses_1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
      if (pathStr.includes('/message/')) {
        return [{name: 'msg_1.json', isFile: () => true, isDirectory: () => false}] as unknown as Awaited<
          ReturnType<typeof fs.readdir>
        >
      }
      if (pathStr.includes('/part/')) {
        return parts.map(p => ({
          name: `${p.id}.json`,
          isFile: () => true,
          isDirectory: () => false,
        })) as unknown as Awaited<ReturnType<typeof fs.readdir>>
      }
      return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>
    })

    vi.mocked(fs.readFile).mockImplementation(async filePath => {
      const pathStr = String(filePath)
      if (pathStr.includes('/project/')) return JSON.stringify(project)
      if (pathStr.includes('ses_1.json')) return JSON.stringify(session)
      if (pathStr.includes('msg_1.json')) return JSON.stringify(message)
      for (const part of parts) {
        if (pathStr.includes(`${part.id}.json`)) return JSON.stringify(part)
      }
      throw new Error('ENOENT')
    })

    // #when
    const results = await searchSessions('match', '/path/to/repo', {limit: 2}, mockLogger)

    // #then
    expect(results).toHaveLength(1)
    expect(results[0]?.matches.length).toBeLessThanOrEqual(2)
  })
})

describe('getSessionInfo', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.XDG_DATA_HOME = '/test/data'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.XDG_DATA_HOME
  })

  it('returns null when session does not exist', async () => {
    // #given
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'))

    // #when
    const result = await getSessionInfo('nonexistent', 'proj1', mockLogger)

    // #then
    expect(result).toBeNull()
  })

  it('returns session info with message count and agents', async () => {
    // #given
    const session = createMockSession('ses_1', {})
    const messages = [
      createMockMessage('msg_1', 'user', 'Sisyphus', 1000),
      createMockMessage('msg_2', 'assistant', 'oracle', 2000),
    ]
    const todos = [
      {id: '1', content: 'Task 1', status: 'completed', priority: 'high'},
      {id: '2', content: 'Task 2', status: 'pending', priority: 'low'},
    ]

    vi.mocked(fs.readdir).mockImplementation(async dirPath => {
      const pathStr = String(dirPath)
      if (pathStr.includes('/message/')) {
        return messages.map(m => ({
          name: `${m.id}.json`,
          isFile: () => true,
          isDirectory: () => false,
        })) as unknown as Awaited<ReturnType<typeof fs.readdir>>
      }
      return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>
    })

    vi.mocked(fs.readFile).mockImplementation(async filePath => {
      const pathStr = String(filePath)
      if (pathStr.includes('ses_1.json') && pathStr.includes('/session/')) return JSON.stringify(session)
      if (pathStr.includes('/todo/')) return JSON.stringify(todos)
      for (const msg of messages) {
        if (pathStr.includes(`${msg.id}.json`)) return JSON.stringify(msg)
      }
      throw new Error('ENOENT')
    })

    // #when
    const result = await getSessionInfo('ses_1', 'proj1', mockLogger)

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
})
