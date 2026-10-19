import * as path from 'node:path'
import {describe, expect, it} from 'vitest'

import {sanitizeKeyComponent, validateDownloadPath, validateEndpoint, validatePrefix} from './validation.js'

describe('validateEndpoint', () => {
  it('rejects insecure internal endpoints by default', () => {
    const endpoint = 'http://internal'

    const result = validateEndpoint(endpoint, false)

    expect(result.success).toBe(false)
  })

  it('accepts localhost over http when insecure endpoints are allowed', () => {
    const endpoint = 'http://localhost:9000'

    const result = validateEndpoint(endpoint, true)

    expect(result.success).toBe(true)
    expect(result.success && result.data.toString()).toBe('http://localhost:9000/')
  })

  it('rejects link-local https endpoints', () => {
    const endpoint = 'https://169.254.169.254'

    const result = validateEndpoint(endpoint, false)

    expect(result.success).toBe(false)
  })

  // WHATWG URL keeps the brackets on an IPv6 hostname, so the literal must be unwrapped before classification.
  describe('bracketed IPv6 literals', () => {
    it.each([
      ['https://[::1]', 'loopback'],
      ['https://[::1]:9000', 'loopback with port'],
      ['https://[fc00::1]', 'unique local'],
      ['https://[fd12:3456::1]', 'unique local'],
      ['https://[fe80::1]', 'link-local'],
      ['https://[::]', 'unspecified'],
      ['https://[::ffff:127.0.0.1]', 'IPv4-mapped loopback'],
      ['https://[::ffff:10.0.0.1]', 'IPv4-mapped private'],
      ['https://[2001:db8::1]', 'documentation'],
    ])('rejects %s (%s) by default with the private-address message', endpoint => {
      const result = validateEndpoint(endpoint, false)

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('loopback, link-local, or private network addresses')
    })

    it.each(['https://[::1]', 'https://[fc00::1]', 'https://[::]', 'https://[::ffff:127.0.0.1]'])(
      'accepts %s when insecure endpoints are allowed',
      endpoint => {
        expect(validateEndpoint(endpoint, true).success).toBe(true)
      },
    )

    it.each(['https://[fd00:ec2::254]', 'https://[::ffff:169.254.169.254]', 'https://[::ffff:a9fe:a9fe]'])(
      'rejects metadata endpoint %s even when insecure endpoints are allowed',
      endpoint => {
        for (const allowInsecure of [false, true]) {
          const result = validateEndpoint(endpoint, allowInsecure)

          expect(result.success).toBe(false)
          expect(!result.success && result.error.message).toContain('cloud instance metadata services')
        }
      },
    )

    it.each(['https://[2606:4700::1]', 'https://[2607:f8b0::1]:9000', 'https://[::ffff:104.20.23.154]'])(
      'accepts public IPv6 literal %s',
      endpoint => {
        expect(validateEndpoint(endpoint, false).success).toBe(true)
      },
    )
  })

  describe('reserved IPv4 ranges', () => {
    it.each([
      ['https://0.0.0.0', 'unspecified'],
      ['https://100.64.0.1', 'CGNAT'],
      ['https://100.127.255.254', 'CGNAT upper bound'],
      ['https://192.0.2.1', 'TEST-NET-1'],
      ['https://198.51.100.7', 'TEST-NET-2'],
      ['https://203.0.113.9', 'TEST-NET-3'],
    ])('rejects %s (%s) by default with the private-address message', endpoint => {
      const result = validateEndpoint(endpoint, false)

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('loopback, link-local, or private network addresses')
    })

    it.each(['https://0.0.0.0', 'https://100.64.0.1', 'https://192.0.2.1', 'http://10.0.0.5:9000'])(
      'accepts %s when insecure endpoints are allowed',
      endpoint => {
        expect(validateEndpoint(endpoint, true).success).toBe(true)
      },
    )

    it('still rejects the IPv4 metadata address when insecure endpoints are allowed', () => {
      const result = validateEndpoint('http://169.254.169.254', true)

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('cloud instance metadata services')
    })

    it.each(['https://100.63.255.255', 'https://100.128.0.1', 'https://8.8.8.8'])('accepts public %s', endpoint => {
      expect(validateEndpoint(endpoint, false).success).toBe(true)
    })
  })

  it('rejects the Google metadata hostname even when insecure endpoints are allowed', () => {
    const result = validateEndpoint('http://metadata.google.internal', true)

    expect(result.success).toBe(false)
    expect(!result.success && result.error.message).toContain('cloud instance metadata services')
  })
})

describe('validatePrefix', () => {
  it('accepts a valid object store prefix', () => {
    const prefix = 'fro-bot-state'

    const result = validatePrefix(prefix)

    expect(result.success).toBe(true)
    expect(result.success && result.data).toBe(prefix)
  })

  it('rejects traversal-like prefixes', () => {
    const prefix = '../other-repo'

    const result = validatePrefix(prefix)

    expect(result.success).toBe(false)
  })
})

describe('sanitizeKeyComponent', () => {
  it('replaces slashes with dashes', () => {
    const value = 'owner/repo'

    const result = sanitizeKeyComponent(value)

    expect(result.success).toBe(true)
    expect(result.success && result.data).toBe('owner-repo')
  })

  it('rejects traversal markers', () => {
    const value = '..'

    const result = sanitizeKeyComponent(value)

    expect(result.success).toBe(false)
  })
})

describe('validateDownloadPath', () => {
  it('returns an absolute path within the storage root', () => {
    const storagePath = '/tmp/opencode-storage'
    const relativePath = 'sessions/opencode.db'

    const result = validateDownloadPath(storagePath, relativePath)

    expect(result.success).toBe(true)
    expect(result.success && result.data).toBe(path.resolve(storagePath, relativePath))
  })

  it('rejects path traversal attempts', () => {
    const storagePath = '/tmp/opencode-storage'
    const relativePath = '../../../etc/passwd'

    const result = validateDownloadPath(storagePath, relativePath)

    expect(result.success).toBe(false)
  })
})
