import type {ActionOpenCodeV2Client, OwnershipLedger, V2CallError, V2PromptFile} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {AttemptOutcome, AttemptResult} from './prompt-sender.js'
import type {RunPromptAttemptV2Options} from './retry-v2.js'
import type {ExecutionDeadline} from './retry.js'
import type {FormAskedResponderV2, PermissionAskedResponderV2} from './streaming-v2.js'
import {createAgentError, createLLMFetchError} from '@fro-bot/runtime'
import {runPromptAttemptV2} from './retry-v2.js'
import {createDeadlineExceededError, shouldRetryFromOutcome} from './retry.js'

/**
 * Prompt submission on OpenCode V2: the sibling of `prompt-sender.ts`.
 *
 * The V2 prompt carries only text and files (`PromptInput`): the model and agent are properties of the session, set
 * where the session is created or continued (`execution-v2.ts`), not per prompt as on V1. The continuation prompt text
 * is shared with V1 (`buildContinuationPrompt`).
 *
 * A failed call is classified by its kind, never by response text: a transport failure, a 5xx, a 408 or a 429 is the
 * retryable `llm_fetch_error` that the retry loop resends under `MAX_LLM_RETRIES`; an auth failure or another 4xx is
 * not retryable. The error message names the kind and status only, since a response body can echo prompt text.
 */

function describeCallError(error: V2CallError): string {
  switch (error.kind) {
    case 'auth':
    case 'http':
      return `${error.kind} ${error.status}`
    case 'network':
      return 'network failure'
    case 'parse':
    case 'aborted':
      return error.kind
  }
}

export function isRetryableCallError(error: V2CallError): boolean {
  switch (error.kind) {
    case 'network':
    case 'parse':
      return true
    case 'http':
      return error.status >= 500 || error.status === 408 || error.status === 429
    case 'auth':
    case 'aborted':
      return false
  }
}

export function createSubmissionFailureV2(what: string, error: V2CallError): AttemptResult {
  const message = `${what} (${describeCallError(error)})`
  const llmError = isRetryableCallError(error) ? createLLMFetchError(message) : null
  const outcome: AttemptOutcome = 'submit_failed'
  return {
    success: false,
    error: message,
    llmError,
    outcome,
    shouldRetry: shouldRetryFromOutcome(outcome),
    settlement: {kind: 'failure-observed'},
    eventStreamResult: {
      tokens: null,
      model: null,
      cost: null,
      prsCreated: [],
      commitsCreated: [],
      commentsPosted: 0,
      llmError: llmError ?? createAgentError(message),
      classificationPath: llmError === null ? 'unclassified' : 'fallback',
    },
  }
}

export interface SendPromptV2Options {
  readonly client: ActionOpenCodeV2Client
  readonly sessionId: string
  readonly promptText: string
  readonly files?: readonly V2PromptFile[]
  readonly directory: string
  readonly logger: Logger
  readonly deadline?: ExecutionDeadline
  readonly onPermissionAsked?: PermissionAskedResponderV2
  readonly onFormAsked?: FormAskedResponderV2
  readonly onFatal?: (cause: 'session_moved') => void
  readonly ownershipLedger?: OwnershipLedger
  readonly poll?: RunPromptAttemptV2Options['poll']
}

export async function sendPromptToSessionV2(options: SendPromptV2Options): Promise<AttemptResult> {
  const {client, sessionId, promptText, files, directory, logger, deadline} = options
  const attemptAbortController = new AbortController()
  try {
    const subscriptionSignal =
      deadline === undefined
        ? attemptAbortController.signal
        : AbortSignal.any([attemptAbortController.signal, deadline.signal])
    const subscribe = async () => client.subscribeEvents({directory, signal: subscriptionSignal})
    const subscribed = deadline === undefined ? await subscribe() : await deadline.run(subscribe, 'event subscription')
    if (!subscribed.success) {
      if (subscribed.error.kind === 'aborted' && deadline?.isExpired() === true) {
        throw createDeadlineExceededError('event subscription')
      }
      return createSubmissionFailureV2(
        'OpenCode V2 event subscription failed; the prompt was not sent',
        subscribed.error,
      )
    }

    const startPrompt = async (): Promise<AttemptResult | null> => {
      const prompted = await client.prompt({
        sessionId,
        text: promptText,
        directory,
        ...(files === undefined || files.length === 0 ? {} : {files}),
        ...(deadline === undefined ? {} : {signal: deadline.signal}),
      })
      if (prompted.success) return null
      if (prompted.error.kind === 'aborted' && deadline?.isExpired() === true) {
        throw createDeadlineExceededError('prompt submission')
      }
      return createSubmissionFailureV2('OpenCode V2 prompt submission failed', prompted.error)
    }

    return await runPromptAttemptV2({
      client,
      sessionId,
      eventStream: subscribed.data,
      startPrompt,
      logger,
      attemptAbortController,
      ...(deadline === undefined ? {} : {deadline}),
      ...(options.onPermissionAsked === undefined ? {} : {onPermissionAsked: options.onPermissionAsked}),
      ...(options.onFormAsked === undefined ? {} : {onFormAsked: options.onFormAsked}),
      ...(options.onFatal === undefined ? {} : {onFatal: options.onFatal}),
      ...(options.ownershipLedger === undefined ? {} : {ownershipLedger: options.ownershipLedger}),
      ...(options.poll === undefined ? {} : {poll: options.poll}),
    })
  } finally {
    attemptAbortController.abort()
  }
}
