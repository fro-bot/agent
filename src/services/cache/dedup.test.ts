import type {CacheAdapter} from './types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {DEDUP_CACHE_PREFIX, DEDUP_SENTINEL_DIR} from '../../shared/constants.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  buildDedupSaveKey,
  restoreDeduplicationMarker,
  saveDeduplicationMarker,
  type DeduplicationEntity,
  type DeduplicationMarker,
} from './dedup.js'

const testRepo = 'owner/repo'
const testEntity: DeduplicationEntity = {
  entityType: 'pr',
  entityNumber: 42,
}
const testEntityDir = path.join(DEDUP_SENTINEL_DIR, 'owner-repo-pr-42')

function createMarker(runId: number): DeduplicationMarker {
  return {
    timestamp: '2026-03-21T12:00:00.000Z',
    runId,
    action: 'opened',
    eventType: 'pull_request',
    entityType: 'pr',
    entityNumber: testEntity.entityNumber,
  }
}

describe('buildDedupSaveKey', () => {
  it('builds key with sanitized repo and run id', () => {
    // #given repository and dedup entity
    const runId = 777

    // #when building save key
    const key = buildDedupSaveKey(testRepo, testEntity, runId)

    // #then key follows dedup pattern
    expect(key).toBe(`${DEDUP_CACHE_PREFIX}-owner-repo-pr-42-777`)
  })
})

describe('restoreDeduplicationMarker', () => {
  afterEach(async () => {
    await fs.rm(DEDUP_SENTINEL_DIR, {recursive: true, force: true})
  })

  it('returns null when no sentinel exists', async () => {
    // #given cache restore miss
    const cacheAdapter: CacheAdapter = {
      restoreCache: vi.fn(async () => undefined),
      saveCache: vi.fn(async () => 1),
    }

    // #when restoring dedup marker
    const marker = await restoreDeduplicationMarker(testRepo, testEntity, createMockLogger(), cacheAdapter)

    // #then null is returned for miss
    expect(marker).toBeNull()
  })

  it('returns parsed marker when sentinel exists', async () => {
    // #given cache restore hit and sentinel file restored
    const expected = createMarker(1001)
    const cacheAdapter: CacheAdapter = {
      restoreCache: vi.fn(async () => {
        const sentinelPath = path.join(testEntityDir, 'sentinel.json')
        await fs.mkdir(testEntityDir, {recursive: true})
        await fs.writeFile(sentinelPath, JSON.stringify(expected), 'utf8')
        return 'hit-key'
      }),
      saveCache: vi.fn(async () => 1),
    }

    // #when restoring dedup marker
    const marker = await restoreDeduplicationMarker(testRepo, testEntity, createMockLogger(), cacheAdapter)

    // #then parsed marker is returned
    expect(marker).toEqual(expected)
  })

  it('returns null when cache restore throws', async () => {
    // #given cache adapter throws during restore
    const cacheAdapter: CacheAdapter = {
      restoreCache: vi.fn(async () => {
        throw new Error('restore failed')
      }),
      saveCache: vi.fn(async () => 1),
    }

    // #when restoring dedup marker
    const marker = await restoreDeduplicationMarker(testRepo, testEntity, createMockLogger(), cacheAdapter)

    // #then fail-open returns null
    expect(marker).toBeNull()
  })

  it('uses prefix as primary key and entity-scoped directory', async () => {
    // #given cache adapter spy for restore args
    const restoreCache = vi.fn(async () => undefined)
    const cacheAdapter: CacheAdapter = {
      restoreCache,
      saveCache: vi.fn(async () => 1),
    }

    // #when restoring dedup marker
    await restoreDeduplicationMarker(testRepo, testEntity, createMockLogger(), cacheAdapter)

    // #then restore uses prefix as primary key with entity-scoped dir
    expect(restoreCache).toHaveBeenCalledWith([testEntityDir], `${DEDUP_CACHE_PREFIX}-owner-repo-pr-42-`, [])
  })
})

describe('saveDeduplicationMarker', () => {
  afterEach(async () => {
    await fs.rm(DEDUP_SENTINEL_DIR, {recursive: true, force: true})
  })

  it('saves with correct cache key including run id', async () => {
    // #given marker with run id and save adapter spy
    const marker = createMarker(3003)
    const saveCache = vi.fn(async () => 1)
    const cacheAdapter: CacheAdapter = {
      restoreCache: vi.fn(async () => undefined),
      saveCache,
    }

    // #when saving dedup marker
    const result = await saveDeduplicationMarker(testRepo, testEntity, marker, createMockLogger(), cacheAdapter)

    // #then save succeeds and key matches expected format
    expect(result).toBe(true)
    expect(saveCache).toHaveBeenCalledWith([testEntityDir], `${DEDUP_CACHE_PREFIX}-owner-repo-pr-42-3003`)
  })

  it('writes sentinel file with marker json content', async () => {
    // #given marker and save adapter
    const marker = createMarker(4004)
    const cacheAdapter: CacheAdapter = {
      restoreCache: vi.fn(async () => undefined),
      saveCache: vi.fn(async () => 1),
    }

    // #when saving dedup marker
    await saveDeduplicationMarker(testRepo, testEntity, marker, createMockLogger(), cacheAdapter)

    // #then sentinel file contains marker JSON
    const sentinelPath = path.join(testEntityDir, 'sentinel.json')
    const content = await fs.readFile(sentinelPath, 'utf8')
    const parsed = JSON.parse(content) as DeduplicationMarker
    expect(parsed).toEqual(marker)
  })

  it('saves to entity-scoped directory', async () => {
    // #given marker and save adapter spy
    const marker = createMarker(7007)
    const saveCache = vi.fn(async () => 1)
    const cacheAdapter: CacheAdapter = {
      restoreCache: vi.fn(async () => undefined),
      saveCache,
    }

    // #when saving dedup marker
    await saveDeduplicationMarker(testRepo, testEntity, marker, createMockLogger(), cacheAdapter)

    // #then save uses entity-scoped directory, not global sentinel dir
    expect(saveCache).toHaveBeenCalledWith([testEntityDir], expect.stringContaining('owner-repo-pr-42'))
  })

  it('returns true when cache key already exists', async () => {
    // #given save adapter throws already exists error
    const marker = createMarker(5005)
    const cacheAdapter: CacheAdapter = {
      restoreCache: vi.fn(async () => undefined),
      saveCache: vi.fn(async () => {
        throw new Error('Cache already exists for key')
      }),
    }

    // #when saving dedup marker
    const result = await saveDeduplicationMarker(testRepo, testEntity, marker, createMockLogger(), cacheAdapter)

    // #then save is treated as success
    expect(result).toBe(true)
  })

  it('returns false when save fails with non exists error', async () => {
    // #given save adapter throws generic error
    const marker = createMarker(6006)
    const cacheAdapter: CacheAdapter = {
      restoreCache: vi.fn(async () => undefined),
      saveCache: vi.fn(async () => {
        throw new Error('network timeout')
      }),
    }

    // #when saving dedup marker
    const result = await saveDeduplicationMarker(testRepo, testEntity, marker, createMockLogger(), cacheAdapter)

    // #then save failure returns false
    expect(result).toBe(false)
  })
})
