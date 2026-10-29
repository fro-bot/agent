import type {Logger} from '../shared/logger.js'
import type {V2SessionApi, V2SessionInfoLike, V2SessionListInput, V2SessionListPage} from './ledger-reconcile-v2.js'

import {describe, expect, it, vi} from 'vitest'

import {
  ACTIVE_WHILE_CHILD_HELD,
  CHILD_SESSION_ID,
  CHILD_SESSION_INFO,
  PARENT_SESSION_ID,
  PARENT_SESSION_INFO,
  REPO_A_DIRECTORY,
  REPO_B_SESSION_INFO,
} from './event-v2.fixtures.js'
import {
  createV2LedgerReconcileAdapter,
  DEFAULT_V2_LIST_MAX_PAGES,
  listV2SessionsInDirectory,
} from './ledger-reconcile-v2.js'
import {reconcileLedgerOnce} from './ledger-reconcile.js'
import {createOwnershipLedger} from './ownership-ledger.js'

function makeLogger(): Logger {
  return {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}
}

interface FakeServer {
  readonly api: V2SessionApi
  readonly listCalls: V2SessionListInput[]
  readonly activeCalls: number[]
}

/** A server double that filters like the real one: `parentID` and an EXACT-string `directory` match. */
function makeServer(options: {
  readonly active: Readonly<Record<string, {readonly type: string}>>
  readonly sessions: readonly V2SessionInfoLike[]
  readonly pageSize?: number
}): FakeServer {
  const listCalls: V2SessionListInput[] = []
  const activeCalls: number[] = []
  const pageSize = options.pageSize ?? 100
  const api: V2SessionApi = {
    active: async () => {
      activeCalls.push(1)
      return options.active
    },
    list: async (input): Promise<V2SessionListPage> => {
      listCalls.push(input)
      const matching = options.sessions.filter(session => {
        if (input.parentID !== undefined && session.parentID !== input.parentID) return false
        if (input.directory !== undefined && session.location?.directory !== input.directory) return false
        return true
      })
      const start = input.cursor === undefined ? 0 : Number(input.cursor)
      const page = matching.slice(start, start + pageSize)
      const next = start + pageSize < matching.length ? String(start + pageSize) : null
      return {data: page, cursor: {next}}
    },
  }
  return {api, listCalls, activeCalls}
}

const ALL_SESSIONS = [PARENT_SESSION_INFO, CHILD_SESSION_INFO, REPO_B_SESSION_INFO]

describe('createV2LedgerReconcileAdapter: liveSessionIds', () => {
  it('returns the ids in the global active list (real P2 capture: only the background child)', async () => {
    // #given the parent finished and the child is still held
    const server = makeServer({active: ACTIVE_WHILE_CHILD_HELD, sessions: ALL_SESSIONS})
    // #when asking for live ids
    const result = await createV2LedgerReconcileAdapter(server.api).liveSessionIds()
    // #then only the child is live; the parent is not listed
    expect(result.success && [...result.data]).toEqual([CHILD_SESSION_ID])
  })

  it('returns an empty set when nothing is active', async () => {
    const result = await createV2LedgerReconcileAdapter(makeServer({active: {}, sessions: []}).api).liveSessionIds()
    expect(result.success && result.data.size).toBe(0)
  })

  it('fails when the request rejects', async () => {
    const api: V2SessionApi = {
      active: async () => {
        throw new Error('connection refused')
      },
      list: async () => ({data: []}),
    }
    const result = await createV2LedgerReconcileAdapter(api).liveSessionIds()
    expect(result.success).toBe(false)
    expect(!result.success && result.error.message).toBe('connection refused')
  })

  it('fails on a payload that is not an object keyed by session id', async () => {
    for (const bad of [null, [], 'x', 7]) {
      const api = {active: async () => bad, list: async () => ({data: []})} as unknown as V2SessionApi
      expect((await createV2LedgerReconcileAdapter(api).liveSessionIds()).success).toBe(false)
    }
  })
})

describe('createV2LedgerReconcileAdapter: children', () => {
  it('lists the children of a parent through session.list({parentID}) (real P2 capture)', async () => {
    const server = makeServer({active: {}, sessions: ALL_SESSIONS})
    const result = await createV2LedgerReconcileAdapter(server.api).children(PARENT_SESSION_ID)
    expect(result.success && result.data).toEqual([{id: CHILD_SESSION_ID}])
    expect(server.listCalls[0]).toMatchObject({parentID: PARENT_SESSION_ID})
  })

  it('does not trust a returned session whose parent differs from the one asked for', async () => {
    // #given a server (or a filter bug) that returns a session under another parent
    const stranger = {...CHILD_SESSION_INFO, id: 'ses_stranger', parentID: 'ses_someone_else'}
    const api: V2SessionApi = {active: async () => ({}), list: async () => ({data: [CHILD_SESSION_INFO, stranger]})}
    // #when listing the children
    const result = await createV2LedgerReconcileAdapter(api).children(PARENT_SESSION_ID)
    // #then it is excluded
    expect(result.success && result.data.map(child => child.id)).toEqual([CHILD_SESSION_ID])
  })

  it('follows the cursor across pages', async () => {
    const many = Array.from({length: 5}, (_, i) => ({...CHILD_SESSION_INFO, id: `ses_child_${i}`}))
    const server = makeServer({active: {}, sessions: many, pageSize: 2})
    const result = await createV2LedgerReconcileAdapter(server.api).children(PARENT_SESSION_ID)
    expect(result.success && result.data.map(child => child.id)).toEqual(many.map(child => child.id))
    expect(server.listCalls).toHaveLength(3)
  })

  it('fails rather than returning a partial list when the page bound is hit', async () => {
    // #given a server that never stops paging
    const api: V2SessionApi = {
      active: async () => ({}),
      list: async () => ({data: [CHILD_SESSION_INFO], cursor: {next: 'more'}}),
    }
    // #when listing
    const result = await createV2LedgerReconcileAdapter(api).children(PARENT_SESSION_ID)
    // #then the list is reported incomplete, so the ledger cannot settle on a truncated view
    expect(result.success).toBe(false)
    expect(!result.success && result.error.message).toContain(String(DEFAULT_V2_LIST_MAX_PAGES))
  })

  it('fails when the request rejects or the payload has no data array', async () => {
    const rejecting: V2SessionApi = {
      active: async () => ({}),
      list: async () => {
        throw new Error('boom')
      },
    }
    expect((await createV2LedgerReconcileAdapter(rejecting).children('p')).success).toBe(false)
    const shapeless = {active: async () => ({}), list: async () => ({})} as unknown as V2SessionApi
    expect((await createV2LedgerReconcileAdapter(shapeless).children('p')).success).toBe(false)
  })

  it('fails when a request ignores the abort signal and hangs', async () => {
    // #given a list call that never resolves and does not look at the signal
    const api: V2SessionApi = {active: async () => ({}), list: async () => new Promise<V2SessionListPage>(() => {})}
    // #when the pass is aborted
    const controller = new AbortController()
    const pending = createV2LedgerReconcileAdapter(api).children(PARENT_SESSION_ID, controller.signal)
    controller.abort()
    // #then the adapter itself gives up instead of hanging the reconcile pass
    const result = await pending
    expect(result.success).toBe(false)
  })

  it('fails immediately when the signal is already aborted', async () => {
    const server = makeServer({active: {}, sessions: ALL_SESSIONS})
    const controller = new AbortController()
    controller.abort()
    const result = await createV2LedgerReconcileAdapter(server.api).liveSessionIds(controller.signal)
    expect(result.success).toBe(false)
    expect(server.activeCalls).toHaveLength(0)
  })

  it('passes the signal through to the request', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const api: V2SessionApi = {
      active: async requestOptions => {
        seen.push(requestOptions?.signal)
        return {}
      },
      list: async () => ({data: []}),
    }
    const controller = new AbortController()
    await createV2LedgerReconcileAdapter(api).liveSessionIds(controller.signal)
    expect(seen[0]).toBe(controller.signal)
  })
})

describe('reconcileLedgerOnce with the V2 adapter', () => {
  it('settles a child that left the active list and has a terminal outcome', async () => {
    // #given an owned child the parent dispatched, which has since finished (no longer active)
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'bg child')
    const finished = {...CHILD_SESSION_INFO, outcome: 'succeeded'}
    const server = makeServer({active: {}, sessions: [PARENT_SESSION_INFO, finished]})
    // #when reconciling
    const result = await reconcileLedgerOnce({
      ledger,
      adapter: createV2LedgerReconcileAdapter(server.api),
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
    })
    // #then the entry settles
    expect(result.success).toBe(true)
    expect(ledger.snapshot()[0]?.state).toBe('settled')
    expect(ledger.isDrainComplete()).toBe(true)
  })

  it('leaves a child that is still active as outstanding (real P2 capture)', async () => {
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'bg child')
    const server = makeServer({active: ACTIVE_WHILE_CHILD_HELD, sessions: ALL_SESSIONS})
    const result = await reconcileLedgerOnce({
      ledger,
      adapter: createV2LedgerReconcileAdapter(server.api),
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
    })
    expect(result.success && [...result.data.liveTrackedSessionIds]).toEqual([CHILD_SESSION_ID])
    expect(ledger.outstanding()).toBe(1)
  })

  it('marks outstanding entries unknown when the active request fails', async () => {
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'bg child')
    const api: V2SessionApi = {
      active: async () => {
        throw new Error('server gone')
      },
      list: async () => ({data: [CHILD_SESSION_INFO]}),
    }
    const result = await reconcileLedgerOnce({
      ledger,
      adapter: createV2LedgerReconcileAdapter(api),
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
    })
    expect(result.success).toBe(false)
    expect(ledger.unknown()).toBe(1)
    expect(ledger.isDrainComplete()).toBe(false)
  })

  it('marks outstanding entries unknown when a request hangs past the reconcile bound', async () => {
    // #given an active request that never answers
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'bg child')
    const api: V2SessionApi = {
      active: async () => new Promise<Record<string, {type: string}>>(() => {}),
      list: async () => ({data: [CHILD_SESSION_INFO]}),
    }
    // #when the pass is bounded by a signal that fires
    const result = await reconcileLedgerOnce({
      ledger,
      adapter: createV2LedgerReconcileAdapter(api),
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
      signal: AbortSignal.timeout(20),
    })
    // #then the pass fails and the entry is unknown, as in V1
    expect(result.success).toBe(false)
    expect(ledger.unknown()).toBe(1)
  })

  it('marks an entry unknown when the server does not list it as a child of this parent', async () => {
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_forged', 'forged')
    const server = makeServer({active: {ses_forged: {type: 'running'}}, sessions: ALL_SESSIONS})
    await reconcileLedgerOnce({
      ledger,
      adapter: createV2LedgerReconcileAdapter(server.api),
      parentSessionId: PARENT_SESSION_ID,
      logger: makeLogger(),
    })
    expect(ledger.snapshot()[0]?.state).toBe('unknown')
  })
})

/** A directory of sessions served newest first in pages of two, as the real list does. */
function makeSortedServer(updated: readonly (number | null)[]) {
  const sessions = updated.map((time, index) => ({
    id: `ses_${String(index)}`,
    location: {directory: REPO_A_DIRECTORY},
    ...(time === null ? {} : {time: {updated: time}}),
  }))
  const inputs: V2SessionListInput[] = []
  const api: V2SessionApi = {
    active: async () => ({}),
    list: async (input): Promise<V2SessionListPage> => {
      inputs.push(input)
      const start = input.cursor === undefined ? 0 : Number(input.cursor)
      const data = sessions.slice(start, start + 2)
      return {data, cursor: {next: start + 2 < sessions.length ? String(start + 2) : null}}
    },
  }
  return {api, inputs}
}

describe('listV2SessionsInDirectory: updatedSince', () => {
  const NOW = 1_800_000_000_000
  const identity = {realpath: async (path: string) => path}

  it('asks newest first, keeps the sessions updated since, and stops at the first page that reaches the cut-off', async () => {
    // #given — two recent, two old, two older: pages [0,1] [2,3] [4,5]
    const server = makeSortedServer([NOW + 2, NOW + 1, NOW - 10, NOW - 20, NOW - 30, NOW - 40])

    // #when
    const result = await listV2SessionsInDirectory(server.api, REPO_A_DIRECTORY, identity, {updatedSince: NOW})

    // #then — the walk ended on page two; the old half of that page is dropped by the filter
    expect(result.success && result.data).toEqual(['ses_0', 'ses_1'])
    expect(server.inputs).toHaveLength(2)
    expect(server.inputs.every(input => input.order === 'desc')).toBe(true)
  })

  it('applies the page bound to the narrowed walk, not to the stored history', async () => {
    // #given — 40 sessions, only the first two recent, and a bound of three pages
    const times = [NOW + 2, NOW + 1, ...Array.from({length: 38}, (_, index) => NOW - 1_000 - index)]
    const server = makeSortedServer(times)

    // #when
    const result = await listV2SessionsInDirectory(server.api, REPO_A_DIRECTORY, identity, {
      updatedSince: NOW,
      maxPages: 3,
    })

    // #then
    expect(result.success && result.data).toEqual(['ses_0', 'ses_1'])
  })

  it('still fails when the sessions inside the window overrun the page bound', async () => {
    // #given — every session is recent
    const server = makeSortedServer(Array.from({length: 40}, (_, index) => NOW + 100 - index))

    // #when
    const result = await listV2SessionsInDirectory(server.api, REPO_A_DIRECTORY, identity, {
      updatedSince: NOW,
      maxPages: 3,
    })

    // #then
    expect(result.success).toBe(false)
  })

  it('keeps paging when the list is not in newest-first order', async () => {
    // #given — oldest first
    const server = makeSortedServer([NOW - 40, NOW - 30, NOW - 20, NOW - 10, NOW + 1, NOW + 2])

    // #when
    const result = await listV2SessionsInDirectory(server.api, REPO_A_DIRECTORY, identity, {updatedSince: NOW})

    // #then
    expect(result.success && result.data).toEqual(['ses_4', 'ses_5'])
    expect(server.inputs).toHaveLength(3)
  })

  it('keeps a session whose time cannot be read, and does not stop on one', async () => {
    // #given — the last entry of the first page has no time
    const server = makeSortedServer([NOW + 2, null, NOW - 10, NOW - 20])

    // #when
    const result = await listV2SessionsInDirectory(server.api, REPO_A_DIRECTORY, identity, {updatedSince: NOW})

    // #then — it was kept, the walk went on to the next page, and stopped there
    expect(result.success && result.data).toEqual(['ses_0', 'ses_1'])
    expect(server.inputs).toHaveLength(2)
  })

  it('lists every session and sends no order when no cut-off is given', async () => {
    // #given
    const server = makeSortedServer([NOW - 10, NOW - 20, NOW - 30])

    // #when
    const result = await listV2SessionsInDirectory(server.api, REPO_A_DIRECTORY, identity)

    // #then
    expect(result.success && result.data).toEqual(['ses_0', 'ses_1', 'ses_2'])
    expect(server.inputs.some(input => input.order !== undefined)).toBe(false)
  })
})
