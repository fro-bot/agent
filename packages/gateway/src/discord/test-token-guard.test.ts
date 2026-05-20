import {describe, expect, it} from 'vitest'

import {validateTokenIsFake} from './test-token-guard.js'

describe('validateTokenIsFake', () => {
  it('accepts undefined', () => {
    expect(() => validateTokenIsFake(undefined)).not.toThrow()
  })

  it('accepts empty string', () => {
    expect(() => validateTokenIsFake('')).not.toThrow()
  })

  it('accepts known-fake prefixes (case-insensitive)', () => {
    expect(() => validateTokenIsFake('test-token-fake')).not.toThrow()
    expect(() => validateTokenIsFake('fake-token')).not.toThrow()
    expect(() => validateTokenIsFake('mock-token')).not.toThrow()
    expect(() => validateTokenIsFake('test')).not.toThrow()
    expect(() => validateTokenIsFake('Test-Token-Fake-12345')).not.toThrow()
  })

  it('accepts `test` followed by a non-alphanumeric separator', () => {
    expect(() => validateTokenIsFake('test-')).not.toThrow()
    expect(() => validateTokenIsFake('test ')).not.toThrow()
    expect(() => validateTokenIsFake('test_token')).not.toThrow()
  })

  it('throws on bare `fake` (too ambiguous — use fake-token instead)', () => {
    expect(() => validateTokenIsFake('fake')).toThrow(/refusing to run/)
  })

  it('throws on bare `MOCK` (too ambiguous — use mock-token instead)', () => {
    expect(() => validateTokenIsFake('MOCK')).toThrow(/refusing to run/)
  })

  it('throws on `testing123` (alphanumeric follows `test`)', () => {
    expect(() => validateTokenIsFake('testing123')).toThrow(/refusing to run/)
  })

  it('accepts `test-my-real-bot` (test- prefix: `-` is non-alphanumeric)', () => {
    // `test-` matches because `-` is non-alphanumeric. Any `test-*` value is
    // considered an explicit fake token — operators must use a non-test prefix
    // for real tokens.
    expect(() => validateTokenIsFake('test-my-real-bot')).not.toThrow()
  })

  it('throws on `fakery_real_token` (no fake-token prefix)', () => {
    expect(() => validateTokenIsFake('fakery_real_token')).toThrow(/refusing to run/)
  })

  it('throws on a real-looking base64 token', () => {
    expect(() => validateTokenIsFake('MTIzNDU2.real-looking-base64.aBcDeF')).toThrow(/refusing to run/)
  })

  it('throws on arbitrary non-fake values', () => {
    expect(() => validateTokenIsFake('Bot abc123')).toThrow(/refusing to run/)
    expect(() => validateTokenIsFake('my-secret-token')).toThrow(/refusing to run/)
  })
})
