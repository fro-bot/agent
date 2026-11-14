import type {PrivilegedRun, SandboxIdentityDeps} from './sandbox-identity.js'
import type {GateDeps, LaunchAdmission, SandboxNamespaceTools} from './sandbox-namespace.js'
import {describe, expect, it} from 'vitest'
import {
  admitLaunch,
  GATE_GO_FILE,
  GATE_NS_FILE,
  parseNamespaceId,
  readGateNamespace,
  selfExcludingPattern,
  stopGateProcesses,
  stopLaunch,
  stopLaunchNamespace,
} from './sandbox-namespace.js'

const TOOLS: SandboxNamespaceTools = {
  pkill: '/usr/bin/pkill',
  pgrep: '/usr/bin/pgrep',
  lsns: '/usr/bin/lsns',
}

const HOST = 4026531832
const VIEW = 4026532399
const GATE_DIR = '/home/runner/work/_temp/fro-bot-view-AbC123/g-XyZ789'

const NAMESPACE = {id: String(VIEW), host: String(HOST)}

interface Proc {
  readonly pid: number
  readonly ppid: number
  ns: number
  /** The command line, as `pgrep -f` sees it. */
  readonly cmd?: string
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
  /** `lsns` prints one row that is not two numbers, besides the real ones. */
  readonly lsnsGarbageRow?: boolean
  /** `lsns` leaves the host namespace out of the listing. */
  readonly lsnsWithoutHost?: boolean
  /** `sudo` fails to run anything: exit 1, no output. */
  readonly sudoBroken?: boolean
}

/**
 * A model of the host: a process table, and what pgrep, lsns and pkill do to it. A dead process is not in the table. Each
 * call also has its own `sudo -n -- <argv>` parent in the table for the length of the call, as on a real runner.
 */
function createModel(initial: Proc[], options: ModelOptions = {}) {
  // init is always there, in the runner's own namespace, so the listing always names the host.
  const procs: Proc[] = [{pid: 1, ppid: 0, ns: HOST, cmd: 'init'}, ...initial]
  const calls: string[][] = []
  const state = {now: 0, survivals: {...options.stubbornPids}}
  const rows = (): string[] => {
    const lowest = new Map<number, number>()
    for (const proc of procs.toSorted((a, b) => a.pid - b.pid)) if (!lowest.has(proc.ns)) lowest.set(proc.ns, proc.pid)
    const lines = [...lowest]
      .filter(([ns]) => !(options.lsnsWithoutHost === true && ns === HOST))
      .map(([ns, pid]) => `${String(ns).padStart(12)} ${String(pid).padStart(5)}`)
    return options.lsnsGarbageRow === true ? [...lines, '   <unreadable>'] : lines
  }

  const kill = (members: Proc[]): void => {
    for (const member of members) {
      const remaining = state.survivals[member.pid] ?? 0
      if (remaining > 0) {
        state.survivals[member.pid] = remaining - 1
        continue
      }
      procs.splice(procs.indexOf(member), 1)
    }
  }

  const run: PrivilegedRun = async (argv, runOptions) => {
    calls.push([...argv])
    const tool = argv[0]?.split('/').pop()
    if (options.sudoBroken === true) return {exitCode: 1, stdout: ''}
    if (options.hang === true) {
      state.now += runOptions?.timeoutMs ?? 0
      return {exitCode: null, stdout: '', timedOutAfterMs: runOptions?.timeoutMs ?? 0}
    }
    if (tool === 'lsns') {
      if (options.lsnsFails === true) return {exitCode: 1, stdout: ''}
      if (options.lsnsEmpty === true) return {exitCode: 0, stdout: ''}
      return {
        exitCode: 0,
        stdout: rows()
          .map(row => `${row}\n`)
          .join(''),
      }
    }
    if (tool === 'pkill' && argv.includes('--ns')) {
      const reference = procs.find(proc => proc.pid === Number(argv[argv.indexOf('--ns') + 1]))
      if (reference === undefined) return {exitCode: 3, stdout: ''}
      kill(procs.filter(proc => proc.ns === reference.ns))
      return {exitCode: 0, stdout: ''}
    }
    if ((tool === 'pkill' || tool === 'pgrep') && argv.includes('-f')) {
      const pattern = new RegExp(argv.at(-1) ?? '')
      // The `sudo` that runs this very command is in the table too, with the pattern in its argv.
      const sudoParent = `sudo -n -- ${argv.join(' ')}`
      const matching = procs.filter(proc => proc.cmd !== undefined && pattern.test(proc.cmd))
      const matchesSudo = pattern.test(sudoParent)
      if (tool === 'pkill') {
        kill(matching)
        return {exitCode: matching.length > 0 || matchesSudo ? 0 : 1, stdout: ''}
      }
      const count = matching.length + (matchesSudo ? 1 : 0)
      return {exitCode: count > 0 ? 0 : 1, stdout: `${count}\n`}
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

/** The view's members after the go-ahead: the chain has exec'd past the gate, so no command line carries the gate dir. */
function runningTree(): Proc[] {
  return [
    {pid: 100, ppid: 1, ns: HOST, cmd: `sudo -n -- unshare ${GATE_DIR}`},
    {pid: 101, ppid: 100, ns: VIEW, cmd: 'node builder'},
    {pid: 110, ppid: 101, ns: VIEW, cmd: 'opencode serve'},
    {pid: 111, ppid: 101, ns: VIEW, cmd: 'sleep 7781'},
    {pid: 112, ppid: 1, ns: VIEW, cmd: 'sleep 7782'},
  ]
}

/** What a launch looks like while the gate waits: the launcher and the gate shell in the new namespace. */
function gateTree(): Proc[] {
  return [
    {
      pid: 100,
      ppid: 1,
      ns: HOST,
      cmd: `sudo -n -- /usr/bin/unshare --mount -- /usr/bin/sh -c SCRIPT sh ${GATE_DIR} 200`,
    },
    {pid: 101, ppid: 100, ns: VIEW, cmd: `/usr/bin/sh -c SCRIPT sh /usr/bin/readlink /usr/bin/sleep ${GATE_DIR} 200`},
    {pid: 102, ppid: 1, ns: HOST, cmd: 'sleep 1000'},
  ]
}

interface FileModel {
  readonly deps: GateDeps
  readonly files: Map<string, string>
  readonly written: string[]
  readonly reads: () => number
}

function createFiles(options: {
  readonly initial?: Record<string, string>
  readonly host?: string | null
  readonly alive?: (pid: number) => boolean
  /** Called on each read of the ns file, to let a test change the world between polls. */
  readonly onRead?: (reads: number, files: Map<string, string>) => void
  readonly writeFails?: boolean
}): FileModel {
  const files = new Map(Object.entries(options.initial ?? {}))
  const written: string[] = []
  let reads = 0
  let now = 0
  return {
    files,
    written,
    reads: () => reads,
    deps: {
      readText: async file => {
        if (file.endsWith(`/${GATE_NS_FILE}`)) {
          reads += 1
          options.onRead?.(reads, files)
        }
        return files.get(file) ?? null
      },
      writeText: async (file, content) => {
        if (options.writeFails === true) throw new Error('EACCES')
        written.push(file)
        files.set(file, content)
      },
      readHostNamespace: async () => (options.host === undefined ? `mnt:[${HOST}]` : options.host),
      isAlive: options.alive ?? (() => true),
      now: () => now,
      sleep: async ms => {
        now += ms
      },
    },
  }
}

const NS_FILE = `${GATE_DIR}/${GATE_NS_FILE}`
const GO_FILE = `${GATE_DIR}/${GATE_GO_FILE}`
const open = () => false

describe('parseNamespaceId', () => {
  it.each([
    ['mnt:[4026532399]', '4026532399'],
    ['mnt:[4026532399]\n', '4026532399'],
    [' mnt:[1] ', '1'],
  ])('reads %j', (text, id) => {
    // #given a link text
    // #then the id is the inode number
    expect(parseNamespaceId(text)).toBe(id)
  })

  it.each([
    null,
    '',
    'pid:[4026532399]',
    'mnt:[]',
    'mnt:[12ab]',
    '4026532399',
    'mnt:[1]\nmnt:[2]',
    'mnt:[123456789012345678901]',
  ])('refuses %j', text => {
    // #given something else
    // #then there is no id
    expect(parseNamespaceId(text)).toBeNull()
  })
})

describe('admitLaunch', () => {
  it('reads the id, validates it and writes a go-ahead that names that id', async () => {
    // #given a gate that has written its namespace id
    const model = createFiles({initial: {[NS_FILE]: `mnt:[${VIEW}]\n`}})

    // #when the launch is admitted
    const admission = await admitLaunch(100, GATE_DIR, model.deps, {isClosed: open})

    // #then the go-ahead exists and carries the id, in the gate directory only
    expect(admission).toEqual({kind: 'admitted', namespace: NAMESPACE})
    expect(model.written).toEqual([GO_FILE])
    expect(model.files.get(GO_FILE)).toBe(`mnt:[${VIEW}]\n`)
  })

  it('waits for the id to appear, and treats a half-written empty file as not yet', async () => {
    // #given a file that is empty on the first poll and complete on the third
    const model = createFiles({
      initial: {[NS_FILE]: ''},
      onRead: (reads, files) => {
        if (reads === 3) files.set(NS_FILE, `mnt:[${VIEW}]\n`)
      },
    })

    // #when admitted
    const admission = await admitLaunch(100, GATE_DIR, model.deps, {isClosed: open})

    // #then it went on polling and then admitted
    expect(admission.kind).toBe('admitted')
    expect(model.reads()).toBe(3)
  })

  it('gives no go-ahead when the id file never appears within the bound', async () => {
    // #given a gate that never reports
    const model = createFiles({})

    // #when admitted with a short bound
    const admission = await admitLaunch(100, GATE_DIR, model.deps, {isClosed: open, boundMs: 200, pollMs: 50})

    // #then it is refused and nothing was written
    expect(admission).toEqual({kind: 'refused', host: String(HOST), reason: 'no-id'})
    expect(model.written).toEqual([])
  })

  it('gives no go-ahead when the launcher is already gone and no id was written', async () => {
    // #given a dead launcher and no file
    const model = createFiles({alive: () => false})

    // #when admitted
    const admission = await admitLaunch(100, GATE_DIR, model.deps, {isClosed: open})

    // #then
    expect(admission).toEqual({kind: 'refused', host: String(HOST), reason: 'no-id'})
    expect(model.written).toEqual([])
  })

  it.each(['garbage', 'pid:[4026532399]', 'mnt:[12x]', `mnt:[${VIEW}]\nextra`])(
    'gives no go-ahead for a malformed id file %j',
    async content => {
      // #given a file that is not one namespace id
      const model = createFiles({initial: {[NS_FILE]: content}})

      // #when admitted
      const admission = await admitLaunch(100, GATE_DIR, model.deps, {isClosed: open})

      // #then
      expect(admission).toEqual({kind: 'refused', host: String(HOST), reason: 'invalid-id'})
      expect(model.written).toEqual([])
    },
  )

  it('gives no go-ahead when the id is the runner’s own namespace', async () => {
    // #given a gate that reports the host namespace (unshare did not happen)
    const model = createFiles({initial: {[NS_FILE]: `mnt:[${HOST}]\n`}})

    // #when admitted
    const admission = await admitLaunch(100, GATE_DIR, model.deps, {isClosed: open})

    // #then
    expect(admission).toEqual({kind: 'refused', host: String(HOST), reason: 'host-id'})
    expect(model.written).toEqual([])
  })

  it('gives no go-ahead when the runner’s own namespace cannot be read', async () => {
    // #given an unreadable host link
    const model = createFiles({initial: {[NS_FILE]: `mnt:[${VIEW}]\n`}, host: null})

    // #when admitted
    const admission = await admitLaunch(100, GATE_DIR, model.deps, {isClosed: open})

    // #then without a host id there is nothing to compare against
    expect(admission).toEqual({kind: 'refused', host: null, reason: 'host-unreadable'})
    expect(model.written).toEqual([])
  })

  it('gives no go-ahead once the teardown has begun, and still reports the id it saw', async () => {
    // #given a valid id and a teardown that began
    const model = createFiles({initial: {[NS_FILE]: `mnt:[${VIEW}]\n`}})

    // #when admitted
    const admission = await admitLaunch(100, GATE_DIR, model.deps, {isClosed: () => true})

    // #then the id is kept for the stop, and no go-ahead exists
    expect(admission).toEqual({kind: 'held', namespace: NAMESPACE, reason: 'closed'})
    expect(model.written).toEqual([])
  })

  it('gives no go-ahead when the teardown begins while it waits for the id', async () => {
    // #given a gate that has not reported, and a teardown that begins after the first poll
    let closed = false
    const model = createFiles({
      onRead: reads => {
        if (reads === 2) closed = true
      },
    })

    // #when admitted
    const admission = await admitLaunch(100, GATE_DIR, model.deps, {isClosed: () => closed})

    // #then
    expect(admission).toEqual({kind: 'refused', host: String(HOST), reason: 'closed'})
    expect(model.written).toEqual([])
  })

  it('gives no go-ahead to a launcher that is already dead, and keeps the id it saw', async () => {
    // #given an id file and a dead launcher
    const model = createFiles({initial: {[NS_FILE]: `mnt:[${VIEW}]\n`}, alive: () => false})

    // #when admitted
    const admission = await admitLaunch(100, GATE_DIR, model.deps, {isClosed: open})

    // #then
    expect(admission).toEqual({kind: 'held', namespace: NAMESPACE, reason: 'launcher-gone'})
    expect(model.written).toEqual([])
  })

  it('holds the launch when the go-ahead cannot be written', async () => {
    // #given a gate directory the runner cannot write
    const model = createFiles({initial: {[NS_FILE]: `mnt:[${VIEW}]\n`}, writeFails: true})

    // #when admitted
    const admission = await admitLaunch(100, GATE_DIR, model.deps, {isClosed: open})

    // #then the id is kept for the stop
    expect(admission.kind).toBe('held')
  })
})

describe('readGateNamespace', () => {
  it('tells apart an absent, empty, invalid, host and captured file', async () => {
    // #given the five states of the file
    const read = async (content: string | undefined) =>
      readGateNamespace(
        GATE_DIR,
        String(HOST),
        createFiles(content === undefined ? {} : {initial: {[NS_FILE]: content}}).deps,
      )

    // #then each is told apart
    expect(await read(undefined)).toEqual({kind: 'absent'})
    expect(await read('')).toEqual({kind: 'absent'})
    expect(await read('nope')).toEqual({kind: 'invalid'})
    expect(await read(`mnt:[${HOST}]`)).toEqual({kind: 'host'})
    expect(await read(`mnt:[${VIEW}]`)).toEqual({kind: 'captured', namespace: NAMESPACE})
  })
})

describe('stopLaunchNamespace', () => {
  it('kills every member, leaderless and reparented ones included, and confirms the namespace is empty', async () => {
    // #given the leader already dead and members left
    const model = createModel(runningTree().filter(proc => proc.pid !== 101))

    // #when stopped
    const outcome = await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps)

    // #then it killed by the lowest living member and confirmed by the listing
    expect(outcome).toBe('stopped')
    expect(model.procs.filter(proc => proc.ns === VIEW)).toEqual([])
    expect(model.calls).toContainEqual(['/usr/bin/pkill', '-KILL', '--ns', '110', '--nslist', 'mnt'])
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
    const model = createModel(runningTree())

    // #when asked to stop it
    const outcome = await stopLaunchNamespace({id: String(HOST), host: String(HOST)}, TOOLS, model.deps, {boundMs: 300})

    // #then it refuses
    expect(outcome).toBe('unconfirmed')
    expect(model.calls.some(argv => argv[0] === '/usr/bin/pkill')).toBe(false)
  })

  it('kills again when a member survives the first round, then confirms', async () => {
    // #given a member that survives one kill
    const model = createModel(runningTree(), {stubbornPids: {111: 1}})

    // #when stopped
    const outcome = await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps)

    // #then it took a second round
    expect(outcome).toBe('stopped')
    expect(model.calls.filter(argv => argv[0] === '/usr/bin/pkill').length).toBeGreaterThanOrEqual(2)
  })

  it('reports unconfirmed when a member remains past the bound', async () => {
    // #given a member that never dies
    const model = createModel(runningTree(), {stubbornPids: {111: 1000}})

    // #when stopped with a short bound
    const outcome = await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps, {boundMs: 500, pollMs: 100})

    // #then it does not claim success
    expect(outcome).toBe('unconfirmed')
  })

  it('reports unconfirmed when the listing fails, since an empty answer proves nothing', async () => {
    // #given an lsns that errors
    const model = createModel(runningTree(), {lsnsFails: true})

    // #when stopped
    const outcome = await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps, {boundMs: 500, pollMs: 100})

    // #then it is unconfirmed, and nothing was killed on no evidence
    expect(outcome).toBe('unconfirmed')
    expect(model.calls.some(argv => argv[0] === '/usr/bin/pkill')).toBe(false)
  })

  it('reports unconfirmed when the listing is empty, since the host namespace is always listed', async () => {
    // #given an lsns that succeeds with no rows
    const model = createModel(runningTree(), {lsnsEmpty: true})

    // #when stopped
    const outcome = await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps, {boundMs: 500, pollMs: 100})

    // #then silence is not read as an empty namespace
    expect(outcome).toBe('unconfirmed')
  })

  it('rejects a listing with one row it cannot read, even though the other rows parse and the id is absent', async () => {
    // #given a namespace that is gone, and a listing that has one unreadable row besides the host's
    const model = createModel([{pid: 100, ppid: 1, ns: HOST}], {lsnsGarbageRow: true})

    // #when stopped
    const outcome = await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps, {boundMs: 500, pollMs: 100})

    // #then the unreadable row could have been the launch's: not confirmed
    expect(outcome).toBe('unconfirmed')
  })

  it('rejects a listing that does not contain the host namespace, whatever else it lists', async () => {
    // #given a listing cut short: the launch id is absent and so is the host
    const model = createModel(
      runningTree().filter(proc => proc.ns === HOST || proc.pid === 999),
      {lsnsWithoutHost: true},
    )

    // #when stopped
    const outcome = await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps, {boundMs: 500, pollMs: 100})

    // #then absence from an incomplete listing is not confirmation
    expect(outcome).toBe('unconfirmed')
  })

  it('reports unconfirmed when a command hangs past the bound', async () => {
    // #given commands that never return
    const model = createModel(runningTree(), {hang: true})

    // #when stopped with a short bound
    const outcome = await stopLaunchNamespace(NAMESPACE, TOOLS, model.deps, {boundMs: 500, pollMs: 100})

    // #then it ends unconfirmed instead of hanging
    expect(outcome).toBe('unconfirmed')
  })
})

describe('selfExcludingPattern', () => {
  it('matches the text and does not match itself', () => {
    // #given the pattern for a gate directory
    const pattern = new RegExp(selfExcludingPattern(GATE_DIR))

    // #then it finds the directory in a command line and not in its own text
    expect(pattern.test(`sh -c SCRIPT sh ${GATE_DIR} 200`)).toBe(true)
    expect(pattern.test(`sudo -n -- pkill -KILL -f -- ${selfExcludingPattern(GATE_DIR)}`)).toBe(false)
  })

  it('treats regular expression characters of the path as literals', () => {
    // #given a path with dots, plus and brackets
    const text = '/tmp/a.b+c(d)[e]'
    const pattern = new RegExp(selfExcludingPattern(text))

    // #then only the literal text matches
    expect(pattern.test(`x ${text} y`)).toBe(true)
    expect(pattern.test('/tmp/aXb+c(d)[e]')).toBe(false)
  })
})

describe('stopGateProcesses', () => {
  it('kills the gate shell and the launcher by their command line and confirms none is left', async () => {
    // #given a launcher and a gate shell, and an unrelated process
    const model = createModel(gateTree())

    // #when stopped
    const outcome = await stopGateProcesses(GATE_DIR, TOOLS, model.deps)

    // #then both are gone and the unrelated one is not
    expect(outcome).toBe('stopped')
    expect(model.procs.map(proc => proc.pid)).toEqual([1, 102])
  })

  it('does not count the sudo that runs the check as a process of the launch', async () => {
    // #given nothing at the gate
    const model = createModel([{pid: 102, ppid: 1, ns: HOST, cmd: 'sleep 1000'}])

    // #when stopped
    const outcome = await stopGateProcesses(GATE_DIR, TOOLS, model.deps)

    // #then the count is zero although the sudo argv carries the pattern text
    expect(outcome).toBe('stopped')
  })

  it('reports unconfirmed when a gate process survives past the bound', async () => {
    // #given a gate shell that cannot be killed
    const model = createModel(gateTree(), {stubbornPids: {101: 1000}})

    // #when stopped with a short bound
    const outcome = await stopGateProcesses(GATE_DIR, TOOLS, model.deps, {boundMs: 500, pollMs: 100})

    // #then
    expect(outcome).toBe('unconfirmed')
  })

  it('reports unconfirmed when sudo fails, since exit 1 with no count is not a count of zero', async () => {
    // #given a sudo that exits 1 for everything
    const model = createModel(gateTree(), {sudoBroken: true})

    // #when stopped with a short bound
    const outcome = await stopGateProcesses(GATE_DIR, TOOLS, model.deps, {boundMs: 500, pollMs: 100})

    // #then
    expect(outcome).toBe('unconfirmed')
  })
})

describe('stopLaunch: what teardown does for each state of a launch', () => {
  const refused = (host: string | null = String(HOST)): LaunchAdmission => ({
    kind: 'refused',
    host,
    reason: 'no-id',
  })
  const admitted: LaunchAdmission = {kind: 'admitted', namespace: NAMESPACE}
  const noFiles = createFiles({}).deps

  it('id captured, launcher alive: stops the namespace', async () => {
    // #given a running launch
    const model = createModel(runningTree())

    // #when stopped
    const outcome = await stopLaunch({gateDir: GATE_DIR, admission: admitted}, TOOLS, model.deps, noFiles)

    // #then every member of the namespace is gone
    expect(outcome).toBe('stopped')
    expect(model.procs.filter(proc => proc.ns === VIEW)).toEqual([])
  })

  it('id captured, launcher dead: stops the namespace all the same', async () => {
    // #given the launcher killed by a group kill, its root children still running
    const model = createModel(runningTree().filter(proc => proc.pid !== 100))

    // #when stopped
    const outcome = await stopLaunch({gateDir: GATE_DIR, admission: admitted}, TOOLS, model.deps, noFiles)

    // #then the dead launcher was no confirmation: the orphans were killed
    expect(outcome).toBe('stopped')
    expect(model.procs.filter(proc => proc.ns === VIEW)).toEqual([])
    expect(model.calls.some(argv => argv[0] === '/usr/bin/pkill')).toBe(true)
  })

  it('id captured, launcher dead, a member that will not die: unconfirmed', async () => {
    // #given an orphan that survives
    const model = createModel(
      runningTree().filter(proc => proc.pid !== 100),
      {stubbornPids: {110: 1000}},
    )

    // #when stopped
    const outcome = await stopLaunch({gateDir: GATE_DIR, admission: admitted}, TOOLS, model.deps, noFiles, {
      boundMs: 500,
      pollMs: 100,
    })

    // #then
    expect(outcome).toBe('unconfirmed')
  })

  it('id held back (teardown began), launcher alive: stops the namespace the gate is in', async () => {
    // #given a gate shell in the new namespace
    const model = createModel(gateTree())
    const held: LaunchAdmission = {kind: 'held', namespace: NAMESPACE, reason: 'closed'}

    // #when stopped
    const outcome = await stopLaunch({gateDir: GATE_DIR, admission: held}, TOOLS, model.deps, noFiles)

    // #then the gate shell, a member of that namespace, was killed
    expect(outcome).toBe('stopped')
    expect(model.procs.some(proc => proc.pid === 101)).toBe(false)
  })

  it('no id captured, launcher dead, the gate shell still alive in its namespace: kills it by the gate directory', async () => {
    // #given a launcher killed before the id was read, and its root child orphaned at the gate
    const model = createModel(gateTree().filter(proc => proc.pid !== 100))

    // #when stopped
    const outcome = await stopLaunch({gateDir: GATE_DIR, admission: refused()}, TOOLS, model.deps, noFiles)

    // #then the orphan is gone and the result says stopped only because it was killed and counted
    expect(outcome).toBe('stopped')
    expect(model.procs.filter(proc => proc.ns === VIEW)).toEqual([])
    expect(model.calls.some(argv => argv[0] === '/usr/bin/pgrep' && argv.includes('-c'))).toBe(true)
  })

  it('no id captured, launcher dead, the orphan cannot be killed: unconfirmed', async () => {
    // #given an orphan that survives
    const model = createModel(
      gateTree().filter(proc => proc.pid !== 100),
      {stubbornPids: {101: 1000}},
    )

    // #when stopped
    const outcome = await stopLaunch({gateDir: GATE_DIR, admission: refused()}, TOOLS, model.deps, noFiles, {
      boundMs: 500,
      pollMs: 100,
    })

    // #then a dead launcher did not make it stopped
    expect(outcome).toBe('unconfirmed')
  })

  it('no id captured, launcher alive: kills the launcher and the gate shell by the gate directory', async () => {
    // #given a gate that never reported
    const model = createModel(gateTree())

    // #when stopped
    const outcome = await stopLaunch({gateDir: GATE_DIR, admission: refused()}, TOOLS, model.deps, noFiles)

    // #then
    expect(outcome).toBe('stopped')
    expect(model.procs.map(proc => proc.pid)).toEqual([1, 102])
  })

  it('no id captured at admission but the file is there at teardown: stops the namespace it names', async () => {
    // #given an id that appeared after admission gave up
    const model = createModel(gateTree())
    const files = createFiles({initial: {[NS_FILE]: `mnt:[${VIEW}]\n`}})

    // #when stopped
    const outcome = await stopLaunch({gateDir: GATE_DIR, admission: refused()}, TOOLS, model.deps, files.deps)

    // #then it went by the namespace, not by the command line
    expect(outcome).toBe('stopped')
    expect(model.calls.some(argv => argv.includes('--ns'))).toBe(true)
    expect(model.calls.some(argv => argv.includes('-f'))).toBe(false)
  })

  it.each([
    ['malformed', 'garbage'],
    ['the host id', `mnt:[${HOST}]`],
  ])('no usable id (%s): kills by the gate directory and never signals a namespace', async (_label, content) => {
    // #given an id file that cannot be trusted
    const model = createModel(gateTree())
    const files = createFiles({initial: {[NS_FILE]: content}})

    // #when stopped
    const outcome = await stopLaunch({gateDir: GATE_DIR, admission: refused()}, TOOLS, model.deps, files.deps)

    // #then
    expect(outcome).toBe('stopped')
    expect(model.calls.some(argv => argv.includes('--ns'))).toBe(false)
  })

  it('no id captured and the runner’s own namespace unknown: still kills by the gate directory', async () => {
    // #given a refused admission without a host id
    const model = createModel(gateTree())

    // #when stopped
    const outcome = await stopLaunch({gateDir: GATE_DIR, admission: refused(null)}, TOOLS, model.deps, noFiles)

    // #then
    expect(outcome).toBe('stopped')
    expect(model.procs.map(proc => proc.pid)).toEqual([1, 102])
  })
})
