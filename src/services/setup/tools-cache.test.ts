import type {Logger} from '../../shared/logger.js'
import {describe, expect, it, vi} from 'vitest'
import {
  buildCachePaths,
  buildToolsCacheKey,
  buildToolsRestoreKeys,
  restoreToolsCache,
  saveToolsCache,
  type ToolsCacheAdapter,
} from './tools-cache.js'

function createTestLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function createMockToolsCacheAdapter(options: {
  restoreResult?: string | undefined
  saveResult?: number
  saveError?: Error
}): ToolsCacheAdapter {
  return {
    restoreCache: vi.fn(async () => options.restoreResult),
    saveCache: vi.fn(async () => {
      if (options.saveError != null) {
        throw options.saveError
      }
      return options.saveResult ?? 1
    }),
  }
}

const COMPONENTS = {os: 'Linux', opencodeVersion: '1.0.0', systematicVersion: '2.1.0'} as const

const PATHS = {toolCachePath: '/cache/tool/opencode', opencodeCachePath: '/cache/home/opencode'} as const

describe('buildToolsCacheKey', () => {
  it('builds a key from the OS, OpenCode version and Systematic version', () => {
    // #given version info
    // #when building the key
    const key = buildToolsCacheKey(COMPONENTS)

    // #then the key uses the opencode-tools-v2 prefix and carries exactly those components
    expect(key).toBe('opencode-tools-v2-Linux-oc-1.0.0-sys-2.1.0')
  })

  it('handles the latest version', () => {
    expect(buildToolsCacheKey({...COMPONENTS, opencodeVersion: 'latest'})).toBe(
      'opencode-tools-v2-Linux-oc-latest-sys-2.1.0',
    )
  })

  it('preserves raw +harness.<sha> build-metadata in the cache key for harness versions', () => {
    // #given a harness build version
    const key = buildToolsCacheKey({...COMPONENTS, opencodeVersion: '1.17.3+harness.2c9cdbd2'})

    // #then the build metadata distinguishes the key from the plain base version
    expect(key).toBe('opencode-tools-v2-Linux-oc-1.17.3+harness.2c9cdbd2-sys-2.1.0')
    expect(key).not.toBe(buildToolsCacheKey({...COMPONENTS, opencodeVersion: '1.17.3'}))
  })

  it('different Systematic versions produce different keys (cache invalidation)', () => {
    expect(buildToolsCacheKey({...COMPONENTS, systematicVersion: '2.1.0'})).not.toBe(
      buildToolsCacheKey({...COMPONENTS, systematicVersion: '2.2.0'}),
    )
  })

  it('same components always produce the same key (stability)', () => {
    expect(buildToolsCacheKey(COMPONENTS)).toBe(buildToolsCacheKey({...COMPONENTS}))
  })
})

describe('buildToolsRestoreKeys', () => {
  it('scopes restore keys to the exact OpenCode and Systematic versions', () => {
    // #given version info
    const keys = buildToolsRestoreKeys(COMPONENTS)

    // #then there is no broad OS-only fallback
    expect(keys).toEqual(['opencode-tools-v2-Linux-oc-1.0.0-sys-2.1.0-'])
  })

  it('generates restore keys for different OS', () => {
    expect(buildToolsRestoreKeys({...COMPONENTS, os: 'macOS'})).toEqual(['opencode-tools-v2-macOS-oc-1.0.0-sys-2.1.0-'])
  })

  it('restore keys never match a key for a different Systematic version', () => {
    // #given a restore prefix for one Systematic version and the key for another
    const [restoreKey] = buildToolsRestoreKeys(COMPONENTS)
    const otherKey = buildToolsCacheKey({...COMPONENTS, systematicVersion: '2.2.0'})

    // #then the other key does not start with the prefix
    expect(otherKey.startsWith(restoreKey ?? '')).toBe(false)
  })
})

describe('tools-cache keys bound to a recorded V2 digest', () => {
  const V2_COMPONENTS = {os: 'Linux', opencodeVersion: '2.2.0', systematicVersion: '2.1.0'} as const
  const ID_A = 'sha256-6d597970a8cc448f'
  const ID_B = 'sha256-1f1ce0fc07b9245a'

  it('puts the digest id into the primary key and the restore key', () => {
    expect(buildToolsCacheKey({...V2_COMPONENTS, opencodeDigestId: ID_A})).toBe(
      `opencode-tools-v2-Linux-oc-2.2.0-${ID_A}-sys-2.1.0`,
    )
    expect(buildToolsRestoreKeys({...V2_COMPONENTS, opencodeDigestId: ID_A})).toEqual([
      `opencode-tools-v2-Linux-oc-2.2.0-${ID_A}-sys-2.1.0-`,
    ])
  })

  it('never restores a key written before the digest was part of the identity, or for another digest', () => {
    // #given the key an older release saved for the same version, and one for a different digest
    const legacyKey = buildToolsCacheKey(V2_COMPONENTS)
    const otherDigestKey = buildToolsCacheKey({...V2_COMPONENTS, opencodeDigestId: ID_B})
    const [restoreKey] = buildToolsRestoreKeys({...V2_COMPONENTS, opencodeDigestId: ID_A})

    // #then neither matches the digest-bound primary key or its restore prefix
    expect(legacyKey).not.toBe(buildToolsCacheKey({...V2_COMPONENTS, opencodeDigestId: ID_A}))
    expect(legacyKey.startsWith(restoreKey ?? '')).toBe(false)
    expect(otherDigestKey.startsWith(restoreKey ?? '')).toBe(false)
  })

  it('leaves V1 and harness keys exactly as they were', () => {
    expect(buildToolsCacheKey({...V2_COMPONENTS, opencodeVersion: '1.19.4'})).toBe(
      'opencode-tools-v2-Linux-oc-1.19.4-sys-2.1.0',
    )
    expect(buildToolsCacheKey({...V2_COMPONENTS, opencodeVersion: '1.19.4+harness.5bde2635'})).toBe(
      'opencode-tools-v2-Linux-oc-1.19.4+harness.5bde2635-sys-2.1.0',
    )
  })

  it('restores and saves under the digest-bound key', async () => {
    // #given
    const adapter = createMockToolsCacheAdapter({restoreResult: undefined})
    const expectedKey = `opencode-tools-v2-Linux-oc-2.2.0-${ID_A}-sys-2.1.0`

    // #when
    await restoreToolsCache({
      logger: createTestLogger(),
      ...V2_COMPONENTS,
      ...PATHS,
      opencodeDigestId: ID_A,
      cacheAdapter: adapter,
    })
    await saveToolsCache({
      logger: createTestLogger(),
      ...V2_COMPONENTS,
      ...PATHS,
      opencodeDigestId: ID_A,
      cacheAdapter: adapter,
    })

    // #then
    expect(adapter.restoreCache).toHaveBeenCalledWith(expect.any(Array), expectedKey, [`${expectedKey}-`])
    expect(adapter.saveCache).toHaveBeenCalledWith(expect.any(Array), expectedKey)
  })
})

describe('buildCachePaths', () => {
  it('caches the tool cache and the OpenCode cache', () => {
    expect(buildCachePaths(PATHS)).toEqual(['/cache/tool/opencode', '/cache/home/opencode'])
  })
})

describe('restoreToolsCache', () => {
  const options = {logger: createTestLogger(), ...COMPONENTS, ...PATHS}

  it('returns hit: false on cache miss', async () => {
    // #given a cache adapter that returns undefined (miss)
    const adapter = createMockToolsCacheAdapter({restoreResult: undefined})

    // #when restoring
    const result = await restoreToolsCache({...options, cacheAdapter: adapter})

    // #then result indicates miss
    expect(result).toEqual({hit: false, restoredKey: null})
  })

  it('returns hit: true with the restored key on cache hit', async () => {
    // #given a cache adapter that returns the primary key
    const key = buildToolsCacheKey(COMPONENTS)
    const adapter = createMockToolsCacheAdapter({restoreResult: key})

    // #when restoring
    const result = await restoreToolsCache({...options, cacheAdapter: adapter})

    // #then result indicates a hit
    expect(result).toEqual({hit: true, restoredKey: key})
  })

  it('passes the paths, primary key and restore keys to the cache adapter', async () => {
    // #given a cache adapter
    const adapter = createMockToolsCacheAdapter({restoreResult: undefined})

    // #when restoring
    await restoreToolsCache({...options, cacheAdapter: adapter})

    // #then the adapter received exactly the tool cache, the OpenCode cache and the scoped keys
    expect(adapter.restoreCache).toHaveBeenCalledWith(
      ['/cache/tool/opencode', '/cache/home/opencode'],
      'opencode-tools-v2-Linux-oc-1.0.0-sys-2.1.0',
      ['opencode-tools-v2-Linux-oc-1.0.0-sys-2.1.0-'],
    )
  })

  it('handles restore errors gracefully', async () => {
    // #given a cache adapter whose restore throws
    const logger = createTestLogger()
    const adapter: ToolsCacheAdapter = {
      restoreCache: vi.fn(async () => {
        throw new Error('cache service unavailable')
      }),
      saveCache: vi.fn(async () => 1),
    }

    // #when restoring
    const result = await restoreToolsCache({...options, logger, cacheAdapter: adapter})

    // #then it reports a miss and warns
    expect(result).toEqual({hit: false, restoredKey: null})
    expect(logger.warning).toHaveBeenCalledWith('Tools cache restore failed', {error: 'cache service unavailable'})
  })
})

describe('saveToolsCache', () => {
  const options = {logger: createTestLogger(), ...COMPONENTS, ...PATHS}

  it('saves the cache successfully', async () => {
    // #given a cache adapter that accepts the save
    const adapter = createMockToolsCacheAdapter({saveResult: 1})

    // #when saving
    const saved = await saveToolsCache({...options, cacheAdapter: adapter})

    // #then it reports success
    expect(saved).toBe(true)
  })

  it('saves under the primary key with the tool cache and OpenCode cache paths', async () => {
    // #given a cache adapter
    const adapter = createMockToolsCacheAdapter({saveResult: 1})

    // #when saving
    await saveToolsCache({...options, cacheAdapter: adapter})

    // #then the adapter received exactly those paths and the primary key
    expect(adapter.saveCache).toHaveBeenCalledWith(
      ['/cache/tool/opencode', '/cache/home/opencode'],
      'opencode-tools-v2-Linux-oc-1.0.0-sys-2.1.0',
    )
  })

  it('returns false and warns when save returns the failure sentinel', async () => {
    // #given an adapter that reports the -1 sentinel
    const logger = createTestLogger()
    const adapter = createMockToolsCacheAdapter({saveResult: -1})

    // #when saving
    const saved = await saveToolsCache({...options, logger, cacheAdapter: adapter})

    // #then the save is reported as unpersisted
    expect(saved).toBe(false)
    expect(logger.warning).toHaveBeenCalledWith('Tools cache save did not persist', {
      saveKey: 'opencode-tools-v2-Linux-oc-1.0.0-sys-2.1.0',
    })
  })

  it('treats a cache-already-exists error as success', async () => {
    // #given an adapter that throws the reservation-collision error
    const adapter = createMockToolsCacheAdapter({saveError: new Error('Cache already exists')})

    // #when saving
    const saved = await saveToolsCache({...options, cacheAdapter: adapter})

    // #then it is not a failure
    expect(saved).toBe(true)
  })

  it('handles save errors gracefully', async () => {
    // #given an adapter that throws
    const logger = createTestLogger()
    const adapter = createMockToolsCacheAdapter({saveError: new Error('disk full')})

    // #when saving
    const saved = await saveToolsCache({...options, logger, cacheAdapter: adapter})

    // #then it reports failure and warns
    expect(saved).toBe(false)
    expect(logger.warning).toHaveBeenCalledWith('Tools cache save failed', {error: 'disk full'})
  })
})

describe('tools cache key with the fro.bot plugin version (OpenCode V2)', () => {
  const V2_COMPONENTS = {...COMPONENTS, frobotPluginVersion: '0.1.0'} as const

  it('adds the plugin version to the primary and restore keys', () => {
    // #given / #when
    const key = buildToolsCacheKey(V2_COMPONENTS)
    const [restoreKey] = buildToolsRestoreKeys(V2_COMPONENTS)

    // #then
    expect(key).toBe('opencode-tools-v2-Linux-oc-1.0.0-sys-2.1.0-fbp-0.1.0')
    expect(restoreKey).toBe('opencode-tools-v2-Linux-oc-1.0.0-sys-2.1.0-fbp-0.1.0-')
  })

  it('misses an entry saved under a different plugin version, and never matches a V1 key', () => {
    expect(buildToolsCacheKey({...V2_COMPONENTS, frobotPluginVersion: '0.2.0'})).not.toBe(
      buildToolsCacheKey(V2_COMPONENTS),
    )
    expect(buildToolsCacheKey(V2_COMPONENTS)).not.toBe(buildToolsCacheKey(COMPONENTS))
    expect(buildToolsCacheKey(V2_COMPONENTS).startsWith(`${buildToolsCacheKey(COMPONENTS)}-`)).toBe(true)
  })

  it('leaves the V1 key exactly as it was when no plugin version is given', () => {
    expect(buildToolsCacheKey(COMPONENTS)).toBe('opencode-tools-v2-Linux-oc-1.0.0-sys-2.1.0')
    expect(buildToolsRestoreKeys(COMPONENTS)).toEqual(['opencode-tools-v2-Linux-oc-1.0.0-sys-2.1.0-'])
  })

  it('threads the plugin version through restore and save', async () => {
    const adapter = createMockToolsCacheAdapter({restoreResult: 'hit-key'})

    await restoreToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      opencodeVersion: '1.0.0',
      systematicVersion: '2.1.0',
      frobotPluginVersion: '0.1.0',
      ...PATHS,
      cacheAdapter: adapter,
    })
    await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      opencodeVersion: '1.0.0',
      systematicVersion: '2.1.0',
      frobotPluginVersion: '0.1.0',
      ...PATHS,
      cacheAdapter: adapter,
    })

    expect(adapter.restoreCache).toHaveBeenCalledWith(
      expect.any(Array),
      'opencode-tools-v2-Linux-oc-1.0.0-sys-2.1.0-fbp-0.1.0',
      ['opencode-tools-v2-Linux-oc-1.0.0-sys-2.1.0-fbp-0.1.0-'],
    )
    expect(adapter.saveCache).toHaveBeenCalledWith(
      expect.any(Array),
      'opencode-tools-v2-Linux-oc-1.0.0-sys-2.1.0-fbp-0.1.0',
    )
  })
})
