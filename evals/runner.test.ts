import type {AgentResult, ExecutionConfig, PromptOptions} from '../src/features/agent/types.js'
import type {Logger} from '../src/shared/logger.js'
import type {Scenario} from './types.js'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {describe, expect, it} from 'vitest'
import {buildAgentPrompt} from '../src/features/agent/index.js'
import {createIssueCommentCreatedEvent} from '../src/features/triggers/__fixtures__/payloads.js'
import {createLogger} from '../src/shared/logger.js'
import {
  buildPromptOptions,
  parseModel,
  resolveEvalTimeoutMs,
  resolveHarnessBinary,
  resolveModel,
  runScenario,
} from './runner.js'
import {cleanPrScenario} from './scenarios/clean-pr.js'
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
  expect: {
    verdict: null,
    requiredSignals: [],
    forbiddenSignals: [],
  },
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
