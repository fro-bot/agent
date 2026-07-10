import {describe, expect, it} from 'vitest'
import {isBlockedResolvedAddress} from './ip-classification.js'

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
})
