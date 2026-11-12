import type {Result} from '@bfra.me/es/result'
import type {ExecAdapter} from '../../services/setup/types.js'
import type {Logger} from '../../shared/logger.js'
import type {FileChange} from './types.js'

import {Buffer} from 'node:buffer'
import {constants as fsConstants} from 'node:fs'
import * as fs from 'node:fs/promises'
import {resolve, sep} from 'node:path'
import {TextDecoder} from 'node:util'
import {err, ok} from '@bfra.me/es/result'
import {validateFilePath, validateFiles} from './commit.js'
import {runTrustedGit} from './trusted-git.js'
import {FILE_VALIDATION} from './types.js'

const SHA1_PATTERN = /^[0-9a-f]{40}$/i
const ZERO_MODE = '000000'
const REGULAR_FILE_MODE = '100644'
const UTF8_DECODER = new TextDecoder('utf-8', {fatal: true})
/** Bound on each reconstruction git call. A stalled git is killed (its process group), not abandoned. */
export const RECONSTRUCT_GIT_TIMEOUT_MS = 60_000

interface RawDiffEntry {
  readonly oldMode: string
  readonly newMode: string
  readonly status: string
  readonly path: string
}

export interface ReconstructChangesOptions {
  /**
   * `isolate-agent` is on. The diff then never enters a submodule (`--ignore-submodules=dirty`), and reconstruction is
   * declined when any gitlink recorded in the index has a populated directory. Without isolation behavior is unchanged
   * (`--ignore-submodules=none`).
   */
  readonly isolated?: boolean
}

export type ReconstructChangesOutcome =
  | {readonly kind: 'changes'; readonly changes: FileChange[]}
  | {readonly kind: 'nothing-to-deliver'}
  | {readonly kind: 'bypass'; readonly reason: string}

/**
 * Reconstruct the workspace's net file changes against a trusted commit SHA.
 *
 * The anchor is the only commit identity used here. Local HEAD, branches, remotes,
 * and the repository's target metadata are intentionally not consulted.
 */
export async function reconstructChanges(
  execAdapter: ExecAdapter,
  trustedHeadSha: string,
  repoRoot: string,
  logger: Logger,
  options: ReconstructChangesOptions = {},
): Promise<Result<ReconstructChangesOutcome, Error>> {
  if (SHA1_PATTERN.test(trustedHeadSha) === false) {
    logger.debug('Brokered push reconstruction bypassed because the trusted head SHA is malformed')
    return ok({kind: 'bypass', reason: 'Trusted head SHA is missing or malformed'})
  }

  try {
    if (options.isolated === true) {
      const populated = await findPopulatedGitlink(execAdapter, repoRoot)
      if (populated.success === false) {
        logger.warning('Brokered push reconstruction could not read the index gitlinks', {
          error: populated.error.message,
        })
        return err(populated.error)
      }
      if (populated.data !== null) {
        const detail = `Brokered push reconstruction is declined: submodule ${populated.data} is populated, and isolate-agent will not run git inside a directory the agent could have written`
        logger.warning('Brokered push reconstruction declined for a populated submodule', {submodule: populated.data})
        return err(new Error(detail))
      }
    }

    // Under isolation `dirty`, not `none`: a gitlink's recorded commit still shows (and is still rejected below), but git
    // never runs inside the submodule. `none` runs `git status` there, which executes that repository's own
    // `core.fsmonitor`. Without isolation the original `none` is kept.
    const diffResult = await runTrustedGit(
      execAdapter,
      [
        '-c',
        'core.quotepath=false',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        options.isolated === true ? '--ignore-submodules=dirty' : '--ignore-submodules=none',
        '--raw',
        '-z',
        trustedHeadSha,
        '--',
      ],
      repoRoot,
      {timeoutMs: RECONSTRUCT_GIT_TIMEOUT_MS},
    )
    if (diffResult.kind === 'timed-out') {
      logger.warning('Brokered push reconstruction diff timed out and was killed')
      return err(new Error('Unable to diff workspace against trusted head SHA: git timed out'))
    }
    if (diffResult.kind === 'unavailable' || diffResult.exitCode !== 0) {
      const detail = diffResult.kind === 'completed' ? diffResult.stderr.trim() : 'git was unavailable'
      logger.warning('Brokered push reconstruction diff failed', {error: detail})
      return err(new Error(`Unable to diff workspace against trusted head SHA: ${detail}`.trim()))
    }

    const untrackedResult = await runTrustedGit(
      execAdapter,
      ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '-z', '--'],
      repoRoot,
      {timeoutMs: RECONSTRUCT_GIT_TIMEOUT_MS},
    )
    if (untrackedResult.kind === 'timed-out') {
      logger.warning('Brokered push reconstruction untracked-file lookup timed out and was killed')
      return err(new Error('Unable to enumerate untracked workspace files: git timed out'))
    }
    if (untrackedResult.kind === 'unavailable' || untrackedResult.exitCode !== 0) {
      const detail = untrackedResult.kind === 'completed' ? untrackedResult.stderr.trim() : 'git was unavailable'
      logger.warning('Brokered push reconstruction untracked-file lookup failed', {error: detail})
      return err(new Error(`Unable to enumerate untracked workspace files: ${detail}`.trim()))
    }

    const entries = mergeRawDiffAndUntracked(
      parseRawDiff(diffResult.stdout),
      parseUntrackedPaths(untrackedResult.stdout),
    )
    if (entries.length === 0) {
      logger.debug('Brokered push reconstruction found no changes')
      return ok({kind: 'nothing-to-deliver'})
    }

    const changes: FileChange[] = []
    for (const entry of entries) {
      validateEntryModes(entry)
      validateWorkspacePath(entry.path)

      if (entry.status === 'D') {
        changes.push({path: entry.path, deleted: true})
        continue
      }

      changes.push(await readContentChange(repoRoot, entry.path))
    }

    const validation = validateFiles(changes)
    if (validation.valid === false) {
      const detail = `Reconstructed file validation failed: ${validation.errors.join('; ')}`
      logger.warning('Brokered push reconstruction file validation failed', {error: detail})
      return err(new Error(detail))
    }

    return ok({kind: 'changes', changes})
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error))
    logger.warning('Brokered push reconstruction failed', {error: normalizedError.message})
    return err(normalizedError)
  }
}

function parseUntrackedPaths(stdout: string): string[] {
  if (stdout.length === 0) {
    return []
  }

  const fields = stdout.split('\0')
  if (fields.at(-1) === '') {
    fields.pop()
  }

  if (fields.some(path => path.length === 0)) {
    throw new Error('Malformed git ls-files output: empty untracked path')
  }

  return fields
}

function mergeRawDiffAndUntracked(
  diffEntries: readonly RawDiffEntry[],
  untrackedPaths: readonly string[],
): RawDiffEntry[] {
  const entriesByPath = new Map<string, RawDiffEntry>()
  for (const entry of diffEntries) {
    entriesByPath.set(entry.path, entry)
  }

  for (const path of untrackedPaths) {
    if (entriesByPath.has(path) === false) {
      entriesByPath.set(path, {
        oldMode: ZERO_MODE,
        newMode: REGULAR_FILE_MODE,
        status: 'A',
        path,
      })
    }
  }

  return [...entriesByPath.values()]
}

/**
 * The first gitlink path recorded in the index whose directory holds a `.git` (a populated submodule), or null. The
 * gitlinks are read as data with `ls-files --stage` (mode 160000), which does not enter a submodule; only the existence
 * of `<path>/.git` is checked, with `lstat`, never by running git there.
 */
async function findPopulatedGitlink(execAdapter: ExecAdapter, repoRoot: string): Promise<Result<string | null, Error>> {
  const staged = await runTrustedGit(execAdapter, ['ls-files', '--stage', '-z', '--'], repoRoot, {
    timeoutMs: RECONSTRUCT_GIT_TIMEOUT_MS,
  })
  if (staged.kind === 'timed-out') return err(new Error('Unable to read the index gitlinks: git timed out'))
  if (staged.kind === 'unavailable' || staged.exitCode !== 0) {
    const detail = staged.kind === 'completed' ? staged.stderr.trim() : 'git was unavailable'
    return err(new Error(`Unable to read the index gitlinks: ${detail}`.trim()))
  }
  for (const record of staged.stdout.split('\0')) {
    const match = /^160000 [0-9a-f]+ \d\t(.+)$/s.exec(record)
    if (match?.[1] === undefined) continue
    const gitlinkPath = match[1]
    const dotGit = resolve(repoRoot, gitlinkPath, '.git')
    if (!dotGit.startsWith(resolve(repoRoot) + sep)) continue
    try {
      await fs.lstat(dotGit)
      return ok(gitlinkPath)
    } catch {
      // No `.git` there: an unpopulated submodule directory.
    }
  }
  return ok(null)
}

function parseRawDiff(stdout: string): RawDiffEntry[] {
  if (stdout.length === 0) {
    return []
  }

  const fields = stdout.split('\0')
  const entries: RawDiffEntry[] = []

  for (let index = 0; index < fields.length;) {
    const header = fields[index]
    if (header == null || header.length === 0) {
      index += 1
      continue
    }

    const path = fields[index + 1]
    if (path == null || path.length === 0) {
      throw new Error('Malformed git diff output: missing changed path')
    }

    if (header.startsWith(':') === false) {
      if (header !== 'A' && header !== 'M' && header !== 'D') {
        throw new Error(`${path}: only added, modified, and deleted paths are supported`)
      }

      entries.push({
        oldMode: header === 'A' ? ZERO_MODE : REGULAR_FILE_MODE,
        newMode: header === 'D' ? ZERO_MODE : REGULAR_FILE_MODE,
        status: header,
        path,
      })
      index += 2
      continue
    }

    const headerParts = header.split(' ')
    if (headerParts.length !== 5 || headerParts[0]?.startsWith(':') !== true) {
      throw new Error('Malformed git diff output: invalid raw entry')
    }

    const oldMode = headerParts[0].slice(1)
    const newMode = headerParts[1]
    const status = headerParts[4]
    if (newMode == null || status == null || status.length === 0) {
      throw new Error('Malformed git diff output: incomplete raw entry')
    }

    entries.push({oldMode, newMode, status, path})
    index += 2
  }

  return entries
}

function validateEntryModes(entry: RawDiffEntry): void {
  if (entry.status !== 'A' && entry.status !== 'M' && entry.status !== 'D') {
    throw new Error(`${entry.path}: only added, modified, and deleted paths are supported`)
  }

  const modes = [entry.oldMode, entry.newMode].filter(mode => mode !== ZERO_MODE)
  if (modes.some(mode => mode !== REGULAR_FILE_MODE)) {
    throw new Error(`${entry.path}: only regular file mode ${REGULAR_FILE_MODE} is supported`)
  }

  if (entry.status === 'A' && (entry.oldMode !== ZERO_MODE || entry.newMode !== REGULAR_FILE_MODE)) {
    throw new Error(`${entry.path}: added entries must be regular files`)
  }
  if (entry.status === 'M' && (entry.oldMode !== REGULAR_FILE_MODE || entry.newMode !== REGULAR_FILE_MODE)) {
    throw new Error(`${entry.path}: modified entries must remain regular files`)
  }
  if (entry.status === 'D' && (entry.oldMode !== REGULAR_FILE_MODE || entry.newMode !== ZERO_MODE)) {
    throw new Error(`${entry.path}: deleted entries must be regular files`)
  }
}

function validateWorkspacePath(relativePath: string): void {
  if (
    relativePath.startsWith('/') ||
    /^[a-z]:[\\/]/i.test(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').includes('..')
  ) {
    throw new Error(`Unsafe workspace path: ${relativePath}`)
  }

  const pathValidation = validateFilePath(relativePath)
  if (pathValidation.valid === false) {
    throw new Error(pathValidation.reason ?? `Invalid workspace path: ${relativePath}`)
  }
}

async function readContentChange(repoRoot: string, relativePath: string): Promise<FileChange> {
  const workspaceRoot = resolve(repoRoot)
  const filePath = resolve(workspaceRoot, relativePath)
  if (filePath !== workspaceRoot && filePath.startsWith(`${workspaceRoot}${sep}`) === false) {
    throw new Error(`Workspace path escapes repository root: ${relativePath}`)
  }

  // Open with O_NOFOLLOW so a symlink swapped in after path resolution cannot be
  // followed, then stat and read from the same handle. This closes the
  // check-then-use race between an lstat guard and a subsequent path-based read.
  let handle: fs.FileHandle
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    throw new Error(`${relativePath}: only regular files may be reconstructed`)
  }

  try {
    const stats = await handle.stat()
    const isExecutable = typeof stats.mode === 'number' && (stats.mode & 0o111) !== 0
    if (stats.isFile() === false || isExecutable) {
      throw new Error(`${relativePath}: only regular files may be reconstructed`)
    }

    // Reject oversized files by their on-disk size before reading, so a single
    // large file is not pulled into memory only to be rejected by validateFiles.
    if (stats.size > FILE_VALIDATION.MAX_FILE_SIZE_BYTES) {
      throw new Error(`${relativePath}: File exceeds maximum size of ${FILE_VALIDATION.MAX_FILE_SIZE_BYTES} bytes`)
    }

    const content = await handle.readFile()
    try {
      return {path: relativePath, content: UTF8_DECODER.decode(content)}
    } catch {
      return {path: relativePath, content: Buffer.from(content).toString('base64'), encoding: 'base64'}
    }
  } finally {
    await handle.close()
  }
}
