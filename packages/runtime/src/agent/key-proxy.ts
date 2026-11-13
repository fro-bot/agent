import type {ClientRequest, IncomingHttpHeaders, IncomingMessage, Server, ServerResponse} from 'node:http'
import type {Duplex} from 'node:stream'
import type {Logger} from '../shared/logger.js'
import type {Result} from '../shared/types.js'
import type {KeyProxyRoute} from './key-proxy-routes.js'
import {Buffer} from 'node:buffer'
import {createHash, timingSafeEqual} from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import {Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {validateUpstreamUrl} from '../object-store/validation.js'
import {err, ok} from '../shared/types.js'
import {isForwardableTarget} from './forwardable-target.js'
import {matchKeyProxyRoute} from './key-proxy-routes.js'

/**
 * The key proxy: a loopback HTTP server that holds provider API keys and attaches one to a model request on its way to
 * the provider's fixed HTTPS upstream. The sandboxed server and its tools see only a per-run placeholder.
 *
 * Node-only: no Action, SDK or logger dependency beyond the injected `Logger`, so the child entry stays small.
 *
 * SECURITY INVARIANTS:
 * 1. A request is forwarded only when its target is canonical origin-form, its first segment is a configured provider id
 *    (a `Map` lookup), and its method, path and query are one of that provider's routes. Everything else is answered
 *    locally and sends nothing upstream.
 * 2. The credential header the route's protocol uses must carry the run's placeholder, compared with `timingSafeEqual`
 *    over fixed-size digests. No other client credential header is forwarded, and the real credential is set last.
 * 3. Outbound headers are built from a short allowlist. Hop-by-hop headers, and any header named in `Connection`, are
 *    dropped. `accept-encoding` is always `identity`.
 * 4. A 3xx from the upstream is never followed and never passed on: the client gets a local 502.
 * 5. A non-2xx body is forwarded only when it is uncompressed and within the bound, with every exact occurrence of the key
 *    (raw and JSON-escaped) replaced. Any other non-2xx body becomes a fixed generic error with the same status.
 * 6. Response headers come from a short allowlist. Local error bodies are fixed text and never name the upstream.
 * 7. Nothing request-derived, and no key, is ever logged.
 * 8. Malformed or oversized input gets an error; the server keeps serving.
 */

export interface KeyProxyProviderConfig {
  /** The path prefix: requests arrive as `/<id>/...`. */
  readonly id: string
  /** The real credential. Held in this process only. */
  readonly key: string
  /** `https://host[:port]`, no path. */
  readonly origin: string
  readonly routes: readonly KeyProxyRoute[]
}

export interface KeyProxyLimits {
  readonly maxHeaderBytes: number
  readonly maxRequestBodyBytes: number
  /** The largest non-2xx upstream body that is read, redacted and forwarded. */
  readonly maxErrorBodyBytes: number
  readonly maxConnections: number
  readonly connectTimeoutMs: number
  /** From the end of the request to the upstream response headers. */
  readonly headersTimeoutMs: number
  /** Between upstream body chunks. A quiet reasoning stream is not cut off before this. */
  readonly idleTimeoutMs: number
  /** For the client to finish sending its request. */
  readonly requestTimeoutMs: number
}

export const DEFAULT_KEY_PROXY_LIMITS: KeyProxyLimits = {
  maxHeaderBytes: 16 * 1024,
  maxRequestBodyBytes: 64 * 1024 * 1024,
  maxErrorBodyBytes: 256 * 1024,
  maxConnections: 64,
  connectTimeoutMs: 30_000,
  headersTimeoutMs: 10 * 60_000,
  idleTimeoutMs: 10 * 60_000,
  requestTimeoutMs: 5 * 60_000,
}

export interface StartKeyProxyOptions {
  /** A per-run secret of at least 32 characters. Accepted in the protocol's credential header. */
  readonly placeholder: string
  readonly providers: readonly KeyProxyProviderConfig[]
  readonly logger: Logger
  /** Extra TLS trust for the upstream, PEM. Tests only: the supervisor sets it only through its own test options. */
  readonly ca?: string
  readonly limits?: Partial<KeyProxyLimits>
}

export interface KeyProxyServer {
  readonly port: number
  readonly address: '127.0.0.1'
  /** Stops accepting, destroys every connection and aborts every upstream request. */
  readonly close: () => Promise<void>
}

const LOOPBACK = '127.0.0.1'
const MIN_PLACEHOLDER_LENGTH = 32
const REDACTED = '[REDACTED]'

const LOCAL_BODIES: Readonly<Record<number, string>> = {
  400: 'Bad Request\n',
  401: 'Unauthorized\n',
  404: 'Not Found\n',
  405: 'Method Not Allowed\n',
  413: 'Payload Too Large\n',
  417: 'Expectation Failed\n',
  431: 'Request Header Fields Too Large\n',
  500: 'Internal Server Error\n',
  502: 'Bad Gateway\n',
  504: 'Gateway Timeout\n',
}

/** The body of a non-2xx upstream response that is not forwarded as received. Fixed text. */
const GENERIC_UPSTREAM_ERROR = JSON.stringify({
  error: {type: 'proxy_error', message: 'The upstream returned an error.'},
})

/** Client headers that are copied to the upstream. Everything else, credentials included, is dropped. */
const FORWARDED_REQUEST_HEADERS: readonly string[] = [
  'accept',
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'openai-beta',
  'user-agent',
]

/** Upstream response headers passed to the client on a 2xx. */
const SUCCESS_RESPONSE_HEADERS: readonly string[] = [
  'cache-control',
  'content-encoding',
  'content-length',
  'content-type',
]

/** Upstream response headers passed to the client on a non-2xx whose body is forwarded. */
const ERROR_RESPONSE_HEADERS: readonly string[] = ['content-type', 'retry-after', 'retry-after-ms']

/** Headers that only describe one hop. Named by RFC 9110 §7.6.1 and its relatives. */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

interface ProviderState {
  readonly id: string
  readonly key: string
  readonly hostname: string
  readonly port: number
  readonly host: string
  readonly routes: readonly KeyProxyRoute[]
  /** The key as it appears in a body: raw UTF-8, then JSON-escaped when that differs. */
  readonly secrets: readonly Buffer[]
}

interface MatchedRoute {
  readonly provider: ProviderState
  readonly route: KeyProxyRoute
  readonly query: string
}

/** Set on the byte counter when the request body outgrows the bound. */
const REQUEST_TOO_LARGE = new Error('request body too large')

function digestOf(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function countRawHeader(rawHeaders: readonly string[], name: string): number {
  let count = 0
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count += 1
  }
  return count
}

function replaceAll(source: Buffer, needle: Buffer, replacement: Buffer): Buffer {
  if (needle.length === 0) return source
  const parts: Buffer[] = []
  let from = 0
  for (;;) {
    const at = source.indexOf(needle, from)
    if (at === -1) break
    parts.push(source.subarray(from, at), replacement)
    from = at + needle.length
  }
  if (parts.length === 0) return source
  parts.push(source.subarray(from))
  return Buffer.concat(parts)
}

function secretsFor(key: string): Buffer[] {
  const raw = Buffer.from(key, 'utf8')
  const escaped = Buffer.from(JSON.stringify(key).slice(1, -1), 'utf8')
  return raw.equals(escaped) ? [raw] : [raw, escaped]
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value
}

/** Names the client nominated in `Connection`: those are hop-specific for this request and must not be forwarded. */
function nominatedHeaders(headers: IncomingHttpHeaders): ReadonlySet<string> {
  const connection = headerValue(headers.connection)
  if (connection === undefined) return new Set()
  return new Set(
    connection
      .split(',')
      .map(token => token.trim().toLowerCase())
      .filter(token => token.length > 0),
  )
}

function parseOrigin(origin: string): {readonly hostname: string; readonly port: number; readonly host: string} | null {
  const validated = validateUpstreamUrl(origin)
  if (!validated.success) return null
  const url = validated.data
  if (url.pathname !== '/' || url.origin !== origin) return null
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  return {hostname, port: url.port === '' ? 443 : Number(url.port), host: url.host}
}

function buildProviders(providers: readonly KeyProxyProviderConfig[]): Result<Map<string, ProviderState>, string> {
  const states = new Map<string, ProviderState>()
  for (const provider of providers) {
    if (provider.id.length === 0 || provider.id.includes('/') || states.has(provider.id)) {
      return err('a provider id is empty, contains a slash or is repeated')
    }
    if (provider.key.length === 0) return err(`provider "${provider.id}" has no key`)
    const origin = parseOrigin(provider.origin)
    if (origin === null) return err(`provider "${provider.id}" has an upstream that is not a plain https origin`)
    states.set(provider.id, {
      id: provider.id,
      key: provider.key,
      ...origin,
      routes: provider.routes,
      secrets: secretsFor(provider.key),
    })
  }
  return ok(states)
}

export async function startKeyProxy(options: StartKeyProxyOptions): Promise<Result<KeyProxyServer, string>> {
  const {logger} = options
  const limits: KeyProxyLimits = {...DEFAULT_KEY_PROXY_LIMITS, ...options.limits}
  if (options.placeholder.length < MIN_PLACEHOLDER_LENGTH) {
    return err(`the placeholder must be at least ${MIN_PLACEHOLDER_LENGTH} characters`)
  }
  const providers = buildProviders(options.providers)
  if (!providers.success) return err(providers.error)
  const byId = providers.data

  const placeholderDigest = digestOf(options.placeholder)
  const agent = new https.Agent({
    keepAlive: false,
    rejectUnauthorized: true,
    ...(options.ca === undefined ? {} : {ca: options.ca}),
  })
  const inflight = new Set<ClientRequest>()
  let closing = false

  const refuse = (res: ServerResponse, status: number, category: string, provider?: string): void => {
    logger.debug('key-proxy: request answered locally', {
      category,
      status,
      ...(provider === undefined ? {} : {provider}),
    })
    if (res.headersSent) {
      res.destroy()
      return
    }
    const body = LOCAL_BODIES[status] ?? LOCAL_BODIES[500] ?? ''
    res.writeHead(status, {'content-type': 'text/plain', 'content-length': Buffer.byteLength(body)})
    res.end(body)
  }

  const resolveRoute = (method: string, path: string, query: string): MatchedRoute | undefined => {
    // `/<id>/<rest>`: the id is looked up in a Map, so `constructor` and `__proto__` are plain misses.
    const segments = path.split('/')
    const id = segments[1]
    if (id === undefined || segments.length < 3) return undefined
    const provider = byId.get(id)
    if (provider === undefined) return undefined
    const route = matchKeyProxyRoute(provider.routes, method, `/${segments.slice(2).join('/')}`, query)
    return route === undefined ? undefined : {provider, route, query}
  }

  const presentedCredential = (req: IncomingMessage, route: KeyProxyRoute): string | undefined => {
    if (route.auth === 'x-api-key') {
      if (countRawHeader(req.rawHeaders, 'x-api-key') !== 1) return undefined
      return headerValue(req.headers['x-api-key'])
    }
    if (countRawHeader(req.rawHeaders, 'authorization') !== 1) return undefined
    const match = /^Bearer (\S+)$/.exec(headerValue(req.headers.authorization) ?? '')
    return match?.[1]
  }

  const isAuthorized = (req: IncomingMessage, route: KeyProxyRoute): boolean => {
    const presented = presentedCredential(req, route)
    if (presented === undefined) return false
    return timingSafeEqual(digestOf(presented), placeholderDigest)
  }

  const outboundHeaders = (req: IncomingMessage, matched: MatchedRoute, hasBody: boolean): http.OutgoingHttpHeaders => {
    const nominated = nominatedHeaders(req.headers)
    const headers: http.OutgoingHttpHeaders = {}
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = headerValue(req.headers[name])
      if (value === undefined || HOP_BY_HOP.has(name) || nominated.has(name)) continue
      headers[name] = value
    }
    if (hasBody && req.headers['content-length'] !== undefined)
      headers['content-length'] = req.headers['content-length']
    headers.host = matched.provider.host
    headers['accept-encoding'] = 'identity'
    // The real credential goes on last, so nothing above can override it.
    if (matched.route.auth === 'x-api-key') {
      headers['x-api-key'] = matched.provider.key
      headers['anthropic-version'] ??= '2023-06-01'
    } else {
      headers.authorization = `Bearer ${matched.provider.key}`
    }
    return headers
  }

  const pickHeaders = (source: IncomingHttpHeaders, names: readonly string[]): http.OutgoingHttpHeaders => {
    const picked: http.OutgoingHttpHeaders = {}
    for (const name of names) {
      const value = source[name]
      if (value !== undefined) picked[name] = value
    }
    return picked
  }

  /** Reads a non-2xx body whole, redacts the key and forwards it; or replaces it with the fixed generic error. */
  const forwardError = (
    upstreamRes: IncomingMessage,
    status: number,
    provider: ProviderState,
    res: ServerResponse,
    stop: () => void,
  ): void => {
    const generic = (category: string): void => {
      upstreamRes.destroy()
      stop()
      logger.warning('key-proxy: upstream error replaced', {category, status, provider: provider.id})
      const headers = pickHeaders(upstreamRes.headers, ['retry-after', 'retry-after-ms'])
      res.writeHead(status, {
        ...headers,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(GENERIC_UPSTREAM_ERROR),
      })
      res.end(GENERIC_UPSTREAM_ERROR)
    }

    const encoding = headerValue(upstreamRes.headers['content-encoding'])?.trim().toLowerCase()
    if (encoding !== undefined && encoding !== '' && encoding !== 'identity') return generic('compressed')
    const declared = Number(upstreamRes.headers['content-length'] ?? 0)
    if (declared > limits.maxErrorBodyBytes) return generic('oversized')

    const chunks: Buffer[] = []
    let total = 0
    let overflowed = false
    upstreamRes.on('data', (chunk: Buffer) => {
      if (overflowed) return
      total += chunk.length
      if (total > limits.maxErrorBodyBytes) {
        overflowed = true
        chunks.length = 0
        generic('oversized')
        return
      }
      chunks.push(chunk)
    })
    upstreamRes.once('error', () => {
      if (overflowed || res.headersSent) return
      stop()
      refuse(res, 502, 'upstream-error', provider.id)
    })
    upstreamRes.once('end', () => {
      if (overflowed || res.headersSent) return
      stop()
      let body: Buffer = Buffer.concat(chunks)
      for (const secret of provider.secrets) body = replaceAll(body, secret, Buffer.from(REDACTED))
      res.writeHead(status, {
        ...pickHeaders(upstreamRes.headers, ERROR_RESPONSE_HEADERS),
        'content-length': body.length,
      })
      res.end(body)
    })
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers.expect !== undefined) return refuse(res, 417, 'expect')
    if (req.headers.upgrade !== undefined) return refuse(res, 404, 'upgrade')

    const found: {route?: MatchedRoute} = {}
    const forwardable = isForwardableTarget(req.method, req.url, (method, path, query) => {
      found.route = resolveRoute(method, path, query)
      return found.route !== undefined
    })
    if (!forwardable || found.route === undefined) return refuse(res, 404, 'route')
    const target = found.route
    if (!isAuthorized(req, target.route)) return refuse(res, 401, 'credential', target.provider.id)

    const declared = req.headers['content-length']
    const declaredBytes = declared === undefined ? 0 : Number(declared)
    if (declaredBytes > limits.maxRequestBodyBytes) {
      res.setHeader('connection', 'close')
      return refuse(res, 413, 'body-too-large', target.provider.id)
    }
    const hasBody = declaredBytes > 0 || req.headers['transfer-encoding'] !== undefined

    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let activeUpstream: ClientRequest | undefined
    const arm = (ms: number, category: 'connect' | 'headers' | 'idle'): void => {
      if (settled) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        logger.warning('key-proxy: upstream timed out', {category, provider: target.provider.id})
        activeUpstream?.destroy()
        if (res.headersSent) res.destroy()
        else refuse(res, 504, 'upstream-timeout', target.provider.id)
      }, ms)
    }
    const stop = (): void => {
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }

    const upstream = https.request({
      agent,
      hostname: target.provider.hostname,
      port: target.provider.port,
      method: req.method,
      path: target.query === '' ? target.route.upstreamPath : `${target.route.upstreamPath}?${target.query}`,
      headers: outboundHeaders(req, target, hasBody),
    })
    activeUpstream = upstream
    inflight.add(upstream)
    upstream.once('close', () => {
      inflight.delete(upstream)
      stop()
    })
    arm(limits.connectTimeoutMs, 'connect')
    upstream.once('socket', socket => {
      const connected = (): void => arm(limits.headersTimeoutMs, 'headers')
      if (socket.connecting) socket.once('secureConnect', connected)
      else connected()
    })

    res.once('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })

    let failed = false
    upstream.on('error', () => {
      if (failed) return
      failed = true
      req.unpipe()
      req.resume()
      if (res.headersSent) {
        res.destroy()
        return
      }
      stop()
      logger.warning('key-proxy: upstream request failed', {category: 'upstream-error', provider: target.provider.id})
      refuse(res, 502, 'upstream-error', target.provider.id)
    })

    upstream.once('response', upstreamRes => {
      arm(limits.idleTimeoutMs, 'idle')
      upstreamRes.on('data', () => arm(limits.idleTimeoutMs, 'idle'))
      const status = upstreamRes.statusCode ?? 502
      if (status >= 300 && status < 400) {
        // A redirect is never followed and never passed on: its Location could name any host.
        upstreamRes.destroy()
        stop()
        logger.warning('key-proxy: upstream redirect refused', {category: 'redirect', provider: target.provider.id})
        refuse(res, 502, 'redirect', target.provider.id)
        return
      }
      if (status >= 400) {
        forwardError(upstreamRes, status, target.provider, res, stop)
        return
      }
      res.writeHead(status, pickHeaders(upstreamRes.headers, SUCCESS_RESPONSE_HEADERS))
      pipeline(upstreamRes, res)
        .catch(() => {
          // The upstream died or the client left. The head is out, so the only honest ending is an aborted stream.
          upstream.destroy()
          res.destroy()
        })
        .finally(stop)
    })

    if (!hasBody) {
      upstream.end()
      return
    }
    let received = 0
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        if (received > limits.maxRequestBodyBytes) callback(REQUEST_TOO_LARGE)
        else callback(null, chunk)
      },
    })
    counter.once('error', () => {
      req.unpipe()
      upstream.destroy()
      if (res.headersSent) return
      stop()
      res.setHeader('connection', 'close')
      refuse(res, 413, 'body-too-large', target.provider.id)
      res.once('finish', () => req.socket.destroy())
    })
    // `pipe`, not `pipeline`: a failure upstream must not destroy the client request, whose socket carries the answer.
    req.pipe(counter).pipe(upstream)
    upstream.once('finish', () => arm(limits.headersTimeoutMs, 'headers'))
  }

  const server: Server = http.createServer({maxHeaderSize: limits.maxHeaderBytes}, (req, res) => {
    try {
      handle(req, res)
    } catch {
      // A bug must not take the proxy down, and must not echo anything about the request.
      refuse(res, 500, 'internal')
    }
  })
  server.maxConnections = limits.maxConnections
  server.requestTimeout = limits.requestTimeoutMs
  server.headersTimeout = Math.min(30_000, limits.requestTimeoutMs)
  server.keepAliveTimeout = 60_000
  server.timeout = 0

  const endSocket = (socket: Duplex, status: number): void => {
    if (socket.destroyed || !socket.writable) {
      socket.destroy()
      return
    }
    const body = LOCAL_BODIES[status] ?? ''
    socket.end(`HTTP/1.1 ${status} ${body.trim()}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }
  server.on('clientError', (error: NodeJS.ErrnoException, socket) => {
    endSocket(socket, error.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400)
  })
  server.on('connect', (_req, socket) => endSocket(socket, 405))
  server.on('upgrade', (_req, socket) => endSocket(socket, 404))
  server.on('checkContinue', (_req, res) => refuse(res, 417, 'expect'))
  server.on('checkExpectation', (_req, res) => refuse(res, 417, 'expect'))

  const listening = await new Promise<Result<number, string>>(resolve => {
    server.once('error', () => resolve(err('the key proxy could not listen on the loopback address')))
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

  logger.info('key-proxy: listening', {providers: [...byId.keys()]})
  return ok({
    port: listening.data,
    address: LOOPBACK,
    close: async () => {
      if (closing) return
      closing = true
      for (const request of inflight) request.destroy()
      agent.destroy()
      await new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  })
}
