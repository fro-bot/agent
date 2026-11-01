import type {Logger} from '../shared/logger.js'
import {mkdir, mkdtemp, realpath, rm, symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  isSystematicSkillsDir,
  resolveSystematicSkillsDirsV1,
  resolveSystematicSkillsDirsV2,
  SKILLS_EDIT_DENY_PATTERN_V1,
} from './bundled-skills-dir.js'

let cacheHome: string
let logger: Logger

beforeEach(async () => {
  cacheHome = await mkdtemp(path.join(tmpdir(), 'bundled-skills-dir-'))
  logger = {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}
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
    const dirs = await resolveSystematicSkillsDirsV1(cacheHome, '3.29.0', logger)

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
    expect(await resolveSystematicSkillsDirsV1(cacheHome, '3.29.0', logger)).toEqual([])
  })

  it('returns nothing when the plugin is not installed', async () => {
    expect(await resolveSystematicSkillsDirsV1(cacheHome, '3.29.0', logger)).toEqual([])
  })

  it.each(['', '..', '3.29.0/../..', '3.*', '3.29.0?', ' 3.29.0', '3.29.0\n'])(
    'refuses the version %j, which could widen the path or the wildcard',
    async version => {
      expect(await resolveSystematicSkillsDirsV1(cacheHome, version, logger)).toEqual([])
    },
  )

  it('refuses a relative cache home', async () => {
    expect(await resolveSystematicSkillsDirsV1('relative/cache', '3.29.0', logger)).toEqual([])
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
      const dirs = await resolveSystematicSkillsDirsV1(link, '3.29.0', logger)

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
    const dirs = await resolveSystematicSkillsDirsV2(cacheHome, '3.29.0', logger)

    // #then not the older generation and not a staging directory
    expect(dirs[0]).toBe(newest)
    expect(dirs.every(dir => !dir.includes('1700000000000') && !dir.includes('.staging'))).toBe(true)
  })

  it('compares generations numerically, not lexically', async () => {
    const base = ['opencode', 'npm', '@fro.bot', 'systematic@3.29.0']
    await makeSkillsDir(...base, '999', 'node_modules', '@fro.bot', 'systematic', 'skills')
    const newest = await makeSkillsDir(...base, '1000', 'node_modules', '@fro.bot', 'systematic', 'skills')

    expect((await resolveSystematicSkillsDirsV2(cacheHome, '3.29.0', logger))[0]).toBe(newest)
  })

  it('returns nothing when the spec is not cached or has no generation', async () => {
    expect(await resolveSystematicSkillsDirsV2(cacheHome, '3.29.0', logger)).toEqual([])
    await makeSkillsDir('opencode', 'npm', '@fro.bot', 'systematic@3.29.0')
    expect(await resolveSystematicSkillsDirsV2(cacheHome, '3.29.0', logger)).toEqual([])
  })

  it('refuses an unsafe version', async () => {
    expect(await resolveSystematicSkillsDirsV2(cacheHome, '*', logger)).toEqual([])
  })
})

function warningText(log: Logger): string {
  return JSON.stringify(vi.mocked(log.warning).mock.calls)
}

describe('aliased skills directories', () => {
  const V1_LAYOUT = ['opencode', 'packages', '@fro.bot', 'systematic@3.29.0', 'node_modules', '@fro.bot', 'systematic']

  /** Builds the V1 layout with `skills` as a symlink to `target`; returns the lexical skills path. */
  async function linkSkillsTo(target: string): Promise<string> {
    const pkg = await makeSkillsDir(...V1_LAYOUT)
    const skills = path.join(pkg, 'skills')
    await symlink(target, skills)
    return skills
  }

  it.each([
    ['the filesystem root', '/'],
    ['/tmp', '/tmp'],
  ])(
    'drops a real path that is %s, keeping the lexical spelling, and says so without printing a path',
    async (_label, target) => {
      // #given `skills` is a symlink to a path that is not a Systematic skills directory
      const skills = await linkSkillsTo(target)

      // #when
      const dirs = await resolveSystematicSkillsDirsV1(cacheHome, '3.29.0', logger)

      // #then only the lexical spelling survives; `/*` or `/tmp/*` is never granted
      expect(dirs).toEqual([skills])
      expect(dirs).not.toContain(await realpath(target))
      // #then one warning, with no path in it
      expect(logger.warning).toHaveBeenCalledTimes(1)
      expect(warningText(logger)).not.toContain((await realpath(target)) + path.sep)
      expect(warningText(logger)).not.toContain(cacheHome)
      expect(warningText(logger)).not.toContain('tmp/')
    },
  )

  it('drops an aliased V2 real path the same way', async () => {
    // #given
    const base = ['opencode', 'npm', '@fro.bot', 'systematic@3.29.0', '1800000000000', 'node_modules', '@fro.bot']
    const pkg = await makeSkillsDir(...base, 'systematic')
    const skills = path.join(pkg, 'skills')
    await symlink('/', skills)

    // #then
    expect(await resolveSystematicSkillsDirsV2(cacheHome, '3.29.0', logger)).toEqual([skills])
    expect(logger.warning).toHaveBeenCalledTimes(1)
  })

  it('keeps a real path that ends with the required tail but sits elsewhere', async () => {
    // #given `skills` links to another install of the same package, e.g. a cache on another mount
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'bundled-skills-mount-'))
    try {
      const realSkills = path.join(elsewhere, '@fro.bot', 'systematic', 'skills')
      await mkdir(realSkills, {recursive: true})
      const skills = await linkSkillsTo(realSkills)

      // #when
      const dirs = await resolveSystematicSkillsDirsV1(cacheHome, '3.29.0', logger)

      // #then both spellings are granted, and nothing is warned about
      expect(dirs).toEqual([skills, await realpath(realSkills)])
      expect(logger.warning).not.toHaveBeenCalled()
    } finally {
      await rm(elsewhere, {recursive: true, force: true})
    }
  })
})

describe('SKILLS_EDIT_DENY_PATTERN_V1', () => {
  it('is anchored on the tail every granted spelling has, not on the cache layout or the version', () => {
    expect(SKILLS_EDIT_DENY_PATTERN_V1).toBe('*/@fro.bot/systematic/skills/*')
  })
})

describe('isSystematicSkillsDir', () => {
  it.each(['/a/@fro.bot/systematic/skills', '/@fro.bot/systematic/skills'])('accepts %s', directory => {
    expect(isSystematicSkillsDir(directory)).toBe(true)
  })

  it.each(['/', '/tmp', '/a/@fro.bot/systematic', '/a/@fro.bot/systematic/skills-evil', 'x@fro.bot/systematic/skills'])(
    'refuses %s',
    directory => {
      expect(isSystematicSkillsDir(directory)).toBe(false)
    },
  )
})
