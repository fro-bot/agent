import type {IntegrationAdapters, ProvenanceManifest} from './integrate.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {readProvenanceManifest, runIntegration, writeProvenanceManifest} from './integrate.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-test-'))
}

function makeAdapters(overrides: Partial<IntegrationAdapters> = {}): IntegrationAdapters {
  return {
    cloneRepo: async () => {},
    fetchTags: async () => {},
    fetchRef: async () => {},
    createBranch: async () => {},
    runMerge: async () => {},
    buildCli: async () => {},
    verifyVersion: async () => {},
    getCommitSha: async () => 'abc1234deadbeef',
    ...overrides,
  }
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
        runMerge: async () => {
          throw new Error('LLM merge left unresolved conflicts in packages/opencode/src/session/prompt.ts')
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
  // Provenance manifest matches what getProvenance() would read (single source of truth)
  // ---------------------------------------------------------------------------

  it('provenance single source of truth: manifest content matches getProvenance shape', async () => {
    // #given
    const dir = await makeTmpDir()
    try {
      const manifest: ProvenanceManifest = {
        baseVersion: '1.15.13',
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
})
