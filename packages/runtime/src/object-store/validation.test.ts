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

  // A trailing dot is a valid FQDN root marker that still resolves; WHATWG keeps it in `hostname`, and `%2e` decodes to it.
  describe('trailing-dot hostnames', () => {
    it.each([
      'https://metadata.google.internal.',
      'https://METADATA.Google.Internal.',
      'https://metadata.google.internal%2e',
    ])('rejects metadata hostname %s in both modes', endpoint => {
      for (const allowInsecure of [false, true]) {
        const result = validateEndpoint(endpoint, allowInsecure)

        expect(result.success).toBe(false)
        expect(!result.success && result.error.message).toBe(
          's3 endpoint must not target cloud instance metadata services',
        )
      }
    })

    it.each(['https://localhost.', 'https://localhost%2e', 'https://LOCALHOST.:9000'])(
      'rejects %s by default and accepts it when insecure endpoints are allowed',
      endpoint => {
        const strict = validateEndpoint(endpoint, false)

        expect(strict.success).toBe(false)
        expect(!strict.success && strict.error.message).toBe(
          's3 endpoint must not target loopback, link-local, or private network addresses',
        )
        expect(validateEndpoint(endpoint, true).success).toBe(true)
      },
    )
  })

  describe('localhost names', () => {
    it('rejects https://localhost by default', () => {
      const result = validateEndpoint('https://localhost', false)

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toBe(
        's3 endpoint must not target loopback, link-local, or private network addresses',
      )
    })

    it.each(['https://foo.localhost', 'https://foo.bar.localhost:9000', 'https://foo.localhost.'])(
      'rejects %s by default and accepts it when insecure endpoints are allowed',
      endpoint => {
        const strict = validateEndpoint(endpoint, false)

        expect(strict.success).toBe(false)
        expect(!strict.success && strict.error.message).toBe(
          's3 endpoint must not target loopback, link-local, or private network addresses',
        )
        expect(validateEndpoint(endpoint, true).success).toBe(true)
      },
    )

    it('does not treat a name that merely contains localhost as local', () => {
      expect(validateEndpoint('https://localhost.example.com', false).success).toBe(true)
      expect(validateEndpoint('https://notlocalhost', false).success).toBe(true)
    })
  })

  it('rejects http://metadata.google.internal. with the metadata message when insecure endpoints are allowed', () => {
    const result = validateEndpoint('http://metadata.google.internal.', true)

    expect(!result.success && result.error.message).toBe('s3 endpoint must not target cloud instance metadata services')
  })

  describe('translated and extra metadata addresses', () => {
    it.each([
      'https://[::ffff:0:a9fe:a9fe]',
      'https://[::ffff:0:169.254.169.254]',
      'https://169.254.170.2',
      'https://100.100.100.200',
      'https://[::ffff:100.100.100.200]',
      'https://[::ffff:169.254.170.2]',
      'https://[::ffff:0:100.100.100.200]',
    ])('rejects %s as metadata in both modes', endpoint => {
      for (const allowInsecure of [false, true]) {
        const result = validateEndpoint(endpoint, allowInsecure)

        expect(result.success).toBe(false)
        expect(!result.success && result.error.message).toBe(
          's3 endpoint must not target cloud instance metadata services',
        )
      }
    })

    it('accepts the translated form of a public address in strict mode', () => {
      expect(validateEndpoint('https://[::ffff:0:808:808]', false).success).toBe(true)
    })

    it('rejects the translated form of an internal address by default and accepts it when insecure', () => {
      expect(validateEndpoint('https://[::ffff:0:7f00:1]', false).success).toBe(false)
      expect(validateEndpoint('https://[::ffff:0:7f00:1]', true).success).toBe(true)
    })
  })

  describe('this-network and range boundaries', () => {
    it('rejects 0.1.2.3 by default and accepts it when insecure endpoints are allowed', () => {
      expect(validateEndpoint('https://0.1.2.3', false).success).toBe(false)
      expect(validateEndpoint('https://0.1.2.3', true).success).toBe(true)
    })

    it.each(['https://100.64.0.0', 'https://100.127.255.255', 'https://172.16.0.0', 'https://172.31.255.255'])(
      'rejects range boundary %s by default',
      endpoint => {
        expect(validateEndpoint(endpoint, false).success).toBe(false)
      },
    )

    it.each(['https://100.63.255.255', 'https://100.128.0.0', 'https://172.15.255.255', 'https://172.32.0.0'])(
      'accepts address just outside a reserved range %s',
      endpoint => {
        expect(validateEndpoint(endpoint, false).success).toBe(true)
      },
    )

    // WHATWG normalizes these spellings of 127.0.0.1 to dotted form before validation sees them.
    it.each(['https://127.1', 'https://2130706433', 'https://0x7f000001', 'https://0177.0.0.1'])(
      'rejects the alternate IPv4 spelling %s by default',
      endpoint => {
        const result = validateEndpoint(endpoint, false)

        expect(result.success).toBe(false)
        expect(!result.success && result.error.message).toBe(
          's3 endpoint must not target loopback, link-local, or private network addresses',
        )
      },
    )

    it('rejects alternate spellings of the metadata address in both modes', () => {
      for (const endpoint of ['https://2852039166', 'https://0xa9fea9fe', 'https://169.254.43518']) {
        for (const allowInsecure of [false, true]) {
          expect(validateEndpoint(endpoint, allowInsecure).success).toBe(false)
        }
      }
    })
  })

  // Documented limits (see the wiki's "Known limits"): these are accepted today. If a change starts rejecting
  // them, update the docs and this test together.
  describe('documented limits', () => {
    it.each(['https://metadata/', 'https://198.18.0.1/'])('accepts %s in strict mode', endpoint => {
      expect(validateEndpoint(endpoint, false).success).toBe(true)
    })
  })

  describe('error messages', () => {
    it('pins the https message', () => {
      const result = validateEndpoint('http://example.com', false)

      expect(!result.success && result.error.message).toBe(
        's3 endpoint must use https unless insecure endpoints are explicitly allowed',
      )
    })

    it('pins the metadata message', () => {
      const result = validateEndpoint('https://169.254.169.254', false)

      expect(!result.success && result.error.message).toBe(
        's3 endpoint must not target cloud instance metadata services',
      )
    })

    it('pins the private-address message', () => {
      const result = validateEndpoint('https://10.0.0.1', false)

      expect(!result.success && result.error.message).toBe(
        's3 endpoint must not target loopback, link-local, or private network addresses',
      )
    })
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
