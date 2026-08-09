import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {createLogger} from '../../src/shared/logger.js'
import {buildDeterministicScenarioProvenance} from '../runner.js'
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

function readBaseline(): {readonly baseline: U1Baseline; readonly raw: string} {
  const raw = readFileSync(BASELINE_URL, 'utf8')
  return {baseline: JSON.parse(raw) as U1Baseline, raw}
}

function expectExactKeys(value: object, expectedKeys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...expectedKeys].sort())
}

describe('U1 committed baseline integrity', () => {
  it('matches live scenario provenance in registry order', () => {
    // #given the committed baseline and the live scenario registry
    const {baseline} = readBaseline()
    const provenanceLogger = createLogger({component: 'u1-baseline-provenance-test'})
    const liveProvenance = ALL_SCENARIOS.map(scenario =>
      buildDeterministicScenarioProvenance(scenario, provenanceLogger),
    )

    // #then every registry entry matches the baseline's prompt and fixture provenance
    for (const [index, scenario] of ALL_SCENARIOS.entries()) {
      const baselineScenario = baseline.scenarios[index]
      const provenance = liveProvenance[index]
      if (baselineScenario == null || provenance == null) {
        throw new Error(`Missing baseline or live provenance for scenario: ${scenario.id}`)
      }

      expect(
        provenance.promptHash,
        `Scenario ${scenario.id} promptHash drift: baseline=${baselineScenario.promptHash}, live=${provenance.promptHash}`,
      ).toBe(baselineScenario.promptHash)
      expect(
        provenance.scenarioCommitSha,
        `Scenario ${scenario.id} scenarioCommitSha drift: baseline=${baselineScenario.scenarioCommitSha}, live=${provenance.scenarioCommitSha}`,
      ).toBe(baselineScenario.scenarioCommitSha)
    }
  })

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
    for (const scenario of baseline.scenarios) {
      expectExactKeys(scenario, ['id', 'promptHash', 'scenarioCommitSha', 'state', 'passedGateIds'])
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
