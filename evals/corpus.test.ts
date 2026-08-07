import {mkdirSync, writeFileSync} from 'node:fs'
import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {createLogger} from '../src/shared/logger.js'
import {runScenario} from './runner.js'
import {cleanPrScenario} from './scenarios/clean-pr.js'
import {plantedDefectScenario} from './scenarios/planted-defect.js'

const EVAL_ENABLED = process.env.FRO_BOT_EVAL === '1'
const SCENARIOS = [cleanPrScenario, plantedDefectScenario] as const

/**
 * Scenarios run sequentially, so the suite ceiling must cover every scenario's own
 * execution budget plus server startup and teardown. A fixed ceiling below that sum
 * kills a run mid-investigation and reports it as a capability failure.
 */
const PER_SCENARIO_CEILING_MS = 360_000
const SUITE_TIMEOUT_MS = SCENARIOS.length * PER_SCENARIO_CEILING_MS

describe.skipIf(!EVAL_ENABLED)('agent outcome eval corpus', {timeout: SUITE_TIMEOUT_MS}, () => {
  it('runs exactly the two frozen U1 scenarios and writes their reports', async () => {
    // #given the two intentionally small frozen scenarios
    const logger = createLogger({component: 'eval-corpus'})
    const reports = []

    // #when each scenario is evaluated through executeOpenCode
    for (const scenario of SCENARIOS) {
      reports.push(await runScenario(scenario, logger))
    }

    const outputOverride = process.env.FRO_BOT_EVAL_OUTPUT
    const outputPath =
      outputOverride != null && outputOverride.trim().length > 0
        ? outputOverride
        : path.join(process.cwd(), 'evals', 'output', 'eval-report.json')
    mkdirSync(path.dirname(outputPath), {recursive: true})
    writeFileSync(
      outputPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          reports,
        },
        null,
        2,
      ),
      'utf8',
    )

    const inconclusiveReports = reports.filter(report => report.state === 'inconclusive')
    for (const report of inconclusiveReports) {
      logger.warning('Eval scenario inconclusive; no agent-quality conclusion was reached', {
        scenarioId: report.scenarioId,
        reason: report.stateReason,
        exitCode: report.execution.exitCode,
        durationMs: report.execution.durationMs,
        timeoutMs: report.execution.timeoutMs,
        safetyFailures: report.gates.filter(gate => gate.status === 'failed').map(gate => gate.id),
      })
    }

    const failedReports = reports.filter(report => report.state === 'failed')
    const allInconclusive = reports.every(report => report.state === 'inconclusive')

    // #then completed regressions fail, while inconclusive runs remain visible but unscored
    expect(reports).toHaveLength(2)
    expect(failedReports).toHaveLength(0)
    expect(allInconclusive).toBe(false)
  })
})
