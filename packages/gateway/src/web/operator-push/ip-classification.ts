/**
 * Pure IP-address classification shared by the two SSRF defenses on the
 * operator push endpoint path:
 *
 *   - `validate-endpoint.ts`: parse-time literal-address guard, classifying
 *     the hostname AS WRITTEN in a subscription endpoint URL.
 *   - `push-sender.ts`: connect-time guard, classifying the RESOLVED address
 *     immediately before the TLS socket connects — this is what actually
 *     closes the DNS-rebinding gap the parse-time guard cannot.
 *
 * Both call into the same classification logic here so the two layers can
 * never silently drift apart on what counts as "internal".
 */

/** Coarse, closed set of reasons an endpoint URL or resolved address was rejected. No free-form text. */
export type EndpointRejectionReason =
  'not-https' | 'loopback' | 'private-network' | 'link-local' | 'no-dot-hostname' | 'unparseable' | 'ipv6-literal'

/** Matches IPv4-literal hostnames (e.g. "127.0.0.1"). */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isIpv4Loopback(octets: readonly number[]): boolean {
  return octets[0] === 127
}

export function isIpv4PrivateNetwork(octets: readonly number[]): boolean {
  const a = octets[0]
  const b = octets[1]
  if (a === 10) return true
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

export function isIpv4LinkLocal(octets: readonly number[]): boolean {
  const a = octets[0]
  const b = octets[1]
  return a === 169 && b === 254
}

export function isIpv4Unspecified(octets: readonly number[]): boolean {
  return octets.every(o => o === 0)
}

export function classifyIpv4Octets(octets: readonly number[]): EndpointRejectionReason | null {
  if (isIpv4Unspecified(octets)) return 'loopback'
  if (isIpv4Loopback(octets)) return 'loopback'
  if (isIpv4LinkLocal(octets)) return 'link-local'
  if (isIpv4PrivateNetwork(octets)) return 'private-network'
  return null
}

export function classifyIpv4(hostname: string): EndpointRejectionReason | null {
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
 * fc00::/7 unique local, fec0::/10 deprecated site-local, ::ffff:-mapped
 * internal IPv4) get a specific reason for log granularity, but any IPv6
 * literal that isn't one of those — including a mapped PUBLIC IPv4 — still falls
 * through to the 'ipv6-literal' catch-all reject at the end — legitimate
 * push endpoints are always DNS hostnames, never IPv6 literals. Every IPv6
 * literal is therefore rejected; the function is total (never returns null).
 */
export function classifyIpv6(hostname: string): EndpointRejectionReason {
  const lower = hostname.toLowerCase()
  if (lower === '::1') return 'loopback'
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return 'loopback'
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return 'link-local'
  }
  // fc00::/7 covers prefixes fc00:: through fdff:: — first hex nibble 'f' with
  // second nibble 'c' or 'd'.
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'private-network'

  // fec0::/10 (deprecated site-local) covers prefixes fec0:: through
  // feff:: — non-overlapping with the fe80::/10 link-local check above
  // (which covers fe80-febf). Site-local is effectively internal.
  if (lower.startsWith('fec') || lower.startsWith('fed') || lower.startsWith('fee') || lower.startsWith('fef')) {
    return 'private-network'
  }

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
      // A mapped PUBLIC IPv4 (classifyIpv4 returned null) is not internal —
      // fall through to the ipv6-literal catch-all below (still rejected at
      // parse time, but no longer mislabeled as 'private-network').
    } else {
      const hexMatch = IPV6_MAPPED_HEX_TAIL_PATTERN.exec(suffix)
      if (hexMatch !== null) {
        const group0 = Number.parseInt(hexMatch[1] ?? '', 16)
        const group1 = Number.parseInt(hexMatch[2] ?? '', 16)
        if (Number.isNaN(group0) === false && Number.isNaN(group1) === false) {
          const octets = [(group0 >> 8) & 0xff, group0 & 0xff, (group1 >> 8) & 0xff, group1 & 0xff]
          const mappedReason = classifyIpv4Octets(octets)
          if (mappedReason !== null) return mappedReason
          // Same fall-through as above: a mapped public IPv4 is not
          // internal — falls through to the ipv6-literal catch-all below.
        }
      }
    }
    // ::ffff: prefix present but the suffix is not a recognizable IPv4
    // literal — fail closed as an IPv6 literal rather than let an
    // unclassified mapped address through unlabeled.
    return 'ipv6-literal'
  }

  // Fail-closed catch-all: every IPv6 literal that reaches here is not one
  // of the specifically-classified internal forms above, but is still
  // rejected — push endpoints are never IPv6 literals.
  return 'ipv6-literal'
}

/**
 * Connect-time guard: classify a RESOLVED address (from `dns.lookup`) as
 * blocked or not, immediately before the push-sender's TLS socket connects
 * to it. This is what actually defeats DNS rebinding — see push-sender.ts.
 *
 * IPv6 posture: unlike the parse-time guard (which rejects every IPv6
 * literal wholesale, since push endpoints are never written as IPv6
 * literals), a RESOLVED address can legitimately be IPv6 — a push-service
 * hostname may resolve to a public IPv6 address in practice. Blocking every
 * resolved IPv6 address would break real IPv6-reachable push relays for no
 * safety gain, so this function only blocks the classified-internal IPv6
 * forms (loopback / link-local / unique-local / IPv4-mapped-internal) via
 * `classifyIpv6`, treating anything classifyIpv6 could only reach through
 * the fail-closed 'ipv6-literal' catch-all... but that catch-all was built
 * for the "any literal is suspicious" parse-time posture, which does not
 * apply to actual DNS resolution results. So for resolved addresses we
 * derive blocked/allowed from the SPECIFIC internal classifications only
 * (loopback/private-network/link-local), not the catch-all: a resolved
 * public IPv6 address returns not-blocked.
 */
export function isBlockedResolvedAddress(address: string, family: number): boolean {
  if (family === 4) {
    const octets = address.split('.').map(part => Number.parseInt(part, 10))
    if (octets.length !== 4 || octets.some(o => Number.isNaN(o) || o > 255)) {
      // Unparseable — fail closed.
      return true
    }
    return classifyIpv4Octets(octets) !== null
  }

  if (family === 6) {
    const reason = classifyIpv6(address)
    // Only the specific internal classifications block a resolved address;
    // the 'ipv6-literal' catch-all (meant for "this literal is suspicious
    // on its face") does not apply to a real resolved IPv6 address — a
    // public IPv6 push relay must still be reachable.
    return reason === 'loopback' || reason === 'private-network' || reason === 'link-local'
  }

  // Unknown address family — fail closed.
  return true
}
