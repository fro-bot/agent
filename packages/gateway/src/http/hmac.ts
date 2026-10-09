/**
 * HMAC-SHA256 webhook signature verification and replay-window enforcement.
 *
 * Implements the Stripe-style signing scheme: HMAC is computed over
 * `timestamp + "." + rawBody` using the shared secret, constant-time compared.
 *
 * Both functions are pure (no I/O, no Date.now()). Inject `nowMs` for testability.
 */

import {Buffer} from 'node:buffer'
import {createHmac, timingSafeEqual} from 'node:crypto'

/** A SHA-256 HMAC signature: exactly 64 hex characters (case-insensitive), no prefix. */
const SIGNATURE_HEX_PATTERN = /^[0-9a-f]{64}$/i

/** Replay protection window: 5 minutes on each side of now. */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000

/**
 * Verify an HMAC-SHA256 signature over `timestampHeader + "." + rawBody`.
 *
 * Guards against:
 * - Wrong secret or tampered body/timestamp → `{ok:false, reason:'hmac_invalid'}`
 * - Malformed signature (not exactly 64 hex chars) → `{ok:false, reason:'hmac_invalid'}` before any
 *   HMAC is computed (no throw, no hashing on unauthenticated garbage)
 * - Length mismatch before `timingSafeEqual` (it throws on unequal-length Buffers) → same
 */
export function verifyHmac(
  secret: string,
  rawBody: Buffer,
  timestampHeader: string,
  signatureHex: string,
): {ok: true} | {ok: false; reason: string} {
  // Reject a malformed signature BEFORE any hashing: it must be exactly 64 hex chars
  // (SHA-256 → 32 bytes → 64 hex). Unauthenticated callers therefore cannot make the
  // server spend an HMAC computation on garbage, and Buffer.from(...,'hex') never sees
  // odd-length or non-hex input (it silently truncates / stops at the first bad char).
  if (SIGNATURE_HEX_PATTERN.test(signatureHex) === false) {
    return {ok: false, reason: 'hmac_invalid'}
  }

  // Compute the expected HMAC over timestamp + "." + rawBody
  const expected: Buffer = createHmac('sha256', secret).update(timestampHeader).update('.').update(rawBody).digest()

  // Guard: hex string must be exactly twice the byte length (defense in depth; the pattern
  // above already guarantees this).
  if (signatureHex.length !== expected.length * 2) {
    return {ok: false, reason: 'hmac_invalid'}
  }

  // Decode the provided signature (validated hex above).
  const received: Buffer = Buffer.from(signatureHex, 'hex')

  // Guard: after decoding, lengths must still match (they should given the check above,
  // but odd-length hex is silently truncated by Buffer.from, so double-check)
  if (received.length !== expected.length) {
    return {ok: false, reason: 'hmac_invalid'}
  }

  // Constant-time comparison — never short-circuit on mismatch
  const match = timingSafeEqual(expected, received)

  if (match !== true) {
    return {ok: false, reason: 'hmac_invalid'}
  }

  return {ok: true}
}

/**
 * Check that `timestampHeader` is within `windowMs` of `nowMs`.
 *
 * Treats malformed / unparseable timestamps as expired — generic response
 * prevents information leakage about what was wrong.
 *
 * Do NOT call `Date.now()` inside this function — inject `nowMs` for testability.
 */
export function checkTimestamp(
  timestampHeader: string,
  nowMs: number,
  windowMs: number,
): {ok: true} | {ok: false; reason: string} {
  const parsedMs = Date.parse(timestampHeader)

  // Date.parse returns NaN for unparseable strings
  if (Number.isFinite(parsedMs) === false) {
    return {ok: false, reason: 'timestamp_expired'}
  }

  if (Math.abs(nowMs - parsedMs) > windowMs) {
    return {ok: false, reason: 'timestamp_expired'}
  }

  return {ok: true}
}
