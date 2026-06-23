import {execFile} from 'node:child_process'
import {getProjectLicenses} from 'generate-license-file'
import {describe, expect, it, vi} from 'vitest'
import {collectThirdPartyNotices, formatThirdPartyNotices} from './third-party-notices.js'

// All mocks use .js imports (Vitest convention for this project)
vi.mock('generate-license-file', () => ({
  getProjectLicenses: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('node:util', () => ({
  promisify:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      fn(...args),
}))

const mockGetProjectLicenses = vi.mocked(getProjectLicenses)
const mockExecFile = vi.mocked(execFile)

// Simulate pnpm licenses list returning empty (fail-soft path)
function stubPnpmLicensesEmpty() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
    if (typeof cb === 'function') {
      cb(null, JSON.stringify({}), '')
    }
    return {} as ReturnType<typeof execFile>
  })
}

describe('formatThirdPartyNotices', () => {
  it('formats entries sorted by package name with LF line endings', () => {
    // #given two entries in reverse alphabetical order
    const entries = new Map([
      ['zebra', {version: '1.0.0', license: 'MIT', content: 'MIT License text'}],
      ['alpha', {version: '2.0.0', license: 'Apache-2.0', content: 'Apache License text'}],
    ])

    // #when formatted
    const result = formatThirdPartyNotices(entries)

    // #then alpha sorts before zebra and no CRLF
    expect(result.indexOf('alpha')).toBeLessThan(result.indexOf('zebra'))
    expect(result).toContain('alpha@2.0.0\nApache-2.0\nApache License text')
    expect(result).toContain('zebra@1.0.0\nMIT\nMIT License text')
    // No CRLF
    expect(result).not.toContain('\r\n')
  })

  it('normalizes CRLF to LF in license content', () => {
    // #given content with CRLF line endings
    const entries = new Map([['pkg', {version: '1.0.0', license: 'MIT', content: 'line1\r\nline2\r\n'}]])

    // #when formatted
    const result = formatThirdPartyNotices(entries)

    // #then CRLF is normalized to LF
    expect(result).not.toContain('\r\n')
    expect(result).toContain('line1\nline2\n')
  })

  it('returns empty string for empty map', () => {
    // #given / #when / #then
    const result = formatThirdPartyNotices(new Map())
    expect(result).toBe('')
  })
})

describe('collectThirdPartyNotices — happy path', () => {
  it('returns formatted notice string from a fake license dataset', async () => {
    // #given pnpm licenses returns empty and getProjectLicenses returns two entries
    stubPnpmLicensesEmpty()

    mockGetProjectLicenses.mockResolvedValue([
      {
        content: 'MIT License\n\nCopyright (c) 2024',
        notices: [],
        dependencies: ['react@18.2.0', 'react-dom@18.2.0'],
      },
      {
        content: 'Apache License 2.0',
        notices: [],
        dependencies: ['typescript@5.0.0'],
      },
    ])

    // #when collected
    const result = await collectThirdPartyNotices()

    // #then result is a non-empty string with expected packages sorted
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)

    // react and typescript should appear (highest-version dedup: react@18.2.0, react-dom@18.2.0, typescript@5.0.0)
    expect(result).toContain('react@18.2.0')
    expect(result).toContain('typescript@5.0.0')

    // Sorted: react < react-dom < typescript
    expect(result.indexOf('react@')).toBeLessThan(result.indexOf('typescript@'))
  })

  it('deduplicates to highest version per package', async () => {
    // #given two entries for the same package at different versions
    stubPnpmLicensesEmpty()

    mockGetProjectLicenses.mockResolvedValue([
      {
        content: 'MIT License v1',
        notices: [],
        dependencies: ['lodash@4.0.0'],
      },
      {
        content: 'MIT License v2',
        notices: [],
        dependencies: ['lodash@4.17.21'],
      },
    ])

    // #when collected
    const result = await collectThirdPartyNotices()

    // #then only the highest version appears
    expect(result).toContain('lodash@4.17.21')
    expect(result).not.toContain('lodash@4.0.0')
    // Content from the highest version entry
    expect(result).toContain('MIT License v2')
  })
})

describe('collectThirdPartyNotices — error path', () => {
  it('throws when getProjectLicenses fails, with the underlying cause in the message', async () => {
    // #given getProjectLicenses rejects with an ENOENT error
    stubPnpmLicensesEmpty()

    const underlyingError = new Error('ENOENT: no such file or directory, open node_modules/foo/LICENSE')
    mockGetProjectLicenses.mockRejectedValue(underlyingError)

    // #when / #then throws with cause in message
    await expect(collectThirdPartyNotices()).rejects.toThrow(
      /license collection failed.*ENOENT.*no such file or directory/,
    )
  })

  it('error thrown by collectThirdPartyNotices includes the underlying cause', async () => {
    // #given getProjectLicenses rejects
    stubPnpmLicensesEmpty()

    const underlyingError = new Error('stderr: permission denied')
    mockGetProjectLicenses.mockRejectedValue(underlyingError)

    // #when caught
    let caught: unknown
    try {
      await collectThirdPartyNotices()
    } catch (error_) {
      caught = error_
    }

    // #then error has cause and message contains both
    expect(caught).toBeInstanceOf(Error)
    const error = caught as Error
    expect(error.message).toContain('license collection failed')
    expect(error.message).toContain('stderr: permission denied')
    expect(error.cause).toBe(underlyingError)
  })

  it('throws with a non-Error rejection value included in the message', async () => {
    // #given getProjectLicenses rejects with a string
    stubPnpmLicensesEmpty()

    mockGetProjectLicenses.mockRejectedValue('string rejection reason')

    // #when / #then message includes the string value
    await expect(collectThirdPartyNotices()).rejects.toThrow(/license collection failed.*string rejection reason/)
  })
})

describe('collectThirdPartyNotices — edge cases', () => {
  it('produces a valid notice when pnpm licenses list fails (Unknown license types)', async () => {
    // #given pnpm licenses list fails → all types become "Unknown"
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      if (typeof cb === 'function') {
        cb(new Error('pnpm not found'), '', 'command not found: pnpm')
      }
      return {} as ReturnType<typeof execFile>
    })

    mockGetProjectLicenses.mockResolvedValue([
      {
        content: 'Some license text',
        notices: [],
        dependencies: ['some-pkg@1.0.0'],
      },
    ])

    // #when collected
    const result = await collectThirdPartyNotices()

    // #then result is valid with Unknown license type
    expect(typeof result).toBe('string')
    expect(result).toContain('some-pkg@1.0.0')
    expect(result).toContain('Unknown')
  })

  it('returns empty string when there are no license entries', async () => {
    // #given / #when / #then
    stubPnpmLicensesEmpty()
    mockGetProjectLicenses.mockResolvedValue([])

    const result = await collectThirdPartyNotices()

    expect(result).toBe('')
  })

  it('skips dependencies with no version segment', async () => {
    // #given an unscoped and a scoped dep with no version, plus a valid dep
    stubPnpmLicensesEmpty()

    mockGetProjectLicenses.mockResolvedValue([
      {
        content: 'MIT',
        notices: [],
        // deps with no @version — must not produce bogus name@name entries
        dependencies: ['no-version-dep', '@scope/no-version-pkg'],
      },
      {
        content: 'Apache-2.0',
        notices: [],
        dependencies: ['valid-pkg@2.0.0'],
      },
    ])

    // #when collected
    const result = await collectThirdPartyNotices()

    // #then valid-pkg appears; both version-less deps are skipped entirely
    expect(result).toContain('valid-pkg@2.0.0')
    expect(result).not.toContain('no-version-dep')
    expect(result).not.toContain('@scope/no-version-pkg')
  })

  it('does not let a malformed entry latch over a later valid version', async () => {
    // #given a malformed (non-numeric) version of a package before its real version
    stubPnpmLicensesEmpty()

    mockGetProjectLicenses.mockResolvedValue([
      {
        content: 'MIT',
        notices: [],
        dependencies: ['pkg@not-a-version'],
      },
      {
        content: 'Apache-2.0',
        notices: [],
        dependencies: ['pkg@1.2.3'],
      },
    ])

    // #when collected
    const result = await collectThirdPartyNotices()

    // #then the real version replaces the malformed one (no NaN-comparison latch)
    expect(result).toContain('pkg@1.2.3')
    expect(result).not.toContain('pkg@not-a-version')
  })
})
