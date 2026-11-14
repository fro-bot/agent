import type {PrivilegedRun, PrivilegedRunResult, SandboxIdentityDeps} from './sandbox-identity.js'
import type {SandboxNamespaceTools} from './sandbox-namespace.js'
import {describe, expect, it} from 'vitest'
import {findLaunchNamespace, stopLaunchNamespace} from './sandbox-namespace.js'

const TOOLS: SandboxNamespaceTools = {
  pkill: '/usr/bin/pkill',
  pgrep: '/usr/bin/pgrep',
  lsns: '/usr/bin/lsns',
}

const HOST = 4026531832
const VIEW = 4026532399

const NAMESPACE = {id: String(VIEW), member: 101, host: String(HOST)}

interface Proc {
  readonly pid: number
  readonly ppid: number
  ns: number
}

interface ModelOptions {
  /** Processes that survive this many `pkill`s. */
  readonly stubbornPids?: Readonly<Record<number, number>>
  /** `lsns` and `pkill` hang. */
  readonly hang?: boolean
  /** `lsns` exits non-zero. */
  readonly lsnsFails?: boolean
  /** `lsns` exits zero and prints nothing. */
  readonly lsnsEmpty?: boolean
}

/** A model of the host: a process table, and what pgrep, lsns and pkill do to it. A dead process is not in the table. */
function createModel(initial: Proc[], options: ModelOptions = {}) {
  const procs = [...initial]
  const calls: string[][] = []
  const state = {now: 0, survivals: {...options.stubbornPids}}
  const stdout = (lines: readonly string[]): PrivilegedRunResult => ({
    exitCode: lines.length === 0 ? 1 : 0,
    stdout: lines.map(line => `${line}\n`).join(''),
  })
  const rows = (): string[] => {
    const lowest = new Map<number, number>()
    for (const proc of procs.toSorted((a, b) => a.pid - b.pid)) if (!lowest.has(proc.ns)) lowest.set(proc.ns, proc.pid)
    return [...lowest].map(([ns, pid]) => `${String(ns).padStart(12)} ${String(pid).padStart(5)}`)
  }

  const run: PrivilegedRun = async (argv, runOptions) => {
    calls.push([...argv])
    const tool = argv[0]?.split('/').pop()
    if (options.hang === true && (tool === 'lsns' || tool === 'pkill')) {
      state.now += runOptions?.timeoutMs ?? 0
      return {exitCode: null, stdout: '', timedOutAfterMs: runOptions?.timeoutMs ?? 0}
    }
    if (tool === 'pgrep' && argv[1] === '-P') {
      return stdout(procs.filter(proc => proc.ppid === Number(argv[2])).map(proc => String(proc.pid)))
    }
    if (tool === 'lsns') {
      if (options.lsnsFails === true) return {exitCode: 1, stdout: ''}
      if (argv.includes('-p')) {
        const target = procs.find(proc => proc.pid === Number(argv.at(-1)))
        return target === undefined ? {exitCode: 1, stdout: ''} : stdout([String(target.ns)])
      }
      return {
        exitCode: 0,
        stdout: rows()
          .map(row => `${row}\n`)
          .join(''),
      }
    }
    if (tool === 'pkill') {
      const reference = procs.find(proc => proc.pid === Number(argv[argv.indexOf('--ns') + 1]))
      if (reference === undefined) return {exitCode: 3, stdout: ''}
      const members = procs.filter(proc => proc.ns === reference.ns)
      for (const member of members) {
        const remaining = state.survivals[member.pid] ?? 0
        if (remaining > 0) {
          state.survivals[member.pid] = remaining - 1
          continue
        }
        procs.splice(procs.indexOf(member), 1)
      }
      return {exitCode: 0, stdout: ''}
    }
    return {exitCode: 127, stdout: ''}
  }

  const deps: SandboxIdentityDeps = {
    run,
    readText: async () => null,
    now: () => state.now,
    sleep: async ms => {
      state.now += ms
    },
    logger: {debug: () => undefined, info: () => undefined, warning: () => undefined, error: () => undefined},
  }
  return {deps, calls, procs, state}
}

/** sudo (host namespace) with its child, the view's leader, and three more members, one of them reparented to init. */
function launchTree(): Proc[] {
  return [
    {pid: 100, ppid: 1, ns: HOST},
    {pid: 101, ppid: 100, ns: VIEW},
    {pid: 110, ppid: 101, ns: VIEW},
    {pid: 111, ppid: 101, ns: VIEW},
    {pid: 112, ppid: 1, ns: VIEW},
  ]
}

describe('findLaunchNamespace', () => {
  it('finds the namespace of the launcher’s child, which differs from the launcher’s own', async () => {
    // #given sudo in the host namespace with its child in a new one
    const model = createModel(launchTree())

    // #when looked up
    const found = await findLaunchNamespace(100, TOOLS, model.deps, {isAlive: () => true})

    // #then the id and a member pid are returned
    expect(found).toEqual({kind: 'found', namespace: NAMESPACE})
  })

  it('waits until the child has left the host namespace', async () => {
    // #given a child that has not called unshare yet
    const model = createModel(launchTree().map(proc => (proc.pid === 101 ? {...proc, ns: HOST} : proc)))
    let polls = 0
    const deps: SandboxIdentityDeps = {
      ...model.deps,
      sleep: async ms => {
        polls += 1
        const child = model.procs.find(proc => proc.pid === 101)
        if (polls === 2 && child !== undefined) child.ns = VIEW
        await model.deps.sleep?.(ms)
      },
    }

    // #when looked up
    const found = await findLaunchNamespace(100, TOOLS, deps, {isAlive: () => true})

    // #then it did not report the host namespace
    expect(found).toEqual({kind: 'found', namespace: NAMESPACE})
    expect(polls).toBe(2)
  })

  it('reports the launcher gone when it exited before a namespace was seen', async () => {
    // #given a launcher that is already gone
    const model = createModel([])

    // #when looked up
    const found = await findLaunchNamespace(100, TOOLS, model.deps, {isAlive: () => false})

    // #then it says so, not unidentified
    expect(found).toEqual({kind: 'launch-gone'})
  })

  it('reports unidentified when the launcher is alive and no namespace appears within the bound', async () => {
    // #given a launcher whose child never leaves the host namespace
    const model = createModel([
      {pid: 100, ppid: 1, ns: HOST},
      {pid: 101, ppid: 100, ns: HOST},
    ])

    // #when looked up with a short bound
    const found = await findLaunchNamespace(100, TOOLS, model.deps, {isAlive: () => true, boundMs: 500, pollMs: 100})

    // #then it gives up, and never names the host namespace
    expect(found).toEqual({kind: 'unidentified'})
  })
})

describe('stopLaunchNamespace', () => {
  it('kills every member, leaderless and reparented ones included, and confirms the namespace is empty', async () => {
    // #given the leader already dead and three members left
    const model = createModel(launchTree().filter(proc => proc.pid !== 101))

    // #when stopped
    const outcome = await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps)

    // #then it found a living member through the listing, killed by that member, and confirmed by the listing
    expect(outcome).toBe('stopped')
    expect(model.procs.filter(proc => proc.ns === VIEW)).toEqual([])
    expect(model.calls).toContainEqual(['/usr/bin/pkill', '-KILL', '--ns', '110', '--nslist', 'mnt'])
    expect(model.calls.some(argv => argv.includes('101') && argv[0] === '/usr/bin/pkill')).toBe(false)
  })

  it('does not kill anything when the namespace is already gone', async () => {
    // #given only the host's processes
    const model = createModel([{pid: 100, ppid: 1, ns: HOST}])

    // #when stopped
    const outcome = await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps)

    // #then it is confirmed empty with no pkill at all
    expect(outcome).toBe('stopped')
    expect(model.calls.some(argv => argv[0] === '/usr/bin/pkill')).toBe(false)
  })

  it('never signals the host namespace', async () => {
    // #given a namespace id that is somehow the host’s own
    const model = createModel(launchTree())

    // #when asked to stop it
    const outcome = await stopLaunchNamespace({id: String(HOST), member: 100, host: String(HOST)}, TOOLS, model.deps, {
      boundMs: 300,
    })

    // #then it refuses
    expect(outcome).toBe('unconfirmed')
    expect(model.calls.some(argv => argv[0] === '/usr/bin/pkill')).toBe(false)
  })

  it('kills again when a member survives the first round, then confirms', async () => {
    // #given a member that survives one kill
    const model = createModel(launchTree(), {stubbornPids: {111: 1}})

    // #when stopped
    const outcome = await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps)

    // #then it took a second round
    expect(outcome).toBe('stopped')
    expect(model.calls.filter(argv => argv[0] === '/usr/bin/pkill').length).toBeGreaterThanOrEqual(2)
  })

  it('reports unconfirmed when a member remains past the bound', async () => {
    // #given a member that never dies
    const model = createModel(launchTree(), {stubbornPids: {111: 1000}})

    // #when stopped with a short bound
    const outcome = await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps, {
      boundMs: 500,
      pollMs: 100,
    })

    // #then it does not claim success
    expect(outcome).toBe('unconfirmed')
  })

  it('reports unconfirmed when the listing fails, since an empty answer proves nothing', async () => {
    // #given an lsns that errors
    const model = createModel(launchTree(), {lsnsFails: true})

    // #when stopped
    const outcome = await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps, {
      boundMs: 500,
      pollMs: 100,
    })

    // #then it is unconfirmed, and nothing was killed on no evidence
    expect(outcome).toBe('unconfirmed')
    expect(model.calls.some(argv => argv[0] === '/usr/bin/pkill')).toBe(false)
  })

  it('reports unconfirmed when the listing is empty, since the host namespace is always listed', async () => {
    // #given an lsns that succeeds with no rows
    const model = createModel(launchTree(), {lsnsEmpty: true})

    // #when stopped
    const outcome = await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps, {boundMs: 500, pollMs: 100})

    // #then silence is not read as an empty namespace
    expect(outcome).toBe('unconfirmed')
  })

  it('reports unconfirmed when a command hangs past the bound', async () => {
    // #given commands that never return
    const model = createModel(launchTree(), {hang: true})

    // #when stopped with a short bound
    const outcome = await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps, {
      boundMs: 500,
      pollMs: 100,
    })

    // #then it ends unconfirmed instead of hanging
    expect(outcome).toBe('unconfirmed')
  })

  it('never uses a dead leader as the reference of a confirmation', async () => {
    // #given the leader dead and the members alive
    const model = createModel(launchTree().filter(proc => proc.pid !== 101))

    // #when stopped
    await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps)

    // #then no pgrep --ns was used: against a dead reference it answers "no match", which looks like empty
    expect(model.calls.some(argv => argv[0] === '/usr/bin/pgrep' && argv.includes('--ns'))).toBe(false)
  })
})
