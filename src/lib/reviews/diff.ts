import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {DiffFile, DiffHunk, PRDiff} from './types.js'
import {Buffer} from 'node:buffer'
import {PAGINATION_CONFIG} from './types.js'

/**
 * Fetches complete PR diff with bounded pagination.
 *
 * GitHub API limits to 3000 files per PR, returned in pages of 100. We fetch up to
 * MAX_PAGES to prevent unbounded API calls on extremely large PRs. The truncated flag
 * indicates when pagination limit was hit, allowing callers to handle incomplete data.
 */
export async function getPRDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  logger: Logger,
): Promise<PRDiff> {
  logger.debug('Fetching PR diff', {prNumber})

  const allFiles: DiffFile[] = []
  let page = 1
  let truncated = false

  while (page <= PAGINATION_CONFIG.MAX_PAGES) {
    const {data} = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: PAGINATION_CONFIG.PER_PAGE,
      page,
    })

    const files: DiffFile[] = data.map(file => ({
      filename: file.filename,
      status: file.status as DiffFile['status'],
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch ?? null,
      previousFilename: file.previous_filename ?? null,
    }))

    allFiles.push(...files)

    if (data.length < PAGINATION_CONFIG.PER_PAGE) {
      break
    }

    page++

    if (page > PAGINATION_CONFIG.MAX_PAGES) {
      truncated = true
      logger.warning('PR diff pagination limit reached', {
        filesLoaded: allFiles.length,
        maxPages: PAGINATION_CONFIG.MAX_PAGES,
      })
    }
  }

  const totals = allFiles.reduce(
    (acc, file) => ({
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }),
    {additions: 0, deletions: 0},
  )

  logger.debug('Fetched diff', {
    files: allFiles.length,
    additions: totals.additions,
    deletions: totals.deletions,
    truncated,
  })

  return {
    files: allFiles,
    additions: totals.additions,
    deletions: totals.deletions,
    changedFiles: allFiles.length,
    truncated,
  }
}

const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

/**
 * Parses diff hunks from a patch string.
 *
 * Diff hunks represent contiguous blocks of changes. Parsing them enables line-level
 * comment placement by understanding where changes occur within files. The hunk format
 * follows unified diff syntax: @@ -old_start,old_count +new_start,new_count @@.
 */
export function parseHunks(patch: string): readonly DiffHunk[] {
  const hunks: DiffHunk[] = []
  const lines = patch.split('\n')
  let currentHunk: {startLine: number; lineCount: number; content: string[]} | null = null

  for (const line of lines) {
    const hunkMatch = HUNK_HEADER_PATTERN.exec(line)

    if (hunkMatch != null) {
      if (currentHunk != null) {
        hunks.push({
          startLine: currentHunk.startLine,
          lineCount: currentHunk.lineCount,
          content: currentHunk.content.join('\n'),
        })
      }

      const startLineStr = hunkMatch[1] ?? '1'
      const lineCountStr = hunkMatch[2]
      currentHunk = {
        startLine: Number.parseInt(startLineStr, 10),
        lineCount: lineCountStr === undefined ? 1 : Number.parseInt(lineCountStr, 10),
        content: [line],
      }
    } else if (currentHunk != null) {
      currentHunk.content.push(line)
    }
  }

  if (currentHunk != null) {
    hunks.push({
      startLine: currentHunk.startLine,
      lineCount: currentHunk.lineCount,
      content: currentHunk.content.join('\n'),
    })
  }

  return hunks
}

/**
 * Retrieves file content at a specific Git ref.
 *
 * Enables context-aware code review by accessing file state at specific commits.
 * Returns null for non-existent files rather than throwing, allowing graceful
 * handling of deleted files or invalid paths.
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

    // GitHub API returns different shapes for files vs directories
    if ('content' in data && data.content != null) {
      return Buffer.from(data.content, 'base64').toString('utf8')
    }

    return null
  } catch {
    logger.debug('File not found', {path, ref})
    return null
  }
}
