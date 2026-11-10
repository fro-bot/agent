import type {CacheAdapter} from './types.js'
import * as fs from 'node:fs/promises'
import {createRequire} from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {restoreCache} from './restore.js'
import {saveCache} from './save.js'

/**
 * `@actions/cache@6.2.0` is itself ESM (`"type": "module"`, plain `export function`), and
 * Node 24 supports `require()`-ing a synchronous ESM module. `getCacheVersion` lives at
 * `lib/internal/cacheUtils.js`, a subpath the package's `exports` map does not list (only
 * `.` is exported), so a bare-specifier import of that subpath is rejected with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. Exports-map enforcement gates specifier-based
 * resolution, not an already-resolved absolute file path, so `import.meta.resolve` on the
 * exported `.` entry point (which *is* listed) plus `createRequire` on the derived sibling
 * path loads it without needing anything beyond `.` in "exports".
 */
function loadGetCacheVersion(): (
  paths: string[],
  compressionMethod?: string,
  enableCrossOsArchive?: boolean,
) => string {
  const cacheEntryUrl = import.meta.resolve('@actions/cache')
  const cacheUtilsPath = path.join(path.dirname(fileURLToPath(cacheEntryUrl)), 'internal/cacheUtils.js')
  const require = createRequire(import.meta.url)
  const cacheUtils = require(cacheUtilsPath) as {
    getCacheVersion: (paths: string[], compressionMethod?: string, enableCrossOsArchive?: boolean) => string
  }
  return cacheUtils.getCacheVersion
}

function createTestLogger() {
  return {
    debug: () => {},
    info: () => {},
    warning: () => {},
    error: () => {},
  }
}

describe('restore/save cache-version parity (adapter boundary)', () => {
  let tempDir: string
  let storagePath: string
  let projectIdPath: string
  let authPath: string

  const testComponents = {
    agentIdentity: 'github' as const,
    repo: 'owner/repo',
    ref: 'main',
    os: 'Linux',
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paths-parity-test-'))
    storagePath = path.join(tempDir, 'storage')
    projectIdPath = path.join(tempDir, '.project-id')
    authPath = path.join(tempDir, 'auth.json')
    await fs.mkdir(storagePath, {recursive: true})
    // Content in storagePath satisfies hasCacheableContent on the save side.
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')
    // A non-empty opencode.db with no -wal beside it: checkpointDatabase sees a missing
    // write-ahead log and reports 'nothing-to-checkpoint' without ever opening the file as
    // SQLite, so this needs no real database — just a nonzero-size file at the path
    // buildCachePathsV2 selects.
    await fs.writeFile(path.join(tempDir, 'opencode.db'), 'db data')
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  // Named so a future re-split (restore and save building their path lists from two
  // different functions again — the #1519/#1546 shape) fails this test by name.
  it('restoreCache and saveCache request identical paths, producing the same @actions/cache version hash (a differing list makes every save unrestorable)', async () => {
    const restoreCacheFn = vi.fn<CacheAdapter['restoreCache']>().mockResolvedValue(undefined)
    const saveCacheFn = vi.fn<CacheAdapter['saveCache']>().mockResolvedValue(1)

    // #given restoreCache and saveCache each driven with the same components, storage
    // paths, with the object store disabled
    // (storeConfig omitted) and a spy CacheAdapter standing in for @actions/cache
    await restoreCache({
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      projectIdPath,
      cacheAdapter: {restoreCache: restoreCacheFn, saveCache: async () => 1},
    })

    await saveCache({
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      projectIdPath,
      cacheAdapter: {restoreCache: async () => undefined, saveCache: saveCacheFn},
    })

    // #when reading the exact path lists each real call site handed its adapter -- both
    // sides must actually have reached it, or an early return on either (SKIP_CACHE, a
    // declined save) would leave this comparing two fallbacks and passing for nothing
    //
    // (A restore walks four tiers, V2 first; the first call is the V2 tier a save is later restored by.)
    expect(restoreCacheFn).toHaveBeenCalled()
    expect(saveCacheFn).toHaveBeenCalledTimes(1)
    const restorePaths = restoreCacheFn.mock.calls[0]?.[0] ?? []
    const savePaths = saveCacheFn.mock.calls[0]?.[0] ?? []
    expect(restorePaths.length).toBeGreaterThan(0)

    // #then the two lists are identical, and hashing them the way @actions/cache does
    // internally to decide whether a save is restorable produces the same version
    expect(restorePaths).toEqual(savePaths)

    const getCacheVersion = loadGetCacheVersion()
    expect(getCacheVersion(restorePaths, 'zstd')).toBe(getCacheVersion(savePaths, 'zstd'))
  })
})
