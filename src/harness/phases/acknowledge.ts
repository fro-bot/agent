import type {ReactionContext} from '../../features/agent/types.js'
import type {Logger} from '../../shared/logger.js'
import type {RoutingPhaseResult} from './routing.js'
import {acknowledgeReceipt} from '../../features/agent/index.js'
import {createLogger} from '../../shared/logger.js'

export async function runAcknowledge(routing: RoutingPhaseResult, logger: Logger): Promise<ReactionContext> {
  const reactionCtx: ReactionContext = {
    repo: routing.agentContext.repo,
    commentId: routing.agentContext.commentId,
    issueNumber: routing.agentContext.issueNumber,
    issueType: routing.agentContext.issueType,
    botLogin: routing.botLogin,
  }

  const ackLogger = createLogger({phase: 'acknowledgment'})
  await acknowledgeReceipt(routing.githubClient, reactionCtx, ackLogger)
  logger.debug('Acknowledgment phase completed')

  return reactionCtx
}
