import type {CoordinationConfig, ObjectStoreAdapter, RunState} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {RecoverStaleRunsDeps} from './recovery.js'

import {err, getRunKey, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'

import {recoverStaleRuns} from './recovery.js'

// ---------------------------------------------------------------------------
// Composed: real recoverStaleRuns + real findStaleRuns/isRunStale/transitionRun against an in-memory store with real
// ETag/If-Match semantics. The only fakes are the store, the quiescence checker, and Discord.
// ---------------------------------------------------------------------------

const IDENTITY = 'discord-gateway'
const OWNER = 'acme'
const REPO = 'widget'
const REPO_SLUG = `${OWNER}/${REPO}`
const RUN_ID = 'run-composed-1'

const CLEAR = {
  kind: 'clear' as const,
  source: 'opencode-session-status' as const,
  directory: '/workspace/repos/acme/widget',
  checkedAt: '2026-01-01T00:00:00.000Z',
}

function makeStaleRun(): RunState {
  return {
    run_id: RUN_ID,
    thread_id: 'thread-1',
    entity_ref: REPO_SLUG,
    surface: 'discord',
    phase: 'EXECUTING',
    started_at: new Date(Date.now() - 600_000).toISOString(),
    last_heartbeat: new Date(Date.now() - 300_000).toISOString(),
    holder_id: IDENTITY,
    details: {},
  }
}

/** Run-state-only object store; `afterRunRead(n)` fires after the n-th read of the run key has returned its value. */
function createRunStore(initial: RunState, afterRunRead: (readCount: number, heartbeat: () => void) => void) {
  let version = 0
  let current = {data: JSON.stringify(initial), etag: `etag-${version}`}
  let reads = 0
  const key = 'placeholder'

  const heartbeat = (): void => {
    const state = JSON.parse(current.data) as RunState
    version += 1
    current = {
      data: JSON.stringify({...state, last_heartbeat: new Date().toISOString()}),
      etag: `etag-${version}`,
    }
  }

  const adapter: ObjectStoreAdapter = {
    upload: vi.fn(async () => ok(undefined)),
    download: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok([key])),
    getObject: vi.fn(async () => {
      const snapshot = {...current}
      reads += 1
      afterRunRead(reads, heartbeat)
      return ok(snapshot)
    }),
    conditionalPut: vi.fn(async (_key: string, body: string, options: {ifMatch?: string}) => {
      if (options.ifMatch !== current.etag) return err(new Error('precondition failed'))
      version += 1
      current = {data: body, etag: `etag-${version}`}
      return ok({etag: current.etag})
    }),
    conditionalDelete: vi.fn(async () => ok(undefined)),
  }

  /** Simulates another writer replacing the stored record with arbitrary bytes (bumps the etag like a real write). */
  const overwrite = (data: string): void => {
    version += 1
    current = {data, etag: `etag-${version}`}
  }

  return {
    adapter,
    state: () => JSON.parse(current.data) as RunState,
    raw: () => current.data,
    reads: () => reads,
    overwrite,
  }
}

function makeConfig(adapter: ObjectStoreAdapter): CoordinationConfig {
  return {
    storeAdapter: adapter,
    storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  }
}

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeRig(options: {
  readonly onCheck?: (heartbeat: () => void, overwrite: (data: string) => void) => void
  readonly afterRunRead?: (readCount: number, heartbeat: () => void) => void
}) {
  let heartbeatFn: () => void = () => {}
  const store = createRunStore(makeStaleRun(), (n, hb) => {
    heartbeatFn = hb
    options.afterRunRead?.(n, hb)
  })
  const config = makeConfig(store.adapter)
  const runKey = getRunKey(config, IDENTITY, REPO_SLUG, RUN_ID)
  if (runKey.success === false) throw runKey.error
  vi.mocked(store.adapter.list).mockResolvedValue(ok([runKey.data]))

  const thread = {send: vi.fn().mockResolvedValue(undefined)}
  const logger = makeLogger()
  const checkRepoQuiescence = vi.fn(async () => {
    // The initial stale scan has already read the record by the time the check runs.
    options.onCheck?.(heartbeatFn, store.overwrite)
    return CLEAR
  })
  const deps: RecoverStaleRunsDeps = {
    coordinationConfig: config,
    identity: IDENTITY,
    bindingsStore: {
      createBinding: vi.fn(),
      getBindingByRepo: vi.fn(),
      getBindingByChannelId: vi.fn(),
      listBindings: vi.fn().mockResolvedValue({success: true, data: [{owner: OWNER, repo: REPO}]}),
    },
    resolveThread: vi.fn().mockResolvedValue(thread),
    checkRepoQuiescence,
    logger,
  }
  return {deps, store, thread, logger, checkRepoQuiescence}
}

describe('recoverStaleRuns — composed with the real run-state store', () => {
  it('control: a run that is still stale after a clear check is terminalized and noted', async () => {
    // #given
    const {deps, store, thread} = makeRig({})

    // #when
    await recoverStaleRuns(deps)

    // #then
    expect(store.state().phase).toBe('FAILED')
    expect(thread.send).toHaveBeenCalledOnce()
  })

  it('a heartbeat refresh during the workspace check keeps the run alive: not terminalized, no note', async () => {
    // #given — the run heartbeats while the (multi-second) confirmation is in flight
    const {deps, store, thread, logger, checkRepoQuiescence} = makeRig({onCheck: heartbeat => heartbeat()})

    // #when
    await recoverStaleRuns(deps)

    // #then — recovery re-checked staleness on a fresh read and left the live run alone
    expect(checkRepoQuiescence).toHaveBeenCalledOnce()
    expect(store.state().phase).toBe('EXECUTING')
    expect(Date.now() - new Date(store.state().last_heartbeat).getTime()).toBeLessThan(60_000)
    expect(thread.send).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({runId: RUN_ID}),
      expect.stringContaining('no longer stale'),
    )
  })

  it('a heartbeat landing after the fresh read but before the write loses the CAS: run not terminalized', async () => {
    // #given — read 1 = stale scan, read 2 = recovery's fresh read, read 3 = transitionRun's own read.
    // Refresh right after read 2 so the etag recovery holds is already superseded.
    const {deps, store, thread} = makeRig({afterRunRead: (n, heartbeat) => (n === 2 ? heartbeat() : undefined)})

    // #when
    await recoverStaleRuns(deps)

    // #then
    expect(store.reads()).toBe(3)
    expect(store.state().phase).toBe('EXECUTING')
    expect(thread.send).not.toHaveBeenCalled()
  })

  it.each(['COMPLETED', 'CANCELLED'] as const)(
    'a run that became %s during the workspace check is left untouched: no write, no note',
    async terminalPhase => {
      // #given — the run reaches a terminal phase while the (multi-second) confirmation is in flight
      const terminalRecord = JSON.stringify({...makeStaleRun(), phase: terminalPhase})
      const {deps, store, thread, logger} = makeRig({onCheck: (_heartbeat, overwrite) => overwrite(terminalRecord)})

      // #when
      await recoverStaleRuns(deps)

      // #then — recovery re-read, saw a terminal record, and did not clobber it with FAILED
      expect(store.adapter.conditionalPut).not.toHaveBeenCalled()
      expect(store.raw()).toBe(terminalRecord)
      expect(store.state().phase).toBe(terminalPhase)
      expect(thread.send).not.toHaveBeenCalled()
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({runId: RUN_ID, phase: terminalPhase}),
        expect.stringContaining('no longer stale'),
      )
    },
  )

  it.each([
    ['invalid JSON', '{not json'],
    ['a payload failing run-state validation', JSON.stringify({run_id: RUN_ID, phase: 'NOT_A_PHASE'})],
  ])(
    'a run record that became malformed (%s) during the workspace check is left untouched: no write, no note',
    async (_label, malformed) => {
      // #given — the record is corrupted while the workspace check is in flight
      const {deps, store, thread, logger} = makeRig({onCheck: (_heartbeat, overwrite) => overwrite(malformed)})

      // #when
      await recoverStaleRuns(deps)

      // #then — recovery refused to act on an unparseable record
      expect(store.adapter.conditionalPut).not.toHaveBeenCalled()
      expect(store.raw()).toBe(malformed)
      expect(thread.send).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('malformed'))
    },
  )
})
