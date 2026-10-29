import type {Result} from '@bfra.me/es/result'
import type {Logger} from '../shared/logger.js'
import type {V2CallError, V2ShellSummary} from './remote-client-v2.js'
import type {ShellApi} from './shell-jobs-v2.js'

import {err, ok} from '@bfra.me/es/result'
import {describe, expect, it, vi} from 'vitest'

import {createOwnershipLedger, shellLedgerKey} from './ownership-ledger.js'
import {reconcileShellsOnce} from './shell-jobs-v2.js'

const DIR = '/workspace/repo'
const ROOT = 'ses_root'
const CHILD = 'ses_child'

const logger: Logger = {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}

type Status = V2ShellSummary['status']

interface FakeShell {
  status: Status
  owner: string | null
}

/** A shell API over a mutable table. */
function makeApi(
  shells: Record<string, FakeShell>,
  options: {
    readonly listFails?: readonly number[]
    readonly getFails?: Readonly<Record<string, V2CallError>>
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
