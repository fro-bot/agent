/**
 * Tests for agent-walk.ts (Review round E, E5) — real subprocess spawns, real filesystem.
 */

import {statSync} from 'node:fs'
import {chmod, mkdir, open, rm, symlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import process from 'node:process'

import {describe, expect, it} from 'vitest'
import {measureSealedTree, runAgentWalk, runWalkScriptForTesting} from './agent-walk.js'
import {AGENT_GID, AGENT_UID} from './identity.js'
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

/** `parent/sealed/file.txt` -- exactly one 5-byte file, so a correct walk reports 2 entries, 5 bytes. */
async function buildSealedTestTree(): Promise<{readonly parent: string; readonly sealed: string}> {
  const parent = await makeTempDir('agent-walk-test-')
  const sealed = join(parent, 'sealed')
  await mkdir(sealed)
  await writeFile(join(sealed, 'file.txt'), '12345')
  return {parent, sealed}
}

describe('measureSealedTree -- F4/G4: fd-scoped measurement of a genuinely agent-untraversable directory', () => {
  const IS_ROOT = process.getuid?.() === 0

  it.skipIf(process.platform === 'linux')('reports unavailable on a platform without /proc/self/fd', async () => {
    const dir = await makeTempDir('agent-walk-test-')
    try {
      const outcome = await measureSealedTree({
        dirPath: dir,
        maxEntries: 10_000,
        deadlineMs: 5_000,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
        timeoutMs: 10_000,
      })
      expect(outcome.kind).toBe('unavailable')
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })

  it.skipIf(process.platform !== 'linux' || !IS_ROOT)(
    'as root: walks as AGENT_UID/AGENT_GID through a 0700 root-owned parent -- exactly 2 entries, 5 bytes',
    async () => {
      const {parent, sealed} = await buildSealedTestTree()
      try {
        await chmod(parent, 0o700)
        const outcome = await measureSealedTree({
          dirPath: sealed,
          maxEntries: 10_000,
          deadlineMs: 5_000,
          uid: AGENT_UID,
          gid: AGENT_GID,
          timeoutMs: 10_000,
        })
        expect(outcome).toEqual({kind: 'ok', totalBytes: 5, entryCount: 2, complete: true})
      } finally {
        await chmod(parent, 0o700)
        await rm(parent, {recursive: true, force: true})
      }
    },
  )

  it.skipIf(process.platform !== 'linux' || IS_ROOT)(
    'as non-root: walks as the current uid through a mode-0000 parent -- pathname access fails, only the fd works',
    async () => {
      const {parent, sealed} = await buildSealedTestTree()
      try {
        await chmod(parent, 0o000)
        const outcome = await measureSealedTree({
          dirPath: sealed,
          maxEntries: 10_000,
          deadlineMs: 5_000,
          uid: process.getuid?.(),
          gid: process.getgid?.(),
          timeoutMs: 10_000,
        })
        expect(outcome).toEqual({kind: 'ok', totalBytes: 5, entryCount: 2, complete: true})
      } finally {
        await chmod(parent, 0o700)
        await rm(parent, {recursive: true, force: true})
      }
    },
  )

  it.skipIf(process.platform !== 'linux')(
    'the child receives fd 3 bound to the EXACT target directory (ino/dev match), never a substitute',
    async () => {
      const {parent, sealed} = await buildSealedTestTree()
      const targetSt = statSync(sealed)
      try {
        await chmod(parent, 0o700)
        const handle = await open(sealed, 'r')
        try {
          const script =
            "const st = require('node:fs').fstatSync(3); process.stdout.write(JSON.stringify({ino: Number(st.ino), dev: Number(st.dev)}))"
          const outcome = await runWalkScriptForTesting(
            script,
            {
              uid: IS_ROOT ? AGENT_UID : process.getuid?.(),
              gid: IS_ROOT ? AGENT_GID : process.getgid?.(),
              timeoutMs: 10_000,
            },
            handle.fd,
          )
          expect(outcome.kind).toBe('ok')
          if (outcome.kind !== 'ok') throw new Error('unreachable')
          const parsed = JSON.parse(outcome.stdout) as {ino: number; dev: number}
          expect(parsed.ino).toBe(Number(targetSt.ino))
          expect(parsed.dev).toBe(Number(targetSt.dev))
        } finally {
          await handle.close()
        }
      } finally {
        await chmod(parent, 0o700)
        await rm(parent, {recursive: true, force: true})
      }
    },
  )

  it.skipIf(process.platform !== 'linux')(
    'no other file descriptor leaks into the child beyond stdio and the intended fd 3',
    async () => {
      const {parent, sealed} = await buildSealedTestTree()
      const sentinelPath = join(parent, 'sentinel.txt')
      await writeFile(sentinelPath, 'sentinel')
      try {
        await chmod(parent, 0o700)
        // (G4) A descriptor opened in THIS (parent) process BEFORE spawning -- Node's fs handles are
        // O_CLOEXEC by default, so it must never appear in the child's own fd table.
        const sentinelHandle = await open(sentinelPath, 'r')
        const targetHandle = await open(sealed, 'r')
        try {
          const script =
            "process.stdout.write(JSON.stringify(require('node:fs').readdirSync('/proc/self/fd').map(Number)))"
          const outcome = await runWalkScriptForTesting(
            script,
            {
              uid: IS_ROOT ? AGENT_UID : process.getuid?.(),
              gid: IS_ROOT ? AGENT_GID : process.getgid?.(),
              timeoutMs: 10_000,
            },
            targetHandle.fd,
          )
          expect(outcome.kind).toBe('ok')
          if (outcome.kind !== 'ok') throw new Error('unreachable')
          const childFds = JSON.parse(outcome.stdout) as readonly number[]
          expect(childFds).not.toContain(sentinelHandle.fd)
          expect(childFds.every(fd => fd <= 3)).toBe(true)
        } finally {
          await sentinelHandle.close()
          await targetHandle.close()
        }
      } finally {
        await chmod(parent, 0o700)
        await rm(parent, {recursive: true, force: true})
      }
    },
  )
})
