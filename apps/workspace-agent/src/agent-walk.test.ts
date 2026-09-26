/**
 * Tests for agent-walk.ts (Review round E, E5) — real subprocess spawns, real filesystem.
 */

import {mkdir, rm, symlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import process from 'node:process'

import {describe, expect, it} from 'vitest'
import {runAgentWalk} from './agent-walk.js'
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
