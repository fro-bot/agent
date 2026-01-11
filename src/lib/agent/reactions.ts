import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {ReactionContext} from './types.js'
import {
  addLabelsToIssue,
  createCommentReaction,
  deleteCommentReaction,
  ensureLabelExists,
  listCommentReactions,
  removeLabelFromIssue,
} from '../github/api.js'
import {WORKING_LABEL, WORKING_LABEL_COLOR, WORKING_LABEL_DESCRIPTION} from './types.js'

export async function addEyesReaction(client: Octokit, ctx: ReactionContext, logger: Logger): Promise<boolean> {
  if (ctx.commentId == null) {
    logger.debug('No comment ID, skipping eyes reaction')
    return false
  }

  const result = await createCommentReaction(client, ctx.repo, ctx.commentId, 'eyes', logger)
  if (result != null) {
    logger.info('Added eyes reaction', {commentId: ctx.commentId})
    return true
  }
  return false
}

export async function addWorkingLabel(client: Octokit, ctx: ReactionContext, logger: Logger): Promise<boolean> {
  if (ctx.issueNumber == null) {
    logger.debug('No issue number, skipping working label')
    return false
  }

  const labelCreated = await ensureLabelExists(
    client,
    ctx.repo,
    WORKING_LABEL,
    WORKING_LABEL_COLOR,
    WORKING_LABEL_DESCRIPTION,
    logger,
  )

  if (!labelCreated) {
    return false
  }

  const labelAdded = await addLabelsToIssue(client, ctx.repo, ctx.issueNumber, [WORKING_LABEL], logger)
  if (labelAdded) {
    logger.info('Added working label', {issueNumber: ctx.issueNumber})
    return true
  }
  return false
}

export async function acknowledgeReceipt(client: Octokit, ctx: ReactionContext, logger: Logger): Promise<void> {
  await Promise.all([addEyesReaction(client, ctx, logger), addWorkingLabel(client, ctx, logger)])
}

async function removeEyesReaction(client: Octokit, ctx: ReactionContext, logger: Logger): Promise<void> {
  if (ctx.commentId == null || ctx.botLogin == null) return

  const reactions = await listCommentReactions(client, ctx.repo, ctx.commentId, logger)
  const eyesReaction = reactions.find(r => r.content === 'eyes' && r.userLogin === ctx.botLogin)

  if (eyesReaction != null) {
    await deleteCommentReaction(client, ctx.repo, ctx.commentId, eyesReaction.id, logger)
  }
}

async function addReaction(
  client: Octokit,
  ctx: ReactionContext,
  content: 'hooray' | 'confused',
  logger: Logger,
): Promise<void> {
  if (ctx.commentId == null) return
  await createCommentReaction(client, ctx.repo, ctx.commentId, content, logger)
}

export async function updateReactionOnSuccess(client: Octokit, ctx: ReactionContext, logger: Logger): Promise<void> {
  if (ctx.commentId == null || ctx.botLogin == null) {
    logger.debug('Missing comment ID or bot login, skipping reaction update')
    return
  }

  try {
    await removeEyesReaction(client, ctx, logger)
    await addReaction(client, ctx, 'hooray', logger)
    logger.info('Updated reaction to success indicator', {commentId: ctx.commentId, reaction: 'hooray'})
  } catch (error) {
    logger.warning('Failed to update reaction (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function updateReactionOnFailure(client: Octokit, ctx: ReactionContext, logger: Logger): Promise<void> {
  if (ctx.commentId == null || ctx.botLogin == null) {
    logger.debug('Missing comment ID or bot login, skipping reaction update')
    return
  }

  try {
    await removeEyesReaction(client, ctx, logger)
    await addReaction(client, ctx, 'confused', logger)
    logger.info('Updated reaction to confused', {commentId: ctx.commentId})
  } catch (error) {
    logger.warning('Failed to update failure reaction (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function removeWorkingLabel(client: Octokit, ctx: ReactionContext, logger: Logger): Promise<void> {
  if (ctx.issueNumber == null) {
    logger.debug('No issue number, skipping label removal')
    return
  }

  const removed = await removeLabelFromIssue(client, ctx.repo, ctx.issueNumber, WORKING_LABEL, logger)
  if (removed) {
    logger.info('Removed working label', {issueNumber: ctx.issueNumber})
  }
}

export async function completeAcknowledgment(
  client: Octokit,
  ctx: ReactionContext,
  success: boolean,
  logger: Logger,
): Promise<void> {
  if (success) {
    await updateReactionOnSuccess(client, ctx, logger)
  } else {
    await updateReactionOnFailure(client, ctx, logger)
  }

  await removeWorkingLabel(client, ctx, logger)
}
