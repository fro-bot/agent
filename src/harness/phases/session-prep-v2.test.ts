/**
 * Session prep: continuity and prior-work context come from the V2 server's own routes.
 */
import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {RoutingPhaseResult} from './routing.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {runSessionPrep} from './session-prep.js'

const mocks = vi.hoisted(() => ({
  parseAttachmentUrls: vi.fn(() => []),
  buildLogicalKey: vi.fn(),
  logger: {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()},
}))

vi.mock('@fro-bot/runtime', async importOriginal => {
  const original: typeof import('@fro-bot/runtime') = await importOriginal()
  return {
    ...original,
    buildLogicalKey: mocks.buildLogicalKey,
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

function cacheRestore(sessions: readonly unknown[], listStatus = 200): CacheRestorePhaseResult {
  const fetchRoute = vi.fn(async (path: string) => {
    if (path.startsWith('/api/session?')) {
      return new Response(JSON.stringify({data: sessions, cursor: {}}), {status: listStatus})
    }
    return new Response(JSON.stringify({data: []}), {status: 200})
  })
  return {
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

describe('runSessionPrep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildLogicalKey.mockReturnValue({key: 'issue-42', entityType: 'issue', entityId: '42'})
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

  it("resolves the logical key with the running job's invocation identity", async () => {
    // #given the Observe job of a run is preparing its session
    const restore = cacheRestore([])

    // #when session preparation builds the logical key
    await runSessionPrep(bootstrap, routing, restore, metrics)

    // #then run-scoped (schedule/dispatch) keys are qualified by the job, so Observe cannot continue Remediate's root
    // session
    expect(mocks.buildLogicalKey).toHaveBeenCalledWith(routing.triggerResult.context, 'fro-bot-observe')
  })

  it('does not invent continuity when no logical key exists', async () => {
    // #given an event that has no logical session identity
    mocks.buildLogicalKey.mockReturnValue(null)
    const restore = cacheRestore([session('ses_thread', 'fro-bot: issue-42', 9)])

    // #when session preparation runs
    const result = await runSessionPrep(bootstrap, routing, restore, metrics)

    // #then no continuation identity is fabricated
    expect(result).toMatchObject({logicalKey: null, continueSessionId: null, isContinuation: false, sessionTitle: null})
  })
})
