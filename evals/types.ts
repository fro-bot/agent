import type {IssueCommentEvent, PullRequestEvent} from '@octokit/webhooks-types'
import type {AgentResult, DiffFileSummary} from '../packages/runtime/src/agent/index.js'
import type {ParsedResponse, ResponseFileVerdict} from '../packages/runtime/src/agent/response-file.js'
import type {SessionContext} from '../packages/runtime/src/agent/types.js'
import type {HydratedContext} from '../src/features/agent/types.js'

export interface PullRequestSurface {
  readonly kind: 'pull_request'
  readonly event: PullRequestEvent
  readonly diffFiles: readonly DiffFileSummary[]
  readonly hydratedContext: HydratedContext | null
}

export interface IssueCommentSurface {
  readonly kind: 'issue_comment'
  readonly event: IssueCommentEvent
  readonly hydratedContext: HydratedContext | null
}

export type ScenarioSurface = PullRequestSurface | IssueCommentSurface

export interface SignalGroup {
  readonly id: string
  readonly anyOf: readonly [string, ...string[]]
}

export interface OutcomeExpectations {
  readonly verdict: ResponseFileVerdict | null
  readonly requiredSignals: readonly SignalGroup[]
}

export interface PriorWork {
  readonly sessionContext: SessionContext
  readonly currentThreadSessionId: string
}

export interface Scenario {
  readonly id: string
  readonly description: string
  readonly files: Readonly<Record<string, string>>
  readonly surface: ScenarioSurface
  readonly prompt: string
  readonly priorWork: PriorWork | null
  readonly expect: OutcomeExpectations
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
  readonly expect: OutcomeExpectations
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
  /** Where captured logs and/or non-passing response evidence were stored before cleanup. */
  readonly diagnosticsPath: string | null
  readonly cleanupError: string | null
}

export interface EvalRunReport {
  readonly scenarioId: string
  readonly model: string
  readonly openCodeVersion: string
  readonly pluginVersions: readonly string[]
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
