import type {OpenCodeServerHandle} from '../../features/agent/index.js'
import type {Logger} from '../../shared/logger.js'
import type {ActionInputs, CacheResult} from '../../shared/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import * as path from 'node:path'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMetricsCollector} from '../../features/observability/index.js'
import {DB_MAIN_BASENAME, DB_WAL_BASENAME} from '../../services/cache/paths.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {ok} from '../../shared/types.js'

const mocks = vi.hoisted(() => ({
  buildCacheKeyComponents: vi.fn(),
  restoreCache: vi.fn(),
  checkpointDatabase: vi.fn(),
  ensureProjectId: vi.fn(),
  bootstrapOpenCodeServer: vi.fn(),
  getGitHubWorkspace: vi.fn(),
  getOpenCodeAuthPath: vi.fn(),
  getOpenCodeStoragePath: vi.fn(),
  loggerDebug: vi.fn<Logger['debug']>(),
  loggerInfo: vi.fn<Logger['info']>(),
  loggerWarning: vi.fn<Logger['warning']>(),
  loggerError: vi.fn<Logger['error']>(),
}))

vi.mock('../../features/agent/index.js', () => ({
  bootstrapOpenCodeServer: mocks.bootstrapOpenCodeServer,
}))

vi.mock('../../services/cache/index.js', () => ({
  buildCacheKeyComponents: mocks.buildCacheKeyComponents,
  restoreCache: mocks.restoreCache,
  checkpointDatabase: mocks.checkpointDatabase,
}))

vi.mock('../../services/setup/project-id.js', () => ({
  ensureProjectId: mocks.ensureProjectId,
}))

vi.mock('../../shared/env.js', () => ({
  getGitHubWorkspace: mocks.getGitHubWorkspace,
  getOpenCodeAuthPath: mocks.getOpenCodeAuthPath,
  getOpenCodeStoragePath: mocks.getOpenCodeStoragePath,
}))

// Both cacheLogger and serverLogger in runCacheRestore come from createLogger, so a single
// shared stub is enough to assert on the repair log call regardless of which phase name
// was passed — the test only cares about what was logged, not the phase label.
vi.mock('../../shared/logger.js', () => ({
  createLogger: () => ({
    debug: mocks.loggerDebug,
    info: mocks.loggerInfo,
    warning: mocks.loggerWarning,
    error: mocks.loggerError,
  }),
}))

const testStoragePath = '/xdg/opencode/storage'
const testDbDir = path.dirname(testStoragePath)
const expectedDbPath = path.join(testDbDir, DB_MAIN_BASENAME)
const expectedWalPath = path.join(testDbDir, DB_WAL_BASENAME)

const stubServerHandle = {
  client: {} as unknown as OpenCodeServerHandle['client'],
  server: {url: 'http://localhost:0', close: vi.fn()},
  shutdown: vi.fn(),
} satisfies OpenCodeServerHandle

function createActionInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    githubToken: 'ghp_test',
    authJson: '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
    trustedHeadSha: '',
    prompt: null,
    sessionRetention: 50,
    opencodeVersion: '1.0.0',
    outputMode: 'branch-pr',
    agent: null,
    model: null,
    timeoutMs: 600_000,
    serverBootstrapTimeoutMs: 5000,
    enableOmo: false,
    skipCache: false,
    omoVersion: '1.0.0',
    systematicVersion: '1.0.0',
    omoProviders: {
      claude: 'no',
      copilot: 'no',
      gemini: 'no',
      openai: 'no',
      opencodeZen: 'no',
      zaiCodingPlan: 'no',
      kimiForCoding: 'no',
    },
    opencodeConfig: null,
    systematicConfig: null,
    enableOmoSlim: false,
    omoSlimPreset: 'openai',
    dedupWindow: 0,
    responseMode: 'github',
    reviewSkipLabel: null,
    brokeredPushExtraPaths: [],
    storeConfig: {
      enabled: false,
      bucket: '',
      region: '',
      prefix: 'fro-bot-state',
    },
    ...overrides,
  }
}

function createBootstrapPhaseResult(overrides: Partial<BootstrapPhaseResult> = {}): BootstrapPhaseResult {
  return {
    inputs: createActionInputs(),
    logger: createMockLogger(),
    opencodeResult: {path: '/usr/local/bin/opencode', version: '1.0.0', didSetup: false},
    delivery: 'model-gh',
    responseFilePath: null,
    responseFilePathCandidates: null,
    trustedHeadSha: '',
    ...overrides,
  }
}

function createCacheResult(overrides: Partial<CacheResult> = {}): CacheResult {
  return {
    hit: true,
    key: 'test-key',
    restoredPath: testStoragePath,
    corrupted: false,
    source: 'cache',
    ...overrides,
  }
}

describe('runCacheRestore database repair', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildCacheKeyComponents.mockReturnValue({
      agentIdentity: 'github',
      repo: 'owner/repo',
      ref: 'main',
      os: 'Linux',
    })
    mocks.getGitHubWorkspace.mockReturnValue('/workspace')
    mocks.getOpenCodeAuthPath.mockReturnValue('/xdg/opencode/auth.json')
    mocks.getOpenCodeStoragePath.mockReturnValue(testStoragePath)
    mocks.ensureProjectId.mockResolvedValue({projectId: 'a'.repeat(40), source: 'cached'})
    mocks.bootstrapOpenCodeServer.mockResolvedValue(ok(stubServerHandle))
  })

  it('checkpoints a restored database with a populated write-ahead log before bootstrap, and logs the repair', async () => {
    // #given a cache hit whose write-ahead log holds data
    mocks.restoreCache.mockResolvedValue(createCacheResult({hit: true, corrupted: false, source: 'cache'}))
    mocks.checkpointDatabase.mockResolvedValue({status: 'checkpointed'})
    const {runCacheRestore} = await import('./cache-restore.js')

    // #when the cache-restore phase runs
    const result = await runCacheRestore(createBootstrapPhaseResult(), createMetricsCollector())

    // #then the restored database is checkpointed against the canonical DB-family paths
    // and the healed repository is logged at info level
    expect(result).not.toBeNull()
    expect(mocks.checkpointDatabase).toHaveBeenCalledWith({
      dbPath: expectedDbPath,
      walPath: expectedWalPath,
      logger: expect.anything() as unknown,
    })
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      'Repaired restored database: checkpointed write-ahead log before bootstrap',
    )
    expect(mocks.bootstrapOpenCodeServer).toHaveBeenCalled()
  })

  it('leaves an already-clean database alone and logs nothing about repair', async () => {
    // #given a cache hit whose write-ahead log was already empty (the common healthy-run case)
    mocks.restoreCache.mockResolvedValue(createCacheResult({hit: true, corrupted: false, source: 'cache'}))
    mocks.checkpointDatabase.mockResolvedValue({status: 'nothing-to-checkpoint'})
    const {runCacheRestore} = await import('./cache-restore.js')

    // #when the cache-restore phase runs
    const result = await runCacheRestore(createBootstrapPhaseResult(), createMetricsCollector())

    // #then checkpointDatabase was still consulted (there was a restored database to check)
    // but nothing was logged about repair — the healthy path must stay silent
    expect(result).not.toBeNull()
    expect(mocks.checkpointDatabase).toHaveBeenCalledWith({
      dbPath: expectedDbPath,
      walPath: expectedWalPath,
      logger: expect.anything() as unknown,
    })
    expect(mocks.loggerWarning).not.toHaveBeenCalled()
    const infoMessages = mocks.loggerInfo.mock.calls.map(call => call[0])
    expect(infoMessages).not.toContain('Repaired restored database: checkpointed write-ahead log before bootstrap')
  })

  it('performs no repair on a cache miss', async () => {
    // #given a cache miss — there is no restored database on disk to repair
    mocks.restoreCache.mockResolvedValue(
      createCacheResult({hit: false, corrupted: false, key: null, restoredPath: null, source: null}),
    )
    const {runCacheRestore} = await import('./cache-restore.js')

    // #when the cache-restore phase runs
    const result = await runCacheRestore(createBootstrapPhaseResult(), createMetricsCollector())

    // #then checkpointDatabase is never consulted, and bootstrap still proceeds
    expect(result).not.toBeNull()
    expect(mocks.checkpointDatabase).not.toHaveBeenCalled()
    expect(mocks.bootstrapOpenCodeServer).toHaveBeenCalled()
  })

  it('does not fail the run when repair fails — bootstrap is still attempted', async () => {
    // #given a cache hit whose write-ahead log could not be merged (e.g. a live writer)
    mocks.restoreCache.mockResolvedValue(createCacheResult({hit: true, corrupted: false, source: 'cache'}))
    mocks.checkpointDatabase.mockResolvedValue({status: 'failed', reason: 'database is locked'})
    const {runCacheRestore} = await import('./cache-restore.js')

    // #when the cache-restore phase runs
    const result = await runCacheRestore(createBootstrapPhaseResult(), createMetricsCollector())

    // #then the failure is logged as a warning, the run is not failed, and bootstrap proceeds
    expect(result).not.toBeNull()
    expect(mocks.loggerWarning).toHaveBeenCalledWith('Failed to repair restored database before bootstrap', {
      reason: 'database is locked',
    })
    expect(mocks.bootstrapOpenCodeServer).toHaveBeenCalled()
  })

  it('repairs the database after restore completes and before bootstrapOpenCodeServer is called', async () => {
    // #given mocks that each record their invocation order
    const order: string[] = []
    mocks.restoreCache.mockImplementation(async () => {
      order.push('restoreCache')
      return createCacheResult({hit: true, corrupted: false, source: 'cache'})
    })
    mocks.checkpointDatabase.mockImplementation(async () => {
      order.push('checkpointDatabase')
      return {status: 'nothing-to-checkpoint'}
    })
    mocks.bootstrapOpenCodeServer.mockImplementation(async () => {
      order.push('bootstrapOpenCodeServer')
      return ok(stubServerHandle)
    })
    const {runCacheRestore} = await import('./cache-restore.js')

    // #when the cache-restore phase runs
    await runCacheRestore(createBootstrapPhaseResult(), createMetricsCollector())

    // #then the repair happens strictly between restore and bootstrap — an ordering
    // regression here would silently move the checkpoint cost back inside the bootstrap
    // budget it was moved out of
    expect(order).toEqual(['restoreCache', 'checkpointDatabase', 'bootstrapOpenCodeServer'])
  })
})
