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
// Narrow client interface — exactly what handleAnnounce uses via postPresenceEmbed
// ---------------------------------------------------------------------------

/** Minimal channel shape used by postPresenceEmbed. */
interface FakeChannel {
  readonly isTextBased: () => boolean
  readonly send: ReturnType<typeof vi.fn>
}

/** Minimal Client shape used by the deps. */
interface FakeClient {
  readonly channels: {
    readonly fetch: ReturnType<typeof vi.fn>
  }
}

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

/**
 * Create a minimal typed mock client — no double-cast needed.
 * Returns a FakeClient whose channel.send is controllable.
 */
function makeDiscordClient(succeed = true): {
  client: FakeClient & AnnounceHandlerDeps['client']
  sendMock: ReturnType<typeof vi.fn>
} {
  const sendMock = vi.fn()
  if (succeed === true) {
    sendMock.mockResolvedValue(undefined)
  } else {
    sendMock.mockRejectedValue(new Error('Discord API error'))
  }
  const fakeChannel: FakeChannel = {
    isTextBased: () => true,
    send: sendMock,
  }
  const fetchMock = vi.fn().mockResolvedValue(fakeChannel)
  const client: FakeClient = {channels: {fetch: fetchMock}}
  // FakeClient satisfies the structural surface that postPresenceEmbed uses;
  // cast to the full Client type only here so the rest of the test uses FakeClient.
  return {client: client as FakeClient & AnnounceHandlerDeps['client'], sendMock}
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
    // replay is committed — a second call with the same sig is rejected
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
  it('returns 401 with generic body for a replayed (committed) signature', async () => {
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

  it('returns 401 for a concurrent in-flight duplicate (reserved sig)', async () => {
    // #given — pre-seed the replay cache with a reserved signature
    const rawBody = makeRawBody(validSurveyPayload)
    const sig = makeSignature(rawBody, TIMESTAMP)
    const replayCache = createReplayCache({clock: () => NOW_MS})
    replayCache.reserve(sig) // simulate in-flight first request

    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient()
    const {logger} = makeLogger()
    const deps = makeDeps(client, logger, {replayCache})

    // #when — second request with same sig while first is in-flight
    const result = await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then — rejected immediately, same 401 body
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

    // replay NOT committed — a retry of the same sig is NOT blocked
    expect(replayCache.check(sig)).toBe(false)

    // retry succeeds (Discord now works)
    const {client: client2} = makeDiscordClient(true)
    const deps2 = makeDeps(client2, logger, {replayCache})
    const retry = await handleAnnounce(rawBody, headers, '1.2.3.4', deps2)
    expect(retry).toEqual({status: 200, body: {ok: true}})
  })
})

// ---------------------------------------------------------------------------
// FIX 1: Concurrency test — concurrent duplicate requests, same sig
// ---------------------------------------------------------------------------

describe('handleAnnounce — concurrency: duplicate in-flight requests', () => {
  it('allows only ONE Discord post when two requests race with the same signature', async () => {
    // #given — a Discord post that we can hold pending with a deferred promise
    const rawBody = makeRawBody(validSurveyPayload)
    const headers = makeHeaders(rawBody)
    const replayCache = createReplayCache({clock: () => NOW_MS})
    const {logger} = makeLogger()

    let resolveDiscord!: () => void
    const discordHeld = new Promise<void>(resolve => {
      resolveDiscord = resolve
    })

    const sendMock = vi.fn().mockReturnValue(discordHeld)
    const fetchMock = vi.fn().mockResolvedValue({
      isTextBased: () => true,
      send: sendMock,
    })
    const fakeClient: FakeClient = {channels: {fetch: fetchMock}}
    const client = fakeClient as FakeClient & AnnounceHandlerDeps['client']

    const deps1 = makeDeps(client, logger, {replayCache})
    const deps2 = makeDeps(client, logger, {replayCache})

    // #when — fire both requests concurrently; first wins the reserve(), second loses
    const p1 = handleAnnounce(rawBody, headers, '1.2.3.4', deps1)
    // Let req2 start before req1's Discord post completes
    await Promise.resolve()
    const result2 = await handleAnnounce(rawBody, headers, '1.2.3.4', deps2)
    // Now release the Discord post for req1
    resolveDiscord()
    const result1 = await p1

    // #then — exactly one Discord post; second gets 401
    expect(sendMock).toHaveBeenCalledOnce()
    expect(result1).toEqual({status: 200, body: {ok: true}})
    expect(result2).toEqual({status: 401, body: {error: 'unauthorized'}})
  })

  it('discord-post failure then retry of same sig is NOT blocked (release worked)', async () => {
    // #given — first call fails Discord
    const rawBody = makeRawBody(validSurveyPayload)
    const headers = makeHeaders(rawBody)
    const replayCache = createReplayCache({clock: () => NOW_MS})
    const {logger} = makeLogger()

    const {client: failClient} = makeDiscordClient(false)
    const deps1 = makeDeps(failClient, logger, {replayCache})
    const fail = await handleAnnounce(rawBody, headers, '1.2.3.4', deps1)
    expect(fail.status).toBe(500)

    // #when — retry with same sig, Discord now succeeds
    const {client: successClient} = makeDiscordClient(true)
    const deps2 = makeDeps(successClient, logger, {replayCache})
    const retry = await handleAnnounce(rawBody, headers, '1.2.3.4', deps2)

    // #then — not blocked as replay
    expect(retry).toEqual({status: 200, body: {ok: true}})
  })

  it('post-reserve 400 (timestamp mismatch) releases sig so a new valid request is accepted', async () => {
    // #given — a request that will fail at timestamp cross-check (step 8)
    const payloadWithWrongFiredAt = {...validSurveyPayload, fired_at: '2026-05-29T12:00:01.000Z'}
    const rawBodyBad = makeRawBody(payloadWithWrongFiredAt)
    const headersBad = makeHeaders(rawBodyBad) // signed with TIMESTAMP, body has wrong fired_at
    const replayCache = createReplayCache({clock: () => NOW_MS})
    const {logger} = makeLogger()
    const {client} = makeDiscordClient(true)

    // Send malformed request — it gets a 400 but reserves then releases
    const badResult = await handleAnnounce(rawBodyBad, headersBad, '1.2.3.4', makeDeps(client, logger, {replayCache}))
    expect(badResult.status).toBe(400)

    // #when — a new valid request (different sig because different body) is sent
    const rawBodyGood = makeRawBody(validSurveyPayload)
    const headersGood = makeHeaders(rawBodyGood)
    const goodResult = await handleAnnounce(
      rawBodyGood,
      headersGood,
      '1.2.3.4',
      makeDeps(client, logger, {replayCache}),
    )

    // #then — accepted normally
    expect(goodResult).toEqual({status: 200, body: {ok: true}})
  })
})

// ---------------------------------------------------------------------------
// Security: captured-logger test (FIX 8 strengthened)
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

  function assertNoLeakage(
    calls: {level: string; ctx: Record<string, unknown>; msg: string}[],
    signatureHex?: string,
  ): void {
    const serialized = JSON.stringify(calls)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain(PLANTED_REPO_NAME)
    expect(serialized).not.toContain(PLANTED_RENDERED_TEXT)
    if (signatureHex !== undefined) {
      expect(serialized).not.toContain(signatureHex)
    }
  }

  it('does not log secret, repo name, rendered_text, or sig hex on happy path', async () => {
    // #given
    const rawBody = makeRawBody(sensitivePayload)
    const sig = makeSignature(rawBody, TIMESTAMP)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient(true)
    const {logger, calls} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    assertNoLeakage(calls, sig)
  })

  it('does not log secret, repo name, rendered_text, or sig hex on hmac reject', async () => {
    // #given
    const rawBody = makeRawBody(sensitivePayload)
    const sig = makeSignature(rawBody, TIMESTAMP, 'wrong-secret')
    const headers = makeHeaders(rawBody, {secret: 'wrong-secret'})
    const {client} = makeDiscordClient()
    const {logger, calls} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    assertNoLeakage(calls, sig)
  })

  it('does not log secret, repo name, rendered_text, or sig hex on timestamp_expired', async () => {
    // #given — stale timestamp
    const staleTimestamp = '2026-05-29T11:50:00.000Z'
    const stalePayload = {...sensitivePayload, fired_at: staleTimestamp}
    const rawBody = makeRawBody(stalePayload)
    const sig = makeSignature(rawBody, staleTimestamp)
    const headers = makeHeaders(rawBody, {timestamp: staleTimestamp})
    const {client} = makeDiscordClient()
    const {logger, calls} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    assertNoLeakage(calls, sig)
  })

  it('does not log secret, repo name, rendered_text, or sig hex on replayed (reserved)', async () => {
    // #given — sig is already reserved (concurrent duplicate scenario)
    const rawBody = makeRawBody(sensitivePayload)
    const sig = makeSignature(rawBody, TIMESTAMP)
    const replayCache = createReplayCache({clock: () => NOW_MS})
    replayCache.reserve(sig)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient()
    const {logger, calls} = makeLogger()
    const deps = makeDeps(client, logger, {replayCache})

    // #when
    await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    assertNoLeakage(calls, sig)
  })

  it('does not log secret, repo name, rendered_text, or sig hex on malformed JSON', async () => {
    // #given — a raw body that contains the planted name but is invalid JSON
    const rawBody = Buffer.from(`{"repo": "${PLANTED_REPO_NAME}", broken`, 'utf8')
    const sig = makeSignature(rawBody, TIMESTAMP)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient()
    const {logger, calls} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    assertNoLeakage(calls, sig)
  })

  it('does not log secret, repo name, rendered_text, or sig hex on timestamp mismatch (step 8)', async () => {
    // #given — body fired_at != timestamp header
    const mismatchPayload = {...sensitivePayload, fired_at: '2026-05-29T12:00:01.000Z'}
    const rawBody = makeRawBody(mismatchPayload)
    const sig = makeSignature(rawBody, TIMESTAMP)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient()
    const {logger, calls} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    assertNoLeakage(calls, sig)
  })

  it('does not log secret, repo name, rendered_text, or sig hex on unknown_event_type (step 9)', async () => {
    // #given — valid HMAC but unknown event
    const unknownPayload = {
      v: 1,
      event_type: 'unknown_event',
      fired_at: TIMESTAMP,
      context: {owner: 'acme', repo: PLANTED_REPO_NAME, slug: 'setup', wiki_pages_changed: 1},
      rendered_text: PLANTED_RENDERED_TEXT,
    }
    const rawBody = makeRawBody(unknownPayload)
    const sig = makeSignature(rawBody, TIMESTAMP)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient()
    const {logger, calls} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    assertNoLeakage(calls, sig)
  })

  it('does not log secret, repo name, rendered_text, or sig hex on too-large body', async () => {
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

  it('does not log secret, repo name, rendered_text, or sig hex on rate limit', async () => {
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

  it('does not log secret, repo name, rendered_text, or sig hex on discord failure', async () => {
    // #given
    const rawBody = makeRawBody(sensitivePayload)
    const sig = makeSignature(rawBody, TIMESTAMP)
    const headers = makeHeaders(rawBody)
    const {client} = makeDiscordClient(false)
    const {logger, calls} = makeLogger()
    const deps = makeDeps(client, logger)

    // #when
    await handleAnnounce(rawBody, headers, '1.2.3.4', deps)

    // #then
    assertNoLeakage(calls, sig)
  })
})

// ---------------------------------------------------------------------------
// FIX 8: No-oracle regression — hmac_invalid, timestamp_expired, replayed
//         must all return the IDENTICAL {status, body}
// ---------------------------------------------------------------------------

describe('handleAnnounce — security: no-oracle invariant', () => {
  it('hmac_invalid, timestamp_expired, and replayed (reserved) all return identical {status,body}', async () => {
    // #given — build three requests each triggering a different auth rejection
    const rawBody = makeRawBody(validSurveyPayload)

    // 1. bad HMAC
    const badSigHeaders = makeHeaders(rawBody, {secret: 'wrong-secret'})
    const {client: c1} = makeDiscordClient()
    const {logger: l1} = makeLogger()
    const hmacResult = await handleAnnounce(rawBody, badSigHeaders, '1.2.3.4', makeDeps(c1, l1))

    // 2. stale timestamp (valid HMAC)
    const staleTimestamp = '2026-05-29T11:50:00.000Z'
    const stalePayload = {...validSurveyPayload, fired_at: staleTimestamp}
    const rawBodyStale = makeRawBody(stalePayload)
    const staleHeaders = makeHeaders(rawBodyStale, {timestamp: staleTimestamp})
    const {client: c2} = makeDiscordClient()
    const {logger: l2} = makeLogger()
    const tsResult = await handleAnnounce(rawBodyStale, staleHeaders, '1.2.3.4', makeDeps(c2, l2))

    // 3. replayed / reserved sig
    const sig = makeSignature(rawBody, TIMESTAMP)
    const replayCache = createReplayCache({clock: () => NOW_MS})
    replayCache.reserve(sig)
    const replayHeaders = makeHeaders(rawBody)
    const {client: c3} = makeDiscordClient()
    const {logger: l3} = makeLogger()
    const replayResult = await handleAnnounce(rawBody, replayHeaders, '1.2.3.4', makeDeps(c3, l3, {replayCache}))

    // #then — all three produce the IDENTICAL {status, body}
    expect(hmacResult).toEqual({status: 401, body: {error: 'unauthorized'}})
    expect(tsResult).toEqual(hmacResult)
    expect(replayResult).toEqual(hmacResult)
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
