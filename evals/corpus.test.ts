import type {EvalRunReport} from './types.js'
import {execFileSync} from 'node:child_process'
import * as crypto from 'node:crypto'
import {mkdirSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {createLogger} from '../src/shared/logger.js'
import {evaluateCorpusVerdict} from './corpus-verdict.js'
import {resolveEvalTimeoutMs, runScenario} from './runner.js'
import {cleanPrScenario} from './scenarios/clean-pr.js'
import {plantedDefectScenario} from './scenarios/planted-defect.js'

const EVAL_ENABLED = process.env.FRO_BOT_EVAL === '1'
const SCENARIOS = [cleanPrScenario, plantedDefectScenario] as const
const REPORT_COMPLETION_MARKER = 'fro-bot-eval-report-complete-v1'

/**
 * Scenarios run sequentially, so the suite ceiling must cover every scenario's own
 * execution budget plus server startup and teardown. Derive it from the configured budget
 * rather than hardcoding: a fixed ceiling silently caps a raised per-scenario timeout and
 * kills the run mid-investigation, which then reads as a capability failure.
 */
const STARTUP_TEARDOWN_ALLOWANCE_MS = 60_000
const SUITE_TIMEOUT_MS = SCENARIOS.length * (resolveEvalTimeoutMs() + STARTUP_TEARDOWN_ALLOWANCE_MS)

function readCorpusHeadSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: process.cwd(), encoding: 'utf8'}).trim()
}

function warnIfOtherTestsMayRun(logger: ReturnType<typeof createLogger>): void {
  const testFileArguments = process.argv.slice(2).filter(argument => argument.includes('.test.'))
  const otherTestArguments = testFileArguments.filter(argument => path.basename(argument) !== 'corpus.test.ts')

  if (otherTestArguments.length > 0 || testFileArguments.length === 0) {
    logger.warning(
      'FRO_BOT_EVAL changes process.cwd globally for the duration of each scenario; run corpus.test.ts alone to avoid affecting other tests',
      {otherTestArguments},
    )
  }
}

function writeReportAtomically(outputPath: string, report: unknown, runId: string): void {
  const temporaryPath = `${outputPath}.${runId}.tmp`
  try {
    writeFileSync(temporaryPath, JSON.stringify(report, null, 2), 'utf8')
    renameSync(temporaryPath, outputPath)
  } finally {
    rmSync(temporaryPath, {force: true})
  }
}

describe.skipIf(EVAL_ENABLED === false)('agent outcome eval corpus', {timeout: SUITE_TIMEOUT_MS}, () => {
  it('runs exactly the two frozen U1 scenarios and writes their reports', async () => {
    // #given the two intentionally small frozen scenarios
    const logger = createLogger({component: 'eval-corpus'})
    const reports: EvalRunReport[] = []
    const runId = crypto.randomUUID()
    const startedAt = new Date().toISOString()
    const corpusHeadSha = readCorpusHeadSha()

    warnIfOtherTestsMayRun(logger)

    const outputOverride = process.env.FRO_BOT_EVAL_OUTPUT
    const outputPath =
      outputOverride != null && outputOverride.trim().length > 0
        ? outputOverride
        : path.join(process.cwd(), 'evals', 'output', 'eval-report.json')
    mkdirSync(path.dirname(outputPath), {recursive: true})

    const persist = (completed: boolean): void => {
      const suiteVerdict = completed === true ? evaluateCorpusVerdict(reports.map(report => report.state)) : null
      writeReportAtomically(
        outputPath,
        {
          runId,
          corpusHeadSha,
          scenarioIds: SCENARIOS.map(scenario => scenario.id),
          startedAt,
          updatedAt: new Date().toISOString(),
          completed,
          completionMarker: completed ? REPORT_COMPLETION_MARKER : null,
          suiteVerdict,
          reports,
        },
        runId,
      )
    }

    // Mark this run as current before any provider or harness work begins, replacing any
    // complete report left by an older run with an unmistakably incomplete report.
    persist(false)

    // #when each scenario is evaluated through executeOpenCode
    for (const scenario of SCENARIOS) {
      reports.push(await runScenario(scenario, logger))
      persist(false)
    }

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

    const suiteVerdict = evaluateCorpusVerdict(reports.map(report => report.state))
    persist(true)

    // #then completed regressions fail, while partial infrastructure loss remains visible
    expect(reports).toHaveLength(2)
    expect(suiteVerdict.status).toBe('passed')
  })
})
