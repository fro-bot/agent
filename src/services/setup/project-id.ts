import type {ExecAdapter, Logger} from './types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as exec from '@actions/exec'

import {toErrorMessage} from '../../shared/errors.js'

export type ProjectIdSource = 'cached' | 'generated' | 'error'

export interface ProjectIdResult {
  readonly projectId: string | null
  readonly source: ProjectIdSource
  readonly error?: string
}

export interface ProjectIdOptions {
  readonly workspacePath: string
  readonly logger: Logger
  readonly execAdapter?: ExecAdapter
}

const SHA1_PATTERN = /^[0-9a-f]{40}$/i

function createDefaultExecAdapter(): ExecAdapter {
  return {
    exec: exec.exec,
    getExecOutput: exec.getExecOutput,
  }
}

/**
 * Pre-create `.git/opencode` matching OpenCode's algorithm: first root commit SHA (sorted).
 * This ensures deterministic project ID in CI where `.git/opencode` isn't persisted.
 */
export async function ensureProjectId(options: ProjectIdOptions): Promise<ProjectIdResult> {
  const {workspacePath, logger, execAdapter = createDefaultExecAdapter()} = options
  let gitDir = path.join(workspacePath, '.git')
  let projectIdFile = path.join(gitDir, 'opencode')

  try {
    const cachedId = await fs.readFile(projectIdFile, 'utf8')
    const trimmedId = cachedId.trim()
    if (trimmedId.length > 0) {
      if (SHA1_PATTERN.test(trimmedId)) {
        logger.debug('Project ID loaded from cache', {projectId: trimmedId})
        return {projectId: trimmedId, source: 'cached'}
      }
      logger.warning('Invalid cached project ID format, regenerating', {cachedId: trimmedId})
    }
  } catch (error) {
    logger.debug('No cached project ID found', {
      error: toErrorMessage(error),
    })
  }

  try {
    const gitFileContent = await fs.readFile(gitDir, 'utf8')
    // .git is a regular file (worktree link) — parse gitdir
    const gitdirMatch = /^gitdir: (.+)$/m.exec(gitFileContent)
    if (gitdirMatch == null) {
      return {projectId: null, source: 'error', error: 'Invalid .git file format'}
    }
    gitDir = path.resolve(workspacePath, gitdirMatch[1] as string)
    projectIdFile = path.join(gitDir, 'opencode')
  } catch (error) {
    const code = typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined
    if (code !== 'EISDIR') {
      // Any error other than EISDIR means .git doesn't exist or isn't accessible
      return {projectId: null, source: 'error', error: 'Not a git repository'}
    }
    // EISDIR: .git is a directory — normal git repository, proceed with gitDir as-is
  }

  try {
    const {stdout, exitCode} = await execAdapter.getExecOutput('git', ['rev-list', '--max-parents=0', '--all'], {
      cwd: workspacePath,
      silent: true,
    })

    if (exitCode !== 0 || stdout.trim().length === 0) {
      return {projectId: null, source: 'error', error: 'No commits found in repository'}
    }

    const rootCommits = stdout
      .trim()
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .sort()

    if (rootCommits.length === 0) {
      return {projectId: null, source: 'error', error: 'No root commits found'}
    }

    const firstRootCommit = rootCommits[0] as string

    try {
      // Use O_CREAT | O_EXCL (wx flag) for an atomic create-only write, eliminating the TOCTOU
      // window between the earlier readFile check and this write. If another process races to
      // create the same file, we receive EEXIST and continue safely — the value is deterministic.
      await fs.writeFile(projectIdFile, firstRootCommit, {encoding: 'utf8', flag: 'wx'})
      logger.info('Project ID generated and cached', {projectId: firstRootCommit, source: 'generated'})
    } catch (writeError) {
      const errnoCode = typeof writeError === 'object' ? (writeError as NodeJS.ErrnoException).code : undefined
      if (errnoCode === 'EEXIST') {
        logger.debug('Project ID file already written by concurrent process, skipping', {
          projectId: firstRootCommit,
        })
      } else {
        logger.warning('Failed to cache project ID (continuing)', {
          error: toErrorMessage(writeError),
        })
      }
    }

    return {projectId: firstRootCommit, source: 'generated'}
  } catch (error) {
    const errorMessage = toErrorMessage(error)
    return {projectId: null, source: 'error', error: errorMessage}
  }
}
