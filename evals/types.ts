import type {PullRequestEvent} from '@octokit/webhooks-types'
import type {AgentResult, DiffFileSummary} from '../packages/runtime/src/agent/index.js'
import type {ParsedResponse, ResponseFileVerdict} from '../packages/runtime/src/agent/response-file.js'

export interface Scenario {
  readonly id: string
  readonly description: string
  readonly files: Readonly<Record<string, string>>
  readonly event: PullRequestEvent
  readonly prompt: string
  readonly diffFiles: readonly DiffFileSummary[]
  readonly expectedVerdict: ResponseFileVerdict
  readonly expectedDefectFile: string | null
  readonly expectedDefectSignals: readonly string[]
}

export interface GateResult {
  readonly id: string
  readonly kind: GateKind
  readonly status: GateStatus
  readonly detail: string
}
export type GateStatus = 'passed' | 'failed' | 'not-evaluated'

/**
 * Quality gates score the agent's output and are only meaningful once execution completed.
 * Safety gates score what the run did to the world and stay meaningful on a partial run:
 * a repository mutated or a secret echoed is an observed fact, not an absent outcome.
 */
export type GateKind = 'quality' | 'safety'

export type EvalRunState = 'passed' | 'failed' | 'inconclusive'

/**
 * The slice of a run that is observable from the response file and agent result alone.
 *
 * Kept separate from {@link EvalRunArtifacts} deliberately: a collector that knows only
 * this much must not be able to supply placeholder values for the scenario expectations
 * or the mutation scan. Placeholders in that position previously produced a gate that
 * could never fail, which is worse than no gate at all.
 */
export interface ResponseArtifacts {
  readonly responseFileExists: boolean
  readonly parsedResponse: ParsedResponse | null
  readonly responseFileError: string | null
  readonly deliveryCount: number
  readonly output: string
  readonly canary: string
  readonly executionSucceeded: boolean
  readonly executionFailureReason: string | null
  readonly executionExitCode: number
  readonly executionDurationMs: number
  readonly configuredTimeoutMs: number
}

export interface EvalRunArtifacts extends ResponseArtifacts {
  readonly scenarioId: string
  readonly expectedVerdict: ResponseFileVerdict
  readonly expectedDefectFile: string | null
  readonly expectedDefectSignals: readonly string[]
  readonly forbiddenMutations: readonly string[]
}

export interface RunEvaluation {
  readonly state: EvalRunState
  readonly reason: string
  readonly gates: readonly GateResult[]
}

export interface ExecutionDiagnostics {
  readonly completed: boolean
  readonly reason: string | null
  readonly exitCode: number
  readonly durationMs: number
  readonly timeoutMs: number
  /** Where the agent's logs were copied before the isolated home was destroyed, when execution did not complete. */
  readonly diagnosticsPath: string | null
}

export interface EvalRunReport {
  readonly scenarioId: string
  readonly model: string
  readonly openCodeVersion: string
  readonly promptHash: string
  readonly scenarioCommitSha: string
  readonly durationMs: number
  readonly cost: number | null
  readonly state: EvalRunState
  readonly stateReason: string
  readonly execution: ExecutionDiagnostics
  readonly gates: readonly GateResult[]
  readonly agentResult: Pick<AgentResult, 'success' | 'exitCode' | 'error' | 'tokenUsage'>
}
