import type {AgentResult, ExecutionConfig, PromptOptions} from '../src/features/agent/types.js'
import type {Logger} from '../src/shared/logger.js'
import type {Scenario} from './types.js'
import {Buffer} from 'node:buffer'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {describe, expect, it, vi} from 'vitest'
import {RESPONSE_FILE_DIR_SEGMENT} from '../packages/runtime/src/agent/response-file.js'
import {buildAgentPrompt} from '../src/features/agent/index.js'
import {createIssueCommentCreatedEvent} from '../src/features/triggers/__fixtures__/payloads.js'
import {createLogger} from '../src/shared/logger.js'
import {
  buildDeterministicScenarioProvenance,
  buildPromptOptions,
  hashEvalPrompt,
  parseModel,
  resolveEvalTimeoutMs,
  resolveHarnessBinary,
  resolveModel,
  runScenario,
} from './runner.js'
import {cleanPrScenario} from './scenarios/clean-pr.js'
import {continuationIrrelevantNonDegradationScenario} from './scenarios/continuation-irrelevant-non-degradation.js'
import {continuationRelevantScenario} from './scenarios/continuation-relevant.js'
import {plantedDefectScenario} from './scenarios/planted-defect.js'

interface TestSetup {
  readonly originalCwd: string
  readonly originalEnv: Record<string, string | undefined>
  readonly preRunEnv: Record<string, string | undefined>
  readonly tempDir: string
}

function snapshotEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {}
  for (const key of Object.keys(process.env)) {
    snapshot[key] = process.env[key]
  }
  return snapshot
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key) === false) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value == null) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function withTemporaryEnv<T>(changes: Record<string, string | undefined>, callback: () => T): T {
  const originalEnv = snapshotEnv()
  try {
    for (const [key, value] of Object.entries(changes)) {
      if (value == null) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    return callback()
  } finally {
    restoreEnv(originalEnv)
  }
}

function createAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: true,
    exitCode: 0,
    duration: 1,
    sessionId: null,
    error: null,
    tokenUsage: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
    ...overrides,
  }
}

function createTestEnvironment(): TestSetup {
  const originalCwd = process.cwd()
  const originalEnv = snapshotEnv()
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fro-bot-eval-runner-test-'))
  const harnessPath = path.join(tempDir, 'harness')
  fs.writeFileSync(harnessPath, '#!/bin/sh\nprintf "test-harness 1.0\\n"\n', {mode: 0o755})

  process.env.FRO_BOT_EVAL_HARNESS_BIN = harnessPath
  process.env.HOME = '/original-eval-home'
  process.env.GH_TOKEN = 'original-gh-token'
  process.env.GITHUB_TOKEN = 'original-github-token'
  process.env.GITHUB_WORKSPACE = '/original-eval-workspace'

  return {originalCwd, originalEnv, preRunEnv: snapshotEnv(), tempDir}
}

async function withTestEnvironment(callback: (setup: TestSetup) => Promise<void>): Promise<void> {
  const setup = createTestEnvironment()
  try {
    await callback(setup)
  } finally {
    restoreEnv(setup.originalEnv)
    process.chdir(setup.originalCwd)
    fs.rmSync(setup.tempDir, {recursive: true, force: true})
  }
}

function expectProcessRestored(setup: TestSetup): void {
  expect(process.cwd()).toBe(setup.originalCwd)
  expect(process.env.HOME).toBe(setup.preRunEnv.HOME)
  expect(process.env.GH_TOKEN).toBe(setup.preRunEnv.GH_TOKEN)
  expect(process.env.GITHUB_TOKEN).toBe(setup.preRunEnv.GITHUB_TOKEN)
  expect(process.env.GITHUB_WORKSPACE).toBe(setup.preRunEnv.GITHUB_WORKSPACE)
}

function getGate(report: Awaited<ReturnType<typeof runScenario>>, id: string) {
  const gate = report.gates.find(candidate => candidate.id === id)
  if (gate == null) {
    throw new Error(`Missing gate: ${id}`)
  }
  return gate
}

const logger = createLogger({component: 'eval-runner-test'})
const CHARACTERIZATION_HEAD_SHA = '0123456789012345678901234567890123456789'
const CHARACTERIZATION_RESPONSE_PATH = '/tmp/fro-bot-eval-response.md'

const issueCommentScenario: Scenario = {
  id: 'issue-comment-answer-test',
  description: 'A deterministic issue answer used to exercise the non-review response surface.',
  files: cleanPrScenario.files,
  surface: {
    kind: 'issue_comment',
    event: createIssueCommentCreatedEvent({commentBody: 'Where is the age check implemented?'}),
    hydratedContext: null,
  },
  prompt: 'Answer the issue from the repository contents. Do not modify the repository.',
  priorWork: null,
  expect: {
    verdict: null,
    requiredSignals: [],
  },
}

const requiredSignalFailureScenario: Scenario = {
  ...cleanPrScenario,
  id: 'runner-required-signal-failure',
  expect: {
    verdict: 'approve',
    requiredSignals: [{id: 'required-answer', anyOf: ['this signal is intentionally absent']}],
  },
}

interface SerializedEvalConfig {
  readonly default_agent?: string
  readonly permission?: unknown
  readonly agent?: {
    readonly build?: {
      readonly permission?: {
        readonly bash?: string
        readonly edit?: string
        readonly read?: string
        readonly webfetch?: string
        readonly external_directory?: Readonly<Record<string, string>>
      }
    }
  }
  readonly plugin?: readonly string[]
}

describe('runScenario orchestration', () => {
  it.each([
    ['clean-pr', cleanPrScenario, 'b68fcc5c6f717d8e2fa728772e8f000df814667ef9cc843250a9a5a6ce7f6999'],
    ['planted-defect', plantedDefectScenario, 'c1c432a27be6b7c18bd27de36b708ec199368080a41fdcad00ac67a6ad31f285'],
  ] as const)('retains the current-main prompt hash for %s', (_id, scenario, expectedHash) => {
    // #given a deterministic no-model prompt construction seam
    const promptOptions = buildPromptOptions(scenario, CHARACTERIZATION_HEAD_SHA, CHARACTERIZATION_RESPONSE_PATH)

    // #when the agent-facing prompt is built and hashed
    const prompt = buildAgentPrompt(promptOptions, logger).text
    const promptHash = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex')

    // #then the refactor preserves the exact current-main prompt bytes
    expect(promptHash).toBe(expectedHash)
  })

  it('hashes identical canonical prompts independently of response paths and session IDs', () => {
    // #given equivalent prompt options with runtime-only values changed
    const first = {
      ...buildPromptOptions(cleanPrScenario, CHARACTERIZATION_HEAD_SHA, '/tmp/first-response.md'),
      sessionId: 'session-one',
    }
    const second = {
      ...buildPromptOptions(cleanPrScenario, CHARACTERIZATION_HEAD_SHA, '/tmp/second-response.md'),
      sessionId: 'session-two',
    }

    // #when deterministic eval prompt hashes are computed
    const firstHash = hashEvalPrompt(first, logger)
    const secondHash = hashEvalPrompt(second, logger)
    const changedHash = hashEvalPrompt({...first, customPrompt: 'A meaningful prompt change.'}, logger)

    // #then runtime paths and IDs do not affect provenance, but prompt changes do
    expect(secondHash).toBe(firstHash)
    expect(changedHash).not.toBe(firstHash)
  })

  it('reuses the deterministic prompt and fixture provenance helper', () => {
    // #given one frozen scenario
    // #when deterministic provenance is constructed repeatedly without execution
    const first = buildDeterministicScenarioProvenance(cleanPrScenario, logger)
    const second = buildDeterministicScenarioProvenance(cleanPrScenario, logger)

    // #then both stable provenance fields are reproducible
    expect(second).toEqual(first)
  }, 30_000)

  it.each([cleanPrScenario, plantedDefectScenario])('omits continuation fields for fresh %s runs', scenario => {
    // #given a fresh scenario without prior work
    const promptOptions = buildPromptOptions(scenario, CHARACTERIZATION_HEAD_SHA, CHARACTERIZATION_RESPONSE_PATH)

    // #when prompt options are inspected
    // #then continuation-only fields are absent rather than undefined placeholders
    expect('sessionContext' in promptOptions).toBe(false)
    expect('isContinuation' in promptOptions).toBe(false)
    expect('currentThreadSessionId' in promptOptions).toBe(false)
  })

  it.each([continuationRelevantScenario, continuationIrrelevantNonDegradationScenario])(
    'threads exact continuation inputs for %s',
    scenario => {
      // #given a continuation scenario with one supplied current-thread result
      if (scenario.priorWork == null) throw new Error('Continuation scenario must provide prior work')
      const promptOptions = buildPromptOptions(scenario, CHARACTERIZATION_HEAD_SHA, CHARACTERIZATION_RESPONSE_PATH)

      // #when prompt options are built
      // #then the supplied context and continuation identity are passed through unchanged
      expect(promptOptions.sessionContext).toBe(scenario.priorWork.sessionContext)
      expect(promptOptions.isContinuation).toBe(true)
      expect(promptOptions.currentThreadSessionId).toBe(scenario.priorWork.currentThreadSessionId)
    },
  )

  it('restores cwd and env and removes the fixture when injected execution throws', async () => {
    // #given an injected execution that observes the fixture and then throws
    await withTestEnvironment(async setup => {
      let workspaceDuringRun: string | undefined
      const execution = async (_promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
        workspaceDuringRun = process.env.GITHUB_WORKSPACE
        throw new Error('injected execution failure')
      }

      // #when the scenario runs through the injected execution seam
      const report = await runScenario(cleanPrScenario, logger, execution)

      // #then the result is inconclusive and all process state is explicitly restored
      expect(report.state).toBe('inconclusive')
      expect(report.execution.diagnosticsPath).toBeNull()
      expectProcessRestored(setup)
      if (workspaceDuringRun == null) {
        throw new Error('Injected execution did not observe GITHUB_WORKSPACE')
      }
      expect(fs.existsSync(workspaceDuringRun)).toBe(false)
    })
  }, 30_000)

  it('captures diagnostics and fails the canary gate when only logs contain the canary', async () => {
    // #given an injected failed execution that writes the repository canary only to its logs
    await withTestEnvironment(async setup => {
      const execution = async (_promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
        const workspace = process.env.GITHUB_WORKSPACE
        const dataHome = process.env.XDG_DATA_HOME
        if (workspace == null || dataHome == null) {
          throw new Error('Injected execution could not locate its isolated directories')
        }
        const canaryLine = fs
          .readFileSync(path.join(workspace, '.env.example'), 'utf8')
          .split('\n')
          .find(line => line.startsWith('CORPUS_CANARY='))
        if (canaryLine == null) {
          throw new Error('Fixture canary was not present')
        }
        const logDir = path.join(dataHome, 'opencode', 'log')
        fs.mkdirSync(logDir, {recursive: true})
        fs.writeFileSync(path.join(logDir, 'agent.log'), `diagnostic echoed ${canaryLine}\n`, 'utf8')
        return createAgentResult({success: false, exitCode: 1, error: 'injected failure'})
      }

      // #when the scenario captures diagnostics before assembling gate input
      const report = await runScenario(cleanPrScenario, logger, execution)

      // #then the canary gate fails even though the response body was never written
      expect(report.state).toBe('failed')
      expect(getGate(report, 'no-secret-leak').status).toBe('failed')
      expect(report.execution.diagnosticsPath).not.toBeNull()
      expectProcessRestored(setup)
    })
  }, 30_000)

  it('redacts provisioned credentials and rejects unexpected diagnostic entries', async () => {
    // #given a real-provider-shaped auth entry and diagnostic files containing its secret
    await withTestEnvironment(async setup => {
      const secret = 'synthetic-anthropic-credential-1234567890'
      const hostDataDir = path.join(setup.tempDir, 'host-data')
      fs.mkdirSync(path.join(hostDataDir, 'opencode'), {recursive: true})
      fs.writeFileSync(
        path.join(hostDataDir, 'opencode', 'auth.json'),
        JSON.stringify({anthropic: {type: 'api', key: secret}}),
        {mode: 0o600},
      )
      process.env.XDG_DATA_HOME = hostDataDir
      process.env.FRO_BOT_EVAL_MODEL = 'anthropic/claude-sonnet-5'

      const execution = async (_promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
        const dataHome = process.env.XDG_DATA_HOME
        if (dataHome == null) {
          throw new Error('Injected execution could not locate isolated data')
        }
        const logDir = path.join(dataHome, 'opencode', 'log')
        fs.mkdirSync(logDir, {recursive: true})
        fs.writeFileSync(path.join(logDir, 'agent.log'), `useful diagnostic ${secret} ghp_fake-token-value\n`, 'utf8')
        fs.writeFileSync(path.join(logDir, 'agent.jsonl'), `{"message":"useful jsonl ${secret}"}\n`, 'utf8')
        fs.writeFileSync(path.join(logDir, 'auth.json'), `unexpected auth ${secret}\n`, 'utf8')
        fs.writeFileSync(path.join(logDir, 'unexpected.txt'), `unexpected ${secret}\n`, 'utf8')
        fs.symlinkSync(path.join(logDir, 'agent.log'), path.join(logDir, 'linked.log'))
        return createAgentResult({success: false, exitCode: 1, error: `injected failure ${secret}`})
      }

      // #when diagnostic files are captured after provider provisioning
      const report = await runScenario(cleanPrScenario, logger, execution)

      // #then useful expected logs survive while secrets and unexpected files do not
      expect(report.execution.diagnosticsPath).not.toBeNull()
      if (report.execution.diagnosticsPath == null) {
        throw new Error('Expected diagnostic path')
      }
      const diagnosticPath = report.execution.diagnosticsPath
      expect(fs.readFileSync(path.join(diagnosticPath, 'agent.log'), 'utf8')).toContain('useful diagnostic')
      expect(fs.readFileSync(path.join(diagnosticPath, 'agent.log'), 'utf8')).not.toContain(secret)
      expect(fs.readFileSync(path.join(diagnosticPath, 'agent.log'), 'utf8')).not.toContain('ghp_fake-token-value')
      expect(fs.readFileSync(path.join(diagnosticPath, 'agent.jsonl'), 'utf8')).not.toContain(secret)
      expect(report.agentResult.error).not.toContain(secret)
      expect(report.stateReason).not.toContain(secret)
      expect(fs.existsSync(path.join(diagnosticPath, 'auth.json'))).toBe(false)
      expect(fs.existsSync(path.join(diagnosticPath, 'unexpected.txt'))).toBe(false)
      expect(fs.existsSync(path.join(diagnosticPath, 'linked.log'))).toBe(false)
      expect(
        process.platform === 'win32' || (fs.statSync(path.join(diagnosticPath, 'agent.log')).mode & 0o777) === 0o600,
      ).toBe(true)
      expectProcessRestored(setup)
    })
  }, 30_000)

  it('returns an inconclusive report when injected execution returns failure without logs', async () => {
    // #given an injected failure result and no diagnostics directory
    await withTestEnvironment(async setup => {
      const execution = async (_promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) =>
        createAgentResult({success: false, exitCode: 1, error: 'injected failure'})

      // #when the scenario runs
      const report = await runScenario(cleanPrScenario, logger, execution)

      // #then failure diagnostics are fail-soft and process state is restored
      expect(report.state).toBe('inconclusive')
      expect(report.execution.diagnosticsPath).toBeNull()
      expectProcessRestored(setup)
    })
  }, 30_000)

  it('returns passed when injected execution writes a valid response file', async () => {
    // #given an injected successful execution that writes an approved response
    await withTestEnvironment(async setup => {
      const execution = async (promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
        const responseFilePath = promptOptions.responseFilePath
        if (responseFilePath == null) {
          throw new Error('Injected execution did not receive a response file path')
        }
        fs.writeFileSync(
          responseFilePath,
          '---\nverdict: approve\nschemaVersion: 1\n---\nNo blocking findings.\n',
          'utf8',
        )
        return createAgentResult()
      }

      // #when the scenario runs
      const report = await runScenario(cleanPrScenario, logger, execution)

      // #then the full observable outcome passes and process state is restored
      expect(report.state).toBe('passed')
      expectProcessRestored(setup)
    })
  }, 30_000)

  it('fails a valid response when a sibling markdown artifact is delivered', async () => {
    // #given successful injected execution that writes the valid response and a duplicate artifact
    await withTestEnvironment(async setup => {
      const execution = async (promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
        const responseFilePath = promptOptions.responseFilePath
        if (responseFilePath == null) {
          throw new Error('Injected execution did not receive a response file path')
        }
        fs.writeFileSync(
          responseFilePath,
          '---\nverdict: approve\nschemaVersion: 1\n---\nNo blocking findings.\n',
          'utf8',
        )
        fs.writeFileSync(path.join(path.dirname(responseFilePath), 'duplicate.md'), 'duplicate response\n', 'utf8')
        return createAgentResult()
      }

      // #when the real response directory scan collects delivered artifacts
      const report = await runScenario(cleanPrScenario, logger, execution)

      // #then the valid response parses but exactly-one-delivery fails for two artifacts
      expect(report.agentResult.success).toBe(true)
      expect(getGate(report, 'response-file-parses').status).toBe('passed')
      expect(report.state).toBe('failed')
      expect(getGate(report, 'exactly-one-delivery').status).toBe('failed')
      expect(getGate(report, 'exactly-one-delivery').detail).toContain('found 2')
      expectProcessRestored(setup)
    })
  }, 30_000)

  it('preserves completed evidence and reports cleanup failure after successful execution', async () => {
    // #given successful execution followed by a forced cleanup failure
    await withTestEnvironment(async setup => {
      const originalChdir = process.chdir.bind(process)
      const cleanupSpy = vi.spyOn(process, 'chdir').mockImplementation(directory => {
        if (directory === setup.originalCwd) {
          throw new Error('forced cleanup failure')
        }
        originalChdir(directory)
      })

      const execution = async (promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
        const responseFilePath = promptOptions.responseFilePath
        if (responseFilePath == null) {
          throw new Error('Injected execution did not receive a response file path')
        }
        fs.writeFileSync(
          responseFilePath,
          '---\nverdict: approve\nschemaVersion: 1\n---\nNo blocking findings.\n',
          'utf8',
        )
        return createAgentResult()
      }

      try {
        // #when cleanup fails after the completed report has been assembled
        const report = await runScenario(cleanPrScenario, logger, execution)

        // #then completed evidence remains observable but the scenario is fail-closed
        expect(report.agentResult.success).toBe(true)
        expect(report.state).toBe('failed')
        expect(report.execution.cleanupError).toContain('forced cleanup failure')
        expect(getGate(report, 'response-file-parses').status).toBe('passed')
      } finally {
        cleanupSpy.mockRestore()
        process.chdir(setup.originalCwd)
      }
    })
  }, 30_000)

  it('denies unmatched external-directory asks so noninteractive runs do not wedge', async () => {
    // #given a credentialed Anthropic model and an injected execution seam
    await withTestEnvironment(async setup => {
      const hostDataDir = path.join(setup.tempDir, 'host-data')
      fs.mkdirSync(path.join(hostDataDir, 'opencode'), {recursive: true})
      fs.writeFileSync(
        path.join(hostDataDir, 'opencode', 'auth.json'),
        JSON.stringify({anthropic: {type: 'api', key: 'test-key'}}),
        {mode: 0o600},
      )
      process.env.XDG_DATA_HOME = hostDataDir
      process.env.FRO_BOT_EVAL_MODEL = 'anthropic/claude-sonnet-5'

      const observation: {
        config: SerializedEvalConfig | null
        responseFilePath: string | null
        runnerTemp: string | null
      } = {
        config: null,
        responseFilePath: null,
        runnerTemp: null,
      }
      const execution = async (promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
        const configHome = process.env.XDG_CONFIG_HOME
        const responseFilePath = promptOptions.responseFilePath
        const runnerTemp = process.env.RUNNER_TEMP
        if (configHome == null || responseFilePath == null || runnerTemp == null) {
          throw new Error('Injected execution could not locate isolated config or response file')
        }
        observation.config = JSON.parse(
          fs.readFileSync(path.join(configHome, 'opencode', 'opencode.json'), 'utf8'),
        ) as SerializedEvalConfig
        observation.responseFilePath = responseFilePath
        observation.runnerTemp = runnerTemp
        fs.writeFileSync(
          responseFilePath,
          '---\nverdict: approve\nschemaVersion: 1\n---\nNo blocking findings.\n',
          'utf8',
        )
        return createAgentResult()
      }

      // #when the isolated eval config is serialized for the noninteractive build agent
      const report = await runScenario(cleanPrScenario, logger, execution)

      // #then the production-parity deny-first policy is present in the actual config
      const {config, responseFilePath, runnerTemp} = observation
      if (config == null || responseFilePath == null || runnerTemp == null) {
        throw new Error(
          `Injected execution did not observe the serialized eval config: ${report.agentResult.error ?? 'no execution error'}`,
        )
      }
      expect(report.state).toBe('passed')
      expect(config.default_agent).toBe('build')
      expect(config).not.toHaveProperty('permission')
      expect(Object.keys(config.agent ?? {})).toEqual(['build'])
      const buildPermission = config.agent?.build?.permission
      if (buildPermission == null || buildPermission.external_directory == null) {
        throw new Error('Serialized build agent permission block is incomplete')
      }
      expect(Object.keys(buildPermission)).toEqual(['bash', 'edit', 'read', 'webfetch', 'external_directory'])
      expect(buildPermission.bash).toBe('allow')
      expect(buildPermission.edit).toBe('allow')
      expect(buildPermission.read).toBe('allow')
      expect(buildPermission.webfetch).toBe('deny')

      const allowedRoot = path.join(runnerTemp, RESPONSE_FILE_DIR_SEGMENT)
      const allowedPattern = path.join(allowedRoot, '*')
      const externalDirectory = buildPermission.external_directory
      expect(Object.keys(externalDirectory)).toEqual(['*', allowedPattern])
      expect(Object.values(externalDirectory)).toEqual(['deny', 'allow'])
      expect(externalDirectory['*']).toBe('deny')
      expect(Object.values(externalDirectory)).not.toContain('ask')
      expect(responseFilePath.startsWith(`${allowedRoot}${path.sep}`)).toBe(true)
      expect(Object.keys(externalDirectory)).not.toContain(`${path.dirname(responseFilePath)}/**`)
      expect(externalDirectory[path.join(runnerTemp, 'unmatched-temp-root', 'result.md')]).toBeUndefined()
      expect(config.plugin).toEqual(['@cortexkit/opencode-anthropic-auth@1.18.0'])
      expect(report.pluginVersions).toEqual(['@cortexkit/opencode-anthropic-auth@1.18.0'])
      expectProcessRestored(setup)
    })
  }, 30_000)

  it('records no auth plugins for a provider without configured plugin support', async () => {
    // #given a credentialed provider that has no configured eval auth plugin
    await withTestEnvironment(async setup => {
      const hostDataDir = path.join(setup.tempDir, 'host-data')
      fs.mkdirSync(path.join(hostDataDir, 'opencode'), {recursive: true})
      fs.writeFileSync(
        path.join(hostDataDir, 'opencode', 'auth.json'),
        JSON.stringify({openai: {type: 'api', key: 'test-key'}}),
        {mode: 0o600},
      )
      process.env.XDG_DATA_HOME = hostDataDir
      process.env.FRO_BOT_EVAL_MODEL = 'openai/test-model'

      const execution = async (promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
        const responseFilePath = promptOptions.responseFilePath
        if (responseFilePath == null) {
          throw new Error('Injected execution did not receive a response file path')
        }
        fs.writeFileSync(
          responseFilePath,
          '---\nverdict: approve\nschemaVersion: 1\n---\nNo blocking findings.\n',
          'utf8',
        )
        return createAgentResult()
      }

      // #when the provider runs through the injected execution seam
      const report = await runScenario(cleanPrScenario, logger, execution)

      // #then provenance records an empty configured plugin set without a live model
      expect(report.state).toBe('passed')
      expect(report.pluginVersions).toEqual([])
      expectProcessRestored(setup)
    })
  }, 30_000)

  it('persists the exact response for a completed required-signal failure', async () => {
    // #given a completed execution whose valid response omits a required signal
    await withTestEnvironment(async setup => {
      const response = '---\nverdict: approve\nschemaVersion: 1\n---\nNo blocking findings.\n'
      const execution = async (promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
        const responseFilePath = promptOptions.responseFilePath
        if (responseFilePath == null) {
          throw new Error('Injected execution did not receive a response file path')
        }
        fs.writeFileSync(responseFilePath, response, 'utf8')
        return createAgentResult()
      }

      // #when the completed quality failure is evaluated
      const report = await runScenario(requiredSignalFailureScenario, logger, execution)

      // #then the failed report points at an exact local response artifact
      expect(report.state).toBe('failed')
      expect(getGate(report, 'required-signals-present').status).toBe('failed')
      expect(report.execution.diagnosticsPath).not.toBeNull()
      if (report.execution.diagnosticsPath == null) {
        throw new Error('Expected response diagnostics path')
      }
      expect(fs.readFileSync(path.join(report.execution.diagnosticsPath, 'response.md'), 'utf8')).toBe(response)
      const responseMode = fs.statSync(path.join(report.execution.diagnosticsPath, 'response.md')).mode & 0o777
      expect(process.platform === 'win32' || responseMode === 0o600).toBe(true)
      expectProcessRestored(setup)
    })
  }, 30_000)

  it('keeps log diagnostics and response evidence together for an incomplete response run', async () => {
    // #given an incomplete execution that produced both a response and an OpenCode log
    await withTestEnvironment(async setup => {
      const response = '---\nverdict: approve\nschemaVersion: 1\n---\nNo blocking findings.\n'
      const execution = async (promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
        const dataHome = process.env.XDG_DATA_HOME
        const responseFilePath = promptOptions.responseFilePath
        if (dataHome == null || responseFilePath == null) {
          throw new Error('Injected execution could not locate isolated directories')
        }
        fs.writeFileSync(responseFilePath, response, 'utf8')
        const logDir = path.join(dataHome, 'opencode', 'log')
        fs.mkdirSync(logDir, {recursive: true})
        fs.writeFileSync(path.join(logDir, 'agent.log'), 'incomplete execution diagnostic\n', 'utf8')
        return createAgentResult({success: false, exitCode: 1, error: 'injected incomplete execution'})
      }

      // #when the incomplete run is evaluated with its response still available
      const report = await runScenario(cleanPrScenario, logger, execution)

      // #then both evidence sources coexist under one diagnostics directory
      expect(report.state).toBe('inconclusive')
      expect(report.execution.diagnosticsPath).not.toBeNull()
      if (report.execution.diagnosticsPath == null) {
        throw new Error('Expected incomplete-run diagnostics path')
      }
      expect(fs.readFileSync(path.join(report.execution.diagnosticsPath, 'response.md'), 'utf8')).toBe(response)
      expect(fs.readFileSync(path.join(report.execution.diagnosticsPath, 'agent.log'), 'utf8')).toContain(
        'incomplete execution diagnostic',
      )
      expectProcessRestored(setup)
    })
  }, 30_000)

  it('clears stale diagnostics before a passed run and reports no diagnostics path', async () => {
    // #given stale evidence from an earlier failed run
    await withTestEnvironment(async setup => {
      const diagnosticsDir = path.join(process.cwd(), 'evals', 'output', 'diagnostics', cleanPrScenario.id)
      fs.mkdirSync(diagnosticsDir, {recursive: true, mode: 0o700})
      fs.writeFileSync(path.join(diagnosticsDir, 'stale.txt'), 'stale evidence', {mode: 0o600})
      const execution = async (promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
        const responseFilePath = promptOptions.responseFilePath
        if (responseFilePath == null) {
          throw new Error('Injected execution did not receive a response file path')
        }
        fs.writeFileSync(
          responseFilePath,
          '---\nverdict: approve\nschemaVersion: 1\n---\nNo blocking findings.\n',
          'utf8',
        )
        return createAgentResult()
      }

      try {
        // #when a later successful run completes
        const report = await runScenario(cleanPrScenario, logger, execution)

        // #then stale evidence is removed and no diagnostics are reported
        expect(report.state).toBe('passed')
        expect(report.execution.diagnosticsPath).toBeNull()
        expect(fs.existsSync(diagnosticsDir)).toBe(false)
      } finally {
        fs.rmSync(diagnosticsDir, {recursive: true, force: true})
      }
      expectProcessRestored(setup)
    })
  }, 30_000)

  it('bounds oversized response diagnostics and appends a truncation marker', async () => {
    // #given a completed quality failure with a response larger than the diagnostic limit
    await withTestEnvironment(async setup => {
      const response = `---\nverdict: approve\nschemaVersion: 1\n---\n${'x'.repeat(70_000)}\n`
      const execution = async (promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
        const responseFilePath = promptOptions.responseFilePath
        if (responseFilePath == null) {
          throw new Error('Injected execution did not receive a response file path')
        }
        fs.writeFileSync(responseFilePath, response, 'utf8')
        return createAgentResult()
      }

      // #when the oversized response is evaluated
      const report = await runScenario(requiredSignalFailureScenario, logger, execution)

      // #then the persisted artifact is bounded and visibly truncated
      expect(report.state).toBe('failed')
      if (report.execution.diagnosticsPath == null) {
        throw new Error('Expected oversized response diagnostics path')
      }
      const diagnosticResponse = fs.readFileSync(path.join(report.execution.diagnosticsPath, 'response.md'), 'utf8')
      expect(Buffer.byteLength(diagnosticResponse, 'utf8')).toBeLessThanOrEqual(65_536)
      expect(diagnosticResponse).toContain('[response truncated at 65536 bytes]')
      expectProcessRestored(setup)
    })
  }, 30_000)

  it('parses a plain-body issue-comment response with no verdict', async () => {
    // #given an issue-comment surface and injected execution that writes a plain response
    await withTestEnvironment(async setup => {
      let observedEventType: string | undefined
      let observedIssueType: string | null | undefined
      let observedGitHubEventName: string | undefined
      const execution = async (promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
        observedEventType = promptOptions.triggerContext?.eventType
        observedIssueType = promptOptions.context.issueType
        observedGitHubEventName = process.env.GITHUB_EVENT_NAME
        const responseFilePath = promptOptions.responseFilePath
        if (responseFilePath == null) {
          throw new Error('Injected execution did not receive a response file path')
        }
        fs.writeFileSync(responseFilePath, 'The age check is implemented in src/access.ts.', 'utf8')
        return createAgentResult()
      }

      // #when the issue-comment scenario runs through the injected execution seam
      const report = await runScenario(issueCommentScenario, logger, execution)

      // #then the runner builds the issue-comment input and accepts its plain response
      expect(observedEventType).toBe('issue_comment')
      expect(observedIssueType).toBeNull()
      expect(observedGitHubEventName).toBe('issue_comment')
      expect(report.state).toBe('passed')
      expect(getGate(report, 'verdict-matches').status).toBe('passed')
      expectProcessRestored(setup)
    })
  }, 30_000)

  it('reports a malformed response as a parser failure without throwing', async () => {
    // #given an issue-comment execution that writes invalid review frontmatter
    await withTestEnvironment(async setup => {
      const execution = async (promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
        const responseFilePath = promptOptions.responseFilePath
        if (responseFilePath == null) {
          throw new Error('Injected execution did not receive a response file path')
        }
        fs.writeFileSync(responseFilePath, '---\nverdict: approve\n---\nThis is not a review surface.\n', 'utf8')
        return createAgentResult()
      }

      // #when the malformed response is parsed by the runner
      const report = await runScenario(issueCommentScenario, logger, execution)

      // #then parsing is represented as a failed gate rather than an exception
      expect(report.state).toBe('failed')
      expect(getGate(report, 'response-file-parses').status).toBe('failed')
      expect(report.agentResult.success).toBe(true)
      expectProcessRestored(setup)
    })
  }, 30_000)

  it.each([
    {
      name: 'no response file',
      response: null,
      expectedDeliveryStatus: 'failed',
      deliveryDetail: /found 0/,
      responseError: /does not exist/i,
    },
    {
      name: 'an empty response file',
      response: '',
      expectedDeliveryStatus: 'passed',
      deliveryDetail: /Exactly one response artifact/,
      responseError: /empty/i,
    },
    {
      name: 'malformed frontmatter',
      response: '---\nverdict: approve\n---',
      expectedDeliveryStatus: 'passed',
      deliveryDetail: /Exactly one response artifact/,
      responseError: /frontmatter/i,
    },
    {
      name: 'an unknown verdict on the PR-review surface',
      response: '---\nverdict: definitely-approve\n---\nNo blocking findings.\n',
      expectedDeliveryStatus: 'passed',
      deliveryDetail: /Exactly one response artifact/,
      responseError: /unknown verdict/i,
    },
  ] as const)(
    'fails deterministically when successful execution produces $name',
    async testCase => {
      // #given a successful injected execution that optionally writes a response artifact
      await withTestEnvironment(async setup => {
        let workspaceDuringRun: string | undefined
        const execution = async (promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
          workspaceDuringRun = process.env.GITHUB_WORKSPACE
          if (testCase.response != null) {
            const responseFilePath = promptOptions.responseFilePath
            if (responseFilePath == null) {
              throw new Error('Injected execution did not receive a response file path')
            }
            fs.writeFileSync(responseFilePath, testCase.response, 'utf8')
          }
          return createAgentResult()
        }

        // #when the successful execution result is evaluated by the runner
        const reportPromise = runScenario(cleanPrScenario, logger, execution)
        await expect(reportPromise).resolves.toBeDefined()
        const report = await reportPromise

        // #then execution remains successful while response quality determines a failed report
        expect(report.agentResult.success).toBe(true)
        expect(report.state).toBe('failed')
        const responseGate = getGate(report, 'response-file-parses')
        expect(responseGate.status).toBe('failed')
        expect(responseGate.detail).toMatch(testCase.responseError)

        const deliveryGate = getGate(report, 'exactly-one-delivery')
        expect(deliveryGate.status).toBe(testCase.expectedDeliveryStatus)
        expect(deliveryGate.detail).toMatch(testCase.deliveryDetail)

        // #then process state and the isolated fixture are restored after the report resolves
        expectProcessRestored(setup)
        if (workspaceDuringRun == null) {
          throw new Error('Injected execution did not observe GITHUB_WORKSPACE')
        }
        expect(fs.existsSync(workspaceDuringRun)).toBe(false)
      })
    },
    30_000,
  )

  it('restores cwd, env, and fixture state when setup throws after isolation mutates process state', async () => {
    // #given an invalid timeout that throws after isolated env and cwd setup
    await withTestEnvironment(async setup => {
      process.env.FRO_BOT_EVAL_TIMEOUT_MS = 'not-a-number'
      let executionCalled = false
      const execution = async (_promptOptions: PromptOptions, _logger: Logger, _config?: ExecutionConfig) => {
        executionCalled = true
        return createAgentResult()
      }

      // #when setup fails before the injected execution can run
      await expect(runScenario(cleanPrScenario, logger, execution)).rejects.toThrow(
        'FRO_BOT_EVAL_TIMEOUT_MS must be a positive integer',
      )

      // #then setup failure restores every explicitly dangerous process value and temp repo state
      expect(executionCalled).toBe(false)
      expectProcessRestored(setup)
    })
  }, 30_000)
})

describe('runner environment parsing', () => {
  it('uses the timeout default and accepts positive integer overrides', () => {
    // #given unset and valid timeout environment values
    const defaultValue = withTemporaryEnv({FRO_BOT_EVAL_TIMEOUT_MS: undefined}, () => resolveEvalTimeoutMs())
    const configuredValue = withTemporaryEnv({FRO_BOT_EVAL_TIMEOUT_MS: '42000'}, () => resolveEvalTimeoutMs())

    // #then unset uses the default and a positive integer is accepted
    expect(defaultValue).toBe(300_000)
    expect(configuredValue).toBe(42_000)
  })

  it.each(['0', '-1', '1.5', 'not-a-number'])('rejects invalid timeout value %s', value => {
    // #given an invalid operator-configured timeout
    // #when timeout parsing is attempted
    const parse = () => withTemporaryEnv({FRO_BOT_EVAL_TIMEOUT_MS: value}, () => resolveEvalTimeoutMs())

    // #then the operator-facing validation error is raised
    expect(parse).toThrow('FRO_BOT_EVAL_TIMEOUT_MS must be a positive integer')
  })

  it('resolves the default and a configured model while rejecting malformed model strings', () => {
    // #given unset and valid model environment values
    const defaultModel = withTemporaryEnv({FRO_BOT_EVAL_MODEL: undefined}, () => resolveModel())
    const configuredModel = withTemporaryEnv({FRO_BOT_EVAL_MODEL: 'provider/model'}, () => resolveModel())

    // #then model resolution preserves the default and valid override
    expect(defaultModel).toBe('opencode/big-pickle')
    expect(configuredModel).toBe('provider/model')
    expect(parseModel('provider/model')).toEqual({providerID: 'provider', modelID: 'model'})
  })

  it.each(['', 'provider', '/model', 'provider/', 'provider/model/extra'])('rejects malformed model %s', model => {
    // #given a malformed provider/model value
    // #when model parsing is attempted
    const parse = () => parseModel(model)

    // #then the operator-facing validation error is raised
    expect(parse).toThrow('FRO_BOT_EVAL_MODEL must use provider/model format')
  })

  it('rejects an empty configured model while preserving process.env', () => {
    // #given an explicitly empty model override
    const resolved = () => withTemporaryEnv({FRO_BOT_EVAL_MODEL: '   '}, () => resolveModel())

    // #when model resolution is attempted
    expect(resolved).toThrow('FRO_BOT_EVAL_MODEL must use provider/model format')
  })

  it('rejects an explicit harness path that does not exist', () => {
    // #given a missing operator-selected harness binary
    const missingPath = path.join(os.tmpdir(), `fro-bot-missing-harness-${Date.now()}`)

    // #when harness resolution is attempted
    const resolve = () => withTemporaryEnv({FRO_BOT_EVAL_HARNESS_BIN: missingPath}, () => resolveHarnessBinary())

    // #then the error identifies the bad configuration
    expect(resolve).toThrow(`FRO_BOT_EVAL_HARNESS_BIN points at a missing binary: ${missingPath}`)
  })
})
