import {describe, expect, it} from 'vitest'

import {parseEntityRefRepo} from './entity-ref.js'

describe('parseEntityRefRepo', () => {
  it('parses a bare owner/repo', () => {
    // #given an entity ref with no fragment
    // #when parsed
    const result = parseEntityRefRepo('owner/repo')

    // #then owner and repo are split on the slash
    expect(result).toEqual({owner: 'owner', repo: 'repo'})
  })

  it('strips a #fragment', () => {
    // #given an entity ref with a run number
    // #when parsed
    const result = parseEntityRefRepo('owner/repo#12')

    // #then the fragment does not bleed into the repo name
    expect(result).toEqual({owner: 'owner', repo: 'repo'})
  })

  it('strips from the first # when several are present', () => {
    // #given an entity ref with multiple '#'
    // #when parsed
    const result = parseEntityRefRepo('owner/repo#12#x')

    // #then everything from the first '#' is dropped
    expect(result).toEqual({owner: 'owner', repo: 'repo'})
  })

  it('accepts an empty fragment', () => {
    // #given an entity ref with a trailing '#'
    // #when parsed
    const result = parseEntityRefRepo('owner/repo#')

    // #then the repo is intact
    expect(result).toEqual({owner: 'owner', repo: 'repo'})
  })

  it('returns null for an empty owner', () => {
    // #given an entity ref with no owner
    // #when parsed
    // #then null
    expect(parseEntityRefRepo('/repo')).toBeNull()
  })

  it('returns null for an empty repo', () => {
    // #given an entity ref with no repo
    // #when parsed
    // #then null
    expect(parseEntityRefRepo('owner/')).toBeNull()
  })

  it('returns null when there is no slash', () => {
    // #given an entity ref with no slash
    // #when parsed
    // #then null
    expect(parseEntityRefRepo('owner')).toBeNull()
  })

  it('returns null when the slash only appears after the #', () => {
    // #given a slash that lives inside the stripped fragment
    // #when parsed
    // #then the fragment is dropped first, so no slash remains
    expect(parseEntityRefRepo('owner#a/b')).toBeNull()
  })

  it('splits on the first slash only', () => {
    // #given an entity ref with extra path segments
    // #when parsed
    const result = parseEntityRefRepo('a/b/c')

    // #then the remainder stays in repo (current behavior, pinned)
    expect(result).toEqual({owner: 'a', repo: 'b/c'})
  })

  it('returns null for an empty string', () => {
    // #given an empty entity ref
    // #when parsed
    // #then null
    expect(parseEntityRefRepo('')).toBeNull()
  })
})
