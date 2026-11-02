import type {AgentContext} from '../../features/agent/types.js'
import type {TriggerResultProcess} from '../../features/triggers/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {RoutingPhaseResult} from './routing.js'

import {describe, expect, it} from 'vitest'
import {resolveBrokeredPushPlan} from './brokered-push-plan.js'

const TRUSTED_HEAD_SHA = 'a'.repeat(40)

function createBootstrap(
  overrides: Partial<Pick<BootstrapPhaseResult, 'delivery' | 'trustedHeadSha'>> = {},
): Pick<BootstrapPhaseResult, 'delivery' | 'trustedHeadSha'> {
  return {delivery: 'file-convention', trustedHeadSha: TRUSTED_HEAD_SHA, ...overrides}
}

interface RoutingOverrides {
  readonly eventType?: string
  readonly association?: string
  readonly issueType?: AgentContext['issueType']
  readonly hydratedContext?: Record<string, unknown> | null
}

function createRouting(overrides: RoutingOverrides = {}): Pick<RoutingPhaseResult, 'triggerResult' | 'agentContext'> {
  const eventType = overrides.eventType ?? 'issue_comment'
  const hydratedContext =
    overrides.hydratedContext === undefined
      ? {type: 'pull_request', headBranch: 'feature/brokered-fix', isFork: false}
      : overrides.hydratedContext

  return {
    triggerResult: {
      context: {
        eventType,
        eventName: eventType,
        repo: {owner: 'owner', repo: 'repo'},
        author: {login: 'maintainer', association: overrides.association ?? 'COLLABORATOR', isBot: false},
      },
    } as unknown as TriggerResultProcess,
    agentContext: {
      eventName: eventType,
      repo: 'owner/repo',
      issueNumber: 42,
      issueType: overrides.issueType ?? 'pr',
      hydratedContext,
    } as unknown as AgentContext,
  }
}

describe('resolveBrokeredPushPlan', () => {
  it('is eligible for a trusted same-repo PR mention under file-convention delivery', () => {
    // #given / #when
    const plan = resolveBrokeredPushPlan(createBootstrap(), createRouting())

    // #then
    expect(plan).toEqual({eligible: true})
  })

  it('is ineligible for a fork PR', () => {
    const plan = resolveBrokeredPushPlan(
      createBootstrap(),
      createRouting({hydratedContext: {type: 'pull_request', headBranch: 'feature/x', isFork: true}}),
    )

    expect(plan.eligible).toBe(false)
  })

  it.each(['pull_request', 'issues', 'pull_request_review_comment', 'schedule', 'workflow_dispatch'])(
    'is ineligible for a %s trigger',
    eventType => {
      expect(resolveBrokeredPushPlan(createBootstrap(), createRouting({eventType})).eligible).toBe(false)
    },
  )

  it.each(['model-gh', 'none'] as const)('is ineligible under %s delivery', delivery => {
    expect(resolveBrokeredPushPlan(createBootstrap({delivery}), createRouting()).eligible).toBe(false)
  })

  it('is ineligible for a comment on a plain issue', () => {
    expect(resolveBrokeredPushPlan(createBootstrap(), createRouting({issueType: 'issue'})).eligible).toBe(false)
  })

  it.each(['CONTRIBUTOR', 'NONE', 'FIRST_TIME_CONTRIBUTOR', ''])('is ineligible for a %j commenter', association => {
    expect(resolveBrokeredPushPlan(createBootstrap(), createRouting({association})).eligible).toBe(false)
  })

  it('is ineligible without a trusted head SHA anchor', () => {
    expect(resolveBrokeredPushPlan(createBootstrap({trustedHeadSha: ''}), createRouting()).eligible).toBe(false)
  })

  it('is ineligible when the PR context was not hydrated', () => {
    expect(resolveBrokeredPushPlan(createBootstrap(), createRouting({hydratedContext: null})).eligible).toBe(false)
  })

  it('is ineligible when hydrated context is not a pull request', () => {
    const plan = resolveBrokeredPushPlan(createBootstrap(), createRouting({hydratedContext: {type: 'issue'}}))

    expect(plan.eligible).toBe(false)
  })

  it('is ineligible when the head branch is unknown', () => {
    const plan = resolveBrokeredPushPlan(
      createBootstrap(),
      createRouting({hydratedContext: {type: 'pull_request', headBranch: '', isFork: false}}),
    )

    expect(plan.eligible).toBe(false)
  })

  it('explains an ineligible decision', () => {
    // #given / #when
    const plan = resolveBrokeredPushPlan(createBootstrap(), createRouting({eventType: 'issues'}))

    // #then
    expect(plan.eligible).toBe(false)
    expect(plan.eligible === false ? plan.reason : '').toContain('issue comment')
  })
})
