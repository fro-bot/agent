import {describe, expect, it} from 'vitest'
import {classifyReservedIpv4, classifyReservedIpv6, isBlockedResolvedAddress} from './ip-classification.js'

describe('isBlockedResolvedAddress', () => {
  // #given a loopback IPv4 address
  // #when classified at connect time
  // #then it is blocked
  it('blocks IPv4 loopback', () => {
    expect(isBlockedResolvedAddress('127.0.0.1', 4)).toBe(true)
  })

  // #given a private-network IPv4 address
  // #when classified
  // #then it is blocked
  it('blocks IPv4 private network 10.x', () => {
    expect(isBlockedResolvedAddress('10.0.0.1', 4)).toBe(true)
  })

  // #given a private-network IPv4 address (192.168.x)
  // #when classified
  // #then it is blocked
  it('blocks IPv4 private network 192.168.x', () => {
    expect(isBlockedResolvedAddress('192.168.1.1', 4)).toBe(true)
  })

  // #given the cloud-metadata link-local address
  // #when classified
  // #then it is blocked
  it('blocks the cloud metadata link-local address', () => {
    expect(isBlockedResolvedAddress('169.254.169.254', 4)).toBe(true)
  })

  // #given the unspecified IPv4 address
  // #when classified
  // #then it is blocked
  it('blocks 0.0.0.0', () => {
    expect(isBlockedResolvedAddress('0.0.0.0', 4)).toBe(true)
  })

  // #given a public IPv4 address
  // #when classified
  // #then it is NOT blocked
  it('does not block a public IPv4 address', () => {
    expect(isBlockedResolvedAddress('142.250.72.196', 4)).toBe(false)
  })

  // #given the IPv6 loopback address
  // #when classified
  // #then it is blocked
  it('blocks IPv6 loopback', () => {
    expect(isBlockedResolvedAddress('::1', 6)).toBe(true)
  })

  // #given an IPv6 link-local address
  // #when classified
  // #then it is blocked
  it('blocks IPv6 link-local', () => {
    expect(isBlockedResolvedAddress('fe80::1', 6)).toBe(true)
  })

  // #given a public IPv6 address
  // #when classified
  // #then it is NOT blocked (documented allow posture for public IPv6 relays)
  it('does not block a public IPv6 address', () => {
    expect(isBlockedResolvedAddress('2607:f8b0::1', 6)).toBe(false)
  })

  // #given an unparseable IPv4-family address
  // #when classified
  // #then it fails closed and is blocked
  it('fails closed on an unparseable IPv4 address', () => {
    expect(isBlockedResolvedAddress('not-an-ip', 4)).toBe(true)
  })

  // #given a private-network IPv4 address (172.16.0.0/12)
  // #when classified
  // #then it is blocked
  it('blocks IPv4 private network 172.16.0.0/12', () => {
    expect(isBlockedResolvedAddress('172.20.1.1', 4)).toBe(true)
  })

  // #given an IPv6 unique-local address (fc00::/7)
  // #when classified
  // #then it is blocked
  it('blocks IPv6 unique-local fc00::/fd00::', () => {
    expect(isBlockedResolvedAddress('fd12::1', 6)).toBe(true)
  })

  // #given an unknown address family
  // #when classified
  // #then it fails closed and is blocked
  it('fails closed on an unknown address family', () => {
    expect(isBlockedResolvedAddress('1.2.3.4', 0)).toBe(true)
  })

  // #given a resolved address that is IPv4-mapped IPv6 wrapping a PUBLIC IPv4
  // #when classified at connect time
  // #then it is NOT blocked — a public mapped address is not internal
  it('does not block a resolved IPv4-mapped-public IPv6 address', () => {
    expect(isBlockedResolvedAddress('::ffff:104.20.23.154', 6)).toBe(false)
  })

  // #given a resolved address that is IPv4-mapped IPv6 wrapping an INTERNAL
  // IPv4 (127.0.0.1) in the compact hex form
  // #when classified at connect time
  // #then it is blocked
  it('blocks a resolved IPv4-mapped-internal IPv6 address in hex form', () => {
    expect(isBlockedResolvedAddress('::ffff:7f00:1', 6)).toBe(true)
  })

  // #given a resolved deprecated site-local IPv6 address (fec0::/10)
  // #when classified at connect time
  // #then it is blocked
  it('blocks a resolved fec0::/10 site-local address', () => {
    expect(isBlockedResolvedAddress('fec0::1', 6)).toBe(true)
  })
})

describe('classifyReservedIpv4', () => {
  // #given the cloud metadata address
  // #then it is classified as metadata, distinct from other link-local addresses
  it('classifies 169.254.169.254 as metadata', () => {
    expect(classifyReservedIpv4('169.254.169.254')).toBe('metadata')
  })

  // #given addresses in loopback, private, link-local, and unspecified ranges
  // #then each is internal
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '0.0.0.0'])(
    'classifies %s as internal',
    address => {
      expect(classifyReservedIpv4(address)).toBe('internal')
    },
  )

  // #given addresses at and inside the CGNAT range 100.64.0.0/10
  // #then each is internal, and the neighbours outside the range are not
  it.each(['100.64.0.1', '100.100.100.100', '100.127.255.254'])('classifies CGNAT %s as internal', address => {
    expect(classifyReservedIpv4(address)).toBe('internal')
  })

  it.each(['100.63.255.255', '100.128.0.0'])('does not classify %s (adjacent to CGNAT) as reserved', address => {
    expect(classifyReservedIpv4(address)).toBeNull()
  })

  // #given the three RFC 5737 documentation ranges
  // #then each is internal
  it.each(['192.0.2.1', '198.51.100.7', '203.0.113.254'])('classifies documentation %s as internal', address => {
    expect(classifyReservedIpv4(address)).toBe('internal')
  })

  // #given public addresses
  // #then they are not reserved
  it.each(['8.8.8.8', '142.250.72.196', '192.0.3.1'])('does not classify public %s as reserved', address => {
    expect(classifyReservedIpv4(address)).toBeNull()
  })

  // #given the AWS ECS task metadata and Alibaba metadata addresses
  // #then both are metadata, ahead of the link-local and CGNAT checks that would otherwise claim them
  it.each(['169.254.170.2', '100.100.100.200'])('classifies %s as metadata', address => {
    expect(classifyReservedIpv4(address)).toBe('metadata')
  })

  // #given addresses next to the metadata addresses
  // #then they stay in their ordinary class
  it('keeps neighbours of the extra metadata addresses internal', () => {
    expect(classifyReservedIpv4('169.254.170.3')).toBe('internal')
    expect(classifyReservedIpv4('100.100.100.201')).toBe('internal')
  })

  // #given any address in 0.0.0.0/8
  // #then it is internal, not only 0.0.0.0
  it.each(['0.0.0.0', '0.1.2.3', '0.255.255.255'])('classifies this-network %s as internal', address => {
    expect(classifyReservedIpv4(address)).toBe('internal')
  })

  // #given the CGNAT and 172.16.0.0/12 boundaries
  // #then the first and last member are internal and the addresses just outside are not
  it.each(['100.64.0.0', '100.127.255.255', '172.16.0.0', '172.31.255.255'])(
    'classifies boundary %s as internal',
    address => {
      expect(classifyReservedIpv4(address)).toBe('internal')
    },
  )

  it.each(['100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0'])(
    'does not classify boundary neighbour %s as reserved',
    address => {
      expect(classifyReservedIpv4(address)).toBeNull()
    },
  )

  // #given text that is not a dotted-quad
  // #then it is not classified
  it('returns null for non-IPv4 text', () => {
    expect(classifyReservedIpv4('example.com')).toBeNull()
  })
})

describe('classifyReservedIpv6', () => {
  // #given the AWS IPv6 metadata address
  // #then it is metadata, not just private (it sits inside fc00::/7)
  it('classifies fd00:ec2::254 as metadata', () => {
    expect(classifyReservedIpv6('fd00:ec2::254')).toBe('metadata')
  })

  // #given IPv4-mapped IPv6 wrapping the IPv4 metadata address, in dotted and WHATWG hex form
  // #then both are metadata
  it.each(['::ffff:169.254.169.254', '::ffff:a9fe:a9fe'])('classifies mapped metadata %s as metadata', address => {
    expect(classifyReservedIpv6(address)).toBe('metadata')
  })

  // #given loopback, unspecified, link-local, ULA, and site-local IPv6
  // #then each is internal
  it.each(['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'fec0::1'])('classifies %s as internal', address => {
    expect(classifyReservedIpv6(address)).toBe('internal')
  })

  // #given the RFC 2765 IPv4-translated form ::ffff:0:a.b.c.d wrapping a metadata address, in hex and dotted spelling
  // #then it is metadata
  it.each(['::ffff:0:a9fe:a9fe', '::ffff:0:169.254.169.254', '::ffff:0:a9fe:aa02', '::ffff:0:6464:64c8'])(
    'classifies translated metadata %s as metadata',
    address => {
      expect(classifyReservedIpv6(address)).toBe('metadata')
    },
  )

  // #given the translated form wrapping internal and public IPv4
  // #then it follows the wrapped address
  it('classifies translated internal and public addresses by the wrapped IPv4', () => {
    expect(classifyReservedIpv6('::ffff:0:7f00:1')).toBe('internal')
    expect(classifyReservedIpv6('::ffff:0:10.0.0.1')).toBe('internal')
    expect(classifyReservedIpv6('::ffff:0:808:808')).toBeNull()
  })

  // #given the extra metadata addresses in IPv4-mapped form
  // #then they are metadata
  it.each(['::ffff:169.254.170.2', '::ffff:a9fe:aa02', '::ffff:100.100.100.200', '::ffff:6464:64c8'])(
    'classifies mapped metadata %s as metadata',
    address => {
      expect(classifyReservedIpv6(address)).toBe('metadata')
    },
  )

  // #given a translated prefix with an undecodable tail
  // #then it fails closed
  it.each(['::ffff:0:zz', '::ffff:0:1:2:3'])('fails closed on undecodable translated tail %s', address => {
    expect(classifyReservedIpv6(address)).toBe('internal')
  })

  // #given IPv4-mapped IPv6 wrapping internal, CGNAT, and documentation IPv4
  // #then each is internal
  it.each(['::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:6440:1', '::ffff:c000:201'])(
    'classifies mapped internal %s as internal',
    address => {
      expect(classifyReservedIpv6(address)).toBe('internal')
    },
  )

  // #given the IPv6 documentation range 2001:db8::/32
  // #then it is internal
  it('classifies 2001:db8::1 as internal', () => {
    expect(classifyReservedIpv6('2001:db8::1')).toBe('internal')
  })

  // #given public IPv6 and IPv4-mapped PUBLIC IPv4
  // #then neither is reserved (unlike classifyIpv6, which rejects every literal)
  it.each(['2606:4700::1', '2607:f8b0::1', '::ffff:104.20.23.154', '::ffff:6814:179a', '2001:db9::1'])(
    'does not classify public %s as reserved',
    address => {
      expect(classifyReservedIpv6(address)).toBeNull()
    },
  )

  // #given a ::ffff: prefix with an undecodable tail
  // #then it fails closed
  it('fails closed on an undecodable IPv4-mapped tail', () => {
    expect(classifyReservedIpv6('::ffff:zzzz')).toBe('internal')
  })
})
