import type {ExecAdapter, ExecOptions} from './types.js'
import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger, serializeLoggerCalls, unwrapErr, unwrapOk} from '../../shared/test-helpers.js'
import {createExecAdapter} from './adapters.js'
import {
  admitRepoSkills,
  checkSourceBudget,
  createRepoSkillsStagingRoot,
  DEFAULT_REPO_SKILLS_LIMITS,
  parseCatFileBatch,
  parseTreeListing,
  removeRepoSkillsStagingRoot,
  REPO_SKILLS_DIRECTORY_NAME,
  safeRelativeSkillPath,
  stageDefaultBranchSkills,
  type StagedSkills,
} from './repo-skills.js'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@x',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@x',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd, env: GIT_ENV, encoding: 'utf8'})
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, content)
}

function skillMd(name: string, body = 'Do the thing.'): string {
  return `---\nname: ${name}\ndescription: A skill called ${name}\n---\n\n${body}\n`
}

function listFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, {withFileTypes: true, recursive: true})
    .filter(entry => entry.isFile() || entry.isSymbolicLink())
    .map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .toSorted()
}

interface RecordedCall {
  readonly command: string
  readonly cwd: string | undefined
  readonly args: string[]
  readonly env: Record<string, string> | undefined
  readonly timeoutMs: number
  readonly input: Buffer | undefined
}

/** An exec adapter that records every command and then runs it for real. */
function recordingExec(): {exec: ExecAdapter; calls: RecordedCall[]} {
  const real = createExecAdapter()
  const calls: RecordedCall[] = []
  const exec: ExecAdapter = {
    ...real,
    execWithTimeout: async (command, args, timeoutMs, options) => {
      calls.push({command, cwd: options?.cwd, args: args ?? [], env: options?.env, timeoutMs, input: options?.input})
      return (real.execWithTimeout as NonNullable<typeof real.execWithTimeout>)(command, args, timeoutMs, options)
    },
  }
  return {exec, calls}
}

/** The `git cat-file --batch` framing for one object. */
function frame(oid: string, content: Buffer | string, type = 'blob', size?: number): Buffer {
  const body = Buffer.from(content)
  return Buffer.concat([Buffer.from(`${oid} ${type} ${size ?? body.length}\n`), body, Buffer.from('\n')])
}

/**
 * An exec adapter that fakes every git command: `ls-tree` prints `listing`, `cat-file --batch` prints `catFile`, the
 * rest succeed. Records the commands and what was sent on stdin.
 */
function fakeExec(
  listing: Buffer | string,
  catFile: Buffer = Buffer.alloc(0),
  onCatFile?: () => void,
): {exec: ExecAdapter; commands: string[][]; inputs: string[]} {
  const commands: string[][] = []
  const inputs: string[] = []
  const exec: ExecAdapter = {
    exec: vi.fn(),
    getExecOutput: vi.fn(),
    execWithTimeout: async (command, args, _timeoutMs, options: ExecOptions | undefined) => {
      commands.push([command, ...(args ?? [])])
      if (args?.includes('ls-tree') === true) options?.listeners?.stdout?.(Buffer.from(listing))
      if (args?.includes('cat-file') === true) {
        onCatFile?.()
        inputs.push(options?.input?.toString('utf8') ?? '')
        options?.listeners?.stdout?.(catFile)
      }
      return 0
    },
  }
  return {exec, commands, inputs}
}

/** Runs everything for real and records what was fed to `cat-file --batch`. */
function fakeExecOverReal(): {exec: ExecAdapter; inputs: string[]} {
  const real = createExecAdapter()
  const inputs: string[] = []
  const exec: ExecAdapter = {
    ...real,
    execWithTimeout: async (command, args, timeoutMs, options) => {
      if (args?.includes('cat-file') === true) inputs.push(options?.input?.toString('utf8') ?? '')
      return (real.execWithTimeout as NonNullable<typeof real.execWithTimeout>)(command, args, timeoutMs, options)
    },
  }
  return {exec, inputs}
}

const OID = 'a'.repeat(40)

/** One `git ls-tree -r -l -z` record under the skills root. */
const blob = (file: string, size = 1, mode = '100644'): string =>
  `${mode} blob ${'a'.repeat(40)} ${String(size).padStart(7)}\t.agents/skills/${file}\0`

interface RawTreeEntry {
  readonly mode: string
  readonly type: 'blob' | 'tree'
  readonly oid: string
  /** Raw name bytes: git allows any byte except NUL and `/`. */
  readonly name: Buffer | string
}

/** `git hash-object -w`: stores a blob and returns its id. */
function hashObject(cwd: string, content: Buffer | string): string {
  return execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd,
    env: GIT_ENV,
    input: content,
    encoding: 'utf8',
  }).trim()
}

/** `git mktree -z`: stores a tree whose names may be arbitrary bytes (a filesystem could not hold some of them). */
function mktree(cwd: string, entries: readonly RawTreeEntry[]): string {
  const input = Buffer.concat(
    entries.map(entry =>
      Buffer.concat([
        Buffer.from(`${entry.mode} ${entry.type} ${entry.oid}\t`),
        Buffer.from(entry.name),
        Buffer.from([0]),
      ]),
    ),
  )
  return execFileSync('git', ['mktree', '-z'], {cwd, env: GIT_ENV, input, encoding: 'utf8'}).trim()
}

/** Commits `tree` as the new tip of main. */
function commitAsMain(cwd: string, tree: string): void {
  const commit = execFileSync('git', ['commit-tree', tree, '-m', 'raw tree'], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
  }).trim()
  git(cwd, 'update-ref', 'refs/heads/main', commit)
}

/** One `ls-tree -r -l -z` record whose path is raw bytes. */
function rawRecord(mode: string, type: string, size: string, pathBytes: Buffer | string): Buffer {
  return Buffer.concat([
    Buffer.from(`${mode} ${type} ${OID} ${size.padStart(7)}\t`),
    Buffer.from(pathBytes),
    Buffer.from([0]),
  ])
}

describe('repo-skills', () => {
  let root: string

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-skills-test-')))
  })

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
  })

  describe('createRepoSkillsStagingRoot', () => {
    it('creates a private run-scoped directory under the real RUNNER_TEMP', () => {
      // #given an absolute RUNNER_TEMP
      const runnerTemp = path.join(root, 'runner-temp')
      fs.mkdirSync(runnerTemp)

      // #when creating the staging root
      const created = unwrapOk(createRepoSkillsStagingRoot(runnerTemp))

      // #then it is a fresh directory directly under the temp dir, readable by the owner only
      expect(path.dirname(created)).toBe(runnerTemp)
      expect(path.basename(created)).toMatch(/^fro-bot-repo-skills-/)
      expect(fs.statSync(created).isDirectory()).toBe(true)
      expect(fs.statSync(created).mode & 0o077).toBe(0)
    })

    it.each([undefined, '', '   ', 'relative/tmp'])('refuses RUNNER_TEMP %j', runnerTemp => {
      // #given a missing or relative RUNNER_TEMP
      // #when creating the staging root
      const error = unwrapErr(createRepoSkillsStagingRoot(runnerTemp))

      // #then there is nowhere safe to stage, and the reason says why
      expect(error).toContain('RUNNER_TEMP')
    })

    it('refuses a path holding the wildcard characters the permission rules would read', () => {
      // #given a RUNNER_TEMP with a glob character
      const runnerTemp = path.join(root, 'tmp*glob')
      fs.mkdirSync(runnerTemp)

      // #when creating the staging root
      const error = unwrapErr(createRepoSkillsStagingRoot(runnerTemp))

      // #then it is refused: `<dir>/*` would also match a sibling
      expect(error).toContain('wildcard')
    })
  })

  describe('removeRepoSkillsStagingRoot', () => {
    it('removes the staging root and everything in it', async () => {
      // #given a staging root holding a copy
      const runnerTemp = path.join(root, 'runner-temp')
      fs.mkdirSync(runnerTemp)
      const staging = unwrapOk(createRepoSkillsStagingRoot(runnerTemp))
      writeFile(path.join(staging, 'skills', 'a', 'SKILL.md'), skillMd('a'))

      // #when removing it
      await removeRepoSkillsStagingRoot(staging, createMockLogger())

      // #then it is gone
      expect(fs.existsSync(staging)).toBe(false)
    })

    it('does nothing for null', async () => {
      // #given a run that staged nothing
      const remove = vi.fn(async () => undefined)

      // #when removing null
      await removeRepoSkillsStagingRoot(null, createMockLogger(), remove)

      // #then nothing is attempted
      expect(remove).not.toHaveBeenCalled()
    })

    it('refuses a path that is not a staging root', async () => {
      // #given a directory that could hold anything
      const other = path.join(root, 'precious')
      fs.mkdirSync(other)
      const logger = createMockLogger()

      // #when removing it
      await removeRepoSkillsStagingRoot(other, logger)

      // #then it survives and a warning says why
      expect(fs.existsSync(other)).toBe(true)
      expect(serializeLoggerCalls(logger)).toContain('unexpected name')
    })

    it('warns, and does not throw, when the removal fails', async () => {
      // #given a removal that fails
      const logger = createMockLogger()
      const failing = vi.fn(async () => {
        throw Object.assign(new Error('/secret/path'), {code: 'EBUSY'})
      })

      // #when removing a staging root
      await removeRepoSkillsStagingRoot(path.join(root, 'fro-bot-repo-skills-x'), logger, failing)

      // #then it warns with the error code and no path
      expect(logger.warning).toHaveBeenCalledTimes(1)
      expect(serializeLoggerCalls(logger)).toContain('EBUSY')
      expect(serializeLoggerCalls(logger)).not.toContain('/secret/path')
    })
  })

  describe('parseTreeListing', () => {
    const record = (mode: string, type: string, size: string, file: string): string =>
      `${mode} ${type} ${'a'.repeat(40)} ${size.padStart(7)}\t${file}\0`

    it('parses mode, type, size and path from every NUL-terminated record', () => {
      // #given a listing of a tree, a blob, a symlink and a gitlink
      const stdout =
        record('040000', 'tree', '-', '.agents/skills/a') +
        record('100644', 'blob', '1234567', '.agents/skills/a/SKILL.md') +
        record('120000', 'blob', '10', '.agents/skills/a/link') +
        record('160000', 'commit', '-', '.agents/skills/a/sub')

      // #when parsing
      const entries = unwrapOk(parseTreeListing(Buffer.from(stdout)))

      // #then each field is read, with a dash size as null
      expect(entries).toEqual([
        {mode: '040000', type: 'tree', oid: OID, size: null, path: '.agents/skills/a'},
        {mode: '100644', type: 'blob', oid: OID, size: 1_234_567, path: '.agents/skills/a/SKILL.md'},
        {mode: '120000', type: 'blob', oid: OID, size: 10, path: '.agents/skills/a/link'},
        {mode: '160000', type: 'commit', oid: OID, size: null, path: '.agents/skills/a/sub'},
      ])
    })

    it('keeps spaces, tabs and newlines in a path intact', () => {
      // #given a path with each of them (no -z quoting is involved)
      const stdout = record('100644', 'blob', '2', '.agents/skills/we ird/ta\tb\nc.md')

      // #when parsing
      const entries = unwrapOk(parseTreeListing(Buffer.from(stdout)))

      // #then the path is whole
      expect(entries[0]?.path).toBe('.agents/skills/we ird/ta\tb\nc.md')
    })

    it('parses the empty listing as no entries', () => {
      // #given / #when / #then
      expect(unwrapOk(parseTreeListing(Buffer.alloc(0)))).toEqual([])
    })

    it.each([
      ['a missing tab', `100644 blob ${'a'.repeat(40)}       3 path\0`],
      ['an unknown type', `100644 tag ${'a'.repeat(40)}       3\tpath\0`],
      ['a short mode', `644 blob ${'a'.repeat(40)}       3\tpath\0`],
      ['a bad object id', `100644 blob zzzz       3\tpath\0`],
      ['a bad size', `100644 blob ${'a'.repeat(40)}     x3y\tpath\0`],
      ['a missing terminator', `100644 blob ${'a'.repeat(40)}       3\tpath`],
    ])('fails closed on %s', (_label, stdout) => {
      // #given a record git would not write
      // #when parsing
      const error = unwrapErr(parseTreeListing(Buffer.from(stdout)))

      // #then it is an error, not a partial listing
      expect(error).toContain('listing')
    })
  })

  describe('parseTreeListing path integrity', () => {
    const P = '.agents/skills/'
    const listing = (...records: Buffer[]): Buffer => Buffer.concat(records)
    const file = (name: Buffer | string, mode = '100644', type = 'blob'): Buffer =>
      rawRecord(mode, type, type === 'tree' ? '-' : '1', Buffer.concat([Buffer.from(P), Buffer.from(name)]))
    const directory = (name: string): Buffer => file(name, '040000', 'tree')

    it.each([
      ['a lone invalid byte', Buffer.from([0x61, 0xff])],
      ['a truncated multi-byte sequence', Buffer.from([0x61, 0xc3])],
      ['an overlong encoding', Buffer.from([0xc0, 0xaf])],
      ['an encoded surrogate', Buffer.from([0xed, 0xa0, 0x80])],
      ['a continuation byte alone', Buffer.from([0x80])],
    ])('refuses the whole listing for %s, naming no path', (_label, name) => {
      // #given a valid git name that is not valid UTF-8, beside a clean entry
      // #when parsing the raw -z bytes
      const error = unwrapErr(parseTreeListing(listing(file('fine.md'), file(Buffer.concat([Buffer.from('x'), name])))))

      // #then it is refused for its encoding, and the message holds no part of the path
      expect(error).toContain('UTF-8')
      expect(error).not.toContain('fine')
      expect(error).not.toContain('x')
    })

    it('decodes two different invalid names to no string at all instead of one shared replacement character', () => {
      // #given the reviewer's pair, which a lossy decode would collapse into one name
      const first = Buffer.concat([Buffer.from('lnk'), Buffer.from([0xfe])])
      const second = Buffer.concat([Buffer.from('lnk'), Buffer.from([0xff])])

      // #when parsing each
      // #then both are refused
      expect(parseTreeListing(listing(file(first))).success).toBe(false)
      expect(parseTreeListing(listing(file(second))).success).toBe(false)
    })

    it('accepts valid multi-byte names, including a literal U+FFFD', () => {
      // #given accented, emoji and replacement-character names, all valid UTF-8
      const entries = unwrapOk(
        parseTreeListing(listing(file('caf\u00E9.md'), file('\u{1F680}.md'), file('odd\uFFFD.md'))),
      )

      // #then they parse to the strings they spell
      expect(entries.map(entry => entry.path)).toEqual([`${P}caf\u00E9.md`, `${P}\u{1F680}.md`, `${P}odd\uFFFD.md`])
    })

    it('keeps a leading byte-order mark in a path instead of silently dropping it', () => {
      // #given a path that begins with U+FEFF (a lenient decoder strips it, merging two names)
      const entries = unwrapOk(parseTreeListing(listing(rawRecord('100644', 'blob', '1', '\uFEFF.agents/skills/a.md'))))

      // #then the mark is part of the path
      expect(entries[0]?.path).toBe('\uFEFF.agents/skills/a.md')
    })

    it('refuses a path listed twice', () => {
      // #given the same path twice
      const error = unwrapErr(parseTreeListing(listing(file('a.md'), file('a.md'))))

      // #then
      expect(error).toContain('duplicate')
    })

    it.each([
      ['case', 'Skill.md', 'skill.md'],
      ['Unicode normalization', 'caf\u00E9.md', 'cafe\u0301.md'],
    ])('refuses two paths that differ only by %s, which a folding filesystem would merge', (_label, one, two) => {
      // #given two names one filesystem entry could hold
      const error = unwrapErr(parseTreeListing(listing(file(one), file(two))))

      // #then
      expect(error).toContain('duplicate')
    })

    it.each([
      ['a blob', '100644', 'blob'],
      ['a symlink', '120000', 'blob'],
    ])('refuses %s that is also the directory of another entry', (_label, mode, type) => {
      // #given `a/b` as a non-tree entry and `a/b/c` beneath it
      const error = unwrapErr(parseTreeListing(listing(file('a/b', mode, type), file('a/b/c'))))

      // #then
      expect(error).toContain('directory')
    })

    it('refuses a non-tree entry that is an ancestor of a deeper one regardless of listing order', () => {
      // #given the deeper path listed first
      const error = unwrapErr(parseTreeListing(listing(file('a/b/c'), file('a/b'))))

      // #then
      expect(error).toContain('directory')
    })

    it('accepts a tree entry with its children', () => {
      // #given an ordinary directory and its file
      // #then
      expect(
        parseTreeListing(listing(directory('a'), file('a/b.md'), directory('a/c'), file('a/c/d.md'))).success,
      ).toBe(true)
    })
  })

  describe('checkSourceBudget', () => {
    const entry = (type: 'blob' | 'commit' | 'tree', file: string, size: number | null = 1, mode = '100644') => ({
      mode,
      type,
      oid: OID,
      size,
      path: `.agents/skills/${file}`,
    })

    it('ignores the ancestor trees that ls-tree prints above the skills root', () => {
      // #given the .agents and .agents/skills entries and one file
      const entries = [
        {mode: '040000', type: 'tree' as const, oid: OID, size: null, path: '.agents'},
        {mode: '040000', type: 'tree' as const, oid: OID, size: null, path: '.agents/skills'},
        entry('tree', 'a', null, '040000'),
        entry('blob', 'a/SKILL.md'),
      ]

      // #when checking with room for exactly the two real entries
      const verdict = checkSourceBudget(entries, {...DEFAULT_REPO_SKILLS_LIMITS, maxSourceEntries: 2})

      // #then it fits
      expect(verdict.success).toBe(true)
    })

    it('counts every kind of entry, trees and symlinks included', () => {
      // #given three trees and one symlink
      const entries = [
        entry('tree', 'a', null, '040000'),
        entry('tree', 'a/b', null, '040000'),
        entry('tree', 'a/b/c', null, '040000'),
        entry('blob', 'a/b/c/link', 4, '120000'),
      ]

      // #when the budget is three entries
      const error = unwrapErr(checkSourceBudget(entries, {...DEFAULT_REPO_SKILLS_LIMITS, maxSourceEntries: 3}))

      // #then it is over, naming the count and not a path
      expect(error).toContain('4 entries')
      expect(error).not.toContain('link')
    })

    it('sums blob sizes and is over by one byte', () => {
      // #given two blobs one byte over the limit
      const limits = {...DEFAULT_REPO_SKILLS_LIMITS, maxBytes: 100}
      const over = [entry('blob', 'a/SKILL.md', 60), entry('blob', 'a/big.md', 41)]
      const at = [entry('blob', 'a/SKILL.md', 60), entry('blob', 'a/big.md', 40)]

      // #when checking
      // #then one byte over fails and exactly at the limit passes
      expect(unwrapErr(checkSourceBudget(over, limits))).toContain('101 bytes')
      expect(checkSourceBudget(at, limits).success).toBe(true)
    })

    it('refuses a submodule anywhere under the skills root', () => {
      // #given a gitlink inside a skill
      const entries = [entry('commit', 'a/sub', null, '160000')]

      // #when checking
      const error = unwrapErr(checkSourceBudget(entries, DEFAULT_REPO_SKILLS_LIMITS))

      // #then the whole source is refused
      expect(error).toContain('submodule')
    })

    it('admits a file exactly maxDepth directories below its skill and refuses one deeper', () => {
      // #given files six and seven directories below the skill directory
      const atLimit = entry('blob', 'skill/a/b/c/d/e/f/file.md')
      const tooDeep = entry('blob', 'skill/a/b/c/d/e/f/g/file.md')

      // #when checking with the default depth of six
      // #then six passes and seven fails
      expect(checkSourceBudget([atLimit], DEFAULT_REPO_SKILLS_LIMITS).success).toBe(true)
      expect(unwrapErr(checkSourceBudget([tooDeep], DEFAULT_REPO_SKILLS_LIMITS))).toContain('deep')
    })
  })

  describe('safeRelativeSkillPath', () => {
    it('accepts a plain path under the skills root', () => {
      // #given / #when / #then
      expect(unwrapOk(safeRelativeSkillPath('.agents/skills/a/references/x.md'))).toBe(
        '.agents/skills/a/references/x.md',
      )
    })

    it.each([
      ['a parent segment', '.agents/skills/../escape'],
      ['a nested parent segment', '.agents/skills/a/../../../escape'],
      ['a dot segment', '.agents/skills/./x'],
      ['an empty segment', '.agents/skills//x'],
      ['a trailing slash', '.agents/skills/a/'],
      ['an absolute path', '/etc/passwd'],
      ['a path outside the skills root', '.agents/other/x'],
      ['a NUL byte', '.agents/skills/a\0b'],
    ])('refuses %s', (_label, entryPath) => {
      // #given a path git would not produce
      // #when validating
      const error = unwrapErr(safeRelativeSkillPath(entryPath))

      // #then it is refused without echoing the path
      expect(error).toContain('unsafe')
      expect(error).not.toContain('escape')
    })
  })

  describe('parseCatFileBatch', () => {
    const expected = (...sizes: number[]) => sizes.map(size => ({oid: OID, size}))

    it('returns each blob body, byte for byte, including NUL and newline bytes', () => {
      // #given two frames, one with awkward bytes and one empty
      const first = Buffer.from([0x24, 0x0a, 0x00, 0xff, 0x0a])
      const raw = Buffer.concat([frame(OID, first), frame(OID, '')])

      // #when parsing against the listing
      const bodies = unwrapOk(parseCatFileBatch(raw, expected(5, 0), DEFAULT_REPO_SKILLS_LIMITS.maxBytes))

      // #then the bodies are exact
      expect(bodies.map(body => [...body])).toEqual([[...first], []])
    })

    it.each([
      ['a different object id', frame('b'.repeat(40), 'abc'), 'mismatch'],
      ['a non-blob type', frame(OID, 'abc', 'tree'), 'mismatch'],
      ['a smaller size than listed', frame(OID, 'ab'), 'mismatch'],
      ['a missing object', Buffer.from(`${OID} missing\n`), 'missing'],
      ['a header with no newline', Buffer.from(`${OID} blob 3`), 'truncated'],
      ['a body cut short', Buffer.concat([Buffer.from(`${OID} blob 3\nab`)]), 'truncated'],
      ['a missing terminator', Buffer.from(`${OID} blob 3\nabc`), 'truncated'],
      ['a wrong terminator', Buffer.from(`${OID} blob 3\nabcX`), 'truncated'],
      ['a garbled header', Buffer.from('hello world\nabc\n'), 'mismatch'],
      ['trailing bytes after the last frame', Buffer.concat([frame(OID, 'abc'), Buffer.from('extra')]), 'trailing'],
    ])('fails closed on %s', (_label, raw, word) => {
      // #given output that disagrees with a listing of one three-byte blob
      // #when parsing
      const error = unwrapErr(parseCatFileBatch(raw, expected(3), DEFAULT_REPO_SKILLS_LIMITS.maxBytes))

      // #then it is refused, naming the kind of problem and no content
      expect(error).toContain(word)
      expect(error).not.toContain('abc')
    })

    it('stops at a declared size larger than the listing without reading the body', () => {
      // #given a header that claims far more than the listing, with no body behind it
      const raw = Buffer.from(`${OID} blob 99999999\n`)

      // #when parsing
      const error = unwrapErr(parseCatFileBatch(raw, expected(3), DEFAULT_REPO_SKILLS_LIMITS.maxBytes))

      // #then the running counter refused it
      expect(error).toContain('exceeds')
    })

    it('aborts when the running total passes maxBytes even if every size matches its listing', () => {
      // #given a listing that itself is over the byte limit (defense in depth)
      const raw = Buffer.concat([frame(OID, 'abcd'), frame(OID, 'efgh')])

      // #when parsing with a limit of seven bytes
      const error = unwrapErr(parseCatFileBatch(raw, expected(4, 4), 7))

      // #then the counter stopped it
      expect(error).toContain('exceeds')
    })

    it('fails when fewer frames arrive than the listing has blobs', () => {
      // #given one frame for two blobs
      const error = unwrapErr(parseCatFileBatch(frame(OID, 'abc'), expected(3, 3), DEFAULT_REPO_SKILLS_LIMITS.maxBytes))

      // #then it is truncated
      expect(error).toContain('truncated')
    })
  })

  describe('admitRepoSkills', () => {
    let source: string
    let staging: string
    let bundled: string

    beforeEach(() => {
      source = path.join(root, 'source')
      staging = path.join(root, 'staging')
      bundled = path.join(root, 'bundled', '@fro.bot', 'systematic', 'skills')
      fs.mkdirSync(source)
      fs.mkdirSync(staging)
      writeFile(path.join(bundled, 'ce-review', 'SKILL.md'), skillMd('ce:review'))
      writeFile(path.join(bundled, 'git-commit', 'SKILL.md'), skillMd('git-commit'))
    })

    async function admit(limits?: {maxFiles?: number; maxBytes?: number}) {
      const logger = createMockLogger()
      const result = await admitRepoSkills({
        sourceDir: source,
        stagingRoot: staging,
        bundledSkillsDirectories: [bundled],
        logger,
        ...(limits === undefined ? {} : {limits}),
      })
      return {result, logger}
    }

    it('leaves only the exposed directory behind: no scratch space and no extracted source tree', async () => {
      // #given a skill and a leftover extracted tree
      writeFile(path.join(source, 'repo-probe', 'SKILL.md'), skillMd('repo-probe'))
      writeFile(path.join(staging, 'source-tree', 'x'), 'x')

      // #when admitting
      const {result} = await admit()

      // #then the copy was staged through scratch and the scratch is gone, so only skills/ remains
      expect(unwrapOk(result).admitted).toEqual(['repo-probe'])
      expect(fs.readdirSync(staging)).toEqual([REPO_SKILLS_DIRECTORY_NAME])
      expect(fs.readdirSync(path.join(staging, REPO_SKILLS_DIRECTORY_NAME))).toEqual(['repo-probe'])
    })

    it('rejects exactly the skills named as holding a symlink, even though no link is on disk, and keeps the rest', async () => {
      // #given two clean-looking skills on disk, one of which staging reported as holding a symlink
      writeFile(path.join(source, 'tainted', 'SKILL.md'), skillMd('tainted'))
      writeFile(path.join(source, 'clean', 'SKILL.md'), skillMd('clean'))

      // #when admitting with that report
      const logger = createMockLogger()
      const admitted = unwrapOk(
        await admitRepoSkills({
          sourceDir: source,
          stagingRoot: staging,
          bundledSkillsDirectories: [bundled],
          symlinkedSkillIds: ['tainted'],
          logger,
        }),
      )

      // #then only the reported one is rejected, with the symlink reason and the usual log
      expect(admitted.admitted).toEqual(['clean'])
      expect(admitted.skipped).toEqual([{id: 'tainted', reason: 'symlink'}])
      expect(fs.existsSync(path.join(staging, 'skills', 'tainted'))).toBe(false)
      expect(logger.warning).toHaveBeenCalledWith('Skipped a repository skill', {id: 'tainted', reason: 'symlink'})
    })

    it('reports a symlinked skill that has no directory on disk, with a log-safe id', async () => {
      // #given a reported id with no directory (the whole skill was a link) and a hostile-looking name
      writeFile(path.join(source, 'clean', 'SKILL.md'), skillMd('clean'))

      // #when admitting
      const admitted = unwrapOk(
        await admitRepoSkills({
          sourceDir: source,
          stagingRoot: staging,
          bundledSkillsDirectories: [bundled],
          symlinkedSkillIds: ['gone', 'bad\nname'],
          logger: createMockLogger(),
        }),
      )

      // #then each is reported once as a symlink, the newline neutralized
      expect(admitted.skipped.map(skill => skill.id).toSorted()).toEqual(['bad?name', 'gone'])
      expect(admitted.skipped.every(skill => skill.reason === 'symlink')).toBe(true)
      expect(admitted.admitted).toEqual(['clean'])
    })

    it('copies a skill with its references and scripts into the run-scoped skills directory', async () => {
      // #given a skill with nested regular files
      writeFile(path.join(source, 'repo-probe', 'SKILL.md'), skillMd('repo-probe'))
      writeFile(path.join(source, 'repo-probe', 'references', 'x.md'), 'reference body\n')
      writeFile(path.join(source, 'repo-probe', 'scripts', 'run.mjs'), 'console.log(1)\n')

      // #when admitting
      const {result} = await admit()

      // #then every file is copied byte for byte under <staging>/skills
      const admitted = unwrapOk(result)
      expect(admitted.directory).toBe(path.join(staging, REPO_SKILLS_DIRECTORY_NAME))
      expect(admitted.admitted).toEqual(['repo-probe'])
      expect(admitted.skipped).toEqual([])
      expect(listFiles(admitted.directory as string)).toEqual([
        'repo-probe/SKILL.md',
        'repo-probe/references/x.md',
        'repo-probe/scripts/run.mjs',
      ])
      expect(fs.readFileSync(path.join(admitted.directory as string, 'repo-probe', 'references', 'x.md'), 'utf8')).toBe(
        'reference body\n',
      )
    })

    it('rejects a skill containing a symlinked file and copies none of it', async () => {
      // #given a skill whose reference is a symlink to a file outside the source
      const secret = path.join(root, 'secret.txt')
      fs.writeFileSync(secret, 'TOP-SECRET')
      writeFile(path.join(source, 'linky', 'SKILL.md'), skillMd('linky'))
      fs.mkdirSync(path.join(source, 'linky', 'references'))
      fs.symlinkSync(secret, path.join(source, 'linky', 'references', 'leak.md'))
      writeFile(path.join(source, 'fine', 'SKILL.md'), skillMd('fine'))

      // #when admitting
      const {result} = await admit()

      // #then the whole skill is skipped, the sibling is admitted, and nothing links outside
      const admitted = unwrapOk(result)
      expect(admitted.skipped).toEqual([{id: 'linky', reason: 'symlink'}])
      expect(admitted.admitted).toEqual(['fine'])
      expect(listFiles(admitted.directory as string)).toEqual(['fine/SKILL.md'])
    })

    it('rejects a symlinked skill directory without following it', async () => {
      // #given a skill directory that is a symlink to a real skill outside the source
      writeFile(path.join(root, 'outside', 'real', 'SKILL.md'), skillMd('real'))
      fs.symlinkSync(path.join(root, 'outside', 'real'), path.join(source, 'real'))

      // #when admitting
      const {result} = await admit()

      // #then it is skipped and nothing is copied
      const admitted = unwrapOk(result)
      expect(admitted.skipped).toEqual([{id: 'real', reason: 'symlink'}])
      expect(admitted.admitted).toEqual([])
      expect(admitted.directory).toBeNull()
    })

    it('rejects a skill whose SKILL.md is a symlink', async () => {
      // #given SKILL.md pointing at a file outside the skill
      writeFile(path.join(root, 'outside.md'), skillMd('outside'))
      fs.mkdirSync(path.join(source, 'linked-md'))
      fs.symlinkSync(path.join(root, 'outside.md'), path.join(source, 'linked-md', 'SKILL.md'))

      // #when admitting
      const {result} = await admit()

      // #then it is skipped
      expect(unwrapOk(result).skipped).toEqual([{id: 'linked-md', reason: 'symlink'}])
    })

    it('rejects a directory that has no SKILL.md', async () => {
      // #given a directory with references but no SKILL.md
      writeFile(path.join(source, 'no-skill', 'references', 'x.md'), 'x')

      // #when admitting
      const {result} = await admit()

      // #then it is skipped as not a skill
      const admitted = unwrapOk(result)
      expect(admitted.skipped).toEqual([{id: 'no-skill', reason: 'missing-skill-md'}])
      expect(admitted.directory).toBeNull()
    })

    it('does not admit flat markdown files, dot entries or stray files in the root', async () => {
      // #given OpenCode's depth-0 flat `*.md` skill form, a dot directory and a stray file
      writeFile(path.join(source, 'flat.md'), skillMd('flat'))
      writeFile(path.join(source, '.hidden', 'SKILL.md'), skillMd('hidden'))
      writeFile(path.join(source, 'README.txt'), 'hi')
      writeFile(path.join(source, 'good', 'SKILL.md'), skillMd('good'))
      writeFile(path.join(source, 'good', '.dotfile'), 'x')

      // #when admitting
      const {result} = await admit()

      // #then only the real skill directory lands, without its dot file
      const admitted = unwrapOk(result)
      expect(listFiles(admitted.directory as string)).toEqual(['good/SKILL.md'])
      expect(admitted.skipped).toEqual([])
    })

    it('skips a skill whose id collides with a bundled skill, naming the id only', async () => {
      // #given a repo skill that would shadow the bundled ce-review
      writeFile(path.join(source, 'ce-review', 'SKILL.md'), skillMd('totally-different', 'EVIL-BODY-CANARY'))
      writeFile(path.join(source, 'ok', 'SKILL.md'), skillMd('ok'))

      // #when admitting
      const {result, logger} = await admit()

      // #then the repo skill is skipped, the other is admitted, and the warning has the id but no content
      const admitted = unwrapOk(result)
      expect(admitted.skipped).toEqual([{id: 'ce-review', reason: 'collides-with-bundled'}])
      expect(admitted.admitted).toEqual(['ok'])
      const logged = serializeLoggerCalls(logger)
      expect(logged).toContain('ce-review')
      expect(logged).not.toContain('EVIL-BODY-CANARY')
    })

    it.each(['report', 'opencode', 'browser'])(
      'skips a skill that would replace the OpenCode built-in %s',
      async id => {
        // #given a repo skill with the id of a skill the server registers itself
        writeFile(path.join(source, id, 'SKILL.md'), skillMd(id, 'BUILTIN-SHADOW'))

        // #when admitting
        const {result} = await admit()

        // #then it is skipped like a bundled collision
        expect(unwrapOk(result).skipped).toEqual([{id, reason: 'collides-with-bundled'}])
      },
    )

    it('skips a directory named like a bundled skill id, colon included', async () => {
      // #given a directory literally named `ce:review`, which OpenCode would register under that id
      writeFile(path.join(source, 'ce:review', 'SKILL.md'), skillMd('anything', 'COLON-SHADOW'))

      // #when admitting
      const {result} = await admit()

      // #then it is reported as the collision it is, not as a malformed id
      expect(unwrapOk(result).skipped).toEqual([{id: 'ce?review', reason: 'collides-with-bundled'}])
    })

    it.each([
      ['a bare reserved name', 'name: ce:review'],
      ['a quoted reserved name', 'name: "ce:review"'],
      ['a reserved name with a trailing comment', 'name: ce:review # looks bundled'],
      ['a block scalar', 'name: >-\n  ce:review'],
      ['an anchor', 'name: &n ce:review'],
    ])('admits a skill whose frontmatter has %s, since only the directory name registers it', async (_label, line) => {
      // #given a skill in directory `foo` whose frontmatter name is awkward or a bundled skill's name
      writeFile(path.join(source, 'foo', 'SKILL.md'), `---\n${line}\ndescription: d\n---\n\nbody\n`)

      // #when admitting
      const {result} = await admit()

      // #then it is admitted under `foo`: OpenCode 2.2.6 keys the registry by directory name and treats `name` as display
      // text (real-binary test), so the frontmatter is neither read nor trusted for admission
      const admitted = unwrapOk(result)
      expect(admitted.admitted).toEqual(['foo'])
      expect(admitted.skipped).toEqual([])
    })

    it.each([
      ['has space', 'has?space'],
      ['semi;colon', 'semi?colon'],
      ['star*', 'star?'],
      ['q?', 'q?'],
      ['-leading', '-leading'],
    ])('skips the unsafe skill id %j, reporting it as %j', async (id, reported) => {
      // #given a skill directory whose name is not a plain identifier
      writeFile(path.join(source, id, 'SKILL.md'), skillMd('x'))

      // #when admitting
      const {result} = await admit()

      // #then it is skipped, and the reported id carries only log-safe characters
      expect(unwrapOk(result).skipped).toEqual([{id: reported, reason: 'invalid-id'}])
    })

    it('bounds the total size: a skill that would exceed it is skipped, smaller ones still land', async () => {
      // #given a big skill sorted first and a small one after it
      writeFile(path.join(source, 'a-big', 'SKILL.md'), skillMd('a-big'))
      writeFile(path.join(source, 'a-big', 'references', 'huge.md'), 'x'.repeat(2048))
      writeFile(path.join(source, 'b-small', 'SKILL.md'), skillMd('b-small'))

      // #when admitting under a 1 KiB bound
      const {result} = await admit({maxBytes: 1024})

      // #then the big skill is skipped for size and the small one is admitted
      const admitted = unwrapOk(result)
      expect(admitted.skipped).toEqual([{id: 'a-big', reason: 'too-large'}])
      expect(admitted.admitted).toEqual(['b-small'])
    })

    it('bounds the file count across all skills', async () => {
      // #given three one-file skills
      for (const id of ['s1', 's2', 's3']) writeFile(path.join(source, id, 'SKILL.md'), skillMd(id))

      // #when admitting under a 2-file bound
      const {result} = await admit({maxFiles: 2})

      // #then the third is skipped for count
      const admitted = unwrapOk(result)
      expect(admitted.admitted).toEqual(['s1', 's2'])
      expect(admitted.skipped).toEqual([{id: 's3', reason: 'too-many-files'}])
    })

    it('refuses everything when the bundled skills directory is unknown, since collisions cannot be ruled out', async () => {
      // #given no resolved bundled skills directory
      writeFile(path.join(source, 'ok', 'SKILL.md'), skillMd('ok'))

      // #when admitting
      const result = await admitRepoSkills({
        sourceDir: source,
        stagingRoot: staging,
        bundledSkillsDirectories: [],
        logger: createMockLogger(),
      })

      // #then fail closed
      expect(unwrapErr(result)).toContain('bundled')
    })

    it('refuses a source directory that is a symlink', async () => {
      // #given the source root itself is a symlink
      const real = path.join(root, 'real-source')
      writeFile(path.join(real, 'ok', 'SKILL.md'), skillMd('ok'))
      const link = path.join(root, 'link-source')
      fs.symlinkSync(real, link)

      // #when admitting
      const result = await admitRepoSkills({
        sourceDir: link,
        stagingRoot: staging,
        bundledSkillsDirectories: [bundled],
        logger: createMockLogger(),
      })

      // #then it is refused
      expect(unwrapErr(result)).toContain('symbolic link')
    })

    it('removes any extracted source tree from the staging root once admitted', async () => {
      // #given an extracted tree inside the staging root
      const extracted = path.join(staging, 'source-tree', '.agents', 'skills')
      writeFile(path.join(extracted, 'ok', 'SKILL.md'), skillMd('ok'))

      // #when admitting from it
      const result = await admitRepoSkills({
        sourceDir: extracted,
        stagingRoot: staging,
        bundledSkillsDirectories: [bundled],
        logger: createMockLogger(),
      })

      // #then the tree is gone and only the admitted copy remains
      expect(unwrapOk(result).admitted).toEqual(['ok'])
      expect(fs.existsSync(path.join(staging, 'source-tree'))).toBe(false)
    })
  })

  // Each case spawns several git processes, which is slow on a loaded machine: a bound well above the 5 s default.
  describe('stageDefaultBranchSkills', {timeout: 30_000}, () => {
    let server: string
    let origin: string
    let workspace: string
    let staging: string

    const serverUrl = (): string => `file://${server}`

    /**
     * A "GitHub" at `<root>/server/fro-bot/agent.git` whose main carries the reviewed skill, a workspace cloned from it,
     * and a checked-out feature branch that rewrites it (the "PR head" or a dispatched branch). One shell spawn: process
     * spawns are slow on some machines.
     */
    function setUpRepos(): void {
      server = path.join(root, 'server')
      origin = path.join(server, 'fro-bot', 'agent.git')
      workspace = path.join(root, 'workspace')
      staging = path.join(root, 'staging')
      fs.mkdirSync(staging)
      const skills = path.join(origin, '.agents', 'skills')
      writeFile(path.join(skills, 'probe', 'SKILL.md'), skillMd('probe', 'MAIN-VERSION'))
      writeFile(path.join(skills, 'probe', 'references', 'r.md'), 'main reference\n')
      execFileSync(
        'sh',
        [
          '-ec',
          [
            `cd "${origin}"`,
            'git init -q -b main',
            'git add -A',
            'git commit -qm main',
            `git clone -q "${origin}" "${workspace}"`,
            `cd "${workspace}"`,
            'git checkout -qb feature',
          ].join('\n'),
        ],
        {env: GIT_ENV},
      )
      writeFile(path.join(workspace, '.agents', 'skills', 'probe', 'SKILL.md'), skillMd('probe', 'PR-HEAD-VERSION'))
      writeFile(path.join(workspace, '.agents', 'skills', 'added-by-pr', 'SKILL.md'), skillMd('added-by-pr'))
      git(workspace, 'add', '-A')
      git(workspace, 'commit', '-qm', 'pr')
    }

    async function stageDir(overrides: Partial<Parameters<typeof stageDefaultBranchSkills>[0]> = {}) {
      return unwrapOk(await stage(overrides))?.sourceDir ?? null
    }

    /** Directories only, for tests where git must not (or cannot) run. */
    function setUpBareDirectories(): void {
      staging = path.join(root, 'staging')
      fs.mkdirSync(staging)
    }

    async function stage(overrides: Partial<Parameters<typeof stageDefaultBranchSkills>[0]> = {}) {
      return stageDefaultBranchSkills({
        exec: createExecAdapter(),
        repository: 'fro-bot/agent',
        defaultBranch: 'main',
        stagingRoot: staging,
        logger: createMockLogger(),
        env: GIT_ENV,
        serverUrl: serverUrl(),
        ...overrides,
      })
    }

    it('reads the default branch tree fetched fresh, never the checked-out PR head', async () => {
      // #given a checkout on a branch that rewrites a skill and adds another
      setUpRepos()

      // #when staging
      const sourceDir = (await stageDir()) as string

      // #then the extracted tree is main's content, with the branch's additions absent
      expect(sourceDir).toBe(path.join(staging, 'source-tree', '.agents', 'skills'))
      expect(listFiles(sourceDir)).toEqual(['probe/SKILL.md', 'probe/references/r.md'])
      const body = fs.readFileSync(path.join(sourceDir, 'probe', 'SKILL.md'), 'utf8')
      expect(body).toContain('MAIN-VERSION')
      expect(body).not.toContain('PR-HEAD-VERSION')
    })

    it('ignores a stale or planted refs/remotes/origin/main in the checkout and uses the current default branch', async () => {
      // #given a checkout whose origin/main is planted at the feature commit, and a default branch that has moved on
      setUpRepos()
      git(workspace, 'update-ref', 'refs/remotes/origin/main', 'feature')
      writeFile(path.join(origin, '.agents', 'skills', 'probe', 'SKILL.md'), skillMd('probe', 'MAIN-MOVED-ON'))
      git(origin, 'commit', '-qam', 'moved on')

      // #when staging
      const sourceDir = (await stageDir()) as string

      // #then the fresh fetch won: neither the planted ref nor the checkout's old origin/main is read
      const body = fs.readFileSync(path.join(sourceDir, 'probe', 'SKILL.md'), 'utf8')
      expect(body).toContain('MAIN-MOVED-ON')
      expect(body).not.toContain('PR-HEAD-VERSION')
    })

    it('never runs git in the checkout and leaves its refs, shallow state and config alone', async () => {
      // #given a full-history checkout with a hostile insteadOf rewrite in its config
      setUpRepos()
      git(workspace, 'config', `url.file://${root}/evil/.insteadOf`, `${serverUrl()}/`)
      const before = git(workspace, 'for-each-ref')
      const {exec, calls} = recordingExec()

      // #when staging
      const sourceDir = (await stageDir({exec})) as string

      // #then every command ran in the staging root, the rewrite did not redirect the fetch, and the checkout is unchanged
      expect(calls.length).toBeGreaterThan(0)
      expect(new Set(calls.map(call => call.cwd))).toEqual(new Set([staging]))
      expect(fs.readFileSync(path.join(sourceDir, 'probe', 'SKILL.md'), 'utf8')).toContain('MAIN-VERSION')
      expect(git(workspace, 'for-each-ref')).toBe(before)
      expect(fs.existsSync(path.join(workspace, '.git', 'shallow'))).toBe(false)
    })

    it('fetches one commit from the base repository URL into a private ref, then removes the throwaway repository', async () => {
      // #given a recording adapter
      setUpRepos()
      const {exec, calls} = recordingExec()

      // #when staging
      unwrapOk(await stage({exec}))

      // #then the fetch was shallow, from the base repository, into a ref named for this staging root
      const fetchCall = calls.find(call => call.args.includes('fetch'))
      expect(fetchCall?.args).toEqual(
        expect.arrayContaining([
          '--depth=1',
          '--no-tags',
          `${serverUrl()}/fro-bot/agent.git`,
          `+refs/heads/main:refs/fro-bot/repo-skills/${path.basename(staging)}`,
        ]),
      )
      // #and the listing read that exact private ref, blobs came from cat-file in the throwaway repository, and nothing
      // but the extracted tree remains
      const listCall = calls.find(call => call.args.includes('ls-tree'))
      expect(listCall?.args).toContain(`refs/fro-bot/repo-skills/${path.basename(staging)}`)
      const catCall = calls.find(call => call.args.includes('cat-file'))
      expect(catCall?.args).toEqual([`--git-dir=${path.join(staging, 'fetch.git')}`, 'cat-file', '--batch'])
      expect(fs.readdirSync(staging)).toEqual(['source-tree'])
    })

    it('returns null when the default branch has no .agents/skills', async () => {
      // #given a default branch without skills (the branch the workspace is on still has them)
      setUpRepos()
      git(origin, 'rm', '-rq', '.agents')
      git(origin, 'commit', '-qm', 'drop')

      // #when staging
      const staged = await stage()

      // #then there is nothing to admit, and the workspace's skills are not substituted
      expect(unwrapOk(staged)).toBeNull()
    })

    it('writes no symlink, reports the skills that held one, and admission rejects exactly those', async () => {
      // #given a default branch with a symlink inside one skill, a symlink AS a skill directory, and a clean sibling
      setUpRepos()
      fs.symlinkSync('/etc/hosts', path.join(origin, '.agents', 'skills', 'probe', 'references', 'link.md'))
      fs.symlinkSync('probe', path.join(origin, '.agents', 'skills', 'linked'))
      writeFile(path.join(origin, '.agents', 'skills', 'other', 'SKILL.md'), skillMd('other'))
      git(origin, 'add', '-A')
      git(origin, 'commit', '-qm', 'link')
      const bundled = path.join(root, 'bundled', '@fro.bot', 'systematic', 'skills')
      writeFile(path.join(bundled, 'ce-review', 'SKILL.md'), skillMd('ce:review'))
      const {exec, inputs} = fakeExecOverReal()

      // #when staging and admitting with what staging reported
      const staged = unwrapOk(await stage({exec})) as StagedSkills
      const onDisk = fs.readdirSync(staged.sourceDir, {recursive: true, withFileTypes: true})
      const logger = createMockLogger()
      const admitted = unwrapOk(
        await admitRepoSkills({
          sourceDir: staged.sourceDir,
          stagingRoot: staging,
          bundledSkillsDirectories: [bundled],
          symlinkedSkillIds: staged.symlinkedSkillIds,
          logger,
        }),
      )

      // #then nothing on disk is a symlink, the link entries were never even read, and the ids were reported
      expect(onDisk.some(entry => entry.isSymbolicLink())).toBe(false)
      expect(fs.existsSync(path.join(staged.sourceDir, 'linked'))).toBe(false)
      expect(fs.existsSync(path.join(staged.sourceDir, 'probe', 'references', 'link.md'))).toBe(false)
      expect(staged.symlinkedSkillIds.toSorted()).toEqual(['linked', 'probe'])
      expect(inputs).toHaveLength(1)
      // #and admission rejects those two as symlinks, whether or not a directory exists for them, and keeps the sibling
      expect(admitted.skipped.toSorted((x, y) => x.id.localeCompare(y.id))).toEqual([
        {id: 'linked', reason: 'symlink'},
        {id: 'probe', reason: 'symlink'},
      ])
      expect(admitted.admitted).toEqual(['other'])
      expect(serializeLoggerCalls(logger)).toContain('symlink')
    })

    it('reports a clean tree with no symlinked skill ids', async () => {
      // #given the plain fixture
      setUpRepos()

      // #when staging
      const staged = unwrapOk(await stage()) as StagedSkills

      // #then there is nothing to reject
      expect(staged.symlinkedSkillIds).toEqual([])
    })

    it('refuses the whole source when two names alias through different invalid UTF-8 bytes', async () => {
      // #given a tree where `lnk\xfe` (a symlink to the exposed skills directory) and `lnk\xff` (a directory holding a
      // reserved `report` skill) both decode to `lnk\uFFFD`: the old writer made the link, then wrote the reserved skill
      // through it into the exposed directory
      setUpRepos()
      const reserved = hashObject(origin, 'RESERVED-SKILL-PLANTED\n')
      const link = hashObject(origin, '../../../skills')
      const reportTree = mktree(origin, [{mode: '100644', type: 'blob', oid: reserved, name: 'SKILL.md'}])
      const aliasTree = mktree(origin, [{mode: '040000', type: 'tree', oid: reportTree, name: 'report'}])
      const okTree = mktree(origin, [
        {mode: '100644', type: 'blob', oid: hashObject(origin, skillMd('ok')), name: 'SKILL.md'},
      ])
      const skillsTree = mktree(origin, [
        {mode: '120000', type: 'blob', oid: link, name: Buffer.from([0x6c, 0x6e, 0x6b, 0xfe])},
        {mode: '040000', type: 'tree', oid: aliasTree, name: Buffer.from([0x6c, 0x6e, 0x6b, 0xff])},
        {mode: '040000', type: 'tree', oid: okTree, name: 'ok'},
      ])
      const agentsTree = mktree(origin, [{mode: '040000', type: 'tree', oid: skillsTree, name: 'skills'}])
      commitAsMain(origin, mktree(origin, [{mode: '040000', type: 'tree', oid: agentsTree, name: '.agents'}]))
      fs.mkdirSync(path.join(staging, 'skills'))

      // #when staging
      const error = unwrapErr(await stage())

      // #then the source is refused for its encoding, naming no path, and nothing reached the exposed directory
      expect(error).toContain('UTF-8')
      expect(error).not.toContain('lnk')
      expect(fs.readdirSync(path.join(staging, 'skills'))).toEqual([])
      expect(fs.readdirSync(staging)).toEqual(['skills'])
    })

    it('fails closed when the default branch cannot be fetched, with no fallback to the checkout', async () => {
      // #given a base repository that does not exist, and a checkout that has everything
      setUpRepos()

      // #when staging
      const error = unwrapErr(await stage({repository: 'fro-bot/missing'}))

      // #then it is an error naming the step, nothing was extracted, and the throwaway repository is gone
      expect(error).toContain('fetch the default branch')
      expect(fs.readdirSync(staging)).toEqual([])
    })

    it('fails closed when reading the blobs times out', async () => {
      // #given an exec adapter whose cat-file step times out
      setUpRepos()
      const real = createExecAdapter()
      const exec: ExecAdapter = {
        ...real,
        execWithTimeout: async (command, args, timeoutMs, options) =>
          args?.includes('cat-file')
            ? 'timed-out'
            : (real.execWithTimeout as NonNullable<typeof real.execWithTimeout>)(command, args, timeoutMs, options),
      }

      // #when staging
      const error = unwrapErr(await stage({exec}))

      // #then it fails with a timeout message and cleans up after itself
      expect(error).toContain('timed out')
      expect(fs.readdirSync(staging)).toEqual([])
    })

    it('fails closed when the adapter cannot bound a command with a timeout', async () => {
      // #given an adapter without execWithTimeout
      setUpBareDirectories()
      const exec: ExecAdapter = {exec: vi.fn(), getExecOutput: vi.fn()}

      // #when staging
      const error = unwrapErr(await stage({exec}))

      // #then it refuses rather than running unbounded
      expect(error).toContain('timeout')
    })

    it.each(['--upload-pack=evil', '-x', '../escape', 'a b', 'main..other', 'x.lock', '', '/abs'])(
      'refuses the unsafe branch name %j before running git',
      async branch => {
        // #given a branch name that could be read as an option or path
        setUpBareDirectories()
        const calls: string[][] = []
        const exec: ExecAdapter = {
          exec: vi.fn(),
          getExecOutput: vi.fn(),
          execWithTimeout: async (_command, args) => {
            calls.push(args ?? [])
            return 0
          },
        }

        // #when staging
        const error = unwrapErr(await stage({exec, defaultBranch: branch}))

        // #then it is refused and git never ran
        expect(error).toContain('branch name')
        expect(calls).toEqual([])
      },
    )

    it.each(['', 'owner', 'owner/repo/extra', '-x/y', 'a b/c'])(
      'refuses the unsafe repository %j before running git',
      async repository => {
        // #given a repository name that is not owner/repo
        setUpBareDirectories()
        const exec: ExecAdapter = {
          exec: vi.fn(),
          getExecOutput: vi.fn(),
          execWithTimeout: vi.fn(async () => 0),
        }

        // #when staging
        const error = unwrapErr(await stage({exec, repository}))

        // #then git never ran
        expect(error).toContain('owner/repo')
        expect(exec.execWithTimeout).not.toHaveBeenCalled()
      },
    )

    it('passes the token through the environment, never argv, when fetching', async () => {
      // #given a token and a fetch that fails (only the command line and environment matter here)
      setUpBareDirectories()
      const seen: {args: string[]; env: Record<string, string> | undefined}[] = []
      const exec: ExecAdapter = {
        exec: vi.fn(),
        getExecOutput: vi.fn(),
        execWithTimeout: async (_command, args, _timeoutMs, options: ExecOptions | undefined) => {
          seen.push({args: args ?? [], env: options?.env})
          return args?.includes('fetch') === true ? 1 : 0
        },
      }

      // #when staging with a token
      await stage({
        exec,
        githubToken: 'ghs_SECRET_TOKEN',
        serverUrl: 'https://github.com',
        env: {...GIT_ENV, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat'},
      })

      // #then the fetch carried the credential in env as a scoped extra header after the runner's own entry, and no argv held it
      const fetchCall = seen.find(call => call.args.includes('fetch'))
      expect(fetchCall).toBeDefined()
      expect(JSON.stringify(seen.map(call => call.args))).not.toContain('ghs_SECRET_TOKEN')
      expect(fetchCall?.env?.GIT_CONFIG_COUNT).toBe('2')
      expect(fetchCall?.env?.GIT_CONFIG_KEY_1).toBe('http.https://github.com/.extraheader')
      expect(fetchCall?.env?.GIT_CONFIG_VALUE_1).toBe(
        `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_SECRET_TOKEN').toString('base64')}`,
      )
      expect(fetchCall?.env?.GIT_TERMINAL_PROMPT).toBe('0')
      // #and the other commands never saw it
      expect(
        seen.filter(call => !call.args.includes('fetch')).every(call => call.env?.GIT_CONFIG_VALUE_1 === undefined),
      ).toBe(true)
    })

    it('strips environment variables that would point git at another repository', async () => {
      // #given an environment with GIT_DIR and GIT_WORK_TREE set by an earlier step
      setUpBareDirectories()
      const seen: (Record<string, string> | undefined)[] = []
      const exec: ExecAdapter = {
        exec: vi.fn(),
        getExecOutput: vi.fn(),
        execWithTimeout: async (_command, _args, _timeoutMs, options: ExecOptions | undefined) => {
          seen.push(options?.env)
          return 1
        },
      }

      // #when staging
      await stage({exec, env: {...GIT_ENV, GIT_DIR: '/evil/.git', GIT_WORK_TREE: '/evil'}})

      // #then neither reaches git
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every(env => env?.GIT_DIR === undefined && env?.GIT_WORK_TREE === undefined)).toBe(true)
    })

    describe('source budget, checked before anything is materialized', () => {
      const ran = (commands: string[][], word: string): boolean => commands.some(command => command.includes(word))

      function expectNothingMaterialized(commands: string[][]): void {
        expect(ran(commands, 'cat-file')).toBe(false)
        expect(ran(commands, 'archive')).toBe(false)
        expect(ran(commands, 'tar')).toBe(false)
        expect(fs.existsSync(path.join(staging, 'source-tree'))).toBe(false)
      }

      it('rejects a tree with too many entries without reading or writing a blob', async () => {
        // #given a listing one entry over the entry budget
        setUpBareDirectories()
        const {exec, commands} = fakeExec(
          Array.from({length: DEFAULT_REPO_SKILLS_LIMITS.maxSourceEntries + 1}, (_, i) => blob(`s/f${i}.md`)).join(''),
        )

        // #when staging
        const error = unwrapErr(await stage({exec}))

        // #then it is refused for its size, and no blob was read
        expect(error).toContain('budget')
        expect(error).toContain('entries')
        expectNothingMaterialized(commands)
      })

      it('rejects a tree with too many bytes without reading or writing a blob', async () => {
        // #given one blob a byte over the byte budget
        setUpBareDirectories()
        const {exec, commands} = fakeExec(blob('s/SKILL.md', DEFAULT_REPO_SKILLS_LIMITS.maxBytes + 1))

        // #when staging
        const error = unwrapErr(await stage({exec}))

        // #then it is refused for its bytes, and nothing was materialized
        expect(error).toContain('budget')
        expect(error).toContain('bytes')
        expectNothingMaterialized(commands)
      })

      it('counts symlinks, which admission will reject, toward the budget', async () => {
        // #given two files and two symlinks against a budget of three
        setUpBareDirectories()
        const {exec, commands} = fakeExec(
          blob('s/SKILL.md') + blob('s/a.md') + blob('s/l1', 4, '120000') + blob('s/l2', 4, '120000'),
        )

        // #when staging
        const error = unwrapErr(await stage({exec, limits: {maxSourceEntries: 3}}))

        // #then the rejected entries were part of the count
        expect(error).toContain('4 entries')
        expectNothingMaterialized(commands)
      })

      it('rejects a tree of empty-looking directories by counting trees', async () => {
        // #given four tree entries against a budget of three
        setUpBareDirectories()
        const trees = ['s', 's/a', 's/a/b', 's/a/b/c'].map(
          directory => `040000 tree ${'a'.repeat(40)}       -\t.agents/skills/${directory}\0`,
        )
        const {exec, commands} = fakeExec(trees.join(''))

        // #when staging
        const error = unwrapErr(await stage({exec, limits: {maxSourceEntries: 3}}))

        // #then they counted
        expect(error).toContain('4 entries')
        expectNothingMaterialized(commands)
      })

      it('rejects a listing that outgrows the output cap as over budget', async () => {
        // #given a listing larger than the bounded read (hostile giant tree)
        setUpBareDirectories()
        const {exec, commands} = fakeExec(blob(`s/${'x'.repeat(5 * 1024 * 1024)}`))

        // #when staging
        const error = unwrapErr(await stage({exec}))

        // #then it is refused without being parsed whole
        expect(error).toContain('budget')
        expectNothingMaterialized(commands)
      })

      it('refuses a malformed listing', async () => {
        // #given output git would not write
        setUpBareDirectories()
        const {exec, commands} = fakeExec('not a tree listing\0')

        // #when staging
        const error = unwrapErr(await stage({exec}))

        // #then it fails closed
        expect(error).toContain('listing')
        expectNothingMaterialized(commands)
      })

      it('materializes a tree that fits from cat-file, with no archive and no tar', async () => {
        // #given a listing within every limit and a matching cat-file answer
        setUpBareDirectories()
        const {exec, commands, inputs} = fakeExec(blob('s/SKILL.md', 10), frame(OID, '0123456789'))

        // #when staging
        const staged = (await stageDir({exec})) as string

        // #then the blob was read by id, written raw, and neither archive nor tar ran
        expect(inputs).toEqual([`${OID}\n`])
        expect(fs.readFileSync(path.join(staged, 's', 'SKILL.md'), 'utf8')).toBe('0123456789')
        expect(ran(commands, 'archive')).toBe(false)
        expect(ran(commands, 'tar')).toBe(false)
      })

      it('runs ls-tree recursively with sizes and NUL separators on the fetched private ref, before cat-file', async () => {
        // #given a recording adapter over real git
        setUpRepos()
        const {exec, calls} = recordingExec()

        // #when staging
        unwrapOk(await stage({exec}))

        // #then the listing used -r -l -z -t on the private ref, and came before cat-file
        const listIndex = calls.findIndex(call => call.args.includes('ls-tree'))
        const catFileIndex = calls.findIndex(call => call.args.includes('cat-file'))
        expect(calls[listIndex]?.args).toEqual(
          expect.arrayContaining(['-r', '-l', '-z', '-t', `refs/fro-bot/repo-skills/${path.basename(staging)}`]),
        )
        expect(listIndex).toBeGreaterThan(-1)
        expect(listIndex).toBeLessThan(catFileIndex)
      })

      it('refuses a submodule committed under the skills root, before any blob is read', async () => {
        // #given a default branch with a gitlink inside a skill
        setUpRepos()
        git(origin, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},.agents/skills/probe/sub`)
        git(origin, 'commit', '-qm', 'submodule')
        const {exec, calls} = recordingExec()

        // #when staging
        const error = unwrapErr(await stage({exec}))

        // #then the whole source is refused and no blob was read
        expect(error).toContain('submodule')
        expect(calls.some(call => call.args.includes('cat-file'))).toBe(false)
        expect(fs.readdirSync(staging)).toEqual([])
      })

      it('refuses a committed symlink, as admission does, and counts it first', async () => {
        // #given a default branch whose skill holds a symlink, against a budget of one entry
        setUpRepos()
        fs.symlinkSync('/etc/hosts', path.join(origin, '.agents', 'skills', 'probe', 'link.md'))
        git(origin, 'add', '-A')
        git(origin, 'commit', '-qm', 'link')
        const {exec, calls} = recordingExec()

        // #when staging against a tiny budget
        const error = unwrapErr(await stage({exec, limits: {maxSourceEntries: 2}}))

        // #then the symlink was counted (probe/, SKILL.md, references/, r.md, link.md) and no blob was read
        expect(error).toContain('5 entries')
        expect(calls.some(call => call.args.includes('cat-file'))).toBe(false)
      })

      it('admits a file exactly at the depth limit and refuses one a directory deeper', async () => {
        // #given a skill with a file six directories down on one branch state...
        setUpRepos()
        const bundled = path.join(root, 'bundled', '@fro.bot', 'systematic', 'skills')
        writeFile(path.join(bundled, 'ce-review', 'SKILL.md'), skillMd('ce:review'))
        writeFile(path.join(origin, '.agents', 'skills', 'probe', 'a', 'b', 'c', 'd', 'e', 'f', 'deep.md'), 'six\n')
        git(origin, 'add', '-A')
        git(origin, 'commit', '-qm', 'six deep')

        // #when staging and admitting
        const sourceDir = (await stageDir()) as string
        const admitted = unwrapOk(
          await admitRepoSkills({
            sourceDir,
            stagingRoot: staging,
            bundledSkillsDirectories: [bundled],
            logger: createMockLogger(),
          }),
        )

        // #then the file at the limit was staged and admitted with its skill
        expect(admitted.admitted).toEqual(['probe'])
        expect(fs.existsSync(path.join(staging, 'skills', 'probe', 'a', 'b', 'c', 'd', 'e', 'f', 'deep.md'))).toBe(true)

        // #and one directory deeper is refused before any blob is read
        fs.rmSync(staging, {recursive: true, force: true})
        fs.mkdirSync(staging)
        writeFile(
          path.join(origin, '.agents', 'skills', 'probe', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'deeper.md'),
          'seven\n',
        )
        git(origin, 'add', '-A')
        git(origin, 'commit', '-qm', 'seven deep')
        const {exec, calls} = recordingExec()
        const error = unwrapErr(await stage({exec}))
        expect(error).toContain('deep')
        expect(calls.some(call => call.args.includes('cat-file'))).toBe(false)
      })
    })

    describe('path integrity at the source (aliasing, duplicates, planted links)', () => {
      const entry = (file: string, mode = '100644', type = 'blob'): Buffer =>
        rawRecord(mode, type, type === 'tree' ? '-' : '3', `.agents/skills/${file}`)

      it('refuses a listing with invalid UTF-8 before reading or writing anything', async () => {
        // #given two blobs, one of which is named with an invalid byte
        setUpBareDirectories()
        const {exec, commands} = fakeExec(
          Buffer.concat([
            entry('ok/SKILL.md'),
            rawRecord('100644', 'blob', '3', Buffer.from('.agents/skills/b\xFF/SKILL.md', 'latin1')),
          ]),
          Buffer.concat([frame(OID, 'abc'), frame(OID, 'abc')]),
        )

        // #when staging
        const error = unwrapErr(await stage({exec}))

        // #then the source is refused, cat-file never ran and nothing is on disk
        expect(error).toContain('UTF-8')
        expect(commands.some(command => command.includes('cat-file'))).toBe(false)
        expect(fs.readdirSync(staging)).toEqual([])
      })

      it.each([
        ['a duplicate path', [entry('a/SKILL.md'), entry('a/SKILL.md')], 'duplicate'],
        ['paths that differ only by case', [entry('a/SKILL.md'), entry('a/skill.md')], 'duplicate'],
        ['a blob that is also a directory', [entry('a/b'), entry('a/b/c')], 'directory'],
      ])('refuses %s before reading or writing anything', async (_label, records, word) => {
        // #given a listing with the flaw
        setUpBareDirectories()
        const {exec, commands} = fakeExec(Buffer.concat(records), Buffer.concat(records.map(() => frame(OID, 'abc'))))

        // #when staging
        const error = unwrapErr(await stage({exec}))

        // #then the whole source is refused, naming no path
        expect(error).toContain(word)
        expect(commands.some(command => command.includes('cat-file'))).toBe(false)
        expect(fs.readdirSync(staging)).toEqual([])
      })

      it('does not ask cat-file for symlink blobs and reports the skills that hold them', async () => {
        // #given a listing with a file and a symlink in the same skill
        setUpBareDirectories()
        const {exec, inputs} = fakeExec(
          Buffer.concat([entry('s', '040000', 'tree'), entry('s/SKILL.md'), entry('s/link', '120000')]),
          frame(OID, 'abc'),
        )

        // #when staging
        const staged = unwrapOk(await stage({exec})) as StagedSkills

        // #then one blob was read, the link is not on disk and the skill is reported
        expect(inputs).toEqual([`${OID}\n`])
        expect(fs.readdirSync(staged.sourceDir, {recursive: true})).toEqual(['s', path.join('s', 'SKILL.md')])
        expect(staged.symlinkedSkillIds).toEqual(['s'])
      })

      const plantAgents = (outside: string, extract: string): void => {
        fs.mkdirSync(extract)
        fs.symlinkSync(outside, path.join(extract, '.agents'))
      }
      const plantExtractRoot = (outside: string, extract: string): void => {
        fs.symlinkSync(outside, extract)
      }
      const plantSkill = (outside: string, extract: string): void => {
        fs.mkdirSync(path.join(extract, '.agents', 'skills'), {recursive: true})
        fs.symlinkSync(outside, path.join(extract, '.agents', 'skills', 'probe'))
      }
      const withTree = (): Buffer => Buffer.concat([entry('probe', '040000', 'tree'), entry('probe/SKILL.md')])
      const fileOnly = (): Buffer => entry('probe/SKILL.md')
      const treeOnly = (): Buffer => entry('probe', '040000', 'tree')

      it.each([
        ['the .agents directory', plantAgents, withTree],
        ['the extract root', plantExtractRoot, withTree],
        ['a skill directory', plantSkill, withTree],
        ['a skill directory reached only through a file entry', plantSkill, fileOnly],
        ['a skill directory reached only through a tree entry', plantSkill, treeOnly],
      ])(
        'fails closed, writing nothing outside, when %s was replaced by a symlink',
        async (_label, plant, makeListing) => {
          // #given a symlink planted into the extract tree while the blobs were being read
          setUpBareDirectories()
          const outside = path.join(root, 'outside')
          fs.mkdirSync(outside)
          const blobs = makeListing === treeOnly ? Buffer.alloc(0) : frame(OID, 'abc')
          const {exec} = fakeExec(makeListing(), blobs, () => plant(outside, path.join(staging, 'source-tree')))

          // #when staging
          const error = unwrapErr(await stage({exec}))

          // #then the write refused to walk through it, the outside directory is untouched and the tree was removed
          expect(error).toContain('write')
          expect(fs.readdirSync(outside)).toEqual([])
          expect(fs.readdirSync(staging)).toEqual([])
        },
      )
    })

    describe('raw blob materialization (no git archive, no attribute processing)', () => {
      const MARKER = '$Format:%B$'

      /** `git cat-file blob` of a path in origin's HEAD: the stored bytes. */
      const stored = (file: string): Buffer =>
        execFileSync('git', ['cat-file', 'blob', `HEAD:${file}`], {cwd: origin, env: GIT_ENV})

      /** The reviewer's probe: export-subst, ident and eol attributes plus a large commit message. */
      function commitExpandingAttributes(): {skill: string; ident: string; crlf: string} {
        const skill = skillMd('probe', MARKER.repeat(1024))
        const ident = '$Id$\nbody\n'
        const crlf = 'one\ntwo\n'
        writeFile(path.join(origin, '.gitattributes'), '* export-subst\n*.ident.md ident\n*.crlf.md text eol=crlf\n')
        writeFile(path.join(origin, '.agents', 'skills', 'probe', 'SKILL.md'), skill)
        writeFile(path.join(origin, '.agents', 'skills', 'probe', 'references', 'x.ident.md'), ident)
        writeFile(path.join(origin, '.agents', 'skills', 'probe', 'references', 'x.crlf.md'), crlf)
        writeFile(path.join(root, 'message.txt'), `big message\n\n${'M'.repeat(8 * 1024)}\n`)
        git(origin, 'add', '-A')
        git(origin, 'commit', '-qF', path.join(root, 'message.txt'))
        return {skill, ident, crlf}
      }

      it('stages the stored bytes of a blob that export-subst would expand past the budget', async () => {
        // #given a default branch whose attributes make `git archive` turn ~12 KB of blobs into megabytes
        setUpRepos()
        const {skill} = commitExpandingAttributes()
        expect(stored('.agents/skills/probe/SKILL.md').length).toBeLessThan(20_000)

        // #when staging, reading what was staged, and admitting
        const sourceDir = (await stageDir()) as string
        const stagedBytes = fs.readFileSync(path.join(sourceDir, 'probe', 'SKILL.md'))
        const bundled = path.join(root, 'bundled', '@fro.bot', 'systematic', 'skills')
        writeFile(path.join(bundled, 'ce-review', 'SKILL.md'), skillMd('ce:review'))
        const admitted = unwrapOk(
          await admitRepoSkills({
            sourceDir,
            stagingRoot: staging,
            bundledSkillsDirectories: [bundled],
            logger: createMockLogger(),
          }),
        )

        // #then the staged and the admitted skill are the raw blob: markers intact, nothing expanded
        expect(admitted.admitted).toEqual(['probe'])
        for (const staged of [stagedBytes, fs.readFileSync(path.join(staging, 'skills', 'probe', 'SKILL.md'))]) {
          expect(staged.equals(Buffer.from(skill))).toBe(true)
          expect(staged.toString('utf8')).toContain(MARKER)
          expect(staged.length).toBeLessThan(DEFAULT_REPO_SKILLS_LIMITS.maxBytes)
        }
      })

      it('does not apply ident or eol conversion to staged blobs', async () => {
        // #given blobs with ident and text eol=crlf attributes
        setUpRepos()
        const {ident, crlf} = commitExpandingAttributes()

        // #when staging
        const sourceDir = (await stageDir()) as string

        // #then the bytes equal what is stored: `$Id$` is not expanded and no CR was added
        const identBytes = fs.readFileSync(path.join(sourceDir, 'probe', 'references', 'x.ident.md'))
        const crlfBytes = fs.readFileSync(path.join(sourceDir, 'probe', 'references', 'x.crlf.md'))
        expect(identBytes.toString('utf8')).toBe(ident)
        expect(crlfBytes.toString('utf8')).toBe(crlf)
        expect(crlfBytes.includes(0x0d)).toBe(false)
        expect(identBytes.equals(stored('.agents/skills/probe/references/x.ident.md'))).toBe(true)
      })

      it('never runs git archive or tar, and runs cat-file --batch bounded, in the staging root, with git redirection stripped', async () => {
        // #given a recording adapter over real git, and a hostile GIT_DIR in the environment
        setUpRepos()
        const {exec, calls} = recordingExec()

        // #when staging
        unwrapOk(await stage({exec, env: {...GIT_ENV, GIT_DIR: '/evil/.git', GIT_WORK_TREE: '/evil'}}))

        // #then no archive or tar, one cat-file whose stdin is the object ids, and every command was bounded and scrubbed
        expect(calls.some(call => call.args.includes('archive') || call.command === 'tar')).toBe(false)
        const catCalls = calls.filter(call => call.args.includes('cat-file'))
        expect(catCalls).toHaveLength(1)
        expect(catCalls[0]?.input?.toString('utf8')).toMatch(/^([\da-f]{40}\n)+$/)
        expect(new Set(calls.map(call => call.cwd))).toEqual(new Set([staging]))
        expect(calls.every(call => call.timeoutMs === DEFAULT_REPO_SKILLS_LIMITS.commandTimeoutMs)).toBe(true)
        expect(calls.every(call => call.env?.GIT_DIR === undefined && call.env?.GIT_WORK_TREE === undefined)).toBe(true)
      })

      it('writes files 0600 (0700 when executable) and directories 0700', async () => {
        // #given a skill with a plain file and an executable script
        setUpRepos()
        writeFile(path.join(origin, '.agents', 'skills', 'probe', 'scripts', 'run.sh'), '#!/bin/sh\n')
        git(origin, 'add', '-A')
        git(origin, 'update-index', '--chmod=+x', '.agents/skills/probe/scripts/run.sh')
        git(origin, 'commit', '-qm', 'script')

        // #when staging
        const sourceDir = (await stageDir()) as string

        // #then modes are owner-only, and the executable bit survives as owner-execute
        const mode = (file: string): number => fs.statSync(path.join(sourceDir, file)).mode & 0o777
        expect(mode('probe/SKILL.md')).toBe(0o600)
        expect(mode('probe/scripts/run.sh')).toBe(0o700)
        expect(mode('probe')).toBe(0o700)
        expect(mode('probe/scripts')).toBe(0o700)
      })

      const listing = (...files: string[]): string => files.map(file => blob(file, 3)).join('')

      it.each([
        ['a smaller size than listed', frame(OID, 'ab'), 'mismatch'],
        ['a different type', frame(OID, 'abc', 'tree'), 'mismatch'],
        ['a missing object', Buffer.from(`${OID} missing\n`), 'missing'],
        ['a larger size than listed', frame(OID, 'abcd'), 'exceeds'],
        ['trailing output', Buffer.concat([frame(OID, 'abc'), Buffer.from('junk')]), 'trailing'],
      ])('fails closed on %s and leaves nothing behind', async (_label, catFile, word) => {
        // #given a listing of one three-byte blob and a cat-file answer that disagrees with it
        setUpBareDirectories()
        const {exec} = fakeExec(listing('s/SKILL.md'), catFile)

        // #when staging
        const error = unwrapErr(await stage({exec}))

        // #then it is refused and the staging root holds nothing
        expect(error).toContain(word)
        expect(fs.readdirSync(staging)).toEqual([])
      })

      it('aborts when cat-file output outgrows the listing, without parsing it', async () => {
        // #given a ten-byte listing and two megabytes of output
        setUpBareDirectories()
        const {exec} = fakeExec(blob('s/SKILL.md', 10), Buffer.alloc(2 * 1024 * 1024, 0x61))

        // #when staging
        const error = unwrapErr(await stage({exec}))

        // #then the capped read refused it and nothing is left
        expect(error).toContain('exceeds')
        expect(fs.readdirSync(staging)).toEqual([])
      })

      it('fails closed, overwriting nothing, when a file already exists at a path it would create', async () => {
        // #given a regular file planted at the destination while the blobs were being read
        setUpBareDirectories()
        const planted = path.join(staging, 'source-tree', '.agents', 'skills', 's', 'SKILL.md')
        const {exec} = fakeExec(listing('s/SKILL.md'), frame(OID, 'abc'), () => {
          fs.mkdirSync(path.dirname(planted), {recursive: true})
          fs.writeFileSync(planted, 'PLANTED')
        })

        // #when staging
        const error = unwrapErr(await stage({exec}))

        // #then the exclusive create refused it and the tree was removed
        expect(error).toContain('write')
        expect(fs.readdirSync(staging)).toEqual([])
      })

      it.each(['s/../../escape.md', 's/./x.md', 's//x.md'])(
        'refuses the unsafe path %j before any blob is read or written',
        async file => {
          // #given a listing with a path git would not produce
          setUpBareDirectories()
          const {exec, commands} = fakeExec(listing(file), frame(OID, 'abc'))

          // #when staging
          const error = unwrapErr(await stage({exec}))

          // #then it is refused, cat-file never ran, and nothing escaped the extract root
          expect(error).toContain('unsafe')
          expect(commands.some(command => command.includes('cat-file'))).toBe(false)
          expect(fs.readdirSync(staging)).toEqual([])
          expect(fs.existsSync(path.join(root, 'escape.md'))).toBe(false)
        },
      )

      it('refuses an entry with a mode other than file, executable file, symlink or tree', async () => {
        // #given a legacy group-writable mode
        setUpBareDirectories()
        const {exec} = fakeExec(blob('s/SKILL.md', 3, '100664'), frame(OID, 'abc'))

        // #when staging
        const error = unwrapErr(await stage({exec}))

        // #then it fails closed, nothing left
        expect(error).toContain('mode')
        expect(fs.readdirSync(staging)).toEqual([])
      })

      it('fails closed and cleans up when cat-file times out', async () => {
        // #given cat-file that times out after the listing
        setUpRepos()
        const real = createExecAdapter()
        const exec: ExecAdapter = {
          ...real,
          execWithTimeout: async (command, args, timeoutMs, options) =>
            args?.includes('cat-file')
              ? 'timed-out'
              : (real.execWithTimeout as NonNullable<typeof real.execWithTimeout>)(command, args, timeoutMs, options),
        }

        // #when staging
        const error = unwrapErr(await stage({exec}))

        // #then
        expect(error).toContain('timed out')
        expect(fs.readdirSync(staging)).toEqual([])
      })
    })
  })
})
