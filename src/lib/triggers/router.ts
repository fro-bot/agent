import type {
  DiscussionCommentEvent,
  IssueCommentEvent,
  IssuesEvent,
  PullRequestEvent,
  PullRequestReviewCommentEvent,
  WorkflowDispatchEvent,
} from '@octokit/webhooks-types'
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
import {getAuthorAssociation, getCommentAuthor, isIssueLocked, isPullRequest} from '../github/context.js'
import {DEFAULT_TRIGGER_CONFIG} from './types.js'

export function hasBotMention(text: string, botLogin: string): boolean {
  if (botLogin.length === 0) {
    return false
  }

  // Match @botLogin or @botLogin[bot] with word boundary
  // (?:$|[^\w]) ensures we don't match @fro-botty when looking for @fro-bot
  const pattern = new RegExp(String.raw`@${escapeRegExp(botLogin)}(?:\[bot\])?(?:$|[^\w])`, 'i')
  return pattern.test(text)
}

function escapeRegExp(str: string): string {
  return str.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

export function extractCommand(text: string, botLogin: string): ParsedCommand | null {
  if (botLogin.length === 0) {
    return null
  }

  const pattern = new RegExp(String.raw`@${escapeRegExp(botLogin)}(?:\[bot\])?\s*(.*)`, 'is')
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

function buildIssueCommentAuthorInfo(payload: IssueCommentEvent): AuthorInfo {
  const login = getCommentAuthor(payload)
  const association = getAuthorAssociation(payload)

  return {login, association, isBot: isBotUser(login)}
}

function buildIssueCommentTarget(payload: IssueCommentEvent): TriggerTarget {
  const kind = isPullRequest(payload) ? 'pr' : 'issue'

  return {
    kind,
    number: payload.issue.number,
    title: payload.issue.title,
    body: payload.comment.body ?? null,
    locked: isIssueLocked(payload),
  }
}

interface IssueCommentContextData {
  author: AuthorInfo
  target: TriggerTarget
  commentBody: string
  commentId: number
  hasMention: boolean
  command: ParsedCommand | null
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

function buildIssueCommentContextData(payload: IssueCommentEvent, botLogin: string | null): IssueCommentContextData {
  const author = buildIssueCommentAuthorInfo(payload)
  const target = buildIssueCommentTarget(payload)
  const commentBody = payload.comment.body
  const commentId = payload.comment.id

  const {hasMention, command} = parseBotMentionAndCommand(commentBody, botLogin)

  return {author, target, commentBody, commentId, hasMention, command}
}

interface DiscussionContextData {
  author: AuthorInfo | null
  target: TriggerTarget
  commentBody: string | null
  commentId: number | null
  hasMention: boolean
  command: ParsedCommand | null
}

function buildDiscussionContextData(payload: DiscussionCommentEvent, botLogin: string | null): DiscussionContextData {
  const discussion = payload.discussion
  const comment = payload.comment

  const author: AuthorInfo = {
    login: comment.user.login,
    association: comment.author_association ?? 'NONE',
    isBot: isBotUser(comment.user.login),
  }

  const target: TriggerTarget = {
    kind: 'discussion',
    number: discussion.number,
    title: discussion.title,
    body: comment.body ?? discussion.body ?? null,
    locked: discussion.locked ?? false,
  }

  const commentBody = comment.body ?? null
  const commentId = comment.id

  const {hasMention, command} = parseBotMentionAndCommand(commentBody, botLogin)

  return {author, target, commentBody, commentId, hasMention, command}
}

interface WorkflowDispatchContextData {
  author: AuthorInfo
  target: TriggerTarget
  commentBody: string | null
  commentId: null
  hasMention: false
  command: null
}

function buildWorkflowDispatchContextData(payload: WorkflowDispatchEvent, actor: string): WorkflowDispatchContextData {
  const inputs = payload.inputs
  const promptInput = (inputs?.prompt as string | undefined) ?? ''

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
}

function buildIssuesContextData(payload: IssuesEvent, botLogin: string | null): IssuesContextData {
  const issue = payload.issue
  const issueBody = issue.body ?? ''

  const author: AuthorInfo = {
    login: payload.sender.login,
    association: issue.author_association ?? 'NONE',
    isBot: isBotUser(payload.sender.login),
  }

  const target: TriggerTarget = {
    kind: 'issue',
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    locked: issue.locked ?? false,
  }

  const {hasMention, command} = parseBotMentionAndCommand(issueBody, botLogin)

  return {
    author,
    target,
    commentBody: issue.body,
    commentId: null,
    hasMention,
    command,
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
  const payload = context.raw.payload as IssuesEvent
  const action = payload.action

  if (!isIssuesSupportedAction(action)) {
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
}

function buildPullRequestContextData(payload: PullRequestEvent, botLogin: string | null): PullRequestContextData {
  const pr = payload.pull_request
  const prBody = pr.body ?? ''

  const author: AuthorInfo = {
    login: payload.sender.login,
    association: pr.author_association ?? 'NONE',
    isBot: isBotUser(payload.sender.login),
  }

  const target: TriggerTarget = {
    kind: 'pr',
    number: pr.number,
    title: pr.title,
    body: pr.body ?? null,
    locked: pr.locked ?? false,
    isDraft: pr.draft ?? false,
  }

  const {hasMention, command} = parseBotMentionAndCommand(prBody, botLogin)

  return {
    author,
    target,
    commentBody: pr.body,
    commentId: null,
    hasMention,
    command,
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
  const payload = context.raw.payload as PullRequestEvent
  const action = payload.action

  if (!isPRSupportedAction(action)) {
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
}

function buildPRReviewCommentContextData(
  payload: PullRequestReviewCommentEvent,
  botLogin: string | null,
): PRReviewCommentContextData {
  const pr = payload.pull_request
  const comment = payload.comment

  const author: AuthorInfo = {
    login: comment.user.login,
    association: comment.author_association,
    isBot: isBotUser(comment.user.login),
  }

  const target: TriggerTarget = {
    kind: 'pr',
    number: pr.number,
    title: pr.title,
    body: comment.body,
    locked: pr.locked ?? false,
    path: comment.path,
    line: comment.line ?? undefined,
    diffHunk: comment.diff_hunk,
    commitId: comment.commit_id,
  }

  const {hasMention, command} = parseBotMentionAndCommand(comment.body, botLogin)

  return {
    author,
    target,
    commentBody: comment.body,
    commentId: comment.id,
    hasMention,
    command,
  }
}

interface SchedulePayload {
  schedule?: string
}

interface ScheduleContextData {
  author: AuthorInfo
  target: TriggerTarget
  commentBody: string | null
  commentId: null
  hasMention: false
  command: null
}

function buildScheduleContextData(
  _payload: SchedulePayload,
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
  const payload = context.raw.payload as {action?: string}
  const {targetLabel, actionLabel} = options

  if (payload.action !== 'created') {
    logger.debug(`Skipping non-created ${actionLabel} action`, {action: payload.action})
    return {
      shouldSkip: true,
      reason: 'action_not_created',
      message: `${actionLabel} action is '${payload.action}', not 'created'`,
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

const PR_REVIEW_COMMENT_SUPPORTED_ACTIONS = ['created'] as const

function checkPRReviewCommentSkipConditions(
  context: TriggerContext,
  config: TriggerConfig,
  logger: Logger,
): SkipCheckResult {
  const payload = context.raw.payload as {action?: string}
  if (
    !PR_REVIEW_COMMENT_SUPPORTED_ACTIONS.includes(
      payload.action as (typeof PR_REVIEW_COMMENT_SUPPORTED_ACTIONS)[number],
    )
  ) {
    logger.debug('Skipping non-created review comment action', {action: payload.action})
    return {
      shouldSkip: true,
      reason: 'action_not_created',
      message: `Review comment action '${payload.action}' is not supported (only 'created')`,
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
      const payload = githubContext.payload as IssueCommentEvent
      const data = buildIssueCommentContextData(payload, botLogin)
      return {
        ...baseContext,
        author: data.author,
        target: data.target,
        commentBody: data.commentBody,
        commentId: data.commentId,
        hasMention: data.hasMention,
        command: data.command,
      }
    }

    case 'discussion_comment': {
      const payload = githubContext.payload as DiscussionCommentEvent
      const data = buildDiscussionContextData(payload, botLogin)
      return {
        ...baseContext,
        author: data.author,
        target: data.target,
        commentBody: data.commentBody,
        commentId: data.commentId,
        hasMention: data.hasMention,
        command: data.command,
      }
    }

    case 'workflow_dispatch': {
      const payload = githubContext.payload as WorkflowDispatchEvent
      const data = buildWorkflowDispatchContextData(payload, githubContext.actor)
      return {
        ...baseContext,
        author: data.author,
        target: data.target,
        commentBody: data.commentBody,
        commentId: data.commentId,
        hasMention: data.hasMention,
        command: data.command,
      }
    }

    case 'issues': {
      const payload = githubContext.payload as IssuesEvent
      const data = buildIssuesContextData(payload, botLogin)
      return {
        ...baseContext,
        author: data.author,
        target: data.target,
        commentBody: data.commentBody,
        commentId: data.commentId,
        hasMention: data.hasMention,
        command: data.command,
      }
    }

    case 'pull_request': {
      const payload = githubContext.payload as PullRequestEvent
      const data = buildPullRequestContextData(payload, botLogin)
      return {
        ...baseContext,
        author: data.author,
        target: data.target,
        commentBody: data.commentBody,
        commentId: data.commentId,
        hasMention: data.hasMention,
        command: data.command,
      }
    }

    case 'pull_request_review_comment': {
      const payload = githubContext.payload as PullRequestReviewCommentEvent
      const data = buildPRReviewCommentContextData(payload, botLogin)
      return {
        ...baseContext,
        author: data.author,
        target: data.target,
        commentBody: data.commentBody,
        commentId: data.commentId,
        hasMention: data.hasMention,
        command: data.command,
      }
    }

    case 'schedule': {
      const payload = githubContext.payload as SchedulePayload
      const data = buildScheduleContextData(payload, githubContext.actor, promptInput)
      return {
        ...baseContext,
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

  const context = buildTriggerContext(githubContext, fullConfig.login, fullConfig.promptInput)

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
