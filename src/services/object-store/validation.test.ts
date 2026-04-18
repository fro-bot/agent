import * as path from 'node:path'
import {describe, expect, it} from 'vitest'

import {sanitizeKeyComponent, validateDownloadPath, validateEndpoint, validatePrefix} from './validation.js'

describe('validateEndpoint', () => {
  it('rejects insecure internal endpoints by default', () => {
    // #given
    const endpoint = 'http://internal'

    // #when
    const result = validateEndpoint(endpoint, false)

    // #then
    expect(result.success).toBe(false)
  })

  it('accepts localhost over http when insecure endpoints are allowed', () => {
    // #given
    const endpoint = 'http://localhost:9000'

    // #when
    const result = validateEndpoint(endpoint, true)

    // #then
    expect(result.success).toBe(true)
    expect(result.success && result.data.toString()).toBe('http://localhost:9000/')
  })

  it('rejects link-local https endpoints', () => {
    // #given
    const endpoint = 'https://169.254.169.254'

    // #when
    const result = validateEndpoint(endpoint, false)

    // #then
    expect(result.success).toBe(false)
  })
})

describe('validatePrefix', () => {
  it('accepts a valid object store prefix', () => {
    // #given
    const prefix = 'fro-bot-state'

    // #when
    const result = validatePrefix(prefix)

    // #then
    expect(result.success).toBe(true)
    expect(result.success && result.data).toBe(prefix)
  })

  it('rejects traversal-like prefixes', () => {
    // #given
    const prefix = '../other-repo'

    // #when
    const result = validatePrefix(prefix)

    // #then
    expect(result.success).toBe(false)
  })
})

describe('sanitizeKeyComponent', () => {
  it('replaces slashes with dashes', () => {
    // #given
    const value = 'owner/repo'

    // #when
    const result = sanitizeKeyComponent(value)

    // #then
    expect(result.success).toBe(true)
    expect(result.success && result.data).toBe('owner-repo')
  })

  it('rejects traversal markers', () => {
    // #given
    const value = '..'

    // #when
    const result = sanitizeKeyComponent(value)

    // #then
    expect(result.success).toBe(false)
  })
})

describe('validateDownloadPath', () => {
  it('returns an absolute path within the storage root', () => {
    // #given
    const storagePath = '/tmp/opencode-storage'
    const relativePath = 'sessions/opencode.db'

    // #when
    const result = validateDownloadPath(storagePath, relativePath)

    // #then
    expect(result.success).toBe(true)
    expect(result.success && result.data).toBe(path.resolve(storagePath, relativePath))
  })

  it('rejects path traversal attempts', () => {
    // #given
    const storagePath = '/tmp/opencode-storage'
    const relativePath = '../../../etc/passwd'

    // #when
    const result = validateDownloadPath(storagePath, relativePath)

    // #then
    expect(result.success).toBe(false)
  })
})
