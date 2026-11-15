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
    readRootErr: vi.fn(async () => null),
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

  const exiting = (exitCode: number, stderr = ''): SandboxViewProbeDeps['launch'] =>
    vi.fn<SandboxViewProbeDeps['launch']>(async (_command, _args, options) => {
      options.onSpawn(500)
      return {pid: 500, exitCode, timedOut: false, stdout: '', stderr}
    })

  it('names the builder stage, the failed operation and the tool’s error when the view could not be built', async () => {
    // #given the builder's failure line in the gate's error file
    const line =
      '{"view":"failed","stage":"seal","op":"mount -n -o remount,bind,ro /x","detail":"exited non-zero: mount: /x: denied"}'
    const {deps} = createDeps({launch: exiting(78), readRootErr: vi.fn(async () => `${line}\n`)})

    // #when probed
    const result = await probeSandboxView(INPUT, deps)

    // #then the message names the stage and carries the line, on one line
    const message = result.ok ? '' : result.message
    expect(message).toContain('could not be built (stage seal)')
    expect(message).toContain(`[root steps: ${line}]`)
    expect(message).not.toContain('\n')
  })

  it('carries the launcher’s stderr when the root steps wrote nothing, for an exit that is none of the probe’s own', async () => {
    // #given sudo refusing, and no error file
    const {deps} = createDeps({launch: exiting(1, 'sudo: a password is required\n')})

    // #when probed
    const result = await probeSandboxView(INPUT, deps)

    // #then the exit and sudo's text are in the message
    expect(!result.ok && result.message).toBe(
      'the read-only view probe failed (exit 1) [launcher stderr: sudo: a password is required]',
    )
  })

  it('carries both, each as one line cut to a fixed tail', async () => {
    // #given long, multi-line output from both
    const long = `${'a'.repeat(600)}\nlast words\n\tend`
    const {deps} = createDeps({launch: exiting(1, long), readRootErr: vi.fn(async () => long)})

    // #when probed
    const result = await probeSandboxView(INPUT, deps)

    // #then each part is cut to 400 characters plus the ellipsis, and the message has no line break
    const message = result.ok ? '' : result.message
    const parts = [...message.matchAll(/(?:root steps|launcher stderr): (\.\.\.[^;\]]*)/g)].map(match => match[1] ?? '')
    expect(parts).toHaveLength(2)
    for (const part of parts) {
      expect(part.length).toBe(403)
      expect(part.endsWith('last words end')).toBe(true)
    }
    expect(message).not.toMatch(/[\n\t]/)
  })

  it('keeps the stage when the builder’s report is longer than the displayed tail', async () => {
    // #given the longest report the builder prints, after earlier root-step output
    const report = JSON.stringify({
      view: 'failed',
      stage: 'seal',
      op: `mount ${'x'.repeat(150)}`,
      detail: `exited non-zero: ${'e'.repeat(220)}`,
    })
    const {deps} = createDeps({launch: exiting(78), readRootErr: vi.fn(async () => `${'n'.repeat(300)}\n${report}\n`)})

    // #when probed
    const result = await probeSandboxView(INPUT, deps)

    // #then the stage is in the message, and the displayed evidence is still the bounded tail
    const message = result.ok ? '' : result.message
    expect(message).toContain('could not be built (stage seal)')
    expect(message).toMatch(/\[root steps: \.\.\.[^\]]{400}\]/)
    expect(message).not.toContain('"stage":"seal"')
  })

  it('adds the evidence to a failed check of the probe too, and not to a pass', async () => {
    // #given exit 10 with root-step text, and a pass with root-step text
    const failing = createDeps({launch: exiting(10), readRootErr: vi.fn(async () => 'gate: something')})
    const passing = createDeps({readRootErr: vi.fn(async () => 'gate: something')})

    // #when probed
    const failed = await probeSandboxView(INPUT, failing.deps)
    const passed = await probeSandboxView(INPUT, passing.deps)

    // #then
    expect(!failed.ok && failed.message).toContain('not refused [root steps: gate: something]')
    expect(passed).toEqual({ok: true})
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
