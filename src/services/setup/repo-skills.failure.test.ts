/**
 * Failure injection for `admitRepoSkills` (fro-bot/agent#2129): the filesystem fails in the ways a real runner's does
 * (an unreadable directory, a file that vanishes between the inventory and the copy, a removal that errors), and
 * admission must skip what it cannot read, leave nothing partial and never throw. The faults are injected through a
 * partial mock of `node:fs/promises`; everything else is the real filesystem.
 */

import {Buffer} from 'node:buffer'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger, serializeLoggerCalls, unwrapErr, unwrapOk} from '../../shared/test-helpers.js'

const faults = vi.hoisted(() => ({
  readdir: '',
  open: '',
  rename: '',
  realpath: '',
  /** Report every path as its own real path, as if nothing were a link. */
  realpathEcho: false,
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
    realpath: vi.fn(async (...args: Parameters<typeof actual.realpath>) => {
      if (faults.realpathEcho) return String(args[0])
      if (faults.realpath !== '' && String(args[0]).includes(faults.realpath)) return '/elsewhere/outside'
      return actual.realpath(...args)
    }),
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (faults.rename !== '' && String(args[0]).includes(faults.rename)) throw fault('EXDEV')
      return actual.rename(...args)
    }),
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      if (faults.rm) throw fault('EBUSY')
      return actual.rm(...args)
    }),
  }
  return {...patched, default: patched}
})

const {admitRepoSkills, stageDefaultBranchSkills} = await import('./repo-skills.js')

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
    faults.rename = ''
    faults.realpath = ''
    faults.realpathEcho = false
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
    faults.rename = ''
    faults.realpath = ''
    faults.realpathEcho = false
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

  it('never exposes a skill whose copy failed and whose cleanup also failed, and still admits its sibling', async () => {
    // #given SKILL.md copies, a later reference cannot be opened, and removal fails as well
    writeFile(path.join(source, 'vanish', 'SKILL.md'), skillMd('vanish'))
    writeFile(path.join(source, 'vanish', 'references', 'x.md'), 'x')
    faults.open = `${path.sep}vanish${path.sep}references`
    faults.rm = true

    // #when admitting
    const {result} = admit()

    // #then the half-copied skill is not in the directory handed to skills.paths, and the sibling is
    const admitted = unwrapOk(await result)
    expect(admitted.skipped).toEqual([{id: 'vanish', reason: 'copy-failed'}])
    expect(admitted.admitted).toEqual(['good'])
    expect(admitted.directory).toBe(path.join(staging, 'skills'))
    expect(fs.readdirSync(path.join(staging, 'skills'))).toEqual(['good'])
    expect(fs.existsSync(path.join(staging, 'skills', 'vanish'))).toBe(false)
  })

  it('does not expose a skill whose final rename fails', async () => {
    // #given a complete copy that cannot be moved into place
    writeFile(path.join(source, 'stuck', 'SKILL.md'), skillMd('stuck'))
    faults.rename = `${path.sep}stuck`
    faults.rm = true

    // #when admitting
    const {result} = admit()

    // #then it is skipped, nothing of it is in the exposed directory, the sibling is
    const admitted = unwrapOk(await result)
    expect(admitted.skipped).toEqual([{id: 'stuck', reason: 'copy-failed'}])
    expect(fs.readdirSync(path.join(staging, 'skills'))).toEqual(['good'])
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

  it('fails closed when a directory in the extract tree resolves outside the extract root', async () => {
    // #given a listing for one skill and a filesystem where the `probe` directory's real path leaves the extract root
    const oid = 'a'.repeat(40)
    const listing = Buffer.concat([
      Buffer.from(`040000 tree ${oid}       -\t.agents/skills/probe\0`),
      Buffer.from(`100644 blob ${oid}       3\t.agents/skills/probe/SKILL.md\0`),
    ])
    const exec = {
      exec: vi.fn(),
      getExecOutput: vi.fn(),
      execWithTimeout: async (
        _command: string,
        args: string[] | undefined,
        _timeout: number,
        options?: {input?: Buffer; listeners?: {stdout?: (data: Buffer) => void}},
      ) => {
        if (args?.includes('ls-tree') === true) options?.listeners?.stdout?.(listing)
        if (args?.includes('cat-file') === true) options?.listeners?.stdout?.(Buffer.from(`${oid} blob 3\nabc\n`))
        return 0
      },
    }
    faults.realpath = `${path.sep}probe`

    // #when staging
    const error = unwrapErr(
      await stageDefaultBranchSkills({
        exec,
        repository: 'fro-bot/agent',
        defaultBranch: 'main',
        stagingRoot: staging,
        logger: createMockLogger(),
        env: {},
        serverUrl: 'https://github.com',
      }),
    )

    // #then the write refused it, and nothing is left
    expect(error).toContain('write')
    expect(fs.readdirSync(staging)).toEqual([])
  })

  it('refuses a symlinked directory by itself, even when the real-path check has nothing to say', async () => {
    // #given a link planted at a skill directory, and a real-path check that reports every path as itself
    const oid = 'a'.repeat(40)
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    const listing = Buffer.concat([
      Buffer.from(`040000 tree ${oid}       -\t.agents/skills/probe\0`),
      Buffer.from(`100644 blob ${oid}       3\t.agents/skills/probe/SKILL.md\0`),
    ])
    const exec = {
      exec: vi.fn(),
      getExecOutput: vi.fn(),
      execWithTimeout: async (
        _command: string,
        args: string[] | undefined,
        _timeout: number,
        options?: {listeners?: {stdout?: (data: Buffer) => void}},
      ) => {
        if (args?.includes('ls-tree') === true) options?.listeners?.stdout?.(listing)
        if (args?.includes('cat-file') === true) {
          fs.mkdirSync(path.join(staging, 'source-tree', '.agents', 'skills'), {recursive: true})
          fs.symlinkSync(outside, path.join(staging, 'source-tree', '.agents', 'skills', 'probe'))
          options?.listeners?.stdout?.(Buffer.from(`${oid} blob 3\nabc\n`))
        }
        return 0
      },
    }
    faults.realpathEcho = true

    // #when staging
    const error = unwrapErr(
      await stageDefaultBranchSkills({
        exec,
        repository: 'fro-bot/agent',
        defaultBranch: 'main',
        stagingRoot: staging,
        logger: createMockLogger(),
        env: {},
        serverUrl: 'https://github.com',
      }),
    )

    // #then the directory check alone refused it
    expect(error).toContain('write')
    expect(fs.readdirSync(outside)).toEqual([])
  })
})
