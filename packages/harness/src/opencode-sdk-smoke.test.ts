import {mkdirSync, symlinkSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {createOpencodeServer} from '@opencode-ai/sdk'
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest'

import {
  compileFixtureBinary,
  fileExists,
  isGone,
  makeTempDir,
  readPid,
  reapPidFile,
  removeDir,
  stageHarnessPackage,
  waitFor,
} from './shim-test-kit.js'

// The SDK launches `opencode serve` by BARE NAME and stops it with `proc.kill()` (SIGTERM) on the process it spawned.
// With a global harness install that process is the shim, so this is the end-to-end proof that the shim is a drop-in:
// it must start inside the SDK's 5s deadline, and close() must not leave the server behind.
const SDK_DEADLINE_MS = 5000
const OVERHEAD_TRIALS = 5

let root: string
let fixture: string
let shimBinDir: string
let directBinDir: string
const pidFiles: string[] = []

beforeAll(() => {
  root = makeTempDir('harness-sdk-')
  const staged = stageHarnessPackage(root)
  fixture = compileFixtureBinary(root)

  // PATH dir whose `opencode` is the built shim (what a global install provides)…
  shimBinDir = path.join(root, 'shim-bin')
  mkdirSync(shimBinDir)
  symlinkSync(staged.opencodeEntry, path.join(shimBinDir, 'opencode'))
  // …and one whose `opencode` is the fixture itself, as the no-shim baseline.
  directBinDir = path.join(root, 'direct-bin')
  mkdirSync(directBinDir)
  symlinkSync(fixture, path.join(directBinDir, 'opencode'))
}, 120_000)

afterEach(() => {
  vi.unstubAllEnvs()
  for (const file of pidFiles.splice(0)) reapPidFile(file)
})

afterAll(() => {
  removeDir(root)
})

function stubServeEnv(binDir: string, name: string): {ready: string; pid: string} {
  const files = {ready: path.join(root, `${name}.ready`), pid: path.join(root, `${name}.pid`)}
  pidFiles.push(files.pid)
  vi.stubEnv('PATH', `${binDir}${path.delimiter}${process.env.PATH ?? ''}`)
  vi.stubEnv('OPENCODE_PATH', fixture)
  vi.stubEnv('FIXTURE_READY', files.ready)
  vi.stubEnv('FIXTURE_PID', files.pid)
  vi.stubEnv('FIXTURE_RECORD_SIGNALS', '0')
  return files
}

async function timedStart(binDir: string, name: string): Promise<{elapsedMs: number; pid: number | undefined}> {
  const files = stubServeEnv(binDir, name)
  const startedAt = performance.now()
  const server = await createOpencodeServer({port: 4999, timeout: SDK_DEADLINE_MS})
  const elapsedMs = performance.now() - startedAt
  await waitFor('fixture ready', () => fileExists(files.ready))
  const pid = readPid(files.pid)
  server.close()
  if (pid !== undefined) await waitFor('server child to be gone', () => isGone(pid))
  return {elapsedMs, pid}
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] as number
}

describe('SDK createOpencodeServer through the opencode shim', () => {
  it('starts within the SDK deadline and close() leaves no server process', async () => {
    // #given PATH whose first `opencode` is the built shim, OPENCODE_PATH aimed at a fixture `serve`
    const files = stubServeEnv(shimBinDir, 'sdk-close')

    // #when the SDK starts a server and then closes it
    const startedAt = performance.now()
    const server = await createOpencodeServer({port: 4999, timeout: SDK_DEADLINE_MS})
    const elapsedMs = performance.now() - startedAt
    await waitFor('fixture ready', () => fileExists(files.ready))
    const childPid = readPid(files.pid)
    server.close()

    // #then it parsed the readiness line in time, and the fixture (the shim's child) is gone after close()
    expect(server.url).toBe('http://127.0.0.1:4999')
    expect(elapsedMs).toBeLessThan(SDK_DEADLINE_MS)
    expect(childPid).toBeDefined()
    await waitFor('server child to be gone', () => isGone(childPid as number))
  })

  it('records the shim startup overhead against a direct launch', async () => {
    // #given the same fixture started by the SDK with and without the shim in between
    const direct: number[] = []
    const viaShim: number[] = []

    // #when measuring several trials of each, alternating to even out machine noise
    for (let trial = 0; trial < OVERHEAD_TRIALS; trial++) {
      direct.push((await timedStart(directBinDir, `direct-${trial}`)).elapsedMs)
      viaShim.push((await timedStart(shimBinDir, `shim-${trial}`)).elapsedMs)
    }

    // #then the overhead is reported, and the shimmed start stays well inside the SDK deadline
    const overhead = median(viaShim) - median(direct)
    console.warn(
      `[opencode shim] SDK start: direct median ${median(direct).toFixed(0)}ms, ` +
        `via shim median ${median(viaShim).toFixed(0)}ms, overhead ≈ ${overhead.toFixed(0)}ms`,
    )
    expect(median(viaShim)).toBeLessThan(SDK_DEADLINE_MS / 2)
  })
})
