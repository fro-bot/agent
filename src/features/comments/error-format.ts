import type {ErrorInfo} from '@fro-bot/runtime'
import {createErrorInfo} from '@fro-bot/runtime'

/** Legacy comments-module compatibility surface over the canonical runtime formatters. */
export {
  createErrorInfo,
  createLLMFetchError,
  createLLMTimeoutError,
  createRateLimitError,
  formatErrorComment,
  isAgentNotFoundError,
  isLlmFetchError,
} from '@fro-bot/runtime'

/** Preserve the comments-module's legacy import/API behavior for callers while sharing the runtime error shape. */
export function createAgentError(message: string, agent?: string): ErrorInfo {
  return createErrorInfo('configuration', `Agent error: ${message}`, false, {
    details: agent == null ? undefined : `Requested agent: ${agent}`,
    suggestedAction:
      agent == null
        ? 'Verify the agent name is correct.'
        : 'Verify the agent name is correct. If you need an oMo-provided agent (e.g., sisyphus), set `enable-omo: true`.',
  })
}
