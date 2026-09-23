import type {CoordinationConfig} from '@fro-bot/runtime'
import {beforeEach, describe, expect, it, vi} from 'vitest'
/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module
   it mocks, to register vi.mock() side effects before those modules are evaluated */
import {
  awaitLaunchWorkRun,
  buildMockRunState,
  CHANNEL_ID,
  makeBinding,
  makeDeps,
  makeInMemoryReplySink,
  makeInMemoryRequest,
  makeMessage,
  mockRunOpenCodeCore,
  mockRunOpenCodeCoreAbortedBy,
  mockRuntime,
  setupHappyPath,
} from './test-helpers.js'
import {abortRegistry} from './abort-registry.js'
import * as attachModule from './opencode-attach.js'
import * as promptModule from './prompt.js'
import * as runCoreModule from './run-core.js'
/* eslint-enable perfectionist/sort-imports */

// ---------------------------------------------------------------------------
// Operator cancel — abort-registry integration — and the adjoining
// failureKind persistence coverage on FAILED transitions (including the
// CANCELLED→FAILED fallback path, which shares the same failureKind wiring).
// ---------------------------------------------------------------------------

const CANCEL_RUN_ID = 'cancel-run-id-1'

describe('operator cancel — abort-registry integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The registry is a module-level singleton shared with run.ts (mirrors
    // inFlightRuns). Clear any leaked entries between tests.
    abortRegistry.delete(CANCEL_RUN_ID)
  })

  it('registered run aborted via registry settles CANCELLED (not FAILED), notifies SSE observer, releases lock+slot, deletes registry entry', async () => {
    // #given — happy-path runtime mocks, but runOpenCodeCore aborts the run's own
    // registry entry mid-flight (simulating an operator cancel firing during execution)
    const {launchWork} = await import('./run.js')
    const ackState = buildMockRunState({phase: 'ACKNOWLEDGED', run_id: CANCEL_RUN_ID})
    const execState = buildMockRunState({phase: 'EXECUTING', run_id: CANCEL_RUN_ID})
    const cancelledState = buildMockRunState({phase: 'CANCELLED', run_id: CANCEL_RUN_ID})

    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
    })
    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
    mockRuntime.transitionRun
      .mockResolvedValueOnce({success: true as const, data: {etag: 'ack-etag', state: ackState}})
      .mockResolvedValueOnce({success: true as const, data: {etag: 'exec-etag', state: execState}})
      .mockResolvedValueOnce({success: true as const, data: {etag: 'cancelled-etag', state: cancelledState}})
    const heartbeatStop = vi.fn().mockResolvedValue({
      success: true,
      data: {runEtag: 'run-etag-after-heartbeat', lockEtag: 'lock-etag-after-heartbeat', runState: cancelledState},
    })
    mockRuntime.createHeartbeatController.mockReturnValue({
      start: vi.fn(),
      stop: heartbeatStop,
      isRunning: false,
    })
    vi.mocked(attachModule.attachOpencode).mockReturnValue({
      server: {url: 'http://workspace:9200'},
      session: {create: vi.fn(), prompt: vi.fn()},
    } as unknown as ReturnType<typeof attachModule.attachOpencode>)
    vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')

    const cancelledByMetadata = {
      githubUserId: 42,
      login: 'octocat',
      sessionCorrelationId: 'sess-1',
      cancelledAt: '2026-07-03T00:00:00.000Z',
    }
    mockRunOpenCodeCoreAbortedBy(() => {
      abortRegistry.abort(CANCEL_RUN_ID, 'operator cancel', cancelledByMetadata)
    })

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const releaseFn = vi.fn()
    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = CANCEL_RUN_ID
    const deps = makeDeps({
      runObserver: {observe: observeFn},
      concurrency: {
        tryAcquire: vi.fn().mockReturnValue('ok'),
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      },
    })

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — settled CANCELLED, not FAILED
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('CANCELLED')
    expect(transitionPhases).not.toContain('FAILED')

    // #and — the CANCELLED transitionRun call carries the registry's cancelledBy attribution
    // (the only end-to-end check of the getMetadata → transitionRun attribution seam)
    const cancelledCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'CANCELLED')
    const cancelledCallOptions = cancelledCall?.[7] as {detailsPatch: {cancelledBy: unknown}}
    expect(cancelledCallOptions.detailsPatch.cancelledBy).toEqual(cancelledByMetadata)

    // #and — SSE observer notified with the CANCELLED state
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('CANCELLED')

    // #and — lock released using the heartbeat-stop lockEtag
    expect(mockRuntime.releaseLock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'lock-etag-after-heartbeat',
      expect.anything(),
    )

    // #and — concurrency slot released
    expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)

    // #and — no user-facing failure reply was sent to the thread AT ALL (not just
    // one missing the provenance line): the cancel path calls neither
    // `statusSink.resolveToFailure` nor `replySink.send` (see the "Suppress the
    // user-facing failure reply" comment in run.ts — the cancellation notice is
    // the only communication on this path). Guards against a regression that sends
    // a cancel reply containing the provenance line ("Started from…" / "Remote
    // freshness…") that `sends.some(...includes('failed'))` alone would miss.
    expect(request._statusSink.resolveToFailure).not.toHaveBeenCalled()
    const sends = request._replySink._sends
    expect(sends).toHaveLength(0)
    expect(sends.some(s => s.content.toLowerCase().includes('failed'))).toBe(false)
    expect(sends.some(s => s.content.includes('Started from'))).toBe(false)
    expect(sends.some(s => s.content.includes('Remote freshness'))).toBe(false)

    // #and — registry entry deleted (a later abort() is now a no-op)
    expect(abortRegistry.has(CANCEL_RUN_ID)).toBe(false)
  })

  it('heartbeat.stop() failure on the cancel path — CANCELLED still settles using last-known etags, warning logged', async () => {
    // #given — heartbeat.stop() fails on the cancel path
    const {launchWork} = await import('./run.js')
    const cancelledState = buildMockRunState({phase: 'CANCELLED', run_id: 'hb-fail-cancel-run-id'})
    const stopError = new Error('heartbeat stop S3 error on cancel path')

    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
    })
    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'cancelled-etag', state: cancelledState},
    })
    const heartbeatStop = vi.fn().mockResolvedValue({success: false, error: stopError})
    mockRuntime.createHeartbeatController.mockReturnValue({
      start: vi.fn(),
      stop: heartbeatStop,
      isRunning: false,
    })
    vi.mocked(attachModule.attachOpencode).mockReturnValue({
      server: {url: 'http://workspace:9200'},
      session: {create: vi.fn(), prompt: vi.fn()},
    } as unknown as ReturnType<typeof attachModule.attachOpencode>)
    vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')

    const HB_FAIL_CANCEL_RUN_ID = 'hb-fail-cancel-run-id'
    mockRunOpenCodeCoreAbortedBy(() => {
      abortRegistry.abort(HB_FAIL_CANCEL_RUN_ID, 'operator cancel')
    })

    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = HB_FAIL_CANCEL_RUN_ID
    const deps = makeDeps({logger})

    // #when — must not throw
    await expect(awaitLaunchWorkRun(launchWork, request, deps)).resolves.toBeDefined()

    // #then — CANCELLED still settled despite the heartbeat-stop failure
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('CANCELLED')

    // #and — warning logged for the heartbeat-stop failure on the cancel path
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({err: stopError.message}),
      expect.stringContaining('heartbeat stop failed on cancel path'),
    )

    abortRegistry.delete(HB_FAIL_CANCEL_RUN_ID)
  })

  it('cancelled transition failure falls back to FAILED terminalization — run does not remain EXECUTING', async () => {
    // #given — the CANCELLED transitionRun call fails; a re-read shows the run still
    // EXECUTING with a fresh etag; the FAILED fallback uses that fresh etag and succeeds
    const {launchWork} = await import('./run.js')
    const failedState = buildMockRunState({phase: 'FAILED', run_id: 'cancel-fallback-run-id'})
    const executingState = buildMockRunState({phase: 'EXECUTING', run_id: 'cancel-fallback-run-id'})
    const getObjectMock = vi.fn().mockResolvedValue({
      success: true as const,
      data: {data: JSON.stringify(executingState), etag: 'fresh-etag-after-cancel-412'},
    })
    const coordinationConfig = {
      storeAdapter: {upload: vi.fn(), download: vi.fn(), list: vi.fn(), getObject: getObjectMock},
      storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
      pendingStaleThresholdMs: 30 * 60_000,
    } as unknown as CoordinationConfig

    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
    })
    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
    mockRuntime.transitionRun.mockImplementation(
      async (_config: unknown, _identity: unknown, _repo: unknown, _runId: unknown, phase: string) => {
        if (phase === 'CANCELLED') {
          return {success: false as const, error: new Error('CANCELLED conditional write conflict')}
        }
        if (phase === 'FAILED') {
          return {success: true as const, data: {etag: 'failed-etag', state: failedState}}
        }
        // ACKNOWLEDGED / EXECUTING admission transitions
        return {success: true as const, data: {etag: 'admit-etag', state: failedState}}
      },
    )
    const heartbeatStop = vi.fn().mockResolvedValue({
      success: true,
      data: {runEtag: 'run-etag-after-heartbeat', lockEtag: 'lock-etag-after-heartbeat', runState: failedState},
    })
    mockRuntime.createHeartbeatController.mockReturnValue({
      start: vi.fn(),
      stop: heartbeatStop,
      isRunning: false,
    })
    vi.mocked(attachModule.attachOpencode).mockReturnValue({
      server: {url: 'http://workspace:9200'},
      session: {create: vi.fn(), prompt: vi.fn()},
    } as unknown as ReturnType<typeof attachModule.attachOpencode>)
    vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')

    const CANCEL_FALLBACK_RUN_ID = 'cancel-fallback-run-id'
    mockRunOpenCodeCoreAbortedBy(() => {
      abortRegistry.abort(CANCEL_FALLBACK_RUN_ID, 'operator cancel')
    })

    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = CANCEL_FALLBACK_RUN_ID
    const deps = makeDeps({logger, coordinationConfig})

    // #when — must not throw
    await expect(awaitLaunchWorkRun(launchWork, request, deps)).resolves.toBeDefined()

    // #then — both a CANCELLED attempt (failed) and a FAILED fallback attempt (succeeded) observed
    const transitionCalls = mockRuntime.transitionRun.mock.calls.filter(
      (c: unknown[]) => c[4] === 'CANCELLED' || c[4] === 'FAILED',
    )
    const observedPhases = transitionCalls.map((c: unknown[]) => c[4] as string)
    expect(observedPhases).toContain('CANCELLED')
    expect(observedPhases).toContain('FAILED')

    // #and — the re-read happened, and the FAILED fallback used the FRESH etag from the
    // re-read (not the stale runEtag the CANCELLED write was rejected with).
    expect(getObjectMock).toHaveBeenCalled()
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    expect(failedCall?.[5]).toBe('fresh-etag-after-cancel-412')

    // #and — the run does not remain EXECUTING: the FAILED fallback call is the last
    // observed terminal-settlement attempt for this run, confirming it did not stay open.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({runId: CANCEL_FALLBACK_RUN_ID}),
      expect.stringContaining('transitionRun CANCELLED failed'),
    )
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({runId: CANCEL_FALLBACK_RUN_ID}),
      expect.stringContaining('fell back to FAILED'),
    )

    abortRegistry.delete(CANCEL_FALLBACK_RUN_ID)
  })

  it('cancelled transition failure falls back to FAILED terminalization — dispatchRunFailed fires once with the mapped failureKind', async () => {
    // #given — same CANCELLED-fails/re-read/FAILED-succeeds setup as the fallback test above,
    // plus an operatorPushDispatcher to observe
    const {launchWork} = await import('./run.js')
    const failedState = buildMockRunState({phase: 'FAILED', run_id: 'cancel-fallback-push-run-id'})
    const executingState = buildMockRunState({phase: 'EXECUTING', run_id: 'cancel-fallback-push-run-id'})
    const getObjectMock = vi.fn().mockResolvedValue({
      success: true as const,
      data: {data: JSON.stringify(executingState), etag: 'fresh-etag-after-cancel-412'},
    })
    const coordinationConfig = {
      storeAdapter: {upload: vi.fn(), download: vi.fn(), list: vi.fn(), getObject: getObjectMock},
      storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
      pendingStaleThresholdMs: 30 * 60_000,
    } as unknown as CoordinationConfig

    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
    })
    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
    mockRuntime.transitionRun.mockImplementation(
      async (_config: unknown, _identity: unknown, _repo: unknown, _runId: unknown, phase: string) => {
        if (phase === 'CANCELLED') {
          return {success: false as const, error: new Error('CANCELLED conditional write conflict')}
        }
        if (phase === 'FAILED') {
          return {success: true as const, data: {etag: 'failed-etag', state: failedState}}
        }
        return {success: true as const, data: {etag: 'admit-etag', state: failedState}}
      },
    )
    const heartbeatStop = vi.fn().mockResolvedValue({
      success: true,
      data: {runEtag: 'run-etag-after-heartbeat', lockEtag: 'lock-etag-after-heartbeat', runState: failedState},
    })
    mockRuntime.createHeartbeatController.mockReturnValue({
      start: vi.fn(),
      stop: heartbeatStop,
      isRunning: false,
    })
    vi.mocked(attachModule.attachOpencode).mockReturnValue({
      server: {url: 'http://workspace:9200'},
      session: {create: vi.fn(), prompt: vi.fn()},
    } as unknown as ReturnType<typeof attachModule.attachOpencode>)
    vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')

    const CANCEL_FALLBACK_PUSH_RUN_ID = 'cancel-fallback-push-run-id'
    mockRunOpenCodeCoreAbortedBy(() => {
      abortRegistry.abort(CANCEL_FALLBACK_PUSH_RUN_ID, 'operator cancel')
    })

    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const pushDispatcher = {
      dispatchApprovalPending: vi.fn().mockResolvedValue(undefined),
      dispatchRunFailed: vi.fn().mockResolvedValue(undefined),
    }
    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = CANCEL_FALLBACK_PUSH_RUN_ID
    const deps = makeDeps({logger, coordinationConfig, operatorPushDispatcher: pushDispatcher})

    // #when
    await expect(awaitLaunchWorkRun(launchWork, request, deps)).resolves.toBeDefined()

    // #then — dispatchRunFailed fires exactly once with the mapped failureKind for the
    // CANCELLED→FAILED fallback path
    expect(pushDispatcher.dispatchRunFailed).toHaveBeenCalledTimes(1)
    expect(pushDispatcher.dispatchRunFailed).toHaveBeenCalledWith(CANCEL_FALLBACK_PUSH_RUN_ID, expect.anything())

    abortRegistry.delete(CANCEL_FALLBACK_PUSH_RUN_ID)
  })

  it('in-flight FAILED transitionRun failure — dispatchRunFailed is NOT called (success guard is load-bearing)', async () => {
    // #given — the in-flight FAILED transition itself fails (not the cancel-fallback path)
    const {launchWork} = await import('./run.js')
    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
    })
    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
    mockRuntime.transitionRun.mockImplementation(
      async (_config: unknown, _identity: unknown, _repo: unknown, _runId: unknown, phase: string) => {
        if (phase === 'FAILED') {
          return {success: false as const, error: new Error('FAILED conditional write conflict')}
        }
        return {success: true as const, data: {etag: 'admit-etag', state: buildMockRunState({phase: 'EXECUTING'})}}
      },
    )
    const heartbeatStop = vi.fn().mockResolvedValue({success: true, data: {runEtag: 'e', lockEtag: 'l'}})
    mockRuntime.createHeartbeatController.mockReturnValue({
      start: vi.fn(),
      stop: heartbeatStop,
      isRunning: false,
    })
    vi.mocked(attachModule.attachOpencode).mockReturnValue({
      server: {url: 'http://workspace:9200'},
      session: {create: vi.fn(), prompt: vi.fn()},
    } as unknown as ReturnType<typeof attachModule.attachOpencode>)
    vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')
    mockRunOpenCodeCore.mockRejectedValue(new Error('run core in-flight failure'))

    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const pushDispatcher = {
      dispatchApprovalPending: vi.fn().mockResolvedValue(undefined),
      dispatchRunFailed: vi.fn().mockResolvedValue(undefined),
    }
    const request = makeInMemoryRequest()
    const deps = makeDeps({logger, operatorPushDispatcher: pushDispatcher})

    // #when
    await expect(awaitLaunchWorkRun(launchWork, request, deps)).resolves.toBeDefined()

    // #then — the FAILED transition did not succeed, so the notify/dispatch that only runs
    // on success never fires
    expect(pushDispatcher.dispatchRunFailed).not.toHaveBeenCalled()
  })

  for (const terminalPhase of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
    it(`cancelled transition failure + re-read shows run ALREADY TERMINAL (concurrent writer landed ${terminalPhase}) — no FAILED fallback attempted`, async () => {
      // #given — the CANCELLED transitionRun call fails, but a re-read shows a concurrent
      // writer already landed on a terminal phase — the FAILED fallback must be skipped
      // (FAILED is not a valid transition from any terminal phase)
      const {launchWork} = await import('./run.js')
      const terminalState = buildMockRunState({
        phase: terminalPhase,
        run_id: `cancel-fallback-terminal-run-id-${terminalPhase}`,
      })
      const getObjectMock = vi.fn().mockResolvedValue({
        success: true as const,
        data: {data: JSON.stringify(terminalState), etag: 'terminal-etag'},
      })
      const coordinationConfig = {
        storeAdapter: {upload: vi.fn(), download: vi.fn(), list: vi.fn(), getObject: getObjectMock},
        storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
        lockTtlSeconds: 900,
        heartbeatIntervalMs: 30_000,
        staleThresholdMs: 60_000,
        pendingStaleThresholdMs: 30 * 60_000,
      } as unknown as CoordinationConfig

      mockRuntime.acquireLock.mockResolvedValue({
        success: true as const,
        data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
      })
      mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
      mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
      mockRuntime.transitionRun.mockImplementation(
        async (_config: unknown, _identity: unknown, _repo: unknown, _runId: unknown, phase: string) => {
          if (phase === 'CANCELLED') {
            return {success: false as const, error: new Error('CANCELLED conditional write conflict')}
          }
          // ACKNOWLEDGED / EXECUTING admission transitions
          return {success: true as const, data: {etag: 'admit-etag', state: terminalState}}
        },
      )
      const heartbeatStop = vi.fn().mockResolvedValue({
        success: true,
        data: {runEtag: 'run-etag-after-heartbeat', lockEtag: 'lock-etag-after-heartbeat', runState: terminalState},
      })
      mockRuntime.createHeartbeatController.mockReturnValue({
        start: vi.fn(),
        stop: heartbeatStop,
        isRunning: false,
      })
      vi.mocked(attachModule.attachOpencode).mockReturnValue({
        server: {url: 'http://workspace:9200'},
        session: {create: vi.fn(), prompt: vi.fn()},
      } as unknown as ReturnType<typeof attachModule.attachOpencode>)
      vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')

      const TERMINAL_RUN_ID = `cancel-fallback-terminal-run-id-${terminalPhase}`
      mockRunOpenCodeCoreAbortedBy(() => {
        abortRegistry.abort(TERMINAL_RUN_ID, 'operator cancel')
      })

      const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
      const request = makeInMemoryRequest()
      ;(request as {runId?: string}).runId = TERMINAL_RUN_ID
      const deps = makeDeps({logger, coordinationConfig})

      // #when — must not throw
      await expect(awaitLaunchWorkRun(launchWork, request, deps)).resolves.toBeDefined()

      // #then — the FAILED fallback transitionRun was NEVER attempted
      const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
      expect(transitionPhases).not.toContain('FAILED')

      // #and — a log records the concurrent terminalization with the observed phase
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({runId: TERMINAL_RUN_ID, phase: terminalPhase}),
        expect.stringContaining('already terminalized'),
      )

      abortRegistry.delete(TERMINAL_RUN_ID)
    })
  }

  it('cancelled transition failure + re-read fails (read error) — no fallback write, warn logged, no throw', async () => {
    // #given — the CANCELLED transitionRun call fails, and the subsequent re-read also
    // fails (e.g. getObject error) — the fallback must be skipped fail-soft, no throw
    const {launchWork} = await import('./run.js')
    const executingState = buildMockRunState({phase: 'EXECUTING', run_id: 'cancel-fallback-readfail-run-id'})
    const getObjectMock = vi.fn().mockResolvedValue({
      success: false as const,
      error: new Error('getObject transient failure'),
    })
    const coordinationConfig = {
      storeAdapter: {upload: vi.fn(), download: vi.fn(), list: vi.fn(), getObject: getObjectMock},
      storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
      pendingStaleThresholdMs: 30 * 60_000,
    } as unknown as CoordinationConfig

    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
    })
    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
    mockRuntime.transitionRun.mockImplementation(
      async (_config: unknown, _identity: unknown, _repo: unknown, _runId: unknown, phase: string) => {
        if (phase === 'CANCELLED') {
          return {success: false as const, error: new Error('CANCELLED conditional write conflict')}
        }
        return {success: true as const, data: {etag: 'admit-etag', state: executingState}}
      },
    )
    const heartbeatStop = vi.fn().mockResolvedValue({
      success: true,
      data: {runEtag: 'run-etag-after-heartbeat', lockEtag: 'lock-etag-after-heartbeat', runState: executingState},
    })
    mockRuntime.createHeartbeatController.mockReturnValue({
      start: vi.fn(),
      stop: heartbeatStop,
      isRunning: false,
    })
    vi.mocked(attachModule.attachOpencode).mockReturnValue({
      server: {url: 'http://workspace:9200'},
      session: {create: vi.fn(), prompt: vi.fn()},
    } as unknown as ReturnType<typeof attachModule.attachOpencode>)
    vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')

    const READFAIL_RUN_ID = 'cancel-fallback-readfail-run-id'
    mockRunOpenCodeCoreAbortedBy(() => {
      abortRegistry.abort(READFAIL_RUN_ID, 'operator cancel')
    })

    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = READFAIL_RUN_ID
    const deps = makeDeps({logger, coordinationConfig})

    // #when — must not throw
    await expect(awaitLaunchWorkRun(launchWork, request, deps)).resolves.toBeDefined()

    // #then — the FAILED fallback transitionRun was NEVER attempted
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).not.toContain('FAILED')

    // #and — a warn log records the skipped fallback (fail-soft; recovery reconciles)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({runId: READFAIL_RUN_ID}),
      expect.stringContaining('skipping FAILED fallback'),
    )

    abortRegistry.delete(READFAIL_RUN_ID)
  })

  it('cancelled transition failure + re-read data is unparseable — no fallback write, warn logged, no throw', async () => {
    // #given — the CANCELLED transitionRun call fails, and the subsequent re-read's stored
    // data fails to parse (corrupt/malformed run state) — parseRunState failure inside
    // readCurrentRunStateWithEtag must be treated as fail-soft and skip the fallback write
    const {launchWork} = await import('./run.js')
    const getObjectMock = vi.fn().mockResolvedValue({
      success: true as const,
      data: {data: '{not-valid-json', etag: 'corrupt-etag'},
    })
    const coordinationConfig = {
      storeAdapter: {upload: vi.fn(), download: vi.fn(), list: vi.fn(), getObject: getObjectMock},
      storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
      pendingStaleThresholdMs: 30 * 60_000,
    } as unknown as CoordinationConfig

    const executingState = buildMockRunState({phase: 'EXECUTING', run_id: 'cancel-fallback-parsefail-run-id'})
    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
    })
    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
    mockRuntime.transitionRun.mockImplementation(
      async (_config: unknown, _identity: unknown, _repo: unknown, _runId: unknown, phase: string) => {
        if (phase === 'CANCELLED') {
          return {success: false as const, error: new Error('CANCELLED conditional write conflict')}
        }
        return {success: true as const, data: {etag: 'admit-etag', state: executingState}}
      },
    )
    const heartbeatStop = vi.fn().mockResolvedValue({
      success: true,
      data: {runEtag: 'run-etag-after-heartbeat', lockEtag: 'lock-etag-after-heartbeat', runState: executingState},
    })
    mockRuntime.createHeartbeatController.mockReturnValue({
      start: vi.fn(),
      stop: heartbeatStop,
      isRunning: false,
    })
    vi.mocked(attachModule.attachOpencode).mockReturnValue({
      server: {url: 'http://workspace:9200'},
      session: {create: vi.fn(), prompt: vi.fn()},
    } as unknown as ReturnType<typeof attachModule.attachOpencode>)
    vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')

    const PARSEFAIL_RUN_ID = 'cancel-fallback-parsefail-run-id'
    mockRunOpenCodeCoreAbortedBy(() => {
      abortRegistry.abort(PARSEFAIL_RUN_ID, 'operator cancel')
    })

    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = PARSEFAIL_RUN_ID
    const deps = makeDeps({logger, coordinationConfig})

    // #when — must not throw
    await expect(awaitLaunchWorkRun(launchWork, request, deps)).resolves.toBeDefined()

    // #then — the FAILED fallback transitionRun was NEVER attempted
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).not.toContain('FAILED')

    // #and — a warn log records the skipped fallback (fail-soft; recovery reconciles)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({runId: PARSEFAIL_RUN_ID}),
      expect.stringContaining('skipping FAILED fallback'),
    )

    abortRegistry.delete(PARSEFAIL_RUN_ID)
  })

  it('cancelled transition failure + no getObject adapter — re-read unsupported, no fallback write, warn logged, no throw', async () => {
    // #given — the CANCELLED transitionRun call fails, and the store adapter does not
    // support getObject at all — readCurrentRunStateWithEtag must return null without
    // throwing and the fallback write must be skipped fail-soft
    const {launchWork} = await import('./run.js')
    const coordinationConfig = {
      storeAdapter: {upload: vi.fn(), download: vi.fn(), list: vi.fn()},
      storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
      pendingStaleThresholdMs: 30 * 60_000,
    } as unknown as CoordinationConfig

    const executingState = buildMockRunState({phase: 'EXECUTING', run_id: 'cancel-fallback-noadapter-run-id'})
    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
    })
    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
    mockRuntime.transitionRun.mockImplementation(
      async (_config: unknown, _identity: unknown, _repo: unknown, _runId: unknown, phase: string) => {
        if (phase === 'CANCELLED') {
          return {success: false as const, error: new Error('CANCELLED conditional write conflict')}
        }
        return {success: true as const, data: {etag: 'admit-etag', state: executingState}}
      },
    )
    const heartbeatStop = vi.fn().mockResolvedValue({
      success: true,
      data: {runEtag: 'run-etag-after-heartbeat', lockEtag: 'lock-etag-after-heartbeat', runState: executingState},
    })
    mockRuntime.createHeartbeatController.mockReturnValue({
      start: vi.fn(),
      stop: heartbeatStop,
      isRunning: false,
    })
    vi.mocked(attachModule.attachOpencode).mockReturnValue({
      server: {url: 'http://workspace:9200'},
      session: {create: vi.fn(), prompt: vi.fn()},
    } as unknown as ReturnType<typeof attachModule.attachOpencode>)
    vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')

    const NOADAPTER_RUN_ID = 'cancel-fallback-noadapter-run-id'
    mockRunOpenCodeCoreAbortedBy(() => {
      abortRegistry.abort(NOADAPTER_RUN_ID, 'operator cancel')
    })

    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = NOADAPTER_RUN_ID
    const deps = makeDeps({logger, coordinationConfig})

    // #when — must not throw
    await expect(awaitLaunchWorkRun(launchWork, request, deps)).resolves.toBeDefined()

    // #then — the FAILED fallback transitionRun was NEVER attempted
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).not.toContain('FAILED')

    // #and — a warn log records the skipped fallback (fail-soft; recovery reconciles)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({runId: NOADAPTER_RUN_ID}),
      expect.stringContaining('skipping FAILED fallback'),
    )

    abortRegistry.delete(NOADAPTER_RUN_ID)
  })

  it('happy cancel path (CANCELLED transition succeeds) — no re-read, no fallback attempted', async () => {
    // #given — the CANCELLED transitionRun call succeeds outright
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const cancelledState = buildMockRunState({phase: 'CANCELLED', run_id: 'cancel-happy-run-id'})
    const getObjectMock = vi.fn()
    const coordinationConfig = {
      storeAdapter: {upload: vi.fn(), download: vi.fn(), list: vi.fn(), getObject: getObjectMock},
    } as unknown as CoordinationConfig

    mockRuntime.transitionRun.mockImplementation(
      async (_config: unknown, _identity: unknown, _repo: unknown, _runId: unknown, phase: string) => {
        if (phase === 'CANCELLED') {
          return {success: true as const, data: {etag: 'cancelled-etag', state: cancelledState}}
        }
        return {success: true as const, data: {etag: 'admit-etag', state: cancelledState}}
      },
    )

    const HAPPY_CANCEL_RUN_ID = 'cancel-happy-run-id'
    mockRunOpenCodeCoreAbortedBy(() => {
      abortRegistry.abort(HAPPY_CANCEL_RUN_ID, 'operator cancel')
    })

    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = HAPPY_CANCEL_RUN_ID
    const deps = makeDeps({coordinationConfig})

    // #when — must not throw
    await expect(awaitLaunchWorkRun(launchWork, request, deps)).resolves.toBeDefined()

    // #then — the CANCELLED transition succeeded; no re-read (getObject) was ever needed
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('CANCELLED')
    expect(transitionPhases).not.toContain('FAILED')
    expect(getObjectMock).not.toHaveBeenCalled()

    abortRegistry.delete(HAPPY_CANCEL_RUN_ID)
  })

  it('cancelled→failed fallback reaches a terminal state without throwing (accepted notice-vs-settlement interleaving)', async () => {
    // #given — same CANCELLED-transition-fails/FAILED-fallback-succeeds setup as above.
    // ACCEPTED BEHAVIOR: cancelRun (execute/cancel.ts) posts the "cancelled" thread
    // notice fire-and-forget as soon as abort() confirms delivery — before this async
    // settlement runs. In this rare fallback window the thread may show "cancelled"
    // while the run actually settles FAILED. State is always correct; only the
    // best-effort notice can be briefly stale. This test pins the FAILED-fallback
    // side: the run must still reach a terminal state and must not throw or hang.
    // The notice side (fire-and-forget post on abort delivery) is covered separately
    // by cancel.test.ts's "abort delivered → notice posted" test.
    const {launchWork} = await import('./run.js')
    const failedState = buildMockRunState({phase: 'FAILED', run_id: 'cancel-fallback-pin-run-id'})
    const executingState = buildMockRunState({phase: 'EXECUTING', run_id: 'cancel-fallback-pin-run-id'})
    const getObjectMock = vi.fn().mockResolvedValue({
      success: true as const,
      data: {data: JSON.stringify(executingState), etag: 'fresh-etag-pin'},
    })
    const coordinationConfig = {
      storeAdapter: {upload: vi.fn(), download: vi.fn(), list: vi.fn(), getObject: getObjectMock},
      storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
      pendingStaleThresholdMs: 30 * 60_000,
    } as unknown as CoordinationConfig

    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
    mockRuntime.transitionRun.mockImplementation(
      async (_config: unknown, _identity: unknown, _repo: unknown, _runId: unknown, phase: string) => {
        if (phase === 'CANCELLED') {
          return {success: false as const, error: new Error('CANCELLED conditional write conflict')}
        }
        if (phase === 'FAILED') {
          return {success: true as const, data: {etag: 'failed-etag', state: failedState}}
        }
        return {success: true as const, data: {etag: 'admit-etag', state: failedState}}
      },
    )
    const heartbeatStop = vi.fn().mockResolvedValue({
      success: true,
      data: {runEtag: 'run-etag-after-heartbeat', lockEtag: 'lock-etag-after-heartbeat', runState: failedState},
    })
    mockRuntime.createHeartbeatController.mockReturnValue({
      start: vi.fn(),
      stop: heartbeatStop,
      isRunning: false,
    })
    vi.mocked(attachModule.attachOpencode).mockReturnValue({
      server: {url: 'http://workspace:9200'},
      session: {create: vi.fn(), prompt: vi.fn()},
    } as unknown as ReturnType<typeof attachModule.attachOpencode>)
    vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')

    const PIN_RUN_ID = 'cancel-fallback-pin-run-id'
    mockRunOpenCodeCoreAbortedBy(() => {
      abortRegistry.abort(PIN_RUN_ID, 'operator cancel')
    })

    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = PIN_RUN_ID
    const deps = makeDeps({logger, coordinationConfig})

    // #when — the run must resolve (not throw, not hang) despite the CANCELLED
    // transition failing.
    await expect(awaitLaunchWorkRun(launchWork, request, deps)).resolves.toBeDefined()

    // #then — the run reached a terminal state via the FAILED fallback.
    const transitionCalls = mockRuntime.transitionRun.mock.calls.filter(
      (c: unknown[]) => c[4] === 'CANCELLED' || c[4] === 'FAILED',
    )
    expect(transitionCalls.map((c: unknown[]) => c[4] as string)).toEqual(
      expect.arrayContaining(['CANCELLED', 'FAILED']),
    )
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({runId: PIN_RUN_ID}),
      expect.stringContaining('fell back to FAILED'),
    )

    abortRegistry.delete(PIN_RUN_ID)
  })

  it('timeout-vs-cancel race: classification uses registry probe, not composite abort reason', async () => {
    // #given — a pure ceiling-timeout failure where the registry entry exists but was
    // never aborted. The run must still land FAILED with timeout messaging.
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(new runCoreModule.RunCoreError('timeout', 'wall-clock timeout'))

    const request = makeInMemoryRequest()
    const TIMEOUT_RUN_ID = 'timeout-run-id-1'
    ;(request as {runId?: string}).runId = TIMEOUT_RUN_ID
    const deps = makeDeps()

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — settled FAILED (registry was never aborted for this runId)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('CANCELLED')

    // #and — the coarse timeout message was sent (existing FAILED-path messaging)
    const sends = request._replySink._sends
    expect(sends.some(s => s.content.includes('time limit'))).toBe(true)

    abortRegistry.delete(TIMEOUT_RUN_ID)
  })

  it('timeout-vs-cancel race: a cancel-flagged abort lands CANCELLED even with a timeout-kind RunCoreError', async () => {
    // #given — the registry entry IS aborted (operator cancel won the race), even though
    // run-core still surfaces a 'timeout' kind (it has no distinct 'cancelled' kind).
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const RACE_RUN_ID = 'race-run-id-1'
    mockRunOpenCodeCore.mockImplementation(async () => {
      abortRegistry.abort(RACE_RUN_ID, 'operator cancel wins the race')
      throw new runCoreModule.RunCoreError('timeout', 'combined signal aborted')
    })

    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = RACE_RUN_ID
    const deps = makeDeps()

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — settled CANCELLED despite the 'timeout' RunCoreError kind
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('CANCELLED')
    expect(transitionPhases).not.toContain('FAILED')

    abortRegistry.delete(RACE_RUN_ID)
  })

  it('lock-release failure on the cancelled path — cleanup continues, no throw', async () => {
    // #given — cancelled run whose lock release fails
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    mockRuntime.releaseLock.mockResolvedValue({success: false as const, error: new Error('release failed')})

    const LOCK_FAIL_RUN_ID = 'lock-fail-run-id-1'
    mockRunOpenCodeCore.mockImplementation(async () => {
      abortRegistry.abort(LOCK_FAIL_RUN_ID, 'operator cancel')
      throw new runCoreModule.RunCoreError('timeout', 'combined signal aborted')
    })

    const releaseFn = vi.fn()
    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = LOCK_FAIL_RUN_ID
    const deps = makeDeps({
      concurrency: {
        tryAcquire: vi.fn().mockReturnValue('ok'),
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      },
    })

    // #when — must not throw despite the lock-release failure
    await expect(awaitLaunchWorkRun(launchWork, request, deps)).resolves.toBeDefined()

    // #then — the run still settled CANCELLED and the concurrency slot was still released
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('CANCELLED')
    expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)

    abortRegistry.delete(LOCK_FAIL_RUN_ID)
  })

  it('#1055 class: stream never settles after abort — run promise still resolves bounded, no unhandled rejection', async () => {
    // #given — runOpenCodeCore that hangs unless it observes the abort, then rejects
    // (mirrors run-core's makeAbortableStream: the abort signal races the hung iterator
    // rather than waiting on it forever).
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const NEVER_SETTLE_RUN_ID = 'never-settle-run-id-1'
    mockRunOpenCodeCore.mockImplementation(async () => {
      abortRegistry.abort(NEVER_SETTLE_RUN_ID, 'operator cancel')
      // Simulate run-core's abort-aware race resolving promptly instead of hanging
      // on a stream that never emits again.
      throw new runCoreModule.RunCoreError('timeout', 'aborted while stream was hung')
    })

    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = NEVER_SETTLE_RUN_ID
    const deps = makeDeps()

    // #when — the run promise must resolve (not hang, not reject) within this test's
    // normal timeout budget
    await expect(awaitLaunchWorkRun(launchWork, request, deps)).resolves.toBeDefined()

    // #then — settled CANCELLED
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('CANCELLED')

    abortRegistry.delete(NEVER_SETTLE_RUN_ID)
  })

  it('partial output flushed before cancel remains flushed after CANCELLED settles', async () => {
    // #given — a reply sink that has visible/appended output before the abort fires
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const PARTIAL_OUTPUT_RUN_ID = 'partial-output-run-id-1'
    mockRunOpenCodeCore.mockImplementation(async () => {
      abortRegistry.abort(PARTIAL_OUTPUT_RUN_ID, 'operator cancel')
      throw new runCoreModule.RunCoreError('timeout', 'combined signal aborted')
    })

    const replySink = makeInMemoryReplySink()
    replySink.append('partial output streamed before cancel')
    const request = makeInMemoryRequest({replySink})
    ;(request as {runId?: string}).runId = PARTIAL_OUTPUT_RUN_ID
    const deps = makeDeps()

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — flush was called on the cancel path (partial output preserved)
    expect(replySink.flush).toHaveBeenCalled()
    expect(replySink.buffered()).toBe('partial output streamed before cancel')

    abortRegistry.delete(PARTIAL_OUTPUT_RUN_ID)
  })

  it('abort for an unknown/already-completed runId is a registry no-op — no signal fired, run unaffected', async () => {
    // #given — a happy-path run whose registry entry is untouched; abort a DIFFERENT,
    // never-registered runId concurrently
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const HAPPY_RUN_ID = 'happy-run-id-1'
    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = HAPPY_RUN_ID
    const deps = makeDeps()

    // #when — abort an unrelated, unregistered runId; then run the happy-path task
    const noopResult = abortRegistry.abort('never-registered-run-id')
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — the unrelated abort was a no-op
    expect(noopResult).toBe(false)
    // #and — the happy-path run completed normally (COMPLETED, not CANCELLED)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('COMPLETED')
    expect(transitionPhases).not.toContain('CANCELLED')

    abortRegistry.delete(HAPPY_RUN_ID)
  })

  it('cancel-wins-adoption race: PENDING→ACKNOWLEDGED 412s, re-read shows CANCELLED → no failAdmittedRun noise, no user-facing reply, clean exit', async () => {
    // #given — the ACK transition fails (etag mismatch), and a re-read of the run-state
    // shows CANCELLED (an operator cancel committed PENDING→CANCELLED first)
    const {launchWork} = await import('./run.js')
    const releaseFn = vi.fn()

    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
    })
    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    // ACK transition 412s.
    mockRuntime.transitionRun.mockResolvedValueOnce({
      success: false as const,
      error: new Error('412 precondition failed'),
    })

    const cancelledRunState = buildMockRunState({phase: 'CANCELLED'})
    const getObjectMock = vi.fn().mockResolvedValue({
      success: true as const,
      data: {data: JSON.stringify(cancelledRunState), etag: 'cancelled-etag'},
    })
    const coordinationConfig = {
      storeAdapter: {upload: vi.fn(), download: vi.fn(), list: vi.fn(), getObject: getObjectMock},
      storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
      pendingStaleThresholdMs: 30 * 60_000,
    } as unknown as CoordinationConfig

    const request = makeInMemoryRequest()
    const deps = makeDeps({
      coordinationConfig,
      concurrency: {
        tryAcquire: vi.fn().mockReturnValue('ok'),
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      },
    })

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — failAdmittedRun (a second FAILED transitionRun call) was never attempted
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).not.toContain('FAILED')

    // #and — no user-facing "could not start" reply was sent
    const sends = request._replySink._sends
    expect(sends.some(s => s.content.includes('Could not start'))).toBe(false)

    // #and — lock released, execution never attempted, clean exit
    expect(mockRuntime.releaseLock).toHaveBeenCalled()
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })
})

describe('failureKind persistence on FAILED transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('inactivity-timeout failure: FAILED transitionRun called with detailsPatch.failureKind = internal kind', async () => {
    // #given
    const {runMention} = await import('./run.js')
    const {RunCoreError} = runCoreModule
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('inactivity-timeout', 'no progress'))

    const deps = makeDeps()
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const failedOptions = failedCall?.[7] as {detailsPatch: {failureKind: unknown}} | undefined
    expect(failedOptions?.detailsPatch.failureKind).toBe('inactivity-timeout')
  })

  it('wall-clock timeout failure: detailsPatch.failureKind = internal "timeout" kind (projects to max-duration-timeout)', async () => {
    // #given
    const {runMention} = await import('./run.js')
    const {RunCoreError} = runCoreModule
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

    const deps = makeDeps()
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const failedOptions = failedCall?.[7] as {detailsPatch: {failureKind: unknown}} | undefined
    expect(failedOptions?.detailsPatch.failureKind).toBe('timeout')

    const {toOperatorFailureKind} = await import('../operator-contract/run-status.js')
    expect(toOperatorFailureKind(failedOptions?.detailsPatch.failureKind)).toBe('max-duration-timeout')
  })

  it('reachability failure (unreachable/auth): persisted kind projects to workspace-unreachable', async () => {
    // #given
    const {runMention} = await import('./run.js')
    const {RunCoreError} = runCoreModule
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('unreachable', 'network error'))

    const deps = makeDeps()
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const failedOptions = failedCall?.[7] as {detailsPatch: {failureKind: unknown}} | undefined
    expect(failedOptions?.detailsPatch.failureKind).toBe('unreachable')

    const {toOperatorFailureKind} = await import('../operator-contract/run-status.js')
    expect(toOperatorFailureKind(failedOptions?.detailsPatch.failureKind)).toBe('workspace-unreachable')
  })

  it('generic/uncategorized failure: failureKind omitted from detailsPatch (no options object, or options without failureKind)', async () => {
    // #given — a plain Error, not a RunCoreError
    const {runMention} = await import('./run.js')
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(new Error('boom'))

    const deps = makeDeps()
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — the FAILED transitionRun call carries no detailsPatch.failureKind
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const failedOptions = failedCall?.[7]
    expect(failedOptions?.detailsPatch?.failureKind).toBeUndefined()
  })

  it('regression: the CANCELLED path still writes cancelledBy and NOT failureKind', async () => {
    // #given — a run whose registry entry is aborted mid-flight (operator cancel)
    const {launchWork} = await import('./run.js')
    const REGRESSION_CANCEL_RUN_ID = 'regression-cancel-run-id'
    setupHappyPath()
    const cancelledState = buildMockRunState({phase: 'CANCELLED', run_id: REGRESSION_CANCEL_RUN_ID})
    mockRuntime.transitionRun
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'ack-etag', state: buildMockRunState({phase: 'ACKNOWLEDGED', run_id: REGRESSION_CANCEL_RUN_ID})},
      })
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'exec-etag', state: buildMockRunState({phase: 'EXECUTING', run_id: REGRESSION_CANCEL_RUN_ID})},
      })
      .mockResolvedValueOnce({success: true as const, data: {etag: 'cancelled-etag', state: cancelledState}})

    const cancelledByMetadata = {
      githubUserId: 1,
      login: 'someone',
      sessionCorrelationId: 'sess-x',
      cancelledAt: '2026-07-04T00:00:00.000Z',
    }
    mockRunOpenCodeCoreAbortedBy(() => {
      abortRegistry.abort(REGRESSION_CANCEL_RUN_ID, 'operator cancel', cancelledByMetadata)
    })

    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = REGRESSION_CANCEL_RUN_ID
    const deps = makeDeps()

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — CANCELLED transition carries cancelledBy, not failureKind
    const cancelledCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'CANCELLED')
    const cancelledOptions = cancelledCall?.[7] as {detailsPatch: Record<string, unknown>} | undefined
    expect(cancelledOptions?.detailsPatch.cancelledBy).toEqual(cancelledByMetadata)
    expect(cancelledOptions?.detailsPatch.failureKind).toBeUndefined()

    abortRegistry.delete(REGRESSION_CANCEL_RUN_ID)
  })

  it('fallback: CANCELLED transition returns success:false → FAILED fallback persists detailsPatch.failureKind', async () => {
    // #given — the CANCELLED transitionRun call itself fails; the run falls back to FAILED
    const {launchWork} = await import('./run.js')
    const FALLBACK_RUN_ID = 'fallback-cancel-run-id'
    setupHappyPath()
    const failedFallbackState = buildMockRunState({phase: 'FAILED', run_id: FALLBACK_RUN_ID})
    const executingState = buildMockRunState({phase: 'EXECUTING', run_id: FALLBACK_RUN_ID})
    const getObjectMock = vi.fn().mockResolvedValue({
      success: true as const,
      data: {data: JSON.stringify(executingState), etag: 'fresh-etag-failurekind'},
    })
    const coordinationConfig = {
      storeAdapter: {upload: vi.fn(), download: vi.fn(), list: vi.fn(), getObject: getObjectMock},
      storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
      pendingStaleThresholdMs: 30 * 60_000,
    } as unknown as CoordinationConfig
    mockRuntime.transitionRun
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'ack-etag', state: buildMockRunState({phase: 'ACKNOWLEDGED', run_id: FALLBACK_RUN_ID})},
      })
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'exec-etag', state: buildMockRunState({phase: 'EXECUTING', run_id: FALLBACK_RUN_ID})},
      })
      .mockResolvedValueOnce({success: false as const, error: new Error('CANCELLED transition failed')})
      .mockResolvedValueOnce({success: true as const, data: {etag: 'failed-etag', state: failedFallbackState}})

    const {RunCoreError} = runCoreModule
    mockRunOpenCodeCore.mockImplementation(async () => {
      abortRegistry.abort(FALLBACK_RUN_ID, 'operator cancel')
      throw new RunCoreError('inactivity-timeout', 'no progress')
    })

    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = FALLBACK_RUN_ID
    const deps = makeDeps({coordinationConfig})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — the CANCELLED call was attempted, then the FAILED fallback carries failureKind
    const transitionCalls = mockRuntime.transitionRun.mock.calls
    const cancelledCall = transitionCalls.find((c: unknown[]) => c[4] === 'CANCELLED')
    expect(cancelledCall).toBeDefined()
    const failedFallbackCall = transitionCalls.find((c: unknown[]) => c[4] === 'FAILED')
    const failedFallbackOptions = failedFallbackCall?.[7] as {detailsPatch: {failureKind: unknown}} | undefined
    expect(failedFallbackOptions?.detailsPatch.failureKind).toBe('inactivity-timeout')

    abortRegistry.delete(FALLBACK_RUN_ID)
  })

  it('end-to-end (#1109 guard): a real transitionRun(FAILED, {detailsPatch:{failureKind}}) round-trip through the coordination store projects to the operator enum on both surfaces', async () => {
    // #given — the REAL transitionRun (unmocked for this test) against a fake store adapter,
    // driving a PENDING run through FAILED with detailsPatch.failureKind, then feeding the
    // RETURNED state into both operator projections. This ties the write to the read through
    // the real seam (not a hand-built run-state fake) per the #1109 write-path-trap guard.
    const {transitionRun: realTransitionRun} =
      await vi.importActual<typeof import('@fro-bot/runtime')>('@fro-bot/runtime')
    const {toOperatorRunStatus} = await import('../operator-contract/run-status.js')
    const {toRunSummary} = await import('../operator-contract/run-summary.js')

    const initialState = buildMockRunState({phase: 'EXECUTING', run_id: 'e2e-run-1', entity_ref: 'acme/widget#1'})
    let stored = JSON.stringify(initialState)
    const storeAdapter = {
      upload: vi.fn(),
      download: vi.fn(),
      list: vi.fn(),
      conditionalPut: vi.fn(async (_key: unknown, data: string) => {
        stored = data
        return {success: true as const, data: {etag: 'etag-2'}}
      }),
      conditionalDelete: vi.fn(),
      getObject: vi.fn(async () => ({success: true as const, data: {data: stored, etag: 'etag-1'}})),
      listWithMetadata: vi.fn(),
    }
    const coordinationConfig = {
      storeAdapter,
      storeConfig: {enabled: true, bucket: 'test-bucket', region: 'us-east-1', prefix: 'fro-bot-state'},
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
      pendingStaleThresholdMs: 30 * 60_000,
    } as unknown as CoordinationConfig
    const logger = {debug: vi.fn()}

    // #when — the real seam: transitionRun with detailsPatch.failureKind
    const result = await realTransitionRun(
      coordinationConfig,
      'discord-gateway',
      'acme/widget',
      'e2e-run-1',
      'FAILED',
      'etag-1',
      logger,
      {detailsPatch: {failureKind: 'inactivity-timeout'}},
    )
    expect(result.success).toBe(true)
    if (result.success === false) return

    // #then — the RETURNED run-state projects failureKind on both operator surfaces
    const operatorStatus = toOperatorRunStatus(result.data.state, {
      nowMs: Date.now(),
      staleThresholdMs: 60_000,
      repoKey: {databaseId: 123, nodeId: 'node-123'},
      isRepoDenylisted: () => false,
    })
    expect(operatorStatus?.failureKind).toBe('inactivity-timeout')

    const summary = toRunSummary(result.data.state, {owner: 'acme', repo: 'widget'})
    expect(summary?.failureKind).toBe('inactivity-timeout')
  })

  it('drain-timeout failure: detailsPatch.failureKind = internal "drain-timeout" kind (projects to max-duration-timeout)', async () => {
    // #given — Unit 6: a run's deadline covers execution AND drain, so a drain-timeout
    // is operator-facing exactly the same deadline-expiry outcome as a plain timeout.
    const {runMention} = await import('./run.js')
    const {RunCoreError} = runCoreModule
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('drain-timeout', 'drain deadline expired'))

    const deps = makeDeps()
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const failedOptions = failedCall?.[7] as {detailsPatch: {failureKind: unknown}} | undefined
    expect(failedOptions?.detailsPatch.failureKind).toBe('drain-timeout')

    const {toOperatorFailureKind} = await import('../operator-contract/run-status.js')
    expect(toOperatorFailureKind(failedOptions?.detailsPatch.failureKind)).toBe('max-duration-timeout')
  })
})
