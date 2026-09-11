import type {Project} from '@opencode-ai/sdk'

import type {SessionClient} from './backend.js'
import type {Logger, SessionInfo} from './types.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {DEFAULT_PRUNING_CONFIG, pruneSessions} from './prune.js'

// Deliberately no `vi.mock('./discovery.js')` here — these tests exercise the real
// `listProjectsViaSDK` / `findProjectByWorkspace` implementations against a real-shaped SDK
// `project.list()` response, so the end-to-end path from SDK response through project discovery
// into pruning is covered at least once, not just the pruning math with discovery mocked past.
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

function createMockSdkClient(projectListResponse: {data?: unknown; error?: unknown}) {
  return {
    session: {
      list: vi.fn().mockResolvedValue({data: []}),
      get: vi.fn().mockResolvedValue({data: null}),
      messages: vi.fn().mockResolvedValue({data: []}),
      todos: vi.fn().mockResolvedValue({data: []}),
      delete: vi.fn().mockResolvedValue({data: null}),
    },
    project: {
      list: vi.fn().mockResolvedValue(projectListResponse),
    },
  } as unknown as SessionClient
}

describe('pruneSessions (real discovery path)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
  })

  it('finds the project via real discovery and prunes sessions beyond maxSessions', async () => {
    // #given
    const {listSessionsForProject, deleteSession} = await import('./storage.js')
    const now = Date.now()
    const oldTime = now - 60 * 24 * 60 * 60 * 1000

    const sessions = [createMockSession('ses_old', oldTime), createMockSession('ses_recent', now - 1000)]
    vi.mocked(listSessionsForProject).mockResolvedValue(sessions)
    vi.mocked(deleteSession).mockResolvedValue(undefined)

    // Real SDK v1 `Project` shape (`@opencode-ai/sdk`'s root-exported type, dist/gen/types.gen.d.ts):
    // id, worktree, optional vcs, required `time.created`. No `path`, no `time.updated`.
    const projects: Project[] = [{id: 'proj1', worktree: '/repo', vcs: 'git', time: {created: 1000}}]
    const client = createMockSdkClient({data: projects})

    // #when
    const result = await pruneSessions(client, '/repo', {maxSessions: 1, maxAgeDays: 30}, mockLogger)

    // #then: pins the routing query end-to-end — not just at the listProjectsViaSDK unit level
    expect(client.project.list).toHaveBeenCalledWith({query: {directory: '/repo'}})
    expect(result.prunedCount).toBe(1)
    expect(result.prunedSessionIds).toContain('ses_old')
    expect(result.remainingCount).toBe(1)
  })

  it('returns zeros when real discovery finds no matching project', async () => {
    // #given
    const projects: Project[] = [{id: 'proj1', worktree: '/other-repo', time: {created: 1000}}]
    const client = createMockSdkClient({data: projects})

    // #when
    const result = await pruneSessions(client, '/repo', DEFAULT_PRUNING_CONFIG, mockLogger)

    // #then
    expect(result.prunedCount).toBe(0)
    expect(result.remainingCount).toBe(0)
  })

  it("returns zeros when real discovery's project.list() call returns an error", async () => {
    // #given
    const client = createMockSdkClient({error: 'boom', data: null})

    // #when
    const result = await pruneSessions(client, '/repo', DEFAULT_PRUNING_CONFIG, mockLogger)

    // #then
    expect(result.prunedCount).toBe(0)
    expect(result.remainingCount).toBe(0)
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK project list failed', expect.any(Object))
  })
})
