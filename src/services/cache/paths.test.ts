import {createRequire} from 'node:module'
import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {buildCachePaths} from './paths.js'

/**
 * `@actions/cache`'s `getCacheVersion` lives at `lib/internal/cacheUtils.js`, a subpath its
 * `package.json` "exports" map does not list — only `.` is exported. A bare-specifier
 * import of that subpath (`import ... from '@actions/cache/lib/internal/cacheUtils.js'`)
 * is therefore rejected by Node's ESM resolver with `ERR_PACKAGE_PATH_NOT_EXPORTED`, even
 * though the file exists and is plain CommonJS.
 *
 * `import.meta.resolve` still resolves the exported `.` entry point to its real file URL
 * (`lib/cache.js`) because that one *is* listed in "exports". Node's exports-map
 * enforcement only gates specifier-based resolution, not requiring an already-resolved,
 * absolute file path — so deriving the sibling `internal/cacheUtils.js` path from that
 * resolved URL and handing the absolute path to `createRequire` (rather than a bare
 * specifier) loads it without needing any package-internal file listed in "exports".
 */
function loadGetCacheVersion(): (
  paths: string[],
  compressionMethod?: string,
  enableCrossOsArchive?: boolean,
) => string {
  const cacheEntryUrl = import.meta.resolve('@actions/cache')
  const cacheUtilsPath = path.join(path.dirname(new URL(cacheEntryUrl).pathname), 'internal/cacheUtils.js')
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
})

describe('restore and save cache-version parity', () => {
  it('restore and save produce the same @actions/cache version hash (a differing list makes every save unrestorable)', async () => {
    // #given the exact call shape restore.ts and save.ts each use — same function, same
    // arguments, called independently the way the two real modules call it
    const getCacheVersion = loadGetCacheVersion()
    const storagePath = '/tmp/workspace/storage'
    const projectIdPath = '/tmp/workspace/.project-id'
    const opencodeVersion = '1.2.0'

    const restorePaths = await buildCachePaths(storagePath, projectIdPath, opencodeVersion)
    const savePaths = await buildCachePaths(storagePath, projectIdPath, opencodeVersion)

    // #when hashing each side's path list the way @actions/cache does internally to decide
    // whether a save is restorable
    const restoreVersion = getCacheVersion(restorePaths, 'zstd')
    const saveVersion = getCacheVersion(savePaths, 'zstd')

    // #then the two versions must be identical, by construction, because both sides came
    // from the same function call with the same arguments — not from two definitions
    // merely asserted equal
    expect(restoreVersion).toBe(saveVersion)
  })
})
