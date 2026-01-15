import type {GitHubContext, IssueCommentPayload} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {
  AuthorInfo,
  ParsedCommand,
  SkipReason,
  TriggerConfig,
  TriggerContext,
  TriggerResult,
  TriggerTarget,
  TriggerType,
} from './types.js'
import {getAuthorAssociation, getCommentAuthor, isIssueLocked, isPullRequest} from '../github/context.js'
import {ALLOWED_ASSOCIATIONS, DEFAULT_TRIGGER_CONFIG} from './types.js'

export function classifyTrigger(eventName: string): TriggerType {
  switch (eventName) {
    case 'issue_comment':
      return 'issue_comment'
    case 'discussion':
    case 'discussion_comment':
      return 'discussion_comment'
    case 'workflow_dispatch':
      return 'workflow_dispatch'
    case 'issues':
      return 'issues'
    case 'pull_request':
      return 'pull_request'
    case 'pull_request_review_comment':
      return 'pull_request_review_comment'
    case 'schedule':
      return 'schedule'
    default:
      return 'unsupported'
  }
}

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
  const firstPart = parts[0]
  const action = firstPart != null && firstPart.length > 0 ? firstPart : null
  const args = parts.slice(1).join(' ')

  return {raw, action, args}
}

function isSelfComment(authorLogin: string, botLogin: string | null): boolean {
  if (botLogin == null || botLogin.length === 0) {
    return false
  }

  const normalizedAuthor = authorLogin.toLowerCase()
  const normalizedBot = botLogin.toLowerCase()

  return normalizedAuthor === normalizedBot || normalizedAuthor === `${normalizedBot}[bot]`
}

function isAuthorizedAssociation(association: string, allowed: readonly string[]): boolean {
  return allowed.includes(association)
}

function buildIssueCommentAuthorInfo(payload: IssueCommentPayload): AuthorInfo {
  const login = getCommentAuthor(payload)
  const association = getAuthorAssociation(payload)
  const isBot = login.endsWith('[bot]') || payload.comment.user.login.includes('[bot]')

  return {login, association, isBot}
}

function buildIssueCommentTarget(payload: IssueCommentPayload): TriggerTarget {
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
  if (botLogin == null || botLogin.length === 0 || commentBody == null) {
    return {hasMention: false, command: null}
  }

  const hasMention = hasBotMention(commentBody, botLogin)
  const command = hasMention ? extractCommand(commentBody, botLogin) : null

  return {hasMention, command}
}

function buildIssueCommentContextData(payload: IssueCommentPayload, botLogin: string | null): IssueCommentContextData {
  const author = buildIssueCommentAuthorInfo(payload)
  const target = buildIssueCommentTarget(payload)
  const commentBody = payload.comment.body
  const commentId = payload.comment.id

  const {hasMention, command} = parseBotMentionAndCommand(commentBody, botLogin)

  return {author, target, commentBody, commentId, hasMention, command}
}

interface DiscussionPayload {
  discussion?: {
    number?: number
    title?: string
    body?: string
    locked?: boolean
  }
  comment?: {
    id?: number
    body?: string
    user?: {login?: string}
    author_association?: string
  }
  action?: string
}

interface DiscussionContextData {
  author: AuthorInfo | null
  target: TriggerTarget
  commentBody: string | null
  commentId: number | null
  hasMention: boolean
  command: ParsedCommand | null
}

function buildDiscussionContextData(payload: DiscussionPayload, botLogin: string | null): DiscussionContextData {
  const discussion = payload.discussion
  const comment = payload.comment

  if (discussion == null) {
    return {
      author: null,
      target: {kind: 'discussion', number: 0, title: '', body: null, locked: false},
      commentBody: null,
      commentId: null,
      hasMention: false,
      command: null,
    }
  }

  const author: AuthorInfo | null =
    comment?.user?.login == null
      ? null
      : {
          login: comment.user.login,
          association: comment.author_association ?? 'NONE',
          isBot: comment.user.login.endsWith('[bot]'),
        }

  const target: TriggerTarget = {
    kind: 'discussion',
    number: discussion.number ?? 0,
    title: discussion.title ?? '',
    body: comment?.body ?? discussion.body ?? null,
    locked: discussion.locked ?? false,
  }

  const commentBody = comment?.body ?? null
  const commentId = comment?.id ?? null

  const {hasMention, command} = parseBotMentionAndCommand(commentBody, botLogin)

  return {author, target, commentBody, commentId, hasMention, command}
}

interface WorkflowDispatchPayload {
  inputs?: Record<string, string>
}

interface WorkflowDispatchContextData {
  author: AuthorInfo
  target: TriggerTarget
  commentBody: string | null
  commentId: null
  hasMention: false
  command: null
}

function buildWorkflowDispatchContextData(
  payload: WorkflowDispatchPayload,
  actor: string,
): WorkflowDispatchContextData {
  const inputs = payload.inputs
  const promptInput = inputs?.prompt ?? ''

  const target: TriggerTarget = {
    kind: 'manual',
    number: 0,
    title: 'Manual workflow dispatch',
    body: promptInput.length > 0 ? promptInput : null,
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
    commentBody: promptInput.length > 0 ? promptInput : null,
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

interface IssuesPayload {
  action: string
  issue: {
    number: number
    title: string
    body: string | null
    state: string
    user: {login: string}
    locked: boolean
    author_association?: string
  }
  repository: {
    owner: {login: string}
    name: string
  }
  sender: {login: string}
}

interface IssuesContextData {
  author: AuthorInfo
  target: TriggerTarget
  commentBody: string | null
  commentId: null
  hasMention: boolean
  command: ParsedCommand | null
}

function buildIssuesContextData(payload: IssuesPayload, botLogin: string | null): IssuesContextData {
  const issue = payload.issue
  const issueBody = issue.body ?? ''

  const author: AuthorInfo = {
    login: payload.sender.login,
    association: issue.author_association ?? 'NONE',
    isBot: payload.sender.login.endsWith('[bot]'),
  }

  const target: TriggerTarget = {
    kind: 'issue',
    number: issue.number,
    title: issue.title,
    body: issue.body,
    locked: issue.locked,
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

const ISSUES_SUPPORTED_ACTIONS = ['opened', 'edited'] as const

function isIssuesSupportedAction(action: string): action is (typeof ISSUES_SUPPORTED_ACTIONS)[number] {
  return (ISSUES_SUPPORTED_ACTIONS as readonly string[]).includes(action)
}

function checkIssuesSkipConditions(context: TriggerContext, _config: TriggerConfig, logger: Logger): SkipCheckResult {
  const payload = context.raw.payload as IssuesPayload
  const action = payload.action

  if (!isIssuesSupportedAction(action)) {
    logger.debug('Skipping unsupported issues action', {action})
    return {
      shouldSkip: true,
      reason: 'action_not_supported',
      message: `Issues action '${action}' is not supported (only 'opened' and 'edited')`,
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

interface PullRequestPayload {
  action: string
  pull_request: {
    number: number
    title: string
    body: string | null
    state: string
    user: {login: string}
    draft: boolean
    locked: boolean
    author_association?: string
  }
  repository: {
    owner: {login: string}
    name: string
  }
  sender: {login: string}
}

interface PullRequestContextData {
  author: AuthorInfo
  target: TriggerTarget
  commentBody: string | null
  commentId: null
  hasMention: boolean
  command: ParsedCommand | null
}

function buildPullRequestContextData(payload: PullRequestPayload, botLogin: string | null): PullRequestContextData {
  const pr = payload.pull_request
  const prBody = pr.body ?? ''

  const author: AuthorInfo = {
    login: payload.sender.login,
    association: pr.author_association ?? 'NONE',
    isBot: payload.sender.login.endsWith('[bot]'),
  }

  const target: TriggerTarget = {
    kind: 'pr',
    number: pr.number,
    title: pr.title,
    body: pr.body,
    locked: pr.locked,
    isDraft: pr.draft,
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
  const payload = context.raw.payload as PullRequestPayload
  const action = payload.action

  if (!isPRSupportedAction(action)) {
    logger.debug('Skipping unsupported pull_request action', {action})
    return {
      shouldSkip: true,
      reason: 'action_not_supported',
      message: `Pull request action '${action}' is not supported`,
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

interface PRReviewCommentPayload {
  action: string
  pull_request: {
    number: number
    title: string
    locked: boolean
  }
  comment: {
    id: number
    body: string
    user: {login: string}
    author_association: string
    path: string
    line: number | null
    diff_hunk: string
    commit_id: string
  }
  repository: {
    owner: {login: string}
    name: string
  }
  sender: {login: string}
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
  payload: PRReviewCommentPayload,
  botLogin: string | null,
): PRReviewCommentContextData {
  const pr = payload.pull_request
  const comment = payload.comment

  const author: AuthorInfo = {
    login: comment.user.login,
    association: comment.author_association,
    isBot: comment.user.login.endsWith('[bot]'),
  }

  const target: TriggerTarget = {
    kind: 'pr',
    number: pr.number,
    title: pr.title,
    body: comment.body,
    locked: pr.locked,
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
    body: effectivePrompt.length > 0 ? effectivePrompt : null,
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
    commentBody: effectivePrompt.length > 0 ? effectivePrompt : null,
    commentId: null,
    hasMention: false,
    command: null,
  }
}

function checkScheduleSkipConditions(config: TriggerConfig, logger: Logger): SkipCheckResult {
  const promptInput = config.promptInput?.trim() ?? ''

  if (promptInput.length === 0) {
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

  if (promptInput.length === 0) {
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

  if (context.author != null && isSelfComment(context.author.login, config.botLogin)) {
    logger.debug('Skipping self-comment (anti-loop)')
    return {
      shouldSkip: true,
      reason: 'self_comment',
      message: 'Comment is from the bot itself',
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

export function checkSkipConditions(context: TriggerContext, config: TriggerConfig, logger: Logger): SkipCheckResult {
  if (context.triggerType === 'unsupported') {
    logger.debug('Skipping unsupported event', {eventName: context.eventName})
    return {
      shouldSkip: true,
      reason: 'unsupported_event',
      message: `Unsupported event type: ${context.eventName}`,
    }
  }

  switch (context.triggerType) {
    case 'issue_comment':
      return checkIssueCommentSkipConditions(context, config, logger)

    case 'discussion_comment':
      return checkDiscussionCommentSkipConditions(context, config, logger)

    case 'issues':
      return checkIssuesSkipConditions(context, config, logger)

    case 'pull_request':
      return checkPullRequestSkipConditions(context, config, logger)

    case 'pull_request_review_comment':
      return checkCommentSkipConditions(context, config, logger, {
        targetLabel: 'Pull request',
        actionLabel: 'Review comment',
      })

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
  triggerType: TriggerType,
  botLogin: string | null,
  promptInput: string | null,
): TriggerContext {
  const baseContext = {
    triggerType,
    eventName: githubContext.eventName,
    repo: githubContext.repo,
    ref: githubContext.ref,
    sha: githubContext.sha,
    runId: githubContext.runId,
    actor: githubContext.actor,
    raw: githubContext,
  }

  switch (triggerType) {
    case 'issue_comment': {
      const payload = githubContext.payload as IssueCommentPayload
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
      const payload = githubContext.payload as DiscussionPayload
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
      const payload = githubContext.payload as WorkflowDispatchPayload
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
      const payload = githubContext.payload as IssuesPayload
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
      const payload = githubContext.payload as PullRequestPayload
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
      const payload = githubContext.payload as PRReviewCommentPayload
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

  const triggerType = classifyTrigger(githubContext.eventName)
  const context = buildTriggerContext(githubContext, triggerType, fullConfig.botLogin, fullConfig.promptInput)

  logger.debug('Routing event', {
    eventName: githubContext.eventName,
    triggerType,
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

export {ALLOWED_ASSOCIATIONS}
