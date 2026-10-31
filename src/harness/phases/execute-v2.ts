import type {OwnershipLedger} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {CacheRestoreV2PhaseResult} from './cache-restore.js'
import type {ExecutionBackend} from './execution-backend.js'
import {formatSummaryForSession} from '@fro-bot/runtime'
import {searchSessionsV2} from '@fro-bot/runtime/session-v2'
import {createActionClientV2, executeOpenCodeV2} from '../../features/agent/execution-v2.js'
import {toErrorMessage} from '../../shared/errors.js'
import {createSessionReaderV2} from './session-v2.js'

/**
 * The OpenCode V2 side of `runExecute`'s selector (`execute.ts`): the same six operations as V1, over the V2 server's
 * routes. The retry policy, deadline and one-comment protocol are not here; they are shared with V1 inside
 * `executeOpenCodeV2`.
 */
export function createExecutionBackendV2(cacheRestore: CacheRestoreV2PhaseResult): ExecutionBackend {
  const {serverHandle} = cacheRestore
  const client = createActionClientV2(serverHandle)
  const reader = createSessionReaderV2(serverHandle.fetch)

  return {
    execute: async (promptOptions, logger, config, ledger) =>
      executeOpenCodeV2(promptOptions, logger, config, serverHandle, ledger, client),

    // TODO(U12b): cancel the overflowed session's owned children (interrupt them, then confirm they stopped) before the
    // archive, as V1's `runDrain({deadlineMs: 0})` does.
    // The ledger is all this unit can see, so anything it still holds is unresolved and blocks the restart. The release
    // unit (U12b) replaces this with a stop that is confirmed against the directory.
    drainOverflowed: async (ledger: OwnershipLedger) => {
      const held = ledger.outstanding() + ledger.unknown()
      return {unknownCount: held, restartSafe: held === 0}
    },

    archive: async (sessionId: string, logger: Logger) => {
      try {
        const result = await client.updateSession({sessionId, archived: true})
        if (!result.success) {
          logger.warning('V2 session archive failed', {sessionId, error: result.error.kind})
          return false
        }
        logger.debug('Archived session via V2 route', {sessionId})
        return true
      } catch (error) {
        logger.warning('V2 session archive failed', {sessionId, error: toErrorMessage(error)})
        return false
      }
    },

    searchPriorWork: async (query, workspace, excludeSessionIds, logger) => {
      const searched = await searchSessionsV2(query, reader, workspace, {limit: 5, excludeSessionIds}, logger)
      if (!searched.success) throw searched.error
      return searched.data
    },

    // The V2 loop creates the session itself and reports its id, so there is nothing to look up afterwards.
    findLatestSessionId: async () => null,

    writeSummary: async (sessionId, summary, logger) => {
      try {
        const result = await client.addSyntheticMessage({sessionId, text: formatSummaryForSession(summary)})
        if (!result.success) {
          logger.warning('V2 summary writeback failed', {sessionId, error: result.error.kind})
          return
        }
        logger.info('Session summary written via V2 route', {sessionId})
      } catch (error) {
        logger.warning('V2 summary writeback failed', {sessionId, error: toErrorMessage(error)})
      }
    },
  }
}
