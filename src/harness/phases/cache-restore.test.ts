import type {OpenCodeServerHandle} from '../../features/agent/index.js'
import type {Logger} from '../../shared/logger.js'
import type {ActionInputs, CacheResult} from '../../shared/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMetricsCollector} from '../../features/observability/index.js'
import {checkpointDatabase as realCheckpointDatabase} from '../../services/cache/checkpoint.js'
import {verifyDatabaseUsable as realVerifyDatabaseUsable} from '../../services/cache/integrity.js'
import {DB_MAIN_BASENAME, DB_WAL_BASENAME} from '../../services/cache/paths.js'
import {cleanStorage as realCleanStorage} from '../../services/cache/restore.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {ok} from '../../shared/types.js'

const mocks = vi.hoisted(() => ({
  buildCacheKeyComponents: vi.fn(),
  restoreCache: vi.fn(),
  checkpointDatabase: vi.fn(),
  cleanStorage: vi.fn(),
  verifyDatabaseUsable: vi.fn(),
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
  cleanStorage: mocks.cleanStorage,
  verifyDatabaseUsable: mocks.verifyDatabaseUsable,
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
    mocks.verifyDatabaseUsable.mockResolvedValue({usable: true})
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

  it('leaves an already-clean, usable database alone and logs nothing about repair', async () => {
    // #given a cache hit whose write-ahead log was already empty (the common healthy-run
    // case), and the database itself opens and reads fine
    mocks.restoreCache.mockResolvedValue(createCacheResult({hit: true, corrupted: false, source: 'cache'}))
    mocks.checkpointDatabase.mockResolvedValue({status: 'nothing-to-checkpoint'})
    const {runCacheRestore} = await import('./cache-restore.js')

    // #when the cache-restore phase runs
    const result = await runCacheRestore(createBootstrapPhaseResult(), createMetricsCollector())

    // #then checkpointDatabase was still consulted (there was a restored database to check),
    // the usability probe ran against the same database path, and nothing was logged about
    // repair or corruption — the healthy path must stay silent and report a hit
    expect(result).not.toBeNull()
    expect(result?.cacheStatus).toBe('hit')
    expect(mocks.checkpointDatabase).toHaveBeenCalledWith({
      dbPath: expectedDbPath,
      walPath: expectedWalPath,
      logger: expect.anything() as unknown,
    })
    expect(mocks.verifyDatabaseUsable).toHaveBeenCalledWith(expectedDbPath)
    expect(mocks.cleanStorage).not.toHaveBeenCalled()
    expect(mocks.loggerWarning).not.toHaveBeenCalled()
    const infoMessages = mocks.loggerInfo.mock.calls.map(call => call[0])
    expect(infoMessages).not.toContain('Repaired restored database: checkpointed write-ahead log before bootstrap')
  })

  it('cleans storage and reports a corrupted cache when nothing-to-checkpoint hides a structurally corrupt database with no write-ahead log', async () => {
    // #given a cache hit with no write-ahead log to merge (checkpointDatabase reports
    // nothing-to-checkpoint before ever opening it), but the database itself is
    // structurally corrupt — the gap checkpointDatabase's WAL-driven contract cannot see
    mocks.restoreCache.mockResolvedValue(createCacheResult({hit: true, corrupted: false, source: 'cache'}))
    mocks.checkpointDatabase.mockResolvedValue({status: 'nothing-to-checkpoint'})
    mocks.verifyDatabaseUsable.mockResolvedValue({usable: false, reason: 'file is not a database'})
    const {runCacheRestore} = await import('./cache-restore.js')

    // #when the cache-restore phase runs
    const result = await runCacheRestore(createBootstrapPhaseResult(), createMetricsCollector())

    // #then the usability probe catches what the checkpoint attempt could not, storage is
    // wiped, and the run is reported as a corrupted cache instead of a hit
    expect(result).not.toBeNull()
    expect(mocks.verifyDatabaseUsable).toHaveBeenCalledWith(expectedDbPath)
    expect(mocks.cleanStorage).toHaveBeenCalledWith(testStoragePath)
    expect(mocks.loggerWarning).toHaveBeenCalledWith(
      'Restored database is structurally corrupt - cleaning storage before bootstrap',
      {reason: 'file is not a database'},
    )
    expect(result?.cacheStatus).toBe('corrupted')
    expect(mocks.bootstrapOpenCodeServer).toHaveBeenCalled()
  })

  it('performs no repair or usability probe on a cache miss', async () => {
    // #given a cache miss — there is no restored database on disk to repair or verify
    mocks.restoreCache.mockResolvedValue(
      createCacheResult({hit: false, corrupted: false, key: null, restoredPath: null, source: null}),
    )
    const {runCacheRestore} = await import('./cache-restore.js')

    // #when the cache-restore phase runs
    const result = await runCacheRestore(createBootstrapPhaseResult(), createMetricsCollector())

    // #then neither checkpointDatabase nor the usability probe is ever consulted, and
    // bootstrap still proceeds
    expect(result).not.toBeNull()
    expect(mocks.checkpointDatabase).not.toHaveBeenCalled()
    expect(mocks.verifyDatabaseUsable).not.toHaveBeenCalled()
    expect(mocks.bootstrapOpenCodeServer).toHaveBeenCalled()
  })

  it('does not fail the run when repair fails on a retryable (busy/locked) database — bootstrap is still attempted', async () => {
    // #given a cache hit whose write-ahead log could not be merged (e.g. a live writer) —
    // a transient failure, not a structurally corrupt database
    mocks.restoreCache.mockResolvedValue(createCacheResult({hit: true, corrupted: false, source: 'cache'}))
    mocks.checkpointDatabase.mockResolvedValue({status: 'failed', reason: 'database is locked', retryable: true})
    const {runCacheRestore} = await import('./cache-restore.js')

    // #when the cache-restore phase runs
    const result = await runCacheRestore(createBootstrapPhaseResult(), createMetricsCollector())

    // #then the failure is logged as a warning, storage is left alone, the run is not
    // failed, and bootstrap proceeds
    expect(result).not.toBeNull()
    expect(mocks.loggerWarning).toHaveBeenCalledWith('Failed to repair restored database before bootstrap', {
      reason: 'database is locked',
    })
    expect(mocks.cleanStorage).not.toHaveBeenCalled()
    expect(result?.cacheStatus).toBe('hit')
    expect(mocks.bootstrapOpenCodeServer).toHaveBeenCalled()
  })

  it('cleans storage and reports a corrupted cache when repair fails on a structurally corrupt (non-retryable) database', async () => {
    // #given a cache hit whose restored database SQLite itself reports as unusable — not a
    // live writer, not a slow truncation
    mocks.restoreCache.mockResolvedValue(createCacheResult({hit: true, corrupted: false, source: 'cache'}))
    mocks.checkpointDatabase.mockResolvedValue({
      status: 'failed',
      reason: 'file is not a database',
      retryable: false,
    })
    const {runCacheRestore} = await import('./cache-restore.js')

    // #when the cache-restore phase runs
    const result = await runCacheRestore(createBootstrapPhaseResult(), createMetricsCollector())

    // #then storage is wiped, the cache status is downgraded to corrupted, and bootstrap
    // still proceeds against a clean state rather than the malformed database
    expect(result).not.toBeNull()
    expect(mocks.cleanStorage).toHaveBeenCalledWith(testStoragePath)
    expect(mocks.loggerWarning).toHaveBeenCalledWith(
      'Restored database is structurally corrupt - cleaning storage before bootstrap',
      {reason: 'file is not a database'},
    )
    expect(result?.cacheStatus).toBe('corrupted')
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

// The suite above mocks checkpointDatabase entirely, which proves the phase calls it in
// the right order but never that a real restored database is actually repaired — a
// wiring regression in the database path selection (dbDir/dbPath/walPath computation)
// would pass every test above today. This suite wires mocks.checkpointDatabase to the
// real implementation (imported directly from checkpoint.js, bypassing the index.js mock
// above) and points getOpenCodeStoragePath at a real temp directory with a real hot-WAL
// SQLite database sitting exactly where the phase expects it.
describe('runCacheRestore database repair (end-to-end against a real database)', () => {
  let tempDir: string
  let realStoragePath: string
  let dbPath: string
  let walPath: string
  const openHandles: DatabaseSync[] = []

  beforeEach(async () => {
    vi.clearAllMocks()
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-restore-e2e-'))
    realStoragePath = path.join(tempDir, 'storage')
    await fs.mkdir(realStoragePath, {recursive: true})
    dbPath = path.join(tempDir, DB_MAIN_BASENAME)
    walPath = path.join(tempDir, DB_WAL_BASENAME)

    mocks.buildCacheKeyComponents.mockReturnValue({
      agentIdentity: 'github',
      repo: 'owner/repo',
      ref: 'main',
      os: 'Linux',
    })
    mocks.getGitHubWorkspace.mockReturnValue(tempDir)
    mocks.getOpenCodeAuthPath.mockReturnValue(path.join(tempDir, 'auth.json'))
    mocks.getOpenCodeStoragePath.mockReturnValue(realStoragePath)
    mocks.ensureProjectId.mockResolvedValue({projectId: 'a'.repeat(40), source: 'cached'})
    mocks.bootstrapOpenCodeServer.mockResolvedValue(ok(stubServerHandle))
    mocks.restoreCache.mockResolvedValue(
      createCacheResult({hit: true, corrupted: false, source: 'cache', restoredPath: realStoragePath}),
    )
    // The substitutions that matter for this suite: delegate the mocked checkpointDatabase,
    // cleanStorage, and verifyDatabaseUsable calls to their real implementations instead of
    // canned outcomes, so failure-case tests below exercise the real path-selection,
    // clean-slate, and integrity-probe logic.
    mocks.checkpointDatabase.mockImplementation(realCheckpointDatabase)
    mocks.cleanStorage.mockImplementation(realCleanStorage)
    mocks.verifyDatabaseUsable.mockImplementation(realVerifyDatabaseUsable)
  })

  afterEach(async () => {
    while (openHandles.length > 0) {
      const handle = openHandles.pop()
      try {
        handle?.close()
      } catch {
        // best effort — some handles may already be closed by the test itself
      }
    }
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('checkpoints a real hot-WAL database beside the restored storage path and still runs bootstrap', async () => {
    // #given a real database with a populated write-ahead log placed exactly where
    // runCacheRestore computes it (path.dirname(storagePath)), never cleanly closed —
    // mirroring server.close() sending proc.kill() without awaiting a checkpoint
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT)')
    db.exec("INSERT INTO sessions (data) VALUES ('restored-session')")
    openHandles.push(db)
    expect((await fs.stat(walPath)).size).toBeGreaterThan(0)

    const {runCacheRestore} = await import('./cache-restore.js')

    // #when the cache-restore phase runs against the real filesystem
    const result = await runCacheRestore(createBootstrapPhaseResult(), createMetricsCollector())

    // #then the write-ahead log is empty afterwards — the real repair happened, not a
    // mock reporting success — and bootstrap still ran
    expect(result).not.toBeNull()
    expect((await fs.stat(walPath)).size).toBe(0)
    expect(mocks.bootstrapOpenCodeServer).toHaveBeenCalled()

    // #then the data that lived only in the write-ahead log survived the checkpoint
    const verifyDb = new DatabaseSync(dbPath)
    try {
      const rows = verifyDb.prepare('SELECT data FROM sessions').all()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.data).toBe('restored-session')
    } finally {
      verifyDb.close()
    }
  })

  it('cleans storage and reports a corrupted cache for a malformed (not merely hot-WAL) database, and still runs bootstrap', async () => {
    // #given a database file that is not valid SQLite at all — distinct from a hot-WAL
    // database that merely needs a checkpoint — with a populated write-ahead log beside it
    // so checkpointDatabase's early-return does not skip opening it
    await fs.writeFile(dbPath, 'not a real sqlite database file, just garbage bytes'.repeat(50))
    await fs.writeFile(walPath, 'also not a real write-ahead log, just more garbage'.repeat(50))

    const {runCacheRestore} = await import('./cache-restore.js')

    // #when the cache-restore phase runs against the real filesystem
    const result = await runCacheRestore(createBootstrapPhaseResult(), createMetricsCollector())

    // #then the malformed database is detected (a structural SQLite error, not a busy
    // lock), storage is wiped rather than handed to bootstrap, and the run is reported as
    // a corrupted cache instead of a hit — closing the loop that would otherwise
    // re-persist the malformed database under a fresh key
    expect(result).not.toBeNull()
    expect(result?.cacheStatus).toBe('corrupted')
    await expect(fs.access(dbPath)).rejects.toThrow()
    await expect(fs.access(walPath)).rejects.toThrow()
    await expect(fs.readdir(realStoragePath)).resolves.toEqual([])
    expect(mocks.bootstrapOpenCodeServer).toHaveBeenCalled()
  })

  it('retries and reports a retryable failure for a real locked database, leaving storage intact and still running bootstrap', async () => {
    // #given a database held under an exclusive lock by an in-progress transaction on
    // another connection — the same EXCLUSIVE-locked-holder shape as
    // checkpoint.test.ts's unit test, reused here to exercise the real restore-side
    // path-selection code in the failure case instead of a mocked 'failed' outcome
    const holder = new DatabaseSync(dbPath)
    holder.exec('PRAGMA journal_mode=WAL')
    holder.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT)')
    holder.exec("INSERT INTO sessions (data) VALUES ('locked-session')")
    holder.exec('PRAGMA locking_mode=EXCLUSIVE')
    holder.exec('BEGIN IMMEDIATE')
    holder.exec("INSERT INTO sessions (data) VALUES ('in-flight')")
    openHandles.push(holder)

    const {runCacheRestore} = await import('./cache-restore.js')

    // #when the cache-restore phase runs against the real filesystem
    const result = await runCacheRestore(createBootstrapPhaseResult(), createMetricsCollector())

    // #then the lock is reported as a retryable failure rather than structural corruption,
    // storage is left untouched, and bootstrap still runs
    expect(result).not.toBeNull()
    expect(result?.cacheStatus).toBe('hit')
    await expect(fs.access(dbPath)).resolves.toBeUndefined()
    expect(mocks.loggerWarning).toHaveBeenCalledWith(
      'Failed to repair restored database before bootstrap',
      expect.any(Object),
    )
    expect(mocks.bootstrapOpenCodeServer).toHaveBeenCalled()

    holder.exec('COMMIT')
  })

  it('cleans storage and reports a corrupted cache for a structurally corrupt database with no write-ahead log at all', async () => {
    // #given a database file that is not valid SQLite at all, with no write-ahead log
    // beside it — checkpointDatabase reports nothing-to-checkpoint before ever opening it
    // (the exact gap the usability probe exists to close), so this exercises the real
    // probe rather than a mocked 'nothing-to-checkpoint' outcome
    await fs.writeFile(dbPath, 'not a real sqlite database file, just garbage bytes'.repeat(50))
    await expect(fs.access(walPath)).rejects.toThrow()

    const {runCacheRestore} = await import('./cache-restore.js')

    // #when the cache-restore phase runs against the real filesystem
    const result = await runCacheRestore(createBootstrapPhaseResult(), createMetricsCollector())

    // #then the usability probe (not the checkpoint attempt) detects the corruption,
    // storage is wiped, and the run is reported as corrupted instead of a hit
    expect(result).not.toBeNull()
    expect(result?.cacheStatus).toBe('corrupted')
    await expect(fs.access(dbPath)).rejects.toThrow()
    await expect(fs.readdir(realStoragePath)).resolves.toEqual([])
    expect(mocks.bootstrapOpenCodeServer).toHaveBeenCalled()
  })

  it('passes a healthy, cleanly-checkpointed database with no write-ahead log through untouched — the common path must not regress', async () => {
    // #given a real, healthy database that was cleanly closed, leaving no write-ahead log
    // behind — the ordinary shape of the vast majority of cache hits
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT)')
    db.exec("INSERT INTO sessions (data) VALUES ('clean-session')")
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    db.close()
    await expect(fs.access(walPath)).rejects.toThrow()

    const {runCacheRestore} = await import('./cache-restore.js')

    // #when the cache-restore phase runs against the real filesystem
    const result = await runCacheRestore(createBootstrapPhaseResult(), createMetricsCollector())

    // #then the usability probe passes, storage is left completely alone, and the run
    // still reports a hit — this is the common case and must stay silent and untouched
    expect(result).not.toBeNull()
    expect(result?.cacheStatus).toBe('hit')
    expect(mocks.cleanStorage).not.toHaveBeenCalled()
    expect(mocks.loggerWarning).not.toHaveBeenCalled()
    const verifyDb = new DatabaseSync(dbPath)
    try {
      const rows = verifyDb.prepare('SELECT data FROM sessions').all()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.data).toBe('clean-session')
    } finally {
      verifyDb.close()
    }
    expect(mocks.bootstrapOpenCodeServer).toHaveBeenCalled()
  })
})
