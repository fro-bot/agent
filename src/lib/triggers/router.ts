import type {GitHubContext} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {
  AuthorInfo,
  ParsedCommand,
  SkipReason,
  TriggerConfig,
  TriggerContext,
  TriggerResult,
  TriggerTarget,
} from './types.js'
import {DEFAULT_TRIGGER_CONFIG} from './types.js'

export function hasBotMention(text: string, botLogin: string): boolean {
  if (botLogin.length === 0) {
    return false
  }

  // Strip [bot] suffix so both 'fro-bot' and 'fro-bot[bot]' match @fro-bot
  const normalizedLogin = botLogin.replace(/\[bot\]$/i, '')
  if (normalizedLogin.length === 0) {
    return false
  }

  // Match @botLogin or @botLogin[bot] with word boundary
  // (?:$|[^\w]) ensures we don't match @fro-botty when looking for @fro-bot
  const pattern = new RegExp(String.raw`@${escapeRegExp(normalizedLogin)}(?:\[bot\])?(?:$|[^\w])`, 'i')
  return pattern.test(text)
}

function escapeRegExp(str: string): string {
  return str.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

export function extractCommand(text: string, botLogin: string): ParsedCommand | null {
  if (botLogin.length === 0) {
    return null
  }

  // Strip [bot] suffix to match both @fro-bot and @fro-bot[bot] mentions
  const normalizedLogin = botLogin.replace(/\[bot\]$/i, '')
  if (normalizedLogin.length === 0) {
    return null
  }

  const pattern = new RegExp(String.raw`@${escapeRegExp(normalizedLogin)}(?:\[bot\])?\s*(.*)`, 'is')
  const match = pattern.exec(text)

  const captured = match?.[1]
  if (captured == null) {
    return null
  }

  const raw = captured.trim()

  if (raw.length === 0) {
    return {raw: '', action: null, args: ''}
  }

  const parts = raw.split(/\s+/)
  const firstPart = parts[0] ?? ''
  const action = firstPart === '' ? null : firstPart
  const args = parts.slice(1).join(' ')

  return {raw, action, args}
}

function isAuthorizedAssociation(association: string, allowed: readonly string[]): boolean {
  return allowed.includes(association)
}

function isBotUser(login: string): boolean {
  return login.endsWith('[bot]')
}

interface IssueCommentContextData {
  author: AuthorInfo
  target: TriggerTarget
  commentBody: string
  commentId: number
  hasMention: boolean
  command: ParsedCommand | null
  action: string
}

interface MentionAndCommand {
  hasMention: boolean
  command: ParsedCommand | null
}

function parseBotMentionAndCommand(commentBody: string | null, botLogin: string | null): MentionAndCommand {
  if (botLogin == null || botLogin === '' || commentBody == null) {
    return {hasMention: false, command: null}
  }

  const hasMention = hasBotMention(commentBody, botLogin)
  const command = hasMention ? extractCommand(commentBody, botLogin) : null

  return {hasMention, command}
}

function buildIssueCommentContextData(event: GitHubContext['event'], botLogin: string | null): IssueCommentContextData {
  if (event.type !== 'issue_comment') {
    throw new Error('Event type must be issue_comment')
  }

  const author: AuthorInfo = {
    login: event.comment.author,
    association: event.comment.authorAssociation,
    isBot: isBotUser(event.comment.author),
  }

  const target: TriggerTarget = {
    kind: event.issue.isPullRequest ? 'pr' : 'issue',
    number: event.issue.number,
    title: event.issue.title,
    body: event.comment.body ?? null,
    locked: event.issue.locked,
  }

  const commentBody = event.comment.body
  const commentId = event.comment.id
  const {hasMention, command} = parseBotMentionAndCommand(commentBody, botLogin)

  return {author, target, commentBody, commentId, hasMention, command, action: event.action}
}

interface DiscussionContextData {
  author: AuthorInfo | null
  target: TriggerTarget
  commentBody: string | null
  commentId: number | null
  hasMention: boolean
  command: ParsedCommand | null
  action: string
}

function buildDiscussionContextData(event: GitHubContext['event'], botLogin: string | null): DiscussionContextData {
  if (event.type !== 'discussion_comment') {
    throw new Error('Event type must be discussion_comment')
  }

  const author: AuthorInfo = {
    login: event.comment.author,
    association: event.comment.authorAssociation,
    isBot: isBotUser(event.comment.author),
  }

  const target: TriggerTarget = {
    kind: 'discussion',
    number: event.discussion.number,
    title: event.discussion.title,
    body: event.comment.body ?? event.discussion.body ?? null,
    locked: event.discussion.locked,
  }

  const commentBody = event.comment.body ?? null
  const commentId = event.comment.id
  const {hasMention, command} = parseBotMentionAndCommand(commentBody, botLogin)

  return {author, target, commentBody, commentId, hasMention, command, action: event.action}
}

interface WorkflowDispatchContextData {
  author: AuthorInfo
  target: TriggerTarget
  commentBody: string | null
  commentId: null
  hasMention: false
  command: null
  action: null
}

function buildWorkflowDispatchContextData(event: GitHubContext['event'], actor: string): WorkflowDispatchContextData {
  if (event.type !== 'workflow_dispatch') {
    throw new Error('Event type must be workflow_dispatch')
  }

  const promptInput = event.inputs.prompt ?? ''

  const target: TriggerTarget = {
    kind: 'manual',
    number: 0,
    title: 'Manual workflow dispatch',
    body: promptInput === '' ? null : promptInput,
    locked: false,
  }

  const author: AuthorInfo = {
    login: actor,
    association: 'OWNER',
    isBot: false,
  }

  return {
    author,
    target,
    commentBody: promptInput === '' ? null : promptInput,
    commentId: null,
    hasMention: false,
    command: null,
    action: null,
  }
}

type SkipCheckResult = {shouldSkip: false} | {shouldSkip: true; reason: SkipReason; message: string}

interface CommentSkipCheckOptions {
  targetLabel: string
  actionLabel: string
}

interface IssuesContextData {
  author: AuthorInfo
  target: TriggerTarget
  commentBody: string | null
  commentId: null
  hasMention: boolean
  command: ParsedCommand | null
  action: string
}

function buildIssuesContextData(event: GitHubContext['event'], botLogin: string | null): IssuesContextData {
  if (event.type !== 'issues') {
    throw new Error('Event type must be issues')
  }

  const author: AuthorInfo = {
    login: event.sender.login,
    association: event.issue.authorAssociation,
    isBot: isBotUser(event.sender.login),
  }

  const target: TriggerTarget = {
    kind: 'issue',
    number: event.issue.number,
    title: event.issue.title,
    body: event.issue.body,
    locked: event.issue.locked,
  }

  const issueBody = event.issue.body ?? ''
  const {hasMention, command} = parseBotMentionAndCommand(issueBody, botLogin)

  return {
    author,
    target,
    commentBody: event.issue.body,
    commentId: null,
    hasMention,
    command,
    action: event.action,
  }
}

/**
 * Supported issue actions. Only 'opened' and 'edited' are processed.
 *
 * Other actions ('reopened', 'closed', 'labeled', etc.) are intentionally skipped:
 * - 'reopened': Reopened issues should be addressed via comments, not auto-triggered
 * - 'closed'/'deleted': No agent action needed on closed/deleted issues
 * - 'labeled'/'assigned'/etc.: Minor actions that would cause excessive noise
 */
const ISSUES_SUPPORTED_ACTIONS = ['opened', 'edited'] as const

function isIssuesSupportedAction(action: string): action is (typeof ISSUES_SUPPORTED_ACTIONS)[number] {
  return (ISSUES_SUPPORTED_ACTIONS as readonly string[]).includes(action)
}

function checkIssuesSkipConditions(context: TriggerContext, config: TriggerConfig, logger: Logger): SkipCheckResult {
  const action = context.action

  if (action == null || !isIssuesSupportedAction(action)) {
    logger.debug('Skipping unsupported issues action', {action})
    return {
      shouldSkip: true,
      reason: 'action_not_supported',
      message: `Issues action '${action}' is not supported (only 'opened' and 'edited')`,
    }
  }

  if (context.author != null && context.author.isBot) {
    logger.debug('Skipping bot actor', {bot: context.author.login})
    return {
      shouldSkip: true,
      reason: 'self_comment',
      message: `Issues from bots (${context.author.login}) are not processed`,
    }
  }

  if (context.author != null && !isAuthorizedAssociation(context.author.association, config.allowedAssociations)) {
    logger.debug('Skipping unauthorized author', {
      association: context.author.association,
      allowed: config.allowedAssociations,
    })
    return {
      shouldSkip: true,
      reason: 'unauthorized_author',
      message: `Author association '${context.author.association}' is not authorized`,
    }
  }

  if (action === 'edited' && !context.hasMention) {
    logger.debug('Skipping issues.edited without bot mention')
    return {
      shouldSkip: true,
      reason: 'no_mention',
      message: 'Issue edit does not mention the bot',
    }
  }

  if (context.target?.locked === true) {
    logger.debug('Skipping locked issue')
    return {
      shouldSkip: true,
      reason: 'issue_locked',
      message: 'Issue is locked',
    }
  }

  return {shouldSkip: false}
}

interface PullRequestContextData {
  author: AuthorInfo
  target: TriggerTarget
  commentBody: string | null
  commentId: null
  hasMention: boolean
  command: ParsedCommand | null
  action: string
}

function buildPullRequestContextData(event: GitHubContext['event'], botLogin: string | null): PullRequestContextData {
  if (event.type !== 'pull_request') {
    throw new Error('Event type must be pull_request')
  }

  const author: AuthorInfo = {
    login: event.sender.login,
    association: event.pullRequest.authorAssociation,
    isBot: isBotUser(event.sender.login),
  }

  const target: TriggerTarget = {
    kind: 'pr',
    number: event.pullRequest.number,
    title: event.pullRequest.title,
    body: event.pullRequest.body,
    locked: event.pullRequest.locked,
    isDraft: event.pullRequest.draft,
  }

  const prBody = event.pullRequest.body ?? ''
  const {hasMention, command} = parseBotMentionAndCommand(prBody, botLogin)

  return {
    author,
    target,
    commentBody: event.pullRequest.body,
    commentId: null,
    hasMention,
    command,
    action: event.action,
  }
}

const PR_SUPPORTED_ACTIONS = ['opened', 'synchronize', 'reopened'] as const

function isPRSupportedAction(action: string): action is (typeof PR_SUPPORTED_ACTIONS)[number] {
  return (PR_SUPPORTED_ACTIONS as readonly string[]).includes(action)
}

function checkPullRequestSkipConditions(
  context: TriggerContext,
  config: TriggerConfig,
  logger: Logger,
): SkipCheckResult {
  const action = context.action

  if (action == null || !isPRSupportedAction(action)) {
    logger.debug('Skipping unsupported pull_request action', {action})
    return {
      shouldSkip: true,
      reason: 'action_not_supported',
      message: `Pull request action '${action}' is not supported`,
    }
  }

  if (context.author != null && context.author.isBot) {
    logger.debug('Skipping bot actor', {bot: context.author.login})
    return {
      shouldSkip: true,
      reason: 'self_comment',
      message: `Pull requests from bots (${context.author.login}) are not processed`,
    }
  }

  if (context.author != null && !isAuthorizedAssociation(context.author.association, config.allowedAssociations)) {
    logger.debug('Skipping unauthorized author', {
      association: context.author.association,
      allowed: config.allowedAssociations,
    })
    return {
      shouldSkip: true,
      reason: 'unauthorized_author',
      message: `Author association '${context.author.association}' is not authorized`,
    }
  }

  if (config.skipDraftPRs && context.target?.isDraft === true) {
    logger.debug('Skipping draft PR')
    return {
      shouldSkip: true,
      reason: 'draft_pr',
      message: 'Pull request is a draft',
    }
  }

  if (context.target?.locked === true) {
    logger.debug('Skipping locked pull request')
    return {
      shouldSkip: true,
      reason: 'issue_locked',
      message: 'Pull request is locked',
    }
  }

  return {shouldSkip: false}
}

interface PRReviewCommentContextData {
  author: AuthorInfo
  target: TriggerTarget
  commentBody: string
  commentId: number
  hasMention: boolean
  command: ParsedCommand | null
  action: string
}

function buildPRReviewCommentContextData(
  event: GitHubContext['event'],
  botLogin: string | null,
): PRReviewCommentContextData {
  if (event.type !== 'pull_request_review_comment') {
    throw new Error('Event type must be pull_request_review_comment')
  }

  const author: AuthorInfo = {
    login: event.comment.author,
    association: event.comment.authorAssociation,
    isBot: isBotUser(event.comment.author),
  }

  const target: TriggerTarget = {
    kind: 'pr',
    number: event.pullRequest.number,
    title: event.pullRequest.title,
    body: event.comment.body,
    locked: event.pullRequest.locked,
    path: event.comment.path,
    line: event.comment.line ?? undefined,
    diffHunk: event.comment.diffHunk,
    commitId: event.comment.commitId,
  }

  const {hasMention, command} = parseBotMentionAndCommand(event.comment.body, botLogin)

  return {
    author,
    target,
    commentBody: event.comment.body,
    commentId: event.comment.id,
    hasMention,
    command,
    action: event.action,
  }
}

interface ScheduleContextData {
  author: AuthorInfo
  target: TriggerTarget
  commentBody: string | null
  commentId: null
  hasMention: false
  command: null
  action: null
}

function buildScheduleContextData(
  _event: GitHubContext['event'],
  actor: string,
  promptInput: string | null,
): ScheduleContextData {
  const effectivePrompt = promptInput?.trim() ?? ''

  const target: TriggerTarget = {
    kind: 'manual',
    number: 0,
    title: 'Scheduled workflow',
    body: effectivePrompt === '' ? null : effectivePrompt,
    locked: false,
  }

  const author: AuthorInfo = {
    login: actor,
    association: 'OWNER',
    isBot: false,
  }

  return {
    author,
    target,
    commentBody: effectivePrompt === '' ? null : effectivePrompt,
    commentId: null,
    hasMention: false,
    command: null,
    action: null,
  }
}

function checkScheduleSkipConditions(config: TriggerConfig, logger: Logger): SkipCheckResult {
  const promptInput = config.promptInput?.trim() ?? ''

  if (promptInput === '') {
    logger.debug('Skipping schedule event without prompt input')
    return {
      shouldSkip: true,
      reason: 'prompt_required',
      message: 'Schedule trigger requires prompt input',
    }
  }

  return {shouldSkip: false}
}

function checkWorkflowDispatchSkipConditions(context: TriggerContext, logger: Logger): SkipCheckResult {
  const promptInput = context.commentBody?.trim() ?? ''

  if (promptInput === '') {
    logger.debug('Skipping workflow_dispatch event without prompt input')
    return {
      shouldSkip: true,
      reason: 'prompt_required',
      message: 'Workflow dispatch requires prompt input',
    }
  }

  return {shouldSkip: false}
}

function checkCommentSkipConditions(
  context: TriggerContext,
  config: TriggerConfig,
  logger: Logger,
  options: CommentSkipCheckOptions,
): SkipCheckResult {
  const {targetLabel, actionLabel} = options

  if (context.action !== 'created') {
    logger.debug(`Skipping non-created ${actionLabel} action`, {action: context.action})
    return {
      shouldSkip: true,
      reason: 'action_not_created',
      message: `${actionLabel} action is '${context.action}', not 'created'`,
    }
  }

  if (context.target?.locked === true) {
    logger.debug(`Skipping locked ${targetLabel}`)
    return {
      shouldSkip: true,
      reason: 'issue_locked',
      message: `${targetLabel} is locked`,
    }
  }

  if (context.author != null && context.author.isBot) {
    logger.debug('Skipping bot actor', {bot: context.author.login})
    return {
      shouldSkip: true,
      reason: 'self_comment',
      message: `Comments from bots (${context.author.login}) are not processed`,
    }
  }

  if (context.author != null && !isAuthorizedAssociation(context.author.association, config.allowedAssociations)) {
    logger.debug('Skipping unauthorized author', {
      association: context.author.association,
      allowed: config.allowedAssociations,
    })
    return {
      shouldSkip: true,
      reason: 'unauthorized_author',
      message: `Author association '${context.author.association}' is not authorized`,
    }
  }

  if (config.requireMention && !context.hasMention) {
    logger.debug(`Skipping ${actionLabel} without bot mention`)
    return {
      shouldSkip: true,
      reason: 'no_mention',
      message: 'Comment does not mention the bot',
    }
  }

  return {shouldSkip: false}
}

function checkIssueCommentSkipConditions(
  context: TriggerContext,
  config: TriggerConfig,
  logger: Logger,
): SkipCheckResult {
  return checkCommentSkipConditions(context, config, logger, {
    targetLabel: 'Issue or PR',
    actionLabel: 'Comment',
  })
}

function checkDiscussionCommentSkipConditions(
  context: TriggerContext,
  config: TriggerConfig,
  logger: Logger,
): SkipCheckResult {
  return checkCommentSkipConditions(context, config, logger, {
    targetLabel: 'Discussion',
    actionLabel: 'Discussion comment',
  })
}

function checkPRReviewCommentSkipConditions(
  context: TriggerContext,
  config: TriggerConfig,
  logger: Logger,
): SkipCheckResult {
  const action = context.action
  if (action !== 'created') {
    logger.debug('Skipping non-created review comment action', {action})
    return {
      shouldSkip: true,
      reason: 'action_not_created',
      message: `Review comment action '${action}' is not supported (only 'created')`,
    }
  }

  if (context.target?.locked === true) {
    logger.debug('Skipping locked pull request')
    return {
      shouldSkip: true,
      reason: 'issue_locked',
      message: 'Pull request is locked',
    }
  }

  if (context.author != null && context.author.isBot) {
    logger.debug('Skipping bot actor', {bot: context.author.login})
    return {
      shouldSkip: true,
      reason: 'self_comment',
      message: `Review comments from bots (${context.author.login}) are not processed`,
    }
  }

  if (context.author != null && !isAuthorizedAssociation(context.author.association, config.allowedAssociations)) {
    logger.debug('Skipping unauthorized author', {
      association: context.author.association,
      allowed: config.allowedAssociations,
    })
    return {
      shouldSkip: true,
      reason: 'unauthorized_author',
      message: `Author association '${context.author.association}' is not authorized`,
    }
  }

  if (config.requireMention && !context.hasMention) {
    logger.debug('Skipping review comment without bot mention')
    return {
      shouldSkip: true,
      reason: 'no_mention',
      message: 'Review comment does not mention the bot',
    }
  }

  return {shouldSkip: false}
}

export function checkSkipConditions(context: TriggerContext, config: TriggerConfig, logger: Logger): SkipCheckResult {
  if (context.eventType === 'unsupported') {
    logger.debug('Skipping unsupported event', {eventName: context.eventName})
    return {
      shouldSkip: true,
      reason: 'unsupported_event',
      message: `Unsupported event type: ${context.eventName}`,
    }
  }

  switch (context.eventType) {
    case 'issue_comment':
      return checkIssueCommentSkipConditions(context, config, logger)

    case 'discussion_comment':
      return checkDiscussionCommentSkipConditions(context, config, logger)

    case 'issues':
      return checkIssuesSkipConditions(context, config, logger)

    case 'pull_request':
      return checkPullRequestSkipConditions(context, config, logger)

    case 'pull_request_review_comment':
      return checkPRReviewCommentSkipConditions(context, config, logger)

    case 'schedule':
      return checkScheduleSkipConditions(config, logger)

    case 'workflow_dispatch':
      return checkWorkflowDispatchSkipConditions(context, logger)

    default:
      return {shouldSkip: false}
  }
}

function buildTriggerContext(
  githubContext: GitHubContext,
  botLogin: string | null,
  promptInput: string | null,
): TriggerContext {
  const baseContext = {
    eventType: githubContext.eventType,
    eventName: githubContext.eventName,
    repo: githubContext.repo,
    ref: githubContext.ref,
    sha: githubContext.sha,
    runId: githubContext.runId,
    actor: githubContext.actor,
    raw: githubContext,
  }

  switch (githubContext.eventType) {
    case 'issue_comment': {
      const data = buildIssueCommentContextData(githubContext.event, botLogin)
      return {
        ...baseContext,
        action: data.action,
        author: data.author,
        target: data.target,
        commentBody: data.commentBody,
        commentId: data.commentId,
        hasMention: data.hasMention,
        command: data.command,
      }
    }

    case 'discussion_comment': {
      const data = buildDiscussionContextData(githubContext.event, botLogin)
      return {
        ...baseContext,
        action: data.action,
        author: data.author,
        target: data.target,
        commentBody: data.commentBody,
        commentId: data.commentId,
        hasMention: data.hasMention,
        command: data.command,
      }
    }

    case 'workflow_dispatch': {
      const data = buildWorkflowDispatchContextData(githubContext.event, githubContext.actor)
      return {
        ...baseContext,
        action: data.action,
        author: data.author,
        target: data.target,
        commentBody: data.commentBody,
        commentId: data.commentId,
        hasMention: data.hasMention,
        command: data.command,
      }
    }

    case 'issues': {
      const data = buildIssuesContextData(githubContext.event, botLogin)
      return {
        ...baseContext,
        action: data.action,
        author: data.author,
        target: data.target,
        commentBody: data.commentBody,
        commentId: data.commentId,
        hasMention: data.hasMention,
        command: data.command,
      }
    }

    case 'pull_request': {
      const data = buildPullRequestContextData(githubContext.event, botLogin)
      return {
        ...baseContext,
        action: data.action,
        author: data.author,
        target: data.target,
        commentBody: data.commentBody,
        commentId: data.commentId,
        hasMention: data.hasMention,
        command: data.command,
      }
    }

    case 'pull_request_review_comment': {
      const data = buildPRReviewCommentContextData(githubContext.event, botLogin)
      return {
        ...baseContext,
        action: data.action,
        author: data.author,
        target: data.target,
        commentBody: data.commentBody,
        commentId: data.commentId,
        hasMention: data.hasMention,
        command: data.command,
      }
    }

    case 'schedule': {
      const data = buildScheduleContextData(githubContext.event, githubContext.actor, promptInput)
      return {
        ...baseContext,
        action: data.action,
        author: data.author,
        target: data.target,
        commentBody: data.commentBody,
        commentId: data.commentId,
        hasMention: data.hasMention,
        command: data.command,
      }
    }

    case 'unsupported':
      return {
        ...baseContext,
        action: null,
        author: null,
        target: null,
        commentBody: null,
        commentId: null,
        hasMention: false,
        command: null,
      }
  }
}

export function routeEvent(
  githubContext: GitHubContext,
  logger: Logger,
  config: Partial<TriggerConfig> = {},
): TriggerResult {
  const fullConfig: TriggerConfig = {...DEFAULT_TRIGGER_CONFIG, ...config}

  const context = buildTriggerContext(githubContext, fullConfig.botLogin, fullConfig.promptInput)

  logger.debug('Routing event', {
    eventName: githubContext.eventName,
    eventType: githubContext.eventType,
    hasMention: context.hasMention,
  })

  const skipResult = checkSkipConditions(context, fullConfig, logger)

  if (skipResult.shouldSkip) {
    return {
      shouldProcess: false,
      skipReason: skipResult.reason,
      skipMessage: skipResult.message,
      context,
    }
  }

  return {
    shouldProcess: true,
    context,
  }
}
