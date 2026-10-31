import {mkdir, mkdtemp, realpath, rm, symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {
  resolveSystematicSkillsDirsV1,
  resolveSystematicSkillsDirsV2,
  systematicSkillsEditDenyPatternV1,
} from './bundled-skills-dir.js'

let cacheHome: string

beforeEach(async () => {
  cacheHome = await mkdtemp(path.join(tmpdir(), 'bundled-skills-dir-'))
})

afterEach(async () => {
  await rm(cacheHome, {recursive: true, force: true})
})

async function makeSkillsDir(...segments: string[]): Promise<string> {
  const dir = path.join(cacheHome, ...segments)
  await mkdir(dir, {recursive: true})
  return dir
}

describe('resolveSystematicSkillsDirsV1', () => {
  it('returns the installed skills directory of the requested version', async () => {
    // #given V1's install layout: packages/<spec>/node_modules/<name>/skills
    const skills = await makeSkillsDir(
      'opencode',
      'packages',
      '@fro.bot',
      'systematic@3.29.0',
      'node_modules',
      '@fro.bot',
      'systematic',
      'skills',
    )
    const real = await realpath(skills)

    // #when
    const dirs = await resolveSystematicSkillsDirsV1(cacheHome, '3.29.0')

    // #then only the skills directory (and its real path when the cache is behind a symlink)
    expect(dirs).toContain(skills)
    expect(dirs.every(dir => dir === skills || dir === real)).toBe(true)
  })

  it('does not match another installed version', async () => {
    // #given only 3.28.0 is installed
    await makeSkillsDir(
      'opencode',
      'packages',
      '@fro.bot',
      'systematic@3.28.0',
      'node_modules',
      '@fro.bot',
      'systematic',
      'skills',
    )

    // #then 3.29.0 is unresolved, never a sibling version
    expect(await resolveSystematicSkillsDirsV1(cacheHome, '3.29.0')).toEqual([])
  })

  it('returns nothing when the plugin is not installed', async () => {
    expect(await resolveSystematicSkillsDirsV1(cacheHome, '3.29.0')).toEqual([])
  })

  it.each(['', '..', '3.29.0/../..', '3.*', '3.29.0?', ' 3.29.0', '3.29.0\n'])(
    'refuses the version %j, which could widen the path or the wildcard',
    async version => {
      expect(await resolveSystematicSkillsDirsV1(cacheHome, version)).toEqual([])
    },
  )

  it('refuses a relative cache home', async () => {
    expect(await resolveSystematicSkillsDirsV1('relative/cache', '3.29.0')).toEqual([])
  })

  it('also returns the real path when the cache is reached through a symlink', async () => {
    // #given a cache home that is a symlink to the real one (macOS /var -> /private/var, a linked XDG cache)
    const realCache = await mkdtemp(path.join(tmpdir(), 'bundled-skills-real-'))
    const link = path.join(cacheHome, 'link')
    try {
      await symlink(realCache, link)
      const skills = path.join(
        realCache,
        'opencode',
        'packages',
        '@fro.bot',
        'systematic@3.29.0',
        'node_modules',
        '@fro.bot',
        'systematic',
        'skills',
      )
      await mkdir(skills, {recursive: true})

      // #when
      const dirs = await resolveSystematicSkillsDirsV1(link, '3.29.0')

      // #then both spellings are allowed: the lexical one the config names and the real one a loader may report
      expect(dirs).toHaveLength(2)
      expect(dirs[0]).toBe(path.join(link, path.relative(realCache, skills)))
      expect(dirs[1]).toBe(await realpath(skills))
    } finally {
      await rm(realCache, {recursive: true, force: true})
    }
  })
})

describe('resolveSystematicSkillsDirsV2', () => {
  it('resolves the newest numbered generation, the one the server loads', async () => {
    // #given V2's generational layout: npm/<spec>/<generation>/node_modules/<name>/skills
    const base = ['opencode', 'npm', '@fro.bot', 'systematic@3.29.0']
    await makeSkillsDir(...base, '1700000000000', 'node_modules', '@fro.bot', 'systematic', 'skills')
    const newest = await makeSkillsDir(...base, '1800000000000', 'node_modules', '@fro.bot', 'systematic', 'skills')
    await makeSkillsDir(...base, '.staging-1900000000000-abc', 'node_modules', '@fro.bot', 'systematic', 'skills')

    // #when
    const dirs = await resolveSystematicSkillsDirsV2(cacheHome, '3.29.0')

    // #then not the older generation and not a staging directory
    expect(dirs[0]).toBe(newest)
    expect(dirs.every(dir => !dir.includes('1700000000000') && !dir.includes('.staging'))).toBe(true)
  })

  it('compares generations numerically, not lexically', async () => {
    const base = ['opencode', 'npm', '@fro.bot', 'systematic@3.29.0']
    await makeSkillsDir(...base, '999', 'node_modules', '@fro.bot', 'systematic', 'skills')
    const newest = await makeSkillsDir(...base, '1000', 'node_modules', '@fro.bot', 'systematic', 'skills')

    expect((await resolveSystematicSkillsDirsV2(cacheHome, '3.29.0'))[0]).toBe(newest)
  })

  it('returns nothing when the spec is not cached or has no generation', async () => {
    expect(await resolveSystematicSkillsDirsV2(cacheHome, '3.29.0')).toEqual([])
    await makeSkillsDir('opencode', 'npm', '@fro.bot', 'systematic@3.29.0')
    expect(await resolveSystematicSkillsDirsV2(cacheHome, '3.29.0')).toEqual([])
  })

  it('refuses an unsafe version', async () => {
    expect(await resolveSystematicSkillsDirsV2(cacheHome, '*')).toEqual([])
  })
})

describe('systematicSkillsEditDenyPatternV1', () => {
  it('is anchored on the version-specific package path, not the cache home', () => {
    expect(systematicSkillsEditDenyPatternV1('3.29.0')).toBe(
      '*/opencode/packages/@fro.bot/systematic@3.29.0/node_modules/@fro.bot/systematic/skills/*',
    )
  })

  it('is undefined for an unsafe version', () => {
    expect(systematicSkillsEditDenyPatternV1('3.*')).toBeUndefined()
  })
})
