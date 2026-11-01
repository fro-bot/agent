/**
 * Session prep on an OpenCode V2 run: continuity and prior-work context come from the V2 server's own routes, never from
 * the V1 SDK client (a V2 handle has none). The V1 tests live in `session-prep.test.ts`, unedited.
 */
import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestoreV2PhaseResult} from './cache-restore.js'
import type {RoutingPhaseResult} from './routing.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {runSessionPrep} from './session-prep.js'

const mocks = vi.hoisted(() => ({
  parseAttachmentUrls: vi.fn(() => []),
  listSessions: vi.fn(),
  resolveSessionForLogicalKey: vi.fn(),
  searchSessions: vi.fn(),
  logger: {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()},
}))

vi.mock('@fro-bot/runtime', async importOriginal => {
  const original: typeof import('@fro-bot/runtime') = await importOriginal()
  return {
    ...original,
    buildLogicalKey: vi.fn(() => ({key: 'issue-42', entityType: 'issue', entityId: '42'})),
    listSessions: mocks.listSessions,
    resolveSessionForLogicalKey: mocks.resolveSessionForLogicalKey,
    searchSessions: mocks.searchSessions,
  }
})
vi.mock('../../features/attachments/index.js', () => ({
  buildAttachmentResult: vi.fn(),
  downloadAttachments: vi.fn(),
  parseAttachmentUrls: mocks.parseAttachmentUrls,
  validateAttachments: vi.fn(),
}))
vi.mock('../../shared/env.js', () => ({
  getGitHubWorkspace: () => '/workspace/repo',
  getInvocationIdentity: () => 'fro-bot-observe',
}))
vi.mock('../../shared/paths.js', () => ({normalizeWorkspacePath: (value: string) => value}))
vi.mock('../../shared/logger.js', () => ({createLogger: () => mocks.logger}))

function session(id: string, title: string, updated: number) {
  return {id, projectID: 'prj', title, time: {created: 1, updated}, location: {directory: '/workspace/repo'}}
}

function cacheRestore(sessions: readonly unknown[], listStatus = 200): CacheRestoreV2PhaseResult {
  const fetchRoute = vi.fn(async (path: string) => {
    if (path.startsWith('/api/session?')) {
      return new Response(JSON.stringify({data: sessions, cursor: {}}), {status: listStatus})
    }
    return new Response(JSON.stringify({data: []}), {status: 200})
  })
  return {
    generation: 'v2',
    cacheResult: {hit: false, key: null, restoredPath: null, corrupted: false, source: null},
    cacheStatus: 'miss',
    serverHandle: {
      url: 'http://127.0.0.1:1',
      directory: '/workspace/repo',
      fetch: fetchRoute,
    } as unknown as OpenCodeV2ServerHandle,
  }
}

const bootstrap = {inputs: {githubToken: 'token'}} as BootstrapPhaseResult
const routing = {
  triggerResult: {context: {}},
  agentContext: {issueTitle: 'Issue title', repo: 'owner/repo', commentBody: null},
} as unknown as RoutingPhaseResult
const metrics = {addSessionUsed: vi.fn()} as unknown as MetricsCollector

describe('runSessionPrep on an OpenCode V2 server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('continues the session whose V2 title is the logical key, reading through the V2 routes only', async () => {
    // #given a restored database that holds the thread's session
    const restore = cacheRestore([session('ses_thread', 'fro-bot: issue-42', 9), session('ses_other', 'other', 8)])

    // #when
    const result = await runSessionPrep(bootstrap, routing, restore, metrics)

    // #then
    expect(result).toMatchObject({
      continueSessionId: 'ses_thread',
      isContinuation: true,
      sessionTitle: 'fro-bot: issue-42',
    })
    expect(mocks.resolveSessionForLogicalKey).not.toHaveBeenCalled()
    expect(mocks.listSessions).not.toHaveBeenCalled()
    expect(mocks.searchSessions).not.toHaveBeenCalled()
    expect(result.recentSessions.map(item => item.id)).toEqual(['ses_thread', 'ses_other'])
  })

  it('starts a new session, with a warning, when the V2 listing fails', async () => {
    // #given
    const restore = cacheRestore([], 500)

    // #when
    const result = await runSessionPrep(bootstrap, routing, restore, metrics)

    // #then
    expect(result).toMatchObject({continueSessionId: null, isContinuation: false})
    expect(mocks.logger.warning).toHaveBeenCalledWith(
      'Session continuity: lookup error, will create new',
      expect.objectContaining({logicalKey: 'issue-42'}),
    )
  })
})
