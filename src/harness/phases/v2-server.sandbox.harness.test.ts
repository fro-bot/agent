import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  aclLines,
  aclText,
  changedFilesSince,
  controlCoversMatrix,
  copyBundleWithImports,
  describeNamespaceMembers,
  describeOutOfRangeSecretEnv,
  findPaths,
  inspectOutput,
  matrixDirectories,
  matrixSentinels,
  mountNamespaceIds,
  newLaunchNamespaces,
  parseRows,
  pgrepOutput,
  PRELUDE,
  runInspection,
  runnerFirstLine,
  secretEnvRangeReport,
  startPlainScriptedSession,
  writeMatrixProbe,
  writeWorksProbe,
  type InspectionResult,
  type InspectionRunner,
} from './v2-server.sandbox.harness.js'

const noFs = {isDirectory: () => true, isWritable: () => true, subdirectories: () => [] as string[]}

describe('matrixDirectories', () => {
  it('covers every absolute PATH entry, the extra directories and the tool cache with its first subdirectory, once each', () => {
    // #given a PATH with a relative entry, an empty one and a duplicate
    const directories = matrixDirectories(
      {
        pathEnv: '/usr/local/bin:relative:/usr/bin::/usr/local/bin/',
        toolCache: '/opt/hostedtoolcache',
        extra: ['/opt', '/usr/share'],
      },
      {...noFs, subdirectories: () => ['CodeQL', 'node']},
    )

    // #then
    expect(directories).toEqual([
      '/usr/local/bin',
      '/usr/bin',
      '/opt',
      '/usr/share',
      '/opt/hostedtoolcache',
      '/opt/hostedtoolcache/CodeQL',
    ])
  })

  it('drops PATH entries that are not plain absolute paths, since each one is embedded in a shell probe', () => {
    // #given PATH entries carrying shell metacharacters, quotes, spaces or parent segments
    const directories = matrixDirectories(
      {
        pathEnv: "/usr/bin:/tmp/$(id):/tmp/a;b:/tmp/it's:/tmp/../etc:/tmp/a b:/usr/local/bin",
        toolCache: '/opt/hostedtoolcache',
        extra: [],
      },
      noFs,
    )

    // #then only the plain paths remain
    expect(directories).toEqual(['/usr/bin', '/usr/local/bin', '/opt/hostedtoolcache'])
  })

  it('leaves out a directory the runner cannot write, and one that is missing', () => {
    // #given /usr/bin is not writable and /missing is not a directory
    const directories = matrixDirectories(
      {pathEnv: '/usr/local/bin:/usr/bin:/missing', toolCache: '/opt/hostedtoolcache', extra: []},
      {
        isDirectory: target => target !== '/missing',
        isWritable: target => target !== '/usr/bin',
        subdirectories: () => [],
      },
    )

    // #then only what the runner could write is in the matrix
    expect(directories).toEqual(['/usr/local/bin', '/opt/hostedtoolcache'])
  })

  it('picks the first tool cache subdirectory the runner can write', () => {
    // #given a read-only first entry
    const directories = matrixDirectories(
      {pathEnv: undefined, toolCache: '/cache', extra: []},
      {...noFs, isWritable: target => target !== '/cache/a', subdirectories: () => ['a', 'b']},
    )

    // #then
    expect(directories).toEqual(['/cache', '/cache/b'])
  })
})

function run(dir: string): string {
  const probe = writeMatrixProbe('wm_0', dir, '1', os.userInfo().uid)
  const result = spawnSync('bash', ['-c', PRELUDE + probe.cmd], {encoding: 'utf8'})
  return result.stdout + result.stderr
}

const asRoot = os.userInfo().uid === 0

describe('the write matrix probe, run for real on this machine', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.chmodSync(dir, 0o755)
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  function fixture(): {readonly dir: string; readonly sentinels: readonly string[]} {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-'))
    dirs.push(dir)
    const sentinels = matrixSentinels(dir, '1')
    for (const file of sentinels) fs.writeFileSync(file, 'sentinel', {mode: 0o666})
    return {dir, sentinels}
  }

  it('reports OPEN with all four operations in a directory the actor can write, and cleans up after itself', () => {
    // #given a writable directory with the runner's sentinels in it
    const {dir, sentinels} = fixture()

    // #when run as the runner (the control)
    const rows = parseRows(run(dir))

    // #then every operation worked and the control covers the matrix
    expect(controlCoversMatrix(rows.get('wm_0'))).toBe(true)
    // #and the append sentinel is back under its name, the new file is gone, and the unlinked one is gone
    expect(fs.existsSync(sentinels[0] ?? '')).toBe(true)
    expect(fs.existsSync(`${sentinels[0]}.moved`)).toBe(false)
    expect(fs.readdirSync(dir).some(name => name.includes('-new-'))).toBe(false)
    expect(fs.existsSync(sentinels[1] ?? '')).toBe(false)
    // #and the sandbox's sentinels were not touched
    expect(fs.readFileSync(sentinels[2] ?? '', 'utf8')).toBe('sentinel')
    expect(fs.existsSync(sentinels[3] ?? '')).toBe(true)
  })

  // Root bypasses permission bits, so these two cannot show a refusal there.
  it.skipIf(asRoot)('reports BLOCKED when nothing can be written', () => {
    // #given a directory and files nobody may change (run as the sandbox actor: another uid than the runner's)
    const {dir, sentinels} = fixture()
    for (const file of sentinels) fs.chmodSync(file, 0o444)
    fs.chmodSync(dir, 0o555)
    const probe = writeMatrixProbe('wm_0', dir, '1', os.userInfo().uid + 1)

    // #when run
    const result = spawnSync('bash', ['-c', PRELUDE + probe.cmd], {encoding: 'utf8'})

    // #then no operation succeeded
    expect(parseRows(result.stdout).get('wm_0')).toEqual([
      {status: 'BLOCKED', evidence: 'no write operation succeeded'},
    ])
  })

  it('does not call a control complete unless it managed all four operations', () => {
    // #given a control row that only created
    // #then it is not enough
    expect(controlCoversMatrix([{status: 'OPEN', evidence: 'succeeded: create'}])).toBe(false)
    expect(controlCoversMatrix([{status: 'BLOCKED', evidence: 'no write operation succeeded'}])).toBe(false)
    expect(controlCoversMatrix(undefined)).toBe(false)
  })
})

describe('writeWorksProbe', () => {
  it.skipIf(asRoot)('reports WORKS for a writable directory and FAILED for one that is not', () => {
    // #given a writable and a read-only directory
    const writable = fs.mkdtempSync(path.join(os.tmpdir(), 'works-'))
    const sealed = fs.mkdtempSync(path.join(os.tmpdir(), 'works-ro-'))
    fs.chmodSync(sealed, 0o555)
    try {
      // #when each is probed
      const good = spawnSync('bash', ['-c', PRELUDE + writeWorksProbe('w_ok', `'${writable}'`).cmd], {encoding: 'utf8'})
      const bad = spawnSync('bash', ['-c', PRELUDE + writeWorksProbe('w_ro', `'${sealed}'`).cmd], {encoding: 'utf8'})

      // #then
      expect(parseRows(good.stdout).get('w_ok')?.[0]?.status).toBe('WORKS')
      expect(parseRows(bad.stdout).get('w_ro')?.[0]?.status).toBe('FAILED')
      expect(fs.readdirSync(writable)).toEqual([])
    } finally {
      fs.chmodSync(sealed, 0o755)
      fs.rmSync(writable, {recursive: true, force: true})
      fs.rmSync(sealed, {recursive: true, force: true})
    }
  })
})

describe('copyBundleWithImports', () => {
  const dirs: string[] = []
  const temp = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true})
  })

  it('copies the entry and every file it imports, however deep, in minified and plain syntax, and nothing else', () => {
    // #given an entry that imports a chunk, which imports a second chunk, which imports back; and an unrelated file
    const source = temp()
    const target = temp()
    fs.writeFileSync(path.join(source, 'entry.js'), 'import{a as e}from"./one-AAA.js";import"./side.js";export{};')
    fs.writeFileSync(
      path.join(source, 'one-AAA.js'),
      "import {b} from './two-BBB.js'\nexport const a = await import('./three.js')",
    )
    fs.writeFileSync(path.join(source, 'two-BBB.js'), 'import{a}from"./one-AAA.js";export const b=1')
    for (const name of ['side.js', 'three.js', 'other.js']) fs.writeFileSync(path.join(source, name), 'export {}')

    // #when copied
    const copied = copyBundleWithImports(source, target, 'entry.js')

    // #then the whole graph is there and the unrelated file is not
    expect(copied.toSorted()).toEqual(['entry.js', 'one-AAA.js', 'side.js', 'three.js', 'two-BBB.js'])
    expect(fs.readdirSync(target).toSorted()).toEqual(['entry.js', 'one-AAA.js', 'side.js', 'three.js', 'two-BBB.js'])
  })

  it('fails loudly, naming the file, when an import is missing from the source', () => {
    // #given an import of a chunk that is not there
    const source = temp()
    fs.writeFileSync(path.join(source, 'entry.js'), 'import{a}from"./gone-XYZ.js";')

    // #then it names the missing chunk instead of leaving a root process to fail on it
    expect(() => copyBundleWithImports(source, temp(), 'entry.js')).toThrow('gone-XYZ.js')
  })

  it('copies everything the committed builder bundle needs', () => {
    // #given the repository's own dist/ (kept fresh by the build hooks)
    const dist = fileURLToPath(new URL('../../../dist', import.meta.url))
    const target = temp()

    // #when the builder's graph is copied
    const copied = copyBundleWithImports(dist, target, 'sandbox-view.js')

    // #then the entry is there with at least one chunk, and every relative import of every copied file resolves in the copy
    expect(copied).toContain('sandbox-view.js')
    expect(copied.length).toBeGreaterThan(1)
    for (const name of copied) {
      const text = fs.readFileSync(path.join(target, name), 'utf8')
      for (const match of text.matchAll(/(?:from|import)\s*(?:\(\s*)?["'](\.\/[^"']+)["']/g)) {
        expect(fs.existsSync(path.join(target, match[1] ?? ''))).toBe(true)
      }
    }
  })
})

describe('inspections that feed an absence assertion', () => {
  const done = (overrides: Partial<InspectionResult> = {}): InspectionResult => ({
    status: 0,
    signal: null,
    stdout: '',
    stderr: '',
    ...overrides,
  })
  const returning =
    (result: InspectionResult): InspectionRunner =>
    () =>
      result

  // The two the review named, and the same shape for every helper that returns output.
  const callers: readonly (readonly [string, (run: InspectionRunner) => unknown, string])[] = [
    ['aclLines', run => aclLines('/home/runner/.bun', true, run), '/home/runner/.bun'],
    ['aclText', run => aclText(['-R', '-p', '/work/ws', '/work/response'], run), '/work/ws /work/response'],
    [
      'changedFilesSince',
      run => changedFilesSince('/home/runner/setup-pnpm', '/tmp/marker', 'fro-bot-it', run),
      '/home/runner/setup-pnpm',
    ],
    [
      'findPaths',
      run => findPaths(['/work/ws', '-xdev'], 'looking for files the sandbox still owns', run),
      'files the sandbox still owns',
    ],
    ['mountNamespaceIds', run => mountNamespaceIds(run), 'mount namespaces'],
    [
      'newLaunchNamespaces',
      run => newLaunchNamespaces([], {sandboxUid: 999, markers: [], cgroup: '0::/runner'}, run),
      'mount namespace members',
    ],
    ['runnerFirstLine', run => runnerFirstLine('cd /tmp && bun --version', run), 'bun --version'],
    ['pgrepOutput', run => pgrepOutput(['-f', 'sleep 777'], run), 'sleep 777'],
  ]

  describe.each(callers)('%s', (_name, call, named) => {
    it('throws, naming the target, when the command exits non-zero (a half-read listing is not evidence)', () => {
      // #given a failure with partial output that would read as "nothing found"
      const run = returning(done({status: 2, stdout: '', stderr: 'getfacl: /x: Permission denied\nsecond line'}))

      // #then
      expect(() => call(run)).toThrow(named)
      expect(() => call(run)).toThrow('exited 2')
      // #and the stderr tail is on one line
      expect(() => call(run)).toThrow('stderr: getfacl: /x: Permission denied second line')
    })

    it('throws when the command could not be started', () => {
      // #given a spawn error (command not found, timeout, buffer overflow)
      const run = returning(done({status: null, error: new Error('spawn getfacl ENOENT')}))

      // #then
      expect(() => call(run)).toThrow('could not complete (spawn getfacl ENOENT)')
      expect(() => call(run)).toThrow(named)
    })

    it('throws when the command was killed by a signal', () => {
      // #given a process killed before it finished
      const run = returning(done({status: null, signal: 'SIGTERM'}))

      // #then
      expect(() => call(run)).toThrow('killed by SIGTERM')
    })

    it('bounds the stderr tail it reports', () => {
      // #given a very long, multi-line stderr
      const run = returning(done({status: 3, stderr: `${'e'.repeat(500)}\nlast words\n`}))

      // #then the message carries the end of it on one line, cut to a fixed length
      let message = ''
      try {
        call(run)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain('stderr: ...')
      expect(message).toContain('last words')
      expect(message).not.toContain('\n')
      expect(message.length).toBeLessThan(600)
    })

    it('throws when the exit status is missing', () => {
      // #given neither a status nor a signal nor an error
      // #then it is not a completed inspection
      expect(() => call(returning(done({status: null})))).toThrow('without a status')
    })
  })

  describe('on success', () => {
    it('returns the parsed lines of getfacl, without empty ones, and passes the real arguments', () => {
      // #given a runner that records its call
      const calls: (readonly string[])[] = []
      const run: InspectionRunner = (command, args) => {
        calls.push([command, ...args])
        return done({stdout: 'user::rwx\nuser:999:--x\n\ngroup::r-x\n'})
      }

      // #when
      const lines = aclLines('/home/runner', false, run)
      const recursive = aclLines('/home/runner/.bun', true, run)

      // #then
      expect(lines).toEqual(['user::rwx', 'user:999:--x', 'group::r-x'])
      expect(recursive).toHaveLength(3)
      expect(calls).toEqual([
        ['getfacl', '-p', '-c', '/home/runner'],
        ['getfacl', '-p', '-c', '-R', '/home/runner/.bun'],
      ])
    })

    it('returns the changed files from find, skipping the ignored prefix and bun’s own cache by argument', () => {
      // #given
      const calls: (readonly string[])[] = []
      const run: InspectionRunner = (command, args) => {
        calls.push([command, ...args])
        return done({stdout: '/home/runner/.bun/bin/bun\n'})
      }

      // #then
      expect(changedFilesSince('/home/runner/.bun', '/tmp/marker', 'fro-bot-it', run)).toEqual([
        '/home/runner/.bun/bin/bun',
      ])
      expect(calls[0]).toEqual([
        'find',
        '/home/runner/.bun',
        '-type',
        'f',
        '-newer',
        '/tmp/marker',
        '-not',
        '-name',
        'fro-bot-it-*',
        '-not',
        '-path',
        '*/install/*',
      ])
    })

    it('returns an empty list for a command that completed and found nothing', () => {
      // #then success with no output is a real "nothing"
      expect(changedFilesSince('/x', '/m', 'p', returning(done()))).toEqual([])
      expect(aclLines('/x', false, returning(done()))).toEqual([])
    })

    it('treats pgrep exit 1 as no match, and anything above it as a failure', () => {
      // #then
      expect(pgrepOutput(['-f', 'x'], returning(done({status: 1})))).toBe('')
      expect(pgrepOutput(['-f', 'x'], returning(done({stdout: '41,42\n'})))).toBe('41,42')
      expect(() => pgrepOutput(['-f', 'x'], returning(done({status: 2, stderr: 'pgrep: invalid'})))).toThrow('exited 2')
    })

    it('returns the sorted namespace ids from lsns, trimmed', () => {
      // #then
      expect(mountNamespaceIds(returning(done({stdout: '  4026532500\n4026531841\n\n'})))).toEqual([
        '4026531841',
        '4026532500',
      ])
    })

    it('returns the first line of the runner’s own command', () => {
      // #then
      expect(runnerFirstLine('x', returning(done({stdout: '1.4.4\nextra\n'})))).toBe('1.4.4')
    })
  })

  describe('newLaunchNamespaces', () => {
    const RUNNER_CGROUP = '0::/system.slice/hosted-compute-agent.service'
    const HOST_CGROUP = '0::/system.slice/systemd-timedated.service'
    const GATE_DIR = 'fro-bot-gate-abc123'
    /** One scan line, tab separated as the real scan prints it. */
    const member = (ns: string, uid: number, comm: string, cgroup: string, cmdline: string): string =>
      `mnt:[${ns}]\t${uid}\t${comm} \t${cgroup}\t${cmdline} `
    const scan = (...lines: string[]): InspectionRunner => returning(done({stdout: `${lines.join('\n')}\n`}))
    const scope = {sandboxUid: 999, markers: [GATE_DIR, 'sleep 778[12]'], cgroup: RUNNER_CGROUP}
    const hostNamespace = member('4026532755', 0, 'systemd-timedat', HOST_CGROUP, '/usr/lib/systemd/systemd-timedated')
    // The namespace every machine already had: the host's own, shared by everything not in a namespace of its own.
    const hostRoot = member('4026531841', 0, 'systemd', '0::/init.scope', '/sbin/init')

    it('ignores a host-service namespace: root, a system.slice service cgroup and an unrelated command line', () => {
      // #given timedated appeared during the test, in a namespace that was not there before
      const result = newLaunchNamespaces(['4026531841'], scope, scan(hostRoot, hostNamespace))

      // #then it is set aside, with its owner named, and nothing is kept
      expect(result.kept).toEqual([])
      expect(result.ignored).toEqual([
        {
          id: '4026532755',
          uid: 0,
          comm: 'systemd-timedat',
          cgroup: HOST_CGROUP,
          cmdline: '/usr/lib/systemd/systemd-timedated',
        },
      ])
    })

    it('keeps a namespace with a member that runs as the sandbox uid', () => {
      // #given a leftover of the sandbox account
      const result = newLaunchNamespaces(
        ['4026531841'],
        scope,
        scan(hostRoot, member('4026532800', 999, 'sleep', HOST_CGROUP, 'sleep 1')),
      )

      // #then
      expect(result.kept).toEqual(['4026532800'])
      expect(result.keptMembers.map(m => m.comm)).toEqual(['sleep'])
    })

    it('keeps a namespace with a root member in the test process’s own cgroup', () => {
      // #given a root process the launch started, still in the runner's cgroup
      const result = newLaunchNamespaces(
        ['4026531841'],
        scope,
        scan(hostRoot, member('4026532801', 0, 'unshare', RUNNER_CGROUP, 'unshare --mount')),
      )

      // #then
      expect(result.kept).toEqual(['4026532801'])
    })

    it('does not count the root cgroup as ours, where every process shares it', () => {
      // #given a test process in the root cgroup and a host service there too
      const result = newLaunchNamespaces(
        ['4026531841'],
        {...scope, cgroup: '0::/'},
        scan(hostRoot, member('4026532804', 0, 'systemd-timedat', '0::/', '/usr/lib/systemd/systemd-timedated')),
      )

      // #then the host namespace is ignored
      expect(result.kept).toEqual([])
    })

    it('keeps a namespace with a root member whose command line names the gate directory', () => {
      // #given the orphaned gate: root, another cgroup, but the gate directory on its command line
      const result = newLaunchNamespaces(
        ['4026531841'],
        scope,
        scan(hostRoot, member('4026532802', 0, 'sh', HOST_CGROUP, `sh -c wait /tmp/${GATE_DIR}/go`)),
      )

      // #then
      expect(result.kept).toEqual(['4026532802'])
    })

    it('matches a marker as a pattern, the way the suites’ pgrep patterns are written', () => {
      // #given a stray `sleep 7782` and the suite's `sleep 778[12]`
      const result = newLaunchNamespaces([], scope, scan(member('4026532803', 0, 'sleep', HOST_CGROUP, 'sleep 7782')))

      // #then
      expect(result.kept).toEqual(['4026532803'])
    })

    it('keeps a namespace if any one member is ours, and ignores one that was already there', () => {
      // #given a mixed new namespace, and a pre-existing one that also holds a sandbox-uid process
      const result = newLaunchNamespaces(
        ['4026531841'],
        scope,
        scan(
          member('4026532804', 0, 'systemd-timedat', HOST_CGROUP, '/usr/lib/systemd/systemd-timedated'),
          member('4026532804', 999, 'sleep', HOST_CGROUP, 'sleep 1'),
          member('4026531841', 999, 'sleep', RUNNER_CGROUP, 'sleep 2'),
        ),
      )

      // #then only the new one is reported, once
      expect(result.kept).toEqual(['4026532804'])
      expect(result.ignored).toEqual([])
    })

    it('does not treat an unknown sandbox uid or an empty marker as a match for everything', () => {
      // #given no uid and an empty marker
      const result = newLaunchNamespaces(
        [],
        {sandboxUid: null, markers: [''], cgroup: RUNNER_CGROUP},
        scan(hostNamespace),
      )

      // #then
      expect(result.kept).toEqual([])
      expect(result.ignored).toHaveLength(1)
    })

    it('asks root for one scan over /proc, and describes a member for a failure message', () => {
      // #given a runner that records the call
      const calls: (readonly string[])[] = []
      const run: InspectionRunner = (command, args) => {
        calls.push([command, ...args])
        return done({stdout: `${hostNamespace}\n`})
      }

      // #when
      const result = newLaunchNamespaces([], scope, run)

      // #then
      expect(calls).toHaveLength(1)
      expect(calls[0]?.slice(0, 3)).toEqual(['sudo', '-n', 'sh'])
      expect(calls[0]?.[4]).toContain('/proc/[0-9]*')
      expect(describeNamespaceMembers(result.ignored)).toContain('4026532755 (uid 0, systemd-timedat')
      expect(describeNamespaceMembers([])).toBe('none')
    })

    it('throws on a line it cannot read rather than guessing', () => {
      // #then
      expect(() => newLaunchNamespaces([], scope, scan('garbage'))).toThrow('unreadable line')
    })
  })

  describe('the real runner', () => {
    it('reports a command that exits non-zero, and one that does not exist', () => {
      // #given real child processes
      const failed = runInspection('sh', ['-c', 'echo partial; echo oops >&2; exit 3'])
      const missing = runInspection('/nonexistent/inspector', [])

      // #then the status and stderr arrive, and a missing command carries an error
      expect(failed).toMatchObject({status: 3, signal: null})
      expect(failed.stdout).toContain('partial')
      expect(failed.stderr).toContain('oops')
      expect(missing.error).toBeDefined()
      // #and through the helper both throw
      expect(() => inspectOutput('sh', ['-c', 'echo partial; exit 3'], 'real failing command')).toThrow('exited 3')
      expect(() => inspectOutput('/nonexistent/inspector', [], 'real missing command')).toThrow('could not complete')
    })

    it('reports a process killed by a signal', () => {
      // #given a shell that kills itself
      // #then
      expect(() => inspectOutput('sh', ['-c', 'kill -KILL $$'], 'real killed command')).toThrow('killed by SIGKILL')
    })

    it('returns the output of a command that succeeds', () => {
      // #then
      expect(inspectOutput('sh', ['-c', 'echo fine'], 'real command')).toBe('fine\n')
    })
  })
})

describe('startPlainScriptedSession', () => {
  const provider = {port: 1, state: {results: [] as string[], done: true}, close: async () => undefined}
  const handleWith = (fetch: () => Promise<Response>) => ({
    fetch: vi.fn(fetch),
    registerOwnedSession: vi.fn(),
    shutdown: vi.fn(async () => ({exit: {outcome: 'graceful'}})),
  })
  const optionsFor = (handle: ReturnType<typeof handleWith>) => ({
    binary: '/bin/opencode',
    workspace: '/ws',
    env: {},
    provider,
    logger: createMockLogger(),
    deps: {start: vi.fn(async () => ({success: true as const, data: handle}))},
  })

  it('shuts the server down before it rethrows when the session cannot be created', async () => {
    // #given a started server whose session request fails
    const handle = handleWith(async () => Promise.reject(new Error('connection reset')))

    // #when the helper drives the turn
    // #then it rejects, and the caller never held the handle, so the helper stopped the server itself
    await expect(startPlainScriptedSession(optionsFor(handle) as never)).rejects.toThrow('connection reset')
    expect(handle.shutdown).toHaveBeenCalledTimes(1)
  })

  it('shuts the server down when the prompt request fails after the session was created', async () => {
    // #given a session that is created, then a prompt that fails
    let calls = 0
    const handle = handleWith(async () => {
      calls += 1
      if (calls === 1) return new Response(JSON.stringify({data: {id: 'ses_1'}}))
      throw new Error('prompt refused')
    })

    // #then the helper stops the server and the original error still reaches the caller
    await expect(startPlainScriptedSession(optionsFor(handle) as never)).rejects.toThrow('prompt refused')
    expect(handle.registerOwnedSession).toHaveBeenCalledWith('ses_1')
    expect(handle.shutdown).toHaveBeenCalledTimes(1)
  })

  it('returns the running handle, and leaves the shutdown to the caller, when the turn completes', async () => {
    // #given a server that takes the session and the prompt
    let calls = 0
    const handle = handleWith(async () => new Response(JSON.stringify(++calls === 1 ? {data: {id: 'ses_1'}} : {})))

    // #then the helper hands it back still running
    await expect(startPlainScriptedSession(optionsFor(handle) as never)).resolves.toBe(handle)
    expect(handle.shutdown).not.toHaveBeenCalled()
  })

  it('keeps the turn error when the shutdown itself fails', async () => {
    // #given a failing turn and a failing shutdown
    const handle = handleWith(async () => Promise.reject(new Error('turn failed')))
    handle.shutdown.mockRejectedValueOnce(new Error('shutdown failed'))

    // #then the caller sees the turn's error
    await expect(startPlainScriptedSession(optionsFor(handle) as never)).rejects.toThrow('turn failed')
  })
})

describe('parseRows verdicts', () => {
  it('reads an INCOMPLETE row, so a scan that left data unexamined is not mistaken for a missing one', () => {
    // #given a scan result that skipped a file
    const rows = parseRows('RESULT canary_scan INCOMPLETE canary.xdg=0 skip.xdg=1\n')

    // #then the status is kept
    expect(rows.get('canary_scan')).toEqual([{status: 'INCOMPLETE', evidence: 'canary.xdg=0 skip.xdg=1'}])
  })
})

describe('secretEnvRangeReport', () => {
  const long = (length: number): string => `t${'x'.repeat(length - 1)}`

  it('is matchable, with nothing out of range, for secret-named values of 8 to 4,096 characters and for any other name', () => {
    // #given what a hosted step holds: long tokens, a short value under a name that is not a secret's
    const report = secretEnvRangeReport({
      ACTIONS_RUNTIME_TOKEN: long(1400),
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: long(8),
      GITHUB_TOKEN: long(4096),
      CI: 'true',
      RUNNER_OS: 'Linux',
      EMPTY_TOKEN: '',
      BLANK_SECRET: '   ',
    })

    // #then
    expect(report).toEqual({matchable: true, inspected: 3, outOfRange: []})
  })

  it('is not matchable when a secret-named value is too short, and names it with its length only', () => {
    // #given a 7-character token and a 4,097-character one, beside an in-range one
    const secret7 = 'ghs_abc'
    const report = secretEnvRangeReport({
      GITHUB_TOKEN: secret7,
      ACTIONS_RUNTIME_TOKEN: long(4097),
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: long(500),
    })

    // #then both are reported, sorted by name, and no value is anywhere in the report or its description
    expect(report.matchable).toBe(false)
    expect(report.outOfRange).toEqual([
      {name: 'ACTIONS_RUNTIME_TOKEN', length: 4097},
      {name: 'GITHUB_TOKEN', length: 7},
    ])
    const description = describeOutOfRangeSecretEnv(report)
    expect(description).toBe('ACTIONS_RUNTIME_TOKEN (4097 characters), GITHUB_TOKEN (7 characters)')
    expect(`${JSON.stringify(report)} ${description}`).not.toContain(secret7)
  })

  it('agrees with the registry: the report names an offender exactly when the registry is not matchable', () => {
    for (const env of [
      {},
      {SOME_TOKEN: long(7)},
      {SOME_TOKEN: long(8)},
      {SOME_TOKEN: long(4097)},
      {SOME_TOKEN: long(4096)},
    ]) {
      const report = secretEnvRangeReport(env)
      expect(report.matchable).toBe(report.outOfRange.length === 0)
    }
  })
})
