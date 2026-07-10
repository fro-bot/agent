/**
 * SSRF-conservative validation for browser-supplied push subscription endpoint
 * URLs, applied before any endpoint value reaches the subscription store.
 *
 * A push endpoint is normally a push-service origin (e.g. Google FCM,
 * Mozilla autopush) chosen by the browser, not the operator. Accepting it
 * without validation would let a malicious or compromised browser register
 * an endpoint pointing at an internal service — the dispatch path would
 * then issue an authenticated-looking HTTPS POST to that URL. This module
 * rejects the classes of URL that would make that dangerous.
 *
 * Architectural boundary: this is a parse-time literal-address guard. It
 * classifies the hostname as written in the URL and cannot defend against
 * DNS rebinding, where a hostname resolves to a public IP at validation
 * time and to a private or metadata IP at fetch/dispatch time. The push
 * dispatch path must additionally validate the resolved IP at connect time
 * to close that gap; this module only stops literal-address bypasses.
 *
 * IPv6 posture: IPv6 literals are rejected wholesale — push service
 * endpoints are DNS hostnames, so any IPv6 literal is treated as an SSRF
 * risk and denied; specific internal forms are still classified for
 * logging granularity.
 *
 * Security invariant: the endpoint value itself must NEVER be echoed in a
 * thrown reason or a log line — only the coarse rejection class name.
 */

/** Coarse, closed set of reasons an endpoint URL was rejected. No free-form text. */
export type EndpointRejectionReason =
  'not-https' | 'loopback' | 'private-network' | 'link-local' | 'no-dot-hostname' | 'unparseable' | 'ipv6-literal'

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

function isIpv4Unspecified(octets: readonly number[]): boolean {
  return octets.every(o => o === 0)
}

function classifyIpv4Octets(octets: readonly number[]): EndpointRejectionReason | null {
  if (isIpv4Unspecified(octets)) return 'loopback'
  if (isIpv4Loopback(octets)) return 'loopback'
  if (isIpv4LinkLocal(octets)) return 'link-local'
  if (isIpv4PrivateNetwork(octets)) return 'private-network'
  return null
}

function classifyIpv4(hostname: string): EndpointRejectionReason | null {
  const match = IPV4_PATTERN.exec(hostname)
  if (match === null) return null
  const octets = [match[1] ?? '', match[2] ?? '', match[3] ?? '', match[4] ?? ''].map(part => Number.parseInt(part, 10))
  if (octets.some(o => Number.isNaN(o) || o > 255)) return null
  return classifyIpv4Octets(octets)
}

/** Matches a two-hex-group IPv6 tail, e.g. the "7f00:1" in "::ffff:7f00:1". */
const IPV6_MAPPED_HEX_TAIL_PATTERN = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/

/**
 * Classify an IPv6 literal hostname (already bracket-stripped by URL.hostname).
 * Fail-closed: known internal forms (::1 loopback, fe80::/10 link-local,
 * fc00::/7 unique local, ::ffff:-mapped IPv4) get a specific reason for log
 * granularity, but any IPv6 literal that isn't one of those still falls
 * through to the 'ipv6-literal' catch-all reject at the end — legitimate
 * push endpoints are always DNS hostnames, never IPv6 literals. Every IPv6
 * literal is therefore rejected; the function is total (never returns null).
 */
function classifyIpv6(hostname: string): EndpointRejectionReason {
  const lower = hostname.toLowerCase()
  if (lower === '::1') return 'loopback'
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return 'loopback'
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return 'link-local'
  }
  // fc00::/7 covers prefixes fc00:: through fdff:: — first hex nibble 'f' with
  // second nibble 'c' or 'd'.
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'private-network'

  // IPv4-mapped IPv6 (::ffff:a.b.c.d). WHATWG URL normalizes the dotted form
  // to a hex-compressed tail (e.g. "::ffff:127.0.0.1" -> "::ffff:7f00:1"), so
  // both the dotted and hex forms must be decoded and classified as IPv4.
  const mappedPrefix = '::ffff:'
  if (lower.startsWith(mappedPrefix)) {
    const suffix = lower.slice(mappedPrefix.length)
    if (suffix.includes('.')) {
      if (IPV4_PATTERN.test(suffix) === false) return 'private-network'
      const mappedReason = classifyIpv4(suffix)
      if (mappedReason !== null) return mappedReason
      // A mapped PUBLIC IPv4 (classifyIpv4 returned null) is still an IPv6
      // literal — fall through to the catch-all reject below rather than
      // accept it.
    } else {
      const hexMatch = IPV6_MAPPED_HEX_TAIL_PATTERN.exec(suffix)
      if (hexMatch !== null) {
        const group0 = Number.parseInt(hexMatch[1] ?? '', 16)
        const group1 = Number.parseInt(hexMatch[2] ?? '', 16)
        if (Number.isNaN(group0) === false && Number.isNaN(group1) === false) {
          const octets = [(group0 >> 8) & 0xff, group0 & 0xff, (group1 >> 8) & 0xff, group1 & 0xff]
          const mappedReason = classifyIpv4Octets(octets)
          if (mappedReason !== null) return mappedReason
          // Same fall-through as above: a mapped public IPv4 is still
          // rejected as an IPv6 literal by the catch-all below.
        }
      }
    }
    // ::ffff: prefix present but the suffix is not a recognizable IPv4
    // literal, or resolved to a public IPv4 — fail closed rather than let
    // an unclassified or mapped-public address through.
    return 'private-network'
  }

  // Fail-closed catch-all: every IPv6 literal that reaches here is not one
  // of the specifically-classified internal forms above, but is still
  // rejected — push endpoints are never IPv6 literals.
  return 'ipv6-literal'
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
    // Every IPv6 literal is rejected — classifyIpv6 is total.
    return {ok: false, reason: classifyIpv6(hostname)}
  }
  const ipv4Reason = classifyIpv4(hostname)
  if (ipv4Reason !== null) return {ok: false, reason: ipv4Reason}

  // A trailing dot is a valid FQDN root marker ("foo.internal.") that Node
  // fetch still resolves, but it defeats a naive suffix/no-dot check. Strip
  // it before those checks — never before IP literal parsing above, since
  // IP literals don't carry a trailing dot.
  const normalizedHostname = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname

  if (normalizedHostname.endsWith('.local') || normalizedHostname.endsWith('.internal')) {
    return {ok: false, reason: 'no-dot-hostname'}
  }

  // Bare hostname / local service name — no dot at all (e.g. "workspace").
  // IPv6 literals already returned above, so only DNS-style hosts reach here.
  if (normalizedHostname.includes('.') === false) {
    return {ok: false, reason: 'no-dot-hostname'}
  }

  return {ok: true}
}
