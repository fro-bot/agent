/**
 * Tests for backups.ts (Unit 5, slice 5a) — real filesystem, temp directories, no mocking of fs.
 */

import type {QuarantineMetadata} from './backups.js'

import {lstat, mkdir, rm, symlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {deleteBackup, listBackups, QUARANTINE_METADATA_FILE_NAME} from './backups.js'
import {writeJournal} from './journal.js'
import {markRepoHeld, repoMutexKey, resetRepoHoldsForTesting, resetRepoLocksForTesting} from './repo-mutex.js'
import {makeTempDir} from './update-fixtures/helpers.js'

let reposRoot: string

beforeEach(async () => {
  reposRoot = await makeTempDir('backups-test-repos-')
  resetRepoLocksForTesting()
  resetRepoHoldsForTesting()
})

afterEach(async () => {
  await rm(reposRoot, {recursive: true, force: true})
})

function quarantineRepoDir(owner = 'acme', repo = 'widgets'): string {
  return join(reposRoot, '.workspace-agent', 'quarantine', `${owner}__${repo}`)
}

function makeMetadata(overrides: Partial<QuarantineMetadata> = {}): QuarantineMetadata {
  return {
    recoveryId: 'gen-1',
    owner: 'acme',
    repo: 'widgets',
    createdAt: '2026-09-24T00:00:00.000Z',
    sizeBytes: 1024,
    entryCount: 5,
    sizeComplete: true,
    source: 'recovery',
    originalHeadSha: 'a'.repeat(40),
    originalBranch: 'main',
    ...overrides,
  }
}

async function writeGeneration(
  id: string,
  metadata: QuarantineMetadata | undefined,
  owner = 'acme',
  repo = 'widgets',
): Promise<string> {
  const dir = join(quarantineRepoDir(owner, repo), id)
  // (E1) A real generation always has an envelope `checkout/` subdirectory alongside metadata.json.
  await mkdir(join(dir, 'checkout'), {recursive: true})
  if (metadata !== undefined) {
    await writeFile(join(dir, QUARANTINE_METADATA_FILE_NAME), JSON.stringify(metadata))
  }
  return dir
}

describe('listBackups', () => {
  it('reports an empty list when the quarantine subdirectory was never created', async () => {
    // #given / #when
    const result = await listBackups('acme', 'widgets', {reposRoot})
    // #then
    expect(result).toEqual({kind: 'ok', backups: [], totalBytes: 0})
  })

  it('lists a single generation with valid metadata', async () => {
    // #given
    await writeGeneration('gen-1', makeMetadata())
    // #when
    const result = await listBackups('acme', 'widgets', {reposRoot})
    // #then
    expect(result).toEqual({
      kind: 'ok',
      backups: [
        {
          id: 'gen-1',
          metadataOk: true,
          createdAt: '2026-09-24T00:00:00.000Z',
          sizeBytes: 1024,
          sizeComplete: true,
          originalHeadSha: 'a'.repeat(40),
          originalBranch: 'main',
        },
      ],
      totalBytes: 1024,
    })
  })

  it('lists multiple generations and sums their sizes into totalBytes', async () => {
    // #given
    await writeGeneration('gen-1', makeMetadata({recoveryId: 'gen-1', sizeBytes: 1000}))
    await writeGeneration('gen-2', makeMetadata({recoveryId: 'gen-2', sizeBytes: 2000}))
    // #when
    const result = await listBackups('acme', 'widgets', {reposRoot})
    // #then
    expect(result.kind).toBe('ok')
    expect(result.kind === 'ok' ? result.backups.length : 0).toBe(2)
    expect(result.kind === 'ok' ? result.totalBytes : 0).toBe(3000)
  })

  it('never lists a DIFFERENT repository\u2019s generations', async () => {
    // #given
    await writeGeneration('gen-1', makeMetadata(), 'acme', 'other-repo')
    // #when
    const result = await listBackups('acme', 'widgets', {reposRoot})
    // #then
    expect(result).toEqual({kind: 'ok', backups: [], totalBytes: 0})
  })
})

describe('listBackups — malformed and non-generation entries', () => {
  it('lists a generation with malformed metadata as metadataOk:false, degraded fields, never counted in totalBytes', async () => {
    // #given \u2014 a generation directory with invalid JSON metadata
    const dir = await writeGeneration('gen-broken', undefined)
    await writeFile(join(dir, QUARANTINE_METADATA_FILE_NAME), '{not valid json')
    await writeGeneration('gen-good', makeMetadata({recoveryId: 'gen-good', sizeBytes: 500}))

    // #when
    const result = await listBackups('acme', 'widgets', {reposRoot})

    // #then
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    const broken = result.backups.find(b => b.id === 'gen-broken')
    expect(broken?.metadataOk).toBe(false)
    expect(broken?.sizeBytes).toBe(0)
    expect(broken?.originalHeadSha).toBeUndefined()
    expect(result.totalBytes).toBe(500)
  })

  it('lists a generation with NO metadata file at all as metadataOk:false', async () => {
    // #given
    await writeGeneration('gen-nometa', undefined)

    // #when
    const result = await listBackups('acme', 'widgets', {reposRoot})

    // #then
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.backups).toEqual([
      {
        id: 'gen-nometa',
        metadataOk: false,
        createdAt: expect.any(String) as string,
        sizeBytes: 0,
        sizeComplete: true,
        originalHeadSha: undefined,
        originalBranch: undefined,
      },
    ])
  })

  it('skips a symlinked "generation" entirely \u2014 never followed, never listed', async () => {
    // #given
    const realDir = await makeTempDir('backups-test-elsewhere-')
    await mkdir(quarantineRepoDir(), {recursive: true})
    await symlink(realDir, join(quarantineRepoDir(), 'gen-symlink'))

    // #when
    const result = await listBackups('acme', 'widgets', {reposRoot})

    // #then
    expect(result).toEqual({kind: 'ok', backups: [], totalBytes: 0})
    await rm(realDir, {recursive: true, force: true})
  })

  it('skips a non-directory entry under the quarantine repo dir', async () => {
    // #given
    await mkdir(quarantineRepoDir(), {recursive: true})
    await writeFile(join(quarantineRepoDir(), 'stray-file'), 'not a generation')

    // #when
    const result = await listBackups('acme', 'widgets', {reposRoot})

    // #then
    expect(result).toEqual({kind: 'ok', backups: [], totalBytes: 0})
  })

  it('fails closed when the quarantine repo directory is itself a symlink', async () => {
    // #given
    const realDir = await makeTempDir('backups-test-quarantine-elsewhere-')
    await mkdir(join(reposRoot, '.workspace-agent', 'quarantine'), {recursive: true})
    await symlink(realDir, quarantineRepoDir())

    // #when
    const result = await listBackups('acme', 'widgets', {reposRoot})

    // #then
    expect(result).toEqual({kind: 'failed'})
    await rm(realDir, {recursive: true, force: true})
  })
})

describe('deleteBackup — happy path', () => {
  it('removes exactly the named generation, leaving others intact', async () => {
    // #given
    const target = await writeGeneration('gen-target', makeMetadata({recoveryId: 'gen-target'}))
    await writeGeneration('gen-keep', makeMetadata({recoveryId: 'gen-keep'}))

    // #when
    const result = await deleteBackup('acme', 'widgets', 'gen-target', {reposRoot})

    // #then
    expect(result).toEqual({kind: 'ok'})
    await expect(lstat(target)).rejects.toThrow()
    const listed = await listBackups('acme', 'widgets', {reposRoot})
    expect(listed.kind).toBe('ok')
    expect(listed.kind === 'ok' ? listed.backups.map(b => b.id) : []).toEqual(['gen-keep'])
  })

  it('refuses not-found for an id that does not exist', async () => {
    // #given
    await writeGeneration('gen-keep', makeMetadata())

    // #when
    const result = await deleteBackup('acme', 'widgets', 'gen-missing', {reposRoot})

    // #then
    expect(result).toEqual({kind: 'refused', reason: 'not-found'})
    const listed = await listBackups('acme', 'widgets', {reposRoot})
    expect(listed.kind === 'ok' ? listed.backups.length : -1).toBe(1)
  })

  it('refuses not-found when the quarantine repo directory was never created', async () => {
    // #given / #when
    const result = await deleteBackup('acme', 'widgets', 'gen-1', {reposRoot})
    // #then
    expect(result).toEqual({kind: 'refused', reason: 'not-found'})
  })
})

describe('deleteBackup — traversal, symlink, and cross-repo refusals leave everything intact', () => {
  it.each(['..', '../escaped', '/etc/passwd', 'a/b', String.raw`a\b`, '.', ''])(
    'refuses invalid-id for %j without touching the filesystem',
    async id => {
      // #given
      const target = await writeGeneration('gen-keep', makeMetadata())

      // #when
      const result = await deleteBackup('acme', 'widgets', id, {reposRoot})

      // #then
      expect(result).toEqual({kind: 'refused', reason: 'invalid-id'})
      await expect(lstat(target)).resolves.toBeDefined()
    },
  )

  it('refuses invalid-id for a symlinked "generation", and never deletes the symlink\u2019s target', async () => {
    // #given
    const realDir = await makeTempDir('backups-test-symlink-target-')
    await writeFile(join(realDir, 'sentinel.txt'), 'still here')
    await mkdir(quarantineRepoDir(), {recursive: true})
    const linkPath = join(quarantineRepoDir(), 'gen-symlink')
    await symlink(realDir, linkPath)

    // #when
    const result = await deleteBackup('acme', 'widgets', 'gen-symlink', {reposRoot})

    // #then
    expect(result).toEqual({kind: 'refused', reason: 'invalid-id'})
    await expect(lstat(join(realDir, 'sentinel.txt'))).resolves.toBeDefined()
    await rm(realDir, {recursive: true, force: true})
  })

  it('refuses not-found for another repository\u2019s valid id \u2014 it simply does not exist under THIS repo', async () => {
    // #given
    await writeGeneration('gen-shared-name', makeMetadata(), 'acme', 'other-repo')

    // #when
    const result = await deleteBackup('acme', 'widgets', 'gen-shared-name', {reposRoot})

    // #then
    expect(result).toEqual({kind: 'refused', reason: 'not-found'})
    const otherListed = await listBackups('acme', 'other-repo', {reposRoot})
    expect(otherListed.kind === 'ok' ? otherListed.backups.length : -1).toBe(1)
  })
})

describe('deleteBackup — E8: repo exclusion (maintenance hold, in-progress recovery)', () => {
  it('refuses maintenance-hold, touching nothing', async () => {
    // #given
    const target = await writeGeneration('gen-keep', makeMetadata())
    markRepoHeld(repoMutexKey('acme', 'widgets'), 'termination-unconfirmed')

    // #when
    const result = await deleteBackup('acme', 'widgets', 'gen-keep', {reposRoot})

    // #then
    expect(result).toEqual({kind: 'refused', reason: 'maintenance-hold'})
    await expect(lstat(target)).resolves.toBeDefined()
  })

  it('refuses recovery-in-progress for an in-flight recovery journal, touching nothing', async () => {
    // #given
    const target = await writeGeneration('gen-keep', makeMetadata())
    const journalsDir = join(reposRoot, '.workspace-agent', 'journals')
    await writeJournal(journalsDir, {
      kind: 'recovery',
      owner: 'acme',
      repo: 'widgets',
      phase: 'quarantining',
      recoveryId: 'gen-other',
      targetSha: '1'.repeat(40),
      branch: 'main',
      startedAt: new Date().toISOString(),
    })

    // #when
    const result = await deleteBackup('acme', 'widgets', 'gen-keep', {reposRoot})

    // #then
    expect(result).toEqual({kind: 'refused', reason: 'recovery-in-progress'})
    await expect(lstat(target)).resolves.toBeDefined()
  })

  it('an in-progress UPDATE journal does NOT block a backup delete', async () => {
    // #given
    await writeGeneration('gen-keep', makeMetadata())
    const journalsDir = join(reposRoot, '.workspace-agent', 'journals')
    await writeJournal(journalsDir, {
      kind: 'update',
      owner: 'acme',
      repo: 'widgets',
      phase: 'applying',
      fromSha: '0'.repeat(40),
      toSha: '1'.repeat(40),
      startedAt: new Date().toISOString(),
    })

    // #when
    const result = await deleteBackup('acme', 'widgets', 'gen-keep', {reposRoot})

    // #then
    expect(result).toEqual({kind: 'ok'})
  })
})
