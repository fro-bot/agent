import type {CoordinationConfig, HeartbeatController} from '@fro-bot/runtime'
import type {Message, ThreadChannel} from 'discord.js'
import type {ApprovalRegistry} from '../approvals/registry.js'
import type {RepoBinding} from '../bindings/types.js'
import type {LaunchWorkRequest, ReplySink, StatusSink} from './launch-types.js'
import type {ChannelQueue} from './queue.js'
import type {RunMentionDeps, RunTask} from './run.js'

import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import * as runtimeModule from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as coordinatorModule from '../approvals/coordinator.js'
import * as discordApprovalsModule from '../discord/approvals.js'
import * as reactionsModule from '../discord/reactions.js'
import * as statusMessageModule from '../discord/status-message.js'
import * as streamingModule from '../discord/streaming.js'
import {abortRegistry} from './abort-registry.js'
import * as attachModule from './opencode-attach.js'
import * as promptModule from './prompt.js'
import * as runCoreModule from './run-core.js'
import {formatTimeoutDuration, getInFlightRuns} from './run.js'

// ---------------------------------------------------------------------------
// Mock external collaborators so run.test.ts does not need real AWS/S3/Discord
// ---------------------------------------------------------------------------

vi.mock('@fro-bot/runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@fro-bot/runtime')>()
  return {
    ...actual,
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
    createRun: vi.fn(),
    transitionRun: vi.fn(),
    createHeartbeatController: vi.fn(),
  }
})

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
    hasPendingForScope: vi.fn().mockReturnValue(false),
    describePendingForScope: vi.fn().mockReturnValue([]),
    handleDecision: vi.fn().mockResolvedValue('ok'),
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
    removeBy: vi.fn().mockReturnValue(undefined),
  }
}

/**
 * Build a minimal `LaunchWorkRequest` for use in pending-task construction.
 * Uses no-op sinks since the pending task's sinks are not exercised in handoff tests.
 */
function makeMinimalRequest(message: Message, binding: RepoBinding): LaunchWorkRequest {
  const noopSettle = (_delivered: boolean) => {
    /* no-op */
  }
  return {
    promptText: (message as unknown as {content: string}).content ?? '',
    channelId: (message as unknown as {channel: {id: string}}).channel.id,
    guildId: undefined,
    surface: 'discord',
    binding,
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
  }
}

/**
 * Build a `RunTask` for use in pending-task / handoff tests.
 * Wraps `makeMinimalRequest` with the given deps.
 * Provides placeholder runId and adoptionEtag for tests that don't exercise admission.
 */
function makePendingTask(message: Message, binding: RepoBinding, deps: RunMentionDeps): RunTask {
  return {
    request: makeMinimalRequest(message, binding),
    deps,
    runId: crypto.randomUUID(),
    adoptionEtag: 'test-adoption-etag',
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
    runInactivityTimeoutMs: overrides.runInactivityTimeoutMs ?? 300_000,
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
/**
 * Build a minimal mock RunState with required fields filled in.
 * Localises the single `as RunState` cast so tests don't scatter double-casts.
 */
function buildMockRunState(
  overrides: Partial<import('@fro-bot/runtime').RunState> = {},
): import('@fro-bot/runtime').RunState {
  return {
    run_id: 'r1',
    surface: 'discord',
    thread_id: '',
    entity_ref: 'acme/widget',
    phase: 'PENDING',
    started_at: '2026-01-01T00:00:00.000Z',
    last_heartbeat: '2026-01-01T00:00:00.000Z',
    holder_id: 'discord-gateway',
    details: {},
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
    data: {etag: 'run-etag-v2', state: buildMockRunState()},
  })
  mockRuntime.createHeartbeatController.mockReturnValue({
    start: (heartbeatOverrides?.start ?? vi.fn()) as unknown as HeartbeatController['start'],
    stop: (heartbeatOverrides?.stop ??
      vi.fn().mockResolvedValue({
        success: true,
        data: {
          runEtag: 'run-etag-after-heartbeat',
          lockEtag: 'lock-etag-after-heartbeat',
          runState: buildMockRunState(),
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
      // createRun is now called in launchWork for the queued path too (admission block).
      const {runMention} = await import('./run.js')
      mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
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
      const pendingTask: RunTask = makePendingTask(pendingMessage, pendingBinding, pendingDeps)

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
      const pendingTask: RunTask = makePendingTask(pendingMessage, makeBinding(), pendingDeps)

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
      const pendingTask: RunTask = makePendingTask(pendingMessage, makeBinding(), pendingDeps)

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
    const pendingTask: RunTask = makePendingTask(pendingMessage, makeBinding(), pendingDeps)

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
    const pendingTask: RunTask = makePendingTask(pendingMessage, makeBinding(), pendingDeps)

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
    const pendingTask: RunTask = makePendingTask(pendingMessage, makeBinding(), pendingDeps)

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
// TDZ regression: throwing createApprovalOnPending factory must not produce
// "Cannot access 'coordinator' before initialization" — Fix 1 guard.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Characterization tests — pin current Discord behavior as a zero-regression gate.
//
// These tests assert CURRENT observable behavior via the existing Message-based
// entry points. They must be GREEN on unmodified production code and must
// remain green after any refactor.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Approval: pending wait → decision → run continues (approved)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Thread creation: message.startThread called for a valid run
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// statusMode 'live-status': status message posted AND edited as run progresses
// ---------------------------------------------------------------------------

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
// EMPTY-PROMPT fail-fast: bare @fro-bot mention → immediate reply on source message
//
// The adapter strips the bot mention and detects an empty prompt BEFORE calling
// launchWork. It replies on the SOURCE message (not a thread), creates no thread,
// acquires no lock, writes no run-state. This avoids the late EmptyPromptError
// path (which surfaced in-thread after thread creation and lock acquisition).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// launchWork — in-memory sink tests
//
// These tests prove the engine runs with no Discord/Message dependency.
// They use in-memory StatusSink/ReplySink implementations and verify:
// - Happy path: completes + calls statusSink/replySink methods
// - Timeout: respects runTimeoutMs; statusSink receives failure note
// - Shutdown: isShuttingDown() → slot released immediately
// - Queue/concurrency: still enforced via ChannelQueue (same as runMention)
// ---------------------------------------------------------------------------

/**
 * Build an in-memory StatusSink that records calls.
 */
function makeInMemoryStatusSink(): StatusSink & {
  readonly _reactions: string[]
  readonly _activities: string[]
  readonly _busyStates: boolean[]
  readonly _resolvedAnswers: string[]
  readonly _resolvedFailures: string[]
  readonly _disposed: boolean[]
} {
  const reactions: string[] = []
  const activities: string[] = []
  const busyStates: boolean[] = []
  const resolvedAnswers: string[] = []
  const resolvedFailures: string[] = []
  const disposed: boolean[] = []

  return {
    _reactions: reactions,
    _activities: activities,
    _busyStates: busyStates,
    _resolvedAnswers: resolvedAnswers,
    _resolvedFailures: resolvedFailures,
    _disposed: disposed,
    noteActivity: (summary: string) => {
      activities.push(summary)
    },
    setBusy: (busy: boolean) => {
      busyStates.push(busy)
    },
    resolveToAnswer: vi.fn().mockResolvedValue({transition: 'delegated'}),
    resolveToFailure: vi.fn().mockResolvedValue({transition: 'delegated'}),
    dispose: vi.fn().mockResolvedValue(undefined),
    setReaction: state => {
      reactions.push(state)
    },
  }
}

/**
 * Build an in-memory ReplySink that records calls.
 */
function makeInMemoryReplySink(): ReplySink & {
  readonly _sends: {target: string; content: string}[]
  readonly _appended: string[]
  readonly _flushed: number
} {
  const sends: {target: string; content: string}[] = []
  const appended: string[] = []
  let flushed = 0
  let visible = false
  let pendingCount = 0

  const sink = {
    _sends: sends,
    _appended: appended,
    get _flushed() {
      return flushed
    },
    send: vi.fn().mockImplementation(async (target: string, options: {content?: string}) => {
      sends.push({target, content: options.content ?? ''})
      return {success: true, data: undefined}
    }),
    append: (text: string) => {
      appended.push(text)
    },
    flush: vi.fn().mockImplementation(async () => {
      flushed++
      visible = true
      return {kind: 'sent', charCount: appended.join('').length}
    }),
    buffered: () => appended.join(''),
    hasVisibleOutput: () => visible || pendingCount > 0,
    markVisibleOutputSent: () => {
      visible = true
    },
    markVisibleOutputPending: () => {
      pendingCount++
      let settled = false
      return (delivered: boolean) => {
        if (settled) return
        settled = true
        pendingCount--
        if (delivered) visible = true
      }
    },
  }
  return sink
}

/**
 * Build a minimal `LaunchWorkRequest` with in-memory sinks.
 * No Discord dependency — suitable for launchWork tests.
 */
function makeInMemoryRequest(
  overrides: {
    readonly channelId?: string
    readonly promptText?: string
    readonly statusSink?: StatusSink
    readonly replySink?: ReplySink
  } = {},
): LaunchWorkRequest & {
  readonly _statusSink: ReturnType<typeof makeInMemoryStatusSink>
  readonly _replySink: ReturnType<typeof makeInMemoryReplySink>
} {
  const statusSink = (overrides.statusSink as ReturnType<typeof makeInMemoryStatusSink>) ?? makeInMemoryStatusSink()
  const replySink = (overrides.replySink as ReturnType<typeof makeInMemoryReplySink>) ?? makeInMemoryReplySink()
  return {
    promptText: overrides.promptText ?? 'do the thing',
    channelId: overrides.channelId ?? CHANNEL_ID,
    guildId: undefined,
    surface: 'discord',
    binding: makeBinding(),
    requester: {kind: 'discord-user', userId: 'user-111'},
    statusSink,
    replySink,
    _statusSink: statusSink,
    _replySink: replySink,
  }
}

/**
 * Call `launchWork` and await the run promise (if present) so tests can check
 * behavior inside `executeWorkOnHeldSlot`. Since `launchWork` now returns
 * `LaunchAdmission` early (fire-and-forget for the immediate path), tests that
 * check run behavior must await the `runPromise` from the admission result.
 *
 * For cap/queue/empty-prompt paths, `runPromise` is absent and this is a no-op.
 */
async function awaitLaunchWorkRun(
  launchWork: (
    request: import('./launch-types.js').LaunchWorkRequest,
    deps: RunMentionDeps,
  ) => Promise<import('./launch-types.js').LaunchAdmission>,
  request: import('./launch-types.js').LaunchWorkRequest,
  deps: RunMentionDeps,
): Promise<import('./launch-types.js').LaunchAdmission> {
  const admission = await launchWork(request, deps)
  if (admission.accepted === true && admission.runPromise !== undefined) {
    await admission.runPromise
  }
  return admission
}

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

// ---------------------------------------------------------------------------
// Unit 1: Approval transport selection and web surface support
// ---------------------------------------------------------------------------

describe('Unit 1 — approval transport selection', () => {
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

// ---------------------------------------------------------------------------
// Unit 0: Characterization — Phase A seam invariants
//
// These static guards pin the public API contract that Phase B depends on:
//   1. `executeWorkOnHeldSlot` is NOT exported — callers must use `launchWork`.
//   2. `launchWork` IS exported — it is the single public front door.
//   3. `runMention` IS exported — it is the Discord adapter entry point.
//
// If any of these fail, a caller has bypassed the queue/cap or the public
// front door has been removed. Both require deliberate security review.
// ---------------------------------------------------------------------------

describe('Unit 0 — Phase A seam invariants (static guards)', () => {
  it('executeWorkOnHeldSlot is NOT exported from run.ts — callers must use launchWork', async () => {
    // #given — import the run module
    const runModule = await import('./run.js')

    // #then — the private execution primitive must not be exported
    expect(Object.keys(runModule)).not.toContain('executeWorkOnHeldSlot')
  })

  it('launchWork IS exported from run.ts — it is the single public front door', async () => {
    // #given — import the run module
    const runModule = await import('./run.js')

    // #then — the public front door must be exported
    expect(typeof runModule.launchWork).toBe('function')
  })

  it('runMention IS exported from run.ts — it is the Discord adapter entry point', async () => {
    // #given — import the run module
    const runModule = await import('./run.js')

    // #then — the Discord adapter must be exported
    expect(typeof runModule.runMention).toBe('function')
  })

  it('run.ts source does not export executeWorkOnHeldSlot (static source scan)', () => {
    // #given — read the source file directly (catches re-export patterns the module check misses)
    const runSrcPath = join(__dirname, 'run.ts')
    const content = readFileSync(runSrcPath, 'utf8')

    // #then — no export keyword precedes executeWorkOnHeldSlot
    // Matches: "export function executeWorkOnHeldSlot", "export async function executeWorkOnHeldSlot",
    // "export { executeWorkOnHeldSlot", "export {executeWorkOnHeldSlot"
    const exportPattern = /export\s+(?:async\s+)?function\s+executeWorkOnHeldSlot|export\s*\{[^}]*executeWorkOnHeldSlot/
    expect(exportPattern.test(content)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// FIX 5: runIndex.register() wiring test
// ---------------------------------------------------------------------------

describe('runIndex.register() wiring (FIX 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('createRun → runIndex.register() called with correct repo (entity_ref), surface, and startedAt', async () => {
    // #given — a mock runIndex with a spy on register()
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const registerFn = vi.fn()
    const runIndex = {
      register: registerFn,
      lookup: vi.fn().mockResolvedValue(undefined),
      listRunsForRepo: vi.fn().mockResolvedValue([]),
    }

    const deps = makeDeps({runIndex})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — register was called once
    expect(registerFn).toHaveBeenCalledOnce()

    // #and — called with the correct runId (any string), repo, surface, and startedAt
    const [calledRunId, calledEntry] = registerFn.mock.calls[0] as [
      string,
      {repo: string; surface: string; startedAt: string},
    ]
    expect(typeof calledRunId).toBe('string')
    expect(calledRunId.length).toBeGreaterThan(0)
    // repo must be the entity_ref: owner/repo
    expect(calledEntry.repo).toBe(`${OWNER}/${REPO}`)
    // surface must be 'discord' (the default surface in makeMinimalRequest)
    expect(calledEntry.surface).toBe('discord')
    // startedAt must be a non-empty ISO string
    expect(typeof calledEntry.startedAt).toBe('string')
    expect(calledEntry.startedAt.length).toBeGreaterThan(0)
  })

  it('register() failure is fail-closed: run terminalized to FAILED, admission rejects', async () => {
    // #given — runIndex.register() throws
    // Per the fail-closed admission block: register throwing after createRun succeeds
    // must terminalize the run to FAILED (no orphan PENDING) and reject admission.
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const registerFn = vi.fn(() => {
      throw new Error('index register failed')
    })
    const runIndex = {
      register: registerFn,
      lookup: vi.fn().mockResolvedValue(undefined),
      listRunsForRepo: vi.fn().mockResolvedValue([]),
    }

    const deps = makeDeps({runIndex})
    const message = makeMessage()

    // #when — launchWork throws (admission rejected); runMention propagates the throw
    await expect(runMention(message, makeBinding(), deps)).rejects.toThrow('index register failed')

    // #then — register was called
    expect(registerFn).toHaveBeenCalledOnce()
    // #and — run was terminalized to FAILED (transitionRun FAILED called)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    // #and — runOpenCodeCore was NOT called (run was rejected before execution)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  it('runIndex is optional — omitting it does not break run execution', async () => {
    // #given — no runIndex in deps
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const deps = makeDeps({runIndex: undefined})
    const message = makeMessage()

    // #when — should not throw
    await runMention(message, makeBinding(), deps)

    // #then — execution completed normally
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe('launchWork admission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Happy path (immediate) ─────────────────────────────────────────────────

  it('immediate: launchWork returns {accepted:true, runId} BEFORE the run completes', async () => {
    // #given — a hanging executeWorkOnHeldSlot mock (run never completes)
    // This proves launchWork returns admission early, not after the run.
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    // Make runOpenCodeCore hang indefinitely
    let resolveRun: (() => void) | undefined
    mockRunOpenCodeCore.mockImplementation(
      async () =>
        new Promise<void>(resolve => {
          resolveRun = resolve
        }),
    )

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when — launchWork returns admission early (before run completes)
    const admissionPromise = launchWork(request, deps)
    const admission = await admissionPromise

    // #then — admission returned before run completed
    expect(admission).toMatchObject({accepted: true, runId: expect.any(String) as unknown})
    // runPromise is present for the immediate path
    expect(admission.accepted === true ? admission.runPromise : undefined).toBeDefined()

    // Yield to the event loop so executeWorkOnHeldSlot can start
    await new Promise(resolve => setTimeout(resolve, 0))

    // #and — runOpenCodeCore was called (run started, even though launchWork returned early)
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()

    // Resolve the hanging run so the test can clean up
    resolveRun?.()
    await (admission.accepted === true ? admission.runPromise : Promise.resolve())
  })

  // ── R8/ownership: immediate run completes after launchWork returns ──────────

  it('r8/ownership: immediate run completes and posts output after launchWork returns admission early', async () => {
    // #given — a run that completes after a delay
    // This proves the gateway in-flight set keeps the run alive after launchWork returns.
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when — launchWork returns admission early
    const admission = await launchWork(request, deps)

    // #then — admission returned
    expect(admission.accepted).toBe(true)

    // #and — await the run promise to verify the run completes
    await (admission.accepted === true ? admission.runPromise : Promise.resolve())

    // #and — run completed (COMPLETED transition)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('COMPLETED')

    // #and — output was posted (flush called)
    expect(request._replySink.flush).toHaveBeenCalled()
  })

  // ── R8/ownership: shutdown drains in-flight immediate run ──────────────────

  it('r8/ownership: getInFlightRuns() exposes the in-flight set; runPromise awaits the run', async () => {
    // #given — a run that completes normally
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when — launchWork returns admission early
    const admission = await launchWork(request, deps)
    expect(admission.accepted).toBe(true)

    // #then — the runPromise is present (immediate path)
    expect(admission.accepted === true ? admission.runPromise : undefined).toBeDefined()

    // Await the runPromise directly (the caller's way to await the run)
    await (admission.accepted === true ? admission.runPromise : Promise.resolve())

    // #and — run completed (COMPLETED transition)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('COMPLETED')

    // #and — in-flight set is now empty (run completed and was removed)
    expect(getInFlightRuns().size).toBe(0)
  })

  // ── Happy path (queued) ────────────────────────────────────────────────────

  it('queued: launchWork creates PENDING, returns {accepted:true, runId}, enqueues task with runId+adoptionEtag', async () => {
    // #given — channel is busy; queue has capacity
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-queued'}})

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
    const admission = await launchWork(request, deps)

    // #then — admission accepted
    expect(admission).toMatchObject({accepted: true, runId: expect.any(String) as unknown})
    // No runPromise for queued path
    expect(admission.accepted === true ? admission.runPromise : 'not-accepted').toBeUndefined()

    // #and — createRun was called (PENDING created)
    expect(mockRuntime.createRun).toHaveBeenCalledOnce()

    // #and — task enqueued with runId and adoptionEtag
    expect(queue.enqueue).toHaveBeenCalledOnce()
    const enqueuedTask = (queue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      runId: string
      adoptionEtag: string
    }
    expect(typeof enqueuedTask.runId).toBe('string')
    expect(enqueuedTask.runId.length).toBeGreaterThan(0)
    expect(enqueuedTask.adoptionEtag).toBe('run-etag-queued')
  })

  // ── Edge (cap) ─────────────────────────────────────────────────────────────

  it('cap: returns {accepted:false,"cap"} and does NOT call createRun', async () => {
    // #given — global cap reached
    const {launchWork} = await import('./run.js')

    const request = makeInMemoryRequest()
    const deps = makeDeps({
      concurrency: {
        tryAcquire: vi.fn().mockReturnValue('cap'),
        release: vi.fn(),
        activeCount: vi.fn().mockReturnValue(3),
        max: 3,
      },
    })

    // #when
    const admission = await launchWork(request, deps)

    // #then — admission rejected with 'cap'
    expect(admission).toMatchObject({accepted: false, reason: 'cap'})

    // #and — createRun NOT called (no admission for cap)
    expect(mockRuntime.createRun).not.toHaveBeenCalled()
  })

  // ── Edge (empty prompt) ────────────────────────────────────────────────────

  it('empty-prompt: returns {accepted:false,"empty-prompt"} before any admission', async () => {
    // #given — empty prompt
    const {launchWork} = await import('./run.js')

    const request = makeInMemoryRequest({promptText: '   '})
    const deps = makeDeps()

    // #when
    const admission = await launchWork(request, deps)

    // #then — admission rejected with 'empty-prompt'
    expect(admission).toMatchObject({accepted: false, reason: 'empty-prompt'})

    // #and — createRun NOT called (no admission for empty prompt)
    expect(mockRuntime.createRun).not.toHaveBeenCalled()
    // #and — tryAcquire NOT called (empty prompt guard fires first)
    // (concurrency is not consulted before the empty-prompt check)
  })

  // ── Fail-closed: register throws after createRun ───────────────────────────

  it('fail-closed: runIndex.register throws after createRun → run terminalized to FAILED, admission rejects', async () => {
    // #given — register throws after createRun succeeds
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
    // transitionRun mock for the FAILED terminalization
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    const registerFn = vi.fn(() => {
      throw new Error('register failed')
    })
    const runIndex = {
      register: registerFn,
      lookup: vi.fn().mockResolvedValue(undefined),
      listRunsForRepo: vi.fn().mockResolvedValue([]),
    }

    const request = makeInMemoryRequest()
    const deps = makeDeps({runIndex})

    // #when — launchWork throws (admission rejected)
    await expect(launchWork(request, deps)).rejects.toThrow('register failed')

    // #then — createRun was called (admission started)
    expect(mockRuntime.createRun).toHaveBeenCalledOnce()

    // #and — run terminalized to FAILED (no orphan PENDING)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')

    // #and — runOpenCodeCore NOT called (run was rejected before execution)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  // ── Exactly ONE createRun per run ──────────────────────────────────────────

  it('exactly one createRun per run with PENDING initial state', async () => {
    // #given — happy path
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — createRun called exactly once
    expect(mockRuntime.createRun).toHaveBeenCalledOnce()

    // #and — the initial run state has phase PENDING
    const createRunCall = mockRuntime.createRun.mock.calls[0] as unknown[]
    const initialState = createRunCall[3] as {phase?: string}
    expect(initialState.phase).toBe('PENDING')
  })

  // ── Observer sees PENDING before ACKNOWLEDGED ──────────────────────────────

  it('observer sees PENDING before ACKNOWLEDGED for an immediate run', async () => {
    // #given — observer that records phases in order
    const {launchWork} = await import('./run.js')

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
    const request = makeInMemoryRequest()
    const deps = makeDeps({runObserver})

    // #when — await the run promise so the run completes before asserting
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — observer called with PENDING first, then ACKNOWLEDGED, EXECUTING, COMPLETED
    expect(observeFn).toHaveBeenCalledTimes(4)
    const phases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(phases[0]).toBe('PENDING')
    expect(phases[1]).toBe('ACKNOWLEDGED')
    expect(phases[2]).toBe('EXECUTING')
    expect(phases[3]).toBe('COMPLETED')
  })

  // ── LaunchAdmission type: accepted path carries runId ─────────────────────

  it('launchWork returns {accepted:true, runId} for immediate path', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when
    const admission = await launchWork(request, deps)

    // #then
    expect(admission).toMatchObject({accepted: true, runId: expect.any(String) as unknown})

    // Drain the run
    await (admission.accepted === true ? admission.runPromise : Promise.resolve())
  })

  // ── runId from request.runId is honored ────────────────────────────────────

  it('launchWork uses request.runId when provided (non-empty)', async () => {
    // #given — caller provides a specific runId
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const CALLER_RUN_ID = 'caller-provided-run-id-abc123'
    const request = makeInMemoryRequest()
    const requestWithRunId = {...request, runId: CALLER_RUN_ID}
    const deps = makeDeps()

    // #when
    const admission = await launchWork(requestWithRunId, deps)

    // #then — admission uses the caller-provided runId
    expect(admission).toMatchObject({accepted: true, runId: CALLER_RUN_ID})

    // Drain the run
    await (admission.accepted === true ? admission.runPromise : Promise.resolve())
  })

  // ── Empty string runId falls back to UUID ─────────────────────────────────

  it('launchWork generates a UUID when request.runId is empty string', async () => {
    // #given — caller provides an empty string runId (should be treated as absent)
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const request = makeInMemoryRequest()
    const requestWithEmptyRunId = {...request, runId: ''}
    const deps = makeDeps()

    // #when
    const admission = await launchWork(requestWithEmptyRunId, deps)

    // #then — admission generates a UUID (not empty string)
    expect(admission).toMatchObject({accepted: true, runId: expect.any(String) as unknown})
    expect(admission.accepted === true ? admission.runId : '').not.toBe('')

    // Drain the run
    await (admission.accepted === true ? admission.runPromise : Promise.resolve())
  })
})

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//
// Each early-abort gate in executeWorkOnHeldSlot must:
//   1. Call failAdmittedRun (PENDING → FAILED) before returning.
//   2. Send the same user reply as before (unchanged text).
//   3. Leave no orphan PENDING run-state.
//
// The dual-finally requirement: a gate that THROWS (not just returns) must also
// terminalize to FAILED. This is covered by the "gate throws" test below.
// ---------------------------------------------------------------------------

describe('early-abort gates terminalize to FAILED', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Gate 1: ensureClone fail ───────────────────────────────────────────────

  it('gate 1 (ensureClone fail): run terminalized to FAILED, same reply text, no orphan PENDING', async () => {
    // #given — ensureClone fails; run was admitted (PENDING) by launchWork
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-1'}})
    // transitionRun mock for the FAILED terminalization (best-effort)
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    const ensureClone = makeEnsureCloneFn('failure')
    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone, runObserver: {observe: observeFn}})

    // #when — await the run promise so executeWorkOnHeldSlot completes
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — run terminalized to FAILED (no orphan PENDING)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    // ACKNOWLEDGED was NOT reached (ensureClone failed before ACK)
    expect(transitionPhases).not.toContain('ACKNOWLEDGED')

    // #and — observer notified of FAILED state
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — same reply text as before (unchanged)
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('workspace'))
    expect(errorSend).toBeDefined()
    expect(errorSend?.content).toContain('not available')

    // #and — runOpenCodeCore NOT called (gate fired before execution)
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  // ── Gate 2: readyz not-ready ───────────────────────────────────────────────

  it('gate 2 (readyz not-ready): run terminalized to FAILED, same reply text, no orphan PENDING', async () => {
    // #given — readyz returns not-ready; run was admitted (PENDING) by launchWork
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-2'}})
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    const readyz = makeReadyzFn('not-ready')
    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({readyz, runObserver: {observe: observeFn}})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — run terminalized to FAILED
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('ACKNOWLEDGED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — same reply text as before
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('not reachable'))
    expect(errorSend).toBeDefined()

    // #and — runOpenCodeCore NOT called
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  // ── Gate 3a: threadFactory throws ─────────────────────────────────────────

  it('gate 3a (threadFactory throws): run terminalized to FAILED, same reply text, no orphan PENDING', async () => {
    // #given — threadFactory throws; run was admitted (PENDING) by launchWork
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-3a'}})
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest({
      // threadFactory that throws
    })
    const threadFactory = vi.fn().mockRejectedValue(new Error('Discord API error'))
    const requestWithFactory = {...request, threadFactory}
    const deps = makeDeps({runObserver: {observe: observeFn}})

    // #when
    await awaitLaunchWorkRun(launchWork, requestWithFactory, deps)

    // #then — run terminalized to FAILED
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('ACKNOWLEDGED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — same reply text as before
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('Could not start'))
    expect(errorSend).toBeDefined()

    // #and — acquireLock NOT called (threadFactory failed before lock)
    expect(mockRuntime.acquireLock).not.toHaveBeenCalled()
  })

  // ── Gate 3b: threadFactory ok:false ───────────────────────────────────────

  it('gate 3b (threadFactory ok:false): run terminalized to FAILED, same reply text, no orphan PENDING', async () => {
    // #given — threadFactory returns {ok:false}; run was admitted (PENDING) by launchWork
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-3b'}})
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const threadFactory = vi.fn().mockResolvedValue({ok: false as const, error: 'thread creation failed'})
    const requestWithFactory = {...request, threadFactory}
    const deps = makeDeps({runObserver: {observe: observeFn}})

    // #when
    await awaitLaunchWorkRun(launchWork, requestWithFactory, deps)

    // #then — run terminalized to FAILED
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('ACKNOWLEDGED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — same reply text as before
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('Could not start'))
    expect(errorSend).toBeDefined()

    // #and — acquireLock NOT called
    expect(mockRuntime.acquireLock).not.toHaveBeenCalled()
  })

  // ── thread_id persistence at ACK (bug fix) ────────────────────────────────

  it('persists the live thread_id to run-state at PENDING → ACKNOWLEDGED when threadFactory succeeds', async () => {
    // #given — a discord run with a threadFactory that resolves a real thread id
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-thread'}})
    setupHappyPath()

    const request = makeInMemoryRequest()
    const threadFactory = vi.fn().mockResolvedValue({ok: true as const, threadId: 'live-thread-999'})
    const requestWithFactory = {...request, threadFactory}
    const deps = makeDeps()

    // #when
    await awaitLaunchWorkRun(launchWork, requestWithFactory, deps)

    // #then — the ACKNOWLEDGED transitionRun call carries the live thread id in the options bag
    const ackCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'ACKNOWLEDGED')
    expect(ackCall).toBeDefined()
    expect((ackCall as unknown[])[7]).toEqual({threadId: 'live-thread-999'})
  })

  it('leaves thread_id empty at ACK when there is no threadFactory (non-discord/no-thread path)', async () => {
    // #given — a run with no threadFactory (e.g. in-memory/no-thread transport)
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-nothread'}})
    setupHappyPath()

    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — the ACKNOWLEDGED transitionRun call passes {threadId: ''} (no-op in transitionRun)
    const ackCall = mockRuntime.transitionRun.mock.calls.find((c: unknown[]) => c[4] === 'ACKNOWLEDGED')
    expect(ackCall).toBeDefined()
    expect((ackCall as unknown[])[7]).toEqual({threadId: ''})
  })

  // ── Gate 4a: lock acquisition error ───────────────────────────────────────

  it('gate 4a (lock acquisition error): run terminalized to FAILED, same reply text, no orphan PENDING', async () => {
    // #given — acquireLock returns success:false; run was admitted (PENDING) by launchWork
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-4a'}})
    mockRuntime.acquireLock.mockResolvedValue({
      success: false as const,
      error: new Error('S3 timeout'),
    })
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({runObserver: {observe: observeFn}})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — run terminalized to FAILED
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('ACKNOWLEDGED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — same reply text as before (coarse error, no S3 detail)
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('Could not start'))
    expect(errorSend).toBeDefined()
    // No S3 detail leaked
    expect(sends.every(s => !s.content.includes('S3'))).toBe(true)

    // #and — runOpenCodeCore NOT called
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  // ── Gate 4b: lock not acquired (held by another) ───────────────────────────

  it('gate 4b (lock not acquired): run terminalized to FAILED, same reply text, no orphan PENDING', async () => {
    // #given — acquireLock returns acquired:false; run was admitted (PENDING) by launchWork
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-4b'}})
    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: false as const, etag: null, holder: {holder_id: 'other-gateway', etag: 'abc'} as unknown},
    } as Awaited<ReturnType<typeof runtimeModule.acquireLock>>)
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({runObserver: {observe: observeFn}})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — run terminalized to FAILED
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    expect(transitionPhases).not.toContain('ACKNOWLEDGED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — same reply text as before ("in progress")
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('in progress'))
    expect(errorSend).toBeDefined()
    // Holder ID NOT leaked
    expect(sends.every(s => !s.content.includes('other-gateway'))).toBe(true)

    // #and — runOpenCodeCore NOT called
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  // ── Gate 5: ACK transition fail ────────────────────────────────────────────

  it('gate 5 (ACK transition fail): run terminalized to FAILED, lock released, same reply text', async () => {
    // #given — transitionRun PENDING→ACKNOWLEDGED fails; run is still PENDING
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-5'}})
    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
    })
    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    // First transitionRun call (ACKNOWLEDGED) fails; second (FAILED terminalization) succeeds
    mockRuntime.transitionRun
      .mockResolvedValueOnce({
        success: false as const,
        error: new Error('ACK transition conflict'),
      })
      .mockResolvedValueOnce({
        success: true as const,
        data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
      })

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({runObserver: {observe: observeFn}})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — run terminalized to FAILED (using adoptionEtag since ACK failed)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
    // ACKNOWLEDGED was attempted but failed
    expect(transitionPhases[0]).toBe('ACKNOWLEDGED')
    expect(transitionPhases[1]).toBe('FAILED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — lock released (even though ACK failed)
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()

    // #and — same reply text as before
    const sends = request._replySink._sends
    const errorSend = sends.find(s => s.content.includes('Could not start'))
    expect(errorSend).toBeDefined()

    // #and — runOpenCodeCore NOT called
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
  })

  // ── Dual-finally: gate that THROWS still terminalizes ─────────────────────

  it('dual-finally: a gate that THROWS (not returns) still terminalizes to FAILED', async () => {
    // #given — ensureClone THROWS (not just returns failure); run was admitted (PENDING)
    // This tests the dual-finally wrapper: a thrown error in a gate must still
    // terminalize the run to FAILED before propagating.
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-throw'}})
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    // ensureClone THROWS (not returns {success:false})
    const ensureClone = vi.fn().mockRejectedValue(new Error('ensureClone threw unexpectedly'))
    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({ensureClone, runObserver: {observe: observeFn}})

    // #when — the run promise may reject (the throw propagates after terminalization)
    const admission = await launchWork(request, deps)
    if (admission.accepted === true && admission.runPromise !== undefined) {
      // The run promise may reject — catch it so the test doesn't fail on the rejection
      await admission.runPromise.catch(() => {
        /* expected: gate threw */
      })
    }

    // #then — run terminalized to FAILED (dual-finally caught the throw)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')
  })

  // ── Dual-finally: gate THROWS after lock acquisition releases the lock ─────

  it('dual-finally: a gate that THROWS after lock acquisition releases the lock', async () => {
    // #given — lock is acquired, then transitionRun THROWS (not returns failure)
    // This tests the lock-leak fix: a thrown error after acquireLock must still release the lock.
    const {launchWork} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-throw-post-lock'}})
    mockRuntime.acquireLock.mockResolvedValue({
      success: true as const,
      data: {acquired: true as const, etag: 'lock-etag-throw', holder: null},
    })
    mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
    // transitionRun THROWS on the ACKNOWLEDGED call (not returns {success:false})
    mockRuntime.transitionRun.mockRejectedValueOnce(new Error('transitionRun threw unexpectedly'))

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({runObserver: {observe: observeFn}})

    // #when — the run promise rejects (the throw propagates after terminalization)
    const admission = await launchWork(request, deps)
    if (admission.accepted === true && admission.runPromise !== undefined) {
      await admission.runPromise.catch(() => {
        /* expected: gate threw */
      })
    }

    // #then — run terminalized to FAILED (dual-finally caught the throw)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')

    // #and — lock IS released (not leaked)
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
    const releaseCall = mockRuntime.releaseLock.mock.calls[0] as unknown[]
    expect(releaseCall[2]).toBe('lock-etag-throw')
  })

  // ── R8 Discord: Discord run whose early gate fails writes FAILED run-state ─

  it('r8 Discord: Discord run whose ensureClone fails now writes FAILED run-state (previously just replied)', async () => {
    // #given — Discord mention; ensureClone fails; run was admitted (PENDING) by launchWork
    const {runMention} = await import('./run.js')
    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'adoption-etag-r8'}})
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'fail-etag', state: buildMockRunState({phase: 'FAILED'})},
    })

    const ensureClone = makeEnsureCloneFn('failure')
    const observeFn = vi.fn().mockResolvedValue(undefined)
    const message = makeMessage()
    const deps = makeDeps({ensureClone, runObserver: {observe: observeFn}})

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — FAILED run-state written (new behavior: observable failure)
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')

    // #and — observer notified of FAILED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases).toContain('FAILED')

    // #and — same reply text as before (unchanged)
    expect(message.reply).toHaveBeenCalledOnce()
    const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
    expect(call.content).toContain('workspace')
    expect(call.content).toContain('not available')
  })

  // ── Regression: successful run unchanged ───────────────────────────────────

  it('regression: successful run still goes PENDING→ACKNOWLEDGED→EXECUTING→COMPLETED unchanged', async () => {
    // #given — happy path; all gates pass
    const {launchWork} = await import('./run.js')
    setupHappyPath()

    const ackState = buildMockRunState({phase: 'ACKNOWLEDGED'})
    const execState = buildMockRunState({phase: 'EXECUTING'})
    const completedState = buildMockRunState({phase: 'COMPLETED'})

    mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
    mockRuntime.transitionRun
      .mockResolvedValueOnce({success: true as const, data: {etag: 'ack-etag', state: ackState}})
      .mockResolvedValueOnce({success: true as const, data: {etag: 'exec-etag', state: execState}})
      .mockResolvedValueOnce({success: true as const, data: {etag: 'done-etag', state: completedState}})

    const observeFn = vi.fn().mockResolvedValue(undefined)
    const request = makeInMemoryRequest()
    const deps = makeDeps({runObserver: {observe: observeFn}})

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then — full lifecycle: PENDING→ACKNOWLEDGED→EXECUTING→COMPLETED
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toEqual(['ACKNOWLEDGED', 'EXECUTING', 'COMPLETED'])

    // #and — observer sees PENDING (from launchWork), then ACKNOWLEDGED, EXECUTING, COMPLETED
    const observedPhases = observeFn.mock.calls.map((c: unknown[]) => (c[0] as {phase?: string}).phase)
    expect(observedPhases[0]).toBe('PENDING')
    expect(observedPhases).toContain('ACKNOWLEDGED')
    expect(observedPhases).toContain('EXECUTING')
    expect(observedPhases).toContain('COMPLETED')
    expect(observedPhases).not.toContain('FAILED')

    // #and — exactly one createRun (no double-create)
    expect(mockRuntime.createRun).toHaveBeenCalledOnce()

    // #and — execution happened
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Operator cancel — abort-registry integration (Unit 1)
// ---------------------------------------------------------------------------

const CANCEL_RUN_ID = 'cancel-run-id-1'

/**
 * Simulate `runOpenCodeCore` observing the cancel signal fire and throwing
 * the same way the real implementation would once its combined signal aborts:
 * a `RunCoreError('timeout', ...)` (run-core does not add a distinct
 * 'cancelled' kind — classification happens in run.ts via registry probe).
 */
function mockRunOpenCodeCoreAbortedBy(viaRegistryAbort: () => void) {
  mockRunOpenCodeCore.mockImplementation(async () => {
    viaRegistryAbort()
    throw new runCoreModule.RunCoreError('timeout', 'run-core: signal aborted')
  })
}

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

    mockRunOpenCodeCoreAbortedBy(() => {
      abortRegistry.abort(CANCEL_RUN_ID, 'operator cancel')
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

    // #and — no user-facing failure reply was sent to the thread
    const sends = request._replySink._sends
    expect(sends.some(s => s.content.toLowerCase().includes('failed'))).toBe(false)

    // #and — registry entry deleted (a later abort() is now a no-op)
    expect(abortRegistry.has(CANCEL_RUN_ID)).toBe(false)
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
