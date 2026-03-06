import type {SkipCheckResult} from './skip-conditions-types.js'
import type {TriggerConfig, TriggerContext} from './types.js'
import {isAuthorizedAssociation} from './author-utils.js'

const ISSUES_SUPPORTED_ACTIONS = ['opened', 'edited'] as const

function isIssuesSupportedAction(action: string): action is (typeof ISSUES_SUPPORTED_ACTIONS)[number] {
  return (ISSUES_SUPPORTED_ACTIONS as readonly string[]).includes(action)
}

export function checkIssuesSkipConditions(context: TriggerContext, config: TriggerConfig): SkipCheckResult {
  const action = context.action
  if (action == null || !isIssuesSupportedAction(action)) {
    return {
      shouldSkip: true,
      reason: 'action_not_supported',
      message: `Issues action '${action}' is not supported (only 'opened' and 'edited')`,
    }
  }
  if (context.author != null && context.author.isBot) {
    return {
      shouldSkip: true,
      reason: 'self_comment',
      message: `Issues from bots (${context.author.login}) are not processed`,
    }
  }
  if (context.author != null && !isAuthorizedAssociation(context.author.association, config.allowedAssociations)) {
    return {
      shouldSkip: true,
      reason: 'unauthorized_author',
      message: `Author association '${context.author.association}' is not authorized`,
    }
  }
  if (action === 'edited' && !context.hasMention) {
    return {
      shouldSkip: true,
      reason: 'no_mention',
      message: 'Issue edit does not mention the bot',
    }
  }
  if (context.target?.locked === true) {
    return {
      shouldSkip: true,
      reason: 'issue_locked',
      message: 'Issue is locked',
    }
  }

  return {shouldSkip: false}
}
