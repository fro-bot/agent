import type {BrokeredPushEventFacts} from '../../features/delegated/brokered-push-gate.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {RoutingPhaseResult} from './routing.js'

import {evaluateBrokeredPushEarlyGate} from '../../features/delegated/brokered-push-gate.js'

/**
 * Whether the Action will certainly attempt a brokered push for this invocation, from everything knowable
 * before the agent runs. It gates only the prompt bullet telling the agent the Action pushes its changes,
 * so it is deliberately narrower than finalize's decision: finalize also runs the broker (and fails loudly)
 * when the PR context is missing or the PR is a fork, but the agent must not be promised a push there.
 * It reuses the broker's early gate so the trigger, association and anchor rules cannot drift. The post-run
 * half -- execution success, no execution veto, changes actually existing, live permission and the
 * pre-write PR check -- stays in finalize and the broker.
 */
export type BrokeredPushPlan = {readonly eligible: true} | {readonly eligible: false; readonly reason: string}

export function resolveBrokeredPushPlan(
  bootstrap: Pick<BootstrapPhaseResult, 'delivery' | 'trustedHeadSha'>,
  routing: Pick<RoutingPhaseResult, 'triggerResult' | 'agentContext'>,
): BrokeredPushPlan {
  if (bootstrap.delivery !== 'file-convention') {
    return {eligible: false, reason: 'Response delivery is not file-convention'}
  }

  const triggerContext = routing.triggerResult.context
  const [owner = '', repo = ''] = routing.agentContext.repo.split('/')
  const eventFacts: BrokeredPushEventFacts = {
    eventType: triggerContext.eventType,
    isPullRequest: routing.agentContext.issueType === 'pr',
    authorAssociation: triggerContext.author?.association ?? '',
    commentAuthor: triggerContext.author?.login ?? '',
    issueNumber: routing.agentContext.issueNumber ?? 0,
    owner,
    repo,
  }

  const earlyGate = evaluateBrokeredPushEarlyGate({facts: eventFacts, trustedHeadSha: bootstrap.trustedHeadSha})
  if (earlyGate.decision === 'ineligible') {
    return {eligible: false, reason: earlyGate.reason}
  }

  const hydratedContext = routing.agentContext.hydratedContext
  if (hydratedContext?.type !== 'pull_request') {
    return {eligible: false, reason: 'Pull request context was not hydrated'}
  }

  if (hydratedContext.isFork === true) {
    return {eligible: false, reason: 'Pull request head is a fork'}
  }

  if (hydratedContext.headBranch.trim() === '') {
    return {eligible: false, reason: 'Pull request head branch is unknown'}
  }

  return {eligible: true}
}
