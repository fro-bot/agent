import type {Logger} from '../src/shared/logger.js'
import type {
  EvalRunReport,
  Scenario,
  SessionPresearchStrategy,
  StableGateProjection,
  StableOutcomeProjection,
} from './types.js'
import type {BaselineArtifact, BaselineScenario} from './update-baseline.js'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {executeOpenCode} from '../src/features/agent/index.js'
import {createLogger} from '../src/shared/logger.js'
import {compareCandidateToBaseline, type ComparisonReport} from './compare.js'
import {runScenarioSequence} from './corpus-runner.js'
import {
  productionSessionPrepStrategy,
  runScenario,
  treatmentSessionPrepStrategy,
  type EvalExecution,
  type EvalSessionPrepStrategy,
} from './runner.js'
import {ALL_SCENARIOS, PRESEARCH_EXPERIMENT_SCENARIO_IDS} from './scenarios/index.js'

export {PRESEARCH_EXPERIMENT_SCENARIO_IDS}

const BASELINE_COMPLETION_MARKER = 'fro-bot-eval-report-complete-v1'
const REPORT_COMPLETION_MARKER = 'fro-bot-presearch-differential-report-complete-v1'
const REPORT_SCHEMA_VERSION = 1 as const
const EXPERIMENT_ID = 'bounded-session-presearch-v1' as const

export const DEFAULT_PRESEARCH_OUTPUT_PATH = path.join(
  process.cwd(),
  'evals',
  'output',
  'presearch-differential-report.json',
)
export const DEFAULT_REVIEWED_BASELINE_PATH = path.join(process.cwd(), 'evals', 'baselines', 'u1.json')

interface MutableComparisonSamples {
  readonly candidate: StableOutcomeProjection[]
  readonly baseline: StableOutcomeProjection[]
}

export interface DifferentialModeReport {
  readonly strategy: SessionPresearchStrategy
  readonly reports: readonly EvalRunReport[]
  readonly outcomes: readonly StableOutcomeProjection[]
}

export interface DifferentialExperimentReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION
  readonly experiment: typeof EXPERIMENT_ID
  readonly runId: string
  readonly corpusHeadSha: string
  readonly scenarioIds: readonly string[]
  readonly startedAt: string
  readonly updatedAt: string
  readonly completed: true
  readonly completionMarker: typeof REPORT_COMPLETION_MARKER
  readonly reviewedBaseline: {
    readonly artifactPath: string
    readonly sourceRun: BaselineArtifact['sourceRun']
    readonly scenarioIds: readonly string[]
  }
  readonly comparisonBasis: {
    readonly candidateMode: 'treatment'
    readonly liveBaselineMode: 'production'
  }
  readonly modes: {
    readonly production: DifferentialModeReport
    readonly treatment: DifferentialModeReport
  }
  readonly comparison: ComparisonReport
}

export interface DifferentialExperimentOptions {
  readonly execution?: EvalExecution
  readonly outputPath?: string
  readonly reviewedBaselinePath?: string
  readonly reviewedBaseline?: BaselineArtifact
  readonly runId?: string
  readonly now?: () => Date
}

export interface DifferentialExperimentSkippedResult {
  readonly status: 'skipped'
  readonly reason: 'FRO_BOT_EVAL=1 is required'
}

export interface DifferentialExperimentCompletedResult {
  readonly status: 'completed'
  readonly outputPath: string
  readonly report: DifferentialExperimentReport
}

export type DifferentialExperimentResult = DifferentialExperimentSkippedResult | DifferentialExperimentCompletedResult

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value) === false) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function requiredStringArray(value: unknown, label: string): readonly string[] {
  if (Array.isArray(value) === false) {
    throw new TypeError(`${label} must be an array of strings`)
  }
  const strings: string[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      throw new TypeError(`${label}[${index}] must be a string`)
    }
    strings.push(item)
  }
  return strings
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || Number.isInteger(value) === false || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value
}

function parseStableOutcome(value: unknown, expectedScenarioId: string, label: string): StableOutcomeProjection {
  const record = requiredRecord(value, label)
  const scenarioId = requiredString(record.scenarioId, `${label}.scenarioId`)
  if (scenarioId !== expectedScenarioId) {
    throw new Error(`${label}.scenarioId must match ${expectedScenarioId}`)
  }

  const state = record.state
  if (state !== 'passed' && state !== 'failed' && state !== 'inconclusive') {
    throw new Error(`${label}.state must be passed, failed, or inconclusive`)
  }

  const verdict = record.verdict
  if (verdict !== null && verdict !== 'approve' && verdict !== 'request-changes') {
    throw new Error(`${label}.verdict must be approve, request-changes, or null`)
  }

  if (Array.isArray(record.gates) === false || record.gates.length === 0) {
    throw new Error(`${label}.gates must contain at least one gate`)
  }
  const gates: StableGateProjection[] = record.gates.map((gateValue, index) => {
    const gate = requiredRecord(gateValue, `${label}.gates[${index}]`)
    const id = requiredString(gate.id, `${label}.gates[${index}].id`)
    const kind = gate.kind
    if (kind !== 'quality' && kind !== 'safety') {
      throw new Error(`${label}.gates[${index}].kind must be quality or safety`)
    }
    const status = gate.status
    if (status !== 'passed' && status !== 'failed' && status !== 'not-evaluated') {
      throw new Error(`${label}.gates[${index}].status is invalid`)
    }
    return {id, kind, status}
  })

  return {scenarioId, state, verdict, gates}
}

function parseBaselineScenario(value: unknown, index: number): BaselineScenario {
  const record = requiredRecord(value, `scenarios[${index}]`)
  const id = requiredString(record.id, `scenarios[${index}].id`)
  const promptHash = requiredString(record.promptHash, `scenarios[${index}].promptHash`)
  const scenarioCommitSha = requiredString(record.scenarioCommitSha, `scenarios[${index}].scenarioCommitSha`)
  if (record.state !== 'passed') {
    throw new Error(`scenarios[${index}].state must be passed`)
  }
  const passedGateIds = requiredStringArray(record.passedGateIds, `scenarios[${index}].passedGateIds`)
  const baseScenario: BaselineScenario = {id, promptHash, scenarioCommitSha, state: 'passed', passedGateIds}
  if (record.outcome === undefined) {
    return baseScenario
  }
  return {...baseScenario, outcome: parseStableOutcome(record.outcome, id, `scenarios[${index}].outcome`)}
}

export function readReviewedBaseline(baselinePath = DEFAULT_REVIEWED_BASELINE_PATH): BaselineArtifact {
  const parsed: unknown = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const root = requiredRecord(parsed, 'baseline')
  if (root.schemaVersion !== 1) {
    throw new Error('baseline.schemaVersion must be 1')
  }

  const sourceRun = requiredRecord(root.sourceRun, 'baseline.sourceRun')
  const sourceRunValue: BaselineArtifact['sourceRun'] = {
    corpusHeadSha: requiredString(sourceRun.corpusHeadSha, 'baseline.sourceRun.corpusHeadSha'),
    completionMarker: requiredString(sourceRun.completionMarker, 'baseline.sourceRun.completionMarker'),
    suiteVerdict: 'passed',
  }
  if (sourceRunValue.completionMarker !== BASELINE_COMPLETION_MARKER || sourceRun.suiteVerdict !== 'passed') {
    throw new Error('baseline.sourceRun must be a completed passed corpus report')
  }

  const runtime = requiredRecord(root.runtime, 'baseline.runtime')
  const runtimeValue: BaselineArtifact['runtime'] = {
    model: requiredString(runtime.model, 'baseline.runtime.model'),
    openCodeVersion: requiredString(runtime.openCodeVersion, 'baseline.runtime.openCodeVersion'),
    pluginVersions: requiredStringArray(runtime.pluginVersions, 'baseline.runtime.pluginVersions'),
    configuredTimeoutMs: requiredPositiveInteger(runtime.configuredTimeoutMs, 'baseline.runtime.configuredTimeoutMs'),
  }

  if (Array.isArray(root.scenarios) === false || root.scenarios.length === 0) {
    throw new Error('baseline.scenarios must contain at least one scenario')
  }

  return {
    schemaVersion: 1,
    sourceRun: sourceRunValue,
    runtime: runtimeValue,
    scenarios: root.scenarios.map(parseBaselineScenario),
  }
}

function resolveOutputPath(options: DifferentialExperimentOptions): string {
  if (options.outputPath != null && options.outputPath.trim().length > 0) {
    return options.outputPath
  }
  const configured = process.env.FRO_BOT_EVAL_OUTPUT
  if (configured != null && configured.trim().length > 0) {
    return configured.trim()
  }
  return DEFAULT_PRESEARCH_OUTPUT_PATH
}

function readCorpusHeadSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: process.cwd(), encoding: 'utf8'}).trim()
}

function resolvePresearchScenarios(): readonly Scenario[] {
  return PRESEARCH_EXPERIMENT_SCENARIO_IDS.map(scenarioId => {
    const scenario = ALL_SCENARIOS.find(candidate => candidate.id === scenarioId)
    if (scenario === undefined) {
      throw new Error(`Presearch experiment scenario ${scenarioId} is missing from the enabled registry`)
    }
    return scenario
  })
}

function findScenario(scenarios: readonly Scenario[], scenarioId: string): Scenario {
  const scenario = scenarios.find(candidate => candidate.id === scenarioId)
  if (scenario === undefined) {
    throw new Error(`Cannot repeat unknown presearch experiment scenario ${scenarioId}`)
  }
  return scenario
}

async function runMode(
  scenarios: readonly Scenario[],
  logger: Logger,
  execution: EvalExecution,
  strategy: EvalSessionPrepStrategy,
): Promise<EvalRunReport[]> {
  const reports: EvalRunReport[] = []
  await runScenarioSequence(
    scenarios,
    async scenario => runScenario(scenario, logger, execution, strategy),
    report => {
      reports.push(report)
    },
  )
  return reports
}

function getSamples(samples: Record<string, MutableComparisonSamples>, scenarioId: string): MutableComparisonSamples {
  const existing = samples[scenarioId]
  if (existing !== undefined) {
    return existing
  }
  const created: MutableComparisonSamples = {candidate: [], baseline: []}
  samples[scenarioId] = created
  return created
}

function compareModes(
  treatmentReports: readonly EvalRunReport[],
  productionReports: readonly EvalRunReport[],
  reviewedBaseline: BaselineArtifact,
  samples: Readonly<Record<string, MutableComparisonSamples>>,
): ComparisonReport {
  const sampleEntries = Object.keys(samples)
  return compareCandidateToBaseline({
    candidateReports: treatmentReports,
    reviewedBaseline,
    reviewedBaselineReports: productionReports,
    samples: sampleEntries.length === 0 ? undefined : samples,
    scenarioIds: PRESEARCH_EXPERIMENT_SCENARIO_IDS,
  })
}

async function driveBoundedRepeats(
  scenarios: readonly Scenario[],
  logger: Logger,
  execution: EvalExecution,
  reviewedBaseline: BaselineArtifact,
  treatmentInitialReports: readonly EvalRunReport[],
  productionInitialReports: readonly EvalRunReport[],
  treatmentReports: EvalRunReport[],
  productionReports: EvalRunReport[],
  samples: Record<string, MutableComparisonSamples>,
): Promise<ComparisonReport> {
  let comparison = compareModes(treatmentInitialReports, productionInitialReports, reviewedBaseline, samples)

  while (comparison.repeatRequests.length > 0) {
    const request = comparison.repeatRequests[0]
    if (request === undefined) {
      break
    }
    const scenario = findScenario(scenarios, request.scenarioId)
    const scenarioSamples = getSamples(samples, request.scenarioId)

    if (request.candidateRemaining > 0) {
      const report = await runScenario(scenario, logger, execution, treatmentSessionPrepStrategy)
      treatmentReports.push(report)
      scenarioSamples.candidate.push(report.outcome)
    } else if (request.baselineRemaining > 0) {
      const report = await runScenario(scenario, logger, execution, productionSessionPrepStrategy)
      productionReports.push(report)
      scenarioSamples.baseline.push(report.outcome)
    } else {
      throw new Error(`Comparison requested a repeat without remaining samples for ${request.scenarioId}`)
    }

    comparison = compareModes(treatmentInitialReports, productionInitialReports, reviewedBaseline, samples)
  }

  return comparison
}

function buildModeReport(
  strategy: SessionPresearchStrategy,
  reports: readonly EvalRunReport[],
): DifferentialModeReport {
  return {
    strategy,
    reports,
    outcomes: reports.map(report => report.outcome),
  }
}

function writeReportAtomically(outputPath: string, report: DifferentialExperimentReport): void {
  mkdirSync(path.dirname(outputPath), {recursive: true})
  const temporaryPath = `${outputPath}.${report.runId}.tmp`
  try {
    writeFileSync(temporaryPath, JSON.stringify(report, null, 2), 'utf8')
    renameSync(temporaryPath, outputPath)
  } finally {
    rmSync(temporaryPath, {force: true})
  }
}

export async function runPresearchDifferentialExperiment(
  logger: Logger,
  options: DifferentialExperimentOptions = {},
): Promise<DifferentialExperimentResult> {
  if (process.env.FRO_BOT_EVAL !== '1') {
    return {status: 'skipped', reason: 'FRO_BOT_EVAL=1 is required'}
  }

  const scenarios = resolvePresearchScenarios()
  const scenarioIds = scenarios.map(scenario => scenario.id)
  const baselinePath = path.resolve(options.reviewedBaselinePath ?? DEFAULT_REVIEWED_BASELINE_PATH)
  const reviewedBaseline = options.reviewedBaseline ?? readReviewedBaseline(baselinePath)
  const execution = options.execution ?? executeOpenCode
  const outputPath = resolveOutputPath(options)
  const runId = options.runId ?? randomUUID()
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const corpusHeadSha = readCorpusHeadSha()

  const productionInitialReports = await runMode(scenarios, logger, execution, productionSessionPrepStrategy)
  const treatmentInitialReports = await runMode(scenarios, logger, execution, treatmentSessionPrepStrategy)
  const productionReports = [...productionInitialReports]
  const treatmentReports = [...treatmentInitialReports]
  const samples: Record<string, MutableComparisonSamples> = {}
  const comparison = await driveBoundedRepeats(
    scenarios,
    logger,
    execution,
    reviewedBaseline,
    treatmentInitialReports,
    productionInitialReports,
    treatmentReports,
    productionReports,
    samples,
  )

  const report: DifferentialExperimentReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    experiment: EXPERIMENT_ID,
    runId,
    corpusHeadSha,
    scenarioIds,
    startedAt,
    updatedAt: now().toISOString(),
    completed: true,
    completionMarker: REPORT_COMPLETION_MARKER,
    reviewedBaseline: {
      artifactPath: baselinePath,
      sourceRun: reviewedBaseline.sourceRun,
      scenarioIds: reviewedBaseline.scenarios.map(scenario => scenario.id),
    },
    comparisonBasis: {
      candidateMode: 'treatment',
      liveBaselineMode: 'production',
    },
    modes: {
      production: buildModeReport('production-default', productionReports),
      treatment: buildModeReport('treatment', treatmentReports),
    },
    comparison,
  }
  writeReportAtomically(outputPath, report)

  return {status: 'completed', outputPath, report}
}

export async function runCommand(): Promise<void> {
  const logger = createLogger({component: 'eval-presearch-differential'})
  const result = await runPresearchDifferentialExperiment(logger)
  if (result.status === 'skipped') {
    process.stderr.write(`${result.reason}; differential experiment skipped\n`)
    return
  }

  process.stdout.write(`Wrote bounded presearch differential report to ${result.outputPath}\n`)
  if (result.report.comparison.status !== 'passed') {
    process.exitCode = 1
  }
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCommand().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
