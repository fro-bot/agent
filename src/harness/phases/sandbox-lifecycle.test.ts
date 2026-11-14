import type {SandboxToolPaths} from '../../services/setup/sandbox-preflight.js'
import type {ExecAdapter, ExecOptions} from '../../services/setup/types.js'
import type {SandboxLifecycleDeps, SignalHost} from './sandbox-lifecycle.js'
import {Buffer} from 'node:buffer'
import {EventEmitter} from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {err, ok} from '@bfra.me/es/result'
import {createSandboxAccount} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest'
import {isSignalOwned} from '../../services/setup/adapters.js'
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

function deferred<T>(): {readonly promise: Promise<T>; readonly resolve: (value: T) => void} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => {
    resolve = settle
  })
  return {promise, resolve}
}

/** An exec adapter whose commands whose argv contains `hangOn` never exit: they are killed on their budget. */
function hangingExec(hangOn: string, seen: string[]): ExecAdapter {
  return {
    exec: vi.fn(async () => 0),
    getExecOutput: vi.fn(async () => ({exitCode: 0, stdout: '', stderr: ''})),
    execWithTimeout: vi.fn(async (_command: string, args: string[] | undefined) => {
      seen.push((args ?? []).join(' '))
      return (args ?? []).some(arg => arg.endsWith(hangOn)) ? ('timed-out' as const) : 0
    }),
  }
}

function lateStart() {
  const ready = deferred<void>()
  const died = new AbortController()
  const stop = vi.fn(async () => ({outcome: 'stopped' as const, crashed: false}))
  const proxy = {died: died.signal, stop}
  return {ready, stop, proxy}
}

describe('createSandboxLifecycle', () => {
  let temp: string
  // Every lifecycle holds process-wide signal ownership until it is released; a test that never releases its own must not
  // leak the hold into the next one.
  const created: {readonly release: () => Promise<unknown>}[] = []

  beforeEach(() => {
    temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lifecycle-')))
  })
  afterEach(async () => {
    // (bounded: a test about a teardown that never finishes leaves a release that never resolves)
    await Promise.allSettled(
      created
        .splice(0)
        .map(async lifecycle => Promise.race([lifecycle.release(), new Promise(resolve => setTimeout(resolve, 50))])),
    )
    fs.rmSync(temp, {recursive: true, force: true})
  })

  function create(harness: Harness, overrides: Partial<Parameters<typeof createSandboxLifecycle>[0]> = {}) {
    const lifecycle = createSandboxLifecycle({
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
    created.push(lifecycle)
    return lifecycle
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

  describe('launch: the lifecycle owns every process-producing operation', () => {
    const prepareInput = {keyFilePaths: [], ghConfigDir: null, repoSkills: null}
    const quietReport = <T>(value: T) => ({value, unconfirmed: false})

    async function prepared(overrides: Partial<Parameters<typeof createSandboxLifecycle>[0]> = {}) {
      const harness = createHarness()
      const host = fakeHost()
      const states: string[] = []
      const lifecycle = create(harness, {signals: host, recordState: state => states.push(state), ...overrides})
      expect((await lifecycle.prepare(prepareInput)).success).toBe(true)
      return {harness, host, states, lifecycle}
    }

    it('hands the spawn the launch spec and returns its value', async () => {
      // #given a prepared sandbox
      const {lifecycle} = await prepared()

      // #when a launch runs
      const result = await lifecycle.launch(async context => quietReport(context.spec.account.name))

      // #then
      expect(result).toEqual(ok('fro-bot-sandbox'))
    })

    it('refuses a launch before prepare, and after release', async () => {
      // #given a lifecycle that has not been prepared, and one that was released
      const harness = createHarness()
      const fresh = create(harness)
      const done = await prepared()
      await done.lifecycle.release()
      const spawn = vi.fn(async () => quietReport('x'))

      // #when
      const early = await fresh.launch(spawn)
      const late = await done.lifecycle.launch(spawn)

      // #then neither ran the spawn
      expect(early.success).toBe(false)
      expect(late.success).toBe(false)
      expect(spawn).not.toHaveBeenCalled()
    })

    it('closes admission synchronously when release is called, before anything is awaited', async () => {
      // #given a prepared sandbox
      const {lifecycle} = await prepared()
      const spawn = vi.fn(async () => quietReport('x'))

      // #when release starts and, in the same tick, a launch is attempted
      const releasing = lifecycle.release()
      const attempt = lifecycle.launch(spawn)

      // #then the launch is refused although release has not yet awaited anything
      expect((await attempt).success).toBe(false)
      expect(spawn).not.toHaveBeenCalled()
      await releasing
    })

    it('records the attempt before the spawn first awaits, so a release in that window waits for it', async () => {
      // #given a spawn that suspends at its first await (like port allocation)
      const {harness, lifecycle} = await prepared()
      const port = deferred<void>()
      let spawned = false
      const attempt = lifecycle.launch(async () => {
        await port.promise
        spawned = true
        return quietReport('server')
      })

      // #when release starts while the spawn is still waiting for its port
      const releasing = lifecycle.release()
      await Promise.resolve()
      await Promise.resolve()

      // #then nothing has been stopped, taken back or deleted yet
      expect(harness.mocks.stop).not.toHaveBeenCalled()
      expect(harness.mocks.takeBack).not.toHaveBeenCalled()
      expect(harness.mocks.deleteAccount).not.toHaveBeenCalled()

      // #when the spawn settles
      port.resolve()
      await attempt
      await releasing

      // #then the stop that follows comes after the launch finished, so it sees the process the launch created
      expect(spawned).toBe(true)
      const stopOrder = harness.mocks.stop.mock.invocationCallOrder[0] ?? 0
      expect(stopOrder).toBeGreaterThan(0)
    })

    it('aborts the spawn through its signal when release begins', async () => {
      // #given a spawn that waits for the abort
      const {lifecycle} = await prepared()
      const seen = deferred<boolean>()
      const attempt = lifecycle.launch(async context => {
        context.signal.addEventListener('abort', () => seen.resolve(true))
        await seen.promise
        return quietReport('aborted')
      })

      // #when release begins
      const releasing = lifecycle.release()

      // #then the spawn was told to stop, and release completed once it had
      expect(await seen.promise).toBe(true)
      await attempt
      expect(await releasing).toEqual({stop: 'stopped', restore: 'restored'})
    })

    it('waits for a signal during port allocation, then stops, takes back and deletes in that order', async () => {
      // #given a spawn that is still allocating its port
      const {harness, host, lifecycle} = await prepared()
      const port = deferred<void>()
      const attempt = lifecycle.launch(async () => {
        await port.promise
        return quietReport('server')
      })

      // #when SIGTERM arrives
      host.emitter.emit('SIGTERM')
      await Promise.resolve()
      expect(harness.mocks.stop).not.toHaveBeenCalled()
      port.resolve()
      await attempt

      // #then the teardown ran after the launch settled, in order, and the signal was re-raised afterwards
      await vi.waitFor(() => {
        expect(host.killed).toEqual(['4242:SIGTERM'])
      })
      const order = [harness.mocks.stop, harness.mocks.takeBack, harness.mocks.deleteAccount].map(
        mock => mock.mock.invocationCallOrder[0] ?? 0,
      )
      expect(order[0]).toBeGreaterThan(0)
      expect(order).toEqual([...order].sort((x, y) => x - y))
    })

    it('waits for a signal during the privileged launch itself (the child exists, readiness is pending)', async () => {
      // #given a spawn past port allocation and waiting for readiness
      const {harness, host, lifecycle} = await prepared()
      const ready = deferred<void>()
      const attempt = lifecycle.launch(async context => {
        context.signal.addEventListener('abort', () => ready.resolve())
        await ready.promise
        return quietReport('cleaned-up')
      })

      // #when SIGINT arrives
      host.emitter.emit('SIGINT')
      await attempt

      // #then the abort let the launcher clean up first; only then was the account's uid verified empty and files taken back
      await vi.waitFor(() => {
        expect(host.killed).toEqual(['4242:SIGINT'])
      })
      expect(harness.mocks.stop).toHaveBeenCalledTimes(1)
      expect(harness.mocks.takeBack).toHaveBeenCalledTimes(1)
    })

    it('reports unconfirmed when the launcher could not confirm its child is gone: no take-back, account kept, state unsafe', async () => {
      // #given a launcher whose own cleanup was unconfirmed
      const {harness, states, lifecycle} = await prepared()
      await lifecycle.launch(async () => ({value: 'failed-start', unconfirmed: true}))

      // #when released
      const outcome = await lifecycle.release()

      // #then
      expect(outcome.stop).toBe('unconfirmed')
      expect(outcome.restore).toBe('unsafe')
      expect(harness.mocks.takeBack).not.toHaveBeenCalled()
      expect(harness.mocks.deleteAccount).not.toHaveBeenCalled()
      expect(states.at(-1)).toBe('unsafe')
    })

    it('treats a spawn that throws as unconfirmed and rethrows', async () => {
      // #given a spawn that throws
      const {harness, lifecycle} = await prepared()

      // #when
      await expect(
        lifecycle.launch(async () => {
          throw new Error('spawn blew up')
        }),
      ).rejects.toThrow('spawn blew up')

      // #then what it may have started is unknown, so the release is unconfirmed
      const outcome = await lifecycle.release()
      expect(outcome.stop).toBe('unconfirmed')
      expect(harness.mocks.takeBack).not.toHaveBeenCalled()
    })

    it('does not wait forever for a spawn that ignores the abort: unconfirmed after its settle budget', async () => {
      // #given a spawn that never settles, and a small settle budget
      const {harness, lifecycle} = await prepared({launchSettleBudgetMs: 20})
      lifecycle.launch(async () => new Promise<never>(() => undefined)).catch(() => undefined)

      // #when released
      const outcome = await lifecycle.release()

      // #then fail closed: no take-back, no account deletion
      expect(outcome.stop).toBe('unconfirmed')
      expect(outcome.restore).toBe('unsafe')
      expect(harness.mocks.takeBack).not.toHaveBeenCalled()
      expect(harness.mocks.deleteAccount).not.toHaveBeenCalled()
    })
  })

  describe('signal ownership', () => {
    const prepareInput = {keyFilePaths: [], ghConfigDir: null, repoSkills: null}

    it('owns signal handling from prepare until release, and gives it back afterwards', async () => {
      // #given a lifecycle that has not been prepared
      const harness = createHarness()
      const lifecycle = create(harness, {signals: fakeHost()})
      expect(isSignalOwned()).toBe(false)

      // #when prepared
      await lifecycle.prepare(prepareInput)

      // #then the exec adapter defers to it
      expect(isSignalOwned()).toBe(true)

      // #when released
      await lifecycle.release()

      // #then the adapter is back in charge (a leaked hold would make every later command ignore signals)
      expect(isSignalOwned()).toBe(false)
    })

    it('gives ownership back when a signal has run the teardown, before the signal is re-raised', async () => {
      // #given a prepared lifecycle and a host that records when the signal is re-raised
      const harness = createHarness()
      const host = fakeHost()
      const owned: boolean[] = []
      const raising = {
        ...host,
        kill: (pid: number, signal: 'SIGINT' | 'SIGTERM') => {
          owned.push(isSignalOwned())
          host.kill(pid, signal)
        },
      }
      const lifecycle = create(harness, {signals: raising})
      await lifecycle.prepare(prepareInput)

      // #when SIGTERM arrives
      host.emitter.emit('SIGTERM')
      await vi.waitFor(() => {
        expect(host.killed).toEqual(['4242:SIGTERM'])
      })

      // #then at the moment of the re-raise the adapter had its say back
      expect(owned).toEqual([false])
    })

    it('does not own signal handling when preparation fails before any handler is needed', async () => {
      // #given a lifecycle whose account creation fails
      const harness = createHarness()
      harness.mocks.createAccount.mockResolvedValue(err({kind: 'create-failed', message: 'nope'}))
      const lifecycle = create(harness, {signals: fakeHost()})

      // #when
      await lifecycle.prepare(prepareInput)
      await lifecycle.release()

      // #then nothing is left held
      expect(isSignalOwned()).toBe(false)
    })
  })

  describe('a privileged command that times out is never confirmed', () => {
    const prepareInput = {keyFilePaths: [], ghConfigDir: null, repoSkills: null}
    const PASSWD = 'root:x:0:0:root:/root:/bin/bash\nrunner:x:1001:1001::/home/runner:/bin/bash\n'
    const GROUP = 'root:x:0:\nrunner:x:1001:\n'

    it('keeps the account and ends unsafe when useradd times out, so state is never restored', async () => {
      // #given the real account creation, with a useradd that never exits (and an account that exists at the timeout)
      const harness = createHarness()
      const seen: string[] = []
      const states: string[] = []
      let passwd = PASSWD
      const lifecycle = create(harness, {
        exec: hangingExec('useradd', seen),
        signals: fakeHost(),
        recordState: state => states.push(state),
        deps: {
          ...harness.deps,
          createAccount: createSandboxAccount,
          readText: async file => {
            if (file === '/etc/group') return GROUP
            // useradd got as far as creating the account before it hung
            passwd = seen.some(line => line.endsWith('useradd') || line.includes('useradd '))
              ? `${PASSWD}fro-bot-sandbox:x:998:997::/home/fro-bot-sandbox:/bin/bash\n`
              : PASSWD
            return passwd
          },
        },
      })

      // #when prepared and then released
      const prepared = await lifecycle.prepare(prepareInput)
      // (the failed preparation itself must already have recorded unsafe: a caller that never calls release must not read pending)
      const stateAfterPrepare = states.at(-1)
      const released = await lifecycle.release()

      // #then preparation failed, nothing ever deleted the account, and the run never claimed it was restored
      expect(prepared.success).toBe(false)
      expect(stateAfterPrepare).toBe('unsafe')
      expect(seen.some(line => line.includes('userdel'))).toBe(false)
      expect(released.restore).toBe('unsafe')
      expect(states).not.toContain('restored')
      expect(states.at(-1)).toBe('unsafe')
      expect(harness.mocks.takeBack).not.toHaveBeenCalled()
      expect(harness.mocks.deleteAccount).not.toHaveBeenCalled()
    })

    it('keeps the account and records unsafe when a handoff command times out', async () => {
      // #given a handoff whose privileged command never exits (then reports the failure, as the real one does)
      const harness = createHarness()
      const states: string[] = []
      const seen: string[] = []
      harness.mocks.handOff.mockImplementation(async (_manifest, handoffDeps) => {
        await handoffDeps.run(['/usr/bin/setfacl', '-hang'])
        return err('Sandbox handoff failed: checkout ACL timed out after 120000ms')
      })
      const lifecycle = create(harness, {
        exec: hangingExec('-hang', seen),
        signals: fakeHost(),
        recordState: state => states.push(state),
      })

      // #when
      const prepared = await lifecycle.prepare(prepareInput)

      // #then preparation failed through the rollback, which kept the account: no take-back, no deletion, unsafe
      expect(prepared.success).toBe(false)
      expect(harness.mocks.deleteAccount).not.toHaveBeenCalled()
      expect(harness.mocks.takeBack).not.toHaveBeenCalled()
      expect(states).not.toContain('restored')
      expect(states.at(-1)).toBe('unsafe')
    })

    it('ends unsafe when the stop sweep times out, even if it then reports stopped', async () => {
      // #given a prepared sandbox whose stop step runs a command that never exits
      const harness = createHarness()
      const states: string[] = []
      const seen: string[] = []
      harness.mocks.stop.mockImplementation(async (_account, _tools, identityDeps) => {
        await identityDeps.run(['/usr/bin/pkill', '-hang'])
        return 'stopped'
      })
      const lifecycle = create(harness, {
        exec: hangingExec('-hang', seen),
        signals: fakeHost(),
        recordState: state => states.push(state),
      })
      await lifecycle.prepare(prepareInput)

      // #when released
      const released = await lifecycle.release()

      // #then the account stays and nothing is taken back
      expect(released.restore).toBe('unsafe')
      expect(released.reason).toMatch(/timed out/)
      expect(harness.mocks.takeBack).not.toHaveBeenCalled()
      expect(harness.mocks.deleteAccount).not.toHaveBeenCalled()
      expect(states.at(-1)).toBe('unsafe')
    })

    it('ends unsafe, keeping the account, when a take-back command times out but take-back still reports restored', async () => {
      // #given a take-back whose best-effort command hung (the step itself does not treat that as fatal)
      const harness = createHarness()
      const states: string[] = []
      const seen: string[] = []
      harness.mocks.takeBack.mockImplementation(async (_manifest, _journal, handoffDeps) => {
        await handoffDeps.run(['/usr/bin/chmod', '-hang'])
        return {status: 'restored' as const}
      })
      const lifecycle = create(harness, {
        exec: hangingExec('-hang', seen),
        signals: fakeHost(),
        recordState: state => states.push(state),
      })
      await lifecycle.prepare(prepareInput)

      // #when
      const released = await lifecycle.release()

      // #then
      expect(released.restore).toBe('unsafe')
      expect(harness.mocks.deleteAccount).not.toHaveBeenCalled()
      expect(states).not.toContain('restored')
    })

    it('production-shaped: a take-back that times out and returns unsafe never reaches userdel, and keeps its own reason', async () => {
      // #given a take-back like the real one: its privileged command hangs, and it reports `unsafe` with the timeout as the reason
      const harness = createHarness()
      const states: string[] = []
      const seen: string[] = []
      harness.mocks.takeBack.mockImplementation(async (_manifest, _journal, handoffDeps) => {
        await handoffDeps.run(['/usr/bin/chown', '-hang'])
        return {status: 'unsafe' as const, reason: 'taking the checkout back timed out after 120000ms'}
      })
      const lifecycle = create(harness, {
        exec: hangingExec('-hang', seen),
        signals: fakeHost(),
        recordState: state => states.push(state),
      })
      await lifecycle.prepare(prepareInput)

      // #when released
      const released = await lifecycle.release()

      // #then the account was neither deleted nor touched by any userdel, the state is unsafe, and the take-back's reason survived
      expect(harness.mocks.deleteAccount).not.toHaveBeenCalled()
      expect(seen.some(line => line.includes('userdel'))).toBe(false)
      expect(released.restore).toBe('unsafe')
      expect(released.reason).toBe('taking the checkout back timed out after 120000ms')
      expect(states).not.toContain('restored')
      expect(states.at(-1)).toBe('unsafe')
    })

    it('production-shaped: a take-back that returns unsafe WITHOUT any timeout still deletes the account (the stop was confirmed)', async () => {
      // #given an unsafe take-back for an ordinary reason
      const harness = createHarness()
      harness.mocks.takeBack.mockResolvedValue({status: 'unsafe' as const, reason: '.git/commondir exists'})
      const lifecycle = create(harness, {signals: fakeHost()})
      await lifecycle.prepare(prepareInput)

      // #when
      const released = await lifecycle.release()

      // #then the old behaviour holds: nothing runs as that uid any more, so the account goes
      expect(harness.mocks.deleteAccount).toHaveBeenCalledTimes(1)
      expect(released).toEqual({stop: 'stopped', restore: 'unsafe', reason: '.git/commondir exists'})
    })

    it('ends unsafe when userdel times out, rather than reporting restored with the account possibly still there', async () => {
      // #given an account deletion whose command hung
      const harness = createHarness()
      const states: string[] = []
      const seen: string[] = []
      harness.mocks.deleteAccount.mockImplementation(async (_account, _tools, identityDeps) => {
        await identityDeps.run(['/usr/sbin/userdel', '-hang'])
        return 'failed' as const
      })
      const lifecycle = create(harness, {
        exec: hangingExec('-hang', seen),
        signals: fakeHost(),
        recordState: state => states.push(state),
      })
      await lifecycle.prepare(prepareInput)

      // #when
      const released = await lifecycle.release()

      // #then
      expect(released.restore).toBe('unsafe')
      expect(states).not.toContain('restored')
    })

    it('still restores normally when nothing timed out', async () => {
      // #given a fully healthy run
      const harness = createHarness()
      const states: string[] = []
      const lifecycle = create(harness, {signals: fakeHost(), recordState: state => states.push(state)})
      await lifecycle.prepare(prepareInput)

      // #when
      const released = await lifecycle.release()

      // #then
      expect(released).toEqual({stop: 'stopped', restore: 'restored'})
      expect(states.at(-1)).toBe('restored')
    })
  })

  describe('teardown state', () => {
    const prepareInput = {keyFilePaths: [], ghConfigDir: null, repoSkills: null}

    it('records pending before the account exists, and restored only after a confirmed release', async () => {
      // #given a recorder, and an account creation that observes it
      const harness = createHarness()
      const states: string[] = []
      let seenWhenCreating: string[] = []
      harness.mocks.createAccount.mockImplementation(async () => {
        seenWhenCreating = [...states]
        return ok(ACCOUNT)
      })
      const lifecycle = create(harness, {recordState: state => states.push(state)})

      // #when prepared, then released
      await lifecycle.prepare(prepareInput)
      expect(states).toEqual(['pending'])
      await lifecycle.release()

      // #then pending was recorded first, and restored only at the end
      expect(seenWhenCreating).toEqual(['pending'])
      expect(states).toEqual(['pending', 'restored'])
    })

    it.each([
      ['an unsafe take-back', (h: Harness) => h.mocks.takeBack.mockResolvedValue({status: 'unsafe', reason: 'x'})],
      ['an unconfirmed stop', (h: Harness) => h.mocks.stop.mockResolvedValue('unconfirmed')],
      ['a release that throws', (h: Harness) => h.mocks.stop.mockRejectedValue(new Error('sudo vanished'))],
    ])('records unsafe for %s, never restored', async (_label, arrange) => {
      // #given a teardown that cannot be confirmed
      const harness = createHarness()
      arrange(harness)
      const states: string[] = []
      const lifecycle = create(harness, {recordState: state => states.push(state)})
      await lifecycle.prepare(prepareInput)

      // #when released
      await lifecycle.release()

      // #then
      expect(states).toEqual(['pending', 'unsafe'])
    })

    it('records pending and then restored for a failed preparation that was rolled back', async () => {
      // #given a handoff that fails (it rolled itself back)
      const harness = createHarness()
      harness.mocks.handOff.mockResolvedValue(err('chown failed'))
      const states: string[] = []
      const lifecycle = create(harness, {recordState: state => states.push(state)})

      // #when preparation fails
      const prepared = await lifecycle.prepare(prepareInput)

      // #then the account was removed and the state says so
      expect(prepared.success).toBe(false)
      expect(states).toEqual(['pending', 'restored'])
    })
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

    it('waits for account creation, then tears down the real account instead of caching a never-started release', async () => {
      // #given a signal that arrives while the account is still being created
      const harness = createHarness()
      const host = fakeHost()
      const creation = deferred<Awaited<ReturnType<SandboxLifecycleDeps['createAccount']>>>()
      harness.mocks.createAccount.mockImplementation(async () => creation.promise)
      const lifecycle = create(harness, {signals: host})
      const preparing = lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})
      await vi.waitFor(() => {
        expect(harness.mocks.createAccount).toHaveBeenCalledTimes(1)
      })

      // #when SIGTERM arrives mid-creation, and the creation then completes
      host.emitter.emit('SIGTERM')
      await Promise.resolve()
      expect(harness.mocks.stop).not.toHaveBeenCalled()
      creation.resolve(ok(ACCOUNT))
      const prepared = await preparing

      // #then preparation was abandoned without handing anything over, and the real account was stopped and deleted
      expect(prepared.success).toBe(false)
      await vi.waitFor(() => {
        expect(host.killed).toEqual(['4242:SIGTERM'])
      })
      expect(harness.mocks.handOff).not.toHaveBeenCalled()
      expect(harness.mocks.stop).toHaveBeenCalledWith(
        expect.objectContaining({uid: ACCOUNT.uid}),
        expect.anything(),
        expect.anything(),
      )
      expect(harness.mocks.deleteAccount).toHaveBeenCalledTimes(1)
      // #and the cached release is the earned one, not a never-started result
      expect(await lifecycle.release()).toEqual({stop: 'stopped', restore: 'restored'})
    })

    it('waits for the handoff, then takes back using the real journal', async () => {
      // #given a signal that arrives while files are being handed over
      const harness = createHarness()
      const host = fakeHost()
      const handoff = deferred<Awaited<ReturnType<SandboxLifecycleDeps['handOff']>>>()
      const journal = {snapshotDir: '/journal', touched: [], chowned: [], aclTrees: [], git: null, gitPresent: false}
      harness.mocks.handOff.mockImplementation(async () => handoff.promise)
      const lifecycle = create(harness, {signals: host})
      const preparing = lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})
      await vi.waitFor(() => {
        expect(harness.mocks.handOff).toHaveBeenCalledTimes(1)
      })

      // #when SIGINT arrives mid-handoff, and the handoff then completes
      host.emitter.emit('SIGINT')
      await Promise.resolve()
      expect(harness.mocks.takeBack).not.toHaveBeenCalled()
      handoff.resolve(ok(journal))
      const prepared = await preparing

      // #then preparation did not go on to a launch spec for a server nobody will stop
      expect(prepared.success).toBe(false)

      // #and take-back ran on the journal the handoff produced, before the account was deleted, then the signal was re-raised
      await vi.waitFor(() => {
        expect(host.killed).toEqual(['4242:SIGINT'])
      })
      expect(harness.mocks.takeBack).toHaveBeenCalledTimes(1)
      expect(harness.mocks.takeBack.mock.calls[0]?.[1]).toBe(journal)
      expect(harness.mocks.takeBack.mock.invocationCallOrder[0]).toBeLessThan(
        harness.mocks.deleteAccount.mock.invocationCallOrder[0] ?? 0,
      )
    })

    it('refuses to prepare once a signal has been received', async () => {
      // #given a signal before preparation starts
      const harness = createHarness()
      const host = fakeHost()
      const lifecycle = create(harness, {signals: host})
      await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})
      host.emitter.emit('SIGTERM')
      await vi.waitFor(() => {
        expect(host.killed).toHaveLength(1)
      })
      harness.mocks.createAccount.mockClear()

      // #when preparation is attempted again
      const again = await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})

      // #then no second account is created
      expect(again.success).toBe(false)
      expect(harness.mocks.createAccount).not.toHaveBeenCalled()
    })

    it('between prepare and spawn: reports inactive from the signal on, tears down using the journal, never spawns on a stale launch', async () => {
      // #given a fully prepared sandbox (handoff done, launch spec returned) whose server has not started yet
      const harness = createHarness()
      const host = fakeHost()
      const journal = {snapshotDir: '/journal', touched: [], chowned: [], aclTrees: [], git: null, gitPresent: false}
      harness.mocks.handOff.mockResolvedValue(ok(journal))
      const states: string[] = []
      const lifecycle = create(harness, {signals: host, recordState: state => states.push(state)})
      const prepared = await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})
      expect(prepared.success).toBe(true)

      // #when SIGTERM arrives in the gap before the spawn
      host.emitter.emit('SIGTERM')

      // #then a launch attempted at once is refused, before the teardown has even finished
      const spawn = vi.fn(async () => ({value: 'x', unconfirmed: false}))
      expect((await lifecycle.launch(spawn)).success).toBe(false)
      expect(spawn).not.toHaveBeenCalled()
      await vi.waitFor(() => {
        expect(host.killed).toEqual(['4242:SIGTERM'])
      })
      // #and the teardown used the real journal, then deleted the account, and only then reported restored
      expect(harness.mocks.takeBack.mock.calls[0]?.[1]).toBe(journal)
      expect(harness.mocks.deleteAccount).toHaveBeenCalledTimes(1)
      expect(states).toEqual(['pending', 'restored'])
    })

    it.each([
      ['account creation', 'createAccount'],
      ['handoff', 'handOff'],
    ] as const)('reports no restored when %s outlasts the teardown budget', async (_label, stepName) => {
      // #given a step that does not finish before the 20 ms budget, and a recorder
      const harness = createHarness()
      const host = fakeHost()
      const gate = deferred<unknown>()
      harness.mocks[stepName].mockImplementation((async () => gate.promise) as never)
      const states: string[] = []
      const lifecycle = create(harness, {
        signals: host,
        signalTeardownBudgetMs: 20,
        recordState: state => states.push(state),
      })
      const preparing = lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})
      await vi.waitFor(() => {
        expect(harness.mocks[stepName]).toHaveBeenCalledTimes(1)
      })

      // #when the signal arrives and the budget runs out with the step still running
      host.emitter.emit('SIGINT')
      await vi.waitFor(() => {
        expect(host.killed).toEqual(['4242:SIGINT'])
      })

      // #then the signal was re-raised without ever recording a restore: the state the post hook sees is not restored
      expect(states).not.toContain('restored')
      expect(states.at(-1)).toBe('unsafe')
      expect(harness.mocks.deleteAccount).not.toHaveBeenCalled()
      gate.resolve(
        stepName === 'createAccount'
          ? ok(ACCOUNT)
          : ok({snapshotDir: '/j', touched: [], chowned: [], aclTrees: [], git: null, gitPresent: false}),
      )
      await preparing
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

  describe('the key proxy the lifecycle owns', () => {
    type StopOutcome = 'already-exited' | 'killed' | 'stopped' | 'unconfirmed'

    function fakeProxy(options: {outcome?: StopOutcome; crashed?: boolean; order?: string[]} = {}) {
      const died = new AbortController()
      const stop = vi.fn(async () => {
        options.order?.push('proxy-stop')
        return {outcome: options.outcome ?? 'stopped', crashed: options.crashed ?? false}
      })
      return {proxy: {died: died.signal, stop}, stop, died}
    }

    const report = <T>(proxy: T | null, unconfirmed = false) => ({proxy, unconfirmed})

    it('starts the proxy under signal ownership, before any account exists, and stops it last on release', async () => {
      // #given a harness that records the order of the teardown steps
      const harness = createHarness()
      const order: string[] = []
      harness.mocks.stop.mockImplementation(async () => {
        order.push('sandbox-stop')
        return 'stopped' as const
      })
      harness.mocks.takeBack.mockImplementation(async () => {
        order.push('take-back')
        return {status: 'restored' as const}
      })
      harness.mocks.deleteAccount.mockImplementation(async () => {
        order.push('delete-account')
        return 'deleted' as const
      })
      const host = fakeHost()
      const lifecycle = create(harness, {signals: host})
      const {proxy, stop} = fakeProxy({order})

      // #when the proxy starts first, then the sandbox is prepared and released
      let ownedDuringStart: boolean | undefined
      const started = await lifecycle.startKeyProxy(async () => {
        ownedDuringStart = isSignalOwned()
        return report(proxy)
      })
      await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})
      const outcome = await lifecycle.release()

      // #then signals were owned before the spawn, and the proxy stopped after the sandbox was taken back
      expect(ownedDuringStart).toBe(true)
      expect(started).toEqual({success: true, data: proxy})
      expect(order).toEqual(['sandbox-stop', 'take-back', 'delete-account', 'proxy-stop'])
      expect(stop).toHaveBeenCalledTimes(1)
      expect(outcome).toEqual({stop: 'stopped', restore: 'restored', proxy: 'stopped'})
    })

    it('stops the proxy when no sandbox account was ever created', async () => {
      // #given a proxy and a release with no prepare
      const harness = createHarness()
      const lifecycle = create(harness)
      const {proxy, stop} = fakeProxy()
      await lifecycle.startKeyProxy(async () => report(proxy))

      // #when released
      const outcome = await lifecycle.release()

      // #then the proxy is stopped and the sandbox steps never ran
      expect(stop).toHaveBeenCalledTimes(1)
      expect(harness.mocks.stop).not.toHaveBeenCalled()
      expect(outcome).toEqual({stop: 'never-started', restore: 'not-needed', proxy: 'stopped'})
    })

    it('stops the proxy once however many times release is called', async () => {
      const harness = createHarness()
      const lifecycle = create(harness)
      const {proxy, stop} = fakeProxy()
      await lifecycle.startKeyProxy(async () => report(proxy))

      const [first, second] = await Promise.all([lifecycle.release(), lifecycle.release()])
      await lifecycle.release()

      expect(first).toEqual(second)
      expect(stop).toHaveBeenCalledTimes(1)
    })

    it('logs a confirmed proxy stop with exitConfirmed true, and nothing when the exit is unconfirmed', async () => {
      // #given one lifecycle whose proxy stops cleanly and one whose proxy exit cannot be confirmed
      const stoppedLogger = createMockLogger()
      const stopped = create(createHarness(), {logger: stoppedLogger})
      await stopped.startKeyProxy(async () => report(fakeProxy().proxy))
      const unconfirmedLogger = createMockLogger()
      const unconfirmed = create(createHarness(), {logger: unconfirmedLogger})
      await unconfirmed.startKeyProxy(async () => report(fakeProxy({outcome: 'unconfirmed'}).proxy))

      // #when both are released
      await stopped.release()
      await unconfirmed.release()

      // #then only the confirmed stop logs the line
      expect(stoppedLogger.info).toHaveBeenCalledWith('Key proxy stopped', {exitConfirmed: true})
      expect(unconfirmedLogger.info).not.toHaveBeenCalledWith('Key proxy stopped', expect.anything())
      expect(unconfirmedLogger.error).toHaveBeenCalledWith(
        'The key proxy exit could not be confirmed; the run can no longer be trusted',
      )
    })

    it('records the run unsafe when the proxy exit cannot be confirmed', async () => {
      // #given a proxy that cannot be confirmed stopped
      const harness = createHarness()
      const states: string[] = []
      const lifecycle = create(harness, {recordState: state => states.push(state)})
      const {proxy} = fakeProxy({outcome: 'unconfirmed'})
      await lifecycle.startKeyProxy(async () => report(proxy))
      await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})

      // #when released
      const outcome = await lifecycle.release()

      // #then nothing is called restored, even though the sandbox itself was
      expect(outcome.restore).toBe('unsafe')
      expect(outcome.proxy).toBe('unconfirmed')
      expect(outcome.reason).toMatch(/key proxy/)
      expect(states.at(-1)).toBe('unsafe')
    })

    it('records the run unsafe when no sandbox was created and the proxy exit cannot be confirmed', async () => {
      const harness = createHarness()
      const lifecycle = create(harness)
      const {proxy} = fakeProxy({outcome: 'unconfirmed'})
      await lifecycle.startKeyProxy(async () => report(proxy))

      const outcome = await lifecycle.release()

      expect(outcome).toMatchObject({stop: 'never-started', restore: 'unsafe', proxy: 'unconfirmed'})
    })

    it('reports a proxy that died on its own as crashed, with the sandbox still restored', async () => {
      const harness = createHarness()
      const lifecycle = create(harness)
      const {proxy} = fakeProxy({outcome: 'already-exited', crashed: true})
      await lifecycle.startKeyProxy(async () => report(proxy))
      await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})

      const outcome = await lifecycle.release()

      expect(outcome).toEqual({stop: 'stopped', restore: 'restored', proxy: 'crashed'})
    })

    it('treats a start that could not confirm its child is gone as unsafe', async () => {
      // #given a start that failed and left an unconfirmed child
      const harness = createHarness()
      const lifecycle = create(harness)
      const started = await lifecycle.startKeyProxy(async () => report(null, true))

      // #when released
      const outcome = await lifecycle.release()

      // #then the start result is "no proxy" and the release is unsafe
      expect(started).toEqual({success: true, data: null})
      expect(outcome).toMatchObject({restore: 'unsafe', proxy: 'unconfirmed'})
    })

    it('treats a start that throws as unsafe and still rejects to its caller', async () => {
      const harness = createHarness()
      const lifecycle = create(harness)

      await expect(
        lifecycle.startKeyProxy(async () => {
          throw new Error('spawn blew up')
        }),
      ).rejects.toThrow('spawn blew up')

      expect(await lifecycle.release()).toMatchObject({restore: 'unsafe', proxy: 'unconfirmed'})
    })

    it('refuses a second proxy, and any proxy once the teardown has begun', async () => {
      const harness = createHarness()
      const lifecycle = create(harness)
      const {proxy} = fakeProxy()
      await lifecycle.startKeyProxy(async () => report(proxy))

      const second = await lifecycle.startKeyProxy(async () => report(proxy))
      await lifecycle.release()
      const afterRelease = await lifecycle.startKeyProxy(async () => report(proxy))

      expect(second.success).toBe(false)
      expect(afterRelease.success).toBe(false)
    })

    it('never starts a proxy after SIGTERM arrived before the spawn', async () => {
      // #given a signal before the proxy is requested
      const harness = createHarness()
      const host = fakeHost()
      const lifecycle = create(harness, {signals: host})
      const {proxy, stop} = fakeProxy()
      await lifecycle.startKeyProxy(async () => report(proxy))
      host.emitter.emit('SIGTERM')
      await vi.waitFor(() => {
        expect(host.killed).toEqual(['4242:SIGTERM'])
      })

      // #when another start is requested
      const starter = vi.fn(async () => report(proxy))
      const refused = await lifecycle.startKeyProxy(starter)

      // #then it is refused and the earlier proxy was stopped
      expect(refused.success).toBe(false)
      expect(starter).not.toHaveBeenCalled()
      expect(stop).toHaveBeenCalledTimes(1)
    })

    it('waits for a start that SIGTERM interrupts during readiness, then stops what it produced', async () => {
      // #given a proxy start that is still waiting for its ready line
      const harness = createHarness()
      const host = fakeHost()
      const lifecycle = create(harness, {signals: host})
      const ready = deferred<void>()
      const {proxy, stop} = fakeProxy()
      let startSignal: AbortSignal | undefined
      const starting = lifecycle.startKeyProxy(async context => {
        startSignal = context.signal
        await ready.promise
        return report(proxy)
      })

      // #when SIGTERM arrives mid-start
      host.emitter.emit('SIGTERM')
      await Promise.resolve()

      // #then the start was told to abort, and nothing is stopped or re-raised until it settles
      expect(startSignal?.aborted).toBe(true)
      expect(stop).not.toHaveBeenCalled()
      expect(host.killed).toEqual([])

      // #when the start produces its proxy anyway
      ready.resolve()
      await starting

      // #then it is stopped before the signal is re-raised
      await vi.waitFor(() => {
        expect(host.killed).toEqual(['4242:SIGTERM'])
      })
      expect(stop).toHaveBeenCalledTimes(1)
    })

    it('stops a ready proxy when SIGTERM lands before prepare, and refuses the prepare', async () => {
      // #given a running proxy and no prepare yet
      const harness = createHarness()
      const host = fakeHost()
      const lifecycle = create(harness, {signals: host})
      const {proxy, stop} = fakeProxy()
      await lifecycle.startKeyProxy(async () => report(proxy))

      // #when the signal arrives, then prepare is attempted
      host.emitter.emit('SIGTERM')
      await vi.waitFor(() => {
        expect(host.killed).toEqual(['4242:SIGTERM'])
      })
      const prepared = await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})

      // #then the proxy is stopped, and no account was created
      expect(stop).toHaveBeenCalledTimes(1)
      expect(prepared.success).toBe(false)
      expect(harness.mocks.createAccount).not.toHaveBeenCalled()
    })

    it('fails closed when a start does not settle within the launch budget after it is aborted', async () => {
      // #given a start that ignores its abort and never settles
      const harness = createHarness()
      const lifecycle = create(harness, {launchSettleBudgetMs: 30})
      lifecycle.startKeyProxy(async () => new Promise<never>(() => undefined)).catch(() => undefined)

      // #when released
      const outcome = await lifecycle.release()

      // #then the run is unsafe
      expect(outcome).toMatchObject({restore: 'unsafe', proxy: 'unconfirmed'})
    })
  })

  describe('a key proxy that is ready only after the release gave up waiting for its start', () => {
    it('still stops the proxy when it turns up late, and the run stays unsafe', async () => {
      // #given a start that ignores its abort and becomes ready after the settle budget
      const harness = createHarness()
      const lifecycle = create(harness, {launchSettleBudgetMs: 30})
      const {ready, stop, proxy} = lateStart()
      const starting = lifecycle.startKeyProxy(async () => {
        await ready.promise
        return {proxy, unconfirmed: false}
      })

      // #when the release gives up waiting and finishes
      const outcome = await lifecycle.release()
      expect(outcome).toMatchObject({restore: 'unsafe', proxy: 'unconfirmed'})
      expect(stop).not.toHaveBeenCalled()

      // #and the start then produces its proxy
      ready.resolve()
      const started = await starting

      // #then the caller is handed no proxy (not a stopped one), that proxy is stopped once, and the outcome is unchanged
      expect(started).toEqual({success: true, data: null})
      await vi.waitFor(() => {
        expect(stop).toHaveBeenCalledTimes(1)
      })
      expect(await lifecycle.release()).toBe(outcome)
    })

    it('does not stop a proxy twice when the release did wait for it', async () => {
      // #given a start that settles within the budget
      const harness = createHarness()
      const lifecycle = create(harness, {launchSettleBudgetMs: 2000})
      const {ready, stop, proxy} = lateStart()
      const starting = lifecycle.startKeyProxy(async () => {
        await ready.promise
        return {proxy, unconfirmed: false}
      })

      // #when it becomes ready while the release is waiting
      const releasing = lifecycle.release()
      ready.resolve()
      await starting
      const outcome = await releasing

      // #then it is stopped once, by the release, and the run is not unsafe
      expect(stop).toHaveBeenCalledTimes(1)
      expect(outcome).toMatchObject({proxy: 'stopped'})
      expect(outcome.restore).not.toBe('unsafe')
    })

    it('logs and swallows a stop that throws for a late proxy', async () => {
      const harness = createHarness()
      const lifecycle = create(harness, {launchSettleBudgetMs: 30})
      const ready = deferred<void>()
      const stop = vi.fn(async () => Promise.reject(new Error('stop failed')))
      const starting = lifecycle.startKeyProxy(async () => {
        await ready.promise
        return {proxy: {died: new AbortController().signal, stop}, unconfirmed: false}
      })

      await lifecycle.release()
      ready.resolve()

      // #then the caller is handed no proxy, whatever the stop did
      await expect(starting).resolves.toEqual({success: true, data: null})

      await vi.waitFor(() => {
        expect(stop).toHaveBeenCalledTimes(1)
      })
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
    expect(result).toEqual({exitCode: 3, stdout: 'out', stderr: ''})
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
    expect(defaulted).toEqual({exitCode: null, stdout: '', stderr: '', timedOutAfterMs: DEFAULT_PRIVILEGED_TIMEOUT_MS})
    expect(getExecOutput).not.toHaveBeenCalled()
    expect(execWithTimeout.mock.calls.map(call => call[2])).toEqual([DEFAULT_PRIVILEGED_TIMEOUT_MS, 1234])
    expect(execWithTimeout).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      ['-n', '--', '/usr/bin/find', '/x'],
      expect.any(Number),
      expect.objectContaining({cwd: '/'}),
    )
  })

  it('reports how long a killed command was given and the tail of its stderr', async () => {
    // #given a command that printed to stderr and then hung past its budget
    const execWithTimeout = vi.fn(
      async (_command: string, _args: string[] | undefined, _timeout: number, options?: ExecOptions) => {
        options?.listeners?.stderr?.(Buffer.from('first line\n'))
        options?.listeners?.stderr?.(Buffer.from('useradd: stuck on /etc/passwd'))
        return 'timed-out' as const
      },
    )
    const run = createPrivilegedRun({exec: vi.fn(), execWithTimeout, getExecOutput: vi.fn()}, '/usr/bin/sudo')

    // #when
    const result = await run(['/usr/sbin/useradd', 'x'], {timeoutMs: 4321})

    // #then
    expect(result).toEqual({
      exitCode: null,
      stdout: '',
      stderr: 'first line\nuseradd: stuck on /etc/passwd',
      timedOutAfterMs: 4321,
    })
  })

  it('asks the adapter for a process snapshot on timeout and returns it', async () => {
    // #given an adapter that reports a snapshot and then a timeout
    const execWithTimeout = vi.fn(
      async (_command: string, _args: string[] | undefined, _timeout: number, options?: ExecOptions) => {
        options?.onTimeout?.('PID PPID PGID STAT ELAPSED COMMAND\n9 8 9 S 01:00 /usr/sbin/useradd x')
        return 'timed-out' as const
      },
    )
    const run = createPrivilegedRun({exec: vi.fn(), execWithTimeout, getExecOutput: vi.fn()}, '/usr/bin/sudo')

    // #when
    const result = await run(['/usr/sbin/useradd', 'x'], {timeoutMs: 60_000})

    // #then
    expect(result.processes).toContain('9 8 9 S 01:00 /usr/sbin/useradd x')
  })

  it('keeps only the last 2048 bytes of stderr', async () => {
    // #given a command with far more stderr than that
    const execWithTimeout = vi.fn(
      async (_command: string, _args: string[] | undefined, _timeout: number, options?: ExecOptions) => {
        options?.listeners?.stderr?.(Buffer.from('a'.repeat(5000)))
        options?.listeners?.stderr?.(Buffer.from('END'))
        return 1
      },
    )
    const run = createPrivilegedRun({exec: vi.fn(), execWithTimeout, getExecOutput: vi.fn()}, '/usr/bin/sudo')

    // #when
    const result = await run(['/usr/bin/find', '/x'])

    // #then
    expect(result.stderr?.length).toBe(2048)
    expect(result.stderr?.endsWith('END')).toBe(true)
  })

  it('logs a command that took long, with its tool name and duration, but not its arguments', async () => {
    // #given a clock that advances 7 s during the command
    let now = 1000
    const execWithTimeout = vi.fn(async () => {
      now += 7000
      return 0
    })
    const logger = createMockLogger()
    const run = createPrivilegedRun({exec: vi.fn(), execWithTimeout, getExecOutput: vi.fn()}, '/usr/bin/sudo', {
      logger,
      now: () => now,
    })

    // #when
    await run(['/usr/sbin/useradd', '--comment', 'a secret-looking arg', 'fro-bot-sandbox'])

    // #then
    expect(logger.warning).toHaveBeenCalledWith('A privileged command was slow', {tool: 'useradd', elapsedMs: 7000})
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
    expect(result).toEqual({exitCode: 1, stdout: 'hello', stderr: ''})
  })
})
