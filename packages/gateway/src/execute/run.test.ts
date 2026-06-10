import type {CoordinationConfig, HeartbeatController} from '@fro-bot/runtime'
import type {Message, ThreadChannel} from 'discord.js'
import type {ApprovalRegistry} from '../approvals/registry.js'
import type {RepoBinding} from '../bindings/types.js'
import type {ChannelQueue} from './queue.js'
import type {RunMentionDeps, RunTask} from './run.js'

import * as runtimeModule from '@fro-bot/runtime'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import * as coordinatorModule from '../approvals/coordinator.js'
import * as discordApprovalsModule from '../discord/approvals.js'
import * as reactionsModule from '../discord/reactions.js'
import * as statusMessageModule from '../discord/status-message.js'
import * as streamingModule from '../discord/streaming.js'
import * as attachModule from './opencode-attach.js'
import * as promptModule from './prompt.js'
import * as runCoreModule from './run-core.js'
import {formatTimeoutDuration} from './run.js'

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

vi.mock('../approvals/coordinator.js', () => ({
  createPermissionCoordinator: vi.fn().mockReturnValue({
    onPermissionAsked: vi.fn(),
    onPermissionReplied: vi.fn(),
    pending: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
  }),
}))

vi.mock('../discord/approvals.js', () => ({
  buildApprovalEmbed: vi.fn().mockReturnValue({type: 'embed'}),
  buildApprovalButtons: vi.fn().mockReturnValue({type: 'buttons'}),
  buildSettledEmbed: vi.fn().mockReturnValue({type: 'settled-embed'}),
  parseApprovalCustomId: vi.fn().mockReturnValue(null),
  APPROVE_PREFIX: 'fb-approve:',
  DENY_PREFIX: 'fb-deny:',
}))

vi.mock('./opencode-attach.js', () => ({
  attachOpencode: vi.fn().mockReturnValue({
    promptAsync: vi.fn(),
    subscribe: vi.fn(),
    client: {
      permission: {
        reply: vi.fn().mockResolvedValue({data: null, error: null}),
      },
    },
  }),
}))

vi.mock('../discord/streaming.js', () => ({
  createDiscordStreamSink: vi.fn().mockReturnValue({
    append: vi.fn(),
    flush: vi.fn().mockResolvedValue({kind: 'sent', charCount: 10}),
    buffered: vi.fn().mockReturnValue(''),
    markVisibleOutputSent: vi.fn(),
    markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
    hasVisibleOutput: vi.fn().mockReturnValue(false),
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

vi.mock('../discord/status-message.js', () => ({
  createStatusController: vi.fn().mockReturnValue({
    noteActivity: vi.fn(),
    setBusy: vi.fn(),
    resolveToAnswer: vi.fn().mockResolvedValue({transition: 'delegated'}),
    resolveToFailure: vi.fn().mockResolvedValue({transition: 'delegated'}),
    dispose: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../discord/reactions.js', () => ({
  setRunReaction: vi.fn().mockResolvedValue(undefined),
  REACTION_EMOJIS: {
    working: '⏳',
    succeeded: '✅',
    failed: '❌',
    'awaiting-approval': '⏸️',
  },
}))

// ---------------------------------------------------------------------------
// Typed mocks
// ---------------------------------------------------------------------------

const mockRuntime = vi.mocked(runtimeModule)
const mockRunOpenCodeCore = vi.mocked(runCoreModule.runOpenCodeCore)
const mockCreateDiscordStreamSink = vi.mocked(streamingModule.createDiscordStreamSink)
const mockCreatePermissionCoordinator = vi.mocked(coordinatorModule.createPermissionCoordinator)
const mockCreateStatusController = vi.mocked(statusMessageModule.createStatusController)
vi.mocked(discordApprovalsModule) // ensure module mock is applied

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

function makeApprovalRegistry(): ApprovalRegistry {
  return {
    register: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    pending: vi.fn().mockReturnValue([]),
    handleButtonDecision: vi.fn().mockResolvedValue('ok'),
    applySettlement: vi.fn().mockResolvedValue(undefined),
    attachMessage: vi.fn(),
    markMessagePostFailed: vi.fn(),
    confirmReply: vi.fn(),
    disposeRun: vi.fn(),
    disposeAll: vi.fn().mockResolvedValue(undefined),
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

function makeDefaultQueue(): ChannelQueue<RunTask> {
  return {
    enqueue: vi.fn().mockReturnValue('queued'),
    pendingCount: vi.fn().mockReturnValue(0),
    takeNext: vi.fn().mockReturnValue(undefined),
    clear: vi.fn().mockReturnValue(0),
  }
}

/**
 * Build a stream-sink mock with sensible defaults. Pass overrides to customise
 * individual methods without repeating the full literal in every test.
 */
function makeStreamSinkMock(
  overrides: {
    append?: ReturnType<typeof vi.fn>
    flush?: ReturnType<typeof vi.fn>
    buffered?: ReturnType<typeof vi.fn>
    markVisibleOutputSent?: ReturnType<typeof vi.fn>
    markVisibleOutputPending?: ReturnType<typeof vi.fn>
    hasVisibleOutput?: ReturnType<typeof vi.fn>
  } = {},
) {
  return {
    append: overrides.append ?? vi.fn(),
    flush: overrides.flush ?? vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 10}),
    buffered: overrides.buffered ?? vi.fn().mockReturnValue(''),
    markVisibleOutputSent: overrides.markVisibleOutputSent ?? vi.fn(),
    markVisibleOutputPending: overrides.markVisibleOutputPending ?? vi.fn().mockReturnValue(vi.fn()),
    hasVisibleOutput: overrides.hasVisibleOutput ?? vi.fn().mockReturnValue(false),
  }
}

/**
 * Build a stateful stream-sink mock where flush() sets the visible flag and
 * hasVisibleOutput() reads it. Simulates the real sink's post-flush visibility
 * state so tests can prove the timeout classifier reads state AFTER flush.
 *
 * @param flushKind - the kind returned by flush() (determines whether visible is set)
 * @param flushShouldSetVisible - when true, flush() sets visible=true (simulates sent/attachment)
 */
function makeStatefulSinkMock(
  flushKind: 'sent' | 'attachment' | 'empty' | 'skipped-visible',
  flushShouldSetVisible: boolean,
) {
  let visible = false
  const flushFn = vi.fn().mockImplementation(async () => {
    if (flushShouldSetVisible) visible = true
    if (flushKind === 'sent') return {kind: 'sent' as const, charCount: 10}
    if (flushKind === 'attachment') return {kind: 'attachment' as const, charCount: 3000}
    if (flushKind === 'skipped-visible') return {kind: 'skipped-visible' as const}
    return {kind: 'empty' as const}
  })
  const hasVisibleOutputFn = vi.fn().mockImplementation(() => visible)
  return {
    append: vi.fn(),
    flush: flushFn,
    buffered: vi.fn().mockReturnValue(''),
    markVisibleOutputSent: vi.fn().mockImplementation(() => {
      visible = true
    }),
    markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
    hasVisibleOutput: hasVisibleOutputFn,
  }
}

/**
 * Build a stateful sink mock that properly tracks pending-visibility state
 * via markVisibleOutputPending(), mirroring the real sink's closure semantics.
 * Used to prove that in-flight sends count as visible context at classification time.
 *
 * flush() faithfully emulates the real createDiscordStreamSink empty-buffer semantics
 * after FIX 1: when the buffer is empty, returns {kind:'skipped-visible'} if
 * visibleOutputSent === true || pendingVisibleOutput > 0, else records that the
 * _(no output)_ message was posted and returns {kind:'empty'}.
 */
function makeStatefulPendingSinkMock() {
  let visibleOutputSent = false
  let pendingVisibleOutput = 0
  let noOutputPosted = false

  const markVisibleOutputPending = vi.fn().mockImplementation(() => {
    pendingVisibleOutput += 1
    let settled = false
    return (delivered: boolean): void => {
      if (settled === true) {
        return
      }
      settled = true
      pendingVisibleOutput -= 1
      if (delivered === true) {
        visibleOutputSent = true
      }
    }
  })

  const flushFn = vi.fn().mockImplementation(async () => {
    // Emulate real sink empty-buffer path (FIX 1 semantics):
    // skip _(no output)_ when either delivered OR pending visible output exists.
    if (visibleOutputSent === true || pendingVisibleOutput > 0) {
      return {kind: 'skipped-visible' as const}
    }
    // Genuinely empty — record that _(no output)_ would be posted
    noOutputPosted = true
    return {kind: 'empty' as const}
  })

  return {
    append: vi.fn(),
    flush: flushFn,
    buffered: vi.fn().mockReturnValue(''),
    markVisibleOutputSent: vi.fn().mockImplementation(() => {
      visibleOutputSent = true
    }),
    markVisibleOutputPending,
    hasVisibleOutput: vi.fn().mockImplementation(() => visibleOutputSent === true || pendingVisibleOutput > 0),
    /** Test-only: true if flush() posted the _(no output)_ fallback message. */
    _noOutputPosted: () => noOutputPosted,
  }
}

/**
 * Build a status controller mock with configurable transition results.
 * Returns the mock controller and wires it into `mockCreateStatusController`.
 */
function makeStatusControllerMock(
  opts: {
    resolveToAnswerResult?: {transition: 'handled' | 'delegated'}
    resolveToFailureResult?: {transition: 'handled' | 'delegated'}
  } = {},
) {
  const ctrl = {
    noteActivity: vi.fn(),
    setBusy: vi.fn(),
    resolveToAnswer: vi.fn().mockResolvedValue(opts.resolveToAnswerResult ?? {transition: 'delegated'}),
    resolveToFailure: vi.fn().mockResolvedValue(opts.resolveToFailureResult ?? {transition: 'delegated'}),
    dispose: vi.fn().mockResolvedValue(undefined),
  }
  mockCreateStatusController.mockReturnValue(ctrl)
  return ctrl
}

function makeEnsureCloneFn(result: 'success' | 'failure' = 'success') {
  return result === 'success'
    ? vi.fn().mockResolvedValue({success: true as const, data: '/workspace/acme/widget'})
    : vi.fn().mockResolvedValue({
        success: false as const,
        error: {kind: 'workspace-failure' as const, workspaceKind: 'network-error' as const},
      })
}

function makeReadyzFn(result: 'ready' | 'not-ready' | 'throws' = 'ready') {
  if (result === 'throws') {
    return vi.fn().mockRejectedValue(new Error('readyz threw'))
  }
  return result === 'ready'
    ? vi.fn().mockResolvedValue({success: true as const, data: {ready: true, opencode: 'ready'}})
    : vi.fn().mockResolvedValue({success: true as const, data: {ready: false, opencode: 'starting'}})
}

function makeDeps(overrides: Partial<RunMentionDeps> = {}): RunMentionDeps {
  return {
    coordinationConfig: {} as CoordinationConfig,
    identity: 'discord-gateway',
    concurrency: overrides.concurrency ?? makeDefaultConcurrency(),
    queue: overrides.queue ?? makeDefaultQueue(),
    attachUrl: 'http://workspace:9200',
    attachToken: 'secret-bearer-token',
    runTimeoutMs: overrides.runTimeoutMs ?? 600000,
    botUserId: overrides.botUserId ?? 'bot-123',
    persona: overrides.persona ?? null,
    logger: overrides.logger ?? {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    approvalRegistry: overrides.approvalRegistry ?? makeApprovalRegistry(),
    approvalMode: overrides.approvalMode ?? 'approval-required',
    statusMode: overrides.statusMode ?? 'live-status',
    ensureClone: overrides.ensureClone ?? makeEnsureCloneFn('success'),
    readyz: overrides.readyz ?? makeReadyzFn('ready'),
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
  mockCreateDiscordStreamSink.mockReturnValue(
    makeStreamSinkMock() as unknown as ReturnType<typeof streamingModule.createDiscordStreamSink>,
  )
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
    it('enqueues and sends queued ack when channel already has an active run (busy → queue)', async () => {
      // #given — channel is busy; queue has capacity
      const {runMention} = await import('./run.js')
      const enqueueFn = vi.fn().mockReturnValue('queued')
      const queue = makeDefaultQueue()
      ;(queue.enqueue as ReturnType<typeof vi.fn>).mockImplementation(enqueueFn)
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('busy'),
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
        queue,
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — task enqueued
      expect(queue.enqueue).toHaveBeenCalledOnce()
      // #and — queued ack sent (not the old "already a task" reject)
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        content: string
        allowedMentions: unknown
      }
      expect(call.content).not.toContain('already a task')
      expect(call.content).toMatch(/queue/i)
      expect(call.allowedMentions).toEqual({parse: []})
      // #and — no thread created (not running immediately)
      expect(message.startThread).not.toHaveBeenCalled()
    })
  })

  // ── Ensure-clone gate (after concurrency, before thread/lock) ──────────

  describe('ensure-clone gate', () => {
    it('happy path: ensure-clone succeeds → proceeds to thread creation and execution', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const ensureClone = makeEnsureCloneFn('success')
      const deps = makeDeps({ensureClone})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — ensureClone was called; execution proceeded
      expect(ensureClone).toHaveBeenCalledWith(OWNER, REPO)
      expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    })

    it('ensure-clone failure → coarse reply, no thread created, concurrency slot released', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const ensureClone = makeEnsureCloneFn('failure')
      const releaseFn = vi.fn()
      const deps = makeDeps({
        ensureClone,
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('ok'),
          release: releaseFn,
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — coarse reply sent via message.reply (no thread yet)
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        content: string
        allowedMentions: unknown
      }
      expect(call.content).toContain('workspace')
      expect(call.allowedMentions).toEqual({parse: []})
      // No thread created
      expect(message.startThread).not.toHaveBeenCalled()
      // Concurrency slot released in finally
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
    })

    it('ensure-clone failure does not expose internal details in reply', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const ensureClone = vi.fn().mockResolvedValue({
        success: false as const,
        error: {kind: 'auth-failure' as const, reason: 'auth-error' as const},
      })
      const deps = makeDeps({ensureClone})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — no internal detail in reply
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
      expect(call.content).not.toContain('auth')
      expect(call.content).not.toContain('token')
      expect(call.content).not.toContain('clone')
    })

    it('ensure-clone is NOT called when concurrency cap is reached (storm guard)', async () => {
      // #given — concurrency cap fires before ensure-clone
      const {runMention} = await import('./run.js')
      const ensureClone = makeEnsureCloneFn('success')
      const deps = makeDeps({
        ensureClone,
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

      // #then — cap reply sent; ensureClone never called
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
      expect(call.content).toContain('capacity')
      expect(ensureClone).not.toHaveBeenCalled()
    })

    it('ensure-clone is NOT called when channel is busy (enqueued — storm guard)', async () => {
      // #given — busy enqueues; ensure-clone must not be called before the slot is held
      const {runMention} = await import('./run.js')
      const ensureClone = makeEnsureCloneFn('success')
      const deps = makeDeps({
        ensureClone,
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

      // #then — queued ack sent; ensureClone never called
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
      expect(call.content).toMatch(/queue/i)
      expect(ensureClone).not.toHaveBeenCalled()
    })

    it('runOpenCodeCore receives ensured path from ensureClone, not stale binding.workspacePath', async () => {
      // #given — binding has a stale workspacePath; ensureClone returns the canonical path
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const canonicalPath = '/workspace/canonical/acme/widget'
      const ensureClone = vi.fn().mockResolvedValue({success: true as const, data: canonicalPath})
      const staleBinding = {...makeBinding(), workspacePath: '/old/stale/path'}
      const deps = makeDeps({ensureClone})
      const msg = makeMessage()

      // #when
      await runMention(msg, staleBinding, deps)

      // #then — runOpenCodeCore called with the canonical path
      expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
      const coreParams = mockRunOpenCodeCore.mock.calls[0]?.[0] as {directory?: string}
      expect(coreParams.directory).toBe(canonicalPath)
      expect(coreParams.directory).not.toBe('/old/stale/path')
    })
  })

  // ── Readiness gate (after ensure-clone, before thread/lock) ─────────────

  describe('readiness gate', () => {
    it('happy path: readyz=ready → proceeds to thread creation and execution', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const readyz = makeReadyzFn('ready')
      const deps = makeDeps({readyz})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — readyz called; execution proceeded
      expect(readyz).toHaveBeenCalledOnce()
      expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    })

    it('readyz=not-ready → coarse reply, no thread created, concurrency slot released', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const readyz = makeReadyzFn('not-ready')
      const releaseFn = vi.fn()
      const deps = makeDeps({
        readyz,
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('ok'),
          release: releaseFn,
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — coarse reply; no thread
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        content: string
        allowedMentions: unknown
      }
      expect(call.content).toContain('not reachable')
      expect(call.allowedMentions).toEqual({parse: []})
      expect(message.startThread).not.toHaveBeenCalled()
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
    })

    it('readyz throws → fail-closed: coarse reply, no thread created', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const readyz = makeReadyzFn('throws')
      const deps = makeDeps({readyz})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — thrown exception treated as not-ready (fail-closed)
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
      expect(call.content).toContain('not reachable')
      expect(message.startThread).not.toHaveBeenCalled()
    })

    it('readyz is NOT called when ensure-clone fails', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const ensureClone = makeEnsureCloneFn('failure')
      const readyz = makeReadyzFn('ready')
      const deps = makeDeps({ensureClone, readyz})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — ensure-clone failed: readyz never called
      expect(readyz).not.toHaveBeenCalled()
    })

    it('readyz is NOT called when concurrency cap fires', async () => {
      // #given
      const {runMention} = await import('./run.js')
      const readyz = makeReadyzFn('ready')
      const deps = makeDeps({
        readyz,
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

      // #then — cap fires before readyz
      expect(readyz).not.toHaveBeenCalled()
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
        | {onDeadlineSettled?: () => void | Promise<void>}
        | undefined
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
          channelID: thread.id,
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
        | {onDeadlineSettled?: () => void | Promise<void>}
        | undefined
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
        | {deadlineMs?: number}
        | undefined
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

  // ── Serial per-channel queue — front door + atomic handoff ─────────────

  describe('serial per-channel queue', () => {
    // ── busy → enqueue + queued ack ──────────────────────────────────────────

    it('r1: mention while channel busy → queue.enqueue called + queued ack sent (not old reject)', async () => {
      // #given — channel is busy; queue has capacity
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const queue = makeDefaultQueue()
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('busy'),
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
        queue,
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — task enqueued
      expect(queue.enqueue).toHaveBeenCalledOnce()
      // #and — queued ack sent (not the old terminal reject)
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        content: string
        allowedMentions: unknown
      }
      expect(call.content).toMatch(/queue/i)
      expect(call.content).not.toContain('already a task')
      expect(call.allowedMentions).toEqual({parse: []})
      // #and — startRun pipeline NOT invoked synchronously
      expect(message.startThread).not.toHaveBeenCalled()
      expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    })

    it('r1: busy + queue.enqueue returns "full" → terse "queue is full" reply (not queued ack)', async () => {
      // #given — channel is busy; queue is at capacity
      const {runMention} = await import('./run.js')
      const queue = makeDefaultQueue()
      ;(queue.enqueue as ReturnType<typeof vi.fn>).mockReturnValue('full')
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('busy'),
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
        queue,
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — "queue is full" reply (not the queued ack)
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        content: string
        allowedMentions: unknown
      }
      expect(call.content).toMatch(/full/i)
      expect(call.allowedMentions).toEqual({parse: []})
      // #and — no thread created
      expect(message.startThread).not.toHaveBeenCalled()
    })

    // ── FIFO gate: pending work present → enqueue even if slot is free ───────

    it('fIFO gate: new mention with pendingCount > 0 is enqueued even though tryAcquire would return ok', async () => {
      // #given — no in-flight run (tryAcquire would return 'ok') but pending work exists
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const queue = makeDefaultQueue()
      // pendingCount returns 1 → front-door must enqueue without consulting tryAcquire
      ;(queue.pendingCount as ReturnType<typeof vi.fn>).mockReturnValue(1)
      const tryAcquireFn = vi.fn().mockReturnValue('ok')
      const deps = makeDeps({
        concurrency: {
          tryAcquire: tryAcquireFn,
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(0),
          max: 3,
        },
        queue,
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — task enqueued (not started immediately)
      expect(queue.enqueue).toHaveBeenCalledOnce()
      // #and — tryAcquire NOT consulted (pending work has priority)
      expect(tryAcquireFn).not.toHaveBeenCalled()
      // #and — startRun pipeline NOT invoked
      expect(message.startThread).not.toHaveBeenCalled()
      expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
      // #and — queued ack sent
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
      expect(call.content).toMatch(/queue/i)
    })

    // ── completion with pending task → takeNext + next startRun ─────────────

    it('r2: completion with pending task → takeNext called + next startRun begins', async () => {
      // #given — first run completes; queue has one pending task
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const releaseFn = vi.fn()
      const sharedConcurrency = {
        tryAcquire: vi.fn().mockReturnValue('ok'),
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      }
      const queue = makeDefaultQueue()

      // The pending task must share the same concurrency + queue so the handoff
      // uses the same release fn and the same takeNext chain.
      const pendingMessage = makeMessage()
      const pendingBinding = makeBinding()
      const pendingDeps = makeDeps({concurrency: sharedConcurrency, queue})
      const pendingTask: RunTask = {message: pendingMessage, binding: pendingBinding, deps: pendingDeps}

      ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingTask).mockReturnValue(undefined)

      const deps = makeDeps({concurrency: sharedConcurrency, queue})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // Allow the fire-and-forget handoff to settle
      await new Promise(resolve => setTimeout(resolve, 10))

      // #then — takeNext was called (handoff attempted)
      expect(queue.takeNext).toHaveBeenCalledWith(CHANNEL_ID)
      // #and — runOpenCodeCore called twice (once for original, once for queued task)
      expect(mockRunOpenCodeCore).toHaveBeenCalledTimes(2)
      // #and — concurrency.release called exactly once (after the second run completes with empty queue)
      // The slot was handed off (not freed) between the two runs; release fires only after the last run.
      expect(releaseFn).toHaveBeenCalledExactlyOnceWith(CHANNEL_ID)
    })

    it('r2: completion with empty queue → concurrency.release IS called (slot freed)', async () => {
      // #given — first run completes; queue is empty
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const queue = makeDefaultQueue()
      // takeNext returns undefined → queue is empty
      ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValue(undefined)

      const releaseFn = vi.fn()
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('ok'),
          release: releaseFn,
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
        queue,
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — takeNext was called
      expect(queue.takeNext).toHaveBeenCalledWith(CHANNEL_ID)
      // #and — concurrency.release IS called (queue was empty)
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
    })

    // ── Serial safety: no free-slot gap ──────────────────────────────────────

    it('serial safety: slot handed off without concurrency.release between runs (no free-slot gap)', async () => {
      // #given — first run completes; queue has one pending task
      // Assert: concurrency.release is NOT called between the two startRun invocations.
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const releaseFn = vi.fn()
      const callOrder: string[] = []

      // Track when release is called vs when runOpenCodeCore is called
      releaseFn.mockImplementation(() => {
        callOrder.push('release')
      })
      mockRunOpenCodeCore.mockImplementation(async () => {
        callOrder.push('runOpenCodeCore')
      })

      const sharedConcurrency = {
        tryAcquire: vi.fn().mockReturnValue('ok'),
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      }
      const queue = makeDefaultQueue()

      // The pending task must share the same concurrency + queue so the handoff
      // uses the same release fn and the same takeNext chain.
      const pendingMessage = makeMessage()
      const pendingDeps = makeDeps({concurrency: sharedConcurrency, queue})
      const pendingTask: RunTask = {message: pendingMessage, binding: makeBinding(), deps: pendingDeps}

      ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingTask).mockReturnValue(undefined)

      const deps = makeDeps({concurrency: sharedConcurrency, queue})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)
      await new Promise(resolve => setTimeout(resolve, 10))

      // #then — runOpenCodeCore called twice (two runs)
      expect(callOrder.filter(e => e === 'runOpenCodeCore')).toHaveLength(2)
      // #and — release NOT called between the two runs (no free-slot gap)
      // release should only be called AFTER the second run completes
      const firstRunIdx = callOrder.indexOf('runOpenCodeCore')
      const secondRunIdx = callOrder.lastIndexOf('runOpenCodeCore')
      const releaseIdx = callOrder.indexOf('release')
      // release must come AFTER the second run, not between them
      expect(releaseIdx).toBeGreaterThan(secondRunIdx)
      // release must NOT appear between first and second run
      expect(callOrder.slice(firstRunIdx + 1, secondRunIdx)).not.toContain('release')
    })

    // ── ok path and cap path ─────────────────────────────────────────────────

    it('r5: ok path (no pending work) runs normally — startRun pipeline invoked', async () => {
      // #given — no pending work; tryAcquire returns ok
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const queue = makeDefaultQueue()
      // pendingCount returns 0 → ok path
      ;(queue.pendingCount as ReturnType<typeof vi.fn>).mockReturnValue(0)
      const deps = makeDeps({queue})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — full pipeline ran
      expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
      expect(message.startThread).toHaveBeenCalledOnce()
    })

    it('r6: cap path replies terminally and does NOT enqueue', async () => {
      // #given — global cap reached
      const {runMention} = await import('./run.js')
      const queue = makeDefaultQueue()
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('cap'),
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(3),
          max: 3,
        },
        queue,
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — terminal capacity reply
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
      expect(call.content).toContain('capacity')
      // #and — NOT enqueued (cap stays terminal)
      expect(queue.enqueue).not.toHaveBeenCalled()
      // #and — no thread created
      expect(message.startThread).not.toHaveBeenCalled()
    })

    // ── Error path: handed-off startRun that throws still releases ───────────

    it('error path: handed-off startRun that throws still releases/hands off (its own finally)', async () => {
      // #given — first run completes; queue has one pending task that will throw
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const releaseFn = vi.fn()
      const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
      const sharedConcurrency = {
        tryAcquire: vi.fn().mockReturnValue('ok'),
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      }
      const queue = makeDefaultQueue()

      // The pending task must share the same concurrency + queue so the handoff
      // uses the same release fn and the same takeNext chain.
      const pendingMessage = makeMessage()
      const pendingDeps = makeDeps({concurrency: sharedConcurrency, queue, logger})
      const pendingTask: RunTask = {message: pendingMessage, binding: makeBinding(), deps: pendingDeps}

      ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingTask).mockReturnValue(undefined)

      // Second run (the handed-off one) throws
      mockRunOpenCodeCore
        .mockResolvedValueOnce(undefined) // first run succeeds
        .mockRejectedValueOnce(new Error('handoff run failed')) // second run throws

      const deps = makeDeps({concurrency: sharedConcurrency, queue, logger})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)
      // Allow the fire-and-forget handoff to settle (including its error path)
      await new Promise(resolve => setTimeout(resolve, 20))

      // #then — slot eventually released (handoff's own finally ran)
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
      // #and — queue not stranded (takeNext called for the handoff too)
      expect(queue.takeNext).toHaveBeenCalledTimes(2)
    })

    // ── Integration: three mentions run strictly FIFO ─────────────────────────

    it('integration: three mentions on a busy channel run strictly FIFO with no concurrent overlap', async () => {
      // #given — simulate three sequential mentions on the same channel
      // First mention: acquires slot immediately (ok) and runs
      // Second + third: arrive while first is still running (busy → enqueue)
      // After first completes: second starts via handoff; after second: third starts
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const runOrder: string[] = []
      const releaseOrder: string[] = []

      // Use a real queue to test FIFO ordering
      const {createChannelQueue} = await import('./queue.js')
      const realQueue = createChannelQueue<RunTask>()

      // Control when the first run completes — it must pause so msg2/msg3 can be enqueued
      let resolveFirstRun!: () => void
      const firstRunPaused = new Promise<void>(resolve => {
        resolveFirstRun = resolve
      })

      let runCount = 0
      mockRunOpenCodeCore.mockImplementation(async () => {
        runCount++
        const thisRun = runCount
        runOrder.push(`run-${thisRun}`)
        // First run pauses until we explicitly release it
        if (thisRun === 1) {
          await firstRunPaused
        }
      })

      const releaseFn = vi.fn().mockImplementation(() => {
        releaseOrder.push('release')
      })

      // Concurrency: first tryAcquire returns 'ok', subsequent return 'busy'
      let acquireCount = 0
      const tryAcquireFn = vi.fn().mockImplementation(() => {
        acquireCount++
        return acquireCount === 1 ? 'ok' : 'busy'
      })

      const sharedConcurrency = {
        tryAcquire: tryAcquireFn,
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      }

      // All three mentions share the same concurrency + queue so handoffs chain correctly.
      const deps1 = makeDeps({concurrency: sharedConcurrency, queue: realQueue})
      const deps2 = makeDeps({concurrency: sharedConcurrency, queue: realQueue})
      const deps3 = makeDeps({concurrency: sharedConcurrency, queue: realQueue})

      const msg1 = makeMessage()
      const msg2 = makeMessage()
      const msg3 = makeMessage()

      // #when — start first mention (it will pause inside runOpenCodeCore)
      const run1Promise = runMention(msg1, makeBinding(), deps1)

      // Yield to let run1 start and reach the pause point
      await new Promise(resolve => setTimeout(resolve, 0))

      // Second and third arrive while first is still running (busy)
      await runMention(msg2, makeBinding(), deps2)
      await runMention(msg3, makeBinding(), deps3)

      // Verify second and third were enqueued (not started yet)
      expect(realQueue.pendingCount(CHANNEL_ID)).toBe(2)

      // Release the first run to complete
      resolveFirstRun()
      await run1Promise

      // Allow all handoffs to settle
      await new Promise(resolve => setTimeout(resolve, 50))

      // #then — all three runs completed in order
      expect(runOrder).toEqual(['run-1', 'run-2', 'run-3'])
      // #and — slot released exactly once (after the last run)
      expect(releaseOrder).toHaveLength(1)
      // #and — queue fully drained
      expect(realQueue.pendingCount(CHANNEL_ID)).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// isShuttingDown — shutdown gate for handoff
// ---------------------------------------------------------------------------

describe('isShuttingDown — handoff shutdown gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('when isShuttingDown() returns true, handoff does NOT call queue.takeNext and DOES release the slot', async () => {
    // #given — first run completes; shutdown is in progress
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const releaseFn = vi.fn()
    const sharedConcurrency = {
      tryAcquire: vi.fn().mockReturnValue('ok'),
      release: releaseFn,
      activeCount: vi.fn().mockReturnValue(1),
      max: 3,
    }
    const queue = makeDefaultQueue()
    const isShuttingDown = vi.fn().mockReturnValue(true)

    const deps = makeDeps({concurrency: sharedConcurrency, queue, isShuttingDown})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — shutdown gate fired: takeNext NOT called (no handoff started)
    expect(queue.takeNext).not.toHaveBeenCalled()
    // #and — slot released immediately (not transferred to a next run)
    expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
  })

  it('when isShuttingDown() returns false, normal handoff proceeds (takeNext called, startRun fires)', async () => {
    // #given — first run completes; NOT shutting down; queue has one pending task
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const releaseFn = vi.fn()
    const sharedConcurrency = {
      tryAcquire: vi.fn().mockReturnValue('ok'),
      release: releaseFn,
      activeCount: vi.fn().mockReturnValue(1),
      max: 3,
    }
    const queue = makeDefaultQueue()
    const isShuttingDown = vi.fn().mockReturnValue(false)

    const pendingMessage = makeMessage()
    const pendingDeps = makeDeps({concurrency: sharedConcurrency, queue, isShuttingDown})
    const pendingTask: RunTask = {message: pendingMessage, binding: makeBinding(), deps: pendingDeps}

    ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingTask).mockReturnValue(undefined)

    const deps = makeDeps({concurrency: sharedConcurrency, queue, isShuttingDown})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)
    // Allow the fire-and-forget handoff to settle
    await new Promise(resolve => setTimeout(resolve, 10))

    // #then — not shutting down: takeNext WAS called (handoff attempted)
    expect(queue.takeNext).toHaveBeenCalledWith(CHANNEL_ID)
    // #and — slot NOT released by the first run (transferred to the handoff)
    // (it will be released by the handoff run's own outer finally after it completes)
    // We verify release was called exactly once — by the handoff run after it drains
    expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
  })

  it('when isShuttingDown is absent (undefined), normal handoff proceeds', async () => {
    // #given — no isShuttingDown injected; queue has one pending task
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const queue = makeDefaultQueue()
    const pendingMessage = makeMessage()
    const pendingDeps = makeDeps({queue})
    const pendingTask: RunTask = {message: pendingMessage, binding: makeBinding(), deps: pendingDeps}

    ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingTask).mockReturnValue(undefined)

    const deps = makeDeps({queue})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)
    await new Promise(resolve => setTimeout(resolve, 10))

    // #then — takeNext was called (handoff proceeded normally)
    expect(queue.takeNext).toHaveBeenCalledWith(CHANNEL_ID)
  })
})

// ---------------------------------------------------------------------------
// F3: startThread throws → failure reply sent to message
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// F8: Additional handoff unit tests
// ---------------------------------------------------------------------------

describe('handoff unit tests (F8)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('mocked handoff: startRun runs for the next task; release NOT called during handoff; release IS called when takeNext returns undefined', async () => {
    // #given — first run completes; queue has one pending task
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const releaseFn = vi.fn()
    const callOrder: string[] = []

    releaseFn.mockImplementation(() => {
      callOrder.push('release')
    })
    mockRunOpenCodeCore.mockImplementation(async () => {
      callOrder.push('runOpenCodeCore')
    })

    const sharedConcurrency = {
      tryAcquire: vi.fn().mockReturnValue('ok'),
      release: releaseFn,
      activeCount: vi.fn().mockReturnValue(1),
      max: 3,
    }
    const queue = makeDefaultQueue()

    const pendingMessage = makeMessage()
    const pendingDeps = makeDeps({concurrency: sharedConcurrency, queue})
    const pendingTask: RunTask = {message: pendingMessage, binding: makeBinding(), deps: pendingDeps}

    // First takeNext returns the pending task; second returns undefined (queue empty)
    ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingTask).mockReturnValue(undefined)

    const deps = makeDeps({concurrency: sharedConcurrency, queue})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)
    await new Promise(resolve => setTimeout(resolve, 10))

    // #then — (1) startRun ran for the next task (runOpenCodeCore called twice)
    expect(callOrder.filter(e => e === 'runOpenCodeCore')).toHaveLength(2)
    // #and — (2) release NOT called during handoff (only after second run)
    const firstRunIdx = callOrder.indexOf('runOpenCodeCore')
    const secondRunIdx = callOrder.lastIndexOf('runOpenCodeCore')
    const releaseIdx = callOrder.indexOf('release')
    expect(callOrder.slice(firstRunIdx + 1, secondRunIdx)).not.toContain('release')
    // #and — (3) release IS called after takeNext returns undefined
    expect(releaseIdx).toBeGreaterThan(secondRunIdx)
    expect(releaseFn).toHaveBeenCalledExactlyOnceWith(CHANNEL_ID)
  })

  it('fIFO-gate full branch: pendingCount > 0 and enqueue returns "full" → "queue is full" reply', async () => {
    // #given — pending work exists; queue is at capacity
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const queue = makeDefaultQueue()
    ;(queue.pendingCount as ReturnType<typeof vi.fn>).mockReturnValue(1)
    ;(queue.enqueue as ReturnType<typeof vi.fn>).mockReturnValue('full')

    const deps = makeDeps({queue})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — "queue is full" reply via the FIFO-gate path
    expect(message.reply).toHaveBeenCalledOnce()
    const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
    expect(call.content).toMatch(/full/i)
    // #and — ensureClone NOT called (rejected before pipeline)
    expect(message.startThread).not.toHaveBeenCalled()
  })

  it('fIFO-gate: ensureClone not called when pendingCount > 0', async () => {
    // #given — pending work exists; slot would be free
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const ensureClone = makeEnsureCloneFn('success')
    const queue = makeDefaultQueue()
    ;(queue.pendingCount as ReturnType<typeof vi.fn>).mockReturnValue(1)
    ;(queue.enqueue as ReturnType<typeof vi.fn>).mockReturnValue('queued')

    const deps = makeDeps({queue, ensureClone})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — ensureClone NOT called (FIFO gate short-circuits before pipeline)
    expect(ensureClone).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Reaction-wiring containment
// ---------------------------------------------------------------------------
//
// These tests assert that:
//   1. Reaction calls are made at the correct lifecycle points (working on
//      start, succeeded/failed on terminal, awaiting-approval on approval-wait).
//   2. A thrown reaction mock NEVER alters the run outcome — the run still
//      completes/fails identically to the no-reaction baseline.
//   3. Reaction failures do not produce unhandled rejections.
//
// The reaction module is mocked at the module level (see top-level vi.mock above)
// so we can control whether it throws without touching the real Discord API.

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

// ---------------------------------------------------------------------------
// formatTimeoutDuration — unit tests for the exported helper
// ---------------------------------------------------------------------------

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
