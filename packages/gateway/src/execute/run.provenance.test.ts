import {beforeEach, describe, expect, it, vi} from 'vitest'

import {
  awaitLaunchWorkRun,
  buildMockRunState,
  makeCleanObservation,
  makeDeps,
  makeEnsureCloneFn,
  makeInMemoryRequest,
  makeInspectFn,
  mockRunOpenCodeCore,
  mockRuntime,
  setupHappyPath,
} from './test-helpers.js'

// ---------------------------------------------------------------------------
// Checkout provenance — inspection under the lock, persistence onto run
// state, engine-level prompt insertion, the human-facing deterministic
// reply line on every delivery mode, and the corrected clone-failure mapping.
// ---------------------------------------------------------------------------

describe('checkout provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a run records its starting provenance on run state (EXECUTING detailsPatch)', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const observation = makeCleanObservation({sha: 'b'.repeat(40), branch: 'feature/x'})
    const inspect = makeInspectFn('observed')
    ;(inspect as unknown as {mockResolvedValue: (v: unknown) => void}).mockResolvedValue({
      success: true,
      data: observation,
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({inspect})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — the EXECUTING transition carries checkoutProvenance in its detailsPatch
    const executingCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'EXECUTING')
    expect(executingCall).toBeDefined()
    const options = executingCall?.[7]
    expect(options?.detailsPatch?.checkoutProvenance).toEqual({
      kind: 'observed',
      observation,
      remote: {kind: 'not-checked'},
    })
  })

  it("the agent's prompt carries provenance on the Discord builder path (no request.promptBuilder)", async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const request = makeInMemoryRequest()
    const deps = makeDeps({inspect: makeInspectFn('observed')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    const promptText = mockRunOpenCodeCore.mock.calls[0]?.[0]?.promptText as string
    expect(promptText).toContain('Checkout provenance')
    expect(promptText).toContain('Remote freshness was not checked')
  })

  it("the agent's prompt carries provenance on a custom/web promptBuilder path — proves engine-level insertion", async () => {
    // #given — a custom builder that returns fixed text unrelated to provenance
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const request = {...makeInMemoryRequest(), promptBuilder: () => 'CUSTOM WEB PROMPT'}
    const deps = makeDeps({inspect: makeInspectFn('observed')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — the engine appended provenance AFTER the custom builder ran; the builder
    // itself never mentions provenance, so this proves the engine inserted it, not the builder.
    const promptText = mockRunOpenCodeCore.mock.calls[0]?.[0]?.promptText as string
    expect(promptText).toContain('CUSTOM WEB PROMPT')
    expect(promptText).toContain('Checkout provenance')
  })

  it('the final reply carries the deterministic line on success (buffer channel — the ONLY channel the web transport uses)', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    mockRunOpenCodeCore.mockImplementation(async params => {
      ;(params as {sink: {append: (t: string) => void}}).sink.append('the agent answer')
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({inspect: makeInspectFn('observed')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then
    const buffered = request._replySink.buffered()
    expect(buffered).toContain('the agent answer')
    expect(buffered).toContain('Started from `acme/widget@')
    expect(buffered).toContain('Remote freshness not checked.')
  })

  it('the final reply carries the deterministic line on generic failure — the failure-note text Discord delivers', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const {RunCoreError} = await import('./run-core.js')
    mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('stream-ended', 'stream closed'))
    const request = makeInMemoryRequest()
    const deps = makeDeps({inspect: makeInspectFn('observed')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — the literal failure-note text Discord delivers via resolveToFailure/send
    const sends = request._replySink._sends
    const failureSend = sends.find(s => s.content.includes('stream closed unexpectedly'))
    expect(failureSend).toBeDefined()
    expect(failureSend?.content).toContain('Started from `acme/widget@')
  })

  it('inspection unavailable → the run proceeds (runOpenCodeCore still called) and the line says so', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const request = makeInMemoryRequest()
    const deps = makeDeps({inspect: makeInspectFn('unavailable')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — proceeded, not failed
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    const buffered = request._replySink.buffered()
    expect(buffered).toContain('starting state unavailable')
    expect(buffered).toContain('Remote freshness not checked')
  })

  it('checkout-substituted → the run fails through the post-lock path, the lock is released, and no agent session starts', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag'}})
    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
    })
    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    mockRuntime.transitionRun
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'ack-etag', state: buildMockRunState({phase: 'ACKNOWLEDGED'})},
      })
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
      })
    mockRuntime.createHeartbeatController.mockReturnValue({
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue({
        success: true,
        data: {
          runEtag: 'run-etag-after-heartbeat',
          lockEtag: 'lock-etag-after-heartbeat',
          runState: buildMockRunState(),
        },
      }),
      isRunning: false,
    })

    const request = makeInMemoryRequest()
    const deps = makeDeps({inspect: makeInspectFn('checkout-substituted')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — fails through the post-lock path: reaches ACKNOWLEDGED, then FAILED — never EXECUTING
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('ACKNOWLEDGED')
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('EXECUTING')

    // #and — the lock is released
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()

    // #and — no agent session starts
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  it('inspection is called after ensureClone and under the lock (call order)', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const callOrder: string[] = []
    const ensureClone = vi.fn().mockImplementation(async () => {
      callOrder.push('ensureClone')
      return {success: true as const, data: '/workspace/acme/widget'}
    })
    const inspect = vi.fn().mockImplementation(async () => {
      callOrder.push('inspect')
      return {success: true as const, data: makeCleanObservation()}
    })
    mockRuntime.acquireLock.mockImplementation(async () => {
      callOrder.push('acquireLock')
      return {success: true as const, data: {acquired: true as const, etag: 'lock-etag-v1', holder: null}}
    })
    mockRuntime.createHeartbeatController.mockReturnValue({
      start: vi.fn().mockImplementation(() => {
        callOrder.push('heartbeat.start')
      }),
      stop: vi.fn().mockResolvedValue({
        success: true,
        data: {
          runEtag: 'run-etag-after-heartbeat',
          lockEtag: 'lock-etag-after-heartbeat',
          runState: buildMockRunState(),
        },
      }),
      isRunning: false,
    })

    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone, inspect})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then
    expect(callOrder).toEqual(['acquireLock', 'heartbeat.start', 'ensureClone', 'inspect'])
  })

  it('corrected clone-failure mapping: an operator-side clone-error (invalid-repo) no longer yields the retry message', async () => {
    // #given — clone-error code that is operator-side and will not resolve on its own
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const ensureClone = makeEnsureCloneFn('success')
    ;(ensureClone as unknown as {mockResolvedValue: (v: unknown) => void}).mockResolvedValue({
      success: false,
      error: {kind: 'workspace-failure', workspaceKind: 'clone-error', code: 'invalid-repo'},
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — no "not reachable... try again later" retry-inviting message, and no guess
    // at WHY (the message must not claim the repo may not exist or lacks access — that
    // diagnosis is wrong for other codes in the same bucket, e.g. local permission-denied).
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.length > 0)
    expect(errorSend).toBeDefined()
    expect(errorSend?.content).not.toContain('not reachable')
    expect(errorSend?.content).not.toMatch(/may not exist|doesn't have access/)
    expect(errorSend?.content).toContain('An operator needs to look at it')

    // #and — inspect was never called (ensureClone failed before it)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  it('clone-failed stays in the unreachable/retry bucket — it is transient-dominant since missing repos fail earlier, at auth', async () => {
    // #given — clone-failed is the workspace-agent's catch-all for any non-timeout/ENOSPC/
    // missing-git clone error. A missing/uninstalled repo never reaches it (that fails at
    // GitHub App auth instead), so this bucket is dominated by transient causes (a reset
    // connection, a proxy 502, a GitHub 5xx mid-clone) — it must keep inviting a retry.
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const ensureClone = makeEnsureCloneFn('success')
    ;(ensureClone as unknown as {mockResolvedValue: (v: unknown) => void}).mockResolvedValue({
      success: false,
      error: {kind: 'workspace-failure', workspaceKind: 'clone-error', code: 'clone-failed'},
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — still the retry-inviting "not reachable" message
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('not reachable'))
    expect(errorSend).toBeDefined()
  })

  it("positive evidence — reason 'not-installed' (AppNotInstalledError) is permanent, not the retry message", async () => {
    // #given — this is where a missing/uninstalled repository actually lands: GitHub App
    // auth fails BEFORE git ever runs (ensure-clone.ts mints a token first).
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const ensureClone = vi
      .fn()
      .mockResolvedValue({success: false, error: {kind: 'auth-failure', reason: 'not-installed'}})
    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — no retry invitation for a permanent installation problem
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.length > 0)
    expect(errorSend).toBeDefined()
    expect(errorSend?.content).not.toContain('not reachable')
    expect(errorSend?.content).toContain('An operator needs to look at it')
  })

  it("positive evidence — reason 'insufficient-permissions' (InsufficientPermissionsError) is permanent, not the retry message", async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const ensureClone = vi
      .fn()
      .mockResolvedValue({success: false, error: {kind: 'auth-failure', reason: 'insufficient-permissions'}})
    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.length > 0)
    expect(errorSend).toBeDefined()
    expect(errorSend?.content).not.toContain('not reachable')
    expect(errorSend?.content).toContain('An operator needs to look at it')
  })

  it('no positive evidence — a plain discovery AuthError (e.g. GitHub 5xx/network/rate-limit) yields the retry message', async () => {
    // #given — reason 'auth-error' with no instanceof match: the unclassified remainder
    // defaults to transient, never to permanent.
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const ensureClone = vi.fn().mockResolvedValue({success: false, error: {kind: 'auth-failure', reason: 'auth-error'}})
    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — still invites a retry
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('not reachable'))
    expect(errorSend).toBeDefined()
  })

  it('no positive evidence — a token-mint failure (reason absent) yields the retry message', async () => {
    // #given — mintToken always returns a plain AuthError, never AppNotInstalledError/
    // InsufficientPermissionsError; ensureClone surfaces it with reason 'auth-error'.
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const ensureClone = vi.fn().mockResolvedValue({success: false, error: {kind: 'auth-failure'}})
    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('not reachable'))
    expect(errorSend).toBeDefined()
  })

  it("auth-failure with reason 'timeout' stays in the retry bucket — a GitHub App auth timeout is transient", async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const ensureClone = vi.fn().mockResolvedValue({success: false, error: {kind: 'auth-failure', reason: 'timeout'}})
    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — unchanged: still invites a retry
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('not reachable'))
    expect(errorSend).toBeDefined()
  })

  it('an unreachable clone failure (network-error) still yields the "not reachable" message unchanged', async () => {
    // #given — default ensureClone failure mock is workspace-failure/network-error
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const ensureClone = makeEnsureCloneFn('failure')
    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — unchanged baseline behavior
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('not reachable'))
    expect(errorSend).toBeDefined()
  })
})
