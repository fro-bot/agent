import type {AgentContext, ResponseSurface, TriggerContext} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import * as fs from 'node:fs/promises'
import {parseResponseFile} from '@fro-bot/runtime'
import {isAuthorizedAssociation} from '../triggers/author-utils.js'
import {ALLOWED_ASSOCIATIONS} from '../triggers/types.js'

export type ResponseFileStatus = 'present' | 'absent' | 'unknown'

type ResponseSurfaceTriggerContext = Pick<TriggerContext, 'eventType'> & {
  readonly author?:
    | (Partial<NonNullable<TriggerContext['author']>> & {
        readonly association?: NonNullable<TriggerContext['author']>['association'] | undefined
      })
    | null
  readonly hasMention?: TriggerContext['hasMention'] | undefined
}

export function resolveResponseSurface(
  agentContext: Pick<AgentContext, 'issueType'>,
  triggerContext: ResponseSurfaceTriggerContext | null | undefined,
): ResponseSurface {
  if (triggerContext?.eventType === 'pull_request') return 'pr-review'
  // Routing is the primary authorization boundary; repeat its comment checks here so this resolver fails closed.
  const author = triggerContext?.author
  if (
    triggerContext?.eventType === 'issue_comment' &&
    agentContext.issueType === 'pr' &&
    author != null &&
    author.isBot === false &&
    typeof author.association === 'string' &&
    isAuthorizedAssociation(author.association, ALLOWED_ASSOCIATIONS) &&
    triggerContext.hasMention === true
  ) {
    return 'pr-review-permitted'
  }
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
