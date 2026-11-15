import type {SandboxViewChildIo} from './sandbox-view-child.js'
import type {MountEntry, SandboxViewPolicy} from './sandbox-view.js'
import {describe, expect, it} from 'vitest'
import {runSandboxViewChild, SANDBOX_VIEW_EXIT_FAILED, SANDBOX_VIEW_EXIT_INVALID_POLICY} from './sandbox-view-child.js'

const ROOT = '/run/view/root'

/** The one line the builder reported, parsed. Fails the test when there is not exactly one, ending in a newline. */
function reported(model: {readonly written: readonly string[]}): Record<string, unknown> {
  expect(model.written).toHaveLength(1)
  const line = model.written[0] ?? ''
  expect(line.endsWith('\n')).toBe(true)
  expect(line.slice(0, -1)).not.toContain('\n')
  return JSON.parse(line) as Record<string, unknown>
}

const POLICY: SandboxViewPolicy = {
  newRoot: ROOT,
  putOld: '/mnt',
  tools: {mount: '/usr/bin/mount', umount: '/usr/bin/umount'},
  writable: ['/home/runner/work/repo/repo', '/home/fro-bot-sandbox'],
  readOnly: ['/home/runner/work/_temp/attachments'],
  runnerHome: '/home/runner',
  actionsDir: '/home/runner/work/_actions',
}

interface Model {
  readonly io: SandboxViewChildIo
  readonly ran: string[][]
  readonly written: string[]
  readonly made: string[]
  table: () => MountEntry[]
}

interface ModelOptions {
  readonly policyText?: string | undefined
  /** An argv that makes the tool exit non-zero. */
  readonly failOn?: (argv: readonly string[]) => boolean
  /** What a failing tool prints. */
  readonly stderr?: (argv: readonly string[]) => string
  /** An argv that never finishes within its deadline. */
  readonly hangOn?: (argv: readonly string[]) => boolean
  /** A remount of this path that silently does nothing, as `ro=recursive` does for submounts. */
  readonly ignoreRemountOf?: string
  readonly symlinks?: Readonly<Record<string, string>>
  readonly notEmpty?: readonly string[]
  readonly hostMounts?: readonly MountEntry[]
}

function hostTable(): MountEntry[] {
  return [
    {id: 1, parentId: 0, mountPoint: '/', options: ['rw'], fsType: 'ext4'},
    {id: 2, parentId: 1, mountPoint: '/proc', options: ['rw'], fsType: 'proc'},
    {id: 3, parentId: 2, mountPoint: '/proc/sys/fs/binfmt_misc', options: ['rw'], fsType: 'autofs'},
    {id: 4, parentId: 2, mountPoint: '/proc/sys/fs/binfmt_misc', options: ['rw'], fsType: 'binfmt_misc'},
    {id: 5, parentId: 1, mountPoint: '/dev', options: ['rw'], fsType: 'devtmpfs'},
    {id: 6, parentId: 5, mountPoint: '/dev/shm', options: ['rw'], fsType: 'tmpfs'},
    {id: 7, parentId: 1, mountPoint: '/mnt/with space', options: ['rw'], fsType: 'ext4'},
  ]
}

/** A small model of the kernel's mount table: what each tool does to it, as far as the builder depends on. */
function createModel(options: ModelOptions = {}): Model {
  let mounts: MountEntry[] = [...(options.hostMounts ?? hostTable())]
  let nextId = 100
  const ran: string[][] = []
  const written: string[] = []
  const made: string[] = []

  const topAt = (mountPoint: string): MountEntry | undefined =>
    mounts.filter(mount => mount.mountPoint === mountPoint).toSorted((a, b) => b.id - a.id)[0]
  const replace = (target: MountEntry, next: MountEntry): void => {
    mounts = mounts.map(mount => (mount === target ? next : mount))
  }

  const apply = (argv: readonly string[]): boolean => {
    if (options.failOn?.(argv) === true) return false
    const target = argv.at(-1) ?? ''
    if (argv[3] === 'rbind') {
      const host = [...mounts]
      for (const mount of host) {
        const mountPoint = mount.mountPoint === '/' ? ROOT : `${ROOT}${mount.mountPoint}`
        mounts.push({...mount, id: nextId++, mountPoint})
      }
    } else if (argv[1] === '-l') {
      const top = topAt(target)
      if (top === undefined) return false
      mounts = mounts.filter(mount => mount !== top)
    } else if (argv[2] === '-o' && (argv[3] ?? '').startsWith('remount,bind,')) {
      const top = topAt(target)
      if (top === undefined) return false
      if (target === options.ignoreRemountOf) return true
      replace(top, {...top, options: [argv[3]?.endsWith('ro') === true ? 'ro' : 'rw']})
    } else if (argv[2] === '-t' && argv[3] === 'tmpfs') {
      mounts.push({id: nextId++, parentId: 1, mountPoint: target, options: ['rw'], fsType: 'tmpfs'})
    } else if (argv[2] === '--bind') {
      mounts.push({id: nextId++, parentId: 1, mountPoint: target, options: ['rw'], fsType: 'ext4'})
    }
    return true
  }

  const io: SandboxViewChildIo = {
    policyText: 'policyText' in options ? options.policyText : JSON.stringify(POLICY),
    readMountInfo: async () =>
      mounts
        .map(mount => {
          const escaped = mount.mountPoint.replaceAll(' ', String.raw`\040`)
          return `${mount.id} ${mount.parentId} 8:1 / ${escaped} ${mount.options.join(',')} - ${mount.fsType} src rw`
        })
        .join('\n'),
    run: async (argv, timeoutMs) => {
      ran.push([...argv])
      if (options.hangOn?.(argv) === true) {
        expect(timeoutMs).toBeGreaterThan(0)
        return {status: 'timeout' as const, stderr: ''}
      }
      return apply(argv)
        ? {status: 'ok' as const, stderr: ''}
        : {status: 'failed' as const, stderr: options.stderr?.(argv) ?? 'mount: failed'}
    },
    mkdir: async directory => {
      made.push(directory)
    },
    realpath: async target => options.symlinks?.[target] ?? target,
    isEmptyDirectory: async target => options.notEmpty?.includes(target) !== true,
    report: {
      write: chunk => {
        written.push(String(chunk))
      },
    },
  }
  return {io, ran, written, made, table: () => mounts}
}

describe('runSandboxViewChild', () => {
  it('builds the view, verifies the table and prints nothing', async () => {
    // #given a host with nested and stacked mounts
    const model = createModel()

    // #when the builder runs
    const code = await runSandboxViewChild(model.io)

    // #then it succeeded, silently
    expect(code).toBe(0)
    expect(model.written).toEqual([])

    // #and the first operation is the recursive bind, before anything else
    expect(model.ran[0]).toEqual(['/usr/bin/mount', '-n', '-o', 'rbind', '/', ROOT])

    // #and the binfmt_misc stack is detached, both mounts, and the rest is remounted read-only
    expect(model.ran.filter(argv => argv[1] === '-l')).toHaveLength(2)
    const under = model.table().filter(mount => mount.mountPoint.startsWith(ROOT))
    expect(under.some(mount => mount.mountPoint.endsWith('binfmt_misc'))).toBe(false)
    const writable = under.filter(mount => !mount.options.includes('ro')).map(mount => mount.mountPoint)
    expect(writable.toSorted()).toEqual(
      [
        `${ROOT}/dev/shm`,
        `${ROOT}/tmp`,
        `${ROOT}/var/tmp`,
        `${ROOT}/home/runner/work/repo/repo`,
        `${ROOT}/home/fro-bot-sandbox`,
      ].toSorted(),
    )

    // #and a mount path with a space was decoded, remounted as one argument
    expect(model.ran.some(argv => argv.at(-1) === `${ROOT}/mnt/with space`)).toBe(true)
  })

  it('refuses an invalid policy before running anything', async () => {
    // #given text that is not a policy
    for (const policyText of [undefined, 'not json', '{"newRoot": "relative"}']) {
      const model = createModel({policyText})

      // #when the builder runs
      const code = await runSandboxViewChild(model.io)

      // #then nothing ran and the exit is the invalid-policy code with the fixed line
      expect(code).toBe(SANDBOX_VIEW_EXIT_INVALID_POLICY)
      expect(model.ran).toEqual([])
      expect(reported(model)).toMatchObject({view: 'failed', stage: 'policy'})
    }
  })

  it('refuses a writable root with a mount beneath it before any operation', async () => {
    // #given a mount inside the checkout
    const hostMounts = [
      ...hostTable(),
      {id: 8, parentId: 1, mountPoint: '/home/runner/work/repo/repo/dist', options: ['rw'], fsType: 'tmpfs'},
    ]
    const model = createModel({hostMounts})

    // #when the builder runs
    const code = await runSandboxViewChild(model.io)

    // #then nothing was mounted
    expect(code).toBe(SANDBOX_VIEW_EXIT_INVALID_POLICY)
    expect(model.ran).toEqual([])
  })

  it('refuses a root that is reached through a symlink', async () => {
    // #given a root whose real path differs from the policy's
    const model = createModel({symlinks: {'/home/fro-bot-sandbox': '/elsewhere'}})

    // #when the builder runs
    const code = await runSandboxViewChild(model.io)

    // #then nothing was mounted
    expect(code).toBe(SANDBOX_VIEW_EXIT_INVALID_POLICY)
    expect(model.ran).toEqual([])
  })

  it('refuses a new root that is not empty', async () => {
    // #given leftovers in the new root
    const model = createModel({notEmpty: [ROOT]})

    // #when the builder runs
    // #then nothing was mounted
    expect(await runSandboxViewChild(model.io)).toBe(SANDBOX_VIEW_EXIT_INVALID_POLICY)
    expect(model.ran).toEqual([])
  })

  it('stops at the first failing operation, runs nothing further and exits non-zero with a fixed line', async () => {
    // #given the second remount fails
    let remounts = 0
    const model = createModel({
      failOn: argv => argv[3] === 'remount,bind,ro' && ++remounts === 2,
    })

    // #when the builder runs
    const code = await runSandboxViewChild(model.io)

    // #then it stopped there: no tmpfs, no bind of a root
    expect(code).toBe(SANDBOX_VIEW_EXIT_FAILED)
    expect(model.ran.some(argv => argv.includes('tmpfs'))).toBe(false)
    expect(model.ran.some(argv => argv.includes('--bind'))).toBe(false)
    expect(model.ran.filter(argv => argv[3] === 'remount,bind,ro')).toHaveLength(2)
    // #and the line names a stage and nothing else
    expect(reported(model)).toMatchObject({view: 'failed', stage: 'seal'})
  })

  it('names the failed operation and carries the tool’s error text, on one bounded line', async () => {
    // #given a remount that fails with a multi-line, over-long error
    const noise = `${'x'.repeat(500)}\nmount: ${ROOT}/dev: permission denied.\n\tdmesg may have more information\u0000\n`
    const model = createModel({
      failOn: argv => argv.at(-1) === `${ROOT}/dev` && argv[3] === 'remount,bind,ro',
      stderr: () => noise,
    })

    // #when the builder runs
    const code = await runSandboxViewChild(model.io)

    // #then the line names the stage, the operation by tool name and arguments, and the end of the error text
    expect(code).toBe(SANDBOX_VIEW_EXIT_FAILED)
    const line = reported(model)
    expect(line.stage).toBe('seal')
    expect(line.op).toBe(`mount -n -o remount,bind,ro ${ROOT}/dev`)
    const detail = String(line.detail)
    expect(detail.startsWith('...')).toBe(true)
    expect(detail.endsWith('dmesg may have more information')).toBe(true)
    expect(detail).toContain(`mount: ${ROOT}/dev: permission denied.`)
    expect(detail.length).toBeLessThanOrEqual(243)

    expect(/[^\x20-\x7E]/.test(detail)).toBe(false)
  })

  it('says why a policy was refused', async () => {
    // #given a writable root with a mount beneath it
    const hostMounts = [
      ...hostTable(),
      {id: 8, parentId: 1, mountPoint: '/home/runner/work/repo/repo/dist', options: ['rw'], fsType: 'tmpfs'},
    ]
    const model = createModel({hostMounts})

    // #when the builder runs
    await runSandboxViewChild(model.io)

    // #then the reason is in the line
    const line = reported(model)
    expect(line.stage).toBe('policy')
    expect(String(line.detail)).toContain('has a mount beneath it: /home/runner/work/repo/repo/dist')
  })

  it('says why verification failed', async () => {
    // #given a remount that silently does nothing
    const model = createModel({ignoreRemountOf: `${ROOT}/dev`})

    // #when the builder runs
    await runSandboxViewChild(model.io)

    // #then the verification's own reason is in the line
    const line = reported(model)
    expect(line.stage).toBe('verify')
    expect(String(line.detail).length).toBeGreaterThan(0)
  })

  it('says a tool timed out', async () => {
    // #given the tmpfs mount hangs
    const model = createModel({hangOn: argv => argv.includes('tmpfs')})

    // #when the builder runs
    await runSandboxViewChild(model.io)

    // #then
    expect(String(reported(model).detail)).toMatch(/^timed out/)
  })

  it('treats an operation that exceeds its deadline as a failure', async () => {
    // #given the tmpfs mount hangs
    const model = createModel({hangOn: argv => argv.includes('tmpfs')})

    // #when the builder runs
    const code = await runSandboxViewChild(model.io)

    // #then it stops without binding any root
    expect(code).toBe(SANDBOX_VIEW_EXIT_FAILED)
    expect(reported(model)).toMatchObject({view: 'failed', stage: 'temp'})
    expect(model.ran.some(argv => argv.includes('--bind'))).toBe(false)
  })

  it('stops when the whole build runs out of time', async () => {
    // #given a clock that is already past the total budget after the first operation
    const model = createModel()
    let tick = 0
    const io: SandboxViewChildIo = {...model.io, now: () => tick, totalTimeoutMs: 100}
    const run = model.io.run
    const timed: SandboxViewChildIo = {
      ...io,
      run: async (argv, timeoutMs) => {
        tick += 200
        return run(argv, timeoutMs)
      },
    }

    // #when the builder runs
    const code = await runSandboxViewChild(timed)

    // #then it did not carry on
    expect(code).toBe(SANDBOX_VIEW_EXIT_FAILED)
    expect(model.ran).toHaveLength(1)
  })

  it('fails when a remount silently does nothing, which is what the table check is for', async () => {
    // #given a nested mount whose remount is ignored, as `ro=recursive` ignores submounts
    const model = createModel({ignoreRemountOf: `${ROOT}/dev`})

    // #when the builder runs
    const code = await runSandboxViewChild(model.io)

    // #then every operation succeeded and the verification still refused the view
    expect(code).toBe(SANDBOX_VIEW_EXIT_FAILED)
    expect(reported(model)).toMatchObject({view: 'failed', stage: 'verify'})
  })

  it('fails when the put-old directory is not empty', async () => {
    // #given something in the directory the old root would move onto
    const model = createModel({notEmpty: [`${ROOT}/mnt`]})

    // #when the builder runs
    const code = await runSandboxViewChild(model.io)

    // #then it is refused before the verification
    expect(code).toBe(SANDBOX_VIEW_EXIT_FAILED)
    expect(reported(model)).toMatchObject({view: 'failed', stage: 'enter'})
  })

  it('creates the mount point of a root under a private temp directory', async () => {
    // #given a writable root beneath /tmp
    const policy = {...POLICY, writable: [...POLICY.writable, '/tmp/run/out']}
    const model = createModel({policyText: JSON.stringify(policy)})

    // #when the builder runs
    const code = await runSandboxViewChild(model.io)

    // #then the directory was made on the fresh tmpfs and the view verified
    expect(code).toBe(0)
    expect(model.made).toEqual([`${ROOT}/tmp/run/out`])
  })

  it('reports a thrown tool failure as a failure, not a crash', async () => {
    // #given a runner that throws
    const model = createModel()
    const io: SandboxViewChildIo = {
      ...model.io,
      run: async () => {
        throw new Error('spawn failed')
      },
    }

    // #when the builder runs
    // #then it is a failed bind that carries the error's message
    expect(await runSandboxViewChild(io)).toBe(SANDBOX_VIEW_EXIT_FAILED)
    expect(reported(model)).toMatchObject({
      view: 'failed',
      stage: 'bind',
      op: `mount -n -o rbind / ${ROOT}`,
      detail: 'spawn failed',
    })
  })
})
