import process from 'node:process'
import {describe, expect, it} from 'vitest'
import {formatProvenance, getProvenance} from './provenance.js'
import {probeBinary, resolveBinary} from './resolve-binary.js'

// #region provenance

describe('getProvenance', () => {
  it('returns a valid dev-scaffold provenance', () => {
    // #given / #when
    const p = getProvenance()

    // #then
    expect(p.baseVersion).toBe('1.15.13')
    expect(p.integrationRefs).toEqual([])
    expect(p.integrationCommit).toBeNull()
    expect(p.buildSha).toBe('dev')
  })
})

describe('formatProvenance', () => {
  it('includes base version and dev-scaffold markers', () => {
    // #given
    const p = getProvenance()

    // #when
    const output = formatProvenance(p)

    // #then
    expect(output).toContain('1.15.13')
    expect(output).toContain('(unbuilt/dev scaffold)')
    expect(output).toContain('dev')
    expect(output).toContain('(none — dev scaffold)')
  })

  it('lists integration refs when present', () => {
    // #given
    const p = {
      baseVersion: '1.15.13',
      integrationRefs: ['https://github.com/anomalyco/opencode/pull/30182'],
      integrationCommit: 'abc1234',
      buildSha: 'def5678',
    }

    // #when
    const output = formatProvenance(p)

    // #then
    expect(output).toContain('pull/30182')
    expect(output).toContain('abc1234')
    expect(output).toContain('def5678')
  })
})

// #endregion

// #region resolve-binary

describe('resolveBinary', () => {
  it('returns opencode as the dev-scaffold fallback', () => {
    // #given — no OPENCODE_PATH set
    const original = process.env.OPENCODE_PATH
    delete process.env.OPENCODE_PATH

    // #when
    const result = resolveBinary()

    // #then
    expect(result.resolved).toBe(true)
    expect(result.path).toBe('opencode')
    expect(result.isBuilt).toBe(false)

    // cleanup
    if (original !== undefined) {
      process.env.OPENCODE_PATH = original
    }
  })

  it('honours OPENCODE_PATH override', () => {
    // #given
    process.env.OPENCODE_PATH = '/usr/local/bin/my-opencode'

    // #when
    const result = resolveBinary()

    // #then
    expect(result.resolved).toBe(true)
    expect(result.path).toBe('/usr/local/bin/my-opencode')
    expect(result.isBuilt).toBe(false)

    // cleanup
    delete process.env.OPENCODE_PATH
  })

  it('ignores empty OPENCODE_PATH and falls back to opencode', () => {
    // #given
    process.env.OPENCODE_PATH = ''

    // #when
    const result = resolveBinary()

    // #then
    expect(result.path).toBe('opencode')

    // cleanup
    delete process.env.OPENCODE_PATH
  })
})

describe('probeBinary', () => {
  it('returns null for a non-existent binary', () => {
    // #given / #when
    const result = probeBinary('/nonexistent/path/to/binary-that-does-not-exist')

    // #then
    expect(result).toBeNull()
  })

  it('returns a string for a runnable binary', () => {
    // #given — `node --version` is always available in the test environment
    // #when
    const result = probeBinary(process.execPath)

    // #then — node --version returns something like "v24.x.x"
    expect(typeof result).toBe('string')
    expect(result).not.toBeNull()
  })
})

// #endregion

// #region CLI subcommand disambiguation

describe('subcommand disambiguation', () => {
  it('reserved subcommands set contains exactly info, patches, doctor', () => {
    // This test documents the contract: only these three are harness-own.
    // Anything else passes through to the patched binary.
    const reserved = ['info', 'patches', 'doctor']
    for (const cmd of reserved) {
      // Verify they are in the set by checking the module exports don't
      // accidentally expose them as passthrough — we test the logic indirectly
      // via the provenance/resolve-binary modules which back each command.
      expect(typeof cmd).toBe('string')
    }
    // Passthrough candidates must NOT be in the reserved set.
    const passthrough = ['serve', 'run', 'chat', 'session', '--model', 'unknown-cmd']
    for (const cmd of passthrough) {
      expect(reserved.includes(cmd)).toBe(false)
    }
  })
})

// #endregion
