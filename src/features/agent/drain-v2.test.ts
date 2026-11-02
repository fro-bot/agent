/**
 * Releasing a V2 run. The tests drive the real runtime directory gate over a stateful in-memory server, with the
 * stability window shortened (a few readings a few milliseconds apart) so the timing is real and the suite stays fast.
 */
import type {ActionOpenCodeV2Client, OpenCodeV2ShutdownResult, RemoteOpenCodeV2Client} from '@fro-bot/runtime'
import {
  BLOCKING_SET_ID_CAP,
  createOwnershipLedger,
  createRemoteOpenCodeV2Client,
  DRAIN_UNREADABLE_MESSAGE,
  DRAIN_WAITING_MESSAGE,
  shellLedgerKey,
} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  createReleaseTally,
  drainUntilQuietV2,
  releaseRunV2,
  stopAndConfirmQuietV2,
  type DirectoryReleaseContext,
  type ReleaseRunOptions,
} from './drain-v2.js'

const DIRECTORY = '/workspace/repo'
const ROOT = 'ses_root'
const CHILD = 'ses_child'
const SHELL = 'sh_job'
const FAST = {requiredObservations: 3, minSpacingMs: 5, minSpanMs: 10} as const

const ok = <T>(data: T) => ({success: true as const, data})
const notFound = () => ({success: false as const, error: {kind: 'http' as const, status: 404}})

interface ServerState {
  readonly active: Set<string>
  readonly shells: Map<string, {owner: string | null}>
  readonly inbox: Map<string, number>
  /** Sessions the server lists under the directory, with their parent. */
  readonly sessions: Map<string, {parentID: string | null; directory: string}>
  /** A killed shell wakes its owner (probe p22). */
  wakeOwnerOnShellDelete: boolean
  /** An interrupt stops the session. Turn off to model a stop that never lands. */
  interruptsLand: boolean
  readonly calls: string[]
}

function createServer() {
  const state: ServerState = {
    active: new Set(),
    shells: new Map(),
    inbox: new Map(),
    sessions: new Map([[ROOT, {parentID: null, directory: DIRECTORY}]]),
    wakeOwnerOnShellDelete: false,
    interruptsLand: true,
    calls: [],
  }
  const client = {
    session: {
      active: vi.fn(async () => Object.fromEntries([...state.active].map(id => [id, {type: 'running'}]))),
      list: vi.fn(async (input: {parentID?: string; directory?: string}) => ({
        data: [...state.sessions]
          .filter(([, info]) => input.parentID === undefined || info.parentID === input.parentID)
          .filter(([, info]) => input.directory === undefined || info.directory === input.directory)
          .map(([id, info]) => ({
            id,
            parentID: info.parentID,
            location: {directory: info.directory},
            time: {updated: Date.now()},
          })),
      })),
    },
    getSession: vi.fn(async ({sessionId}: {sessionId: string}) => {
      const info = state.sessions.get(sessionId)
      return info === undefined
        ? notFound()
        : ok({id: sessionId, parentId: info.parentID, directory: info.directory, outcome: null})
    }),
    listSessionInbox: vi.fn(
      async ({sessionId}: {sessionId: string}): ReturnType<RemoteOpenCodeV2Client['listSessionInbox']> =>
        ok({queued: state.inbox.get(sessionId) ?? 0}),
    ),
    listShells: vi.fn(async () =>
      ok([...state.shells].map(([id, shell]) => ({id, status: 'running', ownerSessionId: shell.owner, pid: 1}))),
    ),
    getShell: vi.fn(async ({shellId}: {shellId: string}) =>
      state.shells.has(shellId) ? ok({id: shellId, status: 'running', ownerSessionId: null, pid: 1}) : notFound(),
    ),
    deleteShell: vi.fn(async ({shellId}: {shellId: string}) => {
      state.calls.push(`deleteShell:${shellId}`)
      const shell = state.shells.get(shellId)
      state.shells.delete(shellId)
      if (shell?.owner != null && state.wakeOwnerOnShellDelete) state.active.add(shell.owner)
      return ok(undefined)
    }),
    interrupt: vi.fn(async ({sessionId}: {sessionId: string}) => {
      state.calls.push(`interrupt:${sessionId}`)
      const wasActive = state.active.has(sessionId)
      if (state.interruptsLand) state.active.delete(sessionId)
      return ok({interrupted: wasActive})
    }),
  }
  return {state, client: client as unknown as ActionOpenCodeV2Client, raw: client}
}

function shutdownResult(outcome: 'forced' | 'graceful' | 'unconfirmed' = 'graceful'): OpenCodeV2ShutdownResult {
  return {
    interrupts: {stopped: [], notRunning: [], unconfirmed: []},
    exit: {outcome, code: 0, signal: null},
  }
}

function context(
  server: ReturnType<typeof createServer>,
  overrides: Partial<DirectoryReleaseContext> = {},
): DirectoryReleaseContext {
  return {
    client: server.client,
    directory: DIRECTORY,
    rootSessionId: ROOT,
    ledger: createOwnershipLedger(),
    runStartedAt: Date.now(),
    logger: createMockLogger(),
    stability: FAST,
    ...overrides,
  }
}

function release(
  server: ReturnType<typeof createServer>,
  overrides: Partial<ReleaseRunOptions> = {},
): {options: ReleaseRunOptions; shutdown: ReturnType<typeof vi.fn>} {
  const shutdown = vi.fn(async (_options?: unknown) => {
    server.state.calls.push('shutdown')
    return shutdownResult()
  })
  return {
    shutdown,
    options: {
      ...context(server),
      handle: {shutdown},
      executionSucceeded: true,
      deadlineMs: 2_000,
      pollIntervalMs: 5,
      ...overrides,
    },
  }
}

function later(ms: number, action: () => void): void {
  setTimeout(action, ms)
}

describe('drainUntilQuietV2', () => {
  it('is quiet at once when nothing was started, but still reads the directory through the whole window', async () => {
    // #given
    const server = createServer()

    // #when
    const outcome = await drainUntilQuietV2(context(server), {deadlineMs: 2_000, pollIntervalMs: 5})

    // #then every success waits for the gate, whatever the ledger holds
    expect(outcome).toEqual({kind: 'quiet'})
    expect(server.raw.session.active.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('waits for a background child that finishes after the root succeeded', async () => {
    // #given an adopted child that is a live direct child of the root
    const server = createServer()
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'child')
    server.state.sessions.set(CHILD, {parentID: ROOT, directory: DIRECTORY})
    server.state.active.add(CHILD)
    const finishedAt = Date.now() + 80
    later(80, () => server.state.active.delete(CHILD))

    // #when
    const outcome = await drainUntilQuietV2(context(server, {ledger}), {deadlineMs: 2_000, pollIntervalMs: 5})

    // #then it did not release before the child ended, and the ledger settled from the REST view
    expect(outcome).toEqual({kind: 'quiet'})
    expect(Date.now()).toBeGreaterThanOrEqual(finishedAt)
    expect(ledger.isDrainComplete()).toBe(true)
  })

  it('does not pass while ownership becomes unresolved inside the quiet window, and starts the window over', async () => {
    // #given a directory that has been quiet for part of its window, and a child adopted then (a late dispatch)
    const server = createServer()
    const ledger = createOwnershipLedger()
    const stability = {requiredObservations: 6, minSpacingMs: 10, minSpanMs: 50} as const
    const adoptedAt = 25
    const finishedAt = 160
    const startedAt = Date.now()
    later(adoptedAt, () => {
      ledger.adopt(CHILD, 'late child')
      server.state.sessions.set(CHILD, {parentID: ROOT, directory: DIRECTORY})
      server.state.active.add(CHILD)
    })
    later(finishedAt, () => server.state.active.delete(CHILD))

    // #when
    const outcome = await drainUntilQuietV2(context(server, {ledger, stability}), {
      deadlineMs: 5_000,
      pollIntervalMs: 5,
    })

    // #then it did not release on the window that began before the child, and the child was accounted for
    expect(outcome).toEqual({kind: 'quiet'})
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(finishedAt)
    expect(ledger.isDrainComplete()).toBe(true)
  })

  it('waits for a child the ledger never adopted that is running in the directory', async () => {
    // #given
    const server = createServer()
    server.state.sessions.set('ses_untracked', {parentID: ROOT, directory: DIRECTORY})
    server.state.active.add('ses_untracked')
    const finishedAt = Date.now() + 80
    later(80, () => server.state.active.delete('ses_untracked'))

    // #when
    const outcome = await drainUntilQuietV2(context(server), {deadlineMs: 2_000, pollIntervalMs: 5})

    // #then
    expect(outcome).toEqual({kind: 'quiet'})
    expect(Date.now()).toBeGreaterThanOrEqual(finishedAt)
  })

  it('waits for a background shell that is running after the root succeeded', async () => {
    // #given a shell the ledger tracks, still running
    const server = createServer()
    const ledger = createOwnershipLedger()
    ledger.adopt(shellLedgerKey(SHELL), 'background shell')
    server.state.shells.set(SHELL, {owner: ROOT})
    const finishedAt = Date.now() + 80
    later(80, () => server.state.shells.delete(SHELL))

    // #when
    const outcome = await drainUntilQuietV2(context(server, {ledger}), {deadlineMs: 2_000, pollIntervalMs: 5})

    // #then
    expect(outcome).toEqual({kind: 'quiet'})
    expect(Date.now()).toBeGreaterThanOrEqual(finishedAt)
    expect(ledger.isDrainComplete()).toBe(true)
  })

  it('waits for a queued notice that has not started its turn yet', async () => {
    // #given the producer admitted a notice and the wake has not started: nothing is active, one item is queued
    const server = createServer()
    server.state.inbox.set(ROOT, 1)
    const finishedAt = Date.now() + 80
    later(80, () => server.state.inbox.set(ROOT, 0))

    // #when
    const outcome = await drainUntilQuietV2(context(server), {deadlineMs: 2_000, pollIntervalMs: 5})

    // #then
    expect(outcome).toEqual({kind: 'quiet'})
    expect(Date.now()).toBeGreaterThanOrEqual(finishedAt)
  })

  it('gives up on a child that never ends once the drain deadline passes', async () => {
    // #given a child that is live and stays live
    const server = createServer()
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'stuck child')
    server.state.sessions.set(CHILD, {parentID: ROOT, directory: DIRECTORY})
    server.state.active.add(CHILD)
    const startedAt = Date.now()

    // #when
    const outcome = await drainUntilQuietV2(context(server, {ledger}), {deadlineMs: 150, pollIntervalMs: 5})

    // #then bounded: the run is not held forever, and the drain does not call it quiet
    expect(outcome).toEqual({kind: 'expired'})
    expect(Date.now() - startedAt).toBeLessThan(1_500)
    expect(ledger.isDrainComplete()).toBe(false)
  })

  describe('with no Action deadline (timeout: 0)', () => {
    it('stops waiting on owned work that no pass can see running', async () => {
      // #given an unsettled child the server does not list as a child of the root
      const server = createServer()
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'invisible child')

      // #when
      const outcome = await drainUntilQuietV2(context(server, {ledger}), {
        deadlineMs: Number.POSITIVE_INFINITY,
        pollIntervalMs: 5,
      })

      // #then it does not wait for ever, and says why
      expect(outcome.kind).toBe('unobservable')
    })

    it('puts no time cap on work that is observed running: it is still waited for past half an hour', async () => {
      // #given a child that stays live; the job timeout, not this drain, is the backstop with no Action deadline
      vi.useFakeTimers()
      try {
        const server = createServer()
        const ledger = createOwnershipLedger()
        ledger.adopt(CHILD, 'long child')
        server.state.sessions.set(CHILD, {parentID: ROOT, directory: DIRECTORY})
        server.state.active.add(CHILD)
        let outcome: Awaited<ReturnType<typeof drainUntilQuietV2>> | null = null
        const drain = drainUntilQuietV2(context(server, {ledger}), {
          deadlineMs: Number.POSITIVE_INFINITY,
          pollIntervalMs: 60_000,
        }).then(result => {
          outcome = result
        })

        // #when 31 minutes pass
        await vi.advanceTimersByTimeAsync(31 * 60_000)

        // #then it is still waiting, and still waiting on a child it can see
        expect(outcome).toBeNull()
        expect(ledger.isDrainComplete()).toBe(false)

        // #when the child finally ends
        server.state.active.delete(CHILD)
        await vi.advanceTimersByTimeAsync(5 * 60_000)
        await drain

        // #then
        expect(outcome).toEqual({kind: 'quiet'})
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps waiting on work that is observed running, and releases when it ends', async () => {
      // #given
      const server = createServer()
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'child')
      server.state.sessions.set(CHILD, {parentID: ROOT, directory: DIRECTORY})
      server.state.active.add(CHILD)
      later(150, () => server.state.active.delete(CHILD))

      // #when
      const outcome = await drainUntilQuietV2(context(server, {ledger}), {
        deadlineMs: Number.POSITIVE_INFINITY,
        pollIntervalMs: 5,
      })

      // #then more passes than the unobservable limit saw it running, and it still waited
      expect(outcome).toEqual({kind: 'quiet'})
    })
  })
})

describe('stopAndConfirmQuietV2', () => {
  it('deletes the running shells, then interrupts the active sessions root first, and confirms through the gate', async () => {
    // #given a running shell, an active root and an active child
    const server = createServer()
    server.state.shells.set(SHELL, {owner: ROOT})
    server.state.active.add(ROOT)
    server.state.active.add(CHILD)
    server.state.sessions.set(CHILD, {parentID: ROOT, directory: DIRECTORY})
    server.state.wakeOwnerOnShellDelete = true

    // #when
    const outcome = await stopAndConfirmQuietV2(context(server), {timeoutMs: 3_000})

    // #then
    expect(outcome).toEqual({quiet: true})
    expect(server.state.calls.slice(0, 3)).toEqual([`deleteShell:${SHELL}`, `interrupt:${ROOT}`, `interrupt:${CHILD}`])
    expect(server.state.active.size).toBe(0)
    expect(server.state.shells.size).toBe(0)
  })

  it('does not call a stop confirmed from the interrupt reply: it is quiet only when the directory shows it', async () => {
    // #given an interrupt that answers "interrupted" and does nothing
    const server = createServer()
    server.state.active.add(ROOT)
    server.state.interruptsLand = false
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'child')

    // #when
    const outcome = await stopAndConfirmQuietV2(context(server, {ledger}), {timeoutMs: 200})

    // #then unconfirmed, and what the ledger held is unknown, not settled
    expect(outcome.quiet).toBe(false)
    expect(ledger.unknown()).toBe(1)
  })

  it('acts on a partial reading: a shell is deleted even when another read of the same reading failed', async () => {
    // #given the shell list answers and the inbox read fails
    const server = createServer()
    server.state.shells.set(SHELL, {owner: null})
    server.raw.listSessionInbox.mockResolvedValueOnce({success: false, error: {kind: 'network'}} as never)

    // #when
    const outcome = await stopAndConfirmQuietV2(context(server), {timeoutMs: 3_000})

    // #then
    expect(server.state.calls).toContain(`deleteShell:${SHELL}`)
    expect(outcome).toEqual({quiet: true})
  })
})

describe('releaseRunV2', () => {
  it('on a deadline kills shells, interrupts sessions, confirms quiet, then shuts the server down, in that order', async () => {
    // #given a run that failed on its deadline with a shell running and the root still active
    const server = createServer()
    server.state.shells.set(SHELL, {owner: ROOT})
    server.state.active.add(ROOT)
    server.state.wakeOwnerOnShellDelete = true
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'child')
    const {options, shutdown} = release(server, {executionSucceeded: false, ledger})

    // #when
    const outcome = await releaseRunV2(options)

    // #then
    expect(outcome).toMatchObject({
      quiet: true,
      stopped: true,
      drain: 'not-attempted',
      unknownCount: 0,
      declineReason: null,
    })
    const order = server.state.calls
    expect(order.indexOf(`deleteShell:${SHELL}`)).toBeLessThan(order.indexOf(`interrupt:${ROOT}`))
    expect(order.indexOf(`interrupt:${ROOT}`)).toBeLessThan(order.indexOf('shutdown'))
    expect(order.at(-1)).toBe('shutdown')
    // the owned sessions ride along so a shutdown interrupts them with reason `user`
    expect(shutdown).toHaveBeenCalledWith({ownedSessionIds: [ROOT, CHILD]})
  })

  it('declines persistence when quiescence cannot be reached, and still shuts the server down', async () => {
    // #given a stop that never lands
    const server = createServer()
    server.state.active.add(ROOT)
    server.state.interruptsLand = false
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'child')
    const {options, shutdown} = release(server, {executionSucceeded: false, ledger, stopTimeoutMs: 200})

    // #when
    const outcome = await releaseRunV2(options)

    // #then no save: quiet is false, with a reason, and the ledger says unresolved
    expect(outcome.quiet).toBe(false)
    expect(outcome.declineReason).toContain('could not be confirmed quiet')
    expect(outcome.unknownCount).toBe(1)
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('releases a succeeded run without a stop once the directory is quiet', async () => {
    // #given
    const server = createServer()
    const {options, shutdown} = release(server)

    // #when
    const outcome = await releaseRunV2(options)

    // #then
    expect(outcome).toMatchObject({quiet: true, stopped: false, drain: 'quiet', declineReason: null})
    expect(server.state.calls).toEqual(['shutdown'])
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  describe('the release verdict line', () => {
    const verdictCalls = (logger: unknown) =>
      vi
        .mocked((logger as ReturnType<typeof createMockLogger>).info)
        .mock.calls.filter(([message]) => message === 'Run release verdict')

    it('logs one line on a clean path, before the pre-shutdown step', async () => {
      // #given a quiet directory and a pre-shutdown step that notes when it ran
      const server = createServer()
      const {options} = release(server)
      let verdictsBeforeStep = -1
      const withStep: ReleaseRunOptions = {
        ...options,
        beforeShutdown: async () => {
          verdictsBeforeStep = verdictCalls(options.logger).length
        },
      }

      // #when
      await releaseRunV2(withStep)

      // #then exactly one verdict, logged ahead of the summary write
      expect(verdictsBeforeStep).toBe(1)
      expect(verdictCalls(options.logger)).toHaveLength(1)
      expect(verdictCalls(options.logger)[0]?.[1]).toEqual({
        drain: 'quiet',
        stopped: false,
        quiet: true,
        readings: FAST.requiredObservations,
        quietStreak: FAST.requiredObservations,
        shellsDeleted: 0,
        sessionsInterrupted: 0,
        unknownCount: 0,
      })
    })

    it('counts the shells deleted and sessions interrupted by a stop', async () => {
      // #given a failed run with a shell running and the root active
      const server = createServer()
      server.state.shells.set(SHELL, {owner: ROOT})
      server.state.active.add(ROOT)
      server.state.wakeOwnerOnShellDelete = true
      const {options} = release(server, {executionSucceeded: false})

      // #when
      await releaseRunV2(options)

      // #then
      expect(verdictCalls(options.logger)).toHaveLength(1)
      expect(verdictCalls(options.logger)[0]?.[1]).toMatchObject({
        drain: 'not-attempted',
        stopped: true,
        quiet: true,
        shellsDeleted: 1,
        sessionsInterrupted: 1,
        unknownCount: 0,
      })
      expect(verdictCalls(options.logger)[0]?.[1]).not.toHaveProperty('declineReason')
    })

    it('names the decline reason and the unknown entries when quiet cannot be confirmed', async () => {
      // #given a stop that never lands
      const server = createServer()
      server.state.active.add(ROOT)
      server.state.interruptsLand = false
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'child')
      const {options} = release(server, {executionSucceeded: false, ledger, stopTimeoutMs: 200})

      // #when
      await releaseRunV2(options)

      // #then
      expect(verdictCalls(options.logger)).toHaveLength(1)
      expect(verdictCalls(options.logger)[0]?.[1]).toMatchObject({
        quiet: false,
        quietStreak: 0,
        unknownCount: 1,
        declineReason: expect.stringContaining('could not be confirmed quiet') as unknown,
      })
    })
  })

  it('stops the directory when the drain runs out, and reports the stop, not the drain, as the verdict', async () => {
    // #given a child that is live until the stop interrupts it
    const server = createServer()
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'stuck child')
    server.state.sessions.set(CHILD, {parentID: ROOT, directory: DIRECTORY})
    server.state.active.add(CHILD)
    const {options} = release(server, {ledger, deadlineMs: 120})

    // #when
    const outcome = await releaseRunV2(options)

    // #then
    expect(outcome).toMatchObject({drain: 'expired', stopped: true, quiet: true, unknownCount: 0})
    expect(server.state.calls).toContain(`interrupt:${CHILD}`)
  })

  it('runs the pre-shutdown step only on a quiet directory and before the server goes down', async () => {
    // #given
    const quietServer = createServer()
    const beforeShutdown = vi.fn(async (_signal: AbortSignal) => {
      quietServer.state.calls.push('prune')
    })
    const quiet = release(quietServer, {beforeShutdown})

    const stuckServer = createServer()
    stuckServer.state.active.add(ROOT)
    stuckServer.state.interruptsLand = false
    const skipped = vi.fn(async () => undefined)
    const stuck = release(stuckServer, {executionSucceeded: false, beforeShutdown: skipped, stopTimeoutMs: 150})

    // #when
    await releaseRunV2(quiet.options)
    await releaseRunV2(stuck.options)

    // #then
    expect(quietServer.state.calls).toEqual(['prune', 'shutdown'])
    expect(skipped).not.toHaveBeenCalled()
  })

  it('reaches shutdown, and keeps the save allowed, when the pre-shutdown step never finishes', async () => {
    // #given a pre-shutdown step (summary write, prune) that never settles and ignores its signal
    const server = createServer()
    let stepSignal: AbortSignal | undefined
    const beforeShutdown = vi.fn(async (signal: AbortSignal) => {
      stepSignal = signal
      await new Promise<never>(() => undefined)
    })
    const {options, shutdown} = release(server, {beforeShutdown, preShutdownTimeoutMs: 60})
    const startedAt = Date.now()

    // #when
    const outcome = await releaseRunV2(options)

    // #then the bound cut it, the signal told the step to stop, and the server still went down
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(stepSignal?.aborted).toBe(true)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({quiet: true, declineReason: null})
  })

  it('settles the event observation after the directory is decided and before anything shuts the server down', async () => {
    // #given
    const quietServer = createServer()
    const onSettled = vi.fn(async (_quiet: boolean, _signal: AbortSignal) => {
      quietServer.state.calls.push('settled')
    })
    const quiet = release(quietServer, {onSettled})
    const stuckServer = createServer()
    stuckServer.state.active.add(ROOT)
    stuckServer.state.interruptsLand = false
    const stuckSettled = vi.fn(async () => undefined)
    const stuck = release(stuckServer, {executionSucceeded: false, onSettled: stuckSettled, stopTimeoutMs: 150})

    // #when
    await releaseRunV2(quiet.options)
    await releaseRunV2(stuck.options)

    // #then it ran before shutdown, with the verdict; and it also ran when the directory could not be confirmed
    expect(quietServer.state.calls).toEqual(['settled', 'shutdown'])
    expect(onSettled.mock.calls[0]?.[0]).toBe(true)
    expect(stuckSettled).toHaveBeenCalledWith(false, expect.any(AbortSignal))
  })

  it('does not let a settle step that never finishes hold the server up', async () => {
    // #given
    const server = createServer()
    const onSettled = vi.fn(async () => new Promise<never>(() => undefined))
    const {options, shutdown} = release(server, {onSettled, preShutdownTimeoutMs: 60})

    // #when
    const outcome = await releaseRunV2(options)

    // #then
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(outcome.quiet).toBe(true)
  })

  it('treats a shutdown that throws as unconfirmed rather than failing the release', async () => {
    // #given
    const server = createServer()
    const shutdown = vi.fn(async () => {
      throw new Error('stdin closed')
    })
    const {options} = release(server)

    // #when
    const outcome = await releaseRunV2({...options, handle: {shutdown}})

    // #then
    expect(outcome.shutdown).toBeNull()
    expect(outcome.quiet).toBe(true)
  })
})

describe('drain progress logging', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const infoLines = (logger: unknown, message: string) =>
    vi
      .mocked((logger as ReturnType<typeof createMockLogger>).info)
      .mock.calls.filter(([line]) => line === message)
      .map(([, fields]) => fields as Record<string, unknown>)

  it('logs once when the blocker changes, not once per reading, and keeps the per-reading debug line', async () => {
    // #given a notice queued on the root for a while: many readings, one blocker
    const server = createServer()
    server.state.inbox.set(ROOT, 1)
    later(150, () => server.state.inbox.set(ROOT, 0))
    const tally = createReleaseTally()
    const ctx = context(server, {tally})

    // #when
    const outcome = await drainUntilQuietV2(ctx, {deadlineMs: 2_000, pollIntervalMs: 5})

    // #then
    expect(outcome).toEqual({kind: 'quiet'})
    expect(tally.readings).toBeGreaterThan(5)
    const waiting = infoLines(ctx.logger, DRAIN_WAITING_MESSAGE)
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({
      sessions: {count: 0, ids: []},
      shells: {count: 0, ids: []},
      inbox: {count: 1, items: [{sessionId: ROOT, queued: 1}]},
      readings: 1,
      elapsedMs: expect.any(Number) as unknown,
    })
    const debugReadings = vi
      .mocked(ctx.logger.debug)
      .mock.calls.filter(([line]) => line === 'The run directory is not quiet yet')
    expect(debugReadings.length).toBeGreaterThan(1)
  })

  it('logs a heartbeat about every 60 s while the same blocker stays', async () => {
    // #given a shell that never ends, read once a second (fake timers)
    vi.useFakeTimers()
    const server = createServer()
    server.state.shells.set(SHELL, {owner: ROOT})
    const ctx = context(server, {stability: {requiredObservations: 3, minSpacingMs: 1_000, minSpanMs: 2_000}})

    // #when
    const draining = drainUntilQuietV2(ctx, {deadlineMs: 200_000, pollIntervalMs: 1_000})
    await vi.advanceTimersByTimeAsync(185_000)
    server.state.shells.delete(SHELL)
    await vi.advanceTimersByTimeAsync(10_000)
    const outcome = await draining

    // #then one line for the change, then one a minute
    expect(outcome).toEqual({kind: 'quiet'})
    const waiting = infoLines(ctx.logger, DRAIN_WAITING_MESSAGE)
    expect(waiting).toHaveLength(4)
    const elapsed = waiting.map(fields => fields.elapsedMs as number)
    expect(elapsed[0]).toBe(0)
    expect(elapsed[1]).toBeGreaterThanOrEqual(60_000)
    expect(elapsed[1]).toBeLessThan(62_000)
    expect(elapsed[3]).toBeGreaterThanOrEqual(180_000)
    for (const fields of waiting) expect(fields).toMatchObject({shells: {count: 1, ids: [SHELL]}})
  })

  it('caps every list in the line and keeps the true count', async () => {
    // #given more running shells than the cap
    const server = createServer()
    const total = BLOCKING_SET_ID_CAP + 5
    for (let index = 0; index < total; index += 1) server.state.shells.set(`sh_${index}`, {owner: null})
    const ctx = context(server)

    // #when
    await drainUntilQuietV2(ctx, {deadlineMs: 60, pollIntervalMs: 5})

    // #then
    const waiting = infoLines(ctx.logger, DRAIN_WAITING_MESSAGE)
    expect(waiting).toHaveLength(1)
    const shells = waiting[0]?.shells as {count: number; ids: string[]}
    expect(shells.count).toBe(total)
    expect(shells.ids).toHaveLength(BLOCKING_SET_ID_CAP)
  })

  it('logs an unreadable directory once, with the reason', async () => {
    // #given every shell read fails
    const server = createServer()
    const networkError = {success: false, error: {kind: 'network', message: 'down'}} as const
    server.raw.listShells.mockImplementation(async () => networkError as never)
    const ctx = context(server)

    // #when
    const outcome = await drainUntilQuietV2(ctx, {deadlineMs: 120, pollIntervalMs: 5})

    // #then
    expect(outcome).toEqual({kind: 'expired'})
    const unreadable = infoLines(ctx.logger, DRAIN_UNREADABLE_MESSAGE)
    expect(unreadable).toHaveLength(1)
    expect(unreadable[0]).toMatchObject({reason: expect.stringContaining('shell.list') as unknown, readings: 1})
  })

  it('logs ids and closed-set fields only: no message text or command text from an inbox item', async () => {
    // #given an inbox item that carries text and a command in the fixture
    const server = createServer()
    server.raw.listSessionInbox.mockImplementation(async ({sessionId}: {sessionId: string}) => {
      const item = {
        type: 'synthetic',
        source: 'shell',
        text: 'SECRET-MESSAGE-TEXT',
        command: 'SECRET-COMMAND rm -rf /',
      } as const
      return ok({queued: sessionId === ROOT ? 1 : 0, ...(sessionId === ROOT ? {items: [item]} : {})})
    })
    const ctx = context(server)

    // #when
    await drainUntilQuietV2(ctx, {deadlineMs: 60, pollIntervalMs: 5})

    // #then the new info lines name the item by kind, never by content
    const waiting = infoLines(ctx.logger, DRAIN_WAITING_MESSAGE)
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({
      inbox: {items: [{sessionId: ROOT, queued: 1, items: [{type: 'synthetic', source: 'shell'}]}]},
    })
    expect(JSON.stringify(vi.mocked(ctx.logger.info).mock.calls)).not.toContain('SECRET')
  })

  it('names no string a caller chose in a progress or verdict line: a metadata source on a user or synthetic item', async () => {
    // #given an inbox read by the real client, whose items carry a token-shaped source next to allowlisted fields
    const hostile = createRemoteOpenCodeV2Client({
      baseUrl: 'http://example.invalid',
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [
              {type: 'user', delivery: 'queue', payload: {text: 'T', metadata: {source: 'PrivateCustomer'}}},
              {type: 'synthetic', delivery: 'steer', payload: {text: 'T', metadata: {source: 'PrivateCustomer'}}},
              {type: 'Tenant42', delivery: 'AcmeDelivery', payload: {text: 'T'}},
            ],
          }),
          {status: 200, headers: {'content-type': 'application/json'}},
        ),
    })
    const server = createServer()
    server.raw.listSessionInbox.mockImplementation(async ({sessionId}: {sessionId: string}) =>
      sessionId === ROOT ? hostile.listSessionInbox({sessionId}) : ok({queued: 0}),
    )
    const {options} = release(server, {deadlineMs: 80, stopTimeoutMs: 100})

    // #when the drain expires on the queued items, so both the progress line and the verdict line are written
    const outcome = await releaseRunV2(options)

    // #then the kinds are named, the caller's strings are on no line at all
    expect(outcome).toMatchObject({drain: 'expired'})
    const waiting = infoLines(options.logger, DRAIN_WAITING_MESSAGE)
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({
      inbox: {
        items: [
          {
            sessionId: ROOT,
            queued: 3,
            items: [
              {type: 'user', delivery: 'queue'},
              {type: 'synthetic', delivery: 'steer', source: 'other'},
              {type: 'other', delivery: 'other'},
            ],
          },
        ],
      },
    })
    expect(infoLines(options.logger, 'Run release verdict')[0]).toHaveProperty('blocking')
    // every level: debug readings and warnings included
    const everyLine = Object.values(options.logger as unknown as Record<string, {mock?: {calls: unknown[]}}>).map(
      method => method.mock?.calls ?? [],
    )
    expect(JSON.stringify(everyLine)).not.toMatch(/PrivateCustomer|Tenant42|AcmeDelivery/)
  })

  it('names the blocking set on the verdict line when the directory could not be confirmed quiet', async () => {
    // #given a child that stays live and a stop that never lands
    const server = createServer()
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'stuck child')
    server.state.sessions.set(CHILD, {parentID: ROOT, directory: DIRECTORY})
    server.state.active.add(CHILD)
    server.state.interruptsLand = false
    const {options} = release(server, {ledger, deadlineMs: 80, stopTimeoutMs: 150})

    // #when
    const outcome = await releaseRunV2(options)

    // #then
    expect(outcome).toMatchObject({drain: 'expired', stopped: true, quiet: false})
    const verdict = infoLines(options.logger, 'Run release verdict')
    expect(verdict).toHaveLength(1)
    expect(verdict[0]).toMatchObject({
      quiet: false,
      blocking: {
        sessions: {count: 1, ids: [CHILD]},
        shells: {count: 0, ids: []},
        inbox: {count: 0, items: []},
      },
    })
  })

  it('leaves the blocking set off the verdict line when the directory was confirmed quiet', async () => {
    // #given a blocker that clears
    const server = createServer()
    server.state.inbox.set(ROOT, 1)
    later(40, () => server.state.inbox.set(ROOT, 0))
    const {options} = release(server)

    // #when
    await releaseRunV2(options)

    // #then
    const verdict = infoLines(options.logger, 'Run release verdict')
    expect(verdict[0]).toMatchObject({quiet: true})
    expect(verdict[0]).not.toHaveProperty('blocking')
  })
})
