import type {RemoteOpenCodeV2Client, V2SessionOutcome} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {StreamTerminal} from './root-stop-v2.js'
import type {ShellServerOptions} from './shell-server-v2.fixture.js'

import {createOwnershipLedger, err, ok, shellLedgerKey} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {DEFAULT_SETTLE_TIMEOUT_MS, settleOwnedSessionsV2} from './settle-owned-sessions-v2.js'
import {makeShellServer} from './shell-server-v2.fixture.js'

const ROOT = 'ses_root'
const CHILD = 'ses_child'
const OTHER_CHILD = 'ses_other'
const DIR = '/workspace/repos/o/r'

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

interface ServerOptions {
  /** Sessions that are active before any interrupt. */
  readonly active?: readonly string[]
  /** Sessions an interrupt stops (removes from `active`). Defaults to all of them. */
  readonly stoppable?: readonly string[]
  readonly children?: readonly string[]
  readonly outcome?: V2SessionOutcome | null
  readonly interrupt?: (sessionId: string) => Promise<unknown>
  readonly activeFails?: boolean
  readonly shellServer?: ShellServerOptions
}

function makeServer(options: ServerOptions = {}) {
  const shellServer = makeShellServer(options.shellServer)
  const active = new Set(options.active ?? [])
  const stoppable = new Set(options.stoppable ?? [ROOT, CHILD, OTHER_CHILD])
  const interrupt = vi.fn(async ({sessionId}: {sessionId: string}) => {
    shellServer.log.push(`interrupt:${sessionId}`)
    if (options.interrupt !== undefined) return options.interrupt(sessionId) as never
    if (stoppable.has(sessionId)) active.delete(sessionId)
    return ok({interrupted: true})
  })
  const activeCalls = vi.fn(async () => {
    if (options.activeFails === true) throw new Error('session.active failed: http 503')
    return Object.fromEntries([...active].map(id => [id, {type: 'running'}]))
  })
  const client = {
    session: {
      active: activeCalls,
      list: vi.fn(async () => ({data: (options.children ?? []).map(id => ({id, parentID: ROOT}))})),
    },
    interrupt,
    getSession: vi.fn(async () => ok({id: ROOT, parentId: null, directory: '/d', outcome: options.outcome ?? null})),
    ...shellServer.routes,
  } as unknown as RemoteOpenCodeV2Client
  return {client, interrupt, activeCalls, active, shellServer}
}

function unknownIds(ledger: ReturnType<typeof createOwnershipLedger>): string[] {
  return ledger
    .snapshot()
    .filter(entry => entry.state === 'unknown')
    .map(entry => entry.sessionId)
}

function ledgerWith(...ids: string[]) {
  const ledger = createOwnershipLedger()
  for (const id of ids) ledger.adopt(id, id)
  return ledger
}

afterEach(() => {
  vi.useRealTimers()
})

describe('settleOwnedSessionsV2', () => {
  it('settles with zero remote calls when nothing is owned and the root need not be confirmed', async () => {
    // #given
    const server = makeServer()

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger: createOwnershipLedger(),
      logger: makeLogger(),
    })

    // #then
    expect(result).toEqual({settled: true})
    expect(server.interrupt).not.toHaveBeenCalled()
    expect(server.activeCalls).not.toHaveBeenCalled()
  })

  it('interrupts the root and every unsettled child and settles a child that left the active list', async () => {
    // #given
    const ledger = ledgerWith(CHILD)
    const server = makeServer({active: [CHILD], children: [CHILD]})

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger,
      logger: makeLogger(),
    })

    // #then
    expect(result).toEqual({settled: true})
    expect(server.interrupt.mock.calls.map(([input]) => input.sessionId).sort()).toEqual([CHILD, ROOT])
    expect(ledger.isDrainComplete()).toBe(true)
  })

  it('downgrades a child that is still active to unknown and reports it unsettled', async () => {
    // #given — the child ignores the interrupt
    const ledger = ledgerWith(CHILD)
    const server = makeServer({active: [CHILD], stoppable: [], children: [CHILD]})

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger,
      logger: makeLogger(),
    })

    // #then
    expect(result).toMatchObject({settled: false, rootUnconfirmed: false})
    expect(unknownIds(ledger)).toEqual([CHILD])
  })

  it('does not treat an interrupt reply of false as a stop for a child', async () => {
    // #given — the reply says nothing was interrupted, and the child is still active
    const ledger = ledgerWith(CHILD)
    const server = makeServer({
      active: [CHILD],
      children: [CHILD],
      interrupt: async () => ok({interrupted: false}),
    })

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger,
      logger: makeLogger(),
    })

    // #then
    expect(result).toMatchObject({settled: false})
    expect(ledger.isDrainComplete()).toBe(false)
  })

  describe('root confirmation', () => {
    it('confirms a root that ended with a persisted outcome and is absent from the active list', async () => {
      // #given
      const server = makeServer({active: [ROOT], outcome: 'interrupted'})

      // #when
      const result = await settleOwnedSessionsV2({
        client: server.client,
        directory: DIR,
        rootSessionId: ROOT,
        ledger: createOwnershipLedger(),
        logger: makeLogger(),
        confirmRootQuiescent: true,
        rootPollIntervalMs: 10,
      })

      // #then
      expect(result).toEqual({settled: true})
      expect(server.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
    })

    it('accepts an interrupt with reason user from the stream', async () => {
      // #given — no persisted outcome yet, but the stream saw the user interrupt
      const server = makeServer({active: [ROOT]})
      const terminal: StreamTerminal = 'user'

      // #when
      const result = await settleOwnedSessionsV2({
        client: server.client,
        directory: DIR,
        rootSessionId: ROOT,
        ledger: createOwnershipLedger(),
        logger: makeLogger(),
        confirmRootQuiescent: true,
        streamTerminal: () => terminal,
        rootPollIntervalMs: 10,
      })

      // #then
      expect(result).toEqual({settled: true})
    })

    it('quarantines when the interrupt that stopped the root had reason shutdown', async () => {
      // #given — the root is gone from the active list, but its last interrupt was a shutdown (claim still held)
      vi.useFakeTimers()
      const server = makeServer({active: [ROOT], outcome: 'interrupted'})
      const pending = settleOwnedSessionsV2({
        client: server.client,
        directory: DIR,
        rootSessionId: ROOT,
        ledger: createOwnershipLedger(),
        logger: makeLogger(),
        confirmRootQuiescent: true,
        streamTerminal: () => 'shutdown',
        rootPollIntervalMs: 50,
      })

      // #when
      await vi.advanceTimersByTimeAsync(DEFAULT_SETTLE_TIMEOUT_MS + 100)

      // #then
      await expect(pending).resolves.toMatchObject({settled: false, rootUnconfirmed: true})
    })

    it('interrupts the root again whenever it turns up live, and quarantines if it never stops', async () => {
      // #given
      vi.useFakeTimers()
      const server = makeServer({active: [ROOT], stoppable: [], outcome: 'succeeded'})
      const pending = settleOwnedSessionsV2({
        client: server.client,
        directory: DIR,
        rootSessionId: ROOT,
        ledger: createOwnershipLedger(),
        logger: makeLogger(),
        confirmRootQuiescent: true,
        rootPollIntervalMs: 100,
      })

      // #when
      await vi.advanceTimersByTimeAsync(DEFAULT_SETTLE_TIMEOUT_MS + 100)

      // #then
      await expect(pending).resolves.toMatchObject({settled: false, rootUnconfirmed: true})
      expect(server.interrupt.mock.calls.length).toBeGreaterThan(2)
    })

    it('quarantines when the root has no evidence of an ended execution', async () => {
      // #given — absent from the active list, but no outcome and nothing on the stream: not started, or not admitted
      vi.useFakeTimers()
      const server = makeServer({outcome: null})
      const pending = settleOwnedSessionsV2({
        client: server.client,
        directory: DIR,
        rootSessionId: ROOT,
        ledger: createOwnershipLedger(),
        logger: makeLogger(),
        confirmRootQuiescent: true,
        rootPollIntervalMs: 100,
      })

      // #when
      await vi.advanceTimersByTimeAsync(DEFAULT_SETTLE_TIMEOUT_MS + 100)

      // #then
      await expect(pending).resolves.toMatchObject({settled: false, rootUnconfirmed: true})
    })

    it('does not poll when background work is open: it reports the root unconfirmed at once', async () => {
      // #given — a child is still running and can start a root turn
      const ledger = ledgerWith(CHILD)
      const server = makeServer({active: [ROOT, CHILD], children: [CHILD], outcome: 'succeeded'})

      // #when
      const result = await settleOwnedSessionsV2({
        client: server.client,
        directory: DIR,
        rootSessionId: ROOT,
        ledger,
        logger: makeLogger(),
        confirmRootQuiescent: true,
        followUpPossible: true,
      })

      // #then — the children settled, the root did not, and no budget was spent waiting
      expect(result).toMatchObject({settled: false, rootUnconfirmed: true})
      expect(server.client.getSession).not.toHaveBeenCalled()
      expect(ledger.isDrainComplete()).toBe(true)
    })
  })

  describe('bound and failure', () => {
    it('quarantines instead of hanging when the server never answers', async () => {
      // #given
      vi.useFakeTimers()
      const ledger = ledgerWith(CHILD)
      const server = makeServer({active: [CHILD], interrupt: async () => new Promise(() => undefined)})
      const pending = settleOwnedSessionsV2({
        client: server.client,
        directory: DIR,
        rootSessionId: ROOT,
        ledger,
        logger: makeLogger(),
        confirmRootQuiescent: true,
      })

      // #when
      await vi.advanceTimersByTimeAsync(DEFAULT_SETTLE_TIMEOUT_MS + 1)

      // #then
      await expect(pending).resolves.toMatchObject({settled: false, rootUnconfirmed: true})
      expect(unknownIds(ledger)).toEqual([CHILD])
    })

    it('does not let an abandoned attempt settle the ledger after the bound has passed', async () => {
      // #given — the active list answers only after the bound
      vi.useFakeTimers()
      const ledger = ledgerWith(CHILD)
      let release: (() => void) | undefined
      const server = makeServer({active: [CHILD], children: [CHILD]})
      ;(server.client.session as unknown as {active: unknown}).active = async () =>
        new Promise(resolve => {
          release = () => resolve({})
        })
      const pending = settleOwnedSessionsV2({
        client: server.client,
        directory: DIR,
        rootSessionId: ROOT,
        ledger,
        logger: makeLogger(),
        timeoutMs: 1_000,
      })
      await vi.advanceTimersByTimeAsync(1_001)
      await expect(pending).resolves.toMatchObject({settled: false})

      // #when — the late answer would have settled the child
      release?.()
      await vi.advanceTimersByTimeAsync(10)

      // #then
      expect(unknownIds(ledger)).toEqual([CHILD])
    })

    it('quarantines when the active list cannot be read, and never settles on a failed read', async () => {
      // #given
      const ledger = ledgerWith(CHILD)
      const server = makeServer({active: [CHILD], children: [CHILD], activeFails: true})

      // #when
      const result = await settleOwnedSessionsV2({
        client: server.client,
        directory: DIR,
        rootSessionId: ROOT,
        ledger,
        logger: makeLogger(),
      })

      // #then
      expect(result).toMatchObject({settled: false, rootUnconfirmed: false})
      expect(unknownIds(ledger)).toEqual([CHILD])
    })

    it('stamps the run id on its log lines when it has one', async () => {
      // #given
      const logger = makeLogger()
      const server = makeServer({active: [CHILD], stoppable: [], children: [CHILD]})

      // #when
      await settleOwnedSessionsV2({
        client: server.client,
        directory: DIR,
        rootSessionId: ROOT,
        ledger: ledgerWith(CHILD),
        logger,
        runId: 'run-1',
      })

      // #then
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({runId: 'run-1'}), expect.any(String))
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({runId: 'run-1'}), expect.any(String))
    })
  })

  it('reports an interrupt failure as evidence, not as a reason to skip the confirmation', async () => {
    // #given — the root interrupt errors, the child still gets interrupted and settles
    const ledger = ledgerWith(CHILD)
    const server = makeServer({
      active: [CHILD],
      children: [CHILD],
      interrupt: async sessionId => {
        if (sessionId === ROOT) return err({kind: 'http', status: 500})
        return ok({interrupted: true})
      },
    })
    ;(server.client.session as unknown as {active: unknown}).active = async () => ({})

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger,
      logger: makeLogger(),
    })

    // #then
    expect(result).toEqual({settled: true})
  })
})

describe('settleOwnedSessionsV2: background shells', () => {
  const SHELL = 'sh_bg1'
  const SHELL_KEY = shellLedgerKey(SHELL)
  const RUNNING = {shells: {[SHELL]: {status: 'running' as const, owner: ROOT}}}

  function shellLedger() {
    const ledger = createOwnershipLedger()
    ledger.adopt(SHELL_KEY, 'background shell')
    return ledger
  }

  function stateOf(ledger: ReturnType<typeof createOwnershipLedger>): string | undefined {
    return ledger.snapshot().find(entry => entry.sessionId === SHELL_KEY)?.state
  }

  it('kills an owned shell, confirms and settles it, and interrupts the root anyway', async () => {
    // #given — a stop where the root is not confirmable by the stream
    const ledger = shellLedger()
    const server = makeServer({shellServer: RUNNING})

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger,
      logger: makeLogger(),
      confirmRootQuiescent: true,
      streamTerminal: () => 'user',
      rootPollIntervalMs: 1,
    })

    // #then — the kill and its confirming re-list come first, the root is interrupted either way, and the DELETE's error
    // notice can wake the root, so the root is not confirmed and the stop quarantines
    const log = server.shellServer.log
    expect(log.indexOf(`delete:${SHELL}`)).toBeGreaterThanOrEqual(0)
    expect(log.indexOf(`delete:${SHELL}`)).toBeLessThan(log.indexOf(`interrupt:${ROOT}`))
    expect(log.slice(log.indexOf(`delete:${SHELL}`) + 1, log.indexOf(`interrupt:${ROOT}`))).toContain('list')
    expect(stateOf(ledger)).toBe('settled')
    expect(result).toMatchObject({
      settled: false,
      rootUnconfirmed: true,
      followUpPossible: true,
      shellsUnconfirmed: false,
    })
  })

  it('interrupts the root whether or not the kill is confirmed', async () => {
    // #given — every DELETE fails, so no kill can be confirmed
    const server = makeServer({shellServer: {...RUNNING, deleteFails: true}})

    // #when
    await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger: shellLedger(),
      logger: makeLogger(),
      confirmRootQuiescent: true,
      rootPollIntervalMs: 1,
      shellKillRounds: 2,
      shellKillPollIntervalMs: 0,
    })

    // #then
    expect(server.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
  })

  it('does not confirm the root after it deleted a shell the ledger never heard of (probe A)', async () => {
    // #given — an owned running shell whose creation frame was lost, and a root that stops at once
    const server = makeServer({shellServer: RUNNING})

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger: createOwnershipLedger(),
      logger: makeLogger(),
      confirmRootQuiescent: true,
      followUpPossible: false,
      streamTerminal: () => 'user',
      rootPollIntervalMs: 1,
    })

    // #then — the DELETE queued an error notice that wakes the root, which nothing on the stream will show
    expect(server.shellServer.deleteShell).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({settled: false, rootUnconfirmed: true, followUpPossible: true})
  })

  it('settles clean, with a sweep before and after, when no shell is owned', async () => {
    // #given
    const server = makeServer({shellServer: {shells: {sh_stranger: {status: 'running', owner: 'ses_stranger'}}}})

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger: createOwnershipLedger(),
      logger: makeLogger(),
      confirmRootQuiescent: true,
      streamTerminal: () => 'user',
      rootPollIntervalMs: 1,
    })

    // #then
    expect(result).toEqual({settled: true})
    expect(server.shellServer.listShells).toHaveBeenCalledTimes(2)
    expect(server.shellServer.deleteShell).not.toHaveBeenCalled()
  })

  it('sweeps again after the root is confirmed: a shell started during the barrier does not survive the release', async () => {
    // #given — nothing runs at the first sweep; the shell appears while the root is being interrupted
    const server = makeServer({
      interrupt: async () => {
        server.shellServer.shells[SHELL] = {status: 'running', owner: ROOT}
        return ok({interrupted: true})
      },
    })

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger: createOwnershipLedger(),
      logger: makeLogger(),
      confirmRootQuiescent: true,
      streamTerminal: () => 'user',
      rootPollIntervalMs: 1,
    })

    // #then — the final sweep killed it, and its error notice means the root is no longer confirmed
    expect(server.shellServer.deleteShell).toHaveBeenCalledWith(expect.objectContaining({shellId: SHELL}))
    expect(server.shellServer.shells[SHELL]).toBeUndefined()
    expect(result).toMatchObject({settled: false, rootUnconfirmed: true, followUpPossible: true})
  })

  it('reports a shell the final sweep still lists as unconfirmed', async () => {
    // #given — the late shell shrugs off the DELETE
    const server = makeServer({
      shellServer: {deleteDoesNotKill: [SHELL]},
      interrupt: async () => {
        server.shellServer.shells[SHELL] = {status: 'running', owner: ROOT}
        return ok({interrupted: true})
      },
    })

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      shellKillRounds: 1,
      shellKillPollIntervalMs: 0,
      rootSessionId: ROOT,
      ledger: createOwnershipLedger(),
      logger: makeLogger(),
      confirmRootQuiescent: true,
      streamTerminal: () => 'user',
      rootPollIntervalMs: 1,
      timeoutMs: 3_000,
    })

    // #then
    expect(result).toMatchObject({settled: false, shellsUnconfirmed: true})
  })

  it('does not sweep for a late shell when the stop was already unconfirmed', async () => {
    // #given — follow-up work is open, so the root is not confirmed and the watch owns the polling
    const server = makeServer({shellServer: RUNNING})

    // #when
    await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger: shellLedger(),
      logger: makeLogger(),
      confirmRootQuiescent: true,
      followUpPossible: true,
    })

    // #then — one sweep: the kill and its confirming list, no second
    expect(server.shellServer.listShells).toHaveBeenCalledTimes(2)
  })

  it('keeps the stop unconfirmed when the shell is still running after the kill', async () => {
    // #given — the same stop, but the server accepts the DELETE and kills nothing
    const ledger = shellLedger()
    const server = makeServer({shellServer: {...RUNNING, deleteDoesNotKill: [SHELL]}})

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      shellKillRounds: 1,
      shellKillPollIntervalMs: 0,
      rootSessionId: ROOT,
      ledger,
      logger: makeLogger(),
      confirmRootQuiescent: true,
      streamTerminal: () => 'user',
      rootPollIntervalMs: 1,
    })

    // #then — never settled, downgraded to unknown, and reported so the caller keeps killing through the hold
    expect(result).toMatchObject({settled: false, shellsUnconfirmed: true})
    expect(stateOf(ledger)).toBe('unknown')
  })

  it('still interrupts the root when the kill is unconfirmed', async () => {
    // #given
    const server = makeServer({shellServer: {...RUNNING, deleteFails: true}})

    // #when
    await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      shellKillRounds: 1,
      shellKillPollIntervalMs: 0,
      rootSessionId: ROOT,
      ledger: shellLedger(),
      logger: makeLogger(),
      confirmRootQuiescent: true,
      followUpPossible: true,
    })

    // #then
    expect(server.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
  })

  it('does not confirm the root while the shell is open work, even when the kill is confirmed', async () => {
    // #given — the DELETE queues an error notice that wakes the root
    const ledger = shellLedger()
    const server = makeServer({shellServer: RUNNING})

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger,
      logger: makeLogger(),
      confirmRootQuiescent: true,
      followUpPossible: true,
      streamTerminal: () => 'succeeded',
    })

    // #then — quarantine, with the shell itself no longer the problem
    expect(result).toMatchObject({settled: false, rootUnconfirmed: true, shellsUnconfirmed: false})
    expect(stateOf(ledger)).toBe('settled')
  })

  it('reports a shell it could not kill even when the root is not confirmed either', async () => {
    // #given — follow-up work is open, so the root cannot be confirmed; the shell ignores the DELETE
    const ledger = shellLedger()
    const server = makeServer({shellServer: {...RUNNING, deleteDoesNotKill: [SHELL]}})

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      shellKillRounds: 1,
      shellKillPollIntervalMs: 0,
      rootSessionId: ROOT,
      ledger,
      logger: makeLogger(),
      confirmRootQuiescent: true,
      followUpPossible: true,
    })

    // #then — both are unresolved, and the caller must watch for both
    expect(result).toMatchObject({settled: false, rootUnconfirmed: true, shellsUnconfirmed: true})
  })

  it('does not settle while a shell the ledger never heard of survives the kill, whatever the root did', async () => {
    // #given — an empty ledger and a root that stops at once; only a stray shell ignores the DELETE
    const server = makeServer({shellServer: {...RUNNING, deleteDoesNotKill: [SHELL]}})

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      shellKillRounds: 1,
      shellKillPollIntervalMs: 0,
      rootSessionId: ROOT,
      ledger: createOwnershipLedger(),
      logger: makeLogger(),
      confirmRootQuiescent: true,
      streamTerminal: () => 'user',
      rootPollIntervalMs: 1,
    })

    // #then — the shell is the reason; the DELETE was accepted, so its notice can wake the root as well
    expect(result).toMatchObject({settled: false, rootUnconfirmed: true, shellsUnconfirmed: true})
    expect(result.settled === false && result.reason.includes(SHELL)).toBe(true)
  })

  it('reports a stray shell it could not kill when the root is unconfirmed as well', async () => {
    // #given — follow-up work is open, and the only shell is one the ledger never heard of
    const server = makeServer({shellServer: {...RUNNING, deleteDoesNotKill: [SHELL]}})

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      shellKillRounds: 1,
      shellKillPollIntervalMs: 0,
      rootSessionId: ROOT,
      ledger: createOwnershipLedger(),
      logger: makeLogger(),
      confirmRootQuiescent: true,
      followUpPossible: true,
    })

    // #then
    expect(result).toMatchObject({settled: false, rootUnconfirmed: true, shellsUnconfirmed: true})
  })

  it('kills a shell of the root that the ledger never heard of, and leaves a stranger’s alone', async () => {
    // #given — nothing adopted
    const server = makeServer({
      shellServer: {
        shells: {
          [SHELL]: {status: 'running', owner: ROOT},
          sh_stranger: {status: 'running', owner: 'ses_stranger'},
        },
      },
    })

    // #when
    const result = await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger: createOwnershipLedger(),
      logger: makeLogger(),
      confirmRootQuiescent: true,
      streamTerminal: () => 'user',
      rootPollIntervalMs: 1,
    })

    // #then — the root's stray shell is handled and the stranger's left alone; the root is not confirmed
    expect(result).toMatchObject({settled: false, rootUnconfirmed: true, followUpPossible: true})
    expect(server.shellServer.deleteShell).toHaveBeenCalledTimes(1)
    expect(server.shellServer.shells[SHELL]).toBeUndefined()
    expect(server.shellServer.shells.sh_stranger).toBeDefined()
  })

  it('never treats a shell entry as a session to interrupt', async () => {
    // #given
    const server = makeServer({shellServer: RUNNING})

    // #when
    await settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger: shellLedger(),
      logger: makeLogger(),
      confirmRootQuiescent: true,
      followUpPossible: true,
    })

    // #then
    expect(server.interrupt.mock.calls.map(([input]) => input.sessionId)).toEqual([ROOT])
  })

  it('reports shells unconfirmed on the bound, and settles nothing late', async () => {
    // #given — the list never answers
    vi.useFakeTimers()
    const ledger = shellLedger()
    const server = makeServer({shellServer: RUNNING})
    ;(
      server.shellServer.listShells as unknown as {mockImplementation: (fn: () => Promise<never>) => void}
    ).mockImplementation(async () => new Promise<never>(() => undefined))
    const pending = settleOwnedSessionsV2({
      client: server.client,
      directory: DIR,
      rootSessionId: ROOT,
      ledger,
      logger: makeLogger(),
      confirmRootQuiescent: true,
      timeoutMs: 1_000,
    })

    // #when
    await vi.advanceTimersByTimeAsync(1_001)

    // #then
    await expect(pending).resolves.toMatchObject({settled: false, shellsUnconfirmed: true})
    expect(stateOf(ledger)).toBe('unknown')
  })
})
