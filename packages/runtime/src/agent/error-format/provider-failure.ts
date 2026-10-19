import type {ErrorInfo} from './types.js'

import {
  classifyContextOverflowError,
  classifyModelNotFoundError,
  classifyProviderAuthError,
  classifyQuotaError,
  createAgentError,
  createErrorInfo,
  createLLMFetchError,
  createProviderAuthError,
  createRetryableApiError,
  isLlmFetchError,
} from './format.js'

/**
 * Shared provider-failure classification for the Action and the gateway.
 *
 * One function decides two things from a normalized OpenCode signal: what kind of provider failure it is, and
 * whether the run should stop now. Both surfaces act on `stop`; neither keeps its own copy of the rule.
 *
 * Rule table (evidence precedence is structured, then text, then hint, then the generic label ladder):
 *
 * | Signal                                                     | Kind                   | Evidence   | Stop             |
 * | ---------------------------------------------------------- | ---------------------- | ---------- | ---------------- |
 * | retry `auth_unavailable`                                   | auth                   | structured | yes              |
 * | retry `account_rate_limit`                                 | quota                  | structured | yes              |
 * | retry `model_not_found` / `model_not_supported`            | model-not-found        | structured | yes              |
 * | retry, any other reason                                    | none (returns `null`)  | none       | no, keep waiting |
 * | terminal `ProviderAuthError`                               | auth                   | structured | yes              |
 * | terminal 402 / `insufficient_quota` / `usage_not_included` | quota                  | structured | yes              |
 * | terminal usage-limit text                                  | quota                  | text       | yes              |
 * | terminal `Model not found:` text                           | model-not-found        | text       | yes              |
 * | terminal auth wording, "model is not supported"            | auth / model-not-found | hint       | no               |
 * | `ContextOverflowError`                                     | context-overflow       | structured | surface policy   |
 * | `MessageAbortedError`                                      | aborted                | structured | surface policy   |
 * | anything else                                              | unclassified           | none       | no               |
 *
 * `context-overflow` and `aborted` report `stop: false`: the response is surface policy (the Action restarts in a
 * fresh session, the gateway waits for compaction and checks its own cancel signal), not a shared decision.
 *
 * Security: classification reads upstream fields but never echoes them. Every `errorInfo` is fixed guidance, except
 * the generic `unclassified` ladder, which carries the caller-supplied bounded `detail` diagnostic exactly as the
 * Action's ladder did before it moved here. Message text is never auth evidence for a structured or stop decision.
 */

export type ProviderFailureKind = 'auth' | 'quota' | 'model-not-found' | 'context-overflow' | 'aborted' | 'unclassified'

/** Which tier of evidence picked the kind. Only `structured` and `text` can stop a run. */
export type ProviderFailureEvidence = 'structured' | 'text' | 'hint' | 'none'

/** A `session.status` retry. `resetAt` is a `Date` or epoch-millisecond `next`; invalid values are dropped. */
export interface RetryStatusSignal {
  readonly source: 'retry-status'
  readonly reason?: unknown
  readonly resetAt?: Date | number
}

/**
 * A terminal error payload (`session.error` or an assistant `info.error`). Callers extract the fields; the
 * classifier never receives a raw SDK event or payload object.
 */
export interface TerminalPayloadSignal {
  readonly source: 'terminal-payload'
  readonly name?: unknown
  readonly status?: unknown
  readonly code?: unknown
  readonly message?: unknown
  readonly isRetryable?: unknown
  /**
   * Bounded, caller-built diagnostic for the generic `unclassified` label (never raw provider text). Defaults
   * to a fixed placeholder when absent.
   */
  readonly detail?: string
  /** Active model id, attached to the generic fetch-error and retryable-API labels as a detail line. */
  readonly model?: string
}

export type ProviderFailureSignal = RetryStatusSignal | TerminalPayloadSignal

export interface ProviderFailureClassification {
  readonly kind: ProviderFailureKind
  readonly evidence: ProviderFailureEvidence
  /** True when the run should stop now. Never true for hint, generic, overflow, or abort results. */
  readonly stop: boolean
  /** The Action's error label for this failure. */
  readonly errorInfo: ErrorInfo
}

/** Retry `action.reason` values that mean the model can never be served, matched exactly. */
const MODEL_UNAVAILABLE_RETRY_REASONS = new Set(['model_not_found', 'model_not_supported'])

/**
 * Looser wording on a terminal payload. Labels the failure, never stops the run: a message can describe a
 * recoverable outage, so it is not evidence the failure is hopeless.
 */
const AUTH_HINT_PATTERNS = [/\bauth_unavailable\b/i, /\bno auth available\b/i] as const
const MODEL_HINT_PATTERNS = [/\bmodel_not_found\b/i, /\bmodel (?:is )?not (?:supported|found)\b/i] as const

/** Upper bound on text inspected, so a hostile payload cannot make matching expensive. */
const MAX_INSPECTED_MESSAGE_LENGTH = 2048

const GENERIC_DETAIL = 'Unknown session error'

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some(pattern => pattern.test(text))
}

function normalizeResetAt(value: Date | number | undefined): Date | undefined {
  if (value === undefined) return undefined
  const candidate = typeof value === 'number' ? (Number.isFinite(value) ? new Date(value) : undefined) : value
  if (candidate === undefined || Number.isNaN(candidate.getTime())) return undefined
  return candidate
}

/** Fixed `model_not_found` label for a model failure that carries no extractable model id. */
function createModelUnavailableError(): ErrorInfo {
  return createErrorInfo('model_not_found', 'The configured model is not available from the provider.', false, {
    suggestedAction: 'Check that the configured model id is correct and supported by the provider, or choose another.',
  })
}

function result(
  kind: ProviderFailureKind,
  evidence: ProviderFailureEvidence,
  stop: boolean,
  errorInfo: ErrorInfo,
): ProviderFailureClassification {
  return {kind, evidence, stop, errorInfo}
}

function classifyRetryStatus(signal: RetryStatusSignal): ProviderFailureClassification | null {
  const reason = signal.reason
  if (typeof reason !== 'string') return null

  const auth = classifyProviderAuthError({kind: 'retry-status', reason})
  if (auth !== null) return result('auth', 'structured', true, auth)

  const quota = classifyQuotaError({kind: 'retry-status', reason, resetAt: normalizeResetAt(signal.resetAt)})
  if (quota !== null) return result('quota', 'structured', true, quota)

  if (MODEL_UNAVAILABLE_RETRY_REASONS.has(reason)) {
    return result('model-not-found', 'structured', true, createModelUnavailableError())
  }

  return null
}

/** The Action's generic label ladder for a payload with no provider evidence. Waits; never stops. */
function classifyGeneric(signal: TerminalPayloadSignal): ErrorInfo {
  const detail = signal.detail ?? GENERIC_DETAIL

  if (isLlmFetchError(detail)) return createLLMFetchError(detail, signal.model)
  if (signal.status === 429) return createErrorInfo('rate_limit', detail, true)
  if (signal.isRetryable === true) return createRetryableApiError(detail, signal.model)
  return createAgentError(detail)
}

function classifyTerminalPayload(signal: TerminalPayloadSignal): ProviderFailureClassification {
  const name = signal.name
  const status = typeof signal.status === 'number' ? signal.status : undefined
  const code = typeof signal.code === 'string' ? signal.code : undefined
  const message =
    typeof signal.message === 'string' && signal.message.length > 0
      ? signal.message.slice(0, MAX_INSPECTED_MESSAGE_LENGTH)
      : undefined

  // Structured: exact error names, then quota status/code. Text is deliberately withheld from the quota
  // classifier here so a structured overflow or auth marker is never outranked by text.
  const auth = classifyProviderAuthError({kind: 'session-error', name})
  if (auth !== null) return result('auth', 'structured', true, auth)

  const overflow = classifyContextOverflowError({kind: 'session-error', name})
  if (overflow !== null) return result('context-overflow', 'structured', false, overflow)

  if (name === 'MessageAbortedError') return result('aborted', 'structured', false, classifyGeneric(signal))

  const structuredQuota = classifyQuotaError({kind: 'session-error', status, code})
  if (structuredQuota !== null) return result('quota', 'structured', true, structuredQuota)

  if (message !== undefined) {
    // Text: the established patterns. Usage-limit wording first, then `Model not found:`.
    const textQuota = classifyQuotaError({kind: 'session-error', message})
    if (textQuota !== null) return result('quota', 'text', true, textQuota)

    const textModel = classifyModelNotFoundError({kind: 'session-error', message})
    if (textModel !== null) return result('model-not-found', 'text', true, textModel)

    // Hint: looser wording labels the failure but never stops the run.
    if (matchesAny(AUTH_HINT_PATTERNS, message)) return result('auth', 'hint', false, createProviderAuthError())
    if (matchesAny(MODEL_HINT_PATTERNS, message)) {
      return result('model-not-found', 'hint', false, createModelUnavailableError())
    }
  }

  return result('unclassified', 'none', false, classifyGeneric(signal))
}

/**
 * Classify a provider failure signal.
 *
 * A retry status returns `null` unless its structured reason can never recover; the caller keeps waiting. A
 * terminal payload always returns a classification, `unclassified` when there is no evidence.
 */
export function classifyProviderFailure(signal: RetryStatusSignal): ProviderFailureClassification | null
export function classifyProviderFailure(signal: TerminalPayloadSignal): ProviderFailureClassification
export function classifyProviderFailure(signal: ProviderFailureSignal): ProviderFailureClassification | null
export function classifyProviderFailure(signal: ProviderFailureSignal): ProviderFailureClassification | null {
  return signal.source === 'retry-status' ? classifyRetryStatus(signal) : classifyTerminalPayload(signal)
}
