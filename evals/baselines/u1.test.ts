import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {ALL_SCENARIOS} from '../scenarios/index.js'

interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: {
    readonly read: number
    readonly write: number
  }
}

interface BaselineScenario {
  readonly id: string
  readonly promptHash: string
  readonly scenarioCommitSha: string
  readonly state: 'passed'
  readonly durationMs: number
  readonly cost: number | null
  readonly executionDurationMs: number
  readonly tokenUsage: TokenUsage
  readonly passedGateIds: readonly string[]
}

interface U1Baseline {
  readonly schemaVersion: 1
  readonly sourceRun: {
    readonly runId: string
    readonly corpusHeadSha: string
    readonly startedAt: string
    readonly completedAt: string
    readonly completionMarker: string
    readonly suiteVerdict: 'passed'
  }
  readonly runtime: {
    readonly model: string
    readonly openCodeVersion: string
    readonly pluginVersions: readonly string[]
    readonly configuredTimeoutMs: number
  }
  readonly scenarios: readonly BaselineScenario[]
}

const BASELINE_URL = new URL('./u1.json', import.meta.url)
const EXPECTED_PLUGIN_VERSIONS = ['@cortexkit/opencode-anthropic-auth@1.18.0'] as const
const EXPECTED_PASSED_GATE_IDS = [
  'response-file-parses',
  'verdict-matches',
  'exactly-one-delivery',
  'required-signals-present',
  'no-forbidden-mutation',
  'no-secret-leak',
] as const
const EXPECTED_SCENARIO_PROVENANCE = [
  {
    id: 'clean-pr',
    promptHash: 'c931108224b647965698bce33895321dda4f36196f3a0cf08e614318b8c64ab3',
    scenarioCommitSha: 'a943c8487eb4b3a9f5d2eac5011c99f8d5cdd0c7',
  },
  {
    id: 'planted-defect',
    promptHash: 'e95b23271f5f4c0968bf9991549c77795e800d0da72e9b4650be2e354b02433e',
    scenarioCommitSha: '935e9a0454b58682fa700f2060540d0075abb9e4',
  },
  {
    id: 'issue-known-files',
    promptHash: '0f22b91506e74c20eb2e6a81e8c475b4b243dd0aab2e2df5adbe1ebab7f1be42',
    scenarioCommitSha: '82900e7f5e0b91bb563f6d356f55e978ba6b55c9',
  },
  {
    id: 'continuation-relevant',
    promptHash: '252d5edf42487cef19331318f237e4d84052bf2653bc07c50e7631b13c16b4bc',
    scenarioCommitSha: 'dca3771ea0d4897a6319349ec5540d868e26246f',
  },
  {
    id: 'continuation-irrelevant-non-degradation',
    promptHash: '5dadff0e901f47658588a5850605a5bdf1ae5ee2f5c72384a5154ee6c13a2c6d',
    scenarioCommitSha: '5a8ccb832cfa476454a9d1c87bb7b6347003a935',
  },
  {
    id: 'unchanged-constraint-violation',
    promptHash: 'fe4b49d4dace5eb41372a037e1539f8fed44cec3d6ca1afe59bf84fdb2ac83c0',
    scenarioCommitSha: 'c4645b169220949c5f72408c3c3d33d0f24b519b',
  },
] as const

function readBaseline(): {readonly baseline: U1Baseline; readonly raw: string} {
  const raw = readFileSync(BASELINE_URL, 'utf8')
  return {baseline: JSON.parse(raw) as U1Baseline, raw}
}

function expectExactKeys(value: object, expectedKeys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...expectedKeys].sort())
}

function expectNonNegativeFiniteNumber(value: number): void {
  expect(Number.isFinite(value)).toBe(true)
  expect(value).toBeGreaterThanOrEqual(0)
}

describe('U1 committed baseline integrity', () => {
  it('contains only the reviewed outcome and provenance reference', () => {
    // #given the committed baseline artifact
    const {baseline, raw} = readBaseline()

    // #then the top-level shape contains only the sanitized schema sections
    expectExactKeys(baseline, ['schemaVersion', 'sourceRun', 'runtime', 'scenarios'])
    expect(baseline.schemaVersion).toBe(1)
    expectExactKeys(baseline.sourceRun, [
      'runId',
      'corpusHeadSha',
      'startedAt',
      'completedAt',
      'completionMarker',
      'suiteVerdict',
    ])
    expect(baseline.sourceRun).toEqual({
      runId: '7a99a05c-b589-4707-b916-e2e1e56edab8',
      corpusHeadSha: '2e58f3bd662b0102d853ffae7d2f0bcf0bf4be71',
      startedAt: '2026-08-08T23:40:14.169Z',
      completedAt: '2026-08-08T23:46:45.804Z',
      completionMarker: 'fro-bot-eval-report-complete-v1',
      suiteVerdict: 'passed',
    })
    expectExactKeys(baseline.runtime, ['model', 'openCodeVersion', 'pluginVersions', 'configuredTimeoutMs'])
    expect(baseline.runtime).toEqual({
      model: 'anthropic/claude-sonnet-5',
      openCodeVersion: '1.18.14+harness.202732ae',
      pluginVersions: EXPECTED_PLUGIN_VERSIONS,
      configuredTimeoutMs: 600_000,
    })

    // #then scenarios retain registry order and exact stable provenance from the source report
    expect(baseline.scenarios).toHaveLength(ALL_SCENARIOS.length)
    expect(baseline.scenarios.map(scenario => scenario.id)).toEqual(ALL_SCENARIOS.map(scenario => scenario.id))
    expect(baseline.scenarios.map(scenario => scenario.id)).toEqual(EXPECTED_SCENARIO_PROVENANCE.map(item => item.id))
    for (const expected of EXPECTED_SCENARIO_PROVENANCE) {
      const scenario = baseline.scenarios.find(candidate => candidate.id === expected.id)
      if (scenario == null) {
        throw new Error(`Missing baseline scenario: ${expected.id}`)
      }

      expectExactKeys(scenario, [
        'id',
        'promptHash',
        'scenarioCommitSha',
        'state',
        'durationMs',
        'cost',
        'executionDurationMs',
        'tokenUsage',
        'passedGateIds',
      ])
      expect(scenario.promptHash).toBe(expected.promptHash)
      expect(scenario.scenarioCommitSha).toBe(expected.scenarioCommitSha)
      expect(scenario.state).toBe('passed')
      expectNonNegativeFiniteNumber(scenario.durationMs)
      expect(scenario.cost === null || Number.isFinite(scenario.cost)).toBe(true)
      expect(scenario.cost === null || scenario.cost >= 0).toBe(true)
      expectNonNegativeFiniteNumber(scenario.executionDurationMs)
      expectExactKeys(scenario.tokenUsage, ['input', 'output', 'reasoning', 'cache'])
      expectNonNegativeFiniteNumber(scenario.tokenUsage.input)
      expectNonNegativeFiniteNumber(scenario.tokenUsage.output)
      expectNonNegativeFiniteNumber(scenario.tokenUsage.reasoning)
      expectExactKeys(scenario.tokenUsage.cache, ['read', 'write'])
      expectNonNegativeFiniteNumber(scenario.tokenUsage.cache.read)
      expectNonNegativeFiniteNumber(scenario.tokenUsage.cache.write)
      expect(scenario.passedGateIds).toEqual(EXPECTED_PASSED_GATE_IDS)
    }

    // #then no failed or unevaluated gate data can be hidden in the compact representation
    expect(raw).not.toMatch(/failed|not-evaluated/i)

    // #then raw responses, diagnostics, auth material, paths, and credential-shaped values are absent
    expect(raw).not.toMatch(/diagnosticsPath|response\.md|canary|rawResponse|agentResult|auth\.json/i)
    expect(raw).not.toContain('/Users/')
    expect(raw).not.toMatch(
      /(?:sk|rk|ghp|gho|ghs|ghu|ghr|github_pat|xox[baprs])[-_][\w-]{8,}|Bearer\s+[\w.~+/=-]{8,}|-----BEGIN [A-Z ]+ PRIVATE KEY-----/i,
    )
  })
})
