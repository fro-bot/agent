import type {Logger} from '../../shared/logger.js'
import {createWriteStream} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {pipeline} from 'node:stream/promises'
import {openRegularFileNoFollow} from '@fro-bot/runtime'
import {getOpenCodeLogPath} from '../../shared/env.js'

/**
 * A per-invocation, runner-owned copy of the OpenCode log directory, for `isolate-agent` runs.
 *
 * The log directory is one path per runner home, not per invocation: every isolated step in a job hands it to its own
 * sandbox user. Once a step has confirmed its sandbox stopped and its files taken back, the directory holds what that
 * step wrote -- but a later step's sandbox can write to it again, before the earlier step's post hook runs. So an isolated
 * invocation copies the directory at its own confirmed take-back and publishes only the copy. The copy lives under
 * `RUNNER_TEMP`, which a sandbox user cannot enter.
 */

export const LOG_SNAPSHOT_MAX_BYTES = 100 * 1024 * 1024

/** One budget for every directory entry the walk visits (files, directories and skipped links alike). */
export const LOG_SNAPSHOT_MAX_ENTRIES = 10_000

const SNAPSHOT_DIR_PREFIX = 'fro-bot-logs-'

export interface SnapshotLogDirectoryOptions {
  /** The shared OpenCode log directory. */
  readonly source: string
  /** An existing directory only the runner can enter (`RUNNER_TEMP`). The snapshot is created inside it. */
  readonly tempRoot: string
  /** Only regular files owned by this uid are copied. */
  readonly runnerUid: number
  readonly maxBytes?: number
  readonly maxEntries?: number
  readonly logger: Logger
}

interface CopyState {
  readonly root: string
  readonly runnerUid: number
  readonly maxBytes: number
  readonly maxEntries: number
  bytes: number
  entries: number
  skipped: number
}

type CopyOutcome = 'copied' | 'over-bytes' | 'over-entries'

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function copyFile(from: string, to: string, state: CopyState): Promise<CopyOutcome> {
  let handle: Awaited<ReturnType<typeof openRegularFileNoFollow>>
  try {
    // O_NOFOLLOW on the file, `within` for a directory swapped for a link in the middle of the path, and an fstat on the
    // handle for "regular". A size over the remaining budget is refused with EFBIG.
    handle = await openRegularFileNoFollow(from, {within: state.root, maxBytes: state.maxBytes - state.bytes})
  } catch (error) {
    if (errorCode(error) === 'EFBIG') return 'over-bytes'
    // A symlink (ELOOP), a FIFO or device (ENOTREG), a path that left the root (EOUTSIDE), a file that vanished or one the
    // runner cannot read: none is copied.
    state.skipped += 1
    return 'copied'
  }
  try {
    const {size, uid} = await handle.stat()
    if (uid !== state.runnerUid) {
      // A file another uid owns (a dead sandbox user's, or one the runner was never meant to trust) is not the runner's.
      state.skipped += 1
      return 'copied'
    }
    state.bytes += size
    if (state.bytes > state.maxBytes) return 'over-bytes'
    if (size === 0) {
      await fs.writeFile(to, '', {flag: 'wx', mode: 0o600})
    } else {
      // Bounded to the size seen on the handle, so a file that grows mid-copy cannot exceed the budget.
      await pipeline(
        handle.createReadStream({start: 0, end: size - 1, autoClose: false}),
        createWriteStream(to, {flags: 'wx', mode: 0o600}),
      )
    }
    return 'copied'
  } finally {
    await handle.close()
  }
}

/**
 * Walks `root` breadth first, one directory handle open at a time, streaming entries (`opendir`) instead of listing a
 * directory into memory. Every entry spends the shared entry budget before anything is done with it.
 */
async function copyTree(root: string, destRoot: string, state: CopyState): Promise<CopyOutcome> {
  const pending: {readonly from: string; readonly to: string}[] = [{from: root, to: destRoot}]
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const {from, to} = next
    for await (const entry of await fs.opendir(from)) {
      state.entries += 1
      if (state.entries > state.maxEntries) return 'over-entries'
      const source = path.join(from, entry.name)
      const target = path.join(to, entry.name)
      if (entry.isDirectory()) {
        await fs.mkdir(target, {mode: 0o700})
        pending.push({from: source, to: target})
      } else if (entry.isFile()) {
        const copied = await copyFile(source, target, state)
        if (copied !== 'copied') return copied
      } else {
        // A symlink, FIFO, socket or device: never opened.
        state.skipped += 1
      }
    }
  }
  return 'copied'
}

/**
 * Copies the regular, runner-owned files of `source` into a new `mkdtemp` directory (mode 0700) under `tempRoot` and
 * returns its path. Returns null when there is nothing to publish: no log directory, a log directory that is not a real
 * directory, a total over the size cap or the entry budget (the snapshot is discarded), or any failure. Never throws and never names a path
 * or file content in a log.
 */
export async function snapshotLogDirectory(options: SnapshotLogDirectoryOptions): Promise<string | null> {
  const {source, tempRoot, runnerUid, logger} = options
  const maxBytes = options.maxBytes ?? LOG_SNAPSHOT_MAX_BYTES
  const maxEntries = options.maxEntries ?? LOG_SNAPSHOT_MAX_ENTRIES
  let snapshotDir: string | null = null
  try {
    const rootStats = await fs.lstat(source).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    })
    if (rootStats === null) {
      logger.debug('No OpenCode log directory to snapshot')
      return null
    }
    if (!rootStats.isDirectory()) {
      logger.warning('Not snapshotting the OpenCode log directory: it is not a real directory')
      return null
    }
    snapshotDir = await fs.mkdtemp(path.join(tempRoot, SNAPSHOT_DIR_PREFIX))
    const state: CopyState = {root: source, runnerUid, maxBytes, maxEntries, bytes: 0, entries: 0, skipped: 0}
    const outcome = await copyTree(source, snapshotDir, state)
    if (outcome !== 'copied') {
      // Over either bound the partial copy goes: a truncated log set is not published as if it were whole.
      await fs.rm(snapshotDir, {recursive: true, force: true})
      if (outcome === 'over-bytes') {
        logger.warning('Discarding the OpenCode log snapshot: the logs exceed the size cap, so none are published', {
          maxBytes,
        })
      } else {
        logger.warning(
          'Discarding the OpenCode log snapshot: the logs exceed the entry budget, so none are published',
          {
            maxEntries,
          },
        )
      }
      return null
    }
    if (state.skipped > 0) {
      logger.warning('Some OpenCode log entries were not copied: they were not regular files owned by the runner', {
        skipped: state.skipped,
      })
    }
    logger.info('OpenCode log snapshot taken', {bytes: state.bytes})
    return snapshotDir
  } catch (error) {
    if (snapshotDir !== null) await fs.rm(snapshotDir, {recursive: true, force: true}).catch(() => undefined)
    logger.warning('Could not snapshot the OpenCode log directory, so no logs are published', {code: errorCode(error)})
    return null
  }
}

export interface ResolveLogReadPathOptions {
  /** The invocation used `isolate-agent` (including one whose sandbox never started). */
  readonly isolated: boolean
  /** The teardown confirmed the sandbox's output can be trusted (or there was no sandbox). */
  readonly trusted: boolean
  /** This invocation's snapshot, if it took one. Absent or empty means none. */
  readonly snapshotPath: string | null
}

/**
 * The one directory a log upload may read, or null when it must read nothing. An isolated invocation reads only its own
 * snapshot and never falls back to the shared path; every other invocation is unchanged.
 */
export function resolveLogReadPath(options: ResolveLogReadPathOptions): string | null {
  if (!options.trusted) return null
  if (!options.isolated) return getOpenCodeLogPath()
  return options.snapshotPath === null || options.snapshotPath === '' ? null : options.snapshotPath
}
