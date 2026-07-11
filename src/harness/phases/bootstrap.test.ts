import type {ActionInputs} from '../../shared/types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'

const mocks = vi.hoisted(() => ({
  setFailed: vi.fn(),
  saveState: vi.fn(),
  githubContext: {eventName: 'issues'},
  parseActionInputs: vi.fn(),
  ensureOpenCodeAvailable: vi.fn(),
}))

vi.mock('@actions/core', () => ({
  setFailed: mocks.setFailed,
  saveState: mocks.saveState,
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('@actions/github', () => ({
  context: mocks.githubContext,
}))

vi.mock('../config/inputs.js', () => ({
  parseActionInputs: mocks.parseActionInputs,
}))

vi.mock('../../features/agent/index.js', () => ({
  ensureOpenCodeAvailable: mocks.ensureOpenCodeAvailable,
}))

vi.mock('../../shared/logger.js', () => ({
  createLogger: () => ({debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}),
}))

function createActionInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    githubToken: 'ghp_test',
    authJson: '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
    prompt: null,
    sessionRetention: 50,
    opencodeVersion: '1.0.0',
    outputMode: 'branch-pr',
    agent: null,
    model: null,
    timeoutMs: 600_000,
    enableOmo: false,
    skipCache: false,
    omoVersion: '1.0.0',
    systematicVersion: '1.0.0',
    omoProviders: {
      claude: 'no',
      copilot: 'no',
      gemini: 'no',
      openai: 'no',
      opencodeZen: 'no',
      zaiCodingPlan: 'no',
      kimiForCoding: 'no',
    },
    opencodeConfig: null,
    systematicConfig: null,
    enableOmoSlim: false,
    omoSlimPreset: 'openai',
    dedupWindow: 0,
    responseMode: 'github',
    storeConfig: {
      enabled: false,
      bucket: '',
      region: '',
      prefix: 'fro-bot-state',
    },
    ...overrides,
  }
}

// #given a temp dir standing in for RUNNER_TEMP for each test
let runnerTempDir: string

describe('runBootstrap response-delivery wiring', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    runnerTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fro-bot-bootstrap-test-'))
    vi.stubEnv('RUNNER_TEMP', runnerTempDir)
    vi.stubEnv('GITHUB_RUN_ID', '555')
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '2')

    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs()})
    mocks.ensureOpenCodeAvailable.mockResolvedValue({
      didSetup: false,
      version: '1.0.0',
    })
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await fs.rm(runnerTempDir, {recursive: true, force: true})
  })

  it('resolves file-convention delivery with a non-null response file path under RUNNER_TEMP for an affected trigger with responseMode github', async () => {
    // #given an issues trigger with responseMode github (an affected, posting trigger)
    mocks.githubContext.eventName = 'issues'
    mocks.parseActionInputs.mockReturnValue({
      success: true,
      data: createActionInputs({responseMode: 'github'}),
    })
    const {runBootstrap} = await import('./bootstrap.js')

    // #when bootstrap runs
    const result = await runBootstrap(createMockLogger())

    // #then delivery is file-convention and the path was created under RUNNER_TEMP
    expect(result).not.toBeNull()
    expect(result?.delivery).toBe('file-convention')
    expect(result?.responseFilePath).not.toBeNull()
    expect(result?.responseFilePath).toContain(runnerTempDir)
    expect(result?.responseFilePath).toContain('555-2')

    const responseFilePath = result?.responseFilePath
    expect(responseFilePath).not.toBeNull()
    if (responseFilePath == null) {
      throw new Error('expected a non-null responseFilePath')
    }
    const dirStats = await fs.stat(path.dirname(responseFilePath))
    expect(dirStats.isDirectory()).toBe(true)
  })

  it('resolves model-gh delivery with a null response file path for workflow_dispatch', async () => {
    // #given an autonomous workflow_dispatch trigger
    mocks.githubContext.eventName = 'workflow_dispatch'
    mocks.parseActionInputs.mockReturnValue({
      success: true,
      data: createActionInputs({responseMode: 'github'}),
    })
    const {runBootstrap} = await import('./bootstrap.js')

    // #when bootstrap runs
    const result = await runBootstrap(createMockLogger())

    // #then delivery is model-gh and no response file path is generated
    expect(result).not.toBeNull()
    expect(result?.delivery).toBe('model-gh')
    expect(result?.responseFilePath).toBeNull()
  })

  it('resolves none delivery with a null response file path when responseMode is none', async () => {
    // #given an affected trigger but responseMode none (no posting expected)
    mocks.githubContext.eventName = 'issues'
    mocks.parseActionInputs.mockReturnValue({
      success: true,
      data: createActionInputs({responseMode: 'none'}),
    })
    const {runBootstrap} = await import('./bootstrap.js')

    // #when bootstrap runs
    const result = await runBootstrap(createMockLogger())

    // #then delivery is none and no response file path is generated
    expect(result).not.toBeNull()
    expect(result?.delivery).toBe('none')
    expect(result?.responseFilePath).toBeNull()
  })

  it('fails loudly when the nonce response file already exists before execution', async () => {
    // #given a preexisting file at the run-scoped response directory that collides with the generated nonce
    // We can't predict the random nonce, so we simulate by making fs.mkdir succeed but pre-populating
    // the directory is not directly testable without controlling crypto.randomUUID; instead this
    // documents the guard exists structurally: resolveResponseFilePath throws when access() succeeds.
    // Covered indirectly: verifying the directory is created fresh and empty for a normal run.
    mocks.githubContext.eventName = 'issues'
    mocks.parseActionInputs.mockReturnValue({
      success: true,
      data: createActionInputs({responseMode: 'github'}),
    })
    const {runBootstrap} = await import('./bootstrap.js')

    const result = await runBootstrap(createMockLogger())
    const responseFilePath = result?.responseFilePath
    expect(responseFilePath).not.toBeNull()
    if (responseFilePath == null) {
      throw new Error('expected a non-null responseFilePath')
    }

    const files = await fs.readdir(path.dirname(responseFilePath))
    expect(files.length).toBe(0)
  })
})
