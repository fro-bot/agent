import type {ClientRequest, IncomingMessage, Server, ServerResponse} from 'node:http'
import type {Duplex} from 'node:stream'
import type {Result} from '../shared/types.js'
import type {
  TraceRelayBatchCounts,
  TraceRelayHeader,
  TraceRelayLimits,
  TraceRelayPluginCounts,
} from './trace-relay-wire.js'
import {Buffer} from 'node:buffer'
import http from 'node:http'
import https from 'node:https'
import {err, ok} from '../shared/types.js'
import {isForwardableTarget} from './forwardable-target.js'
import {
  parseTraceRelayCountsHeader,
  resolveTraceRelayUpstreamPort,
  TRACE_RELAY_COUNTS_HEADER,
  TRACE_RELAY_PATH,
  TRACE_RELAY_STATUS,
  validateTraceRelayUrl,
} from './trace-relay-wire.js'

/**
 * The trace relay: a loopback HTTP server that holds the collector credential and forwards each OpenTelemetry trace
 * batch the plugin posts to it, unchanged, to the one configured collector URL. It is stateless: no queue, no retry, no
 * span decoding. It answers the sender with one fixed status for what happened (see `TRACE_RELAY_STATUS`) and counts
 * batches by outcome; the sender's exporter owns retries.
 *
 * Node-only, and deliberately given no logger: it never logs, because nothing request-derived, and neither the URL nor a
 * header, may reach a log.
 *
 * SECURITY INVARIANTS:
 * 1. A request is forwarded only when its target is canonical origin-form, its method is `POST` and its path is exactly
 *    `TRACE_RELAY_PATH` with no query. Everything else, `CONNECT` and upgrades included, is answered locally and sends
 *    nothing upstream. The upstream is always the configured URL; the sender's path, `Host` header and body never choose it.
 * 2. The proxy does not authenticate its local callers. No sender header is forwarded except the content type (protobuf or
 *    JSON, normalized) and the content encoding (gzip only); the configured credential headers are set from the config.
 *    One sender header is read and never forwarded: the plugin's span counts (`TRACE_RELAY_COUNTS_HEADER`). Only a value
 *    of exactly the fixed numeric form is kept, as numbers; the last valid one wins, and anything else is ignored.
 * 3. A 3xx from the upstream is never followed, nor passed on. An upstream 101 (Upgrade) is never followed either.
 * 4. Nothing of the upstream's response reaches the sender but the fixed status: no body, no header. A `retry-after` is
 *    never forwarded, so the collector cannot stall the sender's exporter.
 * 5. Request size is refused from the declared length before anything is buffered, a total per run is enforced, and slow
 *    senders and a slow collector are cut off by timeouts. Upstream requests in flight are capped on their own, and so is
 *    the number of batches per run, because an empty batch costs no bytes and a sender that disconnects frees its inbound
 *    connection while its forward runs on. A batch past either cap is refused locally with the final dropped status (a
 *    retryable one would be sent again), and a forward whose sender went away is aborted.
 * 6. The request goes out through `https.request` (or `http.request` for a loopback collector), never `fetch`.
 */

export interface StartTraceRelayOptions {
  /** The collector's full traces URL. Validated here again, so a caller that skipped the wire parse cannot bypass the rules. */
  readonly url: string
  readonly headers: readonly TraceRelayHeader[]
  readonly limits?: Partial<TraceRelayLimits>
  /** Extra TLS trust for an https collector, PEM. Tests only: it is not part of the wire frame. */
  readonly ca?: string
}

export interface TraceRelayServer {
  readonly port: number
  readonly address: '127.0.0.1'
  /** Batches answered so far, by outcome. */
  readonly counts: () => TraceRelayBatchCounts
  /** The last valid span totals the plugin sent in the counts header, or null if it never sent one. Untrusted. */
  readonly pluginCounts: () => TraceRelayPluginCounts | null
  /** Stops accepting, destroys every connection and aborts every forward. Resolves with the final counts. */
  readonly close: () => Promise<TraceRelayBatchCounts>
}

export const DEFAULT_TRACE_RELAY_LIMITS: TraceRelayLimits = {
  maxHeaderBytes: 16 * 1024,
  maxRequestBodyBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxConnections: 32,
  maxConcurrentForwards: 8,
  // At one batch a second a six-hour run sends about 22,000; this stops a zero-byte flood the byte caps cannot see.
  maxBatches: 50_000,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  connectTimeoutMs: 5000,
  // Shorter than the sender exporter's own 10 s timeout, so the sender hears "retry" from here rather than timing out.
  upstreamTimeoutMs: 8000,
  rejectLingerMs: 100,
}

const LOOPBACK = '127.0.0.1'

/** Longest `close` waits for cut-off forwards to be counted. They settle within ticks; this only bounds a bug. */
const CLOSE_SETTLE_BOUND_MS = 1000

/** Longest a refused socket may take to flush its answer before it is destroyed. */
const REJECT_FLUSH_BOUND_MS = 2000

type Outcome = keyof typeof TRACE_RELAY_STATUS

/** The content types a sender may use. Compared on the media type alone, case-insensitively, without parameters. */
const ACCEPTED_MEDIA_TYPES: ReadonlySet<string> = new Set(['application/x-protobuf', 'application/json'])

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value
}

function mediaTypeOf(value: string | string[] | undefined): string | undefined {
  const raw = headerValue(value)
  if (raw === undefined) return undefined
  const type = (raw.split(';')[0] ?? '').trim().toLowerCase()
  return ACCEPTED_MEDIA_TYPES.has(type) ? type : undefined
}

/** `identity` (or none) is `null`; `gzip` is `gzip`; anything else, a list included, is not accepted. */
function encodingOf(value: string | string[] | undefined): 'gzip' | 'refused' | null {
  const raw = headerValue(value)
  if (raw === undefined) return null
  const encoding = raw.trim().toLowerCase()
  if (encoding === '' || encoding === 'identity') return null
  return encoding === 'gzip' ? 'gzip' : 'refused'
}

function classifyUpstreamStatus(status: number): Outcome {
  if (status >= 200 && status < 300) return 'delivered'
  if (status === 429 || status >= 500) return 'retry'
  // Everything else is final: 4xx, and any 3xx, which is never followed.
  return 'dropped'
}

export async function startTraceRelay(options: StartTraceRelayOptions): Promise<Result<TraceRelayServer, string>> {
  const limits: TraceRelayLimits = {...DEFAULT_TRACE_RELAY_LIMITS, ...options.limits}
  const validated = validateTraceRelayUrl(options.url)
  if (!validated.success) return err('the collector URL is not allowed')
  const upstreamUrl = validated.data
  const useTls = upstreamUrl.protocol === 'https:'
  // A plain-http collector does not prove who it is, so no credential goes to it: refused before anything is bound.
  if (!useTls && options.headers.length > 0) return err('the collector URL does not allow a credential over plain http')
  const transport = useTls ? https : http
  const upstreamHost = upstreamUrl.hostname.startsWith('[') ? upstreamUrl.hostname.slice(1, -1) : upstreamUrl.hostname
  const upstreamPort = resolveTraceRelayUpstreamPort(upstreamUrl)
  const upstreamPath = `${upstreamUrl.pathname}${upstreamUrl.search}`
  const credentialHeaders: http.OutgoingHttpHeaders = {}
  for (const header of options.headers) credentialHeaders[header.name] = header.value

  const agent = useTls
    ? new https.Agent({
        keepAlive: false,
        rejectUnauthorized: true,
        ...(options.ca === undefined ? {} : {ca: options.ca}),
      })
    : new http.Agent({keepAlive: false})
  const inflight = new Set<ClientRequest>()
  const counts = {delivered: 0, retry: 0, dropped: 0}
  let totalBytes = 0
  let pluginCounts: TraceRelayPluginCounts | null = null
  // Forwards running, forwards ever started, and who is waiting for the running ones to finish (close).
  let activeForwards = 0
  let forwardsStarted = 0
  const idleWaiters: (() => void)[] = []
  let closed: Promise<TraceRelayBatchCounts> | undefined

  const snapshot = (): TraceRelayBatchCounts => ({...counts})

  /** Answers locally: a final status, an empty body, and the connection closed. Counted as dropped when it refuses a batch. */
  const refuse = (res: ServerResponse, status: number, batch: boolean): void => {
    if (batch) counts.dropped++
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(status, {'content-length': 0, connection: 'close'})
    res.end()
  }

  const answer = (res: ServerResponse, outcome: Outcome): void => {
    counts[outcome]++
    if (res.headersSent || res.destroyed) return
    res.writeHead(TRACE_RELAY_STATUS[outcome], {'content-length': 0})
    res.end()
  }

  /** Sends one batch to the collector and says how it went. Never rejects. */
  const forward = async (
    body: Buffer,
    mediaType: string,
    encoding: 'gzip' | null,
    senderGone: AbortSignal,
  ): Promise<Outcome> =>
    new Promise<Outcome>(resolve => {
      if (senderGone.aborted) {
        resolve('retry')
        return
      }
      let settled = false
      let connectTimer: ReturnType<typeof setTimeout> | undefined
      let upstreamTimer: ReturnType<typeof setTimeout> | undefined
      let request: ClientRequest | undefined
      const settle = (outcome: Outcome): void => {
        if (settled) return
        settled = true
        if (connectTimer !== undefined) clearTimeout(connectTimer)
        if (upstreamTimer !== undefined) clearTimeout(upstreamTimer)
        resolve(outcome)
      }
      const abandon = (outcome: Outcome): void => {
        settle(outcome)
        request?.destroy()
      }

      // The configured credential goes first and carries only names the config parser allowed; the relay's own framing
      // follows, so nothing a sender sent is in this object at all.
      const headers: http.OutgoingHttpHeaders = {
        ...credentialHeaders,
        host: upstreamUrl.host,
        'content-type': mediaType,
        'content-length': body.length,
      }
      if (encoding !== null) headers['content-encoding'] = encoding

      request = transport.request({
        agent,
        hostname: upstreamHost,
        port: upstreamPort,
        method: 'POST',
        path: upstreamPath,
        headers,
      })
      inflight.add(request)
      const started = request
      // A sender that went away before the answer takes its upstream request with it: nothing is waiting for the result.
      senderGone.addEventListener('abort', () => abandon('retry'), {once: true})
      started.once('close', () => inflight.delete(started))
      connectTimer = setTimeout(() => abandon('retry'), limits.connectTimeoutMs)
      upstreamTimer = setTimeout(() => abandon('retry'), limits.upstreamTimeoutMs)
      started.once('socket', socket => {
        const connected = (): void => {
          if (connectTimer !== undefined) clearTimeout(connectTimer)
        }
        if (socket.connecting) socket.once(useTls ? 'secureConnect' : 'connect', connected)
        else connected()
      })
      started.on('error', () => abandon('retry'))
      started.once('upgrade', (_response, socket) => {
        // A 101 never comes through `response`. Nothing is tunnelled: the socket is closed and the batch is dropped.
        socket.destroy()
        abandon('dropped')
      })
      started.once('response', upstreamResponse => {
        // Only the status is read. The body is never read, kept or passed on; the connection is closed.
        upstreamResponse.on('error', () => undefined)
        const outcome = classifyUpstreamStatus(upstreamResponse.statusCode ?? 0)
        upstreamResponse.destroy()
        abandon(outcome)
      })
      started.end(body)
    })

  const atForwardLimit = (): boolean =>
    forwardsStarted >= limits.maxBatches || activeForwards >= limits.maxConcurrentForwards

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers.upgrade !== undefined) return refuse(res, 404, false)

    let onRoute = false
    const forwardable = isForwardableTarget(req.method, req.url, (method, path, query) => {
      onRoute = path === TRACE_RELAY_PATH && query === ''
      return onRoute && method === 'POST'
    })
    if (!forwardable) return refuse(res, onRoute ? 405 : 404, false)

    // From here on this is a batch: a refusal below counts as a dropped one.
    // The plugin's running totals: the last valid value wins, and any other value is ignored, never a reason to refuse.
    pluginCounts = parseTraceRelayCountsHeader(req.headers[TRACE_RELAY_COUNTS_HEADER]) ?? pluginCounts
    // Past a cap the batch is refused before anything of it is buffered. 422, not 503: the exporter retries a 503 up to five
    // times, which would turn overload into more load.
    if (atForwardLimit()) return refuse(res, TRACE_RELAY_STATUS.dropped, true)
    const mediaType = mediaTypeOf(req.headers['content-type'])
    const encoding = encodingOf(req.headers['content-encoding'])
    if (mediaType === undefined || encoding === 'refused') return refuse(res, 415, true)

    const declared = req.headers['content-length']
    if (declared !== undefined && !/^\d{1,15}$/.test(declared)) return refuse(res, 400, true)
    const declaredBytes = declared === undefined ? 0 : Number(declared)
    const tooLarge = (): void => {
      req.unpipe()
      req.pause()
      refuse(res, 413, true)
      res.once('finish', () => req.socket.destroy())
    }
    if (declaredBytes > limits.maxRequestBodyBytes || totalBytes + declaredBytes > limits.maxTotalBytes) {
      return tooLarge()
    }

    const chunks: Buffer[] = []
    let received = 0
    let refused = false
    req.on('data', (chunk: Buffer) => {
      if (refused) return
      received += chunk.length
      totalBytes += chunk.length
      if (received > limits.maxRequestBodyBytes || totalBytes > limits.maxTotalBytes) {
        refused = true
        chunks.length = 0
        tooLarge()
        return
      }
      chunks.push(chunk)
    })
    req.once('end', () => {
      if (refused) return
      // The check above ran when the headers arrived; other batches may have started forwarding while this body was read.
      if (atForwardLimit()) {
        answer(res, 'dropped')
        return
      }
      // The sender may have disconnected while its body was read, or may do so any time before the answer.
      const senderGone = new AbortController()
      if (res.destroyed) senderGone.abort()
      res.once('close', () => {
        if (!res.writableFinished) senderGone.abort()
      })
      activeForwards++
      forwardsStarted++
      forward(Buffer.concat(chunks), mediaType, encoding, senderGone.signal)
        .then(
          outcome => answer(res, outcome),
          () => answer(res, 'retry'),
        )
        .finally(() => {
          activeForwards--
          if (activeForwards === 0) for (const wake of idleWaiters.splice(0)) wake()
        })
    })
    // A sender that goes away mid-body has sent no batch; its socket error must not become an uncaught exception.
    req.on('error', () => undefined)
  }

  const server: Server = http.createServer(
    {
      maxHeaderSize: limits.maxHeaderBytes,
      // Node checks header and request timeouts on this interval; the default 30 s would outlast a short timeout.
      connectionsCheckingInterval: Math.max(50, Math.min(30_000, Math.floor(limits.headersTimeoutMs / 4))),
    },
    (req, res) => {
      try {
        handle(req, res)
      } catch {
        // A bug must not take the relay down, and must not echo anything about the request.
        refuse(res, 500, false)
      }
    },
  )
  server.maxConnections = limits.maxConnections
  server.requestTimeout = limits.requestTimeoutMs
  server.headersTimeout = Math.min(limits.headersTimeoutMs, limits.requestTimeoutMs)
  server.keepAliveTimeout = 5000
  server.timeout = 0

  // Sockets Node hands over for CONNECT, Upgrade and malformed requests are detached from the HTTP server: it removes its
  // own error handler and no longer counts them for `closeAllConnections`. They are tracked here instead.
  const detached = new Set<Duplex>()

  /**
   * Answers a refused socket and closes it. An error handler goes on first, because a reset after the answer would
   * otherwise be an uncaught exception. The answer is flushed, the socket lingers briefly so the client can read it, then
   * it is destroyed: a client that keeps its write half open cannot hold a connection slot.
   */
  const endSocket = (socket: Duplex, status: number, reason: string): void => {
    socket.on('error', () => undefined)
    if (socket.destroyed || !socket.writable) {
      socket.destroy()
      return
    }
    detached.add(socket)
    const timers: ReturnType<typeof setTimeout>[] = []
    const destroy = (): void => {
      socket.destroy()
    }
    timers.push(setTimeout(destroy, limits.rejectLingerMs + REJECT_FLUSH_BOUND_MS))
    socket.once('finish', () => timers.push(setTimeout(destroy, limits.rejectLingerMs)))
    socket.once('close', () => {
      detached.delete(socket)
      for (const timer of timers) clearTimeout(timer)
    })
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }
  server.on('clientError', (error: NodeJS.ErrnoException, socket) => {
    if (error.code === 'HPE_HEADER_OVERFLOW') endSocket(socket, 431, 'Request Header Fields Too Large')
    else endSocket(socket, 400, 'Bad Request')
  })
  server.on('connect', (_req, socket) => endSocket(socket, 405, 'Method Not Allowed'))
  server.on('upgrade', (_req, socket) => endSocket(socket, 404, 'Not Found'))
  server.on('checkContinue', (_req, res) => refuse(res, 417, false))
  server.on('checkExpectation', (_req, res) => refuse(res, 417, false))

  const listening = await new Promise<Result<number, string>>(resolve => {
    server.once('error', () => resolve(err('the trace relay could not listen on the loopback address')))
    server.listen(0, LOOPBACK, () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? ok(address.port) : err('no listening address'))
    })
  })
  if (!listening.success) {
    agent.destroy()
    return err(listening.error)
  }
  server.removeAllListeners('error')
  // A late socket error must not become an uncaught exception.
  server.on('error', () => undefined)

  return ok({
    port: listening.data,
    address: LOOPBACK,
    counts: snapshot,
    pluginCounts: () => pluginCounts,
    // One close: a second call gets the first's promise, so nobody reports counts before the cut-off forwards are in them.
    close: async () => {
      closed ??= (async () => {
        for (const request of inflight) request.destroy()
        for (const socket of detached) socket.destroy()
        agent.destroy()
        await new Promise<void>(resolve => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
        // Destroyed forwards settle as retry on the next ticks; wait for them to be counted, bounded in case one never does.
        if (activeForwards > 0) {
          let bound: ReturnType<typeof setTimeout> | undefined
          await Promise.race([
            new Promise<void>(resolve => idleWaiters.push(resolve)),
            new Promise<void>(resolve => {
              bound = setTimeout(resolve, CLOSE_SETTLE_BOUND_MS)
            }),
          ])
          clearTimeout(bound)
        }
        return snapshot()
      })()
      return closed
    },
  })
}
