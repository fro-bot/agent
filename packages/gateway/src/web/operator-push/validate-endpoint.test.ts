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
})
