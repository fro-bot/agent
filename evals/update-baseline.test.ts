import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as prettier from 'prettier'
import {describe, expect, it} from 'vitest'
import {createLogger} from '../src/shared/logger.js'
import {buildDeterministicScenarioProvenance} from './runner.js'
import {ALL_SCENARIOS} from './scenarios/index.js'
import {buildBaselineFromReport, updateBaselineFromReportPath} from './update-baseline.js'

interface SyntheticScenario {
  readonly scenarioId: string
  readonly execution: {
    readonly timeoutMs: number
    readonly diagnosticsPath: string | null
    readonly [key: string]: unknown
  }
  readonly [key: string]: unknown
}

interface SyntheticReport {
  readonly reports: readonly SyntheticScenario[]
  readonly [key: string]: unknown
}

const provenanceLogger = createLogger({component: 'eval-baseline-test'})
const deterministicProvenance = new Map(
  ALL_SCENARIOS.map(
    scenario => [scenario.id, buildDeterministicScenarioProvenance(scenario, provenanceLogger)] as const,
  ),
)

function createReport(overrides: Partial<SyntheticReport> = {}): SyntheticReport {
  const reports: SyntheticScenario[] = ALL_SCENARIOS.map(scenario => ({
    scenarioId: scenario.id,
    model: 'anthropic/claude-sonnet-5',
    openCodeVersion: '1.18.14+harness.202732ae',
    pluginVersions: ['@cortexkit/opencode-anthropic-auth@1.18.0'],
    ...deterministicProvenance.get(scenario.id),
    state: 'passed',
    durationMs: 12_345,
    cost: 9,
    execution: {
      timeoutMs: 600_000,
      durationMs: 12_000,
      diagnosticsPath: null,
    },
    agentResult: {
      tokenUsage: {input: 1, output: 2, reasoning: 0, cache: {read: 3, write: 4}},
      error: 'raw provider error',
    },
    output: 'raw response body with auth sk-secret-value',
    canary: 'raw canary',
    gates: [
      {id: 'response-file-parses', status: 'passed'},
      {id: 'verdict-matches', status: 'passed'},
    ],
  }))

  return {
    runId: 'raw-run-id',
    corpusHeadSha: '2e58f3bd662b0102d853ffae7d2f0bcf0bf4be71',
    scenarioIds: ALL_SCENARIOS.map(scenario => scenario.id),
    startedAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:01:00.000Z',
    completed: true,
    completionMarker: 'fro-bot-eval-report-complete-v1',
    suiteVerdict: {status: 'passed', reason: 'raw reason'},
    reports,
    ...overrides,
  }
}

describe('buildBaselineFromReport', {timeout: 60_000}, () => {
  it('rejects a report with missing pluginVersions provenance', () => {
    // #given a report whose first scenario omits plugin provenance entirely
    const reports = createReport().reports.map((report, index) => {
      if (index !== 0) {
        return report
      }
      const reportWithoutPlugins = {...report}
      Reflect.deleteProperty(reportWithoutPlugins, 'pluginVersions')
      return reportWithoutPlugins
    })

    // #when strict baseline promotion validates the report
    // #then missing plugin provenance is rejected rather than inferred from the model
    expect(() => buildBaselineFromReport(createReport({reports}))).toThrow()
  })

  it.each([
    ['model', {model: 'different/model'}],
    ['OpenCode version', {openCodeVersion: 'different-harness'}],
    ['plugin versions', {pluginVersions: ['different-plugin@1.0.0']}],
    [
      'timeout',
      {
        execution: {
          ...createReport().reports[0]?.execution,
          timeoutMs: 300_000,
          diagnosticsPath: createReport().reports[0]?.execution.diagnosticsPath ?? null,
        },
      },
    ],
    ['prompt hash', {promptHash: 'stale-prompt-hash'}],
    ['fixture SHA', {scenarioCommitSha: 'stale-fixture-sha'}],
  ] as const)('rejects a per-scenario %s mismatch', (_label, change) => {
    // #given a valid deterministic report with one stale scenario field
    const reports = createReport().reports.map((report, index) => (index === 0 ? {...report, ...change} : report))

    // #when strict baseline promotion validates provenance and runtime consistency
    // #then the stale report is rejected rather than silently rewritten
    expect(() => buildBaselineFromReport(createReport({reports}))).toThrow()
  })

  it.each([0, -1, 1.5])('rejects a configured timeout of %s', timeoutMs => {
    // #given a report with a non-positive or non-integral timeout
    const reports = createReport().reports.map((report, index) =>
      index === 0 ? {...report, execution: {...report.execution, timeoutMs}} : report,
    )

    // #when strict baseline promotion validates the timeout
    // #then promotion fails closed
    expect(() => buildBaselineFromReport(createReport({reports}))).toThrow()
  })

  it.each([
    ['incomplete report', {completed: false}],
    ['wrong completion marker', {completionMarker: 'wrong-marker'}],
    ['failed suite verdict', {suiteVerdict: {status: 'failed'}}],
    ['scenario order mismatch', {scenarioIds: [...ALL_SCENARIOS].reverse().map(scenario => scenario.id)}],
    [
      'diagnostic-bearing report',
      {
        reports: createReport().reports.map((report, index) =>
          index === 0 ? {...report, execution: {...report.execution, diagnosticsPath: '/tmp/diagnostics'}} : report,
        ),
      },
    ],
    [
      'failed scenario',
      {
        reports: createReport().reports?.map((report, index) => (index === 0 ? {...report, state: 'failed'} : report)),
      },
    ],
    [
      'failed gate',
      {
        reports: createReport().reports?.map((report, index) =>
          index === 0 ? {...report, gates: [{id: 'response-file-parses', status: 'failed'}]} : report,
        ),
      },
    ],
  ] as const)('rejects %s', (_label, override) => {
    // #given a report that violates one promotion precondition
    // #when baseline promotion validation runs
    expect(() => buildBaselineFromReport(createReport(override))).toThrow()
  })

  it('returns only the sanitized allowlisted baseline fields', () => {
    // #given a completed all-pass report containing sensitive and advisory raw fields
    const baseline = buildBaselineFromReport(createReport())
    const serialized = JSON.stringify(baseline)

    // #then raw outputs, diagnostics, auth, paths, canaries, and run metadata are omitted
    expect(serialized).not.toContain('raw response')
    expect(serialized).not.toContain('diagnostics')
    expect(serialized).not.toContain('raw-run-id')
    expect(serialized).not.toContain('/Users/')
    expect(serialized).not.toContain('sk-secret-value')
    expect(serialized).not.toContain('durationMs')
    expect(serialized).not.toContain('cost')
    expect(serialized).not.toContain('startedAt')
    expect(serialized).not.toContain('updatedAt')
    expect(serialized).not.toContain('canary')
    expect(serialized).not.toContain('error')
    expect(serialized).not.toContain('runId')
    expect(baseline.scenarios).toHaveLength(ALL_SCENARIOS.length)
    expect(baseline.scenarios.every(scenario => scenario.state === 'passed')).toBe(true)
    expect(baseline.scenarios.every(scenario => scenario.passedGateIds.length === 2)).toBe(true)
  }, 30_000)

  it('writes a sanitized, Prettier-clean baseline artifact', async () => {
    // #given a valid completed report and temporary input/output paths
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'fro-bot-baseline-update-'))
    const reportPath = path.join(tempDir, 'report.json')
    const outputPath = path.join(tempDir, 'baseline.json')
    const report = createReport()
    writeFileSync(reportPath, JSON.stringify(report), 'utf8')

    try {
      // #when the baseline updater writes the sanitized artifact
      const update = updateBaselineFromReportPath(reportPath, outputPath)

      // #then the updater is asynchronous and emits the expected sanitized data in repo format
      expect(update).toBeInstanceOf(Promise)
      await update
      const raw = readFileSync(outputPath, 'utf8')
      const baseline = JSON.parse(raw) as unknown
      const expectedBaseline = buildBaselineFromReport(report)

      expect(baseline).toEqual(expectedBaseline)
      expect(raw).toBe(await prettier.format(raw, {filepath: outputPath, parser: 'json'}))
      expect(raw).not.toContain('raw response')
      expect(raw).not.toContain('sk-secret-value')
    } finally {
      rmSync(tempDir, {recursive: true, force: true})
    }
  }, 30_000)
})
