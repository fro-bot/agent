import type {RunSummary} from '../types.js'
import type {Logger} from './types.js'

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {getOpenCodeStoragePath} from './storage.js'

/**
 * Generate random base62 string (matching OpenCode ID format).
 */
function generateRandomBase62(length: number): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

/**
 * Format run summary for session storage.
 */
function formatSummaryForSession(summary: RunSummary): string {
  const lines = [
    '--- Fro Bot Run Summary ---',
    `Event: ${summary.eventType}`,
    `Repo: ${summary.repo}`,
    `Ref: ${summary.ref}`,
    `Run ID: ${summary.runId}`,
    `Cache: ${summary.cacheStatus}`,
    `Duration: ${summary.duration}s`,
  ]

  if (summary.sessionIds.length > 0) {
    lines.push(`Sessions used: ${summary.sessionIds.join(', ')}`)
  }

  if (summary.createdPRs.length > 0) {
    lines.push(`PRs created: ${summary.createdPRs.join(', ')}`)
  }

  if (summary.createdCommits.length > 0) {
    lines.push(`Commits: ${summary.createdCommits.join(', ')}`)
  }

  if (summary.tokenUsage != null) {
    lines.push(`Tokens: ${summary.tokenUsage.input} in / ${summary.tokenUsage.output} out`)
  }

  return lines.join('\n')
}

/**
 * Append a run summary to a session's message history.
 *
 * This creates a synthetic "user" message containing the run summary,
 * making it discoverable in future session searches.
 *
 * NOTE: This directly writes to the OpenCode storage format. The message
 * will appear in session_read and session_search results.
 */
export async function writeSessionSummary(sessionId: string, summary: RunSummary, logger: Logger): Promise<void> {
  const storagePath = getOpenCodeStoragePath()
  const messageDir = path.join(storagePath, 'message', sessionId)
  const partDir = path.join(storagePath, 'part')

  // Generate IDs matching OpenCode format (hex timestamp + random base62)
  const timestamp = Date.now()
  const messageId = `msg_${timestamp.toString(16)}${generateRandomBase62(14)}`
  const partId = `prt_${timestamp.toString(16)}${generateRandomBase62(14)}`

  // Create message metadata
  const messageMetadata = {
    id: messageId,
    sessionID: sessionId,
    role: 'user',
    time: {
      created: timestamp,
    },
    summary: {
      title: 'GitHub Action Run Summary',
      diffs: [],
    },
    agent: 'fro-bot',
    model: {
      providerID: 'system',
      modelID: 'run-summary',
    },
  }

  // Create text part with summary content
  const summaryText = formatSummaryForSession(summary)
  const partMetadata = {
    id: partId,
    sessionID: sessionId,
    messageID: messageId,
    type: 'text',
    text: summaryText,
    time: {
      start: timestamp,
      end: timestamp,
    },
  }

  try {
    // Ensure directories exist
    await fs.mkdir(messageDir, {recursive: true})
    await fs.mkdir(path.join(partDir, messageId), {recursive: true})

    // Write message and part files
    const messagePath = path.join(messageDir, `${messageId}.json`)
    const partPath = path.join(partDir, messageId, `${partId}.json`)

    await fs.writeFile(messagePath, JSON.stringify(messageMetadata, null, 2), 'utf8')
    await fs.writeFile(partPath, JSON.stringify(partMetadata, null, 2), 'utf8')

    logger.info('Session summary written', {sessionId, messageId})
  } catch (error) {
    logger.warning('Failed to write session summary', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
