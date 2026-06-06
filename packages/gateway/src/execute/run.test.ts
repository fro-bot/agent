import type {CoordinationConfig, HeartbeatController} from '@fro-bot/runtime'
import type {Message, ThreadChannel} from 'discord.js'
import type {ApprovalRegistry} from '../approvals/registry.js'
import type {RepoBinding} from '../bindings/types.js'
import type {RunMentionDeps} from './run.js'

import * as runtimeModule from '@fro-bot/runtime'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import * as coordinatorModule from '../approvals/coordinator.js'
import * as discordApprovalsModule from '../discord/approvals.js'
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
const mockCreatePermissionCoordinator = vi.mocked(coordinatorModule.createPermissionCoordinator)
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
    attachUrl: 'http://workspace:9200',
    attachToken: 'secret-bearer-token',
    runTimeoutMs: overrides.runTimeoutMs ?? 600000,
    botUserId: overrides.botUserId ?? 'bot-123',
    logger: overrides.logger ?? {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    approvalRegistry: overrides.approvalRegistry ?? makeApprovalRegistry(),
    approvalMode: overrides.approvalMode ?? 'approval-required',
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
  mockCreateDiscordStreamSink.mockReturnValue({
    append: vi.fn(),
    flush: vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 10}),
    buffered: vi.fn().mockReturnValue(''),
    markVisibleOutputSent: vi.fn(),
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

    it('ensure-clone is NOT called when channel is busy (storm guard)', async () => {
      // #given — busy fires before ensure-clone
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

      // #then — busy reply sent; ensureClone never called
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
      expect(call.content).toContain('already a task')
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
        markVisibleOutputSent: vi.fn(),
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

  // ── Approval mode propagation (Unit 2) ──────────────────────────────────

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

  // ── Unit 4: Approval wait and timeout UX ────────────────────────────────

  describe('approval wait and timeout UX (Unit 4)', () => {
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

    it('onPending: sink.markVisibleOutputSent() is called so flush cannot add _(no output)_ after approval status', async () => {
      // #given
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const markVisibleOutputSentFn = vi.fn()
      mockCreateDiscordStreamSink.mockReturnValue({
        append: vi.fn(),
        flush: vi.fn().mockResolvedValue({kind: 'sent' as const, charCount: 10}),
        buffered: vi.fn().mockReturnValue(''),
        markVisibleOutputSent: markVisibleOutputSentFn,
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

      // #then — markVisibleOutputSent was called on the sink
      expect(markVisibleOutputSentFn).toHaveBeenCalled()
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
      const runTimeoutMs = 600_000
      let callCount = 0
      const originalDateNow = Date.now.bind(Date)
      const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
        // First call: runStartMs capture at run entry → return base time
        // Subsequent calls: simulate elapsed setup time
        callCount++
        return callCount === 1 ? originalDateNow() : originalDateNow() + SIMULATED_ELAPSED_MS
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
      const runTimeoutMs = 600_000
      let callCount = 0
      const originalDateNow = Date.now.bind(Date)
      const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
        // First call: runStartMs capture at run entry → return base time
        // Subsequent calls: simulate elapsed setup time
        callCount++
        return callCount === 1 ? originalDateNow() : originalDateNow() + SIMULATED_ELAPSED_MS
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
