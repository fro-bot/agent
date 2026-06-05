/**
 * Tests for integrate-command.ts — config assembly, flag parsing, exit-code mapping.
 *
 * No real merge runs here. runIntegration and makeRealAdapters are stubbed.
 * Tests prove: config assembly from harness.config.json + flags, exit-code mapping,
 * required-flag validation, and no secret/stack leakage on error.
 */
import type {IntegrationConfig, IntegrationResult} from './integrate.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {cmdIntegrate} from './integrate-command.js'
// Import the mocked functions after vi.mock is declared.
import {makeRealAdapters, runIntegration} from './integrate.js'

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before any imports of the module under test.
// ---------------------------------------------------------------------------

// We mock the integrate module so no real git/opencode runs happen.
vi.mock('./integrate.js', () => ({
  runIntegration: vi.fn(),
  makeRealAdapters: vi.fn(() => ({})),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-integrate-cmd-test-'))
}

/**
 * Writes a minimal harness.config.json to the given directory.
 * Returns the path to the written file.
 */
async function writeHarnessConfig(dir: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const config = {
    release_repo: 'anomalyco/opencode',
    source_repo: 'https://github.com/anomalyco/opencode.git',
    base_version: '1.15.13',
    integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
    agent: 'build',
    model: 'anthropic/claude-sonnet-4-6',
    opencode_bin: 'opencode',
    ...overrides,
  }
  const configPath = path.join(dir, 'harness.config.json')
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8')
  return configPath
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string
let configPath: string
let workDir: string
let promptPath: string

beforeEach(async () => {
  tmpDir = await makeTmpDir()
  configPath = await writeHarnessConfig(tmpDir)
  workDir = path.join(tmpDir, 'work')
  promptPath = path.join(tmpDir, 'prompt.md')
  // Write a minimal prompt file so the command can read it.
  await fs.writeFile(promptPath, 'Merge {{branches}} onto {{tag}}.', 'utf8')
  vi.clearAllMocks()
})

afterEach(async () => {
  await fs.rm(tmpDir, {recursive: true, force: true})
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('cmdIntegrate — happy path', () => {
  it('calls runIntegration with the correctly-assembled IntegrationConfig and returns 0 on {ok:true}', async () => {
    // #given
    const mockResult: IntegrationResult = {
      ok: true,
      manifest: {
        baseVersion: '1.15.13',
        integrationRefs: [],
        integrationCommit: 'abc1234',
        buildSha: 'dev',
      },
    }
    vi.mocked(runIntegration).mockResolvedValue(mockResult)

    // #when
    const code = await cmdIntegrate(
      ['--work-dir', workDir, '--prompt-path', promptPath, '--out', '/tmp/out.tar'],
      configPath,
    )

    // #then
    expect(code).toBe(0)
    expect(runIntegration).toHaveBeenCalledOnce()

    const [calledConfig] = vi.mocked(runIntegration).mock.calls[0] as [IntegrationConfig, unknown]
    expect(calledConfig.baseVersion).toBe('1.15.13')
    expect(calledConfig.releaseRepo).toBe('anomalyco/opencode')
    expect(calledConfig.integrationRefs).toEqual(['https://github.com/anomalyco/opencode/pull/30182'])
    expect(calledConfig.agent).toBe('build')
    expect(calledConfig.model).toBe('anthropic/claude-sonnet-4-6')
    expect(calledConfig.opencodeBin).toBe('opencode')
    expect(calledConfig.workDir).toBe(workDir)
    expect(calledConfig.promptPath).toBe(promptPath)
  })

  it('passes the real adapters from makeRealAdapters to runIntegration', async () => {
    // #given
    const fakeAdapters = {cloneRepo: vi.fn()}
    vi.mocked(makeRealAdapters).mockReturnValue(fakeAdapters as never)
    vi.mocked(runIntegration).mockResolvedValue({
      ok: true,
      manifest: {baseVersion: '1.15.13', integrationRefs: [], integrationCommit: 'abc', buildSha: 'dev'},
    })

    // #when
    await cmdIntegrate(['--work-dir', workDir, '--prompt-path', promptPath], configPath)

    // #then
    expect(makeRealAdapters).toHaveBeenCalledOnce()
    const [, calledAdapters] = vi.mocked(runIntegration).mock.calls[0] as [IntegrationConfig, unknown]
    expect(calledAdapters).toBe(fakeAdapters)
  })
})

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------

describe('cmdIntegrate — error path', () => {
  it('returns 1 and prints a one-line error when runIntegration returns {ok:false}', async () => {
    // #given
    vi.mocked(runIntegration).mockResolvedValue({ok: false, error: 'LLM merge failed: conflict in foo.ts'})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // #when
    const code = await cmdIntegrate(['--work-dir', workDir, '--prompt-path', promptPath], configPath)

    // #then
    expect(code).toBe(1)
    expect(errorSpy).toHaveBeenCalledOnce()
    const [errorLine] = errorSpy.mock.calls[0] as [string]
    // Must be a single line (no newlines in the message)
    expect(errorLine).not.toContain('\n')
    // Must contain the error message
    expect(errorLine).toContain('LLM merge failed')
    // Must NOT contain stack traces or secret-shaped content
    expect(errorLine).not.toMatch(/at \w+ \(/)

    errorSpy.mockRestore()
  })

  it('returns 1 and prints a one-line error when runIntegration throws', async () => {
    // #given
    vi.mocked(runIntegration).mockRejectedValue(new Error('Unexpected crash'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // #when
    const code = await cmdIntegrate(['--work-dir', workDir, '--prompt-path', promptPath], configPath)

    // #then
    expect(code).toBe(1)
    expect(errorSpy).toHaveBeenCalledOnce()
    const [errorLine] = errorSpy.mock.calls[0] as [string]
    expect(errorLine).not.toContain('\n')
    expect(errorLine).toContain('Unexpected crash')
    // Must NOT leak a stack trace
    expect(errorLine).not.toMatch(/at \w+ \(/)

    errorSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Missing required flags
// ---------------------------------------------------------------------------

describe('cmdIntegrate — missing required flags', () => {
  it('returns non-zero when --work-dir is missing', async () => {
    // #given / #when
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await cmdIntegrate(['--prompt-path', promptPath], configPath)

    // #then
    expect(code).not.toBe(0)
    expect(runIntegration).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })

  it('returns non-zero when --prompt-path is missing', async () => {
    // #given / #when
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await cmdIntegrate(['--work-dir', workDir], configPath)

    // #then
    expect(code).not.toBe(0)
    expect(runIntegration).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Config sourcing
// ---------------------------------------------------------------------------

describe('cmdIntegrate — config sourcing', () => {
  it('reads integrationRefs, agent, and model from harness.config.json (not hardcoded)', async () => {
    // #given — write a config with distinct values
    const customConfigPath = await writeHarnessConfig(tmpDir, {
      integrationRefs: ['https://github.com/anomalyco/opencode/pull/99999'],
      agent: 'custom-agent',
      model: 'anthropic/claude-opus-4',
    })
    vi.mocked(runIntegration).mockResolvedValue({
      ok: true,
      manifest: {baseVersion: '1.15.13', integrationRefs: [], integrationCommit: 'abc', buildSha: 'dev'},
    })

    // #when
    await cmdIntegrate(['--work-dir', workDir, '--prompt-path', promptPath], customConfigPath)

    // #then
    const [calledConfig] = vi.mocked(runIntegration).mock.calls[0] as [IntegrationConfig, unknown]
    expect(calledConfig.integrationRefs).toEqual(['https://github.com/anomalyco/opencode/pull/99999'])
    expect(calledConfig.agent).toBe('custom-agent')
    expect(calledConfig.model).toBe('anthropic/claude-opus-4')
  })

  it('defaults opencodeBin to "opencode" when opencode_bin is absent from config', async () => {
    // #given — config without opencode_bin
    const customConfigPath = await writeHarnessConfig(tmpDir, {opencode_bin: undefined})
    // Remove the key entirely by rewriting
    const raw = JSON.parse(await fs.readFile(customConfigPath, 'utf8')) as Record<string, unknown>
    delete raw.opencode_bin
    await fs.writeFile(customConfigPath, JSON.stringify(raw, null, 2), 'utf8')

    vi.mocked(runIntegration).mockResolvedValue({
      ok: true,
      manifest: {baseVersion: '1.15.13', integrationRefs: [], integrationCommit: 'abc', buildSha: 'dev'},
    })

    // #when
    await cmdIntegrate(['--work-dir', workDir, '--prompt-path', promptPath], customConfigPath)

    // #then
    const [calledConfig] = vi.mocked(runIntegration).mock.calls[0] as [IntegrationConfig, unknown]
    expect(calledConfig.opencodeBin).toBe('opencode')
  })

  it('reads opencodeBin from config when present', async () => {
    // #given
    const customConfigPath = await writeHarnessConfig(tmpDir, {opencode_bin: '/usr/local/bin/opencode-custom'})
    vi.mocked(runIntegration).mockResolvedValue({
      ok: true,
      manifest: {baseVersion: '1.15.13', integrationRefs: [], integrationCommit: 'abc', buildSha: 'dev'},
    })

    // #when
    await cmdIntegrate(['--work-dir', workDir, '--prompt-path', promptPath], customConfigPath)

    // #then
    const [calledConfig] = vi.mocked(runIntegration).mock.calls[0] as [IntegrationConfig, unknown]
    expect(calledConfig.opencodeBin).toBe('/usr/local/bin/opencode-custom')
  })
})

// ---------------------------------------------------------------------------
// --out flag parsing (Unit 1: parse and pass; Unit 2 will use it for packaging)
// ---------------------------------------------------------------------------

describe('cmdIntegrate — --out flag', () => {
  it('accepts --out flag without error and still returns 0 on success', async () => {
    // #given
    vi.mocked(runIntegration).mockResolvedValue({
      ok: true,
      manifest: {baseVersion: '1.15.13', integrationRefs: [], integrationCommit: 'abc', buildSha: 'dev'},
    })

    // #when
    const code = await cmdIntegrate(
      ['--work-dir', workDir, '--prompt-path', promptPath, '--out', '/tmp/artifact.tar'],
      configPath,
    )

    // #then
    expect(code).toBe(0)
  })
})
