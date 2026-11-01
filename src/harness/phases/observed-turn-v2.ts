import type {ErrorInfo} from '@fro-bot/runtime'
import type {RootTerminalV2} from '../../features/agent/streaming-v2.js'
import type {EventStreamResult} from '../../features/agent/streaming.js'
import type {RunUsageV2} from '../../features/agent/usage-v2.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {ExecutePhaseResult} from './execute.js'
import {createAgentError} from '@fro-bot/runtime'

/**
 * What the event observation saw between the prompt attempt's return and the release, folded back into the execution
 * result.
 *
 * The run's outcome is the outcome of the LAST root turn. The first turn can succeed while a notice then starts a second
 * one that fails; that run failed. Text needs no choosing: the loop writes every turn's text to the log in the order it
 * arrives, never replacing an earlier turn (V1 does the same), and what the run delivers is the response file or the
 * comment the agent posted, which finalize reads after the release, so a later turn's version is the one it finds.
 * Artifacts (pull requests, commits, comments) accumulate over every turn.
 */
export interface ObservedTurnV2 {
  /** Everything the stream gathered over its life (the same processor as the attempt's, so a superset of its result). */
  readonly result: EventStreamResult
  /** How the root's latest turn ended, or `null` when none ended after the last one began (or none was seen). */
  readonly rootTerminal: RootTerminalV2 | null
  /** The failure the tracker recorded for that turn, when there is one. */
  readonly failure: ErrorInfo | null
  /** The run's usage re-read after the last turn, or `null` when it could not be read. */
  readonly usage: RunUsageV2 | null
}

function appendNew(known: readonly string[], seen: readonly string[]): string[] {
  return [...known, ...seen.filter(item => !known.includes(item))]
}

/** Pure part: the execution result after the observed turns. A result that already failed stays as it was. */
export function mergeObservedTurn(execution: ExecutePhaseResult, observed: ObservedTurnV2): ExecutePhaseResult {
  const base: ExecutePhaseResult = {
    ...execution,
    prsCreated: appendNew(execution.prsCreated, observed.result.prsCreated),
    commitsCreated: appendNew(execution.commitsCreated, observed.result.commitsCreated),
    commentsPosted: Math.max(execution.commentsPosted, observed.result.commentsPosted),
    observationGap: execution.observationGap || observed.result.discontinuity !== undefined,
    ...(observed.usage?.tokens == null
      ? {}
      : {tokenUsage: observed.usage.tokens, cost: observed.usage.cost, model: observed.usage.model ?? execution.model}),
  }
  if (!execution.success) return base

  const terminal = observed.rootTerminal
  if (terminal?.kind === 'failed') {
    const llmError = observed.failure ?? observed.result.llmError ?? createAgentError('The final root turn failed')
    return {
      ...base,
      success: false,
      exitCode: 1,
      error: llmError.message,
      llmError,
      ...(observed.result.classificationPath === undefined
        ? {}
        : {classificationPath: observed.result.classificationPath}),
    }
  }
  if (terminal?.kind === 'interrupted') {
    return {...base, success: false, exitCode: 1, error: `The final root turn was interrupted (${terminal.reason})`}
  }
  return base
}

/** Record into the run's metrics what the observed turns added to the execution result. */
export function recordObservedTurn(
  before: ExecutePhaseResult,
  after: ExecutePhaseResult,
  metrics: MetricsCollector,
): void {
  for (const pr of after.prsCreated) if (!before.prsCreated.includes(pr)) metrics.addPRCreated(pr)
  for (const commit of after.commitsCreated)
    if (!before.commitsCreated.includes(commit)) metrics.addCommitCreated(commit)
  for (let i = before.commentsPosted; i < after.commentsPosted; i++) metrics.incrementComments()
  if (after.tokenUsage != null && after.tokenUsage !== before.tokenUsage) {
    metrics.setTokenUsage(after.tokenUsage, after.model, after.cost)
  }
  if (after.llmError != null && before.llmError == null) {
    metrics.recordError(
      after.llmError.type,
      after.llmError.message,
      after.llmError.retryable,
      after.classificationPath,
      after.llmError.suggestedAction,
    )
  }
}
