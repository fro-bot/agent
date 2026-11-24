import type {Buffer} from 'node:buffer'
import type {OtlpSink} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import type {Logger} from '../shared/logger.js'
import type {SignalHost, SignalName} from './signal-owner.js'
import {spawn, spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {startOtlpSink} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import {isRunCancelled, resetRunCancellation} from '../shared/cancellation.js'
import {createSignalOwner, SIGNAL_FLUSH_DEADLINE_MS} from './signal-owner.js'

vi.setConfig({testTimeout: 60_000})

const quietLogger = (): Logger => ({debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()})

/** A `process` that records what the owner does to it, and delivers a signal when told to. */
function fakeHost() {
  const listeners = new Map<SignalName, (() => void)[]>()
  const kills: [number, SignalName][] = []
  const host: SignalHost = {
    pid: 4242,
    on: (signal, listener) => {
      listeners.set(signal, [...(listeners.get(signal) ?? []), listener])
    },
    off: (signal, listener) => {
      listeners.set(
        signal,
        (listeners.get(signal) ?? []).filter(item => item !== listener),
      )
    },
    kill: (pid, signal) => {
      kills.push([pid, signal])
    },
  }
  const deliver = (signal: SignalName): void => {
    for (const listener of listeners.get(signal) ?? []) listener()
  }
  return {
    host,
    deliver,
    kills,
    listenerCount: () => [...listeners.values()].reduce((sum, list) => sum + list.length, 0),
  }
}

const tick = async (ms = 0): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function setup(overrides: Partial<Parameters<typeof createSignalOwner>[0]> = {}) {
  const fake = fakeHost()
  const events: string[] = []
  const release = vi.fn(() => {
    events.push('ownership-released')
  })
  const hold = vi.fn(() => {
    events.push('ownership-held')
    return release
  })
  const reapChildren = vi.fn(() => {
    events.push('reap')
    return 1
  })
  const flush = vi.fn(async (_options: {readonly boundMs: number}) => {
    events.push('flush')
  })
  const onCancel = vi.fn((_signal: SignalName) => {
    events.push(`on-cancel(cancelled=${String(isRunCancelled())})`)
  })
  const owner = createSignalOwner({
    logger: quietLogger(),
    host: fake.host,
    onCancel,
    flush,
    reapChildren,
    holdOwnership: hold,
    ...overrides,
  })
  return {...fake, owner, events, hold, release, reapChildren, flush, onCancel}
}

describe('createSignalOwner', () => {
  beforeEach(() => {
    resetRunCancellation()
  })
  afterEach(() => {
    resetRunCancellation()
    vi.useRealTimers()
  })

  it('holds the exec adapter’s signal ownership from creation, and listens for both signals', () => {
    // #given / #when
    const {hold, listenerCount, events} = setup()

    // #then
    expect(hold).toHaveBeenCalledTimes(1)
    expect(listenerCount()).toBe(2)
    expect(events).toEqual(['ownership-held'])
  })

  it('sets the cancelled flag and calls onCancel synchronously, before anything else starts', async () => {
    // #given
    const {deliver, events, owner} = setup()

    // #when the signal is delivered, with nothing awaited yet
    deliver('SIGINT')

    // #then the flag, the span ending and the command reaping happened in that order, all inside the handler
    expect(isRunCancelled()).toBe(true)
    expect(owner.cancelled()).toBe(true)
    expect(events).toEqual(['ownership-held', 'on-cancel(cancelled=true)', 'reap'])
    await owner.drain()
  })

  it('starts the teardown before the export builds its scrubber and serializes the spans', async () => {
    // #given a teardown and an export, each noting when it starts
    const {deliver, events, owner, flush} = setup()
    owner.registerTeardown(async () => {
      events.push('teardown')
    })

    // #when the signal is delivered
    deliver('SIGTERM')
    await owner.drain()

    // #then the teardown was under way before the export's own preparation began
    expect(events.slice(1, 4)).toEqual(['on-cancel(cancelled=true)', 'teardown', 'flush'])
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('still bounds the export from the moment of the signal, preparation included', async () => {
    // #given an export that never answers and a 40 ms deadline
    const {deliver, kills, owner} = setup({
      flushDeadlineMs: 40,
      flush: vi.fn(async () => new Promise<void>(() => undefined)),
    })

    // #when
    const started = Date.now()
    deliver('SIGINT')
    await owner.drain()

    // #then the process was released at about the deadline, not later
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(kills).toEqual([[4242, 'SIGINT']])
  })

  it('starts the export with the deadline it was given', async () => {
    // #given
    const {deliver, flush, owner} = setup({flushDeadlineMs: 1234})

    // #when
    deliver('SIGTERM')
    await owner.drain()

    // #then
    expect(flush).toHaveBeenCalledWith({boundMs: 1234})
  })

  it('has a default deadline short of the runner’s SIGTERM, 7.5 s after the SIGINT', () => {
    expect(SIGNAL_FLUSH_DEADLINE_MS).toBeLessThan(7_500)
  })

  it('with no teardown, reaps the running commands, then re-raises the same signal after releasing its handlers', async () => {
    // #given
    const {deliver, kills, owner, events, listenerCount} = setup()

    // #when
    deliver('SIGINT')
    await owner.drain()

    // #then
    expect(events).toContain('reap')
    expect(kills).toEqual([[4242, 'SIGINT']])
    expect(listenerCount()).toBe(0)
    expect(events.at(-1)).toBe('ownership-released')
  })

  it('with a teardown registered, runs it instead of reaping, and re-raises only when it has settled', async () => {
    // #given a teardown that takes a while
    const {deliver, kills, owner, reapChildren} = setup()
    let finish: () => void = () => undefined
    const teardown = vi.fn(
      async () =>
        new Promise<void>(resolve => {
          finish = resolve
        }),
    )
    owner.registerTeardown(teardown)

    // #when the signal arrives and time passes
    deliver('SIGTERM')
    await tick(30)

    // #then the teardown ran with the signal, no command was reaped, and nothing was raised yet
    expect(teardown).toHaveBeenCalledWith('SIGTERM')
    expect(reapChildren).not.toHaveBeenCalled()
    expect(kills).toEqual([])

    // #when the teardown settles
    finish()
    await owner.drain()
    expect(kills).toEqual([[4242, 'SIGTERM']])
  })

  it('does not re-raise before the export has settled, nor wait for one past its deadline', async () => {
    // #given an export that never settles, and a 40 ms deadline
    const {deliver, kills, owner} = setup({
      flush: async () => new Promise<void>(() => undefined),
      flushDeadlineMs: 40,
    })

    // #when
    deliver('SIGINT')
    await tick(10)
    const early = kills.length
    await owner.drain()

    // #then it waited for the deadline and then re-raised
    expect(early).toBe(0)
    expect(kills).toEqual([[4242, 'SIGINT']])
  })

  it('does not re-raise before a slow teardown even when the export is quick', async () => {
    // #given
    const {deliver, kills, owner} = setup()
    owner.registerTeardown(async () => tick(80))

    // #when
    deliver('SIGINT')
    await tick(30)

    // #then
    expect(kills).toEqual([])
    await owner.drain()
    expect(kills).toHaveLength(1)
  })

  it('ignores a second signal: no second export, no second teardown, no early re-raise', async () => {
    // #given
    const {deliver, kills, owner, flush, onCancel} = setup()
    const teardown = vi.fn(async () => tick(40))
    owner.registerTeardown(teardown)

    // #when a SIGINT, then a SIGTERM while it is being handled
    deliver('SIGINT')
    deliver('SIGTERM')
    await owner.drain()

    // #then
    expect(flush).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(kills).toEqual([[4242, 'SIGINT']])
  })

  it('runs a teardown registered after the signal began, and waits for it', async () => {
    // #given a signal already being handled (no teardown yet)
    const {deliver, kills, owner} = setup()
    deliver('SIGINT')

    // #when one registers late
    const late = vi.fn(async () => tick(60))
    owner.registerTeardown(late)
    await tick(10)

    // #then it ran at once, with the signal that began the handling, and the re-raise waits for it
    expect(late).toHaveBeenCalledWith('SIGINT')
    expect(kills).toEqual([])
    await owner.drain()
    expect(kills).toEqual([[4242, 'SIGINT']])
  })

  it('does not run an unregistered teardown', async () => {
    // #given
    const {deliver, owner, reapChildren} = setup()
    const teardown = vi.fn(async () => undefined)
    owner.registerTeardown(teardown)()

    // #when
    deliver('SIGINT')
    await owner.drain()

    // #then it was not run, and the commands were reaped as with none
    expect(teardown).not.toHaveBeenCalled()
    expect(reapChildren).toHaveBeenCalledTimes(1)
  })

  it('still re-raises when the teardown, the export and onCancel all throw', async () => {
    // #given
    const {deliver, kills, owner} = setup({
      onCancel: () => {
        throw new Error('span trouble')
      },
      flush: async () => {
        throw new Error('export trouble')
      },
    })
    owner.registerTeardown(async () => {
      throw new Error('teardown trouble')
    })

    // #when
    deliver('SIGTERM')
    await owner.drain()

    // #then
    expect(kills).toEqual([[4242, 'SIGTERM']])
    expect(isRunCancelled()).toBe(true)
  })

  it('drains at once when no signal arrived, and disposes idempotently', async () => {
    // #given
    const {owner, release, listenerCount} = setup()

    // #when
    await owner.drain()
    owner.dispose()
    owner.dispose()

    // #then ownership went back once, and no listener is left
    expect(release).toHaveBeenCalledTimes(1)
    expect(listenerCount()).toBe(0)
    expect(isRunCancelled()).toBe(false)
  })
})

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

describe.skipIf(!hasBun)('a signal to a real process with the signal owner', () => {
  let dir = ''
  let sink: OtlpSink | undefined
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'signal-owner-')))
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
    const child = spawn('bun', [path.join(import.meta.dirname, 'signal-owner.fixture.ts')], {
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

  it('reaps a long-running child, flushes once with the running phase and the root cancelled, and exits by the signal (no isolation)', async () => {
    // #given a run waiting on a minute-long command, and a collector
    sink = await startOtlpSink()

    // #when SIGINT arrives
    const result = await runFixture({
      scenario: 'child',
      mode: 'plain',
      collector: sink,
      signals: [{afterMs: 400, signal: 'SIGINT'}],
    })

    // #then the command is gone, the export ran once, and the process ended by the signal
    const childPid = Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8').trim())
    expect(alive(childPid)).toBe(false)
    // Reaped by the owner while the process was still alive (the run saw its command end), not by the exit that followed.
    expect(result.lines).toContain('child-exit:1')
    expect(result.signal).toBe('SIGINT')
    expect(result.lines.filter(line => line === 'flush-started')).toHaveLength(1)
    expect(sink.accepted()).toHaveLength(1)
    const spans = spansOf(sink)
    const execution = spans.find(span => span.name === 'execution')
    const root = spans.find(span => span.name === 'action.main')
    expect(attr(execution ?? {attributes: []}, 'fro_bot.outcome')).toBe('cancelled')
    expect(attr(execution ?? {attributes: []}, 'fro_bot.reason')).toBe('sigint')
    expect(attr(root ?? {attributes: []}, 'fro_bot.outcome')).toBe('cancelled')
    // The run's own unwinding after the reap (`failed`) did not overwrite the cancelled outcome: the first end wins.
    expect(result.elapsedMs).toBeLessThan(SIGNAL_FLUSH_DEADLINE_MS + 3_000)
  })

  it('completes the sandbox teardown too on an isolated run, flushes once, and exits by the signal', async () => {
    // #given an isolated run whose stop step takes a second
    sink = await startOtlpSink()

    // #when SIGTERM arrives
    const result = await runFixture({
      scenario: 'child',
      mode: 'isolated',
      collector: sink,
      signals: [{afterMs: 400, signal: 'SIGTERM'}],
    })

    // #then the whole teardown ran in order before the exit, the export ran once, and the exit was the signal's
    expect(result.lines.filter(line => /^(?:state|stop|takeback|delete)/.test(line))).toEqual([
      'state:pending',
      'stop-start',
      'stop-done',
      'takeback',
      'delete',
      'state:restored',
    ])
    expect(result.signal).toBe('SIGTERM')
    expect(result.lines.filter(line => line === 'flush-started')).toHaveLength(1)
    expect(sink.accepted()).toHaveLength(1)
    expect(attr(spansOf(sink).find(span => span.name === 'action.main') ?? {attributes: []}, 'fro_bot.outcome')).toBe(
      'cancelled',
    )
  })

  it('starts no second export for a second signal during the first one’s export', async () => {
    // #given a collector that answers after a second
    sink = await startOtlpSink({respond: () => ({status: 200, delayMs: 1_000})})

    // #when SIGINT, then SIGTERM 200 ms later (the runner escalates)
    const result = await runFixture({
      scenario: 'child',
      mode: 'plain',
      collector: sink,
      signals: [
        {afterMs: 400, signal: 'SIGINT'},
        {afterMs: 200, signal: 'SIGTERM'},
      ],
    })

    // #then one export, one request, and the first signal's exit
    expect(result.lines.filter(line => line === 'flush-started')).toHaveLength(1)
    expect(sink.received()).toBe(1)
    expect(result.signal).toBe('SIGINT')
  })

  it('flushes exactly once when normal completion races a signal, and the process does not exit before the export settles', async () => {
    // #given a run that has finished and is waiting on a slow collector
    sink = await startOtlpSink({respond: () => ({status: 200, delayMs: 1_500})})

    // #when a signal arrives mid-export
    const result = await runFixture({
      scenario: 'complete',
      mode: 'plain',
      collector: sink,
      signals: [{afterMs: 300, signal: 'SIGTERM'}],
    })

    // #then one request, delivered; the process waited for the answer (about 1.2 s of the 1.5 s were left) and then ended
    expect(sink.received()).toBe(1)
    expect(sink.accepted()).toHaveLength(1)
    expect(result.lines.filter(line => line === 'flush-started')).toHaveLength(1)
    expect(result.elapsedMs).toBeGreaterThan(900)
    expect(result.signal).toBe('SIGTERM')
  })

  it('does not let a collector that never answers push the exit past the export deadline', async () => {
    // #given a collector that holds every connection, and a 1.5 s deadline
    sink = await startOtlpSink({respond: () => ({status: 200, hold: true})})

    // #when
    const result = await runFixture({
      scenario: 'child',
      mode: 'plain',
      collector: sink,
      signals: [{afterMs: 400, signal: 'SIGINT'}],
      env: {SIGNAL_FIXTURE_DEADLINE_MS: '1500'},
    })

    // #then it waited for the deadline (not less) and not much more
    expect(result.signal).toBe('SIGINT')
    expect(result.elapsedMs).toBeGreaterThan(1_300)
    expect(result.elapsedMs).toBeLessThan(3_500)
  })

  it('submits no comment after the signal when a read was in flight and the collector stalls, and keeps the teardown’s budget', async () => {
    // #given an isolated run, a collector that never answers, a read that finishes 1.5 s in, and a stop step far longer than
    // its 1.5 s budget
    sink = await startOtlpSink({respond: () => ({status: 200, hold: true})})

    // #when SIGTERM arrives 300 ms in, while the read is still in flight
    const result = await runFixture({
      scenario: 'read-then-write',
      mode: 'isolated',
      collector: sink,
      signals: [{afterMs: 300, signal: 'SIGTERM'}],
      env: {SIGNAL_FIXTURE_DEADLINE_MS: '2500', SIGNAL_FIXTURE_STOP_MS: '8000', SIGNAL_FIXTURE_BUDGET_MS: '1500'},
    })

    // #then the read finished after the signal, the write was refused at the point of submission, and nothing was sent
    expect(result.lines).toContain('read-finished')
    expect(result.lines).not.toContain('comment-submitted')
    expect(result.lines).toContain('post-result:null')
    // #and the teardown was cut at its own budget (the stop step never finished) and said so; the export did not shorten that
    expect(result.lines).toContain('stop-start')
    expect(result.lines).not.toContain('stop-done')
    expect(result.lines).toContain('state:unsafe')
    // #and the process ended by the signal, held only by the export's deadline (2.5 s), not the stop step (8 s)
    expect(result.signal).toBe('SIGTERM')
    expect(result.elapsedMs).toBeGreaterThan(2_300)
    expect(result.elapsedMs).toBeLessThan(5_000)
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
    expect(result.lines.filter(line => /^(?:state|stop|takeback|delete)/.test(line))).toEqual([
      'state:pending',
      'stop-start',
      'stop-done',
      'takeback',
      'delete',
      'state:restored',
    ])
    expect(result.signal).toBe('SIGTERM')
  })
})
