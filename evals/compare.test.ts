import type {EvalRunReport, StableOutcomeProjection} from './types.js'
import type {BaselineArtifact} from './update-baseline.js'
import {describe, expect, it} from 'vitest'
import {compareCandidateToBaseline, MAX_COMPARISON_SAMPLES} from './compare.js'
import {ALL_SCENARIOS} from './scenarios/index.js'

const STABLE_GATE_IDS = [
  'response-file-parses',
  'verdict-matches',
  'exactly-one-delivery',
  'required-signals-present',
  'no-forbidden-mutation',
  'no-secret-leak',
] as const

function createOutcome(scenarioId: string, overrides: Partial<StableOutcomeProjection> = {}): StableOutcomeProjection {
  return {
    scenarioId,
    state: 'passed',
    verdict: null,
    gates: STABLE_GATE_IDS.map(id => ({
      id,
      kind: id === 'no-forbidden-mutation' || id === 'no-secret-leak' ? 'safety' : 'quality',
      status: 'passed',
    })),
    ...overrides,
  }
}

function createReport(
  scenarioId: string,
  outcomeOverrides: Partial<StableOutcomeProjection> = {},
  provenanceOverrides: Partial<EvalRunReport> = {},
): EvalRunReport {
  const outcome = createOutcome(scenarioId, outcomeOverrides)
  const gates = outcome.gates.map(gate => ({...gate, detail: 'synthetic gate'}))
  return {
    scenarioId,
    model: 'baseline/model',
    openCodeVersion: 'baseline-harness',
    pluginVersions: ['baseline-plugin@1.0.0'],
    promptHash: `baseline-prompt-${scenarioId}`,
    scenarioCommitSha: `baseline-fixture-${scenarioId}`,
    durationMs: 100,
    cost: 1,
    state: outcome.state,
    stateReason: 'synthetic report for comparison',
    execution: {
      completed: outcome.state === 'passed',
      reason: outcome.state === 'passed' ? null : 'synthetic incomplete execution',
      exitCode: outcome.state === 'passed' ? 0 : 1,
      durationMs: 100,
      timeoutMs: 300_000,
      diagnosticsPath: null,
      cleanupError: null,
    },
    outcome,
    gates,
    agentResult: {
      success: outcome.state === 'passed',
      exitCode: outcome.state === 'passed' ? 0 : 1,
      error: null,
      tokenUsage: {input: 10, output: 20, reasoning: 0, cache: {read: 1, write: 2}},
    },
    ...provenanceOverrides,
  }
}

function createBaseline(reports: readonly EvalRunReport[]): BaselineArtifact {
  const firstReport = reports[0]
  if (firstReport == null || firstReport.outcome == null) {
    throw new Error('Synthetic baseline requires at least one stable outcome')
  }

  return {
    schemaVersion: 1,
    sourceRun: {
      corpusHeadSha: 'reviewed-corpus-head',
      completionMarker: 'fro-bot-eval-report-complete-v1',
      suiteVerdict: 'passed',
    },
    runtime: {
      model: firstReport.model,
      openCodeVersion: firstReport.openCodeVersion,
      pluginVersions: firstReport.pluginVersions,
      configuredTimeoutMs: firstReport.execution.timeoutMs,
    },
    scenarios: reports.map(report => ({
      id: report.scenarioId,
      promptHash: report.promptHash,
      scenarioCommitSha: report.scenarioCommitSha,
      state: 'passed' as const,
      passedGateIds: report.outcome?.gates.filter(gate => gate.status === 'passed').map(gate => gate.id) ?? [],
      outcome: report.outcome,
    })),
  }
}

function createCorpusReports(
  outcomeOverrides: Readonly<Record<string, Partial<StableOutcomeProjection>>> = {},
): readonly EvalRunReport[] {
  return ALL_SCENARIOS.map(scenario => createReport(scenario.id, outcomeOverrides[scenario.id]))
}

function createQualityFailureOutcome(scenarioId: string): StableOutcomeProjection {
  return createOutcome(scenarioId, {
    state: 'failed',
    gates: createOutcome(scenarioId).gates.map(gate =>
      gate.id === 'verdict-matches' ? {...gate, status: 'failed' as const} : gate,
    ),
  })
}

describe('compareCandidateToBaseline', () => {
  it('compares stable outcomes and reports a bounded no-regression statement', () => {
    // #given a reviewed six-scenario baseline and a candidate with the same stable outcomes
    const baselineReports = createCorpusReports()
    const candidateReports = baselineReports.map(report =>
      createReport(
        report.scenarioId,
        {},
        {
          model: 'candidate/model',
          openCodeVersion: 'candidate-harness',
          pluginVersions: ['candidate-plugin@2.0.0'],
          promptHash: `candidate-prompt-${report.scenarioId}`,
          scenarioCommitSha: `candidate-fixture-${report.scenarioId}`,
          durationMs: 9_999,
          cost: 99,
          agentResult: {
            ...report.agentResult,
            tokenUsage: {input: 999, output: 888, reasoning: 7, cache: {read: 6, write: 5}},
          },
        },
      ),
    )

    // #when the candidate is compared without any live execution or baseline mutation
    const comparison = compareCandidateToBaseline({
      candidateReports,
      reviewedBaseline: createBaseline(baselineReports),
      reviewedBaselineReports: baselineReports,
    })

    // #then stable outcomes pass while advisory provenance differences remain visible
    expect(comparison.status).toBe('passed')
    expect(comparison.statement).toBe('No large observed regression across the six covered scenarios')
    expect(comparison.scenarios.every(scenario => scenario.status === 'passed')).toBe(true)
    expect(comparison.advisoryDifferences.some(difference => difference.field === 'promptHash')).toBe(true)
    expect(comparison.advisoryDifferences.some(difference => difference.field === 'durationMs')).toBe(true)
    expect(comparison.advisoryDifferences.some(difference => difference.field === 'cost')).toBe(true)
    expect(comparison.advisoryDifferences.some(difference => difference.field === 'tokenUsage')).toBe(true)
  })

  it.each([
    {
      label: 'an incomplete execution',
      reports: (baselineReports: readonly EvalRunReport[]): readonly EvalRunReport[] =>
        baselineReports.map(report =>
          report.scenarioId === 'clean-pr' ? {...report, execution: {...report.execution, completed: false}} : report,
        ),
      expectedReason: 'Reviewed baseline report clean-pr is not a completed validated pass',
    },
    {
      label: 'an invalid stable outcome',
      reports: (baselineReports: readonly EvalRunReport[]): readonly EvalRunReport[] =>
        baselineReports.map(report =>
          report.scenarioId === 'clean-pr'
            ? {...report, outcome: {...report.outcome, scenarioId: 'wrong-scenario'}}
            : report,
        ),
      expectedReason: 'Reviewed baseline report clean-pr is missing a valid stable outcome',
    },
    {
      label: 'a registry-order mismatch',
      reports: (baselineReports: readonly EvalRunReport[]): readonly EvalRunReport[] => [...baselineReports].reverse(),
      expectedReason: 'Reviewed baseline reports must exactly match the enabled or selected scenario registry in order',
    },
  ])('rejects reviewed baseline reports with $label', ({reports, expectedReason}) => {
    // #given a reviewed baseline report set with one invalid validation condition
    const baselineReports = createCorpusReports()

    // #when the candidate is compared with the invalid reviewed baseline reports
    const comparison = compareCandidateToBaseline({
      candidateReports: baselineReports,
      reviewedBaseline: createBaseline(baselineReports),
      reviewedBaselineReports: reports(baselineReports),
    })

    // #then the specific baseline validation rejection is returned
    expect(comparison.status).toBe('failed')
    expect(comparison.reason).toBe(expectedReason)
  })

  it('compares the two existing continuation scenarios without expanding the corpus', () => {
    // #given a reviewed six-scenario baseline and candidate reports for only the bounded experiment slice
    const baselineReports = createCorpusReports()
    const scenarioIds = ['continuation-relevant', 'continuation-irrelevant-non-degradation'] as const
    const candidateReports = baselineReports.filter(report =>
      scenarioIds.includes(report.scenarioId as (typeof scenarioIds)[number]),
    )

    // #when the bounded scenario slice is compared through the existing stable machinery
    const comparison = compareCandidateToBaseline({
      candidateReports,
      reviewedBaseline: createBaseline(baselineReports),
      reviewedBaselineReports: baselineReports,
      scenarioIds,
    })

    // #then only the two selected outcomes participate and the result remains non-regression evidence
    expect(comparison.status).toBe('passed')
    expect(comparison.scenarios.map(scenario => scenario.scenarioId)).toEqual(scenarioIds)
    expect(comparison.statement).toBe('No large observed regression across the two covered scenarios')
  })

  it('keeps presearch accounting advisory rather than stable quality evidence', () => {
    // #given identical stable outcomes with different context accounting between modes
    const baselineReports = createCorpusReports().map(report => ({
      ...report,
      sessionPresearch: {
        strategy: 'production-default' as const,
        logicalKey: 'issue-1',
        continuationSessionId: 'continuation-session-42',
        recentSessionCount: 2,
        priorWorkResultCount: 1,
        injectedContextBytes: 512,
      },
    }))
    const candidateReports = baselineReports.map(report => ({
      ...report,
      sessionPresearch: {
        ...report.sessionPresearch,
        strategy: 'treatment' as const,
        recentSessionCount: 0,
        priorWorkResultCount: 0,
        injectedContextBytes: 0,
      },
    }))

    // #when the treatment is compared with the eager baseline
    const comparison = compareCandidateToBaseline({
      candidateReports,
      reviewedBaseline: createBaseline(baselineReports),
      reviewedBaselineReports: baselineReports,
    })

    // #then accounting differences are visible without changing the stable result
    expect(comparison.status).toBe('passed')
    expect(comparison.advisoryDifferences.some(difference => difference.field === 'sessionPresearch')).toBe(true)
  })

  it('blocks on safety or response-contract failure without a stochastic retry request', () => {
    // #given a candidate with an observed response-contract failure and a separate safety failure
    const baselineReports = createCorpusReports()
    const candidateReports = createCorpusReports({
      'clean-pr': {
        state: 'failed',
        verdict: null,
        gates: [
          ...createOutcome('clean-pr').gates.map(gate =>
            gate.id === 'response-file-parses' ? {...gate, status: 'failed' as const} : gate,
          ),
        ],
      },
      'planted-defect': {
        state: 'failed',
        gates: createOutcome('planted-defect').gates.map(gate =>
          gate.id === 'no-secret-leak' ? {...gate, status: 'failed' as const} : gate,
        ),
      },
    })

    // #when the candidate is compared with the reviewed baseline
    const comparison = compareCandidateToBaseline({
      candidateReports,
      reviewedBaseline: createBaseline(baselineReports),
    })

    // #then both decisive failures block immediately and neither scenario receives quality repeats
    expect(comparison.status).toBe('failed')
    expect(comparison.scenarios.find(scenario => scenario.scenarioId === 'clean-pr')?.decisiveGateIds).toEqual([
      'response-file-parses',
    ])
    expect(comparison.scenarios.find(scenario => scenario.scenarioId === 'planted-defect')?.decisiveGateIds).toEqual([
      'no-secret-leak',
    ])
    expect(comparison.repeatRequests).toEqual([])
  })

  it('marks an incomplete run inconclusive and requests a rerun instead of a quality failure', () => {
    // #given a candidate that timed out before any assessable response existed
    const baselineReports = createCorpusReports()
    const candidateReports = createCorpusReports({
      'clean-pr': {
        state: 'inconclusive',
        gates: createOutcome('clean-pr').gates.map(gate =>
          gate.kind === 'quality' ? {...gate, status: 'not-evaluated' as const} : gate,
        ),
      },
    }).map(report =>
      report.scenarioId === 'clean-pr'
        ? {
            ...report,
            execution: {...report.execution, completed: false, reason: 'timeout'},
            agentResult: {...report.agentResult, success: false, exitCode: 124},
          }
        : report,
    )

    // #when the candidate is compared with the reviewed baseline
    const comparison = compareCandidateToBaseline({
      candidateReports,
      reviewedBaseline: createBaseline(baselineReports),
    })

    // #then infrastructure loss is rerunnable and does not become a candidate regression
    expect(comparison.status).toBe('inconclusive')
    expect(comparison.rerunScenarioIds).toEqual(['clean-pr'])
    expect(comparison.scenarios.find(scenario => scenario.scenarioId === 'clean-pr')?.status).toBe('inconclusive')
    expect(comparison.repeatRequests).toEqual([])
  })

  it('lazily bounds repeats to four-vs-four for only the affected stochastic quality scenario', () => {
    // #given one candidate quality-gate failure and five other clean scenarios
    const baselineReports = createCorpusReports()
    const candidateReports = createCorpusReports({
      'clean-pr': {
        state: 'failed',
        gates: createOutcome('clean-pr').gates.map(gate =>
          gate.id === 'verdict-matches' ? {...gate, status: 'failed' as const} : gate,
        ),
      },
    })

    // #when no repeat samples have been supplied yet
    const initial = compareCandidateToBaseline({
      candidateReports,
      reviewedBaseline: createBaseline(baselineReports),
    })

    // #then only the affected scenario requests three additional samples per side, including its initial run
    expect(initial.status).toBe('inconclusive')
    expect(initial.repeatRequests).toEqual([
      {
        scenarioId: 'clean-pr',
        candidateSamples: 1,
        baselineSamples: 1,
        candidateRemaining: MAX_COMPARISON_SAMPLES - 1,
        baselineRemaining: MAX_COMPARISON_SAMPLES - 1,
        maxSamplesPerSide: MAX_COMPARISON_SAMPLES,
      },
    ])
    expect(initial.repeatRequests.map(request => request.scenarioId)).toEqual(['clean-pr'])

    // #when the bounded repeat set is mixed and both modes otherwise pass
    const repeated = compareCandidateToBaseline({
      candidateReports,
      reviewedBaseline: createBaseline(baselineReports),
      samples: {
        'clean-pr': {
          candidate: [createOutcome('clean-pr'), createOutcome('clean-pr'), createOutcome('clean-pr')],
          baseline: [createOutcome('clean-pr'), createOutcome('clean-pr'), createOutcome('clean-pr')],
        },
      },
    })

    // #then the mixed stochastic evidence is inconclusive, never an improvement claim
    expect(repeated.status).toBe('inconclusive')
    expect(repeated.repeatRequests).toEqual([])
    expect(repeated.statement).toContain('No causal improvement claim')
    expect(repeated.scenarios.find(scenario => scenario.scenarioId === 'clean-pr')?.status).toBe('inconclusive')
  })

  it('fails when bounded stochastic quality loss persists across all four candidate samples', () => {
    // #given the initial candidate and three bounded repeats all fail the same stochastic quality gate
    const baselineReports = createCorpusReports()
    const candidateReports = createCorpusReports({
      'clean-pr': createQualityFailureOutcome('clean-pr'),
    })

    // #when the candidate loses every allowed sample while the reviewed baseline passes every sample
    const comparison = compareCandidateToBaseline({
      candidateReports,
      reviewedBaseline: createBaseline(baselineReports),
      samples: {
        'clean-pr': {
          candidate: [
            createQualityFailureOutcome('clean-pr'),
            createQualityFailureOutcome('clean-pr'),
            createQualityFailureOutcome('clean-pr'),
          ],
          baseline: [createOutcome('clean-pr'), createOutcome('clean-pr'), createOutcome('clean-pr')],
        },
      },
    })

    // #then the bounded quality loss is decisive and no further sampling is requested
    expect(comparison.status).toBe('failed')
    expect(comparison.repeatRequests).toEqual([])
    expect(comparison.scenarios.find(scenario => scenario.scenarioId === 'clean-pr')?.status).toBe('failed')
    expect(comparison.reason).toContain('bounded stochastic quality loss')
  })

  it('keeps a full four-vs-four mixed-quality comparison inconclusive', () => {
    // #given two candidate quality failures mixed with two passing samples at the full budget
    const baselineReports = createCorpusReports()
    const candidateReports = createCorpusReports({
      'clean-pr': createQualityFailureOutcome('clean-pr'),
    })

    // #when four candidate and four reviewed baseline samples are compared
    const comparison = compareCandidateToBaseline({
      candidateReports,
      reviewedBaseline: createBaseline(baselineReports),
      samples: {
        'clean-pr': {
          candidate: [createQualityFailureOutcome('clean-pr'), createOutcome('clean-pr'), createOutcome('clean-pr')],
          baseline: [createOutcome('clean-pr'), createOutcome('clean-pr'), createOutcome('clean-pr')],
        },
      },
    })

    // #then mixed full-budget evidence stays inconclusive without another repeat request
    expect(comparison.status).toBe('inconclusive')
    expect(comparison.repeatRequests).toEqual([])
    expect(comparison.reason).toContain('Repeated samples were mixed')
    expect(comparison.scenarios.find(scenario => scenario.scenarioId === 'clean-pr')?.status).toBe('inconclusive')
  })

  it.each(['quality-failed', 'inconclusive'] as const)(
    'reruns when reviewed-baseline repeats are %s despite a passing candidate',
    baselineRepeatState => {
      // #given a passing candidate and a reviewed baseline repeat that is not a stable pass
      const baselineReports = createCorpusReports()
      const baselineRepeat =
        baselineRepeatState === 'quality-failed'
          ? createQualityFailureOutcome('clean-pr')
          : createOutcome('clean-pr', {
              state: 'inconclusive',
              gates: createOutcome('clean-pr').gates.map(gate =>
                gate.kind === 'quality' ? {...gate, status: 'not-evaluated' as const} : gate,
              ),
            })

      // #when the candidate is compared with the asymmetric baseline sample set
      const comparison = compareCandidateToBaseline({
        candidateReports: createCorpusReports(),
        reviewedBaseline: createBaseline(baselineReports),
        samples: {
          'clean-pr': {
            candidate: [],
            baseline: [baselineRepeat],
          },
        },
      })

      // #then the comparison is inconclusive, asks for a rerun, and makes no candidate-regression claim
      expect(comparison.status).toBe('inconclusive')
      expect(comparison.rerunScenarioIds).toContain('clean-pr')
      expect(comparison.scenarios.find(scenario => scenario.scenarioId === 'clean-pr')?.status).toBe('inconclusive')
      expect(comparison.reason).not.toContain('candidate regression')
    },
  )

  it('fails closed when one side supplies five samples including the initial run', () => {
    // #given four additional candidate samples, exceeding the four-vs-four total budget
    const baselineReports = createCorpusReports()

    // #when the candidate is compared with five candidate observations for one scenario
    const comparison = compareCandidateToBaseline({
      candidateReports: createCorpusReports(),
      reviewedBaseline: createBaseline(baselineReports),
      samples: {
        'clean-pr': {
          candidate: [
            createOutcome('clean-pr'),
            createOutcome('clean-pr'),
            createOutcome('clean-pr'),
            createOutcome('clean-pr'),
          ],
          baseline: [],
        },
      },
    })

    // #then the comparison fails with an explicit bounded-budget reason
    expect(comparison.status).toBe('failed')
    expect(comparison.scenarios.find(scenario => scenario.scenarioId === 'clean-pr')?.reason).toContain(
      'comparison budget',
    )
    expect(comparison.repeatRequests).toEqual([])
  })

  it.each([
    {
      label: 'five baseline samples',
      samples: {
        candidate: [],
        baseline: [
          createOutcome('clean-pr'),
          createOutcome('clean-pr'),
          createOutcome('clean-pr'),
          createOutcome('clean-pr'),
        ],
      },
      expectedReason: 'comparison budget',
    },
    {
      label: 'a baseline sample for another scenario',
      samples: {
        candidate: [],
        baseline: [createOutcome('planted-defect')],
      },
      expectedReason: 'different scenario',
    },
  ])('fails closed for $label', ({samples, expectedReason}) => {
    // #given a valid candidate and reviewed baseline with malformed baseline-side samples
    const baselineReports = createCorpusReports()

    // #when the malformed samples are compared
    const comparison = compareCandidateToBaseline({
      candidateReports: baselineReports,
      reviewedBaseline: createBaseline(baselineReports),
      samples: {'clean-pr': samples},
    })

    // #then the baseline-side sample contract rejects the comparison
    expect(comparison.status).toBe('failed')
    expect(comparison.scenarios.find(scenario => scenario.scenarioId === 'clean-pr')?.reason).toContain(expectedReason)
    expect(comparison.repeatRequests).toEqual([])
  })

  it('returns explicit missing-evidence when the reviewed baseline lacks an observed outcome', () => {
    // #given the committed legacy baseline shape with no observed structured verdict
    const baselineReports = createCorpusReports()
    const baseline = createBaseline(baselineReports)
    const legacyBaseline: BaselineArtifact = {
      ...baseline,
      scenarios: baseline.scenarios.map(({outcome: _outcome, ...scenario}) => scenario),
    }

    // #when a complete candidate is compared against that baseline
    const comparison = compareCandidateToBaseline({
      candidateReports: baselineReports,
      reviewedBaseline: legacyBaseline,
    })

    // #then comparison refuses to manufacture baseline evidence from candidate values
    expect(comparison.status).toBe('inconclusive')
    expect(comparison.missingEvidence).toEqual(ALL_SCENARIOS.map(scenario => scenario.id))
    expect(comparison.scenarios).toHaveLength(ALL_SCENARIOS.length)
    expect(comparison.scenarios.every(scenario => scenario.baseline === null)).toBe(true)
    expect(comparison.scenarios.every(scenario => scenario.candidate?.scenarioId === scenario.scenarioId)).toBe(true)
    expect(comparison.statement).toContain('missing reviewed baseline evidence')
  })

  it('blocks an exactly-one-delivery contract failure without a retry request', () => {
    // #given a candidate with an observed duplicate delivery contract failure
    const baselineReports = createCorpusReports()
    const candidateReports = createCorpusReports({
      'clean-pr': {
        state: 'failed',
        gates: createOutcome('clean-pr').gates.map(gate =>
          gate.id === 'exactly-one-delivery' ? {...gate, status: 'failed' as const} : gate,
        ),
      },
    })

    // #when the candidate is compared with the reviewed baseline
    const comparison = compareCandidateToBaseline({
      candidateReports,
      reviewedBaseline: createBaseline(baselineReports),
    })

    // #then the response-contract failure is decisive and never enters stochastic sampling
    expect(comparison.status).toBe('failed')
    expect(comparison.scenarios.find(scenario => scenario.scenarioId === 'clean-pr')?.decisiveGateIds).toEqual([
      'exactly-one-delivery',
    ])
    expect(comparison.repeatRequests).toEqual([])
  })

  it('fails closed when candidate reports exceed the registered scenario set', () => {
    // #given the six registered scenarios plus an unregistered candidate report
    const baselineReports = createCorpusReports()

    // #when the candidate corpus contains an extra scenario instead of replacing one
    const comparison = compareCandidateToBaseline({
      candidateReports: [...baselineReports, createReport('unregistered-scenario')],
      reviewedBaseline: createBaseline(baselineReports),
    })

    // #then the eight-scenario ceiling and registry identity remain enforced
    expect(comparison.status).toBe('failed')
    expect(comparison.reason).toContain('scenario registry')
  })
})
