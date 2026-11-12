import type {PrivilegedRun} from '@fro-bot/runtime'
import type {HandoffDeps, HandoffManifest} from './sandbox-handoff.js'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {grantsSandboxWrite, handOff, planLocks, takeBack, verifyRoots} from './sandbox-handoff.js'

const SANDBOX_UID = 998
const SANDBOX_GID = 997
// The audit parses the trusted config with real git, so the suite needs a real absolute path to it.
const GIT = spawnSync('which', ['git'], {encoding: 'utf8'}).stdout.trim()
const TOOLS = {
  git: GIT,
  setfacl: '/usr/bin/setfacl',
  getfacl: '/usr/bin/getfacl',
  find: '/usr/bin/find',
  chown: '/usr/bin/chown',
  chmod: '/usr/bin/chmod',
}

const BASE_ACL = '# file: x\nuser::rwx\ngroup::r-x\nother::r-x\n'

interface Fixture {
  readonly root: string
  readonly manifest: HandoffManifest
  readonly calls: string[][]
  readonly deps: HandoffDeps
  readonly failWhen: {predicate: ((argv: readonly string[]) => boolean) | null}
  readonly aclFor: Map<string, string>
  readonly leftover: {value: string}
}

function buildFixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-handoff-')))
  const home = path.join(root, 'home')
  const work = path.join(home, 'work')
  const workspace = path.join(work, 'agent', 'agent')
  const runnerTemp = path.join(work, '_temp')
  const dirs = [
    path.join(workspace, '.git', 'hooks'),
    path.join(workspace, '.git', 'info'),
    path.join(runnerTemp, '_runner_file_commands'),
    path.join(runnerTemp, 'secret-0700'),
    path.join(runnerTemp, 'fro-bot-response', '1-1'),
    path.join(runnerTemp, 'fro-bot-credentials-abc'),
    path.join(runnerTemp, 'fro-bot-attachments', '1-1'),
    path.join(home, '.local', 'share', 'opencode'),
    path.join(home, '.local', 'share', 'other'),
    path.join(home, '.config', 'opencode'),
    path.join(home, '.config', 'canary'),
    path.join(home, '.cache', 'opencode'),
    path.join(home, '.local', 'state', 'opencode'),
    path.join(home, '.docker'),
    path.join(work, '_actions'),
  ]
  for (const dir of dirs) fs.mkdirSync(dir, {recursive: true})
  fs.writeFileSync(path.join(workspace, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
  fs.writeFileSync(path.join(workspace, '.git', 'hooks', 'pre-push.sample'), '#!/bin/sh\n')
  fs.writeFileSync(path.join(workspace, '.git', 'info', 'exclude'), '# trusted\n')
  fs.writeFileSync(path.join(home, '.bashrc'), 'x')
  fs.writeFileSync(path.join(home, '.docker', 'config.json'), '{}')
  fs.symlinkSync('/etc', path.join(home, 'linked-etc'))

  const calls: string[][] = []
  const failWhen: Fixture['failWhen'] = {predicate: null}
  const aclFor = new Map<string, string>()
  const leftover = {value: ''}
  const run: PrivilegedRun = async argv => {
    calls.push([...argv])
    if (failWhen.predicate?.(argv) === true) return {exitCode: 1, stdout: ''}
    if (argv[0] === TOOLS.getfacl) return {exitCode: 0, stdout: aclFor.get(argv.at(-1) ?? '') ?? BASE_ACL}
    if (argv.includes('-print')) return {exitCode: 0, stdout: leftover.value}
    return {exitCode: 0, stdout: ''}
  }
  const manifest: HandoffManifest = {
    ids: {
      runnerUid: process.getuid?.() ?? 0,
      runnerGid: process.getgid?.() ?? 0,
      sandboxUid: SANDBOX_UID,
      sandboxGid: SANDBOX_GID,
    },
    runnerHome: home,
    runnerTemp,
    workspace,
    handedOver: [
      path.join(home, '.local', 'share', 'opencode'),
      path.join(home, '.config', 'opencode'),
      path.join(home, '.cache', 'opencode'),
      path.join(home, '.local', 'state', 'opencode'),
      path.join(runnerTemp, 'fro-bot-credentials-abc'),
      path.join(runnerTemp, 'fro-bot-response', '1-1'),
    ],
    readable: [path.join(runnerTemp, 'fro-bot-attachments', '1-1')],
    traverseOnly: [],
    tighten: [runnerTemp, path.join(runnerTemp, '_runner_file_commands')],
  }
  return {root, manifest, calls, deps: {run, tools: TOOLS, logger: createMockLogger()}, failWhen, aclFor, leftover}
}

const mutating = (calls: readonly string[][]): string[][] =>
  calls.filter(call => call[0] !== TOOLS.getfacl && !call.includes('-print'))

describe('sandbox handoff', () => {
  let fx: Fixture

  beforeEach(() => {
    fx = buildFixture()
  })
  afterEach(() => {
    fs.rmSync(fx.root, {recursive: true, force: true})
  })

  it('locks, traverses and grants exactly what the manifest names', async () => {
    // #given a runner home with secrets, canaries and a symlink beside the roots
    const {manifest} = fx
    const home = manifest.runnerHome

    // #when handed off
    const result = await handOff(manifest, fx.deps)

    // #then it succeeded
    expect(result.success).toBe(true)
    const argv = mutating(fx.calls).map(call => call.join(' '))
    const has = (needle: string): boolean => argv.some(line => line.includes(needle))

    // #and runner-private siblings are denied, down the chain (home entries, ~/.config and ~/.local/share siblings, _temp)
    expect(has(`-m u:${SANDBOX_UID}:--- ${home}/.docker`)).toBe(true)
    expect(has(`-m u:${SANDBOX_UID}:--- ${home}/.bashrc`)).toBe(true)
    expect(has(`-m u:${SANDBOX_UID}:--- ${home}/.config/canary`)).toBe(true)
    expect(has(`-m u:${SANDBOX_UID}:--- ${home}/.local/share/other`)).toBe(true)
    expect(has(`-m u:${SANDBOX_UID}:--- ${manifest.runnerTemp}/secret-0700`)).toBe(true)
    expect(has(`-m u:${SANDBOX_UID}:--- ${manifest.runnerTemp}/_runner_file_commands`)).toBe(true)
    expect(has(`-m u:${SANDBOX_UID}:--- ${home}/work/_actions`)).toBe(true)
    // #and roots, chain dirs and symlinks are never denied
    expect(
      has(`-m u:${SANDBOX_UID}:--- ${manifest.workspace} `) || argv.some(l => l.endsWith(`--- ${manifest.workspace}`)),
    ).toBe(false)
    expect(argv.some(l => l.endsWith(`--- ${home}/.config`))).toBe(false)
    expect(argv.some(l => l.endsWith(`--- ${home}/linked-etc`))).toBe(false)
    expect(argv.some(l => l.endsWith(`--- ${manifest.runnerTemp}/fro-bot-response`))).toBe(false)
    // #and the chain gets traverse-only
    expect(has(`-m u:${SANDBOX_UID}:--x ${home}`)).toBe(true)
    expect(argv.filter(l => l.endsWith(`--x ${manifest.runnerTemp}`))).toHaveLength(1)

    // #and the temp tree is tightened before its traverse grant
    const chmodTemp = argv.indexOf(`${TOOLS.chmod} 0700 ${manifest.runnerTemp}`)
    const traverseTemp = argv.findIndex(l => l.endsWith(`--x ${manifest.runnerTemp}`))
    expect(chmodTemp).toBeGreaterThanOrEqual(0)
    expect(chmodTemp).toBeLessThan(traverseTemp)

    // #and the checkout, every handed-over dir and the read-only dir are covered
    expect(has(`-R -P -m u:${SANDBOX_UID}:rwX ${manifest.workspace}`)).toBe(true)
    // (the sandbox only: no runner entry on the checkout, access or default; the runner is its owner and never reads it mid-run)
    expect(has(`-d -m u:${SANDBOX_UID}:rwX ${manifest.workspace}`) || has(`-d -m u:${SANDBOX_UID}:rwX {}`)).toBe(true)
    for (const dir of manifest.handedOver) {
      expect(
        has(
          `find -P ${dir} -xdev -user ${manifest.ids.runnerUid} -exec ${TOOLS.chown} -h ${SANDBOX_UID}:${SANDBOX_GID}`,
        ),
      ).toBe(true)
    }
    expect(has(`-R -P -m u:${SANDBOX_UID}:rX ${manifest.readable[0]}`)).toBe(true)
  })

  it('refuses to hand over when a root is a symlink, and changes nothing', async () => {
    // #given the response dir swapped for a symlink
    const response = path.join(fx.manifest.runnerTemp, 'fro-bot-response', '1-1')
    fs.rmSync(response, {recursive: true})
    fs.symlinkSync(fx.manifest.runnerHome, response)

    // #when handed off
    const result = await handOff(fx.manifest, fx.deps)

    // #then it is refused before any privileged mutation
    expect(!result.success && result.error).toContain('symlink')
    expect(mutating(fx.calls)).toEqual([])
  })

  describe('the trusted git snapshot (an allowlist of the keys actions/checkout writes)', () => {
    const gitPath = (name: string): string => path.join(fx.manifest.workspace, '.git', name)
    const writeConfig = (text: string): void => {
      fs.writeFileSync(gitPath('config'), text)
    }
    const refused = async (): Promise<string> => {
      const result = await handOff(fx.manifest, fx.deps)
      expect(result.success).toBe(false)
      // refused before any lock or grant; the only privileged commands are the rollback's own chown back of inodes the
      // sandbox owns (there are none)
      const applied = mutating(fx.calls).filter(call => !call.includes('-user') || !call.includes(String(SANDBOX_UID)))
      expect(applied).toEqual([])
      // the .git was there before the audit refused it, so the rollback is complete rather than blaming the run for creating it
      const message = result.success ? '' : result.error
      expect(message).not.toContain('rollback incomplete')
      expect(message).not.toContain('created during the run')
      return message
    }

    /** What actions/checkout leaves in `.git/config` for a normal (shallow, no-credentials) checkout. */
    const checkoutConfig = (workspace: string): string =>
      [
        '[core]',
        '\trepositoryformatversion = 0',
        '\tfilemode = true',
        '\tbare = false',
        '\tlogallrefupdates = true',
        '\tignorecase = true',
        '\tprecomposeunicode = true',
        '\tsymlinks = true',
        '[extensions]',
        '\tworktreeConfig = true',
        '[remote "origin"]',
        '\turl = https://github.com/fro-bot/agent',
        '\tfetch = +refs/heads/*:refs/remotes/origin/*',
        '\tpromisor = true',
        '\tpartialclonefilter = blob:none',
        '[branch "main"]',
        '\tremote = origin',
        '\tmerge = refs/heads/main',
        '[gc]',
        '\tauto = 0',
        '[safe]',
        `\tdirectory = ${workspace}`,
        '',
      ].join('\n')

    it('positive control: a real actions/checkout-shaped config is accepted', async () => {
      // #given
      writeConfig(checkoutConfig(fx.manifest.workspace))

      // #when / #then it is trusted as is
      const result = await handOff(fx.manifest, fx.deps)
      expect(result.success ? 'ok' : result.error).toBe('ok')
    })

    it('positive control: the exact local config of a real hosted actions/checkout (git-lfs installed) is accepted', async () => {
      // #given the keys `git config --local --list --name-only` printed on a GitHub-hosted runner after actions/checkout v7;
      // git-lfs 3.x is installed system-wide there, which is why the checkout writes lfs.repositoryformatversion
      writeConfig(
        [
          '[core]',
          '\trepositoryformatversion = 0',
          '\tfilemode = true',
          '\tbare = false',
          '\tlogallrefupdates = true',
          '[remote "origin"]',
          '\turl = https://github.com/fro-bot/.github',
          '\tfetch = +refs/heads/*:refs/remotes/origin/*',
          '[branch "probe/isolate-agent-live"]',
          '\tremote = origin',
          '\tmerge = refs/heads/probe/isolate-agent-live',
          '[gc]',
          '\tauto = 0',
          '[lfs]',
          '\trepositoryformatversion = 0',
          '',
        ].join('\n'),
      )

      // #when / #then it is trusted as is, and the rollback has nothing to report
      const result = await handOff(fx.manifest, fx.deps)
      expect(result.success ? 'ok' : result.error).toBe('ok')
    })

    it('positive control: the config.worktree a real actions/checkout v7 leaves behind (sparse-checkout disabled) is accepted', async () => {
      // #given checkout v7 sets extensions.worktreeConfig, runs `git sparse-checkout disable`, then unsets the extension. That
      // leaves a real config.worktree (git ignores it from then on, the audit still reads it) beside the lfs local config
      writeConfig(
        [
          '[core]',
          '\trepositoryformatversion = 0',
          '\tfilemode = true',
          '\tbare = false',
          '\tlogallrefupdates = true',
          '[remote "origin"]',
          '\turl = https://github.com/fro-bot/.github',
          '\tfetch = +refs/heads/*:refs/remotes/origin/*',
          '[branch "probe/isolate-agent-live"]',
          '\tremote = origin',
          '\tmerge = refs/heads/probe/isolate-agent-live',
          '[gc]',
          '\tauto = 0',
          '[lfs]',
          '\trepositoryformatversion = 0',
          '',
        ].join('\n'),
      )
      fs.writeFileSync(
        gitPath('config.worktree'),
        '[core]\n\tsparseCheckout = false\n\tsparseCheckoutCone = false\n[index]\n\tsparse = false\n',
      )

      // #when / #then it is trusted as is
      const result = await handOff(fx.manifest, fx.deps)
      expect(result.success ? 'ok' : result.error).toBe('ok')
    })

    it('positive control: the same config in config.worktree is accepted too', async () => {
      // #given
      fs.writeFileSync(gitPath('config.worktree'), '[core]\n\tfilemode = true\n')

      // #when / #then
      expect((await handOff(fx.manifest, fx.deps)).success).toBe(true)
    })

    it.each([
      ['a clean filter that runs a script', '[filter "x"]\n\tclean = sh scripts/clean.sh\n', 'filter.x.clean'],
      ['a smudge filter', '[filter "x"]\n\tsmudge = ./smudge\n', 'filter.x.smudge'],
      ['a textconv driver', '[diff "x"]\n\ttextconv = ./conv\n', 'diff.x.textconv'],
      ['an external diff', '[diff]\n\texternal = /usr/bin/true\n', 'diff.external'],
      ['a merge driver', '[merge "x"]\n\tdriver = ./merge %O %A %B\n', 'merge.x.driver'],
      ['an alias', '[alias]\n\tgo = !sh -c x\n', 'alias.go'],
      [
        'an include that points outside every writable root',
        '[include]\n\tpath = /etc/gitconfig-extra\n',
        'include.path',
      ],
      ['a relative include', '[include]\n\tpath = ../model.config\n', 'include.path'],
      ['a conditional include', '[includeIf "gitdir:/x/"]\n\tpath = /etc/y\n', 'includeif.gitdir:/x/.path'],
      ['core.hooksPath, even /dev/null', '[core]\n\thooksPath = /dev/null\n', 'core.hookspath'],
      ['core.attributesFile', '[core]\n\tattributesFile = /etc/attrs\n', 'core.attributesfile'],
      ['core.excludesFile', '[core]\n\texcludesFile = /etc/ignore\n', 'core.excludesfile'],
      ['core.fsmonitor', '[core]\n\tfsmonitor = true\n', 'core.fsmonitor'],
      ['core.sshCommand', '[core]\n\tsshCommand = ssh -i key\n', 'core.sshcommand'],
      ['core.editor', '[core]\n\teditor = vi\n', 'core.editor'],
      ['a credential helper', '[credential]\n\thelper = store\n', 'credential.helper'],
      ['a credential helper for a url', '[credential "https://x"]\n\thelper = !f\n', 'credential.https://x.helper'],
      ['an http setting', '[http]\n\tproxy = http://x\n', 'http.proxy'],
      ['a persisted extra header', '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: x\n', 'extraheader'],
      ['a submodule', '[submodule "s"]\n\turl = https://x/s\n', 'submodule.s.url'],
      ['a remote pushurl', '[remote "origin"]\n\tpushurl = https://x\n', 'remote.origin.pushurl'],
      ['a remote with an unknown option', '[remote "origin"]\n\tuploadpack = ./x\n', 'remote.origin.uploadpack'],
      ['a branch with an unknown option', '[branch "main"]\n\tmergeOptions = --x\n', 'branch.main.mergeoptions'],
      ['an unknown section', '[whatever]\n\tx = y\n', 'whatever.x'],
      ['lfs.url in local config', '[lfs]\n\turl = https://x/lfs\n', 'lfs.url'],
      ['lfs.url beside the allowed lfs key', '[lfs]\n\trepositoryformatversion = 0\n\turl = https://x\n', 'lfs.url'],
      ['lfs.customtransfer.*', '[lfs "customtransfer.x"]\n\tpath = ./xfer\n', 'lfs.customtransfer.x.path'],
      ['an lfs filter in local config', '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n', 'filter.lfs.clean'],
    ])('refuses %s, naming the key', async (_label, text, key) => {
      // #given a config with one key outside the allowlist, beside an otherwise normal checkout config
      writeConfig(`${checkoutConfig(fx.manifest.workspace)}${text}`)

      // #when / #then it is refused by key
      const message = await refused()
      expect(message).toContain('allowlist')
      expect(message.toLowerCase()).toContain(key.toLowerCase())
    })

    it('refuses an include whose target is a symlink out of the checkout', async () => {
      // #given an include that goes through a symlink inside the checkout
      const target = path.join(fx.root, 'outside.config')
      fs.writeFileSync(target, '[core]\n')
      fs.symlinkSync(target, path.join(fx.manifest.workspace, 'link.config'))
      writeConfig(`${checkoutConfig(fx.manifest.workspace)}[include]\n\tpath = ../link.config\n`)

      // #when / #then the include key alone is enough; nothing is followed
      expect(await refused()).toContain('include.path')
    })

    it('refuses a url that names a transport helper (ext::, fd::)', async () => {
      // #given
      writeConfig(
        `${checkoutConfig(fx.manifest.workspace).replace('https://github.com/fro-bot/agent', 'ext::sh -c x')}`,
      )

      // #when / #then
      expect(await refused()).toMatch(/remote\.origin\.url.*transport helper/)
    })

    it('does not read includes: a key inside an included file never matters, the include itself is the problem', async () => {
      // #given an include of a file that is itself harmless
      const harmless = path.join(fx.root, 'harmless.config')
      fs.writeFileSync(harmless, '[core]\n\tfilemode = true\n')
      writeConfig(`${checkoutConfig(fx.manifest.workspace)}[include]\n\tpath = ${harmless}\n`)

      // #when / #then it is still refused: include is not on the allowlist
      expect(await refused()).toContain('include.path')
    })

    it('also audits config.worktree', async () => {
      // #given
      fs.writeFileSync(gitPath('config.worktree'), '[core]\n\tfsmonitor = ./fsmon.sh\n')

      // #when / #then
      const message = await refused()
      expect(message).toContain('config.worktree')
      expect(message).toContain('core.fsmonitor')
    })

    it('refuses a config git itself cannot parse, naming the file', async () => {
      // #given
      writeConfig('[core\n\tbroken')

      // #when / #then
      expect(await refused()).toMatch(/config.*could not be parsed/)
    })

    it('refuses an oversize config by size', async () => {
      // #given
      writeConfig(`[core]\n${'#'.repeat(1024 * 1024 + 1)}\n`)

      // #when / #then
      expect(await refused()).toMatch(/config.*cannot be audited/)
    })

    it.each(['config', 'config.worktree'])('refuses %s when it is a symlink, even to a harmless file', async name => {
      // #given a symlink where a regular file should be
      const harmless = path.join(fx.root, 'harmless.cfg')
      fs.writeFileSync(harmless, '[core]\n')
      fs.rmSync(gitPath(name), {force: true})
      fs.symlinkSync(harmless, gitPath(name))

      // #when / #then the snapshot would preserve the link verbatim, so it is refused by name
      expect(await refused()).toMatch(new RegExp(`${name.replace('.', String.raw`\.`)}.*symlink`))
    })

    it('refuses a symlink nested in hooks/ or info/', async () => {
      // #given
      fs.symlinkSync('../../model-attributes', gitPath('info/attributes'))

      // #when / #then
      expect(await refused()).toMatch(/info\/attributes.*symlink/)
    })

    it('refuses a special file in the snapshot', async () => {
      // #given a FIFO among the hooks (mkfifo)
      const made = spawnSync('mkfifo', [gitPath('hooks/fifo-hook')])
      if (made.status !== 0) return

      // #when / #then
      expect(await refused()).toMatch(/hooks\/fifo-hook/)
    })
  })

  describe('the reserved _actions subtree', () => {
    const actions = (fxx: Fixture): string => path.join(path.dirname(fxx.manifest.runnerTemp), '_actions')

    it.each([
      ['the checkout equals _actions', (a: string) => ({workspace: a})],
      ['the checkout sits under _actions', (a: string) => ({workspace: path.join(a, 'fro-bot', 'agent', 'v1')})],
      ['the checkout contains _actions (it is the work directory)', (a: string) => ({workspace: path.dirname(a)})],
      ['a handed-over directory sits under _actions', (a: string) => ({handedOver: [path.join(a, 'fro-bot')]})],
      ['a handed-over directory is _actions', (a: string) => ({handedOver: [a]})],
      ['a handed-over directory contains _actions', (a: string) => ({handedOver: [path.dirname(a)]})],
      ['a readable directory sits under _actions', (a: string) => ({readable: [path.join(a, 'fro-bot')]})],
      ['a traverse-only directory is under _actions', (a: string) => ({traverseOnly: [path.join(a, 'fro-bot')]})],
    ])('refuses to hand over when %s, before any mutation', async (_label, override) => {
      // #given a grant that equals, contains or lies under the runner's downloaded-actions tree
      const a = actions(fx)
      fs.mkdirSync(path.join(a, 'fro-bot', 'agent', 'v1'), {recursive: true})
      const reserved = {...fx.manifest, ...override(a)}

      // #when handed off
      const result = await handOff(reserved, fx.deps)

      // #then it is refused by name and nothing was changed
      expect(!result.success && result.error).toContain('_actions')
      expect(mutating(fx.calls)).toEqual([])
    })

    it('applies the same rule before take-back', async () => {
      // #given a manifest that is reserved-overlapping at take-back time
      const a = actions(fx)
      const problem = await verifyRoots({...fx.manifest, handedOver: [a]}, fx.deps, 'take-back')

      // #then
      expect(problem).toContain('_actions')
    })

    it('allows siblings that merely share the name prefix, and a directory named ..action beside it', async () => {
      // #given grants beside _actions: _actions-cache and ..action (a real directory, not a climb)
      const work = path.dirname(fx.manifest.runnerTemp)
      const siblings = [path.join(work, '_actions-cache'), path.join(work, '..action')]
      for (const dir of siblings) fs.mkdirSync(dir, {recursive: true})

      // #when verified
      const problem = await verifyRoots(
        {...fx.manifest, readable: [...fx.manifest.readable, ...siblings]},
        fx.deps,
        'handoff',
      )

      // #then neither is reserved
      expect(problem).toBeNull()
    })
  })

  it('refuses a root or ancestor owned by someone else', async () => {
    // #given a runner uid that does not match the owner of anything on disk
    const foreign = {...fx.manifest, ids: {...fx.manifest.ids, runnerUid: (process.getuid?.() ?? 0) + 4242}}

    // #when verified
    const problem = await verifyRoots(foreign, fx.deps, 'handoff')

    // #then ownership is the stated reason
    expect(problem).toContain('owned by uid')
  })

  it('refuses a symlinked ancestor', async () => {
    // #given the checkout reached through a symlinked parent
    const real = path.join(fx.root, 'real-parent')
    fs.mkdirSync(path.join(real, 'ws'), {recursive: true})
    fs.symlinkSync(real, path.join(fx.root, 'link-parent'))
    const viaLink = {...fx.manifest, workspace: path.join(fx.root, 'link-parent', 'ws')}

    // #when verified
    const problem = await verifyRoots(viaLink, fx.deps, 'handoff')

    // #then
    expect(problem).toContain('symlink')
  })

  it('refuses an ancestor that grants the sandbox write access', async () => {
    // #given an ancestor ACL naming the sandbox with write
    fx.aclFor.set(path.join(fx.manifest.runnerHome, 'work'), `${BASE_ACL}user:${SANDBOX_UID}:rwx\n`)

    // #when verified
    const problem = await verifyRoots(fx.manifest, fx.deps, 'take-back')

    // #then
    expect(problem).toContain('grants the sandbox write access')
    expect(grantsSandboxWrite(`default:user:${SANDBOX_UID}:-w-`, SANDBOX_UID)).toBe(true)
    expect(grantsSandboxWrite(`user:${SANDBOX_UID}:r-x`, SANDBOX_UID)).toBe(false)
  })

  it('rolls back what it recorded when a step fails partway, and reports the failure', async () => {
    // #given the checkout ACL step failing, after the locks were applied
    fx.failWhen.predicate = argv => argv[0] === TOOLS.setfacl && argv.includes(`u:${SANDBOX_UID}:rwX`)

    // #when handed off
    const result = await handOff(fx.manifest, fx.deps)

    // #then it fails before launch and the locks it applied were reversed (ACL cleared, mode restored)
    expect(!result.success && result.error).toContain('Sandbox handoff failed')
    const argv = mutating(fx.calls).map(call => call.join(' '))
    const firstDeny = argv.findIndex(l => l.includes(`u:${SANDBOX_UID}:---`))
    const rollbackBase = argv.findIndex(l => l.startsWith(`${TOOLS.setfacl} -P -b`))
    expect(firstDeny).toBeGreaterThanOrEqual(0)
    expect(rollbackBase).toBeGreaterThan(firstDeny)
    expect(argv.some(l => l.startsWith(`${TOOLS.chmod} `) && !l.includes('0700'))).toBe(true)
  })

  it('refuses a .git/commondir that already exists at handoff, changing nothing', async () => {
    // #given a checkout whose .git already redirects its config and objects elsewhere
    fs.writeFileSync(path.join(fx.manifest.workspace, '.git', 'commondir'), '../elsewhere\n')

    // #when handed off
    const result = await handOff(fx.manifest, fx.deps)

    // #then it is refused by name before any privileged command ran
    expect(!result.success && result.error).toContain('commondir')
    expect(mutating(fx.calls)).toEqual([])
  })

  it('refuses a gitfile .git at handoff', async () => {
    // #given .git replaced by a gitfile
    const gitDir = path.join(fx.manifest.workspace, '.git')
    fs.rmSync(gitDir, {recursive: true})
    fs.writeFileSync(gitDir, 'gitdir: /somewhere/else\n')

    // #when handed off
    const result = await handOff(fx.manifest, fx.deps)

    // #then
    expect(!result.success && result.error).toContain('.git')
  })

  it('refuses a .git that is a gitfile or symlink at handoff', async () => {
    // #given .git replaced by a symlink
    const gitDir = path.join(fx.manifest.workspace, '.git')
    fs.rmSync(gitDir, {recursive: true})
    fs.symlinkSync(fx.root, gitDir)

    // #when handed off
    const result = await handOff(fx.manifest, fx.deps)

    // #then
    expect(!result.success && result.error).toContain('.git')
  })
})

describe('sandbox take-back', () => {
  let fx: Fixture

  beforeEach(() => {
    fx = buildFixture()
  })
  afterEach(() => {
    fs.rmSync(fx.root, {recursive: true, force: true})
  })

  async function handedOff(): Promise<Awaited<ReturnType<typeof handOff>> & {success: true}> {
    const result = await handOff(fx.manifest, fx.deps)
    if (!result.success) throw new Error(result.error)
    return result
  }

  it('reverses exactly what handoff recorded, in order', async () => {
    // #given a completed handoff
    const handed = await handedOff()
    fx.calls.length = 0

    // #when taken back
    const outcome = await takeBack(fx.manifest, handed.data, fx.deps)

    // #then the sandbox's inodes are chowned back per root (with owner rwX on non-links in the same pass)
    expect(outcome.status).toBe('restored')
    const argv = mutating(fx.calls).map(call => call.join(' '))
    for (const root of [fx.manifest.workspace, ...fx.manifest.handedOver]) {
      expect(argv).toContain(
        `${TOOLS.find} -P ${root} -xdev -user ${SANDBOX_UID} -exec ${TOOLS.chown} -h ${fx.manifest.ids.runnerUid}:${fx.manifest.ids.runnerGid} {} + ! -type l -exec ${TOOLS.chmod} u+rwX {} +`,
      )
    }
    // #and recorded modes are restored
    expect(argv).toContain(
      `${TOOLS.chmod} ${(fs.statSync(fx.manifest.runnerHome).mode & 0o7777).toString(8).padStart(4, '0')} ${fx.manifest.runnerHome}`,
    )
    // #and the chown comes before any ACL removal
    const lastChown = argv.map(l => l.includes(` -user ${SANDBOX_UID} -exec`)).lastIndexOf(true)
    const firstRemoval = argv.findIndex(l => l.includes(' -x u:') || l.includes(' -d -x u:'))
    expect(lastChown).toBeGreaterThanOrEqual(0)
    expect(lastChown).toBeLessThan(firstRemoval)
    // #and the private snapshot is gone
    expect(fs.existsSync(handed.data.snapshotDir)).toBe(false)
  })

  it("removes only this run's ACL entries, access and default, and never wipes a tree with -b", async () => {
    // #given a completed handoff over a checkout, handed-over dirs and a readable dir
    const handed = await handedOff()
    fx.calls.length = 0
    const {runnerUid} = fx.manifest.ids

    // #when taken back
    await takeBack(fx.manifest, handed.data, fx.deps)
    const argv = mutating(fx.calls).map(call => call.join(' '))

    // #then the checkout loses the sandbox's access entry and default entry
    const ws = fx.manifest.workspace
    expect(argv).toContain(`${TOOLS.setfacl} -R -P -n -x u:${SANDBOX_UID} ${ws}`)
    expect(argv).toContain(
      `${TOOLS.find} -P ${ws} -xdev -type d -exec ${TOOLS.setfacl} -P -d -n -x u:${SANDBOX_UID} {} +`,
    )
    // #and a handed-over dir loses only the runner entry handoff added; a readable dir only the sandbox's
    const handedDir = fx.manifest.handedOver[0] ?? ''
    expect(argv).toContain(`${TOOLS.setfacl} -R -P -n -x u:${runnerUid} ${handedDir}`)
    const readable = fx.manifest.readable[0] ?? ''
    expect(argv).toContain(`${TOOLS.setfacl} -R -P -n -x u:${SANDBOX_UID} ${readable}`)
    expect(argv).toContain(
      `${TOOLS.find} -P ${readable} -xdev -type d -exec ${TOOLS.setfacl} -P -d -n -x u:${SANDBOX_UID} {} +`,
    )
    // #and -b is used only on the individual chain dirs the handoff recorded, never on a tree
    const trees = [ws, ...fx.manifest.handedOver, ...fx.manifest.readable]
    expect(argv.filter(line => line.includes(' -b ') && trees.some(tree => line.endsWith(` ${tree}`)))).toEqual([])
    expect(argv.some(line => line.includes(' -R ') && line.includes(' -b '))).toBe(false)
  })

  it('gives the runner no ACL entry on the checkout, so take-back removes none and a pre-existing runner grant survives', async () => {
    // #given a completed handoff: only the sandbox is named on the checkout (access and default). The runner is the owner
    // and, in the audited run window, reads and writes nothing inside the checkout, so a default entry for it would only be
    // inherited by every file the sandbox creates, and removing it at take-back would also remove a grant that existed before
    const handed = await handedOff()
    const {runnerUid} = fx.manifest.ids
    const ws = fx.manifest.workspace
    const handoffCalls = mutating(fx.calls).map(call => call.join(' '))
    fx.calls.length = 0

    // #when taken back
    await takeBack(fx.manifest, handed.data, fx.deps)
    const takeBackCalls = mutating(fx.calls).map(call => call.join(' '))

    // #then neither direction names the runner uid on the checkout tree
    const onWorkspace = (line: string): boolean => line.includes(` ${ws}`) || line.includes(`find -P ${ws} `)
    const naming = (line: string): boolean => new RegExp(`(^|[ ,:])u:${runnerUid}(:|,| |$)`).test(line)
    expect(handoffCalls.filter(line => onWorkspace(line) && line.includes('setfacl') && naming(line))).toEqual([])
    expect(takeBackCalls.filter(line => onWorkspace(line) && line.includes('setfacl') && naming(line))).toEqual([])
  })

  it('removes with -n everywhere, so no removal recalculates the mask (a rw- file must not gain an execute bit)', async () => {
    // #given a completed handoff
    const handed = await handedOff()
    fx.calls.length = 0

    // #when taken back
    await takeBack(fx.manifest, handed.data, fx.deps)
    const removals = mutating(fx.calls).filter(call => call.includes('-x'))

    // #then every entry removal passes -n: removing a named entry makes setfacl recalculate the mask as the union of the
    // stored entries, which turns a file the model created as rw- into one whose group class has x, and reconstruction
    // refuses an executable file
    expect(removals.length).toBeGreaterThan(0)
    expect(removals.filter(call => !call.includes('-n')).map(call => call.join(' '))).toEqual([])
  })

  it('uses the same entry-by-entry removal when a partial handoff rolls back', async () => {
    // #given a handoff that fails after the checkout and the handed-over dirs were granted
    fx.failWhen.predicate = argv => argv.includes(`u:${SANDBOX_UID}:rX`) && argv.includes('-R')

    // #when
    const result = await handOff(fx.manifest, fx.deps)

    // #then the rollback removed this run's entries and wiped no tree
    expect(result.success).toBe(false)
    const argv = mutating(fx.calls).map(call => call.join(' '))
    expect(argv).toContain(`${TOOLS.setfacl} -R -P -n -x u:${SANDBOX_UID} ${fx.manifest.workspace}`)
    expect(argv.some(line => line.includes(' -R ') && line.includes(' -b '))).toBe(false)
  })

  it('moves the trusted git metadata into place by rename, so it needs no free space', async () => {
    // #given a handoff and the inode of the trusted copy
    const handed = await handedOff()
    const gitDir = path.join(fx.manifest.workspace, '.git')
    const trusted = path.join(handed.data.snapshotDir, 'git', 'config')
    const trustedInode = fs.statSync(trusted).ino
    fs.rmSync(path.join(gitDir, 'config'))
    fs.writeFileSync(path.join(gitDir, 'config'), `[core]\n\tfsmonitor = ${path.join(fx.root, 'payload')}\n`)

    // #when taken back
    const outcome = await takeBack(fx.manifest, handed.data, fx.deps)

    // #then the file in .git is the very inode of the trusted copy (a rename), not a fresh copy
    expect(outcome.status).toBe('restored')
    expect(fs.statSync(path.join(gitDir, 'config')).ino).toBe(trustedInode)
    expect(fs.readFileSync(path.join(gitDir, 'config'), 'utf8')).toBe('[core]\n\trepositoryformatversion = 0\n')
  })

  it('is unsafe when a command is killed on its deadline, naming the timeout', async () => {
    // #given the checkout chown being killed (exit null)
    const handed = await handedOff()
    fx.failWhen.predicate = null
    const baseRun = fx.deps.run
    const deps = {
      ...fx.deps,
      run: (async (argv, options) => {
        if (argv.includes(TOOLS.chown) && argv.includes(fx.manifest.workspace)) {
          return {exitCode: null, stdout: '', stderr: 'chown: stuck on a busy inode', timedOutAfterMs: 4321}
        }
        return baseRun(argv, options)
      }) satisfies PrivilegedRun,
    }

    // #when
    const outcome = await takeBack(fx.manifest, handed.data, deps)

    // #then
    expect(outcome.status === 'unsafe' && outcome.reason).toContain('timed out after 4321ms')
    expect(outcome.status === 'unsafe' && outcome.reason).toContain('stuck on a busy inode')
  })

  it('gives every take-back command what is left of a shared deadline and starts none after it', async () => {
    // #given a clock the commands advance and a small budget
    const handed = await handedOff()
    let clock = 0
    const seen: (number | undefined)[] = []
    const started: string[] = []
    const baseRun = fx.deps.run
    const deps: HandoffDeps = {
      ...fx.deps,
      now: () => clock,
      budgetMs: 1000,
      run: async (argv, options) => {
        seen.push(options?.timeoutMs)
        started.push(argv.join(' '))
        clock += 400
        return baseRun(argv, options)
      },
    }

    // #when taken back
    const outcome = await takeBack(fx.manifest, handed.data, deps)

    // #then each command was bounded by the time left, and the third onward never started
    expect(seen.slice(0, 3)).toEqual([1000, 600, 200])
    expect(seen.every(value => value !== undefined && value <= 1000)).toBe(true)
    expect(started.length).toBe(3)
    expect(outcome.status).toBe('unsafe')
  })

  it('still reverts the runner-surface locks when the sandbox files could not be restored', async () => {
    // #given sandbox-owned files left behind (the data restore fails)
    const handed = await handedOff()
    fx.leftover.value = `${fx.manifest.workspace}/leftover\n`
    fx.calls.length = 0

    // #when taken back
    const outcome = await takeBack(fx.manifest, handed.data, fx.deps)

    // #then the result is unsafe, but the runner temp mode and the chain dir ACLs were still reverted
    expect(outcome.status).toBe('unsafe')
    const argv = mutating(fx.calls).map(call => call.join(' '))
    expect(argv).toContain(
      `${TOOLS.chmod} ${(fs.statSync(fx.manifest.runnerTemp).mode & 0o7777).toString(8).padStart(4, '0')} ${fx.manifest.runnerTemp}`,
    )
    expect(argv).toContain(`${TOOLS.setfacl} -P -b ${fx.manifest.runnerHome}`)
  })

  it('restores an extended ACL it recorded rather than only clearing it', async () => {
    // #given a chain dir that carried a pre-existing named ACL entry
    fx.aclFor.set(fx.manifest.runnerHome, `${BASE_ACL}user:1234:r-x\nmask::r-x\n`)
    const handed = await handedOff()
    fx.calls.length = 0

    // #when taken back
    await takeBack(fx.manifest, handed.data, fx.deps)

    // #then the original is re-applied from the stored copy after the clear
    const argv = mutating(fx.calls).map(call => call.join(' '))
    expect(argv.some(l => l.startsWith(`${TOOLS.setfacl} -P --set-file=`) && l.endsWith(fx.manifest.runnerHome))).toBe(
      true,
    )
  })

  it('is unsafe when a take-back step fails', async () => {
    // #given a failing chown of the checkout
    const handed = await handedOff()
    fx.failWhen.predicate = argv => argv.includes(TOOLS.chown) && argv.includes(fx.manifest.workspace)

    // #when taken back
    const outcome = await takeBack(fx.manifest, handed.data, fx.deps)

    // #then
    expect(outcome.status).toBe('unsafe')
  })

  it('is unsafe when sandbox-owned files remain after the chown', async () => {
    // #given find still reporting a sandbox-owned file
    const handed = await handedOff()
    fx.leftover.value = `${fx.manifest.workspace}/leftover\n`

    // #when taken back
    const outcome = await takeBack(fx.manifest, handed.data, fx.deps)

    // #then
    expect(outcome.status === 'unsafe' && outcome.reason).toContain('still holds files owned by the sandbox')
  })

  it('is unsafe, and moves nothing, when a root was swapped for a symlink', async () => {
    // #given the sandbox replaced the checkout's parent with a link
    const handed = await handedOff()
    fx.calls.length = 0
    const parent = path.dirname(fx.manifest.workspace)
    fs.renameSync(parent, `${parent}-moved`)
    fs.symlinkSync(`${parent}-moved`, parent)

    // #when taken back
    const outcome = await takeBack(fx.manifest, handed.data, fx.deps)

    // #then
    expect(outcome.status).toBe('unsafe')
    expect(mutating(fx.calls)).toEqual([])
  })

  it.each([
    [
      'a symlink',
      (gitDir: string, root: string) => {
        fs.rmSync(gitDir, {recursive: true})
        fs.symlinkSync(root, gitDir)
      },
    ],
    [
      'a gitfile',
      (gitDir: string) => {
        fs.rmSync(gitDir, {recursive: true})
        fs.writeFileSync(gitDir, 'gitdir: /elsewhere\n')
      },
    ],
  ])('is unsafe, and moves nothing, when .git became %s', async (_label, mutate) => {
    // #given .git replaced after handoff
    const handed = await handedOff()
    fx.calls.length = 0
    mutate(path.join(fx.manifest.workspace, '.git'), fx.root)

    // #when taken back
    const outcome = await takeBack(fx.manifest, handed.data, fx.deps)

    // #then it is unsafe before any chown
    expect(outcome.status === 'unsafe' && outcome.reason).toContain('.git')
    expect(mutating(fx.calls)).toEqual([])
  })

  it('writes the pre-model git metadata over whatever the model left', async () => {
    // #given a model that rewrote config, added a hook, a config.worktree and info/attributes
    const handed = await handedOff()
    const gitDir = path.join(fx.manifest.workspace, '.git')
    fs.rmSync(path.join(gitDir, 'config'))
    fs.writeFileSync(
      path.join(gitDir, 'config'),
      `[core]\n\tfsmonitor = ${path.join(fx.root, 'payload')}\n[include]\n\tpath = ${path.join(fx.root, 'evil')}\n`,
    )
    fs.writeFileSync(path.join(gitDir, 'config.worktree'), `[core]\n\tfsmonitor = ${path.join(fx.root, 'payload2')}\n`)
    fs.writeFileSync(path.join(gitDir, 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${path.join(fx.root, 'hook')}\n`)
    fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), '* filter=x\n')
    fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), '# tampered\n')

    // #when taken back
    const outcome = await takeBack(fx.manifest, handed.data, fx.deps)

    // #then trusted versions are back and nothing the model added survives
    expect(outcome.status).toBe('restored')
    expect(fs.readFileSync(path.join(gitDir, 'config'), 'utf8')).toBe('[core]\n\trepositoryformatversion = 0\n')
    expect(fs.existsSync(path.join(gitDir, 'config.worktree'))).toBe(false)
    expect(fs.existsSync(path.join(gitDir, 'hooks', 'pre-commit'))).toBe(false)
    expect(fs.existsSync(path.join(gitDir, 'hooks', 'pre-push.sample'))).toBe(true)
    expect(fs.existsSync(path.join(gitDir, 'info', 'attributes'))).toBe(false)
    expect(fs.readFileSync(path.join(gitDir, 'info', 'exclude'), 'utf8')).toBe('# trusted\n')
  })

  it('replaces a hooks directory the model turned into a symlink without touching the target', async () => {
    // #given hooks/ replaced by a link to a runner directory
    const handed = await handedOff()
    const gitDir = path.join(fx.manifest.workspace, '.git')
    const target = path.join(fx.root, 'precious')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'keep'), 'keep')
    fs.rmSync(path.join(gitDir, 'hooks'), {recursive: true})
    fs.symlinkSync(target, path.join(gitDir, 'hooks'))

    // #when taken back
    const outcome = await takeBack(fx.manifest, handed.data, fx.deps)

    // #then the link is replaced by the real directory and the target is untouched
    expect(outcome.status).toBe('restored')
    expect(fs.lstatSync(path.join(gitDir, 'hooks')).isDirectory()).toBe(true)
    expect(fs.readFileSync(path.join(target, 'keep'), 'utf8')).toBe('keep')
  })

  it('is unsafe, and deletes nothing, when the model planted .git/commondir', async () => {
    // #given a handoff over a clean .git, then a commondir written by the sandbox
    const handed = await handedOff()
    const commondir = path.join(fx.manifest.workspace, '.git', 'commondir')
    fs.writeFileSync(commondir, '../evil\n')
    fx.calls.length = 0

    // #when taken back
    const outcome = await takeBack(fx.manifest, handed.data, fx.deps)

    // #then it is unsafe by name, nothing was moved, and the evidence was left in place (refuse, don't repair)
    expect(outcome.status === 'unsafe' && outcome.reason).toContain('commondir')
    expect(mutating(fx.calls)).toEqual([])
    expect(fs.readFileSync(commondir, 'utf8')).toBe('../evil\n')
  })

  it.skipIf(process.getuid?.() === 0)(
    'treats an unreadable .git as a possible commondir: unsafe, never assumed clean',
    async () => {
      // #given a .git the sandbox made untraversable, so "does commondir exist" cannot be answered
      const handed = await handedOff()
      const gitDir = path.join(fx.manifest.workspace, '.git')
      fs.chmodSync(gitDir, 0o000)
      fx.calls.length = 0

      try {
        // #when taken back
        const outcome = await takeBack(fx.manifest, handed.data, fx.deps)

        // #then a lookup that is not a clean "absent" is refused
        expect(outcome.status).toBe('unsafe')
        expect(mutating(fx.calls)).toEqual([])
      } finally {
        fs.chmodSync(gitDir, 0o755)
      }
    },
  )

  it('is unsafe when the model replaced .git with a gitfile', async () => {
    // #given a handoff, then .git swapped for a gitfile
    const handed = await handedOff()
    const gitDir = path.join(fx.manifest.workspace, '.git')
    fs.rmSync(gitDir, {recursive: true})
    fs.writeFileSync(gitDir, 'gitdir: /somewhere/else\n')
    fx.calls.length = 0

    // #when taken back
    const outcome = await takeBack(fx.manifest, handed.data, fx.deps)

    // #then
    expect(outcome.status).toBe('unsafe')
    expect(mutating(fx.calls)).toEqual([])
  })

  it('is unsafe when .git was created during a run that started without one', async () => {
    // #given a checkout without .git at handoff
    fs.rmSync(path.join(fx.manifest.workspace, '.git'), {recursive: true})
    const handed = await handedOff()
    fs.mkdirSync(path.join(fx.manifest.workspace, '.git'))

    // #when taken back
    const outcome = await takeBack(fx.manifest, handed.data, fx.deps)

    // #then
    expect(outcome.status === 'unsafe' && outcome.reason).toContain('created during the run')
  })
})

describe('planLocks', () => {
  it('never locks a symlink or a root-owned entry', async () => {
    // #given the fixture with a symlink in the home
    const fx = buildFixture()
    try {
      const plan = await planLocks(fx.manifest)

      // #then the symlink is skipped
      expect(plan.deny.some(entry => entry.endsWith('linked-etc'))).toBe(false)
      expect(plan.deny.length).toBeGreaterThan(5)
    } finally {
      fs.rmSync(fx.root, {recursive: true, force: true})
    }
  })

  it('still denies the secrets beside a grant when the directory on the way to it is named ..something', async () => {
    // #given a grant at <temp>/..x/resp, with a runner-only file beside it in the directory named ..x
    const fx = buildFixture()
    try {
      // (a temp tree outside the runner home, so only the temp-tree rule can cover it)
      const temp = path.join(fx.root, 'tmpx')
      const chainDir = path.join(temp, '..x')
      const grant = path.join(chainDir, 'resp')
      fs.mkdirSync(grant, {recursive: true})
      fs.writeFileSync(path.join(chainDir, 'secret.txt'), 'runner only')

      // #when the lock plan is made
      const plan = await planLocks({...fx.manifest, runnerTemp: temp, handedOver: [grant]})

      // #then the directory counts as inside the temp tree (a name starting with two dots is not a climb), so the secret is denied
      expect(plan.deny).toContain(path.join(chainDir, 'secret.txt'))
    } finally {
      fs.rmSync(fx.root, {recursive: true, force: true})
    }
  })
})
