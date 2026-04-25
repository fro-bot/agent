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
