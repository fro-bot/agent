import type {CoordinationConfig, RunState} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {CancelRunDeps} from './cancel.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module
   it mocks, to register vi.mock() side effects before those modules are evaluated */
import {
  awaitLaunchWorkRun,
  buildMockRunState,
  CHANNEL_ID,
  makeApprovalRegistry,
  makeDefaultConcurrency,
  makeDeps,
  makeInMemoryRequest,
  mockRunOpenCodeCore,
  mockRuntime,
  setupHappyPath,
} from './test-helpers.js'
import * as runCoreModule from './run-core.js'
import {abortRegistry} from './abort-registry.js'
import {cancelRun} from './cancel.js'
import {isRunLive, isRunQuarantined} from './live-run-registry.js'
/* eslint-enable perfectionist/sort-imports */

// ---------------------------------------------------------------------------
// A cancel that lands during a quarantine hold. A quarantined run's termination barrier could not confirm its owned
// sessions stopped, so it keeps the repo lock (heartbeat) and the channel slot for QUARANTINE_HOLD_WINDOW_MS while the
// quarantine watch keeps interrupting. The abort-registry entry is gone by then (run.ts's `finally`), so `cancelRun`
// cannot reach the run through the abort path. It must still never write CANCELLED over owned, unconfirmed work.
// ---------------------------------------------------------------------------

const LOGGER: GatewayLogger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}

/**
 * Stateful run record behind the mocked `transitionRun`: a write of a phase in `failPhases` fails, every other write
 * lands, and `getObject` reads back whatever last landed. `writes` lists every phase the run or the cancel attempted.
 */
function makeRecordStore(failPhases: readonly string[]) {
  let record: RunState | undefined
  const writes: string[] = []
  mockRuntime.transitionRun.mockImplementation(async (...args: unknown[]) => {
    const phase = String(args[4])
    writes.push(phase)
    if (failPhases.includes(phase)) return {success: false as const, error: new Error('412 precondition failed')}
    const patch = (args[7] as {detailsPatch?: Record<string, unknown>} | undefined)?.detailsPatch ?? {}
    record = buildMockRunState({
      run_id: String(args[3]),
      phase: phase as RunState['phase'],
      thread_id: 'thread-1',
      details: {...record?.details, channelId: CHANNEL_ID, ...patch},
    })
    return {success: true as const, data: {etag: `etag-${writes.length}`, state: record}}
  })
  const coordinationConfig = {
    storeAdapter: {
      upload: vi.fn(),
      download: vi.fn(),
      list: vi.fn(),
      getObject: vi.fn(async () => ({
        success: true as const,
        data: {data: JSON.stringify(record), etag: `etag-${writes.length}`},
      })),
    },
    storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  } as unknown as CoordinationConfig
  return {coordinationConfig, writes, phase: () => record?.phase}
}

function makeCancelDeps(coordinationConfig: CoordinationConfig): CancelRunDeps & {
  readonly postCancelNotice: ReturnType<typeof vi.fn>
  readonly approvalRegistry: ReturnType<typeof makeApprovalRegistry>
} {
  return {
    coordinationConfig,
    identity: 'discord-gateway',
    runIndex: {lookup: vi.fn(async () => ({repo: 'acme/widget', surface: 'discord' as const}))},
    queue: {
      enqueue: vi.fn(),
      pendingCount: vi.fn().mockReturnValue(0),
      takeNext: vi.fn().mockReturnValue(undefined),
      clear: vi.fn().mockReturnValue(0),
      removeBy: vi.fn().mockReturnValue(undefined),
    },
    abortRegistry,
    isRunQuarantined,
    approvalRegistry: makeApprovalRegistry(),
    postCancelNotice: vi.fn().mockResolvedValue(undefined),
  }
}

const ACTOR = {githubUserId: 42, login: 'octocat', sessionCorrelationId: 'sess-1'}

/** Run a task that quarantines (unconfirmed stop), stopping inside its hold window. */
async function quarantineARun(failPhases: readonly string[]) {
  setupHappyPath()
  const store = makeRecordStore(failPhases)
  const heartbeatStop = vi.fn().mockResolvedValue({
    success: true,
    data: {runEtag: 'run-etag', lockEtag: 'lock-etag', runState: buildMockRunState()},
  })
  mockRuntime.createHeartbeatController.mockReturnValue({
    start: vi.fn(),
    stop: heartbeatStop,
    isRunning: false,
  })
  mockRunOpenCodeCore.mockRejectedValue(new runCoreModule.RunCoreError('session-error', 'unconfirmed stop', true))
  const concurrency = makeDefaultConcurrency()
  const deps = makeDeps({coordinationConfig: store.coordinationConfig, concurrency})
  const {launchWork, QUARANTINE_HOLD_WINDOW_MS} = await import('./run.js')

  const done = awaitLaunchWorkRun(launchWork, makeInMemoryRequest(), deps)
  await vi.advanceTimersByTimeAsync(60_000)
  const admission = await done
  const runId = admission.accepted === true ? admission.runId : ''
  return {store, heartbeatStop, concurrency, runId, QUARANTINE_HOLD_WINDOW_MS}
}

describe('cancelRun during a quarantine hold', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves a quarantined run untouched when its FAILED record landed: no CANCELLED write, slot and heartbeat kept', async () => {
    // #given the run quarantined and the record says FAILED (quarantined: true), with the hold still running
    const {store, heartbeatStop, concurrency, runId} = await quarantineARun([])
    expect(runId).not.toBe('')
    expect(store.phase()).toBe('FAILED')
    expect(isRunLive(runId)).toBe(true)
    expect(abortRegistry.has(runId)).toBe(false)
    const deps = makeCancelDeps(store.coordinationConfig)

    // #when an operator cancels during the hold
    const outcome = await cancelRun({runId, actor: ACTOR, logger: LOGGER}, deps)

    // #then it is reported as an already-failed run, and nothing was written, released, or announced
    expect(outcome).toEqual({outcome: 'already-terminal', phase: 'FAILED'})
    expect(store.writes).not.toContain('CANCELLED')
    expect(store.phase()).toBe('FAILED')
    expect(concurrency.release).not.toHaveBeenCalled()
    expect(heartbeatStop).not.toHaveBeenCalled()
    expect(isRunLive(runId)).toBe(true)
    expect(deps.postCancelNotice).not.toHaveBeenCalled()
  })

  it('never writes CANCELLED over a quarantined run whose FAILED record did not land, and keeps the hold intact', async () => {
    // #given the run quarantined but its FAILED write never landed: the record still says EXECUTING
    const {store, heartbeatStop, concurrency, runId, QUARANTINE_HOLD_WINDOW_MS} = await quarantineARun(['FAILED'])
    expect(runId).not.toBe('')
    expect(store.phase()).toBe('EXECUTING')
    expect(isRunLive(runId)).toBe(true)
    expect(isRunQuarantined(runId)).toBe(true)
    expect(abortRegistry.has(runId)).toBe(false)
    const deps = makeCancelDeps(store.coordinationConfig)

    // #when an operator cancels during the hold
    const outcome = await cancelRun({runId, actor: ACTOR, logger: LOGGER}, deps)

    // #then the quarantined state is untouched
    expect(outcome).toEqual({outcome: 'quarantined'})
    expect(store.writes).not.toContain('CANCELLED')
    expect(store.phase()).toBe('EXECUTING')
    expect(deps.postCancelNotice).not.toHaveBeenCalled()
    expect(concurrency.release).not.toHaveBeenCalled()
    expect(heartbeatStop).not.toHaveBeenCalled()
    expect(isRunLive(runId)).toBe(true)

    // #when the hold window elapses
    await vi.advanceTimersByTimeAsync(QUARANTINE_HOLD_WINDOW_MS)

    // #then the hold ends the way it always does: heartbeat stopped, slot released once, run no longer live
    expect(heartbeatStop).toHaveBeenCalledTimes(1)
    expect(concurrency.release).toHaveBeenCalledTimes(1)
    expect(isRunLive(runId)).toBe(false)
    expect(isRunQuarantined(runId)).toBe(false)
  })
})
