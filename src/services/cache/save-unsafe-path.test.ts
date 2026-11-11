import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {findUnsafeSessionPath, saveCache} from './save.js'

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
})
