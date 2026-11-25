import type {Buffer} from 'node:buffer'
import type {OtlpSink} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import {spawn, spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {startOtlpSink} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'

vi.setConfig({testTimeout: 60_000})

const tick = async (ms = 0): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

// ---- real signals to a real process -------------------------------------------------------------------------------

const hasBun = spawnSync('bun', ['--version']).status === 0

interface FixtureRun {
  readonly signal: NodeJS.Signals | null
  readonly code: number | null
  readonly lines: string[]
  /** From the first signal sent to the exit. */
  readonly elapsedMs: number
  readonly dir: string
}

interface FixtureOptions {
  readonly scenario: 'child' | 'complete' | 'read-then-write'
  readonly mode: 'isolated' | 'plain'
  readonly collector?: OtlpSink
  readonly signals: readonly {readonly afterMs: number; readonly signal: NodeJS.Signals}[]
  readonly env?: Record<string, string>
}

describe.skipIf(!hasBun)('a signal to a real process', () => {
  let dir = ''
  let sink: OtlpSink | undefined
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'signal-cancel-')))
  })
  afterEach(async () => {
    // A child a test left running on purpose (an isolated run does not reap commands).
    const pidFile = path.join(dir, 'child.pid')
    if (fs.existsSync(pidFile)) {
      try {
        process.kill(Number(fs.readFileSync(pidFile, 'utf8').trim()), 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    await sink?.stop()
    sink = undefined
    fs.rmSync(dir, {recursive: true, force: true})
  })

  async function runFixture(options: FixtureOptions): Promise<FixtureRun> {
    const log = path.join(dir, 'log.txt')
    const child = spawn('bun', [path.join(import.meta.dirname, 'signal-cancel.fixture.ts')], {
      env: {
        ...process.env,
        SIGNAL_FIXTURE_LOG: log,
        SIGNAL_FIXTURE_TEMP: dir,
        SIGNAL_FIXTURE_COLLECTOR: options.collector?.url ?? '',
        SIGNAL_FIXTURE_MODE: options.mode,
        SIGNAL_FIXTURE_SCENARIO: options.scenario,
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const exited = new Promise<{signal: NodeJS.Signals | null; code: number | null}>(resolve => {
      child.once('exit', (code, signal) => resolve({code, signal}))
    })
    await new Promise<void>((resolve, reject) => {
      child.once('exit', () => reject(new Error('the fixture exited before it was ready')))
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('READY')) resolve()
      })
    })
    const firstSignalAt = {value: 0}
    for (const next of options.signals) {
      await tick(next.afterMs)
      if (firstSignalAt.value === 0) firstSignalAt.value = Date.now()
      child.kill(next.signal)
    }
    const outcome = await exited
    const elapsedMs = Date.now() - firstSignalAt.value
    const lines = fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter(line => line.length > 0)
      : []
    return {...outcome, lines, elapsedMs, dir}
  }

  const spansOf = (target: OtlpSink) =>
    target
      .accepted()
      .flatMap(
        request =>
          (
            request.body as {
              resourceSpans: {
                scopeSpans: {
                  spans: {name: string; attributes: {key: string; value: {stringValue?: string}}[]}[]
                }[]
              }[]
            }
          ).resourceSpans,
      )
      .flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
  const attr = (span: {attributes: {key: string; value: {stringValue?: string}}[]}, key: string): string | undefined =>
    span.attributes.find(item => item.key === key)?.value.stringValue
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  describe('without isolate-agent: a signal ends the run as it always did', () => {
    it('reaps the running command, ends the process by the signal at once, and sends no lifecycle trace', async () => {
      // #given a run waiting on a minute-long command, with a collector it could send a trace to
      sink = await startOtlpSink()

      // #when SIGINT arrives
      const result = await runFixture({
        scenario: 'child',
        mode: 'plain',
        collector: sink,
        signals: [{afterMs: 400, signal: 'SIGINT'}],
      })

      // #then the command is gone, the process ended by the signal without waiting for anything, and nothing was exported
      const childPid = Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8').trim())
      expect(alive(childPid)).toBe(false)
      expect(result.signal).toBe('SIGINT')
      expect(result.elapsedMs).toBeLessThan(1_500)
      expect(sink.received()).toBe(0)
      expect(result.lines.filter(line => line.startsWith('flush') || line.startsWith('cancelled'))).toEqual([])
    })

    it('holds no signal handler of its own while no command runs, so the default action ends it', async () => {
      // #given a run between commands, finished except for a slow collector
      sink = await startOtlpSink({respond: () => ({status: 200, delayMs: 3_000})})

      // #when SIGTERM arrives while the normal export is in flight
      const result = await runFixture({
        scenario: 'complete',
        mode: 'plain',
        collector: sink,
        signals: [{afterMs: 300, signal: 'SIGTERM'}],
      })

      // #then nothing listened: the process ended at once by the signal, not after the export
      expect(result.lines).toContain('listeners:0:0')
      expect(result.signal).toBe('SIGTERM')
      expect(result.elapsedMs).toBeLessThan(1_500)
    })

    it('ends at once on a signal during a read, and the write that depended on it never happens', async () => {
      // #given a run whose GitHub read is still in flight
      sink = await startOtlpSink()

      // #when SIGTERM arrives 300 ms in
      const result = await runFixture({
        scenario: 'read-then-write',
        mode: 'plain',
        collector: sink,
        signals: [{afterMs: 300, signal: 'SIGTERM'}],
      })

      // #then the process is gone before the read finishes, so nothing is submitted
      expect(result.signal).toBe('SIGTERM')
      expect(result.lines).not.toContain('comment-submitted')
      expect(result.lines).not.toContain('read-finished')
    })

    it('sends its lifecycle trace as usual when no signal arrives', async () => {
      // #given
      sink = await startOtlpSink()

      // #when the run completes by itself
      const result = await runFixture({scenario: 'complete', mode: 'plain', collector: sink, signals: []})

      // #then one export, delivered, and the run's own exit
      expect(result.code).toBe(0)
      expect(result.lines.filter(line => line === 'flush-started')).toEqual([])
      expect(sink.accepted()).toHaveLength(1)
    })

    it('sends the comment when no signal arrives (the guard is the signal, not the read)', async () => {
      // #given the same run with no signal, which completes by itself
      sink = await startOtlpSink()

      // #when
      const result = await runFixture({
        scenario: 'read-then-write',
        mode: 'plain',
        collector: sink,
        signals: [],
        env: {SIGNAL_FIXTURE_READ_MS: '300'},
      })

      // #then
      expect(result.lines).toContain('comment-submitted')
      expect(result.code).toBe(0)
    })
  })

  describe('with isolate-agent: the export runs inside the teardown window', () => {
    const teardownOrder = (lines: readonly string[]): string[] =>
      lines.filter(line => /^(?:state|stop|takeback|delete)/.test(line))
    const RESTORED = ['state:pending', 'stop-start', 'stop-done', 'takeback', 'delete', 'state:restored']

    it('runs the whole teardown, delivers the reached spans beside it, and re-raises when the teardown settles', async () => {
      // #given an isolated run whose stop step takes a second, and a collector that answers at once
      sink = await startOtlpSink()

      // #when SIGTERM arrives
      const result = await runFixture({
        scenario: 'child',
        mode: 'isolated',
        collector: sink,
        signals: [{afterMs: 400, signal: 'SIGTERM'}],
      })

      // #then the teardown ran in order, the export started while the stop step was still running, and the exit was the signal's
      expect(teardownOrder(result.lines)).toEqual(RESTORED)
      expect(result.lines.indexOf('flush-started')).toBeGreaterThan(result.lines.indexOf('stop-start'))
      expect(result.lines.indexOf('flush-started')).toBeLessThan(result.lines.indexOf('stop-done'))
      expect(result.signal).toBe('SIGTERM')
      // #and the spans it had reached were delivered, cancelled, and the run's own unwinding did not overwrite them
      expect(sink.accepted()).toHaveLength(1)
      const spans = spansOf(sink)
      const root = spans.find(span => span.name === 'action.main')
      const execution = spans.find(span => span.name === 'execution')
      expect(attr(root ?? {attributes: []}, 'fro_bot.outcome')).toBe('cancelled')
      expect(attr(execution ?? {attributes: []}, 'fro_bot.reason')).toBe('sigterm')
    })

    it('records the interruption before the teardown settles and the signal is re-raised', async () => {
      // #given an isolated run
      // #when SIGTERM arrives
      const result = await runFixture({
        scenario: 'child',
        mode: 'isolated',
        signals: [{afterMs: 400, signal: 'SIGTERM'}],
      })

      // #then the cancellation was recorded once, ahead of the restore the post hook reads, and the exit was the signal's
      expect(result.lines.filter(line => line === 'interrupted')).toHaveLength(1)
      expect(result.lines.indexOf('interrupted')).toBeLessThan(result.lines.indexOf('state:restored'))
      expect(result.signal).toBe('SIGTERM')
    })

    it('still tears down and ends by the signal when recording the interruption throws', async () => {
      // #given a state write that fails
      // #when SIGTERM arrives
      const result = await runFixture({
        scenario: 'child',
        mode: 'isolated',
        signals: [{afterMs: 400, signal: 'SIGTERM'}],
        env: {SIGNAL_FIXTURE_CANCEL_THROWS: 'true'},
      })

      // #then the failure changed nothing about the teardown or the exit
      expect(teardownOrder(result.lines)).toEqual(RESTORED)
      expect(result.signal).toBe('SIGTERM')
    })

    it('re-raises when the teardown settles, even though the collector never answers', async () => {
      // #given a collector that holds every connection, and a one-second stop step
      sink = await startOtlpSink({respond: () => ({status: 200, hold: true})})

      // #when
      const result = await runFixture({
        scenario: 'child',
        mode: 'isolated',
        collector: sink,
        signals: [{afterMs: 400, signal: 'SIGINT'}],
      })

      // #then it ended with the teardown (about a second), not at the export's own five-second bound; the spans were lost
      expect(teardownOrder(result.lines)).toEqual(RESTORED)
      expect(result.signal).toBe('SIGINT')
      expect(result.elapsedMs).toBeGreaterThan(900)
      expect(result.elapsedMs).toBeLessThan(2_800)
      expect(result.lines).not.toContain('flush-settled')
    })

    it('is held no longer than the teardown’s own budget, and says the sandbox was not restored', async () => {
      // #given a stop step far longer than its 1.5 s budget, and a collector that never answers
      sink = await startOtlpSink({respond: () => ({status: 200, hold: true})})

      // #when
      const result = await runFixture({
        scenario: 'child',
        mode: 'isolated',
        collector: sink,
        signals: [{afterMs: 400, signal: 'SIGTERM'}],
        env: {SIGNAL_FIXTURE_STOP_MS: '8000', SIGNAL_FIXTURE_BUDGET_MS: '1500'},
      })

      // #then re-raised at the budget
      expect(result.lines).not.toContain('stop-done')
      expect(result.lines).toContain('state:unsafe')
      expect(result.signal).toBe('SIGTERM')
      expect(result.elapsedMs).toBeGreaterThan(1_300)
      expect(result.elapsedMs).toBeLessThan(3_000)
    })

    it('submits no comment after the signal when a read was in flight, and keeps the teardown’s budget', async () => {
      // #given an isolated run, a read that finishes 1.5 s in, and a stop step far longer than its 1.5 s budget
      sink = await startOtlpSink({respond: () => ({status: 200, hold: true})})

      // #when SIGTERM arrives 300 ms in, while the read is still in flight
      const result = await runFixture({
        scenario: 'read-then-write',
        mode: 'isolated',
        collector: sink,
        signals: [{afterMs: 300, signal: 'SIGTERM'}],
        env: {SIGNAL_FIXTURE_STOP_MS: '8000', SIGNAL_FIXTURE_BUDGET_MS: '2500'},
      })

      // #then the read finished after the signal and the write was refused at the point of submission
      expect(result.lines).toContain('read-finished')
      expect(result.lines).not.toContain('comment-submitted')
      expect(result.lines).toContain('post-result:null')
      expect(result.signal).toBe('SIGTERM')
      expect(result.elapsedMs).toBeLessThan(4_500)
    })

    it('starts one export for two signals, and the teardown runs once', async () => {
      // #given
      sink = await startOtlpSink()

      // #when SIGTERM, then another 300 ms later
      const result = await runFixture({
        scenario: 'child',
        mode: 'isolated',
        collector: sink,
        signals: [
          {afterMs: 400, signal: 'SIGTERM'},
          {afterMs: 300, signal: 'SIGTERM'},
        ],
      })

      // #then
      expect(result.lines.filter(line => line === 'flush-started')).toHaveLength(1)
      expect(teardownOrder(result.lines)).toEqual(RESTORED)
      expect(result.signal).toBe('SIGTERM')
    })

    it('with tracing off, tears an isolated run down exactly as the lifecycle always did', async () => {
      // #given no collector at all
      // #when SIGTERM arrives, and a second 300 ms later
      const result = await runFixture({
        scenario: 'child',
        mode: 'isolated',
        signals: [
          {afterMs: 400, signal: 'SIGTERM'},
          {afterMs: 300, signal: 'SIGTERM'},
        ],
      })

      // #then the same teardown, in the same order, as `sandbox-signal.test.ts` pins for the lifecycle alone
      expect(teardownOrder(result.lines)).toEqual(RESTORED)
      expect(result.signal).toBe('SIGTERM')
    })
  })
})
