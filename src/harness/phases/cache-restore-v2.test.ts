import type {OpenCodeV2ServerHandle, OpenCodeV2ShutdownResult} from '@fro-bot/runtime'
import type {ActionInputs, CacheResult} from '../../shared/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import * as path from 'node:path'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMetricsCollector} from '../../features/observability/index.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {ok} from '../../shared/types.js'

const mocks = vi.hoisted(() => ({
  restoreCache: vi.fn(),
  checkpointDatabase: vi.fn(),
  cleanStorage: vi.fn(),
  verifyDatabaseUsable: vi.fn(),
  ensureProjectId: vi.fn(),
  bootstrapOpenCodeServer: vi.fn(),
  startActionOpenCodeV2: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
}))

vi.mock('@actions/core', () => ({
  setFailed: mocks.setFailed,
  setSecret: mocks.setSecret,
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('../../features/agent/index.js', () => ({bootstrapOpenCodeServer: mocks.bootstrapOpenCodeServer}))

vi.mock('../../services/cache/index.js', () => ({
  buildCacheKeyComponents: () => ({agentIdentity: 'github', repo: 'owner/repo', ref: 'main', os: 'Linux'}),
  restoreCache: mocks.restoreCache,
  checkpointDatabase: mocks.checkpointDatabase,
  cleanStorage: mocks.cleanStorage,
  verifyDatabaseUsable: mocks.verifyDatabaseUsable,
}))

vi.mock('../../services/setup/project-id.js', () => ({ensureProjectId: mocks.ensureProjectId}))

vi.mock('../../shared/env.js', () => ({
  getGitHubWorkspace: () => '/tmp/../workspace',
  getOpenCodeAuthPath: () => '/xdg/opencode/auth.json',
  getOpenCodeStoragePath: () => '/xdg/opencode/storage',
  getGitHubRunId: () => 777,
  getGitHubRunAttempt: () => 2,
}))

vi.mock('./v2-server.js', () => ({startActionOpenCodeV2: mocks.startActionOpenCodeV2}))

vi.mock('../../shared/logger.js', () => ({
  createLogger: () => ({debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}),
}))

const V2_VERSION = '2.2.5'

function inputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    githubToken: 'ghp_test',
    authJson: '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
    trustedHeadSha: '',
    prompt: null,
    sessionRetention: 50,
    opencodeVersion: V2_VERSION,
    outputMode: 'branch-pr',
    agent: null,
    model: {providerID: 'anthropic', modelID: 'claude-sonnet'},
    timeoutMs: 600_000,
    serverBootstrapTimeoutMs: 5000,
    skipCache: false,
    systematicVersion: 'latest',
    opencodeConfig: '{"share":"disabled"}',
    systematicConfig: null,
    dedupWindow: 0,
    responseMode: 'github',
    reviewSkipLabel: null,
    brokeredPushExtraPaths: [],
    storeConfig: {enabled: false, bucket: '', region: '', prefix: 'fro-bot-state'},
    ...overrides,
  }
}

function bootstrap(version: string, overrides: Partial<ActionInputs> = {}): BootstrapPhaseResult {
  return {
    inputs: inputs(overrides),
    logger: createMockLogger(),
    opencodeResult: {path: '/opt/opencode', version, didSetup: true},
    delivery: 'model-gh',
    responseFilePath: null,
    responseFilePathCandidates: null,
    trustedHeadSha: '',
  }
}

function cacheHit(): CacheResult {
  return {hit: true, key: 'k', restoredPath: '/xdg/opencode/storage', corrupted: false, source: 'cache'}
}

function v2Handle(): {handle: OpenCodeV2ServerHandle; shutdown: ReturnType<typeof vi.fn>} {
  const shutdown = vi.fn(async (): Promise<OpenCodeV2ShutdownResult> => ({
    interrupts: {stopped: [], notRunning: [], unconfirmed: []},
    exit: {outcome: 'graceful', code: 0, signal: null},
  }))
  return {
    shutdown,
    handle: {
      url: 'http://127.0.0.1:1',
      pid: 1,
      directory: '/workspace',
      fetch: vi.fn(),
      authorizationHeader: () => 'Basic x',
      exited: new Promise(() => undefined),
      registerOwnedSession: () => undefined,
      shutdown,
    },
  }
}

describe('runCacheRestore on OpenCode V2', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.restoreCache.mockResolvedValue(cacheHit())
    mocks.checkpointDatabase.mockResolvedValue({status: 'nothing-to-checkpoint'})
    mocks.verifyDatabaseUsable.mockResolvedValue({usable: true})
    mocks.ensureProjectId.mockResolvedValue({projectId: 'a'.repeat(40), source: 'cached'})
    mocks.bootstrapOpenCodeServer.mockResolvedValue(ok({}))
  })

  it('starts the V2 server with the run, restore and credential facts and never the V1 bootstrap', async () => {
    // #given
    const {handle} = v2Handle()
    mocks.startActionOpenCodeV2.mockResolvedValue({success: true, data: handle})
    const {runCacheRestore} = await import('./cache-restore.js')

    // #when
    await runCacheRestore(bootstrap(V2_VERSION), createMetricsCollector())

    // #then
    expect(mocks.bootstrapOpenCodeServer).not.toHaveBeenCalled()
    const call = mocks.startActionOpenCodeV2.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call).toMatchObject({
      binaryPath: '/opt/opencode',
      workspacePath: '/workspace',
      authJson: '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
      opencodeConfig: '{"share":"disabled"}',
      systematicVersion: 'latest',
      model: 'anthropic/claude-sonnet',
      dbPath: path.join('/xdg/opencode', 'opencode.db'),
      authPath: '/xdg/opencode/auth.json',
      runId: 777,
      runAttempt: 2,
    })
    expect(call.env).toBe(process.env)
    // the password is registered for masking through the Actions runner
    ;(call.maskSecret as (value: string) => void)('pw')
    expect(mocks.setSecret).toHaveBeenCalledWith('pw')
  })

  it('repairs the restored database before the spawn, exactly as V1 does', async () => {
    // #given a restore hit whose log needed a checkpoint
    mocks.checkpointDatabase.mockResolvedValue({status: 'checkpointed'})
    mocks.startActionOpenCodeV2.mockResolvedValue({success: true, data: v2Handle().handle})
    const order: string[] = []
    mocks.checkpointDatabase.mockImplementation(async () => {
      order.push('checkpoint')
      return {status: 'checkpointed'}
    })
    mocks.startActionOpenCodeV2.mockImplementation(async () => {
      order.push('spawn')
      return {success: true, data: v2Handle().handle}
    })
    const {runCacheRestore} = await import('./cache-restore.js')

    // #when
    await runCacheRestore(bootstrap(V2_VERSION), createMetricsCollector())

    // #then
    expect(order).toEqual(['checkpoint', 'spawn'])
  })

  it('hands a complete start to the execution loop: the V2 handle is returned live and the run is not failed', async () => {
    // #given
    const {handle, shutdown} = v2Handle()
    mocks.startActionOpenCodeV2.mockResolvedValue({success: true, data: handle})
    const {runCacheRestore} = await import('./cache-restore.js')

    // #when
    const result = await runCacheRestore(bootstrap(V2_VERSION), createMetricsCollector())

    // #then the server is left running for the loop, tagged as V2, and nothing failed
    expect(result).toMatchObject({generation: 'v2', serverHandle: handle})
    expect(shutdown).not.toHaveBeenCalled()
    expect(mocks.setFailed).not.toHaveBeenCalled()
  })

  it('names the stage of a failed V2 start and returns null', async () => {
    // #given
    mocks.startActionOpenCodeV2.mockResolvedValue({
      success: false,
      error: {stage: 'import-wait', message: 'no progress for 60s'},
    })
    const {runCacheRestore} = await import('./cache-restore.js')

    // #when
    const result = await runCacheRestore(bootstrap(V2_VERSION), createMetricsCollector())

    // #then
    expect(result).toBeNull()
    expect(mocks.setFailed).toHaveBeenCalledTimes(1)
    expect(mocks.setFailed).toHaveBeenCalledWith('OpenCode V2 start failed (import-wait): no progress for 60s')
  })

  it('passes a null model when the model input is unset', async () => {
    mocks.startActionOpenCodeV2.mockResolvedValue({success: true, data: v2Handle().handle})
    const {runCacheRestore} = await import('./cache-restore.js')

    await runCacheRestore(bootstrap(V2_VERSION, {model: null}), createMetricsCollector())

    expect(mocks.startActionOpenCodeV2.mock.calls[0]?.[0]).toMatchObject({model: null})
  })

  it.each(['1.19.4', '1.19.4+harness.5bde2635', 'latest', 'not-a-version'])(
    'leaves the V1 bootstrap alone for the version %j',
    async version => {
      // #given
      const {runCacheRestore} = await import('./cache-restore.js')

      // #when
      const result = await runCacheRestore(bootstrap(version), createMetricsCollector())

      // #then
      expect(result).not.toBeNull()
      expect(mocks.bootstrapOpenCodeServer).toHaveBeenCalledTimes(1)
      expect(mocks.startActionOpenCodeV2).not.toHaveBeenCalled()
    },
  )
})
