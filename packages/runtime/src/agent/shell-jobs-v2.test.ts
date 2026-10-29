import type {Result} from '@bfra.me/es/result'
import type {Logger} from '../shared/logger.js'
import type {V2CallError, V2ShellSummary} from './remote-client-v2.js'
import type {ShellApi} from './shell-jobs-v2.js'

import {err, ok} from '@bfra.me/es/result'
import {describe, expect, it, vi} from 'vitest'

import {createOwnershipLedger, shellLedgerKey} from './ownership-ledger.js'
import {
  collectOwnerSessionIds,
  DEFAULT_SHELL_KILL_POLL_INTERVAL_MS,
  DEFAULT_SHELL_KILL_ROUNDS,
  killOwnedShells,
  listOwnedRunningShells,
  reconcileShellsOnce,
} from './shell-jobs-v2.js'

const DIR = '/workspace/repo'
const ROOT = 'ses_root'
const CHILD = 'ses_child'
const OTHER = 'ses_other'

const logger: Logger = {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}

type Status = V2ShellSummary['status']

interface FakeShell {
  status: Status
  owner: string | null
}

/** A shell API over a mutable table. `deleteBehavior` decides what a DELETE does to the table. */
function makeApi(
  shells: Record<string, FakeShell>,
  options: {
    readonly listFails?: readonly number[]
    readonly getFails?: Readonly<Record<string, V2CallError>>
    readonly deleteDoesNotKill?: readonly string[]
    readonly deleteFails?: boolean
  } = {},
) {
  const calls: string[] = []
  let listCount = 0
  const summary = (id: string, shell: FakeShell): V2ShellSummary => ({
    id,
    status: shell.status,
    ownerSessionId: shell.owner,
    pid: shell.status === 'running' ? 1 : null,
  })
  const api: ShellApi = {
    listShells: async () => {
      listCount += 1
      calls.push('list')
      if (options.listFails?.includes(listCount) === true) return err({kind: 'network', message: 'down'})
      return ok(
        Object.entries(shells)
          .filter(([, shell]) => shell.status === 'running' || shell.status === 'unknown')
          .map(([id, shell]) => summary(id, shell)),
      )
    },
    getShell: async ({shellId}): Promise<Result<V2ShellSummary, V2CallError>> => {
      calls.push(`get:${shellId}`)
      const failure = options.getFails?.[shellId]
      if (failure !== undefined) return err(failure)
      const shell = shells[shellId]
      return shell === undefined ? err({kind: 'http', status: 404}) : ok(summary(shellId, shell))
    },
    deleteShell: async ({shellId}) => {
      calls.push(`delete:${shellId}`)
      if (options.deleteFails === true) return err({kind: 'network', message: 'down'})
      if (options.deleteDoesNotKill?.includes(shellId) !== true) {
        // The real server removes the record: a later GET is a 404.

        delete shells[shellId]
      }
      return ok(undefined)
    },
  }
  return {api, calls}
}

function ledgerWith(...shellIds: string[]) {
  const ledger = createOwnershipLedger()
  for (const id of shellIds) ledger.adopt(shellLedgerKey(id), 'sleep')
  return ledger
}

describe('reconcileShellsOnce', () => {
  it('makes no request when the ledger holds no unsettled shell', async () => {
    // #given — a session entry and a settled shell
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'child')
    ledger.adopt(shellLedgerKey('sh_done'), 'done')
    ledger.settle(shellLedgerKey('sh_done'))
    const {api, calls} = makeApi({})

    // #when
    const result = await reconcileShellsOnce({ledger, api, directory: DIR, logger})

    // #then
    expect(result.success).toBe(true)
    expect(calls).toEqual([])
  })

  it('leaves a shell that is still running outstanding', async () => {
    // #given
    const ledger = ledgerWith('sh_1')
    const {api, calls} = makeApi({sh_1: {status: 'running', owner: ROOT}})

    // #when
    const result = await reconcileShellsOnce({ledger, api, directory: DIR, logger})

    // #then
    expect(ledger.outstanding()).toBe(1)
    expect(result).toEqual({success: true, data: {liveShellIds: new Set(['sh_1'])}})
    expect(calls).toEqual(['list'])
  })

  it.each(['exited', 'timeout', 'killed'] as const)(
    'settles a shell absent from the list that reads %s',
    async status => {
      // #given
      const ledger = ledgerWith('sh_1')
      const {api} = makeApi({sh_1: {status, owner: ROOT}})

      // #when
      await reconcileShellsOnce({ledger, api, directory: DIR, logger})

      // #then
      expect(ledger.isDrainComplete()).toBe(true)
    },
  )

  it('settles a shell the server no longer knows (404 after retention)', async () => {
    // #given
    const ledger = ledgerWith('sh_1')
    const {api} = makeApi({})

    // #when
    await reconcileShellsOnce({ledger, api, directory: DIR, logger})

    // #then
    expect(ledger.snapshot()).toEqual([{sessionId: shellLedgerKey('sh_1'), label: 'sleep', state: 'settled'}])
  })

  it('keeps a shell it cannot read unknown, never settled', async () => {
    // #given — absent from the list, and the per-shell read fails in every non-404 way
    for (const error of [
      {kind: 'network', message: 'down'},
      {kind: 'http', status: 500},
      {kind: 'auth', status: 401},
      {kind: 'parse'},
      {kind: 'aborted'},
    ] as const) {
      const ledger = ledgerWith('sh_1')
      const {api} = makeApi({sh_1: {status: 'exited', owner: ROOT}}, {getFails: {sh_1: error}})

      // #when
      await reconcileShellsOnce({ledger, api, directory: DIR, logger})

      // #then
      expect(ledger.snapshot()[0]?.state).toBe('unknown')
      expect(ledger.isDrainComplete()).toBe(false)
    }
  })

  it('marks every outstanding shell unknown when the list cannot be read, and settles nothing', async () => {
    // #given
    const ledger = ledgerWith('sh_1', 'sh_2')
    const {api} = makeApi({sh_1: {status: 'exited', owner: ROOT}}, {listFails: [1]})

    // #when
    const result = await reconcileShellsOnce({ledger, api, directory: DIR, logger})

    // #then
    expect(result.success).toBe(false)
    expect(ledger.snapshot().map(entry => entry.state)).toEqual(['unknown', 'unknown'])
  })

  it('treats a status it does not know as running', async () => {
    // #given
    const ledger = ledgerWith('sh_1')
    const {api} = makeApi({sh_1: {status: 'unknown', owner: ROOT}})

    // #when
    await reconcileShellsOnce({ledger, api, directory: DIR, logger})

    // #then
    expect(ledger.outstanding()).toBe(1)
  })

  it('can settle an unknown entry once the shell is seen stopped', async () => {
    // #given
    const ledger = ledgerWith('sh_1')
    ledger.markUnknown(shellLedgerKey('sh_1'))
    const {api} = makeApi({sh_1: {status: 'exited', owner: ROOT}})

    // #when
    await reconcileShellsOnce({ledger, api, directory: DIR, logger})

    // #then
    expect(ledger.isDrainComplete()).toBe(true)
  })

  it('does not touch session entries', async () => {
    // #given
    const ledger = ledgerWith('sh_1')
    ledger.adopt(CHILD, 'child')
    const {api} = makeApi({sh_1: {status: 'exited', owner: ROOT}})

    // #when
    await reconcileShellsOnce({ledger, api, directory: DIR, logger})

    // #then
    expect(ledger.snapshot().find(entry => entry.sessionId === CHILD)?.state).toBe('outstanding')
  })
})

describe('collectOwnerSessionIds', () => {
  it('returns the root and every session entry in any state, and no shell key', () => {
    // #given
    const ledger = ledgerWith('sh_1')
    ledger.adopt(CHILD, 'child')
    ledger.settle(CHILD)

    // #when / #then
    expect(collectOwnerSessionIds(ROOT, ledger)).toEqual(new Set([ROOT, CHILD]))
  })
})

describe('killOwnedShells', () => {
  const owners = new Set([ROOT, CHILD])

  it('does nothing when no owned shell is running: one request, confirmed', async () => {
    // #given — only a stranger's shell
    const ledger = createOwnershipLedger()
    const {api, calls} = makeApi({sh_x: {status: 'running', owner: OTHER}})

    // #when
    const result = await killOwnedShells({api, directory: DIR, ownerSessionIds: owners, ledger, logger})

    // #then
    expect(result).toEqual({confirmed: true, deleted: []})
    expect(calls).toEqual(['list'])
  })

  it('deletes a ledger shell and a listed shell of the root or an owned child, then confirms with a re-list', async () => {
    // #given
    const ledger = ledgerWith('sh_ledger')
    const shells: Record<string, FakeShell> = {
      sh_ledger: {status: 'running', owner: ROOT},
      sh_root: {status: 'running', owner: ROOT},
      sh_child: {status: 'running', owner: CHILD},
      sh_stranger: {status: 'running', owner: OTHER},
      sh_untagged: {status: 'running', owner: null},
    }
    const {api, calls} = makeApi(shells)

    // #when
    const result = await killOwnedShells({api, directory: DIR, ownerSessionIds: owners, ledger, logger})

    // #then — the stranger's and the untagged shell are left alone
    expect(result.confirmed).toBe(true)
    expect(calls.filter(call => call.startsWith('delete:')).sort()).toEqual([
      'delete:sh_child',
      'delete:sh_ledger',
      'delete:sh_root',
    ])
    expect(calls.at(-1)).toBe('list')
    expect(Object.keys(shells).sort()).toEqual(['sh_stranger', 'sh_untagged'])
    expect(ledger.isDrainComplete()).toBe(true)
  })

  it('still deletes the ledger shells when the first list fails', async () => {
    // #given
    const ledger = ledgerWith('sh_1')
    const {api, calls} = makeApi({sh_1: {status: 'running', owner: ROOT}}, {listFails: [1]})

    // #when
    const result = await killOwnedShells({api, directory: DIR, ownerSessionIds: owners, ledger, logger})

    // #then
    expect(calls).toContain('delete:sh_1')
    expect(result.confirmed).toBe(true)
  })

  it('is unconfirmed when the confirming list cannot be read, and settles nothing', async () => {
    // #given
    const ledger = ledgerWith('sh_1')
    const {api} = makeApi({sh_1: {status: 'running', owner: ROOT}}, {listFails: [2]})

    // #when
    const result = await killOwnedShells({api, directory: DIR, ownerSessionIds: owners, ledger, logger, rounds: 1})

    // #then
    expect(result.confirmed).toBe(false)
    expect(ledger.outstanding()).toBe(1)
  })

  it('is unconfirmed when a shell survives every round, and says which', async () => {
    // #given — a DELETE that is accepted and kills nothing
    const ledger = ledgerWith('sh_stuck')
    const {api, calls} = makeApi({sh_stuck: {status: 'running', owner: ROOT}}, {deleteDoesNotKill: ['sh_stuck']})

    // #when
    const result = await killOwnedShells({
      api,
      directory: DIR,
      ownerSessionIds: owners,
      ledger,
      logger,
      rounds: 3,
      pollIntervalMs: 0,
    })

    // #then
    expect(result).toEqual({confirmed: false, stillRunning: ['sh_stuck']})
    expect(calls.filter(call => call === 'delete:sh_stuck')).toHaveLength(3)
    expect(ledger.outstanding()).toBe(1)
  })

  it('is unconfirmed when the DELETE itself fails and the shell is still running', async () => {
    // #given
    const ledger = ledgerWith('sh_1')
    const {api} = makeApi({sh_1: {status: 'running', owner: ROOT}}, {deleteFails: true})

    // #when
    const result = await killOwnedShells({
      api,
      directory: DIR,
      ownerSessionIds: owners,
      ledger,
      logger,
      rounds: 2,
      pollIntervalMs: 0,
    })

    // #then
    expect(result).toEqual({confirmed: false, stillRunning: ['sh_1']})
  })

  it('settles only the shells it confirmed gone', async () => {
    // #given
    const ledger = ledgerWith('sh_dies', 'sh_stuck')
    const {api} = makeApi(
      {sh_dies: {status: 'running', owner: ROOT}, sh_stuck: {status: 'running', owner: ROOT}},
      {deleteDoesNotKill: ['sh_stuck']},
    )

    // #when
    await killOwnedShells({api, directory: DIR, ownerSessionIds: owners, ledger, logger, rounds: 1})

    // #then
    expect(ledger.snapshot().map(entry => [entry.sessionId, entry.state])).toEqual([
      [shellLedgerKey('sh_dies'), 'settled'],
      [shellLedgerKey('sh_stuck'), 'outstanding'],
    ])
  })

  it('does not abort the stop on a throwing client', async () => {
    // #given
    const ledger = ledgerWith('sh_1')
    const api: ShellApi = {
      listShells: async () => {
        throw new Error('boom')
      },
      getShell: async () => err({kind: 'parse'}),
      deleteShell: async () => {
        throw new Error('boom')
      },
    }

    // #when
    const result = await killOwnedShells({api, directory: DIR, ownerSessionIds: owners, ledger, logger, rounds: 1})

    // #then
    expect(result.confirmed).toBe(false)
  })
})

describe('kill budget', () => {
  it('allows six rounds half a second apart: a kill takes about a second to leave the running list (p22)', () => {
    // #given / #when / #then
    expect(DEFAULT_SHELL_KILL_ROUNDS).toBe(6)
    expect(DEFAULT_SHELL_KILL_POLL_INTERVAL_MS).toBe(500)
  })
})

describe('listOwnedRunningShells', () => {
  const owners = new Set([ROOT, CHILD])

  it('lists the running shells tagged with the root or an owned session, and no others', async () => {
    // #given
    const {api, calls} = makeApi({
      sh_root: {status: 'running', owner: ROOT},
      sh_child: {status: 'running', owner: CHILD},
      sh_stranger: {status: 'running', owner: OTHER},
      sh_untagged: {status: 'running', owner: null},
      sh_done: {status: 'exited', owner: ROOT},
      sh_unknown: {status: 'unknown', owner: ROOT},
    })

    // #when
    const result = await listOwnedRunningShells({api, directory: DIR, ownerSessionIds: owners})

    // #then — a status the client does not know is read as running; the list is one request
    expect(result).toEqual({success: true, data: ['sh_root', 'sh_child', 'sh_unknown']})
    expect(calls).toEqual(['list'])
  })

  it('fails when the list cannot be read or throws, never reading it as empty', async () => {
    // #given
    const failing = makeApi({}, {listFails: [1]})
    const throwing: ShellApi = {
      listShells: async () => {
        throw new Error('boom')
      },
      getShell: async () => err({kind: 'parse'}),
      deleteShell: async () => err({kind: 'parse'}),
    }

    // #when / #then
    expect((await listOwnedRunningShells({api: failing.api, directory: DIR, ownerSessionIds: owners})).success).toBe(
      false,
    )
    expect((await listOwnedRunningShells({api: throwing, directory: DIR, ownerSessionIds: owners})).success).toBe(false)
  })
})
