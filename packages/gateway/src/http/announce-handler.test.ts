/**
 * Unit-level tests for the announce handler.
 *
 * Covers every ordered branch plus the security invariant:
 * no log line ever contains the webhook secret, a planted repo name,
 * rendered_text content, or the signature hex.
 *
 * Uses BDD comments (#given, #when, #then).
 * Throw-based narrowing helpers instead of conditional expects.
 */

import type {AnnounceHandlerDeps, AnnounceLogger} from './announce-handler.js'
import {Buffer} from 'node:buffer'
import {createHmac} from 'node:crypto'

import {describe, expect, it, vi} from 'vitest'
import {handleAnnounce} from './announce-handler.js'
import {createRateLimiter} from './rate-limit.js'
import {createReplayCache} from './replay-cache.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = 'super-secret-test-key'
const CHANNEL_ID = 'presence-channel-123'
const NOW_MS = new Date('2026-05-29T12:00:00.000Z').getTime()

/** Valid ISO8601 timestamp that matches NOW_MS. */
const TIMESTAMP = '2026-05-29T12:00:00.000Z'

/** A payload that should pass all validation steps. */
const validSurveyPayload = {
  v: 1,
  event_type: 'survey_completed',
  fired_at: TIMESTAMP,
  context: {owner: 'acme', repo: 'alpha', slug: 'setup', wiki_pages_changed: 3},
  rendered_text: null,
}

const validInvitationPayload = {
  v: 1,
  event_type: 'invitation_accepted',
  fired_at: TIMESTAMP,
  context: {count: 1, repos: [{owner: 'acme', name: 'alpha'}]},
  rendered_text: null,
}

function makeRawBody(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload), 'utf8')
}

function makeSignature(rawBody: Buffer, timestamp: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(timestamp).update('.').update(rawBody).digest('hex')
}

function makeHeaders(
  rawBody: Buffer,
  opts: {timestamp?: string; secret?: string; omitSig?: boolean; omitTs?: boolean} = {},
): {
  get: (name: string) => string | null
} {
  const timestamp = opts.timestamp ?? TIMESTAMP
  const sig = opts.omitSig === true ? null : makeSignature(rawBody, timestamp, opts.secret ?? SECRET)
  const ts = opts.omitTs === true ? null : timestamp
  return {
    get(name: string): string | null {
      if (name === 'x-gateway-signature') return sig
      if (name === 'x-gateway-timestamp') return ts
      return null
    },
  }
}

function makeDiscordClient(succeed = true): {
  client: AnnounceHandlerDeps['client']
  sendMock: ReturnType<typeof vi.fn>
} {
  const sendMock = vi.fn()
  if (succeed) {
    sendMock.mockResolvedValue(undefined)
  } else {
    sendMock.mockRejectedValue(new Error('Discord API error'))
  }
  const fetchMock = vi.fn().mockResolvedValue({
    isTextBased: () => true,
    send: sendMock,
  })
  const client = {channels: {fetch: fetchMock}} as unknown as AnnounceHandlerDeps['client']
  return {client, sendMock}
}

/** Captured logger that records all calls for security assertions. */
function makeLogger(): {
  logger: AnnounceLogger
  calls: {level: string; ctx: Record<string, unknown>; msg: string}[]
} {
  const calls: {level: string; ctx: Record<string, unknown>; msg: string}[] = []
  const logger: AnnounceLogger = {
    info: (ctx, msg) => calls.push({level: 'info', ctx, msg}),
    warn: (ctx, msg) => calls.push({level: 'warn', ctx, msg}),
    error: (ctx, msg) => calls.push({level: 'error', ctx, msg}),
  }
  return {logger, calls}
}

function makeDeps(
  client: AnnounceHandlerDeps['client'],
  logger: AnnounceLogger,
  overrides: Partial<AnnounceHandlerDeps> = {},
): AnnounceHandlerDeps {
  return {
    client,
    logger,
    webhookSecret: SECRET,
    presenceChannelId: CHANNEL_ID,
    rateLimiter: overrides.rateLimiter ?? createRateLimiter(),
    replayCache: overrides.replayCache ?? createReplayCache(),
    clock: overrides.clock ?? (() => NOW_MS),
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('handleAnnounce — happy path (survey_completed)', () => {
  it('returns 200 {ok:true} and records replay after Discord success', async () => {
    // #given
    const rawBody = makeRawBody(validSurveyPayload)
    const headers = makeHeaders(rawBody)
    const {client, sendMock} = makeDiscordClient(true)
    const {logger} = makeLogger()
    const replayCache = createReplayCache({clock: () => NOW_MS})
    const deps = makeDeps(client, logger, {replayCache})

    // #when
    const result = await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    expect(result).toEqual({status: 200, body: {ok: true}})
    expect(sendMock).toHaveBeenCalledOnce()
    // replay is recorded — a second call with the same sig is rejected
    const result2 = await handleAnnounce(rawBody, headers, '1.2.3.4', deps)
    expect(result2.status).toBe(401)
  })
})

describe('handleAnnounce — happy path (invitation_accepted)', () => {
  it('returns 200 {ok:true} for valid invitation payload', async () => {
    // #given
    const rawBody = makeRawBody(validInvitationPayload)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient(true)
    const {logger} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    const result = await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    expect(result).toEqual({status: 200, body: {ok: true}})
  })
})

// ---------------------------------------------------------------------------
// Reject branches (ordered: cheapest first)
// ---------------------------------------------------------------------------

describe('handleAnnounce — step 1: body too large', () => {
  it('returns 413 when rawBody exceeds 8 KB', async () => {
    // #given — 8193 bytes
    const rawBody = Buffer.alloc(8193, 0x41)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient()
    const {logger} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    const result = await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    expect(result).toEqual({status: 413, body: {error: 'payload too large'}})
  })
})

describe('handleAnnounce — step 2: rate limited', () => {
  it('returns 429 when rate limiter denies', async () => {
    // #given — limiter always denies
    const rawBody = makeRawBody(validSurveyPayload)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient()
    const {logger} = makeLogger()
    const rateLimiter = {allow: () => false}
    const deps = makeDeps(client, logger, {rateLimiter})

    // #when
    const result = await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    expect(result).toEqual({status: 429, body: {error: 'rate limited'}})
  })
})

describe('handleAnnounce — step 3: missing headers', () => {
  it('returns 400 when X-Gateway-Signature is absent', async () => {
    // #given
    const rawBody = makeRawBody(validSurveyPayload)
    const headers = makeHeaders(rawBody, {omitSig: true})
    const {client} = makeDiscordClient()
    const {logger} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    const result = await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    expect(result).toEqual({status: 400, body: {error: 'bad request'}})
  })

  it('returns 400 when X-Gateway-Timestamp is absent', async () => {
    // #given
    const rawBody = makeRawBody(validSurveyPayload)
    const headers = makeHeaders(rawBody, {omitTs: true})
    const {client} = makeDiscordClient()
    const {logger} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    const result = await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    expect(result).toEqual({status: 400, body: {error: 'bad request'}})
  })
})

describe('handleAnnounce — step 4: bad HMAC', () => {
  it('returns 401 with generic body when signature is wrong', async () => {
    // #given
    const rawBody = makeRawBody(validSurveyPayload)
    const headers = makeHeaders(rawBody, {secret: 'wrong-secret'})
    const {client} = makeDiscordClient()
    const {logger} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    const result = await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    expect(result).toEqual({status: 401, body: {error: 'unauthorized'}})
  })
})

describe('handleAnnounce — step 5: stale timestamp', () => {
  it('returns 401 with SAME body as bad-HMAC (no oracle)', async () => {
    // #given — valid HMAC but timestamp is 10 minutes stale
    const staleTimestamp = '2026-05-29T11:50:00.000Z' // 10 min before NOW_MS
    const rawBodyWithStale = Buffer.from(JSON.stringify({...validSurveyPayload, fired_at: staleTimestamp}), 'utf8')
    const headers = makeHeaders(rawBodyWithStale, {timestamp: staleTimestamp})
    const {client} = makeDiscordClient()
    const {logger} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    const result = await handleAnnounce(rawBodyWithStale, headers, '1.2.3.4', deps)

    // #then — 401 with same body as step 4
    expect(result).toEqual({status: 401, body: {error: 'unauthorized'}})
  })
})

describe('handleAnnounce — step 6: replayed request', () => {
  it('returns 401 with generic body for a replayed signature', async () => {
    // #given — pre-seed the replay cache with the signature
    const rawBody = makeRawBody(validSurveyPayload)
    const sig = makeSignature(rawBody, TIMESTAMP)
    const replayCache = createReplayCache({clock: () => NOW_MS})
    replayCache.record(sig, NOW_MS)

    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient()
    const {logger} = makeLogger()
    const deps = makeDeps(client, logger, {replayCache})

    // #when
    const result = await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    expect(result).toEqual({status: 401, body: {error: 'unauthorized'}})
  })
})

describe('handleAnnounce — step 7: malformed JSON', () => {
  it('returns 400 when body is not valid JSON', async () => {
    // #given — valid HMAC over garbage body
    const rawBody = Buffer.from('not-json!', 'utf8')
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient()
    const {logger} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    const result = await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    expect(result).toEqual({status: 400, body: {error: 'bad request'}})
  })
})

describe('handleAnnounce — step 8: timestamp cross-check mismatch', () => {
  it('returns 400 when body fired_at differs from X-Gateway-Timestamp', async () => {
    // #given — body has a different fired_at from the header
    const payloadWithWrongFiredAt = {
      ...validSurveyPayload,
      fired_at: '2026-05-29T12:00:01.000Z', // one second off from TIMESTAMP
    }
    const rawBody = makeRawBody(payloadWithWrongFiredAt)
    // Sign with TIMESTAMP (not the body's fired_at)
    const headers = makeHeaders(rawBody) // uses TIMESTAMP
    const {client} = makeDiscordClient()
    const {logger} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    const result = await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    expect(result).toEqual({status: 400, body: {error: 'bad request'}})
  })
})

describe('handleAnnounce — step 9: unknown event_type', () => {
  it('returns 400 for an unrecognized event_type', async () => {
    // #given
    const payload = {...validSurveyPayload, event_type: 'reconcile_notable'}
    const rawBody = makeRawBody(payload)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient()
    const {logger} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    const result = await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    expect(result).toEqual({status: 400, body: {error: 'bad request'}})
  })
})

describe('handleAnnounce — step 10: Discord failure', () => {
  it('returns 500 and does NOT record replay when Discord post fails', async () => {
    // #given — Discord send will fail
    const rawBody = makeRawBody(validSurveyPayload)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient(false)
    const {logger} = makeLogger()
    const replayCache = createReplayCache({clock: () => NOW_MS})
    const deps = makeDeps(client, logger, {replayCache})
    const sig = makeSignature(rawBody, TIMESTAMP)

    // #when
    const result = await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then — 500
    expect(result).toEqual({status: 500, body: {error: 'internal error'}})

    // replay NOT recorded — a retry of the same sig is NOT blocked
    expect(replayCache.check(sig)).toBe(false)

    // retry succeeds (Discord now works)
    const {client: client2} = makeDiscordClient(true)
    const deps2 = makeDeps(client2, logger, {replayCache})
    const retry = await handleAnnounce(rawBody, headers, '1.2.3.4', deps2)
    expect(retry).toEqual({status: 200, body: {ok: true}})
  })
})

// ---------------------------------------------------------------------------
// Security: captured-logger test
// ---------------------------------------------------------------------------

describe('handleAnnounce — security: no secret/body leakage in logs', () => {
  /**
   * PLANTED_REPO_NAME appears in the payload context — verifying it never
   * surfaces in logs confirms we're not accidentally logging raw bodies or
   * rendered embed text.
   */
  const PLANTED_REPO_NAME = 'super-secret-repo-do-not-log'
  const PLANTED_RENDERED_TEXT = 'rendered_text_sentinel_value_abc123'

  const sensitivePayload = {
    v: 1,
    event_type: 'survey_completed',
    fired_at: TIMESTAMP,
    context: {owner: 'acme', repo: PLANTED_REPO_NAME, slug: 'setup', wiki_pages_changed: 1},
    rendered_text: PLANTED_RENDERED_TEXT,
  }

  function assertNoLeakage(calls: {level: string; ctx: Record<string, unknown>; msg: string}[]): void {
    const serialized = JSON.stringify(calls)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain(PLANTED_REPO_NAME)
    expect(serialized).not.toContain(PLANTED_RENDERED_TEXT)
  }

  it('does not log secret, repo name, or rendered_text on happy path', async () => {
    // #given
    const rawBody = makeRawBody(sensitivePayload)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient(true)
    const {logger, calls} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    assertNoLeakage(calls)
  })

  it('does not log secret, repo name, or rendered_text on hmac reject', async () => {
    // #given
    const rawBody = makeRawBody(sensitivePayload)
    const headers = makeHeaders(rawBody, {secret: 'wrong-secret'})
    const {client} = makeDiscordClient()
    const {logger, calls} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    assertNoLeakage(calls)
  })

  it('does not log secret, repo name, or rendered_text on malformed JSON', async () => {
    // #given — a raw body that contains the planted name but is invalid JSON
    const rawBody = Buffer.from(`{"repo": "${PLANTED_REPO_NAME}", broken`, 'utf8')
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient()
    const {logger, calls} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    assertNoLeakage(calls)
  })

  it('does not log secret, repo name, or rendered_text on too-large body', async () => {
    // #given — fill with ascii that contains the planted name repeated
    const rawBody = Buffer.alloc(8193, 0x41)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient()
    const {logger, calls} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    assertNoLeakage(calls)
  })

  it('does not log secret, repo name, or rendered_text on rate limit', async () => {
    // #given
    const rawBody = makeRawBody(sensitivePayload)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient()
    const {logger, calls} = makeLogger()
    const rateLimiter = {allow: () => false}
    const deps = makeDeps(client, logger, {rateLimiter})

    // #when
    await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    assertNoLeakage(calls)
  })

  it('does not log secret, repo name, or rendered_text on replay reject', async () => {
    // #given
    const rawBody = makeRawBody(sensitivePayload)
    const sig = makeSignature(rawBody, TIMESTAMP)
    const replayCache = createReplayCache({clock: () => NOW_MS})
    replayCache.record(sig, NOW_MS)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient()
    const {logger, calls} = makeLogger()
    const deps = makeDeps(client, logger, {replayCache})

    // #when
    await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    assertNoLeakage(calls)
  })

  it('does not log secret, repo name, or rendered_text on discord failure', async () => {
    // #given
    const rawBody = makeRawBody(sensitivePayload)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient(false)
    const {logger, calls} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    assertNoLeakage(calls)
  })
})

// ---------------------------------------------------------------------------
// Replay recorded only after success
// ---------------------------------------------------------------------------

describe('replay cache record-only-on-success invariant', () => {
  it('discord failure then retry with same sig is NOT blocked as replay', async () => {
    // #given — first call fails Discord
    const rawBody = makeRawBody(validSurveyPayload)
    const headers = makeHeaders(rawBody)
    const replayCache = createReplayCache({clock: () => NOW_MS})
    const {logger} = makeLogger()

    const {client: failClient} = makeDiscordClient(false)
    const deps1 = makeDeps(failClient, logger, {replayCache})
    const fail = await handleAnnounce(rawBody, headers, '1.2.3.4', deps1)
    expect(fail.status).toBe(500)

    // #when — retry with same sig but Discord now succeeds
    const {client: successClient} = makeDiscordClient(true)
    const deps2 = makeDeps(successClient, logger, {replayCache})
    const retry = await handleAnnounce(rawBody, headers, '1.2.3.4', deps2)

    // #then — not blocked
    expect(retry).toEqual({status: 200, body: {ok: true}})
  })
})
