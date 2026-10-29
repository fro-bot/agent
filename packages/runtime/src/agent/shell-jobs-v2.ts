import type {Result} from '@bfra.me/es/result'
import type {Logger} from '../shared/logger.js'
import type {OwnershipLedger} from './ownership-ledger.js'
import type {RemoteOpenCodeV2Client, V2ShellSummary} from './remote-client-v2.js'

import {err, ok} from '@bfra.me/es/result'
import {toError} from '../shared/errors.js'
import {isShellLedgerKey, shellIdFromLedgerKey} from './ownership-ledger.js'

/**
 * Ownership of background `shell` jobs on OpenCode V2 (v2.2.0): reconciling the ledger's shell entries against the
 * server, and killing the shells a run owns when the run stops. See `shell-notice.ts` for what a background shell is.
 *
 * Why the kill is explicit: a session interrupt does not stop a background shell (`Job.cancel(sessionID)` matches no job
 * under a session id, bgshell probe p21-b), and the shell outlives the run's lock. `DELETE /api/shell/:id` is the one
 * route that stops it (probe p22). It is location-scoped and answers 204 for an unknown id, so a stop is confirmed only
 * by `GET /api/shell` (running shells) no longer listing the shell. The job ends as `error` and its notice WAKES the
 * owning session, so a caller that kills must still keep the session from running (it interrupts it afterwards).
 */

/** The three shell calls these functions need; the real V2 client satisfies it. */
export type ShellApi = Pick<RemoteOpenCodeV2Client, 'deleteShell' | 'getShell' | 'listShells'>

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

/** The root and every session the ledger tracks, in any state: the sessions whose shells belong to this run. */
export function collectOwnerSessionIds(rootSessionId: string, ledger: OwnershipLedger): ReadonlySet<string> {
  const owners = new Set<string>([rootSessionId])
  for (const entry of ledger.snapshot()) {
    if (!isShellLedgerKey(entry.sessionId)) owners.add(entry.sessionId)
  }
  return owners
}

export interface ListOwnedRunningShellsOptions {
  readonly api: ShellApi
  readonly directory: string
  /** The root and the sessions this run owns (`collectOwnerSessionIds`). */
  readonly ownerSessionIds: ReadonlySet<string>
  readonly signal?: AbortSignal
}

/**
 * Ids of the running shells in `directory` tagged with an owned session, straight from the server and not from the
 * ledger. A shell whose creation frame arrived before its owner was adopted, or never arrived, is invisible to the
 * ledger and visible here. A status the client does not know counts as running. A list that cannot be read is an error,
 * never an empty answer. Never throws.
 */
export async function listOwnedRunningShells(
  options: ListOwnedRunningShellsOptions,
): Promise<Result<readonly string[], Error>> {
  const {api, directory, ownerSessionIds, signal} = options
  try {
    const listed = await api.listShells({directory, ...(signal === undefined ? {} : {signal})})
    if (!listed.success) return err(new Error(`shell.list failed: ${describe(listed.error)}`))
    return ok(
      listed.data
        .filter(
          shell => !isStopped(shell) && shell.ownerSessionId !== null && ownerSessionIds.has(shell.ownerSessionId),
        )
        .map(shell => shell.id),
    )
  } catch (error) {
    return err(toError(error))
  }
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

/** Pause between kill rounds. A killed process leaves the running list in about a second (probe p22). */
export const DEFAULT_SHELL_KILL_POLL_INTERVAL_MS = 500
/** Kill rounds before a shell is reported as still running: about three seconds, three times the observed kill. */
export const DEFAULT_SHELL_KILL_ROUNDS = 6

export interface KillOwnedShellsOptions {
  readonly api: ShellApi
  readonly directory: string
  /** The root and the sessions this run owns (`collectOwnerSessionIds`). A running shell tagged with one is killed. */
  readonly ownerSessionIds: ReadonlySet<string>
  /** Its unsettled shell entries are killed whether or not the list shows them; confirmed ones are settled. */
  readonly ledger: OwnershipLedger
  readonly logger: Logger
  readonly signal?: AbortSignal
  readonly rounds?: number
  readonly pollIntervalMs?: number
}

export type KillOwnedShellsResult =
  | {readonly confirmed: true; readonly deleted: readonly string[]}
  /** `stillRunning` is the shells not shown gone; every target when the confirming list could not be read. */
  | {readonly confirmed: false; readonly stillRunning: readonly string[]}

/**
 * Kill every shell this run owns: the ledger's unsettled shells plus any running shell of the location that is tagged
 * with the root or an owned session (a shell whose creation the stream never delivered). Each round sends a DELETE per
 * target and re-lists to confirm; the stop is confirmed only when no target is listed running. A listed shell of a
 * stranger, or one nobody tagged, is left alone.
 *
 * Confirmed ledger entries are settled. A DELETE queues an `error` notice that wakes the owning session, so settling
 * here does not mean the owner is quiet: a caller that deleted anything (`deleted` is non-empty) must not confirm the
 * root. The accepted cost is that every stop with a live owned shell quarantines, even after a clean kill. Never
 * throws; every failure is an unconfirmed result.
 */
export async function killOwnedShells(options: KillOwnedShellsOptions): Promise<KillOwnedShellsResult> {
  const {
    api,
    directory,
    ownerSessionIds,
    ledger,
    logger,
    signal,
    rounds = DEFAULT_SHELL_KILL_ROUNDS,
    pollIntervalMs = DEFAULT_SHELL_KILL_POLL_INTERVAL_MS,
  } = options
  const signalArg = signal === undefined ? {} : {signal}
  const ledgerEntries = unsettledShellEntries(ledger)
  const targets = new Set(ledgerEntries.map(entry => entry.shellId))
  const deleted = new Set<string>()
  let stillRunning: readonly string[] = [...targets]

  function addOwnedRunning(shells: readonly V2ShellSummary[]): void {
    for (const shell of shells) {
      if (isStopped(shell)) continue
      if (shell.ownerSessionId !== null && ownerSessionIds.has(shell.ownerSessionId)) targets.add(shell.id)
    }
  }

  async function list(): Promise<readonly V2ShellSummary[] | null> {
    try {
      const listed = await api.listShells({directory, ...signalArg})
      if (listed.success) return listed.data
      logger.warning('Owned shell stop: the shell list could not be read', {error: describe(listed.error)})
    } catch (error) {
      logger.warning('Owned shell stop: the shell list threw', {detail: toError(error).message})
    }
    return null
  }

  for (let round = 1; round <= rounds; round++) {
    if (signal?.aborted === true) break
    const before = await list()
    if (before !== null) addOwnedRunning(before)
    if (before !== null && targets.size === 0) return {confirmed: true, deleted: []}
    if (before === null && targets.size === 0) {
      // Nothing is known to kill and the list is unreadable: no owned shell can be ruled out.
      return {confirmed: false, stillRunning: []}
    }

    await Promise.all(
      [...targets].map(async shellId => {
        try {
          const result = await api.deleteShell({directory, shellId, ...signalArg})
          if (result.success) deleted.add(shellId)
          else
            logger.warning('Owned shell stop: a shell DELETE returned an error', {
              shellId,
              error: describe(result.error),
            })
        } catch (error) {
          logger.warning('Owned shell stop: a shell DELETE threw', {shellId, detail: toError(error).message})
        }
      }),
    )

    const after = await list()
    if (after === null) {
      stillRunning = [...targets]
    } else {
      // A shell an owned session started since the first reading is a target of the next round.
      addOwnedRunning(after)
      const running = new Set(after.filter(shell => !isStopped(shell)).map(shell => shell.id))
      for (const entry of ledgerEntries) {
        if (!running.has(entry.shellId)) ledger.settle(entry.key)
      }
      stillRunning = [...targets].filter(shellId => running.has(shellId))
      if (stillRunning.length === 0) return {confirmed: true, deleted: [...deleted]}
    }

    if (round < rounds && pollIntervalMs > 0) {
      await new Promise<void>(resolve => {
        setTimeout(resolve, pollIntervalMs)
      })
    }
  }

  logger.error('Owned shell stop: shells could not be confirmed stopped', {stillRunning})
  return {confirmed: false, stillRunning}
}
