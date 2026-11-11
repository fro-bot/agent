import type {PrivilegedRun} from '@fro-bot/runtime'
import type {HandoffDeps, HandoffManifest} from './sandbox-handoff.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {grantsSandboxWrite, handOff, planLocks, takeBack, verifyRoots} from './sandbox-handoff.js'

const SANDBOX_UID = 998
const SANDBOX_GID = 997
const TOOLS = {
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
    expect(has(`-d -m u:${SANDBOX_UID}:rwX,u:${manifest.ids.runnerUid}:rwX`)).toBe(true)
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

    // #then the sandbox's inodes are chowned back per root, ACLs cleared per tree and recorded modes restored
    expect(outcome.status).toBe('restored')
    const argv = mutating(fx.calls).map(call => call.join(' '))
    for (const root of [fx.manifest.workspace, ...fx.manifest.handedOver]) {
      expect(argv).toContain(
        `${TOOLS.find} -P ${root} -xdev -user ${SANDBOX_UID} -exec ${TOOLS.chown} -h ${fx.manifest.ids.runnerUid}:${fx.manifest.ids.runnerGid} {} +`,
      )
    }
    expect(argv).toContain(`${TOOLS.setfacl} -R -P -b ${fx.manifest.workspace}`)
    expect(argv).toContain(
      `${TOOLS.chmod} ${(fs.statSync(fx.manifest.runnerHome).mode & 0o7777).toString(8).padStart(4, '0')} ${fx.manifest.runnerHome}`,
    )
    // #and the chown comes before any ACL removal
    const lastChown = argv.map(l => l.includes('-exec')).lastIndexOf(true)
    const firstB = argv.findIndex(l => l.includes('-b '))
    expect(lastChown).toBeLessThan(firstB)
    // #and the private snapshot is gone
    expect(fs.existsSync(handed.data.snapshotDir)).toBe(false)
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
    fs.writeFileSync(path.join(gitDir, 'config'), '[core]\n\tfsmonitor = /tmp/payload\n[include]\n\tpath = /tmp/evil\n')
    fs.writeFileSync(path.join(gitDir, 'config.worktree'), '[core]\n\tfsmonitor = /tmp/payload2\n')
    fs.writeFileSync(path.join(gitDir, 'hooks', 'pre-commit'), '#!/bin/sh\ntouch /tmp/hook\n')
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
})
