import type {Scenario} from './types.js'
import {describe, expect, it} from 'vitest'
import {RESPONSE_FILE_VERDICTS} from '../packages/runtime/src/agent/response-file.js'
import {buildAgentPrompt} from '../src/features/agent/index.js'
import {createLogger} from '../src/shared/logger.js'
import {buildPromptOptions, EVAL_CANARY_PLACEHOLDER} from './runner.js'
import {cleanPrScenario} from './scenarios/clean-pr.js'
import {continuationIrrelevantNonDegradationScenario} from './scenarios/continuation-irrelevant-non-degradation.js'
import {continuationRelevantScenario} from './scenarios/continuation-relevant.js'
import {ALL_SCENARIOS, MAX_SCENARIOS} from './scenarios/index.js'
import {issueKnownFilesScenario} from './scenarios/issue-known-files.js'
import {plantedDefectScenario} from './scenarios/planted-defect.js'
import {NEUTRAL_REVIEW_PROMPT} from './scenarios/shared.js'
import {unchangedConstraintViolationScenario} from './scenarios/unchanged-constraint-violation.js'

function expectationTokens(scenario: Scenario): readonly string[] {
  return [...RESPONSE_FILE_VERDICTS, ...scenario.expect.requiredSignals.flatMap(group => group.anyOf)]
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
    expect(MAX_SCENARIOS).toBe(8)
  })

  it.each(ALL_SCENARIOS)('$id declares an explicit forbidden mutation policy', scenario => {
    // #given one of the currently registered read-only scenarios
    // #when its mutation contract is inspected
    // #then every existing scenario remains explicitly forbidden
    expect(scenario.mutation).toEqual({kind: 'forbidden'})
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

  it.each(ALL_SCENARIOS)('$id has no forbidden signal expectation mechanism', scenario => {
    // #given one registered scenario
    // #when its quality contract is inspected
    // #then quality scoring asserts presence only
    expect(Object.keys(scenario.expect).some(key => key.endsWith('Signals') && key !== 'requiredSignals')).toBe(false)
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
    expect(ALL_SCENARIOS.map(scenario => scenario.id)).toEqual([
      'clean-pr',
      'planted-defect',
      'issue-known-files',
      'continuation-relevant',
      'continuation-irrelevant-non-degradation',
      'unchanged-constraint-violation',
    ])
  })

  it('models an unchanged-constraint violation as an actionable PR review', () => {
    // #given the unchanged-constraint violation scenario
    // #when its surface and outcome contract are inspected
    // #then it identifies the changed violation and unchanged authority without a second quality mechanism
    expect(unchangedConstraintViolationScenario.surface.kind).toBe('pull_request')
    expect(unchangedConstraintViolationScenario.prompt).toBe(NEUTRAL_REVIEW_PROMPT)
    expect(unchangedConstraintViolationScenario.priorWork).toBeNull()
    expect(unchangedConstraintViolationScenario.expect).toEqual({
      verdict: 'request-changes',
      requiredSignals: [
        {id: 'violating-file', anyOf: ['src/retry-policy.ts']},
        {id: 'constraint-source', anyOf: ['deploy/lease-policy.json']},
      ],
    })
    expect(Object.keys(unchangedConstraintViolationScenario)).not.toContain('forbiddenSignals')
    expect(Object.keys(unchangedConstraintViolationScenario.expect)).toEqual(['verdict', 'requiredSignals'])
  })

  it('keeps hydrated comments chronological, descriptive, and non-normative', () => {
    // #given the supplied hydrated PR context
    if (unchangedConstraintViolationScenario.surface.kind !== 'pull_request') {
      throw new Error('Unchanged-constraint violation must use a pull_request surface')
    }
    const context = unchangedConstraintViolationScenario.surface.hydratedContext
    if (context == null || context.type !== 'pull_request') {
      throw new Error('Unchanged-constraint violation must provide hydrated pull request context')
    }

    // #when the context ordering and comment language are inspected
    // #then exactly three chronological comments contain only descriptions of the visible patch
    expect(context.comments).toHaveLength(3)
    expect(context.commentsTruncated).toBe(false)
    expect(context.totalComments).toBe(3)
    expect(context.comments.map(comment => comment.createdAt)).toEqual([
      '2026-08-01T10:00:00Z',
      '2026-08-02T10:00:00Z',
      '2026-08-03T10:00:00Z',
    ])
    const forbiddenCommentTerms = [
      'must',
      'cannot',
      'require',
      'should',
      'block',
      'ship',
      'merge',
      'lgtm',
      '2500',
      'EDGE-BUDGET',
      'deploy/lease-policy.json',
      'lease budget',
      'retry ceiling',
    ]
    const serializedComments = JSON.stringify(context.comments).toLowerCase()
    for (const term of forbiddenCommentTerms) {
      expect(serializedComments).not.toContain(term.toLowerCase())
    }
    for (const group of unchangedConstraintViolationScenario.expect.requiredSignals) {
      for (const signal of group.anyOf) {
        expect(serializedComments).not.toContain(signal.toLowerCase())
      }
    }
  })

  it('keeps the authoritative policy independent from the visible diff', () => {
    // #given the unchanged policy fixture and hydrated changed-file metadata
    if (unchangedConstraintViolationScenario.surface.kind !== 'pull_request') {
      throw new Error('Unchanged-constraint violation must use a pull_request surface')
    }
    const context = unchangedConstraintViolationScenario.surface.hydratedContext
    if (context == null || context.type !== 'pull_request') {
      throw new Error('Unchanged-constraint violation must provide hydrated pull request context')
    }
    const policyText = unchangedConstraintViolationScenario.files['deploy/lease-policy.json']
    if (policyText == null) {
      throw new Error('Unchanged-constraint violation must provide the unchanged policy fixture')
    }

    // #when the policy content and changed-file metadata are inspected
    // #then the policy independently supplies the limit and lease relation while staying outside the diff
    expect(JSON.parse(policyText)).toEqual({
      authority: 'gateway lease-renewal mechanism',
      leaseRenewalBudgetMs: 2500,
      retryBackoff: {
        maxMs: 2500,
        constraint:
          'Retry backoff must not exceed the lease renewal budget because the gateway re-leases between retry attempts; a longer backoff outlives the lease.',
      },
    })
    expect(policyText).toMatch(/retry backoff/i)
    expect(policyText).toMatch(/2500/)
    expect(policyText).toMatch(/gateway re-leases between retry attempts/i)
    expect(policyText).toMatch(/longer backoff outlives the lease/i)
    expect(unchangedConstraintViolationScenario.surface.diffFiles).not.toContainEqual(
      expect.objectContaining({filename: 'deploy/lease-policy.json'}),
    )
    expect(context.files).not.toContainEqual(expect.objectContaining({path: 'deploy/lease-policy.json'}))
  })

  it('keeps the visible source and test coherent at 3000ms', () => {
    // #given the unchanged-constraint violation fixture
    if (unchangedConstraintViolationScenario.surface.kind !== 'pull_request') {
      throw new Error('Unchanged-constraint violation must use a pull_request surface')
    }
    const source = unchangedConstraintViolationScenario.files['src/retry-policy.ts']
    const test = unchangedConstraintViolationScenario.files['src/retry-policy.test.ts']

    // #when source, test, and changed-file metadata are compared
    // #then the visible change is a coherent 3000ms implementation/test update
    expect(source).toContain('3000')
    expect(test).toContain('3000')
    expect(source).not.toContain('2500')
    expect(test).not.toContain('2500')
    expect(unchangedConstraintViolationScenario.surface.diffFiles).toEqual([
      {filename: 'src/retry-policy.ts', status: 'modified', additions: 1, deletions: 1},
      {filename: 'src/retry-policy.test.ts', status: 'modified', additions: 1, deletions: 1},
    ])
  })

  it('keeps policy evidence and the expected outcome out of agent-facing inputs', () => {
    // #given the scenario inputs visible to the review agent
    if (unchangedConstraintViolationScenario.surface.kind !== 'pull_request') {
      throw new Error('Unchanged-constraint violation must use a pull_request surface')
    }
    const visibleInputs = [
      unchangedConstraintViolationScenario.prompt,
      JSON.stringify(unchangedConstraintViolationScenario.surface.event),
      JSON.stringify(unchangedConstraintViolationScenario.surface.diffFiles),
      JSON.stringify(unchangedConstraintViolationScenario.surface.hydratedContext?.comments),
    ].join('\n')

    // #when policy path, value, relation, and expected verdict hints are searched for
    // #then the agent must discover trusted policy evidence from the fixture repository
    for (const hint of [
      'deploy/lease-policy.json',
      '2500',
      'must not exceed',
      'gateway re-leases between retry attempts',
      'longer backoff outlives the lease',
      'request-changes',
    ]) {
      expect(visibleInputs).not.toContain(hint)
    }
  })

  it('renders hydrated comments as ordered PR-comment attachments', () => {
    // #given a complete hydrated PR context
    const promptOptions = buildPromptOptions(
      unchangedConstraintViolationScenario,
      '0123456789012345678901234567890123456789',
      '/tmp/fro-bot-eval-response.md',
    )

    // #when the agent-facing prompt and reference files are built
    const prompt = buildAgentPrompt(promptOptions, createLogger({component: 'eval-scenarios-test'}))
    const commentAttachments = prompt.referenceFiles.filter(file => file.filename.startsWith('pr-comment-'))

    // #then comments remain oldest-to-newest in their attachment filenames and contents
    if (unchangedConstraintViolationScenario.surface.kind !== 'pull_request') {
      throw new Error('Unchanged-constraint violation must use a pull_request surface')
    }
    const context = unchangedConstraintViolationScenario.surface.hydratedContext
    if (context == null || context.type !== 'pull_request') {
      throw new Error('Unchanged-constraint violation must provide hydrated pull request context')
    }
    expect(commentAttachments.map(file => file.filename)).toEqual([
      'pr-comment-001-reviewer-one.txt',
      'pr-comment-002-reviewer-two.txt',
      'pr-comment-003-reviewer-three.txt',
    ])
    expect(commentAttachments.map(file => file.content)).toEqual(context.comments.map(comment => comment.body))
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

  it('keeps the continuation pair differential and issue-shaped', () => {
    // #given relevant and irrelevant continuation scenarios
    // #when their shared agent-facing inputs and continuation metadata are compared
    // #then only prior work and expectations distinguish the pair
    expect(continuationRelevantScenario.prompt).toBe(continuationIrrelevantNonDegradationScenario.prompt)
    expect(continuationRelevantScenario.surface).toBe(continuationIrrelevantNonDegradationScenario.surface)
    expect(continuationRelevantScenario.files).toBe(continuationIrrelevantNonDegradationScenario.files)
    expect(continuationRelevantScenario.expect).not.toEqual(continuationIrrelevantNonDegradationScenario.expect)
    expect(continuationRelevantScenario.priorWork).not.toEqual(continuationIrrelevantNonDegradationScenario.priorWork)

    for (const scenario of [continuationRelevantScenario, continuationIrrelevantNonDegradationScenario]) {
      expect(scenario.surface.kind).toBe('issue_comment')
      expect(scenario.surface.hydratedContext).toBeNull()
      expect('diffFiles' in scenario.surface).toBe(false)
      expect(scenario.mutation).toEqual({kind: 'forbidden'})
    }
  })

  it('captures the continuation pair expectations without scanning supplied prior work', () => {
    // #given the two intentionally different prior-work excerpts
    // #when their outcome contracts are inspected
    // #then relevant work is required while unrelated prior work has no absence contract
    expect(continuationRelevantScenario.expect).toEqual({
      verdict: null,
      requiredSignals: [
        {id: 'ordering-field', anyOf: ['seq']},
        {id: 'prior-decision', anyOf: ['ORBIT-217']},
      ],
    })
    expect(continuationIrrelevantNonDegradationScenario.expect).toEqual({
      verdict: null,
      requiredSignals: [{id: 'ordering-field', anyOf: ['seq']}],
    })
    expect(JSON.stringify(continuationRelevantScenario.priorWork)).toContain('ORBIT-217')
    expect(JSON.stringify(continuationIrrelevantNonDegradationScenario.priorWork)).toContain('UTC-ROUNDING-9000')
    expect(
      Object.keys(continuationRelevantScenario.expect).some(
        key => key.endsWith('Signals') && key !== 'requiredSignals',
      ),
    ).toBe(false)
    expect(
      Object.keys(continuationIrrelevantNonDegradationScenario.expect).some(
        key => key.endsWith('Signals') && key !== 'requiredSignals',
      ),
    ).toBe(false)
  })
})
