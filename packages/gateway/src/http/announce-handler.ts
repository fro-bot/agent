/**
 * Framework-agnostic handler for POST /v1/announce.
 *
 * Takes a raw body Buffer, headers, and injected deps; returns a typed
 * {status, body} result. server.ts adapts the Hono context → this function.
 *
 * Processing order (fail-closed, cheapest check first):
 *   1. Body size guard (8 KB hard limit)
 *   2. Rate limit
 *   3. Required headers present
 *   4. HMAC verification
 *   5. Timestamp window check
 *   6. Replay cache reserve (atomic check-and-set — concurrent duplicates rejected here)
 *   7. JSON parse
 *   8. Timestamp cross-check (body fired_at === timestampHeader by exact string)
 *   9. Schema decode (unknown event_type → 400)
 *  10. Render embed + post to Discord (Discord failure → 5xx, release reservation)
 *  11. Commit replay cache + return 200
 *
 * Security invariants:
 * - Steps 4–6 all return the SAME 401 body (no oracle for which check failed).
 * - Raw body, headers, signature, and rendered text are NEVER logged.
 * - Replay is committed ONLY after a successful Discord post (step 11).
 * - reservation is released on every post-reserve early-return so a legit retry
 *   is never permanently blocked by a malformed or failed request.
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

/** Fallback source key used when caller provides no IP. */
const DEFAULT_SOURCE_KEY = '__unknown__'

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
 * @param sourceKey - Client identity for rate limiting (IP / connection remote address).
 * @param deps - Injected dependencies.
 */
export async function handleAnnounce(
  rawBody: Buffer,
  headers: {readonly get: (name: string) => string | null | undefined},
  sourceKey: string | undefined,
  deps: AnnounceHandlerDeps,
): Promise<AnnounceHandlerResult> {
  const {client, logger, webhookSecret, presenceChannelId, rateLimiter, replayCache} = deps
  const clock = deps.clock ?? Date.now
  const key = sourceKey ?? DEFAULT_SOURCE_KEY

  // ── Step 1: Body size ────────────────────────────────────────────────────
  if (rawBody.byteLength > ANNOUNCE_MAX_BODY_BYTES) {
    logger.warn({reason: 'too_large'}, 'announce rejected')
    return {status: 413, body: {error: 'payload too large'}}
  }

  // ── Step 2: Rate limit ───────────────────────────────────────────────────
  if (rateLimiter.allow(key) === false) {
    logger.warn({reason: 'rate_limited'}, 'announce rejected')
    return {status: 429, body: {error: 'rate limited'}}
  }

  // ── Step 3: Required headers ─────────────────────────────────────────────
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

  // ── Step 4: HMAC verification ────────────────────────────────────────────
  const hmacResult = verifyHmac(webhookSecret, rawBody, timestampHeader, signatureHex)
  if (hmacResult.ok === false) {
    logger.warn({reason: 'hmac_invalid'}, 'announce rejected')
    return {status: 401, body: UNAUTHORIZED_BODY}
  }

  // ── Step 5: Timestamp window ─────────────────────────────────────────────
  const tsResult = checkTimestamp(timestampHeader, clock(), REPLAY_WINDOW_MS)
  if (tsResult.ok === false) {
    logger.warn({reason: 'timestamp_expired'}, 'announce rejected')
    // Same body as step 4 — no oracle
    return {status: 401, body: UNAUTHORIZED_BODY}
  }

  // ── Step 6: Replay cache reserve (atomic check-and-set) ─────────────────
  // reserve() is synchronous — no await between check and set.
  // A concurrent request with the same sig will hit this and get false.
  if (replayCache.reserve(signatureHex) === false) {
    logger.warn({reason: 'replayed'}, 'announce rejected')
    return {status: 401, body: UNAUTHORIZED_BODY}
  }

  // ── Step 7: JSON parse ───────────────────────────────────────────────────
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody.toString('utf8'))
  } catch {
    logger.warn({reason: 'malformed_body'}, 'announce rejected')
    replayCache.release(signatureHex)
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
    replayCache.release(signatureHex)
    return {status: 400, body: {error: 'bad request'}}
  }

  // ── Step 9: Schema decode ────────────────────────────────────────────────
  const decoded = decodeAnnounce(parsed)
  if (Either.isLeft(decoded)) {
    const reason = decoded.left === 'unknown_event_type' ? 'unknown_event_type' : 'bad_request'
    logger.warn({reason}, 'announce rejected')
    replayCache.release(signatureHex)
    return {status: 400, body: {error: 'bad request'}}
  }

  const payload = decoded.right

  // ── Step 10: Render + post to Discord ───────────────────────────────────
  const embed: PresenceEmbed = renderEmbed(payload)
  const postResult = await postPresenceEmbed(client, presenceChannelId, embed)

  if (postResult.success === false) {
    logger.error({reason: 'discord_post_failed'}, 'announce discord post failed')
    // Release reservation so the control-plane retry is not blocked
    replayCache.release(signatureHex)
    return {status: 500, body: {error: 'internal error'}}
  }

  // ── Step 11: Commit replay cache + success ───────────────────────────────
  replayCache.commit(signatureHex)
  logger.info({event_type: payload.event_type, fired_at: payload.fired_at, discordStatus: 'ok'}, 'announce accepted')
  return {status: 200, body: {ok: true}}
}
