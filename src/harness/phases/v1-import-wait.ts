import type {Result} from '@bfra.me/es/result'
import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import {existsSync, statSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {err, ok} from '@bfra.me/es/result'
import {readV1MigrationStatus} from '@fro-bot/runtime'

/**
 * Waits for OpenCode V2's V1 session-history import to finish before the Action sends a prompt.
 *
 * A V2 server that boots on a restored V1 database imports the history in the background (`GET
 * /api/experimental/migration/v1`). A prompt sent before it finishes would race the import for the database. The wait
 * polls the runtime's single read until it says `completed`, and fails closed on everything else:
 *
 * - `required` and `running` keep waiting (probe P7 never saw `required` at 250 ms polling, but it is in the union);
 * - `error` fails at once;
 * - the whole wait is bounded (300 s: about 2.7 times the worst P7 sample, 111 s on a 488 MB row-heavy database);
 * - `running` progress (`numerator`, sessions migrated) that does not move for the stall window fails the wait before the
 *   hard bound. A `running` reading with no progress at all cannot show a stall, so only the hard bound applies;
 * - an `unreadable` reading is retried, bounded by a count of consecutive failures, and is never read as `completed`.
 *
 * Any failure means no prompt and no save: the caller (`cache-restore.ts`) reports the failed start, and the run
 * declines to persist session state.
 */

export const V1_IMPORT_WAIT_TIMEOUT_MS = 300_000
export const V1_IMPORT_STALL_TIMEOUT_MS = 60_000
export const V1_IMPORT_POLL_INTERVAL_MS = 500
export const V1_IMPORT_MAX_CONSECUTIVE_UNREADABLE = 5

export type V1ImportWaitErrorKind = 'aborted' | 'import-error' | 'stalled' | 'timeout' | 'unreadable'

export interface V1ImportWaitError {
  readonly kind: V1ImportWaitErrorKind
  readonly message: string
}

export interface V1ImportWaitSuccess {
  readonly durationMs: number
  readonly polls: number
}

/** What the restored database looked like before the import, logged on every wait. */
export interface V1DatabaseFacts {
  readonly bytes: number | null
  readonly sessions: number | null
}

export interface WaitForV1ImportOptions {
  /** The V2 server handle's `fetch`: it carries the credential and the location header. */
  readonly fetch: OpenCodeV2ServerHandle['fetch']
  readonly logger: Logger
  readonly facts?: V1DatabaseFacts
  readonly timeoutMs?: number
  readonly stallTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly maxConsecutiveUnreadable?: number
  readonly signal?: AbortSignal
}

/** The server's import error text may name paths, so only its first line is kept, and only so far. */
const MAX_DETAIL_LENGTH = 200

function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? ''
  return line.length > MAX_DETAIL_LENGTH ? `${line.slice(0, MAX_DETAIL_LENGTH)}...` : line
}

async function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return
  await new Promise<void>(resolve => {
    let timer: NodeJS.Timeout | undefined
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, {once: true})
  })
}

export async function waitForV1Import(
  options: WaitForV1ImportOptions,
): Promise<Result<V1ImportWaitSuccess, V1ImportWaitError>> {
  const {
    fetch,
    logger,
    signal,
    facts,
    timeoutMs = V1_IMPORT_WAIT_TIMEOUT_MS,
    stallTimeoutMs = V1_IMPORT_STALL_TIMEOUT_MS,
    pollIntervalMs = V1_IMPORT_POLL_INTERVAL_MS,
    maxConsecutiveUnreadable = V1_IMPORT_MAX_CONSECUTIVE_UNREADABLE,
  } = options

  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  logger.info('Waiting for the OpenCode V2 import of V1 session history', {
    databaseBytes: facts?.bytes ?? null,
    sessionCount: facts?.sessions ?? null,
    timeoutMs,
    stallTimeoutMs,
  })

  let polls = 0
  let consecutiveUnreadable = 0
  let lastNumerator: number | undefined
  let lastProgressAt: number | undefined
  let lastLoggedNumerator: number | undefined

  for (;;) {
    if (signal?.aborted === true) {
      return err({kind: 'aborted', message: 'The wait for the OpenCode V2 import was cancelled'})
    }

    const reading = await readV1MigrationStatus({fetch, ...(signal === undefined ? {} : {signal})})
    polls += 1
    const now = Date.now()

    switch (reading.status) {
      case 'completed': {
        const durationMs = now - startedAt
        logger.info('OpenCode V2 import of V1 session history completed', {
          durationMs,
          polls,
          databaseBytes: facts?.bytes ?? null,
          sessionCount: facts?.sessions ?? null,
        })
        return ok({durationMs, polls})
      }
      case 'error':
        logger.error('OpenCode V2 import of V1 session history failed', {polls, detail: firstLine(reading.error)})
        return err({
          kind: 'import-error',
          message: `The OpenCode V2 import of V1 session history failed: ${firstLine(reading.error)}`,
        })
      case 'unreadable': {
        if (reading.reason === 'aborted') {
          return err({kind: 'aborted', message: 'The wait for the OpenCode V2 import was cancelled'})
        }
        consecutiveUnreadable += 1
        logger.warning('OpenCode V2 import status could not be read', {
          reason: reading.reason,
          ...(reading.reason === 'http' ? {httpStatus: reading.httpStatus} : {}),
          consecutiveUnreadable,
        })
        if (consecutiveUnreadable >= maxConsecutiveUnreadable) {
          return err({
            kind: 'unreadable',
            message: `The OpenCode V2 import status was unreadable ${consecutiveUnreadable} times in a row`,
          })
        }
        break
      }
      case 'required':
        consecutiveUnreadable = 0
        break
      case 'running': {
        consecutiveUnreadable = 0
        const numerator = reading.progress?.numerator
        if (numerator !== undefined) {
          // The first reading with a count starts the clock; any change restarts it. Only movement counts.
          if (lastProgressAt === undefined || numerator !== lastNumerator) lastProgressAt = now
          lastNumerator = numerator
          if (numerator !== lastLoggedNumerator) {
            lastLoggedNumerator = numerator
            logger.debug('OpenCode V2 import progress', {
              migrated: numerator,
              total: reading.progress?.denominator ?? null,
            })
          }
        }
        break
      }
    }

    // A stalled count is checked on every reading, including an unreadable one in between: the clock is real time.
    if (lastProgressAt !== undefined && now - lastProgressAt >= stallTimeoutMs) {
      logger.error('OpenCode V2 import of V1 session history stalled', {
        migrated: lastNumerator ?? null,
        stallTimeoutMs,
        polls,
      })
      return err({
        kind: 'stalled',
        message: `The OpenCode V2 import of V1 session history made no progress for ${Math.round(stallTimeoutMs / 1000)}s (${lastNumerator ?? 0} sessions migrated)`,
      })
    }
    if (now >= deadline) {
      logger.error('OpenCode V2 import of V1 session history exceeded its bound', {timeoutMs, polls})
      return err({
        kind: 'timeout',
        message: `The OpenCode V2 import of V1 session history did not finish within ${Math.round(timeoutMs / 1000)}s`,
      })
    }

    await sleepUnlessAborted(Math.min(pollIntervalMs, Math.max(0, deadline - now)), signal)
  }
}

/**
 * The size and session count of the restored database, for the wait's log line. Read before the spawn, while no server
 * holds the file. A V2 database, an empty one or an unreadable one reports `null` for what it cannot say; this never
 * throws, because a diagnostic must not fail the run.
 */
export function readV1DatabaseFacts(dbPath: string): V1DatabaseFacts {
  if (!existsSync(dbPath)) return {bytes: null, sessions: null}
  let bytes: number | null = null
  try {
    bytes = statSync(dbPath).size
  } catch {
    return {bytes: null, sessions: null}
  }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath, {readOnly: true})
    const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'session'").get()
    if (table === undefined) return {bytes, sessions: null}
    const row = db.prepare('SELECT COUNT(*) AS count FROM session').get()
    const count = row?.count
    return {bytes, sessions: typeof count === 'number' || typeof count === 'bigint' ? Number(count) : null}
  } catch {
    return {bytes, sessions: null}
  } finally {
    try {
      db?.close()
    } catch {
      // Nothing useful to do if close fails on a diagnostic read.
    }
  }
}
