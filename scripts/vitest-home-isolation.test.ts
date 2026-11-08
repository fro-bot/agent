import {existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {installHomeIsolation} from './vitest-home-isolation.js'

const ISOLATED_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'] as const

// A homedir resolver that behaves like POSIX `os.homedir()`: it follows the env object it is given.
function followingHome(env: Record<string, string | undefined>): () => string {
  return () => env.HOME ?? ''
}

describe('installHomeIsolation', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(realpathSync(tmpdir()), 'home-isolation-test-'))
  })

  afterEach(() => {
    rmSync(tmpRoot, {recursive: true, force: true})
  })

  it('creates a distinct tree per call, as two test files would get', () => {
    // #given two plain env objects (two "test files")
    const envA: Record<string, string | undefined> = {}
    const envB: Record<string, string | undefined> = {}

    // #when each installs isolation under the same temp root
    const a = installHomeIsolation({env: envA, tmpRoot, homedir: followingHome(envA)})
    const b = installHomeIsolation({env: envB, tmpRoot, homedir: followingHome(envB)})

    // #then the roots, and every variable pointed into them, are distinct
    expect(a.root).not.toBe(b.root)
    for (const key of ISOLATED_KEYS) {
      expect(envA[key]).toBeDefined()
      expect(envA[key]).not.toBe(envB[key])
      expect(envA[key]?.startsWith(`${a.root}/`)).toBe(true)
      expect(existsSync(envA[key] ?? '')).toBe(true)
    }
  })

  it('removes a populated tree on cleanup, leaving the other file’s tree alone', () => {
    // #given two isolated trees, one populated by "the test file"
    const envA: Record<string, string | undefined> = {}
    const envB: Record<string, string | undefined> = {}
    const a = installHomeIsolation({env: envA, tmpRoot, homedir: followingHome(envA)})
    const b = installHomeIsolation({env: envB, tmpRoot, homedir: followingHome(envB)})
    const nested = join(envA.XDG_CONFIG_HOME ?? '', 'opencode', 'deep')
    mkdirSync(nested, {recursive: true})
    writeFileSync(join(nested, 'config.json'), '{}')
    writeFileSync(join(envA.HOME ?? '', '.rc'), 'x')

    // #when the first file finishes
    a.cleanup()

    // #then its tree is gone (files included), the second is intact, and cleanup is idempotent
    expect(existsSync(a.root)).toBe(false)
    expect(existsSync(b.root)).toBe(true)
    expect(() => a.cleanup()).not.toThrow()
  })

  it('fails closed and removes its tree when homedir() ignores the HOME override', () => {
    // #given a resolver that keeps returning the real home (a worker_threads-style env copy)
    const env: Record<string, string | undefined> = {HOME: '/real/home'}

    // #when / #then it throws with the actionable message
    expect(() => installHomeIsolation({env, tmpRoot, homedir: () => '/real/home'})).toThrow(
      /home isolation failed: os\.homedir\(\) returned \/real\/home.*process-based pool/s,
    )

    // #then the half-built tree was cleaned up
    expect(readdirSync(tmpRoot)).toEqual([])
  })
})
