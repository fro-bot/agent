import type {Buffer} from 'node:buffer'
import {spawn, spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

vi.setConfig({testTimeout: 60_000})

const hasBun = spawnSync('bun', ['--version']).status === 0

/**
 * Real signals to a real process (fro-bot/agent#2135): the lifecycle owns signal handling while a sandbox is live, so a
 * second SIGTERM (the runner escalates a cancelled step) must not kill the teardown's own commands, and the process ends only
 * after the teardown has finished.
 */
describe.skipIf(!hasBun)('a signal to a process with a live sandbox', () => {
  let dir = ''
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-signal-')))
  })
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  async function runFixture(signals: readonly {readonly afterMs: number}[]): Promise<{
    readonly signal: NodeJS.Signals | null
    readonly code: number | null
    readonly lines: string[]
  }> {
    const log = path.join(dir, 'log.txt')
    const child = spawn('bun', [path.join(import.meta.dirname, 'sandbox-signal.fixture.ts')], {
      env: {...process.env, SIGNAL_FIXTURE_LOG: log, SIGNAL_FIXTURE_TEMP: dir},
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const ready = new Promise<void>((resolve, reject) => {
      child.once('exit', () => reject(new Error('the fixture exited before it was ready')))
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('READY')) resolve()
      })
    })
    const exited = new Promise<{signal: NodeJS.Signals | null; code: number | null}>(resolve => {
      child.once('exit', (code, signal) => resolve({code, signal}))
    })
    await ready
    for (const next of signals) {
      await new Promise(resolve => setTimeout(resolve, next.afterMs))
      child.kill('SIGTERM')
    }
    const outcome = await exited
    const lines = fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter(line => line.length > 0)
      : []
    return {...outcome, lines}
  }

  it('finishes the teardown before the process exits, and ends by the signal', async () => {
    // #given a live sandbox and one SIGTERM
    // #when it arrives
    const result = await runFixture([{afterMs: 50}])

    // #then the whole teardown ran, in order, before the process exited, and the exit was the signal's
    // (a process ended by a signal's default action runs no exit handlers, so the last line is the teardown's own)
    expect(result.lines).toEqual(['state:pending', 'stop-start', 'stop-done:0', 'takeback', 'delete', 'state:restored'])
    expect(result.signal).toBe('SIGTERM')
  })

  it('lets the teardown command finish when a second SIGTERM arrives mid-teardown (the runner escalates)', async () => {
    // #given one SIGTERM, and a second 300 ms later while `stop` is still running its child
    // #when both arrive
    const result = await runFixture([{afterMs: 50}, {afterMs: 300}])

    // #then the stop child was not killed by the second signal: it exited 0 and the teardown completed before the exit
    expect(result.lines).toEqual(['state:pending', 'stop-start', 'stop-done:0', 'takeback', 'delete', 'state:restored'])
    expect(result.signal).toBe('SIGTERM')
  })
})
