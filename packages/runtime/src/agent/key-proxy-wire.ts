import type {Result} from '../shared/types.js'
import type {KeyProxyRoute} from './key-proxy-routes.js'
import type {KeyProxyProviderConfig} from './key-proxy.js'
import {Buffer} from 'node:buffer'
import {err, ok} from '../shared/types.js'

/**
 * What the Action and the key-proxy child say to each other.
 *
 * Action to child, on stdin: one frame (a 4-byte big-endian length, then that many bytes of UTF-8 JSON) holding the
 * provider keys and the upstream map. The pipe then stays open; closing it is the shutdown signal.
 *
 * Child to Action, on stdout: one JSON line, either `{"ready":true,"port":N}` or `{"error":"<code>"}` with a fixed code.
 * An error line never quotes input.
 */

export const KEY_PROXY_CONFIG_VERSION = 1
export const KEY_PROXY_MAX_CONFIG_BYTES = 1024 * 1024
const MAX_PROVIDERS = 64
const MAX_ROUTES_PER_PROVIDER = 64
const MAX_QUERIES_PER_ROUTE = 8

/** Exit codes of the child. Zero is a clean stop after stdin closed. */
export const KEY_PROXY_EXIT_INVALID_CONFIG = 64
export const KEY_PROXY_EXIT_START_FAILED = 65
export const KEY_PROXY_EXIT_INTERNAL = 70

export type KeyProxyChildErrorCode = 'internal' | 'invalid-config' | 'start-failed'

export interface KeyProxyWireConfig {
  readonly version: 1
  readonly providers: readonly KeyProxyProviderConfig[]
  /** Extra TLS trust for the upstream (PEM). Set only by the supervisor's test options. */
  readonly ca?: string
}

export type KeyProxyChildLine =
  | {readonly kind: 'error'; readonly code: KeyProxyChildErrorCode}
  | {readonly kind: 'invalid'}
  | {readonly kind: 'ready'; readonly port: number}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnly(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).every(name => names.includes(name))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function parseRoute(value: unknown): KeyProxyRoute | null {
  if (!isRecord(value) || !hasOnly(value, ['method', 'path', 'queries', 'auth', 'upstreamPath', 'kind'])) return null
  const {method, path, queries, auth, upstreamPath, kind} = value
  if (method !== 'GET' && method !== 'POST') return null
  if (!nonEmptyString(path) || !path.startsWith('/')) return null
  if (!nonEmptyString(upstreamPath) || !upstreamPath.startsWith('/')) return null
  if (auth !== 'bearer' && auth !== 'x-api-key') return null
  if (kind !== 'inference' && kind !== 'models') return null
  if (!Array.isArray(queries) || queries.length > MAX_QUERIES_PER_ROUTE) return null
  if (!queries.every((query): query is string => typeof query === 'string')) return null
  return {method, path, queries, auth, upstreamPath, kind}
}

function parseProvider(value: unknown): KeyProxyProviderConfig | null {
  if (!isRecord(value) || !hasOnly(value, ['id', 'key', 'origin', 'routes'])) return null
  const {id, key, origin, routes} = value
  if (!nonEmptyString(id) || !nonEmptyString(key) || !nonEmptyString(origin)) return null
  if (!Array.isArray(routes) || routes.length > MAX_ROUTES_PER_PROVIDER) return null
  const parsed = routes.map(parseRoute)
  if (parsed.includes(null)) return null
  return {id, key, origin, routes: parsed as KeyProxyRoute[]}
}

/** Validates the decoded JSON. The error is a fixed code: nothing of the input is ever quoted. */
export function parseKeyProxyConfig(value: unknown): Result<KeyProxyWireConfig, 'invalid-config'> {
  if (!isRecord(value) || !hasOnly(value, ['version', 'providers', 'ca'])) return err('invalid-config')
  if (value.version !== KEY_PROXY_CONFIG_VERSION) return err('invalid-config')
  if (!Array.isArray(value.providers) || value.providers.length > MAX_PROVIDERS) return err('invalid-config')
  const providers = value.providers.map(parseProvider)
  if (providers.includes(null)) return err('invalid-config')
  if (value.ca !== undefined && !nonEmptyString(value.ca)) return err('invalid-config')
  return ok({
    version: KEY_PROXY_CONFIG_VERSION,
    providers: providers as KeyProxyProviderConfig[],
    ...(value.ca === undefined ? {} : {ca: value.ca}),
  })
}

export function encodeKeyProxyConfig(config: KeyProxyWireConfig): Buffer {
  const payload = Buffer.from(JSON.stringify(config), 'utf8')
  if (payload.length > KEY_PROXY_MAX_CONFIG_BYTES) throw new Error('the key proxy config is too large')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length)
  return Buffer.concat([header, payload])
}

/** The payload length announced by a frame header, or null when the header is short, empty or over the bound. */
export function readKeyProxyFrameLength(header: Buffer): number | null {
  if (header.length < 4) return null
  const length = header.readUInt32BE(0)
  return length > 0 && length <= KEY_PROXY_MAX_CONFIG_BYTES ? length : null
}

export function parseKeyProxyChildLine(line: string): KeyProxyChildLine {
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
  const {error} = parsed
  if (error === 'internal' || error === 'invalid-config' || error === 'start-failed')
    return {kind: 'error', code: error}
  return {kind: 'invalid'}
}
