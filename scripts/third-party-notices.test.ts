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
