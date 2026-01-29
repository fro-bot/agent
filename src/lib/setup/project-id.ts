import type {ExecAdapter, Logger} from './types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as exec from '@actions/exec'

import {toErrorMessage} from '../../utils/errors.js'

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
    const stat = await fs.stat(gitDir)
    if (stat.isDirectory() === false) {
      const gitFileContent = await fs.readFile(gitDir, 'utf8')
      const gitdirMatch = /^gitdir: (.+)$/m.exec(gitFileContent)
      if (gitdirMatch == null) {
        return {projectId: null, source: 'error', error: 'Invalid .git file format'}
      }
      gitDir = path.resolve(workspacePath, gitdirMatch[1] as string)
      projectIdFile = path.join(gitDir, 'opencode')
    }
  } catch {
    return {projectId: null, source: 'error', error: 'Not a git repository'}
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
      await fs.writeFile(projectIdFile, firstRootCommit, 'utf8')
      logger.info('Project ID generated and cached', {projectId: firstRootCommit, source: 'generated'})
    } catch (writeError) {
      logger.warning('Failed to cache project ID (continuing)', {
        error: toErrorMessage(writeError),
      })
    }

    return {projectId: firstRootCommit, source: 'generated'}
  } catch (error) {
    const errorMessage = toErrorMessage(error)
    return {projectId: null, source: 'error', error: errorMessage}
  }
}
