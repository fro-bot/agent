import type {TokenUsage} from '../types.js'
import type {CommentSummaryOptions} from './types.js'
import {BOT_COMMENT_MARKER} from '../github/types.js'

/**
 * Format cache status with visual indicators for run summaries.
 *
 * Uses emoji to provide quick visual feedback on cache state,
 * particularly important for identifying corrupted caches that require clean starts.
 */
export function formatCacheStatus(status: 'hit' | 'miss' | 'corrupted'): string {
  switch (status) {
    case 'hit':
      return '✅ hit'
    case 'miss':
      return '🆕 miss'
    case 'corrupted':
      return '⚠️ corrupted (clean start)'
  }
}

/**
 * Format duration from milliseconds to human-readable format.
 *
 * Shows seconds only for durations under 1 minute,
 * otherwise displays minutes and seconds.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

/**
 * Format token usage statistics from OpenCode SDK for display.
 *
 * Includes input/output tokens, reasoning tokens (if any), and cache tokens (if any).
 * Appends model name when available for cost tracking context.
 */
export function formatTokenUsage(usage: TokenUsage, model: string | null): string {
  const parts: string[] = []
  parts.push(`${usage.input.toLocaleString()} in`)
  parts.push(`${usage.output.toLocaleString()} out`)

  if (usage.reasoning > 0) {
    parts.push(`${usage.reasoning.toLocaleString()} reasoning`)
  }

  const cacheTotal = usage.cache.read + usage.cache.write
  if (cacheTotal > 0) {
    parts.push(`${cacheTotal.toLocaleString()} cache`)
  }

  let formatted = parts.join(' / ')
  if (model != null) {
    formatted = `${formatted} (${model})`
  }
  return formatted
}

/**
 * Generate markdown summary for GitHub comments.
 *
 * Creates a collapsible details block containing run metadata, sessions,
 * token usage, created artifacts, and errors. Uses BOT_COMMENT_MARKER
 * for identification when updating existing comments.
 */
export function generateCommentSummary(options: CommentSummaryOptions): string {
  const {eventType, repo, ref, runId, runUrl, metrics, agent} = options

  const rows: string[] = []

  rows.push('| Field | Value |')
  rows.push('| ----- | ----- |')
  rows.push(`| Event | \`${eventType}\` |`)
  rows.push(`| Repo | \`${repo}\` |`)
  rows.push(`| Ref | \`${ref}\` |`)
  rows.push(`| Run ID | [${runId}](${runUrl}) |`)
  rows.push(`| Agent | \`${agent}\` |`)
  rows.push(`| Cache | ${formatCacheStatus(metrics.cacheStatus)} |`)

  if (metrics.sessionsUsed.length > 0) {
    rows.push(`| Sessions Used | ${metrics.sessionsUsed.map(s => `\`${s}\``).join(', ')} |`)
  }

  if (metrics.sessionsCreated.length > 0) {
    rows.push(`| Sessions Created | ${metrics.sessionsCreated.map(s => `\`${s}\``).join(', ')} |`)
  }

  if (metrics.duration != null) {
    rows.push(`| Duration | ${formatDuration(metrics.duration)} |`)
  }

  if (metrics.tokenUsage != null) {
    rows.push(`| Tokens | ${formatTokenUsage(metrics.tokenUsage, metrics.model)} |`)
  }

  if (metrics.cost != null) {
    rows.push(`| Cost | $${metrics.cost.toFixed(4)} |`)
  }

  if (metrics.prsCreated.length > 0) {
    rows.push(`| PRs Created | ${metrics.prsCreated.join(', ')} |`)
  }

  if (metrics.commitsCreated.length > 0) {
    const shortShas = metrics.commitsCreated.map(sha => `\`${sha.slice(0, 7)}\``)
    rows.push(`| Commits | ${shortShas.join(', ')} |`)
  }

  if (metrics.commentsPosted > 0) {
    rows.push(`| Comments Posted | ${metrics.commentsPosted} |`)
  }

  if (metrics.errors.length > 0) {
    const errorCount = metrics.errors.length
    const recoverableCount = metrics.errors.filter(e => e.recoverable).length
    rows.push(`| Errors | ${errorCount} (${recoverableCount} recovered) |`)
  }

  const table = rows.join('\n')

  return `${BOT_COMMENT_MARKER}
<details>
<summary>Run Summary</summary>

${table}

</details>`
}

/**
 * Append run summary to comment body with separator.
 *
 * Used when creating new comments or when existing comment
 * doesn't have a summary yet.
 */
export function appendSummaryToComment(body: string, options: CommentSummaryOptions): string {
  const summary = generateCommentSummary(options)
  return `${body}\n\n---\n\n${summary}`
}

/**
 * Extract existing summary from comment body for updates.
 *
 * Searches for BOT_COMMENT_MARKER to identify agent-generated summaries.
 * Returns null if no marker found, indicating this is not an agent comment.
 */
export function extractSummaryFromComment(body: string): string | null {
  const markerIndex = body.indexOf(BOT_COMMENT_MARKER)

  if (markerIndex === -1) {
    return null
  }

  return body.slice(markerIndex)
}

/**
 * Replace existing summary in comment body with updated version.
 *
 * Falls back to appending if no existing summary found.
 * Preserves original comment content while updating metrics.
 */
export function replaceSummaryInComment(body: string, options: CommentSummaryOptions): string {
  const existingSummary = extractSummaryFromComment(body)

  if (existingSummary == null) {
    return appendSummaryToComment(body, options)
  }

  const newSummary = generateCommentSummary(options)
  let bodyWithoutSummary = body.slice(0, body.indexOf(BOT_COMMENT_MARKER))

  bodyWithoutSummary = bodyWithoutSummary.replace(/\n*---\n*$/, '')

  return `${bodyWithoutSummary}\n\n---\n\n${newSummary}`
}
