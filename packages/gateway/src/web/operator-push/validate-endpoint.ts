/**
 * SSRF-conservative validation for browser-supplied push subscription endpoint
 * URLs, applied before any endpoint value reaches the subscription store.
 *
 * A push endpoint is normally a push-service origin (e.g. Google FCM,
 * Mozilla autopush) chosen by the browser, not the operator. Accepting it
 * without validation would let a malicious or compromised browser register
 * an endpoint pointing at an internal service — the dispatch path (a later
 * unit) would then issue an authenticated-looking HTTPS POST to that URL.
 * This module rejects the classes of URL that would make that dangerous.
 *
 * Security invariant: the endpoint value itself must NEVER be echoed in a
 * thrown reason or a log line — only the coarse rejection class name.
 */

/** Coarse, closed set of reasons an endpoint URL was rejected. No free-form text. */
export type EndpointRejectionReason =
  'not-https' | 'loopback' | 'private-network' | 'link-local' | 'no-dot-hostname' | 'unparseable'

export interface EndpointValidationResult {
  readonly ok: boolean
  readonly reason?: EndpointRejectionReason
}

const LOOPBACK_HOSTNAMES = new Set(['localhost'])

/** Matches IPv4-literal hostnames (e.g. "127.0.0.1"). */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isIpv4Loopback(octets: readonly number[]): boolean {
  return octets[0] === 127
}

function isIpv4PrivateNetwork(octets: readonly number[]): boolean {
  const a = octets[0]
  const b = octets[1]
  if (a === 10) return true
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

function isIpv4LinkLocal(octets: readonly number[]): boolean {
  const a = octets[0]
  const b = octets[1]
  return a === 169 && b === 254
}

function classifyIpv4(hostname: string): EndpointRejectionReason | null {
  const match = IPV4_PATTERN.exec(hostname)
  if (match === null) return null
  const octets = [match[1] ?? '', match[2] ?? '', match[3] ?? '', match[4] ?? ''].map(part => Number.parseInt(part, 10))
  if (octets.some(o => Number.isNaN(o) || o > 255)) return null
  if (isIpv4Loopback(octets)) return 'loopback'
  if (isIpv4LinkLocal(octets)) return 'link-local'
  if (isIpv4PrivateNetwork(octets)) return 'private-network'
  return null
}

/**
 * Classify an IPv6 literal hostname (already bracket-stripped by URL.hostname).
 * Covers ::1 (loopback), fe80::/10 (link-local), and fc00::/7 (unique local).
 */
function classifyIpv6(hostname: string): EndpointRejectionReason | null {
  const lower = hostname.toLowerCase()
  if (lower === '::1') return 'loopback'
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return 'link-local'
  }
  // fc00::/7 covers prefixes fc00:: through fdff:: — first hex nibble 'f' with
  // second nibble 'c' or 'd'.
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'private-network'
  return null
}

/**
 * Validate a push subscription endpoint URL against an SSRF-conservative
 * allowlist posture: HTTPS-only, no loopback, no private/link-local network,
 * no bare/local hostnames.
 *
 * Never includes the endpoint value in the returned reason — callers must
 * not log the endpoint alongside the rejection.
 */
export function validateEndpointUrl(endpoint: string): EndpointValidationResult {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return {ok: false, reason: 'unparseable'}
  }

  if (url.protocol !== 'https:') {
    return {ok: false, reason: 'not-https'}
  }

  const rawHostname = url.hostname.toLowerCase()

  if (LOOPBACK_HOSTNAMES.has(rawHostname)) {
    return {ok: false, reason: 'loopback'}
  }

  // WHATWG URL.hostname keeps the brackets for an IPv6 literal (e.g. "[::1]").
  const isIpv6Literal = rawHostname.startsWith('[') && rawHostname.endsWith(']')
  const hostname = isIpv6Literal ? rawHostname.slice(1, -1) : rawHostname

  if (isIpv6Literal) {
    const reason = classifyIpv6(hostname)
    if (reason !== null) return {ok: false, reason}
  } else {
    const ipv4Reason = classifyIpv4(hostname)
    if (ipv4Reason !== null) return {ok: false, reason: ipv4Reason}
  }

  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return {ok: false, reason: 'no-dot-hostname'}
  }

  // Bare hostname / local service name — no dot at all (e.g. "workspace").
  // IPv6 literals never contain a dot check here since they already passed above.
  if (isIpv6Literal === false && hostname.includes('.') === false) {
    return {ok: false, reason: 'no-dot-hostname'}
  }

  return {ok: true}
}
