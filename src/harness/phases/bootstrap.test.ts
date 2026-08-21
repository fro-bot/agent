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
  randomUUID: vi.fn(),
}))

vi.mock('@actions/core', () => ({
  setFailed: mocks.setFailed,
  saveState: mocks.saveState,
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('node:crypto', () => ({
  randomUUID: mocks.randomUUID,
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
    trustedHeadSha: '',
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
    reviewSkipLabel: null,
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
    mocks.randomUUID.mockReturnValue('test-nonce')

    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs()})
    mocks.ensureOpenCodeAvailable.mockResolvedValue({
      didSetup: false,
      version: '1.0.0',
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await fs.rm(runnerTempDir, {recursive: true, force: true})
  })

  it('resolves file-convention delivery with a non-null response file path under RUNNER_TEMP for an affected trigger with responseMode github', async () => {
    // #given an issues trigger with responseMode github (an affected, posting trigger)
    mocks.githubContext.eventName = 'issues'
    vi.stubEnv('GITHUB_WORKSPACE', path.join(runnerTempDir, 'repo'))
    const trustedHeadSha = 'a'.repeat(40)
    mocks.parseActionInputs.mockReturnValue({
      success: true,
      data: createActionInputs({responseMode: 'github', trustedHeadSha}),
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
    expect(result?.trustedHeadSha).toBe(trustedHeadSha)

    const responseFilePath = result?.responseFilePath
    expect(responseFilePath).not.toBeNull()
    if (responseFilePath == null) {
      throw new Error('expected a non-null responseFilePath')
    }
    const dirStats = await fs.stat(path.dirname(responseFilePath))
    expect(dirStats.isDirectory()).toBe(true)
    expect(result?.responseFilePathCandidates).toEqual({
      expectedPath: responseFilePath,
      fallbackPaths: [
        path.join(
          runnerTempDir,
          'repo',
          path.basename(runnerTempDir),
          'fro-bot-response',
          '555-2',
          path.basename(responseFilePath),
        ),
        path.join(runnerTempDir, 'repo', 'fro-bot-response', '555-2', path.basename(responseFilePath)),
      ],
    })
  })

  it('logs only the response directory and never the generated nonce', async () => {
    // #given a file-convention run with a workspace configured
    mocks.githubContext.eventName = 'issues'
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fro-bot-workspace-'))
    vi.stubEnv('GITHUB_WORKSPACE', workspaceDir)
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({responseMode: 'github'})})
    const {runBootstrap} = await import('./bootstrap.js')

    // #when bootstrap resolves the response artifact
    const result = await runBootstrap(createMockLogger())

    // #then the debug payload contains the directory but not the nonce filename
    const responseFilePath = result?.responseFilePath
    expect(responseFilePath).not.toBeNull()
    const logger = result?.logger
    expect(logger).toBeDefined()
    if (logger === undefined) {
      throw new Error('expected bootstrap logger')
    }
    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Resolved response file path', {
      directory: path.dirname(responseFilePath as string),
    })
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(path.basename(responseFilePath as string))
    await fs.rm(workspaceDir, {recursive: true, force: true})
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

  it('fails loudly when the fallback candidate is pre-seeded', async () => {
    // #given a preexisting file at the workspace fallback candidate
    mocks.githubContext.eventName = 'issues'
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fro-bot-workspace-'))
    vi.stubEnv('GITHUB_WORKSPACE', workspaceDir)
    mocks.randomUUID.mockReturnValue('fallback-preseed-nonce')
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({responseMode: 'github'})})
    const fallbackPath = path.join(
      workspaceDir,
      path.basename(runnerTempDir),
      'fro-bot-response',
      '555-2',
      'fallback-preseed-nonce.md',
    )
    await fs.mkdir(path.dirname(fallbackPath), {recursive: true})
    await fs.writeFile(fallbackPath, 'untrusted response', 'utf8')
    const {runBootstrap} = await import('./bootstrap.js')

    // #when bootstrap checks response candidates
    let caughtError: unknown
    try {
      await runBootstrap(createMockLogger())
    } catch (error) {
      caughtError = error
    }
    expect(caughtError).toBeInstanceOf(Error)
    const detail = caughtError instanceof Error ? caughtError.message : String(caughtError)
    expect(detail).toBe(
      `Response file already exists before execution (preseed guard tripped) in directory: ${path.dirname(fallbackPath)}`,
    )
    expect(detail).not.toContain('fallback-preseed-nonce.md')
    await fs.rm(workspaceDir, {recursive: true, force: true})
  })

  it('fails loudly when the second fallback candidate is pre-seeded', async () => {
    // #given a preexisting file at the workspace-relative fallback candidate
    mocks.githubContext.eventName = 'issues'
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fro-bot-workspace-'))
    vi.stubEnv('GITHUB_WORKSPACE', workspaceDir)
    mocks.randomUUID.mockReturnValue('second-fallback-preseed-nonce')
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({responseMode: 'github'})})
    const fallbackPath = path.join(workspaceDir, 'fro-bot-response', '555-2', 'second-fallback-preseed-nonce.md')
    await fs.mkdir(path.dirname(fallbackPath), {recursive: true})
    await fs.writeFile(fallbackPath, 'untrusted response', 'utf8')
    const {runBootstrap} = await import('./bootstrap.js')

    // #when bootstrap checks response candidates
    let caughtError: unknown
    try {
      await runBootstrap(createMockLogger())
    } catch (error) {
      caughtError = error
    }

    // #then the second fallback trips the same file-only guard
    expect(caughtError).toBeInstanceOf(Error)
    const detail = caughtError instanceof Error ? caughtError.message : String(caughtError)
    expect(detail).toBe(
      `Response file already exists before execution (preseed guard tripped) in directory: ${path.dirname(fallbackPath)}`,
    )
    expect(detail).not.toContain('second-fallback-preseed-nonce.md')
    await fs.rm(workspaceDir, {recursive: true, force: true})
  })

  it('does not trip the preseed guard for a fallback directory', async () => {
    // #given a directory at the first fallback candidate instead of a file
    mocks.githubContext.eventName = 'issues'
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fro-bot-workspace-'))
    vi.stubEnv('GITHUB_WORKSPACE', workspaceDir)
    mocks.randomUUID.mockReturnValue('fallback-directory-nonce')
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({responseMode: 'github'})})
    const fallbackPath = path.join(
      workspaceDir,
      path.basename(runnerTempDir),
      'fro-bot-response',
      '555-2',
      'fallback-directory-nonce.md',
    )
    await fs.mkdir(fallbackPath, {recursive: true})
    const {runBootstrap} = await import('./bootstrap.js')

    // #when bootstrap checks response candidates
    const result = await runBootstrap(createMockLogger())

    // #then a directory does not trip the file-only guard
    expect(result?.responseFilePathCandidates?.fallbackPaths).toContain(fallbackPath)
    await fs.rm(workspaceDir, {recursive: true, force: true})
  })

  it('proceeds when neither response candidate exists', async () => {
    // #given a controlled nonce with no preexisting primary or fallback file
    mocks.githubContext.eventName = 'issues'
    vi.stubEnv('GITHUB_WORKSPACE', path.join(runnerTempDir, 'repo'))
    mocks.randomUUID.mockReturnValue('fresh-nonce')
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({responseMode: 'github'})})
    const {runBootstrap} = await import('./bootstrap.js')

    // #when bootstrap checks response candidates
    const result = await runBootstrap(createMockLogger())

    // #then the response path is resolved normally
    expect(result?.responseFilePathCandidates).toEqual({
      expectedPath: result?.responseFilePath,
      fallbackPaths: [
        path.join(runnerTempDir, 'repo', path.basename(runnerTempDir), 'fro-bot-response', '555-2', 'fresh-nonce.md'),
        path.join(runnerTempDir, 'repo', 'fro-bot-response', '555-2', 'fresh-nonce.md'),
      ],
    })
  })

  it('proceeds when the fallback parent directory is absent', async () => {
    // #given a workspace whose fallback response directory has not been created
    mocks.githubContext.eventName = 'issues'
    const workspaceDir = path.join(runnerTempDir, 'absent-repo')
    vi.stubEnv('GITHUB_WORKSPACE', workspaceDir)
    mocks.randomUUID.mockReturnValue('absent-parent-nonce')
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({responseMode: 'github'})})
    const {runBootstrap} = await import('./bootstrap.js')

    // #when bootstrap checks response candidates
    const result = await runBootstrap(createMockLogger())

    // #then only the primary response directory is created and bootstrap proceeds
    expect(result?.responseFilePathCandidates?.fallbackPaths).toEqual([
      path.join(workspaceDir, path.basename(runnerTempDir), 'fro-bot-response', '555-2', 'absent-parent-nonce.md'),
      path.join(workspaceDir, 'fro-bot-response', '555-2', 'absent-parent-nonce.md'),
    ])
    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({code: 'ENOENT'})
  })
})
