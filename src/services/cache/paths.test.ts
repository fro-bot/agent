import type {CacheAdapter} from './types.js'
import * as fs from 'node:fs/promises'
import {createRequire} from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {buildCachePaths} from './paths.js'
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

describe('buildCachePaths', () => {
  const storagePath = '/tmp/workspace/storage'
  const projectIdPath = '/tmp/workspace/.project-id'

  it('includes opencode.db (and no -wal/-shm sidecars) for a sqlite backend', async () => {
    const paths = await buildCachePaths(storagePath, projectIdPath, '1.2.0')

    expect(paths).toEqual([storagePath, projectIdPath, path.join('/tmp/workspace', 'opencode.db')])
  })

  it('omits opencode.db entirely for a non-sqlite backend', async () => {
    const paths = await buildCachePaths(storagePath, projectIdPath, '1.0.0')

    expect(paths).toEqual([storagePath, projectIdPath])
  })

  it('omits projectIdPath when not provided', async () => {
    const paths = await buildCachePaths(storagePath, undefined, '1.0.0')

    expect(paths).toEqual([storagePath])
  })

  describe('with a null opencodeVersion', () => {
    // A null version makes isSqliteBackend probe process.env.XDG_DATA_HOME (or
    // ~/.local/share) for a global opencode.db, not anything derived from storagePath —
    // so the result of buildCachePaths(..., null) depends on filesystem state at call
    // time, not purely on its arguments. Restore and save must therefore be called with
    // the same (non-null, ideally) version for the shared-hash guarantee this module
    // exists for to hold; passing null on one side and a string on the other can make the
    // two calls disagree about whether opencode.db is included at all.
    let xdgDataHome: string
    let originalXdgDataHome: string | undefined

    beforeEach(async () => {
      xdgDataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'paths-test-xdg-'))
      originalXdgDataHome = process.env.XDG_DATA_HOME
      process.env.XDG_DATA_HOME = xdgDataHome
    })

    afterEach(async () => {
      if (originalXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME
      } else {
        process.env.XDG_DATA_HOME = originalXdgDataHome
      }
      await fs.rm(xdgDataHome, {recursive: true, force: true})
    })

    it('includes opencode.db when the global db exists on disk', async () => {
      const dbDir = path.join(xdgDataHome, 'opencode')
      await fs.mkdir(dbDir, {recursive: true})
      await fs.writeFile(path.join(dbDir, 'opencode.db'), 'data')

      const paths = await buildCachePaths(storagePath, projectIdPath, null)

      expect(paths).toEqual([storagePath, projectIdPath, path.join('/tmp/workspace', 'opencode.db')])
    })

    it('omits opencode.db when the global db does not exist on disk', async () => {
      const paths = await buildCachePaths(storagePath, projectIdPath, null)

      expect(paths).toEqual([storagePath, projectIdPath])
    })
  })
})

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
    // buildCachePaths (called with a sqlite-backend version) selects.
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
    // paths, and a sqlite-backend opencode version, with the object store disabled
    // (storeConfig omitted) and a spy CacheAdapter standing in for @actions/cache
    await restoreCache({
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      projectIdPath,
      opencodeVersion: '1.2.0',
      cacheAdapter: {restoreCache: restoreCacheFn, saveCache: async () => 1},
    })

    await saveCache({
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      projectIdPath,
      opencodeVersion: '1.2.0',
      cacheAdapter: {restoreCache: async () => undefined, saveCache: saveCacheFn},
    })

    // #when reading the exact path lists each real call site handed its adapter -- both
    // sides must actually have reached it, or an early return on either (SKIP_CACHE, a
    // declined save) would leave this comparing two fallbacks and passing for nothing
    expect(restoreCacheFn).toHaveBeenCalledTimes(1)
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
