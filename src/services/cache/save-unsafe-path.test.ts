import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {findUnsafeSessionPath, saveCache, writeStorageVersion} from './save.js'

describe('session path safety before a save', () => {
  let dir: string
  let dataDir: string
  let storagePath: string
  let projectIdPath: string
  let secret: string

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'save-unsafe-')))
    dataDir = path.join(dir, 'opencode')
    storagePath = path.join(dataDir, 'storage')
    projectIdPath = path.join(dir, 'repo', '.git', 'opencode')
    fs.mkdirSync(storagePath, {recursive: true})
    fs.mkdirSync(path.dirname(projectIdPath), {recursive: true})
    fs.writeFileSync(path.join(dataDir, 'opencode.db'), 'db')
    secret = path.join(dir, 'secret.txt')
    fs.writeFileSync(secret, 'runner secret')
  })
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  it('accepts a normal layout, including missing files', async () => {
    expect(await findUnsafeSessionPath(storagePath, projectIdPath, ['opencode.db', 'opencode.db-wal'])).toBeNull()
  })

  it('flags a symlinked database file, storage dir, data dir and project-id file', async () => {
    // #given each in turn replaced by a link
    fs.rmSync(path.join(dataDir, 'opencode.db'))
    fs.symlinkSync(secret, path.join(dataDir, 'opencode.db'))
    expect(await findUnsafeSessionPath(storagePath, projectIdPath, ['opencode.db'])).toBe(
      path.join(dataDir, 'opencode.db'),
    )
    fs.rmSync(path.join(dataDir, 'opencode.db'))

    fs.symlinkSync(secret, projectIdPath)
    expect(await findUnsafeSessionPath(storagePath, projectIdPath, [])).toBe(projectIdPath)
    fs.rmSync(projectIdPath)

    fs.rmSync(storagePath, {recursive: true})
    fs.symlinkSync(dir, storagePath)
    expect(await findUnsafeSessionPath(storagePath, projectIdPath, [])).toBe(storagePath)
  })

  it('flags a database file that is a directory', async () => {
    fs.rmSync(path.join(dataDir, 'opencode.db'))
    fs.mkdirSync(path.join(dataDir, 'opencode.db'))
    expect(await findUnsafeSessionPath(storagePath, projectIdPath, ['opencode.db'])).toBe(
      path.join(dataDir, 'opencode.db'),
    )
  })

  it('declines the whole save, touching neither the cache nor the store, when a path is a symlink', async () => {
    // #given a symlinked database
    fs.rmSync(path.join(dataDir, 'opencode.db'))
    fs.symlinkSync(secret, path.join(dataDir, 'opencode.db'))
    const cacheAdapter = {saveCache: vi.fn(async () => 1), restoreCache: vi.fn()}

    // #when saving
    const result = await saveCache({
      components: {agentIdentity: 'github', repo: 'o/r', ref: 'main', os: 'Linux'} as never,
      runId: 1,
      logger: createMockLogger(),
      storagePath,
      authPath: path.join(dataDir, 'auth.json'),
      projectIdPath,
      cacheAdapter,
    })

    // #then it is declined for safety and nothing was saved
    expect(result.outcome).toBe('ownership-declined')
    expect(cacheAdapter.saveCache).not.toHaveBeenCalled()
  })

  describe('storage/.version', () => {
    it('is flagged when it is a symlink or a directory, and accepted when it is a regular file', async () => {
      // #given a regular .version first (the control)
      const version = path.join(storagePath, '.version')
      fs.writeFileSync(version, '1')
      expect(await findUnsafeSessionPath(storagePath, projectIdPath, [])).toBeNull()

      // #when it becomes a symlink, then a directory
      fs.rmSync(version)
      fs.symlinkSync(secret, version)
      expect(await findUnsafeSessionPath(storagePath, projectIdPath, [])).toBe(version)
      fs.rmSync(version)
      fs.mkdirSync(version)

      // #then both are refused
      expect(await findUnsafeSessionPath(storagePath, projectIdPath, [])).toBe(version)
    })

    it('declines the save and leaves the link target alone when .version is a symlink', async () => {
      // #given .version linked to a runner-owned file
      fs.symlinkSync(secret, path.join(storagePath, '.version'))
      const cacheAdapter = {saveCache: vi.fn(async () => 1), restoreCache: vi.fn()}

      // #when saving
      const result = await saveCache({
        components: {agentIdentity: 'github', repo: 'o/r', ref: 'main', os: 'Linux'} as never,
        runId: 1,
        logger: createMockLogger(),
        storagePath,
        authPath: path.join(dataDir, 'auth.json'),
        projectIdPath,
        cacheAdapter,
      })

      // #then it is declined, nothing was saved, and the target keeps its content
      expect(result.outcome).toBe('ownership-declined')
      expect(cacheAdapter.saveCache).not.toHaveBeenCalled()
      expect(fs.readFileSync(secret, 'utf8')).toBe('runner secret')
    })

    it('writes through a temp file and a rename, so a link planted at the last moment is replaced, never followed', async () => {
      // #given the control: the planted link IS followed by a plain write
      const version = path.join(storagePath, '.version')
      fs.symlinkSync(secret, version)
      fs.writeFileSync(version, 'followed')
      expect(fs.readFileSync(secret, 'utf8')).toBe('followed')
      fs.writeFileSync(secret, 'runner secret')
      fs.rmSync(version)
      fs.symlinkSync(secret, version)

      // #when writeStorageVersion runs over a link
      await writeStorageVersion(storagePath)

      // #then .version is now a regular file with the version, the target is untouched, and no temp file is left
      // One handle for the kind check and the read, so the file cannot change between them.
      const fd = fs.openSync(version, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        expect(fs.fstatSync(fd).isFile()).toBe(true)
        expect(fs.readFileSync(fd, 'utf8')).toBe('1')
      } finally {
        fs.closeSync(fd)
      }
      expect(fs.readFileSync(secret, 'utf8')).toBe('runner secret')
      expect(fs.readdirSync(storagePath).filter(name => name.startsWith('.version'))).toEqual(['.version'])
    })
  })
})
