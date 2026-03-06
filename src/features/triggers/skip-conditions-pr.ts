import type {SkipCheckResult} from './skip-conditions-types.js'
import type {TriggerConfig, TriggerContext} from './types.js'
import {isAuthorizedAssociation} from './author-utils.js'

const PR_SUPPORTED_ACTIONS = ['opened', 'synchronize', 'reopened'] as const

function isPRSupportedAction(action: string): action is (typeof PR_SUPPORTED_ACTIONS)[number] {
  return (PR_SUPPORTED_ACTIONS as readonly string[]).includes(action)
}

export function checkPullRequestSkipConditions(context: TriggerContext, config: TriggerConfig): SkipCheckResult {
  const action = context.action
  if (action == null || !isPRSupportedAction(action)) {
    return {
      shouldSkip: true,
      reason: 'action_not_supported',
      message: `Pull request action '${action}' is not supported`,
    }
  }
  if (context.author != null && context.author.isBot) {
    return {
      shouldSkip: true,
      reason: 'self_comment',
      message: `Pull requests from bots (${context.author.login}) are not processed`,
    }
  }
  if (context.author != null && !isAuthorizedAssociation(context.author.association, config.allowedAssociations)) {
    return {
      shouldSkip: true,
      reason: 'unauthorized_author',
      message: `Author association '${context.author.association}' is not authorized`,
    }
  }
  if (config.skipDraftPRs && context.target?.isDraft === true) {
    return {
      shouldSkip: true,
      reason: 'draft_pr',
      message: 'Pull request is a draft',
    }
  }
  if (context.target?.locked === true) {
    return {
      shouldSkip: true,
      reason: 'issue_locked',
      message: 'Pull request is locked',
    }
  }

  return {shouldSkip: false}
}

export function checkPRReviewCommentSkipConditions(context: TriggerContext, config: TriggerConfig): SkipCheckResult {
  const action = context.action
  if (action !== 'created') {
    return {
      shouldSkip: true,
      reason: 'action_not_created',
      message: `Review comment action '${action}' is not supported (only 'created')`,
    }
  }
  if (context.target?.locked === true) {
    return {
      shouldSkip: true,
      reason: 'issue_locked',
      message: 'Pull request is locked',
    }
  }
  if (context.author != null && context.author.isBot) {
    return {
      shouldSkip: true,
      reason: 'self_comment',
      message: `Review comments from bots (${context.author.login}) are not processed`,
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
      message: 'Review comment does not mention the bot',
    }
  }

  return {shouldSkip: false}
}
