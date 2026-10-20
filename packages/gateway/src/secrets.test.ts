import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {
  isSecretFileBlank,
  readEnvSecret,
  readMultilineSecret,
  readOptionalMultilineSecret,
  readOptionalSecret,
  readSecret,
} from './secrets.js'

let tmpDir: string
let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = {...process.env}
  delete process.env.SECRET_UNDER_TEST
  delete process.env.SECRET_UNDER_TEST_FILE
  tmpDir = mkdtempSync(join(tmpdir(), 'gateway-secrets-test-'))
})

afterEach(() => {
  process.env = savedEnv
  rmSync(tmpDir, {recursive: true, force: true})
})

function writeSecretFile(name: string, contents: string): string {
  const file = join(tmpDir, name)
  writeFileSync(file, contents, {mode: 0o600})
  return file
}

describe('secret reader precedence', () => {
  it('a non-blank file beats the env var', () => {
    // #given a value in both places
    process.env.SECRET_UNDER_TEST_FILE = writeSecretFile('value', 'from-file\n')
    process.env.SECRET_UNDER_TEST = 'from-env'

    // #when / #then
    expect(readOptionalSecret('SECRET_UNDER_TEST')).toBe('from-file')
    expect(readSecret('SECRET_UNDER_TEST')).toBe('from-file')
  })

  it.each([
    ['empty', ''],
    ['whitespace-only', ' \n\t\n'],
  ])('a %s file returns null and the env var is NOT consulted', (_label, contents) => {
    // #given a blank file (an explicit opt-out) and a stale env value
    process.env.SECRET_UNDER_TEST_FILE = writeSecretFile('blank', contents)
    process.env.SECRET_UNDER_TEST = 'stale-env'

    // #when / #then
    expect(readOptionalSecret('SECRET_UNDER_TEST')).toBeNull()
    expect(readOptionalMultilineSecret('SECRET_UNDER_TEST')).toBeNull()
    expect(() => readSecret('SECRET_UNDER_TEST')).toThrow(
      'Missing required secret: SECRET_UNDER_TEST (set SECRET_UNDER_TEST env var or SECRET_UNDER_TEST_FILE pointing to a file)',
    )
    expect(() => readMultilineSecret('SECRET_UNDER_TEST')).toThrow('Missing required secret: SECRET_UNDER_TEST')
  })

  it('a missing file path falls through to the env var', () => {
    // #given
    process.env.SECRET_UNDER_TEST_FILE = join(tmpDir, 'does-not-exist')
    process.env.SECRET_UNDER_TEST = 'from-env'

    // #when / #then
    expect(readOptionalSecret('SECRET_UNDER_TEST')).toBe('from-env')
  })

  it('returns null when nothing is set', () => {
    expect(readOptionalSecret('SECRET_UNDER_TEST')).toBeNull()
  })

  it('rejects a symlinked file', () => {
    // #given
    const target = writeSecretFile('target', 'value')
    const link = join(tmpDir, 'link')
    symlinkSync(target, link)
    process.env.SECRET_UNDER_TEST_FILE = link

    // #when / #then
    expect(() => readOptionalSecret('SECRET_UNDER_TEST')).toThrow(/symlink|not a regular file/i)
  })

  it('rejects a directory', () => {
    // #given
    const dir = join(tmpDir, 'a-dir')
    mkdirSync(dir)
    process.env.SECRET_UNDER_TEST_FILE = dir

    // #when / #then
    expect(() => readOptionalSecret('SECRET_UNDER_TEST')).toThrow(/not a regular file/)
  })

  it('rejects a file over 4096 bytes', () => {
    // #given
    process.env.SECRET_UNDER_TEST_FILE = writeSecretFile('big', 'x'.repeat(4097))

    // #when / #then
    expect(() => readOptionalSecret('SECRET_UNDER_TEST')).toThrow(/too large/)
  })

  it('trims only trailing whitespace and keeps leading whitespace', () => {
    // #given
    process.env.SECRET_UNDER_TEST_FILE = writeSecretFile('padded', '  value  \n\n')

    // #when / #then
    expect(readOptionalSecret('SECRET_UNDER_TEST')).toBe('  value')
  })

  it('rejects an embedded line break in a single-line secret but keeps it in a multiline one', () => {
    // #given a two-line value
    process.env.SECRET_UNDER_TEST_FILE = writeSecretFile('two-lines', 'line-one\nline-two\n')

    // #when / #then
    expect(() => readOptionalSecret('SECRET_UNDER_TEST')).toThrow(/line-breaking/)
    expect(readOptionalMultilineSecret('SECRET_UNDER_TEST')).toBe('line-one\nline-two')
    expect(readMultilineSecret('SECRET_UNDER_TEST')).toBe('line-one\nline-two')
  })

  it('treats a whitespace-only env var as unset', () => {
    process.env.SECRET_UNDER_TEST = '   '
    expect(readOptionalSecret('SECRET_UNDER_TEST')).toBeNull()
  })
})

describe('isSecretFileBlank', () => {
  it.each([
    ['empty', '', true],
    ['whitespace-only', '  \n', true],
    ['non-blank', 'value', false],
  ])('%s file → %s', (_label, contents, expected) => {
    // #given
    process.env.SECRET_UNDER_TEST_FILE = writeSecretFile('probe', contents)

    // #when / #then
    expect(isSecretFileBlank('SECRET_UNDER_TEST')).toBe(expected)
  })

  it('is false when no file is configured or the path does not exist', () => {
    expect(isSecretFileBlank('SECRET_UNDER_TEST')).toBe(false)
    process.env.SECRET_UNDER_TEST_FILE = join(tmpDir, 'does-not-exist')
    expect(isSecretFileBlank('SECRET_UNDER_TEST')).toBe(false)
  })

  it('still rejects a symlink', () => {
    const target = writeSecretFile('target', '')
    const link = join(tmpDir, 'link')
    symlinkSync(target, link)
    process.env.SECRET_UNDER_TEST_FILE = link
    expect(() => isSecretFileBlank('SECRET_UNDER_TEST')).toThrow(/symlink|not a regular file/i)
  })
})

describe('readEnvSecret', () => {
  it('reads the env var only and ignores any _FILE', () => {
    // #given a non-blank file and a different env value
    process.env.SECRET_UNDER_TEST_FILE = writeSecretFile('ignored', 'from-file')
    process.env.SECRET_UNDER_TEST = 'from-env'

    // #when / #then
    expect(readEnvSecret('SECRET_UNDER_TEST')).toBe('from-env')
  })

  it('returns null when the env var is unset or blank, and rejects line breaks', () => {
    expect(readEnvSecret('SECRET_UNDER_TEST')).toBeNull()
    process.env.SECRET_UNDER_TEST = '  '
    expect(readEnvSecret('SECRET_UNDER_TEST')).toBeNull()
    process.env.SECRET_UNDER_TEST = 'a\nb'
    expect(() => readEnvSecret('SECRET_UNDER_TEST')).toThrow(/line-breaking/)
  })
})
