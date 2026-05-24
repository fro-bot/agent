import {describe, expect, it} from 'vitest'

import {sanitizeOwner, sanitizeRepo, validateTokenShape} from './sanitize.js'

// #given valid GitHub owner/repo names
describe('sanitizeOwner', () => {
  it('accepts simple alphanumeric names', () => {
    expect(sanitizeOwner('fro-bot')).toBe('fro-bot')
    expect(sanitizeOwner('MyOrg')).toBe('MyOrg')
    expect(sanitizeOwner('org123')).toBe('org123')
  })

  it('accepts names with dots and underscores', () => {
    expect(sanitizeOwner('my.org')).toBe('my.org')
    expect(sanitizeOwner('my_org')).toBe('my_org')
    expect(sanitizeOwner('my-org.io')).toBe('my-org.io')
  })

  it('rejects empty string', () => {
    expect(sanitizeOwner('')).toBeNull()
  })

  it('rejects path traversal with ..', () => {
    expect(sanitizeOwner('../etc')).toBeNull()
    expect(sanitizeOwner('foo..bar')).toBeNull()
    expect(sanitizeOwner('..')).toBeNull()
  })

  it('rejects bare dot (.) — path traversal sentinel', () => {
    expect(sanitizeOwner('.')).toBeNull()
  })

  it('allows .github (GitHub repos can start with dot)', () => {
    expect(sanitizeOwner('.github')).toBe('.github')
  })

  it('rejects forward slash', () => {
    expect(sanitizeOwner('foo/bar')).toBeNull()
    expect(sanitizeOwner('/etc')).toBeNull()
  })

  it('rejects backslash', () => {
    expect(sanitizeOwner(String.raw`foo\bar`)).toBeNull()
  })

  it('rejects unicode characters', () => {
    expect(sanitizeOwner('fröbot')).toBeNull()
    expect(sanitizeOwner('org\u200B')).toBeNull()
    expect(sanitizeOwner('org\u0000')).toBeNull()
  })

  it('rejects null and non-string inputs', () => {
    expect(sanitizeOwner(null)).toBeNull()
    expect(sanitizeOwner(undefined)).toBeNull()
    expect(sanitizeOwner(42)).toBeNull()
    expect(sanitizeOwner({})).toBeNull()
  })

  it('rejects names with spaces', () => {
    expect(sanitizeOwner('my org')).toBeNull()
    expect(sanitizeOwner(' org')).toBeNull()
  })
})

// #given valid GitHub repo names
describe('sanitizeRepo', () => {
  it('accepts simple repo names', () => {
    expect(sanitizeRepo('agent')).toBe('agent')
    expect(sanitizeRepo('my-repo')).toBe('my-repo')
    expect(sanitizeRepo('repo_name')).toBe('repo_name')
    expect(sanitizeRepo('repo.name')).toBe('repo.name')
  })

  it('rejects empty string', () => {
    expect(sanitizeRepo('')).toBeNull()
  })

  it('rejects path traversal with ..', () => {
    expect(sanitizeRepo('../secret')).toBeNull()
    expect(sanitizeRepo('foo..bar')).toBeNull()
  })

  it('rejects forward slash (e.g. scoped names)', () => {
    expect(sanitizeRepo('foo/bar')).toBeNull()
  })

  it('rejects backslash', () => {
    expect(sanitizeRepo(String.raw`foo\bar`)).toBeNull()
  })

  it('rejects unicode', () => {
    expect(sanitizeRepo('rëpo')).toBeNull()
  })

  it('rejects non-string inputs', () => {
    expect(sanitizeRepo(null)).toBeNull()
    expect(sanitizeRepo(undefined)).toBeNull()
  })

  it('rejects bare dot (.) — path traversal sentinel', () => {
    expect(sanitizeRepo('.')).toBeNull()
  })

  it('rejects bare double-dot (..) — path traversal sentinel', () => {
    expect(sanitizeRepo('..')).toBeNull()
  })

  it('allows .github as a repo name', () => {
    expect(sanitizeRepo('.github')).toBe('.github')
  })

  it('allows repo.git', () => {
    expect(sanitizeRepo('repo.git')).toBe('repo.git')
  })

  it('allows a 100-character repo name (GitHub limit)', () => {
    const name = 'a'.repeat(100)
    expect(sanitizeRepo(name)).toBe(name)
  })

  it('allows a 101-character repo name (no length cap in sanitizer — GitHub enforces this)', () => {
    // The sanitizer does not enforce GitHub's 100-char limit; that's a GitHub API concern.
    // This test documents the current behavior.
    const name = 'a'.repeat(101)
    expect(sanitizeRepo(name)).toBe(name)
  })
})

// #given installation access tokens
describe('validateTokenShape', () => {
  it('accepts valid ghs_ prefixed tokens', () => {
    expect(validateTokenShape(`ghs_${'a'.repeat(20)}`)).toBe(true)
    expect(validateTokenShape('ghs_16C7e42F292c6912E7710c838347Ae178B4a')).toBe(true)
  })

  it('rejects tokens without ghs_ prefix', () => {
    expect(validateTokenShape('ghp_sometoken')).toBe(false)
    expect(validateTokenShape('sometoken')).toBe(false)
    expect(validateTokenShape('Bearer ghs_token')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(validateTokenShape('')).toBe(false)
  })

  it('rejects short ghs_ tokens (likely truncated)', () => {
    expect(validateTokenShape('ghs_short')).toBe(false)
  })

  it('rejects non-string inputs', () => {
    expect(validateTokenShape(null)).toBe(false)
    expect(validateTokenShape(undefined)).toBe(false)
    expect(validateTokenShape(42)).toBe(false)
  })
})
