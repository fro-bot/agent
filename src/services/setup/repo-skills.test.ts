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
  createRepoSkillsStagingRoot,
  removeRepoSkillsStagingRoot,
  REPO_SKILLS_DIRECTORY_NAME,
  stageDefaultBranchSkills,
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

/** An exec adapter that records every command's cwd and arguments and then runs it for real. */
function recordingExec(): {exec: ExecAdapter; calls: {cwd: string | undefined; args: string[]}[]} {
  const real = createExecAdapter()
  const calls: {cwd: string | undefined; args: string[]}[] = []
  const exec: ExecAdapter = {
    ...real,
    execWithTimeout: async (command, args, timeoutMs, options) => {
      calls.push({cwd: options?.cwd, args: args ?? []})
      return (real.execWithTimeout as NonNullable<typeof real.execWithTimeout>)(command, args, timeoutMs, options)
    },
  }
  return {exec, calls}
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
      const sourceDir = unwrapOk(await stage())

      // #then the extracted tree is main's content, with the branch's additions absent
      expect(sourceDir).toBe(path.join(staging, 'source-tree', '.agents', 'skills'))
      expect(listFiles(sourceDir as string)).toEqual(['probe/SKILL.md', 'probe/references/r.md'])
      const body = fs.readFileSync(path.join(sourceDir as string, 'probe', 'SKILL.md'), 'utf8')
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
      const sourceDir = unwrapOk(await stage())

      // #then the fresh fetch won: neither the planted ref nor the checkout's old origin/main is read
      const body = fs.readFileSync(path.join(sourceDir as string, 'probe', 'SKILL.md'), 'utf8')
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
      const sourceDir = unwrapOk(await stage({exec}))

      // #then every command ran in the staging root, the rewrite did not redirect the fetch, and the checkout is unchanged
      expect(calls.length).toBeGreaterThan(0)
      expect(new Set(calls.map(call => call.cwd))).toEqual(new Set([staging]))
      expect(fs.readFileSync(path.join(sourceDir as string, 'probe', 'SKILL.md'), 'utf8')).toContain('MAIN-VERSION')
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
      // #and the archive reads that exact private ref, and nothing but the extracted tree remains
      const archiveCall = calls.find(call => call.args.includes('archive'))
      expect(archiveCall?.args).toContain(`refs/fro-bot/repo-skills/${path.basename(staging)}`)
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

    it('hands a committed symlink to the admission filter, which rejects it', async () => {
      // #given a default branch whose skill contains a committed symlink
      setUpRepos()
      fs.symlinkSync('/etc/hosts', path.join(origin, '.agents', 'skills', 'probe', 'references', 'link.md'))
      git(origin, 'add', '-A')
      git(origin, 'commit', '-qm', 'link')
      const bundled = path.join(root, 'bundled', '@fro.bot', 'systematic', 'skills')
      writeFile(path.join(bundled, 'ce-review', 'SKILL.md'), skillMd('ce:review'))

      // #when staging and admitting
      const sourceDir = unwrapOk(await stage()) as string
      const admitted = unwrapOk(
        await admitRepoSkills({
          sourceDir,
          stagingRoot: staging,
          bundledSkillsDirectories: [bundled],
          logger: createMockLogger(),
        }),
      )

      // #then the skill is rejected as a whole
      expect(admitted.skipped).toEqual([{id: 'probe', reason: 'symlink'}])
      expect(admitted.directory).toBeNull()
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

    it('fails closed when git archive times out', async () => {
      // #given an exec adapter whose archive step times out
      setUpRepos()
      const real = createExecAdapter()
      const exec: ExecAdapter = {
        ...real,
        execWithTimeout: async (command, args, timeoutMs, options) =>
          args?.includes('archive')
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
  })
})
