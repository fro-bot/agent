import type {Thread} from '../comments/types.js'
import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {TriggerContext} from './types.js'
import {readThread} from '../comments/reader.js'
import {getCommentTarget} from '../github/context.js'

export interface IssueCommentResult {
  readonly handled: boolean
  readonly thread: Thread | null
}

export async function handleIssueComment(
  context: TriggerContext,
  client: Octokit,
  botLogin: string | null,
  logger: Logger,
): Promise<IssueCommentResult> {
  const target = getCommentTarget(context.raw)

  if (target == null) {
    logger.debug('No comment target found for event', {eventType: context.eventType})
    return {handled: false, thread: null}
  }

  const thread = await readThread(client, target, botLogin, logger)

  if (thread == null) {
    logger.warning('Failed to read thread', {target})
    return {handled: false, thread: null}
  }

  logger.debug('Read thread successfully', {
    type: thread.type,
    number: thread.number,
    commentCount: thread.comments.length,
  })

  return {handled: true, thread}
}
