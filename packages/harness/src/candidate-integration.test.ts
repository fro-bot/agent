import type {IntegrationAdapters, IntegrationConfig, ProvenanceManifest, TrustedPushRepository} from './integrate.js'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {describe, expect, it, vi} from 'vitest'
import {finalizeCandidateIntegration} from './integrate-command.js'
import {makeRealAdapters} from './integrate.js'

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-candidate-test-'))
}

function runGit(workDir: string, args: readonly string[]): string {
  return execFileSync('git', args, {cwd: workDir, encoding: 'utf8'}).trim()
}

async function makeCandidateRepository(root: string): Promise<{workDir: string; commit: string}> {
  const workDir = path.join(root, 'candidate')
  await fs.mkdir(workDir, {recursive: true})
  runGit(workDir, ['init', '--quiet', '-b', 'integrate/v1.0.0'])
  runGit(workDir, ['config', 'user.name', 'candidate-test'])
  runGit(workDir, ['config', 'user.email', 'candidate@example.invalid'])
  await fs.writeFile(path.join(workDir, 'README.md'), 'candidate committed\n', 'utf8')
  runGit(workDir, ['add', 'README.md'])
  runGit(workDir, ['commit', '--quiet', '-m', 'base'])
  runGit(workDir, ['tag', 'v1.0.0'])
  await fs.writeFile(path.join(workDir, 'README.md'), 'candidate committed\n')
  await fs.writeFile(path.join(workDir, 'candidate.txt'), 'integration\n', 'utf8')
  runGit(workDir, ['add', 'README.md', 'candidate.txt'])
  runGit(workDir, ['commit', '--quiet', '-m', 'integration candidate'])
  const commit = runGit(workDir, ['rev-parse', 'HEAD'])
  runGit(workDir, ['update-ref', 'refs/remotes/watch/local/candidate-ref', commit])
  return {workDir, commit}
}

function candidateConfig(workDir: string): IntegrationConfig {
  return {
    baseVersion: '1.0.0',
    releaseRepo: 'anomalyco/opencode',
    sourceRepo: 'https://github.com/anomalyco/opencode.git',
    integrationRefs: ['candidate-ref'],
    workDir,
    dryRun: false,
    pushTarget: {repository: 'https://github.com/fro-bot/agent.git', ref: 'refs/harness-integrate/1.0.0'},
  }
}

describe('finalizeCandidateIntegration', () => {
  it('rejects a dirty candidate and names every offending path', async () => {
    // #given
    const root = await makeTmpDir()
    try {
      const {workDir} = await makeCandidateRepository(root)
      await fs.writeFile(path.join(workDir, 'README.md'), 'dirty\n', 'utf8')
      await fs.writeFile(path.join(workDir, 'untracked.txt'), 'dirty\n', 'utf8')
      const adapters = makeRealAdapters()

      // #when
      const result = await finalizeCandidateIntegration(
        candidateConfig(workDir),
        path.join(root, 'artifact.tar'),
        adapters,
      )

      // #then
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected dirty candidate failure')
      expect(result.error).toContain('README.md')
      expect(result.error).toContain('untracked.txt')
    } finally {
      await fs.rm(root, {recursive: true, force: true})
    }
  })

  it('builds and pushes the frozen materialized tree, not later candidate mutations', async () => {
    // #given
    const root = await makeTmpDir()
    const previousGhToken = process.env.GH_TOKEN
    try {
      const {workDir, commit} = await makeCandidateRepository(root)
      const outPath = path.join(root, 'artifact.tar')
      const real = makeRealAdapters()
      process.env.GH_TOKEN = 'trusted-push-token'
      const originalPrepare = real.prepareTrustedPushRepository
      let pushedRepository: TrustedPushRepository | null = null
      const preparedManifest: {value: ProvenanceManifest | null} = {value: null}
      let candidateMutated = false
      const adapters: IntegrationAdapters = {
        ...real,
        validateFinalTree: async (validationWorkDir, expectation) => {
          if (validationWorkDir === workDir && candidateMutated) {
            throw new Error('mutable candidate directory must not be authoritative after freeze')
          }
          await real.validateFinalTree(validationWorkDir, expectation)
        },
        prepareTrustedPushRepository: async (sourceWorkDir, integrationCommit, manifest, expectation) => {
          preparedManifest.value = manifest
          const trusted = await originalPrepare(sourceWorkDir, integrationCommit, manifest, expectation)
          // Simulate the mutable working directory changing after freeze.
          await fs.writeFile(path.join(workDir, 'README.md'), 'mutated after freeze\n', 'utf8')
          candidateMutated = true
          return trusted
        },
        buildCli: async trustedWorkDir => {
          expect(trustedWorkDir).not.toBe(workDir)
          expect(process.env.GH_TOKEN).toBeUndefined()
          await expect(fs.readFile(path.join(trustedWorkDir, 'README.md'), 'utf8')).resolves.toBe(
            'candidate committed\n',
          )
          await expect(fs.readFile(path.join(workDir, 'README.md'), 'utf8')).resolves.toBe('mutated after freeze\n')
        },
        installDependencies: async () => {},
        verifyVersion: async () => {},
        acquirePushCredential: async () => {
          expect(process.env.GH_TOKEN).toBe('trusted-push-token')
          return {token: 'trusted-push-token'}
        },
        pushIntegration: async trusted => {
          pushedRepository = trusted
        },
      }

      // #when
      const result = await finalizeCandidateIntegration(candidateConfig(workDir), outPath, adapters)

      // #then
      expect(result.ok).toBe(true)
      if (preparedManifest.value === null) throw new Error('expected prepared provenance manifest')
      expect(preparedManifest.value.carryManifest).toEqual({
        base: 'v1.0.0',
        carries: [{ref: 'candidate-ref', resolvedSha: commit}],
      })
      expect(pushedRepository).not.toBeNull()
      expect(outPath).toBeTruthy()
      await expect(fs.stat(outPath)).resolves.toBeTruthy()
    } finally {
      if (previousGhToken === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previousGhToken
      await fs.rm(root, {recursive: true, force: true})
    }
  })

  it('fails closed when no push credential is available at push time', async () => {
    // #given
    const root = await makeTmpDir()
    const previousGhToken = process.env.GH_TOKEN
    const previousGithubToken = process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    try {
      const {workDir} = await makeCandidateRepository(root)
      const real = makeRealAdapters()
      const pushCalled = vi.fn()
      const adapters: IntegrationAdapters = {
        ...real,
        installDependencies: async () => {},
        buildCli: async () => {},
        verifyVersion: async () => {},
        pushIntegration: async () => {
          pushCalled()
        },
      }

      // #when
      const result = await finalizeCandidateIntegration(
        candidateConfig(workDir),
        path.join(root, 'artifact.tar'),
        adapters,
        async () => {},
      )

      // #then
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected missing push credential failure')
      expect(result.stage).toBe('push')
      expect(result.error).toContain('GH_TOKEN or GITHUB_TOKEN is required')
      expect(pushCalled).not.toHaveBeenCalled()
    } finally {
      if (previousGhToken === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previousGhToken
      if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = previousGithubToken
      await fs.rm(root, {recursive: true, force: true})
    }
  })
})
