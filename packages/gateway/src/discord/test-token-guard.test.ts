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
    expect(() => validateTokenIsFake('fake')).not.toThrow()
    expect(() => validateTokenIsFake('test')).not.toThrow()
    expect(() => validateTokenIsFake('MOCK')).not.toThrow()
    expect(() => validateTokenIsFake('Test-Token-Fake-12345')).not.toThrow()
  })

  it('throws on a real-looking base64 token', () => {
    expect(() => validateTokenIsFake('MTIzNDU2.real-looking-base64.aBcDeF')).toThrow(/refusing to run/)
  })

  it('throws on arbitrary non-fake values', () => {
    expect(() => validateTokenIsFake('Bot abc123')).toThrow(/refusing to run/)
    expect(() => validateTokenIsFake('my-secret-token')).toThrow(/refusing to run/)
  })
})
