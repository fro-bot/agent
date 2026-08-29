import {describe, expect, it} from 'vitest'

import {
  BROKERED_PUSH_PROTECTED_SURFACES,
  hasProtectedSegment,
  isCanonicalBrokeredPushPath,
  matchesBrokeredPushPrefix,
  normalizeBrokeredPushPrefix,
  parseBrokeredPushExtraPaths,
} from './brokered-push-paths.js'

describe('brokered-push path primitives', () => {
  it('normalizes prefixes to relative paths without trailing slashes', () => {
    // #given a comma-separated list with whitespace, a leading ./, and repeated separators
    const input = ' apps/, tools//cli '

    // #when parsing the extra path list
    const result = parseBrokeredPushExtraPaths(input)

    // #then the canonical representation is relative and has no trailing slash
    expect(result).toEqual(['apps', 'tools/cli'])
  })

  it.each(['', '  ', ','])('treats %j as an empty list', input => {
    // #given an unset, empty, whitespace-only, or comma-only value
    // #when parsing the extra path list
    const result = parseBrokeredPushExtraPaths(input)

    // #then no match-everything prefix is produced
    expect(result).toEqual([])
  })

  it('deduplicates entries after normalization', () => {
    // #given equivalent spellings of one prefix
    // #when parsing the extra path list
    const result = parseBrokeredPushExtraPaths('apps, ./apps/, apps//')

    // #then the normalized prefix appears once
    expect(result).toEqual(['apps'])
  })

  it('nFC-normalizes prefix entries', () => {
    // #given an NFD spelling of café
    const nfd = 'cafe\u0301'

    // #when normalizing the prefix
    const result = normalizeBrokeredPushPrefix(nfd)

    // #then the canonical NFC spelling is returned
    expect(result).toBe('café')
  })

  it.each(['../etc', '/abs/path', 'docs/../.github/'])('rejects malformed entry %s', entry => {
    // #given an absolute or traversal-containing prefix
    // #when parsing it
    // #then the error names the original entry and malformation
    expect(() => parseBrokeredPushExtraPaths(entry)).toThrow(entry)
    expect(() => parseBrokeredPushExtraPaths(entry)).toThrow('malformed')
  })

  it.each(['.github/', 'scripts/', 'package.json', '.npmrc', '.gitmodules', 'action.yml', 'action.yaml'])(
    'rejects protected entry %s',
    entry => {
      // #given a prefix overlapping a protected surface
      // #when parsing it
      // #then parsing fails and identifies the entry
      expect(() => parseBrokeredPushExtraPaths(entry)).toThrow(entry)
      expect(() => parseBrokeredPushExtraPaths(entry)).toThrow('protected')
    },
  )

  it('exports the canonical protected surface set', () => {
    // #given the shared protected-surface definition
    // #then execution and repository-control surfaces are present
    expect(BROKERED_PUSH_PROTECTED_SURFACES).toEqual(
      new Set([
        '.github',
        'scripts',
        'deploy/scripts',
        '.git',
        'package.json',
        'bun.lock',
        'package-lock.json',
        'npm-shrinkwrap.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'bun.lockb',
        'Dockerfile',
        '.npmrc',
        '.gitmodules',
        'action.yml',
        'action.yaml',
      ]),
    )
  })

  it('checks prefixes at segment boundaries', () => {
    // #given a prefix and a sibling directory with a similar name
    // #when matching paths
    // #then only the exact segment and its descendants match
    expect(matchesBrokeredPushPrefix('apps', 'apps')).toBe(true)
    expect(matchesBrokeredPushPrefix('apps/web/src/index.ts', 'apps')).toBe(true)
    expect(matchesBrokeredPushPrefix('apps-legacy/x.ts', 'apps')).toBe(false)
  })

  it.each([
    'apps/web/package.json',
    'apps/web/.github/workflows/ci.yml',
    'apps/web/Dockerfile.dev',
    'apps/web/src/index.ts',
  ])('checks protected segments and basenames for %s', path => {
    // #when checking the path against the shared protected-surface policy
    const protectedPath = hasProtectedSegment(path)

    // #then only the protected examples are denied
    expect(protectedPath).toBe(path !== 'apps/web/src/index.ts')
  })

  it.each(['apps/x.ts', './apps/x.ts', 'apps/./x.ts', 'apps//x.ts', 'apps/x.ts/'])(
    'identifies non-canonical brokered paths: %s',
    path => {
      expect(isCanonicalBrokeredPushPath(path)).toBe(path === 'apps/x.ts')
    },
  )
})
