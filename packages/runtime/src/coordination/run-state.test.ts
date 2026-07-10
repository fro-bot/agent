import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'
import type {Logger} from '../shared/logger.js'
import type {CoordinationConfig, RunState} from './types.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {err, ok} from '../shared/types.js'
import {createRun, findStaleRuns, parseRunState, transitionRun} from './run-state.js'

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function createStoreConfig(): ObjectStoreConfig {
  return {
    enabled: true,
    bucket: 'test-bucket',
    region: 'us-east-1',
    prefix: 'fro-bot-state',
  }
}

function createRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: 'run-1',
    surface: 'discord',
    thread_id: 'thread-1',
    entity_ref: 'owner/repo#123',
    phase: 'PENDING',
    started_at: '2026-04-24T18:00:00.000Z',
    last_heartbeat: '2026-04-24T18:00:00.000Z',
    holder_id: 'gateway-1',
    details: {},
    ...overrides,
  }
}

function createStoreAdapter(overrides: Partial<Required<ObjectStoreAdapter>> = {}): Required<ObjectStoreAdapter> {
  return {
    upload: vi.fn(async () => ok(undefined)),
    download: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok([])),
    conditionalPut: vi.fn(async () => ok({etag: 'etag-1'})),
    conditionalDelete: vi.fn(async () => ok(undefined)),
    getObject: vi.fn(async () => ok({data: JSON.stringify(createRunState()), etag: 'etag-1'})),
    listWithMetadata: vi.fn(async () => ok([])),
    ...overrides,
  }
}

function createCoordinationConfig(storeAdapter: Required<ObjectStoreAdapter>): CoordinationConfig {
  return {
    storeAdapter,
    storeConfig: createStoreConfig(),
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  }
}

// ---------------------------------------------------------------------------
// Surface widening — web surface validation
// ---------------------------------------------------------------------------

describe('parseRunState — surface validation', () => {
  it("accepts surface: 'github'", () => {
    // #given a run-state with github surface
    const state = {
      run_id: 'run-1',
      surface: 'github',
      thread_id: 'thread-1',
      entity_ref: 'owner/repo#123',
      phase: 'PENDING',
      started_at: '2026-04-24T18:00:00.000Z',
      last_heartbeat: '2026-04-24T18:00:00.000Z',
      holder_id: 'gateway-1',
      details: {},
    }

    // #when parsed
    const result = parseRunState(JSON.stringify(state))

    // #then valid
    expect(result.success).toBe(true)
  })

  it("accepts surface: 'discord'", () => {
    // #given a run-state with discord surface
    const state = {
      run_id: 'run-1',
      surface: 'discord',
      thread_id: 'thread-1',
      entity_ref: 'owner/repo#123',
      phase: 'PENDING',
      started_at: '2026-04-24T18:00:00.000Z',
      last_heartbeat: '2026-04-24T18:00:00.000Z',
      holder_id: 'gateway-1',
      details: {},
    }

    // #when parsed
    const result = parseRunState(JSON.stringify(state))

    // #then valid
    expect(result.success).toBe(true)
  })

  it("accepts surface: 'web' (web surface widening)", () => {
    // #given a run-state with web surface
    const state = {
      run_id: 'run-1',
      surface: 'web',
      thread_id: '',
      entity_ref: 'owner/repo#123',
      phase: 'PENDING',
      started_at: '2026-04-24T18:00:00.000Z',
      last_heartbeat: '2026-04-24T18:00:00.000Z',
      holder_id: 'gateway-1',
      details: {},
    }

    // #when parsed
    const result = parseRunState(JSON.stringify(state))

    // #then valid — web is a recognized surface
    expect(result.success).toBe(true)
  })

  it("rejects an unknown surface: 'ftp'", () => {
    // #given a run-state with an unknown surface
    const state = {
      run_id: 'run-1',
      surface: 'ftp',
      thread_id: 'thread-1',
      entity_ref: 'owner/repo#123',
      phase: 'PENDING',
      started_at: '2026-04-24T18:00:00.000Z',
      last_heartbeat: '2026-04-24T18:00:00.000Z',
      holder_id: 'gateway-1',
      details: {},
    }

    // #when parsed
    const result = parseRunState(JSON.stringify(state))

    // #then invalid — unknown surface is rejected
    expect(result.success).toBe(false)
  })
})

describe('run-state coordination', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T18:15:00.000Z'))
  })

  it('creates a pending run-state record', async () => {
    // #given
    const storeAdapter = createStoreAdapter()
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()
    const runState = createRunState()

    // #when
    const result = await createRun(config, 'coordination', 'owner/repo', runState, logger)

    // #then
    expect(result).toEqual(ok({etag: 'etag-1'}))
    expect(storeAdapter.conditionalPut).toHaveBeenCalledWith(
      'fro-bot-state/coordination/owner/repo/runs/run-1.json',
      JSON.stringify(runState),
      {ifNoneMatch: '*'},
    )
  })

  it('transitions a run through acknowledged executing and completed phases', async () => {
    // #given
    const acknowledged = createRunState({phase: 'ACKNOWLEDGED'})
    const executing = createRunState({phase: 'EXECUTING'})
    const completed = createRunState({phase: 'COMPLETED'})
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(createRunState()), etag: 'etag-1'}))
      .mockResolvedValueOnce(ok({data: JSON.stringify(acknowledged), etag: 'etag-2'}))
      .mockResolvedValueOnce(ok({data: JSON.stringify(executing), etag: 'etag-3'}))
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-2'}))
      .mockResolvedValueOnce(ok({etag: 'etag-3'}))
      .mockResolvedValueOnce(ok({etag: 'etag-4'}))
    const storeAdapter = createStoreAdapter({getObject, conditionalPut})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const pendingToAcknowledged = await transitionRun(
      config,
      'coordination',
      'owner/repo',
      'run-1',
      'ACKNOWLEDGED',
      'etag-1',
      logger,
    )
    const acknowledgedToExecuting = await transitionRun(
      config,
      'coordination',
      'owner/repo',
      'run-1',
      'EXECUTING',
      'etag-2',
      logger,
    )
    const executingToCompleted = await transitionRun(
      config,
      'coordination',
      'owner/repo',
      'run-1',
      'COMPLETED',
      'etag-3',
      logger,
    )

    // #then
    expect(pendingToAcknowledged).toEqual(ok({etag: 'etag-2', state: acknowledged}))
    expect(acknowledgedToExecuting).toEqual(ok({etag: 'etag-3', state: executing}))
    expect(executingToCompleted).toEqual(ok({etag: 'etag-4', state: completed}))
  })

  it('persists thread_id atomically with the phase write when threadId is provided', async () => {
    // #given a PENDING run with an empty thread_id, and a live thread id resolved by threadFactory
    const pending = createRunState({phase: 'PENDING', thread_id: ''})
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(pending), etag: 'etag-1'}))
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-2'}))
    const storeAdapter = createStoreAdapter({getObject, conditionalPut})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when transitioning PENDING -> ACKNOWLEDGED with a non-empty threadId
    const result = await transitionRun(
      config,
      'coordination',
      'owner/repo',
      'run-1',
      'ACKNOWLEDGED',
      'etag-1',
      logger,
      {threadId: 'live-thread-123'},
    )

    // #then the written state carries the live thread_id alongside the new phase
    expect(result).toEqual(
      ok({etag: 'etag-2', state: {...pending, phase: 'ACKNOWLEDGED', thread_id: 'live-thread-123'}}),
    )
    const [, writtenBody] = conditionalPut.mock.calls[0] as [string, string, unknown]
    expect(JSON.parse(writtenBody)).toMatchObject({thread_id: 'live-thread-123', phase: 'ACKNOWLEDGED'})
  })

  it('preserves the existing thread_id when threadId is omitted', async () => {
    // #given a run with an existing thread_id
    const pending = createRunState({phase: 'PENDING', thread_id: 'existing-thread'})
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(pending), etag: 'etag-1'}))
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-2'}))
    const storeAdapter = createStoreAdapter({getObject, conditionalPut})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when transitioning without passing threadId
    const result = await transitionRun(config, 'coordination', 'owner/repo', 'run-1', 'ACKNOWLEDGED', 'etag-1', logger)

    // #then thread_id is unchanged from current state
    expect(result).toEqual(ok({etag: 'etag-2', state: {...pending, phase: 'ACKNOWLEDGED'}}))
  })

  it('treats an empty-string threadId as a no-op (does not clobber existing thread_id)', async () => {
    // #given a run with an existing thread_id
    const pending = createRunState({phase: 'PENDING', thread_id: 'existing-thread'})
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(pending), etag: 'etag-1'}))
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-2'}))
    const storeAdapter = createStoreAdapter({getObject, conditionalPut})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when transitioning with an explicit empty-string threadId (no thread exists on this path)
    const result = await transitionRun(
      config,
      'coordination',
      'owner/repo',
      'run-1',
      'ACKNOWLEDGED',
      'etag-1',
      logger,
      {threadId: ''},
    )

    // #then thread_id is unchanged — empty string never overwrites an existing value
    expect(result).toEqual(ok({etag: 'etag-2', state: {...pending, phase: 'ACKNOWLEDGED'}}))
  })

  it('carries a thread_id persisted at ACKNOWLEDGED through later transitions without options (no clobber)', async () => {
    // #given a PENDING run with an empty thread_id, progressing PENDING -> ACKNOWLEDGED (with threadId)
    // -> EXECUTING (no options) -> COMPLETED (no options)
    const pending = createRunState({phase: 'PENDING', thread_id: ''})
    const acknowledged = {...pending, phase: 'ACKNOWLEDGED' as const, thread_id: 'live-thread'}
    const executing = {...acknowledged, phase: 'EXECUTING' as const}
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(pending), etag: 'etag-1'}))
      .mockResolvedValueOnce(ok({data: JSON.stringify(acknowledged), etag: 'etag-2'}))
      .mockResolvedValueOnce(ok({data: JSON.stringify(executing), etag: 'etag-3'}))
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-2'}))
      .mockResolvedValueOnce(ok({etag: 'etag-3'}))
      .mockResolvedValueOnce(ok({etag: 'etag-4'}))
    const storeAdapter = createStoreAdapter({getObject, conditionalPut})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const toAcknowledged = await transitionRun(
      config,
      'coordination',
      'owner/repo',
      'run-1',
      'ACKNOWLEDGED',
      'etag-1',
      logger,
      {threadId: 'live-thread'},
    )
    const toExecuting = await transitionRun(
      config,
      'coordination',
      'owner/repo',
      'run-1',
      'EXECUTING',
      'etag-2',
      logger,
    )
    const toCompleted = await transitionRun(
      config,
      'coordination',
      'owner/repo',
      'run-1',
      'COMPLETED',
      'etag-3',
      logger,
    )

    // #then thread_id set at ACKNOWLEDGED survives EXECUTING and COMPLETED transitions made without options
    expect(toAcknowledged).toEqual(ok({etag: 'etag-2', state: acknowledged}))
    expect(toExecuting).toEqual(ok({etag: 'etag-3', state: executing}))
    expect(toExecuting.success === true ? toExecuting.data.state.thread_id : '').toBe('live-thread')
    expect(toCompleted.success === true ? toCompleted.data.state.thread_id : '').toBe('live-thread')
    expect(toCompleted.success === true ? toCompleted.data.state.phase : '').toBe('COMPLETED')
  })

  it('rejects an invalid completed to executing transition', async () => {
    // #given
    const storeAdapter = createStoreAdapter({
      getObject: vi.fn(async () => ok({data: JSON.stringify(createRunState({phase: 'COMPLETED'})), etag: 'etag-1'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await transitionRun(config, 'coordination', 'owner/repo', 'run-1', 'EXECUTING', 'etag-1', logger)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('Invalid run-state transition')
  })

  it('surfaces optimistic concurrency failures on stale etag writes', async () => {
    // #given
    const storeAdapter = createStoreAdapter({
      conditionalPut: vi.fn(async () => err(new Error('optimistic concurrency failure'))),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await transitionRun(
      config,
      'coordination',
      'owner/repo',
      'run-1',
      'ACKNOWLEDGED',
      'stale-etag',
      logger,
    )

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('optimistic concurrency failure')
  })

  it('finds stale executing runs older than the configured threshold', async () => {
    // #given
    const storeAdapter = createStoreAdapter({
      list: vi.fn(async () =>
        ok([
          'fro-bot-state/coordination/owner/repo/runs/run-1.json',
          'fro-bot-state/coordination/owner/repo/runs/run-2.json',
        ]),
      ),
      getObject: vi
        .fn<Required<ObjectStoreAdapter>['getObject']>()
        .mockResolvedValueOnce(
          ok({
            data: JSON.stringify(createRunState({phase: 'EXECUTING', last_heartbeat: '2026-04-24T18:13:00.000Z'})),
            etag: 'etag-1',
          }),
        )
        .mockResolvedValueOnce(
          ok({
            data: JSON.stringify(
              createRunState({run_id: 'run-2', phase: 'COMPLETED', last_heartbeat: '2026-04-24T18:14:50.000Z'}),
            ),
            etag: 'etag-2',
          }),
        ),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await findStaleRuns(config, 'coordination', 'owner/repo', logger)

    // #then
    expect(result).toEqual(ok([createRunState({phase: 'EXECUTING', last_heartbeat: '2026-04-24T18:13:00.000Z'})]))
  })

  it('skips unreadable run-state files and continues scanning', async () => {
    // #given
    const staleRun = createRunState({phase: 'EXECUTING', last_heartbeat: '2026-04-24T18:13:00.000Z'})
    const logger = createLogger()
    const storeAdapter = createStoreAdapter({
      list: vi.fn(async () =>
        ok([
          'fro-bot-state/coordination/owner/repo/runs/bad.json',
          'fro-bot-state/coordination/owner/repo/runs/stale.json',
          'fro-bot-state/coordination/owner/repo/runs/malformed.json',
        ]),
      ),
      getObject: vi
        .fn<Required<ObjectStoreAdapter>['getObject']>()
        .mockResolvedValueOnce(err(new Error('read failed')))
        .mockResolvedValueOnce(ok({data: JSON.stringify(staleRun), etag: 'etag-stale'}))
        .mockResolvedValueOnce(ok({data: '{bad-json', etag: 'etag-malformed'})),
    })
    const config = createCoordinationConfig(storeAdapter)

    // #when
    const result = await findStaleRuns(config, 'coordination', 'owner/repo', logger)

    // #then
    expect(result).toEqual(ok([staleRun]))
    expect(logger.debug).toHaveBeenCalledWith('Skipping unreadable run-state file', {
      key: 'fro-bot-state/coordination/owner/repo/runs/bad.json',
      error: 'read failed',
    })
    const debugMock = vi.mocked(logger.debug)
    const malformedLogCall = debugMock.mock.calls.find(call => call[0] === 'Skipping malformed run-state file')
    expect(malformedLogCall?.[1]).toMatchObject({
      key: 'fro-bot-state/coordination/owner/repo/runs/malformed.json',
    })
    expect(typeof malformedLogCall?.[1]?.error).toBe('string')
  })

  it('round-trips a created run-state through a read', async () => {
    // #given
    const runState = createRunState({
      phase: 'EXECUTING',
      last_heartbeat: '2026-04-24T18:13:00.000Z',
      details: {attempt: 1, mode: 'review'},
    })
    const storeAdapter = createStoreAdapter({
      list: vi.fn(async () => ok(['fro-bot-state/coordination/owner/repo/runs/run-1.json'])),
      getObject: vi.fn(async () => ok({data: JSON.stringify(runState), etag: 'etag-1'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const createResult = await createRun(config, 'coordination', 'owner/repo', runState, logger)
    const staleRuns = await findStaleRuns(config, 'coordination', 'owner/repo', logger)

    // #then
    expect(createResult).toEqual(ok({etag: 'etag-1'}))
    expect(staleRuns.success).toBe(true)
    expect(staleRuns).toEqual(ok([runState]))
    expect(storeAdapter.conditionalPut).toHaveBeenCalledWith(
      'fro-bot-state/coordination/owner/repo/runs/run-1.json',
      JSON.stringify(runState),
      {ifNoneMatch: '*'},
    )
  })

  // ---------------------------------------------------------------------------
  // Transition table — early-FAILED/CANCELLED edges
  // ---------------------------------------------------------------------------

  it('allows PENDING to transition directly to FAILED', async () => {
    const failed = createRunState({phase: 'FAILED'})
    const storeAdapter = createStoreAdapter({
      getObject: vi.fn(async () => ok({data: JSON.stringify(createRunState({phase: 'PENDING'})), etag: 'etag-1'})),
      conditionalPut: vi.fn(async () => ok({etag: 'etag-2'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    const result = await transitionRun(config, 'coordination', 'owner/repo', 'run-1', 'FAILED', 'etag-1', logger)

    expect(result).toEqual(ok({etag: 'etag-2', state: failed}))
  })

  it('allows PENDING to transition directly to CANCELLED', async () => {
    const cancelled = createRunState({phase: 'CANCELLED'})
    const storeAdapter = createStoreAdapter({
      getObject: vi.fn(async () => ok({data: JSON.stringify(createRunState({phase: 'PENDING'})), etag: 'etag-1'})),
      conditionalPut: vi.fn(async () => ok({etag: 'etag-2'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    const result = await transitionRun(config, 'coordination', 'owner/repo', 'run-1', 'CANCELLED', 'etag-1', logger)

    expect(result).toEqual(ok({etag: 'etag-2', state: cancelled}))
  })

  it('allows ACKNOWLEDGED to transition directly to FAILED', async () => {
    const failed = createRunState({phase: 'FAILED'})
    const storeAdapter = createStoreAdapter({
      getObject: vi.fn(async () => ok({data: JSON.stringify(createRunState({phase: 'ACKNOWLEDGED'})), etag: 'etag-1'})),
      conditionalPut: vi.fn(async () => ok({etag: 'etag-2'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    const result = await transitionRun(config, 'coordination', 'owner/repo', 'run-1', 'FAILED', 'etag-1', logger)

    expect(result).toEqual(ok({etag: 'etag-2', state: failed}))
  })

  it('allows ACKNOWLEDGED to transition directly to CANCELLED', async () => {
    const cancelled = createRunState({phase: 'CANCELLED'})
    const storeAdapter = createStoreAdapter({
      getObject: vi.fn(async () => ok({data: JSON.stringify(createRunState({phase: 'ACKNOWLEDGED'})), etag: 'etag-1'})),
      conditionalPut: vi.fn(async () => ok({etag: 'etag-2'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    const result = await transitionRun(config, 'coordination', 'owner/repo', 'run-1', 'CANCELLED', 'etag-1', logger)

    expect(result).toEqual(ok({etag: 'etag-2', state: cancelled}))
  })

  it('rejects PENDING to EXECUTING (skipping ACKNOWLEDGED)', async () => {
    const storeAdapter = createStoreAdapter({
      getObject: vi.fn(async () => ok({data: JSON.stringify(createRunState({phase: 'PENDING'})), etag: 'etag-1'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    const result = await transitionRun(config, 'coordination', 'owner/repo', 'run-1', 'EXECUTING', 'etag-1', logger)

    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('Invalid run-state transition')
  })

  it('rejects ACKNOWLEDGED to COMPLETED (skipping EXECUTING)', async () => {
    const storeAdapter = createStoreAdapter({
      getObject: vi.fn(async () => ok({data: JSON.stringify(createRunState({phase: 'ACKNOWLEDGED'})), etag: 'etag-1'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    const result = await transitionRun(config, 'coordination', 'owner/repo', 'run-1', 'COMPLETED', 'etag-1', logger)

    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('Invalid run-state transition')
  })

  it('rejects any transition out of a terminal COMPLETED phase', async () => {
    const storeAdapter = createStoreAdapter({
      getObject: vi.fn(async () => ok({data: JSON.stringify(createRunState({phase: 'COMPLETED'})), etag: 'etag-1'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    const result = await transitionRun(config, 'coordination', 'owner/repo', 'run-1', 'FAILED', 'etag-1', logger)

    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('Invalid run-state transition')
  })

  it('rejects any transition out of a terminal FAILED phase', async () => {
    const storeAdapter = createStoreAdapter({
      getObject: vi.fn(async () => ok({data: JSON.stringify(createRunState({phase: 'FAILED'})), etag: 'etag-1'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    const result = await transitionRun(config, 'coordination', 'owner/repo', 'run-1', 'CANCELLED', 'etag-1', logger)

    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('Invalid run-state transition')
  })

  it('rejects any transition out of a terminal CANCELLED phase', async () => {
    const storeAdapter = createStoreAdapter({
      getObject: vi.fn(async () => ok({data: JSON.stringify(createRunState({phase: 'CANCELLED'})), etag: 'etag-1'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    const result = await transitionRun(config, 'coordination', 'owner/repo', 'run-1', 'EXECUTING', 'etag-1', logger)

    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('Invalid run-state transition')
  })

  // ---------------------------------------------------------------------------
  // findStaleRuns — PENDING and ACKNOWLEDGED extension
  // ---------------------------------------------------------------------------

  it('returns stale PENDING runs older than the pending staleness threshold', async () => {
    // #given — system time is 2026-04-24T18:15:00Z; pendingStaleThresholdMs = 30 min → cutoff = 17:45:00Z
    // A PENDING run with last_heartbeat at 17:40:00Z is 35 min old → stale by the long threshold
    const stalePending = createRunState({phase: 'PENDING', last_heartbeat: '2026-04-24T17:40:00.000Z'})
    const storeAdapter = createStoreAdapter({
      list: vi.fn(async () => ok(['fro-bot-state/coordination/owner/repo/runs/run-1.json'])),
      getObject: vi.fn(async () => ok({data: JSON.stringify(stalePending), etag: 'etag-1'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await findStaleRuns(config, 'coordination', 'owner/repo', logger)

    // #then — stale PENDING is included (genuinely orphaned — older than 30 min)
    expect(result).toEqual(ok([stalePending]))
  })

  it('returns stale ACKNOWLEDGED runs older than the pending staleness threshold', async () => {
    // #given — system time is 2026-04-24T18:15:00Z; pendingStaleThresholdMs = 30 min → cutoff = 17:45:00Z
    // A stale ACKNOWLEDGED run with last_heartbeat at 17:40:00Z is 35 min old → stale
    const staleAcknowledged = createRunState({phase: 'ACKNOWLEDGED', last_heartbeat: '2026-04-24T17:40:00.000Z'})
    const storeAdapter = createStoreAdapter({
      list: vi.fn(async () => ok(['fro-bot-state/coordination/owner/repo/runs/run-1.json'])),
      getObject: vi.fn(async () => ok({data: JSON.stringify(staleAcknowledged), etag: 'etag-1'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await findStaleRuns(config, 'coordination', 'owner/repo', logger)

    // #then — stale ACKNOWLEDGED is included (genuinely orphaned — older than 30 min)
    expect(result).toEqual(ok([staleAcknowledged]))
  })

  it('excludes a FRESH PENDING run within the staleness threshold (run-killing-race guard)', async () => {
    // #given — system time is 2026-04-24T18:15:00Z; pendingStaleThresholdMs = 30 min → cutoff = 17:45:00Z
    // A PENDING run with last_heartbeat at 18:14:30Z is only 30 s old → NOT stale
    // This is the critical guard: a just-admitted PENDING must NOT be killed by the sweep.
    const freshPending = createRunState({phase: 'PENDING', last_heartbeat: '2026-04-24T18:14:30.000Z'})
    const storeAdapter = createStoreAdapter({
      list: vi.fn(async () => ok(['fro-bot-state/coordination/owner/repo/runs/run-1.json'])),
      getObject: vi.fn(async () => ok({data: JSON.stringify(freshPending), etag: 'etag-1'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await findStaleRuns(config, 'coordination', 'owner/repo', logger)

    // #then — fresh PENDING is excluded (not killed)
    expect(result).toEqual(ok([]))
  })

  it('does not recover a PENDING run stale by the short threshold but fresh by the long threshold (queued-behind-long-run case)', async () => {
    // #given — system time is 2026-04-24T18:15:00Z
    // staleThresholdMs = 60 s → short cutoff = 18:14:00Z
    // pendingStaleThresholdMs = 30 min → long cutoff = 17:45:00Z
    //
    // A PENDING run with last_heartbeat at 18:13:00Z is 2 min old:
    //   - stale by the short (60 s) threshold → would be killed if PENDING used staleThresholdMs
    //   - FRESH by the long (30 min) threshold → must NOT be killed (it is queued behind a long task)
    //
    // This is the core regression guard: before the fix, this run would be incorrectly recovered.
    const queuedPending = createRunState({phase: 'PENDING', last_heartbeat: '2026-04-24T18:13:00.000Z'})
    const storeAdapter = createStoreAdapter({
      list: vi.fn(async () => ok(['fro-bot-state/coordination/owner/repo/runs/run-1.json'])),
      getObject: vi.fn(async () => ok({data: JSON.stringify(queuedPending), etag: 'etag-1'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await findStaleRuns(config, 'coordination', 'owner/repo', logger)

    // #then — queued PENDING is NOT recovered (fresh by the long threshold)
    expect(result).toEqual(ok([]))
  })

  it('returns stale EXECUTING + stale PENDING + stale ACKNOWLEDGED together, excludes queued-behind-long-run PENDING', async () => {
    // #given — system time is 2026-04-24T18:15:00Z
    // staleThresholdMs = 60 s → EXECUTING cutoff = 18:14:00Z
    // pendingStaleThresholdMs = 30 min → PENDING/ACKNOWLEDGED cutoff = 17:45:00Z
    //
    // Four runs:
    //   staleExecuting  — EXECUTING, 2 min old (stale by 60 s threshold) → recovered
    //   stalePending    — PENDING, 35 min old (stale by 30 min threshold) → recovered
    //   staleAcknowledged — ACKNOWLEDGED, 35 min old → recovered
    //   queuedPending   — PENDING, 2 min old (stale by 60 s but fresh by 30 min) → NOT recovered
    const staleExecuting = createRunState({
      run_id: 'run-exec',
      phase: 'EXECUTING',
      last_heartbeat: '2026-04-24T18:13:00.000Z',
    })
    const stalePending = createRunState({
      run_id: 'run-pend',
      phase: 'PENDING',
      last_heartbeat: '2026-04-24T17:40:00.000Z',
    })
    const staleAcknowledged = createRunState({
      run_id: 'run-ack',
      phase: 'ACKNOWLEDGED',
      last_heartbeat: '2026-04-24T17:40:00.000Z',
    })
    const queuedPending = createRunState({
      run_id: 'run-queued',
      phase: 'PENDING',
      last_heartbeat: '2026-04-24T18:13:00.000Z',
    })
    const storeAdapter = createStoreAdapter({
      list: vi.fn(async () =>
        ok([
          'fro-bot-state/coordination/owner/repo/runs/run-exec.json',
          'fro-bot-state/coordination/owner/repo/runs/run-pend.json',
          'fro-bot-state/coordination/owner/repo/runs/run-ack.json',
          'fro-bot-state/coordination/owner/repo/runs/run-queued.json',
        ]),
      ),
      getObject: vi
        .fn<Required<ObjectStoreAdapter>['getObject']>()
        .mockResolvedValueOnce(ok({data: JSON.stringify(staleExecuting), etag: 'etag-exec'}))
        .mockResolvedValueOnce(ok({data: JSON.stringify(stalePending), etag: 'etag-pend'}))
        .mockResolvedValueOnce(ok({data: JSON.stringify(staleAcknowledged), etag: 'etag-ack'}))
        .mockResolvedValueOnce(ok({data: JSON.stringify(queuedPending), etag: 'etag-queued'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await findStaleRuns(config, 'coordination', 'owner/repo', logger)

    // #then — three genuinely stale runs returned; queued-behind-long-run PENDING excluded
    expect(result).toEqual(
      ok(
        expect.arrayContaining([
          expect.objectContaining({run_id: 'run-exec'}),
          expect.objectContaining({run_id: 'run-pend'}),
          expect.objectContaining({run_id: 'run-ack'}),
        ]),
      ),
    )
    // Queued PENDING must not appear; total count must be exactly 3
    expect(result.success === true ? result.data.map(r => r.run_id) : []).not.toContain('run-queued')
    expect(result.success === true ? result.data : []).toHaveLength(3)
  })

  it('skips structurally invalid run-state payloads and continues scanning', async () => {
    // #given
    const staleRun = createRunState({phase: 'EXECUTING', last_heartbeat: '2026-04-24T18:13:00.000Z'})
    const logger = createLogger()
    const storeAdapter = createStoreAdapter({
      list: vi.fn(async () =>
        ok([
          'fro-bot-state/coordination/owner/repo/runs/invalid.json',
          'fro-bot-state/coordination/owner/repo/runs/stale.json',
        ]),
      ),
      getObject: vi
        .fn<Required<ObjectStoreAdapter>['getObject']>()
        .mockResolvedValueOnce(ok({data: JSON.stringify({phase: 'EXECUTING'}), etag: 'etag-invalid'}))
        .mockResolvedValueOnce(ok({data: JSON.stringify(staleRun), etag: 'etag-stale'})),
    })
    const config = createCoordinationConfig(storeAdapter)

    // #when
    const result = await findStaleRuns(config, 'coordination', 'owner/repo', logger)

    // #then
    expect(result).toEqual(ok([staleRun]))
    const debugMock = vi.mocked(logger.debug)
    const malformedLogCall = debugMock.mock.calls.find(call => call[0] === 'Skipping malformed run-state file')
    expect(malformedLogCall?.[1]).toMatchObject({
      key: 'fro-bot-state/coordination/owner/repo/runs/invalid.json',
    })
    expect(typeof malformedLogCall?.[1]?.error).toBe('string')
  })
})
