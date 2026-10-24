/**
 * A run that never acquired the Action coordination lock must not publish the session to the object
 * store. Every early return in `run()` reaches `runCleanup`, including the dedup skip and the routing
 * skip, which return before any lock is taken. Every cleanup safety gate reads "safe" for such a run
 * (no ownership ledger, no server handle, no lease to lose), so only positive evidence that a lease was
 * acquired may allow the publish.
 *
 * Drives the REAL `runCleanup` and the REAL `saveCache` against a stub object-store adapter and a real
 * session database on disk, counting calls at the adapter's `upload` boundary.
 */
import type {ObjectStoreAdapter, ObjectStoreConfig} from '@fro-bot/runtime'
import type {LeaseController} from './acquire-lock.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMetricsCollector} from '../../features/observability/index.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {ok} from '../../shared/types.js'

const mocks = vi.hoisted(() => ({
  stateStore: new Map<string, string>(),
  addTable: vi.fn(),
  addRaw: vi.fn(),
}))

vi.mock('@actions/core', () => ({
  saveState: vi.fn((key: string, value: string) => {
    mocks.stateStore.set(key, value)
  }),
  getState: vi.fn((key: string) => mocks.stateStore.get(key) ?? ''),
  setOutput: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addTable: mocks.addTable.mockReturnThis(),
    addRaw: mocks.addRaw.mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@actions/cache', () => ({
  saveCache: vi.fn(),
  restoreCache: vi.fn(),
}))

vi.mock('../../features/agent/index.js', () => ({completeAcknowledgment: vi.fn()}))
vi.mock('../../features/attachments/index.js', () => ({cleanupTempFiles: vi.fn()}))
vi.mock('../../services/artifact/index.js', () => ({uploadLogArtifact: vi.fn()}))

vi.mock('@fro-bot/runtime', async importOriginal => {
  const original = await importOriginal<typeof import('@fro-bot/runtime')>()
  return {
    ...original,
    createS3Adapter: vi.fn(),
    releaseLock: vi.fn(async () => ({success: true, data: undefined})),
    pruneSessions: vi.fn(async () => ({prunedCount: 0, remainingCount: 0})),
    syncArtifactsToStore: vi.fn(async () => ({uploaded: 0, failed: 0})),
    syncMetadataToStore: vi.fn(async () => ({success: true})),
  }
})

const STORE_ON: ObjectStoreConfig = {enabled: true, bucket: 'bucket', region: 'us-east-1', prefix: 'fro-bot-state'}
const STORE_OFF: ObjectStoreConfig = {enabled: false, bucket: '', region: '', prefix: ''}

/** The inputs `run()` hands to `runCleanup` on each path that did not acquire a lock. */
const UNLEASED_RUNS = [
  // run.ts: dedup skip returns before runAcquireLock, with the repo and run id already known.
  ['a dedup-skipped run', {repo: 'owner/repo', runId: '99999'}],
  // run.ts: routing skip returns before the repo and run id are even assigned.
  ['a routing-skipped run', {repo: '', runId: ''}],
] as const

async function cleanup(overrides: {
  readonly storeConfig?: ObjectStoreConfig
  readonly repo?: string
  readonly runId?: string
  readonly lockEtag?: string | null
  readonly leaseRenewal?: LeaseController
}) {
  const {runCleanup} = await import('./cleanup.js')
  const logger = createMockLogger()
  await runCleanup({
    bootstrapLogger: logger,
    reactionCtx: null,
    githubClient: null,
    attachmentResult: null,
    serverHandle: null,
    sessionRetention: null,
    detectedOpencodeVersion: '1.0.0',
    storeConfig: overrides.storeConfig ?? STORE_ON,
    metrics: createMetricsCollector(),
    agentIdentity: 'github',
    repo: overrides.repo ?? '',
    runId: overrides.runId ?? '',
    lockEtag: overrides.lockEtag ?? null,
    ...(overrides.leaseRenewal === undefined ? {} : {leaseRenewal: overrides.leaseRenewal}),
  })
  return logger
}

async function summaryText(): Promise<string> {
  await Promise.resolve()
  return [...mocks.addTable.mock.calls, ...mocks.addRaw.mock.calls].map(call => JSON.stringify(call[0])).join('\n')
}

function leaseStub(): LeaseController {
  return {
    stop: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
    currentEtag: vi.fn(() => 'etag-renewed'),
    hasFailed: vi.fn(() => false),
    continuityUnverified: vi.fn(() => false),
  }
}

describe('runCleanup publishes to the object store only when the run acquired the lease', () => {
  let tempDir: string
  let storeAdapter: ObjectStoreAdapter

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.stateStore.clear()

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-unleased-'))
    const openCodeDir = path.join(tempDir, 'opencode')
    const storagePath = path.join(openCodeDir, 'storage')
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'older local session')
    // The file syncSessionsToStore uploads: a stale database left on a persistent runner by an earlier run.
    await fs.writeFile(path.join(openCodeDir, 'opencode.db'), 'older local database')

    process.env.XDG_DATA_HOME = tempDir
    process.env.GITHUB_WORKSPACE = tempDir
    process.env.GITHUB_RUN_ID = '99999'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    process.env.GITHUB_REF_NAME = 'main'
    process.env.RUNNER_OS = 'Linux'
    delete process.env.OPENCODE_PROMPT_ARTIFACT
    delete process.env.SKIP_CACHE

    storeAdapter = {
      upload: vi.fn(async () => ok(undefined)),
      download: vi.fn(async () => ok(undefined)),
      list: vi.fn(async () => ok([])),
    }
    const {createS3Adapter} = await import('@fro-bot/runtime')
    vi.mocked(createS3Adapter).mockReturnValue(storeAdapter)
    const {saveCache} = await import('@actions/cache')
    vi.mocked(saveCache).mockResolvedValue(12345)
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
    for (const key of [
      'XDG_DATA_HOME',
      'GITHUB_WORKSPACE',
      'GITHUB_RUN_ID',
      'GITHUB_RUN_ATTEMPT',
      'GITHUB_REPOSITORY',
      'GITHUB_REF_NAME',
      'RUNNER_OS',
    ]) {
      delete process.env[key]
    }
  })

  it.each(UNLEASED_RUNS)(
    '%s does not upload to the object store, though a local database exists',
    async (_label, ids) => {
      // #given a run that returned before taking the lock, on a runner that still has an older local database
      // #when its cleanup saves
      await cleanup({...ids, lockEtag: null})

      // #then the shared session object is never written
      expect(storeAdapter.upload).not.toHaveBeenCalled()
    },
  )

  it.each(UNLEASED_RUNS)('%s still writes the Actions cache, exactly as before', async (_label, ids) => {
    // #when
    await cleanup({...ids, lockEtag: null})

    // #then the cache side is unchanged
    const {saveCache} = await import('@actions/cache')
    expect(saveCache).toHaveBeenCalledTimes(1)
    expect(mocks.stateStore.get('cacheSaved')).toBe('durable')
  })

  it('logs once that the publish was withheld because no lease was acquired', async () => {
    // #when
    await cleanup({repo: 'owner/repo', runId: '99999', lockEtag: null})

    // #then
    const core = await import('@actions/core')
    const withheldLogs = vi
      .mocked(core.info)
      .mock.calls.filter(call => String(call[0]).includes('Object store session publish withheld'))
    expect(withheldLogs).toHaveLength(1)
    const text = await summaryText()
    expect(text).toContain('Object Store Publish')
    expect(text).toContain('no lease acquired')
  })

  it('a run that acquired the lock (non-null lock ETag) still publishes', async () => {
    // #when
    await cleanup({repo: 'owner/repo', runId: '99999', lockEtag: 'etag-1'})

    // #then
    expect(storeAdapter.upload).toHaveBeenCalledTimes(1)
    expect(await summaryText()).not.toContain('Object Store Publish')
  })

  it('a run whose lease renewal is running still publishes, even without the original ETag', async () => {
    // #when
    await cleanup({repo: 'owner/repo', runId: '99999', lockEtag: null, leaseRenewal: leaseStub()})

    // #then
    expect(storeAdapter.upload).toHaveBeenCalledTimes(1)
  })

  it('with the object store disabled, nothing changes: no upload, the cache is written, no store note', async () => {
    // #when
    await cleanup({repo: 'owner/repo', runId: '99999', lockEtag: null, storeConfig: STORE_OFF})

    // #then
    expect(storeAdapter.upload).not.toHaveBeenCalled()
    const {saveCache} = await import('@actions/cache')
    expect(saveCache).toHaveBeenCalledTimes(1)
    expect(await summaryText()).not.toContain('Object Store Publish')
  })
})
