import type {Logger} from '../../shared/logger.js'
import type {SkipCheckResult} from './skip-conditions-types.js'
import type {TriggerConfig, TriggerContext} from './types.js'
import {checkDiscussionCommentSkipConditions, checkIssueCommentSkipConditions} from './skip-conditions-comment.js'
import {checkIssuesSkipConditions} from './skip-conditions-issues.js'
import {checkScheduleSkipConditions, checkWorkflowDispatchSkipConditions} from './skip-conditions-manual.js'
import {checkPRReviewCommentSkipConditions, checkPullRequestSkipConditions} from './skip-conditions-pr.js'

function skipUnsupported(eventName: string): SkipCheckResult {
  return {
    shouldSkip: true,
    reason: 'unsupported_event',
    message: `Unsupported event type: ${eventName}`,
  }
}

export function checkSkipConditions(context: TriggerContext, config: TriggerConfig, logger: Logger): SkipCheckResult {
  if (context.eventType === 'unsupported') {
    logger.debug('Skipping unsupported event', {eventName: context.eventName})
    return skipUnsupported(context.eventName)
  }

  switch (context.eventType) {
    case 'issue_comment':
      return checkIssueCommentSkipConditions(context, config)
    case 'discussion_comment':
      return checkDiscussionCommentSkipConditions(context, config)
    case 'issues':
      return checkIssuesSkipConditions(context, config)
    case 'pull_request':
      return checkPullRequestSkipConditions(context, config)
    case 'pull_request_review_comment':
      return checkPRReviewCommentSkipConditions(context, config)
    case 'schedule':
      return checkScheduleSkipConditions(config)
    case 'workflow_dispatch':
      return checkWorkflowDispatchSkipConditions(context)
    default:
      return {shouldSkip: false}
  }
}
