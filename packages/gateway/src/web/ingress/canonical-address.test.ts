import {describe, expect, it} from 'vitest'

import {canonicalAddressEquals, canonicalAddressToString, parseCanonicalAddress} from './canonical-address.js'

describe('parseCanonicalAddress — IPv4', () => {
  // #given a well-formed dotted-decimal IPv4 address
  // #when parsed
  // #then it round-trips to the same canonical string
  it('accepts a well-formed IPv4 address', () => {
    const parsed = parseCanonicalAddress('203.0.113.7')
    expect(parsed).toBeDefined()
    expect(canonicalAddressToString(parsed!)).toBe('203.0.113.7')
  })

  // #given a shortened IPv4 form
  // #when parsed
  // #then it is rejected
  it('rejects a shortened IPv4 form', () => {
    expect(parseCanonicalAddress('192.168.1')).toBeUndefined()
  })

  // #given an integer-form IPv4 address
  // #when parsed
  // #then it is rejected
  it('rejects an integer-form IPv4 address', () => {
    expect(parseCanonicalAddress('3232235521')).toBeUndefined()
  })

  // #given a hex-octet IPv4 address
  // #when parsed
  // #then it is rejected
  it('rejects a hex-octet IPv4 address', () => {
    expect(parseCanonicalAddress('0xC0.0xA8.0x01.0x01')).toBeUndefined()
  })

  // #given a leading-zero IPv4 octet
  // #when parsed
  // #then it is rejected
  it('rejects a leading-zero IPv4 octet', () => {
    expect(parseCanonicalAddress('192.168.001.1')).toBeUndefined()
  })

  // #given an out-of-range octet
  // #when parsed
  // #then it is rejected
  it('rejects an out-of-range octet', () => {
    expect(parseCanonicalAddress('192.168.1.256')).toBeUndefined()
  })

  // #given an IPv4 address with a port suffix
  // #when parsed
  // #then it is rejected
  it('rejects IPv4:port', () => {
    expect(parseCanonicalAddress('203.0.113.7:8080')).toBeUndefined()
  })
})

describe('parseCanonicalAddress — IPv6', () => {
  // #given a fully expanded IPv6 address
  // #when parsed
  // #then it normalizes to lowercase four-digit groups
  it('accepts and normalizes a fully expanded IPv6 address', () => {
    const parsed = parseCanonicalAddress('2001:0DB8:0000:0000:0000:0000:0000:0001')
    expect(parsed).toBeDefined()
    expect(canonicalAddressToString(parsed!)).toBe('2001:0db8:0000:0000:0000:0000:0000:0001')
  })

  // #given a compressed IPv6 address
  // #when parsed
  // #then it expands to the same canonical value as the fully expanded form
  it('normalizes compression to match the expanded form', () => {
    const compressed = parseCanonicalAddress('2001:db8::1')
    const expanded = parseCanonicalAddress('2001:0db8:0000:0000:0000:0000:0000:0001')
    expect(compressed).toBeDefined()
    expect(expanded).toBeDefined()
    expect(canonicalAddressEquals(compressed!, expanded!)).toBe(true)
  })

  // #given the all-zero compressed IPv6 address
  // #when parsed
  // #then it resolves to eight zero groups
  it('parses the bare "::" as all-zero groups', () => {
    const parsed = parseCanonicalAddress('::')
    expect(parsed).toBeDefined()
    expect(canonicalAddressToString(parsed!)).toBe('0000:0000:0000:0000:0000:0000:0000:0000')
  })

  // #given an address with two compression markers
  // #when parsed
  // #then it is rejected (ambiguous)
  it('rejects an address with two "::" compressions', () => {
    expect(parseCanonicalAddress('2001::db8::1')).toBeUndefined()
  })

  // #given a fully expanded address that also uses "::"
  // #when parsed
  // #then it is rejected (ambiguous — "::" must represent at least one omitted group)
  it('rejects "::" when all 8 groups are already explicit', () => {
    expect(parseCanonicalAddress('1:2:3:4:5:6:7::8')).toBeUndefined()
  })

  // #given a bare token with a trailing colon-number
  // #when parsed
  // #then it is parsed as IPv6 (never guessed as a port)
  it('never treats the trailing component of a bare token as a port', () => {
    // fe80::1:80 is a syntactically valid (if unusual) IPv6 address — "80" is
    // the last hex group, not a port, even though it looks numeric.
    const parsed = parseCanonicalAddress('fe80::1:80')
    expect(parsed).toBeDefined()
    expect(parsed!.family).toBe('ipv6')
  })

  // #given a bracketed IPv6 address
  // #when parsed
  // #then brackets are stripped and the address parses normally
  it('accepts a bracketed IPv6 address', () => {
    const parsed = parseCanonicalAddress('[2001:db8::1]')
    expect(parsed).toBeDefined()
    expect(canonicalAddressEquals(parsed!, parseCanonicalAddress('2001:db8::1')!)).toBe(true)
  })

  // #given a bracketed IPv6 address with a port suffix
  // #when parsed
  // #then it is rejected
  it('rejects [IPv6]:port', () => {
    expect(parseCanonicalAddress('[2001:db8::1]:8080')).toBeUndefined()
  })

  // #given a bracketed IPv4 address
  // #when parsed
  // #then it is rejected
  it('rejects bracketed IPv4', () => {
    expect(parseCanonicalAddress('[203.0.113.7]')).toBeUndefined()
  })

  // #given a zone identifier suffix
  // #when parsed
  // #then it is rejected outright
  it('rejects an IPv6 zone identifier', () => {
    expect(parseCanonicalAddress('fe80::1%eth0')).toBeUndefined()
  })

  // #given a percent-encoded zone identifier
  // #when parsed
  // #then it is rejected outright
  it('rejects a percent-encoded IPv6 zone identifier', () => {
    expect(parseCanonicalAddress('fe80::1%25eth0')).toBeUndefined()
  })
})

describe('parseCanonicalAddress — IPv4-mapped IPv6', () => {
  // #given the same client's IPv4 and hex-tail-mapped IPv6 spellings
  // #when parsed
  // #then they compare equal (a mismatch here silently reintroduces the socket-key collapse)
  it('iPv4 and its hex-tail IPv4-mapped-IPv6 form compare equal', () => {
    const ipv4 = parseCanonicalAddress('127.0.0.1')
    const mappedHex = parseCanonicalAddress('::ffff:7f00:1')
    expect(ipv4).toBeDefined()
    expect(mappedHex).toBeDefined()
    expect(canonicalAddressEquals(ipv4!, mappedHex!)).toBe(true)
    expect(mappedHex!.family).toBe('ipv4')
  })

  // #given the same client's IPv4 and dotted-form mapped IPv6 spellings
  // #when parsed
  // #then they compare equal
  it('iPv4 and its dotted-decimal IPv4-mapped-IPv6 form compare equal', () => {
    const ipv4 = parseCanonicalAddress('192.0.2.55')
    const mappedDotted = parseCanonicalAddress('::ffff:192.0.2.55')
    expect(ipv4).toBeDefined()
    expect(mappedDotted).toBeDefined()
    expect(canonicalAddressEquals(ipv4!, mappedDotted!)).toBe(true)
  })

  // #given an expanded (non-compressed) IPv4-mapped-IPv6 spelling
  // #when parsed
  // #then it still normalizes to the mapped IPv4 identity
  it('accepts an expanded IPv4-mapped-IPv6 form', () => {
    const expanded = parseCanonicalAddress('0:0:0:0:0:ffff:192.0.2.55')
    const ipv4 = parseCanonicalAddress('192.0.2.55')
    expect(expanded).toBeDefined()
    expect(canonicalAddressEquals(expanded!, ipv4!)).toBe(true)
  })

  // #given a loopback address in dotted-decimal and compressed mapped-IPv6 spellings
  // #when parsed
  // #then they compare equal — this is the trusted-proxy-list collapse the
  // deprecated compatible form below must NOT also get
  it('127.0.0.1 and its compressed IPv4-mapped-IPv6 form compare equal', () => {
    const ipv4 = parseCanonicalAddress('127.0.0.1')
    const mapped = parseCanonicalAddress('::ffff:127.0.0.1')
    expect(ipv4).toBeDefined()
    expect(mapped).toBeDefined()
    expect(canonicalAddressEquals(ipv4!, mapped!)).toBe(true)
  })

  // #given a loopback address in dotted-decimal and fully expanded mapped-IPv6 spellings
  // #when parsed
  // #then they compare equal
  it('127.0.0.1 and its fully expanded IPv4-mapped-IPv6 form compare equal', () => {
    const ipv4 = parseCanonicalAddress('127.0.0.1')
    const mapped = parseCanonicalAddress('0000:0000:0000:0000:0000:ffff:127.0.0.1')
    expect(ipv4).toBeDefined()
    expect(mapped).toBeDefined()
    expect(canonicalAddressEquals(ipv4!, mapped!)).toBe(true)
  })
})

describe('parseCanonicalAddress — deprecated IPv4-compatible IPv6 (rejected)', () => {
  // #given the deprecated IPv4-compatible compressed form of a loopback address
  // #when parsed
  // #then it is rejected outright, and is therefore never equal to the plain IPv4 form
  it('rejects the compressed IPv4-compatible dotted form, distinct from plain IPv4', () => {
    const compatible = parseCanonicalAddress('::127.0.0.1')
    const ipv4 = parseCanonicalAddress('127.0.0.1')
    expect(compatible).toBeUndefined()
    expect(ipv4).toBeDefined()
  })

  // #given the deprecated IPv4-compatible form written with explicit zero groups
  // #when parsed
  // #then it is rejected outright
  it('rejects the fully expanded IPv4-compatible dotted form', () => {
    expect(parseCanonicalAddress('0:0:0:0:0:0:127.0.0.1')).toBeUndefined()
  })

  // #given the IPv4-compatible dotted form for a non-loopback address
  // #when parsed
  // #then it is rejected outright (not specific to loopback)
  it('rejects the IPv4-compatible dotted form for an arbitrary address', () => {
    expect(parseCanonicalAddress('::203.0.113.7')).toBeUndefined()
  })
})

describe('parseCanonicalAddress — general normalization', () => {
  // #given surrounding space and tab characters
  // #when parsed
  // #then they are trimmed and the address parses
  it('trims surrounding space and tab', () => {
    const parsed = parseCanonicalAddress(' \t203.0.113.7 \t')
    expect(parsed).toBeDefined()
    expect(canonicalAddressToString(parsed!)).toBe('203.0.113.7')
  })

  // #given embedded whitespace inside the token
  // #when parsed
  // #then it is rejected
  it('rejects embedded whitespace', () => {
    expect(parseCanonicalAddress('203.0. 113.7')).toBeUndefined()
  })

  // #given an embedded control character
  // #when parsed
  // #then it is rejected
  it('rejects an embedded control character', () => {
    expect(parseCanonicalAddress('203.0.113.7\u0000')).toBeUndefined()
  })

  // #given a hostname
  // #when parsed
  // #then it is rejected
  it('rejects a hostname', () => {
    expect(parseCanonicalAddress('example.com')).toBeUndefined()
  })

  // #given the literal "unknown"
  // #when parsed
  // #then it is rejected
  it('rejects the literal "unknown"', () => {
    expect(parseCanonicalAddress('unknown')).toBeUndefined()
  })

  // #given an RFC 7239 Forwarded-syntax token
  // #when parsed
  // #then it is rejected
  it('rejects a `for=` token', () => {
    expect(parseCanonicalAddress('for=203.0.113.7')).toBeUndefined()
  })

  // #given a CIDR range
  // #when parsed
  // #then it is rejected
  it('rejects a CIDR range', () => {
    expect(parseCanonicalAddress('203.0.113.0/24')).toBeUndefined()
  })

  // #given a quoted-string token
  // #when parsed
  // #then it is rejected
  it('rejects a quoted-string token', () => {
    expect(parseCanonicalAddress('"203.0.113.7"')).toBeUndefined()
  })

  // #given an empty token
  // #when parsed
  // #then it is rejected
  it('rejects an empty token', () => {
    expect(parseCanonicalAddress('')).toBeUndefined()
  })
})
