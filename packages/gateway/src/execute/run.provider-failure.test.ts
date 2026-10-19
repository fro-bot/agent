import type {CoordinationConfig} from '@fro-bot/runtime'
import type {ProviderFailureReason} from './provider-failure.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'
/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module
   it mocks, to register vi.mock() side effects before those modules are evaluated */
import {
  awaitLaunchWorkRun,
  buildMockRunState,
  makeBinding,
  makeDeps,
  makeEnsureCloneFn,
  makeInMemoryRequest,
  makeMessage,
  makeUpdateFn,
  mockRunOpenCodeCore,
  mockRuntime,
  setupHappyPath,
} from './test-helpers.js'
import {abortRegistry} from './abort-registry.js'
/* eslint-enable perfectionist/sort-imports */

// ---------------------------------------------------------------------------
// Provider failure reason persisted at the terminal FAILED writes (contract 1.12.0).
//
// ./test-helpers.js replaces `RunCoreError` with a stand-in class, which would hide a reason that never
// reaches `run.ts`. This file swaps the REAL `run-core` module back in (keeping the shared
// `runOpenCodeCore` mock) BEFORE `run.js` is first imported, so every error below is a real
// `RunCoreError` and the `instanceof` checks in `run.ts` run against the real class.
// ---------------------------------------------------------------------------

const realRunCore = await vi.importActual<typeof import('./run-core.js')>('./run-core.js')
vi.doMock('./run-core.js', () => ({...realRunCore, runOpenCodeCore: mockRunOpenCodeCore}))

const {RunCoreError} = realRunCore

/** The internal reason → the wire value `run.ts` must persist. */
const REASON_CASES = [
  ['provider auth unavailable', 'provider-auth-unavailable'],
  ['model not available', 'model-not-available'],
  ['provider quota exceeded', 'provider-quota-exceeded'],
  ['model provider rejected the request', 'provider-rejected-request'],
  ['session error', 'unclassified'],
] as const satisfies readonly (readonly [ProviderFailureReason, string])[]

interface FailedWrite {
  readonly detailsPatch?: Record<string, unknown>
}

function failedWrites(): FailedWrite[] {
  return mockRuntime.transitionRun.mock.calls
    .filter((call: unknown[]) => call[4] === 'FAILED')
    .map((call: unknown[]) => (call[7] ?? {}) as FailedWrite)
}

function onlyFailedPatch(): Record<string, unknown> {
  const writes = failedWrites()
  expect(writes).toHaveLength(1)
  return writes[0]?.detailsPatch ?? {}
}

describe('provider failure reason — persisted at the terminal FAILED write (real RunCoreError)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('the stand-in is NOT in play: the error class under test is the real RunCoreError', async () => {
    // #given the real run-core module swapped in above
    // #when a real error is built and the shared mock is the runner
    const error = new RunCoreError('session-error', 'x', false, 'model not available')

    // #then the typed property exists on the real class (the stand-in has no such constructor parameter
    // behavior in production), and run.ts sees the same class through its own import
    const {RunCoreError: seenByRun} = await import('./run-core.js')
    expect(seenByRun).toBe(RunCoreError)
    expect(error.providerFailureReason).toBe('model not available')
  })

  it.each(REASON_CASES)(
    'in-flight: internal reason %s persists the wire value %s next to failureKind',
    async (internal, wire) => {
      // #given — a provider failure that the barrier did not quarantine
      const {runMention} = await import('./run.js')
      setupHappyPath()
      mockRunOpenCodeCore.mockRejectedValue(
        new RunCoreError('session-error', `Provider failure: ${internal}`, false, internal),
      )

      // #when
      await runMention(makeMessage(), makeBinding(), makeDeps())

      // #then — the WIRE value (never the spaced internal spelling) is on the record
      expect(onlyFailedPatch()).toEqual({failureKind: 'session-error', providerFailureReason: wire})
    },
  )

  it('quarantined: the reason is inside the quarantine details patch with quarantined + failureKind', async () => {
    // #given — the barrier could not confirm owned work stopped
    const {runMention} = await import('./run.js')
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(
      new RunCoreError(
        'session-error',
        'Provider failure: provider auth unavailable',
        true,
        'provider auth unavailable',
      ),
    )

    // #when
    await runMention(makeMessage(), makeBinding(), makeDeps())

    // #then
    expect(onlyFailedPatch()).toMatchObject({
      quarantined: true,
      failureKind: 'session-error',
      providerFailureReason: 'provider-auth-unavailable',
    })
  })

  it('quarantine 412 retry: the retry write reuses the patch, so the reason is still persisted', async () => {
    // #given — the first FAILED write loses a conditional-write race; a fresh etag is read back
    const {runMention} = await import('./run.js')
    const executing = buildMockRunState({phase: 'EXECUTING'})
    const coordinationConfig = {
      storeAdapter: {
        upload: vi.fn(),
        download: vi.fn(),
        list: vi.fn(),
        getObject: vi.fn().mockResolvedValue({
          success: true as const,
          data: {data: JSON.stringify(executing), etag: 'fresh-etag'},
        }),
      },
      storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
      pendingStaleThresholdMs: 30 * 60_000,
    } as unknown as CoordinationConfig
    setupHappyPath()
    let failedAttempts = 0
    mockRuntime.transitionRun.mockImplementation(
      async (_c: unknown, _i: unknown, _r: unknown, _id: unknown, phase: string) => {
        if (phase === 'FAILED') {
          failedAttempts += 1
          return failedAttempts === 1
            ? {success: false as const, error: new Error('412 precondition failed')}
            : {success: true as const, data: {etag: 'failed-etag', state: buildMockRunState({phase: 'FAILED'})}}
        }
        return {success: true as const, data: {etag: 'etag', state: buildMockRunState()}}
      },
    )
    mockRunOpenCodeCore.mockRejectedValue(
      new RunCoreError('session-error', 'Provider failure: model not available', true, 'model not available'),
    )

    // #when
    await runMention(makeMessage(), makeBinding(), makeDeps({coordinationConfig}))

    // #then — two FAILED attempts, and BOTH carry the reason
    const writes = failedWrites()
    expect(writes).toHaveLength(2)
    for (const write of writes) {
      expect(write.detailsPatch).toMatchObject({
        quarantined: true,
        failureKind: 'session-error',
        providerFailureReason: 'model-not-available',
      })
    }
  })

  it('a non-provider session-error (no typed reason) writes no reason', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('session-error', 'Session error: something else'))

    // #when
    await runMention(makeMessage(), makeBinding(), makeDeps())

    // #then — failureKind alone; the key is absent, not undefined
    const patch = onlyFailedPatch()
    expect(patch).toEqual({failureKind: 'session-error'})
    expect('providerFailureReason' in patch).toBe(false)
  })

  it.each([
    'timeout',
    'inactivity-timeout',
    'stream-ended',
    'unreachable',
    'auth',
    'prompt-error',
    'drain-timeout',
    'checkout-substituted',
    'workspace-unavailable',
  ] as const)('kind %s never writes a reason, even if a reason were attached', async kind => {
    // #given — gate on kind: the reason refines `session-error` only
    const {runMention} = await import('./run.js')
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(new RunCoreError(kind, 'boom', false, 'provider auth unavailable'))

    // #when
    await runMention(makeMessage(), makeBinding(), makeDeps())

    // #then
    const patch = onlyFailedPatch()
    expect(patch).toEqual({failureKind: kind})
  })

  it('a plain Error writes neither failureKind nor a reason', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(new Error('generic'))

    // #when
    await runMention(makeMessage(), makeBinding(), makeDeps())

    // #then
    const writes = failedWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0]?.detailsPatch).toBeUndefined()
  })

  it('preparation failure (workspace clone) writes no reason', async () => {
    // #given — the run fails before execution starts
    const {runMention} = await import('./run.js')
    setupHappyPath()

    // #when
    await runMention(
      makeMessage(),
      makeBinding(),
      makeDeps({ensureClone: makeEnsureCloneFn('failure'), update: makeUpdateFn('no-checkout')}),
    )

    // #then
    const writes = failedWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0]?.detailsPatch).toBeDefined()
    expect('providerFailureReason' in (writes[0]?.detailsPatch ?? {})).toBe(false)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  it('logs the closed reason and the error NAME — never the error message', async () => {
    // #given — a message carrying text that must not reach the log
    const {runMention} = await import('./run.js')
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(
      new RunCoreError('session-error', 'Provider failure: SENTINEL-PROMPT-TEXT', false, 'model not available'),
    )
    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}

    // #when
    await runMention(makeMessage(), makeBinding(), makeDeps({logger}))

    // #then
    const failedLog = logger.error.mock.calls.find(call => call[1] === 'run: execution failed')
    expect(failedLog?.[0]).toMatchObject({
      kind: 'session-error',
      providerFailureReason: 'model-not-available',
      err: 'RunCoreError',
    })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SENTINEL-PROMPT-TEXT')
  })
})

describe('provider failure reason — racing an operator cancel (real RunCoreError)', () => {
  const RUN_ID = 'provider-failure-cancel-run'

  beforeEach(() => {
    vi.clearAllMocks()
    abortRegistry.delete(RUN_ID)
  })

  function failWithProviderReasonAfterCancel(): void {
    mockRunOpenCodeCore.mockImplementation(async () => {
      abortRegistry.abort(RUN_ID, 'operator cancel')
      throw new RunCoreError(
        'session-error',
        'Provider failure: provider auth unavailable',
        false,
        'provider auth unavailable',
      )
    })
  }

  it('a provider failure racing a cancel ends CANCELLED with no FAILED write and no reason', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    failWithProviderReasonAfterCancel()
    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = RUN_ID

    // #when
    await awaitLaunchWorkRun(launchWork, request, makeDeps())

    // #then
    const phases = mockRuntime.transitionRun.mock.calls.map((call: unknown[]) => call[4])
    expect(phases).toContain('CANCELLED')
    expect(phases).not.toContain('FAILED')
    const cancelled = mockRuntime.transitionRun.mock.calls.find((call: unknown[]) => call[4] === 'CANCELLED')
    expect(cancelled?.[7]?.detailsPatch ?? {}).not.toHaveProperty('providerFailureReason')
    abortRegistry.delete(RUN_ID)
  })

  it('when the CANCELLED write fails, the FAILED fallback carries both failureKind and the reason', async () => {
    // #given — CANCELLED conflicts; a re-read finds a non-terminal run, so FAILED is attempted
    const {launchWork} = await import('./run.js')
    const executing = buildMockRunState({phase: 'EXECUTING', run_id: RUN_ID})
    const coordinationConfig = {
      storeAdapter: {
        upload: vi.fn(),
        download: vi.fn(),
        list: vi.fn(),
        getObject: vi.fn().mockResolvedValue({
          success: true as const,
          data: {data: JSON.stringify(executing), etag: 'fresh-etag'},
        }),
      },
      storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
      pendingStaleThresholdMs: 30 * 60_000,
    } as unknown as CoordinationConfig
    setupHappyPath()
    mockRuntime.transitionRun.mockImplementation(
      async (_c: unknown, _i: unknown, _r: unknown, _id: unknown, phase: string) => {
        if (phase === 'CANCELLED') {
          return {success: false as const, error: new Error('CANCELLED conditional write conflict')}
        }
        return {success: true as const, data: {etag: 'etag', state: buildMockRunState({phase: 'FAILED'})}}
      },
    )
    failWithProviderReasonAfterCancel()
    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = RUN_ID

    // #when
    await awaitLaunchWorkRun(launchWork, request, makeDeps({coordinationConfig}))

    // #then
    expect(onlyFailedPatch()).toEqual({
      failureKind: 'session-error',
      providerFailureReason: 'provider-auth-unavailable',
    })
    abortRegistry.delete(RUN_ID)
  })
})
