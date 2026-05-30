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

/** Replay protection window: 5 minutes on each side of now. */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000

/**
 * Verify an HMAC-SHA256 signature over `timestampHeader + "." + rawBody`.
 *
 * Guards against:
 * - Wrong secret or tampered body/timestamp → `{ok:false, reason:'hmac_invalid'}`
 * - Malformed hex (odd length, non-hex chars) → `{ok:false, reason:'hmac_invalid'}` (no throw)
 * - Length mismatch before `timingSafeEqual` (it throws on unequal-length Buffers) → same
 */
export function verifyHmac(
  secret: string,
  rawBody: Buffer,
  timestampHeader: string,
  signatureHex: string,
): {ok: true} | {ok: false; reason: string} {
  // Compute the expected HMAC over timestamp + "." + rawBody
  const expected: Buffer = createHmac('sha256', secret).update(timestampHeader).update('.').update(rawBody).digest()

  // Guard: hex string must be exactly twice the byte length to be a valid encoding
  // (Buffer.from with 'hex' silently truncates odd-length strings; a non-hex char
  // produces a zero byte at that position — both produce length mismatches or wrong values)
  if (signatureHex.length !== expected.length * 2) {
    return {ok: false, reason: 'hmac_invalid'}
  }

  // Decode the provided signature. Non-hex characters produce 0x00 bytes, which
  // will fail timingSafeEqual — no throw needed here, but we still guard just in case.
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
