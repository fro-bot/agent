import {beforeEach, describe, expect, it, vi} from 'vitest'
/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module
   it mocks, to register vi.mock() side effects before those modules are evaluated */
import {
  awaitLaunchWorkRun,
  CHANNEL_ID,
  makeApprovalRegistry,
  makeBinding,
  makeDeps,
  makeMessage,
  makeStatefulPendingSinkMock,
  makeThread,
  mockCreateDiscordStreamSink,
  mockCreatePermissionCoordinator,
  mockRunOpenCodeCore,
  mockRuntime,
  setupHappyPath,
} from './test-helpers.js'
import * as attachModule from './opencode-attach.js'
import * as runCoreModule from './run-core.js'
/* eslint-enable perfectionist/sort-imports */

// ---------------------------------------------------------------------------
// Approvals — pending-visibility race, coordinator wiring, wait/timeout UX,
// dispose/shutdown, the throwing-factory regression, transport selection, and
// the adjoining approval-mode / registry-deadline coverage.
// ---------------------------------------------------------------------------

describe('runMention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Approval pending-visibility race ────────────────────────────────────

  describe('approval pending-visibility race', () => {
    it('approval send STARTED but UNRESOLVED when timeout fires → visible-output timeout copy chosen', async () => {
      // #given — the approval send promise never resolves before the timeout fires.
      // This is the core race: onPending fires (marking pending), runOpenCodeCore throws
      // timeout, classification reads hasVisibleOutput() → true (pending counts as visible).
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()

      const statefulSink = makeStatefulPendingSinkMock()
      mockCreateDiscordStreamSink.mockReturnValue(statefulSink)

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({runTimeoutMs: 600_000})

      // Capture onPending from the coordinator factory
      let capturedOnPending: ((req: import('../approvals/coordinator.js').PermissionRequest) => void) | undefined
      mockCreatePermissionCoordinator.mockImplementation(coordinatorDeps => {
        capturedOnPending = coordinatorDeps.onPending
        return {
          onPermissionAsked: vi.fn(),
          onPermissionReplied: vi.fn(),
          pending: vi.fn().mockReturnValue([]),
          dispose: vi.fn(),
          addOwnedSession: vi.fn(),
          isOwned: vi.fn().mockReturnValue(true),
        }
      })

      // thread.send returns a never-resolving promise for the first 2 calls
      // (waiting-status send + embed send) so they are still in-flight when
      // the timeout fires. The 3rd call (error message) resolves immediately.
      const neverResolves = new Promise<never>(() => {
        /* intentionally never resolves — simulates in-flight Discord send */
      })
      thread.send.mockReturnValueOnce(neverResolves).mockReturnValueOnce(neverResolves).mockResolvedValue(undefined)

      // runOpenCodeCore calls onPending (triggering the fire-and-forget sends)
      // then throws a timeout error — simulating the race condition.
      mockRunOpenCodeCore.mockImplementation(async () => {
        if (capturedOnPending !== undefined) {
          capturedOnPending({
            requestID: 'req-race-1',
            sessionID: 'sess-race',
            permission: 'bash',
            patterns: [],
            title: 'Run command: ls',
          })
        }
        throw new RunCoreError('timeout', 'timed out')
      })

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — visible-output branch chosen (pending send counts as visible context)
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toMatch(/updates above/i)
      expect(lastCall.content).toMatch(/new.*@fro-bot request|what to do next/i)
      // #and — does NOT use no-output retry wording
      expect(lastCall.content).not.toMatch(/please try again/i)
      // #and — the _(no output)_ fallback was NOT posted (flush returned skipped-visible)
      // This is the FIX 1 regression guard: flush() must not post _(no output)_ when a
      // pending send is in-flight, preventing the contradictory "(no output) + updates above" pair.
      expect(statefulSink._noOutputPosted()).toBe(false)
      // Verify flush returned skipped-visible (not empty)
      const flushResult = await ((statefulSink.flush as ReturnType<typeof vi.fn>).mock.results[0]?.value as Promise<{
        kind: string
      }>)
      expect(flushResult).toEqual({kind: 'skipped-visible'})
    })

    it('approval send PENDING at timeout + empty buffer → flush returns skipped-visible (no _(no output)_ posted) AND visible-output copy chosen', async () => {
      // Regression test for FIX 1: the flush/classification contradiction race.
      // When an approval send is still PENDING (not yet delivered) and the buffer is empty,
      // flush() must return {kind:'skipped-visible'} — NOT post _(no output)_ — so that
      // classification can then post the "updates above" copy without contradiction.
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()

      const statefulSink = makeStatefulPendingSinkMock()
      mockCreateDiscordStreamSink.mockReturnValue(statefulSink)

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({runTimeoutMs: 600_000})

      let capturedOnPending: ((req: import('../approvals/coordinator.js').PermissionRequest) => void) | undefined
      mockCreatePermissionCoordinator.mockImplementation(coordinatorDeps => {
        capturedOnPending = coordinatorDeps.onPending
        return {
          onPermissionAsked: vi.fn(),
          onPermissionReplied: vi.fn(),
          pending: vi.fn().mockReturnValue([]),
          dispose: vi.fn(),
          addOwnedSession: vi.fn(),
          isOwned: vi.fn().mockReturnValue(true),
        }
      })

      // The approval send never resolves — it is still PENDING when timeout fires.
      const neverResolves = new Promise<never>(() => {
        /* intentionally never resolves */
      })
      thread.send.mockReturnValueOnce(neverResolves).mockReturnValueOnce(neverResolves).mockResolvedValue(undefined)

      mockRunOpenCodeCore.mockImplementation(async () => {
        if (capturedOnPending !== undefined) {
          capturedOnPending({
            requestID: 'req-fix1-regression',
            sessionID: 'sess-fix1',
            permission: 'bash',
            patterns: [],
            title: 'Run command: ls',
          })
        }
        throw new RunCoreError('timeout', 'timed out')
      })

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — flush returned skipped-visible (pending send suppressed _(no output)_)
      expect(statefulSink._noOutputPosted()).toBe(false)
      const flushResult = await ((statefulSink.flush as ReturnType<typeof vi.fn>).mock.results[0]?.value as Promise<{
        kind: string
      }>)
      expect(flushResult).toEqual({kind: 'skipped-visible'})

      // #and — classification chose the visible-output branch ("updates above" copy)
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toMatch(/updates above/i)
      expect(lastCall.content).toMatch(/new.*@fro-bot request|what to do next/i)

      // #and — the contradictory _(no output)_ message was NOT sent at any point
      const allContents = thread.send.mock.calls.map(c => (c[0] as {content?: string}).content ?? '')
      expect(allContents.some(c => c.includes('_(no output)_'))).toBe(false)
    })

    it('approval send REJECTS before timeout fires → no-output timeout copy chosen', async () => {
      // #given — the approval send rejects (settle(false) retracts the pending claim).
      // After rejection, hasVisibleOutput() returns false → no-output branch.
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()

      const statefulSink = makeStatefulPendingSinkMock()
      mockCreateDiscordStreamSink.mockReturnValue(statefulSink)

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({runTimeoutMs: 600_000})

      let capturedOnPending: ((req: import('../approvals/coordinator.js').PermissionRequest) => void) | undefined
      mockCreatePermissionCoordinator.mockImplementation(coordinatorDeps => {
        capturedOnPending = coordinatorDeps.onPending
        return {
          onPermissionAsked: vi.fn(),
          onPermissionReplied: vi.fn(),
          pending: vi.fn().mockReturnValue([]),
          dispose: vi.fn(),
          addOwnedSession: vi.fn(),
          isOwned: vi.fn().mockReturnValue(true),
        }
      })

      // thread.send rejects for the first 2 calls (approval sends fail).
      // The 3rd call (error message) resolves immediately.
      const sendRejected = Promise.reject(new Error('Discord send failed'))
      // Attach a no-op catch so the unhandled rejection doesn't leak in test output
      sendRejected.catch(() => undefined)
      thread.send.mockReturnValueOnce(sendRejected).mockReturnValueOnce(sendRejected).mockResolvedValue(undefined)

      // runOpenCodeCore calls onPending then throws timeout.
      // The approval sends reject first (microtask queue), then timeout is classified.
      mockRunOpenCodeCore.mockImplementation(async () => {
        if (capturedOnPending !== undefined) {
          capturedOnPending({
            requestID: 'req-reject-1',
            sessionID: 'sess-reject',
            permission: 'bash',
            patterns: [],
            title: 'Run command: ls',
          })
        }
        // Yield to the microtask queue so the rejection .catch() handlers run
        // and settle(false) retracts the pending claim before the timeout is thrown.
        await new Promise(resolve => setTimeout(resolve, 0))
        throw new RunCoreError('timeout', 'timed out')
      })

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — no-output branch chosen (failed send retracted the pending claim)
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toMatch(/please try again/i)
      // #and — does NOT use visible-output wording
      expect(lastCall.content).not.toMatch(/updates above/i)
      expect(lastCall.content).not.toMatch(/what to do next/i)
    })

    it('approval send RESOLVES before timeout fires → visible-output timeout copy chosen', async () => {
      // #given — the approval send resolves successfully (settle(true) promotes to delivered).
      // This is the existing behavior preserved: successful send → visible-output branch.
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()

      const statefulSink = makeStatefulPendingSinkMock()
      mockCreateDiscordStreamSink.mockReturnValue(statefulSink)

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({runTimeoutMs: 600_000})

      let capturedOnPending: ((req: import('../approvals/coordinator.js').PermissionRequest) => void) | undefined
      mockCreatePermissionCoordinator.mockImplementation(coordinatorDeps => {
        capturedOnPending = coordinatorDeps.onPending
        return {
          onPermissionAsked: vi.fn(),
          onPermissionReplied: vi.fn(),
          pending: vi.fn().mockReturnValue([]),
          dispose: vi.fn(),
          addOwnedSession: vi.fn(),
          isOwned: vi.fn().mockReturnValue(true),
        }
      })

      // thread.send resolves immediately for all calls (approval sends succeed).
      const fakeApprovalMessage = {id: 'msg-approval-race', edit: vi.fn()}
      thread.send.mockResolvedValue(fakeApprovalMessage)

      // runOpenCodeCore calls onPending, yields so sends resolve, then throws timeout.
      mockRunOpenCodeCore.mockImplementation(async () => {
        if (capturedOnPending !== undefined) {
          capturedOnPending({
            requestID: 'req-resolve-1',
            sessionID: 'sess-resolve',
            permission: 'bash',
            patterns: [],
            title: 'Run command: ls',
          })
        }
        // Yield so the .then() handlers run and settle(true) promotes to delivered
        await new Promise(resolve => setTimeout(resolve, 0))
        throw new RunCoreError('timeout', 'timed out')
      })

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — visible-output branch chosen (send resolved → permanently delivered)
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toMatch(/updates above/i)
      expect(lastCall.content).toMatch(/new.*@fro-bot request|what to do next/i)
      // #and — does NOT use no-output retry wording
      expect(lastCall.content).not.toMatch(/please try again/i)
    })

    it('no approval requested + empty output + timeout → no-output copy (unchanged baseline)', async () => {
      // #given — no onPending ever called; sink has no visible output; timeout fires.
      // Verifies the baseline no-output path is unchanged by the pending-visibility feature.
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()

      const statefulSink = makeStatefulPendingSinkMock()
      mockCreateDiscordStreamSink.mockReturnValue(statefulSink)

      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({runTimeoutMs: 600_000})

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — no-output branch chosen (no approval, no visible output)
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toMatch(/please try again/i)
      // #and — does NOT use visible-output wording
      expect(lastCall.content).not.toMatch(/updates above/i)
      expect(lastCall.content).not.toMatch(/what to do next/i)
      // #and — includes configured duration
      expect(lastCall.content).toMatch(/10.?min/i)
    })
  })

  // ── Approval mode propagation ────────────────────────────────────────────

  describe('approval mode propagation', () => {
    it('approval-required: runOpenCodeCore is called with approvalMode === "approval-required"', async () => {
      // #given — default approval-required mode
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const deps = makeDeps({approvalMode: 'approval-required'})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — runOpenCodeCore called with approvalMode exactly 'approval-required'
      expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
      const coreParams = mockRunOpenCodeCore.mock.calls[0]?.[0] as {approvalMode?: string}
      expect(coreParams.approvalMode).toBe('approval-required')
    })
  })

  // ── Approval coordinator wiring ──────────────────────────────────────────

  describe('approval coordinator wiring', () => {
    it('no permission asked → registry.register and registry.applySettlement are never called', async () => {
      // #given — runOpenCodeCore resolves without triggering any permission callbacks
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const approvalRegistry = makeApprovalRegistry()
      const deps = makeDeps({approvalRegistry})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — no approval interactions
      expect(approvalRegistry.register).not.toHaveBeenCalled()
      expect(approvalRegistry.applySettlement).not.toHaveBeenCalled()
    })

    it('coordinator is created with a deadlineMs strictly less than runTimeoutMs and <= 13*60_000', async () => {
      // #given — deadline is computed directly from runTimeoutMs
      const {computeApprovalDeadlineMs} = await import('./run.js')

      const runTimeoutMs = 600_000
      const deadlineMs = computeApprovalDeadlineMs(runTimeoutMs)

      // Strictly less than runTimeoutMs
      expect(deadlineMs).toBeLessThan(runTimeoutMs)
      // At most 13 minutes (Discord interaction-token expiry guard)
      expect(deadlineMs).toBeLessThanOrEqual(13 * 60_000)
    })

    it('deadline math: approvalDeadlineMs < runTimeoutMs for all reasonable timeout values', async () => {
      // #given — test with a smaller runTimeoutMs
      const {computeApprovalDeadlineMs} = await import('./run.js')

      const runTimeoutMs = 120_000 // 2 min
      const deadlineMs = computeApprovalDeadlineMs(runTimeoutMs)
      expect(deadlineMs).toBeLessThan(runTimeoutMs)
      expect(deadlineMs).toBeLessThanOrEqual(13 * 60_000)
      expect(deadlineMs).toBeGreaterThan(0)
    })

    it('onPending: posts approval embed+buttons to thread and calls approvalRegistry.register with ensured canonical path', async () => {
      // #given — binding has a stale workspacePath; ensureClone returns the canonical path.
      // approvalRegistry.register must receive the canonical path, NOT the stale binding path.
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const canonicalPath = '/workspace/canonical/acme/widget'
      const staleBinding = {...makeBinding(), workspacePath: '/old/stale/path'}
      const ensureClone = vi.fn().mockResolvedValue({success: true as const, data: canonicalPath})

      const approvalRegistry = makeApprovalRegistry()
      const thread = makeThread()
      // Make thread.send return a message-like object
      const fakeApprovalMessage = {id: 'msg-approval-1', edit: vi.fn()}
      thread.send.mockResolvedValue(fakeApprovalMessage)
      const message = makeMessage(thread)
      const deps = makeDeps({approvalRegistry, ensureClone})

      // Capture the onPending callback from coordinator factory
      let capturedOnPending: ((req: import('../approvals/coordinator.js').PermissionRequest) => void) | undefined
      mockCreatePermissionCoordinator.mockImplementation(coordinatorDeps => {
        capturedOnPending = coordinatorDeps.onPending
        return {
          onPermissionAsked: vi.fn(),
          onPermissionReplied: vi.fn(),
          pending: vi.fn().mockReturnValue([]),
          dispose: vi.fn(),
          addOwnedSession: vi.fn(),
          isOwned: vi.fn().mockReturnValue(true),
        }
      })

      // #when — run completes first so coordinator is created
      await runMention(message, staleBinding, deps)

      expect(capturedOnPending).toBeDefined()

      // Simulate a permission request arriving
      const fakeRequest: import('../approvals/coordinator.js').PermissionRequest = {
        requestID: 'req-abc-123',
        sessionID: 'sess-xyz',
        permission: 'bash',
        patterns: [],
        title: 'Run command: ls',
      }
      if (capturedOnPending === undefined) throw new Error('onPending callback was not captured')
      capturedOnPending(fakeRequest)

      // Allow the async send().then() to settle
      await new Promise(resolve => setTimeout(resolve, 0))

      // #then — approval embed posted to thread
      expect(thread.send).toHaveBeenCalledWith(
        expect.objectContaining({
          embeds: expect.any(Array) as unknown,
          components: expect.any(Array) as unknown,
        }),
      )

      // #and — approvalRegistry.register called with the CANONICAL path from ensureClone,
      // NOT the stale binding.workspacePath
      expect(approvalRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({
          requestID: 'req-abc-123',
          approvalScopeId: thread.id,
          directory: canonicalPath,
        }),
      )
      expect(approvalRegistry.register).not.toHaveBeenCalledWith(
        expect.objectContaining({directory: '/old/stale/path'}),
      )
    })

    it('onReplied: calls approvalRegistry.confirmReply when coordinator fires onReplied', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const approvalRegistry = makeApprovalRegistry()
      const deps = makeDeps({approvalRegistry})
      const message = makeMessage()

      let capturedOnReplied:
        | ((event: {
            requestID: string
            sessionID: string
            reply: import('../approvals/coordinator.js').PermissionReply
          }) => void)
        | undefined
      mockCreatePermissionCoordinator.mockImplementation(coordinatorDeps => {
        capturedOnReplied = coordinatorDeps.onReplied
        return {
          onPermissionAsked: vi.fn(),
          onPermissionReplied: vi.fn(),
          pending: vi.fn().mockReturnValue([]),
          dispose: vi.fn(),
          addOwnedSession: vi.fn(),
          isOwned: vi.fn().mockReturnValue(true),
        }
      })

      // #when
      await runMention(message, makeBinding(), deps)

      expect(capturedOnReplied).toBeDefined()
      if (capturedOnReplied === undefined) throw new Error('onReplied callback was not captured')
      capturedOnReplied({requestID: 'req-abc-123', sessionID: 'sess-1', reply: 'once'})

      // Allow async confirmReply to fire
      await new Promise(resolve => setTimeout(resolve, 0))

      // #then
      expect(approvalRegistry.confirmReply).toHaveBeenCalledWith({
        requestID: 'req-abc-123',
        sessionID: 'sess-1',
        reply: 'once',
      })
    })

    it('coordinator.dispose is called in finally block after run completes', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const disposeFn = vi.fn()
      mockCreatePermissionCoordinator.mockReturnValue({
        onPermissionAsked: vi.fn(),
        onPermissionReplied: vi.fn(),
        pending: vi.fn().mockReturnValue([]),
        dispose: disposeFn,
        addOwnedSession: vi.fn(),
        isOwned: vi.fn().mockReturnValue(true),
      })

      const deps = makeDeps()
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — dispose called with 'run ended'
      expect(disposeFn).toHaveBeenCalledWith('run ended')
    })

    it('coordinator.dispose is called even when run-core throws', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()
      mockRunOpenCodeCore.mockRejectedValue(new Error('boom'))

      const disposeFn = vi.fn()
      mockCreatePermissionCoordinator.mockReturnValue({
        onPermissionAsked: vi.fn(),
        onPermissionReplied: vi.fn(),
        pending: vi.fn().mockReturnValue([]),
        dispose: disposeFn,
        addOwnedSession: vi.fn(),
        isOwned: vi.fn().mockReturnValue(true),
      })

      const deps = makeDeps()
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — dispose still called
      expect(disposeFn).toHaveBeenCalledWith('run ended')
    })

    it('postReply closure: calls handle.client.postSessionIdPermissionsPermissionId with query.directory — guards silent-no-op regression', async () => {
      // Regression guard: the OpenCode V1 reply route silently no-ops when `query.directory` is
      // absent (returns 200 but does not resolve the pending permission). This test pins that the
      // closure wired into registry.register actually forwards the workspace directory.

      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const postSessionIdPermissionsPermissionId = vi.fn().mockResolvedValue({error: null})

      vi.mocked(attachModule.attachOpencode).mockReturnValue({
        server: {url: 'http://workspace:9200'},
        session: {create: vi.fn(), prompt: vi.fn()},
        client: {postSessionIdPermissionsPermissionId},
      } as unknown as ReturnType<typeof attachModule.attachOpencode>)

      const approvalRegistry = makeApprovalRegistry()
      const thread = makeThread()
      const fakeApprovalMessage = {id: 'msg-approval-999', edit: vi.fn()}
      thread.send.mockResolvedValue(fakeApprovalMessage)
      const message = makeMessage(thread)
      const binding = makeBinding() // workspacePath = '/workspace/acme/widget'

      let capturedOnPending: ((req: import('../approvals/coordinator.js').PermissionRequest) => void) | undefined
      mockCreatePermissionCoordinator.mockImplementation(coordinatorDeps => {
        capturedOnPending = coordinatorDeps.onPending
        return {
          onPermissionAsked: vi.fn(),
          onPermissionReplied: vi.fn(),
          pending: vi.fn().mockReturnValue([]),
          dispose: vi.fn(),
          addOwnedSession: vi.fn(),
          isOwned: vi.fn().mockReturnValue(true),
        }
      })

      await runMention(message, binding, makeDeps({approvalRegistry}))

      if (capturedOnPending === undefined) throw new Error('onPending not captured')

      const fakeRequest: import('../approvals/coordinator.js').PermissionRequest = {
        requestID: 'req-seam-999',
        sessionID: 'sess-seam',
        permission: 'bash',
        patterns: ['ls'],
        title: 'Run command: ls',
      }

      // #when — trigger onPending (fires send().then() → register)
      capturedOnPending(fakeRequest)
      await new Promise(resolve => setTimeout(resolve, 0))

      // Extract the postReply closure from the register call
      const registerCall = (approvalRegistry.register as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | {effects: {postReply: (requestID: string, directory: string, decision: string) => Promise<{ok: boolean}>}}
        | undefined
      expect(registerCall).toBeDefined()
      if (registerCall === undefined) throw new Error('registerCall not captured')

      const capturedPostReply = registerCall.effects.postReply

      // #when — invoke the postReply closure
      await capturedPostReply('req-seam-999', binding.workspacePath, 'once')

      // #then — SDK endpoint called with session + permissionID in path AND directory in query
      expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          path: {id: fakeRequest.sessionID, permissionID: fakeRequest.requestID},
          body: {response: 'once'},
          query: {directory: binding.workspacePath},
        }),
      )
    })

    it('coordinator is passed into runOpenCodeCore as the coordinator param', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const fakeCoordinator = {
        onPermissionAsked: vi.fn(),
        onPermissionReplied: vi.fn(),
        pending: vi.fn().mockReturnValue([]),
        dispose: vi.fn(),
        addOwnedSession: vi.fn(),
        isOwned: vi.fn().mockReturnValue(true),
      }
      mockCreatePermissionCoordinator.mockReturnValue(fakeCoordinator)

      const deps = makeDeps()
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — runOpenCodeCore received the coordinator
      expect(mockRunOpenCodeCore).toHaveBeenCalledWith(
        expect.objectContaining({
          coordinator: fakeCoordinator,
        }),
      )
    })

    it('createApprovalOnPending factory: ApprovalTransportContext.directory equals canonical ensureClone path and approvalDeadlineMs is positive', async () => {
      // Regression guard: the factory must receive the canonical path from ensureClone,
      // not the stale binding.workspacePath. This is the Fix 4 assertion.
      const {launchWork} = await import('./run.js')
      setupHappyPath()

      const CANONICAL_PATH = '/workspace/canonical/acme/widget'
      const ensureClone = vi.fn().mockResolvedValue({success: true as const, data: CANONICAL_PATH})
      const staleBinding = {...makeBinding(), workspacePath: '/old/stale/path'}

      let capturedContext: import('./launch-types.js').ApprovalTransportContext | undefined
      const createApprovalOnPending = vi
        .fn()
        .mockImplementation((ctx: import('./launch-types.js').ApprovalTransportContext) => {
          capturedContext = ctx
          return (_req: import('../approvals/coordinator.js').PermissionRequest) => {
            /* no-op */
          }
        })

      const noopSettle = (_delivered: boolean) => {
        /* no-op */
      }
      const request: import('./launch-types.js').LaunchWorkRequest = {
        promptText: 'do the thing',
        channelId: CHANNEL_ID,
        guildId: undefined,
        surface: 'discord',
        binding: staleBinding,
        requester: {kind: 'discord-user', userId: 'user-111'},
        statusSink: {
          noteActivity: vi.fn(),
          setBusy: vi.fn(),
          resolveToAnswer: vi.fn().mockResolvedValue({transition: 'delegated'}),
          resolveToFailure: vi.fn().mockResolvedValue({transition: 'delegated'}),
          dispose: vi.fn().mockResolvedValue(undefined),
          setReaction: vi.fn(),
        },
        replySink: {
          send: vi.fn().mockResolvedValue({success: true, data: undefined}),
          append: vi.fn(),
          flush: vi.fn().mockResolvedValue({kind: 'sent', charCount: 0}),
          buffered: vi.fn().mockReturnValue(''),
          hasVisibleOutput: vi.fn().mockReturnValue(false),
          markVisibleOutputSent: vi.fn(),
          markVisibleOutputPending: vi.fn().mockReturnValue(noopSettle),
        },
        createApprovalOnPending,
      }

      const deps = makeDeps({ensureClone, runTimeoutMs: 600_000})

      // #when — await the run promise so the run completes before asserting
      await awaitLaunchWorkRun(launchWork, request, deps)

      // #then — factory was called
      expect(createApprovalOnPending).toHaveBeenCalledOnce()
      expect(capturedContext).toBeDefined()

      // #and — directory is the canonical path from ensureClone, NOT the stale binding path
      expect(capturedContext?.directory).toBe(CANONICAL_PATH)
      expect(capturedContext?.directory).not.toBe('/old/stale/path')

      // #and — approvalDeadlineMs is a positive number (not undefined, not zero)
      expect(typeof capturedContext?.approvalDeadlineMs).toBe('number')
      expect(capturedContext?.approvalDeadlineMs).toBeGreaterThan(0)
      // Must be strictly less than runTimeoutMs (aligned with remaining budget)
      expect(capturedContext?.approvalDeadlineMs).toBeLessThan(600_000)
      // Must not exceed 13 minutes (Discord interaction-token guard)
      expect(capturedContext?.approvalDeadlineMs).toBeLessThanOrEqual(13 * 60_000)
    })
  })

  // ── Approval wait and timeout UX ────────────────────────────────────────

  describe('approval wait and timeout UX', () => {
    it('computeApprovalDeadlineMs: uses remainingBudgetMs (not raw runTimeoutMs) — shorter budget yields shorter deadline', async () => {
      // #given — the function should accept remainingBudgetMs
      const {computeApprovalDeadlineMs} = await import('./run.js')

      const fullBudget = 600_000
      const halfBudget = 300_000

      const deadlineFull = computeApprovalDeadlineMs(fullBudget)
      const deadlineHalf = computeApprovalDeadlineMs(halfBudget)

      // Both should be defined and less than their respective budgets
      expect(deadlineFull).toBeDefined()
      expect(deadlineHalf).toBeDefined()
      // Shorter remaining budget → shorter or equal deadline
      // Use nullish coalescing to avoid conditional expect
      expect(deadlineHalf ?? 0).toBeLessThanOrEqual(deadlineFull ?? Infinity)
    })

    it('computeApprovalDeadlineMs: returns undefined when remaining budget is too short (< 90s)', async () => {
      // #given — very short remaining budget
      const {computeApprovalDeadlineMs} = await import('./run.js')

      // #then — undefined when budget is too short
      expect(computeApprovalDeadlineMs(80_000)).toBeUndefined()
      expect(computeApprovalDeadlineMs(90_000)).toBeUndefined()
      expect(computeApprovalDeadlineMs(91_000)).toBeDefined()
    })

    it('onPending: posts visible waiting-for-approval status to thread with allowedMentions:{parse:[]}', async () => {
      // Regression guard: a run blocked on approval must not end with only _(no output)_
      // because the user needs to see the run is waiting.

      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const thread = makeThread()
      const fakeApprovalMessage = {id: 'msg-approval-1', edit: vi.fn()}
      thread.send.mockResolvedValue(fakeApprovalMessage)
      const message = makeMessage(thread)
      const deps = makeDeps()

      let capturedOnPending: ((req: import('../approvals/coordinator.js').PermissionRequest) => void) | undefined
      mockCreatePermissionCoordinator.mockImplementation(coordinatorDeps => {
        capturedOnPending = coordinatorDeps.onPending
        return {
          onPermissionAsked: vi.fn(),
          onPermissionReplied: vi.fn(),
          pending: vi.fn().mockReturnValue([]),
          dispose: vi.fn(),
          addOwnedSession: vi.fn(),
          isOwned: vi.fn().mockReturnValue(true),
        }
      })

      // #when — run completes, then simulate permission ask
      await runMention(message, makeBinding(), deps)

      expect(capturedOnPending).toBeDefined()
      if (capturedOnPending === undefined) throw new Error('onPending not captured')

      const fakeRequest: import('../approvals/coordinator.js').PermissionRequest = {
        requestID: 'req-wait-1',
        sessionID: 'sess-wait',
        permission: 'bash',
        patterns: ['ls'],
        title: 'Run command: ls',
      }
      capturedOnPending(fakeRequest)
      await new Promise(resolve => setTimeout(resolve, 0))

      // #then — a waiting-for-approval status message was sent to the thread
      // (separate from the approval embed — this is a plain text status)
      const allSends = thread.send.mock.calls.map(
        c => c[0] as {content?: string; allowedMentions?: unknown; embeds?: unknown},
      )
      const statusSend = allSends.find(
        s => typeof s.content === 'string' && s.content.length > 0 && s.embeds === undefined,
      )
      expect(statusSend).toBeDefined()
      expect(statusSend?.allowedMentions).toEqual({parse: []})
      // Content must contain the approval-waiting wording
      expect(statusSend?.content).toContain('Waiting for tool approval')
    })

    it('onPending: sink.markVisibleOutputPending() is called and settle(true) fires on success so flush cannot add _(no output)_ after approval status', async () => {
      // #given — verifies the pending-visibility API is used: markVisibleOutputPending()
      // is called synchronously before the send, and the returned settle handle is called
      // with true on success (promoting to permanently delivered).
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const settleFn = vi.fn()
      const markVisibleOutputPendingFn = vi.fn().mockReturnValue(settleFn)
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 10}),
        buffered: vi.fn().mockReturnValue(''),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: markVisibleOutputPendingFn,
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })

      const thread = makeThread()
      const fakeApprovalMessage = {id: 'msg-approval-2', edit: vi.fn()}
      thread.send.mockResolvedValue(fakeApprovalMessage)
      const message = makeMessage(thread)
      const deps = makeDeps()

      let capturedOnPending: ((req: import('../approvals/coordinator.js').PermissionRequest) => void) | undefined
      mockCreatePermissionCoordinator.mockImplementation(coordinatorDeps => {
        capturedOnPending = coordinatorDeps.onPending
        return {
          onPermissionAsked: vi.fn(),
          onPermissionReplied: vi.fn(),
          pending: vi.fn().mockReturnValue([]),
          dispose: vi.fn(),
          addOwnedSession: vi.fn(),
          isOwned: vi.fn().mockReturnValue(true),
        }
      })

      await runMention(message, makeBinding(), deps)

      expect(capturedOnPending).toBeDefined()
      if (capturedOnPending === undefined) throw new Error('onPending not captured')

      capturedOnPending({
        requestID: 'req-mark-1',
        sessionID: 'sess-mark',
        permission: 'bash',
        patterns: [],
        title: 'Run command',
      })
      await new Promise(resolve => setTimeout(resolve, 0))

      // #then — markVisibleOutputPending was called (once per send: waiting-status + embed)
      expect(markVisibleOutputPendingFn).toHaveBeenCalled()
      // #and — the settle handle was called with true (sends succeeded → permanently delivered)
      expect(settleFn).toHaveBeenCalledWith(true)
    })

    it('deadline settlement: posts visible timed-out/denied status to thread with allowedMentions:{parse:[]}', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const thread = makeThread()
      const fakeApprovalMessage = {id: 'msg-approval-3', edit: vi.fn()}
      thread.send.mockResolvedValue(fakeApprovalMessage)
      const message = makeMessage(thread)
      const approvalRegistry = makeApprovalRegistry()
      const deps = makeDeps({approvalRegistry})

      let capturedOnPending: ((req: import('../approvals/coordinator.js').PermissionRequest) => void) | undefined
      mockCreatePermissionCoordinator.mockImplementation(coordinatorDeps => {
        capturedOnPending = coordinatorDeps.onPending
        return {
          onPermissionAsked: vi.fn(),
          onPermissionReplied: vi.fn(),
          pending: vi.fn().mockReturnValue([]),
          dispose: vi.fn(),
          addOwnedSession: vi.fn(),
          isOwned: vi.fn().mockReturnValue(true),
        }
      })

      await runMention(message, makeBinding(), deps)

      expect(capturedOnPending).toBeDefined()
      if (capturedOnPending === undefined) throw new Error('onPending not captured')

      capturedOnPending({
        requestID: 'req-deadline-1',
        sessionID: 'sess-deadline',
        permission: 'bash',
        patterns: [],
        title: 'Run command',
      })
      await new Promise(resolve => setTimeout(resolve, 0))

      // Extract the onDeadlineSettled callback from the register call
      const registerCall = (approvalRegistry.register as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        {onDeadlineSettled?: () => void | Promise<void>} | undefined
      expect(registerCall).toBeDefined()
      expect(registerCall?.onDeadlineSettled).toBeDefined()

      // #when — simulate deadline firing
      if (registerCall?.onDeadlineSettled !== undefined) {
        await registerCall.onDeadlineSettled()
      }

      // #then — a timed-out/denied status was sent to the thread
      const allSends = thread.send.mock.calls.map(
        c => c[0] as {content?: string; allowedMentions?: unknown; embeds?: unknown},
      )
      // There should be at least one plain-text status (waiting + timeout)
      const plainTextSends = allSends.filter(
        s => typeof s.content === 'string' && s.content.length > 0 && s.embeds === undefined,
      )
      expect(plainTextSends.length).toBeGreaterThanOrEqual(2) // waiting + timeout
      // All plain-text sends must have allowedMentions:{parse:[]}
      for (const s of plainTextSends) {
        expect(s.allowedMentions).toEqual({parse: []})
      }
      // The timeout message must contain approval timeout / could-not-continue semantics
      const timeoutSend = plainTextSends.find(
        s =>
          typeof s.content === 'string' &&
          (s.content.includes('timed out') || s.content.includes('could not continue')),
      )
      expect(timeoutSend).toBeDefined()
      expect(timeoutSend?.content).toMatch(/timed out|could not continue/i)
    })

    it('approval deadline uses remaining budget (elapsed time subtracted from runTimeoutMs)', async () => {
      // #given — simulate elapsed setup time so remainingBudgetMs differs from runTimeoutMs.
      // The registered deadlineMs must equal computeApprovalDeadlineMs(runTimeoutMs - elapsedMs).
      const {runMention, computeApprovalDeadlineMs} = await import('./run.js')
      setupHappyPath()

      const SIMULATED_ELAPSED_MS = 5_000 // 5 s of simulated setup time
      const SIMULATED_START_MS = 1_700_000_000_000
      const runTimeoutMs = 600_000
      let callCount = 0
      const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
        // First call: runStartMs capture at run entry → return base time
        // Subsequent calls: simulate elapsed setup time
        callCount++
        return callCount === 1 ? SIMULATED_START_MS : SIMULATED_START_MS + SIMULATED_ELAPSED_MS
      })

      const thread = makeThread()
      const fakeApprovalMessage = {id: 'msg-approval-4', edit: vi.fn()}
      thread.send.mockResolvedValue(fakeApprovalMessage)
      const message = makeMessage(thread)
      const approvalRegistry = makeApprovalRegistry()
      const deps = makeDeps({approvalRegistry, runTimeoutMs})

      let capturedOnPending: ((req: import('../approvals/coordinator.js').PermissionRequest) => void) | undefined
      mockCreatePermissionCoordinator.mockImplementation(coordinatorDeps => {
        capturedOnPending = coordinatorDeps.onPending
        return {
          onPermissionAsked: vi.fn(),
          onPermissionReplied: vi.fn(),
          pending: vi.fn().mockReturnValue([]),
          dispose: vi.fn(),
          addOwnedSession: vi.fn(),
          isOwned: vi.fn().mockReturnValue(true),
        }
      })

      await runMention(message, makeBinding(), deps)
      dateNowSpy.mockRestore()

      expect(capturedOnPending).toBeDefined()
      if (capturedOnPending === undefined) throw new Error('onPending not captured')

      capturedOnPending({
        requestID: 'req-budget-1',
        sessionID: 'sess-budget',
        permission: 'bash',
        patterns: [],
        title: 'Run command',
      })
      await new Promise(resolve => setTimeout(resolve, 0))

      // Extract the deadlineMs from the register call
      const registerCall = (approvalRegistry.register as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        {deadlineMs?: number} | undefined
      expect(registerCall).toBeDefined()

      // The deadline must equal computeApprovalDeadlineMs(runTimeoutMs - elapsedMs).
      // With SIMULATED_ELAPSED_MS = 5_000, remainingBudgetMs = 595_000.
      const expectedDeadlineMs = computeApprovalDeadlineMs(runTimeoutMs - SIMULATED_ELAPSED_MS)
      expect(registerCall?.deadlineMs).toBe(expectedDeadlineMs)
      // Sanity: must be strictly less than runTimeoutMs
      expect(registerCall?.deadlineMs ?? runTimeoutMs).toBeLessThan(runTimeoutMs)
      expect(registerCall?.deadlineMs ?? 0).toBeLessThanOrEqual(13 * 60_000)
    })

    it('hard abort signal and approval deadline both use remaining budget from the same origin — not raw runTimeoutMs', async () => {
      // Regression guard: AbortSignal.timeout() passed to runOpenCodeCore must use
      // remainingBudgetMs (runTimeoutMs − elapsed), not the raw configured runTimeoutMs.
      // We simulate elapsed setup time by controlling Date.now() so the two values differ.

      // #given — spy on AbortSignal.timeout to capture the argument it receives
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const SIMULATED_ELAPSED_MS = 5_000 // 5 s of simulated setup time
      const SIMULATED_START_MS = 1_700_000_000_000
      const runTimeoutMs = 600_000
      let callCount = 0
      const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
        // First call: runStartMs capture at run entry → return base time
        // Subsequent calls: simulate elapsed setup time
        callCount++
        return callCount === 1 ? SIMULATED_START_MS : SIMULATED_START_MS + SIMULATED_ELAPSED_MS
      })

      const abortTimeoutSpy = vi.spyOn(AbortSignal, 'timeout')

      const deps = makeDeps({runTimeoutMs})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // Capture calls before restoring spies
      const capturedCalls = abortTimeoutSpy.mock.calls.slice()
      dateNowSpy.mockRestore()
      abortTimeoutSpy.mockRestore()

      // #then — AbortSignal.timeout was called with remainingBudgetMs, not raw runTimeoutMs
      // Find the call that is NOT the 10_000 ms postReply guard (which is a fixed constant)
      const runBudgetCall = capturedCalls.find(([ms]) => ms !== 10_000)
      expect(runBudgetCall).toBeDefined()
      const signalBudgetMs = runBudgetCall?.[0]
      // Must be strictly less than runTimeoutMs (elapsed time was subtracted)
      expect(signalBudgetMs).toBeLessThan(runTimeoutMs)
      // Must be approximately runTimeoutMs − SIMULATED_ELAPSED_MS
      expect(signalBudgetMs).toBeLessThanOrEqual(runTimeoutMs - SIMULATED_ELAPSED_MS + 100) // +100ms tolerance
      expect(signalBudgetMs).toBeGreaterThan(0)
    })
  })
})

describe('TDZ regression: throwing createApprovalOnPending factory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('factory that throws is handled cleanly: outer catch fires, concurrency slot released, no unhandled error', async () => {
    // Regression guard: if `createApprovalOnPending` throws, the outer catch block must
    // handle the error gracefully. The inner try/finally (which calls coordinator.dispose)
    // is never entered because coordinator is only created AFTER the factory call succeeds.
    // The outer finally must still release the concurrency slot.
    //
    // This test also guards against any future refactor that might accidentally introduce
    // a TDZ error by referencing coordinator before it is initialized.
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const FACTORY_ERROR = new Error('createApprovalOnPending factory threw')
    const createApprovalOnPending = vi.fn().mockImplementation(() => {
      throw FACTORY_ERROR
    })

    const releaseFn = vi.fn()
    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}

    const noopSettle = (_delivered: boolean) => {
      /* no-op */
    }
    const request: import('./launch-types.js').LaunchWorkRequest = {
      promptText: 'do the thing',
      channelId: CHANNEL_ID,
      guildId: undefined,
      surface: 'discord',
      binding: makeBinding(),
      requester: {kind: 'discord-user', userId: 'user-111'},
      statusSink: {
        noteActivity: vi.fn(),
        setBusy: vi.fn(),
        resolveToAnswer: vi.fn().mockResolvedValue({transition: 'delegated'}),
        resolveToFailure: vi.fn().mockResolvedValue({transition: 'delegated'}),
        dispose: vi.fn().mockResolvedValue(undefined),
        setReaction: vi.fn(),
      },
      replySink: {
        send: vi.fn().mockResolvedValue({success: true, data: undefined}),
        append: vi.fn(),
        flush: vi.fn().mockResolvedValue({kind: 'sent', charCount: 0}),
        buffered: vi.fn().mockReturnValue(''),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(noopSettle),
      },
      createApprovalOnPending,
    }

    const deps = makeDeps({
      concurrency: {
        tryAcquire: vi.fn().mockReturnValue('ok'),
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      },
      logger,
    })

    // #when — must not throw "Cannot access 'coordinator' before initialization"
    // and must not throw at all (error is caught and handled internally).
    // launchWork now returns LaunchAdmission (not void); await the run promise too.
    const admission = await launchWork(request, deps)
    // The factory throws inside executeWorkOnHeldSlot (fire-and-forget); await the run promise
    // so the outer finally (slot release) runs before we assert.
    if (admission.accepted === true && admission.runPromise !== undefined) {
      await admission.runPromise
    }

    // #then — concurrency slot released (outer finally ran despite factory throw)
    expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)

    // #and — the factory error was NOT a TDZ error
    // (If TDZ occurred, the error message would contain "Cannot access 'coordinator'")
    const errorCalls = logger.error.mock.calls
    for (const call of errorCalls) {
      const errMsg = String((call[1] as {err?: string})?.err ?? call[0] ?? '')
      expect(errMsg).not.toContain("Cannot access 'coordinator' before initialization")
    }
  })
})

describe('approval: pending wait → decision → run continues', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a pending approval that resolves with "once" allows the run to complete successfully', async () => {
    // #given — coordinator.onPermissionAsked resolves with 'once' (approved)
    // This pins the current behavior: when an approval is granted, the run
    // continues to completion (COMPLETED transition, succeeded reaction).
    const {runMention} = await import('./run.js')
    setupHappyPath()

    // Wire a real coordinator that resolves the permission immediately with 'once'
    mockCreatePermissionCoordinator.mockImplementation(_coordinatorDeps => {
      return {
        onPermissionAsked: vi.fn().mockResolvedValue('once' as const),
        onPermissionReplied: vi.fn(),
        pending: vi.fn().mockReturnValue([]),
        dispose: vi.fn(),
        addOwnedSession: vi.fn(),
        isOwned: vi.fn().mockReturnValue(true),
      }
    })

    // runOpenCodeCore calls onPermissionAsked and awaits the result
    mockRunOpenCodeCore.mockImplementation(async params => {
      const {coordinator} = params as {coordinator: import('../approvals/coordinator.js').PermissionCoordinator}
      const reply = await coordinator.onPermissionAsked({
        requestID: 'req-approved-1',
        sessionID: 'sess-approved',
        permission: 'bash',
        patterns: ['ls'],
        title: 'Run command: ls',
      })
      // Approved — run continues
      expect(reply).toBe('once')
    })

    const message = makeMessage()
    const deps = makeDeps()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — run completed (not failed)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('COMPLETED')
    expect(transitionPhases).not.toContain('FAILED')
  })

  it('a pending approval that resolves with "reject" causes the run to fail-close (run-core sees reject)', async () => {
    // #given — coordinator.onPermissionAsked resolves with 'reject' (denied)
    // This pins the current behavior: when an approval is rejected, run-core
    // receives 'reject' and the run fails.
    const {runMention} = await import('./run.js')
    setupHappyPath()

    mockCreatePermissionCoordinator.mockImplementation(() => {
      return {
        onPermissionAsked: vi.fn().mockResolvedValue('reject' as const),
        onPermissionReplied: vi.fn(),
        pending: vi.fn().mockReturnValue([]),
        dispose: vi.fn(),
        addOwnedSession: vi.fn(),
        isOwned: vi.fn().mockReturnValue(true),
      }
    })

    // runOpenCodeCore calls onPermissionAsked, gets 'reject', and throws
    mockRunOpenCodeCore.mockImplementation(async params => {
      const {coordinator} = params as {coordinator: import('../approvals/coordinator.js').PermissionCoordinator}
      const reply = await coordinator.onPermissionAsked({
        requestID: 'req-rejected-1',
        sessionID: 'sess-rejected',
        permission: 'bash',
        patterns: ['rm -rf /'],
        title: 'Run command: rm -rf /',
      })
      expect(reply).toBe('reject')
      // run-core would throw on reject — simulate that
      const {RunCoreError} = runCoreModule
      throw new RunCoreError('session-error', 'permission rejected')
    })

    const thread = makeThread()
    const message = makeMessage(thread)
    const deps = makeDeps()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — run transitioned to FAILED
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('COMPLETED')
  })
})

// ---------------------------------------------------------------------------
// Approval timeout: registry deadline → fail-closed reject (registry-level)
// ---------------------------------------------------------------------------

describe('approval timeout: registry deadline fires → fail-closed reject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registry deadline fires on open entry → postReply called with reject, entry removed', async () => {
    // #given — a registry entry with a very short deadline
    // This pins the current registry behavior: when the deadline fires on an
    // open entry, it POSTs reject and removes the entry (fail-closed).
    const {createApprovalRegistry} = await import('../approvals/registry.js')
    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const registry = createApprovalRegistry({logger})

    const postReply = vi.fn().mockResolvedValue({ok: true})
    const onDeadlineSettled = vi.fn()

    registry.register({
      requestID: 'req-deadline-reg-1',
      sessionID: 'ses-deadline',
      approvalScopeId: 'chan-deadline',
      directory: '/ws/deadline',
      request: {
        requestID: 'req-deadline-reg-1',
        sessionID: 'ses-deadline',
        permission: 'bash',
        patterns: [],
        title: 'Run command',
      },
      effects: {postReply},
      deadlineMs: 10, // very short deadline
      onDeadlineSettled,
    })

    expect(registry.has('req-deadline-reg-1')).toBe(true)

    // #when — wait for deadline to fire
    await new Promise(resolve => setTimeout(resolve, 50))

    // #then — entry removed (fail-closed)
    expect(registry.has('req-deadline-reg-1')).toBe(false)
    // #and — postReply called with 'reject'
    expect(postReply).toHaveBeenCalledWith('req-deadline-reg-1', '/ws/deadline', 'reject')
    // #and — onDeadlineSettled callback invoked
    expect(onDeadlineSettled).toHaveBeenCalledOnce()
  })

  it('registry deadline fires while entry is claimed (button in-flight) → deadline is a no-op (button wins)', async () => {
    // #given — entry is claimed (button click in-flight) when deadline fires
    // This pins the current winner-vs-loser rule: claimed state beats the deadline.
    const {createApprovalRegistry} = await import('../approvals/registry.js')
    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const registry = createApprovalRegistry({logger})

    // postReply hangs so the entry stays in 'claimed' state when deadline fires
    let resolvePostReply!: (value: {ok: boolean}) => void
    const postReply = vi.fn().mockReturnValue(
      new Promise<{ok: boolean}>(resolve => {
        resolvePostReply = resolve
      }),
    )
    const onDeadlineSettled = vi.fn()

    registry.register({
      requestID: 'req-deadline-claimed-1',
      sessionID: 'ses-claimed',
      approvalScopeId: 'chan-claimed',
      directory: '/ws/claimed',
      request: {
        requestID: 'req-deadline-claimed-1',
        sessionID: 'ses-claimed',
        permission: 'bash',
        patterns: [],
        title: 'Run command',
      },
      effects: {postReply},
      deadlineMs: 20,
      onDeadlineSettled,
    })

    // Claim the entry (decision submitted) before deadline fires
    const decisionPromise = registry.handleDecision({
      requestID: 'req-deadline-claimed-1',
      approvalScopeId: 'chan-claimed',
      decision: 'once',
      actor: {kind: 'discord-user', userId: 'user-1'},
    })

    // #when — wait for deadline to fire (entry is claimed)
    await new Promise(resolve => setTimeout(resolve, 50))

    // #then — deadline is a no-op (entry still exists, claimed by button)
    // onDeadlineSettled NOT called (deadline lost to button)
    expect(onDeadlineSettled).not.toHaveBeenCalled()
    // Entry still exists (button owns it)
    expect(registry.has('req-deadline-claimed-1')).toBe(true)

    // Cleanup: resolve the button's postReply
    resolvePostReply({ok: true})
    await decisionPromise
  })
})

// ---------------------------------------------------------------------------
// Approval dispose/shutdown: onDispose → disposeRun fail-closes pending entries
// ---------------------------------------------------------------------------

describe('approval dispose/shutdown: onDispose fail-closes pending registry entries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('coordinator dispose calls onDispose which calls registry.disposeRun — pending entries fail-closed', async () => {
    // #given — a coordinator wired to a real registry; a pending entry exists
    // This pins the current behavior: coordinator.dispose → onDispose → registry.disposeRun
    // → pending entries are fail-closed (postReply called with 'reject', entry removed).
    //
    // NOTE: coordinator.js is mocked at the module level in run.test.ts, so we use
    // vi.importActual to get the real implementation for this integration test.
    const {createApprovalRegistry} = await import('../approvals/registry.js')
    const {createPermissionCoordinator: realCreatePermissionCoordinator} =
      await vi.importActual<typeof import('../approvals/coordinator.js')>('../approvals/coordinator.js')

    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const registry = createApprovalRegistry({logger})

    const postReply = vi.fn().mockResolvedValue({ok: true})
    registry.register({
      requestID: 'req-dispose-1',
      sessionID: 'ses-dispose',
      approvalScopeId: 'chan-dispose',
      directory: '/ws/dispose',
      request: {
        requestID: 'req-dispose-1',
        sessionID: 'ses-dispose',
        permission: 'bash',
        patterns: [],
        title: 'Run command',
      },
      effects: {postReply},
    })

    expect(registry.has('req-dispose-1')).toBe(true)

    const coordinator = realCreatePermissionCoordinator({
      logger,
      onDispose: sessionIDs => {
        // eslint-disable-next-line no-void
        void Promise.all(sessionIDs.map(async sid => registry.disposeRun(sid, 'run ended')))
      },
    })

    // Register the request with the coordinator so it tracks the sessionID
    // eslint-disable-next-line no-void
    void coordinator.onPermissionAsked({
      requestID: 'req-dispose-1',
      sessionID: 'ses-dispose',
      permission: 'bash',
      patterns: [],
      title: 'Run command',
    })

    // #when — coordinator disposed (run teardown)
    coordinator.dispose('run ended')

    // Allow async disposeRun to complete
    await new Promise(resolve => setTimeout(resolve, 10))

    // #then — entry fail-closed (removed from registry)
    expect(registry.has('req-dispose-1')).toBe(false)
    // #and — postReply called with 'reject' (fail-closed)
    expect(postReply).toHaveBeenCalledWith('req-dispose-1', '/ws/dispose', 'reject')
  })

  it('registry.disposeAll fail-closes all pending entries across all sessions (gateway shutdown)', async () => {
    // #given — multiple pending entries across different sessions
    const {createApprovalRegistry} = await import('../approvals/registry.js')
    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const registry = createApprovalRegistry({logger})

    const postReplyA = vi.fn().mockResolvedValue({ok: true})
    const postReplyB = vi.fn().mockResolvedValue({ok: true})

    registry.register({
      requestID: 'req-shutdown-A',
      sessionID: 'ses-A',
      approvalScopeId: 'chan-A',
      directory: '/ws/a',
      request: {requestID: 'req-shutdown-A', sessionID: 'ses-A', permission: 'bash', patterns: [], title: 'cmd A'},
      effects: {postReply: postReplyA},
    })
    registry.register({
      requestID: 'req-shutdown-B',
      sessionID: 'ses-B',
      approvalScopeId: 'chan-B',
      directory: '/ws/b',
      request: {requestID: 'req-shutdown-B', sessionID: 'ses-B', permission: 'bash', patterns: [], title: 'cmd B'},
      effects: {postReply: postReplyB},
    })

    expect(registry.has('req-shutdown-A')).toBe(true)
    expect(registry.has('req-shutdown-B')).toBe(true)

    // #when — gateway shutdown: disposeAll
    await registry.disposeAll('gateway shutdown')

    // #then — all entries removed
    expect(registry.has('req-shutdown-A')).toBe(false)
    expect(registry.has('req-shutdown-B')).toBe(false)
    // #and — both postReply calls made with 'reject'
    expect(postReplyA).toHaveBeenCalledWith('req-shutdown-A', '/ws/a', 'reject')
    expect(postReplyB).toHaveBeenCalledWith('req-shutdown-B', '/ws/b', 'reject')
  })
})

describe('approval transport selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('discord approval behavior is unchanged when no approval factory is provided (default path)', async () => {
    // #given — a standard Discord mention with no createApprovalOnPending override
    const {runMention} = await import('./run.js')
    setupHappyPath()

    let capturedOnPending: ((req: import('../approvals/coordinator.js').PermissionRequest) => void) | undefined
    mockCreatePermissionCoordinator.mockImplementation(coordinatorDeps => {
      capturedOnPending = coordinatorDeps.onPending
      return {
        onPermissionAsked: vi.fn(),
        onPermissionReplied: vi.fn(),
        pending: vi.fn().mockReturnValue([]),
        dispose: vi.fn(),
        addOwnedSession: vi.fn(),
        isOwned: vi.fn().mockReturnValue(true),
      }
    })

    const message = makeMessage()
    const deps = makeDeps()

    // #when — run completes normally
    await runMention(message, makeBinding(), deps)

    // #then — coordinator was created with an onPending callback (Discord transport wired)
    expect(capturedOnPending).toBeDefined()
    // #and — execution completed (Discord path unchanged)
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
  })

  it('createApprovalOnPending factory is called with engine-owned context and its callback is used instead of Discord transport', async () => {
    // #given — a LaunchWorkRequest with a createApprovalOnPending factory (simulating web transport)
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    // Capture the context the engine passes to the factory
    let capturedContext: import('./launch-types.js').ApprovalTransportContext | undefined
    const webApprovalOnPending = vi.fn()
    const webFactory = vi.fn((ctx: import('./launch-types.js').ApprovalTransportContext) => {
      capturedContext = ctx
      return webApprovalOnPending
    })

    let capturedOnPending: ((req: import('../approvals/coordinator.js').PermissionRequest) => void) | undefined
    mockCreatePermissionCoordinator.mockImplementation(coordinatorDeps => {
      capturedOnPending = coordinatorDeps.onPending
      return {
        onPermissionAsked: vi.fn(),
        onPermissionReplied: vi.fn(),
        pending: vi.fn().mockReturnValue([]),
        dispose: vi.fn(),
        addOwnedSession: vi.fn(),
        isOwned: vi.fn().mockReturnValue(true),
      }
    })

    const noopSettle = (_delivered: boolean) => {
      /* no-op */
    }
    const request: import('./launch-types.js').LaunchWorkRequest = {
      promptText: 'do the thing',
      channelId: CHANNEL_ID,
      guildId: undefined,
      surface: 'web',
      binding: makeBinding(),
      requester: {kind: 'web-operator', githubUserId: 12345, login: 'octocat', sessionCorrelationId: 'sess-abc'},
      statusSink: {
        noteActivity: vi.fn(),
        setBusy: vi.fn(),
        resolveToAnswer: vi.fn().mockResolvedValue({transition: 'delegated'}),
        resolveToFailure: vi.fn().mockResolvedValue({transition: 'delegated'}),
        dispose: vi.fn().mockResolvedValue(undefined),
        setReaction: vi.fn(),
      },
      replySink: {
        send: vi.fn().mockResolvedValue({success: true, data: undefined}),
        append: vi.fn(),
        flush: vi.fn().mockResolvedValue({kind: 'sent', charCount: 0}),
        buffered: vi.fn().mockReturnValue(''),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(noopSettle),
      },
      createApprovalOnPending: webFactory,
    }
    const deps = makeDeps()

    // #when — launch with web surface and createApprovalOnPending factory
    // Await the run promise so the run completes before asserting
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — factory was called exactly once (engine called it with context)
    expect(webFactory).toHaveBeenCalledOnce()

    // #then — context carries all engine-owned fields a web transport needs
    expect(capturedContext).toBeDefined()
    // canonical directory (from ensureClone, not stale binding.workspacePath)
    expect(typeof capturedContext?.directory).toBe('string')
    expect(capturedContext?.directory.length).toBeGreaterThan(0)
    // approval deadline (aligned with run budget)
    expect(
      capturedContext?.approvalDeadlineMs === undefined || typeof capturedContext?.approvalDeadlineMs === 'number',
    ).toBe(true)
    // runId — stable UUID for this run
    expect(typeof capturedContext?.runId).toBe('string')
    expect(capturedContext?.runId.length).toBeGreaterThan(0)
    // repo — owner/repo string
    expect(typeof capturedContext?.repo).toBe('string')
    expect(capturedContext?.repo).toContain('/')
    // approvalRegistry — the program-scoped registry
    expect(capturedContext?.approvalRegistry).toBeDefined()
    expect(typeof capturedContext?.approvalRegistry?.register).toBe('function')
    expect(typeof capturedContext?.approvalRegistry?.handleDecision).toBe('function')
    // replySink — the run's reply sink
    expect(capturedContext?.replySink).toBeDefined()
    expect(typeof capturedContext?.replySink?.send).toBe('function')
    // postReplyFactory — factory for per-request SDK reply closures
    expect(typeof capturedContext?.postReplyFactory).toBe('function')

    // #then — coordinator was created with an onPending callback
    expect(capturedOnPending).toBeDefined()

    // #when — simulate a permission request arriving
    if (capturedOnPending !== undefined) {
      capturedOnPending({
        requestID: 'per_web_1',
        sessionID: 'ses_web_1',
        permission: 'bash',
        patterns: [],
        title: 'Run command: ls',
      })
    }

    // #then — the web callback was called (not Discord transport)
    expect(webApprovalOnPending).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({requestID: 'per_web_1', permission: 'bash'}),
    )
  })

  it('web surface run compiles and executes without unsafe casts', async () => {
    // #given — a LaunchWorkRequest with surface: 'web' (type-safe, no cast needed)
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const noopSettle = (_delivered: boolean) => {
      /* no-op */
    }
    const request: import('./launch-types.js').LaunchWorkRequest = {
      promptText: 'do the thing',
      channelId: CHANNEL_ID,
      guildId: undefined,
      surface: 'web', // typed as Surface — no 'as Surface' cast needed
      binding: makeBinding(),
      requester: {kind: 'web-operator', githubUserId: 99999, login: 'webuser', sessionCorrelationId: 'sess-xyz'},
      statusSink: {
        noteActivity: vi.fn(),
        setBusy: vi.fn(),
        resolveToAnswer: vi.fn().mockResolvedValue({transition: 'delegated'}),
        resolveToFailure: vi.fn().mockResolvedValue({transition: 'delegated'}),
        dispose: vi.fn().mockResolvedValue(undefined),
        setReaction: vi.fn(),
      },
      replySink: {
        send: vi.fn().mockResolvedValue({success: true, data: undefined}),
        append: vi.fn(),
        flush: vi.fn().mockResolvedValue({kind: 'sent', charCount: 0}),
        buffered: vi.fn().mockReturnValue(''),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(noopSettle),
      },
    }
    const deps = makeDeps()

    // #when — launch with web surface; await the run promise to verify execution
    const admission = await launchWork(request, deps)
    // launchWork returns admission early; await the run promise to verify execution completed
    if (admission.accepted === true && admission.runPromise !== undefined) {
      await admission.runPromise
    }

    // #then — execution completed (web surface is now a valid Surface value)
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    // #and — acquireLock was called with 'web' surface (no cast, no error)
    expect(mockRuntime.acquireLock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      'web',
      expect.any(String),
      expect.anything(),
    )
  })
})
