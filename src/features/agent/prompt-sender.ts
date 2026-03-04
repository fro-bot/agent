import type {FilePartInput, TextPartInput, type createOpencode} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
import type {ErrorInfo} from '../comments/types.js'
import type {EventStreamResult} from './streaming.js'
import type {ExecutionConfig} from './types.js'
import {DEFAULT_AGENT, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS} from '../../shared/constants.js'
import {createLLMFetchError, isLlmFetchError} from '../comments/error-format.js'
import {runPromptAttempt} from './retry.js'

export const CONTINUATION_PROMPT = `The previous request was interrupted by a network error (fetch failed).
Please continue where you left off. If you were in the middle of a task, resume it.
If you had completed the task, confirm the completion.`

const resolvePromptModel = (config: ExecutionConfig | undefined): {providerID: string; modelID: string} | undefined => {
  if (config?.model != null) return {providerID: config.model.providerID, modelID: config.model.modelID}
  const hasConfiguredProviders =
    config != null && Object.values(config.omoProviders).some(provider => provider !== 'no')
  if (!hasConfiguredProviders) return {providerID: DEFAULT_MODEL.providerID, modelID: DEFAULT_MODEL.modelID}
  return undefined
}

export interface AttemptResult {
  success: boolean
  error: string | null
  llmError: ErrorInfo | null
  shouldRetry: boolean
  eventStreamResult: EventStreamResult
}

export async function sendPromptToSession(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  promptText: string,
  fileParts: readonly FilePartInput[] | undefined,
  directory: string,
  config: ExecutionConfig | undefined,
  logger: Logger,
): Promise<AttemptResult> {
  const textPart: TextPartInput = {type: 'text', text: promptText}
  const parts: (TextPartInput | FilePartInput)[] = [textPart, ...(fileParts ?? [])]
  const body: {
    agent?: string
    model?: {providerID: string; modelID: string}
    parts: (TextPartInput | FilePartInput)[]
  } = {parts}
  const model = resolvePromptModel(config)
  if (model != null) body.model = model
  const agentName = config?.agent ?? DEFAULT_AGENT
  if (agentName !== DEFAULT_AGENT) body.agent = agentName

  const response = await client.session.promptAsync({path: {id: sessionId}, body, query: {directory}})
  if (response.error != null) {
    const promptError = String(response.error)
    const promptLlmError = isLlmFetchError(response.error) ? createLLMFetchError(promptError) : null
    return {
      success: false,
      error: promptError,
      llmError: promptLlmError,
      shouldRetry: promptLlmError != null,
      eventStreamResult: {
        tokens: null,
        model: null,
        cost: null,
        prsCreated: [],
        commitsCreated: [],
        commentsPosted: 0,
        llmError: promptLlmError,
      },
    }
  }

  return runPromptAttempt(client, sessionId, directory, config?.timeoutMs ?? DEFAULT_TIMEOUT_MS, logger)
}
