import type {DirectoryActivity, RemoteOpenCodeV2Client} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {DirectoryStopClientV2} from './root-stop-v2.js'

import {err, ok} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {interruptSession, startQuarantineWatchV2, stopDirectoryActivityV2} from './root-stop-v2.js'
import {makeShellServer} from './shell-server-v2.fixture.js'

const ROOT = 'ses_root'
const CHILD = 'ses_child'
const GRAND = 'ses_grand'
const DIRECTORY = '/workspace/repos/o/r'

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function activity(overrides: Partial<DirectoryActivity> = {}): DirectoryActivity {
  return {activeSessionIds: [], runningShellIds: [], queuedInbox: [], ...overrides}
}

type InterruptImpl = DirectoryStopClientV2['interrupt']

function makeStopClient(
  options: {
    readonly interrupt?: InterruptImpl
    readonly shellServer?: Parameters<typeof makeShellServer>[0]
  } = {},
) {
  const shellServer = makeShellServer(options.shellServer)
  const interrupt = vi.fn<InterruptImpl>(async ({sessionId}) => {
    shellServer.log.push(`interrupt:${sessionId}`)
    return options.interrupt === undefined ? ok({interrupted: true}) : options.interrupt({sessionId})
  })
  const client: DirectoryStopClientV2 = {interrupt, deleteShell: shellServer.deleteShell}
  return {client, interrupt, shellServer}
}

afterEach(() => {
  vi.useRealTimers()
})

describe('interruptSession', () => {
  it('reports nothing and never throws when the interrupt fails', async () => {
    // #given
    const logger = makeLogger()
    const {client} = makeStopClient({interrupt: async () => err({kind: 'network', message: 'down'})})

    // #when / #then
    await expect(interruptSession(client, ROOT, new AbortController().signal, logger, 'root')).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: ROOT, role: 'root', error: 'network'}),
      expect.stringContaining('interrupt'),
    )
  })

  it('treats an interrupt reply of false as a no-op worth a debug line, not a warning', async () => {
    // #given
    const logger = makeLogger()
    const {client} = makeStopClient({interrupt: async () => ok({interrupted: false})})

    // #when
    await interruptSession(client, ROOT, new AbortController().signal, logger, 'owned')

    // #then
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: ROOT, interrupted: false}),
      expect.stringContaining('interrupt'),
    )
  })

  it('swallows a thrown interrupt', async () => {
    // #given
    const logger = makeLogger()
    const {client} = makeStopClient({
      interrupt: async () => {
        throw new Error('boom')
      },
    })

    // #when / #then
    await expect(interruptSession(client, ROOT, new AbortController().signal, logger, 'root')).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('stopDirectoryActivityV2', () => {
  const signal = new AbortController().signal

  it('deletes every running shell, then interrupts the root first and every other active session', async () => {
    // #given
    const {client, shellServer} = makeStopClient({
      shellServer: {
        shells: {sh_1: {status: 'running', owner: ROOT}, sh_2: {status: 'running', owner: null}},
      },
    })

    // #when
    await stopDirectoryActivityV2({
      client,
      rootSessionId: ROOT,
      directory: DIRECTORY,
      activity: activity({activeSessionIds: [GRAND, CHILD, ROOT], runningShellIds: ['sh_1', 'sh_2']}),
      signal,
      logger: makeLogger(),
    })

    // #then
    const log = shellServer.log
    expect(log.slice(0, 2).sort()).toEqual(['delete:sh_1', 'delete:sh_2'])
    expect(log[2]).toBe(`interrupt:${ROOT}`)
    expect(log.slice(3).sort()).toEqual([`interrupt:${CHILD}`, `interrupt:${GRAND}`].sort())
  })

  it('passes the directory and the signal to every DELETE', async () => {
    // #given
    const controller = new AbortController()
    const {client, shellServer} = makeStopClient({shellServer: {shells: {sh_1: {status: 'running', owner: ROOT}}}})

    // #when
    await stopDirectoryActivityV2({
      client,
      rootSessionId: ROOT,
      directory: DIRECTORY,
      activity: activity({runningShellIds: ['sh_1']}),
      signal: controller.signal,
      logger: makeLogger(),
    })

    // #then
    expect(shellServer.deleteShell).toHaveBeenCalledWith({
      directory: DIRECTORY,
      shellId: 'sh_1',
      signal: controller.signal,
    })
  })

  it('does nothing for a queued inbox item: only a wake that has started can be interrupted', async () => {
    // #given
    const {client, interrupt, shellServer} = makeStopClient()

    // #when
    await stopDirectoryActivityV2({
      client,
      rootSessionId: ROOT,
      directory: DIRECTORY,
      activity: activity({queuedInbox: [{sessionId: ROOT, queued: 1}]}),
      signal,
      logger: makeLogger(),
    })

    // #then
    expect(interrupt).not.toHaveBeenCalled()
    expect(shellServer.deleteShell).not.toHaveBeenCalled()
  })

  it('keeps going when a DELETE fails or throws, and when an interrupt throws', async () => {
    // #given
    const {client, interrupt} = makeStopClient({
      shellServer: {shells: {sh_1: {status: 'running', owner: ROOT}}, deleteFails: true},
      interrupt: async () => {
        throw new Error('boom')
      },
    })

    // #when / #then
    await expect(
      stopDirectoryActivityV2({
        client,
        rootSessionId: ROOT,
        directory: DIRECTORY,
        activity: activity({activeSessionIds: [ROOT, CHILD], runningShellIds: ['sh_1']}),
        signal,
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined()
    expect(interrupt).toHaveBeenCalledTimes(2)
  })

  it('interrupts the root even when it is not in the activity, if asked to', async () => {
    // #given — the root’s prompt may not be admitted yet
    const {client, interrupt} = makeStopClient()

    // #when
    await stopDirectoryActivityV2({
      client,
      rootSessionId: ROOT,
      directory: DIRECTORY,
      activity: activity({activeSessionIds: [CHILD]}),
      alwaysInterruptRoot: true,
      signal,
      logger: makeLogger(),
    })

    // #then
    expect(interrupt.mock.calls.map(([input]) => input.sessionId)).toEqual([ROOT, CHILD])
  })
})

function startWatch(
  world: {
    active?: string[]
    sessions?: string[]
    shellServer?: Parameters<typeof makeShellServer>[0]
    interrupt?: InterruptImpl
    activeFails?: boolean
    activeHangs?: boolean
  } = {},
  extra: {windowMs?: number} = {},
) {
  vi.useFakeTimers()
  const active = new Set(world.active ?? [])
  const made = makeStopClient({
    shellServer: world.shellServer,
    interrupt: async ({sessionId}) => {
      if (world.interrupt !== undefined) return world.interrupt({sessionId})
      active.delete(sessionId)
      return ok({interrupted: true})
    },
  })
  const activeCalls = vi.fn(async () => {
    if (world.activeHangs === true) return new Promise<never>(() => undefined)
    if (world.activeFails === true) throw new Error('down')
    return Object.fromEntries([...active].map(id => [id, {type: 'running'}]))
  })
  const sessions = world.sessions ?? [ROOT, CHILD]
  const client = {
    ...made.client,
    session: {
      active: activeCalls,
      list: vi.fn(async () => ({data: sessions.map(id => ({id, location: {directory: DIRECTORY}}))})),
    },
    getSession: vi.fn(async ({sessionId}: {sessionId: string}) =>
      sessions.includes(sessionId)
        ? ok({id: sessionId, parentId: null, directory: DIRECTORY, outcome: null})
        : {success: false as const, error: {kind: 'http' as const, status: 404}},
    ),
    listShells: made.shellServer.listShells,
    listSessionInbox: made.shellServer.listSessionInbox,
  } as unknown as RemoteOpenCodeV2Client
  const logger = makeLogger()
  const stop = startQuarantineWatchV2({
    client,
    directory: DIRECTORY,
    rootSessionId: ROOT,
    logger,
    pollIntervalMs: 500,
    ...(extra.windowMs === undefined ? {} : {windowMs: extra.windowMs}),
  })
  return {...made, active, activeCalls, logger, stop}
}

describe('startQuarantineWatchV2', () => {
  it('interrupts every active session of the directory on every tick of the hold, root first', async () => {
    // #given
    const w = startWatch({active: [CHILD, ROOT]})

    // #when
    await vi.advanceTimersByTimeAsync(600)

    // #then
    expect(w.interrupt.mock.calls.map(([input]) => input.sessionId)).toEqual([ROOT, CHILD])
    w.stop()
  })

  it('catches a session that wakes later in the hold, not only at the first tick', async () => {
    // #given — quiet at first
    const w = startWatch()
    await vi.advanceTimersByTimeAsync(2_100)
    expect(w.interrupt).not.toHaveBeenCalled()

    // #when — the root is woken
    w.active.add(ROOT)
    await vi.advanceTimersByTimeAsync(600)

    // #then
    expect(w.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
    w.stop()
  })

  it('deletes every running shell of the directory it finds during the hold, owned or not', async () => {
    // #given
    const w = startWatch({shellServer: {shells: {sh_stray: {status: 'running', owner: null}}}})

    // #when
    await vi.advanceTimersByTimeAsync(600)

    // #then
    expect(w.shellServer.deleteShell).toHaveBeenCalledWith(
      expect.objectContaining({shellId: 'sh_stray', directory: DIRECTORY}),
    )
    expect(w.shellServer.shells).toEqual({})
    w.stop()
  })

  it('catches a shell that starts late in the hold', async () => {
    // #given
    const w = startWatch()
    await vi.advanceTimersByTimeAsync(3_000)

    // #when
    w.shellServer.shells.sh_late = {status: 'running', owner: ROOT}
    await vi.advanceTimersByTimeAsync(600)

    // #then
    expect(w.shellServer.deleteShell).toHaveBeenCalledWith(expect.objectContaining({shellId: 'sh_late'}))
    w.stop()
  })

  it('does not end when the directory looks quiet: the hold runs to the end of its window', async () => {
    // #given
    const w = startWatch({}, {windowMs: 10_000})

    // #when
    await vi.advanceTimersByTimeAsync(9_000)
    const callsBefore = w.activeCalls.mock.calls.length
    await vi.advanceTimersByTimeAsync(900)

    // #then — still polling
    expect(w.activeCalls.mock.calls.length).toBeGreaterThan(callsBefore)
    w.stop()
  })

  it('ends when the hold window closes, and polls no more', async () => {
    // #given
    const w = startWatch({}, {windowMs: 2_000})

    // #when
    await vi.advanceTimersByTimeAsync(2_100)
    const callsAtEnd = w.activeCalls.mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)

    // #then
    expect(w.activeCalls.mock.calls.length).toBe(callsAtEnd)
    expect(w.logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('quarantine hold ended'))
  })

  it('does not read the inbox: only a wake that has started can be stopped', async () => {
    // #given
    const w = startWatch({shellServer: {inbox: {[ROOT]: 3}}})

    // #when
    await vi.advanceTimersByTimeAsync(1_200)

    // #then
    expect(w.shellServer.listSessionInbox).not.toHaveBeenCalled()
    w.stop()
  })

  it('keeps sweeping when the active list cannot be read, and still deletes the shells it can see', async () => {
    // #given
    const w = startWatch({activeFails: true, shellServer: {shells: {sh_1: {status: 'running', owner: ROOT}}}})

    // #when
    await vi.advanceTimersByTimeAsync(1_200)

    // #then
    expect(w.shellServer.deleteShell).toHaveBeenCalledWith(expect.objectContaining({shellId: 'sh_1'}))
    w.stop()
  })

  it('does not stall on a read that never answers', async () => {
    // #given
    const w = startWatch({activeHangs: true})

    // #when — past the per-request cap and a few polls
    await vi.advanceTimersByTimeAsync(20_000)

    // #then — the watch is still ticking
    expect(w.activeCalls.mock.calls.length).toBeGreaterThan(1)
    w.stop()
  })

  it('stops when asked, and stopping twice is safe', async () => {
    // #given
    const w = startWatch()
    await vi.advanceTimersByTimeAsync(600)
    const calls = w.activeCalls.mock.calls.length

    // #when
    w.stop()
    w.stop()
    await vi.advanceTimersByTimeAsync(5_000)

    // #then
    expect(w.activeCalls.mock.calls.length).toBe(calls)
  })
})
