import type {OwnershipLedger, SessionSearchResult} from '@fro-bot/runtime'
import type {AgentResult, ExecutionConfig, PromptOptions} from '../../features/agent/types.js'
import type {Logger} from '../../shared/logger.js'
import type {RunSummary} from '../../shared/types.js'

/**
 * Everything `runExecute` needs from the OpenCode generation it runs on. This is the one selector: `runExecute` builds a
 * backend once (V1 in `execute.ts`, V2 in `execute-v2.ts`) and uses it for the main run AND the context-overflow
 * recovery restart, so the two `executeOpenCode` call sites can never end up on different generations.
 */

/** What draining the overflowed session's own work left behind (the V1 `DrainOutcome` fields the recovery reads). */
export interface OverflowDrainOutcome {
  readonly unknownCount: number
  /**
   * `false` when the stop could not be confirmed, so a replacement session would race whatever the overflowed session
   * still has running in the shared directory: the recovery then neither archives nor restarts. A backend that leaves it
   * out keeps the recovery's older rule (restart, and report the unresolved ownership).
   */
  readonly restartSafe?: boolean
}

export interface ExecutionBackend {
  /** Run one prompt to completion on this generation. */
  readonly execute: (
    promptOptions: PromptOptions,
    logger: Logger,
    config: ExecutionConfig,
    ledger: OwnershipLedger,
  ) => Promise<AgentResult>
  /** Cancel and settle the work the overflowed session still owns, before it is archived. */
  readonly drainOverflowed: (
    ledger: OwnershipLedger,
    sessionId: string,
    logger: Logger,
  ) => Promise<OverflowDrainOutcome>
  readonly archive: (sessionId: string, logger: Logger) => Promise<boolean>
  readonly searchPriorWork: (
    query: string,
    workspace: string,
    excludeSessionIds: readonly string[],
    logger: Logger,
  ) => Promise<readonly SessionSearchResult[]>
  /** The newest session created after `afterTimestamp`, for a run that did not report its session id. */
  readonly findLatestSessionId: (afterTimestamp: number, workspace: string, logger: Logger) => Promise<string | null>
  readonly writeSummary: (sessionId: string, summary: RunSummary, logger: Logger) => Promise<void>
}
