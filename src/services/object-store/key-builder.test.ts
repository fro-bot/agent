import type {ObjectStoreConfig} from './types.js'
import {describe, expect, it} from 'vitest'

import {buildObjectStoreKey} from './key-builder.js'

const config: ObjectStoreConfig = {
  enabled: true,
  bucket: 'test-bucket',
  region: 'us-east-1',
  prefix: 'fro-bot-state',
}

describe('buildObjectStoreKey', () => {
  it('builds a key with sanitized repository and suffix components', () => {
    // #given
    const identity = 'github'
    const repo = 'owner/repo'
    const contentType = 'artifacts'
    const suffix = 'run-123/prompt.txt'

    // #when
    const result = buildObjectStoreKey(config, identity, repo, contentType, suffix)

    // #then
    expect(result.success).toBe(true)
    expect(result.success && result.data).toBe('fro-bot-state/github/owner/repo/artifacts/run-123-prompt.txt')
  })

  it('returns a content-type prefix when suffix is omitted', () => {
    // #given
    const identity = 'github'
    const repo = 'owner/repo'

    // #when
    const result = buildObjectStoreKey(config, identity, repo, 'sessions')

    // #then
    expect(result.success).toBe(true)
    expect(result.success && result.data).toBe('fro-bot-state/github/owner/repo/sessions/')
  })

  it('rejects key components that contain traversal markers', () => {
    // #given
    const suffix = '../secrets.txt'

    // #when
    const result = buildObjectStoreKey(config, 'github', 'owner/repo', 'metadata', suffix)

    // #then
    expect(result.success).toBe(false)
  })
})
