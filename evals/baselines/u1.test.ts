import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {ALL_SCENARIOS} from '../scenarios/index.js'

interface BaselineScenario {
  readonly id: string
  readonly promptHash: string
  readonly scenarioCommitSha: string
  readonly state: 'passed'
  readonly passedGateIds: readonly string[]
}

interface U1Baseline {
  readonly schemaVersion: 1
  readonly sourceRun: {
    readonly corpusHeadSha: string
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
    promptHash: '48d15b4fd97bf026d20fb03bca19314a58b3031278a126d2cf56fc90ccdac7ac',
    scenarioCommitSha: '62a462da9bb73b8b97f9e0cd44e8252ceda3f978',
  },
  {
    id: 'planted-defect',
    promptHash: '0d5990b3d28f6d7cb9337058c80ac28daf5627a3fbb1b1d7be2da6bb0d37acb4',
    scenarioCommitSha: '61f263fd5706ff26297d09bc247b8e82046e658d',
  },
  {
    id: 'issue-known-files',
    promptHash: 'ee155352b166322796402585b374008e7f3a5d021d9ad00832c6b2425ea92609',
    scenarioCommitSha: '07a4cc53a1c110b6432d6228c63011c8d210b847',
  },
  {
    id: 'continuation-relevant',
    promptHash: '09a2503aef5fe4b3e2dffab36ccea61a6ee1cd8ed293de5a403d00bd316b6e62',
    scenarioCommitSha: 'c4fa14cfe1b2e137d5813c356412a58e24523584',
  },
  {
    id: 'continuation-irrelevant-non-degradation',
    promptHash: '6dea1071c92f3748a1e19843e0604a960084b7d60d42ac233d27d2cbc261a809',
    scenarioCommitSha: 'c4fa14cfe1b2e137d5813c356412a58e24523584',
  },
  {
    id: 'unchanged-constraint-violation',
    promptHash: '68b5219165c34ea7d77988931f2eb01757bee57e6de32723e6f69f92feaa6218',
    scenarioCommitSha: 'c6c546c63c2df8b16bb5c112f909d1c685e55ba4',
  },
] as const

function readBaseline(): {readonly baseline: U1Baseline; readonly raw: string} {
  const raw = readFileSync(BASELINE_URL, 'utf8')
  return {baseline: JSON.parse(raw) as U1Baseline, raw}
}

function expectExactKeys(value: object, expectedKeys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...expectedKeys].sort())
}

describe('U1 committed baseline integrity', () => {
  it('contains only the reviewed outcome and provenance reference', () => {
    // #given the committed baseline artifact
    const {baseline, raw} = readBaseline()

    // #then the top-level shape contains only the sanitized schema sections
    expectExactKeys(baseline, ['schemaVersion', 'sourceRun', 'runtime', 'scenarios'])
    expect(baseline.schemaVersion).toBe(1)
    expectExactKeys(baseline.sourceRun, ['corpusHeadSha', 'completionMarker', 'suiteVerdict'])
    expect(baseline.sourceRun).toEqual({
      corpusHeadSha: '2e58f3bd662b0102d853ffae7d2f0bcf0bf4be71',
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

      expectExactKeys(scenario, ['id', 'promptHash', 'scenarioCommitSha', 'state', 'passedGateIds'])
      expect(scenario.promptHash).toBe(expected.promptHash)
      expect(scenario.scenarioCommitSha).toBe(expected.scenarioCommitSha)
      expect(scenario.state).toBe('passed')
      expect(scenario.passedGateIds).toEqual(EXPECTED_PASSED_GATE_IDS)
    }

    // #then no failed or unevaluated gate data can be hidden in the compact representation
    expect(raw).not.toMatch(/failed|not-evaluated/i)

    // #then raw responses, diagnostics, auth material, paths, and credential-shaped values are absent
    expect(raw).not.toMatch(
      /diagnosticsPath|response\.md|canary|rawResponse|agentResult|auth\.json|durationMs|executionDurationMs|cost|tokenUsage|startedAt|updatedAt|runId/i,
    )
    expect(raw).not.toContain('/Users/')
    expect(raw).not.toMatch(
      /(?:sk|rk|ghp|gho|ghs|ghu|ghr|github_pat|xox[baprs])[-_][\w-]{8,}|Bearer\s+[\w.~+/=-]{8,}|-----BEGIN [A-Z ]+ PRIVATE KEY-----/i,
    )
  })
})
