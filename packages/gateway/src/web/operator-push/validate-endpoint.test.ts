import {describe, expect, it} from 'vitest'
import {validateEndpointUrl} from './validate-endpoint.js'

describe('validateEndpointUrl', () => {
  // #given a well-formed https push-service endpoint
  // #when validated
  // #then it is accepted
  it('accepts a valid https endpoint', () => {
    const result = validateEndpointUrl('https://fcm.googleapis.com/fcm/send/abc123')
    expect(result.ok).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  // #given an http (non-https) endpoint
  // #when validated
  // #then it is rejected as not-https
  it('rejects http scheme', () => {
    const result = validateEndpointUrl('http://push.example.com/x')
    expect(result).toEqual({ok: false, reason: 'not-https'})
  })

  // #given a non-http(s) scheme
  // #when validated
  // #then it is rejected as not-https
  it('rejects mailto scheme', () => {
    const result = validateEndpointUrl('mailto:someone@example.com')
    expect(result).toEqual({ok: false, reason: 'not-https'})
  })

  // #given an unparseable string
  // #when validated
  // #then it is rejected as unparseable
  it('rejects an unparseable URL', () => {
    const result = validateEndpointUrl('not a url')
    expect(result).toEqual({ok: false, reason: 'unparseable'})
  })

  // #given loopback hostnames
  // #when validated
  // #then each is rejected as loopback
  it('rejects the localhost hostname', () => {
    expect(validateEndpointUrl('https://localhost/x')).toEqual({ok: false, reason: 'loopback'})
  })

  it('rejects the IPv4 loopback range 127.0.0.0/8', () => {
    expect(validateEndpointUrl('https://127.0.0.1/x')).toEqual({ok: false, reason: 'loopback'})
    expect(validateEndpointUrl('https://127.255.255.255/x')).toEqual({ok: false, reason: 'loopback'})
  })

  it('rejects the IPv6 loopback ::1', () => {
    expect(validateEndpointUrl('https://[::1]/x')).toEqual({ok: false, reason: 'loopback'})
  })

  // #given private IPv4 network ranges
  // #when validated
  // #then each is rejected as private-network
  it('rejects 10.0.0.0/8', () => {
    expect(validateEndpointUrl('https://10.1.2.3/x')).toEqual({ok: false, reason: 'private-network'})
  })

  it('rejects 172.16.0.0/12', () => {
    expect(validateEndpointUrl('https://172.16.0.1/x')).toEqual({ok: false, reason: 'private-network'})
    expect(validateEndpointUrl('https://172.31.255.255/x')).toEqual({ok: false, reason: 'private-network'})
    expect(validateEndpointUrl('https://172.32.0.1/x').ok).toBe(true)
    expect(validateEndpointUrl('https://172.15.255.255/x').ok).toBe(true)
  })

  it('rejects 192.168.0.0/16', () => {
    expect(validateEndpointUrl('https://192.168.1.1/x')).toEqual({ok: false, reason: 'private-network'})
  })

  it('rejects IPv6 unique-local fc00::/7', () => {
    expect(validateEndpointUrl('https://[fc00::1]/x')).toEqual({ok: false, reason: 'private-network'})
    expect(validateEndpointUrl('https://[fd12::1]/x')).toEqual({ok: false, reason: 'private-network'})
  })

  // #given link-local ranges
  // #when validated
  // #then each is rejected as link-local
  it('rejects the IPv4 link-local range 169.254.0.0/16', () => {
    expect(validateEndpointUrl('https://169.254.1.1/x')).toEqual({ok: false, reason: 'link-local'})
  })

  it('rejects IPv6 link-local fe80::/10', () => {
    expect(validateEndpointUrl('https://[fe80::1]/x')).toEqual({ok: false, reason: 'link-local'})
  })

  // #given bare hostnames or local service names with no public dot
  // #when validated
  // #then each is rejected as no-dot-hostname
  it('rejects a bare hostname with no dot', () => {
    expect(validateEndpointUrl('https://workspace/x')).toEqual({ok: false, reason: 'no-dot-hostname'})
  })

  it('rejects a .local hostname', () => {
    expect(validateEndpointUrl('https://myhost.local/x')).toEqual({ok: false, reason: 'no-dot-hostname'})
  })

  it('rejects a .internal hostname', () => {
    expect(validateEndpointUrl('https://service.internal/x')).toEqual({ok: false, reason: 'no-dot-hostname'})
  })

  // #given the rejection result
  // #when inspected
  // #then it never contains the raw endpoint string
  it('never echoes the input endpoint in the rejection reason', () => {
    const secretEndpoint = 'https://127.0.0.1/super-secret-path-should-not-leak'
    const result = validateEndpointUrl(secretEndpoint)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('super-secret-path-should-not-leak')
  })

  // #given IPv4-mapped IPv6 literals in both dotted and WHATWG-normalized hex form
  // #when validated
  // #then the embedded IPv4 address is decoded and classified the same as the plain IPv4 literal
  describe('IPv4-mapped IPv6 literals', () => {
    it('rejects a mapped loopback address', () => {
      expect(validateEndpointUrl('https://[::ffff:127.0.0.1]/p')).toEqual({ok: false, reason: 'loopback'})
    })

    it('rejects mapped private-network addresses', () => {
      expect(validateEndpointUrl('https://[::ffff:10.0.0.1]/p')).toEqual({ok: false, reason: 'private-network'})
      expect(validateEndpointUrl('https://[::ffff:192.168.1.1]/p')).toEqual({ok: false, reason: 'private-network'})
      expect(validateEndpointUrl('https://[::ffff:172.16.0.1]/p')).toEqual({ok: false, reason: 'private-network'})
    })

    it('rejects mapped cloud-metadata / link-local addresses in both dotted and hex form', () => {
      expect(validateEndpointUrl('https://[::ffff:169.254.169.254]/p')).toEqual({ok: false, reason: 'link-local'})
      expect(validateEndpointUrl('https://[::ffff:a9fe:a9fe]/p')).toEqual({ok: false, reason: 'link-local'})
    })

    it('rejects a mapped unspecified address', () => {
      expect(validateEndpointUrl('https://[::ffff:0:0]/p')).toEqual({ok: false, reason: 'loopback'})
    })
  })

  // #given the IPv4 and IPv6 unspecified addresses
  // #when validated
  // #then each is rejected
  it('rejects the IPv4 unspecified address 0.0.0.0', () => {
    expect(validateEndpointUrl('https://0.0.0.0/p')).toEqual({ok: false, reason: 'loopback'})
  })

  it('rejects the IPv6 unspecified address ::', () => {
    expect(validateEndpointUrl('https://[::]/p')).toEqual({ok: false, reason: 'loopback'})
  })

  // #given internal hostnames written with a trailing dot (a valid FQDN root marker)
  // #when validated
  // #then the trailing dot is normalized away and the hostname is still rejected
  it('rejects a trailing-dot .internal hostname', () => {
    expect(validateEndpointUrl('https://metadata.google.internal./p')).toEqual({ok: false, reason: 'no-dot-hostname'})
    expect(validateEndpointUrl('https://service.internal./p')).toEqual({ok: false, reason: 'no-dot-hostname'})
  })

  // #given legitimate push-service origins
  // #when validated
  // #then each is accepted, guarding against false positives from the hardened checks
  it('accepts real push-service hosts', () => {
    expect(validateEndpointUrl('https://fcm.googleapis.com/fcm/send/abc').ok).toBe(true)
    expect(validateEndpointUrl('https://updates.push.services.mozilla.com/wpush/v2/xyz').ok).toBe(true)
    expect(validateEndpointUrl('https://web.push.apple.com/abc').ok).toBe(true)
  })

  // #given IPv6 literals in forms that embed or reduce to an internal address
  // through a path the specific classifiers don't decode (IPv4-compatible,
  // NAT64, 6to4), plus an arbitrary global-unicast literal with no internal
  // meaning at all
  // #when validated
  // #then every one is rejected — the fail-closed posture treats any IPv6
  // literal as an SSRF risk regardless of whether it decodes to something
  // internal, since real push endpoints are never IPv6 literals
  describe('fail-closed IPv6 literal posture', () => {
    it('rejects an IPv4-compatible IPv6 literal embedding 127.0.0.1', () => {
      const result = validateEndpointUrl('https://[::7f00:1]/p')
      expect(result.ok).toBe(false)
    })

    it('rejects a NAT64-embedded literal encoding 127.0.0.1', () => {
      const result = validateEndpointUrl('https://[64:ff9b::7f00:1]/p')
      expect(result.ok).toBe(false)
    })

    it('rejects a 6to4-embedded literal encoding 127.0.0.1', () => {
      const result = validateEndpointUrl('https://[2002:7f00:1::]/p')
      expect(result.ok).toBe(false)
    })

    it('rejects an arbitrary global-unicast IPv6 literal with no internal meaning', () => {
      const result = validateEndpointUrl('https://[2606:4700:4700::1111]/p')
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('ipv6-literal')
    })

    it('never echoes the endpoint or IPv6 literal in the rejection', () => {
      const endpoints = [
        'https://[::7f00:1]/secret-path',
        'https://[64:ff9b::7f00:1]/secret-path',
        'https://[2002:7f00:1::]/secret-path',
        'https://[2606:4700:4700::1111]/secret-path',
      ]
      for (const endpoint of endpoints) {
        const result = validateEndpointUrl(endpoint)
        expect(result.ok).toBe(false)
        expect(JSON.stringify(result)).not.toContain('secret-path')
      }
    })

    it('still accepts real push-service hostnames alongside the fail-closed IPv6 posture', () => {
      expect(validateEndpointUrl('https://fcm.googleapis.com/fcm/send/abc').ok).toBe(true)
      expect(validateEndpointUrl('https://updates.push.services.mozilla.com/wpush/v2/xyz').ok).toBe(true)
      expect(validateEndpointUrl('https://web.push.apple.com/abc').ok).toBe(true)
    })
  })

  // #given each hardened rejection case
  // #when the rejection reason is serialized
  // #then it never contains the raw endpoint value
  it('never echoes the endpoint for the hardened rejection cases', () => {
    const secretPath = '/super-secret-path-should-not-leak'
    const endpoints = [
      `https://[::ffff:127.0.0.1]${secretPath}`,
      `https://0.0.0.0${secretPath}`,
      `https://[::]${secretPath}`,
      `https://metadata.google.internal.${secretPath}`,
    ]
    for (const endpoint of endpoints) {
      const result = validateEndpointUrl(endpoint)
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain(secretPath)
    }
  })
})
