import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'
import type {Logger} from '../shared/logger.js'
import type {CoordinationConfig, RunState} from './types.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {err, ok} from '../shared/types.js'
import {createRun, findStaleRuns, transitionRun} from './run-state.js'

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
  }
}

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
