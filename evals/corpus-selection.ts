import type {Scenario} from './types.js'
import process from 'node:process'

export function selectCorpusScenarios(
  scenarios: readonly Scenario[],
  allowMutation = process.env.FRO_BOT_EVAL_ALLOW_MUTATION === '1',
): {readonly selectedScenarios: readonly Scenario[]; readonly skippedScenarioIds: readonly string[]} {
  const selectedScenarios: Scenario[] = []
  const skippedScenarioIds: string[] = []

  for (const scenario of scenarios) {
    if (scenario.mutation.kind === 'allowed' && allowMutation === false) {
      skippedScenarioIds.push(scenario.id)
    } else {
      selectedScenarios.push(scenario)
    }
  }

  return {selectedScenarios, skippedScenarioIds}
}
