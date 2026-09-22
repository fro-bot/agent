/**
 * Internal canonical IPv4/IPv6 address parsing, formatting, and equality —
 * the single parser shared by socket-address normalization, X-Forwarded-For
 * entry parsing, and configured trusted-proxy address parsing (see
 * `resolve-client.ts` and `trusted-proxy-address.ts`). Not part of the
 * ingress module's public surface; import only from within
 * `packages/gateway/src/web/ingress/`.
 *
 * Deliberately NOT `web/operator-push/ip-classification.ts`. That module
 * classifies DESTINATION reachability (internal vs public network) for SSRF
 * defense on outbound push requests. This module establishes CANONICAL
 * IDENTITY for trust-boundary / equality comparison on INBOUND client
 * addresses — a different question with different correctness properties
 * (e.g. it must treat an IPv4 address and its IPv4-mapped-IPv6 form as
 * identical, which ip-classification.ts has no reason to do).
 */

/**
 * Numeric identity of a parsed address. IPv4-mapped IPv6 forms (`::ffff:a.b.c.d`
 * and their hex-tail equivalents) are normalized to the `'ipv4'` variant during
 * parsing, so two textually different spellings of the same client compare equal.
 */
export type CanonicalAddress =
  | {readonly family: 'ipv4'; readonly octets: readonly [number, number, number, number]}
  | {
      readonly family: 'ipv6'
      readonly groups: readonly [number, number, number, number, number, number, number, number]
    }

const HEX_GROUP_PATTERN = /^[0-9a-f]{1,4}$/i
// Exactly four decimal octets, each either the literal "0" or a nonzero digit
// followed by up to two more digits — rejects leading-zero forms ("01"),
// shortened forms ("1.2.3"), and non-decimal forms by construction.
const STRICT_IPV4_PATTERN = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/
const SURROUNDING_SPACE_TAB = /^[ \t]+|[ \t]+$/g
// eslint-disable-next-line no-control-regex -- deliberately scanning for embedded whitespace/control characters to reject them
const EMBEDDED_WS_OR_CONTROL_PATTERN = /[\s\x00-\x1F\x7F]/

/** Trims surrounding space/tab only, then rejects embedded whitespace or control characters. */
function normalizeToken(raw: string): string | undefined {
  const trimmed = raw.replaceAll(SURROUNDING_SPACE_TAB, '')
  if (trimmed === '') return undefined
  if (EMBEDDED_WS_OR_CONTROL_PATTERN.test(trimmed)) return undefined
  return trimmed
}

function parseStrictIpv4(token: string): readonly [number, number, number, number] | undefined {
  const match = STRICT_IPV4_PATTERN.exec(token)
  if (match === null) return undefined
  const octets = [match[1], match[2], match[3], match[4]].map(part => Number.parseInt(part ?? '', 10))
  if (octets.some(octet => octet > 255)) return undefined
  return octets as [number, number, number, number]
}

/**
 * Splits an IPv6 half (the text to one side of `::`, or the whole address when
 * there is no compression) into 16-bit group values. The final piece may be a
 * dotted-decimal IPv4 tail (RFC 4291 mixed notation), which is converted to
 * two hex groups. Returns `undefined` on any malformed piece.
 */
function parseGroupSequence(part: string): number[] | undefined {
  if (part === '') return []
  const pieces = part.split(':')
  if (pieces.includes('')) return undefined
  const last = pieces.at(-1) ?? ''
  if (last.includes('.')) {
    const ipv4 = parseStrictIpv4(last)
    if (ipv4 === undefined) return undefined
    const hexPieces = pieces.slice(0, -1)
    if (hexPieces.some(piece => HEX_GROUP_PATTERN.test(piece) === false)) return undefined
    const hexGroups = hexPieces.map(piece => Number.parseInt(piece, 16))
    const ipv4Groups = [(ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]]
    return [...hexGroups, ...ipv4Groups]
  }
  if (pieces.some(piece => HEX_GROUP_PATTERN.test(piece) === false)) return undefined
  return pieces.map(piece => Number.parseInt(piece, 16))
}

function splitOnDoubleColon(token: string): readonly [string, string] {
  const index = token.indexOf('::')
  return [token.slice(0, index), token.slice(index + 2)]
}

/** Parses a bracket-free IPv6 token (may embed a trailing IPv4 dotted quad) into 8 numeric groups. */
function parseIpv6Groups(
  token: string,
): readonly [number, number, number, number, number, number, number, number] | undefined {
  const doubleColonCount = token.split('::').length - 1
  if (doubleColonCount > 1) return undefined
  const compressed = doubleColonCount === 1

  if (compressed === false) {
    const groups = parseGroupSequence(token)
    if (groups === undefined || groups.length !== 8) return undefined
    return groups as [number, number, number, number, number, number, number, number]
  }

  const [headRaw, tailRaw] = splitOnDoubleColon(token)
  const head = parseGroupSequence(headRaw)
  const tail = parseGroupSequence(tailRaw)
  if (head === undefined || tail === undefined) return undefined
  const knownLength = head.length + tail.length
  // '::' must stand in for at least one 16-bit zero group — reject if the
  // explicit groups already account for all 8 (ambiguous / non-canonical).
  if (knownLength >= 8) return undefined
  const zeroFill = Array.from({length: 8 - knownLength}).fill(0)
  const full = [...head, ...zeroFill, ...tail]
  return full as [number, number, number, number, number, number, number, number]
}

function toCanonicalFromGroups(
  groups: readonly [number, number, number, number, number, number, number, number],
): CanonicalAddress {
  // IPv4-mapped IPv6 range (::ffff:0:0/96): the leading five groups are zero
  // and the sixth is 0xffff, regardless of whether the address was written in
  // compressed hex-tail form (::ffff:7f00:1) or expanded dotted form
  // (::ffff:127.0.0.1) — both reach this same 8-group numeric shape.
  const isMapped =
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff
  if (isMapped) {
    const high = groups[6]
    const low = groups[7]
    const octets: [number, number, number, number] = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff]
    return {family: 'ipv4', octets}
  }
  return {family: 'ipv6', groups}
}

/** Strips a single matched `[...]` bracket pair, rejecting stray brackets and any trailing content (e.g. `:port`). */
function stripBrackets(token: string): {readonly inner: string; readonly hadBrackets: boolean} | undefined {
  if (token.startsWith('[')) {
    const closeIndex = token.indexOf(']')
    if (closeIndex === -1) return undefined
    const inner = token.slice(1, closeIndex)
    const rest = token.slice(closeIndex + 1)
    if (rest !== '') return undefined
    return {inner, hadBrackets: true}
  }
  if (token.includes('[') || token.includes(']')) return undefined
  return {inner: token, hadBrackets: false}
}

/**
 * Parses a single address token (socket address, one X-Forwarded-For entry,
 * or one configured trusted-proxy address) into its canonical numeric
 * identity, or `undefined` if the token is not a valid, unambiguous address.
 *
 * Rejects: shortened/hex/leading-zero IPv4, ports on either family,
 * bracketed IPv4, zone identifiers (including encoded forms), embedded
 * whitespace/control characters, hostnames, and any other non-address token
 * (e.g. `unknown`, `for=...`, CIDR).
 */
export function parseCanonicalAddress(raw: string): CanonicalAddress | undefined {
  const normalized = normalizeToken(raw)
  if (normalized === undefined) return undefined
  // Zone identifiers ("%eth0") and their percent-encoded spelling ("%25eth0")
  // both contain a literal '%' character — reject outright rather than
  // attempt to strip them silently.
  if (normalized.includes('%')) return undefined

  const bracketResult = stripBrackets(normalized)
  if (bracketResult === undefined) return undefined
  const {inner, hadBrackets} = bracketResult

  if (hadBrackets) {
    // Bracketed content is always IPv6-only — a bracketed IPv4 literal
    // ("[1.2.3.4]") has no colon and therefore fails IPv6 group parsing
    // below, which correctly rejects it without a separate special case.
    const groups = parseIpv6Groups(inner)
    if (groups === undefined) return undefined
    return toCanonicalFromGroups(groups)
  }

  if (inner.includes(':')) {
    const groups = parseIpv6Groups(inner)
    if (groups === undefined) return undefined
    return toCanonicalFromGroups(groups)
  }

  const octets = parseStrictIpv4(inner)
  if (octets === undefined) return undefined
  return {family: 'ipv4', octets}
}

/**
 * Canonical string form: IPv4 as dotted decimal, native and mapped IPv6 as
 * eight lowercase four-digit hex groups (no `::` compression — unnecessary
 * for an internal comparison/log key).
 */
export function canonicalAddressToString(address: CanonicalAddress): string {
  if (address.family === 'ipv4') return address.octets.join('.')
  return address.groups.map(group => group.toString(16).padStart(4, '0')).join(':')
}

/** Numeric-identity equality — never compares raw strings. */
export function canonicalAddressEquals(a: CanonicalAddress, b: CanonicalAddress): boolean {
  if (a.family === 'ipv4' && b.family === 'ipv4') {
    return (
      a.octets[0] === b.octets[0] &&
      a.octets[1] === b.octets[1] &&
      a.octets[2] === b.octets[2] &&
      a.octets[3] === b.octets[3]
    )
  }
  if (a.family === 'ipv6' && b.family === 'ipv6') {
    return a.groups.every((group, index) => group === b.groups[index])
  }
  return false
}
