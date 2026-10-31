/**
 * Cleanup on an OpenCode V2 run: the server handle is the V2 one (no SDK client, a richer shutdown result). The V1
 * cleanup tests live in `cleanup.test.ts` and stay unedited.
 */
import type {OpenCodeV2ExitOutcome, OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import type {CleanupPhaseOptions} from './cleanup.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMetricsCollector} from '../../features/observability/index.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {ok} from '../../shared/types.js'

vi.mock('@actions/core', () => ({
  saveState: vi.fn(),
  setOutput: vi.fn(),
  warning: vi.fn(),
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../features/agent/index.js', () => ({completeAcknowledgment: vi.fn()}))
vi.mock('../../features/attachments/index.js', () => ({cleanupTempFiles: vi.fn()}))
vi.mock('node:fs/promises', () => ({rm: vi.fn().mockResolvedValue(undefined)}))
vi.mock('../../services/artifact/index.js', () => ({uploadLogArtifact: vi.fn()}))
vi.mock('../../services/cache/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../services/cache/index.js')>()
  return {
    ...original,
    buildCacheKeyComponents: vi.fn(() => ({agentIdentity: 'github'})),
    saveCache: vi.fn(async () => ({cachePersisted: true, storePersisted: false, outcome: 'persisted'})),
  }
})
vi.mock('@fro-bot/runtime', async importOriginal => {
  const original = await importOriginal<typeof import('@fro-bot/runtime')>()
  return {
    ...original,
    createS3Adapter: vi.fn(),
    pruneSessions: vi.fn(async () => ({prunedCount: 0, remainingCount: 0})),
    syncArtifactsToStore: vi.fn(async () => ({uploaded: 0, failed: 0})),
    syncMetadataToStore: vi.fn(async () => ({success: true})),
    releaseLock: vi.fn(async () => ok(undefined)),
  }
})

function v2Handle(
  outcome: OpenCodeV2ExitOutcome,
  onShutdown?: () => void,
): {
  handle: OpenCodeV2ServerHandle
  shutdown: ReturnType<typeof vi.fn>
} {
  const shutdown = vi.fn(async () => {
    onShutdown?.()
    return {
      interrupts: {stopped: [], notRunning: [], unconfirmed: []},
      exit: {outcome, code: 0, signal: null},
    }
  })
  const handle = {
    url: 'http://127.0.0.1:4096',
    pid: 1,
    directory: '/tmp/workspace',
    fetch: vi.fn(),
    authorizationHeader: () => 'Basic x',
    exited: Promise.resolve({code: 0, signal: null}),
    registerOwnedSession: vi.fn(),
    shutdown,
  } as unknown as OpenCodeV2ServerHandle
  return {handle, shutdown}
}

function options(serverHandleV2: OpenCodeV2ServerHandle): CleanupPhaseOptions {
  return {
    bootstrapLogger: createMockLogger(),
    reactionCtx: null,
    githubClient: null,
    attachmentResult: null,
    serverHandle: null,
    serverHandleV2,
    sessionRetention: null,
    detectedOpencodeVersion: '2.2.5',
    storeConfig: {enabled: false, bucket: '', region: '', prefix: ''},
    metrics: createMetricsCollector(),
    agentIdentity: 'github',
    repo: 'owner/repo',
    runId: 'run-1',
    lockEtag: null,
  }
}

describe('runCleanup on an OpenCode V2 server', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.GITHUB_WORKSPACE = '/tmp/workspace'
    process.env.GITHUB_RUN_ID = '1'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    delete process.env.RUNNER_TEMP
  })

  it.each(['graceful', 'forced', 'already-exited'] as const)(
    'shuts the V2 server down and treats a %s exit as confirmed quiescence',
    async exit => {
      // #given
      const {handle, shutdown} = v2Handle(exit)
      const {runCleanup} = await import('./cleanup.js')

      // #when
      const result = await runCleanup(options(handle))

      // #then
      expect(shutdown).toHaveBeenCalledTimes(1)
      expect(result.quiescenceConfirmed).toBe(true)
    },
  )

  it('reports an exit it could not confirm as unconfirmed quiescence and declines the save', async () => {
    // #given
    const {handle} = v2Handle('unconfirmed')
    const {saveCache} = await import('../../services/cache/index.js')
    const {runCleanup} = await import('./cleanup.js')

    // #when
    const result = await runCleanup(options(handle))

    // #then
    expect(result.quiescenceConfirmed).toBe(false)
    expect(saveCache).not.toHaveBeenCalled()
  })

  it('saves only after the server exit is confirmed, so the checkpoint inside the save sees a database no writer holds', async () => {
    // #given
    const order: string[] = []
    const {handle} = v2Handle('graceful', () => order.push('shutdown'))
    const {saveCache} = await import('../../services/cache/index.js')
    vi.mocked(saveCache).mockImplementation(async () => {
      order.push('save')
      return {cachePersisted: true, storePersisted: false, outcome: 'persisted'}
    })
    const {runCleanup} = await import('./cleanup.js')

    // #when
    await runCleanup(options(handle))

    // #then the V2 save names the V2 generation, whose database `saveCache` checkpoints before it reads sizes
    expect(order).toEqual(['shutdown', 'save'])
    expect(vi.mocked(saveCache).mock.calls[0]?.[0]).toMatchObject({opencodeVersion: '2.2.5'})
  })

  it('does not save when the release declined persistence (the directory was not confirmed quiet)', async () => {
    // #given a release that already shut the server down but could not confirm the directory quiet
    const {handle} = v2Handle('graceful')
    const {saveCache} = await import('../../services/cache/index.js')
    const {runCleanup} = await import('./cleanup.js')

    // #when
    await runCleanup({
      ...options(handle),
      skipSessionPersistence: true,
      persistenceDeclineReason: 'the run directory could not be confirmed quiet',
    })

    // #then
    expect(saveCache).not.toHaveBeenCalled()
  })

  it('does not prune through the V1 session client (a V2 handle has none)', async () => {
    // #given
    const {handle} = v2Handle('graceful')
    const {pruneSessions} = await import('@fro-bot/runtime')
    const {runCleanup} = await import('./cleanup.js')

    // #when
    await runCleanup(options(handle))

    // #then
    expect(pruneSessions).not.toHaveBeenCalled()
  })
})
