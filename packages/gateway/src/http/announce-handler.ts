/**
 * Framework-agnostic handler for POST /v1/announce.
 *
 * Takes a raw body Buffer, headers, and injected deps; returns a typed
 * {status, body} result. server.ts adapts the Hono context → this function.
 *
 * Processing order (fail-closed; authenticate BEFORE spending any quota):
 *   1. Body size guard (8 KB hard limit)
 *   2. Required headers present
 *   3. HMAC verification (malformed signature rejected before hashing)
 *   4. Timestamp window check
 *   5. Replay cache reserve (atomic check-and-set — concurrent duplicates rejected here)
 *   6. Producer rate limit (one fixed server-owned key; 429 releases the reservation)
 *   7. JSON parse
 *   8. Timestamp cross-check (body fired_at === timestampHeader by exact string)
 *   9. Schema decode (unknown event_type → 400)
 *  10. Render embed + post to Discord (Discord failure → 5xx, release reservation)
 *  11. Commit replay cache + return 200
 *
 * Security invariants:
 * - Steps 3–5 all return the SAME 401 body (no oracle for which check failed).
 * - The rate limiter is keyed on the authenticated producer, never on caller-controlled or
 *   socket-derived data. Unauthenticated, stale, and replayed traffic therefore cannot
 *   consume the producer's allowance. Coarse flood protection for unauthenticated traffic
 *   belongs at ingress/transport, not in this handler.
 * - Raw body, headers, signature, and rendered text are NEVER logged.
 * - Replay is committed ONLY after a successful Discord post (step 11).
 * - reservation is released on every post-reserve early-return (including 429) so a legit
 *   retry is never permanently blocked by a malformed, throttled, or failed request.
 */

import type {Buffer} from 'node:buffer'

import type {Client} from 'discord.js'
import type {PresenceEmbed} from '../discord/presence.js'
import type {RateLimiter} from './rate-limit.js'
import type {ReplayCache} from './replay-cache.js'
import {Either} from 'effect'
import {postPresenceEmbed} from '../discord/presence.js'
import {decodeAnnounce} from './announce-schema.js'
import {checkTimestamp, REPLAY_WINDOW_MS, verifyHmac} from './hmac.js'
import {renderEmbed} from './templates.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed request body size in bytes. Shared with server.ts. */
export const ANNOUNCE_MAX_BODY_BYTES = 8 * 1024

/**
 * Fixed, server-owned rate-limit key. There is a single shared webhook secret, so a request
 * that passes HMAC is by definition the control-plane producer. The key must never be derived
 * from request data (socket address, XFF, headers, body).
 */
const PRODUCER_KEY = 'control-plane'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of the logger injected into the handler. */
export interface AnnounceLogger {
  readonly info: (ctx: Record<string, unknown>, msg: string) => void
  readonly warn: (ctx: Record<string, unknown>, msg: string) => void
  readonly error: (ctx: Record<string, unknown>, msg: string) => void
}

/** Injected dependencies for the announce handler. */
export interface AnnounceHandlerDeps {
  readonly client: Client
  readonly logger: AnnounceLogger
  readonly webhookSecret: string
  readonly presenceChannelId: string
  readonly rateLimiter: RateLimiter
  readonly replayCache: ReplayCache
  /** Injectable clock for testability (default: Date.now). */
  readonly clock?: () => number
}

/** Result returned by handleAnnounce — server.ts maps this to c.json(body, status). */
export interface AnnounceHandlerResult {
  readonly status: 200 | 400 | 401 | 413 | 429 | 500 | 503
  readonly body: object
}

// Shared 401 body — intentionally generic so callers cannot distinguish
// bad-sig from stale-timestamp from replay (or concurrent in-flight duplicate).
const UNAUTHORIZED_BODY = {error: 'unauthorized'} as const

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

/**
 * Handle a POST /v1/announce request.
 *
 * @param rawBody - The raw request body Buffer (exact bytes used for HMAC).
 * @param headers - Raw headers from the request (lowercased lookup expected).
 * @param headers.get - Look up a header by lowercased name.
 * @param deps - Injected dependencies.
 */
export async function handleAnnounce(
  rawBody: Buffer,
  headers: {readonly get: (name: string) => string | null | undefined},
  deps: AnnounceHandlerDeps,
): Promise<AnnounceHandlerResult> {
  const {client, logger, webhookSecret, presenceChannelId, rateLimiter, replayCache} = deps
  const clock = deps.clock ?? Date.now

  // ── Step 1: Body size ────────────────────────────────────────────────────
  if (rawBody.byteLength > ANNOUNCE_MAX_BODY_BYTES) {
    logger.warn({reason: 'too_large'}, 'announce rejected')
    return {status: 413, body: {error: 'payload too large'}}
  }

  // ── Step 2: Required headers ─────────────────────────────────────────────
  const signatureHex = headers.get('x-gateway-signature')
  const timestampHeader = headers.get('x-gateway-timestamp')

  if (signatureHex === null || signatureHex === undefined || signatureHex === '') {
    logger.warn({reason: 'bad_request'}, 'announce rejected')
    return {status: 400, body: {error: 'bad request'}}
  }
  if (timestampHeader === null || timestampHeader === undefined || timestampHeader === '') {
    logger.warn({reason: 'bad_request'}, 'announce rejected')
    return {status: 400, body: {error: 'bad request'}}
  }

  // ── Step 3: HMAC verification ────────────────────────────────────────────
  const hmacResult = verifyHmac(webhookSecret, rawBody, timestampHeader, signatureHex)
  if (hmacResult.ok === false) {
    logger.warn({reason: 'hmac_invalid'}, 'announce rejected')
    return {status: 401, body: UNAUTHORIZED_BODY}
  }

  // Normalize only after HMAC verified (hex is case-insensitive; the signature is now known-valid hex).
  const replayKey = signatureHex.toLowerCase()

  // ── Step 4: Timestamp window ─────────────────────────────────────────────
  const tsResult = checkTimestamp(timestampHeader, clock(), REPLAY_WINDOW_MS)
  if (tsResult.ok === false) {
    logger.warn({reason: 'timestamp_expired'}, 'announce rejected')
    // Same body as step 3 — no oracle
    return {status: 401, body: UNAUTHORIZED_BODY}
  }

  // ── Step 5: Replay cache reserve (atomic check-and-set) ─────────────────
  // reserve() is synchronous — no await between check and set.
  // A concurrent request with the same sig will hit this and get false.
  // The key is the normalized (lowercase) signature so a case-variant of an
  // already-seen signature cannot dodge the cache.
  if (replayCache.reserve(replayKey) === false) {
    logger.warn({reason: 'replayed'}, 'announce rejected')
    return {status: 401, body: UNAUTHORIZED_BODY}
  }

  // ── Step 6: Producer rate limit ──────────────────────────────────────────
  // Runs only for authenticated, fresh, non-replayed requests, on one fixed key.
  // A throttled request releases its reservation so a retry after the window works.
  if (rateLimiter.allow(PRODUCER_KEY) === false) {
    logger.warn({reason: 'producer_rate_limited'}, 'announce rejected')
    replayCache.release(replayKey)
    return {status: 429, body: {error: 'rate limited'}}
  }

  // ── Step 7: JSON parse ───────────────────────────────────────────────────
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody.toString('utf8'))
  } catch {
    logger.warn({reason: 'malformed_body'}, 'announce rejected')
    replayCache.release(replayKey)
    return {status: 400, body: {error: 'bad request'}}
  }

  // ── Step 8: Timestamp cross-check ───────────────────────────────────────
  // The body fired_at MUST exactly equal the timestampHeader by raw string comparison.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    'fired_at' in parsed === false ||
    (parsed as Record<string, unknown>).fired_at !== timestampHeader
  ) {
    logger.warn({reason: 'timestamp_mismatch'}, 'announce rejected')
    replayCache.release(replayKey)
    return {status: 400, body: {error: 'bad request'}}
  }

  // ── Step 9: Schema decode ────────────────────────────────────────────────
  const decoded = decodeAnnounce(parsed)
  if (Either.isLeft(decoded)) {
    const reason = decoded.left === 'unknown_event_type' ? 'unknown_event_type' : 'bad_request'
    logger.warn({reason}, 'announce rejected')
    replayCache.release(replayKey)
    return {status: 400, body: {error: 'bad request'}}
  }

  const payload = decoded.right

  // ── Step 10: Render + post to Discord ───────────────────────────────────
  const embed: PresenceEmbed = renderEmbed(payload)
  const postResult = await postPresenceEmbed(client, presenceChannelId, embed)

  if (postResult.success === false) {
    logger.error({reason: 'discord_post_failed'}, 'announce discord post failed')
    // Release reservation so the control-plane retry is not blocked
    replayCache.release(replayKey)
    return {status: 500, body: {error: 'internal error'}}
  }

  // ── Step 11: Commit replay cache + success ───────────────────────────────
  replayCache.commit(replayKey)
  logger.info({event_type: payload.event_type, fired_at: payload.fired_at, discordStatus: 'ok'}, 'announce accepted')
  return {status: 200, body: {ok: true}}
}
