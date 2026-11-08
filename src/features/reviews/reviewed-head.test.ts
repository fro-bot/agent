import type {AgentContext, PullRequestContext, TriggerContext} from '@fro-bot/runtime'
import {describe, expect, it} from 'vitest'
import {resolveReviewedHeadSha} from './reviewed-head.js'

function hydrated(headSha: string): AgentContext['hydratedContext'] {
  return {type: 'pull_request', headSha} as unknown as PullRequestContext
}

function trigger(
  eventType: TriggerContext['eventType'],
  headSha?: string,
  kind: 'pr' | 'issue' = 'pr',
): Pick<TriggerContext, 'eventType' | 'target'> {
  return {
    eventType,
    target: {kind, number: 7, title: 'T', body: null, locked: false, ...(headSha === undefined ? {} : {headSha})},
  }
}

describe('resolveReviewedHeadSha', () => {
  it('uses the pull_request event head, ignoring a later-hydrated head', () => {
    // #given a pull_request event head A and hydration that already saw B
    // #when resolving
    const sha = resolveReviewedHeadSha({hydratedContext: hydrated('B')}, trigger('pull_request', 'A'))

    // #then the immutable event head wins
    expect(sha).toBe('A')
  })

  it('returns null for a pull_request with no event head, without borrowing the hydrated head', () => {
    expect(resolveReviewedHeadSha({hydratedContext: hydrated('B')}, trigger('pull_request'))).toBeNull()
  })

  it('returns null for a pull_request with an empty event head', () => {
    expect(resolveReviewedHeadSha({hydratedContext: null}, trigger('pull_request', ''))).toBeNull()
  })

  it('uses the hydrated PR head for an issue_comment', () => {
    expect(resolveReviewedHeadSha({hydratedContext: hydrated('H')}, trigger('issue_comment'))).toBe('H')
  })

  it('returns null for an issue_comment whose hydration failed', () => {
    expect(resolveReviewedHeadSha({hydratedContext: null}, trigger('issue_comment'))).toBeNull()
  })

  it('returns null when the hydrated context is an issue, not a PR', () => {
    const issue = {type: 'issue'} as unknown as AgentContext['hydratedContext']
    expect(resolveReviewedHeadSha({hydratedContext: issue}, trigger('issue_comment', undefined, 'issue'))).toBeNull()
  })
})
