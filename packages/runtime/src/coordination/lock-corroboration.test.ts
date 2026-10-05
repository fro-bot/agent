import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'
import type {ConfirmExpiredHolder, CoordinationConfig, LockRecord, RepoQuiescence, RunState} from './types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {err, ok} from '../shared/types.js'
import {acquireLock} from './lock.js'

const LOCK_KEY = 'fro-bot-state/coordination/owner/repo/locks/repo.json'
const DIRECTORY = '/workspace/repos/owner/repo'

function createLogger() {
  return {
    debug: vi.fn<(message: string, context?: Record<string, unknown>) => void>(),
    info: vi.fn<(message: string, context?: Record<string, unknown>) => void>(),
  }
}

function lockRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    repo: 'owner/repo',
    holder_id: 'discord-gateway',
    surface: 'discord',
    acquired_at: '2026-04-24T17:30:00.000Z',
    ttl_seconds: 900,
    run_id: 'run-old',
    ...overrides,
  }
}

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: 'run-old',
    surface: 'discord',
    thread_id: 't',
    entity_ref: 'owner/repo',
    phase: 'FAILED',
    started_at: '2026-04-24T17:30:00.000Z',
    last_heartbeat: '2026-04-24T17:44:00.000Z',
    holder_id: 'discord-gateway',
    details: {},
    ...overrides,
  }
}

function clear(): RepoQuiescence {
  return {kind: 'clear', source: 'opencode-session-status', directory: DIRECTORY, checkedAt: '2026-04-24T18:15:00.000Z'}
}

function busy(sessionIds: readonly string[]): RepoQuiescence {
  return {
    kind: 'busy',
    source: 'opencode-session-status',
    directory: DIRECTORY,
    checkedAt: '2026-04-24T18:15:00.000Z',
    sessionIds,
  }
}

function configFor(adapter: ObjectStoreAdapter): CoordinationConfig {
  const storeConfig: ObjectStoreConfig = {enabled: true, bucket: 'b', region: 'us-east-1', prefix: 'fro-bot-state'}
  return {
    storeAdapter: adapter,
    storeConfig,
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  }
}

/** Single-key in-memory store with real ETag/If-Match/If-None-Match semantics plus a RunState lookup. */
function createMemoryStore(initial: LockRecord | null, runStates: Record<string, string> = {}, hangRunReads = false) {
  let current: {data: string; etag: string} | null =
    initial === null ? null : {data: JSON.stringify(initial), etag: 'etag-0'}
  let version = 0
  const puts: {readonly body: string; readonly options: unknown}[] = []

  const adapter: Required<ObjectStoreAdapter> = {
    upload: vi.fn(async () => ok(undefined)),
    download: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok([])),
    listWithMetadata: vi.fn(async () => ok([])),
    conditionalDelete: vi.fn(async () => ok(undefined)),
    getObject: vi.fn(async (key: string) => {
      if (key === LOCK_KEY) {
        return current === null ? err(new Error('NoSuchKey')) : ok({...current})
      }
      if (hangRunReads) return new Promise<never>(() => {})
      const state = runStates[key]
      return state === undefined ? err(new Error('NoSuchKey')) : ok({data: state, etag: 'etag-run'})
    }),
    conditionalPut: vi.fn(async (key: string, body: string, options?: {ifMatch?: string; ifNoneMatch?: string}) => {
      puts.push({body, options})
      if (key !== LOCK_KEY) return ok({etag: 'other'})
      if (options?.ifNoneMatch === '*' && current !== null) return err(new Error('precondition failed'))
      if (options?.ifMatch !== undefined && options.ifMatch !== current?.etag) {
        return err(new Error('precondition failed'))
      }
      version += 1
      current = {data: body, etag: `etag-${version}`}
      return ok({etag: current.etag})
    }),
  }

  return {
    adapter,
    puts,
    current: () => (current === null ? null : (JSON.parse(current.data) as LockRecord)),
    replaceExternally: (record: LockRecord) => {
      version += 1
      current = {data: JSON.stringify(record), etag: `etag-${version}`}
    },
  }
}

describe('acquireLock — corroborated expired takeover', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T18:15:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never invokes the checker for an active lease', async () => {
    // #given
    const store = createMemoryStore(lockRecord({acquired_at: '2026-04-24T18:14:30.000Z'}))
    const confirm = vi.fn<ConfirmExpiredHolder>(async () => clear())

    // #when
    const result = await acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', createLogger(), {
      confirmExpiredHolder: confirm,
    })

    // #then
    expect(result.success === true ? result.data.outcome : null).toBe('active-holder')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('acquires an expired lease when the checker reports clear, using the observed ETag', async () => {
    // #given
    const store = createMemoryStore(lockRecord())
    const confirm = vi.fn<ConfirmExpiredHolder>(async () => clear())

    // #when
    const result = await acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', createLogger(), {
      confirmExpiredHolder: confirm,
    })

    // #then
    expect(result.success === true ? result.data.outcome : null).toBe('acquired')
    expect(store.current()?.run_id).toBe('run-2')
    expect(store.puts.at(-1)?.options).toEqual({ifMatch: 'etag-0'})
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('stamps the replacement acquired_at after confirmation completes', async () => {
    // #given — confirmation takes 3s
    const store = createMemoryStore(lockRecord())
    const confirm: ConfirmExpiredHolder = async () => {
      await new Promise(resolve => setTimeout(resolve, 3000))
      return clear()
    }

    // #when
    const pending = acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', createLogger(), {
      confirmExpiredHolder: confirm,
    })
    await vi.advanceTimersByTimeAsync(3000)
    await pending

    // #then
    expect(store.current()?.acquired_at).toBe('2026-04-24T18:15:03.000Z')
  })

  it.each([
    ['busy', async () => busy(['ses_child'])],
    [
      'unknown',
      async (): Promise<RepoQuiescence> => ({
        kind: 'unknown',
        source: 'opencode-session-status',
        directory: DIRECTORY,
        reason: 'status-request-failed',
      }),
    ],
  ])('blocks and never writes when the checker reports %s', async (_label, confirmFn) => {
    // #given
    const store = createMemoryStore(lockRecord())

    // #when
    const result = await acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', createLogger(), {
      confirmExpiredHolder: confirmFn,
    })

    // #then
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('expired-holder')
    expect(result.success === true ? result.data.acquired : null).toBe(false)
    expect(store.current()?.run_id).toBe('run-old')
    expect(store.puts.filter(put => (put.options as {ifMatch?: string}).ifMatch !== undefined)).toHaveLength(0)
  })

  it('blocks with reason no-corroborator when no callback is supplied', async () => {
    // #given
    const store = createMemoryStore(lockRecord())

    // #when
    const result = await acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', createLogger())

    // #then
    expect(
      result.success === true && result.data.outcome === 'expired-holder' ? result.data.confirmation : null,
    ).toEqual({kind: 'unknown', source: 'unavailable', directory: null, reason: 'no-corroborator'})
    expect(store.current()?.run_id).toBe('run-old')
  })

  it('blocks when the callback throws', async () => {
    // #given
    const store = createMemoryStore(lockRecord())

    // #when
    const result = await acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', createLogger(), {
      confirmExpiredHolder: async () => {
        throw new Error('boom')
      },
    })

    // #then
    expect(result.success === true ? result.data.outcome : null).toBe('expired-holder')
    expect(store.current()?.run_id).toBe('run-old')
  })

  it('blocks on timeout even when the callback ignores the abort signal, and drops a late clear', async () => {
    // #given — callback ignores the signal and resolves clear only after 6s
    const store = createMemoryStore(lockRecord())
    let sawAbort = false
    const confirm: ConfirmExpiredHolder = async ({signal}) => {
      signal.addEventListener('abort', () => {
        sawAbort = true
      })
      await new Promise(resolve => setTimeout(resolve, 6000))
      return clear()
    }

    // #when
    const pending = acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', createLogger(), {
      confirmExpiredHolder: confirm,
    })
    await vi.advanceTimersByTimeAsync(5000)
    const result = await pending
    await vi.advanceTimersByTimeAsync(2000)

    // #then
    expect(sawAbort).toBe(true)
    expect(
      result.success === true && result.data.outcome === 'expired-holder' ? result.data.confirmation : null,
    ).toEqual({kind: 'unknown', source: 'unavailable', directory: null, reason: 'confirmation-timeout'})
    expect(store.current()?.run_id).toBe('run-old')
  })

  it.each([
    ['null', null],
    ['unknown kind', {kind: 'idle'}],
    ['clear missing directory', {kind: 'clear', source: 'opencode-session-status', checkedAt: 'x'}],
    ['clear with wrong source', {kind: 'clear', source: 'elsewhere', directory: DIRECTORY, checkedAt: 'x'}],
    [
      'busy with non-string ids',
      {kind: 'busy', source: 'opencode-session-status', directory: DIRECTORY, checkedAt: 'x', sessionIds: [1]},
    ],
  ])('blocks on a malformed callback result (%s)', async (_label, malformed) => {
    // #given
    const store = createMemoryStore(lockRecord())

    // #when
    const result = await acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', createLogger(), {
      confirmExpiredHolder: async () => malformed as unknown as RepoQuiescence,
    })

    // #then
    expect(
      result.success === true && result.data.outcome === 'expired-holder' ? result.data.confirmation : null,
    ).toEqual({kind: 'unknown', source: 'unavailable', directory: null, reason: 'confirmation-malformed'})
    expect(store.current()?.run_id).toBe('run-old')
  })

  it('returns conflict and keeps the newer record when the lease is renewed during confirmation', async () => {
    // #given — holder renews (new ETag) while the checker runs
    const store = createMemoryStore(lockRecord())
    const renewed = lockRecord({acquired_at: '2026-04-24T18:15:00.000Z'})
    const confirm: ConfirmExpiredHolder = async () => {
      store.replaceExternally(renewed)
      return clear()
    }

    // #when
    const result = await acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', createLogger(), {
      confirmExpiredHolder: confirm,
    })

    // #then
    expect(result).toEqual(ok({acquired: false, outcome: 'conflict', etag: null, holder: null}))
    expect(store.current()).toEqual(renewed)
  })

  it('lets exactly one of two clear contenders win the compare-and-swap', async () => {
    // #given
    const store = createMemoryStore(lockRecord())
    const contend = async (id: string) =>
      acquireLock(configFor(store.adapter), 'owner/repo', id, 'discord', `run-${id}`, createLogger(), {
        confirmExpiredHolder: async () => clear(),
      })

    // #when
    const results = await Promise.all([contend('a'), contend('b')])

    // #then
    const outcomes = results.map(result => (result.success === true ? result.data.outcome : 'error')).sort()
    expect(outcomes).toEqual(['acquired', 'conflict'])
  })

  it('surfaces a store failure during the conditional write as an error', async () => {
    // #given
    const store = createMemoryStore(lockRecord())
    vi.mocked(store.adapter.conditionalPut)
      .mockResolvedValueOnce(err(new Error('precondition failed')))
      .mockResolvedValueOnce(err(new Error('S3 503')))
    const logger = createLogger()

    // #when
    const result = await acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', logger, {
      confirmExpiredHolder: async () => clear(),
    })

    // #then
    expect(result.success).toBe(false)
    expect(logger.info).toHaveBeenLastCalledWith(
      'lock-takeover-outcome',
      expect.objectContaining({decision: 'store-error'}),
    )
  })
})

describe('acquireLock — reclaimableWithoutConfirmation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T18:15:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reclaims an expired lease the predicate approves without invoking the checker', async () => {
    // #given — expired Action-held lease
    const store = createMemoryStore(lockRecord({surface: 'github', holder_id: 'action:1:1'}))
    const confirm = vi.fn<ConfirmExpiredHolder>(async () => busy(['ses_x']))
    const logger = createLogger()

    // #when
    const result = await acquireLock(configFor(store.adapter), 'owner/repo', 'action:2:1', 'github', 'run-2', logger, {
      confirmExpiredHolder: confirm,
      reclaimableWithoutConfirmation: holder => holder.surface === 'github',
    })

    // #then
    expect(result.success === true ? result.data.outcome : null).toBe('acquired')
    expect(confirm).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenLastCalledWith(
      'lock-takeover-outcome',
      expect.objectContaining({decision: 'taken-over', confirmationSource: 'holder-surface-reclaimable'}),
    )
  })

  it('does not reclaim an expired lease the predicate rejects', async () => {
    // #given — expired gateway-held lease, Action-style options without a corroborator
    const store = createMemoryStore(lockRecord())

    // #when
    const result = await acquireLock(
      configFor(store.adapter),
      'owner/repo',
      'action:2:1',
      'github',
      'run-2',
      createLogger(),
      {
        reclaimableWithoutConfirmation: holder => holder.surface === 'github',
      },
    )

    // #then
    expect(result.success === true ? result.data.outcome : null).toBe('expired-holder')
    expect(store.current()?.run_id).toBe('run-old')
  })
})

describe('acquireLock — audit events', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T18:15:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const runStateKey = 'fro-bot-state/discord-gateway/owner/repo/runs/run-old.json'

  it('emits attempt and outcome INFO events with the full evidence set', async () => {
    // #given
    const state = runState({
      details: {
        quarantined: true,
        failureKind: 'termination-unconfirmed',
        quarantineHoldUntil: '2026-04-24T17:50:00.000Z',
        rootSessionId: 'ses_root',
        ownedSessionIds: ['ses_a', 'ses_b'],
        apiToken: 'sk-super-secret',
        prompt: 'do the secret thing',
      },
    })
    const store = createMemoryStore(lockRecord(), {[runStateKey]: JSON.stringify(state)})
    const logger = createLogger()

    // #when
    await acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', logger, {
      confirmExpiredHolder: async () => busy(['ses_child']),
    })

    // #then
    const calls = logger.info.mock.calls
    expect(calls.map(call => call[0])).toEqual(['lock-takeover-attempt', 'lock-takeover-outcome'])
    const attempt = calls[0]?.[1] as Record<string, unknown>
    const outcome = calls[1]?.[1] as Record<string, unknown>
    expect(attempt).toMatchObject({
      operation: 'acquire',
      repo: 'owner/repo',
      oldHolderId: 'discord-gateway',
      oldRunId: 'run-old',
      oldSurface: 'discord',
      oldAcquiredAt: '2026-04-24T17:30:00.000Z',
      oldTtlSeconds: 900,
      oldExpiryAgeMs: 30 * 60_000,
      newHolderId: 'g2',
      newRunId: 'run-2',
      newSurface: 'discord',
      oldRunState: 'known',
      oldRunPhase: 'FAILED',
      oldRunLastHeartbeat: '2026-04-24T17:44:00.000Z',
      oldRunQuarantined: true,
      oldRunQuarantineReason: 'termination-unconfirmed',
      oldRunQuarantineHoldUntil: '2026-04-24T17:50:00.000Z',
      oldRunPersistedRootSessionId: 'ses_root',
      oldRunPersistedOwnedSessionCount: 2,
      decision: 'pending',
    })
    expect(outcome).toMatchObject({
      correlationId: attempt.correlationId,
      decision: 'blocked-busy',
      confirmationSource: 'opencode-session-status',
      confirmationDirectory: DIRECTORY,
      confirmationCheckedAt: '2026-04-24T18:15:00.000Z',
      confirmationBusyCount: 1,
      confirmationBusySessionIds: ['ses_child'],
    })
    const serialized = JSON.stringify(calls)
    expect(serialized).not.toContain('sk-super-secret')
    expect(serialized).not.toContain('secret thing')
  })

  it('caps logged busy session ids at 32 while reporting the full count', async () => {
    // #given
    const store = createMemoryStore(lockRecord())
    const logger = createLogger()
    const ids = Array.from({length: 40}, (_unused, index) => `ses_${index}`)

    // #when
    await acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', logger, {
      confirmExpiredHolder: async () => busy(ids),
    })

    // #then
    const outcome = logger.info.mock.calls[1]?.[1] as Record<string, unknown>
    expect(outcome.confirmationBusyCount).toBe(40)
    expect(outcome.confirmationBusySessionIds).toHaveLength(32)
  })

  it('reports Action holders as unknown: not-written-by-action without reading RunState', async () => {
    // #given
    const store = createMemoryStore(lockRecord({surface: 'github', holder_id: 'action:1:1'}))
    const logger = createLogger()

    // #when
    await acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', logger, {
      confirmExpiredHolder: async () => clear(),
    })

    // #then
    expect(logger.info.mock.calls[0]?.[1]).toMatchObject({oldRunState: 'unknown: not-written-by-action'})
    expect(store.adapter.getObject).not.toHaveBeenCalledWith(expect.stringContaining('/runs/'))
  })

  it.each([
    ['missing', undefined, 'unknown: run-state-unavailable'],
    ['malformed', '{"nope":true}', 'unknown: run-state-malformed'],
  ])('reports an explicit unknown when the RunState is %s, without blocking', async (_label, body, expected) => {
    // #given
    const store = createMemoryStore(lockRecord(), body === undefined ? {} : {[runStateKey]: body})
    const logger = createLogger()

    // #when
    const result = await acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', logger, {
      confirmExpiredHolder: async () => clear(),
    })

    // #then
    expect(logger.info.mock.calls[0]?.[1]).toMatchObject({oldRunState: expected})
    expect(result.success === true ? result.data.outcome : null).toBe('acquired')
  })

  it('bounds the RunState read to 2s and reports a timeout as unknown', async () => {
    // #given — RunState read never settles
    const store = createMemoryStore(lockRecord(), {}, true)
    const logger = createLogger()

    // #when
    const pending = acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', logger, {
      confirmExpiredHolder: async () => clear(),
    })
    await vi.advanceTimersByTimeAsync(2000)
    const result = await pending

    // #then
    expect(logger.info.mock.calls[0]?.[1]).toMatchObject({oldRunState: 'unknown: run-state-read-timeout'})
    expect(result.success === true ? result.data.outcome : null).toBe('acquired')
  })

  it('records cas-conflict and unknown reasons in the outcome event', async () => {
    // #given
    const store = createMemoryStore(lockRecord())
    const logger = createLogger()

    // #when
    await acquireLock(configFor(store.adapter), 'owner/repo', 'g2', 'discord', 'run-2', logger, {
      confirmExpiredHolder: async () => {
        throw new Error('nope')
      },
    })

    // #then
    expect(logger.info.mock.calls[1]?.[1]).toMatchObject({
      decision: 'blocked-unknown',
      confirmationUnknownReason: 'confirmation-failed',
    })
  })
})
