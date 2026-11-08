/**
 * The PR head the agent reviewed, captured before execution. A review is always pinned to it, never to a head fetched
 * at delivery, so a mid-run push cannot attribute a review of A to B (#2124).
 *
 * - `pull_request`: the event's `head.sha`. A default checkout is the merge ref, whose PR-side parent is this head.
 * - `issue_comment` on a PR: the head from context hydration, fetched with the diff shown to the agent.
 *
 * Returns `null` when none was captured; callers fail closed.
 */

import type {AgentContext, TriggerContext} from '@fro-bot/runtime'

export function resolveReviewedHeadSha(
  agentContext: Pick<AgentContext, 'hydratedContext'>,
  triggerContext: Pick<TriggerContext, 'eventType' | 'target'>,
): string | null {
  const candidate =
    triggerContext.eventType === 'pull_request'
      ? triggerContext.target?.kind === 'pr'
        ? triggerContext.target.headSha
        : undefined
      : agentContext.hydratedContext?.type === 'pull_request'
        ? agentContext.hydratedContext.headSha
        : undefined

  return candidate != null && candidate.length > 0 ? candidate : null
}
