/**
 * Integration tests for the Hono announce server.
 *
 * Spins up a real HTTP server on a random port per test group.
 * Mocks the Discord client to avoid real API calls.
 *
 * Uses BDD comments (#given, #when, #then).
 */

import type {AddressInfo} from 'node:net'

import type {Client} from 'discord.js'

import type {AnnounceLogger} from './announce-handler.js'
import {Buffer} from 'node:buffer'
import {createHmac} from 'node:crypto'
import http, {createServer} from 'node:http'

import {describe, expect, it, vi} from 'vitest'

import {createReplayCache} from './replay-cache.js'
import {createAnnounceServer} from './server.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SECRET = 'integration-test-secret'
const CHANNEL_ID = 'presence-channel-999'
const NOW_MS = new Date('2026-05-29T12:00:00.000Z').getTime()
const TIMESTAMP = '2026-05-29T12:00:00.000Z'

function makeRawBody(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload), 'utf8')
}

function makeSignature(rawBody: Buffer, timestamp: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(timestamp).update('.').update(rawBody).digest('hex')
}

function makeLogger(): AnnounceLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

/** Make a mock discord.js Client. sendMock is returned for assertions. */
function makeDiscordClient(succeed = true): {client: Client; sendMock: ReturnType<typeof vi.fn>} {
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
  const client = {channels: {fetch: fetchMock}} as unknown as Client
  return {client, sendMock}
}

/** Find a free port by briefly opening a server. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port
      s.close(err => {
        if (err !== undefined && err !== null) {
          reject(err)
        } else {
          resolve(port)
        }
      })
    })
  })
}

/** Post to the announce endpoint. */
async function postAnnounce(
  port: number,
  rawBody: Buffer,
  extraHeaders: Record<string, string> = {},
): Promise<{status: number; body: unknown}> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/announce`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(rawBody.byteLength),
      ...extraHeaders,
    },
    body: rawBody,
  })
  const body = await res.json()
  return {status: res.status, body}
}

const validSurveyPayload = {
  v: 1,
  event_type: 'survey_completed',
  fired_at: TIMESTAMP,
  context: {owner: 'acme', repo: 'alpha', slug: 'setup', wiki_pages_changed: 3},
  rendered_text: null,
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('POST /v1/announce — happy path', () => {
  it('returns 200 {ok:true} and posts to the correct Discord channel', async () => {
    // #given
    const port = await findFreePort()
    const {client, sendMock} = makeDiscordClient(true)
    const logger = makeLogger()

    const server = createAnnounceServer(
      {client, logger, clock: () => NOW_MS},
      {webhookSecret: SECRET, presenceChannelId: CHANNEL_ID, httpPort: port},
    )

    const rawBody = makeRawBody(validSurveyPayload)
    const sig = makeSignature(rawBody, TIMESTAMP)

    try {
      // #when
      const {status, body} = await postAnnounce(port, rawBody, {
        'x-gateway-signature': sig,
        'x-gateway-timestamp': TIMESTAMP,
      })

      // #then
      expect(status).toBe(200)
      expect(body).toEqual({ok: true})
      const embedMatcher = expect.objectContaining({
        description: expect.any(String) as unknown as string,
        color: expect.any(Number) as unknown as number,
      }) as unknown
      expect(sendMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          embeds: [embedMatcher] as unknown[],
          allowedMentions: {parse: []},
        }),
      )
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('POST /v1/announce — bad signature → 401', () => {
  it('returns 401 {error:"unauthorized"} for wrong HMAC', async () => {
    // #given
    const port = await findFreePort()
    const {client} = makeDiscordClient()
    const logger = makeLogger()

    const server = createAnnounceServer(
      {client, logger, clock: () => NOW_MS},
      {webhookSecret: SECRET, presenceChannelId: CHANNEL_ID, httpPort: port},
    )

    const rawBody = makeRawBody(validSurveyPayload)
    const badSig = makeSignature(rawBody, TIMESTAMP, 'wrong-secret')

    try {
      // #when
      const {status, body} = await postAnnounce(port, rawBody, {
        'x-gateway-signature': badSig,
        'x-gateway-timestamp': TIMESTAMP,
      })

      // #then
      expect(status).toBe(401)
      expect(body).toEqual({error: 'unauthorized'})
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('POST /v1/announce — stale timestamp → 401 (same body as bad-sig)', () => {
  it('returns 401 {error:"unauthorized"} for a timestamp outside the 5-min window', async () => {
    // #given — clock is 10 minutes ahead of payload timestamp
    const staleTimestamp = '2026-05-29T11:50:00.000Z'
    const stalePayload = {...validSurveyPayload, fired_at: staleTimestamp}
    const rawBody = makeRawBody(stalePayload)
    const sig = makeSignature(rawBody, staleTimestamp)

    const port = await findFreePort()
    const {client} = makeDiscordClient()
    const logger = makeLogger()

    const server = createAnnounceServer(
      {client, logger, clock: () => NOW_MS},
      {webhookSecret: SECRET, presenceChannelId: CHANNEL_ID, httpPort: port},
    )

    try {
      // #when
      const {status, body} = await postAnnounce(port, rawBody, {
        'x-gateway-signature': sig,
        'x-gateway-timestamp': staleTimestamp,
      })

      // #then — same body as bad-sig (no oracle)
      expect(status).toBe(401)
      expect(body).toEqual({error: 'unauthorized'})
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('POST /v1/announce — replay → 401', () => {
  it('returns 401 for a replayed (exact same) request after success', async () => {
    // #given — pre-seed replay cache
    const rawBody = makeRawBody(validSurveyPayload)
    const sig = makeSignature(rawBody, TIMESTAMP)
    const replayCache = createReplayCache({clock: () => NOW_MS})
    replayCache.record(sig, NOW_MS)

    const port = await findFreePort()
    const {client} = makeDiscordClient()
    const logger = makeLogger()

    const server = createAnnounceServer(
      {client, logger, replayCache, clock: () => NOW_MS},
      {webhookSecret: SECRET, presenceChannelId: CHANNEL_ID, httpPort: port},
    )

    try {
      // #when
      const {status, body} = await postAnnounce(port, rawBody, {
        'x-gateway-signature': sig,
        'x-gateway-timestamp': TIMESTAMP,
      })

      // #then
      expect(status).toBe(401)
      expect(body).toEqual({error: 'unauthorized'})
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('POST /v1/announce — unknown event_type → 400', () => {
  it('returns 400 {error:"bad request"} for an unrecognized event type', async () => {
    // #given
    const payload = {...validSurveyPayload, event_type: 'unknown_event'}
    const rawBody = makeRawBody(payload)
    const sig = makeSignature(rawBody, TIMESTAMP)

    const port = await findFreePort()
    const {client} = makeDiscordClient()
    const logger = makeLogger()

    const server = createAnnounceServer(
      {client, logger, clock: () => NOW_MS},
      {webhookSecret: SECRET, presenceChannelId: CHANNEL_ID, httpPort: port},
    )

    try {
      // #when
      const {status, body} = await postAnnounce(port, rawBody, {
        'x-gateway-signature': sig,
        'x-gateway-timestamp': TIMESTAMP,
      })

      // #then
      expect(status).toBe(400)
      expect(body).toEqual({error: 'bad request'})
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('POST /v1/announce — malformed JSON → 400', () => {
  it('returns 400 {error:"bad request"} when body is not valid JSON', async () => {
    // #given
    const rawBody = Buffer.from('not-json!', 'utf8')
    const sig = makeSignature(rawBody, TIMESTAMP)

    const port = await findFreePort()
    const {client} = makeDiscordClient()
    const logger = makeLogger()

    const server = createAnnounceServer(
      {client, logger, clock: () => NOW_MS},
      {webhookSecret: SECRET, presenceChannelId: CHANNEL_ID, httpPort: port},
    )

    try {
      // #when
      const {status, body} = await postAnnounce(port, rawBody, {
        'x-gateway-signature': sig,
        'x-gateway-timestamp': TIMESTAMP,
      })

      // #then
      expect(status).toBe(400)
      expect(body).toEqual({error: 'bad request'})
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('POST /v1/announce — missing headers → 400', () => {
  it('returns 400 when X-Gateway-Signature is missing', async () => {
    // #given
    const rawBody = makeRawBody(validSurveyPayload)

    const port = await findFreePort()
    const {client} = makeDiscordClient()
    const logger = makeLogger()

    const server = createAnnounceServer(
      {client, logger, clock: () => NOW_MS},
      {webhookSecret: SECRET, presenceChannelId: CHANNEL_ID, httpPort: port},
    )

    try {
      // #when — only send timestamp, no signature
      const {status, body} = await postAnnounce(port, rawBody, {
        'x-gateway-timestamp': TIMESTAMP,
      })

      // #then
      expect(status).toBe(400)
      expect(body).toEqual({error: 'bad request'})
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('POST /v1/announce — oversized body → 413', () => {
  it('returns 413 when Content-Length header declares > 8 KB (raw http precheck)', async () => {
    // #given — use node:http directly so we can send a lying content-length header
    // fetch enforces content-length accuracy, so we use http.request instead.
    const port = await findFreePort()
    const {client} = makeDiscordClient()
    const logger = makeLogger()

    const server = createAnnounceServer(
      {client, logger, clock: () => NOW_MS},
      {webhookSecret: SECRET, presenceChannelId: CHANNEL_ID, httpPort: port},
    )

    try {
      // #when — declare 8193 bytes but only send 100 bytes
      const {status, json} = await new Promise<{status: number; json: unknown}>((resolve, reject) => {
        const req = http.request(
          {hostname: '127.0.0.1', port, path: '/v1/announce', method: 'POST'},
          (res: http.IncomingMessage) => {
            let data = ''
            res.on('data', (chunk: string) => {
              data += chunk
            })
            res.on('end', () => {
              try {
                resolve({status: res.statusCode ?? 0, json: JSON.parse(data)})
              } catch (error) {
                reject(error)
              }
            })
          },
        )
        req.on('error', reject)
        req.setHeader('content-type', 'application/json')
        req.setHeader('content-length', '8193')
        req.setHeader('x-gateway-signature', 'fake')
        req.setHeader('x-gateway-timestamp', TIMESTAMP)
        // Only send 100 bytes — server sees the content-length header (8193) before reading body
        req.end(Buffer.alloc(100, 0x41))
      })

      // #then — content-length precheck fires before body read
      expect(status).toBe(413)
      expect(json).toEqual({error: 'payload too large'})
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('returns 413 when actual body exceeds 8 KB', async () => {
    // #given — actually send > 8 KB
    const rawBody = Buffer.alloc(8193, 0x41)
    const sig = makeSignature(rawBody, TIMESTAMP)

    const port = await findFreePort()
    const {client} = makeDiscordClient()
    const logger = makeLogger()

    const server = createAnnounceServer(
      {client, logger, clock: () => NOW_MS},
      {webhookSecret: SECRET, presenceChannelId: CHANNEL_ID, httpPort: port},
    )

    try {
      // #when
      const res = await fetch(`http://127.0.0.1:${port}/v1/announce`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gateway-signature': sig,
          'x-gateway-timestamp': TIMESTAMP,
        },
        body: rawBody,
      })
      const body = await res.json()

      // #then
      expect(res.status).toBe(413)
      expect(body).toEqual({error: 'payload too large'})
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('POST /v1/announce — rate limited → 429', () => {
  it('returns 429 when rate limiter is exhausted', async () => {
    // #given — rate limiter that always denies
    const rawBody = makeRawBody(validSurveyPayload)
    const sig = makeSignature(rawBody, TIMESTAMP)
    const rateLimiter = {allow: () => false}

    const port = await findFreePort()
    const {client} = makeDiscordClient()
    const logger = makeLogger()

    const server = createAnnounceServer(
      {client, logger, rateLimiter, clock: () => NOW_MS},
      {webhookSecret: SECRET, presenceChannelId: CHANNEL_ID, httpPort: port},
    )

    try {
      // #when
      const {status, body} = await postAnnounce(port, rawBody, {
        'x-gateway-signature': sig,
        'x-gateway-timestamp': TIMESTAMP,
      })

      // #then
      expect(status).toBe(429)
      expect(body).toEqual({error: 'rate limited'})
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('POST /v1/announce — Discord failure → 5xx', () => {
  it('returns 500 {error:"internal error"} when Discord post fails', async () => {
    // #given
    const rawBody = makeRawBody(validSurveyPayload)
    const sig = makeSignature(rawBody, TIMESTAMP)

    const port = await findFreePort()
    const {client} = makeDiscordClient(false)
    const logger = makeLogger()

    const server = createAnnounceServer(
      {client, logger, clock: () => NOW_MS},
      {webhookSecret: SECRET, presenceChannelId: CHANNEL_ID, httpPort: port},
    )

    try {
      // #when
      const {status, body} = await postAnnounce(port, rawBody, {
        'x-gateway-signature': sig,
        'x-gateway-timestamp': TIMESTAMP,
      })

      // #then
      expect(status).toBe(500)
      expect(body).toEqual({error: 'internal error'})
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
