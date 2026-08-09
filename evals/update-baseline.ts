import type {Logger} from '../src/shared/logger.js'
import type {Scenario} from './types.js'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
// eslint-disable-next-line import-x/no-extraneous-dependencies -- evals are dev-only tooling
import * as prettier from 'prettier'
import {createLogger} from '../src/shared/logger.js'
import {buildDeterministicScenarioProvenance} from './runner.js'
import {ALL_SCENARIOS} from './scenarios/index.js'

const COMPLETION_MARKER = 'fro-bot-eval-report-complete-v1'
const BASELINE_PATH = path.join(process.cwd(), 'evals', 'baselines', 'u1.json')

export interface BaselineScenario {
  readonly id: string
  readonly promptHash: string
  readonly scenarioCommitSha: string
  readonly state: 'passed'
  readonly passedGateIds: readonly string[]
}

export interface BaselineArtifact {
  readonly schemaVersion: 1
  readonly sourceRun: {
    readonly corpusHeadSha: string
    readonly completionMarker: string
    readonly suiteVerdict: 'passed'
  }
  readonly runtime: {
    readonly model: string
    readonly openCodeVersion: string
    readonly pluginVersions: readonly string[]
    readonly configuredTimeoutMs: number
  }
  readonly scenarios: readonly BaselineScenario[]
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`)
  }
  return value
}

function requiredReports(record: Record<string, unknown>): readonly Record<string, unknown>[] {
  const reports = record.reports
  if (Array.isArray(reports) === false) {
    throw new TypeError('reports must be an array')
  }
  return reports.map((report, index) => asRecord(report, `reports[${index}]`))
}

function requiredPluginVersions(report: Record<string, unknown>): readonly string[] {
  const configured = report.pluginVersions
  if (configured === undefined) {
    throw new Error('reports[*].pluginVersions is required for strict baseline promotion')
  }
  if (Array.isArray(configured) === false) {
    throw new TypeError('reports[*].pluginVersions must be an array of strings')
  }
  const versions: string[] = []
  for (const version of configured) {
    if (typeof version !== 'string') {
      throw new TypeError('reports[*].pluginVersions must be an array of strings')
    }
    versions.push(version)
  }
  return versions
}

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function requiredPositiveIntegerTimeout(value: unknown, label: string): number {
  if (typeof value !== 'number' || Number.isInteger(value) === false || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`)
  }
  return value
}

function requiredPassedGateIds(report: Record<string, unknown>, index: number): readonly string[] {
  const gates = report.gates
  if (Array.isArray(gates) === false || gates.length === 0) {
    throw new Error(`reports[${index}].gates must contain at least one gate`)
  }

  const passedGateIds: string[] = []
  for (const [gateIndex, gateValue] of gates.entries()) {
    const gate = asRecord(gateValue, `reports[${index}].gates[${gateIndex}]`)
    const id = requiredString(gate, 'id', `reports[${index}].gates[${gateIndex}]`)
    if (gate.status !== 'passed') {
      throw new Error(`reports[${index}].gates[${gateIndex}] must be passed`)
    }
    passedGateIds.push(id)
  }
  return passedGateIds
}

function buildScenarioProvenance(
  scenario: Scenario,
  provenance: ReturnType<typeof buildDeterministicScenarioProvenance>,
): Omit<BaselineScenario, 'passedGateIds'> {
  return {
    id: scenario.id,
    promptHash: provenance.promptHash,
    scenarioCommitSha: provenance.scenarioCommitSha,
    state: 'passed',
  }
}

export function buildBaselineFromReport(
  source: unknown,
  logger: Logger = createLogger({component: 'eval-baseline'}),
): BaselineArtifact {
  const root = asRecord(source, 'report')
  if (root.completed !== true) {
    throw new Error('Report must be completed')
  }
  if (root.completionMarker !== COMPLETION_MARKER) {
    throw new Error(`Report completion marker must be ${COMPLETION_MARKER}`)
  }

  const suiteVerdict = asRecord(root.suiteVerdict, 'suiteVerdict')
  if (suiteVerdict.status !== 'passed') {
    throw new Error('Report suite verdict must be passed')
  }

  const expectedScenarioIds = ALL_SCENARIOS.map(scenario => scenario.id)
  const scenarioIds = root.scenarioIds
  if (
    Array.isArray(scenarioIds) === false ||
    scenarioIds.length !== expectedScenarioIds.length ||
    scenarioIds.some((id, index) => id !== expectedScenarioIds[index])
  ) {
    throw new Error('Report scenario IDs must exactly match the enabled registry order')
  }

  const reports = requiredReports(root)
  if (reports.length !== ALL_SCENARIOS.length) {
    throw new Error('Report must contain one report for every enabled scenario')
  }

  const firstReport = reports[0]
  if (firstReport == null) {
    throw new Error('Report must contain at least one scenario report')
  }
  const model = requiredString(firstReport, 'model', 'reports[0]')
  const openCodeVersion = requiredString(firstReport, 'openCodeVersion', 'reports[0]')
  const firstExecution = asRecord(firstReport.execution, 'reports[0].execution')
  const configuredTimeoutMs = requiredPositiveIntegerTimeout(firstExecution.timeoutMs, 'reports[0].execution.timeoutMs')
  const pluginVersions = requiredPluginVersions(firstReport)

  const scenarios: BaselineScenario[] = []
  for (const [index, report] of reports.entries()) {
    if (report.scenarioId !== expectedScenarioIds[index]) {
      throw new Error(`reports[${index}].scenarioId must match the enabled registry order`)
    }
    const reportModel = requiredString(report, 'model', `reports[${index}]`)
    const reportOpenCodeVersion = requiredString(report, 'openCodeVersion', `reports[${index}]`)
    const execution = asRecord(report.execution, `reports[${index}].execution`)
    const timeoutMs = requiredPositiveIntegerTimeout(execution.timeoutMs, `reports[${index}].execution.timeoutMs`)
    const reportPlugins = requiredPluginVersions(report)
    if (
      reportModel !== model ||
      reportOpenCodeVersion !== openCodeVersion ||
      timeoutMs !== configuredTimeoutMs ||
      equalStringArrays(reportPlugins, pluginVersions) === false
    ) {
      throw new Error(`Runtime values must be common across reports; mismatch at index ${index}`)
    }
    if (execution.diagnosticsPath != null) {
      throw new Error(`reports[${index}] contains diagnostics and cannot be promoted`)
    }
    if (report.state !== 'passed') {
      throw new Error(`reports[${index}] must be passed`)
    }

    const passedGateIds = requiredPassedGateIds(report, index)
    const scenario = ALL_SCENARIOS[index]
    if (scenario == null) {
      throw new Error(`Missing registry scenario at index ${index}`)
    }
    const sourcePromptHash = requiredString(report, 'promptHash', `reports[${index}]`)
    const sourceScenarioCommitSha = requiredString(report, 'scenarioCommitSha', `reports[${index}]`)
    const provenance = buildDeterministicScenarioProvenance(scenario, logger)
    if (sourcePromptHash !== provenance.promptHash) {
      throw new Error(`reports[${index}].promptHash does not match deterministic scenario provenance`)
    }
    if (sourceScenarioCommitSha !== provenance.scenarioCommitSha) {
      throw new Error(`reports[${index}].scenarioCommitSha does not match deterministic scenario provenance`)
    }
    scenarios.push({...buildScenarioProvenance(scenario, provenance), passedGateIds})
  }

  return {
    schemaVersion: 1,
    sourceRun: {
      corpusHeadSha: requiredString(root, 'corpusHeadSha', 'report'),
      completionMarker: COMPLETION_MARKER,
      suiteVerdict: 'passed',
    },
    runtime: {
      model,
      openCodeVersion,
      pluginVersions,
      configuredTimeoutMs,
    },
    scenarios,
  }
}

export async function updateBaselineFromReportPath(reportPath: string, outputPath = BASELINE_PATH): Promise<void> {
  const source = JSON.parse(readFileSync(reportPath, 'utf8')) as unknown
  const baseline = buildBaselineFromReport(source)
  const config = await prettier.resolveConfig(BASELINE_PATH)
  const formatted = await prettier.format(JSON.stringify(baseline), {
    ...(config ?? {}),
    filepath: outputPath,
    parser: 'json',
  })
  mkdirSync(path.dirname(outputPath), {recursive: true})
  writeFileSync(outputPath, formatted, 'utf8')
}

async function runCommand(): Promise<void> {
  const reportPath = process.argv[2]
  if (reportPath == null || reportPath.trim().length === 0) {
    throw new Error('Usage: bun run evals:baseline:update -- <completed-report.json>')
  }
  await updateBaselineFromReportPath(reportPath)
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCommand().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
