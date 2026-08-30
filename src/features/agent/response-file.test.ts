import type {AgentContext, TriggerContext} from '@fro-bot/runtime'
import {describe, expect, it} from 'vitest'
import {resolveResponseSurface} from './response-file.js'

function makeAgentContext(issueType: AgentContext['issueType']): Pick<AgentContext, 'issueType'> {
  return {issueType}
}

function makeTriggerContext(eventType: TriggerContext['eventType']): Pick<TriggerContext, 'eventType'> {
  return {eventType}
}

describe('resolveResponseSurface', () => {
  it('keeps pull_request triggers on the review-required surface', () => {
    // #given a pull request trigger for a pull request
    // #when the response surface is resolved
    const surface = resolveResponseSurface(makeAgentContext('pr'), makeTriggerContext('pull_request'))

    // #then the existing required-review behavior is unchanged
    expect(surface).toBe('pr-review')
  })

  it('uses the review-permitted surface for issue_comment mentions on a pull request', () => {
    // #given an issue_comment trigger targeting a pull request
    // #when the response surface is resolved
    const surface = resolveResponseSurface(makeAgentContext('pr'), makeTriggerContext('issue_comment'))

    // #then a verdict is permitted without making it mandatory
    expect(surface).toBe('pr-review-optional')
  })

  it('keeps issue_comment triggers on issues as comment-only', () => {
    // #given an issue_comment trigger targeting an issue
    // #when the response surface is resolved
    const surface = resolveResponseSurface(makeAgentContext('issue'), makeTriggerContext('issue_comment'))

    // #then the response remains a comment
    expect(surface).toBe('issue-comment')
  })

  it('does not promote pull_request_review_comment triggers to reviews', () => {
    // #given an inline review comment trigger on a pull request
    // #when the response surface is resolved
    const surface = resolveResponseSurface(makeAgentContext('pr'), makeTriggerContext('pull_request_review_comment'))

    // #then inline review comments remain comment-only
    expect(surface).toBe('pr-comment')
  })
})
