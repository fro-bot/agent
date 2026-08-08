import {describe, expect, it} from 'vitest'
import {selectCorpusScenarios} from './corpus-selection.js'
import {cleanPrScenario} from './scenarios/clean-pr.js'

describe('corpus scenario selection', () => {
  it('omits allowed scenarios and records their IDs when mutation opt-in is absent', () => {
    // #given a synthetic corpus containing one forbidden and one allowed scenario
    const allowed = {
      ...cleanPrScenario,
      id: 'synthetic-allowed',
      mutation: {
        kind: 'allowed' as const,
        changedPaths: ['src/access.ts'] as const,
        verifyTestPath: 'src/access.test.ts',
      },
    }

    // #when mutation execution is not opted in
    const result = selectCorpusScenarios([cleanPrScenario, allowed], false)

    // #then the allowed scenario is skipped rather than scored
    expect(result.selectedScenarios.map(scenario => scenario.id)).toEqual(['clean-pr'])
    expect(result.skippedScenarioIds).toEqual(['synthetic-allowed'])
  })

  it('includes allowed scenarios when mutation opt-in is enabled', () => {
    // #given the same synthetic corpus
    const allowed = {
      ...cleanPrScenario,
      id: 'synthetic-allowed',
      mutation: {
        kind: 'allowed' as const,
        changedPaths: ['src/access.ts'] as const,
        verifyTestPath: 'src/access.test.ts',
      },
    }

    // #when mutation execution is explicitly opted in
    const result = selectCorpusScenarios([cleanPrScenario, allowed], true)

    // #then both scenarios are selected and none is represented as inconclusive
    expect(result.selectedScenarios.map(scenario => scenario.id)).toEqual(['clean-pr', 'synthetic-allowed'])
    expect(result.skippedScenarioIds).toEqual([])
  })
})
