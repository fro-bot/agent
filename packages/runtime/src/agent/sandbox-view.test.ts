import type {MountEntry, SandboxViewPolicy} from './sandbox-view.js'
import {describe, expect, it} from 'vitest'
import {
  decodeMountPath,
  parseMountInfo,
  parseSandboxViewPolicy,
  planViewBind,
  planViewSeal,
  SANDBOX_VIEW_TEMP_MOUNTS,
  validateViewPolicy,
  verifyView,
} from './sandbox-view.js'

const ROOT = '/run/view/root'

function policy(overrides: Partial<SandboxViewPolicy> = {}): SandboxViewPolicy {
  return {
    newRoot: ROOT,
    putOld: '/mnt',
    tools: {mount: '/usr/bin/mount', umount: '/usr/bin/umount'},
    writable: ['/home/runner/work/repo/repo', '/home/fro-bot-sandbox'],
    readOnly: ['/home/runner/work/_temp/attachments'],
    runnerHome: '/home/runner',
    actionsDir: '/home/runner/work/_actions',
    ...overrides,
  }
}

function entry(id: number, mountPoint: string, options = 'rw', fsType = 'ext4'): MountEntry {
  return {id, parentId: 1, mountPoint, options: options.split(','), fsType}
}

/** One mountinfo line in the kernel's format. */
function line(id: number, mountPoint: string, options = 'rw,relatime', fsType = 'ext4'): string {
  const escaped = mountPoint
    .replaceAll('\\', String.raw`\134`)
    .replaceAll(' ', String.raw`\040`)
    .replaceAll('\n', String.raw`\012`)
  return `${id} 1 8:1 / ${escaped} ${options} shared:1 - ${fsType} /dev/sda1 rw`
}

/** The mounts under the new root after the recursive bind: the root, two real nested mounts and the host's /tmp. */
function boundTable(): MountEntry[] {
  return [
    entry(100, ROOT),
    entry(101, `${ROOT}/proc`, 'rw', 'proc'),
    entry(102, `${ROOT}/proc/sys/fs/binfmt_misc`, 'rw', 'binfmt_misc'),
    entry(103, `${ROOT}/dev`, 'rw', 'devtmpfs'),
    entry(104, `${ROOT}/dev/shm`, 'rw', 'tmpfs'),
    entry(99, '/', 'rw'),
    entry(98, '/home/runner/work/repo/repo', 'rw'),
  ]
}

describe('decodeMountPath', () => {
  it('decodes the kernel octal escapes for space, tab, newline and backslash', () => {
    // #given an escaped mount point
    // #when decoded
    // #then every escape is one character
    expect(decodeMountPath(String.raw`/mnt/a\040b\011c\012d\134e`)).toBe('/mnt/a b\tc\nd\\e')
  })
})

describe('parseMountInfo', () => {
  it('reads the mount point, the per-mount options and the filesystem type', () => {
    // #given a line with optional fields before the separator
    const text = `${line(36, '/mnt/with space', 'ro,nosuid')}\n${line(37, '/data')}\n`

    // #when parsed
    const parsed = parseMountInfo(text)

    // #then the escaped path is decoded and the per-mount options are read from the right field
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toEqual([
      {id: 36, parentId: 1, mountPoint: '/mnt/with space', options: ['ro', 'nosuid'], fsType: 'ext4'},
      {id: 37, parentId: 1, mountPoint: '/data', options: ['rw', 'relatime'], fsType: 'ext4'},
    ])
  })

  it('reads a line with no optional fields', () => {
    // #given the separator directly after the options
    const text = '40 1 0:20 / /sys rw,nosuid - sysfs sysfs rw\n'

    // #when parsed
    const parsed = parseMountInfo(text)

    // #then the filesystem type is the field after the separator
    expect(parsed.success && parsed.data[0]?.fsType).toBe('sysfs')
  })

  it('refuses a line it cannot read', () => {
    // #given a truncated line
    // #when parsed
    const parsed = parseMountInfo('36 35 98:0\n')

    // #then the whole table is refused, never half-read
    expect(parsed.success).toBe(false)
  })
})

describe('parseSandboxViewPolicy', () => {
  it('accepts a complete policy', () => {
    // #given a policy as JSON data
    // #when parsed
    const parsed = parseSandboxViewPolicy(JSON.parse(JSON.stringify(policy())))

    // #then it round-trips
    expect(parsed).toEqual({success: true, data: policy()})
  })

  it.each([
    ['a relative root', {writable: ['relative/dir']}],
    ['a root with a dot-dot segment', {writable: ['/home/runner/../etc']}],
    ['a root with a trailing slash', {readOnly: ['/data/']}],
    ['a relative tool path', {tools: {mount: 'mount', umount: '/usr/bin/umount'}}],
    ['the filesystem root as the new root', {newRoot: '/'}],
    ['a relative put-old', {putOld: 'mnt'}],
  ])('refuses %s', (_name, overrides) => {
    // #given a policy with one bad field
    // #when parsed
    const parsed = parseSandboxViewPolicy(JSON.parse(JSON.stringify(policy(overrides))))

    // #then it is refused
    expect(parsed.success).toBe(false)
  })

  it('refuses a value that is not a policy', () => {
    // #given data of the wrong shape
    // #when parsed
    // #then it is refused
    expect(parseSandboxViewPolicy({writable: 'nope'}).success).toBe(false)
    expect(parseSandboxViewPolicy(null).success).toBe(false)
  })
})

describe('validateViewPolicy', () => {
  it('accepts a policy whose roots have no mount beneath them', () => {
    // #given the host table
    // #when validated
    // #then it is accepted
    expect(validateViewPolicy(policy(), [entry(1, '/'), entry(2, '/proc', 'rw', 'proc')]).success).toBe(true)
  })

  it('refuses a writable root with a mount beneath it and names the mount', () => {
    // #given a mount inside the checkout
    const mounts = [entry(1, '/'), entry(2, '/home/runner/work/repo/repo/node_modules')]

    // #when validated
    const result = validateViewPolicy(policy(), mounts)

    // #then it is refused before anything is mounted
    expect(!result.success && result.error).toContain('/home/runner/work/repo/repo/node_modules')
  })

  it('does not count the mounts of the new root itself', () => {
    // #given mounts that exist only because the view was already bound
    const mounts = [entry(1, '/'), entry(2, `${ROOT}/home/runner/work/repo/repo/node_modules`)]

    // #when validated
    // #then they are not beneath the real root
    expect(validateViewPolicy(policy(), mounts).success).toBe(true)
  })

  it.each([
    ['equals the runner home', {writable: ['/home/runner'], actionsDir: '/opt/actions'}],
    ['contains the runner home', {writable: ['/home'], actionsDir: '/opt/actions'}],
    ['contains the actions directory', {writable: ['/home/runner/work'], runnerHome: '/root'}],
    ['equals the actions directory', {writable: ['/home/runner/work/_actions'], runnerHome: '/root'}],
    ['is the filesystem root', {writable: ['/']}],
  ])('refuses a writable root that %s', (_name, overrides) => {
    // #given a writable root that would open a protected tree
    // #when validated
    const result = validateViewPolicy(policy(overrides), [entry(1, '/')])

    // #then it is refused
    expect(result.success).toBe(false)
  })

  it('refuses a root that is, or contains, a private temp mount', () => {
    // #given roots that collide with /tmp and /var
    // #when validated
    // #then both are refused
    expect(validateViewPolicy(policy({writable: ['/tmp']}), [entry(1, '/')]).success).toBe(false)
    expect(validateViewPolicy(policy({readOnly: ['/var']}), [entry(1, '/')]).success).toBe(false)
  })

  it('refuses the same root listed twice', () => {
    // #given a root that is both writable and read-only
    // #when validated
    const result = validateViewPolicy(policy({readOnly: ['/home/fro-bot-sandbox']}), [entry(1, '/')])

    // #then the ambiguity is refused
    expect(result.success).toBe(false)
  })

  it('refuses a root that contains or lies inside the new root', () => {
    // #given a root inside the new root and one containing it
    // #when validated
    // #then both are refused
    expect(validateViewPolicy(policy({readOnly: [`${ROOT}/inner`]}), [entry(1, '/')]).success).toBe(false)
    expect(validateViewPolicy(policy({readOnly: ['/run']}), [entry(1, '/')]).success).toBe(false)
  })

  it('refuses a put-old directory under a private temp mount or a listed root', () => {
    // #given a put-old that would be covered by a later mount
    // #when validated
    // #then it is refused
    expect(validateViewPolicy(policy({putOld: '/tmp/old'}), [entry(1, '/')]).success).toBe(false)
    expect(validateViewPolicy(policy({putOld: '/home/fro-bot-sandbox/old'}), [entry(1, '/')]).success).toBe(false)
  })
})

describe('planViewBind', () => {
  it('binds the whole tree onto the new root recursively', () => {
    // #given a policy
    // #when the first operation is planned
    const op = planViewBind(policy())

    // #then it is the recursive bind of / by absolute tool path
    expect(op).toEqual({
      kind: 'mount',
      stage: 'bind',
      argv: ['/usr/bin/mount', '-n', '-o', 'rbind', '/', ROOT],
    })
  })
})

describe('planViewSeal', () => {
  it('detaches the binfmt_misc stack, remounts every mount read-only deepest first, then mounts temp and binds roots back', () => {
    // #given the table after the recursive bind
    // #when planned
    const plan = planViewSeal(policy(), boundTable())

    // #then the stages come in order
    expect(plan.success).toBe(true)
    if (!plan.success) return
    expect(plan.data.map(op => op.stage)).toEqual([
      'detach',
      'seal',
      'seal',
      'seal',
      'seal',
      'temp',
      'temp',
      'temp',
      'roots',
      'roots',
      'roots',
      'roots',
      'roots',
      'roots',
    ])

    // #and the binfmt_misc mount is detached lazily, never remounted
    expect(plan.data[0]).toEqual({
      kind: 'umount',
      stage: 'detach',
      argv: ['/usr/bin/umount', '-l', `${ROOT}/proc/sys/fs/binfmt_misc`],
    })
    const sealed = plan.data.filter(op => op.stage === 'seal').map(op => (op.kind === 'mkdir' ? '' : op.argv.at(-1)))
    expect(sealed).toEqual([`${ROOT}/proc`, `${ROOT}/dev/shm`, `${ROOT}/dev`, ROOT].toSorted(byDepthThenName))
    // #and every remount is a bind remount, never a plain one
    for (const op of plan.data.filter(candidate => candidate.stage === 'seal')) {
      expect(op.kind === 'mkdir' ? [] : op.argv.slice(0, 4)).toEqual(['/usr/bin/mount', '-n', '-o', 'remount,bind,ro'])
    }
  })

  it('remounts the deepest mount first', () => {
    // #given nested mounts
    // #when planned
    const plan = planViewSeal(policy(), boundTable())

    // #then no mount is remounted before a mount beneath it
    expect(plan.success).toBe(true)
    if (!plan.success) return
    const order = plan.data
      .filter(op => op.stage === 'seal')
      .map(op => (op.kind === 'mkdir' ? '' : (op.argv.at(-1) ?? '')))
    for (const [index, mountPoint] of order.entries()) {
      for (const later of order.slice(index + 1)) expect(later.startsWith(`${mountPoint}/`)).toBe(false)
    }
    expect(order.at(-1)).toBe(ROOT)
  })

  it('mounts private tmpfs on /tmp, /var/tmp and /dev/shm before binding any root', () => {
    // #given a policy
    // #when planned
    const plan = planViewSeal(policy(), boundTable())

    // #then each temp mount is a fresh tmpfs with a size bound
    expect(plan.success).toBe(true)
    if (!plan.success) return
    const temp = plan.data.filter(op => op.stage === 'temp')
    expect(temp.map(op => (op.kind === 'mkdir' ? '' : op.argv.at(-1)))).toEqual(
      SANDBOX_VIEW_TEMP_MOUNTS.map(mount => `${ROOT}${mount.path}`),
    )
    for (const op of temp) {
      expect(op.kind === 'mkdir' ? [] : op.argv.slice(0, 5)).toEqual(['/usr/bin/mount', '-n', '-t', 'tmpfs', '-o'])
      expect(op.kind === 'mkdir' ? '' : (op.argv[5] ?? '')).toMatch(/mode=1777,size=\d+[mg]/)
    }
  })

  it('binds writable roots read-write and read-only inputs read-only, parents before children', () => {
    // #given a read-only input nested under a writable root
    const nested = policy({
      writable: ['/home/runner/work/repo/repo', '/home/runner/work/repo/repo/sub'],
      readOnly: ['/home/runner/work/repo/repo/sub/input'],
    })

    // #when planned
    const plan = planViewSeal(nested, boundTable())

    // #then the roots are bound parent first, each with its own mode
    expect(plan.success).toBe(true)
    if (!plan.success) return
    const roots = plan.data.filter(op => op.stage === 'roots').flatMap(op => (op.kind === 'mkdir' ? [] : [op.argv]))
    expect(roots).toEqual([
      ['/usr/bin/mount', '-n', '--bind', '/home/runner/work/repo/repo', `${ROOT}/home/runner/work/repo/repo`],
      ['/usr/bin/mount', '-n', '-o', 'remount,bind,rw', `${ROOT}/home/runner/work/repo/repo`],
      ['/usr/bin/mount', '-n', '--bind', '/home/runner/work/repo/repo/sub', `${ROOT}/home/runner/work/repo/repo/sub`],
      ['/usr/bin/mount', '-n', '-o', 'remount,bind,rw', `${ROOT}/home/runner/work/repo/repo/sub`],
      [
        '/usr/bin/mount',
        '-n',
        '--bind',
        '/home/runner/work/repo/repo/sub/input',
        `${ROOT}/home/runner/work/repo/repo/sub/input`,
      ],
      ['/usr/bin/mount', '-n', '-o', 'remount,bind,ro', `${ROOT}/home/runner/work/repo/repo/sub/input`],
    ])
  })

  it('creates the mount point of a root that lies under a private temp directory, and binds it after the tmpfs', () => {
    // #given a writable root and a read-only input beneath /tmp
    const underTmp = policy({writable: ['/tmp/run/out'], readOnly: ['/tmp/run/in']})

    // #when planned
    const plan = planViewSeal(underTmp, boundTable())

    // #then the directories are made on the fresh tmpfs, after it is mounted and before the bind
    expect(plan.success).toBe(true)
    if (!plan.success) return
    const steps = plan.data.map(
      op => `${op.stage}:${op.kind}:${op.kind === 'mkdir' ? op.path : (op.argv.at(-1) ?? '')}`,
    )
    const tmpfsAt = steps.indexOf(`temp:mount:${ROOT}/tmp`)
    const mkdirAt = steps.indexOf(`roots:mkdir:${ROOT}/tmp/run/out`)
    const bindAt = steps.indexOf(`roots:mount:${ROOT}/tmp/run/out`)
    expect(tmpfsAt).toBeGreaterThanOrEqual(0)
    expect(mkdirAt).toBeGreaterThan(tmpfsAt)
    expect(bindAt).toBeGreaterThan(mkdirAt)
    // #and a root outside every temp directory needs no mkdir
    expect(steps.some(step => step.startsWith(`roots:mkdir:${ROOT}/home`))).toBe(false)
  })

  it('escapes nothing: a mount point with a space is remounted as one argument', () => {
    // #given a mount whose decoded path has a space
    const table = [...boundTable(), entry(105, `${ROOT}/mnt/with space`)]

    // #when planned
    const plan = planViewSeal(policy(), table)

    // #then the path is one argv entry, decoded
    expect(plan.success).toBe(true)
    if (!plan.success) return
    expect(plan.data.some(op => op.kind === 'mount' && op.argv.at(-1) === `${ROOT}/mnt/with space`)).toBe(true)
  })

  it('plans one remount for two mounts stacked on one path', () => {
    // #given a stack other than binfmt_misc: the remount reaches only the top mount
    const table = [...boundTable(), entry(110, `${ROOT}/srv`), entry(111, `${ROOT}/srv`)]

    // #when planned
    const plan = planViewSeal(policy(), table)

    // #then the path is remounted once, and the verification (by mount id) decides about the covered one
    expect(plan.success).toBe(true)
    if (!plan.success) return
    expect(plan.data.filter(op => op.kind === 'mount' && op.argv.at(-1) === `${ROOT}/srv`)).toHaveLength(1)
  })

  it('detaches every mount of a stacked binfmt_misc path', () => {
    // #given the doubled binfmt_misc mount of the hosted images
    const table = [...boundTable(), entry(90, `${ROOT}/proc/sys/fs/binfmt_misc`, 'rw', 'autofs')]

    // #when planned
    const plan = planViewSeal(policy(), table)

    // #then one lazy detach per mount, so neither survives
    expect(plan.success).toBe(true)
    if (!plan.success) return
    expect(plan.data.filter(op => op.stage === 'detach')).toHaveLength(2)
  })

  it('refuses a table with no mount under the new root', () => {
    // #given a table where the recursive bind did nothing
    // #when planned
    const plan = planViewSeal(policy(), [entry(1, '/')])

    // #then it is refused
    expect(plan.success).toBe(false)
  })
})

/** The table a correct build leaves: everything read-only except the temp mounts and the listed writable roots. */
function sealedTable(): MountEntry[] {
  return [
    entry(100, ROOT, 'ro'),
    entry(101, `${ROOT}/proc`, 'ro', 'proc'),
    entry(103, `${ROOT}/dev`, 'ro', 'devtmpfs'),
    entry(104, `${ROOT}/dev/shm`, 'ro', 'tmpfs'),
    entry(120, `${ROOT}/dev/shm`, 'rw,nosuid', 'tmpfs'),
    entry(121, `${ROOT}/tmp`, 'rw', 'tmpfs'),
    entry(122, `${ROOT}/var/tmp`, 'rw', 'tmpfs'),
    entry(123, `${ROOT}/home/runner/work/repo/repo`, 'rw'),
    entry(124, `${ROOT}/home/fro-bot-sandbox`, 'rw'),
    entry(125, `${ROOT}/home/runner/work/_temp/attachments`, 'ro'),
    entry(1, '/', 'rw'),
  ]
}

describe('verifyView', () => {
  it('accepts a table where only the writable roots and temp mounts are writable', () => {
    // #given a correct build
    // #when verified
    // #then it passes, the covered read-only /dev/shm included
    expect(verifyView(policy(), sealedTable()).success).toBe(true)
  })

  it('rejects an undeclared writable mount and names it', () => {
    // #given one mount left writable
    const table = sealedTable().map(item => (item.mountPoint === `${ROOT}/dev` ? {...item, options: ['rw']} : item))

    // #when verified
    const result = verifyView(policy(), table)

    // #then it is refused and the mount is named
    expect(!result.success && result.error).toContain(`${ROOT}/dev`)
  })

  it('rejects the covered mount of a stack when it is writable, by mount id', () => {
    // #given two mounts on one path, the bottom one writable
    const table = [...sealedTable(), entry(130, `${ROOT}/srv`, 'rw'), entry(131, `${ROOT}/srv`, 'ro')]

    // #when verified
    const result = verifyView(policy(), table)

    // #then the writable one is found even though the path resolves to the read-only one
    expect(!result.success && result.error).toContain('130')
  })

  it('rejects a writable mount covered by a declared temp mount', () => {
    // #given the host's /dev/shm left writable under our tmpfs
    const table = sealedTable().map(item => (item.id === 104 ? {...item, options: ['rw']} : item))

    // #when verified
    // #then the covered writable mount is refused
    expect(verifyView(policy(), table).success).toBe(false)
  })

  it('rejects a read-only mount where a writable root was declared', () => {
    // #given the checkout bound back read-only
    const table = sealedTable().map(item => (item.id === 123 ? {...item, options: ['ro']} : item))

    // #when verified
    // #then the agent would have no checkout to write: refused
    expect(verifyView(policy(), table).success).toBe(false)
  })

  it('rejects a read-only input that is writable', () => {
    // #given an input bound read-write
    const table = sealedTable().map(item => (item.id === 125 ? {...item, options: ['rw']} : item))

    // #when verified
    // #then it is refused
    expect(verifyView(policy(), table).success).toBe(false)
  })

  it('rejects a temp mount that is not a tmpfs', () => {
    // #given /tmp backed by the host's filesystem
    const table = sealedTable().map(item => (item.id === 121 ? {...item, fsType: 'ext4'} : item))

    // #when verified
    // #then the agent's temp files would survive the run: refused
    expect(verifyView(policy(), table).success).toBe(false)
  })

  it('rejects a table that is missing a declared mount', () => {
    // #given no mount for the checkout
    const table = sealedTable().filter(item => item.id !== 123)

    // #when verified
    // #then it is refused
    expect(verifyView(policy(), table).success).toBe(false)
  })

  it('ignores the host mounts outside the new root', () => {
    // #given a writable host mount (the real root) beside a correct view
    // #when verified
    // #then only the new root's mounts are judged
    expect(verifyView(policy(), sealedTable()).success).toBe(true)
  })
})

function byDepthThenName(a: string, b: string): number {
  const depth = (value: string): number => value.split('/').length
  return depth(b) - depth(a) || a.localeCompare(b)
}
