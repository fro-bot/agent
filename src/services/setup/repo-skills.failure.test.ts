/**
 * Failure injection for `admitRepoSkills` (fro-bot/agent#2129): the filesystem fails in the ways a real runner's does
 * (an unreadable directory, a file that vanishes between the inventory and the copy, a removal that errors), and
 * admission must skip what it cannot read, leave nothing partial and never throw. The faults are injected through a
 * partial mock of `node:fs/promises`; everything else is the real filesystem.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger, serializeLoggerCalls, unwrapErr, unwrapOk} from '../../shared/test-helpers.js'

const faults = vi.hoisted(() => ({
  readdir: '',
  open: '',
  rm: false,
}))

function fault(code: string): Error {
  return Object.assign(new Error(`${code}: /secret/runner/path`), {code})
}

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const patched = {
    ...actual,
    readdir: vi.fn(async (...args: Parameters<typeof actual.readdir>) => {
      if (faults.readdir !== '' && String(args[0]).includes(faults.readdir)) throw fault('EACCES')
      return (actual.readdir as (...a: unknown[]) => Promise<unknown>)(...args)
    }),
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      if (faults.open !== '' && String(args[0]).includes(faults.open)) throw fault('ENOENT')
      return actual.open(...args)
    }),
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      if (faults.rm) throw fault('EBUSY')
      return actual.rm(...args)
    }),
  }
  return {...patched, default: patched}
})

const {admitRepoSkills} = await import('./repo-skills.js')

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, content)
}

const skillMd = (name: string): string => `---\nname: ${name}\ndescription: d\n---\n\nbody\n`

describe('admitRepoSkills failure injection', () => {
  let root: string
  let source: string
  let staging: string
  let bundled: string

  beforeEach(() => {
    faults.readdir = ''
    faults.open = ''
    faults.rm = false
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-skills-fault-')))
    source = path.join(root, 'source')
    staging = path.join(root, 'staging')
    bundled = path.join(root, 'bundled', 'skills')
    fs.mkdirSync(source)
    fs.mkdirSync(staging)
    writeFile(path.join(bundled, 'ce-review', 'SKILL.md'), skillMd('ce:review'))
    writeFile(path.join(source, 'good', 'SKILL.md'), skillMd('good'))
  })

  afterEach(() => {
    faults.readdir = ''
    faults.open = ''
    faults.rm = false
    fs.rmSync(root, {recursive: true, force: true})
  })

  function admit() {
    const logger = createMockLogger()
    const result = admitRepoSkills({
      sourceDir: source,
      stagingRoot: staging,
      bundledSkillsDirectories: [bundled],
      logger,
    })
    return {result, logger}
  }

  it('skips a skill directory it cannot read and admits the rest', async () => {
    // #given a skill directory whose listing fails with EACCES
    writeFile(path.join(source, 'locked', 'SKILL.md'), skillMd('locked'))
    faults.readdir = `${path.sep}locked`

    // #when admitting
    const {result, logger} = admit()

    // #then it is skipped as unreadable, the other skill lands, nothing throws and no path is logged
    const admitted = unwrapOk(await result)
    expect(admitted.skipped).toEqual([{id: 'locked', reason: 'unreadable'}])
    expect(admitted.admitted).toEqual(['good'])
    expect(fs.existsSync(path.join(staging, 'skills', 'locked'))).toBe(false)
    expect(serializeLoggerCalls(logger)).not.toContain('/secret/runner/path')
  })

  it('refuses everything, and leaves nothing partial, when the source directory cannot be listed', async () => {
    // #given a source listing that fails, and an extracted tree already in the staging root
    writeFile(path.join(staging, 'source-tree', 'x'), 'x')
    faults.readdir = `${path.sep}source`

    // #when admitting
    const error = unwrapErr(await admit().result)

    // #then it is a refusal with no copy and no extracted tree left behind
    expect(error).toContain('not readable')
    expect(fs.readdirSync(staging)).toEqual([])
  })

  it('skips a skill whose file vanishes between the inventory and the copy, removing the partial copy', async () => {
    // #given a skill whose reference cannot be opened when the copy reaches it
    writeFile(path.join(source, 'vanish', 'SKILL.md'), skillMd('vanish'))
    writeFile(path.join(source, 'vanish', 'references', 'x.md'), 'x')
    faults.open = `${path.sep}vanish${path.sep}references`

    // #when admitting
    const {result} = admit()

    // #then the skill is skipped as a failed copy, with none of its files left under the copy
    const admitted = unwrapOk(await result)
    expect(admitted.skipped).toEqual([{id: 'vanish', reason: 'copy-failed'}])
    expect(admitted.admitted).toEqual(['good'])
    expect(fs.existsSync(path.join(staging, 'skills', 'vanish'))).toBe(false)
  })

  it('does not throw when removing a partial copy fails too', async () => {
    // #given a failed copy and a removal that also fails
    writeFile(path.join(source, 'vanish', 'SKILL.md'), skillMd('vanish'))
    faults.open = `${path.sep}vanish${path.sep}SKILL.md`
    faults.rm = true

    // #when admitting
    const {result} = admit()

    // #then admission still returns a result
    const admitted = unwrapOk(await result)
    expect(admitted.skipped).toEqual([{id: 'vanish', reason: 'copy-failed'}])
  })
})
