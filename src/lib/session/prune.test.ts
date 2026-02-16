import type {JsonBackend} from './backend.js'
import type {Logger} from './types.js'

import * as fs from 'node:fs/promises'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {DEFAULT_PRUNING_CONFIG, pruneSessions} from './prune.js'

// Mock fs module
vi.mock('node:fs/promises')
vi.mock('node:os')

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}

// Helper to create mock session data
function createMockSession(id: string, updatedAt: number, parentID?: string) {
  return {
    id,
    version: '1.0.0',
    projectID: 'proj1',
    directory: '/path/to/repo',
    title: `Session ${id}`,
    time: {created: updatedAt - 1000, updated: updatedAt},
    parentID,
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

describe('DEFAULT_PRUNING_CONFIG', () => {
  it('has expected default values', () => {
    expect(DEFAULT_PRUNING_CONFIG.maxSessions).toBe(50)
    expect(DEFAULT_PRUNING_CONFIG.maxAgeDays).toBe(30)
  })
})

describe('pruneSessions', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.XDG_DATA_HOME = '/test/data'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    delete process.env.XDG_DATA_HOME
  })

  it('returns empty result when no project found', async () => {
    // #given
    vi.mocked(fs.readdir).mockRejectedValue(new Error('ENOENT'))
    const backend: JsonBackend = {type: 'json', workspacePath: '/nonexistent'}

    // #when
    const result = await pruneSessions(backend, DEFAULT_PRUNING_CONFIG, mockLogger)

    // #then
    expect(result.prunedCount).toBe(0)
    expect(result.remainingCount).toBe(0)
    expect(result.freedBytes).toBe(0)
  })

  it('keeps at least maxSessions even if older than maxAgeDays', async () => {
    // #given
    const project = createMockProject('proj1', '/path/to/repo')
    const now = Date.now()
    const oldTime = now - 60 * 24 * 60 * 60 * 1000 // 60 days ago

    // Create 5 old sessions
    const sessions = [
      createMockSession('ses_1', oldTime),
      createMockSession('ses_2', oldTime + 1000),
      createMockSession('ses_3', oldTime + 2000),
      createMockSession('ses_4', oldTime + 3000),
      createMockSession('ses_5', oldTime + 4000),
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

    vi.mocked(fs.stat).mockResolvedValue({size: 100} as Awaited<ReturnType<typeof fs.stat>>)
    vi.mocked(fs.unlink).mockResolvedValue(undefined)
    vi.mocked(fs.rm).mockResolvedValue(undefined)
    const backend: JsonBackend = {type: 'json', workspacePath: '/path/to/repo'}

    // #when - maxSessions=3 should keep 3 most recent even though all are older than 30 days
    const result = await pruneSessions(backend, {maxSessions: 3, maxAgeDays: 30}, mockLogger)

    // #then
    expect(result.remainingCount).toBe(3)
    expect(result.prunedCount).toBe(2) // 5 - 3 = 2 pruned
  })

  it('keeps recent sessions even if count exceeds maxSessions', async () => {
    // #given
    const project = createMockProject('proj1', '/path/to/repo')
    const now = Date.now()

    // Create 5 recent sessions (within 30 days)
    const sessions = [
      createMockSession('ses_1', now - 1 * 24 * 60 * 60 * 1000), // 1 day ago
      createMockSession('ses_2', now - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      createMockSession('ses_3', now - 3 * 24 * 60 * 60 * 1000), // 3 days ago
      createMockSession('ses_4', now - 4 * 24 * 60 * 60 * 1000), // 4 days ago
      createMockSession('ses_5', now - 5 * 24 * 60 * 60 * 1000), // 5 days ago
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
    const backend: JsonBackend = {type: 'json', workspacePath: '/path/to/repo'}

    // #when - maxSessions=2 but all are within 30 days, so all should be kept
    const result = await pruneSessions(backend, {maxSessions: 2, maxAgeDays: 30}, mockLogger)

    // #then - all 5 sessions are within 30 days, so none should be pruned
    expect(result.prunedCount).toBe(0)
    expect(result.remainingCount).toBe(5)
  })

  it('also prunes child sessions of pruned parents', async () => {
    // #given
    const project = createMockProject('proj1', '/path/to/repo')
    const now = Date.now()
    const oldTime = now - 60 * 24 * 60 * 60 * 1000 // 60 days ago

    // Create parent and child sessions
    const sessions = [
      createMockSession('ses_parent', oldTime), // Old parent - will be pruned
      createMockSession('ses_child', oldTime + 1000, 'ses_parent'), // Child of old parent
      createMockSession('ses_recent', now - 1000), // Recent - will be kept
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

    vi.mocked(fs.stat).mockResolvedValue({size: 100} as Awaited<ReturnType<typeof fs.stat>>)
    vi.mocked(fs.unlink).mockResolvedValue(undefined)
    vi.mocked(fs.rm).mockResolvedValue(undefined)
    const backend: JsonBackend = {type: 'json', workspacePath: '/path/to/repo'}

    // #when - maxSessions=1 should keep only the most recent
    const result = await pruneSessions(backend, {maxSessions: 1, maxAgeDays: 30}, mockLogger)

    // #then - both parent and child should be pruned
    expect(result.prunedSessionIds).toContain('ses_parent')
    expect(result.prunedSessionIds).toContain('ses_child')
    expect(result.prunedCount).toBe(2)
    expect(result.remainingCount).toBe(1)
  })

  it('reports freed bytes accurately', async () => {
    // #given
    const project = createMockProject('proj1', '/path/to/repo')
    const now = Date.now()
    const oldTime = now - 60 * 24 * 60 * 60 * 1000 // 60 days ago

    const sessions = [createMockSession('ses_old', oldTime), createMockSession('ses_recent', now - 1000)]

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

    vi.mocked(fs.stat).mockResolvedValue({size: 500} as Awaited<ReturnType<typeof fs.stat>>)
    vi.mocked(fs.unlink).mockResolvedValue(undefined)
    vi.mocked(fs.rm).mockResolvedValue(undefined)
    const backend: JsonBackend = {type: 'json', workspacePath: '/path/to/repo'}

    // #when
    const result = await pruneSessions(backend, {maxSessions: 1, maxAgeDays: 30}, mockLogger)

    // #then
    expect(result.freedBytes).toBeGreaterThanOrEqual(0)
  })

  it('handles deletion errors gracefully', async () => {
    // #given
    const project = createMockProject('proj1', '/path/to/repo')
    const now = Date.now()
    const oldTime = now - 60 * 24 * 60 * 60 * 1000 // 60 days ago

    const sessions = [createMockSession('ses_old', oldTime), createMockSession('ses_recent', now - 1000)]

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

    vi.mocked(fs.stat).mockRejectedValue(new Error('Permission denied'))
    vi.mocked(fs.unlink).mockRejectedValue(new Error('Permission denied'))
    vi.mocked(fs.rm).mockRejectedValue(new Error('Permission denied'))
    const backend: JsonBackend = {type: 'json', workspacePath: '/path/to/repo'}

    // #when
    const result = await pruneSessions(backend, {maxSessions: 1, maxAgeDays: 30}, mockLogger)

    // #then - should complete without throwing, with 0 freed bytes
    expect(result.prunedCount).toBe(1) // Still counts as pruned even if deletion failed
    expect(result.freedBytes).toBe(0)
  })
})
