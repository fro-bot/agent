import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {LOG_SNAPSHOT_MAX_BYTES, resolveLogReadPath, snapshotLogDirectory} from './log-snapshot.js'

const RUNNER_UID = process.getuid?.() ?? 0

async function listFiles(root: string): Promise<readonly string[]> {
  const entries = await fs.readdir(root, {recursive: true, withFileTypes: true})
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort()
}

describe('snapshotLogDirectory', () => {
  let base: string
  let source: string
  let tempRoot: string

  beforeEach(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'log-snapshot-')))
    source = path.join(base, 'log')
    tempRoot = path.join(base, 'runner-temp')
    await fs.mkdir(source, {recursive: true})
    await fs.mkdir(tempRoot, {recursive: true})
  })

  afterEach(async () => {
    await fs.rm(base, {recursive: true, force: true})
  })

  it('copies the regular files, nested ones included, into a fresh private directory under the temp root', async () => {
    // #given a log directory with a top-level and a nested file
    await fs.writeFile(path.join(source, 'a.log'), 'alpha')
    await fs.mkdir(path.join(source, 'nested'))
    await fs.writeFile(path.join(source, 'nested', 'b.log'), 'beta')
    await fs.writeFile(path.join(source, 'empty.log'), '')

    // #when
    const snapshot = await snapshotLogDirectory({source, tempRoot, runnerUid: RUNNER_UID, logger: createMockLogger()})

    // #then the copy is outside the source, under the temp root, and private to the runner
    expect(snapshot).not.toBeNull()
    const dir = snapshot as string
    expect(path.dirname(dir)).toBe(tempRoot)
    expect(dir.startsWith(source)).toBe(false)
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700)
    expect(await listFiles(dir)).toEqual(['a.log', 'empty.log', path.join('nested', 'b.log')])
    expect(await fs.readFile(path.join(dir, 'nested', 'b.log'), 'utf8')).toBe('beta')
  })

  it('gives each invocation its own directory', async () => {
    // #given one log directory snapshotted twice
    await fs.writeFile(path.join(source, 'a.log'), 'alpha')
    const logger = createMockLogger()

    // #when
    const first = await snapshotLogDirectory({source, tempRoot, runnerUid: RUNNER_UID, logger})
    const second = await snapshotLogDirectory({source, tempRoot, runnerUid: RUNNER_UID, logger})

    // #then
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first).not.toBe(second)
  })

  it('does not follow a symlinked file or directory out of the log directory', async () => {
    // #given a runner-owned secret outside the log directory, and links to it planted inside
    const outside = path.join(base, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret.txt'), 'runner-secret')
    await fs.writeFile(path.join(source, 'real.log'), 'real')
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(source, 'leak.log'))
    await fs.symlink(outside, path.join(source, 'leak-dir'))
    const logger = createMockLogger()

    // #when
    const snapshot = await snapshotLogDirectory({source, tempRoot, runnerUid: RUNNER_UID, logger})

    // #then only the regular file was copied, and the skip was reported without naming a path
    expect(await listFiles(snapshot as string)).toEqual(['real.log'])
    expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('not regular'), {skipped: 2})
  })

  it('refuses a log directory that is itself a symlink', async () => {
    // #given the log path replaced by a link to a runner-owned directory
    const outside = path.join(base, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret.txt'), 'runner-secret')
    const linked = path.join(base, 'linked-log')
    await fs.symlink(outside, linked)

    // #when
    const snapshot = await snapshotLogDirectory({
      source: linked,
      tempRoot,
      runnerUid: RUNNER_UID,
      logger: createMockLogger(),
    })

    // #then nothing was copied and no directory was left behind
    expect(snapshot).toBeNull()
    expect(await fs.readdir(tempRoot)).toEqual([])
  })

  it('skips a file the runner does not own', async () => {
    // #given a file whose owner is not the runner uid (the runner uid is passed in, so a plain file stands in for one
    // a dead sandbox user left behind)
    await fs.writeFile(path.join(source, 'sandbox-written.log'), 'untrusted')
    const logger = createMockLogger()

    // #when the runner uid is anyone but the file's owner
    const snapshot = await snapshotLogDirectory({source, tempRoot, runnerUid: RUNNER_UID + 1, logger})

    // #then the snapshot holds no file
    expect(await listFiles(snapshot as string)).toEqual([])
    expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('not regular'), {skipped: 1})
  })

  it('discards the snapshot when the logs exceed the size cap', async () => {
    // #given 12 bytes of logs and a 10-byte cap
    await fs.writeFile(path.join(source, 'a.log'), '123456')
    await fs.writeFile(path.join(source, 'b.log'), '789012')
    const logger = createMockLogger()

    // #when
    const snapshot = await snapshotLogDirectory({source, tempRoot, runnerUid: RUNNER_UID, maxBytes: 10, logger})

    // #then there is no snapshot, nothing is left on disk, and the warning carries the cap but no file content or path
    expect(snapshot).toBeNull()
    expect(await fs.readdir(tempRoot)).toEqual([])
    expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('size cap'), {maxBytes: 10})
  })

  it('caps at 100 MiB by default', () => {
    // #then the documented bound
    expect(LOG_SNAPSHOT_MAX_BYTES).toBe(100 * 1024 * 1024)
  })

  it('returns null without creating anything when there is no log directory', async () => {
    // #given a source that does not exist
    // #when
    const snapshot = await snapshotLogDirectory({
      source: path.join(base, 'missing'),
      tempRoot,
      runnerUid: RUNNER_UID,
      logger: createMockLogger(),
    })

    // #then
    expect(snapshot).toBeNull()
    expect(await fs.readdir(tempRoot)).toEqual([])
  })

  it('returns null when the temp root cannot be used', async () => {
    // #given a temp root that does not exist
    await fs.writeFile(path.join(source, 'a.log'), 'alpha')

    // #when
    const snapshot = await snapshotLogDirectory({
      source,
      tempRoot: path.join(base, 'no-such-root'),
      runnerUid: RUNNER_UID,
      logger: createMockLogger(),
    })

    // #then
    expect(snapshot).toBeNull()
  })
})

describe('resolveLogReadPath', () => {
  it('reads the shared log directory for a run that is not isolated', () => {
    // #when / #then
    expect(resolveLogReadPath({isolated: false, trusted: true, snapshotPath: null})).toEqual(expect.any(String))
    expect(resolveLogReadPath({isolated: false, trusted: true, snapshotPath: null})).toContain('opencode')
  })

  it('reads only the snapshot for an isolated run', () => {
    // #when / #then
    expect(resolveLogReadPath({isolated: true, trusted: true, snapshotPath: '/tmp/snap'})).toBe('/tmp/snap')
  })

  it.each([null, ''])(
    'reads nothing for an isolated run without a snapshot (%j), never the shared path',
    snapshotPath => {
      // #when / #then
      expect(resolveLogReadPath({isolated: true, trusted: true, snapshotPath})).toBeNull()
    },
  )

  it('reads nothing when the sandbox output is untrusted, snapshot or not', () => {
    // #when / #then
    expect(resolveLogReadPath({isolated: true, trusted: false, snapshotPath: '/tmp/snap'})).toBeNull()
    expect(resolveLogReadPath({isolated: false, trusted: false, snapshotPath: null})).toBeNull()
  })
})
