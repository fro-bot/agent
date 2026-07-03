/**
 * Tests for the transport-neutral run-cancellation orchestrator.
 *
 * Deterministic fakes throughout — no real S3/Discord, no sleeps.
 * BDD `// #given/#when/#then` per repo convention.
 */

import type {CoordinationConfig, RunState} from '@fro-bot/runtime'
import type {ApprovalRegistry, PendingApprovalDTO} from '../approvals/registry.js'
import type {GatewayLogger} from '../discord/client.js'
import type {AbortRegistry} from './abort-registry.js'
import type {CancelActorContext, CancelRunDeps} from './cancel.js'
import type {ChannelQueue} from './queue.js'
import type {RunIndex} from './run-index.js'
import type {RunTask} from './run.js'

import {err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {cancelRun} from './cancel.js'

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeActor(overrides: Partial<CancelActorContext> = {}): CancelActorContext {
  return {githubUserId: 42, login: 'octocat', sessionCorrelationId: 'sess-1', ...overrides}
}

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: 'run-1',
    surface: 'discord',
    thread_id: 'thread-1',
    entity_ref: 'acme/widget',
    phase: 'PENDING',
    started_at: '2026-07-03T00:00:00.000Z',
    last_heartbeat: '2026-07-03T00:00:00.000Z',
    holder_id: 'gateway',
    details: {channelId: 'ch-a'},
    ...overrides,
  }
}

/** In-memory getObject/conditionalPut fake so transitionRun's read-modify-write works end to end. */
function makeCoordinationConfig(initialState: RunState, initialEtag = 'etag-1'): CoordinationConfig {
  let stored = {state: initialState, etag: initialEtag}
  return {
    storeAdapter: {
      upload: vi.fn(async () => ok(undefined)),
      download: vi.fn(async () => ok(undefined)),
      getObject: vi.fn(async () => ok({data: JSON.stringify(stored.state), etag: stored.etag})),
      conditionalPut: vi.fn(async (_key: string, data: string, opts: {readonly ifMatch?: string}) => {
        if (opts.ifMatch !== undefined && opts.ifMatch !== stored.etag) {
          return err(new Error('etag mismatch (412)'))
        }
        const nextEtag = `etag-${Math.random().toString(36).slice(2)}`
        stored = {state: JSON.parse(data) as RunState, etag: nextEtag}
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
}

function makeRunIndex(repo = 'acme/widget'): Pick<RunIndex, 'lookup'> {
  return {lookup: vi.fn(async () => ({repo, surface: 'discord' as const}))}
}

function makeQueue(overrides: Partial<ChannelQueue<RunTask>> = {}): ChannelQueue<RunTask> {
  return {
    enqueue: vi.fn().mockReturnValue('queued'),
    pendingCount: vi.fn().mockReturnValue(0),
    takeNext: vi.fn().mockReturnValue(undefined),
    clear: vi.fn().mockReturnValue(0),
    removeBy: vi.fn().mockReturnValue(undefined),
    ...overrides,
  }
}

function makeAbortRegistry(overrides: Partial<AbortRegistry> = {}): Pick<AbortRegistry, 'has' | 'abort'> {
  return {
    has: vi.fn().mockReturnValue(false),
    abort: vi.fn().mockReturnValue(true),
    ...overrides,
  }
}

function makeApprovalRegistry(
  overrides: Partial<Pick<ApprovalRegistry, 'describePendingForScope' | 'handleDecision'>> = {},
): Pick<ApprovalRegistry, 'describePendingForScope' | 'handleDecision'> {
  return {
    describePendingForScope: vi.fn().mockReturnValue([]),
    handleDecision: vi.fn().mockResolvedValue('ok'),
    ...overrides,
  }
}

function makeDiscordClient(sendMock = vi.fn().mockResolvedValue(undefined)): CancelRunDeps['discordClient'] {
  const channel = {
    isTextBased: () => true,
    send: sendMock,
  }
  return {
    channels: {
      fetch: vi.fn().mockResolvedValue(channel),
    } as unknown as CancelRunDeps['discordClient']['channels'],
  }
}

function makeDeps(overrides: Partial<CancelRunDeps> & {readonly runState: RunState}): CancelRunDeps {
  const {runState, ...rest} = overrides
  return {
    coordinationConfig: rest.coordinationConfig ?? makeCoordinationConfig(runState),
    identity: rest.identity ?? 'discord-gateway',
    runIndex: rest.runIndex ?? makeRunIndex(),
    queue: rest.queue ?? makeQueue(),
    abortRegistry: rest.abortRegistry ?? makeAbortRegistry(),
    approvalRegistry: rest.approvalRegistry ?? makeApprovalRegistry(),
    discordClient: rest.discordClient ?? makeDiscordClient(),
    runObserver: rest.runObserver,
    now: rest.now ?? (() => new Date('2026-07-03T12:00:00.000Z').getTime()),
  }
}

// ---------------------------------------------------------------------------
// not-found
// ---------------------------------------------------------------------------

describe('cancelRun — not-found', () => {
  it('returns not-found for an unknown runId', async () => {
    // #given — runIndex.lookup misses
    const deps = makeDeps({
      runState: makeRunState(),
      runIndex: {lookup: vi.fn().mockResolvedValue(undefined)},
    })

    // #when
    const result = await cancelRun({runId: 'unknown-run', actor: makeActor(), logger: makeLogger()}, deps)

    // #then
    expect(result).toEqual({outcome: 'not-found'})
  })
})

// ---------------------------------------------------------------------------
// already-terminal
// ---------------------------------------------------------------------------

describe('cancelRun — already-terminal', () => {
  it('short-circuits on a terminal phase without a transition attempt or notice', async () => {
    // #given — the run is already COMPLETED
    const runState = makeRunState({phase: 'COMPLETED'})
    const coordinationConfig = makeCoordinationConfig(runState)
    const discordClient = makeDiscordClient()
    const deps = makeDeps({runState, coordinationConfig, discordClient})

    // #when
    const result = await cancelRun({runId: 'run-1', actor: makeActor(), logger: makeLogger()}, deps)

    // #then — origin AE1: idempotent, no transition, no notice
    expect(result).toEqual({outcome: 'already-terminal', phase: 'COMPLETED'})
    expect(coordinationConfig.storeAdapter.conditionalPut).not.toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() mock reference, not a real method
    expect(discordClient.channels.fetch).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Queued cancel
// ---------------------------------------------------------------------------

describe('cancelRun — queued', () => {
  it('removes from queue, commits CANCELLED with cancelledBy details, notifies observer, sends notice', async () => {
    // #given — a PENDING run with a matching queue entry
    const runState = makeRunState({phase: 'PENDING'})
    const task = {runId: 'run-1'} as unknown as RunTask
    const queue = makeQueue({removeBy: vi.fn().mockReturnValue(task)})
    const observe = vi.fn().mockResolvedValue(undefined)
    const sendMock = vi.fn().mockResolvedValue(undefined)
    const discordClient = makeDiscordClient(sendMock)
    const deps = makeDeps({runState, queue, runObserver: {observe}, discordClient})

    // #when
    const result = await cancelRun({runId: 'run-1', actor: makeActor(), logger: makeLogger()}, deps)

    // #then
    expect(result).toEqual({outcome: 'cancelled', wasQueued: true})
    expect(queue.removeBy).toHaveBeenCalledWith('ch-a', expect.any(Function))
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({phase: 'CANCELLED'}))
    const observedState = observe.mock.calls[0]?.[0] as RunState
    expect(observedState.details.cancelledBy).toMatchObject({
      githubUserId: 42,
      login: 'octocat',
      sessionCorrelationId: 'sess-1',
    })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher typing
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({content: expect.stringContaining('cancelled')}))
  })

  it('does not touch an active run on the same channel (other queue entries untouched)', async () => {
    // #given — origin AE2: queue.removeBy is scoped by predicate/channel; only the target is affected
    const runState = makeRunState({phase: 'PENDING'})
    const task = {runId: 'run-1'} as unknown as RunTask
    const removeBy = vi.fn().mockReturnValue(task)
    const queue = makeQueue({removeBy})
    const deps = makeDeps({runState, queue})

    // #when
    await cancelRun({runId: 'run-1', actor: makeActor(), logger: makeLogger()}, deps)

    // #then — removeBy called once, scoped to the target channel; the predicate is
    // responsible for matching only run-1 (verified indirectly: only one call made).
    expect(removeBy).toHaveBeenCalledTimes(1)
    expect(removeBy).toHaveBeenCalledWith('ch-a', expect.any(Function))
  })
})

// ---------------------------------------------------------------------------
// Executing cancel
// ---------------------------------------------------------------------------

describe('cancelRun — executing', () => {
  it('settles approvals via handleDecision, aborts AFTER settlement, sends notice', async () => {
    // #given — abort registry has the run; one pending approval
    const runState = makeRunState({phase: 'EXECUTING'})
    const pending: PendingApprovalDTO[] = [{requestID: 'req-1', permission: 'bash'}]
    const callOrder: string[] = []
    const handleDecision = vi.fn().mockImplementation(async () => {
      callOrder.push('handleDecision')
      return 'ok'
    })
    const abort = vi.fn().mockImplementation(() => {
      callOrder.push('abort')
      return true
    })
    const approvalRegistry = makeApprovalRegistry({
      describePendingForScope: vi.fn().mockReturnValue(pending),
      handleDecision,
    })
    const abortRegistry = makeAbortRegistry({has: vi.fn().mockReturnValue(true), abort})
    const sendMock = vi.fn().mockResolvedValue(undefined)
    const discordClient = makeDiscordClient(sendMock)
    const deps = makeDeps({runState, approvalRegistry, abortRegistry, discordClient})

    // #when
    const result = await cancelRun({runId: 'run-1', actor: makeActor(), logger: makeLogger()}, deps)

    // #then
    expect(result).toEqual({outcome: 'cancelled', wasQueued: false})
    expect(handleDecision).toHaveBeenCalledWith({
      requestID: 'req-1',
      approvalScopeId: 'thread-1',
      decision: 'reject',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher typing
      actor: expect.objectContaining({kind: 'web-operator', githubUserId: 42}),
    })
    expect(abort).toHaveBeenCalledWith(
      'run-1',
      'operator cancel',
      expect.objectContaining({githubUserId: 42, login: 'octocat'}),
    )
    // #and — settlement happens BEFORE the abort fires
    expect(callOrder).toEqual(['handleDecision', 'abort'])
    expect(sendMock).toHaveBeenCalled()
  })

  it('asserts no direct registry-state mutation — only handleDecision is called for settlement', async () => {
    // #given
    const runState = makeRunState({phase: 'EXECUTING'})
    const pending: PendingApprovalDTO[] = [{requestID: 'req-1', permission: 'bash'}]
    const handleDecision = vi.fn().mockResolvedValue('ok')
    const approvalRegistry = makeApprovalRegistry({
      describePendingForScope: vi.fn().mockReturnValue(pending),
      handleDecision,
    })
    const abortRegistry = makeAbortRegistry({has: vi.fn().mockReturnValue(true)})
    const deps = makeDeps({runState, approvalRegistry, abortRegistry})

    // #when
    await cancelRun({runId: 'run-1', actor: makeActor(), logger: makeLogger()}, deps)

    // #then — the fake only exposes describePendingForScope + handleDecision; a call to
    // any other mutator would be a TypeScript error at the mock construction site, and
    // handleDecision is the sole settlement call observed.
    expect(handleDecision).toHaveBeenCalledTimes(1)
  })

  it('partial failure: first entry rejection throws, second still settled, cancellation proceeds', async () => {
    // #given — two pending approvals; the first handleDecision call throws
    const runState = makeRunState({phase: 'EXECUTING'})
    const pending: PendingApprovalDTO[] = [
      {requestID: 'req-1', permission: 'bash'},
      {requestID: 'req-2', permission: 'bash'},
    ]
    const handleDecision = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('postReply failed')
      })
      .mockImplementationOnce(async () => 'ok')
    const approvalRegistry = makeApprovalRegistry({
      describePendingForScope: vi.fn().mockReturnValue(pending),
      handleDecision,
    })
    const abortRegistry = makeAbortRegistry({has: vi.fn().mockReturnValue(true)})
    const deps = makeDeps({runState, approvalRegistry, abortRegistry})
    const logger = makeLogger()

    // #when
    const result = await cancelRun({runId: 'run-1', actor: makeActor(), logger}, deps)

    // #then — both entries attempted despite the first throwing; cancellation still proceeds
    expect(handleDecision).toHaveBeenCalledTimes(2)
    expect(handleDecision).toHaveBeenNthCalledWith(1, expect.objectContaining({requestID: 'req-1'}))
    expect(handleDecision).toHaveBeenNthCalledWith(2, expect.objectContaining({requestID: 'req-2'}))
    expect(result).toEqual({outcome: 'cancelled', wasQueued: false})
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Double-miss rendezvous
// ---------------------------------------------------------------------------

describe('cancelRun — double-miss rendezvous', () => {
  it('commits CANCELLED directly when no queue entry and no abort-registry entry exist', async () => {
    // #given — origin AE7: pre-ACK window, queue miss AND registry miss
    const runState = makeRunState({phase: 'ACKNOWLEDGED'})
    const queue = makeQueue({removeBy: vi.fn().mockReturnValue(undefined)})
    const abortRegistry = makeAbortRegistry({has: vi.fn().mockReturnValue(false)})
    const observe = vi.fn().mockResolvedValue(undefined)
    const deps = makeDeps({runState, queue, abortRegistry, runObserver: {observe}})

    // #when
    const result = await cancelRun({runId: 'run-1', actor: makeActor(), logger: makeLogger()}, deps)

    // #then
    expect(result).toEqual({outcome: 'cancelled', wasQueued: false})
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({phase: 'CANCELLED'}))
  })

  it('412 then re-read terminal → already-terminal', async () => {
    // #given — the coordination config's conditionalPut 412s once, then the re-read shows CANCELLED
    // (i.e. the run's own transition won the race first).
    const runState = makeRunState({phase: 'ACKNOWLEDGED'})
    let getObjectCallCount = 0
    const coordinationConfig: CoordinationConfig = {
      storeAdapter: {
        upload: vi.fn(async () => ok(undefined)),
        download: vi.fn(async () => ok(undefined)),
        getObject: vi.fn(async () => {
          getObjectCallCount += 1
          if (getObjectCallCount === 1) {
            return ok({data: JSON.stringify(runState), etag: 'etag-1'})
          }
          // Second read (after 412) sees the run already CANCELLED by someone else.
          return ok({data: JSON.stringify({...runState, phase: 'CANCELLED'}), etag: 'etag-99'})
        }),
        conditionalPut: vi.fn(async () => err(new Error('412'))),
        list: vi.fn(async () => ok([])),
      },
      storeConfig: {enabled: true, bucket: 'test-bucket', region: 'us-east-1', prefix: 'fro-bot-state'},
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
      pendingStaleThresholdMs: 30 * 60_000,
    }
    const queue = makeQueue({removeBy: vi.fn().mockReturnValue(undefined)})
    const abortRegistry = makeAbortRegistry({has: vi.fn().mockReturnValue(false)})
    const deps = makeDeps({runState, coordinationConfig, queue, abortRegistry})

    // #when
    const result = await cancelRun({runId: 'run-1', actor: makeActor(), logger: makeLogger()}, deps)

    // #then
    expect(result).toEqual({outcome: 'already-terminal', phase: 'CANCELLED'})
  })

  it('412 then re-read still EXECUTING → bounded retry then retry outcome', async () => {
    // #given — every conditionalPut 412s and every re-read shows a non-terminal phase,
    // simulating the run advancing faster than the rendezvous loop can observe stability.
    const runState = makeRunState({phase: 'ACKNOWLEDGED'})
    const coordinationConfig: CoordinationConfig = {
      storeAdapter: {
        upload: vi.fn(async () => ok(undefined)),
        download: vi.fn(async () => ok(undefined)),
        getObject: vi.fn(async () => ok({data: JSON.stringify({...runState, phase: 'EXECUTING'}), etag: 'etag-x'})),
        conditionalPut: vi.fn(async () => err(new Error('412'))),
        list: vi.fn(async () => ok([])),
      },
      storeConfig: {enabled: true, bucket: 'test-bucket', region: 'us-east-1', prefix: 'fro-bot-state'},
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
      pendingStaleThresholdMs: 30 * 60_000,
    }
    const queue = makeQueue({removeBy: vi.fn().mockReturnValue(undefined)})
    const abortRegistry = makeAbortRegistry({has: vi.fn().mockReturnValue(false)})
    const deps = makeDeps({runState, coordinationConfig, queue, abortRegistry})

    // #when
    const result = await cancelRun({runId: 'run-1', actor: makeActor(), logger: makeLogger()}, deps)

    // #then — bounded retry exhausted without a terminal resolution
    expect(result).toEqual({outcome: 'retry'})
  })
})

// ---------------------------------------------------------------------------
// Thread notice failure
// ---------------------------------------------------------------------------

describe('cancelRun — thread notice failure', () => {
  it('cancellation still succeeds when the notice send fails', async () => {
    // #given — channels.fetch throws
    const runState = makeRunState({phase: 'PENDING'})
    const task = {runId: 'run-1'} as unknown as RunTask
    const queue = makeQueue({removeBy: vi.fn().mockReturnValue(task)})
    const discordClient: CancelRunDeps['discordClient'] = {
      channels: {
        fetch: vi.fn().mockRejectedValue(new Error('discord unreachable')),
      } as unknown as CancelRunDeps['discordClient']['channels'],
    }
    const logger = makeLogger()
    const deps = makeDeps({runState, queue, discordClient})

    // #when
    const result = await cancelRun({runId: 'run-1', actor: makeActor(), logger}, deps)

    // #then — outcome unaffected; failure logged
    expect(result).toEqual({outcome: 'cancelled', wasQueued: true})
    expect(logger.warn).toHaveBeenCalled()
  })
})
