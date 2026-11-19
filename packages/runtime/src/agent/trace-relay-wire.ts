import type {Result} from '../shared/types.js'
import {Buffer} from 'node:buffer'
import * as net from 'node:net'
import {classifyReservedIpv4, classifyReservedIpv6} from '../net/ip-classification.js'
import {err, ok} from '../shared/types.js'

/**
 * What the Action and the trace-relay child say to each other, and what the relay says to the plugin.
 *
 * Action to child, on stdin: one frame (a 4-byte big-endian length, then that many bytes of UTF-8 JSON) holding the
 * collector's traces URL, its credential headers and the caps. The pipe then stays open; closing it is the stop signal.
 *
 * Child to Action, on stdout: one ready line, `{"ready":true,"port":N}` or `{"error":"<code>"}` with a fixed code, and,
 * once stdin has closed, one report line, `{"report":{"delivered":N,"retry":N,"dropped":N}}`. Nothing else, ever. An
 * error line never quotes input.
 *
 * Node-only: no Action, SDK or logger dependency, so the child entry stays small.
 */

export const TRACE_RELAY_CONFIG_VERSION = 1
export const TRACE_RELAY_MAX_CONFIG_BYTES = 64 * 1024
const MAX_HEADERS = 32
const MAX_HEADER_NAME_LENGTH = 256
const MAX_HEADER_VALUE_LENGTH = 8192

/** The one path the relay serves. The plugin's exporter posts here. */
export const TRACE_RELAY_PATH = '/v1/traces'

/**
 * The status the relay answers the sender with, and nothing else about the upstream.
 *
 * Chosen against the OTLP HTTP exporter's own rules (`@opentelemetry/otlp-exporter-base` 0.219.0,
 * `is-export-retryable.js` and `transport/http-transport-utils.js`): a status up to 299 is success; exactly 429, 502,
 * 503 and 504 are retryable, with the exporter's own backoff when no `retry-after` is present; every other status is a
 * final failure. So `delivered` is 200, `retry` is 503, and `dropped` is 422, a final failure the exporter counts as
 * dropped and does not retry. Locally refused requests (wrong path, method, type, size) use final statuses too.
 */
export const TRACE_RELAY_STATUS = {delivered: 200, retry: 503, dropped: 422} as const

/** Exit codes of the child. Zero is a clean stop after stdin closed. */
export const TRACE_RELAY_EXIT_INVALID_CONFIG = 64
export const TRACE_RELAY_EXIT_START_FAILED = 65
export const TRACE_RELAY_EXIT_INTERNAL = 70

export type TraceRelayChildErrorCode = 'internal' | 'invalid-config' | 'start-failed'

export interface TraceRelayLimits {
  readonly maxHeaderBytes: number
  /** Refused from the declared length, before any of the body is buffered. */
  readonly maxRequestBodyBytes: number
  /** Total request body bytes accepted over the relay's life. Once reached, further batches are refused. */
  readonly maxTotalBytes: number
  readonly maxConnections: number
  /** For a sender to finish its request headers. */
  readonly headersTimeoutMs: number
  /** For a sender to finish its whole request. */
  readonly requestTimeoutMs: number
  /** For the connection to the collector. */
  readonly connectTimeoutMs: number
  /** From the start of the forward to the collector's response headers. */
  readonly upstreamTimeoutMs: number
  /** How long a socket refused outside the request path stays open after the answer. */
  readonly rejectLingerMs: number
}

const LIMIT_NAMES: readonly (keyof TraceRelayLimits)[] = [
  'maxHeaderBytes',
  'maxRequestBodyBytes',
  'maxTotalBytes',
  'maxConnections',
  'headersTimeoutMs',
  'requestTimeoutMs',
  'connectTimeoutMs',
  'upstreamTimeoutMs',
  'rejectLingerMs',
]

export interface TraceRelayHeader {
  readonly name: string
  readonly value: string
}

export interface TraceRelayWireConfig {
  readonly version: 1
  /** The collector's full OTLP traces URL. Held in the child only; never logged. */
  readonly url: string
  /** The credential headers added to every forwarded batch. Held in the child only; never logged. */
  readonly headers: readonly TraceRelayHeader[]
  readonly limits?: Partial<TraceRelayLimits>
}

export interface TraceRelayBatchCounts {
  readonly delivered: number
  readonly retry: number
  readonly dropped: number
}

export type TraceRelayChildLine =
  | {readonly kind: 'error'; readonly code: TraceRelayChildErrorCode}
  | {readonly kind: 'invalid'}
  | {readonly kind: 'ready'; readonly port: number}
  | {readonly kind: 'report'; readonly counts: TraceRelayBatchCounts}

/** Headers the relay sets itself, or whose meaning is one hop. A configured header may not name one of them. */
const REFUSED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'expect',
  'content-type',
  'content-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
])

/** RFC 9110 `token`. */
const HEADER_NAME_TOKEN = /^[\w!#$%&'*+\-.^`|~]+$/

/** What Node accepts in a header value, minus tab: printable ASCII and Latin-1 above DEL. */
const HEADER_VALUE_CHARS = /^[\x20-\x7E\x80-\xFF]+$/

export function isValidTraceRelayHeaderName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_HEADER_NAME_LENGTH &&
    HEADER_NAME_TOKEN.test(name) &&
    !REFUSED_HEADER_NAMES.has(name.toLowerCase())
  )
}

/** A non-empty value of printable characters with no control character and no space at either end. */
export function isValidTraceRelayHeaderValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_HEADER_VALUE_LENGTH &&
    HEADER_VALUE_CHARS.test(value) &&
    value === value.trim()
  )
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function isMetadataHost(hostname: string): boolean {
  const bare = stripBrackets(hostname.toLowerCase())
  const normalized = bare.endsWith('.') ? bare.slice(0, -1) : bare
  if (normalized === 'metadata.google.internal') return true
  const family = net.isIP(normalized)
  if (family === 4) return classifyReservedIpv4(normalized) === 'metadata'
  if (family === 6) return classifyReservedIpv6(normalized) === 'metadata'
  return false
}

/** A literal `127.0.0.0/8` or `::1` address, as WHATWG serializes it. A name, `localhost` included, is never loopback here. */
function isLiteralLoopback(hostname: string): boolean {
  const bare = stripBrackets(hostname)
  const family = net.isIP(bare)
  if (family === 4) return bare.startsWith('127.')
  if (family === 6) return bare === '::1'
  return false
}

/**
 * The collector URL rules: `https`, or `http` only to a literal `127.0.0.0/8` or `::1` address (a loopback collector); no
 * userinfo; no fragment; not a cloud metadata host. A path and a query are allowed (the collector's route is part of the
 * URL). The error is a fixed code: the value is never quoted.
 */
export function validateTraceRelayUrl(value: string): Result<URL, 'invalid-url'> {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return err('invalid-url')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return err('invalid-url')
  if (parsed.username.length > 0 || parsed.password.length > 0) return err('invalid-url')
  if (parsed.hash.length > 0 || value.includes('#')) return err('invalid-url')
  if (parsed.hostname.length === 0) return err('invalid-url')
  if (isMetadataHost(parsed.hostname)) return err('invalid-url')
  if (parsed.protocol === 'http:' && !isLiteralLoopback(parsed.hostname)) return err('invalid-url')
  return ok(parsed)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnly(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).every(name => names.includes(name))
}

function parseHeaders(value: unknown): readonly TraceRelayHeader[] | null {
  if (!Array.isArray(value) || value.length > MAX_HEADERS) return null
  const headers: TraceRelayHeader[] = []
  const seen = new Set<string>()
  for (const entry of value as unknown[]) {
    if (!isRecord(entry) || !hasOnly(entry, ['name', 'value'])) return null
    const {name, value: headerValue} = entry
    if (typeof name !== 'string' || typeof headerValue !== 'string') return null
    if (!isValidTraceRelayHeaderName(name) || !isValidTraceRelayHeaderValue(headerValue)) return null
    const lower = name.toLowerCase()
    if (seen.has(lower)) return null
    seen.add(lower)
    headers.push({name, value: headerValue})
  }
  return headers
}

function parseLimits(value: unknown): Partial<TraceRelayLimits> | null {
  if (!isRecord(value) || !hasOnly(value, LIMIT_NAMES)) return null
  const limits: {-readonly [K in keyof TraceRelayLimits]?: number} = {}
  for (const name of LIMIT_NAMES) {
    const limit = value[name]
    if (limit === undefined) continue
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) return null
    limits[name] = limit
  }
  return limits
}

/** Validates the decoded JSON. The error is a fixed code: nothing of the input is ever quoted. */
export function parseTraceRelayConfig(value: unknown): Result<TraceRelayWireConfig, 'invalid-config'> {
  if (!isRecord(value) || !hasOnly(value, ['version', 'url', 'headers', 'limits'])) return err('invalid-config')
  if (value.version !== TRACE_RELAY_CONFIG_VERSION) return err('invalid-config')
  if (typeof value.url !== 'string' || !validateTraceRelayUrl(value.url).success) return err('invalid-config')
  const headers = parseHeaders(value.headers)
  if (headers === null) return err('invalid-config')
  const limits = value.limits === undefined ? undefined : parseLimits(value.limits)
  if (limits === null) return err('invalid-config')
  return ok({
    version: TRACE_RELAY_CONFIG_VERSION,
    url: value.url,
    headers,
    ...(limits === undefined ? {} : {limits}),
  })
}

export function encodeTraceRelayConfig(config: TraceRelayWireConfig): Buffer {
  const payload = Buffer.from(JSON.stringify(config), 'utf8')
  if (payload.length > TRACE_RELAY_MAX_CONFIG_BYTES) throw new Error('the trace relay config is too large')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length)
  return Buffer.concat([header, payload])
}

/** The payload length announced by a frame header, or null when the header is short, empty or over the bound. */
export function readTraceRelayFrameLength(header: Buffer): number | null {
  if (header.length < 4) return null
  const length = header.readUInt32BE(0)
  return length > 0 && length <= TRACE_RELAY_MAX_CONFIG_BYTES ? length : null
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function parseTraceRelayChildLine(line: string): TraceRelayChildLine {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return {kind: 'invalid'}
  }
  if (!isRecord(parsed)) return {kind: 'invalid'}
  if (parsed.ready === true && typeof parsed.port === 'number') {
    const {port} = parsed
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? {kind: 'ready', port} : {kind: 'invalid'}
  }
  const {report, error} = parsed
  if (isRecord(report)) {
    const {delivered, retry, dropped} = report
    return isCount(delivered) && isCount(retry) && isCount(dropped)
      ? {kind: 'report', counts: {delivered, retry, dropped}}
      : {kind: 'invalid'}
  }
  if (error === 'internal' || error === 'invalid-config' || error === 'start-failed')
    return {kind: 'error', code: error}
  return {kind: 'invalid'}
}
