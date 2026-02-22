import type {SessionClient} from './backend.js'
import type {Logger, SessionInfo} from './types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {DEFAULT_PRUNING_CONFIG, pruneSessions} from './prune.js'

vi.mock('./storage.js')

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}

function createMockSession(id: string, updatedAt: number, parentID?: string): SessionInfo {
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

function createMockSdkClient() {
  return {
    session: {
      list: vi.fn().mockResolvedValue({data: []}),
      get: vi.fn().mockResolvedValue({data: null}),
      messages: vi.fn().mockResolvedValue({data: []}),
      todos: vi.fn().mockResolvedValue({data: []}),
      delete: vi.fn().mockResolvedValue({data: null}),
    },
    project: {
      list: vi.fn().mockResolvedValue({data: []}),
    },
  } as unknown as SessionClient
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
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('returns zeros when no project found', async () => {
    // #given
    const {findProjectByWorkspace} = await import('./storage.js')
    vi.mocked(findProjectByWorkspace).mockResolvedValue(null)
    const client = createMockSdkClient()

    // #when
    const result = await pruneSessions(client, '/nonexistent', DEFAULT_PRUNING_CONFIG, mockLogger)

    // #then
    expect(result.prunedCount).toBe(0)
    expect(result.remainingCount).toBe(0)
    expect(result.freedBytes).toBe(0)
    expect(result.prunedSessionIds).toEqual([])
  })

  it('returns zeros when no sessions exist', async () => {
    // #given
    const {findProjectByWorkspace, listSessionsForProject} = await import('./storage.js')
    vi.mocked(findProjectByWorkspace).mockResolvedValue({
      id: 'proj1',
      worktree: '/repo',
      vcs: 'git',
      time: {created: 1000, updated: 2000},
    })
    vi.mocked(listSessionsForProject).mockResolvedValue([])
    const client = createMockSdkClient()

    // #when
    const result = await pruneSessions(client, '/repo', {maxSessions: 5, maxAgeDays: 30}, mockLogger)

    // #then
    expect(result.prunedCount).toBe(0)
    expect(result.remainingCount).toBe(0)
    expect(result.freedBytes).toBe(0)
  })

  it('prunes oldest sessions when count exceeds maxSessions', async () => {
    // #given
    const {findProjectByWorkspace, listSessionsForProject, deleteSession} = await import('./storage.js')
    const now = Date.now()
    const oldTime = now - 60 * 24 * 60 * 60 * 1000 // 60 days ago

    const sessions = [
      createMockSession('ses_1', oldTime),
      createMockSession('ses_2', oldTime + 1000),
      createMockSession('ses_3', oldTime + 2000),
      createMockSession('ses_4', oldTime + 3000),
      createMockSession('ses_5', oldTime + 4000),
    ]

    vi.mocked(findProjectByWorkspace).mockResolvedValue({
      id: 'proj1',
      worktree: '/repo',
      vcs: 'git',
      time: {created: 1000, updated: 2000},
    })
    vi.mocked(listSessionsForProject).mockResolvedValue(sessions)
    vi.mocked(deleteSession).mockResolvedValue(0)
    const client = createMockSdkClient()

    // #when — maxSessions=3, all sessions older than 30 days
    const result = await pruneSessions(client, '/repo', {maxSessions: 3, maxAgeDays: 30}, mockLogger)

    // #then — keeps 3 most recent, prunes 2 oldest
    expect(result.remainingCount).toBe(3)
    expect(result.prunedCount).toBe(2)
    expect(result.prunedSessionIds).toContain('ses_1')
    expect(result.prunedSessionIds).toContain('ses_2')
  })

  it('keeps recent sessions even if count exceeds maxSessions', async () => {
    // #given
    const {findProjectByWorkspace, listSessionsForProject} = await import('./storage.js')
    const now = Date.now()

    const sessions = [
      createMockSession('ses_1', now - 1 * 24 * 60 * 60 * 1000),
      createMockSession('ses_2', now - 2 * 24 * 60 * 60 * 1000),
      createMockSession('ses_3', now - 3 * 24 * 60 * 60 * 1000),
      createMockSession('ses_4', now - 4 * 24 * 60 * 60 * 1000),
      createMockSession('ses_5', now - 5 * 24 * 60 * 60 * 1000),
    ]

    vi.mocked(findProjectByWorkspace).mockResolvedValue({
      id: 'proj1',
      worktree: '/repo',
      vcs: 'git',
      time: {created: 1000, updated: 2000},
    })
    vi.mocked(listSessionsForProject).mockResolvedValue(sessions)
    const client = createMockSdkClient()

    // #when — maxSessions=2 but all within 30 days
    const result = await pruneSessions(client, '/repo', {maxSessions: 2, maxAgeDays: 30}, mockLogger)

    // #then — all kept because they're within age limit
    expect(result.prunedCount).toBe(0)
    expect(result.remainingCount).toBe(5)
  })

  it('prunes child sessions when parent is pruned', async () => {
    // #given
    const {findProjectByWorkspace, listSessionsForProject, deleteSession} = await import('./storage.js')
    const now = Date.now()
    const oldTime = now - 60 * 24 * 60 * 60 * 1000

    const sessions = [
      createMockSession('ses_parent', oldTime),
      createMockSession('ses_child', oldTime + 1000, 'ses_parent'),
      createMockSession('ses_recent', now - 1000),
    ]

    vi.mocked(findProjectByWorkspace).mockResolvedValue({
      id: 'proj1',
      worktree: '/repo',
      vcs: 'git',
      time: {created: 1000, updated: 2000},
    })
    vi.mocked(listSessionsForProject).mockResolvedValue(sessions)
    vi.mocked(deleteSession).mockResolvedValue(0)
    const client = createMockSdkClient()

    // #when — maxSessions=1, only ses_recent kept
    const result = await pruneSessions(client, '/repo', {maxSessions: 1, maxAgeDays: 30}, mockLogger)

    // #then — both parent and child pruned
    expect(result.prunedSessionIds).toContain('ses_parent')
    expect(result.prunedSessionIds).toContain('ses_child')
    expect(result.prunedCount).toBe(2)
    expect(result.remainingCount).toBe(1)
  })

  it('handles SDK delete failure gracefully', async () => {
    // #given
    const {findProjectByWorkspace, listSessionsForProject, deleteSession} = await import('./storage.js')
    const now = Date.now()
    const oldTime = now - 60 * 24 * 60 * 60 * 1000

    const sessions = [createMockSession('ses_old', oldTime), createMockSession('ses_recent', now - 1000)]

    vi.mocked(findProjectByWorkspace).mockResolvedValue({
      id: 'proj1',
      worktree: '/repo',
      vcs: 'git',
      time: {created: 1000, updated: 2000},
    })
    vi.mocked(listSessionsForProject).mockResolvedValue(sessions)
    vi.mocked(deleteSession).mockRejectedValue(new Error('SDK delete failed'))
    const client = createMockSdkClient()

    // #when
    const result = await pruneSessions(client, '/repo', {maxSessions: 1, maxAgeDays: 30}, mockLogger)

    // #then — failure caught, logged, not thrown
    expect(result.freedBytes).toBe(0)
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Failed to prune session',
      expect.objectContaining({sessionId: 'ses_old'}),
    )
  })

  it('returns zero freedBytes from SDK deletes', async () => {
    // #given
    const {findProjectByWorkspace, listSessionsForProject, deleteSession} = await import('./storage.js')
    const now = Date.now()
    const oldTime = now - 60 * 24 * 60 * 60 * 1000

    const sessions = [createMockSession('ses_old', oldTime), createMockSession('ses_recent', now - 1000)]

    vi.mocked(findProjectByWorkspace).mockResolvedValue({
      id: 'proj1',
      worktree: '/repo',
      vcs: 'git',
      time: {created: 1000, updated: 2000},
    })
    vi.mocked(listSessionsForProject).mockResolvedValue(sessions)
    vi.mocked(deleteSession).mockResolvedValue(0)
    const client = createMockSdkClient()

    // #when
    const result = await pruneSessions(client, '/repo', {maxSessions: 1, maxAgeDays: 30}, mockLogger)

    // #then — SDK always returns 0 bytes
    expect(result.freedBytes).toBe(0)
    expect(result.prunedCount).toBe(1)
  })
})
