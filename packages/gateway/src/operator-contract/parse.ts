/**
 * Runtime validators for operator HTTP response types.
 *
 * Each validator is a hand-rolled type-guard + parse function that returns
 * Result<T, Error>. The pattern mirrors parseRunState in
 * packages/runtime/src/coordination/run-state.ts.
 *
 * Design constraints:
 * - Effect Schema is never used here — exported surface is plain TS + Result only.
 * - NO-ORACLE: error messages are FIXED reason strings. They never echo, interpolate,
 *   or stringify any part of the input. Even a garbled fragment is forbidden.
 * - Extra-field policy: IGNORE extra fields (permissive structural subtyping).
 *   The guard checks only the required fields; unknown extra fields are silently
 *   ignored. The parsed value is typed as the interface, so extra fields are not
 *   accessible via the type.
 */

import type {Result} from '@fro-bot/runtime'
import type {
  OperatorCancelResponse,
  OperatorCsrfToken,
  OperatorError,
  OperatorOk,
  OperatorPushSubscribeRequest,
  OperatorPushVapidKeyResponse,
  OperatorSessionInfo,
} from './responses.js'

import {err, ok} from '@fro-bot/runtime'

// ---------------------------------------------------------------------------
// OperatorSessionInfo
// ---------------------------------------------------------------------------

function hasValidOperatorSessionInfoShape(value: unknown): value is OperatorSessionInfo {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.operatorId === 'number' &&
    Number.isInteger(candidate.operatorId) &&
    typeof candidate.login === 'string' &&
    typeof candidate.expiresAt === 'number' &&
    Number.isFinite(candidate.expiresAt)
  )
}

/**
 * Parse an unknown value as OperatorSessionInfo.
 *
 * Returns ok(value) when the input has the required shape.
 * Returns err(Error) with a FIXED reason string when validation fails —
 * the error message never echoes any part of the input.
 */
export function parseOperatorSessionInfo(input: unknown): Result<OperatorSessionInfo, Error> {
  if (hasValidOperatorSessionInfoShape(input) === false) {
    return err(new Error('invalid operator session info shape'))
  }

  return ok(input)
}

// ---------------------------------------------------------------------------
// OperatorCsrfToken
// ---------------------------------------------------------------------------

function hasValidOperatorCsrfTokenShape(value: unknown): value is OperatorCsrfToken {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return typeof candidate.csrfToken === 'string'
}

/**
 * Parse an unknown value as OperatorCsrfToken.
 *
 * Returns ok(value) when the input has the required shape.
 * Returns err(Error) with a FIXED reason string when validation fails —
 * the error message never echoes any part of the input.
 */
export function parseOperatorCsrfToken(input: unknown): Result<OperatorCsrfToken, Error> {
  if (hasValidOperatorCsrfTokenShape(input) === false) {
    return err(new Error('invalid operator csrf token shape'))
  }

  return ok(input)
}

// ---------------------------------------------------------------------------
// OperatorOk
// ---------------------------------------------------------------------------

function hasValidOperatorOkShape(value: unknown): value is OperatorOk {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return candidate.ok === true
}

/**
 * Parse an unknown value as OperatorOk.
 *
 * Returns ok(value) when the input has the required shape ({ ok: true }).
 * Returns err(Error) with a FIXED reason string when validation fails —
 * the error message never echoes any part of the input.
 */
export function parseOperatorOk(input: unknown): Result<OperatorOk, Error> {
  if (hasValidOperatorOkShape(input) === false) {
    return err(new Error('invalid operator ok shape'))
  }

  return ok(input)
}

// ---------------------------------------------------------------------------
// OperatorError
// ---------------------------------------------------------------------------

function hasValidOperatorErrorShape(value: unknown): value is OperatorError {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return typeof candidate.error === 'string'
}

/**
 * Parse an unknown value as OperatorError.
 *
 * Returns ok(value) when the input has the required shape.
 * Returns err(Error) with a FIXED reason string when validation fails —
 * the error message never echoes any part of the input.
 */
export function parseOperatorError(input: unknown): Result<OperatorError, Error> {
  if (hasValidOperatorErrorShape(input) === false) {
    return err(new Error('invalid operator error shape'))
  }

  return ok(input)
}

// ---------------------------------------------------------------------------
// OperatorCancelResponse
// ---------------------------------------------------------------------------

const VALID_CANCEL_PHASES: ReadonlySet<string> = new Set(['CANCELLED', 'COMPLETED', 'FAILED'])

function hasValidOperatorCancelResponseShape(value: unknown): value is OperatorCancelResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    candidate.ok === true &&
    typeof candidate.runId === 'string' &&
    typeof candidate.phase === 'string' &&
    VALID_CANCEL_PHASES.has(candidate.phase)
  )
}

/**
 * Parse an unknown value as OperatorCancelResponse.
 *
 * Returns ok(value) when the input has the required shape.
 * Returns err(Error) with a FIXED reason string when validation fails —
 * the error message never echoes any part of the input.
 */
export function parseOperatorCancelResponse(input: unknown): Result<OperatorCancelResponse, Error> {
  if (hasValidOperatorCancelResponseShape(input) === false) {
    return err(new Error('invalid operator cancel response shape'))
  }

  return ok(input)
}

// ---------------------------------------------------------------------------
// OperatorPushVapidKeyResponse
// ---------------------------------------------------------------------------
//
// Contract-level guard only — accepts exactly the allowlisted response
// fields (publicKey, keyVersion). Extra fields are ignored per the module's
// extra-field policy; this function does not itself decide route
// availability or VAPID validity (see web/operator-push/vapid.ts for that).

function hasValidOperatorPushVapidKeyResponseShape(value: unknown): value is OperatorPushVapidKeyResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return typeof candidate.publicKey === 'string' && typeof candidate.keyVersion === 'string'
}

/**
 * Parse an unknown value as OperatorPushVapidKeyResponse.
 *
 * Returns ok(value) when the input has the required shape.
 * Returns err(Error) with a FIXED reason string when validation fails —
 * the error message never echoes any part of the input.
 */
export function parseOperatorPushVapidKeyResponse(input: unknown): Result<OperatorPushVapidKeyResponse, Error> {
  if (hasValidOperatorPushVapidKeyResponseShape(input) === false) {
    return err(new Error('invalid operator push vapid key response shape'))
  }

  return ok(input)
}

// ---------------------------------------------------------------------------
// OperatorPushSubscribeRequest
// ---------------------------------------------------------------------------
//
// Accepts the W3C `PushSubscription.toJSON()` shape: `{endpoint, keys:{p256dh, auth}}`.

function hasValidOperatorPushSubscribeRequestShape(value: unknown): value is OperatorPushSubscribeRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  if (typeof candidate.endpoint !== 'string' || candidate.endpoint.length === 0) {
    return false
  }

  if (typeof candidate.keys !== 'object' || candidate.keys === null || Array.isArray(candidate.keys)) {
    return false
  }

  const keys = candidate.keys as Record<string, unknown>
  return (
    typeof keys.p256dh === 'string' && keys.p256dh.length > 0 && typeof keys.auth === 'string' && keys.auth.length > 0
  )
}

/**
 * Parse an unknown value as OperatorPushSubscribeRequest.
 *
 * Accepts only the W3C `PushSubscription.toJSON()` shape:
 * `{endpoint, keys:{p256dh, auth}}`, with all fields as non-empty strings.
 * Returns err(Error) with a FIXED reason string when validation fails —
 * the error message never echoes any part of the input (endpoint/key
 * material must never appear in a parse error).
 */
export function parseOperatorPushSubscribeRequest(input: unknown): Result<OperatorPushSubscribeRequest, Error> {
  if (hasValidOperatorPushSubscribeRequestShape(input) === false) {
    return err(new Error('invalid operator push subscribe request shape'))
  }

  return ok(input)
}
