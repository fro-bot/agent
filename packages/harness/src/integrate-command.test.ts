/**
 * Tests for integrate-command.ts — config assembly, flag parsing, exit-code mapping,
 * artifact packaging (Unit 2).
 *
 * No real merge runs here. runIntegration and makeRealAdapters are stubbed.
 * packageArtifact is injected as a stub for command-level tests; it is tested
 * directly for atomic-staging and provenance-inclusion contracts.
 *
 * Tests prove: config assembly from harness.config.json + flags, exit-code mapping,
 * required-flag validation (including --out), packageArtifact invocation contract,
 * atomic staging (throw before rename leaves outPath untouched), and no secret/stack
 * leakage on error.
 */
import type {IntegrationConfig, IntegrationResult} from './integrate.js'
import {execFileSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {cmdIntegrate, packageArtifact} from './integrate-command.js'
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
let outPath: string

beforeEach(async () => {
  tmpDir = await makeTmpDir()
  configPath = await writeHarnessConfig(tmpDir)
  workDir = path.join(tmpDir, 'work')
  promptPath = path.join(tmpDir, 'prompt.md')
  outPath = path.join(tmpDir, 'artifact.tar')
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
    const stubPackage = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    // #when
    const code = await cmdIntegrate(
      ['--work-dir', workDir, '--prompt-path', promptPath, '--out', outPath],
      configPath,
      stubPackage,
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

  it('calls packageArtifact with workDir, integrationCommit, and outPath on {ok:true}', async () => {
    // #given
    const integrationCommit = 'deadbeef1234'
    vi.mocked(runIntegration).mockResolvedValue({
      ok: true,
      manifest: {baseVersion: '1.15.13', integrationRefs: [], integrationCommit, buildSha: 'dev'},
    })
    const stubPackage = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    // #when
    const code = await cmdIntegrate(
      ['--work-dir', workDir, '--prompt-path', promptPath, '--out', outPath],
      configPath,
      stubPackage,
    )

    // #then
    expect(code).toBe(0)
    expect(stubPackage).toHaveBeenCalledExactlyOnceWith(workDir, integrationCommit, outPath)
  })

  it('passes the real adapters from makeRealAdapters to runIntegration', async () => {
    // #given
    const fakeAdapters = {cloneRepo: vi.fn()}
    vi.mocked(makeRealAdapters).mockReturnValue(fakeAdapters as never)
    vi.mocked(runIntegration).mockResolvedValue({
      ok: true,
      manifest: {baseVersion: '1.15.13', integrationRefs: [], integrationCommit: 'abc', buildSha: 'dev'},
    })
    const stubPackage = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    // #when
    await cmdIntegrate(['--work-dir', workDir, '--prompt-path', promptPath, '--out', outPath], configPath, stubPackage)

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
    const stubPackage = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    // #when
    const code = await cmdIntegrate(
      ['--work-dir', workDir, '--prompt-path', promptPath, '--out', outPath],
      configPath,
      stubPackage,
    )

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

  it('does NOT call packageArtifact when runIntegration returns {ok:false}', async () => {
    // #given
    vi.mocked(runIntegration).mockResolvedValue({ok: false, error: 'merge failed'})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stubPackage = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    // #when
    const code = await cmdIntegrate(
      ['--work-dir', workDir, '--prompt-path', promptPath, '--out', outPath],
      configPath,
      stubPackage,
    )

    // #then
    expect(code).toBe(1)
    expect(stubPackage).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })

  it('returns 1 and prints a one-line error when runIntegration throws', async () => {
    // #given
    vi.mocked(runIntegration).mockRejectedValue(new Error('Unexpected crash'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stubPackage = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    // #when
    const code = await cmdIntegrate(
      ['--work-dir', workDir, '--prompt-path', promptPath, '--out', outPath],
      configPath,
      stubPackage,
    )

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

  it('returns 1 and leaves no artifact when packageArtifact throws', async () => {
    // #given — integration succeeds but packaging fails
    vi.mocked(runIntegration).mockResolvedValue({
      ok: true,
      manifest: {baseVersion: '1.15.13', integrationRefs: [], integrationCommit: 'abc', buildSha: 'dev'},
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stubPackage = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('git archive failed'))

    // #when
    const code = await cmdIntegrate(
      ['--work-dir', workDir, '--prompt-path', promptPath, '--out', outPath],
      configPath,
      stubPackage,
    )

    // #then
    expect(code).toBe(1)
    // outPath must NOT exist — packaging failure must not leave a partial artifact
    expect(existsSync(outPath)).toBe(false)
    expect(errorSpy).toHaveBeenCalledOnce()
    const [errorLine] = errorSpy.mock.calls[0] as [string]
    expect(errorLine).toContain('git archive failed')

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
    const code = await cmdIntegrate(['--prompt-path', promptPath, '--out', outPath], configPath)

    // #then
    expect(code).not.toBe(0)
    expect(runIntegration).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })

  it('returns non-zero when --prompt-path is missing', async () => {
    // #given / #when
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await cmdIntegrate(['--work-dir', workDir, '--out', outPath], configPath)

    // #then
    expect(code).not.toBe(0)
    expect(runIntegration).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })

  it('returns non-zero when --out is missing', async () => {
    // #given / #when
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await cmdIntegrate(['--work-dir', workDir, '--prompt-path', promptPath], configPath)

    // #then
    expect(code).not.toBe(0)
    expect(runIntegration).not.toHaveBeenCalled()
    // Error message must mention --out
    const [errorLine] = errorSpy.mock.calls[0] as [string]
    expect(errorLine).toContain('--out')

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
    const stubPackage = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    // #when
    await cmdIntegrate(
      ['--work-dir', workDir, '--prompt-path', promptPath, '--out', outPath],
      customConfigPath,
      stubPackage,
    )

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
    const stubPackage = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    // #when
    await cmdIntegrate(
      ['--work-dir', workDir, '--prompt-path', promptPath, '--out', outPath],
      customConfigPath,
      stubPackage,
    )

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
    const stubPackage = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    // #when
    await cmdIntegrate(
      ['--work-dir', workDir, '--prompt-path', promptPath, '--out', outPath],
      customConfigPath,
      stubPackage,
    )

    // #then
    const [calledConfig] = vi.mocked(runIntegration).mock.calls[0] as [IntegrationConfig, unknown]
    expect(calledConfig.opencodeBin).toBe('/usr/local/bin/opencode-custom')
  })
})

// ---------------------------------------------------------------------------
// FIX 3: Flag parser rejects another flag token as a flag's value
// ---------------------------------------------------------------------------

describe('cmdIntegrate — FIX 3: flag value cannot be another flag', () => {
  it('returns non-zero when --work-dir is followed by another flag', async () => {
    // #given / #when
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await cmdIntegrate(['--work-dir', '--prompt-path', promptPath, '--out', outPath], configPath)

    // #then
    expect(code).not.toBe(0)
    expect(runIntegration).not.toHaveBeenCalled()
    const [errorLine] = errorSpy.mock.calls[0] as [string]
    expect(errorLine).toContain('--work-dir')
    expect(errorLine).toContain('requires a value')

    errorSpy.mockRestore()
  })

  it('returns non-zero when --prompt-path is followed by another flag', async () => {
    // #given / #when
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await cmdIntegrate(['--work-dir', workDir, '--prompt-path', '--out', outPath], configPath)

    // #then
    expect(code).not.toBe(0)
    expect(runIntegration).not.toHaveBeenCalled()
    const [errorLine] = errorSpy.mock.calls[0] as [string]
    expect(errorLine).toContain('--prompt-path')
    expect(errorLine).toContain('requires a value')

    errorSpy.mockRestore()
  })

  it('returns non-zero when --out is followed by another flag', async () => {
    // #given / #when
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await cmdIntegrate(
      ['--work-dir', workDir, '--prompt-path', promptPath, '--out', '--dry-run'],
      configPath,
    )

    // #then
    expect(code).not.toBe(0)
    expect(runIntegration).not.toHaveBeenCalled()
    const [errorLine] = errorSpy.mock.calls[0] as [string]
    expect(errorLine).toContain('--out')
    expect(errorLine).toContain('requires a value')

    errorSpy.mockRestore()
  })

  it('returns non-zero when --work-dir has no following value at all', async () => {
    // #given / #when
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await cmdIntegrate(['--work-dir'], configPath)

    // #then
    expect(code).not.toBe(0)
    expect(runIntegration).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// FIX 7: integrationRefs element-type validation
// ---------------------------------------------------------------------------

describe('cmdIntegrate — FIX 7: integrationRefs element validation', () => {
  it('returns non-zero when integrationRefs contains a non-string element', async () => {
    // #given — config with a non-string element in integrationRefs
    const badConfigPath = await writeHarnessConfig(tmpDir, {integrationRefs: ['valid-ref', 42, null]})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // #when
    const code = await cmdIntegrate(
      ['--work-dir', workDir, '--prompt-path', promptPath, '--out', outPath],
      badConfigPath,
    )

    // #then — config rejected before runIntegration is called
    expect(code).not.toBe(0)
    expect(runIntegration).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })

  it('returns non-zero when integrationRefs contains an empty string', async () => {
    // #given — config with an empty string element
    const badConfigPath = await writeHarnessConfig(tmpDir, {integrationRefs: ['valid-ref', '']})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // #when
    const code = await cmdIntegrate(
      ['--work-dir', workDir, '--prompt-path', promptPath, '--out', outPath],
      badConfigPath,
    )

    // #then
    expect(code).not.toBe(0)
    expect(runIntegration).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// packageArtifact — unit tests (direct, no command layer)
// ---------------------------------------------------------------------------

/**
 * Helper: set up a fake git repo in a temp dir with a commit and provenance.json.
 * Returns {repoDir, commit, provenanceContent}.
 */
async function makeGitRepo(dir: string): Promise<{repoDir: string; commit: string; provenanceContent: string}> {
  const repoDir = path.join(dir, 'repo')
  await fs.mkdir(repoDir, {recursive: true})

  // Init a minimal git repo.
  execFileSync('git', ['init', '-b', 'main'], {cwd: repoDir, stdio: 'pipe'})
  execFileSync('git', ['config', 'user.email', 'test@test.com'], {cwd: repoDir, stdio: 'pipe'})
  execFileSync('git', ['config', 'user.name', 'Test'], {cwd: repoDir, stdio: 'pipe'})

  // Add a tracked file.
  await fs.writeFile(path.join(repoDir, 'README.md'), '# test\n', 'utf8')
  execFileSync('git', ['add', 'README.md'], {cwd: repoDir, stdio: 'pipe'})
  execFileSync('git', ['commit', '-m', 'init'], {cwd: repoDir, stdio: 'pipe'})

  // Get the commit SHA.
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repoDir, encoding: 'utf8'}).trim()

  // Write provenance.json to the repo dir as an UNTRACKED file.
  // This mirrors the real flow: runIntegration writes provenance.json after getCommitSha,
  // so it is never committed to git. packageArtifact copies it into the artifact separately.
  // The FIX 5 dirty-tree guard only checks TRACKED changes (not untracked '??' files).
  const provenanceContent = JSON.stringify(
    {baseVersion: '1.15.13', integrationRefs: [], integrationCommit: commit, buildSha: 'dev'},
    null,
    2,
  )
  await fs.writeFile(path.join(repoDir, 'provenance.json'), provenanceContent, 'utf8')

  return {repoDir, commit, provenanceContent}
}

describe('packageArtifact', () => {
  it('creates a tar artifact at outPath containing provenance.json', async () => {
    // #given
    const {repoDir, commit} = await makeGitRepo(tmpDir)
    const artifactPath = path.join(tmpDir, 'out', 'artifact.tar')

    // #when
    await packageArtifact(repoDir, commit, artifactPath)

    // #then — artifact exists
    expect(existsSync(artifactPath)).toBe(true)

    // Verify provenance.json is in the tar.
    const listOutput = execFileSync('tar', ['tf', artifactPath], {encoding: 'utf8'})
    expect(listOutput).toContain('provenance.json')
  })

  it('rejects a dirty working tree before git archive (FIX 5 guard)', async () => {
    // #given — create a repo, then stage a tracked change without committing
    // The guard only catches TRACKED uncommitted changes (not untracked '??' files).
    const {repoDir, commit} = await makeGitRepo(tmpDir)
    // Modify a tracked file and stage it (tracked dirty change)
    await fs.writeFile(path.join(repoDir, 'README.md'), '# modified\n', 'utf8')
    execFileSync('git', ['add', 'README.md'], {cwd: repoDir, stdio: 'pipe'})
    const artifactPath = path.join(tmpDir, 'artifact.tar')

    // #when / #then — FIX 5: uncommitted tracked changes must be rejected
    await expect(packageArtifact(repoDir, commit, artifactPath)).rejects.toThrow(/uncommitted/i)
    // Artifact must NOT be created
    expect(existsSync(artifactPath)).toBe(false)
  })

  it('does NOT leave an artifact at outPath when git archive fails (atomic staging)', async () => {
    // #given — use a non-existent commit SHA to force git archive to fail
    const {repoDir} = await makeGitRepo(tmpDir)
    const artifactPath = path.join(tmpDir, 'should-not-exist.tar')
    const badCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

    // #when / #then
    await expect(packageArtifact(repoDir, badCommit, artifactPath)).rejects.toThrow()
    // Atomic: outPath must NOT exist after the failure
    expect(existsSync(artifactPath)).toBe(false)
  })

  it('fIX 5: throws when working tree has uncommitted tracked changes before git archive', async () => {
    // #given — create a repo with a commit, then stage a tracked change without committing
    const {repoDir, commit} = await makeGitRepo(tmpDir)
    // Modify a tracked file and stage it (tracked dirty change, not untracked)
    await fs.writeFile(path.join(repoDir, 'README.md'), '# modified\n', 'utf8')
    execFileSync('git', ['add', 'README.md'], {cwd: repoDir, stdio: 'pipe'})
    const artifactPath = path.join(tmpDir, 'should-not-exist.tar')

    // #when / #then — must throw because tracked changes are uncommitted
    await expect(packageArtifact(repoDir, commit, artifactPath)).rejects.toThrow(/uncommitted/i)
    // Artifact must NOT be created
    expect(existsSync(artifactPath)).toBe(false)
  })

  it('provenance.json in the artifact carries the same integrationCommit', async () => {
    // #given
    const {repoDir, commit, provenanceContent} = await makeGitRepo(tmpDir)
    const artifactPath = path.join(tmpDir, 'artifact.tar')

    // #when
    await packageArtifact(repoDir, commit, artifactPath)

    // #then — extract and verify provenance.json content
    const extractDir = path.join(tmpDir, 'extracted')
    await fs.mkdir(extractDir, {recursive: true})
    execFileSync('tar', ['xf', artifactPath, '-C', extractDir], {stdio: 'pipe'})

    const extractedProvenance = await fs.readFile(path.join(extractDir, 'provenance.json'), 'utf8')
    const parsed = JSON.parse(extractedProvenance) as {integrationCommit: string}
    expect(parsed.integrationCommit).toBe(commit)
    // Content must match what was written to workDir
    expect(extractedProvenance.trim()).toBe(provenanceContent.trim())
  })
})
