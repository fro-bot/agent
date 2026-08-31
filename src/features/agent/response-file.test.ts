import type {AgentContext, TriggerContext} from '@fro-bot/runtime'
import {describe, expect, it} from 'vitest'
import {resolveResponseSurface} from './response-file.js'

function makeAgentContext(issueType: AgentContext['issueType']): Pick<AgentContext, 'issueType'> {
  return {issueType}
}

type TriggerAuthor = NonNullable<TriggerContext['author']>

function makeTriggerContext(
  eventType: TriggerContext['eventType'],
  options: {
    readonly author?: Partial<TriggerAuthor> & {readonly association?: TriggerAuthor['association'] | undefined}
    readonly hasMention?: TriggerContext['hasMention'] | undefined
  } = {},
): Pick<TriggerContext, 'eventType'> & typeof options {
  return {eventType, ...options}
}

describe('resolveResponseSurface', () => {
  it('keeps pull_request triggers on the review-required surface', () => {
    // #given a pull request trigger for a pull request
    // #when the response surface is resolved
    const surface = resolveResponseSurface(makeAgentContext('pr'), makeTriggerContext('pull_request'))

    // #then the existing required-review behavior is unchanged
    expect(surface).toBe('pr-review')
  })

  it('uses the review-permitted surface for an authorized issue_comment mention on a pull request', () => {
    // #given an issue_comment trigger from a non-bot member targeting a pull request
    const triggerContext = makeTriggerContext('issue_comment', {
      author: {login: 'member', association: 'MEMBER', isBot: false},
      hasMention: true,
    })

    // #when the response surface is resolved
    const surface = resolveResponseSurface(makeAgentContext('pr'), triggerContext)

    // #then a verdict is permitted without making it mandatory
    expect(surface).toBe('pr-review-permitted')
  })

  it('keeps contributor comments on the comment surface', () => {
    // #given an issue_comment mention from an unauthorized contributor
    const triggerContext = makeTriggerContext('issue_comment', {
      author: {login: 'contributor', association: 'CONTRIBUTOR', isBot: false},
      hasMention: true,
    })

    // #when the response surface is resolved
    const surface = resolveResponseSurface(makeAgentContext('pr'), triggerContext)

    // #then review authority is not granted
    expect(surface).toBe('pr-comment')
  })

  it('keeps bot-authored mentions on the comment surface', () => {
    // #given an issue_comment mention from a bot with an allowed association
    const triggerContext = makeTriggerContext('issue_comment', {
      author: {login: 'automation[bot]', association: 'MEMBER', isBot: true},
      hasMention: true,
    })

    // #when the response surface is resolved
    const surface = resolveResponseSurface(makeAgentContext('pr'), triggerContext)

    // #then review authority is not granted
    expect(surface).toBe('pr-comment')
  })

  it('keeps non-mention comments on the comment surface', () => {
    // #given an authorized non-bot author whose comment does not mention the bot
    const triggerContext = makeTriggerContext('issue_comment', {
      author: {login: 'member', association: 'MEMBER', isBot: false},
      hasMention: false,
    })

    // #when the response surface is resolved
    const surface = resolveResponseSurface(makeAgentContext('pr'), triggerContext)

    // #then review authority is not granted
    expect(surface).toBe('pr-comment')
  })

  it('fails closed when the comment author association is missing or undefined', () => {
    // #given an authorized-looking non-bot mention without an association
    const missingAssociation = makeTriggerContext('issue_comment', {
      author: {login: 'member', isBot: false},
      hasMention: true,
    })
    const undefinedAssociation = makeTriggerContext('issue_comment', {
      author: {login: 'member', association: undefined, isBot: false},
      hasMention: true,
    })

    // #when the response surface is resolved for either malformed context
    const missingSurface = resolveResponseSurface(makeAgentContext('pr'), missingAssociation)
    const undefinedSurface = resolveResponseSurface(makeAgentContext('pr'), undefinedAssociation)

    // #then neither context grants review authority
    expect(missingSurface).toBe('pr-comment')
    expect(undefinedSurface).toBe('pr-comment')
  })

  it('fails closed when the mention field is missing or undefined', () => {
    // #given an authorized non-bot comment with no usable mention signal
    const missingMention = makeTriggerContext('issue_comment', {
      author: {login: 'member', association: 'MEMBER', isBot: false},
    })
    const undefinedMention = makeTriggerContext('issue_comment', {
      author: {login: 'member', association: 'MEMBER', isBot: false},
      hasMention: undefined,
    })

    // #when the response surface is resolved for either malformed context
    const missingSurface = resolveResponseSurface(makeAgentContext('pr'), missingMention)
    const undefinedSurface = resolveResponseSurface(makeAgentContext('pr'), undefinedMention)

    // #then neither context grants review authority
    expect(missingSurface).toBe('pr-comment')
    expect(undefinedSurface).toBe('pr-comment')
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
