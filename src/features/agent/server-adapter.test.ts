import type {OpenCodeServerHandle} from './server-adapter.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {pathToFileURL} from 'node:url'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {noTaskReusePluginPath, noTaskReusePluginSpec} from '../../services/setup/no-task-reuse-config.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {ok} from '../../shared/types.js'

const mocks = vi.hoisted(() => ({
  assetUrl: {current: null as URL | null},
  runtimeBootstrap: vi.fn(),
}))

vi.mock('@fro-bot/runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@fro-bot/runtime')>()
  return {...actual, bootstrapOpenCodeServer: mocks.runtimeBootstrap}
})

// Use the REAL provisioner (real fs, real registration) and redirect only the bundled-asset lookup: under
// Vitest the code runs from src/, where no `dist/no-task-reuse.js` sibling exists.
vi.mock('../../services/setup/no-task-reuse-config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/setup/no-task-reuse-config.js')>()
  return {
    ...actual,
    provisionTaskReuseGuard: async (configDir: string, logger: Parameters<typeof actual.provisionTaskReuseGuard>[1]) =>
      actual.provisionTaskReuseGuard(configDir, logger, () => mocks.assetUrl.current ?? new URL('file:///nonexistent')),
  }
})

const {bootstrapOpenCodeServer} = await import('./server-adapter.js')

const handle = {url: 'http://127.0.0.1:1', close: () => {}} as unknown as OpenCodeServerHandle

describe('bootstrapOpenCodeServer (Action server-start choke point)', () => {
  let tmpDir: string
  let xdgConfigHome: string
  let originalXdg: string | undefined

  beforeEach(async () => {
    mocks.runtimeBootstrap.mockReset()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-adapter-test-'))
    xdgConfigHome = path.join(tmpDir, 'xdg')
    originalXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = xdgConfigHome
    const assetPath = path.join(tmpDir, 'no-task-reuse.js')
    await fs.writeFile(assetPath, 'export default {}\n')
    mocks.assetUrl.current = pathToFileURL(assetPath)
  })

  afterEach(async () => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = originalXdg
    mocks.assetUrl.current = null
    await fs.rm(tmpDir, {recursive: true, force: true})
  })

  it('writes the guard file and its registration before the server starts, with no setup having run', async () => {
    // #given a runner whose OpenCode was already installed (didSetup: false): no setup, no opencode.json
    const configDir = path.join(xdgConfigHome, 'opencode')
    const seenAtStart: {file: boolean; plugins: unknown} = {file: false, plugins: null}
    mocks.runtimeBootstrap.mockImplementation(async () => {
      seenAtStart.file = await fs.access(noTaskReusePluginPath(configDir)).then(
        () => true,
        () => false,
      )
      seenAtStart.plugins = (
        JSON.parse(await fs.readFile(path.join(configDir, 'opencode.json'), 'utf8')) as {
          plugin: unknown
        }
      ).plugin
      return ok(handle)
    })

    // #when
    const result = await bootstrapOpenCodeServer(new AbortController().signal, createMockLogger(), '/workspace')

    // #then the server was started, and the guard was already on disk and registered last when it was
    expect(result.success).toBe(true)
    expect(mocks.runtimeBootstrap).toHaveBeenCalledTimes(1)
    expect(seenAtStart.file).toBe(true)
    expect(seenAtStart.plugins).toEqual([noTaskReusePluginSpec(configDir)])
  })

  it('preserves an existing operator config and moves a guard-first entry to the end', async () => {
    // #given a preinstalled runner with its own config that already lists the guard first
    const configDir = path.join(xdgConfigHome, 'opencode')
    const spec = noTaskReusePluginSpec(configDir)
    await fs.mkdir(configDir, {recursive: true})
    await fs.writeFile(
      path.join(configDir, 'opencode.json'),
      JSON.stringify({model: 'x/y', plugin: [spec, 'other@1.0.0']}),
    )
    mocks.runtimeBootstrap.mockResolvedValue(ok(handle))

    // #when
    await bootstrapOpenCodeServer(new AbortController().signal, createMockLogger(), '/workspace')

    // #then
    expect(JSON.parse(await fs.readFile(path.join(configDir, 'opencode.json'), 'utf8'))).toEqual({
      model: 'x/y',
      plugin: ['other@1.0.0', spec],
    })
  })

  it('returns an error and never starts the server when the guard cannot be provisioned', async () => {
    // #given the bundled asset is unreadable
    mocks.assetUrl.current = pathToFileURL(path.join(tmpDir, 'missing.js'))

    // #when
    const result = await bootstrapOpenCodeServer(new AbortController().signal, createMockLogger(), '/workspace')

    // #then startup is refused (fail-closed) with a message naming the guard
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.message).toMatch(/without the task-reuse guard/)
    expect(mocks.runtimeBootstrap).not.toHaveBeenCalled()
  })

  it('returns an error and never starts the server when the existing opencode.json cannot be parsed', async () => {
    // #given a config OpenCode would discard (which would silently drop the guard)
    const configDir = path.join(xdgConfigHome, 'opencode')
    await fs.mkdir(configDir, {recursive: true})
    await fs.writeFile(path.join(configDir, 'opencode.json'), '{broken')

    // #when
    const result = await bootstrapOpenCodeServer(new AbortController().signal, createMockLogger(), '/workspace')

    // #then
    expect(result.success).toBe(false)
    expect(mocks.runtimeBootstrap).not.toHaveBeenCalled()
  })
})
