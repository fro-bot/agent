/**
 * A stateful double for the background-shell routes of a V2 server (`GET /api/shell`, `GET /api/shell/:id`,
 * `DELETE /api/shell/:id`), shared by the gateway tests. Behaviour follows the bgshell probes: the list shows RUNNING
 * shells only, a DELETE kills the shell and removes its record (a later GET is 404), and an unknown id deletes as a no-op.
 */

import type {RemoteOpenCodeV2Client, V2CallError, V2ShellSummary} from '@fro-bot/runtime'

import {err, ok} from '@fro-bot/runtime'
import {vi} from 'vitest'

export interface FakeShell {
  status: V2ShellSummary['status']
  owner: string | null
}

export interface ShellServerOptions {
  readonly shells?: Readonly<Record<string, FakeShell>>
  /** Every call is appended here as `list`, `get:<id>` or `delete:<id>`, so a test can order it against other calls. */
  readonly log?: string[]
  /** A DELETE that is accepted and kills nothing. */
  readonly deleteDoesNotKill?: readonly string[]
  /** Fail every list call. */
  readonly listFails?: boolean
  /** Fail the nth list call (1-based). */
  readonly listFailsOn?: readonly number[]
  /** Fail every DELETE. */
  readonly deleteFails?: boolean
  /** Fail the per-shell read with this error. */
  readonly getFails?: Readonly<Record<string, V2CallError>>
}

export type ShellRoutes = Pick<RemoteOpenCodeV2Client, 'deleteShell' | 'getShell' | 'listShells'>

export function makeShellServer(options: ShellServerOptions = {}) {
  const shells: Record<string, FakeShell> = Object.fromEntries(
    Object.entries(options.shells ?? {}).map(([id, shell]) => [id, {...shell}]),
  )
  const log = options.log ?? []
  let listCount = 0
  const summary = (id: string, shell: FakeShell): V2ShellSummary => ({
    id,
    status: shell.status,
    ownerSessionId: shell.owner,
    pid: shell.status === 'running' ? 4242 : null,
  })

  const listShells = vi.fn(async () => {
    listCount += 1
    log.push('list')
    if (options.listFails === true || options.listFailsOn?.includes(listCount) === true) {
      return err<V2CallError>({kind: 'network', message: 'down'})
    }
    return ok(
      Object.entries(shells)
        .filter(([, shell]) => shell.status === 'running' || shell.status === 'unknown')
        .map(([id, shell]) => summary(id, shell)),
    )
  })
  const getShell = vi.fn(async ({shellId}: {readonly shellId: string}) => {
    log.push(`get:${shellId}`)
    const failure = options.getFails?.[shellId]
    if (failure !== undefined) return err<V2CallError>(failure)
    const shell = shells[shellId]
    return shell === undefined ? err<V2CallError>({kind: 'http', status: 404}) : ok(summary(shellId, shell))
  })
  const deleteShell = vi.fn(async ({shellId}: {readonly shellId: string}) => {
    log.push(`delete:${shellId}`)
    if (options.deleteFails === true) return err<V2CallError>({kind: 'network', message: 'down'})
    if (options.deleteDoesNotKill?.includes(shellId) !== true) {
      delete shells[shellId]
    }
    return ok(undefined)
  })

  return {
    routes: {listShells, getShell, deleteShell} as unknown as ShellRoutes,
    listShells,
    getShell,
    deleteShell,
    shells,
    log,
  }
}
