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

// Record every file read so a test can prove user config files are never opened.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {...actual, readFile: vi.fn(actual.readFile)}
})

// Use the REAL writer (real fs) and redirect only the bundled-asset lookup: under Vitest the code runs from
// src/, where no `dist/no-task-reuse.js` sibling exists.
vi.mock('../../services/setup/no-task-reuse-config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/setup/no-task-reuse-config.js')>()
  return {
    ...actual,
    writeNoTaskReuseFile: async (configDir: string, logger: Parameters<typeof actual.writeNoTaskReuseFile>[1]) =>
      actual.writeNoTaskReuseFile(configDir, logger, () => mocks.assetUrl.current ?? new URL('file:///nonexistent')),
  }
})

const {bootstrapOpenCodeServer} = await import('./server-adapter.js')

const handle = {url: 'http://127.0.0.1:1', close: () => {}} as unknown as OpenCodeServerHandle

describe('bootstrapOpenCodeServer (Action server-start choke point)', () => {
  let tmpDir: string
  let configDir: string
  let originalXdg: string | undefined

  beforeEach(async () => {
    mocks.runtimeBootstrap.mockReset()
    vi.mocked(fs.readFile).mockClear()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-adapter-test-'))
    configDir = path.join(tmpDir, 'xdg', 'opencode')
    originalXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'xdg')
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

  it('writes the guard file, then starts the server with exactly the guard plugin as its config', async () => {
    // #given a runner whose OpenCode was already installed (didSetup: false): setup never ran, no guard file exists
    let fileExistedAtStart: boolean | null = null
    mocks.runtimeBootstrap.mockImplementation(async () => {
      fileExistedAtStart = await fs.access(noTaskReusePluginPath(configDir)).then(
        () => true,
        () => false,
      )
      return ok(handle)
    })
    const signal = new AbortController().signal
    const logger = createMockLogger()

    // #when
    const result = await bootstrapOpenCodeServer(signal, logger, '/workspace', 1234, 5678)

    // #then the file was already on disk when the server started, and the runtime got the other arguments
    // untouched plus a config naming only the guard
    expect(result.success).toBe(true)
    expect(fileExistedAtStart).toBe(true)
    expect(mocks.runtimeBootstrap).toHaveBeenCalledTimes(1)
    expect(mocks.runtimeBootstrap).toHaveBeenCalledWith(signal, logger, '/workspace', 1234, 5678, {
      config: {plugin: [noTaskReusePluginSpec(configDir)]},
    })
  })

  it('never opens or modifies a user config file, so one OpenCode accepts but JSON.parse rejects cannot block startup', async () => {
    // #given global config files with comments and trailing commas (valid JSONC), one clearing the plugin list
    await fs.mkdir(configDir, {recursive: true})
    const jsonc = '{\n  // operator note\n  "plugin": [],\n}\n'
    const json = '{"model": "x/y", /* kept */ "plugin": ["other@1.0.0",],}'
    await fs.writeFile(path.join(configDir, 'opencode.jsonc'), jsonc)
    await fs.writeFile(path.join(configDir, 'opencode.json'), json)
    mocks.runtimeBootstrap.mockResolvedValue(ok(handle))

    // #when
    const result = await bootstrapOpenCodeServer(new AbortController().signal, createMockLogger(), '/workspace')

    // #then startup succeeded, neither file was read, and both are byte-for-byte unchanged
    expect(result.success).toBe(true)
    const readPaths = vi.mocked(fs.readFile).mock.calls.map(([target]) => String(target))
    expect(readPaths.some(target => target.includes('opencode.json'))).toBe(false)
    expect(await fs.readFile(path.join(configDir, 'opencode.jsonc'), 'utf8')).toBe(jsonc)
    expect(await fs.readFile(path.join(configDir, 'opencode.json'), 'utf8')).toBe(json)
  })

  it('returns an error and never starts the server when the guard file cannot be written', async () => {
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
})
