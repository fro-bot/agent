import type {RunSummary} from '../types.js'
import type {SessionBackend} from './backend.js'
import type {Logger} from './types.js'

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {toErrorMessage} from '../../utils/errors.js'
import {getOpenCodeStoragePath} from './storage.js'

/**
 * Generate random base62 string matching OpenCode's ID format.
 * OpenCode IDs use base62 to pack more entropy into shorter strings
 * (62 chars vs 16 for hex), reducing storage overhead.
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
 * Creates a synthetic "user" message to make GitHub Action metadata searchable.
 * This enables close-the-loop functionality: agents can discover which GitHub
 * runs created which PRs/commits, avoiding duplicate work and enabling
 * follow-up coordination.
 *
 * The synthetic message uses role="user" so it appears in conversation context
 * but uses special agent="fro-bot" and modelID="run-summary" to identify it
 * as GitHub Action metadata rather than human input.
 */
export async function writeSessionSummary(
  sessionId: string,
  summary: RunSummary,
  backend: SessionBackend,
  logger: Logger,
): Promise<void> {
  if (backend.type === 'sdk') {
    logger.debug('SDK backend detected, using JSON file writeback (no silent message API available)', {sessionId})
  }

  const storagePath = getOpenCodeStoragePath()
  const messageDir = path.join(storagePath, 'message', sessionId)
  const partDir = path.join(storagePath, 'part')

  const timestamp = Date.now()
  const messageId = `msg_${timestamp.toString(16)}${generateRandomBase62(14)}`
  const partId = `prt_${timestamp.toString(16)}${generateRandomBase62(14)}`

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
    await fs.mkdir(messageDir, {recursive: true})
    await fs.mkdir(path.join(partDir, messageId), {recursive: true})

    const messagePath = path.join(messageDir, `${messageId}.json`)
    const partPath = path.join(partDir, messageId, `${partId}.json`)

    await fs.writeFile(messagePath, JSON.stringify(messageMetadata, null, 2), 'utf8')
    await fs.writeFile(partPath, JSON.stringify(partMetadata, null, 2), 'utf8')

    logger.info('Session summary written', {sessionId, messageId})
  } catch (error) {
    logger.warning('Failed to write session summary', {
      sessionId,
      error: toErrorMessage(error),
    })
  }
}
