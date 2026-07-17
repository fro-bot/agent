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
  // For review_requested/ready_for_review the webhook sender is the user or bot
  // that triggered the action, not the PR author. A bot auto-assigning reviews
  // (e.g., bfra-me[bot]) is a legitimate workflow — not a self-loop. Loop
  // prevention for these actions comes from bot_not_requested below.
  if (
    context.action !== 'review_requested' &&
    context.action !== 'ready_for_review' &&
    context.author != null &&
    context.author.isBot
  ) {
    return {
      shouldSkip: true,
      reason: 'self_comment',
      message: `Pull requests from bots (${context.author.login}) are not processed`,
    }
  }
  // For review_requested and ready_for_review, the router resolves the sender's
  // association via API and overrides author.association before this check runs.
  // No permissive fallback for any action — if the API lookup fails and the PR
  // author is unauthorized, the event is correctly blocked. The three authorization
  // rules fall out naturally:
  //   Rule 1: Authorized PR author → author.association passes this check
  //   Rule 2: Unauthorized PR author + authorized sender → router overrode author.association
  //   Rule 3: Unauthorized PR author + no resolution → blocks here
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
  if (config.reviewSkipLabel != null) {
    const skipLabel = config.reviewSkipLabel.trim().toLowerCase()
    // Direct-call guard: parseActionInputs already collapses whitespace-only
    // input to null, so this is only reachable when callers bypass the parser.
    if (skipLabel === '') {
      return {shouldSkip: false}
    }
    const hasSkipLabel = (context.target?.labels ?? []).some(label => label.toLowerCase() === skipLabel)
    // A PR-body mention overrides the opt-out label only for opened, synchronize,
    // and reopened, where context.author.association reflects the PR author who
    // wrote that body. For review_requested and ready_for_review, the router
    // substitutes the webhook sender's association into context.author before
    // this check runs (see routeEvent) — so hasMention still reflects the PR
    // body, which the (possibly unauthorized) PR author controls, not the
    // validated sender. Honoring it there would let an unauthorized fork author
    // plant a mention that overrides the skip label using the sender's borrowed
    // authorization. ready_for_review has no override at all; review_requested
    // gets its own trusted override below, driven by the live API-verified
    // reviewer request rather than PR-author-controlled body text. Note:
    // isBotReviewRequested also gates bot_not_requested above — an explicit
    // bot reviewer request both admits the event and beats the opt-out label;
    // revisit both gates together if either's semantics change.
    const isOverridden =
      (context.hasMention === true && context.action !== 'ready_for_review' && context.action !== 'review_requested') ||
      (context.action === 'review_requested' && context.isBotReviewRequested === true)
    if (hasSkipLabel && !isOverridden) {
      return {
        shouldSkip: true,
        reason: 'review_skip_label',
        message: `Pull request has the opt-out label '${config.reviewSkipLabel}'`,
      }
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
