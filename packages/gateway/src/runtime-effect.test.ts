/**
 * Tests for runtime-effect.ts — Effect adapters over @fro-bot/runtime functions.
 *
 * Strategy: vi.mock('@fro-bot/runtime') so we never touch real S3/coordination
 * infrastructure. Each wrapper is tested for:
 *   1. Happy path — Result{success:true} resolves the Effect to data
 *   2. Error path — Result{success:false} fails the Effect with the error
 *   3. Promise rejection — thrown error is caught and wrapped as Effect failure
 *
 * S3 sync helpers (plain Promise, no Result tag) are tested for (1) and (3) only.
 *
 * We use Effect.runPromiseExit to inspect Exit without throwing.
 */

import {
  acquireLock,
  createRun,
  findStaleRuns,
  forceReleaseLock,
  releaseLock,
  renewLease,
  syncArtifactsToStore,
  syncMetadataToStore,
  syncSessionsFromStore,
  syncSessionsToStore,
  transitionRun,
  validateProviderSemantics,
} from '@fro-bot/runtime'
import {Effect, Exit} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import {
  acquireLockEffect,
  createRunEffect,
  findStaleRunsEffect,
  forceReleaseLockEffect,
  releaseLockEffect,
  renewLeaseEffect,
  syncArtifactsToStoreEffect,
  syncMetadataToStoreEffect,
  syncSessionsFromStoreEffect,
  syncSessionsToStoreEffect,
  transitionRunEffect,
  validateProviderSemanticsEffect,
} from './runtime-effect.js'

// vi.mock is hoisted by vitest to the top of the module at runtime,
// so this intercepts @fro-bot/runtime before any test code runs.
vi.mock('@fro-bot/runtime', () => ({
  acquireLock: vi.fn(),
  createRun: vi.fn(),
  findStaleRuns: vi.fn(),
  forceReleaseLock: vi.fn(),
  releaseLock: vi.fn(),
  renewLease: vi.fn(),
  syncArtifactsToStore: vi.fn(),
  syncMetadataToStore: vi.fn(),
  syncSessionsFromStore: vi.fn(),
  syncSessionsToStore: vi.fn(),
  transitionRun: vi.fn(),
  validateProviderSemantics: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const noop = () => {}
const logger = {debug: noop, info: noop, warning: noop, error: noop}
const coordLogger = {debug: noop}

// Minimal CoordinationConfig stub — only shape matters for mocked calls
const config = {} as Parameters<typeof acquireLockEffect>[0]
const adapter = {} as Parameters<typeof syncSessionsToStoreEffect>[0]
const storeConfig = {} as Parameters<typeof syncSessionsToStoreEffect>[1]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok<T>(data: T) {
  return {success: true as const, data}
}

function err(error: Error) {
  return {success: false as const, error}
}

// ---------------------------------------------------------------------------
// acquireLockEffect
// ---------------------------------------------------------------------------

describe('acquireLockEffect', () => {
  beforeEach(() => vi.resetAllMocks())

  // #given underlying returns success
  // #when Effect runs
  // #then resolves to data
  it('resolves to LockAcquisitionResult on success', async () => {
    const data = {acquired: true, etag: 'abc', holder: null}
    vi.mocked(acquireLock).mockResolvedValue(ok(data))

    const exit = await Effect.runPromiseExit(
      acquireLockEffect(config, 'repo', 'holder', 'discord', 'run-1', coordLogger),
    )

    expect(exit).toMatchObject({_tag: 'Success', value: data})
  })

  // #given underlying returns failure Result
  // #when Effect runs
  // #then fails with the error
  it('fails with error when Result is failure', async () => {
    const error = new Error('lock conflict')
    vi.mocked(acquireLock).mockResolvedValue(err(error))

    const exit = await Effect.runPromiseExit(
      acquireLockEffect(config, 'repo', 'holder', 'discord', 'run-1', coordLogger),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  // #given underlying throws
  // #when Effect runs
  // #then fails with wrapped error
  it('fails when underlying function throws', async () => {
    vi.mocked(acquireLock).mockRejectedValue(new Error('network error'))

    const exit = await Effect.runPromiseExit(
      acquireLockEffect(config, 'repo', 'holder', 'discord', 'run-1', coordLogger),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// releaseLockEffect
// ---------------------------------------------------------------------------

describe('releaseLockEffect', () => {
  beforeEach(() => vi.resetAllMocks())

  it('resolves to void on success', async () => {
    vi.mocked(releaseLock).mockResolvedValue(ok(undefined))

    const exit = await Effect.runPromiseExit(releaseLockEffect(config, 'repo', 'etag-1', coordLogger))

    expect(exit).toMatchObject({_tag: 'Success'})
  })

  it('fails with error when Result is failure', async () => {
    const error = new Error('delete failed')
    vi.mocked(releaseLock).mockResolvedValue(err(error))

    const exit = await Effect.runPromiseExit(releaseLockEffect(config, 'repo', 'etag-1', coordLogger))

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('fails when underlying function throws', async () => {
    vi.mocked(releaseLock).mockRejectedValue(new Error('boom'))

    const exit = await Effect.runPromiseExit(releaseLockEffect(config, 'repo', 'etag-1', coordLogger))

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// renewLeaseEffect
// ---------------------------------------------------------------------------

describe('renewLeaseEffect', () => {
  beforeEach(() => vi.resetAllMocks())

  const lockRecord = {
    repo: 'repo',
    holder_id: 'holder',
    surface: 'discord' as const,
    acquired_at: new Date().toISOString(),
    ttl_seconds: 60,
    run_id: 'run-1',
  }

  it('resolves to {etag} on success', async () => {
    vi.mocked(renewLease).mockResolvedValue(ok({etag: 'new-etag'}))

    const exit = await Effect.runPromiseExit(renewLeaseEffect(config, 'repo', lockRecord, 'old-etag', coordLogger))

    expect(exit).toMatchObject({_tag: 'Success', value: {etag: 'new-etag'}})
  })

  it('fails with error when Result is failure', async () => {
    vi.mocked(renewLease).mockResolvedValue(err(new Error('precondition failed')))

    const exit = await Effect.runPromiseExit(renewLeaseEffect(config, 'repo', lockRecord, 'old-etag', coordLogger))

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('fails when underlying function throws', async () => {
    vi.mocked(renewLease).mockRejectedValue('string error')

    const exit = await Effect.runPromiseExit(renewLeaseEffect(config, 'repo', lockRecord, 'old-etag', coordLogger))

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// forceReleaseLockEffect
// ---------------------------------------------------------------------------

describe('forceReleaseLockEffect', () => {
  beforeEach(() => vi.resetAllMocks())

  it('resolves to void on success', async () => {
    vi.mocked(forceReleaseLock).mockResolvedValue(ok(undefined))

    const exit = await Effect.runPromiseExit(forceReleaseLockEffect(config, 'repo', 'etag-1', coordLogger))

    expect(exit).toMatchObject({_tag: 'Success'})
  })

  it('fails with error when Result is failure', async () => {
    vi.mocked(forceReleaseLock).mockResolvedValue(err(new Error('force delete failed')))

    const exit = await Effect.runPromiseExit(forceReleaseLockEffect(config, 'repo', 'etag-1', coordLogger))

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('fails when underlying function throws', async () => {
    vi.mocked(forceReleaseLock).mockRejectedValue(new Error('boom'))

    const exit = await Effect.runPromiseExit(forceReleaseLockEffect(config, 'repo', 'etag-1', coordLogger))

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createRunEffect
// ---------------------------------------------------------------------------

describe('createRunEffect', () => {
  beforeEach(() => vi.resetAllMocks())

  const runState = {
    run_id: 'run-1',
    surface: 'discord' as const,
    thread_id: 'thread-1',
    entity_ref: 'ref-1',
    phase: 'PENDING' as const,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    holder_id: 'holder',
    details: {},
  }

  it('resolves to {etag} on success', async () => {
    vi.mocked(createRun).mockResolvedValue(ok({etag: 'etag-1'}))

    const exit = await Effect.runPromiseExit(createRunEffect(config, 'identity', 'repo', runState, coordLogger))

    expect(exit).toMatchObject({_tag: 'Success', value: {etag: 'etag-1'}})
  })

  it('fails with error when Result is failure', async () => {
    vi.mocked(createRun).mockResolvedValue(err(new Error('already exists')))

    const exit = await Effect.runPromiseExit(createRunEffect(config, 'identity', 'repo', runState, coordLogger))

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('fails when underlying function throws', async () => {
    vi.mocked(createRun).mockRejectedValue(new Error('network'))

    const exit = await Effect.runPromiseExit(createRunEffect(config, 'identity', 'repo', runState, coordLogger))

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// transitionRunEffect
// ---------------------------------------------------------------------------

describe('transitionRunEffect', () => {
  beforeEach(() => vi.resetAllMocks())

  const nextState = {
    run_id: 'run-1',
    surface: 'discord' as const,
    thread_id: 'thread-1',
    entity_ref: 'ref-1',
    phase: 'ACKNOWLEDGED' as const,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    holder_id: 'holder',
    details: {},
  }

  it('resolves to {etag, state} on success', async () => {
    vi.mocked(transitionRun).mockResolvedValue(ok({etag: 'etag-2', state: nextState}))

    const exit = await Effect.runPromiseExit(
      transitionRunEffect(config, 'identity', 'repo', 'run-1', 'ACKNOWLEDGED', 'etag-1', coordLogger),
    )

    expect(exit).toMatchObject({_tag: 'Success', value: {etag: 'etag-2', state: {phase: 'ACKNOWLEDGED'}}})
  })

  it('fails with error when Result is failure', async () => {
    vi.mocked(transitionRun).mockResolvedValue(err(new Error('invalid transition')))

    const exit = await Effect.runPromiseExit(
      transitionRunEffect(config, 'identity', 'repo', 'run-1', 'ACKNOWLEDGED', 'etag-1', coordLogger),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('fails when underlying function throws', async () => {
    vi.mocked(transitionRun).mockRejectedValue(new Error('timeout'))

    const exit = await Effect.runPromiseExit(
      transitionRunEffect(config, 'identity', 'repo', 'run-1', 'ACKNOWLEDGED', 'etag-1', coordLogger),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// findStaleRunsEffect
// ---------------------------------------------------------------------------

describe('findStaleRunsEffect', () => {
  beforeEach(() => vi.resetAllMocks())

  it('resolves to RunState[] on success', async () => {
    vi.mocked(findStaleRuns).mockResolvedValue(ok([]))

    const exit = await Effect.runPromiseExit(findStaleRunsEffect(config, 'identity', 'repo', coordLogger))

    expect(exit).toMatchObject({_tag: 'Success', value: []})
  })

  it('fails with error when Result is failure', async () => {
    vi.mocked(findStaleRuns).mockResolvedValue(err(new Error('list failed')))

    const exit = await Effect.runPromiseExit(findStaleRunsEffect(config, 'identity', 'repo', coordLogger))

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('fails when underlying function throws', async () => {
    vi.mocked(findStaleRuns).mockRejectedValue(new Error('boom'))

    const exit = await Effect.runPromiseExit(findStaleRunsEffect(config, 'identity', 'repo', coordLogger))

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// validateProviderSemanticsEffect
// ---------------------------------------------------------------------------

describe('validateProviderSemanticsEffect', () => {
  beforeEach(() => vi.resetAllMocks())

  it('resolves to void on success', async () => {
    vi.mocked(validateProviderSemantics).mockResolvedValue(ok(undefined))

    const exit = await Effect.runPromiseExit(validateProviderSemanticsEffect(config, coordLogger))

    expect(exit).toMatchObject({_tag: 'Success'})
  })

  it('fails with error when Result is failure', async () => {
    vi.mocked(validateProviderSemantics).mockResolvedValue(err(new Error('semantics check failed')))

    const exit = await Effect.runPromiseExit(validateProviderSemanticsEffect(config, coordLogger))

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('fails when underlying function throws', async () => {
    vi.mocked(validateProviderSemantics).mockRejectedValue(new Error('provider unreachable'))

    const exit = await Effect.runPromiseExit(validateProviderSemanticsEffect(config, coordLogger))

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// S3 sync helpers — plain Promise (no Result tag), test (1) and (3) only
// ---------------------------------------------------------------------------

describe('syncSessionsToStoreEffect', () => {
  beforeEach(() => vi.resetAllMocks())

  it('resolves to {uploaded, failed} on success', async () => {
    vi.mocked(syncSessionsToStore).mockResolvedValue({uploaded: 2, failed: 0})

    const exit = await Effect.runPromiseExit(
      syncSessionsToStoreEffect(adapter, storeConfig, 'identity', 'repo', '/sessions', logger),
    )

    expect(exit).toMatchObject({_tag: 'Success', value: {uploaded: 2, failed: 0}})
  })

  it('fails when underlying function throws', async () => {
    vi.mocked(syncSessionsToStore).mockRejectedValue(new Error('upload error'))

    const exit = await Effect.runPromiseExit(
      syncSessionsToStoreEffect(adapter, storeConfig, 'identity', 'repo', '/sessions', logger),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('syncSessionsFromStoreEffect', () => {
  beforeEach(() => vi.resetAllMocks())

  it('resolves to {downloaded, failed, mainDbRestored} on success', async () => {
    vi.mocked(syncSessionsFromStore).mockResolvedValue({downloaded: 3, failed: 0, mainDbRestored: true})

    const exit = await Effect.runPromiseExit(
      syncSessionsFromStoreEffect(adapter, storeConfig, 'identity', 'repo', '/sessions', logger),
    )

    expect(exit).toMatchObject({_tag: 'Success', value: {downloaded: 3, failed: 0, mainDbRestored: true}})
  })

  it('fails when underlying function throws', async () => {
    vi.mocked(syncSessionsFromStore).mockRejectedValue(new Error('download error'))

    const exit = await Effect.runPromiseExit(
      syncSessionsFromStoreEffect(adapter, storeConfig, 'identity', 'repo', '/sessions', logger),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('syncArtifactsToStoreEffect', () => {
  beforeEach(() => vi.resetAllMocks())

  it('resolves to {uploaded, failed} on success', async () => {
    vi.mocked(syncArtifactsToStore).mockResolvedValue({uploaded: 1, failed: 0})

    const exit = await Effect.runPromiseExit(
      syncArtifactsToStoreEffect(adapter, storeConfig, 'identity', 'repo', 'run-1', '/logs', logger),
    )

    expect(exit).toMatchObject({_tag: 'Success', value: {uploaded: 1, failed: 0}})
  })

  it('fails when underlying function throws', async () => {
    vi.mocked(syncArtifactsToStore).mockRejectedValue(new Error('artifact error'))

    const exit = await Effect.runPromiseExit(
      syncArtifactsToStoreEffect(adapter, storeConfig, 'identity', 'repo', 'run-1', '/logs', logger),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('syncMetadataToStoreEffect', () => {
  beforeEach(() => vi.resetAllMocks())

  it('resolves to {success} on success', async () => {
    vi.mocked(syncMetadataToStore).mockResolvedValue({success: true})

    const exit = await Effect.runPromiseExit(
      syncMetadataToStoreEffect(adapter, storeConfig, 'identity', 'repo', 'run-1', {key: 'val'}, logger),
    )

    expect(exit).toMatchObject({_tag: 'Success', value: {success: true}})
  })

  it('fails when underlying function throws', async () => {
    vi.mocked(syncMetadataToStore).mockRejectedValue(new Error('metadata error'))

    const exit = await Effect.runPromiseExit(
      syncMetadataToStoreEffect(adapter, storeConfig, 'identity', 'repo', 'run-1', {key: 'val'}, logger),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})
