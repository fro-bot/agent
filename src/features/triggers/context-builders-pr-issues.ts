import type {GitHubContext} from '../../services/github/types.js'
import type {TriggerContextData} from './context-builders-types.js'
import type {AuthorInfo, TriggerTarget} from './types.js'
import {isBotUser} from './author-utils.js'
import {parseBotMentionAndCommand} from './mention-command.js'

export function buildIssuesContextData(event: GitHubContext['event'], botLogin: string | null): TriggerContextData {
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
    action: event.action,
    author,
    target,
    commentBody: event.issue.body,
    commentId: null,
    hasMention,
    command,
  }
}

export function buildPullRequestContextData(
  event: GitHubContext['event'],
  botLogin: string | null,
): TriggerContextData {
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
    action: event.action,
    author,
    target,
    commentBody: event.pullRequest.body,
    commentId: null,
    hasMention,
    command,
  }
}
