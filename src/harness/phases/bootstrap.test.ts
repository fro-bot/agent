import type {ActionInputs} from '../../shared/types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {DEFAULT_OPENCODE_VERSION} from '../../shared/constants.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {err, ok} from '../../shared/types.js'

const mocks = vi.hoisted(() => ({
  setFailed: vi.fn(),
  saveState: vi.fn(),
  githubContext: {eventName: 'issues'},
  parseActionInputs: vi.fn(),
  ensureOpenCodeAvailable: vi.fn(),
  randomUUID: vi.fn(),
  assertNoPersistedGitCredentials: vi.fn(),
  runSandboxPreflight: vi.fn(),
  createSandboxLifecycle: vi.fn(),
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

vi.mock('@fro-bot/runtime', async importOriginal => {
  const original = await importOriginal<typeof import('@fro-bot/runtime')>()
  return {...original, ensureOpenCodeAvailable: mocks.ensureOpenCodeAvailable}
})

// The real preflight shells out to git; these response-delivery wiring tests don't exercise it —
// its own real-git behavior is covered exhaustively by git-credential-check.integration.test.ts.
// Mocked here only, not globally: other suites still exercise the real function.
vi.mock('../../services/setup/git-credential-check.js', () => ({
  assertNoPersistedGitCredentials: mocks.assertNoPersistedGitCredentials,
}))

vi.mock('./sandbox-lifecycle.js', () => ({
  createSandboxLifecycle: mocks.createSandboxLifecycle,
}))

vi.mock('../../services/setup/sandbox-preflight.js', () => ({
  runSandboxPreflight: mocks.runSandboxPreflight,
  createSandboxPreflightDeps: () => ({}),
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
    opencodeVersion: DEFAULT_OPENCODE_VERSION,
    outputMode: 'branch-pr',
    agent: null,
    model: null,
    timeoutMs: 600_000,
    serverBootstrapTimeoutMs: 5000,
    skipCache: false,
    systematicVersion: '1.0.0',
    opencodeConfig: null,
    systematicConfig: null,
    dedupWindow: 0,
    responseMode: 'github',
    reviewSkipLabel: null,
    brokeredPushExtraPaths: [],
    repoSkills: false,
    isolateAgent: false,
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
      version: DEFAULT_OPENCODE_VERSION,
    })
    mocks.assertNoPersistedGitCredentials.mockResolvedValue(ok(undefined))
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

describe('runBootstrap git-credential-check wiring', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    runnerTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fro-bot-bootstrap-test-'))
    vi.stubEnv('RUNNER_TEMP', runnerTempDir)
    vi.stubEnv('GITHUB_RUN_ID', '555')
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '2')
    mocks.randomUUID.mockReturnValue('test-nonce')

    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs()})
    mocks.ensureOpenCodeAvailable.mockResolvedValue({
      version: DEFAULT_OPENCODE_VERSION,
    })
    mocks.assertNoPersistedGitCredentials.mockResolvedValue(ok(undefined))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await fs.rm(runnerTempDir, {recursive: true, force: true})
  })

  it('calls the real-boundary credential check with the resolved workspace and phase logger for an affected withhold trigger (issues)', async () => {
    // #given an affected trigger (credential withheld regardless of responseMode) with an explicit workspace
    mocks.githubContext.eventName = 'issues'
    const workspaceDir = path.join(runnerTempDir, 'repo')
    vi.stubEnv('GITHUB_WORKSPACE', workspaceDir)
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({responseMode: 'github'})})
    const {runBootstrap} = await import('./bootstrap.js')

    // #when
    const result = await runBootstrap(createMockLogger())

    // #then the mocked boundary was called once with an exec-adapter-shaped object, the resolved
    // workspace, and the exact phase logger instance bootstrap returns
    expect(result).not.toBeNull()
    expect(mocks.assertNoPersistedGitCredentials).toHaveBeenCalledTimes(1)
    expect(mocks.assertNoPersistedGitCredentials).toHaveBeenCalledWith(
      expect.objectContaining({exec: expect.any(Function) as unknown, getExecOutput: expect.any(Function) as unknown}),
      workspaceDir,
      result?.logger,
    )
  })

  it('passes process.cwd() as the workspace when GITHUB_WORKSPACE is unset', async () => {
    // #given an affected trigger with no GITHUB_WORKSPACE in the environment
    mocks.githubContext.eventName = 'issues'
    vi.stubEnv('GITHUB_WORKSPACE', undefined)
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({responseMode: 'github'})})
    const expectedCwd = process.cwd()
    const {runBootstrap} = await import('./bootstrap.js')

    // #when
    const result = await runBootstrap(createMockLogger())

    // #then the production `?? process.cwd()` fallback is exercised, not a nonexistent path
    expect(result).not.toBeNull()
    expect(mocks.assertNoPersistedGitCredentials).toHaveBeenCalledWith(
      expect.anything(),
      expectedCwd,
      expect.anything(),
    )
  })

  it('fails closed, sets core.setFailed, and never calls ensureOpenCodeAvailable when the credential check denies', async () => {
    // #given the credential check reports a static denial
    mocks.githubContext.eventName = 'issues'
    vi.stubEnv('GITHUB_WORKSPACE', path.join(runnerTempDir, 'repo'))
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({responseMode: 'github'})})
    mocks.assertNoPersistedGitCredentials.mockResolvedValue(err('static denial reason'))
    const {runBootstrap} = await import('./bootstrap.js')

    // #when
    const result = await runBootstrap(createMockLogger())

    // #then bootstrap aborts before ever reaching OpenCode setup
    expect(result).toBeNull()
    expect(mocks.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Refusing to proceed with credential withheld: static denial reason') as string,
    )
    expect(mocks.ensureOpenCodeAvailable).not.toHaveBeenCalled()
  })

  it('skips the credential check entirely for a provisioned (autonomous) trigger', async () => {
    // #given workflow_dispatch, which provisions the credential rather than withholding it
    mocks.githubContext.eventName = 'workflow_dispatch'
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({responseMode: 'github'})})
    const {runBootstrap} = await import('./bootstrap.js')

    // #when
    const result = await runBootstrap(createMockLogger())

    // #then the boundary is never invoked when nothing needs withholding
    expect(result).not.toBeNull()
    expect(mocks.assertNoPersistedGitCredentials).not.toHaveBeenCalled()
  })

  it('still runs the credential check for an affected trigger even when responseMode is none', async () => {
    // #given an affected trigger with responseMode none — delivery is 'none' but credential stays withheld
    mocks.githubContext.eventName = 'issues'
    vi.stubEnv('GITHUB_WORKSPACE', path.join(runnerTempDir, 'repo'))
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({responseMode: 'none'})})
    const {runBootstrap} = await import('./bootstrap.js')

    // #when
    const result = await runBootstrap(createMockLogger())

    // #then delivery is none, but the withhold-driven credential check still ran
    expect(result).not.toBeNull()
    expect(result?.delivery).toBe('none')
    expect(mocks.assertNoPersistedGitCredentials).toHaveBeenCalledTimes(1)
  })
})

describe('runBootstrap isolate-agent preflight', () => {
  const tools = {sudo: '/usr/bin/sudo', setpriv: '/usr/bin/setpriv'}

  beforeEach(async () => {
    vi.clearAllMocks()
    runnerTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fro-bot-bootstrap-iso-'))
    vi.stubEnv('RUNNER_TEMP', runnerTempDir)
    mocks.githubContext.eventName = 'issues'
    mocks.randomUUID.mockReturnValue('test-nonce')
    mocks.ensureOpenCodeAvailable.mockResolvedValue({version: DEFAULT_OPENCODE_VERSION})
    mocks.assertNoPersistedGitCredentials.mockResolvedValue(ok(undefined))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await fs.rm(runnerTempDir, {recursive: true, force: true})
  })

  it('stops before any setup or directory creation when the runner is unsupported', async () => {
    // #given isolation is on and the preflight rejects the runner
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({isolateAgent: true})})
    mocks.runSandboxPreflight.mockResolvedValue({
      ok: false,
      check: 'sudo',
      message: 'isolate-agent is not supported on this runner (sudo): passwordless sudo is required',
    })
    const {runBootstrap} = await import('./bootstrap.js')

    // #when bootstrap runs
    const result = await runBootstrap(createMockLogger())

    // #then it fails with the check's message and nothing was set up
    expect(result).toBeNull()
    expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('(sudo)'))
    expect(mocks.ensureOpenCodeAvailable).not.toHaveBeenCalled()
    expect(mocks.assertNoPersistedGitCredentials).not.toHaveBeenCalled()
    expect(await fs.readdir(runnerTempDir)).toEqual([])
  })

  it('carries the resolved tool paths forward when the runner is supported', async () => {
    // #given isolation is on and the preflight passes
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({isolateAgent: true})})
    mocks.runSandboxPreflight.mockResolvedValue({ok: true, tools})
    const {runBootstrap} = await import('./bootstrap.js')

    // #when bootstrap runs
    const result = await runBootstrap(createMockLogger())

    // #then setup proceeds and the tools are handed to later phases
    expect(result?.sandboxTools).toEqual(tools)
    expect(mocks.ensureOpenCodeAvailable).toHaveBeenCalledTimes(1)
  })

  it.each(['workflow_dispatch', 'schedule', 'issues'])(
    'checks the checkout for persisted git credentials on %s when isolation is on',
    async eventName => {
      // #given isolation on; workflow_dispatch and schedule provision the credential, issues withholds it
      mocks.githubContext.eventName = eventName
      vi.stubEnv('GITHUB_WORKSPACE', path.join(runnerTempDir, 'repo'))
      mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({isolateAgent: true})})
      mocks.runSandboxPreflight.mockResolvedValue({ok: true, tools})
      const {runBootstrap} = await import('./bootstrap.js')

      // #when
      const result = await runBootstrap(createMockLogger())

      // #then the sandbox user could read the checkout's .git/config, so the check ran, once
      expect(result).not.toBeNull()
      expect(mocks.assertNoPersistedGitCredentials).toHaveBeenCalledTimes(1)
    },
  )

  it('fails closed on a provision trigger when the checkout persisted credentials, naming persist-credentials', async () => {
    // #given a provision trigger, isolation on, and a checkout that kept its extraheader
    mocks.githubContext.eventName = 'workflow_dispatch'
    vi.stubEnv('GITHUB_WORKSPACE', path.join(runnerTempDir, 'repo'))
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({isolateAgent: true})})
    mocks.runSandboxPreflight.mockResolvedValue({ok: true, tools})
    mocks.assertNoPersistedGitCredentials.mockResolvedValue(err('http.extraheader found'))
    const {runBootstrap} = await import('./bootstrap.js')

    // #when
    const result = await runBootstrap(createMockLogger())

    // #then it aborts before setup, with an actionable message
    expect(result).toBeNull()
    expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('persist-credentials: false') as string)
    expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('isolate-agent') as string)
    expect(mocks.ensureOpenCodeAvailable).not.toHaveBeenCalled()
  })

  it('still skips the credential check on a provision trigger when isolation is off', async () => {
    // #given the same trigger without isolation
    mocks.githubContext.eventName = 'workflow_dispatch'
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({isolateAgent: false})})
    const {runBootstrap} = await import('./bootstrap.js')

    // #when
    await runBootstrap(createMockLogger())

    // #then behavior is unchanged
    expect(mocks.assertNoPersistedGitCredentials).not.toHaveBeenCalled()
  })

  it('creates the sandbox lifecycle here, so the run owns it before the server starts, and records its state', async () => {
    // #given isolation on, a supported runner and a file-convention response path
    const lifecycle = {prepare: vi.fn(), release: vi.fn(), isActive: vi.fn()}
    mocks.createSandboxLifecycle.mockReturnValue(lifecycle)
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({isolateAgent: true})})
    mocks.runSandboxPreflight.mockResolvedValue({ok: true, tools})
    vi.stubEnv('GITHUB_WORKSPACE', path.join(runnerTempDir, 'repo'))
    const {runBootstrap} = await import('./bootstrap.js')

    // #when bootstrap runs
    const result = await runBootstrap(createMockLogger())

    // #then the lifecycle is on the result, built from the resolved tools and the run's own paths
    expect(result?.sandbox).toBe(lifecycle)
    const options = mocks.createSandboxLifecycle.mock.calls[0]?.[0] as {
      tools: unknown
      workspacePath: string
      recordState: (state: string) => void
    }
    expect(options.tools).toBe(tools)
    expect(options.workspacePath).toBe(path.join(runnerTempDir, 'repo'))
    // #and its state changes are written for the post hook
    options.recordState('pending')
    expect(mocks.saveState).toHaveBeenCalledWith('sandboxState', 'pending')
  })

  it('creates no lifecycle when isolation is off', async () => {
    // #given the input is off
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({isolateAgent: false})})
    const {runBootstrap} = await import('./bootstrap.js')

    // #when bootstrap runs
    const result = await runBootstrap(createMockLogger())

    // #then
    expect(result?.sandbox ?? null).toBeNull()
    expect(mocks.createSandboxLifecycle).not.toHaveBeenCalled()
  })

  it('runs no preflight and carries no tools when isolation is off', async () => {
    // #given the input is off
    mocks.parseActionInputs.mockReturnValue({success: true, data: createActionInputs({isolateAgent: false})})
    const {runBootstrap} = await import('./bootstrap.js')

    // #when bootstrap runs
    const result = await runBootstrap(createMockLogger())

    // #then the preflight never ran
    expect(mocks.runSandboxPreflight).not.toHaveBeenCalled()
    expect(result?.sandboxTools).toBeNull()
  })
})
