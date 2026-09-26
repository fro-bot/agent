/**
 * Tests for agent-walk.ts (Review round E, E5) — real subprocess spawns, real filesystem.
 */

import {chmod, mkdir, rm, symlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import process from 'node:process'

import {describe, expect, it} from 'vitest'
import {measureSealedTree, runAgentWalk, runWalkScriptForTesting} from './agent-walk.js'
import {makeTempDir} from './update-fixtures/helpers.js'

function opts(rootPath: string, overrides: Partial<Parameters<typeof runAgentWalk>[0]> = {}) {
  return {
    rootPath,
    maxEntries: 200_000,
    deadlineMs: 10_000,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    timeoutMs: 10_000,
    ...overrides,
  }
}

describe('runAgentWalk — basic counting', () => {
  it('counts files and their bytes, complete:true', async () => {
    const dir = await makeTempDir('agent-walk-test-')
    try {
      await writeFile(join(dir, 'a.txt'), 'hello')
      await mkdir(join(dir, 'sub'))
      await writeFile(join(dir, 'sub', 'b.txt'), 'world!')
      const outcome = await runAgentWalk(opts(dir))
      expect(outcome).toEqual({kind: 'ok', totalBytes: 11, entryCount: 4, complete: true})
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })

  it('counts a symlink itself but never follows it', async () => {
    const dir = await makeTempDir('agent-walk-test-')
    const outside = await makeTempDir('agent-walk-outside-')
    try {
      await writeFile(join(outside, 'big.txt'), 'x'.repeat(10_000))
      await symlink(outside, join(dir, 'link'))
      const outcome = await runAgentWalk(opts(dir))
      expect(outcome.kind).toBe('ok')
      if (outcome.kind !== 'ok') throw new Error('unreachable')
      expect(outcome.totalBytes).toBeLessThan(1_000)
    } finally {
      await rm(dir, {recursive: true, force: true})
      await rm(outside, {recursive: true, force: true})
    }
  })
})

describe('runAgentWalk — bounds', () => {
  it('caps at maxEntries and reports complete:false', async () => {
    const dir = await makeTempDir('agent-walk-test-')
    try {
      for (let i = 0; i < 10; i += 1) await writeFile(join(dir, `f${i}.txt`), 'x')
      const outcome = await runAgentWalk(opts(dir, {maxEntries: 3}))
      expect(outcome).toEqual({kind: 'ok', totalBytes: expect.any(Number) as number, entryCount: 3, complete: false})
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })

  it('caps at a tight deadline (enough real entries that a 1ms budget cannot finish) and reports complete:false', async () => {
    const dir = await makeTempDir('agent-walk-test-')
    try {
      for (let i = 0; i < 2_000; i += 1) await writeFile(join(dir, `f${i}.txt`), 'x')
      const outcome = await runAgentWalk(opts(dir, {deadlineMs: 1}))
      expect(outcome.kind).toBe('ok')
      if (outcome.kind !== 'ok') throw new Error('unreachable')
      expect(outcome.complete).toBe(false)
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })
})

describe('runAgentWalk — failure modes', () => {
  it.skipIf(process.getuid?.() === 0)('reports failed when the subprocess cannot even spawn (bogus uid)', async () => {
    const dir = await makeTempDir('agent-walk-test-')
    try {
      const outcome = await runAgentWalk(opts(dir, {uid: 999_999_999}))
      expect(outcome.kind).toBe('failed')
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })
})

describe('runAgentWalk \u2014 F1: minimal, secret-free environment', () => {
  it('the child sees no ambient secrets, no NODE_OPTIONS, and a safe cwd', async () => {
    const originalEnv = {...process.env}
    process.env.WORKSPACE_OPENCODE_TOKEN = 'sentinel-workspace-token'
    process.env.GITHUB_TOKEN = 'sentinel-github-token'
    process.env.NODE_OPTIONS = '--require /nonexistent-sentinel-module'
    try {
      const script = 'process.stdout.write(JSON.stringify({env: process.env, cwd: process.cwd()}))'
      const outcome = await runWalkScriptForTesting(script, {
        uid: process.getuid?.(),
        gid: process.getgid?.(),
        timeoutMs: 10_000,
      })
      expect(outcome.kind).toBe('ok')
      if (outcome.kind !== 'ok') throw new Error('unreachable')
      const parsed = JSON.parse(outcome.stdout) as {env: Record<string, string | undefined>; cwd: string}
      expect(parsed.env.WORKSPACE_OPENCODE_TOKEN).toBeUndefined()
      expect(parsed.env.GITHUB_TOKEN).toBeUndefined()
      expect(parsed.env.NODE_OPTIONS).toBeUndefined()
      expect(parsed.env.NODE_PATH).toBeUndefined()
      expect(JSON.stringify(parsed.env)).not.toContain('sentinel')
      expect(parsed.cwd).toBe('/')
    } finally {
      process.env = originalEnv
    }
  })
})

describe('runAgentWalk \u2014 F2: traversal errors report completeness, never silently complete', () => {
  it.skipIf(process.getuid?.() === 0)(
    'an unreadable root directory reports complete:false, never complete',
    async () => {
      const dir = await makeTempDir('agent-walk-test-')
      try {
        await writeFile(join(dir, 'a.txt'), 'x')
        await chmod(dir, 0o000)
        const outcome = await runAgentWalk(opts(dir))
        expect(outcome.kind).toBe('ok')
        if (outcome.kind !== 'ok') throw new Error('unreachable')
        expect(outcome.complete).toBe(false)
      } finally {
        await chmod(dir, 0o700)
        await rm(dir, {recursive: true, force: true})
      }
    },
  )

  it.skipIf(process.getuid?.() === 0)(
    'an unreadable interior directory reports complete:false, never complete',
    async () => {
      const dir = await makeTempDir('agent-walk-test-')
      const sub = join(dir, 'sub')
      try {
        await mkdir(sub)
        await writeFile(join(sub, 'a.txt'), 'x')
        await writeFile(join(dir, 'top.txt'), 'y')
        await chmod(sub, 0o000)
        const outcome = await runAgentWalk(opts(dir))
        expect(outcome.kind).toBe('ok')
        if (outcome.kind !== 'ok') throw new Error('unreachable')
        expect(outcome.complete).toBe(false)
      } finally {
        await chmod(sub, 0o700)
        await rm(dir, {recursive: true, force: true})
      }
    },
  )

  it('a vanished (nonexistent) root fails, never reports complete', async () => {
    const dir = await makeTempDir('agent-walk-test-')
    await rm(dir, {recursive: true, force: true})
    const outcome = await runAgentWalk(opts(dir))
    expect(outcome.kind).toBe('failed')
  })
})

describe('measureSealedTree \u2014 F4: fd-scoped measurement of an agent-untraversable directory', () => {
  const opts = (dirPath: string) => ({
    dirPath,
    maxEntries: 10_000,
    deadlineMs: 5_000,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    timeoutMs: 10_000,
  })

  it.skipIf(process.platform === 'linux')('reports unavailable on a platform without /proc/self/fd', async () => {
    const dir = await makeTempDir('agent-walk-test-')
    try {
      const outcome = await measureSealedTree(opts(dir))
      expect(outcome.kind).toBe('unavailable')
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })

  it.skipIf(process.platform !== 'linux')(
    'measures a directory reachable ONLY via the inherited fd, never a pathname, on Linux',
    async () => {
      const parent = await makeTempDir('agent-walk-test-')
      const sealed = join(parent, 'sealed')
      try {
        await mkdir(sealed)
        await writeFile(join(sealed, 'a.txt'), 'hello')
        await chmod(parent, 0o700) // ancestor unreadable by anyone else; the fd bypasses this entirely
        const outcome = await measureSealedTree(opts(sealed))
        expect(outcome.kind).toBe('ok')
        if (outcome.kind !== 'ok') throw new Error('unreachable')
        expect(outcome.totalBytes).toBeGreaterThan(0)
        expect(outcome.complete).toBe(true)
      } finally {
        await chmod(parent, 0o700)
        await rm(parent, {recursive: true, force: true})
      }
    },
  )
})
