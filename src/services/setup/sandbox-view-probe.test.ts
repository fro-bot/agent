import type {LaunchAdmission} from '@fro-bot/runtime'
import type {SandboxViewProbeDeps, ViewProbeInput} from './sandbox-view-probe.js'
import {describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {probeSandboxView} from './sandbox-view-probe.js'

const TOOLS = Object.fromEntries(
  [
    'sudo',
    'unshare',
    'sh',
    'pivot_root',
    'umount',
    'mount',
    'setpriv',
    'lsns',
    'pkill',
    'pgrep',
    'readlink',
    'sleep',
  ].map(name => [name, `/usr/bin/${name}`]),
) as unknown as ViewProbeInput['tools']

const INPUT: ViewProbeInput = {
  tools: TOOLS,
  nodePath: '/opt/node/bin/node',
  builderPath: '/home/runner/work/_actions/fro-bot/agent/v1/dist/sandbox-view.js',
  runnerHome: '/home/runner',
  actionsDir: '/home/runner/work/_actions',
  nobody: {uid: 65_534, gid: 65_534},
}

const FIXTURE = {
  dir: '/home/runner/work/_temp/probe-1',
  newRoot: '/home/runner/work/_temp/probe-1/root',
  gate: '/home/runner/work/_temp/probe-1/gate',
  allowed: '/home/runner/work/_temp/probe-1/allowed',
  sealed: '/home/runner/work/_temp/probe-1/sealed',
}

const NAMESPACE = {id: '4026532399', host: '4026531832'}
const ADMITTED: LaunchAdmission = {kind: 'admitted', namespace: NAMESPACE}
const REFUSED: LaunchAdmission = {kind: 'refused', host: NAMESPACE.host, reason: 'no-id'}

function createDeps(overrides: Partial<SandboxViewProbeDeps> = {}) {
  const launches: {command: string; args: readonly string[]; timeoutMs: number}[] = []
  const deps: SandboxViewProbeDeps = {
    makeFixture: vi.fn(async () => FIXTURE),
    removeFixture: vi.fn(async () => undefined),
    launch: vi.fn<SandboxViewProbeDeps['launch']>(async (command, args, options) => {
      launches.push({command, args, timeoutMs: options.timeoutMs})
      options.onSpawn(500)
      return {pid: 500, exitCode: 0, timedOut: false, stdout: ''}
    }),
    admit: vi.fn(async (): Promise<LaunchAdmission> => ADMITTED),
    stopLaunch: vi.fn(async () => 'stopped' as const),
    isAlive: () => false,
    logger: createMockLogger(),
    ...overrides,
  }
  return {deps, launches}
}

describe('probeSandboxView', () => {
  it('passes when the real chain runs the checks and exits 0', async () => {
    // #given a runner where the probe exits cleanly
    const {deps, launches} = createDeps()

    // #when probed
    const result = await probeSandboxView(INPUT, deps)

    // #then it passes, through sudo and the same chain as the launch, with a short deadline
    expect(result).toEqual({ok: true})
    expect(launches).toHaveLength(1)
    expect(launches[0]?.command).toBe('/usr/bin/sudo')
    expect(launches[0]?.args.slice(0, 3)).toEqual(['-n', '--', '/usr/bin/unshare'])
    expect(launches[0]?.args).toContain(INPUT.builderPath)
    expect(launches[0]?.timeoutMs).toBeLessThanOrEqual(20_000)
    // #and the policy names the fixture only
    const policy = JSON.parse(launches[0]?.args.find(arg => arg.startsWith('{"newRoot"')) ?? '{}') as {
      writable: string[]
      readOnly: string[]
    }
    expect(policy.writable).toEqual([FIXTURE.allowed])
    expect(policy.readOnly).toEqual([])
    // #and the drop is to the unprivileged account
    expect(launches[0]?.args).toContain('--reuid=65534')
    expect(deps.removeFixture).toHaveBeenCalledWith(FIXTURE)
  })

  it.each([
    [10, /not refused/],
    [11, /declared root/],
    [12, /private temp/],
    [13, /unprivileged/],
  ])('fails with one message when the probe exits %i', async (exitCode, message) => {
    // #given a probe script that reports a failed check
    const {deps} = createDeps({
      launch: vi.fn<SandboxViewProbeDeps['launch']>(async (_command, _args, options) => {
        options.onSpawn(500)
        return {pid: 500, exitCode, timedOut: false, stdout: ''}
      }),
    })

    // #when probed
    const result = await probeSandboxView(INPUT, deps)

    // #then it fails and says which check
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toMatch(message)
    expect(deps.removeFixture).toHaveBeenCalled()
  })

  it('names the builder stage when the view could not be built', async () => {
    // #given the builder's failure line
    const {deps} = createDeps({
      launch: vi.fn<SandboxViewProbeDeps['launch']>(async (_command, _args, options) => {
        options.onSpawn(500)
        return {pid: 500, exitCode: 78, timedOut: false, stdout: '{"view":"failed","stage":"verify"}\n'}
      }),
    })

    // #when probed
    const result = await probeSandboxView(INPUT, deps)

    // #then the stage is in the message
    expect(!result.ok && result.message).toContain('stage verify')
  })

  it('fails when the probe cannot be started', async () => {
    // #given no pid: the spawn failed
    const {deps} = createDeps({
      launch: vi.fn<SandboxViewProbeDeps['launch']>(async () => ({
        pid: null,
        exitCode: null,
        timedOut: false,
        stdout: '',
      })),
    })

    // #when probed
    const result = await probeSandboxView(INPUT, deps)

    // #then it fails, and there is nothing to stop
    expect(result.ok).toBe(false)
    expect(deps.stopLaunch).not.toHaveBeenCalled()
  })

  it('fails when the fixture cannot be created, without launching anything', async () => {
    // #given a runner temp that refuses
    const {deps} = createDeps({
      makeFixture: vi.fn(async () => {
        throw new Error('EACCES')
      }),
    })

    // #when probed
    const result = await probeSandboxView(INPUT, deps)

    // #then nothing was launched
    expect(result.ok).toBe(false)
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it('fails on a timeout and confirms the probe’s launch is stopped before saying so', async () => {
    // #given a probe that hangs, with an admitted launch
    const {deps} = createDeps({
      launch: vi.fn<SandboxViewProbeDeps['launch']>(async (_command, _args, options) => {
        options.onSpawn(500)
        return {pid: 500, exitCode: null, timedOut: true, stdout: ''}
      }),
    })

    // #when probed
    const result = await probeSandboxView(INPUT, deps)

    // #then the launch was stopped by its gate directory and admission, and the failure is the timeout
    expect(deps.stopLaunch).toHaveBeenCalledWith(FIXTURE.gate, ADMITTED)
    expect(!result.ok && result.message).toMatch(/timed out/)
  })

  it('fails closed, naming it, when a timed-out probe cannot be confirmed stopped', async () => {
    // #given a launch that cannot be confirmed stopped
    const {deps} = createDeps({
      launch: vi.fn<SandboxViewProbeDeps['launch']>(async (_command, _args, options) => {
        options.onSpawn(500)
        return {pid: 500, exitCode: null, timedOut: true, stdout: ''}
      }),
      stopLaunch: vi.fn(async () => 'unconfirmed' as const),
    })

    // #when probed
    const result = await probeSandboxView(INPUT, deps)

    // #then the message says the probe may still be running, and nothing is deleted under it
    expect(!result.ok && result.message).toMatch(/could not be confirmed stopped/)
    expect(deps.removeFixture).not.toHaveBeenCalled()
  })

  it('fails the preflight and keeps the fixture when the launcher died before its id was captured and the stop cannot confirm', async () => {
    // #given a launcher that was killed (no exit code) at the gate, no id, and a gate shell that cannot be confirmed gone
    const {deps} = createDeps({
      launch: vi.fn<SandboxViewProbeDeps['launch']>(async (_command, _args, options) => {
        options.onSpawn(500)
        return {pid: 500, exitCode: null, timedOut: true, stdout: ''}
      }),
      admit: vi.fn(async () => REFUSED),
      stopLaunch: vi.fn(async () => 'unconfirmed' as const),
      isAlive: () => false,
    })

    // #when probed
    const result = await probeSandboxView(INPUT, deps)

    // #then a dead launcher is not the confirmation: the probe fails and leaves the fixture in place
    expect(deps.stopLaunch).toHaveBeenCalledWith(FIXTURE.gate, REFUSED)
    expect(!result.ok && result.message).toMatch(/could not be confirmed stopped/)
    expect(deps.removeFixture).not.toHaveBeenCalled()
  })

  it('passes a launcher that died at the gate only as the gate failure it is, once the stop confirmed', async () => {
    // #given a gate that gave up (exit 71) with no id captured, and a stop that confirmed
    const {deps} = createDeps({
      launch: vi.fn<SandboxViewProbeDeps['launch']>(async (_command, _args, options) => {
        options.onSpawn(500)
        return {pid: 500, exitCode: 71, timedOut: false, stdout: ''}
      }),
      admit: vi.fn(async () => REFUSED),
    })

    // #when probed
    const result = await probeSandboxView(INPUT, deps)

    // #then it fails with the gate message, and the fixture is removed
    expect(!result.ok && result.message).toMatch(/launch gate/)
    expect(deps.removeFixture).toHaveBeenCalled()
  })

  it('fails when a passing probe left its launcher behind', async () => {
    // #given an exit 0 whose launcher is still alive after the stop confirmed
    const {deps} = createDeps({isAlive: () => true})

    // #when probed
    const result = await probeSandboxView(INPUT, deps, {settleMs: 50})

    // #then the pass is not trusted
    expect(!result.ok && result.message).toMatch(/could not be confirmed stopped/)
  })

  it('confirms a passing probe through the same stop as the teardown, with its gate directory in the chain', async () => {
    // #given a probe that exits 0
    const {deps, launches} = createDeps()

    // #when probed
    const result = await probeSandboxView(INPUT, deps)

    // #then it passed after stopping the launch, and the chain carries the gate directory
    expect(result).toEqual({ok: true})
    expect(deps.stopLaunch).toHaveBeenCalledWith(FIXTURE.gate, ADMITTED)
    expect(launches[0]?.args).toContain(FIXTURE.gate)
    expect(deps.admit).toHaveBeenCalledWith(500, FIXTURE.gate)
  })
})
