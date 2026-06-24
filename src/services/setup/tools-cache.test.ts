import type {Logger} from '../../shared/logger.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  buildCachePaths,
  buildToolsCacheKey,
  buildToolsRestoreKeys,
  restoreToolsCache,
  saveToolsCache,
  type CacheMode,
  type ToolsCacheAdapter,
} from './tools-cache.js'

// Create a silent logger for tests
function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warning: () => {},
    error: () => {},
  }
}

// Create a mock cache adapter for testing
function createMockToolsCacheAdapter(options: {
  restoreResult?: string | undefined
  saveResult?: number
  saveError?: Error
}): ToolsCacheAdapter {
  return {
    restoreCache: async () => options.restoreResult,
    saveCache: async () => {
      if (options.saveError != null) {
        throw options.saveError
      }
      return options.saveResult ?? 1
    },
  }
}

describe('buildToolsCacheKey', () => {
  it('builds enabled key with mode, opencode version, oMo version, Systematic version, and Bun version', () => {
    // #given version info with enabled mode
    const os = 'Linux'
    const bunVersion = '1.3.14'
    const opencodeVersion = '1.0.0'
    const omoVersion = '3.5.5'
    const systematicVersion = '2.1.0'
    const cacheMode: CacheMode = 'enabled'

    // #when building cache key
    const key = buildToolsCacheKey({os, bunVersion, opencodeVersion, omoVersion, systematicVersion, cacheMode})

    // #then key uses opencode-tools prefix with enabled mode, includes oMo version and Bun version
    expect(key).toBe('opencode-tools-Linux-enabled-oc-1.0.0-omo-3.5.5-sys-2.1.0-bun-1.3.14')
    expect(key).toMatch(/^opencode-tools-/)
    expect(key).toContain('-enabled-')
    expect(key).toContain('-omo-')
    expect(key).toContain('-bun-')
  })

  it('builds disabled key with mode, opencode version, Systematic version, and Bun version but NOT oMo version', () => {
    // #given version info with disabled mode
    const os = 'Linux'
    const bunVersion = '1.3.14'
    const opencodeVersion = '1.0.0'
    const omoVersion = '3.5.5'
    const systematicVersion = '2.1.0'
    const cacheMode: CacheMode = 'disabled'

    // #when building cache key
    const key = buildToolsCacheKey({os, bunVersion, opencodeVersion, omoVersion, systematicVersion, cacheMode})

    // #then key uses opencode-tools prefix with disabled mode, no oMo version, includes Bun version
    expect(key).toBe('opencode-tools-Linux-disabled-oc-1.0.0-sys-2.1.0-bun-1.3.14')
    expect(key).toMatch(/^opencode-tools-/)
    expect(key).toContain('-disabled-')
    expect(key).not.toContain('-omo-')
    expect(key).toContain('-bun-')
  })

  it('handles latest version in enabled mode', () => {
    // #given latest opencodeVersion
    const os = 'Linux'
    const bunVersion = '1.3.14'
    const opencodeVersion = 'latest'
    const omoVersion = '3.5.5'
    const systematicVersion = '2.1.0'
    const cacheMode: CacheMode = 'enabled'

    // #when building cache key
    const key = buildToolsCacheKey({os, bunVersion, opencodeVersion, omoVersion, systematicVersion, cacheMode})

    // #then key includes latest with enabled mode and Bun version
    expect(key).toBe('opencode-tools-Linux-enabled-oc-latest-omo-3.5.5-sys-2.1.0-bun-1.3.14')
  })

  it('handles latest version in disabled mode', () => {
    // #given latest opencodeVersion
    const os = 'Linux'
    const bunVersion = '1.3.14'
    const opencodeVersion = 'latest'
    const omoVersion = '3.5.5'
    const systematicVersion = '2.1.0'
    const cacheMode: CacheMode = 'disabled'

    // #when building cache key
    const key = buildToolsCacheKey({os, bunVersion, opencodeVersion, omoVersion, systematicVersion, cacheMode})

    // #then disabled key omits oMo even with latest, includes Bun version
    expect(key).toBe('opencode-tools-Linux-disabled-oc-latest-sys-2.1.0-bun-1.3.14')
    expect(key).not.toContain('-omo-')
  })

  it('preserves raw +harness.<sha> build-metadata in the cache key for harness versions', () => {
    // #given a harness OpenCode version with +harness.<sha> build-metadata suffix
    const os = 'Linux'
    const bunVersion = '1.3.14'
    const opencodeVersion = '1.17.3+harness.2c9cdbd2'
    const omoVersion = '3.5.5'
    const systematicVersion = '2.1.0'
    const cacheMode: CacheMode = 'enabled'

    // #when building the cache key
    const key = buildToolsCacheKey({os, bunVersion, opencodeVersion, omoVersion, systematicVersion, cacheMode})

    // #then the raw +harness.<sha> form is embedded verbatim in the key (NOT the -harness. identity form
    // used by toolCache.find/cacheDir — the cache KEY intentionally uses the raw semver metadata so
    // harness builds never collide with stock builds of the same base version)
    expect(key).toContain('+harness.2c9cdbd2')
    expect(key).toBe('opencode-tools-Linux-enabled-oc-1.17.3+harness.2c9cdbd2-omo-3.5.5-sys-2.1.0-bun-1.3.14')
  })

  it('different bunVersion values produce different keys (cache invalidation)', () => {
    // #given same components except bunVersion
    const base = {
      os: 'Linux',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'enabled' as CacheMode,
    }

    // #when building keys with different Bun versions
    const keyA = buildToolsCacheKey({...base, bunVersion: '1.3.14'})
    const keyB = buildToolsCacheKey({...base, bunVersion: '1.4.0'})

    // #then keys differ — a Bun upgrade invalidates the cache
    expect(keyA).not.toBe(keyB)
    expect(keyA).toContain('-bun-1.3.14')
    expect(keyB).toContain('-bun-1.4.0')
  })

  it('same components always produce the same key (stability)', () => {
    // #given identical components
    const components = {
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'enabled' as CacheMode,
    }

    // #when building the key twice
    const key1 = buildToolsCacheKey(components)
    const key2 = buildToolsCacheKey(components)

    // #then the key is stable
    expect(key1).toBe(key2)
  })
})

describe('buildToolsRestoreKeys', () => {
  it('generates enabled restore keys scoped to exact opencode+omo+bun versions only', () => {
    // #given version info with enabled mode
    const os = 'Linux'
    const bunVersion = '1.3.14'
    const opencodeVersion = '1.0.0'
    const omoVersion = '3.5.5'
    const systematicVersion = '2.1.0'
    const cacheMode: CacheMode = 'enabled'

    // #when building restore keys
    const keys = buildToolsRestoreKeys({os, bunVersion, opencodeVersion, omoVersion, systematicVersion, cacheMode})

    // #then only version-specific prefix key with enabled mode is returned, includes bun segment
    expect(keys).toEqual(['opencode-tools-Linux-enabled-oc-1.0.0-omo-3.5.5-sys-2.1.0-bun-1.3.14-'])
  })

  it('generates disabled restore keys scoped to opencode+systematic+bun versions without oMo', () => {
    // #given version info with disabled mode
    const os = 'Linux'
    const bunVersion = '1.3.14'
    const opencodeVersion = '1.0.0'
    const omoVersion = '3.5.5'
    const systematicVersion = '2.1.0'
    const cacheMode: CacheMode = 'disabled'

    // #when building restore keys
    const keys = buildToolsRestoreKeys({os, bunVersion, opencodeVersion, omoVersion, systematicVersion, cacheMode})

    // #then only version-specific prefix key with disabled mode, no oMo version, includes bun segment
    expect(keys).toEqual(['opencode-tools-Linux-disabled-oc-1.0.0-sys-2.1.0-bun-1.3.14-'])
  })

  it('does not include broad OS-only fallback key for enabled mode', () => {
    // #given version info with enabled mode
    const os = 'Linux'
    const bunVersion = '1.3.14'
    const opencodeVersion = '1.0.0'
    const omoVersion = '3.5.5'
    const systematicVersion = '2.1.0'
    const cacheMode: CacheMode = 'enabled'

    // #when building restore keys
    const keys = buildToolsRestoreKeys({os, bunVersion, opencodeVersion, omoVersion, systematicVersion, cacheMode})

    // #then no OS-only key that could match stale versions
    const broadKeys = [...keys].filter(k => k === `opencode-tools-${os}-`)
    expect(broadKeys).toHaveLength(0)
  })

  it('generates enabled restore keys for different OS', () => {
    // #given macOS version info
    const os = 'macOS'
    const bunVersion = '1.3.14'
    const opencodeVersion = '1.0.0'
    const omoVersion = '3.5.5'
    const systematicVersion = '2.1.0'
    const cacheMode: CacheMode = 'enabled'

    // #when building restore keys
    const keys = buildToolsRestoreKeys({os, bunVersion, opencodeVersion, omoVersion, systematicVersion, cacheMode})

    // #then keys include macOS prefix with enabled mode and bun segment
    expect(keys[0]).toBe('opencode-tools-macOS-enabled-oc-1.0.0-omo-3.5.5-sys-2.1.0-bun-1.3.14-')
  })

  it('generates disabled restore keys for different OS', () => {
    // #given macOS version info
    const os = 'macOS'
    const bunVersion = '1.3.14'
    const opencodeVersion = '1.0.0'
    const omoVersion = '3.5.5'
    const systematicVersion = '2.1.0'
    const cacheMode: CacheMode = 'disabled'

    // #when building restore keys
    const keys = buildToolsRestoreKeys({os, bunVersion, opencodeVersion, omoVersion, systematicVersion, cacheMode})

    // #then keys include macOS prefix with disabled mode, no oMo, includes bun segment
    expect(keys[0]).toBe('opencode-tools-macOS-disabled-oc-1.0.0-sys-2.1.0-bun-1.3.14-')
  })

  it('enabled and disabled restore keys cannot cross-match each other', () => {
    // #given same version info for both modes
    const os = 'Linux'
    const bunVersion = '1.3.14'
    const opencodeVersion = '1.0.0'
    const omoVersion = '3.5.5'
    const systematicVersion = '2.1.0'

    // #when building restore keys for both modes
    const enabledKeys = buildToolsRestoreKeys({
      os,
      bunVersion,
      opencodeVersion,
      omoVersion,
      systematicVersion,
      cacheMode: 'enabled',
    })
    const disabledKeys = buildToolsRestoreKeys({
      os,
      bunVersion,
      opencodeVersion,
      omoVersion,
      systematicVersion,
      cacheMode: 'disabled',
    })

    // #then no disabled restore key is a prefix of any enabled key, and vice versa
    for (const dk of disabledKeys) {
      for (const ek of enabledKeys) {
        // Remove trailing dash for prefix comparison
        const dkPrefix = dk.endsWith('-') ? dk : `${dk}-`
        const ekPrefix = ek.endsWith('-') ? ek : `${ek}-`
        expect(ek.startsWith(dkPrefix)).toBe(false)
        expect(dk.startsWith(ekPrefix)).toBe(false)
      }
    }
  })

  it('different bunVersion values produce different restore keys', () => {
    // #given same components except bunVersion
    const base = {
      os: 'Linux',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'enabled' as CacheMode,
    }

    // #when building restore keys with different Bun versions
    const keysA = buildToolsRestoreKeys({...base, bunVersion: '1.3.14'})
    const keysB = buildToolsRestoreKeys({...base, bunVersion: '1.4.0'})

    // #then restore keys differ — a Bun upgrade invalidates the restore prefix
    expect(keysA[0]).not.toBe(keysB[0])
    expect(keysA[0]).toContain('-bun-1.3.14-')
    expect(keysB[0]).toContain('-bun-1.4.0-')
  })
})

describe('buildCachePaths', () => {
  const toolCachePath = '/opt/hostedtoolcache/opencode'
  const bunCachePath = '/opt/hostedtoolcache/bun'
  const omoConfigPath = '/home/user/.config/opencode'
  const opencodeCachePath = '/home/user/.cache/opencode'

  it('enabled mode includes Bun and config paths', () => {
    // #given enabled mode

    // #when building paths
    const paths = buildCachePaths({
      cacheMode: 'enabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
    })

    // #then all four paths are included
    expect(paths).toEqual([toolCachePath, bunCachePath, omoConfigPath, opencodeCachePath])
  })

  it('disabled mode excludes Bun and config paths', () => {
    // #given disabled mode

    // #when building paths
    const paths = buildCachePaths({
      cacheMode: 'disabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
    })

    // #then only OpenCode tool cache and package cache are included
    expect(paths).toEqual([toolCachePath, opencodeCachePath])
    expect(paths).not.toContain(bunCachePath)
    expect(paths).not.toContain(omoConfigPath)
  })
})

describe('restoreToolsCache', () => {
  let tempDir: string
  let toolCachePath: string
  let bunCachePath: string
  let omoConfigPath: string
  let opencodeCachePath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-cache-test-'))
    toolCachePath = path.join(tempDir, 'tool-cache', 'opencode')
    bunCachePath = path.join(tempDir, 'tool-cache', 'bun')
    omoConfigPath = path.join(tempDir, 'config', 'opencode')
    opencodeCachePath = path.join(tempDir, 'cache', 'opencode')
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('returns hit: false on cache miss in enabled mode', async () => {
    // #given a cache adapter that returns undefined (miss)
    const adapter = createMockToolsCacheAdapter({restoreResult: undefined})

    // #when restoring cache in enabled mode
    const result = await restoreToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'enabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then result indicates miss
    expect(result.hit).toBe(false)
    expect(result.restoredKey).toBeNull()
  })

  it('returns hit: false on cache miss in disabled mode', async () => {
    // #given a cache adapter that returns undefined (miss)
    const adapter = createMockToolsCacheAdapter({restoreResult: undefined})

    // #when restoring cache in disabled mode
    const result = await restoreToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'disabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then result indicates miss
    expect(result.hit).toBe(false)
    expect(result.restoredKey).toBeNull()
  })

  it('returns hit: true with key on cache hit in enabled mode', async () => {
    // #given a cache adapter that returns a key (hit)
    const restoredKey = 'opencode-tools-Linux-enabled-oc-1.0.0-omo-3.5.5-sys-2.1.0-bun-1.3.14'
    const adapter = createMockToolsCacheAdapter({restoreResult: restoredKey})

    // #when restoring cache
    const result = await restoreToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'enabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then result indicates hit
    expect(result.hit).toBe(true)
    expect(result.restoredKey).toBe(restoredKey)
  })

  it('passes enabled-mode paths to cache adapter', async () => {
    // #given a cache adapter
    let capturedPaths: string[] = []
    const adapter: ToolsCacheAdapter = {
      restoreCache: async paths => {
        capturedPaths = paths
        return undefined
      },
      saveCache: async () => 1,
    }

    // #when restoring cache in enabled mode
    await restoreToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'enabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then adapter receives all four paths
    expect(capturedPaths).toEqual([toolCachePath, bunCachePath, omoConfigPath, opencodeCachePath])
  })

  it('passes disabled-mode paths to cache adapter (no Bun, no config)', async () => {
    // #given a cache adapter
    let capturedPaths: string[] = []
    const adapter: ToolsCacheAdapter = {
      restoreCache: async paths => {
        capturedPaths = paths
        return undefined
      },
      saveCache: async () => 1,
    }

    // #when restoring cache in disabled mode
    await restoreToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'disabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then adapter receives only OpenCode tool cache and package cache
    expect(capturedPaths).toEqual([toolCachePath, opencodeCachePath])
    expect(capturedPaths).not.toContain(bunCachePath)
    expect(capturedPaths).not.toContain(omoConfigPath)
  })

  it('handles restore errors gracefully in enabled mode', async () => {
    // #given a cache adapter that throws
    const adapter: ToolsCacheAdapter = {
      restoreCache: async () => {
        throw new Error('Network error')
      },
      saveCache: async () => 1,
    }

    // #when restoring cache
    const result = await restoreToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'enabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then returns miss instead of throwing
    expect(result.hit).toBe(false)
    expect(result.restoredKey).toBeNull()
  })

  it('handles restore errors gracefully in disabled mode', async () => {
    // #given a cache adapter that throws
    const adapter: ToolsCacheAdapter = {
      restoreCache: async () => {
        throw new Error('Network error')
      },
      saveCache: async () => 1,
    }

    // #when restoring cache in disabled mode
    const result = await restoreToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'disabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then returns miss instead of throwing
    expect(result.hit).toBe(false)
    expect(result.restoredKey).toBeNull()
  })
})

describe('saveToolsCache', () => {
  let tempDir: string
  let toolCachePath: string
  let bunCachePath: string
  let omoConfigPath: string
  let opencodeCachePath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-cache-test-'))
    toolCachePath = path.join(tempDir, 'tool-cache', 'opencode')
    bunCachePath = path.join(tempDir, 'tool-cache', 'bun')
    omoConfigPath = path.join(tempDir, 'config', 'opencode')
    opencodeCachePath = path.join(tempDir, 'cache', 'opencode')
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('saves cache successfully in enabled mode', async () => {
    // #given a cache adapter
    const adapter = createMockToolsCacheAdapter({saveResult: 1024})

    // #when saving cache in enabled mode
    const result = await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'enabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then save succeeds
    expect(result).toBe(true)
  })

  it('saves cache successfully in disabled mode', async () => {
    // #given a cache adapter
    const adapter = createMockToolsCacheAdapter({saveResult: 1024})

    // #when saving cache in disabled mode
    const result = await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'disabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then save succeeds
    expect(result).toBe(true)
  })

  it('passes enabled-mode paths to cache adapter', async () => {
    // #given a cache adapter
    let capturedPaths: string[] = []
    const adapter: ToolsCacheAdapter = {
      restoreCache: async () => undefined,
      saveCache: async paths => {
        capturedPaths = paths
        return 1024
      },
    }

    // #when saving cache in enabled mode
    await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'enabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then adapter receives all four paths
    expect(capturedPaths).toEqual([toolCachePath, bunCachePath, omoConfigPath, opencodeCachePath])
  })

  it('passes disabled-mode paths to cache adapter (no Bun, no config)', async () => {
    // #given a cache adapter
    let capturedPaths: string[] = []
    const adapter: ToolsCacheAdapter = {
      restoreCache: async () => undefined,
      saveCache: async paths => {
        capturedPaths = paths
        return 1024
      },
    }

    // #when saving cache in disabled mode
    await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'disabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then adapter receives only OpenCode tool cache and package cache
    expect(capturedPaths).toEqual([toolCachePath, opencodeCachePath])
    expect(capturedPaths).not.toContain(bunCachePath)
    expect(capturedPaths).not.toContain(omoConfigPath)
  })

  it('uses correct enabled save key', async () => {
    // #given a cache adapter
    let capturedKey: string | null = null
    const adapter: ToolsCacheAdapter = {
      restoreCache: async () => undefined,
      saveCache: async (_paths, key) => {
        capturedKey = key
        return 1024
      },
    }

    // #when saving cache in enabled mode
    await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'enabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then uses correct enabled key
    expect(capturedKey).toBe('opencode-tools-Linux-enabled-oc-1.0.0-omo-3.5.5-sys-2.1.0-bun-1.3.14')
  })

  it('uses correct disabled save key (no oMo version)', async () => {
    // #given a cache adapter
    let capturedKey: string | null = null
    const adapter: ToolsCacheAdapter = {
      restoreCache: async () => undefined,
      saveCache: async (_paths, key) => {
        capturedKey = key
        return 1024
      },
    }

    // #when saving cache in disabled mode
    await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'disabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then uses correct disabled key without oMo version, includes Bun version
    expect(capturedKey).toBe('opencode-tools-Linux-disabled-oc-1.0.0-sys-2.1.0-bun-1.3.14')
  })

  it('handles cache already exists error in enabled mode', async () => {
    // #given a cache adapter that throws already exists error
    const adapter = createMockToolsCacheAdapter({
      saveError: new Error('Cache already exists'),
    })

    // #when saving cache in enabled mode
    const result = await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'enabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then treats as success
    expect(result).toBe(true)
  })

  it('handles cache already exists error in disabled mode', async () => {
    // #given a cache adapter that throws already exists error
    const adapter = createMockToolsCacheAdapter({
      saveError: new Error('Cache already exists'),
    })

    // #when saving cache in disabled mode
    const result = await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'disabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then treats as success
    expect(result).toBe(true)
  })

  it('handles save errors gracefully in enabled mode', async () => {
    // #given a cache adapter that throws other error
    const adapter = createMockToolsCacheAdapter({
      saveError: new Error('Network error'),
    })

    // #when saving cache in enabled mode
    const result = await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'enabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then returns false instead of throwing
    expect(result).toBe(false)
  })

  it('handles save errors gracefully in disabled mode', async () => {
    // #given a cache adapter that throws other error
    const adapter = createMockToolsCacheAdapter({
      saveError: new Error('Network error'),
    })

    // #when saving cache in disabled mode
    const result = await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      bunVersion: '1.3.14',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      systematicVersion: '2.1.0',
      cacheMode: 'disabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      opencodeCachePath,
      cacheAdapter: adapter,
    })

    // #then returns false instead of throwing
    expect(result).toBe(false)
  })
})
