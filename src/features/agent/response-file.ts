import type {AgentContext, ResponseSurface, TriggerContext} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import * as fs from 'node:fs/promises'
import {parseResponseFile} from '@fro-bot/runtime'

export type ResponseFileStatus = 'present' | 'absent' | 'unknown'

export function resolveResponseSurface(
  agentContext: Pick<AgentContext, 'issueType'>,
  triggerContext: Pick<TriggerContext, 'eventType'> | null | undefined,
): ResponseSurface {
  if (triggerContext?.eventType === 'pull_request') return 'pr-review'
  if (triggerContext?.eventType === 'issue_comment' && agentContext.issueType === 'pr') return 'pr-review-optional'
  if (agentContext.issueType === 'pr') return 'pr-comment'
  return 'issue-comment'
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export async function inspectResponseFile(
  responseFilePath: string | null | undefined,
  surface: ResponseSurface,
  logger: Logger,
): Promise<ResponseFileStatus> {
  if (responseFilePath == null) return 'absent'

  let raw: string
  try {
    raw = await fs.readFile(responseFilePath, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) return 'absent'
    logger.warning('Response-file status is unknown; declining recovery', {
      responseFilePath,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'unknown'
  }

  const parsed = parseResponseFile(raw, {surface})
  if (parsed.success === true) return 'present'

  logger.warning('Response file is not a valid deliverable; allowing recovery', {
    responseFilePath,
    reason: parsed.error.reason,
  })
  return 'absent'
}
