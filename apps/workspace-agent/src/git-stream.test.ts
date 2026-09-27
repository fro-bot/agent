/**
 * Unit 3 supplemental coverage for `runPackStream` beyond what
 * apps/workspace-agent/src/update-fixtures/pack.test.ts exercises with real git.
 *
 * The plan's Unit 3 test scenarios call out "a 50 MB pack streams intact; hashes match" as the
 * happy-path case. pack.test.ts's own "protected" happy-path test cannot exercise this at scale
 * because it drives real `git pack-objects`/`index-pack` (see the Unit 3 report for why that
 * specific fixture cannot pass as written); this file proves the streaming primitive itself —
 * byte-for-byte integrity under backpressure at a realistic pack size — independent of git.
 */

import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import process from 'node:process'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {runPackStream} from './git-stream.js'

const SCRIPT_ENV_BASE: Record<string, string> = {PATH: process.env.PATH ?? '/usr/bin:/bin'}

let scriptsDir: string

beforeEach(async () => {
  scriptsDir = await mkdtemp(join(os.tmpdir(), 'git-stream-test-'))
})

afterEach(async () => {
  await rm(scriptsDir, {recursive: true, force: true})
})

/**
 * A deterministic, non-repeating-in-any-short-period byte pattern so a truncated or reordered
 * transfer changes the hash. `offset * 31` stays well under `Number.MAX_SAFE_INTEGER` even at 50
 * MB of offsets, so there is no floating-point precision loss relative to the same arithmetic
 * re-expressed inside the writer script string below.
 */
function patternByte(offset: number): number {
  return (offset * 31 + 17) & 0xff
}

describe('runPackStream — 50 MB stream integrity (no git involved)', () => {
  it('streams the full 50 MB through backpressure with a matching hash and exact byte count', async () => {
    // #given a writer that emits 50 MB in 1 MB chunks (forcing multiple backpressure cycles
    // through runPackStream's write()/drain handling, never buffering the whole thing at once)
    // and hashes what it sent; a reader that hashes what it received. Both write their digest to
    // a side file since PackStreamOutcome carries no process output, only exit/signal.
    const totalBytes = 50 * 1024 * 1024
    const chunkBytes = 1024 * 1024
    const writerHashFile = join(scriptsDir, 'writer-hash.txt')
    const readerHashFile = join(scriptsDir, 'reader-hash.json')

    const writerScript = join(scriptsDir, 'writer-50mb.js')
    await writeFile(
      writerScript,
      [
        "const {createHash} = require('node:crypto')",
        "const {writeFileSync} = require('node:fs')",
        `const total = ${totalBytes}`,
        `const chunkSize = ${chunkBytes}`,
        "const hash = createHash('sha256')",
        'let written = 0',
        'function nextChunk() {',
        '  while (written < total) {',
        '    const size = Math.min(chunkSize, total - written)',
        '    const buf = Buffer.allocUnsafe(size)',
        '    for (let i = 0; i < size; i++) buf[i] = ((written + i) * 31 + 17) & 0xff',
        '    hash.update(buf)',
        '    written += size',
        '    const canContinue = process.stdout.write(buf)',
        '    if (!canContinue) {',
        '      process.stdout.once("drain", nextChunk)',
        '      return',
        '    }',
        '  }',
        `  writeFileSync(${JSON.stringify(writerHashFile)}, hash.digest("hex"))`,
        '}',
        'nextChunk()',
        '',
      ].join('\n'),
    )

    const readerScript = join(scriptsDir, 'reader-hash.js')
    await writeFile(
      readerScript,
      [
        "const {createHash} = require('node:crypto')",
        "const {writeFileSync} = require('node:fs')",
        "const hash = createHash('sha256')",
        'let total = 0',
        "process.stdin.on('data', chunk => { hash.update(chunk); total += chunk.length })",
        "process.stdin.on('end', () => {",
        `  writeFileSync(${JSON.stringify(readerHashFile)}, JSON.stringify({hash: hash.digest('hex'), total}))`,
        '})',
        '',
      ].join('\n'),
    )

    // #when runPackStream pumps the writer's stdout into the reader's stdin
    const outcome = await runPackStream({
      writer: {command: 'node', args: [writerScript], cwd: scriptsDir, env: SCRIPT_ENV_BASE},
      reader: {command: 'node', args: [readerScript], cwd: scriptsDir, env: SCRIPT_ENV_BASE},
      maxBytes: totalBytes + chunkBytes,
      timeoutMs: 20_000,
    })

    // #then the pair reports ok with the exact byte count runPackStream itself observed
    expect(outcome.kind).toBe('ok')
    const success = outcome.kind === 'ok' ? outcome : null
    expect(success?.bytesTransferred).toBe(totalBytes)

    // #then the writer's own hash of what it sent matches the reader's hash of what it received —
    // proof the full 50 MB arrived byte-for-byte, not truncated, reordered, or corrupted by the
    // backpressure handling in between
    const writerHash = (await readFile(writerHashFile, 'utf8')).trim()
    const readerRecord = JSON.parse(await readFile(readerHashFile, 'utf8')) as {hash: string; total: number}
    expect(readerRecord.total).toBe(totalBytes)
    expect(readerRecord.hash).toBe(writerHash)

    // #then sanity: an independently computed hash of the same deterministic pattern agrees too,
    // so this test would fail if BOTH scripts shared some coincidental bug
    const independent = createHash('sha256')
    for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
      const size = Math.min(chunkBytes, totalBytes - offset)
      const buf = Buffer.allocUnsafe(size)
      for (let i = 0; i < size; i++) buf.writeUInt8(patternByte(offset + i), i)
      independent.update(buf)
    }
    expect(writerHash).toBe(independent.digest('hex'))
  }, 30_000)
})
