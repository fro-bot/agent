import type {CoordinationConfig, RunPhase, RunState} from '@fro-bot/runtime'
import type {BindingsStore} from '../bindings/store.js'
import type {GatewayLogger} from '../discord/client.js'
import type {SinkThread} from '../discord/streaming.js'
import type {RecoverStaleRunsDeps} from './recovery.js'

import * as runtimeModule from '@fro-bot/runtime'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import {recoverStaleRuns} from './recovery.js'
// ---------------------------------------------------------------------------
// Mock @fro-bot/runtime
// ---------------------------------------------------------------------------

vi.mock('@fro-bot/runtime', async () => {
  const actual = await vi.importActual<typeof import('@fro-bot/runtime')>('@fro-bot/runtime')
  return {
    getRunKey: vi.fn(),
    getLockKey: vi.fn(),
    findStaleRuns: vi.fn(),
    transitionRun: vi.fn(),
    releaseLock: vi.fn(),
    forceReleaseStaleLock: vi.fn(),
    // parseRunState is pure JSON-shape validation — use the real implementation.
    parseRunState: actual.parseRunState,
  }
})

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------

const mockGetRunKey = vi.mocked(runtimeModule.getRunKey)
const mockGetLockKey = vi.mocked(runtimeModule.getLockKey)
const mockFindStaleRuns = vi.mocked(runtimeModule.findStaleRuns)
const mockTransitionRun = vi.mocked(runtimeModule.transitionRun)
const mockReleaseLock = vi.mocked(runtimeModule.releaseLock)
const mockForceReleaseStaleLock = vi.mocked(runtimeModule.forceReleaseStaleLock)

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const OWNER = 'acme'
const REPO = 'widget'
const REPO_SLUG = `${OWNER}/${REPO}`
const RUN_ID = 'run-stale-001'
const THREAD_ID = 'thread-123'
const RUN_KEY = 'state/identity/acme/widget/runs/run-stale-001.json'
const LOCK_KEY = 'state/coordination/acme/widget/locks/repo.json'
const RUN_ETAG = 'etag-run-1'
const LOCK_ETAG = 'etag-lock-1'

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeLogger(): GatewayLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function makeStaleRun(overrides: Partial<{run_id: string; thread_id: string; phase: RunPhase}> = {}): RunState {
  return {
    run_id: overrides.run_id ?? RUN_ID,
    thread_id: overrides.thread_id ?? THREAD_ID,
    entity_ref: REPO_SLUG,
    surface: 'discord' as const,
    phase: overrides.phase ?? 'EXECUTING',
    started_at: new Date(Date.now() - 300_000).toISOString(),
    last_heartbeat: new Date(Date.now() - 300_000).toISOString(),
    holder_id: 'discord-gateway',
    details: {},
  }
}

function makeBinding() {
  return {owner: OWNER, repo: REPO, channelId: 'ch-1', workspacePath: '/workspace/repos/acme/widget'}
}

function makeBindingsStore(overrides: {listBindings?: () => Promise<unknown>} = {}): BindingsStore {
  return {
    createBinding: vi.fn(),
    getBindingByRepo: vi.fn(),
    getBindingByChannelId: vi.fn(),
    listBindings:
      overrides.listBindings ??
      (vi.fn().mockResolvedValue({success: true, data: [makeBinding()]}) as BindingsStore['listBindings']),
  } as unknown as BindingsStore
}

function makeCoordinationConfig(): CoordinationConfig {
  const getObject = vi.fn().mockImplementation(async (key: string) => {
    if (key === RUN_KEY) return {success: true, data: {data: '{}', etag: RUN_ETAG}}
    if (key === LOCK_KEY) return {success: true, data: {data: JSON.stringify({run_id: RUN_ID}), etag: LOCK_ETAG}}
    return {success: false, error: new Error('not found')}
  })

  return {
    storeAdapter: {
      upload: vi.fn(),
      download: vi.fn(),
      list: vi.fn(),
      getObject,
    },
    storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  }
}

function makeResolveThread(thread: SinkThread | null = null): (id: string) => Promise<SinkThread | null> {
  return vi.fn().mockResolvedValue(thread)
}

function makeThread(): SinkThread {
  return {send: vi.fn().mockResolvedValue(undefined)}
}

function makeCancelledLockFixture(overrides: {lockRunId?: string} = {}): CoordinationConfig {
  const runStateJson = JSON.stringify({
    run_id: RUN_ID,
    surface: 'discord',
    thread_id: THREAD_ID,
    entity_ref: REPO_SLUG,
    phase: 'CANCELLED',
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    holder_id: 'discord-gateway',
    details: {},
  })

  const getObjectFn = vi.fn().mockImplementation(async (key: string) => {
    if (key === RUN_KEY) return {success: true, data: {data: runStateJson, etag: RUN_ETAG}}
    if (key === LOCK_KEY) {
      return {
        success: true,
        data: {data: JSON.stringify({run_id: overrides.lockRunId ?? RUN_ID}), etag: LOCK_ETAG},
      }
    }
    return {success: false, error: new Error('not found')}
  })

  const base = makeCoordinationConfig()
  return {
    ...base,
    storeAdapter: {...base.storeAdapter, getObject: getObjectFn},
  }
}

function makeDeps(overrides: Partial<RecoverStaleRunsDeps> = {}): RecoverStaleRunsDeps {
  return {
    coordinationConfig: overrides.coordinationConfig ?? makeCoordinationConfig(),
    identity: overrides.identity ?? 'discord-gateway',
    bindingsStore: overrides.bindingsStore ?? makeBindingsStore(),
    resolveThread: overrides.resolveThread ?? makeResolveThread(),
    logger: overrides.logger ?? makeLogger(),
  }
}

// Helper to create a ValidationError-shaped object that satisfies the runtime type
function makeValidationError(message: string): Error & {readonly code: 'VALIDATION_ERROR'} {
  const error = new Error(message) as Error & {code: 'VALIDATION_ERROR'}
  error.code = 'VALIDATION_ERROR'
  return error
}

type KeyResult = ReturnType<typeof runtimeModule.getRunKey>

function okKey(key: string): KeyResult {
  return {success: true, data: key}
}

function errKey(message: string): KeyResult {
  return {success: false, error: makeValidationError(message)} as unknown as KeyResult
}

// ---------------------------------------------------------------------------
// Default runtime mock wiring (success path)
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()

  // getRunKey: called with (config, identity, repo, runId) → returns key result
  mockGetRunKey.mockImplementation((_config, _identity, _repo, runId) => {
    if (runId === RUN_ID) return okKey(RUN_KEY)
    return errKey('unexpected run key')
  })

  // getLockKey: called with (config, repo) → returns lock key result
  mockGetLockKey.mockReturnValue(okKey(LOCK_KEY))

  mockFindStaleRuns.mockResolvedValue({success: true, data: []})
  mockTransitionRun.mockResolvedValue({
    success: true,
    data: {etag: 'etag-run-2', state: makeStaleRun({phase: 'FAILED'})},
  })
  mockReleaseLock.mockResolvedValue({success: true, data: undefined})
  mockForceReleaseStaleLock.mockResolvedValue({
    success: true,
    data: {outcome: 'no-lock', holderId: null, runId: null, lockAgeMs: null, heartbeatAgeMs: null},
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recoverStaleRuns', () => {
  describe('no stale runs', () => {
    it('is a clean no-op when there are no bindings', async () => {
      // #given
      const deps = makeDeps({
        bindingsStore: makeBindingsStore({
          listBindings: vi.fn().mockResolvedValue({success: true, data: []}),
        }),
      })

      // #when
      await recoverStaleRuns(deps)

      // #then
      expect(mockFindStaleRuns).not.toHaveBeenCalled()
      expect(mockTransitionRun).not.toHaveBeenCalled()
      expect(mockReleaseLock).not.toHaveBeenCalled()
    })

    it('is a clean no-op when findStaleRuns returns an empty list', async () => {
      // #given
      mockFindStaleRuns.mockResolvedValue({success: true, data: []})
      const deps = makeDeps()

      // #when
      await recoverStaleRuns(deps)

      // #then
      expect(mockFindStaleRuns).toHaveBeenCalledOnce()
      expect(mockTransitionRun).not.toHaveBeenCalled()
      expect(mockReleaseLock).not.toHaveBeenCalled()
    })
  })

  describe('happy path — one stale run', () => {
    it('transitions run to FAILED, releases lock, and posts thread note', async () => {
      // #given
      const staleRun = makeStaleRun()
      mockFindStaleRuns.mockResolvedValue({success: true, data: [staleRun]})

      const thread = makeThread()
      const resolveThread = makeResolveThread(thread)
      const deps = makeDeps({resolveThread})

      // #when
      await recoverStaleRuns(deps)

      // #then
      expect(mockTransitionRun).toHaveBeenCalledWith(
        expect.anything(),
        'discord-gateway',
        REPO_SLUG,
        RUN_ID,
        'FAILED',
        RUN_ETAG,
        expect.anything(),
      )
      expect(mockReleaseLock).toHaveBeenCalledWith(expect.anything(), REPO_SLUG, LOCK_ETAG, expect.anything())
      expect(resolveThread).toHaveBeenCalledWith(THREAD_ID)
      expect(thread.send).toHaveBeenCalledWith(expect.objectContaining({allowedMentions: {parse: []}}))
    })
  })

  describe('edge cases', () => {
    it('skips thread note when thread_id cannot be resolved', async () => {
      // #given
      const staleRun = makeStaleRun()
      mockFindStaleRuns.mockResolvedValue({success: true, data: [staleRun]})

      const resolveThread = makeResolveThread(null) // thread not found
      const deps = makeDeps({resolveThread})

      // #when
      await recoverStaleRuns(deps)

      // #then — FAILED + lock release still run; just no thread note
      expect(mockTransitionRun).toHaveBeenCalled()
      expect(mockReleaseLock).toHaveBeenCalled()
      const thread = {send: vi.fn()}
      expect(thread.send).not.toHaveBeenCalled()
    })

    it('continues sweep when resolveThread throws', async () => {
      // #given
      const staleRun = makeStaleRun()
      mockFindStaleRuns.mockResolvedValue({success: true, data: [staleRun]})

      const resolveThread: (id: string) => Promise<SinkThread | null> = vi
        .fn()
        .mockRejectedValue(new Error('discord error'))
      const logger = makeLogger()
      const deps = makeDeps({resolveThread, logger})

      // #when — must not throw
      await expect(recoverStaleRuns(deps)).resolves.toBeUndefined()

      // #then — still transitioned and released despite the throw
      expect(mockTransitionRun).toHaveBeenCalled()
      expect(mockReleaseLock).toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({runId: RUN_ID}),
        expect.stringContaining('thread note'),
      )
    })
  })

  describe('error paths', () => {
    it('continues sweep when one run transition fails', async () => {
      // #given
      const run1 = makeStaleRun({run_id: 'run-001'})
      const run2 = makeStaleRun({run_id: 'run-002'})
      mockFindStaleRuns.mockResolvedValue({success: true, data: [run1, run2]})

      const RUN_KEY_2 = 'state/identity/acme/widget/runs/run-002.json'

      mockGetRunKey.mockImplementation((_config, _identity, _repo, runId) => {
        if (runId === 'run-001') return okKey(RUN_KEY)
        if (runId === 'run-002') return okKey(RUN_KEY_2)
        return errKey('unexpected run key')
      })
      mockGetLockKey.mockReturnValue(okKey(LOCK_KEY))

      // Make getObject return etags for both run keys — typed cast is test-only
      const getObjectFn = vi.fn().mockImplementation(async (key: string) => {
        if (key === RUN_KEY) return {success: true, data: {data: '{}', etag: RUN_ETAG}}
        if (key === RUN_KEY_2) return {success: true, data: {data: '{}', etag: 'etag-run-2'}}
        if (key === LOCK_KEY) return {success: true, data: {data: JSON.stringify({run_id: 'run-002'}), etag: LOCK_ETAG}}
        return {success: false, error: new Error('not found')}
      })
      const coordConfig: CoordinationConfig = {
        ...makeCoordinationConfig(),
        storeAdapter: {
          ...makeCoordinationConfig().storeAdapter,
          getObject: getObjectFn,
        },
      }

      // run-001 transition fails; run-002 should still be processed
      mockTransitionRun
        .mockResolvedValueOnce({success: false, error: new Error('write conflict')})
        .mockResolvedValueOnce({success: true, data: {etag: 'etag-r2', state: makeStaleRun({phase: 'FAILED'})}})

      const logger = makeLogger()
      const deps = makeDeps({coordinationConfig: coordConfig, logger})

      // #when — must not throw
      await expect(recoverStaleRuns(deps)).resolves.toBeUndefined()

      // #then — both runs attempted; warning logged for run-001; only run-002 releases lock (it owns it)
      expect(mockTransitionRun).toHaveBeenCalledTimes(2)
      expect(mockReleaseLock).toHaveBeenCalledTimes(1)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({runId: 'run-001'}),
        expect.stringContaining('transitionRun FAILED'),
      )
    })

    it('continues sweep when one repo findStaleRuns fails', async () => {
      // #given
      const binding1 = {owner: 'acme', repo: 'widget', channelId: 'ch-1', workspacePath: '/w/widget'}
      const binding2 = {owner: 'acme', repo: 'other', channelId: 'ch-2', workspacePath: '/w/other'}

      const bindingsStore = makeBindingsStore({
        listBindings: vi.fn().mockResolvedValue({success: true, data: [binding1, binding2]}),
      })

      // First repo fails; second succeeds with no stale runs
      mockFindStaleRuns
        .mockResolvedValueOnce({success: false, error: new Error('list failed')})
        .mockResolvedValueOnce({success: true, data: []})

      const logger = makeLogger()
      const deps = makeDeps({bindingsStore, logger})

      // #when
      await expect(recoverStaleRuns(deps)).resolves.toBeUndefined()

      // #then
      expect(mockFindStaleRuns).toHaveBeenCalledTimes(2)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({repo: 'acme/widget'}),
        expect.stringContaining('findStaleRuns failed'),
      )
    })

    it('logs an error and returns early when listBindings fails', async () => {
      // #given
      const bindingsStore = makeBindingsStore({
        listBindings: vi.fn().mockResolvedValue({success: false, error: new Error('S3 error')}),
      })
      const logger = makeLogger()
      const deps = makeDeps({bindingsStore, logger})

      // #when
      await expect(recoverStaleRuns(deps)).resolves.toBeUndefined()

      // #then
      expect(mockFindStaleRuns).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({err: 'S3 error'}),
        expect.stringContaining('listBindings failed'),
      )
    })
  })

  describe('stale PENDING and ACKNOWLEDGED recovery', () => {
    it('transitions a stale PENDING run to FAILED without attempting lock release', async () => {
      // #given — a stale PENDING run (no lock held by PENDING runs)
      const stalePending = makeStaleRun({phase: 'PENDING'})
      mockFindStaleRuns.mockResolvedValue({success: true, data: [stalePending]})

      const logger = makeLogger()
      const deps = makeDeps({logger})

      // #when
      await recoverStaleRuns(deps)

      // #then — run transitioned to FAILED
      expect(mockTransitionRun).toHaveBeenCalledWith(
        expect.anything(),
        'discord-gateway',
        REPO_SLUG,
        RUN_ID,
        'FAILED',
        RUN_ETAG,
        expect.anything(),
      )
      // PENDING runs do not hold a lock — lock release must NOT be attempted
      expect(mockReleaseLock).not.toHaveBeenCalled()
    })

    it('transitions a stale ACKNOWLEDGED run to FAILED without attempting lock release', async () => {
      // #given — a stale ACKNOWLEDGED run (no lock held by ACKNOWLEDGED runs)
      const staleAcknowledged = makeStaleRun({phase: 'ACKNOWLEDGED'})
      mockFindStaleRuns.mockResolvedValue({success: true, data: [staleAcknowledged]})

      const logger = makeLogger()
      const deps = makeDeps({logger})

      // #when
      await recoverStaleRuns(deps)

      // #then — run transitioned to FAILED
      expect(mockTransitionRun).toHaveBeenCalledWith(
        expect.anything(),
        'discord-gateway',
        REPO_SLUG,
        RUN_ID,
        'FAILED',
        RUN_ETAG,
        expect.anything(),
      )
      // ACKNOWLEDGED runs do not hold a lock — lock release must NOT be attempted
      expect(mockReleaseLock).not.toHaveBeenCalled()
    })

    it('handles a mix of stale EXECUTING, PENDING, and ACKNOWLEDGED runs in one sweep', async () => {
      // #given — three stale runs of different phases
      const staleExecuting = makeStaleRun({run_id: 'run-exec', phase: 'EXECUTING'})
      const stalePending = makeStaleRun({run_id: 'run-pend', phase: 'PENDING'})
      const staleAcknowledged = makeStaleRun({run_id: 'run-ack', phase: 'ACKNOWLEDGED'})
      mockFindStaleRuns.mockResolvedValue({success: true, data: [staleExecuting, stalePending, staleAcknowledged]})

      const RUN_KEY_EXEC = 'state/identity/acme/widget/runs/run-exec.json'
      const RUN_KEY_PEND = 'state/identity/acme/widget/runs/run-pend.json'
      const RUN_KEY_ACK = 'state/identity/acme/widget/runs/run-ack.json'

      mockGetRunKey.mockImplementation((_config, _identity, _repo, runId) => {
        if (runId === 'run-exec') return okKey(RUN_KEY_EXEC)
        if (runId === 'run-pend') return okKey(RUN_KEY_PEND)
        if (runId === 'run-ack') return okKey(RUN_KEY_ACK)
        return errKey('unexpected run key')
      })

      const getObjectFn = vi.fn().mockImplementation(async (key: string) => {
        if (key === RUN_KEY_EXEC) return {success: true, data: {data: '{}', etag: 'etag-exec'}}
        if (key === RUN_KEY_PEND) return {success: true, data: {data: '{}', etag: 'etag-pend'}}
        if (key === RUN_KEY_ACK) return {success: true, data: {data: '{}', etag: 'etag-ack'}}
        // Lock belongs to the EXECUTING run
        if (key === LOCK_KEY)
          return {success: true, data: {data: JSON.stringify({run_id: 'run-exec'}), etag: LOCK_ETAG}}
        return {success: false, error: new Error('not found')}
      })
      const coordConfig: CoordinationConfig = {
        ...makeCoordinationConfig(),
        storeAdapter: {...makeCoordinationConfig().storeAdapter, getObject: getObjectFn},
      }

      mockTransitionRun.mockResolvedValue({
        success: true,
        data: {etag: 'new-etag', state: makeStaleRun({phase: 'FAILED'})},
      })

      const deps = makeDeps({coordinationConfig: coordConfig})

      // #when
      await recoverStaleRuns(deps)

      // #then — all three runs transitioned to FAILED
      expect(mockTransitionRun).toHaveBeenCalledTimes(3)
      // Only the EXECUTING run's lock is released (it owns the lock)
      expect(mockReleaseLock).toHaveBeenCalledTimes(1)
    })

    it('regression: existing stale EXECUTING recovery still works after PENDING extension', async () => {
      // #given — a stale EXECUTING run with a held lock (the original recovery path)
      const staleExecuting = makeStaleRun({phase: 'EXECUTING'})
      mockFindStaleRuns.mockResolvedValue({success: true, data: [staleExecuting]})

      const thread = makeThread()
      const resolveThread = makeResolveThread(thread)
      const deps = makeDeps({resolveThread})

      // #when
      await recoverStaleRuns(deps)

      // #then — EXECUTING run transitioned to FAILED, lock released, thread notified
      expect(mockTransitionRun).toHaveBeenCalledWith(
        expect.anything(),
        'discord-gateway',
        REPO_SLUG,
        RUN_ID,
        'FAILED',
        RUN_ETAG,
        expect.anything(),
      )
      expect(mockReleaseLock).toHaveBeenCalledWith(expect.anything(), REPO_SLUG, LOCK_ETAG, expect.anything())
      expect(thread.send).toHaveBeenCalled()
    })
  })

  describe('cancelled-run lock reconciliation', () => {
    it('releases the lock via forceReleaseStaleLock when it is still held by a CANCELLED run', async () => {
      // #given — no other stale runs; a CANCELLED run whose own lock is still live
      mockFindStaleRuns.mockResolvedValue({success: true, data: []})
      const coordinationConfig = makeCancelledLockFixture()
      mockForceReleaseStaleLock.mockResolvedValue({
        success: true,
        data: {
          outcome: 'released',
          holderId: 'discord-gateway',
          runId: RUN_ID,
          lockAgeMs: 999_999,
          heartbeatAgeMs: 999_999,
        },
      })
      const logger = makeLogger()
      const deps = makeDeps({coordinationConfig, logger})

      // #when
      await recoverStaleRuns(deps)

      // #then — release goes through the dead-run-verified path, not a raw releaseLock
      expect(mockForceReleaseStaleLock).toHaveBeenCalledWith(
        coordinationConfig,
        REPO_SLUG,
        'discord-gateway',
        expect.anything(),
      )
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({repo: REPO_SLUG, runId: RUN_ID}),
        expect.stringContaining('released repo lock stranded'),
      )
    })

    it('leaves the lock untouched when it was re-acquired by a newer run (ownership mismatch)', async () => {
      // #given — the lock's run_id no longer matches the CANCELLED run that originally held it
      mockFindStaleRuns.mockResolvedValue({success: true, data: []})
      const coordinationConfig = makeCancelledLockFixture({lockRunId: 'run-newer-999'})
      const deps = makeDeps({coordinationConfig})

      // #when
      await recoverStaleRuns(deps)

      // #then — reconciliation reads run-state for the LOCK's run_id (run-newer-999), which is
      // not the CANCELLED fixture (RUN_ID) — forceReleaseStaleLock must not even be attempted
      expect(mockForceReleaseStaleLock).not.toHaveBeenCalled()
    })

    it('is a no-op when the CANCELLED run holds no lock', async () => {
      // #given — CANCELLED run-state exists, but no lock object for the repo
      mockFindStaleRuns.mockResolvedValue({success: true, data: []})
      const getObjectFn = vi.fn().mockImplementation(async (key: string) => {
        if (key === LOCK_KEY) return {success: false, error: new Error('not found')}
        return {success: false, error: new Error('not found')}
      })
      const base = makeCoordinationConfig()
      const coordinationConfig = {...base, storeAdapter: {...base.storeAdapter, getObject: getObjectFn}}
      const deps = makeDeps({coordinationConfig})

      // #when
      await expect(recoverStaleRuns(deps)).resolves.toBeUndefined()

      // #then
      expect(mockForceReleaseStaleLock).not.toHaveBeenCalled()
    })

    it('continues the sweep when forceReleaseStaleLock errors (fail-soft)', async () => {
      // #given
      mockFindStaleRuns.mockResolvedValue({success: true, data: []})
      const coordinationConfig = makeCancelledLockFixture()
      mockForceReleaseStaleLock.mockResolvedValue({success: false, error: new Error('conditional delete boom')})
      const logger = makeLogger()
      const deps = makeDeps({coordinationConfig, logger})

      // #when — must not throw; startup sweep completes
      await expect(recoverStaleRuns(deps)).resolves.toBeUndefined()

      // #then
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({repo: REPO_SLUG, runId: RUN_ID}),
        expect.stringContaining('forceReleaseStaleLock errored'),
      )
    })

    it('does not attempt reconciliation for a non-CANCELLED terminal run (FAILED) holding the lock', async () => {
      // #given — a lock owned by a FAILED (not CANCELLED) run
      mockFindStaleRuns.mockResolvedValue({success: true, data: []})
      const runStateJson = JSON.stringify({
        run_id: RUN_ID,
        surface: 'discord',
        thread_id: THREAD_ID,
        entity_ref: REPO_SLUG,
        phase: 'FAILED',
        started_at: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
        holder_id: 'discord-gateway',
        details: {},
      })
      const getObjectFn = vi.fn().mockImplementation(async (key: string) => {
        if (key === RUN_KEY) return {success: true, data: {data: runStateJson, etag: RUN_ETAG}}
        if (key === LOCK_KEY) return {success: true, data: {data: JSON.stringify({run_id: RUN_ID}), etag: LOCK_ETAG}}
        return {success: false, error: new Error('not found')}
      })
      const base = makeCoordinationConfig()
      const coordinationConfig = {...base, storeAdapter: {...base.storeAdapter, getObject: getObjectFn}}
      const deps = makeDeps({coordinationConfig})

      // #when
      await recoverStaleRuns(deps)

      // #then — only CANCELLED-held locks are reconciled by this pass
      expect(mockForceReleaseStaleLock).not.toHaveBeenCalled()
    })

    it('does not disturb existing EXECUTING/PENDING/ACKNOWLEDGED recovery when a separate CANCELLED lock is also reconciled', async () => {
      // #given — one stale EXECUTING run (existing path) plus a CANCELLED run's lock is NOT
      // the one held (findStaleRuns path exercises the same repo scan already covered above);
      // here we assert the two passes coexist without interference.
      const staleExecuting = makeStaleRun({phase: 'EXECUTING'})
      mockFindStaleRuns.mockResolvedValue({success: true, data: [staleExecuting]})
      const coordinationConfig = makeCoordinationConfig() // lock owned by RUN_ID, run-state is '{}' (not CANCELLED)
      const deps = makeDeps({coordinationConfig})

      // #when
      await recoverStaleRuns(deps)

      // #then — existing EXECUTING recovery still fires; cancelled-lock pass is a no-op (parse fails)
      expect(mockTransitionRun).toHaveBeenCalled()
      expect(mockReleaseLock).toHaveBeenCalled()
      expect(mockForceReleaseStaleLock).not.toHaveBeenCalled()
    })
  })

  describe('integration — boot with stale run and held lock', () => {
    it('leaves run as FAILED and lock released so a new mention can proceed', async () => {
      // #given — simulate a stale EXECUTING run with a held lock
      const staleRun = makeStaleRun()
      mockFindStaleRuns.mockResolvedValue({success: true, data: [staleRun]})
      mockTransitionRun.mockResolvedValue({
        success: true,
        data: {etag: 'new-etag', state: {...staleRun, phase: 'FAILED'}},
      })
      mockReleaseLock.mockResolvedValue({success: true, data: undefined})

      const thread = makeThread()
      const deps = makeDeps({resolveThread: makeResolveThread(thread)})

      // #when
      await recoverStaleRuns(deps)

      // #then — state is FAILED, lock is released, thread notified
      expect(mockTransitionRun).toHaveBeenCalledWith(
        expect.anything(),
        'discord-gateway',
        REPO_SLUG,
        RUN_ID,
        'FAILED',
        RUN_ETAG,
        expect.anything(),
      )
      expect(mockReleaseLock).toHaveBeenCalledWith(expect.anything(), REPO_SLUG, LOCK_ETAG, expect.anything())
      expect(thread.send).toHaveBeenCalledWith(expect.objectContaining({allowedMentions: {parse: []}}))
    })

    it('skips lock release when fetchLockRecord returns runId: null (unparseable/missing run_id)', async () => {
      // #given — stale run with lock content that has no parseable run_id
      const staleRun = makeStaleRun()
      mockFindStaleRuns.mockResolvedValue({success: true, data: [staleRun]})
      mockTransitionRun.mockResolvedValue({
        success: true,
        data: {etag: 'new-etag', state: {...staleRun, phase: 'FAILED'}},
      })

      // Build a coordination config where the lock content has no run_id field
      const getObjectFn = vi.fn().mockImplementation(async (key: string) => {
        if (key === RUN_KEY) return {success: true, data: {etag: RUN_ETAG, data: JSON.stringify({phase: 'EXECUTING'})}}
        if (key === LOCK_KEY) {
          // Lock exists but has NO run_id — fetchLockRecord will return {etag, runId: null}
          return {success: true, data: {etag: LOCK_ETAG, data: JSON.stringify({holder: 'some-unknown-holder'})}}
        }
        return {success: false, error: new Error('not found')}
      })
      const base = makeCoordinationConfig()
      const coordConfig: CoordinationConfig = {
        ...base,
        storeAdapter: {...base.storeAdapter, getObject: getObjectFn},
      }

      const deps = makeDeps({coordinationConfig: coordConfig})

      // #when
      await recoverStaleRuns(deps)

      // #then — lock release is NOT called (ownership mismatch — runId: null !== stale RUN_ID)
      expect(mockReleaseLock).not.toHaveBeenCalled()
      // #and — transition still happened
      expect(mockTransitionRun).toHaveBeenCalledWith(
        expect.anything(),
        'discord-gateway',
        REPO_SLUG,
        RUN_ID,
        'FAILED',
        RUN_ETAG,
        expect.anything(),
      )
    })
  })
})
