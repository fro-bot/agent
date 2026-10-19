import type {ClassificationPath} from '../types.js'
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
 * `terminalSignalFromPayload` is the one place a raw OpenCode error payload becomes a typed signal, so the Action and
 * the gateway hand the rule the same input for the same payload.
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
  readonly reason?: string | undefined
  readonly resetAt?: Date | number | undefined
}

/**
 * A terminal error payload (`session.error` or an assistant `info.error`), already narrowed to typed fields. Build
 * it with {@link terminalSignalFromPayload}; the classifier never receives a raw SDK event or payload object.
 */
export interface TerminalPayloadSignal {
  readonly source: 'terminal-payload'
  readonly name?: string | undefined
  readonly status?: number | undefined
  readonly code?: string | undefined
  readonly message?: string | undefined
  readonly isRetryable?: boolean | undefined
  /**
   * Bounded, caller-built diagnostic for the generic `unclassified` label (never raw provider text). Defaults
   * to a fixed placeholder when absent.
   */
  readonly detail?: string | undefined
  /** Active model id, attached to the generic fetch-error and retryable-API labels as a detail line. */
  readonly model?: string | undefined
}

export type ProviderFailureSignal = RetryStatusSignal | TerminalPayloadSignal

export interface ProviderFailureClassification {
  readonly kind: ProviderFailureKind
  readonly evidence: ProviderFailureEvidence
  /** True when the run should stop now. Never true for hint, generic, overflow, or abort results. */
  readonly stop: boolean
  /** The Action's error label for this failure. */
  readonly errorInfo: ErrorInfo
  /**
   * How the label was reached, for telemetry. Structured markers, including quota text (recorded as structured
   * since the Action first matched it), are `structured`; text recovered from a message, and hints, are
   * `fallback`; the generic ladder reports `name` when the payload carried a name, status or code, and
   * `unclassified` when it carried none.
   */
  readonly classificationPath: ClassificationPath
}

/** Retry `action.reason` values that mean the model can never be served, matched exactly. */
const MODEL_UNAVAILABLE_RETRY_REASONS = new Set(['model_not_found', 'model_not_supported'])

/**
 * Looser wording on a terminal payload. Labels the failure, never stops the run: a message can describe a
 * recoverable outage, so it is not evidence the failure is hopeless.
 */
const AUTH_HINT_PATTERNS = [/\bauth_unavailable\b/i, /\bno auth available\b/i] as const
const MODEL_HINT_PATTERNS = [/\bmodel_not_found\b/i, /\bmodel (?:is )?not (?:supported|found)\b/i] as const

/**
 * Upper bound on the text the looser hint patterns inspect. The stop patterns (usage-limit wording, `Model not
 * found:`) match the whole message: a provider error that echoes a long body before its usage-limit phrase must
 * still stop the run.
 */
const MAX_HINT_MESSAGE_LENGTH = 2048

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

/**
 * A hint labels a failure it cannot confirm, so it never changes retryability in either direction: the label is
 * retryable exactly when the generic ladder would call this payload retryable without the hint (an explicit
 * `isRetryable`, an HTTP 429, or a fetch/network error). Retry admission is therefore the same as if the wording
 * were absent.
 */
function labelHint(label: ErrorInfo, signal: TerminalPayloadSignal): ErrorInfo {
  const retryable = classifyGeneric(signal).errorInfo.retryable
  return retryable === label.retryable ? label : {...label, retryable}
}

function result(
  kind: ProviderFailureKind,
  evidence: ProviderFailureEvidence,
  stop: boolean,
  errorInfo: ErrorInfo,
  classificationPath: ClassificationPath,
): ProviderFailureClassification {
  return {kind, evidence, stop, errorInfo, classificationPath}
}

function classifyRetryStatus(signal: RetryStatusSignal): ProviderFailureClassification | null {
  const reason = signal.reason
  if (reason === undefined) return null

  const auth = classifyProviderAuthError({kind: 'retry-status', reason})
  if (auth !== null) return result('auth', 'structured', true, auth, 'structured')

  const quota = classifyQuotaError({kind: 'retry-status', reason, resetAt: normalizeResetAt(signal.resetAt)})
  if (quota !== null) return result('quota', 'structured', true, quota, 'structured')

  if (MODEL_UNAVAILABLE_RETRY_REASONS.has(reason)) {
    return result('model-not-found', 'structured', true, createModelUnavailableError(), 'structured')
  }

  return null
}

/** The Action's generic label ladder for a payload with no provider evidence. Waits; never stops. */
function classifyGeneric(signal: TerminalPayloadSignal): {
  readonly errorInfo: ErrorInfo
  readonly classificationPath: ClassificationPath
} {
  const detail = signal.detail ?? GENERIC_DETAIL

  if (isLlmFetchError(detail)) {
    return {errorInfo: createLLMFetchError(detail, signal.model), classificationPath: 'fallback'}
  }
  if (signal.status === 429) {
    return {errorInfo: createErrorInfo('rate_limit', detail, true), classificationPath: 'name'}
  }
  if (signal.isRetryable === true) {
    return {errorInfo: createRetryableApiError(detail, signal.model), classificationPath: 'structured'}
  }
  if (signal.isRetryable === false) {
    return {errorInfo: createAgentError(detail), classificationPath: 'structured'}
  }
  return {
    errorInfo: createAgentError(detail),
    classificationPath:
      signal.name !== undefined || signal.status !== undefined || signal.code !== undefined ? 'name' : 'unclassified',
  }
}

function classifyTerminalPayload(signal: TerminalPayloadSignal): ProviderFailureClassification {
  const {name, status, code} = signal
  const message = signal.message !== undefined && signal.message.length > 0 ? signal.message : undefined

  // Structured: exact error names, then quota status/code. Text is deliberately withheld from the quota
  // classifier here so a structured overflow or auth marker is never outranked by text.
  const auth = classifyProviderAuthError({kind: 'session-error', name})
  if (auth !== null) return result('auth', 'structured', true, auth, 'structured')

  const overflow = classifyContextOverflowError({kind: 'session-error', name})
  if (overflow !== null) return result('context-overflow', 'structured', false, overflow, 'structured')

  if (name === 'MessageAbortedError') {
    const generic = classifyGeneric(signal)
    return result('aborted', 'structured', false, generic.errorInfo, generic.classificationPath)
  }

  const structuredQuota = classifyQuotaError({kind: 'session-error', status, code})
  if (structuredQuota !== null) return result('quota', 'structured', true, structuredQuota, 'structured')

  if (message !== undefined) {
    // Text: the established patterns, matched against the whole message. Usage-limit wording first, then
    // `Model not found:`.
    const textQuota = classifyQuotaError({kind: 'session-error', message})
    if (textQuota !== null) return result('quota', 'text', true, textQuota, 'structured')

    const textModel = classifyModelNotFoundError({kind: 'session-error', message})
    if (textModel !== null) return result('model-not-found', 'text', true, textModel, 'fallback')

    // Hint: looser wording labels the failure but never stops the run.
    const hintText = message.slice(0, MAX_HINT_MESSAGE_LENGTH)
    if (matchesAny(AUTH_HINT_PATTERNS, hintText)) {
      return result('auth', 'hint', false, labelHint(createProviderAuthError(), signal), 'fallback')
    }
    if (matchesAny(MODEL_HINT_PATTERNS, hintText)) {
      return result('model-not-found', 'hint', false, labelHint(createModelUnavailableError(), signal), 'fallback')
    }
  }

  const generic = classifyGeneric(signal)
  return result('unclassified', 'none', false, generic.errorInfo, generic.classificationPath)
}

function ownValue(value: unknown, property: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return Object.getOwnPropertyDescriptor(value, property)?.value
}

/** First candidate of the wanted type: a value of the wrong type never hides a valid fallback. */
function firstString(candidates: readonly unknown[]): string | undefined {
  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
}

function firstNumber(candidates: readonly unknown[]): number | undefined {
  return candidates.find((candidate): candidate is number => typeof candidate === 'number')
}

function firstBoolean(candidates: readonly unknown[]): boolean | undefined {
  return candidates.find((candidate): candidate is boolean => typeof candidate === 'boolean')
}

/**
 * Build the typed signal for a raw OpenCode error payload (`session.error` `error`, assistant `info.error`), or for
 * the plain string some `session.error` events carry. This is the single extractor both surfaces use.
 *
 * Precedence, per field, first value of the right type wins:
 * - `name`: top level, then `data.name`. OpenCode's `NamedError.toObject()` is `{name, data}`, so the name lives at
 *   the top level; `data.name` is a tolerated fallback for wrapped payloads.
 * - `message`, `status` (`status` then `statusCode`), `code`, `isRetryable`: `data.*` first, then top level. In the
 *   pinned OpenCode source (v1.19.0 `packages/core/src/v1/session.ts`) every provider-supplied field is declared on
 *   the error's `data` struct (`APIError`: `message`, `statusCode`, `isRetryable`, `responseBody`; `ProviderAuthError`
 *   and `UnknownError`: `message`), so the top level only carries these on a hand-built or wrapped payload.
 * - A string payload is the message.
 *
 * A non-string `message`, non-number `status` and so on is skipped rather than shadowing the fallback; an empty
 * string is treated as absent.
 */
export function terminalSignalFromPayload(
  payload: unknown,
  options: {readonly detail?: string | undefined; readonly model?: string | undefined} = {},
): TerminalPayloadSignal {
  const data = ownValue(payload, 'data')
  const message =
    typeof payload === 'string' ? payload : firstString([ownValue(data, 'message'), ownValue(payload, 'message')])
  return {
    source: 'terminal-payload',
    name: firstString([ownValue(payload, 'name'), ownValue(data, 'name')]),
    status: firstNumber([
      ownValue(data, 'status'),
      ownValue(data, 'statusCode'),
      ownValue(payload, 'status'),
      ownValue(payload, 'statusCode'),
    ]),
    code: firstString([ownValue(data, 'code'), ownValue(payload, 'code')]),
    message,
    isRetryable: firstBoolean([ownValue(data, 'isRetryable'), ownValue(payload, 'isRetryable')]),
    detail: options.detail,
    model: options.model,
  }
}

/**
 * Build the typed signal for a `session.status` payload, or `null` when the status is not a `retry`. Only the
 * structured `action.reason` and the retry-after `next` are read: the retry `message` is the text of a retried
 * (often 5xx) failure and is not evidence the retry is hopeless.
 */
export function retrySignalFromStatus(status: unknown): RetryStatusSignal | null {
  if (ownValue(status, 'type') !== 'retry') return null
  return {
    source: 'retry-status',
    reason: firstString([ownValue(ownValue(status, 'action'), 'reason')]),
    resetAt: firstNumber([ownValue(status, 'next')]),
  }
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
