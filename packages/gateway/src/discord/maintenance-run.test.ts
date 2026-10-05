import type {CoordinationConfig} from '@fro-bot/runtime'
import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

const mockHeartbeat = {start: vi.fn(), stop: vi.fn(), isRunning: false}
const mockAcquireLockEffect = vi.fn()
const mockCreateRunEffect = vi.fn()
const mockTransitionRunEffect = vi.fn()
const mockReleaseLockEffect = vi.fn()

vi.mock('../runtime-effect.js', () => ({
  createHeartbeatController: vi.fn(() => mockHeartbeat),
  acquireLockEffect: (...args: unknown[]): unknown => mockAcquireLockEffect(...args) as unknown,
  createRunEffect: (...args: unknown[]): unknown => mockCreateRunEffect(...args) as unknown,
  transitionRunEffect: (...args: unknown[]): unknown => mockTransitionRunEffect(...args) as unknown,
  releaseLockEffect: (...args: unknown[]): unknown => mockReleaseLockEffect(...args) as unknown,
}))

const {acquireMaintenanceRun} = await import('./maintenance-run.js')

const CONFIG = {} as CoordinationConfig
const LOGGER = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
const CHECK = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mockHeartbeat.stop.mockResolvedValue({
    success: true,
    data: {runEtag: 'run-etag-2', lockEtag: 'lock-etag-2', runState: {}},
  })
  mockAcquireLockEffect.mockReturnValue(
    Effect.succeed({acquired: true as const, outcome: 'acquired' as const, etag: 'lock-etag-1', holder: null}),
  )
  mockCreateRunEffect.mockReturnValue(Effect.succeed({etag: 'run-etag-1'}))
  mockTransitionRunEffect.mockReturnValue(Effect.succeed({etag: 'run-etag-3', state: {}}))
  mockReleaseLockEffect.mockReturnValue(Effect.succeed(undefined))
})

describe('acquireMaintenanceRun', () => {
  it('acquired: locks, creates the run, starts the heartbeat', async () => {
    // #given — default mocks: lock acquired

    // #when
    const result = await Effect.runPromise(
      acquireMaintenanceRun({
        coordinationConfig: CONFIG,
        identity: 'gw',
        repo: 'acme/widget',
        kind: 'recover-checkout',
        logger: LOGGER,
        checkRepoQuiescence: CHECK,
      }),
    )

    // #then
    expect(result.outcome).toBe('acquired')
    expect(mockHeartbeat.start).toHaveBeenCalledOnce()
    expect(mockCreateRunEffect.mock.calls[0]?.[3]).toMatchObject({
      phase: 'EXECUTING',
      details: {kind: 'recover-checkout'},
    })
  })

  it('lock-held: names the holder, never creates a run or starts a heartbeat', async () => {
    // #given — an active holder owns the lock
    mockAcquireLockEffect.mockReturnValue(
      Effect.succeed({
        acquired: false as const,
        outcome: 'active-holder' as const,
        etag: null,
        holder: {holder_id: 'other-gw'} as never,
      }),
    )

    // #when
    const result = await Effect.runPromise(
      acquireMaintenanceRun({
        coordinationConfig: CONFIG,
        identity: 'gw',
        repo: 'acme/widget',
        kind: 'recover-checkout',
        logger: LOGGER,
        checkRepoQuiescence: CHECK,
      }),
    )

    // #then
    expect(result).toEqual({outcome: 'lock-held', holderId: 'other-gw'})
    expect(mockCreateRunEffect).not.toHaveBeenCalled()
    expect(mockHeartbeat.start).not.toHaveBeenCalled()
  })

  it('passes the shared workspace checker to acquisition as the expired-holder corroborator', async () => {
    // #given — default mocks

    // #when
    await Effect.runPromise(
      acquireMaintenanceRun({
        coordinationConfig: CONFIG,
        identity: 'gw',
        repo: 'acme/widget',
        kind: 'recover-checkout',
        logger: LOGGER,
        checkRepoQuiescence: CHECK,
      }),
    )

    // #then
    expect(mockAcquireLockEffect.mock.calls[0]?.[6]).toEqual({confirmExpiredHolder: CHECK})
  })

  it.each([
    [
      'busy',
      {kind: 'busy', source: 'opencode-session-status', directory: '/d', checkedAt: 't', sessionIds: ['s']},
      'workspace-busy',
    ],
    ['unknown', {kind: 'unknown', source: 'unavailable', directory: null, reason: 'x'}, 'workspace-unknown'],
  ])(
    'blocked (%s): returns a named block without creating a run or heartbeat',
    async (_label, confirmation, reason) => {
      // #given — acquisition reports an expired holder the workspace check could not clear
      mockAcquireLockEffect.mockReturnValue(
        Effect.succeed({
          acquired: false as const,
          outcome: 'expired-holder' as const,
          etag: null,
          holder: {holder_id: 'other-gw'} as never,
          confirmation: confirmation as never,
        }),
      )

      // #when
      const result = await Effect.runPromise(
        acquireMaintenanceRun({
          coordinationConfig: CONFIG,
          identity: 'gw',
          repo: 'acme/widget',
          kind: 'recover-checkout',
          logger: LOGGER,
          checkRepoQuiescence: CHECK,
        }),
      )

      // #then
      expect(result).toEqual({outcome: 'blocked', reason})
      expect(mockCreateRunEffect).not.toHaveBeenCalled()
      expect(mockHeartbeat.start).not.toHaveBeenCalled()
    },
  )

  it('acquireLock error surfaces as outcome: error', async () => {
    // #given
    mockAcquireLockEffect.mockReturnValue(Effect.fail(new Error('store unreachable')))

    // #when
    const result = await Effect.runPromise(
      acquireMaintenanceRun({
        coordinationConfig: CONFIG,
        identity: 'gw',
        repo: 'acme/widget',
        kind: 'recover-checkout',
        logger: LOGGER,
        checkRepoQuiescence: CHECK,
      }),
    )

    // #then
    expect(result).toEqual({outcome: 'error', message: 'store unreachable'})
  })

  it('createRun failure releases the just-acquired lock before returning error', async () => {
    // #given
    mockCreateRunEffect.mockReturnValue(Effect.fail(new Error('conflict')))

    // #when
    const result = await Effect.runPromise(
      acquireMaintenanceRun({
        coordinationConfig: CONFIG,
        identity: 'gw',
        repo: 'acme/widget',
        kind: 'recover-checkout',
        logger: LOGGER,
        checkRepoQuiescence: CHECK,
      }),
    )

    // #then
    expect(result).toEqual({outcome: 'error', message: 'conflict'})
    expect(mockReleaseLockEffect).toHaveBeenCalledWith(CONFIG, 'acme/widget', 'lock-etag-1', expect.anything())
  })

  it('release: stops heartbeat, transitions to the terminal phase with detailsPatch, then releases with the post-heartbeat etag', async () => {
    // #given — an acquired maintenance run
    const result = await Effect.runPromise(
      acquireMaintenanceRun({
        coordinationConfig: CONFIG,
        identity: 'gw',
        repo: 'acme/widget',
        kind: 'recover-checkout',
        logger: LOGGER,
        checkRepoQuiescence: CHECK,
      }),
    )
    if (result.outcome !== 'acquired') throw new Error('expected acquired')

    // #when
    await Effect.runPromise(result.handle.release('COMPLETED', {outcome: 'success'}))

    // #then
    expect(mockHeartbeat.stop).toHaveBeenCalledOnce()
    expect(mockTransitionRunEffect).toHaveBeenCalledWith(
      CONFIG,
      'gw',
      'acme/widget',
      result.handle.runId,
      'COMPLETED',
      'run-etag-2',
      expect.anything(),
      {detailsPatch: {outcome: 'success'}},
    )
    expect(mockReleaseLockEffect).toHaveBeenCalledWith(CONFIG, 'acme/widget', 'lock-etag-2', expect.anything())
  })

  it('release: a heartbeat.stop failure still transitions and releases, using the original etags', async () => {
    // #given — heartbeat.stop fails
    mockHeartbeat.stop.mockResolvedValue({success: false, error: new Error('stop failed')})
    const result = await Effect.runPromise(
      acquireMaintenanceRun({
        coordinationConfig: CONFIG,
        identity: 'gw',
        repo: 'acme/widget',
        kind: 'recover-checkout',
        logger: LOGGER,
        checkRepoQuiescence: CHECK,
      }),
    )
    if (result.outcome !== 'acquired') throw new Error('expected acquired')

    // #when
    await Effect.runPromise(result.handle.release('FAILED'))

    // #then
    expect(mockTransitionRunEffect).toHaveBeenCalledWith(
      CONFIG,
      'gw',
      'acme/widget',
      result.handle.runId,
      'FAILED',
      'run-etag-1',
      expect.anything(),
      undefined,
    )
    expect(mockReleaseLockEffect).toHaveBeenCalledWith(CONFIG, 'acme/widget', 'lock-etag-1', expect.anything())
  })
})
