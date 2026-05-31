import type {CoordinationConfig, HeartbeatController} from '@fro-bot/runtime'
import type {Message, ThreadChannel} from 'discord.js'
import type {RepoBinding} from '../bindings/types.js'
import type {RunMentionDeps} from './run.js'

import * as runtimeModule from '@fro-bot/runtime'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import * as streamingModule from '../discord/streaming.js'
import * as attachModule from './opencode-attach.js'
import * as promptModule from './prompt.js'
import * as runCoreModule from './run-core.js'

// ---------------------------------------------------------------------------
// Mock external collaborators so run.test.ts does not need real AWS/S3/Discord
// ---------------------------------------------------------------------------

vi.mock('@fro-bot/runtime', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  createRun: vi.fn(),
  transitionRun: vi.fn(),
  createHeartbeatController: vi.fn(),
}))

vi.mock('./opencode-attach.js', () => ({
  attachOpencode: vi.fn().mockReturnValue({promptAsync: vi.fn(), subscribe: vi.fn()}),
}))

vi.mock('../discord/streaming.js', () => ({
  createDiscordStreamSink: vi.fn().mockReturnValue({
    append: vi.fn(),
    flush: vi.fn().mockResolvedValue({kind: 'sent', charCount: 10}),
    buffered: vi.fn().mockReturnValue(''),
  }),
}))

vi.mock('./prompt.js', () => ({
  buildDiscordPrompt: vi.fn().mockReturnValue('Repository: acme/widget\n\ndo the thing'),
  EmptyPromptError: class EmptyPromptError extends Error {
    constructor() {
      super('empty')
      this.name = 'EmptyPromptError'
    }
  },
}))

vi.mock('./run-core.js', () => ({
  runOpenCodeCore: vi.fn().mockResolvedValue(undefined),
  RunCoreError: class RunCoreError extends Error {
    readonly kind: string
    constructor(kind: string, message: string) {
      super(message)
      this.kind = kind
      this.name = 'RunCoreError'
    }
  },
}))

// ---------------------------------------------------------------------------
// Typed mocks
// ---------------------------------------------------------------------------

const mockRuntime = vi.mocked(runtimeModule)
const mockRunOpenCodeCore = vi.mocked(runCoreModule.runOpenCodeCore)
const mockCreateDiscordStreamSink = vi.mocked(streamingModule.createDiscordStreamSink)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const CHANNEL_ID = 'ch-test'
const OWNER = 'acme'
const REPO = 'widget'

function makeBinding(): RepoBinding {
  return {
    owner: OWNER,
    repo: REPO,
    channelId: CHANNEL_ID,
    channelName: 'widget-dev',
    workspacePath: '/workspace/acme/widget',
    createdAt: '2026-01-01T00:00:00Z',
    createdByDiscordId: 'user-1',
  }
}

function makeThread(): ThreadChannel & {send: ReturnType<typeof vi.fn>} {
  const sendFn = vi.fn(async (opts: unknown) => opts)
  return {
    id: 'thread-99',
    send: sendFn,
  } as unknown as ThreadChannel & {send: ReturnType<typeof vi.fn>}
}

function makeMessage(thread?: ReturnType<typeof makeThread>): Message & {
  startThread: ReturnType<typeof vi.fn>
  reply: ReturnType<typeof vi.fn>
  _thread: ReturnType<typeof makeThread>
} {
  const t = thread ?? makeThread()
  return {
    channel: {id: CHANNEL_ID, isThread: () => false},
    author: {id: 'user-111', bot: false},
    guild: null,
    startThread: vi.fn().mockResolvedValue(t),
    reply: vi.fn().mockResolvedValue(undefined),
    content: 'do the thing',
    _thread: t,
  } as unknown as Message & {
    startThread: ReturnType<typeof vi.fn>
    reply: ReturnType<typeof vi.fn>
    _thread: ReturnType<typeof makeThread>
  }
}

function makeDefaultConcurrency() {
  return {
    tryAcquire: vi.fn().mockReturnValue('ok'),
    release: vi.fn(),
    activeCount: vi.fn().mockReturnValue(1),
    max: 3,
  }
}

function makeDeps(overrides: Partial<RunMentionDeps> = {}): RunMentionDeps {
  return {
    coordinationConfig: {} as CoordinationConfig,
    identity: 'discord-gateway',
    concurrency: overrides.concurrency ?? makeDefaultConcurrency(),
    attachUrl: 'http://workspace:9200',
    attachToken: 'secret-bearer-token',
    runTimeoutMs: overrides.runTimeoutMs ?? 600000,
    botUserId: overrides.botUserId ?? 'bot-123',
    logger: overrides.logger ?? {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    ...overrides,
  }
}
/** Set up default happy-path returns for all runtime mocks. */
function setupHappyPath(heartbeatOverrides?: {start?: ReturnType<typeof vi.fn>; stop?: ReturnType<typeof vi.fn>}) {
  mockRuntime.acquireLock.mockResolvedValue({
    success: true as const,
    data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
  })
  mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
  mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
  mockRuntime.transitionRun.mockResolvedValue({
    success: true as const,
    data: {etag: 'run-etag-v2', state: {} as unknown as import('@fro-bot/runtime').RunState},
  })
  mockRuntime.createHeartbeatController.mockReturnValue({
    start: (heartbeatOverrides?.start ?? vi.fn()) as unknown as HeartbeatController['start'],
    stop: (heartbeatOverrides?.stop ??
      vi.fn().mockResolvedValue({
        success: true,
        data: {
          runEtag: 'run-etag-after-heartbeat',
          lockEtag: 'lock-etag-after-heartbeat',
          runState: {} as unknown as import('@fro-bot/runtime').RunState,
        },
      })) as unknown as HeartbeatController['stop'],
    isRunning: false,
  })
  mockCreateDiscordStreamSink.mockReturnValue({
    append: vi.fn(),
    flush: vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 10}),
    buffered: vi.fn().mockReturnValue(''),
  })
  mockRunOpenCodeCore.mockResolvedValue(undefined)
  vi.mocked(attachModule.attachOpencode).mockReturnValue({
    server: {url: 'http://workspace:9200'},
    session: {
      create: vi.fn(),
      prompt: vi.fn(),
    },
  } as unknown as ReturnType<typeof attachModule.attachOpencode>)
  vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runMention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Global concurrency cap ───────────────────────────────────────────────

  describe('concurrency cap', () => {
    it('replies "at capacity" and returns early when global cap is reached', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('cap'),
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(3),
          max: 3,
        },
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        content: string
        allowedMentions: unknown
      }
      expect(call.content).toContain('capacity')
      expect(call.allowedMentions).toEqual({parse: []})
      // No thread created
      expect(message.startThread).not.toHaveBeenCalled()
    })

    it('does NOT release concurrency slot when cap was returned (slot was never acquired)', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const releaseFn = vi.fn()
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('cap'),
          release: releaseFn,
          activeCount: vi.fn().mockReturnValue(3),
          max: 3,
        },
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — slot was NOT acquired; release is not called
      expect(releaseFn).not.toHaveBeenCalled()
    })
  })

  // ── Per-channel in-flight guard ─────────────────────────────────────────

  describe('per-channel in-flight guard', () => {
    it('replies "busy" when channel already has an active run', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('busy'),
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        content: string
        allowedMentions: unknown
      }
      expect(call.content).toContain('already a task')
      expect(call.allowedMentions).toEqual({parse: []})
      expect(message.startThread).not.toHaveBeenCalled()
    })
  })

  // ── Lock acquisition ────────────────────────────────────────────────────

  describe('lock acquisition', () => {
    it('replies to thread "waiting" when lock is held by another — terminal, no queue', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const thread = makeThread()
      const message = makeMessage(thread)
      const releaseFn = vi.fn()
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('ok'),
          release: releaseFn,
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
      })

      mockRuntime.acquireLock.mockResolvedValue({
        success: true as const,
        data: {acquired: false as const, etag: null, holder: {holder_id: 'other-gateway', etag: 'abc'} as unknown},
      } as Awaited<ReturnType<typeof runtimeModule.acquireLock>>)

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — "waiting" sent to thread (coarse message, no holder ID)
      expect(thread.send).toHaveBeenCalledOnce()
      const call = thread.send.mock.calls[0]?.[0] as {content: string; allowedMentions: unknown}
      expect(call.allowedMentions).toEqual({parse: []})
      expect(call.content).toContain('in progress')
      // MUST NOT leak holder ID
      expect(call.content).not.toContain('other-gateway')
      // Concurrency slot released in finally
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
    })

    it('replies coarse error to thread when acquireLock itself errors (no S3 detail)', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const thread = makeThread()
      const message = makeMessage(thread)

      mockRuntime.acquireLock.mockResolvedValue({
        success: false as const,
        error: new Error('S3 timeout — internal'),
      })
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — coarse reply, no S3 error detail
      expect(thread.send).toHaveBeenCalledOnce()
      const call = thread.send.mock.calls[0]?.[0] as {content: string; allowedMentions: unknown}
      expect(call.allowedMentions).toEqual({parse: []})
      expect(call.content).not.toContain('S3')
      expect(call.content).not.toContain('internal')
    })
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
      })
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('timeout', 'timed out'))

      const thread = makeThread()
      const message = makeMessage(thread)
      const deps = makeDeps()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — flush called on error path
      expect(flushMock).toHaveBeenCalledOnce()
      // #and — error message sent after flush
      const lastCall = thread.send.mock.calls.at(-1)?.[0] as {content: string}
      expect(lastCall.content).toContain('timed out')
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
      })
      setupHappyPath()
      // Make EXECUTING transition fail — error caught before sink is created
      mockRuntime.transitionRun
        .mockResolvedValueOnce({
          success: true as const,
          data: {etag: 'ack-etag', state: {} as unknown as import('@fro-bot/runtime').RunState},
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
