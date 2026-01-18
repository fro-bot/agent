/**
 * Commit operations for delegated work (RFC-010).
 *
 * Uses GitHub Git Data API for atomic multi-file commits.
 * Flow: createBlob → createTree → createCommit → updateRef
 */

import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {CommitOptions, CommitResult, FileChange} from './types.js'

import {Buffer} from 'node:buffer'

import {DEFAULT_AUTHOR, FILE_VALIDATION} from './types.js'

/**
 * Validate file paths for security.
 *
 * Rejects path traversal, .git directories, and secret files.
 */
export function validateFilePath(path: string): {valid: boolean; reason?: string} {
  for (const pattern of FILE_VALIDATION.FORBIDDEN_PATTERNS) {
    if (pattern.test(path)) {
      return {valid: false, reason: `Path contains forbidden pattern: ${path}`}
    }
  }

  const fileName = path.split('/').pop() ?? ''
  if (FILE_VALIDATION.FORBIDDEN_FILES.includes(fileName as (typeof FILE_VALIDATION.FORBIDDEN_FILES)[number])) {
    return {valid: false, reason: `File name is forbidden (secrets): ${fileName}`}
  }

  for (const ext of FILE_VALIDATION.FORBIDDEN_EXTENSIONS) {
    if (path.endsWith(ext)) {
      return {valid: false, reason: `File extension is forbidden: ${ext}`}
    }
  }

  return {valid: true}
}

/**
 * Validate file content size.
 */
export function validateFileSize(
  content: string,
  encoding: 'utf-8' | 'base64' = 'utf-8',
): {valid: boolean; reason?: string} {
  const sizeBytes = encoding === 'base64' ? Buffer.byteLength(content, 'base64') : Buffer.byteLength(content, 'utf-8')

  if (sizeBytes > FILE_VALIDATION.MAX_FILE_SIZE_BYTES) {
    return {valid: false, reason: `File exceeds maximum size of ${FILE_VALIDATION.MAX_FILE_SIZE_BYTES} bytes`}
  }

  return {valid: true}
}

/**
 * Validate all files before commit.
 */
export function validateFiles(files: readonly FileChange[]): {valid: boolean; errors: string[]} {
  const errors: string[] = []

  for (const file of files) {
    const pathResult = validateFilePath(file.path)
    if (!pathResult.valid && pathResult.reason != null) {
      errors.push(pathResult.reason)
    }

    const sizeResult = validateFileSize(file.content, file.encoding)
    if (!sizeResult.valid && sizeResult.reason != null) {
      errors.push(`${file.path}: ${sizeResult.reason}`)
    }
  }

  return {valid: errors.length === 0, errors}
}

/**
 * Create an atomic commit with multiple file changes.
 *
 * Uses Git Data API: createBlob → createTree → createCommit → updateRef (force: false)
 */
export async function createCommit(octokit: Octokit, options: CommitOptions, logger: Logger): Promise<CommitResult> {
  const {owner, repo, branch, message, files, author} = options
  const commitAuthor = author ?? DEFAULT_AUTHOR

  logger.info('Creating commit', {
    branch,
    filesChanged: files.length,
    message: message.slice(0, 50),
  })

  const validation = validateFiles(files)
  if (!validation.valid) {
    throw new Error(`File validation failed: ${validation.errors.join('; ')}`)
  }

  const {data: ref} = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  })
  const currentCommitSha = ref.object.sha

  const {data: currentCommit} = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: currentCommitSha,
  })
  const baseTreeSha = currentCommit.tree.sha

  const treeItems = await Promise.all(
    files.map(async file => {
      const {data: blob} = await octokit.rest.git.createBlob({
        owner,
        repo,
        content: file.content,
        encoding: file.encoding ?? 'utf-8',
      })

      return {
        path: file.path,
        mode: '100644' as const,
        type: 'blob' as const,
        sha: blob.sha,
      }
    }),
  )

  const {data: newTree} = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: treeItems,
  })

  const {data: newCommit} = await octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.sha,
    parents: [currentCommitSha],
    author: {
      name: commitAuthor.name,
      email: commitAuthor.email,
      date: new Date().toISOString(),
    },
  })

  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: newCommit.sha,
    force: false,
  })

  logger.info('Commit created', {sha: newCommit.sha})

  return {
    sha: newCommit.sha,
    url: newCommit.html_url,
    message: newCommit.message,
  }
}

/**
 * Get the content of a file at a specific ref.
 *
 * Returns null if file doesn't exist.
 */
export async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  logger: Logger,
): Promise<string | null> {
  try {
    const {data} = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    })

    if ('content' in data && data.content != null) {
      logger.debug('File content retrieved', {path, ref})
      return Buffer.from(data.content, 'base64').toString('utf-8')
    }

    return null
  } catch (error) {
    if ((error as {status?: number}).status === 404) {
      logger.debug('File not found', {path, ref})
      return null
    }
    throw error
  }
}

/**
 * Format a commit message with conventional commit structure.
 *
 * Format: `type(scope): description` or `type: description`
 */
export function formatCommitMessage(type: string, scope: string | null, description: string, body?: string): string {
  const scopePart = scope == null ? '' : `(${scope})`
  const header = `${type}${scopePart}: ${description}`

  if (body != null && body.length > 0) {
    return `${header}\n\n${body}`
  }

  return header
}
