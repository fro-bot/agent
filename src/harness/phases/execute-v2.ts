import type {OwnershipLedger} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {CacheRestoreV2PhaseResult} from './cache-restore.js'
import type {ExecutionBackend} from './execution-backend.js'
import {searchSessionsV2} from '@fro-bot/runtime/session-v2'
import {stopAndConfirmQuietV2} from '../../features/agent/drain-v2.js'
import {createActionClientV2, executeOpenCodeV2} from '../../features/agent/execution-v2.js'
import {toErrorMessage} from '../../shared/errors.js'
import {createSessionReaderV2} from './session-v2.js'

/**
 * The OpenCode V2 side of `runExecute`'s selector (`execute.ts`): the same six operations as V1, over the V2 server's
 * routes. The retry policy, deadline and one-comment protocol are not here; they are shared with V1 inside
 * `executeOpenCodeV2`.
 */
/** The longest the overflow archive may take. It is best-effort: a session left unarchived is re-continued next run. */
export const ARCHIVE_TIMEOUT_MS = 10_000

export function createExecutionBackendV2(cacheRestore: CacheRestoreV2PhaseResult): ExecutionBackend {
  const {serverHandle} = cacheRestore
  const client = createActionClientV2(serverHandle)
  const runStartedAt = Date.now()
  const reader = createSessionReaderV2(serverHandle.fetch)

  return {
    execute: async (promptOptions, logger, config, ledger) =>
      executeOpenCodeV2(promptOptions, logger, config, serverHandle, ledger, client),

    // Before the overflowed session is archived and its replacement starts, stop what it left running: its children,
    // and the shells its sessions started. The recovery session shares the directory, so a child still writing would
    // race it. Nothing is trusted from a reply: the directory is read until it stays quiet (the V2 form of V1's
    // `runDrain({deadlineMs: 0})`). The server stays up for the recovery run, so this stops short of shutdown. A stop
    // the directory does not confirm is reported unresolved, which keeps persistence closed and the run incomplete.
    drainOverflowed: async (ledger: OwnershipLedger, sessionId: string, logger: Logger) => {
      const confirmation = await stopAndConfirmQuietV2({
        client,
        directory: serverHandle.directory,
        rootSessionId: sessionId,
        ledger,
        runStartedAt,
        logger,
      })
      const held = ledger.outstanding() + ledger.unknown()
      // Anything the stop could not confirm blocks the restart: a replacement session would share the directory with it.
      return {
        unknownCount: confirmation.quiet ? held : Math.max(1, held),
        restartSafe: confirmation.quiet && held === 0,
      }
    },

    // Fail-soft and bounded: this runs after the execution deadline has been disposed, so a request that never answers
    // would hold the run (and its cleanup) past the budget. The signal stops a client that honors it; the race ends the
    // wait for one that does not.
    archive: async (sessionId: string, logger: Logger) => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<'timed-out'>(resolve => {
        timer = setTimeout(() => {
          controller.abort()
          resolve('timed-out')
        }, ARCHIVE_TIMEOUT_MS)
      })
      try {
        const settled = await Promise.race([
          client.updateSession({sessionId, archived: true, signal: controller.signal}),
          timedOut,
        ])
        if (settled === 'timed-out') {
          logger.warning('V2 session archive timed out', {sessionId, timeoutMs: ARCHIVE_TIMEOUT_MS})
          return false
        }
        const result = settled
        if (!result.success) {
          logger.warning('V2 session archive failed', {sessionId, error: result.error.kind})
          return false
        }
        logger.debug('Archived session via V2 route', {sessionId})
        return true
      } catch (error) {
        logger.warning('V2 session archive failed', {sessionId, error: toErrorMessage(error)})
        return false
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },

    searchPriorWork: async (query, workspace, excludeSessionIds, logger) => {
      const searched = await searchSessionsV2(query, reader, workspace, {limit: 5, excludeSessionIds}, logger)
      if (!searched.success) throw searched.error
      return searched.data
    },

    // The V2 loop creates the session itself and reports its id, so there is nothing to look up afterwards.
    findLatestSessionId: async () => null,

    // Returned, not written: a summary posted now would sit in the root's inbox as a queued item and the directory gate
    // would wait on it for ever. It rides on the execute result to the release, which writes it after the final reading,
    // just before the shutdown (`release-v2.ts`).
    writeSummary: async (sessionId, summary, logger) => {
      logger.debug('Session summary deferred until the run is released', {sessionId})
      return {sessionId, summary}
    },
  }
}
