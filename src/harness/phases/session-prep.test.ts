import type {SessionSearchResult, SessionSummary} from '@fro-bot/runtime'
import type {OpenCodeServerHandle} from '../../features/agent/index.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {CacheResult} from '../../shared/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {RoutingPhaseResult} from './routing.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {runSessionPrep} from './session-prep.js'

const mocks = vi.hoisted(() => ({
  buildLogicalKey: vi.fn(),
  buildSessionTitle: vi.fn(),
  listSessions: vi.fn(),
  resolveSessionForLogicalKey: vi.fn(),
  searchSessions: vi.fn(),
  parseAttachmentUrls: vi.fn(),
  createLogger: vi.fn(),
  getGitHubWorkspace: vi.fn(),
  normalizeWorkspacePath: vi.fn(),
}))

vi.mock('@fro-bot/runtime', () => ({
  buildLogicalKey: mocks.buildLogicalKey,
  buildSessionTitle: mocks.buildSessionTitle,
  listSessions: mocks.listSessions,
  resolveSessionForLogicalKey: mocks.resolveSessionForLogicalKey,
  searchSessions: mocks.searchSessions,
}))

vi.mock('../../features/attachments/index.js', () => ({
  buildAttachmentResult: vi.fn(),
  downloadAttachments: vi.fn(),
  parseAttachmentUrls: mocks.parseAttachmentUrls,
  validateAttachments: vi.fn(),
}))

vi.mock('../../shared/env.js', () => ({getGitHubWorkspace: mocks.getGitHubWorkspace}))
vi.mock('../../shared/paths.js', () => ({normalizeWorkspacePath: mocks.normalizeWorkspacePath}))
vi.mock('../../shared/logger.js', () => ({createLogger: mocks.createLogger}))

const logicalKey = {key: 'issue-42', entityType: 'issue' as const, entityId: '42'}
const recentSessions: readonly SessionSummary[] = [
  {
    id: 'session-recent',
    projectID: 'project',
    directory: '/workspace',
    title: 'Recent work',
    createdAt: 1,
    updatedAt: 2,
    messageCount: 3,
    agents: ['build'],
    isChild: false,
  },
]
const priorWorkContext: readonly SessionSearchResult[] = [
  {
    sessionId: 'session-prior',
    matches: [],
  },
]

function createBootstrap(): BootstrapPhaseResult {
  return {inputs: {githubToken: 'token'}} as BootstrapPhaseResult
}

function createRouting(): RoutingPhaseResult {
  return {
    triggerResult: {context: {}} as RoutingPhaseResult['triggerResult'],
    agentContext: {
      issueTitle: 'Issue title',
      repo: 'owner/repo',
      commentBody: null,
    },
  } as RoutingPhaseResult
}

function createCacheRestore(): CacheRestorePhaseResult {
  return {
    cacheResult: {
      hit: false,
      key: null,
      restoredPath: null,
      corrupted: false,
      source: null,
    } satisfies CacheResult,
    cacheStatus: 'miss',
    serverHandle: {
      client: {} as unknown as OpenCodeServerHandle['client'],
      server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
      shutdown: vi.fn(),
    },
  }
}

function createMetrics(): MetricsCollector {
  return {
    start: vi.fn(),
    end: vi.fn(),
    setCacheStatus: vi.fn(),
    setCacheSource: vi.fn(),
    addSessionUsed: vi.fn(),
    addSessionCreated: vi.fn(),
    addPRCreated: vi.fn(),
    addCommitCreated: vi.fn(),
    incrementComments: vi.fn(),
    setTokenUsage: vi.fn(),
    recordError: vi.fn(),
    getMetrics: vi.fn(),
  }
}

function createTreatmentStrategy() {
  return async () => ({recentSessions: [], priorWorkContext: []})
}

describe('runSessionPrep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createLogger.mockReturnValue({debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()})
    mocks.getGitHubWorkspace.mockReturnValue('/workspace')
    mocks.normalizeWorkspacePath.mockImplementation((value: string) => value)
    mocks.parseAttachmentUrls.mockReturnValue([])
    mocks.buildLogicalKey.mockReturnValue(logicalKey)
    mocks.buildSessionTitle.mockReturnValue('fro-bot: issue-42')
    mocks.listSessions.mockResolvedValue(recentSessions)
    mocks.resolveSessionForLogicalKey.mockResolvedValue({
      status: 'found',
      session: {id: 'session-continuation'},
    })
    mocks.searchSessions.mockResolvedValue(priorWorkContext)
  })

  it('keeps the production default eager context behavior', async () => {
    // #given the current eager session context sources return recent and prior-work data
    // #when session preparation uses its default strategy
    const result = await runSessionPrep(createBootstrap(), createRouting(), createCacheRestore(), createMetrics())

    // #then both injected context collections and continuity remain available
    expect(result.recentSessions).toEqual(recentSessions)
    expect(result.priorWorkContext).toEqual(priorWorkContext)
    expect(result.logicalKey).toEqual(logicalKey)
    expect(result.continueSessionId).toBe('session-continuation')
    expect(result.isContinuation).toBe(true)
  })

  it('allows the eval treatment to omit only eager injected context', async () => {
    // #given an eval-only strategy that supplies no eager recent or prior-work context
    // #when session preparation runs with the injected treatment
    const result = await runSessionPrep(
      createBootstrap(),
      createRouting(),
      createCacheRestore(),
      createMetrics(),
      createTreatmentStrategy(),
    )

    // #then logical identity and continuation selection are unchanged while injected context is empty
    expect(result.recentSessions).toEqual([])
    expect(result.priorWorkContext).toEqual([])
    expect(result.logicalKey).toEqual(logicalKey)
    expect(result.continueSessionId).toBe('session-continuation')
    expect(result.isContinuation).toBe(true)
  })

  it.each([false, true])('does not invent continuity when no logical key exists (treatment=%s)', async treatment => {
    // #given an event that has no logical session identity
    mocks.buildLogicalKey.mockReturnValue(null)

    // #when session preparation runs in either mode
    const result = await runSessionPrep(
      createBootstrap(),
      createRouting(),
      createCacheRestore(),
      createMetrics(),
      treatment ? createTreatmentStrategy() : undefined,
    )

    // #then no continuation identity is fabricated
    expect(result.logicalKey).toBeNull()
    expect(result.continueSessionId).toBeNull()
    expect(result.isContinuation).toBe(false)
  })

  it('keeps eager lookup failures fail-soft while preserving continuity data', async () => {
    // #given eager context lookups reject while logical-key resolution still finds the continuation
    mocks.listSessions.mockRejectedValue(new Error('list unavailable'))
    mocks.searchSessions.mockRejectedValue(new Error('search unavailable'))

    // #when the production default preparation runs
    const result = await runSessionPrep(createBootstrap(), createRouting(), createCacheRestore(), createMetrics())

    // #then the candidate can proceed with empty injected context and the existing continuation
    expect(result.recentSessions).toEqual([])
    expect(result.priorWorkContext).toEqual([])
    expect(result.continueSessionId).toBe('session-continuation')
    expect(result.isContinuation).toBe(true)
  })
})
