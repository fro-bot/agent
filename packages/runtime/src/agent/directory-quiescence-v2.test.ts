import type {Result} from '@bfra.me/es/result'
import type {DirectoryObservation, DirectoryQuiescenceClient, InboxScope} from './directory-quiescence-v2.js'
import type {V2CallError, V2ShellSummary} from './remote-client-v2.js'

import {err, ok} from '@bfra.me/es/result'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {
  awaitDirectoryStability,
  createDirectoryStabilityGate,
  DIRECTORY_INBOX_RECENT_MARGIN_MS,
  DIRECTORY_QUIESCENCE_MIN_SPACING_MS,
  DIRECTORY_QUIESCENCE_MIN_SPAN_MS,
  DIRECTORY_QUIESCENCE_REQUIRED_OBSERVATIONS,
  observeDirectoryV2,
} from './directory-quiescence-v2.js'

const DIR = '/workspace/repos/o/r'
/** The moment the run began. Sessions are updated just after it unless a test says otherwise. */
const RUN_STARTED = 1_800_000_000_000
const RECENT = RUN_STARTED + 1_000
const TEN_MINUTES_MS = 600_000
const ROOT = 'ses_root'
const CHILD = 'ses_child'
const GRAND = 'ses_grandchild'
const SCOPE: InboxScope = {runStartedAt: RUN_STARTED, ownedSessionIds: () => [ROOT]}

afterEach(() => {
  vi.useRealTimers()
})

interface World {
  /** Sessions stored under DIR. */
  sessions: string[]
  /** Sessions the server lists as running (anywhere). */
  active: string[]
  shells: {id: string; status: V2ShellSummary['status']; owner: string | null}[]
  inbox: Record<string, number>
  /** `time.updated` per session stored under DIR; a session not listed here was updated just after the run began. */
  updated?: Record<string, number>
  /** Sessions the server no longer has (a `getSession` or inbox read of one is a 404). */
  gone?: string[]
}

function emptyWorld(): World {
  return {sessions: [ROOT], active: [], shells: [], inbox: {}}
}

function makeClient(
  world: World,
  hooks: {
    readonly listFails?: boolean
    readonly shellsFail?: boolean
    readonly inboxFails?: readonly string[]
    readonly inboxMissing?: readonly string[]
    readonly activeHangs?: boolean
    readonly pages?: number
    readonly getFails?: readonly string[]
    /** Session lookups that never answer until their signal aborts. */
    readonly getHangs?: readonly string[]
    /** The shell list never answers until its signal aborts. */
    readonly shellsHang?: boolean
    /** The inbox reads of these sessions never answer until their signal aborts. */
    readonly inboxHangs?: readonly string[]
    /** Pages of this many sessions, newest first, following the real `order` and `cursor` contract. */
    readonly pageSize?: number
    /** Ignore `order` and answer oldest first, as a server that did not honour it would. */
    readonly ignoreOrder?: boolean
  } = {},
) {
  const calls: string[] = []
  const client: DirectoryQuiescenceClient = {
    session: {
      active: vi.fn(async (opts?: {signal?: AbortSignal}) => {
        calls.push('active')
        if (hooks.activeHangs === true) {
          return new Promise<never>((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true})
          })
        }
        return Object.fromEntries(world.active.map(id => [id, {type: 'running'}]))
      }),
      list: vi.fn(async (input: {directory?: string; cursor?: string; order?: 'asc' | 'desc'; limit?: number}) => {
        calls.push(`list:${input.directory}:${input.cursor ?? ''}`)
        if (hooks.listFails === true) throw new Error('list failed')
        const updatedOf = (id: string): number => world.updated?.[id] ?? RECENT
        const info = (id: string) => ({id, location: {directory: DIR}, time: {updated: updatedOf(id)}})
        if (hooks.pages !== undefined && hooks.pages > 1) {
          const page = input.cursor === undefined ? 0 : Number(input.cursor)
          const size = Math.ceil(world.sessions.length / hooks.pages)
          const data = world.sessions.slice(page * size, (page + 1) * size).map(info)
          return page + 1 < hooks.pages ? {data, cursor: {next: String(page + 1)}} : {data}
        }
        const ordered = [...world.sessions].sort((a, b) => updatedOf(b) - updatedOf(a))
        const sequence = input.order === 'desc' && hooks.ignoreOrder !== true ? ordered : [...ordered].reverse()
        const size = hooks.pageSize ?? input.limit ?? sequence.length
        const start = input.cursor === undefined ? 0 : Number(input.cursor)
        const data = sequence.slice(start, start + size).map(info)
        return start + size < sequence.length ? {data, cursor: {next: String(start + size)}} : {data}
      }),
    },
    getSession: vi.fn(
      async ({
        sessionId,
        signal,
      }: {
        readonly sessionId: string
        readonly signal?: AbortSignal
      }): Promise<
        Result<{id: string; parentId: string | null; directory: string | null; outcome: null}, V2CallError>
      > => {
        calls.push(`get:${sessionId}`)
        if (hooks.getHangs?.includes(sessionId) === true) {
          return new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true})
          })
        }
        if (hooks.getFails?.includes(sessionId) === true) return err({kind: 'network', message: 'down'})
        if (world.gone?.includes(sessionId) === true) return err({kind: 'http', status: 404})
        const here = world.sessions.includes(sessionId)
        return ok({id: sessionId, parentId: null, directory: here ? DIR : '/workspace/repos/other', outcome: null})
      },
    ),
    listShells: vi.fn(
      async ({signal}: {readonly signal?: AbortSignal} = {}): Promise<
        Result<readonly V2ShellSummary[], V2CallError>
      > => {
        calls.push('shells')
        if (hooks.shellsHang === true) {
          return new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true})
          })
        }
        if (hooks.shellsFail === true) return err({kind: 'network', message: 'down'})
        return ok(
          world.shells
            .filter(shell => shell.status === 'running' || shell.status === 'unknown')
            .map(shell => ({id: shell.id, status: shell.status, ownerSessionId: shell.owner, pid: 1})),
        )
      },
    ),
    listSessionInbox: vi.fn(
      async ({
        sessionId,
        signal,
      }: {
        readonly sessionId: string
        readonly signal?: AbortSignal
      }): Promise<Result<{queued: number}, V2CallError>> => {
        calls.push(`inbox:${sessionId}`)
        if (hooks.inboxHangs?.includes(sessionId) === true) {
          return new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true})
          })
        }
        if (hooks.inboxFails?.includes(sessionId) === true) return err({kind: 'network', message: 'down'})
        if (hooks.inboxMissing?.includes(sessionId) === true) return err({kind: 'http', status: 404})
        return ok({queued: world.inbox[sessionId] ?? 0})
      },
    ),
  }
  return {client, calls}
}

const identityRealpath = async (path: string): Promise<string> => path

describe('observeDirectoryV2', () => {
  it('is quiescent when nothing is active, running or queued in the directory', async () => {
    // #given
    const world = emptyWorld()
    const {client} = makeClient(world)

    // #when
    const observation = await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: SCOPE})

    // #then
    expect(observation).toEqual({kind: 'quiescent'})
  })

  it('reports every active session of the directory: root, child, grandchild and a resumed descendant alike', async () => {
    // #given — the join is on the directory, not on what the run adopted
    const world: World = {
      sessions: [ROOT, CHILD, GRAND, 'ses_resumed'],
      active: [CHILD, GRAND, 'ses_resumed', 'ses_elsewhere'],
      shells: [],
      inbox: {},
    }
    const {client} = makeClient(world)

    // #when
    const observation = await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: SCOPE})

    // #then — a session active elsewhere on the server is not this directory's
    expect(observation).toMatchObject({kind: 'active'})
    if (observation.kind !== 'active') throw new Error('unreachable')
    expect([...activityOf(observation).activeSessionIds].sort()).toEqual([CHILD, GRAND, 'ses_resumed'].sort())
  })

  it('reports a running shell whoever owns it, and counts a status it does not know as running', async () => {
    // #given
    const world = emptyWorld()
    world.shells = [
      {id: 'sh_owned', status: 'running', owner: ROOT},
      {id: 'sh_untagged', status: 'running', owner: null},
      {id: 'sh_stranger', status: 'unknown', owner: 'ses_stranger'},
      {id: 'sh_done', status: 'exited', owner: ROOT},
    ]
    const {client} = makeClient(world)

    // #when
    const observation = await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: SCOPE})

    // #then
    if (observation.kind !== 'active') throw new Error('expected activity')
    expect([...activityOf(observation).runningShellIds].sort()).toEqual(['sh_owned', 'sh_stranger', 'sh_untagged'])
  })

  it('reports a queued inbox item on any session of the directory, active or not', async () => {
    // #given — an idle session with a notice enqueued and its wake not yet started
    const world: World = {sessions: [ROOT, CHILD], active: [], shells: [], inbox: {[CHILD]: 2}}
    const {client, calls} = makeClient(world)

    // #when
    const observation = await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: SCOPE})

    // #then — read per directory session, not per adopted session
    expect(observation).toMatchObject({kind: 'active', activity: {queuedInbox: [{sessionId: CHILD, queued: 2}]}})
    expect(calls).toContain(`inbox:${ROOT}`)
    expect(calls).toContain(`inbox:${CHILD}`)
  })

  it('reads the inbox of a session on a later page', async () => {
    // #given
    const sessions = Array.from({length: 7}, (_, i) => `ses_${i}`)
    const world: World = {sessions, active: [], shells: [], inbox: {ses_6: 1}}
    const {client} = makeClient(world, {pages: 3})

    // #when
    const observation = await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: SCOPE})

    // #then
    expect(observation).toMatchObject({kind: 'active', activity: {queuedInbox: [{sessionId: 'ses_6', queued: 1}]}})
  })

  it('reads a session that vanished between the list and the inbox read as having nothing queued', async () => {
    // #given
    const world = emptyWorld()
    const {client} = makeClient(world, {inboxMissing: [ROOT]})

    // #when / #then
    expect(await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: SCOPE})).toEqual({
      kind: 'quiescent',
    })
  })

  it('is unreadable, never quiescent, when any one read fails', async () => {
    // #given
    const cases: readonly Parameters<typeof makeClient>[1][] = [
      {listFails: true},
      {shellsFail: true},
      {inboxFails: [ROOT]},
    ]

    for (const hooks of cases) {
      const {client} = makeClient(emptyWorld(), hooks)

      // #when
      const observation = await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: SCOPE})

      // #then
      expect({hooks, kind: observation.kind}).toEqual({hooks, kind: 'unreadable'})
    }
  })

  it('keeps what the other reads saw when one of them fails, so the stop path can still act on it', async () => {
    // #given — the shell list fails, the session reads work and show a running child
    const world: World = {sessions: [ROOT, CHILD], active: [CHILD], shells: [], inbox: {}}
    const {client} = makeClient(world, {shellsFail: true})

    // #when
    const observation = await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: SCOPE})

    // #then
    expect(observation).toMatchObject({kind: 'unreadable', activity: {activeSessionIds: [CHILD]}})
  })

  it('treats a failed realpath as unreadable', async () => {
    // #given
    const {client} = makeClient(emptyWorld())

    // #when
    const observation = await observeDirectoryV2({
      client,
      directory: DIR,
      inbox: SCOPE,
      realpath: async () => {
        throw new Error('no such directory')
      },
    })

    // #then
    expect(observation.kind).toBe('unreadable')
  })

  it('bounds a read that never answers by the read timeout, passing the signal on', async () => {
    // #given
    vi.useFakeTimers()
    const {client} = makeClient(emptyWorld(), {activeHangs: true})

    // #when
    const pending = observeDirectoryV2({
      client,
      directory: DIR,
      inbox: SCOPE,
      realpath: identityRealpath,
      readTimeoutMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(1_001)

    // #then
    expect((await pending).kind).toBe('unreadable')
  })

  it('is unreadable when the caller’s signal is already aborted, without a request', async () => {
    // #given
    const {client, calls} = makeClient(emptyWorld())
    const controller = new AbortController()
    controller.abort()

    // #when
    const observation = await observeDirectoryV2({
      client,
      directory: DIR,
      inbox: SCOPE,
      realpath: identityRealpath,
      signal: controller.signal,
    })

    // #then
    expect(observation.kind).toBe('unreadable')
    expect(calls).toEqual([])
  })

  it('skips the inbox reads when asked: the kill-and-interrupt sweep does not need them', async () => {
    // #given
    const world: World = {sessions: [ROOT, CHILD], active: [], shells: [], inbox: {[CHILD]: 1}}
    const {client, calls} = makeClient(world)

    // #when
    const observation = await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: false})

    // #then
    expect(observation).toEqual({kind: 'quiescent'})
    expect(calls.some(call => call.startsWith('inbox:'))).toBe(false)
  })
})

describe('createDirectoryStabilityGate', () => {
  const QUIET: DirectoryObservation = {kind: 'quiescent'}
  const BUSY: DirectoryObservation = {
    kind: 'active',
    activity: {activeSessionIds: [ROOT], runningShellIds: [], queuedInbox: []},
  }
  const UNREADABLE: DirectoryObservation = {
    kind: 'unreadable',
    reason: 'shell.list failed',
    activity: {activeSessionIds: [], runningShellIds: [], queuedInbox: []},
  }

  function makeGate(script: DirectoryObservation[], options: {now?: () => number} = {}) {
    let clock = 0
    const observe = vi.fn(async () => script.shift() ?? QUIET)
    const gate = createDirectoryStabilityGate({observe, now: options.now ?? (() => clock)})
    return {
      gate,
      observe,
      advance: (ms: number) => {
        clock += ms
      },
      at: () => clock,
    }
  }

  const signal = new AbortController().signal

  it('uses eleven observations, 500 ms apart, over 5 s', () => {
    // #given / #then
    expect(DIRECTORY_QUIESCENCE_REQUIRED_OBSERVATIONS).toBe(11)
    expect(DIRECTORY_QUIESCENCE_MIN_SPACING_MS).toBe(500)
    expect(DIRECTORY_QUIESCENCE_MIN_SPAN_MS).toBe(5_000)
  })

  it('passes only on the eleventh consecutive quiescent observation, 5 s after the first', async () => {
    // #given
    const t = makeGate([])

    // #when / #then — ten quiet observations are not enough
    for (let i = 0; i < 10; i++) {
      const state = await t.gate.step(signal)
      expect(state.passed, `observation ${i + 1}`).toBe(false)
      expect(state.streak).toBe(i + 1)
      t.advance(500)
    }
    const eleventh = await t.gate.step(signal)
    expect(eleventh).toMatchObject({passed: true, streak: 11, spanMs: 5_000})
  })

  it('needs the span as well as the count: enough observations over too short a time do not pass', async () => {
    // #given — three observations are required, 100 ms apart, over at least 5 s
    let clock = 0
    const gate = createDirectoryStabilityGate({
      observe: async () => ({kind: 'quiescent'}),
      now: () => clock,
      requiredObservations: 3,
      minSpacingMs: 100,
      minSpanMs: 5_000,
    })

    // #when — the count is met at 200 ms
    await gate.step(signal)
    clock = 100
    await gate.step(signal)
    clock = 200
    const countMet = await gate.step(signal)
    clock = 4_900
    const nearly = await gate.step(signal)
    clock = 5_000
    const spanMet = await gate.step(signal)

    // #then
    expect(countMet).toMatchObject({passed: false, streak: 3, spanMs: 200})
    expect(nearly.passed).toBe(false)
    expect(spanMet).toMatchObject({passed: true, spanMs: 5_000})
  })

  it('does not count an observation taken sooner than the spacing after the last counted one', async () => {
    // #given
    const t = makeGate([])

    // #when
    await t.gate.step(signal)
    t.advance(100)
    const early = await t.gate.step(signal)
    t.advance(400)
    const onTime = await t.gate.step(signal)

    // #then
    expect(early.streak).toBe(1)
    expect(onTime.streak).toBe(2)
  })

  it('resets the count on any activity and starts the window again', async () => {
    // #given — nine quiet observations, then a wake
    const t = makeGate([QUIET, QUIET, QUIET, QUIET, QUIET, QUIET, QUIET, QUIET, QUIET, BUSY])
    for (let i = 0; i < 9; i++) {
      await t.gate.step(signal)
      t.advance(500)
    }

    // #when
    const busy = await t.gate.step(signal)
    t.advance(500)
    const after = await t.gate.step(signal)

    // #then
    expect(busy).toMatchObject({passed: false, streak: 0})
    expect(after.streak).toBe(1)
    // and the full window is needed again
    let state = after
    for (let i = 0; i < 9; i++) {
      t.advance(500)
      state = await t.gate.step(signal)
      expect(state.passed).toBe(false)
    }
    t.advance(500)
    expect((await t.gate.step(signal)).passed).toBe(true)
  })

  it('resets the count on a failed read, and a failed read never counts as quiet', async () => {
    // #given
    const t = makeGate([QUIET, QUIET, QUIET, UNREADABLE])
    for (let i = 0; i < 3; i++) {
      await t.gate.step(signal)
      t.advance(500)
    }

    // #when
    const failed = await t.gate.step(signal)

    // #then
    expect(failed).toMatchObject({passed: false, streak: 0})
    expect(failed.last).toEqual(UNREADABLE)
  })

  it('resets when an observation throws', async () => {
    // #given
    const observe = vi
      .fn()
      .mockResolvedValueOnce(QUIET)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(QUIET)
    let clock = 0
    const gate = createDirectoryStabilityGate({observe, now: () => clock})
    await gate.step(signal)
    clock += 500

    // #when
    const thrown = await gate.step(signal)

    // #then
    expect(thrown).toMatchObject({passed: false, streak: 0})
    expect(thrown.last?.kind).toBe('unreadable')
  })

  it('can be reset by the caller, for activity the gate did not see', async () => {
    // #given
    const t = makeGate([])
    await t.gate.step(signal)
    t.advance(500)
    await t.gate.step(signal)

    // #when
    t.gate.reset()

    // #then
    expect(t.gate.state().streak).toBe(0)
    expect((await t.gate.step(signal)).streak).toBe(1)
  })

  it('keeps passing nothing once passed is a point-in-time fact: a later activity unpasses it', async () => {
    // #given
    const t = makeGate([])
    for (let i = 0; i < 10; i++) {
      await t.gate.step(signal)
      t.advance(500)
    }
    expect((await t.gate.step(signal)).passed).toBe(true)

    // #when
    t.observe.mockResolvedValueOnce(BUSY)
    t.advance(500)
    const state = await t.gate.step(signal)

    // #then
    expect(state.passed).toBe(false)
  })
})

describe('observeDirectoryV2: which inboxes are read', () => {
  const inboxCalls = (calls: readonly string[]): string[] => calls.filter(call => call.startsWith('inbox:'))

  it('never reads the inbox of an old idle session, even one with an item queued', async () => {
    // #given — a session of an earlier run, last updated long before this one began
    const world: World = {
      sessions: [ROOT, 'ses_old'],
      active: [],
      shells: [],
      inbox: {ses_old: 3},
      updated: {ses_old: RUN_STARTED - TEN_MINUTES_MS - 60_000},
    }
    const {client, calls} = makeClient(world)

    // #when
    const observation = await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: SCOPE})

    // #then — it already passed its own release gate
    expect(observation).toEqual({kind: 'quiescent'})
    expect(inboxCalls(calls)).toEqual([`inbox:${ROOT}`])
  })

  it('reads the inbox of a session updated after the run started', async () => {
    // #given
    const world: World = {
      sessions: [ROOT, 'ses_woken'],
      active: [],
      shells: [],
      inbox: {ses_woken: 1},
      updated: {ses_woken: RUN_STARTED + 30_000},
    }
    const {client} = makeClient(world)

    // #when
    const observation = await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: SCOPE})

    // #then
    expect(observation).toMatchObject({kind: 'active', activity: {queuedInbox: [{sessionId: 'ses_woken', queued: 1}]}})
  })

  it('draws the line at the margin before the run started', async () => {
    // #given — one second inside the margin, one second outside it
    const world: World = {
      sessions: ['ses_inside', 'ses_outside'],
      active: [],
      shells: [],
      inbox: {},
      updated: {
        ses_inside: RUN_STARTED - TEN_MINUTES_MS + 1_000,
        ses_outside: RUN_STARTED - TEN_MINUTES_MS - 1_000,
      },
    }
    const {client, calls} = makeClient(world)

    // #when
    await observeDirectoryV2({
      client,
      directory: DIR,
      realpath: identityRealpath,
      inbox: {runStartedAt: RUN_STARTED, ownedSessionIds: () => []},
    })

    // #then
    expect(DIRECTORY_INBOX_RECENT_MARGIN_MS).toBe(TEN_MINUTES_MS)
    expect(inboxCalls(calls)).toEqual(['inbox:ses_inside'])
  })

  it('reads an owned session whatever its time, once, and a session that is both owned and recent only once', async () => {
    // #given
    const world: World = {
      sessions: [ROOT, CHILD],
      active: [],
      shells: [],
      inbox: {[CHILD]: 1},
      updated: {[CHILD]: RUN_STARTED - 24 * 60 * 60 * 1000},
    }
    const {client, calls} = makeClient(world)

    // #when
    const observation = await observeDirectoryV2({
      client,
      directory: DIR,
      realpath: identityRealpath,
      inbox: {runStartedAt: RUN_STARTED, ownedSessionIds: () => [ROOT, CHILD]},
    })

    // #then
    expect(observation).toMatchObject({kind: 'active', activity: {queuedInbox: [{sessionId: CHILD, queued: 1}]}})
    expect(inboxCalls(calls).sort()).toEqual([`inbox:${CHILD}`, `inbox:${ROOT}`].sort())
  })

  it('reads as quiet over a stored history of 5000 sessions with 3 recent: three inbox reads, one list page', async () => {
    // #given — the failure this bound removes: past the list page bound the directory never read as quiet
    const old = Array.from({length: 4_997}, (_, index) => `ses_old_${String(index)}`)
    const recent = ['ses_recent_a', 'ses_recent_b', 'ses_recent_c']
    const updated: Record<string, number> = {}
    for (const [index, id] of old.entries()) updated[id] = RUN_STARTED - 60 * 60 * 1000 - index
    const world: World = {sessions: [...old, ...recent], active: [], shells: [], inbox: {}, updated}
    const {client, calls} = makeClient(world, {pageSize: 100})

    // #when
    const observation = await observeDirectoryV2({
      client,
      directory: DIR,
      realpath: identityRealpath,
      inbox: {runStartedAt: RUN_STARTED, ownedSessionIds: () => []},
    })

    // #then
    expect(observation).toEqual({kind: 'quiescent'})
    expect(inboxCalls(calls).sort()).toEqual(recent.map(id => `inbox:${id}`).sort())
    expect(calls.filter(call => call.startsWith('list:'))).toHaveLength(1)
  })

  it('keeps paging while the recent sessions fill whole pages, and stops at the first page that reaches the cut-off', async () => {
    // #given — 250 recent sessions then old ones, pages of 100
    const recent = Array.from({length: 250}, (_, index) => `ses_r${String(index)}`)
    const old = Array.from({length: 400}, (_, index) => `ses_o${String(index)}`)
    const updated: Record<string, number> = {}
    for (const [index, id] of recent.entries()) updated[id] = RUN_STARTED + 10_000 - index
    for (const [index, id] of old.entries()) updated[id] = RUN_STARTED - 3_600_000 - index
    const world: World = {sessions: [...recent, ...old], active: [], shells: [], inbox: {ses_r249: 1}, updated}
    const {client, calls} = makeClient(world, {pageSize: 100})

    // #when
    const observation = await observeDirectoryV2({
      client,
      directory: DIR,
      realpath: identityRealpath,
      inbox: {runStartedAt: RUN_STARTED, ownedSessionIds: () => []},
    })

    // #then — the last recent session was reached, and the walk ended on the third page
    expect(observation).toMatchObject({kind: 'active', activity: {queuedInbox: [{sessionId: 'ses_r249', queued: 1}]}})
    expect(calls.filter(call => call.startsWith('list:'))).toHaveLength(3)
    expect(inboxCalls(calls)).toHaveLength(250)
  })

  it('does not cut the list short when the server does not return it newest first', async () => {
    // #given — a server that ignores `order`: oldest first, so the recent session is on the last page
    const old = Array.from({length: 250}, (_, index) => `ses_o${String(index)}`)
    const updated: Record<string, number> = {}
    for (const [index, id] of old.entries()) updated[id] = RUN_STARTED - 3_600_000 + index
    updated.ses_late = RUN_STARTED + 5_000
    const world: World = {sessions: [...old, 'ses_late'], active: [], shells: [], inbox: {ses_late: 2}, updated}
    const {client} = makeClient(world, {pageSize: 100, ignoreOrder: true})

    // #when
    const observation = await observeDirectoryV2({
      client,
      directory: DIR,
      realpath: identityRealpath,
      inbox: {runStartedAt: RUN_STARTED, ownedSessionIds: () => []},
    })

    // #then
    expect(observation).toMatchObject({kind: 'active', activity: {queuedInbox: [{sessionId: 'ses_late', queued: 2}]}})
  })

  it('is unreadable, not quiet, when even the recent sessions overrun the page bound', async () => {
    // #given — 2100 sessions all updated since the run began
    const sessions = Array.from({length: 2_100}, (_, index) => `ses_${String(index)}`)
    const updated = Object.fromEntries(sessions.map((id, index) => [id, RECENT + 10_000 - index]))
    const world: World = {sessions, active: [], shells: [], inbox: {}, updated}
    const {client} = makeClient(world, {pageSize: 100})

    // #when
    const observation = await observeDirectoryV2({
      client,
      directory: DIR,
      realpath: identityRealpath,
      inbox: {runStartedAt: RUN_STARTED, ownedSessionIds: () => []},
    })

    // #then
    expect(observation.kind).toBe('unreadable')
  })

  it('makes no list or inbox request when the inbox is skipped', async () => {
    // #given
    const {client, calls} = makeClient(emptyWorld())

    // #when
    await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: false})

    // #then
    expect(calls.some(call => call.startsWith('list:') || call.startsWith('inbox:'))).toBe(false)
  })
})

/** What a reading that was not quiet saw. */
function activityOf(observation: DirectoryObservation) {
  if (observation.kind === 'quiescent') throw new Error('expected a reading that was not quiet')
  return observation.activity
}

describe('observeDirectoryV2: an incomplete reading keeps what it found', () => {
  const SHORT = 200

  it('keeps the placed sessions when another session lookup fails', async () => {
    // #given — three active sessions; one lookup fails, two are placed in the directory
    const world: World = {sessions: [ROOT, CHILD], active: [ROOT, CHILD, 'ses_unlocatable'], shells: [], inbox: {}}
    const {client} = makeClient(world, {getFails: ['ses_unlocatable']})

    // #when
    const observation = await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: false})

    // #then — unreadable for the release, and the two it did place are still there to be stopped
    expect(observation.kind).toBe('unreadable')
    expect([...activityOf(observation).activeSessionIds].sort()).toEqual([CHILD, ROOT].sort())
  })

  it('keeps the placed sessions when one lookup never answers', async () => {
    // #given
    vi.useFakeTimers()
    const world: World = {sessions: [ROOT, CHILD], active: [ROOT, CHILD, 'ses_slow'], shells: [], inbox: {}}
    const {client} = makeClient(world, {getHangs: ['ses_slow']})

    // #when
    const pending = observeDirectoryV2({
      client,
      directory: DIR,
      realpath: identityRealpath,
      inbox: false,
      readTimeoutMs: SHORT,
    })
    await vi.advanceTimersByTimeAsync(SHORT + 10)
    const observation = await pending

    // #then
    expect(observation.kind).toBe('unreadable')
    expect([...activityOf(observation).activeSessionIds].sort()).toEqual([CHILD, ROOT].sort())
  })

  it('keeps a running shell when the active read times out', async () => {
    // #given — the shell list answered; the active list never does
    vi.useFakeTimers()
    const world = emptyWorld()
    world.shells = [{id: 'sh_known', status: 'running', owner: ROOT}]
    const {client} = makeClient(world, {activeHangs: true})

    // #when
    const pending = observeDirectoryV2({
      client,
      directory: DIR,
      realpath: identityRealpath,
      inbox: false,
      readTimeoutMs: SHORT,
    })
    await vi.advanceTimersByTimeAsync(SHORT + 10)
    const observation = await pending

    // #then
    expect(observation.kind).toBe('unreadable')
    expect(activityOf(observation).runningShellIds).toEqual(['sh_known'])
  })

  it('keeps the active sessions when the shell list times out', async () => {
    // #given
    vi.useFakeTimers()
    const world: World = {sessions: [ROOT, CHILD], active: [CHILD], shells: [], inbox: {}}
    const {client} = makeClient(world, {shellsHang: true})

    // #when
    const pending = observeDirectoryV2({
      client,
      directory: DIR,
      realpath: identityRealpath,
      inbox: false,
      readTimeoutMs: SHORT,
    })
    await vi.advanceTimersByTimeAsync(SHORT + 10)
    const observation = await pending

    // #then
    expect(observation.kind).toBe('unreadable')
    expect(activityOf(observation).activeSessionIds).toEqual([CHILD])
  })

  it('keeps a queued inbox item when another inbox read times out', async () => {
    // #given
    vi.useFakeTimers()
    const world: World = {sessions: [ROOT, CHILD], active: [], shells: [], inbox: {[CHILD]: 2}}
    const {client} = makeClient(world, {inboxHangs: [ROOT]})

    // #when
    const pending = observeDirectoryV2({
      client,
      directory: DIR,
      realpath: identityRealpath,
      inbox: SCOPE,
      readTimeoutMs: SHORT,
    })
    await vi.advanceTimersByTimeAsync(SHORT + 10)
    const observation = await pending

    // #then
    expect(observation.kind).toBe('unreadable')
    expect(activityOf(observation).queuedInbox).toEqual([{sessionId: CHILD, queued: 2}])
  })

  it('keeps what completed when the caller aborts the reading', async () => {
    // #given
    const world: World = {sessions: [ROOT, CHILD], active: [ROOT, CHILD, 'ses_slow'], shells: [], inbox: {}}
    const {client} = makeClient(world, {getHangs: ['ses_slow']})
    const controller = new AbortController()

    // #when
    const pending = observeDirectoryV2({
      client,
      directory: DIR,
      realpath: identityRealpath,
      inbox: false,
      signal: controller.signal,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    const observation = await pending

    // #then
    expect(observation.kind).toBe('unreadable')
    expect([...activityOf(observation).activeSessionIds].sort()).toEqual([CHILD, ROOT].sort())
  })

  it('counts a known session as active when it is on the active list, without locating it', async () => {
    // #given — a session that moved: it is stored under another directory now, and its lookup would say so
    const world: World = {sessions: [ROOT], active: ['ses_moved'], shells: [], inbox: {}}
    const {client, calls} = makeClient(world)

    // #when
    const observation = await observeDirectoryV2({
      client,
      directory: DIR,
      realpath: identityRealpath,
      inbox: false,
      knownSessionIds: () => ['ses_moved', 'ses_not_active'],
    })

    // #then — active wherever it is, and not looked up
    expect(observation).toMatchObject({kind: 'active', activity: {activeSessionIds: ['ses_moved']}})
    expect(calls).not.toContain('get:ses_moved')
  })

  it('does not count a known session that is not active', async () => {
    // #given
    const world: World = {sessions: [ROOT], active: [], shells: [], inbox: {}}
    const {client} = makeClient(world)

    // #when
    const observation = await observeDirectoryV2({
      client,
      directory: DIR,
      realpath: identityRealpath,
      inbox: false,
      knownSessionIds: () => ['ses_moved'],
    })

    // #then
    expect(observation).toEqual({kind: 'quiescent'})
  })
})

describe('observeDirectoryV2: locating the active sessions', () => {
  it('does not list the directory to place an active session: the cost follows the active list, not the history', async () => {
    // #given — a long history, and a session active in another repo
    const sessions = Array.from({length: 5_000}, (_, index) => `ses_old_${String(index)}`)
    const world: World = {sessions, active: ['ses_elsewhere'], shells: [], inbox: {}}
    const {client, calls} = makeClient(world)

    // #when
    const observation = await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: false})

    // #then
    expect(observation).toEqual({kind: 'quiescent'})
    expect(calls).toContain('get:ses_elsewhere')
    expect(calls.some(call => call.startsWith('list:'))).toBe(false)
  })

  it('places an active session by its stored directory, canonicalised first', async () => {
    // #given — the caller holds a symlinked path; the session is stored under the canonical one
    const world: World = {sessions: [CHILD], active: [CHILD, 'ses_elsewhere'], shells: [], inbox: {}}
    const {client} = makeClient(world)

    // #when
    const observation = await observeDirectoryV2({
      client,
      directory: '/link/r',
      realpath: async path => (path === '/link/r' ? DIR : path),
      inbox: false,
    })

    // #then
    expect(observation).toMatchObject({kind: 'active', activity: {activeSessionIds: [CHILD]}})
  })

  it('ignores an active session that was deleted between the two reads', async () => {
    // #given
    const world: World = {sessions: [ROOT], active: ['ses_gone'], shells: [], inbox: {}, gone: ['ses_gone']}
    const {client} = makeClient(world)

    // #when / #then
    expect(await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: false})).toEqual({
      kind: 'quiescent',
    })
  })

  it('is unreadable when an active session cannot be located, never quiet', async () => {
    // #given
    const world: World = {sessions: [ROOT], active: ['ses_unlocatable'], shells: [], inbox: {}}
    const {client} = makeClient(world, {getFails: ['ses_unlocatable']})

    // #when
    const observation = await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: false})

    // #then
    expect(observation.kind).toBe('unreadable')
  })

  it('is unreadable on an active list that is not an object keyed by session id', async () => {
    // #given
    const {client: base} = makeClient(emptyWorld())
    const client: DirectoryQuiescenceClient = {...base, session: {...base.session, active: async () => [] as never}}

    // #when
    const observation = await observeDirectoryV2({client, directory: DIR, realpath: identityRealpath, inbox: false})

    // #then
    expect(observation.kind).toBe('unreadable')
  })
})

function setupGate(script: DirectoryObservation[]) {
  vi.useFakeTimers()
  const observe = vi.fn(async () => script.shift() ?? ({kind: 'quiescent'} as const))
  const gate = createDirectoryStabilityGate({observe})
  return {gate, observe}
}

describe('awaitDirectoryStability', () => {
  const setup = setupGate

  it('spaces the observations 500 ms apart and passes after 5 s', async () => {
    // #given
    const {gate, observe} = setup([])
    const controller = new AbortController()

    // #when
    const waiting = awaitDirectoryStability({gate, signal: controller.signal})
    await vi.advanceTimersByTimeAsync(4_900)
    expect(observe).toHaveBeenCalledTimes(10)
    await vi.advanceTimersByTimeAsync(200)

    // #then
    expect(await waiting).toMatchObject({passed: true})
    expect(observe).toHaveBeenCalledTimes(11)
  })

  it('keeps going through activity until a full quiet window has passed', async () => {
    // #given — a wake at the fourth observation
    const busy: DirectoryObservation = {
      kind: 'active',
      activity: {activeSessionIds: [CHILD], runningShellIds: [], queuedInbox: []},
    }
    const {gate, observe} = setup([{kind: 'quiescent'}, {kind: 'quiescent'}, {kind: 'quiescent'}, busy])
    const seen: string[] = []

    // #when
    const waiting = awaitDirectoryStability({
      gate,
      signal: new AbortController().signal,
      onObservation: state => seen.push(state.last?.kind ?? 'none'),
    })
    await vi.advanceTimersByTimeAsync(20_000)

    // #then — 4 observations to the wake, then 11 more
    expect(await waiting).toMatchObject({passed: true})
    expect(observe).toHaveBeenCalledTimes(15)
    expect(seen.filter(kind => kind === 'active')).toHaveLength(1)
  })

  it('stops when the caller says the evidence it was waiting for is gone', async () => {
    // #given
    const {gate} = setup([])
    let keep = true

    // #when
    const waiting = awaitDirectoryStability({gate, signal: new AbortController().signal, shouldContinue: () => keep})
    await vi.advanceTimersByTimeAsync(1_000)
    keep = false
    await vi.advanceTimersByTimeAsync(600)

    // #then — and the streak does not carry over to whatever comes next
    expect(await waiting).toEqual({passed: false, reason: 'invalidated'})
    expect(gate.state().streak).toBe(0)
  })

  it('does not pass on a reading that would have passed when the evidence changed while it was in flight', async () => {
    // #given — the reading that completes the window is held; the caller's evidence changes before it returns
    vi.useFakeTimers()
    let keep = true
    let readings = 0
    const gate = createDirectoryStabilityGate({
      requiredObservations: 2,
      minSpacingMs: 10,
      minSpanMs: 10,
      observe: async () => {
        readings += 1
        if (readings === 2) keep = false
        return {kind: 'quiescent'} as const
      },
    })

    // #when
    const waiting = awaitDirectoryStability({
      gate,
      signal: new AbortController().signal,
      spacingMs: 10,
      shouldContinue: () => keep,
    })
    await vi.advanceTimersByTimeAsync(100)

    // #then — invalidated and the count dropped, instead of passing on a streak counted for the old evidence
    expect(await waiting).toEqual({passed: false, reason: 'invalidated'})
    expect(gate.state()).toMatchObject({passed: false, streak: 0})
  })

  it('stops on abort, mid-sleep, with an unpassed result', async () => {
    // #given
    const {gate} = setup([])
    const controller = new AbortController()

    // #when
    const waiting = awaitDirectoryStability({gate, signal: controller.signal})
    await vi.advanceTimersByTimeAsync(700)
    controller.abort()
    await vi.advanceTimersByTimeAsync(10)

    // #then
    expect(await waiting).toEqual({passed: false, reason: 'aborted'})
  })
})
