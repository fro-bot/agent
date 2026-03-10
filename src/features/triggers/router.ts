import type {GitHubContext} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import type {TriggerConfig, TriggerResult} from './types.js'
import {buildTriggerContext} from './context-builders.js'
import {extractCommand, hasBotMention} from './mention-command.js'
import {checkSkipConditions} from './skip-conditions.js'
import {DEFAULT_TRIGGER_CONFIG} from './types.js'

export {checkSkipConditions, extractCommand, hasBotMention}

export function routeEvent(
  githubContext: GitHubContext,
  logger: Logger,
  config: Partial<TriggerConfig> = {},
): TriggerResult {
  const fullConfig: TriggerConfig = {...DEFAULT_TRIGGER_CONFIG, ...config}
  let context = buildTriggerContext(githubContext, fullConfig.botLogin, fullConfig.promptInput)

  if (fullConfig.senderAssociation != null && context.action === 'review_requested' && context.author != null) {
    context = {...context, author: {...context.author, association: fullConfig.senderAssociation}}
  }

  logger.debug('Routing event', {
    eventName: githubContext.eventName,
    eventType: githubContext.eventType,
    hasMention: context.hasMention,
  })

  const skipResult = checkSkipConditions(context, fullConfig, logger)
  if (skipResult.shouldSkip) {
    return {
      shouldProcess: false,
      skipReason: skipResult.reason,
      skipMessage: skipResult.message,
      context,
    }
  }

  return {
    shouldProcess: true,
    context,
  }
}
