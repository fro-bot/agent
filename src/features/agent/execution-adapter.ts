import type {Logger} from '../../shared/logger.js'
import type {OpenCodeServerHandle} from './server.js'
import type {AgentResult, ExecutionConfig, PromptOptions} from './types.js'
import {executeOpenCode as executeRuntimeOpenCode} from '@fro-bot/runtime'
import {runPromptAttempt} from './retry.js'

export async function executeOpenCode(
  promptOptions: PromptOptions,
  logger: Logger,
  config?: ExecutionConfig,
  serverHandle?: OpenCodeServerHandle,
): Promise<AgentResult> {
  return executeRuntimeOpenCode(promptOptions, logger, config, serverHandle, runPromptAttempt) as Promise<AgentResult>
}
