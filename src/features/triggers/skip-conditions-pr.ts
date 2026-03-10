import type {SkipCheckResult} from './skip-conditions-types.js'
import type {TriggerConfig, TriggerContext} from './types.js'
import {isAuthorizedAssociation} from './author-utils.js'

const PR_SUPPORTED_ACTIONS = ['opened', 'synchronize', 'reopened', 'ready_for_review', 'review_requested'] as const

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
  // For review_requested, skip association gating on the PR author. GitHub restricts
  // reviewer assignment to users with write or triage access, providing a strong
  // platform-level permission gate. The webhook payload only carries the PR author's
  // association (not the sender's), and when the API lookup succeeds the router has
  // already overridden author.association. This fallback handles API failure.
  //
  // For ready_for_review, no fallback bypass — GitHub gates it to PR authors + write
  // access users, which is weaker than review_requested. The sender's association
  // MUST be resolved via API (Layer 1) for ready_for_review to pass this check on
  // bot-authored PRs. If the API call fails, this correctly blocks.
  if (
    context.action !== 'review_requested' &&
    context.author != null &&
    !isAuthorizedAssociation(context.author.association, config.allowedAssociations)
  ) {
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
  if (
    config.botLogin != null &&
    config.botLogin !== '' &&
    (context.action === 'ready_for_review' || context.action === 'review_requested') &&
    context.isBotReviewRequested !== true
  ) {
    return {
      shouldSkip: true,
      reason: 'bot_not_requested',
      message: `Pull request action '${context.action}' did not request review from the bot`,
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
