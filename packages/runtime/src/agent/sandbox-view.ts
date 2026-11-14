import type {Result} from '../shared/types.js'
import path from 'node:path'
import {isWithin} from '../shared/path-within.js'
import {err, ok} from '../shared/types.js'

/**
 * The read-only filesystem view of the `isolate-agent` sandbox: pure planning and verification.
 *
 * The launch runs the view builder as root inside a private mount namespace. The builder binds `/` recursively onto a
 * new root, remounts every mount under it read-only, mounts private temp directories, binds the declared roots back
 * and then checks the kernel's mount table. A fixed step afterwards enters the new root and drops the user.
 *
 * Nothing here runs a command. The mount table goes in and ordered operations or a verdict come out, so the rules are
 * testable without root. `sandbox-view-child.ts` runs the operations.
 */

/** Private tmpfs mounts of the view. Everything the agent writes there vanishes with the namespace. */
export const SANDBOX_VIEW_TEMP_MOUNTS = [
  {path: '/tmp', size: '1g'},
  {path: '/var/tmp', size: '1g'},
  {path: '/dev/shm', size: '512m'},
] as const

/** The stacked mount the hosted images carry on `/proc/sys/fs/binfmt_misc`: an autofs trigger under the real mount. */
const BINFMT_MISC_PATH = '/proc/sys/fs/binfmt_misc'

export type SandboxViewStage = 'bind' | 'detach' | 'enter' | 'policy' | 'roots' | 'seal' | 'temp' | 'verify'

export interface SandboxViewPolicy {
  /** An empty directory that becomes the view's root. Created by the Action, empty, and not under any listed root. */
  readonly newRoot: string
  /** A directory inside the new root, named as the new root sees it, that holds the old root until it is unmounted. */
  readonly putOld: string
  readonly tools: {readonly mount: string; readonly umount: string}
  /** Bound back read-write. The checkout, the handed-over directories and the account's home. */
  readonly writable: readonly string[]
  /** Bound back read-only. The inputs the Action puts in front of the agent. */
  readonly readOnly: readonly string[]
  /** A writable root may not be, contain or lie under these two. */
  readonly runnerHome: string
  readonly actionsDir: string
}

/** One line of `/proc/self/mountinfo`, reduced to what the view needs. */
export interface MountEntry {
  readonly id: number
  readonly parentId: number
  readonly mountPoint: string
  /** The per-mount options (`rw`, `ro`, `nosuid`, ...). The superblock options are not read. */
  readonly options: readonly string[]
  readonly fsType: string
}

export type ViewOp =
  | {readonly kind: 'mkdir'; readonly stage: SandboxViewStage; readonly path: string}
  | {readonly kind: 'mount' | 'umount'; readonly stage: SandboxViewStage; readonly argv: readonly string[]}

/** The kernel escapes a space, a tab, a newline and a backslash in a mount path as `\040`, `\011`, `\012` and `\134`. */
export function decodeMountPath(escaped: string): string {
  return escaped.replaceAll(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCodePoint(Number.parseInt(octal, 8)))
}

export function parseMountInfo(text: string): Result<readonly MountEntry[], string> {
  const entries: MountEntry[] = []
  for (const raw of text.split('\n')) {
    if (raw.length === 0) continue
    const fields = raw.split(' ')
    const separator = fields.indexOf('-', 6)
    if (separator === -1 || fields.length < separator + 2) return err('a mountinfo line has no separator')
    const id = Number.parseInt(fields[0] ?? '', 10)
    const parentId = Number.parseInt(fields[1] ?? '', 10)
    const mountPoint = fields[4]
    const options = fields[5]
    const fsType = fields[separator + 1]
    if (Number.isNaN(id) || Number.isNaN(parentId) || mountPoint === undefined || options === undefined) {
      return err('a mountinfo line could not be read')
    }
    if (fsType === undefined) return err('a mountinfo line has no filesystem type')
    entries.push({id, parentId, mountPoint: decodeMountPath(mountPoint), options: options.split(','), fsType})
  }
  return ok(entries)
}

function isNormalizedAbsolute(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    (value === '/' || !value.endsWith('/'))
  )
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  const items: unknown[] = value
  return items.every(isNormalizedAbsolute) ? items : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parses the policy the Action hands the builder as data. Every path must be absolute and normalized. */
export function parseSandboxViewPolicy(value: unknown): Result<SandboxViewPolicy, string> {
  if (!isRecord(value)) return err('the view policy is not an object')
  const {newRoot, putOld, tools, writable, readOnly, runnerHome, actionsDir} = value
  const writableRoots = stringList(writable)
  const readOnlyRoots = stringList(readOnly)
  if (!isNormalizedAbsolute(newRoot) || newRoot === '/') return err('the view policy has no usable new root')
  if (!isNormalizedAbsolute(putOld) || putOld === '/') return err('the view policy has no usable put-old directory')
  if (!isRecord(tools) || !isNormalizedAbsolute(tools.mount) || !isNormalizedAbsolute(tools.umount)) {
    return err('the view policy has no absolute tool paths')
  }
  if (writableRoots === null || readOnlyRoots === null) return err('the view policy roots are not absolute paths')
  if (!isNormalizedAbsolute(runnerHome) || !isNormalizedAbsolute(actionsDir)) {
    return err('the view policy has no protected paths')
  }
  return ok({
    newRoot,
    putOld,
    tools: {mount: tools.mount, umount: tools.umount},
    writable: writableRoots,
    readOnly: readOnlyRoots,
    runnerHome,
    actionsDir,
  })
}

function depth(value: string): number {
  return value.split('/').length
}

/** Deepest first; equal depth in name order so a plan is deterministic. */
function deepestFirst(a: string, b: string): number {
  return depth(b) - depth(a) || a.localeCompare(b)
}

/** Parents before children; equal depth in name order. */
function parentsFirst(a: string, b: string): number {
  return depth(a) - depth(b) || a.localeCompare(b)
}

function isStrictlyWithin(parent: string, child: string): boolean {
  return parent !== child && isWithin(parent, child)
}

/**
 * Refuses a policy the view cannot honor, before any operation runs. `mounts` is the host's table; mounts under the new
 * root (present when the table was read after the bind) are ignored.
 */
export function validateViewPolicy(policy: SandboxViewPolicy, mounts: readonly MountEntry[]): Result<void, string> {
  const roots = [...policy.writable, ...policy.readOnly]
  if (new Set(roots).size !== roots.length) return err('a root is listed more than once')

  for (const root of roots) {
    if (isWithin(policy.newRoot, root) || isWithin(root, policy.newRoot)) {
      return err(`the root ${root} overlaps the new root`)
    }
    for (const temp of SANDBOX_VIEW_TEMP_MOUNTS) {
      if (isWithin(root, temp.path)) return err(`the root ${root} is or contains the private temp mount ${temp.path}`)
    }
  }
  for (const root of policy.writable) {
    if (isWithin(root, policy.runnerHome)) return err(`the writable root ${root} is or contains the runner home`)
    if (isWithin(root, policy.actionsDir)) return err(`the writable root ${root} is or contains the actions directory`)
  }

  const covered = [...roots, ...SANDBOX_VIEW_TEMP_MOUNTS.map(temp => temp.path)]
  if (covered.some(parent => isWithin(parent, policy.putOld))) {
    return err('the put-old directory lies under a mount that is made after the bind')
  }

  const hostMounts = mounts.filter(mount => !isWithin(policy.newRoot, mount.mountPoint))
  for (const root of roots) {
    const beneath = hostMounts.find(mount => isStrictlyWithin(root, mount.mountPoint))
    if (beneath !== undefined) return err(`the root ${root} has a mount beneath it: ${beneath.mountPoint}`)
  }
  return ok(undefined)
}

/** The recursive bind of `/` onto the new root. Everything else is planned from the table this leaves. */
export function planViewBind(policy: SandboxViewPolicy): ViewOp {
  return {kind: 'mount', stage: 'bind', argv: [policy.tools.mount, '-n', '-o', 'rbind', '/', policy.newRoot]}
}

function mountAt(policy: SandboxViewPolicy, relative: string): string {
  return relative === '/' ? policy.newRoot : `${policy.newRoot}${relative}`
}

/**
 * The operations that follow the recursive bind, planned from the table it left:
 * 1. detach the stacked `binfmt_misc` mounts (the covered autofs trigger stays writable under any remount order);
 * 2. remount every other mount under the new root read-only, deepest first, with `remount,bind,ro`: a plain remount would
 *    change the host's superblock, and `ro=recursive` silently skips submounts;
 * 3. mount the private temp directories;
 * 4. bind the listed roots back from their real paths, parents before children.
 */
export function planViewSeal(
  policy: SandboxViewPolicy,
  mounts: readonly MountEntry[],
): Result<readonly ViewOp[], string> {
  const under = mounts.filter(mount => isWithin(policy.newRoot, mount.mountPoint))
  if (under.length === 0) return err('the recursive bind left no mount under the new root')

  const ops: ViewOp[] = []
  const binfmt = `${policy.newRoot}${BINFMT_MISC_PATH}`
  // The most recent mount first: each lazy detach uncovers the one beneath, and one detach per mount clears the stack.
  const detached = under.filter(mount => mount.mountPoint === binfmt).toSorted((a, b) => b.id - a.id)
  for (const mount of detached) {
    ops.push({kind: 'umount', stage: 'detach', argv: [policy.tools.umount, '-l', mount.mountPoint]})
  }

  const sealed = [...new Set(under.filter(mount => mount.mountPoint !== binfmt).map(mount => mount.mountPoint))]
  for (const mountPoint of sealed.toSorted(deepestFirst)) {
    ops.push({kind: 'mount', stage: 'seal', argv: [policy.tools.mount, '-n', '-o', 'remount,bind,ro', mountPoint]})
  }

  for (const temp of SANDBOX_VIEW_TEMP_MOUNTS) {
    ops.push({
      kind: 'mount',
      stage: 'temp',
      argv: [
        policy.tools.mount,
        '-n',
        '-t',
        'tmpfs',
        '-o',
        `mode=1777,size=${temp.size},nosuid,nodev`,
        'tmpfs',
        mountAt(policy, temp.path),
      ],
    })
  }

  const roots = [
    ...policy.writable.map(root => ({root, mode: 'rw' as const})),
    ...policy.readOnly.map(root => ({root, mode: 'ro' as const})),
  ].toSorted((a, b) => parentsFirst(a.root, b.root))
  for (const {root, mode} of roots) {
    const target = mountAt(policy, root)
    // A directory on the fresh tmpfs does not exist yet. Anywhere else the real path is already in the bound tree.
    if (SANDBOX_VIEW_TEMP_MOUNTS.some(temp => isWithin(temp.path, root))) {
      ops.push({kind: 'mkdir', stage: 'roots', path: target})
    }
    ops.push({kind: 'mount', stage: 'roots', argv: [policy.tools.mount, '-n', '--bind', root, target]})
    ops.push({kind: 'mount', stage: 'roots', argv: [policy.tools.mount, '-n', '-o', `remount,bind,${mode}`, target]})
  }
  return ok(ops)
}

function isReadOnly(mount: MountEntry): boolean {
  return mount.options.includes('ro')
}

/**
 * Checks the table the build left, by mount id. Every mount under the new root must be read-only, except the topmost
 * mount at each declared writable path, and every declared mount must be there with its declared mode. Mounts stacked
 * on one path are each judged: a covered writable mount is still writable.
 */
export function verifyView(policy: SandboxViewPolicy, mounts: readonly MountEntry[]): Result<void, string> {
  const under = mounts.filter(mount => isWithin(policy.newRoot, mount.mountPoint))
  const relative = (mount: MountEntry): string =>
    mount.mountPoint === policy.newRoot ? '/' : mount.mountPoint.slice(policy.newRoot.length)

  const temp = new Set<string>(SANDBOX_VIEW_TEMP_MOUNTS.map(mount => mount.path))
  const writable = new Set<string>([...temp, ...policy.writable])
  const readOnly = new Set<string>(policy.readOnly)

  const byPath = new Map<string, MountEntry[]>()
  for (const mount of under) {
    const key = relative(mount)
    byPath.set(key, [...(byPath.get(key) ?? []), mount])
  }

  for (const [key, stacked] of byPath) {
    const top = stacked.reduce((latest, mount) => (mount.id > latest.id ? mount : latest))
    for (const mount of stacked) {
      const mayWrite = writable.has(key) && mount === top
      if (mayWrite) {
        if (isReadOnly(mount))
          return err(`the declared writable mount ${mount.mountPoint} (id ${mount.id}) is read-only`)
        if (temp.has(key) && mount.fsType !== 'tmpfs') {
          return err(`the private temp mount ${mount.mountPoint} (id ${mount.id}) is not a tmpfs`)
        }
      } else if (!isReadOnly(mount)) {
        return err(`the mount ${mount.mountPoint} (id ${mount.id}) is writable`)
      }
    }
  }
  for (const declared of [...writable, ...readOnly]) {
    if (!byPath.has(declared)) return err(`the declared mount ${declared} is missing`)
  }
  return ok(undefined)
}
