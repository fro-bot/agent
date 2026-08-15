import type {EvalRunReport, StableGateProjection, StableOutcomeProjection} from './types.js'
import type {BaselineArtifact} from './update-baseline.js'
import {evaluateCorpusReports} from './corpus-verdict.js'
import {isDecisiveGateFailure, isStochasticQualityGateFailure} from './gates.js'
import {ALL_SCENARIOS, MAX_SCENARIOS} from './scenarios/index.js'

export const MAX_COMPARISON_SAMPLES = 4

const CORPUS_LIMITATIONS = [
  'The comparison covers only the six registered scenarios and never expands the corpus automatically.',
  'A clean result means no large observed regression on the covered slice; it does not prove improvement or production-surface quality.',
  'Quality ignores raw prose, prompt hashes, runtime/plugin versions, duration, cost, token counts, tool calls, call counts, and reasoning order.',
] as const

export type ComparisonStatus = 'passed' | 'failed' | 'inconclusive'
export type ComparisonScenarioStatus = 'passed' | 'failed' | 'inconclusive' | 'missing-evidence'

export interface AdvisoryDifference {
  readonly scenarioId: string
  readonly field: string
  readonly candidate: unknown
  readonly baseline: unknown
}

export interface ComparisonSamples {
  readonly candidate: readonly StableOutcomeProjection[]
  readonly baseline: readonly StableOutcomeProjection[]
}

export interface ComparisonInput {
  readonly candidateReports: readonly EvalRunReport[]
  readonly reviewedBaseline: BaselineArtifact
  /**
   * Optional independently validated completed reports for a legacy baseline
   * artifact that predates the stable outcome projection.
   */
  readonly reviewedBaselineReports?: readonly EvalRunReport[]
  /** Additional samples exclude the initial candidate and baseline observations. */
  readonly samples?: Readonly<Record<string, ComparisonSamples>>
}

export interface RepeatRequest {
  readonly scenarioId: string
  readonly candidateSamples: number
  readonly baselineSamples: number
  readonly candidateRemaining: number
  readonly baselineRemaining: number
  readonly maxSamplesPerSide: number
}

export interface ScenarioComparison {
  readonly scenarioId: string
  readonly status: ComparisonScenarioStatus
  readonly candidate: StableOutcomeProjection | null
  readonly baseline: StableOutcomeProjection | null
  readonly stableDifferences: readonly string[]
  readonly advisoryDifferences: readonly AdvisoryDifference[]
  readonly decisiveGateIds: readonly string[]
  readonly stochasticQualityGateIds: readonly string[]
  readonly reason: string
}

export interface ComparisonReport {
  readonly status: ComparisonStatus
  readonly statement: string
  readonly reason: string
  readonly scenarios: readonly ScenarioComparison[]
  readonly advisoryDifferences: readonly AdvisoryDifference[]
  readonly repeatRequests: readonly RepeatRequest[]
  readonly rerunScenarioIds: readonly string[]
  readonly missingEvidence: readonly string[]
  readonly limitations: readonly string[]
}

type SampleClassification = 'passed' | 'decisive-failed' | 'quality-failed' | 'inconclusive'

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function idsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function gateMap(gates: readonly StableGateProjection[]): ReadonlyMap<string, StableGateProjection> {
  return new Map(gates.map(gate => [gate.id, gate] as const))
}

function stableDifferences(candidate: StableOutcomeProjection, baseline: StableOutcomeProjection): readonly string[] {
  const differences: string[] = []
  if (candidate.state !== baseline.state) {
    differences.push(`state: candidate=${candidate.state}, baseline=${baseline.state}`)
  }
  if (candidate.verdict !== baseline.verdict) {
    differences.push(`verdict: candidate=${candidate.verdict ?? 'null'}, baseline=${baseline.verdict ?? 'null'}`)
  }

  const candidateGates = gateMap(candidate.gates)
  const baselineGates = gateMap(baseline.gates)
  const gateIds = [...new Set([...candidateGates.keys(), ...baselineGates.keys()])].sort()
  for (const id of gateIds) {
    const candidateGate = candidateGates.get(id)
    const baselineGate = baselineGates.get(id)
    if (candidateGate == null || baselineGate == null) {
      differences.push(`gate ${id}: present only in ${candidateGate == null ? 'baseline' : 'candidate'}`)
      continue
    }
    if (candidateGate.kind !== baselineGate.kind) {
      differences.push(`gate ${id} kind: candidate=${candidateGate.kind}, baseline=${baselineGate.kind}`)
    }
    if (candidateGate.status !== baselineGate.status) {
      differences.push(`gate ${id} status: candidate=${candidateGate.status}, baseline=${baselineGate.status}`)
    }
  }

  return differences
}

function reportOutcome(report: EvalRunReport): StableOutcomeProjection | null {
  if (report.outcome == null) {
    return null
  }
  if (report.outcome.scenarioId !== report.scenarioId || report.outcome.state !== report.state) {
    return null
  }
  const reportGates = report.gates.map(({id, kind, status}) => ({id, kind, status}))
  if (valuesEqual(report.outcome.gates, reportGates) === false) {
    return null
  }
  return report.outcome
}

function isReviewedBaselineOutcome(scenarioId: string, outcome: StableOutcomeProjection): boolean {
  return (
    outcome.scenarioId === scenarioId &&
    outcome.state === 'passed' &&
    outcome.gates.every(gate => gate.status === 'passed')
  )
}

function classifySample(outcome: StableOutcomeProjection): SampleClassification {
  const decisiveGateIds = outcome.gates.filter(isDecisiveGateFailure).map(gate => gate.id)
  if (decisiveGateIds.length > 0) {
    return 'decisive-failed'
  }
  if (outcome.state === 'inconclusive') {
    return 'inconclusive'
  }
  if (outcome.gates.some(isStochasticQualityGateFailure)) {
    return 'quality-failed'
  }
  if (outcome.state === 'failed') {
    // Fail closed: an unclassifiable failure is decisive rather than sampled.
    // Retrying it could launder a real defect into a flake.
    return 'decisive-failed'
  }
  return 'passed'
}

function advisoryDifference(
  scenarioId: string,
  field: string,
  candidate: unknown,
  baseline: unknown,
): AdvisoryDifference | null {
  return valuesEqual(candidate, baseline) ? null : {scenarioId, field, candidate, baseline}
}

function buildAdvisoryDifferences(
  candidate: EvalRunReport,
  baseline: EvalRunReport | null,
  baselineScenario: BaselineArtifact['scenarios'][number],
  baselineRuntime: BaselineArtifact['runtime'],
): readonly AdvisoryDifference[] {
  const differences: AdvisoryDifference[] = []
  const compare = (field: string, candidateValue: unknown, baselineValue: unknown): void => {
    const difference = advisoryDifference(candidate.scenarioId, field, candidateValue, baselineValue)
    if (difference != null) {
      differences.push(difference)
    }
  }

  compare('model', candidate.model, baselineRuntime.model)
  compare('openCodeVersion', candidate.openCodeVersion, baselineRuntime.openCodeVersion)
  compare('pluginVersions', candidate.pluginVersions, baselineRuntime.pluginVersions)
  compare('promptHash', candidate.promptHash, baselineScenario.promptHash)
  compare('scenarioCommitSha', candidate.scenarioCommitSha, baselineScenario.scenarioCommitSha)

  if (baseline != null) {
    compare('durationMs', candidate.durationMs, baseline.durationMs)
    compare('cost', candidate.cost, baseline.cost)
    compare('tokenUsage', candidate.agentResult.tokenUsage, baseline.agentResult.tokenUsage)
  }

  return differences
}

function invalidReport(reason: string): ComparisonReport {
  return {
    status: 'failed',
    statement: 'Comparison blocked',
    reason,
    scenarios: [],
    advisoryDifferences: [],
    repeatRequests: [],
    rerunScenarioIds: [],
    missingEvidence: [],
    limitations: CORPUS_LIMITATIONS,
  }
}

function scenarioRegistryError(candidateReports: readonly EvalRunReport[], baseline: BaselineArtifact): string | null {
  const registryIds = ALL_SCENARIOS.map(scenario => scenario.id)
  if (ALL_SCENARIOS.length > MAX_SCENARIOS) {
    return `The scenario registry exceeds the ${MAX_SCENARIOS}-scenario capacity`
  }
  if (
    idsEqual(
      candidateReports.map(report => report.scenarioId),
      registryIds,
    ) === false
  ) {
    return 'Candidate scenario IDs must exactly match the enabled scenario registry in order'
  }
  if (
    idsEqual(
      baseline.scenarios.map(scenario => scenario.id),
      registryIds,
    ) === false
  ) {
    return 'Reviewed baseline scenario IDs must exactly match the enabled scenario registry in order'
  }
  return null
}

function validatedBaselineReports(
  reports: readonly EvalRunReport[] | undefined,
  registryIds: readonly string[],
): {readonly reports: ReadonlyMap<string, EvalRunReport>; readonly error: string | null} {
  if (reports == null) {
    return {reports: new Map(), error: null}
  }
  if (
    idsEqual(
      reports.map(report => report.scenarioId),
      registryIds,
    ) === false
  ) {
    return {
      reports: new Map(),
      error: 'Reviewed baseline reports must exactly match the enabled scenario registry in order',
    }
  }
  for (const report of reports) {
    if (report.state !== 'passed' || report.execution.completed !== true || report.execution.diagnosticsPath != null) {
      return {
        reports: new Map(),
        error: `Reviewed baseline report ${report.scenarioId} is not a completed validated pass`,
      }
    }
    const outcome = reportOutcome(report)
    if (outcome == null || isReviewedBaselineOutcome(report.scenarioId, outcome) === false) {
      return {
        reports: new Map(),
        error: `Reviewed baseline report ${report.scenarioId} is missing a valid stable outcome`,
      }
    }
  }
  return {reports: new Map(reports.map(report => [report.scenarioId, report] as const)), error: null}
}

function completeSamples(
  scenarioId: string,
  candidate: StableOutcomeProjection,
  baseline: StableOutcomeProjection,
  samples: ComparisonSamples | undefined,
): {
  readonly candidate: readonly StableOutcomeProjection[]
  readonly baseline: readonly StableOutcomeProjection[]
  readonly error: string | null
} {
  const candidateSamples = [candidate, ...(samples?.candidate ?? [])]
  const baselineSamples = [baseline, ...(samples?.baseline ?? [])]
  if (
    candidateSamples.some(sample => sample.scenarioId !== scenarioId) ||
    baselineSamples.some(sample => sample.scenarioId !== scenarioId)
  ) {
    return {
      candidate: candidateSamples,
      baseline: baselineSamples,
      error: `Scenario ${scenarioId} contains a sample for a different scenario`,
    }
  }
  if (candidateSamples.length > MAX_COMPARISON_SAMPLES || baselineSamples.length > MAX_COMPARISON_SAMPLES) {
    return {
      candidate: candidateSamples,
      baseline: baselineSamples,
      error: `Scenario ${scenarioId} exceeds the ${MAX_COMPARISON_SAMPLES}-vs-${MAX_COMPARISON_SAMPLES} comparison budget`,
    }
  }
  return {candidate: candidateSamples, baseline: baselineSamples, error: null}
}

function repeatRequest(scenarioId: string, candidateSamples: number, baselineSamples: number): RepeatRequest {
  return {
    scenarioId,
    candidateSamples,
    baselineSamples,
    candidateRemaining: MAX_COMPARISON_SAMPLES - candidateSamples,
    baselineRemaining: MAX_COMPARISON_SAMPLES - baselineSamples,
    maxSamplesPerSide: MAX_COMPARISON_SAMPLES,
  }
}

function scenarioComparison(
  candidateReport: EvalRunReport,
  candidate: StableOutcomeProjection,
  baseline: StableOutcomeProjection,
  baselineReport: EvalRunReport | null,
  baselineScenario: BaselineArtifact['scenarios'][number],
  baselineRuntime: BaselineArtifact['runtime'],
  samples: ComparisonSamples | undefined,
): {
  readonly result: ScenarioComparison
  readonly repeatRequest: RepeatRequest | null
  readonly rerun: boolean
} {
  const advisoryDifferences = buildAdvisoryDifferences(
    candidateReport,
    baselineReport,
    baselineScenario,
    baselineRuntime,
  )
  const stableDifferenceList = stableDifferences(candidate, baseline)
  const decisiveGateIds = candidate.gates.filter(isDecisiveGateFailure).map(gate => gate.id)
  const stochasticQualityGateIds = candidate.gates.filter(isStochasticQualityGateFailure).map(gate => gate.id)

  if (decisiveGateIds.length > 0) {
    return {
      result: {
        scenarioId: candidateReport.scenarioId,
        status: 'failed',
        candidate,
        baseline,
        stableDifferences: stableDifferenceList,
        advisoryDifferences,
        decisiveGateIds,
        stochasticQualityGateIds,
        reason: `Decisive safety or response-contract gates failed: ${decisiveGateIds.join(', ')}`,
      },
      repeatRequest: null,
      rerun: false,
    }
  }

  if (candidate.state === 'inconclusive') {
    return {
      result: {
        scenarioId: candidateReport.scenarioId,
        status: 'inconclusive',
        candidate,
        baseline,
        stableDifferences: stableDifferenceList,
        advisoryDifferences,
        decisiveGateIds,
        stochasticQualityGateIds,
        reason: 'Candidate infrastructure outcome is inconclusive and must be rerun',
      },
      repeatRequest: null,
      rerun: true,
    }
  }

  if (candidate.state === 'failed' && stochasticQualityGateIds.length === 0) {
    return {
      result: {
        scenarioId: candidateReport.scenarioId,
        status: 'failed',
        candidate,
        baseline,
        stableDifferences: stableDifferenceList,
        advisoryDifferences,
        decisiveGateIds,
        stochasticQualityGateIds,
        reason: 'Candidate report failed without a retryable stochastic quality gate',
      },
      repeatRequest: null,
      rerun: false,
    }
  }

  if (candidate.state === 'passed' && stableDifferenceList.length > 0) {
    return {
      result: {
        scenarioId: candidateReport.scenarioId,
        status: 'failed',
        candidate,
        baseline,
        stableDifferences: stableDifferenceList,
        advisoryDifferences,
        decisiveGateIds,
        stochasticQualityGateIds,
        reason: 'Stable outcome projection differs from the reviewed baseline',
      },
      repeatRequest: null,
      rerun: false,
    }
  }

  const completed = completeSamples(candidateReport.scenarioId, candidate, baseline, samples)
  if (completed.error != null) {
    return {
      result: {
        scenarioId: candidateReport.scenarioId,
        status: 'failed',
        candidate,
        baseline,
        stableDifferences: stableDifferenceList,
        advisoryDifferences,
        decisiveGateIds,
        stochasticQualityGateIds,
        reason: completed.error,
      },
      repeatRequest: null,
      rerun: false,
    }
  }

  const baselineClasses = completed.baseline.map(classifySample)
  const candidateClasses = completed.candidate.map(classifySample)
  if (candidateClasses.includes('decisive-failed')) {
    return {
      result: {
        scenarioId: candidateReport.scenarioId,
        status: 'failed',
        candidate,
        baseline,
        stableDifferences: stableDifferenceList,
        advisoryDifferences,
        decisiveGateIds,
        stochasticQualityGateIds,
        reason: 'A bounded candidate sample produced a decisive safety or response-contract failure',
      },
      repeatRequest: null,
      rerun: false,
    }
  }
  if (candidateClasses.includes('inconclusive')) {
    return {
      result: {
        scenarioId: candidateReport.scenarioId,
        status: 'inconclusive',
        candidate,
        baseline,
        stableDifferences: stableDifferenceList,
        advisoryDifferences,
        decisiveGateIds,
        stochasticQualityGateIds,
        reason: 'A bounded candidate sample was inconclusive and requires rerun',
      },
      repeatRequest: null,
      rerun: true,
    }
  }
  if (baselineClasses.some(classification => classification !== 'passed')) {
    return {
      result: {
        scenarioId: candidateReport.scenarioId,
        status: 'inconclusive',
        candidate,
        baseline,
        stableDifferences: stableDifferenceList,
        advisoryDifferences,
        decisiveGateIds,
        stochasticQualityGateIds,
        reason: 'Reviewed baseline samples did not provide a stable passed comparison',
      },
      repeatRequest: null,
      rerun: true,
    }
  }

  const qualityFailures = candidateClasses.filter(classification => classification === 'quality-failed').length
  if (qualityFailures === 0) {
    return {
      result: {
        scenarioId: candidateReport.scenarioId,
        status: 'passed',
        candidate,
        baseline,
        stableDifferences: stableDifferenceList,
        advisoryDifferences,
        decisiveGateIds,
        stochasticQualityGateIds,
        reason: 'Stable outcome projection passed after bounded comparison',
      },
      repeatRequest: null,
      rerun: false,
    }
  }

  if (completed.candidate.length < MAX_COMPARISON_SAMPLES || completed.baseline.length < MAX_COMPARISON_SAMPLES) {
    return {
      result: {
        scenarioId: candidateReport.scenarioId,
        status: 'inconclusive',
        candidate,
        baseline,
        stableDifferences: stableDifferenceList,
        advisoryDifferences,
        decisiveGateIds,
        stochasticQualityGateIds,
        reason: 'A stochastic quality gate failed; bounded candidate and baseline samples are required',
      },
      repeatRequest: repeatRequest(candidateReport.scenarioId, completed.candidate.length, completed.baseline.length),
      rerun: false,
    }
  }

  if (qualityFailures === MAX_COMPARISON_SAMPLES) {
    return {
      result: {
        scenarioId: candidateReport.scenarioId,
        status: 'failed',
        candidate,
        baseline,
        stableDifferences: stableDifferenceList,
        advisoryDifferences,
        decisiveGateIds,
        stochasticQualityGateIds,
        reason: 'Candidate lost the bounded stochastic quality comparison: bounded stochastic quality loss',
      },
      repeatRequest: null,
      rerun: false,
    }
  }

  return {
    result: {
      scenarioId: candidateReport.scenarioId,
      status: 'inconclusive',
      candidate,
      baseline,
      stableDifferences: stableDifferenceList,
      advisoryDifferences,
      decisiveGateIds,
      stochasticQualityGateIds,
      reason: 'Repeated samples were mixed; no causal improvement claim is supported',
    },
    repeatRequest: null,
    rerun: false,
  }
}

export function compareCandidateToBaseline(input: ComparisonInput): ComparisonReport {
  const registryError = scenarioRegistryError(input.candidateReports, input.reviewedBaseline)
  if (registryError != null) {
    return invalidReport(`Invalid scenario registry: ${registryError}`)
  }

  if (input.reviewedBaseline.sourceRun.suiteVerdict !== 'passed') {
    return invalidReport('Reviewed baseline suite verdict must be passed')
  }

  const registryIds = ALL_SCENARIOS.map(scenario => scenario.id)
  const baselineReports = validatedBaselineReports(input.reviewedBaselineReports, registryIds)
  if (baselineReports.error != null) {
    return invalidReport(baselineReports.error)
  }

  const candidateOutcomes = new Map<string, StableOutcomeProjection>()
  for (const report of input.candidateReports) {
    const outcome = reportOutcome(report)
    if (outcome == null) {
      return invalidReport(`Candidate report ${report.scenarioId} is missing a valid stable outcome projection`)
    }
    candidateOutcomes.set(report.scenarioId, outcome)
  }

  const baselineOutcomes = new Map<string, StableOutcomeProjection>()
  const missingEvidence: string[] = []
  for (const scenario of input.reviewedBaseline.scenarios) {
    const report = baselineReports.reports.get(scenario.id)
    const outcome = report == null ? scenario.outcome : reportOutcome(report)
    if (outcome == null || isReviewedBaselineOutcome(scenario.id, outcome) === false) {
      missingEvidence.push(scenario.id)
    } else {
      baselineOutcomes.set(scenario.id, outcome)
    }
  }

  if (missingEvidence.length > 0) {
    return {
      status: 'inconclusive',
      statement: 'Comparison stopped because missing reviewed baseline evidence cannot be compared',
      reason:
        'The reviewed baseline lacks observed structured outcomes for one or more scenarios; no candidate value was copied into the baseline projection',
      scenarios: missingEvidence.map(scenarioId => ({
        scenarioId,
        status: 'missing-evidence',
        candidate: candidateOutcomes.get(scenarioId) ?? null,
        baseline: null,
        stableDifferences: [],
        advisoryDifferences: [],
        decisiveGateIds: [],
        stochasticQualityGateIds: [],
        reason: 'Reviewed baseline stable outcome is missing',
      })),
      advisoryDifferences: [],
      repeatRequests: [],
      rerunScenarioIds: [],
      missingEvidence,
      limitations: CORPUS_LIMITATIONS,
    }
  }

  const scenarioResults: ScenarioComparison[] = []
  const repeatRequests: RepeatRequest[] = []
  const rerunScenarioIds: string[] = []
  const advisoryDifferences: AdvisoryDifference[] = []

  for (const scenario of ALL_SCENARIOS) {
    const candidateReport = input.candidateReports.find(report => report.scenarioId === scenario.id)
    const candidate = candidateOutcomes.get(scenario.id)
    const baseline = baselineOutcomes.get(scenario.id)
    const baselineScenario = input.reviewedBaseline.scenarios.find(item => item.id === scenario.id)
    if (candidateReport == null || candidate == null || baseline == null || baselineScenario == null) {
      return invalidReport(`Comparison could not resolve scenario ${scenario.id}`)
    }

    const compared = scenarioComparison(
      candidateReport,
      candidate,
      baseline,
      baselineReports.reports.get(scenario.id) ?? null,
      baselineScenario,
      input.reviewedBaseline.runtime,
      input.samples?.[scenario.id],
    )
    scenarioResults.push(compared.result)
    advisoryDifferences.push(...compared.result.advisoryDifferences)
    if (compared.repeatRequest != null) {
      repeatRequests.push(compared.repeatRequest)
    }
    if (compared.rerun) {
      rerunScenarioIds.push(scenario.id)
    }
  }

  const failedScenarios = scenarioResults.filter(result => result.status === 'failed')
  const inconclusiveScenarios = scenarioResults.filter(result => result.status === 'inconclusive')
  const corpusVerdict = evaluateCorpusReports(
    scenarioResults.map(result => ({
      state: result.status === 'failed' ? 'failed' : result.status === 'passed' ? 'passed' : 'inconclusive',
    })),
  )
  if (corpusVerdict.status === 'failed') {
    return {
      status: 'failed',
      statement: 'Comparison blocked by an observed candidate regression',
      reason: failedScenarios.map(result => `${result.scenarioId}: ${result.reason}`).join('; '),
      scenarios: scenarioResults,
      advisoryDifferences,
      repeatRequests,
      rerunScenarioIds,
      missingEvidence: [],
      limitations: CORPUS_LIMITATIONS,
    }
  }
  if (inconclusiveScenarios.length > 0) {
    return {
      status: 'inconclusive',
      statement:
        repeatRequests.length > 0
          ? 'Comparison requires bounded reruns for an affected stochastic quality scenario'
          : 'No causal improvement claim is supported; comparison is inconclusive',
      reason: inconclusiveScenarios.map(result => `${result.scenarioId}: ${result.reason}`).join('; '),
      scenarios: scenarioResults,
      advisoryDifferences,
      repeatRequests,
      rerunScenarioIds,
      missingEvidence: [],
      limitations: CORPUS_LIMITATIONS,
    }
  }

  return {
    status: 'passed',
    statement: 'No large observed regression across the six covered scenarios',
    reason: 'All six candidate stable outcome projections passed without a large observed regression',
    scenarios: scenarioResults,
    advisoryDifferences,
    repeatRequests: [],
    rerunScenarioIds: [],
    missingEvidence: [],
    limitations: CORPUS_LIMITATIONS,
  }
}
