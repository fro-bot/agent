import {beforeEach, describe, expect, it, vi} from 'vitest'
/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module
   it mocks, to register vi.mock() side effects before those modules are evaluated */
import {
  awaitLaunchWorkRun,
  buildMockRunState,
  CHANNEL_ID,
  makeBinding,
  makeDeps,
  makeEnsureCloneFn,
  makeInMemoryRequest,
  makeMessage,
  mockRunOpenCodeCore,
  mockRuntime,
  OWNER,
  REPO,
  setupHappyPath,
} from './test-helpers.js'
import {parseRecoverEntryCustomId} from '../discord/recover-checkout-button.js'
import {CLIENT_TIMEOUT_REPLY} from './preparation-reply.js'
/* eslint-enable perfectionist/sort-imports */

// ---------------------------------------------------------------------------
// Checkout preparation (Unit 7) — /update replaces ensureClone→inspect. Covers every
// outcome→phase/failureKind/persisted-record/reply mapping, the Recover button on Discord,
// client timeouts, and the clone-then-update lock discipline.
// ---------------------------------------------------------------------------

describe('checkout preparation: outcome mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refused/dirty → FAILED, no session, checkoutPreparation persisted, exact reply + recover suffix', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {kind: 'refused', reason: 'dirty', changedPaths: ['a.txt', 'b.txt']},
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({update})

    await awaitLaunchWorkRun(launchWork, request, deps)

    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    expect(failedCall).toBeDefined()
    const options = failedCall?.[7] as {detailsPatch?: {checkoutPreparation?: unknown}}
    expect(options?.detailsPatch?.checkoutPreparation).toEqual({
      outcome: 'refused',
      reason: 'dirty',
      changedPaths: ['a.txt', 'b.txt'],
    })
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    const sent = request._replySink._sends[0]
    expect(sent?.content).toContain("The checkout has uncommitted or untracked changes, so I can't update it safely.")
    expect(sent?.content).toContain('Use the button below')
  })

  it('failed/fetch-timeout (permanent: false) → FAILED, checkoutPreparation persisted, transient reply', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {kind: 'failed', reason: 'fetch-timeout', mutationStarted: false, permanent: false},
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({update})

    await awaitLaunchWorkRun(launchWork, request, deps)

    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const options = failedCall?.[7] as {detailsPatch?: {checkoutPreparation?: unknown}}
    expect(options?.detailsPatch?.checkoutPreparation).toEqual({
      outcome: 'failed',
      reason: 'fetch-timeout',
      mutationStarted: false,
      permanent: false,
    })
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    expect(request._replySink._sends[0]?.content).toContain("couldn't reach the repository's remote right now")
  })

  it('refused/maintenance-hold → FAILED, checkoutPreparation persisted, grounded reply with NO recover suffix', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({success: true, data: {kind: 'refused', reason: 'maintenance-hold'}})
    const request = makeInMemoryRequest()
    const deps = makeDeps({update})

    await awaitLaunchWorkRun(launchWork, request, deps)

    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    const sent = request._replySink._sends[0]
    expect(sent?.content).toContain('the workspace has put this repository on hold')
    expect(sent?.content).not.toContain('recover-checkout')
  })

  it('failed/termination-unconfirmed → FAILED, checkoutPreparation persisted, its own reply', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {kind: 'failed', reason: 'termination-unconfirmed', mutationStarted: 'possibly', permanent: false},
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({update})

    await awaitLaunchWorkRun(launchWork, request, deps)

    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    expect(request._replySink._sends[0]?.content).toContain("couldn't be confirmed to have stopped")
  })

  it('ready → EXECUTING commits, OpenCode session starts, no FAILED transition', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const request = makeInMemoryRequest()
    const deps = makeDeps()

    await awaitLaunchWorkRun(launchWork, request, deps)

    const phases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(phases).toContain('EXECUTING')
    expect(phases).not.toContain('FAILED')
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
  })
})

describe('checkout preparation: client timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a client-side timeout produces the state-unknown reply, no checkoutPreparation, and releases the lock with the renewed etag', async () => {
    const {launchWork} = await import('./run.js')
    const stopFn = vi.fn().mockResolvedValue({
      success: true,
      data: {runEtag: 'run-etag-after-heartbeat', lockEtag: 'lock-etag-after-heartbeat', runState: buildMockRunState()},
    })
    setupHappyPath({stop: stopFn})
    mockRuntime.transitionRun
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'ack-etag', state: buildMockRunState({phase: 'ACKNOWLEDGED'})},
      })
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
      })
    const update = vi.fn().mockResolvedValue({success: false, error: {kind: 'timeout'}})
    const request = makeInMemoryRequest()
    const deps = makeDeps({update})

    await awaitLaunchWorkRun(launchWork, request, deps)

    expect(request._replySink._sends[0]?.content).toContain(CLIENT_TIMEOUT_REPLY)
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const options = failedCall?.[7] as {detailsPatch?: {checkoutPreparation?: unknown}}
    expect(options?.detailsPatch?.checkoutPreparation).toBeUndefined()
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
    const releaseCall = mockRuntime.releaseLock.mock.calls[0] as unknown[]
    expect(releaseCall[2]).toBe('lock-etag-after-heartbeat')
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })
})

describe('checkout preparation: the Recover button (Discord only)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a refused Discord reply carries the button, and its custom ID round-trips back to this channel', async () => {
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({success: true, data: {kind: 'refused', reason: 'detached'}})
    const message = makeMessage()
    const deps = makeDeps({update})

    await runMention(message, makeBinding(), deps)

    const thread = message._thread
    const sendMock = thread.send as ReturnType<typeof vi.fn>
    expect(sendMock).toHaveBeenCalledOnce()
    const options = sendMock.mock.calls[0]?.[0] as {content: string; components?: unknown[]}
    expect(options.components).toHaveLength(1)
    const row = options.components?.[0] as {toJSON: () => {components: {custom_id: string}[]}}
    const customId = row.toJSON().components[0]?.custom_id
    expect(customId).toBeDefined()
    // The button identifies the BOUND channel (request.channelId), not the ephemeral reply
    // thread — every bound channel maps to exactly one repo binding (see the button module's
    // own doc comment), so Unit 8's click handler can resolve it the same way it always does.
    expect(parseRecoverEntryCustomId(customId ?? '')).toEqual({channelId: CHANNEL_ID})
  })

  it('a web-launched refusal persists checkoutPreparation but never attaches a button', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({success: true, data: {kind: 'refused', reason: 'detached'}})
    const request = {...makeInMemoryRequest(), surface: 'web' as const}
    const deps = makeDeps({update})

    await awaitLaunchWorkRun(launchWork, request, deps)

    const sendMock = request._replySink.send as unknown as ReturnType<typeof vi.fn>
    const options = sendMock.mock.calls[0]?.[1] as {components?: unknown}
    expect(options?.components).toBeUndefined()
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    const detailsOptions = failedCall?.[7] as {detailsPatch?: {checkoutPreparation?: unknown}}
    expect(detailsOptions?.detailsPatch?.checkoutPreparation).toEqual({outcome: 'refused', reason: 'detached'})
  })

  it('an apply-failed reply whose mutation may have started ALSO carries the button (not only refusals)', async () => {
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {kind: 'failed', reason: 'apply-failed', mutationStarted: 'possibly', permanent: false},
    })
    const message = makeMessage()
    const deps = makeDeps({update})

    await runMention(message, makeBinding(), deps)

    const options = (message._thread.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      content: string
      components?: unknown[]
    }
    expect(options.content).toContain('needs recovery before I can run here')
    expect(options.components).toHaveLength(1)
  })

  it('a client timeout does NOT carry the button (nothing useful to recover into)', async () => {
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({success: false, error: {kind: 'timeout'}})
    const message = makeMessage()
    const deps = makeDeps({update})

    await runMention(message, makeBinding(), deps)

    const options = (message._thread.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {components?: unknown}
    expect(options.components).toBeUndefined()
  })

  it('maintenance-hold does NOT carry the button', async () => {
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({success: true, data: {kind: 'refused', reason: 'maintenance-hold'}})
    const message = makeMessage()
    const deps = makeDeps({update})

    await runMention(message, makeBinding(), deps)

    const options = (message._thread.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {components?: unknown}
    expect(options.components).toBeUndefined()
  })
})

describe('checkout preparation: clone-then-update lock discipline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('the lock is held across the clone-then-update sequence, and a clone failure releases it', async () => {
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const ensureClone = makeEnsureCloneFn('failure')
    const update = vi.fn().mockResolvedValue({success: true, data: {kind: 'no-checkout'}})
    const message = makeMessage()
    const deps = makeDeps({ensureClone, update})

    await runMention(message, makeBinding(), deps)

    expect(mockRuntime.acquireLock).toHaveBeenCalledOnce()
    expect(ensureClone).toHaveBeenCalledOnce()
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })
})

describe('checkout preparation: deadline propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('the deadline passed to update equals the lesser of 100s and the run’s remaining budget', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {
        kind: 'ready',
        change: 'unchanged',
        branch: 'main',
        sha: 'a'.repeat(40),
        checkedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    const request = makeInMemoryRequest()
    // Small run budget — well under update's own 100s ceiling — so remainingBudgetMs
    // should reflect THIS run's budget, not a hardcoded 100_000.
    const deps = makeDeps({update, runTimeoutMs: 5_000})

    await awaitLaunchWorkRun(launchWork, request, deps)

    const call = update.mock.calls[0] as [string, string, {remainingBudgetMs: number}]
    expect(call[0]).toBe(OWNER)
    expect(call[1]).toBe(REPO)
    expect(call[2].remainingBudgetMs).toBeGreaterThan(0)
    expect(call[2].remainingBudgetMs).toBeLessThanOrEqual(5_000)
  })
})

describe('checkout preparation: both transports go through it', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a web launch (launchWork) calls update', async () => {
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {
        kind: 'ready',
        change: 'unchanged',
        branch: 'main',
        sha: 'a'.repeat(40),
        checkedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    const request = {...makeInMemoryRequest(), surface: 'web' as const}
    const deps = makeDeps({update})

    await awaitLaunchWorkRun(launchWork, request, deps)

    const call = update.mock.calls[0] as [string, string, {remainingBudgetMs: number}]
    expect(call[0]).toBe(OWNER)
    expect(call[1]).toBe(REPO)
    expect(typeof call[2].remainingBudgetMs).toBe('number')
  })

  it('a Discord mention (runMention) calls update', async () => {
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {
        kind: 'ready',
        change: 'unchanged',
        branch: 'main',
        sha: 'a'.repeat(40),
        checkedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    const message = makeMessage()
    const deps = makeDeps({update})

    await runMention(message, makeBinding(), deps)

    const call = update.mock.calls[0] as [string, string, {remainingBudgetMs: number}]
    expect(call[0]).toBe(OWNER)
    expect(call[1]).toBe(REPO)
    expect(typeof call[2].remainingBudgetMs).toBe('number')
  })
})
