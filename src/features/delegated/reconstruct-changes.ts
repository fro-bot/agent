import type {Result} from '@bfra.me/es/result'
import type {ExecAdapter} from '../../services/setup/types.js'
import type {FileChange} from './types.js'

import {Buffer} from 'node:buffer'
import * as fs from 'node:fs/promises'
import {resolve, sep} from 'node:path'
import {TextDecoder} from 'node:util'
import {err, ok} from '@bfra.me/es/result'
import {validateFilePath, validateFiles} from './commit.js'

const SHA1_PATTERN = /^[0-9a-f]{40}$/i
const ZERO_MODE = '000000'
const REGULAR_FILE_MODE = '100644'
const UTF8_DECODER = new TextDecoder('utf-8', {fatal: true})

interface RawDiffEntry {
  readonly oldMode: string
  readonly newMode: string
  readonly status: string
  readonly path: string
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
): Promise<Result<ReconstructChangesOutcome, Error>> {
  if (SHA1_PATTERN.test(trustedHeadSha) === false) {
    return ok({kind: 'bypass', reason: 'Trusted head SHA is missing or malformed'})
  }

  try {
    const diffResult = await execAdapter.getExecOutput(
      'git',
      [
        '--no-pager',
        '-c',
        'core.quotepath=false',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--ignore-submodules=none',
        '--raw',
        '-z',
        trustedHeadSha,
        '--',
      ],
      {
        cwd: repoRoot,
        env: {
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_PAGER: 'cat',
        },
        ignoreReturnCode: true,
        silent: true,
      },
    )

    if (diffResult.exitCode !== 0) {
      return err(new Error(`Unable to diff workspace against trusted head SHA: ${diffResult.stderr.trim()}`.trim()))
    }

    const entries = parseRawDiff(diffResult.stdout)
    if (entries.length === 0) {
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
      return err(new Error(`Reconstructed file validation failed: ${validation.errors.join('; ')}`))
    }

    return ok({kind: 'changes', changes})
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
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

  const stats = await fs.lstat(filePath)
  if (stats.isSymbolicLink() || stats.isFile() === false) {
    throw new Error(`${relativePath}: only regular files may be reconstructed`)
  }

  const content = await fs.readFile(filePath)
  try {
    return {path: relativePath, content: UTF8_DECODER.decode(content)}
  } catch {
    return {path: relativePath, content: Buffer.from(content).toString('base64'), encoding: 'base64'}
  }
}
