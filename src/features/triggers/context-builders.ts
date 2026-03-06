import type {GitHubContext} from '../../services/github/types.js'
import type {TriggerContextData} from './context-builders-types.js'
import type {TriggerContext} from './types.js'
import {
  buildDiscussionContextData,
  buildIssueCommentContextData,
  buildPRReviewCommentContextData,
} from './context-builders-comments.js'
import {buildScheduleContextData, buildWorkflowDispatchContextData} from './context-builders-manual.js'
import {buildIssuesContextData, buildPullRequestContextData} from './context-builders-pr-issues.js'

function mergeContext(
  baseContext: Omit<TriggerContext, keyof TriggerContextData>,
  data: TriggerContextData,
): TriggerContext {
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

export function buildTriggerContext(
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
    case 'issue_comment':
      return mergeContext(baseContext, buildIssueCommentContextData(githubContext.event, botLogin))
    case 'discussion_comment':
      return mergeContext(baseContext, buildDiscussionContextData(githubContext.event, botLogin))
    case 'workflow_dispatch':
      return mergeContext(
        baseContext,
        buildWorkflowDispatchContextData(githubContext.event, githubContext.actor, promptInput),
      )
    case 'issues':
      return mergeContext(baseContext, buildIssuesContextData(githubContext.event, botLogin))
    case 'pull_request':
      return mergeContext(baseContext, buildPullRequestContextData(githubContext.event, botLogin))
    case 'pull_request_review_comment':
      return mergeContext(baseContext, buildPRReviewCommentContextData(githubContext.event, botLogin))
    case 'schedule':
      return mergeContext(baseContext, buildScheduleContextData(githubContext.event, githubContext.actor, promptInput))
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
