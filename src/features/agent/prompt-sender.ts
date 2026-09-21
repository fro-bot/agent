import type {OwnershipLedger} from '@fro-bot/runtime'
import type {createOpencode, Event, FilePartInput, TextPartInput} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
import type {AttemptSettlement} from './attempt-outcome.js'
import type {EventStreamResult, PermissionAskedResponder} from './streaming.js'
import type {ErrorInfo, ExecutionConfig} from './types.js'
import {createLLMFetchError, isLlmFetchError} from '@fro-bot/runtime'
import {DEFAULT_MODEL, DEFAULT_TIMEOUT_MS} from '../../shared/constants.js'
import {runPromptAttempt, shouldRetryFromOutcome, type ExecutionDeadline, type PromptStartResult} from './retry.js'

export type AttemptOutcome =
  'submit_failed' | 'turn_failed_retryable' | 'turn_failed_terminal' | 'timeout' | 'completed'

export function buildContinuationPrompt(error: ErrorInfo, credentialProvisioned: boolean): string {
  const sideEffectGuidance =
    credentialProvisioned === true
      ? 'Before taking any action, verify what has already landed, including external changes and response artifacts, and do not repeat completed side effects.'
      : 'Inspect the current session state before continuing and do not repeat completed work.'

  return [
    `The previous turn was accepted but ended with the observed failure type \`${error.type}\`.`,
    'Continue the remaining objective from the current session; do not resend or replay the original request.',
    sideEffectGuidance,
  ].join('\n')
}

const resolvePromptModel = (config: ExecutionConfig | undefined): {providerID: string; modelID: string} | undefined => {
  if (config?.model != null) return {providerID: config.model.providerID, modelID: config.model.modelID}
  const hasConfiguredProviders =
    config != null && Object.values(config.omoProviders).some(provider => provider !== 'no')
  if (!hasConfiguredProviders) return {providerID: DEFAULT_MODEL.providerID, modelID: DEFAULT_MODEL.modelID}
  return undefined
}

export interface AttemptResult {
  readonly success: boolean
  readonly error: string | null
  readonly llmError: ErrorInfo | null
  readonly outcome: AttemptOutcome
  /** Compatibility view derived from outcome; outcome is authoritative. */
  readonly shouldRetry: boolean
  readonly eventStreamResult: EventStreamResult
  /**
   * Why observation of this attempt stopped, as decided at the one point it was actually decided
   * -- never re-derived later from a clock read. See attempt-outcome.ts's module doc for the
   * governing invariant: selecting an error never proves quiescence, and observing quiescence
   * never erases an error. Every `AttemptResult` construction site states the settlement it
   * actually observed; callers (execution.ts) read this instead of inferring a cause from deadline
   * or ledger state observed after the fact.
   */
  readonly settlement: AttemptSettlement
}

export async function sendPromptToSession(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  promptText: string,
  fileParts: readonly FilePartInput[] | undefined,
  directory: string,
  config: ExecutionConfig | undefined,
  logger: Logger,
  serverUrl?: string | null,
  deadline?: ExecutionDeadline,
  onPermissionAsked?: PermissionAskedResponder,
  ownershipLedger?: OwnershipLedger,
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
  const agentName = config?.agent ?? null
  if (agentName != null) body.agent = agentName

  const attemptAbortController = new AbortController()
  try {
    const subscriptionSignal =
      deadline == null
        ? attemptAbortController.signal
        : AbortSignal.any([attemptAbortController.signal, deadline.signal])
    const subscribe = async () => client.event.subscribe({signal: subscriptionSignal})
    const events = deadline == null ? await subscribe() : await deadline.run(subscribe, 'event subscription')
    const createSubmissionFailure = (promptError: string, error: unknown): AttemptResult => {
      const promptLlmError = isLlmFetchError(error) ? createLLMFetchError(promptError) : null
      const outcome: AttemptOutcome = 'submit_failed'
      return {
        success: false,
        error: promptError,
        llmError: promptLlmError,
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
          llmError: promptLlmError,
          classificationPath: promptLlmError == null ? 'unclassified' : 'fallback',
        },
      }
    }
    const startPrompt = async (): Promise<PromptStartResult> => {
      const response = await client.session.promptAsync({
        path: {id: sessionId},
        body,
        query: {directory},
        signal: deadline?.signal,
      })
      if (response.error == null) return null
      return createSubmissionFailure(String(response.error), response.error)
    }

    const runAttempt = async () =>
      runPromptAttempt(
        client,
        sessionId,
        directory,
        config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        logger,
        events.stream as AsyncIterable<Event>,
        serverUrl,
        startPrompt,
        deadline,
        attemptAbortController,
        onPermissionAsked,
        ownershipLedger,
      )
    return await runAttempt()
  } finally {
    attemptAbortController.abort()
  }
}
