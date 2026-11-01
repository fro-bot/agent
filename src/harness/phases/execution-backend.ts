import type {OwnershipLedger, SessionSearchResult} from '@fro-bot/runtime'
import type {AgentResultV2} from '../../features/agent/live-observation-v2.js'
import type {ExecutionConfig, PromptOptions} from '../../features/agent/types.js'
import type {Logger} from '../../shared/logger.js'
import type {RunSummary} from '../../shared/types.js'

/**
 * Everything `runExecute` needs from the OpenCode generation it runs on. This is the one selector: `runExecute` builds a
 * backend once (V1 in `execute.ts`, V2 in `execute-v2.ts`) and uses it for the main run AND the context-overflow
 * recovery restart, so the two `executeOpenCode` call sites can never end up on different generations.
 */

/**
 * A run summary a backend holds back for the release instead of writing now (V2: a synthetic message posted before the
 * release would sit queued in the root's inbox, and the release waits for an empty one). It travels as a field of the
 * execute phase's result to `runReleaseV2`, which writes it after the final reading of the directory.
 */
export interface DeferredSummaryV2 {
  readonly sessionId: string
  readonly text: string
}

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
  ) => Promise<AgentResultV2>
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
  /** Write the summary now (V1), or return it for the release to write (V2). */
  readonly writeSummary: (
    sessionId: string,
    summary: RunSummary,
    logger: Logger,
  ) => Promise<DeferredSummaryV2 | undefined>
}
