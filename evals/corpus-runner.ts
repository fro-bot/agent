import type {EvalRunReport, Scenario} from './types.js'

export async function runScenarioSequence(
  scenarios: readonly Scenario[],
  runScenario: (scenario: Scenario) => Promise<EvalRunReport>,
  onReport: (report: EvalRunReport) => void,
): Promise<readonly EvalRunReport[]> {
  const reports: EvalRunReport[] = []
  for (const scenario of scenarios) {
    const report = await runScenario(scenario)
    reports.push(report)
    onReport(report)
    if (report.execution.cleanupError != null) {
      throw new Error(
        `Scenario ${scenario.id} cleanup failed; stopping corpus continuation: ${report.execution.cleanupError}`,
      )
    }
  }

  return reports
}
