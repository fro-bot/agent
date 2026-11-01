import type {ActionOpenCodeV2Client} from '@fro-bot/runtime'
import {createOwnershipLedger, shellLedgerKey} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {createOwnedWorkReconcilerV2, reconcileOwnedWorkV2} from './reconcile-v2.js'

const ROOT = 'ses_root'
const CHILD = 'ses_child'
const SHELL = 'sh_job'

const ok = <T>(data: T) => ({success: true as const, data})
const notFound = () => ({success: false as const, error: {kind: 'http' as const, status: 404}})

function client(overrides: {
  active?: () => Promise<Record<string, unknown>>
  children?: readonly string[]
  shells?: readonly string[]
  getShell?: () => Promise<unknown>
}) {
  return {
    session: {
      active: vi.fn(overrides.active ?? (async () => ({}))),
      list: vi.fn(async () => ({data: (overrides.children ?? []).map(id => ({id, parentID: ROOT}))})),
    },
    listShells: vi.fn(async () =>
      ok((overrides.shells ?? []).map(id => ({id, status: 'running', ownerSessionId: ROOT, pid: 1}))),
    ),
    getShell: vi.fn(overrides.getShell ?? (async () => notFound())),
  } as unknown as ActionOpenCodeV2Client
}

describe('reconcileOwnedWorkV2', () => {
  it('makes no request for an empty ledger', async () => {
    // #given
    const api = client({})

    // #when
    const running = await reconcileOwnedWorkV2({
      client: api,
      ledger: createOwnershipLedger(),
      directory: '/d',
      parentSessionId: ROOT,
      logger: createMockLogger(),
    })

    // #then
    expect(running).toBe(false)
    expect(api.session.active).not.toHaveBeenCalled()
    expect(api.listShells).not.toHaveBeenCalled()
  })

  it('settles a finished child and a vanished shell, and says nothing was running', async () => {
    // #given
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'child')
    ledger.adopt(shellLedgerKey(SHELL), 'shell')

    // #when
    const running = await reconcileOwnedWorkV2({
      client: client({children: [CHILD]}),
      ledger,
      directory: '/d',
      parentSessionId: ROOT,
      logger: createMockLogger(),
    })

    // #then
    expect(running).toBe(false)
    expect(ledger.snapshot().map(entry => entry.state)).toEqual(['settled', 'settled'])
  })

  it('reports work that is observed running, and leaves it unsettled', async () => {
    // #given a live child and a listed shell
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'child')
    ledger.adopt(shellLedgerKey(SHELL), 'shell')

    // #when
    const running = await reconcileOwnedWorkV2({
      client: client({active: async () => ({[CHILD]: {type: 'running'}}), children: [CHILD], shells: [SHELL]}),
      ledger,
      directory: '/d',
      parentSessionId: ROOT,
      logger: createMockLogger(),
    })

    // #then
    expect(running).toBe(true)
    expect(ledger.outstanding()).toBe(2)
  })

  describe('a pass that never answers', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('marks outstanding entries unknown at its bound and cannot overturn that when it finally answers', async () => {
      // #given a shell list that ignores the abort and answers only after the bound, saying the shell is gone
      let answer!: () => void
      const late = new Promise<void>(resolve => {
        answer = resolve
      })
      const ledger = createOwnershipLedger()
      ledger.adopt(shellLedgerKey(SHELL), 'shell')
      const api = client({})
      vi.mocked(api.listShells).mockImplementation(async () => {
        await late
        return ok([] as never)
      })

      // #when the bound passes
      const pass = reconcileOwnedWorkV2({
        client: api,
        ledger,
        directory: '/d',
        parentSessionId: ROOT,
        logger: createMockLogger(),
        timeoutMs: 1_000,
      })
      await vi.advanceTimersByTimeAsync(1_000)
      const running = await pass

      // #then
      expect(running).toBe(false)
      expect(ledger.unknown()).toBe(1)

      // #when the abandoned pass answers: the shell is gone and unreadable by id, which would settle it
      answer()
      await vi.advanceTimersByTimeAsync(10)

      // #then the late answer changed nothing
      expect(ledger.snapshot().map(entry => entry.state)).toEqual(['unknown'])
    })
  })
})

describe('createOwnedWorkReconcilerV2', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lets a pass still pending at dispose change nothing when it finally answers', async () => {
    // #given a reconcile pass held open on its active-session read, for a child that has in fact finished
    let answer!: (value: Record<string, unknown>) => void
    const late = new Promise<Record<string, unknown>>(resolve => {
      answer = resolve
    })
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'child')
    const api = client({active: async () => late, children: [CHILD]})
    const reconciler = createOwnedWorkReconcilerV2({
      client: api,
      ledger,
      directory: '/d',
      parentSessionId: ROOT,
      logger: createMockLogger(),
      intervalMs: 600_000,
    })
    const pass = reconciler.reconcileNow()
    await vi.advanceTimersByTimeAsync(10)

    // #when the run moves on (disposes) and the old read then returns
    reconciler.dispose()
    answer({})
    await vi.advanceTimersByTimeAsync(10)
    await pass

    // #then the late answer did not settle the child it would have settled
    expect(ledger.snapshot().map(entry => entry.state)).toEqual(['outstanding'])
  })

  it('ticks on its interval, joins a pass already in flight instead of stacking another, and stops on dispose', async () => {
    // #given a slow shell list that holds the first pass open
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const ledger = createOwnershipLedger()
    ledger.adopt(shellLedgerKey(SHELL), 'shell')
    const api = client({})
    vi.mocked(api.listShells).mockImplementation(async () => {
      await gate
      return ok([{id: SHELL, status: 'running', ownerSessionId: ROOT, pid: 1}] as never)
    })
    const reconciler = createOwnedWorkReconcilerV2({
      client: api,
      ledger,
      directory: '/d',
      parentSessionId: ROOT,
      logger: createMockLogger(),
      intervalMs: 1_000,
    })

    // #when the tick fires, then fires again and a one-shot is asked for, all while the first pass is open
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    const oneShot = reconciler.reconcileNow()
    release()
    await vi.advanceTimersByTimeAsync(10)
    await oneShot

    // #then one pass ran for all three triggers
    expect(vi.mocked(api.listShells)).toHaveBeenCalledTimes(1)

    // #when disposed, no further tick runs
    reconciler.dispose()
    await vi.advanceTimersByTimeAsync(5_000)
    await reconciler.reconcileNow()
    expect(vi.mocked(api.listShells)).toHaveBeenCalledTimes(1)
  })
})
