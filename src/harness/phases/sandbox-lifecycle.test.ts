import type {SandboxToolPaths} from '../../services/setup/sandbox-preflight.js'
import type {ExecAdapter, ExecOptions} from '../../services/setup/types.js'
import type {SandboxLifecycleDeps, SignalHost} from './sandbox-lifecycle.js'
import {Buffer} from 'node:buffer'
import {EventEmitter} from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {err, ok} from '@bfra.me/es/result'
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {createPrivilegedRun, createSandboxLifecycle, DEFAULT_PRIVILEGED_TIMEOUT_MS} from './sandbox-lifecycle.js'

const TOOLS = Object.fromEntries(
  [
    'sudo',
    'setpriv',
    'setfacl',
    'getfacl',
    'useradd',
    'userdel',
    'pkill',
    'pgrep',
    'find',
    'chown',
    'chmod',
    'mkdir',
    'env',
    'git',
  ].map(name => [name, `/usr/bin/${name}`]),
) as unknown as SandboxToolPaths

const ACCOUNT = {name: 'fro-bot-sandbox', uid: 998, gid: 997, home: '/home/fro-bot-sandbox'}

interface Harness {
  readonly deps: SandboxLifecycleDeps
  readonly mocks: {
    readonly createAccount: Mock<SandboxLifecycleDeps['createAccount']>
    readonly stop: Mock<SandboxLifecycleDeps['stop']>
    readonly deleteAccount: Mock<SandboxLifecycleDeps['deleteAccount']>
    readonly handOff: Mock<SandboxLifecycleDeps['handOff']>
    readonly takeBack: Mock<SandboxLifecycleDeps['takeBack']>
  }
  readonly exec: ExecAdapter
  readonly sudoCalls: string[][]
}

function createHarness(): Harness {
  const mocks = {
    createAccount: vi.fn(async () => ok(ACCOUNT)),
    stop: vi.fn(async () => 'stopped' as const),
    deleteAccount: vi.fn(async () => 'deleted' as const),
    handOff: vi.fn(async () =>
      ok({snapshotDir: '/x', touched: [], chowned: [], aclTrees: [], git: null, gitPresent: false}),
    ),
    takeBack: vi.fn(async () => ({status: 'restored' as const})),
  }
  const sudoCalls: string[][] = []
  const exec: ExecAdapter = {
    exec: vi.fn(async () => 0),
    getExecOutput: vi.fn(async (command: string, args: string[] = []) => {
      sudoCalls.push([command, ...args])
      const isGitGlobal = args[0] === 'config' && args[1] === '--global'
      return {exitCode: 0, stdout: isGitGlobal ? `${args[3]}-value\n` : '', stderr: ''}
    }),
  }
  const deps = {
    ...mocks,
    readText: async () => null,
    ids: () => ({uid: 1001, gid: 1001}),
  } as unknown as SandboxLifecycleDeps
  return {deps, mocks, exec, sudoCalls}
}

function fakeHost(): SignalHost & {readonly emitter: EventEmitter; readonly killed: string[]} {
  const emitter = new EventEmitter()
  const killed: string[] = []
  return {
    pid: 4242,
    emitter,
    killed,
    on: (signal, listener) => emitter.on(signal, listener),
    off: (signal, listener) => emitter.off(signal, listener),
    kill: (pid, signal) => {
      killed.push(`${pid}:${signal}`)
    },
  }
}

describe('createSandboxLifecycle', () => {
  let temp: string

  beforeEach(() => {
    temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lifecycle-')))
  })
  afterEach(() => {
    fs.rmSync(temp, {recursive: true, force: true})
  })

  function create(harness: Harness, overrides: Partial<Parameters<typeof createSandboxLifecycle>[0]> = {}) {
    return createSandboxLifecycle({
      tools: TOOLS,
      env: {HOME: '/home/runner', RUNNER_TEMP: temp, XDG_DATA_HOME: '/custom/data'},
      runnerHome: '/home/runner',
      workspacePath: '/home/runner/work/r/r',
      responseDir: `${temp}/fro-bot-response/1-1`,
      attachmentDir: null,
      logger: createMockLogger(),
      exec: harness.exec,
      deps: harness.deps,
      ...overrides,
    })
  }

  it('builds the manifest from the runner-resolved paths and returns the launch spec', async () => {
    // #given a runner with a custom XDG data home
    const harness = createHarness()
    const lifecycle = create(harness)

    // #when prepared with a key file and the provisioned gh config
    const prepared = await lifecycle.prepare({
      keyFilePaths: [`${temp}/fro-bot-credentials-x/openai.key`],
      ghConfigDir: `${temp}/gh-config-abc`,
      repoSkills: null,
    })

    // #then the launch uses the runner-resolved XDG paths, and the manifest hands over the four opencode dirs plus the run dirs
    expect(prepared.success).toBe(true)
    if (!prepared.success) throw new Error('unreachable')
    expect(prepared.data.xdg).toEqual({
      data: '/custom/data',
      config: '/home/runner/.config',
      cache: '/home/runner/.cache',
      state: '/home/runner/.local/state',
    })
    expect(prepared.data.account).toEqual(ACCOUNT)
    expect(prepared.data.extraEnv).toEqual({GH_CONFIG_DIR: `${temp}/gh-config-abc`})
    expect(prepared.data.tmpdir).toBe('/home/fro-bot-sandbox/tmp')
    const manifest = harness.mocks.handOff.mock.calls[0]?.[0] as unknown as {
      handedOver: string[]
      tighten: string[]
      workspace: string
    }
    expect(manifest.handedOver).toEqual(
      expect.arrayContaining([
        '/custom/data/opencode',
        '/home/runner/.config/opencode',
        '/home/runner/.cache/opencode',
        '/home/runner/.local/state/opencode',
        `${temp}/fro-bot-credentials-x`,
        `${temp}/fro-bot-response/1-1`,
        `${temp}/gh-config-abc`,
      ]),
    )
    expect(manifest.tighten).toContain(temp)
    expect(manifest.workspace).toBe('/home/runner/work/r/r')
  })

  it('writes the sandbox gitconfig as the sandbox, with the runner identity and safe.directory', async () => {
    // #given a prepared lifecycle
    const harness = createHarness()
    const lifecycle = create(harness)

    // #when
    await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})

    // #then every write goes through setpriv as the sandbox uid with the exact drop, and covers the three keys
    const gitWrites = harness.sudoCalls.filter(call => call.includes('--file'))
    expect(gitWrites).toHaveLength(3)
    for (const call of gitWrites) {
      expect(call.slice(0, 5)).toEqual(['/usr/bin/sudo', '-n', '--', '/usr/bin/setpriv', '--reuid=998'])
      expect(call).toContain('/home/fro-bot-sandbox/.gitconfig')
    }
    expect(gitWrites.map(call => call.at(-2))).toEqual(['safe.directory', 'user.name', 'user.email'])
    expect(
      harness.sudoCalls.some(call => call.includes('/usr/bin/mkdir') && call.includes('/home/fro-bot-sandbox/tmp')),
    ).toBe(true)
  })

  it('refuses when the account already exists, without handing anything over', async () => {
    // #given an existing account
    const harness = createHarness()
    harness.mocks.createAccount.mockResolvedValue(
      err({kind: 'exists', message: 'already exists; refusing to adopt it'}),
    )
    const lifecycle = create(harness)

    // #when
    const prepared = await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})

    // #then no handoff, no kill, no delete: nothing of ours exists to undo
    expect(!prepared.success && prepared.error).toContain('refusing to adopt')
    expect(harness.mocks.handOff).not.toHaveBeenCalled()
    expect(harness.mocks.stop).not.toHaveBeenCalled()
    expect(harness.mocks.deleteAccount).not.toHaveBeenCalled()
    expect(await lifecycle.release()).toEqual({stop: 'never-started', restore: 'not-needed'})
  })

  it('stops and deletes the account when handoff fails, before launch', async () => {
    // #given a handoff failure
    const harness = createHarness()
    harness.mocks.handOff.mockResolvedValue(err('Sandbox handoff failed: checkout ACL failed'))
    const lifecycle = create(harness)

    // #when
    const prepared = await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})

    // #then the run fails and no account survives (the failed handoff already rolled itself back)
    expect(!prepared.success && prepared.error).toContain('checkout ACL failed')
    expect(harness.mocks.stop).toHaveBeenCalledTimes(1)
    expect(harness.mocks.takeBack).not.toHaveBeenCalled()
    expect(harness.mocks.deleteAccount).toHaveBeenCalledTimes(1)
  })

  it('stops, takes back and deletes in that order, once, however often release is called', async () => {
    // #given a prepared lifecycle
    const harness = createHarness()
    const order: string[] = []
    harness.mocks.stop.mockImplementation(async () => {
      order.push('stop')
      return 'stopped' as const
    })
    harness.mocks.takeBack.mockImplementation(async () => {
      order.push('takeBack')
      return {status: 'restored' as const}
    })
    harness.mocks.deleteAccount.mockImplementation(async () => {
      order.push('delete')
      return 'deleted' as const
    })
    const lifecycle = create(harness)
    await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})

    // #when released twice, concurrently
    const [first, second] = await Promise.all([lifecycle.release(), lifecycle.release()])

    // #then one sequence ran and both callers see the same restored outcome
    expect(order).toEqual(['stop', 'takeBack', 'delete'])
    expect(first).toEqual({stop: 'stopped', restore: 'restored'})
    expect(second).toBe(first)
    expect(lifecycle.isActive()).toBe(false)
  })

  it('does not take back or delete when the stop cannot be confirmed', async () => {
    // #given processes that survive the kill bound
    const harness = createHarness()
    harness.mocks.stop.mockResolvedValue('unconfirmed')
    const lifecycle = create(harness)
    await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})

    // #when released
    const outcome = await lifecycle.release()

    // #then nothing that reads or moves sandbox output ran
    expect(outcome.stop).toBe('unconfirmed')
    expect(outcome.restore).toBe('unsafe')
    expect(harness.mocks.takeBack).not.toHaveBeenCalled()
    expect(harness.mocks.deleteAccount).not.toHaveBeenCalled()
  })

  it('still deletes the account after a confirmed stop when take-back is unsafe', async () => {
    // #given an unsafe take-back
    const harness = createHarness()
    harness.mocks.takeBack.mockResolvedValue({status: 'unsafe', reason: 'ancestor /x is a symlink'})
    const lifecycle = create(harness)
    await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})

    // #when released
    const outcome = await lifecycle.release()

    // #then the reason is surfaced, and since nothing runs as the uid any more the account is deleted anyway
    expect(outcome).toEqual({stop: 'stopped', restore: 'unsafe', reason: 'ancestor /x is a symlink'})
    expect(harness.mocks.deleteAccount).toHaveBeenCalledTimes(1)
  })

  it('keeps the account, and takes nothing back, when the stop is not confirmed', async () => {
    // #given processes that survive the kill bound
    const harness = createHarness()
    harness.mocks.stop.mockResolvedValue('unconfirmed')
    const lifecycle = create(harness)
    await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})

    // #when released
    const outcome = await lifecycle.release()

    // #then the sandbox might still be writing: no take-back, no delete
    expect(outcome.stop).toBe('unconfirmed')
    expect(outcome.restore).toBe('unsafe')
    expect(harness.mocks.takeBack).not.toHaveBeenCalled()
    expect(harness.mocks.deleteAccount).not.toHaveBeenCalled()
  })

  describe('termination signals', () => {
    it('installs handlers before the account exists and removes them after a normal release', async () => {
      // #given a lifecycle whose account creation observes the handlers
      const harness = createHarness()
      const host = fakeHost()
      let listenersWhenCreating = -1
      harness.mocks.createAccount.mockImplementation(async () => {
        listenersWhenCreating = host.emitter.listenerCount('SIGTERM') + host.emitter.listenerCount('SIGINT')
        return ok(ACCOUNT)
      })
      const lifecycle = create(harness, {signals: host})

      // #when prepared and released normally
      await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})
      expect(host.emitter.listenerCount('SIGTERM')).toBe(1)
      await lifecycle.release()

      // #then they were in place first and are gone after
      expect(listenersWhenCreating).toBe(2)
      expect(host.emitter.listenerCount('SIGTERM')).toBe(0)
      expect(host.emitter.listenerCount('SIGINT')).toBe(0)
      expect(host.killed).toEqual([])
    })

    it('stops the sandbox and takes its files back on a signal, then re-raises it once; a second signal is ignored', async () => {
      // #given a prepared sandbox
      const harness = createHarness()
      const host = fakeHost()
      const lifecycle = create(harness, {signals: host})
      await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})

      // #when SIGTERM arrives twice (the exec adapter re-raises it)
      host.emitter.emit('SIGTERM')
      host.emitter.emit('SIGTERM')
      await vi.waitFor(() => {
        expect(host.killed).toEqual(['4242:SIGTERM'])
      })

      // #then teardown ran once, in order, and only afterwards was the signal re-raised with the handlers gone
      expect(harness.mocks.stop).toHaveBeenCalledTimes(1)
      expect(harness.mocks.takeBack).toHaveBeenCalledTimes(1)
      expect(harness.mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
        harness.mocks.takeBack.mock.invocationCallOrder[0] ?? 0,
      )
      expect(host.emitter.listenerCount('SIGTERM')).toBe(0)
      expect(host.emitter.listenerCount('SIGINT')).toBe(0)
    })

    it('ends the process anyway when the teardown does not finish within its budget', async () => {
      // #given a stop that never returns
      const harness = createHarness()
      harness.mocks.stop.mockImplementation(async () => new Promise<never>(() => undefined))
      const host = fakeHost()
      const lifecycle = create(harness, {signals: host, signalTeardownBudgetMs: 20})
      await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})

      // #when SIGINT arrives
      host.emitter.emit('SIGINT')

      // #then the signal is still re-raised, bounded by the budget
      await vi.waitFor(() => {
        expect(host.killed).toEqual(['4242:SIGINT'])
      })
      expect(harness.mocks.takeBack).not.toHaveBeenCalled()
    })
  })

  it('reports an exception during release as unsafe instead of throwing', async () => {
    // #given a stop that throws
    const harness = createHarness()
    harness.mocks.stop.mockRejectedValue(new Error('sudo vanished'))
    const lifecycle = create(harness)
    await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})

    // #when released
    const outcome = await lifecycle.release()

    // #then
    expect(outcome.restore).toBe('unsafe')
    expect(outcome.reason).toContain('sudo vanished')
  })
})

describe('createPrivilegedRun', () => {
  it('runs absolute argv through sudo -n from a neutral directory', async () => {
    // #given an exec adapter
    const getExecOutput = vi.fn(async () => ({exitCode: 3, stdout: 'out', stderr: ''}))
    const run = createPrivilegedRun({exec: vi.fn(), getExecOutput}, '/usr/bin/sudo')

    // #when
    const result = await run(['/usr/bin/pkill', '-KILL', '-u', '998'])

    // #then the command carries no shell and cwd is '/'
    expect(getExecOutput).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      ['-n', '--', '/usr/bin/pkill', '-KILL', '-u', '998'],
      expect.objectContaining({cwd: '/', ignoreReturnCode: true}),
    )
    expect(result).toEqual({exitCode: 3, stdout: 'out'})
  })

  it('bounds every command, defaulting the timeout, and reports a killed command as a null exit', async () => {
    // #given an adapter whose timeout path fires
    const execWithTimeout = vi.fn(
      async (_command: string, _args: string[] | undefined, _timeout: number, _options?: ExecOptions) =>
        'timed-out' as const,
    )
    const getExecOutput = vi.fn()
    const run = createPrivilegedRun({exec: vi.fn(), execWithTimeout, getExecOutput}, '/usr/bin/sudo')

    // #when run with no timeout and with an explicit one
    const defaulted = await run(['/usr/bin/find', '/x'])
    await run(['/usr/bin/find', '/x'], {timeoutMs: 1234})

    // #then both went through the killing path, with the default and the caller's bound, and report no exit code
    expect(defaulted).toEqual({exitCode: null, stdout: ''})
    expect(getExecOutput).not.toHaveBeenCalled()
    expect(execWithTimeout.mock.calls.map(call => call[2])).toEqual([DEFAULT_PRIVILEGED_TIMEOUT_MS, 1234])
    expect(execWithTimeout).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      ['-n', '--', '/usr/bin/find', '/x'],
      expect.any(Number),
      expect.objectContaining({cwd: '/'}),
    )
  })

  it('returns the exit code and the collected stdout when the command finishes in time', async () => {
    // #given a command that prints and exits 1
    const execWithTimeout = vi.fn(
      async (_command: string, _args: string[] | undefined, _timeout: number, options?: ExecOptions) => {
        options?.listeners?.stdout?.(Buffer.from('hel'))
        options?.listeners?.stdout?.(Buffer.from('lo'))
        return 1
      },
    )
    const run = createPrivilegedRun({exec: vi.fn(), execWithTimeout, getExecOutput: vi.fn()}, '/usr/bin/sudo')

    // #when
    const result = await run(['/usr/bin/pgrep', '-u', '998'])

    // #then
    expect(result).toEqual({exitCode: 1, stdout: 'hello'})
  })
})
