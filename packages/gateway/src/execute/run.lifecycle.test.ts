import type * as streamingModule from '../discord/streaming.js'
import type {LaunchWorkRequest} from './launch-types.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module
   it mocks, to register vi.mock() side effects before those modules are evaluated */
import {
  awaitLaunchWorkRun,
  buildMockRunState,
  CHANNEL_ID,
  makeApprovalRegistry,
  makeBinding,
  makeDefaultQueue,
  makeDeps,
  makeInMemoryRequest,
  makeMessage,
  makeMinimalRequest,
  makeReadyzFn,
  makeStatefulSinkMock,
  makeStreamSinkMock,
  makeThread,
  mockCreateDiscordStreamSink,
  mockCreatePermissionCoordinator,
  mockRunOpenCodeCore,
  mockRuntime,
  REPO,
  setupHappyPath,
} from './test-helpers.js'
import * as reactionsModule from '../discord/reactions.js'
import * as runCoreModule from './run-core.js'
import {formatTimeoutDuration} from './run.js'
/* eslint-enable perfectionist/sort-imports */

// ---------------------------------------------------------------------------
// The mention lifecycle — happy path, run-core error handling, heartbeat stop
// failure, deadline-settled path, security invariants, thread creation,
// timeout-duration formatting, the runId seam, empty-prompt fail-fast, the
// launchWork in-memory sink tests, and the threadFactory failure/timeout paths.
// ---------------------------------------------------------------------------

describe('runMention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Run-state lifecycle ─────────────────────────────────────────────────

  describe('authorized happy path — lifecycle', () => {
    it('transitions PENDING → ACKNOWLEDGED → EXECUTING → COMPLETED and flushes sink', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const flushMock = vi.fn().mockResolvedValue(undefined)
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

      // #then — run-state transitions in order
      expect(mockRuntime.createRun).toHaveBeenCalledOnce()
      const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
      expect(transitionPhases).toContain('ACKNOWLEDGED')
      expect(transitionPhases).toContain('EXECUTING')
      expect(transitionPhases).toContain('COMPLETED')

      // #and — execution happened
      expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()

      // #and — sink flushed
      expect(flushMock).toHaveBeenCalledOnce()

      // #and — lock released
      expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()

      // #and — concurrency slot released
      const releaseFn = deps.concurrency.release as ReturnType<typeof vi.fn>
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
    })

    it('starts and stops heartbeat around execution', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const startMock = vi.fn()
      const stopMock = vi.fn().mockResolvedValue({
        success: true as const,
        data: {runEtag: 'r-etag', lockEtag: 'l-etag', runState: {}},
      })
      setupHappyPath({start: startMock, stop: stopMock})

      const deps = makeDeps()
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then
      expect(startMock).toHaveBeenCalledOnce()
      expect(stopMock).toHaveBeenCalledOnce()
    })
  })

  // ── Error paths ─────────────────────────────────────────────────────────

  describe('run-core error handling', () => {
    it('maps RunCoreError(unreachable) to "workspace not reachable" and transitions to FAILED', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('unreachable', 'connect ECONNREFUSED'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — coarse "workspace not reachable" message, no internal detail
      expect(thread.send).toHaveBeenCalled()
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {
        content: string
        allowedMentions: unknown
      }
      expect(lastCall.allowedMentions).toEqual({parse: []})
      expect(lastCall.content).toContain('not reachable')
      expect(lastCall.content).not.toContain('ECONNREFUSED')

      // #and — FAILED transition
      const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
      expect(transitionPhases).toContain('FAILED')

      // #and — lock and concurrency released
      expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
      const releaseFn = deps.concurrency.release as ReturnType<typeof vi.fn>
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
    })

    it('maps RunCoreError(auth) to "workspace not reachable" — not to generic task failed', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('auth', '401 Unauthorized'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — "not reachable" (same message as unreachable), no "401" leaked
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {
        content: string
        allowedMentions: unknown
      }
      expect(lastCall.content).toContain('not reachable')
      expect(lastCall.content).not.toContain('401')
      expect(lastCall.content).not.toContain('Unauthorized')

      // #and — FAILED transition
      const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
      expect(transitionPhases).toContain('FAILED')
    })

    it('maps generic Error to "task failed" (not "not reachable")', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()
      mockRunOpenCodeCore.mockRejectedValue(new Error('something unknown happened'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — generic error message, no internal detail
      const calls = thread.send.mock.calls
      const lastCallArg = calls.at(-1)?.[0] as {content?: string; allowedMentions?: unknown} | undefined
      expect(lastCallArg?.content).toContain('failed')
      expect(lastCallArg?.content).not.toContain('unknown happened')
      // NOT "not reachable" — only for RunCoreError(unreachable|auth)
      expect(lastCallArg?.content).not.toContain('not reachable')
    })

    it('releases lock and concurrency slot in finally even when run-core throws', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()
      mockRunOpenCodeCore.mockRejectedValue(new Error('boom'))

      const deps = makeDeps()
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then
      expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
      const releaseFn = deps.concurrency.release as ReturnType<typeof vi.fn>
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
    })

    it('flushes partial sink output on timeout path before posting error', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      const flushMock = vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 5})
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: flushMock,
        buffered: vi.fn().mockReturnValue('partial output'),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — flush called on error path
      expect(flushMock).toHaveBeenCalledOnce()
      // #and — error message sent after flush (last send is the timeout message)
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toMatch(/time.?limit|timed? ?out/i)
    })

    // ── Timeout copy branching ───────────────────────────────────────────────

    it('timeout with no visible output: message includes configured duration and generic retry guidance', async () => {
      // #given — no visible output; runTimeoutMs = 600_000 (10 min)
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: vi.fn().mockResolvedValue({kind: 'empty' as const}),
        buffered: vi.fn().mockReturnValue(''),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({runTimeoutMs: 600_000})

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — message includes the configured timeout duration
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toMatch(/10.?min/i)
      // #and — does NOT use partial-output continuation wording
      expect(lastCall.content).not.toMatch(/partial|continue|follow.?up/i)
    })

    it('timeout with no visible output: message does not leak internal error detail', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: vi.fn().mockResolvedValue({kind: 'empty' as const}),
        buffered: vi.fn().mockReturnValue(''),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'AbortError: signal timed out'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — no internal error detail in message
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).not.toContain('AbortError')
      expect(lastCall.content).not.toContain('signal timed out')
    })

    it('timeout with visible text output: message acknowledges visible updates and gives new-request guidance', async () => {
      // #given — visible output was flushed (text sent to thread)
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 42}),
        buffered: vi.fn().mockReturnValue('some partial output'),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(true),
      })
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({runTimeoutMs: 600_000})

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — message acknowledges visible updates
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toMatch(/updates above/i)
      // #and — gives explicit new-request guidance
      expect(lastCall.content).toMatch(/new.*@fro-bot request|what to do next/i)
      // #and — includes configured timeout duration
      expect(lastCall.content).toMatch(/10.?min/i)
    })

    it('timeout with visible attachment output: message follows the visible-output branch', async () => {
      // #given — visible output was flushed as an attachment
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: vi.fn().mockResolvedValue({kind: 'attachment' as const, charCount: 3000}),
        buffered: vi.fn().mockReturnValue('x'.repeat(3000)),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(true),
      })
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({runTimeoutMs: 600_000})

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — visible-output branch: new-request guidance present
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toMatch(/new.*@fro-bot request|what to do next/i)
      // #and — does NOT use no-output wording
      expect(lastCall.content).not.toMatch(/try again/i)
    })

    it('timeout with approval-status visible output: message follows the visible-output branch', async () => {
      // #given — approval waiting status was sent (markVisibleOutputSent called), no buffered text
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: vi.fn().mockResolvedValue({kind: 'skipped-visible' as const}),
        buffered: vi.fn().mockReturnValue(''),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(true),
      })
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({runTimeoutMs: 600_000})

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — visible-output branch: new-request guidance present
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toMatch(/new.*@fro-bot request|what to do next/i)
    })

    it('timeout: flush completes before the timeout message is sent (ordering invariant)', async () => {
      // #given — track call order
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      const callOrder: string[] = []
      const flushMock = vi.fn().mockImplementation(async () => {
        callOrder.push('flush')
        return {kind: 'sent' as const, charCount: 5}
      })
      const thread = makeThread()
      thread.send.mockImplementation((opts: unknown) => {
        callOrder.push('send')
        return opts
      })
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: flushMock,
        buffered: vi.fn().mockReturnValue('partial'),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(true),
      })
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

      const message = makeMessage(thread)
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — flush happened before the final send
      const flushIdx = callOrder.indexOf('flush')
      const lastSendIdx = callOrder.lastIndexOf('send')
      expect(flushIdx).toBeGreaterThanOrEqual(0)
      expect(lastSendIdx).toBeGreaterThan(flushIdx)
    })

    it('regression: stream-ended message is unchanged by timeout branching', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 5}),
        buffered: vi.fn().mockReturnValue('partial'),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(true), // visible output present — but stream-ended, not timeout
      })
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('stream-ended', 'stream closed'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — stream-ended message is unchanged
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toContain('stream closed unexpectedly')
      // #and — does NOT use timeout-specific wording
      expect(lastCall.content).not.toMatch(/timed? ?out/i)
    })

    it('regression: generic failure message is unchanged by timeout branching', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 5}),
        buffered: vi.fn().mockReturnValue('partial'),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(true),
      })
      mockRunOpenCodeCore.mockRejectedValue(new Error('some unknown error'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — generic failure message unchanged
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toContain('failed')
      expect(lastCall.content).not.toMatch(/timed? ?out/i)
    })

    it('timeout: FAILED run-state transition still occurs regardless of visible-output branch', async () => {
      // #given — visible output present
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 10}),
        buffered: vi.fn().mockReturnValue('output'),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(true),
      })
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — run still transitions to FAILED (timeout is always a failure)
      const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
      expect(transitionPhases).toContain('FAILED')
      expect(transitionPhases).not.toContain('COMPLETED')
    })

    it('flushes partial sink output on stream-ended path before posting error', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      const flushMock = vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 5})
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: flushMock,
        buffered: vi.fn().mockReturnValue('partial'),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('stream-ended', 'stream closed'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then
      expect(flushMock).toHaveBeenCalledOnce()
    })

    it('flushes partial sink output on session-error path before posting error', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      const flushMock = vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 5})
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: flushMock,
        buffered: vi.fn().mockReturnValue('partial'),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('session-error', 'LLM quota exceeded'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then
      expect(flushMock).toHaveBeenCalledOnce()
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toContain('failed')
    })

    it('does not flush when sink was never created (pre-EXECUTING error)', async () => {
      // #given — transitionRun(EXECUTING) throws before sink is created
      const {runMention} = await import('./run.js')
      const flushMock = vi.fn()
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: flushMock,
        buffered: vi.fn().mockReturnValue(''),
        markVisibleOutputSent: vi.fn(),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: vi.fn().mockReturnValue(false),
      })
      setupHappyPath()
      // Make EXECUTING transition fail — error caught before sink is created
      mockRuntime.transitionRun
        .mockResolvedValueOnce({
          success: true as const,
          data: {etag: 'ack-etag', state: buildMockRunState({phase: 'ACKNOWLEDGED'})},
        }) // ACKNOWLEDGED
        .mockRejectedValueOnce(new Error('EXECUTING transition threw')) // EXECUTING

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — flush NOT called because sink was never initialized
      expect(flushMock).not.toHaveBeenCalled()
    })

    // ── Stateful sink: timeout copy reads visibility AFTER flush ────────────

    it('timeout: visible-output branch fires when flush() sets visible=true (stateful sink — sent)', async () => {
      // #given — sink starts with visible=false; flush() sets visible=true (simulates sent output)
      // This proves the classifier reads hasVisibleOutput() AFTER the error-path flush completes.
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      const statefulSink = makeStatefulSinkMock('sent', /* flushShouldSetVisible */ true)
      mockCreateDiscordStreamSink.mockReturnValue(statefulSink)
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({runTimeoutMs: 600_000})

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — flush was called and set visible=true
      expect(statefulSink.flush).toHaveBeenCalledOnce()
      // #and — visible-output branch used (new-request guidance present)
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toMatch(/what to do next|new.*@fro-bot/i)
      // #and — does NOT use no-output retry wording
      expect(lastCall.content).not.toMatch(/please try again/i)
    })

    it('timeout: visible-output branch fires when flush() sets visible=true (stateful sink — attachment)', async () => {
      // #given — sink starts with visible=false; flush() sets visible=true (simulates attachment output)
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      const statefulSink = makeStatefulSinkMock('attachment', /* flushShouldSetVisible */ true)
      mockCreateDiscordStreamSink.mockReturnValue(statefulSink)
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({runTimeoutMs: 600_000})

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — visible-output branch used
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toMatch(/what to do next|new.*@fro-bot/i)
    })

    it('timeout: generic branch fires when flush() leaves visible=false (stateful sink — empty)', async () => {
      // #given — sink starts with visible=false; flush() does NOT set visible (empty flush)
      // This is the inverse case: flush errors or produces no visible output → generic timeout.
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      const statefulSink = makeStatefulSinkMock('empty', /* flushShouldSetVisible */ false)
      mockCreateDiscordStreamSink.mockReturnValue(statefulSink)
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({runTimeoutMs: 600_000})

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — generic branch used (no new-request guidance)
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).not.toMatch(/what to do next|new.*@fro-bot/i)
      // #and — includes configured duration
      expect(lastCall.content).toMatch(/10.?min/i)
    })

    it('timeout: generic branch fires when flush() throws (stateful sink — flush error)', async () => {
      // #given — flush throws; visible stays false → generic timeout branch
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      let visible = false
      const flushFn = vi.fn().mockRejectedValue(new Error('flush network error'))
      const hasVisibleOutputFn = vi.fn().mockImplementation(() => visible)
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: flushFn,
        buffered: vi.fn().mockReturnValue(''),
        markVisibleOutputSent: vi.fn().mockImplementation(() => {
          visible = true
        }),
        markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
        hasVisibleOutput: hasVisibleOutputFn,
      })
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps({runTimeoutMs: 600_000})

      // #when — must not throw (flush failure is best-effort)
      await expect(runMention(message, makeBinding(), deps)).resolves.toBeUndefined()

      // #then — generic branch used (visible stayed false after flush threw)
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).not.toMatch(/what to do next|new.*@fro-bot/i)
      expect(lastCall.content).toMatch(/10.?min/i)
    })
  })

  // ── onDeadlineSettled path ───────────────────────────────────────────────

  describe('onDeadlineSettled path', () => {
    it('deadline-settled send marks visible output on the sink (markVisibleOutputSent called after send)', async () => {
      // Exercises the onDeadlineSettled path: when the deadline fires, run.ts calls
      // safeSend then sink.markVisibleOutputSent(). This test asserts that after
      // onDeadlineSettled completes, the sink reports visible output.
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const thread = makeThread()
      const fakeApprovalMessage = {id: 'msg-deadline-vis', edit: vi.fn()}
      thread.send.mockResolvedValue(fakeApprovalMessage)
      const message = makeMessage(thread)
      const approvalRegistry = makeApprovalRegistry()

      // Use a stateful sink so we can observe markVisibleOutputSent
      let visibleMarked = false
      const sinkMock = makeStreamSinkMock({
        markVisibleOutputSent: vi.fn().mockImplementation(() => {
          visibleMarked = true
        }),
        hasVisibleOutput: vi.fn().mockImplementation(() => visibleMarked),
      })
      mockCreateDiscordStreamSink.mockReturnValue(
        sinkMock as unknown as ReturnType<typeof streamingModule.createDiscordStreamSink>,
      )

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
        requestID: 'req-deadline-vis-1',
        sessionID: 'sess-deadline-vis',
        permission: 'bash',
        patterns: [],
        title: 'Run command',
      })
      await new Promise(resolve => setTimeout(resolve, 0))

      // Extract the onDeadlineSettled callback from the register call
      const registerCall = (approvalRegistry.register as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        {onDeadlineSettled?: () => void | Promise<void>} | undefined
      expect(registerCall?.onDeadlineSettled).toBeDefined()

      // #when — simulate deadline firing
      if (registerCall?.onDeadlineSettled !== undefined) {
        await registerCall.onDeadlineSettled()
      }

      // #then — after onDeadlineSettled completes, the sink reports visible output
      // (markVisibleOutputSent was called after the safeSend succeeded)
      expect(visibleMarked).toBe(true)
      // markVisibleOutputSent was called exactly once (by onDeadlineSettled)
      expect(sinkMock.markVisibleOutputSent).toHaveBeenCalledOnce()
    })
  })

  // ── Security invariants ──────────────────────────────────────────────────

  describe('security invariants', () => {
    it('does not post raw exception message to Discord on any error path', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const internalDetail = 'secret-internal-database-key-xyz'
      mockRunOpenCodeCore.mockRejectedValue(new Error(internalDetail))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — the internal detail is NOT in any Discord send
      for (const call of thread.send.mock.calls) {
        const arg = call[0] as {content?: string}
        expect(arg.content ?? '').not.toContain(internalDetail)
      }
      for (const call of (message.reply as ReturnType<typeof vi.fn>).mock.calls) {
        const arg = call[0] as {content?: string}
        expect(arg.content ?? '').not.toContain(internalDetail)
      }
    })

    it('uses allowedMentions: {parse: []} on all thread sends in error path', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()
      mockRunOpenCodeCore.mockRejectedValue(new Error('boom'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — every thread send has allowedMentions: {parse: []}
      for (const call of thread.send.mock.calls) {
        const arg = call[0] as {allowedMentions?: unknown}
        expect(arg.allowedMentions).toEqual({parse: []})
      }
    })
  })

  // ── Heartbeat stop failure ───────────────────────────────────────────────

  describe('heartbeat stop failure', () => {
    it('logs, proceeds with last-known etags, transitions to terminal state, releases lock — does not throw', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const stopError = new Error('heartbeat stop S3 error')
      const stopMock = vi.fn().mockResolvedValue({success: false, error: stopError})
      setupHappyPath({stop: stopMock})
      // run-core throws so we reach the error catch with a stopped heartbeat
      const {RunCoreError} = runCoreModule
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

      const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
      const deps = makeDeps({logger})
      const thread = makeThread()
      const message = makeMessage(thread)

      // #when — must not throw
      await expect(runMention(message, makeBinding(), deps)).resolves.toBeUndefined()

      // #then — warning logged for heartbeat stop failure
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({err: stopError.message}),
        expect.stringContaining('heartbeat stop failed'),
      )

      // #and — terminal FAILED transition still attempted
      const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
      expect(transitionPhases).toContain('FAILED')

      // #and — lock release still attempted in finally
      expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()

      // #and — concurrency slot released
      const releaseFn = deps.concurrency.release as ReturnType<typeof vi.fn>
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
    })

    it('on success path: heartbeat.stop() failure logs warning and continues to COMPLETED', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const stopError = new Error('stop S3 timeout')
      const stopMock = vi.fn().mockResolvedValue({success: false, error: stopError})
      setupHappyPath({stop: stopMock})

      const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
      const deps = makeDeps({logger})
      const message = makeMessage()

      // #when
      await expect(runMention(message, makeBinding(), deps)).resolves.toBeUndefined()

      // #then — warning logged
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({err: stopError.message}),
        expect.stringContaining('heartbeat stop failed'),
      )

      // #and — COMPLETED transition still attempted
      const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
      expect(transitionPhases).toContain('COMPLETED')

      // #and — lock released
      expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
    })
  })
})

describe('startThread throws — failure reply sent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('startThread rejection → safeReply sent to message, no thread-level send', async () => {
    // #given — startThread rejects (e.g. Discord API error)
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const message = makeMessage()
    ;(message.startThread as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Discord API error'))

    const deps = makeDeps()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — a failure reply was sent to the original message
    expect(message.reply).toHaveBeenCalledOnce()
    const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
    expect(call.content).toMatch(/could not start|please try again/i)

    // #and — no thread-level sends (thread was never created)
    expect(message._thread.send).not.toHaveBeenCalled()
  })

  it('startThread rejection → concurrency slot is released in outer finally', async () => {
    // #given — startThread rejects
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const releaseFn = vi.fn()
    const message = makeMessage()
    ;(message.startThread as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('thread creation failed'))

    const deps = makeDeps({
      concurrency: {
        tryAcquire: vi.fn().mockReturnValue('ok'),
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      },
    })

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — slot released (outer finally ran)
    expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
  })
})

describe('formatTimeoutDuration', () => {
  it('45_000 ms → "45 seconds"', () => {
    expect(formatTimeoutDuration(45_000)).toBe('45 seconds')
  })

  it('1_000 ms → "1 second"', () => {
    expect(formatTimeoutDuration(1_000)).toBe('1 second')
  })

  it('60_000 ms → "1 minute" (no trailing seconds)', () => {
    expect(formatTimeoutDuration(60_000)).toBe('1 minute')
  })

  it('90_000 ms → "1 minute 30 seconds" (non-integral minute)', () => {
    expect(formatTimeoutDuration(90_000)).toBe('1 minute 30 seconds')
  })

  it('120_000 ms → "2 minutes" (no trailing seconds)', () => {
    expect(formatTimeoutDuration(120_000)).toBe('2 minutes')
  })

  it('600_000 ms → "10 minutes"', () => {
    expect(formatTimeoutDuration(600_000)).toBe('10 minutes')
  })

  it('61_000 ms → "1 minute 1 second" (singular second)', () => {
    expect(formatTimeoutDuration(61_000)).toBe('1 minute 1 second')
  })

  it('125_000 ms → "2 minutes 5 seconds"', () => {
    expect(formatTimeoutDuration(125_000)).toBe('2 minutes 5 seconds')
  })
})

// ---------------------------------------------------------------------------
// FIX-5: empty-string runId seam — falls back to generated UUID
// ---------------------------------------------------------------------------

describe('runId seam — empty-string falls back to generated UUID', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('an empty-string request.runId falls back to a generated UUID (not empty string)', async () => {
    // #given — a request with an empty-string runId (not undefined, not null)
    // The seam in executeWorkOnHeldSlot must treat '' the same as absent.
    setupHappyPath()

    // Capture the runId passed to createRun so we can assert it is not empty
    let capturedRunId: string | undefined
    mockRuntime.createRun.mockImplementation(async (_cfg, _id, _repo, state) => {
      capturedRunId = (state as {run_id: string}).run_id
      return {success: true as const, data: {etag: 'etag-create'}}
    })

    const binding = makeBinding()
    const message = makeMessage()
    const deps = makeDeps()
    const request: LaunchWorkRequest = {
      ...makeMinimalRequest(message, binding),
      runId: '', // empty string — should fall back to generated UUID
    }

    // #when — launchWork with empty-string runId
    const {launchWork} = await import('./run.js')
    await launchWork(request, deps)

    // #then — capturedRunId is a non-empty UUID (not the empty string)
    expect(capturedRunId).toBeDefined()
    expect(capturedRunId).not.toBe('')
    expect(capturedRunId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

describe('thread creation: message.startThread called for a valid run', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('startThread is called with the repo name as the thread name', async () => {
    // #given — happy path run
    // This pins the current behavior: startThread is called with name `fro-bot: ${repo}`
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const message = makeMessage()
    const binding = makeBinding() // repo = 'widget'
    const deps = makeDeps()

    // #when
    await runMention(message, binding, deps)

    // #then — startThread called exactly once with the repo name
    expect(message.startThread).toHaveBeenCalledOnce()
    const call = (message.startThread as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {name: string}
    expect(call.name).toBe(`fro-bot: ${REPO}`)
  })

  it('startThread is NOT called when workspace is not ready (pre-thread gate)', async () => {
    // #given — workspace not ready
    const {runMention} = await import('./run.js')
    const readyz = makeReadyzFn('not-ready')
    const message = makeMessage()
    const deps = makeDeps({readyz})

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — startThread never called (gate fires before thread creation)
    expect(message.startThread).not.toHaveBeenCalled()
  })
})

describe('empty-prompt fail-fast: bare mention → immediate reply on source message', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('bare @fro-bot mention: fails fast BEFORE thread creation, lock, or run-state', async () => {
    // Post-Unit-3 behavior: the adapter strips the bot mention and detects an
    // empty prompt before calling launchWork. The "nothing to do" reply goes to
    // the SOURCE message (not a thread). No thread is created, no lock acquired,
    // no run-state written.

    // #given — message content is just the bot mention (empty prompt after strip)
    const {runMention} = await import('./run.js')
    // No setupHappyPath() — we must not reach the engine at all

    const thread = makeThread()
    const message = makeMessage(thread)
    // Override content to be a bare mention (empty after strip)
    ;(message as unknown as {content: string}).content = `<@${makeDeps().botUserId}>`
    const deps = makeDeps()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — NO thread created (fail-fast fires before threadFactory)
    expect(message.startThread).not.toHaveBeenCalled()

    // #and — NO lock acquired (fail-fast fires before launchWork)
    expect(mockRuntime.acquireLock).not.toHaveBeenCalled()

    // #and — NO run-state created (fail-fast fires before launchWork)
    expect(mockRuntime.createRun).not.toHaveBeenCalled()

    // #and — the "nothing to do" reply is sent to the SOURCE message (not a thread)
    expect(message.reply).toHaveBeenCalledOnce()
    const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      content: string
      allowedMentions: unknown
    }
    expect(call.content).toMatch(/nothing to do/i)
    expect(call.allowedMentions).toEqual({parse: []})

    // #and — the thread did NOT receive the "nothing to do" message
    expect(thread.send).not.toHaveBeenCalled()

    // #and — no run-state transitions (no FAILED, no COMPLETED)
    expect(mockRuntime.transitionRun).not.toHaveBeenCalled()
  })

  it('empty-prompt fail-fast: concurrency slot is NOT acquired (no slot to release)', async () => {
    // Post-Unit-3 behavior: fail-fast fires before launchWork, so the concurrency
    // slot is never acquired and never needs to be released.

    // #given — message content is a bare mention
    const {runMention} = await import('./run.js')

    const releaseFn = vi.fn()
    const tryAcquireFn = vi.fn().mockReturnValue('ok')
    const message = makeMessage()
    const deps = makeDeps({
      concurrency: {
        tryAcquire: tryAcquireFn,
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(0),
        max: 3,
      },
    })
    ;(message as unknown as {content: string}).content = `<@${deps.botUserId}>`

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — tryAcquire NOT called (fail-fast fires before launchWork)
    expect(tryAcquireFn).not.toHaveBeenCalled()
    // #and — release NOT called (slot was never acquired)
    expect(releaseFn).not.toHaveBeenCalled()
  })

  it('empty-prompt fail-fast: whitespace-only prompt after mention strip also fails fast', async () => {
    // #given — message content is mention + whitespace only
    const {runMention} = await import('./run.js')

    const message = makeMessage()
    const deps = makeDeps()
    ;(message as unknown as {content: string}).content = `<@${deps.botUserId}>   \t  `

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — fails fast: reply on source message, no thread
    expect(message.reply).toHaveBeenCalledOnce()
    const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
    expect(call.content).toMatch(/nothing to do/i)
    expect(message.startThread).not.toHaveBeenCalled()
  })
})

describe('launchWork — in-memory sink tests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('happy path: launchWork completes a run, calls statusSink.setReaction and replySink.flush', async () => {
    // #given — in-memory sinks; happy path runtime mocks
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when — await the run promise so the run completes before asserting
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — run completed (COMPLETED transition)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('COMPLETED')

    // #and — statusSink.setReaction called with 'working' and 'succeeded'
    const reactions = request._statusSink._reactions
    expect(reactions).toContain('working')
    expect(reactions).toContain('succeeded')

    // #and — replySink.flush called (delegated answer path)
    expect(request._replySink.flush).toHaveBeenCalled()
  })

  it('happy path: launchWork calls runOpenCodeCore with the request promptText', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const request = makeInMemoryRequest({promptText: 'fix the bug'})
    const deps = makeDeps()

    // #when — await the run promise so the run completes before asserting
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — runOpenCodeCore called with a promptText derived from the request
    expect(mockRunOpenCodeCore).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        promptText: expect.any(String) as unknown,
      }),
    )
    // The promptText is built by buildDiscordPrompt from request.promptText
    // (buildDiscordPrompt is mocked to return a fixed string)
  })

  it('happy path: launchWork acquires and releases the concurrency slot', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const releaseFn = vi.fn()
    const request = makeInMemoryRequest()
    const deps = makeDeps({
      concurrency: {
        tryAcquire: vi.fn().mockReturnValue('ok'),
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      },
    })

    // #when — await the run promise so the run completes before asserting
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — slot released in outer finally
    expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
  })

  it('happy path: launchWork calls statusSink.dispose in finally', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when — await the run promise so the run completes before asserting
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — statusSink.dispose called
    expect(request._statusSink.dispose).toHaveBeenCalledOnce()
  })

  // ── Timeout ────────────────────────────────────────────────────────────────

  it('timeout: launchWork respects runTimeoutMs; statusSink receives failed reaction; replySink.send called with timeout message', async () => {
    // #given — runOpenCodeCore throws timeout
    const {launchWork} = await import('./run.js')
    const {RunCoreError} = runCoreModule
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

    const request = makeInMemoryRequest()
    const deps = makeDeps({runTimeoutMs: 600_000})

    // #when — await the run promise so the run completes before asserting
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — failed reaction set
    expect(request._statusSink._reactions).toContain('failed')

    // #and — replySink.send called with timeout message (via delegated failure path)
    const sends = request._replySink._sends
    const timeoutSend = sends.find(s => s.content.includes('time limit'))
    expect(timeoutSend).toBeDefined()
    expect(timeoutSend?.content).toMatch(/10.?min/i)
  })

  it('timeout: launchWork transitions to FAILED on timeout', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    const {RunCoreError} = runCoreModule
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when — await the run promise so the run completes before asserting
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — FAILED transition
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('COMPLETED')
  })

  // ── Shutdown ───────────────────────────────────────────────────────────────

  it('shutdown: isShuttingDown() → slot released immediately, no handoff', async () => {
    // #given — shutdown in progress
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const releaseFn = vi.fn()
    const queue = makeDefaultQueue()
    const isShuttingDown = vi.fn().mockReturnValue(true)

    const request = makeInMemoryRequest()
    const deps = makeDeps({
      concurrency: {
        tryAcquire: vi.fn().mockReturnValue('ok'),
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      },
      queue,
      isShuttingDown,
    })

    // #when — await the run promise so the run completes before asserting
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — slot released immediately (no handoff)
    expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
    // #and — takeNext NOT called (shutdown gate fired)
    expect(queue.takeNext).not.toHaveBeenCalled()
  })

  // ── Queue/concurrency ──────────────────────────────────────────────────────

  it('queue: launchWork enqueues when channel is busy', async () => {
    // #given — channel is busy
    const {launchWork} = await import('./run.js')

    const queue = makeDefaultQueue()
    const request = makeInMemoryRequest()
    const deps = makeDeps({
      concurrency: {
        tryAcquire: vi.fn().mockReturnValue('busy'),
        release: vi.fn(),
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      },
      queue,
    })

    // #when
    await launchWork(request, deps)

    // #then — task enqueued
    expect(queue.enqueue).toHaveBeenCalledOnce()
    // #and — queued ack sent via replySink.send('source', ...)
    const sends = request._replySink._sends
    const queuedAck = sends.find(s => s.target === 'source' && s.content.includes('Queued'))
    expect(queuedAck).toBeDefined()
  })

  it('cap: launchWork sends capacity reply and does NOT enqueue', async () => {
    // #given — global cap reached
    const {launchWork} = await import('./run.js')

    const queue = makeDefaultQueue()
    const request = makeInMemoryRequest()
    const deps = makeDeps({
      concurrency: {
        tryAcquire: vi.fn().mockReturnValue('cap'),
        release: vi.fn(),
        activeCount: vi.fn().mockReturnValue(3),
        max: 3,
      },
      queue,
    })

    // #when
    await launchWork(request, deps)

    // #then — capacity reply sent via replySink.send('source', ...)
    const sends = request._replySink._sends
    const capReply = sends.find(s => s.target === 'source' && s.content.includes('capacity'))
    expect(capReply).toBeDefined()
    // #and — NOT enqueued
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('fIFO gate: launchWork enqueues when pendingCount > 0 (even if slot is free)', async () => {
    // #given — pending work exists; slot would be free
    const {launchWork} = await import('./run.js')

    const queue = makeDefaultQueue()
    ;(queue.pendingCount as ReturnType<typeof vi.fn>).mockReturnValue(1)
    const tryAcquireFn = vi.fn().mockReturnValue('ok')

    const request = makeInMemoryRequest()
    const deps = makeDeps({
      concurrency: {
        tryAcquire: tryAcquireFn,
        release: vi.fn(),
        activeCount: vi.fn().mockReturnValue(0),
        max: 3,
      },
      queue,
    })

    // #when
    await launchWork(request, deps)

    // #then — task enqueued (FIFO gate)
    expect(queue.enqueue).toHaveBeenCalledOnce()
    // #and — tryAcquire NOT consulted (pending work has priority)
    expect(tryAcquireFn).not.toHaveBeenCalled()
  })

  // ── No Discord dependency ──────────────────────────────────────────────────

  it('no Discord dependency: launchWork does NOT call setRunReaction (no message)', async () => {
    // #given — in-memory sinks; no Discord message
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when — await the run promise so the run completes before asserting
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — setRunReaction NOT called (no Discord message in launchWork path)
    // Reactions are handled by the statusSink.setReaction method instead
    const mockReaction = vi.mocked(reactionsModule.setRunReaction)
    expect(mockReaction).not.toHaveBeenCalled()
  })

  it('no Discord dependency: launchWork does NOT call message.startThread', async () => {
    // #given — in-memory sinks; no Discord message
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when — await the run promise so the run completes before asserting
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — createDiscordStreamSink NOT called (no thread in launchWork path)
    // The replySink is provided by the caller, not created internally
    expect(mockCreateDiscordStreamSink).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// threadFactory failure path (FIX 4)
// ---------------------------------------------------------------------------

describe('threadFactory failure path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('threadFactory returns {ok:false} → replySink.send called with error message, acquireLock NOT called, slot released, run terminalized to FAILED', async () => {
    // #given — threadFactory fails immediately
    // Note: createRun IS called in launchWork (admission) before executeWorkOnHeldSlot.
    // The threadFactory failure is an early-abort gate inside executeWorkOnHeldSlot.
    // The run is admitted (PENDING) and the threadFactory failure terminalizes it to FAILED.
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const thread = makeThread()
    const message = makeMessage(thread)
    // Override startThread to return a rejected promise so threadFactory fails
    ;(message.startThread as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Discord thread creation failed'))

    const releaseFn = vi.fn()
    const deps = makeDeps({
      concurrency: {
        tryAcquire: vi.fn().mockReturnValue('ok'),
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      },
    })

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — replySink.send called with coarse error message (via message.reply for 'source' target)
    expect(message.reply).toHaveBeenCalledOnce()
    const replyCall = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
    expect(replyCall.content).toContain('Could not start the task')

    // #and — acquireLock NOT called (threadFactory failed before lock acquisition)
    expect(mockRuntime.acquireLock).not.toHaveBeenCalled()

    // #and — createRun IS called (in launchWork admission block, before executeWorkOnHeldSlot)
    expect(mockRuntime.createRun).toHaveBeenCalledOnce()

    // #and — run terminalized to FAILED (no orphan PENDING)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    // ACKNOWLEDGED was NOT reached (threadFactory failed before ACK)
    expect(transitionPhases).not.toContain('ACKNOWLEDGED')

    // #and — concurrency slot released (no leak)
    expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
  })
})

// ---------------------------------------------------------------------------
// threadFactory timeout path (FIX 5)
// ---------------------------------------------------------------------------

/** Bounded timeout for threadFactory calls (ms). Mirrors the constant in run.ts. */
const THREAD_FACTORY_TIMEOUT_MS = 10_000

describe('threadFactory timeout path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('threadFactory that never resolves → times out, replySink.send called with error, acquireLock NOT called, slot released, run terminalized to FAILED', async () => {
    // #given — threadFactory hangs indefinitely (simulates a hung Discord API call)
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const thread = makeThread()
    const message = makeMessage(thread)
    // startThread returns a promise that never resolves — simulates a hung Discord call
    const neverResolves = new Promise<never>(() => {
      /* intentionally never resolves */
    })
    ;(message.startThread as ReturnType<typeof vi.fn>).mockReturnValue(neverResolves)

    const releaseFn = vi.fn()
    const deps = makeDeps({
      concurrency: {
        tryAcquire: vi.fn().mockReturnValue('ok'),
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      },
    })

    // #when — start the run; advance fake timers past the threadFactory timeout while it's pending
    // We must interleave timer advancement with the awaited promise so the setTimeout fires.
    const runPromise = runMention(message, makeBinding(), deps)
    // Advance past the threadFactory timeout (setTimeout in run.ts fires)
    await vi.advanceTimersByTimeAsync(THREAD_FACTORY_TIMEOUT_MS + 100)
    // Now the timeout rejection should have propagated; await the run to completion
    await runPromise

    // #then — replySink.send called with coarse error (via message.reply for 'source' target)
    expect(message.reply).toHaveBeenCalledOnce()
    const replyCall = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
    expect(replyCall.content).toContain('Could not start the task')

    // #and — acquireLock NOT called (threadFactory timed out before lock acquisition)
    expect(mockRuntime.acquireLock).not.toHaveBeenCalled()

    // #and — createRun IS called (in launchWork admission block, before executeWorkOnHeldSlot)
    expect(mockRuntime.createRun).toHaveBeenCalledOnce()

    // #and — run terminalized to FAILED (no orphan PENDING)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('ACKNOWLEDGED')

    // #and — concurrency slot released (no leak)
    expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
  }, 15_000)
})
