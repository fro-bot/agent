import type {SkipCheckResult} from './skip-conditions-types.js'
import type {TriggerConfig, TriggerContext} from './types.js'
import {isAuthorizedAssociation} from './author-utils.js'

interface CommentSkipCheckOptions {
  readonly targetLabel: string
  readonly actionLabel: string
}

function checkCommentSkipConditions(
  context: TriggerContext,
  config: TriggerConfig,
  options: CommentSkipCheckOptions,
): SkipCheckResult {
  const {targetLabel, actionLabel} = options

  if (context.action !== 'created') {
    return {
      shouldSkip: true,
      reason: 'action_not_created',
      message: `${actionLabel} action is '${context.action}', not 'created'`,
    }
  }
  if (context.target?.locked === true) {
    return {
      shouldSkip: true,
      reason: 'issue_locked',
      message: `${targetLabel} is locked`,
    }
  }
  if (context.author != null && context.author.isBot) {
    return {
      shouldSkip: true,
      reason: 'self_comment',
      message: `Comments from bots (${context.author.login}) are not processed`,
    }
  }
  if (context.author != null && !isAuthorizedAssociation(context.author.association, config.allowedAssociations)) {
    return {
      shouldSkip: true,
      reason: 'unauthorized_author',
      message: `Author association '${context.author.association}' is not authorized`,
    }
  }
  if (config.requireMention && !context.hasMention) {
    return {
      shouldSkip: true,
      reason: 'no_mention',
      message: 'Comment does not mention the bot',
    }
  }

  return {shouldSkip: false}
}

export function checkIssueCommentSkipConditions(context: TriggerContext, config: TriggerConfig): SkipCheckResult {
  return checkCommentSkipConditions(context, config, {
    targetLabel: 'Issue or PR',
    actionLabel: 'Comment',
  })
}

export function checkDiscussionCommentSkipConditions(context: TriggerContext, config: TriggerConfig): SkipCheckResult {
  return checkCommentSkipConditions(context, config, {
    targetLabel: 'Discussion',
    actionLabel: 'Discussion comment',
  })
}
