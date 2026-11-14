import type {PrivilegedRun, PrivilegedRunResult, SandboxIdentityDeps, SandboxIdentityTools} from './sandbox-identity.js'
import {describe, expect, it} from 'vitest'
import {
  buildRunAsSandboxArgv,
  buildSetprivDropArgs,
  createSandboxAccount,
  deleteSandboxAccount,
  SANDBOX_ACCOUNT_CREATE_TIMEOUT_MS,
  SANDBOX_ACCOUNT_NAME,
  stopSandboxProcesses,
} from './sandbox-identity.js'

const TOOLS: SandboxIdentityTools = {
  setpriv: '/usr/bin/setpriv',
  useradd: '/usr/sbin/useradd',
  userdel: '/usr/sbin/userdel',
  pkill: '/usr/bin/pkill',
  pgrep: '/usr/bin/pgrep',
  chmod: '/usr/bin/chmod',
  chown: '/usr/bin/chown',
  find: '/usr/bin/find',
  mkdir: '/usr/bin/mkdir',
}

interface FakeSystemOptions {
  readonly passwd?: string[]
  readonly group?: string[]
  readonly failUseradd?: boolean
  /** Extra passwd line added by useradd, simulating a uid collision. */
  readonly collidingUid?: boolean
  readonly failChmod?: boolean
  readonly failMkdir?: boolean
  readonly failChown?: boolean
  readonly failFind?: boolean
  /** A directory already at the home path before the account is created, with the files in it. */
  readonly existingHome?: {readonly ownerUid: number; readonly entries?: readonly string[]}
  /** A home-setup command that is killed on its budget instead of finishing; its effect did not happen. */
  readonly timeoutOn?: 'chmod' | 'chown' | 'find' | 'mkdir'
  /** What useradd returns instead of succeeding. */
  readonly useraddResult?: PrivilegedRunResult
  /** When useradd returns `useraddResult`, still create the account (a hung useradd that had already finished its work). */
  readonly createDespiteResult?: boolean
  /** How long (on the fake clock) a useradd takes. */
  readonly useraddElapsedMs?: number
}

/** A tiny model of the host: passwd, group, a process table and a log of every privileged argv. */
function createFakeSystem(options: FakeSystemOptions = {}) {
  const passwd = [
    ...(options.passwd ?? ['root:x:0:0:root:/root:/bin/bash', 'runner:x:1001:1001::/home/runner:/bin/bash']),
  ]
  const group = [...(options.group ?? ['root:x:0:', 'runner:x:1001:'])]
  const calls: string[][] = []
  const useraddOptions: ({readonly timeoutMs?: number} | undefined)[] = []
  const infoLog: {readonly message: string; readonly context?: unknown}[] = []
  /** Home directories by path, with the uid that owns each and what is inside. */
  const homes = new Map<string, {uid: number; entries: readonly string[]}>(
    options.existingHome === undefined
      ? []
      : [
          [
            `/home/${SANDBOX_ACCOUNT_NAME}`,
            {uid: options.existingHome.ownerUid, entries: options.existingHome.entries ?? []},
          ],
        ],
  )
  const state = {
    procs: [] as string[],
    /** Processes spawned by a hostile parent right after each pkill, before the next pgrep. */
    respawnAfterKill: 0,
    survivors: false,
    now: 0,
    /** Whether chown fails; a test can clear it to retry on the same host. */
    failChown: options.failChown === true,
  }

  const run: PrivilegedRun = async (argv, runOptions) => {
    calls.push([...argv])
    if (argv[0] === TOOLS.useradd) useraddOptions.push(runOptions)
    const tool = argv[0]?.split('/').pop() ?? ''
    if (options.timeoutOn === tool) return {exitCode: null, stdout: '', stderr: '', timedOutAfterMs: 30_000}
    switch (tool) {
      case 'useradd': {
        state.now += options.useraddElapsedMs ?? 0
        if (options.useraddResult !== undefined) {
          if (options.createDespiteResult === true) {
            passwd.push(`${SANDBOX_ACCOUNT_NAME}:x:998:997::/home/${SANDBOX_ACCOUNT_NAME}:/bin/bash`)
          }
          return options.useraddResult
        }
        if (options.failUseradd === true) return {exitCode: 9, stdout: ''}
        passwd.push(`${SANDBOX_ACCOUNT_NAME}:x:998:997::/home/${SANDBOX_ACCOUNT_NAME}:/bin/bash`)
        group.push(`${SANDBOX_ACCOUNT_NAME}:x:997:`)
        if (options.collidingUid === true) passwd.push('other:x:998:998::/home/other:/bin/false')
        return {exitCode: 0, stdout: ''}
      }
      case 'chmod':
        return {exitCode: options.failChmod === true ? 1 : 0, stdout: ''}
      case 'mkdir': {
        const target = argv.at(-1) ?? ''
        if (options.failMkdir === true || homes.has(target)) return {exitCode: 1, stdout: '', stderr: 'File exists'}
        homes.set(target, {uid: 0, entries: []})
        return {exitCode: 0, stdout: ''}
      }
      case 'chown': {
        if (state.failChown) return {exitCode: 1, stdout: ''}
        const target = argv.at(-1) ?? ''
        const home = homes.get(target)
        if (home !== undefined) home.uid = Number.parseInt((argv.at(-2) ?? '').split(':')[0] ?? '', 10)
        return {exitCode: 0, stdout: ''}
      }
      case 'find': {
        // Only the exact non-recursive form is modelled: an empty directory at the path, never followed or descended into.
        if (options.failFind === true) return {exitCode: 1, stdout: '', stderr: 'find: cannot delete'}
        const target = argv[2] ?? ''
        const home = homes.get(target)
        if (home !== undefined && home.entries.length === 0) homes.delete(target)
        return {exitCode: 0, stdout: ''}
      }
      case 'userdel': {
        const name = argv.at(-1) ?? ''
        const index = passwd.findIndex(line => line.startsWith(`${name}:`))
        if (index === -1) return {exitCode: 6, stdout: ''}
        // Like shadow's `userdel --remove`: a home is removed only when the account owns it.
        const fields = (passwd[index] ?? '').split(':')
        const homePath = fields[5] ?? ''
        const owned = homes.get(homePath)?.uid === Number.parseInt(fields[2] ?? '', 10)
        if (argv.includes('--remove') && owned) homes.delete(homePath)
        passwd.splice(index, 1)
        const groupIndex = group.findIndex(line => line.startsWith(`${name}:`))
        if (groupIndex !== -1) group.splice(groupIndex, 1)
        return {exitCode: 0, stdout: ''}
      }
      case 'pkill': {
        const killed = state.procs.length > 0
        if (!state.survivors) state.procs = []
        if (state.respawnAfterKill > 0) {
          state.respawnAfterKill -= 1
          state.procs = ['respawned']
        }
        return {exitCode: killed ? 0 : 1, stdout: ''}
      }
      case 'pgrep':
        return {exitCode: state.procs.length > 0 ? 0 : 1, stdout: state.procs.join('\n')}
      default:
        return {exitCode: 127, stdout: ''}
    }
  }

  const deps: SandboxIdentityDeps = {
    run,
    readText: async file => {
      if (file === '/etc/passwd') return `${passwd.join('\n')}\n`
      if (file === '/etc/group') return `${group.join('\n')}\n`
      return null
    },
    now: () => state.now,
    sleep: async ms => {
      state.now += ms
    },
    logger: {
      debug: () => undefined,
      info: (message, context) => infoLog.push({message, context}),
      warning: () => undefined,
      error: () => undefined,
    },
  }
  return {deps, calls, state, passwd, group, homes, useraddOptions, infoLog}
}

const toolNames = (calls: readonly string[][]): string[] => calls.map(call => call[0]?.split('/').pop() ?? '')

describe('createSandboxAccount', () => {
  it('creates a system user with its own group and a 0700 home, and reads back the allocated ids', async () => {
    // #given a host without the account
    const system = createFakeSystem()

    // #when the account is created
    const result = await createSandboxAccount(TOOLS, system.deps)

    // #then the ids come from the host, the home is locked and no supplementary group was requested
    expect(result.success && result.data).toEqual({
      name: 'fro-bot-sandbox',
      uid: 998,
      gid: 997,
      home: '/home/fro-bot-sandbox',
    })
    const useradd = system.calls.find(call => call[0] === TOOLS.useradd) ?? []
    expect(useradd).toEqual(expect.arrayContaining(['--system', '--user-group', '--home-dir', '/home/fro-bot-sandbox']))
    expect(useradd).not.toContain('--groups')
    expect(system.calls).toContainEqual([TOOLS.chmod, '0700', '/home/fro-bot-sandbox'])
  })

  it('creates the account without copying /etc/skel', async () => {
    // #given a host without the account
    const system = createFakeSystem()

    // #when the account is created
    await createSandboxAccount(TOOLS, system.deps)

    // #then useradd was told not to create the home (--create-home copies /etc/skel, about 833 MB on hosted images)
    const useradd = system.calls.find(call => call[0] === TOOLS.useradd) ?? []
    expect(useradd).toContain('--no-create-home')
    expect(useradd).not.toContain('--create-home')
    expect(useradd).not.toContain('--skel')
  })

  it('creates the home, then hands it to the read-back uid and gid, then sets mode 0700, in that order', async () => {
    // #given a host that allocates uid 998 and gid 997
    const system = createFakeSystem()

    // #when the account is created
    const result = await createSandboxAccount(TOOLS, system.deps)

    // #then the steps after useradd are exactly these, in this order
    expect(result.success).toBe(true)
    const afterUseradd = system.calls.slice(system.calls.findIndex(call => call[0] === TOOLS.useradd) + 1)
    expect(afterUseradd).toEqual([
      [TOOLS.mkdir, '-m', '0700', '/home/fro-bot-sandbox'],
      [TOOLS.chown, '998:997', '/home/fro-bot-sandbox'],
      [TOOLS.chmod, '0700', '/home/fro-bot-sandbox'],
    ])
    // #and the home is owned by the account
    expect(system.homes.get('/home/fro-bot-sandbox')?.uid).toBe(998)
  })

  describe('the useradd budget and its failure messages', () => {
    it('gives useradd its own pinned budget instead of the generic default', async () => {
      // #given a host that creates the account
      const system = createFakeSystem()

      // #when
      await createSandboxAccount(TOOLS, system.deps)

      // #then useradd ran with the account-creation budget, and that budget is the value this test pins
      expect(system.useraddOptions).toEqual([{timeoutMs: SANDBOX_ACCOUNT_CREATE_TIMEOUT_MS}])
      // A cold hosted runner's first useradd sat in uninterruptible I/O wait for 99 s (CI probe, fro-bot/agent#2135).
      expect(SANDBOX_ACCOUNT_CREATE_TIMEOUT_MS).toBe(180_000)
    })

    it('logs at info, with the tool and elapsed time only, when account creation takes more than 10 s', async () => {
      // #given a useradd that takes 99 s on the clock
      const system = createFakeSystem({useraddElapsedMs: 99_000})

      // #when
      const result = await createSandboxAccount(TOOLS, system.deps)

      // #then it still succeeds, and the slow creation was logged once with nothing else in it
      expect(result.success).toBe(true)
      expect(system.infoLog.filter(entry => entry.message === 'Sandbox account creation was slow')).toEqual([
        {message: 'Sandbox account creation was slow', context: {tool: 'useradd', elapsedMs: 99_000}},
      ])
    })

    it('does not log a creation that took 10 s or less', async () => {
      // #given
      const system = createFakeSystem({useraddElapsedMs: 10_000})

      // #when
      await createSandboxAccount(TOOLS, system.deps)

      // #then
      expect(system.infoLog.some(entry => entry.message === 'Sandbox account creation was slow')).toBe(false)
    })

    it('says "timed out after Nms", includes the stderr tail, and whether the account had been created', async () => {
      // #given a useradd the runner had to kill, which printed a warning first
      const system = createFakeSystem({
        useraddResult: {
          exitCode: null,
          stdout: '',
          stderr: 'useradd: warning: the home directory already exists.',
          timedOutAfterMs: 60_000,
        },
      })

      // #when
      const result = await createSandboxAccount(TOOLS, system.deps)

      // #then the reason is a timeout (not "exit null"), with the evidence
      expect(!result.success && result.error.message).toContain('timed out after 60000ms')
      expect(!result.success && result.error.message).toContain('the home directory already exists')
      expect(!result.success && result.error.message).toContain('account present at timeout: no')
      expect(!result.success && result.error.message).not.toContain('exit null')
    })

    it('reports a useradd that finished its work but never closed its pipes: the account was present at the timeout', async () => {
      // #given a killed useradd whose account exists anyway
      const system = createFakeSystem({
        useraddResult: {exitCode: null, stdout: '', stderr: '', timedOutAfterMs: 60_000},
        createDespiteResult: true,
      })

      // #when
      const result = await createSandboxAccount(TOOLS, system.deps)

      // #then the message separates "hung before creating" from "created, then hung"
      expect(!result.success && result.error.message).toContain('account present at timeout: yes')
    })

    it('never removes the account after a timeout: a killed useradd is not known to have stopped', async () => {
      // #given a useradd that outlived its budget and whose account exists
      const system = createFakeSystem({
        useraddResult: {exitCode: null, stdout: '', stderr: '', timedOutAfterMs: 60_000},
        createDespiteResult: true,
      })

      // #when
      const result = await createSandboxAccount(TOOLS, system.deps)

      // #then userdel never ran (the useradd could still be finishing), the failure says so, and it is flagged as a timeout
      expect(toolNames(system.calls)).not.toContain('userdel')
      expect(!result.success && result.error.message).toContain('left in place')
      expect(!result.success && 'timedOut' in result.error && result.error.timedOut).toBe(true)
    })

    it('does flag an ordinary failure as not timed out, and still cleans up after it', async () => {
      // #given a useradd that exits non-zero after creating the account
      const system = createFakeSystem({
        useraddResult: {exitCode: 9, stdout: '', stderr: 'boom'},
        createDespiteResult: true,
      })

      // #when
      const result = await createSandboxAccount(TOOLS, system.deps)

      // #then it was cleaned up and is not a timeout
      expect(toolNames(system.calls)).toContain('userdel')
      expect(!result.success && 'timedOut' in result.error).toBe(false)
    })

    it('includes the processes that were running at the timeout, on one bounded line', async () => {
      // #given a killed useradd with the snapshot the runner took
      const processes = [
        'PID PPID PGID STAT ELAPSED COMMAND',
        '4101 4090 4101 S 01:00 sudo -n -- /usr/sbin/useradd x',
        '4102 4101 4101 S 01:00 /usr/sbin/useradd x',
      ].join('\n')
      const system = createFakeSystem({
        useraddResult: {exitCode: null, stdout: '', stderr: '', timedOutAfterMs: 60_000, processes},
      })

      // #when
      const result = await createSandboxAccount(TOOLS, system.deps)

      // #then
      const message = result.success ? '' : result.error.message
      expect(message).toContain('processes at timeout: ')
      expect(message).toContain('4102 4101 4101 S 01:00 /usr/sbin/useradd x')
      expect(message).not.toContain('\n')
    })

    it('bounds the process listing in the message', async () => {
      // #given a snapshot far longer than the bound
      const processes = Array.from({length: 200}, (_, index) => `${index} 1 1 S 00:01 /usr/bin/thing-${index}`).join(
        '\n',
      )
      const system = createFakeSystem({
        useraddResult: {exitCode: null, stdout: '', stderr: '', timedOutAfterMs: 60_000, processes},
      })

      // #when
      const result = await createSandboxAccount(TOOLS, system.deps)

      // #then
      expect(!result.success && result.error.message.length).toBeLessThan(1500)
    })

    it('includes the exit code and stderr tail for an ordinary failure, bounded to one line', async () => {
      // #given a useradd that fails with a long, multi-line stderr
      const noisy = `${'x'.repeat(5000)}\nuseradd: cannot lock /etc/passwd; try again later.`
      const system = createFakeSystem({useraddResult: {exitCode: 1, stdout: '', stderr: noisy}})

      // #when
      const result = await createSandboxAccount(TOOLS, system.deps)

      // #then
      const message = result.success ? '' : result.error.message
      expect(message).toContain('exit 1')
      expect(message).toContain('cannot lock /etc/passwd')
      expect(message).not.toContain('\n')
      expect(message.length).toBeLessThan(700)
    })
  })

  it('refuses an existing account and deletes nothing', async () => {
    // #given an account of that name that already exists
    const system = createFakeSystem({
      passwd: ['fro-bot-sandbox:x:900:900::/home/fro-bot-sandbox:/bin/bash'],
      group: ['fro-bot-sandbox:x:900:'],
    })

    // #when creation is attempted
    const result = await createSandboxAccount(TOOLS, system.deps)

    // #then it is refused without adoption, creation or deletion
    expect(!result.success && result.error.kind).toBe('exists')
    expect(toolNames(system.calls)).toEqual([])
  })

  it('refuses a pre-existing group of that name', async () => {
    // #given a group with the sandbox name but no user
    const system = createFakeSystem({group: ['root:x:0:', 'fro-bot-sandbox:x:900:runner']})

    // #when creation is attempted
    const result = await createSandboxAccount(TOOLS, system.deps)

    // #then it is refused
    expect(!result.success && result.error.kind).toBe('exists')
    expect(toolNames(system.calls)).not.toContain('useradd')
  })

  it('removes a partially created account when useradd fails after creating it', async () => {
    // #given a useradd that fails
    const system = createFakeSystem({failUseradd: true})

    // #when creation is attempted
    const result = await createSandboxAccount(TOOLS, system.deps)

    // #then it reports the failure and, finding nothing created, deletes nothing
    expect(!result.success && result.error.kind).toBe('create-failed')
    expect(toolNames(system.calls)).not.toContain('userdel')
  })

  it('rolls the account back when its uid is shared with another account', async () => {
    // #given a host where the allocated uid is already in use
    const system = createFakeSystem({collidingUid: true})

    // #when creation is attempted
    const result = await createSandboxAccount(TOOLS, system.deps)

    // #then it fails closed and removes the account it just created
    expect(!result.success && result.error.kind).toBe('create-failed')
    expect(toolNames(system.calls)).toContain('userdel')
  })

  it('removes the account when the home cannot be locked down', async () => {
    // #given a chmod that fails
    const system = createFakeSystem({failChmod: true})

    // #when creation is attempted
    const result = await createSandboxAccount(TOOLS, system.deps)

    // #then the account does not survive
    expect(result.success).toBe(false)
    expect(system.passwd.some(line => line.startsWith('fro-bot-sandbox:'))).toBe(false)
  })
})

describe('createSandboxAccount: the home steps', () => {
  const HOME = '/home/fro-bot-sandbox'
  const accountExists = (system: ReturnType<typeof createFakeSystem>): boolean =>
    system.passwd.some(line => line.startsWith('fro-bot-sandbox:'))
  const FIND_HOME_ARGV = [TOOLS.find, '-P', HOME, '-maxdepth', '0', '-type', 'd', '-empty', '-delete']

  it('stops at the first failed step: a failed mkdir never reaches chown, chmod or the cleanup', async () => {
    // #given an mkdir that fails
    const system = createFakeSystem({failMkdir: true})

    // #when
    const result = await createSandboxAccount(TOOLS, system.deps)

    // #then the account is removed with a plain userdel (the home was not made here, so it is not ours to remove)
    expect(!result.success && result.error.kind).toBe('create-failed')
    expect(!result.success && 'timedOut' in result.error).toBe(false)
    expect(toolNames(system.calls)).not.toContain('chown')
    expect(toolNames(system.calls)).not.toContain('chmod')
    expect(toolNames(system.calls)).not.toContain('find')
    expect(system.calls).toContainEqual([TOOLS.userdel, 'fro-bot-sandbox'])
    expect(accountExists(system)).toBe(false)
  })

  it.each([
    ['root', 0],
    ['the newly allocated uid', 998],
  ] as const)(
    'keeps a pre-existing home owned by %s, with its contents, and removes only the account',
    async (_owner, ownerUid) => {
      // #given a directory already at the home path with a file in it
      const system = createFakeSystem({existingHome: {ownerUid, entries: ['precious.txt']}})

      // #when creation is attempted
      const result = await createSandboxAccount(TOOLS, system.deps)

      // #then creation fails, the account is gone, and the directory and its file are untouched
      expect(!result.success && result.error.kind).toBe('create-failed')
      expect(accountExists(system)).toBe(false)
      expect(system.homes.get(HOME)).toEqual({uid: ownerUid, entries: ['precious.txt']})
      // #and nothing was asked to adopt, change or remove it
      expect(system.calls.find(call => call[0] === TOOLS.mkdir)).not.toContain('-p')
      for (const tool of ['chown', 'chmod', 'find']) expect(toolNames(system.calls)).not.toContain(tool)
      expect(system.calls.filter(call => call[0] === TOOLS.userdel)).toEqual([[TOOLS.userdel, 'fro-bot-sandbox']])
    },
  )

  it('removes the new home, then the account, when chown fails after mkdir, and a retry then succeeds', async () => {
    // #given a chown that fails once the root-owned home exists
    const system = createFakeSystem({failChown: true})

    // #when creation is attempted
    const result = await createSandboxAccount(TOOLS, system.deps)

    // #then the half-made home is removed first (non-recursively), then the account, with a plain userdel
    expect(!result.success && result.error.kind).toBe('create-failed')
    expect(!result.success && 'timedOut' in result.error).toBe(false)
    const afterMkdir = system.calls.slice(system.calls.findIndex(call => call[0] === TOOLS.mkdir))
    expect(afterMkdir.map(call => call.join(' '))).toEqual([
      `${TOOLS.mkdir} -m 0700 ${HOME}`,
      `${TOOLS.chown} 998:997 ${HOME}`,
      FIND_HOME_ARGV.join(' '),
      `${TOOLS.userdel} fro-bot-sandbox`,
    ])
    expect(system.homes.has(HOME)).toBe(false)
    expect(accountExists(system)).toBe(false)

    // #and the fixed path is free again: a second attempt on the same host succeeds
    system.state.failChown = false
    const retry = await createSandboxAccount(TOOLS, system.deps)
    expect(retry.success).toBe(true)
  })

  it('removes the home and the account when chmod fails after mkdir and chown', async () => {
    // #given a chmod that fails after the home was made and handed over
    const system = createFakeSystem({failChmod: true})

    // #when creation is attempted
    const result = await createSandboxAccount(TOOLS, system.deps)

    // #then both are gone, the home first
    expect(!result.success && result.error.kind).toBe('create-failed')
    expect(system.homes.has(HOME)).toBe(false)
    expect(accountExists(system)).toBe(false)
    const tail = system.calls.slice(-2).map(call => call.join(' '))
    expect(tail).toEqual([FIND_HOME_ARGV.join(' '), `${TOOLS.userdel} fro-bot-sandbox`])
  })

  it('cleans the half-made home with one exact, non-recursive, symlink-safe find', async () => {
    // #given a failure after mkdir
    const system = createFakeSystem({failChown: true})

    // #when
    await createSandboxAccount(TOOLS, system.deps)

    // #then the only cleanup command is find on the path itself: no recursion, no -L, only an empty directory
    const finds = system.calls.filter(call => call[0] === TOOLS.find)
    expect(finds).toEqual([FIND_HOME_ARGV])
    expect(finds[0]).toContain('-P')
    expect(finds[0]).not.toContain('-L')
    expect(finds[0]?.slice(finds[0].indexOf('-maxdepth'), finds[0].indexOf('-maxdepth') + 2)).toEqual([
      '-maxdepth',
      '0',
    ])
    expect(system.calls.some(call => call.includes('--remove') || call.includes('-r') || call.includes('-rf'))).toBe(
      false,
    )
  })

  it('reports a failed cleanup in the error message and still removes the account', async () => {
    // #given a chown failure whose cleanup also fails
    const system = createFakeSystem({failChown: true, failFind: true})

    // #when
    const result = await createSandboxAccount(TOOLS, system.deps)

    // #then the message says the home was left, and the account is gone anyway
    const message = result.success ? '' : result.error.message
    expect(message).toContain(`the half-made home ${HOME} could not be removed`)
    expect(message).toContain('Could not hand the sandbox home to the account')
    expect(accountExists(system)).toBe(false)
  })

  it.each([{failChown: true}, {failChmod: true}] as const)(
    'leaves the account in place when the cleanup of a half-made home is killed on its budget (%o)',
    async failure => {
      // #given an ordinary home-step failure whose cleanup outlives its budget
      const system = createFakeSystem({...failure, timeoutOn: 'find'})

      // #when creation is attempted
      const result = await createSandboxAccount(TOOLS, system.deps)

      // #then the account is kept (the killed find is not known to have stopped) and the failure is a timeout
      expect(toolNames(system.calls)).toContain('find')
      expect(toolNames(system.calls)).not.toContain('userdel')
      expect(accountExists(system)).toBe(true)
      expect(!result.success && 'timedOut' in result.error && result.error.timedOut).toBe(true)
      expect(!result.success && result.error.message).toContain(`the half-made home ${HOME} could not be removed`)
    },
  )

  it.each(['mkdir', 'chown', 'chmod'] as const)(
    'leaves the account and the home in place, and cleans up nothing, when %s is killed on its budget',
    async step => {
      // #given a home step that outlives its budget
      const system = createFakeSystem({timeoutOn: step})

      // #when creation is attempted
      const result = await createSandboxAccount(TOOLS, system.deps)

      // #then neither userdel nor find ran (the killed command is not known to have stopped) and the failure is a timeout
      expect(toolNames(system.calls)).not.toContain('userdel')
      expect(toolNames(system.calls)).not.toContain('find')
      expect(accountExists(system)).toBe(true)
      expect(system.homes.has(HOME)).toBe(step !== 'mkdir')
      expect(!result.success && 'timedOut' in result.error && result.error.timedOut).toBe(true)
      expect(!result.success && result.error.message).toContain('timed out after 30000ms')
    },
  )
})

describe('stopSandboxProcesses', () => {
  it('kills the uid and confirms nothing is left', async () => {
    // #given sandbox processes
    const system = createFakeSystem()
    system.state.procs = ['server', 'setsid-child']

    // #when stopped
    const outcome = await stopSandboxProcesses({uid: 998}, TOOLS, system.deps)

    // #then the kill ran against the uid and the verification came back empty
    expect(outcome).toBe('stopped')
    expect(system.calls).toContainEqual([TOOLS.pkill, '-KILL', '-u', '998'])
    expect(system.calls.at(-1)).toEqual([TOOLS.pgrep, '-u', '998'])
  })

  it('gives every pkill and pgrep the time left of the bound, and ends unconfirmed when they hang', async () => {
    // #given a runner whose commands never finish (exit null, as a killed-on-timeout command reports) and a fake clock
    let clock = 0
    const timeouts: number[] = []
    const hung: PrivilegedRun = async (_argv, options) => {
      timeouts.push(options?.timeoutMs ?? -1)
      clock += options?.timeoutMs ?? 0
      return {exitCode: null, stdout: ''}
    }
    const system = createFakeSystem()

    // #when stopped with a 1s bound
    const outcome = await stopSandboxProcesses(
      {uid: 998},
      TOOLS,
      {...system.deps, run: hung, now: () => clock, sleep: async () => undefined},
      {boundMs: 1000, pollMs: 10},
    )

    // #then nothing is proven, the loop stops at the deadline, and no command was allowed past what was left
    expect(outcome).toBe('unconfirmed')
    expect(timeouts.length).toBeGreaterThan(0)
    expect(timeouts.every(timeoutMs => timeoutMs > 0 && timeoutMs <= 1000)).toBe(true)
    expect(clock).toBeLessThanOrEqual(1000 + 1)
  })

  it('reports unconfirmed, and never deletes, when processes survive past the bound', async () => {
    // #given a process pkill cannot remove
    const system = createFakeSystem()
    system.state.procs = ['stuck']
    system.state.survivors = true

    // #when stopped with a short bound
    const outcome = await stopSandboxProcesses({uid: 998}, TOOLS, system.deps, {boundMs: 500, pollMs: 100})

    // #then the outcome is unconfirmed and the loop kept trying until the bound
    expect(outcome).toBe('unconfirmed')
    expect(system.calls.filter(call => call[0] === TOOLS.pkill).length).toBeGreaterThan(2)
    expect(toolNames(system.calls)).not.toContain('userdel')
  })

  it('kills a process that reappears between pkill and pgrep on the next pass', async () => {
    // #given a hostile parent that spawns a replacement right after the first kill
    const system = createFakeSystem()
    system.state.procs = ['server']
    system.state.respawnAfterKill = 1

    // #when stopped
    const outcome = await stopSandboxProcesses({uid: 998}, TOOLS, system.deps, {boundMs: 5000})

    // #then the second pass removes the replacement
    expect(outcome).toBe('stopped')
    expect(system.calls.filter(call => call[0] === TOOLS.pkill)).toHaveLength(2)
  })

  it('treats a pgrep error as no proof of absence', async () => {
    // #given a pgrep that cannot run
    const system = createFakeSystem()
    const failing: SandboxIdentityDeps = {
      ...system.deps,
      run: async argv => (argv[0] === TOOLS.pgrep ? {exitCode: 2, stdout: ''} : {exitCode: 1, stdout: ''}),
    }

    // #when stopped
    const outcome = await stopSandboxProcesses({uid: 998}, TOOLS, failing, {boundMs: 300, pollMs: 100})

    // #then an error is not mistaken for an empty process table
    expect(outcome).toBe('unconfirmed')
  })
})

describe('deleteSandboxAccount', () => {
  it('deletes the account with its home', async () => {
    const system = createFakeSystem()
    const created = await createSandboxAccount(TOOLS, system.deps)
    if (!created.success) throw new Error('unreachable')

    // #when deleted
    const outcome = await deleteSandboxAccount(created.data, TOOLS, system.deps)

    // #then the account and its home are removed, including a home that useradd did not create
    expect(outcome).toBe('deleted')
    expect(system.calls.at(-1)).toEqual([TOOLS.userdel, '--remove', 'fro-bot-sandbox'])
    expect(system.homes.has('/home/fro-bot-sandbox')).toBe(false)
  })
})

describe('privilege drop arguments', () => {
  it('pins the exact flags', () => {
    expect(buildSetprivDropArgs({uid: 5, gid: 6})).toEqual([
      '--reuid=5',
      '--regid=6',
      '--clear-groups',
      '--no-new-privs',
      '--inh-caps=-all',
      '--bounding-set=-all',
      '--ambient-caps=-all',
    ])
    expect(buildRunAsSandboxArgv({uid: 5, gid: 6}, TOOLS, ['/usr/bin/id'])).toEqual([
      '/usr/bin/setpriv',
      ...buildSetprivDropArgs({uid: 5, gid: 6}),
      '--',
      '/usr/bin/id',
    ])
  })
})
