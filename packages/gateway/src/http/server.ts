/**
 * Hono HTTP server for the POST /v1/announce webhook.
 *
 * createAnnounceServer builds a Hono app, wires the announce handler, and
 * returns the @hono/node-server handle so the caller (program.ts / Unit 7)
 * can close it during graceful shutdown.
 *
 * Content-length pre-check is performed before reading the body to avoid
 * allocating memory for obviously oversized requests; the handler also
 * guards on rawBody.byteLength (authoritative).
 *
 * Mirror of apps/workspace-agent/src/server.ts for the serve()/handle pattern.
 */

import type {ServerType} from '@hono/node-server'
import type {Client} from 'discord.js'
import type {AnnounceLogger} from './announce-handler.js'
import type {RateLimiter} from './rate-limit.js'
import type {ReplayCache} from './replay-cache.js'
import {Buffer} from 'node:buffer'
import {serve} from '@hono/node-server'
import {Hono} from 'hono'
import {handleAnnounce} from './announce-handler.js'
import {createRateLimiter} from './rate-limit.js'
import {createReplayCache} from './replay-cache.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Maximum allowed Content-Length before we even read the body. */
const MAX_BODY_BYTES = 8 * 1024

export interface AnnounceServerDeps {
  readonly client: Client
  readonly logger: AnnounceLogger
  /** Optional — a default cache is created if absent. */
  readonly replayCache?: ReplayCache
  /** Optional — a default limiter is created if absent. */
  readonly rateLimiter?: RateLimiter
  /** Injectable clock for testability. */
  readonly clock?: () => number
  /**
   * Returns true when the gateway is draining (SIGTERM/SIGINT received).
   * Injected so the route can return 503 without importing shutdown.ts directly.
   * Defaults to () => false if omitted (useful in tests that don't care about drain).
   */
  readonly isShuttingDown?: () => boolean
}

export interface AnnounceServerConfig {
  readonly webhookSecret: string
  readonly presenceChannelId: string
  readonly httpPort: number
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build and start the Hono server for POST /v1/announce.
 *
 * Returns the @hono/node-server handle. Call `.close(cb)` during shutdown.
 */
export function createAnnounceServer(deps: AnnounceServerDeps, config: AnnounceServerConfig): ServerType {
  const replayCache = deps.replayCache ?? createReplayCache({clock: deps.clock})
  const rateLimiter = deps.rateLimiter ?? createRateLimiter({clock: deps.clock})
  const checkShuttingDown = deps.isShuttingDown ?? (() => false)

  const app = new Hono()

  app.post('/v1/announce', async c => {
    // Drain gate — refuse new requests during graceful shutdown
    if (checkShuttingDown() === true) {
      deps.logger.warn({reason: 'draining'}, 'announce rejected (shutting down)')
      return c.json({error: 'unavailable'}, 503)
    }

    // Content-length pre-check (fast path — avoids reading the body if obviously too large)
    const contentLengthHeader = c.req.header('content-length')
    if (contentLengthHeader !== undefined && contentLengthHeader !== null) {
      const contentLength = Number.parseInt(contentLengthHeader, 10)
      if (Number.isNaN(contentLength) === false && contentLength > MAX_BODY_BYTES) {
        deps.logger.warn({reason: 'too_large'}, 'announce rejected (content-length precheck)')
        return c.json({error: 'payload too large'}, 413)
      }
    }

    // Read exact bytes for HMAC — do NOT use c.req.json()
    const arrayBuffer = await c.req.arrayBuffer()
    const rawBody = Buffer.from(arrayBuffer)

    // Derive source key from forwarded / remote IP headers
    const forwarded = c.req.header('x-forwarded-for')
    const sourceKey = forwarded !== undefined && forwarded !== null ? forwarded.split(',')[0]?.trim() : undefined

    const result = await handleAnnounce(
      rawBody,
      {
        get: (name: string) => c.req.header(name) ?? null,
      },
      sourceKey,
      {
        client: deps.client,
        logger: deps.logger,
        webhookSecret: config.webhookSecret,
        presenceChannelId: config.presenceChannelId,
        rateLimiter,
        replayCache,
        clock: deps.clock,
      },
    )

    return c.json(result.body, result.status as Parameters<typeof c.json>[1])
  })

  app.notFound(c => c.json({error: 'not-found'}, 404))

  return serve({fetch: app.fetch, port: config.httpPort})
}
