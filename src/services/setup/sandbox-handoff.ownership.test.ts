/**
 * Handoff and take-back against a model of file ownership, not just the argv they send.
 *
 * `sandbox-handoff.test.ts` runs as one real uid and fakes `run`, so it can show which commands were issued but never a
 * directory changing hands: `verifyRoots` reads real `lstat` owners, and an unprivileged test cannot `chown`. Here `lstat`
 * is wrapped so every path has a modelled owner (the runner, until a fake `chown` or the "sandbox" changes it), and the fake
 * `run` applies `find -user A -exec chown B` and the checkout ACL to that model. The sequence is then the real one: hand
 * over, let the sandbox write, verify the roots as they are at take-back, take back. It still models: the kernel is not here.
 * `v2-server.sandbox.integration.test.ts` runs the same layouts against real uids on a hosted runner.
 */
import type {PrivilegedRun} from '@fro-bot/runtime'
import type {HandoffManifest} from './sandbox-handoff.js'
import {spawnSync} from 'node:child_process'
import * as fsSync from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {handOff, planLocks, takeBack} from './sandbox-handoff.js'

const RUNNER = 1001
const RUNNER_GID = 1001
const SANDBOX = 998
const SANDBOX_GID = 997

const model = vi.hoisted(() => ({owners: new Map<string, number>(), realUid: process.getuid?.() ?? 0, runner: 1001}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const lstat = (async (target: Parameters<typeof actual.lstat>[0]) => {
    const stats = await actual.lstat(target)
    // What the files really are (owned by this process's uid) stands in for the runner's; the rest of the model is explicit.
    const uid = model.owners.get(String(target)) ?? (stats.uid === model.realUid ? model.runner : stats.uid)
    const copy = Object.create(Object.getPrototypeOf(stats) as object) as typeof stats
    return Object.assign(copy, stats, {uid})
  }) as typeof actual.lstat
  return {...actual, lstat, default: {...actual, lstat}}
})

const GIT = spawnSync('which', ['git'], {encoding: 'utf8'}).stdout.trim()
const TOOLS = {
  git: GIT,
  setfacl: '/usr/bin/setfacl',
  getfacl: '/usr/bin/getfacl',
  find: '/usr/bin/find',
  chown: '/usr/bin/chown',
  chmod: '/usr/bin/chmod',
}
const BASE_ACL = 'user::rwx\ngroup::r-x\nother::r-x\n'

const ownerOf = (target: string): number => model.owners.get(target) ?? RUNNER

/** `target` and everything under it, never following a link. */
function walk(target: string): string[] {
  const stats = fsSync.lstatSync(target)
  if (!stats.isDirectory()) return [target]
  return [target, ...fsSync.readdirSync(target).flatMap(entry => walk(path.join(target, entry)))]
}

interface World {
  readonly root: string
  readonly manifest: HandoffManifest
  readonly stateHome: string
  readonly nested: string
  readonly calls: string[][]
  readonly acl: Map<string, string>
  readonly deps: Parameters<typeof handOff>[1]
  /** The sandbox writes a file (as its own uid) at `target`, creating parents. */
  readonly sandboxWrites: (target: string) => void
}

function buildWorld(extraHandedOver: (dirs: {runnerTemp: string; home: string}) => string[] = () => []): World {
  model.owners.clear()
  const root = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'sandbox-ownership-')))
  const home = path.join(root, 'home')
  const work = path.join(home, 'work')
  const workspace = path.join(work, 'agent', 'agent')
  const runnerTemp = path.join(work, '_temp')
  // connect's layout: the runner's XDG_STATE_HOME is the state home, so its `opencode` directory sits inside it.
  const stateHome = path.join(workspace, 'connect', 'state')
  const nested = path.join(stateHome, 'opencode')
  for (const dir of [
    path.join(workspace, '.git', 'hooks'),
    path.join(workspace, '.git', 'info'),
    nested,
    path.join(runnerTemp, '_runner_file_commands'),
    path.join(runnerTemp, 'fro-bot-response', '1-1'),
    path.join(home, '.local', 'share', 'opencode'),
    path.join(work, '_actions'),
  ]) {
    fsSync.mkdirSync(dir, {recursive: true})
  }
  fsSync.writeFileSync(path.join(workspace, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
  fsSync.writeFileSync(path.join(nested, 'session.db'), 'runner-created')
  for (const dir of extraHandedOver({runnerTemp, home})) fsSync.mkdirSync(dir, {recursive: true})

  const calls: string[][] = []
  const acl = new Map<string, string>()
  const run: PrivilegedRun = async argv => {
    calls.push([...argv])
    const [tool] = argv
    if (tool === TOOLS.getfacl) return {exitCode: 0, stdout: acl.get(argv.at(-1) ?? '') ?? BASE_ACL}
    if (tool === TOOLS.setfacl && argv.includes('-R')) {
      const target = argv.at(-1) ?? ''
      for (const entry of walk(target).filter(item => fsSync.lstatSync(item).isDirectory())) {
        if (argv.includes('-m')) acl.set(entry, `${BASE_ACL}user:${SANDBOX}:rwx\n`)
        else acl.delete(entry)
      }
      return {exitCode: 0, stdout: ''}
    }
    if (tool === TOOLS.find) {
      const dir = argv[2] ?? ''
      const from = Number(argv[argv.indexOf('-user') + 1])
      if (argv.includes('-print')) {
        const left = walk(dir).find(entry => ownerOf(entry) === from)
        return {exitCode: 0, stdout: left ?? ''}
      }
      if (argv.includes('-user') && argv.includes(TOOLS.chown)) {
        const to = Number((argv[argv.indexOf(TOOLS.chown) + 2] ?? '').split(':')[0])
        for (const entry of walk(dir)) if (ownerOf(entry) === from) model.owners.set(entry, to)
      }
    }
    return {exitCode: 0, stdout: ''}
  }
  const manifest: HandoffManifest = {
    ids: {runnerUid: RUNNER, runnerGid: RUNNER_GID, sandboxUid: SANDBOX, sandboxGid: SANDBOX_GID},
    runnerHome: home,
    runnerTemp,
    workspace,
    handedOver: [
      path.join(home, '.local', 'share', 'opencode'),
      path.join(runnerTemp, 'fro-bot-response', '1-1'),
      stateHome,
      nested,
      ...extraHandedOver({runnerTemp, home}),
    ],
    readable: [],
    traverseOnly: [],
    tighten: [runnerTemp, path.join(runnerTemp, '_runner_file_commands')],
  }
  return {
    root,
    manifest,
    stateHome,
    nested,
    calls,
    acl,
    deps: {run, tools: TOOLS, logger: createMockLogger()},
    sandboxWrites: target => {
      // Whatever the sandbox creates is its own; a path that already existed keeps the owner the handoff gave it.
      const created: string[] = []
      // `mkdirSync` reports the first directory it made; every directory from there down to the parent is new.
      const firstMade = fsSync.mkdirSync(path.dirname(target), {recursive: true})
      if (firstMade !== undefined) {
        for (let current = path.dirname(target); ; current = path.dirname(current)) {
          created.push(current)
          if (current === firstMade) break
        }
      }
      try {
        fsSync.writeFileSync(target, 'sandbox-wrote', {flag: 'wx'})
        created.push(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        fsSync.writeFileSync(target, 'sandbox-wrote')
      }
      for (const entry of created) model.owners.set(entry, SANDBOX)
    },
  }
}

describe('handoff and take-back over a model of ownership', () => {
  let world: World

  async function handedOff(manifest: HandoffManifest = world.manifest) {
    const handed = await handOff(manifest, world.deps)
    if (!handed.success) throw new Error(handed.error)
    return handed.data
  }

  afterEach(() => {
    fsSync.rmSync(world.root, {recursive: true, force: true})
    model.owners.clear()
  })

  describe("connect's layout: the state home and the runner opencode directory inside it are both handed over", () => {
    beforeEach(() => {
      world = buildWorld()
    })

    it('hands both over, lets the sandbox write in each, and takes everything back as restored', async () => {
      // #given the layout
      const {manifest, stateHome, nested} = world

      // #when handed over
      const handed = await handOff(manifest, world.deps)
      if (!handed.success) throw new Error(handed.error)

      // #then the sandbox owns the state home and what is inside it, the nested directory and its content included
      expect(ownerOf(stateHome)).toBe(SANDBOX)
      expect(ownerOf(nested)).toBe(SANDBOX)
      expect(ownerOf(path.join(nested, 'session.db'))).toBe(SANDBOX)

      // #when the sandbox writes a run record, a session file and a file in the checkout, and the run is taken back
      world.sandboxWrites(path.join(stateHome, 'systematic', 'connect', 'run.json'))
      world.sandboxWrites(path.join(nested, 'log', 'out.log'))
      world.sandboxWrites(path.join(manifest.workspace, 'result.txt'))
      const outcome = await takeBack(manifest, handed.data, world.deps)

      // #then it is restored, and every path the sandbox touched is the runner's again
      expect(outcome).toEqual({status: 'restored'})
      for (const entry of walk(manifest.workspace)) expect(ownerOf(entry)).toBe(RUNNER)
      expect(ownerOf(path.join(stateHome, 'systematic', 'connect', 'run.json'))).toBe(RUNNER)
      expect(ownerOf(path.join(nested, 'log', 'out.log'))).toBe(RUNNER)
    })

    it('covers the nested directory with the outer walk: it is not handed over, taken back or ACL-ed on its own', async () => {
      // #given the layout, handed over
      const {manifest, stateHome, nested} = world
      const handed = await handOff(manifest, world.deps)
      if (!handed.success) throw new Error(handed.error)

      // #when taken back
      world.calls.length = 0
      await takeBack(manifest, handed.data, world.deps)

      // #then the journal records the outer root only, and no command names the nested one as its own root
      expect(handed.data.chowned).toContain(stateHome)
      expect(handed.data.chowned).not.toContain(nested)
      expect(handed.data.aclTrees.map(tree => tree.path)).not.toContain(nested)
      expect(world.calls.some(call => call[0] === TOOLS.find && call[2] === nested)).toBe(false)
      // #and the outer walk reached it anyway: it changed hands both ways
      expect(ownerOf(nested)).toBe(RUNNER)
    })

    it('still refuses a directory the sandbox swapped between the checkout and the state home', async () => {
      // #given a handed-over layout in which `connect`, the directory above the state home, ended up the sandbox's
      const {manifest} = world
      const handed = await handOff(manifest, world.deps)
      if (!handed.success) throw new Error(handed.error)
      model.owners.set(path.dirname(world.stateHome), SANDBOX)

      // #when taken back
      const outcome = await takeBack(manifest, handed.data, world.deps)

      // #then nothing moves, and the reason names the directory
      expect(outcome.status).toBe('unsafe')
      expect(outcome.status === 'unsafe' && outcome.reason).toContain('owned by uid 998')
      expect(outcome.status === 'unsafe' && outcome.reason).toContain(path.dirname(world.stateHome))
    })

    it('still refuses a state home that was swapped for a symlink', async () => {
      // #given the state home replaced by a link out of the checkout
      const {manifest, stateHome} = world
      const handed = await handOff(manifest, world.deps)
      if (!handed.success) throw new Error(handed.error)
      const outside = path.join(world.root, 'outside')
      fsSync.mkdirSync(outside)
      fsSync.rmSync(stateHome, {recursive: true})
      fsSync.symlinkSync(outside, stateHome)

      // #when taken back
      const outcome = await takeBack(manifest, handed.data, world.deps)

      // #then
      expect(outcome.status === 'unsafe' && outcome.reason).toContain('symlink')
    })
  })

  describe('a nested root is still a root: it is verified on its own, though the outer walk moves it', () => {
    beforeEach(() => {
      world = buildWorld()
    })

    it('plans no locks of its own for the nested root: the outer root is not made a traverse-only chain directory', async () => {
      // #given the layout, planned
      const plan = await planLocks(world.manifest)

      // #then the state home, which the outer root owns, is not locked as an ancestor of the nested root
      expect(plan.traverse).not.toContain(world.stateHome)
      expect(plan.deny).not.toContain(world.stateHome)
      expect(plan.deny).not.toContain(world.nested)
    })

    it('refuses a nested root the sandbox deleted', async () => {
      // #given the runner's opencode directory, inside the state home, removed during the run
      const journal = await handedOff()
      fsSync.rmSync(world.nested, {recursive: true})

      // #when taken back
      const outcome = await takeBack(world.manifest, journal, world.deps)

      // #then the runner is not told it is restored: it would read session state from a path that is gone
      expect(outcome.status).toBe('unsafe')
      expect(outcome.status === 'unsafe' && outcome.reason).toContain(`root ${world.nested} is missing`)
    })

    it('refuses a nested root the sandbox replaced with a symlink', async () => {
      // #given the runner's opencode directory replaced by a link to somewhere the runner would then read
      const journal = await handedOff()
      const outside = path.join(world.root, 'outside')
      fsSync.mkdirSync(outside)
      fsSync.rmSync(world.nested, {recursive: true})
      fsSync.symlinkSync(outside, world.nested)

      // #when taken back
      const outcome = await takeBack(world.manifest, journal, world.deps)

      // #then
      expect(outcome.status).toBe('unsafe')
      expect(outcome.status === 'unsafe' && outcome.reason).toContain(`root ${world.nested} is a symlink`)
    })

    it('refuses a nested root the sandbox replaced with a regular file', async () => {
      // #given a file where the directory was
      const journal = await handedOff()
      fsSync.rmSync(world.nested, {recursive: true})
      fsSync.writeFileSync(world.nested, 'x')

      // #when taken back
      const outcome = await takeBack(world.manifest, journal, world.deps)

      // #then
      expect(outcome.status === 'unsafe' && outcome.reason).toContain(`root ${world.nested} is not a directory`)
    })

    describe('with a directory between the outer root and the nested one', () => {
      let manifest: HandoffManifest
      let between: string
      let deep: string

      beforeEach(() => {
        between = path.join(world.stateHome, 'sub')
        deep = path.join(between, 'deep')
        fsSync.mkdirSync(deep, {recursive: true})
        manifest = {...world.manifest, handedOver: [...world.manifest.handedOver, deep]}
      })

      it('allows the sandbox to own it, and to have made it world-writable, at take-back', async () => {
        // #given handed-over content the sandbox is free to chown-by-creation and chmod
        const journal = await handedOff(manifest)
        model.owners.set(between, SANDBOX)
        fsSync.chmodSync(between, 0o777)

        // #when taken back
        const outcome = await takeBack(manifest, journal, world.deps)

        // #then the outer take-back moves it, and the nested root is still a verified directory
        expect(outcome).toEqual({status: 'restored'})
        expect(ownerOf(between)).toBe(RUNNER)
      })

      it('refuses it when the sandbox swapped it for a symlink', async () => {
        // #given the directory above the nested root replaced by a link out of the tree
        const journal = await handedOff(manifest)
        const outside = path.join(world.root, 'outside')
        fsSync.mkdirSync(path.join(outside, 'deep'), {recursive: true})
        fsSync.rmSync(between, {recursive: true})
        fsSync.symlinkSync(outside, between)

        // #when taken back
        const outcome = await takeBack(manifest, journal, world.deps)

        // #then
        expect(outcome.status === 'unsafe' && outcome.reason).toContain(`${between} is a symlink`)
      })

      it('refuses the nested root when it is gone', async () => {
        // #given the deeper root removed
        const journal = await handedOff(manifest)
        fsSync.rmSync(deep, {recursive: true})

        // #when taken back
        const outcome = await takeBack(manifest, journal, world.deps)

        // #then
        expect(outcome.status === 'unsafe' && outcome.reason).toContain(`root ${deep} is missing`)
      })
    })
  })

  describe('roots outside the checkout keep the ancestor check', () => {
    beforeEach(() => {
      world = buildWorld()
    })

    it('still refuses a world-writable ancestor that no handed-over root contains', async () => {
      // #given the temp directory above the response root made world-writable
      const handed = await handOff(world.manifest, world.deps)
      if (!handed.success) throw new Error(handed.error)
      const parent = path.join(world.manifest.runnerTemp, 'fro-bot-response')
      fsSync.chmodSync(parent, 0o777)

      // #when taken back
      const outcome = await takeBack(world.manifest, handed.data, world.deps)

      // #then
      expect(outcome.status === 'unsafe' && outcome.reason).toContain(`ancestor ${parent} is world-writable`)
    })

    it('refuses a sandbox-owned ancestor of a handed-over root', async () => {
      // #given the response directory's parent ended up the sandbox's
      const {manifest} = world
      const handed = await handOff(manifest, world.deps)
      if (!handed.success) throw new Error(handed.error)
      const parent = path.join(manifest.runnerTemp, 'fro-bot-response')
      model.owners.set(parent, SANDBOX)

      // #when taken back
      const outcome = await takeBack(manifest, handed.data, world.deps)

      // #then it is refused, naming the ancestor
      expect(outcome.status).toBe('unsafe')
      expect(outcome.status === 'unsafe' && outcome.reason).toContain(`ancestor ${parent} is owned by uid ${SANDBOX}`)
    })

    it('refuses a sandbox-owned ancestor of a root that sits inside another handed-over root outside the checkout', async () => {
      // #given a root nested in another handed-over root, both under the temp tree, and the outer one's parent swapped
      const sub = path.join(world.manifest.runnerTemp, 'fro-bot-response', '1-1', 'sub')
      fsSync.mkdirSync(sub)
      const manifest = {...world.manifest, handedOver: [...world.manifest.handedOver, sub]}
      const handed = await handOff(manifest, world.deps)
      if (!handed.success) throw new Error(handed.error)
      const parent = path.join(manifest.runnerTemp, 'fro-bot-response')
      model.owners.set(parent, SANDBOX)

      // #when taken back
      const outcome = await takeBack(manifest, handed.data, world.deps)

      // #then the outer root's ancestors are still held to runner or root
      expect(outcome.status === 'unsafe' && outcome.reason).toContain(`ancestor ${parent} is owned by uid ${SANDBOX}`)
    })

    it('restores a root nested in another handed-over root outside the checkout', async () => {
      // #given the same nesting, with nothing swapped
      const sub = path.join(world.manifest.runnerTemp, 'fro-bot-response', '1-1', 'sub')
      fsSync.mkdirSync(sub)
      const manifest = {...world.manifest, handedOver: [...world.manifest.handedOver, sub]}
      const handed = await handOff(manifest, world.deps)
      if (!handed.success) throw new Error(handed.error)
      expect(ownerOf(sub)).toBe(SANDBOX)

      // #when taken back
      const outcome = await takeBack(manifest, handed.data, world.deps)

      // #then
      expect(outcome).toEqual({status: 'restored'})
      expect(ownerOf(sub)).toBe(RUNNER)
    })
  })
})
