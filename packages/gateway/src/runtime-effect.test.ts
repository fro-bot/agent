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
import {Effect} from 'effect'
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

async function assertEffectFailsWith<E extends Error>(
  effect: Effect.Effect<unknown, E>,
  expectedMessageSubstring: string,
): Promise<void> {
  const result = await Effect.runPromise(Effect.either(effect))
  expect(result._tag).toBe('Left')
  if (result._tag === 'Left') {
    expect(result.left).toBeInstanceOf(Error)
    expect((result.left as Error).message).toContain(expectedMessageSubstring)
  }
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
  // eslint-disable-next-line vitest/expect-expect
  it('fails with error when Result is failure', async () => {
    vi.mocked(acquireLock).mockResolvedValue(err(new Error('lock conflict')))

    await assertEffectFailsWith(
      acquireLockEffect(config, 'repo', 'holder', 'discord', 'run-1', coordLogger),
      'lock conflict',
    )
  })

  // #given underlying throws
  // #when Effect runs
  // #then fails with wrapped error
  // eslint-disable-next-line vitest/expect-expect
  it('fails when underlying function throws', async () => {
    vi.mocked(acquireLock).mockRejectedValue(new Error('network error'))

    await assertEffectFailsWith(
      acquireLockEffect(config, 'repo', 'holder', 'discord', 'run-1', coordLogger),
      'network error',
    )
  })

  // eslint-disable-next-line vitest/expect-expect
  it('preserves the error message when Result is failure', async () => {
    vi.mocked(acquireLock).mockResolvedValue(err(new Error('lock conflict')))

    await assertEffectFailsWith(
      acquireLockEffect(config, 'repo', 'holder', 'discord', 'run-1', coordLogger),
      'lock conflict',
    )
  })

  // eslint-disable-next-line vitest/expect-expect
  it('wraps non-Error rejections into an Error instance', async () => {
    vi.mocked(acquireLock).mockRejectedValue('oops')

    await assertEffectFailsWith(acquireLockEffect(config, 'repo', 'holder', 'discord', 'run-1', coordLogger), 'oops')
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

  // eslint-disable-next-line vitest/expect-expect
  it('fails with error when Result is failure', async () => {
    vi.mocked(releaseLock).mockResolvedValue(err(new Error('delete failed')))

    await assertEffectFailsWith(releaseLockEffect(config, 'repo', 'etag-1', coordLogger), 'delete failed')
  })

  // eslint-disable-next-line vitest/expect-expect
  it('fails when underlying function throws', async () => {
    vi.mocked(releaseLock).mockRejectedValue(new Error('boom'))

    await assertEffectFailsWith(releaseLockEffect(config, 'repo', 'etag-1', coordLogger), 'boom')
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

  // eslint-disable-next-line vitest/expect-expect
  it('fails with error when Result is failure', async () => {
    vi.mocked(renewLease).mockResolvedValue(err(new Error('precondition failed')))

    await assertEffectFailsWith(
      renewLeaseEffect(config, 'repo', lockRecord, 'old-etag', coordLogger),
      'precondition failed',
    )
  })

  // eslint-disable-next-line vitest/expect-expect
  it('fails when underlying function throws', async () => {
    vi.mocked(renewLease).mockRejectedValue('string error')

    await assertEffectFailsWith(renewLeaseEffect(config, 'repo', lockRecord, 'old-etag', coordLogger), 'string error')
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

  // eslint-disable-next-line vitest/expect-expect
  it('fails with error when Result is failure', async () => {
    vi.mocked(forceReleaseLock).mockResolvedValue(err(new Error('force delete failed')))

    await assertEffectFailsWith(forceReleaseLockEffect(config, 'repo', 'etag-1', coordLogger), 'force delete failed')
  })

  // eslint-disable-next-line vitest/expect-expect
  it('fails when underlying function throws', async () => {
    vi.mocked(forceReleaseLock).mockRejectedValue(new Error('boom'))

    await assertEffectFailsWith(forceReleaseLockEffect(config, 'repo', 'etag-1', coordLogger), 'boom')
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

  // eslint-disable-next-line vitest/expect-expect
  it('fails with error when Result is failure', async () => {
    vi.mocked(createRun).mockResolvedValue(err(new Error('already exists')))

    await assertEffectFailsWith(createRunEffect(config, 'identity', 'repo', runState, coordLogger), 'already exists')
  })

  // eslint-disable-next-line vitest/expect-expect
  it('fails when underlying function throws', async () => {
    vi.mocked(createRun).mockRejectedValue(new Error('network'))

    await assertEffectFailsWith(createRunEffect(config, 'identity', 'repo', runState, coordLogger), 'network')
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

  // eslint-disable-next-line vitest/expect-expect
  it('fails with error when Result is failure', async () => {
    vi.mocked(transitionRun).mockResolvedValue(err(new Error('invalid transition')))

    await assertEffectFailsWith(
      transitionRunEffect(config, 'identity', 'repo', 'run-1', 'ACKNOWLEDGED', 'etag-1', coordLogger),
      'invalid transition',
    )
  })

  // eslint-disable-next-line vitest/expect-expect
  it('fails when underlying function throws', async () => {
    vi.mocked(transitionRun).mockRejectedValue(new Error('timeout'))

    await assertEffectFailsWith(
      transitionRunEffect(config, 'identity', 'repo', 'run-1', 'ACKNOWLEDGED', 'etag-1', coordLogger),
      'timeout',
    )
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

  // eslint-disable-next-line vitest/expect-expect
  it('fails with error when Result is failure', async () => {
    vi.mocked(findStaleRuns).mockResolvedValue(err(new Error('list failed')))

    await assertEffectFailsWith(findStaleRunsEffect(config, 'identity', 'repo', coordLogger), 'list failed')
  })

  // eslint-disable-next-line vitest/expect-expect
  it('fails when underlying function throws', async () => {
    vi.mocked(findStaleRuns).mockRejectedValue(new Error('boom'))

    await assertEffectFailsWith(findStaleRunsEffect(config, 'identity', 'repo', coordLogger), 'boom')
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

  // eslint-disable-next-line vitest/expect-expect
  it('fails with error when Result is failure', async () => {
    vi.mocked(validateProviderSemantics).mockResolvedValue(err(new Error('semantics check failed')))

    await assertEffectFailsWith(validateProviderSemanticsEffect(config, coordLogger), 'semantics check failed')
  })

  // eslint-disable-next-line vitest/expect-expect
  it('fails when underlying function throws', async () => {
    vi.mocked(validateProviderSemantics).mockRejectedValue(new Error('provider unreachable'))

    await assertEffectFailsWith(validateProviderSemanticsEffect(config, coordLogger), 'provider unreachable')
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

  // eslint-disable-next-line vitest/expect-expect
  it('fails when underlying function throws', async () => {
    vi.mocked(syncSessionsToStore).mockRejectedValue(new Error('upload error'))

    await assertEffectFailsWith(
      syncSessionsToStoreEffect(adapter, storeConfig, 'identity', 'repo', '/sessions', logger),
      'upload error',
    )
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

  // eslint-disable-next-line vitest/expect-expect
  it('fails when underlying function throws', async () => {
    vi.mocked(syncSessionsFromStore).mockRejectedValue(new Error('download error'))

    await assertEffectFailsWith(
      syncSessionsFromStoreEffect(adapter, storeConfig, 'identity', 'repo', '/sessions', logger),
      'download error',
    )
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

  // eslint-disable-next-line vitest/expect-expect
  it('fails when underlying function throws', async () => {
    vi.mocked(syncArtifactsToStore).mockRejectedValue(new Error('artifact error'))

    await assertEffectFailsWith(
      syncArtifactsToStoreEffect(adapter, storeConfig, 'identity', 'repo', 'run-1', '/logs', logger),
      'artifact error',
    )
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

  // eslint-disable-next-line vitest/expect-expect
  it('fails when underlying function throws', async () => {
    vi.mocked(syncMetadataToStore).mockRejectedValue(new Error('metadata error'))

    await assertEffectFailsWith(
      syncMetadataToStoreEffect(adapter, storeConfig, 'identity', 'repo', 'run-1', {key: 'val'}, logger),
      'metadata error',
    )
  })
})
