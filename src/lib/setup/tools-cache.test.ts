import type {Logger} from '../logger.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  buildToolsCacheKey,
  buildToolsRestoreKeys,
  restoreToolsCache,
  saveToolsCache,
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
  it('builds key with opencode-tools prefix', () => {
    // #given version info
    const os = 'Linux'
    const opencodeVersion = '1.0.0'
    const omoVersion = '3.5.5'

    // #when building cache key
    const key = buildToolsCacheKey({os, opencodeVersion, omoVersion})

    // #then key uses opencode-tools prefix
    expect(key).toBe('opencode-tools-Linux-oc-1.0.0-omo-3.5.5')
    expect(key).toMatch(/^opencode-tools-/)
  })

  it('handles latest version', () => {
    // #given latest opencodeVersion
    const os = 'Linux'
    const opencodeVersion = 'latest'
    const omoVersion = '3.5.5'

    // #when building cache key
    const key = buildToolsCacheKey({os, opencodeVersion, omoVersion})

    // #then key includes latest
    expect(key).toBe('opencode-tools-Linux-oc-latest-omo-3.5.5')
  })
})

describe('buildToolsRestoreKeys', () => {
  it('generates restore keys scoped to exact opencode+omo versions only', () => {
    // #given version info
    const os = 'Linux'
    const opencodeVersion = '1.0.0'
    const omoVersion = '3.5.5'

    // #when building restore keys
    const keys = buildToolsRestoreKeys({os, opencodeVersion, omoVersion})

    // #then only version-specific prefix key is returned (no broad OS-only fallback)
    expect(keys).toEqual(['opencode-tools-Linux-oc-1.0.0-omo-3.5.5-'])
  })

  it('does not include broad OS-only fallback key', () => {
    // #given version info
    const os = 'Linux'
    const opencodeVersion = '1.0.0'
    const omoVersion = '3.5.5'

    // #when building restore keys
    const keys = buildToolsRestoreKeys({os, opencodeVersion, omoVersion})

    // #then no OS-only key that could match stale versions
    const broadKeys = [...keys].filter(k => k === `opencode-tools-${os}-`)
    expect(broadKeys).toHaveLength(0)
  })

  it('generates restore keys for different OS', () => {
    // #given macOS version info
    const os = 'macOS'
    const opencodeVersion = '1.0.0'
    const omoVersion = '3.5.5'

    // #when building restore keys
    const keys = buildToolsRestoreKeys({os, opencodeVersion, omoVersion})

    // #then keys include macOS prefix
    expect(keys[0]).toBe('opencode-tools-macOS-oc-1.0.0-omo-3.5.5-')
  })
})

describe('restoreToolsCache', () => {
  let tempDir: string
  let toolCachePath: string
  let bunCachePath: string
  let omoConfigPath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-cache-test-'))
    toolCachePath = path.join(tempDir, 'tool-cache', 'opencode')
    bunCachePath = path.join(tempDir, 'tool-cache', 'bun')
    omoConfigPath = path.join(tempDir, 'config', 'opencode')
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('returns hit: false on cache miss', async () => {
    // #given a cache adapter that returns undefined (miss)
    const adapter = createMockToolsCacheAdapter({restoreResult: undefined})

    // #when restoring cache
    const result = await restoreToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      cacheAdapter: adapter,
    })

    // #then result indicates miss
    expect(result.hit).toBe(false)
    expect(result.restoredKey).toBeNull()
  })

  it('returns hit: true with key on cache hit', async () => {
    // #given a cache adapter that returns a key (hit)
    const restoredKey = 'opencode-tools-Linux-oc-1.0.0-omo-3.5.5'
    const adapter = createMockToolsCacheAdapter({restoreResult: restoredKey})

    // #when restoring cache
    const result = await restoreToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      cacheAdapter: adapter,
    })

    // #then result indicates hit
    expect(result.hit).toBe(true)
    expect(result.restoredKey).toBe(restoredKey)
  })

  it('passes correct paths to cache adapter', async () => {
    // #given a cache adapter
    let capturedPaths: string[] = []
    const adapter: ToolsCacheAdapter = {
      restoreCache: async paths => {
        capturedPaths = paths
        return undefined
      },
      saveCache: async () => 1,
    }

    // #when restoring cache
    await restoreToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      cacheAdapter: adapter,
    })

    // #then adapter receives all three paths
    expect(capturedPaths).toEqual([toolCachePath, bunCachePath, omoConfigPath])
  })

  it('handles restore errors gracefully', async () => {
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
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
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

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-cache-test-'))
    toolCachePath = path.join(tempDir, 'tool-cache', 'opencode')
    bunCachePath = path.join(tempDir, 'tool-cache', 'bun')
    omoConfigPath = path.join(tempDir, 'config', 'opencode')
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('saves cache successfully', async () => {
    // #given a cache adapter
    const adapter = createMockToolsCacheAdapter({saveResult: 1024})

    // #when saving cache
    const result = await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      cacheAdapter: adapter,
    })

    // #then save succeeds
    expect(result).toBe(true)
  })

  it('passes correct paths to cache adapter', async () => {
    // #given a cache adapter
    let capturedPaths: string[] = []
    const adapter: ToolsCacheAdapter = {
      restoreCache: async () => undefined,
      saveCache: async paths => {
        capturedPaths = paths
        return 1024
      },
    }

    // #when saving cache
    await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      cacheAdapter: adapter,
    })

    // #then adapter receives all three paths
    expect(capturedPaths).toEqual([toolCachePath, bunCachePath, omoConfigPath])
  })

  it('uses correct save key', async () => {
    // #given a cache adapter
    let capturedKey: string | null = null
    const adapter: ToolsCacheAdapter = {
      restoreCache: async () => undefined,
      saveCache: async (_paths, key) => {
        capturedKey = key
        return 1024
      },
    }

    // #when saving cache
    await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      cacheAdapter: adapter,
    })

    // #then uses correct key
    expect(capturedKey).toBe('opencode-tools-Linux-oc-1.0.0-omo-3.5.5')
  })

  it('handles cache already exists error', async () => {
    // #given a cache adapter that throws already exists error
    const adapter = createMockToolsCacheAdapter({
      saveError: new Error('Cache already exists'),
    })

    // #when saving cache
    const result = await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      cacheAdapter: adapter,
    })

    // #then treats as success
    expect(result).toBe(true)
  })

  it('handles save errors gracefully', async () => {
    // #given a cache adapter that throws other error
    const adapter = createMockToolsCacheAdapter({
      saveError: new Error('Network error'),
    })

    // #when saving cache
    const result = await saveToolsCache({
      logger: createTestLogger(),
      os: 'Linux',
      opencodeVersion: '1.0.0',
      omoVersion: '3.5.5',
      toolCachePath,
      bunCachePath,
      omoConfigPath,
      cacheAdapter: adapter,
    })

    // #then returns false instead of throwing
    expect(result).toBe(false)
  })
})
