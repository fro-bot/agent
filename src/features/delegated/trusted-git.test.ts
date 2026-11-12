import type {PrivilegedRun} from '@fro-bot/runtime'
import type {HandoffManifest} from '../../services/setup/sandbox-handoff.js'
import {execFileSync, spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createExecAdapter} from '../../services/setup/adapters.js'
import {handOff, takeBack} from '../../services/setup/sandbox-handoff.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {resolveBrokeredPushCommitMessage} from './commit-message.js'
import {reconstructChanges} from './reconstruct-changes.js'
import {runTrustedGit, TRUSTED_GIT_ENV, TRUSTED_GIT_GLOBAL_ARGS} from './trusted-git.js'

vi.setConfig({testTimeout: 60_000, hookTimeout: 60_000})

/**
 * Adversarial fixtures for the post-model git calls (fro-bot/agent#2135 R4). Each payload writes a marker file when it
 * runs. Every fixture has a positive control: plain git against the same hostile checkout DOES run the payload, so a
 * missing marker after the trusted call proves the fix rather than a fixture that never fired.
 */

// The identity comes from the environment, not from `user.*` in the repo config: the handoff audit trusts only the keys a
// hosted checkout writes, and a checkout's config has no user section.
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
}
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ...IDENTITY},
  })

interface Repo {
  readonly root: string
  readonly repo: string
  readonly anchor: string
  readonly marker: (name: string) => string
  /** A script that records that it ran, for use as a config command or hook. */
  readonly payload: (name: string) => string
  readonly ran: (name: string) => boolean
}

function makeRepo(): Repo {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-git-')))
  const repo = path.join(root, 'work', 'repo')
  fs.mkdirSync(repo, {recursive: true})
  fs.mkdirSync(path.join(root, 'work', '_temp'))
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'anchor\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'anchor')
  const anchor = git(repo, 'rev-parse', 'HEAD').trim()
  const marker = (name: string): string => path.join(root, `ran-${name}`)
  const payload = (name: string): string => {
    const script = path.join(root, `payload-${name}.sh`)
    // `cat` makes it a valid clean/smudge/textconv filter; the exit status is ignored by the fsmonitor and hook uses.
    fs.writeFileSync(script, `#!/bin/sh\necho ran >> ${marker(name)}\ncat\n`, {mode: 0o755})
    return script
  }
  return {root, repo, anchor, marker, payload, ran: name => fs.existsSync(marker(name))}
}

/** What a model with write access to `.git` can do to config: replace the file (rename), so it applies to every reader. */
function writeHostileConfig(repo: string, extra: string): void {
  const config = path.join(repo, '.git', 'config')
  const existing = fs.readFileSync(config, 'utf8')
  fs.rmSync(config)
  fs.writeFileSync(config, `${existing}${extra}`)
}

/**
 * `.git/commondir` makes git read its config, objects and refs from another directory. A model can copy `.git` to a
 * second place inside the checkout, put a clean filter in THAT config, and point `commondir` at it: restoring
 * `.git/config` then restores nothing git reads. The filter is selected by a tracked `.gitattributes`.
 */
function plantCommondir(repo: Repo, name: string): void {
  const evil = path.join(repo.repo, 'evil-common')
  fs.cpSync(path.join(repo.repo, '.git'), evil, {recursive: true})
  fs.appendFileSync(path.join(evil, 'config'), `[filter "x"]\n\tclean = ${repo.payload(name)}\n`)
  fs.writeFileSync(path.join(repo.repo, '.gitattributes'), '* filter=x\n')
  fs.writeFileSync(path.join(repo.repo, '.git', 'commondir'), '../evil-common\n')
}

/** Dirty the worktree so a diff has to hash content (clean filters) and refresh the index (fsmonitor, index hooks). */
function dirtyWorktree(repo: string): void {
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed by the model\n')
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n')
}

/** Runs the same two reads the Action does, plus the commit-message lookup, through the real adapter and wrapper. */
async function runPostModelGit(repo: Repo): Promise<void> {
  const logger = createMockLogger()
  const adapter = createExecAdapter()
  // Read the files for real: reconstruct reads worktree bytes itself.
  await reconstructChanges(adapter, repo.anchor, repo.repo, logger)
  await resolveBrokeredPushCommitMessage(adapter, repo.anchor, repo.repo, logger, 'fallback')
}

/** A manifest rooted at the fixture, with a fake privileged runner, so take-back's real restore runs without root. */
function manifestFor(repo: Repo): HandoffManifest {
  return {
    ids: {runnerUid: process.getuid?.() ?? 0, runnerGid: process.getgid?.() ?? 0, sandboxUid: 998, sandboxGid: 997},
    runnerHome: path.join(repo.root, 'work'),
    runnerTemp: path.join(repo.root, 'work', '_temp'),
    workspace: repo.repo,
    handedOver: [],
    readable: [],
    traverseOnly: [],
    tighten: [],
  }
}

// The handoff audit parses the trusted config with real git; every other tool is a fake that is never executed.
const TOOLS = {
  git: spawnSync('which', ['git'], {encoding: 'utf8'}).stdout.trim(),
  setfacl: '/s',
  getfacl: '/g',
  find: '/f',
  chown: '/c',
  chmod: '/m',
}

const fakeRun: PrivilegedRun = async argv => ({
  exitCode: 0,
  stdout: argv.includes('-print') ? '' : '# file: x\nuser::rwx\ngroup::r-x\nother::r-x\n',
})

async function restoreThenRun(repo: Repo, hostile: () => void): Promise<void> {
  const manifest = manifestFor(repo)
  const handed = await handOff(manifest, {
    run: fakeRun,
    tools: TOOLS,
    logger: createMockLogger(),
  })
  if (!handed.success) throw new Error(handed.error)
  // The sandbox runs here; then everything below is what the Action does.
  hostile()
  const outcome = await takeBack(manifest, handed.data, {
    run: fakeRun,
    tools: TOOLS,
    logger: createMockLogger(),
  })
  expect(outcome.status).toBe('restored')
  await runPostModelGit(repo)
}

/** A model-controlled file in the checkout that defines the clean filter `.gitattributes` selects. */
function plantModelConfig(repo: Repo, name: string, file: string): void {
  fs.writeFileSync(path.join(repo.repo, file), `[filter "x"]\n\tclean = ${repo.payload(name)}\n`)
  fs.writeFileSync(path.join(repo.repo, '.gitattributes'), '* filter=x\n')
  dirtyWorktree(repo.repo)
}

describe('post-model git against a hostile checkout', () => {
  let repo: Repo

  beforeEach(() => {
    repo = makeRepo()
  })
  afterEach(() => {
    fs.rmSync(repo.root, {recursive: true, force: true})
  })

  describe('positive controls: plain git runs each payload', () => {
    it('core.fsmonitor', () => {
      writeHostileConfig(repo.repo, `[core]\n\tfsmonitor = ${repo.payload('fsmonitor')}\n`)
      dirtyWorktree(repo.repo)
      git(repo.repo, 'diff', '--raw', repo.anchor)
      expect(repo.ran('fsmonitor')).toBe(true)
    })

    it('diff textconv named by .gitattributes', () => {
      fs.writeFileSync(path.join(repo.repo, '.gitattributes'), '* diff=x\n')
      git(repo.repo, 'add', '.gitattributes')
      git(repo.repo, 'commit', '-qm', 'attrs')
      writeHostileConfig(repo.repo, `[diff "x"]\n\ttextconv = ${repo.payload('textconv')}\n`)
      dirtyWorktree(repo.repo)
      git(repo.repo, 'diff', 'HEAD')
      expect(repo.ran('textconv')).toBe(true)
    })

    it('clean filter named by .gitattributes', () => {
      fs.writeFileSync(path.join(repo.repo, '.gitattributes'), '* filter=x\n')
      writeHostileConfig(repo.repo, `[filter "x"]\n\tclean = ${repo.payload('clean')}\n`)
      dirtyWorktree(repo.repo)
      git(repo.repo, 'diff', '--raw', repo.anchor)
      expect(repo.ran('clean')).toBe(true)
    })

    it('include.path pulling in a second config', () => {
      const included = path.join(repo.root, 'included.config')
      fs.writeFileSync(included, `[core]\n\tfsmonitor = ${repo.payload('include')}\n`)
      writeHostileConfig(repo.repo, `[include]\n\tpath = ${included}\n`)
      dirtyWorktree(repo.repo)
      git(repo.repo, 'diff', '--raw', repo.anchor)
      expect(repo.ran('include')).toBe(true)
    })

    it('a post-index-change hook', () => {
      const hook = path.join(repo.repo, '.git', 'hooks', 'post-index-change')
      fs.writeFileSync(hook, `#!/bin/sh\necho ran >> ${repo.marker('hook')}\n`, {mode: 0o755})
      // A stale stat makes the refresh rewrite the index.
      fs.utimesSync(path.join(repo.repo, 'tracked.txt'), new Date(1_000_000), new Date(1_000_000))
      git(repo.repo, 'status', '--short')
      expect(repo.ran('hook')).toBe(true)
    })

    it('.git/info/attributes selecting a configured filter', () => {
      fs.writeFileSync(path.join(repo.repo, '.git', 'info', 'attributes'), '* filter=x\n')
      writeHostileConfig(repo.repo, `[filter "x"]\n\tclean = ${repo.payload('info')}\n`)
      dirtyWorktree(repo.repo)
      git(repo.repo, 'diff', '--raw', repo.anchor)
      expect(repo.ran('info')).toBe(true)
    })

    it('a gitlink whose own repository carries core.fsmonitor, under --ignore-submodules=none', () => {
      const sub = path.join(repo.repo, 'sub')
      fs.mkdirSync(sub)
      git(sub, 'init', '-q', '-b', 'main')
      git(sub, 'config', 'user.name', 'Fixture')
      git(sub, 'config', 'user.email', 'fixture@example.invalid')
      fs.writeFileSync(path.join(sub, 'g'), 'y\n')
      git(sub, 'add', '.')
      git(sub, 'commit', '-qm', 's')
      git(sub, 'config', 'core.fsmonitor', repo.payload('submodule'))
      git(repo.repo, 'update-index', '--add', '--cacheinfo', `160000,${git(sub, 'rev-parse', 'HEAD').trim()},sub`)
      fs.appendFileSync(path.join(sub, 'g'), 'dirty\n')
      git(repo.repo, 'diff', '--ignore-submodules=none', '--raw', repo.anchor)
      expect(repo.ran('submodule')).toBe(true)
    })
  })

  describe('trusting the pre-run metadata: include.path and a symlinked config', () => {
    const deps = () => ({
      run: fakeRun,
      tools: TOOLS,
      logger: createMockLogger(),
    })

    it('positive control: a config that includes a checkout file runs its filter even through the hardened wrapper', async () => {
      // #given the pre-run config includes ../model.config (relative to .git/, so a file in the checkout)
      plantModelConfig(repo, 'include', 'model.config')
      fs.appendFileSync(path.join(repo.repo, '.git', 'config'), '[include]\n\tpath = ../model.config\n')

      // #when the Action's own post-model git calls run, with fsmonitor and hooks disabled as they always are
      await runPostModelGit(repo)

      // #then the payload still ran as the runner: restoring the config from a snapshot would restore this too
      expect(repo.ran('include')).toBe(true)
    })

    it('handoff refuses that config, so the sandbox never starts and no payload runs', async () => {
      // #given the same config
      plantModelConfig(repo, 'include-guarded', 'model.config')
      fs.appendFileSync(path.join(repo.repo, '.git', 'config'), '[include]\n\tpath = ../model.config\n')

      // #when handed off
      const handed = await handOff(manifestFor(repo), deps())

      // #then
      expect(!handed.success && handed.error).toContain('include.path')
      expect(repo.ran('include-guarded')).toBe(false)
    })

    it("positive control: a .git/config symlinked into the checkout is the model's config, and runs its filter", async () => {
      // #given a config that is a symlink to a checkout file defining the filter
      plantModelConfig(repo, 'linked', 'linked.cfg')
      const config = path.join(repo.repo, '.git', 'config')
      fs.writeFileSync(
        path.join(repo.repo, 'linked.cfg'),
        `[core]\n\trepositoryformatversion = 0\n${fs.readFileSync(path.join(repo.repo, 'linked.cfg'), 'utf8')}`,
      )
      fs.rmSync(config)
      fs.symlinkSync(path.join(repo.repo, 'linked.cfg'), config)

      // #when
      await runPostModelGit(repo)

      // #then
      expect(repo.ran('linked')).toBe(true)
    })

    it('handoff refuses the symlinked config', async () => {
      // #given
      plantModelConfig(repo, 'linked-guarded', 'linked.cfg')
      const config = path.join(repo.repo, '.git', 'config')
      fs.rmSync(config)
      fs.symlinkSync(path.join(repo.repo, 'linked.cfg'), config)

      // #when
      const handed = await handOff(manifestFor(repo), deps())

      // #then
      expect(!handed.success && handed.error).toMatch(/config.*symlink/)
      expect(repo.ran('linked-guarded')).toBe(false)
    })
  })

  describe('commondir redirect', () => {
    it('positive control: plain git with a planted commondir runs the clean filter as the runner', () => {
      // #given a checkout whose .git/commondir points at a copy carrying a clean filter
      plantCommondir(repo, 'commondir')
      dirtyWorktree(repo.repo)

      // #when plain git diffs the worktree against the anchor (which hashes content through the clean filter)
      git(repo.repo, 'diff', '--raw', repo.anchor)

      // #then the payload ran: the fixture is real
      expect(repo.ran('commondir')).toBe(true)
    })

    it('positive control: the hardened wrapper alone does not stop it, because the config git reads is not .git/config', async () => {
      // #given the redirect, with .git/config itself untouched (so restoring it would change nothing)
      plantCommondir(repo, 'wrapper')
      dirtyWorktree(repo.repo)

      // #when the Action's own post-model git calls run against it
      await runPostModelGit(repo)

      // #then the filter ran as the runner: only refusing the redirect protects the runner-side git
      expect(repo.ran('wrapper')).toBe(true)
    })

    it('take-back is unsafe, so the runner-side git calls never run against it', async () => {
      // #given a handoff, then a model that plants the commondir redirect and dirties the tree
      const manifest = manifestFor(repo)
      const deps = {
        run: fakeRun,
        tools: TOOLS,
        logger: createMockLogger(),
      }
      const handed = await handOff(manifest, deps)
      if (!handed.success) throw new Error(handed.error)
      plantCommondir(repo, 'guarded')
      dirtyWorktree(repo.repo)

      // #when taken back
      const outcome = await takeBack(manifest, handed.data, deps)

      // #then it is unsafe by name; the caller declines to reconstruct or build a commit message, and nothing ran
      expect(outcome.status === 'unsafe' && outcome.reason).toContain('commondir')
      expect(repo.ran('guarded')).toBe(false)
      expect(fs.existsSync(path.join(repo.repo, '.git', 'commondir'))).toBe(true)
    })

    it('handoff refuses a checkout that already has a commondir', async () => {
      // #given a checkout redirected before the sandbox ever starts
      plantCommondir(repo, 'preexisting')

      // #when handed off
      const handed = await handOff(manifestFor(repo), {
        run: fakeRun,
        tools: TOOLS,
        logger: createMockLogger(),
      })

      // #then
      expect(!handed.success && handed.error).toContain('commondir')
    })
  })

  describe('the trusted wrapper alone (non-isolated runs)', () => {
    it('keeps core.fsmonitor and hooks from running, with the hostile config still on disk', async () => {
      // #given hostile fsmonitor config and a hook, and no metadata restore
      writeHostileConfig(repo.repo, `[core]\n\tfsmonitor = ${repo.payload('fsmonitor')}\n`)
      const hook = path.join(repo.repo, '.git', 'hooks', 'post-index-change')
      fs.writeFileSync(hook, `#!/bin/sh\necho ran >> ${repo.marker('hook')}\n`, {mode: 0o755})
      dirtyWorktree(repo.repo)
      fs.utimesSync(path.join(repo.repo, 'tracked.txt'), new Date(1_000_000), new Date(1_000_000))

      // #when the post-model reads run
      await runPostModelGit(repo)

      // #then neither payload ran
      expect(repo.ran('fsmonitor')).toBe(false)
      expect(repo.ran('hook')).toBe(false)
    })

    it('runs nothing inside a gitlink whose repository carries a hostile config', async () => {
      // #given a gitlink to a nested repository with core.fsmonitor
      const sub = path.join(repo.repo, 'sub')
      fs.mkdirSync(sub)
      git(sub, 'init', '-q', '-b', 'main')
      git(sub, 'config', 'user.name', 'Fixture')
      git(sub, 'config', 'user.email', 'fixture@example.invalid')
      fs.writeFileSync(path.join(sub, 'g'), 'y\n')
      git(sub, 'add', '.')
      git(sub, 'commit', '-qm', 's')
      git(sub, 'config', 'core.fsmonitor', repo.payload('submodule'))
      git(repo.repo, 'update-index', '--add', '--cacheinfo', `160000,${git(sub, 'rev-parse', 'HEAD').trim()},sub`)
      fs.appendFileSync(path.join(sub, 'g'), 'dirty\n')

      // #when reconstructed under isolation
      const result = await reconstructChanges(createExecAdapter(), repo.anchor, repo.repo, createMockLogger(), {
        isolated: true,
      })

      // #then nothing ran, and the populated submodule is declined by name rather than silently dropped
      expect(repo.ran('submodule')).toBe(false)
      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('sub')
      expect(!result.success && result.error.message).toContain('populated')
    })

    it('replaces the environment: no global config, a pinned PATH, no prompts', () => {
      expect(TRUSTED_GIT_ENV.GIT_CONFIG_GLOBAL).toBe('/dev/null')
      expect(TRUSTED_GIT_ENV.GIT_TERMINAL_PROMPT).toBe('0')
      expect(TRUSTED_GIT_ENV.PATH).toBe(process.platform === 'win32' ? undefined : '/usr/local/bin:/usr/bin:/bin')
      expect(TRUSTED_GIT_GLOBAL_ARGS).toEqual([
        '--no-pager',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
      ])
    })
  })

  describe('after take-back restores the trusted metadata', () => {
    it('runs no payload for fsmonitor, textconv, clean filter, include.path, hooks or info/attributes together', async () => {
      // #given a model that sets up every vector at once (the clean filter and attributes only matter if config survives)
      const included = path.join(repo.root, 'included.config')
      fs.writeFileSync(included, `[core]\n\tfsmonitor = ${repo.payload('include')}\n`)
      await restoreThenRun(repo, () => {
        writeHostileConfig(
          repo.repo,
          `[core]\n\tfsmonitor = ${repo.payload('fsmonitor')}\n[diff "x"]\n\ttextconv = ${repo.payload('textconv')}\n` +
            `[filter "x"]\n\tclean = ${repo.payload('clean')}\n[include]\n\tpath = ${included}\n`,
        )
        fs.writeFileSync(path.join(repo.repo, '.gitattributes'), '* diff=x filter=x\n')
        fs.writeFileSync(path.join(repo.repo, '.git', 'info', 'attributes'), '* filter=x\n')
        fs.writeFileSync(
          path.join(repo.repo, '.git', 'config.worktree'),
          `[core]\n\tfsmonitor = ${repo.payload('worktree')}\n`,
        )
        fs.writeFileSync(
          path.join(repo.repo, '.git', 'hooks', 'post-index-change'),
          `#!/bin/sh\necho ran >> ${repo.marker('hook')}\n`,
          {mode: 0o755},
        )
        dirtyWorktree(repo.repo)
        fs.utimesSync(path.join(repo.repo, 'tracked.txt'), new Date(1_000_000), new Date(1_000_000))
      })

      // #then no payload ran as the runner
      for (const name of ['fsmonitor', 'textconv', 'clean', 'include', 'worktree', 'hook']) {
        expect(repo.ran(name), `payload ${name} must not run`).toBe(false)
      }
    })

    it("still reconstructs the model's net changes exactly (staged, unstaged, untracked, deleted, new branch)", async () => {
      // #given an ordinary model session
      const adapter = createExecAdapter()
      await restoreThenRun(repo, () => {
        git(repo.repo, 'switch', '-q', '-c', 'model-branch')
        fs.writeFileSync(path.join(repo.repo, 'staged.txt'), 'staged\n')
        git(repo.repo, 'add', 'staged.txt')
        fs.writeFileSync(path.join(repo.repo, 'tracked.txt'), 'edited\n')
        fs.writeFileSync(path.join(repo.repo, 'untracked.txt'), 'untracked\n')
      })

      // #when reconstructed after the restore
      const result = await reconstructChanges(adapter, repo.anchor, repo.repo, createMockLogger())

      // #then the net changes against the trusted anchor are all there
      expect(result.success).toBe(true)
      const changes = result.success && result.data.kind === 'changes' ? result.data.changes : []
      expect(changes.map(change => change.path).sort()).toEqual(['staged.txt', 'tracked.txt', 'untracked.txt'])
    })
  })

  describe('bounds', () => {
    it('reports a hung git as timed out, passing the bound to the adapter', async () => {
      // #given an adapter whose git never returns before the bound
      const execWithTimeout = vi.fn(async () => 'timed-out' as const)
      const adapter = {exec: vi.fn(), getExecOutput: vi.fn(), execWithTimeout}

      // #when
      const result = await runTrustedGit(adapter, ['rev-parse', 'HEAD'], '/repo', {timeoutMs: 1234})

      // #then the wrapper surfaces it and used the killing path with the bound and the replaced environment
      expect(result).toEqual({kind: 'timed-out'})
      const [command, argv, timeoutMs, execOptions] = execWithTimeout.mock.calls[0] as unknown as [
        string,
        string[],
        number,
        {cwd: string; env: Record<string, string>},
      ]
      expect([command, argv, timeoutMs]).toEqual(['git', [...TRUSTED_GIT_GLOBAL_ARGS, 'rev-parse', 'HEAD'], 1234])
      expect(execOptions.cwd).toBe('/repo')
      expect(execOptions.env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
      expect(adapter.getExecOutput).not.toHaveBeenCalled()
    })

    it('fails reconstruction loudly, never falling back, when git times out', async () => {
      // #given
      const adapter = {exec: vi.fn(), getExecOutput: vi.fn(), execWithTimeout: vi.fn(async () => 'timed-out' as const)}

      // #when
      const result = await reconstructChanges(adapter, 'a'.repeat(40), '/repo', createMockLogger())

      // #then
      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('timed out')
    })

    it('skips an unbounded call when the caller requires a timeout and the adapter has none', async () => {
      const getExecOutput = vi.fn()
      const result = await runTrustedGit({exec: vi.fn(), getExecOutput}, ['status'], '/repo', {
        timeoutMs: 10,
        requireTimeout: true,
      })
      expect(result).toEqual({kind: 'unavailable'})
      expect(getExecOutput).not.toHaveBeenCalled()
    })
  })
})
