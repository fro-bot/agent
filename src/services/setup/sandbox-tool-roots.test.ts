import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {resolveToolRoots, SANDBOX_TOOL_ROOTS, toolCacheEnv, type ToolRootInput} from './sandbox-tool-roots.js'

const RUNNER_UID = process.getuid?.() ?? 0

describe('resolveToolRoots', () => {
  let base: string
  let home: string
  let input: ToolRootInput

  const bunRoot = (): string => path.join(home, '.bun')
  const pnpmRoot = (): string => path.join(home, 'setup-pnpm')

  /** A PATH as the runner has it after `setup-bun` and `pnpm/action-setup`, as the agent's mirrored PATH would hold it. */
  const agentPath = (...entries: string[]): string => [...entries, '/usr/local/bin', '/usr/bin', '/bin'].join(':')

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-roots-')))
    home = path.join(base, 'home', 'runner')
    fs.mkdirSync(path.join(home, 'work', '_temp'), {recursive: true})
    fs.mkdirSync(path.join(home, 'work', '_actions'), {recursive: true})
    fs.mkdirSync(path.join(home, 'work', 'repo', 'repo'), {recursive: true})
    fs.mkdirSync(path.join(bunRoot(), 'bin'), {recursive: true})
    fs.writeFileSync(path.join(bunRoot(), 'bin', 'bun'), 'bun')
    fs.symlinkSync('bun', path.join(bunRoot(), 'bin', 'bunx'))
    fs.mkdirSync(path.join(pnpmRoot(), 'node_modules', '.bin', 'bin'), {recursive: true})
    input = {
      runnerHome: home,
      runnerUid: RUNNER_UID,
      agentPath: agentPath(path.join(pnpmRoot(), 'node_modules', '.bin'), path.join(bunRoot(), 'bin')),
      runnerTemp: path.join(home, 'work', '_temp'),
      actionsDir: path.join(home, 'work', '_actions'),
      workspace: path.join(home, 'work', 'repo', 'repo'),
      writableRoots: [path.join(home, '.local', 'share', 'opencode')],
    }
  })
  afterEach(() => {
    fs.rmSync(base, {recursive: true, force: true})
  })

  it('names the supported tools and their install roots, relative to the runner home', () => {
    // #then the list is short and fixed
    expect(SANDBOX_TOOL_ROOTS).toEqual([
      {tool: 'bun', directory: '.bun'},
      {tool: 'pnpm', directory: 'setup-pnpm'},
    ])
  })

  it('grants the bun root when a directory on the agent PATH lies inside it', async () => {
    // #given bun's bin directory on the PATH and nothing for pnpm
    const result = await resolveToolRoots({...input, agentPath: agentPath(path.join(bunRoot(), 'bin'))})

    // #then only the bun root is granted, at its real path, and pnpm is skipped with its reason
    expect(result.granted).toEqual([bunRoot()])
    expect(result.skipped).toEqual([{tool: 'pnpm', root: pnpmRoot(), reason: 'no PATH entry lies inside it'}])
  })

  it('grants the pnpm root, whose PATH entries are directories deep inside it', async () => {
    // #given the two entries pnpm/action-setup adds
    const result = await resolveToolRoots({
      ...input,
      agentPath: agentPath(
        path.join(pnpmRoot(), 'node_modules', '.bin', 'bin'),
        path.join(pnpmRoot(), 'node_modules', '.bin'),
      ),
    })

    // #then
    expect(result.granted).toEqual([pnpmRoot()])
  })

  it('grants both, in the fixed order, whatever order the PATH names them', async () => {
    // #given the measured PATH order (pnpm entries first, bun last)
    const result = await resolveToolRoots(input)

    // #then
    expect(result.granted).toEqual([bunRoot(), pnpmRoot()])
    expect(result.skipped).toEqual([])
  })

  it('grants nothing for a root that does not exist, and says why', async () => {
    // #given no bun install
    fs.rmSync(bunRoot(), {recursive: true, force: true})

    // #when resolved
    const result = await resolveToolRoots(input)

    // #then
    expect(result.granted).toEqual([pnpmRoot()])
    expect(result.skipped).toEqual([{tool: 'bun', root: bunRoot(), reason: 'does not exist'}])
  })

  it('grants nothing when no PATH entry lies inside the root, even if the root exists', async () => {
    // #given a bun root that no PATH entry points into (a sibling that shares the name prefix is not inside it)
    fs.mkdirSync(path.join(home, '.bun-other', 'bin'), {recursive: true})
    const result = await resolveToolRoots({...input, agentPath: agentPath(path.join(home, '.bun-other', 'bin'))})

    // #then
    expect(result.granted).toEqual([])
    expect(result.skipped.map(entry => entry.reason)).toEqual([
      'no PATH entry lies inside it',
      'no PATH entry lies inside it',
    ])
  })

  it('refuses a root that is a symlink, so a link cannot redirect a grant', async () => {
    // #given .bun replaced by a link to a directory elsewhere that does hold a PATH entry
    const elsewhere = path.join(base, 'elsewhere')
    fs.mkdirSync(path.join(elsewhere, 'bin'), {recursive: true})
    fs.rmSync(bunRoot(), {recursive: true, force: true})
    fs.symlinkSync(elsewhere, bunRoot())

    // #when resolved
    const result = await resolveToolRoots(input)

    // #then
    expect(result.granted).toEqual([pnpmRoot()])
    expect(result.skipped).toEqual([{tool: 'bun', root: bunRoot(), reason: 'is a symlink'}])
  })

  it('refuses a root that is not a directory', async () => {
    // #given a file where the root should be
    fs.rmSync(pnpmRoot(), {recursive: true, force: true})
    fs.writeFileSync(pnpmRoot(), 'x')

    // #then
    const result = await resolveToolRoots(input)
    expect(result.skipped).toEqual([{tool: 'pnpm', root: pnpmRoot(), reason: 'is not a directory'}])
  })

  it('refuses a root the runner does not own', async () => {
    // #given the runner uid is not the owner of what is on disk
    const result = await resolveToolRoots({...input, runnerUid: RUNNER_UID + 1})

    // #then neither root is granted
    expect(result.granted).toEqual([])
    expect(result.skipped.map(entry => entry.reason)).toEqual([
      'is not owned by the runner',
      'is not owned by the runner',
    ])
  })

  it('refuses a root whose real path is elsewhere, such as one reached through a symlinked ancestor', async () => {
    // #given the runner home reached through a link
    const linkedHome = path.join(base, 'linked-home')
    fs.symlinkSync(home, linkedHome)
    const result = await resolveToolRoots({
      ...input,
      runnerHome: linkedHome,
      agentPath: agentPath(path.join(linkedHome, '.bun', 'bin')),
    })

    // #then the grant is refused: it is made at the real path or not at all
    expect(result.granted).toEqual([])
    expect(result.skipped[0]).toMatchObject({tool: 'bun', reason: 'is reached through a symlink'})
  })

  describe('never grants a root that overlaps what must stay apart', () => {
    it.each([
      ['RUNNER_TEMP', (root: string) => ({runnerTemp: path.join(root, 'tmp')}), 'RUNNER_TEMP'],
      ['RUNNER_TEMP itself', (root: string) => ({runnerTemp: root}), 'RUNNER_TEMP'],
      ['the actions directory', (root: string) => ({actionsDir: path.join(root, '_actions')}), 'the actions directory'],
      ['the checkout', (root: string) => ({workspace: path.join(root, 'checkout')}), 'the checkout'],
      ['a writable root', (root: string) => ({writableRoots: [path.join(root, 'data')]}), 'a writable root'],
    ])('a root that contains %s', async (_label, override, name) => {
      // #given the bun root made to contain the thing
      const result = await resolveToolRoots({...input, ...override(bunRoot())})

      // #then bun is refused, naming the overlap, and pnpm is unaffected
      expect(result.granted).toEqual([pnpmRoot()])
      expect(result.skipped).toEqual([{tool: 'bun', root: bunRoot(), reason: `overlaps ${name}`}])
    })

    it('a root inside the checkout or a writable root', async () => {
      // #given the checkout and a writable root that contain the roots
      const inside = await resolveToolRoots({...input, workspace: home})
      const writable = await resolveToolRoots({...input, writableRoots: [home]})

      // #then nothing is granted either way
      expect(inside.granted).toEqual([])
      expect(writable.granted).toEqual([])
    })
  })

  it('still grants a root that holds a symlink pointing outside it: the grant never follows links', async () => {
    // #given a link from inside the pnpm root to a runner-private directory
    fs.mkdirSync(path.join(home, '.ssh'), {recursive: true})
    fs.symlinkSync(path.join(home, '.ssh'), path.join(pnpmRoot(), 'to-ssh'))

    // #when resolved
    const result = await resolveToolRoots(input)

    // #then the root is still granted: the link is a name, and what the agent can do through it is decided by the
    // target's own mode and ACL (the home's other entries stay denied), not by this grant
    expect(result.granted).toEqual([bunRoot(), pnpmRoot()])
  })
})

describe('toolCacheEnv', () => {
  const runnerHome = '/home/runner'
  const agentHome = '/home/fro-bot-sandbox'
  const bun = `${runnerHome}/.bun`
  const pnpm = `${runnerHome}/setup-pnpm`
  const ALWAYS = {
    UV_CACHE_DIR: `${agentHome}/.cache/uv`,
    UV_PYTHON_INSTALL_DIR: `${agentHome}/.local/share/uv/python`,
    UV_TOOL_DIR: `${agentHome}/.local/share/uv/tools`,
    PIP_CACHE_DIR: `${agentHome}/.cache/pip`,
  }

  it('always points uv’s and pip’s caches, managed Pythons and tools at the agent’s own home', () => {
    // #given no root granted (uv and pip run from the tool cache, not the runner home)
    const env = toolCacheEnv([], runnerHome, agentHome)

    // #then uv and pip get their locations, all under the agent's home
    expect(env).toEqual(ALWAYS)
    for (const value of Object.values(env)) expect(value.startsWith(`${agentHome}/`)).toBe(true)
  })

  it('points pnpm’s store, cache and state at the agent’s own home when the pnpm root is granted', () => {
    // #given only pnpm granted
    const env = toolCacheEnv([pnpm], runnerHome, agentHome)

    // #then pnpm gets its three locations under the agent's home, and bun nothing
    expect(env).toEqual({
      ...ALWAYS,
      npm_config_store_dir: `${agentHome}/.pnpm-store`,
      npm_config_cache_dir: `${agentHome}/.cache/pnpm`,
      npm_config_state_dir: `${agentHome}/.local/state/pnpm`,
    })
  })

  it('points bun’s install cache at the agent’s own home when the bun root is granted', () => {
    // #given only bun granted
    // #then
    expect(toolCacheEnv([bun], runnerHome, agentHome)).toEqual({
      ...ALWAYS,
      BUN_INSTALL_CACHE_DIR: `${agentHome}/.bun/install/cache`,
    })
  })

  it('sets both for both, and no npm or bun names when no root is granted (so npm sees no unknown config)', () => {
    // #given
    // #then
    expect(Object.keys(toolCacheEnv([bun, pnpm], runnerHome, agentHome)).toSorted()).toEqual(
      [
        ...Object.keys(ALWAYS),
        'BUN_INSTALL_CACHE_DIR',
        'npm_config_cache_dir',
        'npm_config_state_dir',
        'npm_config_store_dir',
      ].toSorted(),
    )
    expect(toolCacheEnv([], runnerHome, agentHome)).toEqual(ALWAYS)
  })

  it('ignores a granted path that is not one of the supported roots', () => {
    // #given a path that merely looks similar
    // #then
    expect(toolCacheEnv([`${runnerHome}/.bun-other`, '/opt/pnpm'], runnerHome, agentHome)).toEqual(ALWAYS)
  })
})
