import type {Scenario} from './types.js'
import {describe, expect, it} from 'vitest'
import {RESPONSE_FILE_VERDICTS} from '../packages/runtime/src/agent/response-file.js'
import {EVAL_CANARY_PLACEHOLDER} from './runner.js'
import {cleanPrScenario} from './scenarios/clean-pr.js'
import {ALL_SCENARIOS, MAX_SCENARIOS} from './scenarios/index.js'
import {issueKnownFilesScenario} from './scenarios/issue-known-files.js'
import {plantedDefectScenario} from './scenarios/planted-defect.js'

function expectationTokens(scenario: Scenario): readonly string[] {
  return [
    ...RESPONSE_FILE_VERDICTS,
    ...scenario.expect.requiredSignals.flatMap(group => group.anyOf),
    ...scenario.expect.forbiddenSignals.flatMap(group => group.anyOf),
  ]
}

function assertNoExpectationLeakage(scenario: Scenario): void {
  const promptAndEvent = `${scenario.prompt}\n${JSON.stringify(scenario.surface.event)}`.toLowerCase()

  for (const token of expectationTokens(scenario)) {
    expect(promptAndEvent).not.toContain(token.toLowerCase())
  }
}

describe('eval scenario registry', () => {
  it('keeps scenario IDs unique and within the corpus capacity', () => {
    // #given the centralized scenario registry
    const ids = ALL_SCENARIOS.map(scenario => scenario.id)

    // #when the registry invariants are checked
    // #then the corpus remains bounded and every scenario is addressable once
    expect(ALL_SCENARIOS.length).toBeLessThanOrEqual(MAX_SCENARIOS)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(ALL_SCENARIOS)('$id contains the eval canary placeholder in fixture files', scenario => {
    // #given one registered scenario
    // #when every fixture file is inspected
    const fixtureText = Object.values(scenario.files).join('\n')

    // #then the runner can plant its per-run canary
    expect(fixtureText).toContain(EVAL_CANARY_PLACEHOLDER)
  })

  it.each(ALL_SCENARIOS)('$id keeps expectations out of the agent-facing input', scenario => {
    // #given one registered scenario
    // #when its prompt and typed event payload are inspected
    // #then verdicts and signal alternatives are not answer keys
    assertNoExpectationLeakage(scenario)
  })

  it('keeps required signal alternatives in the leakage guard', () => {
    // #given the planted scenario's required signal alternatives
    const tokens = expectationTokens(plantedDefectScenario)

    // #when the registry guard inputs are assembled
    // #then both the file signal and at least one defect alternative are present
    expect(tokens).toContain('src/access.ts')
    expect(tokens).toContain('age < 18')
  })

  it('fails the leakage guard when a required signal is accidentally added to a prompt', () => {
    // #given a planted scenario accidentally amended with a required signal
    const leakedScenario = {
      ...plantedDefectScenario,
      prompt: `${plantedDefectScenario.prompt} age < 18`,
    }

    // #when the neutralization guard is exercised against that fixture
    // #then the table-driven guard would reject the leaked answer key
    expect(() => assertNoExpectationLeakage(leakedScenario)).toThrow()
  })

  it('rejects forbidden signal alternatives leaked into prompt or event input', () => {
    // #given a constructed scenario with a forbidden signal group leaked into its prompt
    const leakedScenario = {
      ...cleanPrScenario,
      prompt: `${cleanPrScenario.prompt} internal-only marker`,
      expect: {
        ...cleanPrScenario.expect,
        forbiddenSignals: [{id: 'internal-marker', anyOf: ['internal-only marker', 'private marker'] as const}],
      },
    }

    // #when the table-driven expectation tokens and neutralization guard are exercised
    // #then every forbidden alternative is represented and leakage is rejected
    expect(expectationTokens(leakedScenario)).toEqual(
      expect.arrayContaining(['internal-only marker', 'private marker']),
    )
    expect(() => assertNoExpectationLeakage(leakedScenario)).toThrow()
  })

  it('keeps the agent-facing prompt, event, files, and diff summary identical', () => {
    // #given the clean and planted-defect scenarios
    // #when their agent-facing inputs are compared
    // #then only the implementation body differs
    expect(cleanPrScenario.prompt).toBe(plantedDefectScenario.prompt)
    expect(cleanPrScenario.surface).toMatchObject({kind: 'pull_request'})
    expect(plantedDefectScenario.surface).toMatchObject({kind: 'pull_request'})
    if (cleanPrScenario.surface.kind !== 'pull_request' || plantedDefectScenario.surface.kind !== 'pull_request') {
      throw new Error('Differential scenarios must both use the pull_request surface')
    }
    expect(cleanPrScenario.surface.event).toEqual(plantedDefectScenario.surface.event)
    expect(cleanPrScenario.surface.diffFiles).toEqual(plantedDefectScenario.surface.diffFiles)
    expect(Object.keys(cleanPrScenario.files).sort()).toEqual(Object.keys(plantedDefectScenario.files).sort())
    expect(cleanPrScenario.files['src/access.test.ts']).toBe(plantedDefectScenario.files['src/access.test.ts'])
    expect(cleanPrScenario.files['src/access.ts']).not.toBe(plantedDefectScenario.files['src/access.ts'])
  })

  it('keeps answer-revealing instructions out of the shared prompt', () => {
    // #given the shared neutral review prompt
    const prompt = cleanPrScenario.prompt.toLowerCase()

    // #when the prompt is inspected for answer leakage
    // #then it does not reveal scenario expectations or defect metadata
    expect(prompt).not.toContain('clean')
    expect(prompt).not.toContain('defect')
    expect(prompt).not.toContain('approve')
    expect(prompt).not.toContain('request-changes')
    expect(prompt).not.toContain('src/access.ts')
  })

  it('registers the issue answer scenario after the existing review scenarios', () => {
    // #given the centralized registry
    // #when scenario IDs are inspected
    // #then the stable corpus order includes the issue-answer scenario
    expect(ALL_SCENARIOS.map(scenario => scenario.id)).toEqual(['clean-pr', 'planted-defect', 'issue-known-files'])
  })

  it('models the issue answer scenario as a non-PR issue comment with answer signals', () => {
    // #given the issue answer scenario
    // #when its surface and outcome expectations are inspected
    // #then it has no PR diff and requires the defining file plus an equivalent delay value
    expect(issueKnownFilesScenario.surface.kind).toBe('issue_comment')
    expect(issueKnownFilesScenario.surface.hydratedContext).toBeNull()
    expect('diffFiles' in issueKnownFilesScenario.surface).toBe(false)
    expect(issueKnownFilesScenario.expect.verdict).toBeNull()
    expect(issueKnownFilesScenario.expect.requiredSignals).toEqual([
      {id: 'defining-file', anyOf: ['src/retry-policy.ts']},
      {id: 'max-retry-delay', anyOf: ['2750', '2,750', '2.75 seconds', '2.75s']},
    ])
  })

  it('keeps issue answer values and source path out of the agent-facing input', () => {
    // #given the issue answer scenario's typed event and neutral prompt
    const promptAndEvent = `${issueKnownFilesScenario.prompt}\n${JSON.stringify(issueKnownFilesScenario.surface.event)}`

    // #when answer hints are searched for
    // #then neither the event nor prompt gives away the expected response
    for (const hint of ['src/retry-policy.ts', '2750', '2,750', '2.75 seconds', '2.75s']) {
      expect(promptAndEvent).not.toContain(hint)
    }
  })
})
