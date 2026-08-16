import type {AgentResult, ExecutionConfig, PromptOptions} from '../src/features/agent/types.js'
import type {Logger} from '../src/shared/logger.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {describe, expect, it} from 'vitest'
import {createLogger} from '../src/shared/logger.js'
import {
  PRESEARCH_EXPERIMENT_SCENARIO_IDS,
  runPresearchDifferentialExperiment,
  type DifferentialExperimentResult,
} from './presearch-differential.js'

interface TestEnvironment {
  readonly originalEnv: Record<string, string | undefined>
  readonly tempDir: string
}

function snapshotEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {}
  for (const key of Object.keys(process.env)) {
    snapshot[key] = process.env[key]
  }
  return snapshot
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key) === false) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function createTestEnvironment(enabled: boolean): TestEnvironment {
  const originalEnv = snapshotEnv()
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fro-bot-presearch-test-'))
  const harnessPath = path.join(tempDir, 'harness')
  fs.writeFileSync(harnessPath, '#!/bin/sh\nprintf "test-harness 1.0\\n"\n', {mode: 0o755})

  if (enabled) {
    process.env.FRO_BOT_EVAL = '1'
  } else {
    delete process.env.FRO_BOT_EVAL
  }
  process.env.FRO_BOT_EVAL_HARNESS_BIN = harnessPath
  process.env.FRO_BOT_EVAL_MODEL = 'opencode/big-pickle'

  return {originalEnv, tempDir}
}

function restoreTestEnvironment(environment: TestEnvironment): void {
  restoreEnv(environment.originalEnv)
  fs.rmSync(environment.tempDir, {recursive: true, force: true})
}

function createAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: true,
    exitCode: 0,
    duration: 1,
    sessionId: null,
    error: null,
    tokenUsage: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
    ...overrides,
  }
}

function isTreatment(promptOptions: PromptOptions): boolean {
  return promptOptions.sessionContext?.priorWorkContext.length === 0
}

function writeIssueResponse(promptOptions: PromptOptions, body: string): void {
  const responseFilePath = promptOptions.responseFilePath
  if (responseFilePath == null) {
    throw new Error('Injected execution did not receive a response file path')
  }
  fs.writeFileSync(responseFilePath, body, 'utf8')
}

function outputPath(environment: TestEnvironment): string {
  return path.join(environment.tempDir, 'presearch-differential.json')
}

async function runEnabled(
  environment: TestEnvironment,
  execution: (promptOptions: PromptOptions, logger: Logger, config?: ExecutionConfig) => Promise<AgentResult>,
): Promise<Extract<DifferentialExperimentResult, {readonly status: 'completed'}>> {
  const result = await runPresearchDifferentialExperiment(createLogger({component: 'presearch-test'}), {
    execution,
    outputPath: outputPath(environment),
  })
  if (result.status !== 'completed') {
    throw new Error(`Expected a completed experiment, got ${result.status}`)
  }
  return result
}

describe('bounded session-presearch differential experiment', () => {
  it('runs both modes over exactly the two continuation scenarios and preserves identity', async () => {
    // #given an enabled experiment and injected execution that returns both required signals
    const environment = createTestEnvironment(true)
    try {
      const result = await runEnabled(environment, async promptOptions => {
        writeIssueResponse(promptOptions, 'seq ORBIT-217\n')
        return createAgentResult()
      })

      // #when the differential report is written
      const {report} = result
      const productionReports = report.modes.production.reports
      const treatmentReports = report.modes.treatment.reports

      // #then only the two selected scenarios participate in both modes
      expect(report.scenarioIds).toEqual(PRESEARCH_EXPERIMENT_SCENARIO_IDS)
      expect(productionReports.map(scenario => scenario.scenarioId)).toEqual(PRESEARCH_EXPERIMENT_SCENARIO_IDS)
      expect(treatmentReports.map(scenario => scenario.scenarioId)).toEqual(PRESEARCH_EXPERIMENT_SCENARIO_IDS)
      expect(report.comparison.status).toBe('passed')
      expect(report.comparison.missingEvidence).toEqual([])

      const productionAccounting = productionReports.map(scenario => {
        const accounting = scenario.sessionPresearch
        if (accounting === undefined) {
          throw new Error(`Missing production accounting for ${scenario.scenarioId}`)
        }
        return accounting
      })
      const treatmentAccounting = treatmentReports.map(scenario => {
        const accounting = scenario.sessionPresearch
        if (accounting === undefined) {
          throw new Error(`Missing treatment accounting for ${scenario.scenarioId}`)
        }
        return accounting
      })
      expect(
        productionAccounting.map(accounting => ({
          strategy: accounting.strategy,
          logicalKey: accounting.logicalKey,
          continuationSessionId: accounting.continuationSessionId,
          recentSessionCount: accounting.recentSessionCount,
          priorWorkResultCount: accounting.priorWorkResultCount,
        })),
      ).toEqual([
        {
          strategy: 'production-default',
          logicalKey: 'issue-1',
          continuationSessionId: 'continuation-session-42',
          recentSessionCount: 0,
          priorWorkResultCount: 1,
        },
        {
          strategy: 'production-default',
          logicalKey: 'issue-1',
          continuationSessionId: 'continuation-session-42',
          recentSessionCount: 0,
          priorWorkResultCount: 1,
        },
      ])
      expect(productionAccounting.every(accounting => accounting.injectedContextBytes > 0)).toBe(true)
      expect(treatmentAccounting).toEqual([
        {
          strategy: 'treatment',
          logicalKey: 'issue-1',
          continuationSessionId: 'continuation-session-42',
          recentSessionCount: 0,
          priorWorkResultCount: 0,
          injectedContextBytes: 0,
        },
        {
          strategy: 'treatment',
          logicalKey: 'issue-1',
          continuationSessionId: 'continuation-session-42',
          recentSessionCount: 0,
          priorWorkResultCount: 0,
          injectedContextBytes: 0,
        },
      ])
      expect(report.comparison.advisoryDifferences.some(difference => difference.field === 'sessionPresearch')).toBe(
        true,
      )
      expect(fs.existsSync(result.outputPath)).toBe(true)
    } finally {
      restoreTestEnvironment(environment)
    }
  }, 30_000)

  it('blocks a decisive safety or response-contract failure without repeats', async () => {
    // #given an injected treatment response that omits the required response artifact
    const environment = createTestEnvironment(true)
    let treatmentRuns = 0
    try {
      const result = await runEnabled(environment, async promptOptions => {
        if (isTreatment(promptOptions)) {
          treatmentRuns += 1
          if (treatmentRuns === 1) {
            return createAgentResult()
          }
        }
        writeIssueResponse(promptOptions, 'seq ORBIT-217\n')
        return createAgentResult()
      })

      // #when the candidate mode is compared with the live production mode
      const {report} = result
      const relevantScenario = report.comparison.scenarios.find(
        scenario => scenario.scenarioId === 'continuation-relevant',
      )

      // #then the decisive failure blocks immediately and adds no stochastic samples
      expect(report.comparison.status).toBe('failed')
      expect(relevantScenario?.status).toBe('failed')
      expect(relevantScenario?.decisiveGateIds).toContain('response-file-parses')
      expect(report.comparison.repeatRequests).toEqual([])
      expect(report.modes.production.reports).toHaveLength(2)
      expect(report.modes.treatment.reports).toHaveLength(2)
    } finally {
      restoreTestEnvironment(environment)
    }
  }, 30_000)

  it('drives stochastic quality repeats only to the existing four-vs-four bound', async () => {
    // #given one initial treatment quality failure followed by passing injected observations
    const environment = createTestEnvironment(true)
    let treatmentRuns = 0
    try {
      const result = await runEnabled(environment, async promptOptions => {
        if (isTreatment(promptOptions)) {
          treatmentRuns += 1
          if (treatmentRuns === 1) {
            writeIssueResponse(promptOptions, 'ORBIT-217\n')
            return createAgentResult()
          }
        }
        writeIssueResponse(promptOptions, 'seq ORBIT-217\n')
        return createAgentResult()
      })

      // #when the comparison requests lazy repeats for the stochastic quality failure
      const {report} = result
      const productionRelevant = report.modes.production.reports.filter(
        scenario => scenario.scenarioId === 'continuation-relevant',
      )
      const treatmentRelevant = report.modes.treatment.reports.filter(
        scenario => scenario.scenarioId === 'continuation-relevant',
      )

      // #then each side has at most four observations and the mixed result is not a regression claim
      expect(productionRelevant).toHaveLength(4)
      expect(treatmentRelevant).toHaveLength(4)
      expect(report.comparison.repeatRequests).toEqual([])
      expect(report.comparison.status).toBe('inconclusive')
      expect(report.comparison.statement).toContain('No causal improvement claim')
    } finally {
      restoreTestEnvironment(environment)
    }
  }, 30_000)

  it('retries an inconclusive infrastructure outcome before finalizing the comparison', async () => {
    // #given an injected treatment transport failure with no assessable response on the first attempt
    const environment = createTestEnvironment(true)
    let treatmentRuns = 0
    try {
      const result = await runEnabled(environment, async promptOptions => {
        if (isTreatment(promptOptions)) {
          treatmentRuns += 1
          if (treatmentRuns === 1) {
            return createAgentResult({success: false, exitCode: 1, error: 'injected transport failure'})
          }
        }
        writeIssueResponse(promptOptions, 'seq ORBIT-217\n')
        return createAgentResult()
      })

      // #when the infrastructure outcome is retried
      const {report} = result

      // #then the successful retry resolves the comparison without classifying the treatment as a regression
      expect(report.comparison.status).toBe('passed')
      expect(report.comparison.rerunScenarioIds).toEqual([])
      expect(
        report.comparison.scenarios.find(scenario => scenario.scenarioId === 'continuation-relevant')?.status,
      ).toBe('passed')
      expect(report.comparison.statement).not.toContain('candidate regression')
      expect(report.infrastructureAttempts).toHaveLength(1)
      expect(report.infrastructureAttempts[0]?.mode).toBe('treatment')
    } finally {
      restoreTestEnvironment(environment)
    }
  }, 30_000)

  it('retries a production infrastructure loss without poisoning the bounded quality comparison', async () => {
    // #given every treatment observation loses the continuation-relevant quality comparison
    const environment = createTestEnvironment(true)
    let productionRelevantRuns = 0
    try {
      const result = await runEnabled(environment, async promptOptions => {
        const relevant = promptOptions.context.repo.endsWith('/continuation-relevant')
        if (relevant === false) {
          writeIssueResponse(promptOptions, 'seq ORBIT-217\n')
          return createAgentResult()
        }

        if (isTreatment(promptOptions)) {
          writeIssueResponse(promptOptions, 'ORBIT-217\n')
          return createAgentResult()
        }

        productionRelevantRuns += 1
        if (productionRelevantRuns === 2) {
          return createAgentResult({success: false, exitCode: 1, error: 'server startup failure'})
        }
        writeIssueResponse(promptOptions, 'seq ORBIT-217\n')
        return createAgentResult()
      })

      // #when the first production repeat loses infrastructure and the next repeat succeeds
      const {report} = result
      const relevantScenario = report.comparison.scenarios.find(
        scenario => scenario.scenarioId === 'continuation-relevant',
      )

      // #then the candidate loss is decisive after the full quality budget, with the infra attempt auditable
      expect(report.comparison.status).toBe('failed')
      expect(relevantScenario?.status).toBe('failed')
      expect(relevantScenario?.reason).toContain('bounded stochastic quality loss')
      expect(
        report.modes.treatment.reports.filter(scenario => scenario.scenarioId === 'continuation-relevant'),
      ).toHaveLength(4)
      expect(
        report.modes.production.reports.filter(scenario => scenario.scenarioId === 'continuation-relevant'),
      ).toHaveLength(5)
      expect(report.infrastructureAttempts).toHaveLength(1)
      expect(report.infrastructureAttempts[0]).toMatchObject({
        mode: 'production',
        scenarioId: 'continuation-relevant',
        retryNumber: 1,
        retriesSpent: 0,
        reason: 'server startup failure',
      })
    } finally {
      restoreTestEnvironment(environment)
    }
  }, 30_000)

  it('stops infrastructure retries at the explicit cap without consuming quality budget', async () => {
    // #given every treatment quality sample fails and every production repeat loses infrastructure
    const environment = createTestEnvironment(true)
    let productionRelevantRuns = 0
    try {
      const result = await runEnabled(environment, async promptOptions => {
        const relevant = promptOptions.context.repo.endsWith('/continuation-relevant')
        if (relevant === false) {
          writeIssueResponse(promptOptions, 'seq ORBIT-217\n')
          return createAgentResult()
        }

        if (isTreatment(promptOptions)) {
          writeIssueResponse(promptOptions, 'ORBIT-217\n')
          return createAgentResult()
        }

        productionRelevantRuns += 1
        if (productionRelevantRuns > 1) {
          return createAgentResult({success: false, exitCode: 1, error: 'persistent server startup failure'})
        }
        writeIssueResponse(promptOptions, 'seq ORBIT-217\n')
        return createAgentResult()
      })

      // #when the infrastructure retry cap is exhausted
      const {report} = result

      // #then the comparison remains fail-closed and every infrastructure loss is recorded
      expect(report.comparison.status).toBe('inconclusive')
      const repeatRequest = report.comparison.repeatRequests.find(
        request => request.scenarioId === 'continuation-relevant',
      )
      expect(repeatRequest?.baselineRemaining).toBe(3)
      expect(report.infrastructureAttempts).toHaveLength(3)
      expect(report.infrastructureAttempts.map(attempt => attempt.retryNumber)).toEqual([1, 2, 3])
      expect(report.infrastructureAttempts.map(attempt => attempt.retriesSpent)).toEqual([0, 1, 2])
      expect(report.infrastructureAttempts.every(attempt => attempt.mode === 'production')).toBe(true)
      expect(
        report.modes.production.reports.filter(scenario => scenario.scenarioId === 'continuation-relevant'),
      ).toHaveLength(4)
    } finally {
      restoreTestEnvironment(environment)
    }
  }, 30_000)

  it('preserves the existing bounded quality flow when no infrastructure failures occur', async () => {
    // #given one initial treatment quality failure and otherwise successful execution
    const environment = createTestEnvironment(true)
    let treatmentRelevantRuns = 0
    try {
      const result = await runEnabled(environment, async promptOptions => {
        const relevant = promptOptions.context.repo.endsWith('/continuation-relevant')
        if (relevant && isTreatment(promptOptions)) {
          treatmentRelevantRuns += 1
          if (treatmentRelevantRuns === 1) {
            writeIssueResponse(promptOptions, 'ORBIT-217\n')
            return createAgentResult()
          }
        }
        writeIssueResponse(promptOptions, 'seq ORBIT-217\n')
        return createAgentResult()
      })

      // #when the comparison drives only stochastic quality repeats
      const {report} = result

      // #then the pre-existing four-vs-four inconclusive result is unchanged and no infra record exists
      expect(report.comparison.status).toBe('inconclusive')
      expect(report.comparison.repeatRequests).toEqual([])
      expect(report.infrastructureAttempts).toEqual([])
      expect(
        report.modes.production.reports.filter(scenario => scenario.scenarioId === 'continuation-relevant'),
      ).toHaveLength(4)
      expect(
        report.modes.treatment.reports.filter(scenario => scenario.scenarioId === 'continuation-relevant'),
      ).toHaveLength(4)
    } finally {
      restoreTestEnvironment(environment)
    }
  }, 30_000)

  it('is inert without the explicit live-eval gate', async () => {
    // #given the live-eval gate is absent
    const environment = createTestEnvironment(false)
    try {
      // #when the driver is invoked with an execution that must never run
      const result = await runPresearchDifferentialExperiment(createLogger({component: 'presearch-test'}), {
        execution: async () => {
          throw new Error('live execution should not start')
        },
        outputPath: outputPath(environment),
      })

      // #then it skips without creating an artifact or starting OpenCode
      expect(result).toEqual({status: 'skipped', reason: 'FRO_BOT_EVAL=1 is required'})
      expect(fs.existsSync(outputPath(environment))).toBe(false)
    } finally {
      restoreTestEnvironment(environment)
    }
  })
})
