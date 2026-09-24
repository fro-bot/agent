import type {HandoffOps} from './handoff.js'

import {describe, expect, it, vi} from 'vitest'
import {handOffToAgent} from './handoff.js'

const TARGET_UID = 10_001
const TARGET_GID = 10_001
const ROOT_DEV = 42

interface FakeNode {
  readonly path: string
  readonly dev?: number
  readonly nlink?: number
  readonly mode?: number
  readonly kind: 'dir' | 'file' | 'symlink' | 'fifo'
  readonly children?: readonly string[]
}

/** Builds injectable HandoffOps backed by an in-memory map of path -> FakeNode, plus spies. */
function makeFakeOps(nodes: readonly FakeNode[]): HandoffOps & {
  readonly lchownCalls: [string, number, number][]
  readonly chmodCalls: [string, number][]
} {
  const byPath = new Map(nodes.map(n => [n.path, n]))
  const lchownCalls: [string, number, number][] = []
  const chmodCalls: [string, number][] = []

  const lstat = vi.fn().mockImplementation(async (path: string) => {
    const node = byPath.get(path)
    if (node === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), {code: 'ENOENT'})
    const stats = {
      dev: node.dev ?? ROOT_DEV,
      nlink: node.nlink ?? 1,
      mode: node.mode ?? (node.kind === 'dir' ? 0o755 : 0o644),
      isSymbolicLink: () => node.kind === 'symlink',
      isDirectory: () => node.kind === 'dir',
      isFile: () => node.kind === 'file',
    }
    return stats
  })

  const readdir = vi.fn().mockImplementation(async (path: string) => {
    const node = byPath.get(path)
    if (node?.children === undefined) return []
    return node.children.map(child => child.split('/').pop() ?? child)
  })

  const lchown = vi.fn().mockImplementation(async (path: string, uid: number, gid: number) => {
    lchownCalls.push([path, uid, gid])
  })

  const chmod = vi.fn().mockImplementation(async (path: string, mode: number) => {
    chmodCalls.push([path, mode])
  })

  return {lstat, readdir, lchown, chmod, lchownCalls, chmodCalls}
}

describe('handOffToAgent — happy path', () => {
  it('chowns every entry in a nested tree, including an executable file, and never the symlink target', async () => {
    // #given — root/dir1/file.txt (0644), root/dir1/exec.sh (0755, executable),
    // root/link -> /outside/target (a path never registered as a node)
    const ops = makeFakeOps([
      {path: '/staging/root', kind: 'dir', children: ['/staging/root/dir1', '/staging/root/link']},
      {
        path: '/staging/root/dir1',
        kind: 'dir',
        children: ['/staging/root/dir1/file.txt', '/staging/root/dir1/exec.sh'],
      },
      {path: '/staging/root/dir1/file.txt', kind: 'file', mode: 0o644},
      // Owner-execute but no owner-write: forces chmod to OR in owner-rw, so the test can prove
      // the executable bit survives that OR rather than merely being unable to observe it.
      {path: '/staging/root/dir1/exec.sh', kind: 'file', mode: 0o500},
      {path: '/staging/root/link', kind: 'symlink'},
      // Deliberately NOT registered: /outside/target — the symlink's target. If the walker ever
      // followed it, lstat would throw ENOENT and the test would fail loudly.
    ])

    // #when
    const result = await handOffToAgent('/staging/root', {
      uid: TARGET_UID,
      gid: TARGET_GID,
      deadlineMs: 10_000,
      maxEntries: 1000,
      ops,
    })

    // #then — every registered entry was lchown'd to the target uid/gid
    expect(result.ok).toBe(true)
    const chownedPaths = ops.lchownCalls.map(c => c[0]).sort()
    expect(chownedPaths).toEqual(
      [
        '/staging/root',
        '/staging/root/dir1',
        '/staging/root/dir1/file.txt',
        '/staging/root/dir1/exec.sh',
        '/staging/root/link',
      ].sort(),
    )
    for (const [, uid, gid] of ops.lchownCalls) {
      expect(uid).toBe(TARGET_UID)
      expect(gid).toBe(TARGET_GID)
    }
    // The symlink TARGET was never lchown'd or lstat'd — it was never registered as a node, so
    // any attempt to touch it would have thrown.
    expect(chownedPaths).not.toContain('/outside/target')

    // Executable bit preserved: exec.sh's mode had 0o100 (owner-execute) but no owner-write, so
    // OR-ing in owner-rw forces a chmod — and that chmod must not clear the execute bit.
    const execChmod = ops.chmodCalls.find(c => c[0] === '/staging/root/dir1/exec.sh')
    expect(execChmod).toBeDefined()
    expect((execChmod as [string, number])[1] & 0o100).toBe(0o100)
  })
})

describe('handOffToAgent — hardlink rejection', () => {
  it('fails the walk and leaves staging untouched once a hardlinked file (nlink > 1) is found', async () => {
    // #given — a file with nlink=2 midway through the tree
    const ops = makeFakeOps([
      {path: '/staging/root', kind: 'dir', children: ['/staging/root/a', '/staging/root/linked.bin']},
      {path: '/staging/root/a', kind: 'file'},
      {path: '/staging/root/linked.bin', kind: 'file', nlink: 2},
    ])

    // #when
    const result = await handOffToAgent('/staging/root', {
      uid: TARGET_UID,
      gid: TARGET_GID,
      deadlineMs: 10_000,
      maxEntries: 1000,
      ops,
    })

    // #then
    expect(result).toEqual({ok: false, reason: 'hardlink', path: '/staging/root/linked.bin'})
    // Nothing was ever lchown'd on the failing node — a clean failure, not a partial handoff.
    const chownedTheHardlink = ops.lchownCalls.some(c => c[0] === '/staging/root/linked.bin')
    expect(chownedTheHardlink).toBe(false)
  })
})

describe('handOffToAgent — bounded walk', () => {
  it('fails with deadline-exceeded once the wall-clock deadline passes', async () => {
    // #given — a clock that reports well past the deadline on the very first check
    const ops = makeFakeOps([{path: '/staging/root', kind: 'dir', children: []}])
    let calls = 0
    const now = () => {
      calls += 1
      // First call establishes deadlineAt = now() + deadlineMs; every call after that must be
      // past it for the walk's first deadline check to trip.
      return calls === 1 ? 0 : 1_000_000
    }

    // #when
    const result = await handOffToAgent('/staging/root', {
      uid: TARGET_UID,
      gid: TARGET_GID,
      deadlineMs: 10,
      maxEntries: 1000,
      ops,
      now,
    })

    // #then
    expect(result).toEqual({ok: false, reason: 'deadline-exceeded', path: '/staging/root'})
    expect(ops.lchownCalls.length).toBe(0)
  })

  it('fails with too-many-entries once the entry cap is exceeded', async () => {
    // #given — a flat directory with more children than the cap allows
    const children = Array.from({length: 5}, (_, i) => `/staging/root/f${i}`)
    const ops = makeFakeOps([
      {path: '/staging/root', kind: 'dir', children},
      ...children.map(path => ({path, kind: 'file' as const})),
    ])

    // #when — cap of 2 means: root (1) + f0 (2) succeeds, f1 (3) exceeds
    const result = await handOffToAgent('/staging/root', {
      uid: TARGET_UID,
      gid: TARGET_GID,
      deadlineMs: 10_000,
      maxEntries: 2,
      ops,
    })

    // #then
    expect(result).toEqual({ok: false, reason: 'too-many-entries', path: '/staging/root/f1'})
  })
})

describe('handOffToAgent — filesystem-boundary and unsupported-node defense', () => {
  it('fails closed when an entry reports a different st_dev than the root', async () => {
    // #given
    const ops = makeFakeOps([
      {path: '/staging/root', kind: 'dir', children: ['/staging/root/mounted'], dev: ROOT_DEV},
      {path: '/staging/root/mounted', kind: 'dir', dev: ROOT_DEV + 1, children: []},
    ])

    // #when
    const result = await handOffToAgent('/staging/root', {
      uid: TARGET_UID,
      gid: TARGET_GID,
      deadlineMs: 10_000,
      maxEntries: 1000,
      ops,
    })

    // #then
    expect(result).toEqual({ok: false, reason: 'foreign-filesystem', path: '/staging/root/mounted'})
  })

  it('fails closed on an unsupported node type (fifo)', async () => {
    // #given
    const ops = makeFakeOps([
      {path: '/staging/root', kind: 'dir', children: ['/staging/root/pipe']},
      {path: '/staging/root/pipe', kind: 'fifo'},
    ])

    // #when
    const result = await handOffToAgent('/staging/root', {
      uid: TARGET_UID,
      gid: TARGET_GID,
      deadlineMs: 10_000,
      maxEntries: 1000,
      ops,
    })

    // #then
    expect(result).toEqual({ok: false, reason: 'unsupported-entry-type', path: '/staging/root/pipe'})
  })
})
