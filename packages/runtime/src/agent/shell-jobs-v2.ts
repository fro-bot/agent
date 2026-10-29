import type {Result} from '@bfra.me/es/result'
import type {Logger} from '../shared/logger.js'
import type {OwnershipLedger} from './ownership-ledger.js'
import type {RemoteOpenCodeV2Client, V2ShellSummary} from './remote-client-v2.js'

import {err, ok} from '@bfra.me/es/result'
import {toError} from '../shared/errors.js'
import {isShellLedgerKey, shellIdFromLedgerKey} from './ownership-ledger.js'

/**
 * Ownership of background `shell` jobs on OpenCode V2 (v2.2.0): reconciling the ledger's shell entries against the
 * server. See `shell-notice.ts` for what a background shell is.
 *
 * This is ownership bookkeeping (what the ledger shows, what `waitReason` says), not a release decision. A run is
 * released on the directory staying quiet (`directory-quiescence-v2.ts`), and a stop kills whatever shells the directory
 * shows (`root-stop-v2.ts`), owned or not.
 */

/** The three shell calls these functions need; the real V2 client satisfies it. */
export type ShellApi = Pick<RemoteOpenCodeV2Client, 'getShell' | 'listShells'>

function isStopped(shell: V2ShellSummary): boolean {
  return shell.status === 'exited' || shell.status === 'timeout' || shell.status === 'killed'
}

function describe(error: {readonly kind: string}): string {
  return error.kind
}

function unsettledShellEntries(ledger: OwnershipLedger): readonly {readonly key: string; readonly shellId: string}[] {
  return ledger
    .snapshot()
    .filter(entry => isShellLedgerKey(entry.sessionId) && entry.state !== 'settled')
    .map(entry => ({key: entry.sessionId, shellId: shellIdFromLedgerKey(entry.sessionId)}))
}

export interface ReconcileShellsOptions {
  readonly ledger: OwnershipLedger
  readonly api: ShellApi
  /** The location the shells run in: the directory the run's sessions were created at. */
  readonly directory: string
  readonly logger: Logger
  readonly signal?: AbortSignal
}

export interface ShellReconcileObservation {
  /** Unsettled shell ids this pass saw running. */
  readonly liveShellIds: ReadonlySet<string>
}

/**
 * One reconcile pass over the ledger's unsettled shell entries. Settles what it can prove stopped, never adopts.
 *
 * - Listed as running: left as it is.
 * - Absent from the list and `GET /api/shell/:id` reads `exited`, `timeout` or `killed`: settled.
 * - Absent from the list and `GET /api/shell/:id` is 404: settled. The server keeps the last 25 exited shells per
 *   location, so an old one is gone from the record, and a shell removed by a DELETE is too. Not running now is what
 *   the ledger needs; whether its notice arrived is the drain gate's separate question.
 * - Any other read failure: the entry is marked `unknown`, never settled.
 * - The list itself cannot be read: every outstanding shell becomes `unknown` and the pass fails.
 *
 * Makes no request when the ledger has no unsettled shell. Never throws.
 */
export async function reconcileShellsOnce(
  options: ReconcileShellsOptions,
): Promise<Result<ShellReconcileObservation, Error>> {
  const {ledger, api, directory, logger, signal} = options
  const entries = unsettledShellEntries(ledger)
  if (entries.length === 0) return ok({liveShellIds: new Set<string>()})

  const signalArg = signal === undefined ? {} : {signal}
  try {
    const listed = await api.listShells({directory, ...signalArg})
    if (!listed.success) {
      for (const entry of entries) ledger.markUnknown(entry.key)
      logger.warning('Shell reconciliation failed; marking outstanding shells unknown rather than settling them', {
        source: 'reconcileShellsOnce',
        unknownCount: entries.length,
        error: describe(listed.error),
      })
      return err(new Error(`shell.list failed: ${describe(listed.error)}`))
    }

    const running = new Set(listed.data.filter(shell => !isStopped(shell)).map(shell => shell.id))
    const liveShellIds = new Set<string>()
    const settled: string[] = []
    const unreadable: string[] = []
    for (const entry of entries) {
      if (running.has(entry.shellId)) {
        liveShellIds.add(entry.shellId)
        continue
      }
      const read = await api.getShell({directory, shellId: entry.shellId, ...signalArg})
      if (read.success && isStopped(read.data)) {
        ledger.settle(entry.key)
        settled.push(entry.shellId)
      } else if (read.success) {
        // Running after all: it started between the list and this read.
        liveShellIds.add(entry.shellId)
      } else if (read.error.kind === 'http' && read.error.status === 404) {
        ledger.settle(entry.key)
        settled.push(entry.shellId)
      } else {
        ledger.markUnknown(entry.key)
        unreadable.push(entry.shellId)
      }
    }
    if (settled.length > 0 || unreadable.length > 0) {
      logger.debug('Shell reconciliation adjusted ownership', {source: 'reconcileShellsOnce', settled, unreadable})
    }
    return ok({liveShellIds})
  } catch (error) {
    for (const entry of entries) ledger.markUnknown(entry.key)
    return err(toError(error))
  }
}
