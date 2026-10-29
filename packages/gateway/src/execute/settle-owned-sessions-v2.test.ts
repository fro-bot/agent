import type {DirectoryStabilityTuning, RemoteOpenCodeV2Client} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {ShellServerOptions} from './shell-server-v2.fixture.js'

import {createOwnershipLedger, ok, shellLedgerKey} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {DEFAULT_SETTLE_TIMEOUT_MS, settleOwnedSessionsV2} from './settle-owned-sessions-v2.js'
import {makeShellServer} from './shell-server-v2.fixture.js'

const ROOT = 'ses_root'
const CHILD = 'ses_child'
const GRAND = 'ses_grandchild'
const SHELL = 'sh_bg1'
const DIR = '/workspace/repos/o/r'
/** The run began a moment ago: sessions the fakes list carry no time, and are read whatever the cut-off. */
const RUN_STARTED = 1_800_000_000_000

/** A short window for the tests that are not about the window itself: 3 readings, 50 ms apart, over 100 ms. */
const FAST: DirectoryStabilityTuning = {requiredObservations: 3, minSpacingMs: 50, minSpanMs: 100}

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

interface ServerOptions {
  /** Sessions stored under the directory. */
  readonly sessions?: readonly string[]
  /** Sessions of earlier runs stored under the directory: last updated an hour before `RUN_STARTED`. */
  readonly oldSessions?: readonly string[]
  /** Sessions that are active before any interrupt. */
  readonly active?: readonly string[]
  /** Sessions an interrupt does NOT stop. */
  readonly unstoppable?: readonly string[]
  readonly interruptFails?: boolean
  readonly activeFails?: boolean
  readonly shellServer?: ShellServerOptions
}

function makeServer(options: ServerOptions = {}) {
  const shellServer = makeShellServer(options.shellServer)
  const sessions = [...(options.sessions ?? [ROOT])]
  const active = new Set(options.active ?? [])
  const interrupt = vi.fn(async ({sessionId}: {sessionId: string}) => {
    shellServer.log.push(`interrupt:${sessionId}`)
    if (options.interruptFails === true)
      return {success: false as const, error: {kind: 'network' as const, message: 'down'}}
    if (options.unstoppable?.includes(sessionId) !== true) active.delete(sessionId)
    return ok({interrupted: true})
  })
  const activeCalls = vi.fn(async () => {
    shellServer.log.push('active')
    if (options.activeFails === true) throw new Error('session.active failed: http 503')
    return Object.fromEntries([...active].map(id => [id, {type: 'running'}]))
  })
  const client = {
    session: {
      active: activeCalls,
      list: vi.fn(async () => ({
        data: [
          ...sessions.map(id => ({id, location: {directory: DIR}})),
          ...(options.oldSessions ?? []).map(id => ({
            id,
            location: {directory: DIR},
            time: {updated: RUN_STARTED - 60 * 60 * 1000},
          })),
        ],
      })),
    },
    getSession: vi.fn(async ({sessionId}: {sessionId: string}) =>
      sessions.includes(sessionId)
        ? ok({id: sessionId, parentId: null, directory: DIR, outcome: null})
        : {success: false as const, error: {kind: 'http' as const, status: 404}},
    ),
    interrupt,
    ...shellServer.routes,
  } as unknown as RemoteOpenCodeV2Client
  return {client, interrupt, activeCalls, active, sessions, shellServer}
}

function ledgerWith(...ids: string[]) {
  const ledger = createOwnershipLedger()
  for (const id of ids) ledger.adopt(id, id)
  return ledger
}

async function settle(
  server: ReturnType<typeof makeServer>,
  extra: Partial<Parameters<typeof settleOwnedSessionsV2>[0]> = {},
) {
  return settleOwnedSessionsV2({
    client: server.client,
    directory: DIR,
    rootSessionId: ROOT,
    ledger: createOwnershipLedger(),
    runStartedAt: RUN_STARTED,
    logger: makeLogger(),
    stability: FAST,
    ...extra,
  })
}

/** Run `settle` under fake timers to completion. */
async function settleAndWait(
  server: ReturnType<typeof makeServer>,
  extra: Partial<Parameters<typeof settleOwnedSessionsV2>[0]> = {},
  advanceMs = 5_000,
) {
  const pending = settle(server, extra)
  await vi.advanceTimersByTimeAsync(advanceMs)
  return pending
}

afterEach(() => {
  vi.useRealTimers()
})

describe('settleOwnedSessionsV2', () => {
  it('settles once the directory shows nothing for the whole window, without touching anything', async () => {
    // #given
    vi.useFakeTimers()
    const server = makeServer()

    // #when
    const result = await settleAndWait(server)

    // #then
    expect(result).toEqual({settled: true})
    expect(server.interrupt).not.toHaveBeenCalled()
    expect(server.shellServer.deleteShell).not.toHaveBeenCalled()
  })

  it('interrupts the root while it is active, then settles after a full quiet window', async () => {
    // #given
    vi.useFakeTimers()
    const server = makeServer({active: [ROOT]})

    // #when
    const result = await settleAndWait(server)

    // #then
    expect(result).toEqual({settled: true})
    expect(server.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
  })

  it('interrupts every active session of the directory, root first, ledger or not (grandchildren, resumed descendants)', async () => {
    // #given — the ledger knows only the child; the grandchild and a resumed session are active under the directory
    vi.useFakeTimers()
    const server = makeServer({
      sessions: [ROOT, CHILD, GRAND, 'ses_resumed'],
      active: [GRAND, CHILD, ROOT, 'ses_resumed'],
    })

    // #when
    const result = await settleAndWait(server, {ledger: ledgerWith(CHILD)})

    // #then
    const interrupted = server.interrupt.mock.calls.map(([input]) => input.sessionId)
    expect(result).toEqual({settled: true})
    expect(interrupted[0]).toBe(ROOT)
    expect([...interrupted].sort()).toEqual([CHILD, GRAND, ROOT, 'ses_resumed'].sort())
  })

  it('does not touch a session active elsewhere on the server', async () => {
    // #given
    vi.useFakeTimers()
    const server = makeServer({active: ['ses_elsewhere']})

    // #when
    const result = await settleAndWait(server)

    // #then
    expect(result).toEqual({settled: true})
    expect(server.interrupt).not.toHaveBeenCalled()
  })

  it('deletes every running shell of the directory, owned or not, before it interrupts anything', async () => {
    // #given — one owned, one untagged, one of a stranger: the directory is the run's
    vi.useFakeTimers()
    const server = makeServer({
      active: [ROOT],
      shellServer: {
        shells: {
          sh_owned: {status: 'running', owner: ROOT},
          sh_untagged: {status: 'running', owner: null},
          sh_stranger: {status: 'running', owner: 'ses_stranger'},
        },
      },
    })

    // #when
    const result = await settleAndWait(server)

    // #then — the DELETEs come first because each one wakes its owner, which the interrupt then stops
    const log = server.shellServer.log
    expect(result).toEqual({settled: true})
    expect(server.shellServer.shells).toEqual({})
    expect(log.indexOf('delete:sh_owned')).toBeLessThan(log.indexOf(`interrupt:${ROOT}`))
    expect(log.indexOf('delete:sh_stranger')).toBeLessThan(log.indexOf(`interrupt:${ROOT}`))
  })

  it('does not settle while a deleted shell’s wake keeps the root running, and gives up at the bound', async () => {
    // #given — every interrupt is accepted and the root stays active
    vi.useFakeTimers()
    const server = makeServer({active: [ROOT], unstoppable: [ROOT]})

    // #when
    const result = await settleAndWait(server, {timeoutMs: 2_000}, 3_000)

    // #then
    expect(result).toMatchObject({settled: false})
    expect(server.interrupt.mock.calls.length).toBeGreaterThan(2)
  })

  it('does not settle, and does not end early, when a DELETE commits, its response is lost, and the root is woken', async () => {
    // #given — the shell is gone from the list after the DELETE, so an empty list is all the barrier ever sees
    vi.useFakeTimers()
    const server = makeServer({
      shellServer: {shells: {[SHELL]: {status: 'running', owner: ROOT}}, deleteLosesResponse: true},
    })
    const ledger = ledgerWith()

    // #when — the DELETE's error notice wakes the root 120 ms in, inside the window
    let resolved = false
    const pending = settle(server, {ledger}).then(result => {
      resolved = true
      return result
    })
    await vi.advanceTimersByTimeAsync(20)
    expect(server.shellServer.deleteShell).toHaveBeenCalled()
    expect(server.shellServer.shells).toEqual({})
    await vi.advanceTimersByTimeAsync(100)
    server.active.add(ROOT)
    await vi.advanceTimersByTimeAsync(60)

    // #then — the wake is seen and stopped, and the window starts again from there
    expect(server.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).toEqual({settled: true})
  })

  it('reports unsettled when the wake after a lost-response DELETE never stops', async () => {
    // #given
    vi.useFakeTimers()
    const server = makeServer({
      unstoppable: [ROOT],
      shellServer: {shells: {[SHELL]: {status: 'running', owner: ROOT}}, deleteLosesResponse: true},
    })
    const pending = settle(server, {timeoutMs: 2_000})
    await vi.advanceTimersByTimeAsync(50)
    server.active.add(ROOT)

    // #when
    await vi.advanceTimersByTimeAsync(3_000)

    // #then
    expect(await pending).toMatchObject({settled: false})
  })

  it('catches a notice whose wake was deferred inside the window: a queued inbox item holds the gate', async () => {
    // #given — the root is idle with a notice enqueued; the wake starts 70 ms in
    vi.useFakeTimers()
    const server = makeServer({shellServer: {inbox: {[ROOT]: 1}}})
    const pending = settle(server)

    // #when
    await vi.advanceTimersByTimeAsync(40)
    delete server.shellServer.inbox[ROOT]
    server.active.add(ROOT)
    await vi.advanceTimersByTimeAsync(40)

    // #then — the wake was seen as activity and the root interrupted, not released on an idle reading
    expect(server.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).toEqual({settled: true})
  })

  it('does not settle while a queued inbox item never drains', async () => {
    // #given
    vi.useFakeTimers()
    const server = makeServer({shellServer: {inbox: {[CHILD]: 1}}, sessions: [ROOT, CHILD]})

    // #when
    const result = await settleAndWait(server, {timeoutMs: 1_000}, 2_000)

    // #then
    expect(result).toMatchObject({settled: false})
  })

  it('treats any read failure as not quiet, then settles once reads recover', async () => {
    // #given — the shell list fails for the first three reads
    vi.useFakeTimers()
    const server = makeServer({shellServer: {listFailsOn: [1, 2, 3]}})

    // #when
    const pending = settle(server)
    await vi.advanceTimersByTimeAsync(100)

    // #then — three failed readings, none counted
    expect(await Promise.race([pending, Promise.resolve('waiting' as const)])).toBe('waiting')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).toEqual({settled: true})
  })

  it('does not settle when reads never succeed', async () => {
    // #given
    vi.useFakeTimers()
    const server = makeServer({shellServer: {listFails: true}})

    // #when
    const result = await settleAndWait(server, {timeoutMs: 1_000}, 2_000)

    // #then
    expect(result).toMatchObject({settled: false})
  })

  it('does not settle when the active list cannot be read', async () => {
    // #given
    vi.useFakeTimers()
    const server = makeServer({activeFails: true})

    // #when
    const result = await settleAndWait(server, {timeoutMs: 1_000}, 2_000)

    // #then
    expect(result).toMatchObject({settled: false})
  })

  it('still acts on what a partial reading showed: a running shell is deleted although the active list failed', async () => {
    // #given
    vi.useFakeTimers()
    const server = makeServer({
      activeFails: true,
      shellServer: {shells: {[SHELL]: {status: 'running', owner: ROOT}}},
    })

    // #when
    await settleAndWait(server, {timeoutMs: 500}, 1_000)

    // #then
    expect(server.shellServer.deleteShell).toHaveBeenCalledWith(expect.objectContaining({shellId: SHELL}))
  })

  it('keeps a shell that survives its DELETE counted as activity until it is gone', async () => {
    // #given — the server accepts the DELETE and kills nothing
    vi.useFakeTimers()
    const server = makeServer({
      shellServer: {shells: {[SHELL]: {status: 'running', owner: ROOT}}, deleteDoesNotKill: [SHELL]},
    })

    // #when
    const result = await settleAndWait(server, {timeoutMs: 1_000}, 2_000)

    // #then
    expect(result).toMatchObject({settled: false})
    expect(server.shellServer.deleteShell.mock.calls.length).toBeGreaterThan(1)
  })

  it('a shell that appears late in the window is deleted and restarts the window (the final-sweep case)', async () => {
    // #given
    vi.useFakeTimers()
    const server = makeServer()
    const pending = settle(server)

    // #when — a shell starts after two readings
    await vi.advanceTimersByTimeAsync(60)
    server.shellServer.shells[SHELL] = {status: 'running', owner: ROOT}
    await vi.advanceTimersByTimeAsync(60)

    // #then
    expect(server.shellServer.deleteShell).toHaveBeenCalledWith(expect.objectContaining({shellId: SHELL}))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).toEqual({settled: true})
  })

  it('times out with a late shell that stalls the window: unsettled, ledger entries unknown', async () => {
    // #given — the late shell never dies
    vi.useFakeTimers()
    const server = makeServer({shellServer: {deleteDoesNotKill: [SHELL]}})
    const ledger = ledgerWith(CHILD)
    const pending = settle(server, {ledger, timeoutMs: 1_000})
    await vi.advanceTimersByTimeAsync(60)
    server.shellServer.shells[SHELL] = {status: 'running', owner: ROOT}

    // #when
    await vi.advanceTimersByTimeAsync(2_000)

    // #then
    expect(await pending).toMatchObject({settled: false})
    expect(ledger.snapshot().map(entry => entry.state)).toEqual(['unknown'])
  })

  it('settles every ledger entry on a pass, and marks them unknown on a failure', async () => {
    // #given
    vi.useFakeTimers()
    const passLedger = ledgerWith(CHILD)
    passLedger.adopt(shellLedgerKey(SHELL), 'background shell')
    const failLedger = ledgerWith(CHILD)

    // #when
    const passed = await settleAndWait(makeServer(), {ledger: passLedger})
    const failed = await settleAndWait(
      makeServer({active: [ROOT], unstoppable: [ROOT]}),
      {
        ledger: failLedger,
        timeoutMs: 500,
      },
      1_000,
    )

    // #then
    expect(passed).toEqual({settled: true})
    expect(passLedger.isDrainComplete()).toBe(true)
    expect(failed).toMatchObject({settled: false})
    expect(failLedger.snapshot().map(entry => entry.state)).toEqual(['unknown'])
  })

  it('names why it gave up', async () => {
    // #given
    vi.useFakeTimers()
    const server = makeServer({active: [ROOT], unstoppable: [ROOT]})

    // #when
    const result = await settleAndWait(server, {timeoutMs: 500}, 1_000)

    // #then
    expect(result.settled === false && result.reason.length > 0).toBe(true)
  })

  it('bounds a barrier whose requests never answer', async () => {
    // #given — every request hangs
    vi.useFakeTimers()
    const server = makeServer()
    server.activeCalls.mockImplementation(async () => new Promise<never>(() => undefined))

    // #when
    const pending = settle(server, {timeoutMs: 1_000})
    await vi.advanceTimersByTimeAsync(1_100)

    // #then
    expect(await pending).toMatchObject({settled: false})
  })

  it('does not let an abandoned attempt change the ledger after the bound has passed', async () => {
    // #given
    vi.useFakeTimers()
    const server = makeServer()
    server.activeCalls.mockImplementation(async () => new Promise<never>(() => undefined))
    const ledger = ledgerWith(CHILD)

    // #when
    const pending = settle(server, {ledger, timeoutMs: 500})
    await vi.advanceTimersByTimeAsync(600)
    await pending

    // #then
    expect(ledger.snapshot().map(entry => entry.state)).toEqual(['unknown'])
  })

  it('uses the real window by default: eleven readings over five seconds', async () => {
    // #given
    vi.useFakeTimers()
    const server = makeServer()
    const pending = settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger: createOwnershipLedger(),
      runStartedAt: RUN_STARTED,
      logger: makeLogger(),
    })

    // #when
    await vi.advanceTimersByTimeAsync(4_900)
    const early = await Promise.race([pending, Promise.resolve('waiting' as const)])
    await vi.advanceTimersByTimeAsync(200)

    // #then
    expect(early).toBe('waiting')
    expect(await pending).toEqual({settled: true})
    expect(DEFAULT_SETTLE_TIMEOUT_MS).toBeGreaterThan(5_000)
  })

  it('stamps the run id on its log lines', async () => {
    // #given
    vi.useFakeTimers()
    const logger = makeLogger()
    const server = makeServer({active: [ROOT], unstoppable: [ROOT]})

    // #when
    await settleAndWait(server, {logger, runId: 'run-9', timeoutMs: 300}, 600)

    // #then
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({runId: 'run-9'}), expect.any(String))
  })

  it('does not read the inbox of a session from an earlier run, so its queued item does not hold the stop', async () => {
    // #given — a stored session from an hour before the run, with an item that was queued back then
    const server = makeServer({oldSessions: ['ses_earlier'], shellServer: {shells: {}, inbox: {ses_earlier: 1}}})
    vi.useFakeTimers()

    // #when
    const pending = settle(server)
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await pending

    // #then
    expect(result).toEqual({settled: true})
    expect(server.shellServer.listSessionInbox).not.toHaveBeenCalledWith(
      expect.objectContaining({sessionId: 'ses_earlier'}),
    )
  })

  it('reads the inbox of the root and of a ledger session, whatever their stored time', async () => {
    // #given — the child is in the ledger, so it is owned
    const server = makeServer({sessions: [ROOT, CHILD], shellServer: {shells: {}, inbox: {[CHILD]: 1}}})
    vi.useFakeTimers()

    // #when
    const pending = settle(server, {ledger: ledgerWith(CHILD)})
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await pending

    // #then — the queued item never clears, so the bound ends it unconfirmed
    expect(result.settled).toBe(false)
    expect(server.shellServer.listSessionInbox).toHaveBeenCalledWith(expect.objectContaining({sessionId: CHILD}))
  })
})
