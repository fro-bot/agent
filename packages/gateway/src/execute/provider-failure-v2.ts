/**
 * Provider-failure labelling for the OpenCode V2 event loop: the sibling of `provider-failure.ts`.
 *
 * V2 reports a terminal failure as `session.execution.failed` with a structured error `{type, message, status,
 * retryAfterMs}` (`packages/schema/src/session-error.ts`). The shared classifier (`classifyProviderFailure`) takes the
 * same typed signal the V1 loop builds, so the V2 error is mapped onto it field by field. Classification reads
 * upstream fields but NEVER returns them: every result is a closed, fixed `reason`. The error `type` and `message` are
 * provider- or plugin-controlled, so the logged error name is always `unknown`, never the upstream string.
 *
 * A retry (`session.retry.scheduled`) is never a failure here. V1 stopped on a retry only when the structured
 * `action.reason` said the model could never be served. The V2 retry event carries the retried error and no such
 * action, and the message of a retried (often 5xx) failure is not evidence the retry is hopeless, so the loop keeps
 * waiting and lets the terminal event decide.
 */

import type {ProviderFailureKind, V2ErrorInfo} from '@fro-bot/runtime'
import type {ProviderFailure, ProviderFailureReason} from './provider-failure.js'

import {classifyProviderFailure, terminalSignalFromPayload} from '@fro-bot/runtime'

function toReason(kind: ProviderFailureKind): ProviderFailureReason {
  switch (kind) {
    case 'auth':
      return 'provider auth unavailable'
    case 'quota':
      return 'provider quota exceeded'
    case 'model-not-found':
      return 'model not available'
    case 'unclassified':
    case 'context-overflow':
    case 'aborted':
      return 'session error'
  }
}

/** Label a V2 execution failure. Total: an unrecognized error still yields a fixed reason. */
export function failureFromV2Error(error: V2ErrorInfo): ProviderFailure {
  const classification = classifyProviderFailure(
    terminalSignalFromPayload({
      name: error.type,
      message: error.message,
      ...(error.status === null ? {} : {status: error.status}),
    }),
  )
  return {reason: toReason(classification.kind), errorName: 'unknown'}
}
