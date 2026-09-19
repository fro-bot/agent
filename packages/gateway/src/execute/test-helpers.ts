import type {CoordinationConfig, HeartbeatController, RunState} from '@fro-bot/runtime'
import type {Message, ThreadChannel} from 'discord.js'
import type {ApprovalRegistry} from '../approvals/registry.js'
import type {RepoBinding} from '../bindings/types.js'
import type {LaunchWorkRequest, ReplySink, StatusSink} from './launch-types.js'
import type {ChannelQueue} from './queue.js'
import type {RunMentionDeps, RunTask} from './run.js'

import * as runtimeModule from '@fro-bot/runtime'
import {err, ok} from '@fro-bot/runtime'
import {vi} from 'vitest'
import * as coordinatorModule from '../approvals/coordinator.js'
import * as discordApprovalsModule from '../discord/approvals.js'
import * as statusMessageModule from '../discord/status-message.js'
import * as streamingModule from '../discord/streaming.js'
import * as attachModule from './opencode-attach.js'
import * as promptModule from './prompt.js'
import * as runCoreModule from './run-core.js'

// ---------------------------------------------------------------------------
// Shared test setup for the run.test.ts split. Mocks external collaborators so
// the split test files do not need real AWS/S3/Discord. This module is
// imported (not copy-pasted) by every sibling `run.*.test.ts` file so there is
// exactly one copy of these fixtures and mocks — divergent copies are how
// these suites rot.
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
    addOwnedSession: vi.fn(),
    isOwned: vi.fn().mockReturnValue(true),
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
    readonly quarantined: boolean
    constructor(kind: string, message: string, quarantined = false) {
      super(message)
      this.kind = kind
      this.quarantined = quarantined
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

export const mockRuntime = vi.mocked(runtimeModule)
export const mockRunOpenCodeCore = vi.mocked(runCoreModule.runOpenCodeCore)
export const mockCreateDiscordStreamSink = vi.mocked(streamingModule.createDiscordStreamSink)
export const mockCreatePermissionCoordinator = vi.mocked(coordinatorModule.createPermissionCoordinator)
export const mockCreateStatusController = vi.mocked(statusMessageModule.createStatusController)
vi.mocked(discordApprovalsModule) // ensure module mock is applied

// NOTE: `attachModule`/`promptModule`/`runCoreModule`/etc. are intentionally NOT
// re-exported here. Vitest's `vi.mock()` hoisting mocks a module for every
// direct importer within a test file's module graph, but re-exporting a
// mocked namespace import through this module does not reliably forward the
// live binding to consumers — it was observed to arrive `undefined` at the
// call site despite working fine inside this file. Files that need to
// dereference these namespaces at runtime (not just in a type position)
// should import them directly from their real module path themselves; the
// `vi.mock()` calls above still apply since they run before those imports
// are evaluated as long as this helpers module is imported first.
export {runtimeModule}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

export const CHANNEL_ID = 'ch-test'
export const OWNER = 'acme'
export const REPO = 'widget'

export function makeBinding(): RepoBinding {
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

export function makeThread(): ThreadChannel & {send: ReturnType<typeof vi.fn>} {
  const sendFn = vi.fn(async (opts: unknown) => opts)
  return {
    id: 'thread-99',
    send: sendFn,
  } as unknown as ThreadChannel & {send: ReturnType<typeof vi.fn>}
}

export function makeMessage(thread?: ReturnType<typeof makeThread>): Message & {
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

export function makeApprovalRegistry(): ApprovalRegistry {
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

export function makeDefaultConcurrency() {
  return {
    tryAcquire: vi.fn().mockReturnValue('ok'),
    release: vi.fn(),
    activeCount: vi.fn().mockReturnValue(1),
    max: 3,
  }
}

export function makeDefaultQueue(): ChannelQueue<RunTask> {
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
export function makeMinimalRequest(message: Message, binding: RepoBinding): LaunchWorkRequest {
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
export function makePendingTask(message: Message, binding: RepoBinding, deps: RunMentionDeps): RunTask {
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
export function makeStreamSinkMock(
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
export function makeStatefulSinkMock(
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
export function makeStatefulPendingSinkMock() {
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
export function makeStatusControllerMock(
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

export function makeEnsureCloneFn(result: 'success' | 'failure' = 'success') {
  return result === 'success'
    ? vi.fn().mockResolvedValue({success: true as const, data: '/workspace/acme/widget'})
    : vi.fn().mockResolvedValue({
        success: false as const,
        error: {kind: 'workspace-failure' as const, workspaceKind: 'network-error' as const},
      })
}

export function makeReadyzFn(result: 'ready' | 'not-ready' | 'throws' = 'ready') {
  if (result === 'throws') {
    return vi.fn().mockRejectedValue(new Error('readyz threw'))
  }
  return result === 'ready'
    ? vi.fn().mockResolvedValue({success: true as const, data: {ready: true, opencode: 'ready'}})
    : vi.fn().mockResolvedValue({success: true as const, data: {ready: false, opencode: 'starting'}})
}

export function makeDeps(overrides: Partial<RunMentionDeps> = {}): RunMentionDeps {
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
export function buildMockRunState(
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
export function setupHappyPath(heartbeatOverrides?: {
  start?: ReturnType<typeof vi.fn>
  stop?: ReturnType<typeof vi.fn>
}) {
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

/**
 * In-memory `CoordinationConfig` whose `getObject`/`conditionalPut` perform a real
 * read-modify-write cycle (mirrors `cancel.test.ts`'s `makeCoordinationConfig`), so
 * `patchRunDetails` — NOT mocked by this file's `vi.mock('@fro-bot/runtime', ...)`,
 * which only overrides `acquireLock`/`releaseLock`/`createRun`/`transitionRun`/
 * `createHeartbeatController` — actually executes against it.
 */
export function makeOwnershipCoordinationConfig(initialState: RunState, initialEtag = 'etag-1') {
  let stored = {state: initialState, etag: initialEtag}
  const writes: RunState[] = []
  const config: CoordinationConfig = {
    storeAdapter: {
      upload: vi.fn(async () => ok(undefined)),
      download: vi.fn(async () => ok(undefined)),
      getObject: vi.fn(async () => ok({data: JSON.stringify(stored.state), etag: stored.etag})),
      conditionalPut: vi.fn(async (_key: string, data: string, opts: {readonly ifMatch?: string}) => {
        if (opts.ifMatch !== undefined && opts.ifMatch !== stored.etag) {
          return err(new Error('etag mismatch (412)'))
        }
        const nextEtag = `etag-${Math.random().toString(36).slice(2)}`
        const nextState = JSON.parse(data) as RunState
        writes.push(nextState)
        stored = {state: nextState, etag: nextEtag}
        return ok({etag: nextEtag})
      }),
      list: vi.fn(async () => ok([])),
    },
    storeConfig: {enabled: true, bucket: 'test-bucket', region: 'us-east-1', prefix: 'fro-bot-state'},
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  }
  return {config, writes: () => writes}
}

// ---------------------------------------------------------------------------
// launchWork — in-memory sink helpers
//
// These build in-memory StatusSink/ReplySink implementations (no Discord
// dependency) used by launchWork-focused tests across several of the split
// files (admission, early-abort gates, operator cancel, failureKind
// persistence, and the in-memory sink tests themselves).
// ---------------------------------------------------------------------------

/**
 * Build an in-memory StatusSink that records calls.
 */
export function makeInMemoryStatusSink(): StatusSink & {
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
export function makeInMemoryReplySink(): ReplySink & {
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
export function makeInMemoryRequest(
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
export async function awaitLaunchWorkRun(
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

/**
 * Simulate `runOpenCodeCore` observing the cancel signal fire and throwing
 * the same way the real implementation would once its combined signal aborts:
 * a `RunCoreError('timeout', ...)` (run-core does not add a distinct
 * 'cancelled' kind — classification happens in run.ts via registry probe).
 */
export function mockRunOpenCodeCoreAbortedBy(viaRegistryAbort: () => void) {
  mockRunOpenCodeCore.mockImplementation(async () => {
    viaRegistryAbort()
    throw new runCoreModule.RunCoreError('timeout', 'run-core: signal aborted')
  })
}
