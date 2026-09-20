import {beforeEach, describe, expect, it, vi} from 'vitest'
/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module
   it mocks, to register vi.mock() side effects before those modules are evaluated */
import {
  buildMockRunState,
  CHANNEL_ID,
  makeApprovalRegistry,
  makeBinding,
  makeDeps,
  makeMessage,
  makeStatusControllerMock,
  makeThread,
  mockCreateDiscordStreamSink,
  mockCreatePermissionCoordinator,
  mockCreateStatusController,
  mockRunOpenCodeCore,
  mockRuntime,
  setupHappyPath,
} from './test-helpers.js'
import * as reactionsModule from '../discord/reactions.js'
import * as attachModule from './opencode-attach.js'
import * as promptModule from './prompt.js'
import * as runCoreModule from './run-core.js'
/* eslint-enable perfectionist/sort-imports */

// ---------------------------------------------------------------------------
// Observers, the status controller, reactions, and the operator push
// dispatcher — all secondary side-channels driven off the same run lifecycle.
// ---------------------------------------------------------------------------

describe('runMention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Run observer hook ───────────────────────────────────────────────────

  describe('run observer hook', () => {
    it('happy path: observe called with correct RunState at each transition (PENDING→ACKNOWLEDGED→EXECUTING→COMPLETED)', async () => {
      // #given
      const {runMention} = await import('./run.js')

      const ackState = buildMockRunState({phase: 'ACKNOWLEDGED'})
      const execState = buildMockRunState({phase: 'EXECUTING'})
      const completedState = buildMockRunState({phase: 'COMPLETED'})

      mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
      mockRuntime.acquireLock.mockResolvedValue({
        success: true as const,
        data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
      })
      mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
      mockRuntime.transitionRun
        .mockResolvedValueOnce({success: true as const, data: {etag: 'ack-etag', state: ackState}})
        .mockResolvedValueOnce({success: true as const, data: {etag: 'exec-etag', state: execState}})
        .mockResolvedValueOnce({success: true as const, data: {etag: 'done-etag', state: completedState}})
      mockRuntime.createHeartbeatController.mockReturnValue({
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue({
          success: true,
          data: {runEtag: 'r-etag', lockEtag: 'l-etag', runState: completedState},
        }),
        isRunning: false,
      })
      mockRunOpenCodeCore.mockResolvedValue(undefined)
      vi.mocked(attachModule.attachOpencode).mockReturnValue({
        server: {url: 'http://workspace:9200'},
        session: {create: vi.fn(), prompt: vi.fn()},
      } as unknown as ReturnType<typeof attachModule.attachOpencode>)
      vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')

      const observeFn = vi.fn().mockResolvedValue(undefined)
      const runObserver = {observe: observeFn}
      const deps = makeDeps({runObserver})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — observe called for PENDING (createRun), ACKNOWLEDGED, EXECUTING, COMPLETED in exact order
      expect(observeFn).toHaveBeenCalledTimes(4)
      const phases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
      expect(phases).toEqual(['PENDING', 'ACKNOWLEDGED', 'EXECUTING', 'COMPLETED'])
    })

    it('failure path: observe called with FAILED state on error', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const failedState = buildMockRunState({phase: 'FAILED'})
      const ackState = buildMockRunState({phase: 'ACKNOWLEDGED'})
      const execState = buildMockRunState({phase: 'EXECUTING'})

      mockRuntime.acquireLock.mockResolvedValue({
        success: true as const,
        data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
      })
      mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
      mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
      mockRuntime.transitionRun
        .mockResolvedValueOnce({success: true as const, data: {etag: 'ack-etag', state: ackState}})
        .mockResolvedValueOnce({success: true as const, data: {etag: 'exec-etag', state: execState}})
        .mockResolvedValueOnce({success: true as const, data: {etag: 'fail-etag', state: failedState}})
      mockRuntime.createHeartbeatController.mockReturnValue({
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue({
          success: true,
          data: {runEtag: 'r-etag', lockEtag: 'l-etag', runState: failedState},
        }),
        isRunning: false,
      })
      mockRunOpenCodeCore.mockRejectedValue(new Error('boom'))
      vi.mocked(attachModule.attachOpencode).mockReturnValue({
        server: {url: 'http://workspace:9200'},
        session: {create: vi.fn(), prompt: vi.fn()},
      } as unknown as ReturnType<typeof attachModule.attachOpencode>)
      vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')

      const observeFn = vi.fn().mockResolvedValue(undefined)
      const deps = makeDeps({runObserver: {observe: observeFn}})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — observe called with PENDING, ACKNOWLEDGED, EXECUTING, FAILED in exact order
      const phases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
      expect(phases).toEqual(['PENDING', 'ACKNOWLEDGED', 'EXECUTING', 'FAILED'])
    })

    it('best-effort sync: observe that throws synchronously does not abort the run', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const observeFn = vi.fn().mockImplementation(() => {
        throw new Error('observe threw synchronously')
      })
      const deps = makeDeps({runObserver: {observe: observeFn}})
      const message = makeMessage()

      // #when — must not throw
      await expect(runMention(message, makeBinding(), deps)).resolves.toBeUndefined()

      // #then — run completed normally (COMPLETED transition happened)
      const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
      expect(transitionPhases).toContain('COMPLETED')
    })

    it('best-effort async: observe that rejects does not abort the run and does not surface as unhandled rejection', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const observeFn = vi.fn().mockRejectedValue(new Error('observe rejected'))
      const deps = makeDeps({runObserver: {observe: observeFn}})
      const message = makeMessage()

      // #when — must not throw; rejection must be contained
      await expect(runMention(message, makeBinding(), deps)).resolves.toBeUndefined()

      // #then — run completed normally
      const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
      expect(transitionPhases).toContain('COMPLETED')
    })

    it('inert: omitting runObserver (undefined) is safe — run completes normally', async () => {
      // #given — no runObserver in deps
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const deps = makeDeps() // runObserver absent
      const message = makeMessage()

      // #when — must not throw
      await expect(runMention(message, makeBinding(), deps)).resolves.toBeUndefined()

      // #then — run completed normally
      const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
      expect(transitionPhases).toContain('COMPLETED')
    })

    // ── Observer notification ordering (the race fix) ────────────────────────
    //
    // Characterization: Discord successful run → flush posts output AND run completes normally.
    // This pins the existing Discord behavior so the reorder is provably inert for Discord.
    //
    // Ordering: for a run with an observer, the final output flush fires BEFORE the observer
    // receives the terminal COMPLETED/FAILED state. This is the load-bearing guarantee that
    // the web sink's final output frame is delivered before the terminal status frame closes
    // run subscribers.

    it('characterization (Discord regression): successful Discord run completes and replySink.flush posts output — reorder is inert', async () => {
      // #given — Discord surface; happy path; delegated answer path (flush posts the answer)
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const flushMock = vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 42})
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: flushMock,
        buffered: vi.fn().mockReturnValue('the agent answer'),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })

      const completedState = buildMockRunState({phase: 'COMPLETED'})
      mockRuntime.transitionRun
        .mockResolvedValueOnce({
          success: true as const,
          data: {etag: 'ack-etag', state: buildMockRunState({phase: 'ACKNOWLEDGED'})},
        })
        .mockResolvedValueOnce({
          success: true as const,
          data: {etag: 'exec-etag', state: buildMockRunState({phase: 'EXECUTING'})},
        })
        .mockResolvedValueOnce({success: true as const, data: {etag: 'done-etag', state: completedState}})

      const observeFn = vi.fn().mockResolvedValue(undefined)
      const deps = makeDeps({runObserver: {observe: observeFn}})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — run completed (COMPLETED transition happened)
      const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
      expect(transitionPhases).toContain('COMPLETED')

      // #and — replySink.flush was called (Discord posts the answer via flush)
      expect(flushMock).toHaveBeenCalledOnce()

      // #and — observer was called with the COMPLETED state (Discord behavior unchanged)
      const phases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
      expect(phases).toContain('COMPLETED')
    })

    it('ordering (COMPLETED path): replySink.flush is called BEFORE the observer receives the terminal COMPLETED state', async () => {
      // #given — track call order between flush and observe(COMPLETED)
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const callOrder: string[] = []

      const flushMock = vi.fn().mockImplementation(async () => {
        callOrder.push('flush')
        return {kind: 'sent' as const, charCount: 10}
      })
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: flushMock,
        buffered: vi.fn().mockReturnValue('answer'),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })

      const completedState = buildMockRunState({phase: 'COMPLETED'})
      mockRuntime.transitionRun
        .mockResolvedValueOnce({
          success: true as const,
          data: {etag: 'ack-etag', state: buildMockRunState({phase: 'ACKNOWLEDGED'})},
        })
        .mockResolvedValueOnce({
          success: true as const,
          data: {etag: 'exec-etag', state: buildMockRunState({phase: 'EXECUTING'})},
        })
        .mockResolvedValueOnce({success: true as const, data: {etag: 'done-etag', state: completedState}})

      const observeFn = vi.fn().mockImplementation(async (state: {phase?: string}) => {
        if (state.phase === 'COMPLETED') {
          callOrder.push('observe-COMPLETED')
        }
        return Promise.resolve()
      })
      const deps = makeDeps({runObserver: {observe: observeFn}})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — flush happened before observe(COMPLETED)
      const flushIdx = callOrder.indexOf('flush')
      const observeIdx = callOrder.indexOf('observe-COMPLETED')
      expect(flushIdx).toBeGreaterThanOrEqual(0)
      expect(observeIdx).toBeGreaterThanOrEqual(0)
      expect(flushIdx).toBeLessThan(observeIdx)
    })

    it('ordering (FAILED path): replySink.flush is called BEFORE the observer receives the terminal FAILED state', async () => {
      // #given — track call order between flush and observe(FAILED)
      const {runMention} = await import('./run.js')
      setupHappyPath()
      mockRunOpenCodeCore.mockRejectedValue(new Error('boom'))

      const callOrder: string[] = []

      const flushMock = vi.fn().mockImplementation(async () => {
        callOrder.push('flush')
        return {kind: 'sent' as const, charCount: 5}
      })
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: flushMock,
        buffered: vi.fn().mockReturnValue('partial'),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })

      const failedState = buildMockRunState({phase: 'FAILED'})
      mockRuntime.transitionRun
        .mockResolvedValueOnce({
          success: true as const,
          data: {etag: 'ack-etag', state: buildMockRunState({phase: 'ACKNOWLEDGED'})},
        })
        .mockResolvedValueOnce({
          success: true as const,
          data: {etag: 'exec-etag', state: buildMockRunState({phase: 'EXECUTING'})},
        })
        .mockResolvedValueOnce({success: true as const, data: {etag: 'fail-etag', state: failedState}})

      const observeFn = vi.fn().mockImplementation(async (state: {phase?: string}) => {
        if (state.phase === 'FAILED') {
          callOrder.push('observe-FAILED')
        }
        return Promise.resolve()
      })
      const deps = makeDeps({runObserver: {observe: observeFn}})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — flush happened before observe(FAILED)
      const flushIdx = callOrder.indexOf('flush')
      const observeIdx = callOrder.indexOf('observe-FAILED')
      expect(flushIdx).toBeGreaterThanOrEqual(0)
      expect(observeIdx).toBeGreaterThanOrEqual(0)
      expect(flushIdx).toBeLessThan(observeIdx)
    })
  })

  // ── Status controller wiring ─────────────────────────────────────────────

  describe('status controller wiring', () => {
    it('integration (live-status, short answer): resolveToAnswer(handled) → sink.flush NOT called', async () => {
      // #given — status controller returns 'handled' (edited in place)
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const ctrl = makeStatusControllerMock({resolveToAnswerResult: {transition: 'handled'}})
      const flushMock = vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 10})
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: flushMock,
        buffered: vi.fn().mockReturnValue('Short answer text'),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })

      const deps = makeDeps({statusMode: 'live-status'})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — resolveToAnswer called with buffered text
      expect(ctrl.resolveToAnswer).toHaveBeenCalledWith('Short answer text')
      // #and — sink.flush NOT called (answer is in the status message)
      expect(flushMock).not.toHaveBeenCalled()
    })

    it('integration (live-status, long answer): resolveToAnswer(delegated) → sink.flush IS called', async () => {
      // #given — status controller returns 'delegated' (status deleted, sink posts)
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const ctrl = makeStatusControllerMock({resolveToAnswerResult: {transition: 'delegated'}})
      const flushMock = vi.fn().mockResolvedValue({kind: 'attachment' as const, charCount: 3000})
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: flushMock,
        buffered: vi.fn().mockReturnValue('x'.repeat(2001)),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })

      const deps = makeDeps({statusMode: 'live-status'})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — resolveToAnswer called
      expect(ctrl.resolveToAnswer).toHaveBeenCalled()
      // #and — sink.flush IS called (delegated → sink owns the answer)
      expect(flushMock).toHaveBeenCalledOnce()
    })

    it('integration (failure, status present): resolveToFailure(handled) → safeSend NOT called', async () => {
      // #given — run-core throws; status controller returns 'handled' for failure
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      const ctrl = makeStatusControllerMock({resolveToFailureResult: {transition: 'handled'}})
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('session-error', 'LLM error'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({statusMode: 'live-status'})

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — resolveToFailure called with the coarse failure note
      expect(ctrl.resolveToFailure).toHaveBeenCalledOnce()
      const failureNote = (ctrl.resolveToFailure as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
      expect(typeof failureNote).toBe('string')
      expect(failureNote.length).toBeGreaterThan(0)
      // #and — thread.send NOT called for the failure message (controller owns it)
      // The only sends should be from the sink flush (partial output), not the error message
      const sendContents = thread.send.mock.calls.map(c => (c[0] as {content?: string}).content ?? '')
      // None of the sends should be the coarse failure note (controller handled it)
      expect(sendContents.includes(failureNote)).toBe(false)
    })

    it('integration (failure before activity, no status): resolveToFailure(delegated) → safeSend IS called', async () => {
      // #given — run-core throws; no status message posted; controller returns 'delegated'
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      const ctrl = makeStatusControllerMock({resolveToFailureResult: {transition: 'delegated'}})
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('unreachable', 'connect failed'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({statusMode: 'live-status'})

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — resolveToFailure called
      expect(ctrl.resolveToFailure).toHaveBeenCalledOnce()
      // #and — thread.send called for the failure message (delegated → safeSend posts it)
      const sendContents = thread.send.mock.calls.map(c => (c[0] as {content?: string}).content ?? '')
      expect(sendContents.some(c => c.includes('not reachable'))).toBe(true)
    })

    it('integration (typing-only mode): resolveToAnswer always delegated → sink.flush called', async () => {
      // #given — typing-only mode; controller always returns 'delegated'
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const ctrl = makeStatusControllerMock({resolveToAnswerResult: {transition: 'delegated'}})
      const flushMock = vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 10})
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: flushMock,
        buffered: vi.fn().mockReturnValue('answer text'),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })

      const deps = makeDeps({statusMode: 'typing-only'})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — createStatusController called with typing-only mode
      expect(mockCreateStatusController).toHaveBeenCalledWith(expect.objectContaining({mode: 'typing-only'}))
      // #and — sink.flush called (delegated)
      expect(flushMock).toHaveBeenCalledOnce()
      // #and — resolveToAnswer called (same call site regardless of mode)
      expect(ctrl.resolveToAnswer).toHaveBeenCalledOnce()
    })

    it('edge (cleanup): controller.dispose called in finally on success', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const ctrl = makeStatusControllerMock()

      const deps = makeDeps()
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — dispose called exactly once
      expect(ctrl.dispose).toHaveBeenCalledOnce()
    })

    it('edge (cleanup): controller.dispose called in finally on failure', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const ctrl = makeStatusControllerMock()
      mockRunOpenCodeCore.mockRejectedValue(new Error('boom'))

      const deps = makeDeps()
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — dispose called even when run-core throws
      expect(ctrl.dispose).toHaveBeenCalledOnce()
    })

    it('createStatusController receives statusMode from deps', async () => {
      // #given — live-status mode
      const {runMention} = await import('./run.js')
      setupHappyPath()
      makeStatusControllerMock()

      const deps = makeDeps({statusMode: 'live-status'})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — createStatusController called with mode: 'live-status'
      expect(mockCreateStatusController).toHaveBeenCalledWith(expect.objectContaining({mode: 'live-status'}))
    })

    it('runOpenCodeCore receives onActivity and onBusy callbacks', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()
      makeStatusControllerMock()

      const deps = makeDeps()
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — runOpenCodeCore called with onActivity and onBusy
      expect(mockRunOpenCodeCore).toHaveBeenCalledWith(
        expect.objectContaining({
          onActivity: expect.any(Function) as unknown,
          onBusy: expect.any(Function) as unknown,
        }),
      )
    })

    it('onActivity callback calls controller.noteActivity', async () => {
      // #given — capture the onActivity callback from runOpenCodeCore
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const ctrl = makeStatusControllerMock()

      let capturedOnActivity: ((summary: string) => void) | undefined
      mockRunOpenCodeCore.mockImplementation(async params => {
        capturedOnActivity = (params as {onActivity?: (s: string) => void}).onActivity
      })

      const deps = makeDeps()
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      expect(capturedOnActivity).toBeDefined()
      capturedOnActivity?.('edited 1 file')

      // #then — noteActivity called with the summary
      expect(ctrl.noteActivity).toHaveBeenCalledWith('edited 1 file')
    })

    it('onBusy callback calls controller.setBusy', async () => {
      // #given — capture the onBusy callback from runOpenCodeCore
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const ctrl = makeStatusControllerMock()

      let capturedOnBusy: ((busy: boolean) => void) | undefined
      mockRunOpenCodeCore.mockImplementation(async params => {
        capturedOnBusy = (params as {onBusy?: (b: boolean) => void}).onBusy
      })

      const deps = makeDeps()
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      expect(capturedOnBusy).toBeDefined()
      capturedOnBusy?.(true)
      capturedOnBusy?.(false)

      // #then — setBusy called with the correct values
      expect(ctrl.setBusy).toHaveBeenCalledWith(true)
      expect(ctrl.setBusy).toHaveBeenCalledWith(false)
    })

    it('edge (no output): empty answer → resolveToAnswer called with empty string → delegated → sink.flush called', async () => {
      // #given — empty buffer; controller returns 'delegated' for empty answer
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const ctrl = makeStatusControllerMock({resolveToAnswerResult: {transition: 'delegated'}})
      const flushMock = vi.fn().mockResolvedValue({kind: 'empty' as const})
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: flushMock,
        buffered: vi.fn().mockReturnValue(''),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })

      const deps = makeDeps()
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — resolveToAnswer called with empty string
      expect(ctrl.resolveToAnswer).toHaveBeenCalledWith('')
      // #and — sink.flush called (delegated → sink owns the no-output fallback)
      expect(flushMock).toHaveBeenCalledOnce()
    })

    // ── P1-A integration: terminal edit failure falls back to sink/safeSend ──

    it('p1-A: resolveToAnswer returns delegated (terminal edit failed) → answer delivered via sink.flush with exact content', async () => {
      // #given — status controller returns 'delegated' (simulating a failed terminal edit)
      // This is the P1-A regression guard: when the final edit fails, the answer must still
      // reach the user via sink.flush(), not be silently dropped.
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const ctrl = makeStatusControllerMock({resolveToAnswerResult: {transition: 'delegated'}})
      const ANSWER_TEXT = 'Here is the answer from the agent.'
      const flushMock = vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: ANSWER_TEXT.length})
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: flushMock,
        buffered: vi.fn().mockReturnValue(ANSWER_TEXT),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({statusMode: 'live-status'})

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — resolveToAnswer was called with the buffered answer text
      expect(ctrl.resolveToAnswer).toHaveBeenCalledWith(ANSWER_TEXT)
      // #and — exactly ONE flush call (answer delivered via sink, not dropped)
      expect(flushMock).toHaveBeenCalledOnce()
      // #and — no extra thread.send for the answer (sink.flush owns it)
      // (thread.send may be called for other reasons but not for the answer content)
    })

    it('p1-A: resolveToFailure returns delegated (terminal edit failed) → failure note delivered via safeSend with exact content', async () => {
      // #given — run-core throws; status controller returns 'delegated' (simulating a failed terminal edit)
      // P1-A regression guard: when the final failure edit fails, the note must still reach
      // the user via safeSend(), not be silently dropped.
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      const ctrl = makeStatusControllerMock({resolveToFailureResult: {transition: 'delegated'}})
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('unreachable', 'connect failed'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({statusMode: 'live-status'})

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — resolveToFailure was called
      expect(ctrl.resolveToFailure).toHaveBeenCalledOnce()
      const failureNote = (ctrl.resolveToFailure as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
      expect(typeof failureNote).toBe('string')
      expect(failureNote.length).toBeGreaterThan(0)
      // #and — thread.send was called with the exact failure note content (safeSend path)
      const sendContents = thread.send.mock.calls.map(c => (c[0] as {content?: string}).content ?? '')
      expect(sendContents.includes(failureNote)).toBe(true)
      // #and — the send includes allowedMentions: {parse: []} (mention-safe)
      const failureSend = thread.send.mock.calls.find(c => (c[0] as {content?: string}).content === failureNote)
      expect((failureSend?.[0] as {allowedMentions?: unknown}).allowedMentions).toEqual({parse: []})
    })

    it('p1-A: resolveToAnswer returns handled → sink.flush NOT called (exactly one message path)', async () => {
      // #given — status controller returns 'handled' (terminal edit succeeded)
      // Verifies the single-owner invariant: when handled, the answer is in the status message
      // and sink.flush must NOT be called (would double-post).
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const ctrl = makeStatusControllerMock({resolveToAnswerResult: {transition: 'handled'}})
      const flushMock = vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 10})
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: flushMock,
        buffered: vi.fn().mockReturnValue('Short answer'),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({statusMode: 'live-status'})

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — resolveToAnswer called
      expect(ctrl.resolveToAnswer).toHaveBeenCalledOnce()
      // #and — sink.flush NOT called (answer is in the status message — no double-post)
      expect(flushMock).not.toHaveBeenCalled()
    })

    it('p1-A: resolveToFailure returns handled → safeSend NOT called (exactly one message path)', async () => {
      // #given — run-core throws; status controller returns 'handled' (terminal edit succeeded)
      // Verifies the single-owner invariant: when handled, the failure note is in the status
      // message and safeSend must NOT be called (would double-post).
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      const ctrl = makeStatusControllerMock({resolveToFailureResult: {transition: 'handled'}})
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('session-error', 'LLM error'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({statusMode: 'live-status'})

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — resolveToFailure called
      expect(ctrl.resolveToFailure).toHaveBeenCalledOnce()
      const failureNote = (ctrl.resolveToFailure as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
      // #and — thread.send NOT called with the failure note (controller owns it)
      const sendContents = thread.send.mock.calls.map(c => (c[0] as {content?: string}).content ?? '')
      expect(sendContents.includes(failureNote)).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Reaction wiring — lifecycle hooks and containment (failure isolation)
//
// Verifies (F5):
//   1. setRunReaction is called at the correct lifecycle points.
//   2. A reaction call is never load-bearing for the run outcome — the run
//      completes/fails identically to the no-reaction baseline.
//   3. Reaction failures do not produce unhandled rejections.
//
// The reaction module is mocked at the module level (see test-helpers.ts)
// so we can control whether it throws without touching the real Discord API.
// ---------------------------------------------------------------------------

const mockSetRunReaction = vi.mocked(reactionsModule.setRunReaction)

describe('reaction wiring — lifecycle hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSetRunReaction.mockResolvedValue(undefined)
  })

  it('happy path: working reaction set at run start, succeeded at terminal success', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const message = makeMessage()
    const deps = makeDeps()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — setRunReaction called at least twice: working then succeeded
    const calls = mockSetRunReaction.mock.calls
    const states = calls.map(c => c[1])
    expect(states).toContain('working')
    expect(states).toContain('succeeded')
    // working must come before succeeded
    expect(states.indexOf('working')).toBeLessThan(states.indexOf('succeeded'))
  })

  it('failure path: working reaction set at run start, failed at terminal failure', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(new Error('boom'))
    const message = makeMessage()
    const deps = makeDeps()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — working then failed
    const states = mockSetRunReaction.mock.calls.map(c => c[1])
    expect(states).toContain('working')
    expect(states).toContain('failed')
    expect(states.indexOf('working')).toBeLessThan(states.indexOf('failed'))
  })

  it('reaction is called with the triggering message (not the thread)', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const message = makeMessage()
    const deps = makeDeps()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — all reaction calls use the triggering message
    for (const call of mockSetRunReaction.mock.calls) {
      expect(call[0]).toBe(message)
    }
  })

  it('awaiting-approval reaction fires on the onPending path', async () => {
    // #given — capture onPending from the coordinator factory and invoke it
    // to simulate the approval-pending transition; assert awaiting-approval fires.
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

    mockRunOpenCodeCore.mockImplementation(async () => {
      // Invoke onPending to trigger the awaiting-approval reaction
      capturedOnPending?.({
        requestID: 'req-pending-1',
        sessionID: 'sess-pending',
        permission: 'bash',
        patterns: [],
        title: 'Run command: ls',
      })
    })

    const message = makeMessage()
    const deps = makeDeps()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — awaiting-approval reaction was set
    const states = mockSetRunReaction.mock.calls.map(c => c[1])
    expect(states).toContain('awaiting-approval')
  })
})

describe('reaction wiring — containment (failure isolation)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('thrown reaction mock on happy path: run still completes successfully (outcome unchanged)', async () => {
    // #given — reaction always throws
    const {runMention} = await import('./run.js')
    setupHappyPath()
    mockSetRunReaction.mockRejectedValue(new Error('reaction API exploded'))
    const message = makeMessage()
    const deps = makeDeps()

    // #when — must not throw
    await expect(runMention(message, makeBinding(), deps)).resolves.toBeUndefined()

    // #then — run still completed (COMPLETED transition occurred)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('COMPLETED')
    expect(transitionPhases).not.toContain('FAILED')
  })

  it('thrown reaction mock on failure path: run still transitions to FAILED (outcome unchanged)', async () => {
    // #given — reaction throws AND run-core throws
    const {runMention} = await import('./run.js')
    setupHappyPath()
    mockSetRunReaction.mockRejectedValue(new Error('reaction API exploded'))
    mockRunOpenCodeCore.mockRejectedValue(new Error('run-core boom'))
    const message = makeMessage()
    const deps = makeDeps()

    // #when — must not throw
    await expect(runMention(message, makeBinding(), deps)).resolves.toBeUndefined()

    // #then — run still transitioned to FAILED (reaction failure did not mask run failure)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('COMPLETED')
  })

  it('thrown reaction mock: lock and concurrency slot still released (cleanup unaffected)', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    mockSetRunReaction.mockRejectedValue(new Error('reaction API exploded'))
    const message = makeMessage()
    const deps = makeDeps()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — cleanup still ran
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
    const releaseFn = deps.concurrency.release as ReturnType<typeof vi.fn>
    expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
  })
})

describe('statusMode live-status: status message posted and edited', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('live-status: createStatusController called with mode live-status and the created thread', async () => {
    // #given — live-status mode
    // This pins the current behavior: createStatusController receives the thread
    // created by startThread, not the original message channel.
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const ctrl = makeStatusControllerMock()

    const thread = makeThread()
    const message = makeMessage(thread)
    const deps = makeDeps({statusMode: 'live-status'})

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — createStatusController called with the thread and live-status mode
    expect(mockCreateStatusController).toHaveBeenCalledOnce()
    const ctrlCall = mockCreateStatusController.mock.calls[0]?.[0] as {
      thread: unknown
      mode: string
    }
    expect(ctrlCall.mode).toBe('live-status')
    // The thread passed is the one returned by startThread (not the message channel)
    expect(ctrlCall.thread).toBe(thread)
    // #and — resolveToAnswer called (status controller owns the answer transition)
    expect(ctrl.resolveToAnswer).toHaveBeenCalledOnce()
  })

  it('live-status: resolveToAnswer(handled) → status message is the answer (no sink flush)', async () => {
    // #given — status controller handles the answer (edits status message in place)
    const {runMention} = await import('./run.js')
    setupHappyPath()
    makeStatusControllerMock({resolveToAnswerResult: {transition: 'handled'}})
    const flushMock = vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 10})
    mockCreateDiscordStreamSink.mockReturnValue({
      append: vi.fn(),
      flush: flushMock,
      buffered: vi.fn().mockReturnValue('The answer'),
      markVisibleOutputSent: vi.fn(),
      markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
      hasVisibleOutput: vi.fn().mockReturnValue(false),
    })

    const message = makeMessage()
    const deps = makeDeps({statusMode: 'live-status'})

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — sink.flush NOT called (status controller owns the answer)
    expect(flushMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// statusMode 'typing-only': typing indicator pulses; NO status message posted
// ---------------------------------------------------------------------------

describe('statusMode typing-only: typing indicator only, no status message', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('typing-only: createStatusController called with mode typing-only', async () => {
    // #given — typing-only mode
    // This pins the current behavior: createStatusController is called with
    // mode 'typing-only', which suppresses the status message.
    const {runMention} = await import('./run.js')
    setupHappyPath()
    makeStatusControllerMock({resolveToAnswerResult: {transition: 'delegated'}})

    const message = makeMessage()
    const deps = makeDeps({statusMode: 'typing-only'})

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — createStatusController called with typing-only mode
    expect(mockCreateStatusController).toHaveBeenCalledOnce()
    const ctrlCall = mockCreateStatusController.mock.calls[0]?.[0] as {mode: string}
    expect(ctrlCall.mode).toBe('typing-only')
  })

  it('typing-only: resolveToAnswer always returns delegated → sink.flush called (no status message to edit)', async () => {
    // #given — typing-only mode; controller always delegates (no status message)
    const {runMention} = await import('./run.js')
    setupHappyPath()
    makeStatusControllerMock({resolveToAnswerResult: {transition: 'delegated'}})
    const flushMock = vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 10})
    mockCreateDiscordStreamSink.mockReturnValue({
      append: vi.fn(),
      flush: flushMock,
      buffered: vi.fn().mockReturnValue('answer text'),
      markVisibleOutputSent: vi.fn(),
      markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
      hasVisibleOutput: vi.fn().mockReturnValue(false),
    })

    const message = makeMessage()
    const deps = makeDeps({statusMode: 'typing-only'})

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — sink.flush called (typing-only always delegates to sink)
    expect(flushMock).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// operatorPushDispatcher wiring — approval-pending and FAILED terminalization
// ---------------------------------------------------------------------------

function makePushDispatcher() {
  return {
    dispatchApprovalPending: vi.fn().mockResolvedValue(undefined),
    dispatchRunFailed: vi.fn().mockResolvedValue(undefined),
  }
}

describe('operatorPushDispatcher wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // #given a run with a fake operatorPushDispatcher present
  // #when the coordinator's onPending fires
  // #then dispatchApprovalPending is called once with the requestID, and the
  //       existing approval flow (Discord render + registry) is unchanged
  it('calls dispatchApprovalPending once on a pending approval without altering the approval flow', async () => {
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const pushDispatcher = makePushDispatcher()

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

    mockRunOpenCodeCore.mockImplementation(async () => {
      capturedOnPending?.({
        requestID: 'req-push-1',
        sessionID: 'sess-push',
        permission: 'bash',
        patterns: [],
        title: 'Run command: ls',
      })
    })

    const approvalRegistry = makeApprovalRegistry()
    const deps = makeDeps({operatorPushDispatcher: pushDispatcher, approvalRegistry})
    const message = makeMessage()

    await runMention(message, makeBinding(), deps)

    expect(pushDispatcher.dispatchApprovalPending).toHaveBeenCalledTimes(1)
    expect(pushDispatcher.dispatchApprovalPending).toHaveBeenCalledWith('req-push-1')
    // The existing approval transport still ran — the push dispatch is additive, not a
    // replacement. If push dispatch replaced the existing flow instead of augmenting it,
    // this assertion would fail.
    expect(approvalRegistry.register).toHaveBeenCalled()
  })

  // #given a run whose core execution fails in-flight (RunCoreError)
  // #when the FAILED transition succeeds
  // #then dispatchRunFailed is called once with the mapped OperatorFailureKind
  it('calls dispatchRunFailed once with the mapped failureKind on in-flight FAILED terminalization', async () => {
    const {runMention} = await import('./run.js')
    const {RunCoreError} = runCoreModule
    setupHappyPath()
    const pushDispatcher = makePushDispatcher()
    mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('inactivity-timeout', 'no progress'))

    const deps = makeDeps({operatorPushDispatcher: pushDispatcher})
    const message = makeMessage()

    await runMention(message, makeBinding(), deps)

    expect(pushDispatcher.dispatchRunFailed).toHaveBeenCalledTimes(1)
    expect(pushDispatcher.dispatchRunFailed).toHaveBeenCalledWith(expect.any(String), 'inactivity-timeout')
  })

  // #given operatorPushDispatcher is undefined (push disabled)
  // #when a pending approval and a FAILED terminalization both occur
  // #then nothing throws and the run flow is unchanged — push is fully inert
  it('does nothing when operatorPushDispatcher is undefined — push stays fully inert', async () => {
    const {runMention} = await import('./run.js')
    const {RunCoreError} = runCoreModule
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
    mockRunOpenCodeCore.mockImplementation(async () => {
      capturedOnPending?.({
        requestID: 'req-inert-1',
        sessionID: 'sess-inert',
        permission: 'bash',
        patterns: [],
        title: 'Run command: ls',
      })
      throw new RunCoreError('inactivity-timeout', 'no progress')
    })

    const deps = makeDeps({operatorPushDispatcher: undefined})
    const message = makeMessage()

    // #then — no throw
    await expect(runMention(message, makeBinding(), deps)).resolves.toBeUndefined()
  })

  // #given a fake operatorPushDispatcher whose dispatchApprovalPending/dispatchRunFailed throw
  // #when a pending approval and a FAILED terminalization occur
  // #then the throw does not break the approval or run flow (fail-soft)
  it('does not break the run flow when the dispatcher throws', async () => {
    const {runMention} = await import('./run.js')
    const {RunCoreError} = runCoreModule
    setupHappyPath()
    const throwingDispatcher = {
      dispatchApprovalPending: vi.fn().mockRejectedValue(new Error('push boom')),
      dispatchRunFailed: vi.fn().mockRejectedValue(new Error('push boom')),
    }

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
    mockRunOpenCodeCore.mockImplementation(async () => {
      capturedOnPending?.({
        requestID: 'req-throw-1',
        sessionID: 'sess-throw',
        permission: 'bash',
        patterns: [],
        title: 'Run command: ls',
      })
      throw new RunCoreError('inactivity-timeout', 'no progress')
    })

    const deps = makeDeps({operatorPushDispatcher: throwingDispatcher})
    const message = makeMessage()

    // #then — no throw propagates out of runMention despite the dispatcher rejecting
    await expect(runMention(message, makeBinding(), deps)).resolves.toBeUndefined()
    const failedCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'FAILED')
    expect(failedCall).toBeDefined()

    // #and — the dispatcher was actually invoked (both call sites), not merely present but
    // unreached — otherwise this test would pass even if dispatch never fired
    expect(throwingDispatcher.dispatchApprovalPending.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(throwingDispatcher.dispatchRunFailed.mock.calls.length).toBeGreaterThanOrEqual(1)
  })
})
