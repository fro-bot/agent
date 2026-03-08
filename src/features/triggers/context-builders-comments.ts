import type {GitHubContext} from '../../services/github/types.js'
import type {TriggerContextData} from './context-builders-types.js'
import type {AuthorInfo, TriggerTarget} from './types.js'
import {isBotUser} from './author-utils.js'
import {parseBotMentionAndCommand} from './mention-command.js'

export function buildIssueCommentContextData(
  event: GitHubContext['event'],
  botLogin: string | null,
): TriggerContextData {
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
  const {hasMention, command} = parseBotMentionAndCommand(event.comment.body, botLogin)

  return {
    action: event.action,
    author,
    target,
    commentBody: event.comment.body,
    commentId: event.comment.id,
    hasMention,
    command,
    isBotReviewRequested: false,
  }
}

export function buildDiscussionContextData(event: GitHubContext['event'], botLogin: string | null): TriggerContextData {
  if (event.type !== 'discussion_comment') {
    throw new Error('Event type must be discussion_comment')
  }

  const author: AuthorInfo = {
    login: event.comment.author,
    association: event.comment.authorAssociation,
    isBot: isBotUser(event.comment.author),
  }
  const commentBody = event.comment.body ?? null
  const target: TriggerTarget = {
    kind: 'discussion',
    number: event.discussion.number,
    title: event.discussion.title,
    body: commentBody ?? event.discussion.body ?? null,
    locked: event.discussion.locked,
  }
  const {hasMention, command} = parseBotMentionAndCommand(commentBody, botLogin)

  return {
    action: event.action,
    author,
    target,
    commentBody,
    commentId: event.comment.id,
    hasMention,
    command,
    isBotReviewRequested: false,
  }
}

export function buildPRReviewCommentContextData(
  event: GitHubContext['event'],
  botLogin: string | null,
): TriggerContextData {
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
    action: event.action,
    author,
    target,
    commentBody: event.comment.body,
    commentId: event.comment.id,
    hasMention,
    command,
    isBotReviewRequested: false,
  }
}
