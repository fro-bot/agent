import type {AgentContext} from '../../features/agent/types.js'
import type {TriggerResultProcess} from '../../features/triggers/types.js'
import type {Octokit} from '../../services/github/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import * as core from '@actions/core'
import {collectAgentContext} from '../../features/agent/index.js'
import {routeEvent} from '../../features/triggers/index.js'
import {getRepositoryPermission} from '../../services/github/api.js'
import {createClient, getBotLogin, parseGitHubContext} from '../../services/github/index.js'
import {createLogger} from '../../shared/logger.js'
import {setActionOutputs} from '../config/outputs.js'
import {STATE_KEYS} from '../config/state-keys.js'

export interface RoutingPhaseResult {
  readonly githubClient: Octokit
  readonly triggerResult: TriggerResultProcess
  readonly agentContext: AgentContext
  readonly botLogin: string | null
}

export async function runRouting(
  bootstrap: BootstrapPhaseResult,
  startTime: number,
): Promise<RoutingPhaseResult | null> {
  const contextLogger = createLogger({phase: 'context'})
  const githubContext = parseGitHubContext(contextLogger)
  const githubClient = createClient({token: bootstrap.inputs.githubToken, logger: contextLogger})
  const botLogin = await getBotLogin(githubClient, contextLogger)

  let senderAssociation: string | null = null
  if (
    githubContext.eventType === 'pull_request' &&
    githubContext.event.type === 'pull_request' &&
    githubContext.event.action === 'review_requested'
  ) {
    const {owner, repo} = githubContext.repo
    senderAssociation = await getRepositoryPermission(
      githubClient,
      owner,
      repo,
      githubContext.event.sender.login,
      contextLogger,
    )
  }

  const triggerLogger = createLogger({phase: 'trigger'})
  const triggerResult = routeEvent(githubContext, triggerLogger, {
    botLogin,
    requireMention: true,
    promptInput: bootstrap.inputs.prompt,
    senderAssociation,
  })

  if (!triggerResult.shouldProcess) {
    triggerLogger.info('Skipping event', {
      reason: triggerResult.skipReason,
      message: triggerResult.skipMessage,
    })
    setActionOutputs({
      sessionId: null,
      cacheStatus: 'miss',
      duration: Date.now() - startTime,
    })
    return null
  }

  triggerLogger.info('Event routed for processing', {
    eventType: triggerResult.context.eventType,
    hasMention: triggerResult.context.hasMention,
    command: triggerResult.context.command?.action ?? null,
  })

  core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'true')

  const agentContext = await collectAgentContext({
    logger: contextLogger,
    octokit: githubClient,
    triggerContext: triggerResult.context,
    botLogin,
  })

  return {
    githubClient,
    triggerResult,
    agentContext,
    botLogin,
  }
}
