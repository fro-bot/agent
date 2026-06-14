import type {SessionClient} from './backend.js'
import type {Logger, SessionInfo} from './types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {DEFAULT_PRUNING_CONFIG, pruneSessions} from './prune.js'

vi.mock('./discovery.js')
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
    const {findProjectByWorkspace} = await import('./discovery.js')
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
    const {findProjectByWorkspace} = await import('./discovery.js')
    const {listSessionsForProject} = await import('./storage.js')
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
    const {findProjectByWorkspace} = await import('./discovery.js')
    const {listSessionsForProject} = await import('./storage.js')
    const {deleteSession} = await import('./storage.js')
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
    vi.mocked(deleteSession).mockResolvedValue(undefined)
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
    const {findProjectByWorkspace} = await import('./discovery.js')
    const {listSessionsForProject} = await import('./storage.js')
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
    const {findProjectByWorkspace} = await import('./discovery.js')
    const {listSessionsForProject} = await import('./storage.js')
    const {deleteSession} = await import('./storage.js')
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
    vi.mocked(deleteSession).mockResolvedValue(undefined)
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
    const {findProjectByWorkspace} = await import('./discovery.js')
    const {listSessionsForProject} = await import('./storage.js')
    const {deleteSession} = await import('./storage.js')
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

  it('force-expires a legacy aggregate schedule session older than maxAgeDays even when within count-floor', async () => {
    // #given — legacy session title matches /^fro-bot: schedule-[0-9a-f]{8}$/ (no runId suffix)
    const {findProjectByWorkspace} = await import('./discovery.js')
    const {listSessionsForProject} = await import('./storage.js')
    const {deleteSession} = await import('./storage.js')
    const now = Date.now()
    const oldTime = now - 60 * 24 * 60 * 60 * 1000 // 60 days ago, beyond maxAgeDays=30

    const legacyScheduleSession: SessionInfo = {
      id: 'ses_legacy_schedule',
      version: '1.0.0',
      projectID: 'proj1',
      directory: '/path/to/repo',
      title: 'fro-bot: schedule-abc12345',
      time: {created: oldTime - 1000, updated: oldTime},
    }
    // Fill count-floor with recent sessions so the legacy one would normally survive via count-floor
    const recentSessions = Array.from({length: 3}, (_, i) => createMockSession(`ses_recent_${i}`, now - i * 1000))

    vi.mocked(findProjectByWorkspace).mockResolvedValue({
      id: 'proj1',
      worktree: '/repo',
      vcs: 'git',
      time: {created: 1000, updated: 2000},
    })
    vi.mocked(listSessionsForProject).mockResolvedValue([legacyScheduleSession, ...recentSessions])
    vi.mocked(deleteSession).mockResolvedValue(undefined)
    const client = createMockSdkClient()

    // #when — maxSessions=4 keeps all 4 via count-floor, but legacy should be force-expired
    const result = await pruneSessions(client, '/repo', {maxSessions: 4, maxAgeDays: 30}, mockLogger)

    // #then — legacy aggregate pruned despite count-floor
    expect(result.prunedSessionIds).toContain('ses_legacy_schedule')
    expect(result.prunedCount).toBeGreaterThanOrEqual(1)
  })

  it('does NOT force-expire a legacy schedule session still within maxAgeDays', async () => {
    // #given — legacy session title matches pattern but is recent
    const {findProjectByWorkspace} = await import('./discovery.js')
    const {listSessionsForProject} = await import('./storage.js')
    const now = Date.now()
    const recentTime = now - 5 * 24 * 60 * 60 * 1000 // 5 days ago, within maxAgeDays=30

    const legacyScheduleSession: SessionInfo = {
      id: 'ses_legacy_recent',
      version: '1.0.0',
      projectID: 'proj1',
      directory: '/path/to/repo',
      title: 'fro-bot: schedule-abc12345',
      time: {created: recentTime - 1000, updated: recentTime},
    }

    vi.mocked(findProjectByWorkspace).mockResolvedValue({
      id: 'proj1',
      worktree: '/repo',
      vcs: 'git',
      time: {created: 1000, updated: 2000},
    })
    vi.mocked(listSessionsForProject).mockResolvedValue([legacyScheduleSession])
    const client = createMockSdkClient()

    // #when
    const result = await pruneSessions(client, '/repo', {maxSessions: 50, maxAgeDays: 30}, mockLogger)

    // #then — within maxAgeDays, not force-expired
    expect(result.prunedSessionIds).not.toContain('ses_legacy_recent')
    expect(result.prunedCount).toBe(0)
  })

  it('does NOT force-expire a new run-scoped schedule session (title has -<digits> suffix)', async () => {
    // #given — run-scoped title does NOT match /^fro-bot: schedule-[0-9a-f]{8}$/ (has trailing -digits)
    const {findProjectByWorkspace} = await import('./discovery.js')
    const {listSessionsForProject} = await import('./storage.js')
    const now = Date.now()
    const oldTime = now - 60 * 24 * 60 * 60 * 1000

    const runScopedSession: SessionInfo = {
      id: 'ses_run_scoped',
      version: '1.0.0',
      projectID: 'proj1',
      directory: '/path/to/repo',
      title: 'fro-bot: schedule-abc12345-67890',
      time: {created: oldTime - 1000, updated: oldTime},
    }
    const recentSessions = Array.from({length: 3}, (_, i) => createMockSession(`ses_recent_${i}`, now - i * 1000))

    vi.mocked(findProjectByWorkspace).mockResolvedValue({
      id: 'proj1',
      worktree: '/repo',
      vcs: 'git',
      time: {created: 1000, updated: 2000},
    })
    vi.mocked(listSessionsForProject).mockResolvedValue([runScopedSession, ...recentSessions])
    const client = createMockSdkClient()

    // #when — maxSessions=4 keeps all 4 via count-floor; run-scoped should NOT be force-expired
    const result = await pruneSessions(client, '/repo', {maxSessions: 4, maxAgeDays: 30}, mockLogger)

    // #then — run-scoped session protected by normal count-floor rules
    expect(result.prunedSessionIds).not.toContain('ses_run_scoped')
  })

  it('does NOT force-expire a normal non-schedule session within count-floor', async () => {
    // #given
    const {findProjectByWorkspace} = await import('./discovery.js')
    const {listSessionsForProject} = await import('./storage.js')
    const now = Date.now()
    const oldTime = now - 60 * 24 * 60 * 60 * 1000

    const normalSession: SessionInfo = {
      id: 'ses_normal',
      version: '1.0.0',
      projectID: 'proj1',
      directory: '/path/to/repo',
      title: 'fro-bot: pr-42',
      time: {created: oldTime - 1000, updated: oldTime},
    }
    const recentSessions = Array.from({length: 2}, (_, i) => createMockSession(`ses_recent_${i}`, now - i * 1000))

    vi.mocked(findProjectByWorkspace).mockResolvedValue({
      id: 'proj1',
      worktree: '/repo',
      vcs: 'git',
      time: {created: 1000, updated: 2000},
    })
    vi.mocked(listSessionsForProject).mockResolvedValue([normalSession, ...recentSessions])
    const client = createMockSdkClient()

    // #when — maxSessions=3 keeps all 3 via count-floor
    const result = await pruneSessions(client, '/repo', {maxSessions: 3, maxAgeDays: 30}, mockLogger)

    // #then — normal session unaffected by legacy schedule cleanup
    expect(result.prunedSessionIds).not.toContain('ses_normal')
    expect(result.prunedCount).toBe(0)
  })

  it('returns zero freedBytes from SDK deletes', async () => {
    // #given
    const {findProjectByWorkspace} = await import('./discovery.js')
    const {listSessionsForProject} = await import('./storage.js')
    const {deleteSession} = await import('./storage.js')
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
    vi.mocked(deleteSession).mockResolvedValue(undefined)
    const client = createMockSdkClient()

    // #when
    const result = await pruneSessions(client, '/repo', {maxSessions: 1, maxAgeDays: 30}, mockLogger)

    // #then — SDK always returns 0 bytes
    expect(result.freedBytes).toBe(0)
    expect(result.prunedCount).toBe(1)
  })
})
