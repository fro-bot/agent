import {existsSync, readdirSync, readFileSync} from 'node:fs'
import {describe, expect, it, vi} from 'vitest'
import {
  collectProdClosureFromBunLock,
  collectThirdPartyNotices,
  collectThirdPartyNoticesBun,
  formatThirdPartyNotices,
} from './third-party-notices.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal()
  const mod = actual as typeof import('node:fs')
  return {
    ...mod,
    existsSync: vi.fn(mod.existsSync),
    readdirSync: vi.fn(mod.readdirSync),
    readFileSync: vi.fn(mod.readFileSync),
  }
})

const mockExistsSync = vi.mocked(existsSync)
const mockReaddirSync = vi.mocked(readdirSync)
const mockReadFileSync = vi.mocked(readFileSync)

function makeBunLock(workspaceDeps: Record<string, string>, packages: Record<string, unknown>): string {
  return JSON.stringify(
    {
      lockfileVersion: 1,
      configVersion: 1,
      workspaces: {
        '': {
          name: '@test/workspace',
          dependencies: workspaceDeps,
        },
      },
      packages,
    },
    null,
    2,
  )
}

describe('formatThirdPartyNotices', () => {
  it('formats entries sorted by package name with LF line endings', () => {
    const entries = new Map([
      ['zebra', {version: '1.0.0', license: 'MIT', content: 'MIT License text'}],
      ['alpha', {version: '2.0.0', license: 'Apache-2.0', content: 'Apache License text'}],
    ])
    const result = formatThirdPartyNotices(entries)
    expect(result.indexOf('alpha')).toBeLessThan(result.indexOf('zebra'))
    expect(result).toContain('alpha@2.0.0\nApache-2.0\nApache License text')
    expect(result).toContain('zebra@1.0.0\nMIT\nMIT License text')
    expect(result).not.toContain('\r\n')
  })

  it('normalizes CRLF to LF in license content', () => {
    const entries = new Map([['pkg', {version: '1.0.0', license: 'MIT', content: 'line1\r\nline2\r\n'}]])
    const result = formatThirdPartyNotices(entries)
    expect(result).not.toContain('\r\n')
    expect(result).toContain('line1\nline2\n')
  })

  it('returns empty string for empty map', () => {
    expect(formatThirdPartyNotices(new Map())).toBe('')
  })
})

describe('collectProdClosureFromBunLock', () => {
  it('extracts prod deps from workspace dependencies', () => {
    const lockContent = makeBunLock(
      {react: '18.2.0', typescript: '5.0.0'},
      {
        react: ['react@18.2.0', '', {dependencies: {}}],
        typescript: ['typescript@5.0.0', '', {}],
      },
    )
    mockReadFileSync.mockReturnValue(lockContent)
    mockExistsSync.mockReturnValue(true)
    const closure = collectProdClosureFromBunLock('/fake/bun.lock', '/fake/node_modules')
    expect(closure.has('react')).toBe(true)
    expect(closure.has('typescript')).toBe(true)
    expect(closure.get('react')?.version).toBe('18.2.0')
  })

  it('traverses transitive dependencies', () => {
    const lockContent = makeBunLock(
      {react: '18.2.0'},
      {
        react: ['react@18.2.0', '', {dependencies: {'loose-envify': '^1.0.0'}}],
        'loose-envify': ['loose-envify@1.4.0', '', {dependencies: {'js-tokens': '^3.0.0'}}],
        'js-tokens': ['js-tokens@4.0.0', '', {}],
      },
    )
    mockReadFileSync.mockReturnValue(lockContent)
    mockExistsSync.mockReturnValue(true)
    const closure = collectProdClosureFromBunLock('/fake/bun.lock', '/fake/node_modules')
    expect(closure.has('react')).toBe(true)
    expect(closure.has('loose-envify')).toBe(true)
    expect(closure.has('js-tokens')).toBe(true)
  })

  it('includes optional dependencies', () => {
    const lockContent = makeBunLock(
      {jackspeak: '3.4.3'},
      {
        jackspeak: [
          'jackspeak@3.4.3',
          '',
          {
            dependencies: {'@isaacs/cliui': '^8.0.2'},
            optionalDependencies: {'@pkgjs/parseargs': '^0.11.0'},
          },
        ],
        '@isaacs/cliui': ['@isaacs/cliui@8.0.2', '', {}],
        '@pkgjs/parseargs': ['@pkgjs/parseargs@0.11.0', '', {}],
      },
    )
    mockReadFileSync.mockReturnValue(lockContent)
    mockExistsSync.mockReturnValue(true)
    const closure = collectProdClosureFromBunLock('/fake/bun.lock', '/fake/node_modules')
    expect(closure.has('@pkgjs/parseargs')).toBe(true)
  })

  it('resolves nested package versions (Bun hoisting)', () => {
    const lockContent = makeBunLock(
      {'archiver-utils': '5.0.2'},
      {
        'archiver-utils': ['archiver-utils@5.0.2', '', {dependencies: {glob: '^10.0.0'}}],
        glob: ['glob@13.0.6', '', {}],
        'archiver-utils/glob': ['glob@10.5.0', '', {dependencies: {'foreground-child': '^3.1.0', jackspeak: '^3.1.2'}}],
        'foreground-child': ['foreground-child@3.3.1', '', {}],
        jackspeak: ['jackspeak@3.4.3', '', {}],
      },
    )
    mockReadFileSync.mockReturnValue(lockContent)
    mockExistsSync.mockReturnValue(true)
    const closure = collectProdClosureFromBunLock('/fake/bun.lock', '/fake/node_modules')
    expect(closure.has('foreground-child')).toBe(true)
    expect(closure.has('jackspeak')).toBe(true)
    expect(closure.has('glob')).toBe(true)
  })

  it('excludes workspace packages from prod seeds', () => {
    const lockContent = JSON.stringify({
      lockfileVersion: 1,
      configVersion: 1,
      workspaces: {
        '': {
          name: '@test/root',
          dependencies: {'@test/lib': 'workspace:*', react: '18.2.0'},
        },
        'packages/lib': {
          name: '@test/lib',
          dependencies: {lodash: '4.17.21'},
        },
      },
      packages: {
        react: ['react@18.2.0', '', {}],
        lodash: ['lodash@4.17.21', '', {}],
      },
    })
    mockReadFileSync.mockReturnValue(lockContent)
    mockExistsSync.mockReturnValue(true)
    const closure = collectProdClosureFromBunLock('/fake/bun.lock', '/fake/node_modules')
    expect(closure.has('@test/lib')).toBe(false)
    expect(closure.has('react')).toBe(true)
    expect(closure.has('lodash')).toBe(true)
  })

  it('deduplicates to highest version per package', () => {
    const lockContent = makeBunLock(
      {pkgA: '1.0.0', pkgB: '1.0.0'},
      {
        pkgA: ['pkgA@1.0.0', '', {dependencies: {shared: '^1.0.0'}}],
        pkgB: ['pkgB@1.0.0', '', {dependencies: {shared: '^2.0.0'}}],
        shared: ['shared@1.5.0', '', {}],
        'pkgB/shared': ['shared@2.0.0', '', {}],
      },
    )
    mockReadFileSync.mockReturnValue(lockContent)
    mockExistsSync.mockReturnValue(true)
    const closure = collectProdClosureFromBunLock('/fake/bun.lock', '/fake/node_modules')
    expect(closure.get('shared')?.version).toBe('2.0.0')
  })

  it('exercises stripTrailingCommas — trailing commas in lockfile input are handled', () => {
    // JSON.stringify never emits trailing commas, so this exercises the regex path
    // that stripTrailingCommas must handle (bun.lock uses JSON5-style trailing commas).
    const lockWithTrailingCommas = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "@test/workspace",
      "dependencies": {
        "chalk": "5.3.0",
      },
    },
  },
  "packages": {
    "chalk": ["chalk@5.3.0", "", {}],
  },
}`
    mockReadFileSync.mockReturnValue(lockWithTrailingCommas)
    mockExistsSync.mockReturnValue(true)
    const closure = collectProdClosureFromBunLock('/fake/bun.lock', '/fake/node_modules')
    expect(closure.has('chalk')).toBe(true)
    expect(closure.get('chalk')?.version).toBe('5.3.0')
  })

  it('parses scoped packages correctly (@actions/core@3.0.1)', () => {
    const lockContent = makeBunLock({'@actions/core': '3.0.1'}, {'@actions/core': ['@actions/core@3.0.1', '', {}]})
    mockReadFileSync.mockReturnValue(lockContent)
    mockExistsSync.mockReturnValue(true)
    const closure = collectProdClosureFromBunLock('/fake/bun.lock', '/fake/node_modules')
    expect(closure.has('@actions/core')).toBe(true)
    expect(closure.get('@actions/core')?.version).toBe('3.0.1')
  })

  it('silently skips a dependency not present in the packages map', () => {
    // resolveDepKey returns null → should not crash, just skip
    const lockContent = makeBunLock(
      {pkgA: '1.0.0'},
      {
        pkgA: ['pkgA@1.0.0', '', {dependencies: {'ghost-dep': '^1.0.0'}}],
        // 'ghost-dep' is intentionally absent from packages
      },
    )
    mockReadFileSync.mockReturnValue(lockContent)
    mockExistsSync.mockReturnValue(true)
    const closure = collectProdClosureFromBunLock('/fake/bun.lock', '/fake/node_modules')
    expect(closure.has('pkgA')).toBe(true)
    expect(closure.has('ghost-dep')).toBe(false)
  })

  it('throws a clear error when lockfileVersion is missing or not 1 (FIX B)', () => {
    const badLock = JSON.stringify({
      lockfileVersion: 2,
      workspaces: {'': {name: '@test/workspace', dependencies: {}}},
      packages: {},
    })
    mockReadFileSync.mockReturnValue(badLock)
    mockExistsSync.mockReturnValue(true)
    expect(() => collectProdClosureFromBunLock('/fake/bun.lock', '/fake/node_modules')).toThrow(
      /unsupported bun\.lock format.*lockfileVersion 1/,
    )
  })

  it('throws a clear error when lockfileVersion is absent (FIX B)', () => {
    const badLock = JSON.stringify({
      workspaces: {'': {name: '@test/workspace', dependencies: {}}},
      packages: {},
    })
    mockReadFileSync.mockReturnValue(badLock)
    mockExistsSync.mockReturnValue(true)
    expect(() => collectProdClosureFromBunLock('/fake/bun.lock', '/fake/node_modules')).toThrow(
      /unsupported bun\.lock format/,
    )
  })

  it('includes packages reachable only via peerDependencies (FIX G)', () => {
    // peer-only-dep is not in dependencies or optionalDependencies of pkgA,
    // only in peerDependencies — it must still be included in the closure.
    const lockContent = makeBunLock(
      {pkgA: '1.0.0'},
      {
        pkgA: ['pkgA@1.0.0', '', {peerDependencies: {'peer-only-dep': '^1.0.0'}}],
        'peer-only-dep': ['peer-only-dep@1.0.0', '', {}],
      },
    )
    mockReadFileSync.mockReturnValue(lockContent)
    mockExistsSync.mockReturnValue(true)
    const closure = collectProdClosureFromBunLock('/fake/bun.lock', '/fake/node_modules')
    expect(closure.has('pkgA')).toBe(true)
    expect(closure.has('peer-only-dep')).toBe(true)
  })

  it('excludes workspace devDependencies that are not reachable via any prod dep', () => {
    // Seeds come from workspace `dependencies` only — a package listed solely in
    // `devDependencies` must not appear in the prod closure.
    const lockContent = JSON.stringify({
      lockfileVersion: 1,
      configVersion: 1,
      workspaces: {
        '': {
          name: '@test/workspace',
          dependencies: {chalk: '5.3.0'},
          devDependencies: {vitest: '2.0.0'},
        },
      },
      packages: {
        chalk: ['chalk@5.3.0', '', {}],
        vitest: ['vitest@2.0.0', '', {}],
      },
    })
    mockReadFileSync.mockReturnValue(lockContent)
    mockExistsSync.mockReturnValue(true)
    const closure = collectProdClosureFromBunLock('/fake/bun.lock', '/fake/node_modules')
    // prod dep is included
    expect(closure.has('chalk')).toBe(true)
    expect(closure.get('chalk')?.version).toBe('5.3.0')
    // devDep with no prod-reachable path is excluded
    expect(closure.has('vitest')).toBe(false)
  })

  it('includes a package that is both a workspace devDependency and a transitive prod dep', () => {
    // Prod reachability wins: if a package is listed in devDependencies but is also
    // reachable transitively through a prod dependency's tree, it must be included.
    // This pins the seeding contract: closure seeds from `dependencies` only, but
    // BFS traversal still reaches packages that happen to also be devDeps.
    const lockContent = JSON.stringify({
      lockfileVersion: 1,
      configVersion: 1,
      workspaces: {
        '': {
          name: '@test/workspace',
          dependencies: {chalk: '5.3.0'},
          // shared-util is also a devDep, but chalk depends on it transitively
          devDependencies: {'shared-util': '1.0.0'},
        },
      },
      packages: {
        chalk: ['chalk@5.3.0', '', {dependencies: {'shared-util': '^1.0.0'}}],
        'shared-util': ['shared-util@1.0.0', '', {}],
      },
    })
    mockReadFileSync.mockReturnValue(lockContent)
    mockExistsSync.mockReturnValue(true)
    const closure = collectProdClosureFromBunLock('/fake/bun.lock', '/fake/node_modules')
    expect(closure.has('chalk')).toBe(true)
    // shared-util is reachable via chalk → must be in the prod closure
    expect(closure.has('shared-util')).toBe(true)
    expect(closure.get('shared-util')?.version).toBe('1.0.0')
  })
})

describe('collectThirdPartyNoticesBun', () => {
  it('returns formatted notices for a simple prod closure', async () => {
    const lockContent = makeBunLock({react: '18.2.0'}, {react: ['react@18.2.0', '', {}]})

    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p)
      return (
        path.endsWith('bun.lock') ||
        path.endsWith('/react') ||
        path.endsWith('/react/LICENSE') ||
        path.endsWith('/react/package.json')
      )
    })

    mockReadFileSync.mockImplementation((p: unknown, _enc?: unknown) => {
      const path = String(p)
      if (path.endsWith('bun.lock')) return lockContent
      if (path.endsWith('/react/LICENSE')) return 'MIT License\n\nCopyright (c) Facebook'
      if (path.endsWith('/react/package.json'))
        return JSON.stringify({name: 'react', version: '18.2.0', license: 'MIT'})
      return ''
    })

    mockReaddirSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('/react')) return ['LICENSE', 'package.json'] as unknown as ReturnType<typeof readdirSync>
      return []
    })

    const result = await collectThirdPartyNoticesBun('/fake/bun.lock', '/fake/node_modules')
    expect(result).toContain('react@18.2.0')
    expect(result).toContain('MIT')
    expect(result).toContain('MIT License')
  })

  it('throws when bun.lock does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    await expect(collectThirdPartyNoticesBun('/nonexistent/bun.lock', '/fake/node_modules')).rejects.toThrow(
      /bun\.lock not found/,
    )
  })

  it('throws when a prod package directory is missing (fail-closed)', async () => {
    const lockContent = makeBunLock({react: '18.2.0'}, {react: ['react@18.2.0', '', {}]})

    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p)
      return path.endsWith('bun.lock')
    })

    mockReadFileSync.mockImplementation((p: unknown, _enc?: unknown) => {
      if (String(p).endsWith('bun.lock')) return lockContent
      return ''
    })

    await expect(collectThirdPartyNoticesBun('/fake/bun.lock', '/fake/node_modules')).rejects.toThrow(
      /missing from node_modules/,
    )
  })

  it('uses Unknown license type for packages with no license file or field', async () => {
    const lockContent = makeBunLock({oldpkg: '0.1.1'}, {oldpkg: ['oldpkg@0.1.1', '', {}]})

    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p)
      return path.endsWith('bun.lock') || path.endsWith('/oldpkg') || path.endsWith('/oldpkg/package.json')
    })

    mockReadFileSync.mockImplementation((p: unknown, _enc?: unknown) => {
      const path = String(p)
      if (path.endsWith('bun.lock')) return lockContent
      if (path.endsWith('/oldpkg/package.json')) return JSON.stringify({name: 'oldpkg', version: '0.1.1'})
      return ''
    })

    mockReaddirSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('/oldpkg')) return ['package.json'] as unknown as ReturnType<typeof readdirSync>
      return []
    })

    const result = await collectThirdPartyNoticesBun('/fake/bun.lock', '/fake/node_modules')
    expect(result).toContain('oldpkg@0.1.1')
    expect(result).toContain('Unknown')
  })

  it('throws when bun.lock is malformed', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('not valid json at all {{{')
    await expect(collectThirdPartyNoticesBun('/fake/bun.lock', '/fake/node_modules')).rejects.toThrow(
      /failed to parse bun\.lock/,
    )
  })

  it('reads license type from old-style licenses ARRAY field when no LICENSE file exists', async () => {
    // Tests the package.json fallback path with the legacy `licenses` array format
    const lockContent = makeBunLock({oldstyle: '0.5.0'}, {oldstyle: ['oldstyle@0.5.0', '', {}]})

    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p)
      return path.endsWith('bun.lock') || path.endsWith('/oldstyle') || path.endsWith('/oldstyle/package.json')
    })

    mockReadFileSync.mockImplementation((p: unknown, _enc?: unknown) => {
      const path = String(p)
      if (path.endsWith('bun.lock')) return lockContent
      if (path.endsWith('/oldstyle/package.json'))
        return JSON.stringify({name: 'oldstyle', version: '0.5.0', licenses: [{type: 'BSD-2-Clause', url: '...'}]})
      return ''
    })

    mockReaddirSync.mockImplementation((p: unknown) => {
      // No LICENSE file — only package.json
      if (String(p).endsWith('/oldstyle')) return ['package.json'] as unknown as ReturnType<typeof readdirSync>
      return []
    })

    const result = await collectThirdPartyNoticesBun('/fake/bun.lock', '/fake/node_modules')
    expect(result).toContain('oldstyle@0.5.0')
    expect(result).toContain('BSD-2-Clause')
  })

  it('falls back to package.json license field when no LICENSE file exists', async () => {
    // Tests the package.json-only fallback path (no LICENSE file in the package dir)
    const lockContent = makeBunLock({minipkg: '1.0.0'}, {minipkg: ['minipkg@1.0.0', '', {}]})

    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p)
      return path.endsWith('bun.lock') || path.endsWith('/minipkg') || path.endsWith('/minipkg/package.json')
    })

    mockReadFileSync.mockImplementation((p: unknown, _enc?: unknown) => {
      const path = String(p)
      if (path.endsWith('bun.lock')) return lockContent
      if (path.endsWith('/minipkg/package.json'))
        return JSON.stringify({name: 'minipkg', version: '1.0.0', license: 'ISC'})
      return ''
    })

    mockReaddirSync.mockImplementation((p: unknown) => {
      // No LICENSE file — only package.json
      if (String(p).endsWith('/minipkg')) return ['package.json'] as unknown as ReturnType<typeof readdirSync>
      return []
    })

    const result = await collectThirdPartyNoticesBun('/fake/bun.lock', '/fake/node_modules')
    expect(result).toContain('minipkg@1.0.0')
    expect(result).toContain('ISC')
  })
})

describe('collectThirdPartyNotices', () => {
  it('uses Bun-native path when bun.lock is present', async () => {
    const lockContent = makeBunLock({react: '18.2.0'}, {react: ['react@18.2.0', '', {}]})

    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p)
      return (
        path.endsWith('bun.lock') ||
        path.endsWith('/react') ||
        path.endsWith('/react/LICENSE') ||
        path.endsWith('/react/package.json')
      )
    })

    mockReadFileSync.mockImplementation((p: unknown, _enc?: unknown) => {
      const path = String(p)
      if (path.endsWith('bun.lock')) return lockContent
      if (path.endsWith('/react/LICENSE')) return 'MIT License'
      if (path.endsWith('/react/package.json'))
        return JSON.stringify({name: 'react', version: '18.2.0', license: 'MIT'})
      return ''
    })

    mockReaddirSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('/react')) return ['LICENSE', 'package.json'] as unknown as ReturnType<typeof readdirSync>
      return []
    })

    const result = await collectThirdPartyNotices('./package.json')
    expect(result).toContain('react@18.2.0')
  })
})
