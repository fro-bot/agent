import type {EvalRunReport} from './types.js'
import {describe, expect, it} from 'vitest'
import {runScenarioSequence} from './corpus-runner.js'
import {cleanPrScenario} from './scenarios/clean-pr.js'
import {plantedDefectScenario} from './scenarios/planted-defect.js'

function createReport(scenarioId: string, cleanupError: string | null): EvalRunReport {
  return {
    scenarioId,
    model: 'test/model',
    openCodeVersion: 'test-harness',
    pluginVersions: [],
    promptHash: 'prompt-hash',
    scenarioCommitSha: 'fixture-sha',
    durationMs: 1,
    cost: null,
    state: cleanupError == null ? 'passed' : 'failed',
    stateReason: cleanupError == null ? 'passed' : 'cleanup failed',
    execution: {
      completed: true,
      reason: null,
      exitCode: 0,
      durationMs: 1,
      timeoutMs: 1_000,
      diagnosticsPath: null,
      cleanupError,
    },
    outcome: {
      scenarioId,
      state: cleanupError == null ? 'passed' : 'failed',
      verdict: null,
      gates: [],
    },
    gates: [],
    agentResult: {success: true, exitCode: 0, error: null, tokenUsage: null},
  }
}

describe('runScenarioSequence', () => {
  it('stops after cleanup failure and preserves the completed report', async () => {
    // #given a first scenario whose execution completed but cleanup failed
    const reports: EvalRunReport[] = []
    const executed: string[] = []
    const runScenario = async (scenario: typeof cleanPrScenario | typeof plantedDefectScenario) => {
      executed.push(scenario.id)
      return createReport(scenario.id, scenario.id === cleanPrScenario.id ? 'forced cleanup failure' : null)
    }

    // #when the corpus sequence runs
    const result = runScenarioSequence([cleanPrScenario, plantedDefectScenario], runScenario, report => {
      reports.push(report)
    })

    // #then the first evidence is retained, the sequence fails, and continuation never runs
    await expect(result).rejects.toThrow('forced cleanup failure')
    expect(reports).toHaveLength(1)
    expect(reports[0]?.state).toBe('failed')
    expect(executed).toEqual([cleanPrScenario.id])
  })
})
