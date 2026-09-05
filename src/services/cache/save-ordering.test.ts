import type {Logger} from '../../shared/logger.js'
import type {CacheKeyComponents} from './cache-key.js'
import type {CacheAdapter} from './types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// This suite pins the control-flow ordering save.ts's hasCacheableContent doc comment
// depends on: a 'failed' checkpoint outcome must make saveCache return before
// buildCachePaths is ever called, which is what makes it safe for that comment to
// say the write-ahead log can no longer be the sole holder of unmerged content by the
// time hasCacheableContent runs. A future change that reintroduced a decline-then-inspect
// path (checkpoint fails, but path-building and content inspection still proceed) would
// fail this test without needing to know anything about save.ts's internals.
const mocks = vi.hoisted(() => ({
  buildCachePaths: vi.fn(),
}))

vi.mock('./paths.js', async importOriginal => {
  const original = await importOriginal<typeof import('./paths.js')>()
  return {
    ...original,
    buildCachePaths: mocks.buildCachePaths.mockImplementation(original.buildCachePaths),
  }
})

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warning: () => {},
    error: () => {},
  }
}

// Never actually called in the failed-checkpoint test (the whole point is that saveCache
// returns before reaching it) and stubs the network call in the control case, so neither
// test depends on real @actions/cache behavior.
function createStubCacheAdapter(): CacheAdapter {
  return {
    restoreCache: async () => undefined,
    saveCache: async () => 1,
  }
}

const testComponents: CacheKeyComponents = {
  agentIdentity: 'github',
  repo: 'owner/repo',
  ref: 'main',
  os: 'Linux',
}

describe('saveCache checkpoint-then-paths ordering', () => {
  let tempDir: string
  let storagePath: string
  let authPath: string
  let dbPath: string

  beforeEach(async () => {
    vi.clearAllMocks()
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'save-ordering-'))
    storagePath = path.join(tempDir, 'workspace', 'storage')
    authPath = path.join(tempDir, 'auth.json')
    dbPath = path.join(path.dirname(storagePath), 'opencode.db')
    await fs.mkdir(storagePath, {recursive: true})
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('returns false without ever calling buildCachePaths when the checkpoint fails', async () => {
    // #given a database held under an exclusive lock by an in-progress transaction on
    // another connection, guaranteeing a real 'failed' checkpoint outcome — the harness's
    // only signal that a writer is still alive, since serverHandle.shutdown() cannot
    // observe the child process's exit
    const holder = new DatabaseSync(dbPath)
    holder.exec('PRAGMA journal_mode=WAL')
    holder.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT)')
    holder.exec("INSERT INTO sessions (data) VALUES ('session-1')")
    holder.exec('PRAGMA locking_mode=EXCLUSIVE')
    holder.exec('BEGIN IMMEDIATE')
    holder.exec("INSERT INTO sessions (data) VALUES ('in-flight')")

    const {saveCache} = await import('./save.js')

    // #when saving cache
    const result = await saveCache({
      components: testComponents,
      runId: 12345,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.2.0',
      cacheAdapter: createStubCacheAdapter(),
    })

    // #then the save is declined, and — the property this test exists to pin —
    // buildCachePaths is never reached, because the checkpoint's failure returns
    // before the path-building and content-inspection block below it ever runs
    expect(result).toMatchObject({cachePersisted: false, storePersisted: false, outcome: 'checkpoint-declined'})
    expect(mocks.buildCachePaths).not.toHaveBeenCalled()

    holder.exec('COMMIT')
    holder.close()
  })

  it('does call buildCachePaths once the checkpoint resolves (control case, proves the mock is wired correctly)', async () => {
    // #given a healthy workspace with no database at all — checkpointDatabase resolves
    // 'nothing-to-checkpoint' rather than 'failed'
    await fs.writeFile(path.join(storagePath, 'session.json'), '{"session":"created"}', 'utf8')

    const {saveCache} = await import('./save.js')

    // #when saving cache
    const result = await saveCache({
      components: testComponents,
      runId: 12345,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.2.0',
      cacheAdapter: createStubCacheAdapter(),
    })

    // #then the save proceeds and buildCachePaths is reached — confirming the mock
    // above would have caught a missing call in the failed-checkpoint case, rather than
    // silently passing because it is never exercised at all
    expect(result).toMatchObject({cachePersisted: true, outcome: 'persisted'})
    expect(mocks.buildCachePaths).toHaveBeenCalledTimes(1)
  })
})
