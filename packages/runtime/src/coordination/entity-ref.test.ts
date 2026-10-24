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

  it('returns null when there are extra path segments (D4: was {owner: a, repo: b/c})', () => {
    // #given an entity ref with extra path segments
    // #when parsed
    // #then it is not an owner/repo, so it is rejected instead of leaking `b/c` into the repo name
    expect(parseEntityRefRepo('a/b/c')).toBeNull()
    expect(parseEntityRefRepo('a/b/c#4')).toBeNull()
    expect(parseEntityRefRepo('owner/repo/')).toBeNull()
  })

  it.each(['owner/re po', 'ow ner/repo', 'owner/repo?x=1', String.raw`ow\ner/repo`, 'owner/re\u0000po'])(
    'returns null for the forbidden character in %j',
    entityRef => {
      expect(parseEntityRefRepo(entityRef)).toBeNull()
    },
  )

  it.each(['\u200B', '\u200D', '\uFEFF'])('returns null for an invisible format character (%j)', char => {
    expect(parseEntityRefRepo(`owner${char}/repo`)).toBeNull()
    expect(parseEntityRefRepo(`owner/re${char}po#3`)).toBeNull()
    expect(parseEntityRefRepo(`${char}owner/repo`)).toBeNull()
  })

  it('trims surrounding whitespace, as the slug contract does', () => {
    expect(parseEntityRefRepo(' owner/repo#2 ')).toEqual({owner: 'owner', repo: 'repo'})
  })

  it('does not change case', () => {
    expect(parseEntityRefRepo('Owner/Repo#1')).toEqual({owner: 'Owner', repo: 'Repo'})
  })

  it('returns null for an empty string', () => {
    // #given an empty entity ref
    // #when parsed
    // #then null
    expect(parseEntityRefRepo('')).toBeNull()
  })
})
