import type {CoordinationConfig} from '@fro-bot/runtime'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import {
  awaitLaunchWorkRun,
  buildMockRunState,
  makeBinding,
  makeDeps,
  makeEnsureCloneFn,
  makeInMemoryRequest,
  makeMessage,
  makeStatusControllerMock,
  makeUpdateFn,
  mockCreateDiscordStreamSink,
  mockRunOpenCodeCore,
  mockRuntime,
  setupHappyPath,
} from './test-helpers.js'

// ---------------------------------------------------------------------------
// Checkout provenance — preparation (Unit 7's /update) under the lock, persistence onto run
// state, engine-level prompt insertion, the human-facing deterministic reply line on every
// delivery mode, and the corrected clone-failure mapping (ensureClone runs only when /update
// reports `no-checkout`).
// ---------------------------------------------------------------------------

describe('checkout provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a run records its starting provenance on run state (EXECUTING detailsPatch), built from the /update ready result', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const update = vi.fn().mockResolvedValue({
      success: true,
      data: {
        kind: 'ready',
        change: 'unchanged',
        branch: 'feature/x',
        sha: 'b'.repeat(40),
        checkedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({update})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — the EXECUTING transition carries checkoutProvenance in its detailsPatch, with a
    // `checked` remote synthesized from the /update ready result — never `not-checked`.
    const executingCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'EXECUTING')
    expect(executingCall).toBeDefined()
    const options = executingCall?.[7]
    expect(options?.detailsPatch?.checkoutProvenance).toEqual({
      kind: 'observed',
      observation: {
        head: {kind: 'attached', branch: 'feature/x', sha: 'b'.repeat(40)},
        worktree: {kind: 'clean'},
        operationInProgress: 'none',
        observedAt: '2026-01-01T00:00:00.000Z',
      },
      remote: {
        kind: 'checked',
        defaultBranch: 'feature/x',
        sha: 'b'.repeat(40),
        checkedAt: '2026-01-01T00:00:00.000Z',
        change: 'unchanged',
      },
    })
  })

  it("the agent's prompt carries provenance on the Discord builder path (no request.promptBuilder)", async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const request = makeInMemoryRequest()
    const deps = makeDeps({update: makeUpdateFn('ready')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    const promptText = mockRunOpenCodeCore.mock.calls[0]?.[0]?.promptText as string
    expect(promptText).toContain('Checkout provenance')
    expect(promptText).toContain('Remote checked: default branch')
  })

  it("the agent's prompt carries provenance on a custom/web promptBuilder path — proves engine-level insertion", async () => {
    // #given — a custom builder that returns fixed text unrelated to provenance
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const request = {...makeInMemoryRequest(), promptBuilder: () => 'CUSTOM WEB PROMPT'}
    const deps = makeDeps({update: makeUpdateFn('ready')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — the engine appended provenance AFTER the custom builder ran; the builder
    // itself never mentions provenance, so this proves the engine inserted it, not the builder.
    const promptText = mockRunOpenCodeCore.mock.calls[0]?.[0]?.promptText as string
    expect(promptText).toContain('CUSTOM WEB PROMPT')
    expect(promptText).toContain('Checkout provenance')
  })

  it('the final reply carries the deterministic checked-ready line on success (buffer channel — the ONLY channel the web transport uses)', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    mockRunOpenCodeCore.mockImplementation(async params => {
      ;(params as {sink: {append: (t: string) => void}}).sink.append('the agent answer')
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({update: makeUpdateFn('ready')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then
    const buffered = request._replySink.buffered()
    expect(buffered).toContain('the agent answer')
    expect(buffered).toContain('The checkout is already at `')
    expect(buffered).toContain(', checked `')
  })

  it('the final reply carries the deterministic line on generic failure — the failure-note text Discord delivers', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const {RunCoreError} = await import('./run-core.js')
    mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('stream-ended', 'stream closed'))
    const request = makeInMemoryRequest()
    const deps = makeDeps({update: makeUpdateFn('ready')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — the literal failure-note text Discord delivers via resolveToFailure/send
    const sends = request._replySink._sends
    const failureSend = sends.find(s => s.content.includes('stream closed unexpectedly'))
    expect(failureSend).toBeDefined()
    expect(failureSend?.content).toContain('The checkout is already at `')
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
    const deps = makeDeps({update: makeUpdateFn('checkout-substituted')})

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

  it('checkout-substituted → the failure reply carries the withheld-provenance line (no SHA, no branch)', async () => {
    // #given — the same substituted-checkout setup as above; this test only asserts
    // on the reply content
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
    const deps = makeDeps({update: makeUpdateFn('checkout-substituted')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — this is the ONE failure reply that most needs the line (the run found a
    // tree that shouldn't be there), and before the fix it was silently dropped because
    // `provenanceLine` was never set before the throw. Exact text, no SHA, no branch —
    // those would describe the substituted (untrusted) tree, not the expected one.
    const sends = request._replySink._sends
    const failureSend = sends.find(s => s.content.includes("doesn't match this repository"))
    expect(failureSend).toBeDefined()
    expect(failureSend?.content).toContain(
      'Started from `acme/widget` — starting state withheld: checkout is not the expected repository.',
    )
    expect(failureSend?.content).not.toMatch(/@[0-9a-f]{7}/)
  })

  it('eXECUTING lost the adoption race to an operator cancel: no provenance write ever lands', async () => {
    // #given — /update succeeds with ready (a checked provenance would normally be persisted
    // via the EXECUTING detailsPatch), but the ACKNOWLEDGED -> EXECUTING transition 412s and a
    // re-read shows the run was already cancelled by an operator. Pins existing behavior (run.ts's
    // cancel-wins-adoption-race exit at the EXECUTING transition never writes provenance).
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
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
      .mockResolvedValueOnce({success: false as const, error: new Error('412 precondition failed')})
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
    const deps = makeDeps({coordinationConfig, update: makeUpdateFn('ready')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — ACKNOWLEDGED succeeded, EXECUTING was attempted (carrying checkoutProvenance
    // in its detailsPatch) but that attempt is exactly the one mocked to fail above — no
    // transitionRun call ever succeeds with checkoutProvenance, so nothing lands in the store
    const transitionCalls = mockRuntime.transitionRun.mock.calls
    expect(transitionCalls.map(c => c[4] as string)).toEqual(['ACKNOWLEDGED', 'EXECUTING'])
    const executingCall = transitionCalls.find(c => c[4] === 'EXECUTING')
    const executingOptions = executingCall?.[7]
    expect(executingOptions?.detailsPatch?.checkoutProvenance).toBeDefined()

    // #and — no FAILED fallback (this is the graceful-loser exit, not a genuine failure)
    // and no further transitionRun attempts — the provenance-carrying write is never retried
    expect(mockRuntime.transitionRun).toHaveBeenCalledTimes(2)

    // #and — clean exit: lock released, no agent session started, no reply sent
    expect(mockRuntime.releaseLock).toHaveBeenCalled()
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    expect(request._replySink._sends).toHaveLength(0)
  })

  it('/update is called under the lock; ensureClone runs only after a no-checkout result, then /update is retried', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const callOrder: string[] = []
    let updateCallCount = 0
    const ensureClone = vi.fn().mockImplementation(async () => {
      callOrder.push('ensureClone')
      return {success: true as const, data: '/workspace/acme/widget'}
    })
    const update = vi.fn().mockImplementation(async () => {
      updateCallCount += 1
      callOrder.push(`update-${updateCallCount}`)
      if (updateCallCount === 1) return {success: true as const, data: {kind: 'no-checkout' as const}}
      return {
        success: true as const,
        data: {
          kind: 'ready' as const,
          change: 'unchanged' as const,
          branch: 'main',
          sha: 'a'.repeat(40),
          checkedAt: '2026-01-01T00:00:00.000Z',
        },
      }
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
    const deps = makeDeps({ensureClone, update})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then
    expect(callOrder).toEqual(['acquireLock', 'heartbeat.start', 'update-1', 'ensureClone', 'update-2'])
  })

  it('a no-checkout result on retry (after ensureClone) is treated as a workspace bug, not a transient blip', async () => {
    // #given — update keeps reporting no-checkout even after ensureClone just ensured the
    // checkout exists; this can only mean the workspace-agent's own view is inconsistent.
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const request = makeInMemoryRequest()
    const deps = makeDeps({update: makeUpdateFn('no-checkout')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — the operator-side "an operator needs to look at it" message, not a retry invitation
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.length > 0)
    expect(errorSend).toBeDefined()
    expect(errorSend?.content).toContain('An operator needs to look at it')
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  it('corrected clone-failure mapping: an operator-side clone-error (invalid-repo) no longer yields the retry message', async () => {
    // #given — /update reports no-checkout so ensureClone runs; ensureClone then fails with a
    // clone-error code that is operator-side and will not resolve on its own
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const ensureClone = makeEnsureCloneFn('success')
    ;(ensureClone as unknown as {mockResolvedValue: (v: unknown) => void}).mockResolvedValue({
      success: false,
      error: {kind: 'workspace-failure', workspaceKind: 'clone-error', code: 'invalid-repo'},
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})

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

    // #and — no OpenCode session starts
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  it('checkout-handoff-failed is workspace-unavailable, not the retry-inviting message — a handoff failure (hardlink, filesystem boundary, deadline, entry cap) is deterministic and will not resolve on retry', async () => {
    // #given — clone-error code the workspace-agent returns when the post-clone ownership
    // handoff fails (apps/workspace-agent/src/clone.ts); the same staged tree fails the same
    // way every time, so this must land in the no-retry bucket, not `clone-timeout`'s or
    // `too-many-files`'s retryable one.
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const ensureClone = makeEnsureCloneFn('success')
    ;(ensureClone as unknown as {mockResolvedValue: (v: unknown) => void}).mockResolvedValue({
      success: false,
      error: {kind: 'workspace-failure', workspaceKind: 'clone-error', code: 'checkout-handoff-failed'},
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — no retry-inviting wording; the no-retry "an operator needs to look at it" wording
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.length > 0)
    expect(errorSend).toBeDefined()
    expect(errorSend?.content).not.toContain('not reachable')
    expect(errorSend?.content).not.toContain('try again later')
    expect(errorSend?.content).toContain('An operator needs to look at it')
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  it('clone response-mismatch is workspace-unavailable, not the retry-inviting message — the path comparison gives the same answer on every retry, and ensure-clone.ts already logs it as a security signal', async () => {
    // #given — ensureClone surfaces a workspace-failure/response-mismatch, the coarse
    // mapping of client.ts's strict full-path equality check failing (a possible tamper
    // signal, not a transient condition)
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const ensureClone = makeEnsureCloneFn('success')
    ;(ensureClone as unknown as {mockResolvedValue: (v: unknown) => void}).mockResolvedValue({
      success: false,
      error: {kind: 'workspace-failure', workspaceKind: 'response-mismatch'},
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — no "try again later" retry invitation for a check that returns the same
    // answer on every retry
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.length > 0)
    expect(errorSend).toBeDefined()
    expect(errorSend?.content).not.toContain('not reachable')
    expect(errorSend?.content).not.toContain('try again later')
    expect(errorSend?.content).toContain('An operator needs to look at it')
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
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})

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
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})

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
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})

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
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})

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
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})

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
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})

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
    const deps = makeDeps({ensureClone, update: makeUpdateFn('no-checkout')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — unchanged baseline behavior
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('not reachable'))
    expect(errorSend).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// The deterministic provenance line is appended into the reply buffer through
// a mutable guard (`provenanceLineAppended` in run.ts) that fires at most once
// per run — deliberately NOT on the generic failure and cancel paths (see the
// comment at the FAILED branch's flush call). These tests pin that "exactly
// once" contract on every delivery mode that DOES carry the buffer-channel
// line: both success transitions (live-status and typing-only, which differ
// only in whether the status controller "handles" the answer in place or
// "delegates" to a sink flush), a plain buffer-only success (the web
// transport's shape), and quarantine (whose flush explicitly re-uses the same
// buffer-append mechanism "so the buffer-only web transport still carries
// it"). A regression that appended the line twice (guard removed) or zero
// times (append call deleted) would fail these.
// ---------------------------------------------------------------------------

/** Count non-overlapping occurrences of the checked-ready line's stable opening marker. */
function countProvenanceMarker(text: string): number {
  return (text.match(/The checkout is already at `/g) ?? []).length
}

/** Stream-sink mock with a real accumulating buffer (unlike the static default). */
function makeTrackingStreamSinkMock() {
  let buffer = ''
  return {
    append: vi.fn((text: string) => {
      buffer += text
    }),
    flush: vi.fn().mockImplementation(async () => ({kind: 'sent' as const, charCount: buffer.length})),
    buffered: vi.fn(() => buffer),
    markVisibleOutputSent: vi.fn(),
    markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
    hasVisibleOutput: vi.fn().mockReturnValue(false),
  }
}

describe('the deterministic provenance line appears exactly once per delivery mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('success on live-status: resolveToAnswer(handled) carries the line exactly once — no separate flush to duplicate it', async () => {
    // #given — live-status mode; the status controller "handles" the answer by editing
    // the status message in place with the text it received
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const ctrl = makeStatusControllerMock({resolveToAnswerResult: {transition: 'handled'}})
    mockCreateDiscordStreamSink.mockReturnValue(makeTrackingStreamSinkMock())
    const message = makeMessage()
    const deps = makeDeps({statusMode: 'live-status', update: makeUpdateFn('ready')})

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — the line is in the exact text the status message was edited to
    expect(ctrl.resolveToAnswer).toHaveBeenCalledOnce()
    const finalText = ctrl.resolveToAnswer.mock.calls[0]?.[0] as string
    expect(countProvenanceMarker(finalText)).toBe(1)
  })

  it('success on typing-only: resolveToAnswer(delegated) → sink.flush carries the line exactly once', async () => {
    // #given — typing-only mode; the controller delegates (no status message), so the
    // flushed sink buffer is the only place the answer (and the line) is delivered
    const {runMention} = await import('./run.js')
    setupHappyPath()
    makeStatusControllerMock({resolveToAnswerResult: {transition: 'delegated'}})
    const streamSink = makeTrackingStreamSinkMock()
    mockCreateDiscordStreamSink.mockReturnValue(streamSink)
    const message = makeMessage()
    const deps = makeDeps({statusMode: 'typing-only', update: makeUpdateFn('ready')})

    // #when
    await runMention(message, makeBinding(), deps)

    // #then
    expect(streamSink.flush).toHaveBeenCalledOnce()
    expect(countProvenanceMarker(streamSink.buffered())).toBe(1)
  })

  it('web success: the buffer-only transport (no status controller) carries the line exactly once', async () => {
    // #given — the launchWork/in-memory-request shape the web transport uses: no status
    // message, `replySink.buffered()`/`flush()` is the only delivery channel
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    mockRunOpenCodeCore.mockImplementation(async params => {
      ;(params as {sink: {append: (t: string) => void}}).sink.append('the agent answer')
    })
    const request = makeInMemoryRequest()
    const deps = makeDeps({update: makeUpdateFn('ready')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then
    expect(countProvenanceMarker(request._replySink.buffered())).toBe(1)
  })

  it('quarantine: the flushed buffer carries the line exactly once', async () => {
    // #given — a quarantined RunCoreError; the quarantine branch appends the line into
    // the SAME buffer/guard mechanism as the success path ("so the buffer-only web
    // transport still carries it"), before flushing
    const {launchWork} = await import('./run.js')
    const {RunCoreError} = await import('./run-core.js')
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('stream-ended', 'stream closed', true))
    const request = makeInMemoryRequest()
    const deps = makeDeps({update: makeUpdateFn('ready')})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then
    expect(countProvenanceMarker(request._replySink.buffered())).toBe(1)
  })
})
