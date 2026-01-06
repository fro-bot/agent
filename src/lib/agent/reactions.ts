/**
 * Reactions and labels management for RFC-012.
 *
 * Handles acknowledgment of agent receipt (eyes reaction, working label)
 * and completion updates (success/failure reactions, label removal).
 */

import type {Logger} from '../logger.js'
import type {ReactionContext} from './types.js'
import * as exec from '@actions/exec'
import {WORKING_LABEL, WORKING_LABEL_COLOR, WORKING_LABEL_DESCRIPTION} from './types.js'

/**
 * Add eyes reaction to acknowledge receipt of the triggering comment.
 */
export async function addEyesReaction(ctx: ReactionContext, logger: Logger): Promise<boolean> {
  if (ctx.commentId == null) {
    logger.debug('No comment ID, skipping eyes reaction')
    return false
  }

  try {
    await exec.exec(
      'gh',
      [
        'api',
        '--method',
        'POST',
        `/repos/${ctx.repo}/issues/comments/${ctx.commentId}/reactions`,
        '-f',
        'content=eyes',
      ],
      {silent: true},
    )

    logger.info('Added eyes reaction', {commentId: ctx.commentId})
    return true
  } catch (error) {
    logger.warning('Failed to add eyes reaction (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Add "agent: working" label to the issue/PR.
 */
export async function addWorkingLabel(ctx: ReactionContext, logger: Logger): Promise<boolean> {
  if (ctx.issueNumber == null) {
    logger.debug('No issue number, skipping working label')
    return false
  }

  try {
    // Ensure label exists (--force updates if exists)
    await exec.exec(
      'gh',
      [
        'label',
        'create',
        WORKING_LABEL,
        '--color',
        WORKING_LABEL_COLOR,
        '--description',
        WORKING_LABEL_DESCRIPTION,
        '--force',
      ],
      {silent: true},
    )

    // Add label to issue/PR
    const cmd = ctx.issueType === 'pr' ? 'pr' : 'issue'
    await exec.exec('gh', [cmd, 'edit', String(ctx.issueNumber), '--add-label', WORKING_LABEL], {silent: true})

    logger.info('Added working label', {issueNumber: ctx.issueNumber})
    return true
  } catch (error) {
    logger.warning('Failed to add working label (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Acknowledge receipt by adding eyes reaction and working label.
 */
export async function acknowledgeReceipt(ctx: ReactionContext, logger: Logger): Promise<void> {
  // Run both in parallel - neither is dependent on the other
  await Promise.all([addEyesReaction(ctx, logger), addWorkingLabel(ctx, logger)])
}

/**
 * Remove the bot's eyes reaction from a comment.
 */
async function removeEyesReaction(ctx: ReactionContext): Promise<void> {
  if (ctx.commentId == null || ctx.botLogin == null) return

  const {stdout} = await exec.getExecOutput(
    'gh',
    [
      'api',
      `/repos/${ctx.repo}/issues/comments/${ctx.commentId}/reactions`,
      '--jq',
      `.[] | select(.content=="eyes" and .user.login=="${ctx.botLogin}") | .id`,
    ],
    {silent: true},
  )

  const reactionId = stdout.trim()
  if (reactionId.length > 0) {
    await exec.exec('gh', ['api', '--method', 'DELETE', `/repos/${ctx.repo}/reactions/${reactionId}`], {silent: true})
  }
}

/**
 * Add a reaction to the triggering comment.
 */
async function addReaction(ctx: ReactionContext, content: string): Promise<void> {
  if (ctx.commentId == null) return

  await exec.exec(
    'gh',
    [
      'api',
      '--method',
      'POST',
      `/repos/${ctx.repo}/issues/comments/${ctx.commentId}/reactions`,
      '-f',
      `content=${content}`,
    ],
    {silent: true},
  )
}

/**
 * Update reaction from eyes to success indicator on successful completion.
 * Uses hooray (🎉) as GitHub API doesn't support peace sign reactions.
 */
export async function updateReactionOnSuccess(ctx: ReactionContext, logger: Logger): Promise<void> {
  if (ctx.commentId == null || ctx.botLogin == null) {
    logger.debug('Missing comment ID or bot login, skipping reaction update')
    return
  }

  try {
    await removeEyesReaction(ctx)
    await addReaction(ctx, 'hooray')
    logger.info('Updated reaction to success indicator', {commentId: ctx.commentId, reaction: 'hooray'})
  } catch (error) {
    logger.warning('Failed to update reaction (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Update reaction to confused (😕) on failure.
 */
export async function updateReactionOnFailure(ctx: ReactionContext, logger: Logger): Promise<void> {
  if (ctx.commentId == null || ctx.botLogin == null) {
    logger.debug('Missing comment ID or bot login, skipping reaction update')
    return
  }

  try {
    await removeEyesReaction(ctx)
    await addReaction(ctx, 'confused')
    logger.info('Updated reaction to confused', {commentId: ctx.commentId})
  } catch (error) {
    logger.warning('Failed to update failure reaction (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Remove "agent: working" label on completion (success or failure).
 */
export async function removeWorkingLabel(ctx: ReactionContext, logger: Logger): Promise<void> {
  if (ctx.issueNumber == null) {
    logger.debug('No issue number, skipping label removal')
    return
  }

  try {
    const cmd = ctx.issueType === 'pr' ? 'pr' : 'issue'
    await exec.exec('gh', [cmd, 'edit', String(ctx.issueNumber), '--remove-label', WORKING_LABEL], {silent: true})

    logger.info('Removed working label', {issueNumber: ctx.issueNumber})
  } catch (error) {
    logger.warning('Failed to remove working label (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Complete acknowledgment cycle based on success/failure.
 */
export async function completeAcknowledgment(ctx: ReactionContext, success: boolean, logger: Logger): Promise<void> {
  // Update reaction based on outcome
  if (success) {
    await updateReactionOnSuccess(ctx, logger)
  } else {
    await updateReactionOnFailure(ctx, logger)
  }

  // Always remove working label
  await removeWorkingLabel(ctx, logger)
}
