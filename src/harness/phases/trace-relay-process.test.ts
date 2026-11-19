import type {TraceRelayLauncher, TraceRelayProcess} from './trace-relay-process.js'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {postBatch, rawExchange, startHttpUpstream} from '../../../packages/runtime/src/agent/trace-relay-test-kit.js'
import {createMockLogger, serializeLoggerCalls, unwrapErr, unwrapOk} from '../../shared/test-helpers.js'
import {startTraceRelayProcess} from './trace-relay-process.js'

const CREDENTIAL = 'Basic c3VwZXJ2aXNvci1jYW5hcnktMDA0Mjpzcw=='
const COLLECTOR_HOST_CANARY = 'collector-canary.example.com'

function findBun(): string | null {
  try {
    return execFileSync('which', ['bun'], {encoding: 'utf8'}).trim() || null
  } catch {
    return null
  }
}

const BUN = findBun()
const SOURCE_ENTRY = fileURLToPath(new URL('../../../apps/action/src/trace-relay.ts', import.meta.url))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const HEADERS = [{name: 'Authorization', value: CREDENTIAL}]

describe('trace-relay-process', () => {
  let dir: string
  const cleanups: (() => Promise<void>)[] = []
  const trackedPids: number[] = []

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-relay-process-'))
  })

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    for (const pid of trackedPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    await fs.rm(dir, {recursive: true, force: true})
  })

  async function fakeChild(source: string): Promise<TraceRelayLauncher> {
    const file = path.join(dir, `fake-${Math.random().toString(36).slice(2)}.mjs`)
    await fs.writeFile(file, source)
    return {command: process.execPath, args: [file]}
  }

  const realLauncher = (): TraceRelayLauncher => {
    if (BUN === null) throw new Error('bun is required for the real-child tests')
    return {command: BUN, args: [SOURCE_ENTRY]}
  }

  async function startWith(
    launcher: TraceRelayLauncher,
    extra: Partial<Parameters<typeof startTraceRelayProcess>[0]> = {},
  ) {
    const logger = createMockLogger()
    const started = await startTraceRelayProcess({
      launcher,
      config: {url: `https://${COLLECTOR_HOST_CANARY}/v1/traces`, headers: HEADERS},
      logger,
      timeouts: {readyMs: 5000, exitGraceMs: 1500, killConfirmMs: 1500},
      ...extra,
    })
    if (started.success) {
      cleanups.push(async () => {
        await started.data.stop()
      })
    }
    return {started, logger}
  }

  describe.skipIf(BUN === null)('with the real child', () => {
    it('returns a port, forwards with the credential, and stops with the batch counts when stdin closes', async () => {
      // #given a loopback collector that answers delivered, then retry, and the real child on the source entry
      const statuses = [200, 503]
      let next = 0
      const upstream = await startHttpUpstream((_request, res) => {
        res.writeHead(statuses[next++] ?? 200, {'content-length': 0})
        res.end()
      })
      cleanups.push(upstream.close)
      const {started, logger} = await startWith(realLauncher(), {
        config: {url: `${upstream.origin}/${COLLECTOR_HOST_CANARY}/v1/traces`, headers: HEADERS},
      })
      const relay: TraceRelayProcess = unwrapOk(started)

      // #when two batches are posted
      expect((await postBatch(relay.port)).status).toBe(200)
      expect((await postBatch(relay.port)).status).toBe(503)

      // #then the collector saw the credential, and nothing else of the sender's
      expect(upstream.requests[0]?.headers.authorization).toBe(CREDENTIAL)
      expect(upstream.requests[0]?.url).toBe(`/${COLLECTOR_HOST_CANARY}/v1/traces`)

      // #when it is stopped
      const stopped = await relay.stop()

      // #then the exit is confirmed, the report's counts come back, and an intentional stop is not a crash
      expect(stopped).toEqual({outcome: 'stopped', counts: {delivered: 1, retry: 1, dropped: 0}})
      expect(relay.crashed()).toBe(false)

      // #and the log says so in fixed text, with no endpoint, host or header value
      expect(loggedAt(logger, 'info')).toEqual([
        ['Trace relay started', {pid: relay.pid}],
        ['Trace relay stopped', {delivered: 1, retry: 1, dropped: 0}],
      ])
      expect(loggedAt(logger, 'warning')).toEqual([])
      const logged = serializeLoggerCalls(logger)
      for (const canary of [CREDENTIAL, COLLECTOR_HOST_CANARY, upstream.origin, 'Basic', 'Authorization']) {
        expect(logged).not.toContain(canary)
      }
    })

    it('answers a refused request locally while running, and keeps serving', async () => {
      const upstream = await startHttpUpstream((_request, res) => res.end())
      cleanups.push(upstream.close)
      const {started} = await startWith(realLauncher(), {
        config: {url: `${upstream.origin}/v1/traces`, headers: HEADERS},
      })
      const relay = unwrapOk(started)

      const refused = await rawExchange(relay.port, 'GET /v1/traces HTTP/1.1\r\nHost: x\r\n\r\n')

      expect(refused.status).toBe(405)
      expect((await postBatch(relay.port)).status).toBe(200)
      await relay.stop()
    })

    it('keeps the credential out of the child argv and environment, which is empty', async () => {
      // #given a parent environment that holds a canary
      process.env.TRACE_RELAY_PARENT_CANARY = 'parent-canary-value'
      cleanups.push(async () => {
        delete process.env.TRACE_RELAY_PARENT_CANARY
      })
      const {started} = await startWith(realLauncher())
      const relay = unwrapOk(started)
      trackedPids.push(relay.pid)

      // #when the child's own command line and environment are read from the runner side (Linux only)
      const proc =
        process.platform === 'linux'
          ? {
              cmdline: await fs.readFile(`/proc/${relay.pid}/cmdline`, 'utf8'),
              environ: await fs.readFile(`/proc/${relay.pid}/environ`, 'utf8'),
            }
          : {cmdline: '', environ: ''}

      // #then neither holds the credential, the collector host or anything of the parent's environment
      expect(proc.cmdline).not.toContain(CREDENTIAL)
      expect(proc.cmdline).not.toContain(COLLECTOR_HOST_CANARY)
      expect(proc.environ).not.toContain(CREDENTIAL)
      expect(proc.environ).not.toContain('parent-canary-value')
      expect(proc.environ).toBe('')
      expect((await relay.stop()).outcome).toBe('stopped')
    })

    it('notices when the child dies after ready: one warning, no abort signal, and the stop still reports', async () => {
      // #given a running relay
      const {started, logger} = await startWith(realLauncher())
      const relay = unwrapOk(started)

      // #when the child is killed from outside
      process.kill(relay.pid, 'SIGKILL')
      await new Promise<void>(resolve => {
        const poll = setInterval(() => {
          if (relay.crashed()) {
            clearInterval(poll)
            resolve()
          }
        }, 20)
      })

      // #then the crash is latched, logged once in fixed text, and offered to nobody as a signal
      expect(relay.crashed()).toBe(true)
      expect('died' in relay).toBe(false)
      expect(loggedAt(logger, 'warning')).toEqual([
        ['Trace relay exited unexpectedly; spans for the rest of the run are not exported', {reason: 'crashed'}],
      ])
      const stopped = await relay.stop()
      expect(stopped).toEqual({outcome: 'already-exited', counts: 'incomplete'})
      expect(loggedAt(logger, 'warning')).toHaveLength(1)
    })

    it('does not report a crash when stop races the exit, and both calls agree', async () => {
      const {started, logger} = await startWith(realLauncher())
      const relay = unwrapOk(started)

      const [first, second] = await Promise.all([relay.stop(), relay.stop()])

      expect(first).toEqual(second)
      expect(first.outcome).toBe('stopped')
      expect(relay.crashed()).toBe(false)
      expect(loggedAt(logger, 'warning')).toEqual([])
      expect(loggedAt(logger, 'info').filter(([message]) => message === 'Trace relay stopped')).toHaveLength(1)
    })
  })

  describe('with a fake child', () => {
    it.each([
      ['exits before it is ready', 'process.exit(3)', 'exited-early'],
      [
        'prints something that is not a ready line',
        String.raw`process.stdout.write('this is not json\n'); setInterval(() => {}, 1000); process.stdin.resume()`,
        'bad-ready',
      ],
      [
        'reports an error line',
        String.raw`process.stdout.write('{"error":"invalid-config"}\n'); process.exit(64)`,
        'child-error',
      ],
    ])('fails the start, with one fixed warning, when the child %s', async (_name, source, kind) => {
      const launcher = await fakeChild(source)

      const {started, logger} = await startWith(launcher)

      expect(unwrapErr(started).kind).toBe(kind)
      expect(loggedAt(logger, 'warning')).toEqual([
        ['The trace relay did not start; this run is not traced', {reason: kind}],
      ])
      expect(loggedAt(logger, 'info')).toEqual([])
      const logged = serializeLoggerCalls(logger)
      expect(logged).not.toContain('not json')
      expect(logged).not.toContain(COLLECTOR_HOST_CANARY)
    })

    it('fails the start, and reaps the child, when it never answers within the bound', async () => {
      const pidFile = path.join(dir, 'pid')
      const launcher = await fakeChild(
        `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1000)`,
      )

      const {started, logger} = await startWith(launcher, {
        timeouts: {readyMs: 300, exitGraceMs: 300, killConfirmMs: 1000},
      })

      expect(unwrapErr(started).kind).toBe('ready-timeout')
      expect(loggedAt(logger, 'warning')).toEqual([
        ['The trace relay did not start; this run is not traced', {reason: 'ready-timeout'}],
      ])
      const pid = Number(await fs.readFile(pidFile, 'utf8'))
      trackedPids.push(pid)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(alive(pid)).toBe(false)
    })

    it('reports a launcher that cannot be spawned, with one fixed warning', async () => {
      const {started, logger} = await startWith({command: path.join(dir, 'does-not-exist'), args: []})

      expect(unwrapErr(started).kind).toBe('spawn-failed')
      expect(loggedAt(logger, 'warning')).toEqual([
        ['The trace relay did not start; this run is not traced', {reason: 'spawn-failed'}],
      ])
    })

    it.each([
      ['an http URL to a public host', {url: `http://${COLLECTOR_HOST_CANARY}/v1/traces`, headers: HEADERS}],
      ['userinfo in the URL', {url: `https://u:p@${COLLECTOR_HOST_CANARY}/v1/traces`, headers: HEADERS}],
      [
        'a header the relay owns',
        {url: `https://${COLLECTOR_HOST_CANARY}/v1/traces`, headers: [{name: 'host', value: 'x'}]},
      ],
    ])('refuses %s before it spawns anything, and logs one fixed warning with no value', async (_name, config) => {
      // #given a launcher that would fail loudly if it were spawned
      const {started, logger} = await startWith({command: path.join(dir, 'must-not-spawn'), args: []}, {config})

      // #then the start fails on the config, not on the spawn
      expect(unwrapErr(started).kind).toBe('invalid-config')
      expect(loggedAt(logger, 'warning')).toEqual([
        ['The trace relay did not start; this run is not traced', {reason: 'invalid-config'}],
      ])
      const logged = serializeLoggerCalls(logger)
      expect(logged).not.toContain(COLLECTOR_HOST_CANARY)
      expect(logged).not.toContain(CREDENTIAL)
    })

    it('refuses a config too large for the frame before it spawns anything', async () => {
      // #given ten headers of 8000 characters each: every one is valid, the frame is not
      const headers = Array.from({length: 10}, (_, i) => ({name: `x-big-${i}`, value: 'v'.repeat(8000)}))

      const {started, logger} = await startWith(
        {command: path.join(dir, 'must-not-spawn'), args: []},
        {config: {url: 'https://collector.example.com/v1/traces', headers}},
      )

      expect(unwrapErr(started).kind).toBe('invalid-config')
      expect(loggedAt(logger, 'warning')).toEqual([
        ['The trace relay did not start; this run is not traced', {reason: 'invalid-config'}],
      ])
    })

    it('kills a child that ignores stdin EOF, confirms it, and says the count is incomplete', async () => {
      // #given a child that is ready and then ignores the closed pipe
      const launcher = await fakeChild(
        String.raw`process.stdout.write('{"ready":true,"port":4321}\n'); process.stdin.resume(); process.stdin.on('end', () => {}); setInterval(() => {}, 1000)`,
      )
      const {started, logger} = await startWith(launcher, {
        timeouts: {readyMs: 3000, exitGraceMs: 200, killConfirmMs: 2000},
      })
      const relay = unwrapOk(started)

      // #when it is stopped
      const stopped = await relay.stop()

      // #then it was killed and the exit confirmed, the count is incomplete, and an intentional stop is not a crash
      expect(stopped).toEqual({outcome: 'killed', counts: 'incomplete'})
      expect(relay.crashed()).toBe(false)
      expect(loggedAt(logger, 'info').at(-1)).toEqual(['Trace relay stopped', {countIncomplete: true}])
      expect(loggedAt(logger, 'warning')).toEqual([])
    })

    it('reports unconfirmed when a child survives the kill, and never throws', async () => {
      const pidFile = path.join(dir, 'pid')
      const launcher = await fakeChild(
        String.raw`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('{"ready":true,"port":4321}\n'); process.stdin.resume(); setInterval(() => {}, 1000)`,
      )
      const {started, logger} = await startWith(launcher, {
        timeouts: {readyMs: 3000, exitGraceMs: 150, killConfirmMs: 150},
        deps: {killGroup: () => undefined},
      })
      const relay = unwrapOk(started)
      trackedPids.push(Number(await fs.readFile(pidFile, 'utf8')))

      const stopped = await relay.stop()

      expect(stopped).toEqual({outcome: 'unconfirmed', counts: 'incomplete'})
      expect(loggedAt(logger, 'error')).toEqual([['The trace relay exit could not be confirmed after SIGKILL']])
    })

    it('reads the report the child prints after stdin closes, and treats an unreadable one as incomplete', async () => {
      const reporting = await fakeChild(
        String.raw`process.stdout.write('{"ready":true,"port":4321}\n'); process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('{"report":{"delivered":4,"retry":2,"dropped":1}}\n'); process.exit(0) })`,
      )
      const garbled = await fakeChild(
        String.raw`process.stdout.write('{"ready":true,"port":4321}\n'); process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('{"report":{"delivered":"many"}}\n'); process.exit(0) })`,
      )
      const first = unwrapOk((await startWith(reporting)).started)
      const second = unwrapOk((await startWith(garbled)).started)

      expect(await first.stop()).toEqual({outcome: 'stopped', counts: {delivered: 4, retry: 2, dropped: 1}})
      expect(await second.stop()).toEqual({outcome: 'stopped', counts: 'incomplete'})
    })

    it('says the count is incomplete when the caller knows the server was killed before its last flush', async () => {
      const reporting = await fakeChild(
        String.raw`process.stdout.write('{"ready":true,"port":4321}\n'); process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('{"report":{"delivered":4,"retry":2,"dropped":1}}\n'); process.exit(0) })`,
      )
      const {started, logger} = await startWith(reporting)
      const relay = unwrapOk(started)

      const stopped = await relay.stop({serverKilled: true})

      // the relay's own numbers could be short of what the plugin tried to send, so none are offered
      expect(stopped).toEqual({outcome: 'stopped', counts: 'incomplete'})
      expect(loggedAt(logger, 'info').at(-1)).toEqual(['Trace relay stopped', {countIncomplete: true}])
    })

    it('does not leak the credential into argv, the handle or the logs', async () => {
      // #given a child that records its own argv and environment names
      const argvFile = path.join(dir, 'argv.json')
      const launcher = await fakeChild(
        String.raw`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify([process.argv, Object.keys(process.env)])); process.stdout.write('{"ready":true,"port":4321}\n'); process.stdin.resume(); setInterval(() => {}, 1000)`,
      )
      process.env.TRACE_RELAY_PARENT_CANARY = 'parent-canary-value'
      cleanups.push(async () => {
        delete process.env.TRACE_RELAY_PARENT_CANARY
      })

      // #when it starts and stops
      const {started, logger} = await startWith(launcher, {
        timeouts: {readyMs: 3000, exitGraceMs: 200, killConfirmMs: 2000},
      })
      const relay = unwrapOk(started)
      await relay.stop()

      // #then argv has no credential, the environment holds none of the parent's variables, and neither the handle nor the log has it
      const [argv, envKeys] = JSON.parse(await fs.readFile(argvFile, 'utf8')) as [string[], string[]]
      expect(argv.join(' ')).not.toContain(CREDENTIAL)
      expect(argv.join(' ')).not.toContain(COLLECTOR_HOST_CANARY)
      expect(envKeys).not.toContain('TRACE_RELAY_PARENT_CANARY')
      expect(envKeys).not.toContain('PATH')
      expect(envKeys).not.toContain('HOME')
      expect(JSON.stringify(relay)).not.toContain(CREDENTIAL)
      expect(JSON.stringify(Object.values(relay).map(String))).not.toContain(CREDENTIAL)
      expect(serializeLoggerCalls(logger)).not.toContain(CREDENTIAL)
      expect(serializeLoggerCalls(logger)).not.toContain(COLLECTOR_HOST_CANARY)
    })
  })
})

/** The `[message, fields]` pairs a mock logger received at one level. */
function loggedAt(logger: ReturnType<typeof createMockLogger>, level: 'debug' | 'error' | 'info' | 'warning') {
  return (logger[level] as unknown as {mock: {calls: unknown[][]}}).mock.calls
}
